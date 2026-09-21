// Stable, dependency-free Station3D browser facade. The planner can bind its
// controls immediately, while Three.js and the runtime graph are fetched only
// when a 3D action (or an explicit preload) actually needs them.

import { configureSessionHost } from './core/session-host.js';
import {
    configureWorldProvider,
    getWorldAttributions,
    getWorldProvider,
    worldProviderContains,
} from './core/api.js';

const configuredAssetConfig = window.__station3DAssetConfig || {};
const productionBundle = configuredAssetConfig.productionBundle === true
    || window.__station3DProductionBundle === true
    || new URL(import.meta.url).pathname.includes('/dist/');
const entryBaseUrl = new URL('.', import.meta.url);
window.__station3DAssetConfig = Object.freeze({
    // A product may keep authored/licensed media downstream while loading the
    // engine code, chunks and workers from the npm distribution.
    rootUrl: configuredAssetConfig.rootUrl
        ? new URL(configuredAssetConfig.rootUrl, document.baseURI).href
        : new URL('./', entryBaseUrl).href,
    productionBundle,
    baseUrl: entryBaseUrl.href,
    renderCompilerWorkerUrl: configuredAssetConfig.renderCompilerWorkerUrl || new URL(
        productionBundle
            ? 'render-compiler-worker.js'
            : 'workers/render-compiler-worker.js',
        entryBaseUrl,
    ).href,
    bakedWorldShadowWorkerUrl: configuredAssetConfig.bakedWorldShadowWorkerUrl || new URL(
        productionBundle ? 'baked-world-shadow-worker.js' : 'core/baked-world-shadow-worker.js', entryBaseUrl,
    ).href,
    dracoDecoderUrl: configuredAssetConfig.dracoDecoderUrl || (productionBundle
        ? new URL('draco/', entryBaseUrl).href
        : new URL('/__station3d_vendor__/three/examples/jsm/libs/draco/gltf/', location.href).href),
});

let runtime = null;
let runtimePromise = null;
let openGeneration = 0;
const earlyTuning = {};

function loadRuntime() {
    if (runtime) return Promise.resolve(runtime);
    if (!runtimePromise) {
        const startedAtMs = performance.now();
        window.__station3DRuntimeTiming = {
            startedAtMs,
            readyAtMs: null,
            durationMs: null,
            productionBundle,
        };
        runtimePromise = import('./index.js').then(() => {
            const loaded = window.Station3D;
            if (!loaded || loaded === facade || typeof loaded.openCab !== 'function') {
                throw new Error('Station3D runtime loaded without installing its public API.');
            }
            runtime = loaded;
            Object.assign(runtime.tuning || {}, earlyTuning);
            const readyAtMs = performance.now();
            Object.assign(window.__station3DRuntimeTiming, {
                readyAtMs,
                durationMs: readyAtMs - startedAtMs,
            });
            window.dispatchEvent(new CustomEvent('station3d:runtime-ready', {
                detail: { ...window.__station3DRuntimeTiming },
            }));
            return runtime;
        }).catch((error) => {
            runtimePromise = null;
            if (window.__station3DRuntimeTiming) {
                window.__station3DRuntimeTiming.failed = true;
            }
            window.__station3DLoadError = error;
            window.dispatchEvent(new CustomEvent('station3d:load-error', { detail: { error } }));
            throw error;
        });
    }
    return runtimePromise;
}

function reportQueuedFailure(method, error) {
    console.error(`[Station3D] ${method} failed while loading:`, error);
}

function queueOpen(method, args) {
    const generation = ++openGeneration;
    loadRuntime().then((api) => {
        if (generation !== openGeneration) return;
        const opened = api[method]?.(...args);
        if (opened === false) {
            window.dispatchEvent(new CustomEvent('station3d:open-refused', {
                detail: { method },
            }));
        }
    }).catch(error => reportQueuedFailure(method, error));
    return true;
}

function delegate(method, fallback, ...args) {
    if (runtime && typeof runtime[method] === 'function') return runtime[method](...args);
    return fallback;
}

function queueDelegate(method, args, fallback = false) {
    if (runtime && typeof runtime[method] === 'function') return runtime[method](...args);
    loadRuntime().then(api => api[method]?.(...args)).catch(error => reportQueuedFailure(method, error));
    return fallback;
}

