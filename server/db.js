'use strict';
/**
 * Storage layer.
 *
 * Backends, chosen automatically:
 *   1. Postgres  - when DATABASE_URL is set. This is what you use on Render,
 *                  pointed at a free Neon database. Persistent, survives restarts.
 *   2. SQLite    - local file, for running the server on your own PC.
 *   3. JSON      - last-resort fallback if the native sqlite module won't build.
 *
 * Every method is async and returns a Promise, so all three backends share one
 * interface. Callers must await.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'whatslite.db');
const JSON_FILE = path.join(DATA_DIR, 'db.json');
const DATABASE_URL = process.env.DATABASE_URL || '';

const now = () => Date.now();
const threadId = (a, b) => [Number(a), Number(b)].sort((x, y) => x - y).join('-');
const normEmail = (email) => String(email || '').trim().toLowerCase();

/* ====================================================================== */
/*  POSTGRES (Neon / Render / any managed Postgres)                        */
/* ====================================================================== */

function pgLayer() {
  // eslint-disable-next-line global-require
  const { Pool, types } = require('pg');
  // Postgres returns BIGINT (int8, OID 20) as a string. Our timestamps and
  // counters are far inside JS safe-integer range, and the phone expects real
  // numbers, so parse them as Number.
  types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

  const needsSsl = /sslmode=require/i.test(DATABASE_URL);
  const pool = new Pool({
    connectionString: DATABASE_URL,
    max: Number(process.env.PG_POOL_MAX || 5),
    // Neon and most managed providers terminate TLS with a valid cert; some
    // corporate networks substitute their own, so allow opting out of strict
    // verification without turning TLS off entirely.
    ssl: needsSsl ? { rejectUnauthorized: process.env.PG_STRICT_SSL === '1' } : undefined,
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 30000,
  });
  pool.on('error', (err) => console.error('[db] pg pool error:', err.message));

  const q = (text, params) => pool.query(text, params);
  const one = async (text, params) => (await q(text, params)).rows[0] || null;

  return {
    kind: 'postgres',
    pool,

    async init() {
      await q(`
        CREATE TABLE IF NOT EXISTS users (
          id           SERIAL PRIMARY KEY,
          email        TEXT UNIQUE NOT NULL,
          display_name TEXT NOT NULL,
          banned       BOOLEAN NOT NULL DEFAULT FALSE,
          created_at   BIGINT NOT NULL
        )`);
      await q(`
        CREATE TABLE IF NOT EXISTS friends (
          owner_id   INT NOT NULL,
          friend_id  INT NOT NULL,
          status     TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          PRIMARY KEY (owner_id, friend_id)
        )`);
      await q(`
        CREATE TABLE IF NOT EXISTS messages (
          id           BIGSERIAL PRIMARY KEY,
          thread_id    TEXT NOT NULL,
          sender_id    INT NOT NULL,
          body         TEXT NOT NULL,
          kind         TEXT NOT NULL DEFAULT 'text',
          ts           BIGINT NOT NULL,
          delivered_at BIGINT,
          read_at      BIGINT
        )`);
      await q(`CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, id)`);
      await q(`
        CREATE TABLE IF NOT EXISTS calls (
          id          SERIAL PRIMARY KEY,
          caller_id   INT NOT NULL,
          callee_id   INT NOT NULL,
          started_at  BIGINT NOT NULL,
          ended_at    BIGINT,
          status      TEXT NOT NULL,
          duration_ms BIGINT DEFAULT 0
        )`);
      await q(`
        CREATE TABLE IF NOT EXISTS settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )`);
    },

    // ------------------------------------------------------------- users
    userByEmail: (email) => one('SELECT * FROM users WHERE email = $1', [normEmail(email)]),
    userById: (id) => one('SELECT * FROM users WHERE id = $1', [id]),
    createUser: async (email, name) => {
      const r = await q(
        'INSERT INTO users (email, display_name, created_at) VALUES ($1,$2,$3) RETURNING *',
        [normEmail(email), name, now()]
      );
      return r.rows[0];
    },
    renameUser: async (id, name) => {
      await q('UPDATE users SET display_name = $1 WHERE id = $2', [name, id]);
    },
    searchUsers: async (needle, excludeId) => {
      const r = await q(
        'SELECT * FROM users WHERE email ILIKE $1 AND id <> $2 ORDER BY email LIMIT 25',
        [`%${needle}%`, excludeId]
      );
      return r.rows;
    },
    allUsers: async () => (await q('SELECT * FROM users ORDER BY id')).rows,
    setBanned: async (id, banned) => {
      await q('UPDATE users SET banned = $1 WHERE id = $2', [banned, id]);
    },
    deleteUser: async (id) => {
      await q('DELETE FROM friends WHERE owner_id = $1 OR friend_id = $1', [id]);
      await q('DELETE FROM messages WHERE sender_id = $1', [id]);
      await q('DELETE FROM calls WHERE caller_id = $1 OR callee_id = $1', [id]);
      await q('DELETE FROM users WHERE id = $1', [id]);
    },

    // ----------------------------------------------------------- friends
    friendRow: (ownerId, friendId) =>
      one('SELECT * FROM friends WHERE owner_id = $1 AND friend_id = $2', [ownerId, friendId]),
    upsertFriend: async (ownerId, friendId, status) => {
      await q(
        `INSERT INTO friends (owner_id, friend_id, status, created_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (owner_id, friend_id) DO UPDATE SET status = EXCLUDED.status`,
        [ownerId, friendId, status, now()]
      );
    },
    deleteFriend: async (ownerId, friendId) => {
      await q('DELETE FROM friends WHERE owner_id = $1 AND friend_id = $2', [ownerId, friendId]);
    },
    friendsOf: async (userId) => {
      const r = await q(
        `SELECT u.* FROM friends f JOIN users u ON u.id = f.friend_id
         WHERE f.owner_id = $1 AND f.status = 'accepted' ORDER BY u.email`,
        [userId]
      );
      return r.rows;
    },
    incomingRequests: async (userId) => {
      const r = await q(
        `SELECT u.* FROM friends f JOIN users u ON u.id = f.owner_id
         WHERE f.friend_id = $1 AND f.status = 'pending'`,
        [userId]
      );
      return r.rows;
    },
    outgoingRequests: async (userId) => {
      const r = await q(
        `SELECT u.* FROM friends f JOIN users u ON u.id = f.friend_id
         WHERE f.owner_id = $1 AND f.status = 'pending'`,
        [userId]
      );
      return r.rows;
    },

    // ---------------------------------------------------------- messages
    saveMessage: async (senderId, receiverId, body, kind) => {
      const r = await q(
        `INSERT INTO messages (thread_id, sender_id, body, kind, ts)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [threadId(senderId, receiverId), senderId, body, kind, now()]
      );
      return r.rows[0];
    },
    messageById: (id) => one('SELECT * FROM messages WHERE id = $1', [id]),
    history: async (a, b, limit) => {
      const r = await q(
        `SELECT * FROM (
           SELECT * FROM messages WHERE thread_id = $1 ORDER BY id DESC LIMIT $2
         ) t ORDER BY t.id ASC`,
        [threadId(a, b), limit]
      );
      return r.rows;
    },
    markDelivered: async (id) => {
      const r = await q(
        'UPDATE messages SET delivered_at = $1 WHERE id = $2 AND delivered_at IS NULL RETURNING id',
        [now(), id]
      );
      return r.rowCount;
    },
    markThreadRead: async (viewerId, otherId) => {
      const r = await q(
        `UPDATE messages SET read_at = $1
         WHERE thread_id = $2 AND sender_id = $3 AND read_at IS NULL RETURNING id`,
        [now(), threadId(viewerId, otherId), otherId]
      );
      return r.rowCount;
    },
    unreadCount: async (viewerId, otherId) => {
      const r = await one(
        'SELECT COUNT(*)::int AS n FROM messages WHERE thread_id = $1 AND sender_id = $2 AND read_at IS NULL',
        [threadId(viewerId, otherId), otherId]
      );
      return r.n;
    },
    lastMessage: (a, b) =>
      one('SELECT * FROM messages WHERE thread_id = $1 ORDER BY id DESC LIMIT 1', [threadId(a, b)]),
    totalMessages: async () => (await one('SELECT COUNT(*)::int AS n FROM messages', [])).n,

    // ------------------------------------------------------------- calls
    startCall: async (callerId, calleeId) => {
      const r = await q(
        'INSERT INTO calls (caller_id, callee_id, started_at, status) VALUES ($1,$2,$3,$4) RETURNING *',
        [callerId, calleeId, now(), 'ringing']
      );
      return r.rows[0];
    },
    callById: (id) => one('SELECT * FROM calls WHERE id = $1', [id]),
    endCall: async (id, status, durationMs) => {
      await q('UPDATE calls SET ended_at = $1, status = $2, duration_ms = $3 WHERE id = $4',
        [now(), status, durationMs, id]);
    },
    callLog: async (a, b) => {
      const r = await q(
        `SELECT * FROM calls
         WHERE (caller_id = $1 AND callee_id = $2) OR (caller_id = $2 AND callee_id = $1)
         ORDER BY id DESC LIMIT 30`,
        [a, b]
      );
      return r.rows;
    },
    lastCallBetween: (a, b) =>
      one(`SELECT * FROM calls
           WHERE (caller_id = $1 AND callee_id = $2) OR (caller_id = $2 AND callee_id = $1)
           ORDER BY id DESC LIMIT 1`, [a, b]),
    totalCalls: async () => (await one('SELECT COUNT(*)::int AS n FROM calls', [])).n,

    // ---------------------------------------------------------- settings
    getSetting: async (key) => {
      const r = await one('SELECT value FROM settings WHERE key = $1', [key]);
      return r ? r.value : null;
    },
    setSetting: async (key, value) => {
      await q(
        `INSERT INTO settings (key, value) VALUES ($1,$2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, String(value)]
      );
    },
  };
}

