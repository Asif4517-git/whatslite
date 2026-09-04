# WhatsLite — get it actually working

The APK is only **half** the system. Two phones cannot find each other on their
own, so they both talk to a small server in the middle. WhatsApp does exactly the
same thing — you just never see Meta's servers because Meta runs them for you.

```
   Your phone  ─────►  WhatsLite server  ◄─────  Friend's phone
                     (holds accounts, relays
                      messages, introduces
                      the two phones)

   Once a call starts, the audio goes phone-to-phone directly (WebRTC).
   The server never hears your voice — it only sets up the connection.
```

**So you need to run the server somewhere both phones can reach.** Pick one:

---

## Path A — run it on your own PC (5 minutes, free)

Best for testing with someone in the same house / same WiFi.

**1.** Install Node.js 18+ from https://nodejs.org (the LTS button).

**2.** Copy the `server` folder to your PC, open a terminal inside it, and run:

```bash
npm install
npm start
```

You should see:

```
  WhatsLite server  (storage: sqlite)
  http://0.0.0.0:3000
```

**3.** Find your PC's WiFi IP address:

| Your PC runs | Command      | Look for                          |
|--------------|--------------|-----------------------------------|
| Windows      | `ipconfig`   | `IPv4 Address` e.g. `192.168.1.20`|
| macOS        | `ifconfig`   | `inet 192.168.1.20`               |
| Linux        | `ip addr`    | `inet 192.168.1.20`               |

**4.** On both phones, install `WhatsLite.apk` and on the sign-in screen set the
server address to:

```
http://192.168.1.20:3000        <- your PC's IP from step 3
```

**5.** Sign in with two different Gmail addresses, add each other, chat.

> **Limits of Path A:** your PC must stay on and awake, and both phones must be
> on the same WiFi. If your friend goes home, it stops working. For that, use
> Path B.
>
> If Windows Firewall pops up, allow Node on **Private networks**.

---

## Path B — put the server on the free internet (10 minutes)

Works anywhere, any network, phone on mobile data. Free.

### Using Render.com (easiest, no credit card)

**1.** Push the `whatslite` folder to a GitHub repository (a private one is fine).

**2.** Go to https://render.com → sign in with GitHub → **New** → **Blueprint**.

**3.** Pick your repository. Render finds `render.yaml` automatically and creates
the service. Click **Apply**.

**4.** When the deploy finishes you get a URL like:

```
https://whatslite-server.onrender.com
```

**5.** Put **that** URL into the server field on both phones. No `:3000`, it is
already HTTPS.

**6.** Check it works by opening `https://whatslite-server.onrender.com/health`
in a browser — you should see `{"ok":true,...}`.

> Render's free tier sleeps after ~15 minutes of no traffic. The first message
> after a pause can take ~30 seconds to wake it up. Everything after that is instant.

### Or with Docker (any host: a VPS, Railway, Fly.io, your own server)

```bash
cd server
docker build -t whatslite .
docker run -d -p 3000:3000 -e JWT_SECRET="some-long-random-string" whatslite
```

---

## Which address do I type?

| Situation                                | Server address                          |
|------------------------------------------|-----------------------------------------|
| PC on the same WiFi as the phones        | `http://<PC-IP>:3000`                   |
| Android **emulator** on that PC          | `http://10.0.2.2:3000` (already default)|
| Server on the internet (Render etc.)     | `https://your-app.onrender.com`         |

The address is saved, so you only type it once per phone.

---

## Then the actual flow

1. Open the app → type your Gmail → **Continue**. No password, no OTP.
2. Your friend does the same with their Gmail.
3. Tap **+**, type your friend's email, tap **Add**.
   *(They must have signed in once already, so the server knows their address.)*
4. Their phone shows the request → they tap **Accept**.
5. Chat, send emoji, tap the **phone icon** to call.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Cannot reach server" | Wrong address, or the server isn't running. Open the address in the phone's browser — if it doesn't load, the phone can't see the server. |
| Login works but friend search finds nobody | Your friend hasn't signed in yet. They must open the app and sign in once. |
| Messages work but calls fail | Your network is blocking peer-to-peer. Try both phones on the same WiFi, or add a TURN server (`TURN_URL`, `TURN_USER`, `TURN_PASS`). |
| Works at home, not outside | You used Path A. Switch to Path B. |
| App won't install | Android blocks unknown apps by default — allow it when prompted. |
