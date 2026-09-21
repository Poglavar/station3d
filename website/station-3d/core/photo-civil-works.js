import { finiteOrNull } from './math.js';
// Classifies fixed photo-mode track chunks against sampled Google terrain,
// reusing the model world's viaduct/tunnel run policy without moving the track.

import {
    classifyTunnelSegments,
    classifyViaductSegments,
    smoothedSegmentExtremes,
    DEFAULT_TUNNEL_COVER_THRESHOLD_M,
    RECONSTRUCTION_STRUCTURE_MIN_RUN_M,
    RECONSTRUCTION_TERRAIN_SMOOTHING_M,
    TUNNEL_COVER_TOLERANCE_M,
} from './rail-formation.js';

// Public photo-world name retained for callers; its value now comes from the
// single shared tunnel-cover rule exposed through rail-formation.js.
export const PHOTO_DESIGN_TUNNEL_MIN_COVER_M = DEFAULT_TUNNEL_COVER_THRESHOLD_M;

// Google photogrammetry is a DSM: a downward ray often lands on a roof or tree
// crown rather than bare earth. Select a low robust neighbourhood sample, with
// the DGU ground implied by the authored profile as an outlier prior. The prior
// never replaces visible Google evidence: a sustained datum/terrain difference
// is exactly what photo-mode civil classification must adapt to.
export function selectPhotoBareEarthHeight(samples, {
    expectedGroundY = null,
    maxAboveExpectedM = 4,
    maxBelowExpectedM = 12,
    quantile = 0.25,
} = {}) {
    const finite = (samples || [])
        .filter(value => value != null)
        .map(Number)
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
    const expected = Number(expectedGroundY);
    const hasExpected = expectedGroundY !== null
        && expectedGroundY !== undefined
        && expectedGroundY !== ''
        && Number.isFinite(expected);
    // No photogrammetry evidence is still unknown. Falling back to DGU here
    // would fabricate civil works before the corresponding Google tile exists.
    if (finite.length === 0) return null;

    const plausible = hasExpected
        ? finite.filter(value => (
            value >= expected - Math.max(0, Number(maxBelowExpectedM) || 0)
            && value <= expected + Math.max(0, Number(maxAboveExpectedM) || 0)
        ))
        : finite;
    const candidates = plausible.length > 0 ? plausible : finite;
    const q = Math.max(0, Math.min(1, Number(quantile) || 0));
    return candidates[Math.floor((candidates.length - 1) * q)];
}

function finiteTerrainValues(chunk) {
    return [chunk?.groundL, chunk?.groundR, chunk?.groundC]
        .filter(value => value != null)
        .map(Number)
        .filter(Number.isFinite);
}

// Retaining-wall crowns follow robust bare earth, never the highest visible
// Google hit. A tree, roof or coarse photogrammetry skirt must not turn one
// 12 m wall panel into a freestanding tower. The median also requires a high
// reading to persist into a neighbouring panel before it changes the civil
// envelope; the corridor mask and wall overlap own the source-mesh seam.
export function photoRetainingWallTop(samples, {
    trackY = 0,
    parapetM = 1,
    maxHeightM = 60,
} = {}) {
    const finite = (samples || [])
        .filter(value => value !== null && value !== undefined && value !== '')
        .map(Number)
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
    if (finite.length === 0) return null;
    const base = Number(trackY);
    const cap = Number.isFinite(base)
        ? base + Math.max(0, Number(maxHeightM) || 0)
        : Infinity;
    // Use the lower median for an even-sized route-end window: with only the
    // current and one neighbour, one high DSM outlier must not win merely
    // because it sorts second. A real rise still wins once it persists.
    const middle = finite[Math.floor((finite.length - 1) * 0.5)];
    return Math.min(
        middle + Math.max(0, Number(parapetM) || 0),
        cap,
    );
}

