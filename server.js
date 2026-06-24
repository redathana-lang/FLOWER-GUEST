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

// ─── Website system prompt (separate, used when channel === 'website') ──────
// Same override-wins pattern as the in-house prompt: a saved copy on the
// persistent disk wins, otherwise we fall back to website-system-prompt.txt
// shipped in the repo. Lets the website Gonxhe be trained independently.
const WEBSITE_PROMPT_FILE = 'website-system-prompt.txt';
const DEFAULT_WEBSITE_PROMPT_PATH = path.join(__dirname, 'website-system-prompt.txt');

function getWebsitePrompt() {
  try {
    const saved = fs.readFileSync(path.join(DATA_DIR, WEBSITE_PROMPT_FILE), 'utf8');
    if (saved && saved.trim().length >= 20) return saved;
  } catch (_) {}
  try {
    return fs.readFileSync(DEFAULT_WEBSITE_PROMPT_PATH, 'utf8');
  } catch (e) {
    console.error('Website system prompt missing — falling back to in-house prompt', e);
    return getSystemPrompt();
  }
}
function setWebsitePrompt(text) {
  const full = path.join(DATA_DIR, WEBSITE_PROMPT_FILE);
  const tmp = full + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, full);
}

// ─── Geo-IP (offline) + website-visitor tracking (Phase A) ─────────────────
// geoip-lite is an offline country database — no third-party calls, no IP ever
// leaves the server. Loaded defensively so the app still boots if it's absent.
let geoip = null;
try { geoip = require('geoip-lite'); }
catch (e) { console.warn('geoip-lite unavailable; visitor country will be blank'); }

function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || (req.socket && req.socket.remoteAddress) || '';
}
function countryFromReq(req) {
  try {
    if (!geoip) return '';
    const g = geoip.lookup(clientIp(req));
    return (g && g.country) || ''; // ISO 3166-1 alpha-2, e.g. "IT", "AL"
  } catch (_) { return ''; }
}

// ─── Bot / crawler filtering ───────────────────────────────────────────────
// Visitor & view counts should approximate Google Analytics, which excludes
// bots. We drop any request whose User-Agent looks like a known crawler, link
// unfurler, uptime monitor, headless browser, or HTTP library — and any request
// with no User-Agent at all (real browsers always send one). Applied at the
// tracking ingestion points so web-visitors.json / web-daily.json stay clean.
const BOT_UA_RE = new RegExp([
  'bot', 'crawl', 'spider', 'slurp', 'mediapartners', 'adsbot', 'bingpreview',
  'facebookexternalhit', 'facebot', 'whatsapp', 'telegram', 'discord', 'slack',
  'twitter', 'linkedin', 'embedly', 'pinterest', 'redditbot', 'applebot',
  'petalbot', 'yandex', 'baidu', 'sogou', 'exabot', 'duckduck', 'semrush',
  'ahrefs', 'mj12', 'dotbot', 'dataforseo', 'seznam', 'bytespider', 'gptbot',
  'claudebot', 'ccbot', 'amazonbot', 'headless', 'phantom', 'puppeteer',
  'playwright', 'selenium', 'python-requests', 'python-urllib', 'aiohttp',
  'okhttp', 'go-http-client', 'libwww', 'wget', 'curl', 'httpclient', 'axios',
  'node-fetch', 'lighthouse', 'pagespeed', 'gtmetrix', 'pingdom', 'uptimerobot',
  'statuscake', 'monitis', 'newrelic', 'site24x7', 'prerender', 'archive.org',
  'ia_archiver', 'feedfetcher', 'apache-httpclient', 'java/', 'scrapy',
].join('|'), 'i');

function isBotRequest(req) {
  const ua = String((req.headers && req.headers['user-agent']) || '');
  if (!ua.trim()) return true;        // no UA → not a real browser
  return BOT_UA_RE.test(ua);
}

// One JSON map keyed by sessionId. We store only the resolved country, never
// the raw IP, plus the funnel flags the dashboard reports on.
const WEB_VISITORS_FILE = 'web-visitors.json';
function emptyFunnel() {
  return { landed: false, opened: false, messaged: false, bookingLinkShown: false,
           bookingLinkClicked: false, whatsappClicked: false, leadCaptured: false };
}
function upsertWebVisitor(sessionId, patch, req) {
  if (!sessionId) return null;
  const all = readJSON(WEB_VISITORS_FILE, {});
  const now = new Date().toISOString();
  const prev = all[sessionId] || {
    sessionId, channel: 'website',
    country: req ? countryFromReq(req) : '',
    name: '', email: '', phone: '',
    messages: 0, funnel: emptyFunnel(), firstSeen: now,
  };
  if (!prev.country && req) prev.country = countryFromReq(req);
  const { incMessages, funnel: patchFunnel, __page, __ref, ...rest } = patch || {};
  const next = { ...prev, ...rest, lastSeen: now };
  if (incMessages) next.messages = (prev.messages || 0) + 1;
  if (__ref && !next.referrer) next.referrer = __ref;       // first (landing) referrer only
  if (__page) {
    next.pages = (prev.pages || []).slice();
    if (next.pages[next.pages.length - 1] !== __page) next.pages.push(__page);
    while (next.pages.length > 30) next.pages.shift();
    if (!next.landingPage) next.landingPage = __page;
  }
  next.funnel = { ...emptyFunnel(), ...prev.funnel, ...(patchFunnel || {}) };
  all[sessionId] = next;
  const keys = Object.keys(all);
  if (keys.length > 2000) {
    keys.sort((a, b) => (all[a].lastSeen > all[b].lastSeen ? 1 : -1));
    while (Object.keys(all).length > 2000) delete all[keys.shift()];
  }
  writeJSON(WEB_VISITORS_FILE, all);
  return next;
}

// ── Per-day website analytics (the EXACT source for the daily report) ──────
// The per-visitor `web-visitors.json` snapshot above is cumulative for the
// lifetime of a (localStorage-persisted) sessionId, so it spans many days and
// CANNOT yield an accurate single-day figure. Instead we keep a per-day log,
// keyed by date in REPORT_TZ, that records — for that calendar day only —
// each session's resolved country, page-views, real on-site duration, and
// Gonxhe messages, plus a per-page view tally. Everything in the report is
// derived from this, so each day's numbers are exact for that 24h window.
//   web-daily.json = { "YYYY-MM-DD": { sessions: { sid: {c,v,d,m} }, pages: { path: n } } }
//     c = ISO country, v = page-views, d = active ms on site, m = Gonxhe messages
const WEB_DAILY_FILE = 'web-daily.json';
const DAY_MS = 24 * 60 * 60 * 1000;

function emptyDay() { return { sessions: {}, pages: {} }; }

function withWebDaily(mutator) {
  const data = readJSON(WEB_DAILY_FILE, {});
  mutator(data);
  const days = Object.keys(data).sort();
  while (days.length > 400) delete data[days.shift()]; // keep ~13 months
  writeJSON(WEB_DAILY_FILE, data);
}

// Get (creating if needed) a session bucket for `day`. tzDateString is a
// hoisted function declaration, so it's safe to call here.
function daySession(data, day, sid) {
  if (!data[day]) data[day] = emptyDay();
  if (!data[day].sessions[sid]) data[day].sessions[sid] = { c: '', v: 0, d: 0, m: 0 };
  return data[day];
}

// A page load: +1 view for the session and the page, set country once.
function recordWebView(sessionId, page, country) {
  if (!sessionId) return;
  const day = tzDateString(new Date().toISOString());
  withWebDaily(data => {
    const d = daySession(data, day, sessionId);
    d.sessions[sessionId].v += 1;
    if (country && !d.sessions[sessionId].c) d.sessions[sessionId].c = country;
    if (page) {
      const key = (String(page).split('?')[0] || '/') || '/';
      d.pages[key] = (d.pages[key] || 0) + 1;
    }
  });
}

