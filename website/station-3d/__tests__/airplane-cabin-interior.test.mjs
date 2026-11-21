// The smuggler's aircraft can be furnished for the opening film: translucent
// glazing, seats, an instrument panel, the cargo, and a seat for the pilot.
// Every variant shares the hollow shell; furnishing only selects its contents.

import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { AIRPLANE_PILOT_SEAT, createAirplaneMesh } from '../models/vehicles/boat-airplane.js';
import { AIRPLANE_CABIN_SECTIONS } from '../models/vehicles/boat-airplane-geometry.js';

const names = mesh => {
    const found = [];
    mesh.traverse(object => found.push(object.name));
    return found;
};

test('the plain aircraft uses the same hollow airframe with opaque glass and no furnishings', () => {
    const plain = createAirplaneMesh();
    assert.equal(plain.userData.pilotSeat, undefined);
    assert.ok(!names(plain).some(name => /Interior|Cargo|PilotSeat|Liner/.test(name)));
    const cabin = plain.getObjectByName('GtaAirplaneRoundedCabin');
    const glass = cabin.material[1];
    assert.equal(glass.transparent, false);
    assert.equal(glass.opacity, 1);
    const furnished = createAirplaneMesh({ interior: 'smuggler' });
    assert.deepEqual(cabin.geometry.index.array, furnished.getObjectByName(cabin.name).geometry.index.array);
    assert.deepEqual(cabin.geometry.attributes.position.array, furnished.getObjectByName(cabin.name).geometry.attributes.position.array);
    assert.equal(cabin.geometry.groups.length, 2);
    assert.equal(names(plain).filter(name => name === 'GtaAirplaneCabinSideWindow').length, 0);
});

function opaqueShellHits(airplane, from, to) {
    const shell = [];
    for (const name of ['GtaAirplaneTaperedFuselage', 'GtaAirplaneRoundedCabin',
        'GtaAirplaneCabinLiner', 'GtaAirplaneFuselageLiner', 'GtaAirplaneRoundedMainWing']) {
        const object = airplane.getObjectByName(name);
        if (!object) continue;
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.side = THREE.DoubleSide;
        shell.push(object);
    }
    airplane.updateMatrixWorld(true);
    const origin = new THREE.Vector3(...from);
    const direction = new THREE.Vector3(...to).sub(origin);
    const ray = new THREE.Raycaster(origin, direction.clone().normalize(), 0.001, direction.length());
    return ray.intersectObjects(shell, false).filter(hit => {
        const material = Array.isArray(hit.object.material) ? hit.object.material[hit.face.materialIndex] : hit.object.material;
        return !material.transparent;
    }).map(hit => `${hit.object.name} at ${hit.point.toArray().map(n => n.toFixed(3))}`);
}

test('the cabin is clear from the floor to the roof, including under the wing and behind the pilot', () => {
    const airplane = createAirplaneMesh({ interior: 'smuggler' });
    for (const z of [0.48, 0.7, 0.98, 1.3]) {
        for (const x of [-0.24, 0, 0.24]) {
            assert.deepEqual(opaqueShellHits(airplane, [x, 0.54, z], [x, 1.62, z]), [], `clear cabin volume at ${x},${z}`);
        }
    }
});

test('both side windows and the windshield have clear sightlines through the outer skin and liner', () => {
    const airplane = createAirplaneMesh({ interior: 'smuggler' });
    for (const z of [0.5, 0.8, 1.2, 1.4]) {
        for (const y of [1.16, 1.3, 1.5]) {
            assert.deepEqual(opaqueShellHits(airplane, [-1, y, z], [1, y, z]), [], `side glazing at ${y},${z}`);
        }
    }
    for (const x of [-0.24, 0.24]) {
        assert.deepEqual(opaqueShellHits(airplane, [x, 1.4, 1.9], [x, 1.4, 1.3]), [], `windshield at ${x}`);
    }
});

test('cargo is supported by the floor or another box, with the sack resting on the floor', () => {
    const airplane = createAirplaneMesh({ interior: 'smuggler' });
    airplane.updateMatrixWorld(true);
    const cargo = airplane.getObjectByName('GtaAirplaneCargo');
    const floor = airplane.getObjectByName('GtaAirplaneCabinFloor');
    for (const object of cargo.children) {
        const bounds = new THREE.Box3().setFromObject(object);
        const ray = new THREE.Raycaster(new THREE.Vector3(object.position.x, bounds.min.y + 0.001, object.position.z), new THREE.Vector3(0, -1, 0), 0, 0.005);
        const supports = [floor, ...cargo.children.filter(other => other !== object)];
        assert.ok(ray.intersectObjects(supports, false).length, `${object.name} must rest on a surface`);
    }
});

test('the cabin has bulkheads separating its living space from the tail and engine', () => {
    const airplane = createAirplaneMesh({ interior: 'smuggler' });
    assert.ok(opaqueShellHits(airplane, [0, 1.3, 0], [0, 1.3, -0.8]).some(hit => hit.includes('-0.430')));
    assert.ok(opaqueShellHits(airplane, [0, 0.75, 1.3], [0, 0.75, 1.9]).some(hit => hit.includes('1.500')));
});

