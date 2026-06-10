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

  // Follow-up: 5 minutes after a visitor clicks the booking engine, if they
  // haven't left a number, ask for their WhatsApp so reception can help.
  var FOLLOWUP_MS = 5 * 60 * 1000; // 5 minutes after the booking-engine click
  var RESERVATION_WA = '355676040707'; // Flower reservation desk (+355 67 604 0707)
  var lastBooking = null, followupTimer = null, followupShown = false, leadGiven = false;
  var DIAL_CODES = [
    ['Albania', '+355'], ['Kosovo', '+383'], ['North Macedonia', '+389'], ['Montenegro', '+382'],
    ['Italy', '+39'], ['Germany', '+49'], ['United Kingdom', '+44'], ['Austria', '+43'], ['Switzerland', '+41'],
    ['France', '+33'], ['Greece', '+30'], ['Netherlands', '+31'], ['Belgium', '+32'], ['Spain', '+34'],
    ['Poland', '+48'], ['Sweden', '+46'], ['Norway', '+47'], ['Denmark', '+45'], ['Finland', '+358'],
    ['Czechia', '+420'], ['Hungary', '+36'], ['Romania', '+40'], ['Bulgaria', '+359'], ['Croatia', '+385'],
    ['Slovenia', '+386'], ['Serbia', '+381'], ['Bosnia & Herzegovina', '+387'], ['Turkey', '+90'],
    ['Ukraine', '+380'], ['Russia', '+7'], ['Ireland', '+353'], ['Portugal', '+351'], ['Luxembourg', '+352'],
    ['United States / Canada', '+1'], ['United Arab Emirates', '+971'], ['Saudi Arabia', '+966'],
    ['Qatar', '+974'], ['Kuwait', '+965'], ['Israel', '+972'], ['Australia', '+61'], ['China', '+86'],
    ['Japan', '+81'], ['India', '+91'], ['Brazil', '+55']
  ];

  // ── Beacon helpers (never throw, never block the UI) ───────────────────
  function post(path, body) {
    try {
      fetch(API_BASE + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), keepalive: true,
      }).catch(function () {});
    } catch (e) {}
  }
  function logVisit(ev, extra) { post('/api/web/visit', Object.assign({ sessionId: SID, event: ev }, extra || {})); }

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
  .gnxw-fab.gnxw-alert { animation: gnxw-alert 1.3s ease-in-out infinite; }\
  @keyframes gnxw-alert { 0%,100% { transform: scale(1); } 50% { transform: scale(1.09); } }\
  .gnxw-lead { align-self: stretch; background: #FFFFFF; border: 1px solid rgba(196,169,106,0.4); border-radius: 13px; padding: 13px; }\
  .gnxw-lead-row { display: flex; gap: 7px; margin-bottom: 9px; }\
  .gnxw-cc { flex: 0 0 128px; border: 1px solid rgba(196,169,106,0.35); border-radius: 9px; padding: 9px 8px; font-size: 13px; font-family: inherit; color: #2A2520; background: #FBF8F2; outline: none; }\
  .gnxw-num { flex: 1; min-width: 0; border: 1px solid rgba(196,169,106,0.35); border-radius: 9px; padding: 9px 11px; font-size: 14px; font-family: inherit; color: #2A2520; background: #FBF8F2; outline: none; }\
  .gnxw-cc:focus, .gnxw-num:focus { border-color: #C4A96A; }\
  .gnxw-lead-send { width: 100%; border: none; border-radius: 9px; padding: 11px; background: linear-gradient(135deg,#C4A96A,#D8C08E); color: #070E1B; font-weight: 600; font-size: 13px; cursor: pointer; font-family: inherit; }\
  .gnxw-lead-send:hover { filter: brightness(1.05); } .gnxw-lead-send:disabled { opacity: .55; cursor: default; }\
  .gnxw-name { width: 100%; border: 1px solid rgba(196,169,106,0.35); border-radius: 9px; padding: 9px 11px; font-size: 14px; font-family: inherit; color: #2A2520; background: #FBF8F2; outline: none; margin-bottom: 9px; }\
  .gnxw-name:focus { border-color: #C4A96A; }\
  .gnxw-dl { flex: 1; display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: rgba(42,37,32,0.6); }\
  .gnxw-dl input { border: 1px solid rgba(196,169,106,0.35); border-radius: 9px; padding: 8px 10px; font-size: 13px; font-family: inherit; color: #2A2520; background: #FBF8F2; outline: none; }\
  .gnxw-dl input:focus { border-color: #C4A96A; }\
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
    fab.classList.remove('gnxw-alert');
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
        // The moment she offers a booking link, invite a direct preferential
        // enquiry — once per session, with the dates from her link pre-filled.
        if (/cloudbeds\.com/i.test(text)) {
          var b = bookingFromText(text);
          if (b) lastBooking = b;
          showFollowup();
        }
      })
      .catch(function () { typing.remove(); addMsg('bot', ERR_MSG); })
      .then(function () { sending = false; sendBtn.disabled = false; input.focus(); });
  }

  function datesPhrase() {
    if (lastBooking && lastBooking.checkin && lastBooking.checkout) {
      return 'for ' + lastBooking.checkin + ' to ' + lastBooking.checkout;
    }
    return 'for your dates';
  }
  // Pull the dates/guests out of a Cloudbeds link inside one of Gonxhe's replies.
  function bookingFromText(text) {
    var m = String(text || '').match(/https?:\/\/hotels\.cloudbeds\.com\/[^\s)]+/i);
    if (!m) return null;
    try {
      var u = new URL(m[0]);
      return {
        checkin: u.searchParams.get('checkin') || '',
        checkout: u.searchParams.get('checkout') || '',
        guests: u.searchParams.get('guests') || u.searchParams.get('adults') || '',
      };
    } catch (e) { return {}; }
  }
  function scheduleFollowup() {
    if (followupShown || leadGiven) return;
    if (followupTimer) clearTimeout(followupTimer);
    followupTimer = setTimeout(showFollowup, FOLLOWUP_MS);
  }
  var followupEls = [];
  function clearFollowup() {
    followupEls.forEach(function (el) { if (el && el.parentNode) el.parentNode.removeChild(el); });
    followupEls = [];
  }
  function showFollowup() {
    // Always re-show after each booking link — clear any previous one first so
    // the invite + form never stack up.
    clearFollowup();
    followupEls.push(addMsg('bot', 'Would you like a preferential offer? 🌸 You can also contact our reservation desk directly — just fill in your details below and they\'ll reply on WhatsApp with their best price ' + datesPhrase() + '.'));
    var ci = (lastBooking && lastBooking.checkin) || '';
    var co = (lastBooking && lastBooking.checkout) || '';
    var ad = (lastBooking && lastBooking.guests) || '2';
    var kd = '0';
    var form = document.createElement('div');
    form.className = 'gnxw-lead';
    var opts = DIAL_CODES.map(function (c) {
      return '<option value="' + c[1] + '">' + c[1] + '  ' + c[0] + '</option>';
    }).join('');
    form.innerHTML =
      '<div class="gnxw-lead-row">' +
        '<select class="gnxw-cc" aria-label="Country code">' + opts + '</select>' +
        '<input class="gnxw-num" type="tel" inputmode="tel" placeholder="WhatsApp number" />' +
      '</div>' +
      '<input class="gnxw-name" type="text" placeholder="Your name" />' +
      '<div class="gnxw-lead-row">' +
        '<label class="gnxw-dl">Check-in<input class="gnxw-ci" type="date" value="' + ci + '" /></label>' +
        '<label class="gnxw-dl">Check-out<input class="gnxw-co" type="date" value="' + co + '" /></label>' +
      '</div>' +
      '<div class="gnxw-lead-row">' +
        '<label class="gnxw-dl">Adults<input class="gnxw-ad" type="number" min="1" value="' + ad + '" /></label>' +
        '<label class="gnxw-dl">Children<input class="gnxw-kd" type="number" min="0" value="' + kd + '" /></label>' +
      '</div>' +
      '<button class="gnxw-lead-send">Send to reception on WhatsApp</button>';
    msgs.appendChild(form);
    followupEls.push(form);
    msgs.scrollTop = msgs.scrollHeight;
    if (!panel.classList.contains('gnxw-open')) fab.classList.add('gnxw-alert');
    var sel = form.querySelector('.gnxw-cc');
    var num = form.querySelector('.gnxw-num');
    var nameEl = form.querySelector('.gnxw-name');
    var ciEl = form.querySelector('.gnxw-ci');
    var coEl = form.querySelector('.gnxw-co');
    var adEl = form.querySelector('.gnxw-ad');
    var kdEl = form.querySelector('.gnxw-kd');
    var btn = form.querySelector('.gnxw-lead-send');
    function submitLead() {
      var digits = (num.value || '').replace(/[^0-9]/g, '');
      if (digits.length < 5) { num.style.borderColor = '#B26A6A'; num.focus(); return; }
      var phone = sel.value + digits;
      var nm = (nameEl.value || '').trim();
      var cin = ciEl.value || '', cout = coEl.value || '';
      var adv = (adEl.value || '').trim(), kdv = (kdEl.value || '').trim();
      leadGiven = true;
      if (followupTimer) clearTimeout(followupTimer);
      // Record it in the dashboard too (non-blocking) so reception sees it there.
      post('/api/web/lead', { sessionId: SID, name: nm, phone: phone, checkin: cin, checkout: cout, adults: adv, kids: kdv });
      // Compose the enquiry as a WhatsApp message to the reservation desk.
      var lines = [
        'New booking enquiry from the website',
        'Name: ' + (nm || '—'),
        'WhatsApp: ' + phone,
        'Check-in: ' + (cin || '—'),
        'Check-out: ' + (cout || '—'),
        'Adults: ' + (adv || '—') + ', Children: ' + (kdv || '0')
      ];
      lines.push('Please send me the best available offer for these dates. Thank you!');
      var wa = 'https://wa.me/' + RESERVATION_WA + '?text=' + encodeURIComponent(lines.join('\n'));
      form.remove();
      addMsg('bot', 'Perfect — your enquiry is ready for our reception team. Tap below to send it on WhatsApp and they\'ll reply with the best offer ' + datesPhrase() + '. 🌸\n\n[📲 Send to reception on WhatsApp](' + wa + ')');
      try { window.open(wa, '_blank'); } catch (e) {}
    }
    btn.addEventListener('click', submitLead);
    num.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submitLead(); } });
  }

  // Funnel: catch booking-engine & WhatsApp clicks before they navigate away.
  // A booking-engine click also arms the 5-minute WhatsApp follow-up.
  msgs.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (/cloudbeds\.com/i.test(href)) {
      logVisit('booking_link_clicked');
      try {
        var u = new URL(a.href);
        lastBooking = {
          checkin: u.searchParams.get('checkin') || '',
          checkout: u.searchParams.get('checkout') || '',
          guests: u.searchParams.get('guests') || u.searchParams.get('adults') || '',
        };
      } catch (_) { lastBooking = lastBooking || {}; }
    } else if (/wa\.me/i.test(href)) {
      logVisit('whatsapp_clicked');
    }
  });

  fab.addEventListener('click', openPanel);
  root.getElementById('gnxwClose').addEventListener('click', closePanel);
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); send(); } });

  // Track every visitor who loads the page — even if they never open the chat —
  // along with which page they're on and where they came from.
  logVisit('landed', { page: location.pathname + location.search, ref: document.referrer || '' });
})();
