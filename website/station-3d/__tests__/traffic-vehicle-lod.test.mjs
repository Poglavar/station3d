// Guards the one-draw distant traffic silhouette and near-detail handoff.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { updateTrafficVehicleLods } from '../models/vehicles/road-vehicles.js';

const source = readFileSync(new URL('../world/cars.js', import.meta.url), 'utf8')
    + readFileSync(new URL('../models/vehicles/road-vehicles.js', import.meta.url), 'utf8');

test('road vehicles tie detailed rendering to quality while keeping interaction full-range', () => {
    assert.match(source, /function trafficDetailRadiusM/);
    assert.match(source, /getRenderQualityContext\(\)\.shadowCasterDistanceM/);
    assert.match(source, /Math\.min\(60, shadowDistance\)/);
    assert.match(source, /function addTrafficVehicleFarLod/);
    assert.match(source, /new THREE\.Mesh\(geometry, bodyMaterial\)/);
    assert.match(source, /detailRoot\.visible = detailed/);
    assert.match(source, /farMesh\.visible = !detailed/);
    assert.match(source, /car\.controlled === true[\s\S]*car\.physicsControlled === true/);
    assert.match(source, /updateTrafficVehicleLods\(local\.x, local\.z,/);
});

test('moving and parked traffic switch detail without replacing the vehicle root', () => {
    const makeCar = distance => {
        const mesh = new THREE.Group();
        mesh.position.x = distance;
        mesh.userData.detailRoot = new THREE.Group();
        mesh.userData.farMesh = new THREE.Group();
        return { mesh };
    };
    const moving = makeCar(59), parked = makeCar(61);
    const original = moving.mesh;
    updateTrafficVehicleLods(0, 0, [moving], new Map([['parked', parked]]), 60);
    assert.equal(moving.mesh.userData.detailRoot.visible, true);
    assert.equal(parked.mesh.userData.farMesh.visible, true);
    moving.mesh.position.x = 61;
    updateTrafficVehicleLods(0, 0, [moving], new Map(), 60);
    assert.equal(moving.mesh, original);
    assert.equal(moving.mesh.userData.detailRoot.visible, false);
    assert.equal(moving.mesh.userData.farMesh.visible, true);
    parked.controlled = true;
    moving.physicsControlled = true;
    updateTrafficVehicleLods(1000, 0, [moving], new Map([['parked', parked]]), 40);
    for (const car of [moving, parked]) {
        assert.equal(car.mesh.userData.detailRoot.visible, true);
        assert.equal(car.mesh.userData.farMesh.visible, false);
    }
});

test('far traffic geometry is shared per vehicle type and cleared on teardown', () => {
    assert.match(source, /farTrafficGeometries = \{\}/);
    assert.match(source, /farTrafficGeometries\[key\] = geometry/);
    assert.match(source, /registerShared\(geometry\)/);
    assert.match(source, /disposeMap\(farTrafficGeometries\)/);
});
