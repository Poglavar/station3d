// Exercise the actual building/atlas handoff with real Three geometry. A warm
// slot must avoid source allocation without changing UVs, ownership or repair.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from 'three';
import { createOwnedResourceCache, createMeshResourceBindings } from '../core/owned-resource-cache.js';
import { createFacadeAtlasLayout, remapFacadeAtlasUvs } from '../core/facade-atlas-layout.js';
import { createCooperativeBuildTask } from '../core/cooperative-build-task.js';
import { disposeGroup, registerShared, unregisterShared } from '../core/dispose.js';

const source = readFileSync(new URL('../world/buildings.js', import.meta.url), 'utf8');
function load(context, names) {
    for (const name of names) {
        const plain = source.indexOf(`function ${name}(`);
        const start = plain >= 0 ? plain : source.indexOf(`function* ${name}(`);
        assert.ok(start >= 0, `Missing production function ${name}`);
        vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), context);
    }
}
function world() {
    const sources = createOwnedResourceCache({ maxIdleBytes: 0 });
    const pages = createOwnedResourceCache({ maxIdleBytes: 0 });
    const allocations = [];
    const context = vm.createContext({
        THREE, facadeResources: sources, facadeAtlasResources: pages,
        facadeOverlayBindings: new WeakMap(), facadeAtlasGroups: new Map(),
        facadeAtlasStats: { sourceReuses: 0 },
        overtureTileScope: key => String(key ?? 'radius'), overtureRegionForScope: () => 'region',
        architecturalLocationId: () => 'zagreb', getFacadeStyleIndex: id => id % 2,
        remapFacadeAtlasUvs, passageBaseMaterialByMesh: new WeakMap(),
        buildingsGroup: new THREE.Group(), tileVisualReplacements: new Map(),
        buildingEntityMetadata: () => ({ key: 'building' }),
        isShared: () => false, overtureMaterialExcluded: () => false,
        overtureColorFamilyFor: () => null, overtureMaterialIds: new WeakMap(), nextOvertureMaterialId: 0,
        boundsOfPositions: () => ({ minX: 0, maxX: 1, minZ: 0, maxZ: 1 }),
        publishBuildingAggregatePart: record => context.records.push(record), records: [],
        facadeAtlasPart() { throw Error('A prebound atlas must not be atlased again'); },
    });
    context.getFacadeOverlayMaterial = (objectId, floors, bays, mask, shops, glass, descriptor) => {
        assert.ok(descriptor, 'materialization keeps the captured style identity');
        descriptor = context.facadeOverlayDescriptor(objectId, floors, bays, mask, shops, glass, descriptor);
        return sources.getOrCreate(descriptor.key, () => {
            allocations.push({ objectId, floors, bays, mask, shops, glass, descriptor });
            const value = new THREE.MeshStandardMaterial({ map: new THREE.Texture({ width: 32, height: 48 }) });
            value.userData.facadeSourceKey = descriptor.key;
            registerShared(value);
            return { value, cpuBytes: 64, gpuBytes: 86, dispose() { unregisterShared(value); value.map.dispose(); value.dispose(); } };
        });
    };
    load(context, ['facadeOverlayDescriptor', 'getFacadeOverlayBinding', 'rememberFacadeOverlayBinding',
        'restoreFacadeOverlaySource', 'retainBuildingFacadeMaterial', 'captureBuildingMeshesForBatching']);
    const bind = createMeshResourceBindings({ retain: context.retainBuildingFacadeMaterial });
    context.setPassageAwareMaterial = (mesh, material) => {
        bind(mesh, material); context.passageBaseMaterialByMesh.set(mesh, material); mesh.material = material;
    };
    const descriptor = (...args) => context.facadeOverlayDescriptor(...args);
    function atlas(d, { failed = false, disposed = false, region = 'region' } = {}) {
        const family = d.glass ? 'glass' : 'punched';
        const layout = createFacadeAtlasLayout({ pageSize: 64, padding: 2, maxEntrySize: 24 });
        const slot = layout.allocate(d.key, 32, 48);
        const material = pages.getOrCreate(region + family + d.key, () => {
            const value = new THREE.MeshStandardMaterial(); registerShared(value);
            return { value, cpuBytes: 16384, gpuBytes: 21846, dispose() { unregisterShared(value); value.dispose(); } };
        });
        const page = { material, paintFailed: failed, disposed };
        context.facadeAtlasGroups.set(region + '|' + family, { layout, pages: [page] });
        return { page, slot, material };
    }
    function mesh(d, tile = 'tile') {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
        const uv = geometry.attributes.uv.array;
        const binding = context.getFacadeOverlayBinding(d, tile);
        const value = new THREE.Mesh(geometry, binding.material);
        value.userData.facadeWindowOverlay = true;
        value.userData.overlayRepaint = { objectId: d.objectId, segments: [{ floors: d.floors, bays: d.bays }] };
        context.setPassageAwareMaterial(value, binding.material);
        context.rememberFacadeOverlayBinding(value, binding);
        return { value, binding, uv };
    }
    return { context, sources, pages, allocations, descriptor, atlas, mesh };
}

