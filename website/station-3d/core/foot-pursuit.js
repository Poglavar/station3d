// Pure rules for the campaign's on-foot pursuers. The player's own walked
// positions form a breadcrumb trail; a small group marches along it at a
// walking pace, so a walking player is caught and a running one pulls away.
// The trail carries the height the walker stood at, so followers keep to the
// streets and stairs the player already crossed without any ground sampling.
// Headings use the person-mesh convention: +Z forward at zero, atan2(dx, dz).

const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);

export const FOOT_PURSUIT_DEFAULTS = Object.freeze({
    count: 4,
    // Brisker than the story walk (1.8 m/s), far slower than the ×3 run.
    speedMps: 2.3,
    // The group appears this far back along the trail, once the trail is long
    // enough and the spot is behind the player's back.
    spawnBehindM: 16,
    spacingM: 2.2,
    laneM: 0.45,
    catchRadiusM: 1.6,
    // A group this far behind gives up; a fresh one forms after the player
    // has walked regroupAfterM more, so a runner is chased the whole way.
    loseBehindM: 90,
    regroupAfterM: 45,
    trailStepM: 0.5,
    trailKeepM: 400,
    // A jump between samples this long is a teleport or a flight, not a walk.
    trailGapM: 8,
    trailDropM: 3,
});

export function createFootPursuitState(spec = {}) {
    const options = { ...FOOT_PURSUIT_DEFAULTS };
    for (const key of Object.keys(FOOT_PURSUIT_DEFAULTS)) {
        const value = spec?.[key];
        if (isFiniteNumber(value) && value > 0) options[key] = value;
    }
    options.count = Math.max(1, Math.min(8, Math.trunc(options.count)));
    return {
        options,
        trail: [],
        trailLengthM: 0,
        pursuers: [],
        groups: 0,
        nextSpawnAtM: options.spawnBehindM,
        caught: false,
    };
}

export function resetFootPursuit(state) {
    if (!state) return;
    state.trail = [];
    state.trailLengthM = 0;
    state.pursuers = [];
    state.nextSpawnAtM = state.options.spawnBehindM;
}

function recordTrail(state, player) {
    const { trailStepM, trailGapM, trailDropM, trailKeepM } = state.options;
    const last = state.trail.at(-1);
    if (!last) {
        state.trail.push({ x: player.x, y: player.y, z: player.z, s: 0 });
        state.trailLengthM = 0;
        return 'started';
    }
    const moved = Math.hypot(player.x - last.x, player.z - last.z);
    if (moved >= trailGapM || Math.abs(player.y - last.y) >= trailDropM) {
        resetFootPursuit(state);
        state.trail.push({ x: player.x, y: player.y, z: player.z, s: 0 });
        return 'reset';
    }
    if (moved < trailStepM) return 'held';
    const s = last.s + moved;
    state.trail.push({ x: player.x, y: player.y, z: player.z, s });
    state.trailLengthM = s;
    // Keep the segment every pursuer stands on plus the retained length.
    let minS = Math.max(0, s - trailKeepM);
    for (const pursuer of state.pursuers) minS = Math.min(minS, pursuer.s - 5);
    while (state.trail.length > 2 && state.trail[1].s <= minS) state.trail.shift();
    return 'extended';
}

export function footPursuitTrailPoint(state, s) {
    const trail = state?.trail;
    if (!trail || trail.length === 0) return null;
    if (trail.length === 1 || s <= trail[0].s) {
        const a = trail[0];
        const b = trail[1] || null;
        const headingRad = b ? Math.atan2(b.x - a.x, b.z - a.z) : 0;
        return { x: a.x, y: a.y, z: a.z, headingRad };
    }
    let lo = 0;
    let hi = trail.length - 1;
    if (s >= trail[hi].s) {
        const a = trail[hi - 1];
        const b = trail[hi];
        return { x: b.x, y: b.y, z: b.z, headingRad: Math.atan2(b.x - a.x, b.z - a.z) };
    }
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (trail[mid].s <= s) lo = mid;
        else hi = mid;
    }
    const a = trail[lo];
    const b = trail[hi];
    const span = b.s - a.s;
    const t = span > 0 ? (s - a.s) / span : 0;
    return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
        headingRad: Math.atan2(b.x - a.x, b.z - a.z),
    };
}

