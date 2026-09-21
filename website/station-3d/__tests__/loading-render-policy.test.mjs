import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { shouldRenderWorldFrame } from '../core/loading-render-policy.js';

const animate = await readFile(new URL('../scene/animate.js', import.meta.url), 'utf8');

test('opaque world construction skips only the main scene render', () => {
    assert.equal(shouldRenderWorldFrame({
        worldBuilding: true, canvasWidth: 1280, canvasHeight: 720,
    }), false);
    assert.equal(shouldRenderWorldFrame({
        worldBuilding: false, canvasWidth: 1280, canvasHeight: 720,
    }), true);
    assert.equal(shouldRenderWorldFrame({
        worldBuilding: false, canvasWidth: 0, canvasHeight: 720,
    }), false);
});

test('the frame loop checks readiness after construction hooks and restores skipped origins', () => {
    const hooks = animate.indexOf('for (const fn of beforeRenderHooks) fn()');
    const decision = animate.indexOf('const renderFrame = shouldRenderWorldFrame');
    const render = animate.indexOf('renderer.render(scene, camera)', decision);
    assert.ok(hooks >= 0 && decision > hooks && render > decision);
    const branch = animate.slice(decision, animate.indexOf('const frameGpuAttribution', decision));
    assert.match(branch, /worldBuilding: isWorldBuilding\(\)/);
    assert.match(branch, /else \{[\s\S]*restoreAbsoluteRenderCoordinates\(\)/);
    assert.match(branch, /if \(renderFrame\) \{[\s\S]*for \(const fn of afterRenderHooks\) fn\(\)/);
});
