// The real civil compiler, alignment model, Three geometry and registry run
// here. Only GPU completion and the outer frame queue are controlled seams.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import * as alignmentApi from '../core/road-vertical-alignment.js';
import { roadStructureHalfWidths as alignmentHalfWidths, roadStructureSampleFrame } from '../core/road-structure-cross-section.js';
import * as spec from '../core/road-grade-separation-spec.js';
import * as pillars from '../core/intelligent-pillar-placement.js';
import * as hierarchy from '../core/surface-hierarchy.js';
import * as replacement from '../core/road-replacement-publication.js';
import { markSurfaceClaim } from '../core/surface-claim.js';
import { disposeGroup, registerShared, unregisterShared } from '../core/dispose.js';
import { ownReadSnapshot, retainReadSnapshot } from '../core/read-snapshot-lifetime.js';
import { createSurfacePublicationRegistry } from '../core/surface-publication-registry.js';
import { createGroundPublicationBoundary } from '../core/ground-publication-boundary.js';
import { DEG_TO_RAD, EARTH_RADIUS_M, finiteOrNull } from '../core/math.js';
import { clipReceiverMeshOpeningsSteps } from '../core/receiver-mesh-openings.js';
import { captureReceiverMeshReadSteps } from '../core/receiver-mesh-read.js';
import { composeReceiverSupportReadsSteps, EMPTY_RECEIVER_SUPPORT_READ } from '../core/receiver-support-read.js';
import { createSurfaceOpeningReadSteps } from '../core/surface-opening-read.js';
import { GROUND_GENERATION_LIMITS } from '../core/ground-generation-limits.js';
import { buildCurbSurfaceTrimeshData } from '../core/gta-curb-surface.js';
import { createPlannerGeometryMaterialCache } from '../world/planner-surface-cutout.js';

await RAPIER.init();

const source = readFileSync(new URL('../world/road-grade-separations.js', import.meta.url), 'utf8');
const lat = 45.8, lon = 16, latM = DEG_TO_RAD * EARTH_RADIUS_M, lonM = latM * Math.cos(lat * DEG_TO_RAD);
const ll = (x, z) => [lon + x / lonM, lat - z / latM];
const limits = { maxAlignments: 4, maxSamples: 1024, maxObjects: 128, maxGeometryBytes: 4 * 1024 ** 2,
    maxVertices: 100000, maxTriangles: 100000 };
