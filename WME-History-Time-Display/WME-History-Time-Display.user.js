// ==UserScript==
// @name         WME History Time Display
// @namespace    https://github.com/TxAgBQ/Scripts
// @version      2026.10.23.02
// @description  Adds the time of day to edit History entries and the "Last updated" line in the Waze Map Editor (e.g. 18 Sep 26 · 2:41 PM).
// @author       TxAgBQ
// @license      MIT
// @match        https://beta.waze.com/editor*
// @match        https://beta.waze.com/*/editor*
// @match        https://www.waze.com/editor*
// @match        https://www.waze.com/*/editor*
// @exclude      https://www.waze.com/user/editor*
// @exclude      https://beta.waze.com/user/editor*
// @grant        none
// @run-at       document-end
// @homepageURL  https://github.com/TxAgBQ/Scripts/tree/main/WME-History-Time-Display
// @supportURL   https://github.com/TxAgBQ/Scripts/issues
// @updateURL    https://raw.githubusercontent.com/TxAgBQ/Scripts/main/WME-History-Time-Display/WME-History-Time-Display.user.js
// @downloadURL  https://raw.githubusercontent.com/TxAgBQ/Scripts/main/WME-History-Time-Display/WME-History-Time-Display.user.js
// ==/UserScript==

/*
 * WME History Time Display
 *
 * What it does
 *   - History entries: "September 05, 2025 by user" -> "5 Sep 25 · 10:07 AM by user"
 *   - "Last updated: September 16, 2026 by user" -> "Last updated: 16 Sep 26 · 11:40 AM by user"
 *
 * How it works
 *   - Uses the WME SDK (async mode) to learn which object is selected and its last-updated time.
 *   - The History panel is not covered by the SDK, so the panel's text is changed in the page, and
 *     the per-entry timestamps come from WME's own ElementHistory request, which this script
 *     repeats once per object (it does not patch window.fetch, so it will not conflict with other scripts).
 *   - Times are shown in your browser's local time, which is the same time zone WME uses for the dates.
 *   - Every change is checked first: if an entry's date does not match its timestamp, it is left alone.
 */

