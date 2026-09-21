// Free-roam pedestrian mode: W/S (or ↑/↓) walk the direction you're looking,
// A/D (or ←/→) rotate heading, Space activates the jetpack (hold to ascend,
// release to slow-fall). Produces cab-compatible poses that the cab mode
// feeds through the normal camera/tile/decoration pipeline.
//
// Vertical physics uses a caller-injected getGroundY(localX, localZ) and
// horizontal movement a caller-injected resolveMove(...) — the walk module
// stays free of THREE / scene knowledge, and cab.js supplies the raycast and
// the wall collision as closures.

import { DEG_TO_RAD, EARTH_RADIUS_M, haversineMeters } from '../core/math.js';

// Free roam is a survey tool: 25 m/s crosses a city fast enough to inspect it.
// Authored campaign scenes are not — at 25 m/s a 2.5 s keypress covers 62 m,
// which overshoots every 6 m interaction radius, blows through the 14–38 m
// story zones and completes "walk to the harbour" before the player has spoken
// to anyone. Story scenes ask for a person's pace instead.
export const FREE_ROAM_WALK_SPEED_MPS = 25;
export const STORY_WALK_SPEED_MPS = 1.8;
const TURN_SPEED = 1.8;         // rad/s
const JETPACK_ACCEL = 18;       // m/s² upward thrust while held
const JETPACK_MAX_VY = 8;       // m/s upward terminal — no infinite acceleration
// Hard ceiling above the ground/rooftop reference. The session sets it via
// setJetpackCeiling: 120 m for city walks so every roof is reachable from the
// street (Zagreb's tallest towers are just under 100 m), 350 m for photoreal
// terrain inspection. 50 m is only the unset default.
let jetpackMaxY = 50;
export function setJetpackCeiling(m) { jetpackMaxY = Number.isFinite(m) && m > 0 ? m : 50; }
const FALL_GRAVITY = 9.8;       // m/s² when not jetpacking
const FALL_TERMINAL_VY = -12;   // m/s downward terminal
// Under a canopy the fall settles onto a steady descent and the walker keeps
// steering authority at a drift pace, whatever the session's walking speed —
// a bailed-out pilot at story walking pace could not steer at all.
export const PARACHUTE_DESCENT_VY = -5.5;
export const PARACHUTE_DRIFT_MPS = 7;
const PARACHUTE_OPEN_DECEL = 6;   // m/s² the canopy pulls a faster fall back with
// "Ground" snap epsilon — when standing on a surface vy is held at 0
// rather than left to drift on numerical noise.
const GROUND_EPS_M = 0.02;
const WALK_STEP_DOWN_MIN_M = 0.40;
const WALK_STEP_DOWN_PER_HORIZONTAL_M = 0.8;
const WALK_STEP_DOWN_MAX_M = 2.0;
const WALK_SUPPORT_SEAM_GRACE_S = 0.06;
// `initialGroundY` belongs only to the cab/direct-walk spawn point. It is not
// a world datum: carrying it away from that point creates an invisible level
// plane whenever the streamed terrain ray misses.
const WALK_INITIAL_SUPPORT_RADIUS_M = 0.75;
const WALK_BUILDING_SUPPORT_TOLERANCE_M = 0.5;
export const WALK_TERRAIN_RECOVERY_DEPTH_M = 2.5;
// How far ABOVE a spawn hint a detected support may sit and still be believed.
// See acceptsDetectedGroundAtSpawn.
export const WALK_SPAWN_HINT_TOLERANCE_M = 1.5;
export const WALK_MAX_STEP_UP_M = 1.75;

// Support for anyone over the mapped sea: the water surface, unless something
// stands above it (a quay deck, a jetty, a moored boat's deck). The terrain
// under the sea is no floor — LiDAR is NoData there, the 20 m base carries
// harbour artefacts metres off the datum, and a basin can have nothing at
// all — so a parachutist, a jetpack jumper and a walker stepping off the Riva
// all end on the surface, never 5.5 m under it (Split, 2026-09-16). A null
// sea level (the sea not yet published) leaves the ground sample alone.
export function seaSurfaceSupportY(groundY, seaY) {
    if (!Number.isFinite(seaY)) return groundY;
    return Number.isFinite(groundY) ? Math.max(groundY, seaY) : seaY;
}

