// ==UserScript==
// @name         WME Place Assist
// @namespace    https://github.com/TxAgBQ
// @version      2026.11.01.01
// @description  Finds Waze places on screen whose linked Google places are permanently closed, and stages their deletion in bulk.
// @author       TxAgBQ
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
  const VERSION = '2026.11.01.01';
  const LOOKUP_CONCURRENCY = 4;

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

  async function findClosedOnScreen(sdk, onProgress) {
    const extent = await sdk.Map.getMapExtent();
    const all = await sdk.DataModel.Venues.getAll();
    const linked = all.filter((v) => v.externalProviderIds && v.externalProviderIds.length)
      .filter((v) => { const p = venuePoint(v); return p && inExtent(p, extent); });

    const placeIds = [...new Set(linked.flatMap((v) => v.externalProviderIds))];
    const statusById = new Map();
    let done = 0;
    await mapPool(placeIds, LOOKUP_CONCURRENCY, async (id) => {
      statusById.set(id, await lookupBusinessStatus(id));
      if (onProgress) onProgress(++done, placeIds.length);
    });

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
    return { rows, linkedChecked: linked.length };
  }

  // ---------------------------------------------------------------------------
  // 3. Actions (no UI): select/center and stage deletions
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

  // ---------------------------------------------------------------------------
  // 4. Sidebar UI
  // ---------------------------------------------------------------------------
  const CSS = `
    .wpa { font-size: 13px; padding: 8px; }
    .wpa-title { font-weight: 600; margin-bottom: 6px; }
    .wpa-bar { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
    .wpa-bar button, .wpa-confirm button { cursor: pointer; padding: 3px 8px; }
    .wpa-bar button:disabled { cursor: default; opacity: 0.5; }
    .wpa-status { margin: 6px 0; color: #555; }
    .wpa-confirm { margin: 6px 0; padding: 6px; border: 1px solid #c0392b; border-radius: 4px; background: #fdecea; }
    .wpa-row { display: flex; align-items: flex-start; gap: 6px; padding: 4px 2px; border-bottom: 1px solid #e5e5e5; }
    .wpa-row.remove { background: #fdf3f2; }
    .wpa-row.review { background: #fff8e1; }
    .wpa-name { background: none; border: 0; padding: 0; color: #0366d6; text-align: left; cursor: pointer; font-size: 13px; }
    .wpa-meta { color: #666; font-size: 11px; }
    .wpa-version { margin-top: 8px; color: #999; font-size: 10px; }
  `;

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

  function buildUi(sdk, pane) {
    const state = { rows: [], checked: new Set(), confirm: null, busy: false, message: 'Pan/zoom to an area, then press Scan screen.' };
    const root = el('div', { class: 'wpa' });
    pane.append(el('style', { text: CSS }), root);

    const removeRows = () => state.rows.filter((r) => r.kind === 'remove' && r.canDelete);

    async function scan() {
      if (state.busy) return;
      if (!googlePlacesAvailable()) {
        state.message = 'Google Places library is not available on this page, so closed status cannot be checked.';
        return render();
      }
      state.busy = true; state.confirm = null; state.message = 'Scanning…'; render();
      try {
        const { rows, linkedChecked } = await findClosedOnScreen(sdk, (done, total) => {
          state.message = `Checking Google places… ${done}/${total}`; render();
        });
        state.rows = rows;
        state.checked = new Set(rows.filter((r) => r.kind === 'remove' && r.canDelete).map((r) => r.id));
        const nRemove = rows.filter((r) => r.kind === 'remove').length;
        const nReview = rows.length - nRemove;
        state.message = rows.length
          ? `Checked ${linkedChecked} linked places: ${nRemove} closed-only, ${nReview} to review.`
          : `Checked ${linkedChecked} linked places: none permanently closed.`;
      } catch (e) {
        state.message = `Scan failed: ${(e && e.message) || e}`;
      }
      state.busy = false; render();
    }

    async function runDelete() {
      const ids = state.confirm.ids;
      state.busy = true; state.confirm = null; state.message = 'Staging deletions…'; render();
      const { deleted, failed } = await stageDeletions(sdk, ids);
      state.rows = state.rows.filter((r) => !deleted.includes(r.id));
      deleted.forEach((id) => state.checked.delete(id));
      let unsaved = '?';
      try { unsaved = await sdk.Editing.getUnsavedChangesCount(); } catch (e) { /* ignore */ }
      state.message = `Staged ${deleted.length} deletion(s)${failed.length ? `, ${failed.length} failed (${failed[0].error})` : ''}. ` +
        `Unsaved changes: ${unsaved}. Save in WME to apply.`;
      state.busy = false; render();
    }

    function render() {
      const selectedIds = state.rows.filter((r) => state.checked.has(r.id)).map((r) => r.id);
      const closedOnly = removeRows();
      const bar = el('div', { class: 'wpa-bar' },
        el('button', { text: 'Scan screen', disabled: state.busy, onclick: scan }),
        el('button', { text: 'Select all', disabled: state.busy || !state.rows.length, onclick: () => { state.rows.filter((r) => r.canDelete).forEach((r) => state.checked.add(r.id)); render(); } }),
        el('button', { text: 'Select none', disabled: state.busy || !state.rows.length, onclick: () => { state.checked.clear(); render(); } }),
        el('button', { text: `Delete selected (${selectedIds.length})`, disabled: state.busy || !selectedIds.length, onclick: () => { state.confirm = { ids: selectedIds }; render(); } }),
        el('button', { text: `Delete all closed-only (${closedOnly.length})`, disabled: state.busy || !closedOnly.length, onclick: () => { state.confirm = { ids: closedOnly.map((r) => r.id) }; render(); } }),
      );

      const confirmBox = state.confirm && el('div', { class: 'wpa-confirm' },
        el('div', { text: `Delete ${state.confirm.ids.length} place(s)? This only stages the deletion; nothing is final until you save in WME.` }),
        el('div', { class: 'wpa-bar' },
          el('button', { text: 'Confirm delete', onclick: runDelete }),
          el('button', { text: 'Cancel', onclick: () => { state.confirm = null; render(); } })));

      const list = state.rows.map((r) => {
        const total = r.links.length;
        const meta = r.kind === 'remove'
          ? `All ${total} Google link${total > 1 ? 's' : ''} permanently closed`
          : `Review: ${r.closedCount} of ${total} Google links closed`;
        const tags = [`L${(r.lockRank || 0) + 1}`];
        if (r.urCount) tags.push(`${r.urCount} UR`);
        if (!r.canDelete) tags.push('no permission');
        return el('div', { class: `wpa-row ${r.kind}` },
          el('input', {
            type: 'checkbox', checked: state.checked.has(r.id), disabled: state.busy || !r.canDelete,
            onchange: (ev) => { if (ev.target.checked) state.checked.add(r.id); else state.checked.delete(r.id); render(); },
          }),
          el('div', {},
            el('button', { class: 'wpa-name', text: r.name, title: r.links.map((l) => l.status).join(', '), onclick: () => showVenue(sdk, r) }),
            el('div', { class: 'wpa-meta', text: `${meta} · ${tags.join(' · ')}` })));
      });

      root.replaceChildren(...[
        el('div', { class: 'wpa-title', text: 'Closed places on screen' }),
        bar,
        confirmBox,
        el('div', { class: 'wpa-status', text: state.message }),
        ...list,
        el('div', { class: 'wpa-version', text: `${SCRIPT_NAME} v${VERSION}` }),
      ].filter(Boolean));
    }

    render();
  }

  // ---------------------------------------------------------------------------
  // 5. Bootstrap (SDK async mode)
  // ---------------------------------------------------------------------------
  async function init() {
    const sdk = await window.getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME, mode: 'async' });
    if (!(await sdk.State.isReady())) await sdk.Events.once({ eventName: 'wme-ready' });
    const { tabLabel, tabPane } = await sdk.Sidebar.registerScriptTab();
    tabLabel.textContent = 'Place Assist';
    tabLabel.title = SCRIPT_NAME;
    buildUi(sdk, tabPane);
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
