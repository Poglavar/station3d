// Reusable bench geometry and materials; the decor layer owns placement and batching.
import * as THREE from 'three';

export function createBenchParts() {
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.9 });
    const metalMat = new THREE.MeshStandardMaterial({ color: 0x4b5563, metalness: 0.35, roughness: 0.55 });
    const seatGeo = new THREE.BoxGeometry(1.34, 0.08, 0.36);
    seatGeo.translate(0, 0.46, 0);
    const backGeo = new THREE.BoxGeometry(1.34, 0.34, 0.08);
    backGeo.translate(0, 0.68, -0.14);
    const leftSupportGeo = new THREE.BoxGeometry(0.08, 0.42, 0.3);
    leftSupportGeo.translate(-0.54, 0.21, -0.02);
    const rightSupportGeo = new THREE.BoxGeometry(0.08, 0.42, 0.3);
    rightSupportGeo.translate(0.54, 0.21, -0.02);

    return { woodMat, metalMat, seatGeo, backGeo, leftSupportGeo, rightSupportGeo };
}