// Ensure a session exists for the day (and capture country) without a view —
// used for non-'landed' funnel pings.
function touchWebSession(sessionId, country) {
  if (!sessionId) return;
  const day = tzDateString(new Date().toISOString());
  withWebDaily(data => {
    const d = daySession(data, day, sessionId);
    if (country && !d.sessions[sessionId].c) d.sessions[sessionId].c = country;
  });
}

// A measured chunk of real, active on-site time (ms). Deltas are summed, so
// multiple beacons never double-count; a per-delta clamp guards against clock
// jumps / a tab left in the background.
function recordWebDuration(sessionId, ms, country) {
  if (!sessionId) return;
  const add = Math.max(0, Math.min(Number(ms) || 0, 30 * 60 * 1000)); // ≤30 min per chunk
  if (!add) return;
  const day = tzDateString(new Date().toISOString());
  withWebDaily(data => {
    const d = daySession(data, day, sessionId);
    d.sessions[sessionId].d += add;
    if (country && !d.sessions[sessionId].c) d.sessions[sessionId].c = country;
  });
}

// One Gonxhe reply (a message exchange) for this session, today.
function recordWebMessage(sessionId, country) {
  if (!sessionId) return;
  const day = tzDateString(new Date().toISOString());
  withWebDaily(data => {
    const d = daySession(data, day, sessionId);
    d.sessions[sessionId].m += 1;
    if (country && !d.sessions[sessionId].c) d.sessions[sessionId].c = country;
  });
}

// ─── Middleware ──────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));

// We sit behind Render's proxy — trust it so clientIp() reads X-Forwarded-For.
app.set('trust proxy', true);

// CORS — only the public chat/widget endpoints are opened cross-origin so the
// hotel website (a different domain, e.g. Webflow) can talk to Gonxhe. The
// dashboard/admin/read endpoints are NOT listed here and stay same-origin.
const PUBLIC_API_PREFIXES = ['/api/gonxhe', '/api/web', '/api/conversation', '/api/event', '/api/feedback', '/api/guest'];
app.use((req, res, next) => {
  const open = PUBLIC_API_PREFIXES.some(p => req.path === p || req.path.startsWith(p + '/'));
  if (open) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});

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

// Separate password (defaults to "Admin26") guarding the Gonxhe Cost tab —
// the dashboard password is shared with reception, the admin password isn't.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin26';
function requireAdminAuth(req, res, next) {
  const provided = req.headers['x-admin-password'] || req.query.adminPassword;
  if (provided !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// ─── Gonxhe usage tracking ───────────────────────────────────────────────
// Aggregated in one small JSON file. We keep a lifetime cumulative bucket
// (never trimmed) and a per-day bucket (last ~365 days) so the dashboard can
// show today / this month / lifetime without scanning a full message log.
const GONXHE_USAGE_FILE = 'gonxhe-usage.json';

// Anthropic Sonnet 4.x list price, USD per million tokens. Update here if
// the active model (GONXHE_MODEL) or pricing tier changes.
const GONXHE_RATES_PER_MILLION = {
  input: 3,
  output: 15,
  cache_create: 3.75, // 5-minute ephemeral cache write
  cache_read: 0.30,
};

function zeroUsageBucket() {
  return { input: 0, output: 0, cache_create: 0, cache_read: 0, messages: 0 };
}

function recordGonxheUsage(usage) {
  if (!usage || typeof usage !== 'object') return;
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const data = readJSON(GONXHE_USAGE_FILE, { lifetime: zeroUsageBucket(), byDay: {} });
  if (!data.lifetime) data.lifetime = zeroUsageBucket();
  if (!data.byDay) data.byDay = {};
  if (!data.byDay[today]) data.byDay[today] = zeroUsageBucket();

  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cacheCreate = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;

  for (const bucket of [data.lifetime, data.byDay[today]]) {
    bucket.input += inputTokens;
    bucket.output += outputTokens;
    bucket.cache_create += cacheCreate;
    bucket.cache_read += cacheRead;
    bucket.messages += 1;
  }

  // Trim byDay to the last 365 entries — keeps the file small forever.
  const days = Object.keys(data.byDay).sort();
  while (days.length > 365) {
    delete data.byDay[days.shift()];
  }

  writeJSON(GONXHE_USAGE_FILE, data);
}

function computeGonxheCost(bucket) {
  if (!bucket) return 0;
  const r = GONXHE_RATES_PER_MILLION;
  return (
    (bucket.input || 0) * r.input +
    (bucket.output || 0) * r.output +
    (bucket.cache_create || 0) * r.cache_create +
    (bucket.cache_read || 0) * r.cache_read
  ) / 1_000_000;
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

const WEBSITE_CONV_FILE = 'website-conversations.json';
const HOTEL_CONV_FILE = 'hotel-conversations.json';

app.post('/api/conversation', (req, res) => {
  const { sessionId, room, guest, messages, channel } = req.body || {};
  if (!sessionId || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'sessionId and messages required' });
  }
  const isWebsite = channel === 'website';
  const file = isWebsite ? WEBSITE_CONV_FILE : HOTEL_CONV_FILE;
  const all = readJSON(file, {});
  all[sessionId] = {
    sessionId,
    channel: isWebsite ? 'website' : 'guest',
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
  writeJSON(file, all);
  if (isWebsite && !isBotRequest(req)) {
    try { upsertWebVisitor(sessionId, { funnel: { opened: true } }, req); }
    catch (e) { console.error('web visitor (conversation) update failed', e); }
  }
  res.json({ ok: true });
});

// ─── WEBSITE VISITOR FUNNEL PING (public, CORS-open) ──────────────────────
// The widget calls this to record funnel steps it can see client-side:
// 'opened', 'booking_link_clicked', 'whatsapp_clicked'. (messaged /
// bookingLinkShown are set server-side inside /api/gonxhe.)
app.post('/api/web/visit', (req, res) => {
  const { sessionId, event } = req.body || {};
  if (!sessionId || !event) {
    return res.status(400).json({ error: 'sessionId and event required' });
  }
  // Don't record bots/crawlers — keeps counts comparable to Google Analytics.
  if (isBotRequest(req)) return res.json({ ok: true, skipped: 'bot' });
  const country = countryFromReq(req);

  // 'duration' is a measured chunk of real active time (ms) — it feeds the
  // accurate per-day on-site metric and is NOT a funnel step.
  if (event === 'duration') {
    recordWebDuration(sessionId, (req.body && req.body.ms), country);
    return res.json({ ok: true });
  }

  const EVENT_TO_FLAG = {
    landed: 'landed',
    opened: 'opened',
    booking_link_shown: 'bookingLinkShown',
    booking_link_clicked: 'bookingLinkClicked',
    whatsapp_clicked: 'whatsappClicked',
  };
  const flag = EVENT_TO_FLAG[event];
  const { page, ref } = req.body || {};
  const patch = { funnel: flag ? { [flag]: true } : {} };
  if (page) patch.__page = String(page).slice(0, 200);
  if (ref) patch.__ref = String(ref).slice(0, 300);
  upsertWebVisitor(sessionId, patch, req);

  // Per-day accurate log: a 'landed' is a page view; other pings just ensure
  // the session (and its country) is counted for the day.
  if (event === 'landed') {
    recordWebView(sessionId, page ? String(page).slice(0, 200) : '', country);
  } else {
    touchWebSession(sessionId, country);
  }
  res.json({ ok: true });
});

// ─── WEBSITE WHATSAPP LEAD (from the 5-min follow-up form) ────────────────
// A pending visitor (clicked the booking engine) leaves a WhatsApp number so
// reception can offer them the best rate for the dates they were viewing.
app.post('/api/web/lead', (req, res) => {
  const { sessionId, name, phone, checkin, checkout, adults, kids } = req.body || {};
  if (!sessionId || !phone) {
    return res.status(400).json({ error: 'sessionId and phone required' });
  }
  const cleanPhone = String(phone).slice(0, 40);
  upsertWebVisitor(sessionId, {
    ...(name ? { name: String(name).slice(0, 80) } : {}),
    phone: cleanPhone,
    interestCheckin: String(checkin || '').slice(0, 12),
    interestCheckout: String(checkout || '').slice(0, 12),
    interestAdults: String(adults || '').slice(0, 4),
    interestKids: String(kids || '').slice(0, 4),
    funnel: { leadCaptured: true },
  }, req);
  const dates = (checkin && checkout) ? (checkin + ' → ' + checkout) : '';
  const pax = (adults || kids)
    ? (String(adults || '?') + ' adults' + ((kids && kids !== '0') ? (', ' + kids + ' kids') : ''))
    : '';
  try {
    appendItem('events.json', {
      id: crypto.randomUUID(), ts: new Date().toISOString(),
      room: '—', type: 'web_lead_whatsapp',
      detail: ['WhatsApp ' + cleanPhone, dates ? ('dates ' + dates) : '', pax]
        .filter(Boolean).join(' · ').slice(0, 280),
      guest: name ? String(name).slice(0, 80) : '', sessionId: sessionId || '', channel: 'website',
    });
  } catch (e) { console.error('web lead log failed', e); }
  res.json({ ok: true });
});

// ─── GONXHE BOOKING TOOL ─────────────────────────────────────────────────
// Reception WhatsApp (digits only, for wa.me). Mirrors WA_PHONE in index.html.
const RECEPTION_WA = '355692073380';

// One tool: turn a guest's booking intent into a ready-to-send WhatsApp message
// to reception. There is no WhatsApp Business API here — "sending" means handing
// the guest a wa.me deep link, pre-filled with the booking details, that they tap
// to fire off to reception (who then confirm or propose another time).
const GONXHE_TOOLS = [{
  name: 'prepare_booking_request',
  description:
    "Use this when a guest wants to BOOK one of these and you have all the details: " +
    "(a) a Spa treatment, (b) a Salon/hair service such as a blow dry, or (c) the Dégustation Menu. " +
    "Before calling, make sure you have: the service name, the guest's preferred day/time, the guest's name, and their room number. " +
    "For the Dégustation Menu you ALSO need the restaurant (Flower Restaurant or Brutal Steakhouse). " +
    "If any required detail is missing, ask the guest for it first — do NOT guess. " +
    "This returns a ready-to-send WhatsApp message link for reception; present it to the guest with a short summary table.",
  input_schema: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: ['spa', 'salon', 'degustation'],
        description: 'spa = spa treatment; salon = hair/beauty e.g. blow dry; degustation = Dégustation Menu' },
      service: { type: 'string', description: 'The exact service, e.g. "Blow dry", "Couple Massage", "Dégustation Menu".' },
      preferredTime: { type: 'string', description: 'The day and/or time the guest wants, in their own words, e.g. "today 16:00", "tomorrow 7:30pm".' },
      guestName: { type: 'string', description: "The guest's name." },
      roomNumber: { type: 'string', description: "The guest's room number." },
      restaurant: { type: 'string', enum: ['Flower Restaurant', 'Brutal Steakhouse'],
        description: 'Required ONLY when category is degustation.' },
    },
    required: ['category', 'service', 'preferredTime', 'guestName', 'roomNumber'],
  },
}];

