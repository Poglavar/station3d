// Photorealistic base layer: streams Google Photorealistic 3D Tiles (brokered by
// Cesium ion) straight into the sim's own Three.js scene via 3d-tiles-renderer —
// no second renderer, so the cab drives the existing track through the real
// world. Anchored to the session origin (the cab's local tangent frame). Enabled
// per session by a URL flag (?rw / ?real); off by default so normal rides are
// unaffected.
//
// The railway corridor is cut out of the streamed mesh the way AEC tooling clips
// a reality mesh around a designed alignment (Cesium's "clipping polygons"
// technique): every tile material gets a small fragment-shader patch that
// DISCARDS fragments lying inside the corridor footprint (a top-down mask
// texture of the route ribbon) and above the trench floor. Unlike vertex
// flattening this is LOD-independent — coarse tiles show exactly the same crisp
// cut as refined ones, nothing gets dragged into stretched "curtains", and
// sliding the mask window costs one small texture render instead of re-processing
// geometry. The designed trench itself is our own geometry: a ballast floor slab
// and stone retaining walls standing on the cut edges (InstancedMesh boxes,
// which double as walk colliders). Terrain BELOW track level is left untouched,
// so floating stretches still show the real valley under the rails (viaduct
// geometry is a later slice).
import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { scene, camera, renderer } from '../scene/setup.js';
import { DEG_TO_RAD, geoToLocal, localToGeo } from '../core/math.js';
import { collectAtGradeCorridor, collectFullCorridor } from '../core/corridor-at-grade.js';
import {
    buryDsmSurfaceCrown,
    buryDsmSurfaceCrownFromSamples,
    classifyPhotoCivilWorks,
    photoRetainingWallTop,
    selectPhotoBareEarthHeight,
    slabSpanRiseM,
} from '../core/photo-civil-works.js';
import {
    buildCutFlankMaskQuads,
    buildPortalCollarMaskQuads,
    buildPortalHoodMaskQuads,
    buildTunnelCoreMaskQuads,
    derivePhotoCorridorOwnership,
    photoCutFlankOwnershipAt,
    photoPortalFacadeFrame,
    photoPortalSourceOwnershipAt,
    PHOTO_AT_GRADE_CORRIDOR_HALF_WIDTH_M,
    PHOTO_CORRIDOR_HALF_WIDTH_M,
    PHOTO_CORRIDOR_MASK_RESOLUTION,
    PHOTO_CORRIDOR_MASK_WINDOW_HALF_M,
    resolvePhotoCutFlankBand,
    resolvePhotoCutPlanContract,
    resolvePhotoPortalPlanContract,
    resolvePhotoPortalCivilEnvelope,
} from '../core/photo-corridor-ownership.js';
import { installRevisionedMaterialCompilePatch } from '../core/revisioned-material-compile-patch.js';
import {
    applyPhotoStationCivilOwnership,
    buildPhotoStationCivilEnvelopes,
    buildPhotoStationMaskQuads,
    photoStationKey,
    photoStationRuntimeStructure,
    photoStationSourceOwnershipAt,
    photoStationSupportsRigidStructure,
    resolvePhotoStationStructures,
} from '../core/photo-station-civil-envelope.js';
import { PHOTO_RUNNING_TUNNEL_SECTION } from '../core/photo-covered-station-shell.js';
import {
    prepareStationTrackRoutes,
    splitStationTrackRouteBySegmentOwners,
} from '../core/planner-station-track-anchor.js';
import {
    registrationStationsAlong,
    selectConsensusSeatOffset,
    terrainSeatOffset,
} from '../core/photo-track-frame.js';
import { keepObjectNameInPhoto } from '../core/photo-object-visibility.js';
import { resetWalkColliders } from './walk-collision.js';
import { ensureRoadIndex } from '../core/road-index.js';
import { resolveIntelligentPillarSamples } from '../core/intelligent-pillar-placement.js';
import { createPillarClearanceEvaluator } from '../core/pillar-clearance.js';
import { shouldSuspendPhotoSource } from '../core/photo-source-suspension.js';
import { markInspectionLayer } from '../core/scene-inspection.js';

// 3d-tiles-renderer is a heavy optional dependency, so it is LAZY-loaded — dynamically
// imported only when a ?rw session actually starts — and never pulled into
// Station3D's core module graph (a static import here blocked/timed-out the whole
// cab load when the CDN was slow). Populated by loadTilesLib().
let TilesRenderer, CesiumIonAuthPlugin, GLTFExtensionsPlugin, TileCompressionPlugin,
    ReorientationPlugin;
let tilesLibPromise = null;
function loadTilesLib() {
    if (!tilesLibPromise) {
        tilesLibPromise = Promise.all([
            import('3d-tiles-renderer/three'),
            import('3d-tiles-renderer/three/plugins'),
        ]).then(([core, plugins]) => {
            ({ TilesRenderer } = core);
            ({
                CesiumIonAuthPlugin, GLTFExtensionsPlugin, TileCompressionPlugin,
                ReorientationPlugin,
            } = plugins);
        });
    }
    return tilesLibPromise;
}

// Cesium ion token — client-side by design (tile streaming needs it in the
// browser); this is the same public token consensus-builder's photoreal-mode.js
// ships, overridable via window.__ION_TOKEN__ or runtime config. ion asset
// 2275207 = Google Photorealistic 3D Tiles (brokered by ion; bypasses the EEA
// block that 403s a raw Google key over Croatia).
const DEFAULT_ION_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI5MTBkNDc1Ny0zNzlkLTRiOTMtYTM2Zi1hZjYzNWY0MTJjMTIiLCJpZCI6NDI0MDY3LCJpYXQiOjE3NzcyNzM2ODF9.-GY-QQkFSEcYl8fkkm_u4AxVbmWY2aNefvzoHAiLuLE';
function ionToken() {
    if (typeof window === 'undefined') return DEFAULT_ION_TOKEN;
    const cfg = window.__ZAGREB_RUNTIME_CONFIG__ || {};
    return window.__ION_TOKEN__ || cfg.ionToken || DEFAULT_ION_TOKEN;
}
const GOOGLE_PHOTOREALISTIC_ION_ASSET = 2275207;
const DRACO_DECODER = window.__station3DAssetConfig?.dracoDecoderUrl
    || '/__station3d_vendor__/three/examples/jsm/libs/draco/gltf/';

let tiles = null;
let root = null;
let active = false;
let photoUnavailable = false; // terminal fallback releases loading without exposing bad geometry
let sessionGeneration = 0;    // invalidates lazy library continuations from closed sessions
let grounded = false;        // world seated at its final height
let tilesRevealed = false;   // world shown (kept hidden until seated + cut + dressed)
// Coarse tiles read wildly tall, so the trench builder dresses a phantom tunnel
// until the mesh refines. Height/stability heuristics can't tell a coarse-but-
// static tile from a refined one, so instead we hold the reveal (behind a
// "loading" overlay) until the streamer goes QUIET: no new tile model has
// loaded for REVEAL_QUIET_S and the queue is nearly drained. A coarse-complete
// state can't satisfy this — the renderer immediately streams the refined
// children, resetting the quiet timer — so this waits out the coarse→refined
// swap. A hard cap reveals anyway so a stalled stream isn't trapped forever.
const REVEAL_QUIET_S = 0.5;
const REVEAL_MAX_WAIT_S = 12;
let revealWaitS = 0;
let photoLoadStartMs = 0;   // wall-clock start of the current photo load (for the uniform bar)
let photoResourceUrls = new Set(); // exact tile URLs whose Resource Timing bytes belong to this load
let sinceTileLoadS = 1e9;    // time since the last tile model loaded (∞ until first)
let corridorTracks = null;
let stationStops = [];
let anchorLatLon = null;
let photoTrackFrame = null;
let photoGroundOffsetAt = null;
let profileRegistrationActive = false;
const _rayDir = new THREE.Vector3(0, -1, 0);
const _raycaster = new THREE.Raycaster();

// URL toggles: &nocarve skips the corridor cut, &nowalls the wall dressing,
// &elev=<m> pins the track at an absolute altitude (see the height lock below).
let carveEnabled = true;
// Captured at MODULE LOAD: the walk deeplink handler rewrites the URL (strips
// its own params) before beginSession runs, which silently dropped flags read
// from location.search at session time.
const INITIAL_PAGE_PARAMS = new URLSearchParams(
    (typeof window !== 'undefined' && window.location && window.location.search) || '',
);
let seamGlowEnabled = false;         // &seams: glowing plane under the world — holes show pink
let seamGlowMesh = null;
let wallsEnabled = true;
let elevAbsolute = false;
let trackElevationM = 0;
let corridorIsReconstruction = false;
// The authored a.s.l. datum (DGU/EVRF2000) the cab emitted its c[2] against, if
// any. It is the exact tangent frame's height origin; the authored track stays
// in that frame while the Google root receives one independent vertical tie.
let aslDatumM = null;

// Google-ground capture: as the ride's wall window sweeps the route, we already
// raycast Google's bare surface under it (chunk.groundC). In an ASL session the inverse
// tangent transform converts that hit back to an altitude for the planner's
// elevation overlay. Additive and best-effort: only the stretch the ride
// actually covered is captured; nothing is lost when the cab hands off to walk
// or the sim closes, because the planner keeps it.
let onPhotoGroundSamples = null;
let photoGroundSeen = new Set();

const CORRIDOR_HALF_WIDTH_M = PHOTO_CORRIDOR_HALF_WIDTH_M;
const CORRIDOR_HALF_SQ = CORRIDOR_HALF_WIDTH_M * CORRIDOR_HALF_WIDTH_M;
// Earthworks only where the track meets the ground: planner track coordinates
// carry elevation in c[2] (levels × 10 m, ramps interpolated), and spans at
// ±1 level get their own designed structures from planner-elevation.js — a
// flyover must not also dig a surface trench beneath itself. Mirrors
// planner-elevation's ELEV_EPS so the two regimes stay complementary: every
// span is either earthwork (here) or designed structure (there), never both
// and never neither.
const AT_GRADE_EPS_M = 0.5;

// The two world modes are `photo` (photorealistic Google 3D Tiles, rendered by
// this module) and `model` (the modeled OSM/GDI/Overture world, the default).
// The rule lives in website/world-mode.js, loaded as a classic script before
// this module runs, so transit.js and this file cannot disagree about which
// world the URL asked for — they each used to carry their own copy of it.
export function isPhotoWorld() {
    return !!(window.__worldMode && window.__worldMode.isPhotoWorld());
}

// ---------------------------------------------------------------------------
// Track height. The authored profile is immutable: some stretches cut into the
// terrain, others float over it, and both are intentional. The Google world is
// translated ONCE and never moved again:
//   • authored profile: preserve its DGU track-vs-ground relationship at one
//     registration point beside the session start;
//   • legacy flat route: seat the start track a little above Google ground;
//   • ?elev=<m>: put the track at an ABSOLUTE altitude of <m> metres above the
//     anchor's sea level — identical no matter where the session starts.
// Google tiles stream coarse→fine and the coarse surface can be metres off,
// which used to seat the world on garbage. The lock therefore waits until a few
// consecutive readings at a FIXED point agree (refinement has converged); the
// whole photoreal world stays hidden until seated and dressed, so the first
// thing you see is already the final look.
const TRACK_FLOAT_ABOVE_GROUND_M = 2;
const GRADE_SAMPLE_INTERVAL_S = 0.2;
const TAG_INTERVAL_S = 0.5;
const LOCK_STABLE_SAMPLES = 3;      // consecutive readings that must agree...
const LOCK_STABLE_SPREAD_M = 1.5;   // ...within this spread => refinement converged
const LOCK_MAX_WAIT_S = 12;         // lock on whatever answered (degraded) after this
const LOCK_GIVE_UP_S = 60;          // ...but only declare photo TERMINALLY unavailable
                                    // after this long with ZERO station answers — 12 s
                                    // was a handful of refinement rounds on a strained
                                    // GPU and sent healthy sessions to the fallback
const LOCK_ABANDON_DIST_M = 150;    // cab has driven away from the reference — take what we have
let gradeAccum = 0;
let tagAccum = 1e9;
let lockSamples = [];
let lockWaitS = 0;
let lockRefX = null, lockRefZ = null;
let lockRefUx = 0, lockRefUz = -1;
let lockTrackY = 0;
let lockAuthoredGroundOffsetM = 0;
// Consensus registration (authored profiles): several stations along the
// alignment, probed round-robin; the applied shift is the MEDIAN of their
// candidate shifts, so clutter at any one spot (station platforms, canopy,
// an overpass at km 0) cannot re-seat the whole route.
let lockStations = null;
let lockStationCursor = 0;
let inheritedSeatOffsetY = null;

function registrationGroundY() {
    return registrationGroundYAt(lockRefX, lockRefZ, lockRefUx, lockRefUz);
}

function registrationGroundYAt(refX, refZ, refUx, refUz) {
    const lockRefX = refX;
    const lockRefZ = refZ;
    const lockRefUx = refUx;
    const lockRefUz = refUz;
    const px = -lockRefUz;
    const pz = lockRefUx;
    const probes = [
        [0, 0],
        [lockRefUx * 10, lockRefUz * 10],
        [-lockRefUx * 10, -lockRefUz * 10],
        [px * 18, pz * 18],
        [-px * 18, -pz * 18],
        [px * 30, pz * 30],
        [-px * 30, -pz * 30],
        [lockRefUx * 8 + px * 18, lockRefUz * 8 + pz * 18],
        [-lockRefUx * 8 - px * 18, -lockRefUz * 8 - pz * 18],
    ];
    const values = probes.map(([dx, dz]) => terrainTopAt(lockRefX + dx, lockRefZ + dz));
    const center = values[0];
    const support = values.slice(1).filter(Number.isFinite).sort((a, b) => a - b);
    if (support.length < 3) return Number.isFinite(center) ? center : null;
    const middle = Math.floor(support.length / 2);
    const median = support.length % 2
        ? support[middle]
        : (support[middle - 1] + support[middle]) * 0.5;
    // Prefer the actual route point when it agrees with its neighbourhood.
    // A roof, tree crown or existing bridge deck is a DSM outlier; use the
    // surrounding bare-earth proxy so one object cannot shift the whole route.
    return Number.isFinite(center) && Math.abs(center - median) <= 3
        ? center
        : median;
}

