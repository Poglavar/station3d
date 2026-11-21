import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const skySource = readFileSync(new URL('../scene/sky.js', import.meta.url), 'utf8');

test('page-lifetime sky resources initialize immediately after the scene renderer', () => {
    assert.match(
        skySource,
        /export function initializeSkyEnvironment\(\)\s*\{[\s\S]*?updateSky\(\);[\s\S]*?return !!envRenderTarget;/,
    );

    const initialization = indexSource.slice(
        indexSource.indexOf('function ensureInitialized()'),
        indexSource.indexOf('function activateRendererLifecycle()'),
    );
    const sceneOffset = initialization.indexOf('initScene(containerEl)');
    const environmentOffset = initialization.indexOf('initializeSkyEnvironment()');
    const interactionOffset = initialization.indexOf('bindCameraLook(renderer.domElement)');

    assert.ok(sceneOffset >= 0, 'scene initialisation remains explicit');
    assert.ok(environmentOffset > sceneOffset, 'environment follows renderer creation');
    assert.ok(
        environmentOffset < interactionOffset,
        'environment is ready before session/input lifecycle wiring begins',
    );
});