const walkKeys = new Set();
let keysBound = false;

// Speed booster: hold Shift or toggle ⚡ for ×3 horizontal speed. State lives here so the physics step and the UI stay in sync.
const BOOST_MULTIPLIER = 3;
let speedBoost = false;
export function setWalkSpeedBoost(on) { speedBoost = !!on; }
export function isWalkSpeedBoostOn() { return speedBoost || walkKeys.has('shift'); }

// Base pace, set per session. A campaign scene drops it to walking speed and
// the free-roam default is restored when that session closes, so nothing about
// ordinary walk mode changes.
let baseWalkSpeedMps = FREE_ROAM_WALK_SPEED_MPS;
export function setWalkSpeed(mps) {
    const next = Number(mps);
    baseWalkSpeedMps = Number.isFinite(next) && next > 0 ? next : FREE_ROAM_WALK_SPEED_MPS;
}
export function getWalkSpeed() { return baseWalkSpeedMps; }
export function walkStepSpeedMps(baseMps, boost) {
    const base = Number(baseMps);
    const safe = Number.isFinite(base) && base > 0 ? base : FREE_ROAM_WALK_SPEED_MPS;
    return safe * (boost ? BOOST_MULTIPLIER : 1);
}

export function bindWalkKeys() {
    if (keysBound) return;
    keysBound = true;
}

// Called by the cab-mode key handler.
export function onKeyDown(k) { walkKeys.add(k); }
export function onKeyUp(k)   { walkKeys.delete(k); }
export function clearWalkKeys() { walkKeys.clear(); }

export function shouldRecoverTerrainFloor(walkerY, terrainGroundY, {
    insideSurfaceCutout = false,
    insideStructuralCutout = false,
    insideSubsurfaceCorridor = false,
    nearestSupportY = null,
} = {}) {
    // A support close beneath the walker means they are STANDING on something
    // real — a cut bench, a collar, a trench floor. Recovery exists for true
    // fall-through (no support anywhere near) and must never out-rank an
    // actual floor: on the portal-approach bench it yanked a walker standing
    // on engineered works up to the raw hilltop 16 m above (the "not permitted
    // to enter the tunnel" bump).
    if (Number.isFinite(nearestSupportY)
        && Number.isFinite(walkerY)
        && nearestSupportY >= walkerY - WALK_TERRAIN_RECOVERY_DEPTH_M) {
        return false;
    }
    return Number.isFinite(walkerY)
        && Number.isFinite(terrainGroundY)
        && walkerY < terrainGroundY - WALK_TERRAIN_RECOVERY_DEPTH_M
        && !insideSurfaceCutout
        && !insideStructuralCutout
        && !insideSubsurfaceCorridor;
}

export function isWalkSupportOverhead(walkerY, supportY, {
    maxStepUpM = WALK_MAX_STEP_UP_M,
} = {}) {
    return Number.isFinite(walkerY)
        && Number.isFinite(supportY)
        && supportY > walkerY + maxStepUpM + 0.01;
}

export function reachableWalkSupportY(walkerY, supportY, options = {}) {
    if (!Number.isFinite(supportY)) return null;
    return isWalkSupportOverhead(walkerY, supportY, options) ? null : supportY;
}

// A model-terrain rail cut removes the DGU surface in the shader and replaces
// it with the formation's own level bed / batter / collar. Walk support must
// make the identical ownership choice. Otherwise the removed DGU triangle is
// still returned as an invisible floor and a walker remains suspended above a
// deep cutting instead of dropping onto the visible track-level surface.
export function resolveRailFormationWalkSupport({
    walkerY = null,
    civilGroundY = null,
    insideOpenCut = false,
    maxStepUpM = WALK_MAX_STEP_UP_M,
} = {}) {
    const ownsCut = !!insideOpenCut;
    return {
        ownsCut,
        firmGroundY: ownsCut
            ? reachableWalkSupportY(walkerY, civilGroundY, { maxStepUpM })
            : null,
    };
}

