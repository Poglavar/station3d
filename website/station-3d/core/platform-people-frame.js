// Convert deterministic platform-person records between scene-graph frames.
// Crowd meshes are consolidated under the platform-window root to save draw
// calls, so their station-local positions must be baked into that root first.

import * as THREE from 'three';

export function platformPeopleInTargetFrame(
    people,
    sourceMatrixWorld,
    targetMatrixWorld,
) {
    if (!Array.isArray(people) || people.length === 0) return [];

    const sourceToTarget = new THREE.Matrix4()
        .copy(targetMatrixWorld)
        .invert()
        .multiply(sourceMatrixWorld);
    const point = new THREE.Vector3();
    const heading = new THREE.Vector3();

    return people.map((person) => {
        point.set(person.x, person.y, person.z).applyMatrix4(sourceToTarget);
        const yaw = Number.isFinite(person.yaw) ? person.yaw : 0;
        heading
            .set(Math.sin(yaw), 0, Math.cos(yaw))
            .transformDirection(sourceToTarget);
        return {
            ...person,
            x: point.x,
            y: point.y,
            z: point.z,
            yaw: Math.atan2(heading.x, heading.z),
        };
    });
}
