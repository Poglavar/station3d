// In-scene HUD: the status overlay (speed, next stop, passenger counts), the
// route overlay (sliding "approaching X" / "stopping at Y" message), the
// dedicated driver-mode throttle pill, the toast message, and the station
// arrival bell sound.

import {
    modalEl, containerEl, statusOverlayEl,
    setShareToastHandler,
} from './modal.js';
import { escapeHtml, formatCurrencyEur } from '../core/text.js';
import { finiteOrNull } from '../core/math.js';
import { t, onLangChange } from '../core/i18n.js';
import { campaignOwnsInteraction } from './walk-controls.js';
import { routeOverlayTopPx } from '../core/navigation-guidance.js';
import {
    createUnlockedAudioContext,
    getAudioDestination,
    resumeUnlockedAudioContext,
} from '../core/audio-unlock.js';
import { ensureDashboard, adoptIntoDashboardLeft, setDashboardSpeed, setDashboardInfo, setDashboardMetrics, setDashboardStation, isDashboardVisible } from './dashboard.js';
import { formatRailChainage, formatSignedGradePercent } from '../core/rail-readout.js';
import { formatAircraftInstruments } from '../core/aircraft-readout.js';
import { stationDeparturePresentation } from '../core/station-departure.js';

let routeOverlayEl = null;
let cabToastEl = null;
let driverHudEl = null;
let driverHudThrottleFillEl = null;
let combatHudRowEl = null;
let combatHudCountersEl = null;
let killCounterEl = null;
let lastKillCount = -1;
let demolishedCounterEl = null;
let lastDemolishedCount = -1;
let ammoCounterEl = null;
let lastAmmoCount = -1;
let gunHintEl = null;
let tramHealthEl = null;
let tramHealthFillEl = null;
let lastTramHealthKey = '';
let fireBtnEl = null;
let fireBtnHandlers = { onStart: null, onEnd: null };
let viewBtnEl = null;
let viewBtnHandler = null;
let viewIndicatorEl = null;
let viewIndicatorMode = null;
let lastStatusHTML = '';
let lastRouteOverlayHTML = '';
let statusOverlayHeightPx;
let statusSizeObserver = null;

// Force a re-render of the status + route overlays the next time they
// receive a status object after the locale switches, so cached HTML from
// the previous language doesn't stick.
onLangChange(() => {
    lastStatusHTML = '';
    lastRouteOverlayHTML = '';
});
let cabToastTimer = null;
let lastBellStation = null;
let bellCtx = null;

export function ensureHud() {
    if (!containerEl || !modalEl) return;
    if (!routeOverlayEl) {
        routeOverlayEl = document.createElement('div');
        routeOverlayEl.className = 'station-3d-route-overlay hidden';
        containerEl.appendChild(routeOverlayEl);
    }
    if (!cabToastEl) {
        cabToastEl = document.createElement('div');
        cabToastEl.className = 'station-3d-toast hidden';
        cabToastEl.setAttribute('aria-live', 'polite');
        cabToastEl.setAttribute('role', 'status');
        containerEl.appendChild(cabToastEl);
    }
    ensureCombatHudRow();
    ensureDriverHud();
    ensureKillCounter();
    ensureAmmoCounter();
    ensureGunHint();
    ensureTramHealthBar();
    ensureFireButton();
    ensureViewButton();
    ensureViewIndicator();
    // Wire the modal's ride-share handler to route through our toast.
    setShareToastHandler(showCabToast);
}

// On a phone the row has to tuck right under the header and the health strip:
// the 66 px desktop offset (which clears the centered route/station banner)
// pushed the passenger counters and the kill pill far down the viewport. The
// banner is centred, so at the screen edges there is nothing to clear.
const COMPACT_HUD_MEDIA = window.matchMedia(
    '(max-width: 768px), (orientation: landscape) and (max-height: 500px)',
);
// The status band on a phone: one pill line (about 30 px) plus its gap. The
// stacked readouts start under it at all times; see routeOverlayTopPx.
const STACKED_READOUT_BAND_PX = 38;

let hudTopClearancePx = 0;
let routeOverlayHeightPx = 0;
const HUD_CLEARANCE_MEDIA = window.matchMedia('(max-width: 799px)');

export function setHudTopClearance(heightPx, routeHeightPx = routeOverlayHeightPx) {
    const next = Number.isFinite(heightPx) ? Math.max(0, heightPx) : 0;
    const nextRoute = Number.isFinite(routeHeightPx) ? Math.max(0, routeHeightPx) : 0;
    if (next === hudTopClearancePx && nextRoute === routeOverlayHeightPx) return;
    hudTopClearancePx = next;
    routeOverlayHeightPx = nextRoute;
    syncCombatHudRowTop();
}

function getCombatHudRowTopPx() {
    // Snug under the top icon bar: the cab frame is thick, the counters and
    // status lines must not float over the windshield. Phones keep a notch
    // margin.
    const base = COMPACT_HUD_MEDIA.matches ? 22 : 12;
    return HUD_CLEARANCE_MEDIA.matches && hudTopClearancePx > 0
        ? base + hudTopClearancePx + 18 : base;
}

function syncCombatHudRowTop() {
    if (combatHudRowEl) combatHudRowEl.style.top = `${getCombatHudRowTopPx()}px`;
    syncRouteOverlayTop();
    syncMinimapTopClearance();
}

COMPACT_HUD_MEDIA.addEventListener('change', syncCombatHudRowTop);
HUD_CLEARANCE_MEDIA.addEventListener('change', syncCombatHudRowTop);