const GONXHE_BOOKING_GUIDE =
  "BOOKING REQUESTS — when a guest wants to book a Spa treatment, a Salon/hair service (e.g. a blow dry), " +
  "or the Dégustation Menu: collect the service, the preferred day/time, the guest's name and room number " +
  "(plus the restaurant — Flower Restaurant or Brutal Steakhouse — for the Dégustation Menu), then call the " +
  "prepare_booking_request tool. Ask for any missing detail first; never invent a name, room, or time. " +
  "After the tool returns, show the guest a short summary table of their request, then the ready WhatsApp link " +
  "rendered as a markdown link with this EXACT short label and nothing else: [📲 Tap to get your booking confirmation](LINK). " +
  "Never paste the raw URL on its own — always wrap it in that markdown label so the guest sees a short button, not a long link. Do NOT tell the guest the " +
  "booking is confirmed, done, or booked — nothing is confirmed yet. Instead, clearly tell the guest that our " +
  "reservations team will send them a confirmation very soon, and may confirm the requested time or propose an alternative.";

// Build the pre-filled reception WhatsApp message + log the request to the
// staff dashboard event feed. Returns the data Gonxhe needs to reply.
function runBookingTool(input) {
  const cat = input && input.category;
  const lines = [
    'New booking request via Gonxhe',
    `Service: ${input.service}`,
  ];
  if (cat === 'degustation' && input.restaurant) {
    lines.push(`Restaurant: ${input.restaurant}`);
  }
  lines.push(
    `Preferred time: ${input.preferredTime}`,
    `Guest: ${input.guestName}`,
    `Room: ${input.roomNumber}`,
    '',
    'Please confirm this time, or suggest an alternative. Thank you!'
  );
  const waMessage = lines.join('\n');
  const link = `https://wa.me/${RECEPTION_WA}?text=${encodeURIComponent(waMessage)}`;

  try {
    appendItem('events.json', {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      room: String(input.roomNumber || '—').slice(0, 32),
      type: 'gonxhe_booking_request',
      detail: [input.service, cat === 'degustation' ? input.restaurant : null, input.preferredTime]
        .filter(Boolean).join(' · ').slice(0, 280),
      guest: String(input.guestName || '').slice(0, 80),
      sessionId: '',
    });
  } catch (e) { console.error('booking event log failed', e); }

  return { whatsappLink: link, summary: { ...input } };
}

// ─── WEBSITE TOOL — capture_lead (channel === 'website') ───────────────────
// Stores a website visitor's contact details when THEY offer them. Mirrors the
// "conversational, only when offered" rule in the website prompt.
const CAPTURE_LEAD_TOOL = {
  name: 'capture_lead',
  description:
    "Save a website visitor's contact details ONLY after they have freely offered them " +
    "(for a callback, a custom/group quote, or a follow-up). Never ask for details just to " +
    "call this tool, and never invent values. Pass only the fields the visitor actually gave.",
  input_schema: {
    type: 'object',
    properties: {
      name:  { type: 'string', description: "Visitor's name, if given." },
      email: { type: 'string', description: 'Email, if given.' },
      phone: { type: 'string', description: 'Phone / WhatsApp number, if given.' },
      note:  { type: 'string', description: 'Short note on what they want (callback, quote, dates of interest).' },
    },
  },
};
// ─── WEBSITE TOOL — check_trinosoft_availability ─────────────────────────────
// Checks real-time room availability by screenshotting the Trinosoft HMS Gantt
// chart (running on the hotel computer) and analysing it with Claude Vision.
// Requires TRINOSOFT_BRIDGE_URL env var pointing to the local bridge tunnel.
const CHECK_AVAILABILITY_TOOL = {
  name: 'check_trinosoft_availability',
  description:
    'Check REAL-TIME room availability in Trinosoft HMS for specific dates. ' +
    'Call this when a visitor asks if rooms are available, what rooms are free, ' +
    'or when you want to give them a concrete availability answer before sending a booking link. ' +
    'You need their check-in date, check-out date, and number of guests. ' +
    'Returns which room types are available so you can recommend the right rooms.',
  input_schema: {
    type: 'object',
    properties: {
      checkin:  { type: 'string', description: 'Check-in date in YYYY-MM-DD format.' },
      checkout: { type: 'string', description: 'Check-out date in YYYY-MM-DD format.' },
      guests:   { type: 'number', description: 'Total number of guests (adults + children).' },
    },
    required: ['checkin', 'checkout'],
  },
};

