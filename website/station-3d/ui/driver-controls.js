// Bottom-right on-screen driver controls: the "🕹️" enter-driver-mode button,
// then the Gas / Koči / ◀ / ▶ buttons once active.
//
// Hold controls (accel/brake) and activate controls (left/right, enter) are
// bound via the small helpers below. Every control shields its own pointer
// events from bleeding into the canvas (which steals cab-look drags).

import { modalEl, setAutopilotButtonVisible, setAutopilotButtonState } from './modal.js';
import { ensureDashboard, adoptIntoDashboardControls } from './dashboard.js';
import { state } from '../state.js';
import { t, onLangChange } from '../core/i18n.js';

let driverControlsEl = null;
let driverModeBtnEl = null;
let driverActiveControlsEl = null;
let driverAccelBtnEl = null;
let driverBrakeBtnEl = null;
let driverLeftBtnEl = null;
let driverRightBtnEl = null;
const CAB_CONTROL_BG = 'rgba(15,23,42,0.56)';
const CAB_CONTROL_ACTIVE_BG = 'rgba(30,64,175,0.66)';
const CAB_CONTROL_DRIVE_BG = 'rgba(22,163,74,0.68)';
// Sizing and typography live in transit.css (.station-3d-dash-btn + media
// query) so the dashboard console can shrink the controls on phones —
// inline values would override the breakpoint.
const ACTIVE_DRIVER_BUTTON_STYLE = 'white-space:normal';

// Callbacks set by ensureDriverControls() — bound once per session.
let onEnter = () => {};
let onThrottle = () => {};
let onArmTurn = () => {};

function setDisplay(element, display) {
    if (element && element.style.display !== display) element.style.display = display;
}

function setDisabled(element, disabled) {
    if (element && element.disabled !== disabled) element.disabled = disabled;
}

function setText(element, text) {
    if (element && element.textContent !== text) element.textContent = text;
}

function setButtonActive(element, active) {
    if (!element) return;
    const background = active ? CAB_CONTROL_ACTIVE_BG : CAB_CONTROL_BG;
    const borderColor = active ? 'rgba(147, 197, 253, 0.95)' : 'rgba(255,255,255,0.18)';
    if (element.style.background !== background) element.style.background = background;
    if (element.style.borderColor !== borderColor) element.style.borderColor = borderColor;
}

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

function bindHoldControl(button, onStart, onEnd) {
    if (!button) return;
    const release = (event) => {
        stopCabUiEvent(event);
        onEnd?.();
    };
    button.addEventListener('pointerdown', (event) => {
        stopCabUiEvent(event);
        onStart?.();
        button.setPointerCapture?.(event.pointerId);
    });
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('pointerleave', release);
}

function bindActivateControl(button, onActivate) {
    if (!button) return;
    let lastPointerActivationAt = 0;
    button.addEventListener('pointerup', (event) => {
        stopCabUiEvent(event);
        lastPointerActivationAt = Date.now();
        onActivate?.();
    });
    button.addEventListener('click', (event) => {
        stopCabUiEvent(event);
        if (Date.now() - lastPointerActivationAt < 600) return;
        onActivate?.();
    });
}

function bindCabUiShield(element) {
    if (!element) return;
    const stopOnly = (event) => stopCabUiPropagation(event);
    const stopAndPrevent = (event) => stopCabUiEvent(event);
    for (const eventName of ['pointerdown', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'touchcancel']) {
        element.addEventListener(eventName, stopOnly, { passive: false });
    }
    element.addEventListener('contextmenu', stopAndPrevent, { passive: false });
    element.addEventListener('selectstart', stopAndPrevent, { passive: false });
}

function makeButton(label, dataName, extra = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset[dataName] = 'true';
    button.textContent = label;
    button.className = 'station-3d-dash-btn';
    button.style.cssText = [
        'border-radius:14px',
        'border:1px solid rgba(255,255,255,0.18)',
        `background:${CAB_CONTROL_BG}`,
        'color:#fff',
        'font-family:ui-sans-serif,system-ui,sans-serif',
        'backdrop-filter:blur(6px)',
        '-webkit-backdrop-filter:blur(6px)',
        'box-shadow:0 12px 30px rgba(0,0,0,0.28)',
        'touch-action:none',
        'user-select:none',
        '-webkit-user-select:none',
        '-webkit-touch-callout:none',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'text-align:center',
        extra,
    ].join(';');
    button.draggable = false;
    return button;
}

