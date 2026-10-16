// ==UserScript==
// @name         WME Segment Importer
// @namespace    wme-segment-importer
// @author       TxAgBQ
// @version      2026101502
// @description  Imports roads from county GIS into WME (joins nodes, extends stubs, names streets and cities), imports everything inside an outlined area in one run (and fixes the flagged segments there), adds house numbers, and highlights segments missing a street name or city, and checks the city info of the segment you are editing. Uses WME GIS Layers outside Kendall County, TX. Can name an unnamed road from a Google Maps right-click.
// @match        https://beta.waze.com/*editor*
// @match        https://www.waze.com/*editor*
// @match        https://www.google.com/maps
// @match        https://www.google.com/maps/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @connect      raw.githubusercontent.com
// @connect      services2.arcgis.com
// @connect      docs.google.com
// @connect      tigerweb.geo.census.gov
// @connect      *
// @downloadURL  https://raw.githubusercontent.com/TxAgBQ/Scripts/refs/heads/main/wme-segment-importer/WME-Segment-Importer.user.js
// @updateURL    https://raw.githubusercontent.com/TxAgBQ/Scripts/refs/heads/main/wme-segment-importer/WME-Segment-Importer.user.js
// ==/UserScript==

/* global getWmeSdk, unsafeWindow, GM_xmlhttpRequest, GM_setValue, GM_getValue, GM_info */

(async function () {
    'use strict';

    const SCRIPT_ID = 'wme-segment-importer';
    const SCRIPT_NAME = 'WME Segment Importer';
    // Roads are purple-pink and house numbers aquamarine everywhere: buttons, switches and the map cursor.
    const COLOUR_ROADS = '#862791';
    const COLOUR_HOUSES = '#03f5f6';
    const COLOUR_CLEANUP = '#500000'; // maroon: the Snap button
    const SCRIPT_VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || 'unknown';

    // ------------------------------------------------------------------
    // Google Maps tab: remember the street named in the right-click panel
    // ------------------------------------------------------------------
    // Right-click a street in Google Maps and its panel shows the road name and the click point as plain text. This keeps the
    // latest one (Tampermonkey shares it between tabs) so a click on an unnamed segment in WME can use that name.
    const GOOGLE_STREET_KEY = 'wme_gis_importer_google_street_v1';

    function watchGoogleMaps() {
        // "Rockwall Pass, Schertz, TX 78108" (a road) or "6320 Black Butte, Schertz, TX 78108" (a house); and "29.627304, -98.214525"
        const ADDRESS = /^(.+?),\s*([^,]+),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?(?:,\s*(?:USA|United States))?$/;
        const COORDS = /^(-?\d{1,3}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})$/;
        let lastKey = '';
        let timer = null;

        const toast = (text) => {
            const note = document.createElement('div');
            note.textContent = text;
            note.style.cssText = 'position: fixed; left: 50%; bottom: 90px; transform: translateX(-50%); z-index: 2147483647; background: #202124; ' +
                'color: #ffffff; font: 13px sans-serif; padding: 8px 12px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.4); pointer-events: none;';
            document.body.appendChild(note);
            setTimeout(() => note.remove(), 3500);
        };

        const scan = () => {
            if (document.hidden) return;
            let addressText = '';
            let coordText = '';
            for (const el of document.querySelectorAll('span, button')) {
                if (el.children.length || !el.offsetParent) continue;
                const t = (el.textContent || '').trim();
                if (!t || t.length > 120) continue;
                if (!addressText && ADDRESS.test(t)) addressText = t;
                else if (!coordText && COORDS.test(t)) coordText = t;
                if (addressText && coordText) break;
            }
            // both are needed: the click point is what ties the name to a spot (search result lists show addresses without it)
            if (!addressText || !coordText) return;
            const key = `${addressText}|${coordText}`;
            if (key === lastKey) return;
            lastKey = key;
            const a = addressText.match(ADDRESS);
            const c = coordText.match(COORDS);
            const house = a[1].match(/^(\d+[A-Za-z]?(?:-\d+)?)\s+(.+)$/);
            const record = {
                name: house ? house[2] : a[1], kind: house ? 'address' : 'road', houseNumber: house ? house[1] : '',
                city: a[2], state: a[3], zip: a[4], full: addressText, lat: Number(c[1]), lon: Number(c[2]), at: Date.now()
            };
            try {
                GM_setValue(GOOGLE_STREET_KEY, JSON.stringify(record));
                toast(`${SCRIPT_NAME}: copied "${record.name}" (${record.kind === 'address' ? 'from a house address, ' : ''}${record.city} ${record.zip})`);
            } catch (err) {
                console.warn(`[${SCRIPT_NAME}] Could not keep the Google Maps street name:`, err);
            }
        };

        new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(scan, 400);
        }).observe(document.body, { childList: true, subtree: true, characterData: true });
        console.log(`[${SCRIPT_NAME}] watching Google Maps for the street name from a right-click.`);
    }

    if (/(^|\.)google\.[a-z.]+$/.test(location.hostname) && location.pathname.startsWith('/maps')) {
        watchGoogleMaps();
        return;
    }

    const STORAGE_KEY_POS = 'wme_gis_importer_pos_v1';
    const STORAGE_KEY_TOOLBAR = 'wme_gis_importer_toolbar_v1';
    const STORAGE_KEY_POSTAL = 'wme_gis_importer_default_postal_city_v1';
    const STORAGE_KEY_HN_SETBACK = 'wme_gis_importer_house_number_setback_v1';
    const STORAGE_KEY_HN_EXACT = 'wme_gis_importer_house_number_exact_ft_v1';
    const STORAGE_KEY_NAME_RADIUS = 'wme_gis_importer_address_name_radius_m_v1';

    // The two switches start OFF every session, so the map is never captured by surprise:
    //  roads on, house numbers off -> a click imports the road (or extends a stub)
    //  roads off, house numbers on -> a click adds the missing house numbers to the existing road
    //  both on                     -> an existing road gets house numbers; a road that isn't mapped is imported
    let importRoadsEnabled = false;
    let houseNumbersEnabled = false;
    let cleanUpEnabled = false;   // clean up on: clicking an existing road moves it onto the GIS centerline

    // House number markers are placed this many meters out from the road (remembered between sessions).
    let houseNumberSetbackM = 30;
    try {
        const saved = parseFloat(localStorage.getItem(STORAGE_KEY_HN_SETBACK));
        if (Number.isFinite(saved) && saved >= 0 && saved <= 200) houseNumberSetbackM = saved;
    } catch (e) { /* storage unavailable */ }

    // An address point at least this many feet from the road is taken to be the house itself, and the number goes exactly there.
    // Closer than that, the point is taken to be a curb or centerline point and the number goes houseNumberSetbackM out from the
    // road. 0 = always exactly at the point; 5000 = never (the old behaviour).
    let houseNumberExactFt = 25;
    try {
        const saved = parseFloat(localStorage.getItem(STORAGE_KEY_HN_EXACT));
        if (Number.isFinite(saved) && saved >= 0 && saved <= 5000) houseNumberExactFt = saved;
    } catch (e) { /* storage unavailable */ }

    // A segment no GIS road runs along can take its street name from the address points beside it: points within this many meters vote.
    let addressNameRadiusM = 50;
    try {
        const saved = parseFloat(localStorage.getItem(STORAGE_KEY_NAME_RADIUS));
        if (Number.isFinite(saved) && saved >= 10 && saved <= 150) addressNameRadiusM = saved;
    } catch (e) { /* storage unavailable */ }

    // Postal city used as the alternate city for roads whose GIS data has no ZIP (set in the sidebar tab).
    let defaultPostalCity = '';
    try {
        defaultPostalCity = (localStorage.getItem(STORAGE_KEY_POSTAL) || '').trim();
    } catch (e) { /* storage unavailable */ }

    // An imported endpoint within this distance of a loaded node is joined to that node.
    const SNAP_TOLERANCE_M = 8;
    // WME only knows about nodes in areas it has loaded. If an endpoint is off-screen, a node
    // there may not be loaded yet, so the import is refused rather than creating a stray node.
    const REQUIRE_ENDS_ON_SCREEN = true;
    const ROAD_TYPE_STREET = 1;

    // Postal city for each ZIP in Kendall County (the county layer has no postal city field).
    // Add to this list whenever the panel reports a ZIP that is missing.
    const KENDALL_ZIP_CITIES = {
        '78006': 'Boerne',
        '78015': 'Boerne',
        '78013': 'Comfort',
        '78004': 'Bergheim',
        '78027': 'Kendalia',
        '78624': 'Fredericksburg',
        '78606': 'Blanco',
        '78070': 'Spring Branch'
    };

    // Kendall County's own road and address point layers, tuned field by field. Other counties come from WME GIS Layers
    // (see "Where the data comes from" below).
    const GIS_SOURCES = [
        {
            key: 'kendall',
            label: 'Kendall County',
            queryUrl: 'https://services2.arcgis.com/KenzhPpScXZWWBrv/ArcGIS/rest/services/Road_Centerlines/FeatureServer/1/query',
            bounds: { minLon: -99.05, maxLon: -98.35, minLat: 29.65, maxLat: 30.15 },
            // The legacy name fields hold the abbreviated forms (LN, E) that WME uses.
            nameParts: (p) => ({ preDir: p.LSt_PreDir, name: p.LSt_Name, type: p.LSt_Type, sufDir: p.LSt_PosDir, full: p.gcFullName }),
            oneWay: (p) => p.OneWay,
            query: (box) => queryLayerBox('https://services2.arcgis.com/KenzhPpScXZWWBrv/ArcGIS/rest/services/Road_Centerlines/FeatureServer/1/query', box, '*'),
            houseNumbers: {
                queryUrl: 'https://services2.arcgis.com/KenzhPpScXZWWBrv/ArcGIS/rest/services/Address_Points/FeatureServer/0/query',
                outFields: 'Add_Number,AddNum_Suf,gcFullName,LSt_PreDir,LSt_Name,LSt_Type,LSt_PosDir',
                query: (box) => queryLayerBox('https://services2.arcgis.com/KenzhPpScXZWWBrv/ArcGIS/rest/services/Address_Points/FeatureServer/0/query', box,
                    'Add_Number,AddNum_Suf,gcFullName,LSt_PreDir,LSt_Name,LSt_Type,LSt_PosDir'),
                nameParts: (p) => ({ preDir: p.LSt_PreDir, name: p.LSt_Name, type: p.LSt_Type, sufDir: p.LSt_PosDir, full: p.gcFullName }),
                number: (p) => (p.Add_Number ? `${p.Add_Number}${String(p.AddNum_Suf || '').trim()}` : '')
            },
            postalCities: (p) => {
                const cities = [];
                const notes = [];
                let zipsSeen = 0;
                for (const raw of [p.PostCode_L, p.PostCode_R]) {
                    const zip = typeof raw === 'string' ? raw.trim().slice(0, 5) : '';
                    if (!zip) continue;
                    zipsSeen++;
                    const city = KENDALL_ZIP_CITIES[zip];
                    if (city) cities.push(city);
                    else if (!notes.some((n) => n.includes(zip))) notes.push(`ZIP ${zip} is not in the ZIP-to-city table (add it near the top of the script), so no postal city was set.`);
                }
                return { cities, notes, missing: zipsSeen === 0 };
            }
        }
    ];

    // ------------------------------------------------------------------
    // Where the data comes from
    // ------------------------------------------------------------------
    // Kendall County uses its own tuned source above. Everywhere else in Texas, the road and address point layers you
    // have switched on in WME GIS Layers are used: the most local one that has data wins (city, then county, then state).
    const KENDALL = GIS_SOURCES.find((s) => s.key === 'kendall');
    const GISL_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1cEG3CvXSCI4TOZyMQTI50SQGbVhJ48Xip-jjWg4blWw/gviz/tq?tqx=out:json';
    const GISL_SETTINGS_KEY = 'wme_gis_layers_fl';
    const GISL_CACHE_KEY = 'wme_gis_importer_gisl_layers_v1';
    const GISL_CACHE_HOURS = 24;
    const TIGER_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer';
    const LEVEL_ORDER = ['city', 'county', 'state'];

    function gmGetJson(url, timeout = 30000) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                timeout,
                onload: (response) => {
                    try {
                        resolve(JSON.parse(response.responseText));
                    } catch (err) {
                        reject(new Error(`unreadable answer from ${new URL(url).hostname}`));
                    }
                },
                onerror: (e) => reject(new Error(`request to ${new URL(url).hostname} failed${e && e.error ? ` (${e.error})` : ''}`)),
                ontimeout: () => reject(new Error(`request to ${new URL(url).hostname} timed out`))
            });
        });
    }

    // County at a point, from Census TIGERweb (remembered for the area, so it is asked about once per ~1 km).
    const countyCache = new Map();
    let tigerCountyLayerId = null;
    async function countyAt(pt) {
        const key = `${pt.lon.toFixed(2)},${pt.lat.toFixed(2)}`;
        if (countyCache.has(key)) return countyCache.get(key);
        if (tigerCountyLayerId === null) {
            const svc = await gmGetJson(`${TIGER_URL}?f=json`);
            const layer = (svc.layers || []).find((l) => /^count/i.test(l.name));
            if (!layer) throw new Error('county layer not found on TIGERweb');
            tigerCountyLayerId = layer.id;
        }
        const params = new URLSearchParams({
            geometry: `${pt.lon},${pt.lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
            outFields: 'BASENAME,STATE', returnGeometry: 'false', f: 'json'
        });
        const data = await gmGetJson(`${TIGER_URL}/${tigerCountyLayerId}/query?${params}`);
        const attrs = data.features && data.features[0] ? data.features[0].attributes : null;
        const county = attrs ? { name: attrs.BASENAME, stateFips: String(attrs.STATE) } : null;
        countyCache.set(key, county);
        return county;
    }

    const roleOfLayer = (id, style) => {
        if (/parcel/i.test(id)) return null;
        if (/(pts|points|address|addr)/i.test(id)) return 'address';
        if (style === 'roads' || /(road|street|rds|route|centerline)/i.test(id)) return 'roads';
        return null;
    };
    const levelOfLayer = (id) => (/-city-/i.test(id) ? 'city' : /statewide|-state-/i.test(id) ? 'state' : 'county');

    // GIS Layers' layer list (its public sheet): only the Texas road and address point layers on ArcGIS are kept.
    let gislLayersPromise = null;
    function loadGislLayers() {
        if (gislLayersPromise) return gislLayersPromise;
        gislLayersPromise = (async () => {
            try {
                const cached = JSON.parse(localStorage.getItem(GISL_CACHE_KEY) || 'null');
                if (cached && Date.now() - cached.at < GISL_CACHE_HOURS * 3600000 && Array.isArray(cached.layers)) return cached.layers;
            } catch (e) { /* refetch */ }
            const text = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: GISL_SHEET_URL,
                    timeout: 60000,
                    onload: (r) => resolve(r.responseText),
                    onerror: () => reject(new Error('could not load the GIS Layers layer list')),
                    ontimeout: () => reject(new Error('the GIS Layers layer list timed out'))
                });
            });
            const m = text.match(/setResponse\(([\s\S]+)\);/);
            if (!m) throw new Error('the GIS Layers layer list could not be read');
            const rows = JSON.parse(m[1]).table.rows.map((r) => (r.c || []).map((c) => (c && c.v !== null && c.v !== undefined ? String(c.v).trim() : '')));
            const hi = rows.findIndex((r) => r.some((v) => /^id$/i.test(v)) && r.some((v) => /^url$/i.test(v)));
            if (hi < 0) throw new Error('the GIS Layers layer list has an unexpected layout');
            const head = rows[hi].map((v) => v.toLowerCase());
            const at = (name) => head.indexOf(name);
            const C = { subL1: at('subl1'), id: at('id'), subL2: at('subl2'), url: at('url'), where: at('where'), labelFields: at('labelfields'), style: at('style') };
            const layers = [];
            for (const r of rows.slice(hi + 1)) {
                const id = r[C.id];
                const url = (r[C.url] || '').replace(/\/$/, '');
                if (!id || !/^TX$/i.test(r[C.subL1]) || !/\/(MapServer|FeatureServer)\/\d+$/i.test(url)) continue;
                const role = roleOfLayer(id, r[C.style]);
                if (!role) continue;
                layers.push({
                    id, url, role, level: levelOfLayer(id), where: r[C.where] || '',
                    counties: (r[C.subL2] || '').split(/[,;]/).map((c) => c.trim().toLowerCase()).filter(Boolean),
                    labelFields: (r[C.labelFields] || '').split(',').map((f) => f.trim()).filter(Boolean)
                });
            }
            try {
                localStorage.setItem(GISL_CACHE_KEY, JSON.stringify({ at: Date.now(), layers }));
            } catch (e) { /* storage full: keep it in memory only */ }
            return layers;
        })().catch((err) => {
            gislLayersPromise = null; // try again next time
            throw err;
        });
        return gislLayersPromise;
    }

    function gislVisibleIds() {
        try {
            const s = JSON.parse(localStorage.getItem(GISL_SETTINGS_KEY) || '{}');
            if (s.enabled === false) return new Set();
            return new Set(s.visibleLayers || []);
        } catch (e) {
            return new Set();
        }
    }

    // Layers that failed in a way that won't fix itself (token required, not queryable) are skipped for the session.
    const brokenLayers = new Map();

    const esriToGeoJson = (g) => {
        if (!g) return null;
        if (Array.isArray(g.paths)) return g.paths.length === 1 ? { type: 'LineString', coordinates: g.paths[0] } : { type: 'MultiLineString', coordinates: g.paths };
        if (typeof g.x === 'number') return { type: 'Point', coordinates: [g.x, g.y] };
        if (Array.isArray(g.rings)) return { type: 'Polygon', coordinates: g.rings };
        return null;
    };

    // GIS Layers can shift a layer to line it up with the imagery. The shift is saved at layers.<id>.offset as { x, y } in ground
    // metres (+x east, +y north) and GIS Layers turns it into degrees with 111320 m per degree (east scaled by cos(latitude)). The
    // importer applies the same shift to what it reads, so a road is imported where the shifted layer is drawn.
    const GISL_M_PER_DEG = 111320;
    function gislOffsetOf(layerId) {
        try {
            const o = (JSON.parse(localStorage.getItem(GISL_SETTINGS_KEY) || '{}').layers || {})[layerId];
            const off = o && o.offset;
            const x = Number(off && off.x);
            const y = Number(off && off.y);
            if (Number.isFinite(x) && Number.isFinite(y) && (x || y)) return { x, y };
        } catch (e) { /* no saved shift */ }
        return null;
    }
    const gislShiftNoted = new Set();
    const shiftedLonLat = (pt, off, sign) => [
        pt[0] + (sign * off.x) / (GISL_M_PER_DEG * Math.cos((pt[1] * Math.PI) / 180)),
        pt[1] + (sign * off.y) / GISL_M_PER_DEG
    ];
    function shiftGeometry(geom, off) {
        const walk = (c) => (typeof c[0] === 'number' ? [...shiftedLonLat(c, off, 1), ...c.slice(2)] : c.map(walk));
        return { ...geom, coordinates: walk(geom.coordinates) };
    }

    // Queries one GIS Layers layer for a box; answers in the same shape as the Kendall queries (GeoJSON-like features).
    // If the layer is shifted in GIS Layers the box is moved back to where the raw data is, and the answers are shifted.
    async function queryGislLayer(layer, box, outFields = '*') {
        const off = gislOffsetOf(layer.id);
        if (off) {
            const key = `${layer.id}:${off.x}:${off.y}`;
            if (!gislShiftNoted.has(key)) {
                gislShiftNoted.add(key);
                console.log(`[${SCRIPT_NAME}] ${layer.id} is shifted in GIS Layers (${off.x} m east, ${off.y} m north): importing at the shifted position.`);
            }
            const lat = (box.minLat + box.maxLat) / 2;
            const dLon = off.x / (GISL_M_PER_DEG * Math.cos((lat * Math.PI) / 180));
            const dLat = off.y / GISL_M_PER_DEG;
            box = { minLon: box.minLon - dLon, maxLon: box.maxLon - dLon, minLat: box.minLat - dLat, maxLat: box.maxLat - dLat };
        }
        const params = {
            geometry: `${box.minLon},${box.minLat},${box.maxLon},${box.maxLat}`, geometryType: 'esriGeometryEnvelope', inSR: '4326',
            spatialRel: 'esriSpatialRelIntersects', where: layer.where || '1=1', outFields, outSR: '4326', returnGeometry: 'true', f: 'json'
        };
        let data = await gmGetJson(`${layer.url}/query?${new URLSearchParams({ ...params, resultRecordCount: '2000' })}`);
        if (data.error && /invalid|parameter/i.test(data.error.message || '')) {
            data = await gmGetJson(`${layer.url}/query?${new URLSearchParams(params)}`); // older servers reject resultRecordCount
        }
        if (data.error) {
            const msg = data.error.message || JSON.stringify(data.error);
            if (/token|not supported|invalid url/i.test(msg)) brokenLayers.set(layer.id, msg);
            throw new Error(`${layer.id}: ${msg}`);
        }
        const oid = data.objectIdFieldName || ((data.fields || []).find((f) => f.type === 'esriFieldTypeOID') || {}).name;
        const features = (data.features || []).map((f, i) => {
            const props = { ...(f.attributes || {}) };
            Object.defineProperty(props, '__layer', { value: layer, enumerable: false });
            const id = oid && props[oid] !== undefined ? props[oid] : i;
            return { type: 'Feature', id: `${layer.id}:${id}`, properties: props, geometry: esriToGeoJson(f.geometry) };
        }).filter((f) => f.geometry);
        if (off) for (const f of features) f.geometry = shiftGeometry(f.geometry, off);
        return { features };
    }

    // Asks the layers in order (most local first) and returns the first answer that has features.
    async function queryFirstWithData(layers, box, used, role) {
        const errors = [];
        for (const layer of layers) {
            if (brokenLayers.has(layer.id)) continue;
            try {
                const data = await queryGislLayer(layer, box);
                if (data.features.length) {
                    used[role] = layer.id;
                    return data;
                }
            } catch (err) {
                errors.push(err.message || String(err));
                console.warn(`[${SCRIPT_NAME}] GIS Layers query failed:`, err);
            }
        }
        if (errors.length) console.warn(`[${SCRIPT_NAME}] ${role} layers with errors: ${errors.join('; ')}`);
        return { features: [] };
    }

    // ----- reading fields whose names differ from layer to layer -----
    const fieldValue = (p, names) => {
        const keys = Object.keys(p);
        for (const name of names) {
            const key = keys.find((k) => k.toLowerCase() === name);
            if (!key) continue;
            const v = p[key];
            if (v === null || v === undefined) continue;
            const s = String(v).trim();
            if (s) return s;
        }
        return '';
    };
    const FIELDS = {
        preDir: ['st_predir', 'predir', 'pre_dir', 'dir1', 'prefixdir', 'fedirp', 'prefix_dir'],
        preType: ['st_pretyp', 'pretype', 'pre_type'],
        name: ['st_name', 'street', 'situsst', 'streetname', 'street_nam', 'st_nm', 'stname'],
        type: ['st_postyp', 'st_type', 'street_type', 'sfx', 'sttype', 'streettype', 'street_typ', 'fetype', 'suf_type'],
        sufDir: ['st_posdir', 'dir2', 'sfxdir', 'suf_dir', 'sufdir', 'fedirs', 'suffixdir'],
        full: ['full_name', 'fullname', 'map_lbl', 'rd_name', 'street_full', 'fullstreet', 'label'],
        number: ['add_number', 'situsnum', 'addr_num', 'address_nu', 'addressnum', 'addnum', 'house_num', 'hse_num', 'st_num', 'housenum'],
        numberSuffix: ['addnum_suf', 'add_num_suf', 'numsuffix', 'num_suffix'],
        fullAddress: ['full_addr', 'siteaddress', 'situsaddr', 'address', 'fulladdr', 'full_address', 'site_addr'],
        postal: ['postcomm_l', 'postcomm_r', 'post_comm', 'l_postal_c', 'r_postal_c', 'postal_city', 'msagcomm_l', 'msagcomm_r', 'city', 'zip_city'],
        oneWay: ['oneway', 'one_way', 'lgcyoneway']
    };

    const labelText = (p) => {
        const layer = p.__layer;
        if (!layer || !layer.labelFields.length) return '';
        return layer.labelFields.map((f) => fieldValue(p, [f.toLowerCase()])).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    };

    // PREFIX and SUFFIX fields hold a direction in some layers and a street type in others, so the value decides.
    function genericNameParts(p) {
        const isDirection = (v) => DIRECTION_TOKENS.has(v.toUpperCase());
        let preDir = fieldValue(p, FIELDS.preDir);
        let preType = fieldValue(p, FIELDS.preType);
        let type = fieldValue(p, FIELDS.type);
        let sufDir = fieldValue(p, FIELDS.sufDir);
        const prefix = fieldValue(p, ['prefix']);
        if (prefix) {
            if (isDirection(prefix)) preDir = preDir || prefix;
            else preType = preType || prefix;
        }
        const suffix = fieldValue(p, ['suffix']);
        if (suffix) {
            if (isDirection(suffix)) sufDir = sufDir || suffix;
            else type = type || suffix;
        }
        const name = [preType, fieldValue(p, FIELDS.name)].filter(Boolean).join(' ');
        const label = fieldValue(p, FIELDS.full) || labelText(p);
        const parts = { preDir, name, type: name ? type : '', sufDir: name ? sufDir : '', full: label };

        // The layer's own label is used when it has words the pieces above missed (and holds all the ones they found).
        const pieceWords = [parts.preDir, parts.name, parts.type, parts.sufDir].join(' ').toUpperCase().split(/\s+/).filter(Boolean);
        const labelWords = String(label).toUpperCase().split(/\s+/).filter(Boolean);
        if (pieceWords.length && labelWords.length > pieceWords.length && pieceWords.every((w) => labelWords.includes(w))) {
            return { preDir: '', name: '', type: '', sufDir: '', full: label };
        }
        return parts;
    }

    // "101 WALTON DR" -> { number: '101', street: 'WALTON DR' } (units after # or UNIT are dropped)
    const splitAddress = (s) => {
        const m = String(s || '').trim().match(/^(\d+[A-Z]?)\s+(.+?)(\s+(#|UNIT|APT|STE|BLDG)\b.*)?$/i);
        return m ? { number: m[1], street: m[2] } : null;
    };

    function genericAddressNumber(p) {
        const n = fieldValue(p, FIELDS.number);
        if (n && /^\d/.test(n)) return `${n}${fieldValue(p, FIELDS.numberSuffix)}`.replace(/\s+/g, '');
        const split = splitAddress(fieldValue(p, FIELDS.fullAddress) || labelText(p));
        return split ? split.number : '';
    }

    function genericAddressNameParts(p) {
        const parts = genericNameParts(p);
        if (parts.name) return { ...parts, full: '' };
        const split = splitAddress(fieldValue(p, FIELDS.fullAddress) || labelText(p));
        return { preDir: '', name: '', type: '', sufDir: '', full: split ? split.street : parts.full };
    }

    function genericPostalCities(p) {
        const cities = [];
        for (const f of FIELDS.postal) {
            const v = fieldValue(p, [f]);
            if (v && !cities.some((c) => c.toLowerCase() === v.toLowerCase())) cities.push(v);
            if (cities.length >= 2) break;
        }
        return { cities, notes: [], missing: !cities.length };
    }

    // The source object every part of the importer uses, built from the GIS Layers layers that cover a county.
    function makeGislSource(countyName, layers) {
        const used = { roads: '', address: '' };
        const roads = layers.filter((l) => l.role === 'roads');
        const addresses = layers.filter((l) => l.role === 'address');
        const source = {
            key: 'gisl',
            generic: true,
            used,
            county: countyName,
            roadLayers: roads,
            get label() { return used.roads ? `GIS Layers: ${used.roads}` : `GIS Layers (${countyName} Co)`; },
            query: (box) => queryFirstWithData(roads, box, used, 'roads'),
            // every road layer you have on, merged: the block beyond a segment can live in another layer (county vs city)
            queryAll: async (box) => {
                const answers = await Promise.all(roads.filter((l) => !brokenLayers.has(l.id)).map((l) => queryGislLayer(l, box).catch((err) => {
                    console.warn(`[${SCRIPT_NAME}] GIS Layers query failed:`, err);
                    return { features: [] };
                })));
                return { features: answers.flatMap((a) => a.features) };
            },
            nameParts: genericNameParts,
            oneWay: (p) => fieldValue(p, FIELDS.oneWay),
            postalCities: genericPostalCities,
            houseNumbers: addresses.length ? {
                query: (box) => queryFirstWithData(addresses, box, used, 'address'),
                nameParts: genericAddressNameParts,
                number: genericAddressNumber,
                postalCities: genericPostalCities
            } : null
        };
        return source;
    }

    // The source for a spot: Kendall's own, or one built from your GIS Layers layers for that county. Null if none.
    // Why the last resolveSource found nothing, in words for the status line.
    let sourceProblem = '';
    const noSourceMessage = () => sourceProblem || 'No GIS road layer here. Outside Kendall County, check a road layer for this county (or the statewide one) in WME GIS Layers.';

    async function resolveSource(pt) {
        sourceProblem = '';
        const inKendallBox = pt.lon >= KENDALL.bounds.minLon && pt.lon <= KENDALL.bounds.maxLon && pt.lat >= KENDALL.bounds.minLat && pt.lat <= KENDALL.bounds.maxLat;
        let county = null;
        try {
            county = await countyAt(pt);
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] County lookup failed:`, err);
            if (inKendallBox) return KENDALL;
            sourceProblem = 'Could not work out which county this is (the Census lookup failed), so no GIS layers were chosen.';
            return null;
        }
        if (!county) {
            sourceProblem = 'Could not work out which county this is, so no GIS layers were chosen.';
            return null;
        }
        if (/^kendall$/i.test(county.name) && county.stateFips === '48') return KENDALL;
        if (county.stateFips !== '48') {
            sourceProblem = 'The importer only has GIS sources for Texas so far.';
            return null;
        }
        const problem = gislProblem();
        if (problem) {
            sourceProblem = problem;
            return null;
        }
        const visible = gislVisibleIds();
        const all = await loadGislLayers();
        const wanted = county.name.toLowerCase();
        const layers = all
            .filter((l) => visible.has(l.id) && !brokenLayers.has(l.id) && (!l.counties.length || l.counties.includes(wanted)))
            .sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level));
        if (!layers.some((l) => l.role === 'roads')) {
            sourceProblem = `No road layer is checked in WME GIS Layers for ${county.name} County (or statewide).`;
            return null;
        }
        return makeGislSource(county.name, layers);
    }

    // A postal city from the address points around a road (statewide address points carry one almost everywhere).
    async function postalFromAddressPoints(source, coords, name) {
        if (!source.houseNumbers || !source.houseNumbers.postalCities) return null;
        const mid = pointAlongLine(coords, 0.5);
        const pad = 0.0015;
        const data = await source.houseNumbers.query({ minLon: mid[0] - pad, maxLon: mid[0] + pad, minLat: mid[1] - pad, maxLat: mid[1] + pad });
        const wanted = normalizeName(name);
        const tally = new Map();
        for (const f of data.features || []) {
            const p = f.properties || {};
            const city = source.houseNumbers.postalCities(p).cities[0];
            if (!city) continue;
            const sameStreet = normalizeName(buildStreetName(source.houseNumbers.nameParts(p)).name) === wanted;
            tally.set(city, (tally.get(city) || 0) + (sameStreet ? 3 : 1));
        }
        const best = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
        return best ? best[0] : null;
    }

    // Postal city for a road whose GIS record has none: same street in WME, address points nearby, the sidebar
    // setting, then the nearest GIS road that has one.
    async function resolvePostal(source, props, name, coords, featureId, excludeSegmentId = null) {
        let postal = source.postalCities(props || {});
        if (!postal.missing) return postal;
        const sameStreet = postalCityFromSameStreet(name, coords, excludeSegmentId);
        if (sameStreet) return { cities: sameStreet.cities, notes: [], fromStreet: { id: sameStreet.segmentId, name } };
        try {
            const fromPoints = await postalFromAddressPoints(source, coords, name);
            if (fromPoints) return { cities: [fromPoints], notes: [], fromAddresses: true };
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Address point postal lookup failed:`, err);
        }
        if (defaultPostalCity) return { cities: [defaultPostalCity], notes: [], fromSetting: true };
        try {
            const near = await neighborPostal(source, coords, featureId);
            if (near) postal = { cities: near.postal.cities, notes: [], fromNeighbor: Math.round(near.dist) };
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Neighbor postal lookup failed:`, err);
        }
        return postal;
    }

    const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    if (pageWin.SDK_INITIALIZED) {
        await pageWin.SDK_INITIALIZED;
    }

    const sdk = pageWin.getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME });

    const isReady = typeof sdk.State?.isReady === 'function' ? sdk.State.isReady() : sdk.State?.isReady;
    if (!isReady) {
        await sdk.Events.once({ eventName: 'wme-ready' });
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // ---- WME SI Core (inlined in this bundled copy; the split build loads it with @require) ----
    const WmeSiCore = (() => {
        'use strict';

        const RAD = Math.PI / 180;
        const EARTH_R = 6371000;

        function distanceMeters(lat1, lon1, lat2, lon2) {
            const dLat = (lat2 - lat1) * RAD;
            const dLon = (lon2 - lon1) * RAD;
            const a = Math.sin(dLat / 2) ** 2 +
                Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
            return EARTH_R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        }

        // Distance in meters from point p ({lon, lat}) to a polyline of [lon, lat] pairs
        // (local flat approximation; accurate at street scale).
        function distanceToLine(p, line) {
            const mx = 111320 * Math.cos(p.lat * RAD);
            const my = 110540;
            let best = Infinity;
            for (let i = 0; i < line.length - 1; i++) {
                const ax = (line[i][0] - p.lon) * mx;
                const ay = (line[i][1] - p.lat) * my;
                const bx = (line[i + 1][0] - p.lon) * mx;
                const by = (line[i + 1][1] - p.lat) * my;
                const dx = bx - ax;
                const dy = by - ay;
                const len2 = dx * dx + dy * dy;
                let t = len2 ? (-ax * dx - ay * dy) / len2 : 0;
                t = Math.max(0, Math.min(1, t));
                best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
            }
            return best;
        }

        // All parts of a GIS feature's geometry as arrays of [lon, lat] pairs.
        function linePartsOf(feature) {
            const g = feature.geometry;
            if (!g) return [];
            const strip = (line) => line.map((c) => [c[0], c[1]]);
            if (g.type === 'LineString') return [strip(g.coordinates)];
            if (g.type === 'MultiLineString') return g.coordinates.map(strip);
            return [];
        }

        // Point at a fraction (0..1) of the way along a line of [lon, lat] pairs.
        function pointAlongLine(coords, fraction) {
            const mx = 111320 * Math.cos(coords[0][1] * RAD);
            const my = 110540;
            const lengths = [];
            let total = 0;
            for (let i = 0; i < coords.length - 1; i++) {
                const len = Math.hypot((coords[i + 1][0] - coords[i][0]) * mx, (coords[i + 1][1] - coords[i][1]) * my);
                lengths.push(len);
                total += len;
            }
            let remaining = total * fraction;
            for (let i = 0; i < lengths.length; i++) {
                if (remaining <= lengths[i] || i === lengths.length - 1) {
                    const t = lengths[i] ? Math.min(1, remaining / lengths[i]) : 0;
                    return [
                        coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t,
                        coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t
                    ];
                }
                remaining -= lengths[i];
            }
            return [...coords[0]];
        }

        function formatCityName(raw) {
            if (typeof raw !== 'string') return '';
            return raw.trim().replace(/\s+/g, ' ').toLowerCase()
                .replace(/(^|[\s-])([a-z])/g, (m, sep, ch) => sep + ch.toUpperCase());
        }

        const DIRECTION_TOKENS = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']);

        // Words whose capitalization can't be guessed. Add more as they turn up (key = upper-case word).
        const NAME_EXCEPTIONS = {
            DESOTO: 'DeSoto',
            DELEON: 'DeLeon',
            DEWITT: 'DeWitt',
            LASALLE: 'LaSalle',
            MACARTHUR: 'MacArthur',
            MACDONALD: 'MacDonald',
            MACGREGOR: 'MacGregor',
            MLK: 'MLK'
        };

        // Street types Waze's voice reads badly when abbreviated (it says "Vis", not "Vista"), so they are spelled out.
        // Only VIS has been confirmed; the rest are guesses, so remove any you don't want spelled out.
        const TYPE_EXPANSIONS = {
            VIS: 'Vista', BND: 'Bend', BLF: 'Bluff', CRK: 'Creek', CRST: 'Crest', XING: 'Crossing', CV: 'Cove',
            FRST: 'Forest', GLN: 'Glen', GRV: 'Grove', HTS: 'Heights', HOLW: 'Hollow', JCT: 'Junction',
            LNDG: 'Landing', MDW: 'Meadow', MDWS: 'Meadows', MNR: 'Manor', PT: 'Point', RDG: 'Ridge',
            RNCH: 'Ranch', SPG: 'Spring', SPGS: 'Springs', TRCE: 'Trace', VLG: 'Village', VLY: 'Valley',
            VW: 'View', LK: 'Lake'
        };

        // A full street name written out ("WALTON DRIVE") gets the abbreviated type WME uses ("WALTON DR"); types Waze reads
        // badly when abbreviated keep the spelled-out form from TYPE_EXPANSIONS.
        const LONG_TYPES = {
            AVENUE: 'AVE', BOULEVARD: 'BLVD', CIRCLE: 'CIR', COURT: 'CT', DRIVE: 'DR', EXPRESSWAY: 'EXPY', FREEWAY: 'FWY',
            HIGHWAY: 'HWY', LANE: 'LN', PARKWAY: 'PKWY', PLACE: 'PL', ROAD: 'RD', STREET: 'ST', TERRACE: 'TER', TRAIL: 'TRL',
            SQUARE: 'SQ', COVE: 'CV', BEND: 'BND', CROSSING: 'XING', HOLLOW: 'HOLW', RIDGE: 'RDG', POINT: 'PT'
        };
        function abbreviateFullType(raw) {
            const tokens = raw.split(' ').filter(Boolean);
            let i = tokens.length - 1;
            while (i > 0 && DIRECTION_TOKENS.has(tokens[i])) i--;
            if (i > 0) {
                const short = LONG_TYPES[tokens[i]] || ALT_TYPES[tokens[i]] || tokens[i];
                tokens[i] = TYPE_EXPANSIONS[short] ? TYPE_EXPANSIONS[short].toUpperCase() : short;
            }
            return tokens.join(' ');
        }

        // Older or alternate street type abbreviations, written the way WME and the USPS write them.
        const ALT_TYPES = { AV: 'AVE', BL: 'BLVD', BV: 'BLVD', HY: 'HWY', LOOP: 'LP' }; // GIS spells out Loop; Waze's approved abbreviation is Lp

        const APOSTROPHE_MARK = '\u0001'; // stands in for an apostrophe between a single letter and a name (O'Brien -> OBrien)

        function capitalize(word) {
            return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        }

        function formatNameToken(token, index, count) {
            if (count > 1 && (index === 0 || index === count - 1) && DIRECTION_TOKENS.has(token)) return token;
            if (NAME_EXCEPTIONS[token]) return NAME_EXCEPTIONS[token];
            if (token.includes(APOSTROPHE_MARK)) {
                const [lead, tail] = token.split(APOSTROPHE_MARK);
                return lead.toUpperCase() + capitalize(tail); // O'BRIEN -> OBrien
            }
            if (/^\d+(ST|ND|RD|TH)$/.test(token)) return token.toLowerCase(); // 1ST -> 1st
            if (/^\d/.test(token)) return token;
            if (/^MC[A-Z]{2,}$/.test(token)) return `Mc${capitalize(token.slice(2))}`; // MCKINNEY -> McKinney
            // Capitalize each piece around hyphens
            return token.toLowerCase().replace(/(^|-)([a-z])/g, (m, sep, ch) => sep + ch.toUpperCase());
        }

        // Turns route-style names into WME form: I-45, US-59, SH-105, FM-1488, RM-620, CR-123.
        // Returns { route, rest } or null if the name isn't a route. A bare "Highway 75" can't be
        // told apart (state vs US) without the GIS SHIELD field, so it is flagged instead of guessed.
        function matchRoute(raw, shield) {
            let m;
            const num = '(\\d{1,4}[A-Z]?)';
            if ((m = raw.match(new RegExp(`^(?:INTERSTATE|IH|I)\\s*-?\\s*${num}\\b\\s*(.*)$`)))) return { route: `I-${m[1]}`, rest: m[2] };
            if ((m = raw.match(new RegExp(`^(?:US|U\\.S\\.)\\s*-?\\s*(?:HIGHWAY|HWY)?\\s*-?\\s*${num}\\b\\s*(.*)$`)))) return { route: `US-${m[1]}`, rest: m[2] };
            if ((m = raw.match(new RegExp(`^(?:STATE\\s+(?:HIGHWAY|HWY)|STATE|SH|TX)\\s*-?\\s*${num}\\b\\s*(.*)$`)))) return { route: `SH-${m[1]}`, rest: m[2] };
            if ((m = raw.match(new RegExp(`^(?:FM|FARM\\s+TO\\s+MARKET(?:\\s+(?:ROAD|RD\\.?))?)\\s*-?\\s*${num}\\b\\s*(.*)$`)))) return { route: `FM-${m[1]}`, rest: m[2] };
            if ((m = raw.match(new RegExp(`^(?:RM|RANCH\\s+TO\\s+MARKET(?:\\s+(?:ROAD|RD\\.?))?)\\s*-?\\s*${num}\\b\\s*(.*)$`)))) return { route: `RM-${m[1]}`, rest: m[2] };
            if ((m = raw.match(new RegExp(`^(?:CR|CO\\.?\\s+(?:ROAD|RD\\.?)|COUNTY\\s+(?:ROAD|RD\\.?))\\s*-?\\s*${num}\\b\\s*(.*)$`)))) return { route: `CR-${m[1]}`, rest: m[2] };
            if ((m = raw.match(new RegExp(`^(?:HIGHWAY|HWY)\\s*-?\\s*${num}\\b\\s*(.*)$`)))) {
                const s = String(shield || '').toUpperCase();
                if (/\bUS\b|FEDERAL/.test(s)) return { route: `US-${m[1]}`, rest: m[2] };
                if (/\b(SH|TX|STATE)\b/.test(s)) return { route: `SH-${m[1]}`, rest: m[2] };
                return { route: null, ambiguousHighway: true };
            }
            return null;
        }

        // Builds a WME-style street name from normalized parts { preDir, name, type, sufDir, full, shield }
        // (blank parts are left out; `full` is used only if the pieces are all empty).
        // Route names (FM, SH, US, I) get their dash and put any direction after the shield: SH-46 E.
        // Returns { name, note } where note is a message when something needs a human decision.
        // Some GIS layers put the road's type in a prefix field and again in the street name ("COUNTY ROAD" + "COUNTY ROAD 4755"), so a
        // run of two or more words that is immediately repeated is written once.
        function collapseRepeats(text) {
            const tokens = text.split(' ').filter(Boolean);
            for (let len = Math.floor(tokens.length / 2); len >= 2; len--) {
                for (let i = 0; i + 2 * len <= tokens.length; i++) {
                    if (tokens.slice(i, i + len).join(' ') === tokens.slice(i + len, i + 2 * len).join(' ')) {
                        tokens.splice(i + len, len);
                        return collapseRepeats(tokens.join(' '));
                    }
                }
            }
            return tokens.join(' ');
        }

        function buildStreetName(parts) {
            const clean = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');
            // Apostrophes are dropped. A single letter before one (O'BRIEN, D'ANGELO) keeps the next capital.
            const fixApostrophes = (t) => t.replace(/\b([A-Z])['\u2019`](?=[A-Z])/g, `$1${APOSTROPHE_MARK}`).replace(/['\u2019`]/g, '');
            const finish = (tokens, routeFirst) => tokens
                .map((t, i) => (routeFirst && i === 0 ? t : formatNameToken(t, i, tokens.length))).join(' ');

            const pre = clean(parts.preDir).toUpperCase();
            const suf = clean(parts.sufDir).toUpperCase();
            const typeRaw0 = clean(parts.type).toUpperCase();
            const typeRaw = ALT_TYPES[typeRaw0] || typeRaw0;
            const typeWord = typeRaw ? (TYPE_EXPANSIONS[typeRaw] || typeRaw) : '';
            const core = collapseRepeats(fixApostrophes([clean(parts.name), typeWord].filter(Boolean).join(' ').toUpperCase()));

            let note = '';
            let sawAmbiguousHighway = false;

            if (core) {
                const route = matchRoute(core, parts.shield);
                if (route && route.route) {
                    const direction = suf || pre;
                    const tokens = [route.route, ...route.rest.split(' ').filter(Boolean), ...(direction ? [direction] : [])];
                    return { name: finish(tokens, true), note };
                }
                if (route && route.ambiguousHighway) sawAmbiguousHighway = true;
            }

            const pieces = [pre, core, suf].filter(Boolean);
            const raw = collapseRepeats(pieces.length ? pieces.join(' ') : abbreviateFullType(fixApostrophes(clean(parts.full).toUpperCase())));
            if (!raw) return { name: '', note: '' };

            const route = matchRoute(raw, parts.shield);
            if (route && route.route) {
                const tokens = [route.route, ...route.rest.split(' ').filter(Boolean)];
                return { name: finish(tokens, true), note };
            }
            if (sawAmbiguousHighway || (route && route.ambiguousHighway)) {
                note = `"${raw}" is a highway - set SH or US by hand.`;
            }
            return { name: finish(raw.split(' '), false), note };
        }

        return {
            RAD,
            EARTH_R,
            distanceMeters,
            distanceToLine,
            linePartsOf,
            pointAlongLine,
            formatCityName,
            DIRECTION_TOKENS,
            buildStreetName
        };
    })();

    const { RAD, EARTH_R, distanceMeters, distanceToLine, linePartsOf, pointAlongLine, formatCityName, DIRECTION_TOKENS, buildStreetName } = WmeSiCore;

    const mapDiv = (typeof sdk.Map.getMapViewportElement === 'function' && sdk.Map.getMapViewportElement()) ||
        document.getElementById('map');

    if (!mapDiv) {
        console.error(`[${SCRIPT_NAME}] Map element not found.`);
        return;
    }

    // GIS feature ids already imported this session (prevents duplicate overlapping segments)
    const importedFeatureIds = new Set();
    const importerMadeIds = new Set(); // segments this script creates (autofill leaves those to the importer)
    let busy = false;
    let areaDrawing = false; // the Area outline is being drawn: map clicks add corners instead of importing
    let areaRunning = false; // an Area run is in progress: the status strip stays out of the way of its panel
    let isImporterActive = false;
    let altHeld = false; // Alt held on the click: house numbers at a dead end are placed beside the road, not fanned

    // Segments that need info (section further down). The state lives here so the toolbar can use it from the start.
    // Scan level, set by the master button on the toolbar:
    //   off   = no scanning at all
    //   light = only data WME has loaded, plus the city limits (missing street name or city; a primary city that does not fit the limits)
    //   full  = Light, plus the postal lookups (GIS, ZIP table, address points) and the nearby-street comparison
    const STORAGE_KEY_SCAN = 'wme_gis_importer_scanlevel_v1';
    const STORAGE_KEY_AUTOFILL = 'wme_gis_importer_autofill_v1';
    let scanLevel = 'light';
    try {
        const saved = localStorage.getItem(STORAGE_KEY_SCAN);
        if (saved === 'off' || saved === 'light' || saved === 'full') scanLevel = saved;
    } catch (e) { /* use the default */ }
    // Autofill: a segment drawn by hand inside city and CDP limits gets its primary city, whatever the scan level (even Off).
    let autofillEnabled = true;
    try {
        autofillEnabled = localStorage.getItem(STORAGE_KEY_AUTOFILL) !== 'off';
    } catch (e) { /* use the default */ }
    const gapSettings = { cities: true }; // a primary city that does not fit the limits is always flagged
    let gapsReady = false; // set once the whole script has loaded
    let gapTimer = null;
    let gapPollTimer = null;
    let gapPollMs = 3000;
    let gapList = [];
    let gapHistory = [];
    let gapSignature = '';
    let gapScanBusy = false;
    const gapCityCache = new Map();
    const GAP_LAYER = 'wme-segment-importer-info-gaps';
    const GAP_ROAD_TYPES = new Set([1, 2, 3, 6, 7]); // Street, Primary Street, Freeway, Major Highway, Minor Highway (ramps and paths are left out)
    const GAP_MIN_ZOOM = 16;
    const GAP_SHORT_CONNECTOR_M = 60; // an unnamed segment shorter than this is taken to be an at-grade connector, which normally has no name
    const GAP_KINDS = {
        none: { colour: '#d93025', label: 'no street name and no city' },
        name: { colour: '#f29900', label: 'no street name' },
        city: { colour: '#fbc02d', label: 'no city (primary or alternate)' },
        badcity: { colour: '#1a73e8', label: 'primary city does not fit the city limits' }
    };
    let gapLayerReady = false;
    let gapZoomNote = '';

    // ------------------------------------------------------------------
    // Panel UI
    // ------------------------------------------------------------------
    // Sidebar tab elements (filled in once the tab is registered)
    let sidebarUi = null;

    let savedPos = {};
    try {
        savedPos = JSON.parse(localStorage.getItem(STORAGE_KEY_POS)) || {};
    } catch (e) {
        savedPos = {};
    }

    // The toolbar is either open or shrunk to an icon (it can no longer be closed, so it can never stay hidden). Remembered between sessions.
    let toolbarState = { minimized: false, closed: false };
    try {
        toolbarState = { ...toolbarState, ...(JSON.parse(localStorage.getItem(STORAGE_KEY_TOOLBAR)) || {}) };
    } catch (e) { /* use defaults */ }
    // Older builds could save a closed state, which hid the toolbar for good. It now counts as minimized.
    if (toolbarState.closed) toolbarState = { minimized: true, closed: false };

    // ----- icons (drawn here, so nothing is downloaded) -----
    const SVG_NS = 'http://www.w3.org/2000/svg';
    function svgIcon(shapes, size, viewBox = '0 0 24 24') {
        const [, , vw, vh] = viewBox.split(' ').map(Number);
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', viewBox);
        svg.setAttribute('width', String(size));
        svg.setAttribute('height', String(Math.round((size * vh) / vw)));
        svg.style.cssText = 'display: block; pointer-events: none; flex: none;';
        for (const [tag, attrs] of shapes) {
            const node = document.createElementNS(SVG_NS, tag);
            for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
            svg.appendChild(node);
        }
        return svg;
    }
    const LINE = { fill: 'none', stroke: 'currentColor', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
    const ICON_SHAPES = {
        road: [
            ['path', { d: 'M9 3h6l5 18H4z', fill: 'currentColor', 'fill-opacity': '0.22', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linejoin': 'round' }],
            ['path', { d: 'M12 5.5v2.5M12 11v3M12 17.5v2', ...LINE, 'stroke-width': '1.9' }]
        ],
        house: [
            ['path', { d: 'M5.5 10.5V20h13v-9.5', fill: 'currentColor', 'fill-opacity': '0.22', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linejoin': 'round' }],
            ['path', { d: 'M3 11.5 12 4l9 7.5', ...LINE, 'stroke-width': '2' }],
            ['path', { d: 'M10 20v-5h4v5', ...LINE, 'stroke-width': '1.6' }]
        ],
        magnet: [
            ['path', { d: 'M7.5 5v7.2a4.5 4.5 0 0 0 9 0V5', fill: 'none', stroke: 'currentColor', 'stroke-width': '3.6' }],
            ['rect', { x: 5.7, y: 3, width: 3.6, height: 4.4, fill: '#ffffff', stroke: 'currentColor', 'stroke-width': '1' }],
            ['rect', { x: 14.7, y: 3, width: 3.6, height: 4.4, fill: '#ffffff', stroke: 'currentColor', 'stroke-width': '1' }]
        ],
        search: [
            ['circle', { cx: 10.5, cy: 10.5, r: 6, ...LINE, 'stroke-width': '2' }],
            ['path', { d: 'm15.2 15.2 5.3 5.3', ...LINE, 'stroke-width': '2.6' }],
            ['path', { d: 'M10.5 7.8v1.6M10.5 11.2v1.6', ...LINE, 'stroke-width': '1.6' }]
        ],
        scan: [
            ['circle', { cx: 12, cy: 12, r: 8.5, ...LINE, 'stroke-width': 1.8 }],
            ['circle', { cx: 12, cy: 12, r: 4, ...LINE, 'stroke-width': 1.6 }],
            ['path', { d: 'M12 12 18.2 5.8', ...LINE, 'stroke-width': 2.2 }],
            ['circle', { cx: 12, cy: 12, r: 1.4, fill: 'currentColor' }]
        ],
        area: [
            ['path', { d: 'M4.5 7.5 13 4l6.5 4.5-1.5 9.5-10.5 2.5z', ...LINE, 'stroke-width': 1.8, 'stroke-dasharray': '3 2.2' }],
            ['path', { d: 'M8.5 16c1.8-3.2 4-3.6 7-6.5', ...LINE, 'stroke-width': 2.2 }],
            ['circle', { cx: 4.5, cy: 7.5, r: 1.5, fill: 'currentColor' }],
            ['circle', { cx: 13, cy: 4, r: 1.5, fill: 'currentColor' }],
            ['circle', { cx: 19.5, cy: 8.5, r: 1.5, fill: 'currentColor' }],
            ['circle', { cx: 18, cy: 18, r: 1.5, fill: 'currentColor' }],
            ['circle', { cx: 7.5, cy: 20.5, r: 1.5, fill: 'currentColor' }]
        ],
        gaps: [
            ['path', { d: 'M12 3.5 21.5 20h-19z', fill: 'currentColor', 'fill-opacity': '0.2', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linejoin': 'round' }],
            ['path', { d: 'M12 9.5v5', ...LINE, 'stroke-width': '2' }],
            ['circle', { cx: 12, cy: 17.4, r: 1.1, fill: 'currentColor' }]
        ]
    };
    // The script's own mark: a road, copied across by a magnet, onto the road beside it.
    const LOGO_SHAPES = [
        ['rect', { x: 3, y: 3, width: 9, height: 24, rx: 1.2, fill: COLOUR_ROADS }],
        ['path', { d: 'M7.5 6v3M7.5 12v3M7.5 18v3', fill: 'none', stroke: '#ffffff', 'stroke-width': 1.3, 'stroke-linecap': 'round' }],
        ['path', { d: 'M14 10Q19 4.5 25.5 8.5M23.2 6.4l2.6 2.1-3.1.8', fill: 'none', stroke: '#4f9fe0', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }],
        ['path', { d: 'M17 14.5v3.7a3.5 3.5 0 0 0 7 0v-3.7', fill: 'none', stroke: '#5b1126', 'stroke-width': 2.6 }],
        ['rect', { x: 15.7, y: 12, width: 2.6, height: 3.4, fill: '#ffffff', stroke: '#5b1126', 'stroke-width': 0.8 }],
        ['rect', { x: 22.7, y: 12, width: 2.6, height: 3.4, fill: '#ffffff', stroke: '#5b1126', 'stroke-width': 0.8 }],
        ['rect', { x: 29, y: 3, width: 9, height: 24, rx: 1.2, fill: '#ffffff', stroke: '#2d2d3a', 'stroke-width': 1.3 }],
        ['path', { d: 'M33.5 6v3M33.5 12v3M33.5 18v3', fill: 'none', stroke: '#2d2d3a', 'stroke-width': 1.3, 'stroke-linecap': 'round' }]
    ];
    const LOGO_VIEWBOX = '0 0 41 30';

    function makeToolButton(iconName, tip, onIconColour) {
        const button = document.createElement('button');
        button.type = 'button';
        button.title = tip;
        button.setAttribute('aria-label', tip);
        button.style.cssText = 'width: 32px; height: 32px; padding: 0; display: flex; align-items: center; justify-content: center; ' +
            'border-radius: 7px; border: 2px solid #dadce0; background: #ffffff; color: #5f6368; cursor: pointer; flex: none;';
        button.appendChild(svgIcon(ICON_SHAPES[iconName], 20));
        button._onIcon = onIconColour || '#ffffff';
        return button;
    }

    function makeSmallButton(text, tip) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = text;
        button.title = tip;
        button.setAttribute('aria-label', tip);
        button.style.cssText = 'width: 18px; height: 18px; padding: 0; border: none; border-radius: 4px; background: transparent; ' +
            'color: #5f6368; font-size: 15px; line-height: 16px; cursor: pointer; flex: none;';
        return button;
    }

    const defaultLeft = Math.round((window.innerWidth - 220) / 2);
    const defaultTop = Math.round((window.innerHeight - 100) / 2);

    const container = document.createElement('div');
    container.id = 'wme-gis-importer-container';
    container.style.cssText = `
        position: fixed;
        left: ${savedPos.left !== undefined ? savedPos.left : defaultLeft}px;
        top: ${savedPos.top !== undefined ? savedPos.top : defaultTop}px;
        z-index: 999999;
        display: flex;
        flex-direction: column;
        background: #ffffff;
        padding: 4px 6px;
        border-radius: 10px;
        box-shadow: 0 3px 12px rgba(0,0,0,0.35);
        font-family: sans-serif;
        cursor: move;
        user-select: none;
        border: 1px solid #dadce0;
    `;

    const bar = document.createElement('div');
    bar.style.cssText = 'display: flex; align-items: center; gap: 5px;';
    container.appendChild(bar);

    const grip = document.createElement('span');
    grip.textContent = '\u22EE';
    grip.title = 'Drag to move';
    grip.style.cssText = 'color: #9aa0a6; font-size: 18px; line-height: 1; width: 8px; text-align: center; flex: none;';
    bar.appendChild(grip);

    // Master scan button: grey = Off, blue = Light, indigo = Full (the letter on it says which, so it is not colour alone).
    const btnScan = makeToolButton('scan', 'Scan');
    btnScan.style.position = 'relative';
    const scanLetter = document.createElement('span');
    scanLetter.style.cssText = 'position: absolute; right: -5px; bottom: -5px; min-width: 14px; height: 14px; border-radius: 7px; border: 1.5px solid #ffffff; ' +
        'box-sizing: border-box; color: #ffffff; font: bold 9px/11px sans-serif; text-align: center; display: none; pointer-events: none;';
    btnScan.appendChild(scanLetter);
    const SCAN_LOOK = {
        off: { background: '#ffffff', border: '#dadce0', icon: '#5f6368', letter: '', badge: '',
            tip: 'Scan: OFF. Nothing is checked. Click for Light. (Autofill of hand-drawn segments still works if it is on in the sidebar tab.)' },
        light: { background: '#1a73e8', border: '#1a73e8', icon: '#ffffff', letter: 'L', badge: '#0b57d0',
            tip: 'Scan: LIGHT. Checks the segments around the map using only what WME has loaded plus the city limits: a missing street name or city, and a primary city that does not fit the limits. Click for Full.' },
        full: { background: '#3c4ba8', border: '#3c4ba8', icon: '#ffffff', letter: 'F', badge: '#1a237e',
            tip: 'Scan: FULL. Light, plus the postal lookups (GIS, ZIP table, address points) and the nearby-street comparison for the selected segment. Click to turn the scan off.' }
    };
    function paintScanButton() {
        const look = SCAN_LOOK[scanLevel] || SCAN_LOOK.off;
        btnScan.style.background = look.background;
        btnScan.style.borderColor = look.border;
        btnScan.style.color = look.icon;
        scanLetter.textContent = look.letter;
        scanLetter.style.background = look.badge;
        scanLetter.style.display = look.letter ? 'block' : 'none';
        btnScan.title = look.tip;
        btnScan.setAttribute('aria-label', look.tip);
        btnScan.setAttribute('data-level', scanLevel);
    }
    paintScanButton();
    const btnRoads = makeToolButton('road', 'Roads: click a GIS road to import it or extend a stub; click a mapped road to fill in its missing name and city');
    const btnHouses = makeToolButton('house', 'HNs: click a mapped road to add its missing house numbers from the address points', '#043b3c');
    const btnCleanUp = makeToolButton('magnet', 'Snap: click a mapped road to snap it onto the GIS centerline (Ctrl+Z undoes it)');
    const btnArea = makeToolButton('area', 'Area: outline an area, preview the GIS roads in it, then import them all in one run (saves every 25 roads), then add house numbers');
    const btnMissing = makeToolButton('search', 'Missing roads: find GIS roads in view that WME does not have');
    // The triangle is status only: green, orange or red for the selected segment. Click it to open the panel (Apply, Next, Prev).
    const btnGaps = makeToolButton('gaps', 'Segment check');
    btnGaps.style.position = 'relative';
    const gapsBadge = document.createElement('span');
    gapsBadge.style.cssText = 'position: absolute; right: -6px; top: -6px; min-width: 16px; height: 16px; padding: 0 3px; box-sizing: border-box; border-radius: 8px; ' +
        'background: #f29900; color: #ffffff; font: bold 10px/16px sans-serif; text-align: center; display: none; pointer-events: none;';
    btnGaps.appendChild(gapsBadge);
    const separator = document.createElement('span');
    separator.style.cssText = 'width: 1px; height: 22px; background: #dadce0; flex: none;';
    const btnMinimize = makeSmallButton('\u2013', 'Shrink to an icon in the stack of buttons on the right of the map (click the icon to bring the toolbar back)');
    bar.append(btnScan, btnRoads, btnHouses, btnCleanUp, btnArea, separator, btnMissing, btnGaps, btnMinimize);

    // Messages appear under the toolbar when something happens and go away by themselves, so the bar stays thin.
    const statusWrap = document.createElement('div');
    statusWrap.dataset.nodrag = '1';
    statusWrap.style.cssText = 'position: absolute; left: 0; width: 300px; display: none; background: #ffffff; border: 1px solid #dadce0; ' +
        'border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.35); cursor: default;';
    const statusEl = document.createElement('div');
    statusEl.style.cssText = 'font-size: 11px; color: #5f6368; line-height: 1.35; user-select: text; cursor: text; padding: 6px 24px 6px 8px; border-left: 4px solid transparent; border-radius: 6px;';
    statusEl.textContent = 'Ready.';
    const statusClose = makeSmallButton('\u00D7', 'Dismiss');
    statusClose.style.cssText += 'position: absolute; top: 3px; right: 4px;';
    statusWrap.append(statusEl, statusClose);
    container.appendChild(statusWrap);

    // The shrunken toolbar normally docks with WME's own overlay buttons (see dockInStack). This floating icon, the script's mark
    // in a small rounded square, is only the fallback for when WME's button stack cannot be found. A green dot shows a mode is on.
    const miniIcon = document.createElement('button');
    miniIcon.type = 'button';
    miniIcon.title = `${SCRIPT_NAME} (click to open the toolbar)`;
    miniIcon.style.cssText = `position: fixed; z-index: 999999; display: none; width: 40px; height: 40px; padding: 0; align-items: center; justify-content: center;
        border-radius: 11px; border: 2px solid #ffffff; background: #dbe9f4; box-shadow: 0 2px 8px rgba(0,0,0,0.4); cursor: pointer;`;
    miniIcon.appendChild(svgIcon(LOGO_SHAPES, 30, LOGO_VIEWBOX));
    const miniDot = document.createElement('span');
    miniDot.style.cssText = 'position: absolute; right: -5px; top: -5px; width: 15px; height: 15px; border-radius: 50%; background: #9aa0a6; border: 2px solid #ffffff; box-sizing: border-box;';
    miniIcon.appendChild(miniDot);

    document.body.append(container, miniIcon);

    let statusTimer = null;
    const STATUS_SHOW_MS = { info: 6000, ok: 12000, warn: 40000, error: 60000 };
    function hideStatusStrip() {
        clearTimeout(statusTimer);
        statusWrap.style.display = 'none';
    }
    function showStatusStrip(level) {
        if (toolbarState.closed || toolbarState.minimized || areaRunning) return;
        const r = container.getBoundingClientRect();
        const below = r.bottom + 150 < window.innerHeight;
        statusWrap.style.top = below ? 'calc(100% + 6px)' : 'auto';
        statusWrap.style.bottom = below ? 'auto' : 'calc(100% + 6px)';
        const alignRight = r.left + 300 > window.innerWidth;
        statusWrap.style.left = alignRight ? 'auto' : '0';
        statusWrap.style.right = alignRight ? '0' : 'auto';
        statusWrap.style.display = 'block';
        clearTimeout(statusTimer);
        statusTimer = setTimeout(hideStatusStrip, STATUS_SHOW_MS[level] || 12000);
    }
    statusWrap.addEventListener('mouseenter', () => clearTimeout(statusTimer));
    statusWrap.addEventListener('mouseleave', () => {
        clearTimeout(statusTimer);
        statusTimer = setTimeout(hideStatusStrip, 5000);
    });
    statusClose.addEventListener('click', hideStatusStrip);

    function savePosition() {
        try {
            localStorage.setItem(STORAGE_KEY_POS, JSON.stringify({
                left: parseInt(container.style.left, 10),
                top: parseInt(container.style.top, 10)
            }));
        } catch (e) { /* storage unavailable */ }
    }

    // The shrunken toolbar docks in the stack of round buttons on the right of the map (WME's own container, which also holds
    // Route Preview and Closures Toolkit). WME moves that whole container aside when the chat opens, so the icon follows it.
    // It goes below WME's own buttons (layers, refresh, link) and above the ones other scripts add.
    const dockButton = document.createElement('div');
    dockButton.id = 'wme-segment-importer-fab';
    dockButton.title = `${SCRIPT_NAME}: click to open the toolbar`;
    dockButton.setAttribute('role', 'button');
    dockButton.tabIndex = 0;
    dockButton.style.cssText = 'position: relative; width: 40px; height: 40px; border-radius: 50%; background: #ffffff; box-shadow: 0 2px 6px rgba(0,0,0,0.3); ' +
        'display: flex; align-items: center; justify-content: center; cursor: pointer; user-select: none; flex: none;';
    dockButton.appendChild(svgIcon(LOGO_SHAPES, 28, LOGO_VIEWBOX));
    const dockDot = document.createElement('span');
    dockDot.style.cssText = 'position: absolute; right: -3px; top: -3px; width: 15px; height: 15px; border-radius: 50%; background: #9aa0a6; border: 2px solid #ffffff; box-sizing: border-box;';
    dockButton.appendChild(dockDot);
    dockButton.addEventListener('click', () => setToolbar('open'));
    dockButton.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setToolbar('open');
        }
    });
    miniIcon.addEventListener('click', () => setToolbar('open'));

    function dockStack() {
        return document.querySelector('#overlay-buttons .overlay-buttons-container.top') || document.querySelector('.overlay-buttons-container.top');
    }

    // Is the icon in the stack? Its exact place is not policed: other scripts also put buttons in the stack, and two scripts each
    // insisting on being right after WME's buttons will move them back and forth for ever (that froze WME while minimized).
    function dockPlaced(stack) {
        return dockButton.parentElement === stack;
    }

    // Puts the icon in the stack (true), or reports that there is no stack to put it in (false).
    function dockInStack() {
        const stack = dockStack();
        if (!stack) return false;
        if (dockPlaced(stack)) return true;
        const own = [...stack.children].filter((c) => c.classList.contains('overlay-button'));
        if (own.length) own[own.length - 1].after(dockButton);
        else stack.prepend(dockButton);
        return true;
    }

    // The floating stand-in only shows if the stack stays missing for a while. WME rebuilds the whole stack when you save, and
    // for that moment the icon simply waits for it (the stand-in would sit at the toolbar's old spot and then jump).
    const DOCK_STAND_IN_AFTER_MS = 8000;
    let stackMissingSince = 0;

    function applyToolbarState() {
        const open = !toolbarState.closed && !toolbarState.minimized;
        const minimized = !toolbarState.closed && toolbarState.minimized;
        container.style.display = open ? 'flex' : 'none';
        if (minimized && dockInStack()) {
            stackMissingSince = 0;
            miniIcon.style.display = 'none';
        } else {
            dockButton.remove();
            if (minimized) {
                if (!stackMissingSince) stackMissingSince = Date.now();
                miniIcon.style.left = container.style.left;
                miniIcon.style.top = container.style.top;
                miniIcon.style.display = Date.now() - stackMissingSince > DOCK_STAND_IN_AFTER_MS ? 'flex' : 'none';
            } else {
                stackMissingSince = 0;
                miniIcon.style.display = 'none';
            }
        }
        if (!open) hideStatusStrip();
        if (sidebarUi && sidebarUi.toolbarBtn) sidebarUi.toolbarBtn.textContent = open ? 'Minimize the toolbar' : 'Open the toolbar';
    }

    // mode: 'open' or 'min' (docked icon)
    function setToolbar(mode) {
        toolbarState = { minimized: mode === 'min', closed: false };
        try {
            localStorage.setItem(STORAGE_KEY_TOOLBAR, JSON.stringify(toolbarState));
        } catch (e) { /* storage unavailable */ }
        applyToolbarState();
    }

    btnMinimize.addEventListener('click', () => setToolbar('min'));

    // WME rebuilds the whole button stack when you save, and the other overlay scripts put their buttons back at once. So the icon is
    // put back the moment the stack changes (this watches for that), with a slow timer as a backup.
    let dockCheckQueued = false;
    function checkDock() {
        dockCheckQueued = false;
        if (toolbarState.closed || !toolbarState.minimized) return;
        const stack = dockStack();
        if (stack && dockPlaced(stack)) return;
        applyToolbarState();
    }
    new MutationObserver(() => {
        if (dockCheckQueued || toolbarState.closed || !toolbarState.minimized) return;
        dockCheckQueued = true;
        setTimeout(checkDock, 150); // not at once: a save rebuilds the stack in many small steps
    }).observe(document.body, { childList: true, subtree: true });
    setInterval(checkDock, 2000);

    applyToolbarState();

    // ----- city check indicator: the toolbar's road icon, and the dot / tint on the docked icon -----
    // level: 'ok' (green), 'warn' (orange), 'error' (red), 'idle' (grey, nothing selected or not checked), 'off' (grey, crossed out)
    const CC_LOOK = {
        ok: { colour: '#188038', background: '#e6f4ea', border: '#188038', dot: '#188038', tint: null },
        warn: { colour: '#c26401', background: '#fff3e0', border: '#f29900', dot: '#f29900', tint: '#ffd699' },
        error: { colour: '#d93025', background: '#fce8e6', border: '#d93025', dot: '#d93025', tint: '#f6aea9' },
        idle: { colour: '#5f6368', background: '#ffffff', border: '#dadce0', dot: '#9aa0a6', tint: null },
        off: { colour: '#5f6368', background: '#ffffff', border: '#dadce0', dot: '#9aa0a6', tint: null }
    };
    let ccIndicatorLevel = 'idle';
    let ccIndicatorText = '';
    function ccSetIndicator(level, text) {
        ccIndicatorLevel = CC_LOOK[level] ? level : 'idle';
        ccIndicatorText = text || '';
        paintTriangle();
        ccPaintDock();
    }
    // The triangle: green, orange or red for the selected segment (or for the segments in view when none is selected); grey when the scan is Off.
    function paintTriangle() {
        const defaults = {
            ok: 'The name and city look right.',
            warn: 'Worth a look.',
            error: 'Needs attention.'
        };
        const off = scanLevel === 'off';
        const real = (v) => v === 'ok' || v === 'warn' || v === 'error';
        const selected = real(ccIndicatorLevel) ? ccIndicatorLevel : '';
        const level = off ? 'off' : selected || (real(ccAreaLevel) ? ccAreaLevel : 'idle');
        const look = CC_LOOK[level] || CC_LOOK.idle;
        btnGaps.style.color = look.colour;
        btnGaps.style.background = look.background;
        btnGaps.style.borderColor = look.border;
        let tip;
        if (off) {
            tip = 'Segment check: scanning is off (use the scan button). Click to open the panel.';
        } else {
            const parts = [selected ? (ccIndicatorText || defaults[selected]) : (gapZoomNote || 'No segment selected.')];
            if (gapList.length) parts.push(`${gapList.length} in view need info.`);
            tip = `Segment check: ${parts.join(' ')} Click to open the panel.`;
        }
        btnGaps.title = tip;
        btnGaps.setAttribute('aria-label', tip);
    }
    // The docked icon: the dot shows the worst of the selected segment and the segments in view; orange or red also tints the whole icon.
    let ccAreaLevel = 'idle';
    let ccAreaCount = 0;
    function ccPaintDock() {
        const rank = { idle: 0, off: 0, ok: 1, warn: 2, error: 3 };
        const level = rank[ccAreaLevel] > rank[ccIndicatorLevel] ? ccAreaLevel : ccIndicatorLevel;
        const look = CC_LOOK[level] || CC_LOOK.idle;
        miniDot.style.background = look.dot;
        dockDot.style.background = look.dot;
        dockButton.style.background = look.tint || '#ffffff';
        miniIcon.style.background = look.tint || '#dbe9f4';
        const notes = [];
        if (ccIndicatorLevel === 'warn' || ccIndicatorLevel === 'error') notes.push('the selected segment needs a look');
        if (ccAreaCount) notes.push(`${ccAreaCount} segment${ccAreaCount === 1 ? '' : 's'} in view need info`);
        dockButton.title = `${SCRIPT_NAME}${notes.length ? `: ${notes.join('; ')}` : ''}. Click to open the toolbar`;
    }
    ccSetIndicator('idle');

    // green = it worked, orange = something to check, red = an error, grey = information
    function statusStyle(level) {
        if (level === 'ok') return { color: '#0d652d', background: '#e6f4ea', border: '#188038' };
        if (level === 'warn') return { color: '#9a5200', background: '#fff3e0', border: '#f29900' };
        if (level === 'error') return { color: '#b31412', background: '#fce8e6', border: '#d93025' };
        return { color: '#5f6368', background: '#f1f3f4', border: '#bdc1c6' };
    }

    function paintStatus(element, level) {
        const st = statusStyle(level);
        element.style.color = st.color;
        element.style.backgroundColor = st.background;
        element.style.borderLeft = `4px solid ${st.border}`;
    }

    let lastStatusLevel = 'info';
    let lastStatusMessage = 'Ready.';
    let lastStatusActions = null;

    // Buttons under a status message: [{ label, primary, run }]. Used for a one-click fix (e.g. rename to the GIS name).
    function addStatusActions(element, actions) {
        if (!actions || !actions.length) return;
        const row = document.createElement('div');
        row.dataset.nodrag = '1';
        row.style.cssText = 'display: flex; flex-direction: column; gap: 4px; margin-top: 6px;';
        for (const action of actions) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = action.label;
            btn.style.cssText = `border: 1px solid ${action.primary ? '#1a73e8' : '#9aa0a6'}; background: ${action.primary ? '#1a73e8' : '#ffffff'}; color: ${action.primary ? '#ffffff' : '#3c4043'}; ` +
                'border-radius: 5px; padding: 4px 8px; font-size: 11px; font-weight: bold; cursor: pointer; text-align: left; white-space: normal;';
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                btn.disabled = true;
                try {
                    await action.run();
                } catch (err) {
                    console.warn(`[${SCRIPT_NAME}] Status action failed:`, err);
                    setStatus(`Could not do that (${err.message || err}).`, 'error');
                }
            });
            row.appendChild(btn);
        }
        element.appendChild(row);
    }

    function setStatus(message, level, actions) {
        lastStatusLevel = level;
        lastStatusMessage = message;
        lastStatusActions = actions || null;
        statusEl.textContent = message;
        addStatusActions(statusEl, actions);
        paintStatus(statusEl, level);
        showStatusStrip(level);
        if (sidebarUi) {
            sidebarUi.statusBox.textContent = message;
            addStatusActions(sidebarUi.statusBox, actions);
            paintStatus(sidebarUi.statusBox, level);
        }
    }

    // A street name that differs from the GIS name: kept for this session only when you press "Keep mine".
    const keptNames = new Set();
    const keptKey = (segmentId, gisName) => `${segmentId}|${normalizeName(gisName)}`;
    function editDistance(a, b) {
        const row = Array.from({ length: b.length + 1 }, (_, i) => i);
        for (let i = 1; i <= a.length; i++) {
            let prev = row[0];
            row[0] = i;
            for (let j = 1; j <= b.length; j++) {
                const tmp = row[j];
                row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
                prev = tmp;
            }
        }
        return row[b.length];
    }
    function mismatchText(mapped, gis) {
        const a = normalizeName(mapped);
        const b = normalizeName(gis);
        const typo = a.length >= 5 && b.length >= 5 && editDistance(a, b) <= 2;
        return `\uD83D\uDEE0\uFE0F Name mismatch: mapped "${mapped}", GIS "${gis}".${typo ? ' The spelling differs by only a letter or two, so the GIS may have the typo: check before applying.' : ''}`;
    }

    let isDragging = false;
    let startX = 0;
    let startY = 0;

    container.addEventListener('mousedown', (e) => {
        if (e.target.closest('button') || e.target.closest('[data-nodrag]')) return;
        isDragging = true;
        startX = e.clientX - container.offsetLeft;
        startY = e.clientY - container.offsetTop;
        container.style.cursor = 'grabbing';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        container.style.left = `${e.clientX - startX}px`;
        container.style.top = `${e.clientY - startY}px`;
    });

    document.addEventListener('mouseup', () => {
        if (!isDragging) return;
        isDragging = false;
        container.style.cursor = 'move';
        savePosition();
    });

    const cursorRing = document.createElement('div');
    cursorRing.id = 'wme-gis-cursor-ring';
    cursorRing.style.cssText = `
        position: fixed;
        width: 24px;
        height: 24px;
        margin-left: -12px;
        margin-top: -12px;
        border: 2px solid ${COLOUR_ROADS};
        background-color: ${COLOUR_ROADS}33;
        border-radius: 50%;
        pointer-events: none;
        z-index: 999998;
        display: none;
    `;
    document.body.appendChild(cursorRing);

    function paintToggleButton(button, on, colour) {
        button.style.background = on ? colour : '#ffffff';
        button.style.borderColor = on ? colour : '#dadce0';
        button.style.color = on ? button._onIcon : '#5f6368';
        button.setAttribute('aria-pressed', String(on));
    }

    function paintSwitch(ui, on, colour) {
        ui.switchBtn.setAttribute('aria-checked', String(on));
        ui.switchBtn.style.background = on ? colour : '#bdc1c6';
        ui.knob.style.left = on ? '20px' : '2px';
        ui.stateText.textContent = on ? 'ON' : 'OFF';
        ui.stateText.style.color = on ? '#188038' : '#5f6368';
    }

    function describeToggles() {
        let text;
        if (importRoadsEnabled && houseNumbersEnabled) {
            text = 'Roads and HNs: click an existing road to fill in its missing name and city and add its missing house numbers; click a road that is not mapped yet to import it and add its house numbers.';
        } else if (importRoadsEnabled) {
            text = 'Roads: click a GIS road to import it or extend a stub. Click a mapped road to fill in its missing street name and city.';
        } else if (houseNumbersEnabled) {
            text = 'HNs: click a mapped road to add the house numbers it is missing.';
        } else if (cleanUpEnabled) {
            text = 'Snap: click a mapped road to snap it onto the GIS centerline.';
        } else {
            return 'Importer off.';
        }
        if (cleanUpEnabled && (importRoadsEnabled || houseNumbersEnabled)) {
            text += ' Snap is ON too: a mapped road you click is also snapped onto the GIS centerline.';
        }
        return cleanUpEnabled ? `${text} Ctrl+Z undoes a snap.` : text;
    }

    // Single place that applies the switches; keeps the floating panel, the sidebar tab and the map cursor in sync.
    function applyToggleState() {
        isImporterActive = importRoadsEnabled || houseNumbersEnabled || cleanUpEnabled;

        paintToggleButton(btnRoads, importRoadsEnabled, COLOUR_ROADS);
        paintToggleButton(btnHouses, houseNumbersEnabled, COLOUR_HOUSES);
        paintToggleButton(btnCleanUp, cleanUpEnabled, COLOUR_CLEANUP);

        cursorRing.style.display = isImporterActive && !areaDrawing ? 'block' : 'none';
        // The dots on the shrunken icon show the city check (see ccSetIndicator); a purple-pink ring shows a mode is on.
        dockButton.style.boxShadow = isImporterActive ? `0 0 0 3px ${COLOUR_ROADS}, 0 2px 6px rgba(0,0,0,0.3)` : '0 2px 6px rgba(0,0,0,0.3)';
        miniIcon.style.boxShadow = isImporterActive ? `0 0 0 3px ${COLOUR_ROADS}, 0 2px 8px rgba(0,0,0,0.4)` : '0 2px 8px rgba(0,0,0,0.4)';
        // purple-pink = roads, aquamarine = house numbers, purple-pink with an aquamarine outer ring = both
        const both = importRoadsEnabled && houseNumbersEnabled;
        const onlyCleanUp = cleanUpEnabled && !importRoadsEnabled && !houseNumbersEnabled;
        const main = onlyCleanUp ? COLOUR_CLEANUP : houseNumbersEnabled && !importRoadsEnabled ? COLOUR_HOUSES : COLOUR_ROADS;
        cursorRing.style.borderStyle = cleanUpEnabled ? 'dashed' : 'solid'; // dashed = clicking an existing road will edit it
        cursorRing.style.borderColor = main;
        cursorRing.style.backgroundColor = `${main}33`;
        cursorRing.style.boxShadow = both ? `0 0 0 4px ${COLOUR_HOUSES}` : 'none';

        if (sidebarUi) {
            sidebarUi.dot.style.background = isImporterActive ? '#188038' : '#9aa0a6';
            sidebarUi.label.title = `${SCRIPT_NAME}: ${isImporterActive ? 'ON' : 'OFF'}`;
            paintSwitch(sidebarUi.roads, importRoadsEnabled, COLOUR_ROADS);
            paintSwitch(sidebarUi.houses, houseNumbersEnabled, COLOUR_HOUSES);
            paintSwitch(sidebarUi.cleanup, cleanUpEnabled, COLOUR_CLEANUP);
        }
        scheduleGapScan();
    }

    // WME GIS Layers must be installed, switched on and have layers checked for the importer to use any GIS layer outside Kendall County.
    function gislState() {
        try {
            const st = JSON.parse(localStorage.getItem(GISL_SETTINGS_KEY) || 'null');
            if (!st) return { found: false };
            return { found: true, enabled: st.enabled !== false, checked: (st.visibleLayers || []).length };
        } catch (e) {
            return { found: false };
        }
    }
    function gislProblem() {
        const st = gislState();
        if (!st.found) return 'WME GIS Layers does not seem to be installed or set up, so there are no GIS layers to use outside Kendall County.';
        if (!st.enabled) return 'WME GIS Layers is switched off, so the importer sees no GIS layers. Turn it on in its sidebar tab.';
        if (!st.checked) return 'No layers are checked in WME GIS Layers, so the importer has no GIS layers to use outside Kendall County.';
        return '';
    }
    function inKendallView() {
        try {
            const [a, b, c, d] = sdk.Map.getMapExtent();
            const lon = (a + c) / 2;
            const lat = (b + d) / 2;
            return lon >= KENDALL.bounds.minLon && lon <= KENDALL.bounds.maxLon && lat >= KENDALL.bounds.minLat && lat <= KENDALL.bounds.maxLat;
        } catch (e) {
            return false;
        }
    }
    function warnIfGisLayersOff() {
        const problem = gislProblem();
        if (problem && !inKendallView()) setStatus(problem, 'warn');
    }

    function setRoadsOn(on) {
        importRoadsEnabled = on;
        applyToggleState();
        setStatus(describeToggles(), 'info');
        if (on) warnIfGisLayersOff();
        console.log(`[${SCRIPT_NAME}] roads ${on ? 'on' : 'off'}.`);
    }

    function setHousesOn(on) {
        houseNumbersEnabled = on;
        applyToggleState();
        setStatus(describeToggles(), 'info');
        if (on) warnIfGisLayersOff();
        console.log(`[${SCRIPT_NAME}] HNs ${on ? 'on' : 'off'}.`);
    }

    function setCleanUpOn(on) {
        cleanUpEnabled = on;
        applyToggleState();
        setStatus(describeToggles(), 'info');
        if (on) warnIfGisLayersOff();
        console.log(`[${SCRIPT_NAME}] snap ${on ? 'on' : 'off'}.`);
    }

    btnRoads.addEventListener('click', () => setRoadsOn(!importRoadsEnabled));
    btnCleanUp.addEventListener('click', () => setCleanUpOn(!cleanUpEnabled));
    btnHouses.addEventListener('click', () => setHousesOn(!houseNumbersEnabled));
    applyToggleState();

    // ------------------------------------------------------------------
    // Sidebar tab (script panel)
    // ------------------------------------------------------------------

    try {
        const { tabLabel, tabPane } = await sdk.Sidebar.registerScriptTab();

        // Tab button: icon with a small on/off dot
        tabLabel.title = `${SCRIPT_NAME}: importer OFF`;
        const icon = document.createElement('span');
        icon.style.cssText = 'position: relative; display: inline-block; line-height: 0;';
        icon.appendChild(svgIcon(LOGO_SHAPES, 22, LOGO_VIEWBOX));
        const dot = document.createElement('span');
        dot.style.cssText = 'position: absolute; right: -6px; top: -4px; width: 8px; height: 8px; border-radius: 50%; background: #9aa0a6; border: 1px solid #ffffff;';
        icon.appendChild(dot);
        tabLabel.appendChild(icon);

        // Tab content
        const wrap = document.createElement('div');
        wrap.style.cssText = 'padding: 0 16px 16px; font-family: sans-serif; font-size: 13px; color: #202124;';

        const heading = document.createElement('div');
        heading.style.cssText = 'font-weight: bold; font-size: 15px; margin: 8px 0 2px;';
        heading.textContent = SCRIPT_NAME;
        wrap.appendChild(heading);

        const versionLine = document.createElement('div');
        versionLine.style.cssText = 'font-size: 11px; color: #5f6368; margin-bottom: 12px;';
        versionLine.textContent = `Version ${SCRIPT_VERSION}`;
        wrap.appendChild(versionLine);

        const makeSwitchRow = (labelText, tip, iconName, iconColour) => {
            const row = document.createElement('div');
            row.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-bottom: 8px;';
            const switchBtn = document.createElement('button');
            switchBtn.type = 'button';
            switchBtn.setAttribute('role', 'switch');
            switchBtn.setAttribute('aria-checked', 'false');
            switchBtn.title = tip;
            switchBtn.style.cssText = 'position: relative; width: 40px; height: 22px; border: none; border-radius: 11px; background: #bdc1c6; cursor: pointer; padding: 0; flex: none;';
            const knob = document.createElement('span');
            knob.style.cssText = 'position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: #ffffff; box-shadow: 0 1px 3px rgba(0,0,0,0.4); transition: left 0.15s;';
            switchBtn.appendChild(knob);
            row.appendChild(switchBtn);
            if (iconName) {
                const rowIcon = svgIcon(ICON_SHAPES[iconName], 16);
                rowIcon.style.color = iconColour;
                row.appendChild(rowIcon);
            }
            const text = document.createElement('span');
            text.textContent = labelText;
            row.appendChild(text);
            const stateText = document.createElement('strong');
            stateText.textContent = 'OFF';
            stateText.style.color = '#5f6368';
            row.appendChild(stateText);
            wrap.appendChild(row);
            return { switchBtn, knob, stateText };
        };
        const roadsUi = makeSwitchRow('Roads:', 'Import roads from the GIS, extend stubs, and fill in missing names and cities on mapped roads', 'road', COLOUR_ROADS);
        const housesUi = makeSwitchRow('HNs (house numbers):', 'Add house numbers from the address points', 'house', '#0a9c9d');
        const cleanupUi = makeSwitchRow('Snap:', 'Click a mapped road to snap it onto the GIS centerline', 'magnet', COLOUR_CLEANUP);
        cleanupUi.stateText.parentElement.style.marginBottom = '12px';

        const gisWarning = document.createElement('div');
        gisWarning.style.cssText = 'display: none; margin-bottom: 12px; padding: 6px 8px; border-left: 4px solid #f29900; border-radius: 3px; background: #fff3e0; color: #9a5200; font-size: 12px; line-height: 1.35;';
        wrap.appendChild(gisWarning);
        const refreshGisWarning = () => {
            const problem = inKendallView() ? '' : gislProblem();
            gisWarning.textContent = problem;
            gisWarning.style.display = problem ? 'block' : 'none';
        };
        refreshGisWarning();
        setInterval(refreshGisWarning, 5000);

        const gapsLabel = document.createElement('div');
        gapsLabel.style.cssText = 'font-size: 11px; font-weight: bold; color: #5f6368; margin-bottom: 4px;';
        gapsLabel.textContent = 'Checks and autofill';
        wrap.appendChild(gapsLabel);
        const makeCheck = (text, checked, onChange) => {
            const label = document.createElement('label');
            label.style.cssText = 'display: flex; align-items: flex-start; gap: 6px; font-size: 12px; margin-bottom: 4px; cursor: pointer;';
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.checked = checked;
            box.addEventListener('change', () => onChange(box.checked));
            label.append(box, document.createTextNode(text));
            wrap.appendChild(label);
        };
        makeCheck('Autofill: a segment I draw by hand inside city or CDP limits gets its primary city (works even when the scan is Off)', autofillEnabled, (v) => {
            autofillEnabled = v;
            try {
                localStorage.setItem(STORAGE_KEY_AUTOFILL, v ? 'on' : 'off');
            } catch (e) { /* storage unavailable */ }
            setStatus(v ? 'Autofill is on: hand-drawn segments inside city limits get their primary city.' : 'Autofill is off.', 'info');
        });
        const scanHint = document.createElement('div');
        scanHint.style.cssText = 'font-size: 11px; color: #5f6368; line-height: 1.4; margin: 4px 0 4px;';
        scanHint.textContent = 'The scan button on the toolbar sets Off, Light or Full. The triangle shows the selected segment (green, orange or red); click it for the panel with Apply, Next and Prev. With Roads on, hover a flagged segment to see what is wrong, and right-click to apply the fix.';
        wrap.appendChild(scanHint);
        const gapsSummary = document.createElement('div');
        gapsSummary.style.cssText = 'font-size: 11px; color: #5f6368; line-height: 1.4; margin: 2px 0 12px;';
        wrap.appendChild(gapsSummary);
        const legend = document.createElement('div');
        legend.style.cssText = 'font-size: 11px; color: #5f6368; line-height: 1.6; margin-bottom: 12px;';
        Object.values(GAP_KINDS).forEach((k) => {
            const row = document.createElement('div');
            const chip = document.createElement('span');
            chip.style.cssText = `display: inline-block; width: 18px; height: 6px; border-radius: 3px; margin-right: 6px; vertical-align: middle; background: ${k.colour};`;
            row.append(chip, document.createTextNode(k.label));
            legend.appendChild(row);
        });
        wrap.appendChild(legend);

        const toolbarBtn = document.createElement('button');
        toolbarBtn.type = 'button';
        toolbarBtn.style.cssText = 'padding: 6px 10px; margin-bottom: 12px; border: 1px solid #dadce0; border-radius: 6px; background: #ffffff; color: #202124; font-size: 12px; cursor: pointer;';
        toolbarBtn.addEventListener('click', () => setToolbar(toolbarState.minimized ? 'open' : 'min'));
        wrap.appendChild(toolbarBtn);

        const postalLabel = document.createElement('div');
        postalLabel.style.cssText = 'font-size: 11px; font-weight: bold; color: #5f6368; margin-bottom: 2px;';
        postalLabel.textContent = 'Postal city for roads with no ZIP';
        wrap.appendChild(postalLabel);

        const postalInput = document.createElement('input');
        postalInput.type = 'text';
        postalInput.placeholder = 'e.g. Boerne (blank = none)';
        postalInput.value = defaultPostalCity;
        postalInput.style.cssText = 'width: 100%; box-sizing: border-box; padding: 6px 8px; margin-bottom: 4px; border: 1px solid #dadce0; border-radius: 6px; font-size: 13px;';
        postalInput.addEventListener('change', () => {
            defaultPostalCity = postalInput.value.trim();
            try {
                localStorage.setItem(STORAGE_KEY_POSTAL, defaultPostalCity);
            } catch (e) { /* storage unavailable */ }
            setStatus(defaultPostalCity
                ? `Roads with no ZIP will get "${defaultPostalCity}" as their alternate city.`
                : 'No default postal city; roads with no ZIP get no alternate city.', 'ok');
        });
        wrap.appendChild(postalInput);

        const postalHint = document.createElement('div');
        postalHint.style.cssText = 'font-size: 11px; color: #5f6368; line-height: 1.35; margin-bottom: 12px;';
        postalHint.textContent = 'Used as the alternate city only when the GIS road has no ZIP of its own. Remembered between sessions.';
        wrap.appendChild(postalHint);

        const setbackRow = document.createElement('div');
        setbackRow.style.cssText = 'display: flex; align-items: center; gap: 6px; font-size: 12px; margin-bottom: 12px;';
        setbackRow.appendChild(document.createTextNode('Marker distance from the road (m):'));
        const setbackInput = document.createElement('input');
        setbackInput.type = 'number';
        setbackInput.min = '0';
        setbackInput.max = '200';
        setbackInput.step = '5';
        setbackInput.value = String(houseNumberSetbackM);
        setbackInput.style.cssText = 'width: 60px; padding: 3px 6px; border: 1px solid #dadce0; border-radius: 6px; font-size: 12px;';
        setbackInput.addEventListener('change', () => {
            const value = parseFloat(setbackInput.value);
            if (Number.isFinite(value) && value >= 0 && value <= 200) {
                houseNumberSetbackM = value;
                try {
                    localStorage.setItem(STORAGE_KEY_HN_SETBACK, String(value));
                } catch (e) { /* storage unavailable */ }
                setStatus(`House number markers will be placed ${value} m out from the road.`, 'ok');
            } else {
                setbackInput.value = String(houseNumberSetbackM);
            }
        });
        setbackRow.appendChild(setbackInput);
        wrap.appendChild(setbackRow);

        const exactRow = document.createElement('div');
        exactRow.style.cssText = 'display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 12px; margin-bottom: 4px;';
        exactRow.appendChild(document.createTextNode('Put a number exactly at its address point when the point is at least'));
        const exactInput = document.createElement('input');
        exactInput.type = 'number';
        exactInput.min = '0';
        exactInput.max = '5000';
        exactInput.step = '5';
        exactInput.value = String(houseNumberExactFt);
        exactInput.style.cssText = 'width: 60px; padding: 3px 6px; border: 1px solid #dadce0; border-radius: 6px; font-size: 12px;';
        exactInput.addEventListener('change', () => {
            const value = parseFloat(exactInput.value);
            if (Number.isFinite(value) && value >= 0 && value <= 5000) {
                houseNumberExactFt = value;
                try {
                    localStorage.setItem(STORAGE_KEY_HN_EXACT, String(value));
                } catch (e) { /* storage unavailable */ }
                setStatus(value >= 5000 ? 'House numbers will always go the marker distance out from the road.'
                    : `Address points ${value} ft or more from the road will be used exactly; closer ones go ${houseNumberSetbackM} m out.`, 'ok');
            } else {
                exactInput.value = String(houseNumberExactFt);
            }
        });
        exactRow.append(exactInput, document.createTextNode('ft from the road'));
        wrap.appendChild(exactRow);
        const exactHint = document.createElement('div');
        exactHint.style.cssText = 'font-size: 11px; color: #5f6368; line-height: 1.35; margin-bottom: 12px;';
        exactHint.textContent = 'Closer than that, the point is taken to be on the street, and the number goes the marker distance out. 0 = always at the point. 5000 = never.';
        wrap.appendChild(exactHint);

        const nameRadiusRow = document.createElement('div');
        nameRadiusRow.style.cssText = 'display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 12px; margin-bottom: 4px;';
        nameRadiusRow.appendChild(document.createTextNode('Name a road from address points within'));
        const nameRadiusInput = document.createElement('input');
        nameRadiusInput.type = 'number';
        nameRadiusInput.min = '10';
        nameRadiusInput.max = '150';
        nameRadiusInput.step = '5';
        nameRadiusInput.value = String(addressNameRadiusM);
        nameRadiusInput.style.cssText = 'width: 60px; padding: 3px 6px; border: 1px solid #dadce0; border-radius: 6px; font-size: 12px;';
        nameRadiusInput.addEventListener('change', () => {
            const value = parseFloat(nameRadiusInput.value);
            if (Number.isFinite(value) && value >= 10 && value <= 150) {
                addressNameRadiusM = value;
                try {
                    localStorage.setItem(STORAGE_KEY_NAME_RADIUS, String(value));
                } catch (e) { /* storage unavailable */ }
                setStatus(`A road with no GIS road along it will take its street name from the address points within ${value} m.`, 'ok');
            } else {
                nameRadiusInput.value = String(addressNameRadiusM);
            }
        });
        nameRadiusRow.append(nameRadiusInput, document.createTextNode('m of it'));
        wrap.appendChild(nameRadiusRow);
        const nameRadiusHint = document.createElement('div');
        nameRadiusHint.style.cssText = 'font-size: 11px; color: #5f6368; line-height: 1.35; margin-bottom: 12px;';
        nameRadiusHint.textContent = 'Only used when no GIS road runs along the segment. The street with the most points (at least 2, and 60% of them) wins; the console lists the names it saw.';
        wrap.appendChild(nameRadiusHint);

        const statusLabel = document.createElement('div');
        statusLabel.style.cssText = 'font-size: 11px; font-weight: bold; color: #5f6368; margin-bottom: 2px;';
        statusLabel.textContent = 'Status';
        wrap.appendChild(statusLabel);

        const statusBox = document.createElement('div');
        statusBox.style.cssText = 'min-height: 48px; padding: 8px; border: 1px solid #dadce0; border-radius: 6px; background: #f8f9fa; font-size: 12px; line-height: 1.35; color: #5f6368; user-select: text;';
        statusBox.textContent = statusEl.textContent;
        paintStatus(statusBox, 'info');
        wrap.appendChild(statusBox);

        const hint = document.createElement('div');
        hint.style.cssText = 'margin-top: 10px; font-size: 11px; color: #5f6368; line-height: 1.35;';
        hint.textContent = 'Roads on: click a GIS road to import it or extend a stub; click a mapped road to fill in its missing street name and city from the GIS (nothing it already has is changed). HNs on: click an existing road to add the house numbers it is missing. Both on: existing roads get house numbers, and roads not mapped yet are imported. Snap on: clicking a mapped road snaps it onto the GIS centerline (Ctrl+Z undoes it; hand mapping is often better, so it starts off). Hold Shift while clicking to import a road anyway. Area (the dotted outline button on the toolbar): click the corners of an area and double-click to close it, Preview to see which GIS roads it would import, Go to import them one at a time (saving every 25; Pause and Stop are on its panel, Escape stops), then House numbers for the second run. Roads that cross the outline are imported whole. The same outline can also fix the existing segments the scan flags: Check flagged counts them, Fix flagged fills in names and cities, corrects primary cities (clearing one and using the postal city as the alternate when the limits call for it) and renames a street to the GIS name when it differs. A road with no GIS data and no name can be named from Google Maps: right-click the street there (this script runs on Google Maps too), then click the segment here with Roads on. Kendall County uses its own county data; elsewhere in Texas the road and address point layers you have switched on in WME GIS Layers are used (city first, then county, then statewide).';
        wrap.appendChild(hint);

        tabPane.appendChild(wrap);

        sidebarUi = { label: tabLabel, dot, roads: roadsUi, houses: housesUi, cleanup: cleanupUi, statusBox, toolbarBtn, gapsSummary };
        roadsUi.switchBtn.addEventListener('click', () => setRoadsOn(!importRoadsEnabled));
        housesUi.switchBtn.addEventListener('click', () => setHousesOn(!houseNumbersEnabled));
        cleanupUi.switchBtn.addEventListener('click', () => setCleanUpOn(!cleanUpEnabled));
        applyToggleState(); // paint the initial state
        applyToolbarState();
    } catch (err) {
        console.warn(`[${SCRIPT_NAME}] Could not register sidebar tab:`, err);
    }

    // ------------------------------------------------------------------
    // Geometry helpers
    // ------------------------------------------------------------------

    // Lon/lat bounds of the visible map area.
    function visibleBounds() {
        const r = mapDiv.getBoundingClientRect();
        const topLeft = sdk.Map.getLonLatFromPixel({ x: r.left, y: r.top });
        const bottomRight = sdk.Map.getLonLatFromPixel({ x: r.right, y: r.bottom });
        return {
            minLon: Math.min(topLeft.lon, bottomRight.lon),
            maxLon: Math.max(topLeft.lon, bottomRight.lon),
            minLat: Math.min(topLeft.lat, bottomRight.lat),
            maxLat: Math.max(topLeft.lat, bottomRight.lat)
        };
    }

    function isOnScreen(coord, bounds) {
        return coord[0] >= bounds.minLon && coord[0] <= bounds.maxLon &&
            coord[1] >= bounds.minLat && coord[1] <= bounds.maxLat;
    }

    // ------------------------------------------------------------------
    // Node sharing
    // ------------------------------------------------------------------
    function findNearestNode(lon, lat, tolerance = SNAP_TOLERANCE_M) {
        const latWindow = (tolerance * 2) / 111000;
        const lonWindow = latWindow / Math.max(Math.cos(lat * RAD), 0.01);

        let best = null;
        let bestDist = Infinity;
        for (const node of sdk.DataModel.Nodes.getAll()) {
            if (!node.connectedSegmentIds.length) continue; // a deleted node lingers with no segments
            const [nx, ny] = node.geometry.coordinates;
            if (Math.abs(ny - lat) > latWindow || Math.abs(nx - lon) > lonWindow) continue;
            const d = distanceMeters(lat, lon, ny, nx);
            if (d < bestDist) {
                bestDist = d;
                best = node;
            }
        }
        return best && bestDist <= tolerance ? { node: best, dist: bestDist } : null;
    }

    // Nearest point on a polyline (arrays of [lon, lat]) to p ({lon, lat}): { dist (meters), point [lon, lat] }.
    function nearestPointOnLine(p, line) {
        const mx = 111320 * Math.cos(p.lat * RAD);
        const my = 110540;
        let best = { dist: Infinity, point: null };
        for (let i = 0; i < line.length - 1; i++) {
            const ax = (line[i][0] - p.lon) * mx;
            const ay = (line[i][1] - p.lat) * my;
            const bx = (line[i + 1][0] - p.lon) * mx;
            const by = (line[i + 1][1] - p.lat) * my;
            const dx = bx - ax;
            const dy = by - ay;
            const len2 = dx * dx + dy * dy;
            let t = len2 ? (-ax * dx - ay * dy) / len2 : 0;
            t = Math.max(0, Math.min(1, t));
            const qx = ax + t * dx;
            const qy = ay + t * dy;
            const d = Math.hypot(qx, qy);
            if (d < best.dist) best = { dist: d, point: [p.lon + qx / mx, p.lat + qy / my] };
        }
        return best;
    }

    function findNearestSegment(lon, lat, tolerance = SNAP_TOLERANCE_M) {
        let best = null;
        for (const segment of sdk.DataModel.Segments.getAll()) {
            if (!isLiveSegment(segment)) continue; // a deleted segment lingers with no nodes
            const hit = nearestPointOnLine({ lon, lat }, segment.geometry.coordinates);
            if (hit.dist <= tolerance && (!best || hit.dist < best.dist)) {
                best = { segment, dist: hit.dist, point: hit.point };
            }
        }
        return best;
    }

    // Decides what each endpoint connects to: an existing node first, otherwise the middle of an
    // existing segment (which WME then splits). The endpoint is moved onto that exact spot and a
    // "snapped feature" record is built, the same record WME's own drawing tool hands to its
    // AddSegment action.
    function snapEndpoints(coords, tolerances = {}) {
        const last = coords.length - 1;
        const snaps = {};
        const snappedFeatures = [];
        const nativeModel = pageWin.W && pageWin.W.model;

        const trySnap = (index, key, other) => {
            const c = coords[index];
            let snap = null;

            const tol = tolerances[key] || SNAP_TOLERANCE_M;
            const nodeHit = findNearestNode(c[0], c[1], tol);
            if (nodeHit) {
                snap = { kind: 'node', targetId: nodeHit.node.id, coord: [...nodeHit.node.geometry.coordinates] };
            } else {
                const edgeHit = findNearestSegment(c[0], c[1], tol);
                if (edgeHit) snap = { kind: 'edge', targetId: edgeHit.segment.id, coord: [...edgeHit.point] };
            }
            if (!snap) return;
            if (other && other.kind === snap.kind && other.targetId === snap.targetId) return;

            const nativeFeature = snap.kind === 'node'
                ? nativeModel?.nodes?.getObjectById(snap.targetId)
                : nativeModel?.segments?.getObjectById(snap.targetId);

            coords[index] = snap.coord;
            snaps[key] = snap;
            if (nativeFeature) {
                snappedFeatures.push({
                    feature: nativeFeature,
                    point: { type: 'Point', coordinates: [...snap.coord] },
                    type: snap.kind
                });
            }
        };

        trySnap(0, 'from', null);
        trySnap(last, 'to', snaps.from);
        return { snaps, snappedFeatures };
    }

    // SDK addSegment never connects to existing nodes on its own (it leaves the native action's
    // snappedFeatures empty). This attaches them to the native AddSegment action for the duration
    // of the call, then restores the original method. Non-SDK, so failures fall back to a plain add.
    function addSegmentWithSnaps(coords, snappedFeatures, roadType = ROAD_TYPE_STREET) {
        const args = { geometry: { type: 'LineString', coordinates: coords }, roadType };
        const actionManager = pageWin.W && pageWin.W.model && pageWin.W.model.actionManager;

        if (!snappedFeatures.length || !actionManager || typeof actionManager.add !== 'function') {
            const segmentId = sdk.DataModel.Segments.addSegment(args);
            importerMadeIds.add(segmentId);
            return { segmentId, patched: false };
        }

        const originalAdd = actionManager.add;
        let patched = false;
        actionManager.add = function (action, ...rest) {
            if (!patched && action && action.constructor && action.constructor.name === 'AddSegment') {
                action.snappedFeatures = snappedFeatures;
                patched = true;
            }
            return originalAdd.call(this, action, ...rest);
        };
        try {
            const segmentId = sdk.DataModel.Segments.addSegment(args);
            importerMadeIds.add(segmentId);
            return { segmentId, patched };
        } finally {
            actionManager.add = originalAdd;
        }
    }

    // ------------------------------------------------------------------
    // Turns
    // ------------------------------------------------------------------
    // WME's AddSegment already opens turns when it joins. This confirms it and fixes anything left closed.
    async function verifyTurns(nodeId, newSegmentId) {
        const { Turns } = sdk.DataModel;
        await sleep(300);

        const involved = () => Turns.getTurnsThroughNode({ nodeId })
            .filter((t) => (t.fromSegmentId === newSegmentId || t.toSegmentId === newSegmentId) && t.fromSegmentId !== t.toSegmentId);

        try {
            for (const turn of involved()) {
                if (turn.isAllowed) continue;
                const args = { fromSegmentId: turn.fromSegmentId, toSegmentId: turn.toSegmentId, nodeId };
                if (Turns.isTurnAllowedBySegmentDirections(args)) {
                    Turns.updateTurn({ turnId: turn.id, isAllowed: true });
                }
            }
            const turns = involved();
            const blocked = turns.filter((t) => !t.isAllowed && Turns.isTurnAllowedBySegmentDirections({
                fromSegmentId: t.fromSegmentId, toSegmentId: t.toSegmentId, nodeId
            }));
            return { total: turns.length, allowed: turns.filter((t) => t.isAllowed).length, blocked: blocked.length };
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Turn verification failed:`, err);
            return { error: err.message || String(err) };
        }
    }

    // ------------------------------------------------------------------
    // Street names
    // ------------------------------------------------------------------

    // ------------------------------------------------------------------
    // City / CDP limits and postal cities
    // ------------------------------------------------------------------
    // Same boundary file the WME Cities Overlay script draws (cities and Census Designated Places).
    // Texas only for now; other states use their own file in the same folder.
    const CITY_KML_URL = 'https://raw.githubusercontent.com/WazeDev/WME-Cities-Overlay/master/KMLs/US/TX_Cities.kml';

    let cityLoadPromise = null;

    function downloadText(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                timeout: 60000,
                onload: (response) => (response.status >= 200 && response.status < 300
                    ? resolve(response.responseText)
                    : reject(new Error(`HTTP ${response.status}`))),
                onerror: () => reject(new Error('download failed')),
                ontimeout: () => reject(new Error('download timed out'))
            });
        });
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

    function parseCityKml(text) {
        const doc = new DOMParser().parseFromString(text, 'text/xml');
        const parseRing = (el) => (el
            ? el.textContent.trim().split(/\s+/)
                .map((s) => s.split(',').slice(0, 2).map(Number))
                .filter((c) => c.length === 2 && !Number.isNaN(c[0]) && !Number.isNaN(c[1]))
            : []);

        return [...doc.getElementsByTagName('Placemark')].map((pm) => {
            const nameEl = pm.getElementsByTagName('name')[0];
            const polys = [...pm.getElementsByTagName('Polygon')].map((poly) => {
                const outer = parseRing(poly.getElementsByTagName('outerBoundaryIs')[0]?.getElementsByTagName('coordinates')[0]);
                const holes = [...poly.getElementsByTagName('innerBoundaryIs')]
                    .map((h) => parseRing(h.getElementsByTagName('coordinates')[0]));
                const xs = outer.map((c) => c[0]);
                const ys = outer.map((c) => c[1]);
                const bbox = outer.length
                    ? { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
                    : null;
                return { outer, holes, bbox };
            }).filter((p) => p.bbox);
            return { name: nameEl ? nameEl.textContent.trim() : '', polys };
        }).filter((place) => place.name && place.polys.length);
    }

    // Downloads and parses the boundaries once; a failure is not cached, so the next import retries.
    function loadCityBoundaries() {
        if (!cityLoadPromise) {
            cityLoadPromise = downloadText(CITY_KML_URL)
                .then(parseCityKml)
                .catch((err) => {
                    cityLoadPromise = null;
                    throw err;
                });
        }
        return cityLoadPromise;
    }

    // Name of the city / CDP containing the point, or '' if none (smallest wins if they overlap).
    function placeAt(places, pt) {
        let best = null;
        let bestArea = Infinity;
        for (const place of places) {
            for (const poly of place.polys) {
                const b = poly.bbox;
                if (pt[0] < b.minX || pt[0] > b.maxX || pt[1] < b.minY || pt[1] > b.maxY) continue;
                if (pointInRing(pt, poly.outer) && !poly.holes.some((h) => pointInRing(pt, h))) {
                    const area = (b.maxX - b.minX) * (b.maxY - b.minY);
                    if (area < bestArea) {
                        bestArea = area;
                        best = place.name;
                    }
                }
            }
        }
        return best || '';
    }

    // The postal city an editor already set on a nearby WME segment with the same street name: its alternate
    // city if it has one (the road is outside city limits), otherwise its city. Nearest segment wins.
    const SAME_STREET_POSTAL_RADIUS_M = 1500;

    function postalCityFromSameStreet(name, coords, excludeSegmentId = null) {
        const wanted = normalizeName(name);
        if (!wanted) return null;
        const project = makeProjector(coords[0]);
        const mid = project(pointAlongLine(coords, 0.5));
        let best = null;
        for (const segment of sdk.DataModel.Segments.getAll()) {
            if (!isLiveSegment(segment) || segment.id === excludeSegmentId) continue;
            const d = xyNearest(segment.geometry.coordinates.map(project), mid[0], mid[1]).d;
            if (d > SAME_STREET_POSTAL_RADIUS_M || (best && d >= best.dist)) continue;
            if (normalizeName(streetNameOf(segment.id)) !== wanted) continue;
            let address;
            try {
                address = sdk.DataModel.Segments.getAddress({ segmentId: segment.id });
            } catch (err) {
                continue;
            }
            const cityName = (x) => (x && x.city && !x.city.isEmpty && x.city.name ? x.city.name : '');
            const alternates = (address.altStreets || []).map(cityName).filter(Boolean);
            const cities = alternates.length ? alternates : [cityName(address)].filter(Boolean);
            if (cities.length) best = { cities, segmentId: segment.id, dist: d };
        }
        return best;
    }

    // A road with no ZIP / postal city of its own borrows it from the nearest road around it that has one.
    const NEIGHBOR_POSTAL_RADIUS_DEG = 0.002; // about 200 m

    async function neighborPostal(source, coords, ownFeatureId) {
        const mid = pointAlongLine(coords, 0.5);
        const r = NEIGHBOR_POSTAL_RADIUS_DEG;
        const data = await source.query({ minLon: mid[0] - r, maxLon: mid[0] + r, minLat: mid[1] - r, maxLat: mid[1] + r });
        let best = null;
        for (const feature of data.features || []) {
            if (feature.id === ownFeatureId) continue;
            const parts = linePartsOf(feature);
            if (!parts.length) continue;
            const postal = source.postalCities(feature.properties || {});
            if (!postal.cities.some((c) => formatCityName(c))) continue;
            const dist = Math.min(...parts.map((part) => distanceToLine({ lon: mid[0], lat: mid[1] }, part)));
            if (!best || dist < best.dist) best = { postal, dist, id: feature.id };
        }
        return best;
    }

    // Decides the primary city and alternate cities for a new segment:
    //  inside a city/CDP  -> that place is the primary city; the postal city is an alternate if it differs
    //  outside            -> no primary city; the postal city is the alternate
    async function resolveCities(coords, postal) {
        const result = { primaryCity: '', alternateCities: [], notes: [], warn: false, summary: '' };

        const postalCities = [];
        if (postal.notes.length) {
            result.warn = true;
            result.notes.push(...postal.notes);
        }
        if (postal.fromStreet) {
            result.notes.push(`This road has no ZIP, so its postal city (${postal.cities[0]}) was copied from an existing ${postal.fromStreet.name} segment.`);
        }
        if (postal.fromGoogle) {
            result.notes.push(`The postal city (${formatCityName(postal.cities[0])}) came from the Google Maps address.`);
        }
        if (postal.fromAddresses) {
            result.notes.push(`This road has no postal city of its own, so it was taken from the address points along it (${formatCityName(postal.cities[0])}).`);
        }
        if (postal.fromSetting) {
            result.notes.push(`This road has no ZIP, so its alternate city came from your sidebar setting (${postal.cities[0]}).`);
        }
        if (postal.fromNeighbor !== undefined) {
            result.warn = true;
            result.notes.push(`This road has no ZIP, so its postal city was taken from the nearest road that has one (${postal.fromNeighbor} m away); check it.`);
        }
        for (const raw of postal.cities) {
            const city = formatCityName(raw);
            if (city && !postalCities.some((c) => c.toLowerCase() === city.toLowerCase())) postalCities.push(city);
        }
        if (postalCities.length > 1) {
            result.warn = true;
            result.notes.push(`Left and right postal cities differ (${postalCities.join(' / ')}); each one that differs from the primary city was added as an alternate.`);
        }

        let places;
        try {
            places = await loadCityBoundaries();
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] City boundaries unavailable:`, err);
            result.skipCity = true;
            result.warn = true;
            result.notes.push('City limits could not be loaded, so no city was set.');
            return result;
        }

        // Decide from the middle of the segment; flag it if the quarter points disagree.
        const inside = [0.25, 0.5, 0.75].map((f) => placeAt(places, pointAlongLine(coords, f)));
        const primary = inside[1];
        if (inside.some((name) => name !== primary)) {
            result.warn = true;
            result.notes.push(`Segment crosses a city limit (${[...new Set(inside)].map((n) => n || 'no city').join(' / ')}); check the city.`);
        }

        result.primaryCity = primary;
        result.alternateCities = postalCities.filter((c) => c.toLowerCase() !== primary.toLowerCase());
        if (!postalCities.length) {
            result.warn = true;
            result.notes.push('GIS road has no postal city.');
        }

        const alt = result.alternateCities.length ? `, alternate ${result.alternateCities.join(' / ')}` : '';
        result.summary = `City: ${primary || 'none'}${alt}.`;
        return result;
    }

    // The country and state to write an address with. WME's "top" country/state is empty at times (zoomed out, area still
    // loading), so fall back to the segment's own address, then to any loaded segment's, then to the only one WME knows.
    function regionOf(segmentId) {
        const ok = (x) => !!x && x.id !== undefined && x.id !== null && !x.isEmpty;
        let country = null;
        let state = null;
        try { country = sdk.DataModel.Countries.getTopCountry(); } catch (err) { /* not available */ }
        try { state = sdk.DataModel.States.getTopState(); } catch (err) { /* not available */ }
        if (!ok(country) || !ok(state)) {
            const ids = [segmentId];
            try {
                for (const other of sdk.DataModel.Segments.getAll().slice(0, 300)) ids.push(other.id);
            } catch (err) { /* not available */ }
            for (const id of ids) {
                if (id === undefined || id === null) continue;
                try {
                    const a = sdk.DataModel.Segments.getAddress({ segmentId: id });
                    if (!ok(country) && ok(a.country)) country = a.country;
                    if (!ok(state) && ok(a.state)) state = a.state;
                } catch (err) { /* next */ }
                if (ok(country) && ok(state)) break;
            }
        }
        if (!ok(country)) {
            try { const all = sdk.DataModel.Countries.getAll(); if (all.length === 1) country = all[0]; } catch (err) { /* not available */ }
        }
        if (!ok(state)) {
            try { const all = sdk.DataModel.States.getAll(); if (all.length === 1) state = all[0]; } catch (err) { /* not available */ }
        }
        return { country: ok(country) ? country : null, state: ok(state) ? state : null };
    }
    const REGION_ERROR = 'WME has not told the script which state this is yet; pan or zoom the map a little so the area loads, then try again';

    // Sets the primary street/city and alternate cities on a segment.
    function applyAddress(segmentId, streetName, primaryCity, alternateCities) {
        const { country, state } = regionOf(segmentId);
        if (!country || !state) throw new Error(REGION_ERROR);

        // An alternate is the same street name in another city, so each needs its city and street to exist.
        const alternateStreetIds = alternateCities.map((cityName) => {
            let city = sdk.DataModel.Cities.getCity({ cityName, countryId: country.id, stateId: state.id });
            if (!city) city = sdk.DataModel.Cities.addCity({ cityName, countryId: country.id, stateId: state.id });
            let street = sdk.DataModel.Streets.getStreet({ streetName, cityId: city.id });
            if (!street) street = sdk.DataModel.Streets.addStreet({ streetName, cityId: city.id });
            return street.id;
        });

        sdk.DataModel.Segments.updateAddress({
            segmentId,
            addressData: { streetName, cityName: primaryCity, countryId: country.id, stateId: state.id, alternateStreetIds }
        });
    }

    // ------------------------------------------------------------------
    // Overlap with existing segments
    // ------------------------------------------------------------------
    // Paths, walkways, stairs, ferries, rail and runways are ignored (a sidewalk beside a road isn't the road).
    const OVERLAP_IGNORED_ROAD_TYPES = new Set([5, 9, 10, 15, 16, 18, 19]);
    const OVERLAP_TOLERANCE_M = 8;          // how close an existing segment must run to count as "the same road"
    const OVERLAP_PARALLEL_RAD = 25 * RAD;  // and how closely it must point the same way
    const OVERLAP_STEP_M = 3;               // spacing of the sample points along a line
    const OVERLAP_MIN_M = 10;               // ignore overlaps shorter than this
    const DUPLICATE_FRACTION = 0.6;         // this much of the GIS road already mapped = "already mapped"
    const PARTIAL_OVERLAP_FRACTION = 0.3;   // this much = "partly overlaps", also not imported
    const STUB_FRACTION = 0.6;              // an existing segment this much along the GIS road = a stub of it
    const MIN_EXTENSION_M = 15;             // the GIS road must continue at least this far beyond a stub
    const HOUSE_NUMBER_BEYOND_END_M = 5;     // a house this far past a segment's end might belong to the road that continues
    const NEXT_ROAD_NEAR_M = 60;            // ...if a GIS road of the same street passes within this distance of it
    const HOUSE_NUMBER_END_ZONE_M = 15;      // houses this close to a dead end (or past it) are fanned around the end node
    const HOUSE_NUMBER_EXACT_MAX_M = 200;    // an address point this far from the road can still belong to it (used for points placed exactly)
    const HOUSE_NUMBER_MIN_GAP_M = 5;        // a marker closer than this to another one added in the same click is pushed out
    const GIS_ALONG_TOLERANCE_M = 30;       // a GIS centerline this close and parallel counts as the same road as a mapped segment

    function makeProjector(origin) {
        const mx = 111320 * Math.cos(origin[1] * RAD);
        const my = 110540;
        return (c) => [(c[0] - origin[0]) * mx, (c[1] - origin[1]) * my];
    }

    function xyLengths(line) {
        return line.slice(1).map((p, i) => Math.hypot(p[0] - line[i][0], p[1] - line[i][1]));
    }

    function xyCumulative(line) {
        const cum = [0];
        xyLengths(line).forEach((d) => cum.push(cum[cum.length - 1] + d));
        return cum;
    }

    // Points spaced along a line, each with the direction (radians) the line is heading there.
    function xyResample(line, step) {
        const lens = xyLengths(line);
        const total = lens.reduce((a, b) => a + b, 0);
        const out = [];
        let seg = 0;
        let segStart = 0;
        for (let d = step / 2; d < total; d += step) {
            while (seg < lens.length - 1 && segStart + lens[seg] < d) {
                segStart += lens[seg];
                seg++;
            }
            const [ax, ay] = line[seg];
            const [bx, by] = line[seg + 1];
            const t = Math.min(1, (d - segStart) / (lens[seg] || 1e-9));
            out.push({ x: ax + (bx - ax) * t, y: ay + (by - ay) * t, ang: Math.atan2(by - ay, bx - ax) });
        }
        if (!out.length && line.length > 1) {
            out.push({
                x: (line[0][0] + line[1][0]) / 2,
                y: (line[0][1] + line[1][1]) / 2,
                ang: Math.atan2(line[1][1] - line[0][1], line[1][0] - line[0][0])
            });
        }
        return out;
    }

    // Nearest point on a line (x/y meters) to (x, y): distance, direction there, and distance along the line.
    function xyNearest(line, x, y, cum) {
        let best = { d: Infinity, ang: 0, pos: 0, overshoot: 0 };
        for (let i = 0; i < line.length - 1; i++) {
            const ax = line[i][0];
            const ay = line[i][1];
            const dx = line[i + 1][0] - ax;
            const dy = line[i + 1][1] - ay;
            const len2 = dx * dx + dy * dy;
            const raw = len2 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
            const t = Math.max(0, Math.min(1, raw));
            const d = Math.hypot(ax + t * dx - x, ay + t * dy - y);
            if (d < best.d) {
                const len = Math.sqrt(len2);
                // how far past the very start or end of the line the point lies (0 if it is alongside the line)
                let overshoot = 0;
                if (i === 0 && raw < 0) overshoot = -raw * len;
                if (i === line.length - 2 && raw > 1) overshoot = Math.max(overshoot, (raw - 1) * len);
                best = { d, ang: Math.atan2(dy, dx), pos: cum ? cum[i] + t * len : 0, qx: ax + t * dx, qy: ay + t * dy, overshoot };
            }
        }
        return best;
    }

    // For each sample point: is it within tolerance of the line AND heading roughly the same way?
    function xyAlongFlags(samples, line) {
        return samples.map((s) => {
            const n = xyNearest(line, s.x, s.y);
            let da = Math.abs(s.ang - n.ang) % Math.PI;
            da = Math.min(da, Math.PI - da);
            return n.d <= OVERLAP_TOLERANCE_M && da <= OVERLAP_PARALLEL_RAD;
        });
    }

    // How much of a candidate line ([lon, lat] pairs) already lies along existing WME segments.
    function analyzeOverlap(coords, excludeIds = []) {
        const project = makeProjector(coords[0]);
        const cand = coords.map(project);
        const samples = xyResample(cand, OVERLAP_STEP_M);
        const covered = new Array(samples.length).fill(false);
        const xs = cand.map((c) => c[0]);
        const ys = cand.map((c) => c[1]);
        const box = {
            minX: Math.min(...xs) - OVERLAP_TOLERANCE_M, maxX: Math.max(...xs) + OVERLAP_TOLERANCE_M,
            minY: Math.min(...ys) - OVERLAP_TOLERANCE_M, maxY: Math.max(...ys) + OVERLAP_TOLERANCE_M
        };
        const candLen = xyLengths(cand).reduce((a, b) => a + b, 0);
        const matches = [];

        for (const segment of sdk.DataModel.Segments.getAll()) {
            if (excludeIds.includes(segment.id) || !isLiveSegment(segment) || OVERLAP_IGNORED_ROAD_TYPES.has(segment.roadType)) continue;
            const sxy = segment.geometry.coordinates.map(project);
            const sx = sxy.map((c) => c[0]);
            const sy = sxy.map((c) => c[1]);
            if (Math.max(...sx) < box.minX || Math.min(...sx) > box.maxX || Math.max(...sy) < box.minY || Math.min(...sy) > box.maxY) continue;

            const candFlags = xyAlongFlags(samples, sxy);
            candFlags.forEach((hit, i) => { if (hit) covered[i] = true; });
            const segLen = xyLengths(sxy).reduce((a, b) => a + b, 0);
            const segCovered = xyAlongFlags(xyResample(sxy, OVERLAP_STEP_M), cand).filter(Boolean).length * OVERLAP_STEP_M;
            const candCovered = candFlags.filter(Boolean).length * OVERLAP_STEP_M;
            if (!segCovered && !candCovered) continue;
            matches.push({ segment, segLen, segCovered, segFraction: segLen ? Math.min(1, segCovered / segLen) : 0, candCovered });
        }

        const unionLen = covered.filter(Boolean).length * OVERLAP_STEP_M;
        return { candLen, unionLen, unionFraction: candLen ? unionLen / candLen : 0, matches };
    }

    // If `stub` lies along the GIS road and has a dead end with road left beyond it, work out the extension.
    function planExtension(coords, stub) {
        const project = makeProjector(coords[0]);
        const gxy = coords.map(project);
        const cum = xyCumulative(gxy);
        const total = cum[cum.length - 1];
        const stubCoords = stub.geometry.coordinates;

        const ends = [
            { label: 'A', nodeId: stub.fromNodeId, coord: stubCoords[0] },
            { label: 'B', nodeId: stub.toNodeId, coord: stubCoords[stubCoords.length - 1] }
        ].map((end) => {
            const node = sdk.DataModel.Nodes.getById({ nodeId: end.nodeId });
            const p = project(end.coord);
            return { ...end, node, degree: node ? node.connectedSegmentIds.length : 0, pos: xyNearest(gxy, p[0], p[1], cum).pos };
        });

        const lo = Math.min(ends[0].pos, ends[1].pos);
        const hi = Math.max(ends[0].pos, ends[1].pos);
        ends.forEach((end) => {
            end.forward = end.pos >= hi - 0.01 && end.pos !== lo;
            end.remainder = end.forward ? total - end.pos : end.pos;
        });

        const end = ends
            .filter((e) => e.node && e.degree === 1 && e.remainder >= MIN_EXTENSION_M)
            .sort((a, b) => b.remainder - a.remainder)[0];
        if (!end) return null;

        const idx = [];
        if (end.forward) {
            for (let i = 0; i < coords.length; i++) if (cum[i] > end.pos + 2) idx.push(i);
        } else {
            for (let i = coords.length - 1; i >= 0; i--) if (cum[i] < end.pos - 2) idx.push(i);
        }
        const extra = idx.map((i) => [...coords[i]]);
        if (!extra.length) return null;

        const own = stubCoords.map((c) => [...c]);
        return {
            end,
            extra,
            outward: [[...end.node.geometry.coordinates], ...extra], // runs from the stub's dead end out to the far end
            newCoords: end.label === 'B' ? [...own, ...extra] : [...extra].reverse().concat(own),
            farCoord: extra[extra.length - 1]
        };
    }

    const normalizeName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    function streetNameOf(segmentId) {
        try {
            const a = sdk.DataModel.Segments.getAddress({ segmentId });
            return a.street && a.street.name ? a.street.name : '';
        } catch (err) {
            return '';
        }
    }

    // Copies what a merge insists on matching (speeds, direction, lock, ...) and the street/city from the stub.
    function copyStubAttributes(stub, pieceId) {
        const piece = sdk.DataModel.Segments.getById({ segmentId: pieceId });
        const update = { segmentId: pieceId, fwdSpeedLimit: stub.fwdSpeedLimit ?? null, revSpeedLimit: stub.revSpeedLimit ?? null };
        const direction = stub.isTwoWay ? 'TWO_WAY' : stub.isAtoB ? 'A_TO_B' : 'B_TO_A';
        if (piece && ((direction === 'TWO_WAY' && !piece.isTwoWay) || (direction === 'A_TO_B' && !piece.isAtoB) || (direction === 'B_TO_A' && !piece.isBtoA))) {
            update.direction = direction;
        }
        if (stub.lockRank !== undefined && stub.lockRank !== null) update.lockRank = stub.lockRank;
        if (stub.elevationLevel !== undefined && stub.elevationLevel !== piece.elevationLevel) update.elevationLevel = stub.elevationLevel;
        try {
            sdk.DataModel.Segments.updateSegment(update);
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Copying all stub attributes failed, trying speeds only:`, err);
            sdk.DataModel.Segments.updateSegment({ segmentId: pieceId, fwdSpeedLimit: update.fwdSpeedLimit, revSpeedLimit: update.revSpeedLimit });
        }

        const a = sdk.DataModel.Segments.getAddress({ segmentId: stub.id });
        if (a.street && a.street.name) {
            const { country, state } = regionOf(stub.id);
            sdk.DataModel.Segments.updateAddress({
                segmentId: pieceId,
                addressData: {
                    streetName: a.street.name,
                    cityName: a.city && !a.city.isEmpty ? a.city.name : '',
                    countryId: country.id,
                    stateId: state.id,
                    alternateStreetIds: (a.altStreets || []).map((x) => x.street.id)
                }
            });
        }
    }

    // Extends an existing stub to reach the end of the GIS road. If the far end is free, its own geometry is
    // extended (same segment id, name, speeds, ...). If the far end meets another road, the missing part is
    // created joined to both, given the stub's attributes, and merged into the stub.
    async function extendStub(ctx, stub, stubName, plan) {
        const messages = [];
        let level = 'ok';
        let finalId = stub.id;
        const metersBeyond = Math.round(plan.end.remainder);

        const farNode = findNearestNode(plan.farCoord[0], plan.farCoord[1]);
        const farEdge = farNode ? null : findNearestSegment(plan.farCoord[0], plan.farCoord[1]);
        const needsJoin = !!farNode || !!(farEdge && farEdge.segment.id !== stub.id);

        if (!needsJoin) {
            sdk.DataModel.Segments.updateSegment({
                segmentId: stub.id,
                geometry: { type: 'LineString', coordinates: plan.newCoords }
            });
            messages.push(`Extended the existing road by ${metersBeyond} m instead of creating a new one.`);
        } else {
            const otherEndNodeId = plan.end.label === 'B' ? stub.fromNodeId : stub.toNodeId;
            const otherNode = sdk.DataModel.Nodes.getById({ nodeId: otherEndNodeId });
            const before = new Set(otherNode ? otherNode.connectedSegmentIds : []);

            // the missing part, running the same way as the stub
            const pieceCoords = plan.end.label === 'B'
                ? plan.outward.map((c) => [...c])
                : [...plan.outward].reverse().map((c) => [...c]);
            const { snaps, snappedFeatures } = snapEndpoints(pieceCoords);
            const { segmentId: pieceId, patched } = addSegmentWithSnaps(pieceCoords, snappedFeatures, stub.roadType);
            finalId = pieceId;
            if (!patched) {
                level = 'warn';
                messages.push('Created the missing part but could not join it; delete it or join it by hand.');
            } else {
                try {
                    copyStubAttributes(stub, pieceId);
                } catch (err) {
                    console.warn(`[${SCRIPT_NAME}] copyStubAttributes failed:`, err);
                }
                try {
                    sdk.DataModel.Segments.mergeSegments({ segmentIds: [stub.id, pieceId] });
                    await sleep(300);
                    const node = sdk.DataModel.Nodes.getById({ nodeId: otherEndNodeId });
                    const fresh = node ? node.connectedSegmentIds.filter((id) => !before.has(id)) : [];
                    if (fresh.length === 1) finalId = fresh[0];
                    messages.push(`Extended the existing road by ${metersBeyond} m and merged it with the new part.`);
                } catch (err) {
                    level = 'warn';
                    messages.push(`Merge refused (${err.message || err}); left as two segments joined at a node.`);
                }

                // far end: confirm the join and the turns
                const farSnap = plan.end.label === 'B' ? snaps.to : snaps.from;
                const finalSeg = sdk.DataModel.Segments.getById({ segmentId: finalId });
                if (farSnap && finalSeg) {
                    const farNodeId = plan.end.label === 'B' ? finalSeg.toNodeId : finalSeg.fromNodeId;
                    const node = sdk.DataModel.Nodes.getById({ nodeId: farNodeId });
                    const connected = node ? node.connectedSegmentIds.length : 0;
                    const joined = farSnap.kind === 'node' ? farNodeId === farSnap.targetId : connected >= 3;
                    if (joined) {
                        const turns = await verifyTurns(farNodeId, finalId);
                        messages.push(turns.error || turns.blocked
                            ? 'Far end joined, but check its turns.'
                            : `Far end joined (${turns.allowed} turn(s) open).`);
                        if (turns.error || turns.blocked) level = 'warn';
                    } else {
                        level = 'warn';
                        messages.push('Far end did NOT join the road it meets; join it by hand.');
                    }
                }
            }
        }

        if (!stubName) {
            level = 'warn';
            messages.push('The existing segment has no street name; name not set.');
        }
        if (ctx.isOneWay) {
            level = 'warn';
            messages.push(`GIS says one-way (${ctx.oneWayCode}); the existing segment's direction was left as is.`);
        }

        if (houseNumbersEnabled && ctx.source && ctx.source.houseNumbers && stubName) {
            try {
                const result = await addHouseNumbers(ctx.source, finalId, stubName);
                if (result.message) messages.push(result.message);
                if (result.warn) level = 'warn';
            } catch (err) {
                level = 'warn';
                messages.push(`HNs failed: ${err.message || err}.`);
                console.warn(`[${SCRIPT_NAME}] addHouseNumbers failed:`, err);
            }
        }

        setStatus(`${stubName || 'Road'}: ${messages.join(' ')}`, level);
        console.log(`[${SCRIPT_NAME}] ${stubName || 'Road'} (segment ${finalId}): ${messages.join(' ')}`);
        try {
            sdk.Editing.setSelection({ selection: { objectType: 'segment', ids: [finalId] } });
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Could not select segment:`, err);
        }
    }

    // Returns true if the click was dealt with here (stub extended, or import refused); false to import normally.
    async function handleOverlap(ctx) {
        const { coords, name } = ctx;
        const hnHint = ctx.source && ctx.source.houseNumbers ? ' To add its house numbers instead, turn on the HNs button and click the road again.' : '';
        const analysis = analyzeOverlap(coords);
        if (analysis.unionLen < OVERLAP_MIN_M) return false;
        const percent = Math.round(analysis.unionFraction * 100);

        // 1. a stub the GIS road continues from -> extend it
        const stubMatch = analysis.matches
            .filter((m) => m.segFraction >= STUB_FRACTION && m.segCovered >= OVERLAP_MIN_M)
            .sort((a, b) => b.segCovered - a.segCovered)[0];
        const plan = stubMatch ? planExtension(coords, stubMatch.segment) : null;

        if (plan) {
            const stub = stubMatch.segment;
            const stubName = streetNameOf(stub.id);
            if (stubName && name && normalizeName(stubName) !== normalizeName(name)) {
                setStatus(`${name || 'This road'}: not imported, because the existing segment is named "${stubName}" but the GIS road is "${name}". Shift-click to import anyway.`, 'warn');
                return true;
            }
            // the part beyond the stub must be clear of other existing segments
            const beyond = analyzeOverlap(plan.outward, [stub.id]);
            if (beyond.unionFraction >= PARTIAL_OVERLAP_FRACTION && beyond.unionLen >= OVERLAP_MIN_M) {
                setStatus(`${name || 'This road'}: not imported, because the road beyond the existing segment also overlaps other existing segments. Shift-click to import anyway.`, 'warn');
                return true;
            }
            await extendStub(ctx, stub, stubName, plan);
            importedFeatureIds.add(ctx.featureKey);
            return true;
        }

        // 1b. a stub lies along the road but can't be extended (no dead end, or nothing beyond it):
        //     importing the full road would put a second segment on top of it
        if (stubMatch) {
            const stub = stubMatch.segment;
            const stubLabel = streetNameOf(stub.id);
            setStatus(analysis.unionFraction >= DUPLICATE_FRACTION
                ? `${name || 'This road'}: already mapped (${percent}% of it lies along ${stubLabel || 'an unnamed segment'}). Not imported; Shift-click to import anyway.${hnHint}`
                : `${name || 'This road'}: not imported, because an existing segment${stubLabel ? ` ("${stubLabel}")` : ''} already lies along it and has no free end to extend. Shift-click to import anyway.${hnHint}`, 'warn');
            return true;
        }

        // 2. otherwise a substantial overlap means it is (mostly) already mapped
        if (analysis.unionFraction >= PARTIAL_OVERLAP_FRACTION) {
            const top = analysis.matches.slice().sort((a, b) => b.candCovered - a.candCovered)[0];
            const what = analysis.unionFraction >= DUPLICATE_FRACTION ? 'already mapped' : 'partly overlaps existing segments';
            setStatus(`${name || 'This road'}: ${what} (${percent}% of it lies along ${streetNameOf(top.segment.id) || 'an unnamed segment'}). Not imported; Shift-click to import anyway.${hnHint}`, 'warn');
            return true;
        }
        return false;
    }

    // ------------------------------------------------------------------
    // Run-ins: a new road whose start (or end) runs along an existing road
    // ------------------------------------------------------------------
    const RUN_IN_MIN_M = 15;   // a start/end that runs along an existing road at least this far is trimmed
    const RUN_IN_JOIN_M = 15;  // the trimmed end joins an existing node or road this close

    // A deleted segment lingers in the data model with no nodes; it is not a real road any more.
    function isLiveSegment(segment) {
        return segment.fromNodeId !== null && segment.fromNodeId !== undefined &&
            segment.toNodeId !== null && segment.toNodeId !== undefined;
    }

    function xyPointAt(line, cum, d) {
        for (let i = 0; i < line.length - 1; i++) {
            if (d <= cum[i + 1] || i === line.length - 2) {
                const len = cum[i + 1] - cum[i];
                const t = len ? Math.min(1, Math.max(0, (d - cum[i]) / len)) : 0;
                return {
                    x: line[i][0] + (line[i + 1][0] - line[i][0]) * t,
                    y: line[i][1] + (line[i + 1][1] - line[i][1]) * t,
                    ang: Math.atan2(line[i + 1][1] - line[i][1], line[i + 1][0] - line[i][0]),
                    seg: i,
                    t
                };
            }
        }
        return null;
    }

    // How far (meters) the start of `coords` keeps running along existing segments. 0 if it doesn't.
    function runInLength(coords) {
        const project = makeProjector(coords[0]);
        const line = coords.map(project);
        const cum = xyCumulative(line);
        const reach = Math.min(cum[cum.length - 1], 150);
        const limit = OVERLAP_TOLERANCE_M;
        // bounding box of the stretch being checked, so far-away segments are skipped quickly
        const probe = [];
        for (let d = 0; d <= reach; d += 10) probe.push(xyPointAt(line, cum, d));
        const box = {
            minX: Math.min(...probe.map((q) => q.x)) - limit - 10, maxX: Math.max(...probe.map((q) => q.x)) + limit + 10,
            minY: Math.min(...probe.map((q) => q.y)) - limit - 10, maxY: Math.max(...probe.map((q) => q.y)) + limit + 10
        };
        const nearby = [];
        for (const segment of sdk.DataModel.Segments.getAll()) {
            if (!isLiveSegment(segment) || OVERLAP_IGNORED_ROAD_TYPES.has(segment.roadType)) continue;
            const sxy = segment.geometry.coordinates.map(project);
            const sx = sxy.map((c) => c[0]);
            const sy = sxy.map((c) => c[1]);
            if (Math.max(...sx) < box.minX || Math.min(...sx) > box.maxX || Math.max(...sy) < box.minY || Math.min(...sy) > box.maxY) continue;
            nearby.push(sxy);
        }

        let run = 0;
        for (let d = 0; d <= reach; d += 2) {
            const p = xyPointAt(line, cum, d);
            const along = nearby.some((sxy) => {
                const n = xyNearest(sxy, p.x, p.y);
                let da = Math.abs(p.ang - n.ang) % Math.PI;
                da = Math.min(da, Math.PI - da);
                return n.d <= limit && da <= OVERLAP_PARALLEL_RAD;
            });
            if (!along) break;
            run = d;
        }
        return run;
    }

    // Cuts off any stretch at either end that just runs along an existing road, so the new road starts where
    // it actually leaves that road. Returns the new coordinates and how many meters were cut from each end.
    function trimRunIns(coords) {
        const trimmed = {};
        let line = coords.map((c) => [...c]);
        for (const key of ['from', 'to']) {
            const oriented = key === 'from' ? line : [...line].reverse();
            const run = runInLength(oriented);
            const xy = oriented.map(makeProjector(oriented[0]));
            const cum = xyCumulative(xy);
            const total = cum[cum.length - 1];
            if (run < RUN_IN_MIN_M || run > total - RUN_IN_MIN_M) continue;

            const p = xyPointAt(xy, cum, run);
            const a = oriented[p.seg];
            const b = oriented[p.seg + 1];
            const cut = [[a[0] + (b[0] - a[0]) * p.t, a[1] + (b[1] - a[1]) * p.t], ...oriented.filter((c, i) => cum[i] > run + 0.5)];
            if (cut.length < 2) continue;
            line = key === 'from' ? cut : cut.reverse();
            trimmed[key] = Math.round(run);
        }
        return { coords: line, trimmed };
    }

    // ------------------------------------------------------------------
    // House numbers from address points
    // ------------------------------------------------------------------
    // The county's address points sit at the road; each number is placed houseNumberSetbackM out from the road
    // on the same side (WME puts the stop point on the road opposite it), the way they are normally placed by hand.
    function queryLayerBox(queryUrl, box, outFields) {
        const params = new URLSearchParams({
            geometry: `${box.minLon},${box.minLat},${box.maxLon},${box.maxLat}`,
            geometryType: 'esriGeometryEnvelope',
            inSR: '4326',
            spatialRel: 'esriSpatialRelIntersects',
            outFields,
            outSR: '4326',
            returnGeometry: 'true',
            resultRecordCount: '2000',
            f: 'geojson'
        });
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `${queryUrl}?${params}`,
                timeout: 30000,
                onload: (response) => {
                    try {
                        resolve(JSON.parse(response.responseText));
                    } catch (err) {
                        reject(err);
                    }
                },
                onerror: () => reject(new Error('address point request failed')),
                ontimeout: () => reject(new Error('address point request timed out'))
            });
        });
    }

    // House numbers already on these segments: saved ones through the SDK, unsaved ones from WME's own store
    // (the SDK does not list numbers that have not been saved yet).
    async function existingHouseNumbers(segmentIds) {
        const have = new Set();
        try {
            const saved = await sdk.DataModel.HouseNumbers.fetchHouseNumbers({ segmentIds });
            saved.forEach((h) => have.add(String(h.number).toLowerCase()));
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Could not read saved house numbers:`, err);
        }
        try {
            const store = pageWin.W && pageWin.W.model && pageWin.W.model.segmentHouseNumbers;
            const all = store && typeof store.getObjectArray === 'function' ? store.getObjectArray() : [];
            all.forEach((h) => {
                if (h.attributes && segmentIds.includes(h.attributes.segID) && !(h.getState && h.getState() === 'DELETE')) {
                    have.add(String(h.attributes.number).toLowerCase());
                }
            });
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Could not read unsaved house numbers:`, err);
        }
        return have;
    }

    // Adds the address-point house numbers that belong to this new segment. Returns a message for the panel.
    // WME accepted house numbers on an unsaved segment (negative id) in a console test. Set to false to make them wait for a save.
    const HOUSE_NUMBERS_ON_UNSAVED_SEGMENTS = true;

    async function addHouseNumbers(source, segmentId, name) {
        if (segmentId < 0 && !HOUSE_NUMBERS_ON_UNSAVED_SEGMENTS) {
            return { message: 'HNs: this segment is not saved yet. Save, then click the road again to add them.', warn: false, level: 'info' };
        }
        const cfg = source.houseNumbers;
        const segment = sdk.DataModel.Segments.getById({ segmentId });
        if (!cfg || !segment) return { message: '', warn: false };

        const coords = segment.geometry.coordinates;
        const lons = coords.map((c) => c[0]);
        const lats = coords.map((c) => c[1]);
        const pad = 0.003;
        const box = { minLon: Math.min(...lons) - pad, maxLon: Math.max(...lons) + pad, minLat: Math.min(...lats) - pad, maxLat: Math.max(...lats) + pad };
        const data = await cfg.query(box);
        if (data.error) throw new Error(data.error.message || 'address point query error');

        const origin = coords[0];
        const project = makeProjector(origin);
        const mx = 111320 * Math.cos(origin[1] * RAD);
        const my = 110540;
        const wanted = normalizeName(name);

        // every segment of this street near the new one; each address point goes to the nearest of them
        const street = [{ id: segmentId, xy: coords.map(project) }];
        for (const other of sdk.DataModel.Segments.getAll()) {
            if (other.id === segmentId || !isLiveSegment(other)) continue;
            const c = other.geometry.coordinates;
            if (c.every((p) => p[0] < box.minLon || p[0] > box.maxLon || p[1] < box.minLat || p[1] > box.maxLat)) continue;
            if (normalizeName(streetNameOf(other.id)) !== wanted) continue;
            street.push({ id: other.id, xy: c.map(project) });
        }
        const have = await existingHouseNumbers(street.map((s) => s.id));

        // The GIS centerlines of this street near the segment. The address points were keyed to these, so they
        // decide which side of the road a house is on even when the mapped road is offset from them.
        //  along  = the GIS lines the mapped segment follows (within GIS_ALONG_TOLERANCE_M and parallel)
        //  others = the rest: roads of this street that are not in WME yet
        let gisRoads;
        const loadGisRoads = async () => {
            if (gisRoads !== undefined) return gisRoads;
            try {
                const roadData = await (source.queryAll || source.query).call(source, box);
                const found = [];
                const every = [];
                for (const feature of roadData.features || []) {
                    const parts = linePartsOf(feature).map((part) => part.map(project));
                    if (!parts.length) continue;
                    const road = { id: feature.id, parts, name: buildStreetName(source.nameParts(feature.properties || {})).name, layer: (feature.properties && feature.properties.__layer && feature.properties.__layer.id) || '' };
                    every.push(road);
                    if (normalizeName(road.name) === wanted) found.push(road);
                }
                const samples = xyResample(street[0].xy, 5);
                // how much of the mapped segment a GIS road runs along (within tolerance and parallel)
                const alongFraction = (road) => {
                    let hits = 0;
                    for (const sm of samples) {
                        let near = null;
                        for (const part of road.parts) {
                            const c = xyNearest(part, sm.x, sm.y);
                            if (!near || c.d < near.d) near = c;
                        }
                        let da = Math.abs(sm.ang - near.ang) % Math.PI;
                        da = Math.min(da, Math.PI - da);
                        // the nearest spot must lie ALONG the GIS line, not past its start or end: the next block of the same
                        // street starts where this one ends, and the last 30 m of this segment are within reach of it
                        if (near.d <= GIS_ALONG_TOLERANCE_M && da <= OVERLAP_PARALLEL_RAD && near.overshoot <= 3) hits++;
                    }
                    return samples.length ? hits / samples.length : 0;
                };
                const along = [];
                const others = [];
                for (const road of found) (alongFraction(road) >= 0.3 ? along : others).push(road);
                // every GIS road that is not this segment's own centerline (any name): one touching a dead end continues from it
                const continuing = every.filter((road) => alongFraction(road) < 0.3);
                gisRoads = { along, others, continuing };
            } catch (err) {
                console.warn(`[${SCRIPT_NAME}] Could not load the GIS roads of this street:`, err);
                gisRoads = null;
            }
            return gisRoads;
        };
        const roadsInfo = await loadGisRoads();

        // Connected segments that are not named like this street yet but that the GIS road of this street runs along (the next
        // block, mapped but not renamed). Houses nearer to one of those belong to it once it is renamed, so they are not put on
        // this segment. A name that differs is flagged in the result so it can be fixed.
        const sameStreetRoads = roadsInfo ? [...roadsInfo.along, ...roadsInfo.others] : [];
        const neighbours = [];
        if (sameStreetRoads.length) {
            const myNodes = new Set([segment.fromNodeId, segment.toNodeId]);
            for (const other of sdk.DataModel.Segments.getAll()) {
                if (other.id === segmentId || !isLiveSegment(other) || OVERLAP_IGNORED_ROAD_TYPES.has(other.roadType)) continue;
                if (!myNodes.has(other.fromNodeId) && !myNodes.has(other.toNodeId)) continue;
                const otherName = streetNameOf(other.id) || '';
                if (normalizeName(otherName) === wanted) continue; // already part of `street`
                const xy = other.geometry.coordinates.map(project);
                const samples = xyResample(xy, 5);
                let hits = 0;
                for (const sm of samples) {
                    let near = null;
                    for (const road of sameStreetRoads) {
                        for (const part of road.parts) {
                            const c = xyNearest(part, sm.x, sm.y);
                            if (!near || c.d < near.d) near = c;
                        }
                    }
                    let da = near ? Math.abs(sm.ang - near.ang) % Math.PI : Math.PI;
                    da = Math.min(da, Math.PI - da);
                    if (near && near.d <= GIS_ALONG_TOLERANCE_M && da <= OVERLAP_PARALLEL_RAD) hits++;
                }
                if (samples.length && hits / samples.length >= 0.5) neighbours.push({ id: other.id, xy, name: otherName });
            }
        }

        // Dead ends of this segment. Houses around a cul-de-sac all sit next to the end of the road (the county's centerline
        // often stops short of it), so placing them straight out from the road stacks them on one spot. They are fanned
        // around the end node instead, each pointing toward its own address point, which keeps them in order around the bulb.
        const segXY = street[0].xy;
        const segCum = xyCumulative(segXY);
        const segLen = segCum[segCum.length - 1];
        const isDeadEnd = (nodeId) => {
            const node = sdk.DataModel.Nodes.getById({ nodeId });
            return !!node && node.connectedSegmentIds.length === 1;
        };
        const deadEnds = [];
        if (isDeadEnd(segment.fromNodeId)) deadEnds.push({ pos: 0, p: segXY[0] });
        if (isDeadEnd(segment.toNodeId)) deadEnds.push({ pos: segLen, p: segXY[segXY.length - 1] });

        // Does the GIS road this segment follows carry on past one of its ends? Then the road is not finished there: a
        // dead end is not a cul-de-sac, and houses beyond the end belong to the next segment, which is not in WME yet.
        const alongContinues = { start: false, end: false };
        if (roadsInfo) {
            const lastXY = segXY[segXY.length - 1];
            for (const road of roadsInfo.along) {
                for (const part of road.parts) {
                    const cumPart = xyCumulative(part);
                    const total = cumPart[cumPart.length - 1];
                    const a0 = xyNearest(part, segXY[0][0], segXY[0][1], cumPart);
                    const a1 = xyNearest(part, lastXY[0], lastXY[1], cumPart);
                    if (a0.d > GIS_ALONG_TOLERANCE_M || a1.d > GIS_ALONG_TOLERANCE_M || Math.abs(a1.pos - a0.pos) < 5) continue;
                    const forward = a1.pos > a0.pos; // the segment's last point lies further along the GIS line than its first
                    if ((forward ? total - a1.pos : a1.pos) >= MIN_EXTENSION_M) alongContinues.end = true;
                    if ((forward ? a0.pos : total - a0.pos) >= MIN_EXTENSION_M) alongContinues.start = true;
                }
            }
        }

        // A dead end that another road continues from is not a cul-de-sac: a GIS road (any name) that touches it, or a
        // WME segment that sits at it without being joined yet. Only real dead ends are fanned. Alt on the click skips the fan.
        const CONTINUES_NEAR_M = 15;
        const realDeadEnds = [];
        const continuingEnds = [];
        for (const end of deadEnds) {
            let found = null;
            if (roadsInfo) {
                for (const road of roadsInfo.continuing) {
                    const d = Math.min(...road.parts.map((part) => xyNearest(part, end.p[0], end.p[1]).d));
                    if (d <= CONTINUES_NEAR_M && (!found || d < found.d)) found = { d, what: `the GIS road${road.name ? ` ${road.name}` : ''}` };
                }
            }
            if (!found && alongContinues[end.pos === 0 ? 'start' : 'end']) found = { d: 0, what: 'the same GIS road' };
            if (!found) {
                for (const other of sdk.DataModel.Segments.getAll()) {
                    if (other.id === segmentId || !isLiveSegment(other) || OVERLAP_IGNORED_ROAD_TYPES.has(other.roadType)) continue;
                    const d = xyNearest(other.geometry.coordinates.map(project), end.p[0], end.p[1]).d;
                    if (d <= 10 && (!found || d < found.d)) found = { d, what: 'a WME segment' };
                }
            }
            if (found) continuingEnds.push({ ...end, found });
            else if (!altHeld) realDeadEnds.push(end);
        }
        // Another mapped segment (any name, joined or not) at an end of this one: whatever lies past that end belongs to it or
        // to the road beyond, which is probably about to get this street's name. Houses past such an end are left off.
        const TOUCHING_END_M = 15;
        const touching = { start: null, end: null };
        const endPoints = { start: segXY[0], end: segXY[segXY.length - 1] };
        for (const side of ['start', 'end']) {
            const nodeId = side === 'start' ? segment.fromNodeId : segment.toNodeId;
            for (const other of sdk.DataModel.Segments.getAll()) {
                if (other.id === segmentId || !isLiveSegment(other) || OVERLAP_IGNORED_ROAD_TYPES.has(other.roadType)) continue;
                if (street.some((st) => st.id === other.id)) continue; // same street: houses go to the nearest of them anyway
                const joined = other.fromNodeId === nodeId || other.toNodeId === nodeId;
                const near = !joined && xyNearest(other.geometry.coordinates.map(project), endPoints[side][0], endPoints[side][1]).d <= TOUCHING_END_M;
                if (joined || near) {
                    const otherName = streetNameOf(other.id) || '';
                    touching[side] = touching[side] || [];
                    if (!touching[side].includes(otherName)) touching[side].push(otherName);
                }
            }
        }
        const nearContinuing = [];
        const continuingWhat = new Set();
        const placed = [];

        const added = [];
        const skipped = [];
        const flat = [];
        const beyond = [];
        const forNeighbour = [];
        const pastMapped = [];
        const touchingNames = new Set();
        const neighbourNamed = new Set();
        const sideFixed = [];
        const fanned = [];
        const exactAt = [];
        const exactFromM = houseNumberExactFt * 0.3048;
        const decisions = [];
        const otherNames = new Set();
        for (const feature of data.features || []) {
            const attrs = feature.properties || {};
            const number = cfg.number(attrs);
            if (!number || !feature.geometry || !feature.geometry.coordinates) continue;

            const [x, y] = project(feature.geometry.coordinates);
            const pointName = buildStreetName(cfg.nameParts(attrs)).name;
            if (normalizeName(pointName) !== wanted) {
                if (xyNearest(street[0].xy, x, y).d <= 40) otherNames.add(pointName);
                continue;
            }
            let best = null;
            for (const s of street) {
                const n = xyNearest(s.xy, x, y);
                if (!best || n.d < best.d) best = { ...n, id: s.id };
            }
            if (!best || best.id !== segmentId) continue;
            const isExact = best.d >= exactFromM; // far enough from the road to be the house itself
            if (best.d > (isExact ? HOUSE_NUMBER_EXACT_MAX_M : 80)) continue;
            // nearer to a connected segment that is this street but not renamed yet: it gets this number once renamed
            let owner = null;
            for (const nb of neighbours) {
                const d = xyNearest(nb.xy, x, y).d;
                if (d < best.d - 1 && (!owner || d < owner.d)) owner = { d, nb };
            }
            if (owner) {
                forNeighbour.push(number);
                neighbourNamed.add(owner.nb.name);
                continue;
            }
            if (best.overshoot > HOUSE_NUMBER_BEYOND_END_M) {
                // Past this segment's end. The house belongs to whichever GIS road of this street it is nearer to: if that is
                // not the road this segment follows (the next block, not in WME yet), it waits. If the road this segment follows
                // carries on past this end, it waits too. If neither, the road really ends here and the house stays.
                let reason = '';
                let dAlong = Infinity;
                let dOther = Infinity;
                let otherRoad = null;
                if (roadsInfo === null) {
                    reason = 'the GIS roads could not be read'; // wait rather than risk the wrong side
                } else {
                    for (const r of roadsInfo.along) for (const part of r.parts) dAlong = Math.min(dAlong, xyNearest(part, x, y).d);
                    for (const r of roadsInfo.others) {
                        const d = Math.min(...r.parts.map((part) => xyNearest(part, x, y).d));
                        if (d < dOther) {
                            dOther = d;
                            otherRoad = r;
                        }
                    }
                    if (otherRoad && dOther <= NEXT_ROAD_NEAR_M && dOther <= dAlong + 5) reason = `nearer to another GIS road of this street (${otherRoad.layer || 'same layer'})`;
                    else if (alongContinues[xyNearest(segXY, x, y, segCum).pos < segLen / 2 ? 'start' : 'end']) reason = 'the GIS road continues past this end';
                }
                const pastSide = xyNearest(segXY, x, y, segCum).pos < segLen / 2 ? 'start' : 'end';
                if (!reason && !altHeld && touching[pastSide]) {
                    reason = `another mapped segment (${touching[pastSide].map((n) => n || 'no name').join(' / ')}) connects at this end`;
                    pastMapped.push(number);
                    touching[pastSide].forEach((n) => touchingNames.add(n || 'no name'));
                }
                decisions.push({
                    number, metersPastEnd: Math.round(best.overshoot), toThisRoad: Number.isFinite(dAlong) ? Math.round(dAlong) : null,
                    toOtherRoad: Number.isFinite(dOther) ? Math.round(dOther) : null, decision: reason ? `left for the next segment: ${reason}` : 'kept: no GIS road continues here'
                });
                if (reason) {
                    if (!pastMapped.includes(number)) beyond.push(number);
                    continue;
                }
            }
            if (have.has(number.toLowerCase())) {
                skipped.push(number);
                continue;
            }

            // Which side of the road is the house on? Ask the GIS centerline, not the mapped road.
            let gisRef = null;
            if (roadsInfo) {
                for (const road of roadsInfo.along) {
                    for (const part of road.parts) {
                        const n = xyNearest(part, x, y);
                        if (!gisRef || n.d < gisRef.d) gisRef = n;
                    }
                }
                if (gisRef && gisRef.d > 80) gisRef = null;
            }

            let tx;
            let ty;
            const onSeg = xyNearest(segXY, x, y, segCum);
            const endHit = isExact ? null : realDeadEnds.find((end) => Math.abs(onSeg.pos - end.pos) < HOUSE_NUMBER_END_ZONE_M);
            const contHit = isExact || endHit ? null : continuingEnds.find((end) => Math.abs(onSeg.pos - end.pos) < HOUSE_NUMBER_END_ZONE_M);
            if (contHit) {
                nearContinuing.push(number);
                continuingWhat.add(contHit.found.what);
            }
            if (isExact) {
                tx = x; // the address point is the house: no offset, no side to work out, no fan
                ty = y;
                exactAt.push(number);
            } else if (endHit) {
                const dx = x - endHit.p[0];
                const dy = y - endHit.p[1];
                const r = Math.hypot(dx, dy);
                if (r < 0.5) {
                    flat.push(number); // right on the end node: no direction to fan it in
                    continue;
                }
                tx = endHit.p[0] + (dx / r) * houseNumberSetbackM;
                ty = endHit.p[1] + (dy / r) * houseNumberSetbackM;
                fanned.push(number);
            } else if (gisRef) {
                if (gisRef.d < 0.5) {
                    flat.push(number); // right on the centerline: no way to tell which side
                    continue;
                }
                const cross = Math.cos(gisRef.ang) * (y - gisRef.qy) - Math.sin(gisRef.ang) * (x - gisRef.qx); // > 0: left of the GIS line
                const foot = xyNearest(street[0].xy, gisRef.qx, gisRef.qy);                                   // the mapped road beside that spot
                const sameWay = Math.cos(gisRef.ang - foot.ang) >= 0;                                        // GIS line drawn the same way as the mapped road?
                const sideSign = (cross >= 0 ? 1 : -1) * (sameWay ? 1 : -1);                                  // +1 = left of the mapped road
                tx = foot.qx + sideSign * -Math.sin(foot.ang) * houseNumberSetbackM;
                ty = foot.qy + sideSign * Math.cos(foot.ang) * houseNumberSetbackM;
                const mappedSide = ((x - best.qx) * -Math.sin(best.ang) + (y - best.qy) * Math.cos(best.ang)) >= 0 ? 1 : -1;
                if (mappedSide !== sideSign) sideFixed.push(number);
            } else {
                // no GIS centerline to go by: use the mapped road
                if (best.d < 0.5) {
                    flat.push(number);
                    continue;
                }
                tx = best.qx + ((x - best.qx) / best.d) * houseNumberSetbackM;
                ty = best.qy + ((y - best.qy) / best.d) * houseNumberSetbackM;
            }
            // keep markers added in this click from landing on top of each other: push a crowded one further out
            for (let tries = 0; tries < 4 && placed.some(([px, py]) => Math.hypot(px - tx, py - ty) < HOUSE_NUMBER_MIN_GAP_M); tries++) {
                const ref = endHit ? endHit.p : [onSeg.qx, onSeg.qy];
                const r = Math.hypot(tx - ref[0], ty - ref[1]) || 1;
                tx += ((tx - ref[0]) / r) * 8;
                ty += ((ty - ref[1]) / r) * 8;
            }
            placed.push([tx, ty]);
            const target = [origin[0] + tx / mx, origin[1] + ty / my];
            sdk.DataModel.HouseNumbers.addHouseNumber({ number, point: { type: 'Point', coordinates: target }, segmentId });
            have.add(number.toLowerCase());
            added.push(number);
        }

        const order = (list) => list.slice().sort((a, b) => parseInt(a, 10) - parseInt(b, 10)).join(', ');
        const hn = (n) => `${n} HN${n === 1 ? '' : 's'}`;
        const parts = [];
        const how = exactAt.length === added.length ? 'at their address points'
            : exactAt.length ? `${exactAt.length} at their address points, ${added.length - exactAt.length} ${houseNumberSetbackM} m out` : `${houseNumberSetbackM} m out`;
        parts.push(added.length ? `${hn(added.length)} added (${how}).` : 'No new HNs.');
        if (skipped.length) parts.push(`${skipped.length} already in WME.`);
        if (beyond.length) parts.push(`${hn(beyond.length)} left for the next segment, which is not in WME yet.`);
        if (pastMapped.length) parts.push(`⚠ ${hn(pastMapped.length)} (${order(pastMapped)}) left off: they lie past the end of this segment, where another mapped segment (${[...touchingNames].join(' / ')}) connects, so they belong to it or the road beyond. Name that segment ${name} if it is the same street, then click it. Hold Alt while clicking to add them here anyway.`);
        if (forNeighbour.length) parts.push(`${hn(forNeighbour.length)} (${order(forNeighbour)}) left off: they sit on the connected segment, which is not named ${name} yet.`);
        if (fanned.length) parts.push(`${hn(fanned.length)} fanned around the dead end (hold Alt while clicking to place them beside the road instead).`);
        if (nearContinuing.length) parts.push(`${hn(nearContinuing.length)} near the end placed beside the road, not fanned, because ${[...continuingWhat].join(' and ')} continues from it.`);
        if (altHeld && deadEnds.length) parts.push('Alt was held, so numbers at the dead end were placed beside the road.');
        if (sideFixed.length) parts.push(`Side taken from the GIS centerline for ${hn(sideFixed.length)}, because the mapped road is offset from it.`);
        if (flat.length) parts.push(`Could not tell the side for ${hn(flat.length)}.`);
        const nameClash = !added.length && !skipped.length && !flat.length && !beyond.length && !forNeighbour.length && !pastMapped.length && otherNames.size > 0;
        if (nameClash) parts.push(`Address points close to this road use other names: ${[...otherNames].slice(0, 4).join(', ')}.`);
        if (source.generic && source.used.address) parts.push(`(address points: ${source.used.address})`);
        // the numbers themselves go to the console only
        console.log(`[${SCRIPT_NAME}] ${name} house numbers:`, {
            added: order(added), atAddressPoint: order(exactAt), alreadyInWme: order(skipped), leftForNextSegment: order(beyond), fanned: order(fanned),
            besideRoadNearContinuingEnd: order(nearContinuing), sideFromGis: order(sideFixed), sideUnknown: order(flat)
        });
        if (decisions.length) {
            console.log(`[${SCRIPT_NAME}] ${name}: houses past the end of this segment (why each was kept or left):`);
            console.table(decisions);
        }
        // The GIS road of this street runs along a connected segment with another name (or none): say so first, so it can be fixed.
        const mismatch = neighbours.length > 0;
        if (mismatch) {
            const names = [...new Set(neighbours.map((n) => (n.name ? `${neighbours.length === 1 ? 'is' : 'are'} named "${n.name}"` : `${neighbours.length === 1 ? 'has' : 'have'} no name`)))].join(' / ');
            parts.unshift(`⚠ NAME MISMATCH: the connected segment${neighbours.length === 1 ? '' : 's'} along the GIS road ${name} ${names}. Rename ${neighbours.length === 1 ? 'it' : 'them'} to ${name} if that is right${forNeighbour.length ? ', then click it to add its HNs' : ''}.`);
        }
        const warn = flat.length > 0 || nameClash || mismatch || pastMapped.length > 0;
        return { message: parts.join(' '), warn, level: warn ? 'warn' : added.length ? 'ok' : 'info' };
    }

    // ------------------------------------------------------------------
    // Snap: move a mapped road onto the GIS centerline (off by default; hand mapping is often better)
    // ------------------------------------------------------------------
    const CLEANUP_MIN_SHIFT_M = 1.5;      // a road already this close to the GIS line is left alone
    const CLEANUP_MAX_END_MOVE_M = 40;    // an end that would have to move further than this probably isn't the same road
    const CLEANUP_PINNED_BEND_M = 8;      // a pinned end this far from the GIS line leaves a visible bend

    // Moves the road's shape onto the GIS centerline it follows. An end that is a dead end or a simple joint (this
    // road plus at most one other segment) is moved onto the line too, which reshapes that neighbour's last stretch;
    // an end at a real junction (3 or more segments) stays where it is so nothing else is disturbed.
    async function cleanUpRoad(segmentId) {
        const segment = sdk.DataModel.Segments.getById({ segmentId });
        if (!segment) return { message: 'Segment not found.', warn: true, error: true, failed: true, notFound: true };
        const coords = segment.geometry.coordinates;
        const source = await resolveSource({ lon: coords[0][0], lat: coords[0][1] });
        if (!source) return { message: noSourceMessage(), warn: true, failed: true };

        const project = makeProjector(coords[0]);
        const mx = 111320 * Math.cos(coords[0][1] * RAD);
        const my = 110540;
        const toLL = (p) => [coords[0][0] + p[0] / mx, coords[0][1] + p[1] / my];
        const P = coords.map(project);
        const samples = xyResample(P, 5);

        const lons = coords.map((c) => c[0]);
        const lats = coords.map((c) => c[1]);
        const pad = 0.0005;
        const box = { minLon: Math.min(...lons) - pad, maxLon: Math.max(...lons) + pad, minLat: Math.min(...lats) - pad, maxLat: Math.max(...lats) + pad };
        const data = await (source.queryAll || source.query).call(source, box);
        if (data.error) throw new Error(data.error.message || 'GIS road query error');

        // the GIS line this road follows (within tolerance and parallel for at least half of its length)
        let best = null;
        for (const feature of data.features || []) {
            for (const part of linePartsOf(feature)) {
                const G = part.map(project);
                let hits = 0;
                const dists = [];
                for (const sm of samples) {
                    const n = xyNearest(G, sm.x, sm.y);
                    let da = Math.abs(sm.ang - n.ang) % Math.PI;
                    da = Math.min(da, Math.PI - da);
                    if (n.d <= GIS_ALONG_TOLERANCE_M && da <= OVERLAP_PARALLEL_RAD) {
                        hits++;
                        dists.push(n.d);
                    }
                }
                const frac = samples.length ? hits / samples.length : 0;
                if (frac >= 0.5 && (!best || frac > best.frac)) best = { G, cumG: xyCumulative(G), frac, dists };
            }
        }
        if (!best) return { message: 'No GIS centerline runs along this road (within 30 m and parallel), so it was left alone.', warn: true, failed: true };

        const ends = [
            { label: 'A', nodeId: segment.fromNodeId, p: P[0] },
            { label: 'B', nodeId: segment.toNodeId, p: P[P.length - 1] }
        ].map((end) => {
            const node = sdk.DataModel.Nodes.getById({ nodeId: end.nodeId });
            const n = xyNearest(best.G, end.p[0], end.p[1], best.cumG);
            const neighbours = node ? node.connectedSegmentIds.filter((id) => id !== segmentId) : [];
            const movable = neighbours.length <= 1;
            const at = xyPointAt(best.G, best.cumG, n.pos);
            return { ...end, neighbours, movable, off: n.d, pos: n.pos, target: movable ? [at.x, at.y] : end.p };
        });

        const maxOffset = Math.max(...best.dists, ...ends.map((e) => e.off));
        if (maxOffset < CLEANUP_MIN_SHIFT_M) return { message: `Already on the GIS centerline (within ${CLEANUP_MIN_SHIFT_M} m).`, warn: false, info: true };
        for (const end of ends) {
            if (end.movable && end.off > CLEANUP_MAX_END_MOVE_M) {
                return { message: `End ${end.label} is ${end.off.toFixed(0)} m from the GIS line, too far to move it (it may not be the same road), so nothing was changed.`, warn: true, failed: true };
            }
        }

        // new shape: both end points, with the GIS line's own points in between
        const lo = Math.min(ends[0].pos, ends[1].pos) + 0.5;
        const hi = Math.max(ends[0].pos, ends[1].pos) - 0.5;
        let inner = best.G.map((p, i) => ({ p, pos: best.cumG[i] })).filter((v) => v.pos > lo && v.pos < hi);
        if (ends[0].pos > ends[1].pos) inner = inner.reverse();
        const newXY = [ends[0].target, ...inner.map((v) => v.p), ends[1].target];
        const newCoords = [
            ends[0].movable ? toLL(ends[0].target) : coords[0],
            ...inner.map((v) => toLL(v.p)),
            ends[1].movable ? toLL(ends[1].target) : coords[coords.length - 1]
        ];

        const cumN = xyCumulative(newXY);
        let maxShift = 0;
        for (let d = 0; d <= cumN[cumN.length - 1]; d += 5) {
            const q = xyPointAt(newXY, cumN, d);
            maxShift = Math.max(maxShift, xyNearest(P, q.x, q.y).d);
        }

        // Both ends are junctions that stay put and the shape in between would barely change: nothing useful to do.
        if (!ends.some((e) => e.movable && e.off > 0.3) && maxShift < CLEANUP_MIN_SHIFT_M) {
            return { message: "This road can't follow the GIS line without moving its junctions, which stay put, so it was left alone.", warn: true };
        }

        const movedEnds = [];
        for (const end of ends) {
            if (end.movable && end.off > 0.3) {
                sdk.DataModel.Nodes.moveNode({ id: end.nodeId, geometry: { type: 'Point', coordinates: toLL(end.target) } });
                movedEnds.push(end);
            }
        }
        await sleep(300);
        sdk.DataModel.Segments.updateSegment({ segmentId, geometry: { type: 'LineString', coordinates: newCoords } });
        await sleep(400);

        const after = sdk.DataModel.Segments.getById({ segmentId });
        const parts = [`Snapped onto the GIS centerline by up to ${Math.max(maxShift, ...movedEnds.map((e) => e.off)).toFixed(1)} m (${coords.length} to ${newCoords.length} points).`];
        for (const end of movedEnds) {
            parts.push(`End ${end.label} moved ${end.off.toFixed(1)} m${end.neighbours.length ? ' and reshaped the neighbouring segment' : ''}.`);
        }
        let warn = false;
        for (const end of ends) {
            if (!end.movable && end.off > CLEANUP_PINNED_BEND_M) {
                warn = true;
                parts.push(`End ${end.label} is a junction and stayed ${end.off.toFixed(1)} m from the GIS line, so a bend remains there.`);
            }
        }
        if (after && (after.fromNodeId !== segment.fromNodeId || after.toNodeId !== segment.toNodeId)) {
            warn = true;
            parts.push('The end nodes changed; check the junctions.');
        }
        parts.push('Ctrl+Z undoes it.');
        return { message: parts.join(' '), warn };
    }

    // Clean up mode: click an existing road to move it onto the GIS centerline (and add its house numbers if that is on too).
    async function cleanUpAt(click, existing) {
        const segmentId = existing.segment.id;
        const name = streetNameOf(segmentId) || 'Road';
        setStatus(`Snapping ${name}...`, 'info');
        const result = await cleanUpRoad(segmentId);
        const parts = [result.message];
        let level = result.error ? 'error' : result.warn ? 'warn' : result.info ? 'info' : 'ok';

        if (houseNumbersEnabled && !result.notFound) {
            const source = await resolveSource(click);
            const streetName = streetNameOf(segmentId);
            if (source && source.houseNumbers && streetName) {
                try {
                    const hn = await addHouseNumbers(source, segmentId, streetName);
                    if (hn.message) parts.push(hn.message);
                    if (hn.warn) level = 'warn';
                    else if (hn.level === 'ok' && level === 'info') level = 'ok';
                } catch (err) {
                    level = 'error';
                    parts.push(`HNs failed: ${err.message || err}.`);
                    console.warn(`[${SCRIPT_NAME}] addHouseNumbers failed:`, err);
                }
            }
        }
        setStatus(`${name}: ${parts.join(' ')}`, level);
        console.log(`[${SCRIPT_NAME}] ${name} (segment ${segmentId}): ${parts.join(' ')}`);
        try {
            sdk.Editing.setSelection({ selection: { objectType: 'segment', ids: [segmentId] } });
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Could not select segment:`, err);
        }
    }

    // The nearest live, real road segment within `tolerance` meters of the click, or null.
    function findExistingRoadAt(click, tolerance = 12) {
        const project = makeProjector([click.lon, click.lat]);
        let best = null;
        for (const segment of sdk.DataModel.Segments.getAll()) {
            if (!isLiveSegment(segment) || OVERLAP_IGNORED_ROAD_TYPES.has(segment.roadType)) continue;
            const near = xyNearest(segment.geometry.coordinates.map(project), 0, 0);
            if (near.d <= tolerance && (!best || near.d < best.d)) best = { segment, d: near.d };
        }
        return best;
    }

    // House numbers: finds the existing WME segment under the click and adds the numbers it is missing.
    async function addNumbersAt(click) {
        const source = await resolveSource(click);
        if (!source) {
            setStatus(noSourceMessage(), 'warn');
            return;
        }
        if (!source.houseNumbers) {
            setStatus(`No address point layer is checked in WME GIS Layers for ${source.county || 'this'} County (or statewide).`, 'warn');
            return;
        }
        const best = findExistingRoadAt(click);
        if (!best) {
            setStatus('No WME road under that click. Click right on the road.', 'warn');
            return;
        }
        const segmentId = best.segment.id;
        const name = streetNameOf(segmentId);
        if (!name) {
            setStatus("This segment has no street name, so its house numbers can't be matched. Name it first.", 'warn');
            return;
        }
        setStatus(`Looking up house numbers for ${name}...`, 'info');
        const result = await addHouseNumbers(source, segmentId, name);
        setStatus(`${name}: ${result.message}`, result.level || (result.warn ? 'warn' : 'ok'));
        console.log(`[${SCRIPT_NAME}] ${name} (segment ${segmentId}): ${result.message}`);
        try {
            sdk.Editing.setSelection({ selection: { objectType: 'segment', ids: [segmentId] } });
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Could not select segment:`, err);
        }
    }

    // ------------------------------------------------------------------
    // Import
    // ------------------------------------------------------------------
    function queryGis(source, lon, lat, buffer = 0.00015) {
        return source.query({ minLon: lon - buffer, maxLon: lon + buffer, minLat: lat - buffer, maxLat: lat + buffer });
    }

    async function importAt(click, options = {}) {
        const source = await resolveSource(click);
        if (!source) {
            setStatus(noSourceMessage(), 'warn');
            return;
        }
        const data = await queryGis(source, click.lon, click.lat);
        if (!data.features || data.features.length === 0) {
            setStatus('No GIS feature under click.', 'warn');
            return;
        }

        // Pick the feature whose line is nearest the click, not simply the first one returned.
        const ranked = data.features
            .map((f) => ({ f, parts: linePartsOf(f) }))
            .filter((r) => r.parts.length)
            .map((r) => {
                let bestPart = r.parts[0];
                let bestDist = Infinity;
                for (const part of r.parts) {
                    const d = distanceToLine(click, part);
                    if (d < bestDist) {
                        bestDist = d;
                        bestPart = part;
                    }
                }
                return { feature: r.f, coords: bestPart, dist: bestDist };
            })
            .sort((a, b) => a.dist - b.dist);

        if (!ranked.length) {
            setStatus('GIS feature is not a usable line.', 'error');
            return;
        }

        const { feature, coords } = ranked[0];
        return importFeature({ source, feature, coords, options });
    }

    // Imports one chosen GIS road (the part of importAt after the road is picked). Also used by the area import, which passes
    // options.quiet so the status line and the selection are left alone. Returns { outcome, level, message, name, segmentId }:
    // outcome is 'created', 'extended', 'skipped' or 'failed'.
    async function importFeature({ source, feature, coords, options = {} }) {
        const quiet = !!options.quiet;
        let name = '';
        const say = (outcome, level, message, extra = {}) => {
            if (!quiet) setStatus(message, level);
            return { outcome, level, message, name, ...extra };
        };

        // ONE_WAY: FT = flows with the drawing order, TF = against it, B/blank = two-way.
        // One-way roads are always built running A to B, so TF lines are reversed before creation.
        const oneWayCode = String(source.oneWay(feature.properties || {}) || '').trim().toUpperCase();
        const isOneWay = oneWayCode === 'FT' || oneWayCode === 'TF';
        if (oneWayCode === 'TF') coords.reverse();
        const featureKey = options.featureKey || `${source.key}:${feature.id}`;
        if (feature.id !== undefined && importedFeatureIds.has(featureKey)) {
            return say('skipped', 'warn', 'This GIS road was already imported this session.');
        }
        if (coords.length < 2) {
            return say('failed', 'error', 'GIS feature is not a usable line.');
        }

        const nameInfo = buildStreetName(source.nameParts(feature.properties || {}));
        name = nameInfo.name;

        // Both ends must be visible so nearby existing nodes are loaded and can be joined.
        if (REQUIRE_ENDS_ON_SCREEN) {
            const bounds = visibleBounds();
            const ends = [coords[0], coords[coords.length - 1]];
            const off = ends.map((c, i) => (isOnScreen(c, bounds) ? null : i === 0 ? 'A' : 'B')).filter(Boolean);
            if (off.length) {
                return say('failed', 'warn', `${name || 'This road'}: end ${off.join(' and ')} is off-screen, so existing nodes there may not be loaded. Zoom out or pan so both ends are visible, then click again.`);
            }
        }

        // Existing segments already along this road (a stub, or the whole road)? Shift skips this check.
        if (!options.force) {
            const handled = await handleOverlap({ coords, name, featureKey, isOneWay, oneWayCode, source });
            if (handled) {
                // handleOverlap has already put its explanation on the status line
                return { outcome: importedFeatureIds.has(featureKey) ? 'extended' : 'skipped', level: lastStatusLevel, message: lastStatusMessage, name };
            }
        }

        // A start or end that just runs along an existing road is cut off, so the new road joins where it leaves.
        let trimmed = {};
        if (!options.force) {
            const result = trimRunIns(coords);
            if (Object.keys(result.trimmed).length) {
                coords.splice(0, coords.length, ...result.coords);
                trimmed = result.trimmed;
            }
        }
        const joinTolerances = {};
        if (trimmed.from) joinTolerances.from = RUN_IN_JOIN_M;
        if (trimmed.to) joinTolerances.to = RUN_IN_JOIN_M;

        // 1. Snap endpoints onto loaded nodes, or onto the middle of loaded segments
        const { snaps, snappedFeatures } = snapEndpoints(coords, joinTolerances);

        // 2. Create the segment, attaching snap info so WME joins nodes / splits segments
        let created;
        try {
            created = addSegmentWithSnaps(coords, snappedFeatures);
        } catch (err) {
            console.error(`[${SCRIPT_NAME}] addSegment failed:`, err);
            return say('failed', 'error', `${name || 'New road'}: could not create segment: ${err.message || err}`);
        }
        const { segmentId, patched } = created;
        if (feature.id !== undefined) importedFeatureIds.add(featureKey);

        let segment = sdk.DataModel.Segments.getById({ segmentId });
        if (!segment) {
            return say('failed', 'error', `${name || 'New road'}: the new segment was created but could not be read back from WME.`, { segmentId });
        }

        let directionNote = '';
        let directionFailed = false;
        const alreadyRight = isOneWay ? segment.isAtoB : segment.isTwoWay;
        if (!alreadyRight) {
            try {
                sdk.DataModel.Segments.updateSegment({ segmentId, direction: isOneWay ? 'A_TO_B' : 'TWO_WAY' });
                segment = sdk.DataModel.Segments.getById({ segmentId });
            } catch (err) {
                directionFailed = true;
                directionNote = `Could not set direction: ${err.message || err}.`;
                console.warn(`[${SCRIPT_NAME}] direction update failed:`, err);
            }
        }
        if (isOneWay && !directionFailed) directionNote = `One-way (${oneWayCode}), drawn A to B.`;

        // 3. Verify joins and turns
        const messages = [`${name || 'New road'}: created (${source.label}).`];
        let level = 'ok';
        for (const [key, meters] of Object.entries(trimmed)) {
            messages.push(`Trimmed ${meters} m off end ${key === 'from' ? 'A' : 'B'} that ran along an existing road.`);
        }
        if (directionNote) {
            messages.push(directionNote);
            if (directionFailed) level = 'warn';
        }

        if (snappedFeatures.length && !patched) {
            level = 'warn';
            messages.push('Could not attach node info to the native action, so ends are not joined.');
        }

        // Street name and cities from the GIS data
        if (name) {
            if (nameInfo.note) {
                level = 'warn';
                messages.push(nameInfo.note);
            }
            let cityInfo = { primaryCity: '', alternateCities: [], notes: [], warn: false, summary: '' };
            try {
                const postal = await resolvePostal(source, feature.properties, name, coords, feature.id);
                cityInfo = await resolveCities(coords, postal);
            } catch (err) {
                cityInfo.warn = true;
                cityInfo.notes.push(`City lookup failed: ${err.message || err}.`);
                console.warn(`[${SCRIPT_NAME}] resolveCities failed:`, err);
            }
            try {
                applyAddress(segmentId, name, cityInfo.primaryCity, cityInfo.alternateCities);
                if (cityInfo.summary) messages.push(cityInfo.summary);
            } catch (err) {
                level = 'warn';
                messages.push(`Could not set address for "${name}": ${err.message || err}.`);
                console.warn(`[${SCRIPT_NAME}] applyAddress failed:`, err);
            }
            if (cityInfo.warn) level = 'warn';
            messages.push(...cityInfo.notes);
        } else {
            level = 'warn';
            messages.push('GIS road has no street name.');
        }

        // A split happens synchronously, but give WME a moment to settle before reading node links.
        if (Object.values(snaps).some((sn) => sn.kind === 'edge')) await sleep(300);
        segment = sdk.DataModel.Segments.getById({ segmentId }) || segment;

        const ends = [
            { label: 'A', snap: snaps.from, actual: segment.fromNodeId },
            { label: 'B', snap: snaps.to, actual: segment.toNodeId }
        ];

        for (const end of ends) {
            if (!end.snap) continue;

            const node = sdk.DataModel.Nodes.getById({ nodeId: end.actual });
            const connectedCount = node ? node.connectedSegmentIds.length : 0;
            // Node target: the new segment must end on that exact node.
            // Segment target: the split leaves the two halves plus the new segment on one node.
            const joined = end.snap.kind === 'node'
                ? end.actual === end.snap.targetId
                : connectedCount >= 3;
            const what = end.snap.kind === 'node'
                ? 'joined an existing intersection'
                : 'split the road it meets and joined it';

            if (joined) {
                const turns = await verifyTurns(end.actual, segmentId);
                if (turns.error) {
                    level = 'warn';
                    messages.push(`End ${end.label} ${what}; turn check failed.`);
                } else if (turns.blocked) {
                    level = 'warn';
                    messages.push(`End ${end.label} ${what}; ${turns.blocked} turn(s) still blocked.`);
                } else {
                    messages.push(`End ${end.label} ${what} (${turns.allowed} turn(s) open).`);
                }
            } else {
                level = 'warn';
                const target = end.snap.kind === 'node' ? 'the intersection it should join' : 'the road it meets';
                messages.push(`End ${end.label} did NOT connect to ${target}.`);
                console.warn(`[${SCRIPT_NAME}] Connection failed at end ${end.label}: wanted ${end.snap.kind} ${end.snap.targetId}, end node is ${end.actual} with ${connectedCount} segment(s).`);
            }
        }

        if (snaps.from === undefined && snaps.to === undefined) {
            messages.push('No existing node or segment near either end.');
        }

        // House numbers for the new segment (Kendall County address points), if switched on
        if (houseNumbersEnabled && source.houseNumbers && name) {
            try {
                const result = await addHouseNumbers(source, segmentId, name);
                if (result.message) messages.push(result.message);
                if (result.warn) level = 'warn';
            } catch (err) {
                level = 'warn';
                messages.push(`HNs failed: ${err.message || err}.`);
                console.warn(`[${SCRIPT_NAME}] addHouseNumbers failed:`, err);
            }
        }

        console.log(`[${SCRIPT_NAME}] (segment ${segmentId}) ${messages.join(' ')}`);

        // 4. Select the new segment (the area import skips this: it would select hundreds of segments in a row)
        if (!quiet) {
            try {
                sdk.Editing.setSelection({ selection: { objectType: 'segment', ids: [segmentId] } });
            } catch (err) {
                console.warn(`[${SCRIPT_NAME}] Could not select new segment:`, err);
            }
        }
        return say('created', level, messages.join(' '), { segmentId });
    }

    // ------------------------------------------------------------------
    // Fill in missing info: Roads on, click a mapped road. Only blanks are filled; nothing it already has is changed.
    // ------------------------------------------------------------------
    const FILL_MIN_ALONG = 0.3; // the GIS road must run along at least this much of the segment

    // The GIS road that runs along a mapped segment (within GIS_ALONG_TOLERANCE_M and parallel), or null.
    let lastAlongNote = '';
    async function gisRoadAlong(segment, source) {
        const coords = segment.geometry.coordinates;
        const project = makeProjector(coords[0]);
        const samples = xyResample(coords.map(project), 5);
        const lons = coords.map((c) => c[0]);
        const lats = coords.map((c) => c[1]);
        const pad = 0.0005;
        const box = { minLon: Math.min(...lons) - pad, maxLon: Math.max(...lons) + pad, minLat: Math.min(...lats) - pad, maxLat: Math.max(...lats) + pad };
        // Every road layer that is checked is asked (city, county and statewide), not just the first one that has some road in the box:
        // a city layer with a different road nearby must not hide the county layer that has this one. Ties go to the more local layer.
        const data = await (source.queryAll || source.query).call(source, box);
        if (data.error) throw new Error(data.error.message || 'GIS road query error');
        const perLayer = new Map();
        for (const feature of data.features || []) {
            const layerName = (feature.properties && feature.properties.__layer && feature.properties.__layer.id) || source.label;
            perLayer.set(layerName, (perLayer.get(layerName) || 0) + 1);
        }
        lastAlongNote = perLayer.size
            ? `The GIS roads within about 50 m (${[...perLayer].map(([name, n]) => `${name}: ${n}`).join(', ')}) do not run along it.`
            : 'No GIS roads at all were found within about 50 m of it.';
        let best = null;
        for (const feature of data.features || []) {
            for (const part of linePartsOf(feature)) {
                const G = part.map(project);
                let hits = 0;
                for (const sm of samples) {
                    const n = xyNearest(G, sm.x, sm.y);
                    let da = Math.abs(sm.ang - n.ang) % Math.PI;
                    da = Math.min(da, Math.PI - da);
                    if (n.d <= GIS_ALONG_TOLERANCE_M && da <= OVERLAP_PARALLEL_RAD) hits++;
                }
                const frac = samples.length ? hits / samples.length : 0;
                if (frac >= FILL_MIN_ALONG && (!best || frac > best.frac)) best = { feature, part, frac };
            }
        }
        // the status line names the layer the road actually came from (later postal lookups may touch other layers)
        if (best && best.feature.properties && best.feature.properties.__layer) best.layerId = best.feature.properties.__layer.id;
        return best;
    }

    // The street name copied from Google Maps (see watchGoogleMaps), if it is recent and its click point is on this segment.
    const GOOGLE_STREET_MAX_AGE_MS = 30 * 60 * 1000;
    const GOOGLE_STREET_MAX_DIST_M = 40;

    function googleStreetNear(coords) {
        let rec = null;
        try {
            const raw = typeof GM_getValue === 'function' ? GM_getValue(GOOGLE_STREET_KEY, '') : '';
            rec = raw ? JSON.parse(raw) : null;
        } catch (e) {
            rec = null;
        }
        if (!rec || !rec.name || !Number.isFinite(rec.lat) || !Number.isFinite(rec.lon)) return null;
        const age = Date.now() - rec.at;
        const distM = Math.round(distanceToLine({ lon: rec.lon, lat: rec.lat }, coords));
        const why = age > GOOGLE_STREET_MAX_AGE_MS ? 'old' : distM > GOOGLE_STREET_MAX_DIST_M ? 'far' : '';
        const sec = Math.max(0, Math.round(age / 1000));
        const ageText = sec < 90 ? `${sec} s` : `${Math.round(sec / 60)} min`;
        return { rec, distM, ageText, ok: !why, why };
    }

    // Fills in a missing street name, primary city and postal alternate city from the GIS road along the segment,
    // using the same city rules as an import. Returns { message, warn, match }.
    // The street name from the address points beside a segment: for a road that is mapped but that no GIS road runs along. Points within
    // the sidebar distance of the segment (and not past either end) vote for their street name. The winner needs at least
    // ADDRESS_NAME_MIN_POINTS points and ADDRESS_NAME_MAJORITY of the votes; otherwise nothing is set and the reason says what was seen.
    const ADDRESS_NAME_MIN_POINTS = 2;
    const ADDRESS_NAME_MAJORITY = 0.6;
    const ADDRESS_NAME_BEYOND_END_M = 5;
    async function nameFromAddressPoints(segment, source) {
        const cfg = source.houseNumbers;
        if (!cfg) return { reason: `No address point layer is checked in WME GIS Layers for ${source.county || 'this'} County (or statewide), so the name could not come from address points.` };
        const radius = addressNameRadiusM;
        const coords = segment.geometry.coordinates;
        const project = makeProjector(coords[0]);
        const xy = coords.map(project);
        const cum = xyCumulative(xy);
        const lons = coords.map((c) => c[0]);
        const lats = coords.map((c) => c[1]);
        const padLat = (radius + 15) / 110540;
        const padLon = (radius + 15) / (111320 * Math.cos(coords[0][1] * RAD));
        const data = await cfg.query({ minLon: Math.min(...lons) - padLon, maxLon: Math.max(...lons) + padLon, minLat: Math.min(...lats) - padLat, maxLat: Math.max(...lats) + padLat });
        if (data.error) throw new Error(data.error.message || 'address point query error');
        const tally = new Map();
        let total = 0;
        for (const feature of data.features || []) {
            const c = feature.geometry && feature.geometry.coordinates;
            if (!Array.isArray(c) || typeof c[0] !== 'number') continue;
            const pointName = buildStreetName(cfg.nameParts(feature.properties || {})).name;
            if (!pointName) continue;
            const [x, y] = project(c);
            const near = xyNearest(xy, x, y, cum);
            if (near.d > radius || near.overshoot > ADDRESS_NAME_BEYOND_END_M) continue;
            const key = normalizeName(pointName);
            const entry = tally.get(key) || { name: pointName, n: 0, nearest: Infinity, farthest: 0 };
            entry.n++;
            entry.nearest = Math.min(entry.nearest, near.d);
            entry.farthest = Math.max(entry.farthest, near.d);
            tally.set(key, entry);
            total++;
        }
        const ranked = [...tally.values()].sort((a, b) => b.n - a.n);
        console.log(`[${SCRIPT_NAME}] address point street names within ${radius} m of the segment (points, nearest m, farthest m):`,
            ranked.map((e) => `${e.name}: ${e.n}, ${e.nearest.toFixed(0)}, ${e.farthest.toFixed(0)}`));
        if (!total) return { reason: `No address points with a street name within ${radius} m of it.` };
        const top = ranked[0];
        if (top.n < ADDRESS_NAME_MIN_POINTS || top.n / total < ADDRESS_NAME_MAJORITY) {
            return { reason: `The address points within ${radius} m do not agree on one street (${ranked.slice(0, 3).map((e) => `${e.name}: ${e.n}`).join(', ')}).` };
        }
        const second = ranked[1];
        return {
            name: top.name,
            summary: `${top.n} of ${total} address point${total === 1 ? '' : 's'} within ${radius} m${source.generic && source.used.address ? `, ${source.used.address}` : ''}`,
            note: second && second.n * 3 >= top.n ? `Address points also show ${second.name} (${second.n}) within ${radius} m; check that ${top.name} is right.` : ''
        };
    }

    // opts.continueOnMismatch: when the mapped name differs from the GIS name, fill in the cities anyway (the name is left alone) and report it in `mismatch`.
    async function fillSegmentInfo(segmentId, opts = {}) {
        const segment = sdk.DataModel.Segments.getById({ segmentId });
        if (!segment) return { message: 'Segment not found.', warn: true };
        const coords = segment.geometry.coordinates;
        const source = await resolveSource({ lon: coords[0][0], lat: coords[0][1] });
        const address = sdk.DataModel.Segments.getAddress({ segmentId });
        const cityOf = (x) => (x && x.city && !x.city.isEmpty && x.city.name ? x.city.name : '');
        const currentName = address.street && address.street.name ? address.street.name : '';
        const currentCity = cityOf(address);
        const currentAlts = (address.altStreets || []).filter((x) => x && x.street);

        // The GIS road along the segment, and the street name copied from Google Maps for this spot (used when the GIS has none).
        const match = source ? await gisRoadAlong(segment, source) : null;
        const google = googleStreetNear(coords);
        const useGoogle = !!(google && google.ok);
        if (!source && !useGoogle) return { message: noSourceMessage(), warn: true };

        const props = match ? match.feature.properties || {} : {};
        const gisName = match ? buildStreetName(source.nameParts(props)).name : '';
        const googleName = useGoogle ? buildStreetName({ full: google.rec.name }).name : '';

        const nameClash = !!(currentName && gisName && normalizeName(currentName) !== normalizeName(gisName) && !keptNames.has(keptKey(segmentId, gisName)));
        const mismatchInfo = nameClash && opts.continueOnMismatch ? { mapped: currentName, gis: gisName } : null;
        if (nameClash && !mismatchInfo) {
            const rerun = async () => {
                cityCheckCache.clear();
                const again = await fillSegmentInfo(segmentId);
                setStatus(`${streetNameOf(segmentId) || 'Road'}: ${again.message}`, again.error ? 'error' : again.warn ? 'warn' : again.info ? 'info' : 'ok', again.actions);
                ccRequestCheck(150, true);
            };
            return {
                message: `${mismatchText(currentName, gisName)} Nothing was changed.`,
                warn: true,
                match,
                actions: [
                    { label: `Apply: Rename to ${gisName} (GIS)`, primary: true, run: async () => { ccApply(segmentId, { kind: 'name', name: gisName }); await rerun(); } },
                    { label: `Keep mine: ${currentName} (until reload)`, run: async () => { keptNames.add(keptKey(segmentId, gisName)); await rerun(); } }
                ]
            };
        }
        let name = currentName || gisName;
        let nameFromGoogle = false;
        let nameFromPoints = false;
        let pointsInfo = null;
        if (!name && googleName) {
            name = googleName;
            nameFromGoogle = true;
        }
        // Still no name: the address points beside the segment (a road you mapped from the imagery, with no GIS road along it)
        if (!name && source) {
            try {
                pointsInfo = await nameFromAddressPoints(segment, source);
            } catch (err) {
                console.warn(`[${SCRIPT_NAME}] Address point name lookup failed:`, err);
                pointsInfo = { reason: `The address points could not be read (${err.message || err}).` };
            }
            if (pointsInfo.name) {
                name = pointsInfo.name;
                nameFromPoints = true;
            }
        }
        if (!name) {
            const why = pointsInfo && pointsInfo.reason ? ` ${pointsInfo.reason}` : '';
            if (match) return { message: `Neither this segment nor the GIS road has a street name, so nothing was filled in.${why}`, warn: true, match };
            let text = `No GIS road runs along this segment, so nothing was filled in. ${lastAlongNote}${why}`.replace(/\s+/g, ' ').trim();
            text += google
                ? ` The street name copied from Google Maps ("${google.rec.name}") ${google.why === 'old' ? `was copied ${google.ageText} ago` : `is ${google.distM} m from this segment`}, so it was not used.`
                : ' You can also right-click the street in Google Maps, then click this segment again.';
            return { message: text, warn: true };
        }

        const filled = [];
        const notes = [];
        let warn = false;
        if (!currentName) filled.push(`name "${name}"`);
        if (nameFromPoints && pointsInfo.note) {
            warn = true;
            notes.push(pointsInfo.note);
        }
        if (googleName && !nameFromGoogle && normalizeName(googleName) !== normalizeName(name)) {
            warn = true;
            notes.push(`Google Maps calls it "${googleName}" (left as is).`);
        }

        // Postal city: the GIS record, else the same street nearby, the address points along it, the sidebar setting,
        // then the nearest GIS road with one.
        // With no GIS road, the city in the Google Maps address is the postal city.
        const postal = match
            ? await resolvePostal(source, props, name, coords, match.feature.id, segmentId)
            : useGoogle
                ? { cities: [google.rec.city], notes: [], fromGoogle: true }
                : await resolvePostal(source, {}, name, coords, null, segmentId);
        const cityInfo = await resolveCities(coords, postal);

        let primary = currentCity;
        let newAltCities = [];
        if (cityInfo.skipCity) {
            warn = true;
            notes.push('City limits could not be loaded, so the city was not checked.');
        } else {
            if (!currentCity && cityInfo.primaryCity) {
                primary = cityInfo.primaryCity;
                filled.push(`city ${primary}`);
            } else if (currentCity && cityInfo.primaryCity && currentCity.toLowerCase() !== cityInfo.primaryCity.toLowerCase()) {
                warn = true;
                notes.push(`Its city is ${currentCity}, but it lies in ${cityInfo.primaryCity} limits (left as is).`);
            } else if (currentCity && !cityInfo.primaryCity) {
                warn = true;
                notes.push(`Its city is ${currentCity}, but it lies outside city and CDP limits (left as is).`);
            }
            const wantedAlts = cityInfo.alternateCities.filter((c) => c.toLowerCase() !== primary.toLowerCase());
            const haveAlts = currentAlts.map(cityOf).filter(Boolean);
            if (!currentAlts.length) {
                newAltCities = wantedAlts;
                if (newAltCities.length) filled.push(`alternate city ${newAltCities.join(' / ')}`);
            } else {
                const differ = wantedAlts.filter((c) => !haveAlts.some((h) => h.toLowerCase() === c.toLowerCase()));
                if (differ.length) {
                    warn = true;
                    notes.push(`Its alternate city is ${haveAlts.join(' / ') || 'blank'}, but the GIS ZIP points to ${differ.join(' / ')} (left as is).`);
                }
            }
            if (filled.some((f) => f.startsWith('city') || f.startsWith('alternate'))) {
                notes.push(...cityInfo.notes);
                if (cityInfo.warn) warn = true;
            }
        }

        if (!filled.length) {
            return { message: `Nothing missing.${notes.length ? ` ${notes.join(' ')}` : ''}`, warn, info: !warn, match, mismatch: mismatchInfo };
        }

        const { country, state } = regionOf(segmentId);
        if (!country || !state) return { message: `Could not fill in the address: ${REGION_ERROR}.`, warn: true, match };
        const alternateStreetIds = currentAlts.map((x) => x.street.id);
        for (const cityName of newAltCities) {
            let city = sdk.DataModel.Cities.getCity({ cityName, countryId: country.id, stateId: state.id });
            if (!city) city = sdk.DataModel.Cities.addCity({ cityName, countryId: country.id, stateId: state.id });
            let street = sdk.DataModel.Streets.getStreet({ streetName: name, cityId: city.id });
            if (!street) street = sdk.DataModel.Streets.addStreet({ streetName: name, cityId: city.id });
            alternateStreetIds.push(street.id);
        }
        sdk.DataModel.Segments.updateAddress({
            segmentId,
            addressData: { streetName: name, cityName: primary, countryId: country.id, stateId: state.id, alternateStreetIds }
        });
        const googleNote = useGoogle ? `right-clicked ${google.ageText} ago, ${google.distM} m from this segment; Google lists it as "${google.rec.full}"` : '';
        const origin = match
            ? `from the GIS road${source.generic ? ` (${match.layerId ? `GIS Layers: ${match.layerId}` : source.label})` : ''}.${nameFromGoogle ? ` The name came from Google Maps (${googleNote}).` : nameFromPoints ? ` The name came from the address points (${pointsInfo.summary}).` : ''}`
            : useGoogle
                ? `from Google Maps (${googleNote}).`
                : `with no GIS road along it${nameFromPoints ? `: the name came from the address points (${pointsInfo.summary})` : ''}.`;
        return { message: `Filled in ${filled.join(', ')} ${origin}${notes.length ? ` ${notes.join(' ')}` : ''}`, warn, match, mismatch: mismatchInfo };
    }

    // Click handler step: fill in the clicked road's missing info and show the result.
    async function fillInfoAt(existing) {
        const segmentId = existing.segment.id;
        setStatus('Checking the GIS for missing info...', 'info');
        let result;
        try {
            result = await fillSegmentInfo(segmentId);
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] fillSegmentInfo failed:`, err);
            result = { message: `Could not fill in info: ${err.message || err}.`, warn: true, error: true };
        }
        const label = `${streetNameOf(segmentId) || 'Road'}:`;
        const text = `${label} ${result.message}`;
        setStatus(text, result.error ? 'error' : result.warn ? 'warn' : result.info ? 'info' : 'ok', result.actions);
        console.log(`[${SCRIPT_NAME}] ${label.slice(0, -1)} (segment ${segmentId}): ${result.message}`);
        try {
            sdk.Editing.setSelection({ selection: { objectType: 'segment', ids: [segmentId] } });
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Could not select segment:`, err);
        }
        return { ...result, text };
    }

    // After a second action (house numbers, stub extension) puts its own message up, keep the fill-in message in front.
    function prependStatus(prefix, prefixLevel) {
        const rank = { info: 0, ok: 1, warn: 2, error: 3 };
        const level = (rank[prefixLevel] || 0) > (rank[lastStatusLevel] || 0) ? prefixLevel : lastStatusLevel;
        setStatus(`${prefix} ${lastStatusMessage}`, level, lastStatusActions);
    }

    // ------------------------------------------------------------------
    // Map events
    // ------------------------------------------------------------------
    mapDiv.addEventListener('mousemove', (e) => {
        if (!isImporterActive) return;
        cursorRing.style.left = `${e.clientX}px`;
        cursorRing.style.top = `${e.clientY}px`;
    });

    mapDiv.addEventListener('click', async (e) => {
        if (!isImporterActive || areaDrawing) return;
        // Other scripts sometimes fire synthetic clicks with no position; ignore them.
        if (!e.isTrusted || typeof e.clientX !== 'number' || typeof e.clientY !== 'number') return;

        e.stopPropagation();
        e.preventDefault();

        if (busy) return;
        busy = true;
        altHeld = e.altKey;

        try {
            // getLonLatFromPixel expects page (client) pixel coordinates, not map-relative ones.
            const click = sdk.Map.getLonLatFromPixel({ x: e.clientX, y: e.clientY });
            // a click this close to a mapped road counts as clicking that road (tighter for Roads, so an unmapped GIS
            // road that starts beside a mapped one can still be clicked to import it)
            const existing = cleanUpEnabled ? findExistingRoadAt(click) : importRoadsEnabled ? findExistingRoadAt(click, 8) : null;
            if (importRoadsEnabled && e.shiftKey) {
                await importAt(click, { force: true });
            } else if (cleanUpEnabled && existing) {
                await cleanUpAt(click, existing);
            } else if (importRoadsEnabled && existing) {
                // a mapped road: fill in its missing name and city first
                const fill = await fillInfoAt(existing);
                if (houseNumbersEnabled) {
                    // ...then its missing house numbers (the name just filled in lets them match)
                    await addNumbersAt(click);
                    prependStatus(fill.text, fill.warn ? 'warn' : 'ok');
                } else if (fill.match) {
                    // ...and if it is a stub the GIS road continues past, extend it as before
                    const stub = sdk.DataModel.Segments.getById({ segmentId: existing.segment.id });
                    if (stub && planExtension(fill.match.part, stub)) {
                        await importAt(click, {});
                        prependStatus(fill.text, fill.warn ? 'warn' : 'ok');
                    }
                }
            } else if (importRoadsEnabled) {
                await importAt(click, {});
            } else if (houseNumbersEnabled) {
                await addNumbersAt(click);
            } else {
                setStatus('No WME road under that click. Click right on the road to snap it.', 'warn');
            }
        } catch (err) {
            console.error(`[${SCRIPT_NAME}] Error processing GIS click:`, err);
            setStatus(`Error: ${err.message || err}`, 'error');
        } finally {
            busy = false;
            scheduleGapScan(); // whatever was just done may have filled in or changed a segment
        }
    }, true);

    // ------------------------------------------------------------------
    // Area import: outline an area, preview the GIS roads in it, then import them all in one run (roads), and add their
    // house numbers in a second run. Written as its own section (own state, layer, panel and loops) so it can move into
    // a script of its own later. It reuses importFeature() / addHouseNumbers() so every road is imported exactly as a single click would.
    // ------------------------------------------------------------------
    const AREA = {
        LAYER: 'wme-segment-importer-area',
        MAX_ROADS: 250,        // roads to import per run; a bigger outline is done in several runs
        SAVE_EVERY: 25,        // save after this many roads (or segments, for house numbers)
        TILE_DEG: 0.01,        // GIS queries are cut into boxes this big (about 1 km), so a big outline never hits the 2000-record limit
        MIN_ZOOM: 16,          // below this WME may not have every segment in view loaded
        WORK_ZOOM: 17,         // zoom used when the map has to be zoomed in to work
        PACE_MS: 150,          // breathing room between roads
        CONNECT_M: 4,          // a road end this close to another road counts as touching it (import order)
        VIEW_MARGIN: 0.1,      // an end must be this far inside the view (fraction) before the map is left where it is
        DATA_WAIT_MS: 2500,    // longest wait for WME to load the data after the map moved
        SAVE_TIMEOUT_MS: 90000,
        MAX_SWEEP_STOPS: 80,   // house number run: most map positions visited
        MAX_LIST: 60           // "needs a look" rows shown in the panel
    };
    const AREA_COLOURS = {
        new: COLOUR_ROADS, extend: '#1a73e8', mapped: '#9aa0a6', unchecked: '#f29900',
        ok: '#188038', warn: '#f29900', fail: '#d93025', skip: '#9aa0a6', halo: '#ffd400'
    };

    // phase: idle | drawing | ready (outline closed) | previewing | previewed | running | done
    const area = {
        phase: 'idle',
        points: [],          // [lon, lat] corners of the outline
        source: null,        // GIS source for the outline's county
        roads: [],           // preview items, in import order
        run: null,           // the run in progress, or the last one
        panelOpen: false,
        nowIndex: -1,
        nowCoords: null,     // the segment or road being worked on (drawn with a yellow halo)
        roadsDone: false,    // the roads of this outline have been imported
        fix: { items: [], counts: null },   // flagged existing segments (Check flagged / Fix flagged)
        message: { level: 'info', text: '' },
        lastClick: null
    };

    // ----- geometry on lon/lat (flat; fine at this scale) -----
    function areaPointInRing(pt, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i][0];
            const yi = ring[i][1];
            const xj = ring[j][0];
            const yj = ring[j][1];
            if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
    }

    function areaSegmentsCross(a, b, c, d) {
        const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
        const o1 = o(a, b, c);
        const o2 = o(a, b, d);
        const o3 = o(c, d, a);
        const o4 = o(c, d, b);
        return ((o1 > 0) !== (o2 > 0)) && ((o3 > 0) !== (o4 > 0));
    }

    // Does any part of this line lie inside the outline (a road that crosses the outline counts)?
    function areaLineTouches(line, ring) {
        for (const p of line) if (areaPointInRing(p, ring)) return true;
        for (let i = 0; i < line.length - 1; i++) {
            for (let j = 0; j < ring.length; j++) {
                if (areaSegmentsCross(line[i], line[i + 1], ring[j], ring[(j + 1) % ring.length])) return true;
            }
        }
        return false;
    }

    function areaRectTouches(rect, ring) {
        const corners = [[rect.minLon, rect.minLat], [rect.maxLon, rect.minLat], [rect.maxLon, rect.maxLat], [rect.minLon, rect.maxLat]];
        if (areaPointInRing([(rect.minLon + rect.maxLon) / 2, (rect.minLat + rect.maxLat) / 2], ring)) return true;
        if (ring.some((p) => p[0] >= rect.minLon && p[0] <= rect.maxLon && p[1] >= rect.minLat && p[1] <= rect.maxLat)) return true;
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < ring.length; j++) {
                if (areaSegmentsCross(corners[i], corners[(i + 1) % 4], ring[j], ring[(j + 1) % ring.length])) return true;
            }
        }
        return false;
    }

    function areaBox(points) {
        const lons = points.map((p) => p[0]);
        const lats = points.map((p) => p[1]);
        return { minLon: Math.min(...lons), maxLon: Math.max(...lons), minLat: Math.min(...lats), maxLat: Math.max(...lats) };
    }

    const areaLengthM = (line) => {
        let total = 0;
        for (let i = 0; i < line.length - 1; i++) total += distanceMeters(line[i][1], line[i][0], line[i + 1][1], line[i + 1][0]);
        return total;
    };

    // ----- map layer (SDK) -----
    let areaLayerReady = false;
    function ensureAreaLayer() {
        if (areaLayerReady) return true;
        try {
            sdk.Map.addLayer({
                layerName: AREA.LAYER,
                styleRules: [
                    { predicate: (p) => p.kind === 'fill', style: { fillColor: COLOUR_ROADS, fillOpacity: 0.07, strokeOpacity: 0, strokeWidth: 0 } },
                    { predicate: (p) => p.kind === 'outline', style: { strokeColor: COLOUR_ROADS, strokeWidth: 3, strokeOpacity: 0.95, strokeDashstyle: 'dash' } },
                    { predicate: (p) => p.kind === 'vertex', style: { pointRadius: 5, fillColor: COLOUR_ROADS, fillOpacity: 1, strokeColor: '#ffffff', strokeWidth: 2 } },
                    { predicate: (p) => p.kind === 'halo', style: { strokeColor: AREA_COLOURS.halo, strokeWidth: 16, strokeOpacity: 0.55, strokeLinecap: 'round' } },
                    ...Object.entries(GAP_KINDS).map(([kind, k]) => ({
                        predicate: (p) => p.kind === `gap-${kind}`,
                        style: { strokeColor: k.colour, strokeWidth: 9, strokeOpacity: 0.65, strokeLinecap: 'round' }
                    })),
                    ...Object.entries(AREA_COLOURS).filter(([k]) => k !== 'halo').map(([kind, colour]) => ({
                        predicate: (p) => p.kind === kind,
                        style: {
                            strokeColor: colour,
                            strokeWidth: kind === 'mapped' || kind === 'skip' ? 3 : 6,
                            strokeOpacity: kind === 'mapped' || kind === 'skip' ? 0.7 : 0.9,
                            strokeDashstyle: kind === 'mapped' || kind === 'skip' || kind === 'unchecked' ? 'dash' : 'solid',
                            strokeLinecap: 'round'
                        }
                    }))
                ]
            });
            areaLayerReady = true;
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Could not add the area import layer:`, err);
        }
        return areaLayerReady;
    }

    function drawAreaLayer() {
        if (!ensureAreaLayer()) return;
        try {
            sdk.Map.removeAllFeaturesFromLayer({ layerName: AREA.LAYER });
        } catch (err) { /* layer empty */ }
        const pts = area.points;
        const features = [];
        if (pts.length >= 3) {
            features.push({ type: 'Feature', id: 'outline-fill', geometry: { type: 'Polygon', coordinates: [[...pts, pts[0]]] }, properties: { kind: 'fill' } });
        }
        if (pts.length >= 2) {
            features.push({ type: 'Feature', id: 'outline', geometry: { type: 'LineString', coordinates: pts.length >= 3 ? [...pts, pts[0]] : pts }, properties: { kind: 'outline' } });
        }
        pts.forEach((p, i) => features.push({ type: 'Feature', id: `vertex-${i}`, geometry: { type: 'Point', coordinates: p }, properties: { kind: 'vertex' } }));
        area.roads.forEach((r, i) => {
            features.push({ type: 'Feature', id: `road-${i}`, geometry: { type: 'LineString', coordinates: r.coords }, properties: { kind: r.draw } });
        });
        area.fix.items.forEach((t, i) => {
            features.push({ type: 'Feature', id: `fix-${i}`, geometry: { type: 'LineString', coordinates: t.coords }, properties: { kind: t.draw } });
        });
        const nowCoords = area.nowCoords || (area.roads[area.nowIndex] && area.roads[area.nowIndex].coords);
        if (nowCoords) features.push({ type: 'Feature', id: 'halo', geometry: { type: 'LineString', coordinates: nowCoords }, properties: { kind: 'halo' } });
        if (!features.length) return;
        try {
            sdk.Map.addFeaturesToLayer({ layerName: AREA.LAYER, features });
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Could not draw the area import layer:`, err);
        }
    }

    // ----- the map: zoom, move, wait for WME's data -----
    function areaZoomOk() {
        try {
            return sdk.Map.getZoomLevel() >= AREA.MIN_ZOOM;
        } catch (e) {
            return true;
        }
    }

    function areaMoveTo(lon, lat) {
        if (!areaZoomOk()) {
            if (typeof sdk.Map.setZoomLevel === 'function') {
                sdk.Map.setZoomLevel({ zoomLevel: AREA.WORK_ZOOM });
            } else {
                sdk.Map.zoomToExtent({ bbox: [lon - 0.003, lat - 0.002, lon + 0.003, lat + 0.002] });
                return;
            }
        }
        sdk.Map.setMapCenter({ lonLat: { lon, lat } });
    }

    // Waits for WME to say its data loaded after the map moved (or a short time, if it has nothing new to load).
    async function areaWaitForData() {
        await Promise.race([sdk.Events.once({ eventName: 'wme-map-data-loaded' }).catch(() => null), sleep(AREA.DATA_WAIT_MS)]);
        await sleep(300);
    }

    // Both ends (and the middle) of a road well inside the view, and the map zoomed in enough that WME holds every segment there?
    function areaRoadInView(coords) {
        if (!areaZoomOk()) return false;
        const b = visibleBounds();
        const w = (b.maxLon - b.minLon) * AREA.VIEW_MARGIN;
        const h = (b.maxLat - b.minLat) * AREA.VIEW_MARGIN;
        const inner = { minLon: b.minLon + w, maxLon: b.maxLon - w, minLat: b.minLat + h, maxLat: b.maxLat - h };
        const mid = pointAlongLine(coords, 0.5);
        return [coords[0], mid, coords[coords.length - 1]].every((c) => isOnScreen(c, inner));
    }

    // Brings a road into view (zooming out to fit it when it is longer than the view) and lets WME load around it.
    async function areaShowRoad(coords) {
        if (areaRoadInView(coords)) return;
        const box = areaBox(coords);
        const view = visibleBounds();
        const fits = (box.maxLon - box.minLon) < (view.maxLon - view.minLon) * 0.8 && (box.maxLat - box.minLat) < (view.maxLat - view.minLat) * 0.8;
        if (fits) {
            areaMoveTo((box.minLon + box.maxLon) / 2, (box.minLat + box.maxLat) / 2);
        } else {
            sdk.Map.zoomToExtent({ bbox: [box.minLon, box.minLat, box.maxLon, box.maxLat] });
        }
        await areaWaitForData();
    }

    // ----- Save (the same DOM routine Rapid Map Suggestion uses; the SDK save is not relied on) -----
    const areaSaveButton = () => document.getElementById('save-button');
    const areaHasPending = () => {
        const b = areaSaveButton();
        return !!b && !b.hasAttribute('disabled');
    };

    // Presses Save and waits for the round trip. If WME asks "Save anyway?" (validation warnings) the run does NOT answer it:
    // the popover is left open for the user, and the warning text comes back in `why`.
    async function areaSave() {
        const btn = areaSaveButton();
        if (!btn) return { ok: false, why: "WME's Save button is not on the page right now." };
        if (btn.hasAttribute('disabled')) return { ok: true, nothing: true };
        const inner = btn.shadowRoot && btn.shadowRoot.querySelector('button');
        if (!inner) return { ok: false, why: "Could not press WME's Save button." };
        inner.click();
        const start = Date.now();
        await sleep(300);
        while (Date.now() - start < AREA.SAVE_TIMEOUT_MS) {
            // WME also shows a .save-popover after a GOOD save ("Saved", with the counts), so only the one titled "Save anyway?" is a stop.
            const pop = document.querySelector('.save-popover');
            const popTitle = pop && pop.querySelector('.actions-title');
            if (pop && popTitle && /save anyway/i.test(popTitle.textContent || '')) {
                const raw = ((pop.querySelector('.error-list') || pop).textContent || '').replace(/\s+/g, ' ').trim();
                return { ok: false, warnings: true, why: raw.length > 400 ? `${raw.slice(0, 400)}...` : raw };
            }
            const current = areaSaveButton();
            if (!current) return { ok: false, why: "WME's Save button went away while saving." };
            if (current.hasAttribute('disabled') && !current.hasAttribute('busy')) {
                await sleep(600); // let WME settle (new segments get their real ids)
                return { ok: true };
            }
            await sleep(100);
        }
        return { ok: false, why: `Saving took longer than ${Math.round(AREA.SAVE_TIMEOUT_MS / 1000)} seconds.` };
    }

    // ----- finding the GIS roads in the outline -----
    // One source for the whole outline: the centre and every corner must be in the same county.
    async function areaSourceFor(points) {
        const box = areaBox(points);
        const probes = [{ lon: (box.minLon + box.maxLon) / 2, lat: (box.minLat + box.maxLat) / 2 }, ...points.map((p) => ({ lon: p[0], lat: p[1] }))];
        let source = null;
        let ident = '';
        for (const pt of probes) {
            const s = await resolveSource(pt);
            if (!s) return { error: noSourceMessage() };
            const id = `${s.key}|${s.county || ''}`;
            if (!source) {
                source = s;
                ident = id;
            } else if (id !== ident) {
                return { error: 'The outline crosses a county line. Draw it inside one county.' };
            }
        }
        return { source };
    }

    async function areaQueryRoads(source, box, onProgress) {
        const tiles = [];
        for (let lon = box.minLon; lon < box.maxLon; lon += AREA.TILE_DEG) {
            for (let lat = box.minLat; lat < box.maxLat; lat += AREA.TILE_DEG) {
                tiles.push({ minLon: lon, maxLon: Math.min(lon + AREA.TILE_DEG, box.maxLon), minLat: lat, maxLat: Math.min(lat + AREA.TILE_DEG, box.maxLat) });
            }
        }
        const found = new Map();
        let failures = 0;
        let truncated = false;
        for (let i = 0; i < tiles.length; i++) {
            if (area.phase !== 'previewing') break;
            try {
                const data = await source.query(tiles[i]);
                if (data.error) throw new Error(data.error.message || 'GIS road query error');
                const features = data.features || [];
                if (features.length >= 1990) truncated = true;
                for (const f of features) {
                    const key = f.id !== undefined && f.id !== null ? String(f.id) : JSON.stringify(f.geometry).slice(0, 240);
                    if (!found.has(key)) found.set(key, f);
                }
            } catch (err) {
                failures++;
                console.warn(`[${SCRIPT_NAME}] Area GIS query failed:`, err);
                if (failures >= 3) throw new Error(`the GIS road query keeps failing (${err.message || err})`);
            }
            onProgress(i + 1, tiles.length);
            await sleep(100);
        }
        return { features: [...found.values()], truncated };
    }

    // What importing this road would do, without doing it. Mirrors the decisions in handleOverlap().
    function areaClassify(coords, name) {
        const analysis = analyzeOverlap(coords);
        if (analysis.unionLen < OVERLAP_MIN_M) return 'new';
        const stubMatch = analysis.matches
            .filter((m) => m.segFraction >= STUB_FRACTION && m.segCovered >= OVERLAP_MIN_M)
            .sort((a, b) => b.segCovered - a.segCovered)[0];
        const plan = stubMatch ? planExtension(coords, stubMatch.segment) : null;
        if (plan) {
            const stubName = streetNameOf(stubMatch.segment.id);
            if (stubName && name && normalizeName(stubName) !== normalizeName(name)) return 'mapped';
            const beyond = analyzeOverlap(plan.outward, [stubMatch.segment.id]);
            if (beyond.unionFraction >= PARTIAL_OVERLAP_FRACTION && beyond.unionLen >= OVERLAP_MIN_M) return 'mapped';
            return 'extend';
        }
        if (stubMatch) return 'mapped';
        return analysis.unionFraction >= PARTIAL_OVERLAP_FRACTION ? 'mapped' : 'new';
    }

    // Import order: roads that touch the existing network first, then roads that touch those, and so on, so every batch that
    // is saved is connected to something (a batch of loose roads makes WME warn about isolated segments).
    function areaOrder(items) {
        const touches = (a, b) => {
            const ends = [a.coords[0], a.coords[a.coords.length - 1]];
            if (ends.some((c) => distanceToLine({ lon: c[0], lat: c[1] }, b.coords) <= AREA.CONNECT_M)) return true;
            const ends2 = [b.coords[0], b.coords[b.coords.length - 1]];
            return ends2.some((c) => distanceToLine({ lon: c[0], lat: c[1] }, a.coords) <= AREA.CONNECT_M);
        };
        if (items.length > 600) return items; // too many to sort by connection quickly; keep the order the GIS gave them
        const seeds = [];
        const rest = [];
        items.forEach((it, i) => {
            it.idx = i;
            let seeded = it.kind === 'extend';
            if (!seeded && it.kind !== 'unchecked') {
                try {
                    seeded = Object.keys(snapEndpoints(it.coords.map((c) => [...c])).snaps).length > 0;
                } catch (e) {
                    seeded = false;
                }
            }
            (seeded ? seeds : rest).push(it);
        });
        const ordered = [];
        const seen = new Set();
        const walk = (start) => {
            const queue = [start];
            seen.add(start);
            while (queue.length) {
                const cur = queue.shift();
                ordered.push(cur);
                for (const other of items) {
                    if (!seen.has(other) && touches(cur, other)) {
                        seen.add(other);
                        queue.push(other);
                    }
                }
            }
        };
        seeds.forEach((s) => { if (!seen.has(s)) walk(s); });
        rest.forEach((r) => { if (!seen.has(r)) walk(r); });
        return ordered;
    }

    const areaToImport = () => area.roads.filter((r) => r.kind === 'new' || r.kind === 'extend' || r.kind === 'unchecked');

    function areaSetMessage(level, text) {
        area.message = { level, text };
        renderAreaPanel();
    }

    async function areaPreview() {
        if (area.points.length < 3 || area.phase === 'previewing' || area.phase === 'running') return;
        area.phase = 'previewing';
        area.roads = [];
        area.roadsDone = false;
        area.nowIndex = -1;
        area.run = null;
        busy = true;
        try {
            areaSetMessage('info', 'Checking which county this is...');
            const picked = await areaSourceFor(area.points);
            if (picked.error) {
                area.phase = 'ready';
                areaSetMessage('warn', picked.error);
                return;
            }
            area.source = picked.source;
            const box = areaBox(area.points);
            // Fit the map to the outline, so WME loads the segments there and "already in WME" can be judged.
            sdk.Map.zoomToExtent({ bbox: [box.minLon, box.minLat, box.maxLon, box.maxLat] });
            await areaWaitForData();

            const gis = await areaQueryRoads(area.source, box, (n, total) => areaSetMessage('info', `Asking the GIS for roads... ${n} of ${total} areas.`));
            if (area.phase !== 'previewing') return; // cancelled meanwhile

            const items = [];
            const seenKeys = new Set();
            for (const feature of gis.features) {
                const parts = linePartsOf(feature);
                parts.forEach((part, i) => {
                    if (part.length < 2 || areaLengthM(part) < 1 || !areaLineTouches(part, area.points)) return;
                    const key = parts.length > 1 ? `${area.source.key}:${feature.id}#${i}` : `${area.source.key}:${feature.id}`;
                    if (seenKeys.has(key)) return;
                    seenKeys.add(key);
                    const name = buildStreetName(area.source.nameParts(feature.properties || {})).name;
                    items.push({ feature, coords: part.map((c) => [...c]), key, name, kind: 'new', draw: 'new', state: 'pending' });
                });
            }

            areaSetMessage('info', `Comparing ${items.length} GIS roads with WME...`);
            await sleep(50);
            for (const it of items) {
                if (importedFeatureIds.has(it.key)) {
                    it.kind = 'mapped';
                } else if (!areaRoadInView(it.coords)) {
                    it.kind = 'unchecked';
                } else {
                    try {
                        it.kind = areaClassify(it.coords, it.name);
                    } catch (err) {
                        console.warn(`[${SCRIPT_NAME}] Could not compare a road with WME:`, err);
                        it.kind = 'unchecked';
                    }
                }
                it.draw = it.kind;
            }
            area.roads = areaOrder(items);
            area.phase = 'previewed';
            drawAreaLayer();
            const c = areaCounts();
            const extra = gis.truncated ? ' Some areas returned the GIS limit of 2000 roads, so roads may be missing: draw a smaller outline.' : '';
            if (!c.total) {
                areaSetMessage('warn', `No GIS roads touch the outline.${extra}`);
            } else if (c.todo > AREA.MAX_ROADS) {
                areaSetMessage('warn', `${c.text} That is ${c.todo - AREA.MAX_ROADS} more than the limit of ${AREA.MAX_ROADS} per run. Redraw a smaller outline.${extra}`);
            } else {
                areaSetMessage(gis.truncated ? 'warn' : 'ok', `${c.text}${extra}`);
            }
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Area preview failed:`, err);
            area.phase = area.points.length >= 3 ? 'ready' : 'idle';
            areaSetMessage('error', `Preview failed: ${err.message || err}`);
        } finally {
            busy = false;
            renderAreaPanel();
        }
    }

    function areaCounts() {
        const n = { total: area.roads.length, new: 0, extend: 0, mapped: 0, unchecked: 0 };
        area.roads.forEach((r) => { n[r.kind] = (n[r.kind] || 0) + 1; });
        const todo = n.new + n.extend + n.unchecked;
        const parts = [`${n.total} roads: ${todo} to import`];
        if (n.extend) parts.push(`${n.extend} of them extend an existing stub`);
        parts.push(`${n.mapped} already in WME`);
        if (n.unchecked) parts.push(`${n.unchecked} not compared with WME yet (outside the loaded map; checked when the run reaches them)`);
        return { ...n, todo, text: `${parts.shift()} (${parts.join(', ')}).` };
    }

    // ----- runs -----
    function areaNewRun(kind, total) {
        return { kind, paused: false, stop: false, total, done: 0, created: 0, extended: 0, skipped: 0, saves: 0, sinceSave: 0, needLook: [], startedAt: Date.now(), stopReason: '', fixed: 0, renamed: 0, unchanged: 0, found: 0, text: '' };
    }

    // Pause and stop are checked between roads; returns false when the run should end.
    async function areaGate() {
        while (area.run.paused && !area.run.stop) await sleep(200);
        return !area.run.stop;
    }

    async function areaPeriodicSave(run) {
        const result = await areaSave();
        if (result.ok) {
            run.sinceSave = 0;
            if (!result.nothing) run.saves++;
            return true;
        }
        run.stop = true;
        run.stopReason = result.warnings
            ? `WME asks "Save anyway?" and the run stopped there so you can look. The popover is still open: read it, fix what it names, then Save yourself. WME says: ${result.why}`
            : `Save did not finish: ${result.why}`;
        return false;
    }

    function areaRunSummary(run, ending) {
        const secs = Math.round((Date.now() - run.startedAt) / 1000);
        const time = secs >= 90 ? `${Math.round(secs / 60)} min` : `${secs} s`;
        const what = run.kind === 'roads'
            ? `${run.created} roads imported, ${run.extended} stubs extended, ${run.skipped} skipped`
            : run.kind === 'fix'
                ? `${run.fixed} flagged segments fixed${run.renamed ? ` (${run.renamed} renamed to the GIS name)` : ''}, ${run.unchanged} unchanged${run.shortLeft ? `, ${run.shortLeft} short segments with no GIS match left alone` : ''} (${run.done} looked at)`
                : run.kind === 'check'
                    ? run.text
                    : `${run.done} roads checked for house numbers, ${run.created} got numbers`;
        const saved = run.sinceSave > 0 ? ` ${run.sinceSave} change(s) since the last save are NOT saved.` : (run.saves ? ` Saved ${run.saves} time(s).` : '');
        const look = run.needLook.length ? ` ${run.needLook.length} need a look (listed below; the scan colours them on the map too).` : '';
        return `${ending} ${what} (${time}).${saved}${look}`;
    }

    function areaFinishRun(run, level, ending) {
        // after roads: done. After anything else: back to where the outline was (so Go is still there when the roads are not imported yet)
        area.phase = run.kind === 'roads' ? 'done' : area.roads.length ? (area.roadsDone ? 'done' : 'previewed') : 'ready';
        area.nowIndex = -1;
        area.nowCoords = null;
        area.run = run;
        busy = false;
        areaRunning = false;
        drawAreaLayer();
        const summary = areaRunSummary(run, ending);
        console.log(`[${SCRIPT_NAME}] Area ${run.kind} run: ${summary}`);
        for (const entry of run.needLook) console.log(`[${SCRIPT_NAME}]   needs a look: ${entry.name}: ${entry.message}`);
        areaSetMessage(level, summary);
        scheduleGapScan();
    }

    function areaRecord(run, item, result) {
        const level = result.level || 'info';
        let draw = 'ok';
        // a road skipped because it is already mapped is expected; one skipped for any other reason (different name, no free end) needs a look
        const benign = /already mapped|already imported/i.test(result.message || '');
        if (result.outcome === 'skipped' && benign) draw = 'skip';
        else if (level === 'error') draw = 'fail';
        else if (level === 'warn' || result.outcome === 'failed' || result.outcome === 'skipped') draw = 'warn';
        if (item) item.draw = draw;
        if (draw === 'warn' || draw === 'fail') {
            run.needLook.push({ name: result.name || (item && item.name) || 'Unnamed road', message: result.message, level: draw === 'fail' ? 'error' : 'warn', at: item ? pointAlongLine(item.coords, 0.5) : result.at });
        }
    }

    async function areaRunRoads() {
        const todo = areaToImport();
        if (area.phase !== 'previewed' || !todo.length || todo.length > AREA.MAX_ROADS || (area.run && area.run.running)) return;
        if (areaHasPending()) {
            areaSetMessage('warn', 'WME has unsaved edits. Save them first, so the saves during this run only hold the imported roads.');
            return;
        }
        const run = areaNewRun('roads', todo.length);
        run.running = true;
        area.run = run;
        area.phase = 'running';
        areaRunning = true;
        busy = true;
        areaSetMessage('info', `Importing ${todo.length} roads...`);
        const source = area.source;
        let failedHard = false;
        try {
            for (const item of todo) {
                if (!(await areaGate())) break;
                area.nowIndex = area.roads.indexOf(item);
                drawAreaLayer();
                renderAreaPanel();
                let result;
                try {
                    await areaShowRoad(item.coords);
                    result = await importFeature({ source, feature: item.feature, coords: item.coords.map((c) => [...c]), options: { quiet: true, featureKey: item.key } });
                } catch (err) {
                    console.error(`[${SCRIPT_NAME}] Area import error:`, err);
                    result = { outcome: 'failed', level: 'error', message: `${item.name || 'Road'}: ${err.message || err}`, name: item.name };
                }
                run.done++;
                if (result.outcome === 'created') run.created++;
                else if (result.outcome === 'extended') run.extended++;
                else if (result.outcome === 'skipped') run.skipped++;
                if (result.outcome === 'created' || result.outcome === 'extended') run.sinceSave++;
                areaRecord(run, item, result);
                if (result.level === 'error') {
                    run.stop = true;
                    failedHard = true;
                    run.stopReason = `Stopped on an error: ${result.message}`;
                    break;
                }
                if (run.sinceSave >= AREA.SAVE_EVERY && !(await areaPeriodicSave(run))) {
                    failedHard = true;
                    break;
                }
                await sleep(AREA.PACE_MS);
            }
            if (!run.stop && !failedHard) {
                // finished every road: one last save
                if (!(await areaPeriodicSave(run))) failedHard = true;
            }
        } catch (err) {
            console.error(`[${SCRIPT_NAME}] Area import crashed:`, err);
            run.stop = true;
            run.stopReason = `Stopped: ${err.message || err}`;
            failedHard = true;
        }
        run.running = false;
        if (run.created || run.extended) area.roadsDone = true;
        if (failedHard) areaFinishRun(run, 'error', run.stopReason);
        else if (run.stop) areaFinishRun(run, 'warn', 'Stopped by you.');
        else areaFinishRun(run, run.needLook.length ? 'warn' : 'ok', 'Done.');
    }

    // House numbers: sweeps the map across the outline and, at each stop, adds the missing numbers to the named segments inside it.
    function areaSweepCenters(box) {
        const view = visibleBounds();
        const w = (view.maxLon - view.minLon) * 0.7;
        const h = (view.maxLat - view.minLat) * 0.7;
        const cols = Math.max(1, Math.ceil((box.maxLon - box.minLon) / w));
        const rows = Math.max(1, Math.ceil((box.maxLat - box.minLat) / h));
        const cw = (box.maxLon - box.minLon) / cols;
        const ch = (box.maxLat - box.minLat) / rows;
        const centers = [];
        for (let r = 0; r < rows; r++) {
            const order = [...Array(cols).keys()];
            if (r % 2) order.reverse();
            for (const c of order) {
                const cell = { minLon: box.minLon + c * cw, maxLon: box.minLon + (c + 1) * cw, minLat: box.minLat + r * ch, maxLat: box.minLat + (r + 1) * ch };
                if (areaRectTouches(cell, area.points)) centers.push({ lon: (cell.minLon + cell.maxLon) / 2, lat: (cell.minLat + cell.maxLat) / 2 });
            }
        }
        return centers;
    }

    async function areaRunHouses() {
        if (area.phase !== 'ready' && area.phase !== 'previewed' && area.phase !== 'done') return;
        if (area.points.length < 3) return;
        if (!area.source) {
            const picked = await areaSourceFor(area.points);
            if (picked.error) {
                areaSetMessage('warn', picked.error);
                return;
            }
            area.source = picked.source;
        }
        if (!area.source.houseNumbers) {
            areaSetMessage('warn', `No address point layer is checked in WME GIS Layers for ${area.source.county || 'this'} County (or statewide), so there are no house numbers to add.`);
            return;
        }
        if (areaHasPending()) {
            areaSetMessage('warn', 'WME has unsaved edits. Save them first (house numbers need the roads saved), then run this again.');
            return;
        }
        const source = area.source;
        const run = areaNewRun('houses', 0);
        run.running = true;
        area.run = run;
        area.phase = 'running';
        areaRunning = true;
        busy = true;
        area.nowIndex = -1;
        areaSetMessage('info', 'Adding house numbers across the outline...');
        const handled = new Set();
        let failedHard = false;
        try {
            const box = areaBox(area.points);
            areaMoveTo((box.minLon + box.maxLon) / 2, (box.minLat + box.maxLat) / 2);
            await areaWaitForData();
            const centers = areaSweepCenters(box);
            if (centers.length > AREA.MAX_SWEEP_STOPS) throw new Error('the outline is too big for one house number run');
            run.stops = centers.length;
            for (let s = 0; s < centers.length; s++) {
                if (!(await areaGate())) break;
                run.stopAt = s + 1;
                areaMoveTo(centers[s].lon, centers[s].lat);
                await areaWaitForData();
                renderAreaPanel();
                const view = visibleBounds();
                const targets = [];
                for (const segment of sdk.DataModel.Segments.getAll()) {
                    if (handled.has(segment.id) || !isLiveSegment(segment) || OVERLAP_IGNORED_ROAD_TYPES.has(segment.roadType)) continue;
                    const mid = pointAlongLine(segment.geometry.coordinates, 0.5);
                    if (!isOnScreen(mid, view) || !areaPointInRing(mid, area.points)) continue;
                    targets.push({ id: segment.id, mid });
                }
                for (const target of targets) {
                    if (!(await areaGate())) break;
                    handled.add(target.id);
                    const name = streetNameOf(target.id);
                    run.done++;
                    if (!name) {
                        run.skipped++;
                        run.needLook.push({ name: 'Unnamed road', message: "Skipped: it has no street name, so its house numbers can't be matched.", level: 'warn', at: target.mid });
                        continue;
                    }
                    let result;
                    try {
                        result = await addHouseNumbers(source, target.id, name);
                    } catch (err) {
                        console.warn(`[${SCRIPT_NAME}] Area house numbers failed:`, err);
                        run.stop = true;
                        failedHard = true;
                        run.stopReason = `Stopped on an error at ${name}: ${err.message || err}`;
                        break;
                    }
                    if (result.level === 'ok') run.created++;
                    if (result.level === 'warn' || result.level === 'error') {
                        run.needLook.push({ name, message: result.message, level: result.level === 'error' ? 'error' : 'warn', at: target.mid });
                    }
                    if (areaHasPending() && ++run.sinceSave >= AREA.SAVE_EVERY && !(await areaPeriodicSave(run))) {
                        failedHard = true;
                        break;
                    }
                    await sleep(AREA.PACE_MS);
                }
                if (failedHard) break;
            }
            if (!run.stop && !failedHard && !(await areaPeriodicSave(run))) failedHard = true;
        } catch (err) {
            console.error(`[${SCRIPT_NAME}] Area house numbers crashed:`, err);
            run.stop = true;
            run.stopReason = `Stopped: ${err.message || err}`;
            failedHard = true;
        }
        run.running = false;
        if (failedHard) areaFinishRun(run, 'error', run.stopReason);
        else if (run.stop) areaFinishRun(run, 'warn', 'Stopped by you.');
        else areaFinishRun(run, run.needLook.length ? 'warn' : 'ok', 'Done.');
    }

    // ----- existing segments the scan flags: Check flagged (counts them) and Fix flagged (fixes them) -----
    async function areaPlaces() {
        if (!gapSettings.cities) return null;
        try {
            return await loadCityBoundaries();
        } catch (err) {
            return null; // limits not available: only the missing name / city is checked, as in the scan
        }
    }

    // Segments in this view whose midpoint is inside the outline and that the scan would flag (the scan's own rules).
    function areaFlaggedInView(view, places, handled) {
        const found = [];
        for (const segment of sdk.DataModel.Segments.getAll()) {
            if (handled.has(segment.id) || !isLiveSegment(segment) || !GAP_ROAD_TYPES.has(segment.roadType)) continue;
            const c = segment.geometry && segment.geometry.coordinates;
            if (!c || c.length < 2) continue;
            const mid = pointAlongLine(c, 0.5);
            if (!isOnScreen(mid, view) || !areaPointInRing(mid, area.points)) continue;
            const hit = evaluateSegmentInfo(segment, places, true);
            if (!hit) continue;
            // extra = only flagged because the area runs also look at the short segments the map scan excuses
            const extra = !evaluateSegmentInfo(segment, places);
            found.push({ ...hit, extra, coords: c.map((p) => [p[0], p[1]]), mid, draw: `gap-${hit.kind}` });
        }
        return found;
    }

    // Moves the map across the outline, stop by stop, and calls handler(view) at each stop (WME only holds the segments in view).
    // Returns false if the handler or the user ended it early.
    async function areaSweep(run, handler) {
        const box = areaBox(area.points);
        areaMoveTo((box.minLon + box.maxLon) / 2, (box.minLat + box.maxLat) / 2);
        await areaWaitForData();
        const centers = areaSweepCenters(box);
        if (centers.length > AREA.MAX_SWEEP_STOPS) throw new Error('the outline is too big for one pass over the map');
        run.stops = centers.length;
        for (let s = 0; s < centers.length; s++) {
            if (!(await areaGate())) return false;
            run.stopAt = s + 1;
            areaMoveTo(centers[s].lon, centers[s].lat);
            await areaWaitForData();
            renderAreaPanel();
            if ((await handler(visibleBounds())) === false) return false;
        }
        return true;
    }

    // Fixes one flagged segment: the primary city the limits call for (outside every limit the primary is cleared and the postal city
    // goes in as the alternate; if no postal city can be found the old primary is put back), then the blanks (name, cities) from the
    // GIS, Google Maps or the address points as a Roads click does, then the street name (a name that differs from the GIS name is
    // renamed to the GIS name, as the "Apply: Rename" button does).
    // Returns { outcome: 'fixed' | 'review' | 'unchanged', changed, renamed, message }.
    async function areaFixSegment(t, places) {
        const id = t.id;
        const notes = [];
        let changed = false;
        let renamed = false;
        let cleared = false;
        const before = ccAddressOf(id);
        const originalPrimary = before ? before.primary : '';

        const analysis = await ccAnalyze(id, false);
        const primary = (analysis.proposals || []).find((p) => p.kind === 'primary');
        if (primary && primary.city) {
            ccApply(id, primary);
            changed = true;
            notes.push(`${primary.label}.`);
        } else if (primary && t.kind === 'badcity' && originalPrimary) {
            ccApply(id, primary);
            changed = true;
            cleared = true;
            notes.push(`Cleared the primary city ${originalPrimary} (it is outside every city and CDP limit).`);
        }

        const fill = await fillSegmentInfo(id, { continueOnMismatch: true });
        const filledSomething = /^Filled in/.test(fill.message);
        if (filledSomething) {
            changed = true;
            notes.push(fill.message);
        }

        if (fill.mismatch) {
            ccApply(id, { kind: 'name', name: fill.mismatch.gis });
            changed = true;
            renamed = true;
            notes.push(`Renamed "${fill.mismatch.mapped}" to "${fill.mismatch.gis}" (GIS).`);
        }
        if (changed) cityCheckCache.clear();

        let segment = sdk.DataModel.Segments.getById({ segmentId: id });
        let after = segment ? evaluateSegmentInfo(segment, places, true) : null;

        // the primary was cleared but no city took its place: a segment with no city at all is worse, so put it back
        if (cleared && after && (after.kind === 'city' || after.kind === 'none')) {
            ccApply(id, { kind: 'primary', city: originalPrimary });
            cityCheckCache.clear();
            notes.push(`No postal city was found to take its place, so ${originalPrimary} was put back.`);
            segment = sdk.DataModel.Segments.getById({ segmentId: id });
            after = segment ? evaluateSegmentInfo(segment, places, true) : null;
        }

        if (after) {
            notes.push(`Still flagged (${after.detail}). ${filledSomething ? '' : fill.message}`.trim());
            return { outcome: 'review', changed, renamed, message: notes.join(' ') };
        }
        if (changed) return { outcome: 'fixed', changed, renamed, message: notes.join(' ') };
        return { outcome: 'unchanged', changed: false, renamed: false, message: fill.message };
    }

    // Counts the flagged segments in the outline (changes nothing).
    async function areaRunCheck() {
        if (area.points.length < 3 || !['ready', 'previewed', 'done'].includes(area.phase)) return;
        const run = areaNewRun('check', 0);
        run.running = true;
        area.run = run;
        area.phase = 'running';
        areaRunning = true;
        busy = true;
        area.fix = { items: [], counts: null };
        areaSetMessage('info', 'Looking for flagged segments across the outline...');
        let failedHard = false;
        try {
            const places = await areaPlaces();
            const handled = new Set();
            await areaSweep(run, async (view) => {
                for (const t of areaFlaggedInView(view, places, handled)) {
                    handled.add(t.id);
                    area.fix.items.push(t);
                    run.found++;
                }
                drawAreaLayer();
            });
            const byKind = {};
            area.fix.items.forEach((t) => { byKind[t.kind] = (byKind[t.kind] || 0) + 1; });
            area.fix.counts = { total: area.fix.items.length, byKind };
            const parts = Object.entries(byKind).map(([k, n]) => `${n} ${GAP_KINDS[k].label}`);
            run.text = area.fix.items.length
                ? `${area.fix.items.length} flagged segments (${parts.join('; ')})`
                : 'No segments in the outline are flagged';
            if (area.fix.items.length > AREA.MAX_ROADS) run.text += `; that is more than the limit of ${AREA.MAX_ROADS} per run, so Fix flagged takes them in parts`;
            run.needLook = [];
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Check flagged failed:`, err);
            run.stop = true;
            run.stopReason = `Stopped: ${err.message || err}`;
            failedHard = true;
        }
        run.running = false;
        if (failedHard) areaFinishRun(run, 'error', run.stopReason);
        else if (run.stop) areaFinishRun(run, 'warn', 'Stopped by you.');
        else areaFinishRun(run, area.fix.items.length ? 'warn' : 'ok', 'Done.');
    }

    // Fixes the flagged segments in the outline, one at a time, saving every 25 changes (same rules as the road import).
    async function areaRunFix() {
        if (area.points.length < 3 || !['ready', 'previewed', 'done'].includes(area.phase)) return;
        if (areaHasPending()) {
            areaSetMessage('warn', 'WME has unsaved edits. Save them first, so the saves during this run only hold the fixes.');
            return;
        }
        const run = areaNewRun('fix', 0);
        run.running = true;
        area.run = run;
        area.phase = 'running';
        areaRunning = true;
        busy = true;
        area.fix = { items: [], counts: null };
        areaSetMessage('info', 'Fixing the flagged segments...');
        let failedHard = false;
        let limitHit = false;
        let errorsInRow = 0;
        let places = null;
        try {
            places = await areaPlaces();
            const handled = new Set();
            await areaSweep(run, async (view) => {
                for (const t of areaFlaggedInView(view, places, handled)) {
                    if (!(await areaGate())) return false;
                    if (run.done >= AREA.MAX_ROADS) {
                        limitHit = true;
                        return false;
                    }
                    handled.add(t.id);
                    run.done++;
                    area.fix.items.push(t);
                    area.nowCoords = t.coords;
                    drawAreaLayer();
                    renderAreaPanel();
                    let result;
                    try {
                        result = await areaFixSegment(t, places);
                        errorsInRow = 0;
                    } catch (err) {
                        console.warn(`[${SCRIPT_NAME}] Area fix failed:`, err);
                        errorsInRow++;
                        result = { outcome: 'failed', changed: false, message: `${err.message || err}` };
                        if (errorsInRow >= 3) {
                            failedHard = true;
                            run.stop = true;
                            run.stopReason = `Stopped after 3 errors in a row. The last one: ${err.message || err}`;
                        }
                    }
                    const label = t.name || 'Unnamed road';
                    // a short segment only looked at because of this run, with no GIS road to fill it from: nothing to report
                    if (t.extra && (result.outcome === 'unchanged' || (result.outcome === 'review' && !result.changed))) {
                        area.fix.items = area.fix.items.filter((x) => x !== t);
                        run.shortLeft = (run.shortLeft || 0) + 1;
                        continue;
                    }
                    if (result.renamed) {
                        run.renamed++;
                        console.log(`[${SCRIPT_NAME}] Area fix: ${result.message}`);
                    }
                    if (result.outcome === 'fixed') {
                        run.fixed++;
                        t.draw = 'ok';
                    } else if (result.outcome === 'review') {
                        t.draw = 'warn';
                        run.needLook.push({ name: label, message: result.message, level: 'warn', at: t.mid });
                    } else if (result.outcome === 'failed') {
                        t.draw = 'fail';
                        run.needLook.push({ name: label, message: `Error: ${result.message}`, level: 'error', at: t.mid });
                    } else {
                        run.unchanged++;
                        t.draw = 'skip';
                        run.needLook.push({ name: label, message: `Nothing could be done. ${result.message}`, level: 'warn', at: t.mid });
                    }
                    if (failedHard) return false;
                    if (result.changed && areaHasPending() && ++run.sinceSave >= AREA.SAVE_EVERY && !(await areaPeriodicSave(run))) {
                        failedHard = true;
                        return false;
                    }
                    await sleep(AREA.PACE_MS);
                }
                return true;
            });
            if (!run.stop && !failedHard && !(await areaPeriodicSave(run))) failedHard = true;
        } catch (err) {
            console.error(`[${SCRIPT_NAME}] Area fix crashed:`, err);
            run.stop = true;
            run.stopReason = `Stopped: ${err.message || err}`;
            failedHard = true;
        }
        run.running = false;
        // fixed segments lose their mark (the green is only for while the run is going); a mark stays only on a segment that is still flagged
        area.fix.items = area.fix.items.filter((t) => {
            if (t.draw === 'ok') return false;
            try {
                const seg = sdk.DataModel.Segments.getById({ segmentId: t.id });
                return !!(seg && evaluateSegmentInfo(seg, places, true));
            } catch (err) {
                return false;
            }
        });
        area.fix.counts = null;
        gapSignature = ''; // forces the scan to redraw its highlights from the segments as they are now
        scheduleGapScan(300);
        if (failedHard) areaFinishRun(run, 'error', run.stopReason);
        else if (run.stop) areaFinishRun(run, 'warn', 'Stopped by you.');
        else if (limitHit) areaFinishRun(run, 'warn', `Reached the limit of ${AREA.MAX_ROADS} segments for one run, so the rest are still flagged: run Fix flagged again.`);
        else areaFinishRun(run, run.needLook.length ? 'warn' : 'ok', 'Done.');
    }

    // ----- drawing the outline -----
    function areaStartDrawing() {
        if (area.phase === 'running' || area.phase === 'previewing') return;
        area.phase = 'drawing';
        areaDrawing = true;
        area.points = [];
        area.roads = [];
        area.run = null;
        area.nowIndex = -1;
        area.nowCoords = null;
        area.roadsDone = false;
        area.fix = { items: [], counts: null };
        area.lastClick = null;
        areaSetMessage('info', 'Click the corners of the area on the map. Double-click the last corner (or press Finish) to close the outline. Escape cancels.');
        drawAreaLayer();
        applyToggleState(); // hides the cursor ring and the hover tip's reasons while drawing
    }

    function areaFinishDrawing() {
        if (area.phase !== 'drawing') return;
        areaDrawing = false;
        if (area.points.length < 3) {
            area.phase = 'idle';
            areaSetMessage('warn', 'An outline needs at least 3 corners. Press Draw to try again.');
        } else {
            area.phase = 'ready';
            areaSetMessage('info', 'Outline closed. Press Preview to see which GIS roads it would import. Roads that cross the outline are imported whole, so draw it close to the edge you want.');
        }
        drawAreaLayer();
        applyToggleState();
    }

    function areaClear() {
        if (area.phase === 'running') return;
        areaDrawing = false;
        area.phase = 'idle';
        area.points = [];
        area.roads = [];
        area.run = null;
        area.source = null;
        area.nowIndex = -1;
        area.nowCoords = null;
        area.roadsDone = false;
        area.fix = { items: [], counts: null };
        area.message = { level: 'info', text: '' };
        drawAreaLayer();
        applyToggleState();
        renderAreaPanel();
    }

    mapDiv.addEventListener('click', (e) => {
        if (area.phase !== 'drawing') return;
        if (!e.isTrusted || typeof e.clientX !== 'number' || typeof e.clientY !== 'number') return;
        e.stopImmediatePropagation();
        e.stopPropagation();
        e.preventDefault();
        const now = Date.now();
        const last = area.lastClick;
        // the second click of a double-click lands on the same spot a moment after the first
        if (last && now - last.t < 450 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 8) return;
        area.lastClick = { t: now, x: e.clientX, y: e.clientY };
        const ll = sdk.Map.getLonLatFromPixel({ x: e.clientX, y: e.clientY });
        area.points.push([ll.lon, ll.lat]);
        drawAreaLayer();
        renderAreaPanel();
    }, true);

    mapDiv.addEventListener('dblclick', (e) => {
        if (area.phase !== 'drawing') return;
        e.stopImmediatePropagation();
        e.stopPropagation();
        e.preventDefault();
        areaFinishDrawing();
    }, true);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (area.phase === 'running' && area.run && !area.run.stop) {
                area.run.stop = true;
                areaSetMessage('info', 'Stopping after the road in progress...');
            } else if (area.phase === 'drawing') {
                areaClear();
            } else if (area.phase === 'previewing') {
                area.phase = 'ready';
            }
        } else if (e.key === 'Backspace' && area.phase === 'drawing' && !/^(input|textarea|select)$/i.test((document.activeElement && document.activeElement.tagName) || '')) {
            e.preventDefault();
            area.points.pop();
            drawAreaLayer();
            renderAreaPanel();
        }
    });

    // ----- the panel -----
    const areaPanel = document.createElement('div');
    areaPanel.id = 'wme-gis-importer-area-panel';
    areaPanel.style.cssText = 'position: fixed; z-index: 999998; width: 330px; max-height: 80vh; overflow-y: auto; display: none; box-sizing: border-box; padding: 8px 10px; ' +
        'background: #ffffff; border: 1px solid #dadce0; border-radius: 10px; box-shadow: 0 4px 16px rgba(0,0,0,0.35); font: 12px/1.4 sans-serif; color: #202124;';
    document.body.appendChild(areaPanel);

    function areaEl(tag, css, text) {
        const node = document.createElement(tag);
        if (css) node.style.cssText = css;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function areaButton(label, onClick, opts = {}) {
        const b = areaEl('button', '', label);
        b.type = 'button';
        b.disabled = !!opts.disabled;
        if (opts.title) b.title = opts.title;
        const colour = opts.danger ? '#d93025' : opts.primary ? COLOUR_ROADS : '#9aa0a6';
        b.style.cssText = `border: 1px solid ${colour}; background: ${opts.primary ? COLOUR_ROADS : opts.danger ? '#d93025' : '#ffffff'}; color: ${opts.primary || opts.danger ? '#ffffff' : '#3c4043'}; ` +
            `border-radius: 5px; padding: 4px 9px; font-size: 12px; font-weight: bold; cursor: ${opts.disabled ? 'default' : 'pointer'}; opacity: ${opts.disabled ? 0.45 : 1};`;
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!b.disabled) onClick();
        });
        return b;
    }

    function positionAreaPanel() {
        const open = !toolbarState.closed && !toolbarState.minimized;
        const r = container.getBoundingClientRect();
        let left = open ? r.left : 80;
        let top = open ? r.bottom + 8 : 80;
        left = Math.max(8, Math.min(left, window.innerWidth - 340));
        top = Math.max(8, Math.min(top, window.innerHeight - Math.min(areaPanel.offsetHeight || 200, window.innerHeight * 0.8) - 8));
        areaPanel.style.left = `${left}px`;
        areaPanel.style.top = `${top}px`;
    }

    function focusAreaRoad(entry) {
        if (!entry.at) return;
        (async () => {
            try {
                areaMoveTo(entry.at[0], entry.at[1]);
                await areaWaitForData();
                const hit = findExistingRoadAt({ lon: entry.at[0], lat: entry.at[1] }, 15);
                if (hit) sdk.Editing.setSelection({ selection: { objectType: 'segment', ids: [hit.segment.id] } });
            } catch (err) {
                console.warn(`[${SCRIPT_NAME}] Could not go to that road:`, err);
            }
        })();
    }

    function renderAreaPanel() {
        areaPanel.textContent = '';
        areaPanel.style.display = area.panelOpen ? 'block' : 'none';
        btnArea.style.borderColor = area.panelOpen ? COLOUR_ROADS : '#dadce0';
        btnArea.style.color = area.panelOpen ? COLOUR_ROADS : '#5f6368';
        if (!area.panelOpen) return;

        const head = areaEl('div', 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;');
        head.appendChild(areaEl('strong', 'font-size: 13px;', 'Area import'));
        const close = areaButton('×', () => {
            if (area.phase === 'running') area.panelOpen = false;
            else {
                area.panelOpen = false;
                areaClear();
            }
            renderAreaPanel();
        }, { title: area.phase === 'running' ? 'Hide this panel (the run continues; the Area button brings it back)' : 'Close and clear the outline' });
        close.style.padding = '0 7px';
        head.appendChild(close);
        areaPanel.appendChild(head);

        if (area.message.text) {
            const msg = areaEl('div', 'padding: 6px 8px; border-radius: 6px; margin-bottom: 8px; user-select: text;', area.message.text);
            paintStatus(msg, area.message.level);
            areaPanel.appendChild(msg);
        }

        if (area.phase === 'running' && area.run) {
            const run = area.run;
            const total = run.kind === 'roads' ? run.total : 0;
            const stopText = `Map stop ${run.stopAt || 0} of ${run.stops || '?'}.`;
            const line = run.kind === 'roads'
                ? `${run.done} of ${total} roads. ${run.created} imported, ${run.extended} extended, ${run.skipped} skipped, ${run.saves} saves.`
                : run.kind === 'fix'
                    ? `${stopText} ${run.done} flagged segments looked at, ${run.fixed} fixed, ${run.needLook.length} to review, ${run.saves} saves.`
                    : run.kind === 'check'
                        ? `${stopText} ${run.found} flagged so far.`
                        : `${stopText} ${run.done} roads checked, ${run.created} got numbers, ${run.saves} saves.`;
            const bar = areaEl('div', 'height: 8px; background: #e8eaed; border-radius: 4px; overflow: hidden; margin-bottom: 4px;');
            const frac = run.kind === 'roads' ? (total ? run.done / total : 0) : (run.stops ? (run.stopAt || 0) / run.stops : 0);
            bar.appendChild(areaEl('div', `height: 100%; width: ${Math.round(Math.min(1, frac) * 100)}%; background: ${COLOUR_ROADS};`));
            areaPanel.append(bar, areaEl('div', 'font-size: 11px; color: #5f6368; margin-bottom: 8px;', `${line}${run.paused ? ' PAUSED.' : ''}${run.stop ? ' Stopping...' : ''}`));
        }

        const phase = area.phase;
        const c = areaCounts();
        const rowOf = (label, buttons) => {
            const group = areaEl('div', 'margin-bottom: 6px;');
            if (label) group.appendChild(areaEl('div', 'font-size: 11px; font-weight: bold; color: #5f6368; margin-bottom: 3px;', label));
            const r = areaEl('div', 'display: flex; flex-wrap: wrap; gap: 6px;');
            r.append(...buttons);
            group.appendChild(r);
            areaPanel.appendChild(group);
        };
        if (phase === 'idle') {
            rowOf('', [areaButton('Draw outline', areaStartDrawing, { primary: true })]);
        } else if (phase === 'drawing') {
            rowOf('', [
                areaButton('Finish', areaFinishDrawing, { primary: true, disabled: area.points.length < 3 }),
                areaButton('Undo point', () => { area.points.pop(); drawAreaLayer(); renderAreaPanel(); }, { disabled: !area.points.length }),
                areaButton('Cancel', areaClear)
            ]);
        } else if (phase === 'previewing') {
            rowOf('', [areaButton('Cancel', () => { area.phase = 'ready'; renderAreaPanel(); })]);
        } else if (phase === 'ready' || phase === 'previewed' || phase === 'done') {
            const tooMany = c.todo > AREA.MAX_ROADS;
            const roadButtons = [areaButton(phase === 'ready' ? 'Preview roads' : 'Preview again', areaPreview, { primary: phase === 'ready' })];
            if (phase === 'previewed') {
                roadButtons.push(areaButton(`Go: import ${c.todo} roads`, areaRunRoads, { primary: true, disabled: !c.todo || tooMany, title: 'Imports one road at a time, saving every 25. Escape stops.' }));
            }
            rowOf('New roads', roadButtons);
            const flaggedCount = area.fix.counts ? ` (${area.fix.counts.total})` : '';
            rowOf('Existing segments', [
                areaButton('Check flagged', areaRunCheck, { title: 'Counts the segments in the outline that the scan flags (no name, no city, primary city outside the limits). Changes nothing.' }),
                areaButton(`Fix flagged${flaggedCount}`, areaRunFix, { primary: true, disabled: !!(area.fix.counts && !area.fix.counts.total), title: 'Fills in missing street names and cities, corrects primary cities (outside every limit it clears the primary and uses the postal city as the alternate) and renames a street to the GIS name when it differs. Saves every 25.' }),
                areaButton('House numbers', areaRunHouses, { disabled: !!(area.source && !area.source.houseNumbers), title: 'Adds the missing house numbers to the roads inside the outline (roads must be saved first).' })
            ]);
            rowOf('', [areaButton('Redraw', areaStartDrawing), areaButton('Clear', areaClear)]);
        } else if (phase === 'running' && area.run) {
            rowOf('', [
                areaButton(area.run.paused ? 'Resume' : 'Pause', () => { area.run.paused = !area.run.paused; renderAreaPanel(); }, { primary: true, disabled: area.run.stop }),
                areaButton('Stop', () => { area.run.stop = true; renderAreaPanel(); }, { danger: true, disabled: area.run.stop, title: 'Finishes the item in progress, then stops (Escape does the same). Nothing is saved on stop.' })
            ]);
        }

        if (phase === 'previewed') {
            const legend = areaEl('div', 'font-size: 11px; color: #5f6368; line-height: 1.6;');
            [['new', 'new road'], ['extend', 'extends a stub'], ['mapped', 'already in WME'], ['unchecked', 'not compared yet']].forEach(([k, label]) => {
                const chip = areaEl('span', `display: inline-block; width: 16px; height: 5px; border-radius: 3px; margin: 0 4px 1px 0; vertical-align: middle; background: ${AREA_COLOURS[k]};`);
                const item = areaEl('span', 'margin-right: 10px; white-space: nowrap;');
                item.append(chip, document.createTextNode(label));
                legend.appendChild(item);
            });
            areaPanel.appendChild(legend);
        }

        const look = area.run ? area.run.needLook : [];
        if (look.length) {
            areaPanel.appendChild(areaEl('div', 'font-weight: bold; font-size: 11px; color: #5f6368; margin: 8px 0 3px;', `Needs a look (${look.length}). Click one to go there.`));
            const list = areaEl('div', 'max-height: 220px; overflow-y: auto; border: 1px solid #e8eaed; border-radius: 6px;');
            look.slice(-AREA.MAX_LIST).forEach((entry) => {
                const rowEl = areaEl('div', 'padding: 4px 6px; border-bottom: 1px solid #f1f3f4; cursor: pointer; font-size: 11px; line-height: 1.35;', `${entry.name}: ${entry.message}`);
                paintStatus(rowEl, entry.level);
                rowEl.addEventListener('click', () => focusAreaRoad(entry));
                list.appendChild(rowEl);
            });
            areaPanel.appendChild(list);
        }
        positionAreaPanel();
    }

    btnArea.addEventListener('click', () => {
        if (area.panelOpen && area.phase !== 'idle') {
            area.panelOpen = false; // second click hides the panel; the outline stays
            renderAreaPanel();
            return;
        }
        area.panelOpen = true;
        if (area.phase === 'idle') areaStartDrawing();
        renderAreaPanel();
    });
    renderAreaPanel();


    // Start downloading the city limits now so the first import doesn't wait for them.
    loadCityBoundaries()
        .then((places) => {
            setStatus(`Ready. City limits loaded (${places.length} places).`, 'ok');
            const problem = inKendallView() ? '' : gislProblem();
            if (problem) setStatus(problem, 'warn');
        })
        .catch((err) => {
            console.warn(`[${SCRIPT_NAME}] Could not load city limits yet (will retry on import):`, err);
            setStatus('Ready. City limits could not be loaded yet; will retry on import.', 'warn');
        });

    // ------------------------------------------------------------------
    // Missing roads: GIS roads in the current view that WME doesn't have, ranked by GPS evidence,
    // with a review queue (snooze / ignore forever) that is remembered in this browser.
    // ------------------------------------------------------------------
    const MISSING = {
        LAYER: 'wme-segment-importer-missing-roads',
        STORAGE_MARKS: 'wme_gis_importer_missing_marks_v1',
        STORAGE_UI: 'wme_gis_importer_missing_ui_v1',
        MIN_ZOOM: 16,           // below this WME may not have every segment in view loaded
        STEP_M: 3,              // spacing of the sample points along a GIS road
        WME_TOLERANCE_M: 20,    // a WME segment this close and running the same way counts as "mapped"
        MIN_STRETCH_M: 30,      // shorter unmapped stretches are ignored (ends at junctions, small offsets)
        GPS_RADIUS_M: 8,        // a GPS dot this close to the GIS line counts (GIS lines can sit a few meters off)
        GPS_ZOOM: 16,           // tile zoom read for GPS dots (512 px tiles, about 1 m per pixel)
        GPS_TILE: 512,
        MAX_GPS_TILES: 300,     // more than this and the view is too big to check GPS
        GPS_LIKELY: 50,         // GPS on this % or more of the missing part = likely built
        GPS_CHECK: 10           // 10-49 % = check it; under 10 % = probably not built yet
    };
    const COLOUR_MISSING = COLOUR_ROADS;

    let missingMarks = {};
    try {
        missingMarks = JSON.parse(localStorage.getItem(MISSING.STORAGE_MARKS)) || {};
    } catch (e) {
        missingMarks = {};
    }
    function saveMissingMarks() {
        try {
            localStorage.setItem(MISSING.STORAGE_MARKS, JSON.stringify(missingMarks));
        } catch (e) { /* storage unavailable */ }
    }

    let missingUi = { left: null, top: null, open: false, minimized: false, showHidden: false, showOnMap: true };
    try {
        missingUi = { ...missingUi, ...(JSON.parse(localStorage.getItem(MISSING.STORAGE_UI)) || {}) };
    } catch (e) { /* use defaults */ }
    function saveMissingUi() {
        try {
            localStorage.setItem(MISSING.STORAGE_UI, JSON.stringify(missingUi));
        } catch (e) { /* storage unavailable */ }
    }

    let missingCandidates = [];
    let missingSelectedKey = null;
    let missingScanBusy = false;

    // --- reading the GIS record -------------------------------------------------
    const toMillis = (v) => {
        if (typeof v === 'number' && v > 1e11) return v;
        if (typeof v === 'string' && v.trim()) {
            const t = Date.parse(v);
            return Number.isNaN(t) ? null : t;
        }
        return null;
    };
    const isoDay = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');

    // When the county last edited this road (used to wake a snoozed road up again).
    function gisEditedMillis(p) {
        for (const field of ['last_edited_date', 'DateUpdate', 'EDIT_DATE', 'LAST_EDIT', 'LastUpdate', 'created_date']) {
            const ms = toMillis(p[field]);
            if (ms) return ms;
        }
        return null;
    }

    // Short notes from the county record that help decide whether the road is real.
    function gisNotes(p) {
        const notes = [];
        for (const field of ['Comment', 'COMMENT', 'gcNotes', 'gcReview', 'Surface_co', 'PUBLIC_PRI']) {
            const v = p[field];
            if (v !== null && v !== undefined && String(v).trim()) notes.push(`${field}: ${String(v).trim()}`);
        }
        const created = toMillis(p.created_date);
        if (created) notes.push(`created ${isoDay(created)}`);
        return notes;
    }

    // --- GPS dots from WME's own GPS points tiles ---------------------------------
    // The GPS layer is a plain image tile layer on WME's own server. Its address is read from the layer
    // (non-SDK, read-only); if that fails, the address seen in testing is used.
    function gpsTileTemplate() {
        try {
            const W = pageWin.W;
            const olMap = W && W.map && (W.map.olMap || (typeof W.map.getOLMap === 'function' && W.map.getOLMap()));
            const layer = olMap && olMap.layers && olMap.layers.find((l) => l.name === 'gps_points');
            const tmpl = layer && (Array.isArray(layer.url) ? layer.url[0] : layer.url);
            if (typeof tmpl === 'string' && tmpl.includes('${z}')) return tmpl;
        } catch (e) { /* fall back below */ }
        return location.origin + '/na-tiles/editor/gps/${z}/${x}/${y}/tile.png';
    }

    const gpsTileData = new Map();     // "x/y" -> pixel data (or null if the tile could not be read)
    const gpsTilePending = new Map();  // "x/y" -> promise

    function loadGpsTile(tx, ty, template) {
        const key = `${tx}/${ty}`;
        if (gpsTileData.has(key)) return Promise.resolve(gpsTileData.get(key));
        if (gpsTilePending.has(key)) return gpsTilePending.get(key);
        const url = template.replace('${z}', String(MISSING.GPS_ZOOM)).replace('${x}', String(tx)).replace('${y}', String(ty));
        const T = MISSING.GPS_TILE;
        const promise = (async () => {
            let data = null;
            try {
                const response = await fetch(url, { credentials: 'include' });
                if (response.ok) {
                    const bitmap = await createImageBitmap(await response.blob());
                    let canvas;
                    if (typeof OffscreenCanvas !== 'undefined') {
                        canvas = new OffscreenCanvas(T, T);
                    } else {
                        canvas = document.createElement('canvas');
                        canvas.width = T;
                        canvas.height = T;
                    }
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(bitmap, 0, 0, T, T);
                    data = ctx.getImageData(0, 0, T, T).data;
                }
            } catch (err) {
                console.warn(`[${SCRIPT_NAME}] GPS tile ${key} could not be read:`, err);
            }
            if (gpsTileData.size > 1500) gpsTileData.clear(); // keep memory in check on long sessions
            gpsTileData.set(key, data);
            gpsTilePending.delete(key);
            return data;
        })();
        gpsTilePending.set(key, promise);
        return promise;
    }

    // Marks every sample of every stretch with gps: true/false. Returns false if GPS could not be checked.
    async function addGpsEvidence(candidates) {
        const Z = MISSING.GPS_ZOOM;
        const T = MISSING.GPS_TILE;
        const N = 2 ** Z * T;
        const all = [];
        candidates.forEach((c) => c.stretches.forEach((s) => all.push(...s.samples)));
        if (!all.length) return true;

        const pxPerM = N / (40075016.686 * Math.cos(all[0].lat * RAD));
        const R = Math.max(1, Math.round(MISSING.GPS_RADIUS_M * pxPerM));
        const need = new Set();
        for (const s of all) {
            const sin = Math.sin(s.lat * RAD);
            s.px = ((s.lon + 180) / 360) * N;
            s.py = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * N;
            for (const dx of [-R, R]) {
                for (const dy of [-R, R]) need.add(`${Math.floor((s.px + dx) / T)}/${Math.floor((s.py + dy) / T)}`);
            }
        }
        if (need.size > MISSING.MAX_GPS_TILES) return false;

        const template = gpsTileTemplate();
        await Promise.all([...need].map((key) => {
            const [tx, ty] = key.split('/').map(Number);
            return loadGpsTile(tx, ty, template);
        }));

        let anyTile = false;
        const alphaAt = (px, py) => {
            const tx = Math.floor(px / T);
            const ty = Math.floor(py / T);
            const d = gpsTileData.get(`${tx}/${ty}`);
            if (!d) return 0;
            anyTile = true;
            return d[((Math.floor(py) - ty * T) * T + (Math.floor(px) - tx * T)) * 4 + 3];
        };
        for (const s of all) {
            s.gps = false;
            for (let dx = -R; dx <= R && !s.gps; dx++) {
                for (let dy = -R; dy <= R; dy++) {
                    if (dx * dx + dy * dy <= R * R && alphaAt(s.px + dx, s.py + dy) >= 128) {
                        s.gps = true;
                        break;
                    }
                }
            }
        }
        return anyTile;
    }

    // --- scanning ---------------------------------------------------------------------
    async function scanMissingRoads() {
        if (missingScanBusy) return;
        const zoom = sdk.Map.getZoomLevel();
        if (zoom < MISSING.MIN_ZOOM) {
            setMissingStatus(`Zoom in to ${MISSING.MIN_ZOOM} or closer (now ${zoom}) so WME loads every road in view, then scan.`, 'warn');
            return;
        }
        const [minLon, minLat, maxLon, maxLat] = sdk.Map.getMapExtent();
        const center = { lon: (minLon + maxLon) / 2, lat: (minLat + maxLat) / 2 };
        let source = null;
        try {
            source = await resolveSource(center);
        } catch (err) {
            setMissingStatus(`Could not work out which GIS layers cover this view: ${err.message || err}`, 'error');
            return;
        }
        if (!source) {
            setMissingStatus(noSourceMessage(), 'warn');
            return;
        }

        missingScanBusy = true;
        missingPanel.scanBtn.disabled = true;
        setMissingStatus(`Scanning ${source.label} roads in view...`, 'info');
        try {
            const data = await source.query({ minLon, minLat, maxLon, maxLat });
            if (data.error) throw new Error(data.error.message || 'GIS query error');
            const features = data.features || [];

            const origin = [center.lon, center.lat];
            const project = makeProjector(origin);
            const mx = 111320 * Math.cos(origin[1] * RAD);
            const my = 110540;
            const toLonLat = (x, y) => [origin[0] + x / mx, origin[1] + y / my];
            const inView = (lon, lat) => lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
            const tol = MISSING.WME_TOLERANCE_M;

            // WME road segments loaded around the view (unsaved ones included, so a road you just drew counts)
            const segs = [];
            for (const segment of sdk.DataModel.Segments.getAll()) {
                if (!isLiveSegment(segment) || OVERLAP_IGNORED_ROAD_TYPES.has(segment.roadType)) continue;
                const xy = segment.geometry.coordinates.map(project);
                const xs = xy.map((c) => c[0]);
                const ys = xy.map((c) => c[1]);
                segs.push({ xy, minX: Math.min(...xs) - tol, maxX: Math.max(...xs) + tol, minY: Math.min(...ys) - tol, maxY: Math.max(...ys) + tol });
            }
            const alongWme = (x, y, ang) => {
                for (const s of segs) {
                    if (x < s.minX || x > s.maxX || y < s.minY || y > s.maxY) continue;
                    for (let i = 0; i < s.xy.length - 1; i++) {
                        const [ax, ay] = s.xy[i];
                        const [bx, by] = s.xy[i + 1];
                        const dx = bx - ax;
                        const dy = by - ay;
                        const len2 = dx * dx + dy * dy;
                        const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
                        if (Math.hypot(ax + t * dx - x, ay + t * dy - y) > tol) continue;
                        let da = Math.abs(ang - Math.atan2(dy, dx)) % Math.PI;
                        da = Math.min(da, Math.PI - da);
                        if (da <= OVERLAP_PARALLEL_RAD) return true;
                    }
                }
                return false;
            };

            // Only the part of each GIS road inside the view is judged: beyond it, WME's segments may not be loaded.
            const found = [];
            for (const feature of features) {
                const p = feature.properties || {};
                const stretches = [];
                let inViewSamples = 0;
                let coveredSamples = 0;
                for (const part of linePartsOf(feature)) {
                    if (part.length < 2) continue;
                    let run = null;
                    const flush = () => {
                        if (run && run.samples.length * MISSING.STEP_M >= MISSING.MIN_STRETCH_M) stretches.push(run);
                        run = null;
                    };
                    for (const s of xyResample(part.map(project), MISSING.STEP_M)) {
                        const [lon, lat] = toLonLat(s.x, s.y);
                        if (!inView(lon, lat)) {
                            flush();
                            continue;
                        }
                        inViewSamples++;
                        if (alongWme(s.x, s.y, s.ang)) {
                            coveredSamples++;
                            flush();
                            continue;
                        }
                        if (!run) run = { samples: [] };
                        run.samples.push({ lon, lat });
                    }
                    flush();
                }
                if (!stretches.length) continue;
                const nameInfo = buildStreetName(source.nameParts(p));
                found.push({
                    key: `${source.key}:${feature.id}`,
                    featureId: feature.id,
                    sourceLabel: source.label,
                    name: nameInfo.name || '(no name)',
                    stretches,
                    inViewM: inViewSamples * MISSING.STEP_M,
                    mappedPct: inViewSamples ? Math.round((100 * coveredSamples) / inViewSamples) : 0,
                    missingM: stretches.reduce((sum, s) => sum + s.samples.length * MISSING.STEP_M, 0),
                    editedMs: gisEditedMillis(p),
                    notes: gisNotes(p)
                });
            }

            const gpsChecked = await addGpsEvidence(found);
            for (const c of found) {
                c.gpsChecked = gpsChecked;
                const samples = c.stretches.flatMap((s) => s.samples);
                c.gpsPct = gpsChecked ? Math.round((100 * samples.filter((s) => s.gps).length) / samples.length) : null;
            }

            missingCandidates = found;
            if (!found.some((c) => c.key === missingSelectedKey)) missingSelectedKey = null;
            const open = visibleMissing().length;
            const hidden = found.length - open;
            const gpsNote = gpsChecked ? '' : ' GPS could not be checked (view too large, or the GPS tiles could not be read); zoom in and scan again.';
            setMissingStatus(found.length
                ? `${open} road(s) with unmapped stretches in view${hidden ? `, plus ${hidden} snoozed or ignored` : ''}.${gpsNote}`
                : `No missing roads in view: every ${source.label} GIS road here is mapped.`, gpsChecked ? 'ok' : 'warn');
            console.log(`[${SCRIPT_NAME}] Missing roads scan: ${features.length} GIS roads, ${segs.length} WME segments, ${found.length} with unmapped stretches.`);
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Missing roads scan failed:`, err);
            setMissingStatus(`Scan failed: ${err.message || err}`, 'error');
        } finally {
            missingScanBusy = false;
            missingPanel.scanBtn.disabled = false;
            renderMissing();
        }
    }

    // --- review marks -----------------------------------------------------------------
    // Snoozed roads come back by themselves when the county edits the road after the snooze.
    function markOf(c) {
        const mark = missingMarks[c.key];
        if (!mark) return null;
        if (mark.status === 'snoozed' && c.editedMs && mark.editedMs && c.editedMs > mark.editedMs) return null;
        return mark;
    }
    function wokeUp(c) {
        const mark = missingMarks[c.key];
        return !!(mark && mark.status === 'snoozed' && !markOf(c));
    }

    function gpsTier(c) {
        if (c.gpsPct === null) return { label: 'GPS ?', colour: '#5f6368', background: '#f1f3f4' };
        if (c.gpsPct >= MISSING.GPS_LIKELY) return { label: 'Likely built', colour: '#0d652d', background: '#e6f4ea' };
        if (c.gpsPct >= MISSING.GPS_CHECK) return { label: 'Check', colour: '#9a5200', background: '#fff3e0' };
        return { label: 'Not built?', colour: '#5f6368', background: '#f1f3f4' };
    }

    function visibleMissing() {
        return missingCandidates
            .filter((c) => missingUi.showHidden || !markOf(c))
            .sort((a, b) => ((b.gpsPct ?? -1) - (a.gpsPct ?? -1)) || (b.missingM - a.missingM));
    }

    function setMark(c, status) {
        if (status) {
            missingMarks[c.key] = { status, at: new Date().toISOString(), editedMs: c.editedMs || null, name: c.name };
        } else {
            delete missingMarks[c.key];
        }
        saveMissingMarks();
    }

    // --- map layer (SDK) ------------------------------------------------------------------
    let missingLayerReady = false;
    function ensureMissingLayer() {
        if (missingLayerReady) return true;
        try {
            sdk.Map.addLayer({
                layerName: MISSING.LAYER,
                styleRules: [
                    { predicate: (p) => p.kind === 'halo', style: { strokeColor: '#ffd400', strokeWidth: 16, strokeOpacity: 0.6, strokeLinecap: 'round' } },
                    { predicate: (p) => p.kind === 'gps', style: { strokeColor: COLOUR_MISSING, strokeWidth: 6, strokeOpacity: 0.95, strokeLinecap: 'round' } },
                    { predicate: (p) => p.kind === 'nogps', style: { strokeColor: COLOUR_MISSING, strokeWidth: 4, strokeOpacity: 0.6, strokeDashstyle: 'dash', strokeLinecap: 'round' } }
                ]
            });
            missingLayerReady = true;
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Could not add the missing roads layer:`, err);
        }
        try {
            sdk.Events.trackLayerEvents({ layerName: MISSING.LAYER });
            sdk.Events.on({
                eventName: 'wme-layer-feature-clicked',
                eventHandler: (e) => {
                    if (!e || e.layerName !== MISSING.LAYER) return;
                    const key = String(e.featureId).split('#')[0];
                    if (missingCandidates.some((c) => c.key === key)) selectMissing(key, false);
                }
            });
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Clicking a highlighted road on the map will not select it:`, err);
        }
        return missingLayerReady;
    }

    // Each unmapped stretch is drawn in pieces: solid where GPS shows traffic, dashed where it doesn't.
    function drawMissingLayer() {
        if (!ensureMissingLayer()) return;
        try {
            sdk.Map.removeAllFeaturesFromLayer({ layerName: MISSING.LAYER });
        } catch (err) { /* layer empty */ }
        if (!missingUi.open || !missingUi.showOnMap) return;

        const features = [];
        const line = (id, coords, kind) => features.push({
            type: 'Feature', id, geometry: { type: 'LineString', coordinates: coords }, properties: { kind }
        });
        const list = visibleMissing();
        const selected = list.find((c) => c.key === missingSelectedKey);
        if (selected) {
            selected.stretches.forEach((s, i) => {
                if (s.samples.length > 1) line(`${selected.key}#halo${i}`, s.samples.map((p) => [p.lon, p.lat]), 'halo');
            });
        }
        for (const c of list) {
            c.stretches.forEach((s, i) => {
                let piece = [];
                let pieceGps = null;
                let n = 0;
                const finish = () => {
                    if (piece.length > 1) line(`${c.key}#${i}-${n++}`, piece, pieceGps ? 'gps' : 'nogps');
                };
                for (const p of s.samples) {
                    const gps = !!p.gps;
                    if (pieceGps !== null && gps !== pieceGps) {
                        piece.push([p.lon, p.lat]); // overlap one point so the pieces touch
                        finish();
                        piece = [];
                    }
                    pieceGps = gps;
                    piece.push([p.lon, p.lat]);
                }
                finish();
            });
        }
        if (!features.length) return;
        try {
            sdk.Map.addFeaturesToLayer({ layerName: MISSING.LAYER, features });
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Could not draw missing roads:`, err);
        }
    }

    function centerOnCandidate(c) {
        const pts = c.stretches.flatMap((s) => s.samples);
        if (!pts.length) return;
        const lons = pts.map((p) => p.lon);
        const lats = pts.map((p) => p.lat);
        const box = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
        const [minLon, minLat, maxLon, maxLat] = sdk.Map.getMapExtent();
        const fits = (box[2] - box[0]) < (maxLon - minLon) * 0.9 && (box[3] - box[1]) < (maxLat - minLat) * 0.9;
        try {
            if (fits && typeof sdk.Map.setMapCenter === 'function') {
                sdk.Map.setMapCenter({ lonLat: { lon: (box[0] + box[2]) / 2, lat: (box[1] + box[3]) / 2 } });
            } else {
                sdk.Map.zoomToExtent({ bbox: box });
            }
        } catch (err) {
            try {
                sdk.Map.zoomToExtent({ bbox: box });
            } catch (err2) {
                console.warn(`[${SCRIPT_NAME}] Could not move the map to the road:`, err2);
            }
        }
    }

    function selectMissing(key, moveMap = true) {
        missingSelectedKey = key;
        const c = missingCandidates.find((x) => x.key === key);
        if (c && moveMap) centerOnCandidate(c);
        renderMissing();
    }

    function stepMissing(delta) {
        const list = visibleMissing();
        if (!list.length) return;
        const i = list.findIndex((c) => c.key === missingSelectedKey);
        const next = i < 0 ? (delta > 0 ? 0 : list.length - 1) : (i + delta + list.length) % list.length;
        selectMissing(list[next].key);
    }

    // --- panel ------------------------------------------------------------------------
    const missingPanel = (() => {
        const el = (tag, css, text) => {
            const node = document.createElement(tag);
            if (css) node.style.cssText = css;
            if (text !== undefined) node.textContent = text;
            return node;
        };
        const smallBtn = 'border: 1px solid #dadce0; background: #ffffff; color: #202124; border-radius: 5px; padding: 3px 8px; font-size: 12px; cursor: pointer;';

        const panel = el('div', `position: fixed; z-index: 999997; width: 340px; max-height: 70vh; display: none; flex-direction: column;
            background: #ffffff; border: 1px solid #dadce0; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.35);
            font-family: sans-serif; font-size: 12px; color: #202124;`);
        const header = el('div', `display: flex; align-items: center; gap: 6px; padding: 8px 10px; cursor: move; user-select: none;
            border-bottom: 3px solid ${COLOUR_MISSING}; border-radius: 8px 8px 0 0;`);
        header.appendChild(el('span', 'font-weight: bold; font-size: 13px; flex: 1;', '🔎 Missing roads'));
        const scanBtn = el('button', `${smallBtn} background: ${COLOUR_MISSING}; color: #ffffff; border-color: ${COLOUR_MISSING}; font-weight: bold;`, 'Scan view');
        scanBtn.title = 'Find GIS roads in the current view that WME does not have';
        const minBtn = el('button', smallBtn, '–');
        minBtn.title = 'Shrink to an icon (click the icon to bring it back)';
        const closeBtn = el('button', smallBtn, '×');
        closeBtn.title = 'Close and clear the map highlights (reopen from the importer panel)';
        header.append(scanBtn, minBtn, closeBtn);
        panel.appendChild(header);

        const body = el('div', 'display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; overflow: hidden; min-height: 0;');
        const status = el('div', 'font-size: 11px; line-height: 1.3; padding: 4px 6px; border-radius: 3px; user-select: text;', 'Zoom to an area and press Scan view.');
        body.appendChild(status);

        const options = el('div', 'display: flex; gap: 12px; font-size: 11px; color: #5f6368;');
        const makeCheck = (label, checked, onChange) => {
            const wrapLabel = el('label', 'display: flex; align-items: center; gap: 4px; cursor: pointer;');
            const box = el('input');
            box.type = 'checkbox';
            box.checked = checked;
            box.addEventListener('change', () => onChange(box.checked));
            wrapLabel.append(box, document.createTextNode(label));
            options.appendChild(wrapLabel);
            return box;
        };
        const mapCheck = makeCheck('Show on map', missingUi.showOnMap, (v) => {
            missingUi.showOnMap = v;
            saveMissingUi();
            drawMissingLayer();
        });
        const hiddenCheck = makeCheck('Show snoozed / ignored', missingUi.showHidden, (v) => {
            missingUi.showHidden = v;
            saveMissingUi();
            renderMissing();
        });
        body.appendChild(options);

        const listBox = el('div', 'overflow-y: auto; border: 1px solid #dadce0; border-radius: 6px; min-height: 40px; max-height: 32vh;');
        body.appendChild(listBox);

        const nav = el('div', 'display: flex; align-items: center; gap: 6px;');
        const prevBtn = el('button', smallBtn, '◀ Prev');
        const counter = el('span', 'flex: 1; text-align: center; color: #5f6368;', '');
        const nextBtn = el('button', smallBtn, 'Next ▶');
        nav.append(prevBtn, counter, nextBtn);
        body.appendChild(nav);

        const detail = el('div', 'display: none; flex-direction: column; gap: 6px; padding: 8px; border-radius: 6px; background: #f8f9fa; border: 1px solid #dadce0;');
        const detailText = el('div', 'line-height: 1.4; user-select: text;');
        const actions = el('div', 'display: flex; gap: 6px; flex-wrap: wrap;');
        const snoozeBtn = el('button', smallBtn, '💤 Not built yet');
        snoozeBtn.title = 'Snooze: hidden until you restore it, or until the county edits this road';
        const ignoreBtn = el('button', smallBtn, '🚫 Ignore forever');
        ignoreBtn.title = 'Never show this road again (restore it from "Show snoozed / ignored")';
        const restoreBtn = el('button', smallBtn, '↩ Restore');
        restoreBtn.title = 'Put it back in the queue';
        actions.append(snoozeBtn, ignoreBtn, restoreBtn);
        detail.append(detailText, actions);
        body.appendChild(detail);

        body.appendChild(el('div', 'font-size: 10px; color: #5f6368; line-height: 1.3;',
            'Solid line: unmapped, GPS shows traffic. Dashed: unmapped, no GPS. Yellow glow: the selected road. Once you map a road, Scan view again and it drops off.'));
        panel.appendChild(body);

        // The shrunken icon: a round button with the number of roads waiting for review.
        const icon = el('button', `position: fixed; z-index: 999997; display: none; width: 40px; height: 40px; border-radius: 50%;
            border: 3px solid ${COLOUR_MISSING}; background: #ffffff; box-shadow: 0 2px 8px rgba(0,0,0,0.35);
            cursor: pointer; font-size: 18px; line-height: 1; padding: 0;`, '🔎');
        icon.title = 'Missing roads (click to open, drag to move)';
        const badge = el('span', `position: absolute; right: -6px; top: -6px; min-width: 18px; height: 18px; padding: 0 4px; box-sizing: border-box;
            border-radius: 9px; background: ${COLOUR_MISSING}; color: #ffffff; font-size: 11px; font-weight: bold; line-height: 18px; display: none;`);
        icon.appendChild(badge);

        document.body.append(panel, icon);

        // Panel and icon share one remembered position. A drag of a few pixels moves them; a plain click on the icon opens it.
        const place = () => {
            const left = missingUi.left ?? Math.max(10, window.innerWidth - 380);
            const top = missingUi.top ?? 120;
            panel.style.left = `${left}px`;
            panel.style.top = `${top}px`;
            icon.style.left = `${left}px`;
            icon.style.top = `${top}px`;
        };
        const makeDraggable = (handle, onClick) => {
            handle.addEventListener('mousedown', (e) => {
                if (handle !== icon && e.target.tagName === 'BUTTON') return;
                const startX = e.clientX;
                const startY = e.clientY;
                const left0 = parseInt(panel.style.left, 10);
                const top0 = parseInt(panel.style.top, 10);
                let moved = false;
                const move = (ev) => {
                    if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
                    moved = true;
                    missingUi.left = Math.max(0, Math.min(window.innerWidth - 40, left0 + ev.clientX - startX));
                    missingUi.top = Math.max(0, Math.min(window.innerHeight - 40, top0 + ev.clientY - startY));
                    place();
                };
                const up = () => {
                    document.removeEventListener('mousemove', move);
                    document.removeEventListener('mouseup', up);
                    if (moved) saveMissingUi();
                    else if (onClick) onClick();
                };
                document.addEventListener('mousemove', move);
                document.addEventListener('mouseup', up);
                e.preventDefault();
            });
        };
        makeDraggable(header, null);
        makeDraggable(icon, () => setMissingPanel(true, false));

        scanBtn.addEventListener('click', () => scanMissingRoads());
        minBtn.addEventListener('click', () => setMissingPanel(true, true));
        closeBtn.addEventListener('click', () => setMissingPanel(false, false));
        prevBtn.addEventListener('click', () => stepMissing(-1));
        nextBtn.addEventListener('click', () => stepMissing(1));

        const actOnSelected = (status) => {
            const c = missingCandidates.find((x) => x.key === missingSelectedKey);
            if (!c) return;
            const list = visibleMissing();
            const i = list.findIndex((x) => x.key === c.key);
            setMark(c, status);
            const after = visibleMissing();
            if (status && !missingUi.showHidden) {
                // move on to the next road in the queue
                const next = after[Math.min(i, after.length - 1)];
                missingSelectedKey = next ? next.key : null;
                if (next) centerOnCandidate(next);
            }
            setMissingStatus(status === 'snoozed' ? `Snoozed ${c.name}.` : status === 'ignored' ? `${c.name} will not be shown again.` : `${c.name} is back in the queue.`, 'ok');
            renderMissing();
        };
        snoozeBtn.addEventListener('click', () => actOnSelected('snoozed'));
        ignoreBtn.addEventListener('click', () => actOnSelected('ignored'));
        restoreBtn.addEventListener('click', () => actOnSelected(null));

        place();
        return { panel, icon, badge, status, listBox, counter, detail, detailText, snoozeBtn, ignoreBtn, restoreBtn, scanBtn, mapCheck, hiddenCheck };
    })();

    function setMissingStatus(message, level) {
        missingPanel.status.textContent = message;
        paintStatus(missingPanel.status, level);
    }

    function setMissingPanel(open, minimized) {
        missingUi.open = open;
        missingUi.minimized = minimized;
        saveMissingUi();
        missingPanel.panel.style.display = open && !minimized ? 'flex' : 'none';
        paintToggleButton(btnMissing, open, COLOUR_ROADS);
        missingPanel.icon.style.display = open && minimized ? 'block' : 'none';
        drawMissingLayer();
        scheduleGapScan();
    }

    function renderMissing() {
        const p = missingPanel;
        const list = visibleMissing();
        const waiting = missingCandidates.filter((c) => !markOf(c)).length;
        p.badge.textContent = String(waiting);
        p.badge.style.display = waiting ? 'block' : 'none';

        p.listBox.textContent = '';
        if (!list.length) {
            const empty = document.createElement('div');
            empty.style.cssText = 'padding: 8px; color: #5f6368;';
            empty.textContent = missingCandidates.length ? 'Nothing left to review in this view.' : 'No scan yet.';
            p.listBox.appendChild(empty);
        }
        const table = document.createElement('table');
        table.style.cssText = 'width: 100%; border-collapse: collapse; font-size: 12px;';
        list.forEach((c) => {
            const tier = gpsTier(c);
            const mark = markOf(c);
            const tr = document.createElement('tr');
            const selected = c.key === missingSelectedKey;
            tr.style.cssText = `cursor: pointer; border-bottom: 1px solid #f1f3f4; ${selected ? 'background: #fff8c5; font-weight: bold;' : ''}${mark ? ' opacity: 0.55;' : ''}`;
            const td = (text, css) => {
                const cell = document.createElement('td');
                cell.style.cssText = `padding: 5px 6px; ${css || ''}`;
                cell.textContent = text;
                tr.appendChild(cell);
                return cell;
            };
            td(`${mark ? (mark.status === 'ignored' ? '🚫 ' : '💤 ') : wokeUp(c) ? '⏰ ' : ''}${c.name}`, 'max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;').title = c.name;
            td(`${c.missingM} m`, 'text-align: right; white-space: nowrap; color: #5f6368;');
            const gpsCell = td(c.gpsPct === null ? '?' : `${c.gpsPct}%`, 'text-align: right; white-space: nowrap;');
            gpsCell.title = 'Share of the unmapped part with GPS dots on it';
            const tierCell = td('', 'white-space: nowrap;');
            const chip = document.createElement('span');
            chip.textContent = tier.label;
            chip.style.cssText = `padding: 1px 6px; border-radius: 8px; font-size: 10px; color: ${tier.colour}; background: ${tier.background};`;
            tierCell.appendChild(chip);
            tr.addEventListener('click', () => selectMissing(c.key));
            table.appendChild(tr);
        });
        if (list.length) p.listBox.appendChild(table);

        const i = list.findIndex((c) => c.key === missingSelectedKey);
        p.counter.textContent = list.length ? `${i >= 0 ? i + 1 : '–'} of ${list.length}` : '';

        const c = i >= 0 ? list[i] : null;
        p.detail.style.display = c ? 'flex' : 'none';
        if (c) {
            const mark = markOf(c);
            const lines = [
                `${c.name} (${c.sourceLabel})`,
                `Unmapped in view: ${c.missingM} m in ${c.stretches.length} stretch(es); ${c.mappedPct}% of the ${c.inViewM} m in view is mapped.`,
                c.gpsPct === null ? 'GPS: not checked.' : `GPS dots on ${c.gpsPct}% of the unmapped part.`,
                c.editedMs ? `County last edited this road ${isoDay(c.editedMs)}.` : '',
                c.notes.length ? c.notes.join(' · ') : '',
                mark ? `${mark.status === 'ignored' ? 'Ignored' : 'Snoozed'} ${mark.at.slice(0, 10)}.` : '',
                wokeUp(c) ? 'You snoozed this road, but the county has edited it since, so it is back.' : ''
            ].filter(Boolean);
            p.detailText.textContent = lines.join('\n');
            p.detailText.style.whiteSpace = 'pre-line';
            p.snoozeBtn.style.display = mark ? 'none' : '';
            p.ignoreBtn.style.display = mark ? 'none' : '';
            p.restoreBtn.style.display = mark ? '' : 'none';
            // keep the selected row in sight
            const row = p.listBox.querySelectorAll('tr')[i];
            if (row) row.scrollIntoView({ block: 'nearest' });
        }
        drawMissingLayer();
    }

    // The 🔎 button on the toolbar opens the missing roads panel.
    btnMissing.addEventListener('click', () => setMissingPanel(!(missingUi.open && !missingUi.minimized), false));

    setMissingPanel(missingUi.open, missingUi.minimized);
    renderMissing();

    // ------------------------------------------------------------------
    // Segments that need info: no street name, no city (primary or alternate), or a primary city that does not fit the limits
    // ------------------------------------------------------------------
    // Checked while Roads, Snap or the Missing roads panel is on, for the segments around the map view. Reads WME's own data, so it
    // does not depend on GIS Layers. A segment needs a street name and a city (primary or alternate) to be routed to.

    const sameCityName = (a, b) => normalizeName(a) === normalizeName(b);

    // The city/CDP the segment lies in, if the points a quarter, half and three quarters along it agree ('' = outside all of them).
    function limitsCityOf(segment, places) {
        const coords = segment.geometry.coordinates;
        const key = `${segment.id}|${coords.length}|${coords[0]}|${coords[coords.length - 1]}`;
        if (gapCityCache.has(key)) return gapCityCache.get(key);
        const names = [0.25, 0.5, 0.75].map((f) => placeAt(places, pointAlongLine(coords, f)));
        const result = names.every((n) => n === names[0]) ? { agreed: true, name: names[0] } : { agreed: false, name: '' };
        if (gapCityCache.size > 20000) gapCityCache.clear();
        gapCityCache.set(key, result);
        return result;
    }

    // thorough = true (the area runs): short unnamed segments are not excused as connectors, so they get looked at too.
    function evaluateSegmentInfo(segment, places, thorough = false) {
        let address;
        try {
            address = sdk.DataModel.Segments.getAddress({ segmentId: segment.id });
        } catch (err) {
            return null;
        }
        const name = address.street && !address.street.isEmpty && address.street.name ? String(address.street.name).trim() : '';
        const cityOf = (x) => (x && x.city && !x.city.isEmpty && x.city.name ? x.city.name : '');
        const primary = cityOf(address);
        const hasCity = !!primary || (address.altStreets || []).some((x) => cityOf(x));
        // Short unnamed segments (the curved at-grade connectors) are fine without a name; they still need a city.
        let shortConnector = false;
        if (!name) {
            const pts = segment.geometry.coordinates;
            let meters = 0;
            for (let i = 1; i < pts.length && meters < GAP_SHORT_CONNECTOR_M; i++) meters += distanceMeters(pts[i - 1][1], pts[i - 1][0], pts[i][1], pts[i][0]);
            shortConnector = !thorough && meters < GAP_SHORT_CONNECTOR_M;
        }
        let kind = null;
        let detail = GAP_KINDS.none.label;
        // An alternate city needs a street name, so an unnamed segment can only have a city when it lies inside city/CDP limits.
        // Inside the limits it needs the primary city; outside them (or when the limits are not loaded) only the missing name counts.
        const limits = places && (!name || primary) ? limitsCityOf(segment, places) : null;
        if (!name) {
            const insideLimits = !!(limits && limits.agreed && limits.name);
            if (insideLimits && !primary) kind = shortConnector ? 'city' : 'none';
            else if (!shortConnector) kind = 'name';
        } else if (!hasCity) kind = 'city';
        if (!kind && limits && gapSettings.cities && primary) {
            if (limits.agreed && !limits.name) {
                kind = 'badcity';
                detail = `primary city ${primary}, but it is outside every city and CDP limit`;
            } else if (limits.agreed && !sameCityName(limits.name, primary)) {
                kind = 'badcity';
                detail = `primary city ${primary}, but the limits here say ${limits.name}`;
            }
        }
        if (!kind) return null;
        return { id: segment.id, kind, name, primary, detail: kind === 'badcity' ? detail : GAP_KINDS[kind].label };
    }

    function gapsWanted() {
        return scanLevel !== 'off';
    }

    function ensureGapLayer() {
        if (gapLayerReady) return true;
        try {
            sdk.Map.addLayer({
                layerName: GAP_LAYER,
                styleRules: Object.entries(GAP_KINDS).map(([kind, k]) => ({
                    predicate: (p) => p.kind === kind,
                    style: { strokeColor: k.colour, strokeWidth: 12, strokeOpacity: 0.45, strokeLinecap: 'round' }
                }))
            });
            gapLayerReady = true;
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Could not add the segment check layer:`, err);
        }
        return gapLayerReady;
    }

    function drawGaps() {
        if (!ensureGapLayer()) return;
        try {
            sdk.Map.removeAllFeaturesFromLayer({ layerName: GAP_LAYER });
        } catch (err) { /* layer empty */ }
        if (!gapList.length) return;
        try {
            sdk.Map.addFeaturesToLayer({
                layerName: GAP_LAYER,
                features: gapList.map((h) => ({ type: 'Feature', id: `gap:${h.id}`, geometry: { type: 'LineString', coordinates: h.coords }, properties: { kind: h.kind } }))
            });
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Could not draw the segments that need info:`, err);
        }
    }

    function gapSummary() {
        const counts = {};
        gapList.forEach((h) => { counts[h.kind] = (counts[h.kind] || 0) + 1; });
        return Object.entries(counts).map(([k, n]) => `${n} ${GAP_KINDS[k].label}`).join('; ');
    }

    function paintGapsButton() {
        const on = gapsWanted();
        const total = gapList.length;
        gapsBadge.textContent = total > 99 ? '99+' : String(total);
        gapsBadge.style.display = on && total ? 'block' : 'none';
        // The docked icon follows this too: orange for anything that needs info, red where there is neither name nor city.
        ccAreaLevel = !on || gapZoomNote ? 'idle' : gapList.some((h) => h.kind === 'none') ? 'error' : total ? 'warn' : 'ok';
        ccAreaCount = on ? total : 0;
        paintTriangle();
        ccPaintDock();
        if (sidebarUi && sidebarUi.gapsSummary) {
            sidebarUi.gapsSummary.textContent = !on ? 'The scan is off.'
                : gapZoomNote || (total ? `${total} in view: ${gapSummary()}.` : 'None in view.');
        }
    }

    function setGapList(found) {
        const center = (() => {
            const [a, b, c, d] = sdk.Map.getMapExtent();
            return [(a + c) / 2, (b + d) / 2];
        })();
        const dist = (h) => Math.hypot((h.mid[0] - center[0]) * Math.cos(center[1] * RAD), h.mid[1] - center[1]);
        found.sort((x, y) => dist(x) - dist(y));
        const signature = found.map((h) => `${h.id}:${h.kind}`).join(',');
        const changed = signature !== gapSignature;
        gapSignature = signature;
        gapList = found;
        gapHistory = gapHistory.filter((id) => found.some((h) => h.id === id)); // ones already fixed drop out
        if (changed) drawGaps();
        paintGapsButton();
        ccRenderNav();
    }

    function clearGaps() {
        if (gapList.length || gapSignature) {
            gapList = [];
            gapSignature = '';
            gapHistory = [];
            drawGaps();
        }
        gapZoomNote = '';
        paintGapsButton();
    }

    async function scanGaps() {
        if (gapScanBusy || !gapsReady) return;
        if (!gapsWanted()) {
            clearGaps();
            return;
        }
        gapScanBusy = true;
        const started = Date.now();
        try {
            if (sdk.Map.getZoomLevel() < GAP_MIN_ZOOM) {
                gapZoomNote = `Zoom in to ${GAP_MIN_ZOOM} or closer to check the segments.`;
                setGapList([]);
                return;
            }
            gapZoomNote = '';
            const [minLon, minLat, maxLon, maxLat] = sdk.Map.getMapExtent();
            const padLon = (maxLon - minLon) * 0.1;
            const padLat = (maxLat - minLat) * 0.1;
            const inside = (p) => p[0] >= minLon - padLon && p[0] <= maxLon + padLon && p[1] >= minLat - padLat && p[1] <= maxLat + padLat;
            let places = null;
            if (gapSettings.cities) {
                try {
                    places = await loadCityBoundaries();
                } catch (err) {
                    places = null; // limits not available: only the missing name / city is checked
                }
            }
            const found = [];
            for (const segment of sdk.DataModel.Segments.getAll()) {
                if (!isLiveSegment(segment) || !GAP_ROAD_TYPES.has(segment.roadType)) continue;
                const c = segment.geometry && segment.geometry.coordinates;
                if (!c || c.length < 2) continue;
                if (!inside(c[0]) && !inside(c[c.length - 1]) && !inside(c[Math.floor(c.length / 2)])) continue;
                const hit = evaluateSegmentInfo(segment, places);
                if (!hit) continue;
                hit.coords = c.map((p) => [p[0], p[1]]);
                hit.mid = pointAlongLine(c, 0.5);
                found.push(hit);
            }
            setGapList(found);
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Segment check failed:`, err);
        } finally {
            gapScanBusy = false;
            gapPollMs = Math.max(3000, (Date.now() - started) * 20); // a slow map gets checked less often
        }
    }

    // Soon after the map moves, a mode changes or something is edited (the timer covers edits the map events do not announce).
    function scheduleGapScan(delay = 400) {
        if (!gapsReady) return;
        clearTimeout(gapTimer);
        gapTimer = setTimeout(scanGaps, delay);
    }
    function pollGaps() {
        clearTimeout(gapPollTimer);
        gapPollTimer = setTimeout(() => {
            if (gapsWanted()) scanGaps();
            pollGaps();
        }, gapPollMs);
    }

    // Next in the triangle panel: go to the nearest segment that needs info that you have not been to yet. Prev: back.
    function stepGaps(back) {
        if (!gapsWanted()) {
            setStatus('The scan is off. Click the scan button on the toolbar to turn it on.', 'info');
            return;
        }
        if (!gapList.length) {
            setStatus(gapZoomNote || 'No segments around here need info.', gapZoomNote ? 'info' : 'ok');
            return;
        }
        let hit = null;
        if (back) {
            gapHistory.pop();
            hit = gapList.find((h) => h.id === gapHistory[gapHistory.length - 1]) || null;
            if (!hit) {
                setStatus('That was the first one.', 'info');
                return;
            }
        } else {
            const current = gapList.find((h) => h.id === gapHistory[gapHistory.length - 1]);
            const [a, b, c, d] = sdk.Map.getMapExtent();
            const from = current ? current.mid : [(a + c) / 2, (b + d) / 2];
            let pool = gapList.filter((h) => !gapHistory.includes(h.id));
            if (!pool.length) {
                // been to all of them: start over, but not on the one we are already at
                gapHistory = [];
                pool = gapList.length > 1 ? gapList.filter((h) => !current || h.id !== current.id) : gapList;
            }
            const distance = (h) => Math.hypot((h.mid[0] - from[0]) * Math.cos(from[1] * RAD), h.mid[1] - from[1]);
            hit = pool.reduce((best, h) => (distance(h) < distance(best) ? h : best), pool[0]);
            gapHistory.push(hit.id);
        }
        try {
            sdk.Map.setMapCenter({ lonLat: { lon: hit.mid[0], lat: hit.mid[1] } });
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Could not move the map to the segment:`, err);
        }
        try {
            sdk.Editing.setSelection({ selection: { objectType: 'segment', ids: [hit.id] } });
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Could not select the segment:`, err);
        }
        setStatus(`${hit.name || 'Unnamed road'}: ${hit.detail}. (${gapHistory.length} of ${gapList.length})`, 'warn');
    }

    for (const eventName of ['wme-map-move-end', 'wme-map-zoom-changed', 'wme-map-data-loaded']) {
        try {
            sdk.Events.on({ eventName, eventHandler: () => scheduleGapScan() });
        } catch (err) { /* this WME version does not announce it; the timer covers it */ }
    }

    gapsReady = true;
    paintGapsButton();
    pollGaps();
    scheduleGapScan(1000);

    // ------------------------------------------------------------------
    // City check popup: checks a segment's name, primary city and alternate city while you edit
    // ------------------------------------------------------------------
    // Runs when you select a segment (a switch turns it off). It only reads; nothing changes until you press a button.
    //   Light  (existing segments): street name, primary city against the city/CDP limits, and a sanity check against nearby
    //          segments already loaded in WME. No GIS queries.
    //   Full   (new segments, or existing ones when the switch says Full): also the postal alternate, using the same sources and
    //          order as an import (GIS record, ZIP table, same street nearby, address points, your default, nearest GIS road).
    // New segments (unsaved, negative id) always get the Full check.
    const STORAGE_KEY_CITYCHECK = 'wme_gis_importer_citycheck_v1';
    let cityCheckSettings = { left: null, top: null };
    try {
        cityCheckSettings = { ...cityCheckSettings, ...(JSON.parse(localStorage.getItem(STORAGE_KEY_CITYCHECK)) || {}) };
    } catch (e) { /* use defaults */ }
    function saveCityCheckSettings() {
        try {
            localStorage.setItem(STORAGE_KEY_CITYCHECK, JSON.stringify(cityCheckSettings));
        } catch (e) { /* storage unavailable */ }
    }

    const CC_NEARBY_RADIUS_M = SAME_STREET_POSTAL_RADIUS_M; // same street name within this distance counts as nearby
    const CC_MAJORITY = 0.6;                                  // share of nearby segments that must agree before it is mentioned
    const CC_MAX_MULTI = 60;                                  // most segments looked at in one multi-select
    const CC_POLL_MS = 600;
    const cityCheckCache = new Map();
    let cityCheckRun = 0;
    let cityCheckLastKey = '';
    let cityCheckPanelOpen = false;   // the details panel opens only when you click the toolbar's road icon
    let cityCheckIndicatorFor = '';  // which selection the icon's colour is for
    let cityCheckTimer = null;
    let cityCheckPollTimer = null;

    const ccCityOf = (x) => (x && x.city && !x.city.isEmpty && x.city.name ? String(x.city.name) : '');
    const ccSameCity = (a, b) => normalizeName(a) === normalizeName(b);
    const ccHas = (list, city) => list.some((c) => ccSameCity(c, city));

    function ccAddressOf(segmentId) {
        try {
            const a = sdk.DataModel.Segments.getAddress({ segmentId });
            const name = a.street && !a.street.isEmpty && a.street.name ? String(a.street.name).trim() : '';
            const primary = ccCityOf(a);
            const altStreets = (a.altStreets || []).filter((x) => x && x.street);
            const alts = altStreets.map(ccCityOf).filter(Boolean);
            return { name, primary, altStreets, alts };
        } catch (err) {
            return null;
        }
    }

    // The postal city a segment stands for: its alternate city if it has one, otherwise its primary city.
    const ccPostalOf = (addr) => (addr.alts.length ? addr.alts : addr.primary ? [addr.primary] : []);

    function ccSelection() {
        let sel = null;
        try {
            sel = sdk.Editing.getSelection();
        } catch (err) {
            return null;
        }
        if (!sel || sel.objectType !== 'segment' || !Array.isArray(sel.ids) || !sel.ids.length) return null;
        return sel.ids.slice();
    }

    // Something short that changes when the selection, or the address or shape of a selected segment, changes.
    function ccSignature(ids) {
        return ids.slice(0, CC_MAX_MULTI).map((id) => {
            const seg = sdk.DataModel.Segments.getById({ segmentId: id });
            const a = seg ? ccAddressOf(id) : null;
            const c = seg && seg.geometry ? seg.geometry.coordinates : [];
            return `${id}:${a ? `${a.name}|${a.primary}|${a.alts.join('/')}` : '?'}:${c.length}:${c[0] || ''}:${c[c.length - 1] || ''}`;
        }).join(';');
    }

    const isNewSegment = (segment) => Number(segment.id) < 0;

    // Nearby evidence from segments already loaded in WME: the segments it connects to, and the same street name within the radius.
    function ccNearby(segment, name) {
        const coords = segment.geometry.coordinates;
        const project = makeProjector(coords[0]);
        const mid = project(pointAlongLine(coords, 0.5));
        const wanted = normalizeName(name);
        const midLL = pointAlongLine(coords, 0.5);
        const pad = (CC_NEARBY_RADIUS_M + 300) / 110540;
        const mine = new Set([segment.fromNodeId, segment.toNodeId].filter((n) => n !== null && n !== undefined));
        const pool = [];
        for (const other of sdk.DataModel.Segments.getAll()) {
            if (other.id === segment.id || !isLiveSegment(other) || OVERLAP_IGNORED_ROAD_TYPES.has(other.roadType)) continue;
            const oc = other.geometry.coordinates;
            const connected = mine.has(other.fromNodeId) || mine.has(other.toNodeId);
            let near = false;
            if (!connected) {
                if (!wanted) continue;
                let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
                for (const c of oc) {
                    if (c[0] < minLon) minLon = c[0];
                    if (c[0] > maxLon) maxLon = c[0];
                    if (c[1] < minLat) minLat = c[1];
                    if (c[1] > maxLat) maxLat = c[1];
                }
                if (midLL[0] < minLon - pad || midLL[0] > maxLon + pad || midLL[1] < minLat - pad || midLL[1] > maxLat + pad) continue;
                if (normalizeName(streetNameOf(other.id)) !== wanted) continue;
                near = xyNearest(oc.map(project), mid[0], mid[1]).d <= CC_NEARBY_RADIUS_M;
                if (!near) continue;
            }
            const addr = ccAddressOf(other.id);
            if (!addr) continue;
            const postal = ccPostalOf(addr);
            if (!postal.length) continue;
            pool.push({ postal, connected });
        }
        // Count how many of them use each postal city.
        const tally = new Map();
        for (const p of pool) {
            for (const city of p.postal) {
                const key = normalizeName(city);
                const e = tally.get(key) || { city, n: 0 };
                e.n++;
                tally.set(key, e);
            }
        }
        const top = [...tally.values()].sort((a, b) => b.n - a.n)[0] || null;
        return { total: pool.length, top, connected: pool.filter((p) => p.connected).length };
    }

    function ccEvidenceLabel(postal) {
        if (postal.fromStreet) return 'same street nearby';
        if (postal.fromAddresses) return 'address points';
        if (postal.fromSetting) return 'your default postal city';
        if (postal.fromNeighbor !== undefined) return 'nearest GIS road (check it)';
        if (postal.fromGoogle) return 'Google Maps address';
        return 'GIS ZIP / postal field';
    }

    // The whole check for one segment. Returns { name, isNew, full, rows[], proposals[], level, summary }.
    // A row is { label, text, level }; a proposal is { kind, label, city, ... } shown as a button.
    async function ccAnalyze(segmentId, full) {
        const segment = sdk.DataModel.Segments.getById({ segmentId });
        const result = { segmentId, name: '', isNew: false, full, rows: [], proposals: [], level: 'info', summary: '' };
        if (!segment || !segment.geometry) {
            result.rows.push({ label: 'Segment', text: 'Not available.', level: 'info' });
            return result;
        }
        result.isNew = isNewSegment(segment);
        const addr = ccAddressOf(segmentId);
        if (!addr) {
            result.rows.push({ label: 'Address', text: 'Could not read this segment\'s address.', level: 'error' });
            result.level = 'error';
            return result;
        }
        result.name = addr.name;
        if (!GAP_ROAD_TYPES.has(segment.roadType)) {
            result.rows.push({ label: 'Road type', text: 'Ramps, paths and other types are not checked.', level: 'info' });
            return result;
        }
        const coords = segment.geometry.coordinates;
        let worst = 'ok';
        const rank = { ok: 0, info: 0, warn: 1, error: 2 };
        const raise = (level) => { if ((rank[level] || 0) > (rank[worst] || 0)) worst = level; };

        // Street name (a short unnamed segment is an at-grade connector, which normally has no name)
        let shortConnector = false;
        if (!addr.name) {
            let meters = 0;
            for (let i = 1; i < coords.length && meters < GAP_SHORT_CONNECTOR_M; i++) meters += distanceMeters(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
            shortConnector = meters < GAP_SHORT_CONNECTOR_M;
        }
        if (addr.name) result.rows.push({ label: 'Street name', text: addr.name, level: 'ok' });
        else if (shortConnector) result.rows.push({ label: 'Street name', text: `None, which is fine for a short connector (under ${GAP_SHORT_CONNECTOR_M} m).`, level: 'ok' });
        else {
            result.rows.push({ label: 'Street name', text: 'None. Name it (the Roads fill-in can do it from the GIS or Google Maps).', level: 'error' });
            raise('error');
        }

        // Primary city against the city/CDP limits
        let places = null;
        try {
            places = await loadCityBoundaries();
        } catch (err) {
            result.rows.push({ label: 'Primary city', text: `${addr.primary || 'none'} (city limits could not be loaded, so it was not checked)`, level: 'info' });
        }
        let limitsPrimary = null;
        if (places) {
            const names = [0.25, 0.5, 0.75].map((f) => placeAt(places, pointAlongLine(coords, f)));
            limitsPrimary = names[1];
            const crosses = names.some((n) => n !== names[1]);
            const limitsText = limitsPrimary || 'outside every city and CDP limit';
            let level = 'ok';
            let text;
            if (!addr.primary && !limitsPrimary && !addr.name) {
                text = 'None, which is right: an unnamed segment outside the city and CDP limits has no city (an alternate city needs a street name).';
            }
            else if (!addr.primary && !limitsPrimary) {
                if (addr.alts.length) text = 'None, and the limits say none (outside every city and CDP). It has an alternate city.';
                else {
                    text = `None, and it lies outside every city and CDP limit. It has no alternate city either, so it has no city at all.${full ? '' : ' Full proposes the postal city.'}`;
                    level = 'warn';
                }
            }
            else if (!addr.primary) { text = `None, but the limits say ${limitsText}.`; level = 'warn'; }
            else if (!limitsPrimary) { text = `${addr.primary}, but it is ${limitsText}.`; level = 'warn'; }
            else if (!ccSameCity(addr.primary, limitsPrimary)) { text = `${addr.primary}, but the limits say ${limitsPrimary}.`; level = 'warn'; }
            else text = `${addr.primary}, matches the limits.`;
            result.rows.push({ label: 'Primary city', text, level });
            raise(level);
            if (level === 'warn' && (limitsPrimary || addr.primary)) {
                result.proposals.push({ kind: 'primary', city: limitsPrimary, label: limitsPrimary ? `Set primary city to ${limitsPrimary}` : 'Clear the primary city' });
            }
            if (crosses) {
                result.rows.push({ label: 'City limit', text: `This segment crosses a city limit (${[...new Set(names)].map((n) => n || 'no city').join(' / ')}); check the city.`, level: 'info' });
            }
        }

        // Nearby segments (sanity check)
        const nearby = full && addr.name ? ccNearby(segment, addr.name) : { total: 0, top: null, connected: 0 }; // the nearby comparison is part of Full
        const mine = ccPostalOf(addr);
        let nearbyCandidate = null;
        if (nearby.total >= 2 && nearby.top && nearby.top.n / nearby.total >= CC_MAJORITY) {
            const agree = ccHas(mine, nearby.top.city);
            const share = `${nearby.top.n} of ${nearby.total} nearby segments use ${nearby.top.city}`;
            if (agree) result.rows.push({ label: 'Nearby', text: `${share}, as this one does.`, level: 'ok' });
            else {
                const asAlt = !(limitsPrimary && ccSameCity(limitsPrimary, nearby.top.city));
                result.rows.push({ label: 'Nearby', text: `${share}; this one has ${mine.length ? mine.join(' / ') : 'no city'}${asAlt ? '. Check whether it needs the alternate city' : ''}.`, level: 'warn' });
                raise('warn');
                if (asAlt) nearbyCandidate = { city: nearby.top.city, source: 'nearby segments' };
            }
        } else if (nearby.total) {
            result.rows.push({ label: 'Nearby', text: nearby.total < 2 ? `Only ${nearby.total} nearby segment to compare with.` : 'Nearby segments do not agree on one city.', level: 'info' });
        } else if (full && addr.name) {
            result.rows.push({ label: 'Nearby', text: 'No nearby segments to compare with.', level: 'info' });
        }

        // Alternate city: the same sources and order as an import (Full check only)
        const candidates = [];
        if (full && !addr.name) {
            result.rows.push({ label: 'Alternate city', text: 'Not needed: an alternate city requires a street name.', level: 'info' });
        } else if (full) {
            try {
                const source = await resolveSource({ lon: coords[0][0], lat: coords[0][1] });
                if (!source) {
                    result.rows.push({ label: 'Alternate city', text: `${noSourceMessage()} The nearby segments were still checked above.`, level: 'info' });
                } else {
                    const match = await gisRoadAlong(segment, source).catch(() => null);
                    const props = match ? match.feature.properties || {} : {};
                    // The GIS road along this segment names it differently (e.g. "Huntwick" mapped, "Huntwick Dr" in the GIS): offer the GIS name
                    const gisName = match && addr.name ? buildStreetName(source.nameParts(props)).name : '';
                    if (gisName && normalizeName(gisName) !== normalizeName(addr.name) && normalizeName(gisName) !== normalizeName(buildStreetName({ full: addr.name }).name)
                        && !keptNames.has(keptKey(segmentId, gisName))) {
                        const layerNote = match.layerId ? `GIS Layers: ${match.layerId}` : source.label;
                        result.rows.push({ label: '\uD83D\uDEE0\uFE0F GIS street name', text: `${mismatchText(addr.name, gisName)} (${layerNote})`, level: 'warn' });
                        raise('warn');
                        result.proposals.push({ kind: 'name', name: gisName, label: `Rename street to ${gisName} (GIS)` });
                        result.proposals.push({ kind: 'keep', keep: true, gisName, label: `Keep mine: ${addr.name} (until reload)` });
                    }
                    const postal = await resolvePostal(source, props, addr.name, coords, match ? match.feature.id : null, segmentId);
                    const cityInfo = await resolveCities(coords, postal);
                    if (postal.cities.length && cityInfo.alternateCities.length) {
                        candidates.push({ cities: cityInfo.alternateCities, source: ccEvidenceLabel(postal) });
                    }
                    const have = addr.alts;
                    const wanted = cityInfo.alternateCities;
                    let level = 'ok';
                    let text;
                    if (!postal.cities.length) { text = `${have.length ? have.join(' / ') : 'None'}. No postal city found from the GIS or other sources; look the address up with USPS.`; level = have.length ? 'info' : 'warn'; }
                    else if (!wanted.length) {
                        text = have.length ? `${have.join(' / ')}. The postal city (${postal.cities.map(formatCityName).join(' / ')}) is the primary city, so no alternate is needed.` : `None needed (postal city is the primary city, from ${ccEvidenceLabel(postal)}).`;
                        level = have.length ? 'info' : 'ok';
                    } else if (!have.length) { text = `None, but the postal city is ${wanted.join(' / ')} (${ccEvidenceLabel(postal)}).`; level = 'warn'; }
                    else if (wanted.every((c) => ccHas(have, c))) text = `${have.join(' / ')}, matches the postal city (${ccEvidenceLabel(postal)}).`;
                    else { text = `${have.join(' / ')}, but the postal city is ${wanted.join(' / ')} (${ccEvidenceLabel(postal)}).`; level = 'warn'; }
                    result.rows.push({ label: 'Alternate city', text, level });
                    raise(level);
                    if (cityInfo.notes.length) result.rows.push({ label: 'Notes', text: cityInfo.notes.join(' '), level: cityInfo.warn ? 'warn' : 'info' });
                    if (cityInfo.warn) raise('warn');
                }
            } catch (err) {
                console.warn(`[${SCRIPT_NAME}] City check (full) failed:`, err);
                result.rows.push({ label: 'Alternate city', text: `Full check failed (${err.message || err}). The light check above still applies.`, level: 'error' });
                raise('warn');
            }
        }

        // Alternate proposals: one button per distinct candidate (pick one when the sources disagree)
        if (nearbyCandidate) candidates.push({ cities: [nearbyCandidate.city], source: nearbyCandidate.source });
        const seen = new Set();
        for (const c of candidates) {
            const key = c.cities.map(normalizeName).sort().join('|');
            if (seen.has(key) || !addr.name) continue;
            seen.add(key);
            const cities = c.cities.filter((x) => !(addr.primary && ccSameCity(x, addr.primary)));
            if (!cities.length || cities.every((x) => ccHas(addr.alts, x))) continue;
            result.proposals.push({ kind: 'alt', cities, label: `${addr.alts.length ? 'Change' : 'Add'} alternate city ${addr.alts.length ? 'to ' : ''}${cities.join(' / ')} (${c.source})` });
        }

        result.level = worst;
        if (worst === 'ok') result.summary = 'Looks right.';
        else if (worst === 'error') result.summary = 'Needs attention.';
        else result.summary = 'Worth a look.';
        return result;
    }

    // Writes a proposal to the segment. Keeps the alternates it has, except when asked to change them.
    function ccApply(segmentId, proposal) {
        if (proposal.kind === 'keep') {
            keptNames.add(keptKey(segmentId, proposal.gisName));
            return;
        }
        const addr = ccAddressOf(segmentId);
        if (!addr) throw new Error('could not read the segment\'s address');
        if (!addr.name && proposal.kind === 'alt') throw new Error('an alternate city needs a street name');
        const { country, state } = regionOf(segmentId);
        if (!country || !state) throw new Error(REGION_ERROR);
        let primary = addr.primary;
        let altIds = addr.altStreets.map((x) => x.street.id);
        if (proposal.kind === 'primary') primary = proposal.city;
        if (proposal.kind === 'name') {
            // the alternate streets carry the old name too: rebuild them with the new one, in the same cities
            if (!proposal.name) throw new Error('no street name to apply');
            altIds = [];
            for (const cityName of addr.alts) {
                const city = sdk.DataModel.Cities.getCity({ cityName, countryId: country.id, stateId: state.id });
                if (!city) continue;
                let street = sdk.DataModel.Streets.getStreet({ streetName: proposal.name, cityId: city.id });
                if (!street) street = sdk.DataModel.Streets.addStreet({ streetName: proposal.name, cityId: city.id });
                altIds.push(street.id);
            }
        }
        if (proposal.kind === 'alt') {
            altIds = [];
            for (const cityName of proposal.cities) {
                let city = sdk.DataModel.Cities.getCity({ cityName, countryId: country.id, stateId: state.id });
                if (!city) city = sdk.DataModel.Cities.addCity({ cityName, countryId: country.id, stateId: state.id });
                let street = sdk.DataModel.Streets.getStreet({ streetName: addr.name, cityId: city.id });
                if (!street) street = sdk.DataModel.Streets.addStreet({ streetName: addr.name, cityId: city.id });
                altIds.push(street.id);
            }
        }
        sdk.DataModel.Segments.updateAddress({
            segmentId,
            addressData: { streetName: proposal.kind === 'name' ? proposal.name : addr.name, cityName: primary, countryId: country.id, stateId: state.id, alternateStreetIds: altIds }
        });
    }

    // ----- the popup -----
    const cityCheckPanel = (() => {
        const el = (tag, css, text) => {
            const node = document.createElement(tag);
            if (css) node.style.cssText = css;
            if (text !== undefined) node.textContent = text;
            return node;
        };
        const smallBtn = 'border: 1px solid #dadce0; background: #ffffff; color: #202124; border-radius: 5px; padding: 3px 8px; font-size: 12px; cursor: pointer;';
        const COLOUR = '#1a73e8';

        const panel = el('div', `position: fixed; z-index: 999996; width: 320px; max-height: 80vh; display: none; flex-direction: column;
            background: #ffffff; border: 1px solid #dadce0; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.35);
            font-family: sans-serif; font-size: 12px; color: #202124;`);
        const header = el('div', `display: flex; align-items: center; gap: 6px; padding: 8px 10px; cursor: move; user-select: none;
            border-bottom: 3px solid ${COLOUR}; border-radius: 8px 8px 0 0;`);
        header.appendChild(el('span', 'font-weight: bold; font-size: 13px; flex: 1;', 'Segment check'));
        const levelLabel = el('span', 'font-size: 11px; font-weight: bold; padding: 2px 7px; border-radius: 9px; color: #ffffff; background: #9aa0a6;', 'Off');
        levelLabel.title = 'The scan level. Change it with the scan button on the toolbar.';
        const closeBtn = el('button', smallBtn, '\u00D7');
        closeBtn.title = 'Close the panel (the triangle on the toolbar keeps showing the result)';
        header.append(levelLabel, closeBtn);
        panel.appendChild(header);

        const body = el('div', 'display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; overflow-y: auto; min-height: 0;');
        const title = el('div', 'font-weight: bold; font-size: 13px; user-select: text;');
        const verdict = el('div', 'font-size: 11px; line-height: 1.3; padding: 4px 6px; border-radius: 3px; user-select: text;');
        const rows = el('div', 'display: flex; flex-direction: column; gap: 4px;');
        const actions = el('div', 'display: flex; flex-direction: column; gap: 4px;');
        const nav = el('div', 'display: none; align-items: center; gap: 6px;');
        const prevBtn = el('button', smallBtn, '◀ Prev');
        const counter = el('span', 'flex: 1; text-align: center; color: #5f6368;', '');
        const nextBtn = el('button', smallBtn, 'Next ▶');
        nav.append(prevBtn, counter, nextBtn);
        const foot = el('div', 'font-size: 10px; color: #5f6368; line-height: 1.3;', 'Nothing changes until you press Apply. Ctrl+Z undoes it.');
        body.append(title, verdict, rows, actions, nav, foot);
        panel.appendChild(body);
        document.body.appendChild(panel);

        const place = () => {
            let left = cityCheckSettings.left;
            let top = cityCheckSettings.top;
            if (left === null || top === null) {
                // Beside the edit panel: just to the right of the sidebar
                const side = document.getElementById('sidebar') || document.getElementById('edit-panel');
                const r = side ? side.getBoundingClientRect() : null;
                left = r && r.width > 100 ? Math.round(r.right + 12) : 380;
                top = 90;
            }
            panel.style.left = `${Math.max(0, Math.min(window.innerWidth - 60, left))}px`;
            panel.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, top))}px`;
        };
        header.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            const startX = e.clientX;
            const startY = e.clientY;
            const left0 = parseInt(panel.style.left, 10);
            const top0 = parseInt(panel.style.top, 10);
            const move = (ev) => {
                cityCheckSettings.left = Math.max(0, Math.min(window.innerWidth - 60, left0 + ev.clientX - startX));
                cityCheckSettings.top = Math.max(0, Math.min(window.innerHeight - 40, top0 + ev.clientY - startY));
                place();
            };
            const up = () => {
                document.removeEventListener('mousemove', move);
                document.removeEventListener('mouseup', up);
                saveCityCheckSettings();
            };
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up);
            e.preventDefault();
        });

        return { panel, title, verdict, rows, actions, nav, counter, prevBtn, nextBtn, levelLabel, closeBtn, place, el, smallBtn };
    })();

    function ccPaintMode() {
        const p = cityCheckPanel;
        const look = SCAN_LOOK[scanLevel] || SCAN_LOOK.off;
        p.levelLabel.textContent = scanLevel === 'full' ? 'Full' : scanLevel === 'light' ? 'Light' : 'Off';
        p.levelLabel.style.background = scanLevel === 'off' ? '#9aa0a6' : look.background;
    }

    function ccShowPanel(show) {
        const p = cityCheckPanel;
        show = show && cityCheckPanelOpen;
        if (show) {
            if (p.panel.style.display === 'none') p.place();
            p.panel.style.display = 'flex';
        } else {
            p.panel.style.display = 'none';
        }
    }

    // Next and Prev step through the segments flagged in view (the same list the map highlights).
    function ccRenderNav() {
        const p = cityCheckPanel;
        if (scanLevel === 'off') {
            p.nav.style.display = 'none';
            return;
        }
        p.nav.style.display = 'flex';
        const n = gapList.length;
        p.counter.textContent = gapZoomNote || (n ? `${n} flagged in view` : 'None flagged in view');
        p.prevBtn.disabled = !n;
        p.nextBtn.disabled = !n;
    }

    function ccRenderRows(result) {
        const p = cityCheckPanel;
        p.rows.textContent = '';
        for (const r of result.rows) {
            const st = statusStyle(r.level);
            const row = p.el('div', `padding: 3px 6px; border-radius: 3px; line-height: 1.3; user-select: text; border-left: 4px solid ${st.border}; background: ${st.background}; color: ${st.color};`);
            row.appendChild(p.el('strong', '', `${r.label}: `));
            row.appendChild(document.createTextNode(r.text));
            p.rows.appendChild(row);
        }
    }

    function ccRenderActions(result) {
        const p = cityCheckPanel;
        p.actions.textContent = '';
        for (const proposal of result.proposals) {
            const btn = p.el('button', proposal.keep
                ? 'border: 1px solid #9aa0a6; background: #ffffff; color: #3c4043; border-radius: 5px; padding: 5px 8px; font-size: 12px; font-weight: bold; cursor: pointer; text-align: left; white-space: normal;'
                : 'border: 1px solid #1a73e8; background: #1a73e8; color: #ffffff; border-radius: 5px; padding: 5px 8px; font-size: 12px; font-weight: bold; cursor: pointer; text-align: left; white-space: normal;', proposal.keep ? proposal.label : `Apply: ${proposal.label}`);
            btn.addEventListener('click', () => {
                try {
                    ccApply(result.segmentId, proposal);
                    cityCheckCache.clear();
                    p.verdict.textContent = `${result.name || 'Road'}: done. ${proposal.label}.`;
                    paintStatus(p.verdict, 'ok');
                    p.actions.textContent = '';
                    ccRequestCheck(150, true);
                    scheduleGapScan(200);
                } catch (err) {
                    console.warn(`[${SCRIPT_NAME}] City check apply failed:`, err);
                    p.verdict.textContent = `${result.name || 'Road'}: could not apply (${err.message || err}).`;
                    paintStatus(p.verdict, 'error');
                }
            });
            p.actions.appendChild(btn);
        }
    }

    // One segment: full detail. Several: a count summary and a queue to step through.
    async function ccRun(force) {
        const p = cityCheckPanel;
        ccPaintMode();
        if (scanLevel === 'off') {
            cityCheckLastKey = '';
            cityCheckIndicatorFor = '';
            ccSetIndicator('off');
            p.title.textContent = 'Segment check';
            p.verdict.textContent = 'The scan is off. Click the scan button on the toolbar for Light or Full.';
            paintStatus(p.verdict, 'info');
            p.rows.textContent = '';
            p.actions.textContent = '';
            ccRenderNav();
            ccShowPanel(true);
            return;
        }
        const ids = ccSelection();
        if (!ids) {
            cityCheckLastKey = '';
            cityCheckIndicatorFor = '';
            ccSetIndicator('idle');
            p.title.textContent = 'Segment check';
            p.verdict.textContent = 'Select a segment to check its name and city.';
            paintStatus(p.verdict, 'info');
            p.rows.textContent = '';
            p.actions.textContent = '';
            ccRenderNav();
            ccShowPanel(true);
            return;
        }
        let sig;
        try {
            sig = ccSignature(ids);
        } catch (err) {
            return;
        }
        const key = `${scanLevel}|${sig}`;
        if (!force && key === cityCheckLastKey) return;
        cityCheckLastKey = key;
        const run = ++cityCheckRun;
        // A different selection: the triangle goes grey until the new result is in. The same segment re-checked keeps its colour.
        const selectionKey = ids.slice(0, CC_MAX_MULTI).join(',');
        if (selectionKey !== cityCheckIndicatorFor) {
            cityCheckIndicatorFor = selectionKey;
            ccSetIndicator('idle', 'checking...');
        }

        if (ids.length > 1) {
            ccShowPanel(true);
            p.title.textContent = `${ids.length} segments selected`;
            p.verdict.textContent = 'Checking...';
            paintStatus(p.verdict, 'info');
            p.rows.textContent = '';
            p.actions.textContent = '';
            const counts = { ok: 0, warn: 0, error: 0, info: 0 };
            for (const id of ids.slice(0, CC_MAX_MULTI)) {
                const r = await ccAnalyze(id, false);
                if (run !== cityCheckRun) return;
                counts[r.level === 'error' ? 'error' : r.level === 'warn' ? 'warn' : r.level === 'info' ? 'info' : 'ok']++;
            }
            const checked = Math.min(ids.length, CC_MAX_MULTI);
            const parts = [`${counts.ok} fine`];
            if (counts.warn) parts.push(`${counts.warn} worth a look`);
            if (counts.error) parts.push(`${counts.error} need attention (usually no street name)`);
            if (counts.info) parts.push(`${counts.info} not checked`);
            p.verdict.textContent = `${checked} checked (light): ${parts.join(', ')}.${ids.length > checked ? ` Only the first ${checked} were looked at.` : ''}`;
            paintStatus(p.verdict, counts.error ? 'error' : counts.warn ? 'warn' : 'ok');
            ccSetIndicator(counts.error ? 'error' : counts.warn ? 'warn' : counts.ok ? 'ok' : 'idle', `${p.verdict.textContent}`);
            ccRenderNav();
            return;
        }

        const id = ids[0];
        const segment = sdk.DataModel.Segments.getById({ segmentId: id });
        const isNew = !!segment && isNewSegment(segment);
        const full = scanLevel === 'full';
        ccShowPanel(true);
        p.title.textContent = `${streetNameOf(id) || 'Unnamed road'}${isNew ? ' (new segment)' : ''}`;
        p.verdict.textContent = full ? 'Checking (full)...' : 'Checking...';
        paintStatus(p.verdict, 'info');

        const cacheKey = `${id}|${full ? 'f' : 'l'}|${sig}`;
        let result = cityCheckCache.get(cacheKey);
        if (!result) {
            try {
                result = await ccAnalyze(id, full);
            } catch (err) {
                console.warn(`[${SCRIPT_NAME}] City check failed:`, err);
                if (run !== cityCheckRun) return;
                p.verdict.textContent = `Could not check this segment (${err.message || err}).`;
                paintStatus(p.verdict, 'error');
                ccSetIndicator('idle', 'could not check this segment.');
                p.rows.textContent = '';
                p.actions.textContent = '';
                return;
            }
            if (cityCheckCache.size > 200) cityCheckCache.clear();
            cityCheckCache.set(cacheKey, result);
        }
        if (run !== cityCheckRun) return;
        p.title.textContent = `${result.name || 'Unnamed road'}${result.isNew ? ' (new segment)' : ''}`;
        p.verdict.textContent = result.summary;
        paintStatus(p.verdict, result.level === 'ok' ? 'ok' : result.level);
        ccSetIndicator(result.level === 'ok' || result.level === 'warn' || result.level === 'error' ? result.level : 'idle', result.summary);
        ccRenderRows(result);
        ccRenderActions(result);
        ccRenderNav();
    }

    function ccRequestCheck(delay = 250, force = false) {
        clearTimeout(cityCheckTimer);
        cityCheckTimer = setTimeout(() => {
            ccRun(force).catch((err) => console.warn(`[${SCRIPT_NAME}] City check error:`, err));
        }, delay);
    }

    // A light poll notices selection changes and edits to the selected segment even where WME announces no event.
    function ccPoll() {
        clearInterval(cityCheckPollTimer);
        cityCheckPollTimer = null;
        if (scanLevel === 'off') return;
        cityCheckPollTimer = setInterval(() => {
            const ids = ccSelection();
            if (!ids) {
                if (cityCheckLastKey) ccRequestCheck(0);
                return;
            }
            let sig = '';
            try {
                sig = ccSignature(ids);
            } catch (err) {
                return;
            }
            if (`${scanLevel}|${sig}` !== cityCheckLastKey) ccRequestCheck(250);
        }, CC_POLL_MS);
    }

    // The master scan button: Off -> Light -> Full -> Off.
    function setScanLevel(level) {
        scanLevel = level === 'full' ? 'full' : level === 'light' ? 'light' : 'off';
        try {
            localStorage.setItem(STORAGE_KEY_SCAN, scanLevel);
        } catch (e) { /* storage unavailable */ }
        paintScanButton();
        ccPaintMode();
        cityCheckLastKey = '';
        cityCheckIndicatorFor = '';
        cityCheckCache.clear();
        if (scanLevel === 'off') {
            clearInterval(cityCheckPollTimer);
            cityCheckPollTimer = null;
            clearGaps();
            ccSetIndicator('off');
        } else {
            ccPoll();
            scheduleGapScan(0);
        }
        ccRequestCheck(0, true);
        setStatus(scanLevel === 'off' ? 'Scan off: nothing is being checked.'
            : scanLevel === 'light' ? 'Scan Light: checking the segments around the map with what WME has loaded and the city limits.'
                : 'Scan Full: also checks the selected segment against the postal sources and nearby streets.', 'info');
        console.log(`[${SCRIPT_NAME}] scan ${scanLevel}.`);
    }

    btnScan.addEventListener('click', () => setScanLevel(scanLevel === 'off' ? 'light' : scanLevel === 'light' ? 'full' : 'off'));
    cityCheckPanel.closeBtn.addEventListener('click', () => {
        cityCheckPanelOpen = false;
        ccShowPanel(false);
    });
    // The triangle opens or closes the panel.
    btnGaps.addEventListener('click', () => {
        cityCheckPanelOpen = !cityCheckPanelOpen;
        if (cityCheckPanelOpen) {
            cityCheckPanel.place();
            cityCheckLastKey = '';
            ccRequestCheck(0, true);
        } else {
            ccShowPanel(false);
        }
    });
    cityCheckPanel.prevBtn.addEventListener('click', () => stepGaps(true));
    cityCheckPanel.nextBtn.addEventListener('click', () => stepGaps(false));

    try {
        sdk.Events.on({ eventName: 'wme-selection-changed', eventHandler: () => ccRequestCheck(150) });
    } catch (err) { /* this WME version does not announce it; the poll covers it */ }

    ccPaintMode();
    paintScanButton();
    if (scanLevel !== 'off') {
        ccPoll();
        ccRequestCheck(1200, true);
    } else {
        ccSetIndicator('off');
    }

    // ------------------------------------------------------------------
    // Autofill: a segment drawn by hand inside city or CDP limits gets its primary city
    // ------------------------------------------------------------------
    // Works whatever the scan level, even Off, while the sidebar switch is on. It only touches a new (unsaved) segment, only fills a blank
    // primary city (never overwrites one), and only when the whole segment lies inside one city or CDP. Segments the importer creates
    // are left to the importer. A primary city can be set on a segment with no name; an alternate city cannot, so those are not touched here.
    const AUTOFILL_ROAD_TYPES = new Set([1, 2, 3, 6, 7, 17, 20, 22]); // streets, highways, private and parking lot roads, narrow streets (no ramps, paths, ferries or rail)
    const AUTOFILL_DELAY_MS = 600;
    const autofillQueue = new Set();
    let autofillTimer = null;
    let autofillRunning = false;

    async function autofillNewSegments() {
        if (autofillRunning) {
            clearTimeout(autofillTimer);
            autofillTimer = setTimeout(autofillNewSegments, 500);
            return;
        }
        const ids = [...autofillQueue];
        autofillQueue.clear();
        if (!autofillEnabled || !ids.length) return;
        autofillRunning = true;
        try {
            const places = await loadCityBoundaries();
            const { country, state } = regionOf(ids[0]);
            if (!country || !state) return;
            const done = [];
            for (const id of ids) {
                if (importerMadeIds.has(id)) continue;
                const segment = sdk.DataModel.Segments.getById({ segmentId: id });
                if (!segment || !isLiveSegment(segment) || !segment.geometry || !AUTOFILL_ROAD_TYPES.has(segment.roadType)) continue;
                const addr = ccAddressOf(id);
                if (!addr || addr.primary) continue;
                const coords = segment.geometry.coordinates;
                const names = [0.25, 0.5, 0.75].map((f) => placeAt(places, pointAlongLine(coords, f)));
                if (!names[1] || names.some((n) => n !== names[1])) continue; // outside every limit, or crossing one: left for you
                sdk.DataModel.Segments.updateAddress({
                    segmentId: id,
                    addressData: { streetName: addr.name, cityName: names[1], countryId: country.id, stateId: state.id, alternateStreetIds: addr.altStreets.map((x) => x.street.id) }
                });
                done.push({ name: addr.name, city: names[1] });
            }
            if (done.length) {
                setStatus(done.length === 1
                    ? `${done[0].name || 'Unnamed road'}: primary city ${done[0].city} filled in (inside city limits).`
                    : `${done.length} new segments: primary city filled in (inside city limits).`, 'ok');
                console.log(`[${SCRIPT_NAME}] autofill:`, done);
                cityCheckCache.clear();
                scheduleGapScan(150);
                if (scanLevel !== 'off') ccRequestCheck(150, true);
            }
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Autofill failed:`, err);
        } finally {
            autofillRunning = false;
        }
    }

    try {
        sdk.Events.trackDataModelEvents({ dataModelName: 'segments' });
        sdk.Events.on({
            eventName: 'wme-data-model-objects-added',
            eventHandler: (e) => {
                if (!autofillEnabled || !e || e.dataModelName !== 'segments') return;
                for (const id of e.objectIds || []) if (Number(id) < 0) autofillQueue.add(id);
                if (!autofillQueue.size) return;
                clearTimeout(autofillTimer);
                autofillTimer = setTimeout(autofillNewSegments, AUTOFILL_DELAY_MS);
            }
        });
    } catch (err) {
        console.warn(`[${SCRIPT_NAME}] Autofill of hand-drawn segments is not available:`, err);
    }

    // ------------------------------------------------------------------
    // Hover tip: with Roads on and the scan at Light or Full, hover a flagged segment to see what is wrong and the fix;
    // right-click applies the fix (one at a time). It stays quiet for the segment you have selected.
    // ------------------------------------------------------------------
    // Only segments the scan has flagged (missing name or city, or a primary city that does not fit the limits) are checked, so the
    // pointer is compared with a short list. The fix text comes from the same check the triangle panel uses (and its cache).
    const HOVER_TOLERANCE_PX = 8;   // how close, in screen pixels, the pointer must be to a flagged segment
    const HOVER_THROTTLE_MS = 30;
    const HOVER_OFFSET_PX = 16;
    const HOVER_MAX_TEXT = 170;
    const HOVER_RECHECK_MS = 700;   // after a fix, give the scan a moment, then show the segment's next fix

    const hoverTip = document.createElement('div');
    hoverTip.id = 'wme-segment-importer-hover-tip';
    hoverTip.style.cssText = 'position: fixed; z-index: 999995; display: none; max-width: 300px; pointer-events: none; padding: 6px 8px; ' +
        'background: #ffffff; border: 1px solid #dadce0; border-left: 4px solid #bdc1c6; border-radius: 6px; box-shadow: 0 3px 12px rgba(0,0,0,0.35); ' +
        'font: 12px/1.35 sans-serif; color: #202124;';
    document.body.appendChild(hoverTip);

    let hoverLast = null;     // the pointer, in page pixels
    let hoverId = null;       // the flagged segment the tip is showing
    let hoverResult = null;   // its check result (null while it is being checked)
    let hoverToken = 0;       // bumped whenever the tip is hidden or changes segment, so a slow check cannot land on the wrong one
    let hoverStamp = 0;

    const hoverWanted = () => importRoadsEnabled && scanLevel !== 'off' && gapList.length > 0 && !areaDrawing && !areaRunning;
    const hoverShort = (text) => (text.length > HOVER_MAX_TEXT ? `${text.slice(0, HOVER_MAX_TEXT - 1)}\u2026` : text);
    const hoverProposal = (result) => (result && result.proposals ? result.proposals.find((p) => !p.keep) || null : null);

    function hideHoverTip() {
        hoverTip.style.display = 'none';
        hoverId = null;
        hoverResult = null;
        hoverToken++;
    }

    function placeHoverTip() {
        if (!hoverLast) return;
        const w = hoverTip.offsetWidth;
        const h = hoverTip.offsetHeight;
        let left = hoverLast.x + HOVER_OFFSET_PX;
        let top = hoverLast.y + HOVER_OFFSET_PX;
        if (left + w > window.innerWidth - 4) left = hoverLast.x - HOVER_OFFSET_PX - w;
        if (top + h > window.innerHeight - 4) top = hoverLast.y - HOVER_OFFSET_PX - h;
        hoverTip.style.left = `${Math.max(4, left)}px`;
        hoverTip.style.top = `${Math.max(4, top)}px`;
    }

    // item = the flagged segment from the scan; result = its full check (or null while checking); failure = text when a fix did not work
    function showHoverTip(item, result, failure) {
        let level = item.kind === 'none' ? 'error' : 'warn';
        if (result && result.level === 'error') level = 'error';
        const st = statusStyle(level);
        hoverTip.style.borderLeftColor = st.border;
        hoverTip.textContent = '';

        const title = document.createElement('div');
        title.style.fontWeight = 'bold';
        title.textContent = item.name || 'Unnamed road';

        const reasonRow = result ? result.rows.find((r) => r.level === 'warn' || r.level === 'error') : null;
        const detail = item.detail ? `${item.detail.charAt(0).toUpperCase()}${item.detail.slice(1)}.` : 'Needs info.';
        const reason = document.createElement('div');
        reason.style.color = st.color;
        reason.textContent = hoverShort(reasonRow ? `${reasonRow.label}: ${reasonRow.text}` : detail);

        const fix = document.createElement('div');
        fix.style.cssText = 'margin-top: 3px; font-weight: bold;';
        const proposal = hoverProposal(result);
        if (failure) {
            fix.textContent = hoverShort(failure);
            fix.style.color = statusStyle('error').color;
        } else if (!result) {
            fix.textContent = 'Checking\u2026';
            fix.style.color = statusStyle('info').color;
        } else if (proposal) {
            fix.textContent = hoverShort(`Right-click: ${proposal.label}`);
            fix.style.color = '#1a73e8';
        } else {
            fix.textContent = 'No quick fix here. Click it with Roads on to fill it in from the GIS.';
            fix.style.color = statusStyle('info').color;
        }
        hoverTip.append(title, reason, fix);
        hoverTip.style.display = 'block';
        placeHoverTip();
    }

    // The same check the triangle panel runs (Light or Full), sharing its cache.
    async function hoverAnalyze(id) {
        const full = scanLevel === 'full';
        const cacheKey = `${id}|${full ? 'f' : 'l'}|${ccSignature([id])}`;
        let result = cityCheckCache.get(cacheKey);
        if (!result) {
            result = await ccAnalyze(id, full);
            if (cityCheckCache.size > 200) cityCheckCache.clear();
            cityCheckCache.set(cacheKey, result);
        }
        return result;
    }

    async function hoverEvaluate() {
        if (!hoverLast || !hoverWanted()) {
            if (hoverId !== null) hideHoverTip();
            return;
        }
        const here = sdk.Map.getLonLatFromPixel({ x: hoverLast.x, y: hoverLast.y });
        const beside = sdk.Map.getLonLatFromPixel({ x: hoverLast.x + HOVER_TOLERANCE_PX, y: hoverLast.y });
        const toleranceM = distanceMeters(here.lat, here.lon, beside.lat, beside.lon);
        let best = null;
        for (const item of gapList) {
            const d = distanceToLine(here, item.coords);
            if (d <= toleranceM && (!best || d < best.d)) best = { item, d };
        }
        const selected = ccSelection();
        if (best && selected && selected.includes(best.item.id)) best = null; // the panel already covers the selected segment
        if (!best) {
            if (hoverId !== null) hideHoverTip();
            return;
        }
        if (best.item.id === hoverId) return;

        hideHoverTip();
        const id = best.item.id;
        hoverId = id;
        const token = ++hoverToken;
        showHoverTip(best.item, null);
        let result = null;
        try {
            result = await hoverAnalyze(id);
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Hover check failed:`, err);
        }
        if (token !== hoverToken) return;
        hoverResult = result;
        showHoverTip(best.item, result, result ? '' : 'Could not check this segment.');
    }

    function hoverApply(id, result, proposal) {
        const label = result.name || 'Road';
        try {
            ccApply(id, proposal);
            cityCheckCache.clear();
            setStatus(`${label}: done. ${proposal.label}.`, 'ok');
            hideHoverTip();
            ccRequestCheck(150, true);
            scheduleGapScan(200);
            // the scan drops the segment if that was its last fix; otherwise the tip comes back with the next one
            setTimeout(() => hoverEvaluate().catch((err) => console.warn(`[${SCRIPT_NAME}] Hover check failed:`, err)), HOVER_RECHECK_MS);
        } catch (err) {
            console.warn(`[${SCRIPT_NAME}] Hover apply failed:`, err);
            setStatus(`${label}: could not apply (${err.message || err}).`, 'error');
            const item = gapList.find((h) => h.id === id);
            if (item) showHoverTip(item, result, `Could not apply: ${err.message || err}`);
        }
    }

    mapDiv.addEventListener('mousemove', (e) => {
        hoverLast = { x: e.clientX, y: e.clientY };
        if (e.buttons || !hoverWanted()) { // a drag or pan is in progress, or the tip is not wanted
            if (hoverId !== null) hideHoverTip();
            return;
        }
        if (hoverId !== null) placeHoverTip();
        const now = Date.now();
        if (now - hoverStamp < HOVER_THROTTLE_MS) return;
        hoverStamp = now;
        hoverEvaluate().catch((err) => console.warn(`[${SCRIPT_NAME}] Hover check failed:`, err));
    });
    mapDiv.addEventListener('mouseleave', () => {
        if (hoverId !== null) hideHoverTip();
    });
    // A click does its own work (the Roads fill-in), so the tip steps aside.
    mapDiv.addEventListener('click', () => {
        if (hoverId !== null) hideHoverTip();
    }, true);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && hoverId !== null) hideHoverTip();
    });
    // Right-click applies the fix the tip is showing. Only while a fix is showing: everywhere else WME's right-click is left alone.
    mapDiv.addEventListener('contextmenu', (e) => {
        if (hoverId === null || !hoverResult || !hoverWanted()) return;
        const proposal = hoverProposal(hoverResult);
        if (!proposal) return;
        e.preventDefault();
        e.stopPropagation();
        hoverApply(hoverId, hoverResult, proposal);
    }, true);

    console.log(`[${SCRIPT_NAME}] loaded.`);
})();