function lockTrackHeightOnce() {
    if (grounded) return;
    if (Number.isFinite(inheritedSeatOffsetY)) {
        root.position.y = inheritedSeatOffsetY;
        root.updateMatrixWorld(true);
        tiles.group.updateMatrixWorld(true);
        wallHeightCache.clear();
        grounded = true;
        console.log(`[photoreal] reused cab registration (Google shift ${root.position.y.toFixed(2)} m)`);
        return;
    }
    lockWaitS += GRADE_SAMPLE_INTERVAL_S;
    // Sample a FIXED point on the alignment beside the session start—not the
    // moving camera. The DGU relationship at this one point registers Google;
    // every other authored vertex remains immutable.
    if (lockRefX === null) {
        // The registration point is the nearest point ON the profile corridor —
        // however far the walk spawned from it. A 200 m cap here silently sent
        // distant spawns to the camera-position fallback (track height 0, DGU
        // offset 0), seating the whole route ~metres off: sunken works, piers
        // in the ground, open clip seams. 50 km = same-world sanity bound.
        const registration = profileRegistrationActive
            ? nearestProfileCorridorPointAt(
                camera.position.x,
                camera.position.z,
                50000 * 50000,
            )
            : null;
        if (registration) {
            lockRefX = registration.x;
            lockRefZ = registration.z;
            lockRefUx = registration.ux;
            lockRefUz = registration.uz;
            lockTrackY = registration.y;
            const authoredOffsetAt = (x, y, z, trackId) => {
                if (!photoTrackFrame || typeof photoGroundOffsetAt !== 'function') return 0;
                const geo = photoTrackFrame.fromScene(x, y, z);
                const offset = Number(photoGroundOffsetAt(geo.lat, geo.lon, trackId));
                return Number.isFinite(offset) ? offset : 0;
            };
            lockAuthoredGroundOffsetM = authoredOffsetAt(
                registration.x,
                registration.y,
                registration.z,
                registration.trackId,
            );
            // Consensus plan: stations spread along the alignment around the
            // start. Each carries its own authored track-vs-DGU offset; the
            // shift that preserves that relationship is computed per station
            // and the median wins, so clutter at any single spot (platforms,
            // canopy, an overpass) cannot re-seat the whole route.
            lockStations = registrationStationsAlong(
                profileCorridorSegs,
                registration.x,
                registration.z,
                {
                    spacingM: 80,
                    maxStations: 7,
                    maxSpanM: 700,
                    segmentTrackIds: profileCorridorTrackIds,
                },
            ).map((station) => ({
                ...station,
                authoredOffsetM: authoredOffsetAt(
                    station.x,
                    station.y,
                    station.z,
                    station.trackId,
                ),
                groundY: null,
            }));
            lockStationCursor = 0;
        } else {
            lockRefX = camera.position.x;
            lockRefZ = camera.position.z;
            lockRefUx = 0;
            lockRefUz = -1;
            lockTrackY = corridorFloorYAt(lockRefX, lockRefZ) ?? 0;
        }
    }
    const useConsensus = profileRegistrationActive && !elevAbsolute
        && Array.isArray(lockStations) && lockStations.length > 0;
    let sampleValue = null;
    if (useConsensus) {
        // Probe ONE station per attempt (same ray budget as before), then
        // derive the median candidate shift across every station that has
        // answered so far. The temporal stability gate below then runs on
        // that median, not on a single spot's ground.
        const station = lockStations[lockStationCursor % lockStations.length];
        lockStationCursor += 1;
        const ground = registrationGroundYAt(station.x, station.z, station.ux, station.uz);
        station.groundY = Number.isFinite(ground) && Math.abs(ground) <= 1500 ? ground : null;
        const shifts = lockStations
            .filter((item) => Number.isFinite(item.groundY))
            .map((item) => terrainSeatOffset({
                trackY: item.y,
                unshiftedGroundY: item.groundY,
                authoredGroundOffsetM: item.authoredOffsetM,
            }));
        const needed = Math.min(3, lockStations.length);
        const enough = shifts.length >= needed
            || (lockWaitS >= LOCK_MAX_WAIT_S && shifts.length >= 1);
        if (!enough) {
            if (lockWaitS >= LOCK_GIVE_UP_S && shifts.length === 0) {
                markPhotorealUnavailable('no stable Google ground reached any registration station');
            }
            return;
        }
        sampleValue = selectConsensusSeatOffset(shifts, { minCandidates: 1 });
        if (!Number.isFinite(sampleValue)) return;
    } else {
        const groundY = registrationGroundY();
        if (!Number.isFinite(groundY)) {
            if (lockWaitS >= LOCK_GIVE_UP_S) {
                markPhotorealUnavailable('no stable Google ground reached the registration point');
            }
            return;
        }
        sampleValue = groundY;
    }
    const groundY = sampleValue;
    // Plausibility: terrain near the anchor sits within a few hundred metres of
    // its sea level. Before local tiles stream in, the ray can hit a COARSE
    // far-earth tile kilometres below (planet curvature) — and a static coarse
    // tile returns IDENTICAL readings each sample, so it sails through the
    // stability test looking rock solid. One such hit once seated the world
    // 4.3 km up. Reject it outright.
    if (!useConsensus && Math.abs(groundY) > 1500) {
        if (lockWaitS >= LOCK_MAX_WAIT_S) {
            markPhotorealUnavailable('Google ground remained physically implausible at the registration point');
        }
        return;
    }
    // And while the streamer is still busy refining the view, even a plausible
    // reading is suspect — hold off (up to half the wait budget) until the
    // queues go quiet.
    const prog = tiles.loadProgress;
    if (Number.isFinite(prog) && prog < 0.95 && lockWaitS < LOCK_MAX_WAIT_S * 0.5) return;
    lockSamples.push(groundY);
    if (lockSamples.length > LOCK_STABLE_SAMPLES) lockSamples.shift();
    const spread = Math.max(...lockSamples) - Math.min(...lockSamples);
    const stable = lockSamples.length >= LOCK_STABLE_SAMPLES && spread <= LOCK_STABLE_SPREAD_M;
    // The cab autopilot drives off immediately; once it is far from the reference
    // point the tiles there stop refining and convergence would stall — take the
    // median of what we have rather than staring at a hidden world.
    const faraway = (camera.position.x - lockRefX) ** 2 + (camera.position.z - lockRefZ) ** 2
        > LOCK_ABANDON_DIST_M * LOCK_ABANDON_DIST_M;
    if (!stable && !faraway && lockWaitS < LOCK_MAX_WAIT_S) return;
    const sorted = [...lockSamples].sort((a, b) => a - b);
    const use = stable ? lockSamples[lockSamples.length - 1] : sorted[Math.floor(sorted.length / 2)];
    const terrainAlt = use - root.position.y;        // root is still unmoved pre-lock
    if (elevAbsolute) {
        root.position.y = -trackElevationM;
        console.log(`[photoreal] track at ABSOLUTE ${trackElevationM} m (start terrain ≈ ${terrainAlt.toFixed(1)} m -> ${(terrainAlt - trackElevationM).toFixed(1)} m cut here)`);
    } else if (useConsensus) {
        root.position.y = use;
        const table = lockStations.map((item) => {
            const shift = Number.isFinite(item.groundY)
                ? terrainSeatOffset({
                    trackY: item.y,
                    unshiftedGroundY: item.groundY,
                    authoredGroundOffsetM: item.authoredOffsetM,
                })
                : null;
            return `${item.arcM.toFixed(0)}m:${shift === null ? 'miss' : shift.toFixed(2)}`;
        }).join(' ');
        console.log(`[photoreal] authored profile registered by consensus of ${lockStations.filter((item) => Number.isFinite(item.groundY)).length}/${lockStations.length} stations (Google shift ${root.position.y.toFixed(2)} m; candidates ${table})`);
    } else if (profileRegistrationActive) {
        const shift = terrainSeatOffset({
            trackY: lockTrackY,
            unshiftedGroundY: use,
            authoredGroundOffsetM: lockAuthoredGroundOffsetM,
        });
        root.position.y = Number.isFinite(shift) ? shift : 0;
        console.log(`[photoreal] authored profile registered once at ${lockRefX.toFixed(1)},${lockRefZ.toFixed(1)} (DGU offset ${lockAuthoredGroundOffsetM.toFixed(2)} m; Google shift ${root.position.y.toFixed(2)} m)`);
    } else {
        root.position.y -= (use - lockTrackY + TRACK_FLOAT_ABOVE_GROUND_M);
        console.log(`[photoreal] track seated ${TRACK_FLOAT_ABOVE_GROUND_M} m above start terrain (≈ ${terrainAlt.toFixed(1)} m; start track height ${lockTrackY.toFixed(1)} m). Pass ?elev=${Math.round(terrainAlt)} to pin this absolutely.`);
    }
    // Raycasting reads matrixWorld. Apply the one-time translation before the
    // first terrain classification in this same frame, and invalidate any
    // unshifted samples so a phantom cut/tunnel cannot survive the seat.
    root.updateMatrixWorld(true);
    tiles.group.updateMatrixWorld(true);
    wallHeightCache.clear();
    grounded = true;
    // One-time orientation sanity probe: on this corridor, 2 km sim-north (−Z)
    // should be the Kozjak slope (high) and 2 km sim-south the sea (≈0 m).
    // '?' just means that terrain has not streamed in yet.
    try {
        const nY = terrainTopAt(lockRefX, lockRefZ - 2000);
        const sY = terrainTopAt(lockRefX, lockRefZ + 2000);
        const alt = (v) => (v === null ? '?' : `${(v - root.position.y).toFixed(0)} m`);
        console.log(`[photoreal] orientation probe: 2 km N ≈ ${alt(nY)}, 2 km S ≈ ${alt(sY)}`);
    } catch (_e) { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Corridor mask — the clip footprint. The route ribbon (centreline offset
// ±half-width, at y=0) is rendered top-down into a small texture over a sliding
// window around the cab; the tile-material shader patch samples it to decide
// what to discard. corridorSegs keeps the same centreline as a flat array for
// CPU-side tests (wall chunks, walk-mode ghost-ground rejection).
const MASK_WINDOW_HALF_M = PHOTO_CORRIDOR_MASK_WINDOW_HALF_M;
const MASK_RES = PHOTO_CORRIDOR_MASK_RESOLUTION;
const MASK_TEXEL_M = (MASK_WINDOW_HALF_M * 2) / MASK_RES;
const MASK_MOVE_M = 150;             // slide the window after this much travel
const CUT_FLOOR_Y = -0.4;            // trench floor sits this far below the LOCAL track height
let corridorSegs = [];               // flat [ax,az,bx,bz,ya,yb], immutable authored scene Y
let profileCorridorSegs = [];        // ASL-only subset for the one DGU/Google registration
let corridorTrackIds = [];           // one optional authored track id per corridor segment
let corridorRunIds = [];             // source LineString identity; never bridge separate route legs
let profileCorridorTrackIds = [];    // matching ids for profileCorridorSegs
let photoStationEnvelopes = [];      // exact canonical station ownership in the photo tangent frame
let photoStationStructureByKey = new Map();
let photoStationStructureRevision = 0;
let photoPillarClearance = null;
let sourceSuspendedInTunnel = false;
let ribbonMesh = null;
let tilesErrorTarget = 8;            // desired SSE target; re-asserted per frame (ion plugin overwrites)
// Per-segment carve half-width (parallel to corridorSegs stride 6) and the
// per-vertex join-disc radius: at-grade spans carve narrow, everything else
// keeps the full corridor. See PHOTO_AT_GRADE_CORRIDOR_HALF_WIDTH_M.
// Ribbon quads TAPER between the two vertex widths (corridorSegHalfEndsM,
// stride 2) so a wide↔narrow flip never clips ground the narrow fill can't
// dress — the join disc takes the vertex's max width, and both adjacent quads
// meet it at exactly that width.
let corridorSegHalfM = [];
let corridorSegHalfEndsM = [];
const corridorDiscHalfM = new Map();
let maskRT = null, maskScene = null, maskCamera = null;
let maskReady = false, maskCenterX = 0, maskCenterZ = 0;
// Per-fragment trench floor (M4): the mask's BLUE channel carries the track's
// local height, normalised over [floorEncodeMin, floorEncodeMin+floorEncodeRange]
// via ribbon vertex colors. Legacy flat sessions encode y=0 and reduce to the
// old constant-floor behaviour; the range adapts to the session's track span
// so 8-bit quantisation stays centimetres, not metres.
let floorEncodeMin = -4;
let floorEncodeRange = 8;
const corridorUniforms = {
    uCorridorMask: { value: null },
    uCorridorMin: { value: new THREE.Vector2() },
    uCorridorScale: { value: 1 / (2 * MASK_WINDOW_HALF_M) },
    uCorridorOn: { value: 0 },
    uFloorMin: { value: -4 },
    uFloorRange: { value: 8 },
};
function encodeFloor(y) {
    return Math.max(0, Math.min(1, (y - floorEncodeMin) / floorEncodeRange));
}

// A disc of corridor radius at a polyline vertex — the "round join" that fills
// the wedge a quad-per-segment ribbon leaves open on the outside of a bend
// (on this proposal's hairpins those wedges were walkable cracks in the cut).
// Every mask vertex carries color (1, 0, encodedFloor) — R footprint, B floor.
const JOIN_SEGS = 10;
function pushJoinDisc(positions, colors, x, z, y, radiusM = CORRIDOR_HALF_WIDTH_M, rValue = 1) {
    const b = encodeFloor(y);
    for (let k = 0; k < JOIN_SEGS; k++) {
        const a0 = (k / JOIN_SEGS) * Math.PI * 2, a1 = ((k + 1) / JOIN_SEGS) * Math.PI * 2;
        positions.push(
            x, 0, z,
            x + Math.cos(a0) * radiusM, 0, z + Math.sin(a0) * radiusM,
            x + Math.cos(a1) * radiusM, 0, z + Math.sin(a1) * radiusM,
        );
        // B premultiplied by R: the shader divides payload by coverage
        // (bilinear edge blending), so every writer must premultiply.
        const pb = b * rValue;
        colors.push(rValue, 0, pb, rValue, 0, pb, rValue, 0, pb);
    }
}
// UNIFIED CLOSURE (2026-07-23): removal, slab and wall are ONE chain, all
// straight from the plan contract — never ad-hoc offsets that drift apart and
// leave a horizontal strip of removed-but-uncovered ground (a "void from
// above"). Per chunk, a single footprint half-width W drives everything:
//   • removal (mask core, R=1) = W                       — the vertical prism cut
//   • floor slab               = plan.floorHalfWidthM    (= W + apron)  covers it
//   • edge beam / retaining wall = plan.wallCenterDistanceM  straddles the slab edge
// The plan's `apron` (maskContainmentApron, ~1 texel) is the ONLY margin: it
// insets the cut line UNDER the slab so the raster-fuzzy edge is hidden, and
// the beam straddling the slab edge caps the drop and any mesh lip. There is
// NO shave/collar band — cutting anything OUTSIDE the footprint (a height
// threshold grazing the ground) only ever scalloped or sliced hollow shells.
function edgeBeamDistForPlan(plan) {
    return plan.wallCenterDistanceM;
}

// End-of-line stations: the drawn line usually ENDS at the station centre, so
// half the station would hang beyond the civil works. Terminal route ends
// with a stop nearby get the CORRIDOR (carve + dressing, not the rails)
// extended so the whole station sits inside its tunnel/trench/viaduct; the
// extension tip is remembered so the dresser can seal it with a headwall.
const STATION_END_COVER_M = 45;      // half of a rendered station's structure
                                     // (platform+hall), not the full 170 m
                                     // planning envelope — 85 extended lines
                                     // by absurd tens of metres
let photoTerminalEnds = [];          // {x,z,y,ux,uz} outward tips of extended terminals
function extendTerminalCorridorsForStations(lineJobs) {
    photoTerminalEnds = [];
    const keyOf = (p) => `${p[0].toFixed(2)}|${p[1].toFixed(2)}`;
    const vertexUse = new Map();
    for (const job of lineJobs) {
        for (const p of job.pts) vertexUse.set(keyOf(p), (vertexUse.get(keyOf(p)) || 0) + 1);
    }
    const stopsScene = [];
    for (const stop of stationStops || []) {
        const lon = Number(stop?.lng ?? stop?.lon);
        const lat = Number(stop?.lat);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        const p = photoTrackFrame
            ? photoTrackFrame.toScene(lon, lat, Number(stop?.elevM) || 0)
            : geoToLocal(lon, lat, anchorLatLon.lon, anchorLatLon.lat);
        stopsScene.push({ x: p.x, z: p.z });
    }
    for (const job of lineJobs) {
        if (!job.isAsl || job.pts.length < 2) continue;
        for (const atStart of [true, false]) {
            const tipIdx = atStart ? 0 : job.pts.length - 1;
            const innerIdx = atStart ? 1 : job.pts.length - 2;
            const tip = job.pts[tipIdx];
            if ((vertexUse.get(keyOf(tip)) || 0) > 1) continue;   // junction, not a terminal
            let nearestStopM = Infinity;
            for (const s of stopsScene) {
                nearestStopM = Math.min(nearestStopM, Math.hypot(s.x - tip[0], s.z - tip[1]));
            }
            if (nearestStopM > STATION_END_COVER_M) continue;
            const extendM = STATION_END_COVER_M - nearestStopM + 5;
            const inner = job.pts[innerIdx];
            const dx = tip[0] - inner[0], dz = tip[1] - inner[1];
            const L = Math.hypot(dx, dz);
            if (L < 1e-3) continue;
            const ux = dx / L, uz = dz / L;
            const ext = [tip[0] + ux * extendM, tip[1] + uz * extendM, tip[2]];
            const tipC = job.coords[tipIdx] || [0, 0, 0];
            const innC = job.coords[innerIdx] || tipC;
            const s = extendM / L;
            const extC = [
                Number(tipC[0]) + (Number(tipC[0]) - Number(innC[0])) * s,
                Number(tipC[1]) + (Number(tipC[1]) - Number(innC[1])) * s,
                Number(tipC[2]) || 0,
            ];
            if (atStart) {
                job.pts.unshift(ext);
                job.coords.unshift(extC);
                if (Array.isArray(job.segmentTrackIds)) {
                    job.segmentTrackIds.unshift(job.segmentTrackIds[0] ?? null);
                }
            } else {
                job.pts.push(ext);
                job.coords.push(extC);
            }
            photoTerminalEnds.push({ x: ext[0], z: ext[1], y: ext[2], ux, uz });
        }
    }
}

// Track vs DGU bare earth at a scene point — the authored design offset. Null
// while the ground-offset provider is absent (fresh worlds, non-planner data).
function designOffsetAtScene(x, z, trackY, trackId = null) {
    const ground = expectedDguGroundYAt(x, z, trackY, trackId);
    return Number.isFinite(ground) ? trackY - ground : null;
}
const AT_GRADE_DESIGN_EPS_M = 1.75;

function buildCorridorData() {
    // Whether the ridden corridor is a RECONSTRUCTION of an existing railway.
    // Its solved rail over a resampled 20 m grid chatters across the civil
    // thresholds, so classification low-passes the terrain and needs a longer
    // run (see RECONSTRUCTION_TERRAIN_SMOOTHING_M in rail-formation.js). The
    // model world decides this per feature; the photo world builds one corridor
    // per session, so it is decided once here and read at classification.
    corridorIsReconstruction = (corridorTracks || []).some(feat => (
        feat?.properties?.source === 'reference-project'
        || feat?.properties?.alignmentSource === 'reference-project'
    ));
    corridorSegs = [];
    corridorSegHalfM = [];
    corridorSegHalfEndsM = [];
    corridorDiscHalfM.clear();
    profileCorridorSegs = [];
    corridorTrackIds = [];
    corridorRunIds = [];
    profileCorridorTrackIds = [];
    // Two passes: collect every line's kept segments/discs first, so the floor
    // encoding range can adapt to the session's actual track-height span
    // before any vertex color is written.
    const collected = [];
    const stationRoutes = [];
    let nextRouteRunId = 0;
    // Pass 0: map every line into scene space, so terminal extension can see
    // ALL vertices (junction detection needs the full set) and the stops.
    const lineJobs = [];
    for (const feat of corridorTracks || []) {
        const g = feat && feat.geometry;
        if (!g) continue;
        // ASL features carry the authored grade relative to one session datum.
        // Map their complete 3D line into Google's WGS84 tangent frame; terrain
        // never participates in this conversion. Legacy level features retain
        // their old at-grade-only corridor behavior.
        const isAsl = feat?.properties?.elevationDatum === 'asl';
        const featureTrackIds = Array.isArray(feat?.properties?.trackIds)
            ? feat.properties.trackIds
            : [];
        const featureSegmentTrackIds = Array.isArray(feat?.properties?.segmentTrackIds)
            ? feat.properties.segmentTrackIds
            : null;
        const trackId = feat?.properties?.trackId
            ?? (featureTrackIds.length === 1 ? featureTrackIds[0] : null);
        if (isAsl) profileRegistrationActive = true;
        const lines = g.type === 'LineString' ? [g.coordinates]
            : g.type === 'MultiLineString' ? g.coordinates : [];
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            const coords = lines[lineIndex];
            const segmentTrackIds = g.type === 'MultiLineString'
                && Array.isArray(featureSegmentTrackIds?.[lineIndex])
                ? featureSegmentTrackIds[lineIndex]
                : featureSegmentTrackIds;
            const pts = (coords || []).map((c) => {
                const relativeY = Number(c[2]);
                const p = isAsl && photoTrackFrame
                    ? photoTrackFrame.toScene(c[0], c[1], relativeY)
                    : geoToLocal(c[0], c[1], anchorLatLon.lon, anchorLatLon.lat);
                return [p.x, p.z, isAsl && photoTrackFrame ? p.y : relativeY];
            });
            lineJobs.push({
                feat,
                isAsl,
                featureTrackIds,
                segmentTrackIds: Array.isArray(segmentTrackIds)
                    ? segmentTrackIds.slice()
                    : segmentTrackIds,
                trackId,
                coords: (coords || []).slice(),
                pts,
            });
        }
    }
    extendTerminalCorridorsForStations(lineJobs);
    for (const job of lineJobs) {
        {
            const { feat, isAsl, featureTrackIds, segmentTrackIds, trackId, coords, pts } = job;
            const routeRunId = nextRouteRunId++;
            collected.push({
                corridor: isAsl
                    ? collectFullCorridor(pts)
                    : collectAtGradeCorridor(pts, AT_GRADE_EPS_M),
                isAsl,
                trackId,
                segmentTrackIds,
                routeRunId,
            });
            stationRoutes.push(...splitStationTrackRouteBySegmentOwners({
                routeKey: `${routeRunId}`,
                routeRunId,
                trackId,
                trackIds: featureTrackIds,
                segmentTrackIds,
                properties: feat?.properties || {},
                usesPhotoFrame: isAsl && !!photoTrackFrame,
                points: pts.map((point, pointIndex) => ({
                    x: point[0],
                    z: point[1],
                    y: point[2],
                    relativeHeightM: Number(coords?.[pointIndex]?.[2]) || 0,
                    lon: Number(coords?.[pointIndex]?.[0]),
                    lat: Number(coords?.[pointIndex]?.[1]),
                })),
            }));
        }
    }
    photoStationEnvelopes = buildPhotoStationCivilEnvelopes({
        stops: stationStops,
        routes: prepareStationTrackRoutes(stationRoutes),
        genericDeckHalfWidthM: DECK_WIDTH_M * 0.5,
        genericCorridorHalfWidthM: CORRIDOR_HALF_WIDTH_M,
        locateStop: (stop, usePhotoFrame) => {
            const lon = Number(stop?.lng ?? stop?.lon);
            const lat = Number(stop?.lat);
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
            const relativeHeightM = Number(stop?.elevM) || 0;
            return usePhotoFrame && photoTrackFrame
                ? photoTrackFrame.toScene(lon, lat, relativeHeightM)
                : geoToLocal(lon, lat, anchorLatLon.lon, anchorLatLon.lat);
        },
    });
    let minY = 0, maxY = 0;
    for (const { corridor: { segs } } of collected) {
        for (const s of segs) {
            minY = Math.min(minY, s[4], s[5]);
            maxY = Math.max(maxY, s[4], s[5]);
        }
    }
    floorEncodeMin = minY - 4;
    floorEncodeRange = Math.max(maxY - minY + 8, 8);
    corridorUniforms.uFloorMin.value = floorEncodeMin;
    corridorUniforms.uFloorRange.value = floorEncodeRange;

    const positions = [];
    const colors = [];
    // Pass A: base width per segment + final join-disc width per vertex, over
    // ALL routes — quads and discs are emitted only afterwards, so a vertex
    // shared across routes (junctions) already knows its max width.
    const quadJobs = [];
    const discJobs = [];
    for (const {
        corridor: { segs, discCenters },
        isAsl,
        trackId,
        segmentTrackIds,
        routeRunId,
    } of collected) {
        for (let segmentIndex = 0; segmentIndex < segs.length; segmentIndex++) {
            const [ax, az, bx, bz, ya, yb] = segs[segmentIndex];
            const segmentTrackId = isAsl
                ? (segmentTrackIds?.[segmentIndex] ?? trackId)
                : trackId;
            const dx = bx - ax, dz = bz - az;
            const L = Math.hypot(dx, dz);
            if (L < 1e-3) continue;
            corridorSegs.push(ax, az, bx, bz, ya, yb);
            corridorTrackIds.push(segmentTrackId);
            corridorRunIds.push(routeRunId);
            if (isAsl) {
                profileCorridorSegs.push(ax, az, bx, bz, ya, yb);
                profileCorridorTrackIds.push(segmentTrackId);
            }
            // Per-span carve width: the FULL corridor exists for excavation —
            // only spans that dip below grade (cuts, tunnels) need it for
            // their trench walls. Everything at or ABOVE the DGU bare earth
            // (surface runs, embankment ramps, viaducts) carves just the
            // narrow formation strip: a ramp flaring to cut width next to an
            // 8 m deck read as a trumpet. Unknown DGU keeps the full width
            // (safe default). Legacy level corridors are at-grade-only.
            let segHalfM = CORRIDOR_HALF_WIDTH_M;
            if (isAsl) {
                const offA = designOffsetAtScene(ax, az, ya, segmentTrackId);
                const offB = designOffsetAtScene(bx, bz, yb, segmentTrackId);
                if (offA !== null && offB !== null
                    && offA >= -AT_GRADE_DESIGN_EPS_M
                    && offB >= -AT_GRADE_DESIGN_EPS_M) {
                    segHalfM = PHOTO_AT_GRADE_CORRIDOR_HALF_WIDTH_M;
                }
            } else {
                segHalfM = PHOTO_AT_GRADE_CORRIDOR_HALF_WIDTH_M;
            }
            corridorSegHalfM.push(segHalfM);
            const noteDisc = (x, z) => {
                const key = `${x.toFixed(3)}|${z.toFixed(3)}`;
                const prev = corridorDiscHalfM.get(key);
                if (!prev || segHalfM > prev) corridorDiscHalfM.set(key, segHalfM);
            };
            noteDisc(ax, az);
            noteDisc(bx, bz);
            quadJobs.push([ax, az, bx, bz, ya, yb, dx, dz, L, segHalfM]);
        }
        // Round joins at every kept vertex (ends double as round caps — also
        // where the clip stops because the track leaves grade). This keeps the
        // GPU mask consistent with isInsideCorridor, whose distance-to-segment
        // test is inherently round-joined.
        discJobs.push(...discCenters);
    }
    // Pass B: each quad end opens to its vertex's disc width, so the ribbon
    // TAPERS across the first/last segment of a narrow run instead of leaving
    // the wide join disc to clip crescents no floor dresses. The shave band
    // is emitted FIRST so the core ribbon overwrites it where both cover.
    const discHalfAt = (x, z, fallback) =>
        corridorDiscHalfM.get(`${x.toFixed(3)}|${z.toFixed(3)}`) ?? fallback;
    const pushTaperQuad = (job, widthFn, rValue) => {
        const [ax, az, bx, bz, ya, yb, dx, dz, L, segHalfM] = job;
        const halfA = widthFn(discHalfAt(ax, az, segHalfM));
        const halfB = widthFn(discHalfAt(bx, bz, segHalfM));
        const nxA = (-dz / L) * halfA, nzA = (dx / L) * halfA;
        const nxB = (-dz / L) * halfB, nzB = (dx / L) * halfB;
        const aL = [ax + nxA, 0, az + nzA], aR = [ax - nxA, 0, az - nzA];
        const bL = [bx + nxB, 0, bz + nzB], bR = [bx - nxB, 0, bz - nzB];
        positions.push(...aL, ...aR, ...bR, ...aL, ...bR, ...bL);
        const ba = encodeFloor(ya) * rValue, bb = encodeFloor(yb) * rValue;
        colors.push(
            rValue, 0, ba, rValue, 0, ba, rValue, 0, bb,
            rValue, 0, ba, rValue, 0, bb, rValue, 0, bb,
        );
    };
    // ONE footprint, ONE band. Paint the core (R=1) at exactly the ribbon
    // width — the vertical prism cut. There is no shave/collar: cutting
    // anything OUTSIDE the footprint means a height threshold grazing the
    // ground, which only ever scalloped or sliced open Google's hollow
    // shells. The plan's apron insets this cut edge under the slab; the slab
    // covers all of it; the wall straddles the slab edge. Snug from above by
    // construction.
    for (const job of quadJobs) {
        const halfA = discHalfAt(job[0], job[1], job[9]);
        const halfB = discHalfAt(job[2], job[3], job[9]);
        corridorSegHalfEndsM.push(halfA, halfB);
        pushTaperQuad(job, (half) => half, 1);
    }
    for (const [px, pz, py] of discJobs) {
        pushJoinDisc(positions, colors, px, pz, py,
            discHalfAt(px, pz, CORRIDOR_HALF_WIDTH_M));
    }
    if (positions.length === 0) return false;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    // Vertex colors, not a flat tint: R = corridor footprint, B = encoded local
    // floor height. G is overdrawn only across exact tunnel cores by
    // rebuildTunnelMask; the shader then keeps the hill above the bore while
    // removing its fused underside below the designed roof.
    ribbonMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        toneMapped: false, // this render target stores data, not display colour
    }));
    ribbonMesh.frustumCulled = false;
    return true;
}

function isInsideCorridor(x, z, radiusSq = CORRIDOR_HALF_SQ) {
    for (let s = 0; s + 5 < corridorSegs.length; s += 6) {
        const ax = corridorSegs[s], az = corridorSegs[s + 1];
        const dx = corridorSegs[s + 2] - ax, dz = corridorSegs[s + 3] - az;
        const lenSq = dx * dx + dz * dz;
        let t = lenSq > 0 ? ((x - ax) * dx + (z - az) * dz) / lenSq : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + dx * t - x, qz = az + dz * t - z;
        if (qx * qx + qz * qz <= radiusSq) return true;
    }
    return false;
}

// Hairpin test that IGNORES the probe's own stretch of route: the plain
// corridor test cannot tell a true hairpin (another leg crossing) from an
// ordinary curve of the SAME run — at every sharp bend it judged the edge
// beam "inside another corridor" and skipped it, leaving the shave ring's
// cut face exposed as a void pit at the kink.
function isInsideForeignCorridor(x, z, radiusSq, ownRunId, ownSegmentIndex, skipSpan = 2) {
    for (let s = 0; s + 5 < corridorSegs.length; s += 6) {
        const segmentIndex = Math.floor(s / 6);
        if (corridorRunIds[segmentIndex] === ownRunId
            && Math.abs(segmentIndex - ownSegmentIndex) <= skipSpan) continue;
        const ax = corridorSegs[s], az = corridorSegs[s + 1];
        const dx = corridorSegs[s + 2] - ax, dz = corridorSegs[s + 3] - az;
        const lenSq = dx * dx + dz * dz;
        let t = lenSq > 0 ? ((x - ax) * dx + (z - az) * dz) / lenSq : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + dx * t - x, qz = az + dz * t - z;
        if (qx * qx + qz * qz <= radiusSq) return true;
    }
    return false;
}

// CPU mirror of the WIDTH-AWARE clip: nearest corridor point plus the LOCAL
// core and shave half-widths (the ribbon tapers per segment). The walk ghost
// filter must agree with the shader about what was removed — testing the
// fixed full width rejected VISIBLE ground beside narrow at-grade spans as
// "ghost", and the walker fell straight through it on spawn.
const GHOST_PROBE_RADIUS_SQ = 14 * 14;
function corridorClipSampleAt(x, z) {
    let best = null, bestDistSq = Infinity;
    for (let s = 0; s + 5 < corridorSegs.length; s += 6) {
        const ax = corridorSegs[s], az = corridorSegs[s + 1];
        const dx = corridorSegs[s + 2] - ax, dz = corridorSegs[s + 3] - az;
        const lenSq = dx * dx + dz * dz;
        let t = lenSq > 0 ? ((x - ax) * dx + (z - az) * dz) / lenSq : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + dx * t - x, qz = az + dz * t - z;
        const distSq = qx * qx + qz * qz;
        if (distSq > GHOST_PROBE_RADIUS_SQ || distSq >= bestDistSq) continue;
        const segmentIndex = Math.floor(s / 6);
        const halfA = corridorSegHalfEndsM[segmentIndex * 2]
            ?? corridorSegHalfM[segmentIndex] ?? CORRIDOR_HALF_WIDTH_M;
        const halfB = corridorSegHalfEndsM[segmentIndex * 2 + 1] ?? halfA;
        const baseHalf = halfA + (halfB - halfA) * t;
        const ya2 = corridorSegs[s + 4], yb2 = corridorSegs[s + 5];
        bestDistSq = distSq;
        // One footprint width — mirrors the mask's single R=1 core band.
        best = {
            y: ya2 + (yb2 - ya2) * t,
            dist: Math.sqrt(distSq),
            coreHalf: baseHalf,
            shaveHalf: baseHalf,
        };
    }
    return best;
}

// Local track height at (x, z): lerped along the NEAREST corridor segment
// within the corridor radius; null outside. CPU counterpart of the mask's
// blue channel — walk ghost-ground must agree with the shader about where
// the trench floor is on a graded route.
function corridorFloorYAt(x, z, radiusSq = CORRIDOR_HALF_SQ) {
    return nearestCorridorPointAt(x, z, radiusSq)?.y ?? null;
}

// Nearest point on the fixed authored alignment. In addition to serving the
// corridor floor, this gives the one terrain-registration tie a real point on
// the route even when the session origin is a few metres off the centreline.
function nearestPointOnSegments(
    segments,
    x,
    z,
    radiusSq = Infinity,
    segmentTrackIds = null,
) {
    let best = null, bestDistSq = Infinity;
    for (let s = 0; s + 5 < segments.length; s += 6) {
        const ax = segments[s], az = segments[s + 1];
        const dx = segments[s + 2] - ax, dz = segments[s + 3] - az;
        const lenSq = dx * dx + dz * dz;
        let t = lenSq > 0 ? ((x - ax) * dx + (z - az) * dz) / lenSq : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + dx * t - x, qz = az + dz * t - z;
        const distSq = qx * qx + qz * qz;
        if (distSq <= radiusSq && distSq < bestDistSq) {
            bestDistSq = distSq;
            best = {
                x: ax + dx * t,
                z: az + dz * t,
                y: segments[s + 4] + (segments[s + 5] - segments[s + 4]) * t,
                ux: lenSq > 0 ? dx / Math.sqrt(lenSq) : 0,
                uz: lenSq > 0 ? dz / Math.sqrt(lenSq) : -1,
                trackId: segmentTrackIds?.[Math.floor(s / 6)] ?? null,
                distSq,
            };
        }
    }
    return best;
}

function nearestCorridorPointAt(x, z, radiusSq = Infinity) {
    return nearestPointOnSegments(corridorSegs, x, z, radiusSq, corridorTrackIds);
}

function nearestProfileCorridorPointAt(x, z, radiusSq = Infinity) {
    return nearestPointOnSegments(
        profileCorridorSegs,
        x,
        z,
        radiusSq,
        profileCorridorTrackIds,
    );
}
// Wall chunks whose outer face lies this close to any OTHER leg of the route are
// hairpin artifacts (a wall across the track); slightly under the corridor width
// so gentle curves, whose neighbours run just outside, are not affected.
const HAIRPIN_SKIP_SQ = (CORRIDOR_HALF_WIDTH_M - 0.5) ** 2;

// True for raycast hits on the ORIGINAL terrain surface inside the corridor —
// visually removed by the shader but still present as geometry. Walk mode
// rejects these so the walker stands on the trench floor inside a cut instead
// of floating on invisible mesh.
export function isPhotorealGhostGround(x, y, z) {
    if (!active || !carveEnabled || !grounded) return false;
    const stationSource = photoStationSourceOwnershipAt(photoStationEnvelopes, x, z);
    if (stationSource?.mode === 'station-core') return y < stationSource.roofY;
    if (stationSource?.mode === 'open') return y > stationSource.floorY + CUT_FLOOR_Y;
    const portalSource = tunnelPortalSourceOwnershipAt(x, z);
    if (portalSource?.mode === 'tunnel-core') return y < portalSource.roofY;
    if (portalSource?.mode === 'open') return y > portalSource.floorY + CUT_FLOOR_Y;
    // Deep-cut flank bands mirror the mask: below the roof plane the crust was
    // shader-removed (ghost), above it the retained hillside is real support.
    const flank = photoCutFlankOwnershipAt(cutFlankStrips, x, z, {
        tunnelRoofOffsetM: TUNNEL_SOURCE_ROOF_OFFSET_M,
    });
    if (flank) return y < flank.roofY;
    const clip = corridorClipSampleAt(x, z);
    if (!clip) return false;
    // In an intact tunnel core the visible hill begins above the designed
    // tube roof; fused source faces/skirts below it were shader-discarded and
    // must not become invisible walk supports. Cut-and-cover mouths use the
    // ordinary open-cut rule below.
    if (isInsideTunnelCore(x, z)) {
        return y < clip.y + TUNNEL_SOURCE_ROOF_OFFSET_M;
    }
    // Ghost mirrors the shader's single band: inside the footprint, the mesh
    // above the trench floor was discarded, so it is ghost (no walk support);
    // below the floor and outside the footprint it is real ground.
    if (clip.dist <= clip.coreHalf) return y > clip.y + CUT_FLOOR_Y;
    return false;
}

