// Production curb task, terrain drape, mesh compiler and publication group.
// Cross-section coordinates are an independent small fixture; no browser/GPU.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { ownReadSnapshot, retainReadSnapshot } from '../core/read-snapshot-lifetime.js';
import { disposeGroup } from '../core/dispose.js';
import { markSurfaceClaim } from '../core/surface-claim.js';
import { reviseSurfaceClaim, SURFACE_COVERAGE_STATE, SURFACE_RENDER_ORDER } from '../core/surface-hierarchy.js';
import { finiteOrNull } from '../core/math.js';
import { resolveCurbSceneYAtLocal } from '../core/curb-height.js';
import { CURB_DRAPE_KIND, curbDrapeHeightSource, stepCurbTerrainDrape,
    stepCurbTerrainDrapeSettled, withoutOmittedCurbRanges } from '../core/curb-terrain-drape.js';
import { isPermanentTerrainGap } from '../core/terrain-evidence-gap.js';
import { prepareCurbTileGeometrySteps } from '../core/curb-tile-geometry.js';
import { prepareCurbPublicationGroupSteps } from '../core/curb-publication-group.js';
import { createSurfaceRebuildLedger } from '../core/surface-rebuild-ledger.js';
import { createSurfacePublicationRegistry } from '../core/surface-publication-registry.js';
import { createGroundPublicationBoundary } from '../core/ground-publication-boundary.js';
import { createPublishedGroundReadSlot } from '../core/published-ground-read.js';
import { prepareGroundConsumerSteps } from '../core/ground-consumer-preparation.js';