// A viaduct deck may replace a shallow DGU ridge that lies above its concrete
// slab. Suppress that raw terrain only for somebody who can actually stand on
// the deck; from below, the same deck is overhead and must not turn the whole
// plan footprint into a physics hole.
export function resolveViaductTerrainWalkSupport({
    walkerY = null,
    deckY = null,
    terrainCutoutActive = false,
    maxStepUpM = WALK_MAX_STEP_UP_M,
} = {}) {
    const firmDeckY = reachableWalkSupportY(walkerY, deckY, { maxStepUpM });
    return {
        ownsTerrain: terrainCutoutActive === true && Number.isFinite(firmDeckY),
        firmDeckY,
    };
}

// A road underpass and an independently rendered street can occupy the same
// plan position. That is exactly what happens where Strossmayerovo šetalište
// crosses the pedestrian tunnel beneath Gornji Grad: the lower solved profile
// opens the terrain, while the upper paving remains a visible bridge/roof.
//
// The lower corridor may suppress raw terrain, but it may never suppress an
// exact rendered road triangle that is within walking reach. Conversely, a
// walker already on the tunnel floor sees that same triangle overhead, so the
// lower corridor remains authoritative. Keeping this altitude decision pure
// makes the render/physics ownership contract independently testable.
export function resolveRoadReplacementWalkSupport({
    walkerY = null,
    terrainY = null,
    renderedSurfaceY = null,
    insideOpening = false,
    insideCorridor = false,
    maxStepUpM = WALK_MAX_STEP_UP_M,
} = {}) {
    const firmRenderedSurfaceY = reachableWalkSupportY(
        walkerY,
        renderedSurfaceY,
        { maxStepUpM },
    );
    const renderedSurfaceOwns = Number.isFinite(firmRenderedSurfaceY);
    const belowTerrain = isWalkSupportOverhead(
        walkerY,
        terrainY,
        { maxStepUpM },
    );
    return {
        firmRenderedSurfaceY,
        insideReplacementCorridor: !renderedSurfaceOwns
            && (!!insideOpening || (belowTerrain && !!insideCorridor)),
    };
}

// Classifies the walker's support situation for one ground query. This is the
// single place where "am I under the world's surface, inside a bore, or on
// open ground" is decided — the flat world used absolute scene heights
// (walkerY < -0.5 meant underground), which is meaningless in a terrain world
// where a bore's interior sits at POSITIVE scene Y. Two symptoms came from
// that: bumping a bore wall "recovered" the walker up through the hill to the
// surface, and standing on intact ground above the bore offered the tube floor
// through it (the corridor-cut polygons describe the PHOTO world's carve,
// which opens the whole route).
// A walker counts as "at bore level" only within this of the tube floor — the
// tube's own clear height. Above it they are inside the HILL (a fall, a seam
// dip), and the surface, not the tube, is their world.
export const WALK_BORE_LEVEL_CLEARANCE_M = 6;

