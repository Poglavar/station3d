// Rare ambient fish jumps near the viewer: when the next one is due, where on
// the mapped sea it breaks the surface, how big the fish is, the arc it flies
// and how loud its splash is where the listener stands. Pure — the world layer
// (world/fish-jumps.js) owns the meshes, the droplets and the sound.

const GRAVITY_MPS2 = 9.81;
const SPEED_OF_SOUND_MPS = 343;

export const FISH_JUMP_DEFAULTS = Object.freeze({
    // Waiting time: a floor plus an exponential tail, so jumps stay rare and irregular.
    meanIntervalS: 24,
    minIntervalS: 8,
    // Only near the viewer, and mostly inside the view so a jump is usually seen.
    minDistanceM: 9,
    maxDistanceM: 60,
    viewConeRad: 0.9,
    inViewShare: 0.8,
    // A fish from 45 m up is a pixel; above that height nothing jumps.
    maxViewerHeightM: 45,
    siteAttempts: 8,
    headingAttempts: 4,
    minLengthM: 0.16,
    maxLengthM: 0.65,
    // The splash is heard out to here, fading over the last 30 %.
    audibleDistanceM: 48,
    splashReferenceM: 10,
    maxConcurrent: 2,
});

function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
}

function smoothstep(edge0, edge1, value) {
    const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
}

const finite = value => typeof value === 'number' && Number.isFinite(value);

export function nextFishJumpDelayS(random, config = FISH_JUMP_DEFAULTS) {
    const tail = Math.max(0, config.meanIntervalS - config.minIntervalS);
    return config.minIntervalS - Math.log(1 - random() * 0.999) * tail;
}

// Nothing jumps for a viewer high above the water or before the sea is known.
export function fishJumpsAllowed({ viewerY, seaY, config = FISH_JUMP_DEFAULTS }) {
    return finite(viewerY) && finite(seaY) && viewerY - seaY <= config.maxViewerHeightM;
}

// A mapped-sea point in a ring around the viewer, uniform over the ring's area,
// inside the view cone for `inViewShare` of the tries. `forward` is the view
// direction in the XZ plane; null when no try lands on the sea.
export function pickFishJumpSite({ random, viewer, forward = null, isSea, config = FISH_JUMP_DEFAULTS }) {
    if (!finite(viewer?.x) || !finite(viewer?.z) || typeof isSea !== 'function') return null;
    const heading = finite(forward?.x) && finite(forward?.z) && Math.hypot(forward.x, forward.z) > 1e-6
        ? Math.atan2(forward.x, forward.z)
        : null;
    const innerSq = config.minDistanceM ** 2;
    const outerSq = config.maxDistanceM ** 2;
    for (let attempt = 0; attempt < config.siteAttempts; attempt++) {
        const inView = heading !== null && random() < config.inViewShare;
        const angle = inView
            ? heading + (random() * 2 - 1) * config.viewConeRad
            : random() * Math.PI * 2;
        const distanceM = Math.sqrt(innerSq + random() * (outerSq - innerSq));
        const x = viewer.x + Math.sin(angle) * distanceM;
        const z = viewer.z + Math.cos(angle) * distanceM;
        if (isSea(x, z)) return { x, z, distanceM, inView };
    }
    return null;
}

