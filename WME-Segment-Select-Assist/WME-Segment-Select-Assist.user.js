// ==UserScript==
// @name         WME Segment Select Assist
// @namespace    https://github.com/TxAgBQ/Scripts
// @version      2026.10.18.02
// @description  Select a first and last segment, then click one link in the edit panel to select every segment in between (shortest connected path, one side only).
// @author       TxAgBQ
// @match        https://www.waze.com/editor*
// @match        https://www.waze.com/*/editor*
// @match        https://beta.waze.com/editor*
// @match        https://beta.waze.com/*/editor*
// @exclude      https://www.waze.com/user/editor*
// @exclude      https://beta.waze.com/user/editor*
// @grant        none
// @license      MIT
// @homepageURL  https://github.com/TxAgBQ/Scripts
// @supportURL   https://github.com/TxAgBQ/Scripts/issues
// @downloadURL  https://raw.githubusercontent.com/TxAgBQ/Scripts/main/WME-Segment-Select-Assist/WME-Segment-Select-Assist.user.js
// @updateURL    https://raw.githubusercontent.com/TxAgBQ/Scripts/main/WME-Segment-Select-Assist/WME-Segment-Select-Assist.user.js
// ==/UserScript==

/* global getWmeSdk */

(function () {
    'use strict';

    const SCRIPT_ID = 'wme-segment-select-assist';
    const SCRIPT_NAME = 'WME Segment Select Assist';
    const BUTTON_ID = 'wme-ssa-between-btn';
    const BUTTON_TEXT = 'Select all segments between those selected';
    const OFF_ROAD_TYPE_PENALTY = 5; // cost multiplier for segments of a different road type than the start segment
    const MAX_SEGMENTS = 2000;       // safety stop

    let sdk = null;
    let busy = false;
    let observer = null;
    let scheduled = false;

    // ---------- SDK boot (works in production and beta) ----------
    function boot() {
        if (!window.SDK_INITIALIZED) {
            setTimeout(boot, 500);
            return;
        }
        window.SDK_INITIALIZED.then(() => {
            sdk = getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME });
            sdk.Events.once({ eventName: 'wme-ready' }).then(init);
        });
    }

    function init() {
        sdk.Events.on({ eventName: 'wme-selection-changed', eventHandler: scheduleUpdate });

        // The edit panel re-renders itself; re-add the link if it gets wiped.
        observer = new MutationObserver(scheduleUpdate);
        observer.observe(document.body, { childList: true, subtree: true });

        // Optional hotkey (no default key; assign one in WME's shortcut settings).
        try {
            sdk.Shortcuts.createShortcut({
                shortcutId: SCRIPT_ID + '-run',
                description: BUTTON_TEXT,
                shortcutKeys: '',
                callback: runSelectBetween
            });
        } catch (e) {
            console.debug(SCRIPT_NAME + ': shortcut not registered', e);
        }

        scheduleUpdate();
        console.log(SCRIPT_NAME + ' v' + GM_VERSION() + ' loaded');
    }

    function GM_VERSION() {
        return '2026.10.18.02';
    }

    // ---------- UI ----------
    function scheduleUpdate() {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            updateButton();
        });
    }

    function twoSegmentsSelected() {
        const sel = sdk.Editing.getSelection();
        return !!sel && sel.objectType === 'segment' && sel.ids.length === 2;
    }

    function updateButton() {
        const existing = document.getElementById(BUTTON_ID);
        if (!twoSegmentsSelected()) {
            if (existing) existing.parentElement.remove();
            return;
        }
        if (existing && document.body.contains(existing)) return;

        const wrapper = document.createElement('div');
        const btn = document.createElement('wz-button');
        btn.id = BUTTON_ID;
        btn.setAttribute('color', 'text');
        btn.setAttribute('size', 'sm');
        btn.setAttribute('type', 'button');
        btn.textContent = BUTTON_TEXT;
        btn.addEventListener('click', runSelectBetween);
        wrapper.appendChild(btn);

        // Anchor by class, not by English text, so other languages work.
        const anchor = document.querySelector('wz-button.select-entire-street');
        if (anchor && anchor.parentElement) {
            anchor.parentElement.insertAdjacentElement('afterend', wrapper);
            return;
        }
        // Fallback: top of the edit panel.
        const panel = document.getElementById('edit-panel');
        if (panel) panel.prepend(wrapper);
    }

    function flash(text) {
        const btn = document.getElementById(BUTTON_ID);
        if (!btn) return;
        btn.textContent = text;
        setTimeout(() => {
            const b = document.getElementById(BUTTON_ID);
            if (b) b.textContent = BUTTON_TEXT;
        }, 4000);
    }

    // ---------- Pathfinding (SDK data only) ----------
    function findPath(startId, endId) {
        const getSeg = id => sdk.DataModel.Segments.getById({ segmentId: id });
        const getNode = id => sdk.DataModel.Nodes.getById({ nodeId: id });

        const start = getSeg(startId);
        if (!start || !getSeg(endId)) return null;

        const cost = s => (s.length || 1) * (s.roadType === start.roadType ? 1 : OFF_ROAD_TYPE_PENALTY);
        const dist = new Map([[startId, 0]]);
        const prev = new Map();
        const done = new Set();

        while (done.size < MAX_SEGMENTS) {
            let cur = null;
            let best = Infinity;
            for (const [id, d] of dist) {
                if (!done.has(id) && d < best) { best = d; cur = id; }
            }
            if (cur === null || cur === endId) break;
            done.add(cur);

            const seg = getSeg(cur);
            if (!seg) continue;
            for (const nodeId of [seg.fromNodeId, seg.toNodeId]) {
                const node = nodeId && getNode(nodeId);
                if (!node) continue;
                for (const nb of node.connectedSegmentIds) {
                    if (done.has(nb)) continue;
                    const t = getSeg(nb);
                    if (!t) continue;
                    const nd = best + cost(t);
                    if (nd < (dist.get(nb) ?? Infinity)) {
                        dist.set(nb, nd);
                        prev.set(nb, cur);
                    }
                }
            }
        }

        if (!dist.has(endId)) return null;
        const path = [];
        for (let x = endId; x !== undefined; x = prev.get(x)) path.push(x);
        return path.reverse();
    }

    function runSelectBetween() {
        if (busy || !sdk || !twoSegmentsSelected()) return;
        busy = true;
        try {
            const [a, b] = sdk.Editing.getSelection().ids;
            const path = findPath(a, b);
            if (!path) {
                flash('Path not found - pan along the route and try again');
                return;
            }
            sdk.Editing.setSelection({ selection: { objectType: 'segment', ids: path } });
        } catch (e) {
            console.error(SCRIPT_NAME, e);
            flash('Error - see console');
        } finally {
            busy = false;
        }
    }

    boot();
})();