function storedQualityMode() {
    try { return localStorage.getItem('station3dQuality') || 'auto'; }
    catch (_error) { return 'auto'; }
}

const campaignMethods = [
    'openMenu', 'start', 'startCheckpoint', 'continue', 'restart', 'retry',
    'exit', 'snapshot', 'replayCinematic', 'list', 'active',
];
const campaigns = Object.fromEntries(campaignMethods.map(method => [method, (...args) => (
    loadRuntime().then((api) => {
        const action = api.campaigns?.[method];
        if (typeof action !== 'function') throw new Error('Station3D campaign runtime is unavailable.');
        return action(...args);
    })
)]));

const tuning = new Proxy(earlyTuning, {
    get(target, property) {
        return runtime?.tuning?.[property] ?? target[property];
    },
    set(target, property, value) {
        target[property] = value;
        if (runtime?.tuning) runtime.tuning[property] = value;
        return true;
    },
    ownKeys(target) {
        return Reflect.ownKeys(runtime?.tuning || target);
    },
    getOwnPropertyDescriptor() {
        return { configurable: true, enumerable: true };
    },
});

const facade = {
    configureHost: configureSessionHost,
    configureWorld: configureWorldProvider,
    getWorldProvider,
    getWorldAttributions,
    preload: loadRuntime,
    ready: loadRuntime,
    open: (...args) => queueOpen('open', args),
    openCab: (...args) => queueOpen('openCab', args),
    openWalk: (...args) => queueOpen('openWalk', args),
    openGta: (lat, lon, ...args) => {
        const startLat = Number(lat);
        const startLon = Number(lon);
        if (!Number.isFinite(startLat) || !Number.isFinite(startLon)
            || !worldProviderContains(startLat, startLon)) return false;
        return queueOpen('openGta', [startLat, startLon, ...args]);
    },
    close: () => {
        openGeneration += 1;
        return delegate('close', undefined);
    },
    setGrade: (...args) => queueDelegate('setGrade', args, true),
    setQuality: (name) => {
        const mode = String(name || '').trim().toLowerCase();
        if (!['auto', 'high', 'medium', 'low'].includes(mode)) return false;
        try { localStorage.setItem('station3dQuality', mode); } catch (_error) { /* optional */ }
        return queueDelegate('setQuality', [mode], { requestedMode: mode, runtimeReady: false });
    },
    setWeather: (...args) => queueDelegate('setWeather', args, true),
    getWeather: () => delegate('getWeather', null),
    refreshWeather: () => queueDelegate('refreshWeather', [], null),
    getLiveWeather: () => delegate('getLiveWeather', null),
    boardCampaignRailVehicle: (...args) => queueDelegate('boardCampaignRailVehicle', args),
    derailCampaignRailVehicle: (...args) => queueDelegate('derailCampaignRailVehicle', args),
    setCampaignNavigationTarget: (...args) => queueDelegate('setCampaignNavigationTarget', args),
    enterFreeRoam: (...args) => queueDelegate('enterFreeRoam', args),
    transitionCampaignGtaToWalk: (...args) => queueDelegate('transitionCampaignGtaToWalk', args),
    transitionCampaignTrainToGta: (...args) => queueDelegate('transitionCampaignTrainToGta', args),
    setInteractionState: (...args) => queueDelegate('setInteractionState', args, true),
    getPose: () => delegate('getPose', null),
    getSessionSnapshot: () => delegate('getSessionSnapshot', null),
    getPerformanceContext: () => delegate('getPerformanceContext', {
        runtimeReady: false,
        quality: { requestedMode: storedQualityMode() },
    }),
    startCampaignEncounter: (...args) => queueDelegate('startCampaignEncounter', args),
    stopCampaignEncounter: (...args) => queueDelegate('stopCampaignEncounter', args),
    getRoadStructureTrace: () => delegate('getRoadStructureTrace', null),
    hasEntity: (...args) => delegate('hasEntity', false, ...args),
    isModelTerrainActive: () => delegate('isModelTerrainActive', false),
    campaigns,
    tuning,
};

window.Station3D = facade;
export { facade as station3D, loadRuntime as preloadStation3D };