test('semantic descriptors preserve all pixel identity fields without creating materials', () => {
    const w = world(), a = w.descriptor(1, 4, 6, '101', true, false);
    assert.equal(a.key, '_facadeOverlay_s1_zagreb_4f_6b_101_shops');
    assert.equal(w.descriptor(3, 4, 6, '101', true, false).key, a.key, 'building IDs sharing style share pixels');
    const variants = [w.descriptor(2, 4, 6, '101', true, false), w.descriptor(1, 3, 6, '101', true, false),
        w.descriptor(1, 4, 5, '101', true, false), w.descriptor(1, 4, 6, '111', true, false),
        w.descriptor(1, 4, 6, '101', false, false), w.descriptor(1, 4, 6, '101', true, true)];
    w.context.architecturalLocationId = () => 'split';
    variants.push(w.descriptor(1, 4, 6, '101', true, false));
    assert.equal(new Set([a, ...variants].map(d => d.key)).size, 8);
    assert.equal(w.allocations.length, 0);
});

for (const glass of [false, true]) {
    test(`a live ${glass ? 'glass' : 'punched'} atlas hit owns its page with zero source allocation`, () => {
        const w = world(), d = w.descriptor(1, 4, 6, null, true, glass), a = w.atlas(d);
        const m = w.mesh(d);
        assert.equal(m.value.material, a.material);
        assert.deepEqual(m.value.geometry.attributes.uv.array, remapFacadeAtlasUvs(m.uv, a.slot));
        assert.deepEqual([...m.uv], [0, 0, 1, 0, 0, 1]);
        assert.equal(w.allocations.length, 0);
        assert.equal(w.sources.snapshot().entries, 0);
        assert.deepEqual(w.pages.snapshot().owners, { mesh: 1 });
        assert.equal(w.pages.trim(), 0, 'detached construction pins an existing page');
        assert.equal(w.context.facadeAtlasStats.sourceReuses, 1);
        m.value.geometry.dispose(); m.value.geometry.dispose();
        assert.equal(w.pages.snapshot().references, 0);
        assert.equal(w.pages.trim(), 1);
    });
}

for (const reason of ['missing', 'different region', 'different mask', 'failed', 'disposed']) {
    test(`a ${reason} atlas slot materializes the ordinary source instead`, () => {
        const w = world(), d = w.descriptor(1, 4, 6);
        if (reason !== 'missing') w.atlas(reason === 'different mask' ? w.descriptor(1, 4, 6, '10') : d,
            { region: reason === 'different region' ? 'elsewhere' : 'region', failed: reason === 'failed', disposed: reason === 'disposed' });
        const a = w.mesh(d), b = w.mesh(d);
        assert.equal(w.allocations.length, 1, 'identical misses still share the ordinary source');
        assert.equal(a.value.material, b.value.material);
        assert.equal(a.value.geometry.attributes.uv.array, a.uv);
        assert.equal(w.sources.snapshot().references, 2);
        a.value.geometry.dispose(); b.value.geometry.dispose();
        assert.equal(w.sources.trim(), 1);
    });
}