async function runTrinosoftAvailability(input, apiKey) {
  const bridgeUrl = process.env.TRINOSOFT_BRIDGE_URL;
  const bridgeKey = process.env.TRINOSOFT_BRIDGE_KEY || 'GonxheBridge26';
  if (!bridgeUrl) {
    return { available: null, note: 'Trinosoft bridge not configured — direct guest to booking engine.' };
  }
  const { checkin, checkout, guests = 2 } = input || {};
  const url = `${bridgeUrl}/screenshot?checkin=${encodeURIComponent(checkin)}&checkout=${encodeURIComponent(checkout)}&key=${encodeURIComponent(bridgeKey)}`;
  let imgB64;
  try {
    const resp = await fetch(url, { headers: { 'x-bridge-key': bridgeKey }, signal: AbortSignal.timeout(20000) });
    if (!resp.ok) throw new Error(`Bridge error ${resp.status}`);
    const buf = await resp.arrayBuffer();
    imgB64 = Buffer.from(buf).toString('base64');
  } catch (e) {
    console.error('Trinosoft bridge fetch failed:', e.message);
    return { available: null, note: 'Could not reach Trinosoft — direct guest to booking engine.' };
  }

  // Use Claude Vision to read the Gantt chart
  const visionResp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imgB64 } },
          { type: 'text', text:
            `This is a Trinosoft HMS Gantt chart showing Flower Hotel room reservations.\n` +
            `Check-in: ${checkin}, Check-out: ${checkout}, Guests: ${guests}.\n` +
            `Rooms with NO colored bar during this period are AVAILABLE. Rooms WITH a bar are OCCUPIED.\n` +
            `Room types: CL = FLOWER Classic Room (sleeps 1-2), LS = FLOWER Loft Suite (sleeps 2-4).\n` +
            `List which rooms appear FREE (no bar / empty row) for those dates. Be concise.\n` +
            `Return JSON: {"available_types":["Classic Room","Loft Suite"],"available_rooms":["420 CL","116 LS"...],"occupied_count":12,"note":"..."}`
          }
        ]
      }]
    })
  });
  const vData = await visionResp.json();
  const raw = (vData.content || []).find(b => b.type === 'text')?.text || '{}';
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : { available: null, raw };
  } catch (_) {
    return { available: null, raw };
  }
}

// ─── WEBSITE TOOL — send_room_inquiry ────────────────────────────────────────
// Widget-side inquiry form collects guest details and sends a prefilled WhatsApp
// to the reservation desk. This backend tool saves the lead for the dashboard.
const SEND_ROOM_INQUIRY_TOOL = {
  name: 'send_room_inquiry',
  description:
    "Use this when a website visitor wants to make a room booking inquiry and has freely provided: " +
    "their name, a WhatsApp or phone number, AND their preferred dates (check-in / check-out) and guest count. " +
    "This generates a prefilled WhatsApp message to our reservations team on the visitor's behalf. " +
    "Do NOT call it if any of name, phone, checkin, checkout, or guests is missing — ask first. " +
    "Never invent values. After the tool returns, show the visitor a short summary table of their inquiry " +
    "and render the link as: [📲 Send your inquiry to our team](LINK). " +
    "Tell them the reservations team will reply on WhatsApp shortly.",
  input_schema: {
    type: 'object',
    properties: {
      name:     { type: 'string', description: "Visitor's name." },
      phone:    { type: 'string', description: "WhatsApp or phone number, as they gave it." },
      checkin:  { type: 'string', description: "Check-in date, YYYY-MM-DD." },
      checkout: { type: 'string', description: "Check-out date, YYYY-MM-DD." },
      guests:   { type: 'string', description: "Total number of guests (adults + children)." },
      note:     { type: 'string', description: "Any special requests or preferences, if mentioned." },
    },
    required: ['name', 'phone', 'checkin', 'checkout', 'guests'],
  },
};

const WEBSITE_TOOLS = [CAPTURE_LEAD_TOOL, CHECK_AVAILABILITY_TOOL, SEND_ROOM_INQUIRY_TOOL];

const WEBSITE_TOOL_GUIDE =
  'You are on the public website with a PROSPECTIVE guest who has not booked. Your priority is to ' +
  'guide them into the Cloudbeds booking engine to book a room directly. ' +
  'INQUIRY FORM — when a visitor provides their check-in date, check-out date, and guest count AND ' +
  'clearly wants a personal quote or human follow-up (rather than booking online themselves), respond ' +
  'warmly and append this EXACT hidden token at the very end of your reply (no space before it): ' +
  '<!--INQUIRY:YYYY-MM-DD|YYYY-MM-DD|N--> where the values are check-in, check-out, and total guests. ' +
  'Example: a visitor says "2 adults, 10 to 14 July" → append <!--INQUIRY:2026-07-10|2026-07-14|2-->. ' +
  'The widget strips the token from display and shows a pre-filled enquiry form immediately. ' +
  'Never include the token when sending a Cloudbeds booking link — only for the inquiry/personal-quote route. ' +
  'AVAILABILITY: if a visitor asks whether rooms are available or free for specific dates, call ' +
  'check_trinosoft_availability to check live availability in the hotel HMS — then respond with what you found ' +
  'and follow immediately with the pre-filled Cloudbeds booking link for their dates. ' +
  'LEAD CAPTURE — when (and only when) a visitor freely shares their name, email, or phone for a ' +
  'callback, quote, or follow-up, call the capture_lead tool to save it — never ask for details just ' +
  'to use the tool, and never invent values.';

function runCaptureLead(sessionId, input, req) {
  const name  = String((input && input.name)  || '').slice(0, 80);
  const email = String((input && input.email) || '').slice(0, 120);
  const phone = String((input && input.phone) || '').slice(0, 40);
  const note  = String((input && input.note)  || '').slice(0, 280);
  upsertWebVisitor(sessionId, {
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    funnel: { leadCaptured: true },
  }, req);
  try {
    appendItem('events.json', {
      id: crypto.randomUUID(), ts: new Date().toISOString(),
      room: '—', type: 'web_lead_captured',
      detail: [name, email, phone, note].filter(Boolean).join(' · ').slice(0, 280),
      guest: name, sessionId: sessionId || '', channel: 'website',
    });
  } catch (e) { console.error('lead event log failed', e); }
  return { ok: true, saved: { name, email, phone } };
}

function runRoomInquiry(sessionId, input, req) {
  const name     = String((input && input.name)     || '').slice(0, 80);
  const phone    = String((input && input.phone)    || '').slice(0, 40);
  const checkin  = String((input && input.checkin)  || '').slice(0, 20);
  const checkout = String((input && input.checkout) || '').slice(0, 20);
  const guests   = String((input && input.guests)   || '').slice(0, 10);
  const note     = String((input && input.note)     || '').slice(0, 280);

  const lines = [
    'New room inquiry from website',
    `Name: ${name}`,
    `WhatsApp: ${phone}`,
    `Check-in: ${checkin}`,
    `Check-out: ${checkout}`,
    `Guests: ${guests}`,
    ...(note ? [`Note: ${note}`] : []),
    '',
    'Please follow up with this guest. Thank you!',
  ];
  const waMessage = lines.join('\n');
  const link = `https://wa.me/${RECEPTION_WA}?text=${encodeURIComponent(waMessage)}`;

  // Save contact to web-visitors so the dashboard sees them
  upsertWebVisitor(sessionId, {
    ...(name  ? { name }  : {}),
    ...(phone ? { phone } : {}),
    funnel: { leadCaptured: true, inquirySent: true },
  }, req);

  try {
    appendItem('events.json', {
      id: crypto.randomUUID(), ts: new Date().toISOString(),
      room: '—', type: 'web_room_inquiry',
      detail: [name, phone, checkin, checkout, `${guests} guests`, note].filter(Boolean).join(' · ').slice(0, 280),
      guest: name, sessionId: sessionId || '', channel: 'website',
    });
  } catch (e) { console.error('room inquiry event log failed', e); }

  return { whatsappLink: link, summary: { name, phone, checkin, checkout, guests, note } };
}

