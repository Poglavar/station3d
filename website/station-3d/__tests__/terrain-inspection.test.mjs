// Verifies exact restoration and live-stream enforcement of terrain-only mode.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { createTerrainInspectionController } from '../core/terrain-inspection.js';

test('terrain inspection cycles overlay, terrain-only, then restores the world', () => {
    const scene = new THREE.Scene();
    const terrain = new THREE.Group();
    const terrainMaterial = new THREE.MeshBasicMaterial({ color: 0x112233 });
    const wireframe = new THREE.MeshBasicMaterial({ wireframe: true });
    const tile = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), terrainMaterial);
    const roads = new THREE.Group();
    const hiddenBuildings = new THREE.Group();
    hiddenBuildings.visible = false;
    terrain.add(tile);
    scene.add(terrain, roads, hiddenBuildings);
    const controller = createTerrainInspectionController({
        targetSceneProvider: () => scene,
        terrainGroupProvider: () => terrain,
        wireframeMaterial: wireframe,
    });

    assert.deepEqual(controller.toggle(), {
        changed: true,
        enabled: true,
        mode: 'overlay',
    });
    assert.equal(controller.getMode(), 'overlay');
    assert.equal(terrain.visible, true);
    assert.equal(roads.visible, false);
    assert.equal(hiddenBuildings.visible, false);
    assert.equal(tile.material, terrainMaterial);
    assert.equal(tile.children.length, 1);
    assert.equal(tile.children[0].material, wireframe);

    assert.deepEqual(controller.toggle(), {
        changed: true,
        enabled: true,
        mode: 'only',
    });
    assert.equal(roads.visible, false);
    assert.equal(tile.children.length, 0);
    assert.equal(tile.material, wireframe);

    assert.deepEqual(controller.toggle(), {
        changed: true,
        enabled: false,
        mode: 'normal',
    });
    assert.equal(roads.visible, true);
    assert.equal(hiddenBuildings.visible, false);
    assert.equal(tile.material, terrainMaterial);
});

test('terrain inspection catches streamed layers, tiles and material changes in both modes', () => {
    const scene = new THREE.Scene();
    const terrain = new THREE.Group();
    const original = new THREE.MeshBasicMaterial({ color: 0x111111 });
    const refreshed = new THREE.MeshBasicMaterial({ color: 0x222222 });
    const streamedMaterial = new THREE.MeshBasicMaterial({ color: 0x333333 });
    const wireframe = new THREE.MeshBasicMaterial({ wireframe: true });
    const firstTile = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), original);
    terrain.add(firstTile);
    scene.add(terrain);
    const controller = createTerrainInspectionController({
        targetSceneProvider: () => scene,
        terrainGroupProvider: () => terrain,
        wireframeMaterial: wireframe,
    });
    controller.toggle();

    const streamedRoads = new THREE.Group();
    const secondTile = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), streamedMaterial);
    firstTile.material = refreshed;
    terrain.add(secondTile);
    scene.add(streamedRoads);
    controller.enforce();
    assert.equal(streamedRoads.visible, false);
    assert.equal(firstTile.material, refreshed);
    assert.equal(firstTile.children[0].material, wireframe);
    assert.equal(secondTile.children[0].material, wireframe);

    controller.toggle();
    assert.equal(streamedRoads.visible, false);
    assert.equal(firstTile.material, wireframe);
    assert.equal(secondTile.material, wireframe);

    firstTile.material = refreshed;
    controller.enforce();

    controller.reset();
    assert.equal(streamedRoads.visible, true);
    assert.equal(firstTile.material, refreshed);
    assert.equal(secondTile.material, streamedMaterial);
});

test('terrain inspection reports an unavailable terrain without changing the scene', () => {
    const scene = new THREE.Scene();
    const world = new THREE.Group();
    scene.add(world);
    const controller = createTerrainInspectionController({
        targetSceneProvider: () => scene,
        terrainGroupProvider: () => null,
    });
    assert.deepEqual(controller.toggle(), {
        changed: false,
        enabled: false,
        mode: 'normal',
        reason: 'unavailable',
    });
    assert.equal(world.visible, true);
});

test('terrain inspection resolves a scene created after controller construction', () => {
    let scene = null;
    const terrain = new THREE.Group();
    terrain.add(new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial(),
    ));
    const controller = createTerrainInspectionController({
        targetSceneProvider: () => scene,
        terrainGroupProvider: () => terrain,
        wireframeMaterial: new THREE.MeshBasicMaterial({ wireframe: true }),
    });
    scene = new THREE.Scene();
    const roads = new THREE.Group();
    scene.add(terrain, roads);

    controller.toggle();
    controller.toggle();
    assert.equal(terrain.visible, true);
    assert.equal(roads.visible, false);
});
