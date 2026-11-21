// Covers diagnostic colour/shadow draw-call attribution without requiring a
// WebGL context.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderCallAttributor } from '../core/render-call-attribution.js';

function sceneWith(groupName = 'Trams') {
    const scene = { name: 'Scene', children: [], traverse: null };
    const group = { name: groupName, parent: scene, children: [] };
    const mesh = {
        name: 'Vehicle',
        parent: group,
        children: [],
        isMesh: true,
        onBeforeRender() {},
        onAfterRender() {},
        onBeforeShadow() {},
        onAfterShadow() {},
    };
    scene.children.push(group);
    group.children.push(mesh);
    scene.traverse = (visit) => {
        visit(scene);
        visit(group);
        visit(mesh);
    };
    return { scene, mesh };
}

test('attributes actual colour and shadow call deltas to the top-level scene group', () => {
    const { scene, mesh } = sceneWith('OtherTrams');
    const renderer = { info: { render: { calls: 0 } } };
    const attribution = createRenderCallAttributor({ scanIntervalMs: 0 });
    assert.equal(attribution.refresh(scene, 0), 1);

    attribution.beginFrame();
    mesh.onBeforeShadow(renderer);
    renderer.info.render.calls += 1;
    mesh.onAfterShadow(renderer);
    mesh.onBeforeRender(renderer);
    renderer.info.render.calls += 2; // transparent double-sided material
    mesh.onAfterRender(renderer);
    const frame = attribution.endFrame(4);

    assert.equal(frame.totalCalls, 4);
    assert.equal(frame.mainCalls, 2);
    assert.equal(frame.shadowCalls, 1);
    assert.equal(frame.unattributedCalls, 1);
    assert.deepEqual(frame.groups, [{
        name: 'OtherTrams', mainCalls: 2, shadowCalls: 1, calls: 3,
    }]);
    const window = attribution.takeWindow();
    assert.equal(window.frames, 1);
    assert.equal(window.groups[0].name, 'OtherTrams');
    assert.equal(window.groups[0].mainCalls, 2);
    assert.equal(window.groups[0].shadowCalls, 1);
});

test('keeps original render callbacks and averages successive frames', () => {
    const { scene, mesh } = sceneWith('Roads');
    let originalCalls = 0;
    mesh.onAfterRender = () => { originalCalls += 1; };
    const renderer = { info: { render: { calls: 0 } } };
    const attribution = createRenderCallAttributor({ scanIntervalMs: 0 });
    attribution.refresh(scene, 0);

    for (const calls of [1, 3]) {
        renderer.info.render.calls = 0;
        attribution.beginFrame();
        mesh.onBeforeRender(renderer);
        renderer.info.render.calls += calls;
        mesh.onAfterRender(renderer);
        attribution.endFrame(calls);
    }

    const window = attribution.takeWindow();
    assert.equal(originalCalls, 2);
    assert.equal(window.frames, 2);
    assert.equal(window.mainCalls, 2);
    assert.equal(window.groups[0].calls, 2);
});

test('an explicit diagnostic label overrides an unnamed scene root', () => {
    const { scene, mesh } = sceneWith('');
    mesh.parent.userData = { perfRenderGroup: 'AmbientVehicles' };
    const renderer = { info: { render: { calls: 0 } } };
    const attribution = createRenderCallAttributor({ scanIntervalMs: 0 });
    attribution.refresh(scene, 0);

    attribution.beginFrame();
    mesh.onBeforeRender(renderer);
    renderer.info.render.calls += 1;
    mesh.onAfterRender(renderer);
    attribution.endFrame(1);

    assert.equal(attribution.takeWindow().groups[0].name, 'AmbientVehicles');
});

test('an unnamed root falls back to existing scene-inspector metadata', () => {
    const { scene, mesh } = sceneWith('');
    mesh.parent.userData = {
        station3dInspectionLayer: { label: 'Pedestrian crossings' },
    };
    const renderer = { info: { render: { calls: 0 } } };
    const attribution = createRenderCallAttributor({ scanIntervalMs: 0 });
    attribution.refresh(scene, 0);

    attribution.beginFrame();
    mesh.onBeforeRender(renderer);
    renderer.info.render.calls += 1;
    mesh.onAfterRender(renderer);
    attribution.endFrame(1);

    assert.equal(attribution.takeWindow().groups[0].name, 'Pedestrian crossings');
});
