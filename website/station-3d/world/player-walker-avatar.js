import * as THREE from 'three';

import { registerShared } from '../core/dispose.js';
import { animatePersonWalk, createPersonMesh } from './person-mesh.js';

let tankGeometry = null;
let nozzleGeometry = null;
let flameGeometry = null;
let canopyGeometry = null;
let riserGeometry = null;
let tankMaterial = null;
let nozzleMaterial = null;
let outerFlameMaterial = null;
let innerFlameMaterial = null;
let canopyMaterial = null;
let riserMaterial = null;

// Canopy proportions: a round emergency chute over a bailed-out pilot.
const CANOPY_RADIUS_M = 3.2;
const CANOPY_HEIGHT_M = 6.4;

const FLIGHT_ARM_RAISE_PER_SECOND = 5;
const FLIGHT_ARM_RELAX_PER_SECOND = 1.15;

function moveToward(current, target, maximumDelta) {
    if (current < target) return Math.min(target, current + maximumDelta);
    return Math.max(target, current - maximumDelta);
}

function sharedGeometry(current, create) {
    if (current) return current;
    const geometry = create();
    registerShared(geometry);
    return geometry;
}

function sharedMaterial(current, create) {
    if (current) return current;
    const material = create();
    registerShared(material);
    return material;
}

function resources() {
    tankGeometry = sharedGeometry(
        tankGeometry,
        () => new THREE.CylinderGeometry(0.07, 0.07, 0.43, 8),
    );
    nozzleGeometry = sharedGeometry(
        nozzleGeometry,
        () => new THREE.CylinderGeometry(0.045, 0.055, 0.12, 8),
    );
    flameGeometry = sharedGeometry(
        flameGeometry,
        () => new THREE.ConeGeometry(0.065, 0.4, 7),
    );
    tankMaterial = sharedMaterial(
        tankMaterial,
        () => new THREE.MeshStandardMaterial({ color: 0x3c4650, roughness: 0.42, metalness: 0.72 }),
    );
    nozzleMaterial = sharedMaterial(
        nozzleMaterial,
        () => new THREE.MeshStandardMaterial({ color: 0x171b20, roughness: 0.35, metalness: 0.8 }),
    );
    outerFlameMaterial = sharedMaterial(
        outerFlameMaterial,
        () => new THREE.MeshBasicMaterial({
            color: 0xff6a18,
            transparent: true,
            opacity: 0.82,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        }),
    );
    innerFlameMaterial = sharedMaterial(
        innerFlameMaterial,
        () => new THREE.MeshBasicMaterial({
            color: 0xffef9c,
            transparent: true,
            opacity: 0.92,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        }),
    );
    canopyGeometry = sharedGeometry(
        canopyGeometry,
        // Upper hemisphere only; both faces show because the pilot looks up
        // into it.
        () => new THREE.SphereGeometry(CANOPY_RADIUS_M, 18, 8, 0, Math.PI * 2, 0, Math.PI * 0.5),
    );
    riserGeometry = sharedGeometry(
        riserGeometry,
        () => new THREE.CylinderGeometry(0.012, 0.012, 1, 4),
    );
    canopyMaterial = sharedMaterial(
        canopyMaterial,
        () => new THREE.MeshStandardMaterial({
            color: 0xe7dcc3,
            roughness: 0.9,
            side: THREE.DoubleSide,
        }),
    );
    riserMaterial = sharedMaterial(
        riserMaterial,
        () => new THREE.MeshBasicMaterial({ color: 0x3a3a3a }),
    );
}

// The canopy group hangs above the person: a hemisphere and four risers from
// its rim down to the shoulders. Hidden unless the walker is under it.
function createParachute() {
    const parachute = new THREE.Group();
    parachute.name = 'PlayerParachute';
    const canopy = new THREE.Mesh(canopyGeometry, canopyMaterial);
    canopy.position.y = CANOPY_HEIGHT_M;
    canopy.castShadow = true;
    parachute.add(canopy);
    const shoulderY = 1.45;
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const rimX = dx * CANOPY_RADIUS_M * 0.72;
        const rimZ = dz * CANOPY_RADIUS_M * 0.72;
        const from = new THREE.Vector3(dx * 0.2, shoulderY, dz * 0.12);
        const to = new THREE.Vector3(rimX, CANOPY_HEIGHT_M + 0.1, rimZ);
        const riser = new THREE.Mesh(riserGeometry, riserMaterial);
        const length = from.distanceTo(to);
        riser.position.copy(from).lerp(to, 0.5);
        riser.scale.y = length;
        riser.quaternion.setFromUnitVectors(
            new THREE.Vector3(0, 1, 0),
            to.clone().sub(from).normalize(),
        );
        parachute.add(riser);
    }
    parachute.visible = false;
    return parachute;
}

