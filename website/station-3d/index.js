// Station 3D view entry point. Exposes window.Station3D = { open, openCab,
// openWalk, close } so the rest of the site can trigger a 3D modal from user
// actions. Any subsystem that needs one-time initialisation (DOM, scene,
// HUD, keyboard, driver controls) is wired here.
//
// See README.md for the module graph + state flow.

import * as THREE from 'three';

import {
    initScene,
    camera,
    renderer,
    applyRenderGrade,
    renderGrade,
    bindSceneResize,
    configureRenderQuality,
    getRenderQualityContext,
    probeWebGlQualityCapabilities,
    resizeScene,
    unbindSceneResize,
} from './scene/setup.js';
import { DRIVER_TUNING } from './modes/driver.js';
import {
    normalizeQualityMode,
    STATION3D_QUALITY_STORAGE_KEY,
} from './core/quality-profile.js';

// Render grade is a load-time choice because THREE.ColorManagement converts
// hex colours at material-creation time and cannot be flipped retroactively.
// 'aces' (default) = modern pipeline: colour management ON + ACES filmic tone
// mapping + sRGB output (renderer settings applied in scene/setup.js).
// 'classic' = the legacy r128-matched look: colour management OFF + raw
// linear output, kept for A/B comparison. Select via ?grade3d=classic or a
// stored preference; Station3D.setGrade() switches renderer settings live
// (approximate for 'classic' — reload for the exact legacy look) and stores
// the preference.
function readStoredRenderGrade() {
    try {
        return localStorage.getItem('station3dGrade');
    } catch (_error) {
        // Storage can be unavailable in privacy-restricted mobile browsers.
        // Rendering does not depend on persistence, so retain the default.
        return null;
    }
}

const _gradeParam = new URLSearchParams(window.location.search).get('grade3d')
    || readStoredRenderGrade()
    || 'aces';
applyRenderGrade(_gradeParam === 'classic' ? 'classic' : 'aces');
THREE.ColorManagement.enabled = (renderGrade !== 'classic');
function readStoredQualityMode() {
    try {
        return localStorage.getItem(STATION3D_QUALITY_STORAGE_KEY);
    } catch (_error) {
        return null;
    }
}
const _qualityParam = new URLSearchParams(window.location.search).get('quality3d')
    || readStoredQualityMode()
    || 'auto';
configureRenderQuality(_qualityParam, probeWebGlQualityCapabilities());
// Expose THREE globally for devtools inspection and for the couple of legacy
// scripts / tests that still reference it by name.
window.THREE = THREE;
import { onBeforeRender, startLoop, stopLoop } from './scene/animate.js';
import { initializeSkyEnvironment } from './scene/sky.js';
import { bindCameraLook, getCameraLook } from './scene/camera-look.js';
import {
    ensureModalDom,
    containerEl,
    showModal,
    hideModal,
    setTitleText,
    setCampaignButtonAvailable,
    setCampaignButtonHandler,
    setCampaignButtonEnabled,
    setCampaignButtonVisible,
} from './ui/modal.js';
import { ensureHud } from './ui/hud.js';
import {
    ensureRoadStructureDebug,
    getCurrentRoadStructureTrace,
    updateRoadStructureDebug,
} from './ui/road-structure-debug.js';
import { state } from './state.js';
import { bindGlobalAudioUnlock } from './core/audio-unlock.js';
import { sampleCinematic } from './core/campaign-cinematics.js';
import { flightCameraFromPose, normalizeFlightTrack, normalizeFollowProfile } from './core/flight.js';
import { isCampaignFeatureEnabled } from './core/campaign-feature.js';
import { getLocation } from './core/locations.js';
import { terrainRequested } from './core/terrain-request.js';
import { resolvePerfProfilerMode } from './core/perf-run-contract.js';
import { getWeatherSnapshot, setWeatherPreset } from './core/weather.js';
import { getLiveWeatherSnapshot, refreshLiveWeather } from './core/live-weather-client.js';
import { getBackgroundActivitySnapshot } from './core/background-activity.js';
import { shouldConfirmSessionExit } from './core/session-exit-policy.js';
import { configureSessionHost, getSessionHost } from './core/session-host.js';
import {
    configureWorldProvider,
    getWorldAttributions,
    getWorldProvider,
    worldProviderContains,
} from './core/api.js';
import {
    bindEntityPointerInteraction,
    hasRegisteredEntity,
    setEntityInteractionState,
} from './core/entity-interaction.js';
import { installTelemetry } from './core/telemetry.js';
import { dropLoadingCurtain, raiseLoadingCurtain } from './ui/loading-curtain.js';

