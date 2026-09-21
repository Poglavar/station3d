// Shared low-poly person mesh for moving passengers and street pedestrians.
// Geometry and palette materials are cached so a bounded crowd stays cheap.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { registerShared, unregisterShared } from '../core/dispose.js';
import { createHairSwingState, stepHairSwing } from '../core/hair-swing.js';
import { attachPersonFace, disposePersonFaceCaches } from './person-face.js';
import { personHeadProfile } from '../core/person-appearance.js';
import {
    getPersonHeadGeometry, getPersonHeadMaterial,
    preparePersonHeadAssets, disposePersonHeadCaches,
} from './person-head.js';

// Authored hairstyles: `long` is the fall-and-locks rig, `short` a bare crown
// (optionally with grey temples), `bun` a crown with a knot at the back,
// `ponytail` a crown with a tail that swings. Only long hair and the ponytail
// carry a swing pivot.
export const PERSON_HAIR_STYLES = Object.freeze(['long', 'short', 'bun', 'ponytail']);

export const PERSON_BODY_COLORS = [
    0x2563eb, 0xdc2626, 0x16a34a, 0xf59e0b,
    0x7c3aed, 0x0ea5e9, 0xec4899, 0x84cc16,
];
export const PERSON_SKIN_COLORS = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac];
export const PERSON_LEG_COLORS = [0x38bdf8, 0x60a5fa, 0x22c55e, 0xfb7185, 0xa78bfa, 0xf97316];

let sphereGeo = null;
let hairCrownGeo = null;
let cylinderGeo = null;
const legGeoCache = new Map();
const hairGeoCache = new Map();
const matCache = new Map();

function getSphereGeo() {
    if (!sphereGeo) {
        sphereGeo = new THREE.SphereGeometry(1, 8, 6);
        registerShared(sphereGeo);
    }
    return sphereGeo;
}

function getHairCrownGeo() {
    if (!hairCrownGeo) {
        const segments = 12;
        const rings = 4;
        const positions = [0, 1, 0];
        const indices = [];
        for (let ring = 1; ring <= rings; ring++) {
            for (let segment = 0; segment < segments; segment++) {
                const phi = segment / segments * Math.PI * 2;
                // Shared people face local +Z. Keep the front hairline high
                // enough to expose the forehead, sweep lower at the temples,
                // and carry the shell below the occiput at the back.
                const front = Math.max(0, Math.sin(phi));
                const back = Math.max(0, -Math.sin(phi));
                const hairlineTheta = Math.PI * (0.5 - 0.2 * front + 0.12 * back);
                const theta = hairlineTheta * ring / rings;
                positions.push(
                    -Math.cos(phi) * Math.sin(theta),
                    Math.cos(theta),
                    Math.sin(phi) * Math.sin(theta),
                );
            }
        }
        for (let segment = 0; segment < segments; segment++) {
            const next = (segment + 1) % segments;
            indices.push(0, 1 + segment, 1 + next);
        }
        for (let ring = 0; ring < rings - 1; ring++) {
            const inner = 1 + ring * segments;
            const outer = inner + segments;
            for (let segment = 0; segment < segments; segment++) {
                const next = (segment + 1) % segments;
                indices.push(
                    inner + segment,
                    outer + segment,
                    outer + next,
                    inner + segment,
                    outer + next,
                    inner + next,
                );
            }
        }
        hairCrownGeo = new THREE.BufferGeometry();
        hairCrownGeo.setAttribute(
            'position',
            new THREE.Float32BufferAttribute(positions, 3),
        );
        hairCrownGeo.setIndex(indices);
        hairCrownGeo.computeVertexNormals();
        registerShared(hairCrownGeo);
    }
    return hairCrownGeo;
}

function placedSphere([x, y, z], [sx, sy, sz]) {
    const geometry = getSphereGeo().clone();
    geometry.applyMatrix4(new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion(),
        new THREE.Vector3(sx, sy, sz),
    ));
    return geometry;
}

function mergedHairGeo(key, build) {
    let geometry = hairGeoCache.get(key);
    if (geometry) return geometry;
    const parts = build();
    geometry = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    geometry.computeBoundingSphere();
    registerShared(geometry);
    hairGeoCache.set(key, geometry);
    return geometry;
}

