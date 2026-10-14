// ==UserScript==
// @name         WME LiveMap Search
// @namespace    https://github.com/TxAgBQ
// @version      2026.10.14.01
// @description  Adds Waze LiveMap place results to the WME search box, ranked by match quality, and centers/zooms the map on the one you pick.
// @author       TxAgBQ
// @match        https://www.waze.com/editor*
// @match        https://www.waze.com/*/editor*
// @match        https://beta.waze.com/editor*
// @match        https://beta.waze.com/*/editor*
// @exclude      https://www.waze.com/user/editor*
// @exclude      https://beta.waze.com/user/editor*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      www.waze.com
// @connect      beta.waze.com
// @run-at       document-end
// ==/UserScript==

/* global GM_xmlhttpRequest, unsafeWindow */

(function () {
    'use strict';

    const SCRIPT_ID = 'wme-livemap-search';
    const SCRIPT_NAME = 'WME LiveMap Search';
    const LOG = '[' + SCRIPT_NAME + ']';

    // ---- Settings (edit here) ----
    const ZOOM_ON_SELECT = 17;       // zoom level after picking a LiveMap result
    const MAX_LIVEMAP_RESULTS = 10;  // how many LiveMap results to take
    const MAX_TOTAL_RESULTS = 15;    // cap on the merged dropdown list
    const MIN_QUERY_LENGTH = 2;      // don't query LiveMap for shorter text
    const REQUEST_TIMEOUT_MS = 800;  // WME gives the search box ~1000 ms, so stay under it
    const CACHE_TTL_MS = 120000;
    const SEARCH_SELECTOR = '#search-autocomplete';

    const doc = unsafeWindow.document;
    const hooked = new WeakSet();
    const picks = new Map();   // our item id -> { lat, lng }
    const cache = new Map();   // query key -> { t, rows }
    let sdk = null;
    let inflight = null;
    let warned = false;

    function warnOnce(...args) {
        if (warned) return;
        warned = true;
        console.warn(LOG, ...args);
    }

    // ---------- text matching ----------
    function norm(s) {
        return String(s || '')
            .toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/['\u2019]/g, '')
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();
    }

    // 0 exact, 1 starts with, 2 every typed word starts a word in the name, 3 contains, 4 other
    function matchTier(text, q, tokens) {
        const n = norm(text);
        if (!n) return 5;
        if (n === q) return 0;
        if (n.startsWith(q)) return 1;
        const words = n.split(' ');
        if (tokens.every(t => words.some(w => w.startsWith(t)))) return 2;
        if (n.includes(q)) return 3;
        return 4;
    }

    function firstPart(s) {
        return String(s || '').split(',')[0];
    }

    // ---------- geography ----------
    function geoEnvFor(c) {
        if (c.lat >= 29 && c.lat <= 34 && c.lon >= 34 && c.lon <= 36) return 'il';
        if (c.lon <= -50 && c.lat >= 18) return 'na';
        return 'row';
    }

    function distanceKm(a, b) {
        const R = 6371;
        const rad = d => d * Math.PI / 180;
        const dLat = rad(b.lat - a.lat);
        const dLon = rad(b.lng - a.lon);
        const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(h));
    }

    function distanceText(km, miles) {
        const v = miles ? km * 0.621371 : km;
        const unit = miles ? 'mi' : 'km';
        return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + unit;
    }

    // ---------- LiveMap request ----------
    function shouldSkip(query) {
        const t = query.trim();
        if (norm(t).length < MIN_QUERY_LENGTH) return true;
        if (/^-?\d+(\.\d+)?\s*[,\s]\s*-?\d+(\.\d+)?$/.test(t)) return true; // coordinates
        if (/^\d{5,}$/.test(t)) return true;                                // segment / object IDs
        if (/^https?:\/\//i.test(t) || /waze\.com/i.test(t)) return true;   // permalinks
        return false;
    }

    function requestLiveMap(url) {
        return new Promise(resolve => {
            if (inflight && inflight.abort) {
                try { inflight.abort(); } catch (e) { /* ignore */ }
            }
            inflight = GM_xmlhttpRequest({
                method: 'GET',
                url,
                timeout: REQUEST_TIMEOUT_MS,
                headers: { Accept: 'application/json' },
                onload: r => {
                    if (r.status !== 200) {
                        warnOnce('LiveMap returned HTTP ' + r.status + '; showing WME results only.');
                        return resolve([]);
                    }
                    try {
                        const data = JSON.parse(r.responseText);
                        resolve(Array.isArray(data) ? data : []);
                    } catch (e) {
                        warnOnce('Unexpected LiveMap response; showing WME results only.');
                        resolve([]);
                    }
                },
                onerror: () => { warnOnce('LiveMap request failed.'); resolve([]); },
                ontimeout: () => resolve([]),
                onabort: () => resolve([])
            });
        });
    }

    async function fetchLiveMap(query, center) {
        const env = geoEnvFor(center);
        const key = norm(query) + '|' + env + '|' + center.lat.toFixed(2) + ',' + center.lon.toFixed(2);
        const hit = cache.get(key);
        if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.rows;

        const url = location.origin + '/live-map/api/autocomplete/?q=' + encodeURIComponent(query) +
            '&exp=8%2C10%2C12&geo-env=' + env +
            '&sll=' + center.lat + '%2C' + center.lon + '&lang=en';
        const raw = await requestLiveMap(url);

        const rows = raw
            .map(r => ({
                name: String((r && (r.name || r.cleanName)) || '').trim(),
                address: String((r && r.address) || '').trim(),
                id: r && r.venueId,
                lat: Number(r && r.latLng && r.latLng.lat),
                lng: Number(r && r.latLng && r.latLng.lng)
            }))
            .filter(r => r.name && r.id && Number.isFinite(r.lat) && Number.isFinite(r.lng))
            .slice(0, MAX_LIVEMAP_RESULTS);

        if (rows.length) {
            if (cache.size > 50) cache.delete(cache.keys().next().value);
            cache.set(key, { t: Date.now(), rows });
        }
        return rows;
    }

    // ---------- merge + rank ----------
    function buildRows(nativeItems, lmRows, query, center) {
        const q = norm(query);
        const tokens = q.split(' ').filter(Boolean);
        const miles = geoEnvFor(center) === 'na';
        const out = [];

        nativeItems.forEach((it, i) => {
            const label = it.text || firstPart(it.secondaryText);
            out.push({ item: it, tier: matchTier(label, q, tokens), ours: false, dist: Infinity, i });
        });

        lmRows.forEach((r, i) => {
            const km = distanceKm(center, r);
            const id = 'wls:' + r.id;
            picks.set(id, { lat: r.lat, lng: r.lng });
            if (picks.size > 300) picks.delete(picks.keys().next().value);
            out.push({
                item: {
                    id,
                    text: r.name,
                    secondaryText: (r.address ? r.address + ' \u00b7 ' : '') + distanceText(km, miles)
                },
                tier: matchTier(r.name, q, tokens),
                ours: true,
                dist: km,
                i
            });
        });

        out.sort((a, b) =>
            a.tier - b.tier ||
            (b.ours - a.ours) ||
            (a.ours ? a.dist - b.dist : a.i - b.i));

        return out.slice(0, MAX_TOTAL_RESULTS).map(r => r.item);
    }

    // ---------- hook into the WME search box ----------
    function wrapGetItems(orig) {
        if (typeof orig !== 'function' || orig.__wls) return orig;

        const wrapped = async function (query) {
            const nativeP = Promise.resolve(orig.call(this, query)).catch(() => []);
            try {
                const q = String(query || '');
                if (!sdk || shouldSkip(q)) return await nativeP;
                const c = sdk.Map.getMapCenter();
                const center = { lat: c.lat, lon: c.lon };
                const [nativeItems, lmRows] = await Promise.all([
                    nativeP,
                    fetchLiveMap(q, center).catch(() => [])
                ]);
                if (!lmRows.length) return nativeItems;
                return buildRows(Array.isArray(nativeItems) ? nativeItems : [], lmRows, q, center);
            } catch (err) {
                warnOnce('Search merge failed; showing WME results only.', err);
                return await nativeP;
            }
        };
        wrapped.__wls = true;
        return wrapped;
    }

    function goTo(lat, lng) {
        try {
            sdk.Map.setMapCenter({ lonLat: { lon: lng, lat }, zoomLevel: ZOOM_ON_SELECT });
        } catch (err) {
            try {
                sdk.Map.setMapCenter({ lonLat: { lon: lng, lat } });
                sdk.Map.setZoomLevel({ zoomLevel: ZOOM_ON_SELECT });
            } catch (err2) {
                console.warn(LOG, 'Could not move the map.', err2);
            }
        }
    }

    function onItemSelected(e) {
        const d = e && e.detail;
        const p = d && picks.get(d.id);
        if (p) goTo(p.lat, p.lng);
    }

    function hook(el) {
        const proto = Object.getPrototypeOf(el);
        const d = Object.getOwnPropertyDescriptor(proto, 'getItems');
        if (!d || !d.get || !d.set) {
            warnOnce('Search box layout changed (no getItems accessor); LiveMap results disabled.');
            hooked.add(el);
            return;
        }
        hooked.add(el);
        Object.defineProperty(el, 'getItems', {
            configurable: true,
            enumerable: true,
            get() { return d.get.call(el); },
            set(v) { d.set.call(el, wrapGetItems(v)); }
        });
        const current = d.get.call(el);
        if (typeof current === 'function') el.getItems = current; // re-set through our setter
        el.addEventListener('itemSelected', onItemSelected);
    }

    function attach() {
        const el = doc.querySelector(SEARCH_SELECTOR);
        if (el && !hooked.has(el)) hook(el);
    }

    // ---------- startup ----------
    function waitFor(test, intervalMs, maxTries) {
        return new Promise(resolve => {
            let n = 0;
            const t = setInterval(() => {
                const v = test();
                if (v || ++n >= maxTries) {
                    clearInterval(t);
                    resolve(v || null);
                }
            }, intervalMs);
        });
    }

    async function init() {
        const ok = await waitFor(() => unsafeWindow.SDK_INITIALIZED && unsafeWindow.getWmeSdk, 250, 240);
        if (!ok) {
            console.error(LOG, 'WME SDK not found.');
            return;
        }
        await unsafeWindow.SDK_INITIALIZED;
        sdk = unsafeWindow.getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME });
        try {
            if (!sdk.State.isReady) await sdk.Events.once({ eventName: 'wme-ready' });
        } catch (e) { /* continue anyway */ }
        attach();
        setInterval(attach, 2000);
        console.log(LOG, 'ready');
    }

    init();
})();
