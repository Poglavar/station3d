// Covers the browser-independent layer registry used by Shift+click scene
// diagnostics: ownership lookup, reversible visibility, hit deduplication,
// and safe serialization of producer metadata.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import {
    absoluteInspectionPoint,
    collectInspectionLayers,
    compactInspectionReport,
    distinctInspectionHits,
    enforceInspectionLayerVisibility,
    formatInspectionReport,
    groupInspectionLayers,
    hiddenInspectionLayerIds,
    inspectionLayerForObject,
    isEffectivelyVisible,
    markInspectionLayer,
    resetInspectionLayerVisibility,
    releaseInspectionLayerObjects,
    setInspectionLayerVisible,
    setInspectionLayersVisible,
    subscribeInspectionLayerVisibility,
    summarizeInspectionUserData,
} from '../core/scene-inspection.js';

test('inspection visibility subscriptions report immutable changes once', () => {
    resetInspectionLayerVisibility();
    const scene = new THREE.Scene();
    const roads = markInspectionLayer(new THREE.Group(), { id: 'subscription-roads' });
    const terrain = markInspectionLayer(new THREE.Group(), { id: 'subscription-terrain' });
    scene.add(roads, terrain);
    const snapshots = [];
    const unsubscribe = subscribeInspectionLayerVisibility((ids) => {
        snapshots.push(ids);
        assert.equal(Object.isFrozen(ids), true);
        assert.throws(() => ids.push('mutated'), TypeError);
    });

    setInspectionLayerVisible(scene, 'subscription-roads', false);
    setInspectionLayerVisible(scene, 'subscription-roads', false);
    setInspectionLayersVisible(scene, ['subscription-roads', 'subscription-terrain'], false);
    setInspectionLayersVisible(scene, ['subscription-roads'], false);
    setInspectionLayersVisible(scene, ['subscription-roads', 'subscription-terrain'], true);
    resetInspectionLayerVisibility(scene);
    resetInspectionLayerVisibility(scene);
    unsubscribe();
    setInspectionLayerVisible(scene, 'subscription-roads', false);
    resetInspectionLayerVisibility(scene);

    assert.deepEqual(snapshots, [
        ['subscription-roads'],
        ['subscription-roads', 'subscription-terrain'],
        [],
    ]);
});

test('raycast points are restored from floating-render to absolute local coordinates', () => {
    const rebased = absoluteInspectionPoint(
        { x: -223.086, y: 1.516, z: 320.386 },
        { x: -2000, z: 100 },
    );
    assert.ok(Math.abs(rebased.x - (-2223.086)) < 1e-9);
    assert.equal(rebased.y, 1.516);
    assert.equal(rebased.z, 420.386);
    assert.deepEqual(
        absoluteInspectionPoint({ x: 4, y: 2, z: -3 }),
        { x: 4, y: 2, z: -3 },
    );
    assert.equal(absoluteInspectionPoint({ x: NaN, y: 2, z: -3 }), null);
});

function mesh(name = 'Surface') {
    const object = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
    object.name = name;
    return object;
}

test('scene inspection resolves layer ownership and registers legacy roots', () => {
    const scene = new THREE.Scene();
    const roads = markInspectionLayer(new THREE.Group(), {
        id: 'road-asphalt',
        label: 'Road asphalt',
        source: 'world/roads.js',
        category: 'Roads',
        order: 20,
    });
    const surface = mesh('RoadSurface:primary');
    roads.add(surface);

    const hiddenTerrain = markInspectionLayer(new THREE.Group(), {
        id: 'terrain',
        label: 'Terrain',
        source: 'world/terrain.js',
        category: 'Terrain',
        order: 10,
    });
    hiddenTerrain.visible = false;
    const tile = mesh('TerrainTile:0:0');
    hiddenTerrain.add(tile);

    const legacy = new THREE.Group();
    legacy.name = 'OneOffDebugGeometry';
    legacy.add(mesh());
    scene.add(roads, hiddenTerrain, legacy);

    assert.equal(inspectionLayerForObject(surface).id, 'road-asphalt');
    assert.equal(inspectionLayerForObject(surface).root, roads);
    assert.equal(isEffectivelyVisible(surface), true);
    assert.equal(isEffectivelyVisible(tile), false);

    const layers = collectInspectionLayers(scene);
    assert.deepEqual(layers.map(layer => layer.id).slice(0, 2), ['terrain', 'road-asphalt']);
    assert.equal(layers.find(layer => layer.id === 'road-asphalt').objectCount, 1);
    assert.equal(layers.find(layer => layer.id === 'terrain').visibleObjectCount, 0);
    assert.equal(layers.find(layer => layer.category === 'Unregistered').label, 'OneOffDebugGeometry');
});

