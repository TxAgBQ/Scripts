// ==UserScript==
// @name         WME Profile Edit Stats
// @namespace    https://github.com/TxAgBQ
// @version      2026.10.14.01
// @description  Editor profile page: adds Avg/Tot edits under each week column of Editing Activity, plus an Editing Stats section with per-week breakdowns.
// @author       TxAgBQ (original idea: JustinS83)
// @match        https://www.waze.com/*user/editor*
// @match        https://beta.waze.com/*user/editor*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/* global W */

(function () {
    'use strict';

    const LOG = '[WME Profile Edit Stats]';
    const SETTINGS_KEY = 'WPES_Settings';
    const MAX_WAIT_MS = 30000;
    const POLL_MS = 250;

    const sum = (arr) => arr.reduce((a, b) => a + b, 0);
    const round2 = (n) => Math.round(n * 100) / 100;
    const fmt = (n) => Number(n).toLocaleString();

    function loadSettings() {
        try {
            const s = JSON.parse(localStorage.getItem(SETTINGS_KEY));
            return { expanded: s && typeof s.expanded === 'boolean' ? s.expanded : true };
        } catch (e) {
            return { expanded: true };
        }
    }

    function saveSettings(settings) {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch (e) { /* storage unavailable, ignore */ }
    }

    // Wait until the profile data and the activity grid both exist.
    function waitForPage() {
        const start = Date.now();
        const timer = setInterval(() => {
            try {
                const data = window.W && W.EditorProfile && W.EditorProfile.data;
                const weeks = document.querySelector('.weeks');
                const section = document.querySelector('#editing-activity');
                if (data && Array.isArray(data.editingActivity) && data.editingActivity.length &&
                    weeks && weeks.children.length && section) {
                    clearInterval(timer);
                    run(data.editingActivity.map(Number), weeks, section);
                    return;
                }
            } catch (e) {
                console.warn(LOG, 'waiting:', e);
            }
            if (Date.now() - start > MAX_WAIT_MS) {
                clearInterval(timer);
                console.warn(LOG, 'Gave up waiting for the profile page data/markup.');
            }
        }, POLL_MS);
    }

    function run(activity, weeksEl, section) {
        // Each feature is isolated so one failure cannot take down the other.
        try { addWeekColumnTotals(activity, weeksEl); } catch (e) { console.error(LOG, 'Week totals failed:', e); }
        try { addEditingStats(activity, section); } catch (e) { console.error(LOG, 'Editing Stats failed:', e); }
    }

    /* ---------- Feature 1: Avg / Tot under each week column ---------- */

    function makeCell(text, title, isAvg) {
        const el = document.createElement('div');
        if (isAvg) {
            el.className = 'day';
            el.style.marginTop = '-5px';
        }
        el.style.fontSize = '10px';
        el.style.height = '10px';
        el.style.textAlign = 'center';
        el.title = title;
        el.textContent = text;
        return el;
    }

    function addWeekColumnTotals(activity, weeksEl) {
        if (weeksEl.dataset.wpesDone) return;
        weeksEl.dataset.wpesDone = '1';

        const legend = document.querySelector('.legend');
        if (legend) {
            ['Avg', 'Tot'].forEach((label) => {
                const d = document.createElement('div');
                d.className = 'day-initial';
                d.textContent = label;
                legend.appendChild(d);
            });
        }

        const cols = Array.from(weeksEl.children);
        // Monday = 0 ... Sunday = 6. The last column is the current (partial) week.
        // Note: uses the browser's local date; Waze may roll its day over in a different time zone.
        const todayIdx = (new Date().getDay() + 6) % 7;
        let end = activity.length;

        for (let c = cols.length - 1; c >= 0; c--) {
            const size = c === cols.length - 1 ? todayIdx + 1 : 7;
            const start = Math.max(0, end - size);
            const slice = activity.slice(start, end);
            end = start;
            if (!slice.length) continue;

            const week = cols[c].querySelector('.week');
            if (!week) continue;
            const total = sum(slice);
            week.appendChild(makeCell(String(round2(total / slice.length)),
                `Average edits per day for this week (${slice.length} days)`, true));
            week.appendChild(makeCell(String(total), 'Total edits for this week', false));
        }
    }

    /* ---------- Feature 2: Editing Stats section ---------- */

    function el(tag, text, style) {
        const e = document.createElement(tag);
        if (text !== undefined) e.textContent = text;
        if (style) e.style.cssText = style;
        return e;
    }

    function labelValue(label, value) {
        const wrap = el('div', undefined, 'display:inline-block;');
        wrap.appendChild(el('h4', label));
        wrap.appendChild(el('div', value));
        return wrap;
    }

    function addEditingStats(activity, section) {
        if (document.getElementById('wpes-stats')) return;
        const settings = loadSettings();

        const total = sum(activity);
        const activeDays = activity.filter((x) => x !== 0).length;
        const avgDaily = Math.round(total / activity.length);
        const avgActive = activeDays ? Math.round(total / activeDays) : 0;

        const header = section.querySelector('h3');
        if (header && !/of last \d+ days/.test(header.textContent)) {
            header.textContent += ` (${activeDays} of last ${activity.length} days)`;
        }

        const wrap = el('div');
        wrap.id = 'wpes-stats';
        const title = el('h3', 'Editing Stats', 'cursor:pointer;');
        title.title = 'Click to collapse/expand';
        wrap.appendChild(title);

        const body = el('div');
        body.style.display = settings.expanded ? 'block' : 'none';

        const top = el('div');
        top.appendChild(labelValue('Average Edits per Day', fmt(avgDaily)));
        const second = labelValue('Average Edits per Day (active days only)', fmt(avgActive));
        second.style.marginLeft = '25px';
        top.appendChild(second);
        const totalBox = labelValue(`Total Edits (last ${activity.length} days)`, fmt(total));
        totalBox.style.marginLeft = '25px';
        top.appendChild(totalBox);
        body.appendChild(top);

        const list = el('div', undefined, 'display:flex; flex-flow:row wrap; justify-content:space-around;');
        const periods = Math.floor(activity.length / 7);
        for (let i = 0; i < periods; i++) {
            const slice = activity.slice(activity.length - (i + 1) * 7, activity.length - i * 7);
            const weekTotal = sum(slice);
            const item = el('div', undefined, 'margin-right:20px;');
            item.appendChild(el('h4', i === 0 ? 'Past 7 days' : `Past ${i * 7 + 1} - ${(i + 1) * 7} days`));
            const rows = el('div');
            rows.className = 'editor-progress-item';
            [["Week's Edits", fmt(weekTotal)], ['Average Edits/Day', String(round2(weekTotal / 7))]].forEach(([n, v]) => {
                const name = el('div', n);
                name.className = 'editor-progress__name';
                const count = el('div', v);
                count.className = 'editor-progress__count';
                rows.appendChild(name);
                rows.appendChild(count);
            });
            item.appendChild(rows);
            list.appendChild(item);
        }
        body.appendChild(list);
        wrap.appendChild(body);
        section.appendChild(wrap);

        title.addEventListener('click', () => {
            const show = body.style.display === 'none';
            body.style.display = show ? 'block' : 'none';
            settings.expanded = show;
            saveSettings(settings);
        });
    }

    waitForPage();
})();
