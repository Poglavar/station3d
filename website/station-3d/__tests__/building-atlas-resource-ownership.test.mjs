// Characterize the real atlas/capture/publication orchestration with real Three
// geometries. Only canvas/GPU I/O and the unrelated world systems are replaced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from 'three';
import { createOwnedResourceCache, createMeshResourceBindings } from '../core/owned-resource-cache.js';
import { createFacadeAtlasLayout, remapFacadeAtlasUvs } from '../core/facade-atlas-layout.js';
import { createGeometryBatcher } from '../core/geometry-batch.js';

const source = readFileSync(new URL('../world/buildings.js', import.meta.url), 'utf8');
function world({ failUpload = false } = {}) {
    const facadeResources = createOwnedResourceCache({ maxIdleBytes: 0 });
    const facadeAtlasResources = createOwnedResourceCache({ maxIdleBytes: 0 });
    const context = vm.createContext({
        THREE, facadeResources, facadeAtlasResources, createFacadeAtlasLayout, remapFacadeAtlasUvs,
        FACADE_ATLAS_PAGE_SIZE: 16, FACADE_ATLAS_PADDING: 1,
        buildingQualityProfile: { buildings: { facadeAtlasMaxEntrySize: 14 } },
        facadeAtlasGroups: new Map(), facadeAtlasMaterials: new Set(), facadeAtlasPageByMaterial: new WeakMap(),
        facadeAtlasStats: {
            entries: 0, pagesCreated: 0, pagesDisposed: 0, pageUpdates: 0, sourcePixels: 0, atlasEntryPixels: 0,
            retiredEntries: 0, retiredContentTexels: 0, retiredReservedTexels: 0, retiredCapacityTexels: 0,
        },
        facadeAtlasPaintPages: [], facadeAtlasPaintJob: null, buildingNowMs: () => 0,
        FRAME_CHUNK_REPEAT_ITEM: Symbol('repeat'),
        document: { createElement: () => ({ getContext: () => ({}) }) },
        makeFacadeTexture: canvas => new THREE.Texture(canvas),
        registerShared() {}, unregisterShared() {}, applyNightModeToMaterial() {},
        disposePassageMaterialVariant() {}, paintFacadeAtlasGutter() {},
        renderer: { initTexture() { if (failUpload) throw Error('upload failed'); } },
        facadeAtlasPaintQueue: {
            enqueue(items, step, callbacks) { return { items, step, callbacks }; },
            clear() { context.facadeAtlasPaintJob?.callbacks.onCancel(); },
        },
        buildingsGroup: new THREE.Group(), tileVisualReplacements: new Map(),
        overtureBatcher: createGeometryBatcher(), overtureScopeOwners: new Map(),
        overtureBucketDescriptors: new Map(), overtureTileBuckets: new Map(), overtureDirtyTiles: new Set(),
        overtureAggregates: new Map(), overtureAggregateEntityUnregister: new WeakMap(),
        overlayOwnersByKey: new Map(), overtureMaterialIds: new WeakMap(), nextOvertureMaterialId: 0,
        overtureTileScope: key => key, overtureRegionForScope: () => '0_0',
        buildingEntityMetadata: feature => ({ key: feature.key }),
        passageBaseMaterialByMesh: new WeakMap(), facadeOverlayBindings: new WeakMap(), overtureMaterialExcluded: () => false,
        overtureColorFamilyFor: () => null, isShared: () => false,
        markSurfaceClaim() {}, applySurfaceStencil() {}, applyGroundOwnership() {},
        BUILDING_MATERIAL_CLAIM: {}, SURFACE_CLASS: {}, SURFACE_COVERAGE_STATE: {}, SURFACE_VERTICAL_RELATION: {},
        meshNeedsPassageMaterial: () => false,
    });
    for (const name of [
        'retainBuildingFacadeMaterial', 'setPassageAwareMaterial', 'restoreFacadeOverlaySource', 'facadeAtlasFamily', 'facadeAtlasPart',
        'createFacadeAtlasPage', 'disposeFacadeAtlasPage', 'disposeFacadeAtlases',
        'getFacadeAtlasOccupancySnapshot',
        'queueFacadeAtlasPaint', 'ensureFacadeAtlasPaintQueue', 'advanceFacadeAtlasPaintPage',
        'clearFacadeAtlasSourcePaints', 'clearFacadeAtlasPaintQueue',
        'captureBuildingMeshesForBatching', 'publishBuildingAggregatePart',
        'releaseTileReplacementResources', 'clearTileVisualReplacements',
        'forgetEmptyOvertureBucket', 'disposeOvertureAggregateMesh',
    ]) {
        const start = source.indexOf(`function ${name}(`);
        assert.ok(start >= 0, `Missing production function ${name}`);
        vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), context);
    }
    context.bindFacadeMeshResource = createMeshResourceBindings({ retain: context.retainBuildingFacadeMaterial });

    function capture(key, tile = key) {
        const material = facadeResources.getOrCreate(key, () => {
            const value = new THREE.MeshStandardMaterial({ map: new THREE.Texture({ width: 14, height: 14 }) });
            value.userData.facadeSourceKey = key;
            return { value, cpuBytes: 784, gpuBytes: 1046, dispose() { value.map.dispose(); value.dispose(); } };
        });
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData.facadeWindowOverlay = true;
        context.setPassageAwareMaterial(mesh, material);
        const start = context.buildingsGroup.children.length;
        context.buildingsGroup.add(mesh);
        const replacement = { stagedAggregateParts: [] };
        context.tileVisualReplacements.set(tile, replacement);
        context.captureBuildingMeshesForBatching({ key }, tile, start);
        assert.equal(context.buildingsGroup.children.length, start, 'the source mesh was merged');
        const record = replacement.stagedAggregateParts[0];
        return { record, replacement, page: context.facadeAtlasPageByMaterial.get(record.descriptor.material) };
    }
    function finishPaints() {
        const job = context.facadeAtlasPaintJob;
        for (const page of job?.items || []) job.step(page);
        job?.callbacks.onComplete();
    }
    function publish(record) {
        context.publishBuildingAggregatePart(record);
        const mesh = new THREE.Mesh(new THREE.BufferGeometry(), record.descriptor.material);
        context.setPassageAwareMaterial(mesh, record.descriptor.material);
        context.overtureAggregates.set(record.bucketKey, { mesh });
        return mesh;
    }
    return { context, cache: facadeAtlasResources, sources: facadeResources, capture, publish, finishPaints };
}