test('capture transfers a warm page directly while preserving source UVs and metadata for repair/close detail', () => {
    const w = world(), d = w.descriptor(1, 4, 6), a = w.atlas(d), m = w.mesh(d);
    const atlasUvs = m.value.geometry.attributes.uv.array;
    m.value.position.y = 8;
    w.context.buildingsGroup.add(m.value);
    const replacement = { stagedAggregateParts: [] };
    w.context.tileVisualReplacements.set('tile', replacement);
    w.context.captureBuildingMeshesForBatching({}, 'tile', 0);
    const record = replacement.stagedAggregateParts[0];
    assert.equal(record.descriptor.material, a.material);
    assert.equal(record.part.attributes.uv, atlasUvs, 'never double-remap an existing atlas');
    assert.equal(record.overlayRecord.uv, m.uv);
    assert.equal(record.overlayRecord.facadeSource, d);
    assert.equal(record.part.attributes.position[1], 8, 'foundation translated exactly once');
    assert.equal(w.allocations.length, 0);
    assert.deepEqual(w.pages.snapshot().owners, { 'staged-part': 1 });
    record.releaseFacadeMaterial();
    assert.equal(w.pages.trim(), 1, 'cancelling a staged replacement releases its warm page');
});

test('a page failing between detached binding and capture cannot acquire another aggregate borrower', () => {
    const w = world(), d = w.descriptor(1, 4, 6), a = w.atlas(d), m = w.mesh(d);
    a.page.paintFailed = true;
    load(w.context, ['facadeAtlasFamily', 'facadeAtlasPart']);
    w.context.buildingsGroup.add(m.value);
    w.context.captureBuildingMeshesForBatching({}, 'tile', 0);
    const record = w.context.records[0];
    assert.notEqual(record.descriptor.material, a.material);
    assert.equal(record.part.attributes.uv, m.uv);
    assert.equal(w.allocations.length, 1);
    assert.equal(w.pages.snapshot().references, 0);
    assert.equal(w.sources.snapshot().references, 1);
    record.releaseFacadeMaterial(); w.sources.clear(); w.pages.clear();
});

test('capturing in a different region recreates a source before looking up that region', () => {
    const w = world(), d = w.descriptor(1, 4, 6), a = w.atlas(d), m = w.mesh(d);
    w.context.overtureRegionForScope = () => 'other';
    let lookups = 0;
    w.context.facadeAtlasPart = (_mesh, base, region, uv) => {
        assert.notEqual(base, a.material); assert.equal(region, 'other'); assert.equal(uv, m.uv);
        lookups++; return null;
    };
    w.context.buildingsGroup.add(m.value);
    w.context.captureBuildingMeshesForBatching({}, 'tile', 0);
    assert.equal(lookups, 1);
    assert.equal(w.allocations.length, 1);
    assert.equal(w.pages.snapshot().references, 0);
    w.context.records[0].releaseFacadeMaterial(); w.sources.clear(); w.pages.clear();
});

for (const reason of ['rotated', 'excluded']) {
    test(`a ${reason} standalone overlay restores its source and UVs before any translation bake`, () => {
        const w = world(), d = w.descriptor(1, 4, 6), a = w.atlas(d), m = w.mesh(d);
        m.value.position.y = 8;
        if (reason === 'rotated') m.value.rotation.y = 0.4;
        else w.context.overtureMaterialExcluded = () => true;
        w.context.buildingsGroup.add(m.value);
        w.context.architecturalLocationId = () => 'split';
        w.context.captureBuildingMeshesForBatching({}, 'tile', 0);
        assert.equal(w.context.buildingsGroup.children[0], m.value);
        assert.equal(m.value.geometry.attributes.position.array[1], 0);
        assert.equal(m.value.geometry.attributes.uv.array, m.uv);
        assert.notEqual(m.value.material, a.material);
        assert.equal(w.allocations.length, 1);
        assert.equal(w.allocations[0].descriptor.architectureId, 'zagreb');
        assert.equal(w.pages.snapshot().references, 0);
        assert.equal(w.sources.snapshot().references, 1);
        m.value.geometry.dispose();
        assert.equal(w.sources.trim(), 1);
    });
}

