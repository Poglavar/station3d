import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { disposeGroup } from '../core/dispose.js';
import { markSurfaceClaim } from '../core/surface-claim.js';
import { reviseSurfaceClaim, SURFACE_CLASS, SURFACE_COVERAGE_STATE } from '../core/surface-hierarchy.js';
import { createSurfacePublicationRegistry } from '../core/surface-publication-registry.js';
import { prepareCurbTileGeometrySteps } from '../core/curb-tile-geometry.js';
import { createSurfaceRebuildLedger } from '../core/surface-rebuild-ledger.js';
import { createTileBuildGenerationController } from '../core/tile-build-generation.js';

const geometryContext = { prepareCurbTileGeometrySteps, SIDEWALK_UV_PER_M: .4, GRASS_UV_PER_M: .3,
    CURB_TERRAIN_SEAM_CLAIM: null, SURFACE_RENDER_ORDER: { CURB_RAMP: 3, ROAD_EARTHWORK: 4 } };
const source = readFileSync(new URL('../world/curbs.js', import.meta.url), 'utf8');

test('an initial curb build keeps a bounded retry obligation when captured inputs become stale', async () => {
    const ledger = createSurfaceRebuildLedger(), jobs = [];
    const controller = createTileBuildGenerationController({ startBuild(key, generation, isCurrent) {
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        jobs.push({ key, generation, isCurrent, resolve, revision: ledger.pendingRevision(key) });
        return { promise };
    } });
    const runtime = vm.createContext({ tileBuildController: controller, curbRebuildLedger: ledger,
        curbDependencyRevision: 0, sessionId: 1 });
    vm.runInContext(source.slice(source.indexOf('function enqueueTileBuild(tileKey)'),
        source.indexOf('function enqueueTileBuildIfReady(')), runtime);
    const first = runtime.enqueueTileBuild('a');
    assert.equal(ledger.isPending('a'), true, 'initial tile publication is an obligation too');
    assert.equal(ledger.shouldRequest('a'), false, 'an in-flight tile does not retry every frame');
    jobs[0].resolve({ cancelled: true }); await first;
    assert.equal(ledger.shouldRequest('a'), true, 'stale initial geometry must be requested again');
    const retry = runtime.enqueueTileBuild('a');
    const replacement = runtime.enqueueTileBuild('a');
    assert.equal(jobs.length, 2, 'supersession coalesces behind the running retry');
    assert.equal(jobs[1].isCurrent(), false);
    jobs[1].resolve({ cancelled: true }); await retry;
    assert.equal(jobs.length, 3);
    assert.equal(ledger.shouldRequest('a'), false,
        'settling the superseded request must not reset its successor acknowledgement');
    assert.equal(jobs[2].revision, ledger.pendingRevision('a'));
    assert.equal(ledger.publish('a', jobs[2].revision), true);
    jobs[2].resolve(); await replacement;
    assert.equal(ledger.size, 0); assert.deepEqual(controller.snapshot(), []);
});

