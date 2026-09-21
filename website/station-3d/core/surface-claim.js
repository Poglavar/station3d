import { compileSurfaceClaim } from './surface-hierarchy.js';

// THREE-free attachment helpers. Geometry producers publish through this tiny
// adapter; policy and validation remain exclusively in surface-hierarchy.js.
export function markSurfaceClaim(object, input) {
    if (!object || typeof object !== 'object') {
        throw new TypeError('Surface claim target must be an object');
    }
    const claim = input?.contract === 'station3d-surface-claim-v1'
        ? input
        : compileSurfaceClaim(input);
    object.userData ||= {};
    object.userData.surfaceClaim = claim;
    return claim;
}

export function surfaceClaimForObject(object) {
    for (let node = object; node; node = node.parent) {
        const claim = node.userData?.surfaceClaim;
        if (claim) return claim;
    }
    return null;
}