test('layer visibility restores original state and applies to streamed roots', () => {
    const scene = new THREE.Scene();
    const visibleRoads = markInspectionLayer(new THREE.Group(), {
        id: 'roads', label: 'Roads', source: 'roads.js', category: 'Roads',
    });
    const alreadyHiddenRoads = markInspectionLayer(new THREE.Group(), {
        id: 'roads', label: 'Roads', source: 'roads.js', category: 'Roads',
    });
    alreadyHiddenRoads.visible = false;
    scene.add(visibleRoads, alreadyHiddenRoads);

    assert.equal(setInspectionLayerVisible(scene, 'roads', false), 2);
    assert.equal(visibleRoads.visible, false);
    assert.equal(alreadyHiddenRoads.visible, false);
    assert.deepEqual([...hiddenInspectionLayerIds()], ['roads']);

    const streamedRoads = markInspectionLayer(new THREE.Group(), {
        id: 'roads', label: 'Roads', source: 'roads.js', category: 'Roads',
    });
    const streamedRoadPart = markInspectionLayer(new THREE.Group(), {
        id: 'roads', label: 'Roads', source: 'roads.js', category: 'Roads',
    });
    streamedRoads.add(streamedRoadPart);
    scene.add(streamedRoads);
    assert.equal(streamedRoads.visible, false);
    assert.equal(streamedRoadPart.visible, false);
    visibleRoads.visible = true;
    assert.equal(enforceInspectionLayerVisibility(), 1);
    assert.equal(visibleRoads.visible, false);
    scene.remove(streamedRoads);

    assert.equal(resetInspectionLayerVisibility(scene), 4);
    assert.equal(visibleRoads.visible, true);
    assert.equal(alreadyHiddenRoads.visible, false);
    assert.equal(streamedRoads.visible, true);
    assert.equal(streamedRoadPart.visible, true);
    assert.deepEqual([...hiddenInspectionLayerIds()], []);
});

test('inspection layers group by topic with tri-state bulk visibility', () => {
    const layers = [
        { id: 'terrain', category: 'Ground', enabled: true },
        { id: 'roads', category: 'Transport', enabled: true },
        { id: 'curbs', category: 'Transport', enabled: false },
        { id: 'legacy', category: '', enabled: true },
    ];

    const topics = groupInspectionLayers(layers);
    assert.deepEqual(topics.map(topic => topic.category), ['Ground', 'Transport', 'Other']);
    assert.deepEqual(topics[1].layers.map(layer => layer.id), ['roads', 'curbs']);
    assert.equal(topics[0].allEnabled, true);
    assert.equal(topics[0].partiallyEnabled, false);
    assert.equal(topics[1].allEnabled, false);
    assert.equal(topics[1].partiallyEnabled, true);

    const scene = new THREE.Scene();
    const roads = markInspectionLayer(new THREE.Group(), {
        id: 'roads', label: 'Roads', category: 'Transport', source: 'roads.js',
    });
    const curbs = markInspectionLayer(new THREE.Group(), {
        id: 'curbs', label: 'Curbs', category: 'Transport', source: 'curbs.js',
    });
    scene.add(roads, curbs);

    assert.equal(setInspectionLayersVisible(scene, ['roads', 'curbs', 'roads'], false), 2);
    assert.equal(roads.visible, false);
    assert.equal(curbs.visible, false);
    assert.deepEqual([...hiddenInspectionLayerIds()].sort(), ['curbs', 'roads']);
    assert.equal(setInspectionLayersVisible(scene, ['roads', 'curbs'], true), 2);
    assert.equal(roads.visible, true);
    assert.equal(curbs.visible, true);
    assert.deepEqual([...hiddenInspectionLayerIds()], []);
});