test('production curb finalization prepares a detached root with the exact support buffer', () => {
    const parent = new THREE.Group(), registry = createSurfacePublicationRegistry();
    const groups = new Map(), collisions = new Map();
    let materialDisposals = 0, acknowledged = 0, current = true;
    const runtime = vm.createContext({ ...geometryContext, THREE, disposeGroup, markSurfaceClaim, reviseSurfaceClaim,
        SURFACE_COVERAGE_STATE, CURB_DRESSING_CLAIM: { surfaceClass: SURFACE_CLASS.ROAD_DRESSING },
        curbsGroup: parent, surfacePublications: registry, tileGroups: groups, tileCollisionSurfaces: collisions,
        curbCollisionRevision: 0, curbPublicationGeneration: 0,
        getCurbMaterial() {
            const material = new THREE.MeshBasicMaterial();
            material.addEventListener('dispose', () => materialDisposals++); return material;
        },
        buildManholeMesh: () => null,
    });
    vm.runInContext(source.slice(source.indexOf('function curbTilePublicationKey('),
        source.indexOf('function disposeTileGroup(')), runtime);
    const state = { tileKey: 'a', bounds: { minX: -1, minZ: -1, maxX: 1, maxZ: 1 },
        curb: { positions: [-1, 2, -1, 1, 2, 1, 1, 2, -1], uvs: [0, 0, 1, 1, 1, 0] },
        ramp: { positions: [] }, greenRamp: { positions: [] }, terrainSeam: { positions: [] }, manholes: [] };
    const staged = runtime.prepareTileBuildPublication(state, () => acknowledged++, () => current);
    const root = staged.entry.root, profile = root.getObjectByName('CurbProfile');
    assert.equal(root.parent, null); assert.equal(parent.children.length, 0);
    assert.equal(groups.size, 0); assert.equal(collisions.size, 0); assert.equal(acknowledged, 0);
    assert.deepEqual([...profile.geometry.attributes.position.array], state.curb.positions);
    assert.equal(staged.publish(), true); assert.equal(acknowledged, 1);
    assert.equal(collisions.get('a').positions, profile.geometry.attributes.position.array);
    assert.deepEqual({ ...collisions.get('a').bounds }, state.bounds);
    root.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(new THREE.Vector3(.5, 10, 0), new THREE.Vector3(0, -1, 0));
    assert.equal(ray.intersectObject(root)[0].point.y, 2);
    const stale = runtime.prepareTileBuildPublication(state, () => acknowledged++, () => current);
    current = false;
    assert.equal(stale.publish(), false); assert.equal(stale.finalize(), false);
    assert.equal(acknowledged, 1); assert.equal(groups.get('a'), root);
    assert.equal(parent.children.length, 1); assert.equal(materialDisposals, 1);
    assert.equal(runtime.finalizeTileBuild({ ...state, curb: { positions: [] } }), true);
    assert.equal(groups.size, 0); assert.equal(collisions.size, 0); assert.equal(parent.children.length, 0);
    assert.equal(materialDisposals, 2); registry.close();
});

