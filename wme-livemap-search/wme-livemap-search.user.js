// ==UserScript==
// @name         WME LiveMap Search
// @namespace    https://github.com/TxAgBQ
// @version      2026.10.14.05
// @description  Adds Waze LiveMap place results (Waze vs Google marked) to the WME search box, ranked by match quality, and centers/zooms the map with a pin on the one you pick.
// @author       TxAgBQ
// @homepageURL  https://github.com/TxAgBQ/Scripts/tree/main/wme-livemap-search
// @updateURL    https://raw.githubusercontent.com/TxAgBQ/Scripts/main/wme-livemap-search/wme-livemap-search.user.js
// @downloadURL  https://raw.githubusercontent.com/TxAgBQ/Scripts/main/wme-livemap-search/wme-livemap-search.user.js
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
    const PIN_LAYER = 'wme-livemap-search-pin';
    const PIN_IGNORE_SELECTION_MS = 700; // ignore selection changes right after a pick

    // Waze = light-blue solid-dot pin. Google = three-band ring pin. The map pin matches the list icon.
    // Edit the colors here to taste.
    const COLORS = {
        waze: { fill: '#66C3F3', edge: '#2B7BB0' },
        google: { bands: ['#7E57C2', '#FF9800', '#26A69A'], edge: '#4A3A6B' }
    };
    const GOOGLE_RING_COLOR = '#FF9800'; // only used if the pin graphic can't load
    const DEBUG = true; // logs each pick to the console; set to false once it works for you

    const doc = unsafeWindow.document;
    const hooked = new WeakSet();
    const picks = new Map();   // our item id -> { lat, lng, src }
    const cache = new Map();   // query key -> { t, rows }
    const warnedKeys = new Set();
    let sdk = null;
    let inflight = null;
    let iconsOk = false;       // true once a data: image is proven to load on this page
    let pinLayerReady = false;
    let pinShown = false;
    let pinAddedAt = 0;

    function warnOnce(key, ...args) {
        if (warnedKeys.has(key)) return;
        warnedKeys.add(key);
        console.warn(LOG, ...args);
    }

    // ---------- pin icons ----------
    // square = padded to a square for the dropdown; otherwise tight pin for the map
    function pinSvg(spec, ring, square) {
        const outline = 'M12 0C5.4 0 0 5.3 0 11.8 0 20.5 12 32 12 32s12-11.5 12-20.2C24 5.3 18.6 0 12 0z';
        let shape;
        if (spec.bands) {
            const h = 32 / spec.bands.length;
            shape =
                '<clipPath id="p"><path d="' + outline + '"/></clipPath><g clip-path="url(#p)">' +
                spec.bands.map((b, i) =>
                    '<rect x="-1" y="' + (i * h) + '" width="26" height="' + (h + 0.5) + '" fill="' + b + '"/>').join('') +
                '</g><path d="' + outline + '" fill="none" stroke="' + spec.edge + '" stroke-width="1"/>';
        } else {
            shape = '<path d="' + outline + '" fill="' + spec.fill + '" stroke="' + spec.edge + '" stroke-width="1"/>';
        }
        const body = shape +
            (ring
                ? '<circle cx="12" cy="11.8" r="4.8" fill="none" stroke="#fff" stroke-width="2.4"/>'
                : '<circle cx="12" cy="11.8" r="4.6" fill="#fff"/>');
        const svg = square
            ? '<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="-5 -1 34 34">' + body + '</svg>'
            : '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="34" viewBox="-1 -1 26 34">' + body + '</svg>';
        return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    }

    const ICONS = {
        waze: pinSvg(COLORS.waze, false, true),
        google: pinSvg(COLORS.google, true, true),
        mapWaze: pinSvg(COLORS.waze, false, false),
        mapGoogle: pinSvg(COLORS.google, true, false)
    };

    // The page's security policy may block data: images. Test once; fall back to text if so.
    function probeIcons() {
        try {
            const img = doc.createElement('img');
            img.onload = () => { iconsOk = true; };
            img.onerror = () => { iconsOk = false; };
            img.src = ICONS.waze;
        } catch (e) {
            iconsOk = false;
        }
    }

    function sourceOf(venueId) {
        return String(venueId).startsWith('googlePlaces.') ? 'google' : 'waze';
    }

    // ---------- text matching ----------
    function norm(s) {
        return String(s || '')
            .toLowerCase()
            .normalize('NFD').replace(/[̀-ͯ]/g, '')
            .replace(/['’]/g, '')
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
                        warnOnce('http', 'LiveMap returned HTTP ' + r.status + '; showing WME results only.');
                        return resolve([]);
                    }
                    try {
                        const data = JSON.parse(r.responseText);
                        resolve(Array.isArray(data) ? data : []);
                    } catch (e) {
                        warnOnce('parse', 'Unexpected LiveMap response; showing WME results only.');
                        resolve([]);
                    }
                },
                onerror: () => { warnOnce('net', 'LiveMap request failed.'); resolve([]); },
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
            const src = sourceOf(r.id);
            picks.set(id, { lat: r.lat, lng: r.lng, src });
            if (picks.size > 300) picks.delete(picks.keys().next().value);

            const prefix = iconsOk ? '' : (src === 'google' ? '○ Google · ' : '● Waze · ');
            const item = {
                id,
                text: r.name,
                secondaryText: prefix + (r.address ? r.address + ' · ' : '') + distanceText(km, miles)
            };
            if (iconsOk) item.imagePath = ICONS[src];

            out.push({ item, tier: matchTier(r.name, q, tokens), ours: true, dist: km, i });
        });

        out.sort((a, b) =>
            a.tier - b.tier ||
            (b.ours - a.ours) ||
            (a.ours ? a.dist - b.dist : a.i - b.i));

        return out.slice(0, MAX_TOTAL_RESULTS).map(r => r.item);
    }

    // ---------- map pin (SDK layer) ----------
    function ensurePinLayer() {
        if (pinLayerReady) return true;
        const gfx = src => iconsOk
            // graphicOpacity must be set: otherwise the pin takes the fill opacity (0 for the ring) and vanishes
            ? { externalGraphic: src, graphicOpacity: 1, graphicWidth: 26, graphicHeight: 34, graphicXOffset: -13, graphicYOffset: -33 }
            : {};
        try {
            try { sdk.Map.removeLayer({ layerName: PIN_LAYER }); } catch (e) { /* not there yet */ }
            sdk.Map.addLayer({
                layerName: PIN_LAYER,
                styleRules: [
                    {
                        predicate: p => !!p && p.src === 'google',
                        // fallback if the pin graphic can't load: an open green ring
                        style: Object.assign({
                            pointRadius: 12, fillColor: GOOGLE_RING_COLOR, fillOpacity: 0,
                            strokeColor: GOOGLE_RING_COLOR, strokeWidth: 4
                        }, gfx(ICONS.mapGoogle))
                    },
                    {
                        predicate: p => !!p && p.src === 'waze',
                        // fallback: a solid blue dot
                        style: Object.assign({
                            pointRadius: 10, fillColor: COLORS.waze.fill, fillOpacity: 0.9,
                            strokeColor: COLORS.waze.edge, strokeWidth: 2
                        }, gfx(ICONS.mapWaze))
                    }
                ]
            });
            pinLayerReady = true;
        } catch (err) {
            warnOnce('pinlayer', 'Could not create the map pin layer.', err);
        }
        return pinLayerReady;
    }

    function showPin(lat, lng, src) {
        if (!sdk || !ensurePinLayer()) return;
        // clearing may fail (e.g. on an empty layer); that must not stop the draw
        try { sdk.Map.removeAllFeaturesFromLayer({ layerName: PIN_LAYER }); } catch (e) { /* ignore */ }
        try {
            sdk.Map.addFeatureToLayer({
                layerName: PIN_LAYER,
                feature: {
                    type: 'Feature',
                    id: 'wls-pin',
                    geometry: { type: 'Point', coordinates: [lng, lat] },
                    properties: { src }
                }
            });
            pinShown = true;
            pinAddedAt = Date.now();
            if (DEBUG) console.log(LOG, 'pin drawn', src, lat, lng);
        } catch (err) {
            warnOnce('pindraw', 'Could not draw the map pin.', err);
        }
    }

    function clearPin() {
        if (!pinShown) return;
        pinShown = false;
        try {
            sdk.Map.removeAllFeaturesFromLayer({ layerName: PIN_LAYER });
        } catch (e) { /* ignore */ }
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
                warnOnce('merge', 'Search merge failed; showing WME results only.', err);
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
        if (!p) return;
        if (DEBUG) console.log(LOG, 'picked', p.src, 'icons ok:', iconsOk, 'pin layer ready:', pinLayerReady);
        goTo(p.lat, p.lng);
        showPin(p.lat, p.lng, p.src);
    }

    function hook(el) {
        const proto = Object.getPrototypeOf(el);
        const d = Object.getOwnPropertyDescriptor(proto, 'getItems');
        hooked.add(el);
        if (!d || !d.get || !d.set) {
            warnOnce('layout', 'Search box layout changed (no getItems accessor); LiveMap results disabled.');
            return;
        }
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
        probeIcons();
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

        // The pin stays until you select something else or press Esc.
        try {
            sdk.Events.on({
                eventName: 'wme-selection-changed',
                eventHandler: () => {
                    if (Date.now() - pinAddedAt > PIN_IGNORE_SELECTION_MS) clearPin();
                }
            });
        } catch (e) {
            warnOnce('selevent', 'Selection event unavailable; pin clears with Esc only.', e);
        }
        doc.addEventListener('keydown', e => {
            if (e.key === 'Escape') clearPin();
        }, true);

        attach();
        setInterval(attach, 2000);
        console.log(LOG, 'ready');
    }

    init();
})();
