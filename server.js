require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const Stripe = require('stripe');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// ---------------------------------------------------------------------------
// Startup sanity checks. Fail loudly and immediately rather than letting the
// app boot into a broken state that only surfaces when a real visitor tries
// to generate a speech or pay for one.
// ---------------------------------------------------------------------------
const REQUIRED_ENV_VARS = ['OPENAI_API_KEY', 'STRIPE_SECRET_KEY'];
const missingEnvVars = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
if (missingEnvVars.length) {
  console.error(
    `Missing required environment variable(s): ${missingEnvVars.join(', ')}.\n` +
    'Copy .env.example to .env and fill in real values before starting the server.'
  );
  process.exit(1);
}
const resolvedPublicUrl = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
if (NODE_ENV === 'production' && (!resolvedPublicUrl || resolvedPublicUrl.includes('localhost'))) {
  console.warn(
    'WARNING: No public URL could be determined (PUBLIC_URL is unset and this does not ' +
    'look like a Render deployment) while NODE_ENV=production.\n' +
    'Stripe Checkout success/cancel redirects will send real customers to the wrong place. ' +
    'Set PUBLIC_URL to your live deployed URL (e.g. https://your-app.up.railway.app).'
  );
}
if (NODE_ENV === 'production' && !process.env.STRIPE_WEBHOOK_SECRET) {
  console.warn(
    'WARNING: STRIPE_WEBHOOK_SECRET is not set. The app still works via the checkout ' +
    'redirect verification, but a customer who pays and then closes the tab before ' +
    'returning to the site will not be marked as paid. Add a webhook for extra safety ' +
    '(see README.md).'
  );
}

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const PRICE_CENTS = Number(process.env.PRICE_CENTS) || 1200; // $12.00 by default
const CURRENCY = process.env.CURRENCY || 'usd';
// PUBLIC_URL always wins if set. Otherwise, on Render this is auto-provided -
// no manual "set the URL and redeploy" step needed. Everywhere else, falls
// back to localhost for local dev.
const DOMAIN = resolvedPublicUrl || `http://localhost:${PORT}`;

// Render/Railway/Heroku all sit behind a reverse proxy. Without this,
// express-rate-limit either throws (it detects an untrusted
// X-Forwarded-For header) or - worse - silently rate-limits every visitor
// together because it thinks they all share the proxy's IP.
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"]
      }
    }
  })
);

// ---------------------------------------------------------------------------
// Stripe webhook - must be registered BEFORE express.json() with its own raw
// body parser, because Stripe's signature check needs the exact raw bytes.
// This is a fallback safety net: the primary unlock path is the redirect back
// to /api/verify-session, which works without any webhook configured. The
// webhook additionally catches the case where a customer pays and then closes
// the tab (or their browser drops the redirect) before returning to the site.
// ---------------------------------------------------------------------------
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.headers['stripe-signature'];
  let event;

  try {
    if (process.env.STRIPE_WEBHOOK_SECRET) {
      event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
    } else {
      // No webhook secret configured (e.g. local dev). Parse without
      // verification so local testing still works, but this must never
      // happen in production - see the startup warning above.
      event = JSON.parse(req.body.toString('utf8'));
    }
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const draftId = session.metadata?.draftId;
    if (draftId && drafts.has(draftId) && session.payment_status === 'paid') {
      drafts.get(draftId).paid = true;
    }
  }

  res.json({ received: true });
});

app.use(express.json({ limit: '15kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory store of drafts. This is fine for a single server instance,
// which is exactly what you'll be running on Render/Railway to start.
// If you ever scale to multiple server instances, move this to Redis or
// Postgres instead - a plain in-memory Map won't be shared between them.
const drafts = new Map();
const DRAFT_TTL_MS = 1000 * 60 * 60 * 2; // drafts expire after 2 hours

function pruneDrafts() {
  const now = Date.now();
  for (const [id, draft] of drafts) {
    if (now - draft.createdAt > DRAFT_TTL_MS) drafts.delete(id);
  }
}
setInterval(pruneDrafts, 1000 * 60 * 15).unref();

// Since your own API key now pays for every generation, cap how many
// a single visitor can request per hour so one person can't run up your bill.
const generateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests from this device. Try again later.' }
});

// Separate, looser limiter so a burst of legitimate checkout retries isn't
// blocked by the (stricter) generation limiter, while still capping how many
// Checkout Sessions any one visitor can spin up.
const checkoutLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many checkout attempts. Try again later.' }
});

