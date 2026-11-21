// Locks the authored face: every feature is opt-in, sits on the +Z face of the
// head in a bounded number of merged meshes, and expressions are transforms
// on the same meshes rather than rebuilds.

import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import {
    createPersonMesh,
    disposePersonMeshSessionCaches,
} from '../world/person-mesh.js';
import {
    FACE_EXPRESSIONS,
    animatePersonFace,
    blinkAmountAt,
    getPersonFaceExpression,
    setPersonFaceExpression,
    speechOpennessAt,
} from '../world/person-face.js';

const FISHERMAN = {
    kind: 'male',
    skinColor: 0xc68642,
    face: {
        eyes: true, nose: true, ears: true, mouth: true, moustache: true, beard: true,
        hairColor: 0xd8d2c4,
        eyeColor: 0x3f5f78,
        hat: { kind: 'fisherman-cap', color: 0x1b2433, peakColor: 0x111418, badgeColor: 0xd4a52a },
    },
};

function faceMeshes(person) {
    const meshes = [];
    person.getObjectByName('PersonFace').traverse(object => { if (object.isMesh) meshes.push(object); });
    return meshes;
}

function worldBox(mesh) {
    mesh.updateWorldMatrix(true, false);
    mesh.geometry.computeBoundingBox();
    return mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
}

test('a full face is a bounded set of merged meshes on the front of the head', () => {
    const person = createPersonMesh(FISHERMAN);
    const head = person.getObjectByName('PersonHead');
    const names = faceMeshes(person).map(mesh => mesh.name).sort();
    assert.deepEqual(names, [
        'PersonBeard', 'PersonBrowLeft', 'PersonBrowRight', 'PersonEyeWhites', 'PersonFaceSkin',
        'PersonHatBadge', 'PersonHatCrown', 'PersonHatTrim',
        'PersonIrises', 'PersonMoustache', 'PersonMouth', 'PersonPupils',
    ]);
    assert.ok(faceMeshes(person).every(mesh => !mesh.castShadow), 'face parts never join the shadow pass');

    const headTopY = head.position.y + head.scale.y;
    const headFrontZ = head.position.z + head.scale.z;
    for (const name of ['PersonEyeWhites', 'PersonIrises', 'PersonPupils', 'PersonMouth', 'PersonBrowLeft']) {
        const box = worldBox(person.getObjectByName(name));
        assert.ok(box.max.z > headFrontZ * 0.9 && box.max.z > box.min.z, `${name} must sit on the +Z face`);
        assert.ok(box.min.z > head.position.z, `${name} must not poke out the back of the head`);
    }
    const skin = worldBox(person.getObjectByName('PersonFaceSkin'));
    assert.ok(skin.max.z > headFrontZ, 'the nose must protrude beyond the head sphere');
    assert.ok(skin.max.x > head.position.x + head.scale.x, 'ears must protrude sideways');
    const crown = worldBox(person.getObjectByName('PersonHatCrown'));
    assert.ok(crown.max.y > headTopY, 'the cap must cover the top of the head');
    assert.ok(crown.min.y > person.getObjectByName('PersonBrowLeft').position.y + head.position.y,
        'the cap must stop above the brows');
    const beard = worldBox(person.getObjectByName('PersonBeard'));
    assert.ok(beard.min.y < head.position.y - head.scale.y, 'the beard must hang below the chin');

    assert.equal(person.getObjectByName('PersonMoustache').material.color.getHex(), 0xd8d2c4);
    assert.equal(person.getObjectByName('PersonBeard').material, person.getObjectByName('PersonMoustache').material);
    assert.equal(person.getObjectByName('PersonFaceSkin').material, head.material, 'nose and ears share the head skin');
    assert.equal(person.getObjectByName('PersonIrises').material.color.getHex(), 0x3f5f78);
});

test('faces stay opt-in and partial specs only build what they name', () => {
    assert.equal(createPersonMesh({ kind: 'male' }).getObjectByName('PersonFace'), undefined);
    const moustacheOnly = createPersonMesh({ kind: 'male', face: { moustache: true, hairColor: 0x2f1b13 } });
    assert.deepEqual(faceMeshes(moustacheOnly).map(mesh => mesh.name), ['PersonMoustache']);
    assert.throws(() => createPersonMesh({ kind: 'male', face: { hat: { kind: 'crown' } } }), RangeError);
});

