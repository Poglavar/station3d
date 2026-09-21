// A one-shot "enable sound" pill for sessions that open the cab without a
// user gesture (the /voznja deeplink auto-opens it on page load). Browsers
// refuse to start an AudioContext until the document has been interacted
// with, so every audio module here waits on the shared unlock gate — which
// on an auto-opened ride never opens, because nothing ever asks the player
// to click. This pill is that ask. Clicking it is itself the gesture: the
// global pointerdown listener in core/audio-unlock.js fires first, the gate
// opens, and the pill removes itself.

import { containerEl } from './modal.js';
import { hasAudioUnlock, isAudioMuted, whenAudioUnlocked } from '../core/audio-unlock.js';
import { t, onLangChange } from '../core/i18n.js';

let promptEl = null;
let unlockCancel = null;
let langCancel = null;

function build() {
    promptEl = document.createElement('button');
    promptEl.type = 'button';
    // Bottom offset comes from this class so the dashboard console can lift
    // the pill above itself (.station-3d-has-dashboard override).
    promptEl.className = 'station-3d-sound-prompt';
    promptEl.textContent = t('sound.enable');
    promptEl.setAttribute('aria-label', t('sound.enable'));
    promptEl.style.cssText = [
        'position:absolute',
        'left:50%',
        'transform:translateX(-50%)',
        // transit.css has a global `select, button { width:100%; margin-top:5px }`
        // for the planner sidebar. Opt out or the pill spans the viewport.
        'width:auto',
        'margin:0',
        'padding:11px 20px',
        'border-radius:999px',
        'border:1px solid rgba(255,255,255,0.28)',
        'background:rgba(15,23,42,0.82)',
        'color:#f8fafc',
        'font:600 15px/1 ui-sans-serif,system-ui,sans-serif',
        'display:flex',
        'align-items:center',
        'gap:8px',
        'box-shadow:0 8px 22px rgba(0,0,0,0.35)',
        'backdrop-filter:blur(6px)',
        '-webkit-backdrop-filter:blur(6px)',
        'touch-action:manipulation',
        'user-select:none',
        '-webkit-user-select:none',
        'z-index:9',
        'pointer-events:auto',
        'cursor:pointer',
    ].join(';');
    // Belt and braces: the window-level unlock listener already fires on the
    // pointerdown that precedes this click, but a keyboard-activated button
    // should hide itself too.
    promptEl.addEventListener('click', hideSoundPrompt);
    containerEl.appendChild(promptEl);

    langCancel = onLangChange(() => {
        if (!promptEl) return;
        promptEl.textContent = t('sound.enable');
        promptEl.setAttribute('aria-label', t('sound.enable'));
    });
}

// Show the pill only when audio is still locked. A ride entered by clicking
// "U kabinu" on the map has already spent its gesture, so nothing appears.
export function ensureSoundPrompt() {
    if (!containerEl || promptEl) return;
    if (isAudioMuted()) return;
    if (hasAudioUnlock()) return;
    build();
    unlockCancel = whenAudioUnlocked(hideSoundPrompt);
}

export function hideSoundPrompt() {
    if (unlockCancel) {
        unlockCancel();
        unlockCancel = null;
    }
    if (langCancel) {
        langCancel();
        langCancel = null;
    }
    if (promptEl) {
        promptEl.removeEventListener('click', hideSoundPrompt);
        promptEl.remove();
        promptEl = null;
    }
}