const source = readFileSync(new URL('../world/curbs.js', import.meta.url), 'utf8');
const block = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
function fixture({ permanent = false, twoRuns = false } = {}) {
    let frame = 0, owners = 0, valid = true, sampled = [], missing = false;
    const registry = createSurfacePublicationRegistry(), boundary = createGroundPublicationBoundary();
    const ledger = createSurfaceRebuildLedger(), material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    function lease() { owners++; let released = false;
        return { retain() { assert.equal(released, false); return lease(); },
            release() { if (released) return false; released = true; owners--; return true; } }; }
    const ground = ownReadSnapshot({ terrain: Object.freeze({ evidenceSceneYAtLocal(x, z) {
        assert.ok(owners > 0); sampled.push([x, z]); return missing && x > 3 ? null : 5;
    }, ...(permanent ? { hasLoadedCoreCoverageAtLocal: () => true, evidenceWithheldAtLocal: () => false } : {}) }), roadFormation: null, railFormation: null, verticalAlignments: null,
    renderedRailSurface: Object.freeze({ coverage: 'candidate-rail' }), isCurrent: () => valid }, [lease()]);
    const r = vm.createContext({ THREE, ownReadSnapshot, retainReadSnapshot, disposeGroup, markSurfaceClaim,
        reviseSurfaceClaim, SURFACE_COVERAGE_STATE, SURFACE_RENDER_ORDER, finiteOrNull, resolveCurbSceneYAtLocal,
        CURB_DRAPE_KIND, curbDrapeHeightSource, stepCurbTerrainDrape, stepCurbTerrainDrapeSettled,
        isPermanentTerrainGap, withoutOmittedCurbRanges, prepareCurbTileGeometrySteps,
        prepareCurbPublicationGroupSteps, TERRAIN_VERTICES_PER_CHUNK: 256, roadSurfaceSceneOffset: () => .08,
        SIDEWALK_UV_PER_M: .4, GRASS_UV_PER_M: .3, CURB_TERRAIN_SEAM_CLAIM: null,
        CURB_DRESSING_CLAIM: { surfaceClass: 'sidewalk', verticalBand: 'ground', supportReady: true },
        curbsGroup: new THREE.Group(), surfacePublications: registry, groundPublications: boundary,
        tileGroups: new Map(), tileCollisionSurfaces: new Map(), curbCollisionRevision: 0, curbPublicationGeneration: 0,
        sessionId: 1, parkingIndex: null, parkingIndexReady: true, curbPublicationLease: null,
        plannerTrackVolumeGrid: Object.freeze({ key: 'planner' }), plannerTrackCorridorVolumes: Object.freeze([]),
        tileFeatures: new Map([['a', [{}]], ['b', [{}]]]), maskTileFeatures: new Map([['a', []], ['b', []]]),
        tramTileFeatures: new Map(), roadbedTileFeatures: new Map(), curbRebuildLedger: ledger,
        FORMATION_DIRTY_PADDING_M: 32, CURB_MASK_STAGES: [['masks:fixture', () => {}]],
        tileLocalBounds: key => ({ minX: key === 'a' ? 0 : 5, minZ: 0, maxX: key === 'a' ? 2 : 7, maxZ: 2 }),
        prepareTileBuildContext(key, captured) {
            assert.equal(captured.planner.grid, r.plannerTrackVolumeGrid);
            assert.equal(captured.renderedRailSurface, ground.renderedRailSurface);
            const x = key === 'a' ? 0 : 5, positions = [x, .18, 0, x, .18, 2, x + 2, .18, 0];
            const uvs = [0, 0, 0, 1, 1, 0];
            const heightRanges = [{ positions, start: 0, end: positions.length, osmIds: [1], verticalOsmIds: null,
                drapeKind: CURB_DRAPE_KIND.OWNER }];
            if (twoRuns && key === 'b') {
                // A second kerb run inland (x <= 3) shares tile b's list with the pier run at x = 5.
                positions.push(2, .18, 0, 2, .18, 2, 3, .18, 0); uvs.push(2, 0, 2, 1, 3, 0);
                heightRanges.push({ positions, start: 9, end: 18, osmIds: [2], verticalOsmIds: null, drapeKind: CURB_DRAPE_KIND.OWNER });
            }
            return { bounds: r.tileLocalBounds(key), ground: captured, features: [], parkingMasks: [],
                curb: { positions, uvs }, ramp: { positions: [] }, greenRamp: { positions: [] },
                terrainSeam: { positions: [] }, manholes: [], verticalAlignmentModel: null, heightRanges };
        },
        captureSurfaceBuildGround() { throw new Error('candidate curb asked for live ground'); },
        groundPhysicsProvider() { throw new Error('curb candidate acquired an independent physics reservation'); },
        getCurbMaterial: () => material, buildManholeMesh: () => null, noteInitialNearCurbTileReady() {},
        renderer: {}, camera: {}, scene: {}, getFrameChunkSequence: () => frame,
        lastCurbGpuFrame: -1, curbGpuReadiness: new Set(),
        *prewarmDetachedObject(root) { assert.equal(root.parent, null); yield { phase: 'controlled-gpu', deferFrame: true }; },
    });
    vm.runInContext(block('function createTilePrepTask(', 'function currentRailCutEdgeEvaluator(')
        + block('function terrainBuildItems(', 'function disposeTileGroup(')
        + block('function trackCurbGpuReadiness(', '// A completed CPU tile'), r);
    for (const key of ['a', 'b']) {
        const x = key === 'a' ? 0 : 5, geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute([x, 1.18, 0, x, 1.18, 2, x + 2, 1.18, 0], 3));
        const root = new THREE.Mesh(geometry, material);
        assert.equal(r.prepareCurbTilePublication(key, root, { tileKey: key, bounds: r.tileLocalBounds(key),
            positions: geometry.attributes.position.array }).publish(), true);
        ledger.mark(key, 7);
    }
    function finish(steps, inspect = () => {}) {
        try { for (let i = 0; i < 5000; i++) {
            frame++; const next = steps.next(); inspect(next);
            if (next.done) return next.value;
        } assert.fail('Curb generation did not converge'); } finally { steps.return(); }
    }
    const y = (key, x = key === 'a' ? .5 : 5.5) => {
        const root = r.tileGroups.get(key); root?.updateMatrixWorld(true);
        return new THREE.Raycaster(new THREE.Vector3(x, 10, .5), new THREE.Vector3(0, -1, 0))
            .intersectObject(root)[0]?.point.y;
    };
    return { r, registry, boundary, ledger, ground, finish, y, owners: () => owners, sampled,
        valid(value) { valid = value; }, missing(value) { missing = value; },
        steps: () => r.prepareCurbReceiverGenerationSteps({ tileKeys: ['a', 'b'], ground, isCurrent: () => valid, maxTiles: 2 }),
        close() { boundary.close(); registry.close({ retireActive: true }); ground.release(); material.dispose(); assert.equal(owners, 0); } };
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

