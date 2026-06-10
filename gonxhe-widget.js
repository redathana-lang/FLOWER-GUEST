/**
 * Gonxhe Website Widget — embeddable chat bubble for the Flower Hotels website.
 *
 * Drop one line into the site (Webflow site-wide custom code, before </body>):
 *   <script src="https://flower-guest.onrender.com/gonxhe-widget.js" defer></script>
 *
 * It injects a floating bubble + chat panel inside a Shadow DOM (so the host
 * site's CSS can't touch it), talks to /api/gonxhe with channel:"website", and
 * reports funnel steps (opened, booking-link click, whatsapp click) so the
 * Website dashboard can track visitor behaviour. The API origin is derived from
 * this script's own src — no hard-coding needed.
 */
(function () {
  'use strict';
  if (window.__gonxheWidgetLoaded) return;
  window.__gonxheWidgetLoaded = true;

  // ── Where to call back to (this script's origin) ───────────────────────
  var thisScript = document.currentScript || (function () {
    var s = document.getElementsByTagName('script');
    for (var i = s.length - 1; i >= 0; i--) {
      if ((s[i].src || '').indexOf('gonxhe-widget') >= 0) return s[i];
    }
    return null;
  })();
  var API_BASE = (function () {
    try { return new URL(thisScript.src).origin; }
    catch (e) { return 'https://flower-guest.onrender.com'; }
  })();
  var AVATAR = API_BASE + '/gonxhe-avatar.jpg';

  // ── Stable anonymous session id (persists across page loads) ───────────
  var SID = (function () {
    try {
      var k = 'gonxhe_web_sid', v = localStorage.getItem(k);
      if (!v) {
        v = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
          : 'w' + Date.now() + Math.random().toString(16).slice(2);
        localStorage.setItem(k, v);
      }
      return v;
    } catch (e) { return 'w' + Date.now(); }
  })();

  var MAX_TURNS = 30;
  var GREETING = 'Mirë se erdhët në Flower Hotels & Resorts. Welcome to Flower Hotels & Resorts. ' +
    'Unë jam Gonxhe, koncierge juaj personale. I\'m Gonxhe, your personal concierge. ' +
    'Si do të preferonit të bisedonim — në Shqip apo në Anglisht? / Would you prefer to chat in Albanian or English?';
  var ERR_MSG = 'I do apologise — I\'m having a brief trouble connecting. Please reach our reception on WhatsApp: https://wa.me/355692073380';
  var CLOSING = 'It has been my pleasure. For anything more, our team is on WhatsApp: https://wa.me/355692073380';

  var history = [], opened = false, sending = false, turns = 0;

  // ── Beacon helpers (never throw, never block the UI) ───────────────────
  function post(path, body) {
    try {
      fetch(API_BASE + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), keepalive: true,
      }).catch(function () {});
    } catch (e) {}
  }
  function logVisit(ev) { post('/api/web/visit', { sessionId: SID, event: ev }); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // [label](url) → gold CTA button; bare URL → plain link; \n → <br>.
  function fmt(text) {
    var linked = esc(text).replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[A-Za-z0-9\-._~:\/?#@!$&*+=%;]+)/g,
      function (m, label, md, bare) {
        return label
          ? '<a class="gnxw-cta" href="' + md + '" target="_blank" rel="noopener noreferrer">' + label + '</a>'
          : '<a href="' + bare + '" target="_blank" rel="noopener noreferrer">' + bare + '</a>';
      });
    return linked.replace(/\n/g, '<br>');
  }

  // ── Build UI inside a Shadow DOM ───────────────────────────────────────
  var host = document.createElement('div');
  host.id = 'gonxhe-widget-host';
  host.style.cssText = 'all:initial;';
  document.body.appendChild(host);
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  var CSS = '\
  :host, * { box-sizing: border-box; }\
  .gnxw-fab { position: fixed; bottom: 24px; right: 24px; width: 62px; height: 62px; border-radius: 50%;\
    background: linear-gradient(135deg,#0E1A2E,#070E1B); border: 2px solid #C4A96A; cursor: pointer;\
    display: flex; align-items: center; justify-content: center; z-index: 2147483000;\
    box-shadow: 0 8px 28px rgba(0,0,0,0.35); transition: transform .2s, box-shadow .2s; font-family: Georgia, "Times New Roman", serif; }\
  .gnxw-fab:hover { transform: scale(1.06); box-shadow: 0 10px 34px rgba(0,0,0,0.45); }\
  .gnxw-fab.gnxw-hide { transform: scale(0); pointer-events: none; }\
  .gnxw-mono { font-style: italic; font-weight: 600; font-size: 27px;\
    background: linear-gradient(135deg,#C4A96A,#E2CE9A); -webkit-background-clip: text; background-clip: text; color: transparent; }\
  .gnxw-fab-img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; display: block; }\
  .gnxw-ping { position: absolute; top: 4px; right: 6px; width: 11px; height: 11px; border-radius: 50%; background: #6FAA8E; border: 2px solid #070E1B; }\
  .gnxw-panel { position: fixed; bottom: 24px; right: 24px; width: 374px; max-width: calc(100vw - 32px); height: 560px; max-height: calc(100vh - 48px);\
    background: #FBF8F2; border-radius: 20px; overflow: hidden; z-index: 2147483000; display: flex; flex-direction: column;\
    box-shadow: 0 24px 70px rgba(7,14,27,0.4); border: 1px solid rgba(196,169,106,0.4);\
    opacity: 0; transform: translateY(16px) scale(.98); pointer-events: none; transition: opacity .24s, transform .24s;\
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }\
  .gnxw-panel.gnxw-open { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }\
  .gnxw-head { background: linear-gradient(135deg,#0E1A2E,#070E1B); padding: 16px 18px; display: flex; align-items: center; gap: 12px; color: #F0E8D8; }\
  .gnxw-av { width: 42px; height: 42px; border-radius: 50%; background: linear-gradient(135deg,#C4A96A,#E2CE9A); flex: 0 0 auto; overflow: hidden;\
    display: flex; align-items: center; justify-content: center; font-family: Georgia, serif; font-style: italic; font-weight: 600; font-size: 21px; color: #070E1B; }\
  .gnxw-av img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; display: block; }\
  .gnxw-id { flex: 1; min-width: 0; }\
  .gnxw-name { font-family: Georgia, "Times New Roman", serif; font-size: 17px; }\
  .gnxw-role { font-size: 11px; letter-spacing: .04em; color: rgba(240,232,216,0.66); margin-top: 1px; }\
  .gnxw-role .gnxw-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #6FAA8E; margin-right: 5px; }\
  .gnxw-x { background: transparent; border: 1px solid rgba(196,169,106,0.4); color: #C4A96A; width: 30px; height: 30px; border-radius: 9px; cursor: pointer; font-size: 17px; line-height: 1; }\
  .gnxw-x:hover { background: rgba(196,169,106,0.15); }\
  .gnxw-msgs { flex: 1; overflow-y: auto; padding: 18px 16px; display: flex; flex-direction: column; gap: 11px; background: #FBF8F2; }\
  .gnxw-msgs::-webkit-scrollbar { width: 5px; } .gnxw-msgs::-webkit-scrollbar-thumb { background: rgba(196,169,106,0.3); border-radius: 3px; }\
  .gnxw-m { max-width: 84%; padding: 10px 13px; font-size: 14px; line-height: 1.5; border-radius: 15px; word-wrap: break-word; }\
  .gnxw-m a { color: #9C8550; }\
  .gnxw-bot { align-self: flex-start; background: #FFFFFF; border: 1px solid rgba(196,169,106,0.22); color: #2A2520; border-bottom-left-radius: 5px; }\
  .gnxw-user { align-self: flex-end; background: linear-gradient(135deg,#1a2740,#0E1A2E); color: #F0E8D8; border-bottom-right-radius: 5px; }\
  .gnxw-cta { display: inline-block; margin-top: 6px; padding: 9px 15px; background: linear-gradient(135deg,#C4A96A,#D8C08E); color: #070E1B !important;\
    text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 13px; }\
  .gnxw-cta:hover { filter: brightness(1.05); }\
  .gnxw-typing { align-self: flex-start; display: flex; gap: 4px; padding: 13px 15px; background: #FFFFFF; border: 1px solid rgba(196,169,106,0.22); border-radius: 15px; }\
  .gnxw-typing span { width: 7px; height: 7px; border-radius: 50%; background: #C4A96A; opacity: .4; animation: gnxw-b 1.2s infinite; }\
  .gnxw-typing span:nth-child(2){ animation-delay:.2s } .gnxw-typing span:nth-child(3){ animation-delay:.4s }\
  @keyframes gnxw-b { 0%,60%,100%{ opacity:.3; transform:translateY(0) } 30%{ opacity:1; transform:translateY(-3px) } }\
  .gnxw-bar { display: flex; gap: 9px; padding: 12px; border-top: 1px solid rgba(196,169,106,0.2); background: #FFFFFF; }\
  .gnxw-in { flex: 1; border: 1px solid rgba(196,169,106,0.35); border-radius: 12px; padding: 11px 14px; font-size: 14px; outline: none; font-family: inherit; color: #2A2520; background: #FBF8F2; }\
  .gnxw-in:focus { border-color: #C4A96A; }\
  .gnxw-send { flex: 0 0 auto; width: 44px; border: none; border-radius: 12px; background: linear-gradient(135deg,#C4A96A,#D8C08E); color: #070E1B; cursor: pointer; font-size: 18px; }\
  .gnxw-send:hover { filter: brightness(1.05); } .gnxw-send:disabled { opacity: .5; cursor: default; }\
  .gnxw-foot { text-align: center; font-size: 10px; color: rgba(42,37,32,0.4); padding: 0 0 8px; background: #FFFFFF; }\
  @media (max-width: 480px) {\
    .gnxw-panel { bottom: 0; right: 0; width: 100vw; max-width: 100vw; height: 100vh; max-height: 100vh; border-radius: 0; border: none; }\
    .gnxw-fab { bottom: 18px; right: 18px; }\
  }';

  var wrap = document.createElement('div');
  wrap.innerHTML =
    '<style>' + CSS + '</style>' +
    '<button class="gnxw-fab" id="gnxwFab" aria-label="Chat with Gonxhe">' +
      '<img class="gnxw-fab-img" src="' + AVATAR + '" alt="Gonxhe" /><span class="gnxw-ping"></span></button>' +
    '<section class="gnxw-panel" id="gnxwPanel" role="dialog" aria-label="Gonxhe concierge chat">' +
      '<div class="gnxw-head">' +
        '<div class="gnxw-av"><img src="' + AVATAR + '" alt="Gonxhe" /></div>' +
        '<div class="gnxw-id"><div class="gnxw-name">Gonxhe</div>' +
          '<div class="gnxw-role"><span class="gnxw-dot"></span>Concierge · Flower Hotels &amp; Resorts</div></div>' +
        '<button class="gnxw-x" id="gnxwClose" aria-label="Close chat">&times;</button>' +
      '</div>' +
      '<div class="gnxw-msgs" id="gnxwMsgs"></div>' +
      '<div class="gnxw-bar">' +
        '<input class="gnxw-in" id="gnxwIn" placeholder="Type your message…" autocomplete="off" />' +
        '<button class="gnxw-send" id="gnxwSend" aria-label="Send">&#10148;</button>' +
      '</div>' +
      '<div class="gnxw-foot">Powered by Gonxhe AI</div>' +
    '</section>';
  root.appendChild(wrap);

  var fab = root.getElementById('gnxwFab');
  var panel = root.getElementById('gnxwPanel');
  var msgs = root.getElementById('gnxwMsgs');
  var input = root.getElementById('gnxwIn');
  var sendBtn = root.getElementById('gnxwSend');

  function addMsg(role, text) {
    var d = document.createElement('div');
    d.className = 'gnxw-m ' + (role === 'user' ? 'gnxw-user' : 'gnxw-bot');
    d.innerHTML = fmt(text);
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
    return d;
  }
  function addTyping() {
    var d = document.createElement('div');
    d.className = 'gnxw-typing';
    d.innerHTML = '<span></span><span></span><span></span>';
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
    return d;
  }

  function openPanel() {
    panel.classList.add('gnxw-open');
    fab.classList.add('gnxw-hide');
    if (!opened) { opened = true; logVisit('opened'); addMsg('bot', GREETING); }
    setTimeout(function () { input.focus(); }, 300);
  }
  function closePanel() {
    panel.classList.remove('gnxw-open');
    fab.classList.remove('gnxw-hide');
  }

  function send() {
    var val = (input.value || '').trim();
    if (!val || sending) return;
    if (turns >= MAX_TURNS) { addMsg('bot', CLOSING); return; }
    input.value = '';
    addMsg('user', val);
    history.push({ role: 'user', content: val });
    turns++;
    var typing = addTyping();
    sending = true; sendBtn.disabled = true;
    fetch(API_BASE + '/api/gonxhe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history, channel: 'website', sessionId: SID }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        typing.remove();
        var text = ((data && data.text) || '').trim() ||
          'I\'m so sorry, I didn\'t quite catch that — could you try again?';
        addMsg('bot', text);
        history.push({ role: 'assistant', content: text });
        post('/api/conversation', { sessionId: SID, channel: 'website', messages: history });
      })
      .catch(function () { typing.remove(); addMsg('bot', ERR_MSG); })
      .then(function () { sending = false; sendBtn.disabled = false; input.focus(); });
  }

  // Funnel: catch booking-engine & WhatsApp clicks before they navigate away.
  msgs.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (/cloudbeds\.com/i.test(href)) logVisit('booking_link_clicked');
    else if (/wa\.me/i.test(href)) logVisit('whatsapp_clicked');
  });

  fab.addEventListener('click', openPanel);
  root.getElementById('gnxwClose').addEventListener('click', closePanel);
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); send(); } });
})();
