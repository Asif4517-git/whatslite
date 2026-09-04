# WhatsLite

A WhatsApp-style messenger for Android: **1:1 chat, emoji, and live voice calls**, with
accounts based on **email only** — no phone number, no password, no OTP.

**Start here:** [DEPLOY.md](DEPLOY.md) — free hosting in about 10 minutes, works from
anywhere. [QUICKSTART.md](QUICKSTART.md) explains how the pieces fit together.

```
whatslite/
├── WhatsLite.apk          <- the built app (install this)
├── DEPLOY.md              <- free Render + Neon setup, step by step
├── QUICKSTART.md          <- what the server is and why you need one
├── render.yaml            <- one-click Render blueprint
├── server/                <- Node.js backend (chat relay + WebRTC signalling)
│   ├── public/admin.html  <- admin console (activate server, stats, ban users)
│   └── test/              <- 56 end-to-end checks, run on both storage backends
└── android/               <- full Android Studio project (Kotlin)
    ├── build_apk.sh       <- one-command build from a clean machine
    └── app/src/main/...   <- sources
```

## What is in v2

- **Postgres support** — point `DATABASE_URL` at a free Neon database and your data
  survives restarts. Still falls back to a local SQLite file for running on your PC.
- **Admin console** — a web page at `/admin`, and inside the app under menu → Admin
  console. Switch the server on or off, watch live usage, ban or delete accounts.
- **Server pause mode** — while paused, sign-in and messaging return a clear
  "paused by administrator" message. Data is kept, and flipping it back on resumes
  everything.
- **Account banning** — a banned user is disconnected immediately and cannot sign
  back in, even with an existing token.

---

## 1. Run the server

The app needs a server to relay messages and to introduce the two phones to each
other before a call. Voice itself travels **peer to peer** (WebRTC), so the server
never hears your calls.

```bash
cd server
npm install
npm start
```

You should see:

```
  WhatsLite server  (storage: sqlite)
  http://0.0.0.0:3000   <- point the app at this machine's LAN IP
```

Storage is chosen automatically:

| Condition | Backend | Persistence |
|---|---|---|
| `DATABASE_URL` is set | **Postgres** (Neon, Render, any managed) | Survives restarts — use this in the cloud |
| otherwise | **SQLite** file at `server/data/whatslite.db` | Fine on your own PC; wiped by Render's free tier |
| sqlite module won't build | JSON file fallback | Works, but not for production |

The active backend is reported by `GET /health` and `GET /`. Always check it says
`postgres` when you deploy to the cloud.

### Environment variables (all optional)

| Variable      | Default                                | Purpose                              |
|---------------|----------------------------------------|--------------------------------------|
| `DATABASE_URL`| *(empty)*                              | Postgres connection string. **Set this in the cloud.** |
| `ADMIN_KEY`   | `whatslite-admin`                      | Admin console password. **Change this.** |
| `PORT`        | `3000`                                 | HTTP + Socket.IO port                |
| `JWT_SECRET`  | `whatslite-dev-secret-change-me`       | **Change this in production**        |
| `STUN_URLS`   | Google's public STUN servers           | Comma-separated ICE urls             |
| `TURN_URL`    | *(empty)*                              | Optional relay, e.g. `turn:host:3478`|
| `TURN_USER` / `TURN_PASS` | *(empty)*                  | TURN credentials                     |
| `PG_POOL_MAX` | `5`                                    | Postgres connection pool size        |

---

## 2. Install the APK

Copy `WhatsLite.apk` to each phone and open it. Android will ask you to allow
"install unknown apps" once — that is normal for an APK that is not from the Play
Store. It is signed with the standard Android debug key, so it installs as-is.

```bash
# or, over USB with adb:
adb install -r WhatsLite.apk
```

---

## 3. Point the app at your server

This is the one step people miss. Open the app and set the **server address** on
the sign-in screen:

| Where the app runs            | Server address to type            |
|-------------------------------|-----------------------------------|
| Real phone, same WiFi as PC   | `http://<PC-LAN-IP>:3000` e.g. `http://192.168.1.20:3000` |
| Android emulator on that PC   | `http://10.0.2.2:3000` (default)  |
| Server on the internet        | `https://your-domain.com`         |

