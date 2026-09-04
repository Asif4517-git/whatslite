# Deploy WhatsLite for free (Render + Neon)

Free forever, works from anywhere. Two accounts, both free, no credit card.

- **Neon** holds your data (a free Postgres database). This is what makes your
  messages survive restarts.
- **Render** runs the server code.

```
   phones  ──►  Render (server)  ──►  Neon (database)
                free web service       free Postgres
```

> **Why a database is needed:** Render's free tier has an *ephemeral filesystem* —
> anything written to local disk is wiped on every restart, and free services
> restart whenever they idle for 15 minutes. Without Neon, your accounts and
> messages would vanish daily. With it, everything persists.

---

## Part 1 — the database (Neon, ~3 minutes)

1. Go to **https://neon.tech** → **Sign up** (GitHub or Google login is fastest).
2. Click **Create a project**.
   - Name: `whatslite`
   - Region: pick the one closest to you (e.g. *Asia Pacific – Singapore*)
   - Postgres version: leave the default
3. When it finishes it shows a **connection string** that looks like:

   ```
   postgres://neondb_owner:npg_XXXX@ep-cool-name-123456-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
   ```

4. **Copy it.** Keep the `?sslmode=require` at the end — it's required.

That's the whole Neon part. Free tier gives 0.5 GB storage and never expires.

---

## Part 2 — the code (GitHub, ~3 minutes)

Render deploys from a GitHub repository.

1. Go to **https://github.com** → sign in (free) → **New repository**.
   - Name: `whatslite`
   - Keep it **Private**
   - Click **Create repository**
2. On the next page click **"uploading an existing file"**.
3. Upload **everything inside the `whatslite` folder** — but *not* the APK
   (it's 49 MB) and not `node_modules`. Specifically:
   ```
   server/server.js
   server/db.js
   server/package.json
   server/package-lock.json
   server/Dockerfile
   server/Procfile
   server/public/admin.html
   render.yaml
   .gitignore
   README.md
   QUICKSTART.md
   DEPLOY.md
   ```
   You can drag the `server` folder and the loose files straight in.
4. Click **Commit changes**.

> Easier alternative if you have Git installed:
> ```bash
> cd whatslite
> git init && git add . && git commit -m "WhatsLite"
> git branch -M main
> git remote add origin https://github.com/YOURNAME/whatslite.git
> git push -u origin main
> ```

---

## Part 3 — the server (Render, ~5 minutes)

1. Go to **https://render.com** → **Get Started** → sign in with GitHub.
2. Click **New →** **Blueprint**.
3. Choose your `whatslite` repository → **Connect**.
4. Render reads `render.yaml` and asks you to fill in the values it can't guess.
   You'll be prompted for two:

   | Variable | What to paste |
   |---|---|
   | `DATABASE_URL` | the Neon connection string from Part 1 |
   | `ADMIN_KEY` | a secret you invent, e.g. `k7Xq2-mvpB-91zz`. **Write it down** — it's your admin password. |

   (`JWT_SECRET` generates itself.)

5. Click **Apply** / **Create**. Wait for the build — about 2–4 minutes.
6. When it says **Live**, your server address is at the top:

   ```
   https://whatslite-server.onrender.com
   ```

7. **Check it works** — open that address in your browser. You should see:

   ```json
   {"name":"whatslite-server","version":"2.0.0","storage":"postgres", ...}
   ```

   `storage` must say **`postgres`**. If it says `sqlite`, the `DATABASE_URL`
   didn't take — go to the service's **Environment** tab, paste it again, and
   click **Save Changes** (that redeploys).

8. Open `https://whatslite-server.onrender.com/admin` — that's your admin console.

---

## Part 4 — the phones

1. Copy `WhatsLite.apk` to both phones and install it (Android will ask you to
   allow "install unknown apps" once — that's normal for an APK).
2. Open it. In the **server address** field, paste:

   ```
   https://whatslite-server.onrender.com
   ```

3. Sign in with your Gmail. Your friend does the same with theirs.
4. Tap **+**, type your friend's email, **Add**. They tap **Accept**.
5. Chat, send emoji, tap the phone icon to call.

**That's it.** It now works from anywhere — different cities, mobile data, any
WiFi. Nothing else to run.

---

## The admin console

Open `https://your-server.onrender.com/admin` in a browser, **or** in the app
tap the menu (⋮) → **Admin console**. Sign in with your `ADMIN_KEY`.

From there you can:

- **Switch the server on or off.** When off, sign-in and messaging are blocked
  for everyone and the app shows *"This server is paused by its administrator."*
  Your data is untouched — flip it back on and everything resumes.
- **See live usage** — accounts, people online right now, total messages, calls,
  and which storage backend is in use.
- **Ban or unban** an account. A banned user is signed out immediately and
  cannot sign back in.
- **Delete** an account and all of its messages permanently.

---

## Things worth knowing

**The 15-minute sleep.** Render's free tier puts the server to sleep when nobody
uses it for 15 minutes. The first message after a pause takes ~30–60 seconds
while it wakes up; after that it's instant. This is normal and free-tier only.

**Your data is safe.** Neon keeps it whether or not Render is awake. That's the
whole point of Part 1.

**Neon also sleeps.** Neon's free database scales to zero after 5 minutes idle
and wakes in a few hundred milliseconds — usually invisible.

**Monthly limits.** Render gives 750 free instance-hours (a service running
24/7 uses ~720, so one service fits) and 5 GB bandwidth. Plenty for a handful
of people chatting.

---

## Updating the server later

Change the code on GitHub → Render redeploys automatically. Your Neon data is
untouched by redeploys.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `storage` says `sqlite` not `postgres` | `DATABASE_URL` isn't set. Render → your service → **Environment** → paste the Neon string → **Save Changes**. |
| "Cannot reach server" on the phone | Check the address has `https://` and no trailing slash. Open it in the phone's browser to confirm it loads. |
| Login says "Server is paused" | You switched it off in the admin console. Switch it back on. |
| Admin console rejects your key | It's the `ADMIN_KEY` you set on Render, not your email password. |
| Friend search finds nobody | They must sign in once first, so the server learns their address. |
| Messages work but calls fail | Your network blocks peer-to-peer. Try both phones on the same WiFi, or add a TURN server (`TURN_URL`, `TURN_USER`, `TURN_PASS` on Render). |
| First message takes a minute | Free tier waking up. Normal. |
