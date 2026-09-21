// Modal chrome: the outer dialog, title, info row, close + ride-share buttons,
// and keyboard/backdrop close handling. Owns DOM references only — no scene
// knowledge — so other UI modules can depend on it without cycling back.

import { escapeHtml } from '../core/text.js';
import { t, onLangChange, getLang, toggleLang } from '../core/i18n.js';
import { getSessionHost } from '../core/session-host.js';

export let modalEl = null;
export let containerEl = null;
export let titleEl = null;
export let closeBtnEl = null;
export let infoEl = null;
export let statusOverlayEl = null;

let rideShareBtnEl = null;
let campaignBtnEl = null;
let controlsHintBtnEl = null;
let walkModeBtnEl = null;
let weaponToggleBtnEl = null;
let autopilotBtnEl = null;
let walkModeBtnVisible = false;
let walkModeBtnEnabled = false;
let controlsHintBtnVisible = false;
let weaponToggleBtnVisible = false;
let weaponToggleBtnEnabled = false;
let autopilotBtnVisible = false;
let autopilotBtnEnabled = false;
let autopilotBtnEngaged = false;
let appliedAutopilotBtnVisible = null;
let appliedAutopilotBtnEnabled = null;
let appliedAutopilotBtnEngaged = null;
let currentRideShareUrl = '';
let currentRideShareUrlProvider = null;
let domListenersBound = false;
let onCloseRequested = null;
let shouldConfirmClose = null;
let closeRequestPending = false;
let exitConfirmEl = null;
let exitConfirmTitleEl = null;
let exitConfirmMessageEl = null;
let exitConfirmNoEl = null;
let exitConfirmYesEl = null;
let exitConfirmPromise = null;
let exitConfirmResolve = null;
let exitConfirmReturnFocus = null;
let campaignStartHandler = null;
let campaignFeatureAvailable = false;
let walkModeStartHandler = null;
let controlsHintHandler = null;
let weaponToggleHandler = null;
let autopilotHandler = null;
let weaponToggleArmed = true;

// Pieces of the header info line. Different async loads write their own keys.
const infoState = { stats: null, buildings: null };

function refreshExitConfirmationText() {
    if (!exitConfirmEl) return;
    exitConfirmTitleEl.textContent = t('session.exitConfirmTitle');
    exitConfirmMessageEl.textContent = t('session.exitConfirmMessage');
    exitConfirmNoEl.textContent = t('session.exitNo');
    exitConfirmYesEl.textContent = t('session.exitYes');
}

function finishExitConfirmation(answer, { restoreFocus = !answer } = {}) {
    if (!exitConfirmPromise) return;
    const resolve = exitConfirmResolve;
    const returnFocus = exitConfirmReturnFocus;
    exitConfirmPromise = null;
    exitConfirmResolve = null;
    exitConfirmReturnFocus = null;
    exitConfirmEl.classList.add('hidden');
    exitConfirmEl.setAttribute('aria-hidden', 'true');
    if (restoreFocus && returnFocus?.isConnected && typeof returnFocus.focus === 'function') {
        returnFocus.focus();
    }
    resolve?.(!!answer);
}

function ensureExitConfirmationDom() {
    if (exitConfirmEl || !modalEl) return;
    exitConfirmEl = document.createElement('div');
    exitConfirmEl.className = 'station-3d-exit-confirm hidden';
    exitConfirmEl.setAttribute('aria-hidden', 'true');

    const card = document.createElement('div');
    card.className = 'station-3d-exit-confirm-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'station3DExitConfirmTitle');
    card.setAttribute('aria-describedby', 'station3DExitConfirmMessage');

    exitConfirmTitleEl = document.createElement('h3');
    exitConfirmTitleEl.id = 'station3DExitConfirmTitle';
    exitConfirmMessageEl = document.createElement('p');
    exitConfirmMessageEl.id = 'station3DExitConfirmMessage';

    const actions = document.createElement('div');
    actions.className = 'station-3d-exit-confirm-actions';
    exitConfirmNoEl = document.createElement('button');
    exitConfirmNoEl.type = 'button';
    exitConfirmNoEl.className = 'station-3d-exit-confirm-no';
    exitConfirmYesEl = document.createElement('button');
    exitConfirmYesEl.type = 'button';
    exitConfirmYesEl.className = 'station-3d-exit-confirm-yes';
    actions.append(exitConfirmNoEl, exitConfirmYesEl);
    card.append(exitConfirmTitleEl, exitConfirmMessageEl, actions);
    exitConfirmEl.appendChild(card);
    // On <body>, not in the modal: the campaign curtain and the film and
    // dialogue reveals cover the modal from <body> (z-index 4200), and an
    // Escape pressed during a chapter load must still show its question.
    document.body.appendChild(exitConfirmEl);

    exitConfirmNoEl.addEventListener('click', () => finishExitConfirmation(false));
    exitConfirmYesEl.addEventListener('click', () => finishExitConfirmation(true));
    exitConfirmEl.addEventListener('click', (event) => {
        if (event.target === exitConfirmEl) finishExitConfirmation(false);
    });
    exitConfirmEl.addEventListener('keydown', (event) => {
        if (event.key !== 'Tab') return;
        if (event.shiftKey && document.activeElement === exitConfirmNoEl) {
            event.preventDefault();
            exitConfirmYesEl.focus();
        } else if (!event.shiftKey && document.activeElement === exitConfirmYesEl) {
            event.preventDefault();
            exitConfirmNoEl.focus();
        }
    });
    refreshExitConfirmationText();
    onLangChange(refreshExitConfirmationText);
}

