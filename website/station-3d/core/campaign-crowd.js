// Pure rules for an authored campaign crowd: where people gather, how they
// mill about a plaza, and when the ones carrying cameras raise them and fire
// a flash. Scene-local metres, no three.js; world/campaign-crowd.js renders
// the result with instanced meshes.

import { geoToLocal, DEG_TO_RAD } from './math.js';

export const CAMPAIGN_CROWD_MAX_PEOPLE = 240;
export const CAMPAIGN_CROWD_CAMERA_SHARE = 0.4;
// Nobody stands inside the walker; the crowd yields around the player.
export const CROWD_PLAYER_CLEARANCE_M = 1.1;
// Flashes are rationed so a full plaza pops, never strobes.
export const CROWD_FLASH_MIN_GAP_S = 0.3;
export const CROWD_PHOTO = Object.freeze({
    raiseS: 0.7,
    holdS: Object.freeze([0.5, 1.4]),
    flashDelayS: 0.15,
    lowerS: 0.6,
    // Chance a standing photographer's next act is a photo rather than a stroll.
    chance: 0.35,
});
const STAND_DWELL_S = Object.freeze([6, 25]);
// A stroll is a few metres to a better spot, not a lap of the plaza: most of
// the crowd stands and watches, a few are always drifting.
const STROLL_M = Object.freeze([3, 12]);
const PHOTO_REST_S = Object.freeze([10, 30]);
const BLOCKED_REST_S = Object.freeze([1, 3]);
const FACE_FOCUS_CHANCE = 0.7;
const TURN_RATE_STANDING = 2.5;
const TURN_RATE_WALKING = 5;
const TURN_RATE_PHOTO = 4;
const FACING_TOLERANCE_RAD = 0.04;
const GAIT_EASE_PER_S = 6;
const GAIT_PHASE_PER_M = 4.8;
const ARRIVE_M = 0.3;
const PLACEMENT_TRIES = 40;
const TARGET_TRIES = 12;

export function hashCrowdSeed(text) {
    let hash = 2166136261;
    for (const character of String(text)) {
        hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    }
    return hash >>> 0;
}

