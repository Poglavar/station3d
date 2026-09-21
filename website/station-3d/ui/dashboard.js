// Cab dashboard console: a bottom strip that hosts the driving controls and
// readouts as instruments — the camera (C) button, digital speed + curve
// limit and heading displays, a PIS-style next-stop/route display, and (adopted from
// driver-controls.js) the switch arrows and throttle/brake buttons. Plain
// DOM rather than raycast 3D surfaces, so every existing binding — hold
// semantics, keyboard shortcuts, the cab UI shield — keeps working; the 3D
// dashboard cowl rendered behind it provides the depth.

import { modalEl } from './modal.js';
import { t, onLangChange } from '../core/i18n.js';
import { compassReading } from '../core/compass.js';
import { formatDashboardMetricValues, formatLoadTelemetry } from '../core/dashboard-metrics.js';
import { loadingGridPlan } from '../core/loading-layout.js';
import { createWorldLoadActivity, formatLoadElapsed, worldLoadFraction, worldLoadStages } from '../core/loading-progress.js';
import { loadingDiagnosticsAllowed } from '../core/loading-curtain-policy.js';
import {
    loadingCurtainDiagnostics,
    loadingCurtainRaised,
    raiseLoadingCurtain,
    setLoadingCurtainHeading,
    setLoadingCurtainLabel,
    setLoadingCurtainProgress,
    setLoadingCurtainDetails,
} from './loading-curtain.js';
import { onTileStreamHealth } from '../core/shared-tile-session.js';
import { setWorldDataOutage } from '../core/world-ready.js';

// Same event shield the driver controls use: pointer/touch events on the
// console must never leak through to the canvas drag-look underneath.
function bindConsoleShield(element) {
    const stopOnly = (event) => {
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    };
    const stopAndPrevent = (event) => {
        if (event.cancelable) event.preventDefault();
        stopOnly(event);
    };
    for (const eventName of ['pointerdown', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'touchcancel']) {
        element.addEventListener(eventName, stopOnly, { passive: false });
    }
    element.addEventListener('contextmenu', stopAndPrevent, { passive: false });
    element.addEventListener('selectstart', stopAndPrevent, { passive: false });
}

let consoleEl = null;
let readoutEl = null;
let readoutDockEl = null;
let leftSlotEl = null;
let speedEl = null;
let speedValueEl = null;
let speedLimitEl = null;
let compassEl = null;
let compassNeedleEl = null;
let compassPointEl = null;
let compassDegreesEl = null;
let controlsSlotEl = null;
let altitudeEl = null;
let altitudeValueEl = null;
let gradeEl = null;
let gradeValueEl = null;
let chainageEl = null;
let chainageValueEl = null;
let stationEl = null;
let lastStationHTML = '';
let bellBtnEl = null;
let bellHandler = null;
let statuslineEl = null;
let doorBtnEl = null;
let doorHandler = null;
let doorOpenState = false;
let brakeBtnEl = null;
let brakeHandler = null;
let brakeAppliedState = false;
let lastSpeedText = '';
let lastLimitText = '';
let lastCompassText = '';
let lastCompassNeedleTenths = null;
let lastInfoHTML = '';
let lastAltitudeText = '';
let lastGradeText = '';
let lastChainageText = '';
let photoLoadingEl = null;
let photoLoadingLabelEl = null;
let photoLoadingTelemetryEl = null;
let photoLoadingFillEl = null;
// The model-world build hold is presented by the one loading screen
// (ui/loading-curtain.js). These track the hold and, on a development host,
// the per-layer breakdown mounted under that screen's bar.
let worldBuildHoldActive = false;
let worldLoadingTelemetryEl = null;
let worldLoadingSegmentsEl = null;
let dataOutageEl = null;
let dataOutageLabelEl = null;
let dataOutageLabels = [];
let lastWorldLoadComponents = [];
let worldLoadActivity = createWorldLoadActivity();
let bakeStatusEl = null;

// The loading screen owns the message while it covers the scene; the pill takes
// over once the world is visible. Re-run on every input that changes either:
// health transitions, language switches, and hold show/hide.
function refreshDataOutageUI() {
    const outage = dataOutageLabels.length > 0;
    const holdVisible = worldBuildHoldActive && loadingCurtainRaised();
    if (holdVisible) setLoadingCurtainLabel(t(outage ? 'hud.dataOutage' : 'hud.loadingWorld'));
    if (dataOutageEl) {
        dataOutageEl.classList.toggle('hidden', !outage || holdVisible);
        if (dataOutageLabelEl) dataOutageLabelEl.textContent = t('hud.dataOutage');
    }
}