export function resolveWalkSupportContext({
    walkerY = null,
    terrainY = null,
    corridorFloorY = null,
    tunnelFloorY = null,         // the formation's own tube floor (hint)
    insideCutPolygon = false,
    insideCutPolygonStructural = false,
    tunnelRoof = null,           // null | 'intact-roof' | 'portal-carve'
    hasTerrainWorld = false,
    maxStepUpM = WALK_MAX_STEP_UP_M,
} = {}) {
    let surfaceCutout = !!insideCutPolygon;
    let structuralCutout = !!insideCutPolygonStructural;
    let subsurface = Number.isFinite(corridorFloorY)
        && Number.isFinite(walkerY)
        && (structuralCutout || (walkerY < -0.5 && corridorFloorY < -0.5));
    let suppressRecovery = false;
    if (hasTerrainWorld && tunnelRoof === 'intact-roof') {
        // Over a bored span the model surface is REAL ground whatever the
        // corridor polygons say. INSIDE the bore, the tube floor is the only
        // floor — and even when the corridor floor query misses for a frame
        // (a wall bump pushed the probe outside the bore), being at bore level
        // under the hill is never a reason to teleport to the surface.
        //
        // "Inside" is judged against the tube floor, not merely "below the
        // terrain": a walker who dips a couple of metres under the surface
        // 30 m ABOVE the tube is falling through the hill, and the ordinary
        // terrain recovery must catch them — offering the tube floor there is
        // exactly the fall-through-into-the-tunnel bug.
        surfaceCutout = false;
        structuralCutout = false;
        const underTerrain = Number.isFinite(terrainY)
            && Number.isFinite(walkerY)
            && walkerY < terrainY - maxStepUpM;
        const boreFloor = Number.isFinite(corridorFloorY) ? corridorFloorY : tunnelFloorY;
        const atBoreLevel = Number.isFinite(boreFloor)
            && Number.isFinite(walkerY)
            && walkerY < boreFloor + WALK_BORE_LEVEL_CLEARANCE_M;
        subsurface = underTerrain && atBoreLevel && Number.isFinite(corridorFloorY);
        suppressRecovery = underTerrain && atBoreLevel;
    }
    return { surfaceCutout, structuralCutout, subsurface, suppressRecovery };
}

// A spawn hint means "you were deliberately placed here, on a floor the caller
// knew about" — Vidi dropping the walker onto an underground station's platform,
// for instance. World layers stream in over several frames, so the first steps
// can run before the layer that owns that floor has built anything.
//
// A detection far ABOVE the hint during that window is not evidence the spawn
// was wrong; it is the world not having built the floor yet. Believing it
// teleported a walker spawned 10 m down in a station up to the street — and
// permanently, because accepting a detection also clears the hint, so the
// correct floor arriving a frame later changed nothing.
//
// Below or near the hint is always believed: that is the real floor arriving.
// The hint is already confined to WALK_INITIAL_SUPPORT_RADIUS_M around the
// spawn point, so this cannot hold a walker down once they actually move —
// climbing the station stairs to the street clears the hint by distance.
export function acceptsDetectedGroundAtSpawn(detectedGroundY, initialGroundY, {
    toleranceM = WALK_SPAWN_HINT_TOLERANCE_M,
} = {}) {
    if (!Number.isFinite(detectedGroundY)) return false;
    if (!Number.isFinite(initialGroundY)) return true;
    return detectedGroundY <= initialGroundY + toleranceM;
}

// A scene's Y origin is the session anchor, not sea level or a universal
// street level. Decide whether the walker is above ground relative to the
// support beneath them so both flat Zagreb (0/0) and coastal Split (-36/-36)
// can use the building roof bump, while a real underground walker (-36/0)
// cannot be lifted through the terrain onto a roof.
export function shouldUseBuildingRoofBump(walkerY, supportY, {
    insideSurfaceCutout = false,
    insideStructuralCutout = false,
    insideSubsurfaceCorridor = false,
    insideBuildingPassage = false,
} = {}) {
    return Number.isFinite(walkerY)
        && Number.isFinite(supportY)
        && walkerY - supportY >= -WALK_BUILDING_SUPPORT_TOLERANCE_M
        && !insideSurfaceCutout
        && !insideStructuralCutout
        && !insideSubsurfaceCorridor
        && !insideBuildingPassage;
}

// A roof is landing support only from above. An airborne walker whose feet
// are well below the roof hit is inside the block's volume (a facade whose
// height the walls did not know) and must not be teleported up onto it the
// moment the jetpack releases; they fall out instead. A grounded walker who
// somehow stands inside a block is still lifted out, as before.
export function shouldAcceptRoofSupport(walkerY, roofY, { airborne = false } = {}) {
    if (!Number.isFinite(roofY)) return false;
    if (!airborne) return true;
    return Number.isFinite(walkerY) && roofY <= walkerY + WALK_MAX_STEP_UP_M;
}

