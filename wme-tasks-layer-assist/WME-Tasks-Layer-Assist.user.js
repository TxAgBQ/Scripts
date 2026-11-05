// ==UserScript==
// @name         WME Tasks Layer Assist
// @namespace    https://github.com/TxAgBQ/Scripts
// @version      2026.11.05.02
// @description  Adds per-type visibility checkboxes (Update requests, Map suggestions) under the Tasks layer in the WME Map layers panel.
// @author       TxAgBQ
// @match        https://*.waze.com/*/editor*
// @match        https://*.waze.com/editor*
// @exclude      https://*.waze.com/user/editor*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=waze.com
// @grant        none
// @run-at       document-end
// @homepageURL  https://github.com/TxAgBQ/Scripts/tree/main/wme-tasks-layer-assist
// @downloadURL  https://github.com/TxAgBQ/Scripts/raw/refs/heads/main/wme-tasks-layer-assist/WME-Tasks-Layer-Assist.user.js
// @updateURL    https://github.com/TxAgBQ/Scripts/raw/refs/heads/main/wme-tasks-layer-assist/WME-Tasks-Layer-Assist.user.js
// ==/UserScript==

(function () {
    'use strict';

    if (window.__wmeTasksLayerAssistLoaded) return;
    window.__wmeTasksLayerAssistLoaded = true;

    const SCRIPT_ID = 'wme-tasks-layer-assist';
    const SCRIPT_NAME = 'WME Tasks Layer Assist';
    const STORAGE_KEY = 'wme-tasks-layer-assist';
    const TASKS_TOGGLE_ID = 'layer-switcher-group_issues_tracker';
    const GROUP_ATTR = 'data-wta-group';
    const NUDGE_DEG = 0.0002;          // ~20 m; used to make WME redraw a layer that was switched back on
    const UI_CHECK_MS = 750;           // how often to make sure the group is in the Map layers panel
    const FALLBACK_AFTER_MISSES = 8;   // panel found but group could not be built this many checks in a row
    const DEBUG = false;

    // Add more issue types here later. layerName must be a valid SDK layer name
    // (see sdk.LayerSwitcher.getWMELayerVisibility): updateRequests, editSuggestions, mapProblems, ...
    const TYPES = [
        { key: 'updateRequests', label: 'Update requests', layerName: 'updateRequests' },
        { key: 'editSuggestions', label: 'Map suggestions (existing)', layerName: 'editSuggestions' },
    ];

    const log = (...a) => { if (DEBUG) console.log('[' + SCRIPT_NAME + ']', ...a); };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // ---------- saved state (localStorage, like WME's own layer settings) ----------
    const state = {};
    TYPES.forEach((t) => { state[t.key] = true; });

    function loadState() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            Object.keys(state).forEach((k) => { if (typeof saved[k] === 'boolean') state[k] = saved[k]; });
        } catch (e) { log('Could not read saved state', e); }
    }

    // Only the key that changed is written, so another open tab's other settings are not overwritten.
    function saveKey(key) {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            saved[key] = state[key];
            localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
        } catch (e) { log('Could not save state', e); }
    }

    // ---------- WME SDK (async mode) ----------
    let sdk = null;

    async function waitForSdk() {
        for (let i = 0; i < 240; i++) {
            if (window.SDK_INITIALIZED && typeof window.getWmeSdk === 'function') {
                await window.SDK_INITIALIZED;
                return window.getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME, mode: 'async' });
            }
            await sleep(500);
        }
        throw new Error('WME SDK not available');
    }

    async function waitForLayers() {
        for (let i = 0; i < 120; i++) {
            try {
                await sdk.LayerSwitcher.getWMELayerVisibility({ layerName: TYPES[0].layerName });
                return;
            } catch (e) { await sleep(500); }
        }
        throw new Error('WME layers not ready');
    }

    // One job at a time, so a map nudge never overlaps another layer change.
    let queue = Promise.resolve();
    function enqueue(fn) {
        queue = queue.then(fn).catch((e) => console.warn('[' + SCRIPT_NAME + ']', e));
        return queue;
    }

    // Returns true if the layer's visibility actually changed.
    async function setLayer(type, visible) {
        const current = await sdk.LayerSwitcher.getWMELayerVisibility({ layerName: type.layerName });
        if (current === visible) return false;
        await sdk.LayerSwitcher.setWMELayerVisibility({ layerName: type.layerName, isVisible: visible });
        return true;
    }

    // WME does not redraw a layer's icons when it is switched back on; a real map move does.
    // Shift the map a few meters and back. If the user moved the map meanwhile, leave it alone.
    // WME also closes the Map layers panel when the redrawn data arrives (a few seconds later).
    // The closed panel is parked off screen, so "open" = the Tasks switch is inside the viewport.
    function tasksSwitchLeft() {
        const tog = document.getElementById(TASKS_TOGGLE_ID);
        return tog ? tog.getBoundingClientRect().left : null;
    }

    function isPanelOpen() {
        const x = tasksSwitchLeft();
        return x !== null && x < window.innerWidth && x > 0 && document.getElementById(TASKS_TOGGLE_ID).getBoundingClientRect().width > 0;
    }

    // If the panel was open before the nudge, reopen it each time WME closes it (the map move triggers a data load). A close must be seen on two checks in a row, so a click never
    // lands in the middle of the slide animation. At most 2 reopens.
    async function watchPanel(openX) {
        if (openX === null) return;
        const btn = () => document.querySelector('wz-button.layer-switcher-button');
        const until = Date.now() + 18000;
        let stable = 0;
        let clicks = 0;
        // If the user clicks the layers button themselves, stop; never fight a real click.
        let userClicked = false;
        const onClick = (e) => { if (e.isTrusted && e.target && e.target.closest && e.target.closest('wz-button.layer-switcher-button')) userClicked = true; };
        document.addEventListener('click', onClick, true);
        try {
            while (Date.now() < until && clicks < 2 && !userClicked) {
                await sleep(250);
                if (userClicked) break;
                const x = tasksSwitchLeft();
                stable = x !== null && x > openX + 150 ? stable + 1 : 0;
                if (stable >= 2) {
                    const b = btn();
                    if (!b) return;
                    b.click();
                    clicks++;
                    stable = 0;
                    await sleep(1500);
                }
            }
        } finally {
            document.removeEventListener('click', onClick, true);
        }
    }

    async function nudgeMap() {
        watchPanel(isPanelOpen() ? tasksSwitchLeft() : null); // not awaited: runs alongside the nudge
        const start = await sdk.Map.getMapCenter();
        const shifted = { lon: start.lon + NUDGE_DEG, lat: start.lat };
        await sdk.Map.setMapCenter({ lonLat: shifted });
        await sleep(150);
        const now = await sdk.Map.getMapCenter();
        if (Math.abs(now.lon - shifted.lon) < NUDGE_DEG / 4 && Math.abs(now.lat - shifted.lat) < NUDGE_DEG / 4) {
            await sdk.Map.setMapCenter({ lonLat: start });
        }
    }

    async function applyAll() {
        let shown = false;
        for (const t of TYPES) {
            const changed = await setLayer(t, state[t.key]);
            if (changed && state[t.key]) shown = true;
        }
        if (shown) await nudgeMap();
    }

    function onTypeChanged(type, checked) {
        state[type.key] = checked;
        saveKey(type.key);
        enqueue(async () => {
            const changed = await setLayer(type, checked);
            if (changed && checked) { showBusy(type, 9000); await nudgeMap(); }
        });
    }

    // ---------- Map layers panel UI ----------
    // The panel's class names are hashed and change between WME builds, so the group is built by
    // cloning an existing native group at runtime (its real classes come along) and located by
    // stable ids / data-testid values only.

    // Prefers a group that is currently expanded, so the clone starts out looking expanded.
    function findTemplate(tasksLi) {
        let fallback = null;
        for (const li of tasksLi.parentElement.children) {
            if (li.tagName !== 'LI' || li.hasAttribute(GROUP_ATTR)) continue;
            const cat = li.querySelector('[data-testid="toggler-tree-category"]');
            const area = li.querySelector('[data-testid^="collapsible-group"]');
            if (!cat || !area || !cat.querySelector('wz-button') || !cat.querySelector('label')) continue;
            const proto = [...area.querySelectorAll('li')].find(
                (x) => !x.querySelector('ul') && x.querySelector('[data-testid="layer-selector"] > wz-checkbox')
            );
            if (!proto) continue;
            const candidate = { group: li, cat, area, proto };
            if (area.getAttribute('aria-expanded') === 'true') return candidate;
            fallback = fallback || candidate;
        }
        return fallback;
    }

    const labelEls = {};

    // Redrawing takes several seconds; show that the click registered.
    function showBusy(type, ms) {
        const el = labelEls[type.key];
        if (!el) return;
        el.textContent = type.label + ' (loading\u2026)';
        setTimeout(() => { el.textContent = type.label; }, ms);
    }

    function buildGroup(tpl) {
        const group = tpl.group.cloneNode(true);
        group.setAttribute(GROUP_ATTR, '1');

        const cat = group.querySelector('[data-testid="toggler-tree-category"]');
        const area = group.querySelector('[data-testid^="collapsible-group"]');
        cat.setAttribute('data-wta-cat', '1');
        area.setAttribute('data-wta-area', '1');
        // Our clone must not answer to WME's own ids / test ids.
        group.querySelectorAll('[id]').forEach((e) => e.removeAttribute('id'));
        group.querySelectorAll('[data-testid]').forEach((e) => e.removeAttribute('data-testid'));

        // Sub-section: no header or arrow of its own; the checkboxes sit directly under Tasks, indented.
        cat.style.display = 'none';
        area.setAttribute('aria-expanded', 'true');
        area.style.display = '';
        area.style.paddingInlineStart = '16px';

        // Body: one checkbox per type, each cloned from a native checkbox row.
        const list = area.querySelector('ul');
        list.replaceChildren();
        area.replaceChildren(list);
        TYPES.forEach((t) => {
            const li = tpl.proto.cloneNode(true);
            li.querySelectorAll('[id]').forEach((e) => e.removeAttribute('id'));
            li.querySelectorAll('[data-testid]').forEach((e) => e.removeAttribute('data-testid'));
            const cb = li.querySelector('wz-checkbox');
            cb.setAttribute('name', 'wta-' + t.key);
            cb.textContent = t.label;
            labelEls[t.key] = cb;
            if (state[t.key]) cb.setAttribute('checked', ''); else cb.removeAttribute('checked');
            cb.checked = state[t.key];
            cb.addEventListener('change', () => onTypeChanged(t, !!cb.checked));
            list.appendChild(li);
        });

        return group;
    }

    // When Tasks is switched off and on again, make sure our unchecked types stay hidden.
    function bindTasksToggle(tog) {
        if (tog.dataset.wtaBound) return;
        tog.dataset.wtaBound = '1';
        tog.addEventListener('change', () => enqueue(async () => { await sleep(600); await applyAll(); }));
    }

    let misses = 0;
    let fallbackActive = false;

    // Returns without doing anything if the Map layers panel is not in the page yet.
    function ensureUi() {
        if (fallbackActive) return;
        const tog = document.getElementById(TASKS_TOGGLE_ID);
        const tasksLi = tog && tog.closest('li');
        if (!tasksLi || !tasksLi.parentElement) return;
        bindTasksToggle(tog);
        if (tasksLi.parentElement.querySelector('[' + GROUP_ATTR + ']')) { misses = 0; return; }
        try {
            const tpl = findTemplate(tasksLi);
            if (tpl) {
                tasksLi.insertAdjacentElement('afterend', buildGroup(tpl));
                misses = 0;
                log('Group added under Tasks');
                return;
            }
        } catch (e) { log('Could not build group', e); }
        if (++misses >= FALLBACK_AFTER_MISSES) enableFallback();
    }

    // If WME's panel markup changes and the group cannot be built, fall back to plain SDK checkboxes.
    // They live in the shared "Userscripts" group (the SDK cannot place them elsewhere).
    async function enableFallback() {
        if (fallbackActive) return;
        fallbackActive = true;
        console.warn('[' + SCRIPT_NAME + '] Could not add the group under Tasks; using Userscripts checkboxes instead.');
        const nameOf = (t) => 'Tasks: ' + t.label;
        try {
            for (const t of TYPES) {
                await sdk.LayerSwitcher.addLayerCheckbox({ name: nameOf(t) });
                await sdk.LayerSwitcher.setLayerCheckboxChecked({ name: nameOf(t), isChecked: state[t.key] });
            }
            sdk.Events.on({
                eventName: 'wme-layer-checkbox-toggled',
                eventHandler: ({ name, checked }) => {
                    const t = TYPES.find((x) => nameOf(x) === name);
                    if (t) onTypeChanged(t, checked);
                },
            });
        } catch (e) { console.warn('[' + SCRIPT_NAME + ']', e); }
    }

    async function init() {
        loadState();
        sdk = await waitForSdk();
        await waitForLayers();
        await enqueue(applyAll);
        ensureUi();
        setInterval(ensureUi, UI_CHECK_MS);
        log('Ready', state);
    }

    init().catch((e) => console.warn('[' + SCRIPT_NAME + '] Could not start:', e));
})();
