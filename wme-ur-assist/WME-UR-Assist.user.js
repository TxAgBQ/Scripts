// ==UserScript==
// @name         WME UR Assist
// @namespace    https://greasyfork.org/users/820296-txagbq
// @version      2026.10.10.03
// @description  Status icons and sticky notes on the UR panel and in the UR-MP list, automatic red X after 72 hours with no Wazer reply, reporter user number, Next-UR tracking, and automatic replies to camera reports.
// @author       TxAgBQ
// @updateURL    https://github.com/TxAgBQ/Scripts/raw/refs/heads/main/wme-ur-assist/WME-UR-Assist.user.js
// @downloadURL  https://github.com/TxAgBQ/Scripts/raw/refs/heads/main/wme-ur-assist/WME-UR-Assist.user.js
// @match        https://www.waze.com/editor*
// @match        https://www.waze.com/*/editor*
// @match        https://beta.waze.com/editor*
// @match        https://beta.waze.com/*/editor*
// @exclude      https://www.waze.com/user/editor*
// @exclude      https://www.waze.com/editor/sdk/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_addValueChangeListener
// @grant        unsafeWindow
// @connect      docs.google.com
// @connect      googleusercontent.com
// @connect      api.openai.com
// @connect      script.google.com
// @connect      script.googleusercontent.com
// ==/UserScript==
 