const finish = (iterator, inspect = () => {}) => {
    try { for (let i = 0; i < 20000; i++) {
        const next = iterator.next(); inspect(next); if (next.done) return next.value;
    } assert.fail('structure preparation did not converge'); } finally { iterator.return(); }
};
function fixture({ omitCrossSection = false } = {}) {
    let sourceY = 1, owners = 0, valid = true, clearanceQueries = 0, uploads = 0;
    function capture() {
        const y = sourceY; let readers = 0;
        const handle = () => {
            owners++; readers++; let released = false;
            return Object.freeze({ contract: 'station3d-ground-read-snapshot-v1',
                evidenceSceneYAtLocal() { assert.ok(readers > 0); return y; },
                absoluteToSceneY(h) { assert.ok(readers > 0); return h - 100; },
                retain() { assert.ok(!released); return handle(); },
                release() { if (released) return false; owners--; readers--; released = true; return true; },
            });
        };
        return handle();
    }
    const definitions = ['underpass', 'overpass'].map((kind, i) => ({
        id: kind, kind, memberOsmIds: [i + 1], axis: [ll(0, i * 100), ll(400, i * 100)],
        profile: { type: 'terrain-offset', offsetM: i ? 7 : -5 },
        structureRange: { start: { distanceM: 150 }, end: { distanceM: 250 } },
        replaceRoadSurface: true, replacementCarriagewayOnly: !i,
        crossSection: omitCrossSection ? undefined : { carriagewayHalfWidthM: 3.5, formationHalfWidthM: 5,
            terrainClearHalfWidthM: 8, terrainCutoutHalfWidthM: 5 },
    }));
    const model = new alignmentApi.RoadVerticalAlignmentModel({ anchorLon: lon, anchorLat: lat,
        definitions, captureTerrainSnapshot: capture, sampleSpacingM: 8 });
    const formation = Object.freeze({ surfaceAtLocal() { clearanceQueries++; return null; } });
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }); registerShared(material);
    const materials = Object.fromEntries(['asphalt', 'earth', 'concrete', 'terrainCollar', 'metal',
        'sidewalk', 'bridgeSupport', 'redPaint', 'whitePaint'].map(key => [key, material]));
    const parent = new THREE.Group(), registry = createSurfacePublicationRegistry(), boundary = createGroundPublicationBoundary();
    const runtime = vm.createContext({ THREE, ...alignmentApi, alignmentHalfWidths, roadStructureSampleFrame, ...spec, ...pillars, ...hierarchy, ...replacement,
        createPlannerGeometryMaterialCache,
        markSurfaceClaim, finiteOrNull, retainReadSnapshot, disposeGroup, registerShared, unregisterShared,
        markInspectionLayer() {}, clipReceiverMeshOpeningsSteps, captureReceiverMeshReadSteps, composeReceiverSupportReadsSteps,
        EMPTY_RECEIVER_SUPPORT_READ, createFrameChunkQueue: () => ({ cancel() {}, clear() {} }),
        performance, camera: {}, renderer: {}, scene: parent, SIDEWALK_UV_PER_M: .25, ASPHALT_UV_PER_M: 1 / 16, GRASS_UV_PER_M: .1,
        fixtureParent: parent, fixtureModel: model, fixtureRegistry: registry, fixtureMaterials: materials,
        liveFormation: new Proxy({}, { get() { throw new Error('structure sampled live road formation'); } }),
        *prewarmDetachedObject(root) { assert.equal(root.parent, null); uploads++; yield { phase: 'controlled-gpu-completion' }; },
    });
    vm.runInContext(source.replace(/^import\s[\s\S]*?;\n/gm, '').replace(/\bexport (?=(function|const)\b)/g, ''), runtime);
    vm.runInContext('group = fixtureParent; alignmentModel = fixtureModel; surfacePublications = fixtureRegistry;'
        + 'materials = fixtureMaterials; roadFormationModel = liveFormation;', runtime);
    const oldAlignments = model.getAlignments();
    for (const alignment of oldAlignments) {
        const task = runtime.createAlignmentBuildTask(alignment, oldAlignments, materials, null, formation);
        for (let i = 0; !task.step(); i++) assert.ok(i < 100);
        task.generation = 1; runtime.replaceAlignmentGroup(task);
    }
    vm.runInContext('builtRevision = alignmentModel.publishedRevision; requestedRevision = builtRevision; buildGeneration = 1;', runtime);
    const state = () => vm.runInContext('({ roots: new Map(alignmentGroups), lease: groundGenerationLease, built: builtRevision, support: groundSupportRead })', runtime);
    return { runtime, model, oldAlignments, parent, registry, boundary, state, formation,
        owners: () => owners, uploads: () => uploads, clearanceQueries: () => clearanceQueries,
        change(y) { sourceY = y; model.invalidateTerrain(); }, setValid(value) { valid = value; },
        admit: () => runtime.admitRoadStructureGroundGeneration({ isCurrent: () => valid }),
        prepare(admission, alignmentRead, extra = {}) {
            const { openings, ...options } = extra;
            const ground = ownReadSnapshot({ verticalAlignments: alignmentRead,
                roadFormation: formation, openings, isCurrent: () => valid }, [alignmentRead.retain('test-ground')]);
            try { return { ground, steps: runtime.prepareRoadStructureGroundGenerationSteps({
                admission, ground, ...limits, ...options }) }; } catch (error) { ground.release(); throw error; }
        },
        close() {
            vm.runInContext('groundGenerationLease?.cancel()', runtime);
            boundary.close(); registry.close({ retireActive: true }); model.dispose();
            unregisterShared(material); material.dispose(); assert.equal(owners, 0);
        },
    };
}
const arrays = root => {
    const result = new Map(); root.updateMatrixWorld(true); root.traverse(object => {
        const position = object.geometry?.attributes.position; if (!position) return;
        const values = [], matrix = new THREE.Matrix4(), point = new THREE.Vector3();
        for (let instance = 0; instance < (object.isInstancedMesh ? object.count : 1); instance++) {
            if (object.isInstancedMesh) object.getMatrixAt(instance, matrix); else matrix.identity();
            matrix.premultiply(object.matrixWorld);
            for (let i = 0; i < position.count; i++) { point.fromBufferAttribute(position, i).applyMatrix4(matrix); values.push(point.x, point.y, point.z); }
        }
        result.set(object.name, values);
    }); return result;
};
const near = (value, expected) => assert.ok(Math.abs(value - expected) <= .001, `${value} != ${expected}`);
const roadY = (root, alignment, osmId) => {
    const z = osmId === 1 ? 0 : 100, y = alignment.profileYAtS(100);
    root.updateMatrixWorld(true);
    return new THREE.Raycaster(new THREE.Vector3(100, y + .5, z), new THREE.Vector3(0, -1, 0))
        .intersectObject(root, true)[0]?.point.y;
};