function askToLeaveSession() {
    ensureExitConfirmationDom();
    if (!exitConfirmEl) return Promise.resolve(false);
    if (exitConfirmPromise) return exitConfirmPromise;
    exitConfirmReturnFocus = document.activeElement;
    exitConfirmPromise = new Promise((resolve) => { exitConfirmResolve = resolve; });
    exitConfirmEl.classList.remove('hidden');
    exitConfirmEl.setAttribute('aria-hidden', 'false');
    // The safe answer owns focus so Enter cannot turn an accidental Escape or
    // close-button click into an immediate exit.
    exitConfirmNoEl.focus();
    return exitConfirmPromise;
}

async function requestModalClose() {
    if (!onCloseRequested || closeRequestPending) return;
    let confirmationRequired = false;
    try { confirmationRequired = shouldConfirmClose?.() === true; } catch (_) {}
    if (!confirmationRequired) {
        onCloseRequested();
        return;
    }
    closeRequestPending = true;
    try {
        if (await askToLeaveSession()) onCloseRequested?.();
    } finally {
        closeRequestPending = false;
    }
}

function ensureStation3DModalMarkup() {
    const existingModal = document.getElementById('station3DModal');
    if (existingModal) return existingModal;

    const modal = document.createElement('div');
    modal.id = 'station3DModal';
    modal.className = 'station-3d-modal hidden';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'station3DTitle');

    const frame = document.createElement('div');
    frame.className = 'station-3d-frame';
    const header = document.createElement('div');
    header.className = 'station-3d-header';
    const title = document.createElement('h3');
    title.id = 'station3DTitle';
    title.textContent = getSessionHost().name || t('modal.defaultTitle');
    const info = document.createElement('span');
    info.id = 'station3DInfo';
    info.className = 'station-3d-info';
    const close = document.createElement('button');
    close.id = 'station3DClose';
    close.type = 'button';
    close.className = 'station-3d-close';
    close.setAttribute('aria-label', t('campaign.close'));
    close.innerHTML = '&times;';
    header.append(title, info, close);

    const container = document.createElement('div');
    container.id = 'station3DContainer';
    container.className = 'station-3d-container';
    const status = document.createElement('div');
    status.id = 'station3DStatusOverlay';
    status.className = 'station-3d-status hidden';
    container.append(status);
    frame.append(header, container);
    modal.append(frame);
    document.body.append(modal);
    return modal;
}

export function ensureModalDom(onClose, options = {}) {
    ensureStation3DModalMarkup();
    modalEl = document.getElementById('station3DModal');
    containerEl = document.getElementById('station3DContainer');
    titleEl = document.getElementById('station3DTitle');
    closeBtnEl = document.getElementById('station3DClose');
    infoEl = document.getElementById('station3DInfo');
    statusOverlayEl = document.getElementById('station3DStatusOverlay');
    if (!modalEl || !containerEl) {
        console.warn('[Station3D] modal DOM not found');
        return false;
    }
    onCloseRequested = onClose;
    shouldConfirmClose = typeof options.shouldConfirmClose === 'function'
        ? options.shouldConfirmClose
        : null;
    // Order matters: buttons are inserted before close, so the final visual
    // order is autopilot/weapon/campaign/controls/walk/share/language/close.
    ensureAutopilotButton();
    ensureWeaponToggleButton();
    ensureCampaignButton();
    ensureControlsHintButton();
    ensureWalkModeButton();
    ensureRideShareButton();
    ensureLanguageToggle();
    // A campaign menu can be the first engine action, before a cab session
    // has applied its capabilities. Initialize hidden controls immediately.
    applyAutopilotButtonState();
    applyHeaderActionButtonState(controlsHintBtnEl, controlsHintBtnVisible, true);
    applyHeaderActionButtonState(walkModeBtnEl, walkModeBtnVisible, walkModeBtnEnabled);
    applyHeaderActionButtonState(weaponToggleBtnEl, weaponToggleBtnVisible, weaponToggleBtnEnabled);
    if (!domListenersBound) {
        closeBtnEl.addEventListener('click', requestModalClose);
        modalEl.addEventListener('click', (e) => {
            if (e.target === modalEl) requestModalClose();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || modalEl.classList.contains('hidden')) return;
            if (exitConfirmPromise) {
                e.preventDefault();
                e.stopImmediatePropagation();
                finishExitConfirmation(false);
                return;
            }
            const embedded = modalEl.dataset.station3dEmbedded === 'true';
            if (!embedded) {
                e.preventDefault();
                e.stopImmediatePropagation();
                requestModalClose();
            }
        }, true);
        domListenersBound = true;
    }
    return true;
}

