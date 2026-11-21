import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { bindGroundPaintMaterial, createGroundPaintMaterialState } from '../core/ground-paint-material.js';
import { captureGroundPaintStyles, captureGroundPaintMaterialRows } from '../core/ground-paint-styles.js';
import { setSceneRenderOrigin, resetSceneRenderOrigin } from '../core/render-origin.js';

const receiver = { key: 'terrain:0:0', verticalBand: 'ground', coverageRevision: 'footprint:1' };
const styles = captureGroundPaintStyles(new Map([['paving', { id: 7, revision: 'v1', surfaceClass: 'sidewalk',
    roughness: .92, metalness: 0, normalInfluence: 0, linearColor: [.2, .3, .4] }]]));
const page = (extra = {}) => ({ receiver, bounds: { minX: 1000, minZ: 2000, maxX: 1016, maxZ: 2016 },
    target: (() => { const texture = Object.assign(new THREE.DataArrayTexture(null, 16, 16, 4), { internalFormat: 'R8' }); return { texture, textures: [texture] }; })(),
    styles, size: 16, layer: 0, patterns: { ready: true, released: false, texture: null },
    copyMaterialRows: () => captureGroundPaintMaterialRows(styles, null, { minX: 1000, minZ: 2000 }), ...extra });

test('receiver binding rejects wrong band, footprint and retired pages before modifying a material', () => {
    const material = new THREE.MeshStandardMaterial();
    const original = material.onBeforeCompile;
    for (const invalid of [page({ receiver: { ...receiver, key: 'deck:1' } }),
        page({ receiver: { ...receiver, verticalBand: 'bridge:1' } }),
        page({ receiver: { ...receiver, coverageRevision: 'footprint:2' } }), page({ disposed: true })]) {
        assert.throws(() => bindGroundPaintMaterial(material, { receiver, page: invalid }), /receiver/);
        assert.equal(material.onBeforeCompile, original);
    }
    const valid = page();
    const bound = bindGroundPaintMaterial(material, { receiver, page: valid });
    assert.throws(() => bindGroundPaintMaterial(material, { receiver }), /already belongs/);
    assert.throws(() => bound.replace(page({ receiver: { ...receiver, key: 'deck:1' } })), /receiver/);
    assert.equal(bound.page, valid);
    material.dispose();
});

test('standard shader retains earlier clipping and uses the new page without recompilation', () => {
    const material = new THREE.MeshStandardMaterial({ roughness: .7 });
    material.onBeforeCompile = shader => {
        shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>',
            '#include <clipping_planes_fragment>\nif (vClipPosition.x > 123.0) discard;');
    };
    material.customProgramCacheKey = () => 'structural-cut-v2';
    const original = page(), bound = bindGroundPaintMaterial(material, { receiver, page: original });
    const shader = { vertexShader: THREE.ShaderLib.standard.vertexShader,
        fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.standard.uniforms) };
    material.onBeforeCompile(shader, {});
    assert.ok(shader.fragmentShader.includes('if (vClipPosition.x > 123.0) discard;'));
    assert.ok(shader.fragmentShader.includes('#include <lights_fragment_begin>'));
    assert.ok(shader.vertexShader.includes('#include <displacementmap_vertex>'));
    assert.equal(shader.uniforms.uReceiverPaintPatterns.value, null);
    const version = material.version, key = material.customProgramCacheKey();
    const refined = page({ receiver: { ...receiver, generation: 2 } });
    assert.equal(bound.replace(refined), original);
    assert.equal(shader.uniforms.uReceiverPaintIds.value, refined.target.texture);
    assert.equal(material.version, version); assert.equal(material.customProgramCacheKey(), key);
    assert.ok(key.includes('structural-cut-v2'));
    assert.equal(material.roughness, .7, 'unpainted receiver retains its original material parameters');
    assert.equal(bound.clear(), refined);
    assert.equal(shader.uniforms.uReceiverPaintCount.value, 0);
    assert.equal(shader.uniforms.uReceiverPaintIds.value, null);
    material.dispose();
});