// Unit-head-radius shapes, scaled by headR at the mesh. The ponytail is
// relative to the swing pivot (head centre); the temples to the head centre.
function getPonytailGeo() {
    // A high ponytail: the knot sits on the crown so it shows above the head
    // from the front, and the tail arcs back and down to the shoulder blades.
    return mergedHairGeo('ponytail', () => [
        placedSphere([0, 1.0, -0.48], [0.34, 0.3, 0.32]),
        placedSphere([0, 0.55, -1.0], [0.2, 0.6, 0.18]),
        placedSphere([0, -0.55, -1.14], [0.19, 0.8, 0.17]),
        placedSphere([0, -1.38, -1.12], [0.23, 0.26, 0.2]),
    ]);
}

function getTempleGeo() {
    return mergedHairGeo('temples', () => [-1, 1].map(side => (
        placedSphere([side * 0.98, 0.4, -0.02], [0.14, 0.24, 0.28])
    )));
}

function getCylinderGeo() {
    if (!cylinderGeo) {
        cylinderGeo = new THREE.CylinderGeometry(1, 1, 1, 8);
        registerShared(cylinderGeo);
    }
    return cylinderGeo;
}

function legSegmentGeometry(start, end, radius) {
    const direction = new THREE.Vector3().subVectors(end, start);
    const length = direction.length();
    const geometry = new THREE.CylinderGeometry(radius, radius, length, 8);
    const midpoint = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
    const rotation = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        direction.normalize(),
    );
    geometry.applyMatrix4(new THREE.Matrix4().compose(
        midpoint,
        rotation,
        new THREE.Vector3(1, 1, 1),
    ));
    return geometry;
}

function mergedLegPose(dims, { seated = false } = {}) {
    const hip = new THREE.Vector3(0, 0, 0);
    const halfLength = dims.legH * 0.5;
    const knee = seated
        ? new THREE.Vector3(0, -Math.cos(1.25) * halfLength, Math.sin(1.25) * halfLength)
        : new THREE.Vector3(0, -halfLength, 0);
    const ankle = seated
        ? new THREE.Vector3(0, knee.y - halfLength, knee.z)
        : new THREE.Vector3(0, -dims.legH, 0);
    const parts = [
        legSegmentGeometry(hip, knee, dims.legR),
        legSegmentGeometry(knee, ankle, dims.legR),
    ];
    const geometry = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    return geometry;
}

function getLegGeo(kind, dims) {
    let geometry = legGeoCache.get(kind);
    if (geometry) return geometry;
    geometry = mergedLegPose(dims);
    const seated = mergedLegPose(dims, { seated: true });
    geometry.morphAttributes.position = [seated.getAttribute('position').clone()];
    geometry.morphAttributes.normal = [seated.getAttribute('normal').clone()];
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    seated.dispose();
    registerShared(geometry);
    legGeoCache.set(kind, geometry);
    return geometry;
}

function getMat(hex) {
    let material = matCache.get(hex);
    if (!material) {
        material = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.75 });
        registerShared(material);
        matCache.set(hex, material);
    }
    return material;
}

export function personDims(kind) {
    if (kind === 'kid') return {
        headR: 0.13, bodyH: 0.48, bodyR: 0.13,
        legH: 0.44, legR: 0.035, legX: 0.055,
        armH: 0.38, armR: 0.03, armX: 0.15,
    };
    if (kind === 'female') return {
        headR: 0.145, bodyH: 0.70, bodyR: 0.17,
        legH: 0.64, legR: 0.04, legX: 0.065,
        armH: 0.55, armR: 0.032, armX: 0.19,
    };
    return {
        headR: 0.15, bodyH: 0.76, bodyR: 0.17,
        legH: 0.72, legR: 0.045, legX: 0.07,
        armH: 0.60, armR: 0.035, armX: 0.20,
    };
}

function pick(random, values) {
    return values[Math.min(values.length - 1, Math.floor(random() * values.length))];
}

