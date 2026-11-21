import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../world/cars.js', import.meta.url), 'utf8')
    + readFileSync(new URL('../models/vehicles/road-vehicles.js', import.meta.url), 'utf8');

test('traffic eviction disposes instance resources while preserving shared caches', () => {
    const disposer = source.slice(
        source.indexOf('function disposeCarRuntimeResources'),
        source.indexOf('function distanceToCamera'),
    );
    assert.match(disposer, /disposeCarHealthBar\(car\);/);
    assert.match(disposer, /disposeGroup\(car\.mesh\);/);
});

test('traffic session teardown clears every lazy vehicle resource family', () => {
    const lifecycle = source.slice(source.indexOf('endSession() {'));
    assert.match(lifecycle, /disposeWreckDriverAnims\(\);[\s\S]*for \(const car of globalCars\)/);
    assert.match(lifecycle, /_decalMaterials\.clear\(\);/);
    assert.match(lifecycle, /_decalTextureCache\.clear\(\);/);
    assert.match(lifecycle, /smokeGeometry = smokeMaterialTemplate = null;/);
    assert.match(lifecycle, /bulletHoleGeometry = bulletHoleMaterial = null;/);
    assert.match(lifecycle, /disposeBicycleSessionCaches\(\);/);
});
