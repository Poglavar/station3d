// Cars cruising along OSM road centrelines, streamed per tile around the
// cab. A shared /roads source feeds the graph in chunks: junction nodes are
// snapped (lon, lat) → (x, z) coords, segments connect two nodes, and cars
// traverse a segment in a valid direction (respecting `oneway`) while picking
// a random non-U-turn outgoing segment at each junction.
//
// Each car is a small THREE.Group with chassis + cabin + 4 wheels +
// headlights + taillights. Headlights/taillights share materials with all
// other cars so night-mode toggle is one update call to flip them all.

import * as THREE from 'three';
import { DEG_TO_RAD, EARTH_RADIUS_M, finiteOrNull, geoToLocal } from '../core/math.js';
import { disposeGroup, registerShared, unregisterShared } from '../core/dispose.js';
import { getApiBase } from '../core/api.js';
import { choosePursuitExit, pursuitTopUp } from '../core/enemy-pursuit.js';
import { createFrameChunkQueue } from '../core/frame-chunk-queue.js';
import { createFixedStepAccumulator } from '../core/fixed-step.js';
import { createPointSpatialIndex } from '../core/point-spatial-index.js';
import { createTrafficGraphOwnership } from '../core/traffic-graph-ownership.js';
import { navigationMapContext } from '../core/navigation-map-context.js';
import { pointInsideKeepClear } from '../core/campaign-vehicle-policy.js';
import { trafficObstaclePopulation } from '../core/traffic-obstacle-population.js';
import { GTA_TRAFFIC_TUNING } from '../core/gta-config.js';
import {
    promotedTrafficRouteMayAdvance,
    trafficSpawnHasClearance,
} from '../core/gta-traffic-promotion.js';
import {
    SESSION_CAPABILITY,
    sessionCapabilityEnabled,
} from '../core/session-capabilities.js';
import { gtaTramPhysicsHeadingFromSceneYaw } from '../core/gta-ambient-trams.js';
import { chooseWeighted } from '../core/weighted-choice.js';
import {
    TRAFFIC_BODY_RIDE_LIFT_M,
    trafficVehicleDimensions,
    trafficVehicleVerticalLayout,
} from '../core/traffic-vehicle-profile.js';
import {
    PARKED_ROAD_VEHICLE_TYPES,
    ROAD_TRAFFIC_VEHICLE_TYPES,
} from '../models/vehicles/traffic-vehicle-catalog.js';
import { trafficRouteBaseSceneYAtLocal } from '../core/traffic-route-elevation.js';
import { recordLayerFrameMs } from '../scene/animate.js';
import {
    NEAR_ROAD_STREAM_OPTIONS,
    TILE_M,
} from '../core/tile-stream.js';
import { classifyViewPriority, tileLocalBounds } from '../core/view-priority.js';
import { scene, camera, getRenderQualityContext } from '../scene/setup.js';
import {
    disposeBicycleSessionCaches,
} from '../models/vehicles/bicycle.js';
import {
    createUnlockedAudioContext,
    getAudioDestination,
    resumeUnlockedAudioContext,
} from '../core/audio-unlock.js';
import { iterOtherTramMeshes } from '../vehicles/tram.js';
import { TRAM_HALF_LENGTH_M, TRAM_HALF_WIDTH_M, TRAM_FRONT_EXTENT_M, TRAM_REAR_EXTENT_M, TRAM_COLLISION_HALF_WIDTH_M } from '../models/vehicles/tram.js';
import * as cabVoice from '../ui/cab-voice.js';
import { playHonk } from '../ui/honk-sfx.js';
import { updateSirens, stopAllSirens } from '../ui/siren-sfx.js';
import {
    playEnemyShotSound, playBulletWhizForSegment, playPlayerBulletHitSound,
} from '../ui/combat-sfx.js';
import { getEnemyMusicTrackCount, queueEnemyMusicSpeaker } from '../ui/enemy-music.js';
import { getBuildingsGroup } from './buildings.js';
import { trafficSignalSpeedFactorAt } from './decor.js';
import { tryStampHole, findImpactPoint, resolveCachedLineOfSight } from './bullet-marks.js';
import { vehicleSweepIntersectsLoadedBuilding } from './courtyard-passages.js';
import { buildPlannerStationClearanceVolumes } from './planner-station-layout.js';
import {
    buildLowElevatedRampVolumes,
    buildTrackCorridorVolumes,
    isPlannerUndergroundRampSegment,
    isPointInsideCorridorFootprints,
    orientedFootprintIntersectsCorridors,
    PLANNER_OPEN_CUT_HALF_WIDTH_M,
} from './track-corridors.js';
import { getActiveRailTrafficSource } from './rails.js';
import { roadSurfaceSceneOffset } from './ground-surface-levels.js';
import { setRoadVehicleNightMode, preloadRoadFleetModels, buildTrafficVehicleMesh, updateTrafficVehicleLods, disposeRoadVehicleSessionCaches, getEnemyBulletGeometry, getEnemyBulletMaterial, getEnemyImpactGeometry, getEnemyImpactMaterial } from '../models/vehicles/road-vehicles.js';

function pickVehicleType() {
    return chooseWeighted(VEHICLE_TYPES, Math.random()) || VEHICLE_TYPES[0];
}

// Halved from 10 → 5: the old density read as too much traffic, and cars are a
// per-frame animated layer, so fewer of them is also a straight perf win.
const CARS_PER_TILE = 5;
function trafficDetailRadiusM() {
    // Five batched Blender parts nearby; one cheap silhouette beyond this
    // ring. Keep full geometry within 60 m even on High. Interaction and
    // driving retain their full range independently of the visible detail.
    const shadowDistance = Number(getRenderQualityContext().shadowCasterDistanceM) || 60;
    return Math.max(40, Math.min(60, shadowDistance));
}
// Ambient traffic does not need to run at the display refresh rate. A bounded
// 30 Hz simulation halves its recurring graph/spacing/ground-query cost on a
// 60 Hz display, and one permitted substep means a long frame can never demand
// several complete O(cars) catch-up passes in the next frame.
const TRAFFIC_STEP_HZ = 30;
const trafficFixedStep = createFixedStepAccumulator({
    stepSeconds: 1 / TRAFFIC_STEP_HZ,
    maxSubsteps: 1,
});
const TRAFFIC_OBSTACLE_GRID_CELL_M = 10;
const trafficObstacleIndex = createPointSpatialIndex(TRAFFIC_OBSTACLE_GRID_CELL_M);
const autopilotVehicleIndex = createPointSpatialIndex(TRAFFIC_OBSTACLE_GRID_CELL_M);
const autopilotTramIndex = createPointSpatialIndex(TRAFFIC_OBSTACLE_GRID_CELL_M);

// Cruise speed by OSM highway type, m/s.
const SPEED_BY_HIGHWAY = {
    motorway: 22, motorway_link: 18,
    trunk: 18, trunk_link: 14,
    primary: 14, primary_link: 12,
    secondary: 12, secondary_link: 11,
    tertiary: 11, tertiary_link: 10,
    residential: 8, unclassified: 8,
};
const DEFAULT_SPEED = 10;

// Highways we actually spawn cars on. `service` and `living_street` are
// excluded because they often route through parking aisles, building
// courtyards, and pedestrian-priority strips — cars on those visually
// "drive into buildings". Restricting the graph to public-traffic
// highways fixes most of those cases.
const DRIVABLE_HIGHWAYS = new Set(Object.keys(SPEED_BY_HIGHWAY));

const NODE_SNAP_M = 0.5;
const PROPOSAL_SPLICE_TOLERANCE_M = 8;
const PROPOSAL_SPLICE_MIN_SEGMENT_M = 1.5;

// ─── Bicycle-model car dynamics ─────────────────────────────────────────
// Cars are integrated as proper kinematic bicycles: the front wheels
// turn at a steering angle δ, and each frame the chassis curves with
// turning radius (wheelbase / tan δ) before advancing along its OWN
// heading at speed v. This replaces the previous parametric-on-segment
// position model where heading lerped independently from motion (and
// thus visibly slid sideways through corners). The car steers toward a
// pure-pursuit lookahead point on the road path; speed is capped by the
// curvature of the steer required, which slows cars naturally into
// corners. Position is integrated from velocity, NOT set from car.t.
const WHEELBASE_M           = 2.5;     // typical sedan
const MAX_STEER_RAD         = 0.55;    // ~31° — passenger-car steering lock
const MAX_LAT_ACCEL_MPS2    = 4.0;     // comfortable cornering ≈ 0.4 g
const ACCEL_LIMIT_MPS2      = 3.0;     // mild city accel
const DECEL_LIMIT_MPS2      = 6.0;     // brakes are ~2× more capable
const LOOKAHEAD_BASE_M      = 4.0;     // pure-pursuit aim distance at rest
const LOOKAHEAD_PER_SPEED_S = 0.45;    // grows with speed: faster cars look further

// Cars drive on the right (Croatia is RHT). LANE_OFFSET_M shifts each car
// off the centreline so two cars in opposite directions don't overlap, and
// so a single car doesn't visually clip street edges. When explicit lane
// metadata is available we derive per-lane centers instead; this remains the
// fallback single-lane offset for roads with no usable lane counts.
const LANE_OFFSET_M = 1.4;
const LANE_WIDTH_M = 3.5;

// Inter-car spacing on a single (segment, direction). When the gap to the
// car ahead drops below CAR_BUFFER_M + BRAKE_RAMP_M, this car ramps speed
// down linearly; below CAR_BUFFER_M it stops entirely. Stops cars from
// passing through each other on a shared segment. Wrecks count as
// stationary occupants of their final lane, so trailing cars brake for
// them too.
const CAR_BUFFER_M = 5.5;
const BRAKE_RAMP_M = 4.0;

// "Swerve around the wreck" maneuver. When a car detects a wreck ahead
// within SWERVE_DETECT_M on the same lane, it ramps a lateral offset
// (negative = into the oncoming lane, since LANE_OFFSET_M biases right)
// toward SWERVE_OFFSET_M at SWERVE_RATE_MPS m/s. Once the offset is
// wide enough (|offset| ≥ SWERVE_PASS_THRESHOLD), the car can creep past
// the wreck at SWERVE_PASS_FACTOR of normal speed instead of being held
// at zero by the spacing brake. After it drives past, the obstacle drops
// out of detection range and the offset decays back to 0 — the car
// rejoins its normal lane.
const SWERVE_DETECT_M       = 12;
const SWERVE_OFFSET_M       = -3.0;
const SWERVE_RATE_MPS       = 2.5;
const SWERVE_PASS_THRESHOLD = 2.0;
const SWERVE_PASS_FACTOR    = 0.35;
// Cars that have been stopped behind something for more than this long
// (and aren't currently swerving past it) despawn — keeps queues from
// growing unboundedly when many cars stack up behind a single wreck.
const STUCK_DESPAWN_S = 12;

// Cars treating TRAMS as swerve-around obstacles. Trams aren't on the
// car road graph (they ride rails), so detection is purely spatial:
// we project each tram's position into the car's forward frame and
// trigger swerve if it's roughly in the lane ahead.
const TRAM_OBSTACLE_AHEAD_M    = 14;     // forward distance to detect
// Tightened from 4.0 → 2.0 so a car in the adjacent lane (~3 m lateral
// from tram centre) doesn't see the tram as an obstacle. Only triggers
// when the tram is actually IN the car's lane / on a directly conflicting
// path. Tram halfW ≈ 1.4 m, so 2.0 = halfW + ~0.6 m of "this is in my
// lane" overlap.
const TRAM_OBSTACLE_LATERAL_M  = 2.0;
// Body-bubble pads: a car inside (tram body box + this much pad) swerves.
// Lateral pad is tiny — just enough to prevent actual contact. Cars are
// allowed to drive in the lane right next to the tram (Zagreb-typical
// shared-corridor traffic), they only swerve when about to scrape.
// Longitudinal pad stays generous (12 m) to catch the "tram catching me
// up from behind in MY lane" case before contact.
const TRAM_BUBBLE_LATERAL_PAD_M = 0.3;
const TRAM_BUBBLE_LONG_PAD_M    = 12;

// Tram-pushes-cars collision. When a tram's body box overlaps a car or
// wreck, the car is shoved sideways at TRAM_PUSH_SPEED_MPS perpendicular
// to the tram's heading. If it wasn't already a wreck, it becomes one
// and a crash sound plays. Live cars that get shoved are immediately
// converted to wrecks so the chassis can drift off the rails freely.
const TRAM_PUSH_SPEED_MPS      = 7.0;
// Vertical separation above which the tram and a car can't physically touch —
// so a tram in a tunnel (deep below) or on a viaduct (above) no longer "hits"
// cars on the road surface it passes under/over. Comfortably clears the ~3.5 m
// tram + ~1.5 m car heights while staying well under any tunnel/viaduct gap.
const TRAM_CAR_VERTICAL_CLEARANCE_M = 3.0;
const TRAM_COLLISION_PAD_M     = 0.6;    // extra clearance around tram box
const TRAM_CRASH_COOLDOWN_S    = 0.5;    // per-tram debounce on crash sound
// Audible range for the thud + screech. Lowered from 280 → 90 m so a
// collision happening across town doesn't blast a faint thud in the
// player's cab — we only hear what's close enough to feel real.
const TRAM_CRASH_AUDIBLE_M     = 90;

// Bezier corner-fillet radius. Within FILLET_M of each junction (the last
// stretch of the current segment AND the first stretch of the next), the
// car's path is blended through a quadratic Bezier with the junction as
// the control point. The car curves smoothly into the next segment instead
// of snapping along the centreline. Bigger = wider, lazier turns.
const FILLET_M = 4.5;

// Shoulder ratio for the chassis — controls the height at which the body
// starts tapering toward the top. With smooth shading on the shouldered
// frustum the hood and trunk slopes read as curves rather than as one
// hard trapezoid. Low value keeps the sharp bottom edge near the wheels.
const CHASSIS_SHOULDER_RATIO = 0.25;

// At a true dead-end (junction whose only outgoing edge is the segment we
// arrived on), the car despawns instead of U-turning. Together with
// LANE_OFFSET_M's right-side bias this also kills the "ping-pong on a
// short stub" symptom — there's no traversable next edge so we don't loop.

const WHEEL_RADIUS = 0.32;
const WHEEL_WIDTH  = 0.20;

const CAR_COLORS = [
    0xc0c0c0, 0xeaeaea, 0x202024, 0x801818,
    0x143868, 0x205028, 0x804018, 0x607080,
    0xa86018, 0x504050, 0x68181c, 0x182838,
];

// Vehicle-type variants. Front of car = local +Z. cabinZ is the cabin's Z
// offset relative to chassis centre — negative shifts the cabin toward the
// rear (sedan look), positive toward the front (truck has cab over engine).
// `weight` controls the spawn distribution: most traffic is compacts/sedans.
//
// Taper parameters (chassisTop*, cabinTop*, *Slant) drive the
// makeTaperedBox helper so volumes aren't perfect cuboids:
//   * chassisTopLen <1 → hood + trunk slope down toward bumpers
//   * cabinTopLen <1 + opposite-sign cabinFrontSlant / cabinRearSlant →
//     windshield slants back, rear window slants forward
//   * cabinTopWidth <1 → roof tapers narrower than belt line
// Chassis/cabin ratios match real cars: the chassis (waist + door panels +
// hood + trunk) is the bulkier portion, the cabin (greenhouse: window
// glass + thin roof frame) sits as a smaller volume on top. Window panels
// fill nearly the whole cabin, with the cabin BOTTOM acting as the belt
// line (where windows meet the body).
//
// Front-vs-rear asymmetry:
//   * cabinZ shifts the cabin along the vehicle's length. Negative pulls
//     the cabin backward, leaving more chassis exposed in front (= longer
//     hood, the typical sedan profile).
//   * chassisFrontSlant / chassisRearSlant push the chassis TOP corners
//     forward at each end. Positive front slant → top-front edge sits
//     further forward → gentler/longer hood slope. Positive rear slant →
//     top-rear edge sits further forward → steeper, shorter trunk slope.
/* Vehicle geometry metadata lives in core/traffic-vehicle-catalog.js. */
const VEHICLE_TYPES = ROAD_TRAFFIC_VEHICLE_TYPES;
const PARKED_VEHICLE_TYPES = PARKED_ROAD_VEHICLE_TYPES;
let carsGroup = null;
let carsSessionGeneration = 0;
let tileSource = null;
let tileSubscription = null;
let anchorLat = 0, anchorLon = 0;
let terrainReference = null;
let roadFormationModel = null;
let onPlayerTramDamage = null;
let playerTramSpeedKmh = 0;
let trafficBuildFocusX = 0;
let trafficBuildFocusZ = 0;
let trafficBuildHeadingDeg = Number.NaN;
let trafficBuildFovDeg = 90;
let plannerOpenCutVolumes = [];
let parkedRailCorridorVolumes = [];
let parkedRailCorridorRevision = -1;
let parkedRailRejectCount = 0;
const tileGraphJobs = new Map();
const trafficRoadReadinessWaiters = new Set();
const graphBuildQueue = createFrameChunkQueue({
    label: 'cars',
    frameBudgetMs: 4,
    workClass: 'simulation',
});
let baseRoadGraphPrimed = false;

// Global road graph + car pool. Every OSM source way is reference-counted by
// the tiles that delivered it. The final owner may retire it only after active
// cars release their segment references; retired slots are recycled so a
// country-scale drive remains bounded instead of retaining every crossed road.
const globalGraph = { segments: [], nodes: new Map() };
const loadedOsmIds = new Set();
// osm_id → array of segIdx in globalGraph.segments. Lets a re-fetched tile
// spawn fresh cars on already-loaded ways without duplicating graph data.
const osmIdToSegIndices = new Map();
const freeSegmentIndices = [];
const globalCars = [];
const parkedCars = new Map();
// Local-metre circles an authored scene reserves: ambient traffic never spawns
// inside one, so a set piece cannot open with a stopped truck across its exit.
let trafficKeepClearVolumes = [];
const parkedCarTiles = new Map();
let parkedFormationRevision = -1;
let parkedTerrainRevision = -1;
let parkedReseatQueue = [];
const parkedReseatQueuedIds = new Set();
const PARKED_FORMATION_CHANGE_PAD_M = 15;
const MAX_PARKED_CARS = 120;
const MAX_GRAPH_SEGMENT_SLOTS = 100000;
const MAX_WRECKED_CARS = 48;
const WRECK_TTL_S = 90;
let graphCapacityHits = 0;
let nextTrafficCarId = 1;

const trafficGraphOwnership = createTrafficGraphOwnership({
    isRetained: trafficSourceIsRetained,
    onRetire: retireTrafficSource,
});
// Proposal roads can resolve before the deferred cars layer begins its
// session, or before the first base-road batch has populated the graph.
// Queue them until the session exists AND the base graph has been primed,
// then append/spawn once proposal vertices can splice into nearby roads.
let pendingProposalRoadCenterlines = [];

function terrainEvidenceYAtLocal(x, z) {
    if (!terrainReference) return 0;
    const terrainY = terrainReference.evidenceSceneYAtLocal?.(x, z);
    return typeof terrainY === 'number' && Number.isFinite(terrainY)
        ? terrainY
        : null;
}

function terrainHeightAtLocal(x, z, segment = null, highwayType = null) {
    const terrainY = terrainEvidenceYAtLocal(x, z);
    let baseY;
    if (segment) {
        // The canonical route owns vehicle grade even where DGU terrain is
        // missing (coast) or another formation is horizontally nearer
        // (crossings). Proposal graph ids and formation ids are intentionally
        // separate, so resolve the latter from the segment.
        baseY = trafficRouteBaseSceneYAtLocal({
            x,
            z,
            segment,
            roadFormation: roadFormationModel,
            terrainSceneY: terrainY,
        });
    } else {
        if (terrainY === null) return null;
        const formationY = roadFormationModel
            ? finiteOrNull(roadFormationModel.sceneYAtLocal(
                x,
                z,
                { maxDistanceM: 20, allowStale: true },
            ))
            : null;
        baseY = formationY ?? terrainY;
    }
    if (baseY === null) return null;
    // Vehicle meshes are rooted at the tyre contact plane. When their owning
    // road is known, seat that plane on the same semantic surface level the
    // asphalt renderer uses instead of on the formation underneath it.
    return baseY + (highwayType ? roadSurfaceSceneOffset(highwayType) : 0);
}

function placeCarOnTerrain(car) {
    if (!car || !car.mesh) return false;
    const roadSegment = globalGraph.segments[car.segIdx] || null;
    const roadType = roadSegment?.highway ?? null;
    const y = terrainHeightAtLocal(car.x, car.z, roadSegment, roadType);
    if (y === null) {
        car.terrainReady = false;
        car.mesh.visible = false;
        return false;
    }
    car.mesh.position.set(car.x, y, car.z);
    car.mesh.rotation.order = 'YXZ';
    car.mesh.rotation.y = car.heading;
    car.mesh.rotation.z = 0;
    if (!terrainReference) {
        car.mesh.rotation.x = 0;
        car.terrainReady = true;
        car.mesh.visible = true;
        return true;
    }
    const halfSampleM = 4;
    const forwardX = Math.sin(car.heading);
    const forwardZ = Math.cos(car.heading);
    const behindY = terrainHeightAtLocal(
        car.x - forwardX * halfSampleM,
        car.z - forwardZ * halfSampleM,
        roadSegment,
        roadType,
    );
    const aheadY = terrainHeightAtLocal(
        car.x + forwardX * halfSampleM,
        car.z + forwardZ * halfSampleM,
        roadSegment,
        roadType,
    );
    if (behindY === null || aheadY === null) {
        car.terrainReady = false;
        car.mesh.visible = false;
        return false;
    }
    // Car meshes face local +Z; Three's positive X rotation lowers +Z, hence
    // the minus sign for a nose-up climb.
    car.mesh.rotation.x = -Math.atan2(aheadY - behindY, halfSampleM * 2);
    car.terrainReady = true;
    car.mesh.visible = true;
    return true;
}

function trafficRenderPose(mesh) {
    return {
        x: mesh.position.x,
        y: mesh.position.y,
        z: mesh.position.z,
        pitch: mesh.rotation.x,
        yaw: mesh.rotation.y,
        roll: mesh.rotation.z,
    };
}

function lerpWrappedAngle(from, to, alpha) {
    const tau = Math.PI * 2;
    const delta = ((to - from + Math.PI) % tau + tau) % tau - Math.PI;
    return from + delta * alpha;
}

// Keep rendering smooth even though ambient route simulation is fixed at
// 30 Hz. The previous/current transforms are complete terrain-seated poses, so
// interpolation itself does no formation queries and adds only a few scalars
// per visible car. Rapier-promoted traffic is excluded: GTA owns those meshes.
function beginTrafficRenderStep() {
    for (const car of globalCars) {
        if (!car?.mesh || car.physicsControlled) continue;
        car.trafficRenderFrom = car.trafficRenderTo || trafficRenderPose(car.mesh);
    }
}

function finishTrafficRenderStep() {
    for (const car of globalCars) {
        if (!car?.mesh || car.physicsControlled) continue;
        car.trafficRenderTo = trafficRenderPose(car.mesh);
        if (!car.trafficRenderFrom) car.trafficRenderFrom = car.trafficRenderTo;
    }
}

function interpolateTrafficRenderPoses(alpha) {
    const t = Math.max(0, Math.min(1, Number(alpha) || 0));
    for (const car of globalCars) {
        if (!car?.mesh || car.physicsControlled) continue;
        const from = car.trafficRenderFrom;
        const to = car.trafficRenderTo;
        if (!from || !to) continue;
        car.mesh.position.set(
            from.x + (to.x - from.x) * t,
            from.y + (to.y - from.y) * t,
            from.z + (to.z - from.z) * t,
        );
        car.mesh.rotation.set(
            lerpWrappedAngle(from.pitch, to.pitch, t),
            lerpWrappedAngle(from.yaw, to.yaw, t),
            lerpWrappedAngle(from.roll, to.roll, t),
            'YXZ',
        );
    }
}

function spawnAuthoredParkedCars(spawns) {
    for (const spawn of spawns || []) {
        const id = String(spawn?.id || '').trim();
        const lat = Number(spawn?.lat);
        const lon = Number(spawn?.lon);
        if (!id || !Number.isFinite(lat) || !Number.isFinite(lon) || parkedCars.has(id)) continue;
        const typeName = String(spawn.type || 'sedan').trim().toLowerCase();
        const type = PARKED_VEHICLE_TYPES.find(candidate => candidate.name === typeName)
            || PARKED_VEHICLE_TYPES.find(candidate => candidate.name === 'sedan')
            || PARKED_VEHICLE_TYPES[0];
        if (!type) continue;
        const local = geoToLocal(lon, lat, anchorLon, anchorLat);
        const headingDeg = Number(spawn.headingDeg);
        const heading = Number.isFinite(headingDeg)
            ? Math.PI - headingDeg * DEG_TO_RAD
            : (Number(spawn.heading) || 0);
        const bodyHex = finiteOrNull(spawn.color) != null
            ? finiteOrNull(spawn.color)
            : CAR_COLORS[stableHash(id) % CAR_COLORS.length];
        const mesh = buildTrafficVehicleMesh(type, bodyHex);
        carsGroup.add(mesh);
        const car = {
            id,
            authored: true,
            parked: true,
            available: true,
            controlled: false,
            destroyed: false,
            abandoned: false,
            segIdx: null,
            x: local.x,
            z: local.z,
            heading,
            type,
            bodyHex,
            mesh,
            // Authored ownership survives road-tile eviction and a control
            // release; the entire record still tears down with the session.
            tileOwners: new Set([`authored:${id}`]),
        };
        placeCarOnTerrain(car);
        parkedCars.set(id, car);
    }
}

// A campaign retry puts the authored fleet back on its marks: every authored
// spawn is rebuilt fresh at its pose, undamaged, whether the old car was
// driven away, wrecked or is still parked. Cars the player still controls are
// left alone; the session releases them before asking for a reset.
export function resetAuthoredParkedCars(spawns) {
    const requested = (spawns || []).filter(spawn => String(spawn?.id || '').trim());
    if (requested.length === 0) return true;
    if (!carsGroup) return false;
    for (const spawn of requested) {
        const id = String(spawn.id).trim();
        const car = parkedCars.get(id);
        if (!car || car.controlled) continue;
        removeParkedCar(car);
        const wreckIndex = wreckedCars.indexOf(car);
        if (wreckIndex >= 0) wreckedCars.splice(wreckIndex, 1);
    }
    spawnAuthoredParkedCars(requested);
    return requested.every(spawn => parkedCars.has(String(spawn.id).trim()));
}

