import assert from 'node:assert/strict';
import test from 'node:test';
import { createCharacterPreview, createPeoplePreview } from '../viewers/model-characters.js';

test('character preview exposes shared controls, cameras and deterministic identity', () => {
    const appearance = { kind: 'female', face: { eyes: true, mouth: true, teeth: true }, hairColor: 0x403028 };
    const a = createCharacterPreview(appearance, { seed: 'x' });
    const b = createCharacterPreview(appearance, { seed: 'x' });
    assert.deepEqual(a.appearances, b.appearances);
    assert.deepEqual(Object.keys(a.cameraViews).slice(0, 4), ['face', 'front', 'quarter', 'side']);
    assert.deepEqual(a.controls.map(control => control.id), ['expression', 'talk', 'walk', 'turn', 'sit']);
    a.update(1, 1 / 60, { walk: true, expression: 'smile' });
    assert.equal(a.controls.find(control => control.id === 'expression').value, 'neutral');
    a.seek(0.5, { sit: true });
    assert.equal(a.people[0].userData.walkLimbs.legs[0].mesh.morphTargetInfluences[0], 1);
    a.seek(0.5, { sit: false, walk: true });
    const limb = a.people[0].userData.walkLimbs.legs[0];
    assert.equal(limb.mesh.morphTargetInfluences[0], 0);
    assert.ok(Math.abs(limb.mesh.rotation.x) > .1, 'walking survives the sitting reset');
    for (const view of ['front', 'quarter', 'side']) {
        const { position, target } = a.cameraViews[view];
        assert.ok(Math.hypot(...position.map((n, i) => n - target[i])) < 1.2, 'face cameras stay close to the head');
    }
    const frozen = a.people[0].userData.hairSwing.pivot.rotation.toArray();
    a.seek(0.5, { sit: false, walk: true });
    assert.deepEqual(a.people[0].userData.hairSwing.pivot.rotation.toArray(), frozen);
});

test('ambient textured faces expose only the controls their model supports', () => {
    const person = createCharacterPreview({ kind: 'male' });
    assert.deepEqual(person.controls.map(control => control.id), ['walk', 'turn', 'sit']);
});

test('people preview keeps twelve appearances across modes and instantiates waiting heads', () => {
    const faces = createPeoplePreview({ seed: 'stable', mode: 'faces' });
    const walking = createPeoplePreview({ seed: 'stable', mode: 'walking' });
    const waiting = createPeoplePreview({ seed: 'stable', mode: 'waiting' });
    assert.equal(faces.appearances.length, 12);
    assert.deepEqual(faces.appearances, walking.appearances);
    assert.deepEqual(faces.appearances, waiting.appearances);
    assert.equal(waiting.object.children.some(child => child.isInstancedMesh), true);
    assert.equal(waiting.controls.length, 0);
    faces.update(0.5, 0, { turn: true });
    assert.notEqual(faces.object.children[0].rotation.y, 0);
    const before = walking.people[0].rotation.y;
    walking.update(2, 1 / 60, { turn: true });
    assert.notEqual(walking.people[0].rotation.y, before);
});
