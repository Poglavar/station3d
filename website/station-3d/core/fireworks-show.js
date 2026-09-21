// Pure scheduler and ballistics for a fireworks show: when each rocket leaves
// which pad, where it bursts, what its stars do, and how a burst should sound
// from where the camera stands. No three.js, no DOM — the world layer only
// turns these records into particles and the sfx module into scheduled clips.

const GRAVITY_MPS2 = 9.81;
const SPEED_OF_SOUND_MPS = 343;
const STALL_CATCH_UP_S = 3;
// Shells leave the mortar fast and shed speed to drag, so a 200 m burst takes
// four to five seconds rather than the six a drag-free lob would need.
export const ROCKET_DRAG_PER_S = 0.4;

export const FIREWORKS_EFFECT_ID = 'toranj-fireworks';
export const FIREWORKS_STAGE_FINALE = 'finale';
export const FIREWORKS_STAGE_FINISHED = 'finished';

export const FIREWORK_KINDS = Object.freeze(['peony', 'chrysanthemum', 'willow', 'ring', 'crackle']);

// Deterministic 32-bit generator so a show can be replayed in a test and a
// given seed always produces the same launch list.
export function createSeededRandom(seed = 1) {
    let state = (Number(seed) >>> 0) || 1;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let value = Math.imul(state ^ (state >>> 15), 1 | state);
        value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function between(rng, min, max) {
    return min + (max - min) * rng();
}

function pick(rng, items) {
    return items[Math.min(items.length - 1, Math.floor(rng() * items.length))];
}

// The world-effect stage is the only signal the layer acts on. A transient
// cinematic keyframe and the persisted run state both arrive on the same event;
// an absent key never stops a running show, because the keyframe after the one
// that started it, and the save broadcast on cinematic close, both omit it.
export function reduceFireworksCommand(running, detail, effectId = FIREWORKS_EFFECT_ID) {
    const stage = detail?.worldEffects?.[effectId];
    if (stage === FIREWORKS_STAGE_FINALE) return running ? null : 'start';
    if (stage === FIREWORKS_STAGE_FINISHED) return running ? 'finish' : null;
    return null;
}

function apexTimeS(verticalMps, k) {
    const terminal = GRAVITY_MPS2 / k;
    return Math.log((verticalMps + terminal) / terminal) / k;
}

// Launch speed that bursts the rocket `heightM` above its pad under drag. The
// fuse is cut a little before the apex so stars still carry upward motion;
// the speed is found by bisection because the drag form has no closed inverse.
export function rocketLaunchFor(heightM, { fuseApexRatio = 0.92, dragPerS = ROCKET_DRAG_PER_S } = {}) {
    const target = Math.max(1, Number(heightM) || 1);
    const k = Math.max(0.01, Number(dragPerS) || ROCKET_DRAG_PER_S);
    const heightAtFuse = (v) => {
        const fuseS = apexTimeS(v, k) * fuseApexRatio;
        return starPositionAt({ x: 0, y: 0, z: 0 }, { x: 0, y: v, z: 0 }, k, fuseS).y;
    };
    let low = 1;
    let high = 400;
    for (let step = 0; step < 48; step += 1) {
        const mid = (low + high) / 2;
        if (heightAtFuse(mid) < target) low = mid;
        else high = mid;
    }
    const verticalMps = (low + high) / 2;
    return { verticalMps, fuseS: apexTimeS(verticalMps, k) * fuseApexRatio, dragPerS: k };
}

// Rocket flight under the same linear drag the shader integrates, matching
// the world layer's trail sampling and the rocket head particle.
export function rocketPositionAt(launch, tS) {
    const t = Math.max(0, Math.min(Number(launch.fuseS) || 0, Number(tS) || 0));
    return starPositionAt(launch.origin, launch.velocity, launch.dragPerS ?? ROCKET_DRAG_PER_S, t);
}

export function rocketBurstPoint(launch) {
    return rocketPositionAt(launch, launch.fuseS);
}

// Star velocities for one burst, in metres per second around the burst point.
// Shell kinds differ in shape (sphere vs ring), speed and how long stars burn.
export function burstStarVelocities(kind, count, rng) {
    const total = Math.max(1, Math.floor(Number(count) || 1));
    const velocities = new Array(total);
    if (kind === 'ring') {
        // A ring lies in one random plane; pick two orthonormal axes in it.
        const normal = randomUnitVector(rng);
        const helper = Math.abs(normal.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
        const axisA = normalize(cross(normal, helper));
        const axisB = cross(normal, axisA);
        const speed = between(rng, 44, 52);
        for (let index = 0; index < total; index += 1) {
            const angle = (index / total) * Math.PI * 2 + between(rng, -0.04, 0.04);
            const s = speed * between(rng, 0.94, 1.06);
            velocities[index] = {
                x: (axisA.x * Math.cos(angle) + axisB.x * Math.sin(angle)) * s,
                y: (axisA.y * Math.cos(angle) + axisB.y * Math.sin(angle)) * s,
                z: (axisA.z * Math.cos(angle) + axisB.z * Math.sin(angle)) * s,
            };
        }
        return velocities;
    }
    const speedRange = kind === 'willow' ? [30, 40] : kind === 'crackle' ? [34, 48] : [46, 64];
    for (let index = 0; index < total; index += 1) {
        const direction = randomUnitVector(rng);
        const s = between(rng, speedRange[0], speedRange[1]);
        velocities[index] = { x: direction.x * s, y: direction.y * s, z: direction.z * s };
    }
    return velocities;
}

// How a kind's stars decay: linear drag coefficient (1/s) and burn time. The
// shader integrates the same closed form, so tests can predict star reach.
export function starProfile(kind) {
    switch (kind) {
    case 'willow': return { dragPerS: 0.55, lifeS: [3.8, 4.8], sizeM: 4.4, flicker: 0.25 };
    case 'crackle': return { dragPerS: 1.3, lifeS: [2.2, 3.0], sizeM: 3.6, flicker: 0.9 };
    case 'ring': return { dragPerS: 1.1, lifeS: [2.4, 3.0], sizeM: 4.2, flicker: 0.2 };
    case 'chrysanthemum': return { dragPerS: 0.95, lifeS: [2.6, 3.4], sizeM: 4.8, flicker: 0.35 };
    default: return { dragPerS: 1.05, lifeS: [2.4, 3.2], sizeM: 4.6, flicker: 0.2 };
    }
}

// Position of a star after `tS` under linear drag `k` and gravity: the shader
// evaluates this per vertex; kept here so it can be asserted headlessly.
export function starPositionAt(origin, velocity, dragPerS, tS, gravityMps2 = GRAVITY_MPS2) {
    const k = Math.max(0.0001, Number(dragPerS) || 0.0001);
    const t = Math.max(0, Number(tS) || 0);
    const e = (1 - Math.exp(-k * t)) / k;
    const fall = (t - e) / k * gravityMps2;
    return {
        x: origin.x + velocity.x * e,
        y: origin.y + velocity.y * e - fall,
        z: origin.z + velocity.z * e,
    };
}

// Speed of sound turns distance into the familiar flash-then-boom lag; gain
// falls off with distance and the burst pans towards the side it is on.
export function fireworkSoundCue({ point, listener, baseGain = 0.5, referenceM = 120 } = {}) {
    if (!point || !listener?.position) return { delayS: 0, gain: baseGain, pan: 0 };
    const dx = point.x - listener.position.x;
    const dy = point.y - listener.position.y;
    const dz = point.z - listener.position.z;
    const distanceM = Math.hypot(dx, dy, dz);
    const gain = baseGain * referenceM / (referenceM + distanceM);
    let pan = 0;
    if (listener.right && distanceM > 1e-6) {
        pan = (dx * listener.right.x + dy * listener.right.y + dz * listener.right.z) / distanceM;
        pan = Math.max(-1, Math.min(1, pan * 0.8));
    }
    return { delayS: distanceM / SPEED_OF_SOUND_MPS, gain, pan, distanceM };
}

function randomUnitVector(rng) {
    const z = between(rng, -1, 1);
    const angle = between(rng, 0, Math.PI * 2);
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    return { x: r * Math.cos(angle), y: z, z: r * Math.sin(angle) };
}

function cross(a, b) {
    return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function normalize(v) {
    const length = Math.hypot(v.x, v.y, v.z) || 1;
    return { x: v.x / length, y: v.y / length, z: v.z / length };
}

// ---------------------------------------------------------------------------
// Show timeline

export function createFireworksShow(spec, { seed = 1, startedAtS = 0 } = {}) {
    if (!spec) throw new Error('Fireworks show requires a spec.');
    return {
        spec,
        rng: createSeededRandom(seed),
        startedAtS: Number(startedAtS) || 0,
        nextLaunchAtS: (Number(startedAtS) || 0) + (Number(spec.leadInS) || 0),
        nextFountainAtS: (Number(startedAtS) || 0) + (Number(spec.leadInS) || 0) + 1.5,
        finaleStartS: null,
        finaleQueue: [],
        launchCount: 0,
        done: false,
    };
}

function launchInterval(show, showTimeS) {
    const { spec, rng } = show;
    const openingS = Number(spec.openingS) || 0;
    if (showTimeS < (Number(spec.leadInS) || 0) + openingS) return between(rng, 0.55, 1.1);
    return between(rng, spec.intervalS?.[0] ?? 1.4, spec.intervalS?.[1] ?? 2.6);
}

function makeLaunch(show, launchedAtS, { kindOverride = null, heightOverride = null, padOverride = null } = {}) {
    const { spec, rng } = show;
    const pad = padOverride || pick(rng, spec.pads);
    const kind = kindOverride || pick(rng, spec.kinds || FIREWORK_KINDS);
    const heightM = heightOverride ?? between(rng, spec.burstHeightM[0], spec.burstHeightM[1]);
    const { verticalMps, fuseS, dragPerS } = rocketLaunchFor(heightM);
    // Drift away from the shaft so a rocket never rises through the tower.
    const outward = Math.hypot(pad.x, pad.z) || 1;
    const lateral = between(rng, 2, 7);
    const swirl = between(rng, -3, 3);
    const colour = pick(rng, spec.palette);
    const secondary = rng() < 0.35 ? pick(rng, spec.palette) : colour;
    show.launchCount += 1;
    return {
        id: `firework-${show.launchCount}`,
        kind,
        padId: pad.id,
        origin: { x: pad.x, y: pad.y || 0, z: pad.z },
        velocity: {
            x: (pad.x / outward) * lateral + (-pad.z / outward) * swirl,
            y: verticalMps,
            z: (pad.z / outward) * lateral + (pad.x / outward) * swirl,
        },
        launchedAtS,
        fuseS,
        dragPerS,
        burstHeightM: heightM,
        starCount: Math.round(between(rng, spec.starCount[0], spec.starCount[1])),
        colour,
        secondaryColour: secondary,
    };
}

function queueFinale(show, atS) {
    const { spec, rng } = show;
    show.finaleStartS = atS;
    const rockets = Math.max(1, Number(spec.finaleRockets) || 10);
    const spanS = Math.max(1, Number(spec.finaleS) || 12);
    const queue = [];
    for (let index = 0; index < rockets; index += 1) {
        const atOffset = (index / rockets) * spanS * 0.8 + between(rng, 0, 0.35);
        queue.push({ atS: atS + atOffset, pad: spec.pads[index % spec.pads.length] });
    }
    // The last salvo bursts as one: a tight volley from every pad.
    for (const pad of spec.pads) {
        queue.push({ atS: atS + spanS * 0.82 + between(rng, 0, 0.25), pad, tall: true });
    }
    queue.sort((a, b) => a.atS - b.atS);
    show.finaleQueue = queue;
}

// Advances the show to `showTimeS` (seconds since the layer started counting)
// and returns everything that became due: rocket launches and crown fountains.
// Calling it with a time that has not moved returns nothing new.
export function advanceFireworksShow(show, showTimeS) {
    const now = Number(showTimeS) || 0;
    const launches = [];
    const fountains = [];
    if (show.done) return { launches, fountains, done: true };
    const { spec, rng } = show;
    const naturalFinaleAtS = show.startedAtS + (Number(spec.durationS) || 0) - (Number(spec.finaleS) || 0);
    if (show.finaleStartS === null && now >= naturalFinaleAtS) queueFinale(show, naturalFinaleAtS);

    // A clock that jumped (a hidden tab, a long hitch) resumes the rhythm from
    // now rather than firing every rocket it missed in one frame.
    if (now - show.nextLaunchAtS > STALL_CATCH_UP_S) show.nextLaunchAtS = now;
    if (show.nextFountainAtS !== null && now - show.nextFountainAtS > STALL_CATCH_UP_S) show.nextFountainAtS = now;

    if (show.finaleStartS === null) {
        let guard = 0;
        while (show.nextLaunchAtS <= now && guard < 12) {
            guard += 1;
            const launchedAtS = show.nextLaunchAtS;
            launches.push(makeLaunch(show, launchedAtS));
            if (rng() < (Number(spec.volleyChance) || 0)) {
                const extra = 1 + Math.floor(rng() * 2);
                for (let index = 0; index < extra; index += 1) {
                    launches.push(makeLaunch(show, launchedAtS + between(rng, 0.12, 0.45)));
                }
            }
            show.nextLaunchAtS = launchedAtS + launchInterval(show, launchedAtS - show.startedAtS);
        }
    } else {
        while (show.finaleQueue.length && show.finaleQueue[0].atS <= now) {
            const entry = show.finaleQueue.shift();
            launches.push(makeLaunch(show, entry.atS, {
                padOverride: entry.pad,
                heightOverride: entry.tall
                    ? spec.burstHeightM[1]
                    : between(rng, spec.burstHeightM[0], spec.burstHeightM[1]),
                kindOverride: entry.tall ? 'chrysanthemum' : null,
            }));
        }
        const finaleEndS = show.finaleStartS + (Number(spec.finaleS) || 12);
        if (show.finaleQueue.length === 0 && now >= finaleEndS + (Number(spec.tailS) || 8)) {
            show.done = true;
        }
    }

    const fountain = spec.crownFountain;
    if (fountain && !show.done) {
        let guard = 0;
        while (show.nextFountainAtS <= now && guard < 4) {
            guard += 1;
            fountains.push({
                id: `fountain-${show.launchCount}-${guard}`,
                atS: show.nextFountainAtS,
                origin: { x: 0, y: fountain.y, z: 0 },
                starCount: fountain.starCount,
                colour: pick(rng, fountain.palette || spec.palette),
                coneDeg: fountain.coneDeg ?? 28,
                speedMps: [fountain.speedMps?.[0] ?? 22, fountain.speedMps?.[1] ?? 34],
            });
            show.nextFountainAtS += between(rng, fountain.intervalS[0], fountain.intervalS[1]);
        }
    }
    return { launches, fountains, done: show.done };
}

// The campaign's last line has been spoken: fire the finale now instead of
// waiting for the authored duration, then let the last stars burn out.
export function finishFireworksShow(show, showTimeS) {
    if (show.done || show.finaleStartS !== null) return false;
    queueFinale(show, Number(showTimeS) || 0);
    return true;
}

// Velocities for a crown fountain: an upward cone from the lantern.
export function fountainStarVelocities(fountain, rng) {
    const total = Math.max(1, Math.floor(Number(fountain.starCount) || 1));
    const cone = ((Number(fountain.coneDeg) || 28) * Math.PI) / 180;
    const velocities = new Array(total);
    for (let index = 0; index < total; index += 1) {
        const tilt = Math.acos(1 - rng() * (1 - Math.cos(cone)));
        const azimuth = between(rng, 0, Math.PI * 2);
        const s = between(rng, fountain.speedMps[0], fountain.speedMps[1]);
        velocities[index] = {
            x: Math.sin(tilt) * Math.cos(azimuth) * s,
            y: Math.cos(tilt) * s,
            z: Math.sin(tilt) * Math.sin(azimuth) * s,
        };
    }
    return velocities;
}