export function ensureDriverControls(handlers) {
    if (driverControlsEl) {
        onEnter = handlers.onEnter || onEnter;
        onThrottle = handlers.onThrottle || onThrottle;
        onArmTurn = handlers.onArmTurn || onArmTurn;
        return;
    }
    if (!modalEl) return;

    onEnter = handlers.onEnter || onEnter;
    onThrottle = handlers.onThrottle || onThrottle;
    onArmTurn = handlers.onArmTurn || onArmTurn;

    driverControlsEl = document.createElement('div');
    driverControlsEl.dataset.cabDriverControls = 'true';
    // Lives inside the dashboard console (adopted below) — a flat row of
    // instruments rather than the old floating corner pad.
    driverControlsEl.classList.add('station-3d-dash-controls-row');
    driverControlsEl.style.cssText = [
        'display:none',
        'flex-direction:row',
        'align-items:center',
        'pointer-events:auto',
        'touch-action:none',
        'user-select:none',
        '-webkit-user-select:none',
        '-webkit-touch-callout:none',
    ].join(';');

    driverModeBtnEl = makeButton('🕹️', 'cabDriverMode', `width:64px;min-width:64px;min-height:64px;padding:0;font-size:30px;background:${CAB_CONTROL_DRIVE_BG}`);
    driverModeBtnEl.setAttribute('aria-label', t('driver.driveBtn'));
    driverModeBtnEl.title = t('driver.driveBtn');
    driverAccelBtnEl = makeButton(t('hud.throttle'), 'cabDriverAccel', ACTIVE_DRIVER_BUTTON_STYLE);
    driverBrakeBtnEl = makeButton(t('hud.brake'), 'cabDriverBrake', ACTIVE_DRIVER_BUTTON_STYLE);
    driverLeftBtnEl  = makeButton('◀', 'cabDriverLeft', ACTIVE_DRIVER_BUTTON_STYLE);
    driverRightBtnEl = makeButton('▶', 'cabDriverRight', ACTIVE_DRIVER_BUTTON_STYLE);
    driverLeftBtnEl.classList.add('station-3d-dash-btn-arrow');
    driverRightBtnEl.classList.add('station-3d-dash-btn-arrow');

    onLangChange(() => {
        if (driverModeBtnEl) {
            driverModeBtnEl.setAttribute('aria-label', t('driver.driveBtn'));
            driverModeBtnEl.title = t('driver.driveBtn');
        }
        if (driverAccelBtnEl) driverAccelBtnEl.textContent = t('hud.throttle');
        // Brake button label is updated per-frame in updateDriverControls
        // (it flips to "Reverse" when speed has dropped to a halt). No
        // static refresh needed on language change.
    });

    driverActiveControlsEl = document.createElement('div');
    driverActiveControlsEl.classList.add('station-3d-dash-controls-grid');
    driverActiveControlsEl.style.cssText = [
        'display:none',
    ].join(';');
    // Two-row console pad: throttle + brake on the top row (thumb reach),
    // the ◀ / ▶ switch arrows underneath. DOM order fills the 2-column grid
    // row-major, so append top row first.
    driverActiveControlsEl.appendChild(driverAccelBtnEl);
    driverActiveControlsEl.appendChild(driverBrakeBtnEl);
    driverActiveControlsEl.appendChild(driverLeftBtnEl);
    driverActiveControlsEl.appendChild(driverRightBtnEl);

    driverControlsEl.appendChild(driverModeBtnEl);
    driverControlsEl.appendChild(driverActiveControlsEl);
    ensureDashboard();
    adoptIntoDashboardControls(driverControlsEl);
    bindCabUiShield(driverControlsEl);

    bindActivateControl(driverModeBtnEl, () => onEnter());
    bindHoldControl(driverAccelBtnEl,
        () => onThrottle('start', 1),
        () => onThrottle('end', 1));
    bindHoldControl(driverBrakeBtnEl,
        () => onThrottle('start', -1),
        () => onThrottle('end', -1));
    bindActivateControl(driverLeftBtnEl,  () => onArmTurn('left'));
    bindActivateControl(driverRightBtnEl, () => onArmTurn('right'));
}