/* ====================================================================== */
/*  SQLITE (local file)                                                    */
/* ====================================================================== */

function sqliteLayer() {
  // eslint-disable-next-line global-require
  const Database = require('better-sqlite3');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_FILE);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL, banned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS friends (
      owner_id INTEGER NOT NULL, friend_id INTEGER NOT NULL, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY (owner_id, friend_id));
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, sender_id INTEGER NOT NULL,
      body TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text', ts INTEGER NOT NULL,
      delivered_at INTEGER, read_at INTEGER);
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, id);
    CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT, caller_id INTEGER NOT NULL, callee_id INTEGER NOT NULL,
      started_at INTEGER NOT NULL, ended_at INTEGER, status TEXT NOT NULL, duration_ms INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  const S = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (email, display_name, created_at) VALUES (?,?,?)'),
    renameUser: db.prepare('UPDATE users SET display_name = ? WHERE id = ?'),
    searchUsers: db.prepare('SELECT * FROM users WHERE email LIKE ? AND id <> ? ORDER BY email LIMIT 25'),
    allUsers: db.prepare('SELECT * FROM users ORDER BY id'),
    setBanned: db.prepare('UPDATE users SET banned = ? WHERE id = ?'),
    delFriendsOf: db.prepare('DELETE FROM friends WHERE owner_id = ? OR friend_id = ?'),
    delMessagesOf: db.prepare('DELETE FROM messages WHERE sender_id = ?'),
    delCallsOf: db.prepare('DELETE FROM calls WHERE caller_id = ? OR callee_id = ?'),
    delUser: db.prepare('DELETE FROM users WHERE id = ?'),
    friendRow: db.prepare('SELECT * FROM friends WHERE owner_id = ? AND friend_id = ?'),
    upsertFriend: db.prepare(
      `INSERT INTO friends (owner_id, friend_id, status, created_at) VALUES (?,?,?,?)
       ON CONFLICT(owner_id, friend_id) DO UPDATE SET status = excluded.status`),
    deleteFriend: db.prepare('DELETE FROM friends WHERE owner_id = ? AND friend_id = ?'),
    friendsOf: db.prepare(
      `SELECT u.* FROM friends f JOIN users u ON u.id = f.friend_id
       WHERE f.owner_id = ? AND f.status = 'accepted' ORDER BY u.email`),
    incomingRequests: db.prepare(
      `SELECT u.* FROM friends f JOIN users u ON u.id = f.owner_id
       WHERE f.friend_id = ? AND f.status = 'pending'`),
    outgoingRequests: db.prepare(
      `SELECT u.* FROM friends f JOIN users u ON u.id = f.friend_id
       WHERE f.owner_id = ? AND f.status = 'pending'`),
    insertMessage: db.prepare(
      'INSERT INTO messages (thread_id, sender_id, body, kind, ts) VALUES (?,?,?,?,?)'),
    messageById: db.prepare('SELECT * FROM messages WHERE id = ?'),
    historyInner: db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?'),
    markDelivered: db.prepare('UPDATE messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL'),
    markRead: db.prepare('UPDATE messages SET read_at = ? WHERE thread_id = ? AND sender_id = ? AND read_at IS NULL'),
    unreadCount: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND sender_id = ? AND read_at IS NULL'),
    lastMessage: db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT 1'),
    totalMessages: db.prepare('SELECT COUNT(*) AS n FROM messages'),
    insertCall: db.prepare('INSERT INTO calls (caller_id, callee_id, started_at, status) VALUES (?,?,?,?)'),
    callById: db.prepare('SELECT * FROM calls WHERE id = ?'),
    updateCall: db.prepare('UPDATE calls SET ended_at = ?, status = ?, duration_ms = ? WHERE id = ?'),
    callLog: db.prepare(
      `SELECT * FROM calls WHERE (caller_id = ? AND callee_id = ?) OR (caller_id = ? AND callee_id = ?)
       ORDER BY id DESC LIMIT 30`),
    lastCall: db.prepare(
      `SELECT * FROM calls WHERE (caller_id = ? AND callee_id = ?) OR (caller_id = ? AND callee_id = ?)
       ORDER BY id DESC LIMIT 1`),
    totalCalls: db.prepare('SELECT COUNT(*) AS n FROM calls'),
    getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
    setSetting: db.prepare(
      `INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
  };

  const bool = (v) => (v ? 1 : 0);
  const rowBool = (u) => (u ? { ...u, banned: !!u.banned } : u);

  return {
    kind: 'sqlite',
    async init() {},

    userByEmail: async (email) => rowBool(S.userByEmail.get(normEmail(email))),
    userById: async (id) => rowBool(S.userById.get(id)),
    createUser: async (email, name) => {
      const info = S.insertUser.run(normEmail(email), name, now());
      return rowBool(S.userById.get(Number(info.lastInsertRowid)));
    },
    renameUser: async (id, name) => { S.renameUser.run(name, id); },
    searchUsers: async (needle, excludeId) =>
      S.searchUsers.all(`%${needle}%`, excludeId).map(rowBool),
    allUsers: async () => S.allUsers.all().map(rowBool),
    setBanned: async (id, banned) => { S.setBanned.run(bool(banned), id); },
    deleteUser: async (id) => {
      S.delFriendsOf.run(id, id);
      S.delMessagesOf.run(id);
      S.delCallsOf.run(id, id);
      S.delUser.run(id);
    },

    friendRow: async (o, f) => S.friendRow.get(o, f),
    upsertFriend: async (o, f, status) => { S.upsertFriend.run(o, f, status, now()); },
    deleteFriend: async (o, f) => { S.deleteFriend.run(o, f); },
    friendsOf: async (userId) => S.friendsOf.all(userId).map(rowBool),
    incomingRequests: async (userId) => S.incomingRequests.all(userId).map(rowBool),
    outgoingRequests: async (userId) => S.outgoingRequests.all(userId).map(rowBool),

    saveMessage: async (senderId, receiverId, body, kind) => {
      const info = S.insertMessage.run(threadId(senderId, receiverId), senderId, body, kind, now());
      return S.messageById.get(Number(info.lastInsertRowid));
    },
    messageById: async (id) => S.messageById.get(id),
    history: async (a, b, limit) => S.historyInner.all(threadId(a, b), limit).reverse(),
    markDelivered: async (id) => S.markDelivered.run(now(), id).changes,
    markThreadRead: async (viewerId, otherId) =>
      S.markRead.run(now(), threadId(viewerId, otherId), otherId).changes,
    unreadCount: async (viewerId, otherId) =>
      S.unreadCount.get(threadId(viewerId, otherId), otherId).n,
    lastMessage: async (a, b) => S.lastMessage.get(threadId(a, b)),
    totalMessages: async () => S.totalMessages.get().n,

    startCall: async (callerId, calleeId) => {
      const info = S.insertCall.run(callerId, calleeId, now(), 'ringing');
      return S.callById.get(Number(info.lastInsertRowid));
    },
    callById: async (id) => S.callById.get(id),
    endCall: async (id, status, durationMs) => { S.updateCall.run(now(), status, durationMs, id); },
    callLog: async (a, b) => S.callLog.all(a, b, b, a),
    lastCallBetween: async (a, b) => S.lastCall.get(a, b, b, a),
    totalCalls: async () => S.totalCalls.get().n,

    getSetting: async (key) => {
      const r = S.getSetting.get(key);
      return r ? r.value : null;
    },
    setSetting: async (key, value) => { S.setSetting.run(key, String(value)); },
  };
}

/* ====================================================================== */
/*  JSON fallback                                                          */
/* ====================================================================== */

function jsonLayer() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let db = { users: [], friends: [], messages: [], calls: [], settings: {}, seq: { users: 1, messages: 1, calls: 1 } };
  if (fs.existsSync(JSON_FILE)) {
    try { db = { ...db, ...JSON.parse(fs.readFileSync(JSON_FILE, 'utf8')) }; } catch (_) { /* start clean */ }
  }
  let timer = null;
  const save = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      fs.writeFileSync(JSON_FILE, JSON.stringify(db));
    }, 200);
    if (timer.unref) timer.unref();
  };
  const tid = threadId;

  return {
    kind: 'json',
    async init() {},

    userByEmail: async (email) => db.users.find((u) => u.email === normEmail(email)) || null,
    userById: async (id) => db.users.find((u) => u.id === id) || null,
    createUser: async (email, name) => {
      const u = { id: db.seq.users++, email: normEmail(email), display_name: name, banned: false, created_at: now() };
      db.users.push(u); save(); return u;
    },
    renameUser: async (id, name) => {
      const u = db.users.find((x) => x.id === id); if (u) { u.display_name = name; save(); }
    },
    searchUsers: async (needle, excludeId) => db.users
      .filter((u) => u.id !== excludeId && u.email.toLowerCase().includes(needle.toLowerCase()))
      .slice(0, 25),
    allUsers: async () => db.users.slice().sort((a, b) => a.id - b.id),
    setBanned: async (id, banned) => {
      const u = db.users.find((x) => x.id === id); if (u) { u.banned = !!banned; save(); }
    },
    deleteUser: async (id) => {
      db.friends = db.friends.filter((f) => f.owner_id !== id && f.friend_id !== id);
      db.messages = db.messages.filter((m) => m.sender_id !== id);
      db.calls = db.calls.filter((c) => c.caller_id !== id && c.callee_id !== id);
      db.users = db.users.filter((u) => u.id !== id);
      save();
    },

    friendRow: async (o, f) => db.friends.find((x) => x.owner_id === o && x.friend_id === f) || null,
    upsertFriend: async (o, f, status) => {
      const row = db.friends.find((x) => x.owner_id === o && x.friend_id === f);
      if (row) row.status = status; else db.friends.push({ owner_id: o, friend_id: f, status, created_at: now() });
      save();
    },
    deleteFriend: async (o, f) => {
      db.friends = db.friends.filter((x) => !(x.owner_id === o && x.friend_id === f)); save();
    },
    friendsOf: async (userId) => db.friends
      .filter((f) => f.owner_id === userId && f.status === 'accepted')
      .map((f) => db.users.find((u) => u.id === f.friend_id))
      .filter(Boolean).sort((a, b) => a.email.localeCompare(b.email)),
    incomingRequests: async (userId) => db.friends
      .filter((f) => f.friend_id === userId && f.status === 'pending')
      .map((f) => db.users.find((u) => u.id === f.owner_id)).filter(Boolean),
    outgoingRequests: async (userId) => db.friends
      .filter((f) => f.owner_id === userId && f.status === 'pending')
      .map((f) => db.users.find((u) => u.id === f.friend_id)).filter(Boolean),

    saveMessage: async (senderId, receiverId, body, kind) => {
      const m = {
        id: db.seq.messages++, thread_id: tid(senderId, receiverId), sender_id: senderId,
        body, kind, ts: now(), delivered_at: null, read_at: null,
      };
      db.messages.push(m); save(); return m;
    },
    messageById: async (id) => db.messages.find((m) => m.id === id) || null,
    history: async (a, b, limit) => db.messages
      .filter((m) => m.thread_id === tid(a, b)).sort((x, y) => y.id - x.id).slice(0, limit).reverse(),
    markDelivered: async (id) => {
      const m = db.messages.find((x) => x.id === id);
      if (m && !m.delivered_at) { m.delivered_at = now(); save(); return 1; }
      return 0;
    },
    markThreadRead: async (viewerId, otherId) => {
      let n = 0;
      db.messages.forEach((m) => {
        if (m.thread_id === tid(viewerId, otherId) && m.sender_id === otherId && !m.read_at) {
          m.read_at = now(); n += 1;
        }
      });
      if (n) save();
      return n;
    },
    unreadCount: async (viewerId, otherId) => db.messages
      .filter((m) => m.thread_id === tid(viewerId, otherId) && m.sender_id === otherId && !m.read_at).length,
    lastMessage: async (a, b) => db.messages
      .filter((m) => m.thread_id === tid(a, b)).sort((x, y) => y.id - x.id)[0] || null,
    totalMessages: async () => db.messages.length,

    startCall: async (callerId, calleeId) => {
      const c = { id: db.seq.calls++, caller_id: callerId, callee_id: calleeId, started_at: now(), ended_at: null, status: 'ringing', duration_ms: 0 };
      db.calls.push(c); save(); return c;
    },
    callById: async (id) => db.calls.find((c) => c.id === id) || null,
    endCall: async (id, status, durationMs) => {
      const c = db.calls.find((x) => x.id === id);
      if (c) { c.ended_at = now(); c.status = status; c.duration_ms = durationMs; save(); }
    },
    callLog: async (a, b) => db.calls
      .filter((c) => (c.caller_id === a && c.callee_id === b) || (c.caller_id === b && c.callee_id === a))
      .sort((x, y) => y.id - x.id).slice(0, 30),
    lastCallBetween: async (a, b) => db.calls
      .filter((c) => (c.caller_id === a && c.callee_id === b) || (c.caller_id === b && c.callee_id === a))
      .sort((x, y) => y.id - x.id)[0] || null,
    totalCalls: async () => db.calls.length,

    getSetting: async (key) => (key in db.settings ? db.settings[key] : null),
    setSetting: async (key, value) => { db.settings[key] = String(value); save(); },
  };
}

/* ====================================================================== */
/*  Backend selection                                                      */
/* ====================================================================== */

function selectLayer() {
  if (DATABASE_URL) {
    try {
      return pgLayer();
    } catch (err) {
      console.error('[db] Postgres unavailable (%s) - falling back', err.message);
    }
  }
  try {
    return sqliteLayer();
  } catch (err) {
    console.warn('[db] better-sqlite3 unavailable (%s) - using JSON store', err.code || err.message);
    return jsonLayer();
  }
}

const L = selectLayer();

/* ====================================================================== */
/*  Public API - all async                                                 */
/* ====================================================================== */

const db = {
  get backend() { return L.kind; },
  threadId,
  normEmail,

  async ready() { await L.init(); },

  // ------------------------------------------------------------- users
  async findUserByEmail(email) { return L.userByEmail(email); },
  async getUser(id) { return L.userById(id); },
  async allUsers() { return L.allUsers(); },
  async setBanned(id, banned) { return L.setBanned(id, banned); },
  async deleteUser(id) { return L.deleteUser(id); },

  async getOrCreateUser(email, displayName) {
    const existing = await L.userByEmail(email);
    if (existing) {
      const clean = String(displayName || '').trim();
      if (clean && clean !== existing.display_name) {
        await L.renameUser(existing.id, clean);
        return L.userById(existing.id);
      }
      return existing;
    }
    const name = String(displayName || '').trim() || normEmail(email).split('@')[0];
    return L.createUser(email, name);
  },

  async searchUsers(query, excludeId) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return [];
    return L.searchUsers(needle, excludeId);
  },

  // ----------------------------------------------------------- friends
  async relation(ownerId, friendId) { return L.friendRow(ownerId, friendId); },

  async requestFriend(ownerId, friendId) {
    const mine = await L.friendRow(ownerId, friendId);
    if (mine && mine.status === 'accepted') return 'already';
    const theirs = await L.friendRow(friendId, ownerId);
    if (theirs && theirs.status === 'pending') {
      // They already asked us - accept both ways.
      await L.upsertFriend(ownerId, friendId, 'accepted');
      await L.upsertFriend(friendId, ownerId, 'accepted');
      return 'accepted';
    }
    await L.upsertFriend(ownerId, friendId, 'pending');
    return 'pending';
  },

  async acceptFriend(ownerId, friendId) {
    await L.upsertFriend(ownerId, friendId, 'accepted');
    await L.upsertFriend(friendId, ownerId, 'accepted');
    return 'accepted';
  },

  async rejectFriend(ownerId, friendId) {
    await L.deleteFriend(ownerId, friendId);
    await L.deleteFriend(friendId, ownerId);
    return 'removed';
  },

  async removeFriend(ownerId, friendId) {
    await L.deleteFriend(ownerId, friendId);
    await L.deleteFriend(friendId, ownerId);
    return 'removed';
  },

  async friendsOf(userId) { return L.friendsOf(userId); },
  async incomingRequests(userId) { return L.incomingRequests(userId); },
  async outgoingRequests(userId) { return L.outgoingRequests(userId); },

  async areFriends(a, b) {
    const row = await L.friendRow(a, b);
    return !!row && row.status === 'accepted';
  },

  // ---------------------------------------------------------- messages
  async saveMessage(senderId, receiverId, body, kind = 'text') {
    return L.saveMessage(senderId, receiverId, body, kind);
  },
  async getMessage(id) { return L.messageById(id); },
  async history(a, b, limit = 80) { return L.history(a, b, limit); },
  async markDelivered(id) { return L.markDelivered(id); },
  async markThreadRead(viewerId, otherId) { return L.markThreadRead(viewerId, otherId); },
  async unreadCount(viewerId, otherId) { return L.unreadCount(viewerId, otherId); },
  async lastMessage(a, b) { return L.lastMessage(a, b); },
  async totalMessages() { return L.totalMessages(); },

  // ------------------------------------------------------------- calls
  async startCall(callerId, calleeId) { return L.startCall(callerId, calleeId); },
  async getCall(id) { return L.callById(id); },
  async endCall(id, status, durationMs = 0) {
    await L.endCall(id, status, durationMs);
    return L.callById(id);
  },
  async callLog(a, b) { return L.callLog(a, b); },
  async totalCalls() { return L.totalCalls(); },

  // ---------------------------------------------------------- settings
  async getSetting(key) { return L.getSetting(key); },
  async setSetting(key, value) { return L.setSetting(key, value); },

  /** Server is active unless an admin has explicitly deactivated it. */
  async isServerActive() {
    const v = await L.getSetting('server_active');
    return v === null ? true : v === '1';
  },
  async setServerActive(active) {
    await L.setSetting('server_active', active ? '1' : '0');
  },

  async stats() {
    const users = await L.allUsers();
    return {
      users: users.length,
      messages: await L.totalMessages(),
      calls: await L.totalCalls(),
    };
  },

  /** Chat list: friends + last message preview + unread count. */
  async conversations(userId) {
    const friends = await L.friendsOf(userId);
    const out = [];
    for (const friend of friends) {
      const last = await L.lastMessage(userId, friend.id);
      const lastCall = await L.lastCallBetween(userId, friend.id);
      let preview = '';
      let previewTs = 0;
      let previewKind = 'none';
      if (lastCall && (!last || lastCall.started_at > last.ts)) {
        preview = lastCall.status === 'missed' ? 'Missed voice call' : 'Voice call';
        previewTs = lastCall.started_at;
        previewKind = 'call';
      } else if (last) {
        preview = last.kind === 'text' ? last.body : 'Voice call';
        previewTs = last.ts;
        previewKind = last.kind;
      }
      out.push({
        id: friend.id,
        email: friend.email,
        display_name: friend.display_name,
        last_message: preview,
        last_message_kind: previewKind,
        last_ts: previewTs,
        unread: await L.unreadCount(userId, friend.id),
      });
    }
    return out.sort((a, b) => (b.last_ts || 0) - (a.last_ts || 0));
  },
};

module.exports = db;
