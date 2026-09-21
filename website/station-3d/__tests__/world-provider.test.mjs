import assert from 'node:assert/strict';
import test from 'node:test';

import {
    configureWorldProvider,
    createWorldProviderConfiguration,
    getApiBase,
    getWorldAttributions,
    getWorldProvider,
    worldProviderContains,
} from '../core/api.js';

test('default world provider is neutral, immutable, and same-origin', () => {
    const provider = createWorldProviderConfiguration();
    assert.deepEqual(provider, {
        id: 'default-http',
        apiBaseUrl: '/api',
        attributions: [],
        bounds: null,
        worldProfile: null,
    });
    assert.equal(Object.isFrozen(provider), true);
    assert.equal(Object.isFrozen(provider.attributions), true);
});

test('configured provider normalizes its base and owns immutable attribution', () => {
    const source = [{
        name: 'OpenStreetMap contributors',
        url: 'https://www.openstreetmap.org/copyright',
        license: 'ODbL 1.0',
        licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
    }];
    const provider = configureWorldProvider({
        id: 'osm-demo',
        apiBaseUrl: 'https://world.example/api///',
        attributions: source,
    });

    source[0].name = 'changed outside';
    assert.equal(provider.apiBaseUrl, 'https://world.example/api');
    assert.equal(getApiBase(), 'https://world.example/api');
    assert.equal(getWorldProvider(), provider);
    assert.equal(getWorldAttributions()[0].name, 'OpenStreetMap contributors');
    assert.equal(Object.isFrozen(provider.attributions[0]), true);

    configureWorldProvider();
});

test('provider rejects ambiguous bases and malformed attribution', () => {
    assert.throws(() => createWorldProviderConfiguration({ apiBaseUrl: 'api' }), /root-relative or HTTP/);
    assert.throws(() => createWorldProviderConfiguration({ id: 'not an id' }), /id is invalid/);
    assert.throws(() => createWorldProviderConfiguration({ attributions: [{}] }), /requires a name/);
    assert.throws(() => createWorldProviderConfiguration({
        attributions: [{ name: 'source', url: '/relative' }],
    }), /absolute URL/);
});

test('provider owns its world profile and applies optional geographic bounds', () => {
    const worldProfile = { id: 'demo', terrain: { surfaceStyle: 'grass' } };
    const provider = configureWorldProvider({
        id: 'bounded-demo',
        bounds: { west: 2, south: 48, east: 3, north: 49 },
        worldProfile,
    });
    worldProfile.terrain.surfaceStyle = 'changed-outside';
    assert.equal(provider.worldProfile.terrain.surfaceStyle, 'grass');
    assert.equal(Object.isFrozen(provider.worldProfile.terrain), true);
    assert.equal(worldProviderContains(48.5, 2.5), true);
    assert.equal(worldProviderContains(50, 2.5), false);
    assert.equal(worldProviderContains('bad', 2.5), false);
    assert.throws(() => createWorldProviderConfiguration({
        bounds: { west: 4, south: 48, east: 3, north: 49 },
    }), /bounds are invalid/);
    configureWorldProvider();
    assert.equal(worldProviderContains(-80, 170), true);
});