// Safety net against a known LLM failure mode: occasionally a model echoes the
// same answer twice (guests reported this on "what's on tonight"). Collapse a
// duplicated reply so it's never shown twice. Conservative: only removes a
// whole-message exact double, or a substantial paragraph (≥40 chars) that
// exactly repeats an earlier one — clean replies pass through unchanged.
function dedupeReply(text) {
  const s = String(text || '');
  const norm = x => x.replace(/\s+/g, ' ').trim().toLowerCase();
  const t = s.trim();
  const half = Math.floor(t.length / 2);
  const a = t.slice(0, half).trim(), b = t.slice(half).trim();
  if (a.length >= 80 && norm(a) === norm(b)) return a;
  const seen = new Set(), out = [];
  for (const para of s.split(/\n{2,}/)) {
    const key = norm(para);
    if (key.length >= 40 && seen.has(key)) continue;
    if (key.length >= 40) seen.add(key);
    out.push(para);
  }
  return out.join('\n\n');
}

// ─── GONXHE PROXY ────────────────────────────────────────────────────────
app.post('/api/gonxhe', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { messages, channel, sessionId } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages required' });
  }
  const isWebsite = channel === 'website';
  // Server is the single source of truth for the system prompt — editable from
  // the dashboard's "Train Gonxhe" tab. The browser never controls it. The
  // website channel uses its own separately-trained prompt.
  const effectiveSystem = isWebsite ? getWebsitePrompt() : getSystemPrompt();

  // Give Gonxhe the current date/time in the hotel's timezone so she never has
  // to ask the guest what day it is. Kept as a separate (uncached) system block
  // so the large editable prompt above still gets a cache hit.
  let nowBlock = '';
  try {
    nowBlock = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Tirane',
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date());
  } catch (_) {
    nowBlock = new Date().toUTCString();
  }
  const dateContext =
    `Current date and time at the hotel (Europe/Tirane, Albania): ${nowBlock}. ` +
    `Use this as "today" for any date question — never ask the guest what the date is.`;

  const system = [
    { type: 'text', text: effectiveSystem, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: dateContext },
    { type: 'text', text: isWebsite ? WEBSITE_TOOL_GUIDE : GONXHE_BOOKING_GUIDE },
  ];

  // Work on a copy so the tool-use loop can append turns without touching what
  // the browser sent (the client only ever stores Gonxhe's final text reply).
  const convo = messages.slice();

  try {
    let finalText = '';
    // A booking resolves in one tool round-trip; the cap is a runaway guard.
    for (let hop = 0; hop < 4; hop++) {
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
          system,
          tools: isWebsite ? WEBSITE_TOOLS : GONXHE_TOOLS,
          messages: convo,
        }),
      });
      const data = await upstream.json();
      if (!upstream.ok) {
        console.error('Anthropic upstream error', upstream.status, data);
        return res.status(upstream.status).json({ error: 'upstream', detail: data });
      }
      // Persist usage for the Gonxhe Cost dashboard (every hop counts). Failures
      // here must never break the chat reply, so we swallow errors after logging.
      try { recordGonxheUsage(data.usage); } catch (e) { console.error('gonxhe usage log failed', e); }

      const blocks = data.content || [];
      const textNow = blocks.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
      if (textNow) finalText = textNow;

      if (data.stop_reason !== 'tool_use') break;

      // Run each requested tool and feed the results back for the next hop.
      const toolResults = await Promise.all(blocks.filter(b => b.type === 'tool_use').map(async tu => {
        let content;
        try {
          if (tu.name === 'prepare_booking_request') {
            content = JSON.stringify(runBookingTool(tu.input || {}));
          } else if (tu.name === 'capture_lead') {
            content = JSON.stringify(runCaptureLead(sessionId, tu.input || {}, req));
          } else if (tu.name === 'check_trinosoft_availability') {
            content = JSON.stringify(await runTrinosoftAvailability(tu.input || {}, apiKey));
          } else if (tu.name === 'send_room_inquiry') {
            content = JSON.stringify(runRoomInquiry(sessionId, tu.input || {}, req));
          } else {
            content = JSON.stringify({ error: 'unknown_tool' });
          }
        } catch (e) {
          console.error('gonxhe tool failed', e);
          content = JSON.stringify({ error: 'tool_failed' });
        }
        return { type: 'tool_result', tool_use_id: tu.id, content };
      }));
      convo.push({ role: 'assistant', content: blocks });
      convo.push({ role: 'user', content: toolResults });
    }
    if (!finalText) {
      finalText = 'Please contact our reception on WhatsApp: https://wa.me/' + RECEPTION_WA;
    }
    finalText = dedupeReply(finalText); // never show the same answer twice
    // Website funnel: count the exchange and flag when a booking-engine link was
    // offered, so the Website dashboard shows engagement without the widget
    // reporting every turn separately.
    if (isWebsite && sessionId && !isBotRequest(req)) {
      try {
        const showsBooking = /cloudbeds\.com/i.test(finalText);
        upsertWebVisitor(sessionId, {
          incMessages: true,
          funnel: { messaged: true, ...(showsBooking ? { bookingLinkShown: true } : {}) },
        }, req);
        recordWebMessage(sessionId, countryFromReq(req)); // exact per-day tally for the daily report
      } catch (e) { console.error('web visitor update failed', e); }
    }
    res.json({ text: finalText });
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

// ─── ADMIN AUTH PING (used by the Gonxhe Cost lock) ──────────────────────
app.post('/api/admin-auth', (req, res) => {
  const provided = (req.body && req.body.password) || '';
  res.json({ ok: provided === ADMIN_PASSWORD });
});

// ─── GONXHE USAGE (admin-only) ───────────────────────────────────────────
app.get('/api/gonxhe-usage', requireAdminAuth, (_req, res) => {
  const data = readJSON(GONXHE_USAGE_FILE, { lifetime: zeroUsageBucket(), byDay: {} });
  const today = new Date().toISOString().slice(0, 10);
  const monthPrefix = today.slice(0, 7); // YYYY-MM

  const sumDays = (predicate) => {
    const acc = zeroUsageBucket();
    for (const [day, b] of Object.entries(data.byDay || {})) {
      if (!predicate(day)) continue;
      acc.input += b.input || 0;
      acc.output += b.output || 0;
      acc.cache_create += b.cache_create || 0;
      acc.cache_read += b.cache_read || 0;
      acc.messages += b.messages || 0;
    }
    return acc;
  };

  const todayBucket = data.byDay?.[today] || zeroUsageBucket();
  const monthBucket = sumDays(d => d.startsWith(monthPrefix));
  const lifetimeBucket = data.lifetime || zeroUsageBucket();

  const withCost = (b) => ({ ...b, cost_usd: computeGonxheCost(b) });

  res.json({
    model: process.env.GONXHE_MODEL || 'claude-sonnet-4-6',
    rates_per_million_usd: GONXHE_RATES_PER_MILLION,
    today: withCost(todayBucket),
    month: withCost(monthBucket),
    lifetime: withCost(lifetimeBucket),
  });
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
  const map = readJSON(HOTEL_CONV_FILE, {});
  const list = Object.values(map)
    .sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1));
  res.json({ conversations: list });
});