// In-place campaign handoffs do not restart the cars layer. Reassert the
// target scene's authored fleet at the handoff boundary so a delayed/partial
// initial layer build cannot leave the player with only ambient parked cars.
export function ensureAuthoredParkedCars(spawns) {
    const requested = (spawns || []).filter(spawn => String(spawn?.id || '').trim());
    if (requested.length === 0) return true;
    if (!carsGroup) return false;
    spawnAuthoredParkedCars(requested);
    return requested.every(spawn => parkedCars.has(String(spawn.id).trim()));
}

function queueParkedCarsForFormationRevision(localX, localZ) {
    const revision = Number(roadFormationModel?.revision) || 0;
    const terrainRevision = Number(terrainReference?.revision) || 0;
    if (revision === parkedFormationRevision
        && terrainRevision === parkedTerrainRevision) return;
    const changes = parkedFormationRevision >= 0
        && revision !== parkedFormationRevision
        && typeof roadFormationModel?.getChangesSince === 'function'
        ? roadFormationModel.getChangesSince(parkedFormationRevision)
        : null;
    parkedFormationRevision = revision;
    parkedTerrainRevision = terrainRevision;
    const x = Number(localX) || 0;
    const z = Number(localZ) || 0;
    const nearestFirst = [...parkedCars.values()]
        .filter(car => !car.controlled)
        .filter((car) => {
            if (!changes || changes.full) return true;
            return changes.bounds.some(bounds => (
                car.x >= bounds.minX - PARKED_FORMATION_CHANGE_PAD_M
                && car.x <= bounds.maxX + PARKED_FORMATION_CHANGE_PAD_M
                && car.z >= bounds.minZ - PARKED_FORMATION_CHANGE_PAD_M
                && car.z <= bounds.maxZ + PARKED_FORMATION_CHANGE_PAD_M
            ));
        })
        .sort((left, right) => (
            (left.x - x) ** 2 + (left.z - z) ** 2
                - ((right.x - x) ** 2 + (right.z - z) ** 2)
        ));
    for (const car of nearestFirst) {
        if (parkedReseatQueuedIds.has(car.id)) continue;
        parkedReseatQueuedIds.add(car.id);
        parkedReseatQueue.push(car.id);
    }
}

function drainParkedCarReseats(maxCars = 10) {
    let remaining = Math.max(0, Math.floor(Number(maxCars) || 0));
    while (remaining > 0 && parkedReseatQueue.length > 0) {
        remaining -= 1;
        const id = parkedReseatQueue.shift();
        parkedReseatQueuedIds.delete(id);
        const car = parkedCars.get(id);
        if (!car || car.controlled) continue;
        // Graph tiles can arrive before the road-formation tile describing the
        // same OSM way. Re-seat from the latest shared profile so a car spawned
        // on raw terrain cannot remain buried after the asphalt is published.
        placeCarOnTerrain(car);
    }
}

// How far past the camera (in metres) a car can be before despawning.
// Loose enough that cars stay visible in the fog distance band.
const DESPAWN_DISTANCE_M = 600;
// Hard ceiling on simultaneous cars. Combined with distance-based
// despawning this self-regulates around ~80–120 in practice.
const MAX_TOTAL_CARS = 160;

function carReferencesSegment(car, segIdx) {
    return car && [car.segIdx, car.prevSegIdx, car.nextSegIdx].includes(segIdx);
}

function trafficSourceIsRetained(osmId) {
    const indices = osmIdToSegIndices.get(osmId) || [];
    for (const segIdx of indices) {
        if (globalCars.some(car => carReferencesSegment(car, segIdx))) return true;
        if (wreckedCars.some(car => carReferencesSegment(car, segIdx))) return true;
        for (const car of parkedCars.values()) {
            if (car.controlled && carReferencesSegment(car, segIdx)) return true;
        }
    }
    return false;
}

function removeEmptyGraphNode(key) {
    const node = globalGraph.nodes.get(key);
    if (node && (!Array.isArray(node.out) || node.out.length === 0)) {
        globalGraph.nodes.delete(key);
    }
}

function retireTrafficSource(osmId) {
    const indices = osmIdToSegIndices.get(osmId) || [];
    for (const segIdx of indices) {
        const seg = globalGraph.segments[segIdx];
        if (!seg) continue;
        removeOutgoing(seg.startKey, segIdx, true);
        removeOutgoing(seg.endKey, segIdx, false);
        removeEmptyGraphNode(seg.startKey);
        removeEmptyGraphNode(seg.endKey);
        globalGraph.segments[segIdx] = null;
        freeSegmentIndices.push(segIdx);
    }
    osmIdToSegIndices.delete(osmId);
    loadedOsmIds.delete(osmId);
}

function stableHash(value) {
    let hash = 2166136261;
    const text = String(value);
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function removeParkedCar(car) {
    if (!car) return;
    if (car.mesh?.parent) car.mesh.parent.remove(car.mesh);
    disposeCarRuntimeResources(car);
    parkedCars.delete(car.id);
}

function releaseParkedCarsForTile(tileKey) {
    const ids = parkedCarTiles.get(tileKey);
    if (!ids) return;
    parkedCarTiles.delete(tileKey);
    for (const id of ids) {
        const car = parkedCars.get(id);
        if (!car) continue;
        car.tileOwners.delete(tileKey);
        if (car.tileOwners.size === 0 && !car.controlled && !car.abandoned) {
            removeParkedCar(car);
        }
    }
}

const GTA_AMBIENT_TRAM_RAILWAYS = new Set(['tram', 'light_rail']);

function isAffirmativeOsmTag(value) {
    return value === true || value === 1 || ['yes', 'true', '1'].includes(
        String(value ?? '').trim().toLowerCase(),
    );
}

function isGtaAmbientTramFeature(feature) {
    const properties = feature?.properties || {};
    const railway = String(
        properties.railway_type
        ?? properties.railway
        ?? properties.tags?.railway
        ?? '',
    ).trim().toLowerCase();
    return GTA_AMBIENT_TRAM_RAILWAYS.has(railway);
}

function isGroundLevelTramSegment({ properties, startElevationM, endElevationM }) {
    const tags = properties?.tags || {};
    if (isAffirmativeOsmTag(properties?.tunnel ?? tags.tunnel)
        || isAffirmativeOsmTag(properties?.bridge ?? tags.bridge)) return false;
    const layer = Number(properties?.layer ?? tags.layer);
    if (Number.isFinite(layer) && Math.abs(layer) >= 1) return false;
    const start = finiteOrNull(startElevationM);
    const end = finiteOrNull(endElevationM);
    if (start !== null && end !== null
        && Math.max(Math.abs(start), Math.abs(end)) > 1.25) return false;
    return true;
}

function buildParkedRailCorridors(features) {
    return buildTrackCorridorVolumes(
        (features || []).filter(isGtaAmbientTramFeature),
        anchorLat,
        anchorLon,
        {
            // This is the moving tram body sweep, not merely the visible rail
            // gauge. The parked vehicle's own OBB is added by the intersection
            // test below, so the two real footprints cannot overlap.
            halfWidth: TRAM_COLLISION_HALF_WIDTH_M + 0.25,
            endPad: Math.max(
                TRAM_HALF_LENGTH_M,
                TRAM_FRONT_EXTENT_M,
                TRAM_REAR_EXTENT_M,
            ) + 0.5,
            elevatedRightExtension: 0,
            segmentFilter: isGroundLevelTramSegment,
        },
    );
}

function parkedVehicleIntersectsTramSweep(car) {
    if (!car) return false;
    const dimensions = trafficVehicleDimensions(car.type);
    return orientedFootprintIntersectsCorridors({
        centerX: car.x,
        centerZ: car.z,
        heading: car.heading,
        widthM: dimensions.widthM,
        lengthM: dimensions.lengthM,
        clearanceM: 0.35,
        volumes: parkedRailCorridorVolumes,
    });
}

function removeParkedCarFromTileOwnership(car) {
    for (const tileKey of car?.tileOwners || []) {
        const ids = parkedCarTiles.get(tileKey);
        if (!ids) continue;
        ids.delete(car.id);
        if (ids.size === 0) parkedCarTiles.delete(tileKey);
    }
    removeParkedCar(car);
}

function refreshParkedRailCorridors() {
    if (!parkedVehiclesEnabled) return;
    const source = getActiveRailTrafficSource();
    const revision = Number(source?.revision) || 0;
    if (revision === parkedRailCorridorRevision) return;
    parkedRailCorridorRevision = revision;
    parkedRailCorridorVolumes = buildParkedRailCorridors(source?.features || []);
    for (const car of [...parkedCars.values()]) {
        if (car.authored || car.controlled || !parkedVehicleIntersectsTramSweep(car)) continue;
        parkedRailRejectCount += 1;
        removeParkedCarFromTileOwnership(car);
    }
}

function spawnParkedCarsForSegments(tileKey, segIndices) {
    if (!parkedVehiclesEnabled || !carsGroup || parkedCars.size >= MAX_PARKED_CARS) return;
    let tileIds = parkedCarTiles.get(tileKey);
    if (!tileIds) {
        tileIds = new Set();
        parkedCarTiles.set(tileKey, tileIds);
    }
    for (const segIdx of expandActiveSegIndices(segIndices)) {
        if (parkedCars.size >= MAX_PARKED_CARS) break;
        const seg = globalGraph.segments[segIdx];
        if (!seg || seg.retired || seg.length < 18) continue;
        if (!['residential', 'unclassified', 'tertiary'].includes(seg.highway)) continue;
        const seed = stableHash(`${seg.osmId}:${seg.chordIndex}`);
        if (seed % 7 !== 0) continue;
        const side = (seed & 1) === 0 ? 1 : -1;
        const id = `osm:${seg.osmId}:parked:${seg.chordIndex}:${side}`;
        let car = parkedCars.get(id);
        if (!car) {
            const forwardX = seg.dx / seg.length;
            const forwardZ = seg.dz / seg.length;
            const rightX = -forwardZ;
            const rightZ = forwardX;
            const t = 0.28 + ((seed >>> 8) % 44) / 100;
            const outerLane = Math.max(
                ...(seg.laneCentersForward || [LANE_OFFSET_M]).map(Math.abs),
                ...(seg.laneCentersBackward || [LANE_OFFSET_M]).map(Math.abs),
            );
            // Parked vehicles use the complete motor fleet, so vans and trucks
            // can be entered without turning moving bicycles into parked cars.
            const type = chooseWeighted(
                PARKED_VEHICLE_TYPES,
                (seed >>> 4) / 0x10000000,
            );
            const offset = side * (outerLane + 2.1);
            const x = seg.x0 + seg.dx * t + rightX * offset;
            const z = seg.z0 + seg.dz * t + rightZ * offset;
            if (pointInsideKeepClear(x, z, trafficKeepClearVolumes)) continue;
            const heading = Math.atan2(forwardX, forwardZ);
            if (parkedVehicleIntersectsTramSweep({ x, z, heading, type })) {
                parkedRailRejectCount += 1;
                continue;
            }
            const color = CAR_COLORS[(seed >>> 12) % CAR_COLORS.length];
            const mesh = buildTrafficVehicleMesh(type, color);
            carsGroup.add(mesh);
            car = {
                id,
                parked: true,
                available: true,
                controlled: false,
                destroyed: false,
                abandoned: false,
                segIdx,
                x,
                z,
                heading,
                type,
                bodyHex: color,
                mesh,
                tileOwners: new Set(),
            };
            placeCarOnTerrain(car);
            parkedCars.set(id, car);
        }
        car.tileOwners.add(tileKey);
        tileIds.add(id);
    }
}

// Reach is measured from the BODY, not the centre. A flat radius from the centre
// meant a longer vehicle was harder to walk up to than a short one, and on a
// 4.5 m sedan the 3.2 m default ran out about a metre past the bumper: standing
// beside the campaign's getaway car at a natural 3.6 m offered no prompt at all,
// so the story's "the dark car is ours" read as scenery. Boats and aircraft
// already carry their own, larger enterDistanceM for the same reason.
function parkedCarBodyReachM(car) {
    const length = Number(car?.type?.length);
    const width = Number(car?.type?.width);
    if (!Number.isFinite(length) || !Number.isFinite(width)) return 0;
    return Math.hypot(length, width) / 2;
}

export function findEnterableParkedCar(localX, localZ, radiusM = 3.2, options = {}) {
    const allowedIds = options.allowedIds instanceof Set ? options.allowedIds : null;
    let best = null;
    let bestDistanceSq = Infinity;
    for (const car of parkedCars.values()) {
        if (allowedIds && !allowedIds.has(String(car.id))) continue;
        if (!car.available || car.controlled || car.destroyed || car.terrainReady === false) continue;
        if (!car.authored && parkedVehicleIntersectsTramSweep(car)) continue;
        const reach = radiusM + parkedCarBodyReachM(car);
        const dx = car.x - localX;
        const dz = car.z - localZ;
        const distanceSq = dx * dx + dz * dz;
        if (distanceSq > reach * reach || distanceSq >= bestDistanceSq) continue;
        best = car;
        bestDistanceSq = distanceSq;
    }
    return best ? { ...best, distanceM: Math.sqrt(bestDistanceSq) } : null;
}

export function claimParkedCar(id) {
    const car = parkedCars.get(id);
    if (!car || !car.available || car.controlled || car.destroyed
        || car.terrainReady === false) return null;
    car.controlled = true;
    car.available = false;
    return car;
}

export function syncControlledParkedCar(id, { x, y, z, heading, quaternion } = {}) {
    const car = parkedCars.get(id);
    if (!car || !car.controlled) return false;
    const nextX = Number(x);
    const nextY = Number(y);
    const nextZ = Number(z);
    const nextHeading = Number(heading);
    if (Number.isFinite(nextX)) car.x = nextX;
    if (Number.isFinite(nextZ)) car.z = nextZ;
    if (Number.isFinite(nextHeading)) car.heading = nextHeading;
    car.mesh.position.set(
        car.x,
        Number.isFinite(nextY) ? nextY : car.mesh.position.y,
        car.z,
    );
    if (quaternion) car.mesh.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
    else car.mesh.rotation.set(0, car.heading, 0);
    return true;
}

const campaignAttachmentLocal = new THREE.Vector3();

export function campaignVehicleAttachmentPose(id, offset = {}, out = {}) {
    const car = parkedCars.get(String(id || ''));
    if (!car?.mesh || car.terrainReady === false) return null;
    car.mesh.updateMatrixWorld(true);
    campaignAttachmentLocal.set(
        finiteOrNull(offset.x) ?? 0,
        finiteOrNull(offset.y) ?? 0,
        finiteOrNull(offset.z) ?? 0,
    );
    car.mesh.localToWorld(campaignAttachmentLocal);
    out.x = campaignAttachmentLocal.x;
    out.y = campaignAttachmentLocal.y;
    out.z = campaignAttachmentLocal.z;
    out.heading = car.heading;
    return out;
}

export function releaseControlledParkedCar(id, pose = {}) {
    const car = parkedCars.get(id);
    if (!car || !car.controlled) return false;
    const poseX = finiteOrNull(pose.x);
    const poseZ = finiteOrNull(pose.z);
    if (poseX !== null && poseZ !== null) {
        syncControlledParkedCar(id, pose);
    }
    car.controlled = false;
    car.available = !car.destroyed;
    car.abandoned = car.tileOwners.size === 0;
    placeCarOnTerrain(car);
    return true;
}

export function getTrafficWorldDebugState() {
    return {
        graphSlots: globalGraph.segments.length,
        activeGraphSegments: globalGraph.segments.reduce((count, segment) => count + (segment ? 1 : 0), 0),
        graphNodes: globalGraph.nodes.size,
        graphCapacityHits,
        movingCars: globalCars.length,
        parkedCars: parkedCars.size,
        parkedFormationRevision,
        pendingParkedReseats: parkedReseatQueue.length,
        wreckedCars: wreckedCars.length,
        parkedRailCorridors: parkedRailCorridorVolumes.length,
        parkedRailCorridorRevision,
        parkedRailRejectCount,
        ...trafficGraphOwnership.snapshot(),
    };
}

export function getTrafficObstaclesNear(localX, localZ, radiusM = 120, excludeId = null) {
    const radiusSq = Math.max(0, Number(radiusM) || 0) ** 2;
    const obstacles = [];
    const append = (car, state) => {
        if (!car || car.id === excludeId || car.controlled || !car.mesh
            || car.terrainReady === false) return;
        const x = Number(car.x ?? car.mesh.position.x);
        const z = Number(car.z ?? car.mesh.position.z);
        if (!Number.isFinite(x) || !Number.isFinite(z)) return;
        const dx = x - localX;
        const dz = z - localZ;
        if (dx * dx + dz * dz > radiusSq) return;
        const dimensions = trafficVehicleDimensions(car.type);
        obstacles.push({
            id: String(car.id ?? `${state}:${car.segIdx}:${car.t}`),
            kind: 'vehicle',
            state,
            x,
            y: Number(car.mesh.position.y) || 0,
            z,
            heading: Number(car.heading) || 0,
            speedMps: Math.max(0, Number(car.speed) || 0),
            physicsControlled: !!car.physicsControlled,
            ...dimensions,
        });
    };
    for (const car of globalCars) append(car, 'moving');
    for (const car of wreckedCars) append(car, 'wrecked');
    for (const car of parkedCars.values()) append(car, car.abandoned ? 'abandoned' : 'parked');
    for (const mesh of iterOtherTramMeshes(true)) {
        const id = String(mesh?.userData?.tramId || '');
        if (!id || id === excludeId) continue;
        const x = Number(mesh.position.x);
        const z = Number(mesh.position.z);
        if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
        const dx = x - localX;
        const dz = z - localZ;
        if (dx * dx + dz * dz > radiusSq) continue;
        obstacles.push({
            id,
            kind: 'vehicle',
            state: mesh.userData.wreckedTram ? 'rail-wrecked' : 'rail-moving',
            x,
            y: Number(mesh.position.y) || 0,
            z,
            heading: gtaTramPhysicsHeadingFromSceneYaw(mesh.rotation.y),
            speedMps: mesh.userData.wreckedTram
                ? 0 : Math.max(0, Number(mesh.userData.speedMps) || 0),
            physicsControlled: false,
            widthM: 2 * (Number(mesh.userData.tramHalfWidthM) || TRAM_HALF_WIDTH_M),
            lengthM: (Number(mesh.userData.tramFrontExtentM) || TRAM_FRONT_EXTENT_M)
                + (Number(mesh.userData.tramRearExtentM) || TRAM_REAR_EXTENT_M),
            heightM: 3.4,
        });
    }
    return obstacles;
}

// GTA owns the rigid body while an ambient moving car is inside its local
// physics bubble. The traffic layer keeps owning the car identity, route
// progress and render mesh; this handoff only pauses publication of the
// kinematic bicycle pose. Keeping one owner for each concern avoids the two
// copies visibly fighting after a collision or a streamed-tile rebuild.
export function claimTrafficCarForPhysics(id) {
    const car = globalCars.find(candidate => candidate.id === id);
    if (!car || car.physicsControlled || car.terrainReady === false) return null;
    car.physicsControlled = true;
    car.trafficRenderFrom = null;
    car.trafficRenderTo = null;
    car.physicsRouteEnded = false;
    car.physicsRouteTarget = {
        x: car.x,
        z: car.z,
        heading: car.heading,
        speedMps: Math.max(0, Number(car.speed) || 0),
    };
    car.stuckSince = null;
    return {
        id: car.id,
        x: car.x,
        y: Number(car.mesh?.position.y) || 0,
        z: car.z,
        heading: car.heading,
        speedMps: Math.max(0, Number(car.speed) || 0),
        ...trafficVehicleDimensions(car.type),
    };
}

export function getPromotedTrafficTarget(id) {
    const car = globalCars.find(candidate => candidate.id === id && candidate.physicsControlled);
    if (!car) return null;
    const target = car.physicsRouteTarget || car;
    const segment = globalGraph.segments[car.segIdx] || null;
    const y = terrainHeightAtLocal(
        Number(target.x) || 0,
        Number(target.z) || 0,
        segment,
        segment?.highway ?? null,
    );
    if (y === null) return null;
    return {
        id: car.id,
        x: Number(target.x) || 0,
        y,
        z: Number(target.z) || 0,
        heading: Number(target.heading) || 0,
        speedMps: car.physicsRouteEnded ? 0 : Math.max(0, Number(target.speedMps) || 0),
    };
}

export function syncPromotedTrafficCar(id, {
    x,
    y,
    z,
    heading,
    speedMps,
    quaternion,
    meshX,
    meshY,
    meshZ,
} = {}) {
    const car = globalCars.find(candidate => candidate.id === id && candidate.physicsControlled);
    if (!car) return false;
    const nextX = finiteOrNull(x);
    const nextY = finiteOrNull(y);
    const nextZ = finiteOrNull(z);
    const nextHeading = finiteOrNull(heading);
    const nextSpeed = finiteOrNull(speedMps);
    if (nextX !== null) car.x = nextX;
    if (nextZ !== null) car.z = nextZ;
    if (nextHeading !== null) car.heading = nextHeading;
    if (nextSpeed !== null) car.speed = Math.max(0, nextSpeed);
    const visualX = finiteOrNull(meshX) ?? car.x;
    const visualY = finiteOrNull(meshY) ?? nextY ?? car.mesh.position.y;
    const visualZ = finiteOrNull(meshZ) ?? car.z;
    car.mesh.position.set(visualX, visualY, visualZ);
    if (quaternion && [quaternion.x, quaternion.y, quaternion.z, quaternion.w]
        .every(Number.isFinite)) {
        car.mesh.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
    } else {
        car.mesh.rotation.set(0, car.heading, 0);
    }
    updateCarHealthBarVisibility(car);
    return true;
}

function projectCarProgressOntoCurrentSegment(car) {
    const segment = globalGraph.segments[car?.segIdx];
    if (!segment || segment.length <= 0) return;
    const lengthSq = segment.dx * segment.dx + segment.dz * segment.dz;
    if (lengthSq <= 1e-9) return;
    car.t = Math.max(0, Math.min(1, (
        (car.x - segment.x0) * segment.dx + (car.z - segment.z0) * segment.dz
    ) / lengthSq));
    car.prevSegIdx = null;
    car.prevForward = null;
    pickAndCacheNext(car, globalGraph);
}

export function releaseTrafficCarFromPhysics(id, pose = {}) {
    const car = globalCars.find(candidate => candidate.id === id && candidate.physicsControlled);
    if (!car) return false;
    syncPromotedTrafficCar(id, pose);
    car.physicsControlled = false;
    car.trafficRenderFrom = null;
    car.trafficRenderTo = null;
    car.physicsRouteTarget = null;
    car.physicsRouteEnded = false;
    car.stuckSince = null;
    projectCarProgressOntoCurrentSegment(car);
    placeCarOnTerrain(car);
    return true;
}

// Infrequent recovery query used only when the player explicitly presses R.
// Keeping it here lets the reset use the same live, tile-owned road graph and
// road-formation height as ambient traffic instead of inventing a second road
// index in the GTA mode.
export function findNearestTrafficRoadPose(localX, localZ, radiusM = 160) {
    const x = Number(localX);
    const z = Number(localZ);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const radiusSq = Math.max(0, Number(radiusM) || 0) ** 2;
    let nearest = null;
    let nearestDistanceSq = radiusSq;
    for (const segment of globalGraph.segments) {
        if (!segment || segment.retired || !(segment.length > 0)) continue;
        const lengthSq = segment.dx * segment.dx + segment.dz * segment.dz;
        const t = lengthSq > 1e-9
            ? Math.max(0, Math.min(1,
                ((x - segment.x0) * segment.dx + (z - segment.z0) * segment.dz) / lengthSq,
            ))
            : 0;
        const roadX = segment.x0 + segment.dx * t;
        const roadZ = segment.z0 + segment.dz * t;
        const distanceSq = (roadX - x) ** 2 + (roadZ - z) ** 2;
        if (distanceSq > nearestDistanceSq) continue;
        const y = terrainHeightAtLocal(roadX, roadZ, segment, segment.highway);
        if (y === null) continue;
        nearestDistanceSq = distanceSq;
        nearest = {
            x: roadX,
            y,
            z: roadZ,
            heading: Math.atan2(segment.dx, segment.dz),
            osmId: segment.osmId,
            distanceM: Math.sqrt(distanceSq),
        };
    }
    return nearest;
}

// ─── Bullet hit-test + persistent bullet holes + wreck mechanic ──────────
// The weapon system calls these to score damage on cars, stamp visible
// holes that move with the car, and trigger wreck transformation when a
// car runs out of health.

const CAR_BODY_CENTER_Y = 0.7 + TRAFFIC_BODY_RIDE_LIFT_M; // approx middle of the body in y
const BULLET_DAMAGE = 10;
const CAR_HEALTH_BY_TYPE = {
    compact: 50,
    sedan: 60,
    suv: 80,
    van: 90,
    truck: 130,
    bus: 180,
    bicycle: 15,
    cargo_bicycle: 25,
    ambulance: 90,
    police: 80,
    technical: 100,
};
const TRAM_COLLISION_DAMAGE_BY_TYPE = {
    compact: 4,
    sedan: 5,
    suv: 7,
    van: 8,
    truck: 12,
    bus: 16,
    bicycle: 2,
    cargo_bicycle: 3,
    ambulance: 8,
    police: 7,
    technical: 9,
};
const HEALTH_BAR_CANVAS_W = 128;
const HEALTH_BAR_CANVAS_H = 24;
const HEALTH_BAR_WIDTH_M = 3.0;
const HEALTH_BAR_HEIGHT_M = 0.36;
const HEALTH_BAR_VISIBLE_RADIUS_M = 240;
const ENEMY_SPAWN_DENOM = 18;
const MAX_ENEMY_VEHICLES = 9;
// How much further than the best exit still counts as "toward the player", so a
// wave fans out across parallel streets instead of queueing nose-to-tail.
const PURSUIT_SPREAD_M = 45;
// The authored chase currently running, or null in free roam. Only an encounter
// declared here hunts and reinforces; free-roam hostiles keep their own rules.
let activePursuit = null;
const ENEMY_FIRE_RANGE_M = 165;
const ENEMY_FIRE_MIN_RANGE_M = 16;
const ENEMY_BURST_MIN = 3;
const ENEMY_BURST_MAX = 5;
const ENEMY_BURST_CADENCE_S = 0.15;
const ENEMY_BURST_COOLDOWN_MIN_S = 1.2;
const ENEMY_BURST_COOLDOWN_MAX_S = 2.4;
const ENEMY_BULLET_SPEED_MPS = 92;
const ENEMY_BULLET_LIFETIME_S = 2.0;
const ENEMY_BULLET_DAMAGE = 3;
const ENEMY_AIM_SPREAD_BASE_M = 1.7;
const ENEMY_AIM_SPREAD_PER_M = 0.012;
const ENEMY_LOS_CACHE_MAX_AGE_S = 0.16;
const ENEMY_LOS_CACHE_SHOOTER_MOVE_M = 1.2;
const ENEMY_LOS_CACHE_TARGET_MOVE_M = 1.2;
const ENEMY_MUZZLE_FLASH_LIFETIME_S = 0.07;
const ENEMY_IMPACT_SPARKS = 5;
const ENEMY_IMPACT_LIFETIME_S = 0.34;
const ENEMY_IMPACT_SPEED_MPS = 3.2;
const wreckedCars = [];               // tracked separately so endSession can clean them up

// Smoke from wrecks. Each wreck emits a slow stream of grey particles
// that rise, drift, scale up, and fade. Capped globally so a row of
// wrecks doesn't tank the framerate.
const SMOKE_SPAWN_INTERVAL_S = 0.40;
const SMOKE_LIFETIME_S = 3.5;
const SMOKE_VISIBLE_RADIUS_M = 300;
const MAX_SMOKE_PARTICLES = 220;
let smokeGroup = null;
let smokeGeometry = null;
let smokeMaterialTemplate = null;
const liveSmoke = [];

// Fire flashes: short-lived bright orange spheres for impact bursts and
// occasional flare-ups on wrecks. Geometry + material template are shared;
// each particle clones the material so opacity / emissive can fade
// independently. Lives in the same smokeGroup so disposal is one place.
const FIRE_LIFETIME_S = 0.40;
const MAX_FIRE_PARTICLES = 80;
let fireGeometry = null;
let fireMaterialTemplate = null;
const liveFire = [];
let enemyProjectilesGroup = null;
const liveEnemyBullets = [];
const liveEnemyImpacts = [];
let isGameModeFn = () => false;
// Enemy cars already in the world keep driving and firing under isGameModeFn,
// including the pursuers a campaign encounter spawns deliberately. This second
// predicate governs only whether the world may invent NEW hostiles of its own,
// which an authored encounter must not have happening around it.
let ambientHostilesFn = () => false;
// In walk mode the camera is a person, not a tram cab — adding a "player
// tram box" derived from the camera position would let the walking player
// plough through cars. Set true via ctx.isWalkMode in beginSession.
let isWalkModeFn = () => false;
let parkedVehiclesEnabled = false;
let suppressTrafficWreckDressing = false;

let bulletHoleGeometry = null;
let bulletHoleMaterial = null;
function getBulletHoleGeometry() {
    if (!bulletHoleGeometry) {
        bulletHoleGeometry = new THREE.CircleGeometry(0.07, 10);
        registerShared(bulletHoleGeometry);
    }
    return bulletHoleGeometry;
}
function getBulletHoleMaterial() {
    if (!bulletHoleMaterial) {
        bulletHoleMaterial = new THREE.MeshStandardMaterial({
            color: 0x080808,
            roughness: 1.0,
            metalness: 0.0,
            side: THREE.DoubleSide,
            polygonOffset: true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits: -2,
        });
        registerShared(bulletHoleMaterial);
    }
    return bulletHoleMaterial;
}

function maxHealthForCarType(type) {
    return CAR_HEALTH_BY_TYPE[type && type.name] || 60;
}

function ensureCarHealth(car) {
    if (!car) return;
    if (!Number.isFinite(car.maxHealth) || car.maxHealth <= 0) {
        car.maxHealth = maxHealthForCarType(car.type);
    }
    if (!Number.isFinite(car.health)) {
        car.health = car.maxHealth;
    }
}

function drawCarHealthBar(car) {
    if (!car || !car.healthBar) return;
    const bar = car.healthBar;
    const ctx = bar.ctx;
    const ratio = Math.max(0, Math.min(1, car.health / car.maxHealth));

    ctx.clearRect(0, 0, HEALTH_BAR_CANVAS_W, HEALTH_BAR_CANVAS_H);
    ctx.fillStyle = 'rgba(15,23,42,0.84)';
    ctx.fillRect(0, 0, HEALTH_BAR_CANVAS_W, HEALTH_BAR_CANVAS_H);
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, HEALTH_BAR_CANVAS_W - 2, HEALTH_BAR_CANVAS_H - 2);
    ctx.fillStyle = ratio <= 0.25 ? '#ef4444' : ratio <= 0.55 ? '#f59e0b' : '#22c55e';
    ctx.fillRect(4, 4, Math.max(0, (HEALTH_BAR_CANVAS_W - 8) * ratio), HEALTH_BAR_CANVAS_H - 8);

    bar.texture.needsUpdate = true;
}