bindGlobalAudioUnlock();
// Fire-and-forget funnel telemetry. Subscribes to the station3d:* window events
// this file already dispatches, so it must be listening before the first open.
// It never awaits, never throws, and ?telemetry=0 disables it.
installTelemetry();

let initialized = false;
let poseEventsBound = false;
let campaignFrameEventsBound = false;
let campaignFrameHandler = null;
let openGeneration = 0;
let staticMode = null;
let staticModePromise = null;
let cabMode = null;
let cabModePromise = null;
let cabModeInitialized = false;
let pendingOpenMode = null;
const campaignFeatureEnabled = getSessionHost().campaigns !== false
    && isCampaignFeatureEnabled();
setCampaignButtonAvailable(campaignFeatureEnabled);

function loadStaticMode() {
    if (staticMode) return Promise.resolve(staticMode);
    if (!staticModePromise) {
        staticModePromise = import('./modes/static.js').then((module) => {
            staticMode = module;
            return module;
        });
    }
    return staticModePromise;
}

function loadCabMode({ gta = false, weapons = false } = {}) {
    if (!cabModePromise) {
        cabModePromise = import('./modes/cab.js').then((module) => {
            cabMode = module;
            return module;
        });
    }
    return cabModePromise.then(async (module) => {
        await module.preloadCabOptionalCapabilities?.({ gta, weapons });
        return module;
    });
}

function initializeCabMode(module) {
    if (cabModeInitialized) return;
    module.initCabMode();
    cabModeInitialized = true;
    if (campaignFrameHandler) module.setCabCampaignFrameHandler(campaignFrameHandler);
}

function closeStatic() {
    staticMode?.closeStatic?.();
}

function closeCab() {
    cabMode?.closeCab?.();
}

function getCabSessionSnapshot() {
    return cabMode?.getCabSessionSnapshot?.() || null;
}

function captureCabSessionRestorePoint() {
    return cabMode?.captureCabSessionRestorePoint?.() || null;
}

function restoreCabSessionRestorePoint(snapshot) {
    return cabMode?.restoreCabSessionRestorePoint?.(snapshot) || false;
}

function getVehicleExitTarget() {
    return cabMode?.getCabVehicleExitTarget?.() || null;
}

function setCabCampaignFrameHandler(handler) {
    return cabMode?.setCabCampaignFrameHandler?.(handler) || false;
}

function setCabSessionPaused(paused) {
    return cabMode?.setCabSessionPaused?.(paused) || false;
}

function clearCabSessionInput() {
    return cabMode?.clearCabSessionInput?.();
}

function reportModeLoadFailure(mode, error) {
    window.__station3DLoadError = error;
    console.error(`[Station3D] ${mode} mode failed to load:`, error);
    window.dispatchEvent(new CustomEvent('station3d:mode-load-error', {
        detail: { mode, error },
    }));
}

function notifyVisibility(active, mode) {
    window.dispatchEvent(new CustomEvent('station3d:visibility', {
        detail: { active: !!active, mode: mode || 'static' },
    }));
}