// ─── WEBSITE ACTIVITY (admin/dashboard read) ──────────────────────────────
// Joins each website visitor with their transcript and returns funnel totals.
app.get('/api/web-activity', requireDashboardAuth, (_req, res) => {
  const visitorsMap = readJSON(WEB_VISITORS_FILE, {});
  const convs = readJSON(WEBSITE_CONV_FILE, {});
  const visitors = Object.values(visitorsMap)
    .map(v => ({ ...v, transcript: (convs[v.sessionId] && convs[v.sessionId].messages) || [] }))
    .sort((a, b) => ((a.lastSeen || '') > (b.lastSeen || '') ? -1 : 1));
  const funnel = { visitors: visitors.length, opened: 0, messaged: 0,
    bookingLinkShown: 0, bookingLinkClicked: 0, whatsappClicked: 0, leadCaptured: 0 };
  for (const v of visitors) {
    const f = v.funnel || {};
    if (f.opened) funnel.opened++;
    if (f.messaged) funnel.messaged++;
    if (f.bookingLinkShown) funnel.bookingLinkShown++;
    if (f.bookingLinkClicked) funnel.bookingLinkClicked++;
    if (f.whatsappClicked) funnel.whatsappClicked++;
    if (f.leadCaptured) funnel.leadCaptured++;
  }
  // GA-style traffic volume, per day, from the accurate per-day log. The
  // dashboard sums these over its chosen date range:
  //   sessions = distinct sessions active that day (a daily "visit")
  //   views    = total page-views that day
  // (web-daily.json began on deploy day, so earlier days are absent → 0.)
  const daily = readJSON(WEB_DAILY_FILE, {});
  const dailyTotals = {};
  for (const [day, dd] of Object.entries(daily)) {
    const sids = Object.keys(dd.sessions || {});
    let views = 0;
    for (const sid of sids) views += (dd.sessions[sid].v || 0);
    dailyTotals[day] = { sessions: sids.length, views };
  }
  res.json({ visitors, funnel, dailyTotals });
});

// ─── WEBSITE VISITOR STATUS (reception pipeline, dashboard-only) ──────────
// Lets reception track each enquiry: New → Contacted → Booked → Lost.
app.post('/api/web/visitor-status', requireDashboardAuth, (req, res) => {
  const { sessionId, status } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  const ALLOWED = ['New', 'Contacted', 'Booked (WhatsApp)', 'Booked (Cloudbeds)', 'Booked', 'Lost'];
  const s = ALLOWED.indexOf(status) >= 0 ? status : 'New';
  const all = readJSON(WEB_VISITORS_FILE, {});
  if (!all[sessionId]) return res.status(404).json({ error: 'visitor not found' });
  all[sessionId].status = s;            // does not touch lastSeen / funnel
  writeJSON(WEB_VISITORS_FILE, all);
  res.json({ ok: true, status: s });
});

