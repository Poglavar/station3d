// Mobile touch overlay for walk mode: forward/back, turn left/right, jetpack.
// Mirrors driver-controls.js patterns (bindHoldControl, pointer-event shielding).

import { modalEl } from './modal.js';
import { t, onLangChange } from '../core/i18n.js';
import { onKeyDown, onKeyUp, setWalkSpeedBoost } from '../modes/walk.js';

let containerEl = null;
let boostBtnEl = null;
let jetpackBtnEl = null;
let gtaInteractBtnEl = null;
let gtaCameraBtnEl = null;
let gtaResetBtnEl = null;
let gtaStopBtnEl = null;
let boostOn = false;
let controlMode = 'walk';
let jetpackAvailable = true;
let gtaHandlers = {};
let gtaInteractionReady = false;
let worldInteractionLabel = '';
let campaignInteractionName = '';
let campaignInteractionAction = 'talk';
// Key → on-screen button. Lets the keyboard handler in cab.js highlight
// the matching button when a walk key is pressed (arrows alias to WASD).
const keyToButton = new Map();

function stopCabUiPropagation(event) {
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') {
        event.stopImmediatePropagation();
    }
}

function stopCabUiEvent(event) {
    if (event.cancelable) event.preventDefault();
    stopCabUiPropagation(event);
}

function setButtonPressed(button, pressed) {
    if (!button) return;
    const inactiveBackground = button.dataset.inactiveBackground || '';
    const activeBackground = button.dataset.activeBackground || '';
    button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    if (activeBackground) {
        button.style.background = pressed ? activeBackground : inactiveBackground;
    }
}

function updateInteractionButton() {
    if (!gtaInteractBtnEl) return;
    const campaignReady = !!campaignInteractionName;
    const ready = gtaInteractionReady || (campaignReady && campaignInteractionAction !== 'approach');
    gtaInteractBtnEl.classList.toggle('station-3d-gta-interact-ready', ready);
    gtaInteractBtnEl.dataset.vehicleNearby = gtaInteractionReady ? 'true' : 'false';
    gtaInteractBtnEl.dataset.campaignNearby = campaignReady ? 'true' : 'false';
    const gta = controlMode === 'gta-walk' || controlMode === 'gta-drive';
    gtaInteractBtnEl.style.display = gta || campaignReady || gtaInteractionReady ? '' : 'none';
    const campaignOwnsAction = campaignReady && !(campaignInteractionAction === 'approach' && gtaInteractionReady);
    const label = worldInteractionLabel || (campaignOwnsAction
        ? t(
            campaignInteractionAction === 'approach' ? 'campaign.approach'
                : campaignInteractionAction === 'board' ? 'campaign.board' : 'campaign.interact',
            { name: campaignInteractionName },
        )
        : t('gta.mobile.enterExit'));
    gtaInteractBtnEl.setAttribute('aria-label', label);
    gtaInteractBtnEl.title = label;
}

export function setGtaInteractionAvailable(available, label = '') {
    gtaInteractionReady = !!available;
    worldInteractionLabel = available ? label : '';
    updateInteractionButton();
}

// True while the campaign prompt owns E: a reachable actor or boardable
// authored vehicle. The status overlay hides its generic "enter nearby
// vehicle" line then, so one action has one instruction (Njofra beside the
// getaway car showed both, 2026-09-09 audit). A person just outside talk
// range still yields to a vehicle that is ready to board.
export function campaignOwnsInteraction() {
    return !!campaignInteractionName
        && !(campaignInteractionAction === 'approach' && gtaInteractionReady);
}

export function setCampaignInteractionAvailable(available, name = '', action = 'talk') {
    campaignInteractionName = available ? String(name || '').trim() : '';
    campaignInteractionAction = available ? String(action || 'talk') : 'talk';
    updateInteractionButton();
}

export function setWalkJetpackAvailable(available = true) {
    jetpackAvailable = available !== false;
    if (!jetpackAvailable) {
        onKeyUp(' ');
        setButtonPressed(jetpackBtnEl, false);
    }
    applyControlMode();
}

function dispatchKeyDown(key) {
    if (controlMode === 'gta-drive') gtaHandlers.onKeyDown?.(key);
    else onKeyDown(key);
}

function dispatchKeyUp(key) {
    if (controlMode === 'gta-drive') gtaHandlers.onKeyUp?.(key);
    else onKeyUp(key);
}

function bindHoldControl(button, key) {
    if (!button) return;
    const release = (event) => {
        stopCabUiEvent(event);
        dispatchKeyUp(key);
        setButtonPressed(button, false);
    };
    button.addEventListener('pointerdown', (event) => {
        stopCabUiEvent(event);
        dispatchKeyDown(key);
        setButtonPressed(button, true);
        button.setPointerCapture?.(event.pointerId);
    });
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('pointerleave', release);
}