// Selects the model world's synthetic ground baseline. Photo mode deliberately
// has no such baseline: its visible Google mesh is sampled by a local ray, and
// substituting scene y=0 (or a hidden DGU/OSM surface) creates an invisible
// absolute floor wherever that ray temporarily misses.
//
// With a walker height supplied, the baseline is the HIGHEST candidate within
// a step below the walker — not the first finite one. "Rail first" was a flat
// world's shortcut (bed ≈ road ≈ terrain within centimetres); on a hillside the
// rail query can answer with a bore segment 30 m beneath the hill the walker is
// standing on, and a fixed priority then declared the tube floor to be street
// level everywhere above it.
export function selectWalkBaselineSupportY({
    photoWorld = false,
    requireEvidence = false,
    walkerY = null,
    railY = null,
    roadY = null,
    terrainY = null,
    maxStepUpM = WALK_MAX_STEP_UP_M,
} = {}) {
    if (photoWorld) return null;
    const candidates = [railY, roadY, terrainY].filter(Number.isFinite);
    if (candidates.length === 0) return requireEvidence ? null : 0;
    if (!Number.isFinite(walkerY)) {
        // No height context (rooftop queries, spawn probes): legacy priority.
        return [railY, roadY, terrainY].find(Number.isFinite);
    }
    const reachable = candidates.filter((candidate) => candidate <= walkerY + maxStepUpM);
    if (reachable.length > 0) {
        // The candidate NEAREST the walker, not the highest: a walker on the
        // street bed of a shallow cut must stand on the bed, not be popped up
        // onto the terrain lip a step above — while a walker on the hill over
        // a bore gets the hill, not the tube 30 m below.
        return reachable.reduce((best, candidate) => (
            Math.abs(candidate - walkerY) < Math.abs(best - walkerY) ? candidate : best
        ));
    }
    // Everything lies above the walker (a pit, a fall in progress): the lowest
    // candidate is the nearest world above; recovery logic decides what to do.
    return Math.min(...candidates);
}

// `y` is height above the *world* (not above the ground beneath). Lands on
// rooftops by reading getGroundY(x, z) every step and clamping. `vy` is
// vertical velocity. `airborne` is true when y is above the surface beneath.
export function createWalkState(lat, lon, options) {
    const initialY = Number(options && options.initialY);
    const initialVy = Number(options && options.initialVerticalVelocity);
    const initialGroundY = options?.initialGroundY == null
        ? Number.NaN
        : Number(options.initialGroundY);
    const groundY = Number.isFinite(initialGroundY) ? initialGroundY : 0;
    return {
        lat,
        lon,
        yaw: 0,
        y: Number.isFinite(initialY) ? initialY : groundY,
        vy: Number.isFinite(initialVy) ? initialVy : 0,
        // Fallback used only until the scene raycast finds a real floor. It
        // keeps an underground Vidi spawn stable without permanently pinning
        // the walker below ground after they climb or jetpack to the surface.
        initialGroundY: Number.isFinite(initialGroundY) ? initialGroundY : null,
        initialSupportLat: lat,
        initialSupportLon: lon,
        lastDetectedGroundY: Number.isFinite(initialGroundY) ? initialGroundY : null,
        spawnY: Number.isFinite(initialY) ? initialY : groundY,
        floorGuardActive: false,
        groundMissSeconds: 0,
        jetpackAllowed: options?.jetpackAllowed !== false,
        parachute: options?.parachute === true,
        airborne: Number.isFinite(initialY)
            ? initialY > groundY + GROUND_EPS_M
            : Number.isFinite(initialVy) && Math.abs(initialVy) > 0.001,
    };
}