test('an unused page retires within a live region without changing its neighbours', () => {
    const w = world();
    const first = w.capture('departing');
    const second = w.capture('staying');
    const group = w.context.facadeAtlasGroups.get('0_0|punched');
    const liveSlot = group.layout.get('staying');
    const liveUvs = second.record.part.attributes.uv.slice();
    assert.deepEqual(w.cache.snapshot().owners, { paint: 2, 'staged-part': 2 });
    const initialOccupancy = w.context.getFacadeAtlasOccupancySnapshot({ includePages: true });
    assert.equal(initialOccupancy.activePages, 2);
    assert.equal(initialOccupancy.allocatedEntries, 2);
    assert.equal(initialOccupancy.allocatedContentTexels, 392);
    assert.equal(initialOccupancy.reservedTexels, 512);
    assert.equal(initialOccupancy.unallocatedTexels, 0);
    assert.ok(initialOccupancy.pageDetails.every(page => page.resourcePresent));
    assert.ok(initialOccupancy.pageDetails.every(page => page.owners.paint === 1 && page.owners['staged-part'] === 1));
    assert.equal(w.cache.trim(), 0);
    w.finishPaints();
    const oldMesh = w.publish(first.record);
    const liveMesh = w.publish(second.record);
    let disposedTexture = 0;
    first.page.texture.addEventListener('dispose', () => disposedTexture++);
    w.context.forgetEmptyOvertureBucket(first.record.bucketKey); // publication commits before old geometry retires
    assert.equal(w.cache.trim(), 0, 'the old visible mesh must still pin its page');
    w.context.disposeOvertureAggregateMesh(oldMesh);
    assert.equal(w.cache.trim(1), 1);
    assert.equal(disposedTexture, 1);
    assert.equal(first.page.canvas.width, 0);
    assert.equal(first.page.texture.image, null);
    assert.equal(group.layout.get('departing'), null);
    assert.equal(group.layout.get('staying'), liveSlot);
    assert.deepEqual(second.record.part.attributes.uv, liveUvs);
    assert.equal(second.page.disposed, false);
    assert.equal(w.context.facadeAtlasGroups.size, 1, 'the neighbouring page/region stays live');
    assert.equal(w.cache.snapshot().entries, 1);
    const remainingOccupancy = w.context.getFacadeAtlasOccupancySnapshot({ includePages: true });
    assert.equal(remainingOccupancy.activePages, 1);
    assert.equal(remainingOccupancy.allocatedEntries, 1);
    assert.equal(remainingOccupancy.pageDetails[0].references, 2);
    assert.equal(remainingOccupancy.pageDetails[0].owners.mesh, 1);
    assert.equal(remainingOccupancy.pageDetails[0].owners.bucket, 1);
    assert.equal(w.context.facadeAtlasStats.retiredEntries, 1);
    assert.equal(w.context.facadeAtlasStats.retiredCapacityTexels, 256);

    const revisit = w.capture('departing', 'return');
    assert.notEqual(revisit.page.material, first.page.material);
    assert.equal(group.layout.get('departing').pageIndex, 0, 'recycle the retired page number');
    assert.equal(group.pages.length, 2, 'no historical page-array growth');
    assert.equal(group.layout.get('staying'), liveSlot);
    w.context.releaseTileReplacementResources(revisit.replacement);
    assert.equal(w.cache.trim(), 0, 'a cancelled part must not dispose a queued paint');
    w.finishPaints();
    assert.equal(w.cache.trim(), 1);
    w.context.forgetEmptyOvertureBucket(second.record.bucketKey);
    w.context.disposeOvertureAggregateMesh(liveMesh);
    w.context.disposeFacadeAtlases();
    assert.equal(w.context.facadeAtlasGroups.size, 0);
    assert.equal(w.cache.snapshot().estimatedBytes, 0);
    assert.equal(w.cache.snapshot().references, 0);
    const emptyOccupancy = w.context.getFacadeAtlasOccupancySnapshot({ includePages: true });
    assert.equal(emptyOccupancy.allocatedEntries, 0);
    assert.equal(emptyOccupancy.allocatedContentTexels, 0);
    assert.equal(emptyOccupancy.activePages, 0);
    assert.equal(emptyOccupancy.estimatedCanvasBytes, 0);
    assert.equal(w.context.facadeAtlasStats.entries, w.context.facadeAtlasStats.retiredEntries);
    assert.equal(w.context.facadeAtlasStats.atlasEntryPixels, w.context.facadeAtlasStats.retiredContentTexels);
    w.sources.clear();
});