const MAX_FIELD_LENGTHS = { occasion: 80, tone: 80, names: 200, details: 4000 };
const VALID_LENGTHS = new Set(['short', 'medium', 'long']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function wordTarget(length) {
  if (length === 'short') return 180;
  if (length === 'long') return 650;
  return 380;
}

function truncateWords(text, count) {
  const words = text.split(/\s+/);
  if (words.length <= count) return text;
  return words.slice(0, count).join(' ') + '...';
}

function clampString(value, maxLen) {
  return String(value ?? '').trim().slice(0, maxLen);
}

// Step 1: generate the speech. Only a short preview goes back to the browser -
// the full text stays server-side, keyed by draftId.
app.post('/api/generate', generateLimiter, async (req, res) => {
  try {
    const occasion = clampString(req.body.occasion, MAX_FIELD_LENGTHS.occasion) || 'wedding speech';
    const tone = clampString(req.body.tone, MAX_FIELD_LENGTHS.tone) || 'heartfelt';
    const names = clampString(req.body.names, MAX_FIELD_LENGTHS.names);
    const details = clampString(req.body.details, MAX_FIELD_LENGTHS.details);
    const length = VALID_LENGTHS.has(req.body.length) ? req.body.length : 'medium';

    if (!details) {
      return res.status(400).json({ error: 'Add at least one real detail or memory.' });
    }

    const prompt = `Write a ${occasion.toLowerCase()} in a "${tone.toLowerCase()}" tone.
Names/context: ${names || 'not specified'}.
Real details and memories to weave in naturally: ${details}.
Target length: about ${wordTarget(length)} words.
Write it as if a real, slightly nervous but genuine person is speaking - natural sentence rhythm, no cliches like "when I was asked to write this speech I didn't know what to say", no generic filler. Use the specific details given. End on a warm, toast-worthy line.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.9
    });

    const fullSpeech = completion.choices?.[0]?.message?.content?.trim();
    if (!fullSpeech) {
      return res.status(502).json({ error: 'No speech came back. Try again.' });
    }

    const draftId = crypto.randomUUID();
    drafts.set(draftId, { fullSpeech, paid: false, createdAt: Date.now() });

    res.json({ draftId, preview: truncateWords(fullSpeech, 60) });
  } catch (err) {
    console.error(err);
    if (err?.status === 401) {
      return res.status(500).json({ error: 'Server is misconfigured (invalid OpenAI API key). Contact support.' });
    }
    if (err?.status === 429) {
      return res.status(502).json({ error: 'The AI service is busy right now. Please try again in a moment.' });
    }
    res.status(500).json({ error: 'Something went wrong generating the speech.' });
  }
});

// Step 2: create a real Stripe Checkout Session tied to this draft.
app.post('/api/create-checkout-session', checkoutLimiter, async (req, res) => {
  try {
    const { draftId } = req.body || {};
    if (!draftId || !UUID_RE.test(draftId) || !drafts.has(draftId)) {
      return res.status(400).json({ error: 'Unknown draft. Generate a speech first.' });
    }

    const draft = drafts.get(draftId);
    if (draft.paid) {
      return res.status(400).json({ error: 'This speech is already unlocked. Refresh the page.' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      // Not setting payment_method_types on purpose: Stripe's newer accounts
      // have "Managed Payments" on by default, which now rejects this
      // parameter outright and picks available payment methods itself.
      //
      // Managed Payments also requires every product to carry a tax code,
      // which this app has no need to manage. Disabling it for this session
      // avoids that requirement entirely and keeps checkout simple.
      managed_payments: { enabled: false },
      line_items: [{
        price_data: {
          currency: CURRENCY,
          product_data: { name: 'VowCraft - full speech unlock' },
          unit_amount: PRICE_CENTS
        },
        quantity: 1
      }],
      metadata: { draftId },
      success_url: `${DOMAIN}/?draftId=${draftId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${DOMAIN}/?draftId=${draftId}&canceled=true`
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not start checkout.' });
  }
});

// Step 3: the ONLY way the full speech ever reaches the browser.
// This calls Stripe directly to confirm payment - a visitor editing the
// URL cannot fake this, because the check happens against Stripe's own
// records, not against anything the browser sent.
app.get('/api/verify-session', async (req, res) => {
  try {
    const { session_id, draftId } = req.query;
    if (!session_id || !draftId || !UUID_RE.test(String(draftId))) {
      return res.status(400).json({ error: 'Missing session_id or draftId.' });
    }

    const draft = drafts.get(draftId);
    if (!draft) {
      return res.status(404).json({ error: 'This draft has expired. Please generate a new speech.' });
    }

    if (draft.paid) {
      return res.json({ paid: true, fullSpeech: draft.fullSpeech });
    }

    const session = await stripe.checkout.sessions.retrieve(String(session_id));

    const belongsToThisDraft = session.metadata?.draftId === draftId;
    const wasPaid = session.payment_status === 'paid';

    if (!belongsToThisDraft || !wasPaid) {
      return res.json({ paid: false });
    }

    draft.paid = true;
    res.json({ paid: true, fullSpeech: draft.fullSpeech });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not verify payment.' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()), draftsInMemory: drafts.size });
});

// 404 for unknown API routes (static file middleware already handled real files).
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// Centralized error handler - catches anything that slipped past a route's
// own try/catch (e.g. a malformed JSON body) instead of leaking a stack trace.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: 'Unexpected server error.' });
});

const server = app.listen(PORT, () => console.log(`VowCraft running on port ${PORT} (${NODE_ENV})`));

function shutdown(signal) {
  console.log(`${signal} received, shutting down gracefully...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
