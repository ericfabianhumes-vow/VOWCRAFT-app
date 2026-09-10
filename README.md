# VowCraft

AI-generated wedding speeches and vows. Visitor fills in occasion, tone, names,
and a few real details; the app generates a full speech via OpenAI, shows a
free preview, and unlocks the full text after a one-time $12 Stripe payment.

## Local setup

```bash
npm install
cp .env.example .env   # then fill in OPENAI_API_KEY and STRIPE_SECRET_KEY
npm run dev             # http://localhost:3000
```

## Required environment variables

| Variable | Required | Notes |
|---|---|---|
| `OPENAI_API_KEY` | yes | From platform.openai.com |
| `STRIPE_SECRET_KEY` | yes | Use a `sk_test_...` key while testing, `sk_live_...` to charge real cards |
| `PUBLIC_URL` | only outside Render | Your deployed URL, e.g. `https://vowcraft.up.railway.app`. Used to build Stripe's success/cancel redirect links. **Not needed on Render** — the app reads Render's own `RENDER_EXTERNAL_URL` automatically. |
| `PORT` | no | Defaults to 3000 locally; `render.yaml` sets it to 10000 on Render |
| `STRIPE_WEBHOOK_SECRET` | recommended in production | See "Stripe webhook" below |
| `PRICE_CENTS` | no | Defaults to 1200 ($12.00) |
| `CURRENCY` | no | Defaults to `usd` |

The server refuses to start if `OPENAI_API_KEY` or `STRIPE_SECRET_KEY` is missing.

## Deploying tonight (Render, free option — easiest path)

This repo includes `render.yaml`, a Blueprint file Render reads automatically.
It pre-fills the build/start commands and port for you, and will prompt you
for just the three secret values it can't know in advance.

1. Get this code onto GitHub. If you've never used GitHub: create a free
   account at github.com, click "New repository", then use the "uploading an
   existing file" link on the new repo's page to drag in every file from this
   folder (including the `public` folder) and commit. No command line needed.
2. Go to `https://render.com/deploy?repo=` followed by your new repo's URL
   (e.g. `https://render.com/deploy?repo=https://github.com/yourname/vowcraft-app`).
   Render will ask you to connect your GitHub account if you haven't already.
3. Render reads `render.yaml` and shows a form asking for `OPENAI_API_KEY`,
   `STRIPE_SECRET_KEY`, and `STRIPE_WEBHOOK_SECRET` — paste in what you have
   so far (webhook secret can be added later, see Stripe setup below) and
   click Apply/Deploy.
4. That's it — no separate step to set the app's own URL. Render gives every
   service a `RENDER_EXTERNAL_URL` automatically and this app already reads
   it, so Stripe's redirect links are correct from the first deploy.

Railway, Fly.io, or any other Node host works too — install, `npm start`, and
set the env vars above manually (on those hosts, also set `PUBLIC_URL` to
your live URL, since only Render provides `RENDER_EXTERNAL_URL` automatically).

## Stripe setup

1. Create a Stripe account, grab the secret key from the Dashboard
   (Developers → API keys).
2. No Stripe product needs to be pre-created — the app creates a Checkout
   Session with an inline price every time, using `PRICE_CENTS`.
3. **Stripe webhook (recommended before taking real money):** Dashboard →
   Developers → Webhooks → Add endpoint → URL: `https://your-domain/api/stripe-webhook`,
   event: `checkout.session.completed`. Copy the signing secret into
   `STRIPE_WEBHOOK_SECRET`. Without this, payment confirmation still works for
   anyone who lands back on the site after paying (the primary flow) — the
   webhook is just a safety net for the rare case someone closes the tab
   before the redirect completes.
4. Switch `STRIPE_SECRET_KEY` from `sk_test_...` to `sk_live_...` (and update
   the webhook to point at the live endpoint) when you're ready to charge real
   customers.

## Before charging real customers

- `public/terms.html` and `public/privacy.html` already list a contact email
  — open them and confirm it's the one you want customers to use.
- Stripe may ask for a support email and refund policy during account
  activation; the terms page above covers the refund policy language.

## Architecture notes

- Drafts (the generated speech text) live in an in-memory `Map`, not a
  database. That's fine for a single server instance, which is what you'll
  run on Render/Railway to start. If you ever scale to multiple instances,
  move this to Redis or Postgres — a plain in-memory Map isn't shared between
  instances.
- The full speech text never reaches the browser until `/api/verify-session`
  confirms payment directly against Stripe's own records — a visitor can't
  fake this by editing the URL.
- `helmet` sets a strict Content-Security-Policy; the front-end has no inline
  `<script>` or `<style>` so nothing needs `unsafe-inline`. If you add inline
  scripts/styles later, update the CSP in `server.js` accordingly.

## Project structure

```
server.js              Express app: generate, checkout, verify-session, webhook
render.yaml             Render Blueprint - pre-fills setup, see Deploying above
public/index.html      Single-page front end
public/styles.css
public/app.js
public/terms.html
public/privacy.html
.env.example           Copy to .env
```