export function showModal() {
    if (modalEl) modalEl.classList.remove('hidden');
}

export function hideModal() {
    finishExitConfirmation(false, { restoreFocus: false });
    if (modalEl) modalEl.classList.add('hidden');
}

export function isModalOpen() {
    return modalEl && !modalEl.classList.contains('hidden');
}

export function setTitleText(text) {
    if (!titleEl) return;
    const safeText = text || t('modal.defaultTitle');
    titleEl.textContent = safeText;
    titleEl.setAttribute('aria-label', safeText);
    titleEl.title = safeText;
}

// Long-press detector on the line badge inside the title. The badge gets
// re-rendered on every renderCabTitle call so we delegate from titleEl
// instead of rebinding to the badge element. Holding the badge for
// `durationMs` (default 5 s) fires `onComplete` once. While held, the
// badge's background fills with a red gradient via the Web Animations
// API so the player gets visual feedback that something is happening.
let lineBadgePressTimer = null;
let lineBadgePressAnim = null;
let lineBadgePressDurationMs = 5000;
let lineBadgePressOnComplete = null;
let lineBadgePressBound = false;

function findLineBadge(target) {
    if (!target || !target.closest) return null;
    return target.closest('.station-3d-line-badge');
}

function clearLineBadgePress(badgeEl) {
    if (lineBadgePressTimer) {
        clearTimeout(lineBadgePressTimer);
        lineBadgePressTimer = null;
    }
    if (lineBadgePressAnim) {
        try { lineBadgePressAnim.cancel(); } catch (_) {}
        lineBadgePressAnim = null;
    }
    if (badgeEl) {
        badgeEl.style.background = '';
        badgeEl.style.boxShadow = '';
    }
}

function bindLineBadgePressListenersOnce() {
    if (lineBadgePressBound || !titleEl) return;
    lineBadgePressBound = true;

    const start = (event) => {
        const badge = findLineBadge(event.target);
        if (!badge || !lineBadgePressOnComplete) return;
        if (event.cancelable) event.preventDefault();
        event.stopPropagation();
        clearLineBadgePress(badge);
        // Visual: animate a red glow filling the badge over the press
        // duration. Web Animations API runs at compositor speed and
        // cancels cleanly if the user releases early.
        try {
            lineBadgePressAnim = badge.animate([
                { background: 'rgba(220,38,38,0)',   boxShadow: '0 0 0 0 rgba(220,38,38,0)' },
                { background: 'rgba(220,38,38,0.85)', boxShadow: '0 0 22px 6px rgba(220,38,38,0.55)' },
            ], { duration: lineBadgePressDurationMs, fill: 'forwards', easing: 'ease-in' });
        } catch (_) { /* older browsers without WAAPI: silent fallback */ }
        lineBadgePressTimer = setTimeout(() => {
            lineBadgePressTimer = null;
            const onDone = lineBadgePressOnComplete;
            clearLineBadgePress(badge);
            onDone?.();
        }, lineBadgePressDurationMs);
        badge.setPointerCapture?.(event.pointerId);
    };
    const cancel = (event) => {
        const badge = findLineBadge(event.target) || titleEl.querySelector('.station-3d-line-badge');
        clearLineBadgePress(badge);
    };
    titleEl.addEventListener('pointerdown', start);
    titleEl.addEventListener('pointerup', cancel);
    titleEl.addEventListener('pointercancel', cancel);
    titleEl.addEventListener('pointerleave', cancel);
    // Suppress synthetic context menu after long press on touch.
    titleEl.addEventListener('contextmenu', (event) => {
        if (findLineBadge(event.target)) event.preventDefault();
    });
}

