// A gun armed in a car used to be the tram's first-person weapon: the mesh
// copied the camera's transform, so in the chase view it floated in front of
// the camera instead of sitting on the vehicle, and it fired along the camera
// rather than along its own barrel.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    MOUNTED_MAX_PITCH_RAD,
    MOUNTED_MIN_PITCH_RAD,
    mountedWeaponAim,
} from '../core/mounted-weapon-aim.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const close = (a, b, tolerance = 1e-9) => Math.abs(a - b) <= tolerance;

test('the turret faces where the player looks', () => {
    // Straight ahead is -Z, matching the camera convention the gun model uses.
    const ahead = mountedWeaponAim({ x: 0, y: 0, z: -1 });
    assert.ok(close(ahead.yaw, 0));
    assert.ok(close(ahead.pitch, 0));
    assert.ok(close(ahead.dir.z, -1));

    // A quarter turn to the right.
    const right = mountedWeaponAim({ x: 1, y: 0, z: 0 });
    assert.ok(close(right.yaw, -Math.PI / 2));
    assert.ok(close(right.dir.x, 1, 1e-9));
    assert.ok(close(right.dir.z, 0, 1e-9));

    // Behind.
    const behind = mountedWeaponAim({ x: 0, y: 0, z: 1 });
    assert.ok(close(Math.abs(behind.yaw), Math.PI));
    assert.ok(close(behind.dir.z, 1, 1e-9));
});

test('the reported direction is always a unit vector, so bullets keep their speed', () => {
    for (const forward of [
        { x: 0, y: 0, z: -1 },
        { x: 3, y: 4, z: -12 },
        { x: -0.2, y: 0.9, z: 0.1 },
        { x: 1, y: -5, z: 1 },
    ]) {
        const { dir } = mountedWeaponAim(forward);
        assert.ok(close(Math.hypot(dir.x, dir.y, dir.z), 1, 1e-9), JSON.stringify(dir));
    }
});

test('pitch is clamped, and the direction reflects the clamp rather than the input', () => {
    const steepDown = mountedWeaponAim({ x: 0, y: -1, z: -0.001 });
    assert.ok(close(steepDown.pitch, MOUNTED_MIN_PITCH_RAD));
    // If the barrel cannot look there, the bullets must not either.
    assert.ok(close(steepDown.dir.y, Math.sin(MOUNTED_MIN_PITCH_RAD), 1e-9));

    const steepUp = mountedWeaponAim({ x: 0, y: 1, z: -0.001 });
    assert.ok(close(steepUp.pitch, MOUNTED_MAX_PITCH_RAD));
    assert.ok(close(steepUp.dir.y, Math.sin(MOUNTED_MAX_PITCH_RAD), 1e-9));

    // Depression is the tighter limit — the barrel must not sweep into its own roof.
    assert.ok(Math.abs(MOUNTED_MIN_PITCH_RAD) < MOUNTED_MAX_PITCH_RAD);
});

test('a degenerate look direction aims straight ahead instead of producing NaN', () => {
    for (const bad of [{ x: 0, y: 0, z: 0 }, {}, null, { x: NaN, y: 1, z: 1 }]) {
        const aim = mountedWeaponAim(bad);
        assert.equal(aim.yaw, 0);
        assert.equal(aim.pitch, 0);
        assert.deepEqual(aim.dir, { x: 0, y: 0, z: -1 });
    }
});

test('the weapon rides the vehicle and fires along its own barrel', () => {
    const weapon = read('../world/weapon.js');
    // The meshes live in their own rig so the pivot can carry the aim.
    assert.match(weapon, /weaponGroup = new THREE\.Group\(\);[\s\S]{0,120}weaponGroup\.add\(gunRig\);/);
    assert.match(weapon, /weaponGroup\.rotation\.set\(aim\.pitch, aim\.yaw, 0, 'YXZ'\);/);
    assert.match(weapon, /weaponGroup\.position\.set\(\s*\n\s*Number\(mount\.x\)/);
    // Bullets take the settled aim, not the raw camera forward, or the turret
    // would visibly point one way and shoot another once pitch is clamped.
    assert.match(weapon, /_camForward\.copy\(_aimDir\);/);
    assert.doesNotMatch(
        weapon,
        /muzzleAnchor\.getWorldPosition\(_muzzleWorld\);\s*\n\s*camera\.getWorldDirection\(_camForward\);/,
        'bullets are reading the camera again',
    );
});

test('the cab mounts the turret on a road vehicle and stows it on foot', () => {
    const cab = read('../modes/cab.js');
    assert.match(cab, /setWeaponMount\(\(\) => \{[\s\S]{0,260}isDrivingGtaVehicle\(active\)/);
    // The vehicle reports its own roof height; a fixed offset buried the gun
    // inside the bodywork of the campaign sedan.
    assert.match(cab, /active\.gtaSession\?\.getWeaponMountPoint\?\.\(\)/);
    const gta = read('../modes/gta.js');
    assert.match(gta, /getWeaponMountPoint\(\) \{/);
    assert.match(gta, /y: pose\.y \+ \(heightM != null && heightM > 0/);
    // Handing it back to the camera is part of stowing.
    assert.match(cab, /setWeaponMount\(null\);\s*\n\s*detachWeapon\(\);/);
    // Visible from the chase camera, and no first-person sight pull.
    assert.match(cab, /if \(isWeaponMounted\(\)\) \{[\s\S]{0,220}setWeaponVisible\(true\);[\s\S]{0,120}setCameraLookDirectAim\(false\);/);
});

test('mounted means riding a vehicle right now, not merely offered a mount', () => {
    // The callback returns null between vehicles; a flag that only tracked
    // whether a mount had been installed would answer the wrong question and
    // leave a tram cab without its first-person sight.
    const weapon = read('../world/weapon.js');
    assert.match(weapon, /export function isWeaponMounted\(\) \{\s*\n\s*return !!\(weaponMountFn && weaponMountFn\(\)\);/);
});
