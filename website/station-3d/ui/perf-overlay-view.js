// The perf overlay's DOM: a fixed-size box with a live pane of coloured topic
// sections on top and a scrolling stutter log below.
//
// Split out of scene/animate.js so the view can be opened and driven WITHOUT
// booting the 3D world — animate.js imports three.js, so anything living there
// can only be looked at by starting a ride. perf-overlay-preview.html feeds this
// module fabricated frames and is the cheap way to check colour, size and the
// log's behaviour. What the overlay should SAY is core/perf-overlay-model.js;
// this file only turns those sections into spans.

import {
    buildPerfSections,
    describeStutter,
    formatStutterLogText,
    STUTTER_MS,
    STUTTER_RENDER_LIMIT,
    stutterLogDelta,
    TONE_COLORS,
} from '../core/perf-overlay-model.js';
import { finiteOrNull } from '../core/math.js';

const STUTTER_ROWS_PER_UPDATE = 4;

// Every rendered line carries data-perf-line so a copy can rebuild the plain
// text with its newlines intact. textContent alone would run the whole box
// together on one line now that rows are elements rather than one \n-joined
// string, and a readout you cannot paste into a bug report is half a diagnostic.
function perfTextOf(root) {
    if (!root) return '';
    return [...root.querySelectorAll('[data-perf-line]')]
        .map(el => el.textContent)
        .join('\n');
}

// Flash green on success, red if the clipboard is unavailable.
function copyPerfText(text, flashTarget) {
    const base = flashTarget?.style.background || '';
    const flash = (ok) => {
        if (!flashTarget) return;
        flashTarget.style.background = ok ? 'rgba(40,160,60,0.85)' : 'rgba(190,60,50,0.85)';
        setTimeout(() => { if (flashTarget) flashTarget.style.background = base; }, 400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => flash(true), () => flash(false));
    } else {
        flash(false);
    }
}

function renderSegments(parent, segments) {
    for (const { text, tone } of segments) {
        const span = document.createElement('span');
        span.textContent = text;
        span.style.color = TONE_COLORS[tone] || TONE_COLORS.value;
        parent.appendChild(span);
    }
}

function patchSegments(parent, segments, offset = 0) {
    const wanted = offset + segments.length;
    while (parent.children.length < wanted) {
        parent.appendChild(document.createElement('span'));
    }
    while (parent.children.length > wanted) parent.lastElementChild.remove();
    segments.forEach(({ text, tone }, index) => {
        const span = parent.children[offset + index];
        if (span.textContent !== text) span.textContent = text;
        const color = TONE_COLORS[tone] || TONE_COLORS.value;
        if (span.style.color !== color) span.style.color = color;
    });
}

function perfLine() {
    const line = document.createElement('div');
    line.dataset.perfLine = '1';
    line.style.whiteSpace = 'pre';
    return line;
}

function perfButton(label, title, onClick, bindClick) {
    const button = document.createElement('span');
    button.textContent = label;
    button.title = title;
    button.style.cssText = [
        'cursor:pointer', 'padding:0 5px', 'margin-left:4px', 'border-radius:3px',
        `border:1px solid ${TONE_COLORS.muted}`, `color:${TONE_COLORS.label}`,
    ].join(';');
    bindClick(button, (event) => {
        event.stopPropagation();
        onClick(button);
    });
    return button;
}

// Wall-clock, not "12s ago": a log you scroll back through needs a stamp that
// still means something after a minute, and one you can match against a console
// warning or a screen recording. Takes a performance.now()-based value.
function perfClockText(perfMs, timeOriginMs) {
    const at = new Date(timeOriginMs + perfMs);
    return `${String(at.getHours()).padStart(2, '0')}`
        + `:${String(at.getMinutes()).padStart(2, '0')}`
        + `:${String(at.getSeconds()).padStart(2, '0')}`;
}

