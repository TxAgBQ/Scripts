// ==UserScript==
// @name         WME Search Assist
// @namespace    https://github.com/TxAgBQ
// @version      2026.10.28.02
// @description  Improves the WME search box: LiveMap-style place results (Waze vs Google marked, ranked by match), a pin on the map, and type segment IDs (one or several) or an update request ID to jump straight to them.
// @author       TxAgBQ
// @homepageURL  https://github.com/TxAgBQ/Scripts/tree/main/wme-search-assist
// @updateURL    https://raw.githubusercontent.com/TxAgBQ/Scripts/main/wme-search-assist/wme-search-assist.user.js
// @downloadURL  https://raw.githubusercontent.com/TxAgBQ/Scripts/main/wme-search-assist/wme-search-assist.user.js
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

    const SCRIPT_ID = 'wme-search-assist';
    const SCRIPT_NAME = 'WME Search Assist';
    const LOG = '[' + SCRIPT_NAME + ']';

    // ---- Settings (edit here) ----
    const ZOOM_ON_SELECT = 17;            // zoom after picking a result; the map never zooms OUT to reach it
    const FIT_MULTIPLE_SEGMENTS = false;  // true = zoom out to fit several selected segments; false = just center
    const MAX_LIVEMAP_RESULTS = 10;       // how many LiveMap results to take
    const MAX_TOTAL_RESULTS = 15;         // cap on the merged dropdown list
    const MIN_QUERY_LENGTH = 2;           // don't query LiveMap for shorter text
    const REQUEST_TIMEOUT_MS = 800;       // WME gives the search box ~1000 ms, so stay under it
    const CACHE_TTL_MS = 120000;
    const SEARCH_SELECTOR = '#search-autocomplete';
    const PIN_LAYER = 'wme-search-assist-pin';
    const PIN_IGNORE_SELECTION_MS = 700;  // ignore selection changes right after a pick
    const MIN_SEGMENT_ID_DIGITS = 6;      // shorter numbers (ZIP codes etc.) go through normal search
    const MAX_SEGMENT_IDS = 50;
    const SEG_LOOKUP_BUDGET_MS = 600;     // how long the dropdown waits to say "found / not found"
    const SEG_PREFIX = 'wsa-seg:';
    const UR_PREFIX = 'wsa-ur:';
    const PLACE_PREFIX = 'wsa:';
    const UR_LOAD_ZOOM = 16;              // URs far from the view are loaded by centering at least this close
    const UR_POLL_MS = 400;               // how often to check whether WME has loaded the report
    const UR_LOAD_TRIES = 15;             // x UR_POLL_MS = how long to wait for WME to load it
    const UR_CLICK_TRIES = 10;            // x UR_POLL_MS = how long to wait for the marker to be drawn
    const UR_NEW_TAB_FALLBACK = true;     // URs WME can't place on the map open in a new tab; false = just log a warning

    // Waze = light-blue solid-dot pin. Google = three-band diagonal ring pin.
    // The map pin matches the list icon. Edit the colors here to taste.
    const COLORS = {
        waze: { fill: '#66C3F3', edge: '#2B7BB0' },
        google: { bands: ['#EA4335', '#FBBC04', '#4285F4'], edge: '#4A3A6B' }
    };
    const GOOGLE_RING_COLOR = '#FF9800'; // only used if the pin graphic can't load
    const DEBUG = true; // logs picks to the console; set to false once it works for you

    const doc = unsafeWindow.document;
    const hooked = new WeakSet();
    const picks = new Map();   // our place item id -> { lat, lng, src }
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
            // stripes run from lower left to upper right: horizontal bands rotated 45 degrees counter-clockwise
            const h = 45 / spec.bands.length;
            const y0 = 16 - (spec.bands.length * h) / 2;
            shape =
                '<clipPath id="p"><path d="' + outline + '"/></clipPath><g clip-path="url(#p)">' +
                '<g transform="rotate(-45 12 16)">' +
                spec.bands.map((b, i) =>
                    '<rect x="-30" y="' + (y0 + i * h) + '" width="84" height="' + (h + 0.5) + '" fill="' + b + '"/>').join('') +
                '</g></g><path d="' + outline + '" fill="none" stroke="' + spec.edge + '" stroke-width="1"/>';
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

    // ---------- map movement (never zooms out) ----------
    // The SDK runs in 'async' mode, so every SDK call is awaited.
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    async function targetZoom(minZoom) {
        let z = minZoom;
        try { z = Math.max(await sdk.Map.getZoomLevel(), minZoom); } catch (e) { /* use default */ }
        return z;
    }

    async function centerOn(lon, lat, minZoom = ZOOM_ON_SELECT) {
        const zoomLevel = await targetZoom(minZoom);
        try {
            await sdk.Map.setMapCenter({ lonLat: { lon, lat }, zoomLevel });
        } catch (err) {
            try {
                await sdk.Map.setMapCenter({ lonLat: { lon, lat } });
                await sdk.Map.setZoomLevel({ zoomLevel });
            } catch (err2) {
                console.warn(LOG, 'Could not move the map.', err2);
            }
        }
    }

    // ---------- segment IDs ----------
    // Returns an array of IDs when the whole text is one or more long whole numbers, else null.
    function parseSegmentIds(text) {
        const t = String(text || '').trim();
        if (!t) return null;
        const parts = t.split(/[\s,;]+/).filter(Boolean);
        if (!parts.length || parts.length > MAX_SEGMENT_IDS) return null;
        const re = new RegExp('^\\d{' + MIN_SEGMENT_ID_DIGITS + ',}$');
        if (!parts.every(p => re.test(p))) return null;
        return Array.from(new Set(parts.map(Number)));
    }

    function lookupSegments(ids) {
        return Promise.all(ids.map(id =>
            Promise.resolve()
                .then(() => sdk.DataModel.Segments.findSegment({ segmentId: id }))
                .then(s => s || null)
                .catch(() => null)));
    }

    function flattenPoints(coords, out) {
        if (!Array.isArray(coords)) return out;
        if (typeof coords[0] === 'number') {
            out.push(coords);
            return out;
        }
        coords.forEach(c => flattenPoints(c, out));
        return out;
    }

    function bboxOf(segs) {
        const pts = [];
        segs.forEach(s => flattenPoints(s && s.geometry && s.geometry.coordinates, pts));
        if (!pts.length) return null;
        const xs = pts.map(p => p[0]);
        const ys = pts.map(p => p[1]);
        return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }

    async function frameSegments(segs) {
        const bbox = bboxOf(segs);
        if (!bbox) return;
        if (FIT_MULTIPLE_SEGMENTS && segs.length > 1) {
            try {
                const before = await sdk.Map.getMapCenter();
                await sdk.Map.zoomToExtent({ bbox });
                await sleep(200);
                const after = await sdk.Map.getMapCenter();
                if (after.lon !== before.lon || after.lat !== before.lat) return;
            } catch (err) {
                if (DEBUG) console.log(LOG, 'zoomToExtent failed, centering instead:', String(err).slice(0, 80));
            }
        }
        await centerOn((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2);
    }

    async function selectSegments(ids) {
        if (!sdk) return;
        const segs = (await lookupSegments(ids)).filter(Boolean);
        if (DEBUG) console.log(LOG, 'segment pick:', ids.join(','), 'found', segs.length);
        if (!segs.length) {
            console.warn(LOG, 'None of those segment IDs could be found:', ids.join(', '));
            return;
        }
        if (segs.length < ids.length) {
            console.warn(LOG, 'Not found:', ids.filter(id => !segs.some(s => s.id === id)).join(', '));
        }
        try {
            await sdk.Editing.setSelection({ selection: { objectType: 'segment', ids: segs.map(s => s.id) } });
        } catch (err) {
            console.warn(LOG, 'Could not select the segment(s).', err);
        }
        await frameSegments(segs);
    }

    // Resolves to undefined if the lookup has not finished within the budget (the dropdown must not wait long).
    function withBudget(p) {
        return Promise.race([p, new Promise(r => setTimeout(() => r(undefined), SEG_LOOKUP_BUDGET_MS))]);
    }

    async function segmentRow(ids) {
        return segmentRowFrom(ids, await withBudget(lookupSegments(ids)));
    }

    function segmentRowFrom(ids, segs) {
        const found = segs ? segs.filter(Boolean).length : null;
        const many = ids.length > 1;
        let note;
        if (found === null) note = many ? 'Select them' : 'Select it';
        else if (found === 0) note = many ? 'None found' : 'Not found';
        else if (found === ids.length) note = many ? 'All found · select them' : 'Found · select it';
        else note = found + ' of ' + ids.length + ' found';
        return {
            id: SEG_PREFIX + ids.join(','),
            text: many ? ids.length + ' segments' : 'Segment ' + ids[0],
            secondaryText: note + (many ? ' · ' + ids.join(', ') : '')
        };
    }

    // ---------- update requests (URs) ----------
    // The SDK can read URs that are loaded around the current view, but it cannot look up one that is far
    // away and it cannot select one (setSelection has no update-request type). So:
    //   1. an unloaded UR is found through WME's own by-ID request, which gives the report's route;
    //   2. the map is centered on that route so WME loads the report, and the SDK then finds it;
    //   3. the report is opened by clicking its marker (WME internals, kept in clickUrMarker only).
    async function fetchUrSession(id) {
        const r = await unsafeWindow.fetch('/Descartes/app/MapProblems/UpdateRequests?ids=' + id, { credentials: 'include' });
        if (!r.ok) return null;
        const j = await r.json();
        const list = j && j.updateRequestSessions && j.updateRequestSessions.objects;
        const o = Array.isArray(list) ? list.find(x => x && x.id === id) : null;
        return o || null;
    }

    // Resolves to { ur } when the SDK has it loaded, { session } when it exists but is not loaded, else null.
    async function lookupUr(id) {
        try {
            const ur = await sdk.DataModel.MapUpdateRequests.getById({ mapUpdateRequestId: id });
            if (ur) return { ur };
        } catch (e) { /* fall through to the by-ID request */ }
        try {
            const session = await fetchUrSession(id);
            if (session) return { session };
        } catch (e) { /* not reachable */ }
        return null;
    }

    function geomBbox(geoms) {
        const pts = [];
        geoms.forEach(g => flattenPoints(g && g.coordinates, pts));
        if (!pts.length) return null;
        const xs = pts.map(p => p[0]);
        const ys = pts.map(p => p[1]);
        return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }

    // Sends the clicks a real mouse click would. Uses WME internals: the UR layer's marker element.
    async function clickUrMarker(id) {
        const w = unsafeWindow;
        const layer = w.W && w.W.map && w.W.map.mapUpdateRequestsLayer;
        if (!layer || typeof layer.getWazeFeatureElement !== 'function') return false;
        await sleep(300); // let the recentered map draw
        for (let i = 0; i < UR_CLICK_TRIES; i++) {
            let el = null;
            try { el = layer.getWazeFeatureElement(id); } catch (e) { /* marker not drawn yet */ }
            if (el) {
                const r = el.getBoundingClientRect();
                const opts = { bubbles: true, cancelable: true, view: w, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
                ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(t => {
                    const Ev = t.startsWith('pointer') && w.PointerEvent ? w.PointerEvent : w.MouseEvent;
                    el.dispatchEvent(new Ev(t, opts));
                });
                return true;
            }
            await sleep(UR_POLL_MS);
        }
        return false;
    }

    // Fallback when the map cannot be sent to the report: WME's own link (...&mapUpdateRequest=ID) always finds it.
    // A new tab leaves this editor alone, so unsaved edits are safe.
    function openUrInNewTab(id, why) {
        if (!UR_NEW_TAB_FALLBACK) {
            console.warn(LOG, 'Update request ' + id + ' found, but ' + why + '.');
            return;
        }
        const env = new URLSearchParams(location.search).get('env');
        const url = location.origin + location.pathname + '?' + (env ? 'env=' + encodeURIComponent(env) + '&' : '') +
            'mapUpdateRequest=' + id;
        if (DEBUG) console.log(LOG, 'opening update request ' + id + ' in a new tab (' + why + ')');
        const w = unsafeWindow.open(url, '_blank');
        if (!w) console.warn(LOG, 'The browser blocked the new tab. Allow pop-ups for waze.com, or open: ' + url);
    }

    async function openUr(id) {
        if (!sdk) return;
        const hit = await lookupUr(id);
        if (!hit) {
            console.warn(LOG, 'Update request ' + id + ' could not be found.');
            return;
        }
        let ur = hit.ur || null;
        if (!ur) {
            const box = geomBbox([hit.session.driveGeometry, hit.session.routeGeometry]);
            if (!box) {
                // Many URs have no route, and WME gives no location for an unloaded one by ID.
                openUrInNewTab(id, 'it has no route to jump to');
                return;
            }
            await centerOn((box[0] + box[2]) / 2, (box[1] + box[3]) / 2, UR_LOAD_ZOOM);
            for (let i = 0; i < UR_LOAD_TRIES && !ur; i++) {
                await sleep(UR_POLL_MS);
                try { ur = await sdk.DataModel.MapUpdateRequests.getById({ mapUpdateRequestId: id }); } catch (e) { ur = null; }
            }
            if (!ur) {
                openUrInNewTab(id, 'WME did not load it near its route');
                return;
            }
        }
        const c = ur.geometry && ur.geometry.coordinates;
        if (!c) return;
        await centerOn(c[0], c[1]);
        const opened = await clickUrMarker(id);
        if (DEBUG) console.log(LOG, 'update request pick:', id, 'opened:', opened);
        if (!opened) {
            console.warn(LOG, 'Centered on update request ' + id + ' but could not open it. Check that the UR layer is on and that your filters show this report (for example closed URs).');
        }
    }

    // A single number could be a segment or a UR, so look up both and show whichever exist.
    async function singleIdRows(id) {
        const [segs, urHit] = await Promise.all([withBudget(lookupSegments([id])), withBudget(lookupUr(id))]);
        const segFound = !!(segs && segs[0]);
        const segMissing = !!segs && !segs[0];
        const urFound = !!urHit;
        const urMissing = urHit === null;
        const segRow = segmentRowFrom([id], segs);
        const type = urHit && urHit.ur && urHit.ur.updateRequestType;
        const urRow = {
            id: UR_PREFIX + id,
            text: 'Update request ' + id,
            secondaryText: urFound ? 'Found · ' + (type ? type + ' · ' : '') + 'open it' : (urMissing ? 'Not found' : 'Open it')
        };
        const rows = [];
        if (segFound) rows.push(segRow);
        if (urFound) rows.push(urRow);
        if (!rows.length) {
            if (!segMissing) rows.push(segRow);
            if (!urMissing) rows.push(urRow);
        }
        if (!rows.length) rows.push(segRow, urRow); // neither exists: say so for both
        return rows;
    }

    // ---------- LiveMap request ----------
    function shouldSkip(query) {
        const t = query.trim();
        if (norm(t).length < MIN_QUERY_LENGTH) return true;
        if (/^-?\d+(\.\d+)?\s*[,\s]\s*-?\d+(\.\d+)?$/.test(t)) return true; // coordinates
        if (/^\d{5,}$/.test(t)) return true;                                // long numbers
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
            const id = PLACE_PREFIX + r.id;
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
    async function ensurePinLayer() {
        if (pinLayerReady) return true;
        const gfx = src => iconsOk
            // graphicOpacity must be set: otherwise the pin takes the fill opacity (0 for the ring) and vanishes
            ? { externalGraphic: src, graphicOpacity: 1, graphicWidth: 26, graphicHeight: 34, graphicXOffset: -13, graphicYOffset: -33 }
            : {};
        try {
            try { await sdk.Map.removeLayer({ layerName: PIN_LAYER }); } catch (e) { /* not there yet */ }
            await sdk.Map.addLayer({
                layerName: PIN_LAYER,
                styleRules: [
                    {
                        predicate: p => !!p && p.src === 'google',
                        // fallback if the pin graphic can't load: an open ring
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

    async function showPin(lat, lng, src) {
        if (!sdk || !(await ensurePinLayer())) return;
        // clearing may fail (e.g. on an empty layer); that must not stop the draw
        try { await sdk.Map.removeAllFeaturesFromLayer({ layerName: PIN_LAYER }); } catch (e) { /* ignore */ }
        try {
            await sdk.Map.addFeatureToLayer({
                layerName: PIN_LAYER,
                feature: {
                    type: 'Feature',
                    id: 'wsa-pin',
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

    async function clearPin() {
        if (!pinShown) return;
        pinShown = false;
        try {
            await sdk.Map.removeAllFeaturesFromLayer({ layerName: PIN_LAYER });
        } catch (e) { /* ignore */ }
    }

    // ---------- hook into the WME search box ----------
    function wrapGetItems(orig) {
        if (typeof orig !== 'function' || orig.__wsa) return orig;

        const wrapped = async function (query) {
            const nativeP = Promise.resolve(orig.call(this, query)).catch(() => []);
            try {
                const q = String(query || '');
                if (!sdk) return await nativeP;

                // One or more long numbers: answer right away and skip WME's bogus "latitude, longitude" row.
                // One number can be a segment or an update request; several can only be segments.
                const ids = parseSegmentIds(q);
                if (ids) return ids.length === 1 ? await singleIdRows(ids[0]) : [await segmentRow(ids)];

                if (shouldSkip(q)) return await nativeP;
                const c = await sdk.Map.getMapCenter();
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
        wrapped.__wsa = true;
        return wrapped;
    }

    async function onItemSelected(e) {
        const d = e && e.detail;
        if (!d || typeof d.id !== 'string') return;

        try {
            if (d.id.startsWith(SEG_PREFIX)) {
                await selectSegments(d.id.slice(SEG_PREFIX.length).split(',').map(Number));
                return;
            }
            if (d.id.startsWith(UR_PREFIX)) {
                await openUr(Number(d.id.slice(UR_PREFIX.length)));
                return;
            }

            const p = picks.get(d.id);
            if (!p) return;
            if (DEBUG) console.log(LOG, 'picked', p.src, 'icons ok:', iconsOk, 'pin layer ready:', pinLayerReady);
            await centerOn(p.lng, p.lat);
            await showPin(p.lat, p.lng, p.src);
        } catch (err) {
            console.warn(LOG, 'Could not complete that pick.', err);
        }
    }

    function hook(el) {
        const proto = Object.getPrototypeOf(el);
        const d = Object.getOwnPropertyDescriptor(proto, 'getItems');
        hooked.add(el);
        if (!d || !d.get || !d.set) {
            warnOnce('layout', 'Search box layout changed (no getItems accessor); extra search results disabled.');
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
        // 'async' mode: the old 'sync' mode is deprecated. SDK calls return promises.
        sdk = unsafeWindow.getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME, mode: 'async' });
        try {
            let ready = sdk.State.isReady;
            if (typeof ready === 'function') ready = ready.call(sdk.State);
            if (!(await ready)) await sdk.Events.once({ eventName: 'wme-ready' });
        } catch (e) { /* continue anyway */ }

        // The pin stays until you select something else or press Esc.
        try {
            await sdk.Events.on({
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
