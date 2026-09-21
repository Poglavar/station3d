// Builds the first-person and mounted gun appearance with explicit material/resource ownership.
import * as THREE from 'three';

export const GUN_X = 0.55;
export const GUN_Y = -0.55;
export const GUN_RECEIVER_Z = -1.10;
export const GUN_BARREL_Z   = -1.55;
export const GUN_MUZZLE_Z   = -2.18;

export function buildMachineGunMesh({ metalMaterial, muzzleMaterial, register }) {
    const g = new THREE.Group();
    const mat = metalMaterial;

    // Receiver — chunky block at the back of the barrel.
    const receiverGeom = new THREE.BoxGeometry(0.22, 0.24, 0.40);
    register(receiverGeom);
    const receiver = new THREE.Mesh(receiverGeom, mat);
    receiver.position.set(GUN_X, GUN_Y, GUN_RECEIVER_Z);
    g.add(receiver);

    // Barrel — cylinder; default axis is +Y, rotate so its axis lies along Z.
    const barrelGeom = new THREE.CylinderGeometry(0.05, 0.062, 1.20, 14);
    barrelGeom.rotateX(Math.PI / 2);
    register(barrelGeom);
    const barrel = new THREE.Mesh(barrelGeom, mat);
    barrel.position.set(GUN_X, GUN_Y, GUN_BARREL_Z);
    g.add(barrel);

    // Cooling sleeve — slightly bigger ringy cylinder around the front
    // half of the barrel for visual interest.
    const sleeveGeom = new THREE.CylinderGeometry(0.095, 0.095, 0.36, 14);
    sleeveGeom.rotateX(Math.PI / 2);
    register(sleeveGeom);
    const sleeve = new THREE.Mesh(sleeveGeom, mat);
    sleeve.position.set(GUN_X, GUN_Y, GUN_BARREL_Z - 0.30);
    g.add(sleeve);

    // Muzzle flash (initially hidden) — small bright cone-ish sphere right
    // at the barrel tip. Scale & visibility pulse on each shot.
    const flashGeom = new THREE.SphereGeometry(0.18, 10, 8);
    register(flashGeom);
    const flash = new THREE.Mesh(flashGeom, muzzleMaterial);
    flash.position.set(GUN_X, GUN_Y, GUN_MUZZLE_Z + 0.04);
    flash.visible = false;
    g.add(flash);

    // Anchor (no mesh) at the muzzle so we can sample its world position
    // for bullet spawn — keeps spawn correct as the camera turns.
    const muzzle = new THREE.Object3D();
    muzzle.position.set(GUN_X, GUN_Y, GUN_MUZZLE_Z);
    g.add(muzzle);

    return { group: g, muzzle, flash };
}

