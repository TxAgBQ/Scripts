// ==UserScript==
// @name         WME Water Import
// @namespace    wme-water-import
// @author       TxAgBQ
// @version      2026101803
// @description  Click a creek, river or pond on the map and add it to WME as a Place (River/Stream or Lake) using the FEMA/NOAA water data that GIS Layers also shows. Streams are drawn as a narrow area along the stream. Nothing is saved for you.
// @match        https://beta.waze.com/*editor*
// @match        https://www.waze.com/*editor*
// @grant        unsafeWindow
// @connect      services.arcgis.com
// @downloadURL  https://raw.githubusercontent.com/TxAgBQ/Scripts/main/wme-water-import/WME-Water-Import.user.js
// @updateURL    https://raw.githubusercontent.com/TxAgBQ/Scripts/main/wme-water-import/WME-Water-Import.user.js
// ==/UserScript==

/* global getWmeSdk, unsafeWindow */

(async function () {
    'use strict';

    const SCRIPT_ID = 'wme-water-import';
    const SCRIPT_NAME = 'WME Water Import';
    const COLOUR = '#1a73e8';
    const ROOT = 'https://services.arcgis.com/P3ePLMYs2RVChkJx/ArcGIS/rest/services/';
    const SOURCES = {
        stream: { url: `${ROOT}USA_Detailed_Streams/FeatureServer/0`, label: 'stream' },
        body: { url: `${ROOT}USA_Detailed_Water_Bodies/FeatureServer/0`, label: 'water body' }
    };
    const LAYER = 'wme-water-import-pick';
    const PICK_PX = 12;          // a click this close (in screen pixels) to a stream counts as clicking it
    const JOIN_M = 3;            // stream pieces whose ends are this close are one stream
    const DEFAULT_WIDTH_M = 5;
    const MAX_WIDTH_M = 60;
    const M_LAT = 110574;
    const M_LON = 111320;

    const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    if (pageWin.SDK_INITIALIZED) await pageWin.SDK_INITIALIZED;
    const sdk = pageWin.getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME });
    const isReady = typeof sdk.State?.isReady === 'function' ? sdk.State.isReady() : sdk.State?.isReady;
    if (!isReady) await sdk.Events.once({ eventName: 'wme-ready' });

    const mapDiv = (typeof sdk.Map.getMapViewportElement === 'function' && sdk.Map.getMapViewportElement()) || document.getElementById('map');
    if (!mapDiv) {
        console.error(`[${SCRIPT_NAME}] Map element not found.`);
        return;
    }

    // ------------------------------------------------------------------
    // Geometry (flat, in metres around a local origin; fine for a stream a few km long)
    // ------------------------------------------------------------------
    const project = (origin) => (p) => [(p[0] - origin[0]) * Math.cos(origin[1] * Math.PI / 180) * M_LON, (p[1] - origin[1]) * M_LAT];
    const unproject = (origin) => (m) => [origin[0] + m[0] / (Math.cos(origin[1] * Math.PI / 180) * M_LON), origin[1] + m[1] / M_LAT];

    function distanceM(a, b) {
        const f = project(a);
        const q = f(b);
        return Math.hypot(q[0], q[1]);
    }

    function pointSegDist(p, a, b) {
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
        return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
    }

    function distanceToPath(point, path) {
        const f = project(point);
        let best = Infinity;
        for (let i = 1; i < path.length; i++) best = Math.min(best, pointSegDist([0, 0], f(path[i - 1]), f(path[i])));
        return best;
    }

    function pathLengthM(path) {
        let total = 0;
        for (let i = 1; i < path.length; i++) total += distanceM(path[i - 1], path[i]);
        return total;
    }

    function pointInRing(pt, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i];
            const [xj, yj] = ring[j];
            if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
    }

    // Douglas-Peucker on metre coordinates
    function simplify(pts, tol) {
        if (pts.length < 3) return pts;
        const keep = new Array(pts.length).fill(false);
        keep[0] = keep[pts.length - 1] = true;
        const stack = [[0, pts.length - 1]];
        while (stack.length) {
            const [s, e] = stack.pop();
            let worst = -1;
            let at = -1;
            for (let i = s + 1; i < e; i++) {
                const d = pointSegDist(pts[i], pts[s], pts[e]);
                if (d > worst) { worst = d; at = i; }
            }
            if (worst > tol) {
                keep[at] = true;
                stack.push([s, at], [at, e]);
            }
        }
        return pts.filter((_, i) => keep[i]);
    }

    function segmentsCross(a, b, c, d) {
        const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
        return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
    }

    function ringCrossesItself(ring) {
        const n = ring.length - 1;
        for (let i = 0; i < n; i++) {
            for (let j = i + 2; j < n; j++) {
                if (i === 0 && j === n - 1) continue;
                if (segmentsCross(ring[i], ring[i + 1], ring[j], ring[j + 1])) return true;
            }
        }
        return false;
    }

    // A stream line becomes a narrow area `width` metres across: the line pushed out to each side, joined at the ends.
    // Returns { ring: [[lon,lat]...closed], crosses: boolean }.
    function bufferLine(path, width) {
        const origin = path[0];
        const to = project(origin);
        const from = unproject(origin);
        const metres = path.map(to);
        let result = null;
        for (const tol of [1, 2.5, 5, 10]) {
            const pts = simplify(metres, tol);
            if (pts.length < 2) continue;
            const half = width / 2;
            const left = [];
            const right = [];
            const normals = [];
            for (let i = 1; i < pts.length; i++) {
                const dx = pts[i][0] - pts[i - 1][0];
                const dy = pts[i][1] - pts[i - 1][1];
                const len = Math.hypot(dx, dy) || 1;
                normals.push([-dy / len, dx / len]);
            }
            for (let i = 0; i < pts.length; i++) {
                const a = normals[Math.max(0, i - 1)];
                const b = normals[Math.min(normals.length - 1, i)];
                let nx = a[0] + b[0];
                let ny = a[1] + b[1];
                const nl = Math.hypot(nx, ny) || 1;
                nx /= nl;
                ny /= nl;
                const along = Math.max(0.5, nx * b[0] + ny * b[1]); // keeps a sharp bend from spiking out
                const k = half / along;
                left.push([pts[i][0] + nx * k, pts[i][1] + ny * k]);
                right.push([pts[i][0] - nx * k, pts[i][1] - ny * k]);
            }
            const ring = [...left, ...right.reverse()];
            ring.push(ring[0]);
            result = { ring, crosses: ringCrossesItself(ring) };
            if (!result.crosses) break;
        }
        if (!result) return null;
        return { ring: result.ring.map(from), crosses: result.crosses };
    }

    // Joins stream pieces that meet end to end, starting from `first`; pieces that do not connect are left out.
    function joinFrom(first, others) {
        const near = (a, b) => distanceM(a, b) <= JOIN_M;
        let cur = first.slice();
        const pool = others.map((p) => p.slice());
        let grew = true;
        while (grew) {
            grew = false;
            for (let i = 0; i < pool.length; i++) {
                const q = pool[i];
                const a0 = cur[0];
                const a1 = cur[cur.length - 1];
                const b0 = q[0];
                const b1 = q[q.length - 1];
                if (near(a1, b0)) cur = cur.concat(q.slice(1));
                else if (near(a1, b1)) cur = cur.concat(q.slice(0, -1).reverse());
                else if (near(a0, b1)) cur = q.concat(cur.slice(1));
                else if (near(a0, b0)) cur = q.slice().reverse().concat(cur.slice(1));
                else continue;
                pool.splice(i, 1);
                grew = true;
                break;
            }
        }
        return cur;
    }

    // ------------------------------------------------------------------
    // The water data
    // ------------------------------------------------------------------
    async function arcQuery(source, { where = '1=1', bbox }) {
        const params = new URLSearchParams({
            f: 'json', where, outFields: '*', returnGeometry: 'true', outSR: '4326', inSR: '4326',
            geometryType: 'esriGeometryEnvelope', spatialRel: 'esriSpatialRelIntersects', geometry: bbox.join(','), resultRecordCount: '300'
        });
        const response = await fetch(`${source.url}/query?${params}`);
        if (!response.ok) throw new Error(`the water data server answered ${response.status}`);
        const json = await response.json();
        if (json.error) throw new Error(json.error.message || 'the water data query failed');
        return json.features || [];
    }

    const pathsOf = (feature) => ((feature.geometry && feature.geometry.paths) || []).filter((p) => p.length >= 2).map((p) => p.map((c) => [c[0], c[1]]));
    const ringsOf = (feature) => ((feature.geometry && feature.geometry.rings) || []).filter((r) => r.length >= 4).map((r) => r.map((c) => [c[0], c[1]]));

    // ------------------------------------------------------------------
    // Place categories
    // ------------------------------------------------------------------
    function loadCategories() {
        let raw = [];
        try {
            raw = sdk.DataModel.Venues.getAllVenueCategories() || [];
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Could not read the place categories:`, err);
        }
        const list = raw.map((c) => (typeof c === 'string' ? { id: c, label: c } : { id: c.id ?? c.name, label: c.localizedName || c.name || String(c.id) }))
            .filter((c) => c.id !== undefined && c.id !== null);
        list.sort((a, b) => String(a.label).localeCompare(String(b.label)));
        return list;
    }
    const categories = loadCategories();
    const findCategory = (re) => {
        const hit = categories.find((c) => re.test(String(c.id)) || re.test(String(c.label)));
        return hit ? hit.id : null;
    };

    // ------------------------------------------------------------------
    // Map layer
    // ------------------------------------------------------------------
    let layerReady = false;
    function ensureLayer() {
        if (layerReady) return true;
        try {
            sdk.Map.addLayer({
                layerName: LAYER,
                styleRules: [
                    { predicate: (p) => p.kind === 'area', style: { fillColor: COLOUR, fillOpacity: 0.35, strokeColor: COLOUR, strokeWidth: 2, strokeOpacity: 0.95 } },
                    { predicate: (p) => p.kind === 'line', style: { strokeColor: '#ffd400', strokeWidth: 3, strokeOpacity: 0.95, strokeDashstyle: 'dash' } }
                ]
            });
            layerReady = true;
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Could not add the preview layer:`, err);
        }
        return layerReady;
    }

    function drawPreview() {
        if (!ensureLayer()) return;
        try {
            sdk.Map.removeAllFeaturesFromLayer({ layerName: LAYER });
        } catch (err) { /* empty */ }
        if (!pick) return;
        const features = [];
        const area = currentArea();
        if (area) features.push({ type: 'Feature', id: 'area', geometry: { type: 'Polygon', coordinates: [area.ring] }, properties: { kind: 'area' } });
        if (pick.kind === 'line') features.push({ type: 'Feature', id: 'line', geometry: { type: 'LineString', coordinates: pick.path }, properties: { kind: 'line' } });
        if (!features.length) return;
        try {
            sdk.Map.addFeaturesToLayer({ layerName: LAYER, features });
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Could not draw the preview:`, err);
        }
    }

    // ------------------------------------------------------------------
    // State and panel
    // ------------------------------------------------------------------
    let picking = false;
    let pick = null; // { kind: 'line'|'area', name, desc, path | ring }
    let busy = false;
    let dupeWarned = false;

    const ui = {};
    function el(tag, css, text) {
        const e = document.createElement(tag);
        if (css) e.style.cssText = css;
        if (text !== undefined) e.textContent = text;
        return e;
    }
    function button(text, primary) {
        const b = el('button', `padding: 6px 10px; border-radius: 6px; cursor: pointer; font-size: 13px; border: 1px solid ${COLOUR}; background: ${primary ? COLOUR : '#fff'}; color: ${primary ? '#fff' : COLOUR};`, text);
        b.type = 'button';
        return b;
    }

    const LEVEL_COLOURS = { ok: '#188038', warn: '#c26401', error: '#d93025', info: '#5f6368' };
    function setStatus(message, level = 'info') {
        if (!ui.status) return;
        ui.status.textContent = message;
        ui.status.style.color = LEVEL_COLOURS[level] || LEVEL_COLOURS.info;
    }

    function currentWidth() {
        const w = parseFloat(ui.width.value);
        return Number.isFinite(w) ? Math.min(MAX_WIDTH_M, Math.max(1, w)) : DEFAULT_WIDTH_M;
    }

    // the area to be added for what is picked right now
    function currentArea() {
        if (!pick) return null;
        if (pick.kind === 'area') return { ring: pick.ring, crosses: false };
        return bufferLine(pick.path, currentWidth());
    }

    function renderPanel() {
        const has = !!pick;
        ui.pickBtn.textContent = picking ? 'Click the water on the map (Esc stops)' : 'Pick water on the map';
        ui.pickBtn.style.background = picking ? COLOUR : '#fff';
        ui.pickBtn.style.color = picking ? '#fff' : COLOUR;
        ui.detail.style.display = has ? 'block' : 'none';
        ui.widthRow.style.display = has && pick.kind === 'line' ? 'flex' : 'none';
        ui.addBtn.disabled = !has || busy;
        ui.clearBtn.disabled = !has;
        ui.addBtn.textContent = dupeWarned ? 'Add anyway' : 'Add to the map';
        ui.addBtn.style.opacity = has && !busy ? '1' : '0.5';
        mapDiv.style.cursor = picking ? 'crosshair' : '';
    }

    function clearPick() {
        pick = null;
        dupeWarned = false;
        drawPreview();
        renderPanel();
    }

    // ------------------------------------------------------------------
    // Picking
    // ------------------------------------------------------------------
    function setPicking(on) {
        picking = on;
        if (!on) mapDiv.style.cursor = '';
        renderPanel();
        if (on) setStatus('Click the creek, river or pond on the map.', 'info');
    }

    function mapPadBox() {
        const [a, b, c, d] = sdk.Map.getMapExtent();
        const padX = (c - a) * 0.5;
        const padY = (d - b) * 0.5;
        return [a - padX, b - padY, c + padX, d + padY];
    }

    async function onMapClick(e) {
        if (!picking || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (busy) return;
        busy = true;
        renderPanel();
        try {
            const click = sdk.Map.getLonLatFromPixel({ x: e.clientX, y: e.clientY });
            const beside = sdk.Map.getLonLatFromPixel({ x: e.clientX + PICK_PX, y: e.clientY });
            const here = [click.lon, click.lat];
            const tol = Math.max(4, distanceM(here, [beside.lon, beside.lat]));
            const dLat = tol / M_LAT;
            const dLon = tol / (Math.cos(click.lat * Math.PI / 180) * M_LON);
            const box = [click.lon - dLon, click.lat - dLat, click.lon + dLon, click.lat + dLat];
            setStatus('Looking for water here...', 'info');
            const [streams, bodies] = await Promise.all([arcQuery(SOURCES.stream, { bbox: box }), arcQuery(SOURCES.body, { bbox: box })]);

            // nearest stream within the tolerance
            let best = null;
            for (const f of streams) {
                for (const path of pathsOf(f)) {
                    const d = distanceToPath(here, path);
                    if (d <= tol && (!best || d < best.d)) best = { f, path, d };
                }
            }
            if (best) {
                await pickStream(best.f, best.path);
            } else {
                const body = bodies.find((f) => ringsOf(f).some((r) => pointInRing(here, r)));
                if (!body) {
                    setStatus('No stream or water body in the water data at that spot. Zoom in and click closer to the water.', 'warn');
                } else {
                    const ring = ringsOf(body)[0];
                    const a = body.attributes || {};
                    pick = { kind: 'area', name: (a.NAME || '').trim(), desc: `${a.FCODE_DESC || a.FTYPE || 'Water body'}${a.SQMI ? `, ${Number(a.SQMI).toFixed(2)} sq mi` : ''}`, ring };
                    afterPick();
                }
            }
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Pick failed:`, err);
            setStatus(`Could not read the water data: ${err.message || err}`, 'error');
        } finally {
            busy = false;
            renderPanel();
        }
    }

    async function pickStream(feature, clickedPath) {
        const a = feature.attributes || {};
        const name = (a.NAME || '').trim();
        let path = clickedPath;
        let pieces = 1;
        if (name && ui.whole.checked) {
            const where = `NAME='${name.replace(/'/g, "''")}'`;
            const same = await arcQuery(SOURCES.stream, { where, bbox: mapPadBox() });
            const others = [];
            for (const f of same) for (const p of pathsOf(f)) if (p !== clickedPath && !(f.attributes.OBJECTID === a.OBJECTID && p.length === clickedPath.length && p[0][0] === clickedPath[0][0] && p[0][1] === clickedPath[0][1])) others.push(p);
            path = joinFrom(clickedPath, others);
            pieces = 1 + others.length;
        }
        pick = {
            kind: 'line', name, path,
            desc: `${a.FCODE_DESC ? String(a.FCODE_DESC).replace(/^Stream\/River:\s*Hydrographic Category = /, '') : 'Stream'} stream, ${(pathLengthM(path) / 1000).toFixed(2)} km`,
            pieces
        };
        afterPick();
    }

    function afterPick() {
        dupeWarned = false;
        picking = false;
        ui.name.value = pick.name;
        ui.detail.textContent = `${pick.name || 'Unnamed'}: ${pick.desc}.`;
        const re = pick.kind === 'line' ? /river|stream/i : /sea|lake|pool/i;
        const id = findCategory(re);
        if (id !== null) ui.category.value = String(id);
        const area = currentArea();
        drawPreview();
        renderPanel();
        if (!pick.name) setStatus('This one has no name in the water data. Type the name before adding it.', 'warn');
        else if (area && area.crosses) setStatus(`${pick.name}: ready to add, but the outline crosses itself at a sharp bend. Check it after adding.`, 'warn');
        else setStatus(`${pick.name}: ready. Check the category and the width, then add it.`, 'info');
    }

    // ------------------------------------------------------------------
    // Adding the Place
    // ------------------------------------------------------------------
    function alreadyMapped(name, categoryId) {
        try {
            const want = name.trim().toLowerCase();
            return sdk.DataModel.Venues.getAll().some((v) => (v.name || '').trim().toLowerCase() === want &&
                (v.categories || []).map(String).includes(String(categoryId)));
        } catch (err) {
            return false;
        }
    }

    // Turns the Waze places layer on if it is off, by clicking its toggle in the Map layers panel (so the panel stays in step with the
    // map). If the toggle is not found the SDK is asked instead. Returns true if it had to be switched on.
    function ensurePlacesLayerOn() {
        try {
            if (sdk.Map.isLayerVisible({ layerName: 'venues' })) return false;
            const toggle = document.getElementById('layer-switcher-group_places');
            if (toggle) toggle.click();
            else sdk.Map.setLayerVisibility({ layerName: 'venues', visibility: true });
            return true;
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Could not check or switch on the Places layer:`, err);
            return false;
        }
    }

    function addIt() {
        if (!pick || busy) return;
        const name = ui.name.value.trim();
        const categoryId = categories.find((c) => String(c.id) === ui.category.value)?.id;
        if (categoryId === undefined) {
            setStatus('Choose a category first.', 'warn');
            return;
        }
        if (!name) {
            setStatus('Type a name first (the water data has none for this one).', 'warn');
            return;
        }
        if (!dupeWarned && alreadyMapped(name, categoryId)) {
            dupeWarned = true;
            renderPanel();
            setStatus(`${name} already looks mapped here (a Place with the same name and category is loaded). Press "Add anyway" if this is a different one.`, 'warn');
            return;
        }
        const area = currentArea();
        if (!area) {
            setStatus(`${name}: could not build an outline from this stream.`, 'error');
            return;
        }
        try {
            // WME only shows (and so only saves) a new Place with the Places layer on, so it is switched on first
            ensurePlacesLayerOn();
            const made = sdk.DataModel.Venues.addVenue({ category: categoryId, geometry: { type: 'Polygon', coordinates: [area.ring] } });
            const rawId = made && typeof made === 'object' ? (made.id ?? made.venueId) : made;
            const id = rawId === undefined || rawId === null ? rawId : String(rawId); // WME wants the id as a string, even a negative number
            if (id === undefined || id === null) throw new Error('WME did not say which Place it made');
            try {
                sdk.DataModel.Venues.updateVenue({ venueId: id, name });
            } catch (err) {
                setStatus(`${name}: the area was added, but WME would not take the name (${err.message || err}). Type it in the Place panel.`, 'warn');
                clearAfterAdd(id);
                return;
            }
            // lock the new Place at level 3 (WME counts lock ranks from 0, so level 3 is rank 2); never above the editor's own level
            let lockNote = '';
            try {
                const info = sdk.State.getUserInfo ? sdk.State.getUserInfo() : null;
                const own = info && Number.isFinite(info.rank) ? info.rank : LOCK_RANK;
                const rank = Math.min(LOCK_RANK, own);
                sdk.DataModel.Venues.updateVenue({ venueId: id, lockRank: rank });
                lockNote = ` Locked at level ${rank + 1}.`;
            } catch (err) {
                console.warn(`[${SCRIPT_NAME}] Could not lock the Place:`, err);
                lockNote = ' Could not set the lock level; set it by hand.';
            }
            const label = categories.find((c) => String(c.id) === String(categoryId))?.label || 'Place';
            setStatus(`${name} added as ${label}${pick.kind === 'line' ? `, ${currentWidth()} m wide` : ''}.It is not saved yet: look it over, then save.${lockNote}`, area.crosses || /Could not/.test(lockNote) ? 'warn' : 'ok');
            clearAfterAdd(id);
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Add failed:`, err);
            setStatus(`${name}: WME would not add it (${err.message || err}).`, 'error');
        }
    }

    const LOCK_RANK = 2; // lock level 3

    function clearAfterAdd(id) {
        const keep = ui.status.textContent;
        const colour = ui.status.style.color;
        clearPick();
        ui.status.textContent = keep;
        ui.status.style.color = colour;
        // Clearing the selection (the Place is not left selected) lets WME go back to the script's tab, ready for the next one.
        try {
            if (typeof sdk.Editing.clearSelection === 'function') sdk.Editing.clearSelection();
            else sdk.Editing.setSelection({ selection: { objectType: 'segment', ids: [] } });
        } catch (err) { /* only a convenience */ }
    }

    // ------------------------------------------------------------------
    // Area: outline a stretch of country and add every named stream and river in it
    // ------------------------------------------------------------------
    const WA = {
        LAYER: 'wme-water-import-area',
        TILE_DEG: 0.06,        // water queries are cut into boxes about 6 km across
        PAGE: 1000,            // records asked for per page
        MIN_PIECE_M: 30,       // shorter bits are not worth a Place
        MAX_PIECE_M: 2000,     // a longer stream is added in pieces this long, so no Place gets huge
        COVER_M: 3,            // a stream point this close to an existing Place's edge counts as covered by it
        SAVE_EVERY: 25,
        SAVE_TIMEOUT_MS: 90000,
        DATA_WAIT_MS: 2500,
        MIN_ZOOM: 16,
        WORK_ZOOM: 17
    };
    const wa = { phase: 'idle', points: [], items: [], counts: null, stop: false, lastClick: null, run: null };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // ----- layer -----
    let waLayerReady = false;
    function ensureAreaLayer() {
        if (waLayerReady) return true;
        try {
            sdk.Map.addLayer({
                layerName: WA.LAYER,
                styleRules: [
                    { predicate: (p) => p.kind === 'fill', style: { fillColor: COLOUR, fillOpacity: 0.06, strokeOpacity: 0, strokeWidth: 0 } },
                    { predicate: (p) => p.kind === 'outline', style: { strokeColor: COLOUR, strokeWidth: 3, strokeOpacity: 0.95, strokeDashstyle: 'dash' } },
                    { predicate: (p) => p.kind === 'vertex', style: { pointRadius: 5, fillColor: COLOUR, fillOpacity: 1, strokeColor: '#ffffff', strokeWidth: 2 } },
                    { predicate: (p) => p.kind === 'creek', style: { strokeColor: '#ffd400', strokeWidth: 4, strokeOpacity: 0.95 } },
                    { predicate: (p) => p.kind === 'river', style: { strokeColor: '#00acc1', strokeWidth: 6, strokeOpacity: 0.95 } },
                    { predicate: (p) => p.kind === 'done', style: { strokeColor: '#188038', strokeWidth: 5, strokeOpacity: 0.95 } },
                    { predicate: (p) => p.kind === 'skip', style: { strokeColor: '#9aa0a6', strokeWidth: 3, strokeOpacity: 0.8, strokeDashstyle: 'dash' } }
                ]
            });
            waLayerReady = true;
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Could not add the area layer:`, err);
        }
        return waLayerReady;
    }

    function drawArea() {
        if (!ensureAreaLayer()) return;
        try { sdk.Map.removeAllFeaturesFromLayer({ layerName: WA.LAYER }); } catch (err) { /* empty */ }
        const features = [];
        const pts = wa.points;
        if (pts.length >= 3 && wa.phase !== 'drawing') {
            features.push({ type: 'Feature', id: 'fill', geometry: { type: 'Polygon', coordinates: [[...pts, pts[0]]] }, properties: { kind: 'fill' } });
        }
        if (pts.length >= 2) {
            const line = wa.phase === 'drawing' ? pts : [...pts, pts[0]];
            features.push({ type: 'Feature', id: 'outline', geometry: { type: 'LineString', coordinates: line }, properties: { kind: 'outline' } });
        }
        pts.forEach((p, i) => features.push({ type: 'Feature', id: `v${i}`, geometry: { type: 'Point', coordinates: p }, properties: { kind: 'vertex' } }));
        wa.items.forEach((it, i) => {
            const kind = it.state === 'done' ? 'done' : it.state === 'skipped' ? 'skip' : it.kind;
            features.push({ type: 'Feature', id: `s${i}`, geometry: { type: 'LineString', coordinates: it.path }, properties: { kind } });
        });
        if (!features.length) return;
        try { sdk.Map.addFeaturesToLayer({ layerName: WA.LAYER, features }); } catch (err) { console.warn(`[${SCRIPT_NAME}] Could not draw the area:`, err); }
    }

    // ----- the water data for a whole outline -----
    async function arcQueryPaged(source, bbox, where = '1=1') {
        const all = [];
        for (let offset = 0; offset < 20000; offset += WA.PAGE) {
            const params = new URLSearchParams({
                f: 'json', where, outFields: '*', returnGeometry: 'true', outSR: '4326', inSR: '4326',
                geometryType: 'esriGeometryEnvelope', spatialRel: 'esriSpatialRelIntersects', geometry: bbox.join(','),
                resultRecordCount: String(WA.PAGE), resultOffset: String(offset)
            });
            const response = await fetch(`${source.url}/query?${params}`);
            if (!response.ok) throw new Error(`the water data server answered ${response.status}`);
            const json = await response.json();
            if (json.error) throw new Error(json.error.message || 'the water data query failed');
            all.push(...(json.features || []));
            if (!json.exceededTransferLimit) break;
        }
        return all;
    }

    // the parts of a path inside the outline (each run of inside points, plus the next point out so it reaches the edge)
    function clipToOutline(path, ring) {
        const inside = path.map((p) => pointInRing(p, ring));
        const runs = [];
        let cur = null;
        for (let i = 0; i < path.length; i++) {
            if (inside[i]) {
                if (!cur) { cur = []; if (i > 0) cur.push(path[i - 1]); }
                cur.push(path[i]);
            } else if (cur) {
                cur.push(path[i]);
                runs.push(cur);
                cur = null;
            }
        }
        if (cur) runs.push(cur);
        return runs.filter((r) => r.length >= 2);
    }

    // pieces that meet end to end become one chain
    function chainPieces(pieces) {
        const near = (a, b) => distanceM(a, b) <= JOIN_M;
        const pool = pieces.map((p) => p.slice());
        const out = [];
        while (pool.length) {
            let cur = pool.shift();
            let grew = true;
            while (grew) {
                grew = false;
                for (let i = 0; i < pool.length; i++) {
                    const q = pool[i];
                    const a0 = cur[0]; const a1 = cur[cur.length - 1]; const b0 = q[0]; const b1 = q[q.length - 1];
                    if (near(a1, b0)) cur = cur.concat(q.slice(1));
                    else if (near(a1, b1)) cur = cur.concat(q.slice(0, -1).reverse());
                    else if (near(a0, b1)) cur = q.concat(cur.slice(1));
                    else if (near(a0, b0)) cur = q.slice().reverse().concat(cur.slice(1));
                    else continue;
                    pool.splice(i, 1);
                    grew = true;
                    break;
                }
            }
            out.push(cur);
        }
        return out;
    }

    // a long path cut into pieces no longer than `max` metres (the cut points are made up on the line)
    function splitPath(path, max) {
        if (pathLengthM(path) <= max * 1.15) return [path];
        const pieces = [];
        let cur = [path[0]];
        let acc = 0;
        for (let i = 1; i < path.length; i++) {
            let a = path[i - 1];
            const b = path[i];
            let seg = distanceM(a, b);
            while (acc + seg > max && seg > 0) {
                const t = (max - acc) / seg;
                const cut = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
                cur.push(cut);
                pieces.push(cur);
                cur = [cut];
                a = cut;
                seg = distanceM(a, b);
                acc = 0;
            }
            cur.push(b);
            acc += seg;
        }
        if (cur.length >= 2) {
            if (pieces.length && pathLengthM(cur) < WA.MIN_PIECE_M) pieces[pieces.length - 1].push(...cur.slice(1));
            else pieces.push(cur);
        }
        return pieces;
    }

    async function waPreview() {
        if (wa.points.length < 3 || wa.phase === 'previewing' || wa.phase === 'running') return;
        wa.phase = 'previewing';
        wa.stop = false;
        wa.items = [];
        wa.counts = null;
        renderAreaPanel();
        const ring = [...wa.points, wa.points[0]];
        const lons = wa.points.map((p) => p[0]);
        const lats = wa.points.map((p) => p[1]);
        const box = { minLon: Math.min(...lons), maxLon: Math.max(...lons), minLat: Math.min(...lats), maxLat: Math.max(...lats) };
        const tiles = [];
        for (let lon = box.minLon; lon < box.maxLon; lon += WA.TILE_DEG) {
            for (let lat = box.minLat; lat < box.maxLat; lat += WA.TILE_DEG) {
                tiles.push([lon, lat, Math.min(lon + WA.TILE_DEG, box.maxLon), Math.min(lat + WA.TILE_DEG, box.maxLat)]);
            }
        }
        const counts = { found: 0, unnamed: 0, intermittent: 0, other: 0, tooShort: 0, creeks: 0, rivers: 0 };
        try {
            const seen = new Map();
            for (let i = 0; i < tiles.length; i++) {
                if (wa.stop) break;
                setAreaStatus(`Looking up streams (${i + 1} of ${tiles.length})...`, 'info');
                const feats = await arcQueryPaged(SOURCES.stream, tiles[i]);
                for (const f of feats) {
                    const id = f.attributes && f.attributes.OBJECTID;
                    if (id !== undefined && seen.has(id)) continue;
                    seen.set(id, f);
                }
            }
            if (wa.stop) {
                wa.phase = wa.points.length >= 3 ? 'ready' : 'idle';
                setAreaStatus('Stopped.', 'info');
                renderAreaPanel();
                return;
            }
            const includeIntermittent = ui.aIntermittent.checked;
            const groups = new Map();
            for (const f of seen.values()) {
                const a = f.attributes || {};
                const runs = [];
                for (const p of pathsOf(f)) runs.push(...clipToOutline(p, ring));
                if (!runs.length) continue;
                counts.found++;
                const name = String(a.NAME || '').trim();
                const desc = String(a.FCODE_DESC || '');
                if (!name) { counts.unnamed++; continue; }
                if (!/^Stream\/River/i.test(desc)) { counts.other++; continue; }
                if (!includeIntermittent && !/Perennial/i.test(desc)) { counts.intermittent++; continue; }
                const key = name.toLowerCase();
                if (!groups.has(key)) groups.set(key, { name, pieces: [] });
                groups.get(key).pieces.push(...runs);
            }
            const creekW = Math.min(MAX_WIDTH_M, Math.max(1, parseFloat(ui.aCreekW.value) || 15));
            const riverW = Math.min(MAX_WIDTH_M, Math.max(1, parseFloat(ui.aRiverW.value) || 24));
            const maxPiece = Math.max(200, parseFloat(ui.aMaxLen.value) || WA.MAX_PIECE_M);
            for (const g of groups.values()) {
                const kind = /\briver\b/i.test(g.name) ? 'river' : 'creek';
                for (const chain of chainPieces(g.pieces)) {
                    for (const part of splitPath(chain, maxPiece)) {
                        const len = pathLengthM(part);
                        if (len < WA.MIN_PIECE_M) { counts.tooShort++; continue; }
                        wa.items.push({ name: g.name, kind, width: kind === 'river' ? riverW : creekW, path: part, lengthM: len, state: 'new', note: '' });
                        counts[kind === 'river' ? 'rivers' : 'creeks']++;
                    }
                }
            }
            wa.items.sort((a, b) => a.name.localeCompare(b.name) || a.path[0][1] - b.path[0][1]);
            wa.counts = counts;
            wa.phase = wa.items.length ? 'previewed' : 'ready';
            drawArea();
            const km = (wa.items.reduce((s, it) => s + it.lengthM, 0) / 1000).toFixed(1);
            const skipped = [counts.unnamed && `${counts.unnamed} unnamed`, counts.intermittent && `${counts.intermittent} intermittent`, counts.other && `${counts.other} canals/other`, counts.tooShort && `${counts.tooShort} too short`].filter(Boolean).join(', ');
            setAreaStatus(wa.items.length
                ? `${wa.items.length} pieces to add (${counts.creeks} creek at ${creekW} m, ${counts.rivers} river at ${riverW} m), ${km} km in all.${skipped ? ` Left out: ${skipped}.` : ''} Press Go to add them.`
                : `Nothing to add in that outline.${skipped ? ` Left out: ${skipped}.` : ''}`, wa.items.length ? 'ok' : 'warn');
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Area preview failed:`, err);
            wa.phase = 'ready';
            setAreaStatus(`Could not read the water data: ${err.message || err}`, 'error');
        }
        renderAreaPanel();
    }

    // ----- save (the same DOM routine the Segment Importer uses) -----
    const saveButton = () => document.getElementById('save-button');
    async function waSave() {
        const btn = saveButton();
        if (!btn) return { ok: false, why: "WME's Save button is not on the page right now." };
        if (btn.hasAttribute('disabled')) return { ok: true, nothing: true };
        const inner = btn.shadowRoot && btn.shadowRoot.querySelector('button');
        if (!inner) return { ok: false, why: "Could not press WME's Save button." };
        inner.click();
        const start = Date.now();
        await sleep(300);
        while (Date.now() - start < WA.SAVE_TIMEOUT_MS) {
            const pop = document.querySelector('.save-popover');
            const title = pop && pop.querySelector('.actions-title');
            if (pop && title && /save anyway/i.test(title.textContent || '')) {
                const raw = ((pop.querySelector('.error-list') || pop).textContent || '').replace(/\s+/g, ' ').trim();
                return { ok: false, warnings: true, why: raw.length > 400 ? `${raw.slice(0, 400)}...` : raw };
            }
            const current = saveButton();
            if (!current) return { ok: false, why: "WME's Save button went away while saving." };
            if (current.hasAttribute('disabled') && !current.hasAttribute('busy')) {
                await sleep(600);
                return { ok: true };
            }
            await sleep(100);
        }
        return { ok: false, why: `Saving took longer than ${Math.round(WA.SAVE_TIMEOUT_MS / 1000)} seconds.` };
    }

    // ----- bringing a piece into view so WME holds the Places around it -----
    async function waShow(path) {
        const lons = path.map((p) => p[0]);
        const lats = path.map((p) => p[1]);
        const bbox = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
        try {
            if (bbox[2] - bbox[0] < 0.004 && bbox[3] - bbox[1] < 0.004) {
                if (sdk.Map.getZoomLevel() < WA.MIN_ZOOM && typeof sdk.Map.setZoomLevel === 'function') sdk.Map.setZoomLevel({ zoomLevel: WA.WORK_ZOOM });
                sdk.Map.setMapCenter({ lonLat: { lon: (bbox[0] + bbox[2]) / 2, lat: (bbox[1] + bbox[3]) / 2 } });
            } else {
                sdk.Map.zoomToExtent({ bbox });
            }
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Could not move the map:`, err);
        }
        await Promise.race([sdk.Events.once({ eventName: 'wme-map-data-loaded' }).catch(() => null), sleep(WA.DATA_WAIT_MS)]);
        await sleep(300);
    }

    // the parts of `path` not already covered by a loaded Place of the same name (null = none loaded)
    function uncoveredRuns(path, name) {
        const want = name.toLowerCase();
        let rings = [];
        try {
            for (const v of sdk.DataModel.Venues.getAll()) {
                if ((v.name || '').trim().toLowerCase() !== want || !v.geometry) continue;
                if (v.geometry.type === 'Polygon') rings.push(v.geometry.coordinates[0]);
                else if (v.geometry.type === 'MultiPolygon') v.geometry.coordinates.forEach((poly) => rings.push(poly[0]));
            }
        } catch (err) {
            return null;
        }
        if (!rings.length) return null;
        const edgeDist = (pt, ring) => {
            const f = project(pt);
            let best = Infinity;
            for (let i = 1; i < ring.length; i++) best = Math.min(best, pointSegDist([0, 0], f(ring[i - 1]), f(ring[i])));
            return best;
        };
        const covered = path.map((p) => rings.some((r) => pointInRing(p, r) || edgeDist(p, r) <= WA.COVER_M));
        if (!covered.some(Boolean)) return { covered: 0, runs: [path] };
        const runs = [];
        let cur = null;
        for (let i = 0; i < path.length; i++) {
            if (!covered[i]) {
                if (!cur) { cur = []; if (i > 0) cur.push(path[i - 1]); }
                cur.push(path[i]);
            } else if (cur) {
                cur.push(path[i]);
                runs.push(cur);
                cur = null;
            }
        }
        if (cur) runs.push(cur);
        return { covered: covered.filter(Boolean).length / path.length, runs: runs.filter((r) => r.length >= 2 && pathLengthM(r) >= WA.MIN_PIECE_M) };
    }

    function addPlace(name, categoryId, ring) {
        const made = sdk.DataModel.Venues.addVenue({ category: categoryId, geometry: { type: 'Polygon', coordinates: [ring] } });
        const raw = made && typeof made === 'object' ? (made.id ?? made.venueId) : made;
        if (raw === undefined || raw === null) throw new Error('WME did not say which Place it made');
        const id = String(raw);
        sdk.DataModel.Venues.updateVenue({ venueId: id, name });
        try {
            const info = sdk.State.getUserInfo ? sdk.State.getUserInfo() : null;
            const own = info && Number.isFinite(info.rank) ? info.rank : LOCK_RANK;
            sdk.DataModel.Venues.updateVenue({ venueId: id, lockRank: Math.min(LOCK_RANK, own) });
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Could not lock the Place:`, err);
        }
        return id;
    }

    async function waRun() {
        if (wa.phase !== 'previewed' || !wa.items.length) return;
        const categoryId = findCategory(/river|stream/i);
        if (categoryId === null) { setAreaStatus('Could not find the River/Stream category.', 'error'); return; }
        wa.phase = 'running';
        wa.stop = false;
        busy = true;
        renderAreaPanel();
        ensurePlacesLayerOn();
        const mode = ui.aExisting.value; // missing | skip | add
        const run = { added: 0, skippedMapped: 0, partial: 0, failed: [], saved: 0, sinceSave: 0, done: 0 };
        wa.run = run;
        let stoppedWhy = '';
        try {
            for (let i = 0; i < wa.items.length; i++) {
                if (wa.stop) { stoppedWhy = 'Stopped by you.'; break; }
                const it = wa.items[i];
                setAreaStatus(`${it.name}: ${i + 1} of ${wa.items.length}. ${run.added} added, ${run.saved} saves.`, 'info');
                try {
                    await waShow(it.path);
                    let runs = [it.path];
                    if (mode !== 'add') {
                        const found = uncoveredRuns(it.path, it.name);
                        if (found) {
                            if (!found.runs.length || (mode === 'skip' && found.covered > 0)) {
                                it.state = 'skipped';
                                it.note = 'already mapped';
                                run.skippedMapped++;
                                run.done++;
                                continue;
                            }
                            if (found.covered > 0) run.partial++;
                            runs = found.runs;
                        }
                    }
                    for (const part of runs) {
                        const area = bufferLine(part, it.width);
                        if (!area) throw new Error('could not build an outline');
                        addPlace(it.name, categoryId, area.ring);
                        run.added++;
                        run.sinceSave++;
                    }
                    it.state = 'done';
                } catch (err) {
                    console.warn(`[${SCRIPT_NAME}] ${it.name} failed:`, err);
                    it.state = 'failed';
                    run.failed.push(`${it.name}: ${err.message || err}`);
                }
                run.done++;
                if (run.sinceSave >= WA.SAVE_EVERY) {
                    setAreaStatus(`Saving ${run.sinceSave} Places...`, 'info');
                    const saved = await waSave();
                    if (!saved.ok) {
                        stoppedWhy = saved.warnings
                            ? `WME asks "Save anyway?" so the run stopped. Read the popover, fix what it names, then Save yourself. WME says: ${saved.why}`
                            : `The save did not finish: ${saved.why}`;
                        break;
                    }
                    run.saved++;
                    run.sinceSave = 0;
                }
                drawArea();
                await sleep(150);
            }
            if (!stoppedWhy && run.sinceSave > 0) {
                setAreaStatus(`Saving the last ${run.sinceSave} Places...`, 'info');
                const saved = await waSave();
                if (!saved.ok) stoppedWhy = saved.warnings ? `WME asks "Save anyway?" for the last batch. Read the popover, then Save yourself. WME says: ${saved.why}` : `The last save did not finish: ${saved.why}`;
                else { run.saved++; run.sinceSave = 0; }
            }
        } finally {
            busy = false;
            wa.phase = 'done';
            drawArea();
        }
        const bits = [`${run.added} Places added`, run.saved ? `${run.saved} saves` : '', run.partial ? `${run.partial} streams joined onto what was already mapped` : '', run.skippedMapped ? `${run.skippedMapped} skipped as already mapped` : '', run.failed.length ? `${run.failed.length} failed` : ''].filter(Boolean);
        const unsaved = run.sinceSave ? ` ${run.sinceSave} not saved yet.` : '';
        setAreaStatus(`${stoppedWhy ? `${stoppedWhy} ` : 'Done. '}${bits.join(', ')}.${unsaved}${run.failed.length ? ` Failed: ${run.failed.slice(0, 5).join('; ')}` : ''}`, stoppedWhy || run.failed.length ? 'warn' : 'ok');
        renderAreaPanel();
    }

    // ----- drawing the outline -----
    const waPress = { down: false, x: 0, y: 0, moved: false, drag: false };
    window.addEventListener('mousedown', (e) => {
        waPress.drag = false;
        waPress.down = e.button === 0 && e.target instanceof Node && mapDiv.contains(e.target);
        Object.assign(waPress, { x: e.clientX, y: e.clientY, moved: false });
    }, true);
    window.addEventListener('mousemove', (e) => {
        if (waPress.down && !waPress.moved && Math.hypot(e.clientX - waPress.x, e.clientY - waPress.y) > 5) waPress.moved = true;
    }, true);
    window.addEventListener('mouseup', () => { waPress.drag = waPress.down && waPress.moved; waPress.down = false; }, true);

    mapDiv.addEventListener('click', (e) => {
        if (wa.phase !== 'drawing' || !e.isTrusted) return;
        if (waPress.drag) { waPress.drag = false; return; } // the map was being panned
        e.stopImmediatePropagation();
        e.stopPropagation();
        e.preventDefault();
        const now = Date.now();
        const last = wa.lastClick;
        if (last && now - last.t < 450 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 8) { waFinishDrawing(); return; } // double-click closes it
        wa.lastClick = { t: now, x: e.clientX, y: e.clientY };
        const ll = sdk.Map.getLonLatFromPixel({ x: e.clientX, y: e.clientY });
        wa.points.push([ll.lon, ll.lat]);
        drawArea();
        renderAreaPanel();
    }, true);

    function waStartDrawing() {
        if (wa.phase === 'running' || wa.phase === 'previewing') return;
        wa.phase = 'drawing';
        wa.points = [];
        wa.items = [];
        wa.counts = null;
        wa.lastClick = null;
        if (picking) setPicking(false);
        setAreaStatus('Click the corners of the area on the map. Double-click the last corner (or press Finish) to close it. Escape cancels.', 'info');
        drawArea();
        renderAreaPanel();
    }

    function waFinishDrawing() {
        if (wa.phase !== 'drawing') return;
        // a double-click adds the same corner twice; drop the repeat
        const n = wa.points.length;
        if (n >= 2 && Math.hypot(wa.points[n - 1][0] - wa.points[n - 2][0], wa.points[n - 1][1] - wa.points[n - 2][1]) < 1e-7) wa.points.pop();
        if (wa.points.length < 3) {
            wa.phase = 'idle';
            wa.points = [];
            setAreaStatus('An outline needs at least 3 corners. Press Draw outline to try again.', 'warn');
        } else {
            wa.phase = 'ready';
            setAreaStatus('Outline closed. Press Preview to see what it would add.', 'info');
        }
        drawArea();
        renderAreaPanel();
    }

    function waClear() {
        if (wa.phase === 'running') return;
        wa.phase = 'idle';
        wa.points = [];
        wa.items = [];
        wa.counts = null;
        drawArea();
        setAreaStatus('Cleared.', 'info');
        renderAreaPanel();
    }

    function setAreaStatus(message, level = 'info') {
        if (!ui.aStatus) return;
        ui.aStatus.textContent = message;
        ui.aStatus.style.color = LEVEL_COLOURS[level] || LEVEL_COLOURS.info;
    }

    function renderAreaPanel() {
        if (!ui.aDraw) return;
        const p = wa.phase;
        ui.aDraw.textContent = p === 'drawing' ? 'Finish outline' : 'Draw outline';
        ui.aDraw.disabled = p === 'running' || p === 'previewing';
        ui.aPreview.disabled = !(p === 'ready' || p === 'previewed' || p === 'done');
        ui.aGo.disabled = p !== 'previewed';
        ui.aStop.disabled = !(p === 'running' || p === 'previewing');
        ui.aClear.disabled = p === 'running' || p === 'idle';
        for (const b of [ui.aDraw, ui.aPreview, ui.aGo, ui.aStop, ui.aClear]) b.style.opacity = b.disabled ? '0.5' : '1';
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && wa.phase === 'drawing') {
            wa.phase = 'idle';
            wa.points = [];
            drawArea();
            setAreaStatus('Outline cancelled.', 'info');
            renderAreaPanel();
        }
    });

    // ------------------------------------------------------------------
    // Sidebar tab
    // ------------------------------------------------------------------
    const { tabLabel, tabPane } = await sdk.Sidebar.registerScriptTab();
    tabLabel.textContent = '💧';
    tabLabel.title = SCRIPT_NAME;

    tabPane.style.cssText = 'padding: 10px; font-size: 13px;';
    tabPane.appendChild(el('div', 'font-weight: 700; font-size: 15px; margin-bottom: 4px;', SCRIPT_NAME));
    tabPane.appendChild(el('div', 'color: #5f6368; margin-bottom: 8px;', 'Adds a creek, river or pond from the FEMA/NOAA water data as a Place. Nothing is saved for you.'));

    ui.pickBtn = button('Pick water on the map', false);
    ui.pickBtn.style.width = '100%';
    ui.pickBtn.addEventListener('click', () => setPicking(!picking));
    tabPane.appendChild(ui.pickBtn);

    const wholeRow = el('label', 'display: flex; align-items: center; gap: 6px; margin: 8px 0;');
    ui.whole = el('input');
    ui.whole.type = 'checkbox';
    ui.whole.checked = true;
    wholeRow.append(ui.whole, el('span', '', 'Take the whole creek (all pieces with the same name in view)'));
    tabPane.appendChild(wholeRow);

    ui.detail = el('div', 'margin: 8px 0; padding: 6px 8px; background: #f1f3f4; border-radius: 6px; display: none;');
    tabPane.appendChild(ui.detail);

    const nameRow = el('div', 'display: flex; align-items: center; gap: 6px; margin: 6px 0;');
    ui.name = el('input', 'flex: 1; padding: 4px 6px;');
    ui.name.type = 'text';
    ui.name.placeholder = 'Name';
    nameRow.append(el('span', 'width: 70px;', 'Name'), ui.name);
    tabPane.appendChild(nameRow);

    const catRow = el('div', 'display: flex; align-items: center; gap: 6px; margin: 6px 0;');
    ui.category = el('select', 'flex: 1; padding: 4px;');
    for (const c of categories) {
        const o = document.createElement('option');
        o.value = String(c.id);
        o.textContent = c.label;
        ui.category.appendChild(o);
    }
    catRow.append(el('span', 'width: 70px;', 'Category'), ui.category);
    tabPane.appendChild(catRow);

    ui.widthRow = el('div', 'display: none; align-items: center; gap: 6px; margin: 6px 0;');
    ui.width = el('input', 'width: 70px; padding: 4px 6px;');
    ui.width.type = 'number';
    ui.width.min = '1';
    ui.width.max = String(MAX_WIDTH_M);
    ui.width.value = String(DEFAULT_WIDTH_M);
    ui.width.addEventListener('input', () => { drawPreview(); });
    ui.widthRow.append(el('span', 'width: 70px;', 'Width (m)'), ui.width);
    tabPane.appendChild(ui.widthRow);

    const actions = el('div', 'display: flex; gap: 8px; margin-top: 8px;');
    ui.addBtn = button('Add to the map', true);
    ui.addBtn.addEventListener('click', addIt);
    ui.clearBtn = button('Clear', false);
    ui.clearBtn.addEventListener('click', () => { clearPick(); setStatus('Cleared.', 'info'); });
    actions.append(ui.addBtn, ui.clearBtn);
    tabPane.appendChild(actions);

    ui.status = el('div', 'margin-top: 10px; min-height: 36px; color: #5f6368;');
    tabPane.appendChild(ui.status);


    // ----- Area section -----
    tabPane.appendChild(el('hr', 'margin: 14px 0 10px; border: none; border-top: 1px solid #dadce0;'));
    tabPane.appendChild(el('div', 'font-weight: 700; font-size: 14px; margin-bottom: 4px;', 'Whole area'));
    tabPane.appendChild(el('div', 'color: #5f6368; margin-bottom: 8px;', 'Outline an area and add every named stream and river in it. Saves every 25.'));

    const numRow = (label, value, min, max) => {
        const row = el('div', 'display: flex; align-items: center; gap: 6px; margin: 4px 0;');
        const input = el('input', 'width: 70px; padding: 4px 6px;');
        input.type = 'number';
        input.min = String(min);
        input.max = String(max);
        input.value = String(value);
        row.append(el('span', 'width: 120px;', label), input);
        tabPane.appendChild(row);
        return input;
    };
    ui.aCreekW = numRow('Creek width (m)', 15, 1, MAX_WIDTH_M);
    ui.aRiverW = numRow('River width (m)', 24, 1, MAX_WIDTH_M);
    ui.aMaxLen = numRow('Longest piece (m)', WA.MAX_PIECE_M, 200, 10000);

    const intRow = el('label', 'display: flex; align-items: center; gap: 6px; margin: 6px 0;');
    ui.aIntermittent = el('input');
    ui.aIntermittent.type = 'checkbox';
    ui.aIntermittent.checked = true;
    intRow.append(ui.aIntermittent, el('span', '', 'Include intermittent streams'));
    tabPane.appendChild(intRow);

    const exRow = el('div', 'display: flex; align-items: center; gap: 6px; margin: 6px 0;');
    ui.aExisting = el('select', 'flex: 1; padding: 4px;');
    for (const [value, label] of [['missing', 'Add only the part not already mapped'], ['skip', 'Skip any that are partly mapped'], ['add', 'Add everything, even if mapped']]) {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = label;
        ui.aExisting.appendChild(o);
    }
    exRow.append(el('span', 'width: 120px;', 'Already mapped'), ui.aExisting);
    tabPane.appendChild(exRow);
    tabPane.appendChild(el('div', 'color: #5f6368; font-size: 12px; margin-bottom: 6px;', 'A Place counts as the same stream if it has the same name. Only Places WME has loaded can be seen; the run moves the map along each stream.'));

    const aRow1 = el('div', 'display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap;');
    ui.aDraw = button('Draw outline', false);
    ui.aDraw.addEventListener('click', () => (wa.phase === 'drawing' ? waFinishDrawing() : waStartDrawing()));
    ui.aPreview = button('Preview', false);
    ui.aPreview.addEventListener('click', waPreview);
    ui.aGo = button('Go', true);
    ui.aGo.addEventListener('click', waRun);
    ui.aStop = button('Stop', false);
    ui.aStop.addEventListener('click', () => { wa.stop = true; });
    ui.aClear = button('Clear', false);
    ui.aClear.addEventListener('click', waClear);
    aRow1.append(ui.aDraw, ui.aPreview, ui.aGo, ui.aStop, ui.aClear);
    tabPane.appendChild(aRow1);

    ui.aStatus = el('div', 'margin-top: 10px; min-height: 36px; color: #5f6368; user-select: text;');
    tabPane.appendChild(ui.aStatus);
    setAreaStatus('Press "Draw outline", click the corners, then Preview.', 'info');
    renderAreaPanel();

    if (!categories.length) setStatus('WME did not give a list of place categories, so nothing can be added. Reload WME and try again.', 'error');
    else setStatus('Press "Pick water on the map", then click the water.', 'info');

    // clicks while picking are taken here, before WME selects anything
    mapDiv.addEventListener('click', onMapClick, true);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && picking) {
            setPicking(false);
            setStatus('Stopped picking.', 'info');
        }
    });

    renderPanel();
    console.log(`[${SCRIPT_NAME}] ready, ${categories.length} place categories.`);
})();