test('a planner clone can preserve callbacks and bind paint without installing the shader patch twice', () => {
    const state = createGroundPaintMaterialState({ receiver });
    const source = new THREE.MeshStandardMaterial();
    let baseCompiles = 0, baseRenders = 0;
    source.onBeforeCompile = () => { baseCompiles++; };
    source.customProgramCacheKey = () => 'planner-base';
    source.onBeforeRender = () => { baseRenders++; };
    bindGroundPaintMaterial(source, { state, minimumRank: 10 });
    const variant = source.clone();
    variant.onBeforeCompile = source.onBeforeCompile;
    variant.customProgramCacheKey = source.customProgramCacheKey;
    variant.onBeforeRender = source.onBeforeRender;
    bindGroundPaintMaterial(variant, { state, minimumRank: 10 });
    const shader = { vertexShader: THREE.ShaderLib.standard.vertexShader,
        fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: {} };
    variant.onBeforeCompile(shader, {});
    variant.onBeforeRender();
    assert.equal(baseCompiles, 1);
    assert.equal(baseRenders, 1);
    assert.equal(shader.vertexShader.match(/varying vec2 vReceiverPaintXZ;/g)?.length, 1);
    assert.equal(shader.fragmentShader.match(/varying vec2 vReceiverPaintXZ;/g)?.length, 1);
    assert.equal(variant.customProgramCacheKey().match(/ground-paint-id-material-v4/g)?.length, 1);
    state.dispose(); source.dispose(); variant.dispose();
});

test('receiver variants share one atomic cascade mapping and retain material rows by page', () => {
    const state = createGroundPaintMaterialState({ receiver });
    const terrain = new THREE.MeshStandardMaterial(), road = new THREE.MeshStandardMaterial();
    bindGroundPaintMaterial(terrain, { state, minimumRank: 10 });
    bindGroundPaintMaterial(road, { state, minimumRank: 50, maximumRank: 90 });
    const compile = material => {
        const shader = { ...THREE.ShaderLib.standard, uniforms: {} };
        material.onBeforeCompile(shader, {}); return shader;
    };
    const a = compile(terrain), b = compile(road);
    assert.equal(a.uniforms.uReceiverPaintBounds, b.uniforms.uReceiverPaintBounds);
    assert.equal(a.uniforms.uReceiverPaintStyles, b.uniforms.uReceiverPaintStyles);
    assert.equal(a.uniforms.uReceiverPaintMinimumRank.value, 10);
    assert.equal(b.uniforms.uReceiverPaintMinimumRank.value, 50);
    assert.equal(a.uniforms.uReceiverPaintMaximumRank.value, 255);
    assert.equal(b.uniforms.uReceiverPaintMaximumRank.value, 90);
    assert.throws(() => bindGroundPaintMaterial(new THREE.MeshStandardMaterial(),
        { state, minimumRank: 50, maximumRank: 30 }), /rank/);
    const near = page(), far = page({ target: near.target, layer: 2,
        bounds: { minX: 992, minZ: 1992, maxX: 1056, maxZ: 2056 } });
    state.replacePages([near, far]);
    const bytes = a.uniforms.uReceiverPaintStyles.value.image.data.slice();
    assert.equal(bytes[7 * 4], Math.fround(.92));
    assert.equal(bytes[4096 + 7 * 4 + 3], 65);
    assert.equal(a.uniforms.uReceiverPaintCount.value, 2);
    const version = terrain.version, tableVersion = a.uniforms.uReceiverPaintStyles.value.version;
    assert.throws(() => state.replacePages([near, { ...far, receiver: { ...receiver, key: 'deck' } }]), /receiver/);
    assert.deepEqual(state.pages, [near, far]);
    assert.deepEqual(a.uniforms.uReceiverPaintStyles.value.image.data, bytes);
    assert.equal(a.uniforms.uReceiverPaintStyles.value.version, tableVersion);
    assert.equal(terrain.version, version);
    terrain.dispose();
    assert.equal(state.disposed, false, 'disposing one material must not close another material’s receiver');
    state.clear(); assert.equal(b.uniforms.uReceiverPaintCount.value, 0);
    state.dispose(); road.dispose();
});