function ensureCarHealthBar(car) {
    if (!car || car.healthBar) return;
    const canvas = document.createElement('canvas');
    canvas.width = HEALTH_BAR_CANVAS_W;
    canvas.height = HEALTH_BAR_CANVAS_H;
    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    const height = car.type
        ? trafficVehicleVerticalLayout(car.type, WHEEL_RADIUS).roofY + 0.65
        : WHEEL_RADIUS + TRAFFIC_BODY_RIDE_LIFT_M + 1.4 + 0.65;
    sprite.position.set(0, height, 0);
    sprite.scale.set(HEALTH_BAR_WIDTH_M, HEALTH_BAR_HEIGHT_M, 1);
    sprite.renderOrder = 20;
    sprite.raycast = () => {};
    car.mesh.add(sprite);
    car.healthBar = {
        canvas,
        ctx: canvas.getContext('2d'),
        texture,
        material,
        sprite,
    };
}

function updateCarHealthBar(car) {
    ensureCarHealth(car);
    if (!car || car.wrecked || car.health >= car.maxHealth) {
        disposeCarHealthBar(car);
        return;
    }
    ensureCarHealthBar(car);
    drawCarHealthBar(car);
    updateCarHealthBarVisibility(car);
}

function updateCarHealthBarVisibility(car) {
    if (!car || !car.healthBar || !camera) return;
    const dx = car.mesh.position.x - camera.position.x;
    const dy = car.mesh.position.y - camera.position.y;
    const dz = car.mesh.position.z - camera.position.z;
    const visibleR2 = HEALTH_BAR_VISIBLE_RADIUS_M * HEALTH_BAR_VISIBLE_RADIUS_M;
    car.healthBar.sprite.visible = (dx * dx + dy * dy + dz * dz) <= visibleR2;
}

function disposeCarHealthBar(car) {
    if (!car || !car.healthBar) return;
    const { sprite, material, texture } = car.healthBar;
    if (sprite && sprite.parent) sprite.parent.remove(sprite);
    if (material) material.dispose();
    if (texture) texture.dispose();
    car.healthBar = null;
}

function disposeCarRuntimeResources(car) {
    if (!car || !car.mesh) return;
    disposeCarHealthBar(car);
    // Cached fleet resources are registered as shared and are skipped here.
    // Everything else hanging from one vehicle (livery decal geometry,
    // flashing cap materials, wreck doors) is instance-owned and must be
    // released both on tile eviction and on session teardown.
    disposeGroup(car.mesh);
    car.mesh.userData.lightbarCaps = null;
}

// Distance in metres from the cab camera to a car's body. Used to pass
// positional info to cab-voice so distant taunts come out quieter and
// muffled instead of dry-close like the speaker is in the cab.
function distanceToCamera(car) {
    if (!car || !car.mesh || !camera) return 0;
    const dx = car.mesh.position.x - camera.position.x;
    const dy = (car.mesh.position.y + CAR_BODY_CENTER_Y) - camera.position.y;
    const dz = car.mesh.position.z - camera.position.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Returns the nearest car whose body sphere contains the world point, or
// null. `hitRadius` lets the caller dilate the bounding sphere to fit
// gameplay feel.
export function tryCarHit(worldX, worldY, worldZ, hitRadius) {
    const r2 = hitRadius * hitRadius;
    let best = null;
    let bestD2 = r2;
    const testCar = (car) => {
        if (car?.terrainReady === false) return;
        const dx = car.mesh.position.x - worldX;
        const dy = (car.mesh.position.y + CAR_BODY_CENTER_Y) - worldY;
        const dz = car.mesh.position.z - worldZ;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; best = car; }
    };
    for (const car of globalCars) testCar(car);
    for (const wreck of wreckedCars) testCar(wreck);
    return best;
}

// Number of cars wrecked BY THE PLAYER since session start (bullets or
// the player's own tram running them down). Wrecks caused by other
// trams plowing through don't count toward the player's tally — only
// the cab driver's own kills show up in the HUD's counter.
let _playerWreckCount = 0;
export function getWreckedCarCount() {
    return _playerWreckCount;
}

// Shared AudioContext for every synthesised SFX in this module (currently
// just the tram-plows-car crash sound). The recorded car-horn samples have
// their own context inside ui/honk-sfx.js.
let _carsAudioCtx = null;
function ensureAudioCtx() {
    if (_carsAudioCtx) return _carsAudioCtx;
    _carsAudioCtx = createUnlockedAudioContext();
    return _carsAudioCtx;
}

// ─── Honk-in-protest sound (per-car, when shot but not wrecked) ──────────
// Uses recorded horn samples from ui/honk-sfx.js. Per-call gain encodes
// distance attenuation; per-car playbackRate jitter so different cars
// sound subtly different even when the random pick lands on the same file.

const HONK_COOLDOWN_S = 0.8;     // each car honks at most this often
const HONK_AUDIBLE_M = 220;      // attenuates to 0 past this distance
const HONK_PEAK_GAIN = 0.55;     // master scale for the recorded horn

function playCarHonk(car) {
    const nowS = performance.now() / 1000;
    if (car.lastHonkAt != null && (nowS - car.lastHonkAt) < HONK_COOLDOWN_S) return;
    car.lastHonkAt = nowS;

    // Per-car pitch jitter, stable for a given car's lifetime, so a single
    // car honking twice sounds the same but two adjacent cars don't.
    if (!car.honkPitch) car.honkPitch = 0.92 + Math.random() * 0.16;

    const dx = car.mesh.position.x - camera.position.x;
    const dy = car.mesh.position.y - camera.position.y;
    const dz = car.mesh.position.z - camera.position.z;
    const distM = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const attenuation = Math.max(0, 1 - distM / HONK_AUDIBLE_M);
    if (attenuation <= 0.02) return;

    playHonk({
        gain: HONK_PEAK_GAIN * attenuation,
        playbackRate: car.honkPitch,
    });
}

// Synthesised "tram plows car" effect: a low thud (square wave with a
// fast pitch drop and short envelope) layered with a band-pass-filtered
// noise burst that sweeps upward and lingers — reads as metal screech
// followed by a heavy thump.
function playTramCarCrash(worldX, worldZ) {
    const ctx = ensureAudioCtx();
    if (!ctx) return;
    resumeUnlockedAudioContext(ctx);

    const dx = worldX - camera.position.x;
    const dz = worldZ - camera.position.z;
    const distM = Math.sqrt(dx * dx + dz * dz);
    const attenuation = Math.max(0, 1 - distM / TRAM_CRASH_AUDIBLE_M);
    if (attenuation <= 0.02) return;

    const t = ctx.currentTime;

    // Thud — square wave dropping from 130 Hz to 50 Hz over 90 ms.
    const thud = ctx.createOscillator();
    thud.type = 'square';
    thud.frequency.setValueAtTime(130, t);
    thud.frequency.exponentialRampToValueAtTime(50, t + 0.09);
    const thudGain = ctx.createGain();
    thudGain.gain.setValueAtTime(0.42 * attenuation, t);
    thudGain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    thud.connect(thudGain).connect(getAudioDestination(ctx));
    thud.start(t);
    thud.stop(t + 0.20);

    // Screech — a 0.55 s noise buffer through a band-pass that sweeps
    // from 800 Hz upward. Sustains for the duration so it overlaps the
    // thud's tail and reads as scraped metal.
    const dur = 0.55;
    const bufLen = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) {
        // Slow envelope swell-then-fall so the screech doesn't pop.
        const k = i / bufLen;
        const env = Math.min(k / 0.08, 1) * (1 - k);
        data[i] = (Math.random() * 2 - 1) * env;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 6.0;
    bp.frequency.setValueAtTime(900, t);
    bp.frequency.exponentialRampToValueAtTime(2400, t + dur);
    const screechGain = ctx.createGain();
    screechGain.gain.setValueAtTime(0.32 * attenuation, t);
    screechGain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    noise.connect(bp).connect(screechGain).connect(getAudioDestination(ctx));
    noise.start(t);
}

function getPoseSpeedKmh(pose) {
    const speed = pose && pose.status && Number(pose.status.speedKmh);
    return Number.isFinite(speed) ? speed : 0;
}

function notifyPlayerTramCollisionDamage(target, isWreck) {
    if (typeof onPlayerTramDamage !== 'function') return;
    const typeName = target && target.type && target.type.name;
    const base = TRAM_COLLISION_DAMAGE_BY_TYPE[typeName] || 6;
    const speedFactor = playerTramSpeedKmh > 1
        ? Math.max(0.35, Math.min(2.0, playerTramSpeedKmh / 45))
        : 0.35;
    const wreckFactor = isWreck ? 0.35 : 1;
    const damage = Math.max(1, Math.round(base * speedFactor * wreckFactor));
    onPlayerTramDamage(damage, {
        source: 'tram-car-collision',
        vehicleType: typeName || 'car',
        wreck: !!isWreck,
    });
}

// ─── Tram presence: collision boxes built once per frame ─────────────────
// We build a snapshot of every visible tram's world-space body box at the
// start of updateGlobalCars and reuse it for both the cars-treat-trams
// swerve detection and the trams-plow-cars collision pass.
const _tramBoxes = [];
export function computePlayerTramCollisionBox(pose, local) {
    if (!pose || !local || !Number.isFinite(local.x) || !Number.isFinite(local.z)) return null;
    const headingRad = (Number(pose.headingDeg) || 0) * Math.PI / 180;
    return {
        x: local.x,
        z: local.z,
        y: Number.isFinite(pose.tramSceneY) ? pose.tramSceneY : null,   // trackbed scene-Y for the altitude gate
        sin: Math.sin(headingRad),
        cos: Math.cos(headingRad),
        halfL: TRAM_HALF_LENGTH_M,
        halfW: TRAM_HALF_WIDTH_M,
        frontM: TRAM_FRONT_EXTENT_M,
        rearM: TRAM_REAR_EXTENT_M,
        collisionHalfW: TRAM_COLLISION_HALF_WIDTH_M,
        isPlayer: true,
    };
}

function refreshTramBoxes(pose, local) {
    let tramBoxCount = 0;
    // Other (autopilot) trams. Tagged with the back-reference to the
    // tram-sim trip object so applyAutopilotTramStalls() can toggle
    // `tripRef._physicsWall.obstacleStall` when a car or wreck sits
    // in their forward cone — they brake / wait instead of plowing
    // through. Player tram (added below) is not stalled and is the
    // only one allowed to actually wreck cars on contact.
    for (const mesh of iterOtherTramMeshes(true)) {
        const headingRad = -mesh.rotation.y;
        const box = _tramBoxes[tramBoxCount] || {};
        _tramBoxes[tramBoxCount] = box;
        tramBoxCount += 1;
        box.x = mesh.position.x;
        box.z = mesh.position.z;
        box.y = null;
        box.sin = Math.sin(headingRad);
        box.cos = Math.cos(headingRad);
        box.halfL = TRAM_HALF_LENGTH_M;
        box.halfW = TRAM_HALF_WIDTH_M;
        box.frontM = Number(mesh.userData.tramFrontExtentM) || TRAM_FRONT_EXTENT_M;
        box.rearM = Number(mesh.userData.tramRearExtentM) || TRAM_REAR_EXTENT_M;
        box.collisionHalfW = Number(mesh.userData.tramHalfWidthM)
            || TRAM_COLLISION_HALF_WIDTH_M;
        box.lastCrashAt = mesh.userData.lastTramCrashAt || 0;
        box.tripRef = mesh.userData.tripRef || null;
        box.mesh = mesh;
        box.isPlayer = false;
    }
    // Player tram collision follows the authoritative pose/local coordinates,
    // not camera direction. Orbiting into third-person changes where the
    // camera looks, but must never rotate or displace the collision body.
    if (!isWalkModeFn()) {
        const headingRad = (Number(pose?.headingDeg) || 0) * Math.PI / 180;
        if (Number.isFinite(local?.x) && Number.isFinite(local?.z)) {
            const box = _tramBoxes[tramBoxCount] || {};
            _tramBoxes[tramBoxCount] = box;
            tramBoxCount += 1;
            box.x = local.x;
            box.z = local.z;
            box.y = Number.isFinite(pose?.tramSceneY) ? pose.tramSceneY : null;
            box.sin = Math.sin(headingRad);
            box.cos = Math.cos(headingRad);
            box.halfL = TRAM_HALF_LENGTH_M;
            box.halfW = TRAM_HALF_WIDTH_M;
            box.frontM = TRAM_FRONT_EXTENT_M;
            box.rearM = TRAM_REAR_EXTENT_M;
            box.collisionHalfW = TRAM_COLLISION_HALF_WIDTH_M;
            box.isPlayer = true;
            box.lastCrashAt = _playerTramLastCrashAt;
            box.tripRef = null;
            box.mesh = null;
        }
    }
    _tramBoxes.length = tramBoxCount;
}
let _playerTramLastCrashAt = 0;

// Apply tram-vs-(car or wreck) physics — ONLY for the player's tram.
// Other trams treat cars as obstacles and brake (see
// applyAutopilotTramStalls below), so they never push or wreck a
// chassis. On overlap with the player tram: shove the chassis
// perpendicular to the tram's heading (away from the centreline),
// wreck if not already, and fire the crash sound (rate-limited).
function applyTramCollisions(dt) {
    if (_tramBoxes.length === 0) return;
    const nowS = performance.now() / 1000;
    const pushStep = TRAM_PUSH_SPEED_MPS * dt;

    const test = (target, isWreck) => {
        if (target?.terrainReady === false) return;
        let overlappedThisFrame = false;
        for (const t of _tramBoxes) {
            if (!t.isPlayer) continue;     // autopilot trams don't plow
            const dx = target.mesh.position.x - t.x;
            const dz = target.mesh.position.z - t.z;
            // World → tram-local.
            const lx = dx * t.cos + dz * t.sin;
            const lz = -dx * t.sin + dz * t.cos;
            const halfW = t.halfW + TRAM_COLLISION_PAD_M;
            const halfL = t.halfL + TRAM_COLLISION_PAD_M;
            if (Math.abs(lx) >= halfW || Math.abs(lz) >= halfL) continue;
            // Altitude gate: a car a tunnel below or a viaduct above the tram
            // overlaps in plan but can't be touched — don't wreck it.
            if (t.y != null && Math.abs((target.mesh.position.y || 0) - t.y) > TRAM_CAR_VERTICAL_CLEARANCE_M) continue;
            overlappedThisFrame = true;

            // Push direction: perpendicular to tram heading, on the
            // side the car is currently on (so it gets ejected away,
            // not pulled across the tracks).
            const sign = lx >= 0 ? 1 : -1;
            // tram-local +X direction in world coords:
            const wxDir = sign * t.cos;
            const wzDir = sign * (-t.sin);
            // Push the bicycle-model state, not just the mesh — otherwise
            // the next frame's integration from car.x/car.z would erase
            // the shove.
            const oldX = target.x != null ? target.x : target.mesh.position.x;
            const oldZ = target.z != null ? target.z : target.mesh.position.z;
            const nextX = oldX + wxDir * pushStep;
            const nextZ = oldZ + wzDir * pushStep;
            const targetHalfWidth = Math.max(0.4, (target.type?.width || 1.8) * 0.5);
            const targetHalfLength = Math.max(1.2, (target.type?.length || 4.5) * 0.5);
            const tBuild0 = performance.now();
            const blockedByBuilding = vehicleSweepIntersectsLoadedBuilding(
                oldX,
                oldZ,
                nextX,
                nextZ,
                Number(target.heading) || 0,
                targetHalfWidth,
                targetHalfLength,
            );
            recordLayerFrameMs('coll:buildingSweep', performance.now() - tBuild0);
            if (!blockedByBuilding) {
                if (target.x != null) target.x = nextX;
                if (target.z != null) target.z = nextZ;
                target.mesh.position.x = nextX;
                target.mesh.position.z = nextZ;
            }

            // Crash sound fires only on contact START (this frame the
            // target overlaps the tram, last frame it didn't). Without
            // this, dragging a wreck under the tram fires "thud" every
            // TRAM_CRASH_COOLDOWN_S as long as the wreck stays in the
            // box — what the user heard as a looping crash.
            if (!isWreck) {
                const tW0 = performance.now();
                wreckCar(target, /* byPlayer */ true);
                const tW1 = performance.now();
                notifyPlayerTramCollisionDamage(target, false);
                const tW2 = performance.now();
                playTramCarCrash(target.mesh.position.x, target.mesh.position.z);
                recordLayerFrameMs('coll:wreckCar', tW1 - tW0);
                recordLayerFrameMs('coll:damage', tW2 - tW1);
                recordLayerFrameMs('coll:crashSound', performance.now() - tW2);
                _playerTramLastCrashAt = nowS;
            } else if (!target.tramContactActive) {
                const tW1 = performance.now();
                notifyPlayerTramCollisionDamage(target, true);
                const tW2 = performance.now();
                playTramCarCrash(target.mesh.position.x, target.mesh.position.z);
                recordLayerFrameMs('coll:damage', tW2 - tW1);
                recordLayerFrameMs('coll:crashSound', performance.now() - tW2);
                _playerTramLastCrashAt = nowS;
            }
            target.tramContactActive = true;
            // One push per car per frame is enough — early-out so we
            // don't double-shove from two overlapping trams.
            return;
        }
        // No overlap with any player tram this frame — clear flag so a
        // future re-bump retriggers the crash sound.
        if (!overlappedThisFrame) target.tramContactActive = false;
    };

    // Iterate a snapshot of globalCars because wreckCar() splices it.
    const liveSnapshot = globalCars.slice();
    // Instrumented separately: this function cost 250-290 ms in one frame and the
    // wreck path it triggers measured as free, so the cost is in one of these two
    // sweeps. The populations are reported because both are O(n × tramBoxes) and
    // wrecks are never removed from wreckedCars.
    const tLive0 = performance.now();
    for (const car of liveSnapshot) test(car, false);
    const tLive1 = performance.now();
    recordLayerFrameMs('coll:live', tLive1 - tLive0);
    for (const wreck of wreckedCars) test(wreck, true);
    recordLayerFrameMs('coll:wrecks', performance.now() - tLive1);
    recordLayerFrameMs(
        `coll:n=${liveSnapshot.length}/${wreckedCars.length}/${_tramBoxes.length}`,
        0.001,
    );
}

// For each autopilot tram (i.e. one with a tripRef), check whether any
// car or wreck sits in its forward cone — if so, raise the trip's
// `obstacleStall` flag so tram-sim's stepPhysics brakes the tram and
// holds it in place until the path is clear. The player tram is never
// stalled this way; it plows through (see applyTramCollisions).
const TRAM_STALL_AHEAD_M    = 12;     // detect cars within this forward distance
const TRAM_STALL_LATERAL_M  = 2.0;    // lateral half-width of the cone (≈ tram width)
const TRAM_TRAM_GAP_M = 1.4;
const TRAM_TRAM_LATERAL_PAD_M = 0.25;
const _tramBoundsScratch = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
const TRAM_CORNER_SIGNS = Object.freeze([
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
]);
function projectTramBoxIntoLocal(ref, other, out) {
    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (const [lateralSign, longitudinalSign] of TRAM_CORNER_SIGNS) {
        const lxOther = lateralSign * other.collisionHalfW;
        const lzOther = longitudinalSign < 0 ? -other.frontM : other.rearM;
        const dxWorld = lxOther * other.cos - lzOther * other.sin;
        const dzWorld = lxOther * other.sin + lzOther * other.cos;
        const dx = other.x + dxWorld - ref.x;
        const dz = other.z + dzWorld - ref.z;
        const lx = dx * ref.cos + dz * ref.sin;
        const lz = -dx * ref.sin + dz * ref.cos;
        if (lx < minX) minX = lx;
        if (lx > maxX) maxX = lx;
        if (lz < minZ) minZ = lz;
        if (lz > maxZ) maxZ = lz;
    }
    out.minX = minX;
    out.maxX = maxX;
    out.minZ = minZ;
    out.maxZ = maxZ;
    return out;
}
function applyAutopilotTramStalls() {
    if (_tramBoxes.length === 0) return;
    autopilotVehicleIndex.clear();
    for (const car of globalCars) {
        if (car.terrainReady === false) continue;
        autopilotVehicleIndex.add(car, car.mesh?.position.x, car.mesh?.position.z);
    }
    for (const wreck of wreckedCars) {
        autopilotVehicleIndex.add(wreck, wreck.mesh?.position.x, wreck.mesh?.position.z);
    }
    autopilotTramIndex.clear();
    let maxTramExtentM = 0;
    for (const tram of _tramBoxes) {
        autopilotTramIndex.add(tram, tram.x, tram.z);
        maxTramExtentM = Math.max(
            maxTramExtentM,
            tram.frontM,
            tram.rearM,
            tram.collisionHalfW,
        );
    }
    for (const t of _tramBoxes) {
        if (t.isPlayer || !t.tripRef) continue;
        const phys = t.tripRef._physicsWall;
        if (!phys) continue;
        // Tram-local axes: forward = -Z, right = +X. For each car/wreck,
        // project (target - tram) into tram-local; ahead means lz < 0.
        let blocked = false;
        const vehicleSearchRadiusM = t.halfL + TRAM_STALL_AHEAD_M
            + TRAM_STALL_LATERAL_M;
        autopilotVehicleIndex.forEachInBounds(
            t.x - vehicleSearchRadiusM,
            t.z - vehicleSearchRadiusM,
            t.x + vehicleSearchRadiusM,
            t.z + vehicleSearchRadiusM,
            (target) => {
                const mesh = target?.mesh;
                if (!mesh) return false;
                const dx = mesh.position.x - t.x;
                const dz = mesh.position.z - t.z;
                const lx = dx * t.cos + dz * t.sin;
                const lz = -dx * t.sin + dz * t.cos;
                // Forward cone: -TRAM_STALL_AHEAD_M < lz < -t.halfL (i.e.
                // strictly in front of the front bumper, not under it).
                // halfL is half the tram body (front bumper at lz=-halfL).
                if (lz > -t.halfL || lz < -t.halfL - TRAM_STALL_AHEAD_M) return false;
                if (Math.abs(lx) > TRAM_STALL_LATERAL_M) return false;
                blocked = true;
                return true;
            },
        );
        if (!blocked) {
            const tramSearchRadiusM = Math.max(t.frontM, t.rearM, t.collisionHalfW)
                + maxTramExtentM + TRAM_TRAM_GAP_M + TRAM_TRAM_LATERAL_PAD_M;
            autopilotTramIndex.forEachInBounds(
                t.x - tramSearchRadiusM,
                t.z - tramSearchRadiusM,
                t.x + tramSearchRadiusM,
                t.z + tramSearchRadiusM,
                (other) => {
                    if (other === t) return false;
                    if (t.mesh && other.mesh === t.mesh) return false;
                    const bounds = projectTramBoxIntoLocal(t, other, _tramBoundsScratch);
                    if (bounds.maxX < -t.collisionHalfW - TRAM_TRAM_LATERAL_PAD_M ||
                        bounds.minX >  t.collisionHalfW + TRAM_TRAM_LATERAL_PAD_M) {
                        return false;
                    }
                    if (bounds.maxZ < -t.frontM - TRAM_TRAM_GAP_M ||
                        bounds.minZ >  t.rearM) {
                        return false;
                    }
                    blocked = true;
                    return true;
                },
            );
        }
        phys.obstacleStall = blocked;
    }
}

