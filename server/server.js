'use strict';
/**
 * WhatsLite server
 *  - Email login (v1: no password, no OTP): POST /api/login {email, name}
 *  - Friends, 1:1 chat with receipts, WebRTC voice-call signalling
 *  - Admin API + web console at /admin (activate/deactivate, stats, users)
 *
 * Storage is chosen by db.js: Postgres when DATABASE_URL is set (Neon on
 * Render), otherwise a local SQLite file.
 */
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const db = require('./db');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const JWT_SECRET = process.env.JWT_SECRET || 'whatslite-dev-secret-change-me';
const ADMIN_KEY = process.env.ADMIN_KEY || 'whatslite-admin';
const STUN_URLS = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302').split(',');
const TURN_URL = process.env.TURN_URL || '';
const TURN_USER = process.env.TURN_USER || '';
const TURN_PASS = process.env.TURN_PASS || '';

const app = express();
app.use(express.json({ limit: '256kb' }));
app.disable('x-powered-by');

/* ------------------------------------------------------------------ helpers */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const publicUser = (u) => (u ? { id: u.id, email: u.email, name: u.display_name } : null);

const signToken = (user) =>
  jwt.sign({ sub: user.id, email: user.email, name: user.display_name }, JWT_SECRET, { expiresIn: '30d' });

const signAdminToken = () =>
  jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });

function readToken(src) {
  const header = (src.headers && src.headers.authorization) || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  if (src.auth && src.auth.token) return src.auth.token;
  const q = src.query || {};
  return q.token || '';
}

async function userFromToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role === 'admin') return null;
    const user = await db.getUser(payload.sub);
    if (!user) return null;
    if (user.banned) return null;
    return user;
  } catch (_) {
    return null;
  }
}

function verifyAdminToken(token) {
  if (!token) return false;
  try {
    return jwt.verify(token, JWT_SECRET).role === 'admin';
  } catch (_) {
    return false;
  }
}

async function requireAuth(req, res, next) {
  const user = await userFromToken(readToken(req));
  if (!user) return res.status(401).json({ error: 'invalid_token' });
  req.user = user;
  return next();
}

function requireAdmin(req, res, next) {
  if (!verifyAdminToken(readToken(req))) return res.status(401).json({ error: 'admin_unauthorized' });
  return next();
}

/** Blocks everything except admin routes while the server is deactivated. */
async function maintenanceGate(req, res, next) {
  if (req.path.startsWith('/api/admin') || req.path.startsWith('/admin')) return next();
  if (req.path === '/health') return next();
  if (await db.isServerActive()) return next();
  return res.status(503).json({ error: 'server_inactive', message: 'Server is paused by the administrator.' });
}

const iceServers = () => {
  const servers = [{ urls: STUN_URLS }];
  if (TURN_URL) servers.push({ urls: TURN_URL.split(','), username: TURN_USER, credential: TURN_PASS });
  return servers;
};

/* --------------------------------------------------------------------- REST */

app.get('/', (req, res) => {
  res.json({
    name: 'whatslite-server',
    version: '2.0.0',
    storage: db.backend,
    admin: '/admin',
  });
});

app.get('/health', async (req, res) => {
  res.json({ ok: true, storage: db.backend, active: await db.isServerActive(), uptime: process.uptime() });
});

app.use(maintenanceGate);

app.post('/api/login', async (req, res) => {
  const email = db.normEmail(req.body && req.body.email);
  const name = String((req.body && req.body.name) || '').trim().slice(0, 40);
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid_email' });
  const user = await db.getOrCreateUser(email, name);
  if (user.banned) return res.status(403).json({ error: 'banned' });
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user), iceServers: iceServers() });
});

app.get('/api/users/search', requireAuth, async (req, res) => {
  const results = await db.searchUsers(req.query.q, req.user.id);
  const out = [];
  for (const u of results) {
    out.push({ ...publicUser(u), online: isOnline(u.id), relation: await relationTo(req.user.id, u.id) });
  }
  res.json({ results: out });
});