test('both candidate curb tiles drape through retained inputs and publish with one support read; failure rolls both back', () => {
    const f = fixture(), roots = [...f.r.tileGroups.values()];
    const old = () => { near(f.y('a'), 1.18); near(f.y('b'), 1.18); assert.deepEqual([...f.r.tileGroups.values()], roots); };
    try {
        for (const fail of [true, false]) {
            const candidate = f.finish(f.steps(), old); assert.ok(candidate); old();
            try {
            assert.equal(f.owners(), 2);
            const surfaces = candidate.curbSurfaceRead.surfacesNear(0, 0, 10);
            assert.equal(surfaces.length, 2);
            for (const surface of surfaces) for (let i = 1; i < surface.positions.length; i += 3) near(surface.positions[i], 5.18);
            const batch = f.registry.prepareBatch(candidate.entries, { commit() { if (fail) throw new Error('later receiver failed'); } });
            if (fail) {
                assert.throws(() => batch.publish(), /later receiver failed/); old();
                assert.equal(f.owners(), 1); assert.equal(f.r.curbPublicationLease, null);
                assert.equal(f.ledger.isPending('a'), true); assert.equal(f.ledger.isPending('b'), true);
            } else {
                assert.ok(f.boundary.enqueue(batch, { onPublished: () => candidate.finalize() })); old();
                f.boundary.publishReady(); near(f.y('a'), 5.18); near(f.y('b'), 5.18);
                assert.equal(f.ledger.size, 0); assert.equal(f.owners(), 1);
                assert.equal(f.r.curbPublicationLease, null);
            }
            } finally { candidate.discard(); }
        }
        assert.ok(f.sampled.some(([x]) => x < 3)); assert.ok(f.sampled.some(([x]) => x > 3));
    } finally { f.close(); }
});

test('curb generation rejects late missing evidence, source edits and cancellation without removing old support or leaking read owners', () => {
    const f = fixture();
    try {
        f.missing(true);
        assert.throws(() => f.finish(f.steps()), { code: 'curb-terrain-evidence-unavailable' });
        near(f.y('a'), 1.18); near(f.y('b'), 1.18); assert.equal(f.owners(), 1);
        assert.equal(f.ledger.size, 2); assert.equal(f.r.curbPublicationLease, null);
        f.missing(false);
        let steps = f.steps(); assert.equal(steps.next().done, false); steps.return();
        assert.equal(f.owners(), 1); assert.equal(f.r.curbPublicationLease, null);
        steps = f.steps(); assert.equal(steps.next().done, false);
        f.r.maskTileFeatures.set('b', []);
        assert.equal(f.finish(steps), null); assert.equal(f.owners(), 1);
        near(f.y('a'), 1.18); near(f.y('b'), 1.18);
        const retry = f.finish(f.steps()); assert.ok(retry); retry.discard();
        assert.equal(f.owners(), 1); assert.equal(f.r.curbPublicationLease, null);
    } finally { f.close(); }
});