function bindCabUiShield(element) {
    if (!element) return;
    const stopOnly = (event) => stopCabUiPropagation(event);
    const stopAndPrevent = (event) => stopCabUiEvent(event);
    for (const evName of ['pointerdown', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'touchcancel']) {
        element.addEventListener(evName, stopOnly, { passive: false });
    }
    element.addEventListener('contextmenu', stopAndPrevent, { passive: false });
    element.addEventListener('selectstart', stopAndPrevent, { passive: false });
}

// Thumb geometry, in one place. The pads sit over a live 3D scene, so they
// stay translucent until pressed: a solid slab of chrome over the world reads
// as UI in the way, and the glyph carries the affordance on its own.
const PAD_BUTTON_PX = 58;
const ACTION_BUTTON_PX = 64;
const PAD_EDGE_PX = 18;
const PAD_IDLE_BG = 'rgba(15,23,42,0.34)';
const PAD_PRESSED_BG = 'rgba(37,99,235,0.92)';

function makeButton(label, styleExtra = '') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.style.cssText = [
        `min-width:${PAD_BUTTON_PX}px`,
        `min-height:${PAD_BUTTON_PX}px`,
        'padding:0',
        'border-radius:14px',
        'border:1px solid rgba(255,255,255,0.18)',
        `background:${PAD_IDLE_BG}`,
        'color:#fff',
        'text-shadow:0 1px 3px rgba(0,0,0,0.55)',
        'font:700 22px/1 ui-sans-serif,system-ui,sans-serif',
        'backdrop-filter:blur(6px)',
        '-webkit-backdrop-filter:blur(6px)',
        'box-shadow:0 12px 30px rgba(0,0,0,0.28)',
        'touch-action:none',
        'user-select:none',
        '-webkit-user-select:none',
        '-webkit-touch-callout:none',
        styleExtra,
    ].join(';');
    btn.draggable = false;
    return btn;
}

function setHoldBackgrounds(button, inactiveBackground, activeBackground) {
    button.dataset.inactiveBackground = inactiveBackground;
    button.dataset.activeBackground = activeBackground;
    button.style.background = inactiveBackground;
    button.setAttribute('aria-pressed', 'false');
}

function updateBoostLabel() {
    if (!boostBtnEl) return;
    const label = t('walk.speedBoost');
    boostBtnEl.setAttribute('aria-label', label);
    boostBtnEl.title = label;
}

function updateGtaActionLabels() {
    if (jetpackBtnEl) {
        const label = t(controlMode === 'gta-drive' ? 'gta.mobile.secondary' : 'walk.jetpack');
        jetpackBtnEl.setAttribute('aria-label', label);
        jetpackBtnEl.title = label;
    }
    if (gtaInteractBtnEl) {
        updateInteractionButton();
    }
    if (gtaCameraBtnEl) {
        gtaCameraBtnEl.setAttribute('aria-label', t('gta.mobile.camera'));
        gtaCameraBtnEl.title = t('gta.mobile.camera');
    }
    if (gtaResetBtnEl) {
        gtaResetBtnEl.setAttribute('aria-label', t('gta.mobile.reset'));
        gtaResetBtnEl.title = t('gta.mobile.reset');
    }
    if (gtaStopBtnEl) {
        gtaStopBtnEl.setAttribute('aria-label', t('gta.mobile.stop'));
        gtaStopBtnEl.title = t('gta.mobile.stop');
    }
}

function bindActivateControl(button, callback) {
    if (!button) return;
    let lastPointerActivationAt = 0;
    button.addEventListener('pointerup', (event) => {
        stopCabUiEvent(event);
        lastPointerActivationAt = Date.now();
        callback();
    });
    button.addEventListener('click', (event) => {
        stopCabUiEvent(event);
        if (Date.now() - lastPointerActivationAt < 600) return;
        callback();
    });
}

function makeRow(...children) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:4px;justify-content:center';
    for (const child of children) row.appendChild(child);
    return row;
}