// The player's one look, shared with the pilot seated in the smuggler's
// aircraft and the stand-in of the splashdown film, so "you" is the same
// person in every shot. The face seed keeps the face the same between sessions.
export const PLAYER_PERSON_LOOK = Object.freeze({
    kind: 'male',
    bodyColor: 0xf59e0b,
    skinColor: 0xe0ac69,
    legColor: 0x2563eb,
    faceSeed: 0x1f4a9c,
});

// The conductor's cap Miltonka hands over: a peaked service cap with a red
// badge, sized from the procedural head so it sits on the crown whatever the
// face seed drew. Built hidden; the campaign's `conductor-hat` world effect
// shows it.
const CAP_CROWN_COLOR = 0x1f2a44;
const CAP_TRIM_COLOR = 0x111418;
const CAP_BADGE_COLOR = 0xb91c1c;
function createConductorCap(person) {
    const head = person.getObjectByName('PersonHead');
    if (!head) return null;
    const R = head.scale.x;
    const cap = new THREE.Group();
    cap.name = 'PlayerConductorCap';
    cap.position.set(head.position.x, head.position.y, head.position.z);
    const crown = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), new THREE.MeshStandardMaterial({ color: CAP_CROWN_COLOR, roughness: 0.8 }));
    crown.position.set(0, 0.92 * R, -0.04 * R);
    crown.scale.set(1.16 * R, 0.5 * R, 1.16 * R);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 20), new THREE.MeshStandardMaterial({ color: CAP_TRIM_COLOR, roughness: 0.7 }));
    band.position.set(0, 0.62 * R, 0);
    band.scale.set(1.08 * R, 0.24 * R, 1.08 * R);
    const peak = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 20, 1, false, 0, Math.PI), band.material);
    peak.position.set(0, 0.52 * R, 0.1 * R);
    peak.scale.set(1.2 * R, 0.05 * R, 1.05 * R);
    const badge = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshStandardMaterial({ color: CAP_BADGE_COLOR, roughness: 0.4 }));
    badge.position.set(0, 0.66 * R, 1.08 * R);
    badge.scale.setScalar(0.08 * R);
    for (const mesh of [crown, band, peak, badge]) {
        mesh.castShadow = true;
        mesh.userData.walkColliderBoxes = [];
        cap.add(mesh);
    }
    cap.visible = false;
    // Follows the head, which the walk cycle bobs and turns with the body.
    head.parent?.add?.(cap);
    return cap;
}