export function ensureDashboard() {
    if (consoleEl || !modalEl) return;
    // Bottom console: controls only now — the icon cluster (left) and the drive
    // controls (right), each spread over two rows. The instrument readouts moved
    // up into the top readout bar so the bottom stays uncluttered.
    consoleEl = document.createElement('div');
    consoleEl.className = 'station-3d-dashboard hidden';
    consoleEl.innerHTML = [
        '<div class="station-3d-dash-slot station-3d-dash-left"></div>',
        // Centre column, two rows: the instrument gauges dock into the top one
        // (see setDashboardVisible), the PIS next-stop line sits under them.
        '<div class="station-3d-dash-center">',
        '  <div class="station-3d-dash-readout-dock"></div>',
        '  <div class="station-3d-dash-station"></div>',
        '</div>',
        '<div class="station-3d-dash-slot station-3d-dash-controls"></div>',
    ].join('');
    modalEl.appendChild(consoleEl);
    readoutDockEl = consoleEl.querySelector('.station-3d-dash-readout-dock');

    // The instruments: digital speed + curve limit, altitude/chainage and the
    // heading compass. In the cab they dock into the console's top row (the
    // windshield is more use than another floating strip); in photoreal walk
    // there is no console, so they stay a floating pill under the top icon row.
    readoutEl = document.createElement('div');
    readoutEl.className = 'station-3d-cab-readout hidden';
    readoutEl.innerHTML = [
        '<div class="station-3d-dash-speed">',
        '  <span class="station-3d-dash-speed-value">0</span>',
        '  <span class="station-3d-dash-speed-unit">km/h</span>',
        '  <span class="station-3d-dash-speed-limit"></span>',
        '</div>',
        '<div class="station-3d-cab-metric station-3d-cab-altitude hidden">',
        '  <span class="station-3d-cab-metric-value">–</span>',
        '</div>',
        '<div class="station-3d-cab-metric station-3d-cab-grade hidden">',
        '  <span class="station-3d-cab-metric-value">–</span>',
        '</div>',
        '<div class="station-3d-cab-metric station-3d-cab-chainage hidden">',
        '  <span class="station-3d-cab-metric-value">–</span>',
        '</div>',
        '<div class="station-3d-dash-compass" role="img">',
        '  <span class="station-3d-dash-compass-dial" aria-hidden="true">',
        '    <span class="station-3d-dash-compass-needle"></span>',
        '    <span class="station-3d-dash-compass-lubber"></span>',
        '  </span>',
        '  <span class="station-3d-dash-compass-readout">',
        '    <span class="station-3d-dash-compass-point">N</span>',
        '    <span class="station-3d-dash-compass-degrees">000°</span>',
        '  </span>',
        '</div>',
    ].join('');
    modalEl.appendChild(readoutEl);
    // Transient status strip (doors open / switch ahead / line identity):
    // its own bottom row above the console. It used to live inside the top
    // readout, where its appearing/disappearing text resized and shifted the
    // gauges every time.
    statuslineEl = document.createElement('div');
    statuslineEl.className = 'station-3d-dash-statusline hidden';
    modalEl.appendChild(statuslineEl);
    altitudeEl = readoutEl.querySelector('.station-3d-cab-altitude');
    altitudeValueEl = altitudeEl.querySelector('.station-3d-cab-metric-value');
    gradeEl = readoutEl.querySelector('.station-3d-cab-grade');
    gradeValueEl = gradeEl.querySelector('.station-3d-cab-metric-value');
    chainageEl = readoutEl.querySelector('.station-3d-cab-chainage');
    chainageValueEl = chainageEl.querySelector('.station-3d-cab-metric-value');
    const relabelMetrics = () => {
        altitudeEl.setAttribute('aria-label', t('hud.altitude'));
        altitudeEl.title = t('hud.altitude');
        gradeEl.setAttribute('aria-label', t('hud.grade'));
        gradeEl.title = t('hud.grade');
        chainageEl.setAttribute('aria-label', t('hud.chainage'));
        chainageEl.title = t('hud.chainage');
    };
    relabelMetrics();
    onLangChange(relabelMetrics);
    // Centred "loading surroundings" overlay, shown while the photoreal world is
    // still streaming/refining so the cab never reveals coarse (phantom-tunnel)
    // geometry. Toggled per frame from cab mode via setPhotoLoading().
    photoLoadingEl = document.createElement('div');
    photoLoadingEl.className = 'station-3d-photo-loading hidden';
    photoLoadingEl.innerHTML = [
        '<span class="station-3d-photo-loading-spinner" aria-hidden="true"></span>',
        '<span class="station-3d-photo-loading-label"></span>',
        '<span class="station-3d-photo-loading-telemetry"></span>',
        // Determinate bar: the 3D-tiles streamer reports a real loaded fraction.
        '<span class="station-3d-loading-bar"><span class="station-3d-loading-fill"></span></span>',
    ].join('');
    modalEl.appendChild(photoLoadingEl);
    photoLoadingLabelEl = photoLoadingEl.querySelector('.station-3d-photo-loading-label');
    photoLoadingTelemetryEl = photoLoadingEl.querySelector('.station-3d-photo-loading-telemetry');
    photoLoadingFillEl = photoLoadingEl.querySelector('.station-3d-loading-fill');

    // Data-outage pill: when every fetch to a source is failing (server down),
    // the tile stream announces it — during the build hold the overlay label
    // explains the wait; once the world is revealed this pill carries the same
    // message so an outage never reads as an empty city with no cause. The
    // sources retry on their own; both notices clear the moment data flows.
    dataOutageEl = document.createElement('div');
    dataOutageEl.className = 'station-3d-photo-loading station-3d-data-outage hidden';
    dataOutageEl.innerHTML = [
        '<span class="station-3d-photo-loading-spinner" aria-hidden="true"></span>',
        '<span class="station-3d-data-outage-label"></span>',
    ].join('');
    modalEl.appendChild(dataOutageEl);
    dataOutageLabelEl = dataOutageEl.querySelector('.station-3d-data-outage-label');

    const relabelLoading = () => {
        if (photoLoadingLabelEl) photoLoadingLabelEl.textContent = t('hud.loadingWorld');
        if (worldLoadingTelemetryEl) worldLoadingTelemetryEl.title = t('hud.decodedHint');
        refreshDataOutageUI();
        if (lastWorldLoadComponents.length > 0) {
            setWorldLoadComponents(lastWorldLoadComponents);
        }
    };
    relabelLoading();
    onLangChange(relabelLoading);
    onTileStreamHealth((labels) => {
        dataOutageLabels = labels;
        setWorldDataOutage(labels);
        refreshDataOutageUI();
    });
    bindConsoleShield(consoleEl);
    leftSlotEl = consoleEl.querySelector('.station-3d-dash-left');
    controlsSlotEl = consoleEl.querySelector('.station-3d-dash-controls');
    stationEl = consoleEl.querySelector('.station-3d-dash-station');
    speedEl = readoutEl.querySelector('.station-3d-dash-speed');
    speedValueEl = readoutEl.querySelector('.station-3d-dash-speed-value');
    speedLimitEl = readoutEl.querySelector('.station-3d-dash-speed-limit');
    compassEl = readoutEl.querySelector('.station-3d-dash-compass');
    compassNeedleEl = readoutEl.querySelector('.station-3d-dash-compass-needle');
    compassPointEl = readoutEl.querySelector('.station-3d-dash-compass-point');
    compassDegreesEl = readoutEl.querySelector('.station-3d-dash-compass-degrees');
    onLangChange(() => { lastCompassText = ''; });
    ensureDashboardBell();
    ensureDashboardDoor();
}

