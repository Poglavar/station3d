// Small status light in the cab/walk header, right of the 🗺️ button: amber while the objects
// the 3D world is built from are still being fetched or built, green once that work has caught
// up, red if something never arrived. It is the one-glyph version of the FPS overlay's
// "background" block, so you can tell a half-built world from a finished one without opening
// the dev overlay.
//
// Sampled from the frame loop rather than a timer, but only ~4x a second: aggregating every
// registered reader on every frame would be pure overhead for a dot that cannot change that fast.

import { getBackgroundActivitySnapshot } from '../core/background-activity.js';
import { t } from '../core/i18n.js';
import { computeWorldStatus, worldStatusLabel, WORLD_STATUS_COLORS } from '../core/world-status.js';
import { onBeforeRender } from '../scene/animate.js';

const SAMPLE_INTERVAL_MS = 250;

let dotEl = null;
let unregisterHook = null;
let lastSampleMs = 0;
let lastState = null;

function applyStatus(status) {
    if (!dotEl) return;
    if (status.state !== lastState) {
        lastState = status.state;
        dotEl.style.background = WORLD_STATUS_COLORS[status.state] || WORLD_STATUS_COLORS.loading;
        // A faint halo in the same colour so the state reads at a glance against the sky.
        dotEl.style.boxShadow = `0 0 6px ${WORLD_STATUS_COLORS[status.state]}`;
    }
    dotEl.title = worldStatusLabel(status, t);
}

function sample(nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : performance.now();
    if (now - lastSampleMs < SAMPLE_INTERVAL_MS) return;
    lastSampleMs = now;
    refreshWorldStatusDot();
}

// Read the counters and repaint the dot now, skipping the sampling interval. The frame hook
// throttles to this; exported so the state can be driven and observed without a running loop.
export function refreshWorldStatusDot() {
    const status = computeWorldStatus(getBackgroundActivitySnapshot());
    applyStatus(status);
    return status;
}

// Creates the element on first call and starts sampling. Returns the element so the caller can
// place it; it is a singleton, so repeated calls hand back the same dot.
export function getWorldStatusDotEl() {
    if (dotEl) return dotEl;

    dotEl = document.createElement('span');
    dotEl.className = 'station-3d-world-status';
    dotEl.style.cssText = [
        'width:10px',
        'height:10px',
        'flex:0 0 10px',
        'margin:0 0 0 6px',
        'border-radius:50%',
        'display:inline-block',
        'pointer-events:auto',
        'border:1px solid rgba(0,0,0,0.35)',
        `background:${WORLD_STATUS_COLORS.loading}`,
    ].join(';');
    // Placeholder until the first sample lands; the dot starts amber.
    dotEl.title = worldStatusLabel({ state: 'loading', pending: 0, retrying: 0, failed: 0 }, t);

    if (!unregisterHook) unregisterHook = onBeforeRender(sample);
    return dotEl;
}

export function stopWorldStatusDot() {
    if (unregisterHook) unregisterHook();
    unregisterHook = null;
    lastSampleMs = 0;
    lastState = null;
}
