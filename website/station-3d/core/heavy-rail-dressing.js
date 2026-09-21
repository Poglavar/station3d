// Pure placement plan for heavy-rail sleepers. Rendering stays in world/rails;
// this module owns the regular chainage, track offsets and dimensions so the
// visual contract can be tested without WebGL or a browser.

import { getRailVisualProfile } from '../world/tram-trackbed-dimensions.js';

export const HEAVY_RAIL_SLEEPER_SPACING_M = 0.65;
export const HEAVY_RAIL_SLEEPER_LENGTH_M = 2.6;
export const HEAVY_RAIL_SLEEPER_WIDTH_M = 0.24;
export const HEAVY_RAIL_SLEEPER_HEIGHT_M = 0.11;
export const HEAVY_RAIL_SLEEPER_CENTER_ABOVE_DATUM_M = 0.105;
// Four ties per repeat gives the mip chain enough longitudinal samples to
// retain their rhythm well beyond the distance where 24 cm box geometry has
// become sub-pixel. The texture is phase-aligned with the physical placements
// below: both put the first sleeper at spacing / 2.
export const HEAVY_RAIL_DISTANT_SLEEPER_REPEAT_COUNT = 4;
export const HEAVY_RAIL_DISTANT_SLEEPER_TILE_LENGTH_M =
    HEAVY_RAIL_SLEEPER_SPACING_M * HEAVY_RAIL_DISTANT_SLEEPER_REPEAT_COUNT;
export const HEAVY_RAIL_DISTANT_SLEEPER_TILE_WIDTH_M = 3;

const EPSILON_M = 1e-6;

function finite(value, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

function positiveModulo(value, divisor) {
    return ((value % divisor) + divisor) % divisor;
}

function smoothstep01(value) {
    const t = Math.max(0, Math.min(1, Number(value) || 0));
    return t * t * (3 - 2 * t);
}

// Mask for the far-field sleeper image baked into the ballast texture. Inputs
// are normalized texture coordinates, so this remains testable without a DOM
// canvas or WebGL. Across-track wrapping is centred on zero because bed UV V
// is signed distance from the track centre.
export function heavyRailDistantSleeperMask(normalizedAlong, normalizedAcross, {
    featherM = 0.035,
} = {}) {
    const alongM = positiveModulo(
        finite(normalizedAlong) * HEAVY_RAIL_DISTANT_SLEEPER_TILE_LENGTH_M,
        HEAVY_RAIL_SLEEPER_SPACING_M,
    );
    const distanceAlongM = Math.abs(alongM - HEAVY_RAIL_SLEEPER_SPACING_M * 0.5);
    const halfWidthM = HEAVY_RAIL_SLEEPER_WIDTH_M * 0.5;
    const feather = Math.max(0.005, finite(featherM, 0.035));
    const alongMask = 1 - smoothstep01(
        (distanceAlongM - Math.max(0, halfWidthM - feather)) / (feather * 2),
    );

    const acrossCycle = positiveModulo(finite(normalizedAcross), 1);
    const distanceAcrossM = Math.min(acrossCycle, 1 - acrossCycle)
        * HEAVY_RAIL_DISTANT_SLEEPER_TILE_WIDTH_M;
    const halfLengthM = HEAVY_RAIL_SLEEPER_LENGTH_M * 0.5;
    const acrossMask = 1 - smoothstep01(
        (distanceAcrossM - Math.max(0, halfLengthM - feather)) / (feather * 2),
    );
    return Math.max(0, Math.min(1, alongMask * acrossMask));
}

export function isHeavyRailSegment(segment) {
    if (typeof segment?.heavyRail === 'boolean') return segment.heavyRail;
    return getRailVisualProfile(segment?.properties || segment?.feature?.properties || {}).kind
        === 'heavy-rail';
}

export function planHeavyRailSleepers(segments, {
    spacingM = HEAVY_RAIL_SLEEPER_SPACING_M,
} = {}) {
    const spacing = Math.max(0.2, finite(spacingM, HEAVY_RAIL_SLEEPER_SPACING_M));
    const phaseM = spacing * 0.5;
    const placements = [];
    for (const segment of segments || []) {
        if (!segment || !isHeavyRailSegment(segment)) continue;
        const lengthM = finite(segment.len, Math.hypot(
            finite(segment.x2) - finite(segment.x1),
            finite(segment.z2) - finite(segment.z1),
        ));
        if (!(lengthM > EPSILON_M)) continue;
        const uStartM = finite(segment.uStart);
        const uEndM = uStartM + lengthM;
        let sleeperIndex = Math.ceil((uStartM - phaseM - EPSILON_M) / spacing);
        let chainageM = phaseM + sleeperIndex * spacing;
        if (chainageM < uStartM - EPSILON_M) {
            sleeperIndex += 1;
            chainageM += spacing;
        }
        const startOffsets = Array.isArray(segment.startTrackCenterOffsetsM)
            ? segment.startTrackCenterOffsetsM
            : [0];
        const endOffsets = Array.isArray(segment.endTrackCenterOffsetsM)
            ? segment.endTrackCenterOffsetsM
            : startOffsets;
        const trackCount = Math.min(startOffsets.length, endOffsets.length);
        while (chainageM < uEndM - EPSILON_M) {
            const t = Math.max(0, Math.min(1, (chainageM - uStartM) / lengthM));
            const centerX = finite(segment.x1)
                + (finite(segment.x2) - finite(segment.x1)) * t;
            const centerZ = finite(segment.z1)
                + (finite(segment.z2) - finite(segment.z1)) * t;
            const centerY = finite(segment.yStart)
                + (finite(segment.yEnd) - finite(segment.yStart)) * t
                + HEAVY_RAIL_SLEEPER_CENTER_ABOVE_DATUM_M;
            const normalX = finite(segment.px, (
                finite(segment.z2) - finite(segment.z1)
            ) / lengthM);
            const normalZ = finite(segment.pz, -(
                finite(segment.x2) - finite(segment.x1)
            ) / lengthM);
            for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
                const offsetM = finite(startOffsets[trackIndex])
                    + (finite(endOffsets[trackIndex]) - finite(startOffsets[trackIndex])) * t;
                placements.push({
                    x: centerX + normalX * offsetM,
                    y: centerY,
                    z: centerZ + normalZ * offsetM,
                    angleY: finite(segment.angle, Math.atan2(
                        finite(segment.x2) - finite(segment.x1),
                        finite(segment.z2) - finite(segment.z1),
                    )),
                    chainageM,
                    trackIndex,
                    lengthM: HEAVY_RAIL_SLEEPER_LENGTH_M,
                    widthM: HEAVY_RAIL_SLEEPER_WIDTH_M,
                    heightM: HEAVY_RAIL_SLEEPER_HEIGHT_M,
                });
            }
            sleeperIndex += 1;
            chainageM = phaseM + sleeperIndex * spacing;
        }
    }
    return placements;
}