// 🔔 tram-bell button. Same physical console-control family as the view and
// door buttons; hidden until a handler is wired via
// setDashboardBellHandler so it never appears in walk/train sessions.
function ensureDashboardBell() {
    if (bellBtnEl || !leftSlotEl) return;
    bellBtnEl = document.createElement('button');
    bellBtnEl.type = 'button';
    bellBtnEl.className = 'station-3d-console-button station-3d-dash-bell';
    bellBtnEl.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">'
        + '<path d="M6 10a6 6 0 0 1 12 0v4l2 3H4l2-3v-4Z" '
        + 'fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>'
        + '<path d="M10 20h4" fill="none" stroke="currentColor" stroke-width="1.9" '
        + 'stroke-linecap="round"/></svg>';
    bellBtnEl.setAttribute('aria-label', t('hud.bell'));
    bellBtnEl.title = t('hud.bell');
    onLangChange(() => {
        if (!bellBtnEl) return;
        bellBtnEl.setAttribute('aria-label', t('hud.bell'));
        bellBtnEl.title = t('hud.bell');
    });
    bellBtnEl.style.display = 'none';
    const tap = (e) => {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        if (bellHandler) bellHandler();
    };
    bellBtnEl.addEventListener('click', tap);
    bellBtnEl.addEventListener('contextmenu', (e) => e.preventDefault());
    leftSlotEl.appendChild(bellBtnEl);
}

// Wire the bell button to a ringer (e.g. playTramBell). Passing a function
// reveals the button; passing null hides it again.
export function setDashboardBellHandler(fn) {
    ensureDashboard();
    bellHandler = typeof fn === 'function' ? fn : null;
    if (bellBtnEl) bellBtnEl.style.display = bellHandler ? 'flex' : 'none';
}

