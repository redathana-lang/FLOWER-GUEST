/**
 * Flower Guest — Express server
 *
 * Serves index.html and the spa menu PDF, and proxies Gonxhe chat
 * requests to the Anthropic API so the key never ships to the browser.
 */

const express = require('express');
const path = require('path');

try { require('dotenv').config(); } catch (_) {}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));

const noCache = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
};

app.get('/', noCache, (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/index.html', noCache, (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use(express.static(__dirname));

// ─── Gonxhe proxy ────────────────────────────────────────────────────────
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = process.env.GONXHE_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = 700;

app.post('/api/gonxhe', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  const { messages, system } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }
  if (typeof system !== 'string' || !system) {
    return res.status(400).json({ error: 'system prompt required' });
  }

  try {
    const upstream = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        max_tokens: MAX_TOKENS,
        system: [
          { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
        ],
        messages,
      }),
    });

    const data = await upstream.json();
    if (!upstream.ok) {
      console.error('Anthropic upstream error', upstream.status, data);
      return res.status(upstream.status).json({ error: 'upstream', detail: data });
    }

    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join(' ')
      .trim();

    res.json({ text });
  } catch (err) {
    console.error('Gonxhe proxy failed', err);
    res.status(500).json({ error: 'proxy_failed' });
  }
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Flower Guest listening on :${PORT}`);
});