test('the Overture builder uses the lazy binding before requesting any ordinary source', () => {
    const w = world(), d = w.descriptor(1, 4, 6, null, false), a = w.atlas(d);
    Object.assign(w.context, {
        buildOvertureFacadeBatches: () => [{ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], uvs: [0, 0, 1, 0, 0, 1], bays: 6, courtyard: true }],
        floorsForHeight: () => 4, terrainReference: null, showOpenings: true,
        FACADE_MIN_FACE_W_M: 1, FACADE_BAY_M: 3,
    });
    load(w.context, ['addOvertureFacadeMeshes']);
    w.context.addOvertureFacadeMeshes({ coordinates: [[]] }, 12, 1, 0, 0, 'tile');
    assert.equal(w.allocations.length, 0);
    assert.equal(w.context.buildingsGroup.children[0].material, a.material);
    assert.equal(w.context.facadeOverlayBindings.get(w.context.buildingsGroup.children[0]).source.key, d.key);
});

test('late passage repair unmerges original UVs into an ordinary source, then applies the new mask', () => {
    const w = world(), d = w.descriptor(1, 4, 6, '111', true, false), a = w.atlas(d), m = w.mesh(d);
    m.value.userData.overlayRepaint.segments = [{ floors: 4, bays: 6, storefronts: true,
        glassTower: false, surface: {}, vertexStart: 0, vertexCount: 3 }];
    w.context.buildingsGroup.add(m.value);
    w.context.captureBuildingMeshesForBatching({}, 'tile', 0);
    const record = w.context.records[0].overlayRecord;
    Object.assign(w.context, {
        removeCloseFacadeDetail() {}, overlayOwnersByKey: new Map(),
        overtureBatcher: { removeOwner: () => true }, queueOvertureBucket() {},
        overtureBucketDescriptors: new Map([[record.bucketKey, { material: a.material }]]),
        getFacadeOpeningMask: () => '101',
    });
    load(w.context, ['createOverlayOwnerMesh', 'repaintOverlayMeshForPassages']);
    const standalone = w.context.createOverlayOwnerMesh(record);
    w.context.buildingsGroup.add(standalone);
    assert.notEqual(standalone.material, a.material, '0..1 UVs never bind an atlas page');
    assert.deepEqual(standalone.geometry.attributes.uv.array, m.uv);
    assert.equal(standalone.userData.overlayRepaint.facadeSource, d);
    w.context.architecturalLocationId = () => 'split';
    const staged = new THREE.Group();
    const repaint = w.context.repaintOverlayMeshForPassages(standalone, staged);
    for (let step = repaint.next(); !step.done; step = repaint.next()) {}
    assert.equal(w.context.buildingsGroup.children.length, 1, 'source remains published while replacement is staged');
    assert.equal(staged.children.length, 1);
    const repaired = staged.children[0];
    assert.deepEqual(repaired.geometry.attributes.uv.array, m.uv);
    assert.equal(w.allocations.at(-1).mask, '101');
    assert.equal(w.allocations.at(-1).descriptor.architectureId, 'zagreb');
    assert.equal(w.sources.snapshot().references, 2, 'staged replacement retains its source until publication');
    repaired.geometry.dispose(); standalone.geometry.dispose();
    w.context.records[0].releaseFacadeMaterial();
    assert.equal(w.sources.snapshot().references, 0);
    w.sources.clear(); w.pages.clear();
});