// 🚪 door button — same physical console-control family as the bell. Doubles
// as the door
// indicator: setDashboardDoorState lights it up while the doors are open.
function ensureDashboardDoor() {
    if (doorBtnEl || !leftSlotEl) return;
    doorBtnEl = document.createElement('button');
    doorBtnEl.type = 'button';
    doorBtnEl.className = 'station-3d-console-button station-3d-dash-door';
    doorBtnEl.textContent = '🚪';
    doorBtnEl.setAttribute('aria-pressed', 'false');
    const relabel = () => {
        if (!doorBtnEl) return;
        doorBtnEl.setAttribute('aria-label', t('hud.doors'));
        doorBtnEl.title = t('hud.doors');
    };
    relabel();
    onLangChange(relabel);
    doorBtnEl.style.display = 'none';
    const tap = (e) => {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        if (doorHandler) doorHandler();
    };
    doorBtnEl.addEventListener('click', tap);
    doorBtnEl.addEventListener('contextmenu', (e) => e.preventDefault());
    leftSlotEl.appendChild(doorBtnEl);
}

// Wire the door button to a toggler. Passing a function reveals the button;
// passing null hides it again.
export function setDashboardDoorHandler(fn) {
    ensureDashboard();
    doorHandler = typeof fn === 'function' ? fn : null;
    if (doorBtnEl) doorBtnEl.style.display = doorHandler ? 'flex' : 'none';
}

// Lights the door button while the doors are open (green, like a real
// door-release lamp).
// 🅿 parking-brake button. Same console-control family as the door and bell
// buttons, and hidden the same way until a handler is wired, so it appears only
// in a rail cab that has a brake to release.
function ensureDashboardParkingBrake() {
    if (brakeBtnEl || !leftSlotEl) return;
    brakeBtnEl = document.createElement('button');
    brakeBtnEl.type = 'button';
    brakeBtnEl.className = 'station-3d-console-button station-3d-dash-brake';
    brakeBtnEl.textContent = '🅿';
    brakeBtnEl.setAttribute('aria-pressed', 'false');
    brakeBtnEl.setAttribute('aria-label', t('hud.parkingBrake'));
    brakeBtnEl.title = t('hud.parkingBrake');
    onLangChange(() => {
        if (!brakeBtnEl) return;
        brakeBtnEl.setAttribute('aria-label', t('hud.parkingBrake'));
        brakeBtnEl.title = t('hud.parkingBrake');
    });
    brakeBtnEl.style.display = 'none';
    const tap = (e) => {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        if (brakeHandler) brakeHandler();
    };
    brakeBtnEl.addEventListener('click', tap);
    brakeBtnEl.addEventListener('contextmenu', (e) => e.preventDefault());
    leftSlotEl.appendChild(brakeBtnEl);
}

export function setDashboardParkingBrakeHandler(fn) {
    ensureDashboard();
    ensureDashboardParkingBrake();
    brakeHandler = typeof fn === 'function' ? fn : null;
    if (brakeBtnEl) brakeBtnEl.style.display = brakeHandler ? 'flex' : 'none';
}

export function setDashboardParkingBrakeState(applied) {
    ensureDashboard();
    ensureDashboardParkingBrake();
    if (!brakeBtnEl || brakeAppliedState === !!applied) return;
    brakeAppliedState = !!applied;
    brakeBtnEl.classList.toggle('is-on', brakeAppliedState);
    brakeBtnEl.setAttribute('aria-pressed', String(brakeAppliedState));
}

export function setDashboardDoorState(open) {
    ensureDashboard();
    if (!doorBtnEl || doorOpenState === !!open) return;
    doorOpenState = !!open;
    doorBtnEl.classList.toggle('is-on', doorOpenState);
    doorBtnEl.setAttribute('aria-pressed', String(doorOpenState));
}

// Re-parents an existing (already event-bound) element into the console.
// Moving a DOM node keeps its listeners, so the controls behave exactly as
// they did when floating.
export function adoptIntoDashboardLeft(el) {
    ensureDashboard();
    if (leftSlotEl && el && el.parentElement !== leftSlotEl) leftSlotEl.appendChild(el);
}

export function adoptIntoDashboardControls(el) {
    ensureDashboard();
    if (controlsSlotEl && el && el.parentElement !== controlsSlotEl) controlsSlotEl.appendChild(el);
}

// The altitude pill can be forced on independently of the cab console —
// photoreal walk mode shows real sea-level altitude with the console hidden.
let altitudeForced = false;