export function setLineBadgeLongPressHandler(onComplete, durationMs) {
    lineBadgePressOnComplete = onComplete;
    if (typeof durationMs === 'number' && durationMs > 0) {
        lineBadgePressDurationMs = durationMs;
    }
    bindLineBadgePressListenersOnce();
}

// Last-rendered title state, kept so a language switch can re-render in the
// new locale without the caller having to know about the change.
let lastTitleInput = null;

export function renderCabTitle(titleText, fallbackLineLabel) {
    lastTitleInput = { titleText, fallbackLineLabel };
    if (!titleEl) return;
    const normalizedTitle = titleText ? String(titleText).trim() : '';
    let prefix = normalizedTitle;
    let badge = fallbackLineLabel == null ? '' : String(fallbackLineLabel).trim();
    // Match either the Croatian "Linija" or English "Line" form so callers
    // that pass a fully-formed title in either language still get the
    // prefix-vs-badge split treatment.
    const lineMatch = normalizedTitle.match(/^(.*?)(?:\s*[—-]\s*)?(?:Linija|Line)\s+(.+)$/i);
    if (lineMatch) {
        prefix = lineMatch[1].trim();
        if (!badge) badge = lineMatch[2].trim();
    } else if (!badge) {
        setTitleText(normalizedTitle || t('title.train'));
        return;
    }
    // Reconstruct the full accessible label using the current locale's
    // word for "Line", regardless of which language the caller passed in.
    const lineWord = t('title.line', { n: badge }).replace(/^.*?[—-]\s*/, '');
    const fullLabel = prefix ? `${prefix} — ${lineWord}` : lineWord;
    titleEl.innerHTML = [
        prefix ? `<span class="station-3d-title-prefix">${escapeHtml(prefix)}</span>` : '',
        `<span class="station-3d-line-badge" aria-label="${escapeHtml(fullLabel)}">${escapeHtml(badge)}</span>`,
    ].join('');
    titleEl.setAttribute('aria-label', fullLabel);
    titleEl.title = fullLabel;
}

onLangChange(() => {
    if (lastTitleInput) renderCabTitle(lastTitleInput.titleText, lastTitleInput.fallbackLineLabel);
});

// Updates a specific slot of the info row (stats / buildings). Others are preserved.
export function setInfoSlot(slot, value) {
    infoState[slot] = value;
    renderInfo();
}

export function clearInfo() {
    infoState.stats = null;
    infoState.buildings = null;
    renderInfo();
}

function renderInfo() {
    if (!infoEl) return;
    const parts = [];
    if (infoState.stats) parts.push(...(Array.isArray(infoState.stats) ? infoState.stats : [infoState.stats]));
    if (infoState.buildings) parts.push(...(Array.isArray(infoState.buildings) ? infoState.buildings : [infoState.buildings]));
    infoEl.innerHTML = parts
        .map(part => `<span class="station-3d-info-item">${escapeHtml(part)}</span>`)
        .join('');
}

// ─── Campaign button ──────────────────────────────────────────────────────
// Optional singleplayer campaign entry. Hidden by default so direct ride links
// land in immediate drive mode without a story overlay.

function ensureCampaignButton() {
    if (campaignBtnEl || !closeBtnEl || !closeBtnEl.parentElement) return;
    campaignBtnEl = document.createElement('button');
    campaignBtnEl.type = 'button';
    campaignBtnEl.dataset.cabCampaign = 'true';
    campaignBtnEl.textContent = '🎯';
    campaignBtnEl.hidden = true;
    campaignBtnEl.style.cssText = [
        'margin-right:8px',
        'width:28px',
        'height:28px',
        'display:inline-flex',
        'align-items:center',
        'justify-content:center',
        'border:none',
        'background:transparent',
        'color:#f8fafc',
        'border-radius:999px',
        'padding:0',
        'font:600 16px/1 ui-sans-serif,system-ui,sans-serif',
        'cursor:pointer',
    ].join(';');
    const refresh = () => {
        campaignBtnEl.setAttribute('aria-label', t('campaign.menu.title'));
        campaignBtnEl.title = t('campaign.menu.title');
    };
    refresh();
    onLangChange(refresh);
    campaignBtnEl.addEventListener('click', () => campaignStartHandler?.());
    closeBtnEl.parentElement.insertBefore(campaignBtnEl, closeBtnEl);
    applyCampaignButtonState();
}

export function setCampaignButtonHandler(handler) {
    campaignStartHandler = typeof handler === 'function' ? handler : null;
}

