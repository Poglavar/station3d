// Production station adapter + opening topology + mesh capture + registry and
// Rapier boundary. Only the visual factory/GPU driver are controlled here.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { captureReceiverMeshReadSteps } from '../core/receiver-mesh-read.js';
import { EMPTY_RECEIVER_SUPPORT_READ } from '../core/receiver-support-read.js';
import { captureStationGroundOpeningsSteps } from '../core/station-ground-openings.js';
import { createSurfaceOpeningReadSteps } from '../core/surface-opening-read.js';
import { GROUND_GENERATION_LIMITS } from '../core/ground-generation-limits.js';
import { DEG_TO_RAD, EARTH_RADIUS_M, finiteOrNull } from '../core/math.js';
import { markSurfaceClaim } from '../core/surface-claim.js';
import { PLATFORM_SURFACE_PUBLICATION_KEY, platformOpeningClaimInput, platformSurfaceClaimInput } from '../core/platform-surface-publication.js';
import { SURFACE_CLASS, SURFACE_VERTICAL_RELATION, SURFACE_COVERAGE_STATE } from '../core/surface-hierarchy.js';
import { createSurfacePublicationRegistry } from '../core/surface-publication-registry.js';
import { prepareFixedSurfacePublicationSteps } from '../core/fixed-surface-publication.js';
import { freezeStaticTransforms } from '../core/static-transforms.js';
import { buildCurbSurfaceTrimeshData } from '../core/gta-curb-surface.js';
import { disposeGroup } from '../core/dispose.js';
import { clearPlannerEntranceCuts, setPlannerEntranceCuts, PLANNER_ENTRANCE_CUT_MAX } from '../world/planner-surface-cutout.js';

await RAPIER.init();
const source = readFileSync(new URL('../world/platforms.js', import.meta.url), 'utf8');
const between = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
const code = between('function* preparePlatformOpeningGroundSteps(', 'function publishPlatformGeneration(')
    + between('function distM(', 'export const platformsLayer');
const drain = steps => { for (;;) { const next = steps.next(); if (next.done) return next.value; } };
const terrainClaim = { surfaceClass: SURFACE_CLASS.TERRAIN, coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
    verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL };

function fixture() {
    const scene = new THREE.Scene(), registry = createSurfacePublicationRegistry();
    const world = new RAPIER.World({ x: 0, y: -9.8, z: 0 }), active = new Map(), metadata = new Map();
    let builds = 0, revision = 0, openings = null, colliders = 0;
    const runtime = vm.createContext({ THREE, scene, renderer: {}, camera: {}, performance,
        captureReceiverMeshReadSteps, EMPTY_RECEIVER_SUPPORT_READ, captureStationGroundOpeningsSteps,
        GROUND_GENERATION_LIMITS, DEG_TO_RAD, EARTH_RADIUS_M, finiteOrNull, markSurfaceClaim,
        PLATFORM_SURFACE_PUBLICATION_KEY, platformOpeningClaimInput, platformSurfaceClaimInput,
        freezeStaticTransforms, disposeGroup, clearPlannerEntranceCuts, setPlannerEntranceCuts, PLANNER_ENTRANCE_CUT_MAX,
        sessionContextReference: {}, activePlatformState: null, group: null, pendingBuildTask: null, photoTrackFrame: null,
        stops: [{}], anchorLat: 45.8, anchorLon: 16, STATION_REBUILD_M: 100,
        lastBuildLat: null, lastBuildLon: null, terrainRevisionDirty: false,
        photoGroundRevealRebuilt: false, photoStationStructureRevision: 0,
        isPhotorealRevealed: () => false, noteWorldQueueIdle() {},
        createPlatformGroup() { const root = new THREE.Group(); root.userData.entranceCuts = []; return root; },
        *build(root, lat, lon, rail, stationRevision, { terrain, prewarm }) {
            builds++;
            assert.equal(prewarm, false, 'support/capacity admission precedes GPU work');
            assert.equal(terrain.marker, 'captured terrain');
            yield { phase: 'controlled-station-factory' };
            if (!runtime.stops.length) return root;
            const geometry = new THREE.PlaneGeometry(2, 8); geometry.rotateX(-Math.PI / 2);
            geometry.translate(0, terrain.evidenceSceneYAtLocal(0, 0) - 3, 0);
            const floor = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
            floor.name = 'StationStairFloor'; floor.userData.walkableSurface = true;
            root.userData.level = -1; root.add(floor);
            root.userData.entranceCuts = [{ x1: 0, z1: -3, x2: 0, z2: 3, widthM: 2,
                maxY: terrain.evidenceSceneYAtLocal(0, 0) + 1 }];
            return root;
        },
        *prewarmDetachedObject() { yield { phase: 'controlled-upload', deferFrame: true }; },
    });
    vm.runInContext(code, runtime);
    const inputs = { session: 1, inputRevision: 1, stopsSignature: 'fixture', photoFrame: null };
    const prepare = height => {
        const generation = ++revision;
        const terrain = Object.freeze({ revision: height, marker: 'captured terrain', evidenceSceneYAtLocal: () => height });
        const candidate = drain(runtime.preparePlatformOpeningGroundSteps({ terrain, registry, generation,
            railFormation: Object.freeze({ revision: generation, constructionInputs: Object.freeze({ ...inputs }) }),
            centerX: 0, centerZ: 0, isCurrent: () => true }));
        return { candidate, generation };
    };
    const stage = height => {
        const { candidate, generation } = prepare(height);
        const nextOpenings = drain(createSurfaceOpeningReadSteps({ entrances: candidate.entrances,
            limits: GROUND_GENERATION_LIMITS.openings }));
        const priorOpenings = openings;
        const physics = drain(prepareFixedSurfacePublicationSteps({ RAPIER, world, active, metadata,
            replacements: [{ key: 'stations', spec: { id: 'stations' }, meshes: candidate.supportRead.surfaces.map(surface => ({
                ...buildCurbSurfaceTrimeshData({ surfaces: [surface], centerX: 0, centerZ: 0, radiusM: 1000, physicsOrigin: { x: 0, z: 0 } }), friction: .8, collisionGroups: 0xffffffff,
            })) }], activeColliderCount: colliders, maxColliders: 16, maxStagedColliders: 16 }));
        const entries = [...candidate.entries, { ticket: registry.begin({ key: 'fixture:openings', generation }),
            clear: true, commit() { openings = nextOpenings; return true; }, rollback() { openings = priorOpenings; }, discard() {} },
        { ticket: registry.begin({ key: 'fixture:physics', generation }), clear: true,
            commit: physics.promote, rollback: physics.rollback, discard: physics.dispose }];
        return { candidate, entries, physics, publish(fail = false) {
            const batch = registry.prepareBatch(entries, fail ? { commit() { throw new Error('later publication failed'); } } : {});
            const result = batch.publish();
            assert.equal(result.status, 'published');
            assert.equal(candidate.finalize(), true); physics.retire();
            colliders = physics.nextColliderCount;
        }, discard() { candidate.discard(); physics.dispose(); } };
    };
    return { runtime, prepare, stage, get builds() { return builds; }, get openings() { return openings; },
        floorY() {
            world.step();
            const hit = world.castRay(new RAPIER.Ray({ x: 0, y: 20, z: 0 }, { x: 0, y: -1, z: 0 }), 50, true);
            return hit ? 20 - hit.timeOfImpact : null;
        }, close() { registry.close(); world.free(); clearPlannerEntranceCuts(); } };
}

for (const outcome of ['publish', 'rollback', 'cancel']) test(`station floors, openings and physical support ${outcome} as one generation`, () => {
    const f = fixture();
    try {
        f.stage(4).publish();
        const previousRoot = f.runtime.group, previousOpenings = f.openings;
        assert.equal(f.floorY(), 1);
        const next = f.stage(7);
        assert.equal(f.runtime.group, previousRoot); assert.equal(f.openings, previousOpenings);
        assert.equal(f.floorY(), 1, 'private colliders stay disabled across physics frames');
        if (outcome === 'publish') next.publish();
        else if (outcome === 'rollback') assert.throws(() => next.publish(true), /later publication failed/);
        else next.discard();
        const floor = outcome === 'publish' ? 4 : 1;
        assert.equal(f.floorY(), floor);
        assert.equal(f.openings.contains(0, floor - .1, 0, terrainClaim), false);
        assert.equal(f.openings.contains(0, floor + .1, 0, terrainClaim), true);
        if (outcome !== 'publish') {
            assert.equal(f.runtime.group, previousRoot); assert.equal(f.openings, previousOpenings);
        }
        const builds = f.builds;
        const retained = f.prepare(outcome === 'publish' ? 7 : 4).candidate;
        assert.equal(retained.entries.length, 0); assert.equal(f.builds, builds, 'unchanged inputs retain station geometry');
        retained.discard();
        f.runtime.stops = []; f.stage(9).publish();
        assert.equal(f.runtime.group, null); assert.equal(f.floorY(), null); assert.equal(f.openings.empty, true);
    } finally { f.close(); }
});
