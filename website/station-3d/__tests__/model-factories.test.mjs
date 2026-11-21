// Exercise extracted model APIs without a browser or a world/scene session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { BUS_PASSENGER_DOORS, ROAD_TRAFFIC_VEHICLE_TYPES } from '../models/vehicles/traffic-vehicle-catalog.js';
import { buildTrafficVehicleMesh, setRoadVehicleNightMode, updateTrafficVehicleLods, disposeRoadVehicleSessionCaches } from '../models/vehicles/road-vehicles.js';
import { createTramMesh, setTramDoorsOpen, updateTramRenderLod, disposeTramSessionCaches } from '../models/vehicles/tram.js';
import { disposeBicycleSessionCaches } from '../models/vehicles/bicycle.js';
import { createBoatMesh } from '../models/vehicles/boat-airplane.js';
import { preloadRoadFleetModels, disposeRoadFleetModels } from '../models/vehicles/road-fleet-models.js';
import { disposeGroup } from '../core/dispose.js';

// The boat wake paints its spray sprite on a canvas; give node a stand-in.
const canvasStub = () => ({
    width: 0, height: 0,
    getContext: () => ({ createRadialGradient: () => ({ addColorStop() {} }), clearRect() {}, fillRect() {}, fillText() {}, beginPath() {}, closePath() {}, stroke() {}, fill() {}, arc() {}, set fillStyle(_v) {}, set strokeStyle(_v) {}, set font(_v) {}, set textAlign(_v) {} }),
});
globalThis.document ??= { createElement: canvasStub, createElementNS: canvasStub };

function finiteModel(group) {
    const box = new THREE.Box3().setFromObject(group);
    assert.ok([...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite));
    assert.ok(box.getSize(new THREE.Vector3()).length() > 1);
    group.traverse(node => {
        for (const attribute of [node.geometry?.attributes.position, node.instanceMatrix]) {
            if (attribute) assert.ok(attribute.array.every(Number.isFinite));
        }
    });
}

function installFleetFetch(t) {
    const previous = globalThis.fetch;
    globalThis.fetch = async url => {
        const id = String(url).split('/').pop();
        const text = await readFile(new URL(`../models/vehicles/fleet/${id}`, import.meta.url), 'utf8');
        return { ok: true, status: 200, json: async () => JSON.parse(text) };
    };
    t.after(() => { globalThis.fetch = previous; });
}

test('all ordinary road-vehicle families construct independently with finite geometry', async t => {
    installFleetFetch(t);
    t.after(disposeRoadVehicleSessionCaches);
    t.after(disposeRoadFleetModels);
    t.after(disposeBicycleSessionCaches);
    const ordinary = ROAD_TRAFFIC_VEHICLE_TYPES.filter(type => type.kind !== 'bicycle');
    await preloadRoadFleetModels(ordinary);
    for (const type of ordinary) {
        finiteModel(buildTrafficVehicleMesh(type, 0x345678));
    }
});

test('road fleet studies have the expected mappings and opaque near detail', async t => {
    installFleetFetch(t);
    t.after(disposeRoadFleetModels);
    const ordinary = ROAD_TRAFFIC_VEHICLE_TYPES.filter(type => type.kind !== 'bicycle');
    await preloadRoadFleetModels(ordinary);
    const expected = new Map([
        ['compact', 'hatchback'], ['sedan', 'sedan'], ['police', 'sedan'],
        ['suv', 'suv'], ['van', 'van'], ['ambulance', 'van'],
        ['truck', 'boxtruck'], ['bus', 'citybus'], ['technical', 'pickup'],
    ]);
    for (const type of ordinary) {
        const detail = buildTrafficVehicleMesh(type, 0x345678);
        assert.equal(detail.userData.fleetStudy, expected.get(type.name), type.name);
        const meshes = [];
        detail.traverse(node => { if (node.isMesh && node.visible) meshes.push(node); });
        if (['compact', 'sedan', 'suv', 'van', 'truck', 'bus'].includes(type.name)) {
            assert.ok(meshes.length <= 5, `${type.name} near draws: ${meshes.length}`);
        }
        const glass = meshes.filter(node => /glass|window/i.test(node.name));
        assert.ok(glass.length > 0, `${type.name} has glass`);
        for (const node of glass) assert.equal(node.material.transparent, false, `${type.name} glass opaque`);
        const zBounds = name => new THREE.Box3().setFromObject(detail.getObjectByName(name)).getCenter(new THREE.Vector3()).z;
        assert.ok(zBounds('TrafficVehicleHeadlights') > 0, `${type.name} front lamps`);
        assert.ok(zBounds('TrafficVehicleTaillights') < 0, `${type.name} rear lamps`);
    }
});

