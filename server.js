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
  // Prefer the saved override on the persistent disk, but ignore it when it's
  // empty or implausibly short (e.g. corrupted/partial write). That keeps the
  // dashboard's Train Gonxhe tab from ever loading a blank prompt — it'll
  // gracefully fall back to default-system-prompt.txt instead.
  try {
    const saved = fs.readFileSync(path.join(DATA_DIR, SYSTEM_PROMPT_FILE), 'utf8');
    if (saved && saved.trim().length >= 20) return saved;
  } catch (_) {}
  try {
    return fs.readFileSync(DEFAULT_PROMPT_PATH, 'utf8');
  } catch (e) {
    console.error('Default system prompt missing', e);
    return 'You are Gonxhe, the AI Concierge for Flower Hotels & Resorts.';
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
  const { room, name, phone, country, dialCode, checkin, checkout, midStay } = req.body || {};
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
  // Country is an ISO 3166-1 alpha-2 code (e.g. "AL", "IT", "DE", or "XK" for Kosovo).
  const safeCountry = /^[A-Z]{2}$/i.test(String(country || ''))
    ? String(country).toUpperCase()
    : (returning ? (guests[existing].country || '') : '');
  const safeDial = /^\+\d{1,4}$/.test(String(dialCode || ''))
    ? String(dialCode)
    : (returning ? (guests[existing].dialCode || '') : '');
  const item = {
    id: returning ? guests[existing].id : crypto.randomUUID(),
    room: roomKey,
    name: String(name).slice(0, 80),
    phone: String(phone).slice(0, 40),
    country: safeCountry,
    dialCode: safeDial,
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

// ─── CONTACTS + EMAIL CAMPAIGNS ──────────────────────────────────────────
// Mailing list stored at /data/contacts.json. Excel import expects columns:
// Name (required), Email (required), Phone, Language, Tags (comma-separated).
// Sends go through Gmail SMTP via nodemailer, with an HMAC-signed unsubscribe
// link in every email's footer.

const nodemailer = require('nodemailer');
const XLSX = require('xlsx');

const CONTACTS_FILE = 'contacts.json';

function normalizeEmail(e) {
  return String(e || '').trim().toLowerCase();
}

function readContacts() {
  return readJSON(CONTACTS_FILE, []);
}

function writeContacts(list) {
  writeJSON(CONTACTS_FILE, list);
}

// Map common header variants to our canonical field names.
function canonicalField(header) {
  const k = String(header || '').trim().toLowerCase();
  if (['name', 'full name', 'fullname', 'guest', 'guest name', 'emri'].includes(k)) return 'name';
  if (['email', 'e-mail', 'mail', 'email address', 'emaili'].includes(k)) return 'email';
  if (['phone', 'mobile', 'tel', 'telephone', 'whatsapp', 'telefon', 'celular'].includes(k)) return 'phone';
  if (['language', 'lang', 'gjuha'].includes(k)) return 'language';
  if (['tags', 'tag', 'segment', 'segments', 'group'].includes(k)) return 'tags';
  return null;
}

function parseXlsxBuffer(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const firstSheet = wb.SheetNames[0];
  if (!firstSheet) return { rows: [], headers: [] };
  const ws = wb.Sheets[firstSheet];
  const json = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
  return { rows: json, sheet: firstSheet, sheetCount: wb.SheetNames.length };
}

function signUnsubToken(id) {
  const secret = process.env.UNSUB_SECRET || process.env.DASHBOARD_PASSWORD || 'flower-fallback-secret';
  return crypto.createHmac('sha256', secret).update(String(id)).digest('hex').slice(0, 24);
}
function verifyUnsubToken(id, token) {
  return signUnsubToken(id) === String(token || '');
}

// Lazy transporter — built only when SMTP_USER/SMTP_PASS are configured.
function getMailTransporter() {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
}

function brandedEmailHTML({ bodyHTML, unsubscribeURL }) {
  const safeBody = String(bodyHTML || '');
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Flower Hotels &amp; Resorts</title></head>
<body style="margin:0; background:#0E1A2E; font-family:Georgia, 'Playfair Display', serif; color:#E8D9B5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0E1A2E; padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; background:#142540; border:1px solid rgba(196,169,106,0.25); border-radius:14px; overflow:hidden;">
        <tr><td style="padding:28px 32px; border-bottom:1px solid rgba(196,169,106,0.2); text-align:center;">
          <div style="font-family:'Playfair Display', Georgia, serif; font-style:italic; font-size:24px; color:#C4A96A; letter-spacing:1px;">Flower Hotels &amp; Resorts</div>
          <div style="font-size:11px; color:#9C8550; letter-spacing:3px; text-transform:uppercase; margin-top:6px;">Golem · Albanian Adriatic</div>
        </td></tr>
        <tr><td style="padding:32px; font-family:Georgia, serif; font-size:15px; line-height:1.65; color:#E8D9B5;">
          ${safeBody}
        </td></tr>
        <tr><td style="padding:20px 32px; border-top:1px solid rgba(196,169,106,0.2); background:#0E1A2E; text-align:center; font-size:11px; color:#9C8550; line-height:1.6;">
          Rruga Ahmet Caci, Golem, Durrës, Albania<br/>
          <a href="https://hotel-flower.com" style="color:#C4A96A; text-decoration:none;">hotel-flower.com</a> · <a href="https://wa.me/355692073380" style="color:#C4A96A; text-decoration:none;">WhatsApp Reception</a><br/><br/>
          <a href="${unsubscribeURL}" style="color:#9C8550; text-decoration:underline;">Unsubscribe from these emails</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

const contactsUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

app.post('/api/contacts/import', requireDashboardAuth, contactsUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  let parsed;
  try {
    parsed = parseXlsxBuffer(req.file.buffer);
  } catch (err) {
    return res.status(400).json({ error: 'xlsx_parse_failed', detail: String(err.message || err) });
  }
  const rows = parsed.rows || [];
  if (rows.length === 0) {
    return res.status(422).json({ error: 'empty_sheet', sheet: parsed.sheet });
  }
  // Map raw headers to canonical fields.
  const sampleRow = rows[0];
  const headerMap = {};
  for (const h of Object.keys(sampleRow)) {
    const f = canonicalField(h);
    if (f) headerMap[h] = f;
  }
  const hasEmailColumn = Object.values(headerMap).includes('email');
  if (!hasEmailColumn) {
    return res.status(422).json({
      error: 'no_email_column',
      hint: 'Spreadsheet must contain a column named "Email" (or "E-mail", "Mail").',
      detected: Object.keys(sampleRow),
    });
  }

  const existing = readContacts();
  const byEmail = new Map(existing.map(c => [normalizeEmail(c.email), c]));
  const now = new Date().toISOString();
  let added = 0, updated = 0, skipped = 0;
  const errors = [];

  for (const [rowIndex, row] of rows.entries()) {
    const obj = { name: '', email: '', phone: '', language: '', tags: [] };
    for (const [rawHeader, value] of Object.entries(row)) {
      const field = headerMap[rawHeader];
      if (!field) continue;
      if (field === 'tags') {
        obj.tags = String(value || '')
          .split(/[,;|]/).map(s => s.trim()).filter(Boolean);
      } else {
        obj[field] = String(value || '').trim();
      }
    }
    const email = normalizeEmail(obj.email);
    if (!email || !email.includes('@') || !email.includes('.')) {
      skipped += 1;
      if (errors.length < 20) errors.push({ row: rowIndex + 2, reason: 'invalid_email', email: obj.email });
      continue;
    }
    if (byEmail.has(email)) {
      const cur = byEmail.get(email);
      cur.name = obj.name || cur.name;
      cur.phone = obj.phone || cur.phone;
      cur.language = obj.language || cur.language;
      cur.tags = Array.from(new Set([...(cur.tags || []), ...obj.tags]));
      cur.updatedAt = now;
      updated += 1;
    } else {
      const item = {
        id: crypto.randomUUID(),
        name: obj.name,
        email,
        phone: obj.phone,
        language: obj.language,
        tags: obj.tags,
        importedAt: now,
        updatedAt: now,
        unsubscribedAt: null,
      };
      existing.push(item);
      byEmail.set(email, item);
      added += 1;
    }
  }
  writeContacts(existing);
  res.json({
    ok: true,
    sheet: parsed.sheet,
    rowsScanned: rows.length,
    added, updated, skipped,
    total: existing.length,
    errors,
  });
});

app.get('/api/contacts', requireDashboardAuth, (req, res) => {
  const all = readContacts();
  const includeUnsub = req.query.includeUnsubscribed === '1';
  const filtered = includeUnsub ? all : all.filter(c => !c.unsubscribedAt);
  res.json({
    contacts: filtered,
    total: all.length,
    active: all.filter(c => !c.unsubscribedAt).length,
    unsubscribed: all.filter(c => c.unsubscribedAt).length,
    tags: Array.from(new Set(all.flatMap(c => c.tags || []))).sort(),
  });
});

app.delete('/api/contacts/:id', requireDashboardAuth, (req, res) => {
  const id = req.params.id;
  const list = readContacts();
  const idx = list.findIndex(c => c.id === id);
  if (idx < 0) return res.status(404).json({ error: 'not_found' });
  list.splice(idx, 1);
  writeContacts(list);
  res.json({ ok: true, total: list.length });
});

app.post('/api/contacts/send', requireDashboardAuth, async (req, res) => {
  const { subject, html, filter, testTo, throttleMs, attachmentUrl } = req.body || {};
  if (!subject || String(subject).trim().length === 0) {
    return res.status(400).json({ error: 'subject required' });
  }
  if (!html || String(html).trim().length === 0) {
    return res.status(400).json({ error: 'html body required' });
  }
  const transporter = getMailTransporter();
  if (!transporter) {
    return res.status(503).json({ error: 'smtp_not_configured', hint: 'Set SMTP_USER and SMTP_PASS on Render.' });
  }
  const fromName = process.env.EMAIL_FROM_NAME || 'Flower Hotels & Resorts';
  const fromEmail = process.env.SMTP_USER;
  const fromHeader = `"${fromName.replace(/"/g, '')}" <${fromEmail}>`;
  const baseURL = process.env.PUBLIC_URL || `https://${req.get('host') || 'flower-guest.onrender.com'}`;

  // Build recipient list.
  let recipients;
  if (testTo) {
    recipients = [{
      id: 'test',
      name: 'Test Recipient',
      email: normalizeEmail(testTo),
      language: '',
      tags: [],
    }];
  } else {
    const all = readContacts().filter(c => !c.unsubscribedAt);
    const tag = (filter && filter.tag) ? String(filter.tag).trim().toLowerCase() : null;
    recipients = tag
      ? all.filter(c => (c.tags || []).some(t => t.toLowerCase() === tag))
      : all;
  }
  if (recipients.length === 0) {
    return res.status(422).json({ error: 'no_recipients' });
  }
  const cap = testTo ? 1 : Math.min(recipients.length, 200);
  recipients = recipients.slice(0, cap);

  // Resolve attachment (if any) — must be a /uploads/<file> URL pointing to
  // an existing file on the persistent disk.
  const attachments = [];
  if (attachmentUrl && typeof attachmentUrl === 'string') {
    const m = attachmentUrl.match(/^\/uploads\/(.+)$/);
    if (!m) {
      return res.status(400).json({ error: 'invalid_attachment_url' });
    }
    const safe = path.basename(m[1]);
    const filepath = path.join(UPLOADS_DIR, safe);
    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ error: 'attachment_not_found', filename: safe });
    }
    attachments.push({ path: filepath, filename: safe });
  }

  const delay = Math.max(0, Math.min(5000, Number(throttleMs) || 700));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  let sent = 0, failed = 0;
  const failures = [];
  for (const c of recipients) {
    try {
      const token = signUnsubToken(c.id);
      const unsubURL = `${baseURL}/unsubscribe?id=${encodeURIComponent(c.id)}&t=${token}`;
      const finalHTML = brandedEmailHTML({ bodyHTML: html, unsubscribeURL: unsubURL });
      await transporter.sendMail({
        from: fromHeader,
        to: c.email,
        subject,
        html: finalHTML,
        attachments,
        headers: {
          'List-Unsubscribe': `<${unsubURL}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      });
      sent += 1;
    } catch (err) {
      failed += 1;
      if (failures.length < 20) failures.push({ email: c.email, error: String(err.message || err) });
    }
    if (delay > 0 && c !== recipients[recipients.length - 1]) await sleep(delay);
  }
  res.json({
    ok: true, sent, failed, total: recipients.length, failures,
    testMode: !!testTo,
    attachment: attachments[0] ? attachments[0].filename : null,
  });
});

// Public unsubscribe — must be GET so it works from any mail client.
app.get('/unsubscribe', (req, res) => {
  const id = String(req.query.id || '');
  const token = String(req.query.t || '');
  if (!id || !verifyUnsubToken(id, token)) {
    return res.status(400).send('<p style="font-family:Georgia,serif;padding:32px;">Invalid unsubscribe link.</p>');
  }
  const list = readContacts();
  const c = list.find(x => x.id === id);
  if (!c) {
    return res.status(404).send('<p style="font-family:Georgia,serif;padding:32px;">Contact not found.</p>');
  }
  if (!c.unsubscribedAt) {
    c.unsubscribedAt = new Date().toISOString();
    writeContacts(list);
  }
  res.send(`<!doctype html><html><body style="margin:0;background:#0E1A2E;color:#E8D9B5;font-family:Georgia,serif;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;">
    <div style="padding:48px; max-width:520px;">
      <div style="font-style:italic; font-size:28px; color:#C4A96A; margin-bottom:16px;">Flower Hotels &amp; Resorts</div>
      <p style="font-size:16px; line-height:1.6;">You've been unsubscribed from our emails. We're sorry to see you go.</p>
      <p style="font-size:13px; color:#9C8550; margin-top:24px;">If this was a mistake, just reply to any past email or message reception on <a href="https://wa.me/355692073380" style="color:#C4A96A;">WhatsApp</a>.</p>
    </div>
  </body></html>`);
});

// Also support POST for List-Unsubscribe=One-Click (RFC 8058).
app.post('/unsubscribe', express.urlencoded({ extended: false }), (req, res) => {
  const id = String((req.body && req.body.id) || req.query.id || '');
  const token = String((req.body && req.body.t) || req.query.t || '');
  if (!id || !verifyUnsubToken(id, token)) return res.status(400).json({ error: 'invalid_token' });
  const list = readContacts();
  const c = list.find(x => x.id === id);
  if (!c) return res.status(404).json({ error: 'not_found' });
  if (!c.unsubscribedAt) {
    c.unsubscribedAt = new Date().toISOString();
    writeContacts(list);
  }
  res.json({ ok: true });
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