// True when a surface prop at (x, z) stands over ground the corridor carve
// removed — inside the trench / at-grade footprint but NOT over a tunnel span,
// where the hill (and everything growing on it) stays intact. Decor consults
// this to cull trees so none pokes through an open cut or the trackbed. Reads
// corridorSegs / tunnelSpans, both populated during the build passes rather than
// the async tile stream, so it is usable as soon as the corridor exists.
export function isPhotorealCorridorGround(x, z) {
    if (!active || !carveEnabled || corridorSegs.length === 0) return false;
    const stationSource = photoStationSourceOwnershipAt(photoStationEnvelopes, x, z);
    if (stationSource?.mode === 'station-core') return false;
    if (stationSource?.mode === 'open') return true;
    const portalSource = tunnelPortalSourceOwnershipAt(x, z);
    // The collar's ownership is bore-style now (the hill above the source roof
    // stays real), but decor over the mouth strip still stands on removed or
    // masonry-buried ground — keep culling it exactly as the old full-removal
    // collar did.
    if (portalSource?.sourceMode === 'portal-collar') return true;
    if (portalSource?.mode === 'tunnel-core') return false;
    if (portalSource?.mode === 'open') return true;
    if (isInsideTunnelCore(x, z)) return false; // hill kept over the bore core
    return isInsideCorridor(x, z);
}

// Local track-deck / trench-floor height at (x, z) on the fixed corridor, for
// WALK support. This is the SAME authoritative floor the ghost-ground shader
// logic uses (corridorFloorYAt), so the walker stands on the deck the carve
// removed the terrain for — even when the dressing floor-slab mesh is momentarily
// absent (freshly streamed, or not yet rebuilt around a walker who left the cab
// spawn). Without it the carve rejects the Google ground inside a cut and the
// walker falls straight through the track into the void. Null outside the
// corridor and inside an underground/covered station core, whose hall floor a
// different owner supplies. Usable as soon as the corridor exists.
export function photorealCorridorDeckY(x, z) {
    if (!active || corridorSegs.length === 0) return null;
    if (photoStationSourceOwnershipAt(photoStationEnvelopes, x, z)?.mode === 'station-core') {
        return null;
    }
    return corridorFloorYAt(x, z);
}

function isInsideTunnelCore(x, z) {
    if (photoStationSourceOwnershipAt(photoStationEnvelopes, x, z)?.mode === 'station-core') {
        return true;
    }
    // Station masks render after portal bands, so their canonical ownership
    // must win here too when a generic running-tunnel mouth meets a hall.
    const portalSource = tunnelPortalSourceOwnershipAt(x, z);
    if (portalSource) return portalSource.mode === 'tunnel-core';
    for (const span of tunnelSpans) {
        const dx = span.x1 - span.x0;
        const dz = span.z1 - span.z0;
        const lengthSq = dx * dx + dz * dz;
        if (lengthSq <= 1e-9) continue;
        const t = ((x - span.x0) * dx + (z - span.z0) * dz) / lengthSq;
        if (t < 0 || t > 1) continue;
        const qx = span.x0 + dx * t - x;
        const qz = span.z0 + dz * t - z;
        if (qx * qx + qz * qz <= CORRIDOR_HALF_SQ) return true;
    }
    // Match the mask's round INTERNAL bend joins without round-capping either
    // portal face (which would extend core ownership into an open mouth).
    // Mirror of the mask's face clamp: a join disc closer to its run's end
    // (the portal face) than the corridor radius is clamped to that distance,
    // so core ownership can never bulge out through the mouth over the open
    // approach (the un-killable portal sliver).
    for (let index = 1; index < tunnelSpans.length; index++) {
        const before = tunnelSpans[index - 1];
        const after = tunnelSpans[index];
        if (before.routeRunId !== after.routeRunId) continue;
        if (Math.hypot(before.x1 - after.x0, before.z1 - after.z0) > 1e-4) continue;
        let first = null;
        let last = null;
        for (const span of tunnelSpans) {
            if (span.routeRunId !== after.routeRunId) continue;
            if (!first) first = span;
            last = span;
        }
        const radius = Math.min(
            CORRIDOR_HALF_WIDTH_M,
            Math.hypot(after.x0 - first.x0, after.z0 - first.z0),
            Math.hypot(after.x0 - last.x1, after.z0 - last.z1),
        );
        const dx = x - after.x0;
        const dz = z - after.z0;
        if (dx * dx + dz * dz <= radius * radius) return true;
    }
    return false;
}

function tunnelPortalSourceOwnershipAt(x, z) {
    return photoPortalSourceOwnershipAt(
        tunnelPortalCollars,
        tunnelPortalHoods,
        x,
        z,
        {
            collarHalfWidthM: PORTAL_COLLAR_HALF_WIDTH_M,
            hoodHalfWidthM: PORTAL_HOOD_SOURCE_HALF_WIDTH_M,
            tunnelRoofOffsetM: TUNNEL_SOURCE_ROOF_OFFSET_M,
        },
    );
}

function ensureMaskObjects() {
    if (maskRT) return;
    maskRT = new THREE.WebGLRenderTarget(MASK_RES, MASK_RES, { depthBuffer: false });
    maskRT.texture.minFilter = THREE.LinearFilter;
    maskRT.texture.magFilter = THREE.LinearFilter;
    maskRT.texture.generateMipmaps = false;
    maskScene = new THREE.Scene();
    maskScene.background = new THREE.Color(0x000000);
    if (ribbonMesh) maskScene.add(ribbonMesh);
    maskCamera = new THREE.OrthographicCamera(
        -MASK_WINDOW_HALF_M, MASK_WINDOW_HALF_M, MASK_WINDOW_HALF_M, -MASK_WINDOW_HALF_M, 1, 1000);
    // Looking straight down with this up-vector, screen-right = +X and
    // screen-up = -Z; the shader flips v to match (see patchTileMaterial).
    maskCamera.up.set(0, 0, -1);
    corridorUniforms.uCorridorMask.value = maskRT.texture;
}

function renderCorridorMask(cx, cz) {
    ensureMaskObjects();
    maskCamera.position.set(cx, 500, cz);
    maskCamera.lookAt(cx, 0, cz);
    maskCamera.updateMatrixWorld(true);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(maskRT);
    renderer.render(maskScene, maskCamera);
    renderer.setRenderTarget(prev);
    corridorUniforms.uCorridorMin.value.set(cx - MASK_WINDOW_HALF_M, cz - MASK_WINDOW_HALF_M);
    corridorUniforms.uCorridorOn.value = 1;
    maskCenterX = cx; maskCenterZ = cz;
    maskReady = true;
}

// Rebuild the tunnel-core quads drawn OVER the red route ribbon in the mask
// scene. Intact hill cores become green; the portal collar is green too —
// bore-style clearance below the shared source roof, with the roof-to-crown
// band it keeps buried inside the deeper opaque facade and the real hill kept
// above the crown (a red sky-column here is what used to shred the hillside
// crust above every portal). Deep-cut flank bands do the same under retaining
// walls. The narrower green hood begins behind the collar and tapers to the
// running-tube roof. BLUE carries ordinary track floor for red and effective
// roof-relative track for green, so facade height never has to fit the track
// encoding range.
// Returns true when the mask needs a re-render (spans exist now or existed).
function rebuildTunnelMask(tunnelSlices, portalCollars, portalHoods, flankStrips = []) {
    const had = !!tunnelMaskMesh
        || !!tunnelPortalCollarMaskMesh
        || !!tunnelPortalHoodMaskMesh
        || !!cutFlankMaskMesh;
    disposeMaskMesh(tunnelMaskMesh);
    disposeMaskMesh(tunnelPortalCollarMaskMesh);
    disposeMaskMesh(tunnelPortalHoodMaskMesh);
    disposeMaskMesh(cutFlankMaskMesh);
    tunnelMaskMesh = null;
    tunnelPortalCollarMaskMesh = null;
    tunnelPortalHoodMaskMesh = null;
    cutFlankMaskMesh = null;
    if (!maskScene) return had;
    const core = buildTunnelCoreMaskQuads(tunnelSlices, {
        halfWidthM: CORRIDOR_HALF_WIDTH_M,
        encodeFloor,
    });
    tunnelMaskMesh = makeMaskMesh(core, 1); // green core after the red ribbon
    // Flank bands draw with the core: they only ever narrow the red ribbon's
    // sky void to the wall-to-wall aperture, and collars/hoods still win at
    // the portal faces where they overlap.
    const flanks = buildCutFlankMaskQuads(flankStrips, { encodeFloor });
    cutFlankMaskMesh = makeMaskMesh(flanks, 1);
    const collars = buildPortalCollarMaskQuads(portalCollars, {
        halfWidthM: PORTAL_COLLAR_HALF_WIDTH_M,
        encodeFloor,
    });
    // The collar straddles the nominal face and remains strictly inside the
    // wider/deeper opaque masonry apron. It clears oblique source triangles
    // out of the aperture on both sides without erasing the hill above it.
    tunnelPortalCollarMaskMesh = makeMaskMesh(collars, 2);
    const hoods = buildPortalHoodMaskQuads(portalHoods, {
        halfWidthM: PORTAL_HOOD_SOURCE_HALF_WIDTH_M,
        encodeFloor,
    });
    // The narrow green hood renders last: it replaces the collar only in the
    // bore and raises the source-clear roof near the face.
    tunnelPortalHoodMaskMesh = makeMaskMesh(hoods, 3);
    return had
        || !!tunnelMaskMesh
        || !!tunnelPortalCollarMaskMesh
        || !!tunnelPortalHoodMaskMesh
        || !!cutFlankMaskMesh;
}

function disposeMaskMesh(mesh) {
    if (!mesh) return;
    if (maskScene) maskScene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
}

function makeMaskMesh(data, renderOrder) {
    if (!maskScene || !data || data.positions.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(data.colors, 3));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        toneMapped: false,
        depthTest: false,
        depthWrite: false,
    }));
    mesh.frustumCulled = false;
    mesh.renderOrder = renderOrder;
    maskScene.add(mesh);
    return mesh;
}

// Stations overdraw the ordinary 12 m route ribbon with their complete civil
// footprint. Underground stair wells render last so their red openings reclaim
// two small holes from the green, source-preserving station hall.
function rebuildStationMask() {
    const had = !!stationMaskMesh || !!stationOpeningMaskMesh;
    disposeMaskMesh(stationMaskMesh);
    disposeMaskMesh(stationOpeningMaskMesh);
    stationMaskMesh = null;
    stationOpeningMaskMesh = null;
    if (!maskScene || photoStationEnvelopes.length === 0) return had;
    const data = buildPhotoStationMaskQuads(photoStationEnvelopes, {
        encodeFloor,
        tunnelSourceRoofOffsetM: TUNNEL_SOURCE_ROOF_OFFSET_M,
    });
    stationMaskMesh = makeMaskMesh(data.ownership, 4);
    stationOpeningMaskMesh = makeMaskMesh(data.openings, 5);
    return had || !!stationMaskMesh || !!stationOpeningMaskMesh;
}

// Inject the corridor discard into a streamed tile material. The vertex side
// exports the world position; the fragment side samples the top-down route mask
// and discards anything inside the corridor above the trench floor. Every
// patched shader shares the SAME uniform objects, so sliding the mask window
// updates all tiles with a couple of assignments and zero geometry work.
const CORRIDOR_MATERIAL_PATCH_ID = 'station3d-photo-corridor';
const CORRIDOR_MATERIAL_PATCH_REVISION = '5';   // v5: single-band cut + backface-earth (fog-blended)
const CORRIDOR_VERTEX_SENTINEL = '// station3d-photo-corridor vertex r2';
const CORRIDOR_FRAGMENT_SENTINEL = '// station3d-photo-corridor fragment r2';

function replaceShaderAnchor(source, anchor, replacement, stage) {
    if (!source.includes(anchor)) {
        throw new Error(`[photoreal] corridor ${stage} shader lacks ${anchor}`);
    }
    return source.replace(anchor, replacement);
}

