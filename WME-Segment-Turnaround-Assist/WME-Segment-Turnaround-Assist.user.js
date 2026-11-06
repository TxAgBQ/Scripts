// ==UserScript==
// @name         WME Segment Turnaround Assist
// @namespace    https://github.com/TxAgBQ/Scripts
// @version      2026.11.06.02
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
 *   - Looks at segments in view whose primary street is "Turnaround" and whose state is Texas.
 *   - The segments at BOTH ends must be the same highway type (Minor or Major Highway).
 *     Anything else is listed as "needs review" and never changed.
 *   - A turnaround needs fixing when its road type differs from the frontage road, its lock is
 *     below target (currently L5 for both Minor and Major), or its routing differs from the +1 routing that
 *     every neighbor shares.
 *   - Apply changes the checked rows only. It does NOT save; you save in WME.
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
    const VERSION = '2026.11.06.02'; // keep in sync with @version
    const LOG = '[WSTA]';

    const CFG = {
        streetName: 'turnaround',       // compared case-insensitively against the primary street name
        stateName: 'Texas',
        typeNames: { 6: 'Major Hwy', 7: 'Minor Hwy' },
        lockForType: { 6: 4, 7: 4 },    // zero-based lockRank: 4 = L5 for both types (was Major L4 / Minor L3)
        rescanDelayMs: 500,
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

    async function scan() {
        const streets = await sdk.DataModel.Streets.getAll();
        turnStreetIds = new Set(
            streets.filter((s) => s && s.name && s.name.trim().toLowerCase() === CFG.streetName).map((s) => s.id)
        );
        if (!turnStreetIds.size) return [];

        const me = await sdk.State.getUserInfo();
        userRank = me && typeof me.rank === 'number' ? me.rank : 0;

        const ext = await sdk.Map.getMapExtent();
        const segments = await sdk.DataModel.Segments.getAll();
        const found = [];
        for (const seg of segments) {
            if (!turnStreetIds.has(seg.primaryStreetId)) continue;
            if (!boxIntersects(seg.geometry, ext)) continue;
            const addr = await sdk.DataModel.Segments.getAddress({ segmentId: seg.id });
            if (!addr || !addr.state || addr.state.name !== CFG.stateName) continue;
            found.push(await evaluate(seg));
        }
        const order = { fix: 0, review: 1, ok: 2 };
        found.sort((a, b) => order[a.status] - order[b.status] || a.id - b.id);
        return found;
    }

    // ---------- the rules ----------
    function review(res, note) {
        res.status = 'review';
        res.note = note;
        return res;
    }

    async function evaluate(seg) {
        const res = { id: seg.id, status: 'ok', note: '', changes: null, summary: '' };

        // Neighbors at BOTH ends, from the nodes.
        const neighbors = [];
        for (const key of ['fromNodeId', 'toNodeId']) {
            const node = await sdk.DataModel.Nodes.getById({ nodeId: seg[key] });
            const atThisEnd = [];
            for (const sid of (node && node.connectedSegmentIds) || []) {
                if (sid === seg.id) continue;
                const other = await sdk.DataModel.Segments.getById({ segmentId: sid });
                if (!other) return review(res, 'A connected segment is not loaded. Pan or zoom and it will rescan.');
                if (turnStreetIds.has(other.primaryStreetId)) continue; // another turnaround, not the frontage road
                atThisEnd.push(other);
            }
            if (!atThisEnd.length) return review(res, 'No frontage road segment at one end.');
            neighbors.push(...atThisEnd);
        }

        const types = new Set(neighbors.map((n) => n.roadType));
        if (types.size !== 1 || !CFG.lockForType[[...types][0]]) {
            const found = [...types].map(typeName).join(' / ');
            return review(res, 'Ends disagree or are not Minor/Major Highway (found: ' + found + ').');
        }
        const targetType = [...types][0];
        const targetLock = CFG.lockForType[targetType];

        // +1 routing is copied only when every neighbor has the same one.
        const routes = new Set(neighbors.map((n) => n.routingRoadType));
        const targetRoute = routes.size === 1 ? [...routes][0] : null;

        const changes = {};
        const parts = [];
        if (seg.roadType !== targetType) {
            changes.roadType = targetType;
            parts.push('Type: ' + typeName(targetType));
        }
        if (seg.lockRank < targetLock) {
            changes.lockRank = targetLock;
            parts.push('Lock: L' + (targetLock + 1));
        }
        if (targetRoute !== null && targetRoute !== undefined && targetRoute !== targetType && seg.routingRoadType !== targetRoute) {
            changes.routingRoadType = targetRoute;
            parts.push('Routing: ' + typeName(targetRoute));
        }

        if (!parts.length) {
            res.summary = 'Already matches';
            return res;
        }

        res.summary = parts.join(' · ');
        const allowed = await sdk.DataModel.Segments.hasPermissions({ segmentId: seg.id });
        if (!allowed) return review(res, 'You cannot edit this segment (' + res.summary + ' needed).');
        if (changes.lockRank !== undefined && changes.lockRank > userRank) {
            return review(res, 'Needs L' + (targetLock + 1) + ' to lock; your rank is L' + (userRank + 1) + '.');
        }

        res.status = 'fix';
        res.changes = changes;
        return res;
    }

    // ---------- applying (never saves) ----------
    async function applyOne(id) {
        const seg = await sdk.DataModel.Segments.getById({ segmentId: id });
        if (!seg) throw new Error('segment not loaded');
        const res = await evaluate(seg);
        if (res.status !== 'fix') return { id, skipped: true, note: res.status === 'ok' ? 'already matches' : res.note };

        await sdk.DataModel.Segments.updateSegment({ segmentId: id, ...res.changes });

        // Verify; if a field did not stick, retry the leftovers one at a time.
        let again = await evaluate(await sdk.DataModel.Segments.getById({ segmentId: id }));
        if (again.status === 'fix') {
            for (const [field, value] of Object.entries(again.changes)) {
                try { await sdk.DataModel.Segments.updateSegment({ segmentId: id, [field]: value }); } catch (e) { console.warn(LOG, id, field, e); }
            }
            again = await evaluate(await sdk.DataModel.Segments.getById({ segmentId: id }));
            if (again.status === 'fix') throw new Error('could not apply: ' + again.summary);
        }
        return { id, done: true };
    }

    async function applyChecked() {
        if (applying) return;
        const ids = results.filter((r) => r.status === 'fix' && !excluded.has(r.id)).map((r) => r.id);
        if (!ids.length) return;
        if (!(await sdk.Editing.isEditingAllowed())) {
            setStatus('Editing is not allowed right now.', true);
            return;
        }
        applying = true;
        updateApplyButton();
        let done = 0;
        const problems = [];
        for (const id of ids) {
            try {
                const r = await applyOne(id);
                if (r.done) done += 1; else problems.push(id + ': ' + r.note);
            } catch (e) {
                problems.push(id + ': ' + (e && e.message ? e.message : e));
            }
        }
        applying = false;
        let msg = 'Applied ' + done + ' of ' + ids.length + '. Not saved yet. Save in WME when you are ready.';
        if (problems.length) msg += ' Problems: ' + problems.join('; ');
        setStatus(msg, problems.length > 0);
        scheduleScan(300);
    }

    // ---------- UI ----------
    const ICON_SVG =
        '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<rect x="2.5" y="2.5" width="19" height="19" rx="3.5"/>' +
        '<path d="M8.5 18V10a3.5 3.5 0 0 1 7 0v5"/><path d="M13.2 12.8l2.3 2.5 2.3-2.5"/></svg>';

    const CSS = `
    .wsta-root{position:fixed;z-index:1050;font:12px/1.35 "Helvetica Neue",Arial,sans-serif;color:#22303a}
    .wsta-bar{display:flex;align-items:center;gap:6px;background:#fff;border:1px solid #b9c4cc;border-radius:20px;
      padding:3px 6px 3px 3px;box-shadow:0 2px 6px rgba(0,0,0,.25);cursor:move;user-select:none}
    .wsta-icon{position:relative;width:30px;height:30px;border-radius:50%;border:0;background:#e3e8ec;color:#56646e;
      cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}
    .wsta-hot .wsta-icon{background:#f5a623;color:#1d1300;animation:wsta-pulse 1.6s infinite}
    .wsta-warn .wsta-icon{background:#fde2e0;color:#a61b13}
    .wsta-badge{position:absolute;top:-5px;right:-5px;min-width:16px;height:16px;border-radius:8px;background:#d93025;
      color:#fff;font-size:10px;font-weight:700;line-height:16px;text-align:center;padding:0 3px;display:none}
    .wsta-badge.wsta-on{display:block}
    .wsta-title{font-weight:600;white-space:nowrap}
    .wsta-min{border:0;background:transparent;font-size:16px;line-height:1;cursor:pointer;color:#56646e;padding:0 4px}
    .wsta-minimized .wsta-title,.wsta-minimized .wsta-min,.wsta-minimized .wsta-panel{display:none}
    .wsta-minimized .wsta-bar{padding:3px}
    .wsta-panel{display:none;margin-top:6px;width:340px;background:#fff;border:1px solid #b9c4cc;border-radius:8px;
      box-shadow:0 2px 8px rgba(0,0,0,.28);padding:8px}
    .wsta-panel.wsta-open{display:block}
    .wsta-summary{font-weight:600;margin-bottom:6px}
    .wsta-list{max-height:42vh;overflow:auto;border-top:1px solid #e3e8ec}
    .wsta-row{display:flex;gap:6px;align-items:flex-start;padding:5px 2px;border-bottom:1px solid #eef1f3}
    .wsta-row input{margin-top:2px}
    .wsta-row a{color:#0b66c3;cursor:pointer;text-decoration:underline;white-space:nowrap}
    .wsta-note{color:#8a5b00}
    .wsta-review .wsta-note{color:#a61b13}
    .wsta-actions{display:flex;gap:6px;margin-top:8px}
    .wsta-actions button{border:1px solid #b9c4cc;background:#f4f6f8;border-radius:4px;padding:3px 8px;cursor:pointer}
    .wsta-actions .wsta-primary{margin-left:auto;background:#1a73e8;border-color:#1a73e8;color:#fff;font-weight:600}
    .wsta-actions button:disabled{opacity:.5;cursor:default}
    .wsta-status{margin-top:6px;color:#22303a}
    .wsta-status.wsta-err{color:#a61b13}
    @keyframes wsta-pulse{0%,100%{box-shadow:0 0 0 0 rgba(245,166,35,.6)}50%{box-shadow:0 0 0 6px rgba(245,166,35,0)}}
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

        ui.root = el('div', 'wsta-root');
        ui.bar = el('div', 'wsta-bar');
        ui.icon = el('button', 'wsta-icon');
        ui.icon.type = 'button';
        ui.icon.innerHTML = ICON_SVG; // static markup only
        ui.icon.title = 'Segment Turnaround Assist';
        ui.badge = el('span', 'wsta-badge');
        ui.icon.appendChild(ui.badge);
        ui.title = el('span', 'wsta-title', 'Turnaround Assist');
        ui.minBtn = el('button', 'wsta-min', '–');
        ui.minBtn.type = 'button';
        ui.minBtn.title = 'Minimize to an icon';
        ui.bar.append(ui.icon, ui.title, ui.minBtn);

        ui.panel = el('div', 'wsta-panel');
        ui.summary = el('div', 'wsta-summary', 'Scanning...');
        ui.list = el('div', 'wsta-list');
        const actions = el('div', 'wsta-actions');
        ui.allBtn = el('button', null, 'All');
        ui.noneBtn = el('button', null, 'None');
        ui.applyBtn = el('button', 'wsta-primary', 'Apply checked');
        for (const b of [ui.allBtn, ui.noneBtn, ui.applyBtn]) b.type = 'button';
        actions.append(ui.allBtn, ui.noneBtn, ui.applyBtn);
        ui.status = el('div', 'wsta-status');
        ui.panel.append(ui.summary, ui.list, actions, ui.status);

        ui.root.append(ui.bar, ui.panel);
        document.body.appendChild(ui.root);

        const pos = store.get('pos', { left: 400, top: 80 });
        placeRoot(pos.left, pos.top);
        ui.root.classList.toggle('wsta-minimized', !!store.get('minimized', false));

        ui.icon.addEventListener('click', () => {
            if (ui.root.classList.contains('wsta-minimized')) {
                ui.root.classList.remove('wsta-minimized');
                store.set('minimized', false);
            } else {
                ui.panel.classList.toggle('wsta-open');
            }
        });
        ui.minBtn.addEventListener('click', () => {
            ui.panel.classList.remove('wsta-open');
            ui.root.classList.add('wsta-minimized');
            store.set('minimized', true);
        });
        ui.allBtn.addEventListener('click', () => { excluded.clear(); persistExcluded(); render(); });
        ui.noneBtn.addEventListener('click', () => {
            results.filter((r) => r.status === 'fix').forEach((r) => excluded.add(r.id));
            persistExcluded();
            render();
        });
        ui.applyBtn.addEventListener('click', applyChecked);
        enableDrag();
    }

    function placeRoot(left, top) {
        const l = Math.max(0, Math.min(left, window.innerWidth - 60));
        const t = Math.max(0, Math.min(top, window.innerHeight - 60));
        ui.root.style.left = l + 'px';
        ui.root.style.top = t + 'px';
    }

    function enableDrag() {
        let start = null;
        ui.bar.addEventListener('mousedown', (e) => {
            if (e.target.closest('button')) return;
            start = { x: e.clientX, y: e.clientY, left: ui.root.offsetLeft, top: ui.root.offsetTop };
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!start) return;
            placeRoot(start.left + e.clientX - start.x, start.top + e.clientY - start.y);
        });
        document.addEventListener('mouseup', () => {
            if (!start) return;
            start = null;
            store.set('pos', { left: ui.root.offsetLeft, top: ui.root.offsetTop });
        });
    }

    function persistExcluded() {
        store.set('excluded', [...excluded].slice(-200));
    }

    function setStatus(text, isError) {
        ui.status.textContent = text;
        ui.status.classList.toggle('wsta-err', !!isError);
    }

    function selectSegment(id) {
        Promise.resolve(sdk.Editing.setSelection({ selection: { ids: [id], objectType: 'segment' } }))
            .catch((e) => console.warn(LOG, 'select failed', e));
    }

    function updateApplyButton() {
        const n = results.filter((r) => r.status === 'fix' && !excluded.has(r.id)).length;
        ui.applyBtn.textContent = 'Apply checked (' + n + ')';
        ui.applyBtn.disabled = applying || n === 0;
    }

    function render() {
        if (!ui.root) return;
        const fix = results.filter((r) => r.status === 'fix');
        const rev = results.filter((r) => r.status === 'review');
        const ok = results.filter((r) => r.status === 'ok');

        ui.badge.textContent = fix.length ? String(fix.length) : (rev.length ? '!' : '');
        ui.badge.classList.toggle('wsta-on', fix.length > 0 || rev.length > 0);
        ui.root.classList.toggle('wsta-hot', fix.length > 0);
        ui.root.classList.toggle('wsta-warn', fix.length === 0 && rev.length > 0);
        ui.icon.title = fix.length
            ? fix.length + ' turnaround segment(s) need changing'
            : 'No turnaround segments need changing in view';

        ui.summary.textContent = fix.length + ' to fix · ' + rev.length + ' need review · ' + ok.length + ' already match';

        ui.list.textContent = '';
        for (const r of [...fix, ...rev]) {
            const row = el('div', 'wsta-row' + (r.status === 'review' ? ' wsta-review' : ''));
            const box = el('input');
            box.type = 'checkbox';
            if (r.status === 'fix') {
                box.checked = !excluded.has(r.id);
                box.addEventListener('change', () => {
                    if (box.checked) excluded.delete(r.id); else excluded.add(r.id);
                    persistExcluded();
                    updateApplyButton();
                });
            } else {
                box.disabled = true;
            }
            const link = el('a', null, String(r.id));
            link.title = 'Select this segment';
            link.addEventListener('click', () => selectSegment(r.id));
            const text = el('span', 'wsta-note', r.status === 'fix' ? r.summary : 'Review: ' + r.note);
            row.append(box, link, text);
            ui.list.appendChild(row);
        }
        if (!fix.length && !rev.length) ui.list.appendChild(el('div', 'wsta-row', 'Nothing to change in this view.'));
        updateApplyButton();
    }

    init().catch((e) => console.error(LOG, 'init failed', e));
})();