// Small fish are common and big ones rare; a bigger fish leaps higher and
// farther. Both surface points must be sea, or the jump is not planned.
export function planFishJump({
    random,
    site,
    seaY,
    isSea = () => true,
    config = FISH_JUMP_DEFAULTS,
    headingAttempts = config.headingAttempts ?? FISH_JUMP_DEFAULTS.headingAttempts,
    // Automation asks for a fish of a given size; play draws one.
    forcedLengthM = null,
}) {
    if (!finite(site?.x) || !finite(site?.z) || !finite(seaY)) return null;
    const sizeDraw = random();
    const lengthM = finite(forcedLengthM)
        ? clamp(forcedLengthM, config.minLengthM, config.maxLengthM)
        : config.minLengthM + (config.maxLengthM - config.minLengthM) * sizeDraw * sizeDraw;
    const heightM = (0.22 + lengthM * 1.3) * (0.8 + random() * 0.4);
    const spanM = (0.5 + lengthM * 2.4) * (0.85 + random() * 0.3);
    const durationS = 2 * Math.sqrt((2 * heightM) / GRAVITY_MPS2);
    for (let attempt = 0; attempt < Math.max(1, headingAttempts); attempt++) {
        const headingRad = random() * Math.PI * 2;
        const halfX = Math.sin(headingRad) * spanM / 2;
        const halfZ = Math.cos(headingRad) * spanM / 2;
        if (!isSea(site.x - halfX, site.z - halfZ) || !isSea(site.x + halfX, site.z + halfZ)) continue;
        return Object.freeze({ x: site.x, z: site.z, seaY, headingRad, lengthM, heightM, spanM, durationS });
    }
    return null;
}

// The fish `t` seconds into its jump: a ballistic arc from one surface point
// to the other with the nose along the flight path and a flicking tail. Null
// before and after the jump.
export function sampleFishJump(plan, t) {
    if (!plan || !finite(t) || t < 0 || t > plan.durationS) return null;
    const progress = t / plan.durationS;
    const along = (progress - 0.5) * plan.spanM;
    const verticalSpeed = (4 * plan.heightM * (1 - 2 * progress)) / plan.durationS;
    const horizontalSpeed = plan.spanM / plan.durationS;
    return {
        x: plan.x + Math.sin(plan.headingRad) * along,
        y: plan.seaY + 4 * plan.heightM * progress * (1 - progress),
        z: plan.z + Math.cos(plan.headingRad) * along,
        yawRad: plan.headingRad,
        pitchRad: Math.atan2(verticalSpeed, horizontalSpeed),
        tailRad: Math.sin(t * 38) * 0.35 * (1 - progress * 0.6),
        progress,
    };
}

// The splash where the listener stands, or null when it is too far to hear.
// `where` is 'out' (breaking the surface, softer) or 'in' (the splash back).
export function fishSplashCue({ plan, listener, where = 'in', config = FISH_JUMP_DEFAULTS }) {
    if (!plan || !finite(listener?.x) || !finite(listener?.y) || !finite(listener?.z)) return null;
    const alongSign = where === 'out' ? -0.5 : 0.5;
    const pointX = plan.x + Math.sin(plan.headingRad) * plan.spanM * alongSign;
    const pointZ = plan.z + Math.cos(plan.headingRad) * plan.spanM * alongSign;
    const dx = pointX - listener.x;
    const dy = plan.seaY - listener.y;
    const dz = pointZ - listener.z;
    const distanceM = Math.hypot(dx, dy, dz);
    if (!(distanceM <= config.audibleDistanceM)) return null;
    const size = (plan.lengthM - config.minLengthM) / Math.max(1e-6, config.maxLengthM - config.minLengthM);
    const falloff = config.splashReferenceM / (config.splashReferenceM + distanceM);
    const edge = 1 - smoothstep(config.audibleDistanceM * 0.7, config.audibleDistanceM, distanceM);
    const gain = clamp((where === 'out' ? 0.22 : 0.55) * (0.45 + 0.9 * size) * falloff * edge, 0, 1);
    let pan = 0;
    if (finite(listener.right?.x) && finite(listener.right?.z) && distanceM > 1e-6) {
        pan = clamp(((dx * listener.right.x + dz * listener.right.z) / distanceM) * 0.8, -1, 1);
    }
    return {
        gain,
        playbackRate: clamp((where === 'out' ? 1.45 : 1.3) - plan.lengthM * 0.8, 0.8, 1.6),
        pan,
        delayS: distanceM / SPEED_OF_SOUND_MPS,
        distanceM,
    };
}