// Shows the top readout bar whenever the console is up, or when only the
// altitude is forced on (photoreal walk mode) — in which case the speed /
// compass / PIS instruments are collapsed away and just the altitude shows.
function syncReadoutVisibility() {
    if (!readoutEl) return;
    const consoleVisible = isDashboardVisible();
    const show = consoleVisible || altitudeForced;
    readoutEl.classList.toggle('hidden', !show);
    readoutEl.classList.toggle('station-3d-cab-readout--altitude-only', show && !consoleVisible);
    // Dock into the console's top row when there is a console; float back under
    // the top icon row when there is not (photoreal walk). Reparenting rather
    // than duplicating keeps one set of gauge elements and one set of setters.
    readoutEl.classList.toggle('station-3d-cab-readout--docked', consoleVisible);
    const parent = consoleVisible ? readoutDockEl : modalEl;
    if (parent && readoutEl.parentElement !== parent) parent.appendChild(readoutEl);
}

export function setDashboardVisible(visible) {
    ensureDashboard();
    if (!consoleEl) return;
    consoleEl.classList.toggle('hidden', !visible);
    if (statuslineEl) statuslineEl.classList.toggle('hidden', !visible || !lastInfoHTML);
    if (altitudeEl) altitudeEl.classList.toggle('hidden', !(visible || altitudeForced));
    if (gradeEl) gradeEl.classList.toggle('hidden', !visible);
    if (chainageEl) chainageEl.classList.toggle('hidden', !visible);
    syncReadoutVisibility();
    // Lets bottom-anchored pills (toast, sound prompt) lift above the console.
    if (modalEl) modalEl.classList.toggle('station-3d-has-dashboard', !!visible);
}

export function setDashboardAltitudeVisible(forced) {
    altitudeForced = !!forced;
    ensureDashboard();
    if (altitudeEl) altitudeEl.classList.toggle('hidden', !(altitudeForced || isDashboardVisible()));
    syncReadoutVisibility();
}

// Show/hide the "loading surroundings" overlay (photoreal world not yet ready).
export function setPhotoLoading(visible) {
    ensureDashboard();
    if (photoLoadingEl) photoLoadingEl.classList.toggle('hidden', !visible);
    if (visible && photoLoadingTelemetryEl && !photoLoadingTelemetryEl.textContent) {
        photoLoadingTelemetryEl.textContent = '0 s · 0.0 MB';
    }
}

// The campaign pack bake's indicator (bake sessions only): phase, what still
// blocks settlement, and a clock — so a long wait reads as a wait. Text nodes
// only; `null` hides it.
export function setCampaignBakeStatus(status) {
    ensureDashboard();
    if (!status) {
        bakeStatusEl?.remove();
        bakeStatusEl = null;
        return;
    }
    if (!bakeStatusEl) {
        bakeStatusEl = document.createElement('div');
        bakeStatusEl.className = 'station-3d-photo-loading station-3d-bake-status';
        bakeStatusEl.setAttribute('aria-live', 'polite');
        // On <body>, above the chapter curtain (which covers the modal during
        // a chapter load): the indicator must be readable through every phase.
        document.body.appendChild(bakeStatusEl);
    }
    bakeStatusEl.classList.toggle('is-failed', status.failed === true);
    bakeStatusEl.classList.toggle('is-done', status.done === true);
    bakeStatusEl.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = status.title || 'BAKE';
    const phase = document.createElement('span');
    phase.textContent = status.phase || '';
    const clock = document.createElement('em');
    clock.textContent = status.elapsed || '';
    bakeStatusEl.append(title, phase, clock);
    if (status.detail) {
        const detail = document.createElement('small');
        detail.textContent = status.detail;
        bakeStatusEl.appendChild(detail);
    }
}

// Show/hide the model-world build hold. The one loading screen (ui/loading-curtain.js)
// presents it: a host has usually raised that screen already, so this adopts it,
// names a campaign chapter on it when a heading is given (a free-roam start keeps
// the host's place heading), and mounts the per-layer breakdown only when ?stats=1
// asks for it. Hiding records the finished build and leaves the screen to its owner:
// the cab drops it for a free-roam world, the campaign director for a chapter.
// The build state is published on the modal for automation, which polls
// data-world-build-state ('building' / 'ready') and data-world-build-reason.
export function setWorldLoading(visible, reason = '', { eyebrow, headline } = {}) {
    ensureDashboard();
    if (visible && !worldBuildHoldActive) {
        worldLoadActivity = createWorldLoadActivity();
        lastWorldLoadComponents = [];
    }
    worldBuildHoldActive = !!visible;
    if (modalEl) {
        if (visible) {
            modalEl.dataset.worldBuildState = 'building';
            delete modalEl.dataset.worldBuildReason;
        } else if (modalEl.dataset.worldBuildState === 'building') {
            modalEl.dataset.worldBuildState = 'ready';
            if (reason) modalEl.dataset.worldBuildReason = String(reason);
        }
    }
    if (!visible) {
        setLoadingCurtainDetails({ tasks: '', activity: '' });
        worldLoadingTelemetryEl = null;
        worldLoadingSegmentsEl = null;
        loadingCurtainDiagnostics({ show: false })?.replaceChildren();
        refreshDataOutageUI();
        return;
    }
    raiseLoadingCurtain({ label: t('hud.loadingWorld') });
    setLoadingCurtainProgress();
    setLoadingCurtainDetails({ tasks: '', activity: '' });
    if (eyebrow || headline) setLoadingCurtainHeading({ eyebrow, headline });
    const diagnosticsAllowed = typeof location !== 'undefined'
        && loadingDiagnosticsAllowed({ search: location.search });
    const diagnostics = loadingCurtainDiagnostics({ show: diagnosticsAllowed });
    worldLoadingTelemetryEl = null;
    worldLoadingSegmentsEl = null;
    if (diagnostics && diagnosticsAllowed) {
        worldLoadingTelemetryEl = document.createElement('span');
        worldLoadingTelemetryEl.className = 'station-3d-campaign-curtain-telemetry';
        worldLoadingTelemetryEl.textContent = '0 s · 0.0 MB';
        worldLoadingTelemetryEl.title = t('hud.decodedHint');
        worldLoadingSegmentsEl = document.createElement('span');
        worldLoadingSegmentsEl.className = 'station-3d-loading-segments';
        diagnostics.replaceChildren(worldLoadingTelemetryEl, worldLoadingSegmentsEl);
    }
    refreshDataOutageUI();
}