// Exercise production preparation and publication with controlled GPU completion.
// Geometry and material ownership stay real; no browser or timing sleeps are used.
function passageReplacementWorld({ merged = false, mask = '101' } = {}) {
    const w = world(), d = w.descriptor(1, 4, 6, '111', true, false), m = w.mesh(d);
    m.value.userData.tileKey = 'tile';
    m.value.userData.overlayRepaint.facadeSource = d;
    m.value.userData.overlayRepaint.segments = [{ floors: 4, bays: 6, storefronts: true,
        glassTower: false, surface: {}, vertexStart: 0, vertexCount: 3 }];
    w.context.buildingsGroup.add(m.value);
    const warmups = [], queued = [], variants = new Map();
    let removed = 0, uploaded = 0, resweeps = 0;
    Object.assign(w.context, {
        buildingsSessionToken: 1, passageCutVolumesRevision: 1,
        overlayOwnersByKey: new Map(), overtureScopeOwners: new Map(),
        overtureBucketDescriptors: new Map(), overtureAggregates: new Map(),
        overlayRepaintWarmups: new Set(), pendingOverlayReplacements: new Map(),
        surfacePublications: null,
        renderer: {}, camera: new THREE.PerspectiveCamera(), scene: new THREE.Scene(),
        getFacadeOpeningMask: () => mask, architecturalLocationId: () => 'split',
        facadeAtlasPart: () => null,
        getPassageMaterialVariant(material) {
            if (!variants.has(material)) variants.set(material, material.clone());
            return variants.get(material);
        },
        createQueuedShaderWarmup(root) {
            const state = { ready: false, error: null, closed: false, root, disposals: 0,
                dispose() { if (!state.closed) { state.closed = true; state.disposals++; } } };
            warmups.push(state); return state;
        },
        prewarmDetachedObject: function* () { yield { phase: 'upload', deferFrame: true }; uploaded++; },
        overtureBatcher: { removeOwner() { removed++; return true; } },
        queueOvertureBucket: key => queued.push(key),
        removeCloseFacadeDetail() {},
        scheduleOverlayPassageRepaint() { resweeps++; },
        forgetEmptyOvertureBucket: key => w.context.overtureAggregates.delete(key),
        disposeOvertureAggregateMesh(mesh) { mesh.parent?.remove(mesh); mesh.geometry.dispose(); },
    });
    load(w.context, ['createOverlayOwnerMesh', 'disposeOverlayStagedRoot', 'repaintOverlayMeshForPassages',
        'prepareOverlayPassageReplacement', 'publishPendingOverlayReplacements', 'clearOvertureAggregate']);
    let record = null, old = m.value;
    if (merged) {
        w.context.captureBuildingMeshesForBatching({}, 'tile', 0);
        const part = w.context.records[0]; record = part.overlayRecord;
        old = new THREE.Mesh(new THREE.BufferGeometry(), part.descriptor.material);
        w.context.buildingsGroup.add(old);
        w.context.overtureAggregates.set(record.bucketKey, { mesh: old });
        w.context.overtureBucketDescriptors.set(record.bucketKey, part.descriptor);
        w.context.overlayOwnersByKey.set(`${record.ownerKey}#${record.bucketKey}`, record);
        w.context.overtureScopeOwners.set(record.scope, new Set([record.ownerKey]));
    }
    const run = { session: 1, group: w.context.buildingsGroup, revision: 1 };
    const task = w.context.prepareOverlayPassageReplacement(merged ? { record } : { mesh: old }, run);
    const cleanup = () => {
        task.return();
        for (const pending of w.context.pendingOverlayReplacements.values()) {
            for (const entry of pending.values()) w.context.disposeOverlayStagedRoot(entry.staged);
        }
        w.context.buildingsGroup.traverse(o => o.geometry?.dispose?.());
        for (const part of w.context.records) part.releaseFacadeMaterial();
        for (const material of variants.values()) material.dispose();
        assert.equal(w.sources.snapshot().references, 0, 'all source leases return');
        assert.equal(w.pages.snapshot().references, 0, 'all atlas leases return');
        w.sources.clear(); w.pages.clear();
    };
    return { ...w, task, old, record, warmups, queued, cleanup, run,
        get removed() { return removed; }, get uploaded() { return uploaded; },
        get resweeps() { return resweeps; } };
}

function advanceReplacement(task, phase = null) {
    for (let i = 0; i < 64; i++) {
        const next = task.next();
        if (next.done || next.value?.phase === phase) return next;
    }
    assert.fail(`replacement did not reach ${phase || 'completion'}`);
}

test('standalone repair preserves visibility and transforms until shader and upload readiness', () => {
    const w = passageReplacementWorld();
    w.old.position.set(10, 3, -8); w.old.rotation.y = 0.4; w.old.scale.set(2, 1, 2);
    w.old.renderOrder = 4;
    assert.equal(advanceReplacement(w.task, 'shader-wait').value.phase, 'shader-wait');
    assert.equal(w.old.parent, w.context.buildingsGroup);
    assert.equal(w.sources.snapshot().references, 2, 'old and staged pixels remain owned');
    assert.equal(w.warmups[0].root.children.length, 2, 'base and passage variants are prepared');
    w.warmups[0].ready = true;
    advanceReplacement(w.task, 'upload');
    assert.equal(w.old.parent, w.context.buildingsGroup, 'linking alone cannot publish');
    assert.equal(advanceReplacement(w.task).done, true);
    assert.equal(w.uploaded, 1);
    assert.equal(w.old.parent, null);
    assert.equal(w.context.buildingsGroup.children.length, 1);
    const replacement = w.context.buildingsGroup.children[0];
    assert.deepEqual(replacement.position.toArray(), w.old.position.toArray());
    assert.deepEqual(replacement.quaternion.toArray(), w.old.quaternion.toArray());
    assert.deepEqual(replacement.scale.toArray(), w.old.scale.toArray());
    assert.equal(replacement.renderOrder, 4);
    assert.equal(replacement.userData.tileKey, 'tile');
    assert.equal(replacement.userData.objectId, 1);
    assert.equal(w.sources.snapshot().references, 1);
    assert.equal(w.warmups[0].disposals, 0, 'prepared programs survive the first visible draw');
    w.cleanup();
    assert.equal(w.warmups[0].disposals, 1);
});