function ensureCombatHudRow() {
    if (combatHudRowEl || !containerEl || !statusOverlayEl) return;
    combatHudRowEl = document.createElement('div');
    combatHudRowEl.className = 'station-3d-combat-hud-row';
    combatHudRowEl.style.cssText = [
        'position:absolute',
        `top:${getCombatHudRowTopPx()}px`,
        'left:20px',
        'right:20px',
        'display:flex',
        'align-items:center',
        'justify-content:space-between',
        'gap:12px',
        'pointer-events:none',
        'z-index:6',
    ].join(';');
    containerEl.appendChild(combatHudRowEl);
    combatHudRowEl.appendChild(statusOverlayEl);

    combatHudCountersEl = document.createElement('div');
    combatHudCountersEl.className = 'station-3d-combat-hud-counters';
    combatHudCountersEl.style.cssText = [
        'display:flex',
        'align-items:center',
        'justify-content:flex-end',
        'gap:8px',
        'min-width:0',
        'margin-left:auto',
    ].join(';');
    combatHudRowEl.appendChild(combatHudCountersEl);
    // The pill's styling lives in shell.css (`.station-3d-combat-hud-row >
    // .station-3d-status`): as inline style no phone rule could reach it, and
    // its desktop reservation for the counters left an "E · Uđi u vozilo"
    // prompt a pill too small for its own text on a 390 px screen.
    // The browser reports the border box after its normal layout pass. Reading
    // offsetHeight/offsetParent after per-frame HUD writes used to force layout
    // on the animation thread, even when the status pill was hidden (Sep 6 trace).
    // HUD elements live for the page lifetime and are reused across sessions.
    statusSizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
            if (entry.target !== statusOverlayEl) continue;
            const height = entry.borderBoxSize[0]?.blockSize;
            if (!Number.isFinite(height) || height < 0) continue;
            statusOverlayHeightPx = height;
            syncRouteOverlayTop();
            syncMinimapTopClearance();
        }
    });
    statusSizeObserver.observe(statusOverlayEl, { box: 'border-box' });
}

// Tram health: persistent full-width combat HUD strip along the top edge
// of the 3D view so damage reads instantly without consuming HUD text space.
// Semi-transparent: it spans the whole top edge and is up for the entire ride,
// so an opaque band reads as chrome bolted over the windshield. At 0.55 the
// colour still carries at a glance while the world shows through it.
const TRAM_HEALTH_COLORS = Object.freeze({
    ok: 'rgba(34, 197, 94, 0.55)',        // #22c55e
    warn: 'rgba(245, 158, 11, 0.6)',      // #f59e0b
    critical: 'rgba(239, 68, 68, 0.65)',  // #ef4444 — loudest, least see-through
});
function ensureTramHealthBar() {
    if (tramHealthEl || !containerEl) return;
    tramHealthEl = document.createElement('div');
    tramHealthEl.className = 'station-3d-tram-health';
    tramHealthEl.style.cssText = [
        'position:absolute',
        'top:0',
        'left:0',
        'right:0',
        'width:100%',
        'pointer-events:none',
        'z-index:6',
        'display:none',
    ].join(';');

    const track = document.createElement('div');
    track.style.cssText = [
        'height:12px',
        'overflow:hidden',
        'background:rgba(148,163,184,0.22)',
        'box-shadow:0 2px 10px rgba(0,0,0,0.18), inset 0 0 0 1px rgba(255,255,255,0.08)',
    ].join(';');

    tramHealthFillEl = document.createElement('div');
    tramHealthFillEl.style.cssText = [
        'height:100%',
        'width:100%',
        `background:${TRAM_HEALTH_COLORS.ok}`,
        'transition:width 130ms ease,background-color 130ms ease',
    ].join(';');
    track.appendChild(tramHealthFillEl);

    tramHealthEl.appendChild(track);
    containerEl.appendChild(tramHealthEl);
}

export function updateTramHealthBar(current, max) {
    if (!tramHealthEl) ensureTramHealthBar();
    if (!tramHealthEl || !tramHealthFillEl) return;

    const safeMax = Math.max(1, Number(max) || 1);
    const safeCurrent = Math.max(0, Math.min(safeMax, Number(current) || 0));
    const ratio = safeCurrent / safeMax;
    const roundedPercent = Math.round(ratio * 100);
    const key = `${roundedPercent}`;
    if (key !== lastTramHealthKey) {
        lastTramHealthKey = key;
        tramHealthFillEl.style.width = `${roundedPercent}%`;
        tramHealthFillEl.style.background = ratio <= 0.25
            ? TRAM_HEALTH_COLORS.critical
            : ratio <= 0.55
                ? TRAM_HEALTH_COLORS.warn
                : TRAM_HEALTH_COLORS.ok;
    }
    tramHealthEl.style.display = '';
}

export function hideTramHealthBar() {
    if (tramHealthEl) tramHealthEl.style.display = 'none';
    lastTramHealthKey = '';
}