// A crown sized from robust bare earth deliberately ignores canopy and DSM
// noise — but any visible source that survives ABOVE the crown next to a
// source-removal boundary re-appears as torn crust no masonry hides (the
// portal "tongue" / wall-top slivers). Where burying matters (portal facades,
// tunnel-approach walls) the crown may rise toward the RAW local surface,
// bounded by an allowance above the robust estimate so an isolated roof or
// LOD spike still cannot mint a tower. Surface evidence alone (no robust
// base) never builds masonry.
export function buryDsmSurfaceCrown(robustTopY, surfaceTopY, {
    hideM = 1,
    allowanceM = 15,
} = {}) {
    const robust = Number(robustTopY);
    if (robustTopY === null || robustTopY === undefined || robustTopY === ''
        || !Number.isFinite(robust)) return null;
    const surface = Number(surfaceTopY);
    if (surfaceTopY === null || surfaceTopY === undefined || surfaceTopY === ''
        || !Number.isFinite(surface)) return robust;
    return Math.max(robust, Math.min(
        surface + Math.max(0, Number(hideM) || 0),
        robust + Math.max(0, Number(allowanceM) || 0),
    ));
}

// Portal variant: a fixed allowance over robust ground SATURATES on genuinely
// steep hillsides (the surface over the collar corners can legitimately stand
// 15+ m above the robust face crown), and the crust band between the
// saturated crown and the true surface re-appears as the torn tongue — one
// allowance higher. The correct spike-vs-slope discriminator is CONSENSUS
// among the dense sample fan, not an absolute allowance: a real slope has
// many high samples agreeing, an isolated roof/LOD blob has one. Take the
// second-highest sample (spike-immune with ≥2 honest rays) plus the hide
// margin, bounded only by the shared rail-relative civil safety clamp.
export function buryDsmSurfaceCrownFromSamples(robustTopY, samples, {
    hideM = 2,
    trackY = 0,
    maxHeightM = 60,
} = {}) {
    const robust = Number(robustTopY);
    if (robustTopY === null || robustTopY === undefined || robustTopY === ''
        || !Number.isFinite(robust)) return null;
    const finiteSamples = (samples || [])
        .filter(value => value !== null && value !== undefined && value !== '')
        .map(Number)
        .filter(Number.isFinite)
        .sort((a, b) => b - a);
    const base = Number(trackY);
    const cap = Number.isFinite(base)
        ? base + Math.max(0, Number(maxHeightM) || 0)
        : Infinity;
    // One sample cannot form a consensus — treat it as a potential spike and
    // keep the robust crown rather than chase (or pad) it.
    if (finiteSamples.length < 2) return Math.min(robust, cap);
    const consensusTop = finiteSamples[1];
    return Math.min(
        Math.max(robust, consensusTop + Math.max(0, Number(hideM) || 0)),
        cap,
    );
}

function hasCompleteSection(chunk) {
    return chunk?.ty != null
        && finiteOrNull(chunk.ty) !== null
        && finiteTerrainValues(chunk).length === 3;
}

function contiguousGroups(chunks) {
    const groups = [];
    let group = [];
    for (const chunk of chunks || []) {
        const previous = group[group.length - 1];
        if (previous) {
            const distanceM = Math.hypot(
                Number(chunk?.mx) - Number(previous?.mx),
                Number(chunk?.mz) - Number(previous?.mz),
            );
            const localSpanM = Math.max(
                1,
                Number(chunk?.spanLen) || 0,
                Number(previous?.spanLen) || 0,
            );
            // Window filtering can make two unrelated route legs neighbours in
            // the array. Never bridge a structure classification across that gap.
            if (!hasCompleteSection(previous)
                || !hasCompleteSection(chunk)
                || previous.routeRunId !== chunk?.routeRunId
                || !Number.isFinite(distanceM)
                || distanceM > localSpanM * 3) {
                groups.push(group);
                group = [];
            }
        }
        group.push(chunk);
    }
    if (group.length) groups.push(group);
    return groups;
}