// Returns true if any tram is close enough to trigger the swerve maneuver.
// Two checks per tram:
//   (1) Tram center is in the car's forward cone (TRAM_OBSTACLE_AHEAD_M ×
//       2·TRAM_OBSTACLE_LATERAL_M). Catches "tram ahead in my lane / on
//       intersecting path".
//   (2) Car is inside the tram's body danger bubble (body extended laterally
//       by TRAM_BUBBLE_LATERAL_PAD_M and longitudinally by
//       TRAM_BUBBLE_LONG_PAD_M past each end). Catches "tram catching me
//       up from behind", "tram alongside", and "long tram body whose nose
//       is right beside me even though its center is far ahead". Without
//       this second check, cars get plowed because their own forward
//       cone simply doesn't see the tram in those geometries.
// A player tram is a lead vehicle at every speed. Cars in the same lane match
// it from a long braking ramp instead of attempting a swerve and rear-ending
// it whenever its speed happens to be above the old 8 km/h cutoff.
const TRAM_BRAKE_AHEAD_M = 36;
const TRAM_BRAKE_LATERAL_M = 2.8;   // tram half-width + car half-width + margin
const TRAM_BRAKE_CAR_HALF_M = 2.4;  // car nose→centre distance
const TRAM_FOLLOW_BUFFER_M = 6;
const TRAM_FOLLOW_BRAKE_RAMP_M = 18;

export function computeCarGapToTram(carX, carZ, heading, tramBox) {
    if (!tramBox) return Infinity;
    const fwdSin = Math.sin(heading);
    const fwdCos = Math.cos(heading);
    const dx = tramBox.x - carX;
    const dz = tramBox.z - carZ;
    const distAhead = dx * fwdSin + dz * fwdCos;
    if (distAhead <= 0 || distAhead > TRAM_BRAKE_AHEAD_M + tramBox.halfL) return Infinity;
    const lateral = Math.abs(dx * fwdCos - dz * fwdSin);
    if (lateral > TRAM_BRAKE_LATERAL_M) return Infinity;
    const forwardProjection = Math.abs(tramBox.sin * fwdSin + tramBox.cos * fwdCos) * tramBox.halfL;
    const sideProjection = Math.abs(tramBox.cos * fwdSin - tramBox.sin * fwdCos) * tramBox.collisionHalfW;
    return distAhead - forwardProjection - sideProjection - TRAM_BRAKE_CAR_HALF_M - TRAM_FOLLOW_BUFFER_M;
}

function tramAheadBrakeGap(car) {
    if (_tramBoxes.length === 0) return Infinity;
    const cx = car.mesh.position.x;
    const cz = car.mesh.position.z;
    let nearest = Infinity;
    for (const t of _tramBoxes) {
        if (!t.isPlayer) continue;
        const gap = computeCarGapToTram(cx, cz, car.heading, t);
        if (gap < nearest) nearest = gap;
    }
    return nearest;
}

function carSeesTramAhead(car) {
    if (_tramBoxes.length === 0) return false;
    const cx = car.mesh.position.x;
    const cz = car.mesh.position.z;
    const fwdSin = Math.sin(car.heading);
    const fwdCos = Math.cos(car.heading);
    for (const t of _tramBoxes) {
        const dx = t.x - cx;
        const dz = t.z - cz;
        // Check 1: tram center in car's forward cone.
        const distAhead = dx * fwdSin + dz * fwdCos;
        if (distAhead > 0 && distAhead <= TRAM_OBSTACLE_AHEAD_M) {
            const lateral = Math.abs(dx * fwdCos - dz * fwdSin);
            if (lateral <= TRAM_OBSTACLE_LATERAL_M) return true;
        }
        // Check 2: car inside tram's body danger bubble (any direction).
        // Project (car − tram) into tram-local axes; the bubble is the
        // tram body box padded.
        const carDx = -dx;     // car relative to tram
        const carDz = -dz;
        const lx = carDx * t.cos + carDz * t.sin;
        const lz = -carDx * t.sin + carDz * t.cos;
        if (Math.abs(lx) <= t.halfW + TRAM_BUBBLE_LATERAL_PAD_M &&
            Math.abs(lz) <= t.halfL + TRAM_BUBBLE_LONG_PAD_M) {
            return true;
        }
    }
    return false;
}

function countEnemyCars() {
    let count = 0;
    for (const car of globalCars) {
        if (car.enemy && !car.wrecked) count++;
    }
    return count;
}

function pickEnemyType() {
    return VEHICLE_TYPES.find(t => t.name === 'technical');
}

function ensureEnemyProjectilesGroup() {
    if (!enemyProjectilesGroup) {
        enemyProjectilesGroup = new THREE.Group();
        scene.add(enemyProjectilesGroup);
    }
}

function getPlayerTramTarget() {
    const box = _tramBoxes.find(t => t.isPlayer);
    if (box) {
        const supportY = terrainHeightAtLocal(box.x, box.z);
        if (supportY === null) return null;
        return {
            x: box.x,
            y: supportY + 1.75,
            z: box.z,
            box,
        };
    }
    if (!camera) return null;
    return {
        x: camera.position.x,
        y: camera.position.y,
        z: camera.position.z,
        box: null,
    };
}

function updateEnemyTurretAim(car, target) {
    const turret = car.mesh.userData && car.mesh.userData.enemyTurret;
    if (!turret || !target) return;
    const dx = target.x - car.mesh.position.x;
    const dz = target.z - car.mesh.position.z;
    const worldYaw = Math.atan2(dx, dz);
    turret.yawGroup.rotation.y = worldYaw - car.mesh.rotation.y;
}

function updateEnemyMuzzleFlash(car, dt) {
    const turret = car.mesh.userData && car.mesh.userData.enemyTurret;
    if (!turret || !turret.flash) return;
    turret.flashTtl = Math.max(0, (turret.flashTtl || 0) - dt);
    if (turret.flashTtl <= 0) {
        turret.flash.visible = false;
        return;
    }
    const k = turret.flashTtl / ENEMY_MUZZLE_FLASH_LIFETIME_S;
    turret.flash.visible = true;
    turret.flash.scale.setScalar(0.45 + k * 1.15);
}

const _enemyMuzzleWorld = new THREE.Vector3();
const _enemyBulletDir = new THREE.Vector3();
const _enemyBulletUp = new THREE.Vector3(0, 1, 0);

function enemyHasLineOfSight(car, target, nowS) {
    const turret = car && car.mesh && car.mesh.userData && car.mesh.userData.enemyTurret;
    if (!turret || !turret.muzzle || !target) return false;
    turret.muzzle.getWorldPosition(_enemyMuzzleWorld);
    car.enemyLosCache = car.enemyLosCache || {};
    return resolveCachedLineOfSight(
        getBuildingsGroup(),
        car.enemyLosCache,
        nowS,
        _enemyMuzzleWorld.x, _enemyMuzzleWorld.y, _enemyMuzzleWorld.z,
        target.x, target.y, target.z,
        {
            targetPad: 0.4,
            cacheMaxAgeS: ENEMY_LOS_CACHE_MAX_AGE_S,
            cacheStartMoveM: ENEMY_LOS_CACHE_SHOOTER_MOVE_M,
            cacheEndMoveM: ENEMY_LOS_CACHE_TARGET_MOVE_M,
        },
    );
}

function spawnEnemyBullet(car, target) {
    const turret = car.mesh.userData && car.mesh.userData.enemyTurret;
    if (!turret || !turret.muzzle || !target) return;
    ensureEnemyProjectilesGroup();

    turret.muzzle.getWorldPosition(_enemyMuzzleWorld);
    const dx = target.x - _enemyMuzzleWorld.x;
    const dy = target.y - _enemyMuzzleWorld.y;
    const dz = target.z - _enemyMuzzleWorld.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const spread = ENEMY_AIM_SPREAD_BASE_M + dist * ENEMY_AIM_SPREAD_PER_M;
    const targetX = target.x + (Math.random() - 0.5) * spread;
    const targetY = target.y + (Math.random() - 0.5) * spread * 0.45;
    const targetZ = target.z + (Math.random() - 0.5) * spread;
    _enemyBulletDir.set(
        targetX - _enemyMuzzleWorld.x,
        targetY - _enemyMuzzleWorld.y,
        targetZ - _enemyMuzzleWorld.z,
    ).normalize();

    const mesh = new THREE.Mesh(getEnemyBulletGeometry(), getEnemyBulletMaterial());
    mesh.position.copy(_enemyMuzzleWorld);
    mesh.quaternion.setFromUnitVectors(_enemyBulletUp, _enemyBulletDir);
    enemyProjectilesGroup.add(mesh);
    liveEnemyBullets.push({
        mesh,
        prevX: _enemyMuzzleWorld.x,
        prevY: _enemyMuzzleWorld.y,
        prevZ: _enemyMuzzleWorld.z,
        vx: _enemyBulletDir.x * ENEMY_BULLET_SPEED_MPS,
        vy: _enemyBulletDir.y * ENEMY_BULLET_SPEED_MPS,
        vz: _enemyBulletDir.z * ENEMY_BULLET_SPEED_MPS,
        ttl: ENEMY_BULLET_LIFETIME_S,
        owner: car,
    });
    playEnemyShotSound(_enemyMuzzleWorld.x, _enemyMuzzleWorld.y, _enemyMuzzleWorld.z);

    if (turret.flash) {
        turret.flash.visible = true;
        turret.flash.rotation.set(
            Math.random() * Math.PI * 2,
            Math.random() * Math.PI * 2,
            Math.random() * Math.PI * 2,
        );
        turret.flashTtl = ENEMY_MUZZLE_FLASH_LIFETIME_S;
    }
}

function segmentHitsSphere(x0, y0, z0, x1, y1, z1, cx, cy, cz, radius) {
    const sx = x1 - x0;
    const sy = y1 - y0;
    const sz = z1 - z0;
    const len2 = sx * sx + sy * sy + sz * sz;
    const t = len2 > 0
        ? Math.max(0, Math.min(1, ((cx - x0) * sx + (cy - y0) * sy + (cz - z0) * sz) / len2))
        : 0;
    const px = x0 + sx * t;
    const py = y0 + sy * t;
    const pz = z0 + sz * t;
    const dx = px - cx;
    const dy = py - cy;
    const dz = pz - cz;
    return (dx * dx + dy * dy + dz * dz) <= radius * radius;
}

function segmentHitsAxis(min, max, p0, p1, hit) {
    const d = p1 - p0;
    if (Math.abs(d) < 0.00001) {
        return p0 >= min && p0 <= max;
    }
    let t0 = (min - p0) / d;
    let t1 = (max - p0) / d;
    if (t0 > t1) {
        const tmp = t0;
        t0 = t1;
        t1 = tmp;
    }
    hit.min = Math.max(hit.min, t0);
    hit.max = Math.min(hit.max, t1);
    return hit.min <= hit.max;
}

function segmentHitsTramBox(bullet, box) {
    const x0 = bullet.prevX - box.x;
    const z0 = bullet.prevZ - box.z;
    const x1 = bullet.mesh.position.x - box.x;
    const z1 = bullet.mesh.position.z - box.z;
    const p0x = x0 * box.cos + z0 * box.sin;
    const p0z = -x0 * box.sin + z0 * box.cos;
    const p1x = x1 * box.cos + z1 * box.sin;
    const p1z = -x1 * box.sin + z1 * box.cos;
    const hit = { min: 0, max: 1 };
    return segmentHitsAxis(-box.halfW - 0.85, box.halfW + 0.85, p0x, p1x, hit) &&
        segmentHitsAxis(0.25, 4.0, bullet.prevY, bullet.mesh.position.y, hit) &&
        segmentHitsAxis(-box.halfL - 0.85, box.halfL + 0.85, p0z, p1z, hit);
}

function enemyBulletHitsPlayer(bullet) {
    const box = _tramBoxes.find(t => t.isPlayer);
    if (!box) {
        if (!camera) return false;
        return segmentHitsSphere(
            bullet.prevX, bullet.prevY, bullet.prevZ,
            bullet.mesh.position.x, bullet.mesh.position.y, bullet.mesh.position.z,
            camera.position.x, camera.position.y, camera.position.z,
            2.5,
        );
    }

    return segmentHitsTramBox(bullet, box);
}

function spawnEnemyImpactAt(x, y, z) {
    ensureEnemyProjectilesGroup();
    for (let i = 0; i < ENEMY_IMPACT_SPARKS; i++) {
        const mesh = new THREE.Mesh(getEnemyImpactGeometry(), getEnemyImpactMaterial());
        mesh.position.set(x, y, z);
        enemyProjectilesGroup.add(mesh);
        const theta = Math.random() * Math.PI * 2;
        const speed = ENEMY_IMPACT_SPEED_MPS * (0.45 + Math.random());
        liveEnemyImpacts.push({
            mesh,
            vx: Math.cos(theta) * speed,
            vy: 0.8 + Math.random() * 2.2,
            vz: Math.sin(theta) * speed,
            ttl: ENEMY_IMPACT_LIFETIME_S,
        });
    }
}

function updateEnemyBullets(dt) {
    if (liveEnemyBullets.length === 0) return;
    for (let i = liveEnemyBullets.length - 1; i >= 0; i--) {
        const b = liveEnemyBullets[i];
        b.ttl -= dt;
        if (b.ttl <= 0) {
            if (b.mesh.parent) b.mesh.parent.remove(b.mesh);
            liveEnemyBullets.splice(i, 1);
            continue;
        }
        b.prevX = b.mesh.position.x;
        b.prevY = b.mesh.position.y;
        b.prevZ = b.mesh.position.z;
        b.mesh.position.x += b.vx * dt;
        b.mesh.position.y += b.vy * dt;
        b.mesh.position.z += b.vz * dt;
        if (!b.whizPlayed) {
            b.whizPlayed = playBulletWhizForSegment(
                b.prevX, b.prevY, b.prevZ,
                b.mesh.position.x, b.mesh.position.y, b.mesh.position.z,
            );
        }
        const buildingHitPt = findImpactPoint(getBuildingsGroup(),
            b.mesh.position.x, b.mesh.position.y, b.mesh.position.z,
            b.vx, b.vy, b.vz);
        if (buildingHitPt) {
            spawnEnemyImpactAt(buildingHitPt.x, buildingHitPt.y, buildingHitPt.z);
            if (b.mesh.parent) b.mesh.parent.remove(b.mesh);
            liveEnemyBullets.splice(i, 1);
            continue;
        }
        if (enemyBulletHitsPlayer(b)) {
            if (typeof onPlayerTramDamage === 'function') {
                onPlayerTramDamage(ENEMY_BULLET_DAMAGE, {
                    source: 'enemy-technical',
                    vehicleType: 'technical',
                });
            }
            playPlayerBulletHitSound(b.mesh.position.x, b.mesh.position.y, b.mesh.position.z);
            spawnEnemyImpactAt(b.mesh.position.x, b.mesh.position.y, b.mesh.position.z);
            if (b.mesh.parent) b.mesh.parent.remove(b.mesh);
            liveEnemyBullets.splice(i, 1);
        }
    }
}

function updateEnemyImpacts(dt) {
    if (liveEnemyImpacts.length === 0) return;
    for (let i = liveEnemyImpacts.length - 1; i >= 0; i--) {
        const s = liveEnemyImpacts[i];
        s.ttl -= dt;
        if (s.ttl <= 0) {
            if (s.mesh.parent) s.mesh.parent.remove(s.mesh);
            liveEnemyImpacts.splice(i, 1);
            continue;
        }
        s.vy -= 9.8 * dt;
        s.mesh.position.x += s.vx * dt;
        s.mesh.position.y += s.vy * dt;
        s.mesh.position.z += s.vz * dt;
        const k = Math.max(0, s.ttl / ENEMY_IMPACT_LIFETIME_S);
        s.mesh.scale.setScalar(0.55 + k * 0.85);
    }
}

function updateEnemyVehicles(dt) {
    if (!isGameModeFn()) return;
    const target = getPlayerTramTarget();
    const nowS = performance.now() / 1000;
    for (const car of globalCars) {
        if (!car.enemy || car.wrecked || car.terrainReady === false) continue;
        queueEnemyMusicSpeaker(
            car.mesh.position.x,
            car.mesh.position.y + 1.7,
            car.mesh.position.z,
            0.95,
            car.enemyMusicTrackIndex,
        );
        updateEnemyMuzzleFlash(car, dt);
        if (!target) continue;

        updateEnemyTurretAim(car, target);
        const dx = target.x - car.mesh.position.x;
        const dy = target.y - (car.mesh.position.y + 1.6);
        const dz = target.z - car.mesh.position.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > ENEMY_FIRE_RANGE_M || dist < ENEMY_FIRE_MIN_RANGE_M) continue;

        if (!Number.isFinite(car.enemyNextShotAt)) {
            car.enemyNextShotAt = nowS + Math.random() * 1.5;
            car.enemyBurstRemaining = 0;
        }
        if (nowS < car.enemyNextShotAt) continue;
        if (!enemyHasLineOfSight(car, target, nowS)) {
            car.enemyBurstRemaining = 0;
            continue;
        }

        if (!car.enemyBurstRemaining || car.enemyBurstRemaining <= 0) {
            car.enemyBurstRemaining = ENEMY_BURST_MIN +
                Math.floor(Math.random() * (ENEMY_BURST_MAX - ENEMY_BURST_MIN + 1));
            cabVoice.playEnemyShootLine?.(distanceToCamera(car));
        }

        spawnEnemyBullet(car, target);
        car.enemyBurstRemaining -= 1;
        car.enemyNextShotAt = car.enemyBurstRemaining > 0
            ? nowS + ENEMY_BURST_CADENCE_S
            : nowS + ENEMY_BURST_COOLDOWN_MIN_S +
                Math.random() * (ENEMY_BURST_COOLDOWN_MAX_S - ENEMY_BURST_COOLDOWN_MIN_S);
    }
    updateEnemyBullets(dt);
    updateEnemyImpacts(dt);
}

// Apply damage to a car; if health reaches zero, freeze the car, tilt +
// sink it as a wreck, and remove it from the active pool so other cars
// stop tracking it for spacing. Returns true exactly on the transition
// from "alive" to "wrecked" so the caller can spawn an explosion effect.
// Non-wrecking hits also fire a honk sound (rate-limited per car).
export function recordCarHit(car, damage = BULLET_DAMAGE) {
    if (!car || car.wrecked) return false;
    ensureCarHealth(car);
    const hitDamage = Number.isFinite(damage) && damage > 0 ? damage : BULLET_DAMAGE;
    car.health = Math.max(0, car.health - hitDamage);
    updateCarHealthBar(car);
    if (car.health <= 0) {
        // Bullets always count as player kills.
        wreckCar(car, /* byPlayer */ true);
        if (!car.enemy) cabVoice.playWreckLine?.();
        return true;
    }
    if (car.enemy) {
        cabVoice.playEnemyHitLine?.(distanceToCamera(car));
    } else {
        playCarHonk(car);
        cabVoice.playShootLine?.();
    }
    // Liveried vehicles (ambulance / police) flick on lights + siren the
    // moment they take a hit and survive. updateEmergencyVehicles() reads
    // car.emergency every frame to drive the lightbar flash + siren mix.
    if (!car.enemy && car.type && car.type.livery) {
        car.emergency = true;
    }
    return false;
}

// Cosmetic wreck dressing — the door that swings open and the driver who climbs
// out — is built on a queue rather than inside the collision test.
//
// applyTramCollisions cost 290 ms in a single frame, which was the largest
// remaining stutter in the world and only happened when a car was actually
// wrecked (hence rare). The collision RESPONSE has to be immediate: the car
// leaves globalCars, tilts and sinks in the same frame. Its decoration does not,
// and a frame or two later is imperceptible next to a 290 ms hitch.
const wreckDressingQueue = createFrameChunkQueue({
    label: 'wreck-dressing',
    frameBudgetMs: 2,
    preferAnimationFrame: true,
    workClass: 'simulation',
});

function wreckCar(car, byPlayer) {
    const tWreck0 = performance.now();
    car.wrecked = true;
    car.wreckedAtS = performance.now() / 1000;
    car.wreckedByPlayer = !!byPlayer;
    if (car.enemy && byPlayer) {
        cabVoice.playEnemyWreckLine?.(distanceToCamera(car));
    }
    recordLayerFrameMs('wreck:voiceLine', performance.now() - tWreck0);
    if (byPlayer) _playerWreckCount++;
    disposeCarHealthBar(car);
    car.smokeAccum = 0;
    // Hide the enemy muzzle flash if it was active mid-burst. Once wrecked,
    // updateEnemyVehicles skips this car so its flashTtl never ticks down —
    // without this it would freeze as a large fireball at the barrel.
    const turret = car.mesh.userData && car.mesh.userData.enemyTurret;
    if (turret) {
        if (turret.flash) turret.flash.visible = false;
        turret.flashTtl = 0;
    }
    // Tilt the body — slight nose-down rotation around the car's local X
    // axis, plus a random small roll around Z to make each wreck look
    // unique. Sink slightly into the road as if the suspension collapsed.
    car.mesh.rotation.x = -0.18;
    car.mesh.rotation.z = (Math.random() - 0.5) * 0.45;
    car.mesh.position.y -= 0.08;
    // Pull from globalCars so the per-frame mover ignores it; the mesh
    // itself stays in carsGroup so the wreck (with all its bullet holes)
    // remains visible on the road.
    const idx = globalCars.indexOf(car);
    if (idx >= 0) globalCars.splice(idx, 1);
    wreckedCars.push(car);
    // Queued, not inline: see wreckDressingQueue above. One item, so it lands
    // whole rather than half-built.
    // Interactive free roam intentionally has no interaction with simulated
    // people in v1. Preserve the tram-sim reaction in sessions that retain it.
    if (!suppressTrafficWreckDressing && car.type?.kind !== 'bicycle') {
        wreckDressingQueue.enqueue([car], (target) => {
            // The wreck may have been evicted or the session torn down since.
            if (!carsGroup || !wreckedCars.includes(target)) return;
            const tDress0 = performance.now();
            createWreckDriverAnim(target);
            recordLayerFrameMs('wreck:dressing', performance.now() - tDress0);
        }, { maxItemsPerFrame: 1 });
    }
    recordLayerFrameMs('wreck:total', performance.now() - tWreck0);
}

// ─── Wreck driver animation ─────────────────────────────────────────────
// After a car is wrecked, its driver door swings open, a stick-figure
// driver climbs out, and walks in random circles around the wreck —
// occasionally throwing both arms up in protest. Each wreck owns one
// `WreckAnim` instance tracked in `liveWreckAnims`.

const DOOR_OPEN_RATE = 2.2;          // rad/s
const DOOR_OPEN_ANGLE = 1.30;        // ~75°
const PERSON_SPAWN_DELAY_S = 0.55;   // wait until door is mostly open
const PERSON_WALK_SPEED = 1.05;      // m/s
// Walk targets are picked in a ring around the car. The inner radius is
// the car's circumscribed-circle radius (half-diagonal) plus this buffer,
// so EVERY ring sample is guaranteed to land outside the car footprint
// regardless of car size. Outer ring extends OBSTACLE_BUFFER + this far.
const PERSON_RING_INNER_BUFFER = 0.6;
const PERSON_RING_OUTER_BUFFER = 2.5;
// Per-frame collision keeps the person OUT of the car's bounding rectangle
// in car-local coords. The buffer accounts for half the person's body
// width so they don't visually clip the chassis.
const PERSON_OBSTACLE_BUFFER = 0.45;
const PERSON_TURN_RATE = 4.0;        // rad/s — heading lerp toward target dir
const ARMS_UP_INTERVAL_MIN_S = 2.5;
const ARMS_UP_INTERVAL_MAX_S = 5.0;
const ARMS_UP_DURATION_S = 0.85;
const ARMS_UP_RAISE_RATE = 6.0;      // rad/s on the shoulder hinge
const ARMS_DOWN_REST_RAD = 0.0;
const ARMS_UP_REACH_RAD = -2.6;      // shoulder rotation.x at full reach
const PERSON_LEG_SWING_AMP = 0.6;    // rad
const PERSON_LEG_SWING_FREQ = 3.2;   // Hz

const liveWreckAnims = [];

let _wreckSphereGeo = null;
let _wreckCylinderGeo = null;
const _wreckMatCache = new Map();

function getWreckSphereGeo() {
    if (!_wreckSphereGeo) {
        _wreckSphereGeo = new THREE.SphereGeometry(1, 10, 8);
        registerShared(_wreckSphereGeo);
    }
    return _wreckSphereGeo;
}
function getWreckCylinderGeo() {
    if (!_wreckCylinderGeo) {
        _wreckCylinderGeo = new THREE.CylinderGeometry(1, 1, 1, 10);
        registerShared(_wreckCylinderGeo);
    }
    return _wreckCylinderGeo;
}
function getWreckMat(hex) {
    let m = _wreckMatCache.get(hex);
    if (!m) {
        m = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.85, metalness: 0.0 });
        registerShared(m);
        _wreckMatCache.set(hex, m);
    }
    return m;
}

