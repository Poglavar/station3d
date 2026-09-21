// Pure Station3D quality selection and auto-DPR hysteresis. Renderer mutation
// lives in scene/setup.js; this module is deterministic and headless-testable.

export const STATION3D_QUALITY_STORAGE_KEY = 'station3dQuality';
export const STATION3D_QUALITY_MODES = Object.freeze(['auto', 'high', 'medium', 'low']);
export const STATION3D_MIN_TEXTURE_SIZE = 2048;

export const STATION3D_QUALITY_PROFILES = Object.freeze({
    high: Object.freeze({
        id: 'high',
        dprCap: 1.5,
        minAutoDpr: 1,
        antialias: true,
        shadowMapSize: 2048,
        shadowCasterDistanceM: 100,
        thinFeatureDistanceM: 1500,
        buildings: Object.freeze({ facadeAtlasMaxEntrySize: 192, closeFacadeMaxOwners: 8 }),
    }),
    medium: Object.freeze({
        id: 'medium',
        dprCap: 1,
        minAutoDpr: 0.8,
        antialias: true,
        shadowMapSize: 1024,
        shadowCasterDistanceM: 60,
        thinFeatureDistanceM: 600,
        buildings: Object.freeze({ facadeAtlasMaxEntrySize: 128, closeFacadeMaxOwners: 3 }),
    }),
    low: Object.freeze({
        id: 'low',
        dprCap: 1,
        minAutoDpr: 0.7,
        antialias: false,
        shadowMapSize: 512,
        shadowCasterDistanceM: 40,
        thinFeatureDistanceM: 400,
        buildings: Object.freeze({ facadeAtlasMaxEntrySize: 96, closeFacadeMaxOwners: 0 }),
    }),
});

export function normalizeQualityMode(value, fallback = 'auto') {
    const mode = String(value || '').trim().toLowerCase();
    return STATION3D_QUALITY_MODES.includes(mode) ? mode : fallback;
}

// A silent, conservative preflight. Browser capability hints are incomplete
// (notably on iOS), so an absent value is "unknown", never a failure. Values
// explicitly observed from the temporary WebGL context are authoritative.
export function assessWebGlCompatibility(capabilities = {}) {
    const reasons = [];
    if (capabilities.webgl2 === false) reasons.push('webgl2-unavailable');
    const maxTextureSize = Number(capabilities.maxTextureSize) || 0;
    if (maxTextureSize > 0 && maxTextureSize < STATION3D_MIN_TEXTURE_SIZE) {
        reasons.push('texture-size');
    }
    const stencilBits = capabilities.stencilBits == null
        ? Number.NaN : Number(capabilities.stencilBits);
    if (stencilBits <= 0) reasons.push('stencil-unavailable');
    const supported = reasons.length === 0;
    const constrained = supported && (
        (Number(capabilities.deviceMemoryGb) > 0 && Number(capabilities.deviceMemoryGb) <= 4)
        || (Number(capabilities.hardwareConcurrency) > 0
            && Number(capabilities.hardwareConcurrency) <= 4)
        || (maxTextureSize > 0 && maxTextureSize < 8192)
    );
    return Object.freeze({ supported, constrained, reasons: Object.freeze(reasons) });
}

export function probeQualityProfile(capabilities = {}) {
    const compatibility = assessWebGlCompatibility(capabilities);
    if (!compatibility.supported || compatibility.constrained) return 'low';
    const maxTextureSize = Number(capabilities.maxTextureSize) || 0;
    const maxSamples = Number(capabilities.maxSamples) || 0;
    const deviceMemoryGb = Number(capabilities.deviceMemoryGb) || 0;
    const hardwareConcurrency = Number(capabilities.hardwareConcurrency) || 0;
    const mobile = capabilities.mobile === true;
    if (maxTextureSize > 0 && maxTextureSize < 8192) return 'low';
    if (deviceMemoryGb > 0 && deviceMemoryGb <= 4) return 'low';
    if (hardwareConcurrency > 0 && hardwareConcurrency <= 4) return 'low';
    if (mobile || (maxSamples > 0 && maxSamples < 4)) return 'medium';
    if (deviceMemoryGb > 0 && deviceMemoryGb <= 8) return 'medium';
    return 'high';
}

export function resolveQualityProfile(modeValue, capabilities = {}) {
    const mode = normalizeQualityMode(modeValue);
    const profileId = mode === 'auto' ? probeQualityProfile(capabilities) : mode;
    return Object.freeze({
        requestedMode: mode,
        profileId,
        auto: mode === 'auto',
        profile: STATION3D_QUALITY_PROFILES[profileId],
        capabilities: Object.freeze({ ...capabilities }),
        compatibility: assessWebGlCompatibility(capabilities),
    });
}