// Wreck counter (gamification): a small pill in the shared top-left HUD row.
// Hidden until the player wrecks at least one car.
function ensureKillCounter() {
    if (killCounterEl || !containerEl) return;
    ensureCombatHudRow();
    killCounterEl = document.createElement('div');
    killCounterEl.className = 'station-3d-kill-counter';
    killCounterEl.style.cssText = [
        'position:static',
        'background:rgba(15,23,42,0.85)',
        'color:#f8fafc',
        'padding:8px 14px',
        'border-radius:999px',
        'font:700 0.95rem/1 ui-sans-serif,system-ui,sans-serif',
        'pointer-events:none',
        'box-shadow:0 4px 14px rgba(0,0,0,0.30)',
        'backdrop-filter:blur(6px)',
        '-webkit-backdrop-filter:blur(6px)',
        'z-index:6',
        'display:none',
    ].join(';');
    (combatHudCountersEl || combatHudRowEl || containerEl).appendChild(killCounterEl);
}

export function updateKillCounter(count) {
    if (!killCounterEl) ensureKillCounter();
    if (!killCounterEl) return;
    if (count === lastKillCount) return;
    lastKillCount = count;
    if (count > 0) {
        killCounterEl.textContent = `💥 ${count}`;
        killCounterEl.style.display = '';
    } else {
        killCounterEl.style.display = 'none';
    }
}

export function hideKillCounter() {
    if (killCounterEl) killCounterEl.style.display = 'none';
    lastKillCount = -1;
}

// 🏚️ counter: how many existing buildings the drawn track passes through and
// demolishes (rendered as transparent ghosts). Works in every city — it counts
// the client-side track-impact demolitions, not the Zagreb-only GDI carve. Sits
// beside the 💥 wrecked-cars counter; same round-pill look; hidden at zero.
function ensureDemolishedCounter() {
    if (demolishedCounterEl || !containerEl) return;
    ensureCombatHudRow();
    demolishedCounterEl = document.createElement('div');
    demolishedCounterEl.className = 'station-3d-demolished-counter';
    // The count alone does not say what it counts. It needs pointer events for
    // the browser to show a title at all — the pill was inert, so the tooltip
    // it already carried could never appear.
    demolishedCounterEl.title = t('hud.demolishedHint');
    onLangChange(() => {
        if (demolishedCounterEl) demolishedCounterEl.title = t('hud.demolishedHint');
    });
    demolishedCounterEl.style.cssText = [
        'position:static',
        'background:rgba(15,23,42,0.85)',
        'color:#f8fafc',
        'padding:8px 14px',
        'border-radius:999px',
        'font:700 0.95rem/1 ui-sans-serif,system-ui,sans-serif',
        'pointer-events:auto',
        'cursor:help',
        'box-shadow:0 4px 14px rgba(0,0,0,0.30)',
        'backdrop-filter:blur(6px)',
        '-webkit-backdrop-filter:blur(6px)',
        'z-index:6',
        'display:none',
    ].join(';');
    (combatHudCountersEl || combatHudRowEl || containerEl).appendChild(demolishedCounterEl);
}

export function updateDemolishedCounter(count) {
    if (!demolishedCounterEl) ensureDemolishedCounter();
    if (!demolishedCounterEl) return;
    if (count === lastDemolishedCount) return;
    lastDemolishedCount = count;
    if (count > 0) {
        demolishedCounterEl.textContent = `🏚️ ${count}`;
        demolishedCounterEl.style.display = '';
    } else {
        demolishedCounterEl.style.display = 'none';
    }
}

export function hideDemolishedCounter() {
    if (demolishedCounterEl) demolishedCounterEl.style.display = 'none';
    lastDemolishedCount = -1;
}

// Ammo counter (gamification): pill below the kill counter, shown only
// while the machine gun is out. Bullets start at 1000 per cab session
// and refill +100 at every station stop.
function ensureAmmoCounter() {
    if (ammoCounterEl || !containerEl) return;
    ensureCombatHudRow();
    ammoCounterEl = document.createElement('div');
    ammoCounterEl.className = 'station-3d-ammo-counter';
    ammoCounterEl.style.cssText = [
        'position:static',
        'background:rgba(15,23,42,0.85)',
        'color:#f8fafc',
        'padding:8px 14px',
        'border-radius:999px',
        'font:700 0.95rem/1 ui-sans-serif,system-ui,sans-serif',
        'pointer-events:none',
        'box-shadow:0 4px 14px rgba(0,0,0,0.30)',
        'backdrop-filter:blur(6px)',
        '-webkit-backdrop-filter:blur(6px)',
        'z-index:6',
        'display:none',
    ].join(';');
    (combatHudCountersEl || combatHudRowEl || containerEl).appendChild(ammoCounterEl);
}

// Update the ammo pill. Pass `visible=false` to hide it (e.g. when the
// machine gun isn't out). Empty (ammo=0) shows a red label. The optional
// hint flag uses the same HUD slot while ammo is hidden.
export function updateAmmoCounter(count, visible = true, hintVisible = false) {
    if (!ammoCounterEl) ensureAmmoCounter();
    if (!ammoCounterEl) return;
    if (!visible) {
        if (ammoCounterEl.style.display !== 'none') ammoCounterEl.style.display = 'none';
        lastAmmoCount = -1;
        updateGunHint(hintVisible);
        return;
    }
    hideGunHint();
    if (count === lastAmmoCount) {
        if (ammoCounterEl.style.display === 'none') ammoCounterEl.style.display = '';
        return;
    }
    lastAmmoCount = count;
    ammoCounterEl.textContent = `🔫 ${count}`;
    ammoCounterEl.style.color = count <= 0 ? '#fca5a5' : '#f8fafc';
    ammoCounterEl.style.display = '';
}

export function hideAmmoCounter() {
    if (ammoCounterEl) ammoCounterEl.style.display = 'none';
    hideGunHint();
    lastAmmoCount = -1;
}