test('FrontSide fleet roofs face outward above sedan and bus interiors', async t => {
    installFleetFetch(t);
    t.after(disposeRoadVehicleSessionCaches);
    t.after(disposeRoadFleetModels);
    const types = ROAD_TRAFFIC_VEHICLE_TYPES.filter(type => ['sedan', 'bus'].includes(type.name));
    await preloadRoadFleetModels(types);
    for (const type of types) {
        const mesh = buildTrafficVehicleMesh(type, 0x345678);
        mesh.updateMatrixWorld(true);
        const targets = ['TrafficVehiclePaintedBody', 'TrafficVehicleWindows']
            .map(name => mesh.getObjectByName(name)).filter(Boolean);
        const bounds = new THREE.Box3();
        for (const target of targets) bounds.expandByObject(target);
        const roofY = bounds.max.y;
        const ray = new THREE.Raycaster(new THREE.Vector3(0.2, roofY + 5, 0), new THREE.Vector3(0, -1, 0));
        const hits = ray.intersectObjects(targets, false);
        assert.ok(hits.some(hit => hit.point.y > roofY - 0.15), `${type.name} ray hits outer roof`);
    }
});

test('emergency lightbar bases sit on the regenerated fleet roofs', async t => {
    installFleetFetch(t);
    t.after(disposeRoadVehicleSessionCaches);
    t.after(disposeRoadFleetModels);
    const types = ROAD_TRAFFIC_VEHICLE_TYPES.filter(type => ['police', 'ambulance'].includes(type.name));
    await preloadRoadFleetModels(types);
    for (const type of types) {
        const mesh = buildTrafficVehicleMesh(type, 0x345678);
        mesh.updateMatrixWorld(true);
        const roof = new THREE.Box3().setFromObject(mesh.getObjectByName('TrafficVehiclePaintedBody'));
        const lightbar = new THREE.Box3().setFromObject(mesh.getObjectByName('TrafficVehicleLightbarBase'));
        assert.ok(lightbar.min.y >= roof.max.y - 0.001, `${type.name} lightbar is not below roof`);
        assert.ok(lightbar.min.y <= roof.max.y + 0.03, `${type.name} lightbar base gap <= 3cm`);
    }
});