let campaignBtnVisible = false;
let campaignBtnEnabled = true;
function applyCampaignButtonState() {
    if (!campaignBtnEl) return;
    const visible = campaignFeatureAvailable && campaignBtnVisible;
    const interactive = visible && campaignBtnEnabled;
    campaignBtnEl.hidden = !visible;
    // Inline display:inline-flex overrides [hidden]{display:none}, so mirror
    // visibility into display (same workaround as the autopilot button).
    campaignBtnEl.style.display = visible ? 'inline-flex' : 'none';
    campaignBtnEl.disabled = !interactive;
    campaignBtnEl.style.opacity = visible && !campaignBtnEnabled ? '0.4' : '1';
    campaignBtnEl.style.cursor = interactive ? 'pointer' : 'default';
}

export function setCampaignButtonAvailable(available) {
    campaignFeatureAvailable = !!available;
    applyCampaignButtonState();
}

export function setCampaignButtonVisible(visible) {
    campaignBtnVisible = !!visible;
    applyCampaignButtonState();
}

// Greyed + non-clickable when disabled by a modal owner or unavailable runtime.
export function setCampaignButtonEnabled(enabled) {
    campaignBtnEnabled = !!enabled;
    applyCampaignButtonState();
}

function applyHeaderActionButtonState(buttonEl, visible, enabled) {
    if (!buttonEl) return;
    const interactive = !!visible && !!enabled;
    buttonEl.hidden = !visible;
    buttonEl.style.display = visible ? 'inline-flex' : 'none';
    buttonEl.disabled = !interactive;
    buttonEl.style.opacity = visible && !enabled ? '0.45' : '1';
    buttonEl.style.cursor = interactive ? 'pointer' : 'default';
}

// Permanent way back to the control list. It used to exist only as a toast on
// entry — five seconds, once, while the player is busy taking off — so the flying
// keys were effectively unrecoverable without reading the README.
function ensureControlsHintButton() {
    if (controlsHintBtnEl || !closeBtnEl || !closeBtnEl.parentElement) return;
    controlsHintBtnEl = document.createElement('button');
    controlsHintBtnEl.type = 'button';
    controlsHintBtnEl.dataset.cabControlsHint = 'true';
    controlsHintBtnEl.textContent = '🎮';
    controlsHintBtnEl.hidden = true;
    controlsHintBtnEl.style.cssText = [
        'margin-right:8px',
        'width:28px',
        'height:28px',
        'display:inline-flex',
        'align-items:center',
        'justify-content:center',
        'border:none',
        'background:transparent',
        'color:#f8fafc',
        'border-radius:999px',
        'padding:0',
        'font:600 16px/1 ui-sans-serif,system-ui,sans-serif',
        'cursor:pointer',
    ].join(';');
    const refresh = () => {
        controlsHintBtnEl.setAttribute('aria-label', t('gta.controlsButton'));
        controlsHintBtnEl.title = t('gta.controlsButton');
    };
    refresh();
    onLangChange(refresh);
    controlsHintBtnEl.addEventListener('click', () => controlsHintHandler?.());
    closeBtnEl.parentElement.insertBefore(controlsHintBtnEl, closeBtnEl);
}

export function setControlsHintHandler(handler) {
    controlsHintHandler = typeof handler === 'function' ? handler : null;
}

export function setControlsHintButtonVisible(visible) {
    controlsHintBtnVisible = !!visible;
    applyHeaderActionButtonState(controlsHintBtnEl, controlsHintBtnVisible, true);
}

function ensureWalkModeButton() {
    if (walkModeBtnEl || !closeBtnEl || !closeBtnEl.parentElement) return;
    walkModeBtnEl = document.createElement('button');
    walkModeBtnEl.type = 'button';
    walkModeBtnEl.dataset.cabWalkMode = 'true';
    walkModeBtnEl.textContent = '🚶';
    walkModeBtnEl.hidden = true;
    walkModeBtnEl.style.cssText = [
        'margin-right:8px',
        'width:28px',
        'height:28px',
        'align-items:center',
        'justify-content:center',
        'border:none',
        'background:transparent',
        'color:#f8fafc',
        'border-radius:999px',
        'padding:0',
        'font:600 16px/1 ui-sans-serif,system-ui,sans-serif',
        'cursor:pointer',
    ].join(';');
    const refresh = () => {
        walkModeBtnEl.setAttribute('aria-label', t('walk.start'));
        walkModeBtnEl.title = t('walk.start');
    };
    refresh();
    onLangChange(refresh);
    walkModeBtnEl.addEventListener('click', () => walkModeStartHandler?.());
    closeBtnEl.parentElement.insertBefore(walkModeBtnEl, closeBtnEl);
}

export function setWalkModeButtonHandler(handler) {
    walkModeStartHandler = typeof handler === 'function' ? handler : null;
}