// ─── WEBSITE SYSTEM PROMPT (Train Gonxhe · Website) ───────────────────────
app.get('/api/website-prompt', requireDashboardAuth, (_req, res) => {
  res.json({ prompt: getWebsitePrompt() });
});
app.post('/api/website-prompt', requireDashboardAuth, (req, res) => {
  const { prompt } = req.body || {};
  if (typeof prompt !== 'string' || prompt.length < 20) {
    return res.status(400).json({ error: 'prompt too short' });
  }
  setWebsitePrompt(prompt);
  res.json({ ok: true });
});
app.post('/api/website-prompt/reset', requireDashboardAuth, (_req, res) => {
  try { fs.unlinkSync(path.join(DATA_DIR, WEBSITE_PROMPT_FILE)); } catch (_) {}
  res.json({ ok: true, prompt: getWebsitePrompt() });
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
  if (['country', 'nationality', 'shteti', 'kombesia'].includes(k)) return 'country';
  return null;
}

// Map common country names → ISO-3166 alpha-2 codes so the spreadsheet can
// carry either "Italy", "IT" or "italia" and we still normalize correctly.
const COUNTRY_NAME_TO_ISO = {
  'albania':'AL','shqipëria':'AL','shqiperia':'AL','italy':'IT','italia':'IT',
  'germany':'DE','deutschland':'DE','gjermania':'DE','france':'FR','francë':'FR','franca':'FR',
  'spain':'ES','españa':'ES','espana':'ES','spanja':'ES','greece':'GR','greqia':'GR',
  'united kingdom':'GB','uk':'GB','britain':'GB','great britain':'GB','england':'GB','angli':'GB','anglia':'GB',
  'united states':'US','usa':'US','u.s.a.':'US','u.s.':'US','america':'US','sh.b.a.':'US','shba':'US',
  'austria':'AT','switzerland':'CH','zvicra':'CH','netherlands':'NL','holland':'NL','holanda':'NL',
  'belgium':'BE','belgjika':'BE','portugal':'PT','ireland':'IE','irlanda':'IE',
  'poland':'PL','czech republic':'CZ','czechia':'CZ','slovakia':'SK','slovenia':'SI','hungary':'HU',
  'romania':'RO','rumania':'RO','bulgaria':'BG','serbia':'RS','serbi':'RS','serbia and montenegro':'RS',
  'kosovo':'XK','kosova':'XK','kosovë':'XK','north macedonia':'MK','macedonia':'MK','maqedonia':'MK',
  'montenegro':'ME','mali i zi':'ME','bosnia':'BA','bosnia and herzegovina':'BA',
  'croatia':'HR','kroacia':'HR','turkey':'TR','türkiye':'TR','turqia':'TR',
  'russia':'RU','rusia':'RU','ukraine':'UA','ukraina':'UA','belarus':'BY',
  'denmark':'DK','sweden':'SE','suedia':'SE','norway':'NO','norvegjia':'NO','finland':'FI','finlanda':'FI',
  'iceland':'IS','islanda':'IS','luxembourg':'LU','liechtenstein':'LI','monaco':'MC','san marino':'SM',
  'canada':'CA','kanadaja':'CA','australia':'AU','australi':'AU','new zealand':'NZ',
  'china':'CN','kina':'CN','japan':'JP','japonia':'JP','south korea':'KR','korea':'KR',
  'india':'IN','indi':'IN','indonesia':'ID','thailand':'TH','vietnam':'VN','philippines':'PH','singapore':'SG',
  'uae':'AE','united arab emirates':'AE','saudi arabia':'SA','israel':'IL','izraeli':'IL',
  'egypt':'EG','egjipti':'EG','morocco':'MA','tunisia':'TN','south africa':'ZA',
  'brazil':'BR','argentina':'AR','mexico':'MX','meksika':'MX','chile':'CL','peru':'PE','colombia':'CO',
};

function normalizeCountry(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (/^[A-Z]{2}$/i.test(v)) return v.toUpperCase();
  return COUNTRY_NAME_TO_ISO[v.toLowerCase()] || '';
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
    const obj = { name: '', email: '', phone: '', language: '', tags: [], country: '' };
    for (const [rawHeader, value] of Object.entries(row)) {
      const field = headerMap[rawHeader];
      if (!field) continue;
      if (field === 'tags') {
        obj.tags = String(value || '')
          .split(/[,;|]/).map(s => s.trim()).filter(Boolean);
      } else if (field === 'country') {
        obj.country = normalizeCountry(value);
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
      cur.country = obj.country || cur.country || '';
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
        country: obj.country,
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
    countries: Array.from(new Set(all.map(c => c.country).filter(Boolean))).sort(),
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
    const country = (filter && filter.country) ? String(filter.country).trim().toUpperCase() : null;
    recipients = all.filter(c => {
      if (tag && !((c.tags || []).some(t => t.toLowerCase() === tag))) return false;
      if (country && (c.country || '').toUpperCase() !== country) return false;
      return true;
    });
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

// ─── DAILY WEBSITE REPORT (Gonxhe site analytics → email at 09:00) ─────────
// Each morning, at REPORT_HOUR (default 09:00) in REPORT_TZ (Europe/Tirane),
// email a summary of the PREVIOUS day's website (Gonxhe) activity to
// reception/owners:
//   • visitors, broken down by nationality
//   • messages exchanged with Gonxhe
//   • most-visited page(s)
//   • average real (measured) time visitors spent on the site
// Data source is web-daily.json — a per-day, timestamp-scoped log (NOT the
// cumulative web-visitors.json), so every figure is exact for that 24h window.
// The email is sent FROM flowreport26@gmail.com (the reports mailbox) — set
// REPORT_SMTP_USER / REPORT_SMTP_PASS (a Gmail App Password) on Render.

const REPORT_TZ = process.env.REPORT_TZ || 'Europe/Tirane';
const REPORT_HOUR = Number(process.env.REPORT_HOUR || 9);
const REPORT_STATE_FILE = 'daily-report-state.json';
const REPORT_DEFAULT_TO =
  'info@hotel-flower.com, redathana@gmail.com, ernestcaci@gmail.com, reception@hotel-flower.com';

let regionNames = null;
try { regionNames = new Intl.DisplayNames(['en'], { type: 'region' }); } catch (_) {}
function countryName(code) {
  const c = String(code || '').toUpperCase();
  if (!c) return 'E panjohur';
  if (c === 'XK') return 'Kosovo';
  try { return (regionNames && regionNames.of(c)) || c; } catch (_) { return c; }
}

// YYYY-MM-DD for an ISO timestamp, evaluated in the report timezone.
function tzDateString(iso, tz = REPORT_TZ) {
  try {
    const d = iso ? new Date(iso) : new Date();
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d); // en-CA → YYYY-MM-DD
  } catch (_) { return String(iso || '').slice(0, 10); }
}

// The calendar day before a YYYY-MM-DD string (DST-safe via UTC noon).
function previousDay(dayStr) {
  const [y, m, d] = String(dayStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

// Current {hour, minute} in the report timezone.
function tzHourMinute(tz = REPORT_TZ) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
    return {
      hour: Number(parts.find(p => p.type === 'hour').value),
      minute: Number(parts.find(p => p.type === 'minute').value),
    };
  } catch (_) { const d = new Date(); return { hour: d.getHours(), minute: d.getMinutes() }; }
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Build the report object for a given YYYY-MM-DD (defaults to today, Tirane).
// EVERY figure comes from the per-day log (web-daily.json), scoped strictly to
// that calendar day — no cumulative/cross-day values, no estimation.
function buildDailyReport(dateStr) {
  const day = dateStr || tzDateString(new Date().toISOString());
  const daily = readJSON(WEB_DAILY_FILE, {});
  const dd = daily[day] || emptyDay();
  const sessions = Object.values(dd.sessions || {});

  // Visitors = distinct sessions active that day.
  const totalVisitors = sessions.length;

  // Nationality breakdown (ISO alpha-2 → full name; blank → Unknown).
  const byCountry = {};
  for (const s of sessions) {
    const code = (s.c || '').toUpperCase() || 'XX';
    byCountry[code] = (byCountry[code] || 0) + 1;
  }
  const nationalities = Object.entries(byCountry)
    .map(([code, count]) => ({
      code,
      name: code === 'XX' ? 'E panjohur' : countryName(code),
      count,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  // Messages exchanged with Gonxhe that day; chatters = sessions that messaged.
  let totalMessages = 0, chatters = 0;
  for (const s of sessions) {
    if (s.m > 0) { totalMessages += s.m; chatters++; }
  }

  // Most-visited pages — exact per-day view counts.
  const topPages = Object.entries(dd.pages || {})
    .map(([page, count]) => ({ page, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Time on site = real measured active duration, averaged over the sessions
  // that produced any (so single-ping bounces with 0 don't drag it down).
  let durSum = 0, durCount = 0;
  for (const s of sessions) {
    if (s.d > 0) { durSum += s.d; durCount++; }
  }
  const avgDwellMs = durCount ? Math.round(durSum / durCount) : 0;

  return {
    day,
    totalVisitors,
    nationalities,
    totalMessages,
    chatters,
    topPage: topPages[0] || null,
    topPages,
    avgDwellMs,
    totalDwellMs: durSum,
    measuredVisitors: durCount, // how many visitors contributed a time reading
  };
}

function reportEmailHTML(r) {
  const C = { navy: '#0E1A2E', card: '#142540', gold: '#C4A96A', dim: '#9C8550', text: '#E8D9B5' };
  const row = (label, value) =>
    `<tr><td style="padding:10px 0;border-bottom:1px solid rgba(196,169,106,0.15);color:${C.dim};font-size:13px;">${label}</td>` +
    `<td style="padding:10px 0;border-bottom:1px solid rgba(196,169,106,0.15);color:${C.text};font-size:15px;text-align:right;font-weight:bold;">${value}</td></tr>`;

  const natRows = r.nationalities.length
    ? r.nationalities.map(n =>
        `<tr><td style="padding:6px 0;color:${C.text};font-size:14px;">${n.name}</td>` +
        `<td style="padding:6px 0;color:${C.gold};font-size:14px;text-align:right;">${n.count}</td></tr>`).join('')
    : `<tr><td colspan="2" style="padding:6px 0;color:${C.dim};font-size:13px;">Asnjë vizitor sot.</td></tr>`;

  const pageRows = r.topPages.length
    ? r.topPages.map(p =>
        `<tr><td style="padding:6px 0;color:${C.text};font-size:14px;font-family:monospace;">${p.page}</td>` +
        `<td style="padding:6px 0;color:${C.gold};font-size:14px;text-align:right;">${p.count}</td></tr>`).join('')
    : `<tr><td colspan="2" style="padding:6px 0;color:${C.dim};font-size:13px;">Asnjë faqe e regjistruar.</td></tr>`;

  return `<!doctype html><html lang="sq"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/><title>Raporti Ditor — Gonxhe Website</title></head>
<body style="margin:0;background:${C.navy};font-family:Georgia,serif;color:${C.text};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.navy};padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:${C.card};border:1px solid rgba(196,169,106,0.25);border-radius:14px;overflow:hidden;">
        <tr><td style="padding:28px 32px;border-bottom:1px solid rgba(196,169,106,0.2);text-align:center;">
          <div style="font-family:'Playfair Display',Georgia,serif;font-style:italic;font-size:22px;color:${C.gold};letter-spacing:1px;">Flower Hotels &amp; Resorts</div>
          <div style="font-size:11px;color:${C.dim};letter-spacing:3px;text-transform:uppercase;margin-top:6px;">Gonxhe · Raporti Ditor i Website-it</div>
          <div style="font-size:13px;color:${C.text};margin-top:10px;">${r.day}</div>
        </td></tr>
        <tr><td style="padding:24px 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${row('Vizitorë në website', r.totalVisitors)}
            ${row('Biseda me Gonxhe (vizitorë)', r.chatters)}
            ${row('Mesazhe të shkëmbyera me Gonxhe', r.totalMessages)}
            ${row('Faqja më e vizituar', r.topPage ? `${r.topPage.page} (${r.topPage.count})` : '—')}
            ${row('Kohë mesatare e qëndrimit', fmtDuration(r.avgDwellMs))}
          </table>
        </td></tr>
        <tr><td style="padding:8px 32px 24px;">
          <div style="color:${C.gold};font-size:13px;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;">Sipas kombësisë</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${natRows}</table>
        </td></tr>
        <tr><td style="padding:8px 32px 28px;">
          <div style="color:${C.gold};font-size:13px;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;">Faqet më të vizituara</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${pageRows}</table>
        </td></tr>
        <tr><td style="padding:18px 32px;border-top:1px solid rgba(196,169,106,0.2);background:${C.navy};text-align:center;font-size:11px;color:${C.dim};line-height:1.6;">
          Raport ditor Gonxhe Website<br/>
          Dërguar në ${String(REPORT_HOUR).padStart(2, '0')}:00 (${REPORT_TZ})
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function reportEmailText(r) {
  const lines = [
    `Gonxhe Website — Raporti Ditor ${r.day}`,
    '',
    `Vizitorë në website: ${r.totalVisitors}`,
    `Biseda me Gonxhe (vizitorë): ${r.chatters}`,
    `Mesazhe të shkëmbyera me Gonxhe: ${r.totalMessages}`,
    `Faqja më e vizituar: ${r.topPage ? `${r.topPage.page} (${r.topPage.count})` : '—'}`,
    `Kohë mesatare e qëndrimit: ${fmtDuration(r.avgDwellMs)}`,
    '',
    'Sipas kombësisë:',
    ...(r.nationalities.length ? r.nationalities.map(n => `  ${n.name}: ${n.count}`) : ['  —']),
    '',
    'Faqet më të vizituara:',
    ...(r.topPages.length ? r.topPages.map(p => `  ${p.page}: ${p.count}`) : ['  —']),
  ];
  return lines.join('\n');
}

// Build a Gmail transporter for the reports mailbox (flowreport26@gmail.com).
// Falls back to the CRM SMTP creds only if the report-specific ones are absent.
function getReportTransporter() {
  const user = process.env.REPORT_SMTP_USER || process.env.SMTP_USER;
  const pass = process.env.REPORT_SMTP_PASS || process.env.SMTP_PASS;
  if (!user || !pass) return null;
  return { transporter: nodemailer.createTransport({ service: 'gmail', auth: { user, pass } }), user };
}

async function sendDailyReport(report, toOverride) {
  const built = getReportTransporter();
  if (!built) throw new Error('REPORT_SMTP_USER/REPORT_SMTP_PASS (or SMTP_USER/SMTP_PASS) not configured');
  // toOverride (string "a@x, b@y" or array) lets a manual test target a single
  // address; otherwise fall back to REPORT_TO / the four default recipients.
  const rawTo = Array.isArray(toOverride) ? toOverride.join(',')
    : (typeof toOverride === 'string' && toOverride.trim() ? toOverride : (process.env.REPORT_TO || REPORT_DEFAULT_TO));
  const to = String(rawTo).split(',').map(s => s.trim()).filter(Boolean);
  await built.transporter.sendMail({
    from: `"Flower Hotels & Resorts — Gonxhe" <${built.user}>`,
    to,
    subject: `Gonxhe Website — Raporti Ditor ${report.day}`,
    text: reportEmailText(report),
    html: reportEmailHTML(report),
  });
  return { to, from: built.user };
}

// Minute-resolution scheduler. Sends once per day at/after REPORT_HOUR, guarded
// by a persisted lastSentDate so a restart never double-sends.
function startDailyReportScheduler() {
  let state = readJSON(REPORT_STATE_FILE, { lastSentDate: '' });
  const tick = async () => {
    try {
      const today = tzDateString(new Date().toISOString());
      const { hour } = tzHourMinute();
      if (hour >= REPORT_HOUR && state.lastSentDate !== today) {
        // At 09:00 today we report on yesterday's activity.
        const reportDay = previousDay(today);
        const report = buildDailyReport(reportDay);
        const info = await sendDailyReport(report);
        state = { lastSentDate: today, reportDay, lastSentAt: new Date().toISOString(), to: info.to };
        writeJSON(REPORT_STATE_FILE, state);
        console.log(`Daily website report sent for ${reportDay} → ${info.to.join(', ')}`);
      }
    } catch (e) {
      console.error('daily report tick failed', e);
    }
  };
  setInterval(tick, 60 * 1000);   // check every minute
  setTimeout(tick, 10 * 1000);    // and shortly after boot (in case we restarted past 23:00)
  console.log(`Daily report scheduler armed for ${REPORT_HOUR}:00 ${REPORT_TZ}`);
}

// Preview the computed report (and its HTML) without sending — dashboard-only.
app.get('/api/daily-report/preview', requireDashboardAuth, (req, res) => {
  const day = req.query.day ? String(req.query.day) : tzDateString(new Date().toISOString());
  const report = buildDailyReport(day);
  res.json({ report, html: reportEmailHTML(report) });
});

// Send the report immediately (manual trigger for testing) — dashboard-only.
app.post('/api/daily-report/run', requireDashboardAuth, async (req, res) => {
  try {
    const day = (req.body && req.body.day) ? String(req.body.day) : tzDateString(new Date().toISOString());
    const report = buildDailyReport(day);
    const toOverride = (req.body && req.body.to) ? req.body.to : undefined;
    const info = await sendDailyReport(report, toOverride);
    res.json({ ok: true, day, sentTo: info.to, from: info.from, report });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ─── GOOGLE SHEETS DAILY SYNC ─────────────────────────────────────────────
// Exports guests, events, conversations, and web visitors to a Google Sheet
// once per day via an Apps Script webhook (GSHEETS_WEBHOOK_URL env var).
// Runs at REPORT_HOUR + 1 minute (right after the daily email report).

async function syncToGoogleSheets() {
  const webhookUrl = process.env.GSHEETS_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    const guests = readJSON('guests.json', []);
    const events = readJSON('events.json', []);
    const websiteConversations = Object.values(readJSON(WEBSITE_CONV_FILE, {}))
      .sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1));
    const hotelConversations = Object.values(readJSON(HOTEL_CONV_FILE, {}))
      .sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1));
    const webVisitors = Object.values(readJSON(WEB_VISITORS_FILE, {}))
      .sort((a, b) => (a.lastSeen > b.lastSeen ? -1 : 1));

    const payload = {
      secret: process.env.GSHEETS_SYNC_SECRET || '',
      guests,
      events,
      websiteConversations,
      hotelConversations,
      webVisitors,
    };

    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    const result = await resp.json();
    console.log('Google Sheets sync:', result);
  } catch (e) {
    console.error('Google Sheets sync failed:', e.message);
  }
}

// Manual trigger — dashboard-only (for testing the sync without waiting for midnight).
app.post('/api/gsheets-sync', requireDashboardAuth, async (_req, res) => {
  if (!process.env.GSHEETS_WEBHOOK_URL) {
    return res.status(503).json({ error: 'GSHEETS_WEBHOOK_URL not configured' });
  }
  await syncToGoogleSheets();
  res.json({ ok: true });
});

function startGSheetsSyncScheduler() {
  if (!process.env.GSHEETS_WEBHOOK_URL) return;
  let lastSyncDate = '';
  const tick = async () => {
    try {
      const today = tzDateString(new Date().toISOString());
      const { hour, minute } = tzHourMinute();
      // Sync at REPORT_HOUR:01 — 1 minute after the daily email report
      if (hour >= REPORT_HOUR && minute >= 1 && lastSyncDate !== today) {
        lastSyncDate = today;
        await syncToGoogleSheets();
      }
    } catch (e) {
      console.error('GSheets sync tick failed', e);
    }
  };
  setInterval(tick, 60 * 1000);
  console.log('Google Sheets sync scheduler armed');
}

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

// Hub: /dashboard shows the two-icon chooser; each dashboard lives under it.
// Old URLs (/dashboard.html, /website-dashboard.html) keep working.
app.get('/dashboard', noCache, (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard-hub.html'));
});
app.get(['/dashboard/hotel', '/dashboard.html'], noCache, (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});
app.get(['/dashboard/website', '/website-dashboard.html'], noCache, (_req, res) => {
  res.sendFile(path.join(__dirname, 'website-dashboard.html'));
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
  startDailyReportScheduler();
  startGSheetsSyncScheduler();
});