test('bus passenger door panels are on the contract right-hand side', async t => {
    installFleetFetch(t);
    t.after(disposeRoadVehicleSessionCaches);
    t.after(disposeRoadFleetModels);
    const bus = ROAD_TRAFFIC_VEHICLE_TYPES.find(type => type.name === 'bus');
    await preloadRoadFleetModels([bus]);
    const mesh = buildTrafficVehicleMesh(bus, 0x345678);
    const windows = mesh.getObjectByName('TrafficVehicleWindows');
    assert.ok(windows, 'bus window mesh exists');
    mesh.updateMatrixWorld(true);
    for (const { z } of BUS_PASSENGER_DOORS) {
        const y = 0.9;
        const rightRay = new THREE.Raycaster(new THREE.Vector3(bus.width, y, z), new THREE.Vector3(-1, 0, 0));
        const leftRay = new THREE.Raycaster(new THREE.Vector3(-bus.width, y, z), new THREE.Vector3(1, 0, 0));
        const rightHits = rightRay.intersectObject(windows, false).filter(hit => hit.point.x > 0);
        const leftHits = leftRay.intersectObject(windows, false).filter(hit => hit.point.x < 0);
        assert.ok(rightHits.length > 0, `right-side door at z=${z}`);
        assert.equal(leftHits.length, 0, `no left-side door at z=${z}`);
    }
    const wheelbaseHalf = bus.wheelbaseM / 2;
    for (const wheelZ of [-wheelbaseHalf, wheelbaseHalf]) {
        for (const offset of [-0.35, 0, 0.35]) {
            const z = wheelZ + offset;
            const ray = new THREE.Raycaster(new THREE.Vector3(bus.width, 0.55, z), new THREE.Vector3(-1, 0, 0));
            const hits = ray.intersectObject(windows, false).filter(hit => hit.point.x > 0);
            assert.equal(hits.length, 0, `no lower door glass over wheel arch z=${z}`);
        }
    }
});