export function ensureWalkControls() {
    if (containerEl) return;
    if (!modalEl) return;

    // Joystick area — left side, bottom-left corner
    const leftPanel = document.createElement('div');
    leftPanel.dataset.cabWalkControls = 'true';
    leftPanel.hidden = true;
    leftPanel.style.cssText = [
        'position:absolute',
        `left:${PAD_EDGE_PX}px`,
        `bottom:${PAD_EDGE_PX}px`,
        'flex-direction:column',
        'align-items:center',
        'gap:6px',
        'z-index:6',
        'pointer-events:auto',
        'touch-action:none',
        'user-select:none',
        '-webkit-user-select:none',
        '-webkit-touch-callout:none',
    ].join(';');

    const fwdBtn  = makeButton('▲');
    const leftBtn = makeButton('◀');
    const backBtn = makeButton('▼');
    const rightBtn = makeButton('▶');
    for (const btn of [fwdBtn, leftBtn, backBtn, rightBtn]) {
        setHoldBackgrounds(btn, PAD_IDLE_BG, PAD_PRESSED_BG);
    }

    // Middle slot in d-pad center row — spacer so left/right are at the edges
    const center = document.createElement('div');
    center.style.cssText = `min-width:${PAD_BUTTON_PX}px;min-height:${PAD_BUTTON_PX}px`;

    leftPanel.appendChild(makeRow(fwdBtn));
    leftPanel.appendChild(makeRow(leftBtn, center, rightBtn));
    leftPanel.appendChild(makeRow(backBtn));

    // Action + booster — right side, sitting on the same baseline as the
    // d-pad so both thumbs work at the bottom edge. E is on top, where the
    // thumb rests; the booster is the one below it.
    const rightPanel = document.createElement('div');
    rightPanel.dataset.cabWalkJetpack = 'true';
    rightPanel.hidden = true;
    rightPanel.style.cssText = [
        'position:absolute',
        `right:${PAD_EDGE_PX}px`,
        `bottom:${PAD_EDGE_PX}px`,
        'flex-direction:column',
        'gap:8px',
        'align-items:center',
        'z-index:6',
        'pointer-events:auto',
        'touch-action:none',
        'user-select:none',
        '-webkit-user-select:none',
        '-webkit-touch-callout:none',
    ].join(';');

    // Booster is a TOGGLE (tap on, tap off), unlike the hold-to-fly jetpack:
    // ×3 walk speed while lit (modes/walk.js applies the multiplier).
    const boostBtn = makeButton('⚡', `width:${ACTION_BUTTON_PX}px;height:${ACTION_BUTTON_PX}px;min-width:${ACTION_BUTTON_PX}px;min-height:${ACTION_BUTTON_PX}px;font-size:27px`);
    setHoldBackgrounds(boostBtn, PAD_IDLE_BG, 'rgba(22,163,74,0.92)');
    boostBtn.addEventListener('pointerdown', (event) => {
        stopCabUiEvent(event);
        boostOn = !boostOn;
        setWalkSpeedBoost(boostOn);
        setButtonPressed(boostBtn, boostOn);
    });
    boostBtnEl = boostBtn;
    updateBoostLabel();
    onLangChange(updateBoostLabel);

    const jetpackBtn = makeButton('🚀', `width:${ACTION_BUTTON_PX}px;height:${ACTION_BUTTON_PX}px;min-width:${ACTION_BUTTON_PX}px;min-height:${ACTION_BUTTON_PX}px;font-size:27px`);
    setHoldBackgrounds(jetpackBtn, PAD_IDLE_BG, PAD_PRESSED_BG);
    jetpackBtnEl = jetpackBtn;

    const gtaInteractBtn = makeButton('E', `width:${ACTION_BUTTON_PX}px;height:${ACTION_BUTTON_PX}px;min-width:${ACTION_BUTTON_PX}px;min-height:${ACTION_BUTTON_PX}px;font-size:26px`);
    const gtaCameraBtn = makeButton('C', `min-width:${ACTION_BUTTON_PX}px;min-height:${ACTION_BUTTON_PX}px;font-size:22px`);
    const gtaResetBtn = makeButton('R', `min-width:${ACTION_BUTTON_PX}px;min-height:${ACTION_BUTTON_PX}px;font-size:22px`);
    const gtaStopBtn = makeButton('STOP', `min-width:${ACTION_BUTTON_PX}px;min-height:${ACTION_BUTTON_PX}px;font-size:16px`);
    for (const button of [gtaInteractBtn, gtaCameraBtn, gtaResetBtn, gtaStopBtn]) {
        setHoldBackgrounds(button, PAD_IDLE_BG, PAD_PRESSED_BG);
        button.style.display = 'none';
    }
    gtaInteractBtnEl = gtaInteractBtn;
    gtaCameraBtnEl = gtaCameraBtn;
    gtaResetBtnEl = gtaResetBtn;
    gtaStopBtnEl = gtaStopBtn;
    updateGtaActionLabels();
    onLangChange(updateGtaActionLabels);

    rightPanel.appendChild(gtaInteractBtn);
    rightPanel.appendChild(jetpackBtn);
    rightPanel.appendChild(boostBtn);
    rightPanel.appendChild(gtaStopBtn);
    rightPanel.appendChild(makeRow(gtaCameraBtn, gtaResetBtn));

    modalEl.appendChild(leftPanel);
    modalEl.appendChild(rightPanel);

    bindCabUiShield(leftPanel);
    bindCabUiShield(rightPanel);

    bindHoldControl(fwdBtn,    'w');
    bindHoldControl(backBtn,   's');
    bindHoldControl(leftBtn,   'a');
    bindHoldControl(rightBtn,  'd');
    bindHoldControl(jetpackBtn, ' ');
    bindActivateControl(gtaStopBtn, () => gtaHandlers.onStop?.());
    bindActivateControl(gtaInteractBtn, () => gtaHandlers.onInteract?.());
    bindActivateControl(gtaCameraBtn, () => gtaHandlers.onCamera?.());
    bindActivateControl(gtaResetBtn, () => gtaHandlers.onReset?.());

    // Arrow keys alias to the same WASD buttons for visual feedback.
    keyToButton.set('w', fwdBtn);   keyToButton.set('arrowup', fwdBtn);
    keyToButton.set('s', backBtn);  keyToButton.set('arrowdown', backBtn);
    keyToButton.set('a', leftBtn);  keyToButton.set('arrowleft', leftBtn);
    keyToButton.set('d', rightBtn); keyToButton.set('arrowright', rightBtn);
    keyToButton.set(' ', jetpackBtn);

    // Keep a single reference so show/hide can reach both panels
    containerEl = { left: leftPanel, right: rightPanel };
    applyControlMode();
}

