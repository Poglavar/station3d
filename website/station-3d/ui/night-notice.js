// A one-shot pill for free roam entered after dark: the sky follows the real
// clock in Croatia, so a player who opens the world in the evening walks into
// night without being told why. Offer noon or leave it dark; either choice
// removes the pill. Shown by the cab once the world is revealed (cab.js
// offerDaylightIfNight), never for authored scenes or the timetable clock.

import { containerEl } from './modal.js';
import { t, onLangChange } from '../core/i18n.js';

let noticeEl = null;
let langCancel = null;

const BUTTON_STYLE = [
    'width:auto',
    'margin:0',
    'padding:9px 16px',
    'border-radius:999px',
    'border:1px solid rgba(255,255,255,0.28)',
    'background:rgba(255,255,255,0.12)',
    'color:#f8fafc',
    'font:600 14px/1 ui-sans-serif,system-ui,sans-serif',
    'touch-action:manipulation',
    'cursor:pointer',
].join(';');

function button(key, onClick) {
    const el = document.createElement('button');
    el.type = 'button';
    el.dataset.text = key;
    el.textContent = t(key);
    el.style.cssText = BUTTON_STYLE;
    el.addEventListener('click', onClick);
    return el;
}

function relabel() {
    if (!noticeEl) return;
    for (const el of noticeEl.querySelectorAll('[data-text]')) el.textContent = t(el.dataset.text);
}

export function ensureNightNotice({ onDaylight } = {}) {
    if (!containerEl || noticeEl) return;
    noticeEl = document.createElement('div');
    noticeEl.className = 'station-3d-night-notice';
    noticeEl.setAttribute('role', 'status');
    // Bottom offset comes from the class so the dashboard console can lift
    // the pill above itself (.station-3d-has-dashboard override, shell.css).
    noticeEl.style.cssText = [
        'position:absolute',
        'left:50%',
        'transform:translateX(-50%)',
        'width:auto',
        'max-width:min(92vw, 440px)',
        'margin:0',
        'padding:12px 16px',
        'border-radius:18px',
        'border:1px solid rgba(255,255,255,0.28)',
        'background:rgba(15,23,42,0.86)',
        'color:#f8fafc',
        'font:500 14px/1.35 ui-sans-serif,system-ui,sans-serif',
        'display:flex',
        'flex-direction:column',
        'align-items:center',
        'gap:10px',
        'text-align:center',
        'box-shadow:0 8px 22px rgba(0,0,0,0.35)',
        'backdrop-filter:blur(6px)',
        '-webkit-backdrop-filter:blur(6px)',
        'user-select:none',
        '-webkit-user-select:none',
        'z-index:9',
        'pointer-events:auto',
    ].join(';');
    const text = document.createElement('span');
    text.dataset.text = 'night.notice';
    text.textContent = t('night.notice');
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:center;gap:8px;';
    actions.append(
        button('night.daylight', () => {
            if (typeof onDaylight === 'function') onDaylight();
            hideNightNotice();
        }),
        button('night.stayDark', hideNightNotice),
    );
    noticeEl.append(text, actions);
    containerEl.appendChild(noticeEl);
    langCancel = onLangChange(relabel);
}

export function hideNightNotice() {
    if (langCancel) {
        langCancel();
        langCancel = null;
    }
    if (noticeEl) {
        noticeEl.remove();
        noticeEl = null;
    }
}
