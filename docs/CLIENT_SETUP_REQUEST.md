# What we need from you to deploy on your Railway

Self-hosted meeting recorder (Next.js + MySQL + Cloudflare R2 + Gemini).
**Fresh start — no data is migrated.** Everything below is created new, on your accounts.

Estimated effort on your side: **~30 minutes.**

---

## 1. Railway — create the project, invite us

- New Railway project, in **your** workspace (you keep ownership and billing).
- Add a **MySQL** database to it. Railway generates `DATABASE_URL` — we don't need it from you.
- Invite our account as a member. **Do not send us your Railway password.**

The app is a Dockerfile build (`apps/web/Dockerfile`), one long-running web service.
Note it is not a hobby workload: recording upload + `ffmpeg` post-processing are CPU-heavy, so
size the service accordingly.

## 2. Cloudflare R2 — the video storage

Create **one bucket** for this app. We need 4 values:

| Value | Where it comes from |
|---|---|
| Account ID | R2 dashboard URL / overview page |
| Bucket name | the bucket you created |
| Access Key ID | R2 → Manage API tokens → Create API token |
| Secret Access Key | shown once, at token creation |

Token permission: **Object Read & Write**, scoped to that one bucket.

> Must be a NEW bucket. Reusing an existing one mixes your recordings with another deployment's.

## 3. Google Gemini — the AI (transcript, summary, chapters, chat)

- **`GEMINI_API_KEY`** — from a Google AI Studio / Cloud project **with billing enabled**. Required
  for AI features; without it recording still works, AI does not.
- **`GEMINI_API_KEY_FREE`** *(optional but recommended)* — a second key from a project with billing
  **OFF**. The app tries the free key first (~20 calls/day at $0) and falls back to the paid one. Real
  measured saving, not theoretical.

Cost shape, so it is not a surprise: transcription dominates. A ~1-hour meeting is roughly **$0.20–0.40**
on the paid key. The app enforces caps ($100 per org, $20 per video) that we can tune.

## 4. Domain

Tell us one of:
- **(a)** you have a domain/subdomain for it → give us the hostname, you point DNS at Railway; or
- **(b)** Railway's generated `*.up.railway.app` hostname is fine.

This matters beyond cosmetics: the Chrome extension has the server URL compiled in, so the hostname
must be final **before** we build the extension your team installs. Changing it later = rebuild +
everyone reinstalls.

## 5. First admin account

Pick an email and a strong password for the initial admin. **Enter them directly into Railway's
variables yourself** (`INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_PASSWORD`) — please don't send the
password over chat/email. Change the password after first login.

## 6. Optional — skip these and everything still works

| Variable | What it buys |
|---|---|
| `TELEGRAM_BOT_TOKEN` + chat id | Telegram alert if the health check fails |
| `ELEVENLABS_API_KEY` | Sharper transcript timestamps (~1–2 s instead of ~10 s), ~$0.22 per audio hour, opt-in per video |

---

## What we generate — do NOT create these yourself

`NEXTAUTH_SECRET` · `DATABASE_ENCRYPTION_KEY` · `INVITE_TOKEN_SECRET` · `CRON_SECRET` ·
`MEDIA_SIGNING_SECRET`

⚠️ **`DATABASE_ENCRYPTION_KEY` can never be changed after the first deploy** — stored credentials
become unreadable if it is. It goes in your password manager on day one.

---

## Summary — the reply we need

```
1. Railway project created + we're invited      yes / no
2. R2: account id, bucket name, access key, secret key
3. GEMINI_API_KEY (paid)                        + GEMINI_API_KEY_FREE (optional)
4. Domain: <hostname>   or   "use railway.app"
5. Admin email (password you set in Railway yourself)
6. Optional: Telegram token / ElevenLabs key    yes / no
```

Send items 2 and 3 through a password manager or a secret link — not plain chat.
Once these are in place, deployment and verification are on us.