export function classifyPhotoCivilWorks(chunks, {
    tunnelEnabled = true,
    wasTunnelAt = null,
    tunnelHysteresisM = 3,
    // A reconstruction of an existing line gets the same treatment as in the
    // model world (see RECONSTRUCTION_TERRAIN_SMOOTHING_M in rail-formation.js):
    // its solved rail over a resampled 20 m grid otherwise chatters across the
    // thresholds. The two worlds must classify the same route identically, so
    // this flag has to travel with it rather than being decided per world.
    reconstruction = false,
} = {}) {
    const result = new Array((chunks || []).length).fill('formation');
    let offset = 0;
    for (const group of contiguousGroups(chunks)) {
        const segments = group.map((chunk) => {
            const trackY = Number(chunk?.ty);
            const terrain = finiteTerrainValues(chunk);
            const completeSection = hasCompleteSection(chunk);
            const hysteresis = completeSection
                && typeof wasTunnelAt === 'function'
                && wasTunnelAt(Number(chunk.mx), Number(chunk.mz))
                ? Math.max(0, Number(tunnelHysteresisM) || 0)
                : 0;
            // Authored design depth below DGU bare earth (cut-and-cover
            // candidate) — independent of what Google's DSM shows on top.
            const dguGroundY = finiteOrNull(chunk?.dguGroundY);
            const designCoverM = dguGroundY !== null && Number.isFinite(trackY)
                ? dguGroundY - trackY
                : -Infinity;
            let maxCoverM = completeSection
                // A bore needs cover at centre and both flanks; the shallowest
                // of the three controls, matching RailFormationModel.
                ? Math.max(0, Math.min(...terrain) - trackY + hysteresis)
                : -Infinity;
            // Deliberately NOT gated on completeSection: the authored design
            // is the truth, and Google tiles may be unstreamed or void where
            // the route runs. Gating this on streamed samples left whole
            // cut-and-cover spans dressed as bare formation (a lid-less
            // causeway) until tiles happened to arrive.
            if (designCoverM >= PHOTO_DESIGN_TUNNEL_MIN_COVER_M - TUNNEL_COVER_TOLERANCE_M) {
                maxCoverM = Math.max(maxCoverM, DEFAULT_TUNNEL_COVER_THRESHOLD_M);
            }
            return {
                length: Math.max(0, Number(chunk?.spanLen) || 0),
                maxFillM: completeSection
                    ? Math.max(0, ...terrain.map(groundY => trackY - groundY))
                    : -Infinity,
                maxCoverM,
            };
        });
        const classifySegments = reconstruction
            ? smoothedSegmentExtremes(segments, RECONSTRUCTION_TERRAIN_SMOOTHING_M)
            : segments;
        const minRunOptions = reconstruction
            ? { minRunM: RECONSTRUCTION_STRUCTURE_MIN_RUN_M }
            : {};
        const viaduct = classifyViaductSegments(classifySegments, minRunOptions);
        const tunnel = tunnelEnabled
            ? classifyTunnelSegments(classifySegments, minRunOptions)
            : new Array(segments.length).fill(false);
        for (let index = 0; index < group.length; index++) {
            result[offset + index] = viaduct[index]
                ? 'viaduct'
                : tunnel[index]
                    ? 'tunnel'
                    : 'formation';
        }
        offset += group.length;
    }
    return result;
}

// Vertical component of a dressing box's along-track basis vector so its top
// face follows the chunk's grade instead of stepping flat at each chunk. The
// grade is the chunk's rise/run (startY→endY over chunkSpanLenM); scaled to the
// box's own along-track length (boxSpanLenM, which the overlap slightly extends)
// it gives the rise the tilted _wx must carry. Zero on flat/degenerate chunks so
// level dressing stays axis-aligned (and remains a walk collider). Pure so the
// staircase→ramp continuity is unit-testable without a browser.
export function slabSpanRiseM(startY, endY, chunkSpanLenM, boxSpanLenM) {
    const span = Number(chunkSpanLenM);
    if (!(span > 1e-3)) return 0;
    const rise = Number(endY) - Number(startY);
    if (!Number.isFinite(rise)) return 0;
    const boxSpan = finiteOrNull(boxSpanLenM) ?? span;
    return rise * (boxSpan / span);
}