function applyControlMode() {
    if (!containerEl) return;
    const gta = controlMode === 'gta-walk' || controlMode === 'gta-drive';
    const driving = controlMode === 'gta-drive';
    // Space is the walk jetpack, road handbrake, and aircraft throttle. A
    // bounded interior hides only the walking jetpack; driving keeps its
    // secondary control available to touch users.
    if (driving || jetpackAvailable) keyToButton.set(' ', jetpackBtnEl);
    else keyToButton.delete(' ');
    if (boostBtnEl) boostBtnEl.style.display = driving ? 'none' : '';
    if (jetpackBtnEl) {
        jetpackBtnEl.style.display = driving || jetpackAvailable ? '' : 'none';
        jetpackBtnEl.textContent = driving ? 'SPACE' : '🚀';
        jetpackBtnEl.style.fontSize = driving ? '15px' : '27px';
    }
    updateInteractionButton();
    if (gtaCameraBtnEl) gtaCameraBtnEl.style.display = driving ? '' : 'none';
    if (gtaResetBtnEl) gtaResetBtnEl.style.display = driving ? '' : 'none';
    if (gtaStopBtnEl) gtaStopBtnEl.style.display = driving ? '' : 'none';
    // Both clusters keep the same baseline in every mode: a thumb reaches
    // the bottom corners, not a column hovering above them.
    containerEl.right.style.bottom = `${PAD_EDGE_PX}px`;
    updateGtaActionLabels();
}

function clearHeldButtonVisuals() {
    for (const button of new Set(keyToButton.values())) setButtonPressed(button, false);
}

export function setWalkControlsMode(mode = 'walk', handlers = null) {
    for (const key of ['w', 's', 'a', 'd', ' ']) dispatchKeyUp(key);
    clearHeldButtonVisuals();
    controlMode = ['walk', 'gta-walk', 'gta-drive'].includes(mode) ? mode : 'walk';
    if (handlers) gtaHandlers = { ...gtaHandlers, ...handlers };
    boostOn = false;
    setWalkSpeedBoost(false);
    if (boostBtnEl) setButtonPressed(boostBtnEl, false);
    if (controlMode !== 'gta-walk') setGtaInteractionAvailable(false);
    applyControlMode();
}

// Called by cab.js's keyboard handler to mirror physical-key state on the
// touch overlay — pressing W lights up ▲, releasing it dims again.
export function setWalkControlPressed(key, pressed) {
    if (key === 'shift' && boostBtnEl) setButtonPressed(boostBtnEl, boostOn || pressed);
    const button = keyToButton.get(key);
    if (!button) return;
    setButtonPressed(button, pressed);
}

export function showWalkControls() {
    if (!containerEl) return;
    containerEl.left.hidden = false;
    containerEl.right.hidden = false;
}

export function hideWalkControls() {
    if (!containerEl) return;
    containerEl.left.hidden = true;
    containerEl.right.hidden = true;
    // Release all held keys when the overlay is hidden so the player
    // doesn't walk off in a direction after the controls disappear.
    for (const key of ['w', 's', 'a', 'd', ' ']) dispatchKeyUp(key);
    clearHeldButtonVisuals();
    // Booster off too — each walk session starts at normal pace.
    boostOn = false;
    setWalkSpeedBoost(false);
    if (boostBtnEl) setButtonPressed(boostBtnEl, false);
    setGtaInteractionAvailable(false);
    setCampaignInteractionAvailable(false);
}
