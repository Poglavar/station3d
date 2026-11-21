// Execute the real monolith's orchestration with I/O collaborators replaced by
// spies. These cover owner handoffs, not merely the presence of source strings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from 'three';
import { createOwnedResourceCache, createMeshResourceBindings } from '../core/owned-resource-cache.js';
import { createFacadeAtlasLayout, remapFacadeAtlasUvs } from '../core/facade-atlas-layout.js';

const source = readFileSync(new URL('../world/buildings.js', import.meta.url), 'utf8');
function load(names, collaborators) {
    const context = vm.createContext(collaborators);
    for (const name of names) {
        const start = source.indexOf(`function ${name}(`);
        assert.ok(start >= 0, `Missing real function ${name}`);
        const end = source.indexOf('\n}', start) + 2;
        vm.runInContext(source.slice(start, end), context);
    }
    return context;
}

function setup() {
    const cache = createOwnedResourceCache({ maxIdleBytes: 0 });
    let disposed = 0;
    const material = cache.getOrCreate('source', () => ({
        value: {}, cpuBytes: 16, gpuBytes: 22, dispose: () => { disposed++; },
    }));
    return { cache, material, disposed: () => disposed };
}

function paints({ throwOnPaint = false, throwOnUpload = false } = {}) {
    const { cache, material, disposed } = setup();
    const queued = [];
    const painted = [];
    const uploaded = [];
    const context = load([
        'advanceFacadeAtlasPaintPage', 'ensureFacadeAtlasPaintQueue',
        'clearFacadeAtlasSourcePaints', 'queueFacadeAtlasPaint', 'clearFacadeAtlasPaintQueue',
    ], {
        facadeResources: cache, facadeAtlasPaintJob: null, facadeAtlasPaintPages: [],
        facadeAtlasResources: createOwnedResourceCache({ maxIdleBytes: 0 }),
        facadeAtlasStats: { pageUpdates: 0 }, buildingNowMs: () => 0,
        FRAME_CHUNK_REPEAT_ITEM: Symbol('repeat'),
        paintFacadeAtlasGutter(_ctx, image) {
            assert.equal(cache.trim(), 0, 'drawImage must see a live source');
            if (throwOnPaint) throw Error('drawImage failed');
            painted.push(image);
        },
        renderer: { initTexture(texture) {
            if (throwOnUpload) throw Error('upload failed');
            uploaded.push(texture);
        } },
        facadeAtlasPaintQueue: {
            enqueue(items, step, callbacks) { const job = { items, step, callbacks }; queued.push(job); return job; },
            clear() { for (const job of queued) job.callbacks.onCancel(); },
        },
    });
    const page = () => ({ pendingPaints: [], paintCursor: 0, paintQueued: false, paintFailed: false, texture: {} });
    return { cache, material, disposed, context, queued, painted, uploaded, page };
}

test('a real atlas paint releases its source immediately after drawing, before GPU publication', () => {
    const p = paints();
    const page = p.page();
    const image = {};
    p.context.queueFacadeAtlasPaint(page, image, {}, p.material);
    const pending = page.pendingPaints[0];
    assert.equal(p.cache.snapshot().references, 1);
    p.queued[0].step(page);
    assert.deepEqual(p.painted, [image]);
    assert.deepEqual(p.uploaded, [page.texture]);
    assert.equal(pending.image, null, 'the completed queue item must not keep the canvas alive');
    assert.equal(p.cache.snapshot().references, 0);
    p.queued[0].callbacks.onComplete();
    assert.equal(p.context.facadeAtlasPaintJob, null);
    assert.equal(p.cache.trim(), 1);
});

test('a later cancelled page cannot poison a page that already uploaded successfully', () => {
    const p = paints();
    const pages = [p.page(), p.page()];
    for (const page of pages) p.context.queueFacadeAtlasPaint(page, {}, {}, p.material);
    p.queued[0].step(pages[0]);
    assert.equal(p.cache.snapshot().references, 1);
    p.queued[0].callbacks.onCancel();
    assert.equal(pages[0].paintFailed, false);
    assert.equal(pages[1].paintFailed, true);
    assert.equal(p.cache.snapshot().references, 0);
    assert.equal(p.cache.trim(), 1);
});