// Gun hint: shown in game mode while the weapon is still stowed. It uses
// the ammo-counter slot because those two states are mutually exclusive.
function ensureGunHint() {
    if (gunHintEl || !containerEl) return;
    ensureCombatHudRow();
    gunHintEl = document.createElement('div');
    gunHintEl.className = 'station-3d-gun-hint';
    gunHintEl.textContent = t('hud.gunHint');
    onLangChange(() => { if (gunHintEl) gunHintEl.textContent = t('hud.gunHint'); });
    gunHintEl.style.cssText = [
        'position:static',
        'max-width:min(210px,calc(100% - 24px))',
        'background:rgba(15,23,42,0.85)',
        'color:#f8fafc',
        'padding:8px 14px',
        'border-radius:999px',
        'font:700 0.88rem/1.1 ui-sans-serif,system-ui,sans-serif',
        'text-align:center',
        'white-space:normal',
        'pointer-events:none',
        'box-shadow:0 4px 14px rgba(0,0,0,0.30)',
        'backdrop-filter:blur(6px)',
        '-webkit-backdrop-filter:blur(6px)',
        'z-index:6',
        'display:none',
    ].join(';');
    (combatHudCountersEl || combatHudRowEl || containerEl).appendChild(gunHintEl);
}

function updateGunHint(visible) {
    if (!gunHintEl) ensureGunHint();
    if (!gunHintEl) return;
    const next = visible ? '' : 'none';
    if (gunHintEl.style.display !== next) gunHintEl.style.display = next;
}

function hideGunHint() {
    if (gunHintEl) gunHintEl.style.display = 'none';
}

// Mobile hold-to-fire button. Lives at bottom-LEFT (driver controls live
// at bottom-right) so the player can hold the phone in either hand and
// still reach the fire trigger with a thumb. Hidden by default; shown
// once the gun is attached. Pointer events mirror the desktop spacebar:
// pointerdown → fire start, pointerup/cancel/leave → fire end.
function ensureFireButton() {
    if (fireBtnEl || !containerEl) return;
    fireBtnEl = document.createElement('button');
    fireBtnEl.type = 'button';
    fireBtnEl.setAttribute('aria-label', t('hud.fireBtnLabel'));
    fireBtnEl.title = t('hud.fireBtnTitle');
    onLangChange(() => {
        if (!fireBtnEl) return;
        fireBtnEl.setAttribute('aria-label', t('hud.fireBtnLabel'));
        fireBtnEl.title = t('hud.fireBtnTitle');
    });
    fireBtnEl.textContent = '🔫';
    fireBtnEl.style.cssText = [
        'position:absolute',
        'left:18px',
        'bottom:18px',
        'width:84px',
        'height:84px',
        'border-radius:50%',
        'border:2px solid rgba(255,255,255,0.32)',
        'background:rgba(220,38,38,0.78)',
        'color:#fff',
        'font-size:36px',
        'line-height:1',
        'display:none',
        'align-items:center',
        'justify-content:center',
        'box-shadow:0 12px 28px rgba(0,0,0,0.4)',
        'backdrop-filter:blur(6px)',
        '-webkit-backdrop-filter:blur(6px)',
        'touch-action:none',
        'user-select:none',
        '-webkit-user-select:none',
        '-webkit-touch-callout:none',
        'z-index:7',
        'pointer-events:auto',
        'transition:transform 90ms ease, background 90ms ease',
    ].join(';');
    containerEl.appendChild(fireBtnEl);

    const press = (e) => {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        fireBtnEl.style.transform = 'scale(0.92)';
        fireBtnEl.style.background = 'rgba(185,28,28,0.92)';
        fireBtnEl.setPointerCapture?.(e.pointerId);
        fireBtnHandlers.onStart?.();
    };
    const release = (e) => {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        fireBtnEl.style.transform = '';
        fireBtnEl.style.background = 'rgba(220,38,38,0.78)';
        fireBtnHandlers.onEnd?.();
    };
    fireBtnEl.addEventListener('pointerdown', press);
    fireBtnEl.addEventListener('pointerup', release);
    fireBtnEl.addEventListener('pointercancel', release);
    fireBtnEl.addEventListener('pointerleave', release);
    // Suppress synthetic clicks / context menus that follow long presses.
    fireBtnEl.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
    fireBtnEl.addEventListener('contextmenu', (e) => e.preventDefault());
}

export function setFireButtonHandlers(onStart, onEnd) {
    fireBtnHandlers.onStart = onStart;
    fireBtnHandlers.onEnd = onEnd;
}

export function showFireButton() {
    if (!fireBtnEl) ensureFireButton();
    if (fireBtnEl) fireBtnEl.style.display = 'flex';
}

export function hideFireButton() {
    if (fireBtnEl) {
        fireBtnEl.style.display = 'none';
        // Make sure we don't leave the gun firing if the button was held
        // when it got hidden (e.g. weapon detached mid-press).
        fireBtnHandlers.onEnd?.();
    }
}