app.get('/api/friends', requireAuth, async (req, res) => {
  const [friends, incoming, outgoing] = await Promise.all([
    db.friendsOf(req.user.id),
    db.incomingRequests(req.user.id),
    db.outgoingRequests(req.user.id),
  ]);
  res.json({
    friends: friends.map((f) => ({ ...publicUser(f), online: isOnline(f.id) })),
    incoming: incoming.map(publicUser),
    outgoing: outgoing.map(publicUser),
  });
});

app.post('/api/friends/request', requireAuth, async (req, res) => {
  const targetEmail = db.normEmail(req.body && req.body.email);
  if (!EMAIL_RE.test(targetEmail)) return res.status(400).json({ error: 'invalid_email' });
  const target = await db.findUserByEmail(targetEmail);
  if (!target) return res.status(404).json({ error: 'no_such_user' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'self' });
  const outcome = await db.requestFriend(req.user.id, target.id);
  if (outcome === 'pending') emitTo(target.id, 'friend:request', { from: publicUser(req.user) });
  res.json({ outcome, friend: { ...publicUser(target), online: isOnline(target.id) } });
});

app.post('/api/friends/accept', requireAuth, async (req, res) => {
  const id = Number(req.body && req.body.id);
  if (!(await db.getUser(id))) return res.status(404).json({ error: 'no_such_user' });
  await db.acceptFriend(req.user.id, id);
  emitTo(id, 'friend:accepted', { friend: publicUser(req.user) });
  syncPresenceBetween(req.user.id, id);
  res.json({ ok: true });
});

app.post('/api/friends/reject', requireAuth, async (req, res) => {
  const id = Number(req.body && req.body.id);
  await db.rejectFriend(req.user.id, id);
  emitTo(id, 'friend:rejected', { friend: publicUser(req.user) });
  res.json({ ok: true });
});

app.delete('/api/friends/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  await db.removeFriend(req.user.id, id);
  emitTo(id, 'friend:removed', { friend: publicUser(req.user) });
  res.json({ ok: true });
});

app.get('/api/conversations', requireAuth, async (req, res) => {
  const list = await db.conversations(req.user.id);
  res.json({ conversations: list.map((c) => ({ ...c, online: isOnline(c.id) })) });
});

app.get('/api/messages/:friendId', requireAuth, async (req, res) => {
  const friendId = Number(req.params.friendId);
  if (!(await db.areFriends(req.user.id, friendId))) return res.status(403).json({ error: 'not_friends' });
  await db.markThreadRead(req.user.id, friendId);
  res.json({ messages: await db.history(req.user.id, friendId, 100) });
});

app.get('/api/calls/:friendId', requireAuth, async (req, res) => {
  res.json({ calls: await db.callLog(req.user.id, Number(req.params.friendId)) });
});

/* -------------------------------------------------------------------- admin */

app.post('/api/admin/login', (req, res) => {
  const key = String((req.body && req.body.key) || '');
  // Constant-time compare so the key cannot be guessed by timing.
  const a = Buffer.from(key);
  const b = Buffer.from(ADMIN_KEY);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(401).json({ error: 'bad_key' });
  res.json({ token: signAdminToken() });
});

app.get('/api/admin/state', requireAdmin, async (req, res) => {
  const stats = await db.stats();
  res.json({
    active: await db.isServerActive(),
    storage: db.backend,
    online: presence.size,
    ...stats,
  });
});

app.post('/api/admin/activate', requireAdmin, async (req, res) => {
  const active = !!(req.body && req.body.active);
  await db.setServerActive(active);
  io.emit('server:state', { active });
  res.json({ ok: true, active });
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const users = await db.allUsers();
  res.json({
    users: users.map((u) => ({
      id: u.id, email: u.email, name: u.display_name,
      banned: !!u.banned, online: isOnline(u.id),
      created_at: u.created_at,
    })),
  });
});