test('an explicit replacement without cross-section fields still publishes its default physical floor', () => {
    const f = fixture({ omitCrossSection: true });
    try {
        const root = f.state().roots.get('underpass');
        const floor = root.getObjectByName('RoadAlignmentSurface:underpass');
        assert.ok(floor?.geometry?.attributes.position.count > 0, 'terrain cuts require a replacement floor');
        const alignment = f.oldAlignments.find(a => a.kind === 'underpass');
        near(roadY(root, alignment, 1), alignment.profileYAtS(100) + .032);
    } finally { f.close(); }
});

test('real structure meshes, model and replacement proof promote together; later failure restores both structures', () => {
    const f = fixture(), old = f.state(), initialOwners = f.owners();
    const oldGeometry = new Map([...old.roots].map(([id, root]) => [id, arrays(root)]));
    const oldYs = f.oldAlignments.map((alignment, i) => roadY(old.roots.get(alignment.id), alignment, i + 1));
    let modelTx = null, candidate = null, inputs = null;
    const assertOld = () => {
        assert.deepEqual([...f.state().roots], [...old.roots]); assert.equal(f.state().built, old.built);
        assert.equal(f.model.getAlignments(), f.oldAlignments);
        f.oldAlignments.forEach((a, i) => near(roadY(old.roots.get(a.id), a, i + 1), oldYs[i]));
    };
    try {
        for (const failLater of [true, false]) {
            const admission = f.admit(); f.change(5);
            modelTx = finish(f.model.preparePublicationSteps({ authoredPortalReplacements: [] }), assertOld);
            inputs = f.prepare(admission, modelTx.read);
            candidate = finish(inputs.steps, assertOld);
            assert.equal(candidate.usage.alignments, 2); assert.ok(candidate.usage.geometryBytes > 0);
            for (const [i, alignment] of modelTx.read.getAlignments().entries()) {
                const key = replacement.roadStructurePublicationKey(alignment.id);
                const root = candidate.structurePublications.getActive(key).root;
                near(roadY(root, alignment, i + 1), oldYs[i] + 4);
                assert.ok(replacement.roadReplacementPublicationReadyForOsmId({ alignmentModel: modelTx.read,
                    surfacePublications: candidate.structurePublications, osmId: i + 1 }));
                assert.equal(replacement.roadReplacementPublicationReadyForOsmId({ alignmentModel: modelTx.read,
                    surfacePublications: f.registry, osmId: i + 1 }), false);
                // Uniform source translation is an independent geometric
                // invariant: every emitted vertex keeps X/Z and moves +4 m.
                for (const [name, positions] of arrays(root)) {
                    const before = oldGeometry.get(alignment.id).get(name); assert.equal(positions.length, before.length);
                    positions.forEach((value, index) => near(value, before[index] + (index % 3 === 1 ? 4 : 0)));
                }
            }
            const batch = f.registry.prepareBatch([{ ticket: f.registry.begin({ key: 'alignment-model', generation: failLater ? 2 : 3 }),
                clear: true, isCurrent: modelTx.isCurrent, commit: modelTx.commit, rollback: modelTx.rollback, discard: modelTx.discard },
            ...candidate.entries], { commit() { if (failLater) throw new Error('late ground member failure'); } });
            if (failLater) {
                assert.throws(() => batch.publish(), /late ground member failure/); assertOld();
                assert.equal(f.state().lease, null); inputs.ground.release(); inputs = null;
                assert.equal(f.owners(), initialOwners);
            } else {
                f.boundary.enqueue(batch, { onPublished() { modelTx.finalize(); candidate.finalize(); } });
                assertOld(); f.boundary.publishReady();
                assert.equal(f.state().lease, null); assert.equal(f.state().built, f.model.publishedRevision);
                assert.equal(f.parent.children.length, 2); assert.notDeepEqual([...f.state().roots], [...old.roots]);
                assert.ok(f.model.getAlignments().every(a => replacement.roadReplacementPublicationReadyForOsmId({
                    alignmentModel: f.model, surfacePublications: f.registry, osmId: a.kind === 'underpass' ? 1 : 2 })));
            }
        }
        assert.ok(f.uploads() >= 4); assert.ok(f.clearanceQueries() > 0);
    } finally { candidate?.discard(); modelTx?.discard(); inputs?.ground.release(); f.close(); }
});