test('distinct inspection hits preserves ordering and separates instances', () => {
    const object = mesh();
    const hits = [
        { object, distance: 4, point: new THREE.Vector3(0, 12, 0), instanceId: 1 },
        { object, distance: 4.005, point: new THREE.Vector3(0, 11.995, 0), instanceId: 1 },
        { object, distance: 4.006, point: new THREE.Vector3(0, 11.994, 0), instanceId: 2 },
        { object, distance: 4.04, point: new THREE.Vector3(0, 11.96, 0), instanceId: 1 },
    ];
    const snapshot = [...hits];

    const cameraHits = distinctInspectionHits(hits);
    const heightHits = distinctInspectionHits(hits, { measure: 'height' });

    assert.deepEqual(hits, snapshot);
    assert.deepEqual(cameraHits, [hits[0], hits[2], hits[3]]);
    assert.deepEqual(heightHits, [hits[0], hits[2], hits[3]]);
});

test('distinct inspection hits retains overlapping owners inside one aggregate mesh', () => {
    const object = mesh();
    object.userData.entityRanges = [
        { start: 0, count: 3, key: 'osm:way/1' },
        { start: 3, count: 3, key: 'osm:way/2' },
    ];
    const hits = [
        { object, faceIndex: 0, face: { materialIndex: 0 }, distance: 4, point: new THREE.Vector3(0, 2, 0) },
        { object, faceIndex: 1, face: { materialIndex: 0 }, distance: 4, point: new THREE.Vector3(0, 2, 0) },
    ];

    assert.deepEqual(distinctInspectionHits(hits), hits);
});

