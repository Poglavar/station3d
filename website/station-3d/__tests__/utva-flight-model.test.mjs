import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createUtvaAirplaneMesh } from '../models/vehicles/utva-airplane.js';
import { createAirplaneBreakupController } from '../models/vehicles/airplane-breakup.js';

const bytes = fs.readFileSync(new URL('../models/vehicles/utva-liaison.glb', import.meta.url));
const { scene: source } = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');

test('the flying UTVA faces +Z, removes only the baked pilot, and owns its geometry', () => {
    const originalPose = source.getObjectByName('UTVA_Liaison').matrix.clone();
    const aircraft = createUtvaAirplaneMesh(source, { interior: 'smuggler' });
    const other = createUtvaAirplaneMesh(source, { interior: 'smuggler' });
    assert.deepEqual(source.getObjectByName('UTVA_Liaison').matrix.elements, originalPose.elements, 'parked source remains untouched');
    assert.equal(aircraft.getObjectByName('Pilot'), undefined, 'the live player replaces the baked pilot');
    assert.deepEqual(aircraft.userData.pilotSeat.position.toArray(), [.24, .56, 1.28]);
    assert.deepEqual(aircraft.userData.propeller.position.toArray(), [0, 1.2, 4.02]);
    const sizes = aircraft.userData.dimensions;
    assert.ok(sizes.width > 10.7 && sizes.width < 10.9);
    assert.ok(sizes.length > 8.4 && sizes.length < 8.6);
    const meshes = [];
    aircraft.traverse(node => { if (node.isMesh) meshes.push(node); });
    assert.ok(meshes.length <= 40, 'repeated opaque geometry is batched');
    assert.ok(meshes.some(node => node.name.includes('Cargo_')));
    assert.equal(meshes.filter(node => node.material.transparent).length, 7, 'curved panes remain individually sortable');
    for (const mesh of meshes) {
        const twin = other.getObjectByName(mesh.name);
        assert.notEqual(mesh.geometry, twin.geometry, 'disposing an aircraft cannot invalidate another');
        assert.notEqual(mesh.material, twin.material);
    }
    const nose = new THREE.Box3().setFromObject(aircraft.userData.propeller);
    assert.ok(nose.min.z > 3.8, 'nose points along the flight solver forward axis');
    const tail = new THREE.Box3().setFromObject(aircraft.getObjectByName('GtaAirplaneRoundedTailplane'));
    assert.ok(tail.max.z < -2.5);
});

test('the UTVA propeller spins around its hub and participates in the shared crash lifecycle', () => {
    const aircraft = createUtvaAirplaneMesh(source, { interior: 'smuggler' });
    const propeller = aircraft.userData.propeller;
    const hub = propeller.position.clone();
    const blade = propeller.children[0];
    const before = blade.localToWorld(new THREE.Vector3(.4, .5, 0));
    propeller.rotation.z = Math.PI / 2;
    const after = blade.localToWorld(new THREE.Vector3(.4, .5, 0));
    assert.ok(before.distanceTo(after) > .2, 'blade actually rotates');
    assert.ok(Math.abs(before.distanceTo(hub) - after.distanceTo(hub)) < 1e-6, 'hub does not orbit');
    const wing = aircraft.getObjectByName('GtaAirplaneRoundedMainWing');
    const wingStart = wing.position.clone();
    const crash = createAirplaneBreakupController(aircraft);
    crash.settle();
    assert.ok(wing.position.distanceTo(wingStart) > 1, 'shared breakup moves the UTVA wing');
    crash.reset();
    assert.deepEqual(wing.position.toArray(), wingStart.toArray());
});
