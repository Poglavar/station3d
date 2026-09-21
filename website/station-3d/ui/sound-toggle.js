// Persistent Station3D mute control. The button lives beside the minimap and
// world-status icons; audio-unlock.js owns the actual cross-context master mute.

import { t, onLangChange } from '../core/i18n.js';
import {
    isAudioMuted,
    onAudioMuteChange,
    toggleAudioMuted,
} from '../core/audio-unlock.js';

let buttonEl = null;

function iconSvg(muted) {
    const speaker = '<path d="M4 10h4l5-4v12l-5-4H4Z" fill="currentColor"/>';
    const state = muted
        ? '<path d="m17 9 5 6m0-6-5 6" fill="none" stroke="currentColor" '
            + 'stroke-width="1.9" stroke-linecap="round"/>'
        : '<path d="M16 9.2a4 4 0 0 1 0 5.6M18.5 6.8a7.3 7.3 0 0 1 0 10.4" '
            + 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>';
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${speaker}${state}</svg>`;
}

function refresh() {
    if (!buttonEl) return;
    const muted = isAudioMuted();
    const label = t(muted ? 'sound.unmute' : 'sound.mute');
    buttonEl.innerHTML = iconSvg(muted);
    buttonEl.setAttribute('aria-label', label);
    buttonEl.setAttribute('aria-pressed', String(muted));
    buttonEl.title = label;
    buttonEl.classList.toggle('is-muted', muted);
}

export function getSoundToggleEl() {
    if (buttonEl) return buttonEl;
    buttonEl = document.createElement('button');
    buttonEl.type = 'button';
    buttonEl.className = 'station-3d-header-sound';
    buttonEl.addEventListener('click', toggleAudioMuted);
    onAudioMuteChange(refresh);
    onLangChange(refresh);
    refresh();
    return buttonEl;
}

export function setSoundToggleVisible(visible) {
    if (buttonEl) buttonEl.style.display = visible ? 'inline-flex' : 'none';
}
