// Run the real lane rebuild tail against a clock and real Three.js buffers:
// aggregate construction must yield, keep the old mesh, and publish once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import * as strips from '../core/strip-geometry-cache.js';

const LANE_SOURCE = readFileSync(new URL('../world/lane-markings.js', import.meta.url), 'utf8');

function fixture() {
    const source = LANE_SOURCE;
    let clock = 0, reads = 0, oldDisposals = 0;
    const material = new THREE.MeshBasicMaterial();
    const group = new THREE.Group(), previous = new THREE.Mesh(new THREE.BufferGeometry(), material);
    previous.geometry.addEventListener('dispose', () => { oldDisposals++; });
    group.add(previous);
    const position = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1]);
    const entries = Array.from({ length: 2000 }, () => ({
        get positions() { reads++; return position; }, uvs: new Float32Array(8), quads: 1,
    }));
    const stripCache = strips.createStripGeometryCache(); stripCache.beginPass('test');
    const sandbox = {
        ...strips, THREE, group, aggregateMesh: previous, stripCache, lastCacheStats: null,
        performance: { now: () => ++clock }, recordLayerFrameMs() {}, stepFormationInvalidation: () => true,
        topologyRevision: 'initial', currentPathTopologyKey: () => sandbox.topologyRevision,
        activeBuild: { pathBuild: null, entries: [], entryIndex: 0, cached: entries, plannerCuts: [], drapeMs: 0,
            terrainEvidenceIncomplete: false, generation: 1, topologyKey: 'initial', publicationTicket: null },
        getDashMaterial: () => material, markSurfaceClaim() {}, reviseSurfaceClaim: x => x,
        LANE_MARKING_CLAIM: {}, LANE_PUBLICATION_KEY: 'lanes', STRIP_RENDER_ORDER: 3,
        settleInitialLanePublication() {},
        disposeAggregateMesh() { throw Error('nonempty assembly cannot clear the old mesh'); },
        disposeLaneMesh(mesh) { mesh.geometry.dispose(); mesh.parent?.remove(mesh); },
    };
    const discard = source.slice(source.indexOf('function discardActiveBuild'), source.indexOf('function beginLanePublication'));
    const step = source.slice(source.indexOf('function stepRebuild'), source.indexOf('function rebuildActiveLaneMarkingsSync'));
    runInNewContext(`${discard}\n${step}`, sandbox);
    return { sandbox, previous, entries, reads: () => reads, oldDisposals: () => oldDisposals,
        close() { for (const child of group.children) child.geometry.dispose(); material.dispose(); } };
}

test('initial world readiness waits for the first complete lane aggregate', () => {
    assert.match(LANE_SOURCE,
        /initialLanePublicationPending = true;\s*noteWorldQueueActive\(INITIAL_LANE_READY_LABEL\)/);
    assert.match(LANE_SOURCE,
        /publicationTicket\.publish\(mesh,[\s\S]{0,180}settleInitialLanePublication\(result\)/);
    assert.match(LANE_SOURCE,
        /publicationTicket\.clear\(\)[\s\S]{0,120}settleInitialLanePublication\(result\)/,
        'a legitimately empty road graph also completes the startup contract');
});

test('lane aggregate finalization cannot scan/copy every cached strip in one frame', () => {
    const f = fixture();
    try {
        f.sandbox.stepRebuild(10);
        assert.equal(f.sandbox.aggregateMesh === f.previous, true, 'old markings stay visible during assembly');
        assert.ok(f.reads() < f.entries.length, 'the first frame cannot even count every entry');
        assert.equal(f.oldDisposals(), 0);
        let frames = 1;
        while (f.sandbox.activeBuild && frames++ < 2000) f.sandbox.stepRebuild(10);
        assert.ok(frames > 2 && frames < 2000);
        const mesh = f.sandbox.aggregateMesh;
        assert.notEqual(mesh, f.previous);
        assert.equal(f.oldDisposals(), 1);
        assert.equal(f.sandbox.group.children.length, 1);
        assert.equal(mesh.geometry.index.count, f.entries.length * 6);
        assert.deepEqual([...mesh.geometry.index.array.slice(-6)], [7996, 7997, 7998, 7996, 7998, 7999]);
        assert.ok(mesh.geometry.boundingBox && mesh.geometry.boundingSphere,
            'publication must not defer an aggregate bounds scan to the renderer');
    } finally { f.close(); }
});

test('cancelling a partly assembled lane generation leaves the old mesh intact', () => {
    const f = fixture();
    try {
        // Advance beyond counting/allocation into actual typed-array copies.
        while (f.reads() <= f.entries.length) f.sandbox.stepRebuild(10);
        f.sandbox.discardActiveBuild('superseded');
        for (let frame = 0; frame < 3; frame++) f.sandbox.stepRebuild(10);
        assert.equal(f.sandbox.aggregateMesh === f.previous, true);
        assert.equal(f.oldDisposals(), 0);
        assert.equal(f.sandbox.group.children.length, 1);
    } finally { f.close(); }
});

test('a topology revision during lane assembly discards stale buffers before publication', () => {
    const f = fixture();
    const discarded = [];
    f.sandbox.activeBuild.publicationTicket = {
        discard: reason => discarded.push(reason), publish() { throw Error('stale lane publication'); },
    };
    try {
        while (f.reads() <= f.entries.length) f.sandbox.stepRebuild(10);
        f.sandbox.topologyRevision = 'new-tiles';
        f.sandbox.stepRebuild(10);
        assert.equal(f.sandbox.activeBuild, null);
        assert.equal(f.sandbox.aggregateMesh === f.previous, true);
        assert.equal(f.oldDisposals(), 0);
        assert.deepEqual(discarded, ['topology-superseded']);
    } finally { f.close(); }
});
