// Pure 2D visibility scoring for streamed world work. It deliberately avoids
// Three.js so tile/build queues can be prioritized and unit-tested before an
// object exists in the scene graph.

import { DEG_TO_RAD, EARTH_RADIUS_M } from './math.js';

const TIER_STRIDE = 1e12;
const DISTANCE_WEIGHT = 1e9;
const CENTER_WEIGHT = 1e5;
const PROMINENCE_WEIGHT = 1e6;
const VISIBLE_MARGIN_DEG = 8;
const PERIPHERAL_MARGIN_DEG = 55;

export const VIEW_PRIORITY_TIERS = Object.freeze({
    support: 4,
    visible: 3,
    peripheral: 2,
    hidden: 1,
    unknown: 0,
});

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function validBounds(bounds) {
    return bounds
        && Number.isFinite(Number(bounds.minX))
        && Number.isFinite(Number(bounds.maxX))
        && Number.isFinite(Number(bounds.minZ))
        && Number.isFinite(Number(bounds.maxZ))
        && Number(bounds.minX) <= Number(bounds.maxX)
        && Number(bounds.minZ) <= Number(bounds.maxZ);
}

export function normalizeHeadingDeg(headingDeg) {
    const heading = Number(headingDeg);
    if (!Number.isFinite(heading)) return Number.NaN;
    return ((heading % 360) + 360) % 360;
}

export function signedHeadingDeltaDeg(aDeg, bDeg) {
    const a = normalizeHeadingDeg(aDeg);
    const b = normalizeHeadingDeg(bDeg);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.NaN;
    return ((a - b + 540) % 360) - 180;
}

export function horizontalFovDeg(verticalFovDeg, aspect = 1) {
    const vertical = Math.max(1, Math.min(179, finite(verticalFovDeg, 60))) * DEG_TO_RAD;
    const safeAspect = Math.max(0.1, finite(aspect, 1));
    return 2 * Math.atan(Math.tan(vertical / 2) * safeAspect) / DEG_TO_RAD;
}

export function resolveCameraViewHeadingDeg({
    baseHeadingDeg = 0,
    lookYawRad = 0,
    cameraMode = 'cab',
    walkMode = false,
} = {}) {
    const base = finite(baseHeadingDeg);
    if (cameraMode === 'third') return normalizeHeadingDeg(base);
    const rearOffsetDeg = !walkMode && cameraMode === 'rear' ? 180 : 0;
    return normalizeHeadingDeg(base + rearOffsetDeg + finite(lookYawRad) / DEG_TO_RAD);
}

export function tileLocalBounds(tx, tz, tileM) {
    const size = Math.max(1, finite(tileM, 1));
    const tileX = finite(tx);
    const tileZ = finite(tz);
    return {
        minX: tileX * size,
        maxX: (tileX + 1) * size,
        minZ: tileZ * size,
        maxZ: (tileZ + 1) * size,
    };
}

export function featureLocalBounds(feature, anchorLat, anchorLon) {
    const coordinates = feature?.geometry?.coordinates;
    if (!Array.isArray(coordinates)) return null;
    const latitude = finite(anchorLat);
    const longitude = finite(anchorLon);
    const scaleLon = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(latitude * DEG_TO_RAD);
    const scaleLat = DEG_TO_RAD * EARTH_RADIUS_M;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;

    function visit(value) {
        if (!Array.isArray(value)) return;
        if (value.length >= 2
            && Number.isFinite(Number(value[0]))
            && Number.isFinite(Number(value[1]))) {
            const x = (Number(value[0]) - longitude) * scaleLon;
            const z = -(Number(value[1]) - latitude) * scaleLat;
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minZ = Math.min(minZ, z);
            maxZ = Math.max(maxZ, z);
            return;
        }
        for (const child of value) visit(child);
    }

    visit(coordinates);
    return Number.isFinite(minX) ? { minX, maxX, minZ, maxZ } : null;
}

export function distanceSqToBounds(bounds, observerX, observerZ) {
    if (!validBounds(bounds)) return Infinity;
    const x = finite(observerX);
    const z = finite(observerZ);
    const minX = Number(bounds.minX);
    const maxX = Number(bounds.maxX);
    const minZ = Number(bounds.minZ);
    const maxZ = Number(bounds.maxZ);
    const dx = x < minX ? minX - x : x > maxX ? x - maxX : 0;
    const dz = z < minZ ? minZ - z : z > maxZ ? z - maxZ : 0;
    return dx * dx + dz * dz;
}

export function classifyViewPriority(bounds, {
    observerX = 0,
    observerZ = 0,
    headingDeg,
    fovDeg = 90,
} = {}) {
    const distanceSq = distanceSqToBounds(bounds, observerX, observerZ);
    if (!Number.isFinite(distanceSq)) {
        return {
            tier: 'unknown',
            tierRank: VIEW_PRIORITY_TIERS.unknown,
            distanceSq,
            angleDeltaDeg: 180,
            angularRadiusDeg: 0,
            score: -Number.MAX_SAFE_INTEGER,
        };
    }

    const heading = normalizeHeadingDeg(headingDeg);
    if (!Number.isFinite(heading)) {
        return {
            tier: 'unknown',
            tierRank: VIEW_PRIORITY_TIERS.unknown,
            distanceSq,
            angleDeltaDeg: 180,
            angularRadiusDeg: 0,
            score: -distanceSq,
        };
    }

    const x = finite(observerX);
    const z = finite(observerZ);
    const centerX = (Number(bounds.minX) + Number(bounds.maxX)) / 2;
    const centerZ = (Number(bounds.minZ) + Number(bounds.maxZ)) / 2;
    const dx = centerX - x;
    const dz = centerZ - z;
    const centerDistance = Math.hypot(dx, dz);
    const radius = Math.hypot(
        (Number(bounds.maxX) - Number(bounds.minX)) / 2,
        (Number(bounds.maxZ) - Number(bounds.minZ)) / 2,
    );
    const bearingDeg = normalizeHeadingDeg(Math.atan2(dx, -dz) / DEG_TO_RAD);
    const angleDeltaDeg = centerDistance > 1e-6
        ? Math.abs(signedHeadingDeltaDeg(bearingDeg, heading))
        : 0;
    const angularRadiusDeg = centerDistance > 1e-6
        ? Math.asin(Math.min(1, radius / centerDistance)) / DEG_TO_RAD
        : 180;
    const halfFovDeg = Math.max(5, Math.min(170, finite(fovDeg, 90))) / 2;
    const nearestAngleDeg = Math.max(0, angleDeltaDeg - angularRadiusDeg);

    let tier = 'hidden';
    if (distanceSq === 0) tier = 'support';
    else if (nearestAngleDeg <= halfFovDeg + VISIBLE_MARGIN_DEG) tier = 'visible';
    else if (nearestAngleDeg <= halfFovDeg + PERIPHERAL_MARGIN_DEG) tier = 'peripheral';

    const tierRank = VIEW_PRIORITY_TIERS[tier];
    const distanceScore = DISTANCE_WEIGHT / (1 + Math.sqrt(distanceSq));
    const centerScore = Math.max(0, 180 - angleDeltaDeg) * CENTER_WEIGHT;
    const prominenceScore = Math.min(180, angularRadiusDeg) * PROMINENCE_WEIGHT;
    const score = tierRank * TIER_STRIDE
        + distanceScore
        + centerScore
        + prominenceScore;
    return {
        tier,
        tierRank,
        distanceSq,
        angleDeltaDeg,
        angularRadiusDeg,
        score,
    };
}

export function viewPriorityScore(bounds, view) {
    return classifyViewPriority(bounds, view).score;
}
