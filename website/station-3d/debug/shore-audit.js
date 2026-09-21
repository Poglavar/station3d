// window.__s3dShoreAudit(): walks the mapped shoreline around the camera and
// asks, for every collar quad, whether paved ground behind it meets the sea
// with a face or ramps into it (core/shore-formation-audit.js). The heights
// come from vertical rays against claimed ground surfaces only, so decor,
// vehicles and the walker never count as ground.

import * as THREE from 'three';
import { surfaceClaimForObject } from '../core/surface-claim.js';
import { auditShoreQuads, SHORE_KIND } from '../core/shore-formation-audit.js';

const raycaster = new THREE.Raycaster();
const down = new THREE.Vector3(0, -1, 0);
const origin = new THREE.Vector3();

// Highest claimed ground surface under (x, z), or null where nothing claimed is drawn.
export function claimedGroundTopYAt(scene, x, z, { fromY = 500 } = {}) {
    origin.set(x, fromY, z);
    raycaster.set(origin, down);
    for (const hit of raycaster.intersectObject(scene, true)) {
        if (!hit.object.isMesh || hit.object.visible === false) continue;
        if (!surfaceClaimForObject(hit.object)) continue;
        return hit.point.y;
    }
    return null;
}

export function runShoreAudit({ scene, quads, seaY, pavedAt }) {
    const report = auditShoreQuads(quads, {
        seaY,
        pavedAt,
        topYAt: (x, z) => claimedGroundTopYAt(scene, x, z),
    });
    return { ...report, rampedCount: report.byKind[SHORE_KIND.RAMPED] || 0 };
}

export function installShoreAudit({ scene, camera, getQuadsNear, getSeaY, pavedAt }) {
    if (typeof window === 'undefined') return;
    window.__s3dShoreAudit = () => {
        const x = camera.position.x;
        const z = camera.position.z;
        const seaY = getSeaY();
        if (!Number.isFinite(seaY)) return { contract: null, reason: 'no mapped sea' };
        return runShoreAudit({ scene, quads: getQuadsNear(x, z), seaY, pavedAt });
    };
}