export function footPursuerPose(state, pursuer) {
    const point = footPursuitTrailPoint(state, pursuer?.s);
    if (!point) return null;
    const lane = isFiniteNumber(pursuer.lane) ? pursuer.lane : 0;
    return {
        x: point.x + Math.cos(point.headingRad) * lane,
        y: point.y,
        z: point.z - Math.sin(point.headingRad) * lane,
        headingRad: point.headingRad,
    };
}

function behindPlayer(player, point) {
    if (!isFiniteNumber(player.headingRad)) return true;
    const forwardX = Math.sin(player.headingRad);
    const forwardZ = Math.cos(player.headingRad);
    return forwardX * (point.x - player.x) + forwardZ * (point.z - player.z) < 0;
}

// One step of the chase. `player` is the walker's feet in local metres with
// `onFoot` and `airborne`; a boarded vehicle clears the trail, a flight leaves
// no crumbs. Returns what changed this step for the caller's presentation.
export function advanceFootPursuit(state, { dt = 0, player = null } = {}) {
    const result = { spawned: 0, lost: false, caught: !!state?.caught, nearestM: null };
    if (!state || state.caught) return result;
    if (!player || player.onFoot !== true) {
        if (state.trail.length || state.pursuers.length) resetFootPursuit(state);
        return result;
    }
    if (!isFiniteNumber(player.x) || !isFiniteNumber(player.y) || !isFiniteNumber(player.z)) return result;
    const options = state.options;
    const step = isFiniteNumber(dt) && dt > 0 ? dt : 0;
    if (player.airborne !== true) recordTrail(state, player);

    if (state.pursuers.length === 0 && state.trailLengthM >= state.nextSpawnAtM) {
        const spawnS = Math.max(0, state.trailLengthM - options.spawnBehindM);
        const point = footPursuitTrailPoint(state, spawnS);
        if (point && behindPlayer(player, point)) {
            for (let index = 0; index < options.count; index++) {
                const side = index % 2 === 0 ? 1 : -1;
                // A file: each man a spacing behind the one before. Where the
                // trail is too short for that, the rest wait at its start for
                // the time the gap takes, so they never leave as one clump.
                const wanted = spawnS - index * options.spacingM;
                state.pursuers.push({
                    index,
                    s: Math.max(0, wanted),
                    holdS: wanted < 0 ? -wanted / options.speedMps : 0,
                    lane: side * options.laneM * (1 + Math.floor(index / 2) * 0.6),
                    phase: index * 1.3,
                    movedM: 0,
                });
            }
            state.groups += 1;
            result.spawned = options.count;
        }
    }

    // Nobody overtakes the crumb the player is standing on, and the file keeps
    // its spacing behind the lead, so a stopped player is faced by a group,
    // not by four men on one spot.
    const headroom = Math.max(0, state.trailLengthM - 0.25);
    for (const pursuer of state.pursuers) {
        let moving = step;
        if (pursuer.holdS > 0) {
            const held = Math.min(pursuer.holdS, step);
            pursuer.holdS -= held;
            moving = step - held;
        }
        const limit = Math.max(0, headroom - pursuer.index * options.spacingM);
        const next = Math.min(limit, pursuer.s + options.speedMps * moving);
        pursuer.movedM = Math.max(0, next - pursuer.s);
        pursuer.s = next;
        pursuer.phase += pursuer.movedM * 5.2;
    }

    if (state.pursuers.length) {
        let lead = -Infinity;
        for (const pursuer of state.pursuers) lead = Math.max(lead, pursuer.s);
        if (state.trailLengthM - lead > options.loseBehindM) {
            state.pursuers = [];
            state.nextSpawnAtM = state.trailLengthM + options.regroupAfterM;
            result.lost = true;
        }
    }

    let nearest = null;
    for (const pursuer of state.pursuers) {
        const pose = footPursuerPose(state, pursuer);
        if (!pose) continue;
        const distance = Math.hypot(pose.x - player.x, pose.z - player.z);
        if (nearest === null || distance < nearest) nearest = distance;
    }
    result.nearestM = nearest;
    if (nearest !== null && nearest <= options.catchRadiusM) {
        state.caught = true;
        result.caught = true;
    }
    return result;
}