test('expressions move the brows, eyes and mouth and are reversible', () => {
    const person = createPersonMesh(FISHERMAN);
    const left = person.getObjectByName('PersonBrowLeft');
    const right = person.getObjectByName('PersonBrowRight');
    const eyes = person.getObjectByName('PersonEyeWhites');
    const mouth = person.getObjectByName('PersonMouth');
    const rest = {
        browY: left.position.y, eyesY: eyes.scale.y,
        mouthGeometry: mouth.geometry, mouthY: mouth.position.y, mouthScaleY: mouth.scale.y,
    };
    assert.equal(getPersonFaceExpression(person), 'neutral');
    assert.deepEqual([...FACE_EXPRESSIONS], ['neutral', 'smile', 'stern', 'surprised']);

    assert.equal(setPersonFaceExpression(person, 'stern'), true);
    assert.ok(left.rotation.z < 0 && right.rotation.z > 0, 'a scowl pulls the inner brow ends down');
    assert.ok(left.position.y < rest.browY);
    assert.ok(eyes.scale.y < rest.eyesY, 'stern narrows the eyes');
    assert.equal(mouth.rotation.z, 0, 'a frown is the arch as built');
    assert.ok(mouth.position.y < rest.mouthY);

    setPersonFaceExpression(person, 'smile');
    assert.equal(mouth.rotation.z, Math.PI, 'a smile is the arch turned over');
    assert.equal(mouth.position.y, rest.mouthY, 'smile corners stay on the mouth line');

    setPersonFaceExpression(person, 'surprised');
    assert.ok(eyes.scale.y > rest.eyesY, 'surprise widens the eyes');
    assert.ok(left.position.y > rest.browY, 'surprise raises the brows');
    assert.ok(mouth.scale.y > rest.mouthScaleY * 2, 'surprise opens the mouth');

    setPersonFaceExpression(person, 'neutral');
    assert.equal(left.rotation.z, 0);
    assert.equal(left.position.y, rest.browY);
    assert.equal(eyes.scale.y, rest.eyesY);
    assert.equal(mouth.geometry, rest.mouthGeometry);
    assert.equal(mouth.position.y, rest.mouthY);

    assert.throws(() => setPersonFaceExpression(person, 'smirk'), RangeError);
    assert.equal(setPersonFaceExpression(createPersonMesh({ kind: 'kid' }), 'smile'), false);
});

test('two faced persons share every geometry and material', () => {
    const first = createPersonMesh(FISHERMAN);
    const second = createPersonMesh(FISHERMAN);
    const firstMeshes = faceMeshes(first);
    const secondMeshes = faceMeshes(second);
    for (const [index, mesh] of firstMeshes.entries()) {
        assert.equal(mesh.geometry, secondMeshes[index].geometry, `${mesh.name} geometry is shared`);
        assert.equal(mesh.material, secondMeshes[index].material, `${mesh.name} material is shared`);
    }
    disposePersonMeshSessionCaches();
});

function firstTimeWhere(predicate) {
    for (let t = 0; t < 3.2; t += 0.005) if (predicate(blinkAmountAt(t))) return t;
    return null;
}

test('blinks are scheduled deterministically: a full blink in every slot, eyes open most of the time', () => {
    for (let slot = 0; slot < 40; slot++) {
        let closedSteps = 0;
        let peak = 0;
        for (let step = 0; step < 320; step++) {
            const t = slot * 3.2 + step * 0.01;
            const amount = blinkAmountAt(t);
            assert.ok(amount >= 0 && amount <= 1);
            assert.equal(amount, blinkAmountAt(t), 'pure in time');
            if (amount > 0) closedSteps += 1;
            peak = Math.max(peak, amount);
        }
        assert.ok(peak > 0.9, `slot ${slot} must contain a full blink`);
        assert.ok(closedSteps * 0.01 < 0.5, `slot ${slot} keeps the eyes open most of the time`);
    }
});

test('pseudo-speech opens the mouth and pauses within every second', () => {
    for (let second = 0; second < 30; second++) {
        let max = 0;
        let min = 1;
        for (let step = 0; step < 100; step++) {
            const value = speechOpennessAt(second + step * 0.01);
            assert.ok(value >= 0 && value <= 1);
            max = Math.max(max, value);
            min = Math.min(min, value);
        }
        assert.ok(max > 0.45, `second ${second} must open the mouth (max ${max.toFixed(2)})`);
        assert.ok(min < 0.05, `second ${second} must pause (min ${min.toFixed(2)})`);
    }
});