// Sets the controls' visual state based on current mode + driver state.
// Called by the cab mode whenever it transitions or driver state changes.
export function updateDriverControls() {
    if (!driverControlsEl) return;
    const cabState = state.cabState;
    const inCab = state.mode === 'cab';
    // Walk mode is hosted inside the cab modal but isn't actually driving
    // a tram — hide the joystick / Drive button entirely.
    const isWalkMode = !!(cabState && cabState.walkMode);
    const isUndergroundSession = !!(cabState && cabState.isUndergroundSession);
    const hasDriverGraph = !!(cabState && cabState.driverGraph);
    const hasUnavailableMessage = !!(cabState && (cabState.driverUnavailableMessage || cabState.driverUnavailableKey));
    const driverEnabled = !!(cabState && cabState.driver && cabState.driver.enabled);
    const canEnterDriverMode = !isWalkMode && !isUndergroundSession && (hasDriverGraph || hasUnavailableMessage);
    setDisplay(driverControlsEl, inCab && canEnterDriverMode ? 'flex' : 'none');
    if (!canEnterDriverMode) {
        // In walk mode the autopilot can't do anything — keep the 🤖 icon
        // visible (as it was in the cab) but greyed and inactive. For non-walk
        // non-drivable sessions (underground/train) hide it entirely.
        if (!isWalkMode) setAutopilotButtonVisible(false);
        setAutopilotButtonState({ engaged: false, clickable: false });
        return;
    }
    // Header autopilot icon: visible whenever a driveable rail session is
    // active. Engaged covers BOTH schedule autopilot (driver=null,
    // poseFn-driven) and driver-graph autopilot (driver.enabled +
    // driver.autopilot, layer-controlled). Clickable only when the
    // player has fully taken over (driver enabled, autopilot flag off)
    // — clicking hands the wheel back via disableDriverMode which
    // flips the flag back on without teleporting.
    const inDriveableRailSession = !!(
        cabState
        && cabState.driverGraph
        && !cabState.walkMode
        && !cabState.isUndergroundSession
    );
    const driver = cabState && cabState.driver;
    const autopilotEngaged = !driverEnabled || !!(driver && driver.autopilot);
    setAutopilotButtonVisible(inDriveableRailSession);
    setAutopilotButtonState({
        engaged: inDriveableRailSession && autopilotEngaged,
        clickable: inDriveableRailSession && !autopilotEngaged,
    });
    // The 🕹️ "take control" button is now redundant: the header 🤖 icon
    // shows autopilot status, and any throttle/steer input — keyboard
    // or the on-screen Gas/Brake/◀/▶ buttons — auto-engages manual mode.
    // Keep the button only for non-drivable vehicles: it is the discoverable
    // action that pauses the simulation and explains why control is unavailable.
    setDisplay(driverModeBtnEl, hasUnavailableMessage && !hasDriverGraph ? '' : 'none');
    // Active controls (Gas / Brake / ◀ / ▶) stay visible in autopilot
    // too, so the player can override autopilot by tapping any of them.
    // The handlers in cab.js auto-engage driver mode on first input.
    setDisplay(driverActiveControlsEl, inDriveableRailSession ? 'grid' : 'none');
    setDisabled(driverAccelBtnEl, false);
    if (driverBrakeBtnEl) {
        setDisabled(driverBrakeBtnEl, false);
        // Once the tram has slowed to a halt, holding brake creeps the
        // tram backwards. Relabel the button so the player knows that
        // continuing to press it switches from braking to reversing.
        const speed = (cabState && cabState.driver && cabState.driver.speed) || 0;
        const reversing = driverEnabled && speed <= 0.05;
        setText(driverBrakeBtnEl, reversing ? t('hud.reverse') : t('hud.brake'));
    }
    setDisabled(driverLeftBtnEl, false);
    setDisabled(driverRightBtnEl, false);
    const armed = (cabState && cabState.driver && cabState.driver.armedTurn) || 'straight';
    for (const [button, direction] of [
        [driverLeftBtnEl, 'left'],
        [driverRightBtnEl, 'right'],
    ]) {
        setButtonActive(button, armed === direction);
    }
    // Throttle / brake get the same pressed highlight as the direction
    // buttons while held (throttleTarget is ±1 only while the input is down).
    const throttleTarget = (driver && driver.throttleTarget) || 0;
    for (const [button, active] of [
        [driverAccelBtnEl, driverEnabled && throttleTarget > 0],
        [driverBrakeBtnEl, driverEnabled && throttleTarget < 0],
    ]) {
        setButtonActive(button, active);
    }
}