test('door seams sit on the rendered skin with a small consistent clearance', () => {
    const airplane = createAirplaneMesh({ interior: 'smuggler' });
    airplane.updateMatrixWorld(true);
    const cabin = airplane.getObjectByName('GtaAirplaneRoundedCabin');
    for (const side of [-1, 1]) {
        const outline = airplane.getObjectByName(side < 0 ? 'GtaAirplaneCabinDoorOutline' : 'GtaAirplaneCabinDoorOutlineRight');
        const positions = outline.geometry.getAttribute('position');
        for (let index = 0; index < positions.count; index += 1) {
            const point = new THREE.Vector3().fromBufferAttribute(positions, index);
            const ray = new THREE.Raycaster(new THREE.Vector3(side * 2, point.y, point.z), new THREE.Vector3(-side, 0, 0));
            const hit = ray.intersectObject(cabin, false)[0];
            assert.ok(hit, 'the seam has real skin beneath it');
            assert.ok(Math.abs(side * (point.x - hit.point.x) - 0.004) < 1e-5, 'no buried or floating seam');
        }
    }
});

test('the furnished cabin shows through its glazing and seats the pilot under the roof', () => {
    const furnished = createAirplaneMesh({ interior: 'smuggler' });
    const found = names(furnished);
    for (const name of ['GtaAirplaneCabinInterior', 'GtaAirplaneCabinLiner', 'GtaAirplaneFuselageLiner',
        'GtaAirplaneCabinFloor', 'GtaAirplaneInstrumentPanel', 'GtaAirplanePilotSeat', 'GtaAirplaneCargo',
        'GtaAirplaneCargoBooks', 'GtaAirplaneCargoSack']) {
        assert.ok(found.includes(name), name);
    }
    assert.ok(found.filter(name => name === 'GtaAirplaneCargoCarton').length >= 5, 'the cartons');
    // The windows are openings in the shell drawn with the glass material, not
    // decals over an unbroken hull: no separate window meshes exist.
    assert.ok(!found.includes('GtaAirplaneCabinWindshield') && !found.includes('GtaAirplaneCabinSideWindow'));
    const cabin = furnished.getObjectByName('GtaAirplaneRoundedCabin');
    assert.ok(Array.isArray(cabin.material) && cabin.material.length === 2, 'body and glass groups');
    const groups = cabin.geometry.groups;
    assert.equal(groups.length, 2);
    assert.ok(groups[1].count >= 36 && groups[1].count < groups[0].count, `a bounded glazed group (${groups[1].count} indices)`);
    const glass = cabin.material[1];
    assert.equal(glass.transparent, true);
    assert.ok(glass.opacity > 0.2 && glass.opacity < 0.5);
    assert.equal(glass.depthWrite, false);
    const liner = furnished.getObjectByName('GtaAirplaneCabinLiner');
    assert.equal(liner.material.side, 1, 'BackSide: the liner faces inward');
    const seat = furnished.userData.pilotSeat;
    assert.equal(seat.name, 'GtaAirplanePilotSeat');
    assert.deepEqual([seat.position.x, seat.position.y, seat.position.z], [AIRPLANE_PILOT_SEAT.x, AIRPLANE_PILOT_SEAT.y, AIRPLANE_PILOT_SEAT.z]);
    assert.ok(AIRPLANE_PILOT_SEAT.x > 0, 'the port seat: with the nose on +z, +x is the left-hand side');
    // A 0.6-scale person is about 1.03 m tall seated at the origin of the seat:
    // the head stays under the cabin roof and the eyes inside the windshield.
    const roofY = Math.max(...AIRPLANE_CABIN_SECTIONS.map(section => section.centerY + section.halfHeight));
    assert.ok(AIRPLANE_PILOT_SEAT.y + 0.6 * 1.72 < roofY, 'head under the roof');
    assert.ok(AIRPLANE_PILOT_SEAT.y + 0.6 * 1.55 > 1.1 && AIRPLANE_PILOT_SEAT.y + 0.6 * 1.55 < 1.54, 'eyes in the windshield');
    // The cargo stays inside the cabin shell.
    const cargo = furnished.getObjectByName('GtaAirplaneCargo');
    const halfWidth = Math.min(...AIRPLANE_CABIN_SECTIONS.map(section => section.halfWidth));
    for (const box of cargo.children) {
        if (!box.geometry?.parameters?.width) continue;
        const { width, height, depth } = box.geometry.parameters;
        assert.ok(Math.abs(box.position.x) + width / 2 <= halfWidth + 0.05, `${box.name} inside the walls`);
        assert.ok(box.position.y + height / 2 < roofY, `${box.name} under the roof`);
        assert.ok(box.position.z + depth / 2 < AIRPLANE_PILOT_SEAT.z - 0.2, `${box.name} behind the seats`);
    }
    // The propeller and breakup parts are untouched by the furnishing.
    assert.ok(furnished.userData.propeller);
    for (const name of ['GtaAirplaneRoundedMainWing', 'GtaAirplaneRoundedTailplane', 'GtaAirplaneRoundedFin', 'GtaAirplaneLandingGear', 'GtaAirplanePropeller']) {
        assert.ok(found.includes(name), name);
    }
});