test('merged repair waits for GPU readiness, then swaps with the actual empty-bucket publication', () => {
    const w = passageReplacementWorld({ merged: true });
    advanceReplacement(w.task, 'shader-wait');
    assert.equal(w.removed, 0);
    assert.equal(w.old.parent, w.context.buildingsGroup);
    w.warmups[0].ready = true;
    advanceReplacement(w.task);
    assert.equal(w.removed, 1);
    assert.deepEqual(w.queued, [w.record.bucketKey]);
    assert.equal(w.context.buildingsGroup.children[0], w.old, 'old aggregate still owns the visible pixels');
    assert.equal(w.context.buildingsGroup.children.length, 1);
    w.context.clearOvertureAggregate(w.record.bucketKey, 2);
    assert.equal(w.old.parent, null);
    assert.equal(w.context.buildingsGroup.children.length, 1);
    assert.equal(w.context.buildingsGroup.children[0].userData.tileKey, 'tile');
    assert.equal(w.context.pendingOverlayReplacements.size, 0);
    w.cleanup();
});

for (const interruption of ['revision', 'cancel', 'shader failure']) {
    test(`${interruption} during preparation retains the old aggregate and releases the candidate`, () => {
        const w = passageReplacementWorld({ merged: true });
        advanceReplacement(w.task, 'shader-wait');
        if (interruption === 'cancel') w.task.return();
        else if (interruption === 'revision') {
            w.context.passageCutVolumesRevision++;
            assert.equal(advanceReplacement(w.task).done, true);
        } else {
            w.warmups[0].error = Error('shader failed');
            assert.throws(() => w.task.next(), /shader failed/);
        }
        assert.equal(w.old.parent, w.context.buildingsGroup);
        assert.equal(w.context.buildingsGroup.children.length, 1);
        assert.equal(w.removed, 0);
        assert.equal(w.context.pendingOverlayReplacements.size, 0);
        assert.equal(w.sources.snapshot().references, 1, 'only the old aggregate part remains owned');
        assert.equal(w.warmups[0].disposals, 1);
        w.cleanup();
    });
}

test('a tile evicted after preparation cannot reappear at aggregate publication', () => {
    const w = passageReplacementWorld({ merged: true });
    advanceReplacement(w.task, 'shader-wait'); w.warmups[0].ready = true;
    advanceReplacement(w.task);
    w.context.overtureScopeOwners.delete(w.record.scope);
    w.context.overlayOwnersByKey.clear();
    w.context.clearOvertureAggregate(w.record.bucketKey, 2);
    assert.equal(w.context.buildingsGroup.children.length, 0);
    assert.equal(w.context.pendingOverlayReplacements.size, 0);
    assert.equal(w.warmups[0].disposals, 1);
    w.cleanup();
});

test('an unchanged opening mask leaves the aggregate intact without shader or upload work', () => {
    const w = passageReplacementWorld({ merged: true, mask: '111' });
    assert.equal(advanceReplacement(w.task).done, true);
    assert.equal(w.removed, 0); assert.equal(w.uploaded, 0); assert.equal(w.warmups.length, 0);
    assert.equal(w.context.buildingsGroup.children[0], w.old);
    w.cleanup();
});