test('actual curb publication rolls back render/support together without consuming rebuild obligations', () => {
    const parent = new THREE.Group(), registry = createSurfacePublicationRegistry();
    const groups = new Map(), collisions = new Map(), ledger = createSurfaceRebuildLedger();
    const runtime = vm.createContext({ disposeGroup, markSurfaceClaim, reviseSurfaceClaim,
        SURFACE_COVERAGE_STATE, CURB_DRESSING_CLAIM: { surfaceClass: SURFACE_CLASS.SIDEWALK,
            verticalBand: 'ground', supportReady: true },
        curbsGroup: parent, surfacePublications: registry, tileGroups: groups,
        tileCollisionSurfaces: collisions, curbCollisionRevision: 0, curbPublicationGeneration: 0 });
    vm.runInContext(source.slice(source.indexOf('function curbTilePublicationKey('),
        source.indexOf('function finalizeTileBuild(')), runtime);
    let disposed = 0, made = 0;
    const output = (height) => {
        const geometry = new THREE.PlaneGeometry(2, 2); geometry.rotateX(-Math.PI / 2); geometry.translate(0, height, 0);
        const root = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
        let retired = false;
        geometry.addEventListener('dispose', () => { assert.equal(retired, false); retired = true; disposed++; });
        made++;
        return { root, collision: { positions: geometry.attributes.position.array } };
    };
    const active = new Map();
    for (const key of ['a', 'b']) {
        const data = output(1); active.set(key, data);
        assert.equal(runtime.prepareCurbTilePublication(key, data.root, data.collision).publish(), true);
    }
    for (const key of ['a', 'b']) ledger.mark(key, 7);
    const prepare = (key, height = 2) => {
        const data = height === null ? { root: null, collision: null } : output(height);
        const candidate = runtime.prepareCurbTilePublication(key, data.root, data.collision,
            () => ledger.publish(key, 7));
        return { ...data, ...candidate };
    };
    const failedA = prepare('a'), failedB = prepare('b');
    // An independent tile published while these candidates were held. A later
    // rollback must not rewind the shared collision revision past that update.
    const unrelated = output(3);
    runtime.prepareCurbTilePublication('c', unrelated.root, unrelated.collision).publish();
    const oldRevision = runtime.curbCollisionRevision;
    const observations = [];
    registry.subscribe(() => observations.push([...collisions].map(([key, data]) => [key, data.positions[1]])));
    const failed = registry.prepareBatch([failedA.entry, failedB.entry], {
        commit() { throw new Error('later ground dependency failed'); },
    });
    assert.equal(failedA.finalize(), false, 'staging cannot acknowledge a tile');
    assert.throws(() => failed.publish(), /later ground dependency failed/);
    assert.equal(failedA.finalize(), false); assert.equal(failedB.finalize(), false);
    assert.equal(ledger.size, 2); assert.equal(observations.length, 0);
    assert.equal(runtime.curbCollisionRevision, oldRevision);
    assert.equal(disposed, 2, 'both rejected roots were released once');
    for (const [key, data] of active) {
        assert.equal(groups.get(key), data.root); assert.equal(collisions.get(key), data.collision);
        assert.equal(registry.getActive(`curbs:tile:${key}`).root, data.root);
        assert.equal(data.root.parent, parent);
    }
    assert.equal(groups.get('c'), unrelated.root); assert.equal(parent.children.length, 3);

    const nextA = prepare('a'), nextB = prepare('b');
    const published = registry.prepareBatch([nextA.entry, nextB.entry]).publish();
    assert.equal(published.status, 'published');
    assert.equal(ledger.size, 2, 'row commits did not consume obligations');
    assert.equal(nextA.finalize(), true); assert.equal(nextB.finalize(), true);
    assert.equal(nextA.finalize(), false); assert.equal(ledger.size, 0);
    assert.equal(runtime.curbCollisionRevision, oldRevision + 2);
    assert.equal(parent.children.length, 3); assert.equal(disposed, 4);
    assert.equal(observations.length, 2);
    for (const observed of observations) assert.deepEqual(observed, [['a', 2], ['b', 2], ['c', 3]]);
    for (const [key, data] of [['a', nextA], ['b', nextB]]) {
        assert.equal(groups.get(key), data.root); assert.equal(collisions.get(key), data.collision);
        data.root.updateMatrixWorld(true);
        const ray = new THREE.Raycaster(new THREE.Vector3(0, 10, 0), new THREE.Vector3(0, -1, 0));
        assert.equal(ray.intersectObject(data.root)[0].point.y, collisions.get(key).positions[1]);
    }

    // A clear is also a candidate: rollback restores both maps and preserves
    // the old roots, then a successful clear can settle the exact obligation.
    for (const key of ['a', 'b']) ledger.mark(key, 7);
    const clearA = prepare('a', null), clearB = prepare('b', null);
    const beforeClearRevision = runtime.curbCollisionRevision;
    assert.throws(() => registry.prepareBatch([clearA.entry, clearB.entry], {
        commit() { throw new Error('clear group failed'); },
    }).publish(), /clear group failed/);
    assert.equal(clearA.finalize(), false); assert.equal(ledger.size, 2);
    assert.equal(runtime.curbCollisionRevision, beforeClearRevision);
    assert.equal(groups.get('a'), nextA.root); assert.equal(collisions.get('b'), nextB.collision);
    assert.equal(parent.children.length, 3);
    for (const key of ['a', 'b']) {
        assert.equal(runtime.clearPublishedCurbTile(key, () => ledger.publish(key, 7)), true);
    }
    assert.equal(ledger.size, 0); assert.equal(groups.size, 1); assert.equal(collisions.size, 1);
    runtime.clearPublishedCurbTile('c');
    assert.equal(groups.size, 0); assert.equal(collisions.size, 0); assert.equal(parent.children.length, 0);
    registry.close(); assert.equal(disposed, made);
});