test('an opening-only update replaces the contacted floor with exact cut support and restores it on removal', () => {
    const f = fixture(), read = finish(f.model.captureReadSnapshotSteps({ authoredPortalReplacements: [] }));
    const initialRoots = f.state().roots;
    const floorY = roadY(initialRoots.get('underpass'), f.oldAlignments[0], 1);
    const bounds = { minX: 99, maxX: 101, minZ: -1, maxZ: 1 };
    const openings = finish(createSurfaceOpeningReadSteps({ authored: [{
        ring: [{ x: 99, z: -1 }, { x: 101, z: -1 }, { x: 101, z: 1 }, { x: 99, z: 1 }],
        minY: floorY - .5, maxY: floorY + 1, replacementKey: 'independent-authored-floor',
    }], limits: GROUND_GENERATION_LIMITS.openings }));
    const empty = finish(createSurfaceOpeningReadSteps({ limits: GROUND_GENERATION_LIMITS.openings }));
    const at = support => support.supportYAt(100, 0, { maxY: floorY + .5 });
    const colliderAt = support => {
        const data = buildCurbSurfaceTrimeshData({ surfaces: support.surfacesNear(100, 0, 10),
            centerX: 100, centerZ: 0, radiusM: 10, maxTriangles: 100000 });
        const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
        try {
            if (!data.triangleCount) return null;
            const collider = world.createCollider(RAPIER.ColliderDesc.trimesh(data.vertices, data.indices));
            const top = floorY + .5;
            const hit = collider.castRay(new RAPIER.Ray({ x: 100, y: top, z: 0 }, { x: 0, y: -1, z: 0 }), 10, true);
            return Number.isFinite(hit) && hit >= 0 && hit <= 10 ? top - hit : null;
        } finally { world.free(); }
    };
    let inputs = null, candidate = null;
    try {
        // First migrate unchanged roots into the shared physical read. This
        // establishes the cache whose opening-only invalidation is exercised.
        inputs = f.prepare(f.admit(), read, { openings: empty }); candidate = finish(inputs.steps);
        f.registry.prepareBatch(candidate.entries).publish(); candidate.finalize(); inputs.ground.release(); inputs = null;
        const previous = f.state(), untouched = previous.roots.get('overpass');
        near(at(previous.support), floorY); near(colliderAt(previous.support), floorY);
        for (const failure of [true, false]) {
            inputs = f.prepare(f.admit(), read, { openings, openingChangedBounds: [bounds] });
            candidate = finish(inputs.steps, () => {
                assert.equal(f.state().support, previous.support); near(at(f.state().support), floorY);
            });
            assert.equal(candidate.usage.alignments, 1, 'only the structure touching the changed opening rebuilds');
            assert.equal(candidate.structurePublications.getActive(replacement.roadStructurePublicationKey('overpass')).root, untouched);
            assert.equal(at(candidate.supportRead), null, 'the cut has no invented analytic floor');
            assert.equal(colliderAt(candidate.supportRead), null, 'Rapier preserves the same opening');
            const nextRoot = candidate.structurePublications.getActive(replacement.roadStructurePublicationKey('underpass')).root;
            nextRoot.updateWorldMatrix(true, true);
            const top = nextRoot.getObjectByName('RoadAlignmentSurface:underpass');
            assert.equal(new THREE.Raycaster(new THREE.Vector3(100, floorY + .5, 0),
                new THREE.Vector3(0, -1, 0)).intersectObject(top)[0], undefined);
            const batch = f.registry.prepareBatch(candidate.entries, { commit() { if (failure) throw Error('later receiver failed'); } });
            if (failure) {
                assert.throws(() => batch.publish(), /later receiver failed/);
                assert.equal(f.state().support, previous.support); near(colliderAt(f.state().support), floorY);
                assert.equal(f.state().roots.get('underpass'), previous.roots.get('underpass'));
            } else { batch.publish(); candidate.finalize(); assert.equal(at(f.state().support), null); }
            inputs.ground.release(); inputs = null;
        }
        inputs = f.prepare(f.admit(), read, { openings: empty, openingChangedBounds: [bounds] });
        candidate = finish(inputs.steps);
        assert.equal(candidate.usage.alignments, 1);
        near(at(candidate.supportRead), floorY); near(colliderAt(candidate.supportRead), floorY);
        f.registry.prepareBatch(candidate.entries).publish(); candidate.finalize();
        near(at(f.state().support), floorY); assert.equal(f.state().roots.get('overpass'), untouched);
    } finally { candidate?.discard(); inputs?.ground.release(); read.release(); f.close(); }
});