test('talking moves the mouth, moustache, beard and head', () => {
    const person = createPersonMesh(FISHERMAN);
    const face = person.getObjectByName('PersonFace');
    const mouth = person.getObjectByName('PersonMouth');
    const moustache = person.getObjectByName('PersonMoustache');
    const beard = person.getObjectByName('PersonBeard');
    const R = person.userData.personDimensions.headR;
    let maxMouth = 0;
    let maxMoustacheLift = 0;
    let minBeardY = 0;
    let maxNod = 0;
    for (let t = 0; t < 3; t += 0.01) {
        assert.equal(animatePersonFace(person, t, { talk: 1 }), true);
        maxMouth = Math.max(maxMouth, mouth.scale.y);
        maxMoustacheLift = Math.max(maxMoustacheLift, moustache.position.y);
        minBeardY = Math.min(minBeardY, beard.position.y);
        maxNod = Math.max(maxNod, Math.abs(face.rotation.x));
    }
    assert.ok(maxMouth > 0.1 * R, 'the mouth must open wide at least once');
    assert.ok(maxMoustacheLift > 0.015 * R, 'the moustache must lift with the lip');
    assert.ok(minBeardY < -0.04 * R, 'the beard must drop with the jaw');
    assert.ok(maxNod > 0.02 && maxNod < 0.1, 'the head nods, but subtly');
});

test('a blink closes whites, irises and pupils together and reopens fully', () => {
    const person = createPersonMesh(FISHERMAN);
    const whites = person.getObjectByName('PersonEyeWhites');
    const irises = person.getObjectByName('PersonIrises');
    const pupils = person.getObjectByName('PersonPupils');
    const closedAt = firstTimeWhere(amount => amount > 0.95);
    assert.notEqual(closedAt, null);
    animatePersonFace(person, closedAt);
    assert.ok(whites.scale.y < 0.15 && irises.scale.y < 0.15 && pupils.scale.y < 0.15);
    animatePersonFace(person, firstTimeWhere(amount => amount === 0));
    assert.deepEqual([whites.scale.y, irises.scale.y, pupils.scale.y], [1, 1, 1]);
});

test('stopping talk returns exactly to the authored expression pose', () => {
    const person = createPersonMesh(FISHERMAN);
    setPersonFaceExpression(person, 'stern');
    const snapshot = () => [
        'PersonMouth', 'PersonMoustache', 'PersonBeard', 'PersonBrowLeft', 'PersonEyeWhites', 'PersonFace',
    ].map((name) => {
        const object = person.getObjectByName(name);
        return [object.position.toArray(), object.scale.toArray(), object.rotation.toArray(), object.geometry?.uuid ?? null];
    });
    const rest = snapshot();
    animatePersonFace(person, 1.234, { talk: 1 });
    assert.notDeepEqual(snapshot(), rest);
    assert.equal(getPersonFaceExpression(person), 'stern', 'talking never changes the authored expression');
    animatePersonFace(person, firstTimeWhere(amount => amount === 0), { talk: 0 });
    assert.deepEqual(snapshot(), rest);
    assert.throws(() => animatePersonFace(person, NaN), TypeError);
    assert.equal(animatePersonFace(createPersonMesh({ kind: 'kid' }), 1), false);
});

const LEADER = {
    kind: 'female',
    skinColor: 0xe0ac69,
    hairColor: 0xe8c56a,
    face: {
        eyes: true, nose: true, ears: true, mouth: true, teeth: true,
        eyeSize: 1.2, noseSize: 0.85, browStyle: 'fine',
        hairColor: 0xb08a3e, eyeColor: 0x4a90e2, lipColor: 0xc2405a,
    },
};

// Vertices of a mesh in head-relative space, for checks a bounding box is too coarse for.
function relativeVertices(person, mesh) {
    const head = person.getObjectByName('PersonHead');
    mesh.updateWorldMatrix(true, false);
    const position = mesh.geometry.getAttribute('position');
    const vertices = [];
    for (let index = 0; index < position.count; index++) {
        vertices.push(new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld).sub(head.position));
    }
    return vertices;
}