// Session elapsed time and bytes of the world build: the wire figure when the
// cab reports one, else the decoded estimate (core/dashboard-metrics.js).
// Seconds and MB are SI abbreviations in every supported UI language.
export function setWorldLoadTelemetry(telemetry) {
    if (worldBuildHoldActive) {
        const activity = worldLoadActivity(telemetry);
        if (activity) {
            const elapsed = t('loading.elapsed', { time: formatLoadElapsed(activity.elapsedMs) });
            const recent = activity.observed && activity.inactiveMs < 1_000;
            const lastActivity = recent ? t('loading.activityRecent')
                : activity.observed ? t('loading.activityAgo', { time: formatLoadElapsed(activity.inactiveMs) })
                    : t('loading.waitingUpdate');
            setLoadingCurtainDetails({ activity: `${elapsed} · ${lastActivity}` });
        }
    }
    if (!worldLoadingTelemetryEl) return;
    const wire = Number(telemetry?.transferBytes) > 0;
    worldLoadingTelemetryEl.textContent = formatLoadTelemetry(telemetry, {
        downloaded: t('hud.downloaded'),
        decoded: t('hud.decoded'),
    });
    worldLoadingTelemetryEl.title = t(wire ? 'hud.downloadedHint' : 'hud.decodedHint');
}

export function setPhotoLoadTelemetry(telemetry) {
    if (photoLoadingTelemetryEl) photoLoadingTelemetryEl.textContent = formatLoadTelemetry(telemetry);
}

// Photo loading bar: fraction 0..1 of queued tiles loaded.
export function setPhotoLoadProgress(fraction) {
    if (!photoLoadingFillEl) return;
    const pct = Math.max(0, Math.min(1, Number(fraction) || 0)) * 100;
    photoLoadingFillEl.style.width = `${pct}%`;
}

// Experienced per-component load times (ms) → segment widths on the model bar.
// Defaults are rough estimates; each build's measured durations smooth them via
// an EWMA persisted in localStorage, so the widths self-tune over sessions.
const LOAD_WEIGHT_DEFAULTS = {
    'terrain-data': 900, 'terrain-decode': 200, 'terrain-mesh': 300,
    base: 1200, layers: 1600,
    roads: 1500, curbs: 700, 'rail-cells': 2500,
    cars: 1200, buildings: 3500, 'far-buildings': 1200,
    'wreck-dressing': 800,
};
const LOAD_WEIGHT_KEY = 'voznjaLoadWeights';
let loadWeights = null;
function getLoadWeights() {
    if (loadWeights) return loadWeights;
    loadWeights = { ...LOAD_WEIGHT_DEFAULTS };
    try {
        const raw = JSON.parse(localStorage.getItem(LOAD_WEIGHT_KEY) || '{}');
        for (const k of Object.keys(raw)) {
            if (Number.isFinite(raw[k]) && raw[k] > 0) loadWeights[k] = raw[k];
        }
    } catch (_e) { /* no storage / bad json → keep defaults */ }
    return loadWeights;
}

// Blend a finished build's measured durations into the persisted EWMA (30% new)
// so segment widths track real experienced load times. Call once per build.
export function recordWorldLoadDurations(durations) {
    if (!durations || typeof durations !== 'object') return;
    const w = getLoadWeights();
    for (const k of Object.keys(durations)) {
        const d = Number(durations[k]);
        if (!Number.isFinite(d) || d <= 0) continue;
        w[k] = w[k] ? Math.round(w[k] * 0.7 + d * 0.3) : d;
    }
    try { localStorage.setItem(LOAD_WEIGHT_KEY, JSON.stringify(w)); } catch (_e) { /* ignore */ }
}