export function setWalkModeButtonVisible(visible) {
    walkModeBtnVisible = !!visible;
    applyHeaderActionButtonState(walkModeBtnEl, walkModeBtnVisible, walkModeBtnEnabled);
}

export function setWalkModeButtonEnabled(enabled) {
    walkModeBtnEnabled = !!enabled;
    applyHeaderActionButtonState(walkModeBtnEl, walkModeBtnVisible, walkModeBtnEnabled);
}

function ensureWeaponToggleButton() {
    if (weaponToggleBtnEl || !closeBtnEl || !closeBtnEl.parentElement) return;
    weaponToggleBtnEl = document.createElement('button');
    weaponToggleBtnEl.type = 'button';
    weaponToggleBtnEl.dataset.cabWeaponToggle = 'true';
    weaponToggleBtnEl.hidden = true;
    weaponToggleBtnEl.style.cssText = [
        'margin-right:8px',
        'width:28px',
        'height:28px',
        'align-items:center',
        'justify-content:center',
        'border:none',
        'background:transparent',
        'color:#f8fafc',
        'border-radius:999px',
        'padding:0',
        'font:600 16px/1 ui-sans-serif,system-ui,sans-serif',
        'cursor:pointer',
    ].join(';');
    const refresh = () => {
        if (!weaponToggleBtnEl) return;
        weaponToggleBtnEl.textContent = weaponToggleArmed ? '🌸' : '🔫';
        const label = weaponToggleArmed ? t('weapon.toggleStow') : t('weapon.toggleReady');
        weaponToggleBtnEl.setAttribute('aria-label', label);
        weaponToggleBtnEl.title = label;
    };
    refresh();
    onLangChange(refresh);
    weaponToggleBtnEl.addEventListener('click', () => weaponToggleHandler?.());
    closeBtnEl.parentElement.insertBefore(weaponToggleBtnEl, closeBtnEl);
}

export function setWeaponToggleButtonHandler(handler) {
    weaponToggleHandler = typeof handler === 'function' ? handler : null;
}

export function setWeaponToggleButtonVisible(visible) {
    weaponToggleBtnVisible = !!visible;
    applyHeaderActionButtonState(weaponToggleBtnEl, weaponToggleBtnVisible, weaponToggleBtnEnabled);
}

export function setWeaponToggleButtonEnabled(enabled) {
    weaponToggleBtnEnabled = !!enabled;
    applyHeaderActionButtonState(weaponToggleBtnEl, weaponToggleBtnVisible, weaponToggleBtnEnabled);
}

export function setWeaponToggleButtonArmed(armed) {
    weaponToggleArmed = !!armed;
    if (!weaponToggleBtnEl) return;
    weaponToggleBtnEl.textContent = weaponToggleArmed ? '🌸' : '🔫';
    const label = weaponToggleArmed ? t('weapon.toggleStow') : t('weapon.toggleReady');
    weaponToggleBtnEl.setAttribute('aria-label', label);
    weaponToggleBtnEl.title = label;
}

// Autopilot indicator button. Lives in the header next to the gun /
// flower / walk icons. Visible only in tram sessions where the driver
// hasn't engaged manual control. Clicking it engages manual control,
// matching the on-screen 🕹️ button down in the driver pad.
function ensureAutopilotButton() {
    if (autopilotBtnEl || !closeBtnEl || !closeBtnEl.parentElement) return;
    autopilotBtnEl = document.createElement('button');
    autopilotBtnEl.type = 'button';
    autopilotBtnEl.dataset.cabAutopilot = 'true';
    autopilotBtnEl.textContent = '🤖';
    autopilotBtnEl.hidden = true;
    autopilotBtnEl.style.cssText = [
        'margin-right:8px',
        'width:28px',
        'height:28px',
        'display:inline-flex',
        'align-items:center',
        'justify-content:center',
        'border:none',
        'background:transparent',
        'color:#f8fafc',
        'border-radius:999px',
        'padding:0',
        'font:600 16px/1 ui-sans-serif,system-ui,sans-serif',
        'cursor:pointer',
    ].join(';');
    const refresh = () => {
        if (!autopilotBtnEl) return;
        const label = `${t('driver.autopilot')} — ${t('driver.autopilotHint')}`;
        autopilotBtnEl.setAttribute('aria-label', label);
        autopilotBtnEl.title = label;
    };
    refresh();
    onLangChange(refresh);
    autopilotBtnEl.addEventListener('click', () => autopilotHandler?.());
    closeBtnEl.parentElement.insertBefore(autopilotBtnEl, closeBtnEl);
}

export function setAutopilotButtonHandler(handler) {
    autopilotHandler = typeof handler === 'function' ? handler : null;
}