// Hands the walker a canopy mid-air: they leave the aircraft at its height,
// already falling, and the next steps settle onto the parachute descent.
export function beginWalkParachute(ws, { lat, lon, y, yaw, initialVerticalVelocity = -2 } = {}) {
    if (!ws || ![lat, lon, y, yaw].every(Number.isFinite)) return false;
    Object.assign(ws, {
        lat, lon, y, yaw,
        vy: initialVerticalVelocity,
        airborne: true,
        parachute: true,
        initialGroundY: null,
        initialSupportLat: lat,
        initialSupportLon: lon,
        spawnY: y,
        floorGuardActive: false,
        groundMissSeconds: 0,
    });
    return true;
}

// Advances a walk state by dt seconds.
//   cameraLookYaw — the user's drag-to-look offset, added to ws.yaw so
//                   "forward" is where the camera is pointing.
//   getGroundY    — optional (localX, localZ, walkerY) → world-Y of the
//                   reachable support surface below the player. If not
//                   supplied, ground = the initial/street level.
//
// Returns a pose with horizontal lat/lon/heading PLUS y (height) and
// horizontalDistM (the metres of horizontal travel this step, for
// driving footstep audio).
export function stepWalk(ws, dt, cameraLookYaw, getGroundY, getLocalXZ, resolveMove) {
    if (walkKeys.has('a') || walkKeys.has('arrowleft'))  ws.yaw -= TURN_SPEED * dt;
    if (walkKeys.has('d') || walkKeys.has('arrowright')) ws.yaw += TURN_SPEED * dt;
    const fwd = (walkKeys.has('w') || walkKeys.has('arrowup'))   ?  1 :
                (walkKeys.has('s') || walkKeys.has('arrowdown')) ? -1 : 0;
    let horizontalDistM = 0;
    if (fwd !== 0) {
        const totalYaw = ws.yaw + cameraLookYaw;
        const fx = Math.sin(totalYaw);
        const fz = -Math.cos(totalYaw);
        const cosLat = Math.cos(ws.lat * DEG_TO_RAD);
        const canopyDrift = ws.parachute === true && ws.airborne;
        const stepM = (canopyDrift
            ? PARACHUTE_DRIFT_MPS
            : walkStepSpeedMps(baseWalkSpeedMps, isWalkSpeedBoostOn())) * dt;
        const fromLat = ws.lat;
        const fromLon = ws.lon;
        const toLat = fromLat + (-fz * fwd * stepM) / (EARTH_RADIUS_M * DEG_TO_RAD);
        const toLon = fromLon + ( fx * fwd * stepM) / (EARTH_RADIUS_M * DEG_TO_RAD * cosLat);
        // Walls are solid: the caller slides the move along whatever it hits.
        const moved = typeof resolveMove === 'function'
            ? resolveMove(fromLat, fromLon, toLat, toLon, ws.y)
            : null;
        ws.lat = moved && Number.isFinite(moved.lat) ? moved.lat : toLat;
        ws.lon = moved && Number.isFinite(moved.lon) ? moved.lon : toLon;
        horizontalDistM = haversineMeters(fromLat, fromLon, ws.lat, ws.lon);
    }

    // Vertical physics. groundY is the surface directly below the player —
    // the rooftop they're standing on, or 0 at street level. Re-evaluated
    // each step so walking off a rooftop edge starts the fall immediately.
    // The supplied spawn support is a local handoff aid, not a permanent
    // horizontal plane. Retire it after the first real scene sample, or as
    // soon as the walker leaves the spawn point. After that, a ray miss means
    // "no floor this frame" (apart from the very short seam grace below), so
    // negative scene Y remains valid and gravity can reach lower terrain.
    const initialSupportDistanceM = Number.isFinite(ws.initialSupportLat)
        && Number.isFinite(ws.initialSupportLon)
        ? haversineMeters(ws.initialSupportLat, ws.initialSupportLon, ws.lat, ws.lon)
        : Infinity;
    if (initialSupportDistanceM > WALK_INITIAL_SUPPORT_RADIUS_M) {
        ws.initialGroundY = null;
    }
    const canSampleGround = typeof getGroundY === 'function' && typeof getLocalXZ === 'function';
    let groundY = Number.isFinite(ws.initialGroundY)
        ? ws.initialGroundY
        : canSampleGround ? null : 0;
    if (canSampleGround) {
        const xz = getLocalXZ(ws.lat, ws.lon);
        let detectedGroundY = xz ? getGroundY(xz.x, xz.z, ws.y) : null;
        // Spawn rescue: before the FIRST contact of the session, a spawn that
        // landed below the streamed surface (photo registration offsets) can
        // never see ground with the short above-the-walker ray budget — probe
        // from high above and seat on the world's topmost support instead of
        // free-falling through the planet.
        if (!Number.isFinite(detectedGroundY)
            && !Number.isFinite(ws.lastDetectedGroundY)
            && xz) {
            detectedGroundY = getGroundY(xz.x, xz.z, ws.y + 500);
        }
        // Lost-support rescue: streamed tiles can REPLACE the surface that a
        // first contact stood on (coarse → refined), leaving the walker below
        // every mesh with nothing beneath — a sustained floorless fall that
        // the short upward ray budget can never recover from. Probe the sky
        // and seat back on top. A genuine interior (tunnel tube, station box,
        // underpass) always keeps a floor BELOW the walker, so ground gets
        // detected and this never fires there.
        if (!Number.isFinite(detectedGroundY)
            && ws.airborne
            && (ws.floorGuardActive
                || (ws.vy < -12 && (Number(ws.groundMissSeconds) || 0) > 1.2))
            && xz) {
            detectedGroundY = getGroundY(xz.x, xz.z, ws.y + 500);
        }
        if (!acceptsDetectedGroundAtSpawn(detectedGroundY, ws.initialGroundY)) {
            detectedGroundY = null;   // hold the spawn; the real floor is still building
        }
        if (Number.isFinite(detectedGroundY)) {
            groundY = detectedGroundY;
            ws.initialGroundY = null;
            ws.lastDetectedGroundY = detectedGroundY;
            ws.groundMissSeconds = 0;
            ws.floorGuardActive = false;
        } else {
            ws.groundMissSeconds = (Number(ws.groundMissSeconds) || 0) + dt;
            // A route node can sit exactly on the boundary between two
            // raycast triangles. Bridge only that momentary miss; a genuine
            // ledge still starts falling after a few frames.
            if (!ws.airborne
                && Number.isFinite(ws.lastDetectedGroundY)
                && ws.groundMissSeconds <= WALK_SUPPORT_SEAM_GRACE_S) {
                groundY = ws.lastDetectedGroundY;
            }
        }
    }
    // No scene floor sample yet THIS SESSION (a photo walk can start before
    // Google geometry streams at the spawn) and no spawn support supplied:
    // falling now would drop the walker through the planet. Hold altitude
    // until the first real sample lands; after that, normal physics owns
    // every ray miss (ledges must still fall).
    // Preserve the distinction between real support and the private altitude
    // hold below. The renderer uses it to hide a ground-relative avatar until
    // the terrain or authored structure it depends on has actually published.
    const supportReady = Number.isFinite(groundY);
    if (!supportReady && !Number.isFinite(ws.lastDetectedGroundY)) {
        groundY = ws.y;
    }
    const wasAirborne = ws.airborne;
    const parachuting = ws.parachute === true && wasAirborne;
    const jetpackHeld = ws.jetpackAllowed !== false && !parachuting && walkKeys.has(' ');
    const hasGround = Number.isFinite(groundY);
    let landed = false;
    let impactSpeedMps = 0;
    if (jetpackHeld) {
        ws.vy += JETPACK_ACCEL * dt;
        if (ws.vy > JETPACK_MAX_VY) ws.vy = JETPACK_MAX_VY;
        ws.y += ws.vy * dt;
        // Hard ceiling above the ground reference. Once hit, vy is clamped to
        // 0 so the player doesn't bounce or stall against a negative residual.
        if (hasGround && ws.y > groundY + jetpackMaxY) {
            ws.y = groundY + jetpackMaxY;
            if (ws.vy > 0) ws.vy = 0;
        }
        ws.airborne = !hasGround || ws.y > groundY + GROUND_EPS_M;
    } else {
        // Stay planted on descending stairs. At the deliberately brisk walk
        // speed one frame can cross more than one tread; gravity alone cannot
        // follow a 10 m / 16 m staircase quickly enough and made the walker
        // float into the hall before falling. Real ledges remain falls because
        // only a drop proportional to this frame's horizontal travel can snap.
        const maxStepDownM = Math.min(
            WALK_STEP_DOWN_MAX_M,
            Math.max(WALK_STEP_DOWN_MIN_M, horizontalDistM * WALK_STEP_DOWN_PER_HORIZONTAL_M),
        );
        const reachableStepDown = hasGround
            && !wasAirborne
            && ws.vy <= 0
            && ws.y >= groundY
            && ws.y - groundY <= maxStepDownM;
        if (reachableStepDown) {
            ws.y = groundY;
            ws.vy = 0;
            ws.airborne = false;
        } else {
            if (parachuting) {
                // The canopy settles the fall onto its descent rate from either
                // side: a faster fall is pulled back, a slower one accelerates.
                ws.vy = ws.vy < PARACHUTE_DESCENT_VY
                    ? Math.min(PARACHUTE_DESCENT_VY, ws.vy + PARACHUTE_OPEN_DECEL * dt)
                    : Math.max(PARACHUTE_DESCENT_VY, ws.vy - FALL_GRAVITY * dt);
            } else {
                ws.vy -= FALL_GRAVITY * dt;
                if (ws.vy < FALL_TERMINAL_VY) ws.vy = FALL_TERMINAL_VY;
            }
            const preClampVy = ws.vy;
            ws.y += ws.vy * dt;
            // ABSOLUTE floor guard: never fall further than 6 m below the
            // last support this session ever knew (last detected ground, the
            // supplied spawn support, or the spawn height itself) while NO
            // support sample exists at all. A missing tile is a HOLE, not a
            // cliff — a real ledge always has detected ground below and falls
            // normally. 6 m keeps the un-streamed dip barely noticeable
            // (80 m still READ as falling through the world); the sky probe
            // fires every frame in this state and reseats on first geometry.
            // A parachutist has no floor to guard: the descent continues until
            // a surface (the caller supplies the sea) is actually under them.
            if (!hasGround && !parachuting) {
                const guardBaseY = Number.isFinite(ws.lastDetectedGroundY)
                    ? ws.lastDetectedGroundY
                    : Number.isFinite(ws.initialGroundY)
                        ? ws.initialGroundY
                        : ws.spawnY;
                if (Number.isFinite(guardBaseY) && ws.y < guardBaseY - 6) {
                    ws.y = guardBaseY - 6;
                    ws.vy = 0;
                    ws.floorGuardActive = true;
                }
            }
            if (hasGround && ws.y <= groundY) {
                ws.y = groundY;
                ws.vy = 0;
                ws.airborne = false;
                // Detect the airborne→grounded transition; impact speed is
                // |vy| from the frame BEFORE we zeroed it, so the caller can
                // scale the thud volume with how hard you hit.
                if (wasAirborne) {
                    landed = true;
                    impactSpeedMps = Math.abs(preClampVy);
                }
                // The canopy is spent once the feet touch anything.
                ws.parachute = false;
            } else {
                ws.airborne = true;
            }
        }
    }

    return {
        lat: ws.lat,
        lon: ws.lon,
        headingDeg: ws.yaw * (180 / Math.PI),
        y: ws.y,
        airborne: ws.airborne,
        parachute: ws.parachute === true && ws.airborne,
        verticalSpeedMps: ws.airborne ? ws.vy : 0,
        jetpackHeld,
        horizontalDistM,
        landed,
        impactSpeedMps,
        supportReady,
    };
}

// Space joins the movement keys so the cab keyboard delegator routes it
// through onKeyDown/Up. Arrow + WASD remain unchanged.
export const WALK_MOVEMENT_KEYS = ['shift', 'w','a','s','d','arrowup','arrowdown','arrowleft','arrowright',' '];