// Door panel: thin slab (X) × tall (Y) × wide (Z). Hinge group lives at
// the FRONT edge of the door so that opening the hinge swings the rear
// of the door outward.
function buildWreckDoor(type, bodyHex) {
    const hinge = new THREE.Group();
    const doorThick = 0.05;
    const doorH = type.chassisH * 0.78;
    const doorW = Math.min(0.62, type.cabinLen * 0.40);
    const panel = new THREE.Mesh(
        new THREE.BoxGeometry(doorThick, doorH, doorW),
        getWreckMat(bodyHex),
    );
    // Translate so the hinge sits at the FRONT edge of the door (z=0 on
    // the hinge), with the door extending rearward (-Z) when closed.
    panel.position.set(0, 0, -doorW / 2);
    hinge.add(panel);
    hinge._doorWidth = doorW;
    hinge._doorHeight = doorH;
    return hinge;
}

// Stick figure with a head, body, two legs, and TWO ARM HINGE GROUPS so
// arms can rotate at the shoulder. Returns { group, leftArm, rightArm,
// leftLeg, rightLeg, totalH } where totalH = full standing height.
function buildWreckPerson() {
    const g = new THREE.Group();
    // Earthy-tone palette so each wreck driver looks distinct enough.
    const SHIRT_COLORS = [0x3a4a78, 0x6a3030, 0x2e5a3a, 0x5a4030, 0x404048, 0x7a5a30];
    const PANTS_COLORS = [0x202028, 0x303040, 0x40302a, 0x2a2a30];
    const SKIN = 0xdaa080;
    const shirt = SHIRT_COLORS[Math.floor(Math.random() * SHIRT_COLORS.length)];
    const pants = PANTS_COLORS[Math.floor(Math.random() * PANTS_COLORS.length)];

    const headR = 0.15, bodyH = 0.74, bodyR = 0.17;
    const legH = 0.72, legR = 0.045, legX = 0.07;
    const armH = 0.60, armR = 0.035, armX = 0.20;

    const head = new THREE.Mesh(getWreckSphereGeo(), getWreckMat(SKIN));
    head.position.y = legH + bodyH + headR * 1.05;
    head.scale.set(headR, headR * 1.08, headR);
    g.add(head);

    const body = new THREE.Mesh(getWreckCylinderGeo(), getWreckMat(shirt));
    body.position.y = legH + bodyH / 2;
    body.scale.set(bodyR, bodyH, bodyR);
    g.add(body);

    const legs = [];
    for (const sx of [-1, +1]) {
        // Hip pivot group — leg geometry hangs from the hip so swinging
        // the group rotates the leg around the hip joint.
        const hip = new THREE.Group();
        hip.position.set(sx * legX, legH, 0);
        const leg = new THREE.Mesh(getWreckCylinderGeo(), getWreckMat(pants));
        leg.position.y = -legH / 2;
        leg.scale.set(legR, legH, legR);
        hip.add(leg);
        g.add(hip);
        legs.push(hip);
    }

    const arms = [];
    for (const sx of [-1, +1]) {
        // Shoulder pivot at top of body. Arm hangs DOWN from pivot, so
        // rotation.x = 0 → resting at side, rotation.x = -π → straight up.
        const shoulder = new THREE.Group();
        shoulder.position.set(sx * armX, legH + bodyH * 0.92, 0);
        const arm = new THREE.Mesh(getWreckCylinderGeo(), getWreckMat(SKIN));
        arm.position.y = -armH / 2;
        arm.scale.set(armR, armH, armR);
        shoulder.add(arm);
        g.add(shoulder);
        arms.push(shoulder);
    }

    return {
        group: g,
        leftLeg: legs[0],
        rightLeg: legs[1],
        leftArm: arms[0],
        rightArm: arms[1],
        totalH: legH + bodyH + headR * 2,
    };
}

function pickWalkTarget(car) {
    const halfDiag = Math.sqrt(
        car.type.length * car.type.length + car.type.width * car.type.width
    ) / 2;
    const minR = halfDiag + PERSON_RING_INNER_BUFFER;
    const maxR = halfDiag + PERSON_RING_OUTER_BUFFER;
    const ang = Math.random() * Math.PI * 2;
    const r = minR + Math.random() * (maxR - minR);
    return {
        x: car.mesh.position.x + Math.cos(ang) * r,
        z: car.mesh.position.z + Math.sin(ang) * r,
    };
}

// Builds the door + driver state for a freshly-wrecked car. The DOOR is a
// child of car.mesh so it inherits the wreck's tilt. The PERSON lives in
// world space (parented to carsGroup) so it stays upright and walks
// independently of the slumped chassis.
function createWreckDriverAnim(car) {
    if (!car || !carsGroup) return;
    const type = car.type;
    if (!type) return;

    // Driver door = LEFT side (Croatia drives on the right, driver sits left).
    const door = buildWreckDoor(type, car.bodyHex || 0x808080);
    // Hinge position in CAR-LOCAL coords: outer edge of the cabin, near
    // the front of the cabin region, vertically centred on the chassis.
    const hingeY = trafficVehicleVerticalLayout(type, WHEEL_RADIUS).chassisCenterY;
    const hingeX = -type.width / 2 - 0.005;
    const hingeZ = type.cabinZ + type.cabinLen * 0.42;
    door.position.set(hingeX, hingeY, hingeZ);
    door.rotation.y = 0;
    car.mesh.add(door);

    const person = buildWreckPerson();
    person.group.visible = false;
    carsGroup.add(person.group);

    const anim = {
        car,
        door,
        doorAngle: 0,
        person,
        personSpawned: false,
        spawnTimer: 0,
        // Walking state in world coords.
        x: car.mesh.position.x,
        z: car.mesh.position.z,
        heading: car.heading + Math.PI / 2,    // start facing left (where door opens)
        target: pickWalkTarget(car),
        // Arms-up timer + state.
        nextArmsUpAt: ARMS_UP_INTERVAL_MIN_S + Math.random() * (ARMS_UP_INTERVAL_MAX_S - ARMS_UP_INTERVAL_MIN_S),
        clock: 0,
        armsUpTimer: 0,
        armAngle: ARMS_DOWN_REST_RAD,
        // Phase offset for leg swing so multiple drivers don't sync.
        legPhase: Math.random() * Math.PI * 2,
    };
    liveWreckAnims.push(anim);
}

function updateWreckDriverAnim(anim, dt) {
    // Open the door progressively up to DOOR_OPEN_ANGLE. The door panel
    // hangs in -Z from the hinge; positive Y rotation swings that -Z
    // panel toward -X (outward, away from the LEFT side of the car).
    if (anim.doorAngle < DOOR_OPEN_ANGLE) {
        anim.doorAngle = Math.min(DOOR_OPEN_ANGLE, anim.doorAngle + DOOR_OPEN_RATE * dt);
        anim.door.rotation.y = anim.doorAngle;
    }

    // Wait for the door to be mostly open, then spawn the person at the
    // door opening (in world coords) and start walking.
    if (!anim.personSpawned) {
        anim.spawnTimer += dt;
        if (anim.spawnTimer >= PERSON_SPAWN_DELAY_S) {
            const car = anim.car;
            const sinH = Math.sin(car.heading);
            const cosH = Math.cos(car.heading);
            // Door opening in car-local: a bit further out than the hinge,
            // and slightly behind the hinge along the door's swept arc.
            const localX = -car.type.width / 2 - 0.6;
            const localZ = car.type.cabinZ + car.type.cabinLen * 0.20;
            // Local → world: rotate by car.heading (matches mesh rotation).
            const wx = car.mesh.position.x + localX * cosH + localZ * sinH;
            const wz = car.mesh.position.z - localX * sinH + localZ * cosH;
            const supportY = terrainHeightAtLocal(wx, wz);
            if (supportY === null) return;
            anim.x = wx;
            anim.z = wz;
            anim.person.group.position.set(wx, supportY, wz);
            anim.person.group.visible = true;
            anim.personSpawned = true;
        }
        return;
    }

    const supportY = terrainHeightAtLocal(anim.x, anim.z);
    if (supportY === null) {
        anim.person.group.visible = false;
        return;
    }
    anim.person.group.visible = true;
    anim.person.group.position.y = supportY;
    anim.clock += dt;

    // ── Walking ────────────────────────────────────────────────────────
    const dx = anim.target.x - anim.x;
    const dz = anim.target.z - anim.z;
    const distToTarget = Math.sqrt(dx * dx + dz * dz);
    if (distToTarget < 0.4) {
        anim.target = pickWalkTarget(anim.car);
    } else {
        const desiredHeading = Math.atan2(dx, dz);
        // Shortest-arc heading lerp.
        let dh = desiredHeading - anim.heading;
        while (dh > Math.PI) dh -= Math.PI * 2;
        while (dh < -Math.PI) dh += Math.PI * 2;
        const maxTurn = PERSON_TURN_RATE * dt;
        anim.heading += Math.max(-maxTurn, Math.min(maxTurn, dh));
        const step = PERSON_WALK_SPEED * dt;
        anim.x += Math.sin(anim.heading) * step;
        anim.z += Math.cos(anim.heading) * step;
    }

    // ── Obstacle: don't walk through the wreck ─────────────────────────
    // Project the proposed world position into car-local coords (using
    // the car's frozen heading, not its tilt). If inside the expanded
    // bounding rectangle, push out along whichever axis has less
    // penetration AND redirect the heading to slide along that edge
    // toward the target. Without the heading override the steer-toward-
    // target logic from the previous block would just push the person
    // back into the car every frame, leaving them visually stuck.
    {
        const car = anim.car;
        const cosH = Math.cos(car.heading);
        const sinH = Math.sin(car.heading);
        const dxw = anim.x - car.mesh.position.x;
        const dzw = anim.z - car.mesh.position.z;
        const lx = dxw * cosH - dzw * sinH;
        const lz = dxw * sinH + dzw * cosH;
        const halfW = car.type.width / 2 + PERSON_OBSTACLE_BUFFER;
        const halfL = car.type.length / 2 + PERSON_OBSTACLE_BUFFER;
        if (Math.abs(lx) < halfW && Math.abs(lz) < halfL) {
            // Target in car-local coords — used to decide which way to
            // slide along the obstacle edge so we make progress.
            const tdx = anim.target.x - car.mesh.position.x;
            const tdz = anim.target.z - car.mesh.position.z;
            const tlx = tdx * cosH - tdz * sinH;
            const tlz = tdx * sinH + tdz * cosH;

            const overX = halfW - Math.abs(lx);
            const overZ = halfL - Math.abs(lz);
            let newLx = lx, newLz = lz;
            // Tangent direction in car-local coords. After push-out the
            // person sits on either an X-edge (slide along Z) or a
            // Z-edge (slide along X). Pick the sign that reduces the
            // car-local distance to the target.
            let tangLx = 0, tangLz = 0;
            if (overX < overZ) {
                newLx = (lx >= 0 ? 1 : -1) * halfW;
                tangLz = (tlz >= lz ? 1 : -1);
            } else {
                newLz = (lz >= 0 ? 1 : -1) * halfL;
                tangLx = (tlx >= lx ? 1 : -1);
            }
            anim.x = car.mesh.position.x + newLx * cosH + newLz * sinH;
            anim.z = car.mesh.position.z - newLx * sinH + newLz * cosH;
            // Convert tangent direction back to world space and snap
            // heading to it. Overrides the steer-toward-target result so
            // the next walking step moves AROUND the car, not back in.
            const tWx = tangLx * cosH + tangLz * sinH;
            const tWz = -tangLx * sinH + tangLz * cosH;
            anim.heading = Math.atan2(tWx, tWz);
        }
    }

    const nextSupportY = terrainHeightAtLocal(anim.x, anim.z);
    if (nextSupportY === null) {
        anim.person.group.visible = false;
        return;
    }
    anim.person.group.position.set(anim.x, nextSupportY, anim.z);
    anim.person.group.rotation.y = anim.heading;

    // ── Leg swing while walking ────────────────────────────────────────
    const legSwing = Math.sin(anim.clock * Math.PI * 2 * PERSON_LEG_SWING_FREQ + anim.legPhase) * PERSON_LEG_SWING_AMP;
    anim.person.leftLeg.rotation.x = legSwing;
    anim.person.rightLeg.rotation.x = -legSwing;

    // ── Arms-up cycle ──────────────────────────────────────────────────
    // armsUpTimer == 0 → arms idle/dropping. > 0 → arms held up, ticking down.
    if (anim.armsUpTimer > 0) {
        anim.armsUpTimer -= dt;
        // Snap arms up quickly, hold.
        anim.armAngle = Math.max(ARMS_UP_REACH_RAD, anim.armAngle - ARMS_UP_RAISE_RATE * dt);
    } else {
        // Drop arms back to rest.
        anim.armAngle = Math.min(ARMS_DOWN_REST_RAD, anim.armAngle + ARMS_UP_RAISE_RATE * 0.6 * dt);
        anim.nextArmsUpAt -= dt;
        if (anim.nextArmsUpAt <= 0) {
            anim.armsUpTimer = ARMS_UP_DURATION_S;
            anim.nextArmsUpAt = ARMS_UP_INTERVAL_MIN_S
                + Math.random() * (ARMS_UP_INTERVAL_MAX_S - ARMS_UP_INTERVAL_MIN_S);
        }
    }
    anim.person.leftArm.rotation.x = anim.armAngle;
    anim.person.rightArm.rotation.x = anim.armAngle;
}

function updateAllWreckDriverAnims(dt) {
    for (const a of liveWreckAnims) updateWreckDriverAnim(a, dt);
}

function disposeWreckDriverAnims() {
    for (const a of liveWreckAnims) {
        disposeGroup(a.door);
        disposeGroup(a.person?.group);
    }
    liveWreckAnims.length = 0;
    for (const m of _wreckMatCache.values()) {
        unregisterShared(m);
        m.dispose();
    }
    _wreckMatCache.clear();
    if (_wreckSphereGeo) { unregisterShared(_wreckSphereGeo); _wreckSphereGeo.dispose(); _wreckSphereGeo = null; }
    if (_wreckCylinderGeo) { unregisterShared(_wreckCylinderGeo); _wreckCylinderGeo.dispose(); _wreckCylinderGeo = null; }
}

// ─── Wreck smoke (lazy resources, per-frame tick) ────────────────────────

function getSmokeGeometry() {
    if (!smokeGeometry) {
        smokeGeometry = new THREE.SphereGeometry(0.35, 8, 6);
        registerShared(smokeGeometry);
    }
    return smokeGeometry;
}
function getSmokeMaterialTemplate() {
    if (!smokeMaterialTemplate) {
        // Template — cloned per particle so each can fade independently.
        // Cloned material is disposed when its particle ends.
        smokeMaterialTemplate = new THREE.MeshStandardMaterial({
            color: 0x3a3a3a, roughness: 1.0, metalness: 0.0,
            transparent: true, opacity: 0.55, depthWrite: false,
        });
        registerShared(smokeMaterialTemplate);
    }
    return smokeMaterialTemplate;
}
function ensureSmokeGroup() {
    if (!smokeGroup) {
        smokeGroup = new THREE.Group();
        smokeGroup.name = 'VehicleSmokeAndFire';
        scene.add(smokeGroup);
    }
}

export function spawnSmokeAt(x, y, z) {
    if (liveSmoke.length >= MAX_SMOKE_PARTICLES) return;
    ensureSmokeGroup();
    const mat = getSmokeMaterialTemplate().clone();
    const mesh = new THREE.Mesh(getSmokeGeometry(), mat);
    const jx = (Math.random() - 0.5) * 0.5;
    const jz = (Math.random() - 0.5) * 0.5;
    mesh.position.set(x + jx, y, z + jz);
    smokeGroup.add(mesh);
    liveSmoke.push({
        mesh,
        vx: (Math.random() - 0.5) * 0.4,
        vy: 1.30 + Math.random() * 0.6,
        vz: (Math.random() - 0.5) * 0.4,
        age: 0,
    });
}

function getFireGeometry() {
    if (!fireGeometry) {
        fireGeometry = new THREE.SphereGeometry(0.55, 10, 8);
        registerShared(fireGeometry);
    }
    return fireGeometry;
}

function getFireMaterialTemplate() {
    if (!fireMaterialTemplate) {
        fireMaterialTemplate = new THREE.MeshStandardMaterial({
            color: 0xffb840,
            emissive: 0xff5410,
            emissiveIntensity: 1.9,
            transparent: true,
            opacity: 0.95,
            depthWrite: false,
            roughness: 0.6,
            metalness: 0.0,
        });
        registerShared(fireMaterialTemplate);
    }
    return fireMaterialTemplate;
}

// Bright orange impact flash + a couple of trailing smoke puffs. Used by
// weapon.js for tram hits and by tram.js / cab.js for ongoing wreck
// flare-ups. Cheap one-shot — lives ~0.4 s.
export function spawnFireFlashAt(x, y, z) {
    if (liveFire.length < MAX_FIRE_PARTICLES) {
        ensureSmokeGroup();
        const mat = getFireMaterialTemplate().clone();
        const mesh = new THREE.Mesh(getFireGeometry(), mat);
        mesh.position.set(x, y, z);
        mesh.scale.setScalar(0.5);
        smokeGroup.add(mesh);
        liveFire.push({ mesh, age: 0 });
    }
    spawnSmokeAt(x, y, z);
    spawnSmokeAt(x + (Math.random() - 0.5) * 0.6, y + 0.2, z + (Math.random() - 0.5) * 0.6);
}

function updateFire(dt) {
    if (liveFire.length === 0) return;
    for (let i = liveFire.length - 1; i >= 0; i--) {
        const f = liveFire[i];
        f.age += dt;
        if (f.age >= FIRE_LIFETIME_S) {
            if (f.mesh.parent) f.mesh.parent.remove(f.mesh);
            if (f.mesh.material) f.mesh.material.dispose();
            liveFire.splice(i, 1);
            continue;
        }
        const k = f.age / FIRE_LIFETIME_S;
        f.mesh.scale.setScalar(0.5 + k * 1.3);
        f.mesh.material.opacity = 0.95 * (1 - k);
        f.mesh.material.emissiveIntensity = 1.9 * (1 - k * 0.45);
    }
}

function maybeEmitWreckSmoke(wreck, dt, camLocalX, camLocalZ) {
    const dx = wreck.mesh.position.x - camLocalX;
    const dz = wreck.mesh.position.z - camLocalZ;
    if (dx * dx + dz * dz > SMOKE_VISIBLE_RADIUS_M * SMOKE_VISIBLE_RADIUS_M) return;
    wreck.smokeAccum = (wreck.smokeAccum || 0) + dt;
    if (wreck.smokeAccum < SMOKE_SPAWN_INTERVAL_S) return;
    wreck.smokeAccum -= SMOKE_SPAWN_INTERVAL_S;
    // Spawn at the front-of-car (engine bay) in WORLD coords. Car forward
    // (local +Z) maps to world (sin θ, 0, cos θ) where θ = car.heading.
    const sinH = Math.sin(wreck.heading);
    const cosH = Math.cos(wreck.heading);
    const fwdM = 1.4;
    const wx = wreck.mesh.position.x + sinH * fwdM;
    const wz = wreck.mesh.position.z + cosH * fwdM;
    const wy = wreck.mesh.position.y + 0.85;
    spawnSmokeAt(wx, wy, wz);
}

function updateSmoke(dt) {
    if (liveSmoke.length === 0) return;
    for (let i = liveSmoke.length - 1; i >= 0; i--) {
        const s = liveSmoke[i];
        s.age += dt;
        if (s.age >= SMOKE_LIFETIME_S) {
            if (s.mesh.parent) s.mesh.parent.remove(s.mesh);
            if (s.mesh.material) s.mesh.material.dispose();
            liveSmoke.splice(i, 1);
            continue;
        }
        // Drag — horizontal damps faster than vertical so smoke hangs.
        s.vx *= (1 - 0.9 * dt);
        s.vz *= (1 - 0.9 * dt);
        s.vy *= (1 - 0.25 * dt);
        s.mesh.position.x += s.vx * dt;
        s.mesh.position.y += s.vy * dt;
        s.mesh.position.z += s.vz * dt;
        const k = s.age / SMOKE_LIFETIME_S;
        s.mesh.scale.setScalar(0.7 + k * 2.4);
        s.mesh.material.opacity = 0.55 * (1 - k);
    }
}

// Stamp a small dark disk on the car at the actual surface impact point.
// The bullet hit-test uses a generous bounding sphere, so the bullet's
// own world position is usually NOT on the body shell. Instead we raycast
// from a point well behind the impact (along the bullet's flight) and
// stamp the hole at the first triangle the ray hits inside the car group.
// The hole is added as a child of car.mesh so it moves + rotates with
// the car for the rest of its lifetime, and is oriented along the actual
// face normal so it lays flat against the surface.
const _holeRay = new THREE.Raycaster();
_holeRay.far = 10;
const _holeRayStart = new THREE.Vector3();
const _holeRayDir = new THREE.Vector3();
const _holeNormalWorld = new THREE.Vector3();
const _holePointLocal = new THREE.Vector3();
const _holeNormalLocal = new THREE.Vector3();
const _holeWorldQuat = new THREE.Quaternion();

export function addBulletHole(car, worldX, worldY, worldZ, vx, vy, vz) {
    if (!car || !car.mesh) return;
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (speed < 1e-3) return;
    const ux = vx / speed, uy = vy / speed, uz = vz / speed;

    // Start the ray 5 m behind the impact along the bullet's path so we
    // hit the entry-side surface, even if the bullet's "hit point" was
    // already inside the body shell.
    const back = 5;
    _holeRayStart.set(worldX - ux * back, worldY - uy * back, worldZ - uz * back);
    _holeRayDir.set(ux, uy, uz);
    _holeRay.set(_holeRayStart, _holeRayDir);

    const intersections = _holeRay.intersectObject(car.mesh, true);
    if (intersections.length === 0 || !intersections[0].face) return;
    const hit = intersections[0];

    // Convert hit point and normal into car-local coordinates. This also
    // works after wrecking, when the chassis has extra pitch/roll.
    _holePointLocal.copy(hit.point);
    car.mesh.worldToLocal(_holePointLocal);

    // Face normal: object-local → world (transformDirection) → car-local.
    // The hole's +Z is its normal direction, so lookAt a point along
    // +normal to align the disk flat on the face.
    _holeNormalWorld.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
    car.mesh.getWorldQuaternion(_holeWorldQuat).invert();
    _holeNormalLocal.copy(_holeNormalWorld).applyQuaternion(_holeWorldQuat).normalize();

    const hole = new THREE.Mesh(getBulletHoleGeometry(), getBulletHoleMaterial());
    hole.position.copy(_holePointLocal);
    hole.lookAt(
        _holePointLocal.x + _holeNormalLocal.x,
        _holePointLocal.y + _holeNormalLocal.y,
        _holePointLocal.z + _holeNormalLocal.z,
    );
    car.mesh.add(hole);
}

// ─── Day/night light toggle ────────────────────────────────────────────────
// Shared headlight/taillight materials → one assignment flips every car.

let isCarNight = false;
export function setCarNightMode(night) {
    if (night === isCarNight) return;
    isCarNight = night;
    setRoadVehicleNightMode(night);
}

// ─── Graph + traffic logic ─────────────────────────────────────────────────

function nodeKey(x, z) {
    return Math.round(x / NODE_SNAP_M) + ',' + Math.round(z / NODE_SNAP_M);
}

function nodeKeyToLocal(key) {
    const [gridX = 0, gridZ = 0] = String(key || '').split(',').map(Number);
    return { x: gridX * NODE_SNAP_M, z: gridZ * NODE_SNAP_M };
}

function getGraphScale() {
    const cosLat = Math.cos(anchorLat * DEG_TO_RAD);
    return {
        scaleLon: DEG_TO_RAD * EARTH_RADIUS_M * cosLat,
        scaleLat: DEG_TO_RAD * EARTH_RADIUS_M,
    };
}

function geoToGraphLocal(lat, lon) {
    const { scaleLon, scaleLat } = getGraphScale();
    return {
        x: (lon - anchorLon) * scaleLon,
        z: -(lat - anchorLat) * scaleLat,
    };
}

function graphLocalToGeo(x, z) {
    const { scaleLon, scaleLat } = getGraphScale();
    return {
        lon: anchorLon + (scaleLon ? x / scaleLon : 0),
        lat: anchorLat - (scaleLat ? z / scaleLat : 0),
    };
}

