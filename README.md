# Apollo Lucky Spin 🎡

A hosted college lucky-draw spin wheel. All prizes, odds, spin-time, the "fix the next spins" queue, and the admin login live on the server, so you can **customize from any device online** and your booth screen picks it up automatically. The spin result is decided on the server, so the odds can't be changed from the browser.

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

With no database set, it stores everything in a local `data.json` file. That's fine for testing.

Default login: **admin / apollo** (change it after first login under "Account & booth").

## Deploy on Render + Neon (free tier works)

### 1. Database (Neon)
1. Create a project at https://neon.tech and copy the connection string (the `postgres://...` URL).
2. Keep it handy — it goes in `DATABASE_URL`.

### 2. Push to GitHub
```bash
git init && git add . && git commit -m "Apollo Lucky Spin"
git branch -M main
git remote add origin https://github.com/<you>/apollo-lucky-spin.git
git push -u origin main
```

### 3. Web service (Render)
1. Render → **New → Web Service** → connect the repo.
2. Settings:
   - Build command: `npm install`
   - Start command: `npm start`
3. Environment variables:
   - `DATABASE_URL` → your Neon connection string (**required for online persistence**)
   - `SESSION_SECRET` → any long random string (optional but recommended; keeps logins valid across restarts)
   - `ADMIN_USER` / `ADMIN_PASS` → initial admin credentials (optional; default `admin` / `apollo`)
4. Deploy. Open the Render URL.

> Render reads `PORT` from the environment automatically — the server already uses it.

### 4. Use it
- Public wheel: the Render URL.
- Admin: tap the ⚙ icon → log in → change prizes, weights, spin time (up to 30s), near-miss, and queue.
- Change something on your phone → the booth screen updates within ~15 seconds (or instantly on next spin).

## How the odds work
Each prize has a **weight**. Chance = `weight ÷ total weight`. Higher weight = lands more often. Your "1 in N" targets can't all be exact at once (they sum to more than 100%), so the wheel keeps your ordering and shows the real % live in the admin panel.

## Resetting data
To wipe everything back to defaults: clear the `state` row in the database (or delete `data.json` locally) and restart the service.

## API (for reference)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/config` | – | Wheel display data (no weights/secrets) |
| POST | `/api/spin` | – | Server decides + returns the result |
| POST | `/api/login` | – | Returns an 8-hour token |
| GET | `/api/admin/state` | ✅ | Full config incl. weights, queue, stats |
| PUT | `/api/admin/state` | ✅ | Save prizes/odds/settings/account |
| POST | `/api/admin/queue` | ✅ | Set the "next spins" queue |
| POST | `/api/admin/reset-stats` | ✅ | Clear spin stats |
# apollo-lucky-spin
# apollo-lucky-spin