export function createPersonMesh({
    kind = 'male',
    bodyColor = PERSON_BODY_COLORS[0],
    skinColor = PERSON_SKIN_COLORS[0],
    legColor = PERSON_LEG_COLORS[0],
    hairColor = null,
    hairStyle = 'long',
    hairTempleColor = null,
    face = null,
    faceSeed = null,
} = {}) {
    const dims = personDims(kind);
    const group = new THREE.Group();
    const legs = [];
    const arms = [];

    const profile = face ? null : personHeadProfile(
        faceSeed ?? Math.floor(Math.random() * 0x100000000), kind);
    const head = new THREE.Mesh(
        profile ? getPersonHeadGeometry(profile.variant) : getSphereGeo(),
        profile ? getPersonHeadMaterial(skinColor) : getMat(skinColor),
    );
    head.name = 'PersonHead';
    head.position.y = dims.legH + dims.bodyH + dims.headR * 1.05;
    head.scale.set(dims.headR, dims.headR * 1.08, dims.headR);
    // An explicitly authored hairstyle was fitted to the original head size.
    if (profile && !Number.isFinite(hairColor)) {
        head.scale.multiply(new THREE.Vector3(profile.width, profile.height, profile.depth));
    }
    if (profile) group.userData.faceSeed = profile.faceSeed;
    group.add(head);

    if (Number.isFinite(hairColor)) {
        if (!PERSON_HAIR_STYLES.includes(hairStyle)) {
            throw new RangeError(`Unknown hair style "${hairStyle}".`);
        }
        const material = getMat(hairColor);
        const crown = new THREE.Mesh(getHairCrownGeo(), material);
        crown.name = 'PersonHair';
        crown.position.copy(head.position);
        crown.position.y += dims.headR * 0.015;
        crown.scale.set(dims.headR * 1.055, dims.headR * 1.1, dims.headR * 1.055);
        group.add(crown);

        // Everything that hangs from the head swings from a pivot on the head
        // centre; animatePersonHair rotates it while the crown stays put.
        const swing = new THREE.Group();
        swing.name = 'PersonHairSwing';
        swing.position.copy(head.position);

        if (hairStyle === 'long') {
            // A flattened low-poly fall behind the head makes this read as hair,
            // not a helmet. It reaches onto the upper back while remaining behind
            // the forehead and face plane.
            const back = new THREE.Mesh(getSphereGeo(), material);
            back.name = 'PersonHairBack';
            back.position.set(0, -dims.headR * 0.92, -dims.headR * 0.92);
            back.scale.set(dims.headR * 1.05, dims.headR * 1.72, dims.headR * 0.52);
            swing.add(back);

            for (const side of [-1, 1]) {
                const lock = new THREE.Mesh(getSphereGeo(), material);
                lock.name = side < 0 ? 'PersonHairSideLeft' : 'PersonHairSideRight';
                lock.position.set(side * dims.headR * 0.82, -dims.headR * 0.72, -dims.headR * 0.2);
                lock.scale.set(dims.headR * 0.28, dims.headR * 1.08, dims.headR * 0.34);
                swing.add(lock);
            }
        } else if (hairStyle === 'ponytail') {
            // Gathered high on the crown, the tail hangs to the shoulder blades
            // and flares slightly at the tip.
            const tail = new THREE.Mesh(getPonytailGeo(), material);
            tail.name = 'PersonHairPonytail';
            tail.scale.setScalar(dims.headR);
            swing.add(tail);
        } else if (hairStyle === 'bun') {
            const bun = new THREE.Mesh(getSphereGeo(), material);
            bun.name = 'PersonHairBun';
            bun.position.copy(head.position);
            bun.position.y += dims.headR * 0.52;
            bun.position.z -= dims.headR * 0.78;
            bun.scale.set(dims.headR * 0.42, dims.headR * 0.36, dims.headR * 0.4);
            group.add(bun);
        }
        if (hairStyle === 'short' && Number.isFinite(hairTempleColor)) {
            const temples = new THREE.Mesh(getTempleGeo(), getMat(hairTempleColor));
            temples.name = 'PersonHairTemples';
            temples.position.copy(head.position);
            temples.scale.setScalar(dims.headR);
            group.add(temples);
        }
        if (swing.children.length > 0) {
            group.add(swing);
            group.userData.hairSwing = { pivot: swing, state: createHairSwingState() };
        }
    }

    // Authored expressions use the existing face rig; ambient markings are
    // already part of the single shared head mesh above.
    if (face) attachPersonFace({ group, head, dims, skinColor, spec: face, material: getMat });

    const body = new THREE.Mesh(getCylinderGeo(), getMat(bodyColor));
    body.name = 'PersonBody';
    body.position.y = dims.legH + dims.bodyH / 2;
    body.scale.set(dims.bodyR, dims.bodyH, dims.bodyR);
    group.add(body);

    for (const side of [-1, 1]) {
        // One morphing mesh contains both thigh and shin. Sitting bends the
        // shared geometry at the knee without adding a draw call per segment.
        const leg = new THREE.Mesh(getLegGeo(kind, dims), getMat(legColor));
        leg.name = side < 0 ? 'PersonLegLeft' : 'PersonLegRight';
        leg.position.set(side * dims.legX, dims.legH, 0);
        legs.push({ mesh: leg, side });
        group.add(leg);

        const arm = new THREE.Mesh(getCylinderGeo(), getMat(skinColor));
        arm.position.set(side * dims.armX, dims.legH + dims.bodyH * 0.52, 0);
        arm.scale.set(dims.armR, dims.armH, dims.armR);
        arms.push({ mesh: arm, side });
        group.add(arm);
    }
    // One head + torso silhouette is enough for an actor this small. Casting
    // every articulated arm, leg, hair lock and moustache multiplied the
    // pedestrian shadow pass to 27 draws in the tram trace.
    head.castShadow = true;
    body.castShadow = true;
    group.userData.walkLimbs = { arms, legs };
    group.userData.personDimensions = { ...dims };
    return group;
}