// Camera-cycle button. It lives in the cab console as a physical eye control;
// tapping it fires the handler set via setViewButtonHandler — the same effect
// as the desktop "C" key.
function ensureViewButton() {
    if (viewBtnEl || !containerEl) return;
    viewBtnEl = document.createElement('button');
    viewBtnEl.type = 'button';
    viewBtnEl.setAttribute('aria-label', t('view.hint'));
    viewBtnEl.title = t('view.hint');
    onLangChange(() => {
        if (!viewBtnEl) return;
        viewBtnEl.setAttribute('aria-label', t('view.hint'));
        viewBtnEl.title = t('view.hint');
    });
    viewBtnEl.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">'
        + '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6S2.5 12 2.5 12Z" '
        + 'fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>'
        + '<circle cx="12" cy="12" r="2.7" fill="currentColor"/></svg>';
    viewBtnEl.className = 'station-3d-console-button station-3d-dash-view';
    viewBtnEl.style.display = 'none';
    ensureDashboard();
    adoptIntoDashboardLeft(viewBtnEl);

    const tap = (e) => {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        viewBtnHandler?.();
    };
    viewBtnEl.addEventListener('click', tap);
    viewBtnEl.addEventListener('contextmenu', (e) => e.preventDefault());
}

export function setViewButtonHandler(fn) {
    viewBtnHandler = typeof fn === 'function' ? fn : null;
}

// The C button used to float and needed per-session repositioning; it now
// lives in the dashboard console, so placement is a no-op kept only for the
// callers' sake.
export function setViewButtonPlacement() {
    if (!viewBtnEl) ensureViewButton();
}

export function showViewButton() {
    if (!viewBtnEl) ensureViewButton();
    if (viewBtnEl) viewBtnEl.style.display = 'flex';
}

export function hideViewButton() {
    if (viewBtnEl) viewBtnEl.style.display = 'none';
}

// Persistent view-mode badge. The 1.2 s toast on (C) press tells you the
// view JUST changed; this badge keeps reminding you that the cab is
// pointed BACKWARDS so you don't get confused mid-game. Only shown for
// the 'rear' mode — front-cab is the default and outside view is
// visually obvious from the orbiting camera.
function ensureViewIndicator() {
    if (viewIndicatorEl || !containerEl) return;
    viewIndicatorEl = document.createElement('div');
    viewIndicatorEl.style.cssText = [
        'position:absolute',
        'top:64px',
        'left:50%',
        'transform:translateX(-50%)',
        'background:rgba(15,23,42,0.78)',
        'color:#f8fafc',
        'padding:6px 14px',
        'border-radius:999px',
        'font:800 13px/1 ui-sans-serif,system-ui,sans-serif',
        'letter-spacing:0.4px',
        'box-shadow:0 6px 18px rgba(0,0,0,0.35)',
        'backdrop-filter:blur(6px)',
        '-webkit-backdrop-filter:blur(6px)',
        'pointer-events:none',
        'user-select:none',
        '-webkit-user-select:none',
        'display:none',
        'z-index:6',
    ].join(';');
    containerEl.appendChild(viewIndicatorEl);
    onLangChange(() => {
        if (viewIndicatorMode) refreshViewIndicatorText();
    });
}

function refreshViewIndicatorText() {
    if (!viewIndicatorEl) return;
    const key = viewIndicatorMode === 'rear' ? 'view.rearCab'
              : viewIndicatorMode === 'third' ? 'view.outside'
              : 'view.frontCab';
    viewIndicatorEl.textContent = t(key);
}

export function setViewIndicator(mode) {
    if (!viewIndicatorEl) ensureViewIndicator();
    if (!viewIndicatorEl) return;
    viewIndicatorMode = mode;
    if (mode === 'rear') {
        refreshViewIndicatorText();
        viewIndicatorEl.style.display = 'block';
    } else {
        viewIndicatorEl.style.display = 'none';
    }
}

export function hideViewIndicator() {
    if (viewIndicatorEl) viewIndicatorEl.style.display = 'none';
    viewIndicatorMode = null;
}

export function showCabToast(message, durationMs = 2200) {
    if (!cabToastEl) return;
    if (cabToastTimer) {
        clearTimeout(cabToastTimer);
        cabToastTimer = null;
    }
    cabToastEl.textContent = message;
    cabToastEl.classList.remove('hidden');
    cabToastTimer = setTimeout(() => {
        cabToastEl.classList.add('hidden');
        cabToastTimer = null;
    }, durationMs);
}

export function hideCabToast() {
    if (!cabToastEl) return;
    cabToastEl.classList.add('hidden');
    if (cabToastTimer) {
        clearTimeout(cabToastTimer);
        cabToastTimer = null;
    }
}

// ─── Status + route overlays (read from cab mode per frame) ────────────────

export function renderRouteOverlay(html) {
    if (!routeOverlayEl) return;
    if (!html) {
        if (!routeOverlayEl.classList.contains('hidden')) {
            routeOverlayEl.classList.add('hidden');
            routeOverlayEl.innerHTML = '';
            lastRouteOverlayHTML = '';
        }
        return;
    }
    if (html !== lastRouteOverlayHTML) {
        routeOverlayEl.innerHTML = html;
        lastRouteOverlayHTML = html;
    }
    routeOverlayEl.classList.remove('hidden');
}

// Keeps the readouts below the vehicle status pill, which is centred in the
// combat HUD row at the very top. Without this the exit prompt is drawn over
// the speed and chainage readouts in every vehicle.
function syncRouteOverlayTop() {
    if (!routeOverlayEl) return;
    const statusVisible = !!statusOverlayEl
        && !statusOverlayEl.classList.contains('hidden')
        && statusOverlayHeightPx !== 0;
    const topPx = routeOverlayTopPx({
        statusVisible,
        statusTopPx: getCombatHudRowTopPx(),
        statusHeightPx: statusOverlayHeightPx,
        stackedBandPx: COMPACT_HUD_MEDIA.matches ? STACKED_READOUT_BAND_PX : null,
    });
    const top = `${topPx}px`;
    if (routeOverlayEl.style.top !== top) routeOverlayEl.style.top = top;
}

