import * as THREE from 'three';
import {
    createPersonMesh, animatePersonWalk, animatePersonHair, resetPersonHair,
    animatePersonSit, PERSON_BODY_COLORS, PERSON_SKIN_COLORS, PERSON_LEG_COLORS,
} from '../world/person-mesh.js';
import { FACE_EXPRESSIONS, animatePersonFace, setPersonFaceExpression } from '../world/person-face.js';
import { personFaceSeed, personHeadProfile } from '../core/person-appearance.js';
import { createInstancedPersonHeadGeometry, getPersonHeadMaterial } from '../world/person-head.js';
import { disposeGroup } from '../core/dispose.js';

const pick = (values, seed, index, salt) => values[personFaceSeed(`${seed}|${index}|${salt}`) % values.length];

function appearances(seed) {
    return Array.from({ length: 12 }, (_, index) => {
        const roll = personFaceSeed(`${seed}|${index}|kind`) % 100;
        return {
            kind: roll < 20 ? 'kid' : roll < 58 ? 'female' : 'male',
            faceSeed: personFaceSeed(`${seed}|person|${index}`),
            skinColor: pick(PERSON_SKIN_COLORS, seed, index, 'skin'),
            bodyColor: pick(PERSON_BODY_COLORS, seed, index, 'body'),
            legColor: pick(PERSON_LEG_COLORS, seed, index, 'legs'),
        };
    });
}

function motionControls(hasFace) {
    return [
        ...(hasFace ? [{ id: 'expression', label: 'Expression', type: 'select', options: FACE_EXPRESSIONS.map(value => ({ value, label: value })), value: 'neutral' }] : []),
        ...(hasFace ? ['talk', 'walk', 'turn', 'sit'] : ['walk', 'turn', 'sit']).map(id => ({ id, label: id[0].toUpperCase() + id.slice(1), type: 'checkbox', value: false })),
    ];
}

export function createCharacterPreview(appearance = {}, { seed = 'city-people-1', mode = 'body' } = {}) {
    const resolvedAppearance = { ...appearance, faceSeed: appearance.faceSeed ?? personFaceSeed(`${seed}|character`) };
    const person = createPersonMesh(resolvedAppearance);
    const headY = person.getObjectByName('PersonHead')?.position.y ?? 1.7;
    const cameraViews = {
        face: { position: [0, headY + .12, 1.05], target: [0, headY, 0], fov: 38 },
        front: { position: [0, headY + .06, 1.05], target: [0, headY, 0], fov: 38 },
        quarter: { position: [.55, headY + .12, .95], target: [0, headY, 0], fov: 38 },
        side: { position: [1.02, headY + .06, .22], target: [0, headY, 0], fov: 38 },
        bodyFront: { position: [0, 2.2, 7], target: [0, 1.1, 0], fov: 38 },
        bodyQuarter: { position: [.55, 2.3, 6.6], target: [0, 1.1, 0], fov: 38 },
        bodySide: { position: [6.6, 2.2, .4], target: [0, 1.1, 0], fov: 38 },
    };
    const object = new THREE.Group();
    object.add(person);
    const controls = motionControls(!!person.userData.face);
    const state = { expression: 'neutral', talk: false, walk: false, turn: false, sit: false };
    const apply = (time, delta) => {
        person.rotation.y = state.turn ? Math.sin(time * 0.8) * 0.55 : 0;
        // Reset the seated arm offsets before applying the walking pose.
        animatePersonSit(person, 0);
        animatePersonWalk(person, time * 8, state.walk ? 1 : 0);
        animatePersonHair(person, { phase: time * 8, walking: state.walk ? 1 : 0, dt: delta });
        animatePersonFace(person, time, { talk: state.talk ? 1 : 0 });
        if (state.sit) animatePersonSit(person, 1);
    };
    const update = (time = 0, delta = 0, next = {}) => {
        Object.assign(state, next);
        setPersonFaceExpression(person, state.expression);
        apply(time, delta);
    };
    const seek = (time = 0, next = {}) => {
        resetPersonHair(person);
        Object.assign(state, next);
        setPersonFaceExpression(person, state.expression);
        const steps = Math.min(1200, Math.max(1, Math.ceil(time * 60)));
        const dt = time / steps;
        for (let i = 1; i <= steps; i++) apply(i * dt, dt);
    };
    return { object, people: [person], cameraViews, controls, appearances: [resolvedAppearance], update, seek, mode };
}

export function createPeoplePreview({ seed = 'city-people-1', mode = 'faces', columns = 6 } = {}) {
    if (!['faces', 'walking', 'waiting'].includes(mode)) throw new RangeError(`Unknown people preview mode "${mode}".`);
    // Keep old ?seed links bit-for-bit compatible with the crowd viewer.
    seed = personFaceSeed(/^\d+$/.test(String(seed)) ? Number(seed) : seed);
    columns = columns === 3 ? 3 : 6;
    const records = appearances(seed);
    const object = new THREE.Group();
    const people = [], displayed = [];
    const rows = Math.ceil(records.length / columns);
    const variants = [], matrices = [], colors = [];
    records.forEach((appearance, index) => {
        const person = createPersonMesh(appearance);
        const head = person.getObjectByName('PersonHead');
        const x = index % columns - (columns - 1) / 2;
        const row = Math.floor(index / columns);
        person.userData.previewIndex = index;
        if (mode === 'faces') {
            head.removeFromParent();
            head.position.set(x * .63, ((rows - 1) / 2 - row) * .62, 0);
            head.scale.multiplyScalar(1.3);
            object.add(head);
            displayed.push(head);
            disposeGroup(person);
        } else {
            person.position.set(x * .66, 0, row * -1.8);
            object.add(person);
            displayed.push(person);
            people.push(person);
            if (mode === 'waiting') {
                head.updateWorldMatrix(true, false);
                matrices.push(head.matrixWorld.clone());
                variants.push(personHeadProfile(appearance.faceSeed, appearance.kind).variant);
                colors.push(appearance.skinColor);
                disposeGroup(head);
            }
        }
    });
    if (mode === 'waiting') {
        const heads = new THREE.InstancedMesh(createInstancedPersonHeadGeometry(variants), getPersonHeadMaterial(0xffffff, { unlit: true }), variants.length);
        variants.forEach((_, i) => { heads.setMatrixAt(i, matrices[i]); heads.setColorAt(i, new THREE.Color(colors[i])); });
        heads.instanceMatrix.needsUpdate = true;
        heads.instanceColor.needsUpdate = true;
        object.add(heads);
    }
    const controls = mode === 'waiting' ? [] : [{ id: 'turn', label: 'Turn heads', type: 'checkbox', value: false }];
    const update = (time = 0, _delta = 0, state = {}) => {
        displayed.forEach((part, i) => {
            if (mode === 'walking') animatePersonWalk(part, time * 6 + i * 1.9, .8);
            if (mode !== 'waiting') part.rotation.y = state.turn ? Math.sin(time * .8 + i * .18) * .55 : 0;
        });
    };
    const seek = (time = 0, state = {}) => update(time, 0, state);
    return { object, people, cameraViews: {}, controls, appearances: records, update, seek, mode };
}