export function createRandomPersonMesh(random = Math.random) {
    const roll = random();
    return createPersonMesh({
        kind: roll < 0.20 ? 'kid' : (roll < 0.58 ? 'female' : 'male'),
        bodyColor: pick(random, PERSON_BODY_COLORS),
        skinColor: pick(random, PERSON_SKIN_COLORS),
        legColor: pick(random, PERSON_LEG_COLORS),
        faceSeed: Math.floor(random() * 0x100000000),
    });
}

// Build shared procedural assets while the world loading gate is still up. A
// late first kid/female walker otherwise pays cylinder merges and morph-target
// construction inside pedestrians:population during live movement.
export function prepareAmbientPersonMeshAssets() {
    preparePersonHeadAssets();
    getSphereGeo();
    getCylinderGeo();
    for (const kind of ['kid', 'female', 'male']) getLegGeo(kind, personDims(kind));
    for (const color of [
        ...PERSON_BODY_COLORS,
        ...PERSON_SKIN_COLORS,
        ...PERSON_LEG_COLORS,
    ]) getMat(color);
    return true;
}

export function animatePersonWalk(person, phase, amount = 1) {
    const limbs = person && person.userData && person.userData.walkLimbs;
    if (!limbs) return;
    const swing = Math.sin(phase) * 0.55 * Math.max(0, Math.min(1, amount));
    for (const { mesh, side } of limbs.legs) {
        mesh.rotation.x = swing * side;
        if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[0] = 0;
    }
    for (const { mesh, side } of limbs.arms) mesh.rotation.x = -swing * side;
}

/**
 * Swings the hair pivot (long fall and locks, or the ponytail) behind the walk
 * bob and behind the person's own heading changes. Allocation-free; the spring
 * state lives on the person's userData. Returns false without a swing rig.
 */
export function animatePersonHair(person, { phase, walking = 0, dt }) {
    const rig = person?.userData?.hairSwing;
    if (!rig) return false;
    const state = stepHairSwing(rig.state, { phase, walking, heading: person.rotation.y, dt });
    rig.pivot.rotation.set(state.pitch, state.yaw, state.roll);
    return true;
}

export function resetPersonHair(person) {
    const rig = person?.userData?.hairSwing;
    if (!rig) return false;
    rig.state = createHairSwingState();
    rig.pivot.rotation.set(0, 0, 0);
    return true;
}

export function animatePersonSit(person, amount = 1) {
    const limbs = person?.userData?.walkLimbs;
    const dims = person?.userData?.personDimensions;
    if (!limbs || !dims) return;
    const ratio = Math.max(0, Math.min(1, Number(amount) || 0));
    const armAngle = ratio === 0 ? 0 : -0.92 * ratio;

    for (const { mesh } of limbs.legs) {
        mesh.rotation.x = 0;
        if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[0] = ratio;
    }

    const armRestY = dims.legH + dims.bodyH * 0.52;
    const shoulderY = armRestY + dims.armH * 0.5;
    for (const { mesh, side } of limbs.arms) {
        const targetY = shoulderY - Math.cos(-0.92) * dims.armH * 0.5;
        const targetZ = -Math.sin(-0.92) * dims.armH * 0.5;
        mesh.position.set(
            side * dims.armX,
            THREE.MathUtils.lerp(armRestY, targetY, ratio),
            THREE.MathUtils.lerp(0, targetZ, ratio),
        );
        mesh.rotation.x = armAngle;
    }
}

export function disposePersonMeshSessionCaches() {
    const resources = new Set([
        sphereGeo,
        hairCrownGeo,
        cylinderGeo,
        ...legGeoCache.values(),
        ...hairGeoCache.values(),
        ...matCache.values(),
    ]);
    for (const resource of resources) {
        if (!resource) continue;
        unregisterShared(resource);
        resource.dispose();
    }
    sphereGeo = null;
    hairCrownGeo = null;
    cylinderGeo = null;
    legGeoCache.clear();
    hairGeoCache.clear();
    matCache.clear();
    disposePersonFaceCaches();
    disposePersonHeadCaches();
}