function injectCorridorShader(shader) {
    Object.assign(shader.uniforms, corridorUniforms);
    if (shader.vertexShader.includes(CORRIDOR_VERTEX_SENTINEL)
        && shader.fragmentShader.includes(CORRIDOR_FRAGMENT_SENTINEL)) return;
    let vertex = replaceShaderAnchor(
        shader.vertexShader,
        '#include <common>',
        `#include <common>\n${CORRIDOR_VERTEX_SENTINEL}\nvarying vec3 vCorridorWorld;`,
        'vertex',
    );
    vertex = replaceShaderAnchor(
        vertex,
        '#include <project_vertex>',
        '#include <project_vertex>\nvCorridorWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
        'vertex',
    );
    shader.vertexShader = vertex;
    let fragment = replaceShaderAnchor(
        shader.fragmentShader,
        '#include <common>',
        `#include <common>
${CORRIDOR_FRAGMENT_SENTINEL}
varying vec3 vCorridorWorld;
uniform sampler2D uCorridorMask;
uniform vec2 uCorridorMin;
uniform float uCorridorScale;
uniform float uCorridorOn;
uniform float uFloorMin;
uniform float uFloorRange;`,
        'fragment',
    );
    fragment = replaceShaderAnchor(fragment, 'void main() {', `void main() {
    if (uCorridorOn > 0.5) {
        vec2 cuv = (vCorridorWorld.xz - uCorridorMin) * uCorridorScale;
        cuv.y = 1.0 - cuv.y;
        if (cuv.x > 0.0 && cuv.x < 1.0 && cuv.y > 0.0 && cuv.y < 1.0) {
            // r = corridor footprint; g = intact tunnel core; b = LOCAL track
            // height. Open mouths remove cover above the floor. In the core,
            // remove only fused source faces/skirts below the tube roof and
            // retain the actual hill above it.
            vec3 cm = texture2D(uCorridorMask, cuv).rgb;
            if (cm.r > 0.5) {
                // ONE band, the vertical prism. Divide payload by coverage
                // (bilinear edge blend) before decoding, then cut: remove mesh
                // above the trench floor inside the footprint; in a tunnel
                // bore keep the intact hill above the tube roof. The > 0.5
                // gate lands the cut edge ~half a texel INSIDE the painted
                // ribbon, so it sits under the slab overhang. No shave/collar
                // — we never discard anything outside the footprint.
                float payloadScale = max(cm.r, 0.0001);
                float tunnelCore = cm.g / payloadScale;
                float trackY = uFloorMin + (cm.b / payloadScale) * uFloorRange;
                if (tunnelCore < 0.5 && vCorridorWorld.y > trackY + ${CUT_FLOOR_Y.toFixed(2)}) discard;
                if (tunnelCore >= 0.5 && vCorridorWorld.y < trackY + ${TUNNEL_SOURCE_ROOF_OFFSET_M.toFixed(2)}) discard;
            }
        }
    }`, 'fragment');
    // Google's mesh is a single skin; a steep bank or terrace winding away from
    // the camera shows its BACKFACE, which front-side culling turns into a
    // see-through gap that reads as a hole (but is real terrain). Draw those
    // backfaces as solid earth so a fold reads as soil. (The whole-scene warm
    // cast is the sim-clock golden-hour FOG in scene/sky.js — unrelated to this.)
    fragment = replaceShaderAnchor(
        fragment,
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
    if (!gl_FrontFacing) {
        gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.33, 0.27, 0.215), 0.85);
    }`,
        'fragment',
    );
    shader.fragmentShader = fragment;
}

function patchTileMaterial(material) {
    if (!material) return;
    const changed = installRevisionedMaterialCompilePatch(material, {
        id: CORRIDOR_MATERIAL_PATCH_ID,
        revision: CORRIDOR_MATERIAL_PATCH_REVISION,
        apply: injectCorridorShader,
    });
    // Double-sided so away-facing folds aren't culled; the shader's
    // backface-earth rule (above) paints them soil. Applied AFTER
    // dithering_fragment, so the earth blend still carries the scene fog that
    // the include already mixed in — no un-fogged brown patch at distance.
    if (material.side !== THREE.DoubleSide) {
        material.side = THREE.DoubleSide;
        material.needsUpdate = true;
    } else if (changed) {
        material.needsUpdate = true;
    }
}

function patchTileDrawable(object) {
    if (!object || !(object.isMesh || object.isPoints || object.isLine)) return;
    const materials = Array.isArray(object.material)
        ? object.material
        : [object.material];
    materials.forEach(patchTileMaterial);
}

function patchTileScene(tileScene) {
    if (!tileScene) return;
    tileScene.traverse(patchTileDrawable);
}

function onTileModelLoad(ev) {
    const tileScene = ev && ev.scene;
    if (!tileScene) return;
    patchTileScene(tileScene);
    // A refined tile just arrived — the trench walls were sampled off whatever
    // (possibly coarse) mesh was there before, so ask for a rebuild. The update
    // loop coalesces the burst via WALL_TILE_REFRESH_MIN_S. It also resets the
    // reveal quiet-timer: streaming isn't done while tiles are still arriving.
    // Invalidate ONLY the cached chunk heights under this tile's footprint, so
    // the coming rebuild re-raycasts just those, not the whole window.
    if (wallHeightCache.size) {
        tileScene.updateWorldMatrix(true, true);
        const box = new THREE.Box3().setFromObject(tileScene);
        if (!box.isEmpty()) {
            const m = 20;   // covers the across-track sL/sR sample offset
            const minX = box.min.x - m, maxX = box.max.x + m;
            const minZ = box.min.z - m, maxZ = box.max.z + m;
            for (const [key, v] of wallHeightCache) {
                if (v.mx >= minX && v.mx <= maxX && v.mz >= minZ && v.mz <= maxZ) {
                    wallHeightCache.delete(key);
                }
            }
        }
    }
    wallRebuildRequested = true;
    sinceTileLoadS = 0;
}

function notePhotorealResource(ev) {
    const url = ev && ev.url;
    if (url != null) photoResourceUrls.add(String(url));
}

// ---------------------------------------------------------------------------
// The designed civil works: stone retaining walls + ballast floor in cuts, a
// viaduct (deck + concrete piers) on float stretches, and a masonry tunnel
// tube (walls, ceiling, light strip, portals) where the ground rises so far
// above the track that a cut would be a canyon. All of it is BoxGeometry
// instances, so walk-collision picks the uprights up as solid.
let wallsGroup = null;              // scene child, name 'PhotorealTrenchWalls'
let wallMesh = null;                // InstancedMesh(unit box): walls AND floor slabs
let wallX = 0, wallZ = 0;           // cab position at the last build
let wallsBuiltOnce = false;
let wallAgeS = 0;                   // time since the last build
let wallRebuildRequested = false;   // a nearby tile refined -> rebuild walls next frame
let lastCivilChunks = [];           // last classified chunk set (debug audit only)
// Per-chunk cache keeps raw Google surface observations separate from robust
// ground evidence. Civil walls, structure classification and pier feet use the
// robust ground only; a roof/tree/coarse-tile hit must never become a masonry
// tower. Heights only change when a tile REFINES — caching the raycasts turns each
// rebuild from "raycast the whole 800 m window" (the hitch) into "raycast only
// the few new/invalidated chunks". Invalidated per-tile in onTileModelLoad.
const wallHeightCache = new Map();
const _wallRayO = new THREE.Vector3();
// Replacement geometry owns every part of the source mesh the sliding clip can
// expose. Classification samples a further halo so a tunnel crossing the mask
// edge is not truncated below the shared 40 m minimum-run rule.
const WALL_WINDOW_HALF_M = MASK_WINDOW_HALF_M;
const CIVIL_CLASSIFICATION_HALO_M = 60;
const CIVIL_WINDOW_HALF_M = MASK_WINDOW_HALF_M + CIVIL_CLASSIFICATION_HALO_M;
const WALL_MOVE_M = 100;            // rebuild once the cab has travelled this far...
const WALL_REFRESH_S = 4;           // ...or this often: heights sampled off COARSE tiles right
                                    // after reveal can be wildly tall — refreshing lets them
                                    // settle onto the refined mesh even when standing still
const WALL_TILE_REFRESH_MIN_S = 2.0;// coalesce tile-load rebuild requests. buildTrenchWalls raycasts
                                    // hundreds of points against the tile mesh, so at speed a 0.5 s
                                    // cadence (~7 m) made the ride hitch rhythmically as tiles refined.
                                    // 2 s (~28 m at 50 km/h) keeps the walls current without the chop;
                                    // the movement (WALL_MOVE_M) + age (WALL_REFRESH_S) triggers still fire.
const WALL_SPAN_M = 12;             // one box per this much edge length (short = follows the terrain)
const WALL_OVERLAP_M = 1.6;         // extend boxes along-track so curve neighbours overlap seamlessly
const WALL_THICK_M = 3;
const CUT_PLAN = resolvePhotoCutPlanContract({
    maskTexelM: MASK_TEXEL_M,
    corridorHalfWidthM: CORRIDOR_HALF_WIDTH_M,
    wallThicknessM: WALL_THICK_M,
    sourceSampleApronM: 0.75,
});
// Source removal is strictly interior to the retaining wall by one complete
// mask-pixel diagonal. Keeping centre, outer face, terrain sample and floor in
// one plan contract prevents a resolution change from reopening this seam.
const WALL_CENTER_DIST_M = CUT_PLAN.wallCenterDistanceM;
const WALL_SAMPLE_DIST_M = CUT_PLAN.sourceSampleDistanceM;
// The at-grade variant of the same contract: narrow carve, matching floor lid
// and (rarely needed) low edge walls. Selected per chunk from the ribbon's
// per-segment width, so cut/tunnel machinery keeps the full-width plan.
const NARROW_PLAN = resolvePhotoCutPlanContract({
    maskTexelM: MASK_TEXEL_M,
    corridorHalfWidthM: PHOTO_AT_GRADE_CORRIDOR_HALF_WIDTH_M,
    wallThicknessM: WALL_THICK_M,
    sourceSampleApronM: 0.75,
});
// Taper spans (the ribbon funnelling between full and narrow width) get a
// plan for their own width so floor/walls always cover at least the local
// carve. Quarter-metre buckets, rounded UP — fill may overhang the clip,
// never undershoot it.
const taperPlanCache = new Map();
function planForHalfWidth(halfM) {
    if (!Number.isFinite(halfM) || halfM >= CORRIDOR_HALF_WIDTH_M - 0.05) return CUT_PLAN;
    if (halfM <= PHOTO_AT_GRADE_CORRIDOR_HALF_WIDTH_M + 0.05) return NARROW_PLAN;
    const key = Math.ceil(halfM * 4) / 4;
    let plan = taperPlanCache.get(key);
    if (!plan) {
        plan = resolvePhotoCutPlanContract({
            maskTexelM: MASK_TEXEL_M,
            corridorHalfWidthM: key,
            wallThicknessM: WALL_THICK_M,
            sourceSampleApronM: 0.75,
        });
        taperPlanCache.set(key, plan);
    }
    return plan;
}
const GROUND_NEIGHBOUR_PROBE_M = 4; // extra DSM rays only when the first hit disagrees with DGU
const GROUND_DGU_FAST_PATH_M = 2.5; // a close hit is already a plausible terrain surface
const WALL_BOTTOM_Y = PHOTO_RUNNING_TUNNEL_SECTION.wallBottomOffsetM;
                                    // wall foot dug below the floor so nothing peeks under
const WALL_MIN_CUT_M = 0.4;         // dress any edge where ground rises above the track; skip true floats
const WALL_TOP_EXTRA_M = 1.0;       // parapet: the wall tops out this much above the retained ground
const WALL_MAX_H_M = 60;            // safety clamp on a runaway ray hit
// Robust crowns deliberately sit below canopy/DSM noise — but next to a
// source-removal boundary anything left visible above a crown re-appears as
// torn crust (portal tongue, wall-top slivers). Only where burying matters
// (portal facades, tunnel-approach walls) crowns may rise toward the RAW
// local surface, within these bounded allowances over the robust estimate.
const TUNNEL_APPROACH_SURFACE_HIDE_M = 0.5;
const TUNNEL_APPROACH_SURFACE_ALLOWANCE_M = 15;
// Portals use consensus-of-samples burial (buryDsmSurfaceCrownFromSamples):
// a fixed allowance saturated on real steep hillsides and left the torn
// tongue one allowance higher, so only the rail-relative civil clamp bounds
// the facade there.
const PORTAL_SURFACE_HIDE_M = 2.0;
// Shared pool for walls, floors, decks, piers, curbs AND covered-trench tube
// pieces, consumed in ROUTE order across the civil window. It must comfortably
// exceed the worst window (covered trench ≈ 6 instances/chunk × ~250 chunks +
// station shells): when it saturates, later-in-route chunks silently get clip
// with NO dressing — black void gashes that pop in/out as the window shifts
// with small camera moves. 1024 was exactly that failure around the airport
// station. Instanced unit boxes are cheap; headroom is the right trade.
const WALL_MAX_INSTANCES = 4096;
const FLOOR_WIDTH_M = CUT_PLAN.floorHalfWidthM * 2;
                                    // MUST span wall-to-wall (+overlap): it's the LID over the
                                    // carved-away trench bottom, not a rail-width ballast bed. A
                                    // viaduct DECK can be narrow (open air below is correct), but a
                                    // narrow cut floor leaves the carved photogrammetry poking up
                                    // through the gaps. Don't shrink toward DECK_WIDTH_M.
const FLOOR_TOP_Y = PHOTO_RUNNING_TUNNEL_SECTION.floorTopOffsetM;
                                    // just under the track plane
const FLOOR_THICK_M = PHOTO_RUNNING_TUNNEL_SECTION.floorTopOffsetM
    - PHOTO_RUNNING_TUNNEL_SECTION.floorBottomOffsetM;
// Viaduct dressing for float stretches (terrain below the track): a box-girder
// deck under the trackbed, carried to the ground by concrete piers.
const DECK_WIDTH_M = 8;
const DECK_THICK_M = 1.2;
const PIER_SPACING_M = 24;          // one pier per this much route (by arc length, so stable across rebuilds)
const PIER_ALONG_M = 1.8;           // pier cross-section
const PIER_ACROSS_M = 2.6;
const PIER_TOP_Y = -1.1;            // reaches up into the deck underside
const PIER_MIN_CLEAR_M = 1.5;       // no pier where the deck is basically on the ground
const PIER_EMBED_M = 4;             // sink the foot into the terrain — deep enough
                                    // to stay buried through LOD height swings
const PIER_MAX_H_M = 80;
// Tunnel dressing for deep cuts: where the ground rises far above the track on
// BOTH sides and the centre, an open canyon reads wrong — a real railway bores.
// The hill is left intact (the shader clip is suppressed via the mask's green
// channel) and the route runs through a masonry tube: side walls, a ceiling,
// an unlit light strip, and portal frames at the transitions.
const TUNNEL_WALL_DIST_M = PHOTO_RUNNING_TUNNEL_SECTION.wallCenterM;
                                    // tube half-width (wall centre from the centreline)
const TUNNEL_WALL_THICK_M = PHOTO_RUNNING_TUNNEL_SECTION.wallThicknessM;
const TUNNEL_WALL_TOP_Y = PHOTO_RUNNING_TUNNEL_SECTION.wallTopOffsetM;
const TUNNEL_CEIL_THICK_M = PHOTO_RUNNING_TUNNEL_SECTION.roofTopOffsetM
    - PHOTO_RUNNING_TUNNEL_SECTION.roofBottomOffsetM;
const TUNNEL_SOURCE_ROOF_OFFSET_M = PHOTO_RUNNING_TUNNEL_SECTION.sourceRoofOffsetM;
const TUNNEL_CEIL_WIDTH_M = PHOTO_RUNNING_TUNNEL_SECTION.roofHalfWidthM * 2;
                                    // ceiling overlaps the tube walls so no slit shows
const PORTAL_PLAN = resolvePhotoPortalPlanContract({
    maskTexelM: MASK_TEXEL_M,
    corridorHalfWidthM: CORRIDOR_HALF_WIDTH_M,
    tunnelRoofHalfWidthM: TUNNEL_CEIL_WIDTH_M * 0.5,
});
const PORTAL_DEPTH_M = PORTAL_PLAN.facadeInwardDepthM;
const PORTAL_OUTWARD_DEPTH_M = PORTAL_PLAN.facadeOutwardDepthM;
                                    // source collar is buried on both sides of face
const PORTAL_OUTER_HALF_WIDTH_M = PORTAL_PLAN.facadeHalfWidthM;
// Keep a complete mask texel between source removal and the opaque facade on
// each flank. The central hood is deliberately narrower: its raised green/core
// payload removes only a bounded bore volume while leaving the real hill above
// and beside it intact.
const PORTAL_COLLAR_HALF_WIDTH_M = PORTAL_PLAN.collarHalfWidthM;
const PORTAL_HOOD_SOURCE_HALF_WIDTH_M = PORTAL_PLAN.hoodHalfWidthM;
const PORTAL_HOOD_ROOF_THICK_M = 0.8;
const LIGHT_MAX_INSTANCES = 1024;  // discrete fixtures use more instances than one strip/slice did
// Discrete ceiling light fixtures (short glowing boxes ~1 m every ~5 m), so the
// photo tube reads with the same 3D lighting elements as model mode instead of
// one continuous ribbon.
const TUNNEL_LIGHT_SPACING_M = 5;
const TUNNEL_LIGHT_BOX_LEN_M = 1.2;
const TUNNEL_LIGHT_BOX_WIDTH_M = 0.4;
const TUNNEL_LIGHT_BOX_THICK_M = 0.18;
let tunnelSpans = [];               // exact core segments used by walk/decor ownership checks
let tunnelPortalCollars = [];       // shallow bore-style mouth clearance under opaque headwalls
let tunnelPortalHoods = [];         // narrow green, raised-roof transitions behind collars
let cutFlankStrips = [];            // wall-buried outer ribbon strips that keep crust above the roof plane
let tunnelClassificationSpans = []; // full prior tunnel runs, including open mouths, for hysteresis
let tunnelMaskMesh = null;          // green/B-encoded overdraw quads marking intact cores
let tunnelPortalCollarMaskMesh = null; // green/B-encoded bore-style facade collars (hill kept above roof)
let tunnelPortalHoodMaskMesh = null; // green/B-encoded tapered bore hoods
let cutFlankMaskMesh = null;        // green/B-encoded deep-cut flank bands under retaining walls
let stationMaskMesh = null;         // station footprint overdraw (red open or green buried hall)
let stationOpeningMaskMesh = null;  // red stair wells drawn over a green underground hall
let lightMesh = null;               // InstancedMesh of unlit ceiling light strips
let coveredStationShellMesh = null; // indexed route-swept compact station shell
let coveredStationLightMesh = null; // matching continuous centre light strip
let coveredStationPlatformMesh = null; // route-swept platform + tactile identity
let coveredStationNameMeshes = []; // short wall boards, one texture per station
let coveredStationShellMaterial = null;
let coveredStationPlatformMaterial = null;
let tunnelEnabled = true;           // &notunnel keeps deep cuts as open canyons

function markPhotorealUnavailable(reason, error = null) {
    if (photoUnavailable) return;
    photoUnavailable = true;
    active = false;
    corridorUniforms.uCorridorOn.value = 0;
    if (root) root.visible = false;
    if (wallsGroup) wallsGroup.visible = false;
    resetWalkColliders();
    setAbstractWorldHidden(false);
    console.warn(`[photoreal] unavailable; continuing with the fallback world (${reason})`, error || '');
}

// The trench-wall group, exposed so walk mode registers it as a solid collider.
export function getPhotorealWallsGroup() {
    return (active && wallsEnabled && wallsGroup?.visible) ? wallsGroup : null;
}

// The streamed tile mesh, exposed so walk mode can raycast it for ground height —
// otherwise the walker stands on the default y=0 plane and, off the track, ends up
// buried inside the real terrain. Null until the world is streaming and seated.
export function getPhotorealGroundGroup() {
    return (active && grounded && tiles) ? tiles.group : null;
}

// World-Y of the anchor's sea level (the root offset applied at seating): real
// altitude in metres a.s.l. = worldY − offset. Null until the world is seated,
// and in non-photoreal sessions — callers fall back to relative altitude then.
// True once the photo world is seated, carved, dressed and shown. Until then the
// cab shows a "loading" overlay instead of coarse/phantom geometry.
// True once this photo session has terminally fallen back to the model world
// (registration timeout, tiles library failure). The layer host uses this to
// LATE-START model-only layers it skipped under the world contract — the
// fallback world must have its civil works.
export function isPhotorealUnavailable() {
    return photoUnavailable;
}

export function isPhotorealRevealed() {
    return photoUnavailable || (active && tilesRevealed);
}

// 0..1 progress for the photo loading bar. NOT the raw tiles.loadProgress: that
// oscillates (each streaming wave — coarse then refinements — refills the queue,
// so the fraction fills, drops, fills again). Instead ease forward monotonically
// on wall time toward the reveal cap, and complete on actual reveal — a uniform
// bar that never retreats.
export function getPhotorealLoadProgress() {
    if (photoUnavailable || (active && tilesRevealed)) return 1;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (!photoLoadStartMs) photoLoadStartMs = now;
    const frac = (now - photoLoadStartMs) / (REVEAL_MAX_WAIT_S * 1000);
    return Math.max(0, Math.min(0.98, frac));
}

// Elapsed time plus bytes the browser is allowed to expose for the exact tile
// URLs requested by 3d-tiles-renderer. Cross-origin Resource Timing entries may
// deliberately report zero without Timing-Allow-Origin; never invent a byte
// estimate from decoded GPU geometry in that case.
export function getPhotorealLoadTelemetry() {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (!photoLoadStartMs) photoLoadStartMs = now;
    let receivedBytes = 0;
    if (typeof performance !== 'undefined' && typeof performance.getEntriesByName === 'function') {
        for (const url of photoResourceUrls) {
            const entries = performance.getEntriesByName(url, 'resource');
            for (const entry of entries) {
                if (entry.startTime + 1 < photoLoadStartMs) continue;
                receivedBytes += Number(entry.encodedBodySize) || Number(entry.transferSize) || 0;
            }
        }
    }
    return {
        elapsedMs: Math.max(0, now - photoLoadStartMs),
        receivedBytes,
    };
}

// Runtime station form is intentionally absent until Google has classified the
// canonical anchor. Consumers withhold planner station geometry instead of
// drawing a saved level-0 canopy inside a tunnel for one or more frames.
export function getPhotorealStationStructure(stop) {
    const key = photoStationKey(stop);
    if (!key) return null;
    const envelope = photoStationEnvelopes.find(item => item.key === key);
    return photoStationRuntimeStructure(
        envelope,
        photoStationStructureByKey.get(key) || null,
    );
}

// A level-0 stop may resolve to tunnel only after Google streams. If its route
// bends, grades or ends inside the rigid 170 m hall envelope, photo ownership
// exposes it as tunnel-but-non-rigid so the compact route-following shell can
// replace both a surface canopy and the straight hall/access/flare.
export function canBuildPhotorealRigidStation(stop) {
    const key = photoStationKey(stop);
    if (!key) return false;
    const envelope = photoStationEnvelopes.find(item => item.key === key);
    const structure = photoStationRuntimeStructure(
        envelope,
        photoStationStructureByKey.get(key),
    );
    if (!structure) return false;
    return !!envelope && photoStationSupportsRigidStructure(envelope, structure);
}

export function getPhotorealStationStructureRevision() {
    return photoStationStructureRevision;
}

export function getPhotorealAltitudeOffset() {
    if (!(active && grounded && root)) return null;
    // Authored-profile scene Y is relative to the DGU/EVRF2000 session datum.
    // Legacy flat sessions instead use the one Google-world seating offset.
    return aslDatumM != null ? -aslDatumM : root.position.y;
}

// Snapshot used only for an in-app cab -> walk handoff. It carries object
// identity for the immutable tangent frame plus the already-resolved vertical
// Google translation; no streamed tile/root object escapes this layer.
export function getPhotorealRegistration() {
    if (!(active && grounded && root && photoTrackFrame)) return null;
    return {
        photoTrackFrame,
        seatOffsetY: root.position.y,
    };
}

// Procedural running-bond stone texture (mostly luminance — the per-instance
// colour supplies the hue, so walls, piers and tunnel lining each keep their
// tint). Deterministic LCG so every session draws the identical pattern.
function makeStoneTexture() {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = 'rgb(96,91,84)';                       // mortar
    g.fillRect(0, 0, 256, 256);
    let seed = 1234567;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0), (seed >>> 8) / 16777216);
    const rows = 6, rh = 256 / rows;                     // 4 m world tile -> ~0.67 m courses
    for (let r = 0; r < rows; r++) {
        let x = -Math.floor(rnd() * 40);
        while (x < 256) {
            const w = 26 + Math.floor(rnd() * 38);
            const v = 0.86 + rnd() * 0.28;
            g.fillStyle = `rgb(${Math.round(168 * v)},${Math.round(161 * v)},${Math.round(148 * v)})`;
            g.fillRect(x + 1.5, r * rh + 1.5, w - 3, rh - 3);
            x += w;
        }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

function patchSweptStoneMaterial(material) {
    material.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vStoneWorld;')
            .replace('#include <project_vertex>', '#include <project_vertex>\nvStoneWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vStoneWorld;')
            .replace('#include <map_fragment>', `
    {
        vec3 tw = abs(normalize(cross(dFdx(vStoneWorld), dFdy(vStoneWorld))));
        tw /= (tw.x + tw.y + tw.z);
        vec4 stone = texture2D(map, vStoneWorld.zy / 4.0) * tw.x
                   + texture2D(map, vStoneWorld.xz / 4.0) * tw.y
                   + texture2D(map, vStoneWorld.xy / 4.0) * tw.z;
        diffuseColor *= stone;
    }`);
    };
}

function makeCoveredStationNameTexture(label) {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 128;
    const context = canvas.getContext('2d');
    context.fillStyle = '#1f2937';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#ffffff';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    let fontPx = 76;
    const text = String(label || 'Station').slice(0, 28);
    do {
        context.font = `bold ${fontPx}px sans-serif`;
        if (context.measureText(text).width <= canvas.width - 80) break;
        fontPx -= 4;
    } while (fontPx > 36);
    context.fillText(text, canvas.width * 0.5, canvas.height * 0.52);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

function ensureWallMesh() {
    if (wallMesh) return;
    const geo = new THREE.BoxGeometry(1, 1, 1);         // unit box, sized per instance via matrix
    // White base so the per-instance colour IS the final tone (the shader
    // multiplies the two); flat shading gives each face its own lit shade.
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1.0, metalness: 0.0, flatShading: true });
    // Stone courses, sampled TRIPLANAR in WORLD space: the instance boxes come
    // in every size, so object UVs would stretch the pattern — world-space
    // projection keeps the course height constant everywhere, and overlapping
    // neighbour boxes sample the same pattern so their seams disappear. The
    // map is assigned so three compiles its map path; the actual sampling is
    // replaced below (face normal derived from position derivatives — exact
    // for our flat-shaded cuboids).
    mat.map = makeStoneTexture();
    mat.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vStoneWorld;')
            .replace('#include <project_vertex>', '#include <project_vertex>\nvStoneWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;');
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vStoneWorld;')
            .replace('#include <map_fragment>', `
    {
        vec3 tw = abs(normalize(cross(dFdx(vStoneWorld), dFdy(vStoneWorld))));
        tw /= (tw.x + tw.y + tw.z);
        vec4 stone = texture2D(map, vStoneWorld.zy / 4.0) * tw.x
                   + texture2D(map, vStoneWorld.xz / 4.0) * tw.y
                   + texture2D(map, vStoneWorld.xy / 4.0) * tw.z;
        diffuseColor *= stone;
    }`);
    };
    coveredStationShellMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 1.0,
        metalness: 0.0,
        flatShading: true,
        vertexColors: true,
        side: THREE.DoubleSide,
        map: mat.map,
    });
    patchSweptStoneMaterial(coveredStationShellMaterial);
    coveredStationPlatformMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.9,
        metalness: 0,
        flatShading: true,
        vertexColors: true,
        side: THREE.DoubleSide,
    });
    wallMesh = new THREE.InstancedMesh(geo, mat, WALL_MAX_INSTANCES);
    wallMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    wallMesh.count = 0;
    wallMesh.frustumCulled = false;                      // instances span a wide window
    wallMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(WALL_MAX_INSTANCES * 3), 3);
    wallsGroup = new THREE.Group();
    wallsGroup.name = 'PhotorealTrenchWalls';
    markInspectionLayer(wallsGroup, {
        id: 'photoreal-civil-works',
        label: 'Photoreal corridor civil works',
        category: 'Civil works',
        source: 'world/photoreal.js · authored cuts, walls, tunnels, and viaduct dressing',
        order: 166,
    });
    // Hidden until the world is revealed: the walls are built (and re-built) on
    // coarse tiles first, so showing them before reveal is exactly the phantom
    // tunnel the loading overlay is meant to hide.
    wallsGroup.visible = tilesRevealed;
    wallsGroup.add(wallMesh);
    // Unlit warm strips along tunnel ceilings — read as continuous lighting
    // without real lights. Separate mesh: they must not receive shading. Thin
    // (0.12 m) so walk-collision ignores them as sub-step-height geometry.
    lightMesh = new THREE.InstancedMesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshBasicMaterial({ color: 0xffe9b8 }),
        LIGHT_MAX_INSTANCES,
    );
    lightMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    lightMesh.count = 0;
    lightMesh.frustumCulled = false;
    wallsGroup.add(lightMesh);
    scene.add(wallsGroup);
}

function disposeCoveredStationMeshes() {
    for (const mesh of [
        coveredStationShellMesh,
        coveredStationLightMesh,
        coveredStationPlatformMesh,
    ]) {
        if (!mesh) continue;
        if (wallsGroup) wallsGroup.remove(mesh);
        mesh.geometry.dispose();
    }
    coveredStationShellMesh = null;
    coveredStationLightMesh = null;
    coveredStationPlatformMesh = null;
    for (const mesh of coveredStationNameMeshes) {
        if (wallsGroup) wallsGroup.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.map?.dispose();
        mesh.material.dispose();
    }
    coveredStationNameMeshes = [];
}

function combineIndexedSweepData(sweeps, field) {
    const combined = { positions: [], colors: [], indices: [], wallColliders: [] };
    for (const sweep of sweeps) {
        for (const fieldName of Array.isArray(field) ? field : [field]) {
            const data = sweep?.[fieldName];
            if (!data?.positions?.length || !data?.indices?.length) continue;
            const vertexOffset = combined.positions.length / 3;
            combined.positions.push(...data.positions);
            if (data.colors?.length) combined.colors.push(...data.colors);
            combined.indices.push(...data.indices.map(index => index + vertexOffset));
        }
        if (field === 'shell') combined.wallColliders.push(...(sweep.wallColliders || []));
    }
    return combined;
}

function addCoveredStationSweeps(sweeps) {
    disposeCoveredStationMeshes();
    if (!wallsGroup || !coveredStationShellMaterial || sweeps.length === 0) return;
    const shell = combineIndexedSweepData(sweeps, 'shell');
    if (shell.positions.length > 0) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(shell.positions, 3));
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(shell.colors, 3));
        geometry.setIndex(shell.indices);
        geometry.computeVertexNormals();
        coveredStationShellMesh = new THREE.Mesh(geometry, coveredStationShellMaterial);
        coveredStationShellMesh.name = 'PhotorealCoveredStationShell';
        coveredStationShellMesh.userData.walkColliderBoxes = shell.wallColliders;
        coveredStationShellMesh.frustumCulled = false;
        coveredStationShellMesh.receiveShadow = true;
        wallsGroup.add(coveredStationShellMesh);
    }
    const light = combineIndexedSweepData(sweeps, 'light');
    if (light.positions.length > 0 && lightMesh?.material) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(light.positions, 3));
        geometry.setIndex(light.indices);
        coveredStationLightMesh = new THREE.Mesh(geometry, lightMesh.material);
        coveredStationLightMesh.name = 'PhotorealCoveredStationLights';
        coveredStationLightMesh.frustumCulled = false;
        wallsGroup.add(coveredStationLightMesh);
    }
    const platform = combineIndexedSweepData(sweeps, ['platform', 'identity']);
    if (platform.positions.length > 0 && coveredStationPlatformMaterial) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(platform.positions, 3));
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(platform.colors, 3));
        geometry.setIndex(platform.indices);
        geometry.computeVertexNormals();
        coveredStationPlatformMesh = new THREE.Mesh(
            geometry,
            coveredStationPlatformMaterial,
        );
        coveredStationPlatformMesh.name = 'PhotorealCoveredStationPlatform';
        coveredStationPlatformMesh.userData.walkableSurface = true;
        coveredStationPlatformMesh.frustumCulled = false;
        coveredStationPlatformMesh.receiveShadow = true;
        wallsGroup.add(coveredStationPlatformMesh);
    }
    for (const sweep of sweeps) {
        const board = sweep?.nameBoard;
        if (!board?.positions?.length || !board?.indices?.length) continue;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(board.positions, 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(board.uvs, 2));
        geometry.setIndex(board.indices);
        const material = new THREE.MeshBasicMaterial({
            map: makeCoveredStationNameTexture(board.label),
            side: THREE.DoubleSide,
            toneMapped: false,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = 'PhotorealCoveredStationNameBoard';
        mesh.frustumCulled = false;
        wallsGroup.add(mesh);
        coveredStationNameMeshes.push(mesh);
    }
}

// Terrain top (world Y) at (x,z) from the ORIGINAL streamed mesh (the raycast
// ignores the shader clip, which is exactly right here: we sample the ground
// the wall retains, just outside the corridor). Null when nothing is streamed.
function terrainTopAt(x, z) {
    _wallRayO.set(x, 4000, z);
    _raycaster.set(_wallRayO, _rayDir);
    _raycaster.far = 8000;
    const hits = _raycaster.intersectObject(tiles.group, true);
    if (hits.length === 0) return null;
    const y = hits[0].point.y;
    return Math.abs(y) > 5000 ? null : y;
}

// DGU is a bare-earth DTM while Google's reality mesh is a surface model. The
// authored profile plus its DGU offset therefore gives a strong ground prior at
// every chainage without constraining the track itself. Convert that prior into
// the exact scene frame so it can distinguish terrain from roofs and foliage.
function expectedDguGroundYAt(x, z, trackY, trackId = null) {
    if (!photoTrackFrame || typeof photoGroundOffsetAt !== 'function') return null;
    try {
        const trackGeo = photoTrackFrame.fromScene(x, trackY, z);
        const rawGroundOffsetM = photoGroundOffsetAt(trackGeo.lat, trackGeo.lon, trackId);
        if (rawGroundOffsetM === null
            || rawGroundOffsetM === undefined
            || rawGroundOffsetM === '') return null;
        const groundOffsetM = Number(rawGroundOffsetM);
        if (!Number.isFinite(groundOffsetM)) return null;
        return photoTrackFrame.toScene(
            trackGeo.lon,
            trackGeo.lat,
            trackGeo.relativeHeightM - groundOffsetM,
        ).y;
    } catch (_error) {
        return null;
    }
}

function terrainPointAt(x, z, expectedGroundY, ux, uz, px, pz) {
    const primary = terrainTopAt(x, z);
    if (!Number.isFinite(expectedGroundY)) {
        return { surfaceY: primary, groundY: primary };
    }
    if (Number.isFinite(primary)
        && Math.abs(primary - expectedGroundY) <= GROUND_DGU_FAST_PATH_M) {
        return { surfaceY: primary, groundY: primary };
    }
    // Pay for the neighbourhood rays only on a suspicious DSM hit. A low
    // quantile normally finds pavement around a tree/small building; the DGU
    // prior handles a roof broad enough to cover the complete probe cross.
    const d = GROUND_NEIGHBOUR_PROBE_M;
    const groundY = selectPhotoBareEarthHeight([
        primary,
        terrainTopAt(x + ux * d, z + uz * d),
        terrainTopAt(x - ux * d, z - uz * d),
        terrainTopAt(x + px * d, z + pz * d),
        terrainTopAt(x - px * d, z - pz * d),
    ], { expectedGroundY });
    return { surfaceY: primary, groundY };
}

function terrainBareEarthAt(x, z, expectedGroundY, ux, uz, px, pz) {
    return terrainPointAt(x, z, expectedGroundY, ux, uz, px, pz).groundY;
}

// Station/access geometry is built outside this layer but must meet the same
// local Google ground as the civil works. Null means the relevant tile has not
// streamed yet; callers keep their DGU fallback and retry after reveal/movement.
export function samplePhotorealBareEarthAt(x, z, {
    expectedGroundY = null,
    alongX = 1,
    alongZ = 0,
    acrossX = 0,
    acrossZ = 1,
} = {}) {
    if (!(active && grounded && tiles?.group)) return null;
    const expected = expectedGroundY === null || expectedGroundY === undefined
        ? null
        : Number(expectedGroundY);
    return terrainBareEarthAt(
        Number(x),
        Number(z),
        expected,
        Number(alongX),
        Number(alongZ),
        Number(acrossX),
        Number(acrossZ),
    );
}

const _wm = new THREE.Matrix4();
const _wx = new THREE.Vector3();
const _wy = new THREE.Vector3(0, 1, 0);
const _wz = new THREE.Vector3();

// Rebuild walls + floor + viaduct for the window around the cab. The centreline
// is walked in ~WALL_SPAN_M chunks; each chunk samples the retained ground just
// outside the corridor on both sides and takes the max of its own and its
// neighbours' readings — a height dip between samples must never leave a short
// wall for the cut face to peek over. Where ground rises above the track the
// chunk gets a wall (up to retained ground + parapet) and a ballast floor slab,
// since the shader clip removed the original terrain there. Float chunks
// (ground below track) instead get a viaduct deck under the trackbed, carried
// to the real terrain by concrete piers on a stable arc-length grid.
function buildTrenchWalls(cx, cz, { dress = wallsEnabled } = {}) {
    if (dress) ensureWallMesh();
    const withinWallWindow = (x, z) => Math.abs(x - cx) <= WALL_WINDOW_HALF_M
        && Math.abs(z - cz) <= WALL_WINDOW_HALF_M;
    const withinCivilWindow = (x, z) => Math.abs(x - cx) <= CIVIL_WINDOW_HALF_M
        && Math.abs(z - cz) <= CIVIL_WINDOW_HALF_M;

    // 1) collect in-window chunks along the centreline, sampling both sides and
    //    the centre (float detection / pier footing). `along` accumulates route
    //    arc length over ALL chunks — including out-of-window ones — so pier
    //    positions are a stable function of the route, not of the window.
    let chunks = [];
    let along = 0;
    for (let s = 0; s + 5 < corridorSegs.length; s += 6) {
        const segmentIndex = Math.floor(s / 6);
        const trackId = corridorTrackIds[segmentIndex] ?? null;
        const routeRunId = corridorRunIds[segmentIndex] ?? segmentIndex;
        const ax = corridorSegs[s], az = corridorSegs[s + 1];
        const dx = corridorSegs[s + 2] - ax, dz = corridorSegs[s + 3] - az;
        const ya = corridorSegs[s + 4], yb = corridorSegs[s + 5];
        const segLen = Math.hypot(dx, dz);
        if (segLen < 1e-3) continue;
        const ux = dx / segLen, uz = dz / segLen, px = -uz, pz = ux;
        // Carve-width plan per CHUNK: the ribbon tapers across this segment
        // between its two vertex widths, so each chunk takes the wider of its
        // own two ends — fill always covers the local clip.
        const halfA = corridorSegHalfEndsM[segmentIndex * 2]
            ?? corridorSegHalfM[segmentIndex] ?? CORRIDOR_HALF_WIDTH_M;
        const halfB = corridorSegHalfEndsM[segmentIndex * 2 + 1] ?? halfA;
        const nCh = Math.max(1, Math.round(segLen / WALL_SPAN_M));
        const spanLen = segLen / nCh;
        for (let c = 0; c < nCh; c++) {
            const t0 = c / nCh;
            const t1 = (c + 1) / nCh;
            const t = (t0 + t1) * 0.5;
            const plan = planForHalfWidth(Math.max(
                halfA + (halfB - halfA) * t0,
                halfA + (halfB - halfA) * t1,
            ));
            const sampleDist = plan.sourceSampleDistanceM;
            const mx = ax + dx * t, mz = az + dz * t;
            const pier = Math.floor((along + spanLen) / PIER_SPACING_M) > Math.floor(along / PIER_SPACING_M);
            const alongStartM = along;   // route arc at chunk start (light grid)
            along += spanLen;
            if (!withinCivilWindow(mx, mz)) continue;
            // Reuse the cached raycast heights for this chunk; only sample the
            // tile mesh on a miss (a new chunk entering the window, or one a
            // refined tile invalidated). This is what stops the rebuild hitching.
            const key = segmentIndex * 4096 + c;
            let h = wallHeightCache.get(key);
            if (!h) {
                const trackY = ya + (yb - ya) * t;
                const expectedGroundY = expectedDguGroundYAt(mx, mz, trackY, trackId);
                const left = terrainPointAt(
                        mx + px * sampleDist,
                        mz + pz * sampleDist,
                        expectedGroundY,
                        ux,
                        uz,
                        px,
                        pz,
                    );
                const right = terrainPointAt(
                        mx - px * sampleDist,
                        mz - pz * sampleDist,
                        expectedGroundY,
                        ux,
                        uz,
                        px,
                        pz,
                    );
                const center = terrainPointAt(mx, mz, expectedGroundY, ux, uz, px, pz);
                const x0 = ax + dx * t0, z0 = az + dz * t0;
                const x1 = ax + dx * t1, z1 = az + dz * t1;
                h = {
                    surfaceL0: terrainTopAt(x0 + px * sampleDist, z0 + pz * sampleDist),
                    surfaceL: left.surfaceY,
                    surfaceL1: terrainTopAt(x1 + px * sampleDist, z1 + pz * sampleDist),
                    surfaceR0: terrainTopAt(x0 - px * sampleDist, z0 - pz * sampleDist),
                    surfaceR: right.surfaceY,
                    surfaceR1: terrainTopAt(x1 - px * sampleDist, z1 - pz * sampleDist),
                    surfaceC: center.surfaceY,
                    groundL: left.groundY,
                    groundR: right.groundY,
                    groundC: center.groundY,
                    // DGU bare earth implied by the authored profile — feeds
                    // the design-depth (cut-and-cover) tunnel classification.
                    dguGroundY: expectedGroundY,
                    mx, mz,
                };
                wallHeightCache.set(key, h);
            }
            chunks.push({
                // ty: LOCAL track height (0 on flat sessions; the authored
                // grade on asl sessions). Every wall/floor/deck/pier/tunnel
                // height below is relative to it, never to the y=0 plane.
                routeRunId,
                segmentIndex,
                chunkIndex: c,
                x0: ax + dx * t0,
                z0: az + dz * t0,
                ty0: ya + (yb - ya) * t0,
                x1: ax + dx * t1,
                z1: az + dz * t1,
                ty1: ya + (yb - ya) * t1,
                mx, mz, ux, uz, px, pz, spanLen, pier, alongStartM, plan,
                ty: ya + (yb - ya) * t,
                trackId,
                seed: segmentIndex * 31 + c,
                surfaceL0: h.surfaceL0, surfaceL: h.surfaceL, surfaceL1: h.surfaceL1,
                surfaceR0: h.surfaceR0, surfaceR: h.surfaceR, surfaceR1: h.surfaceR1,
                surfaceC: h.surfaceC,
                groundL: h.groundL, groundR: h.groundR, groundC: h.groundC,
                dguGroundY: h.dguGroundY,
            });
        }
    }
    // 1b) structure classification. Feed Google's centre + flank samples into
    // the same run policy as the model world (viaduct ≥3.5 m fill for ≥30 m;
    // tunnel ≥15 m cover for ≥40 m, with short gaps bridged). The only photo-
    // specific addition is 3 m of tunnel hysteresis across tile refinement.
    const prevSpans = tunnelClassificationSpans;
    const inPrevSpan = (x, z) => {
        for (const span of prevSpans) {
            const dx = span.x1 - span.x0;
            const dz = span.z1 - span.z0;
            const lengthSq = dx * dx + dz * dz;
            if (lengthSq <= 1e-9) continue;
            const t = ((x - span.x0) * dx + (z - span.z0) * dz) / lengthSq;
            if (t < 0 || t > 1) continue;
            const qx = span.x0 + dx * t - x;
            const qz = span.z0 + dz * t - z;
            if (qx * qx + qz * qz <= CORRIDOR_HALF_SQ) return true;
        }
        return false;
    };
    const structures = classifyPhotoCivilWorks(chunks, {
        tunnelEnabled,
        wasTunnelAt: inPrevSpan,
        reconstruction: corridorIsReconstruction,
    });
    for (let index = 0; index < chunks.length; index++) {
        const structure = structures[index];
        const ch = chunks[index];
        // ONE design rule (2026-07-23): tunnel iff the tube fits fully
        // underground (design cover >= PHOTO_DESIGN_TUNNEL_MIN_COVER_M, the
        // rail-to-roof section + real cover). There is NO covered-cut middle
        // type: shallower designs are open cuts in every world, and Google
        // never overrides the design's classification — modes differ in
        // rendering, not in what gets built.
        let effective = structure;
        // Run-policy smoothing can overhang a viaduct span's ends onto ground
        // that is locally AT grade (the dip's edges). Those chunks got deck-
        // only dressing while the clip still carved their flanks — an open
        // slot with neither floor nor walls. A float chunk whose local ground
        // reaches near track
        // level is really an ABUTMENT: dress it as formation, so it gets the
        // full-width slab and the edge elements like any grade chunk.
        if (effective === 'viaduct'
            && Number.isFinite(ch.groundC)
            && ch.groundC > ch.ty - 1.5) {
            effective = 'formation';
        }
        // DESIGN truth beats Google's smeared photogrammetry: a span the
        // profile draws at grade is never a viaduct, however low the DSM
        // reads (Split's greenhouse fields sit metres under their true
        // ground). Deck+stray-pier runs along nominally at-grade track were
        // exactly this. Real viaducts are DRAWN above ground.
        if (effective === 'viaduct'
            && Number.isFinite(ch.dguGroundY)
            && Number.isFinite(ch.ty)
            && ch.ty - ch.dguGroundY < 1.75) {
            effective = 'formation';
        }
        ch.structure = effective;
        ch.genericStructure = effective;
        ch.tunnel = effective === 'tunnel';
        ch.viaduct = effective === 'viaduct';
    }
    lastCivilChunks = chunks;   // __photorealDebug.civil() audit snapshot
    const newlyResolvedStations = resolvePhotoStationStructures(chunks, photoStationEnvelopes);
    let stationStructureChanged = false;
    for (const [key, decision] of newlyResolvedStations) {
        const envelope = photoStationEnvelopes.find(item => item.key === key);
        if (photoStationStructureByKey.get(key) !== decision.structure) {
            photoStationStructureByKey.set(key, decision.structure);
            stationStructureChanged = true;
        }
        if (envelope && !!envelope.openCutFallback !== !!decision.openCutFallback) {
            stationStructureChanged = true;
        }
        if (envelope && envelope.stationForm !== decision.stationForm) {
            stationStructureChanged = true;
        }
    }
    if (stationStructureChanged) photoStationStructureRevision += 1;
    const activeStationDecisions = new Map();
    for (const envelope of photoStationEnvelopes) {
        const fresh = newlyResolvedStations.get(envelope.key);
        const structure = fresh?.structure || photoStationStructureByKey.get(envelope.key);
        if (!structure) continue;
        activeStationDecisions.set(envelope.key, {
            structure,
            groundY: fresh?.groundY ?? envelope.groundY,
            openCutFallback: fresh?.openCutFallback ?? !!envelope.openCutFallback,
            compactCovered: fresh?.compactCovered ?? !!envelope.compactCovered,
            stationForm: fresh?.stationForm ?? envelope.stationForm ?? null,
        });
    }
    chunks = applyPhotoStationCivilOwnership(
        chunks,
        photoStationEnvelopes,
        activeStationDecisions,
    );
    // The photo renderer used to put every pier on its fixed arc grid even
    // when that landed in an OSM road. Feed the same ordered nominal supports
    // through the shared model-world planner; shifted supports retain the
    // current chunk's deck orientation and resample their own Google footing.
    const nominalPillarChunks = chunks.filter(ch => ch.viaduct && ch.pier);
    if (photoPillarClearance && nominalPillarChunks.length) {
        const resolved = resolveIntelligentPillarSamples(
            nominalPillarChunks.map(ch => ({
                x: ch.mx,
                z: ch.mz,
                s: ch.alongStartM + ch.spanLen,
                ux: ch.ux,
                uz: ch.uz,
            })),
            photoPillarClearance,
            {
                nominalSpacingM: PIER_SPACING_M,
                maxSpanM: 95,
            },
        );
        for (const chunk of nominalPillarChunks) chunk.pier = false;
        for (const support of resolved) {
            const chunk = nominalPillarChunks[support.sourceIndex];
            if (!chunk) continue;
            chunk.pier = true;
            chunk.pillarX = support.x;
            chunk.pillarZ = support.z;
            chunk.pillarPlacement = support.placement;
        }
    }
    if (dress) {
        addCoveredStationSweeps(photoStationEnvelopes
            .map(envelope => envelope.coveredStationSweep)
            .filter(sweep => sweep?.rings?.some(ring => withinWallWindow(ring.x, ring.z))));
    }
    tunnelClassificationSpans = chunks
        .filter(chunk => chunk.genericStructure === 'tunnel')
        .map(chunk => ({
            routeRunId: chunk.routeRunId,
            x0: chunk.x0,
            z0: chunk.z0,
            x1: chunk.x1,
            z1: chunk.z1,
        }));
    const corridorOwnership = derivePhotoCorridorOwnership(chunks, {
        portalCollarDepthM: PORTAL_PLAN.collarInwardDepthM,
        portalCollarOutwardDepthM: PORTAL_PLAN.collarOutwardDepthM,
    });
    const tunnelCoreSlices = corridorOwnership.slices.filter(
        slice => slice.sourceMode === 'tunnel-core',
    );
    const tunnelCoreSlicesByChunk = new Map();
    const openTunnelSlicesByChunk = new Map();
    for (const slice of corridorOwnership.slices) {
        const target = slice.sourceMode === 'tunnel-core'
            ? tunnelCoreSlicesByChunk
            : openTunnelSlicesByChunk;
        const slices = target.get(slice.chunkIndex) || [];
        slices.push(slice);
        target.set(slice.chunkIndex, slices);
    }

    // Deep-cut flank bands collected while walls are placed (dress pass only:
    // they are meaningless without the wall body that buries their roof seam).
    const flankStrips = [];
    const addCutFlankStrip = (piece, side, wallTopY) => {
        const strip = resolvePhotoCutFlankBand({
            x0: piece.x0 - piece.ux * (WALL_OVERLAP_M * 0.5),
            z0: piece.z0 - piece.uz * (WALL_OVERLAP_M * 0.5),
            ty0: piece.ty0,
            x1: piece.x1 + piece.ux * (WALL_OVERLAP_M * 0.5),
            z1: piece.z1 + piece.uz * (WALL_OVERLAP_M * 0.5),
            ty1: piece.ty1,
            px: piece.px,
            pz: piece.pz,
            routeRunId: piece.routeRunId,
        }, {
            side,
            wallTopY,
            // Strictly inside the wall body: from its inner face out to one
            // texel past the red ribbon edge, so the filtered class boundary
            // wobbles within masonry, never in the open aperture.
            innerM: CUT_PLAN.wallInnerDistanceM,
            outerM: PORTAL_COLLAR_HALF_WIDTH_M,
            tunnelRoofOffsetM: TUNNEL_SOURCE_ROOF_OFFSET_M,
        });
        if (strip) flankStrips.push(strip);
    };

    // Source ownership is part of clipping, not of the optional masonry
    // dressing. Keep it current for ?nowalls and after a visual-wall failure so
    // tunnel hills never silently fall back to open canyons.
    const publishTunnelOwnership = () => {
        tunnelPortalCollars = corridorOwnership.portalCollars;
        tunnelPortalHoods = corridorOwnership.portalHoods;
        cutFlankStrips = flankStrips;
        tunnelSpans = tunnelCoreSlices.map((slice) => ({
            routeRunId: slice.routeRunId,
            x0: slice.x0,
            z0: slice.z0,
            x1: slice.x1,
            z1: slice.z1,
        }));
        const tunnelChanged = rebuildTunnelMask(
            tunnelCoreSlices,
            tunnelPortalCollars,
            tunnelPortalHoods,
            cutFlankStrips,
        );
        const stationChanged = rebuildStationMask();
        if ((tunnelChanged || stationChanged) && maskReady) {
            renderCorridorMask(maskCenterX, maskCenterZ);
        }
    };
    if (!dress) {
        publishTunnelOwnership();
        wallX = cx; wallZ = cz;
        wallAgeS = 0;
        wallsBuiltOnce = true;
        return;
    }

    // 2) place instances. Wall crowns use robust bare-earth samples from the
    // current and adjacent chunks. This rejects isolated Google roofs/trees and
    // makes neighbouring boxes share a stable civil envelope.
    let n = 0;
    let nl = 0;
    const scatter = new THREE.Color();
    const portalFacesInWindow = corridorOwnership.portalFaces.filter(
        face => withinWallWindow(face.x, face.z),
    );
    const regularInstanceLimit = Math.max(
        0,
        WALL_MAX_INSTANCES - Math.min(WALL_MAX_INSTANCES, portalFacesInWindow.length * 5),
    );
    const hasWallCapacity = (count = 1) => n + count <= WALL_MAX_INSTANCES;
    const hasRegularCapacity = (count = 1) => n + count <= regularInstanceLimit;

    const groundNeighbours = (index, field) => {
        const current = chunks[index];
        const values = [];
        for (let candidateIndex = index - 1; candidateIndex <= index + 1; candidateIndex++) {
            const candidate = chunks[candidateIndex];
            if (!candidate || candidate.routeRunId !== current.routeRunId) continue;
            if (candidateIndex < index && Math.hypot(
                candidate.x1 - current.x0,
                candidate.z1 - current.z0,
            ) > 1.5) continue;
            if (candidateIndex > index && Math.hypot(
                current.x1 - candidate.x0,
                current.z1 - candidate.z0,
            ) > 1.5) continue;
            values.push(candidate[field]);
        }
        return values;
    };
    const maxFiniteSurface = (...values) => {
        let best = null;
        for (const value of values) {
            const number = Number(value);
            if (!Number.isFinite(number)) continue;
            if (best === null || number > best) best = number;
        }
        return best;
    };
    for (let index = 0; index < chunks.length; index++) {
        const chunk = chunks[index];
        chunk.wallTopL = photoRetainingWallTop(groundNeighbours(index, 'groundL'), {
            trackY: chunk.ty,
            parapetM: WALL_TOP_EXTRA_M,
            maxHeightM: WALL_MAX_H_M,
        });
        chunk.wallTopR = photoRetainingWallTop(groundNeighbours(index, 'groundR'), {
            trackY: chunk.ty,
            parapetM: WALL_TOP_EXTRA_M,
            maxHeightM: WALL_MAX_H_M,
        });
        // DESIGN fallback: with no streamed Google samples on a side, every
        // dressing branch used to bail ("nothing to measure against") while
        // the clip still carved — an open void pit along unstreamed flanks.
        // The DGU bare earth is always known on planner routes; crown from it
        // until real samples arrive and recompute.
        if (Number.isFinite(chunk.dguGroundY)) {
            if (chunk.wallTopL === null) chunk.wallTopL = chunk.dguGroundY + WALL_TOP_EXTRA_M;
            if (chunk.wallTopR === null) chunk.wallTopR = chunk.dguGroundY + WALL_TOP_EXTRA_M;
        }
        // Tunnel approaches: the flank bands keep real crust above the tube
        // roof plane, so whatever the robust crown leaves exposed (canopy,
        // hummocks the lower median rejected) peeks over the wall as torn
        // slivers. Bury the local raw surface within a bounded allowance.
        // Ordinary cuts keep pure robust crowns — a roof beside the road
        // must not grow walls.
        if (chunk.structure === 'tunnel') {
            const cap = chunk.ty + WALL_MAX_H_M;
            const buriedL = buryDsmSurfaceCrown(
                chunk.wallTopL,
                maxFiniteSurface(chunk.surfaceL0, chunk.surfaceL, chunk.surfaceL1),
                {
                    hideM: TUNNEL_APPROACH_SURFACE_HIDE_M,
                    allowanceM: TUNNEL_APPROACH_SURFACE_ALLOWANCE_M,
                },
            );
            if (buriedL !== null) chunk.wallTopL = Math.min(buriedL, cap);
            const buriedR = buryDsmSurfaceCrown(
                chunk.wallTopR,
                maxFiniteSurface(chunk.surfaceR0, chunk.surfaceR, chunk.surfaceR1),
                {
                    hideM: TUNNEL_APPROACH_SURFACE_HIDE_M,
                    allowanceM: TUNNEL_APPROACH_SURFACE_ALLOWANCE_M,
                },
            );
            if (buriedR !== null) chunk.wallTopR = Math.min(buriedR, cap);
        } else {
            // Ordinary cut walls are 3 m THICK: terrain inside the wall's own
            // plan band survives the clip (the mask stops one containment
            // apron short of the outer face) and pokes through the box TOP
            // wherever the raw surface stands above the robust crown. Bury
            // the crown toward the raw surface within a modest allowance —
            // the DGU cap right below still bounds the result, so a roof or
            // coarse-LOD junk beside the cut cannot grow a tower.
            const rawL = maxFiniteSurface(chunk.surfaceL0, chunk.surfaceL, chunk.surfaceL1);
            const rawR = maxFiniteSurface(chunk.surfaceR0, chunk.surfaceR, chunk.surfaceR1);
            const cap = chunk.ty + WALL_MAX_H_M;
            const buriedL = buryDsmSurfaceCrown(chunk.wallTopL, rawL, { hideM: 0.3, allowanceM: 5 });
            if (buriedL !== null) chunk.wallTopL = Math.min(buriedL, cap);
            const buriedR = buryDsmSurfaceCrown(chunk.wallTopR, rawR, { hideM: 0.3, allowanceM: 5 });
            if (buriedR !== null) chunk.wallTopR = Math.min(buriedR, cap);
        }
        // DGU is the height truth wherever the planner supplied it: robust
        // estimates and burial both read Google samples, and on coarse LOD
        // those can sit tens of metres high — which grew skyscraper walls
        // along the trench. Real hillsides survive (dgu IS the hill).
        if (Number.isFinite(chunk.dguGroundY)) {
            const dguCap = chunk.dguGroundY + WALL_TOP_EXTRA_M + 3;
            if (chunk.wallTopL !== null) chunk.wallTopL = Math.min(chunk.wallTopL, dguCap);
            if (chunk.wallTopR !== null) chunk.wallTopR = Math.min(chunk.wallTopR, dguCap);
        }
    }

    // The short tunnel approaches are source-owned OPEN cuts. Each portal sits
    // at the first/last sampled section that actually qualified as tunnel,
    // instead of a fixed distance deeper into a steep hill. Google cover is
    // removed, the formation floor replaces it, and the robust local
    // bare-earth envelope places both retaining-wall crowns.
    const addOpenTunnelSlice = (slice, ch) => {
        if (!slice || !hasRegularCapacity()) return;
        const spanX = slice.ux * (slice.spanLen + WALL_OVERLAP_M);
        const spanZ = slice.uz * (slice.spanLen + WALL_OVERLAP_M);
        const wallTopL = ch.wallTopL;
        const wallTopR = ch.wallTopR;
        for (const [wallTop, side] of [[wallTopL, 1], [wallTopR, -1]]) {
            if (!hasRegularCapacity()
                || wallTop === null
                || wallTop <= slice.ty + WALL_MIN_CUT_M + WALL_TOP_EXTRA_M) continue;
            const acrossJit = ((ch.seed * 7 + (side > 0 ? 0 : 2)) % 5) * 0.015;
            const top = wallTop + (ch.seed % 3) * 0.01;
            const height = top - (slice.ty + WALL_BOTTOM_Y);
            const distance = (ch.plan || CUT_PLAN).wallCenterDistanceM + acrossJit;
            const edgeX = slice.mx + slice.px * side
                * ((ch.plan || CUT_PLAN).wallCenterDistanceM + WALL_THICK_M * 0.5);
            const edgeZ = slice.mz + slice.pz * side
                * ((ch.plan || CUT_PLAN).wallCenterDistanceM + WALL_THICK_M * 0.5);
            if (isInsideCorridor(edgeX, edgeZ, HAIRPIN_SKIP_SQ)) continue;
            _wx.set(spanX, 0, spanZ);
            _wz.set(slice.px * WALL_THICK_M, 0, slice.pz * WALL_THICK_M);
            _wm.makeBasis(_wx, _wy.clone().multiplyScalar(height), _wz);
            _wm.setPosition(
                slice.mx + slice.px * side * distance,
                slice.ty + WALL_BOTTOM_Y + height * 0.5,
                slice.mz + slice.pz * side * distance,
            );
            wallMesh.setMatrixAt(n, _wm);
            const shade = 0.8 + ((ch.seed + (side > 0 ? 1 : 0)) % 5) * 0.05;
            scatter.setRGB(0.48 * shade, 0.45 * shade, 0.40 * shade);
            wallMesh.setColorAt(n, scatter);
            n++;
            addCutFlankStrip(slice, side, wallTop);
        }
        if (!hasRegularCapacity()
            || (wallTopL === null && wallTopR === null && ch.groundC === null)) return;
        const topY = slice.ty + FLOOR_TOP_Y - (ch.seed % 3) * 0.012;
        const sliceSpanRiseM = slabSpanRiseM(ch.ty0, ch.ty1, ch.spanLen, slice.spanLen + WALL_OVERLAP_M);
        _wx.set(spanX, sliceSpanRiseM, spanZ);
        _wz.set(
            slice.px * (ch.plan || CUT_PLAN).floorHalfWidthM * 2, 0,
            slice.pz * (ch.plan || CUT_PLAN).floorHalfWidthM * 2,
        );
        _wm.makeBasis(_wx, _wy.clone().multiplyScalar(FLOOR_THICK_M), _wz);
        _wm.setPosition(slice.mx, topY - FLOOR_THICK_M * 0.5, slice.mz);
        wallMesh.setMatrixAt(n, _wm);
        const floorShade = 0.9 + (ch.seed % 4) * 0.05;
        scatter.setRGB(0.30 * floorShade, 0.285 * floorShade, 0.26 * floorShade);
        wallMesh.setColorAt(n, scatter);
        n++;
    };

    // Fixtures on the global route-arc grid (one every TUNNEL_LIGHT_SPACING_M
    // of arc length) — never per slice/chunk. Bends split the corridor into
    // many short chords, and "at least one per piece" fused the fixtures into
    // a continuous ribbon; the model world's rhythm pass solved it the same
    // way (one grid over the whole feature).
    const addTunnelLightsAlongArc = (arcStartM, spanLen, mx, mz, ux, uz, px, pz, midY, riseM) => {
        if (!(spanLen > 1e-6)) return;
        for (let g = Math.ceil(arcStartM / TUNNEL_LIGHT_SPACING_M) * TUNNEL_LIGHT_SPACING_M;
            g < arcStartM + spanLen && nl < LIGHT_MAX_INSTANCES;
            g += TUNNEL_LIGHT_SPACING_M) {
            const alongOffset = (g - arcStartM) - spanLen * 0.5;
            const gradeT = alongOffset / spanLen;
            _wx.set(ux * TUNNEL_LIGHT_BOX_LEN_M, 0, uz * TUNNEL_LIGHT_BOX_LEN_M);
            _wz.set(px * TUNNEL_LIGHT_BOX_WIDTH_M, 0, pz * TUNNEL_LIGHT_BOX_WIDTH_M);
            _wm.makeBasis(_wx, _wy.clone().multiplyScalar(TUNNEL_LIGHT_BOX_THICK_M), _wz);
            _wm.setPosition(mx + ux * alongOffset, midY + gradeT * riseM, mz + uz * alongOffset);
            lightMesh.setMatrixAt(nl, _wm);
            nl++;
        }
    };

    // Only the intact source-owned core gets a masonry tube. Drawing the tube
    // over the cut-and-cover mouths left a false roof exactly where model mode
    // has open sky and made it hard to distinguish our ceiling from mesh leaks.
    const addTunnelCoreSlice = (slice, ch) => {
        if (!slice || !hasRegularCapacity(4)) return;
        const spanX = slice.ux * (slice.spanLen + WALL_OVERLAP_M);
        const spanZ = slice.uz * (slice.spanLen + WALL_OVERLAP_M);
        // Ceiling/floor/light follow the grade; the vertical side walls stay
        // axis-aligned so they remain walk colliders.
        const sliceSpanRiseM = slabSpanRiseM(ch.ty0, ch.ty1, ch.spanLen, slice.spanLen + WALL_OVERLAP_M);
        const wallHeight = TUNNEL_WALL_TOP_Y - WALL_BOTTOM_Y;
        for (const side of [1, -1]) {
            _wx.set(spanX, 0, spanZ);
            _wz.set(slice.px * TUNNEL_WALL_THICK_M, 0, slice.pz * TUNNEL_WALL_THICK_M);
            _wm.makeBasis(_wx, _wy.clone().multiplyScalar(wallHeight), _wz);
            _wm.setPosition(
                slice.mx + slice.px * side * TUNNEL_WALL_DIST_M,
                slice.ty + WALL_BOTTOM_Y + wallHeight * 0.5,
                slice.mz + slice.pz * side * TUNNEL_WALL_DIST_M,
            );
            wallMesh.setMatrixAt(n, _wm);
            const shade = 0.62 + ((ch.seed + (side > 0 ? 1 : 0)) % 4) * 0.04;
            scatter.setRGB(0.50 * shade, 0.48 * shade, 0.44 * shade);
            wallMesh.setColorAt(n, scatter);
            n++;
        }
        const ceilingY = slice.ty + TUNNEL_WALL_TOP_Y
            + TUNNEL_CEIL_THICK_M * 0.5 - (ch.seed % 3) * 0.012;
        _wx.set(spanX, sliceSpanRiseM, spanZ);
        _wz.set(slice.px * TUNNEL_CEIL_WIDTH_M, 0, slice.pz * TUNNEL_CEIL_WIDTH_M);
        _wm.makeBasis(_wx, _wy.clone().multiplyScalar(TUNNEL_CEIL_THICK_M), _wz);
        _wm.setPosition(slice.mx, ceilingY, slice.mz);
        wallMesh.setMatrixAt(n, _wm);
        const ceilingShade = 0.55 + (ch.seed % 4) * 0.03;
        scatter.setRGB(0.50 * ceilingShade, 0.48 * ceilingShade, 0.45 * ceilingShade);
        wallMesh.setColorAt(n, scatter);
        n++;

        const floorY = slice.ty + FLOOR_TOP_Y - (ch.seed % 3) * 0.012;
        _wx.set(spanX, sliceSpanRiseM, spanZ);
        _wz.set(slice.px * TUNNEL_CEIL_WIDTH_M, 0, slice.pz * TUNNEL_CEIL_WIDTH_M);
        _wm.makeBasis(_wx, _wy.clone().multiplyScalar(FLOOR_THICK_M), _wz);
        _wm.setPosition(slice.mx, floorY - FLOOR_THICK_M * 0.5, slice.mz);
        wallMesh.setMatrixAt(n, _wm);
        const floorShade = 0.8 + (ch.seed % 4) * 0.04;
        scatter.setRGB(0.26 * floorShade, 0.25 * floorShade, 0.23 * floorShade);
        wallMesh.setColorAt(n, scatter);
        n++;

        const sliceArcStartM = (ch.alongStartM || 0)
            + Math.hypot(slice.x0 - ch.x0, slice.z0 - ch.z0);
        addTunnelLightsAlongArc(
            sliceArcStartM, slice.spanLen,
            slice.mx, slice.mz, slice.ux, slice.uz, slice.px, slice.pz,
            slice.ty + TUNNEL_WALL_TOP_Y - 0.2, sliceSpanRiseM,
        );
    };

    // Edge-element plan prepass: tops computed per chunk/side, then SMOOTHED
    // along the run (|Δ| ≤ 0.35 m between neighbours, forward+backward) —
    // adaptive per-chunk tops read as battlements otherwise. The dress loop
    // consumes ch.edgeTopL/R + ch.edgeBottomL/R; null means "no edge element
    // here" (real wall, viaduct, ramp, tunnel, or nothing streamed).
    for (const ch of chunks) {
        ch.edgeTopL = null;
        ch.edgeTopR = null;
        ch.edgeBottomL = null;
        ch.edgeBottomR = null;
        ch.edgeDistL = null;
        ch.edgeDistR = null;
        if (ch.viaduct || ch.tunnel) continue;
        const narrow = ch.plan === NARROW_PLAN;
        const upM = Number.isFinite(ch.dguGroundY) && Number.isFinite(ch.ty)
            ? ch.ty - ch.dguGroundY
            : null;
        if (narrow && upM !== null && upM > 0.3) continue;   // ramp/causeway
        for (const side of [1, -1]) {
            const raw = side > 0 ? ch.wallTopL : ch.wallTopR;
            const robust = raw !== null && raw !== undefined ? raw - WALL_TOP_EXTRA_M : null;
            let top = null;
            let bottom = ch.ty + WALL_BOTTOM_Y;
            let dist = null;
            if (narrow) {
                if (robust !== null && robust < ch.ty - 2) continue;
                // BANK rule: side ground ≥ 2 m above the slab this close to
                // the track means real rising ground ON the alignment edge.
                // The element moves INWARD to the slab edge and grows into a
                // proper retaining wall — its 3 m body then swallows the
                // shave ring's cut line, so no window is ever sliced into
                // the bank's shell (the source of the void pits at bends).
                const bank = robust !== null && robust >= ch.ty + 2;
                top = Math.min(
                    Math.max(
                        ch.ty + WALL_MIN_CUT_M + WALL_TOP_EXTRA_M * 0.15,
                        robust === null ? -Infinity : robust + 0.6,
                    ),
                    ch.ty + (bank ? 4.5 : 2.6),
                );
                dist = bank
                    ? (ch.plan || CUT_PLAN).floorHalfWidthM - 1.0
                    : edgeBeamDistForPlan(ch.plan || CUT_PLAN);
            } else {
                const flatEdge = raw === null || raw === undefined
                    || raw <= ch.ty + WALL_MIN_CUT_M + WALL_TOP_EXTRA_M;
                if (!flatEdge) continue;                     // real wall path
                if (robust === null) continue;
                top = Math.min(
                    Math.max(
                        ch.ty + WALL_MIN_CUT_M + WALL_TOP_EXTRA_M * 0.15,
                        robust + 0.6,
                    ),
                    ch.ty + WALL_MIN_CUT_M + WALL_TOP_EXTRA_M + 0.1,
                );
            }
            if (robust !== null) bottom = Math.min(bottom, robust - 1.2);
            if (side > 0) { ch.edgeTopL = top; ch.edgeBottomL = bottom; ch.edgeDistL = dist; }
            else { ch.edgeTopR = top; ch.edgeBottomR = bottom; ch.edgeDistR = dist; }
        }
    }
    for (const field of ['edgeTopL', 'edgeTopR']) {
        for (let i = 1; i < chunks.length; i++) {
            const prev = chunks[i - 1], cur = chunks[i];
            if (cur.routeRunId !== prev.routeRunId) continue;
            if (cur[field] === null || prev[field] === null) continue;
            if (cur[field] > prev[field] + 0.35) cur[field] = prev[field] + 0.35;
        }
        for (let i = chunks.length - 2; i >= 0; i--) {
            const next = chunks[i + 1], cur = chunks[i];
            if (cur.routeRunId !== next.routeRunId) continue;
            if (cur[field] === null || next[field] === null) continue;
            if (cur[field] > next[field] + 0.35) cur[field] = next[field] + 0.35;
        }
    }
    // Terminal ends of extended corridors seal with a headwall: without one,
    // an end-of-line tunnel/trench is an open window into unstreamed void.
    for (const terminal of photoTerminalEnds) {
        let best = null, bestD = Infinity;
        for (const candidate of chunks) {
            const d = Math.hypot(candidate.mx - terminal.x, candidate.mz - terminal.z);
            if (d < bestD) { bestD = d; best = candidate; }
        }
        if (best && bestD <= best.spanLen + 14) best.sealEnd = terminal;
    }
    for (let i = 0; i < chunks.length && n < regularInstanceLimit; i++) {
        const ch = chunks[i];
        if (!withinWallWindow(ch.mx, ch.mz)) continue;
        const spanX = ch.ux * (ch.spanLen + WALL_OVERLAP_M);
        const spanZ = ch.uz * (ch.spanLen + WALL_OVERLAP_M);
        // Vertical rise the ride/support slabs (ballast floor, viaduct deck) tilt
        // their along-track basis by, so a graded stretch is a smooth ramp rather
        // than a staircase of flat per-chunk terraces. Walls/piers stay flat.
        const chunkSpanRiseM = slabSpanRiseM(ch.ty0, ch.ty1, ch.spanLen, ch.spanLen + WALL_OVERLAP_M);
        // underground.js owns the complete rigid hall and tapered throats. No
        // generic tube, floor or retaining panel may run through that envelope.
        if (ch.structure === 'station-underground') continue;
        if (ch.structure === 'station-covered') continue;
        if (ch.tunnel) {
            for (const slice of tunnelCoreSlicesByChunk.get(i) || []) {
                addTunnelCoreSlice(slice, ch);
            }
            for (const slice of openTunnelSlicesByChunk.get(i) || []) {
                addOpenTunnelSlice(slice, ch);
            }
            continue; // ownership slices replace generic wall/deck handling
        }
        // A viaduct span owns a deck and piers, never retaining walls. Raw
        // photogrammetry above it may be a tree or bridge capture and is not a
        // reason to grow masonry upward from the rail formation.
        const wallTopL = ch.viaduct ? null : ch.wallTopL;
        const wallTopR = ch.viaduct ? null : ch.wallTopR;
        const narrowCarve = ch.plan === NARROW_PLAN;
        // Embankment ramp: the design runs ABOVE the bare earth but below the
        // viaduct threshold. Its slab matches the viaduct DECK width (a ramp
        // wider than the deck it feeds read as a trumpet), it gets a solid
        // core down to the ground instead of a floating curb, and no walls.
        const designUpM = Number.isFinite(ch.dguGroundY) && Number.isFinite(ch.ty)
            ? ch.ty - ch.dguGroundY
            : null;
        // There is no middle type between level ground and ramp: the
        // moment the design leaves the ground it IS a ramp — deck-width slab
        // on a solid embankment core. 0.3 m is the departure threshold (the
        // design profile is smooth, so this flips exactly once per ramp);
        // below it the formation hugs the terrain as level ground. Higher
        // thresholds left a wide slab hovering on air over the first half
        // metre of every climb.
        const fillRamp = !ch.viaduct
            && designUpM !== null
            && designUpM > 0.3;
        // A fill ramp is a deck-width slab on a solid embankment core (built
        // below) — it carries NO retaining walls. A WIDE ramp otherwise fell
        // through to the cut-wall path and built walls at ±wallCenterDistanceM
        // (~8 m) while the deck only reached ±DECK_WIDTH_M/2 (±4 m), leaving an
        // open gap each side (the "walls with no paving between them"). Narrow
        // ramps already skipped walls; this makes every ramp consistent.
        for (const [wallTopRaw, side] of (fillRamp ? [] : [[wallTopL, 1], [wallTopR, -1]])) {
            let wallTop = wallTopRaw;
            let wallDistM = (ch.plan || CUT_PLAN).wallCenterDistanceM;
            if (!hasRegularCapacity()) continue;
            let wallBottomY = ch.ty + WALL_BOTTOM_Y;
            // Edge elements come precomputed and SMOOTHED (prepass above):
            // continuous beams along narrow spans, lips through the wide
            // grade-crossing band, skirts down side-hill slopes. Real walls
            // (retained ground) fall through with their own crown.
            const edgeTop = side > 0 ? ch.edgeTopL : ch.edgeTopR;
            const edgeBottom = side > 0 ? ch.edgeBottomL : ch.edgeBottomR;
            const edgeDist = side > 0 ? ch.edgeDistL : ch.edgeDistR;
            if (narrowCarve && !ch.tunnel && !ch.viaduct && !fillRamp) {
                if (edgeTop === null) continue;
                wallTop = edgeTop;
                wallBottomY = edgeBottom;
                wallDistM = edgeDist ?? edgeBeamDistForPlan(ch.plan || CUT_PLAN);
            } else if (narrowCarve) {
                // Narrow viaduct/ramp/tunnel spans: no side dressing here.
                continue;
            } else {
                const flatEdge = wallTop === null
                    || wallTop <= ch.ty + WALL_MIN_CUT_M + WALL_TOP_EXTRA_M;
                if (flatEdge) {
                    if (edgeTop === null) continue;
                    wallTop = edgeTop;
                    wallBottomY = edgeBottom;
                }
            }
            // Neighbouring boxes overlap along-track; a few deterministic
            // centimetres of across/height offset keep their coplanar faces
            // from z-fighting where they interpenetrate.
            const acrossJit = ((ch.seed * 7 + (side > 0 ? 0 : 2)) % 5) * 0.015;
            const top = wallTop + (ch.seed % 3) * 0.01;
            const h = top - wallBottomY;
            const jitDist = wallDistM + acrossJit;
            const ex = ch.mx + ch.px * side * jitDist, ez = ch.mz + ch.pz * side * jitDist;
            // Hairpin guard: on the proposal's extremely sharp turns, this edge's
            // wall band can land inside the corridor of ANOTHER leg of the route —
            // a wall across the track. Skip those chunks (the bend interior stays
            // an open clearing instead).
            const outD = wallDistM + WALL_THICK_M * 0.5;
            if (isInsideForeignCorridor(
                ch.mx + ch.px * side * outD,
                ch.mz + ch.pz * side * outD,
                HAIRPIN_SKIP_SQ,
                ch.routeRunId,
                ch.segmentIndex,
            )) continue;
            // Basis: X along the track (length), Y up (height), Z across (thickness).
            // The across vector carries NO side sign — flipping it mirrored the box
            // (negative-determinant transform -> inside-out faces), which rendered
            // one wall as open ribs with the "finishing panel" culled away. The
            // cuboid is symmetric, so only the position offset needs the side.
            _wx.set(spanX, 0, spanZ);
            _wz.set(ch.px * WALL_THICK_M, 0, ch.pz * WALL_THICK_M);
            _wm.makeBasis(_wx, _wy.clone().multiplyScalar(h), _wz);
            _wm.setPosition(ex, wallBottomY + h * 0.5, ez);
            wallMesh.setMatrixAt(n, _wm);
            // Karst-rock grey-tan with a little deterministic scatter.
            const shade = 0.8 + ((ch.seed + (side > 0 ? 1 : 0)) % 5) * 0.05;
            scatter.setRGB(0.48 * shade, 0.45 * shade, 0.40 * shade);
            wallMesh.setColorAt(n, scatter);
            n++;
            addCutFlankStrip(ch, side, wallTop);
        }
        // Cut/grade chunks get a ballast floor slab (the clip removed the
        // original terrain there); float chunks get a viaduct deck carried to
        // the ground by piers. The tiny per-chunk height offset keeps
        // overlapping slabs (hairpins) from z-fighting on a shared plane.
        // Floors and decks are DESIGN geometry — they build even where no
        // Google tile has streamed (the clip is active there regardless, so
        // waiting left bare void bands along the route). Only Google-derived
        // dressing (walls above, piers below) waits for real samples.
        if (!hasRegularCapacity()) continue;
        const topY = ch.ty + FLOOR_TOP_Y - (ch.seed % 3) * 0.012;
        if (!ch.viaduct) {
            // Ramps carry a deck-width slab; cuts/at-grade span wall-to-wall.
            const floorWidthM = fillRamp
                ? DECK_WIDTH_M
                : (ch.plan || CUT_PLAN).floorHalfWidthM * 2;
            _wx.set(spanX, chunkSpanRiseM, spanZ);
            _wz.set(ch.px * floorWidthM, 0, ch.pz * floorWidthM);
            _wm.makeBasis(_wx, _wy.clone().multiplyScalar(FLOOR_THICK_M), _wz);
            _wm.setPosition(ch.mx, topY - FLOOR_THICK_M * 0.5, ch.mz);
            wallMesh.setMatrixAt(n, _wm);
            const fshade = 0.9 + (ch.seed % 4) * 0.05;
            scatter.setRGB(0.30 * fshade, 0.285 * fshade, 0.26 * fshade);
            wallMesh.setColorAt(n, scatter);
            n++;
            // Solid embankment core under a ramp slab: without it the slab
            // hovers with open air to the ground. A single earth-toned box
            // from just under the slab down into the terrain reads as the
            // embankment body ("the track always has its own firm geometry").
            const coreGroundY = Number.isFinite(ch.groundC)
                ? Math.min(ch.groundC, ch.dguGroundY ?? ch.groundC)
                : ch.dguGroundY;
            if (fillRamp && Number.isFinite(coreGroundY) && hasRegularCapacity()) {
                const coreTopY = topY - FLOOR_THICK_M;
                const coreBottomY = coreGroundY - 1.5;
                const coreH = coreTopY - coreBottomY;
                if (coreH > 0.3) {
                    const coreWidthM = DECK_WIDTH_M - 1.0;
                    _wx.set(spanX, chunkSpanRiseM, spanZ);
                    _wz.set(ch.px * coreWidthM, 0, ch.pz * coreWidthM);
                    _wm.makeBasis(_wx, _wy.clone().multiplyScalar(coreH), _wz);
                    _wm.setPosition(ch.mx, coreBottomY + coreH * 0.5, ch.mz);
                    wallMesh.setMatrixAt(n, _wm);
                    const eshade = 0.85 + (ch.seed % 5) * 0.05;
                    scatter.setRGB(0.26 * eshade, 0.23 * eshade, 0.20 * eshade);
                    wallMesh.setColorAt(n, scatter);
                    n++;
                }
            }
        } else {
            // Viaduct deck: a box-girder slab under the floating trackbed.
            const stationDeck = ch.structure === 'station-viaduct' && ch.stationOwner
                ? {
                    rightMin: ch.stationOwner.deckRightMinM,
                    rightMax: ch.stationOwner.deckRightMaxM,
                }
                : null;
            const deckWidth = stationDeck
                ? stationDeck.rightMax - stationDeck.rightMin
                : DECK_WIDTH_M;
            const deckCenterRight = stationDeck
                ? (stationDeck.rightMin + stationDeck.rightMax) * 0.5
                : 0;
            _wx.set(spanX, chunkSpanRiseM, spanZ);
            _wz.set(ch.px * deckWidth, 0, ch.pz * deckWidth);
            _wm.makeBasis(_wx, _wy.clone().multiplyScalar(DECK_THICK_M), _wz);
            _wm.setPosition(
                ch.mx + ch.px * deckCenterRight,
                topY - DECK_THICK_M * 0.5,
                ch.mz + ch.pz * deckCenterRight,
            );
            wallMesh.setMatrixAt(n, _wm);
            const dshade = 0.9 + (ch.seed % 4) * 0.04;
            scatter.setRGB(0.40 * dshade, 0.39 * dshade, 0.37 * dshade);
            wallMesh.setColorAt(n, scatter);
            n++;
            // Concrete pier down to the real terrain, on the arc-length grid.
            // Skipped where the deck is close to the ground (embankment feel)
            // and clamped so one bad ray can't grow a kilometre column.
            if (hasRegularCapacity()
                && ch.pier
                && ch.groundC !== null
                && ch.groundC < ch.ty + PIER_TOP_Y - PIER_MIN_CLEAR_M) {
                const pillarX = Number.isFinite(ch.pillarX) ? ch.pillarX : ch.mx;
                const pillarZ = Number.isFinite(ch.pillarZ) ? ch.pillarZ : ch.mz;
                const shifted = Math.hypot(pillarX - ch.mx, pillarZ - ch.mz) > 0.05;
                const shiftedGround = shifted
                    ? terrainPointAt(
                        pillarX,
                        pillarZ,
                        ch.dguGroundY,
                        ch.ux,
                        ch.uz,
                        ch.px,
                        ch.pz,
                    )
                    : null;
                const pillarGroundC = shiftedGround?.groundY ?? ch.groundC;
                const pillarSurfaceC = shiftedGround?.surfaceY ?? ch.surfaceC;
                // The foot must penetrate the surface the EYE sees, not only
                // the robust bare-earth estimate: on coarse tiles (or after an
                // LOD drop) the rendered mesh sits metres below the cached
                // robust ground, leaving the pier hanging in mid-air. Take the
                // LOWER of the two — robust still vetoes tree canopies (which
                // only ever raise the raw sample), extra depth is invisible.
                const visibleGroundY = Number.isFinite(pillarSurfaceC)
                    ? Math.min(pillarGroundC, pillarSurfaceC)
                    : pillarGroundC;
                const footY = Math.max(visibleGroundY - PIER_EMBED_M, ch.ty + PIER_TOP_Y - PIER_MAX_H_M);
                const ph = ch.ty + PIER_TOP_Y - footY;
                _wx.set(ch.ux * PIER_ALONG_M, 0, ch.uz * PIER_ALONG_M);
                _wz.set(ch.px * PIER_ACROSS_M, 0, ch.pz * PIER_ACROSS_M);
                _wm.makeBasis(_wx, _wy.clone().multiplyScalar(ph), _wz);
                _wm.setPosition(pillarX, footY + ph * 0.5, pillarZ);
                wallMesh.setMatrixAt(n, _wm);
                const pshade = 0.88 + (ch.seed % 5) * 0.04;
                scatter.setRGB(0.45 * pshade, 0.44 * pshade, 0.42 * pshade);
                wallMesh.setColorAt(n, scatter);
                n++;
            }
        }
        // Headwall across an extended terminal end: covered trenches seal to
        // the lid, tunnels to the tube roof, open cuts to the wall crowns.
        // Open-air ends (at-grade, viaduct) stay open — the track just ends.
        if (ch.sealEnd && hasRegularCapacity()) {
            const t = ch.sealEnd;
            let capTopRelM = null;
            if (ch.tunnel) {
                capTopRelM = TUNNEL_WALL_TOP_Y + TUNNEL_CEIL_THICK_M;
            } else {
                const crownY = Math.max(
                    wallTopL === null ? -Infinity : wallTopL,
                    wallTopR === null ? -Infinity : wallTopR,
                );
                if (crownY > ch.ty + 1.5) capTopRelM = crownY - ch.ty;
            }
            if (capTopRelM !== null) {
                const sealH = capTopRelM - WALL_BOTTOM_Y;
                const spanW = ((ch.plan || CUT_PLAN).wallCenterDistanceM
                    + WALL_THICK_M * 0.5) * 2;
                _wx.set(t.ux * 1.2, 0, t.uz * 1.2);
                _wz.set(-t.uz * spanW, 0, t.ux * spanW);
                _wm.makeBasis(_wx, _wy.clone().multiplyScalar(sealH), _wz);
                _wm.setPosition(
                    t.x - t.ux * 0.6,
                    ch.ty + WALL_BOTTOM_Y + sealH * 0.5,
                    t.z - t.uz * 0.6,
                );
                wallMesh.setMatrixAt(n, _wm);
                const sshade = 0.78 + (ch.seed % 4) * 0.05;
                scatter.setRGB(0.48 * sshade, 0.45 * sshade, 0.40 * sshade);
                wallMesh.setColorAt(n, scatter);
                n++;
            }
        }
    }

    // BEND WEDGES: the join disc clips a full circle at every route corner,
    // but floor slabs are per-segment rectangles — on a sharp turn the outer
    // wedge between consecutive rectangles lies inside the disc with nothing
    // covering it (an open pit at every kink; gentle curves hide it in the
    // slab overlap). Fill each sharp corner with a bisector-aligned slab.
    for (let i = 0; i + 1 < chunks.length && hasRegularCapacity(); i++) {
        const a = chunks[i], b = chunks[i + 1];
        if (a.routeRunId !== b.routeRunId) continue;
        if (Math.hypot(b.x0 - a.x1, b.z0 - a.z1) > 1.5) continue;
        if (a.viaduct || b.viaduct || a.tunnel || b.tunnel) continue;
        const dot = a.ux * b.ux + a.uz * b.uz;
        if (dot > 0.966) continue;                       // < ~15° turn: overlap covers it
        let bx = a.ux + b.ux, bz = a.uz + b.uz;
        const bl = Math.hypot(bx, bz);
        if (bl < 1e-3) continue;                         // hairpin reversal: skip
        bx /= bl; bz /= bl;
        const planA = a.plan || CUT_PLAN;
        const planB = b.plan || CUT_PLAN;
        const wedgeFloorHalfM = Math.max(planA.floorHalfWidthM, planB.floorHalfWidthM);
        const alongM = wedgeFloorHalfM * 1.25 + WALL_OVERLAP_M;
        const topY = a.ty1 + FLOOR_TOP_Y - 0.006;
        _wx.set(bx * alongM, 0, bz * alongM);
        _wz.set(-bz * wedgeFloorHalfM * 2, 0, bx * wedgeFloorHalfM * 2);
        _wm.makeBasis(_wx, _wy.clone().multiplyScalar(FLOOR_THICK_M), _wz);
        _wm.setPosition(a.x1, topY - FLOOR_THICK_M * 0.5, a.z1);
        wallMesh.setMatrixAt(n, _wm);
        const wshade = 0.9 + ((a.seed + b.seed) % 4) * 0.05;
        scatter.setRGB(0.30 * wshade, 0.285 * wshade, 0.26 * wshade);
        wallMesh.setColorAt(n, scatter);
        n++;
    }

    // Portal facades live at the exact open-mouth/core boundary. Their crown is
    // local authored civil geometry—never the raw hill height or the global
    // mask encoding range. The matching finite collar and hood remove Google
    // fragments below that crown while preserving the real hill above it.
    for (const face of portalFacesInWindow) {
        if (!hasWallCapacity(4)) break;
        const collarIndex = corridorOwnership.portalCollars.findIndex(collar => (
            collar.routeRunId === face.routeRunId
            && collar.side === face.side
            && Math.hypot(collar.faceX - face.x, collar.faceZ - face.z) <= 1e-4
        ));
        const hoodIndex = corridorOwnership.portalHoods.findIndex(hood => (
            hood.routeRunId === face.routeRunId
            && hood.side === face.side
            && Math.hypot(hood.faceX - face.x, hood.faceZ - face.z) <= 1e-4
        ));
        const rawCollar = collarIndex >= 0
            ? corridorOwnership.portalCollars[collarIndex]
            : null;
        const rawHood = hoodIndex >= 0 ? corridorOwnership.portalHoods[hoodIndex] : null;
        const portalFrame = photoPortalFacadeFrame(face, {
            depthM: PORTAL_DEPTH_M,
            outwardDepthM: PORTAL_OUTWARD_DEPTH_M,
        });
        if (!portalFrame || !rawCollar || !rawHood) continue;
        const portalChunk = chunks[face.chunkIndex];
        const portalGroundC = portalChunk?.groundC;
        const retainedTopY = [
            portalChunk?.wallTopL,
            portalChunk?.wallTopR,
            portalGroundC !== null
                && portalGroundC !== undefined
                && portalGroundC !== ''
                && Number.isFinite(Number(portalGroundC))
                ? Number(portalGroundC) + WALL_TOP_EXTRA_M
                : null,
        ].filter(value => value !== null && Number.isFinite(Number(value)))
            .reduce((highest, value) => Math.max(highest, Number(value)), -Infinity);
        // Raw DSM surface over the facade footprint: the collar keeps crust
        // above the crown (bore-style ownership), and anything it keeps above
        // the facade top re-appears as a torn tongue lying on the masonry,
        // cut off at the approach seam. Sample the actual surface across the
        // FULL facade footprint (jamb corners and the facade's own depth
        // included) and raise the facade to the CONSENSUS surface top: on a
        // real steep hillside many samples agree high, so the facade truly
        // reaches the crust it must bury, while an isolated roof/LOD spike
        // has no second witness and cannot mint a tower. Only the shared
        // rail-relative civil clamp bounds it.
        const collarSurfaceSamples = [];
        for (const alongM of [
            -portalFrame.outwardDepthM,
            -rawCollar.outwardDepthM,
            0,
            rawCollar.inwardDepthM,
            portalFrame.inwardDepthM,
        ]) {
            for (const acrossF of [-1, -0.66, -0.33, 0, 0.33, 0.66, 1]) {
                const acrossM = acrossF * PORTAL_OUTER_HALF_WIDTH_M;
                collarSurfaceSamples.push(terrainTopAt(
                    face.x + portalFrame.ux * alongM + portalFrame.px * acrossM,
                    face.z + portalFrame.uz * alongM + portalFrame.pz * acrossM,
                ));
            }
        }
        const buriedRetainedTopY = buryDsmSurfaceCrownFromSamples(
            retainedTopY > -Infinity ? retainedTopY : null,
            collarSurfaceSamples,
            {
                hideM: PORTAL_SURFACE_HIDE_M,
                trackY: face.trackY,
                maxHeightM: WALL_MAX_H_M,
            },
        );
        const portalEnvelope = resolvePhotoPortalCivilEnvelope(rawCollar, rawHood, {
            retainedTopY: buriedRetainedTopY,
            tunnelRoofOffsetM: TUNNEL_SOURCE_ROOF_OFFSET_M,
        });
        if (!portalEnvelope) continue;
        const portalHood = portalEnvelope.hood;
        corridorOwnership.portalHoods[hoodIndex] = portalHood;
        const portalTop = portalEnvelope.portalTopY;
        const portalCollar = portalEnvelope.collar;
        corridorOwnership.portalCollars[collarIndex] = portalCollar;

        _wx.set(
            portalHood.x1 - portalHood.x0,
            portalHood.roofY1 - portalHood.roofY0,
            portalHood.z1 - portalHood.z0,
        );
        _wz.set(
            portalHood.px * TUNNEL_CEIL_WIDTH_M,
            0,
            portalHood.pz * TUNNEL_CEIL_WIDTH_M,
        );
        _wm.makeBasis(
            _wx,
            _wy.clone().multiplyScalar(PORTAL_HOOD_ROOF_THICK_M),
            _wz,
        );
        _wm.setPosition(
            (portalHood.x0 + portalHood.x1) * 0.5,
            (portalHood.roofY0 + portalHood.roofY1) * 0.5
                - PORTAL_HOOD_ROOF_THICK_M * 0.5,
            (portalHood.z0 + portalHood.z1) * 0.5,
        );
        wallMesh.setMatrixAt(n, _wm);
        scatter.setRGB(0.34, 0.33, 0.31);
        wallMesh.setColorAt(n, scatter);
        n++;

        const portalOuter = PORTAL_OUTER_HALF_WIDTH_M;
        const jambWidth = portalOuter - TUNNEL_WALL_DIST_M;
        const jambCenter = (portalOuter + TUNNEL_WALL_DIST_M) * 0.5;
        const jambHeight = portalTop - (face.trackY + WALL_BOTTOM_Y);
        const portalCenterX = portalFrame.centerX;
        const portalCenterZ = portalFrame.centerZ;
        for (const side of [1, -1]) {
            _wx.set(
                portalFrame.ux * portalFrame.depthM,
                0,
                portalFrame.uz * portalFrame.depthM,
            );
            // Use the inward frame's perpendicular, not the forward-route
            // perpendicular. At an end portal the inward axis reverses; mixing
            // frames gives a negative determinant, and FrontSide culling then
            // removes the outward masonry face.
            _wz.set(portalFrame.px * jambWidth, 0, portalFrame.pz * jambWidth);
            _wm.makeBasis(_wx, _wy.clone().multiplyScalar(jambHeight), _wz);
            _wm.setPosition(
                portalCenterX + portalFrame.px * side * jambCenter,
                face.trackY + WALL_BOTTOM_Y + jambHeight * 0.5,
                portalCenterZ + portalFrame.pz * side * jambCenter,
            );
            wallMesh.setMatrixAt(n, _wm);
            scatter.setRGB(0.42, 0.40, 0.37);
            wallMesh.setColorAt(n, scatter);
            n++;
        }
        const lintelBottom = face.trackY + TUNNEL_WALL_TOP_Y - 0.2;
        const lintelHeight = Math.max(0.2, portalTop - lintelBottom);
        _wx.set(
            portalFrame.ux * portalFrame.depthM,
            0,
            portalFrame.uz * portalFrame.depthM,
        );
        _wz.set(
            portalFrame.px * (TUNNEL_WALL_DIST_M * 2 + 2),
            0,
            portalFrame.pz * (TUNNEL_WALL_DIST_M * 2 + 2),
        );
        _wm.makeBasis(_wx, _wy.clone().multiplyScalar(lintelHeight), _wz);
        _wm.setPosition(
            portalCenterX,
            lintelBottom + lintelHeight * 0.5,
            portalCenterZ,
        );
        wallMesh.setMatrixAt(n, _wm);
        scatter.setRGB(0.42, 0.40, 0.37);
        wallMesh.setColorAt(n, scatter);
        n++;

        // Portal cap massif: a solid cut-and-cover block filling the kept
        // band (tube roof .. facade crown) from the facade back over the whole
        // hood run. The collar/hood correctly KEEP source above the roof
        // plane, but near the face that band also contains formerly INTERIOR
        // photogrammetry — fused faces, tile skirts, slope remnants torn at
        // the removal boundaries — which the open mouth now exposes as
        // floating slivers behind the shallow (6.8 m) facade boxes. No
        // per-fragment mask rule can tell that junk from the legitimate hill
        // surface, so the box encloses the entire band, the way a real
        // cut-and-cover portal collar structure does. Real hill higher than
        // the crown still rises above and behind the block.
        if (hasWallCapacity()) {
            const capBottomY = face.trackY + TUNNEL_SOURCE_ROOF_OFFSET_M - 0.55;
            const capHeight = portalTop - capBottomY;
            const capInnerDepthM = Math.max(
                portalFrame.inwardDepthM,
                (Number(rawHood.startDepthM) || 0) + (Number(rawHood.inwardDepthM) || 0),
            );
            const capDepthM = capInnerDepthM + portalFrame.outwardDepthM;
            if (capHeight > 0.2 && capDepthM > 0.5) {
                _wx.set(
                    portalFrame.ux * capDepthM,
                    0,
                    portalFrame.uz * capDepthM,
                );
                _wz.set(
                    portalFrame.px * PORTAL_COLLAR_HALF_WIDTH_M * 2,
                    0,
                    portalFrame.pz * PORTAL_COLLAR_HALF_WIDTH_M * 2,
                );
                _wm.makeBasis(_wx, _wy.clone().multiplyScalar(capHeight), _wz);
                _wm.setPosition(
                    face.x + portalFrame.ux
                        * (capInnerDepthM - portalFrame.outwardDepthM) * 0.5,
                    capBottomY + capHeight * 0.5,
                    face.z + portalFrame.uz
                        * (capInnerDepthM - portalFrame.outwardDepthM) * 0.5,
                );
                wallMesh.setMatrixAt(n, _wm);
                scatter.setRGB(0.42, 0.40, 0.37);
                wallMesh.setColorAt(n, scatter);
                n++;
            }
        }
    }
    wallMesh.count = n;
    wallMesh.instanceMatrix.needsUpdate = true;
    if (wallMesh.instanceColor) wallMesh.instanceColor.needsUpdate = true;
    wallMesh.computeBoundingSphere();
    if (lightMesh) {
        lightMesh.count = nl;
        lightMesh.instanceMatrix.needsUpdate = true;
        lightMesh.computeBoundingSphere();
    }
    // Publish tunnel spans for the CPU tests (walk ghost-ground) and repaint
    // the mask's tunnel channel when spans exist now or existed before.
    publishTunnelOwnership();
    wallX = cx; wallZ = cz;
    wallAgeS = 0;
    wallsBuiltOnce = true;

    // Report newly-seen Google-ground samples from this window's chunks so the
    // planner can overlay the photo surface on the elevation strip. Convert the
    // ray hit through the exact tangent frame; adding the DGU datum directly to
    // scene Y would invent tens of metres of error on a long, curved-Earth route.
    if (onPhotoGroundSamples && aslDatumM != null) {
        const batch = [];
        for (const ch of chunks) {
            if (ch.groundC == null) continue;
            const key = `${Math.round(ch.mx)},${Math.round(ch.mz)}`;   // ~1 m grid
            if (photoGroundSeen.has(key)) continue;
            photoGroundSeen.add(key);
            if (photoTrackFrame) {
                const g = photoTrackFrame.fromScene(ch.mx, ch.groundC, ch.mz);
                batch.push({ lng: g.lon, lat: g.lat, aslM: g.heightM });
            } else {
                const g = localToGeo(ch.mx, ch.mz, anchorLatLon.lon, anchorLatLon.lat);
                batch.push({ lng: g.lon, lat: g.lat, aslM: ch.groundC + aslDatumM });
            }
        }
        if (batch.length) { try { onPhotoGroundSamples(batch); } catch (_e) { /* non-fatal */ } }
    }

    // The collider list is cached by scene signature, which does not notice
    // in-place instance-matrix changes — force it to rebuild from source.
    resetWalkColliders();
}

// ---------------------------------------------------------------------------
// In photoreal mode we want ONLY the track and the streamed world — none of the
// OSM-sim layers (cars, roads, curbs, lamps, lane markings, street names,
// ambient trains, platforms, sim water, buildings, decor…). Most sim layers add
// UNNAMED top-level groups, so rather than blocklist them we KEEP a whitelist:
// lights, and any top-level object that contains the photoreal tiles, our
// trench dressing, the track the cab rides, or the cab itself. Everything else
// is hidden. Decisions are cached per object (the scene grows as tiles/layers
// stream in) and only the hidden set is restored on exit.
// NAMING CONTRACT: 'Planner' keeps every planner-designed civil structure —
// viaduct decks/pillars/walkways, trench walls, tunnel tubes, ramp fill
// (planner-elevation.js) and underground station halls (underground.js) — in
// the photoreal world, where they are the infrastructure for off-grade spans
// the corridor cut skips. Any future Object3D named Planner* opts into
// photoreal visibility by that name alone. TramPlatforms is deliberately NOT
// kept: it would change existing consensus rides (follow-up decision).
// NOTE: 'Planner' (blanket) was removed — the flat-world CIVIL boxes
// (PlannerElevationStructures) are model-only by layer contract (cab.js
// worlds field). STATION structures are deliberately SHARED assets (all
// three station types come from the one model set), so their groups are
// kept by name here; TramPlatforms stays deliberately unkept.
let _hiddenForPhotoreal = [];
let _decidedForPhotoreal = new Set();
function topLevelKeep(obj) {
    if (obj.isLight) return true;
    let keep = false;
    obj.traverse((o) => { if (keepObjectNameInPhoto(o.name)) keep = true; });
    return keep;
}
function setAbstractWorldHidden(hidden) {
    if (hidden) {
        for (const child of scene.children) {
            if (_decidedForPhotoreal.has(child)) continue;
            _decidedForPhotoreal.add(child);
            if (!topLevelKeep(child)) _hiddenForPhotoreal.push(child);
        }
        for (const o of _hiddenForPhotoreal) o.visible = false;
    } else {
        for (const o of _hiddenForPhotoreal) o.visible = true;
        _hiddenForPhotoreal = [];
        _decidedForPhotoreal = new Set();
    }
}

export const photorealLayer = {
    beginSession({
        anchorLat,
        anchorLon,
        fetchController,
        otherTracks,
        customTrackCorridors,
        allStops,
        altitudeDatumM,
        photoTrackFrame: trackFrame,
        photoSeatOffsetY,
        photoGroundOffsetAt: groundOffsetAt,
        onPhotoGroundSamples: onGround,
    }) {
        if (!isPhotoWorld()) return;
        if (!Number.isFinite(anchorLat) || !Number.isFinite(anchorLon)) return;
        const token = ionToken();
        if (!token) {
            console.warn('[photoreal] no Cesium ion token — set window.__ION_TOKEN__ (or runtime config ionToken) to enable Google 3D Tiles');
            return;
        }

        const generation = ++sessionGeneration;
        active = true;
        photoUnavailable = false;
        grounded = false;
        tilesRevealed = false;
        profileRegistrationActive = false;
        photoTrackFrame = trackFrame || null;
        photoGroundOffsetAt = typeof groundOffsetAt === 'function' ? groundOffsetAt : null;
        maskReady = false;
        maskCenterX = 0; maskCenterZ = 0;
        wallX = 0; wallZ = 0;
        wallsBuiltOnce = false;
        wallAgeS = 0;
        wallRebuildRequested = false;
        wallHeightCache.clear();
        revealWaitS = 0; sinceTileLoadS = 1e9;
        photoLoadStartMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        photoResourceUrls = new Set();
        tunnelSpans = [];
        tunnelPortalCollars = [];
        tunnelPortalHoods = [];
        cutFlankStrips = [];
        tunnelClassificationSpans = [];
        photoStationEnvelopes = [];
        photoStationStructureByKey = new Map();
        photoStationStructureRevision = 0;
        photoPillarClearance = null;
        sourceSuspendedInTunnel = false;
        stationStops = allStops || [];
        gradeAccum = 0;
        tagAccum = 1e9;                               // tag immediately on the first frame
        lockSamples = []; lockWaitS = 0; lockRefX = null; lockRefZ = null;
        lockStations = null; lockStationCursor = 0;
        lockRefUx = 0; lockRefUz = -1;
        lockTrackY = 0; lockAuthoredGroundOffsetM = 0;
        const requestedSeatOffsetY = photoSeatOffsetY == null
            ? null
            : Number(photoSeatOffsetY);
        inheritedSeatOffsetY = Number.isFinite(requestedSeatOffsetY)
            ? requestedSeatOffsetY
            : null;
        corridorUniforms.uCorridorOn.value = 0;
        try {
            const p = new URLSearchParams(window.location.search || '');
            carveEnabled = !p.has('nocarve');
            wallsEnabled = !p.has('nowalls');
            tunnelEnabled = !p.has('notunnel');
            seamGlowEnabled = p.has('seams') || INITIAL_PAGE_PARAMS.has('seams');
            elevAbsolute = p.has('elev');
            const e = Number(p.get('elev'));
            trackElevationM = Number.isFinite(e) ? e : 0;
        } catch (_e) { carveEnabled = true; wallsEnabled = true; tunnelEnabled = true; trackElevationM = 0; elevAbsolute = false; }
        aslDatumM = Number.isFinite(altitudeDatumM) ? altitudeDatumM : null;
        onPhotoGroundSamples = typeof onGround === 'function' ? onGround : null;
        photoGroundSeen = new Set();
        // DGU/EVRF2000 and Google's WGS84/DSM height systems do not share a
        // reliable absolute datum. Keep the authored profile in its exact WGS84
        // tangent frame and solve only one vertical translation from the DGU
        // track-vs-ground relationship near the start. Google terrain may then
        // classify cuts, tunnels and viaducts, but can never bend the track.
        // Planner walk sessions also carry the surrounding OSM rail network in
        // otherTracks. Civil engineering belongs only to the authored route;
        // use its explicit corridor set when available and keep otherTracks as
        // the legacy fallback for callers that do not provide one.
        corridorTracks = Array.isArray(customTrackCorridors) && customTrackCorridors.length > 0
            ? customTrackCorridors
            : (otherTracks || []);
        anchorLatLon = { lat: anchorLat, lon: anchorLon };
        const tramTracksReady = (typeof window !== 'undefined'
            && window.tramSim
            && typeof window.tramSim.whenLightReady === 'function')
            ? window.tramSim.whenLightReady().catch(() => {})
            : Promise.resolve();
        Promise.all([ensureRoadIndex(), tramTracksReady]).then(() => {
            if (!active || generation !== sessionGeneration) return;
            const tramTracks = (typeof window !== 'undefined'
                && window.tramSim
                && typeof window.tramSim.getOsmTrackFeatures === 'function')
                ? window.tramSim.getOsmTrackFeatures() || []
                : [];
            photoPillarClearance = createPillarClearanceEvaluator(
                anchorLat,
                anchorLon,
                tramTracks,
            );
            wallRebuildRequested = true;
        });

        // Lazy-load the tiles library, then build the renderer. onFrame no-ops
        // until `tiles` exists, so the cab starts instantly regardless of the CDN.
        loadTilesLib().then(() => {
            if (!active || generation !== sessionGeneration) return;
            tiles = new TilesRenderer();
            tiles.addEventListener('tile-download-start', notePhotorealResource);
            tiles.addEventListener('load-tileset', notePhotorealResource);
            tiles.registerPlugin(new CesiumIonAuthPlugin({
                apiToken: token,
                assetId: GOOGLE_PHOTOREALISTIC_ION_ASSET,
            }));
            // Anchor the ECEF tileset at the same WGS84 tangent origin used by
            // photoTrackFrame, so rails, cab, masks and Google geometry share
            // one curved-Earth-aware coordinate frame.
            tiles.registerPlugin(new ReorientationPlugin({
                lat: anchorLat * DEG_TO_RAD,
                lon: anchorLon * DEG_TO_RAD,
                height: 0,
            }));
            const draco = new DRACOLoader().setDecoderPath(DRACO_DECODER);
            tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));
            tiles.registerPlugin(new TileCompressionPlugin());
            // (No fade plugin: it clones/manipulates tile materials, which would
            // fight the corridor shader patch — and LOD pops are acceptable here.)

            // Performance: the screen-space error target decides how aggressively
            // tiles refine to finer LODs. The old value of 24 let the renderer
            // declare itself SATISFIED over melted parents and outright missing
            // patches (rural VG never resolved; measured live: at 24 zero
            // requests in flight, dropping the target instantly fired hundreds,
            // all HTTP 200). 8 stays lighter than the library default (~6) but
            // actually converges — tunable with ?rwq=<n> (higher = blurrier).
            const qParam = Number(new URLSearchParams(window.location.search || '').get('rwq'));
            tilesErrorTarget = (Number.isFinite(qParam) && qParam > 0) ? qParam : 8;
            tiles.errorTarget = tilesErrorTarget;
            // Cap tile memory so a long ride does not balloon the cache — but
            // the cap must fit the error target: at quality 8 a ground-level
            // view wants ~600+ resident tiles, and the old 500 ceiling made the
            // cache the binding constraint the moment quality improved.
            if (tiles.lruCache) { tiles.lruCache.minSize = 600; tiles.lruCache.maxSize = 1200; }
            // Smoothness: parsing/uploading a finished tile happens on the main
            // thread, so a burst of them while moving stalls frames. Cap how many
            // finalize per tick — the world fills in a touch slower but the ride
            // stops hitching. (downloadQueue capped too, to throttle the burst.)
            if (tiles.parseQueue) tiles.parseQueue.maxJobs = 4;
            if (tiles.downloadQueue) tiles.downloadQueue.maxJobs = 12;

            // Build the immutable alignment even with ?nocarve: it also owns the
            // one DGU/Google registration tie. The flag only disables clipping
            // and civil-work dressing, not coordinate registration.
            const corridorReady = buildCorridorData();
            // The corridor clip: route ribbon + mask objects + material patching.
            if (carveEnabled) {
                if (corridorReady) {
                    ensureMaskObjects();
                    tiles.addEventListener('load-model', onTileModelLoad);
                } else {
                    console.warn('[photoreal] no at-grade track geometry — corridor cut skipped');
                    carveEnabled = false;
                }
            }

            tiles.setCamera(camera);
            tiles.setResolutionFromRenderer(camera, renderer);
            // A root group carries the ground-alignment offset independently of the
            // ReorientationPlugin's transform on tiles.group.
            root = new THREE.Group();
            root.name = 'PhotorealRoot';
            markInspectionLayer(root, {
                id: 'photoreal-container',
                label: 'Photoreal world renderer',
                category: 'Ground',
                source: 'world/photoreal.js · 3d-tiles-renderer session root',
                order: 1,
                containerOnly: true,
            });
            // The ReorientationPlugin's object frame is east=−X / north=+Z (its
            // default frame applies Rx(−π/2)·Rz(π) to the ENU basis), while the
            // sim's local frame is east=+X / north=−Z (core/math.js geoToLocal).
            // Those differ by exactly a 180° yaw — without this, the streamed
            // world is spun half a turn around the anchor: driving sim-west shows
            // the ground scrolling east and the mountains swap sides.
            root.rotation.y = Math.PI;
            markInspectionLayer(tiles.group, {
                id: 'photoreal-source',
                label: 'Google photoreal source mesh',
                category: 'Ground',
                source: 'world/photoreal.js · streamed Google Photorealistic 3D Tiles',
                order: 5,
            });
            root.add(tiles.group);
            // &seams debug: a huge glowing plane far UNDER the world. Any
            // seam/hole in the mesh — however small — reveals it as a bright
            // pink patch (from walking height a hole reads as a glowing
            // column); uninterrupted mesh occludes it completely. Attached to
            // the scene (not root) so the tiles' registration shift cannot
            // move it above coastal terrain.
            if (seamGlowEnabled) {
                seamGlowMesh = new THREE.Mesh(
                    new THREE.PlaneGeometry(16000, 16000),
                    new THREE.MeshBasicMaterial({
                        color: 0xff2fd6,
                        side: THREE.DoubleSide,
                        toneMapped: false,
                    }),
                );
                seamGlowMesh.name = 'PhotorealRootSeamGlow';   // 'PhotorealRoot' token keeps it visible in photo
                markInspectionLayer(seamGlowMesh, {
                    id: 'debug-guides',
                    label: 'Scene guides',
                    category: 'Diagnostics',
                    source: 'world/photoreal.js · seam/hole glow probe',
                    order: 9500,
                });
                seamGlowMesh.rotation.x = -Math.PI / 2;
                seamGlowMesh.position.y = -120;
                seamGlowMesh.frustumCulled = false;
                scene.add(seamGlowMesh);
            }
            // Hidden until seated + cut + dressed: the first visible frame is the
            // final look instead of a canyon collapsing into place as LODs refine.
            tiles.group.visible = false;
            scene.add(root);
            console.log(`[photoreal] streaming Google 3D Tiles anchored at ${anchorLat.toFixed(5)},${anchorLon.toFixed(5)}`);
        }).catch((e) => {
            if (generation === sessionGeneration) {
                markPhotorealUnavailable('failed to load 3d-tiles-renderer', e);
            }
        });
    },

    onFrame(pose, local, dt) {
        if (!active || !tiles) return;
        // The intact Google surface above a tunnel is both invisible and very
        // expensive: advancing a cab under project 76 made the tile renderer
        // stream/draw roughly 950 calls and 660k triangles above the masonry
        // tube. Suspend that source while the viewer is physically below the
        // tunnel roof. Authored rails, tube, stations and vehicles are separate
        // scene groups and remain live; walking/flying over the same alignment
        // stays photoreal because its Y is above the roof.
        const insideTunnelCore = isInsideTunnelCore(local.x, local.z);
        const tunnelFloorY = insideTunnelCore
            ? corridorFloorYAt(local.x, local.z)
            : null;
        // In walk mode `local` is produced from lon/lat at absolute altitude
        // zero, so local.y is a datum conversion artefact (about -96 m here),
        // not the walker's height. Using it made every walker above a tunnel
        // look underground: Google vanished, its surface support disappeared,
        // and the walker fell onto the station/tunnel floor. The walk pose owns
        // scene Y directly; cab/photo-frame poses already own local.y.
        const observerY = pose?.status?.walkMode ? Number(pose.y) : Number(local.y);
        sourceSuspendedInTunnel = shouldSuspendPhotoSource({
            insideTunnelCore,
            tunnelFloorY,
            observerY,
            sourceRoofOffsetM: PHOTO_RUNNING_TUNNEL_SECTION.sourceRoofOffsetM,
        });
        if (tiles.group) {
            tiles.group.visible = tilesRevealed && !sourceSuspendedInTunnel;
        }
        if (!sourceSuspendedInTunnel) {
            tiles.setResolutionFromRenderer(camera, renderer);
            // Re-assert every frame: the Cesium ion auth plugin resolves its
            // endpoint asynchronously and stamps the Google-recommended
            // errorTarget (20) over whatever we configured at setup — measured
            // live as the silent source of the melted-world stall. A number
            // assignment per frame is free and always wins the race.
            tiles.errorTarget = tilesErrorTarget;
            camera.updateMatrixWorld();
            tiles.update();
        }
        if (seamGlowMesh) {
            seamGlowMesh.position.x = camera.position.x;
            seamGlowMesh.position.z = camera.position.z;
            const pulse = 0.8 + 0.2 * Math.sin(performance.now() * 0.004);
            seamGlowMesh.material.color.setRGB(1 * pulse, 0.18 * pulse, 0.84 * pulse);
        }
        // Keep the abstract world hidden (its layers stream in over time).
        setAbstractWorldHidden(true);
        const dtS = Math.max(0, dt || 0.016);
        // Tag the streamed tile meshes walkable so walk mode stands on the real
        // terrain (the sim's walk ground-raycast filters on userData.walkableSurface).
        // A full tree traverse is not cheap, so only a few times a second.
        tagAccum += dtS;
        if (tagAccum >= TAG_INTERVAL_S) {
            tagAccum = 0;
            tiles.group.traverse((o) => {
                if (o.isMesh && o.userData.walkableSurface !== true) {
                    o.userData.walkableSurface = true;
                }
                // Reconcile material identity as well as userData. Three.js
                // copies userData but not shader callbacks when a material is
                // cloned, so a post-load replacement must be repaired even if
                // it inherited the old diagnostic patch marker.
                patchTileDrawable(o);
            });
        }
        // Seat the world once its near ground has streamed AND settled (raycasts
        // the tile tree, so throttled). After it locks this is a cheap no-op.
        gradeAccum += dtS;
        sinceTileLoadS += dtS;               // reveal quiet-timer; reset on tile load
        if (gradeAccum >= GRADE_SAMPLE_INTERVAL_S) {
            if (!grounded) { try { lockTrackHeightOnce(); } catch (_e) { /* mesh not ready yet */ } }
            gradeAccum = 0;
        }
        if (!grounded) return;
        if (carveEnabled) {
            // Slide the clip-mask window with the cab. A slide is one small
            // texture render + two uniform updates — no geometry is touched.
            const movedM = (camera.position.x - maskCenterX) ** 2 + (camera.position.z - maskCenterZ) ** 2;
            if (!maskReady || movedM > MASK_MOVE_M * MASK_MOVE_M) {
                try { renderCorridorMask(camera.position.x, camera.position.z); }
                catch (e) {
                    console.warn('[photoreal] corridor mask failed', e);
                    carveEnabled = false;
                    corridorUniforms.uCorridorOn.value = 0;
                }
            }
            wallAgeS += dtS;
            const movedW = (camera.position.x - wallX) ** 2 + (camera.position.z - wallZ) ** 2;
            // A refined tile just arrived nearby → rebuild so a coarse-tile
            // classification collapses at once, not after WALL_REFRESH_S.
            const tileRefined = wallRebuildRequested && wallAgeS >= WALL_TILE_REFRESH_MIN_S;
            if (!wallsBuiltOnce || tileRefined || movedW > WALL_MOVE_M * WALL_MOVE_M || wallAgeS >= WALL_REFRESH_S) {
                wallRebuildRequested = false;
                // Tile refinement may change source ownership and civil-work
                // dimensions, never the immutable track geometry. Ownership is
                // rebuilt even when visual wall dressing is disabled.
                try {
                    buildTrenchWalls(camera.position.x, camera.position.z, { dress: wallsEnabled });
                } catch (e) {
                    console.warn('[photoreal] civil works failed', e);
                    if (wallsEnabled) {
                        wallsEnabled = false;
                        if (wallsGroup) wallsGroup.visible = false;
                        resetWalkColliders();
                        try {
                            buildTrenchWalls(camera.position.x, camera.position.z, { dress: false });
                        } catch (ownershipError) {
                            console.warn('[photoreal] source ownership failed', ownershipError);
                            wallsBuiltOnce = true; // reveal with the safe base/open mask
                        }
                    } else {
                        wallsBuiltOnce = true;
                    }
                }
            }
        }
        if (!tilesRevealed
            && (!carveEnabled || maskReady)
            && (!carveEnabled || wallsBuiltOnce)) {
            // Phantom-tunnel guard: wait for both clipping ownership and any
            // visual dressing to settle on refined source geometry.
            // Hold the reveal until the streamer goes quiet (no tile loaded for
            // REVEAL_QUIET_S and the queue nearly drained) so the geometry we show
            // is refined, not coarse. A hard cap reveals anyway.
            let settled = !carveEnabled;
            if (!settled) {
                revealWaitS += dtS;
                const prog = tiles.loadProgress;
                const drained = !Number.isFinite(prog) || prog >= 0.95;
                settled = (drained && sinceTileLoadS >= REVEAL_QUIET_S)
                    || revealWaitS >= REVEAL_MAX_WAIT_S;
                // Rebuild once on the now-settled mesh so the revealed walls match
                // it, not the coarse first build.
                if (settled) {
                    try {
                        buildTrenchWalls(camera.position.x, camera.position.z, { dress: wallsEnabled });
                    } catch (e) {
                        console.warn('[photoreal] settled civil works failed', e);
                        wallsEnabled = false;
                        if (wallsGroup) wallsGroup.visible = false;
                        resetWalkColliders();
                        try {
                            buildTrenchWalls(camera.position.x, camera.position.z, { dress: false });
                        } catch (ownershipError) {
                            console.warn('[photoreal] settled source ownership failed', ownershipError);
                            wallsBuiltOnce = true;
                        }
                    }
                }
            }
            if (settled) {
                tiles.group.visible = true;
                if (wallsGroup) wallsGroup.visible = wallsEnabled; // reveal walls WITH the terrain
                tilesRevealed = true;
                if (sourceSuspendedInTunnel) tiles.group.visible = false;
                console.log('[photoreal] world revealed (seated, corridor cut, walls dressed)');
            }
        }
    },

    endSession() {
        sessionGeneration += 1;
        active = false;
        photoUnavailable = false;
        wallHeightCache.clear();
        taperPlanCache.clear();
        setAbstractWorldHidden(false);
        if (wallsGroup) {
            disposeCoveredStationMeshes();
            scene.remove(wallsGroup);
            if (wallMesh) {
                wallMesh.geometry.dispose();
                if (wallMesh.material.map) wallMesh.material.map.dispose();
                wallMesh.material.dispose();
            }
            if (lightMesh) { lightMesh.geometry.dispose(); lightMesh.material.dispose(); }
            if (coveredStationShellMaterial) coveredStationShellMaterial.dispose();
            if (coveredStationPlatformMaterial) coveredStationPlatformMaterial.dispose();
            wallsGroup = null; wallMesh = null; lightMesh = null;
            if (seamGlowMesh) {
                scene.remove(seamGlowMesh);
                seamGlowMesh.geometry.dispose();
                seamGlowMesh.material.dispose();
                seamGlowMesh = null;
            }
            coveredStationShellMaterial = null;
            coveredStationPlatformMaterial = null;
            resetWalkColliders();                        // drop our boxes from the collider list
        }
        disposeMaskMesh(tunnelMaskMesh);
        disposeMaskMesh(tunnelPortalCollarMaskMesh);
        disposeMaskMesh(tunnelPortalHoodMaskMesh);
        disposeMaskMesh(cutFlankMaskMesh);
        tunnelMaskMesh = null;
        tunnelPortalCollarMaskMesh = null;
        tunnelPortalHoodMaskMesh = null;
        cutFlankMaskMesh = null;
        disposeMaskMesh(stationMaskMesh);
        disposeMaskMesh(stationOpeningMaskMesh);
        stationMaskMesh = null;
        stationOpeningMaskMesh = null;
        tunnelSpans = [];
        tunnelPortalCollars = [];
        tunnelPortalHoods = [];
        cutFlankStrips = [];
        tunnelClassificationSpans = [];
        photoStationEnvelopes = [];
        photoStationStructureByKey = new Map();
        photoStationStructureRevision = 0;
        photoPillarClearance = null;
        stationStops = [];
        if (ribbonMesh) { ribbonMesh.geometry.dispose(); ribbonMesh.material.dispose(); ribbonMesh = null; }
        if (maskRT) { maskRT.dispose(); maskRT = null; }
        maskScene = null; maskCamera = null;
        corridorUniforms.uCorridorMask.value = null;
        corridorUniforms.uCorridorOn.value = 0;
        if (tiles) {
            try { tiles.removeEventListener('load-model', onTileModelLoad); } catch (_e) { /* ignore */ }
            try { tiles.removeEventListener('tile-download-start', notePhotorealResource); } catch (_e) { /* ignore */ }
            try { tiles.removeEventListener('load-tileset', notePhotorealResource); } catch (_e) { /* ignore */ }
        }
        if (root) { scene.remove(root); root = null; }
        if (tiles) { try { tiles.dispose(); } catch (_e) { /* best effort */ } tiles = null; }
        grounded = false;
        tilesRevealed = false;
        maskReady = false;
        wallsBuiltOnce = false;
        corridorSegs = [];
        profileCorridorSegs = [];
        corridorTrackIds = [];
        corridorRunIds = [];
        profileCorridorTrackIds = [];
        profileRegistrationActive = false;
        photoTrackFrame = null;
        photoGroundOffsetAt = null;
        onPhotoGroundSamples = null;
        lockSamples = []; lockWaitS = 0; lockRefX = null; lockRefZ = null;
        lockStations = null; lockStationCursor = 0;
        lockRefUx = 0; lockRefUz = -1;
        lockTrackY = 0; lockAuthoredGroundOffsetM = 0;
        inheritedSeatOffsetY = null;
        photoResourceUrls = new Set();
    },
};

// Dev-only live-scene audit hook: interrogates the ACTUAL scene — what mesh a
// screen point hits, whether its material really carries the compiled corridor
// patch, and what the CPU ownership rules say at that exact spot — instead of
// reasoning blind about the mask spec. Read-only; safe to keep.
// Usage: aim the camera at the artifact, open the console, run
//   __photorealDebug.audit()
if (typeof window !== 'undefined') {
    const pickAt = (ndcX, ndcY) => {
        const ray = new THREE.Raycaster();
        ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
        return ray.intersectObject(scene, true)
            .filter(hit => hit.object?.visible !== false)
            .slice(0, 4);
    };
    const materialInfo = (object) => {
        const material = Array.isArray(object.material)
            ? object.material[0] : object.material;
        const compile = material?.onBeforeCompile;
        return {
            side: material?.side,
            patched: typeof compile === 'function'
                && compile.name === 'station3dRevisionedCompilePatch',
            compiledRev: compile?.__station3dCompilePatchVerifiedRevision ?? null,
        };
    };
    const isUnder = (object, ancestor) => {
        for (let p = object; p; p = p.parent) if (p === ancestor) return true;
        return false;
    };
    const round = (v, d = 2) => (Number.isFinite(v) ? +v.toFixed(d) : v);
    window.__photorealDebug = {
        THREE,
        scene: () => scene,
        camera: () => camera,
        tiles: () => tiles,
        collars: () => tunnelPortalCollars,
        hoods: () => tunnelPortalHoods,
        flanks: () => cutFlankStrips,
        ownershipAt: (x, z) => ({
            station: photoStationSourceOwnershipAt(photoStationEnvelopes, x, z),
            portal: tunnelPortalSourceOwnershipAt(x, z),
            flank: photoCutFlankOwnershipAt(cutFlankStrips, x, z, {
                tunnelRoofOffsetM: TUNNEL_SOURCE_ROOF_OFFSET_M,
            }),
            insideCore: isInsideTunnelCore(x, z),
            insideCorridor: isInsideCorridor(x, z),
            floorY: corridorFloorYAt(x, z),
        }),
        // Cut-and-cover audit: per-chunk authored design cover (DGU − track)
        // vs Google cover, and the structure each chunk received. If a deep
        // design still shows 'formation', the null field in its row names the
        // broken link (dgu missing → offset provider; groundC missing → tiles).
        civil() {
            const rows = (lastCivilChunks || []).map(ch => ({
                mx: round(ch.mx, 0),
                mz: round(ch.mz, 0),
                ty: round(ch.ty),
                groundC: round(ch.groundC),
                dgu: round(ch.dguGroundY),
                designCover: Number.isFinite(ch.dguGroundY) && Number.isFinite(ch.ty)
                    ? round(ch.dguGroundY - ch.ty) : null,
                googleCover: Number.isFinite(ch.groundC) && Number.isFinite(ch.ty)
                    ? round(ch.groundC - ch.ty) : null,
                structure: ch.structure,
                halfW: ch.plan ? +(ch.plan.sourceRemovalHalfWidthM).toFixed(1) : null,
                floorW: ch.plan ? +(ch.plan.floorHalfWidthM * 2).toFixed(1) : null,
            }));
            const counts = {};
            for (const row of rows) counts[row.structure] = (counts[row.structure] || 0) + 1;
            const deepest = rows.slice()
                .sort((a, b) => (b.designCover ?? -99) - (a.designCover ?? -99))
                .slice(0, 12);
            return { tunnelEnabled, counts, deepest, rows };
        },
        // Registration audit: how the applied Google shift compares with a
        // fresh consensus read NOW, plus track-vs-Google along the corridor —
        // the phantom-viaduct/trench diagnosis in one call.
        regAudit() {
            const out = {
                grounded,
                appliedShiftY: root ? +root.position.y.toFixed(2) : null,
                stations: [],
                trackVsGoogle: [],
            };
            for (const station of lockStations || []) {
                const ground = registrationGroundYAt(station.x, station.z, station.ux, station.uz);
                const shift = Number.isFinite(ground)
                    ? terrainSeatOffset({
                        trackY: station.y,
                        unshiftedGroundY: ground - (root ? root.position.y : 0),
                        authoredGroundOffsetM: station.authoredOffsetM,
                    })
                    : null;
                out.stations.push({
                    arcM: +station.arcM.toFixed(0),
                    trackY: +station.y.toFixed(2),
                    authoredOffsetM: +station.authoredOffsetM.toFixed(2),
                    lockGroundY: station.groundY === null ? null : +station.groundY.toFixed(2),
                    groundNowY: Number.isFinite(ground) ? +ground.toFixed(2) : null,
                    // The total shift a FRESH registration would choose from
                    // this station now; ≈ appliedShiftY everywhere means the
                    // applied registration is honest.
                    freshShiftM: shift === null ? null : +shift.toFixed(2),
                });
            }
            const count = 14;
            for (let index = 0; index < count; index++) {
                const s = Math.floor((corridorSegs.length / 6 - 1) * index / Math.max(1, count - 1)) * 6;
                if (s + 5 >= corridorSegs.length) break;
                const x = (corridorSegs[s] + corridorSegs[s + 2]) / 2;
                const z = (corridorSegs[s + 1] + corridorSegs[s + 3]) / 2;
                const ty = (corridorSegs[s + 4] + corridorSegs[s + 5]) / 2;
                const ground = terrainTopAt(x, z);
                out.trackVsGoogle.push({
                    at: [+x.toFixed(0), +z.toFixed(0)],
                    trackY: +ty.toFixed(1),
                    googleY: Number.isFinite(ground) ? +ground.toFixed(1) : null,
                    floatM: Number.isFinite(ground) ? +(ty - ground).toFixed(1) : null,
                });
            }
            console.log('PHOTOREAL REG AUDIT');
            console.log(JSON.stringify(out, null, 1));
            return 'reg audit done — copy the JSON above';
        },
        // Aim the camera at the artifact and call this: raycasts the exact
        // crosshair fragment and probes ITS coordinates in THIS session's
        // frame (absolute coords do not survive reloads — the world re-anchors).
        probeAim() {
            // Sweep a fan of rays over the central screen area (no exact
            // aiming needed). Carved crust still raycasts (ghost geometry),
            // so each ray walks its hit chain to the first surface that
            // actually RENDERS. Rays that pass through ghosts and land on a
            // far tile are through-window candidates - the sliver suspects.
            const walkRay = (nx, ny) => {
                const ray = new THREE.Raycaster();
                ray.setFromCamera(new THREE.Vector2(nx, ny), camera);
                ray.far = 1e6;
                const hits = ray.intersectObject(scene, true)
                    .filter(hit => hit.object?.visible !== false).slice(0, 12);
                const ghosts = [];
                for (const hit of hits) {
                    const isTile = isUnder(hit.object, tiles?.group);
                    if (!isTile) {
                        return { ndc: [nx, ny], outcome: 'authored', ghosts, hit };
                    }
                    const own = this.ownershipAt(hit.point.x, hit.point.z);
                    const y = hit.point.y;
                    let cpuDiscard;
                    if (own.station?.mode === 'station-core') cpuDiscard = y < own.station.roofY;
                    else if (own.station?.mode === 'open') cpuDiscard = y > own.station.floorY + CUT_FLOOR_Y;
                    else if (own.portal?.mode === 'tunnel-core') cpuDiscard = y < own.portal.roofY;
                    else if (own.portal?.mode === 'open') cpuDiscard = y > own.portal.floorY + CUT_FLOOR_Y;
                    else if (own.flank) cpuDiscard = y < own.flank.roofY;
                    else if (own.insideCore) cpuDiscard = own.floorY != null
                        && y < own.floorY + TUNNEL_SOURCE_ROOF_OFFSET_M;
                    else cpuDiscard = own.insideCorridor && own.floorY != null
                        && y > own.floorY + CUT_FLOOR_Y;
                    if (cpuDiscard) {
                        ghosts.push([round(hit.point.x, 1), round(hit.point.y, 1), round(hit.point.z, 1)]);
                        continue;
                    }
                    return {
                        ndc: [nx, ny],
                        outcome: hit.distance >= 150 ? 'visibleFar' : 'visibleNear',
                        ghosts, hit,
                    };
                }
                return { ndc: [nx, ny], outcome: 'nothing', ghosts, hit: null };
            };
            const results = [];
            for (let gx = -4; gx <= 4; gx++) {
                for (let gy = -4; gy <= 4; gy++) {
                    results.push(walkRay(gx * 0.09, gy * 0.09));
                }
            }
            const counts = {};
            for (const r of results) counts[r.outcome] = (counts[r.outcome] || 0) + 1;
            const windows = results
                .filter(r => r.outcome === 'visibleFar' && r.ghosts.length > 0)
                .sort((a, b) => (b.ghosts.length - a.ghosts.length)
                    || (b.hit.distance - a.hit.distance));
            const summary = {
                counts,
                throughWindows: windows.slice(0, 4).map(w => ({
                    ndc: w.ndc,
                    ghostsPierced: w.ghosts,
                    lands: {
                        dist: round(w.hit.distance, 1),
                        at: [round(w.hit.point.x, 1), round(w.hit.point.y, 1), round(w.hit.point.z, 1)],
                        obj: w.hit.object.name || w.hit.object.type,
                    },
                })),
            };
            console.log('AIM SWEEP', JSON.stringify(summary, null, 1));
            if (!windows.length) {
                const near = results.filter(r => r.outcome === 'visibleNear')
                    .sort((a, b) => (b.ghosts.length - a.ghosts.length)
                        || (a.hit.distance - b.hit.distance));
                if (near.length) {
                    console.log('No far through-windows; probing the strongest visible near tile.');
                    return this.probe(near[0].hit.point.x, near[0].hit.point.z, near[0].hit.point.y);
                }
                return 'no visible tile in the fan at all - only masonry; re-center and rerun';
            }
            const best = windows[0];
            return this.probe(best.hit.point.x, best.hit.point.z, best.hit.point.y);
        },

        // Read the ACTUAL mask pixel at a world position and decode it exactly
        // like the tile shader, self-calibrating the row orientation against a
        // known centerline texel. Names the class the GPU really sees.
        probe(x, z, y = null) {
            const decode = (px4) => {
                const r = px4[0] / 255, g = px4[1] / 255, b = px4[2] / 255;
                if (r <= 0.5) return { cls: 'NONE (r-gate fails: nothing discards here)', r: +r.toFixed(3), g: +g.toFixed(3) };
                const core = (g / Math.max(r, 1e-4)) >= 0.5;
                const floorY = floorEncodeMin + (b / Math.max(r, 1e-4)) * floorEncodeRange;
                return {
                    cls: core ? 'CORE (keep above roof)' : 'OPEN (remove above floor)',
                    r: +r.toFixed(3), g: +g.toFixed(3),
                    floorY: +floorY.toFixed(2),
                    roofY: +(floorY + TUNNEL_SOURCE_ROOF_OFFSET_M).toFixed(2),
                };
            };
            const texelOf = (wx, wz) => ({
                col: Math.min(MASK_RES - 1, Math.max(0, Math.round(
                    (wx - (maskCenterX - MASK_WINDOW_HALF_M)) / (2 * MASK_WINDOW_HALF_M) * MASK_RES))),
                row: Math.min(MASK_RES - 1, Math.max(0, Math.round(
                    (wz - (maskCenterZ - MASK_WINDOW_HALF_M)) / (2 * MASK_WINDOW_HALF_M) * MASK_RES))),
            });
            const readPx = (col, row) => {
                const buf = new Uint8Array(4);
                renderer.readRenderTargetPixels(maskRT, col, row, 1, 1, buf);
                return Array.from(buf);
            };
            // Calibrate: a point ON the centerline must decode as coverage with
            // floor ≈ its track Y in exactly one row orientation.
            const cal = nearestCorridorPointAt(x, z, Infinity);
            const calT = texelOf(cal.x, cal.z);
            const calA = decode(readPx(calT.col, calT.row));
            const calB = decode(readPx(calT.col, MASK_RES - 1 - calT.row));
            const scoreOf = (d) => (d.floorY == null ? Infinity : Math.abs(d.floorY - cal.y));
            const flipped = scoreOf(calB) < scoreOf(calA);
            const t = texelOf(x, z);
            const row = flipped ? MASK_RES - 1 - t.row : t.row;
            const patch = {};
            for (const [dx, name] of [[-2, 'W2'], [-1, 'W1'], [0, 'C'], [1, 'E1'], [2, 'E2']]) {
                patch[name] = decode(readPx(
                    Math.min(MASK_RES - 1, Math.max(0, t.col + dx)), row));
            }
            const frames = tunnelPortalCollars.map((c) => ({
                side: c.side,
                alongM: +((x - c.faceX) * c.ux + (z - c.faceZ) * c.uz).toFixed(2),
                acrossM: +((x - c.faceX) * c.px + (z - c.faceZ) * c.pz).toFixed(2),
                trackY: +c.faceTrackY.toFixed(2),
                portalTopY: +c.roofY0.toFixed(2),
            }));
            const stationInfo = photoStationEnvelopes.map((envelope) => ({
                key: envelope.key,
                structure: photoStationStructureByKey.get(envelope.key) ?? null,
                own: (() => {
                    const s = photoStationSourceOwnershipAt([envelope], x, z);
                    return s ? {
                        mode: s.mode,
                        roofY: s.roofY != null ? +s.roofY.toFixed(2) : null,
                        floorY: s.floorY != null ? +s.floorY.toFixed(2) : null,
                    } : null;
                })(),
            })).filter(s => s.own);
            const center = patch.C;
            let verdict = null;
            if (Number.isFinite(y)) {
                if (center.floorY == null) verdict = 'KEPT: no coverage - nothing discards this fragment';
                else if (center.cls.startsWith('OPEN')) verdict = y > center.floorY + CUT_FLOOR_Y
                    ? 'DISCARDED (open: above floor)' : 'KEPT (open: below floor)';
                else verdict = y < center.roofY
                    ? 'DISCARDED (core: below roof)' : 'KEPT (core: above roof)';
            }
            const result = {
                at: Number.isFinite(y) ? [x, y, z] : [x, z],
                verdict,
                nearestRoute: {
                    distM: +Math.sqrt(cal.distSq).toFixed(2),
                    trackY: +cal.y.toFixed(2),
                },
                orientation: flipped ? 'flipped' : 'as-is',
                calibration: { trackY: +cal.y.toFixed(2), decoded: flipped ? calB : calA },
                gpuMask: patch,
                cpu: this.ownershipAt(x, z),
                portalFrames: frames,
                stations: stationInfo,
                wallInstances: wallMesh ? { used: wallMesh.count, max: WALL_MAX_INSTANCES } : null,
                flankStrips: cutFlankStrips.map((s) => ({
                    alongM: +(((x - s.x0) * s.ux) + ((z - s.z0) * s.uz)).toFixed(1),
                    acrossM: +(((x - s.x0) * s.px) + ((z - s.z0) * s.pz)).toFixed(1),
                    spanLen: +s.spanLen.toFixed(1),
                    inner: s.innerM, outer: s.outerM,
                    ty: +((s.ty0 + s.ty1) * 0.5).toFixed(2),
                })).filter(s => s.alongM > -5 && s.alongM < s.spanLen + 5 && Math.abs(s.acrossM) < 25),
            };
            console.log('PHOTOREAL PROBE');
            console.log(JSON.stringify(result, null, 1));
            return 'probe done — copy the JSON above';
        },
        audit() {
            const out = { mask: null, collars: [], tiles: null, picks: [] };
            out.mask = {
                on: corridorUniforms.uCorridorOn.value,
                center: { x: round(maskCenterX, 1), z: round(maskCenterZ, 1), ready: maskReady },
                floorMin: round(floorEncodeMin), floorRange: round(floorEncodeRange),
            };
            for (const c of tunnelPortalCollars) {
                out.collars.push({
                    side: c.side,
                    face: [round(c.faceX, 1), round(c.faceZ, 1)],
                    trackY: round(c.faceTrackY),
                    portalTopY: round(c.roofY0),
                });
            }
            let meshes = 0, patched = 0, compiled = 0; const unpatched = [];
            if (tiles?.group) tiles.group.traverse((o) => {
                if (!o.isMesh) return;
                meshes++;
                const info = materialInfo(o);
                if (info.patched) { patched++; if (info.compiledRev) compiled++; }
                else unpatched.push(o.name || o.parent?.name || o.type);
            });
            out.tiles = { meshes, patched, compiled, unpatched: unpatched.slice(0, 6) };
            const grid = [[0, 0], [0.06, 0], [-0.06, 0], [0, 0.06], [0, -0.06],
                [0.12, -0.06], [-0.12, -0.06], [0, -0.15], [0.2, 0.1], [-0.2, 0.1]];
            for (const [nx, ny] of grid) {
                for (const hit of pickAt(nx, ny)) {
                    const o = hit.object;
                    const p = hit.point;
                    const own = this.ownershipAt(p.x, p.z);
                    const roofY = own.portal?.mode === 'tunnel-core' ? own.portal.roofY
                        : own.flank ? own.flank.roofY
                        : own.insideCore && own.floorY != null
                            ? own.floorY + TUNNEL_SOURCE_ROOF_OFFSET_M : null;
                    const floorY = own.portal?.mode === 'open' ? own.portal.floorY : own.floorY;
                    const shaderShouldDiscard = own.portal?.mode === 'tunnel-core' || own.flank || own.insideCore
                        ? (roofY != null && p.y < roofY)
                        : (own.insideCorridor && floorY != null && p.y > floorY + CUT_FLOOR_Y);
                    out.picks.push({
                        ndc: [nx, ny], dist: round(hit.distance, 1),
                        at: [round(p.x, 1), round(p.y, 1), round(p.z, 1)],
                        obj: o.name || o.parent?.name || o.type,
                        isTile: isUnder(o, tiles?.group),
                        isWalls: isUnder(o, wallsGroup),
                        mat: materialInfo(o),
                        own: {
                            portal: own.portal ? {
                                mode: own.portal.mode, src: own.portal.sourceMode,
                                roofY: round(own.portal.roofY), floorY: round(own.portal.floorY),
                            } : null,
                            flankRoofY: own.flank ? round(own.flank.roofY) : null,
                            core: own.insideCore, corridor: own.insideCorridor,
                            floorY: round(own.floorY),
                        },
                        shaderShouldDiscard,
                    });
                }
            }
            console.log('PHOTOREAL AUDIT');
            console.log(JSON.stringify(out, null, 1));
            return 'audit done — copy the JSON above';
        },
    };
}