test('world curb-only generation reuses published reads, keeps unaffected geometry and atomically replaces only curb physics', () => {
    const f = fixture(), slot = createPublishedGroundReadSlot();
    const world = readFileSync(new URL('../world/ground-generations.js', import.meta.url), 'utf8');
    const realm = vm.createContext({ ownReadSnapshot, retainReadSnapshot, prepareGroundConsumerSteps,
        fail(code, message) { throw Object.assign(new Error(message), { code }); } });
    vm.runInContext(world.slice(world.indexOf('export function* prepareWorldGroundGenerationSteps'),
        world.indexOf('const PHYSICS_FAMILIES')).replace('export function*', 'function*'), realm);
    const initial = slot.begin({ isCurrent: () => true }); initial.bindRead(f.ground);
    const initialBatch = f.registry.prepareBatch([{ ticket: f.registry.begin({ key: 'ground:receiver-queries', generation: 1 }),
        clear: true, isCurrent: initial.isCurrent, commit: initial.commit, rollback: initial.rollback, discard: initial.discard }]);
    assert.ok(initialBatch.publish()); assert.equal(initial.finalize(), true);
    const roots = [...f.r.tileGroups.values()];
    let regions = 0, sourceOwners = 0, physicsActive = 0;
    const physics = { admitGroundPublicationRegion(families, options) {
        assert.deepEqual(Array.from(families), ['curb-surfaces']); assert.equal(options.allowEmpty, true);
        regions++;
        return { isCurrent: () => true, release() { regions--; },
            *prepareSteps(reads, current) {
                assert.deepEqual(Object.keys(reads), ['curb-surfaces']);
                const surfaces = reads['curb-surfaces'].surfacesNear(0, 0, 10);
                assert.equal(surfaces.length, 2);
                for (const row of surfaces) for (let i = 1; i < row.positions.length; i += 3) {
                    near(row.positions[i], row.tileKey === 'a' ? 5.18 : 1.18);
                }
                yield { phase: 'controlled-curb-physics' };
                return { entry: { clear: true, isCurrent: current,
                    commit() { physicsActive++; return true; }, rollback() { physicsActive--; }, discard() {} },
                    finalize: () => true };
            } };
    } };
    const poison = new Proxy({}, { get(_target, name) { throw new Error(`Curb update accessed upstream ${String(name)}`); } });
    const layers = { terrain: poison, roads: poison, rails: poison, structures: poison,
        curbs: { *groundTileKeysSteps({ keys, full }) {
            assert.deepEqual(Array.from(keys), ['a']); assert.equal(full, false); return ['a'];
        }, prepareGroundGenerationSteps: f.r.prepareCurbReceiverGenerationSteps } };
    const old = () => { near(f.y('a'), 1.18); near(f.y('b'), 1.18);
        assert.deepEqual([...f.r.tileGroups.values()], roots); assert.equal(physicsActive, 0); };
    try {
        for (const fail of [true, false]) {
            sourceOwners++; let released = false;
            const sources = { isCurrent: () => !released,
                release() { if (!released) { released = true; sourceOwners--; } } };
            const candidate = f.finish(realm.prepareWorldGroundGenerationSteps({
                ctx: { getGroundPhysics: () => physics }, layers,
                admission: { sources, receivers: slot.capture('curb-generation') },
                scope: { curbsOnly: true, curbBounds: [], curbSourceKeys: ['a'], curbFull: false },
                limits: { curbs: { maxTiles: 2 } }, registry: f.registry, generation: fail ? 2 : 3, isCurrent: () => true,
            }), old);
            try {
                assert.equal(candidate.usage.reusedReceivers, true); assert.equal(candidate.usage.curbs.tiles, 1);
                assert.equal(candidate.usage.physics, true); assert.equal(f.owners(), 4); assert.equal(regions, 1);
                const batch = f.registry.prepareBatch(candidate.entries, { commit() { if (fail) throw new Error('later member failed'); } });
                if (fail) { assert.throws(() => batch.publish(), /later member failed/); old(); }
                else {
                    assert.ok(f.boundary.enqueue(batch, { onPublished: () => candidate.finalize() })); old();
                    f.boundary.publishReady(); near(f.y('a'), 5.18); near(f.y('b'), 1.18);
                    assert.equal(f.r.tileGroups.get('b'), roots[1]); assert.equal(physicsActive, 1);
                    assert.equal(f.ledger.isPending('a'), false); assert.equal(f.ledger.isPending('b'), true);
                }
                assert.equal(f.owners(), 2); assert.equal(regions, 0); assert.equal(sourceOwners, 0);
                assert.equal(slot.snapshot().revision, 1); assert.equal(f.r.curbPublicationLease, null);
            } finally { candidate.discard(); }
        }
    } finally { slot.close(); f.close(); }
});

test('a kerb run over ground the terrain will never have is omitted alone; the rest of its tile publishes', () => {
    // Split port, 2026-09-16: one pier kerb used to clear every kerb in a 400 m tile.
    const f = fixture({ permanent: true, twoRuns: true });
    try {
        f.missing(true);
        const warnings = [];
        const warn = f.r.console?.warn; f.r.console = { warn: (...args) => warnings.push(args.join(' ')) };
        const candidate = f.finish(f.steps()); assert.ok(candidate, 'a permanent gap no longer rejects the generation');
        try {
            assert.ok(f.boundary.enqueue(f.registry.prepareBatch(candidate.entries), { onPublished: () => candidate.finalize() }));
            f.boundary.publishReady();
            near(f.y('a'), 5.18);
            near(f.y('b', 2.5), 5.18, 'the inland run of tile b is drawn at its draped height');
            assert.equal(f.y('b', 5.5), undefined, 'the pier run is not drawn');
            const root = f.r.tileGroups.get('b'); let vertices = 0;
            root.traverse(mesh => { if (mesh.isMesh) vertices += mesh.geometry.attributes.position.count; });
            assert.equal(vertices, 3);
            assert.equal(f.ledger.size, 0, 'the tile acknowledges, so the world can finish loading');
            assert.equal(f.owners(), 1);
            assert.ok(warnings.some(line => /tile b published without 1 of 2 kerb runs \(osm 1\)/.test(line)), warnings.join('\n'));
        } finally { candidate.discard(); if (warn) f.r.console = { warn }; }
    } finally { f.close(); }
});
