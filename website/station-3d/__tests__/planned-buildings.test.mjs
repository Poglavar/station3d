// Planned buildings: the provider request around the session start, and the provider's outlines
// becoming one building proposal — drawn only at a known height.
import test from 'node:test';
import assert from 'node:assert/strict';
import { plannedBuildingsProposal, plannedBuildingsUrl } from '../core/planned-buildings.js';

const provider = (plannedBuildings, apiBaseUrl = 'https://world.example/api/') => ({
    apiBaseUrl,
    worldProfile: { id: 'example', plannedBuildings },
});
const square = [[[16, 45.8], [16.001, 45.8], [16.001, 45.801], [16, 45.801], [16, 45.8]]];

test('the request covers ±radius around the start, below the provider base', () => {
    const url = new URL(plannedBuildingsUrl(provider({ endpoint: '/plans/future-buildings', radiusM: 1113.2 }), 45, 16));
    assert.equal(url.origin + url.pathname, 'https://world.example/api/plans/future-buildings');
    const [west, south, east, north] = url.searchParams.get('bbox').split(',').map(Number);
    assert.ok(Math.abs(south - 44.99) < 1e-6 && Math.abs(north - 45.01) < 1e-6, 'latitude ±0.01° for 1,113.2 m');
    assert.ok(Math.abs((east - west) / 2 - 0.01 / Math.cos(Math.PI / 4)) < 1e-6, 'longitude widened by 1/cos(lat)');
    const defaults = new URL(plannedBuildingsUrl(provider({ endpoint: 'plans' }), 45, 16)).searchParams.get('bbox').split(',').map(Number);
    assert.ok(Math.abs((defaults[3] - defaults[1]) / 2 * 111320 - 1500) < 1, 'default radius 1,500 m');
});

test('no request when the world offers no planned buildings or the start is unknown', () => {
    assert.equal(plannedBuildingsUrl(provider(undefined), 45, 16), null);
    assert.equal(plannedBuildingsUrl(provider({ endpoint: '' }), 45, 16), null);
    assert.equal(plannedBuildingsUrl(provider({ endpoint: 'plans' }, null), 45, 16), null);
    assert.equal(plannedBuildingsUrl(provider({ endpoint: 'plans' }), null, 16), null, 'a missing latitude is not 0');
    assert.equal(plannedBuildingsUrl(provider({ endpoint: 'plans' }), 45, Number.NaN), null);
    assert.equal(plannedBuildingsUrl(null, 45, 16), null);
});

test('outlines with a known height become one building proposal; unknown heights are left out', () => {
    const proposal = plannedBuildingsProposal({
        type: 'FeatureCollection',
        features: [
            { type: 'Feature', geometry: { type: 'Polygon', coordinates: square }, properties: { kind: 'estimated', storeys: 9, height_m: 33 } },
            { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [square] }, properties: { height_m: 21 } },
            { type: 'Feature', geometry: { type: 'Polygon', coordinates: square }, properties: { kind: 'projection', height_m: null } },
            { type: 'Feature', geometry: { type: 'Polygon', coordinates: square }, properties: { height_m: 0 } },
            { type: 'Feature', geometry: { type: 'Point', coordinates: [16, 45.8] }, properties: { height_m: 10 } },
            { type: 'Feature', geometry: null, properties: { height_m: 10 } },
        ],
    });
    assert.equal(proposal.goal, 'buildings');
    assert.deepEqual(proposal.geometry.buildings.map(feature => feature.properties.height), [33, 21]);
    assert.equal(proposal.geometry.buildings[1].geometry.type, 'MultiPolygon');
    assert.equal(plannedBuildingsProposal({ features: [] }), null);
    assert.equal(plannedBuildingsProposal(null), null);
});