test('old and unpublished replacement meshes independently pin the same atlas page', () => {
    const w = world();
    const { record, page } = w.capture('same-content');
    w.finishPaints();
    const oldMesh = w.publish(record);
    const candidate = new THREE.Mesh(new THREE.BufferGeometry(), page.material);
    w.context.setPassageAwareMaterial(candidate, page.material);
    w.context.setPassageAwareMaterial(candidate, page.material); // passage refresh must not acquire twice
    assert.deepEqual(w.cache.snapshot().owners, { bucket: 1, mesh: 2 });
    w.context.forgetEmptyOvertureBucket(record.bucketKey);
    assert.equal(w.context.overtureTileBuckets.size, 0);
    assert.equal(w.context.facadeAtlasGroups.size, 1, 'region bookkeeping is not resource ownership');
    assert.throws(() => w.context.disposeFacadeAtlases(), /still has 2 owners/);
    w.context.disposeOvertureAggregateMesh(candidate); // stale candidate
    assert.equal(w.cache.trim(), 0);
    assert.equal(page.disposed, false);
    w.context.disposeOvertureAggregateMesh(oldMesh);
    assert.equal(w.cache.trim(), 1);
    assert.equal(page.disposed, true);
    assert.equal(w.context.facadeAtlasGroups.size, 0);
});

for (const failure of ['cancel', 'upload']) {
    test(`atlas ${failure} releases its paint lease but cannot evict staged replacement pixels`, () => {
        const w = world({ failUpload: failure === 'upload' });
        const { page } = w.capture('staged');
        if (failure === 'cancel') w.context.clearFacadeAtlasPaintQueue();
        else {
            assert.throws(() => w.finishPaints(), /upload failed/);
            w.context.facadeAtlasPaintJob.callbacks.onError();
        }
        assert.equal(page.paintFailed, true);
        assert.deepEqual(w.cache.snapshot().owners, { 'staged-part': 1 });
        assert.equal(w.cache.trim(), 0);
        assert.equal(w.sources.snapshot().references, 0);
        w.context.clearTileVisualReplacements();
        w.context.clearTileVisualReplacements();
        assert.equal(w.cache.trim(), 1);
        assert.equal(w.cache.snapshot().estimatedBytes, 0);
        assert.equal(w.context.facadeAtlasGroups.size, 0);
        assert.equal(w.context.facadeAtlasMaterials.size, 0);
    });
}