test('structure cancellation, busy admission, resource overflow and exact reuse preserve the complete old generation', () => {
    const f = fixture(), old = f.state(), before = f.owners(); let read = null, inputs = null, candidate = null;
    try {
        vm.runInContext('buildJob = {}', f.runtime);
        assert.throws(f.admit, { code: 'ground-dependency-busy' }); vm.runInContext('buildJob = null', f.runtime);
        read = finish(f.model.captureReadSnapshotSteps({ authoredPortalReplacements: [] }));
        inputs = f.prepare(f.admit(), read);
        candidate = finish(inputs.steps);
        assert.equal(candidate.usage.alignments, 0); assert.equal(candidate.usage.geometryBytes, 0); assert.equal(f.uploads(), 0);
        candidate.discard(); inputs.ground.release(); inputs = null;
        for (const mode of ['cancel', 'stale', 'capacity']) {
            inputs = f.prepare(f.admit(), read, { additionalAlignmentIds: ['underpass'],
                ...(mode === 'capacity' ? { maxGeometryBytes: 1 } : {}) });
            assert.equal(inputs.steps.next().done, false);
            if (mode === 'cancel') inputs.steps.return();
            else {
                if (mode === 'stale') f.setValid(false);
                assert.throws(() => finish(inputs.steps), { code: mode === 'stale' ? 'ground-generation-stale' : 'ground-generation-capacity' });
            }
            f.setValid(true); inputs.ground.release(); inputs = null;
            assert.equal(f.state().lease, null); assert.deepEqual([...f.state().roots], [...old.roots]);
        }
        read.release(); read = null; assert.equal(f.owners(), before);
    } finally { candidate?.discard(); inputs?.steps.return(); inputs?.ground.release(); read?.release(); f.close(); }
});
