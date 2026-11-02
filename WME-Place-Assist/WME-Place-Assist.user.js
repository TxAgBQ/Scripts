// ==UserScript==
// @name         WME Place Assist
// @namespace    https://github.com/TxAgBQ
// @version      2026.11.02.03
// @description  Floating bar that flags Waze places on screen linked to permanently closed Google places, with a one-click list and staged delete.
// @author       TxAgBQ
// @homepageURL  https://github.com/TxAgBQ/Scripts/tree/main/WME-Place-Assist
// @supportURL   https://github.com/TxAgBQ/Scripts/issues
// @updateURL    https://raw.githubusercontent.com/TxAgBQ/Scripts/main/WME-Place-Assist/WME-Place-Assist.user.js
// @downloadURL  https://raw.githubusercontent.com/TxAgBQ/Scripts/main/WME-Place-Assist/WME-Place-Assist.user.js
// @match        https://beta.waze.com/editor*
// @match        https://beta.waze.com/*/editor*
// @match        https://www.waze.com/editor*
// @match        https://www.waze.com/*/editor*
// @exclude      https://beta.waze.com/user/editor*
// @exclude      https://www.waze.com/user/editor*
// @grant        none
// @license      MIT
// ==/UserScript==

/* global google */

(function () {
  'use strict';

  const SCRIPT_ID = 'wme-place-assist';
  const SCRIPT_NAME = 'WME Place Assist';
  const VERSION = '2026.11.02.03';
  const LOOKUP_CONCURRENCY = 4;
  const MIN_ZOOM = 17;            // WME only loads places at zoom 17 and closer
  const SCAN_DEBOUNCE_MS = 700;   // wait for the map to settle before scanning
  const POPUP_WIDTH = 300;        // keep in sync with .wpa-popup width in the CSS
  const TOTAL_KEY = 'wme-place-assist.deleted-total';
  const UI_KEY = 'wme-place-assist.ui';             // { minimized, x, y }
  const AUTOSCAN_KEY = 'wme-place-assist.autoscan'; // '0' = off

  // ---------------------------------------------------------------------------
  // 1. Google status lookup
  //    Uses only the Google Maps library WME has already loaded on the page.
  //    This script never loads Google itself and never uses an API key.
  // ---------------------------------------------------------------------------
  const statusCache = new Map(); // placeId -> businessStatus (errors are not cached)

  function googlePlacesAvailable() {
    return !!(window.google && google.maps && google.maps.places && google.maps.places.Place);
  }

  async function lookupBusinessStatus(placeId) {
    if (statusCache.has(placeId)) return statusCache.get(placeId);
    try {
      const place = new google.maps.places.Place({ id: placeId });
      await place.fetchFields({ fields: ['businessStatus'] });
      const status = place.businessStatus || 'UNKNOWN';
      statusCache.set(placeId, status);
      return status;
    } catch (e) {
      return 'ERROR';
    }
  }

  async function mapPool(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
  }

  // ---------------------------------------------------------------------------
  // 2. Finder (no UI): which venues on screen are linked to permanently closed places
  // ---------------------------------------------------------------------------
  function venuePoint(venue) {
    const g = venue.geometry;
    if (!g || !g.coordinates) return null;
    if (g.type === 'Point') return g.coordinates;
    const ring = g.type === 'Polygon' ? g.coordinates[0] : null;
    if (!ring || !ring.length) return null;
    const pts = ring.length > 1 ? ring.slice(0, -1) : ring;
    const lon = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const lat = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    return [lon, lat];
  }

  function inExtent(pt, ext) { // ext = [west, south, east, north]
    return pt[0] >= ext[0] && pt[0] <= ext[2] && pt[1] >= ext[1] && pt[1] <= ext[3];
  }

  // 'remove' = every Google link is permanently closed; 'review' = only some are.
  function classify(statuses) {
    const closed = statuses.filter((s) => s === 'CLOSED_PERMANENTLY').length;
    if (!closed) return null;
    return closed === statuses.length ? 'remove' : 'review';
  }

  async function findClosedOnScreen(sdk) {
    const extent = await sdk.Map.getMapExtent();
    const all = await sdk.DataModel.Venues.getAll();
    const linked = all.filter((v) => v.externalProviderIds && v.externalProviderIds.length)
      .filter((v) => { const p = venuePoint(v); return p && inExtent(p, extent); });

    const placeIds = [...new Set(linked.flatMap((v) => v.externalProviderIds))];
    const statusById = new Map();
    await mapPool(placeIds, LOOKUP_CONCURRENCY, async (id) => {
      statusById.set(id, await lookupBusinessStatus(id));
    });
    const lookupErrors = [...statusById.values()].filter((s) => s === 'ERROR').length;

    const rows = [];
    for (const v of linked) {
      const links = v.externalProviderIds.map((id) => ({ id, status: statusById.get(id) || 'ERROR' }));
      const kind = classify(links.map((l) => l.status));
      if (!kind) continue;
      let canDelete = false;
      try { canDelete = !!(await sdk.DataModel.Venues.hasPermissions({ venueId: v.id })); } catch (e) { /* leave false */ }
      const pt = venuePoint(v);
      rows.push({
        id: v.id,
        name: v.name || '(no name)',
        kind,
        links,
        closedCount: links.filter((l) => l.status === 'CLOSED_PERMANENTLY').length,
        canDelete,
        lockRank: v.lockRank,
        urCount: (v.venueUpdateRequests || []).length,
        lon: pt[0],
        lat: pt[1],
      });
    }
    rows.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'remove' ? -1 : 1));
    return { rows, linkedChecked: linked.length, lookupErrors };
  }

  // ---------------------------------------------------------------------------
  // 3. Actions and storage (no UI)
  // ---------------------------------------------------------------------------
  async function showVenue(sdk, row) {
    await sdk.Editing.setSelection({ selection: { objectType: 'venue', ids: [row.id] } });
    const ext = await sdk.Map.getMapExtent();
    if (!inExtent([row.lon, row.lat], ext)) {
      await sdk.Map.setMapCenter({ lonLat: { lon: row.lon, lat: row.lat } });
    }
  }

  async function stageDeletions(sdk, venueIds) {
    const deleted = [];
    const failed = [];
    for (const venueId of venueIds) {
      try {
        await sdk.DataModel.Venues.deleteVenue({ venueId });
        deleted.push(venueId);
      } catch (e) {
        failed.push({ venueId, error: String((e && e.message) || e) });
      }
    }
    return { deleted, failed };
  }

  // Everything below is stored in this site's localStorage, so beta and production
  // keep separate totals, bar positions and settings.
  function loadJson(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key));
      return v && typeof v === 'object' ? v : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function saveJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
  }

  function loadAutoScan() {
    try { return localStorage.getItem(AUTOSCAN_KEY) !== '0'; } catch (e) { return true; }
  }

  function saveAutoScan(on) {
    try { localStorage.setItem(AUTOSCAN_KEY, on ? '1' : '0'); } catch (e) { /* storage unavailable */ }
  }

  // Running total of places deleted with this tool, counted when the deletion is staged.
  function readTotal() {
    try {
      const n = parseInt(localStorage.getItem(TOTAL_KEY), 10);
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch (e) {
      return 0;
    }
  }

  function addToTotal(count) {
    try { localStorage.setItem(TOTAL_KEY, String(readTotal() + count)); } catch (e) { /* storage unavailable */ }
    return readTotal();
  }

  function resetTotal() {
    try { localStorage.removeItem(TOTAL_KEY); } catch (e) { /* storage unavailable */ }
  }

  // ---------------------------------------------------------------------------
  // 4. Controller: state, scan scheduling, delete. The UI only reads this state.
  // ---------------------------------------------------------------------------
  function createController(sdk) {
    const saved = loadJson(UI_KEY, {});
    const app = {
      rows: [],
      checked: new Set(),
      status: 'idle', // idle | scanning | red | amber | zoom | nogoogle
      message: 'Waiting for the map to settle…',
      minimized: !!saved.minimized,
      autoScan: loadAutoScan(),
      popupOpen: false,
      busy: false,
    };
    const listeners = [];
    const emit = () => listeners.forEach((fn) => fn());
    let timer = null;
    let token = 0;
    let again = false;

    const isPaused = () => app.minimized || !app.autoScan;
    const saveUi = (patch) => saveJson(UI_KEY, { ...loadJson(UI_KEY, {}), ...patch });

    function statusFromRows() {
      if (app.rows.some((r) => r.kind === 'remove')) return 'red';
      return app.rows.length ? 'amber' : 'idle';
    }

    function schedule(delay = SCAN_DEBOUNCE_MS) {
      clearTimeout(timer);
      if (isPaused()) return;
      timer = setTimeout(() => scan(false), delay);
    }

    async function scan(force) {
      if (app.minimized) return;
      if (!force && !app.autoScan) return;
      if (app.busy) { again = true; return; }

      const zoom = await sdk.Map.getZoomLevel();
      if (zoom < MIN_ZOOM) {
        app.rows = []; app.checked.clear(); app.status = 'zoom';
        app.message = `Zoom in to level ${MIN_ZOOM} or closer to scan.`;
        emit();
        return;
      }
      if (!googlePlacesAvailable()) {
        app.status = 'nogoogle';
        app.message = 'The Google Places library is not available on this page, so closed status cannot be checked.';
        emit();
        return;
      }

      app.busy = true; app.status = 'scanning'; emit();
      const myToken = ++token;
      try {
        const result = await findClosedOnScreen(sdk);
        if (myToken === token && !app.minimized) {
          const prev = new Map(app.rows.map((r) => [r.id, app.checked.has(r.id)]));
          app.rows = result.rows;
          // keep the user's earlier choices; new red rows start checked, new amber rows do not
          app.checked = new Set(result.rows
            .filter((r) => r.canDelete && (prev.has(r.id) ? prev.get(r.id) : r.kind === 'remove'))
            .map((r) => r.id));
          const nRemove = result.rows.filter((r) => r.kind === 'remove').length;
          const nReview = result.rows.length - nRemove;
          app.message = result.rows.length
            ? `${nRemove} closed-only, ${nReview} to review.`
            : `Checked ${result.linkedChecked} linked places: none permanently closed.`;
          if (result.lookupErrors) app.message += ` ${result.lookupErrors} lookup(s) failed and will be retried on the next scan.`;
          app.status = statusFromRows();
        }
      } catch (e) {
        app.message = `Scan failed: ${(e && e.message) || e}`;
        app.status = 'idle';
      }
      app.busy = false;
      emit();
      if (again) { again = false; schedule(300); }
    }

    async function deleteChecked() {
      const ids = app.rows.filter((r) => app.checked.has(r.id) && r.canDelete).map((r) => r.id);
      if (!ids.length || app.busy) return;
      app.busy = true; app.message = 'Staging deletions…'; emit();
      const { deleted, failed } = await stageDeletions(sdk, ids);
      app.rows = app.rows.filter((r) => !deleted.includes(r.id));
      deleted.forEach((id) => app.checked.delete(id));
      if (deleted.length) addToTotal(deleted.length);
      let unsaved = '?';
      try { unsaved = await sdk.Editing.getUnsavedChangesCount(); } catch (e) { /* ignore */ }
      app.message = `Staged ${deleted.length} deletion(s)${failed.length ? `, ${failed.length} failed (${failed[0].error})` : ''}. ` +
        `Unsaved changes: ${unsaved}. Save in WME to apply.`;
      app.status = statusFromRows();
      app.busy = false;
      app.popupOpen = false; // list is done once staged; no second click needed
      emit();
      schedule(400); // auto-rescan after a delete
    }

    return {
      app,
      onChange(fn) { listeners.push(fn); },
      schedule,
      scanNow() { return scan(true); },
      deleteChecked,
      show: (row) => showVenue(sdk, row),
      togglePopup() { app.popupOpen = !app.popupOpen; emit(); },
      closePopup() { if (app.popupOpen) { app.popupOpen = false; emit(); } },
      toggleChecked(id, on) { if (on) app.checked.add(id); else app.checked.delete(id); emit(); },
      setAllChecked(on) {
        app.checked = new Set(on ? app.rows.filter((r) => r.canDelete).map((r) => r.id) : []);
        emit();
      },
      setMinimized(on) {
        app.minimized = on;
        saveUi({ minimized: on });
        clearTimeout(timer);
        if (on) { token++; app.popupOpen = false; app.status = 'idle'; again = false; }
        emit();
        if (!on) schedule(150);
      },
      setAutoScan(on) {
        app.autoScan = on;
        saveAutoScan(on);
        emit();
        if (on) schedule(100); else clearTimeout(timer);
      },
      savePosition(x, y) { saveUi({ x, y }); },
      resetPosition() { const u = loadJson(UI_KEY, {}); delete u.x; delete u.y; saveJson(UI_KEY, u); emit(); },
    };
  }

  // ---------------------------------------------------------------------------
  // 5. UI: floating bar + popup, minimized button, sidebar tab
  // ---------------------------------------------------------------------------
  const CSS = `
    .wpa-bar { position: fixed; z-index: 999990; display: flex; align-items: center; gap: 4px; padding: 3px 6px 3px 2px;
      background: #fff; border-radius: 10px; box-shadow: 0 3px 12px rgba(0,0,0,.35); color: #333; user-select: none;
      font: 13px/1.3 "Rubik", "Helvetica Neue", Arial, sans-serif; }
    .wpa-grip { cursor: grab; padding: 4px; color: #999; font-size: 16px; line-height: 1; touch-action: none; }
    .wpa-grip:active { cursor: grabbing; }
    .wpa-status { position: relative; width: 34px; height: 34px; padding: 0; border-radius: 50%; border: 2px solid #c4c8cc;
      background: #fff; color: #6b7280; display: flex; align-items: center; justify-content: center; cursor: pointer; }
    .wpa-status.red { border-color: #d93025; color: #d93025; }
    .wpa-status.amber { border-color: #f29900; color: #c77700; }
    .wpa-status.scanning { border-color: #5f6c7b; animation: wpa-pulse 1.2s ease-out infinite; }
    @keyframes wpa-pulse { 0% { box-shadow: 0 0 0 0 rgba(95,108,123,.55); } 100% { box-shadow: 0 0 0 9px rgba(95,108,123,0); } }
    .wpa-badge { position: absolute; top: -6px; right: -6px; min-width: 16px; height: 16px; padding: 0 3px; border-radius: 8px;
      box-sizing: border-box; background: #d93025; color: #fff; font-size: 10px; font-weight: 700; line-height: 16px; text-align: center; display: none; }
    .wpa-status.amber .wpa-badge { background: #f29900; }
    .wpa-min { border: 0; background: none; cursor: pointer; font-size: 18px; line-height: 1; color: #666; padding: 2px 6px; }
    .wpa-popup { position: absolute; left: 0; top: calc(100% + 6px); width: 300px; max-height: 50vh; overflow: auto; box-sizing: border-box;
      background: #fff; border-radius: 10px; box-shadow: 0 3px 12px rgba(0,0,0,.35); padding: 8px; display: none; user-select: text; }
    .wpa-bar.open .wpa-popup { display: block; }
    .wpa-bar.up .wpa-popup { top: auto; bottom: calc(100% + 6px); }
    .wpa-bar.flip .wpa-popup { left: auto; right: 0; }
    .wpa-head { font-weight: 600; margin-bottom: 2px; }
    .wpa-msg { color: #555; margin-bottom: 6px; }
    .wpa-row { display: flex; align-items: flex-start; gap: 6px; padding: 4px 2px; border-top: 1px solid #eee; }
    .wpa-dot { flex: none; width: 9px; height: 9px; margin-top: 5px; border-radius: 50%; background: #d93025; }
    .wpa-row.review .wpa-dot { background: #f29900; }
    .wpa-name { background: none; border: 0; padding: 0; color: #0366d6; text-align: left; cursor: pointer; font-size: 13px; }
    .wpa-meta { color: #666; font-size: 11px; }
    .wpa-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; padding-top: 6px; border-top: 1px solid #eee; }
    .wpa-btn { cursor: pointer; padding: 3px 10px; }
    .wpa-del { cursor: pointer; padding: 4px 12px; border: 0; border-radius: 6px; background: #d93025; color: #fff; font-weight: 600; }
    .wpa-del:disabled { background: #c4c8cc; cursor: default; }
    .wpa-fab { position: relative; width: 40px; height: 40px; border-radius: 50%; background: #fff; color: #6b7280;
      box-shadow: 0 2px 6px rgba(0,0,0,.3); display: none; align-items: center; justify-content: center; cursor: pointer; }
    .wpa-fab.show { display: flex; }
    .wpa-fab.floating { position: fixed; right: 12px; top: 60%; z-index: 999990; }
    .wpa-side { padding: 8px; font-size: 13px; }
    .wpa-side > div, .wpa-side > label { margin-bottom: 8px; display: block; }
    .wpa-side-title { font-weight: 600; }
    .wpa-side button { cursor: pointer; padding: 2px 8px; margin-left: 4px; }
    .wpa-version { color: #999; font-size: 10px; }
  `;

  // Storefront with a closed slash. Color comes from the surrounding state class.
  const ICON = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4.5 4.5h15L21 10M4.5 4.5 3 10"/>
      <path d="M3 10a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/>
      <path d="M5 12.6V20h14v-7.4"/>
      <path d="M10 20v-4.5h4V20"/>
      <path d="M4 3.5 20 20.5" stroke="#fff" stroke-width="4.4"/>
      <path d="M4 3.5 20 20.5" stroke-width="2"/>
    </svg>`;

  function iconNode() {
    const span = document.createElement('span');
    span.style.display = 'flex';
    span.innerHTML = ICON; // static markup defined above, no page data
    return span;
  }

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k in node) node[k] = v;
      else node.setAttribute(k, v);
    }
    children.forEach((c) => { if (c) node.append(c); });
    return node;
  }

  function createBar(ctrl) {
    const app = ctrl.app;
    const badge = el('span', { class: 'wpa-badge' });
    const statusBtn = el('button', { class: 'wpa-status', type: 'button', onclick: () => ctrl.togglePopup() }, iconNode(), badge);
    const grip = el('span', { class: 'wpa-grip', text: '⋮', title: 'Drag to move' });
    const minBtn = el('button', { class: 'wpa-min', type: 'button', text: '−', title: 'Minimize (pauses scanning)', onclick: () => ctrl.setMinimized(true) });
    const popup = el('div', { class: 'wpa-popup' });
    const bar = el('div', { class: 'wpa-bar', id: 'wme-place-assist-bar' }, grip, statusBtn, minBtn, popup);

    function place() {
      const saved = loadJson(UI_KEY, {});
      const w = bar.offsetWidth || 120;
      const h = bar.offsetHeight || 40;
      const x = Number.isFinite(saved.x) ? saved.x : window.innerWidth - w - 90;
      const y = Number.isFinite(saved.y) ? saved.y : 52;
      bar.style.left = `${Math.min(Math.max(0, x), Math.max(0, window.innerWidth - w))}px`;
      bar.style.top = `${Math.min(Math.max(0, y), Math.max(0, window.innerHeight - h))}px`;
    }

    // Open the popup upward when the bar is in the lower half, and align it to the
    // bar's right edge when it would otherwise run off the right side of the window.
    function orient() {
      const r = bar.getBoundingClientRect();
      bar.classList.toggle('up', r.top > window.innerHeight / 2);
      bar.classList.toggle('flip', r.left + POPUP_WIDTH > window.innerWidth - 8 && r.right - POPUP_WIDTH >= 8);
    }

    grip.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      grip.setPointerCapture(ev.pointerId);
      const startX = ev.clientX;
      const startY = ev.clientY;
      const r = bar.getBoundingClientRect();
      const move = (e) => {
        bar.style.left = `${Math.min(Math.max(0, r.left + e.clientX - startX), Math.max(0, window.innerWidth - r.width))}px`;
        bar.style.top = `${Math.min(Math.max(0, r.top + e.clientY - startY), Math.max(0, window.innerHeight - r.height))}px`;
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        ctrl.savePosition(parseFloat(bar.style.left), parseFloat(bar.style.top));
        orient();
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
    });

    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') ctrl.closePopup(); });

    function tooltip(count) {
      if (app.status === 'red') return `${count} closed place(s) to delete. Click to review.`;
      if (app.status === 'amber') return `${count} place(s) with a closed Google link. Click to review.`;
      if (app.status === 'scanning') return 'Scanning…';
      if (app.status === 'zoom') return `Zoom in to level ${MIN_ZOOM} or closer to scan`;
      if (app.status === 'nogoogle') return 'Google Places library not available';
      if (!app.autoScan) return 'Auto-scan is off. Click to scan now.';
      return 'No closed places on screen';
    }

    function renderPopup() {
      const selected = app.rows.filter((r) => app.checked.has(r.id)).length;
      const deletable = app.rows.filter((r) => r.canDelete);
      const allChecked = deletable.length > 0 && deletable.every((r) => app.checked.has(r.id));

      const rows = app.rows.map((r) => {
        const tags = r.kind === 'review' ? [`${r.closedCount} of ${r.links.length} Google links closed`] : [];
        tags.push(`L${(r.lockRank || 0) + 1}`);
        if (r.urCount) tags.push(`${r.urCount} UR`);
        if (!r.canDelete) tags.push('no permission');
        return el('div', { class: `wpa-row ${r.kind}` },
          el('input', { type: 'checkbox', checked: app.checked.has(r.id), disabled: app.busy || !r.canDelete, onchange: (ev) => ctrl.toggleChecked(r.id, ev.target.checked) }),
          el('span', { class: 'wpa-dot' }),
          el('div', {},
            el('button', { class: 'wpa-name', type: 'button', text: r.name, title: r.links.map((l) => l.status).join(', '), onclick: () => ctrl.show(r) }),
            el('div', { class: 'wpa-meta', text: tags.join(' · ') })));
      });

      const foot = app.rows.length && el('div', { class: 'wpa-foot' },
        el('label', {},
          el('input', { type: 'checkbox', checked: allChecked, disabled: app.busy, onchange: (ev) => ctrl.setAllChecked(ev.target.checked) }),
          document.createTextNode(' Select all')),
        el('button', { class: 'wpa-del', type: 'button', text: selected ? `Delete ${selected}` : 'Delete', disabled: app.busy || !selected, onclick: () => ctrl.deleteChecked() }));

      const scanNow = !app.autoScan && el('button', { class: 'wpa-btn', type: 'button', text: 'Scan now', disabled: app.busy, onclick: () => ctrl.scanNow() });

      popup.replaceChildren(...[
        el('div', { class: 'wpa-head', text: 'Closed places on screen' }),
        el('div', { class: 'wpa-msg', text: app.message }),
        scanNow,
        ...rows,
        foot,
      ].filter(Boolean));
    }

    function render() {
      bar.style.display = app.minimized ? 'none' : 'flex';
      const count = app.status === 'red' ? app.rows.filter((r) => r.kind === 'remove').length : app.status === 'amber' ? app.rows.length : 0;
      statusBtn.className = `wpa-status ${['red', 'amber', 'scanning'].includes(app.status) ? app.status : ''}`;
      statusBtn.title = tooltip(count);
      badge.textContent = String(count);
      badge.style.display = count ? 'block' : 'none';
      bar.classList.toggle('open', app.popupOpen && !app.minimized);
      if (app.popupOpen) renderPopup();
      place();
      orient();
    }

    return { element: bar, render, place };
  }

  // Minimized state: a round 40px button appended to WME's right-hand button column,
  // the same way the other floating-tool scripts do it.
  function createFab(ctrl) {
    const fab = el('div', { id: 'wme-place-assist-fab', class: 'wpa-fab', title: 'Place Assist is paused. Click to open and resume scanning.', onclick: () => ctrl.setMinimized(false) }, iconNode());
    const findColumn = () => document.querySelector('#overlay-buttons .overlay-buttons-container.top') || document.querySelector('.overlay-buttons-container.top');

    function mount() {
      const col = findColumn();
      if (col && (!fab.isConnected || fab.classList.contains('floating'))) {
        fab.classList.remove('floating');
        col.appendChild(fab);
      } else if (!col && !fab.isConnected) {
        fab.classList.add('floating'); // fallback if WME's column is not there
        document.body.appendChild(fab);
      }
    }

    function render() {
      mount();
      fab.classList.toggle('show', ctrl.app.minimized);
    }

    return { render };
  }

  function createSidebar(ctrl, pane) {
    const app = ctrl.app;
    const root = el('div', { class: 'wpa-side' });
    pane.append(root);
    let confirmReset = false;

    function render() {
      const totalLine = el('div', {},
        el('span', { text: `Deleted with Place Assist: ${readTotal()} (this site)` }),
        confirmReset
          ? el('span', {},
            document.createTextNode(' Reset to 0?'),
            el('button', { type: 'button', text: 'Yes', onclick: () => { resetTotal(); confirmReset = false; render(); } }),
            el('button', { type: 'button', text: 'Cancel', onclick: () => { confirmReset = false; render(); } }))
          : el('button', { type: 'button', text: 'Reset', onclick: () => { confirmReset = true; render(); } }));

      root.replaceChildren(
        el('div', { class: 'wpa-side-title', text: 'Place Assist' }),
        el('label', {},
          el('input', { type: 'checkbox', checked: app.autoScan, onchange: (ev) => ctrl.setAutoScan(ev.target.checked) }),
          document.createTextNode(' Auto-scan for closed places (paused while the bar is minimized)')),
        totalLine,
        el('div', {}, el('button', { type: 'button', text: 'Reset bar position', onclick: () => ctrl.resetPosition() })),
        el('div', { class: 'wpa-version', text: `${SCRIPT_NAME} v${VERSION}` }));
    }

    return { render };
  }

  // ---------------------------------------------------------------------------
  // 6. Bootstrap (SDK async mode)
  // ---------------------------------------------------------------------------
  async function init() {
    const sdk = await window.getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME, mode: 'async' });
    if (!(await sdk.State.isReady())) await sdk.Events.once({ eventName: 'wme-ready' });

    document.head.appendChild(el('style', { text: CSS }));
    const ctrl = createController(sdk);
    const bar = createBar(ctrl);
    const fab = createFab(ctrl);
    document.body.appendChild(bar.element);

    [bar.render, fab.render].forEach((fn) => ctrl.onChange(fn));
    bar.render(); fab.render();
    window.addEventListener('resize', bar.place);

    // The sidebar tab is secondary: if it cannot be registered, the bar still works.
    try {
      const { tabLabel, tabPane } = await sdk.Sidebar.registerScriptTab();
      tabLabel.textContent = 'Place Assist';
      tabLabel.title = SCRIPT_NAME;
      const side = createSidebar(ctrl, tabPane);
      ctrl.onChange(side.render);
      side.render();
    } catch (e) {
      console.warn(`${SCRIPT_NAME}: sidebar tab not available`, e);
    }

    // The map fires several data-loaded events per pan, so everything funnels into one debounced scan.
    for (const eventName of ['wme-map-move-end', 'wme-map-data-loaded', 'wme-map-zoom-changed']) {
      await sdk.Events.on({ eventName, eventHandler: () => ctrl.schedule() });
    }
    // After a save, the staged deletions are final: dismiss the popup and rescan.
    try {
      await sdk.Events.on({ eventName: 'wme-save-finished', eventHandler: () => { ctrl.closePopup(); ctrl.schedule(1200); } });
    } catch (e) { console.warn(`${SCRIPT_NAME}: save event not available`, e); }
    ctrl.schedule(800);
    console.log(`${SCRIPT_NAME} v${VERSION} loaded`);
  }

  function bootstrap() {
    if (window.SDK_INITIALIZED && window.getWmeSdk) {
      window.SDK_INITIALIZED.then(init).catch((e) => console.error(`${SCRIPT_NAME} failed to start`, e));
    } else {
      setTimeout(bootstrap, 250);
    }
  }

  bootstrap();
})();
