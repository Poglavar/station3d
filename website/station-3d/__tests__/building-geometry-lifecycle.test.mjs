import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from 'three';
import { createStopShelterGroup } from '../models/objects/stop-shelter.js';
import { isShared, registerShared, unregisterShared } from '../core/dispose.js';

const source = readFileSync(new URL('../world/buildings.js', import.meta.url), 'utf8');
const noop = () => {};
const polygon = { type: 'Polygon', coordinates: [[
    [15.9769, 45.8132], [15.97695, 45.8132], [15.97695, 45.81322],
    [15.9769, 45.81322], [15.9769, 45.8132],
]] };

function fixture() {
    const buildingsGroup = new THREE.Group();
    const removed = createStopShelterGroup(polygon, 45.8132, 15.9769, 10);
    const retained = createStopShelterGroup(polygon, 45.8132, 15.9769, 10);
    removed.userData = { tileKey: 'old', objectId: 'shelter', centroidLatLon: { lat: 1, lon: 1 } };
    retained.userData = { tileKey: 'other', centroidLatLon: { lat: 2, lon: 2 } };
    buildingsGroup.add(removed, retained);
    const geometries = new Map(), otherGeometries = new Map(), materials = new Set();
    for (const [root, counts] of [[removed, geometries], [retained, otherGeometries]]) {
        root.traverse((child) => {
            if (child.geometry && !counts.has(child.geometry)) {
                counts.set(child.geometry, 0);
                child.geometry.addEventListener('dispose', () => counts.set(child.geometry, counts.get(child.geometry) + 1));
            }
            if (child.material) materials.add(child.material);
        });
    }
    assert.equal(geometries.size, 6, 'real shelter: five boxes and one geometry shared by four posts');
    let disposedMaterials = 0;
    const onMaterialDispose = () => disposedMaterials++;
    for (const material of materials) material.addEventListener('dispose', onMaterialDispose);
    const unregistered = [];
    const context = vm.createContext({
        isShared, buildingsGroup, contactAoMaskRevision: 0,
        unregisterEntityTree: root => unregistered.push(root), onCountChanged: noop,
        loadedBuildingIds: new Set(['shelter']), buildingEntrances: new Map(), buildingEntranceIndex: new Map(),
        buildingFootprints: new Map(), buildingFootprintIndex: new Map(),
        statedBuildingCollisions: new Map(), statedBuildingCollisionIndex: new Map(),
        unregisterRoofActivityOwner: noop, roofActivityOwnerId: id => id, setDetailed: noop,
        cancelTileBuildJob: noop, buildingGroundDependencies: new Map(), terrainBuildingRebuildCheck: null,
        tileVisualReplacements: new Map(), releaseTileReplacementResources: noop,
        aggregateGate: { forget: noop }, dropOvertureTileState: noop,
        releaseTileBuildingRecords: () => new Set(), setDetailedTile: noop,
        cancelStaticBuildJob: noop, cancelAllTileBuildJobs: noop, clearTileVisualReplacements: noop,
        resetOvertureAggregateState: noop, clearRoofActivitySurfaces: noop,
        STATION3D_QUALITY_PROFILES: { high: {} }, getRenderQualityContext: () => ({ profileId: 'high' }),
        resetBuildingBuildPhaseStats: noop, resetDetailed: noop,
    });
    for (const name of ['disposeBuildingGeometry', 'clearBuildings', 'removeTile',
        'finishTileVisualReplacement', 'pruneBuildingsByMask']) {
        const start = source.indexOf(`function ${name}(`);
        assert.ok(start >= 0, `Missing production function ${name}`);
        vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), context);
    }
    return { context, removed, retained, geometries, otherGeometries, materials, unregistered,
        disposedMaterials: () => disposedMaterials,
        cleanup() { for (const material of materials) material.removeEventListener('dispose', onMaterialDispose); },
    };
}

for (const operation of ['close', 'evict', 'replace', 'mask']) {
    test(`building ${operation} releases nested shelter geometry exactly once and preserves material ownership`, () => {
        const f = fixture();
        try {
            if (operation === 'close') f.context.clearBuildings();
            if (operation === 'evict') f.context.removeTile('old');
            if (operation === 'replace') {
                f.retained.visible = false;
                f.context.tileVisualReplacements.set('old', {
                    retainedChildren: new Set([f.removed]), newChildVisibility: new Map([[f.retained, true]]),
                });
                f.context.finishTileVisualReplacement('old');
                assert.equal(f.retained.visible, true);
            }
            if (operation === 'mask') assert.equal(f.context.pruneBuildingsByMask(lat => lat === 1), 1);
            assert.deepEqual([...f.geometries.values()], [1, 1, 1, 1, 1, 1]);
            assert.equal(f.disposedMaterials(), 0, 'another live shelter uses the same page-owned materials');
            assert.ok([...f.materials].every(isShared));
            assert.ok(!f.context.buildingsGroup.children.includes(f.removed));
            assert.ok([...f.otherGeometries.values()].every(count => count === (operation === 'close' ? 1 : 0)));
            assert.equal(f.context.buildingsGroup.children.includes(f.retained), operation !== 'close');
            if (operation !== 'replace') assert.ok(f.unregistered.includes(f.removed));
        } finally { f.cleanup(); }
    });
}

test('building geometry retirement preserves registered geometry owned outside the removed tree', () => {
    const f = fixture();
    const borrowed = f.geometries.keys().next().value;
    registerShared(borrowed);
    try {
        f.context.clearBuildings();
        assert.equal(f.geometries.get(borrowed), 0);
        assert.equal([...f.geometries.values()].reduce((sum, count) => sum + count, 0), 5);
    } finally { unregisterShared(borrowed); f.cleanup(); }
});