function applyAutopilotButtonState() {
    if (!autopilotBtnEl) return;
    if (autopilotBtnVisible === appliedAutopilotBtnVisible
        && autopilotBtnEnabled === appliedAutopilotBtnEnabled
        && autopilotBtnEngaged === appliedAutopilotBtnEngaged) {
        return;
    }
    appliedAutopilotBtnVisible = autopilotBtnVisible;
    appliedAutopilotBtnEnabled = autopilotBtnEnabled;
    appliedAutopilotBtnEngaged = autopilotBtnEngaged;
    autopilotBtnEl.hidden = !autopilotBtnVisible;
    // Inline `display:inline-flex` from the initial cssText overrides
    // the UA stylesheet's `[hidden] { display: none }`, so toggling
    // the `hidden` attribute alone leaves the button visible. Mirror
    // the visibility into the inline `display` so it actually hides.
    autopilotBtnEl.style.display = autopilotBtnVisible ? 'inline-flex' : 'none';
    autopilotBtnEl.disabled = !autopilotBtnEnabled;
    // Visual states: ENGAGED (autopilot driving) → bright + glow; not
    // engaged (player has taken over) → dimmer to read as "available
    // to click to hand back to autopilot".
    // engaged → bright; manual (clickable to hand back) → dim; inactive
    // (e.g. walk mode) → clearly greyed out.
    autopilotBtnEl.style.opacity = autopilotBtnEngaged ? '1' : (autopilotBtnEnabled ? '0.55' : '0.4');
    autopilotBtnEl.style.cursor = autopilotBtnEnabled ? 'pointer' : 'default';
    autopilotBtnEl.style.background = autopilotBtnEngaged
        ? 'rgba(34,197,94,0.32)'
        : 'transparent';
    autopilotBtnEl.style.boxShadow = autopilotBtnEngaged
        ? '0 0 0 2px rgba(34,197,94,0.5) inset, 0 0 12px rgba(34,197,94,0.25)'
        : 'none';
}

export function setAutopilotButtonVisible(visible) {
    autopilotBtnVisible = !!visible;
    applyAutopilotButtonState();
}

// `engaged` = autopilot is currently driving. `clickable` = whether
// the button should respond to clicks (typically the inverse — autopilot
// engaged means there's nothing to engage, so the button is just a
// status indicator; in manual mode it's clickable to hand back).
export function setAutopilotButtonState({ engaged, clickable }) {
    autopilotBtnEngaged = !!engaged;
    autopilotBtnEnabled = !!clickable;
    applyAutopilotButtonState();
}

// ─── Language toggle ──────────────────────────────────────────────────────
// Sits in the modal header to the left of the close (and ride-share) button.
// Shows the OPPOSITE language code as a hint that clicking will switch.
let langBtnEl = null;

function ensureLanguageToggle() {
    if (langBtnEl || !closeBtnEl || !closeBtnEl.parentElement) return;
    langBtnEl = document.createElement('button');
    langBtnEl.type = 'button';
    langBtnEl.dataset.cabLangToggle = 'true';
    langBtnEl.style.cssText = [
        'margin-right:8px',
        'width:28px',
        'height:28px',
        'padding:0',
        'display:inline-flex',
        'align-items:center',
        'justify-content:center',
        'border:1px solid rgba(255,255,255,0.32)',
        'background:transparent',
        'color:#f8fafc',
        'border-radius:999px',
        'font:700 12px/1 ui-sans-serif,system-ui,sans-serif',
        'cursor:pointer',
    ].join(';');
    const refresh = () => {
        langBtnEl.textContent = t('lang.toggle');
        langBtnEl.setAttribute('aria-label', t('lang.toggleAria'));
        langBtnEl.title = t('lang.toggleAria');
    };
    refresh();
    onLangChange(refresh);
    langBtnEl.addEventListener('click', () => toggleLang());
    closeBtnEl.parentElement.insertBefore(langBtnEl, closeBtnEl);
}

// ─── Ride-share button ─────────────────────────────────────────────────────

function ensureRideShareButton() {
    if (rideShareBtnEl || !closeBtnEl || !closeBtnEl.parentElement) return;
    rideShareBtnEl = document.createElement('button');
    rideShareBtnEl.type = 'button';
    rideShareBtnEl.dataset.cabShareRide = 'true';
    rideShareBtnEl.textContent = '🔗';
    rideShareBtnEl.setAttribute('aria-label', t('modal.shareRide'));
    rideShareBtnEl.title = t('modal.shareRide');
    rideShareBtnEl.hidden = true;
    rideShareBtnEl.style.cssText = [
        'margin-right:8px',
        'width:28px',
        'height:28px',
        'display:inline-flex',
        'align-items:center',
        'justify-content:center',
        'border:none',
        'background:transparent',
        'color:#f8fafc',
        'border-radius:999px',
        'padding:0',
        'font:600 16px/1 ui-sans-serif,system-ui,sans-serif',
        'cursor:pointer',
    ].join(';');
    rideShareBtnEl.addEventListener('click', shareCurrentRide);
    closeBtnEl.parentElement.insertBefore(rideShareBtnEl, closeBtnEl);
    applyRideShareButtonState();
}