(function () {
    'use strict';

    const SCRIPT_ID = 'wme-history-time-display';
    const SCRIPT_NAME = 'WME History Time Display';
    const VERSION = '2026.10.23.02';
    const MARK = '·';
    const LOG = '[' + SCRIPT_NAME + ']';

    let sdk = null;
    let cache = null; // { key, entries, cardCount }
    let busy = false;
    let timer = null;

    // ---------- formatting ----------
    function fmt(ms) {
        const d = new Date(ms);
        const mon = d.toLocaleString('en-US', { month: 'short' });
        const yr = String(d.getFullYear()).slice(-2);
        const time = d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' });
        return d.getDate() + ' ' + mon + ' ' + yr + ' ' + MARK + ' ' + time;
    }

    function sameCalendarDay(shownText, ms) {
        const t = Date.parse(String(shownText).trim());
        if (isNaN(t)) return false;
        const a = new Date(t);
        const b = new Date(ms);
        return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    }

    // ---------- page lookups ----------
    function historyTitleNodes() {
        const out = [];
        document.querySelectorAll('.elementHistoryContainer wz-card.tx-item .tx-summary-title-content').forEach(function (el) {
            out.push(el);
        });
        return out;
    }

    function firstTextNode(el) {
        const n = el && el.firstChild;
        return n && n.nodeType === 3 ? n : null;
    }

    const LAST_UPDATED_RE = /(Last updated:\s*)([A-Za-z]+ \d{1,2}, \d{4})/;

    function lastUpdatedNode() {
        const lis = document.querySelectorAll('.additional-attributes li');
        for (const li of lis) {
            for (const n of li.childNodes) {
                if (n.nodeType === 3 && n.nodeValue.indexOf('Last updated:') !== -1) return n;
            }
        }
        return null;
    }

    function needsWork() {
        const cardsNeed = historyTitleNodes().some(function (el) {
            const tn = firstTextNode(el);
            return tn && tn.nodeValue.indexOf(MARK) === -1;
        });
        const luNode = lastUpdatedNode();
        const luNeed = !!(luNode && luNode.nodeValue.indexOf(MARK) === -1);
        return { cardsNeed: cardsNeed, luNeed: luNeed, luNode: luNode };
    }

    // ---------- data ----------
    async function getSelectedObject() {
        try {
            const sel = await sdk.Editing.getSelection();
            if (!sel || !sel.ids || sel.ids.length !== 1) return null;
            return { type: sel.objectType, id: sel.ids[0] };
        } catch (e) {
            return null;
        }
    }

    async function getUpdatedOn(obj) {
        try {
            let o = null;
            if (obj.type === 'segment') o = await sdk.DataModel.Segments.getById({ segmentId: obj.id });
            else if (obj.type === 'venue') o = await sdk.DataModel.Venues.getById({ venueId: obj.id });
            else if (obj.type === 'node') o = await sdk.DataModel.Nodes.getById({ nodeId: obj.id });
            return (o && o.modificationData && o.modificationData.updatedOn) || null;
        } catch (e) {
            return null;
        }
    }

    function getJson(url) {
        return new Promise(function (resolve, reject) {
            const x = new XMLHttpRequest();
            x.open('GET', url);
            x.withCredentials = true;
            x.onload = function () {
                try { resolve(JSON.parse(x.responseText)); } catch (e) { reject(e); }
            };
            x.onerror = reject;
            x.send();
        });
    }

    async function getEntries(obj, cardCount) {
        const key = obj.type + ':' + obj.id;
        if (cache && cache.key === key && cardCount <= cache.cardCount) return cache.entries;
        let entries = [];
        try {
            const url = '/Descartes/app/ElementHistory?objectID=' + encodeURIComponent(obj.id) +
                '&objectType=' + encodeURIComponent(obj.type);
            const j = await getJson(url);
            entries = (j && j.transactions && j.transactions.objects) || [];
        } catch (e) {
            console.warn(LOG, 'could not load history data', e);
        }
        cache = { key: key, entries: entries, cardCount: cardCount };
        return entries;
    }

    // ---------- apply ----------
    function applyCards(entries) {
        historyTitleNodes().forEach(function (el, i) {
            const tn = firstTextNode(el);
            if (!tn || tn.nodeValue.indexOf(MARK) !== -1) return;
            const e = entries[i];
            if (!e || !e.date) return;
            if (!sameCalendarDay(tn.nodeValue, e.date)) return; // safety: never guess
            tn.nodeValue = fmt(e.date);
        });
    }

    function applyLastUpdated(luNode, ms) {
        if (!luNode || !ms || luNode.nodeValue.indexOf(MARK) !== -1) return;
        const m = luNode.nodeValue.match(LAST_UPDATED_RE);
        if (!m || !sameCalendarDay(m[2], ms)) return; // safety: never guess
        luNode.nodeValue = luNode.nodeValue.replace(LAST_UPDATED_RE, function (all, prefix) {
            return prefix + fmt(ms);
        });
    }

    async function process() {
        if (busy) return;
        busy = true;
        try {
            const w = needsWork();
            if (!w.cardsNeed && !w.luNeed) return;
            const obj = await getSelectedObject();
            if (!obj) return;

            let updatedOn = null;
            if (w.luNeed) updatedOn = await getUpdatedOn(obj);

            let entries = null;
            if (w.cardsNeed || (w.luNeed && !updatedOn)) {
                entries = await getEntries(obj, historyTitleNodes().length);
            }

            if (w.cardsNeed && entries) applyCards(entries);
            if (w.luNeed) {
                const luNode = lastUpdatedNode(); // re-find in case WME re-rendered while we waited
                const ms = updatedOn || (entries && entries[0] && entries[0].date) || null;
                applyLastUpdated(luNode, ms);
            }
        } catch (e) {
            console.warn(LOG, e);
        } finally {
            busy = false;
        }
    }

    function schedule() {
        if (timer) return;
        timer = setTimeout(function () {
            timer = null;
            const w = needsWork();
            if (w.cardsNeed || w.luNeed) process();
        }, 120);
    }

    // ---------- startup ----------
    async function waitForSdk() {
        await new Promise(function (resolve) {
            if (window.SDK_INITIALIZED) { window.SDK_INITIALIZED.then(resolve); return; }
            let tries = 0;
            const t = setInterval(function () {
                if (window.SDK_INITIALIZED) {
                    clearInterval(t);
                    window.SDK_INITIALIZED.then(resolve);
                } else if (++tries > 300) {
                    clearInterval(t);
                    resolve();
                }
            }, 100);
        });
    }

    async function init() {
        await waitForSdk();
        if (typeof window.getWmeSdk !== 'function') {
            console.warn(LOG, 'WME SDK not found; script not started.');
            return;
        }
        sdk = await window.getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME, mode: 'async' });
        try {
            await Promise.race([
                sdk.Events.once({ eventName: 'wme-ready' }),
                new Promise(function (r) { setTimeout(r, 3000); })
            ]);
        } catch (e) { /* already ready */ }

        new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
        schedule();
        console.log(LOG, 'v' + VERSION + ' loaded');
    }

    init().catch(function (e) { console.error(LOG, 'init failed', e); });
})();