function parseLaneCount(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return Math.max(1, Math.round(value));
    }
    if (typeof value !== 'string') return null;
    const match = value.match(/\d+/);
    if (!match) return null;
    const parsed = Number.parseInt(match[0], 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function buildTwoWayLaneCenters(count) {
    const laneCount = Math.max(1, count || 0);
    return Array.from({ length: laneCount }, (_, index) => (laneCount - index - 0.5) * LANE_WIDTH_M);
}

function buildOneWayLaneCenters(count) {
    const laneCount = Math.max(1, count || 0);
    return Array.from({ length: laneCount }, (_, index) => (laneCount / 2 - 0.5 - index) * LANE_WIDTH_M);
}

function getLaneCentersForFeatureProperties(props = {}, canForward, canBackward) {
    const totalLanes = parseLaneCount(props.lanes);
    let forwardLanes = parseLaneCount(props['lanes:forward'] ?? props.lanes_forward);
    let backwardLanes = parseLaneCount(props['lanes:backward'] ?? props.lanes_backward);

    if (canForward && canBackward) {
        if (!forwardLanes && !backwardLanes) {
            const perDirection = totalLanes && totalLanes >= 2
                ? Math.max(1, Math.floor(totalLanes / 2))
                : 1;
            forwardLanes = perDirection;
            backwardLanes = perDirection;
        } else {
            if (!forwardLanes) forwardLanes = Math.max(1, (totalLanes || backwardLanes || 2) - (backwardLanes || 1));
            if (!backwardLanes) backwardLanes = Math.max(1, (totalLanes || forwardLanes || 2) - (forwardLanes || 1));
        }
        return {
            laneCentersForward: buildTwoWayLaneCenters(forwardLanes),
            laneCentersBackward: buildTwoWayLaneCenters(backwardLanes),
        };
    }

    if (canForward) {
        return {
            laneCentersForward: buildOneWayLaneCenters(forwardLanes || totalLanes || 1),
            laneCentersBackward: [],
        };
    }
    if (canBackward) {
        return {
            laneCentersForward: [],
            laneCentersBackward: buildOneWayLaneCenters(backwardLanes || totalLanes || 1),
        };
    }
    return {
        laneCentersForward: [LANE_OFFSET_M],
        laneCentersBackward: [LANE_OFFSET_M],
    };
}

export function getCarLaneCentersForFeatureProperties(props = {}, canForward = true, canBackward = true) {
    return getLaneCentersForFeatureProperties(props, canForward, canBackward);
}

function chooseLaneStateForSegment(seg, forward, preferredRank = null) {
    const centers = forward ? seg.laneCentersForward : seg.laneCentersBackward;
    const laneCenters = Array.isArray(centers) && centers.length > 0 ? centers : [LANE_OFFSET_M];
    const clampedRank = Number.isInteger(preferredRank)
        ? Math.max(0, Math.min(laneCenters.length - 1, preferredRank))
        : Math.floor(Math.random() * laneCenters.length);
    return {
        rank: clampedRank,
        offset: laneCenters[clampedRank],
    };
}

function assignCarLaneForSegment(car, seg, preferredRank = car && Number.isInteger(car.laneRank) ? car.laneRank : null) {
    if (!car || !seg) return;
    const lane = chooseLaneStateForSegment(seg, car.forward, preferredRank);
    car.laneRank = lane.rank;
    car.laneOffsetBase = lane.offset;
}

function getCarLaneOffset(car) {
    return (Number.isFinite(car && car.laneOffsetBase) ? car.laneOffsetBase : LANE_OFFSET_M) + ((car && car.swerveOffset) || 0);
}

function addOutgoing(key, segIdx, forward) {
    let n = globalGraph.nodes.get(key);
    if (!n) {
        n = { out: [] };
        globalGraph.nodes.set(key, n);
    }
    n.out.push({ segIdx, forward });
}

function removeOutgoing(key, segIdx, forward) {
    const node = globalGraph.nodes.get(key);
    if (!node || !Array.isArray(node.out)) return;
    node.out = node.out.filter((entry) => !(entry.segIdx === segIdx && entry.forward === forward));
}

function getActiveOutgoing(node) {
    if (!node || !Array.isArray(node.out)) return [];
    return node.out.filter((entry) => {
        const seg = globalGraph.segments[entry.segIdx];
        return seg && !seg.retired;
    });
}

function segmentAllowsDirection(segIdx, forward) {
    const seg = globalGraph.segments[segIdx];
    if (!seg) return false;
    const node = globalGraph.nodes.get(forward ? seg.startKey : seg.endKey);
    if (!node || !Array.isArray(node.out)) return false;
    return node.out.some((entry) => entry.segIdx === segIdx && entry.forward === forward);
}

function appendGraphSegment({
    x0, z0, x1, z1, speed, osmId, canForward, canBackward,
    highway = null, chordIndex = null, formationOsmId = null,
    laneCentersForward = [LANE_OFFSET_M], laneCentersBackward = [LANE_OFFSET_M],
}) {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const length = Math.sqrt(dx * dx + dz * dz);
    if (length < 0.5) return null;
    let segIdx = freeSegmentIndices.pop();
    if (!Number.isInteger(segIdx)) {
        if (globalGraph.segments.length >= MAX_GRAPH_SEGMENT_SLOTS) {
            graphCapacityHits += 1;
            if (graphCapacityHits === 1 || graphCapacityHits % 100 === 0) {
                console.warn('[cars] traffic graph capacity reached', MAX_GRAPH_SEGMENT_SLOTS);
            }
            return null;
        }
        segIdx = globalGraph.segments.length;
    }
    const startKey = nodeKey(x0, z0);
    const endKey = nodeKey(x1, z1);
    globalGraph.segments[segIdx] = {
        x0, z0, x1, z1, dx, dz, length, speed,
        startKey, endKey,
        osmId, highway, chordIndex, formationOsmId,
        laneCentersForward: [...laneCentersForward],
        laneCentersBackward: [...laneCentersBackward],
        retired: false,
        replacementSegIndices: null,
    };
    if (canForward) addOutgoing(startKey, segIdx, true);
    if (canBackward) addOutgoing(endKey, segIdx, false);
    return segIdx;
}

function replaceSegIndexInOsmMapping(osmId, oldSegIdx, replacementSegIndices) {
    if (!osmId) return;
    const existing = osmIdToSegIndices.get(osmId) || [];
    const next = [];
    let replaced = false;
    for (const segIdx of existing) {
        if (segIdx === oldSegIdx) {
            replaced = true;
            for (const replacement of replacementSegIndices || []) {
                if (Number.isInteger(replacement)) next.push(replacement);
            }
        } else {
            next.push(segIdx);
        }
    }
    if (!replaced) {
        for (const replacement of replacementSegIndices || []) {
            if (Number.isInteger(replacement)) next.push(replacement);
        }
    }
    osmIdToSegIndices.set(osmId, [...new Set(next.filter((segIdx) => {
        const seg = globalGraph.segments[segIdx];
        return seg && !seg.retired;
    }))]);
}

function collectActiveSegIndices(segIdx, out, seen) {
    if (!Number.isInteger(segIdx) || seen.has(segIdx)) return;
    seen.add(segIdx);
    const seg = globalGraph.segments[segIdx];
    if (!seg) return;
    if (seg.retired && Array.isArray(seg.replacementSegIndices)) {
        for (const replacement of seg.replacementSegIndices) collectActiveSegIndices(replacement, out, seen);
        return;
    }
    if (!seg.retired) out.push(segIdx);
}

function expandActiveSegIndices(segIndices) {
    const out = [];
    const seen = new Set();
    for (const segIdx of segIndices || []) collectActiveSegIndices(segIdx, out, seen);
    return out;
}

function projectPointOntoSegment(x, z, seg) {
    const lenSq = seg.dx * seg.dx + seg.dz * seg.dz;
    if (!(lenSq > 0)) return null;
    let t = ((x - seg.x0) * seg.dx + (z - seg.z0) * seg.dz) / lenSq;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const px = seg.x0 + seg.dx * t;
    const pz = seg.z0 + seg.dz * t;
    const dx = x - px;
    const dz = z - pz;
    return { t, x: px, z: pz, distanceM: Math.sqrt(dx * dx + dz * dz) };
}

function splitGraphSegmentAt(segIdx, x, z) {
    const seg = globalGraph.segments[segIdx];
    if (!seg || seg.retired) return null;
    const distFromStart = Math.sqrt((x - seg.x0) * (x - seg.x0) + (z - seg.z0) * (z - seg.z0));
    const distFromEnd = Math.sqrt((x - seg.x1) * (x - seg.x1) + (z - seg.z1) * (z - seg.z1));
    if (distFromStart <= PROPOSAL_SPLICE_MIN_SEGMENT_M) {
        return { x: seg.x0, z: seg.z0, key: seg.startKey };
    }
    if (distFromEnd <= PROPOSAL_SPLICE_MIN_SEGMENT_M) {
        return { x: seg.x1, z: seg.z1, key: seg.endKey };
    }
    const canForward = segmentAllowsDirection(segIdx, true);
    const canBackward = segmentAllowsDirection(segIdx, false);
    if (!canForward && !canBackward) return null;
    if (canForward) removeOutgoing(seg.startKey, segIdx, true);
    if (canBackward) removeOutgoing(seg.endKey, segIdx, false);
    seg.retired = true;
    const replacementSegIndices = [];
    const firstIdx = appendGraphSegment({
        x0: seg.x0,
        z0: seg.z0,
        x1: x,
        z1: z,
        speed: seg.speed,
        osmId: seg.osmId,
        formationOsmId: seg.formationOsmId,
        highway: seg.highway,
        chordIndex: seg.chordIndex,
        canForward,
        canBackward,
        laneCentersForward: seg.laneCentersForward,
        laneCentersBackward: seg.laneCentersBackward,
    });
    if (Number.isInteger(firstIdx)) replacementSegIndices.push(firstIdx);
    const secondIdx = appendGraphSegment({
        x0: x,
        z0: z,
        x1: seg.x1,
        z1: seg.z1,
        speed: seg.speed,
        osmId: seg.osmId,
        formationOsmId: seg.formationOsmId,
        highway: seg.highway,
        chordIndex: seg.chordIndex,
        canForward,
        canBackward,
        laneCentersForward: seg.laneCentersForward,
        laneCentersBackward: seg.laneCentersBackward,
    });
    if (Number.isInteger(secondIdx)) replacementSegIndices.push(secondIdx);
    seg.replacementSegIndices = replacementSegIndices;
    replaceSegIndexInOsmMapping(seg.osmId, segIdx, replacementSegIndices);
    return { x, z, key: nodeKey(x, z) };
}

function snapProposalPointToGraph(x, z) {
    let best = null;
    for (let segIdx = 0; segIdx < globalGraph.segments.length; segIdx++) {
        const seg = globalGraph.segments[segIdx];
        if (!seg || seg.retired) continue;
        const projection = projectPointOntoSegment(x, z, seg);
        if (!projection || projection.distanceM > PROPOSAL_SPLICE_TOLERANCE_M) continue;
        if (!best || projection.distanceM < best.distanceM) {
            best = { segIdx, ...projection };
        }
    }
    if (!best) return null;
    return splitGraphSegmentAt(best.segIdx, best.x, best.z);
}

function spliceProposalFeatureConnections(features) {
    if (!Array.isArray(features) || features.length === 0) return features;
    for (const feature of features) {
        const geom = feature && feature.geometry;
        const coords = geom && geom.type === 'LineString' ? geom.coordinates : null;
        if (!Array.isArray(coords) || coords.length < 2) continue;
        for (let i = 0; i < coords.length; i++) {
            const coord = coords[i];
            if (!Array.isArray(coord) || coord.length < 2) continue;
            const [lon, lat] = coord;
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
            const local = geoToGraphLocal(lat, lon);
            const snapped = snapProposalPointToGraph(local.x, local.z);
            if (!snapped) continue;
            const geo = graphLocalToGeo(snapped.x, snapped.z);
            coords[i] = [geo.lon, geo.lat];
        }
    }
    return features;
}

// Append a tile's features to the global graph (dedup by osm_id). Returns
// the segIndices belonging to this batch — including indices for already-
// loaded osm_ids so a re-fetched tile can still spawn fresh cars on its
// stretch of road.
function appendFeatureToGlobalGraph(feature, segIndicesInBatch, ownerKey = 'proposal:session') {
    const f = feature;
    const props = f.properties || {};
    const geom = f.geometry;
    if (!geom || geom.type !== 'LineString') return;
    const coords = geom.coordinates;
    if (!coords || coords.length < 2) return;
    const highway = props.highway || 'unclassified';
    if (!DRIVABLE_HIGHWAYS.has(highway)) return;

    trafficGraphOwnership.claim(ownerKey, props.osm_id);

    if (loadedOsmIds.has(props.osm_id)) {
        const existing = expandActiveSegIndices(osmIdToSegIndices.get(props.osm_id) || []);
        if (existing) for (const idx of existing) segIndicesInBatch.push(idx);
        return;
    }
    const ow = props.oneway;
    const oneway = ow === 'yes' || ow === '1' || ow === 'true';
    const onewayReversed = ow === '-1' || ow === 'reverse';
    const speed = SPEED_BY_HIGHWAY[highway] || DEFAULT_SPEED;
    const canForward = !onewayReversed;
    const canBackward = !oneway;
    const { laneCentersForward, laneCentersBackward } = getLaneCentersForFeatureProperties(props, canForward, canBackward);
    const idxsForOsm = [];

    try {
        for (let i = 0; i < coords.length - 1; i++) {
            const [lon0, lat0] = coords[i];
            const [lon1, lat1] = coords[i + 1];
            const p0 = geoToGraphLocal(lat0, lon0);
            const p1 = geoToGraphLocal(lat1, lon1);
            const segIdx = appendGraphSegment({
                x0: p0.x,
                z0: p0.z,
                x1: p1.x,
                z1: p1.z,
                speed,
                osmId: props.osm_id,
                formationOsmId: props.formation_osm_id ?? null,
                highway,
                chordIndex: i,
                canForward,
                canBackward,
                laneCentersForward,
                laneCentersBackward,
            });
            if (!Number.isInteger(segIdx)) continue;
            segIndicesInBatch.push(segIdx);
            idxsForOsm.push(segIdx);
        }
    } catch (error) {
        // A feature is the graph's commit unit. Do not poison loadedOsmIds
        // before every chord is appended, and retire only this feature's new
        // chords if one append fails.
        rollbackTileGraphSegments(idxsForOsm);
        throw error;
    }
    loadedOsmIds.add(props.osm_id);
    osmIdToSegIndices.set(props.osm_id, idxsForOsm);
}

function appendFeaturesToGlobalGraph(features, ownerKey = 'proposal:session') {
    const segIndicesInBatch = [];
    for (const feature of features) appendFeatureToGlobalGraph(feature, segIndicesInBatch, ownerKey);
    return segIndicesInBatch;
}

// Inject proposal-road centerlines into the same global graph the cadastre
// road tiles populate, so cars route across them like any other street.
// Each "line" in `lineStrings` is an Array<{lat, lng}>; we synthesise a
// LineString feature per line with a unique synthetic osm_id (proposal-
// scoped so cadastre IDs never collide), then feed the whole batch into
// the existing append + spawn pipeline. Highway type defaults to
// 'residential' (8 m/s drive speed); `isTrack` proposals are treated as
// non-drivable and skipped — they're tram corridors, not car roads.
export function addProposalRoadCenterlines(lineStrings, proposalId, opts) {
    const features = buildProposalRoadCenterlineFeatures(lineStrings, proposalId, opts);
    if (features.length === 0) return 0;
    if (!carsGroup || !baseRoadGraphPrimed) {
        pendingProposalRoadCenterlines.push(features);
        return 0;
    }
    return appendProposalRoadCenterlineFeatures(features);
}

function buildProposalRoadCenterlineFeatures(lineStrings, proposalId, opts) {
    if (!Array.isArray(lineStrings) || lineStrings.length === 0) return [];
    if (opts && opts.isTrack) return [];
    const highway = (opts && opts.highway) || 'residential';
    const features = [];
    for (let i = 0; i < lineStrings.length; i++) {
        const line = lineStrings[i];
        if (!Array.isArray(line) || line.length < 2) continue;
        const coords = [];
        for (const p of line) {
            const lat = p && (p.lat ?? p[1]);
            const lng = p && (p.lng ?? p.lon ?? p[0]);
            if (Number.isFinite(lat) && Number.isFinite(lng)) coords.push([lng, lat]);
        }
        if (coords.length < 2) continue;
        features.push({
            type: 'Feature',
            properties: {
                osm_id: `proposal-${proposalId}-line-${i}`,
                formation_osm_id: opts?.formationIds?.[i] ?? null,
                highway,
            },
            geometry: { type: 'LineString', coordinates: coords },
        });
    }
    return features;
}

function appendProposalRoadCenterlineFeatures(features) {
    if (!Array.isArray(features) || features.length === 0 || !carsGroup) return 0;
    spliceProposalFeatureConnections(features);
    const segIndices = appendFeaturesToGlobalGraph(features);
    if (segIndices.length > 0) {
        navigationMapContext.setRoadTile(`proposal:${features[0]?.properties?.osm_id}`, segIndices.map(index => globalGraph.segments[index]));
        spawnCarsOnSegments(segIndices, CARS_PER_TILE);
    }
    return segIndices.length;
}

function flushPendingProposalRoadCenterlines() {
    if (!carsGroup || pendingProposalRoadCenterlines.length === 0) return;
    const queuedBatches = pendingProposalRoadCenterlines;
    pendingProposalRoadCenterlines = [];
    for (const features of queuedBatches) {
        appendProposalRoadCenterlineFeatures(features);
    }
}

// Spawn up to `count` cars on a random subset of the given segIndices.
// Skips when the global cap is reached.
// 1-in-EMERGENCY_SPAWN_DENOM rolled per spawn → emergency vehicle override.
// Of those, EMERGENCY_LIGHTS_ON_FRAC are in active "lights + siren" mode;
// the rest are emergency-liveried but quiet (just driving, off duty / on
// the way somewhere).
const EMERGENCY_SPAWN_DENOM   = 50;
// 0.0625 = quarter of the previous 0.25. Now ~1/800 cars overall is
// sirening, which makes it a special spotting moment rather than
// part of the constant traffic ambience.
const EMERGENCY_LIGHTS_ON_FRAC = 0.0625;

function pickEmergencyType() {
    const liveries = ['ambulance', 'police'];
    const livery = liveries[Math.floor(Math.random() * liveries.length)];
    return VEHICLE_TYPES.find(t => t.livery === livery);
}

function trafficSpawnOccupants() {
    const occupants = [];
    const append = (car) => {
        const dimensions = trafficVehicleDimensions(car?.type);
        occupants.push({
            x: car?.x ?? car?.mesh?.position?.x,
            z: car?.z ?? car?.mesh?.position?.z,
            heading: car?.heading ?? car?.mesh?.rotation?.y,
            widthM: dimensions.widthM,
            lengthM: dimensions.lengthM,
        });
    };
    for (const car of globalCars) append(car);
    for (const car of wreckedCars) append(car);
    for (const car of parkedCars.values()) append(car);
    return occupants;
}

function trafficSpawnCandidate(x, z, heading, type) {
    return { x, z, heading, ...trafficVehicleDimensions(type) };
}

function spawnCarsOnSegments(segIndices, count) {
    const activeSegIndices = expandActiveSegIndices(segIndices);
    if (activeSegIndices.length === 0) return;
    let enemyCount = countEnemyCars();
    const spawnAmbientEnemies = ambientHostilesFn();
    const occupants = trafficSpawnOccupants();
    for (let i = 0; i < count; i++) {
        if (globalCars.length >= MAX_TOTAL_CARS) return;
        const segIdx = activeSegIndices[Math.floor(Math.random() * activeSegIndices.length)];
        const seg = globalGraph.segments[segIdx];
        if (!seg || seg.retired) continue;
        const startNode = globalGraph.nodes.get(seg.startKey);
        const endNode = globalGraph.nodes.get(seg.endKey);
        const canForward  = startNode && startNode.out.some(o => o.segIdx === segIdx && o.forward);
        const canBackward = endNode   && endNode.out.some(o => o.segIdx === segIdx && !o.forward);
        let forward;
        if (canForward && canBackward) forward = Math.random() < 0.5;
        else if (canForward)  forward = true;
        else if (canBackward) forward = false;
        else continue;

        const fx = forward ? seg.dx : -seg.dx;
        const fz = forward ? seg.dz : -seg.dz;
        const heading = Math.atan2(fx, fz);
        const t0 = Math.random();
        // Initial world position from parametric t plus right-hand lane
        // offset, so the car starts already in its lane (not on the
        // centreline). Bicycle integration takes over from here.
        const cx0 = seg.x0 + (seg.x1 - seg.x0) * t0;
        const cz0 = seg.z0 + (seg.z1 - seg.z0) * t0;
        const fLen0 = Math.sqrt(fx * fx + fz * fz) || 1;
        const ux0 = fx / fLen0, uz0 = fz / fLen0;
        const rx0 = -uz0, rz0 = ux0;
        const lane = chooseLaneStateForSegment(seg, forward);
        const spawnX = cx0 + rx0 * lane.offset;
        const spawnZ = cz0 + rz0 * lane.offset;
        if (pointInsideKeepClear(spawnX, spawnZ, trafficKeepClearVolumes)) continue;
        if (isPointInsideCorridorFootprints(spawnX, spawnZ, plannerOpenCutVolumes, 1.2)) continue;

        const isEnemy = spawnAmbientEnemies && enemyCount < MAX_ENEMY_VEHICLES &&
            Math.random() < (1 / ENEMY_SPAWN_DENOM);
        const isEmergency = !isEnemy && Math.random() < (1 / EMERGENCY_SPAWN_DENOM);
        const type = isEnemy ? pickEnemyType() : (isEmergency ? pickEmergencyType() : pickVehicleType());
        if (!type) continue;
        const spawnCandidate = trafficSpawnCandidate(spawnX, spawnZ, heading, type);
        if (!trafficSpawnHasClearance(spawnCandidate, occupants)) continue;
        const hex = type.paintHex != null ? type.paintHex : CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)];
        const mesh = buildTrafficVehicleMesh(type, hex);
        carsGroup.add(mesh);
        const maxHealth = maxHealthForCarType(type);
        const car = {
            id: `traffic:${nextTrafficCarId++}`,
            segIdx, forward, t: t0, mesh, heading,
            type, bodyHex: hex,
            nextSegIdx: null, nextForward: null,
            prevSegIdx: null, prevForward: null,
            laneRank: lane.rank,
            laneOffsetBase: lane.offset,
            // Bicycle-model state. x/z are integrated from speed + heading
            // (no longer derived from car.t each frame); car.t is kept as
            // the parametric "intended progress" used by inter-car spacing.
            x: spawnX,
            z: spawnZ,
            speed: seg.speed * (Number(type.speedFactor) || 1) * 0.5,
            maxHealth,
            health: maxHealth,
            enemy: isEnemy,
            enemyNextShotAt: isEnemy ? (performance.now() / 1000) + Math.random() * 2.0 : null,
            enemyBurstRemaining: 0,
            enemyLosCache: isEnemy ? {} : null,
            enemyMusicTrackIndex: isEnemy ? Math.floor(Math.random() * getEnemyMusicTrackCount()) : 0,
            // Emergency-mode flag: only meaningful for liveried vehicles.
            // Drives lightbar flash + siren playback.
            emergency: isEmergency && Math.random() < EMERGENCY_LIGHTS_ON_FRAC,
        };
        pickAndCacheNext(car, globalGraph);
        // Place mesh at initial bicycle position so first-frame spacing
        // queries see the right location.
        placeCarOnTerrain(car);
        globalCars.push(car);
        occupants.push(spawnCandidate);
        if (isEnemy) enemyCount++;
    }
}

// A scripted wave can be requested before the deferred traffic layer has
// delivered its first roads. Resolve on graph publication, with bounded failure
// and teardown, instead of treating an in-flight graph as an empty map.
export function waitForTrafficRoadsNear(centerX, centerZ, radius, { timeoutMs = 15000 } = {}) {
    const available = () => globalGraph.segments.some(seg => seg && !seg.retired
        && Math.hypot((seg.x0 + seg.x1) / 2 - centerX, (seg.z0 + seg.z1) / 2 - centerZ) <= radius);
    if (available()) return Promise.resolve(true);
    return new Promise(resolve => {
        const waiter = {
            check() { if (available()) waiter.finish(true); },
            finish(ready) {
                clearTimeout(timer);
                trafficRoadReadinessWaiters.delete(waiter);
                resolve(ready);
            },
        };
        const timer = setTimeout(() => waiter.finish(false), timeoutMs);
        trafficRoadReadinessWaiters.add(waiter);
    });
}

// Force-spawn a wave of enemy technicals on road segments within `radius`
// metres of (centerX, centerZ). Bypasses the random ENEMY_SPAWN_DENOM
// gate; still respects MAX_ENEMY_VEHICLES + MAX_TOTAL_CARS. Returns the
// number of enemies actually spawned (0 if no nearby segments or caps hit).
// Used by the Quest 3 "retake Crnomerec" defensive hold to apply pressure
// while the player is parked at the terminus.
// Campaign encounters only. Declaring the pursuit is what turns spawned enemy
// cars from armed traffic into a chase: their junction choices start closing on
// the player, and the wave holds its authored strength until it is stopped.
export function beginEncounterPursuit({ encounterId, count, radiusM } = {}) {
    const id = String(encounterId || '').trim();
    const want = Math.max(0, Math.trunc(Number(count) || 0));
    if (!id || !want) return false;
    activePursuit = {
        encounterId: id,
        count: want,
        radiusM: Math.max(60, Number(radiusM) || 240),
        lastSpawnS: performance.now() / 1000,
    };
    return true;
}

export function endEncounterPursuit() {
    activePursuit = null;
}

export function spawnEnemyWaveNear(centerX, centerZ, radius, count, { encounterId = null, diagnostics = {} } = {}) {
    Object.assign(diagnostics, { attempts: 0, nearbySegments: 0, rejected: {}, stopReason: null });
    const reject = reason => { diagnostics.rejected[reason] = (diagnostics.rejected[reason] || 0) + 1; };
    const finish = (count, reason) => { diagnostics.stopReason = reason; return count; };
    if (!carsGroup || !globalGraph) return finish(0, 'roads-unavailable');
    if (!isGameModeFn || !isGameModeFn()) return finish(0, 'game-mode-inactive');
    const r2 = radius * radius;
    const inRange = [];
    for (let i = 0; i < globalGraph.segments.length; i++) {
        const seg = globalGraph.segments[i];
        if (!seg || seg.retired) continue;
        const cx = (seg.x0 + seg.x1) * 0.5;
        const cz = (seg.z0 + seg.z1) * 0.5;
        const dx = cx - centerX;
        const dz = cz - centerZ;
        if (dx * dx + dz * dz <= r2) inRange.push(i);
    }
    diagnostics.nearbySegments = inRange.length;
    if (inRange.length === 0) return finish(0, 'no-nearby-roads');

    let enemyCount = countEnemyCars();
    let spawned = 0;
    const occupants = trafficSpawnOccupants();
    // Failed placement is an attempt, not a spawned pursuer. Keep the work
    // bounded while allowing blocked lanes to yield to other nearby streets.
    const maxAttempts = Math.min(256, Math.max(32, count * 24));
    for (let i = 0; i < maxAttempts && spawned < count; i++) {
        if (globalCars.length >= MAX_TOTAL_CARS) return finish(spawned, 'traffic-cap');
        if (enemyCount >= MAX_ENEMY_VEHICLES) return finish(spawned, 'enemy-cap');
        diagnostics.attempts += 1;
        const segIdx = inRange[Math.floor(Math.random() * inRange.length)];
        const seg = globalGraph.segments[segIdx];
        if (!seg || seg.retired) { reject('retired-road'); continue; }
        const startNode = globalGraph.nodes.get(seg.startKey);
        const endNode = globalGraph.nodes.get(seg.endKey);
        const canForward  = startNode && startNode.out.some(o => o.segIdx === segIdx && o.forward);
        const canBackward = endNode   && endNode.out.some(o => o.segIdx === segIdx && !o.forward);
        let forward;
        if (canForward && canBackward) forward = Math.random() < 0.5;
        else if (canForward)  forward = true;
        else if (canBackward) forward = false;
        else { reject('no-travel-direction'); continue; }

        const fx = forward ? seg.dx : -seg.dx;
        const fz = forward ? seg.dz : -seg.dz;
        const heading = Math.atan2(fx, fz);
        const t0 = Math.random();
        const cx0 = seg.x0 + (seg.x1 - seg.x0) * t0;
        const cz0 = seg.z0 + (seg.z1 - seg.z0) * t0;
        const fLen0 = Math.sqrt(fx * fx + fz * fz) || 1;
        const ux0 = fx / fLen0, uz0 = fz / fLen0;
        const rx0 = -uz0, rz0 = ux0;
        const lane = chooseLaneStateForSegment(seg, forward);
        const spawnX = cx0 + rx0 * lane.offset;
        const spawnZ = cz0 + rz0 * lane.offset;
        if (pointInsideKeepClear(spawnX, spawnZ, trafficKeepClearVolumes)) { reject('keep-clear'); continue; }
        if (isPointInsideCorridorFootprints(spawnX, spawnZ, plannerOpenCutVolumes, 1.2)) { reject('open-cut'); continue; }

        const type = pickEnemyType();
        if (!type) { reject('no-vehicle-type'); continue; }
        const spawnCandidate = trafficSpawnCandidate(spawnX, spawnZ, heading, type);
        if (!trafficSpawnHasClearance(spawnCandidate, occupants)) { reject('occupied'); continue; }
        const hex = type.paintHex != null ? type.paintHex : CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)];
        const mesh = buildTrafficVehicleMesh(type, hex);
        carsGroup.add(mesh);
        const maxHealth = maxHealthForCarType(type);
        const car = {
            id: `traffic:${nextTrafficCarId++}`,
            segIdx, forward, t: t0, mesh, heading,
            type, bodyHex: hex,
            nextSegIdx: null, nextForward: null,
            prevSegIdx: null, prevForward: null,
            laneRank: lane.rank,
            laneOffsetBase: lane.offset,
            x: spawnX,
            z: spawnZ,
            speed: seg.speed * 0.5,
            maxHealth,
            health: maxHealth,
            enemy: true,
            encounterId,
            enemyNextShotAt: (performance.now() / 1000) + Math.random() * 1.2,
            enemyBurstRemaining: 0,
            enemyLosCache: {},
            enemyMusicTrackIndex: Math.floor(Math.random() * getEnemyMusicTrackCount()),
            emergency: false,
        };
        pickAndCacheNext(car, globalGraph);
        placeCarOnTerrain(car);
        globalCars.push(car);
        occupants.push(spawnCandidate);
        enemyCount++;
        spawned++;
    }
    return finish(spawned, spawned >= count ? 'complete' : 'attempt-limit');
}

