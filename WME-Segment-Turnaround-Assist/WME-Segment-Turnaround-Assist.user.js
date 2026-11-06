// ==UserScript==
// @name         WME Segment Turnaround Assist
// @namespace    https://github.com/TxAgBQ/Scripts
// @version      2026.11.06.05
// @description  Finds Texas segments named "Turnaround" and matches them to the frontage road (road type, lock, +1 routing). Review a checklist, apply, then save in WME yourself.
// @author       TxAgBQ
// @match        https://www.waze.com/editor*
// @match        https://www.waze.com/*/editor*
// @match        https://beta.waze.com/editor*
// @match        https://beta.waze.com/*/editor*
// @exclude      https://www.waze.com/user/editor*
// @exclude      https://beta.waze.com/user/editor*
// @grant        none
// @run-at       document-end
// @downloadURL  https://raw.githubusercontent.com/TxAgBQ/Scripts/main/WME-Segment-Turnaround-Assist/WME-Segment-Turnaround-Assist.user.js
// @updateURL    https://raw.githubusercontent.com/TxAgBQ/Scripts/main/WME-Segment-Turnaround-Assist/WME-Segment-Turnaround-Assist.user.js
// ==/UserScript==

/* global getWmeSdk, SDK_INITIALIZED */

/*
 * WME Segment Turnaround Assist
 *
 * What it does
 *   - Looks at segments in the visible part of the map whose primary street is "Turnaround" and whose state is Texas.
 *     Several Turnaround segments in a row are handled as ONE turnaround (one row, one checkbox).
 *   - The frontage road is the NAMED segments at the two outer ends of the turnaround. Names may differ
 *     per end (I-10 W Frontage Rd / I-10 E Frontage Rd, Grand Pkwy, ...). Unnamed segments there are
 *     at grade connectors and are ignored.
 *   - All of those frontage segments must be the same highway type (Minor or Major Highway).
 *     Anything else is listed as "needs review" and never changed.
 *   - A turnaround needs fixing when its road type differs from the frontage road, its lock is
 *     below the lock goal, or its routing differs from the +1 routing that every named frontage segment shares.
 *   - Lock goal is L5, or the editor's own maximum rank if that is lower. It never lowers a lock.
 *   - Apply changes the checked rows only, then closes the list. It does NOT save; you save in WME.
 *
 * Look and feel copies WME Place Assist / WME Segment Importer: a draggable top-bar card with a
 * round status button, and when minimized a round icon in the right-hand stack of map buttons.
 *
 * SDK notes (all verified in the console before writing this)
 *   - Uses getWmeSdk({ ..., mode: 'async' }) only. No W.*, no OpenLayers, no sync mode.
 *   - Lock ranks are zero-based in the SDK: lockRank 2 = L3, 3 = L4, 4 = L5.
 *   - updateSegment throws "Failed to update segment" when nothing would change, and
 *     routingRoadType cannot be set to null, so only changed fields are ever sent.
 *   - Segments.getConnectedSegments is direction aware, so neighbors come from
 *     Nodes.getById(...).connectedSegmentIds on both ends instead.
 */

