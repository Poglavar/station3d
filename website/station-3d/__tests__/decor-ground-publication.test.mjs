// Execute the production decor publication adapter against the real registry.
// A controlled paint entry observes atomic commit/rollback; real cache/source
// generation tests separately exercise preparation, pixels and cancellation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from 'three';
import { createSurfacePublicationRegistry, surfacePublicationClaimCoverage } from '../core/surface-publication-registry.js';
import { compileSurfaceClaim } from '../core/surface-hierarchy.js';
import { releaseInspectionLayerObjects } from '../core/scene-inspection.js';
const source = readFileSync(new URL('../world/decor.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('function prepareGreeneryPublicationGroup('), source.indexOf('function replaceGroup('));
function fixture() {
    const registry = createSurfacePublicationRegistry(), scene = new THREE.Scene();
    let paintValue = 'old', sequence = 0, finalized = 0;
    const retired = [];
    const runtime = vm.createContext({ THREE, surfacePublicationClaimCoverage,
        scene, surfacePublications: registry, greeneryGroup: null, greeneryPublicationGeneration: 0,
        greenerySurfaceRootByGroup: new WeakMap(), greeneryGroupBySurfaceRoot: new WeakMap(),
        disposedGreeneryGroups: new WeakSet(),
        GREENERY_SURFACE_PUBLICATION_KEY: 'decor:greenery-surfaces',
        waterMaterials: [], currentWaterPolygons: [], currentRunwaySpawns: [],
        releaseInspectionLayerObjects,
        disposeGroup: group => { if (!group) return; retired.push(group); group.removeFromParent(); },
    });
    vm.runInContext(code, runtime);
    const group = ({ surface = true } = {}) => {
        const root = new THREE.Group();
        if (surface) {
            const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial());
            mesh.userData.surfaceClaim = compileSurfaceClaim({ surfaceClass: 'passive-landuse',
                coverageState: 'published', verticalRelation: 'same-level', verticalBand: 'ground' });
            root.add(mesh);
        } else root.add(new THREE.Object3D());
        runtime.prepareGreeneryPublicationGroup(root);
        return root;
    };
    const paint = value => {
        const previous = paintValue;
        const ticket = registry.begin({ key: 'paint:fixture', generation: ++sequence });
        let committed = false;
        return { entry: { ticket, clear: true,
            commit() { committed = true; paintValue = value; return true; },
            rollback() { if (committed) paintValue = previous; committed = false; }, discard() {},
        }, finalize() { finalized++; }, discard() {} };
    };
    return { runtime, scene, registry, group, paint, retired,
        value: () => paintValue, finalized: () => finalized,
        close() { registry.close(); scene.traverse(object => { object.geometry?.dispose(); object.material?.dispose(); }); } };
}
test('production decor atomically replaces surface geometry and paint, retiring previous geometry after both commits', () => {
    const f = fixture();
    try {
        const old = f.group(); f.runtime.publishGreeneryGroup(old);
        const next = f.group(), paint = f.paint('parking');
        assert.equal(f.runtime.greeneryGroup, old); assert.equal(f.value(), 'old');
        assert.equal(next.parent, null);
        const result = f.runtime.publishGreeneryGroup(next, { paint });
        assert.equal(result.status, 'published'); assert.equal(f.runtime.greeneryGroup, next);
        assert.equal(f.value(), 'parking'); assert.equal(f.finalized(), 1);
        assert.equal(old.parent, null); assert.equal(next.parent, f.scene); assert.equal(f.retired.includes(old), true);
    } finally { f.close(); }
});
test('a later decor-state failure rolls back paint and keeps previous visible surface', () => {
    const f = fixture();
    try {
        const old = f.group(); f.runtime.publishGreeneryGroup(old);
        const next = f.group();
        Object.defineProperty(next.userData, 'waterPolygons', { get() { throw new Error('decor state publication failed'); } });
        assert.throws(() => f.runtime.publishGreeneryGroup(next, { paint: f.paint('construction') }), /decor state publication failed/);
        assert.equal(f.value(), 'old'); assert.equal(f.runtime.greeneryGroup, old);
        assert.equal(old.parent, f.scene); assert.equal(f.retired.includes(old), false); assert.equal(f.finalized(), 0);
    } finally { f.close(); }
});
test('a props-only successor publishes paint and clears its old decorative surface in one batch', () => {
    const f = fixture();
    try {
        const old = f.group(); f.runtime.publishGreeneryGroup(old);
        const props = f.group({ surface: false });
        f.runtime.publishGreeneryGroup(props, { paint: f.paint('parking-without-drape') });
        assert.equal(f.registry.getActive('decor:greenery-surfaces'), null);
        assert.equal(f.value(), 'parking-without-drape'); assert.equal(props.parent, f.scene);
        assert.equal(f.runtime.greeneryGroup, props); assert.equal(old.parent, null);
    } finally { f.close(); }
});
test('a stale decor candidate cannot replace either visible geometry or paint', () => {
    const f = fixture();
    try {
        const old = f.group(); f.runtime.publishGreeneryGroup(old);
        const next = f.group();
        const result = f.runtime.publishGreeneryGroup(next, { paint: f.paint('stale'), isCurrent: () => false });
        assert.notEqual(result.status, 'published'); assert.equal(f.value(), 'old');
        assert.equal(f.runtime.greeneryGroup, old); assert.equal(old.parent, f.scene); assert.equal(f.finalized(), 0);
    } finally { f.close(); }
});