function archProfile(brow) {
    const vertices = relativeVertices(brow.parent.parent, brow).map(v => v.sub(brow.parent.position).add(brow.parent.position));
    const peak = vertices.reduce((best, v) => (v.y > best.y ? v : best));
    const minX = Math.min(...vertices.map(v => v.x));
    const maxX = Math.max(...vertices.map(v => v.x));
    const endY = x => Math.max(...vertices.filter(v => Math.abs(v.x - x) < 0.02 * brow.parent.parent.userData.personDimensions.headR).map(v => v.y));
    return { peakX: peak.x - brow.position.x, peakY: peak.y, minX: minX - brow.position.x, maxX: maxX - brow.position.x, innerEndY: endY(minX), outerEndY: endY(maxX) };
}

function relativeBox(person, name) {
    const head = person.getObjectByName('PersonHead');
    const box = worldBox(person.getObjectByName(name));
    box.min.sub(head.position);
    box.max.sub(head.position);
    return box;
}

test('teeth show inside the lips for a smile, an open mouth and open talk frames, and hide otherwise', () => {
    const person = createPersonMesh(LEADER);
    const R = person.userData.personDimensions.headR;
    const teeth = person.getObjectByName('PersonTeeth');
    assert.ok(teeth?.isMesh);
    assert.equal(teeth.visible, false, 'a closed neutral mouth hides the teeth');

    setPersonFaceExpression(person, 'smile');
    assert.equal(teeth.visible, true);
    let teethBox = relativeBox(person, 'PersonTeeth');
    let mouthBox = relativeBox(person, 'PersonMouth');
    assert.ok(teethBox.max.z < mouthBox.max.z, 'teeth sit behind the lip line');
    assert.ok(teethBox.max.z > 0.9 * R, 'teeth stand in front of the skin');
    assert.ok(teethBox.min.x > mouthBox.min.x && teethBox.max.x < mouthBox.max.x, 'teeth stay inside the smile');
    assert.ok(teethBox.max.y < -0.44 * R && teethBox.min.y > mouthBox.min.y, 'teeth fill the arc below the mouth line');

    setPersonFaceExpression(person, 'stern');
    assert.equal(teeth.visible, false, 'a frown hides the teeth');
    setPersonFaceExpression(person, 'surprised');
    assert.equal(teeth.visible, true);
    teethBox = relativeBox(person, 'PersonTeeth');
    mouthBox = relativeBox(person, 'PersonMouth');
    assert.ok(teethBox.max.y < mouthBox.max.y && teethBox.max.y > mouthBox.max.y - 0.05 * R, 'upper teeth hang from the upper lip');
    assert.ok(teethBox.min.x > mouthBox.min.x && teethBox.max.x < mouthBox.max.x);
    assert.ok(teethBox.max.z > mouthBox.max.z - 0.02 * R, 'teeth are not buried in the mouth');

    setPersonFaceExpression(person, 'neutral');
    const mouth = person.getObjectByName('PersonMouth');
    let shown = 0;
    let hidden = 0;
    for (let t = 0; t < 3; t += 0.01) {
        animatePersonFace(person, t, { talk: 1 });
        const open = mouth.scale.y > (0.035 + 0.11 * 0.18) * R;
        assert.equal(teeth.visible, open, `teeth follow the jaw at t=${t.toFixed(2)}`);
        if (teeth.visible) {
            shown += 1;
            const lipTop = mouth.position.y + mouth.scale.y;
            assert.ok(Math.abs(teeth.position.y - (lipTop - 0.012 * R)) < 1e-9, 'teeth hang from the moving upper lip');
            assert.ok(teeth.scale.x < mouth.scale.x, 'teeth narrower than the mouth');
        } else {
            hidden += 1;
        }
    }
    assert.ok(shown > 20 && hidden > 20, `speech shows (${shown}) and hides (${hidden}) the teeth`);
    animatePersonFace(person, firstTimeWhere(amount => amount === 0), { talk: 0 });
    assert.equal(teeth.visible, false, 'stopping talk on a neutral face hides them again');

    assert.equal(createPersonMesh(FISHERMAN).getObjectByName('PersonTeeth'), undefined, 'teeth are opt-in');
});