// Only resize/media/objective changes publish this layout reservation.
function syncMinimapTopClearance() {
    if (hudTopClearancePx <= 0 || !HUD_CLEARANCE_MEDIA.matches) return;
    const topPx = routeOverlayTopPx({
        statusVisible: !!statusOverlayEl && !statusOverlayEl.classList.contains('hidden')
            && statusOverlayHeightPx !== 0,
        statusTopPx: getCombatHudRowTopPx(),
        statusHeightPx: statusOverlayHeightPx,
        stackedBandPx: COMPACT_HUD_MEDIA.matches ? STACKED_READOUT_BAND_PX : null,
    });
    const bottom = `${Math.ceil(topPx + routeOverlayHeightPx + 48)}px`;
    if (containerEl?.style.getPropertyValue('--station3d-campaign-hud-bottom') !== bottom) {
        containerEl?.style.setProperty('--station3d-campaign-hud-bottom', bottom);
    }
}

export function renderStatusOverlay(status) {
    if (!statusOverlayEl) return;
    if (!status) {
        if (!statusOverlayEl.classList.contains('hidden')) {
            statusOverlayEl.classList.add('hidden');
            statusOverlayEl.innerHTML = '';
            lastStatusHTML = '';
        }
        renderRouteOverlay('');
        syncRouteOverlayTop();
        return;
    }
    const lines = [];
    let routeOverlayHTML = '';
    const speedKmh = Number(status.speedKmh);
    const routeParts = [];
    // With the dashboard console active, speed and route info render as
    // dashboard instruments instead of the floating top pill.
    const dashActive = isDashboardVisible();
    const dashParts = [];
    // Next-stop / at-station line for the bottom-centre station display (its
    // own element now, no longer inline in the PIS parts). Set by the paused,
    // stop-guide and next-station branches below; '' clears it when running
    // between stops.
    let dashStationHTML = null;
    if (status.railMode) {
        const modeKey = status.railMode === 'train' ? 'title.train' : 'title.tram';
        const gaugeMm = Number(status.trackGaugeMm);
        const identity = Number.isFinite(gaugeMm)
            ? `${escapeHtml(t(modeKey))} · ${Math.round(gaugeMm)} mm`
            : escapeHtml(t(modeKey));
        if (dashActive) dashParts.push(identity);
        else routeParts.push(`<span class="station-3d-route-label">${identity}</span>`);
    }
    if (status.routeDirectionLabel) {
        const direction = `🧭 ${escapeHtml(status.routeDirectionLabel)}`;
        if (dashActive) dashParts.push(direction);
        else routeParts.push(`<span class="station-3d-route-label">${direction}</span>`);
    }
    const railMetrics = !status.walkMode && !status.driving;
    const chainage = railMetrics ? formatRailChainage(status.chainageM) : '';
    const grade = railMetrics ? formatSignedGradePercent(status.gradePercent) : '';
    if (dashActive) {
        // Altitude, grade, and chainage each render in their own console gauge,
        // so the grade shows exactly once (it used to also appear in the PIS
        // line). Chainage/grade therefore no longer join dashParts.
        setDashboardMetrics(
            status.altitudeM,
            status.altitudeAbsolute,
            railMetrics ? status.gradePercent : null,
            chainage || '',
        );
    } else {
        if (chainage) routeParts.push(`<span class="station-3d-route-label">${chainage}</span>`);
        if (grade) routeParts.push(`<span class="station-3d-route-label">${grade}</span>`);
    }
    // Flying replaces the rail pair with gauges an aircraft can act on: height
    // above the ground below, climb/descent rate, and engine power (with the
    // Q power-hold marked, since a held throttle otherwise looks like a stuck
    // one). cab mode leaves status.aircraft unset for every other controller.
    const aircraft = formatAircraftInstruments(status.aircraft);
    if (aircraft && !dashActive) {
        for (const value of [aircraft.agl, aircraft.vertical, aircraft.throttle]) {
            if (value) routeParts.push(`<span class="station-3d-route-label">${escapeHtml(value)}</span>`);
        }
    }
    // Altitude joins the top status line only when the dashboard console is
    // hidden (walk mode) — in the cab it has its own pill beside the console.
    if (!dashActive && !status.campaignOnFoot && Number.isFinite(Number(status.altitudeM))) {
        // Whole metres in the air. A tenth of a metre is noise at 90 m/s, and
        // dropping it keeps the five-gauge aircraft row on one line.
        const rounded = aircraft
            ? Math.round(Number(status.altitudeM))
            : Math.round(Number(status.altitudeM) * 10) / 10;
        const sign = !status.altitudeAbsolute && rounded > 0 ? '+' : '';
        const shown = aircraft ? String(rounded) : rounded.toFixed(1);
        routeParts.push(`<span class="station-3d-route-label">${sign}${shown} m</span>`);
    }
    const routeSpeedHTML = !status.driverMode && !status.campaignOnFoot && Number.isFinite(speedKmh) && !dashActive
        ? `<span class="station-3d-route-speed">${Math.max(0, Math.round(speedKmh))} km/h</span>`
        : '';
    if (dashActive) {
        if (status.driverMode) {
            setDashboardSpeed(status.speedKmh, status.limitKmh, status.limitActive, status.overspeed);
        } else {
            setDashboardSpeed(speedKmh, null, false, false);
        }
    }
    if (status.paused) {
        const where = status.stationName
            ? t('hud.atStation', { name: escapeHtml(status.stationName) })
            : t('hud.atStationGeneric');
        const departure = stationDeparturePresentation(status);
        let departureText = '';
        if (departure?.kind === 'countdown') {
            departureText = t('hud.departsIn', { n: departure.seconds });
        } else if (departure?.kind === 'waiting-doors') {
            departureText = t('hud.departureWaitingDoors');
        } else if (departure?.kind === 'departing') {
            departureText = t('hud.departing');
        } else if (departure?.kind === 'manual') {
            departureText = t('hud.manualDeparture');
        }
        const departureHTML = departureText ? ` · ${escapeHtml(departureText)}` : '';
        routeParts.push(`<span class="station-3d-route-label station-3d-route-line-paused">🛑 ${where}${departureHTML}</span>`);
        dashStationHTML = `<span class="station-3d-dash-station-paused">🛑 ${where}${departureHTML}</span>`;
        if (status.stationName && status.stationName !== lastBellStation) {
            lastBellStation = status.stationName;
            playStationBell();
        }
        if (status.lastAlighted || status.lastBoarded) {
            lines.push(`<span class="station-3d-status-line">${escapeHtml(t('hud.boardingDelta', { off: status.lastAlighted, on: status.lastBoarded }))}</span>`);
        }
    } else if (status.driverMode) {
        // Driver-mode readouts: speed + curve limit render on the dashboard
        // (or in the status overlay when the console is off). Overspeed
        // (safety brake active) flashes red either way.
        if (!dashActive) {
            const limitSuffix = status.limitActive && Number.isFinite(Number(status.limitKmh))
                ? ` / ${status.limitKmh}` : '';
            const overspeedCls = status.overspeed ? ' station-3d-status-overspeed' : '';
            lines.push(`<span class="station-3d-status-line${overspeedCls}">${status.speedKmh}${limitSuffix} km/h</span>`);
        }
        if (status.upcomingSwitch) {
            const dist = Math.round(status.upcomingSwitch.distM / 5) * 5;
            if (dashActive) dashParts.push(escapeHtml(t('hud.switchAhead', { n: dist })));
            else lines.push(`<span class="station-3d-status-line">${escapeHtml(t('hud.switchAhead', { n: dist }))}</span>`);
        }
        if (status.stopGuide && status.stopGuide.name) {
            const guideText = status.stopGuide.inBand
                ? t('hud.stopGuideHere', { name: status.stopGuide.name })
                : t('hud.stopGuide', { name: status.stopGuide.name, n: Math.max(0, Math.round(status.stopGuide.remainingDistanceM || 0)) });
            routeParts.push(`<span class="station-3d-route-label">${escapeHtml(guideText)}</span>`);
            dashStationHTML = escapeHtml(guideText);
            if (status.stopGuide.inBand) {
                lines.push(`<span class="station-3d-status-line">${escapeHtml(t('hud.stopGuideReady'))}</span>`);
            }
        }
    } else if (status.nextStation) {
        const ns = status.nextStation;
        // Quantize to the nearest 5m so the overlay re-renders a few times
        // per second rather than every frame.
        const dist = Math.round(ns.distanceMeters / 5) * 5;
        const distLabel = dist >= 1000 ? `${(dist / 1000).toFixed(1)} km` : `${dist} m`;
        const name = ns.name ? escapeHtml(ns.name) : '';
        const separator = name ? ' · ' : '';
        routeParts.push(`<span class="station-3d-route-label">➡ ${name}${separator}${distLabel}</span>`);
        dashStationHTML = `➡ ${name}${separator}${distLabel}`;
    }
    // Doors-open indicator — shown regardless of drive mode so a manual
    // driver always sees why the throttle is interlocked.
    if (status.doorsOpen) {
        const doorsLabel = `🚪 ${escapeHtml(t('hud.doorsOpen'))}`;
        if (dashActive) dashParts.push(doorsLabel);
        else routeParts.push(`<span class="station-3d-route-label">${doorsLabel}</span>`);
    }
    if (routeSpeedHTML) {
        routeParts.unshift(routeSpeedHTML);
    }
    if (dashActive) {
        setDashboardInfo(dashParts.join(' · '));
        setDashboardStation(dashStationHTML || '');
        routeOverlayHTML = '';
    } else if (routeParts.length > 0) {
        routeOverlayHTML = `<span class="station-3d-route-line">${routeParts.join('<span class="station-3d-route-divider" aria-hidden="true"> · </span>')}</span>`;
    }
    // Legacy GTFS vehicles don't carry passenger data — hide the row instead
    // of showing "0 / 0". Locations without boarding demand + fares (everywhere
    // but Zagreb) hide the passenger/revenue counters entirely rather than show
    // a static "8 / 200 · 0 EUR".
    if (status.passengersSupported && !status.driverMode && status.capacity) {
        lines.push(`<span class="station-3d-status-line">👥 ${status.totalPassengers} / ${status.capacity}</span>`);
    }
    if (status.passengersSupported && status.balanceEur != null && isFinite(status.balanceEur)) {
        lines.push(`<span class="station-3d-status-line">💶 ${formatCurrencyEur(status.balanceEur)}</span>`);
    }
    const vehicleHealth = finiteOrNull(status.vehicleHealth);
    if (status.gtaMode && status.driving && vehicleHealth !== null) {
        // Name the vehicle you are actually in. A car badge over an aircraft
        // reads as a bug even before you notice the number never moves.
        const vehicleIcon = status.vehicleKind === 'aircraft' ? '✈️'
            : status.vehicleKind === 'boat' ? '🚤' : '🚗';
        lines.push(`<span class="station-3d-status-line">${vehicleIcon} ${Math.max(0, Math.round(vehicleHealth))}%</span>`);
    }
    if (status.gtaInteractionKey && !campaignOwnsInteraction()) {
        const interactionClass = status.gtaInteractionAvailable === false
            ? ' station-3d-status-muted'
            : status.gtaInteractionEnterable
                ? ' station-3d-status-interaction-ready'
                : '';
        lines.push(`<span class="station-3d-status-line${interactionClass}">${escapeHtml(t(status.gtaInteractionKey, { name: status.gtaInteractionName || '' }))}</span>`);
    }
    const html = lines.join('');
    renderRouteOverlay(routeOverlayHTML);
    if (html !== lastStatusHTML) {
        statusOverlayEl.innerHTML = html;
        lastStatusHTML = html;
    }
    if (html && statusOverlayEl.classList.contains('hidden')) {
        statusOverlayEl.classList.remove('hidden');
    } else if (!html && !statusOverlayEl.classList.contains('hidden')) {
        statusOverlayEl.classList.add('hidden');
    }
    syncRouteOverlayTop();
}