(function () {
    'use strict';

    const SCRIPT_ID = 'wme-segment-turnaround-assist';
    const SCRIPT_NAME = 'WME Segment Turnaround Assist';
    const VERSION = '2026.11.06.05'; // keep in sync with @version
    const LOG = '[WSTA]';

    const CFG = {
        streetName: 'turnaround',       // compared case-insensitively against the primary street name
        stateName: 'Texas',
        typeNames: { 6: 'Major Hwy', 7: 'Minor Hwy' },
        allowedTypes: [6, 7],           // frontage road types we are willing to copy
        targetLockRank: 4,              // zero-based: 4 = L5. Capped to the editor's own rank.
        rescanDelayMs: 500,
        noteMs: 20000,                  // how long the "Applied..." note stays in the button tooltip
    };

    // ---------- small helpers ----------
    const store = {
        get(key, fallback) {
            try {
                const v = localStorage.getItem('wsta.' + key);
                return v === null ? fallback : JSON.parse(v);
            } catch (e) { return fallback; }
        },
        set(key, value) {
            try { localStorage.setItem('wsta.' + key, JSON.stringify(value)); } catch (e) { /* storage can be unavailable */ }
        },
    };

    const typeName = (t) => CFG.typeNames[t] || ('type ' + t);

    let sdk = null;
    let turnStreetIds = new Set();
    let userRank = 0;
    let results = [];
    let excluded = new Set(store.get('excluded', []));
    let scanning = false;
    let dirty = false;
    let scanTimer = null;
    let applying = false;
    let note = { text: '', until: 0 };
    const ui = {};

    // ---------- SDK start-up ----------
    function waitForSdk() {
        return new Promise((resolve) => {
            const ready = () => {
                if (window.getWmeSdk && window.SDK_INITIALIZED) {
                    window.SDK_INITIALIZED.then(resolve);
                    return true;
                }
                return false;
            };
            if (ready()) return;
            const timer = setInterval(() => { if (ready()) clearInterval(timer); }, 250);
        });
    }

    async function init() {
        await waitForSdk();
        sdk = window.getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME, mode: 'async' });
        try { await sdk.Events.waitForWmeReady(); } catch (e) { console.warn(LOG, 'waitForWmeReady failed', e); }
        buildUi();
        registerEvents();
        scheduleScan(300);
        console.log(LOG, SCRIPT_NAME + ' v' + VERSION + ' loaded');
    }

    function registerEvents() {
        const names = [
            'wme-map-move-end',
            'wme-map-zoom-changed',
            'wme-map-data-loaded',
            'wme-after-edit',
            'wme-after-undo',
            'wme-save-finished',
        ];
        for (const eventName of names) {
            try {
                sdk.Events.on({ eventName, eventHandler: () => scheduleScan() });
            } catch (e) {
                console.warn(LOG, 'could not register', eventName, e);
            }
        }
    }

    // ---------- scanning ----------
    function scheduleScan(delay) {
        clearTimeout(scanTimer);
        scanTimer = setTimeout(runScan, delay === undefined ? CFG.rescanDelayMs : delay);
    }

    async function runScan() {
        if (scanning) { dirty = true; return; }
        scanning = true;
        try {
            results = await scan();
            render();
        } catch (e) {
            console.error(LOG, 'scan failed', e);
        } finally {
            scanning = false;
            if (dirty) { dirty = false; scheduleScan(); }
        }
    }

    function boxIntersects(geometry, ext) {
        if (!geometry || !Array.isArray(geometry.coordinates) || !Array.isArray(ext) || ext.length < 4) return true;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const c of geometry.coordinates) {
            if (c[0] < minX) minX = c[0];
            if (c[0] > maxX) maxX = c[0];
            if (c[1] < minY) minY = c[1];
            if (c[1] > maxY) maxY = c[1];
        }
        return !(maxX < ext[0] || minX > ext[2] || maxY < ext[1] || minY > ext[3]);
    }

    // The area you can actually see. Map.getMapExtent() runs about a sidebar-width past the right edge of the
    // screen, so it would list turnarounds that are off screen. Use the viewport element's real corners instead.
    async function visibleBox() {
        try {
            const r = (await sdk.Map.getMapViewportElement()).getBoundingClientRect();
            const tl = await sdk.Map.getLonLatFromPixel({ x: Math.max(r.left, 0), y: Math.max(r.top, 0) });
            const br = await sdk.Map.getLonLatFromPixel({ x: Math.min(r.right, window.innerWidth), y: Math.min(r.bottom, window.innerHeight) });
            return [tl.lon, br.lat, br.lon, tl.lat]; // [minLon, minLat, maxLon, maxLat]
        } catch (e) {
            console.warn(LOG, 'visibleBox fallback to getMapExtent', e);
            return sdk.Map.getMapExtent();
        }
    }

    // Street names are cached for one scan / one apply so we do not ask the SDK twice.
    const nameCache = new Map();
    async function streetNameOf(seg) {
        const sid = seg.primaryStreetId;
        if (sid === null || sid === undefined) return '';
        if (!nameCache.has(sid)) {
            const st = await sdk.DataModel.Streets.getById({ streetId: sid });
            nameCache.set(sid, st && st.name ? st.name.trim() : '');
        }
        return nameCache.get(sid);
    }

    // A turnaround can be several Turnaround segments in a row. Collect the whole chain.
    async function collectChain(seed, seen) {
        const members = [];
        const queue = [seed];
        seen.add(seed.id);
        while (queue.length) {
            const seg = queue.shift();
            members.push(seg);
            for (const key of ['fromNodeId', 'toNodeId']) {
                const node = await sdk.DataModel.Nodes.getById({ nodeId: seg[key] });
                for (const sid of (node && node.connectedSegmentIds) || []) {
                    if (seen.has(sid)) continue;
                    const other = await sdk.DataModel.Segments.getById({ segmentId: sid });
                    if (other && turnStreetIds.has(other.primaryStreetId)) {
                        seen.add(sid);
                        queue.push(other);
                    }
                }
            }
        }
        members.sort((a, b) => a.id - b.id);
        return members;
    }

    async function loadMembers(ids) {
        const list = [];
        for (const id of ids) {
            const s = await sdk.DataModel.Segments.getById({ segmentId: id });
            if (!s) return null;
            list.push(s);
        }
        return list;
    }

    async function scan() {
        nameCache.clear();
        const streets = await sdk.DataModel.Streets.getAll();
        turnStreetIds = new Set(
            streets.filter((s) => s && s.name && s.name.trim().toLowerCase() === CFG.streetName).map((s) => s.id)
        );
        if (!turnStreetIds.size) return [];

        const me = await sdk.State.getUserInfo();
        userRank = me && typeof me.rank === 'number' ? me.rank : 0;

        const ext = await visibleBox();
        const segments = await sdk.DataModel.Segments.getAll();
        const seen = new Set();
        const found = [];
        for (const seed of segments) {
            if (!turnStreetIds.has(seed.primaryStreetId) || seen.has(seed.id)) continue;
            if (!boxIntersects(seed.geometry, ext)) continue;
            const members = await collectChain(seed, seen);
            let allTexas = true;
            for (const m of members) {
                const addr = await sdk.DataModel.Segments.getAddress({ segmentId: m.id });
                if (!addr || !addr.state || addr.state.name !== CFG.stateName) { allTexas = false; break; }
            }
            if (!allTexas) continue;
            found.push(await evaluateGroup(members));
        }
        const order = { fix: 0, review: 1, ok: 2 };
        found.sort((a, b) => order[a.status] - order[b.status] || a.key - b.key);
        return found;
    }

    // ---------- the rules ----------
    function review(res, text) {
        res.status = 'review';
        res.note = text;
        return res;
    }

    // One result per turnaround (a single segment, or a chain of Turnaround segments).
    async function evaluateGroup(members) {
        const ids = members.map((m) => m.id);
        const res = { key: Math.min(...ids), ids, status: 'ok', note: '', perSegment: [], summary: '' };

        // The two outer ends of the chain: nodes touched by exactly one segment of the chain.
        const touch = new Map();
        for (const m of members) {
            for (const k of ['fromNodeId', 'toNodeId']) touch.set(m[k], (touch.get(m[k]) || 0) + 1);
        }
        const endNodes = [...touch].filter(([, count]) => count === 1).map(([nodeId]) => nodeId);
        if (endNodes.length < 2) return review(res, 'Could not find two ends for this turnaround.');

        // Frontage road = NAMED segments at the outer ends. Unnamed ones are at grade connectors; ignore them.
        const idSet = new Set(ids);
        const neighbors = [];
        for (const nodeId of endNodes) {
            const node = await sdk.DataModel.Nodes.getById({ nodeId });
            const here = [];
            for (const sid of (node && node.connectedSegmentIds) || []) {
                if (idSet.has(sid)) continue;
                const other = await sdk.DataModel.Segments.getById({ segmentId: sid });
                if (!other) return review(res, 'A connected segment is not loaded. Pan or zoom and it will rescan.');
                if (turnStreetIds.has(other.primaryStreetId)) continue;
                if (!(await streetNameOf(other))) continue;
                here.push(other);
            }
            if (!here.length) return review(res, 'No named frontage road segment at one end.');
            neighbors.push(...here);
        }

        const types = new Set(neighbors.map((n) => n.roadType));
        if (types.size !== 1 || !CFG.allowedTypes.includes([...types][0])) {
            const found = [...types].map(typeName).join(' / ');
            return review(res, 'Ends disagree or are not Minor/Major Highway (found: ' + found + ').');
        }
        const targetType = [...types][0];

        // Lock goal: L5, or this editor's own maximum if lower.
        const lockGoal = Math.min(CFG.targetLockRank, userRank);

        // +1 routing is copied only when every named frontage segment has the same one.
        const routes = new Set(neighbors.map((n) => n.routingRoadType));
        const targetRoute = routes.size === 1 ? [...routes][0] : null;
        const copyRoute = targetRoute !== null && targetRoute !== undefined && targetRoute !== targetType;

        for (const seg of members) {
            const changes = {};
            if (seg.roadType !== targetType) changes.roadType = targetType;
            if (seg.lockRank < lockGoal) changes.lockRank = lockGoal;
            if (copyRoute && seg.routingRoadType !== targetRoute) changes.routingRoadType = targetRoute;
            if (Object.keys(changes).length) res.perSegment.push({ id: seg.id, changes });
        }

        if (!res.perSegment.length) {
            res.summary = 'Already matches';
            return res;
        }

        const parts = [];
        if (res.perSegment.some((p) => p.changes.roadType !== undefined)) parts.push('Type: ' + typeName(targetType));
        if (res.perSegment.some((p) => p.changes.lockRank !== undefined)) {
            parts.push('Lock: L' + (lockGoal + 1) + (lockGoal < CFG.targetLockRank ? ' (your max)' : ''));
        }
        if (res.perSegment.some((p) => p.changes.routingRoadType !== undefined)) parts.push('Routing: ' + typeName(targetRoute));
        res.summary = (ids.length > 1 ? ids.length + ' segments · ' : '') + parts.join(' · ');

        // All or nothing: if any segment of the chain is not editable, flag the whole thing.
        for (const p of res.perSegment) {
            const allowed = await sdk.DataModel.Segments.hasPermissions({ segmentId: p.id });
            if (!allowed) return review(res, 'You cannot edit segment ' + p.id + ' (' + res.summary + ' needed).');
        }

        res.status = 'fix';
        return res;
    }

    // ---------- applying (never saves) ----------
    async function applyGroup(ids) {
        nameCache.clear();
        const members = await loadMembers(ids);
        if (!members) throw new Error('segment not loaded');
        const res = await evaluateGroup(members);
        if (res.status !== 'fix') return { skipped: true, note: res.status === 'ok' ? 'already matches' : res.note };

        for (const p of res.perSegment) {
            await sdk.DataModel.Segments.updateSegment({ segmentId: p.id, ...p.changes });
        }

        // Verify; if a field did not stick, retry the leftovers one at a time.
        let again = await evaluateGroup(await loadMembers(ids));
        if (again.status === 'fix') {
            for (const p of again.perSegment) {
                for (const [field, value] of Object.entries(p.changes)) {
                    try { await sdk.DataModel.Segments.updateSegment({ segmentId: p.id, [field]: value }); } catch (e) { console.warn(LOG, p.id, field, e); }
                }
            }
            again = await evaluateGroup(await loadMembers(ids));
            if (again.status === 'fix') throw new Error('could not apply: ' + again.summary);
        }
        return { done: true, segments: res.perSegment.length };
    }

    async function applyChecked() {
        if (applying) return;
        const rows = results.filter((r) => r.status === 'fix' && !excluded.has(r.key));
        if (!rows.length) return;
        if (!(await sdk.Editing.isEditingAllowed())) {
            setNote('Editing is not allowed right now.');
            return;
        }
        applying = true;
        updateApplyButton();
        let done = 0;
        let segs = 0;
        const problems = [];
        for (const row of rows) {
            try {
                const r = await applyGroup(row.ids);
                if (r.done) { done += 1; segs += r.segments; } else problems.push(row.key + ': ' + r.note);
            } catch (e) {
                problems.push(row.key + ': ' + (e && e.message ? e.message : e));
            }
        }
        applying = false;
        closePanel(); // the list goes away once the changes are applied
        let msg = 'Applied ' + done + ' of ' + rows.length + ' turnaround(s), ' + segs + ' segment(s) changed. Not saved yet: save in WME.';
        if (problems.length) {
            msg += ' Problems: ' + problems.join('; ');
            console.warn(LOG, 'problems', problems);
        }
        setNote(msg);
        scheduleScan(300);
    }

    // ---------- UI (modelled on WME Place Assist / Segment Importer) ----------
    // A U-turn sign: rounded sign edge, inner border, thick U arrow whose stem is on the right and
    // whose arrowhead points down on the left (a left-hand U-turn).
    function iconSvg(w, h) {
        return '<svg viewBox="0 0 22 24" width="' + w + '" height="' + h + '" fill="none" stroke="currentColor" ' +
            'stroke-linecap="butt" stroke-linejoin="round" aria-hidden="true">' +
            '<rect x="0.9" y="0.9" width="20.2" height="22.2" rx="3" stroke-width="1.6"/>' +
            '<rect x="3.4" y="3.4" width="15.2" height="17.2" rx="1.8" stroke-width="1.1"/>' +
            '<path d="M14.6 18.6V10.6A3.6 3.6 0 0 0 7.4 10.6V13.4" stroke-width="3"/>' +
            '<path d="M4.4 12.8H10.4L7.4 18.2Z" fill="currentColor" stroke="none"/></svg>';
    }

    const CSS = `
    .wsta-bar{position:fixed;z-index:999990;display:flex;align-items:center;gap:4px;padding:3px 6px 3px 2px;
      background:#fff;border-radius:10px;box-shadow:0 3px 12px rgba(0,0,0,.35);color:#333;user-select:none;
      font:13px/1.3 "Rubik","Helvetica Neue",Arial,sans-serif}
    .wsta-bar.wsta-hidden{display:none}
    .wsta-grip{cursor:grab;padding:4px;color:#999;font-size:16px;line-height:1;touch-action:none}
    .wsta-grip:active{cursor:grabbing}
    .wsta-status{position:relative;width:34px;height:34px;padding:0;border-radius:50%;border:2px solid #c4c8cc;
      background:#fff;color:#6b7280;display:flex;align-items:center;justify-content:center;cursor:pointer}
    .wsta-status.amber{border-color:#f29900;color:#c77700;animation:wsta-pulse 1.6s ease-out infinite}
    .wsta-status.red{border-color:#d93025;color:#d93025}
    .wsta-badge{position:absolute;top:-6px;right:-6px;min-width:16px;height:16px;padding:0 3px;border-radius:8px;
      box-sizing:border-box;background:#d93025;color:#fff;font-size:10px;font-weight:700;line-height:16px;
      text-align:center;display:none}
    .wsta-badge.wsta-on{display:block}
    .wsta-min{border:0;background:none;cursor:pointer;font-size:18px;line-height:1;color:#666;padding:2px 6px}
    .wsta-fab{position:relative;width:40px;height:40px;border-radius:50%;background:#fff;color:#6b7280;
      box-shadow:0 2px 6px rgba(0,0,0,.3);display:none;align-items:center;justify-content:center;cursor:pointer}
    .wsta-fab.show{display:flex}
    .wsta-fab.floating{position:fixed;right:12px;top:66%;z-index:999990}
    .wsta-fab.amber{color:#c77700}
    .wsta-fab.red{color:#d93025}
    .wsta-panel{position:absolute;top:calc(100% + 6px);left:0;width:320px;display:none;background:#fff;
      border:1px solid #dadce0;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.35);padding:8px;cursor:default}
    .wsta-panel.wsta-open{display:block}
    .wsta-summary{font-weight:600;margin-bottom:6px}
    .wsta-list{max-height:42vh;overflow:auto;border-top:1px solid #e3e8ec}
    .wsta-row{display:flex;gap:6px;align-items:flex-start;padding:5px 2px;border-bottom:1px solid #eef1f3}
    .wsta-row input{margin-top:2px}
    .wsta-row a{color:#0b66c3;cursor:pointer;text-decoration:underline;white-space:nowrap}
    .wsta-note{color:#8a5b00}
    .wsta-review .wsta-note{color:#a61b13}
    .wsta-actions{display:flex;gap:6px;margin-top:8px}
    .wsta-actions button{border:1px solid #dadce0;background:#f4f6f8;border-radius:4px;padding:3px 8px;cursor:pointer}
    .wsta-actions .wsta-primary{margin-left:auto;background:#1a73e8;border-color:#1a73e8;color:#fff;font-weight:600}
    .wsta-actions button:disabled{opacity:.5;cursor:default}
    @keyframes wsta-pulse{0%{box-shadow:0 0 0 0 rgba(242,153,0,.5)}70%,100%{box-shadow:0 0 0 7px rgba(242,153,0,0)}}
    `;

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function buildUi() {
        const style = el('style');
        style.id = 'wsta-style';
        style.textContent = CSS;
        document.head.appendChild(style);

        // Top-bar card: grip, round status button, minimize, drop-down list.
        ui.bar = el('div', 'wsta-bar');
        ui.grip = el('span', 'wsta-grip', '⋮');
        ui.grip.title = 'Drag to move';
        ui.status = el('button', 'wsta-status');
        ui.status.type = 'button';
        ui.status.innerHTML = iconSvg(18, 20); // static markup only
        ui.badge = el('span', 'wsta-badge');
        ui.status.appendChild(ui.badge);
        ui.minBtn = el('button', 'wsta-min', '−');
        ui.minBtn.type = 'button';
        ui.minBtn.title = 'Minimize to an icon in the stack of buttons on the right of the map';

        ui.panel = el('div', 'wsta-panel');
        ui.summary = el('div', 'wsta-summary');
        ui.list = el('div', 'wsta-list');
        const actions = el('div', 'wsta-actions');
        ui.allBtn = el('button', null, 'All');
        ui.noneBtn = el('button', null, 'None');
        ui.applyBtn = el('button', 'wsta-primary', 'Apply checked');
        for (const b of [ui.allBtn, ui.noneBtn, ui.applyBtn]) b.type = 'button';
        actions.append(ui.allBtn, ui.noneBtn, ui.applyBtn);
        ui.panel.append(ui.summary, ui.list, actions);

        ui.bar.append(ui.grip, ui.status, ui.minBtn, ui.panel);
        document.body.appendChild(ui.bar);

        // Minimized state: a round icon in WME's right-hand stack of map buttons (or floating if not found).
        ui.fab = el('div', 'wsta-fab');
        ui.fab.setAttribute('role', 'button');
        ui.fab.innerHTML = iconSvg(22, 24);
        ui.fabBadge = el('span', 'wsta-badge');
        ui.fab.appendChild(ui.fabBadge);
        const stack = document.querySelector('.overlay-buttons-container.top');
        if (stack) {
            stack.appendChild(ui.fab);
        } else {
            ui.fab.classList.add('floating');
            document.body.appendChild(ui.fab);
        }

        const pos = store.get('pos', { left: Math.max(0, window.innerWidth - 380), top: 0 });
        placeBar(pos.left, pos.top);
        setMinimized(!!store.get('minimized', false));

        ui.status.addEventListener('click', () => ui.panel.classList.toggle('wsta-open'));
        ui.fab.addEventListener('click', () => setMinimized(false));
        ui.minBtn.addEventListener('click', () => setMinimized(true));
        ui.allBtn.addEventListener('click', () => { excluded.clear(); persistExcluded(); render(); });
        ui.noneBtn.addEventListener('click', () => {
            results.filter((r) => r.status === 'fix').forEach((r) => excluded.add(r.key));
            persistExcluded();
            render();
        });
        ui.applyBtn.addEventListener('click', applyChecked);
        enableDrag();
    }

    function setMinimized(flag) {
        closePanel();
        ui.bar.classList.toggle('wsta-hidden', flag);
        ui.fab.classList.toggle('show', flag);
        store.set('minimized', flag);
    }

    function closePanel() {
        if (ui.panel) ui.panel.classList.remove('wsta-open');
    }

    function placeBar(left, top) {
        const maxLeft = Math.max(0, window.innerWidth - (ui.bar.offsetWidth || 90));
        const maxTop = Math.max(0, window.innerHeight - 50);
        ui.bar.style.left = Math.max(0, Math.min(left, maxLeft)) + 'px';
        ui.bar.style.top = Math.max(0, Math.min(top, maxTop)) + 'px';
    }

    function enableDrag() {
        let start = null;
        ui.grip.addEventListener('mousedown', (e) => {
            start = { x: e.clientX, y: e.clientY, left: ui.bar.offsetLeft, top: ui.bar.offsetTop };
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!start) return;
            placeBar(start.left + e.clientX - start.x, start.top + e.clientY - start.y);
        });
        document.addEventListener('mouseup', () => {
            if (!start) return;
            start = null;
            store.set('pos', { left: ui.bar.offsetLeft, top: ui.bar.offsetTop });
        });
    }

    function persistExcluded() {
        store.set('excluded', [...excluded].slice(-200));
    }

    function setNote(text) {
        note = { text, until: Date.now() + CFG.noteMs };
        renderTitles();
    }

    // Select the turnaround's segments and put them in the middle of the part of the map you can see
    // (the map's own center sits behind the sidebar, so a plain "center map" lands off to one side).
    async function showOnMap(ids) {
        try {
            await sdk.Editing.setSelection({ selection: { ids, objectType: 'segment' } });
            const members = await loadMembers(ids);
            if (!members) return;
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const m of members) {
                for (const c of m.geometry.coordinates) {
                    if (c[0] < minX) minX = c[0];
                    if (c[0] > maxX) maxX = c[0];
                    if (c[1] < minY) minY = c[1];
                    if (c[1] > maxY) maxY = c[1];
                }
            }
            const target = { lon: (minX + maxX) / 2, lat: (minY + maxY) / 2 };
            await sdk.Map.setMapCenter({ lonLat: target });
            const r = (await sdk.Map.getMapViewportElement()).getBoundingClientRect();
            const vis = { x: (r.left + Math.min(r.right, window.innerWidth)) / 2, y: (r.top + Math.min(r.bottom, window.innerHeight)) / 2 };
            const p = await sdk.Map.getPixelFromLonLat({ lonLat: target });
            const shifted = await sdk.Map.getLonLatFromPixel({ x: p.x + (p.x - vis.x), y: p.y + (p.y - vis.y) });
            await sdk.Map.setMapCenter({ lonLat: shifted });
        } catch (e) {
            console.warn(LOG, 'show on map failed', e);
        }
    }

    function updateApplyButton() {
        const n = results.filter((r) => r.status === 'fix' && !excluded.has(r.key)).length;
        ui.applyBtn.textContent = 'Apply checked (' + n + ')';
        ui.applyBtn.disabled = applying || n === 0;
    }

    function renderTitles() {
        if (!ui.bar) return;
        const fix = results.filter((r) => r.status === 'fix').length;
        const rev = results.filter((r) => r.status === 'review').length;
        let base;
        if (fix) base = fix + ' turnaround segment(s) need changing. Click to review.';
        else if (rev) base = 'Turnaround segments need review. Click to open.';
        else base = 'No turnaround segments need changing in view.';
        const text = (note.text && Date.now() < note.until) ? note.text + ' | ' + base : base;
        ui.status.title = text;
        ui.fab.title = text;
    }

    function render() {
        if (!ui.bar) return;
        const fix = results.filter((r) => r.status === 'fix');
        const rev = results.filter((r) => r.status === 'review');
        const ok = results.filter((r) => r.status === 'ok');

        const badgeText = fix.length ? String(fix.length) : (rev.length ? '!' : '');
        for (const b of [ui.badge, ui.fabBadge]) {
            b.textContent = badgeText;
            b.classList.toggle('wsta-on', badgeText !== '');
        }
        for (const b of [ui.status, ui.fab]) {
            b.classList.toggle('amber', fix.length > 0);
            b.classList.toggle('red', fix.length === 0 && rev.length > 0);
        }
        renderTitles();

        ui.summary.textContent = fix.length + ' to fix · ' + rev.length + ' need review · ' + ok.length + ' already match';

        ui.list.textContent = '';
        for (const r of [...fix, ...rev]) {
            const row = el('div', 'wsta-row' + (r.status === 'review' ? ' wsta-review' : ''));
            const box = el('input');
            box.type = 'checkbox';
            if (r.status === 'fix') {
                box.checked = !excluded.has(r.key);
                box.addEventListener('change', () => {
                    if (box.checked) excluded.delete(r.key); else excluded.add(r.key);
                    persistExcluded();
                    updateApplyButton();
                });
            } else {
                box.disabled = true;
            }
            const link = el('a', null, r.ids.length > 1 ? r.ids[0] + ' +' + (r.ids.length - 1) : String(r.ids[0]));
            link.title = r.ids.length > 1 ? 'Show and select all ' + r.ids.length + ' segments of this turnaround' : 'Show and select this segment';
            link.addEventListener('click', () => showOnMap(r.ids));
            const text = el('span', 'wsta-note', r.status === 'fix' ? r.summary : 'Review: ' + r.note);
            row.append(box, link, text);
            ui.list.appendChild(row);
        }
        if (!fix.length && !rev.length) ui.list.appendChild(el('div', 'wsta-row', 'Nothing to change in this view.'));
        updateApplyButton();
    }

    init().catch((e) => console.error(LOG, 'init failed', e));
})();
