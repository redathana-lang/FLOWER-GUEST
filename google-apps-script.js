/**
 * Flower Hotels & Resorts — Google Sheets Sync
 *
 * SETUP:
 * 1. Hap Google Sheets ku dëshiron të ruhen të dhënat
 * 2. Extensions → Apps Script → Paste this code
 * 3. Deploy → New deployment → Web app
 *    - Execute as: Me (your account)
 *    - Who has access: Anyone
 * 4. Copy the Web App URL
 * 5. Set env var on Render: GSHEETS_WEBHOOK_URL = <that URL>
 */

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const secret = PropertiesService.getScriptProperties().getProperty('SYNC_SECRET');
    if (secret && data.secret !== secret) {
      return ContentService.createTextOutput(JSON.stringify({ error: 'unauthorized' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();

    if (data.guests)               syncGuests(ss, data.guests);
    if (data.events)               syncEvents(ss, data.events);
    if (data.websiteConversations) syncWebConvs(ss, data.websiteConversations);
    if (data.hotelConversations)   syncHotelConvs(ss, data.hotelConversations);
    if (data.webVisitors)          syncWebVisitors(ss, data.webVisitors);

    return ContentService.createTextOutput(JSON.stringify({ ok: true, ts: new Date().toISOString() }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function getOrCreateSheet(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
  }
  sh.clearContents();
  sh.appendRow(headers);
  // Style header row
  const headerRange = sh.getRange(1, 1, 1, headers.length);
  headerRange.setBackground('#0E1A2E');
  headerRange.setFontColor('#C4A96A');
  headerRange.setFontWeight('bold');
  return sh;
}

function syncGuests(ss, guests) {
  const headers = ['ID', 'Emri', 'Telefon', 'Shteti', 'Dhoma', 'Check-in', 'Check-out', 'Vizita', 'Regjistruar'];
  const sh = getOrCreateSheet(ss, '👥 Guests', headers);
  for (const g of guests) {
    sh.appendRow([
      g.id || '',
      g.name || '',
      g.phone || '',
      g.country || '',
      g.room || '',
      g.checkin || '',
      g.checkout || '',
      g.visits || 1,
      g.registeredAt ? g.registeredAt.slice(0, 10) : '',
    ]);
  }
}

function syncEvents(ss, events) {
  const headers = ['Data', 'Ora', 'Tipi', 'Detaji', 'Mysafiri', 'Dhoma', 'Kanali'];
  const sh = getOrCreateSheet(ss, '📋 Events', headers);
  for (const ev of events.slice(-2000)) { // max 2000 events
    const ts = ev.ts ? new Date(ev.ts) : null;
    sh.appendRow([
      ts ? Utilities.formatDate(ts, 'Europe/Tirane', 'yyyy-MM-dd') : '',
      ts ? Utilities.formatDate(ts, 'Europe/Tirane', 'HH:mm') : '',
      ev.type || '',
      ev.detail || '',
      ev.guest || '',
      ev.room || '',
      ev.channel || '',
    ]);
  }
}

function syncWebConvs(ss, convs) {
  const headers = ['Session ID', 'Mysafiri', 'Shteti', 'Mesazhe', 'Mesazhi i fundit', 'Përditësuar'];
  const sh = getOrCreateSheet(ss, '🌐 Website Chats', headers);
  for (const c of convs) {
    const msgs = c.messages || [];
    const lastMsg = msgs.length ? (msgs[msgs.length - 1].content || '').slice(0, 200) : '';
    sh.appendRow([
      c.sessionId || '',
      c.guest || '',
      c.country || '',
      msgs.length,
      lastMsg,
      c.updatedAt ? c.updatedAt.slice(0, 16).replace('T', ' ') : '',
    ]);
  }
}

function syncHotelConvs(ss, convs) {
  const headers = ['Session ID', 'Mysafiri', 'Dhoma', 'Mesazhe', 'Mesazhi i fundit', 'Përditësuar'];
  const sh = getOrCreateSheet(ss, '🏨 Hotel Chats', headers);
  for (const c of convs) {
    const msgs = c.messages || [];
    const lastMsg = msgs.length ? (msgs[msgs.length - 1].content || '').slice(0, 200) : '';
    sh.appendRow([
      c.sessionId || '',
      c.guest || '',
      c.room || '',
      msgs.length,
      lastMsg,
      c.updatedAt ? c.updatedAt.slice(0, 16).replace('T', ' ') : '',
    ]);
  }
}

function syncWebVisitors(ss, visitors) {
  const headers = ['Session ID', 'Emri', 'Telefon', 'Email', 'Shteti', 'Mesazhe', 'Statusi', 'Para parë', 'Herën e fundit'];
  const sh = getOrCreateSheet(ss, '📊 Web Visitors', headers);
  for (const v of visitors) {
    const f = v.funnel || {};
    sh.appendRow([
      v.sessionId || '',
      v.name || '',
      v.phone || '',
      v.email || '',
      v.country || '',
      v.messages || 0,
      v.status || 'New',
      v.firstSeen ? v.firstSeen.slice(0, 10) : '',
      v.lastSeen ? v.lastSeen.slice(0, 16).replace('T', ' ') : '',
    ]);
  }
}
