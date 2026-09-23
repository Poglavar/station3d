// The shadow pass may be skipped only when nothing it draws changed; any change,
// a new map, an explicit update request or a disabled cache must render.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCachedShadowMap } from '../core/cached-shadow-map.js';

const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function fixture() {
    const renders = [];
    const map = {};
    const light = { isDirectionalLight: true, matrixWorld: { elements: identity() }, target: { matrixWorld: { elements: identity() } },
        shadow: { map, needsUpdate: false, bias: 0, normalBias: 0, mapSize: { x: 2048, y: 2048 },
            camera: { left: -100, right: 100, top: 100, bottom: -100, near: 0.5, far: 1600 } } };
    const car = { id: 5, castShadow: true, isMesh: true, matrixWorld: { elements: identity() }, geometry: { id: 1, attributes: { position: { version: 0 } }, drawRange: { count: 9 } }, material: { id: 3, version: 0 } };
    const wall = { ...car, id: 6, matrixWorld: { elements: identity() } };
    const casters = [car, wall];
    const scene = { traverseVisible(fn) { for (const c of casters) fn(c); } };
    const shadowMap = { autoUpdate: true, needsUpdate: false, type: 1, render(lights) { renders.push(lights.length); } };
    const renderer = { shadowMap };
    const cache = createCachedShadowMap({ renderer, scene, light });
    const frame = () => shadowMap.render([light], scene, {});
    return { renders, frame, car, casters, light, shadowMap, cache };
}

test('an unchanged scene reuses the map; a moved caster, a new caster or a light step renders', () => {
    const f = fixture();
    f.frame(); f.frame(); f.frame();
    assert.equal(f.renders.length, 1, 'rendered once, then reused');
    f.car.matrixWorld.elements[12] = 3; f.frame();
    assert.equal(f.renders.length, 2, 'moved car');
    f.frame(); assert.equal(f.renders.length, 2);
    f.casters.push({ ...f.car, id: 9 }); f.frame();
    assert.equal(f.renders.length, 3, 'new caster');
    f.light.target.matrixWorld.elements[12] = 8; f.frame();
    assert.equal(f.renders.length, 4, 'light stepped');
    f.casters.pop(); f.frame();
    assert.equal(f.renders.length, 5, 'caster removed');
    assert.deepEqual(f.cache.snapshot(), { enabled: true, renderedFrames: 5, skippedFrames: 3 });
});

test('a replaced map, an explicit update request or a disabled cache always renders', () => {
    const f = fixture();
    f.frame(); f.frame();
    f.light.shadow.map = {}; f.frame();
    assert.equal(f.renders.length, 2, 'new map');
    f.light.shadow.needsUpdate = true; f.frame(); f.light.shadow.needsUpdate = false;
    assert.equal(f.renders.length, 3, 'explicit light update');
    f.cache.setEnabled(false); f.frame(); f.frame();
    assert.equal(f.renders.length, 5, 'disabled renders every frame');
    f.cache.dispose();
    assert.equal(f.shadowMap.render.name, 'render', 'original restored');
});