// ─── Driver HUD (throttle pill) ────────────────────────────────────────────

function ensureDriverHud() {
    if (driverHudEl || !modalEl) return;
    driverHudEl = document.createElement('div');
    driverHudEl.className = 'station-3d-driver-hud';
    driverHudEl.style.cssText = [
        'position:absolute',
        'right:18px',
        'top:50%',
        'transform:translateY(-50%)',
        'display:none',
        'flex-direction:column',
        'gap:14px',
        'font-family:ui-sans-serif,system-ui,sans-serif',
        'color:#f9fafb',
        'pointer-events:none',
        'user-select:none',
        'z-index:5',
    ].join(';');

    const labelStyle = 'font-size:11px;opacity:0.88;letter-spacing:0.4px;text-shadow:0 1px 3px rgba(0,0,0,0.45)';

    const throttle = document.createElement('div');
    throttle.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px';
    const renderThrottleHTML = () => {
        throttle.innerHTML = [
            `<div data-throttle-label-top style="${labelStyle}">${escapeHtml(t('hud.throttle'))}</div>`,
            '<div style="position:relative;width:20px;height:170px;',
            'background:rgba(255,255,255,0.12);border-radius:999px;overflow:hidden;',
            'border:1px solid rgba(255,255,255,0.24);box-shadow:0 6px 18px rgba(0,0,0,0.22)">',
            '  <div style="position:absolute;left:0;right:0;top:50%;height:1px;',
            '       background:rgba(255,255,255,0.55)"></div>',
            '  <div data-throttle-fill style="position:absolute;left:0;right:0;height:0;',
            '       background:#34d399;transition:height 80ms linear,top 80ms linear,bottom 80ms linear,background 120ms"></div>',
            '</div>',
            `<div data-throttle-label-bottom style="${labelStyle}">${escapeHtml(t('hud.brake'))}</div>`,
        ].join('');
        driverHudThrottleFillEl = throttle.querySelector('[data-throttle-fill]');
    };
    renderThrottleHTML();
    onLangChange(renderThrottleHTML);

    driverHudEl.appendChild(throttle);
    modalEl.appendChild(driverHudEl);
}