function applyRideShareButtonState() {
    if (!rideShareBtnEl) return;
    const available = !!(currentRideShareUrl || currentRideShareUrlProvider);
    rideShareBtnEl.hidden = !available;
    // This button owns inline display:inline-flex. As with the campaign and
    // autopilot controls, mirror [hidden] into display because inline author
    // styling otherwise wins over the browser's hidden-element stylesheet.
    rideShareBtnEl.style.display = available ? 'inline-flex' : 'none';
    rideShareBtnEl.disabled = !available;
    rideShareBtnEl.style.cursor = available ? 'pointer' : 'default';
}

export function setRideShareUrl(url) {
    currentRideShareUrl = url || '';
    applyRideShareButtonState();
    restoreRideShareButtonLabel();
}

export function setRideShareUrlProvider(provider) {
    currentRideShareUrlProvider = typeof provider === 'function' ? provider : null;
    applyRideShareButtonState();
    restoreRideShareButtonLabel();
}

export function setRideShareButtonVisible(visible) {
    if (!rideShareBtnEl) return;
    const available = !!visible && !!(currentRideShareUrl || currentRideShareUrlProvider);
    rideShareBtnEl.hidden = !available;
    rideShareBtnEl.style.display = available ? 'inline-flex' : 'none';
    rideShareBtnEl.disabled = !available;
    rideShareBtnEl.style.cursor = available ? 'pointer' : 'default';
}

function setRideShareButtonLabel(label) {
    if (!rideShareBtnEl) return;
    rideShareBtnEl.textContent = '🔗';
    rideShareBtnEl.setAttribute('aria-label', label);
    rideShareBtnEl.title = label;
}

export function restoreRideShareButtonLabel() {
    setRideShareButtonLabel(t('modal.shareRide'));
}

// Handler is wired at button creation; declared here so the hud import surface
// stays narrow. Fires the native share sheet when available; otherwise copies
// to clipboard. Reports success/failure via the toast.
let toastFn = () => {};
export function setShareToastHandler(fn) {
    toastFn = fn || (() => {});
}

async function copyShareUrl(url) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try {
            await navigator.clipboard.writeText(url);
            return true;
        } catch (_) {
            // Permission can be denied even in a secure context. Fall through
            // to the selection-based copy path used by the rest of the site.
        }
    }
    const area = document.createElement('textarea');
    area.value = url;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.focus();
    area.select();
    let copied = false;
    try {
        copied = document.execCommand?.('copy') !== false;
    } finally {
        area.remove();
    }
    return copied;
}

async function shareCurrentRide() {
    if (currentRideShareUrlProvider) {
        try {
            currentRideShareUrl = currentRideShareUrlProvider() || '';
        } catch (error) {
            console.error('[Station3D] share ride url provider failed', error);
            currentRideShareUrl = '';
        }
    }
    if (!currentRideShareUrl) {
        toastFn(t('share.unavailable'));
        restoreRideShareButtonLabel();
        return;
    }
    try {
        // Desktop browsers increasingly expose navigator.share even when the
        // operating-system sheet is unavailable or visually lost behind the
        // full-screen canvas. The chain icon is a deterministic copy action on
        // desktop; touch devices retain their native share sheet.
        if (navigator.maxTouchPoints > 0
            && navigator.share && typeof navigator.share === 'function') {
            await navigator.share({
                title: titleEl ? (titleEl.getAttribute('aria-label') || titleEl.textContent) : t('share.tramRide'),
                url: currentRideShareUrl,
            });
            toastFn(t('share.linkShared'));
            restoreRideShareButtonLabel();
            return;
        }
        if (await copyShareUrl(currentRideShareUrl)) {
            toastFn(t('share.linkCopied'));
            restoreRideShareButtonLabel();
            return;
        }
        toastFn(t('share.unavailable'));
        restoreRideShareButtonLabel();
    } catch (error) {
        if (error && error.name === 'AbortError') {
            restoreRideShareButtonLabel();
            return;
        }
        console.error('[Station3D] share ride failed', error);
        toastFn(t('share.error'));
        restoreRideShareButtonLabel();
    }
}
