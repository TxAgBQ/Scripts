// ==UserScript==
// @name         WME Issue Route Visibility
// @namespace    https://github.com/TxAgBQ/Scripts
// @version      2026.10.27.01
// @description  Shows the direction arrows on an issue's suggested (purple) and driven (green) routes at zoom 16, not only at zoom 17 and higher.
// @author       TxAgBQ
// @match        https://www.waze.com/editor*
// @match        https://www.waze.com/*/editor*
// @match        https://beta.waze.com/editor*
// @match        https://beta.waze.com/*/editor*
// @exclude      https://www.waze.com/user/editor*
// @exclude      https://beta.waze.com/user/editor*
// @grant        none
// @run-at       document-end
// @homepageURL  https://github.com/TxAgBQ/Scripts/tree/main/wme-issue-route-visibility
// @updateURL    https://github.com/TxAgBQ/Scripts/raw/refs/heads/main/wme-issue-route-visibility/WME-Issue-Route-Visibility.user.js
// @downloadURL  https://github.com/TxAgBQ/Scripts/raw/refs/heads/main/wme-issue-route-visibility/WME-Issue-Route-Visibility.user.js
// ==/UserScript==

/* global getWmeSdk, OpenLayers, W */

(function () {
    'use strict';

    const SCRIPT_ID = 'wme-issue-route-visibility';
    const SCRIPT_NAME = 'WME Issue Route Visibility';
    const LOG = '[' + SCRIPT_NAME + ']';

    // ---- Settings (hard-coded for now) ----
    const MIN_ZOOM = 16;         // lowest zoom that gets the extra arrows
    const NATIVE_ZOOM = 17;      // WME draws its own arrows from this zoom up
    const SPACING_PX = 90;       // on-screen distance between arrows (WME uses about 84 px at zoom 17)
    const MIN_LINE_PX = 30;      // route pieces shorter than this on screen get no arrow
    const LAYER_NAME = 'problemMoreInfo';   // WME's internal layer for the issue routes
    const ARROW_ID_PREFIX = 'irv-';         // marks features this script added
    const REDRAW_DELAY_MS = 60;  // WME adds the route features in a burst; wait for it to finish

    // Route line type -> arrow type (names as WME uses them)
    const ARROW_FOR = { drive: 'driveArrow', suggestedRoute: 'suggestedRouteArrow' };

    let sdk = null;
    let ol = null;
    let currentLayer = null;
    let timer = null;

    // ---- Startup: SDK in async mode, then wait for WME to be ready ----
    function start() {
        if (typeof getWmeSdk === 'function') {
            try {
                sdk = getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME, mode: 'async' });
                const ready = sdk.Events && sdk.Events.once
                    ? sdk.Events.once({ eventName: 'wme-ready' })
                    : null;
                if (ready && typeof ready.then === 'function') {
                    ready.then(init).catch(err => console.error(LOG, 'SDK ready failed', err));
                    return;
                }
            } catch (err) {
                console.warn(LOG, 'SDK start failed, falling back to polling', err);
            }
        }
        waitForMap();
    }

    function waitForMap() {
        const iv = setInterval(() => {
            if (window.W && W.map && typeof W.map.getOLMap === 'function') {
                clearInterval(iv);
                init();
            }
        }, 500);
    }

    // The SDK does not expose the issue route layer, so this part has to use the page's OpenLayers map.
    function getOlMap() {
        try {
            return window.W && W.map && W.map.getOLMap ? W.map.getOLMap() : null;
        } catch (e) {
            return null;
        }
    }

    function init() {
        ol = getOlMap();
        if (!ol) {
            waitForMap();
            return;
        }
        // WME creates a brand-new route layer for every issue and removes it when the issue closes,
        // so watch the map for layers coming and going instead of holding on to one layer.
        ol.events.register('addlayer', null, onLayerAdded);
        ol.events.register('removelayer', null, onLayerRemoved);
        ol.events.register('zoomend', null, () => schedule());
        const existing = findLayer();
        if (existing) attach(existing);
        console.log(LOG, 'ready');
    }

    function findLayer() {
        return ol.layers.find(l => l.name === LAYER_NAME) || null;
    }

    function onLayerAdded(ev) {
        if (ev && ev.layer && ev.layer.name === LAYER_NAME) attach(ev.layer);
    }

    function onLayerRemoved(ev) {
        if (ev && ev.layer && ev.layer === currentLayer) {
            detach();
        }
    }

    function attach(layer) {
        detach();
        currentLayer = layer;
        layer.events.register('featuresadded', null, onFeaturesAdded);
        schedule();
    }

    function detach() {
        clearTimeout(timer);
        if (currentLayer) {
            try { currentLayer.events.unregister('featuresadded', null, onFeaturesAdded); } catch (e) { /* layer already gone */ }
        }
        currentLayer = null;
    }

    function isMine(f) {
        const w = f.attributes && f.attributes.wazeFeature;
        return !!w && String(w.id).indexOf(ARROW_ID_PREFIX) === 0;
    }

    function onFeaturesAdded(ev) {
        const fs = (ev && ev.features) || [];
        if (fs.length && fs.every(isMine)) return;   // our own arrows, ignore
        schedule();
    }

    function schedule() {
        clearTimeout(timer);
        timer = setTimeout(draw, REDRAW_DELAY_MS);
    }

    // ---- Drawing ----
    function draw() {
        try {
            const layer = currentLayer;
            if (!layer || !layer.map) return;

            // always clear our previous arrows first so they never double up
            const old = layer.features.filter(isMine);
            if (old.length) layer.removeFeatures(old, { silent: true });

            const zoom = ol.getZoom();
            if (zoom < MIN_ZOOM || zoom >= NATIVE_ZOOM) return;   // WME handles 17+, nothing below 16

            const res = ol.getResolution();
            const step = SPACING_PX * res;
            const arrows = [];
            let n = 0;

            layer.features.forEach(f => {
                if (!f.geometry || f.geometry.CLASS_NAME !== 'OpenLayers.Geometry.LineString') return;
                const w = f.attributes && f.attributes.wazeFeature;
                if (!w || !ARROW_FOR[w.type]) return;

                const c = f.geometry.components;
                const seg = [];
                let total = 0;
                for (let i = 0; i < c.length - 1; i++) {
                    const d = Math.hypot(c[i + 1].x - c[i].x, c[i + 1].y - c[i].y);
                    seg.push(d);
                    total += d;
                }
                if (!seg.length || total < MIN_LINE_PX * res) return;

                const count = Math.max(1, Math.round(total / step));
                for (let k = 0; k < count; k++) {
                    let d = (k + 0.5) * total / count;
                    let i = 0;
                    while (i < seg.length - 1 && d > seg[i]) { d -= seg[i]; i++; }
                    const t = seg[i] ? d / seg[i] : 0;
                    const x = c[i].x + (c[i + 1].x - c[i].x) * t;
                    const y = c[i].y + (c[i + 1].y - c[i].y) * t;
                    // azymuth = degrees clockwise from north, the same as WME's own arrows
                    const az = (Math.atan2(c[i + 1].x - c[i].x, c[i + 1].y - c[i].y) * 180 / Math.PI + 360) % 360;
                    const ll = new OpenLayers.Geometry.Point(x, y).transform('EPSG:900913', 'EPSG:4326');
                    arrows.push(new OpenLayers.Feature.Vector(
                        new OpenLayers.Geometry.Point(x, y),
                        {
                            wazeFeature: {
                                featureType: w.featureType,
                                isDeleted: false,
                                isSelected: false,
                                isUnchanged: false,
                                azymuth: az,
                                geometry: { type: 'Point', coordinates: [ll.x, ll.y] },
                                id: ARROW_ID_PREFIX + w.type + '-' + (n++),
                                type: ARROW_FOR[w.type]
                            }
                        }
                    ));
                }
            });

            if (arrows.length) layer.addFeatures(arrows, { silent: true });
        } catch (err) {
            console.error(LOG, 'draw failed', err);
        }
    }

    start();
})();