Find your PC's LAN IP with `ip addr` (Linux), `ipconfig` (Windows) or
`ifconfig` (macOS). **Both phones must be able to reach that address.**

To test over the internet, expose the local server temporarily:

```bash
npx localtunnel --port 3000     # or: ngrok http 3000
```

---

## 4. Use it

1. **Sign in** on both phones with two different Gmail addresses. No password,
   no verification code — the email address *is* the account.
2. Tap **+** and type your friend's email. They must have signed in once already
   so the server knows them.
3. Send the request. The other phone gets a notification and taps **Accept**.
4. Chat. Tap the **phone icon** at the top to start a voice call.

### Features

- **Chat** — realtime 1:1 messaging, stored history, unread badges
- **Emoji** — full picker with 8 categories (~1000 emoji), inserts as text
- **Receipts** — single tick = delivered, blue double tick = read
- **Typing indicator** — "typing…" under the contact's name
- **Presence** — green dot when a friend is online
- **Voice calls** — WebRTC peer-to-peer with mute, speaker toggle, live timer,
  answer/decline screen, missed-call entries in the chat, foreground service so
  calls survive the screen locking
- **Friends** — add by email, accept/reject/remove, live request notifications
- **Dark mode** — follows the system theme

---

## 5. Rebuild the APK

`android/build_apk.sh` builds from a clean machine — it downloads JDK 17, the
Android SDK (platform 34, build-tools 34) and Gradle 8.9 into `android/toolchain/`
by itself, then assembles a signed debug APK:

```bash
cd android
bash build_apk.sh          # -> android/WhatsLite.apk
```

Or open `android/` in Android Studio and press Run.

The project is plain Kotlin + ViewBinding, minSdk 24 (Android 7.0+), targetSdk 34.
Key dependencies: `io.socket:socket.io-client`, `io.getstream:stream-webrtc-android`,
OkHttp, Gson, Material 3.

---

## Tests

```bash
cd server && npm test                                   # SQLite backend
DATABASE_URL=postgres://user:pass@host/db npm test      # Postgres / Neon backend
```

**56 end-to-end checks**, run green on both backends. They cover: email login and
normalisation, token rejection, banned accounts, friend requests and acceptance,
realtime delivery, delivery + read receipts, typing, history ordering, numeric
types across the Postgres BIGINT boundary, the complete WebRTC handshake
(offer → answer → ICE → connected → hangup with recorded duration), the offline
and non-friend call paths, and the whole admin console — auth, activate/deactivate,
pause behaviour, ban, unban and delete.

---

## How a call works

```
Alice                       Server                        Bob
  |--- call:start ----------->|                            |
  |                           |---- call:incoming -------->|   phone rings
  |<--- ack {callId} ---------|                            |
  |                           |<--- call:accept -----------|   Bob taps Answer
  |<--- call:accepted --------|                            |
  |--- call:signal (offer) -->|---- call:signal ---------->|
  |<-- call:signal (answer) --|<--- call:signal -----------|
  |<====== ice (both ways, trickled) =====================>|
  |<================ audio, peer to peer =================>|
```

Only signalling passes through the server. Media goes directly between the phones
using Google's public STUN servers for NAT traversal. Behind a strict corporate
NAT you may need a TURN relay — set `TURN_URL`, `TURN_USER` and `TURN_PASS` and
run [coturn](https://github.com/coturn/coturn).

---

## Security notes for v1

This is deliberately a simple first version:

- **Email-only login means anyone who knows an address can use it.** There is no
  password or OTP by design. Before exposing the server to the internet, add
  either a password or a "Sign in with Google" OAuth flow — the `/api/login`
  endpoint is the only place that needs to change.
- Messages and calls are **not end-to-end encrypted**; the server can read
  message bodies (though not call audio, which is peer to peer and DTLS-SRTP).
- Set `JWT_SECRET` to a long random value in production.
- The app allows cleartext HTTP so it can reach a LAN dev server. Switch to HTTPS
  (and tighten `network_security_config.xml`) for real deployment.
