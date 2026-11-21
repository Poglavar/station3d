// Locks optional authored hair to a distinct, shared low-poly hairstyle while
// leaving anonymous pedestrians on the shared, single-mesh crowd head.

import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import {
    PERSON_HAIR_STYLES,
    animatePersonHair,
    animatePersonSit,
    createPersonMesh,
    disposePersonMeshSessionCaches,
    resetPersonHair,
} from '../world/person-mesh.js';

function worldBox(mesh) {
    mesh.updateWorldMatrix(true, false);
    mesh.geometry.computeBoundingBox();
    return mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
}

function meshNames(person) {
    const names = [];
    person.traverse(object => { if (object.isMesh && object.name.startsWith('PersonHair')) names.push(object.name); });
    return names.sort();
}

test('authored long hair clears the forehead and falls down the back', () => {
    const person = createPersonMesh({ kind: 'female', hairColor: 0xe8c56a });
    const hair = person.getObjectByName('PersonHair');
    const hairBack = person.getObjectByName('PersonHairBack');
    const head = person.getObjectByName('PersonHead');

    assert.ok(hair?.isMesh);
    assert.ok(hairBack?.isMesh);
    assert.equal(hair.material.color.getHex(), 0xe8c56a);
    assert.ok(hair.scale.y > hair.scale.x);
    const back = worldBox(hairBack);
    assert.ok(
        back.min.y < head.position.y - head.scale.y,
        'the rear fall must extend below the head onto the upper back',
    );
    assert.ok(back.max.z < head.position.z, 'the fall stays behind the face plane');
    assert.equal(hairBack.parent.name, 'PersonHairSwing');
    assert.ok(hairBack.parent.position.distanceTo(head.position) < 1e-12, 'the fall swings from the head centre');

    const position = hair.geometry.getAttribute('position');
    const frontHairlineY = [];
    const backHairlineY = [];
    for (let index = 0; index < position.count; index++) {
        const z = position.getZ(index);
        if (z > 0.55) frontHairlineY.push(position.getY(index));
        if (z < -0.55) backHairlineY.push(position.getY(index));
    }
    assert.ok(Math.min(...frontHairlineY) > 0.35,
        'the crown must stop high enough to leave the forehead visible');
    assert.ok(Math.min(...backHairlineY) < 0,
        'the crown must sweep below the back of the head');
});

test('authored hairstyle meshes remain opt-in', () => {
    const person = createPersonMesh({ kind: 'female' });
    assert.equal(person.getObjectByName('PersonHair'), undefined);
});

test('small actors cast one head-and-torso shadow silhouette', () => {
    const person = createPersonMesh({ kind: 'female', hairColor: 0x443322 });
    const casters = [];
    person.traverse(object => {
        if (object.isMesh && object.castShadow) casters.push(object.name);
    });
    assert.deepEqual(casters.sort(), ['PersonBody', 'PersonHead']);
});

test('seated pose lifts the knees and hands forward, then restores the walk rig', () => {
    const person = createPersonMesh({ kind: 'male' });
    const { legs, arms } = person.userData.walkLimbs;
    const rest = [...legs, ...arms].map(({ mesh }) => ({
        position: mesh.position.clone(),
        rotationX: mesh.rotation.x,
    }));

    animatePersonSit(person, 1);
    for (const { mesh } of legs) {
        assert.equal(mesh.rotation.x, 0);
        assert.equal(mesh.morphTargetInfluences[0], 1);
        const standing = mesh.geometry.getAttribute('position');
        const seated = mesh.geometry.morphAttributes.position[0];
        let standingMaxZ = -Infinity;
        let seatedMaxZ = -Infinity;
        for (let index = 0; index < standing.count; index++) {
            standingMaxZ = Math.max(standingMaxZ, standing.getZ(index));
            seatedMaxZ = Math.max(seatedMaxZ, seated.getZ(index));
        }
        assert.ok(
            seatedMaxZ > standingMaxZ + 0.2,
            'the thigh must project forward before the shin drops at the knee',
        );
    }
    for (const { mesh } of arms) {
        assert.ok(mesh.rotation.x < -0.8);
        assert.ok(mesh.position.z > 0, 'hands settle forward onto the lap');
    }

    animatePersonSit(person, 0);
    [...legs, ...arms].forEach(({ mesh }, index) => {
        assert.ok(mesh.position.distanceTo(rest[index].position) < 1e-12);
        assert.equal(mesh.rotation.x, rest[index].rotationX);
    });
    for (const { mesh } of legs) assert.equal(mesh.morphTargetInfluences[0], 0);
});

test('shared person resources are disposed exactly once at the cab boundary', () => {
    const person = createPersonMesh({
        kind: 'female',
        hairColor: 0x554433,
        face: { eyes: true, mouth: true, moustache: true, hairColor: 0x332211 },
    });
    const resources = new Set();
    person.traverse((object) => {
        if (object.geometry) resources.add(object.geometry);
        if (object.material) resources.add(object.material);
    });
    const counts = new Map([...resources].map(resource => [resource, 0]));
    for (const resource of resources) {
        resource.addEventListener('dispose', () => counts.set(resource, counts.get(resource) + 1));
    }
    disposePersonMeshSessionCaches();
    disposePersonMeshSessionCaches();
    for (const count of counts.values()) assert.equal(count, 1);
});