test('inspection metadata summaries are finite and cycle-safe', () => {
    const circular = { name: 'feature-7' };
    circular.self = circular;
    const userData = {
        circular,
        positions: new Float32Array([1, 2, 3]),
        owner: mesh('Owner'),
        callback() {},
    };

    const summary = summarizeInspectionUserData(userData);
    assert.equal(summary.circular.name, 'feature-7');
    assert.equal(summary.circular.self, '[circular Object]');
    assert.equal(summary.positions, '[Float32Array 3]');
    assert.match(summary.owner, /^\[Mesh Owner/);
    assert.equal(summary.callback, '[function callback]');
    assert.doesNotThrow(() => formatInspectionReport({ userData: summary }));
    assert.doesNotThrow(() => formatInspectionReport(null));
});

test('copy report keeps selected transport evidence while omitting the global registry', () => {
    const selectedHit = {
        index: 5,
        layer: {
            id: 'road-structures-other',
            label: 'Other road structures',
            category: 'Civil works',
            source: 'world/road-grade-separations.js',
        },
        object: {
            name: 'RoadAlignmentSurface:osm-composite-split-lower-35866854',
            type: 'Mesh',
            uuid: 'diagnostically-useless-uuid',
            path: ['Scene', 'RoadGradeSeparations', 'RoadAlignmentSurface'],
            visible: true,
            renderOrder: 0,
        },
        feature: {
            key: 'osm:way:35866854',
            objectId: null,
            metadata: {
                name: 'Miramarski podvožnjak',
                tags: { highway: 'tertiary', maxheight: '3.65' },
            },
        },
        surface: { point: { x: -5, y: -4.8, z: -132 }, faceIndex: 19 },
        roadVerticalAlignment: {
            id: 'osm-composite-split-lower-35866854',
            crossingUpperOsmIds: ['207567941', '739579926'],
        },
        material: {
            type: 'MeshStandardMaterial',
            uuid: 'material-uuid',
            color: '#ffffff',
            shaderHooks: {
                groundHoleMask: true,
                unused: 'x'.repeat(10_000),
            },
        },
        surfaceClaim: {
            ownerId: 'RoadGradeSeparation:osm-composite-split-lower-35866854',
            replacementKey: 'roads:structure:osm-composite-split-lower-35866854',
        },
        surfacePublication: {
            key: 'roads:structure:osm-composite-split-lower-35866854',
            generation: 8,
            activeGeneration: 8,
            status: 'active-owner',
        },
        renderRole: 'visible color surface',
        userData: { entityRanges: Array.from({ length: 2_000 }, () => ({ unused: true })) },
    };
    const active = Array.from({ length: 1_600 }, (_, index) => ({
        key: index === 900
            ? 'roads:structure:osm-composite-split-lower-35866854'
            : `buildings:aggregate:${index}`,
        generation: index,
        rootName: `Aggregate:${index}`,
        meshCount: 1,
        claimCount: 1,
        surfaceClasses: [index === 900 ? 'structure' : 'building'],
        ownerIds: [index === 900
            ? 'RoadGradeSeparation:osm-composite-split-lower-35866854'
            : `building:${index}`],
    }));
    const report = {
        generatedAt: '2026-08-21T14:43:09.201Z',
        selectedPoint: { local: { x: -5, y: -4.8, z: -132 } },
        cameraRayHits: [selectedHit],
        verticalSurfaceStack: [selectedHit],
        selectedSurface: selectedHit,
        groundOwnershipMask: {
            enabled: true,
            publishedRevision: '12|4',
            activeRevision: '12|4',
        },
        surfacePublications: {
            contract: 'station3d-surface-publications-v1',
            activeCount: active.length,
            pendingCount: 0,
            active,
            counters: { published: 1_945, failed: 0 },
            recentProblems: [],
        },
        layers: [
            { ...selectedHit.layer, enabled: true, objectCount: 38, visibleObjectCount: 38 },
            {
                id: 'rail-trackbed',
                label: 'Rail trackbed',
                enabled: true,
                objectCount: 0,
                visibleObjectCount: 0,
            },
            { id: 'buildings', label: 'Buildings', enabled: true, objectCount: 900 },
        ],
        hiddenLayerIds: [],
    };

    const compact = compactInspectionReport(report);
    assert.equal(compact.surfacePublications.active.length, 1);
    assert.equal(compact.surfacePublications.active[0].key, selectedHit.surfacePublication.key);
    assert.deepEqual(compact.layers.map(layer => layer.id), [
        'road-structures-other',
        'rail-trackbed',
    ]);
    assert.equal(compact.selectedSurface.object.uuid, undefined);
    assert.equal(compact.selectedSurface.material.shaderHooks.groundHoleMask, true);
    assert.equal(compact.groundOwnershipMask.enabled, true);
    assert.equal(compact.groundOwnershipMask.activeRevision, '12|4');
    assert.equal(compact.selectedSurface.material.shaderHooks.unused, undefined);
    assert.deepEqual(
        compact.selectedSurface.roadVerticalAlignment.crossingUpperOsmIds,
        ['207567941', '739579926'],
    );

    const text = formatInspectionReport(report);
    const copied = JSON.parse(text);
    assert.ok(text.length < 60_000, `copy payload is ${text.length} characters`);
    assert.equal(copied.copySummary.characters, text.length);
    assert.equal(copied.copySummary.original.activeSurfacePublications, 1_600);
    assert.equal(copied.selectedSurface.feature.metadata.tags.maxheight, '3.65');
    assert.doesNotMatch(text, /buildings:aggregate:1599/);
});

test('retiring a hidden paint metadata root releases its objects but preserves the category choice', () => {
    resetInspectionLayerVisibility();
    const scene = new THREE.Scene();
    const root = new THREE.Group();
    scene.add(root);
    markInspectionLayer(root, {id:'landuse-green'});
    setInspectionLayerVisible(scene, 'landuse-green', false);
    assert.equal(root.visible, false);
    releaseInspectionLayerObjects(root);
    root.removeFromParent();
    assert.equal(root.visible, true);
    assert.equal(hiddenInspectionLayerIds().has('landuse-green'), true);
    assert.equal(resetInspectionLayerVisibility(), 0, 'the retired root is no longer retained');
});