(function () {
  'use strict';
 
  const SCRIPT_ID = 'wme-ai-ur-assist';
  const SCRIPT_NAME = 'UR Assist';
  const VERSION = GM_info.script.version;
  const LOG = (...a) => console.log(`[${SCRIPT_NAME}]`, ...a);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // Markers other scripts can read on <html>: data-ua-api, data-ua-open-ur, data-ua-next-ur (see OPEN-NEXT API below)
  const publish = (name, value) => {
    try {
      const v = value ? String(value) : '';
      if (document.documentElement.dataset[name] !== v) document.documentElement.dataset[name] = v;
    } catch { /* ignore */ }
  };
  // Event details must be copied into the page on Firefox so another userscript can read them
  const toPageObj = o => (typeof cloneInto === 'function' ? cloneInto(o, unsafeWindow) : o);
 
  // ===== SETTINGS (Tampermonkey storage, shared by beta and production) =====
  const DEFAULT_SHEET_ID = '15cyUyhrIuQHYcJ62lpn9MvGLWxPBZBb6dFfYpEmcfRg';
  const SHEET_TAB = 'CustomComments';
  const SHEET_CACHE_HOURS = 12;
  const REMINDER_AFTER_DAYS = 4; // propose the sheet's reminder comment after this many days of no reply
  const CLOSE_AFTER_DAYS = 7;    // propose the sheet's close comment after this many days of no reply
 
  const settings = {
    get sheetId() { return GM_getValue('sheetId', DEFAULT_SHEET_ID); },
    set sheetId(v) { GM_setValue('sheetId', v); },
    get bracketNext() { return GM_getValue('bracketNext', true); },
    set bracketNext(v) { GM_setValue('bracketNext', !!v); },
    get aiKey() { return GM_getValue('aiKey', ''); },
    set aiKey(v) { GM_setValue('aiKey', String(v).trim()); },
    get autoSendCameras() { return GM_getValue('autoSendCameras', true); },
    set autoSendCameras(v) { GM_setValue('autoSendCameras', !!v); },
    get ageHours() { return GM_getValue('ageHours', true); },
    set ageHours(v) { GM_setValue('ageHours', !!v); },
    get syncUrl() { return GM_getValue('syncUrl', ''); },
    set syncUrl(v) { GM_setValue('syncUrl', String(v).trim()); },
    get syncSecret() { return GM_getValue('syncSecret', ''); },
    set syncSecret(v) { GM_setValue('syncSecret', String(v).trim()); },
    get aiModel() { return GM_getValue('aiModel', 'gpt-4o-mini'); },
    set aiModel(v) { GM_setValue('aiModel', String(v).trim() || 'gpt-4o-mini'); },
  };
 
  let sdk;
  let myName = '';
  let replies = emptyReplies();
  let current = null; // { id, ctx, result }
  const ui = {};
 
  // ===== HELPERS =====
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
 
  function el(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'style') e.style.cssText = v;
      else if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e[k] = v;
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid);
    return e;
  }
 
  function setStatus(msg) {
    if (ui.statusLine) ui.statusLine.textContent = msg;
    LOG(msg);
  }
 
  function friendlyType(t) {
    const s = String(t || '').toLowerCase().replace(/^incorrect_general_error$/, 'general_error').replace(/_/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
 
  // ===== URC-E SHEET (read directly from the public Google Sheet) =====
  function emptyReplies() {
    return { list: [], byTitle: new Map(), defaults: {}, vars: {}, reminder: '', close: '' };
  }
 
  function parseCsv(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
        } else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
  }
 
  function buildReplies(rows) {
    const out = emptyReplies();
    const typeRow = rows.findIndex(r => /^TYPE$/i.test((r[0] || '').trim()));
    const listStart = rows.findIndex(r => /COMMENT LIST STARTS/i.test(r[0] || ''));
    if (listStart < 0) throw new Error('Sheet is missing the "COMMENT LIST STARTS" row');
 
    // Rows 5-22: default reply per UR type, plus reminder and close comments
    if (typeRow >= 0) {
      for (let k = typeRow + 1; k < listStart; k++) {
        const label = (rows[k][0] || '').trim().replace(/:\s*$/, '');
        const title = (rows[k][1] || '').trim();
        if (!label) continue;
        if (/^reminder comment/i.test(label)) out.reminder = title;
        else if (/^close comment/i.test(label)) out.close = title;
        else if (title) out.defaults[norm(label)] = title;
      }
    }
 
    // Row 25 down: the reply list
    let group = '(ungrouped)';
    for (let k = listStart + 1; k < rows.length; k++) {
      const title = (rows[k][0] || '').trim();
      const text = rows[k][1] || '';
      const status = (rows[k][2] || '').trim().toUpperCase();
      if (status === 'GROUP TITLE') { group = title || group; continue; }
      if (status === 'BLANK LINE' || status === 'REMOVED' || !title) continue;
      if (status === 'CUSTOM VAR') { out.vars[title.replace(/\$/g, '').trim()] = text; continue; }
      const state = { SOLVED: 'solved', NOTIDENTIFIED: 'not-identified', OPEN: 'open' }[status.replace(/[\s_-]/g, '')] || 'open';
      const reply = { title, text, state, group };
      out.list.push(reply);
      out.byTitle.set(title.toLowerCase(), reply);
    }
    return out;
  }
 
  function gmGet(url) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: 'GET', url, timeout: 20000,
      onload: r => (r.status === 200 ? resolve(r.responseText) : reject(new Error(`HTTP ${r.status}`))),
      onerror: () => reject(new Error('network error')),
      ontimeout: () => reject(new Error('timed out')),
    }));
  }
 
  async function loadReplies(force) {
    const cache = GM_getValue('sheetCache', null);
    const cacheOk = cache && cache.sheetId === settings.sheetId;
    if (!force && cacheOk && Date.now() - cache.time < SHEET_CACHE_HOURS * 3600e3) {
      replies = buildReplies(parseCsv(cache.csv));
      return 'cache';
    }
    const url = `https://docs.google.com/spreadsheets/d/${settings.sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_TAB)}`;
    try {
      const csv = await gmGet(url);
      replies = buildReplies(parseCsv(csv));
      GM_setValue('sheetCache', { sheetId: settings.sheetId, time: Date.now(), csv });
      return 'sheet';
    } catch (e) {
      if (cacheOk) { replies = buildReplies(parseCsv(cache.csv)); return `cache — sheet failed: ${e.message}`; }
      throw e;
    }
  }
 
  async function reloadReplies(force) {
    try {
      const src = await loadReplies(force);
      ui.sheetLine.textContent = `${replies.list.length} replies, ${Object.keys(replies.vars).length} variables (from ${src})`;
    } catch (e) {
      ui.sheetLine.textContent = `Could not load sheet: ${e.message}`;
      console.error(e);
    }
  }
 
  function extractSheetId(v) {
    const m = String(v).match(/\/d\/([\w-]+)/);
    return m ? m[1] : String(v).trim();
  }
 
  function defaultReplyFor(type) {
    const n = norm(type);
    for (const [label, title] of Object.entries(replies.defaults)) {
      if (n === label || n.endsWith(label) || label.endsWith(n)) return replies.byTitle.get(title.toLowerCase()) || null;
    }
    return null;
  }
 
  function findReply(...keys) {
    for (const k of keys) {
      const r = replies.list.find(x => x.title.toLowerCase().includes(k));
      if (r) return r;
    }
    return null;
  }
 
  function byTitle(title) {
    return title ? replies.byTitle.get(title.toLowerCase()) || null : null;
  }
 
  function spanishVersion(reply) {
    const base = reply.title.toLowerCase();
    return replies.list.find(r => r !== reply && r.title.toLowerCase().includes(base) &&
      /\b(es|spa|spanish|español|espanol)\b/i.test(r.title)) || null;
  }
 
  // ===== URC-E VARIABLES (same names as URC-E; English wording) =====
  const casualTod = h => ((h > 20 || h < 4) ? 'night' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening');
  const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const calendarDaysAgo = d => Math.round((startOfDay(new Date()) - startOfDay(d)) / 864e5);
  const dayName = dow => new Date(2024, 0, 7 + dow).toLocaleDateString(undefined, { weekday: 'long' }); // Jan 7 2024 = Sunday
 
  function daysAgoText(n) {
    return n <= 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`;
  }
 
  // Port of URC-E's $DRIVEDATE_TIME_CASUALMODE$ logic
  function casualMode(drive) {
    const ago = calendarDaysAgo(drive), h = drive.getHours(), tod = casualTod(h);
    let dow = drive.getDay();
    if (ago < 21 && h < 4) dow = (dow + 6) % 7; // after-midnight drives count as the previous night
    const day = dayName(dow);
    if (ago <= 0) return h > 20 ? 'tonight' : h < 4 ? 'last night' : `this ${tod}`;
    if (ago === 1) return h > 20 ? 'last night' : h < 4 ? `${day} ${tod}` : `yesterday ${tod}`;
    if (ago < 7) return (ago === 6 && h < 4) ? `last ${day} ${tod}` : `${day} ${tod}`;
    if (ago < 14) return `last ${day} ${tod}`;
    if (ago < 21) return 'two weeks ago';
    if (ago < 28) return 'three weeks ago';
    if (ago < 61) return 'a few weeks ago';
    if (ago < 121) return 'a couple of months ago';
    return 'a while back';
  }
 
  // Your URC-E tagline and tag email (read-only from URC-E's saved settings — not SDK)
  function urceListSettings() {
    try {
      const s = JSON.parse(localStorage.getItem('WME_URC-E') || '{}');
      return s.perCommentListSettings?.[s.commentList] || {};
    } catch { return {}; }
  }
 
  function permalink(ctx) {
    const [lon, lat] = ctx.coords || [];
    if (lon === undefined) return '';
    const env = new URLSearchParams(location.search).get('env');
    return `https://www.waze.com${location.pathname}?${env ? `env=${env}&` : ''}lon=${lon.toFixed(5)}&lat=${lat.toFixed(5)}&zoomLevel=17&mapUpdateRequest=${ctx.id}`;
  }
 
  async function segAddress(segmentId) {
    const D = sdk.DataModel;
    try {
      const a = await D.Segments.getAddress?.({ segmentId });
      if (a) return { street: a.street?.name || '', city: a.city?.name || '' };
    } catch { /* fall through */ }
    try {
      const seg = await D.Segments.getById({ segmentId });
      const st = seg?.primaryStreetId != null ? await D.Streets.getById({ streetId: seg.primaryStreetId }) : null;
      const city = st?.cityId != null ? await D.Cities.getById({ cityId: st.cityId }) : null;
      return { street: st?.name || '', city: city?.name || '' };
    } catch { return { street: '', city: '' }; }
  }
 
  async function selSegsText(withCity) {
    const sel = await sdk.Editing.getSelection();
    if (!sel || sel.objectType !== 'segment' || !sel.ids.length || sel.ids.length > 2) return null;
    const a = await Promise.all(sel.ids.map(segAddress));
    const s1 = a[0].street || 'an unnamed road', s2 = a[1] ? (a[1].street || 'an unnamed road') : '';
    const city = withCity ? (a.find(x => x.city)?.city || '') : '';
    return `${s2 ? `the intersection of ${s1} and ${s2}` : s1}${city ? ` in ${city}` : ''}`;
  }
 
  async function placeInfo() {
    const sel = await sdk.Editing.getSelection();
    if (!sel || sel.objectType !== 'venue' || sel.ids.length !== 1) return null;
    try {
      const v = await sdk.DataModel.Venues.getById({ venueId: sel.ids[0] });
      let address = null;
      try {
        const a = await sdk.DataModel.Venues.getAddress?.({ venueId: sel.ids[0] });
        if (a) address = [a.houseNumber, a.street?.name].filter(Boolean).join(' ') + (a.city?.name ? `, ${a.city.name}` : '') || null;
      } catch { /* leave unresolved */ }
      return { name: v?.name || null, address };
    } catch { return null; }
  }
 
  // Returns the value, or null to leave the $VARIABLE$ in place
  async function varValue(name, ctx) {
    const now = new Date(), drive = new Date(ctx.reportedOn);
    const date = { month: '2-digit', day: '2-digit', year: 'numeric' }, casualDate = { month: 'long', day: '2-digit' };
    const time = { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' };
    switch (name) {
      case 'CURRENTDATE_DAY_OF_WEEK': return now.toLocaleDateString(undefined, { weekday: 'long' });
      case 'CURRENTDATE_DATE': return now.toLocaleDateString(undefined, date);
      case 'CURRENTDATE_DATE_CASUAL': return now.toLocaleDateString(undefined, casualDate);
      case 'CURRENTDATE_TIME': return now.toLocaleTimeString(undefined, time);
      case 'CURRENTDATE_TIME_CASUAL': return casualTod(now.getHours());
      case 'DRIVEDATE_DAY_OF_WEEK': return drive.toLocaleDateString(undefined, { weekday: 'long' });
      case 'DRIVEDATE_DATE': return drive.toLocaleDateString(undefined, date);
      case 'DRIVEDATE_DATE_CASUAL': return drive.toLocaleDateString(undefined, casualDate);
      case 'DRIVEDATE_DAYS_AGO': return daysAgoText(calendarDaysAgo(drive));
      case 'DRIVEDATE_TIME': return drive.toLocaleTimeString(undefined, time);
      case 'DRIVEDATE_TIME_CASUAL': return casualTod(drive.getHours());
      case 'DRIVEDATE_TIME_CASUALMODE': return casualMode(drive);
      case 'URTYPE': return ctx.typeName;
      case 'URID': return String(ctx.id);
      case 'PERMALINK': return permalink(ctx);
      case 'USERNAME': return myName;
      case 'CUSTOMTAGLINE': return urceListSettings().customTagline || '';
      case 'TAG_EMAIL': return urceListSettings().tagEmail || '';
      case 'CLOSED_NOR_EMAIL_TAG': {
        const email = urceListSettings().tagEmail;
        return email && myName
          ? `Since this report is closed, please send further correspondence to ${email} and include ${myName} in the subject line.`
          : '';
      }
      case 'SELSEGS': return selSegsText(false);
      case 'SELSEGS_WITH_CITY': return selSegsText(true);
      case 'PLACE_NAME': return (await placeInfo())?.name ?? null;
      case 'PLACE_ADDRESS': return (await placeInfo())?.address ?? null;
      default: return null;
    }
  }
 
  async function fillVars(text, ctx) {
    // $URD$ = the reporter's description in quotes (URC-E also absorbs quotes already around it)
    let out = text.replace(/"?\$URD\$"?/g, ctx.desc ? `"${ctx.desc}"` : '');
    for (let i = 0; i < 10; i++) {
      const names = [...new Set([...out.matchAll(/\$([A-Z0-9_]+)\$/g)].map(m => m[1]))];
      const values = {};
      for (const n of names) values[n] = n in replies.vars ? replies.vars[n] : await varValue(n, ctx);
      const next = out.replace(/\$([A-Z0-9_]+)\$/g, (m, n) => (values[n] === null || values[n] === undefined ? m : values[n]));
      if (next === out) break;
      out = next;
    }
    return { text: out.trim(), unresolved: [...new Set(out.match(/\$[A-Z0-9_]+\$/g) || [])] };
  }
 
  function varWarning(list) {
    if (!list.length) return '';
    const sel = list.filter(v => /SELSEGS|PLACE_/.test(v));
    const other = list.filter(v => !sel.includes(v));
    const parts = [];
    if (sel.length) parts.push(`${sel.join(' ')}: select the road(s) or place on the map — filled in when you click Send`);
    if (other.length) parts.push(`Fill in or remove: ${other.join(' ')}`);
    return parts.join('. ');
  }
 
  // ===== READING THE UR (SDK) =====
  const ROLE_LABEL = { system: 'Waze (auto)', reporter: 'Reporter', me: 'You' };
 
  // Who wrote a comment: the name decides. Only when there is no name at all (WME sometimes leaves Map Team's
  // automatic first message unnamed) does the text decide - Map Team's standard wording means Map Team.
  // A named editor who uses the same wording is still that editor.
  const MAP_TEAM_TEXT = /^\s*thank you for your report\.\s*could you share what issue you encountered during your drive/i;
  const isMapTeamText = text => MAP_TEAM_TEXT.test(String(text || ''));
  const commentRole = (name, text) =>
    (!String(name ?? '').trim() && isMapTeamText(text) ? 'system' : roleOf(name));
 
  // UR-MP's hover text adds the editor's rank to the name ("Map_Team(6)"), so drop it before comparing
  function roleOf(name) {
    const n = String(name || '').replace(/\s*\(\d+\)\s*$/, '').trim().toLowerCase();
    // Map Team, or a comment UR-MP couldn't put a name to (it saves those as "null" / "Unknown" - Map Team's automatic message)
    if (n === 'map_team' || n === 'null' || n === 'undefined' || n === 'unknown') return 'system';
    if (!n || n === 'admin' || n === 'reporter') return 'reporter';
    if (myName && n === myName.toLowerCase()) return 'me';
    return 'editor';
  }
 
  function looksSpanish(t) {
    const hits = (t.match(/\b(el|la|los|las|que|por|para|calle|está|esta|dirección|direccion|mapa|carretera|salida|cerrada|aquí|aqui)\b/g) || []).length;
    return hits >= 3 || /[ñ¿¡]/.test(t);
  }
 
  function buildContext(ur, details) {
    const raw = (ur.description || '').trim();
    const m = raw.match(/^([A-Z_]{4,}):\s*([\s\S]*)$/);
    const code = m ? m[1] : '';
    const desc = m ? m[2].trim() : raw;
    const comments = (details?.comments || []).map(c => ({ ...c, role: commentRole(c.userName, c.text) }));
    const reporterText = comments.filter(c => c.role === 'reporter').map(c => c.text).join('\n');
    const last = comments[comments.length - 1];
    const text = `${desc}\n${reporterText}`.toLowerCase();
    return {
      id: ur.id,
      type: ur.updateRequestType,
      typeName: friendlyType(ur.updateRequestType),
      code, desc, comments, reporterText, text,
      lastRole: last ? last.role : 'none',
      daysSinceLast: last ? (Date.now() - last.createdOn) / 864e5 : 0,
      editorCommented: comments.some(c => c.role === 'me' || c.role === 'editor'),
      ageDays: (Date.now() - ur.reportedOn) / 864e5,
      spanish: looksSpanish(text),
      source: ur.source,
      reportedOn: ur.reportedOn,
      coords: ur.geometry?.coordinates || null,
    };
  }
 
  // ===== CLASSIFIER RULES — edit freely. First match wins. =====
  // tier: 'propose' = ready to send, 'mapwork' = check the map first, 'review' = read it yourself, 'waiting' = ball is in reporter's court
  const RULES = [
    {
      name: 'Waiting on reporter', tier: 'waiting',
      test: c => c.lastRole === 'me' || c.lastRole === 'editor',
      reply: c => (c.daysSinceLast >= CLOSE_AFTER_DAYS ? byTitle(replies.close)
        : c.daysSinceLast >= REMINDER_AFTER_DAYS ? byTitle(replies.reminder) : null),
    },
    {
      name: 'Speed camera', tier: 'propose',
      test: c => /speed\s*(camera|cam|trap)|red[\s-]*light\s*camera|photo\s*(radar|enforcement)|police\s*camera/.test(c.text),
      reply: () => findReply('camera'),
    },
    {
      name: 'School zone', tier: 'propose',
      test: c => c.code === 'SCHOOL_ZONE' || /school\s*zone/.test(c.text),
      reply: () => findReply('school'),
    },
    {
      name: 'Reporter replied', tier: 'review',
      test: c => c.lastRole === 'reporter' && c.comments.length > 1,
      reply: c => defaultReplyFor(c.type),
    },
    {
      name: 'Closure / closed exit', tier: 'mapwork',
      test: c => c.type === 'BLOCKED_ROAD' || /\b(closed|closure|construction)\b/.test(c.text),
      reply: () => defaultReplyFor('BLOCKED_ROAD') || findReply('closed road', 'closure'),
    },
    {
      name: 'Address / destination', tier: 'mapwork',
      test: c => c.type === 'INCORRECT_ADDRESS' || /\baddress|\bpin\b|my (home|house)|destination/.test(c.text),
      reply: c => defaultReplyFor(c.type),
    },
    {
      name: 'No details yet', tier: 'propose',
      test: c => !c.desc && !c.reporterText && !c.editorCommented,
      reply: c => defaultReplyFor(c.type),
    },
    {
      name: 'Has details', tier: 'review',
      test: () => true,
      reply: c => defaultReplyFor(c.type),
    },
  ];
 
  function classify(c) {
    for (const r of RULES) {
      if (!r.test(c)) continue;
      let reply = r.reply ? r.reply(c) : null;
      if (reply && c.spanish) reply = spanishVersion(reply) || reply;
      let tier = r.tier, rule = r.name;
      if (tier === 'propose' && !reply) { tier = 'review'; rule += ' (no matching reply in sheet)'; }
      return { rule, tier, reply };
    }
    return { rule: 'Unclassified', tier: 'review', reply: null };
  }
 
  async function onUrOpened({ updateRequestId: id }) {
    Next.onOpen(id);
    publish('uaOpenUr', id);
    OpenNext.noteOpened(id);
    Header.urId = id;
    Header.comments = [];
    Header.loadedId = null;
    try {
      const ur = await sdk.DataModel.MapUpdateRequests.getById({ mapUpdateRequestId: id });
      Header.desc = ur?.description || '';
      Header.type = ur?.updateRequestType || '';
      Header.reportedOn = ur?.reportedOn || 0;
      if (ur) reportedTimes.set(id, ur.reportedOn);
      const details = await sdk.DataModel.MapUpdateRequests.getUpdateRequestDetails({ mapUpdateRequestId: id });
      if (Next.openId !== id) return;
      Header.comments = (details?.comments || []).map(c => ({ role: commentRole(c.userName, c.text), time: c.createdOn }));
      Header.loadedId = id;
      Dupes.scan();
      AutoSend.onOpened(id);
    } catch (e) {
      LOG(`Could not read conversation for UR ${id}: ${e.message}`);
    }
  }
 
  // Replies are paused: the reply engine below (sheet, rules, variables, AI) stays for when we pick it back up.
  // ===== SENDING (SDK) =====
  async function send(ctx, box, state, btn) {
    const id = ctx.id;
    const filled = await fillVars(box.value, ctx); // fills selection-based variables at send time
    box.value = filled.text;
    const text = filled.text;
    if (!text) return setStatus('Reply is empty.');
    if (filled.unresolved.length) return setStatus(varWarning(filled.unresolved));
    if (!current || current.id !== id) return setStatus('That UR is no longer open.');
    btn.disabled = true;
    try {
      await sdk.DataModel.MapUpdateRequests.addComment({ mapUpdateRequestId: id, text });
      if (state !== 'open') {
        sdk.DataModel.MapUpdateRequests.updateResolutionState({ mapUpdateRequestId: id, resolutionState: state });
      }
      setStatus(`Sent to UR ${id}${state !== 'open' ? ` and marked ${state}` : ''}.`);
    } catch (e) {
      console.error(e);
      setStatus(`Send failed: ${e.message}`);
      btn.disabled = false;
    }
  }
 
  function copyForAi(ctx) {
    const convo = ctx.comments.map(c => `${c.role === 'editor' ? c.userName : ROLE_LABEL[c.role]}: ${c.text}`).join('\n');
    const prompt = `You are a volunteer Waze map editor replying to a map issue report. Write a brief, friendly reply.
 
Report type: ${ctx.typeName}
Reported: ${Math.floor(ctx.ageDays)} days ago
Description: ${ctx.desc || '(none)'}
Conversation:
${convo || '(none)'}`;
    navigator.clipboard.writeText(prompt).then(() => setStatus('Copied for AI.'));
  }
 
  // ===== AI (optional — your own OpenAI key, kept only in Tampermonkey storage) =====
  const AI_SYSTEM = `You help a volunteer Waze map editor reply to map issue reports (update requests).
Pick the single best reply from the editor's standard replies. If none fits, write a short custom reply in the same voice.
Rules: never say the map was fixed unless the conversation shows it was; if the report lacks details, ask for them;
reply in the reporter's language; keep any $VARIABLE$ placeholders exactly as written.
Respond with JSON only: {"title": "exact title from the list, or empty", "custom": "reply text if title is empty",
"state": "open" | "solved" | "not-identified", "reason": "one short sentence"}`;
 
  function askAi(ctx) {
    return new Promise((resolve, reject) => {
      if (!settings.aiKey) return reject(new Error('add your OpenAI API key in the UR Assist settings tab'));
      const list = replies.list
        .map(r => `- [${r.group}] ${r.title} (${r.state}): ${r.text.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
      const convo = ctx.comments
        .map(c => `${c.role === 'editor' ? 'Other editor' : ROLE_LABEL[c.role]}: ${c.text}`).join('\n');
      const user = `Report type: ${ctx.typeName}
Reported: ${Math.floor(ctx.ageDays)} days ago
Description: ${ctx.desc || '(none)'}
Conversation:
${convo || '(none)'}
 
Standard replies:
${list}`;
      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://api.openai.com/v1/chat/completions',
        timeout: 60000,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.aiKey}` },
        data: JSON.stringify({
          model: settings.aiModel,
          response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: AI_SYSTEM }, { role: 'user', content: user }],
        }),
        onload: r => {
          try {
            const j = JSON.parse(r.responseText);
            if (j.error) throw new Error(j.error.message);
            resolve(JSON.parse(j.choices[0].message.content));
          } catch (e) { reject(e); }
        },
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timed out')),
      });
    });
  }
 
  // ===== STATUSES, NOTES & NO-REPLY X (Tampermonkey storage — shared by beta and production) =====
  const NO_REPLY_HOURS = 72;
 
  // Small, plain icons drawn as SVG
  const ICONS = {
    priority: '<svg viewBox="0 0 16 16"><rect x="6.5" y="1.2" width="3" height="9.3" rx="1.3" fill="#d32f2f"/><circle cx="8" cy="13.5" r="1.7" fill="#d32f2f"/></svg>',
    blacklist: '<svg viewBox="0 0 16 16"><path d="M8 1.3L15.2 14.2H.8z" fill="#111" stroke="#111" stroke-width="1" stroke-linejoin="round"/><rect x="7.15" y="5.3" width="1.7" height="5" rx=".7" fill="#fff"/><circle cx="8" cy="12.2" r=".95" fill="#fff"/></svg>',
    mapwork: '<svg viewBox="0 0 16 16"><rect x="3.3" y="3.3" width="9.4" height="9.4" rx="1" transform="rotate(45 8 8)" fill="#f28c00" stroke="#222" stroke-width="1"/></svg>',
    closure: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.6" fill="#d32f2f"/><rect x="3.6" y="6.8" width="8.8" height="2.4" fill="#fff"/></svg>',
    maybeclosure: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.6" fill="#ffa000"/><rect x="3.6" y="6.8" width="8.8" height="2.4" fill="#fff"/></svg>',
    asked: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.6" fill="#7b1fa2"/><text x="8" y="11.7" text-anchor="middle" font-size="10" font-weight="bold" fill="#fff" font-family="Arial,sans-serif">?</text></svg>',
    waiting: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.3" fill="none" stroke="#1e66f5" stroke-width="2.4"/></svg>',
    watching: '<svg viewBox="0 0 16 16"><circle cx="5.3" cy="4.9" r="1.8" fill="#ffe082" stroke="#b08d00" stroke-width=".5"/><circle cx="8" cy="3.8" r="2" fill="#ffe082" stroke="#b08d00" stroke-width=".5"/><circle cx="10.7" cy="4.9" r="1.8" fill="#ffe082" stroke="#b08d00" stroke-width=".5"/><path d="M3.4 6.2h9.2l-1.3 8.4H4.7z" fill="#fff" stroke="#d32f2f" stroke-width=".8"/><path d="M5.5 6.2l.6 8.4M8 6.2v8.4M10.5 6.2l-.6 8.4" stroke="#d32f2f" stroke-width="1.2"/></svg>',
    dupe: '<svg viewBox="0 0 16 16"><rect x="1.8" y="1.8" width="8.6" height="8.6" fill="#fff" stroke="#d32f2f" stroke-width="1.8"/><rect x="5.6" y="5.6" width="8.6" height="8.6" fill="#ffcdd2" stroke="#d32f2f" stroke-width="1.8"/></svg>',
    camera: '<svg viewBox="0 0 16 16"><rect x="1" y="4.2" width="9.6" height="7.6" rx="1.4" fill="#d32f2f"/><path d="M11.2 7.1L15 4.8v6.4l-3.8-2.3z" fill="#d32f2f"/></svg>',
    train: '<svg viewBox="0 0 16 16"><rect x="3" y="1.3" width="10" height="10.4" rx="2.5" fill="#d32f2f"/><rect x="5" y="3.3" width="6" height="3.2" rx=".6" fill="#fff"/><circle cx="5.7" cy="9.2" r="1" fill="#fff"/><circle cx="10.3" cy="9.2" r="1" fill="#fff"/><path d="M5 12l-1.8 2.8M11 12l1.8 2.8" stroke="#d32f2f" stroke-width="1.4" stroke-linecap="round"/></svg>',
    stopsign: '<svg viewBox="0 0 16 16"><polygon points="5,.8 11,.8 15.2,5 15.2,11 11,15.2 5,15.2 .8,11 .8,5" fill="#d32f2f" stroke="#fff" stroke-width=".8"/><text x="8" y="9.9" text-anchor="middle" font-size="4.6" font-weight="bold" fill="#fff" font-family="Arial,sans-serif">STOP</text></svg>',
    xRed: '<svg viewBox="0 0 16 16"><path d="M4 4L12 12M12 4L4 12" stroke="#e53935" stroke-width="2.6" stroke-linecap="round"/></svg>',
    noteOn: '<svg viewBox="0 0 16 16"><path d="M1.5 1.5h13v9L10.5 14.5h-9z" fill="#ffd54f" stroke="#a88600" stroke-width=".8"/><path d="M3.8 5h8.4M3.8 7.6h8.4M3.8 10.2h5" stroke="#6d5a00" stroke-width=".9"/><path d="M10.5 14.5v-4h4" fill="#e6b800" stroke="#a88600" stroke-width=".8"/></svg>',
    noteOff: '<svg viewBox="0 0 16 16"><path d="M1.5 1.5h13v9L10.5 14.5h-9z" fill="#f2f2f2" stroke="#a0a0a0" stroke-width=".8"/><path d="M10.5 14.5v-4h4" fill="#ddd" stroke="#a0a0a0" stroke-width=".8"/></svg>',
  };
 
  // Statuses you set by clicking (header buttons, in this order). Edit freely; keep each id unchanged once used.
  // The black triangle is not here: it only shows what UR-MP has blacklisted (see UR-MP BLACKLIST below).
  const STATUSES = [
    { id: 'priority', label: 'High priority – work first' },
    { id: 'mapwork', label: 'Map work to do (hides the red X)' },
    { id: 'closure', label: 'Closure – leave it to expire' },
    { id: 'maybeclosure', label: 'Maybe a closure – not sure yet' },
    { id: 'asked', label: 'I asked a question – waiting on the Wazer' },
    { id: 'waiting', label: 'Looked at it, nothing to do – set automatically after 3 s open; click to clear your other statuses' },
    { id: 'watching', label: 'Another editor is working it – I\'m watching (hides the red X)' },
    { id: 'dupe', label: 'Duplicate – close it' },
  ];
  const STATUS_LABEL = Object.fromEntries(STATUSES.map(s => [s.id, s.label]));
  const BL_TITLE = 'Blacklisted in UR-MP (hides the red X)';
 
  // ===== LOOKED-AT CIRCLE (the blue circle is automatic now) =====
  // A UR you keep open for SEEN_MS gets a hidden 'seen' mark. The circle shows for seen URs unless one of your other
  // statuses (or popcorn, duplicate, camera/train/stop sign, UR-MP blacklist, red X) is showing; clear it and the circle returns.
  const SEEN = 'seen';
  const SEEN_MS = 3000;
  const SEEN_TITLE = 'Looked at it, nothing to do (set automatically)';
  const HIDES_SEEN = ['mapwork', 'closure', 'maybeclosure', 'asked', 'watching', 'dupe'];
  const circleOn = f => (f.includes(SEEN) || f.includes('waiting')) && !HIDES_SEEN.some(x => f.includes(x)); // 'waiting' = old manual circle
  const keepOnClear = f => f === 'priority' || f === SEEN || f === BL_ON || f === BL_OFF;
 
  const Seen = {
    id: null,
    since: 0,
    check(id) {
      if (this.id !== id) { this.id = id; this.since = Date.now(); return; }
      if (!this.since || Date.now() - this.since < SEEN_MS) return;
      this.since = 0; // done for this visit
      const cur = urInfo(id);
      if (!cur.flags.includes(SEEN)) saveUrInfo(id, { ...cur, flags: [...cur.flags, SEEN] });
    },
    stop() { this.id = null; this.since = 0; },
  };
 
  // One-time conversion: the old manual blue circle becomes the automatic 'seen' mark (saved as newer, so it syncs)
  function convertWaiting() {
    let n = 0;
    for (const [id, v] of Object.entries(urStore)) {
      if (!v?.flags?.includes('waiting')) continue;
      const flags = v.flags.filter(f => f !== 'waiting');
      if (!flags.includes(SEEN)) flags.push(SEEN);
      urStore[id] = { flags, note: v.note || '', updated: Date.now() };
      Sync.markDirty(id);
      n++;
    }
    if (n) { GM_setValue('urData', urStore); LOG(`Converted ${n} blue circle(s) to the automatic looked-at mark.`); }
  }
 
  function icon(name, title) {
    const s = el('span', { class: 'ua-ic', title });
    s.innerHTML = ICONS[name];
    return s;
  }
 
  // Automatic red X: Map Team or an editor commented last, and the Wazer hasn't answered in 72 hours.
  // If the Wazer replied last, it's waiting on you, so no X.
  function noReply(comments) {
    const last = comments[comments.length - 1];
    return !!last && last.role !== 'reporter' && Date.now() - last.time >= NO_REPLY_HOURS * 3600e3;
  }
  const X_TITLE = `No reply from the Wazer in ${NO_REPLY_HOURS}+ hours`;
 
  // Closures (red or amber) also time out when nobody has commented at all: 72 hours from when it was reported
  function overdueFor(info, comments, reportedOn) {
    if (noReply(comments)) return true;
    const f = info?.flags || [];
    if (comments.length || !reportedOn || !(f.includes('closure') || f.includes('maybeclosure'))) return false;
    return Date.now() - reportedOn >= NO_REPLY_HOURS * 3600e3;
  }
 
  // When was a UR reported? From the map data when it's loaded, otherwise from UR-MP's age column (whole days)
  const reportedTimes = new Map();
  function reportedOnFor(urId, tr) {
    if (reportedTimes.has(urId)) return reportedTimes.get(urId);
    const days = parseInt(tr?.children[1]?.textContent, 10);
    return Number.isNaN(days) ? 0 : Date.now() - days * 864e5;
  }
 
  // Automatic popcorn: another editor has replied and you never have
  function autoPopcorn(comments) {
    return !!myName && comments.some(c => c.role === 'editor') && !comments.some(c => c.role === 'me');
  }
  const POPCORN_AUTO_TITLE = 'Another editor replied and you haven\'t – watching';
 
  // ===== STANDARD-REPLY REPORTS (cameras, trains on the tracks) =====
  // 'auto'   = nobody has added anything – the reply is filled in and Not identified selected when you open it
  // 'review' = the reporter added comments – you handle it
  // Once an editor has replied (and the reporter hasn't), it's treated like any other report.
  const reportCode = d => (String(d || '').match(/^([A-Z_]{4,}):/) || [])[1] || '';
  const AUTO_RULES = [
    {
      id: 'camera', icon: 'camera', label: 'Camera report',
      test: (code) => /CAMERA/.test(code),
      sheetKeys: ['camera', 'flock'],
      fallback: 'Thank you for your report. Volunteer map editors do not add speed or enforcement cameras to the map, so we are closing this report. Safe travels!',
    },
    {
      id: 'train', icon: 'train', label: 'Train on the tracks',
      test: (code, text) => code === 'RAILROAD_CROSSING' && /\btrains?\b/i.test(text),
      sheetKeys: [],
      fallback: 'We don\'t map the location of trains on the permanent Waze map.',
    },
    {
      id: 'stopsign', icon: 'stopsign', label: 'Stop sign report (unmapped feature)',
      test: (code, text) => /\bstop\s*signs?\b/i.test(text),
      sheetKeys: ['unmapped'], // your URC-E "Unmapped features" reply
      fallback: '',            // no made-up wording: if the sheet has no such reply, nothing is filled in
    },
  ];
 
  function autoState(description, comments) {
    const code = reportCode(description);
    const rule = AUTO_RULES.find(r => r.test(code, String(description)));
    if (!rule) return null;
    if (comments.some(c => c.role === 'reporter')) return { rule, state: 'review' };
    if (comments.some(c => c.role === 'editor' || c.role === 'me')) return null;
    return { rule, state: 'auto' };
  }
  const autoTitle = a => `${a.rule.label} – ${a.state === 'review' ? 'the reporter added comments, review it'
    : a.rule.id === 'camera' && settings.autoSendCameras ? 'sent automatically and marked Not identified (or your standard reply goes in if you open it first)'
    : 'your standard reply goes in when you open it'}`;
 
  // What shows for a UR, in order:
  //   ! priority always first · duplicate, or camera/train, replaces everything else ·
  //   red X replaces the other statuses unless map work, popcorn or a UR-MP blacklist is on · the note always shows last
  function displayIcons(info, { overdue, dupeOf, auto, popcorn, blacklisted }) {
    const flags = info?.flags || [];
    const out = [];
    if (flags.includes('priority')) out.push(icon('priority', STATUS_LABEL.priority));
    if (dupeOf || flags.includes('dupe')) {
      out.push(icon('dupe', dupeOf ? `Duplicate of #${dupeOf} – close it` : STATUS_LABEL.dupe));
    } else if (auto) {
      out.push(icon(auto.rule.icon, autoTitle(auto)));
    } else {
      const watching = popcorn || flags.includes('watching') || blacklisted;
      if (overdue && !flags.includes('mapwork') && !watching) {
        out.push(icon('xRed', X_TITLE));
      } else {
        for (const s of STATUSES) {
          if (s.id === 'priority' || s.id === 'dupe') continue;
          if (s.id === 'waiting') { if (circleOn(flags) && !popcorn && !blacklisted) out.push(icon('waiting', SEEN_TITLE)); }
          else if (flags.includes(s.id)) out.push(icon(s.id, s.label));
          else if (s.id === 'watching' && popcorn) out.push(icon('watching', POPCORN_AUTO_TITLE));
        }
        if (blacklisted) out.push(icon('blacklist', BL_TITLE));
      }
    }
    if (info?.note?.trim()) out.push(icon('noteOn', info.note));
    return out;
  }
 
  let urStore = GM_getValue('urData', {});
  const urInfo = id => urStore[id] || { flags: [], note: '' };
 
  // Cleared entries are kept (empty) so a clear also reaches your other laptop through sync
  function saveUrInfo(id, info) {
    urStore[id] = { flags: info.flags, note: info.note || '', updated: Date.now() };
    GM_setValue('urData', urStore);
    Sync.markDirty(id);
    Strip.update();
  }
  const hasContent = v => !!v && (v.flags?.length > 0 || !!String(v.note || '').trim());
 
  // Backup / restore. Accepts this script's export, or the whole Storage tab of an older version from Tampermonkey.
  function exportData() {
    return JSON.stringify({ urData: urStore }, null, 1);
  }
 
  function importData(text) {
    const obj = JSON.parse(text);
    const data = obj && typeof obj.urData === 'object' ? obj.urData : obj;
    let n = 0;
    for (const [id, v] of Object.entries(data || {})) {
      if (!/^\d+$/.test(id) || !v || !Array.isArray(v.flags)) continue;
      const cur = urStore[id];
      if (!cur || (v.updated || 0) >= (cur.updated || 0)) {
        urStore[id] = { flags: v.flags, note: v.note || '', updated: v.updated || Date.now() };
        Sync.markDirty(id);
        n++;
      }
    }
    GM_setValue('urData', urStore);
    Strip.update();
    return n;
  }
 
  // ===== GOOGLE SHEETS SYNC (your own Apps Script web app — keeps both laptops' statuses and notes in step) =====
  function gmPostJson(url, body) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: 'POST', url, timeout: 30000,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      data: JSON.stringify(body),
      onload: r => {
        try { resolve(JSON.parse(r.responseText)); }
        catch { reject(new Error(r.status === 200 ? 'unexpected reply — check the web app is deployed with access "Anyone"' : `HTTP ${r.status}`)); }
      },
      onerror: () => reject(new Error('network error')),
      ontimeout: () => reject(new Error('timed out')),
    }));
  }
 
  const Sync = {
    timer: null,
    busy: false,
    enabled: () => !!(settings.syncUrl && settings.syncSecret),
 
    markDirty(id) {
      if (!this.enabled()) return;
      const dirty = GM_getValue('syncDirty', {});
      dirty[id] = 1;
      GM_setValue('syncDirty', dirty);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.run(), 3000);
    },
 
    async run() {
      if (!this.enabled() || this.busy) return;
      this.busy = true;
      try {
        const since = GM_getValue('syncSince', 0);
        const ids = since ? Object.keys(GM_getValue('syncDirty', {})) : Object.keys(urStore); // first sync sends everything
        const changes = {};
        for (const id of ids) if (urStore[id]) changes[id] = urStore[id];
        const res = await gmPostJson(settings.syncUrl, { secret: settings.syncSecret, since, changes });
        if (res.error) throw new Error(res.error);
        let n = 0;
        const blArrived = []; // UR-MP blacklist changes from your other laptop, to apply here
        for (const [id, v] of Object.entries(res.changes || {})) {
          const cur = urStore[id];
          if (!cur || (v.updated || 0) > (cur.updated || 0)) {
            const mark = blMark(v);
            if (mark && mark !== blMark(cur)) blArrived.push(id);
            urStore[id] = v;
            n++;
          }
        }
        const dirty = GM_getValue('syncDirty', {});
        for (const id of Object.keys(changes)) if (urStore[id]?.updated === changes[id].updated) delete dirty[id];
        GM_setValue('syncDirty', dirty);
        GM_setValue('syncSince', Math.max(0, (res.now || Date.now()) - 5000));
        if (n) { GM_setValue('urData', urStore); Strip.update(); }
        if (blArrived.length) UrmpBL.addPending(blArrived);
        this.status(`Synced ${new Date().toLocaleTimeString()}${n ? ` – ${n} update(s) from your other laptop` : ''}`);
      } catch (e) {
        this.status(`Sync failed: ${e.message}`);
      } finally {
        this.busy = false;
      }
    },
 
    status(msg) {
      if (ui.syncLine) ui.syncLine.textContent = msg;
      LOG(msg);
    },
  };
 
  // One-time import of notes from your WME UR Notes script (it kept them per site in localStorage)
  function migrateOldNotes() {
    let n = 0;
    for (const k of Object.keys(localStorage)) {
      const m = k.match(/^wmeUrNote_(\d+)$/);
      if (!m || urStore[m[1]]?.note) continue;
      urStore[m[1]] = { flags: urInfo(m[1]).flags, note: localStorage.getItem(k) || '', updated: Date.now() };
      n++;
    }
    if (n) {
      GM_setValue('urData', urStore);
      LOG(`Imported ${n} note(s) from WME UR Notes.`);
    }
  }
 
  // ===== UR-MP HOOKS (not SDK — all UR-MP-specific code lives here) =====
  const URMP = {
    // key = UR-MP's own row id ("urt-tr-<row>"); it identifies a row whatever kind of item it lists
    rows() {
      return [...document.querySelectorAll('tr[id^="urt-tr-"]')].map(tr => {
        const target = tr.querySelector('td[id^="urt-targetur-"]');
        return target ? { tr, target, urId: Number(target.title), key: tr.id } : null;
      }).filter(Boolean);
    },
    description(urId) {
      return document.getElementById(`urt-descriptionur-${urId}`)?.title || '';
    },
    open(row) {
      row.target.querySelector('a')?.click();
    },
    // Who commented last and when, read from UR-MP's comment-count hover text
    _cache: new Map(),
    comments(tr) {
      const t = tr.querySelector('[id^="urt-commentscount-"]')?.title || '';
      if (this._cache.has(t)) return this._cache.get(t);
      const out = [];
      const heads = [...t.matchAll(/^(.*?) \(([^()\n]+)\):[ \t]*$/gm)];
      heads.forEach((m, i) => {
        const time = Date.parse(m[2]);
        if (Number.isNaN(time)) return;
        const text = t.slice(m.index + m[0].length, i + 1 < heads.length ? heads[i + 1].index : t.length);
        out.push({ role: commentRole(m[1].trim(), text), time });
      });
      this._cache.set(t, out);
      return out;
    },
  };
 
  // ===== UR-MP BLACKLIST (not SDK — reads UR-MP's saved UR list through UR-MP's own storage helper,
  //       and clicks UR-MP's own blacklist cell) =====
  // The black triangle only shows what UR-MP has blacklisted. It never changes anything.
  // Sync between laptops: when you blacklist or un-blacklist a UR in UR-MP, a hidden marker records it and travels
  // through the Google Sheet with your statuses. The other laptop then clicks UR-MP's blacklist cell to match,
  // one row at a time, only on rows UR-MP is showing.
  const BL_ON = 'urmp-bl';   // hidden marker: blacklisted in UR-MP
  const BL_OFF = 'urmp-wl';  // hidden marker: taken off UR-MP's blacklist
  const blMark = v => (v?.flags?.includes(BL_ON) ? BL_ON : v?.flags?.includes(BL_OFF) ? BL_OFF : null);
 
  // Record blacklist changes you made in UR-MP (many at once) and send them on the next sync
  function setBlMarks(changes) {
    const dirty = GM_getValue('syncDirty', {});
    for (const [id, mark] of changes) {
      const cur = urInfo(id);
      urStore[id] = { flags: cur.flags.filter(f => f !== BL_ON && f !== BL_OFF).concat(mark), note: cur.note || '', updated: Date.now() };
      dirty[id] = 1;
    }
    GM_setValue('urData', urStore);
    if (Sync.enabled()) {
      GM_setValue('syncDirty', dirty);
      clearTimeout(Sync.timer);
      Sync.timer = setTimeout(() => Sync.run(), 3000);
    }
  }
 
  const UrmpBL = {
    ids: new Set(),     // URs blacklisted in UR-MP on this laptop
    ready: false,
    busy: false,
    timer: null,
    lastRead: 0,
    lastTry: 0,
    clicked: new Map(), // urId -> time we last clicked its cell (avoids clicking twice while UR-MP redraws)
 
    has(id) { return this.ids.has(Number(id)); },
 
    // Ask UR-MP's storage helper for its saved UR list (it answers within about 2 seconds)
    loadList() {
      return new Promise(resolve => {
        const H = unsafeWindow.GMStorageHelper;
        if (!H || typeof H.load !== 'function') { resolve(null); return; }
        const giveUp = setTimeout(() => resolve(null), 15000);
        H.load('WMEURMPTracking_URList', job => {
          clearTimeout(giveUp);
          try {
            const list = typeof job.data === 'string' ? JSON.parse(job.data) : job.data;
            resolve(Array.isArray(list) ? list : null);
          } catch { resolve(null); }
        });
      });
    },
 
    // Changes from your other laptop still waiting to be applied here (kept across reloads)
    pending() { return new Set(GM_getValue('urmpBlPending', [])); },
    savePending(set) { GM_setValue('urmpBlPending', [...set]); },
    addPending(ids) {
      const p = this.pending();
      for (const id of ids) p.add(Number(id));
      this.savePending(p);
      this.status();
    },
    dropPending(id) {
      const p = this.pending();
      if (p.delete(Number(id))) { this.savePending(p); this.status(); }
    },
 
    readSoon() {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.read(), 6000); // gives UR-MP time to save after a click
    },
 
    // A row turned up without a report time (UR-MP added it since the last read): read again, at most once a minute
    readIfMissing(rows) {
      if (this.busy || Date.now() - this.lastTry < 60e3) return;
      if (rows.some(r => !reportedTimes.has(r.urId))) this.read();
    },
 
    async read() {
      if (this.busy) return;
      this.busy = true;
      this.lastTry = Date.now();
      try {
        const list = await this.loadList();
        if (!list) return;
        // Report times for every UR in UR-MP's list (WME's map data only has the ones near the map).
        // Used for the hours in the age column and the 72-hour red X on closures nobody has commented on.
        for (const u of list) {
          const t = Number(u.data?.driveDate);
          if (t > 0 && !reportedTimes.has(Number(u.id))) reportedTimes.set(Number(u.id), t);
        }
        const present = new Set(list.map(u => Number(u.id)));
        const now = new Set(list.filter(u => u.blackListed).map(u => Number(u.id)));
        const seen = GM_getValue('urmpBlSeen', null); // what UR-MP had last time on this laptop
        const prev = new Set(seen || []);
 
        // Changes you made in UR-MP since the last read. The very first read counts everything blacklisted as yours.
        const changes = [];
        for (const id of now) if (!prev.has(id)) changes.push([id, BL_ON]);
        if (seen) for (const id of prev) if (present.has(id) && !now.has(id)) changes.push([id, BL_OFF]);
        const pend = this.pending();
        const mine = changes.filter(([id, mark]) => !pend.has(id) && blMark(urStore[id]) !== mark);
        if (mine.length) setBlMarks(mine);
 
        // Changes from the other laptop that UR-MP now matches are done
        let done = false;
        for (const id of [...pend]) {
          const want = blMark(urStore[id]);
          if (!want || (present.has(id) && (want === BL_ON) === now.has(id))) { pend.delete(id); done = true; }
        }
        if (done) this.savePending(pend);
 
        GM_setValue('urmpBlSeen', [...now]);
        this.ids = now;
        this.ready = true;
        this.lastRead = Date.now();
        this.status();
        Strip.update();
      } catch (e) {
        LOG('Reading the UR-MP blacklist failed:', e.message);
      } finally {
        this.busy = false;
      }
    },
 
    // Make UR-MP match a change from your other laptop: one click per pass, only on rows UR-MP is showing
    apply() {
      if (!this.ready || this.busy) return;
      const pend = this.pending();
      if (!pend.size) return;
      for (const r of URMP.rows()) {
        if (!pend.has(r.urId)) continue;
        if (Date.now() - (this.clicked.get(r.urId) || 0) < 10000) continue;
        const want = blMark(urStore[r.urId]);
        const cell = r.tr.querySelector('td.urt-blacklist');
        if (!want || !cell) continue;
        const isBl = /whitelist/i.test(cell.title); // UR-MP's cell says "whitelist this UR" when it's blacklisted
        if ((want === BL_ON) === isBl) {
          pend.delete(r.urId);
          this.savePending(pend);
          this.status();
          continue;
        }
        this.clicked.set(r.urId, Date.now());
        cell.click();
        if (want === BL_ON) this.ids.add(r.urId); else this.ids.delete(r.urId);
        Strip.update();
        return;
      }
    },
 
    status() {
      if (!ui.blLine) return;
      if (!this.ready) {
        ui.blLine.textContent = 'UR-MP blacklist: waiting for UR-MP to load…';
        return;
      }
      const n = this.pending().size;
      ui.blLine.textContent = `UR-MP blacklist: ${this.ids.size} blacklisted, checked ${new Date(this.lastRead).toLocaleTimeString()}` +
        (n ? ` – ${n} change(s) from your other laptop waiting for their rows to show in UR-MP` : '');
    },
 
    start() {
      const firstRead = () => {
        if (unsafeWindow.GMStorageHelper) this.read();
        else setTimeout(firstRead, 3000);
      };
      firstRead();
      setInterval(() => this.read(), 3 * 60e3);
      setInterval(() => this.apply(), 2000);
    },
  };
 
  // A click on UR-MP's blacklist cell (yours, or the sync's): re-read UR-MP's list once it has saved
  document.addEventListener('click', e => {
    const cell = e.target.closest?.('td.urt-blacklist');
    const tr = cell?.closest('tr[id^="urt-tr-"]');
    const urId = Number(tr?.querySelector('td[id^="urt-targetur-"]')?.title);
    if (!urId) return;
    if (e.isTrusted) UrmpBL.dropPending(urId); // your own click wins over a change waiting from the other laptop
    UrmpBL.readSoon();
  }, true);
 
  // ===== UR-MP STATUS STRIP (drawn beside the UR-MP table — UR-MP's own table is left untouched) =====
  function scrollParent(node) {
    for (let n = node.parentElement; n && n !== document.body; n = n.parentElement) {
      const o = getComputedStyle(n).overflowY;
      if ((o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight) return n;
    }
    return document.documentElement;
  }
 
  const TRANSPARENT = /^(transparent|rgba\(0, 0, 0, 0\))$/;
  const border = (cs, side) => `${cs[`border${side}Width`]} ${cs[`border${side}Style`]} ${cs[`border${side}Color`]}`;
 
  // Copies UR-MP's own cell colors and grid lines, so the strip looks like an extra column of the table
  // Finds the colour (or background image) actually showing behind a cell: the cell, then its row, then up to the table
  function findBackground(cell, fallback) {
    const table = cell.closest('table');
    for (let n = cell; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return `${cs.backgroundImage}, ${TRANSPARENT.test(cs.backgroundColor) ? fallback : cs.backgroundColor}`;
      if (!TRANSPARENT.test(cs.backgroundColor)) return cs.backgroundColor;
      if (n === table) break;
    }
    return fallback;
  }
 
  function matchCell(box, cell, row, withTop = false, fallback = '#fff') {
    const cs = getComputedStyle(cell);
    box.style.background = findBackground(cell, fallback);
    box.style.borderBottom = border(cs, 'Bottom');
    box.style.borderRight = border(cs, 'Right');
    box.style.borderTop = withTop ? border(cs, 'Top') : '';
    box.style.color = cs.color;
  }
 
  function findHeadRow(table) {
    if (!table) return null;
    const isHead = tr => !tr.id.startsWith('urt-tr-') && /Description/i.test(tr.textContent);
    for (let n = table, i = 0; n && i < 7; n = n.parentElement, i++) {
      const tr = [...n.querySelectorAll('tr')].find(isHead);
      if (tr) return tr;
    }
    return null;
  }
 
  // UR-MP's age column shows whole days. Work out which time it's counting (last comment or the report itself)
  // by matching its number, then show hours up to 96 h, days after that.
  const AGE_HOURS_UP_TO = 96;
  function ageInfo(r) {
    const cell = r.tr.children[1];
    const shown = parseInt(cell?.textContent, 10);
    if (!cell || Number.isNaN(shown)) return null;
    const comments = URMP.comments(r.tr);
    const times = [comments.length ? comments[comments.length - 1].time : 0, reportedTimes.get(r.urId) || 0].filter(Boolean);
    const days = t => (Date.now() - t) / 864e5;
    const t = times.find(x => Math.floor(days(x)) === shown) ?? times.find(x => Math.abs(days(x) - shown) < 1);
    if (!t) return null;
    const hours = Math.floor((Date.now() - t) / 36e5);
    return {
      cell,
      text: hours <= AGE_HOURS_UP_TO ? `${hours}h` : `${Math.floor(hours / 24)}d`,
      title: `${hours} hours (${Math.floor(hours / 24)} days ${hours % 24} hours)`,
    };
  }
 
  const Strip = {
    box: null,
    head: null,
    line: null,
    cells: new Map(),
    ages: new Map(),
    rows: [],
    width: 18,
    raf: 0,
 
    init() {
      this.box = el('div', { id: 'ua-strip' });
      this.head = el('div', { class: 'ua-cell ua-head', title: `${SCRIPT_NAME} status`, style: 'display:none' },
        icon('mapwork', `${SCRIPT_NAME} status`));
      this.line = el('div', { id: 'ua-nextline', style: 'display:none' });
      this.box.append(this.head);
      document.body.append(this.box, this.line);
      const later = () => {
        if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.place(); });
      };
      document.addEventListener('scroll', later, true);
      window.addEventListener('resize', later);
    },
 
    // Rebuild icons and copy UR-MP's look (runs every second and after any change)
    update() {
      if (!this.box) return;
      this.rows = URMP.rows();
      const seen = new Set();
      let most = 1;
      for (const r of this.rows) {
        seen.add(r.urId);
        let c = this.cells.get(r.urId);
        if (!c) { c = el('div', { class: 'ua-cell' }); this.box.append(c); this.cells.set(r.urId, c); }
        const info = urStore[r.urId];
        const overdue = overdueFor(info, URMP.comments(r.tr), reportedOnFor(r.urId, r.tr));
        const dupeOf = Dupes.closeOf.get(r.urId)?.keep || null;
        const comments = URMP.comments(r.tr);
        const auto = autoState(URMP.description(r.urId), comments);
        const popcorn = autoPopcorn(comments);
        const blacklisted = UrmpBL.has(r.urId);
        const key = JSON.stringify([info?.flags || [], info?.note || '', overdue, dupeOf, auto && [auto.rule.id, auto.state], popcorn, blacklisted]);
        if (c.dataset.key !== key) {
          c.dataset.key = key;
          c.replaceChildren(...displayIcons(info, { overdue, dupeOf, auto, popcorn, blacklisted }));
        }
        most = Math.max(most, c.childElementCount);
        const last = r.tr.lastElementChild;
        if (last) matchCell(c, last, r.tr);
 
        // Hours/days label laid over UR-MP's age number
        const age = settings.ageHours ? ageInfo(r) : null;
        let a = this.ages.get(r.urId);
        if (age) {
          if (!a) { a = el('div', { class: 'ua-age' }); this.box.append(a); this.ages.set(r.urId, a); }
          a._cell = age.cell;
          if (a.textContent !== age.text) a.textContent = age.text;
          a.title = age.title;
          const shownEl = age.cell.querySelector('span') || age.cell;
          const cs = getComputedStyle(shownEl);
          a.style.background = findBackground(age.cell, '#fff');
          a.style.color = cs.color;
          a.style.font = cs.font;
        } else if (a) {
          a.remove();
          this.ages.delete(r.urId);
        }
      }
      for (const [id, c] of this.cells) if (!seen.has(id)) { c.remove(); this.cells.delete(id); }
      for (const [id, a] of this.ages) if (!seen.has(id)) { a.remove(); this.ages.delete(id); }
      this.width = most * 13 + 6;
      UrmpBL.readIfMissing(this.rows);
 
      const table = this.rows[0]?.tr.closest('table');
      this.headRow = findHeadRow(table);
      const headCell = this.headRow
        ? [...this.headRow.children].find(td => /^Description$/i.test(td.textContent.trim())) || this.headRow.lastElementChild
        : null;
      if (headCell) matchCell(this.head, headCell, this.headRow, true, '#a9d1e8');
      this.place();
    },
 
    // Line everything up with the table (runs on scroll and resize too)
    place() {
      const table = this.rows[0]?.tr.closest('table');
      const t = table?.getBoundingClientRect();
      const scroller = table ? scrollParent(table) : null;
      const view = scroller?.getBoundingClientRect();
      const showIn = (box, rr, clip, right = t?.right, width = this.width) => {
        const visible = t && t.width > 0 && rr && rr.height > 0 &&
          (!clip || (rr.bottom > clip.top && rr.top < clip.bottom));
        box.style.display = visible ? '' : 'none';
        if (!visible) return;
        Object.assign(box.style, {
          left: `${right}px`,
          top: `${rr.top}px`,
          height: `${rr.height}px`,
          width: `${width}px`,
          clipPath: clip ? `inset(${Math.max(0, clip.top - rr.top)}px 0 ${Math.max(0, rr.bottom - clip.bottom)}px 0)` : '',
        });
      };
      for (const r of this.rows) {
        const c = this.cells.get(r.urId);
        if (c) showIn(c, r.tr.getBoundingClientRect(), view);
        const a = this.ages.get(r.urId);
        if (a?._cell) {
          const cr = a._cell.getBoundingClientRect();
          showIn(a, cr, view, cr.left, cr.width);
        }
      }
      if (this.headRow) {
        showIn(this.head, this.headRow.getBoundingClientRect(), scroller?.contains(this.headRow) ? view : null,
          this.headRow.closest('table')?.getBoundingClientRect().right);
      }
      else this.head.style.display = 'none';
 
      // Blue line across the top of the next row = right under the one you just worked (UR-MP context only)
      const nr = Next.nextKey ? this.rows.find(r => r.key === Next.nextKey)?.tr.getBoundingClientRect() : null;
      if (nr && nr.height > 0 && t && view && nr.top >= view.top && nr.top <= view.bottom) {
        Object.assign(this.line.style, { display: '', left: `${t.left}px`, top: `${nr.top - 1}px`, width: `${t.width + this.width}px` });
      } else {
        this.line.style.display = 'none';
      }
    },
  };
 
  // ===== NEXT UP =====
  // Where "]" goes depends on where you last clicked:
  //   context 'urmp'    - you last clicked a row in the UR-MP list (or "]" itself opened one): "]" opens the next UR-MP row
  //   context 'tracker' - you last clicked a card in the Issue Tracker list: "]" is left to WME, which follows the tracker's own filtered list
  // Opening a UR from a map pin changes neither: in UR-MP context a UR that is in the UR-MP list becomes your position there.
  const Next = {
    openId: null,
    context: 'urmp',
    pos: null,       // key (UR-MP row id) of the row you last used
    snapshot: [],    // UR-MP row keys when you last used a row, so the next one is still found after rows disappear
    nextKey: null,   // key of the row "]" would open (null = pass "]" through to WME)
    recent: [],      // recent UR-MP row orders [{ t, rows: [{ key, urId }] }], so "next after UR x" still works once x has left the list
    lastSig: '',

    // Remember the row order whenever it changes (an empty list, e.g. mid-redraw, is not remembered)
    record(rows) {
      if (!rows.length) return;
      const sig = rows.map(r => `${r.key}:${r.urId}`).join('|');
      if (sig === this.lastSig) return;
      this.lastSig = sig;
      const now = Date.now();
      this.recent.push({ t: now, rows: rows.map(r => ({ key: r.key, urId: r.urId })) });
      this.recent = this.recent.filter(s => now - s.t < 120e3).slice(-12);
    },

    // The live row that follows UR `id` in the remembered order (newest order first). Never "the next of the current".
    afterId(id) {
      const live = new Map(URMP.rows().map(r => [r.key, r]));
      let known = false;
      for (let i = this.recent.length - 1; i >= 0; i--) {
        const snap = this.recent[i].rows;
        const at = snap.findIndex(x => x.urId === id);
        if (at < 0) continue;
        known = true;
        for (const x of snap.slice(at + 1)) {
          const r = live.get(x.key);
          if (r && r.urId === x.urId && r.urId !== id) return { row: r };
        }
      }
      return { row: null, reason: known ? 'no next row in UR-MP list' : 'closed UR not in UR-MP list' };
    },
 
    onOpen(id) {
      this.openId = id;
      this.record(URMP.rows());
      if (this.context === 'urmp') {
        const rows = URMP.rows();
        const row = rows.find(r => r.urId === id);
        if (row) { this.pos = row.key; this.snapshot = rows.map(r => r.key); }
      }
      this.refresh();
    },
 
    setContext(ctx) {
      if (this.context === ctx) return;
      this.context = ctx;
      this.refresh();
    },
 
    setPosition(key) {
      this.context = 'urmp';
      this.pos = key;
      this.snapshot = URMP.rows().map(r => r.key);
      this.refresh();
    },
 
    refresh() {
      let next = null;
      if (this.context === 'urmp' && this.pos) {
        const keys = URMP.rows().map(r => r.key);
        const at = keys.indexOf(this.pos);
        if (at >= 0) {
          next = keys[at + 1] ?? null;
        } else {
          const snapAt = this.snapshot.indexOf(this.pos);
          if (snapAt >= 0) next = this.snapshot.slice(snapAt + 1).find(k => keys.includes(k)) ?? null;
        }
      }
      this.nextKey = next;
      this.record(URMP.rows());
      publish('uaNextUr', this.row()?.urId || '');
      Strip.update();
    },
 
    row() {
      return this.nextKey ? URMP.rows().find(r => r.key === this.nextKey) || null : null;
    },
 
    openNext() {
      const row = this.row();
      if (row) URMP.open(row);
      else setStatus('No next row found in the UR-MP list.');
    },
  };
 
  // ===== CLICK CONTEXT HOOK (not SDK — notes whether you last clicked in UR-MP or in the Issue Tracker) =====
  // A click on a UR-MP row's target link (yours, "]"'s, or F9's) = UR-MP context and that row is your position.
  // A click on an Issue Tracker list card = tracker context. Clicks anywhere else (map pins, the UR panel) change nothing.
  document.addEventListener('click', e => {
    const t = e.target;
    if (!t || !t.closest) return;
    const tr = t.closest('td[id^="urt-targetur-"]')?.closest('tr[id^="urt-tr-"]');
    if (tr) { Next.setPosition(tr.id); return; }
    if (t.closest('.issue-tracker-card-content')) Next.setContext('tracker');
  }, true);
 
  // ===== KEYBOARD HOOK (not SDK) =====
  // "]" opens the next row in the UR-MP list from anywhere in WME, but only in UR-MP context.
  // In Issue Tracker context, or if UR-MP has no next row, the key passes through to WME's own Issue Tracker "]".
  function isTyping(e) {
    return e.composedPath().some(n => n && n.tagName &&
      (n.isContentEditable || /^(INPUT|TEXTAREA|SELECT|WZ-TEXTAREA|WZ-TEXT-INPUT)$/.test(n.tagName)));
  }
 
  window.addEventListener('keydown', e => {
    if (!settings.bracketNext || e.key !== ']' || e.ctrlKey || e.altKey || e.metaKey || isTyping(e)) return;
    const row = Next.row();
    if (!row) return; // tracker context, or nothing queued from UR-MP — let WME handle "]"
    e.preventDefault();
    e.stopImmediatePropagation();
    URMP.open(row);
  }, true);
 
  // ===== OPEN-NEXT API (for other scripts, e.g. WME Rapid UR Reply's F9) =====
  // Detect:  <html data-ua-api="1">  (set once UR Assist is ready)
  // Markers: <html data-ua-open-ur="id"> = UR whose panel is showing ("" if none), data-ua-next-ur = UR a "]" would open
  // Ask:     document.dispatchEvent(new CustomEvent('ua:open-next', { detail: { closedUrId } }))
  // Answer:  exactly one event on document, within about 2 s:
  //            ua:next-opened  detail { urId, closedUrId }
  //            ua:next-failed  detail { reason, closedUrId }
  // UR-MP context: opens the row that followed closedUrId (found by UR id, never "the next of the current"), retries the SAME row.
  // Tracker context: one plain "]" key for WME's own Next (never a click on its button), no retry.
  // The same closedUrId within 30 s is ignored silently. There is no auto-jump: only this event starts one.
  const OPEN_NEXT_TOTAL_MS = 2000, OPEN_NEXT_LOOKUP_MS = 800, OPEN_NEXT_WAIT_MS = 600, OPEN_NEXT_TRIES = 3, OPEN_NEXT_DEDUPE_MS = 30e3;
  const OpenNext = {
    seen: new Map(),   // closedUrId -> time handled
    busy: false,
    waiting: null,     // { match(id) -> bool, resolve }

    // WME may hand the id over as text or as a number, so every comparison here is on numbers
    noteOpened(id) {
      const n = Number(id);
      if (this.waiting && n && this.waiting.match(n)) this.waiting.resolve(n);
    },
    // Resolves the moment match(id) is true for an opened UR, or with null after ms.
    // Besides WME's panel-opened event it also watches the open-UR value itself (what data-ua-open-ur is published from) every 50 ms,
    // so a missed or differently typed event cannot make a UR that really opened look like a failure.
    waitOpen(match, ms) {
      return new Promise(resolve => {
        const start = Number(Next.openId) || 0;
        let timer = null, poll = null;
        const w = {
          match,
          resolve: id => {
            clearTimeout(timer);
            clearInterval(poll);
            if (this.waiting === w) this.waiting = null;
            resolve(id);
          }
        };
        this.waiting = w;
        timer = setTimeout(() => w.resolve(null), Math.max(0, ms));
        poll = setInterval(() => {
          const n = Number(Next.openId) || 0;
          if (n && n !== start && match(n)) w.resolve(n);
        }, 50);
      });
    },
    answer(name, detail) {
      try { document.dispatchEvent(new CustomEvent(name, { detail: toPageObj(detail) })); } catch (e) { LOG('Could not answer', name, e.message); }
    },
    fail(closedUrId, reason) {
      LOG(`open-next for UR ${closedUrId}: ${reason}`);
      this.answer('ua:next-failed', { reason, closedUrId });
    },

    async handle(e) {
      let closedUrId = null;
      try { closedUrId = Number(e.detail && e.detail.closedUrId) || null; } catch { /* detail not readable */ }
      if (!closedUrId) { this.fail(null, 'no closedUrId in the request'); return; }
      const now = Date.now();
      for (const [k, t] of this.seen) if (now - t > OPEN_NEXT_DEDUPE_MS) this.seen.delete(k);
      if (this.seen.has(closedUrId)) return;   // duplicate: stay silent so the first answer stands
      if (this.busy) { this.fail(closedUrId, 'busy with another request'); return; }
      this.seen.set(closedUrId, now);
      this.busy = true;
      try {
        if (Next.context === 'tracker') await this.viaTracker(closedUrId);
        else await this.viaList(closedUrId, now);
      } catch (err) {
        this.fail(closedUrId, `error: ${err.message}`);
      } finally {
        this.busy = false;
      }
    },

    async viaTracker(closedUrId) {
      const opened = this.waitOpen(id => id !== closedUrId, OPEN_NEXT_TOTAL_MS);  // ids are numbers (see noteOpened)
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ']', code: 'BracketRight', keyCode: 221, which: 221, bubbles: true, cancelable: true }));
      const id = await opened;
      if (id) this.answer('ua:next-opened', { urId: id, closedUrId });
      else this.fail(closedUrId, 'tracker: nothing opened');
    },

    async viaList(closedUrId, t0) {
      const deadline = t0 + OPEN_NEXT_TOTAL_MS;
      // 1. Find the target row. UR-MP may be redrawing, so keep looking for a moment
      let target = null, reason = '';
      for (;;) {
        const found = Next.afterId(closedUrId);
        if (found.row) { target = found.row.urId; break; }
        reason = found.reason;
        if (reason === 'closed UR not in UR-MP list' || Date.now() - t0 >= OPEN_NEXT_LOOKUP_MS) break;
        await sleep(100);
      }
      if (!target) { this.fail(closedUrId, reason); return; }
      // 2. Click that one row (retrying the same UR id) until WME opens it
      const before = { pos: Next.pos, snapshot: Next.snapshot };
      for (let i = 0; i < OPEN_NEXT_TRIES && deadline - Date.now() > 250; i++) {
        const row = URMP.rows().find(r => r.urId === target);
        if (row) {
          const opened = this.waitOpen(id => id === target, Math.min(OPEN_NEXT_WAIT_MS, deadline - Date.now()));
          URMP.open(row);
          if (await opened) {
            LOG(`open-next for UR ${closedUrId}: opened UR ${target} in ${Date.now() - t0} ms`);
            this.answer('ua:next-opened', { urId: target, closedUrId });
            return;
          }
        } else {
          await sleep(100);
        }
      }
      // Failed: put the position back so a hand-pressed "]" doesn't skip this row
      if (Number(Next.openId) !== target) { Next.pos = before.pos; Next.snapshot = before.snapshot; Next.refresh(); }
      this.fail(closedUrId, `UR ${target} did not open`);
    },
  };
  document.addEventListener('ua:open-next', e => OpenNext.handle(e));

  // ===== DUPLICATES =====
  // Likely duplicates: open URs from the same reporter (same username if both have one; otherwise identical
  // phone, vehicle, language and route settings) that are either
  //   - within DUPE_METERS and reported within DUPE_HOURS, or
  //   - back-to-back reports: report numbers at most SEQ_ID_GAP apart, within SEQ_MINUTES, and within a distance
  //     that grows with the time between them (seqMetersFor: at least SEQ_MIN_METERS, up to SEQ_MAX_METERS).
  // Keep: the one with comments > the one with a GPS track (if the other has none) > the later one. Close the rest.
  const DUPE_METERS = 50;
  const DUPE_HOURS = 3;
  const SEQ_ID_GAP = 3;
  const SEQ_MINUTES = 5;
  const SEQ_MIN_METERS = 1700;  // floor: reports about a mile apart still count at any time gap
  const SEQ_SPEED_MPS = 45;     // past the floor, allow this much more distance per second (about 100 mph)
  const SEQ_MARGIN_METERS = 100;
  const SEQ_MAX_METERS = 5000;  // never allow more than this
  const seqMetersFor = ms => Math.min(SEQ_MAX_METERS, Math.max(SEQ_MIN_METERS, (ms / 1000) * SEQ_SPEED_MPS + SEQ_MARGIN_METERS));
  // For now duplicates stay open: the reply goes in the comment box but no status is selected.
  // Set to true later to have Not identified (or your sheet's status for the duplicate reply) selected again.
  const DUPE_SET_STATUS = false;
 
  function metersApart(a, b) {
    const [lo1, la1] = a.geometry.coordinates, [lo2, la2] = b.geometry.coordinates, r = Math.PI / 180;
    return Math.hypot((lo2 - lo1) * r * Math.cos(((la1 + la2) / 2) * r), (la2 - la1) * r) * 6371000;
  }
 
  const Dupes = {
    closeOf: new Map(), // urId -> { keep, keepCoords }
    facts: new Map(),   // urId -> { comments, track, time }
    running: false,
 
    async scan() {
      if (this.running) return;
      this.running = true;
      try {
        const open = (await sdk.DataModel.MapUpdateRequests.getAll()).filter(u => u.isOpen);
        for (const u of open) reportedTimes.set(u.id, u.reportedOn);
        const parent = new Map(open.map(u => [u.id, u.id]));
        const find = x => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
        const paired = new Set();
        for (let i = 0; i < open.length; i++) {
          for (let j = i + 1; j < open.length; j++) {
            const a = open[i], b = open[j];
            const apart = Math.abs(a.reportedOn - b.reportedOn), meters = metersApart(a, b);
            const near = apart <= DUPE_HOURS * 3600e3 && meters <= DUPE_METERS;
            const backToBack = Math.abs(a.id - b.id) <= SEQ_ID_GAP && apart <= SEQ_MINUTES * 60e3 && meters <= seqMetersFor(apart);
            if (!near && !backToBack) continue;
            const ua = wmeExtra(a.id).createdBy, ub = wmeExtra(b.id).createdBy;
            if (ua && ub && ua !== ub) continue;
            if (!(ua && ua === ub) && reporterSettings(a) !== reporterSettings(b)) continue;
            parent.set(find(a.id), find(b.id));
            paired.add(a.id).add(b.id);
          }
        }
        const groups = new Map();
        for (const u of open) if (paired.has(u.id)) groups.set(find(u.id), [...(groups.get(find(u.id)) || []), u]);
 
        const closeOf = new Map();
        for (const members of groups.values()) {
          const info = await Promise.all(members.map(async u => ({ u, ...(await this.factsFor(u.id)) })));
          info.sort((a, b) => (b.comments > 0) - (a.comments > 0) || b.track - a.track || b.u.reportedOn - a.u.reportedOn);
          const keep = info[0].u;
          for (const x of info.slice(1)) closeOf.set(x.u.id, { keep: keep.id, keepCoords: keep.geometry.coordinates });
        }
        this.closeOf = closeOf;
        Strip.update();
      } catch (e) {
        LOG('Duplicate scan failed:', e.message);
      } finally {
        this.running = false;
      }
    },
 
    async factsFor(id) {
      const cached = this.facts.get(id);
      if (cached && Date.now() - cached.time < 10 * 60e3) return cached;
      const d = await sdk.DataModel.MapUpdateRequests.getUpdateRequestDetails({ mapUpdateRequestId: id });
      const f = {
        comments: (d?.comments || []).filter(c => commentRole(c.userName, c.text) !== 'system').length,
        track: !!d?.driveGeometry?.coordinates?.some(line => line.length > 1),
        time: Date.now(),
      };
      this.facts.set(id, f);
      return f;
    },
  };
 
  // Standard reply for a camera/train/stop sign report: your URC-E sheet reply when there is one, always closed as Not identified
  async function autoReplyText(id, rule) {
    const ur = await sdk.DataModel.MapUpdateRequests.getById({ mapUpdateRequestId: id });
    const r = rule.sheetKeys.length ? findReply(...rule.sheetKeys) : null;
    const text = r ? (await fillVars(r.text, buildContext(ur, { comments: [] }))).text : rule.fallback;
    if (!text) {
      setStatus(`No reply with "${rule.sheetKeys[0]}" in its title found in your URC-E sheet — nothing was filled in.`);
      return null;
    }
    return { text, state: 'not-identified' };
  }
 
  // ===== CLOSURE REPLY =====
  // Your Event closure reply goes into the comment box (Not identified selected) when ALL of these are true:
  //   you flagged it with the red closure sign (the amber "maybe" never counts) · the report says it was a closure
  //   (wording below, or the Road closed type) · only Map Team has commented · the red X is showing
  //   (so no map work, popcorn or UR-MP blacklist) · the comment box is empty.
  // Add words to CLOSURE_WORDS as you meet them.
  const CLOSURE_WORDS = /\b(closed|closure|closures|road\s*block(ed)?|blocked|construction)\b/i;
  const CLOSURE_NEGATED = /\b(not|isn'?t|wasn'?t|never)\s+(been\s+)?(closed|blocked)\b/i;
  const CLOSURE_TYPES = ['BLOCKED_ROAD'];
 
  function closureSaid(desc, type) {
    const text = String(desc || '').replace(/^[A-Z_]{4,}:\s*/, '');
    return CLOSURE_TYPES.includes(type) || (CLOSURE_WORDS.test(text) && !CLOSURE_NEGATED.test(text));
  }
 
  function closureReplyDue(id, desc, type, comments, reportedOn) {
    const info = urInfo(id), f = info.flags;
    return f.includes('closure') && !f.includes('maybeclosure') &&
      !['mapwork', 'watching', 'dupe'].some(x => f.includes(x)) &&
      !UrmpBL.has(id) && !autoPopcorn(comments) &&
      comments.every(c => c.role === 'system') &&
      overdueFor(info, comments, reportedOn) &&
      closureSaid(desc, type);
  }
 
  async function closureReply(id) {
    const r = replies.list.find(x => /event\s*closure/i.test(x.title));
    if (!r) {
      setStatus('No reply titled "Event closure" found in your URC-E sheet — nothing was filled in.');
      return null;
    }
    const ur = await sdk.DataModel.MapUpdateRequests.getById({ mapUpdateRequestId: id });
    return { text: (await fillVars(r.text, buildContext(ur, { comments: [] }))).text, state: 'not-identified' };
  }
 
  // Your URC-E duplicate reply (a sheet reply with "duplicate" or "dupe" in its title), plus a link to the one being kept
  async function duplicateReply(id, d) {
    const ur = await sdk.DataModel.MapUpdateRequests.getById({ mapUpdateRequestId: id });
    const ctx = buildContext(ur, { comments: [] });
    const r = findReply('duplicate', 'dupe');
    const body = r
      ? (await fillVars(r.text, ctx)).text
      : 'Thank you for your report. This report duplicates another report from the same trip, so we are closing this one and handling the issue on the other report.';
    return {
      text: `${body}\n\nDuplicate of: ${permalink({ id: d.keep, coords: d.keepCoords })}`,
      state: DUPE_SET_STATUS ? (r?.state || 'not-identified') : 'open',
    };
  }
 
  // ===== WME COMMENT BOX HOOK (not SDK — fills WME's own comment box; you review it and press Send) =====
  function commentBox(card) {
    return card.querySelector('.new-comment-text')?.shadowRoot?.querySelector('textarea') || null;
  }
 
  // WME's Send button, found by its label. Not found (WME changed, other language) = we can't tell, so we assume it's fine.
  function sendReady(card) {
    const b = [...card.querySelectorAll('wz-button, button')].find(x => /^\s*send\s*$/i.test(x.textContent));
    return !b || !(b.disabled || b.hasAttribute('disabled') || b.getAttribute('aria-disabled') === 'true');
  }
  // WME sends what its own comment field (the host element) holds, which can be empty while the box on screen shows text
  function boxTaken(card, text) {
    const h = card.querySelector('.new-comment-text');
    return !!h && String(h.value || '').trim() === text.trim();
  }
  async function waitFilled(card, text, ms) {
    const end = Date.now() + ms;
    for (;;) {
      if (boxTaken(card, text) && sendReady(card)) return true;
      if (Date.now() >= end) return false;
      await sleep(50);
    }
  }

  // Put text in WME's comment box and make sure WME really took it. Picking a status makes WME redraw the comment field and
  // forget earlier text, so the status goes first. WME only notices some kinds of input, so try a paste-like event first,
  // then the plain way, then the browser's own typing, stopping at the first that works.
  async function fillCommentBox(card, text, state) {
    const prevFocus = document.activeElement;
    if (state === 'not-identified' || state === 'solved') {
      card.querySelector(`input[value="${state}"]`)?.click();
      await sleep(150);
    }
    for (let n = 0; n < 10 && !commentBox(card); n++) await sleep(50);
    const methods = [
      (host, ta) => {   // 1. like a paste
        ta.focus();
        ta.value = text;
        ta.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertFromPaste', data: text }));
      },
      (host, ta) => {   // 2. set the value and fire input + change
        ta.value = text;
        if (host && 'value' in host) host.value = text;
        ta.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      },
      (host, ta) => {   // 3. like typing: the browser's own insert
        ta.focus();
        ta.select();
        document.execCommand('insertText', false, text);
      },
    ];
    const apply = i => {
      const ta = commentBox(card);
      if (!ta) return false;
      methods[i](card.querySelector('.new-comment-text'), ta);
      return true;
    };
    let used = -1;
    for (let i = 0; i < methods.length && used < 0; i++) {
      if (!apply(i)) return false;
      if (await waitFilled(card, text, 400)) used = i;
    }
    if (used < 0) {
      LOG('The reply is in the comment box but WME did not take it — re-paste it or press Space then Backspace in the box');
    } else {
      if (used > 0) LOG(`WME only took the reply with fill method ${used + 1}`);
      // A late redraw can still wipe it: check once more and put it back the same way
      await sleep(300);
      if (!boxTaken(card, text)) {
        apply(used);
        LOG((await waitFilled(card, text, 400)) ? 'WME forgot the reply after it was filled; put it back' : 'WME forgot the reply after it was filled and would not take it again');
      }
    }
    try {   // leave the cursor where it was, so keys like "]" still work right after
      if (prevFocus && prevFocus !== document.body && prevFocus.focus) prevFocus.focus();
      else { commentBox(card)?.blur(); card.querySelector('.new-comment-text')?.blur?.(); }
    } catch { /* ignore */ }
    return used >= 0;
  }

  // ===== WME INTERNAL HOOK (not SDK — the reporter's user number isn't in the SDK) =====
  // Extra UR fields WME keeps (phone, vehicle, language, user number). Used for duplicates and the user number.
  function wmeExtra(id) {
    try { return unsafeWindow.W?.model?.mapUpdateRequests?.getObjectById?.(id)?.attributes || {}; } catch { return {}; }
  }
 
  function reporterSettings(u) {
    const e = wmeExtra(u.id), p = u.userPreferences || {};
    return JSON.stringify([e.os, e.vehicleType, e.reporterLanguage, JSON.stringify(p, Object.keys(p).sort())]);
  }
 
  // Anonymous reporters are stored as -1 (no number). Some reporters' replies carry a real number with no username.
  const MAP_TEAM_USER_ID = 2218201706;
  function reporterNumber(id, sdkComments) {
    try {
      const comments = unsafeWindow.W?.model?.updateRequestSessions?.getObjectById?.(id)?.getAttribute?.('comments') || [];
      const reporterTimes = new Set(sdkComments.filter(c => c.role === 'reporter').map(c => c.time));
      const c = comments.find(x => x.userID > 0 && x.userID !== MAP_TEAM_USER_ID && reporterTimes.has(x.createdOn));
      return c ? c.userID : null;
    } catch {
      return null;
    }
  }
 
  // ===== UR PANEL HEADER (not SDK — status buttons and sticky note added to WME's UR panel) =====
  const Header = {
    urId: null,
    comments: [],
 
    ensure() {
      const card = document.querySelector('wz-card.mapUpdateRequest');
      const sub = card?.querySelector('[data-testid="issue-panel-header-subtitle"]');
      publish('uaOpenUr', sub && Next.openId ? Next.openId : '');
      if (!sub || !Next.openId) { Note.close(); Seen.stop(); return; }
      let bar = card.querySelector('.ua-hdr');
      if (!bar || bar.dataset.ur !== String(Next.openId)) {
        bar?.remove();
        bar = this.build(Next.openId);
        sub.after(bar);
      }
      this.refresh(bar, Next.openId);
      this.reporter(card, Next.openId);
      this.autoInsert(card, Next.openId);
      Seen.check(Next.openId);
      Note.position();
    },
 
    // No username shown? Show the reporter's Waze user number in the same spot, if WME has one.
    reporter(card, id) {
      let tag = card.querySelector('.ua-userno');
      const num = card.querySelector('[data-testid="issue-panel-header-username"]') ? null : reporterNumber(id, this.comments);
      if (!num) { tag?.remove(); return; }
      if (tag?.dataset.n === String(num)) return;
      tag?.remove();
      tag = el('div', { class: 'ua-userno', title: 'This reporter has no username; this is their Waze user number' }, `Username: #${num}`);
      tag.dataset.n = String(num);
      const source = [...card.querySelectorAll('wz-caption')].find(c => /^Source/.test(c.textContent.trim()));
      const anchor = source?.closest('wz-tooltip-target') || card.querySelector('[data-testid="issue-panel-header-reported"]');
      anchor?.after(tag);
    },
 
    build(id) {
      const bar = el('span', { class: 'ua-hdr' });
      bar.dataset.ur = String(id);
      for (const s of STATUSES) {
        const b = el('button', { class: 'ua-btn', title: s.label });
        b.dataset.status = s.id;
        b.innerHTML = ICONS[s.id];
        b.addEventListener('click', e => {
          e.stopPropagation();
          const cur = urInfo(id);
          // The circle button clears your other statuses (the red ! stays) and puts the looked-at circle back
          const flags = s.id === 'waiting' ? [...new Set([...cur.flags.filter(keepOnClear), SEEN])]
            : cur.flags.includes(s.id) ? cur.flags.filter(f => f !== s.id) : [...cur.flags, s.id];
          saveUrInfo(id, { ...cur, flags });
          this.refresh(bar, id);
        });
        bar.append(b);
      }
      // Black triangle: shows UR-MP's blacklist only - not a button
      const bl = el('span', { class: 'ua-bl', title: BL_TITLE, style: 'display:none' });
      bl.innerHTML = ICONS.blacklist;
      bar.append(bl);
      bar.append(el('span', { class: 'ua-x' }));
      const dupe = el('span', { class: 'ua-dupe', style: 'display:none' });
      dupe.addEventListener('click', e => {
        e.stopPropagation();
        const card = document.querySelector('wz-card.mapUpdateRequest');
        if (card) this.autoInsert(card, id, true);
      });
      bar.append(dupe);
      const auto = el('span', { class: 'ua-auto', style: 'display:none' });
      auto.addEventListener('click', e => {
        e.stopPropagation();
        const card = document.querySelector('wz-card.mapUpdateRequest');
        if (card) this.autoInsert(card, id, true);
      });
      bar.append(auto);
      const noteBtn = el('button', { class: 'ua-btn ua-notebtn' });
      noteBtn.addEventListener('click', e => { e.stopPropagation(); Note.toggle(id, noteBtn); });
      bar.append(noteBtn);
      return bar;
    },
 
    refresh(bar, id) {
      const info = urInfo(id);
      const loaded = this.loadedId === id;
      const popcorn = loaded && autoPopcorn(this.comments);
      const blacklisted = UrmpBL.has(id);
      const overdue = loaded && overdueFor(info, this.comments, this.reportedOn);
      for (const b of bar.querySelectorAll('[data-status]')) {
        const s = b.dataset.status;
        const circle = s === 'waiting' && circleOn(info.flags) && !popcorn && !blacklisted && !overdue;
        const autoOn = (s === 'watching' && popcorn && !info.flags.includes(s)) || circle;
        b.classList.toggle('on', (s !== 'waiting' && info.flags.includes(s)) || autoOn);
        b.classList.toggle('auto', autoOn);
        b.title = s === 'waiting' ? STATUS_LABEL[s] : autoOn ? `${POPCORN_AUTO_TITLE} (set automatically)` : STATUS_LABEL[s];
      }
      const bs = bar.querySelector('.ua-bl');
      if (bs.dataset.k !== (blacklisted ? '1' : '')) {
        bs.dataset.k = blacklisted ? '1' : '';
        bs.style.display = blacklisted ? '' : 'none';
      }
      const xs = bar.querySelector('.ua-x');
      const x = loaded && overdueFor(info, this.comments, this.reportedOn) && !popcorn && !blacklisted &&
        !['mapwork', 'watching'].some(f => info.flags.includes(f));
      if (xs.dataset.k !== (x ? 'x' : '')) {
        xs.dataset.k = x ? 'x' : '';
        xs.innerHTML = x ? ICONS.xRed : '';
        xs.title = x ? X_TITLE : '';
      }
      const nb = bar.querySelector('.ua-notebtn');
      const k = info.note.trim() ? 'noteOn' : 'noteOff';
      if (nb.dataset.k !== k) { nb.dataset.k = k; nb.innerHTML = ICONS[k]; }
      nb.title = info.note.trim() ? info.note : 'Add a note';
      const ds = bar.querySelector('.ua-dupe');
      const d = Dupes.closeOf.get(id);
      if (ds.dataset.k !== String(d?.keep || '')) {
        ds.dataset.k = String(d?.keep || '');
        ds.style.display = d ? '' : 'none';
        ds.replaceChildren(...(d ? [icon('dupe', ''), ` Dup of #${d.keep}`] : []));
        ds.title = d ? 'Likely duplicate — click to put your duplicate reply in the comment box again' : '';
      }
      const as = bar.querySelector('.ua-auto');
      const a = !d && loaded ? autoState(this.desc, this.comments) : null;
      const ak = a ? `${a.rule.id}:${a.state}` : '';
      if (as.dataset.k !== ak) {
        as.dataset.k = ak;
        as.style.display = a ? '' : 'none';
        as.replaceChildren(...(a ? [icon(a.rule.icon, '')] : []));
        as.title = a ? `${autoTitle(a)} — click to put the standard reply in the comment box` : '';
      }
    },
 
    // Duplicate to close, or a camera/train report nobody has added to? Put the reply in WME's comment box
    // (only if it's empty) and select the status. You review it and press Send.
    async autoInsert(card, id, force = false) {
      if (!force && this.inserted === id) return;
      const d = Dupes.closeOf.get(id);
      let kind = d ? 'dupe' : null;
      let rule = null;
      if (!kind && this.loadedId === id) {
        const a = autoState(this.desc, this.comments);
        if (a && (a.state === 'auto' || force)) {
          if (!force && a.rule.id === 'camera' && AutoSend.covers(id, this.desc, this.reportedOn, this.comments)) return;   // auto-send answers these itself
          kind = 'auto'; rule = a.rule;
        }
        else if (closureReplyDue(id, this.desc, this.type, this.comments, this.reportedOn)) kind = 'closure';
      }
      if (!kind) return;
      const box = commentBox(card);
      if (!box) return; // comment box not ready yet — try again next pass
      this.inserted = id;
      if (!force && box.value.trim()) return;
      const reply = kind === 'dupe' ? await duplicateReply(id, d)
        : kind === 'closure' ? await closureReply(id)
        : await autoReplyText(id, rule);
      if (reply && Next.openId === id) fillCommentBox(card, reply.text, reply.state);
    },
  };
 
  // Sticky-note pad: opens under the note icon, saves as you type, closes when you click elsewhere or press Esc
  const Note = {
    pop: null,
    anchor: null,
    id: null,
 
    toggle(id, anchor) {
      if (this.pop && this.id === id) this.close();
      else this.open(id, anchor);
    },
 
    open(id, anchor) {
      this.close();
      const pad = el('textarea', { class: 'ua-notepad', rows: 6, placeholder: 'Note for this UR…', value: urInfo(id).note });
      let timer;
      pad.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => saveUrInfo(id, { ...urInfo(id), note: pad.value }), 300);
      });
      pad.addEventListener('keydown', e => { if (e.key === 'Escape') { saveUrInfo(id, { ...urInfo(id), note: pad.value }); this.close(); } });
      pad.addEventListener('blur', () => saveUrInfo(id, { ...urInfo(id), note: pad.value }));
      this.pop = el('div', { class: 'ua-notepop' }, pad);
      document.body.append(this.pop);
      this.id = id;
      this.anchor = anchor;
      this.position();
      pad.focus();
    },
 
    position() {
      if (!this.pop) return;
      if (!this.anchor?.isConnected) { this.close(); return; }
      const r = this.anchor.getBoundingClientRect();
      this.pop.style.left = `${Math.max(8, Math.min(r.left - 120, window.innerWidth - 270))}px`;
      this.pop.style.top = `${r.bottom + 4}px`;
    },
 
    close() {
      if (!this.pop) return;
      this.pop.querySelector('textarea')?.blur();
      this.pop.remove();
      this.pop = null;
      this.id = null;
    },
  };
 
  document.addEventListener('mousedown', e => {
    if (Note.pop && !Note.pop.contains(e.target) && !e.target.closest?.('.ua-notebtn')) Note.close();
  }, true);
 
  // ===== SIDEBAR TAB (settings and icon legend) =====
  function syncSection() {
    ui.syncLine = el('div', { class: 'ua-muted' }, Sync.enabled() ? 'Waiting for first sync…' : 'Not set up yet.');
    ui.blLine = el('div', { class: 'ua-muted' }, 'UR-MP blacklist: waiting for UR-MP to load…');
    const urlInput = el('input', { value: settings.syncUrl, placeholder: 'https://script.google.com/macros/s/…/exec', style: 'width:100%' });
    const secretInput = el('input', { type: 'password', value: settings.syncSecret, placeholder: 'Same secret word as in the Apps Script', style: 'width:100%' });
    return el('details', { class: 'ua-settings' },
      el('summary', {}, el('b', {}, 'Sync between laptops (Google Sheets)')),
      el('div', { class: 'ua-muted' }, 'Web app URL'), urlInput,
      el('div', { class: 'ua-muted' }, 'Secret word'), secretInput,
      el('div', { class: 'ua-row' },
        el('button', {
          textContent: 'Save & sync now',
          onclick: () => {
            const changedTarget = urlInput.value.trim() !== settings.syncUrl;
            settings.syncUrl = urlInput.value;
            settings.syncSecret = secretInput.value;
            if (changedTarget) GM_setValue('syncSince', 0); // new sheet: send everything
            Sync.run();
          },
        }),
        el('button', { textContent: 'Sync now', onclick: () => Sync.run() })),
      ui.syncLine,
      ui.blLine);
  }
 
  function backupSection() {
    const box = el('textarea', { rows: 4, placeholder: 'Paste a backup here, then click Restore', style: 'width:100%;box-sizing:border-box' });
    return el('details', { class: 'ua-settings' },
      el('summary', {}, el('b', {}, 'Backup / restore statuses and notes')),
      el('div', { class: 'ua-muted' }, `${Object.values(urStore).filter(hasContent).length} URs with statuses or notes saved.`),
      box,
      el('div', { class: 'ua-row' },
        el('button', {
          textContent: 'Copy backup',
          onclick: async () => {
            box.value = exportData();
            try { await navigator.clipboard.writeText(box.value); setStatus('Backup copied to the clipboard.'); }
            catch { setStatus('Backup is in the box — copy it from there.'); }
          },
        }),
        el('button', {
          textContent: 'Restore (merge)',
          onclick: () => {
            try { setStatus(`Restored ${importData(box.value)} UR(s). Newer entries are kept.`); }
            catch (e) { setStatus(`Couldn't read that backup: ${e.message}`); }
          },
        })));
  }
 
  function buildUi(pane) {
    pane.classList.add('urassist');
    ui.statusLine = el('div', { class: 'ua-status' });
    ui.autoLine = el('div', { class: 'ua-muted' }, 'Auto-send camera reports: starting…');
    ui.sheetLine = el('div', { class: 'ua-muted' }, 'Loading replies…');
    const sheetInput = el('input', { value: settings.sheetId, style: 'width:100%' });
    const keyInput = el('input', { type: 'password', value: settings.aiKey, placeholder: 'sk-…', style: 'width:100%' });
    const modelInput = el('input', { value: settings.aiModel, style: 'width:100%' });
 
    const legend = el('div', { class: 'ua-legend' },
      ...STATUSES.map(s => el('div', {}, icon(s.id, s.label), ` ${s.label}`)),
      el('div', {}, icon('watching', POPCORN_AUTO_TITLE), ' Popcorn also turns on by itself when another editor replied and you never have'),
      el('div', {}, icon('blacklist', BL_TITLE), ' Blacklisted in UR-MP – shown automatically, hides the red X. Blacklisting in UR-MP also syncs to your other laptop.'),
      el('div', {}, icon('xRed', X_TITLE), ` Automatic: no Wazer reply in ${NO_REPLY_HOURS} h (Map Team counts). Hidden by map work, popcorn and UR-MP blacklist.`),
      el('div', {}, icon('camera', ''), ' ', icon('train', ''), ' ', icon('stopsign', ''), ' Camera report: open it and it is answered, closed as Not identified, and the next row opens (setting below). Train / stop sign report: standard reply goes in with Not identified (you review and Send)'),
      el('div', {}, icon('dupe', ''), ` Duplicates are also found automatically: same reporter, and within ${DUPE_METERS} m / ${DUPE_HOURS} h, or back-to-back reports (numbers ${SEQ_ID_GAP} or fewer apart, within ${SEQ_MINUTES} min and ${SEQ_MIN_METERS} m or more, growing with the time between them)`),
      el('div', {}, icon('closure', ''), ' + ', icon('xRed', ''), ' Red closure sign, the report says it was a closure, only Map Team has commented, and the red X is showing: your Event closure reply goes in with Not identified when you open it (never for the amber sign)'),
      el('div', {}, icon('noteOn', 'Note'), ' Has a note'));
 
    pane.append(
      el('div', {}, el('b', {}, SCRIPT_NAME), ' ', el('span', { class: 'ua-muted' }, `v${VERSION}`)),
      el('div', { class: 'ua-muted' }, 'Set statuses and notes from the icons in the UR panel header. They show in a column at the right of the UR-MP list.'),
      legend,
      ui.statusLine,
      ui.autoLine,
      syncSection(),
      backupSection(),
      el('div', { class: 'ua-settings' },
        el('b', {}, 'Settings'),
        el('label', { class: 'ua-row' },
          el('input', { type: 'checkbox', checked: settings.bracketNext, onchange: e => { settings.bracketNext = e.target.checked; } }),
          'Use ] for the next row in UR-MP (after you click in UR-MP). After you click in the Issue Tracker, WME’s own ] is used.'),
        el('label', { class: 'ua-row' },
          el('input', { type: 'checkbox', checked: settings.autoSendCameras, onchange: e => { settings.autoSendCameras = e.target.checked; AutoSend.status(''); Strip.update(); if (e.target.checked) AutoSend.refresh(); } }),
          `Answer camera reports automatically: when you open one, post your sheet's camera reply, mark it Not identified and open the next row (${AUTO_SEND_MIN_AGE_MIN}+ minutes old, only when nobody but Map Team has commented). Uncheck to stop.`),
        el('label', { class: 'ua-row' },
          el('input', { type: 'checkbox', checked: settings.ageHours, onchange: e => { settings.ageHours = e.target.checked; Strip.update(); } }),
          `Show hours (up to ${AGE_HOURS_UP_TO} h) instead of days in UR-MP's age column`),
        el('div', { class: 'ua-muted' }, 'URC-E sheet ID or link (for replies — paused)'),
        sheetInput,
        el('div', { class: 'ua-row' },
          el('button', {
            textContent: 'Save & reload replies',
            onclick: async () => {
              settings.sheetId = extractSheetId(sheetInput.value);
              sheetInput.value = settings.sheetId;
              await reloadReplies(true);
            },
          })),
        ui.sheetLine,
        el('div', { class: 'ua-muted', style: 'margin-top:10px' }, 'OpenAI API key (optional — stored only in Tampermonkey)'),
        keyInput,
        el('div', { class: 'ua-muted' }, 'OpenAI model'),
        modelInput,
        el('div', { class: 'ua-row' },
          el('button', {
            textContent: 'Save AI settings',
            onclick: () => { settings.aiKey = keyInput.value; settings.aiModel = modelInput.value; setStatus('AI settings saved.'); },
          }))));
  }
 
  GM_addStyle(`
    .urassist { padding: 8px; font-size: 13px; }
    #urassist-dock { position: fixed; z-index: 2000; width: 340px; overflow-y: auto; box-sizing: border-box;
      background: var(--background_default, #fff); color: var(--content_default, #202124);
      border-radius: 8px; box-shadow: 0 2px 12px rgba(0,0,0,.35); }
    .urassist .ua-dock-head { display: flex; gap: 6px; align-items: center; }
    .urassist .ua-mini { padding: 1px 6px; font-size: 12px; cursor: pointer; }
    .urassist .ua-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 6px 0; }
    .urassist .ua-next { flex: 1; }
    .urassist .ua-muted { color: #888; font-size: 12px; }
    .urassist .ua-status { min-height: 1em; color: #1565c0; }
    .urassist .ua-title { font-weight: bold; font-size: 14px; margin-top: 6px; }
    .urassist .ua-label { font-weight: bold; margin-top: 8px; }
    .urassist .ua-text { white-space: pre-wrap; }
    .urassist .ua-c { border-left: 3px solid #bbb; padding: 2px 6px; margin: 4px 0; }
    .urassist .ua-c.ua-reporter { border-color: #e67e22; }
    .urassist .ua-c.ua-me { border-color: #2e7d32; }
    .urassist .ua-c.ua-editor { border-color: #1565c0; }
    .urassist .ua-badge { display: inline-block; padding: 1px 7px; border-radius: 9px; margin: 4px 4px 0 0; font-size: 12px; color: #fff; background: #888; }
    .urassist .ua-badge.ua-propose { background: #2e7d32; }
    .urassist .ua-badge.ua-mapwork { background: #e67e22; }
    .urassist .ua-badge.ua-review { background: #1565c0; }
    .urassist .ua-badge.ua-waiting { background: #757575; }
    .urassist .ua-badge.ua-es { background: #8e24aa; }
    .urassist .ua-warn { color: #c62828; font-size: 12px; }
    .urassist .ua-settings { margin-top: 12px; }
    .urassist .ua-dock-head { cursor: move; user-select: none; }
    .urassist .ua-grip { flex: 1; }
    .urassist .ua-flagrow { display: flex; gap: 4px; flex-wrap: wrap; margin: 6px 0 2px; }
    .urassist .ua-flag { font-size: 16px; line-height: 1; padding: 3px 5px; border: 1px solid #bbb; border-radius: 6px;
      background: transparent; cursor: pointer; opacity: .4; filter: grayscale(1); }
    .urassist .ua-flag.on { opacity: 1; filter: none; border-color: #1e66f5; background: rgba(30,102,245,.15); }
    .urassist .ua-note { width: 100%; box-sizing: border-box; margin-top: 6px; background: #fff9c4; color: #202124; }
    .urassist details.ua-reply > summary { cursor: pointer; font-weight: bold; margin-top: 6px; }
    .ua-flags { margin-right: 3px; cursor: help; }
    .ua-hdr { display: inline-flex; gap: 2px; align-items: center; margin-left: 6px; vertical-align: middle; }
    .ua-hdr .ua-btn { width: 22px; height: 22px; padding: 2px; border: 1px solid transparent; border-radius: 5px;
      background: transparent; cursor: pointer; opacity: .28; filter: grayscale(1); }
    .ua-hdr .ua-btn:hover { opacity: .75; filter: none; }
    .ua-hdr .ua-btn.on { opacity: 1; filter: none; border-color: #9e9e9e; }
    .ua-hdr .ua-notebtn { opacity: 1; filter: none; }
    .ua-hdr .ua-bl { display: inline-block; width: 18px; height: 18px; cursor: help; }
    .ua-hdr .ua-x { display: inline-block; width: 16px; height: 16px; }
    .ua-hdr svg, .ua-ic svg { display: block; width: 100%; height: 100%; }
    .ua-ic { display: inline-block; width: 12px; height: 12px; margin: 0 1px; vertical-align: middle; }
    #ua-strip .ua-cell { position: fixed; z-index: 1500; box-sizing: border-box; display: flex; align-items: center;
      justify-content: center; gap: 1px; white-space: nowrap; overflow: hidden; }
    #ua-strip .ua-ic { width: 12px; height: 12px; }
    #ua-strip .ua-head .ua-ic { opacity: .55; }
    #ua-strip .ua-age { position: fixed; z-index: 1500; box-sizing: border-box; display: flex; align-items: center;
      justify-content: center; white-space: nowrap; overflow: hidden; pointer-events: none; }
    #ua-nextline { position: fixed; z-index: 1500; height: 3px; background: #1e66f5; pointer-events: none; }
    .ua-userno { font-size: 12px; margin: 2px 0; }
    .ua-hdr .ua-auto { display: inline-flex; width: 18px; height: 18px; cursor: pointer; }
    .ua-hdr .ua-auto .ua-ic { width: 18px; height: 18px; margin: 0; }
    .ua-hdr .ua-btn.auto { border-style: dashed; }
    .ua-hdr .ua-dupe { display: inline-flex; align-items: center; gap: 2px; font-size: 11px; color: #d32f2f; cursor: pointer; white-space: nowrap; }
    .ua-hdr .ua-dupe .ua-ic { width: 14px; height: 14px; }
    .ua-notepop { position: fixed; z-index: 2100; width: 260px; padding: 6px; background: #fff59d;
      border: 1px solid #c8b400; border-radius: 4px; box-shadow: 0 3px 10px rgba(0,0,0,.3); }
    .ua-notepad { width: 100%; box-sizing: border-box; border: none; outline: none; resize: vertical;
      background: transparent; color: #202124; font: 13px/1.35 sans-serif; }
    .urassist .ua-legend > div { margin: 3px 0; }
    .urassist .ua-legend .ua-ic { width: 14px; height: 14px; }
  `);
 
  // ===== AUTO-SEND CAMERA REPORTS (SDK) =====
  // Camera reports (the ones that get the camera icon) are answered and closed for you: your URC-E sheet's camera reply is
  // posted and the report is marked Not identified. Two ways it starts:
  //   1. YOU OPEN ONE (the main way): it replies, closes it, then opens the next row in the list; if that one is a camera
  //      report too it does the same, and so on until it reaches one that isn't. (Closing needs the report loaded in WME,
  //      which opening it does.)
  //   2. In the background, for camera reports WME already has loaded, a few seconds apart.
  // Only when ALL of these are true:
  //   the setting is on · only Map Team has commented (the reporter said nothing, no editor replied) · it was reported at least
  //   AUTO_SEND_MIN_AGE_MIN minutes ago · it isn't blacklisted in UR-MP, a duplicate, or flagged map work / popcorn ·
  //   your sheet has a camera reply and it needs nothing from the map (no selected-road or place variables).
  // At most AUTO_SEND_MAX_PER_HOUR an hour. Anything else is left for you (and the reply goes in the box for review as before).
  const AUTO_SEND_MIN_AGE_MIN = 10;
  const AUTO_SEND_EVERY_MS = 6000;
  const AUTO_SEND_REFRESH_MS = 30000;
  const AUTO_SEND_MAX_PER_HOUR = 60;
  const AUTO_SEND_NEXT_DELAY_MS = 700;
  const SELECTION_VARS = /\$(SELSEGS|SELSEGS_WITH_CITY|PLACE_NAME|PLACE_ADDRESS)\$/;

  const AutoSend = {
    queue: [],
    later: new Map(),   // urId -> time before which the background pass doesn't look at it again
    why: new Map(),     // urId -> short reason it is being left alone (shown in the status line)
    known: new Set(),   // camera reports seen on the last look
    working: new Set(), // URs being answered right now
    busy: false,
    refreshing: false,
    sentTimes: [],
    count: 0,
    lastText: '',
    lastLog: '',
    warned: new Set(),
    done: GM_getValue('autoSent', {}),   // urId -> { t, stage: 'commented' | 'done' } so nothing is ever answered twice

    enabled() { return !!settings.autoSendCameras; },
    isCamera(desc) {
      const rule = AUTO_RULES.find(r => r.test(reportCode(desc), String(desc)));
      return !!rule && rule.id === 'camera';
    },
    skipFor(id, ms, why) { this.later.set(id, Date.now() + ms); if (why) this.why.set(id, why); },
    skipped(id) { return (this.later.get(id) || 0) > Date.now() || this.done[id]?.stage === 'done'; },
    warnOnce(key, msg) { if (!this.warned.has(key)) { this.warned.add(key); LOG(`Auto-send: ${msg}`); } },

    // One line for the sidebar: what was found, and why anything is being left alone
    summary() {
      const now = Date.now(), why = {};
      for (const id of this.known) {
        if (this.done[id]?.stage === 'done') continue;
        if ((this.later.get(id) || 0) > now) { const w = this.why.get(id) || 'waiting'; why[w] = (why[w] || 0) + 1; }
      }
      const parts = Object.entries(why).map(([w, n]) => `${n} ${w}`);
      return `${this.known.size} camera report(s) open${parts.length ? ` · ${parts.join(' · ')}` : ''}`;
    },
    status(msg) {
      this.lastText = msg;
      const state = !this.enabled() ? 'off' : !myName ? 'waiting for your user name' : !replies.list.length ? 'waiting for your URC-E sheet replies' : 'on';
      if (ui.autoLine) ui.autoLine.textContent = `Auto-send camera reports: ${state}${this.count ? ` · ${this.count} sent this session` : ''}${this.enabled() ? ` · ${this.summary()}` : ''}${msg ? ` · ${msg}` : ''}`;
    },
    save() {
      const cutoff = Date.now() - 60 * 864e5;
      for (const [k, v] of Object.entries(this.done)) if (v.t < cutoff) delete this.done[k];
      GM_setValue('autoSent', this.done);
    },
    usesSelection(text, depth = 0) {
      if (SELECTION_VARS.test(text)) return true;
      if (depth > 5) return false;
      for (const m of String(text).matchAll(/\$([A-Z0-9_]+)\$/g)) {
        if (m[1] in replies.vars && this.usesSelection(replies.vars[m[1]], depth + 1)) return true;
      }
      return false;
    },

    // null = go ahead. Otherwise { why, ms }: the reason to leave it alone, and how long before looking again.
    check(id, desc, reportedOn, comments) {
      if (!this.isCamera(desc)) return { why: 'not a camera type', ms: 24 * 3600e3 };
      if (this.done[id]?.stage === 'done') return { why: 'already answered', ms: 24 * 3600e3 };
      const wait = AUTO_SEND_MIN_AGE_MIN * 60e3 - (Date.now() - reportedOn);
      if (wait > 0) return { why: `too new (under ${AUTO_SEND_MIN_AGE_MIN} min)`, ms: wait + 1000 };
      if (UrmpBL.has(id) || Dupes.closeOf.has(id) || ['mapwork', 'watching', 'dupe'].some(f => urInfo(id).flags.includes(f))) {
        return { why: 'blacklisted/duplicate/flagged', ms: 30 * 60e3 };
      }
      const reply = findReply(...AUTO_RULES.find(r => r.id === 'camera').sheetKeys);
      if (!reply) { this.warnOnce('noreply', 'no reply with "camera" or "flock" in its title in your URC-E sheet, so nothing is sent'); return { why: 'no camera reply in your sheet', ms: 30 * 60e3 }; }
      if (this.usesSelection(reply.text)) { this.warnOnce('selvars', 'the camera reply uses a selected-road or place variable, so it can\'t be sent automatically'); return { why: 'camera reply needs a map selection', ms: 30 * 60e3 }; }
      const st = autoState(desc, comments);
      if (!st || st.state !== 'auto') return { why: st ? 'reporter commented (yours)' : 'someone already replied (yours)', ms: 6 * 3600e3 };
      if (this.sentTimes.filter(t => Date.now() - t < 3600e3).length >= AUTO_SEND_MAX_PER_HOUR) return { why: `hourly limit (${AUTO_SEND_MAX_PER_HOUR})`, ms: 5 * 60e3 };
      return null;
    },

    // For the comment box: true = auto-send has this one (or already did), so don't also fill the box for review
    covers(id, desc, reportedOn, comments) {
      if (!this.enabled() || !this.isCamera(desc)) return false;
      if (this.working.has(id) || this.done[id]) return true;
      if ((this.later.get(id) || 0) > Date.now()) return false;
      return this.check(id, desc, reportedOn, comments) === null;
    },

    // Every open camera report WME has loaded, plus whatever UR-MP is listing (the unloaded ones wait until you open them)
    async refresh() {
      if (!this.enabled() || this.refreshing || !sdk) return;
      this.refreshing = true;
      try {
        const ids = new Set();
        try {
          for (const u of await sdk.DataModel.MapUpdateRequests.getAll()) if (u.isOpen && this.isCamera(u.description)) ids.add(u.id);
        } catch (e) { LOG('Auto-send: could not list URs:', e.message); }
        for (const r of URMP.rows()) if (this.isCamera(URMP.description(r.urId))) ids.add(r.urId);
        this.known = ids;
        const list = [...ids].filter(id => !this.skipped(id));
        for (let i = list.length - 1; i > 0; i--) {   // shuffled, so two laptops don't walk the list in step
          const j = Math.floor(Math.random() * (i + 1));
          [list[i], list[j]] = [list[j], list[i]];
        }
        this.queue = list;
        const line = this.summary() + ` · ${list.length} to look at`;
        if (line !== this.lastLog) { this.lastLog = line; LOG(`Auto-send: ${line}`); }
        this.status(this.lastText);
      } finally {
        this.refreshing = false;
      }
    },

    async tick() {
      if (!this.enabled()) { this.queue = []; return; }
      if (this.busy || !sdk || !myName || !replies.list.length) return;
      const id = this.queue.shift();
      if (!id || this.skipped(id) || this.working.has(id)) return;
      this.busy = true;
      this.working.add(id);
      try {
        await this.handle(id, false);
      } catch (e) {
        this.skipFor(id, 60 * 60e3, 'send failed (see console)');
        LOG(`Auto-send: UR ${id} failed – ${e.message}`);
        this.status(`UR ${id} failed: ${e.message}`);
      } finally {
        this.working.delete(id);
        this.busy = false;
        this.status(this.lastText);
      }
    },

    // You opened UR `id`: if it's an eligible camera report, answer and close it, then move on to the next row
    async onOpened(id) {
      if (!this.enabled() || !sdk || !myName || !replies.list.length) return;
      if (this.working.has(id)) return;
      this.later.delete(id);   // you opened it: the background pass's "open on screen" wait no longer applies
      this.working.add(id);
      let sent = false;
      try {
        for (let i = 0; i < 50 && this.busy; i++) await sleep(100);   // let a background reply finish first
        sent = await this.handle(id, true);
      } catch (e) {
        this.skipFor(id, 60 * 60e3, 'send failed (see console)');
        LOG(`Auto-send: UR ${id} failed – ${e.message}`);
        this.status(`UR ${id} failed: ${e.message}`);
      } finally {
        this.working.delete(id);
        this.status(this.lastText);
      }
      if (!sent) return;
      await sleep(AUTO_SEND_NEXT_DELAY_MS);   // give UR-MP a moment to drop the closed row
      if (Number(Next.openId) !== id) return;   // you moved on yourself
      OpenNext.handle({ detail: { closedUrId: id } });
    },

    async details(id) {
      const d = await sdk.DataModel.MapUpdateRequests.getUpdateRequestDetails({ mapUpdateRequestId: id });
      return { raw: d, comments: (d?.comments || []).map(c => ({ ...c, role: commentRole(c.userName, c.text) })) };
    },

    async close(id) {
      await sdk.DataModel.MapUpdateRequests.updateResolutionState({ mapUpdateRequestId: id, resolutionState: 'not-identified' });
      this.done[id] = { t: Date.now(), stage: 'done' };
      this.save();
    },

    // Returns true when the report was answered and closed
    async handle(id, opened) {
      if (!opened && Number(Next.openId) === id) { this.skipFor(id, 2 * 60e3, 'open on screen'); return false; }   // you're looking at it: open it again to answer it
      const ur = await sdk.DataModel.MapUpdateRequests.getById({ mapUpdateRequestId: id });
      if (!ur) { this.skipFor(id, 10 * 60e3, 'not loaded in WME (answered when you open it)'); return false; }
      if (!ur.isOpen) { this.skipFor(id, 24 * 3600e3, 'already closed'); return false; }

      // Commented but not yet closed (e.g. the close failed last time): just finish the close
      if (this.done[id]?.stage === 'commented') {
        await this.close(id);
        this.finished(id, 'closed (finishing an earlier reply)');
        return true;
      }

      let { comments } = await this.details(id);
      let bad = this.check(id, ur.description, ur.reportedOn, comments);
      if (bad) { this.skipFor(id, bad.ms, bad.why); return false; }

      const reply = findReply(...AUTO_RULES.find(r => r.id === 'camera').sheetKeys);
      const filled = await fillVars(reply.text, buildContext(ur, { comments }));
      if (!filled.text || filled.unresolved.length) {
        this.warnOnce('unresolved', `the camera reply still has ${filled.unresolved.join(' ')} after filling in, so nothing is sent`);
        this.skipFor(id, 30 * 60e3, 'reply has unfilled variables');
        return false;
      }

      // Last look right before posting (in the background, a short random wait helps two laptops not both post it)
      if (!opened) await sleep(Math.random() * 1500);
      if (!opened && Number(Next.openId) === id) { this.skipFor(id, 2 * 60e3, 'open on screen'); return false; }
      ({ comments } = await this.details(id));
      bad = this.check(id, ur.description, ur.reportedOn, comments);
      if (bad) { this.skipFor(id, bad.ms, bad.why); return false; }

      await sdk.DataModel.MapUpdateRequests.addComment({ mapUpdateRequestId: id, text: filled.text });
      this.done[id] = { t: Date.now(), stage: 'commented' };
      this.save();
      this.sentTimes.push(Date.now());
      if (Header.urId === id) Header.inserted = id;   // the open panel must not also fill its box for review
      try {
        await this.close(id);
        this.finished(id, 'replied and marked Not identified');
        return true;
      } catch (e) {
        LOG(`Auto-send: UR ${id} was replied to but marking it Not identified failed – ${e.message}. Will try again.`);
        this.status(`UR ${id}: replied, but Not identified failed`);
        this.skipFor(id, 2 * 60e3, 'close failed, retrying');
        return false;
      }
    },

    finished(id, what) {
      this.count++;
      LOG(`Auto-send: UR ${id} ${what}.`);
      this.status(`UR ${id} ${what} at ${new Date().toLocaleTimeString()}`);
      Strip.update();
    },

    start() {
      this.status('');
      setTimeout(() => this.refresh(), 15000);
      setInterval(() => this.refresh(), AUTO_SEND_REFRESH_MS);
      setInterval(() => this.tick(), AUTO_SEND_EVERY_MS);
    },
  };

  // ===== QUESTION MARK WHEN YOU REPLY =====
  // The moment you press Send on a reply that leaves the UR open, it gets the purple "?" (I asked a question – waiting on
  // the Wazer) in place of the open circle. A reply that closes it (Solved / Not identified) gets nothing: it's done.
  // If the reply turns out not to have gone through, the "?" is taken off again.
  const Asked = {
    set(id) {
      const cur = urInfo(id);
      if (cur.flags.includes('asked')) return false;
      saveUrInfo(id, { ...cur, flags: [...cur.flags, 'asked'] });
      return true;
    },
    unset(id) {
      const cur = urInfo(id);
      if (cur.flags.includes('asked')) saveUrInfo(id, { ...cur, flags: cur.flags.filter(f => f !== 'asked') });
    },
    async verify(id, before, added) {
      await sleep(4000);
      try {
        const { comments } = await AutoSend.details(id);
        const now = comments.filter(c => c.role === 'me').length;
        if (Number(Next.openId) === id && Header.loadedId === id) Header.comments = comments.map(c => ({ role: c.role, time: c.createdOn }));
        const ur = await sdk.DataModel.MapUpdateRequests.getById({ mapUpdateRequestId: id });
        if (!added) return;
        if (ur && !ur.isOpen) this.unset(id);   // it got closed right after (e.g. Rapid UR Reply's F9): nothing to wait for
        else if (before !== null && now <= before) {
          this.unset(id);
          LOG(`Question mark taken off UR ${id}: your reply doesn't show up on it.`);
        }
      } catch { /* leave the mark */ }
    },
  };
  document.addEventListener('click', e => {
    const btn = e.composedPath().find(n => n && n.matches && n.matches('wz-button.send-button'));
    if (!btn) return;
    const card = btn.closest('wz-card.mapUpdateRequest') || document.querySelector('wz-card.mapUpdateRequest');
    const id = Number(Next.openId);
    if (!card || !id) return;
    const text = String(card.querySelector('.new-comment-text')?.value || commentBox(card)?.value || '').trim();
    if (!text) return;
    const picked = card.querySelector('input[type="radio"]:checked')?.value;
    if (picked === 'solved' || picked === 'not-identified') return;   // closing it: nothing to wait for
    const before = Header.loadedId === id ? Header.comments.filter(c => c.role === 'me').length : null;
    const added = Asked.set(id);
    Asked.verify(id, before, added);
  }, true);

  // ===== STARTUP =====
  async function start() {
    myName = (await sdk.State.getUserInfo())?.userName || '';
    migrateOldNotes();
    convertWaiting();
    Strip.init();
    GM_addValueChangeListener('urData', (key, oldVal, newVal, remote) => {
      if (remote) { urStore = newVal || {}; Strip.update(); }
    });
    Sync.run();
    setInterval(() => Sync.run(), 60000);
    const { tabLabel, tabPane } = await sdk.Sidebar.registerScriptTab();
    tabLabel.textContent = 'UR Assist';
    tabLabel.title = SCRIPT_NAME;
    buildUi(tabPane);
    UrmpBL.start();
 
    sdk.Events.on({ eventName: 'wme-update-request-panel-opened', eventHandler: onUrOpened });
    publish('uaApi', '1'); // ready: other scripts can now use the open-next API
    setInterval(() => Next.refresh(), 1000);
    setInterval(() => Header.ensure(), 300);
 
    try {
      await sdk.Shortcuts.createShortcut({
        shortcutId: 'ur-assist-next',
        description: 'UR Assist: open next UR',
        shortcutKeys: null,
        callback: () => Next.openNext(),
      });
    } catch (e) {
      LOG('Shortcut not registered:', e.message);
    }
 
    await reloadReplies(false);
    AutoSend.start();
    Dupes.scan();
    setInterval(() => Dupes.scan(), 30000);
    LOG(`v${VERSION} ready${sdk.isBeta?.() ? ' (beta)' : ''}`);
  }
 
  unsafeWindow.SDK_INITIALIZED.then(async () => {
    try {
      sdk = unsafeWindow.getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME, mode: 'async' });
    } catch (e) {
      LOG('Async SDK mode unavailable, using default:', e.message);
      sdk = unsafeWindow.getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME });
    }
    if (await sdk.State.isReady()) start();
    else sdk.Events.once({ eventName: 'wme-ready' }).then(start);
  });
})();