test('brow styles, eye and nose sizes are opt-in, mirrored and validated loudly', () => {
    const leader = createPersonMesh(LEADER);
    const fisherman = createPersonMesh(FISHERMAN);
    const R = leader.userData.personDimensions.headR;
    const fineLeft = leader.getObjectByName('PersonBrowLeft');
    const fineRight = leader.getObjectByName('PersonBrowRight');
    assert.notEqual(fineLeft.geometry, fisherman.getObjectByName('PersonBrowLeft').geometry, 'fine brows are their own arch');
    assert.notEqual(fineLeft.geometry, fineRight.geometry, 'the arch is mirrored per side');
    const leftBox = relativeBox(leader, 'PersonBrowLeft');
    const rightBox = relativeBox(leader, 'PersonBrowRight');
    assert.ok(Math.abs(leftBox.min.x + rightBox.max.x) < 1e-9 && Math.abs(leftBox.max.y - rightBox.max.y) < 1e-9, 'mirror symmetric');
    const arch = archProfile(fineRight);
    assert.ok(arch.peakX > arch.minX + 0.1 * R && arch.peakX < arch.maxX - 0.1 * R, 'the arch peaks between its ends');
    assert.ok(arch.innerEndY < arch.peakY - 0.03 * R && arch.outerEndY < arch.peakY - 0.03 * R, 'both ends drop from the peak');
    assert.ok(arch.peakX > 0, 'the peak sits toward the temple');
    assert.ok(leftBox.min.y > relativeBox(leader, 'PersonEyeWhites').max.y, 'brows clear the larger eyes');

    // One eye's width in head radii, so the spacing and the head size drop out.
    const eyeWidthR = person => {
        const xs = relativeVertices(person, person.getObjectByName('PersonEyeWhites')).filter(v => v.x > 0).map(v => v.x);
        return (Math.max(...xs) - Math.min(...xs)) / person.userData.personDimensions.headR;
    };
    const widthRatio = eyeWidthR(leader) / eyeWidthR(fisherman);
    assert.ok(widthRatio > 1.15 && widthRatio < 1.25, `eyeSize widens each eye, ratio ${widthRatio.toFixed(3)}`);
    const inRadii = (person, name, axis) => relativeBox(person, name).max[axis] / person.userData.personDimensions.headR;
    assert.ok(inRadii(leader, 'PersonIrises', 'x') > inRadii(fisherman, 'PersonIrises', 'x'), 'irises scale with the eyes');
    assert.ok(inRadii(leader, 'PersonFaceSkin', 'z') < inRadii(fisherman, 'PersonFaceSkin', 'z'), 'a 0.85 nose protrudes less');

    const heavy = createPersonMesh({ kind: 'male', face: { eyes: true, nose: true, browStyle: 'heavy', noseSize: 1.3, hairColor: 0x2b2320 } });
    const heavyLeft = heavy.getObjectByName('PersonBrowLeft');
    assert.ok(heavyLeft.scale.x > 0.25 * R && heavyLeft.scale.y > 0.08 * R, 'heavy brows are a thick bar');
    assert.ok(heavyLeft.rotation.z < 0 && heavy.getObjectByName('PersonBrowRight').rotation.z > 0, 'heavy brows lean in at rest');
    assert.ok(heavyLeft.position.y < fisherman.getObjectByName('PersonBrowLeft').position.y, 'heavy brows sit lower');
    assert.ok(inRadii(heavy, 'PersonFaceSkin', 'z') > inRadii(fisherman, 'PersonFaceSkin', 'z'), 'a 1.3 nose protrudes more');
    setPersonFaceExpression(heavy, 'neutral');
    assert.ok(heavyLeft.rotation.z < 0, 'the lean is part of the rest pose, not an expression');

    assert.throws(() => createPersonMesh({ kind: 'male', face: { eyes: true, browStyle: 'bushy' } }), RangeError);
    assert.throws(() => createPersonMesh({ kind: 'male', face: { eyes: true, eyeSize: '2' } }), TypeError);
    assert.throws(() => createPersonMesh({ kind: 'male', face: { nose: true, noseSize: NaN } }), TypeError);
});