app.post('/api/admin/users/:id/ban', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const banned = !!(req.body && req.body.banned);
  if (!(await db.getUser(id))) return res.status(404).json({ error: 'no_such_user' });
  await db.setBanned(id, banned);
  if (banned) forceDisconnect(id);
  res.json({ ok: true, banned });
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  forceDisconnect(id);
  await db.deleteUser(id);
  res.json({ ok: true });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.use('/admin', express.static(path.join(__dirname, 'public')));

/* ---------------------------------------------------------------- socket.io */

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e6,
  pingInterval: 15000,
  pingTimeout: 30000,
});

const presence = new Map();   // userId -> Set<socketId>
const socketUser = new Map(); // socketId -> userId
const activeCalls = new Map();

const isOnline = (userId) => presence.has(userId) && presence.get(userId).size > 0;

function emitTo(userId, event, payload) {
  const sockets = presence.get(userId);
  if (!sockets || sockets.size === 0) return false;
  let sent = false;
  sockets.forEach((sid) => {
    const s = io.sockets.sockets.get(sid);
    if (s) { s.emit(event, payload); sent = true; }
  });
  return sent;
}

function forceDisconnect(userId) {
  const sockets = presence.get(userId);
  if (!sockets) return;
  sockets.forEach((sid) => {
    const s = io.sockets.sockets.get(sid);
    if (s) s.disconnect(true);
  });
}

async function relationTo(ownerId, otherId) {
  if (!(await db.getUser(otherId))) return 'none';
  const mine = await db.relation(ownerId, otherId);
  const theirs = await db.relation(otherId, ownerId);
  if (mine && mine.status === 'accepted') return 'friends';
  if (mine && mine.status === 'pending') return 'requested';
  if (theirs && theirs.status === 'pending') return 'incoming';
  return 'none';
}

async function broadcastPresence(userId) {
  const friends = await db.friendsOf(userId);
  friends.forEach((f) => emitTo(f.id, 'presence', { id: userId, online: isOnline(userId) }));
}

function syncPresenceBetween(a, b) {
  emitTo(a, 'presence', { id: b, online: isOnline(b) });
  emitTo(b, 'presence', { id: a, online: isOnline(a) });
}

async function pushConversations(userId) {
  const list = await db.conversations(userId);
  emitTo(userId, 'conversations', {
    conversations: list.map((c) => ({ ...c, online: isOnline(c.id) })),
  });
}

io.use(async (socket, next) => {
  if (!(await db.isServerActive())) return next(new Error('server_inactive'));
  const user = await userFromToken(readToken(socket.handshake));
  if (!user) return next(new Error('unauthorized'));
  socket.data.user = user;
  return next();
});