export function createPerfOverlayView({
    onClear = () => {},
    timeOriginMs = (typeof performance !== 'undefined' ? performance.timeOrigin : 0),
} = {}) {
    const root = document.createElement('div');
    const clickActions = new WeakMap();
    const bindClick = (element, action) => clickActions.set(element, action);
    const rootClickHandler = (event) => {
        let element = event.target;
        while (element && element !== root) {
            const action = clickActions.get(element);
            if (action) {
                action(event);
                return;
            }
            element = element.parentElement;
        }
    };
    root.addEventListener('click', rootClickHandler);
    // Exempt from the modal-isolation hide rule (transit.css) so the F-key
    // perf HUD stays visible during a 3D session, in every mode.
    root.className = 'station3d-dev-overlay';
    // Fixed geometry: anchored top and bottom with a fixed width, so the panes
    // scroll and the BOX never moves. It used to grow and shrink every second
    // with the background list, which moved the line you were reading.
    root.style.cssText = [
        'position:fixed', 'left:20px', 'top:170px', 'bottom:16px', 'z-index:9999',
        'width:min(46vw,560px)', 'box-sizing:border-box',
        'font:11px/1.35 ui-monospace,Menlo,monospace', `color:${TONE_COLORS.value}`,
        'background:rgba(0,0,0,0.72)', 'padding:6px 8px', 'border-radius:4px',
        'display:flex', 'flex-direction:column', 'gap:4px', 'overflow:hidden',
        'pointer-events:auto', 'overscroll-behavior:contain',
    ].join(';');

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;flex:0 0 auto';
    const headlineEl = perfLine();
    headlineEl.style.flex = '1 1 auto';
    renderSegments(headlineEl, [{ text: 'warming up…', tone: 'muted' }]);
    header.append(
        headlineEl,
        perfButton('copy', 'Copy the whole readout (every stutter held, not just the visible rows)',
            button => copyPerfText(copyText(), button), bindClick),
        perfButton('clear', 'Empty the stutter log', () => { clear(); onClear(); }, bindClick),
    );

    // Dev-only "where am I" links: open the current sim position on real maps in
    // a new tab. Only mounted when serving locally (localhost/127.0.0.1) — a
    // navigation aid while building, not a production feature. Reads the cab's
    // published window.__simLatLon each frame in update().
    const isLocalHost = typeof location !== 'undefined'
        && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    const mapsRow = document.createElement('div');
    mapsRow.style.cssText = 'flex:0 0 auto;display:flex;gap:12px;align-items:baseline';
    const mapsLabel = document.createElement('span');
    mapsLabel.textContent = 'here →';
    mapsLabel.style.color = TONE_COLORS.muted;
    // Resolved ON CLICK, never per frame: read the cab's last published position
    // and open it in a new tab. No live display, no per-frame overlay work.
    const openHere = (kind) => (event) => {
        event.preventDefault();
        const here = typeof window !== 'undefined' ? window.__simLatLon : null;
        if (!here || !Number.isFinite(here.lat) || !Number.isFinite(here.lon)) return;
        const lat = here.lat.toFixed(6);
        const lon = here.lon.toFixed(6);
        const url = kind === 'gmaps'
            ? `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`
            : `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}`;
        window.open(url, '_blank', 'noopener');
    };
    const mapLink = (label, kind) => {
        const anchor = document.createElement('a');
        anchor.textContent = label;
        anchor.href = '#';
        anchor.style.cssText = `color:${TONE_COLORS.value};text-decoration:underline;cursor:pointer;pointer-events:auto`;
        bindClick(anchor, openHere(kind));
        return anchor;
    };
    mapsRow.append(mapsLabel, mapLink('Google Maps ↗', 'gmaps'), mapLink('OSM ↗', 'osm'));

    const liveEl = document.createElement('div');
    liveEl.className = 'station3d-perf-scroll-pane';
    // The live readout and stutter pane each own exactly half of the space left
    // below the fixed header rows. Content growth scrolls inside its pane and
    // never steals height from the other pane.
    liveEl.style.cssText = 'flex:1 1 0;height:0;overflow-y:auto;min-height:0';
    const warmingLine = perfLine();
    renderSegments(warmingLine, [
        { text: 'WORLD   ', tone: 'heading' },
        { text: 'warming up · waiting for first complete 1 s window', tone: 'muted' },
    ]);
    liveEl.appendChild(warmingLine);

    const logHeader = document.createElement('div');
    logHeader.style.cssText = [
        'flex:0 0 auto', `border-top:1px solid ${TONE_COLORS.muted}`, 'padding-top:3px',
    ].join(';');
    const logCountEl = perfLine();
    renderSegments(logCountEl, [
        { text: 'STUTTERS ', tone: 'heading' },
        { text: '0', tone: 'good' },
        { text: '  · waiting for first complete window', tone: 'muted' },
    ]);
    logHeader.appendChild(logCountEl);

    const logEl = document.createElement('div');
    logEl.className = 'station3d-perf-scroll-pane';
    logEl.style.cssText = 'flex:1 1 auto;overflow-y:auto;min-height:0';
    // Scrolling the log must not also drive the cab's zoom underneath it.
    const stopLogWheelPropagation = event => event.stopPropagation();
    logEl.addEventListener('wheel', stopLogWheelPropagation, { passive: true });

    const logPane = document.createElement('div');
    logPane.style.cssText = 'flex:1 1 0;height:0;min-height:0;display:flex;flex-direction:column';
    logPane.append(logHeader, logEl);

    root.append(header, ...(isLocalHost ? [mapsRow] : []), liveEl, logPane);

    // atMs of the newest entry already in the DOM. The log is built incrementally
    // — re-rendering sixty entries every second would have this overlay
    // perturbing the very frames it exists to measure.
    let renderedAtMs = null;
    // The DOM holds only the newest STUTTER_RENDER_LIMIT rows; this holds the
    // whole five-minute window so `copy` is complete. Keeping 6,000 entries in
    // memory costs ~2 MB; putting them in the DOM would cost ~48,000 nodes and
    // make the overlay jank, which would corrupt the very frames it measures.
    let allStutters = [];
    let liveBlocks = [];

    function buildStutterRow(entry) {
        const described = describeStutter(entry);
        const wrap = document.createElement('div');
        wrap.style.cssText = [
            'padding:1px 0 1px 5px', 'margin-bottom:2px', 'cursor:pointer',
            `border-left:2px solid ${described.hostBusy ? TONE_COLORS.host : TONE_COLORS[described.severity]}`,
            described.hostBusy ? 'opacity:0.72' : '',
        ].filter(Boolean).join(';');
        wrap.title = 'Click to copy this stutter';

        const head = perfLine();
        renderSegments(head, [
            { text: `${perfClockText(described.atMs, timeOriginMs)}  `, tone: 'muted' },
            { text: `${described.frameText.padStart(6)}  `, tone: described.severity },
            { text: described.cause, tone: 'heading' },
            // A spike measured while the MACHINE was contended is not evidence
            // about our code. Marking the row is the whole point of sampling
            // host load — otherwise you read the log and blame the renderer.
            ...(described.hostBusy
                ? [{ text: '  ⚠ host busy', tone: 'host' }]
                : []),
            // Catch-up while the observer is stopped is the scheduler working as
            // designed, not a hitch anyone felt. Marked rather than hidden: it
            // is still real time, and a stationary burst that never ends is
            // still worth seeing.
            ...(described.stationary
                ? [{ text: '  · stopped', tone: 'muted' }]
                : []),
        ]);

        const detail = perfLine();
        renderSegments(detail, [
            { text: `          ${described.breakdown}`, tone: 'muted' },
            ...(described.alsoLayers ? [{ text: `  · ${described.alsoLayers}`, tone: 'layer' }] : []),
            // "idle" is the common case and says nothing; only a real backlog
            // earns a mention, because the question this answers is which build
            // was running when the frame went long.
            ...(described.background && described.background !== 'idle'
                ? [{ text: `  · while ${described.background}`, tone: 'queue' }]
                : []),
        ]);

        wrap.append(head, detail);
        bindClick(wrap, (event) => {
            event.stopPropagation();
            // A click that ends a text selection is the user reading, not copying.
            if (String(window.getSelection?.() || '').length > 0) return;
            copyPerfText(perfTextOf(wrap), wrap);
        });
        return wrap;
    }

    function renderLive(sections) {
        // Keep the row/span tree stable and patch values in place. Recreating
        // the entire pane every second forced layout and made the profiler
        // contribute recurring 16-34 ms perf:windowUpdate frames of its own.
        if (liveBlocks.length === 0) liveEl.replaceChildren();
        sections.forEach((section, sectionIndex) => {
            let record = liveBlocks[sectionIndex];
            if (!record) {
                const block = document.createElement('div');
                block.style.marginBottom = '3px';
                record = { block, lines: [] };
                liveBlocks[sectionIndex] = record;
                liveEl.appendChild(block);
            }
            section.rows.forEach((row, rowIndex) => {
                let line = record.lines[rowIndex];
                if (!line) {
                    line = perfLine();
                    line.appendChild(document.createElement('span'));
                    record.lines[rowIndex] = line;
                    record.block.appendChild(line);
                }
                const title = line.children[0];
                const titleText = (rowIndex === 0 ? section.title : '').padEnd(8);
                if (title.textContent !== titleText) title.textContent = titleText;
                const titleColor = TONE_COLORS[section.tone] || TONE_COLORS.heading;
                if (title.style.color !== titleColor) title.style.color = titleColor;
                title.style.fontWeight = rowIndex === 0 ? '700' : '';
                patchSegments(line, row, 1);
            });
            while (record.lines.length > section.rows.length) {
                record.lines.pop().remove();
            }
        });
        while (liveBlocks.length > sections.length) {
            liveBlocks.pop().block.remove();
        }
    }

    // Prepend only what is new, so a session's worth of spikes costs one row each
    // rather than sixty rows a second, and so scroll position survives an arrival.
    function renderLog(stutters, { total, startedAtMs, thresholdMs, windowMs }) {
        allStutters = Array.isArray(stutters) ? stutters : [];
        const held = allStutters.length;
        const hidden = Math.max(0, held - STUTTER_RENDER_LIMIT);
        patchSegments(logCountEl, [
            { text: 'STUTTERS ', tone: 'heading' },
            { text: String(total), tone: total > 0 ? 'major' : 'good' },
            { text: `  since ${perfClockText(startedAtMs, timeOriginMs)}`, tone: 'muted' },
            { text: `  ·  ≥${thresholdMs}ms`, tone: 'muted' },
            { text: `  ·  last ${Math.round((windowMs || 0) / 60000)} min (${held})`, tone: 'muted' },
            // Never a silent cap: if rows are being withheld from the DOM, say
            // so and say that copy still has them.
            ...(hidden > 0
                ? [{ text: `  ·  ${hidden} more in copy`, tone: 'warn' }]
                : []),
        ]);

        const { fresh, newestAtMs } = stutterLogDelta(stutters, renderedAtMs);
        if (fresh.length === 0) return;

        const stickToTop = logEl.scrollTop <= 2;
        // Reading scrollHeight forces layout for the newly replaced live pane
        // too. At the common top-of-log position that 17-18 ms synchronous
        // reflow made the profiler create its own 30 Hz stutters. Only preserve
        // a scrolled reader's offset; the sticky-top path needs no height read.
        const heightBefore = stickToTop ? 0 : logEl.scrollHeight;
        // A burst can add dozens of rows at once on a 30 Hz display. Building
        // all of those nodes in the measured frame made the diagnostic feed
        // back into itself. Render a bounded oldest-first slice; later updates
        // catch up, while copy continues to use the complete data history.
        const renderFresh = fresh.slice(0, STUTTER_ROWS_PER_UPDATE);
        for (const entry of renderFresh) logEl.insertBefore(buildStutterRow(entry), logEl.firstChild);
        renderedAtMs = renderFresh.at(-1)?.atMs ?? newestAtMs;
        // Trim to the render cap, and also to the history itself: entries that
        // aged out of the window must not linger on screen claiming to be recent.
        const maxRows = Math.min(STUTTER_RENDER_LIMIT, held);
        while (logEl.childElementCount > maxRows) logEl.lastElementChild.remove();
        // Reading an old spike must not be yanked away when a new one lands.
        if (stickToTop) logEl.scrollTop = 0;
        else logEl.scrollTop += logEl.scrollHeight - heightBefore;
    }

    // Live panes come from the DOM (they ARE the DOM), the log from the data.
    function copyText() {
        const live = [header, liveEl, logHeader].map(perfTextOf).filter(Boolean).join('\n');
        const log = formatStutterLogText(allStutters, at => perfClockText(at, timeOriginMs));
        return log ? `${live}\n${log}` : live;
    }

    function clear() {
        renderedAtMs = null;
        allStutters = [];
        logEl.textContent = '';
    }

    return {
        el: root,
        clear,
        setTop(px) { root.style.top = `${px}px`; },
        // Restoring an empty inline display value falls back to block and
        // collapses both height:0 flex panes. The collector keeps updating,
        // which leaves only the overflowing STUTTERS header visible. Restore
        // the layout mode itself when F makes the overlay visible again.
        setVisible(visible) { root.style.display = visible ? 'flex' : 'none'; },
        destroy() {
            root.removeEventListener('click', rootClickHandler);
            logEl.removeEventListener('wheel', stopLogWheelPropagation);
            root.remove();
        },
        update({ fps = 0, frameAvgMs = 0, stutters = [], stutterTotal = 0,
            logStartedAtMs = 0, stutterThresholdMs = STUTTER_MS, stutterWindowMs = 0,
            ...sectionInput } = {}) {
            const safeFps = finiteOrNull(fps) ?? 0;
            const safeFrameAvgMs = finiteOrNull(frameAvgMs) ?? 0;
            renderLive(buildPerfSections({
                fps: safeFps,
                frameAvgMs: safeFrameAvgMs,
                ...sectionInput,
            }));
            patchSegments(headlineEl, [
                { text: 'PERF  ', tone: 'heading' },
                { text: `${safeFps.toFixed(0)}fps`, tone: safeFps < 30 ? 'severe' : (safeFps < 50 ? 'warn' : 'good') },
                { text: ` · ${safeFrameAvgMs.toFixed(1)}ms`, tone: 'muted' },
            ]);
            renderLog(stutters, {
                total: stutterTotal,
                startedAtMs: logStartedAtMs,
                thresholdMs: stutterThresholdMs,
                windowMs: stutterWindowMs,
            });
        },
    };
}