test('cascade admission rejects aliases, different targets and reversed scales before publishing', () => {
    const state = createGroundPaintMaterialState({ receiver });
    const near = page();
    const far = page({ target: near.target, layer: 1,
        bounds: { minX: 992, minZ: 1992, maxX: 1056, maxZ: 2056 } });
    state.replacePages([near, far]);
    for (const next of [[near, { ...far, layer: 0 }], [near, page({ ...far, target: page().target })],
        [far, near], [near, { ...far, bounds: { ...far.bounds, maxZ: 2057 } }]]) {
        assert.throws(() => state.replacePages(next));
        assert.deepEqual(state.pages, [near, far]);
    }
    assert.equal(state.textureBytes, 49152);
    state.dispose();
});

test('pattern library disagreement or a released lease cannot partially change active uniforms', () => {
    const state = createGroundPaintMaterialState({ receiver }), material = new THREE.MeshStandardMaterial();
    bindGroundPaintMaterial(material, { state });
    const shader = { ...THREE.ShaderLib.standard, uniforms: {} };
    material.onBeforeCompile(shader, {});
    const texture = new THREE.DataArrayTexture(null, 4, 4, 4);
    const near = page({ patterns: { ready: true, released: false, texture } });
    const far = page({ target: near.target, layer: 1, patterns: near.patterns,
        bounds: { minX: 992, minZ: 1992, maxX: 1056, maxZ: 2056 } });
    state.replacePages([near, far]);
    const bytes = shader.uniforms.uReceiverPaintStyles.value.image.data.slice();
    for (const patterns of [{ ...near.patterns, released: true }, { ...near.patterns, ready: false },
        { ...near.patterns, texture: new THREE.DataArrayTexture(null, 4, 4, 4) }]) {
        assert.throws(() => state.replacePages([near, { ...far, patterns }]));
        assert.deepEqual(state.pages, [near, far]);
        assert.equal(shader.uniforms.uReceiverPaintPatterns.value, texture);
        assert.deepEqual(shader.uniforms.uReceiverPaintStyles.value.image.data, bytes);
    }
    state.dispose(); material.dispose(); texture.dispose();
});

test('render-origin changes translate page bounds and stale halos without repainting or losing prior hooks', () => {
    const state = createGroundPaintMaterialState({ receiver }), material = new THREE.MeshStandardMaterial();
    let calls = 0;
    material.onBeforeRender = function () { assert.equal(this, material); calls++; };
    bindGroundPaintMaterial(material, { state });
    const shader = { ...THREE.ShaderLib.standard, uniforms: {} };
    material.onBeforeCompile(shader, {});
    const near = page(), invalid = { minX: 1002, minZ: 2003, maxX: 1005, maxZ: 2006 };
    try {
        resetSceneRenderOrigin(); state.replacePages([near], [invalid]);
        const version = material.version, tableVersion = shader.uniforms.uReceiverPaintStyles.value.version;
        const rows = shader.uniforms.uReceiverPaintStyles.value.image.data.slice();
        setSceneRenderOrigin(null, { x: 100000.25, z: -200000.75 });
        material.onBeforeRender();
        assert.equal(calls, 1);
        assert.deepEqual(shader.uniforms.uReceiverPaintBounds.value[0].toArray(), [-99000.25,202000.75,16,16]);
        assert.deepEqual(shader.uniforms.uReceiverPaintInvalidBounds.value[0].toArray(),
            [1001-100000.25,2002+200000.75,1006-100000.25,2007+200000.75]);
        assert.deepEqual(shader.uniforms.uReceiverPaintStyles.value.image.data, rows);
        assert.equal(material.version, version);
        assert.equal(shader.uniforms.uReceiverPaintStyles.value.version, tableVersion);
        assert.equal(state.syncRenderOrigin(), false, 'unchanged origin is a constant-time no-op');
    } finally { resetSceneRenderOrigin(); state.dispose(); material.dispose(); }
});
