require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const Stripe = require('stripe');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const PRICE_CENTS = 1200; // $12.00 - change this to whatever you charge
const DOMAIN = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

app.use(express.json());
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
setInterval(pruneDrafts, 1000 * 60 * 15);

// Since your own API key now pays for every generation, cap how many
// a single visitor can request per hour so one person can't run up your bill.
const generateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests from this device. Try again later.' }
});

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

// Step 1: generate the speech. Only a short preview goes back to the browser -
// the full text stays server-side, keyed by draftId.
app.post('/api/generate', generateLimiter, async (req, res) => {
  try {
    const { occasion, tone, names, details, length } = req.body;

    if (!details || !details.trim()) {
      return res.status(400).json({ error: 'Add at least one real detail or memory.' });
    }

    const prompt = `Write a ${String(occasion || 'wedding speech').toLowerCase()} in a "${String(tone || 'heartfelt').toLowerCase()}" tone.
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
    res.status(500).json({ error: 'Something went wrong generating the speech.' });
  }
});

// Step 2: create a real Stripe Checkout Session tied to this draft.
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { draftId } = req.body;
    if (!draftId || !drafts.has(draftId)) {
      return res.status(400).json({ error: 'Unknown draft. Generate a speech first.' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
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
    if (!session_id || !draftId) {
      return res.status(400).json({ error: 'Missing session_id or draftId.' });
    }

    const draft = drafts.get(draftId);
    if (!draft) {
      return res.status(404).json({ error: 'This draft has expired. Please generate a new speech.' });
    }

    const session = await stripe.checkout.sessions.retrieve(session_id);

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

app.listen(PORT, () => console.log(`VowCraft running on port ${PORT}`));