export function renderDriverHud(driver) {
    if (!driverHudEl) return;
    if (!driver || !driver.enabled) {
        if (driverHudEl.style.display !== 'none') driverHudEl.style.display = 'none';
        return;
    }
    if (driverHudEl.style.display === 'none') driverHudEl.style.display = 'flex';

    const t = Math.max(-1, Math.min(1, driver.throttle || 0));
    if (t >= 0) {
        driverHudThrottleFillEl.style.bottom = '50%';
        driverHudThrottleFillEl.style.top = '';
        driverHudThrottleFillEl.style.height = `${t * 50}%`;
        driverHudThrottleFillEl.style.background = '#34d399';
    } else {
        driverHudThrottleFillEl.style.top = '50%';
        driverHudThrottleFillEl.style.bottom = '';
        driverHudThrottleFillEl.style.height = `${-t * 50}%`;
        driverHudThrottleFillEl.style.background = '#f87171';
    }
}

export function hideDriverHud() {
    if (driverHudEl) driverHudEl.style.display = 'none';
}

// ─── Station arrival bell (three-tone descending chime) ────────────────────

export function playStationBell() {
    try {
        if (!bellCtx) bellCtx = createUnlockedAudioContext();
        if (!bellCtx) return;
        const ctx = bellCtx;
        resumeUnlockedAudioContext(ctx);
        const freqs = [880, 784, 698]; // A5 → G5 → F5
        freqs.forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            osc.connect(gain);
            gain.connect(getAudioDestination(ctx));
            const t = ctx.currentTime + i * 0.45;
            gain.gain.setValueAtTime(0, t);
            gain.gain.linearRampToValueAtTime(0.28, t + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
            osc.start(t);
            osc.stop(t + 1.15);
        });
    } catch (_) { /* audio not available */ }
}

export function resetBellMemory() {
    lastBellStation = null;
}
