# MixerAI — Deployment Guide

This guide walks you through deploying the MixerAI planner backend to
[Railway](https://railway.app) so the Chrome extension works for anyone, not
just on your local machine.

Total time: **~20 minutes.** Cost: **$5/mo flat** for the Railway Hobby plan.

---

## What you're deploying

The MixerAI extension has two parts:

1. **The Chrome extension itself** (TypeScript, runs in the user's browser).
   This is what your friend installs. It calls the planner over HTTP.

2. **The planner backend** (FastAPI / Python, in `planner/`).
   A small HTTP server that takes the user's task and decides which AI
   models should propose, synthesize, and critique. It calls Anthropic's API
   internally using your `ANTHROPIC_API_KEY`.

The extension currently hits `http://localhost:8000/plan`, which only works
on your laptop. After this deployment, it will hit a real public URL that
works from any browser anywhere.

---

## Prerequisites

- A GitHub account (free)
- An Anthropic API key (get one at https://console.anthropic.com/settings/keys)
- A credit card for Railway ($5/mo Hobby plan — no free tier that won't sleep)

---

## Step 1 — Push the repo to a private GitHub repository

Railway deploys directly from GitHub. You need the planner code in a repo.

```bash
cd ~/Downloads/mixerai-extension       # or wherever your local copy is
git init
git add .
git commit -m "MixerAI v1.2.x — initial deploy"
```

Then on GitHub, create a **private** repository (do not make it public —
your conversation history with Claude has been pasted around your local
copy and you don't want that searchable). Then:

```bash
git remote add origin git@github.com:YOUR_USERNAME/mixerai-extension.git
git branch -M main
git push -u origin main
```

---

## Step 2 — Create a Railway project

1. Go to https://railway.app and sign in with GitHub.
2. Click **New Project** → **Deploy from GitHub repo**.
3. Authorize Railway to access your `mixerai-extension` repo.
4. Select the repo. Railway will start trying to auto-detect the project.

**Important:** Railway will see both the root `package.json` (the
extension build) AND the `planner/` directory (the Python backend) and may
get confused. Tell it to deploy only the planner subdirectory:

5. In the deployment settings (or `Settings` → `Service`), set the **Root
   Directory** to `planner`. This tells Railway to ignore everything
   outside `planner/`.

6. Railway should now detect a Python app via `planner/requirements.txt`
   and use the `Procfile` and `railway.toml` we've already added.

---

## Step 3 — Set the Anthropic API key

In your Railway project:

1. Click your service (it'll be named something like "mixerai-extension").
2. Go to **Variables**.
3. Add a new variable:
   - Name: `ANTHROPIC_API_KEY`
   - Value: your real Anthropic key (starts with `sk-ant-api03-...`)
4. Click **Add**. Railway will redeploy automatically.

DO NOT commit your API key to git. It only lives in Railway's variables.

---

## Step 4 — Generate a public URL

1. In your Railway service, go to **Settings** → **Networking**.
2. Click **Generate Domain**.
3. Railway gives you a URL like `https://mixerai-planner-production.up.railway.app`.
4. Copy this URL. You'll need it in the next step.

---

## Step 5 — Verify the planner is live

Open the URL in your browser. You should see a JSON response like:

```json
{
  "service": "mixerai-planner",
  "version": "1.1.0",
  "status": "ok",
  "planner_model_override": null,
  "tier_models": {
    "free": "claude-haiku-4-5-20251001",
    "pro": "claude-sonnet-4-6",
    "pro_plus": "claude-opus-4-7"
  }
}
```

If you see that, the planner is live and working.

If you see an error, check Railway's **Deployments** tab → click the
latest deploy → check the logs. Common issues:

- **`ANTHROPIC_API_KEY environment variable is not set`** → the key wasn't
  added in Variables, or has a typo. Fix in Step 3.
- **`No start command specified`** → Railway didn't pick up the
  `Procfile`. Verify Root Directory is set to `planner`.
- **Port binding errors** → Railway sets `$PORT` automatically. Don't
  override it.

---

## Step 6 — Point the extension at the deployed planner

Back in your local `mixerai-extension` directory:

1. Create a file called `.env` at the **repo root** (NOT inside `planner/`):

```
PLASMO_PUBLIC_PLANNER_URL=https://YOUR-RAILWAY-URL.up.railway.app/plan
```

   Note the `/plan` suffix — that's the actual endpoint, not just the
   domain.

2. Rebuild the extension:

```bash
npm run build
```

3. The build output in `build/chrome-mv3-prod/` now points at your Railway
   URL instead of localhost.

---

## Step 7 — Test on a different machine

This is the critical test. The deployment is only successful if it works
somewhere other than your laptop.

1. ZIP up the `build/chrome-mv3-prod` folder.
2. Send it to your friend.
3. They unzip it and load it in `chrome://extensions/` → **Load unpacked**.
4. They sign in to ChatGPT, Claude, and Gemini in their browser.
5. They open the MixerAI side panel and try a task.

If it works on their machine, you're production-ready.

---

## Costs you'll incur

- **Railway Hobby plan:** $5/mo flat. Includes 8GB RAM, 8 vCPU shared.
  Plenty for the planner. The planner uses ~50MB RAM idle.
- **Anthropic API:** Pay-as-you-go. Roughly:
  - Haiku 4.5 (free tier users): ~$0.003/plan
  - Sonnet 4.6 (Pro users): ~$0.015/plan
  - Opus 4.7 (Pro+ users): ~$0.08/plan
  - 100 free-tier users doing 5 tasks/day each = $4.50/day = $135/mo
  - Watch this number. Add usage caps before scaling.

---

## What's NOT in this deployment (yet)

The deployed planner has no:

- **User authentication.** Anyone with the URL can hit it. They get your
  Anthropic key's quota.
- **Rate limiting.** A single user could spam 10,000 requests.
- **Payment integration.** Tier selection is honor-system in the side panel.

These are fine for v1 (you and trusted friends). Before you ship to the
Chrome Web Store, add:

1. A simple bearer token check on the planner (extension sends a token,
   planner rejects requests without it).
2. Per-IP rate limiting via `slowapi`.
3. Stripe + a user table when you launch paid tiers.

These are 1–2 days of work each. Not blockers for friend-testing.

---

## Troubleshooting

**Extension can't reach the planner (red dot, "Backend unreachable")**

- Check the Railway URL is reachable in a browser (Step 5).
- Check the URL in `.env` has `/plan` at the end.
- Check you rebuilt the extension after creating `.env`.
- Open the extension's background page console
  (chrome://extensions → Inspect views: service worker) and look for the
  fetch error.

**Planner returns 500 on every request**

- Check Railway logs for the actual error.
- Usually it's a stale `ANTHROPIC_API_KEY` or hitting Anthropic's rate
  limit.

**Friend says "all 4 are red"**

- That's an auth detection issue, not a planner issue. They need to
  actually sign in to ChatGPT, Claude, and Gemini in their
  browser, then hard-refresh those tabs.

---

## Updating the planner later

Anytime you push to your GitHub repo's `main` branch, Railway redeploys
automatically. Watch the deploy logs to confirm it succeeds. The extension
doesn't need to be rebuilt unless you change `lib/config.ts` or the
URL — only the backend.