export function createPlayerWalkerAvatar() {
    resources();
    const avatar = new THREE.Group();
    avatar.name = 'PlayerWalker';
    avatar.visible = false;

    const person = createPersonMesh({ ...PLAYER_PERSON_LOOK });
    avatar.add(person);
    const hat = createConductorCap(person);

    const jetpack = new THREE.Group();
    jetpack.name = 'PlayerJetpack';
    const flames = [];
    for (const side of [-1, 1]) {
        const x = side * 0.105;
        const tank = new THREE.Mesh(tankGeometry, tankMaterial);
        tank.position.set(x, 1.03, -0.2);
        tank.castShadow = true;
        jetpack.add(tank);

        const nozzle = new THREE.Mesh(nozzleGeometry, nozzleMaterial);
        nozzle.position.set(x, 0.76, -0.2);
        nozzle.castShadow = true;
        jetpack.add(nozzle);

        const outer = new THREE.Mesh(flameGeometry, outerFlameMaterial);
        outer.position.set(x, 0.51, -0.2);
        outer.rotation.z = Math.PI;
        outer.visible = false;
        jetpack.add(outer);
        flames.push({ mesh: outer, phase: side < 0 ? 0 : Math.PI, inner: false });

        const inner = new THREE.Mesh(flameGeometry, innerFlameMaterial);
        inner.position.set(x, 0.57, -0.2);
        inner.rotation.z = Math.PI;
        inner.scale.set(0.48, 0.62, 0.48);
        inner.visible = false;
        jetpack.add(inner);
        flames.push({ mesh: inner, phase: side < 0 ? 1.1 : 2.4, inner: true });
    }
    avatar.add(jetpack);
    const parachute = createParachute();
    avatar.add(parachute);
    const flightArms = person.userData.walkLimbs.arms.map(({ mesh }) => ({
        mesh,
        restX: mesh.position.x,
        restY: mesh.position.y,
        restZ: mesh.position.z,
        lengthM: mesh.scale.y,
        shoulderY: mesh.position.y + mesh.scale.y * 0.5,
    }));
    avatar.userData.playerWalker = {
        person,
        hat,
        jetpack,
        parachute,
        flames,
        flightArms,
        flightArmBlend: 0,
        walkPhase: 0,
    };
    return avatar;
}

export function updatePlayerWalkerAvatar(avatar, {
    x = 0,
    y = 0,
    z = 0,
    headingRad = 0,
    horizontalDistanceM = 0,
    airborne = false,
    jetpackActive = false,
    jetpackAvailable = true,
    parachuteActive = false,
    elapsedSeconds = 0,
    dt = 1 / 60,
    visible = true,
    // Miltonka's conductor's cap: shown once the campaign says it is worn.
    hat = false,
} = {}) {
    const worn = avatar?.userData?.playerWalker?.hat;
    if (worn) worn.visible = hat === true;
    const state = avatar?.userData?.playerWalker;
    if (!avatar || !state) return;
    avatar.visible = !!visible;
    avatar.position.set(x, y, z);
    avatar.rotation.y = headingRad;
    state.jetpack.visible = !!jetpackAvailable && !parachuteActive;
    if (state.parachute) state.parachute.visible = !!parachuteActive;
    state.walkPhase += Math.max(0, Number(horizontalDistanceM) || 0) * 5.2;
    animatePersonWalk(
        state.person,
        state.walkPhase,
        !airborne && horizontalDistanceM > 0.0005 ? 1 : 0,
    );
    const frameSeconds = Math.max(0, Math.min(0.1, Number(dt) || 0));
    const thrustActive = !!jetpackAvailable && !!jetpackActive;
    const targetArmBlend = thrustActive ? 1 : 0;
    state.flightArmBlend = moveToward(
        Number(state.flightArmBlend) || 0,
        targetArmBlend,
        frameSeconds * (thrustActive
            ? FLIGHT_ARM_RAISE_PER_SECOND
            : FLIGHT_ARM_RELAX_PER_SECOND),
    );
    for (const arm of state.flightArms) {
        const blend = state.flightArmBlend;
        if (blend <= 0) {
            arm.mesh.position.set(arm.restX, arm.restY, arm.restZ);
            continue;
        }
        // Rotate the hanging arm around its SHOULDER, not around the cylinder
        // centre. The hand therefore traces a forward circular arc while the
        // shoulder remains fixed; releasing thrust follows the same arc down.
        // Shared people face local +Z, so a negative X rotation sends the hand
        // forward rather than retreating into the jetpack behind them.
        const angle = -Math.PI * 0.5 * blend;
        const halfLength = arm.lengthM * 0.5;
        arm.mesh.rotation.x = angle;
        arm.mesh.position.set(
            arm.restX,
            arm.shoulderY - Math.cos(angle) * halfLength,
            arm.restZ - Math.sin(angle) * halfLength,
        );
    }
    for (const flame of state.flames) {
        flame.mesh.visible = thrustActive;
        if (!thrustActive) continue;
        const flicker = 0.82 + Math.sin(elapsedSeconds * 31 + flame.phase) * 0.16;
        const width = flame.inner ? 0.48 : 1;
        const height = (flame.inner ? 0.62 : 1) * flicker;
        flame.mesh.scale.set(width, height, width);
    }
}
