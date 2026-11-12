// Planned buildings: the provider request around the session start, and the provider's outlines
// becoming one building proposal — drawn only at a known height.
import test from 'node:test';
import assert from 'node:assert/strict';
import { plannedBuildingsProposal, plannedBuildingsUrl, plannedMeshFeatures, plannedModelUrl } from '../core/planned-buildings.js';
import { proposalBuildingFeaturesByTile } from '../core/proposal-building-features.js';

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

test('a model reference is carried as an absolute mesh URL; outlines keep masking and falling back', () => {
    const proposal = plannedBuildingsProposal({
        features: [
            { type: 'Feature', geometry: { type: 'Polygon', coordinates: square }, properties: { height_m: 23.4, model_url: 'buildings/towers/x/mesh' } },
            { type: 'Feature', geometry: { type: 'Polygon', coordinates: square }, properties: { height_m: 94.5, model_url: 'https://models.example/x.json' } },
            { type: 'Feature', geometry: { type: 'Polygon', coordinates: square }, properties: { height_m: 10, model_url: 42 } },
        ],
    }, { apiBaseUrl: 'https://world.example/api/' });
    assert.deepEqual(proposal.geometry.buildings.map(feature => feature.properties.meshUrl),
        ['https://world.example/api/buildings/towers/x/mesh', 'https://models.example/x.json', undefined]);
    assert.deepEqual(proposal.geometry.buildings.map(feature => feature.properties.height), [23.4, 94.5, 10]);
    assert.equal(plannedModelUrl('buildings/towers/x/mesh', null), null, 'a path with no base is no model');
    assert.equal(plannedModelUrl('  ', 'https://world.example/api'), null);
});

test('a modelled mesh answer becomes namespaced proposal-building features with their stated material', () => {
    const triangle = [[[[16, 45.8, 120], [16.0001, 45.8, 120], [16, 45.8001, 125], [16, 45.8, 120]]]];
    const features = plannedMeshFeatures({
        landmark_id: 'heinzelova-70a',
        features: [
            { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: triangle },
                properties: { source: 'landmark', object_id: '17', z_min: 111.06, material: { kind: 'solid', color: 'eceee9' } } },
            { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: triangle }, properties: { object_id: '18' } },
            { type: 'Feature', geometry: { type: 'Polygon', coordinates: square }, properties: { object_id: '19', material: {} } },
        ],
    }, 'https://world.example/api/buildings/towers/heinzelova-70a/mesh');
    assert.equal(features.length, 1, 'only stated-material triangle sets are drawable');
    assert.deepEqual(features[0].properties, {
        source: 'planned', object_id: 'heinzelova-70a:17', z_min: 111.06,
        material: { kind: 'solid', color: 'eceee9' }, __proposalBuilding: true,
    });
    assert.equal(plannedMeshFeatures({ features: [] }, 'u'), null);
    assert.equal(plannedMeshFeatures(null, 'u'), null);
});

test('mesh-backed outlines leave the solid extrusion unless picked out as the fallback, with stable ids', () => {
    const buildings = [
        { ring: square[0], heightM: 23.4, meshUrl: 'm' },
        { ring: square[0], heightM: 9 },
        { ring: square[0], heightM: 94.5, meshUrl: 'm' },
        { ring: square[0], heightM: 30, modelUrl: 'g.glb' },
    ];
    const ids = byTile => [...byTile.values()].flat().map(feature => feature.properties.object_id).sort();
    const options = { anchorLat: 45.8, anchorLon: 16 };
    assert.deepEqual(ids(proposalBuildingFeaturesByTile(buildings, options)), ['proposal-building:1']);
    assert.deepEqual(ids(proposalBuildingFeaturesByTile(buildings, { ...options, select: b => b.meshUrl === 'm' })),
        ['proposal-building:0', 'proposal-building:2']);
});