for (const failure of ['cancel', 'paint', 'upload']) {
    test(`atlas ${failure} releases every pending source and blocks incomplete-page publication`, () => {
        const p = paints({ throwOnPaint: failure === 'paint', throwOnUpload: failure === 'upload' });
        const pages = [p.page(), p.page()];
        for (const page of pages) p.context.queueFacadeAtlasPaint(page, {}, {}, p.material);
        assert.equal(p.cache.snapshot().references, 2);
        if (failure === 'cancel') p.context.clearFacadeAtlasPaintQueue();
        else {
            assert.throws(() => p.queued[0].step(pages[0]), /failed/);
            p.queued[0].callbacks.onError(); // FrameChunkQueue's failure callback contract.
        }
        for (const page of pages) {
            assert.equal(page.pendingPaints.length, 0);
            assert.equal(page.paintQueued, false);
            assert.equal(page.paintFailed, true);
        }
        p.context.clearFacadeAtlasPaintQueue(); // repeated teardown must be harmless
        assert.equal(p.cache.snapshot().references, 0);
        assert.equal(p.cache.trim(), 1);
        assert.equal(p.disposed(), 1);
        assert.equal(p.context.facadeAtlasPaintJob, null);
        assert.match(source, /if \(atlasPage\?\.paintFailed \|\| atlasPage\?\.paintQueued/);
    });
}

test('recreated facade source textures reuse the same region atlas slot and pixels', () => {
    let paints = 0;
    const context = load(['facadeAtlasPart'], {
        facadeAtlasFamily: () => 'punched', facadeAtlasGroups: new Map(),
        createFacadeAtlasLayout, remapFacadeAtlasUvs,
        FACADE_ATLAS_PAGE_SIZE: 1024, FACADE_ATLAS_PADDING: 2,
        buildingQualityProfile: { buildings: { facadeAtlasMaxEntrySize: 256 } },
        createFacadeAtlasPage(group, _base, _region, _family, index) {
            const page = { material: {} }; group.pages[index] = page; return page;
        },
        queueFacadeAtlasPaint() { paints++; },
        facadeAtlasStats: { entries: 0, sourcePixels: 0, atlasEntryPixels: 0 },
    });
    const base = uuid => ({ map: { uuid, image: { width: 64, height: 64 } }, userData: { facadeSourceKey: 'same-pixels' } });
    const before = context.facadeAtlasPart({}, base('old-instance'), '0_0', new Float32Array([0, 0, 1, 1]));
    const after = context.facadeAtlasPart({}, base('new-instance'), '0_0', new Float32Array([0, 0, 1, 1]));
    assert.equal(before.material, after.material);
    assert.deepEqual(before.uvs, after.uvs);
    assert.equal(paints, 1);
    assert.equal(context.facadeAtlasGroups.get('0_0|punched').layout.stats().entries, 1);
});

test('aggregate publication transfers staged ownership to a bucket until that bucket retires', () => {
    const { cache, material } = setup();
    const parts = [];
    const context = load(['publishBuildingAggregatePart', 'releaseTileReplacementResources'], {
        retainBuildingFacadeMaterial: cache.retain, overtureScopeOwners: new Map(), overlayOwnersByKey: new Map(),
        overtureBucketDescriptors: new Map(), overtureTileBuckets: new Map(), overtureDirtyTiles: new Set(),
        overtureBatcher: { addPart(...args) { parts.push(args); } },
    });
    const record = {
        scope: 'tile', region: 'region', ownerKey: 'building', bucketKey: 'bucket', part: {},
        descriptor: { material }, releaseFacadeMaterial: cache.retain(material, 'staged-part'),
    };
    context.publishBuildingAggregatePart(record);
    assert.equal(parts.length, 1);
    assert.deepEqual(cache.snapshot().owners, { bucket: 1 });
    assert.equal(cache.trim(), 0);
    context.overtureBucketDescriptors.get('bucket').releaseFacadeMaterial();
    assert.equal(cache.trim(), 1);
});

test('cancelling a tile replacement releases unpublished parts exactly once', () => {
    const { cache, material } = setup();
    const replacements = new Map([['tile', { stagedAggregateParts: [
        { releaseFacadeMaterial: cache.retain(material, 'staged-part') },
        { releaseFacadeMaterial: cache.retain(material, 'staged-part') },
    ] }]]);
    const context = load(['releaseTileReplacementResources', 'clearTileVisualReplacements'], { tileVisualReplacements: replacements });
    context.clearTileVisualReplacements(); context.clearTileVisualReplacements();
    assert.equal(replacements.size, 0);
    assert.equal(cache.snapshot().references, 0);
    assert.equal(cache.trim(), 1);
});

test('capturing a replacement retires only its individual geometry, after acquiring staged ownership', () => {
    const { cache, material } = setup();
    const group = new THREE.Group();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    const mesh = new THREE.Mesh(geometry, material);
    const sharedGeometry = geometry.clone();
    const sharedMesh = new THREE.Mesh(sharedGeometry, material);
    group.add(mesh, sharedMesh);
    const bind = createMeshResourceBindings(cache);
    bind(mesh, material); bind(sharedMesh, material);
    let disposed = 0;
    geometry.addEventListener('dispose', () => disposed++);
    const replacement = { stagedAggregateParts: [] };
    const context = load(['captureBuildingMeshesForBatching', 'restoreFacadeOverlaySource', 'releaseTileReplacementResources'], {
        retainBuildingFacadeMaterial: cache.retain, buildingsGroup: group, overtureTileScope: key => key,
        overtureRegionForScope: () => 'region', buildingEntityMetadata: () => ({ key: 'feature' }),
        tileVisualReplacements: new Map([['tile', replacement]]), passageBaseMaterialByMesh: new WeakMap(),
        facadeOverlayBindings: new WeakMap(),
        overtureMaterialExcluded: () => false, overtureColorFamilyFor: () => null,
        overtureMaterialIds: new WeakMap(), nextOvertureMaterialId: 0, isShared: value => value === sharedGeometry,
    });
    context.captureBuildingMeshesForBatching({}, 'tile', 0);
    assert.deepEqual(group.children, [sharedMesh], 'the shared geometry must remain with its live mesh');
    assert.equal(disposed, 1);
    assert.equal(replacement.stagedAggregateParts.length, 1);
    assert.equal(replacement.stagedAggregateParts[0].part.attributes.position, geometry.attributes.position.array);
    assert.deepEqual(cache.snapshot().owners, { mesh: 1, 'staged-part': 1 });
    assert.equal(cache.trim(), 0);
    context.releaseTileReplacementResources(replacement);
    assert.equal(cache.trim(), 0, 'the remaining live mesh still owns its facade');
    sharedGeometry.dispose();
    assert.equal(cache.trim(), 1);
});

test('ordinary facade eviction disposes both maps even when daytime has unbound the emissive map', () => {
    const cache = createOwnedResourceCache({ maxIdleBytes: 0 });
    const textures = [new THREE.Texture({ width: 8, height: 8 }), new THREE.Texture({ width: 8, height: 8 })];
    let disposedTextures = 0, disposedMaterials = 0, disposedVariants = 0;
    for (const texture of textures) texture.addEventListener('dispose', () => disposedTextures++);
    const context = load(['facadeOverlayDescriptor', 'getFacadeOverlayMaterial'], {
        THREE, facadeResources: cache, getFacadeStyleIndex: () => 0, architecturalLocationId: () => 'zagreb',
        getFacadeTexture: () => textures[0], getFacadeEmissiveTexture: () => textures[1], WALL_ENV_MAP_INTENSITY: 0.3,
        registerShared() {}, unregisterShared() {}, windowEmissiveMapByMaterial: new WeakMap(),
        applyNightModeToMaterial(mat) { mat.emissiveMap = null; },
        buildingMaterials: {}, facadeTextureKey: () => 'pixels',
        _facadeTextures: new Map([['pixels', textures[0]]]), _facadeEmissiveTextures: new Map([['pixels', textures[1]]]),
        disposePassageMaterialVariant() { disposedVariants++; },
    });
    const material = context.getFacadeOverlayMaterial(1, 2, 3);
    material.addEventListener('dispose', () => disposedMaterials++);
    assert.equal(material.emissiveMap, null);
    assert.match(material.userData.facadeSourceKey, /zagreb_2f_3b/);
    assert.equal(cache.snapshot().estimatedCanvasBytes, 512);
    const release = cache.retain(material, 'mesh');
    assert.equal(cache.trim(), 0);
    release(); cache.trim();
    assert.equal(disposedMaterials, 1);
    assert.equal(disposedVariants, 1);
    assert.equal(disposedTextures, 2);
    assert.ok(textures.every(texture => texture.image === null));
    assert.equal(Object.keys(context.buildingMaterials).length, 0);
    assert.equal(context._facadeTextures.size + context._facadeEmissiveTextures.size, 0);
});