function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

// Consume completed frame periods, paired with the work of that same frame.
// This sampler is independent of the debug overlay and retains no frame list.
export function createRenderQualityWindow(windowMs = 1000) {
    let startedMs = 0;
    let count = 0;
    let frameMs = 0;
    let hooksMs = 0;
    let renderMs = 0;
    let skyMs = 0;
    let peakFrameMs = 0;
    let longTaskMs = 0;
    function reset(nowMs = 0) {
        startedMs = nowMs;
        count = frameMs = hooksMs = renderMs = skyMs = peakFrameMs = longTaskMs = 0;
    }
    return {
        reset,
        addFrame(frame, periodMs, taskMs = 0) {
            if (!frame || !(periodMs > 0)) return;
            count += 1;
            frameMs += periodMs;
            hooksMs += finite(frame.hooksMs);
            renderMs += finite(frame.renderMs);
            skyMs += finite(frame.skyMs);
            peakFrameMs = Math.max(peakFrameMs, periodMs);
            longTaskMs += finite(taskMs);
        },
        takeSample(nowMs) {
            if (nowMs - startedMs < windowMs || count === 0) return null;
            const sample = {
                frameAvgMs: frameMs / count,
                hooksMs: hooksMs / count,
                renderMs: renderMs / count,
                stallMs: Math.max(0, (frameMs - hooksMs - renderMs - skyMs) / count),
                peakFrameMs,
                longTaskMs,
                stuttered: peakFrameMs >= 50,
            };
            reset(nowMs);
            return sample;
        },
    };
}

export function createAutoDprGovernor({
    initialDpr,
    minDpr,
    maxDpr,
    downWindows = 6,
    upWindows = 20,
    step = 0.1,
} = {}) {
    const minimum = Math.max(0.5, finite(minDpr) || 0.7);
    const maximum = Math.max(minimum, finite(maxDpr) || 1);
    let dpr = Math.max(minimum, Math.min(maximum, finite(initialDpr) || maximum));
    let slowGpuWindows = 0;
    let fastGpuWindows = 0;
    let ignoredWindows = 0;
    let adjustments = 0;

    function observe(sample = {}) {
        const frameMs = finite(sample.frameAvgMs);
        const renderMs = finite(sample.renderMs);
        const hooksMs = finite(sample.hooksMs);
        const stallMs = finite(sample.stallMs);
        const peakFrameMs = finite(sample.peakFrameMs);
        const stable = sample.backgroundPending !== true
            && sample.compilerPending !== true
            && sample.uploadPending !== true
            && sample.stuttered !== true
            && finite(sample.longTaskMs) <= 0
            && peakFrameMs < 33
            && hooksMs < 6
            // A compiler/GC/event-loop stall is not GPU evidence. Auto quality
            // must never punish a one-off gap it cannot fix.
            && stallMs <= Math.max(6, renderMs * 0.75);
        const gpuBound = stable && renderMs >= 7 && renderMs >= hooksMs * 1.5;
        if (!gpuBound) {
            slowGpuWindows = 0;
            fastGpuWindows = 0;
            ignoredWindows += 1;
            return { changed: false, dpr, reason: 'ignored-non-gpu-window' };
        }
        if (frameMs > 18 || renderMs > 13) {
            slowGpuWindows += 1;
            fastGpuWindows = 0;
            if (slowGpuWindows >= Math.max(1, downWindows) && dpr > minimum) {
                dpr = Math.max(minimum, Math.round((dpr - step) * 100) / 100);
                slowGpuWindows = 0;
                adjustments += 1;
                return { changed: true, dpr, reason: 'stable-gpu-pressure' };
            }
            return { changed: false, dpr, reason: 'gpu-pressure-hysteresis' };
        }
        if (frameMs < 15 && renderMs < 8) {
            fastGpuWindows += 1;
            slowGpuWindows = 0;
            if (fastGpuWindows >= Math.max(1, upWindows) && dpr < maximum) {
                dpr = Math.min(maximum, Math.round((dpr + step) * 100) / 100);
                fastGpuWindows = 0;
                adjustments += 1;
                return { changed: true, dpr, reason: 'stable-gpu-headroom' };
            }
            return { changed: false, dpr, reason: 'gpu-headroom-hysteresis' };
        }
        slowGpuWindows = 0;
        fastGpuWindows = 0;
        return { changed: false, dpr, reason: 'gpu-neutral' };
    }

    return Object.freeze({
        observe,
        snapshot: () => Object.freeze({
            dpr,
            minDpr: minimum,
            maxDpr: maximum,
            slowGpuWindows,
            fastGpuWindows,
            ignoredWindows,
            adjustments,
        }),
    });
}
