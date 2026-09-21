// The banner that says why the world is empty. Sits under the top bar, stays
// until dismissed, and is deliberately not a toast: "nothing is prepared here"
// is a standing fact about where you are, not an event that scrolls past.
//
// The decision of WHAT to say lives in core/world-coverage.js; this file only
// renders it.

import { t, onLangChange } from '../core/i18n.js';
import { onCoverageVerdict } from '../core/coverage-probe.js';
import { containerEl } from './modal.js';

let noticeEl = null;
let currentVerdict = null;

const LEVEL_STYLES = {
    // Nothing is here at all — red, because the world you are looking at is not
    // a world, and every conclusion drawn from it would be wrong.
    none: { background: 'rgba(120,20,24,0.92)', border: 'rgba(255,140,140,0.55)' },
    // Part of the bundle is missing — amber; what is drawn is real, just thin.
    warn: { background: 'rgba(122,74,10,0.92)', border: 'rgba(255,205,120,0.55)' },
};

function render() {
    if (!noticeEl || !currentVerdict) return;
    const style = LEVEL_STYLES[currentVerdict.level] || LEVEL_STYLES.warn;
    noticeEl.style.background = style.background;
    noticeEl.style.borderColor = style.border;
    noticeEl.textContent = t(currentVerdict.key, currentVerdict.params);
    noticeEl.title = t('coverage.dismiss');
}

// verdict: the { level, key, params } from assessWorldCoverage, or null to
// clear. mountEl defaults to the 3D session container.
export function showCoverageNotice(verdict, mountEl = containerEl) {
    if (!verdict) {
        hideCoverageNotice();
        return null;
    }
    currentVerdict = verdict;
    if (!noticeEl) {
        if (!mountEl) return null;
        noticeEl = document.createElement('div');
        noticeEl.className = 'station-3d-coverage-notice';
        noticeEl.setAttribute('role', 'status');
        noticeEl.style.cssText = [
            'position:absolute',
            'top:54px',
            'left:50%',
            'transform:translateX(-50%)',
            'max-width:min(560px, calc(100% - 24px))',
            'z-index:40',
            'padding:9px 14px',
            'border-radius:10px',
            'border:1px solid transparent',
            'color:#fff',
            'font:600 0.85rem/1.35 ui-sans-serif,system-ui,sans-serif',
            'text-align:center',
            'cursor:pointer',
            'pointer-events:auto',
            'box-shadow:0 6px 20px rgba(0,0,0,0.35)',
            'backdrop-filter:blur(6px)',
            '-webkit-backdrop-filter:blur(6px)',
        ].join(';');
        noticeEl.addEventListener('click', hideCoverageNotice);
        onLangChange(render);
        mountEl.appendChild(noticeEl);
    }
    noticeEl.style.display = '';
    render();
    return noticeEl;
}

export function hideCoverageNotice() {
    if (noticeEl) noticeEl.style.display = 'none';
}

// Mounts the banner and keeps it in step with the probe. Idempotent: sessions
// open and close repeatedly and the singleton banner survives between them.
let subscribed = false;
export function ensureCoverageNotice() {
    if (subscribed) return;
    subscribed = true;
    onCoverageVerdict(verdict => showCoverageNotice(verdict));
}