test('road fleet preload coalesces requests and retries failures after rejection', async t => {
    t.after(disposeRoadFleetModels);
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async url => {
        calls += 1;
        if (calls === 1) throw new Error('synthetic fetch failure');
        const id = String(url).split('/').pop();
        const text = await readFile(new URL(`../models/vehicles/fleet/${id}`, import.meta.url), 'utf8');
        return { ok: true, status: 200, json: async () => JSON.parse(text) };
    };
    try {
        const type = ROAD_TRAFFIC_VEHICLE_TYPES.find(candidate => candidate.name === 'sedan');
        await assert.rejects(() => preloadRoadFleetModels([type]));
        await Promise.all([preloadRoadFleetModels([type]), preloadRoadFleetModels([type])]);
        assert.equal(calls, 2, 'failed source is retried; concurrent success is coalesced');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('fleet copies share buffers safely across instance disposal', async t => {
    installFleetFetch(t);
    t.after(disposeRoadVehicleSessionCaches);
    t.after(disposeRoadFleetModels);
    const type = ROAD_TRAFFIC_VEHICLE_TYPES.find(candidate => candidate.name === 'sedan');
    await preloadRoadFleetModels([type]);
    const first = buildTrafficVehicleMesh(type, 0x345678);
    const second = buildTrafficVehicleMesh(type, 0xabcdef);
    const bodyA = first.getObjectByName('TrafficVehiclePaintedBody');
    const bodyB = second.getObjectByName('TrafficVehiclePaintedBody');
    assert.equal(bodyA.geometry, bodyB.geometry);
    assert.equal(first.getObjectByName('TrafficVehicleDetails').material, second.getObjectByName('TrafficVehicleDetails').material);
    let disposed = false;
    const onDispose = () => { disposed = true; };
    bodyA.geometry.addEventListener('dispose', onDispose);
    disposeGroup(first);
    assert.equal(disposed, false, 'instance disposal does not release shared geometry');
    assert.ok(second.getObjectByName('TrafficVehiclePaintedBody').geometry.attributes.position);
    bodyA.geometry.removeEventListener('dispose', onDispose);
});

test('stale in-flight fleet preload is cancelled and a later generation retries', async t => {
    t.after(disposeRoadFleetModels);
    const previous = globalThis.fetch;
    let resolveFetch;
    globalThis.fetch = () => new Promise(resolve => { resolveFetch = resolve; });
    const type = ROAD_TRAFFIC_VEHICLE_TYPES.find(candidate => candidate.name === 'sedan');
    const pending = preloadRoadFleetModels([type]);
    disposeRoadFleetModels();
    resolveFetch({ ok: true, status: 200, json: async () => JSON.parse(await readFile(new URL('../models/vehicles/fleet/sedan.json', import.meta.url), 'utf8')) });
    await assert.rejects(pending, /cancelled/);
    assert.throws(() => buildTrafficVehicleMesh(type, 0x345678), /must be preloaded/);
    globalThis.fetch = async url => {
        const id = String(url).split('/').pop();
        const text = await readFile(new URL(`../models/vehicles/fleet/${id}`, import.meta.url), 'utf8');
        return { ok: true, status: 200, json: async () => JSON.parse(text) };
    };
    try {
        await preloadRoadFleetModels([type]);
        assert.equal(buildTrafficVehicleMesh(type, 0x345678).userData.fleetStudy, 'sedan');
    } finally {
        globalThis.fetch = previous;
    }
});

test('the road model owns lamp switching and preserves the controlled vehicle at distant LOD', async t => {
    installFleetFetch(t);
    t.after(disposeRoadVehicleSessionCaches);
    t.after(disposeRoadFleetModels);
    await preloadRoadFleetModels([ROAD_TRAFFIC_VEHICLE_TYPES[0]]);
    const mesh = buildTrafficVehicleMesh(ROAD_TRAFFIC_VEHICLE_TYPES[0], 0x345678);
    const materials = new Set();
    mesh.traverse(node => { if (node.material) materials.add(node.material); });
    const before = new Map([...materials].map(material => [material, material.emissiveIntensity]));
    setRoadVehicleNightMode(true);
    assert.ok([...materials].some(material => before.get(material) === 0 && material.emissiveIntensity === 1.4));
    assert.ok([...materials].some(material => before.get(material) === 0.4 && material.emissiveIntensity === 1.1));
    setRoadVehicleNightMode(false);
    for (const material of materials) assert.equal(material.emissiveIntensity, before.get(material));
    mesh.position.set(500, 0, 500);
    const car = { mesh, controlled: false, physicsControlled: false };
    updateTrafficVehicleLods(0, 0, [car], new Map(), 60);
    assert.equal(mesh.userData.farMesh.visible, true);
    car.controlled = true;
    updateTrafficVehicleLods(0, 0, [car], new Map(), 60);
    assert.equal(mesh.userData.detailRoot.visible, true);
    assert.equal(mesh.userData.farMesh.visible, false);
});

test('a tram retains movable doors when switching between detailed and distant rendering', t => {
    t.after(disposeTramSessionCaches);
    const mesh = createTramMesh('#005eb8');
    finiteModel(mesh);
    const instances = [];
    mesh.traverse(node => { if (node.isInstancedMesh) instances.push(node); });
    const closed = instances.map(node => Array.from(node.instanceMatrix.array));
    setTramDoorsOpen(mesh, 1);
    assert.ok(instances.some((node, index) => node.instanceMatrix.array.some((value, i) => value !== closed[index][i])));
    setTramDoorsOpen(mesh, 0);
    instances.forEach((node, index) => assert.deepEqual(Array.from(node.instanceMatrix.array), closed[index]));
    updateTramRenderLod(mesh, 1e6);
    assert.equal(mesh.userData.farMesh.visible, true);
    updateTramRenderLod(mesh, 0);
    assert.equal(mesh.userData.detailRoot.visible, true);
});

test('the boat is the merged leut: one draw per material family, owned buffers, wake attached', () => {
    const boat = createBoatMesh();
    finiteModel(boat);
    const meshes = [];
    boat.traverse(node => { if (node.isMesh && !/Wake|Spray/.test(node.name)) meshes.push(node); });
    assert.ok(meshes.length >= 4 && meshes.length <= 6, `boat draws: ${meshes.length}`);
    const hull = boat.getObjectByName('GtaBoatVHull');
    assert.ok(hull?.geometry.attributes.color, 'hull carries vertex colours');
    assert.ok(hull.geometry.attributes.position.count > 10000);
    assert.equal(boat.userData.wake?.name, 'GtaBoatWake');
    assert.ok(boat.userData.wake.position.z < -4, 'wake trails the sternpost');
    const second = createBoatMesh();
    assert.notEqual(second.getObjectByName('GtaBoatVHull').geometry, hull.geometry, 'each boat owns buffers disposeGroup can free');
});
