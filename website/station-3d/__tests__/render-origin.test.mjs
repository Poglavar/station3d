import assert from 'node:assert/strict';
import test from 'node:test';

import {
    applyRenderOriginForRender,
    bindRenderOriginShader,
    getRenderOrigin,
    renderOriginUniform,
    resetSceneRenderOrigin,
    resolveRenderOriginRebase,
    setSceneRenderOrigin,
} from '../core/render-origin.js';

test('render origin rebases only outside the precision window', () => {
    assert.equal(resolveRenderOriginRebase({ x: 0, z: 0 }, { x: 1999, z: 0 }, 2000), null);
    assert.deepEqual(
        resolveRenderOriginRebase({ x: 0, z: 0 }, { x: 2100, z: -50 }, 2000),
        { x: 2100, z: -50 },
    );
});

test('scene root and camera receive the same inverse render translation', () => {
    const scene = {
        position: { x: 0, y: 7, z: 0 },
        onAfterRender() {},
    };
    const camera = { position: { x: 2120, y: 5, z: -40 } };
    assert.equal(setSceneRenderOrigin(scene, { x: 2100, z: -50 }), true);
    applyRenderOriginForRender(scene, camera);

    assert.deepEqual(getRenderOrigin(), { x: 2100, z: -50 });
    assert.deepEqual(scene.position, { x: -2100, y: 7, z: 50 });
    assert.deepEqual(camera.position, { x: 20, y: 5, z: 10 });
    assert.equal(renderOriginUniform.value.x, 2100);
    assert.equal(renderOriginUniform.value.y, -50);

    scene.onAfterRender();
    assert.deepEqual(scene.position, { x: 0, y: 7, z: 0 });
    assert.deepEqual(camera.position, { x: 2120, y: 5, z: -40 });

    resetSceneRenderOrigin(scene);
    assert.deepEqual(scene.position, { x: 0, y: 7, z: 0 });
});

test('composed shader hooks share one render-origin declaration', () => {
    const shader = {
        uniforms: {},
        fragmentShader: '#include <common>\nvoid main() {}',
    };
    bindRenderOriginShader(shader);
    bindRenderOriginShader(shader);
    assert.equal(shader.uniforms.uRenderOriginXZ, renderOriginUniform);
    assert.equal(
        shader.fragmentShader.match(/uniform vec2 uRenderOriginXZ;/g)?.length,
        1,
    );
});
