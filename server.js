/**
 * Flower Guest — Express server
 *
 * Serves the guest page (index.html), the staff dashboard (dashboard.html),
 * and a JSON-on-disk event store. The Gonxhe AI Concierge is proxied through
 * /api/gonxhe so the Anthropic API key never reaches the browser.
 *
 * Persistence: events/guests/feedback/conversations are stored as JSON files
 * in DATA_DIR. On Render, mount a Persistent Disk at /data and the server
 * will use it automatically. Locally, falls back to ./data/.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

try { require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch (_) {}

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Storage ─────────────────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR
  || (fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });
console.log('Flower Guest data dir:', DATA_DIR);

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  } catch (_) {
    return fallback;
  }
}
function writeJSON(file, data) {
  const full = path.join(DATA_DIR, file);
  const tmp = full + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, full);
}
function appendItem(file, item, cap = 5000) {
  const arr = readJSON(file, []);
  arr.push(item);
  while (arr.length > cap) arr.shift();
  writeJSON(file, arr);
}

// ─── System prompt (editable from Train Gonxhe) ──────────────────────────
const SYSTEM_PROMPT_FILE = 'system-prompt.txt';
const DEFAULT_PROMPT_PATH = path.join(__dirname, 'default-system-prompt.txt');

function getSystemPrompt() {
  try {
    return fs.readFileSync(path.join(DATA_DIR, SYSTEM_PROMPT_FILE), 'utf8');
  } catch (_) {
    try {
      return fs.readFileSync(DEFAULT_PROMPT_PATH, 'utf8');
    } catch (e) {
      console.error('Default system prompt missing', e);
      return 'You are Gonxhe, the AI Concierge for Flower Hotels & Resorts.';
    }
  }
}
function setSystemPrompt(text) {
  const full = path.join(DATA_DIR, SYSTEM_PROMPT_FILE);
  const tmp = full + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, full);
}

// ─── Middleware ──────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));

function requireDashboardAuth(req, res, next) {
  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected) {
    return res.status(503).json({ error: 'DASHBOARD_PASSWORD not configured' });
  }
  const provided = req.headers['x-dashboard-password'] || req.query.password;
  if (provided !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// ─── PUBLIC WRITE ENDPOINTS (guest page → server) ────────────────────────

app.post('/api/event', (req, res) => {
  const { room, type, detail, guest, sessionId } = req.body || {};
  if (!type) return res.status(400).json({ error: 'type required' });
  appendItem('events.json', {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    room: room || '—',
    type: String(type).slice(0, 64),
    detail: String(detail || '').slice(0, 280),
    guest: String(guest || '').slice(0, 80),
    sessionId: sessionId || '',
  });
  res.json({ ok: true });
});

// Phone digits-only — so "+355 68 111 2233" and "0681112233" match the same guest.
function normalizePhone(p) {
  return String(p || '').replace(/[^0-9]/g, '');
}

app.post('/api/guest', (req, res) => {
  const { room, name, phone, checkin, checkout, midStay } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const guests = readJSON('guests.json', []);
  const roomKey = room || '—';
  const phoneKey = normalizePhone(phone);
  // Identity = room + phone. Same room with a different phone is a different guest.
  const existing = guests.findIndex(g =>
    g.room === roomKey && normalizePhone(g.phone) === phoneKey
  );
  const returning = existing >= 0;
  const item = {
    id: returning ? guests[existing].id : crypto.randomUUID(),
    room: roomKey,
    name: String(name).slice(0, 80),
    phone: String(phone).slice(0, 40),
    checkin: checkin || '',
    checkout: checkout || '',
    midStay: midStay || '',
    registeredAt: returning ? guests[existing].registeredAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    visits: returning ? (guests[existing].visits || 1) + 1 : 1,
  };
  if (returning) guests[existing] = item; else guests.push(item);
  writeJSON('guests.json', guests);
  res.json({ ok: true, returning, guest: item });
});

app.post('/api/feedback', (req, res) => {
  const { room, guest, rating, sessionId } = req.body || {};
  const n = Number(rating);
  if (!n || n < 1 || n > 5) return res.status(400).json({ error: 'rating 1-5 required' });
  appendItem('feedback.json', {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    room: room || '—',
    guest: String(guest || '').slice(0, 80),
    rating: n,
    sessionId: sessionId || '',
  });
  res.json({ ok: true });
});

app.post('/api/conversation', (req, res) => {
  const { sessionId, room, guest, messages } = req.body || {};
  if (!sessionId || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'sessionId and messages required' });
  }
  const all = readJSON('conversations.json', {});
  all[sessionId] = {
    sessionId,
    room: room || '—',
    guest: String(guest || '').slice(0, 80),
    messages: messages.slice(-60),
    updatedAt: new Date().toISOString(),
  };
  const keys = Object.keys(all);
  if (keys.length > 1000) {
    keys.sort((a, b) => (all[a].updatedAt > all[b].updatedAt ? 1 : -1));
    while (keys.length > 1000) delete all[keys.shift()];
  }
  writeJSON('conversations.json', all);
  res.json({ ok: true });
});

// ─── GONXHE PROXY ────────────────────────────────────────────────────────
app.post('/api/gonxhe', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages required' });
  }
  // Server is the single source of truth for the system prompt — editable from
  // the dashboard's "Train Gonxhe" tab. The browser never controls it.
  const effectiveSystem = getSystemPrompt();

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.GONXHE_MODEL || 'claude-sonnet-4-6',
        max_tokens: 700,
        system: [{ type: 'text', text: effectiveSystem, cache_control: { type: 'ephemeral' } }],
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

// ─── DASHBOARD AUTH PING (used by lock screen) ───────────────────────────
app.post('/api/dashboard-auth', (req, res) => {
  const expected = process.env.DASHBOARD_PASSWORD;
  const provided = (req.body && req.body.password) || '';
  res.json({ ok: !!expected && provided === expected });
});

// ─── PROTECTED READ ENDPOINTS (dashboard) ────────────────────────────────
app.get('/api/events', requireDashboardAuth, (req, res) => {
  let events = readJSON('events.json', []);
  if (req.query.since) {
    const since = String(req.query.since);
    events = events.filter(e => e.ts > since);
  }
  if (req.query.limit) {
    const n = Math.min(2000, parseInt(req.query.limit, 10) || 500);
    events = events.slice(-n);
  }
  res.json({ events });
});

app.get('/api/guests', requireDashboardAuth, (_req, res) => {
  res.json({ guests: readJSON('guests.json', []) });
});

app.get('/api/feedback', requireDashboardAuth, (_req, res) => {
  res.json({ feedback: readJSON('feedback.json', []) });
});

app.get('/api/conversations', requireDashboardAuth, (_req, res) => {
  const map = readJSON('conversations.json', {});
  const list = Object.values(map).sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1));
  res.json({ conversations: list });
});

app.get('/api/system-prompt', requireDashboardAuth, (_req, res) => {
  res.json({ prompt: getSystemPrompt() });
});

app.post('/api/system-prompt', requireDashboardAuth, (req, res) => {
  const { prompt } = req.body || {};
  if (typeof prompt !== 'string' || prompt.length < 20) {
    return res.status(400).json({ error: 'prompt too short' });
  }
  setSystemPrompt(prompt);
  res.json({ ok: true });
});

app.post('/api/system-prompt/reset', requireDashboardAuth, (_req, res) => {
  try {
    fs.unlinkSync(path.join(DATA_DIR, SYSTEM_PROMPT_FILE));
  } catch (_) {}
  res.json({ ok: true, prompt: getSystemPrompt() });
});

// ─── KNOWLEDGE IMPORT (PDF / DOCX / TXT → extracted text) ───────────────
const multer = require('multer');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
});

// ─── BROADCAST ATTACHMENTS (PDFs/images saved to disk, served publicly) ──
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function slugifyFilename(name) {
  const dot = name.lastIndexOf('.');
  const stem = (dot > 0 ? name.slice(0, dot) : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'file';
  const ext = (dot > 0 ? name.slice(dot + 1) : '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return ext ? `${stamp}-${stem}.${ext}` : `${stamp}-${stem}`;
}

const attachmentUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => cb(null, slugifyFilename(file.originalname || 'file')),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

app.post('/api/uploads', requireDashboardAuth, attachmentUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  res.json({
    ok: true,
    filename: req.file.filename,
    url: '/uploads/' + req.file.filename,
    size: req.file.size,
  });
});

app.get('/api/uploads', requireDashboardAuth, (_req, res) => {
  try {
    const files = fs.readdirSync(UPLOADS_DIR)
      .filter(n => !n.startsWith('.'))
      .map(n => {
        const st = fs.statSync(path.join(UPLOADS_DIR, n));
        return { filename: n, url: '/uploads/' + n, size: st.size, mtime: st.mtime.toISOString() };
      })
      .sort((a, b) => (a.mtime > b.mtime ? -1 : 1));
    res.json({ files });
  } catch (_) { res.json({ files: [] }); }
});

app.delete('/api/uploads/:name', requireDashboardAuth, (req, res) => {
  const safe = path.basename(req.params.name);
  try {
    fs.unlinkSync(path.join(UPLOADS_DIR, safe));
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: 'not_found' });
  }
});

// Serve uploaded files publicly so wa.me / sms links can point at them.
app.use('/uploads', express.static(UPLOADS_DIR, { fallthrough: true, maxAge: '1h' }));

app.post('/api/system-prompt/import', requireDashboardAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  const name = req.file.originalname || 'upload';
  const ext = (name.split('.').pop() || '').toLowerCase();
  const buf = req.file.buffer;
  try {
    let text = '';
    if (ext === 'pdf') {
      const { PDFParse } = require('pdf-parse');
      const parser = new PDFParse({ data: buf });
      const out = await parser.getText();
      text = (out.pages || [])
        .map(p => (p.text || '').trim())
        .filter(Boolean)
        .join('\n\n');
      if (!text || text.length < 50) {
        return res.status(422).json({
          error: 'no_text_layer',
          hint: 'This PDF appears to be image-only (a scan or design export with no text layer). Save it as a text PDF, or copy the text manually and paste it into the editor.',
          filename: name,
        });
      }
    } else if (ext === 'docx') {
      const mammoth = require('mammoth');
      const out = await mammoth.extractRawText({ buffer: buf });
      text = out.value || '';
    } else if (ext === 'txt' || ext === 'md') {
      text = buf.toString('utf8');
    } else {
      return res.status(400).json({ error: 'unsupported_type', supports: ['pdf', 'docx', 'txt', 'md'] });
    }
    // Normalize whitespace: collapse 3+ blank lines, strip trailing spaces.
    text = text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
    res.json({ ok: true, filename: name, text, length: text.length });
  } catch (err) {
    console.error('Import failed', err);
    res.status(500).json({ error: 'extract_failed', detail: String(err.message || err) });
  }
});

// ─── PAGES ───────────────────────────────────────────────────────────────
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

app.get('/dashboard', noCache, (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/dashboard.html', noCache, (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.use(express.static(__dirname, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Flower Guest listening on :${PORT}`);
});