// A gallery return rebuilds vehicles through the ordinary traffic layer. Route
// references are geographic, so a newly centred session never reuses old indices.
function snapshotEncounterRoute(index) {
    const segment = globalGraph?.segments[index];
    if (!segment || segment.retired) return null;
    return {
        osmId: segment.osmId,
        start: graphLocalToGeo(segment.x0, segment.z0),
        end: graphLocalToGeo(segment.x1, segment.z1),
    };
}

function restoreEncounterRoute(route) {
    if (!route) return null;
    const a = geoToGraphLocal(route.start.lat, route.start.lon);
    const b = geoToGraphLocal(route.end.lat, route.end.lon);
    const candidates = osmIdToSegIndices.get(route.osmId) || [];
    return candidates.find(index => {
        const segment = globalGraph.segments[index];
        return segment && !segment.retired
            && Math.hypot(segment.x0 - a.x, segment.z0 - a.z) < 0.1
            && Math.hypot(segment.x1 - b.x, segment.z1 - b.z) < 0.1;
    }) ?? null;
}

export function getEnemyEncounterSnapshot(encounterId) {
    const now = performance.now() / 1000;
    return globalCars.filter(car => car.enemy && car.encounterId === encounterId).map(car => ({
        ...graphLocalToGeo(car.x, car.z),
        type: structuredClone(car.type), bodyHex: car.bodyHex,
        route: snapshotEncounterRoute(car.segIdx),
        nextRoute: snapshotEncounterRoute(car.nextSegIdx), nextForward: car.nextForward,
        previousRoute: snapshotEncounterRoute(car.prevSegIdx), prevForward: car.prevForward,
        forward: car.forward, t: car.t, heading: car.heading, speed: car.speed,
        laneRank: car.laneRank, laneOffsetBase: car.laneOffsetBase,
        swerveOffset: car.swerveOffset || 0, health: car.health, maxHealth: car.maxHealth,
        nextShotInSeconds: Math.max(0, (car.enemyNextShotAt ?? now) - now),
        enemyBurstRemaining: car.enemyBurstRemaining,
        enemyMusicTrackIndex: car.enemyMusicTrackIndex,
    }));
}

export function restoreEnemyEncounterSnapshot(encounterId, rows) {
    if (!Array.isArray(rows) || !carsGroup || !globalGraph) return false;
    const restored = rows.map(row => ({
        row, segIdx: restoreEncounterRoute(row.route),
        nextSegIdx: restoreEncounterRoute(row.nextRoute),
        prevSegIdx: restoreEncounterRoute(row.previousRoute),
    }));
    if (restored.some(item => item.segIdx == null
        || (item.row.nextRoute && item.nextSegIdx == null)
        || (item.row.previousRoute && item.prevSegIdx == null))) return false;
    // Publish atomically after all original streets exist. No random replacement
    // wave or alternate route is an acceptable substitute for a saved encounter.
    for (const pool of [globalCars, wreckedCars]) {
        for (let i = pool.length - 1; i >= 0; i--) {
            const car = pool[i];
            if (car.encounterId !== encounterId) continue;
            car.mesh.parent?.remove(car.mesh);
            disposeCarRuntimeResources(car);
            pool.splice(i, 1);
        }
    }
    const now = performance.now() / 1000;
    for (const { row, segIdx, nextSegIdx, prevSegIdx } of restored) {
        const local = geoToGraphLocal(row.lat, row.lon);
        const mesh = buildTrafficVehicleMesh(row.type, row.bodyHex);
        const car = {
            id: `traffic:${nextTrafficCarId++}`, mesh, type: row.type, bodyHex: row.bodyHex,
            ...local, segIdx, nextSegIdx, prevSegIdx,
            nextForward: row.nextForward, prevForward: row.prevForward,
            forward: row.forward, t: row.t, heading: row.heading, speed: row.speed,
            laneRank: row.laneRank, laneOffsetBase: row.laneOffsetBase,
            swerveOffset: row.swerveOffset, health: row.health, maxHealth: row.maxHealth,
            encounterId, enemy: true, emergency: false,
            enemyNextShotAt: now + row.nextShotInSeconds,
            enemyBurstRemaining: row.enemyBurstRemaining,
            enemyMusicTrackIndex: row.enemyMusicTrackIndex, enemyLosCache: {},
        };
        carsGroup.add(mesh);
        placeCarOnTerrain(car);
        globalCars.push(car);
    }
    return true;
}

export function stopCampaignEnemyEncounter(encounterId = null) {
    let stopped = 0;
    // Encounter vehicles are owned by that encounter. Turning them into
    // ambient traffic retained their bodies and filled the next Retry's spawn
    // space. Dispose that ownership without touching unrelated road users.
    const belongs = car => car?.encounterId
        && (encounterId == null || car.encounterId === encounterId);
    for (const pool of [globalCars, wreckedCars]) {
        for (let i = pool.length - 1; i >= 0; i--) {
            const car = pool[i];
            if (!belongs(car)) continue;
            car.mesh?.parent?.remove(car.mesh);
            disposeCarRuntimeResources(car);
            pool.splice(i, 1);
            stopped += 1;
        }
    }
    for (let i = liveEnemyBullets.length - 1; i >= 0; i--) {
        const bullet = liveEnemyBullets[i];
        if (!belongs(bullet.owner)) continue;
        bullet.mesh?.parent?.remove(bullet.mesh);
        liveEnemyBullets.splice(i, 1);
    }
    return stopped;
}

export function getCarGraphDebugNodeNear(lat, lon, radiusM = 2) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !(radiusM > 0)) return null;
    const target = geoToGraphLocal(lat, lon);
    let best = null;
    for (const [key, node] of globalGraph.nodes.entries()) {
        const outgoing = getActiveOutgoing(node);
        if (outgoing.length === 0) continue;
        const local = nodeKeyToLocal(key);
        const dx = local.x - target.x;
        const dz = local.z - target.z;
        const distanceM = Math.sqrt(dx * dx + dz * dz);
        if (distanceM > radiusM) continue;
        if (!best || distanceM < best.distanceM) {
            best = {
                key,
                x: local.x,
                z: local.z,
                distanceM,
                outCount: outgoing.length,
                segIndices: [...new Set(outgoing.map((entry) => entry.segIdx))].sort((a, b) => a - b),
            };
        }
    }
    return best;
}

export function getCarGraphDebugSegmentCounts() {
    let retired = 0;
    for (const seg of globalGraph.segments) {
        if (seg && seg.retired) retired++;
    }
    return {
        total: globalGraph.segments.length,
        retired,
        active: globalGraph.segments.length - retired,
    };
}

// Returns null when the only "next segment" would be a U-turn back onto
// the segment we just came from — caller despawns the car in that case.
function pickNextSegment(currentSegIdx, currentForward, graph, pursuitTarget = null) {
    const seg = graph.segments[currentSegIdx];
    const exitKey = currentForward ? seg.endKey : seg.startKey;
    const node = graph.nodes.get(exitKey);
    if (!node) return null;
    const candidates = getActiveOutgoing(node).filter((entry) => entry.segIdx !== currentSegIdx);
    if (candidates.length === 0) return null;
    if (pursuitTarget) {
        // Where each exit leaves the car once it has run the segment out.
        const exits = candidates.map((entry) => {
            const next = graph.segments[entry.segIdx];
            return {
                entry,
                x: entry.forward ? next.x1 : next.x0,
                z: entry.forward ? next.z1 : next.z0,
            };
        });
        const chosen = choosePursuitExit(exits, pursuitTarget, { spread: PURSUIT_SPREAD_M });
        if (chosen) return chosen.entry;
    }
    return candidates[Math.floor(Math.random() * candidates.length)];
}

// Cache the upcoming segment on the car so the path-fillet logic can
// preview the next corner. Called on spawn and after each transition.
function pickAndCacheNext(car, graph) {
    // Only an authored encounter's cars hunt. Free-roam hostiles keep their
    // ambient wander, so campaign pursuit cannot change how game mode plays
    // outside the campaign.
    const next = pickNextSegment(
        car.segIdx,
        car.forward,
        graph,
        car.enemy && car.encounterId ? getPlayerTramTarget() : null,
    );
    if (next) {
        car.nextSegIdx = next.segIdx;
        car.nextForward = next.forward;
    } else {
        car.nextSegIdx = null;
        car.nextForward = null;
    }
}

// Quadratic Bezier through (P0, P1, P2) where P0 sits FILLET_M back from
// the junction along segA in travel direction, P1 IS the junction, and P2
// sits FILLET_M forward into segB in travel direction. Returns position
// (x, z) and tangent (tx, tz) at curve parameter s ∈ [0, 1].
function computeBezierAt(s, segA, forwardA, segB, forwardB) {
    const tP0 = forwardA
        ? Math.max(0, 1 - FILLET_M / segA.length)
        : Math.min(1, FILLET_M / segA.length);
    const P0x = segA.x0 + (segA.x1 - segA.x0) * tP0;
    const P0z = segA.z0 + (segA.z1 - segA.z0) * tP0;
    const tP1 = forwardA ? 1 : 0;
    const P1x = segA.x0 + (segA.x1 - segA.x0) * tP1;
    const P1z = segA.z0 + (segA.z1 - segA.z0) * tP1;
    const tP2 = forwardB
        ? Math.min(1, FILLET_M / segB.length)
        : Math.max(0, 1 - FILLET_M / segB.length);
    const P2x = segB.x0 + (segB.x1 - segB.x0) * tP2;
    const P2z = segB.z0 + (segB.z1 - segB.z0) * tP2;
    const om = 1 - s;
    const x  = om * om * P0x + 2 * s * om * P1x + s * s * P2x;
    const z  = om * om * P0z + 2 * s * om * P1z + s * s * P2z;
    const tx = 2 * om * (P1x - P0x) + 2 * s * (P2x - P1x);
    const tz = 2 * om * (P1z - P0z) + 2 * s * (P2z - P1z);
    return { x, z, tx, tz };
}

// Returns true when the car should despawn (dead-end / no non-U-turn exit).
// Returns {x, z, tx, tz} for a (segIdx, t, forward, prev*, next*) state,
// honouring Bezier corner fillets in the same way updateCar does for
// the car's CURRENT position. Extracted so the lookahead helper can
// reuse the exact same path geometry the car is following.
function pathPointAt(graph, segIdx, t, forward, prevSegIdx, prevForward, nextSegIdx, nextForward) {
    const seg = graph.segments[segIdx];
    const distInTravel = forward ? t * seg.length : (1 - t) * seg.length;
    const distFromEnd  = seg.length - distInTravel;
    if (prevSegIdx != null && distInTravel < FILLET_M) {
        const s = 0.5 + Math.min(distInTravel, FILLET_M) / (2 * FILLET_M);
        return computeBezierAt(s, graph.segments[prevSegIdx], prevForward, seg, forward);
    }
    if (nextSegIdx != null && distFromEnd < FILLET_M) {
        const s = (FILLET_M - distFromEnd) / (2 * FILLET_M);
        return computeBezierAt(s, seg, forward, graph.segments[nextSegIdx], nextForward);
    }
    return {
        x: seg.x0 + (seg.x1 - seg.x0) * t,
        z: seg.z0 + (seg.z1 - seg.z0) * t,
        tx: forward ? seg.dx : -seg.dx,
        tz: forward ? seg.dz : -seg.dz,
    };
}

// Walk `distM` metres forward along the path from the car's current
// (segIdx, t, forward) — possibly crossing one segment boundary — and
// return the world-space lookahead point WITH the same lane offset the
// car is using. This is the goal point for pure-pursuit steering. We
// don't mutate the car; we just look ahead.
function pathLookahead(car, graph, distM) {
    let segIdx = car.segIdx;
    let forward = car.forward;
    let seg = graph.segments[segIdx];
    let t = car.t;
    // Walk along the path. Up to ~3 segments is plenty given typical
    // segment lengths (>15 m) vs lookahead (≤ ~20 m).
    let prevSegIdx = car.prevSegIdx;
    let prevForward = car.prevForward;
    let nextSegIdx = car.nextSegIdx;
    let nextForward = car.nextForward;
    let remaining = distM;
    while (remaining > 0) {
        const distToEnd = forward ? (1 - t) * seg.length : t * seg.length;
        if (remaining <= distToEnd) {
            t += (forward ? 1 : -1) * remaining / seg.length;
            remaining = 0;
            break;
        }
        remaining -= distToEnd;
        if (nextSegIdx == null) {
            // No more path — clamp at end of current segment.
            t = forward ? 1 : 0;
            break;
        }
        // Step into the next segment.
        prevSegIdx = segIdx; prevForward = forward;
        segIdx = nextSegIdx; forward = nextForward;
        seg = graph.segments[segIdx];
        t = forward ? 0 : 1;
        // Look one further hop for fillet computations on the new segment.
        const next = pickNextSegment(segIdx, forward, graph);
        nextSegIdx = next ? next.segIdx : null;
        nextForward = next ? next.forward : null;
    }
    const r = pathPointAt(graph, segIdx, t, forward, prevSegIdx, prevForward, nextSegIdx, nextForward);
    // Apply the same lane offset the car is using so we steer toward
    // its lane, not the centreline.
    const fLen = Math.sqrt(r.tx * r.tx + r.tz * r.tz) || 1;
    const rx = -r.tz / fLen, rz = r.tx / fLen;
    const offset = getCarLaneOffset(car);
    return { x: r.x + rx * offset, z: r.z + rz * offset };
}

function updateCar(car, graph, dt, speedFactor, { publishMesh = true } = {}) {
    if (publishMesh) {
        const routeSegment = graph.segments[car.segIdx] || null;
        const routeY = terrainHeightAtLocal(
            car.x,
            car.z,
            routeSegment,
            routeSegment?.highway ?? null,
        );
        if (routeY === null) {
            car.terrainReady = false;
            car.mesh.visible = false;
            return false;
        }
    }
    let seg = graph.segments[car.segIdx];

    // Advance parametric progress from CURRENT speed (one frame stale, fine).
    // Spacing logic in updateGlobalCars uses car.t to detect "car ahead in
    // the same lane", so it still represents intended progress along the
    // road regardless of how the bicycle integration is doing.
    car.t += (car.forward ? 1 : -1) * (car.speed * dt) / seg.length;

    if ((car.forward && car.t >= 1) || (!car.forward && car.t <= 0)) {
        if (car.nextSegIdx == null) return true;
        const overshoot = car.forward ? (car.t - 1) * seg.length : -car.t * seg.length;
        car.prevSegIdx = car.segIdx;
        car.prevForward = car.forward;
        car.segIdx = car.nextSegIdx;
        car.forward = car.nextForward;
        seg = graph.segments[car.segIdx];
        assignCarLaneForSegment(car, seg);
        car.t = car.forward
            ? Math.min(1, overshoot / seg.length)
            : Math.max(0, 1 - overshoot / seg.length);
        pickAndCacheNext(car, graph);
    }

    // Forget the previous segment once we're past the post-junction fillet
    // (so pathLookahead doesn't keep referencing it).
    const distInTravel = car.forward ? car.t * seg.length : (1 - car.t) * seg.length;
    if (car.prevSegIdx != null && distInTravel >= FILLET_M) {
        car.prevSegIdx = null;
        car.prevForward = null;
    }

    // ── Pure-pursuit steering toward a lookahead point on the path ──────
    // Lookahead grows with speed so a 50 km/h car aims further ahead than
    // a 10 km/h one — gives smoother, less jittery cornering.
    const lookaheadDist = LOOKAHEAD_BASE_M + car.speed * LOOKAHEAD_PER_SPEED_S;
    const goal = pathLookahead(car, graph, lookaheadDist);
    const sinH = Math.sin(car.heading);
    const cosH = Math.cos(car.heading);
    const gdx = goal.x - car.x;
    const gdz = goal.z - car.z;
    // Project goal vector into car-local frame: forward = +Z, right = +X.
    const fwdComp   = gdx * sinH + gdz * cosH;
    const rightComp = gdx * cosH - gdz * sinH;
    const goalDist  = Math.max(0.5, Math.sqrt(gdx * gdx + gdz * gdz));
    const alpha = Math.atan2(rightComp, fwdComp);
    let steer = Math.atan2(2 * WHEELBASE_M * Math.sin(alpha), goalDist);
    if (steer >  MAX_STEER_RAD) steer =  MAX_STEER_RAD;
    if (steer < -MAX_STEER_RAD) steer = -MAX_STEER_RAD;

    // ── Speed: capped by curvature so cars naturally slow into corners ──
    const curvature = Math.abs(Math.tan(steer)) / WHEELBASE_M;
    const vCurveMax = curvature > 1e-3
        ? Math.sqrt(MAX_LAT_ACCEL_MPS2 / curvature)
        : Infinity;
    const targetSpeed = Math.min(
        seg.speed
            * (Number(car.type?.speedFactor) || 1)
            * (speedFactor != null ? speedFactor : 1),
        vCurveMax,
    );
    const dv = targetSpeed - car.speed;
    const accelStep = (dv > 0 ? ACCEL_LIMIT_MPS2 : DECEL_LIMIT_MPS2) * dt;
    car.speed = Math.abs(dv) <= accelStep
        ? targetSpeed
        : car.speed + Math.sign(dv) * accelStep;
    if (car.speed < 0) car.speed = 0;

    // ── Bicycle integration: heading curves with steering, position
    //    advances along chassis heading at current speed. The mesh tracks
    //    state, no independent position-set or heading-lerp.
    const previousX = car.x;
    const previousZ = car.z;
    const previousHeading = car.heading;
    const dHeading = (car.speed / WHEELBASE_M) * Math.tan(steer) * dt;
    car.heading += dHeading;
    car.x += car.speed * Math.sin(car.heading) * dt;
    car.z += car.speed * Math.cos(car.heading) * dt;

    // Hard safety boundary behind the player tram. The long following ramp
    // handles normal braking, while this catches a car spawned unusually
    // close or a long frame that would otherwise step across the six-metre
    // buffer before deceleration completes.
    const playerTramBox = _tramBoxes.find((box) => box.isPlayer);
    const nextTramGap = computeCarGapToTram(car.x, car.z, car.heading, playerTramBox);
    if (nextTramGap !== Infinity && nextTramGap < 0) {
        car.x = previousX;
        car.z = previousZ;
        car.heading = previousHeading;
        car.speed = Math.min(car.speed, Math.max(0, playerTramSpeedKmh / 3.6));
    }

    // Exposed -1 ramps and planner stations reserve physical space. Remove
    // traffic before publishing a pose inside either footprint, so cars can
    // neither hang over a trench nor drive through stairs/platforms.
    if (isPointInsideCorridorFootprints(car.x, car.z, plannerOpenCutVolumes, 1.2)) {
        return true;
    }

    // The bicycle model can cut inside a tight corner even when both road
    // centrelines are valid. Sweep the complete chassis against the loaded
    // building footprint index before publishing the new pose. A car that
    // reaches a wall despawns at the previous valid position rather than ever
    // appearing inside the building; detected courtyard passages are exempt.
    const halfWidth = Math.max(0.4, (car.type?.width || 1.8) * 0.5);
    const halfLength = Math.max(1.2, (car.type?.length || 4.5) * 0.5);
    if (vehicleSweepIntersectsLoadedBuilding(
        previousX,
        previousZ,
        car.x,
        car.z,
        car.heading,
        halfWidth,
        halfLength,
    )) {
        car.x = previousX;
        car.z = previousZ;
        car.heading = previousHeading;
        car.speed = 0;
        return true;
    }

    if (publishMesh) {
        placeCarOnTerrain(car);
        updateCarHealthBarVisibility(car);
    }
    return false;
}

function updatePromotedTrafficRoute(car, graph, dt, speedFactor) {
    const actual = {
        x: car.x,
        z: car.z,
        heading: car.heading,
        speed: car.speed,
    };
    const target = car.physicsRouteTarget || {
        x: car.x,
        z: car.z,
        heading: car.heading,
        speedMps: car.speed,
    };
    if (!promotedTrafficRouteMayAdvance({
        actual,
        target,
        tuning: GTA_TRAFFIC_TUNING,
    })) return false;
    car.x = target.x;
    car.z = target.z;
    car.heading = target.heading;
    car.speed = Math.max(0, Number(target.speedMps) || 0);
    const routeEnded = updateCar(car, graph, dt, speedFactor, { publishMesh: false });
    car.physicsRouteTarget = {
        x: car.x,
        z: car.z,
        heading: car.heading,
        speedMps: routeEnded ? 0 : car.speed,
    };
    car.physicsRouteEnded = routeEnded;
    car.x = actual.x;
    car.z = actual.z;
    car.heading = actual.heading;
    car.speed = actual.speed;
    return false;
}