test('short, bun and ponytail styles build only what they name; unknown styles throw', () => {
    assert.deepEqual([...PERSON_HAIR_STYLES], ['long', 'short', 'bun', 'ponytail']);
    const short = createPersonMesh({ kind: 'male', hairColor: 0x2b2320, hairStyle: 'short', hairTempleColor: 0x8b8680 });
    assert.deepEqual(meshNames(short), ['PersonHair', 'PersonHairTemples']);
    assert.equal(short.userData.hairSwing, undefined, 'short hair has nothing to swing');
    const head = short.getObjectByName('PersonHead');
    const temples = worldBox(short.getObjectByName('PersonHairTemples'));
    assert.ok(temples.max.x > head.position.x + head.scale.x * 1.055, 'grey temples show outside the crown');
    assert.ok(temples.min.y > head.position.y, 'temples sit above the ear line');
    assert.equal(short.getObjectByName('PersonHairTemples').material.color.getHex(), 0x8b8680);
    assert.deepEqual(meshNames(createPersonMesh({ kind: 'male', hairColor: 0x2b2320, hairStyle: 'short' })), ['PersonHair']);

    const bun = createPersonMesh({ kind: 'female', hairColor: 0xc9c4bb, hairStyle: 'bun' });
    assert.deepEqual(meshNames(bun), ['PersonHair', 'PersonHairBun']);
    const bunBox = worldBox(bun.getObjectByName('PersonHairBun'));
    const bunHead = bun.getObjectByName('PersonHead');
    assert.ok(bunBox.min.z < bunHead.position.z - bunHead.scale.z * 0.9, 'the bun sits behind the head');
    assert.ok(bunBox.max.y > bunHead.position.y + bunHead.scale.y * 0.5, 'the bun sits high');

    const ponytail = createPersonMesh({ kind: 'female', hairColor: 0x2a1b14, hairStyle: 'ponytail' });
    assert.deepEqual(meshNames(ponytail), ['PersonHair', 'PersonHairPonytail']);
    const tail = worldBox(ponytail.getObjectByName('PersonHairPonytail'));
    const tailHead = ponytail.getObjectByName('PersonHead');
    assert.ok(tail.min.y < tailHead.position.y - tailHead.scale.y * 1.4, 'the tail hangs well below the head');
    assert.ok(tail.max.z < tailHead.position.z, 'the tail stays behind the head');
    const crownTop = worldBox(ponytail.getObjectByName('PersonHair')).max.y;
    assert.ok(tail.max.y > crownTop + tailHead.scale.y * 0.08, 'the knot shows above the crown head-on');
    assert.equal(ponytail.getObjectByName('PersonHairPonytail').parent.name, 'PersonHairSwing');

    assert.throws(() => createPersonMesh({ kind: 'female', hairColor: 0x2a1b14, hairStyle: 'mohawk' }), RangeError);
    assert.equal(createPersonMesh({ kind: 'female', hairStyle: 'bun' }).getObjectByName('PersonHair'), undefined, 'no colour, no hair');
});

test('walking swings the hair pivot, turning trails it, stopping settles it', () => {
    const person = createPersonMesh({ kind: 'female', hairColor: 0xe8c56a });
    const pivot = person.getObjectByName('PersonHairSwing');
    let phase = 0;
    let peak = 0;
    for (let step = 0; step < 240; step++) {
        phase += 8 / 120;
        assert.equal(animatePersonHair(person, { phase, walking: 1, dt: 1 / 120 }), true);
        peak = Math.max(peak, Math.abs(pivot.rotation.x));
    }
    assert.ok(peak > 0.03, `walking must swing the fall, peak ${peak.toFixed(3)}`);
    person.rotation.y = Math.PI / 2;
    animatePersonHair(person, { phase, walking: 0, dt: 1 / 120 });
    assert.ok(pivot.rotation.y < -0.2, 'a turn leaves the hair trailing');
    for (let step = 0; step < 480; step++) animatePersonHair(person, { phase, walking: 0, dt: 1 / 120 });
    assert.ok(Math.abs(pivot.rotation.x) < 1e-3 && Math.abs(pivot.rotation.y) < 1e-3 && Math.abs(pivot.rotation.z) < 1e-3, 'settles at rest');

    animatePersonHair(person, { phase: 1, walking: 1, dt: 1 / 30 });
    animatePersonHair(person, { phase: 2, walking: 1, dt: 1 / 30 });
    assert.equal(resetPersonHair(person), true);
    assert.deepEqual(pivot.rotation.toArray().slice(0, 3), [0, 0, 0]);
    assert.equal(animatePersonHair(createPersonMesh({ kind: 'male' }), { phase: 0, walking: 1, dt: 0.01 }), false);
    assert.equal(animatePersonHair(createPersonMesh({ kind: 'male', hairColor: 0x111111, hairStyle: 'short' }), { phase: 0, walking: 1, dt: 0.01 }), false);
    assert.throws(() => animatePersonHair(person, { phase: NaN, walking: 1, dt: 0.01 }), TypeError);
});