// Show measured stage progress and concurrent work. The historical weighted
// estimate stays in the watchdog event for compatibility; it is not a player
// percentage or an ETA. A development host also gets the per-layer breakdown:
// one segment per component ({ key, done }), width proportional to its experienced
// load time, with explicit desktop/mobile grid spans on the same scale across every
// row, so wrapping never inflates an orphaned final component to a full-width bar.
export function setWorldLoadComponents(components) {
    const list = Array.isArray(components) ? components : [];
    lastWorldLoadComponents = list.map(component => ({ ...component }));
    const labels = list.map((component) => {
        const key = `loading.${component.key}`;
        const translated = t(key);
        // Production queues should be translated, but never expose an internal
        // dotted identifier if a future queue is added before its copy lands.
        return translated === key
            ? String(component.key || '').replace(/[._-]+/g, ' ')
            : translated;
    });
    const weights = getLoadWeights();
    const { fraction } = worldLoadFraction(list, weights);
    const pct = Math.round(fraction * 100);
    const stages = worldLoadStages(list);
    const current = stages.active[0];
    const stageLabel = (stage) => {
        const key = `loading.${stage.key}`;
        const translated = t(key);
        return translated === key ? t('loading.otherTask') : translated;
    };
    const text = current
        ? t(current.finishing ? 'loading.finishingStage' : current.fraction !== null ? 'loading.stageProgress' : 'loading.stage', {
            component: stageLabel(current), pct: Math.floor((current.fraction || 0) * 100),
        })
        : t(stages.finishing ? 'loading.finishingWorld' : 'hud.loadingWorld');
    if (worldBuildHoldActive) {
        const outage = dataOutageLabels.length > 0;
        setLoadingCurtainProgress({ fraction: outage ? null : current?.fraction ?? null, text: outage ? t('hud.dataOutage') : text });
        const otherTasks = [...new Set(stages.active.slice(1).map(stageLabel))];
        const visibleTasks = otherTasks.slice(0, 2);
        if (otherTasks.length > 2) visibleTasks.push(t('loading.moreTasks', { n: otherTasks.length - 2 }));
        const completed = t('loading.completedTasks', { done: stages.doneCount });
        const also = visibleTasks.length ? t('loading.also', { tasks: visibleTasks.join(' · ') }) : '';
        setLoadingCurtainDetails({ tasks: [also, completed].filter(Boolean).join('\n') });
    }
    window.dispatchEvent(new CustomEvent('station3d:world-load-progress', {
        detail: { fraction, pct, text },
    }));
    if (!worldLoadingSegmentsEl) return;
    const signature = JSON.stringify(list.map((component, index) => [
        component.key,
        labels[index],
        weights[component.key] || 800,
    ]));
    if (worldLoadingSegmentsEl.dataset.layoutSignature !== signature) {
        const items = list.map(component => ({ weight: weights[component.key] || 800 }));
        const desktopPlan = loadingGridPlan(items, {
            columns: 24,
            targetRows: 4,
            minimumSpan: 6,
        });
        const mobilePlan = loadingGridPlan(items, {
            columns: 12,
            targetRows: 5,
            minimumSpan: 4,
        });
        const fragment = document.createDocumentFragment();
        for (let index = 0; index < list.length; index++) {
            const segment = document.createElement('span');
            segment.className = 'station-3d-loading-seg';
            segment.dataset.component = list[index].key;
            segment.style.setProperty('--load-span', desktopPlan[index]?.span || 6);
            segment.style.setProperty('--load-mobile-span', mobilePlan[index]?.span || 4);
            segment.classList.toggle('load-row-start', !!desktopPlan[index]?.breakBefore);
            segment.classList.toggle(
                'load-mobile-row-start',
                !!mobilePlan[index]?.breakBefore,
            );
            const bar = document.createElement('span');
            bar.className = 'station-3d-loading-seg-bar';
            const label = document.createElement('span');
            label.className = 'station-3d-loading-seg-label';
            label.textContent = labels[index];
            segment.append(bar, label);
            fragment.append(segment);
        }
        worldLoadingSegmentsEl.replaceChildren(fragment);
        worldLoadingSegmentsEl.dataset.layoutSignature = signature;
    }
    const segs = worldLoadingSegmentsEl.children;
    for (let i = 0; i < list.length; i++) {
        if (!segs[i]) continue;
        segs[i].classList.toggle('done', !!list[i].done);
        segs[i].classList.toggle('active', !list[i].done && !!list[i].active);
        // A component with measured download progress (the terrain Data
        // phase aggregates bytes across its parallel grid fetches) fills its
        // bar proportionally instead of sitting on the flat active colour.
        const bar = segs[i].querySelector('.station-3d-loading-seg-bar');
        if (!bar) continue;
        const progress = list[i].progress;
        if (!list[i].done && Number.isFinite(progress)) {
            const pct = Math.max(0, Math.min(100, Math.round(progress * 100)));
            bar.style.background = `linear-gradient(to right, #34c759 ${pct}%, #176b3a ${pct}%)`;
        } else if (bar.style.background) {
            bar.style.background = '';
        }
    }
}

