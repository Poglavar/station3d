// Farmland fields carry their own crop colour and rows, and civil earthwork faces read
// as mown verge: the field raster encoding and the ground shader patch that consumes it.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

globalThis.window ??= globalThis;
// The shared sidewalk texture paints a 2D canvas once; a headless stub is enough.
const imageData = (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) });
const context2d = new Proxy({}, { get: (_, name) => name === 'createImageData' ? imageData
    : name === 'getImageData' ? (x, y, w, h) => imageData(w, h)
        : () => ({ addColorStop() {} }), set: () => true });
globalThis.document ??= { createElement: () => ({ getContext: () => context2d }) };
const { createFieldPatchworkRaster, FIELD_COVERS, fieldAt, FIELD_PATCHWORK_DEFAULTS } = await import('../core/field-patchwork-texture.js');
const { applyUrbanGroundSurface, applyEarthworkFaceSurface } = await import('../world/urban-ground-surface.js');
const { compileSurfaceClaim, SURFACE_CLASS, SURFACE_COVERAGE_STATE, SURFACE_VERTICAL_RELATION } = await import('../core/surface-hierarchy.js');

const claim = surfaceClass => compileSurfaceClaim({ surfaceClass, coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
    verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL, verticalBand: 'ground', ownerId: `test-${surfaceClass}` });

function compiled(material) {
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
        fragmentShader: THREE.ShaderLib.standard.fragmentShader };
    material.onBeforeCompile(shader, null);
    return { ...shader, key: material.customProgramCacheKey() };
}

test('fields are absolute crop colours, so a field can be brown or straw rather than only a green shade', () => {
    // The grass is sRGB 34/72/30; a 0..2 multiplier could never take its red past 68.
    assert.ok(FIELD_COVERS.some(cover => cover.rgb[0] > 2 * 34 && cover.rgb[0] > cover.rgb[1]), 'a soil-coloured cover');
    assert.ok(FIELD_COVERS.some(cover => cover.rows === 0) && FIELD_COVERS.some(cover => cover.rows > 0.5));
});

test('the raster stores each field colour and its row strength, with rows stopping at the field rim', () => {
    const size = 64;
    const raster = createFieldPatchworkRaster({ size });
    let rimRows = 0, innerRowPixels = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const field = fieldAt(x / size, y / size, { ...FIELD_PATCHWORK_DEFAULTS, size });
        const i = (y * size + x) * 4;
        const cover = FIELD_COVERS[field.tintIndex];
        if (field.edgeDistance === 0) rimRows += raster.color[i + 3];
        if (field.edgeDistance > FIELD_PATCHWORK_DEFAULTS.rimWidth) {
            assert.deepEqual([...raster.color.subarray(i, i + 3)], cover.rgb);
            assert.equal(raster.color[i + 3], Math.round(cover.rows * 255));
            if (cover.rows > 0) innerRowPixels++;
        }
    }
    assert.equal(rimRows, 0);
    assert.ok(innerRowPixels > 0);
});

test('earthwork claims compile the slope-gated verge look; terrain does not', () => {
    for (const surfaceClass of [SURFACE_CLASS.ROAD_EARTHWORK, SURFACE_CLASS.RAIL_EARTHWORK]) {
        const shader = compiled(applyUrbanGroundSurface(new THREE.MeshStandardMaterial(), claim(surfaceClass), { urbanGround: false }));
        assert.match(shader.vertexShader, /vEarthworkUpness = abs\(normalize\(mat3\(modelMatrix\) \* normal\)\.y\)/);
        assert.match(shader.fragmentShader, /float earthworkSlope = 1\.0 - smoothstep\(0\.94, 0\.985, vEarthworkUpness\)/);
        assert.match(shader.fragmentShader, /bermColor/);
        assert.match(shader.key, /-earthwork/);
    }
    const terrain = compiled(applyUrbanGroundSurface(new THREE.MeshStandardMaterial(), claim(SURFACE_CLASS.TERRAIN),
        { fieldPatchwork: true }));
    assert.match(terrain.fragmentShader, /float earthworkSlope = 0\.0;/);
    // Terrain carries the fields, with rows and the fade on steep banks.
    assert.match(terrain.fragmentShader, /vec3 fieldColor = fieldTexel\.rgb \* groundGrain/);
    assert.match(terrain.fragmentShader, /smoothstep\(0\.90, 0\.96, vGroundFieldUpness\)/);
    assert.doesNotMatch(terrain.fragmentShader, /bermColor/);
    assert.doesNotMatch(terrain.key, /-earthwork/);
});

test('the standalone earthwork patch keeps the material\'s own patch and adds the verge look', () => {
    const material = new THREE.MeshStandardMaterial();
    material.onBeforeCompile = shader => { shader.fragmentShader = `// own patch\n${shader.fragmentShader}`; };
    material.customProgramCacheKey = () => 'own';
    const shader = compiled(applyEarthworkFaceSurface(material));
    assert.match(shader.fragmentShader, /^\/\/ own patch/);
    assert.match(shader.fragmentShader, /bermColor/);
    assert.equal(shader.key, 'own|earthwork-face-v1');
    assert.equal(applyEarthworkFaceSurface(material), material);
    assert.equal(compiled(material).key, 'own|earthwork-face-v1', 'applying twice does not patch twice');
});