test('stubble shades the lower face under the mouth, glasses ring the eyes, a headscarf frames the face', () => {
    const contact = createPersonMesh({
        kind: 'male', skinColor: 0xf1c27d,
        face: { eyes: true, nose: true, mouth: true, stubble: true, hairColor: 0x2b2320, stubbleColor: 0xb59a72 },
    });
    const R = contact.userData.personDimensions.headR;
    const stubble = relativeBox(contact, 'PersonStubble');
    const mouthBox = relativeBox(contact, 'PersonMouth');
    assert.ok(stubble.max.y < mouthBox.min.y, 'stubble starts below the lower lip, so its edge never crosses the mouth');
    setPersonFaceExpression(contact, 'stern');
    assert.ok(relativeBox(contact, 'PersonMouth').max.z > stubble.max.z, 'a frown still stands proud of the shell');
    assert.ok(stubble.min.y < -1.0 * R, 'stubble reaches the chin');
    assert.ok(stubble.max.z > 0.8 * R && stubble.max.z < 0.95 * R, 'the shell hugs the lower face');
    assert.ok(stubble.min.z > -0.2 * R && stubble.max.x > 0.8 * R, 'it wraps round to the jaw hinge, not the nape');
    assert.equal(contact.getObjectByName('PersonStubble').material.color.getHex(), 0xb59a72);
    assert.equal(createPersonMesh({ kind: 'male', face: { stubble: true, hairColor: 0x2b2320 } }).getObjectByName('PersonStubble').material.color.getHex(), 0x2b2320, 'stubble defaults to the hair colour');

    const granny = createPersonMesh({
        kind: 'female', hairColor: 0xd9d4cc, hairStyle: 'bun',
        face: { eyes: true, nose: true, mouth: true, glasses: { color: 0x3a3a40 } },
    });
    const glasses = relativeBox(granny, 'PersonGlasses');
    const pupils = relativeBox(granny, 'PersonPupils');
    assert.ok(glasses.max.z > pupils.max.z, 'rims sit in front of the eyes');
    assert.ok(glasses.min.x < -0.55 * R && glasses.max.x > 0.55 * R, 'rims ring both eyes');
    assert.ok(glasses.min.z < 0.05 * R, 'arms reach back to the ears');
    assert.ok(glasses.min.y > -0.1 * R && glasses.max.y < 0.4 * R, 'the frame stays between nose and brows');
    assert.equal(granny.getObjectByName('PersonGlasses').material.color.getHex(), 0x3a3a40);

    const scarfed = createPersonMesh({
        kind: 'female', hairColor: 0xd9d4cc, hairStyle: 'bun',
        face: { eyes: true, nose: true, mouth: true, hat: { kind: 'headscarf', color: 0x7a1f2b } },
    });
    const head = scarfed.getObjectByName('PersonHead');
    const scarf = relativeBox(scarfed, 'PersonHeadscarf');
    assert.ok(scarf.max.y > head.scale.y, 'the scarf covers the top of the head');
    assert.ok(scarf.min.y < -1.05 * R, 'the scarf is tied under the chin');
    setPersonFaceExpression(scarfed, 'surprised');
    const brow = relativeBox(scarfed, 'PersonBrowLeft');
    for (const vertex of relativeVertices(scarfed, scarfed.getObjectByName('PersonHeadscarf'))) {
        if (Math.abs(vertex.x) < 0.62 * R && vertex.y > brow.min.y - 0.05 * R && vertex.y < brow.max.y + 0.12 * R) {
            assert.ok(vertex.z < brow.min.z, `the scarf must clear raised brows (vertex z ${(vertex.z / R).toFixed(2)}R)`);
        }
    }
    assert.throws(() => createPersonMesh({ kind: 'female', face: { hat: { kind: 'beret' } } }), RangeError);

    const capped = createPersonMesh({
        kind: 'male', hairColor: 0x2b2320, hairStyle: 'short',
        face: { eyes: true, browStyle: 'heavy', hairColor: 0x2b2320, hat: { kind: 'flat-cap', color: 0x3b3a36 } },
    });
    const cappedHead = capped.getObjectByName('PersonHead');
    const cap = relativeBox(capped, 'PersonFlatCap');
    assert.ok(cap.max.y > cappedHead.scale.y, 'the flat cap covers the top of the head');
    assert.ok(cap.max.z > 1.1 * R, 'it has a peak');
    setPersonFaceExpression(capped, 'surprised');
    assert.ok(cap.min.y > relativeBox(capped, 'PersonBrowLeft').max.y + 0.05 * R, 'the peak clears raised heavy brows');
    assert.ok(cap.min.y > 0.45 * R, 'nothing of the cap reaches the eye region');
    assert.equal(capped.getObjectByName('PersonFlatCap').material.color.getHex(), 0x3b3a36);
});
