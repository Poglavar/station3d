import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../world/buildings.js', import.meta.url), 'utf8');

test('building teardown disposes procedural maps independently from materials', () => {
    const disposer = source.slice(
        source.indexOf('function disposeBuildingTextureCaches()'),
        source.indexOf('function disposeStatedMaterialFamilies()'),
    );
    for (const cache of [
        '_wallTextures',
        '_wallNormalTextures',
        '_facadeTextures',
        '_facadeEmissiveTextures',
        'overtureWallTextures',
        'newBuildWallTextures',
        'curtainWallTextures',
        'statedBrickTextures',
    ]) {
        assert.match(disposer, new RegExp(cache));
    }
    assert.match(disposer, /unregisterShared\(texture\);[\s\S]*texture\.dispose\(\);/);
});

test('building lifecycle clears material and texture families after scene removal', () => {
    const lifecycle = source.slice(source.indexOf('endSession() {'));
    assert.match(
        lifecycle,
        /clearCloseFacadeDetails\(true\);[\s\S]*disposeStatedMaterialFamilies\(\);[\s\S]*disposeBuildingTextureCaches\(\);/,
    );
});