function notifyWeatherLocation(lat, lon) {
    const latitude = Number(lat);
    const longitude = Number(lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
    window.dispatchEvent(new CustomEvent('station3d:location', {
        detail: { lat: latitude, lon: longitude },
    }));
}

function ensureInitialized() {
    if (initialized) return true;
    const compatibility = getRenderQualityContext().compatibility;
    if (compatibility?.supported === false) {
        const reason = compatibility.reasons.join(', ') || 'unsupported graphics';
        const error = new Error(`Station3D requires WebGL 2 with stencil support (${reason}).`);
        error.code = 'STATION3D_GRAPHICS_UNSUPPORTED';
        reportModeLoadFailure('compatibility', error);
        return false;
    }
    if (!ensureModalDom(requestHostExit, {
        shouldConfirmClose: () => shouldConfirmSessionExit(state.cabState, pendingOpenMode),
    })) return false;
    ensureHud();
    ensureRoadStructureDebug();
    if (!initScene(containerEl)) return false;
    initializeSkyEnvironment();
    bindCameraLook(renderer.domElement);
    bindEntityPointerInteraction({
        camera,
        domElement: renderer.domElement,
        getAnchor: () => ({
            lat: state.cabState?.anchorLat,
            lon: state.cabState?.anchorLon,
        }),
    });
    setCampaignButtonVisible(campaignFeatureEnabled);
    setCampaignButtonEnabled(campaignFeatureEnabled);
    bindPoseEvents();
    bindCampaignFrameEvents();
    initialized = true;
    return true;
}

// Internal close() is also used between campaign scenes. Only an explicit
// close gesture leaves the embedding app's session and returns to its map.
function requestHostExit() {
    const onExit = getSessionHost().onExit;
    if (!onExit) return close();
    Promise.resolve(onExit({ pose: getPose(), snapshot: getCabSessionSnapshot() }))
        .catch(error => reportModeLoadFailure('exit', error));
}

function activateRendererLifecycle() {
    bindSceneResize();
    requestAnimationFrame(() => resizeScene());
}

function bindCampaignFrameEvents() {
    if (campaignFrameEventsBound) return;
    campaignFrameEventsBound = true;
    // Static/gallery cinematics advance on Station3D's existing renderer loop.
    // Cab scenes run the same handler later in cabStep, after its normal camera
    // update, so a cinematic is always the final camera owner for that frame.
    onBeforeRender(() => {
        if (state.cabState || typeof campaignFrameHandler !== 'function') return;
        campaignFrameHandler({ nowMs: performance.now(), snapshot: null, pose: null });
    });
}

function setCampaignFrameHandler(handler) {
    campaignFrameHandler = typeof handler === 'function' ? handler : null;
    setCabCampaignFrameHandler(campaignFrameHandler);
    return true;
}

function getPose() {
    const pose = state.cabState?.lastRenderedPose || state.cabState?.lastAutoPose;
    if (!pose || !Number.isFinite(Number(pose.lat)) || !Number.isFinite(Number(pose.lon))) {
        return null;
    }
    const look = getCameraLook();
    const headingDeg = ((Number(pose.headingDeg) || 0) + look.yaw * 180 / Math.PI + 360) % 360;
    return {
        lat: Number(pose.lat),
        lon: Number(pose.lon),
        headingDeg,
    };
}

function bindPoseEvents() {
    if (poseEventsBound) return;
    poseEventsBound = true;
    let lastDispatchMs = -Infinity;
    onBeforeRender(() => {
        const now = performance.now();
        if (now - lastDispatchMs < 100) return;
        const pose = getPose();
        if (!pose) return;
        lastDispatchMs = now;
        updateRoadStructureDebug(now);
        window.dispatchEvent(new CustomEvent('station3d:pose', {
            detail: { ...pose, snapshot: getCabSessionSnapshot() },
        }));
    });
}

function setInteractionState(nextState) {
    setEntityInteractionState(nextState || {});
}

function open(lat, lon, name, options) {
    if (!ensureInitialized()) return false;
    const generation = ++openGeneration;
    pendingOpenMode = 'static';
    activateRendererLifecycle();
    closeCab();
    showModal();
    setCampaignButtonVisible(campaignFeatureEnabled);
    setCampaignButtonEnabled(campaignFeatureEnabled);
    notifyVisibility(true, 'static');
    notifyWeatherLocation(lat, lon);
    // Container had zero dims while hidden — resize once it's laid out.
    requestAnimationFrame(() => {
        const ev = new Event('resize');
        window.dispatchEvent(ev);
    });
    loadStaticMode().then((module) => {
        if (generation !== openGeneration) return;
        module.openStatic(lat, lon, name, options);
        pendingOpenMode = null;
        startLoop();
    }).catch((error) => {
        if (generation !== openGeneration) return;
        pendingOpenMode = null;
        reportModeLoadFailure('static', error);
    });
    return true;
}

function queueCabOpen(method, args, { gta = false, weapons = false } = {}) {
    if (!ensureInitialized()) return false;
    const generation = ++openGeneration;
    pendingOpenMode = method === 'openWalk' ? 'walk' : method === 'openGta' ? 'gta' : 'cab';
    activateRendererLifecycle();
    closeStatic();
    // The one loading screen covers the modal from here until the world is built
    // (modes/cab.js drops it); a host has usually raised it already.
    raiseLoadingCurtain();
    showModal();
    loadCabMode({ gta, weapons }).then((module) => {
        if (generation !== openGeneration) return;
        initializeCabMode(module);
        const opened = module[method]?.(...args);
        if (opened === false) {
            throw new Error(`${method} refused the requested session.`);
        }
        pendingOpenMode = null;
        notifyVisibility(true, method === 'openGta' ? 'gta' : method === 'openWalk' ? 'walk' : 'cab');
        startLoop();
    }).catch((error) => {
        if (generation !== openGeneration) return;
        pendingOpenMode = null;
        unbindSceneResize();
        dropLoadingCurtain();
        hideModal();
        // The public open is asynchronous. Forward entry/setup failures
        // through the same readiness callback as layer failures, so a
        // caller can offer recovery without waiting for its load timeout.
        args.at(-1)?.onCampaignSessionReady?.('open-failed', error);
        reportModeLoadFailure(method, error);
    });
    return true;
}

function openCab(train, line, poseFn, options) {
    if (typeof poseFn !== 'function') return false;
    const gta = options?.sessionCapabilities?.roadVehicles === true
        || options?.sessionCapabilities?.boats === true
        || options?.sessionCapabilities?.aircraft === true;
    return queueCabOpen('openCab', [train, line, poseFn, options], {
        gta,
        weapons: gta,
    });
}

function openWalk(lat, lon, options) {
    const gta = options?.sessionCapabilities?.roadVehicles === true
        || options?.sessionCapabilities?.boats === true
        || options?.sessionCapabilities?.aircraft === true;
    const opened = queueCabOpen('openWalk', [lat, lon, options], {
        gta,
        weapons: gta,
    });
    if (opened) notifyWeatherLocation(lat, lon);
    return opened;
}

function openGta(lat, lon, options) {
    const startLat = Number(lat);
    const startLon = Number(lon);
    if (!Number.isFinite(startLat) || !Number.isFinite(startLon)
        || !worldProviderContains(startLat, startLon)) {
        console.warn('[Station3D] openGta: start is outside the configured world');
        return false;
    }
    const opened = queueCabOpen('openGta', [startLat, startLon, options], {
        gta: true,
        weapons: true,
    });
    if (opened) notifyWeatherLocation(startLat, startLon);
    return opened;
}

function close() {
    openGeneration += 1;
    pendingOpenMode = null;
    const closingMode = state.mode;
    hideModal();
    closeCab();
    closeStatic();
    setTitleText(getSessionHost().name);
    stopLoop();
    unbindSceneResize();
    notifyVisibility(false, closingMode);
    // Reset mode so the next open() starts from a known baseline.
    state.mode = 'static';
}

// Live renderer-level grade switch (see load-time note above). Persists the
// choice so the next load picks the matching ColorManagement state too.
function setGrade(name, exposure) {
    if (!applyRenderGrade(name, exposure)) return false;
    try { localStorage.setItem('station3dGrade', name); } catch (_e) { /* private mode */ }
    return true;
}

function setQuality(name) {
    const mode = normalizeQualityMode(name, null);
    if (!mode) return false;
    const context = configureRenderQuality(mode);
    if (!context) return false;
    try { localStorage.setItem(STATION3D_QUALITY_STORAGE_KEY, mode); }
    catch (_error) { /* private mode */ }
    return context;
}

function modelTerrainActive() {
    const location = getLocation();
    const params = new URLSearchParams(window.location.search || '');
    return terrainRequested(params, {
        locationHasTerrain: !!location?.terrain,
        locationOptIn: location?.terrainOptIn === true,
        sessionPolicy: state.cabState?.terrainPolicy || null,
    });
}

// Stable, cheap run dimensions for the external performance harness. Keeping
// these beside the public facade lets the harness compare what the runtime
// actually mounted, rather than guessing from a URL or scene traversal.
function getPerformanceContext() {
    const location = getLocation();
    const session = getCabSessionSnapshot();
    const params = new URLSearchParams(window.location.search || '');
    const terrain = location?.terrain || null;
    const drawingBuffer = renderer?.domElement
        ? { width: renderer.domElement.width, height: renderer.domElement.height }
        : null;
    return {
        profilerMode: resolvePerfProfilerMode(params),
        terrainActive: modelTerrainActive(),
        terrainPolicy: state.cabState?.terrainPolicy || null,
        sourceProfile: {
            locationId: location?.id || null,
            regionalLocationId: location?.regionalLocationId || null,
            styleCityId: location?.styleCityId || null,
            country: location?.country || null,
            buildings: location?.buildings || null,
            buildingEndpoint: location?.buildingEndpoint || null,
            farBuildingEndpoint: location?.farBuildingEndpoint || null,
            terrainSource: terrain?.source || (terrain?.dataUrl ? 'static' : null),
            terrainDetailSource: terrain?.detail?.source || null,
            movingTerrain: !!terrain && !terrain.metadataUrl,
        },
        dpr: Number(renderer?.getPixelRatio?.()) || 1,
        quality: getRenderQualityContext(),
        renderCompiler: state.cabState?.renderCompiler?.snapshot?.() || null,
        terrainRenderCompiler: state.cabState?.terrainRenderCompiler?.snapshot?.() || null,
        background: getBackgroundActivitySnapshot({ includeIdle: true }),
        drawingBuffer,
        activeLayers: session?.activeLayers || [],
        pendingLayers: session?.pendingLayers || [],
        worldMode: window.__worldMode?.isPhotoWorld?.() === true ? 'photo' : 'model',
        renderGrade,
        sessionPresetId: session?.sessionPresetId || null,
    };
}

function boardCampaignRailVehicle(...args) {
    return cabMode?.boardCampaignRailVehicle?.(...args) || false;
}

function setCampaignRailDisembarkEnabled(...args) {
    return cabMode?.setCampaignRailDisembarkEnabled?.(...args) || false;
}

function setCampaignNavigationTarget(...args) {
    return cabMode?.setCampaignNavigationTarget?.(...args) || false;
}

function abandonCampaignVehicle(...args) {
    // Recovery acts on an already-open vehicle session. Its success must be
    // synchronous with ownership transfer, just like an ordinary E exit.
    return cabMode?.abandonCampaignVehicle?.(...args) || false;
}

function failCampaignVehicle(...args) {
    // An authored mechanical failure (the smuggler's engine) on the open session.
    return cabMode?.failCampaignVehicle?.(...args) || false;
}

function beginCampaignParachute(...args) {
    return cabMode?.beginCampaignParachute?.(...args) || false;
}

function retireCampaignVehicle(...args) {
    // The story is done with a named vehicle (the sunk aircraft): it leaves the world.
    return cabMode?.retireCampaignVehicle?.(...args) || false;
}

function setCampaignSidearm(...args) {
    // The campaign's inventory decides whether the weapon button works on foot.
    return cabMode?.setCabCampaignSidearm?.(...args) || false;
}

async function enterFreeRoam(...args) {
    const module = await loadCabMode({ gta: true });
    initializeCabMode(module);
    return module.enterFreeRoam(...args);
}

async function transitionCampaignGtaToWalk(...args) {
    const module = await loadCabMode({ gta: true, weapons: true });
    initializeCabMode(module);
    return module.transitionCampaignGtaToWalk(...args);
}

async function transitionCampaignTrainToGta(...args) {
    const module = await loadCabMode({ gta: true, weapons: true });
    initializeCabMode(module);
    return module.transitionCampaignTrainToGta(...args);
}

async function startCampaignEncounter(...args) {
    const module = await loadCabMode({ weapons: true });
    initializeCabMode(module);
    return module.startCabCampaignEncounter(...args);
}

function stopCampaignEncounter(...args) {
    return cabMode?.stopCabCampaignEncounter?.(...args) || false;
}

function derailCampaignRailVehicle(...args) {
    return cabMode?.derailCabCampaignRailVehicle?.(...args) || false;
}

function captureCampaignWorldPack(...args) {
    if (!cabMode?.captureCurrentCampaignWorldPack) {
        return Promise.reject(new Error('Station3D cab world is not open'));
    }
    return cabMode.captureCurrentCampaignWorldPack(...args);
}

// Driving-feel knobs (speeds km/h, accelerations m/s²) — mutate from the
// console mid-ride, e.g. `Station3D.tuning.lateralAccelMax = 3`.
// isModelTerrainActive: single source of truth for whether the MODEL world
// renders the DGU elevation surface. transit.js (a classic script that cannot
// import this ESM module) gates authored-grade absolute elevations on it —
// absolute EVRF2000 track heights are only seatable when the terrain
// reference exists; on a flat world they would hang the alignment ~100 m up.
const publicApi = {
    configureHost: configureSessionHost,
    configureWorld: configureWorldProvider,
    getWorldProvider,
    getWorldAttributions,
    open, openCab, openWalk, openGta, close, setGrade, setQuality,
    setWeather: setWeatherPreset,
    getWeather: getWeatherSnapshot,
    refreshWeather: () => refreshLiveWeather({ force: true }),
    getLiveWeather: getLiveWeatherSnapshot,
    boardCampaignRailVehicle,
    setCampaignRailDisembarkEnabled,
    setCampaignNavigationTarget,
    abandonCampaignVehicle,
    failCampaignVehicle,
    retireCampaignVehicle,
    setCampaignSidearm,
    beginCampaignParachute,
    transitionCampaignGtaToWalk,
    enterFreeRoam,
    transitionCampaignTrainToGta,
    setInteractionState,
    getPose,
    getSessionSnapshot: getCabSessionSnapshot,
    captureSessionRestorePoint: captureCabSessionRestorePoint,
    restoreSessionRestorePoint: restoreCabSessionRestorePoint,
    getVehicleExitTarget,
    getPerformanceContext,
    startCampaignEncounter,
    stopCampaignEncounter,
    derailCampaignRailVehicle,
    captureCampaignWorldPack,
    getRoadStructureTrace: getCurrentRoadStructureTrace,
    hasEntity: hasRegisteredEntity,
    isModelTerrainActive: modelTerrainActive,
    tuning: DRIVER_TUNING,
};

// Freeform flight: fly the camera independently of the train, through the same
// frame-handler slot campaign cinematics use (cab applies the returned
// {position, lookAt} as the frame's final camera). Requires an active cab
// session — that session is what streams the world — and must not be used
// while a campaign cinematic runs, since both claim the same slot. Driven by
// tools/record-loop.mjs; also usable from the console.
let flightState = null;
function stopFlight() {
    if (!flightState) return false;
    flightState = null;
    setCampaignFrameHandler(null);
    return true;
}
publicApi.flight = {
    // Authored keyframe track (campaign cinematic schema: durationMs +
    // keyframes[{atMs, easing, camera:{position, lookAt, fovDeg}}]). Geographic
    // poses, heightM above the initial filming ground. Returns the duration;
    // stops itself at the end. NOTE: streaming follows the TRAIN, not this
    // camera — keep the path inside the streamed bubble to show built scenery.
    play(track) {
        const normalized = normalizeFlightTrack(track);
        const startedAt = performance.now();
        flightState = { kind: 'track', durationMs: normalized.durationMs };
        setCampaignFrameHandler(({ nowMs }) => {
            const elapsed = (Number.isFinite(nowMs) ? nowMs : performance.now()) - startedAt;
            const sampled = sampleCinematic(normalized, elapsed, { reducedMotion: false });
            if (sampled.done) { stopFlight(); return null; }
            return sampled.camera;
        });
        return normalized.durationMs;
    },
    // Drone profile derived from the live train pose each frame — pacing the
    // train keeps the camera inside the streamed world by construction.
    follow(profile) {
        const normalized = normalizeFollowProfile(profile);
        flightState = { kind: 'follow', profile: normalized };
        setCampaignFrameHandler(({ pose }) => flightCameraFromPose(pose, normalized));
        return true;
    },
    stop: stopFlight,
    active: () => (flightState ? flightState.kind : null),
};

window.Station3D = publicApi;

let campaignClockWasPaused = false;
let campaignRuntimePromise = null;
function loadCampaignRuntime() {
    if (!campaignFeatureEnabled) return Promise.resolve(null);
    if (!ensureInitialized()) return Promise.reject(new Error('Station3D UI could not initialize.'));
    if (!campaignRuntimePromise) {
        campaignRuntimePromise = import('./campaigns/bootstrap.js').then(({ installCampaignRuntime }) => (
            installCampaignRuntime({
                station3D: publicApi,
                enabled: campaignFeatureEnabled,
                pause() {
                    if (setCabSessionPaused(true)) return;
                    const clock = window.simClock;
                    campaignClockWasPaused = !!clock?.isPaused?.();
                    clock?.setPaused?.(true);
                },
                resume() {
                    if (setCabSessionPaused(false)) return;
                    if (!campaignClockWasPaused) window.simClock?.setPaused?.(false);
                    campaignClockWasPaused = false;
                },
                clearInput: clearCabSessionInput,
                setFrameHandler: setCampaignFrameHandler,
            })
        )).catch((error) => {
            campaignRuntimePromise = null;
            reportModeLoadFailure('campaign', error);
            throw error;
        });
    }
    return campaignRuntimePromise;
}

const campaignMethods = [
    'openMenu', 'start', 'startCheckpoint', 'continue', 'restart', 'retry',
    'exit', 'snapshot', 'replayCinematic', 'list', 'active',
];
publicApi.campaigns = Object.fromEntries(campaignMethods.map(method => [method, (...args) => (
    loadCampaignRuntime().then((runtime) => {
        const action = runtime?.[method];
        if (typeof action !== 'function') throw new Error('Station3D campaign runtime is unavailable.');
        return action(...args);
    })
)]));
setCampaignButtonHandler(campaignFeatureEnabled
    ? () => loadCampaignRuntime().then(runtime => runtime?.openMenu())
    : null);