// Separate trackside gauges: altitude, grade, and chainage each keep a fixed
// footprint. Altitude is signed planner metres by default (ramps read
// +3.5 / -2.0); `absolute` renders unsigned metres above sea level for
// photoreal sessions. One decimal keeps a climb readable without repainting on
// interpolation noise.
export function setDashboardMetrics(altitudeM, absolute = false, gradePct = null, chainageText = '') {
    if (!altitudeValueEl || !gradeValueEl || !chainageValueEl) return;
    const values = formatDashboardMetricValues(altitudeM, absolute, gradePct, chainageText);
    if (values.altitude !== lastAltitudeText) {
        altitudeValueEl.textContent = values.altitude;
        lastAltitudeText = values.altitude;
    }
    if (values.grade !== lastGradeText) {
        gradeValueEl.textContent = values.grade;
        lastGradeText = values.grade;
    }
    if (values.chainage !== lastChainageText) {
        chainageValueEl.textContent = values.chainage;
        lastChainageText = values.chainage;
    }
}

// Bottom-centre next-stop / at-station display. Caller supplies pre-escaped
// HTML: the running "➡ Stanica X · 315 m" and, once stopped, the station name
// plus the live dwell countdown ("🛑 Stanica X · Polazak za 12 s").
export function setDashboardStation(html) {
    if (!stationEl) return;
    const next = html || '';
    if (next === lastStationHTML) return;
    stationEl.innerHTML = next;
    stationEl.classList.toggle('station-3d-dash-station--empty', !next);
    lastStationHTML = next;
}

export function isDashboardVisible() {
    return !!(consoleEl && !consoleEl.classList.contains('hidden'));
}

// Camera-facing heading, not merely track bearing. The red half of the
// needle points to geographic north relative to the fixed forward lubber
// mark; the adjacent readout remains unambiguous at a glance.
export function setDashboardHeading(headingDeg) {
    if (!compassEl) return;
    const reading = compassReading(headingDeg);
    const text = `${reading.point} ${reading.degreeText}`;
    if (text !== lastCompassText) {
        compassPointEl.textContent = reading.point;
        compassDegreesEl.textContent = reading.degreeText;
        const label = `${t('hud.heading')}: ${reading.point} ${reading.degreeText}`;
        compassEl.setAttribute('aria-label', label);
        compassEl.title = label;
        lastCompassText = text;
    }
    const needleTenths = reading.heading == null ? null : Math.round(-reading.heading * 10);
    if (needleTenths !== lastCompassNeedleTenths) {
        compassNeedleEl.style.transform = needleTenths == null
            ? 'rotate(0deg)'
            : `rotate(${needleTenths / 10}deg)`;
        lastCompassNeedleTenths = needleTenths;
    }
}

// Digital speed instrument. limitKmh only renders while a curve restriction
// is active; overspeed pulses the value red (safety brake engaged).
export function setDashboardSpeed(speedKmh, limitKmh, limitActive, overspeed) {
    if (!speedEl) return;
    const speedText = Number.isFinite(Number(speedKmh)) ? String(Math.max(0, Math.round(speedKmh))) : '–';
    if (speedText !== lastSpeedText) {
        speedValueEl.textContent = speedText;
        lastSpeedText = speedText;
    }
    const limitText = limitActive && Number.isFinite(Number(limitKmh)) ? `/${Math.round(limitKmh)}` : '';
    if (limitText !== lastLimitText) {
        speedLimitEl.textContent = limitText;
        lastLimitText = limitText;
    }
    speedEl.classList.toggle('overspeed', !!overspeed);
}

// PIS-style route display (caller provides pre-escaped HTML). Now carries only
// line identity / direction / alerts (chainage, grade and the next stop moved
// to their own instruments), so it is often empty — collapse it when so, to
// avoid an empty amber box floating in the readout bar.
export function setDashboardInfo(html) {
    if (!statuslineEl || html === lastInfoHTML) return;
    statuslineEl.innerHTML = html;
    statuslineEl.classList.toggle('hidden', !html || !isDashboardVisible());
    lastInfoHTML = html;
}