// Per-frame across the global car pool: build (segment, direction) → sorted
// occupants for inter-car spacing, derive per-car speed factor, then run
// updateCar. Despawns cars that hit a dead-end (updateCar returns true) OR
// wander past DESPAWN_DISTANCE_M from the camera.
//
// Wrecks are inserted into the lane occupancy map alongside live cars so
// trailing traffic brakes for them. Cars that detect a wreck close ahead
// also activate a lateral swerve (car.swerveOffset) that pulls them into
// the oncoming-lane area enough to drive AROUND the wreck rather than
// piling up behind it forever. Other trams remain crossing/swerve obstacles;
// the player tram is treated as a lead vehicle so following traffic queues
// behind it instead of trying to pass through its rear body.
function updateGlobalCars(dt, localX, localZ) {
    // Sub-pass timing. This function spiked to ~300 ms against a median of 0.2 ms
    // and 'cars:update' cannot say which of its six passes did it — the same
    // problem one label per layer had. Also reports the populations, because every
    // pass here is O(cars) or O(wrecks) and the grid's own comment assumes ~50.
    const tStart = performance.now();
    let mark = tStart;
    const notePass = (name) => {
        const now = performance.now();
        recordLayerFrameMs(name, now - mark);
        mark = now;
    };
    const lanes = new Map();
    for (const car of globalCars) {
        if (car.terrainReady === false) continue;
        const seg = globalGraph.segments[car.segIdx];
        if (!seg) continue;
        const posM = car.forward ? car.t * seg.length : (1 - car.t) * seg.length;
        const key = car.segIdx + (car.forward ? 'F' : 'B') + ':' + (car.laneRank ?? 0);
        let arr = lanes.get(key);
        if (!arr) { arr = []; lanes.set(key, arr); }
        arr.push({ car, posM, isWreck: false });
    }
    for (const wreck of wreckedCars) {
        const seg = globalGraph.segments[wreck.segIdx];
        if (!seg) continue;
        const posM = wreck.forward ? wreck.t * seg.length : (1 - wreck.t) * seg.length;
        const key = wreck.segIdx + (wreck.forward ? 'F' : 'B') + ':' + (wreck.laneRank ?? 0);
        let arr = lanes.get(key);
        if (!arr) { arr = []; lanes.set(key, arr); }
        arr.push({ car: wreck, posM, isWreck: true });
    }

    notePass('carsUpd:bin');
    const speedFactor = new Map();
    // Per car: nearest wreck ahead in its own lane, and the gap to it.
    // Used to drive the swerve maneuver. Live cars ahead don't trigger
    // the swerve — they'll move out of the way on their own.
    const wreckAheadGap = new Map();
    for (const arr of lanes.values()) {
        arr.sort((a, b) => a.posM - b.posM);
        for (let i = 0; i < arr.length; i++) {
            const me = arr[i];
            if (me.isWreck) continue;       // wrecks don't compute their own speed
            if (i === arr.length - 1) {
                speedFactor.set(me.car, 1);
                continue;
            }
            const next = arr[i + 1];
            const gap = next.posM - me.posM - CAR_BUFFER_M;
            const factor = gap >= BRAKE_RAMP_M ? 1
                          : gap <= 0 ? 0
                          : gap / BRAKE_RAMP_M;
            speedFactor.set(me.car, factor);
            // Record nearest wreck for swerve targeting. Walk forward
            // past any live cars to find the first wreck within range —
            // a queue of stopped cars behind a wreck should still know
            // about the wreck so they all start swerving together.
            for (let j = i + 1; j < arr.length; j++) {
                if (arr[j].isWreck) {
                    const wgap = arr[j].posM - me.posM - CAR_BUFFER_M;
                    if (wgap <= SWERVE_DETECT_M) wreckAheadGap.set(me.car, Math.max(0, wgap));
                    break;
                }
            }
        }
    }

    // Cross-lane proximity brake. The per-lane gap above only sees cars
    // queueing on the SAME segment+direction, so cars on intersecting
    // segments (a 90° intersection, a swerver crossing into oncoming) used
    // to drive through each other. Treat every other car/wreck as a ~5 m
    // box centred on its (x, z); for each car, brake if any other box
    // sits in our forward arc within CROSS_BRAKE_DIST_M.
    //
    // Spatial grid: bin all obstacles into 10 m cells once per fixed step, then
    // each car only checks its own cell + 8 neighbours instead of every
    // other car. For ~50 cars across a city radius, this drops the per-
    // frame cost from O(n²) ≈ 2500 to roughly O(n × k) ≈ 50×3 = 150 tests.
    const CROSS_BRAKE_DIST_M = 5.0;       // forward look-ahead for box test
    notePass('carsUpd:laneGaps');
    const CROSS_BOX_HALF_WIDTH_M = 1.6;   // perpendicular tolerance (≈ car width)
    const CROSS_BOX_HALF_LENGTH_M = 2.5;  // half-length of each car's "box"
    // Cell size must be ≥ search radius so a single layer of neighbour
    // cells captures every candidate. Search radius = forward look-ahead
    // + both half-lengths = 5 + 5 = 10 m.
    trafficObstacleIndex.clear();
    // Authored parked cars used to be absent here. Ambient cars therefore
    // drove into the campaign getaway sedan and Rapier promoted the overlap
    // into a hard collision before the player could leave the station.
    for (const obstacle of trafficObstaclePopulation({
        moving: globalCars,
        wrecked: wreckedCars,
        parked: parkedCars.values(),
    })) {
        trafficObstacleIndex.add(obstacle, obstacle.x, obstacle.z);
    }

    const obstacleSearchRadiusM = CROSS_BRAKE_DIST_M + CROSS_BOX_HALF_LENGTH_M * 2;
    for (const car of globalCars) {
        if (car.terrainReady === false) continue;
        if (!Number.isFinite(car.heading)) continue;
        const fx = Math.sin(car.heading);
        const fz = Math.cos(car.heading);
        let nearestGap = Infinity;
        trafficObstacleIndex.forEachInBounds(
            car.x - obstacleSearchRadiusM,
            car.z - obstacleSearchRadiusM,
            car.x + obstacleSearchRadiusM,
            car.z + obstacleSearchRadiusM,
            (other) => {
                if (other === car) return false;
                const odx = other.x - car.x;
                const odz = other.z - car.z;
                const along = odx * fx + odz * fz;
                if (along < CROSS_BOX_HALF_LENGTH_M) return false;
                if (along > CROSS_BRAKE_DIST_M + CROSS_BOX_HALF_LENGTH_M * 2) return false;
                const right = odx * fz - odz * fx;
                if (Math.abs(right) > CROSS_BOX_HALF_WIDTH_M * 2) return false;
                const gap = along - CROSS_BOX_HALF_LENGTH_M * 2;
                if (gap < nearestGap) nearestGap = gap;
                return false;
            },
        );
        if (nearestGap !== Infinity) {
            const factor = nearestGap <= 0 ? 0
                : nearestGap >= BRAKE_RAMP_M ? 1
                : nearestGap / BRAKE_RAMP_M;
            const existing = speedFactor.has(car) ? speedFactor.get(car) : 1;
            if (factor < existing) speedFactor.set(car, factor);
        }
    }

    // Drive each car's swerveOffset toward its target. Wrecks ahead OR a
    // crossing tram trigger the swerve; a player tram directly ahead is a
    // lead vehicle and never a passing target. Once the
    // offset is wide enough to clear the obstacle, allow the car to
    // creep past at reduced speed instead of being held stationary by
    // the spacing brake.
    const lateralStep = SWERVE_RATE_MPS * dt;
    notePass('carsUpd:crossBrake');
    for (const car of globalCars) {
        if (car.terrainReady === false) continue;
        const signalFactor = trafficSignalSpeedFactorAt(car.x, car.z, car.heading);
        if (signalFactor >= 1) continue;
        const existing = speedFactor.has(car) ? speedFactor.get(car) : 1;
        if (signalFactor < existing) speedFactor.set(car, signalFactor);
    }
    notePass('carsUpd:signals');
    const tramBrakeGaps = new Map();
    for (const car of globalCars) {
        if (car.terrainReady === false) continue;
        const tramGap = tramAheadBrakeGap(car);
        const followsPlayerTram = tramGap !== Infinity;
        if (followsPlayerTram) tramBrakeGaps.set(car, tramGap);
        const seesObstacle = wreckAheadGap.has(car) || (!followsPlayerTram && carSeesTramAhead(car));
        const target = seesObstacle ? SWERVE_OFFSET_M : 0;
        const cur = car.swerveOffset || 0;
        const delta = target - cur;
        car.swerveOffset = Math.abs(delta) <= lateralStep
            ? target
            : cur + Math.sign(delta) * lateralStep;
        if (seesObstacle && Math.abs(car.swerveOffset) >= SWERVE_PASS_THRESHOLD) {
            const f = speedFactor.has(car) ? speedFactor.get(car) : 1;
            if (f < SWERVE_PASS_FACTOR) speedFactor.set(car, SWERVE_PASS_FACTOR);
        }
        if (followsPlayerTram) {
            const seg = globalGraph.segments[car.segIdx];
            const roadSpeed = seg && seg.speed > 0 ? seg.speed : DEFAULT_SPEED;
            const matchTramFactor = Math.min(1, Math.max(0, playerTramSpeedKmh / 3.6) / roadSpeed);
            const blend = Math.max(0, Math.min(1, tramGap / TRAM_FOLLOW_BRAKE_RAMP_M));
            const factor = tramGap <= 0 ? 0
                : matchTramFactor + (1 - matchTramFactor) * blend;
            const existing = speedFactor.has(car) ? speedFactor.get(car) : 1;
            if (factor < existing) speedFactor.set(car, factor);
        }
    }

    const despawnDistSq = DESPAWN_DISTANCE_M * DESPAWN_DISTANCE_M;
    notePass('carsUpd:swerve');
    const nowS = performance.now() / 1000;
    const survivors = [];
    for (const car of globalCars) {
        const f = speedFactor.has(car) ? speedFactor.get(car) : 1;
        const despawn = car.physicsControlled
            ? updatePromotedTrafficRoute(car, globalGraph, dt, f)
            : updateCar(car, globalGraph, dt, f);
        // Stuck-timer: if a car has been held to ~zero speed for too long
        // AND has nothing in front of it that the swerve would clear,
        // despawn. Stops chains of stopped cars from accumulating
        // behind every wreck. A car legitimately waiting behind the player
        // tram is not stale and remains in the queue until the tram moves.
        if (car.physicsControlled) {
            car.stuckSince = null;
        } else if (f < 0.05 && !wreckAheadGap.has(car)
            && !tramBrakeGaps.has(car) && !carSeesTramAhead(car)) {
            if (car.stuckSince == null) car.stuckSince = nowS;
        } else {
            car.stuckSince = null;
        }
        const stuckTooLong = car.stuckSince != null && (nowS - car.stuckSince) > STUCK_DESPAWN_S;
        // Distance check after position update so freshly-relocated cars
        // don't get culled before their tile finishes loading.
        let tooFar = false;
        if (!car.physicsControlled && !despawn && !stuckTooLong) {
            const dx = car.mesh.position.x - localX;
            const dz = car.mesh.position.z - localZ;
            if (dx * dx + dz * dz > despawnDistSq) tooFar = true;
        }
        if (despawn || tooFar || stuckTooLong) {
            if (car.mesh.parent) car.mesh.parent.remove(car.mesh);
            disposeCarRuntimeResources(car);
        } else {
            survivors.push(car);
        }
    }
    globalCars.length = 0;
    for (const c of survivors) globalCars.push(c);
    // An authored chase holds its strength. Losses above are exactly what used
    // to empty the street: a pursuer that reaches a dead end, stalls in traffic
    // or falls behind is culled like any other car, and the encounter silently
    // became no encounter at all.
    if (activePursuit) {
        const live = globalCars.reduce(
            (n, car) => n + (car.enemy && !car.wrecked
                && car.encounterId === activePursuit.encounterId ? 1 : 0),
            0,
        );
        const reinforcements = pursuitTopUp({
            desired: activePursuit.count,
            live,
            nowS,
            lastSpawnS: activePursuit.lastSpawnS,
        });
        if (reinforcements > 0) {
            activePursuit.lastSpawnS = nowS;
            spawnEnemyWaveNear(localX, localZ, activePursuit.radiusM, reinforcements, {
                encounterId: activePursuit.encounterId,
            });
        }
    }
    // Tile eviction can defer graph retirement while a live car still owns a
    // segment. Recheck after the survivor pass releases despawned cars.
    trafficGraphOwnership.flush();

    // Wreck meshes used to live until the whole station-3d session ended. That
    // is acceptable around one tram corridor but unbounded on a cross-country
    // drive. Retire old, distant, and over-cap wrecks here.
    const wreckSurvivors = [];
    const wreckOverflow = Math.max(0, wreckedCars.length - MAX_WRECKED_CARS);
    for (let index = 0; index < wreckedCars.length; index += 1) {
        const wreck = wreckedCars[index];
        const dx = (wreck.x ?? wreck.mesh?.position.x ?? 0) - localX;
        const dz = (wreck.z ?? wreck.mesh?.position.z ?? 0) - localZ;
        const expired = Number.isFinite(wreck.wreckedAtS) && nowS - wreck.wreckedAtS > WRECK_TTL_S;
        const tooFar = dx * dx + dz * dz > despawnDistSq;
        const overCap = index < wreckOverflow;
        if (expired || tooFar || overCap) {
            if (wreck.mesh?.parent) wreck.mesh.parent.remove(wreck.mesh);
            disposeCarRuntimeResources(wreck);
        } else {
            wreckSurvivors.push(wreck);
        }
    }
    wreckedCars.length = 0;
    wreckedCars.push(...wreckSurvivors);
    for (const car of [...parkedCars.values()]) {
        if (car.controlled || !car.abandoned) continue;
        const dx = car.x - localX;
        const dz = car.z - localZ;
        if (dx * dx + dz * dz > despawnDistSq) removeParkedCar(car);
    }
    trafficGraphOwnership.flush();
    notePass('carsUpd:drive');
    // Populations, so a pass that is merely O(n) with a large n is
    // distinguishable from one that is accidentally quadratic.
    recordLayerFrameMs(`carsUpd:n=${globalCars.length}/${wreckedCars.length}`, 0.001);
}

function onTileEvict(tileKey) {
    navigationMapContext.removeRoadTile(tileKey);
    cancelTileGraphJob(tileKey);
    releaseParkedCarsForTile(tileKey);
    trafficGraphOwnership.releaseTile(tileKey);
}

function rollbackTileGraphSegments(segIndices) {
    for (const segIdx of segIndices || []) {
        const seg = globalGraph.segments[segIdx];
        if (!seg || seg.retired) continue;
        removeOutgoing(seg.startKey, segIdx, true);
        removeOutgoing(seg.endKey, segIdx, false);
        seg.retired = true;
    }
}

function cancelTileGraphJob(tileKey) {
    if (tileKey == null) return;
    const job = tileGraphJobs.get(tileKey);
    if (!job) return;
    graphBuildQueue.cancel(job);
    tileGraphJobs.delete(tileKey);
}

function enqueueTileGraphAppend(tileKey, features) {
    cancelTileGraphJob(tileKey);
    const safeFeatures = Array.isArray(features) ? features : [];
    const segIndices = [];
    const [tileTx, tileTz] = String(tileKey).split('_').map(Number);
    const job = graphBuildQueue.enqueue(
        safeFeatures,
        (feature) => appendFeatureToGlobalGraph(feature, segIndices, tileKey),
        {
            onComplete: () => {
                tileGraphJobs.delete(tileKey);
                navigationMapContext.setRoadTile(tileKey, segIndices.map(index => globalGraph.segments[index]));
                baseRoadGraphPrimed = true;
                flushPendingProposalRoadCenterlines();
                for (const waiter of trafficRoadReadinessWaiters) waiter.check();
                if (segIndices.length > 0) {
                    spawnCarsOnSegments(segIndices, CARS_PER_TILE);
                    spawnParkedCarsForSegments(tileKey, segIndices);
                }
            },
            onCancel: () => {
                tileGraphJobs.delete(tileKey);
                if (!baseRoadGraphPrimed) {
                    baseRoadGraphPrimed = true;
                    flushPendingProposalRoadCenterlines();
                }
            },
            onError: () => {
                tileGraphJobs.delete(tileKey);
            },
            maxItemsPerFrame: 18,
            priority: () => classifyViewPriority(
                tileLocalBounds(tileTx, tileTz, TILE_M),
                {
                    observerX: trafficBuildFocusX,
                    observerZ: trafficBuildFocusZ,
                    headingDeg: trafficBuildHeadingDeg,
                    fovDeg: trafficBuildFovDeg,
                },
            ).score,
        }
    );
    tileGraphJobs.set(tileKey, job);
    return job.promise;
}

// ─── Emergency vehicle per-frame: lightbar flash + siren update ─────────
// Single phase shared across every active emergency vehicle (so all blue
// caps light at the same instant, all red caps a half-cycle later — same
// look as a real fleet). 3 Hz alternation = 167 ms per side.
const FLASH_HZ = 3;

function updateEmergencyVehicles() {
    const tMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const phase = Math.floor(tMs / (1000 / (FLASH_HZ * 2))) & 1;
    const sirenList = [];
    for (const car of globalCars) {
        if (!car.type || !car.type.livery || !car.emergency
            || car.terrainReady === false) continue;
        const caps = car.mesh.userData && car.mesh.userData.lightbarCaps;
        if (caps && caps.length === 2) {
            caps[0].emissiveIntensity = phase === 0 ? 4.0 : 0;
            caps[1].emissiveIntensity = phase === 1 ? 4.0 : 0;
        }
        const dx = car.mesh.position.x - camera.position.x;
        const dy = car.mesh.position.y - camera.position.y;
        const dz = car.mesh.position.z - camera.position.z;
        const distM = Math.sqrt(dx * dx + dy * dy + dz * dz);
        sirenList.push({ key: car, livery: car.type.livery, distanceM: distM });
    }
    updateSirens(sirenList);
}

// ─── Layer protocol ────────────────────────────────────────────────────────

export const carsLayer = {
    async beginSession({
        anchorLat: lat,
        anchorLon: lon,
        onPlayerTramDamage: damageFn,
        isGameMode,
        isAmbientHostileMode,
        isWalkMode,
        sessionCapabilities,
        sharedTileSession,
        customTrackCorridors,
        otherTracks,
        allStops,
        terrain,
        roadFormation,
        authoredVehicleSpawns,
        trafficKeepClear,
    }) {
        const generation = ++carsSessionGeneration;
        try {
            await preloadRoadFleetModels();
        } catch (error) {
            if (generation !== carsSessionGeneration) return;
            throw error;
        }
        if (generation !== carsSessionGeneration) return;
        anchorLat = lat;
        anchorLon = lon;
        trafficKeepClearVolumes = (Array.isArray(trafficKeepClear) ? trafficKeepClear : [])
            .map((volume) => {
                const local = geoToLocal(Number(volume?.lon), Number(volume?.lat), lon, lat);
                return { x: local.x, z: local.z, radiusM: Number(volume?.radiusM) };
            })
            .filter(volume => Number.isFinite(volume.x) && Number.isFinite(volume.z));
        terrainReference = terrain || null;
        roadFormationModel = roadFormation || null;
        onPlayerTramDamage = typeof damageFn === 'function' ? damageFn : null;
        isGameModeFn = typeof isGameMode === 'function' ? isGameMode : (() => false);
        ambientHostilesFn = typeof isAmbientHostileMode === 'function'
            ? isAmbientHostileMode
            : (() => false);
        isWalkModeFn = typeof isWalkMode === 'function' ? isWalkMode : (() => false);
        setTrafficSessionCapabilities(sessionCapabilities);
        trafficFixedStep.reset();
        playerTramSpeedKmh = 0;
        trafficBuildFocusX = 0;
        trafficBuildFocusZ = 0;
        trafficBuildHeadingDeg = Number.NaN;
        trafficBuildFovDeg = 90;
        parkedRailCorridorRevision = -1;
        parkedRailCorridorVolumes = buildParkedRailCorridors(otherTracks || []);
        parkedRailRejectCount = 0;
        const undergroundRampVolumes = buildTrackCorridorVolumes(customTrackCorridors, anchorLat, anchorLon, {
            halfWidth: PLANNER_OPEN_CUT_HALF_WIDTH_M,
            elevatedRightExtension: 0,
            segmentFilter: ({ startElevationM, endElevationM }) =>
                isPlannerUndergroundRampSegment(startElevationM, endElevationM),
        });
        const lowElevatedRampVolumes = buildLowElevatedRampVolumes(
            customTrackCorridors,
            anchorLat,
            anchorLon,
        );
        plannerOpenCutVolumes = undergroundRampVolumes
            .concat(lowElevatedRampVolumes)
            .concat(buildPlannerStationClearanceVolumes(
                allStops,
                otherTracks,
                anchorLat,
                anchorLon,
            ));
        if (!carsGroup) {
            carsGroup = new THREE.Group();
            carsGroup.name = 'TrafficVehicles';
            scene.add(carsGroup);
        }
        // Reset global graph + car pool for a fresh session.
        globalGraph.segments.length = 0;
        globalGraph.nodes.clear();
        loadedOsmIds.clear();
        osmIdToSegIndices.clear();
        freeSegmentIndices.length = 0;
        trafficGraphOwnership.reset();
        navigationMapContext.resetRoads();
        graphCapacityHits = 0;
        nextTrafficCarId = 1;
        globalCars.length = 0;
        for (const car of parkedCars.values()) removeParkedCar(car);
        parkedCars.clear();
        parkedCarTiles.clear();
        parkedFormationRevision = -1;
        parkedTerrainRevision = -1;
        parkedReseatQueue = [];
        parkedReseatQueuedIds.clear();
        baseRoadGraphPrimed = false;
        spawnAuthoredParkedCars(authoredVehicleSpawns);
        tileSource = sharedTileSession.getSource({
            // Keep simulation on its small moving ring. Using roads:graph here
            // subscribed cars to the civil layer's 1.4 km formation corridor,
            // creating unseen graphs and vehicles. Independent source windows
            // still coalesce identical in-flight HTTP requests.
            key: 'roads:traffic',
            label: 'cars',
            url: (bb) => `${getApiBase()}/roads?bbox=${bb.west},${bb.south},${bb.east},${bb.north}`,
            ...NEAR_ROAD_STREAM_OPTIONS,
        });
        tileSubscription = tileSource.subscribe({
            deliveryLabel: 'cars:road-graph',
            onFetch: (features, tileKey) => enqueueTileGraphAppend(tileKey, features),
            onEvict: onTileEvict,
        });
        tileSource.ensureAround(0, 0);
    },
    onFrame(pose, local, dt) {
        // Reseat already-visible parked cars before spending this frame on new
        // streamed work. This correction is required even on stationary frames.
        refreshParkedRailCorridors();
        queueParkedCarsForFormationRevision(local.x, local.z);
        drainParkedCarReseats();
        trafficBuildFocusX = Number(local?.x) || 0;
        trafficBuildFocusZ = Number(local?.z) || 0;
        const viewHeadingDeg = finiteOrNull(pose?.viewHeadingDeg)
            ?? finiteOrNull(pose?.headingDeg);
        if (viewHeadingDeg != null) trafficBuildHeadingDeg = viewHeadingDeg;
        trafficBuildFovDeg = finiteOrNull(pose?.viewFovDeg) ?? 90;
        if (tileSource) {
            tileSource.ensureAround(local.x, local.z, {
                headingDeg: trafficBuildHeadingDeg,
                fovDeg: trafficBuildFovDeg,
            });
        }
        playerTramSpeedKmh = getPoseSpeedKmh(pose);
        if (!dt || dt <= 0) {
            updateTrafficVehicleLods(local.x, local.z, globalCars, parkedCars, trafficDetailRadiusM());
            return;
        }
        // Sub-pass timing. This layer occasionally cost 285 ms in one frame while
        // its median was half a millisecond, and 'cars' alone does not say which
        // of eight passes did it. recordLayerFrameMs is a no-op unless the perf
        // overlay is open, so this is free in normal use.
        const passStart = performance.now();
        let passMark = passStart;
        const notePass = (name) => {
            const now = performance.now();
            recordLayerFrameMs(name, now - passMark);
            passMark = now;
        };
        // Collision consumers still need the current tram pose every rendered
        // frame; only the self-contained ambient traffic simulation is fixed
        // ticked. This keeps contact accuracy independent of traffic cadence.
        refreshTramBoxes(pose, local);
        notePass('cars:tramBoxes');
        const trafficFrame = trafficFixedStep.advance(dt, fixedDt => {
            beginTrafficRenderStep();
            updateGlobalCars(fixedDt, local.x, local.z);
            finishTrafficRenderStep();
        });
        interpolateTrafficRenderPoses(trafficFrame.alpha);
        updateTrafficVehicleLods(local.x, local.z, globalCars, parkedCars, trafficDetailRadiusM());
        notePass('cars:update');
        // Tram-vs-car contact: shove + wreck — PLAYER tram only. Runs
        // after the normal car updates (which may have moved the
        // chassis into the tram's box this frame) and uses the same
        // _tramBoxes snapshot built in updateGlobalCars.
        applyTramCollisions(dt);
        notePass('cars:collisions');
        // Autopilot trams brake / stall when a car or wreck sits in
        // their forward cone. Toggles trip._physicsWall.obstacleStall
        // for tram-sim's stepPhysics to honour next frame.
        if (trafficFrame.steps > 0) applyAutopilotTramStalls();
        notePass('cars:autopilot');
        // Wreck smoke — emit per nearby wreck, then advance every particle.
        for (const wreck of wreckedCars) {
            maybeEmitWreckSmoke(wreck, dt, local.x, local.z);
        }
        notePass('cars:wreckSmoke');
        updateEnemyVehicles(dt);
        notePass('cars:enemies');
        updateSmoke(dt);
        updateFire(dt);
        updateAllWreckDriverAnims(dt);
        updateEmergencyVehicles();
        notePass('cars:effects');
    },
    endSession() {
        carsSessionGeneration += 1;
        for (const waiter of trafficRoadReadinessWaiters) waiter.finish(false);
        trafficFixedStep.reset();
        trafficObstacleIndex.clear();
        autopilotVehicleIndex.clear();
        autopilotTramIndex.clear();
        if (tileSubscription) tileSubscription();
        tileSubscription = null;
        tileSource = null;
        graphBuildQueue.clear();
        // Pending wreck dressing would otherwise add meshes to a torn-down group.
        wreckDressingQueue.clear();
        tileGraphJobs.clear();
        stopAllSirens();
        // Detach animation-owned meshes before their parent cars so every
        // per-instance geometry follows one disposal path.
        disposeWreckDriverAnims();
        for (const car of globalCars) {
            if (car.mesh.parent) car.mesh.parent.remove(car.mesh);
            disposeCarRuntimeResources(car);
        }
        for (const car of wreckedCars) {
            if (car.mesh.parent) car.mesh.parent.remove(car.mesh);
            disposeCarRuntimeResources(car);
        }
        for (const car of parkedCars.values()) {
            if (car.mesh?.parent) car.mesh.parent.remove(car.mesh);
            disposeCarRuntimeResources(car);
        }
        parkedCars.clear();
        parkedCarTiles.clear();
        for (const s of liveSmoke) {
            if (s.mesh.parent) s.mesh.parent.remove(s.mesh);
            if (s.mesh.material) s.mesh.material.dispose();
        }
        liveSmoke.length = 0;
        for (const f of liveFire) {
            if (f.mesh.parent) f.mesh.parent.remove(f.mesh);
            if (f.mesh.material) f.mesh.material.dispose();
        }
        liveFire.length = 0;
        for (const b of liveEnemyBullets) {
            if (b.mesh.parent) b.mesh.parent.remove(b.mesh);
        }
        liveEnemyBullets.length = 0;
        for (const s of liveEnemyImpacts) {
            if (s.mesh.parent) s.mesh.parent.remove(s.mesh);
        }
        liveEnemyImpacts.length = 0;
        if (enemyProjectilesGroup) {
            if (enemyProjectilesGroup.parent) enemyProjectilesGroup.parent.remove(enemyProjectilesGroup);
            enemyProjectilesGroup = null;
        }
        if (smokeGroup) {
            if (smokeGroup.parent) smokeGroup.parent.remove(smokeGroup);
            smokeGroup = null;
        }
        globalCars.length = 0;
        wreckedCars.length = 0;
        _playerWreckCount = 0;
        globalGraph.segments.length = 0;
        globalGraph.nodes.clear();
        loadedOsmIds.clear();
        osmIdToSegIndices.clear();
        freeSegmentIndices.length = 0;
        trafficGraphOwnership.reset();
        navigationMapContext.resetRoads();
        graphCapacityHits = 0;
        nextTrafficCarId = 1;
        baseRoadGraphPrimed = false;
        pendingProposalRoadCenterlines = [];
        onPlayerTramDamage = null;
        isGameModeFn = () => false;
        ambientHostilesFn = () => false;
        isWalkModeFn = () => false;
        parkedVehiclesEnabled = false;
        suppressTrafficWreckDressing = false;
        playerTramSpeedKmh = 0;
        trafficBuildFocusX = 0;
        trafficBuildFocusZ = 0;
        trafficBuildHeadingDeg = Number.NaN;
        trafficBuildFovDeg = 90;
        plannerOpenCutVolumes = [];
        parkedRailCorridorVolumes = [];
        parkedRailCorridorRevision = -1;
        parkedRailRejectCount = 0;
        roadFormationModel = null;
        parkedFormationRevision = -1;
        parkedTerrainRevision = -1;
        parkedReseatQueue = [];
        parkedReseatQueuedIds.clear();
        terrainReference = null;
        if (carsGroup) {
            if (carsGroup.parent) carsGroup.parent.remove(carsGroup);
            carsGroup = null;
        }
        disposeRoadVehicleSessionCaches();
        for (const ref of [
            smokeGeometry, smokeMaterialTemplate,
            fireGeometry, fireMaterialTemplate,
            bulletHoleGeometry, bulletHoleMaterial,
        ]) {
            if (ref) { unregisterShared(ref); ref.dispose(); }
        }
        smokeGeometry = smokeMaterialTemplate = null;
        fireGeometry = fireMaterialTemplate = null;
        bulletHoleGeometry = bulletHoleMaterial = null;
        disposeBicycleSessionCaches();
        isCarNight = false;
    },
};

export function setTrafficSessionCapabilities(sessionCapabilities) {
        parkedVehiclesEnabled = sessionCapabilityEnabled(
            sessionCapabilities,
            SESSION_CAPABILITY.PARKED_VEHICLES,
        );
        suppressTrafficWreckDressing = sessionCapabilityEnabled(
            sessionCapabilities,
            SESSION_CAPABILITY.SUPPRESS_TRAFFIC_WRECK_DRESSING,
        );
}