// mulberry32: small, fast and good enough for a crowd that must lay out the
// same way every time a checkpoint reopens.
export function createSeededRandom(seed) {
    let state = (typeof seed === 'number' ? seed : hashCrowdSeed(seed)) >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function between(random, [low, high]) {
    return low + random() * (high - low);
}

function wrapAngle(angle) {
    let a = angle;
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
}

function smoothstep(t) {
    const x = Math.max(0, Math.min(1, t));
    return x * x * (3 - 2 * x);
}

// People face local +Z at heading 0, like the shared person mesh; a heading
// is the rotation about Y that turns +Z towards (dx, dz).
export function crowdHeadingTowards(dx, dz) {
    return Math.atan2(dx, dz);
}

// Shapes: { x, z, radiusM } discs or { x, z, halfWidthM, halfDepthM, rotationY }
// rectangles, rotated the same way the tower rotates its site frame.
export function crowdShapeContains(shape, x, z) {
    if (!shape) return false;
    const dx = x - shape.x;
    const dz = z - shape.z;
    if (Number.isFinite(shape.radiusM)) return dx * dx + dz * dz <= shape.radiusM * shape.radiusM;
    const cos = Math.cos(shape.rotationY || 0);
    const sin = Math.sin(shape.rotationY || 0);
    const sx = dx * cos - dz * sin;
    const sz = dx * sin + dz * cos;
    return Math.abs(sx) <= shape.halfWidthM && Math.abs(sz) <= shape.halfDepthM;
}

export function crowdPointBlocked(crowd, x, z) {
    for (const shape of crowd.keepClear) if (crowdShapeContains(shape, x, z)) return true;
    return typeof crowd.isBlocked === 'function' && crowd.isBlocked(x, z) === true;
}

// Converts an authored `scene.authored.crowd` (lat/lon) into scene-local shapes.
export function campaignCrowdLayoutFromAuthored(authored, { anchorLat, anchorLon } = {}) {
    if (!authored || !Array.isArray(authored.gatherings)) return null;
    const local = point => geoToLocal(Number(point.lon), Number(point.lat), Number(anchorLon), Number(anchorLat));
    const gatherings = authored.gatherings.map(gathering => {
        const at = local(gathering);
        return {
            x: at.x,
            z: at.z,
            radiusM: Number(gathering.radiusM),
            innerRadiusM: Number.isFinite(gathering.innerRadiusM) ? Number(gathering.innerRadiusM) : 0,
            count: Math.max(0, Math.floor(Number(gathering.count) || 0)),
        };
    });
    const keepClear = (authored.keepClear || []).map(shape => {
        const at = local(shape);
        if (Number.isFinite(shape.radiusM)) return { x: at.x, z: at.z, radiusM: Number(shape.radiusM) };
        return {
            x: at.x,
            z: at.z,
            halfWidthM: Number(shape.widthM) / 2,
            halfDepthM: Number(shape.depthM) / 2,
            rotationY: (Number(shape.rotationDeg) || 0) * DEG_TO_RAD,
        };
    });
    const focus = authored.focus ? local(authored.focus) : null;
    return {
        gatherings,
        keepClear,
        focus: focus ? { x: focus.x, z: focus.z } : null,
        cameraShare: Number.isFinite(authored.cameraShare) ? authored.cameraShare : CAMPAIGN_CROWD_CAMERA_SHARE,
        seed: authored.seed || 'campaign-crowd',
    };
}

function samplePointInGathering(random, gathering) {
    const angle = random() * Math.PI * 2;
    const inner = Math.max(0, gathering.innerRadiusM || 0);
    // sqrt keeps the disc uniformly filled rather than bunched at the centre.
    const radius = Math.sqrt(random() * (gathering.radiusM ** 2 - inner ** 2) + inner ** 2);
    return { x: gathering.x + Math.sin(angle) * radius, z: gathering.z + Math.cos(angle) * radius };
}

function tooClose(people, x, z, spacingM) {
    const limit = spacingM * spacingM;
    for (const other of people) {
        const dx = other.x - x;
        const dz = other.z - z;
        if (dx * dx + dz * dz < limit) return true;
    }
    return false;
}

function pickKind(random) {
    const roll = random();
    return roll < 0.2 ? 'kid' : roll < 0.58 ? 'female' : 'male';
}

function facingFor(crowd, random, person) {
    if (crowd.focus && random() < FACE_FOCUS_CHANCE) {
        return crowdHeadingTowards(crowd.focus.x - person.x, crowd.focus.z - person.z);
    }
    return random() * Math.PI * 2;
}

export function createCampaignCrowd({
    gatherings = [],
    keepClear = [],
    focus = null,
    cameraShare = CAMPAIGN_CROWD_CAMERA_SHARE,
    seed = 'campaign-crowd',
    isBlocked = null,
    minSpacingM = 0.9,
} = {}) {
    const random = createSeededRandom(seed);
    const crowd = {
        gatherings, keepClear, focus, cameraShare, random, isBlocked, minSpacingM,
        people: [], flashCooldownS: 0, elapsedS: 0,
    };
    let remaining = CAMPAIGN_CROWD_MAX_PEOPLE;
    gatherings.forEach((gathering, gatheringIndex) => {
        const placed = [];
        for (let index = 0; index < gathering.count && remaining > 0; index += 1) {
            let point = null;
            for (let attempt = 0; attempt < PLACEMENT_TRIES && !point; attempt += 1) {
                const candidate = samplePointInGathering(random, gathering);
                if (crowdPointBlocked(crowd, candidate.x, candidate.z)) continue;
                if (tooClose(placed, candidate.x, candidate.z, minSpacingM)) continue;
                point = candidate;
            }
            if (!point) continue;
            const kind = pickKind(random);
            const person = {
                id: crowd.people.length,
                gathering: gatheringIndex,
                kind,
                look: {
                    bodyIndex: Math.floor(random() * 8),
                    skinIndex: Math.floor(random() * 5),
                    legIndex: Math.floor(random() * 6),
                    faceSeed: Math.floor(random() * 0x100000000),
                },
                camera: kind !== 'kid' && random() < cameraShare,
                x: point.x,
                z: point.z,
                y: null,
                heading: 0,
                faceHeading: 0,
                state: 'stand',
                stateS: 0,
                dwellS: between(random, STAND_DWELL_S),
                target: null,
                speedMps: kind === 'kid' ? between(random, [0.7, 1.2]) : between(random, [0.6, 1.1]),
                gaitPhase: random() * Math.PI * 2,
                gaitAmount: 0,
                raise: 0,
                photo: null,
            };
            person.faceHeading = facingFor(crowd, random, person);
            person.heading = person.faceHeading;
            placed.push(person);
            crowd.people.push(person);
            remaining -= 1;
        }
    });
    return crowd;
}

function turnTowards(person, heading, rate, dt) {
    const delta = wrapAngle(heading - person.heading);
    const step = rate * dt;
    person.heading = wrapAngle(person.heading + Math.max(-step, Math.min(step, delta)));
    return Math.abs(delta) <= step;
}

function pickTarget(crowd, person) {
    const gathering = crowd.gatherings[person.gathering];
    for (let attempt = 0; attempt < TARGET_TRIES; attempt += 1) {
        const angle = crowd.random() * Math.PI * 2;
        const distance = between(crowd.random, STROLL_M);
        const candidate = { x: person.x + Math.sin(angle) * distance, z: person.z + Math.cos(angle) * distance };
        if (Math.hypot(candidate.x - gathering.x, candidate.z - gathering.z) > gathering.radiusM) continue;
        if (crowdPointBlocked(crowd, candidate.x, candidate.z)) continue;
        return candidate;
    }
    return null;
}

function beginStand(crowd, person, dwell) {
    person.state = 'stand';
    person.stateS = 0;
    person.dwellS = between(crowd.random, dwell);
    person.target = null;
    person.faceHeading = facingFor(crowd, crowd.random, person);
}

// Exported for the localhost debug hook that stages a photo on demand.
export function beginCrowdPhoto(crowd, person) {
    if (!person?.camera || !crowd.focus) return false;
    beginPhoto(crowd, person);
    return true;
}

function beginPhoto(crowd, person) {
    person.state = 'photo';
    person.stateS = 0;
    person.target = null;
    person.photo = { phase: 'raise', holdS: between(crowd.random, CROWD_PHOTO.holdS), flashed: false };
    person.faceHeading = crowdHeadingTowards(crowd.focus.x - person.x, crowd.focus.z - person.z);
}

function stepStand(crowd, person, dt) {
    person.gaitAmount = Math.max(0, person.gaitAmount - GAIT_EASE_PER_S * dt);
    person.raise = Math.max(0, person.raise - dt / CROWD_PHOTO.lowerS);
    turnTowards(person, person.faceHeading, TURN_RATE_STANDING, dt);
    if (person.stateS < person.dwellS) return;
    if (person.camera && crowd.focus && crowd.random() < CROWD_PHOTO.chance) {
        beginPhoto(crowd, person);
        return;
    }
    const target = pickTarget(crowd, person);
    if (!target) {
        beginStand(crowd, person, STAND_DWELL_S);
        return;
    }
    person.state = 'walk';
    person.stateS = 0;
    person.target = target;
}

function stepWalk(crowd, person, dt) {
    const dx = person.target.x - person.x;
    const dz = person.target.z - person.z;
    const distance = Math.hypot(dx, dz);
    turnTowards(person, crowdHeadingTowards(dx, dz), TURN_RATE_WALKING, dt);
    person.raise = Math.max(0, person.raise - dt / CROWD_PHOTO.lowerS);
    const step = Math.min(distance, person.speedMps * dt);
    if (distance <= ARRIVE_M || step <= 0) {
        beginStand(crowd, person, STAND_DWELL_S);
        return;
    }
    const nextX = person.x + dx / distance * step;
    const nextZ = person.z + dz / distance * step;
    if (crowdPointBlocked(crowd, nextX, nextZ)) {
        // A wall or a keep-clear line across the path: wait a moment, then
        // choose somewhere else rather than pushing through.
        beginStand(crowd, person, BLOCKED_REST_S);
        return;
    }
    person.x = nextX;
    person.z = nextZ;
    person.gaitPhase += step * GAIT_PHASE_PER_M;
    person.gaitAmount = Math.min(1, person.gaitAmount + GAIT_EASE_PER_S * dt);
}

function stepPhoto(crowd, person, dt, flashes) {
    const photo = person.photo;
    person.gaitAmount = Math.max(0, person.gaitAmount - GAIT_EASE_PER_S * dt);
    const facing = turnTowards(person, person.faceHeading, TURN_RATE_PHOTO, dt)
        || Math.abs(wrapAngle(person.faceHeading - person.heading)) <= FACING_TOLERANCE_RAD;
    if (photo.phase === 'raise') {
        person.raise = smoothstep(person.stateS / CROWD_PHOTO.raiseS);
        // The bulb waits for the turn: nobody fires a flash at the wrong wall.
        if (person.stateS >= CROWD_PHOTO.raiseS && facing) {
            photo.phase = 'hold';
            person.stateS = 0;
            person.raise = 1;
        }
        return;
    }
    if (photo.phase === 'hold') {
        if (!photo.flashed && person.stateS >= CROWD_PHOTO.flashDelayS && crowd.flashCooldownS <= 0) {
            photo.flashed = true;
            crowd.flashCooldownS = CROWD_FLASH_MIN_GAP_S;
            flashes.push(person);
        }
        if (person.stateS >= photo.holdS) {
            photo.phase = 'lower';
            person.stateS = 0;
        }
        return;
    }
    person.raise = 1 - smoothstep(person.stateS / CROWD_PHOTO.lowerS);
    if (person.stateS >= CROWD_PHOTO.lowerS) {
        person.raise = 0;
        person.photo = null;
        beginStand(crowd, person, PHOTO_REST_S);
    }
}

function yieldToPlayer(crowd, person, player) {
    const dx = person.x - player.x;
    const dz = person.z - player.z;
    const distance = Math.hypot(dx, dz);
    if (distance >= CROWD_PLAYER_CLEARANCE_M) return;
    const angle = distance > 1e-6 ? Math.atan2(dx, dz) : crowd.random() * Math.PI * 2;
    const nextX = player.x + Math.sin(angle) * CROWD_PLAYER_CLEARANCE_M;
    const nextZ = player.z + Math.cos(angle) * CROWD_PLAYER_CLEARANCE_M;
    if (crowdPointBlocked(crowd, nextX, nextZ)) return;
    person.x = nextX;
    person.z = nextZ;
}

// Advances every person by dt seconds. Returns the people whose flash fired
// this step; the renderer draws the burst and plays the click.
export function stepCampaignCrowd(crowd, { dt = 0, player = null } = {}) {
    const flashes = [];
    if (!(dt > 0)) return { flashes };
    crowd.elapsedS += dt;
    crowd.flashCooldownS -= dt;
    for (const person of crowd.people) {
        person.stateS += dt;
        if (person.state === 'walk') stepWalk(crowd, person, dt);
        else if (person.state === 'photo') stepPhoto(crowd, person, dt, flashes);
        else stepStand(crowd, person, dt);
        if (player && Number.isFinite(player.x) && Number.isFinite(player.z)) yieldToPlayer(crowd, person, player);
    }
    return { flashes };
}

// Arm pitch/roll for one side: the walking swing when the camera hangs, the
// arms lifted up and out in front of the face when it is raised, high enough
// that the pose reads from behind as well. Blended by raise.
export function crowdArmPose(side, swing, raise) {
    const t = Math.max(0, Math.min(1, raise));
    return {
        x: (-swing * side) * (1 - t) + 2.0 * t,
        z: -side * 0.21 * t,
    };
}

// Where the camera body sits relative to the person: slung at the right hip
// when lowered, held out at face height between the hands when raised. The
// raise swings it through a small forward arc so the lift reads as a motion.
export function crowdCameraPlacement(dims, raise) {
    const t = smoothstep(raise);
    const shoulderY = dims.legH + dims.bodyH * 0.95;
    const hip = { x: dims.armX * 0.75, y: dims.legH + dims.bodyH * 0.35, z: dims.bodyR + 0.06, pitch: 0.35 };
    const face = { x: 0, y: shoulderY + 0.25, z: dims.armH * 0.83, pitch: 0.12 };
    return {
        x: hip.x + (face.x - hip.x) * t,
        y: hip.y + (face.y - hip.y) * t,
        z: hip.z + (face.z - hip.z) * t + Math.sin(Math.PI * t) * 0.06,
        pitch: hip.pitch + (face.pitch - hip.pitch) * t,
    };
}