io.on('connection', async (socket) => {
  const me = socket.data.user;
  const userId = me.id;

  if (!presence.has(userId)) presence.set(userId, new Set());
  presence.get(userId).add(socket.id);
  socketUser.set(socket.id, userId);
  socket.join(`u:${userId}`);

  if (presence.get(userId).size === 1) await broadcastPresence(userId);

  const friends = await db.friendsOf(userId);
  friends.forEach((f) => socket.emit('presence', { id: f.id, online: isOnline(f.id) }));

  socket.emit('session', {
    user: publicUser(me),
    iceServers: iceServers(),
    conversations: (await db.conversations(userId)).map((c) => ({ ...c, online: isOnline(c.id) })),
    incoming: (await db.incomingRequests(userId)).map(publicUser),
    friends: friends.map((f) => ({ ...publicUser(f), online: isOnline(f.id) })),
    active: await db.isServerActive(),
    now: Date.now(),
  });

  /* ------------------------------------------------------------- chat */

  socket.on('message:send', async (data, ack) => {
    try {
      const to = Number(data && data.to);
      const body = String((data && data.body) || '').slice(0, 4000);
      const kind = (data && data.kind) === 'call' ? 'call' : 'text';
      if (!body.trim() && kind === 'text') return ack && ack({ error: 'empty' });
      if (!(await db.areFriends(userId, to))) return ack && ack({ error: 'not_friends' });

      const msg = await db.saveMessage(userId, to, body, kind);
      const payload = {
        id: msg.id, thread_id: msg.thread_id, sender_id: msg.sender_id,
        body: msg.body, kind: msg.kind, ts: Number(msg.ts),
      };
      ack && ack({ ok: true, message: payload });

      if (emitTo(to, 'message:new', payload)) {
        await db.markDelivered(msg.id);
        socket.emit('message:status', { id: msg.id, status: 'delivered', ts: Date.now() });
      }
      await pushConversations(userId);
      await pushConversations(to);
    } catch (err) {
      console.error('[message:send]', err);
      ack && ack({ error: 'server_error' });
    }
    return null;
  });

  socket.on('message:delivered', async (data) => {
    const id = Number(data && data.id);
    const msg = await db.getMessage(id);
    if (!msg || Number(msg.sender_id) !== userId) return;
    if (await db.markDelivered(id)) {
      emitTo(Number(msg.sender_id), 'message:status', { id, status: 'delivered', ts: Date.now() });
    }
  });

  socket.on('message:read', async (data) => {
    const otherId = Number(data && data.other);
    if (!otherId) return;
    const changed = await db.markThreadRead(userId, otherId);
    if (changed) {
      const thread = db.threadId(userId, otherId);
      const ids = (await db.history(userId, otherId, 200))
        .filter((m) => Number(m.sender_id) === otherId)
        .map((m) => m.id);
      emitTo(otherId, 'message:status', { thread_id: thread, ids, status: 'read', ts: Date.now() });
      await pushConversations(otherId);
    }
  });

  socket.on('typing', (data) => {
    const to = Number(data && data.to);
    if (to) emitTo(to, 'typing', { from: userId, isTyping: !!(data && data.isTyping) });
  });

  socket.on('conversations:refresh', () => pushConversations(userId));

  /* -------------------------------------------------------- voice calls */

  socket.on('call:start', async (data, ack) => {
    try {
      const to = Number(data && data.to);
      if (!(await db.areFriends(userId, to))) return ack && ack({ error: 'not_friends' });
      if (!isOnline(to)) return ack && ack({ error: 'offline' });
      if (activeCalls.has(to) || activeCalls.has(userId)) return ack && ack({ error: 'busy' });

      const call = await db.startCall(userId, to);
      const record = { id: call.id, caller: userId, callee: to, connectedAt: null };
      activeCalls.set(userId, record);
      activeCalls.set(to, record);

      emitTo(to, 'call:incoming', { callId: call.id, from: publicUser(me), type: 'voice' });
      ack && ack({ ok: true, callId: call.id });
    } catch (err) {
      console.error('[call:start]', err);
      ack && ack({ error: 'server_error' });
    }
    return null;
  });

  socket.on('call:accept', (data, ack) => {
    const record = activeCalls.get(userId);
    if (!record || record.callee !== userId) return ack && ack({ error: 'no_call' });
    emitTo(record.caller, 'call:accepted', { callId: record.id });
    ack && ack({ ok: true, callId: record.id, iceServers: iceServers() });
    return null;
  });

  socket.on('call:reject', async (data) => {
    const record = activeCalls.get(userId);
    if (!record) return;
    const reason = (data && data.reason) === 'busy' ? 'busy' : 'declined';
    await db.endCall(record.id, reason);
    await db.saveMessage(record.caller, record.callee, 'Voice call', 'call');
    emitTo(record.caller, 'call:ended', { callId: record.id, reason });
    emitTo(record.callee, 'call:ended', { callId: record.id, reason });
    activeCalls.delete(record.caller);
    activeCalls.delete(record.callee);
    await pushConversations(record.caller);
    await pushConversations(record.callee);
  });

  socket.on('call:cancel', async () => {
    const record = activeCalls.get(userId);
    if (!record) return;
    await db.endCall(record.id, 'cancelled');
    await db.saveMessage(record.caller, record.callee, 'Voice call', 'call');
    emitTo(record.callee, 'call:ended', { callId: record.id, reason: 'cancelled' });
    emitTo(record.caller, 'call:ended', { callId: record.id, reason: 'cancelled' });
    activeCalls.delete(record.caller);
    activeCalls.delete(record.callee);
    await pushConversations(record.caller);
    await pushConversations(record.callee);
  });

  socket.on('call:signal', (data) => {
    const record = activeCalls.get(userId);
    if (!record || !data) return;
    const peer = record.caller === userId ? record.callee : record.caller;
    emitTo(peer, 'call:signal', { callId: record.id, from: userId, data });
  });

  socket.on('call:connected', async () => {
    const record = activeCalls.get(userId);
    if (!record || record.connectedAt) return;
    record.connectedAt = Date.now();
    await db.endCall(record.id, 'answered', 0);
    const peer = record.caller === userId ? record.callee : record.caller;
    emitTo(peer, 'call:connected', { callId: record.id, at: record.connectedAt });
  });

  socket.on('call:end', async () => {
    const record = activeCalls.get(userId);
    if (!record) return;
    const durationMs = record.connectedAt ? Date.now() - record.connectedAt : 0;
    await db.endCall(record.id, durationMs > 0 ? 'answered' : 'missed', durationMs);
    await db.saveMessage(record.caller, record.callee, 'Voice call', 'call');
    const peer = record.caller === userId ? record.callee : record.caller;
    emitTo(peer, 'call:ended', { callId: record.id, reason: 'hangup', durationMs });
    emitTo(userId, 'call:ended', { callId: record.id, reason: 'hangup', durationMs });
    activeCalls.delete(record.caller);
    activeCalls.delete(record.callee);
    await pushConversations(record.caller);
    await pushConversations(record.callee);
  });

  socket.on('ice', (data) => {
    const record = activeCalls.get(userId);
    if (!record || !data) return;
    const peer = record.caller === userId ? record.callee : record.caller;
    emitTo(peer, 'ice', { callId: record.id, from: userId, candidate: data });
  });

  socket.on('ping:server', (_d, ack) => ack && ack({ ok: true, ts: Date.now() }));

  /* --------------------------------------------------------- disconnect */

  socket.on('disconnect', async () => {
    const sockets = presence.get(userId);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) presence.delete(userId);
    }
    socketUser.delete(socket.id);
    await broadcastPresence(userId);

    const record = activeCalls.get(userId);
    if (record) {
      const durationMs = record.connectedAt ? Date.now() - record.connectedAt : 0;
      await db.endCall(record.id, record.connectedAt ? 'answered' : 'missed', durationMs);
      await db.saveMessage(record.caller, record.callee, 'Voice call', 'call');
      const peer = record.caller === userId ? record.callee : record.caller;
      emitTo(peer, 'call:ended', { callId: record.id, reason: 'disconnected', durationMs });
      activeCalls.delete(record.caller);
      activeCalls.delete(record.callee);
    }
  });
});

/* ------------------------------------------------------------------- errors */

app.use((req, res) => res.status(404).json({ error: 'not_found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[http]', err);
  res.status(500).json({ error: 'server_error' });
});

/* ------------------------------------------------------------------- start */

async function main() {
  await db.ready();
  server.listen(PORT, HOST, () => {
    console.log(`\n  WhatsLite server v2  (storage: ${db.backend})`);
    console.log(`  http://${HOST}:${PORT}`);
    console.log(`  admin console: /admin   (key: ${ADMIN_KEY})`);
    console.log(`  ICE: ${STUN_URLS.join(', ')}${TURN_URL ? ` + ${TURN_URL}` : ''}\n`);
  });
}

// Only bind a port when run directly, so the test suite can import and control it.
if (require.main === module) {
  main().catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
}

module.exports = { app, server, io, main };