test('materializing a captured source keeps its original architecture in both maps and disposal keys', () => {
    const w = world(), d = w.descriptor(1, 4, 6);
    const requested = [], deleted = [];
    Object.assign(w.context, {
        getFacadeTexture(...args) { requested.push(args); return new THREE.Texture({ width: 8, height: 8 }); },
        getFacadeEmissiveTexture(...args) { requested.push(args); return new THREE.Texture({ width: 8, height: 8 }); },
        facadeTextureKey(...args) { requested.push(args); return 'texture-key'; },
        WALL_ENV_MAP_INTENSITY: 0.3, registerShared() {}, unregisterShared() {}, disposePassageMaterialVariant() {},
        windowEmissiveMapByMaterial: new WeakMap(), buildingMaterials: {},
        applyNightModeToMaterial(material) { material.emissiveMap = null; },
        _facadeTextures: { delete: key => deleted.push(key) },
        _facadeEmissiveTextures: { delete: key => deleted.push(key) },
        architecturalLocationId: () => 'split',
    });
    load(w.context, ['getFacadeOverlayMaterial']);
    const material = w.context.getFacadeOverlayMaterial(1, 4, 6, null, true, false, d);
    assert.equal(material.userData.facadeSourceKey, d.key);
    assert.ok(requested.every(args => args[6] === 'zagreb'));
    assert.equal(w.sources.snapshot().estimatedCanvasBytes, 512, 'both diffuse and day-unbound emissive remain accounted');
    w.sources.clear();
    assert.deepEqual(deleted, ['texture-key', 'texture-key']);
});

for (const warm of [false, true]) for (const outcome of ['cancel', 'failure', 'publish']) {
    test(`GDI ${warm ? 'warm atlas' : 'source miss'} geometry owns its material through ${outcome}`, () => {
        const w = world(), d = w.descriptor(1, 4, 6);
        if (warm) w.atlas(d);
        Object.assign(w.context, {
            disposeGroup, createCooperativeBuildTask,
            createTransactionalBuildContext: () => ({}), featureCentroidLatLon: () => null,
            reservedBuildingIds: new Map(), loadedBuildingIds: new Set(),
            isBlockedBuildingObjectId: () => false, isFeatureMaskedByProposalBuildings: () => false,
            anchorLat: 0, anchorLon: 0, terrainReference: null,
            noteBuildingBuildPhase() {}, noteBuildingGroundCoverage() {}, mergeTransactionalBuildContext() {},
            captureBuildingMeshesForBatching() {}, hideTileReplacementChildren() {}, recordTileBuilding() {}, registerBuildingEntityTree() {},
            stageBuildingFeatureGdi: function* (_feature, _lat, _lon, tileKey, _context, transaction) {
                yield { phase: 'facade-triangles' };
                yield* w.context.addGdiFacadeOverlayMeshes(new Map([[d.key, { facadeSource: d,
                    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], uv: [0, 0, 1, 0, 0, 1], segments: [],
                }]]), tileKey, 1, (positions, material, uvs) => {
                    const geometry = new THREE.BufferGeometry();
                    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
                    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
                    const mesh = new THREE.Mesh(geometry, material);
                    w.context.setPassageAwareMaterial(mesh, material);
                    transaction.group.add(mesh); return mesh;
                });
                if (outcome === 'failure') throw Error('geometry failed');
                return 1;
            },
        });
        load(w.context, ['addGdiFacadeOverlayMeshes', 'createGdiBuildingBuildTask']);
        const task = w.context.createGdiBuildingBuildTask({ properties: { object_id: 1 }, geometry: { type: 'MultiPolygon' } }, 'tile');
        task.step();
        assert.equal(w.allocations.length, 0, 'geometry-only preparation does not paint a source');
        task.step();
        const cache = warm ? w.pages : w.sources;
        assert.equal(cache.snapshot().references, 1);
        assert.equal(cache.trim(), 0);
        assert.equal(w.allocations.length, warm ? 0 : 1);
        if (outcome === 'cancel') { task.cancel(); task.cancel(); }
        else if (outcome === 'failure') assert.throws(() => task.step(), /geometry failed/);
        else {
            task.step(); assert.equal(task.step().result, 1);
            assert.equal(cache.snapshot().references, 1, 'published geometry still owns its pixels');
            disposeGroup(w.context.buildingsGroup);
        }
        assert.equal(w.context.reservedBuildingIds.size, 0);
        assert.equal(cache.snapshot().references, 0);
        assert.equal(cache.trim(), 1);
    });
}
