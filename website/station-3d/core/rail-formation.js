// Pure engineered-rail vertical alignment and cut/fill footprint geometry.
// Proposal tracks get a smooth, grade-limited centreline while their level
// cross-section meets untouched terrain through the shared retaining seam.

import { DEG_TO_RAD, EARTH_RADIUS_M, finiteOrNull } from './math.js';
import { ownReadSnapshot, retainReadSnapshot } from './read-snapshot-lifetime.js';
export { finiteOrNull };
import {
    RAIL_TUBE_HEIGHT_ABOVE_RAIL_M,
    TUNNEL_COVER_TOLERANCE_M,
    TUNNEL_FULL_COVER_MIN_M,
    TUNNEL_ROOF_SLAB_COVER_M,
} from './tunnel-cover-rule.js';
import {
    FORMATION_MAX_CUTOUT_REACH_M,
    buildFormationSurfaceProfileSteps,
    formationDressingSurfaceYAtLocal,
} from './road-formation.js';
import {
    buildFormationExcavationRegions,
    TERRAIN_EXCAVATION_MIN_DEPTH_M,
} from './formation-excavation.js';
import {
    flagRailFormationBoundarySegmentsForRoadOpenings,
    flagRailFormationBoundarySegmentsForRoadOpeningsSteps,
} from './rail-road-grade-separation.js';

const DEFAULT_SAMPLE_STEP_M = 20;
// Whole-network dressing reconciliation is deterministic but can be expensive:
// Zagreb's streamed rail set has enough neighbouring profile edges for the
// overlap pass alone to take tens of milliseconds. Deferred builds keep the
// previous complete model published and expose bounded slices of this pass.
const WHOLE_SET_SLICE_MS = 4;
// Check elapsed time after each operation and also cap fast slices. The item
// cap makes a long feature cooperative even on a coarse/very fast clock.
const PREPARATION_SLICE_MAX_ITEMS = 4096;
const PREPARATION_SLICE_MAX_TERRAIN_SAMPLES = 64;

function railBuildNow() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function createRailPreparationSlice(maxItems = PREPARATION_SLICE_MAX_ITEMS) {
    let startedAt = railBuildNow();
    let items = 0;
    return {
        expired() {
            items += 1;
            return items >= maxItems
                || railBuildNow() - startedAt >= WHOLE_SET_SLICE_MS;
        },
        restart() {
            items = 0;
            startedAt = railBuildNow();
        },
    };
}

function finishRailSteps(iterator) {
    let outcome = iterator.next();
    while (!outcome.done) outcome = iterator.next();
    return outcome.value;
}

function* mapRailPreparationSteps(values, project, phase, maxItems) {
    const output = [];
    const slice = createRailPreparationSlice(maxItems);
    for (let index = 0; index < values.length; index++) {
        output.push(project(values[index], index));
        if (slice.expired()) {
            yield { phase };
            slice.restart();
        }
    }
    return output;
}
// Baseline for the reported/gazed grade. 40 m spans two densified steps, so
// centimetre-quantised elevations contribute a quarter of a per mille instead of
// the couple of per mille an 8 m source segment produced.
const GRADE_CHORD_M = 40;
const DEFAULT_DENOISE_RADIUS_M = 60;
const DEFAULT_SMOOTHING_RADIUS_M = 350;
const DEFAULT_MAX_GRADE = 0.025;
export const OSM_CUT_AVOIDANCE_RATIO = 0.35;
export const TRAIN_MAX_GRADE = 0.025;
export const TRAM_MAX_GRADE = 0.06;
export const DEFAULT_VIADUCT_FILL_THRESHOLD_M = 3.5;
const DEFAULT_VIADUCT_MIN_RUN_M = 30;
const DEFAULT_VIADUCT_GAP_BRIDGE_M = 40;
// Planner (authored-absolute) tracks ride high decks over real relief, where a
// knoll can rise to within the fill threshold for ~100 m mid-span. Classified
// at the 40 m default that dip becomes a stranded embankment stub between two
// tall viaducts — retaining-wall tips poking through the hillside with the
// terrain carved black around them. A real viaduct simply continues across
// such a knoll, so these features bridge much longer gaps.
export const PLANNER_VIADUCT_GAP_BRIDGE_M = 160;
// Tunnels are the mirror of viaducts: where the ground covers the rail by the
// shared 8 m rule across the full formation width, an open cut reads wrong and
// the route bores instead. The physical components and tolerance live in the
// hybrid root tunnel-cover-rule.js so the classic planner and ESM worlds read
// the same values rather than test-pinning copies.
export {
    RAIL_TUBE_HEIGHT_ABOVE_RAIL_M,
    TUNNEL_COVER_TOLERANCE_M,
    TUNNEL_FULL_COVER_MIN_M,
    TUNNEL_ROOF_SLAB_COVER_M,
};
// Actual model-world tunnel geometry uses a shallower, declared clear box than
// the conservative 7.3 m planning/classification envelope above. Keep its two
// render datums here so clearance resolution, the renderer, building supports,
// and diagnostics all measure the same physical ceiling.
export const RENDERED_TUNNEL_BED_ABOVE_RAIL_M = 0.06;
export const DEFAULT_RENDERED_TUNNEL_CLEAR_HEIGHT_M = 6.2;
export const DEFAULT_TUNNEL_COVER_THRESHOLD_M = TUNNEL_FULL_COVER_MIN_M;
const DEFAULT_TUNNEL_MIN_RUN_M = 40;
const DEFAULT_TUNNEL_GAP_BRIDGE_M = 40;
// A RECONSTRUCTION of an existing railway is a special case for classification.
// Its rail is a solved, grade-capped alignment — smooth by construction — while
// the ground under it is a 20 m DGU grid sampled every half metre, so the
// difference between them ripples across the ±3.5 m / −8 m rules many times per
// kilometre. Gračac–Knin came out as 31 tunnels and 72 viaducts in 59 km, most
// of them pinned to the 30/40 m minimum: a cab ride popping between bore, deck
// and open ground every few hundred metres.
//
// Two corrections, applied ONLY to reconstructions (see
// isReconstructedRailFeature) so tram lines and user-authored alignments — which
// the planner already limits to 50 m spans — keep classifying exactly as before:
//   * cover and fill are low-passed over the DGU grid's own resolution before
//     they are compared to a threshold. Reading a 20 m grid at 0.5 m spacing
//     does not produce 40 independent measurements.
//   * a structure has to earn its portals over a longer run.
// The THRESHOLDS themselves (8 m cover, 3.5 m fill) are untouched — all three
// worlds still agree on the rule; this only changes what is fed to it.
export const RECONSTRUCTION_TERRAIN_SMOOTHING_M = 20;
export const RECONSTRUCTION_STRUCTURE_MIN_RUN_M = 150;
// The open approach widens over this distance until its walls meet the bore at
// the mapped portal. Earlier this distance was carved INSIDE the tunnel and the
// visible portal was consequently shifted 24 m away from its OSM/solved
// endpoint. It is an approach taper, not permission to move the tunnel.
export const TUNNEL_PORTAL_APPROACH_TAPER_M = 24;
// Compatibility name for callers/tests written before the geometry contract
// was corrected. New code should say what the distance now means.
export const TUNNEL_PORTAL_CARVE_M = TUNNEL_PORTAL_APPROACH_TAPER_M;
// The terrain cut belonging to an open approach cannot stop on the same
// mathematical plane as the portal. The DGU mask is sampled at roughly metre
// scale, so that exact hand-off leaves one filtered texel (and sometimes a
// coarse DTM triangle) hanging through the bore mouth. Keep this aperture
// deliberately short: it overlaps the open cut and only the first metre and a
// half of the bored run, preserving the intact terrain roof immediately behind
// the headwall.
export const TUNNEL_PORTAL_TERRAIN_OPENING_OUTSIDE_M = 2.5;
export const TUNNEL_PORTAL_TERRAIN_OPENING_INSIDE_M = 1.5;
export const TUNNEL_PORTAL_TERRAIN_OPENING_MARGIN_M = 0.6;
// The terrain aperture is deliberately wider/deeper than the visible bore so
// coarse DTM triangles cannot hang into it. Cover that removed INSIDE throat
// with a small civil roof cap which buries beneath the kept terrain at every
// edge. It never extends onto the open approach side of the portal plane.
export const TUNNEL_PORTAL_ROOF_CAP_BURY_M = 0.35;
export const TUNNEL_PORTAL_ROOF_CAP_LATERAL_OVERLAP_M = 0.25;
// Bored-tunnel tube half-width. This is the SINGLE SOURCE OF TRUTH shared with
// the renderer (rails.js tunnelBoreHalfWidth delegates to railBoreHalfWidthM),
// so the open cut can flare its retaining walls out to exactly this half-width
// at the bore mouth and meet the stone tunnel wall flush, with no side gap.
const TUNNEL_BORE_MIN_HALF_WIDTH_M = 5.0;
const TUNNEL_BORE_WIDTH_MARGIN_M = 3.5;
export function railBoreHalfWidthM(railHalfWidthM) {
    return Math.max(
        TUNNEL_BORE_MIN_HALF_WIDTH_M,
        Number(railHalfWidthM || 0) + TUNNEL_BORE_WIDTH_MARGIN_M,
    );
}

function declaredRailTunnelSections(feature) {
    return (Array.isArray(feature?.properties?.railTunnelSections)
        ? feature.properties.railTunnelSections : [])
        .map((section) => {
            const sourceStartM = finiteOrNull(section?.sourceStartM ?? section?.startM);
            const sourceEndM = finiteOrNull(section?.sourceEndM ?? section?.endM);
            return sourceStartM !== null && sourceEndM !== null && sourceEndM > sourceStartM
                ? { ...section, sourceStartM, sourceEndM }
                : null;
        })
        .filter(Boolean);
}

function railFormationSectionForSourceRange(feature, sourceStartM, sourceEndM) {
    const startM = finiteOrNull(sourceStartM);
    const endM = finiteOrNull(sourceEndM);
    if (startM === null || endM === null) return null;
    const queryStartM = Math.min(startM, endM);
    const queryEndM = Math.max(startM, endM);
    const queryIsPoint = queryEndM - queryStartM <= 1e-6;
    return (Array.isArray(feature?.properties?.railFormationSections)
        ? feature.properties.railFormationSections : [])
        .map(section => {
            const sectionStartM = finiteOrNull(section?.sourceStartM ?? section?.startM);
            const sectionEndM = finiteOrNull(section?.sourceEndM ?? section?.endM);
            if (sectionStartM === null || sectionEndM === null) return null;
            return {
                ...section,
                style: String(section?.style || '').trim(),
                containsPoint: queryIsPoint
                    && queryStartM >= Math.min(sectionStartM, sectionEndM) - 1e-3
                    && queryStartM <= Math.max(sectionStartM, sectionEndM) + 1e-3,
                overlapM: Math.max(0,
                    Math.min(queryEndM, Math.max(sectionStartM, sectionEndM))
                    - Math.max(queryStartM, Math.min(sectionStartM, sectionEndM))),
            };
        })
        .filter(section => section?.style && (section.overlapM > 1e-3 || section.containsPoint))
        .sort((left, right) => (
            Number(right.containsPoint) - Number(left.containsPoint)
            || right.overlapM - left.overlapM
        ))[0] || null;
}

function retainedBenchForFormationSection(section) {
    return {
        negativeNormalM: Math.max(
            0,
            finiteOrNull(section?.negativeNormalRetainedBenchM) || 0,
        ),
        positiveNormalM: Math.max(
            0,
            finiteOrNull(section?.positiveNormalRetainedBenchM) || 0,
        ),
    };
}

// Resolve a physical tunnel section independently of the driveable track
// count. A solved reconstruction can carry one centreline while an OSM
// companion proves that one particular civil run is a shared two-track bore.
// The source-chainage range prevents that section leaking onto other tunnels
// carried by the same long solved feature.
export function railTunnelSectionForFeature(
    feature,
    railHalfWidthM,
    sourceStartM = null,
    sourceEndM = null,
) {
    const startM = finiteOrNull(sourceStartM);
    const endM = finiteOrNull(sourceEndM);
    const queryStartM = startM === null ? null : Math.min(startM, endM ?? startM);
    const queryEndM = startM === null ? null : Math.max(startM, endM ?? startM);
    const declared = declaredRailTunnelSections(feature)
        .map(section => ({
            ...section,
            overlapM: queryStartM === null
                ? 0
                : Math.max(0,
                    Math.min(section.sourceEndM, queryEndM)
                    - Math.max(section.sourceStartM, queryStartM)),
            containsPoint: queryStartM !== null && queryEndM - queryStartM <= 1e-6
                && queryStartM >= section.sourceStartM - 1e-3
                && queryStartM <= section.sourceEndM + 1e-3,
        }))
        .filter(section => queryStartM === null || section.overlapM > 0 || section.containsPoint)
        .sort((left, right) => right.overlapM - left.overlapM)[0] || null;
    const centerOffsetM = finiteOrNull(declared?.centerOffsetM) ?? 0;
    const authorityHalfWidthM = Math.max(0.5, Number(railHalfWidthM) || 0);
    const declaredHalfWidthM = finiteOrNull(declared?.boreHalfWidthM);
    const halfWidthM = declaredHalfWidthM !== null && declaredHalfWidthM > 0
        ? Math.max(declaredHalfWidthM, Math.abs(centerOffsetM) + authorityHalfWidthM)
        : railBoreHalfWidthM(authorityHalfWidthM);
    const clearHeightM = finiteOrNull(declared?.clearHeightM);
    const portalCrownM = finiteOrNull(declared?.portalCrownM);
    const portalTerrainOpeningInsideM = finiteOrNull(
        declared?.portalTerrainOpeningInsideM,
    );
    return {
        sourceStartM: declared?.sourceStartM ?? null,
        sourceEndM: declared?.sourceEndM ?? null,
        physicalId: declared?.physicalId || null,
        trackCount: Math.max(1, Number(declared?.trackCount) || 1),
        trackSpacingM: finiteOrNull(declared?.trackSpacingM),
        centerOffsetM,
        halfWidthM,
        clearHeightM: clearHeightM !== null && clearHeightM > 0 ? clearHeightM : null,
        portalCrownM: portalCrownM !== null && portalCrownM > 0 ? portalCrownM : null,
        portalTerrainOpeningInsideM: portalTerrainOpeningInsideM !== null
            && portalTerrainOpeningInsideM >= 0
            ? portalTerrainOpeningInsideM : null,
        evidence: declared?.evidence || null,
    };
}

// Several clipped features can report the same physical mouth. Collapse exact
// duplicates everywhere and use a slightly wider tolerance only when both
// records explicitly name the same physical tunnel; genuinely parallel bores
// without shared ownership remain separate.
export function dedupeRailTunnelPortalMouths(mouths, {
    exactToleranceM = 0.25,
    sharedToleranceM = 2,
} = {}) {
    const unique = [];
    for (const mouth of mouths || []) {
        const mouthX = finiteOrNull(mouth?.x);
        const mouthZ = finiteOrNull(mouth?.z);
        if (mouthX === null || mouthZ === null) continue;
        const duplicate = unique.some((kept) => {
            const keptX = finiteOrNull(kept?.x);
            const keptZ = finiteOrNull(kept?.z);
            if (keptX === null || keptZ === null) return false;
            const sharedId = mouth.physicalId && kept.physicalId
                && String(mouth.physicalId) === String(kept.physicalId);
            const toleranceM = sharedId ? sharedToleranceM : exactToleranceM;
            return Math.hypot(mouthX - keptX, mouthZ - keptZ)
                <= toleranceM;
        });
        if (!duplicate) unique.push(mouth);
    }
    return unique;
}

export function buildTunnelPortalTerrainOpening({
    mouth,
    interior,
    boreHalfWidthM,
    outsideM = TUNNEL_PORTAL_TERRAIN_OPENING_OUTSIDE_M,
    insideM = TUNNEL_PORTAL_TERRAIN_OPENING_INSIDE_M,
    lateralMarginM = TUNNEL_PORTAL_TERRAIN_OPENING_MARGIN_M,
    physicalId = null,
    side = null,
} = {}) {
    const mouthX = finiteOrNull(mouth?.x);
    const mouthZ = finiteOrNull(mouth?.z);
    const interiorX = finiteOrNull(interior?.x);
    const interiorZ = finiteOrNull(interior?.z);
    const halfWidth = finiteOrNull(boreHalfWidthM);
    if (mouthX === null || mouthZ === null || interiorX === null || interiorZ === null
        || halfWidth === null || halfWidth <= 0) return null;
    const dx = interiorX - mouthX;
    const dz = interiorZ - mouthZ;
    const length = Math.hypot(dx, dz);
    if (length < 1e-6) return null;
    const alongX = dx / length;
    const alongZ = dz / length;
    const normalX = alongZ;
    const normalZ = -alongX;
    const outerReach = Math.max(0, Number(outsideM) || 0);
    const innerReach = Math.max(0, Number(insideM) || 0);
    const openingHalfWidth = halfWidth + Math.max(0, Number(lateralMarginM) || 0);
    const outside = {
        x: mouthX - alongX * outerReach,
        z: mouthZ - alongZ * outerReach,
    };
    const inside = {
        x: mouthX + alongX * innerReach,
        z: mouthZ + alongZ * innerReach,
    };
    const ring = [
        {
            x: outside.x - normalX * openingHalfWidth,
            z: outside.z - normalZ * openingHalfWidth,
        },
        {
            x: inside.x - normalX * openingHalfWidth,
            z: inside.z - normalZ * openingHalfWidth,
        },
        {
            x: inside.x + normalX * openingHalfWidth,
            z: inside.z + normalZ * openingHalfWidth,
        },
        {
            x: outside.x + normalX * openingHalfWidth,
            z: outside.z + normalZ * openingHalfWidth,
        },
    ];
    const bounds = ring.reduce((result, point) => ({
        minX: Math.min(result.minX, point.x),
        minZ: Math.min(result.minZ, point.z),
        maxX: Math.max(result.maxX, point.x),
        maxZ: Math.max(result.maxZ, point.z),
    }), { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity });
    return {
        ring,
        bounds,
        physicalId,
        side,
        // The boundary-opening contract is shared by terrain removal and
        // formation dressing. Keeping the oriented frame here lets every rail
        // profile — including a neighbouring siding — yield to the same
        // physical tunnel aperture instead of reconstructing it from bounds.
        x: mouthX,
        z: mouthZ,
        tangentX: alongX,
        tangentZ: alongZ,
        beforeM: outerReach,
        afterM: innerReach,
        halfWidthM: openingHalfWidth,
        mouth: { x: mouthX, z: mouthZ },
        boreHalfWidthM: halfWidth,
        outsideM: outerReach,
        insideM: innerReach,
    };
}

// A tunnel opening owns a real void across the complete rail context, not just
// across the alignment that classified the bore. Reuse the exact clipped
// boundary-opening machinery used for road underpasses so an offset siding or
// yard track cannot leave a cross-cap or longitudinal wall inside the portal.
export function suppressRailFormationDressingAtTunnelPortals(
    railFormationOrProfiles,
    openings,
) {
    return flagRailFormationBoundarySegmentsForRoadOpenings(
        railFormationOrProfiles,
        openings,
    );
}

export function buildTunnelPortalRoofCapFootprint({
    mouth,
    interior,
    boreHalfWidthM,
    terrainOpeningInsideM = TUNNEL_PORTAL_TERRAIN_OPENING_INSIDE_M,
    lateralMarginM = TUNNEL_PORTAL_TERRAIN_OPENING_MARGIN_M,
    buryM = TUNNEL_PORTAL_ROOF_CAP_BURY_M,
    lateralOverlapM = TUNNEL_PORTAL_ROOF_CAP_LATERAL_OVERLAP_M,
    negativeHalfWidthM = null,
    positiveHalfWidthM = null,
    physicalId = null,
    side = null,
} = {}) {
    const openingInsideM = Math.max(0, Number(terrainOpeningInsideM) || 0);
    const longitudinalBuryM = Math.max(0, Number(buryM) || 0);
    const lateralBuryM = Math.max(0, Number(lateralOverlapM) || 0);
    const footprint = buildTunnelPortalTerrainOpening({
        mouth,
        interior,
        boreHalfWidthM,
        outsideM: 0,
        insideM: openingInsideM + longitudinalBuryM,
        lateralMarginM: Math.max(0, Number(lateralMarginM) || 0) + lateralBuryM,
        physicalId,
        side,
    });
    if (!footprint) return null;
    const dx = Number(interior.x) - Number(mouth.x);
    const dz = Number(interior.z) - Number(mouth.z);
    const length = Math.hypot(dx, dz);
    const alongX = dx / length;
    const alongZ = dz / length;
    const normalX = alongZ;
    const normalZ = -alongX;
    const apertureHalfWidthM = Number(boreHalfWidthM)
        + Math.max(0, Number(lateralMarginM) || 0)
        + lateralBuryM;
    const negativeHalfWidth = Math.max(
        apertureHalfWidthM,
        Math.max(0, Number(negativeHalfWidthM) || 0),
    );
    const positiveHalfWidth = Math.max(
        apertureHalfWidthM,
        Math.max(0, Number(positiveHalfWidthM) || 0),
    );
    const inside = {
        x: Number(mouth.x) + alongX * footprint.insideM,
        z: Number(mouth.z) + alongZ * footprint.insideM,
    };
    const ring = [
        {
            x: Number(mouth.x) - normalX * negativeHalfWidth,
            z: Number(mouth.z) - normalZ * negativeHalfWidth,
        },
        {
            x: inside.x - normalX * negativeHalfWidth,
            z: inside.z - normalZ * negativeHalfWidth,
        },
        {
            x: inside.x + normalX * positiveHalfWidth,
            z: inside.z + normalZ * positiveHalfWidth,
        },
        {
            x: Number(mouth.x) + normalX * positiveHalfWidth,
            z: Number(mouth.z) + normalZ * positiveHalfWidth,
        },
    ];
    const bounds = ring.reduce((result, point) => ({
        minX: Math.min(result.minX, point.x),
        minZ: Math.min(result.minZ, point.z),
        maxX: Math.max(result.maxX, point.x),
        maxZ: Math.max(result.maxZ, point.z),
    }), { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity });
    return {
        ...footprint,
        ring,
        bounds,
        terrainOpeningInsideM: openingInsideM,
        buryM: longitudinalBuryM,
        lateralOverlapM: lateralBuryM,
        negativeHalfWidthM: negativeHalfWidth,
        positiveHalfWidthM: positiveHalfWidth,
    };
}
const DEFAULT_QUERY_RADIUS_M = 12;
// OSM bridge/tunnel ways are commonly only the few metres directly over a
// road. The DGU surface there describes the road when the structure itself is
// absent, so solving that tiny way alone faithfully reproduces the wrong
// collapse. Sample the continuation along both end tangents and let the normal
// denoise/grade solver carry the approach level across the explicit structure.
const OSM_STRUCTURE_PROFILE_CONTEXT_M = 160;
const OSM_TOPOLOGY_JOIN_TOLERANCE_M = 0.75;
// Two open rail formations that meet within this vertical tolerance are one
// at-grade civil surface for boundary purposes. Larger separations retain
// their own faces; those are genuine grade-separated works, not draw-order
// conflicts.
const RAIL_PROFILE_AT_GRADE_MAX_DELTA_M = 0.75;
// The retaining face starts underneath the outer trackbed curb instead of
// merely sharing its mathematical edge. This turns a precision-sensitive line
// seam into a covered handoff without publishing another surface or draw call.
const RAIL_FORMATION_TOP_UNDERLAP_M = 0.2;

function osmInferredProfileRecord(record) {
    return record?.feature?.properties?.railProfileSource === 'osm-inferred'
        && !record.authoredAbsolute
        && Array.isArray(record.samples)
        && Array.isArray(record.designedY)
        && record.samples.length === record.designedY.length
        && record.samples.length >= 2;
}

function endpointCellKey(x, z, cellM) {
    return `${Math.floor(x / cellM)}:${Math.floor(z / cellM)}`;
}

function endpointCorrectionWeight(distanceM, influenceM) {
    const t = Math.max(0, Math.min(1, distanceM / influenceM));
    return 1 - t * t * (3 - 2 * t);
}

// OSM commonly splits one physical railway at a bridge tag boundary. Each way
// is still designed separately, but their shared node is one immutable rail
// level: an explicit bridge/tunnel endpoint owns that node and its neighbouring
// ordinary formation eases into it over a grade-safe distance.
export function joinOsmRailStructureProfiles(records, options = {}) {
    return finishRailSteps(joinOsmRailStructureProfilesSteps(records, options));
}

function* joinOsmRailStructureProfilesSteps(records, {
    toleranceM = OSM_TOPOLOGY_JOIN_TOLERANCE_M,
    minimumInfluenceM = OSM_STRUCTURE_PROFILE_CONTEXT_M,
    maxGrade = DEFAULT_MAX_GRADE,
} = {}) {
    const slice = createRailPreparationSlice();
    const endpoints = [];
    for (const record of records || []) {
        if (slice.expired()) {
            yield { phase: 'join:endpoints' };
            slice.restart();
        }
        if (!osmInferredProfileRecord(record)) continue;
        const lastIndex = record.samples.length - 1;
        for (const sampleIndex of [0, lastIndex]) {
            const sample = record.samples[sampleIndex];
            endpoints.push({
                record,
                sampleIndex,
                x: sample.x,
                z: sample.z,
                y: record.designedY[sampleIndex],
                explicit: ['viaduct', 'tunnel'].includes(
                    record.feature?.properties?.railStructure,
                ),
            });
        }
    }
    if (endpoints.length < 2) return records;

    const tolerance = Math.max(0.05, Number(toleranceM) || OSM_TOPOLOGY_JOIN_TOLERANCE_M);
    const parent = yield* mapRailPreparationSteps(endpoints, (_, index) => index, 'join:endpoints');
    const find = (index) => {
        let root = index;
        while (parent[root] !== root) root = parent[root];
        while (parent[index] !== index) {
            const next = parent[index];
            parent[index] = root;
            index = next;
        }
        return root;
    };
    const union = (a, b) => {
        const rootA = find(a);
        const rootB = find(b);
        if (rootA !== rootB) parent[rootB] = rootA;
    };
    const cells = new Map();
    for (let index = 0; index < endpoints.length; index++) {
        const endpoint = endpoints[index];
        const col = Math.floor(endpoint.x / tolerance);
        const row = Math.floor(endpoint.z / tolerance);
        for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
                for (const otherIndex of cells.get(`${col + dx}:${row + dz}`) || []) {
                    const other = endpoints[otherIndex];
                    if (Math.hypot(endpoint.x - other.x, endpoint.z - other.z) <= tolerance) {
                        union(index, otherIndex);
                    }
                    if (slice.expired()) {
                        yield { phase: 'join:topology' };
                        slice.restart();
                    }
                }
            }
        }
        const key = endpointCellKey(endpoint.x, endpoint.z, tolerance);
        const inCell = cells.get(key) || [];
        inCell.push(index);
        cells.set(key, inCell);
        if (slice.expired()) {
            yield { phase: 'join:topology' };
            slice.restart();
        }
    }

    const groups = new Map();
    for (let index = 0; index < endpoints.length; index++) {
        const root = find(index);
        const group = groups.get(root) || [];
        group.push(endpoints[index]);
        groups.set(root, group);
        if (slice.expired()) {
            yield { phase: 'join:groups' };
            slice.restart();
        }
    }
    const targetsByRecord = new Map();
    for (const group of groups.values()) {
        if (slice.expired()) {
            yield { phase: 'join:targets' };
            slice.restart();
        }
        if (group.length < 2) continue;
        const authorities = group.filter(endpoint => endpoint.explicit);
        if (authorities.length === 0) continue;
        const sorted = authorities.map(endpoint => endpoint.y).sort((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);
        const targetY = sorted.length % 2
            ? sorted[middle]
            : (sorted[middle - 1] + sorted[middle]) * 0.5;
        for (const endpoint of group) {
            const targets = targetsByRecord.get(endpoint.record) || {};
            targets[endpoint.sampleIndex === 0 ? 'start' : 'end'] = targetY;
            targetsByRecord.set(endpoint.record, targets);
            if (slice.expired()) {
                yield { phase: 'join:targets' };
                slice.restart();
            }
        }
    }

    for (const [record, targets] of targetsByRecord) {
        const samples = record.samples;
        const designedY = record.designedY;
        const endStation = Math.max(1e-6, samples.at(-1).station - samples[0].station);
        const startDelta = Number.isFinite(targets.start)
            ? targets.start - designedY[0]
            : null;
        const endDelta = Number.isFinite(targets.end)
            ? targets.end - designedY.at(-1)
            : null;
        const gradeLimit = Math.max(
            0.005,
            Number(railMaxGradeForFeature(record.feature, maxGrade)) || DEFAULT_MAX_GRADE,
        );
        const influenceFor = delta => Math.max(
            Number(minimumInfluenceM) || OSM_STRUCTURE_PROFILE_CONTEXT_M,
            Math.abs(delta || 0) * 1.5 / gradeLimit,
        );
        const startInfluence = influenceFor(startDelta);
        const endInfluence = influenceFor(endDelta);
        const overlappingAnchors = startDelta != null
            && endDelta != null
            && endStation < startInfluence + endInfluence;
        for (let index = 0; index < designedY.length; index++) {
            const distanceFromStart = samples[index].station - samples[0].station;
            const distanceFromEnd = endStation - distanceFromStart;
            let correction = 0;
            if (overlappingAnchors) {
                const t = Math.max(0, Math.min(1, distanceFromStart / endStation));
                correction = startDelta + (endDelta - startDelta) * t;
            } else {
                if (startDelta != null) {
                    correction += startDelta
                        * endpointCorrectionWeight(distanceFromStart, startInfluence);
                }
                if (endDelta != null) {
                    correction += endDelta
                        * endpointCorrectionWeight(distanceFromEnd, endInfluence);
                }
            }
            designedY[index] += correction;
            if (slice.expired()) {
                yield { phase: 'join:corrections' };
                slice.restart();
            }
        }
    }
    return records;
}
// Vertical gate for referenceY-disambiguated queries: a candidate rail more than
// this far from the height the caller is riding is a track at a DIFFERENT level
// (a tunnel track under a crossing track) and is excluded. Sized well above the
// sub-metre lag between a frame's height and the previous frame's smoothed value,
// and well below a tunnel's cover depth, so it only ever separates genuine levels.
const REFERENCE_Y_GATE_M = 4;
const DEFAULT_HALF_WIDTH_M = 1.15;
const PROFILE_STEP_M = 4;
const MAX_MITER_SCALE = 2.25;
const SEGMENT_INDEX_CELL_M = 80;
// Civil-ground consumers need a tighter corridor than plan-nearest rail
// queries. An 80 m cell made every road sample across a 160 m strip inspect a
// narrow railway profile even though fewer than 1% touched its earthworks.
const SURFACE_PROFILE_INDEX_CELL_M = 40;
const RAIL_RING_QUERY_CELL_M = 16;

function finiteCoordinate(coordinate) {
    return Array.isArray(coordinate)
        && finiteOrNull(coordinate[0]) !== null
        && finiteOrNull(coordinate[1]) !== null;
}

function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
}

function smoothstep01(value) {
    const t = clamp(Number(value) || 0, 0, 1);
    return t * t * (3 - 2 * t);
}

// Asymmetric station bays widen only the platform side of a formation. Plans
// use a short full-width plateau plus a smooth longitudinal taper, which avoids
// both a wall through the platform and a square retaining-wall discontinuity.
export function railSurfaceAccessRightHalfWidthAt(plans, stationM, baseHalfWidthM) {
    const base = Math.max(0, Number(baseHalfWidthM) || 0);
    const station = Number(stationM);
    if (!Number.isFinite(station)) return base;
    let width = base;
    for (const plan of plans || []) {
        for (const section of plan?.sections || []) {
            const center = Number(section.centerStationM);
            const plateau = Math.max(0, Number(section.plateauHalfM) || 0);
            const taper = Math.max(0, Number(section.taperM) || 0);
            const target = Math.max(base, Number(section.rightHalfWidthM) || 0);
            if (!Number.isFinite(center) || target <= base) continue;
            const beyondPlateau = Math.max(0, Math.abs(station - center) - plateau);
            if (taper <= 0 && beyondPlateau > 0) continue;
            if (beyondPlateau >= taper && taper > 0) continue;
            const factor = taper > 0 ? 1 - smoothstep01(beyondPlateau / taper) : 1;
            width = Math.max(width, base + (target - base) * factor);
        }
    }
    return width;
}

function stationAccessMinimumCutBenchReachAt(plans, stationM) {
    let reachM = null;
    for (const plan of plans || []) {
        const stair = plan?.stair;
        const required = Number(stair?.requiredBenchReachM);
        if (!(required > 0)) continue;
        const section = (plan.sections || []).find(item => item.kind === 'stair-well');
        const plateau = Math.max(0, Number(section?.plateauHalfM) || stair.widthM * 0.5);
        const taper = Math.max(0, Number(section?.taperM) || 0);
        const beyondPlateau = Math.max(
            0,
            Math.abs(Number(stationM) - Number(section?.centerStationM)) - plateau,
        );
        if (taper <= 0 && beyondPlateau > 0) continue;
        if (taper > 0 && beyondPlateau >= taper) continue;
        const factor = taper > 0 ? 1 - smoothstep01(beyondPlateau / taper) : 1;
        reachM = Math.max(reachM || 0, required * factor);
    }
    return reachM;
}

// A cut-station stair crosses the formation's retained face. Describe that
// narrow route as the same exact boundary-opening rectangle used for a road
// through an embankment: wall face, terrain collar and walk collider can then
// all stop at identical in-segment points instead of leaving an invisible wall
// across the first riser. The concrete portal apron continues beneath the kept
// terrain edge, so the opening itself never reveals the world underlay.
export function railSurfaceAccessRetainingOpenings(plans) {
    const openings = [];
    for (const plan of plans || []) {
        const stair = plan?.stair;
        const startRightM = finiteOrNull(stair?.startRightM);
        const portalEndRightM = finiteOrNull(stair?.portalEndRightM)
            ?? finiteOrNull(stair?.landingEndRightM);
        const widthM = finiteOrNull(stair?.widthM);
        const rightX = finiteOrNull(plan?.rightX);
        const rightZ = finiteOrNull(plan?.rightZ);
        const centerX = finiteOrNull(plan?.centerX);
        const centerZ = finiteOrNull(plan?.centerZ);
        if (startRightM === null || portalEndRightM === null
            || widthM === null || !(portalEndRightM > startRightM) || !(widthM > 0)
            || rightX === null || rightZ === null
            || centerX === null || centerZ === null) continue;
        const centerRightM = (startRightM + portalEndRightM) * 0.5;
        const halfRunM = (portalEndRightM - startRightM) * 0.5;
        openings.push({
            x: centerX + rightX * centerRightM,
            z: centerZ + rightZ * centerRightM,
            tangentX: rightX,
            tangentZ: rightZ,
            beforeM: halfRunM,
            afterM: halfRunM,
            halfWidthM: widthM * 0.5,
            source: 'surface-cut-station-stairs',
            stopId: plan.stopId ?? null,
        });
    }
    return openings;
}

function median(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (sorted.length === 0) return 0;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) * 0.5;
}

function projectPointToSegment(x, z, segment) {
    const dx = segment.x2 - segment.x1;
    const dz = segment.z2 - segment.z1;
    const lengthSquared = dx * dx + dz * dz;
    if (lengthSquared < 1e-9) return null;
    const t = clamp(
        ((x - segment.x1) * dx + (z - segment.z1) * dz) / lengthSquared,
        0,
        1,
    );
    const projectedX = segment.x1 + dx * t;
    const projectedZ = segment.z1 + dz * t;
    return {
        x: projectedX,
        z: projectedZ,
        t,
        distanceSquared: (x - projectedX) ** 2 + (z - projectedZ) ** 2,
    };
}

function projectPointToSegmentWithEndExtensions(
    x,
    z,
    segment,
    { extendStartM = 0, extendEndM = 0 } = {},
) {
    const dx = segment.x2 - segment.x1;
    const dz = segment.z2 - segment.z1;
    const lengthSquared = dx * dx + dz * dz;
    if (lengthSquared < 1e-9) return null;
    const length = Math.sqrt(lengthSquared);
    const t = clamp(
        ((x - segment.x1) * dx + (z - segment.z1) * dz) / lengthSquared,
        -Math.max(0, Number(extendStartM) || 0) / length,
        1 + Math.max(0, Number(extendEndM) || 0) / length,
    );
    const projectedX = segment.x1 + dx * t;
    const projectedZ = segment.z1 + dz * t;
    return {
        x: projectedX,
        z: projectedZ,
        t,
        distanceSquared: (x - projectedX) ** 2 + (z - projectedZ) ** 2,
    };
}

function* indexAlignmentSegmentsSteps(alignment) {
    const index = new Map();
    const slice = createRailPreparationSlice();
    for (const segment of alignment.segments) {
        const minCellX = Math.floor(Math.min(segment.x1, segment.x2) / SEGMENT_INDEX_CELL_M);
        const maxCellX = Math.floor(Math.max(segment.x1, segment.x2) / SEGMENT_INDEX_CELL_M);
        const minCellZ = Math.floor(Math.min(segment.z1, segment.z2) / SEGMENT_INDEX_CELL_M);
        const maxCellZ = Math.floor(Math.max(segment.z1, segment.z2) / SEGMENT_INDEX_CELL_M);
        for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
            for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
                const key = `${cellX}_${cellZ}`;
                const bucket = index.get(key);
                if (bucket) bucket.push(segment);
                else index.set(key, [segment]);
                if (slice.expired()) {
                    yield { phase: 'index' };
                    slice.restart();
                }
            }
        }
    }
    alignment.segmentIndex = index;
}

function alignmentSegmentsNear(alignment, x, z, radiusM) {
    const radius = Math.max(0, Number(radiusM) || 0);
    const minCellX = Math.floor((x - radius) / SEGMENT_INDEX_CELL_M);
    const maxCellX = Math.floor((x + radius) / SEGMENT_INDEX_CELL_M);
    const minCellZ = Math.floor((z - radius) / SEGMENT_INDEX_CELL_M);
    const maxCellZ = Math.floor((z + radius) / SEGMENT_INDEX_CELL_M);
    const found = [];
    const seen = new Set();
    for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
        for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
            for (const segment of alignment.segmentIndex?.get(`${cellX}_${cellZ}`) || []) {
                if (seen.has(segment)) continue;
                seen.add(segment);
                found.push(segment);
            }
        }
    }
    return found;
}

function railSurfaceProfileBounds(profile) {
    return profile?.overlapBounds
        || profile?.terrainCutoutBounds
        || profile?.outerBounds
        || profile?.bounds
        || null;
}

// Envelope radii keyed by profile ring + alignment plan shape. A re-assembled
// alignment (terrain changed under part of it) produces fresh profile objects,
// but ring x/z and the plan axis only move when FEATURES change — terrain
// changes move heights, and the projection distances are horizontal. The cache
// therefore survives re-assembly and keeps indexRailSurfaceProfiles from
// re-projecting hundreds of thousands of points per rebuild.
const profileEnvelopeRadiusCache = new Map();
const profileIndexCellKeysCache = new Map();
const PROFILE_ENVELOPE_CACHE_MAX = 4096;

const envelopeHashBuffer = new ArrayBuffer(8);
const envelopeHashView = new DataView(envelopeHashBuffer);

function fnv1aNumber(hash, value) {
    // Hash the exact IEEE-754 bytes incrementally. Building comma-separated
    // strings for every coordinate allocated several megabytes and consumed
    // most of Split's rail surface-index refresh even on a radius-cache hit.
    envelopeHashView.setFloat64(0, Number(value), true);
    let next = hash;
    for (let index = 0; index < 8; index++) {
        next ^= envelopeHashView.getUint8(index);
        next = Math.imul(next, 0x01000193);
    }
    return next >>> 0;
}

function profileEnvelopeCacheKey(profile, alignment) {
    if (!alignment) return null;
    if (alignment._envelopePlanKey == null) {
        let planHash = 0x811c9dc5;
        planHash = fnv1aNumber(planHash, alignment.samples?.length || 0);
        for (const sample of alignment.samples || []) {
            planHash = fnv1aNumber(planHash, sample.x);
            planHash = fnv1aNumber(planHash, sample.z);
        }
        alignment._envelopePlanKey = planHash;
    }
    let hash = 0x811c9dc5;
    hash = fnv1aNumber(hash, alignment._envelopePlanKey);
    hash = fnv1aNumber(hash, alignment.halfWidthM);
    hash = fnv1aNumber(hash, profile.startStation);
    hash = fnv1aNumber(hash, profile.endStation);
    if (profile._civilGroundEnvelopePlanStable === true) {
        hash = fnv1aNumber(hash, profile._civilGroundEnvelopeRadiusM);
        return hash;
    }
    hash = fnv1aNumber(hash, profile.points?.length ?? 0);
    for (const point of profile.points || []) {
        hash = fnv1aNumber(hash, point.innerX);
        hash = fnv1aNumber(hash, point.innerZ);
        hash = fnv1aNumber(hash, point.outerX);
        hash = fnv1aNumber(hash, point.outerZ);
        hash = fnv1aNumber(hash, point.overlapX);
        hash = fnv1aNumber(hash, point.overlapZ);
    }
    return hash;
}

function indexRailSurfaceProfiles(profiles) {
    const indexSets = new Map();
    const addBoundsCellKeys = (keys, bounds) => {
        const minCellX = Math.floor(bounds.minX / SURFACE_PROFILE_INDEX_CELL_M);
        const maxCellX = Math.floor(bounds.maxX / SURFACE_PROFILE_INDEX_CELL_M);
        const minCellZ = Math.floor(bounds.minZ / SURFACE_PROFILE_INDEX_CELL_M);
        const maxCellZ = Math.floor(bounds.maxZ / SURFACE_PROFILE_INDEX_CELL_M);
        for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
            for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
                keys.add(`${cellX}_${cellZ}`);
            }
        }
    };
    const publishProfileCellKeys = (profile, keys) => {
        for (const key of keys) {
            let bucket = indexSets.get(key);
            if (!bucket) indexSets.set(key, bucket = new Set());
            bucket.add(profile);
        }
    };
    for (const profile of profiles || []) {
        const bounds = railSurfaceProfileBounds(profile);
        if (!bounds) continue;
        const alignment = profile.alignment;
        const segments = alignment?.segments || [];
        if (segments.length === 0) {
            const cellKeys = new Set();
            addBoundsCellKeys(cellKeys, bounds);
            publishProfileCellKeys(profile, cellKeys);
            continue;
        }

        // A long curved formation has a huge rectangular AABB: Split's narrow
        // harbour railway spans several square kilometres in plan. Stamping
        // that whole box put the profile in practically every road query and
        // made road construction call ringContainsPoint hundreds of thousands
        // of times. Measure the actual civil reach from its axis, then stamp
        // only the alignment segments belonging to this profile's station run.
        // Projecting every ring point onto its nearby segments was measured at
        // 600+ ms per rebuild on the Split corridor — and the result is a pure
        // function of the profile's own geometry, so a profile reused by the
        // formation-assembly memoization carries its radius over. Only freshly
        // assembled profiles pay for the computation.
        const cacheKey = profile._civilGroundEnvelopeCacheKey
            ?? profileEnvelopeCacheKey(profile, alignment);
        profile._civilGroundEnvelopeCacheKey = cacheKey;
        if (!Number.isFinite(profile._civilGroundEnvelopeRadiusM)) {
            const cachedRadiusM = cacheKey != null
                ? profileEnvelopeRadiusCache.get(cacheKey)
                : undefined;
            if (cachedRadiusM !== undefined) {
                profile._civilGroundEnvelopeRadiusM = cachedRadiusM;
            } else {
            let measuredRadiusM = Math.max(1, Number(alignment.halfWidthM) || 0) + 1;
            for (const point of profile.points || []) {
                for (const [x, z] of [
                    [point.innerX, point.innerZ],
                    [point.outerX, point.outerZ],
                    [point.overlapX, point.overlapZ],
                ]) {
                    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
                    let nearestDistanceSquared = Infinity;
                    for (const segment of alignmentSegmentsNear(alignment, x, z, 200)) {
                        const projected = projectPointToSegment(x, z, segment);
                        if (projected && projected.distanceSquared < nearestDistanceSquared) {
                            nearestDistanceSquared = projected.distanceSquared;
                        }
                    }
                    if (Number.isFinite(nearestDistanceSquared)) {
                        measuredRadiusM = Math.max(
                            measuredRadiusM,
                            Math.sqrt(nearestDistanceSquared) + 1,
                        );
                    }
                }
            }
            profile._civilGroundEnvelopeRadiusM = measuredRadiusM;
            if (cacheKey != null) {
                if (profileEnvelopeRadiusCache.size >= PROFILE_ENVELOPE_CACHE_MAX) {
                    profileEnvelopeRadiusCache.clear();
                    profileIndexCellKeysCache.clear();
                }
                profileEnvelopeRadiusCache.set(cacheKey, measuredRadiusM);
            }
            }
        }
        const cachedCellKeys = profile._civilGroundIndexCellKeys
            || (cacheKey != null ? profileIndexCellKeysCache.get(cacheKey) : null);
        if (cachedCellKeys) {
            profile._civilGroundIndexCellKeys = cachedCellKeys;
            publishProfileCellKeys(profile, cachedCellKeys);
            continue;
        }
        const envelopeRadiusM = profile._civilGroundEnvelopeRadiusM;
        const cellKeys = new Set();
        let stamped = false;
        // Formation profiles are created from one contiguous segment run. Use
        // that exact range instead of scanning the alignment's complete route
        // for every profile. The Split reconstruction has 8,663 segments and
        // 36 profiles; the old nested scan revisited ~312k segments after each
        // bounded terrain update even though the runs are already known here.
        const storedRange = profile._alignmentSegmentRange;
        const hasStoredRange = Number.isInteger(storedRange?.start)
            && Number.isInteger(storedRange?.end)
            && storedRange.start >= 0
            && storedRange.end >= storedRange.start
            && storedRange.end < segments.length;
        const firstSegmentIndex = hasStoredRange ? storedRange.start : 0;
        const lastSegmentIndex = hasStoredRange ? storedRange.end : segments.length - 1;
        for (let segmentIndex = firstSegmentIndex;
            segmentIndex <= lastSegmentIndex;
            segmentIndex++) {
            const segment = segments[segmentIndex];
            const segmentStartM = alignment.samples?.[segment.startSampleIndex]?.station;
            const segmentEndM = alignment.samples?.[segment.endSampleIndex]?.station;
            if (!hasStoredRange
                && Number.isFinite(profile.startStation) && Number.isFinite(profile.endStation)
                && Number.isFinite(segmentStartM) && Number.isFinite(segmentEndM)
                && (segmentEndM < profile.startStation - 1e-6
                    || segmentStartM > profile.endStation + 1e-6)) {
                continue;
            }
            addBoundsCellKeys(cellKeys, {
                minX: Math.min(segment.x1, segment.x2) - envelopeRadiusM,
                maxX: Math.max(segment.x1, segment.x2) + envelopeRadiusM,
                minZ: Math.min(segment.z1, segment.z2) - envelopeRadiusM,
                maxZ: Math.max(segment.z1, segment.z2) + envelopeRadiusM,
            });
            stamped = true;
        }
        if (!stamped) addBoundsCellKeys(cellKeys, bounds);
        const storedCellKeys = [...cellKeys];
        profile._civilGroundIndexCellKeys = storedCellKeys;
        if (cacheKey != null) profileIndexCellKeysCache.set(cacheKey, storedCellKeys);
        publishProfileCellKeys(profile, storedCellKeys);
    }
    return new Map(Array.from(indexSets, ([key, bucket]) => [key, [...bucket]]));
}

function indexedRailSurfaceProfilesNear(index, x, z, radius) {
    const found = new Set();
    const minCellX = Math.floor((x - radius) / SURFACE_PROFILE_INDEX_CELL_M);
    const maxCellX = Math.floor((x + radius) / SURFACE_PROFILE_INDEX_CELL_M);
    const minCellZ = Math.floor((z - radius) / SURFACE_PROFILE_INDEX_CELL_M);
    const maxCellZ = Math.floor((z + radius) / SURFACE_PROFILE_INDEX_CELL_M);
    for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
        for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
            for (const profile of index?.get(`${cellX}_${cellZ}`) || []) {
                const bounds = railSurfaceProfileBounds(profile);
                if (!bounds) continue;
                const dx = x < bounds.minX ? bounds.minX - x : x > bounds.maxX ? x - bounds.maxX : 0;
                const dz = z < bounds.minZ ? bounds.minZ - z : z > bounds.maxZ ? z - bounds.maxZ : 0;
                if (dx * dx + dz * dz <= radius * radius) found.add(profile);
            }
        }
    }
    return [...found];
}

function indexedRailSurfaceProfilesAt(index, x, z) {
    const cellX = Math.floor(x / SURFACE_PROFILE_INDEX_CELL_M);
    const cellZ = Math.floor(z / SURFACE_PROFILE_INDEX_CELL_M);
    return index?.get(`${cellX}_${cellZ}`) || [];
}

function segmentNormal(from, to) {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const length = Math.hypot(dx, dz);
    return length > 1e-6 ? { x: dz / length, z: -dx / length } : null;
}

function joinVector(before, after) {
    if (!before && !after) return { x: 1, z: 0 };
    if (!before) return after;
    if (!after) return before;
    let x = before.x + after.x;
    let z = before.z + after.z;
    const length = Math.hypot(x, z);
    if (length < 1e-5) return after;
    x /= length;
    z /= length;
    const alignment = Math.max(0.2, x * after.x + z * after.z);
    const scale = Math.min(MAX_MITER_SCALE, 1 / alignment);
    return { x: x * scale, z: z * scale };
}

function interpolateBoundarySample(samples, joins, stationM) {
    if (!samples?.length || !joins?.length) return null;
    const station = Number(stationM);
    if (!Number.isFinite(station)) return null;
    for (let index = 0; index < samples.length; index++) {
        if (Math.abs(samples[index].station - station) <= 1e-6) {
            return { sample: samples[index], join: joins[index] };
        }
    }
    for (let index = 1; index < samples.length; index++) {
        const before = samples[index - 1];
        const after = samples[index];
        if (station <= before.station || station >= after.station) continue;
        const span = after.station - before.station;
        const t = span > 1e-9 ? (station - before.station) / span : 0;
        return {
            sample: {
                x: before.x + (after.x - before.x) * t,
                z: before.z + (after.z - before.z) * t,
                railY: before.railY + (after.railY - before.railY) * t,
                station,
            },
            // Interpolating the already-mitered joins preserves the exact run
            // end vectors and is stable through a gently curved station bay.
            join: {
                x: joins[index - 1].x + (joins[index].x - joins[index - 1].x) * t,
                z: joins[index - 1].z + (joins[index].z - joins[index - 1].z) * t,
            },
        };
    }
    return null;
}

function formationBoundarySamples(runSamples, runJoins, accessPlans) {
    if (!accessPlans?.length || runSamples.length < 2) {
        return { samples: runSamples, joins: runJoins };
    }
    const startM = runSamples[0].station;
    const endM = runSamples.at(-1).station;
    const additions = [];
    for (const plan of accessPlans) {
        for (const section of plan?.sections || []) {
            const center = Number(section.centerStationM);
            const plateau = Math.max(0, Number(section.plateauHalfM) || 0);
            const taper = Math.max(0, Number(section.taperM) || 0);
            for (const station of [
                center,
                center - plateau,
                center + plateau,
                center - plateau - taper,
                center + plateau + taper,
            ]) {
                if (station <= startM + 1e-6 || station >= endM - 1e-6) continue;
                const interpolated = interpolateBoundarySample(runSamples, runJoins, station);
                if (interpolated) additions.push(interpolated);
            }
        }
    }
    if (additions.length === 0) return { samples: runSamples, joins: runJoins };
    const combined = runSamples.map((sample, index) => ({ sample, join: runJoins[index] }));
    for (const addition of additions) {
        if (combined.some(entry => Math.abs(entry.sample.station - addition.sample.station) <= 1e-6)) {
            continue;
        }
        combined.push(addition);
    }
    combined.sort((left, right) => left.sample.station - right.sample.station);
    return {
        samples: combined.map(entry => entry.sample),
        joins: combined.map(entry => entry.join),
    };
}

function createRailRingQueryIndex(ring) {
    const cells = new Map();
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
        const a = ring[index];
        const b = ring[previous];
        if (a.z === b.z) continue;
        const minCell = Math.floor(Math.min(a.z, b.z) / RAIL_RING_QUERY_CELL_M);
        const maxCell = Math.floor(Math.max(a.z, b.z) / RAIL_RING_QUERY_CELL_M);
        const edge = { a, b };
        for (let cell = minCell; cell <= maxCell; cell++) {
            const bucket = cells.get(cell);
            if (bucket) bucket.push(edge);
            else cells.set(cell, [edge]);
        }
    }
    return cells;
}

// Rings are immutable compiled geometry; query acceleration must not mutate a
// published profile or pin it after its generation retires.
const railRingQueryIndexes = new WeakMap();
function railRingQueryIndex(ring) {
    if (!ring) return null;
    let index = railRingQueryIndexes.get(ring);
    if (!index) {
        index = createRailRingQueryIndex(ring);
        railRingQueryIndexes.set(ring, index);
    }
    return index;
}
const railInnerRingQueryIndex = profile => railRingQueryIndex(profile?.innerRing);
const railTerrainCutoutRingQueryIndex = profile => railRingQueryIndex(profile?.terrainCutoutRing);

function ringContainsPoint(ring, x, z, queryIndex = null) {
    let inside = false;
    const edges = queryIndex?.get(Math.floor(z / RAIL_RING_QUERY_CELL_M)) || null;
    const edgeCount = edges ? edges.length : ring.length;
    for (let index = 0; index < edgeCount; index++) {
        const a = edges ? edges[index].a : ring[index];
        const b = edges ? edges[index].b : ring[(index - 1 + ring.length) % ring.length];
        const crosses = (a.z > z) !== (b.z > z)
            && x < ((b.x - a.x) * (z - a.z)) / ((b.z - a.z) || 1e-12) + a.x;
        if (crosses) inside = !inside;
    }
    return inside;
}

function railContextProfilesOverlapAtBoundary(profile, other, index) {
    const points = profile?.points || [];
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const ring = other?.innerRing || [];
    if (!a || !b || ring.length < 3) return false;
    for (const t of [0.25, 0.5, 0.75]) {
        const x = a.innerX + (b.innerX - a.innerX) * t;
        const z = a.innerZ + (b.innerZ - a.innerZ) * t;
        const bounds = other.bounds;
        if (bounds && (x < bounds.minX || x > bounds.maxX
            || z < bounds.minZ || z > bounds.maxZ)) continue;
        if (ringContainsPoint(ring, x, z, railInnerRingQueryIndex(other))) return true;
    }
    return false;
}

// Parallel station tracks are separate LineStrings, but physically share one
// ballast/formation yard. Suppress only boundaries buried inside another
// member of the same curated context group; the exterior perimeter remains a
// neat cut/collar. This also joins the OSM context to the solved drive track.
function mergeRailContextProfileBoundaries(profiles) {
    const list = (profiles || []).filter(profile => profile?.railContextGroupId);
    for (const profile of list) {
        if (profile.railContextRole === 'station-yard') profile.railContextApron = true;
    }
    for (let leftIndex = 0; leftIndex < list.length; leftIndex++) {
        const left = list[leftIndex];
        for (let rightIndex = leftIndex + 1; rightIndex < list.length; rightIndex++) {
            const right = list[rightIndex];
            if (left.railContextGroupId !== right.railContextGroupId) continue;
            if (left.railContextRole !== 'station-yard'
                && right.railContextRole !== 'station-yard') continue;
            let merged = false;
            for (let index = 0; index < left.points.length; index++) {
                if (!railContextProfilesOverlapAtBoundary(left, right, index)) continue;
                left.internalSegments[index] = true;
                left.collarInternalSegments[index] = true;
                merged = true;
            }
            for (let index = 0; index < right.points.length; index++) {
                if (!railContextProfilesOverlapAtBoundary(right, left, index)) continue;
                right.internalSegments[index] = true;
                right.collarInternalSegments[index] = true;
                merged = true;
            }
            if (merged) {
                left.railContextApron = true;
                right.railContextApron = true;
            }
        }
    }
}

function railProfileSurfaceYAtLocal(profile, x, z) {
    const alignment = profile?.alignment;
    if (!alignment?.segments?.length) return null;
    const queryRadiusM = Math.max(
        20,
        Number(profile._civilGroundEnvelopeRadiusM) || 0,
    );
    let bestDistanceSquared = Infinity;
    let bestY = null;
    for (const segment of alignmentSegmentsNear(alignment, x, z, queryRadiusM)) {
        const segmentStartM = alignment.samples?.[segment.startSampleIndex]?.station;
        const segmentEndM = alignment.samples?.[segment.endSampleIndex]?.station;
        if (Number.isFinite(profile.startStation) && Number.isFinite(profile.endStation)
            && Number.isFinite(segmentStartM) && Number.isFinite(segmentEndM)
            && (segmentEndM < profile.startStation - 1e-6
                || segmentStartM > profile.endStation + 1e-6)) continue;
        const projected = projectPointToSegment(x, z, segment);
        if (!projected || projected.distanceSquared >= bestDistanceSquared) continue;
        bestDistanceSquared = projected.distanceSquared;
        bestY = segment.y1 + (segment.y2 - segment.y1) * projected.t;
    }
    return finiteOrNull(bestY);
}

function railProfilesMeetAtGradeAtLocal(profile, other, x, z, ownY) {
    if (!other || other === profile) return false;
    const bounds = other.bounds;
    if (bounds && (x < bounds.minX || x > bounds.maxX
        || z < bounds.minZ || z > bounds.maxZ)) return false;
    if (!ringContainsPoint(
        other.innerRing || [],
        x,
        z,
        railInnerRingQueryIndex(other),
    )) return false;
    const otherY = railProfileSurfaceYAtLocal(other, x, z);
    return ownY !== null && otherY !== null
        && Math.abs(ownY - otherY) <= RAIL_PROFILE_AT_GRADE_MAX_DELTA_M;
}

// A whole boundary segment is removed below, so replacement evidence must
// cover the whole sampled band. The former ANY-sample rule could see one
// neighbouring trackbed at one corner and delete a four-metre collar quad;
// on an embankment the uncovered remainder became a literal see-through slot.
function railProfileBandFullyCoveredByAnotherSurface(
    profile,
    a,
    b,
    profileIndex,
    nearXKey,
    nearZKey,
    farXKey,
    farZKey,
    acrossFractions,
    alongFractions,
) {
    let sampled = false;
    for (const t of alongFractions) {
        const nearX = a[nearXKey] + (b[nearXKey] - a[nearXKey]) * t;
        const nearZ = a[nearZKey] + (b[nearZKey] - a[nearZKey]) * t;
        const farX = a[farXKey] + (b[farXKey] - a[farXKey]) * t;
        const farZ = a[farZKey] + (b[farZKey] - a[farZKey]) * t;
        const ownY = a.roadY + (b.roadY - a.roadY) * t;
        for (const s of acrossFractions) {
            sampled = true;
            const x = nearX + (farX - nearX) * s;
            const z = nearZ + (farZ - nearZ) * s;
            let covered = false;
            for (const other of indexedRailSurfaceProfilesAt(profileIndex, x, z)) {
                if (!railProfilesMeetAtGradeAtLocal(profile, other, x, z, ownY)) continue;
                covered = true;
                break;
            }
            if (!covered) return false;
        }
    }
    return sampled;
}

function railProfileEdgeHasIndexedNeighbour(profile, a, b, profileIndex) {
    const xs = [
        a.innerX, a.outerX, a.overlapX,
        b.innerX, b.outerX, b.overlapX,
    ];
    const zs = [
        a.innerZ, a.outerZ, a.overlapZ,
        b.innerZ, b.outerZ, b.overlapZ,
    ];
    if (![...xs, ...zs].every(Number.isFinite)) return true;
    const minCellX = Math.floor(Math.min(...xs) / SURFACE_PROFILE_INDEX_CELL_M);
    const maxCellX = Math.floor(Math.max(...xs) / SURFACE_PROFILE_INDEX_CELL_M);
    const minCellZ = Math.floor(Math.min(...zs) / SURFACE_PROFILE_INDEX_CELL_M);
    const maxCellZ = Math.floor(Math.max(...zs) / SURFACE_PROFILE_INDEX_CELL_M);
    for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
        for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
            const bucket = profileIndex?.get(`${cellX}_${cellZ}`) || [];
            if (bucket.some(candidate => candidate !== profile)) return true;
        }
    }
    return false;
}

// Every open rail LineString builds its own wall/collar envelope. At a switch,
// parallel yard track, or harmless OSM way split those envelopes can overlap
// another trackbed even though both rail tops are one at-grade surface. Resolve
// that conflict semantically: the paved rail surface wins; only the buried
// boundary dressing is removed. The spatial profile index keeps this local to
// actual neighbours rather than making national streaming an O(N²) pass.
function* suppressRailProfileDressingOverlapSteps(profiles, profileIndex, {
    sliceMs = WHOLE_SET_SLICE_MS,
} = {}) {
    const list = Array.isArray(profiles) ? profiles : [];
    if (list.length < 2) return;
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let sliceStartedAt = now();
    for (const profile of list) {
        const points = profile.points || [];
        for (let index = 0; index < points.length; index++) {
            const a = points[index];
            const b = points[(index + 1) % points.length];
            // Most of a national-scale formation has no neighbouring rail
            // surface at all. The spatial index is conservative, so an edge
            // whose complete inner→overlap band sees only itself cannot pass
            // either exact overlap test below. This avoids 17 sampled queries
            // per boundary edge along otherwise solitary railway.
            if (!railProfileEdgeHasIndexedNeighbour(profile, a, b, profileIndex)) {
                continue;
            }
            const wallInside = railProfileBandFullyCoveredByAnotherSurface(
                profile,
                a,
                b,
                profileIndex,
                'innerX',
                'innerZ',
                'outerX',
                'outerZ',
                [0.25, 0.5, 0.75],
                [0.25, 0.5, 0.75],
            );
            if (wallInside) profile.internalSegments[index] = true;
            const collarInside = railProfileBandFullyCoveredByAnotherSurface(
                profile,
                a,
                b,
                profileIndex,
                'outerX',
                'outerZ',
                'overlapX',
                'overlapZ',
                [0.25, 0.5, 0.75],
                [0.125, 0.25, 0.5, 0.75, 0.875],
            );
            if (collarInside) profile.collarInternalSegments[index] = true;
            if (now() - sliceStartedAt >= Math.max(0.5, Number(sliceMs) || WHOLE_SET_SLICE_MS)) {
                yield { phase: 'edges' };
                sliceStartedAt = now();
            }
        }
    }
}

function suppressRailProfileCap(profile, side) {
    const tags = profile?.boundarySegmentTags;
    if (!Array.isArray(tags)) return;
    for (let index = 0; index < tags.length; index++) {
        if (tags[index] !== side) continue;
        profile.internalSegments[index] = true;
        profile.collarInternalSegments[index] = true;
    }
}

// An OSM way endpoint is not a physical earthwork endpoint when another rail
// way continues from the same topology node. Remove the false cross-wall and
// collar for ordinary/tunnel continuations, but keep a formation-to-viaduct cap
// as the bridge abutment. Matching both plan and rail Y avoids joining stacked
// routes that merely share a coordinate.
function suppressConnectedRailFormationCaps(alignments, profiles) {
    const endpoints = [];
    for (const alignment of alignments || []) {
        const samples = alignment?.samples || [];
        if (samples.length < 2) continue;
        const lastIndex = samples.length - 1;
        endpoints.push({
            alignment,
            side: 'start',
            x: samples[0].x,
            z: samples[0].z,
            y: samples[0].railY,
            structure: alignment.endpointStructures?.start || 'formation',
        }, {
            alignment,
            side: 'end',
            x: samples[lastIndex].x,
            z: samples[lastIndex].z,
            y: samples[lastIndex].railY,
            structure: alignment.endpointStructures?.end || 'formation',
        });
    }
    if (endpoints.length < 2) return;
    const toleranceM = OSM_TOPOLOGY_JOIN_TOLERANCE_M;
    const cells = new Map();
    for (const endpoint of endpoints) {
        const key = endpointCellKey(endpoint.x, endpoint.z, toleranceM);
        let bucket = cells.get(key);
        if (!bucket) cells.set(key, bucket = []);
        bucket.push(endpoint);
    }
    const nearby = (endpoint) => {
        const col = Math.floor(endpoint.x / toleranceM);
        const row = Math.floor(endpoint.z / toleranceM);
        const found = [];
        for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
                for (const other of cells.get(`${col + dx}:${row + dz}`) || []) {
                    if (other.alignment === endpoint.alignment) continue;
                    if (Math.hypot(other.x - endpoint.x, other.z - endpoint.z) > toleranceM) {
                        continue;
                    }
                    if (Math.abs(other.y - endpoint.y) > RAIL_PROFILE_AT_GRADE_MAX_DELTA_M) {
                        continue;
                    }
                    found.push(other);
                }
            }
        }
        return found;
    };
    for (const endpoint of endpoints) {
        if (endpoint.structure !== 'formation') continue;
        const continuation = nearby(endpoint).some(other => other.structure !== 'viaduct');
        if (!continuation) continue;
        const totalStation = endpoint.alignment.samples.at(-1)?.station || 0;
        for (const profile of profiles || []) {
            if (profile.alignment !== endpoint.alignment) continue;
            const ownsEndpoint = endpoint.side === 'start'
                ? Math.abs((profile.startStation || 0)) <= 1e-6
                : Math.abs((profile.endStation || 0) - totalStation) <= 1e-6;
            if (ownsEndpoint) suppressRailProfileCap(profile, endpoint.side);
        }
    }
}

// ── Per-feature assembly reuse ─────────────────────────────────────────────
// The post-join assembly (cross-sections, classification, surface profiles,
// excavation) is ~99% of a formation rebuild and is deterministic per feature
// given its post-join samples and options. A rebuild triggered by a bounded
// terrain change may therefore carry over every alignment whose content
// signature matches the previous model's AND whose dressing footprint misses
// the changed bounds — the flank/excavation sampling reaches beyond the
// centreline, so the signature alone (centreline terrain only) is not enough.
const ASSEMBLY_REUSE_PAD_M = 20;

// Preparation depends on source geometry/tags, model options and the terrain
// queried by the profile solver, not on neighbouring endpoint corrections.
// Keep the unjoined design: joins must be recomputed against the CURRENT set.
function railFeaturePreparationKey(feature) {
    return JSON.stringify([feature?.geometry ?? null, feature?.properties ?? null]);
}

function* railPreparationBoundsSteps(samples, feature, sampleStepM) {
    let minX = Infinity; let maxX = -Infinity;
    let minZ = Infinity; let maxZ = -Infinity;
    const grow = (x, z) => {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    };
    const slice = createRailPreparationSlice();
    for (const sample of samples) {
        grow(sample.x, sample.z);
        if (slice.expired()) {
            yield { phase: 'bounds' };
            slice.restart();
        }
    }
    // An explicit bridge/tunnel samples both outward tangents, up to 160 m
    // beyond the geometry. An assembly's dressing bounds do not include them.
    if (feature?.properties?.railProfileSource === 'osm-inferred'
        && ['viaduct', 'tunnel'].includes(feature?.properties?.railStructure)) {
        const reachM = Math.ceil(OSM_STRUCTURE_PROFILE_CONTEXT_M / sampleStepM) * sampleStepM;
        for (const [tip, inner] of [[samples[0], samples[1]], [samples.at(-1), samples.at(-2)]]) {
            const length = Math.hypot(tip.x - inner.x, tip.z - inner.z);
            if (length >= 0.01) grow(
                tip.x + (tip.x - inner.x) / length * reachM,
                tip.z + (tip.z - inner.z) / length * reachM,
            );
        }
    }
    return {
        minX: minX - ASSEMBLY_REUSE_PAD_M, maxX: maxX + ASSEMBLY_REUSE_PAD_M,
        minZ: minZ - ASSEMBLY_REUSE_PAD_M, maxZ: maxZ + ASSEMBLY_REUSE_PAD_M,
    };
}

function railFeatureAssemblySignature({
    feature,
    samples,
    halfWidthM,
    surfaceHalfWidthM,
    routeStartStationM,
    authoredAbsolute,
    authoredGroundRelative,
}) {
    const parts = [
        String(routeStartStationM),
        String(halfWidthM),
        String(surfaceHalfWidthM),
        authoredAbsolute ? 'A' : '-',
        authoredGroundRelative ? 'G' : '-',
        JSON.stringify(feature?.properties ?? null),
    ];
    for (const sample of samples) {
        parts.push(
            String(sample.x), String(sample.z), String(sample.station),
            String(sample.terrainY), String(sample.railY),
            String(sample.incomingCivilStructure ?? ''),
            String(sample.elevationM ?? ''),
        );
    }
    return parts.join('');
}

// Everything the feature's earthworks can touch: samples widened by the
// alignment half width, plus every profile's own outermost bounds (which
// include collars, cutouts and excavation reach), padded.
function railAlignmentReuseBounds(alignment) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    const grow = (x, z, radiusM = 0) => {
        if (!Number.isFinite(x) || !Number.isFinite(z)) return;
        minX = Math.min(minX, x - radiusM);
        maxX = Math.max(maxX, x + radiusM);
        minZ = Math.min(minZ, z - radiusM);
        maxZ = Math.max(maxZ, z + radiusM);
    };
    const halfWidthM = finiteOrNull(alignment?.halfWidthM) ?? 0;
    for (const sample of alignment?.samples || []) grow(sample.x, sample.z, halfWidthM);
    for (const profile of alignment?.profiles || []) {
        const b = profile?.overlapBounds || profile?.terrainCutoutBounds
            || profile?.outerBounds || profile?.bounds;
        if (b) {
            grow(b.minX, b.minZ);
            grow(b.maxX, b.maxZ);
        }
    }
    if (!Number.isFinite(minX)) return null;
    return {
        minX: minX - ASSEMBLY_REUSE_PAD_M,
        maxX: maxX + ASSEMBLY_REUSE_PAD_M,
        minZ: minZ - ASSEMBLY_REUSE_PAD_M,
        maxZ: maxZ + ASSEMBLY_REUSE_PAD_M,
    };
}

// Chord- and profile-level dirtiness: a whole-way bbox over-dirties long or
// diagonal ways enormously (its box covers km² the dressing never touches).
// A change rect dirties the alignment only if it comes within reach of an
// actual chord (padded by the half width) or of a profile's own run-local
// bounds.
function railAlignmentTouchesRects(alignment, rects) {
    const samples = alignment?.samples || [];
    const chordPadM = (finiteOrNull(alignment?.halfWidthM) ?? 0) + ASSEMBLY_REUSE_PAD_M;
    for (const rect of rects || []) {
        const rMinX = finiteOrNull(rect?.minX);
        const rMaxX = finiteOrNull(rect?.maxX);
        const rMinZ = finiteOrNull(rect?.minZ);
        const rMaxZ = finiteOrNull(rect?.maxZ);
        if (rMinX == null || rMaxX == null || rMinZ == null || rMaxZ == null) continue;
        for (let index = 1; index < samples.length; index += 1) {
            const a = samples[index - 1];
            const b = samples[index];
            if (Math.max(a.x, b.x) + chordPadM >= rMinX
                && Math.min(a.x, b.x) - chordPadM <= rMaxX
                && Math.max(a.z, b.z) + chordPadM >= rMinZ
                && Math.min(a.z, b.z) - chordPadM <= rMaxZ) return true;
        }
        for (const profile of alignment?.profiles || []) {
            const bounds = profile?.overlapBounds || profile?.terrainCutoutBounds
                || profile?.outerBounds || profile?.bounds;
            if (!bounds) continue;
            if (bounds.maxX + ASSEMBLY_REUSE_PAD_M >= rMinX
                && bounds.minX - ASSEMBLY_REUSE_PAD_M <= rMaxX
                && bounds.maxZ + ASSEMBLY_REUSE_PAD_M >= rMinZ
                && bounds.minZ - ASSEMBLY_REUSE_PAD_M <= rMaxZ) return true;
        }
    }
    return false;
}

function reuseBoundsIntersectRects(bounds, rects) {
    for (const rect of rects || []) {
        const rMinX = finiteOrNull(rect?.minX);
        const rMaxX = finiteOrNull(rect?.maxX);
        const rMinZ = finiteOrNull(rect?.minZ);
        const rMaxZ = finiteOrNull(rect?.maxZ);
        if (rMinX == null || rMaxX == null || rMinZ == null || rMaxZ == null) continue;
        if (bounds.maxX >= rMinX && bounds.minX <= rMaxX
            && bounds.maxZ >= rMinZ && bounds.minZ <= rMaxZ) return true;
    }
    return false;
}

// The whole-set passes after the assembly loop (cap suppression, boundary
// merges, dressing overlaps) and the scene layer's crossing flaggers latch
// booleans onto profiles. A reused profile must re-enter those passes exactly
// as a freshly assembled one would — with its flags pristine — or a condition
// that disappeared (a removed neighbour) would stay latched forever.
function captureRailProfilePristineFlags(alignment) {
    for (const profile of alignment?.profiles || []) {
        profile._pristineFlags = {
            internalSegments: Array.isArray(profile.internalSegments)
                ? [...profile.internalSegments]
                : null,
            collarInternalSegments: Array.isArray(profile.collarInternalSegments)
                ? [...profile.collarInternalSegments]
                : null,
            sharedRetainingWallSegments: Array.isArray(profile.sharedRetainingWallSegments)
                ? [...profile.sharedRetainingWallSegments]
                : null,
            roadOpeningSegmentRanges: Array.isArray(profile.roadOpeningSegmentRanges)
                ? profile.roadOpeningSegmentRanges.map(ranges => (
                    (ranges || []).map(range => [...range])
                ))
                : null,
            railContextApron: profile.railContextApron === true,
        };
    }
}

// Reuse compiled geometry, never a previous generation's mutable graph. The
// active scene can still read crossing/cap flags while this iterator is paused
// or discarded. Segment/run/access references must point at the new alignment
// too, otherwise its new feature and profile flags leak back through queries.
function* copyRailAlignmentGenerationSteps(previous, feature, { resetFlags = true } = {}) {
    const alignment = { ...previous, feature, segments: [], profiles: [] };
    const segmentCopies = new Map();
    alignment.segments = yield* mapRailPreparationSteps(previous.segments, (segment) => {
        const copy = { ...segment, alignment };
        segmentCopies.set(segment, copy);
        return copy;
    }, 'segments');
    alignment.segmentIndex = new Map();
    const slice = createRailPreparationSlice();
    for (const [key, segments] of previous.segmentIndex) {
        const bucket = [];
        for (const segment of segments) {
            bucket.push(segmentCopies.get(segment));
            if (slice.expired()) {
                yield { phase: 'index' };
                slice.restart();
            }
        }
        alignment.segmentIndex.set(key, bucket);
    }
    for (const previousProfile of previous.profiles) {
        const profile = { ...previousProfile, alignment };
        const pristine = resetFlags ? previousProfile._pristineFlags : previousProfile;
        for (const name of ['internalSegments', 'collarInternalSegments',
            'sharedRetainingWallSegments']) {
            if (pristine[name]) {
                profile[name] = yield* mapRailPreparationSteps(
                    pristine[name], value => value, 'flags',
                );
            } else delete profile[name];
        }
        if (pristine.roadOpeningSegmentRanges) {
            profile.roadOpeningSegmentRanges = [];
            for (const ranges of pristine.roadOpeningSegmentRanges) {
                profile.roadOpeningSegmentRanges.push(yield* mapRailPreparationSteps(
                    ranges || [], range => [...range], 'openings',
                ));
                if (slice.expired()) {
                    yield { phase: 'openings' };
                    slice.restart();
                }
            }
        } else delete profile.roadOpeningSegmentRanges;
        profile.railContextApron = pristine.railContextApron;
        alignment.profiles.push(profile);
        yield { phase: 'profile' };
    }
    alignment.profile = alignment.profiles[previous.profiles.indexOf(previous.profile)];
    alignment.stationAccessPlans = yield* mapRailPreparationSteps(
        previous.stationAccessPlans || [], plan => ({ ...plan, alignment }), 'access',
    );
    const previousEffects = previous._assemblyEffects;
    const effects = { ...previousEffects, stationAccessPlans: alignment.stationAccessPlans };
    for (const name of ['viaductRuns', 'tunnelRuns']) {
        effects[name] = [];
        for (const run of previousEffects[name]) {
            effects[name].push({ ...run, alignment, segments: yield* mapRailPreparationSteps(
                run.segments, segment => segmentCopies.get(segment), 'runs',
            ) });
            yield { phase: 'run' };
        }
    }
    alignment._assemblyEffects = effects;
    return alignment;
}

function publishedCivilStructure(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'tunnel') return 'tunnel';
    if (normalized === 'viaduct' || normalized === 'bridge') return 'viaduct';
    if (['formation', 'at-grade', 'cut', 'fill', 'embankment'].includes(normalized)) {
        return 'formation';
    }
    return null;
}

function normalizedRailCivilRuns(feature) {
    return (Array.isArray(feature?.properties?.railCivilRuns)
        ? feature.properties.railCivilRuns : [])
        .map((run) => {
            const startM = finiteOrNull(run?.startM ?? run?.fromM ?? run?.dM0);
            const endM = finiteOrNull(run?.endM ?? run?.toM ?? run?.dM1);
            const structure = publishedCivilStructure(
                run?.structure ?? run?.regime ?? run?.expectedRegime ?? run?.type,
            );
            return startM !== null && endM !== null && endM > startM && structure
                ? { startM, endM, structure }
                : null;
        })
        .filter(Boolean)
        .sort((left, right) => left.startM - right.startM || left.endM - right.endM);
}

function civilStructureAt(runs, sourceStationM) {
    const station = finiteOrNull(sourceStationM);
    if (station === null) return null;
    for (let index = 0; index < runs.length; index++) {
        const run = runs[index];
        const isLast = index === runs.length - 1;
        if (station >= run.startM - 1e-6
            && (station < run.endM - 1e-6 || (isLast && station <= run.endM + 1e-6))) {
            return run.structure;
        }
    }
    return null;
}

function* densifyLocalLineSteps(coordinates, toLocal, sampleStepM, {
    sourceChainagesM = null,
    civilRuns = null,
} = {}) {
    const rawCoordinates = Array.isArray(coordinates) ? coordinates : [];
    const alignedChainages = Array.isArray(sourceChainagesM)
        && sourceChainagesM.length === rawCoordinates.length
        ? sourceChainagesM : null;
    const runs = Array.isArray(civilRuns) ? civilRuns : [];
    const civilBoundaries = [...new Set(runs.flatMap(run => [run.startM, run.endM]))]
        .sort((left, right) => left - right);
    const source = [];
    const slice = createRailPreparationSlice();
    for (let sourceIndex = 0; sourceIndex < rawCoordinates.length; sourceIndex++) {
        const coordinate = rawCoordinates[sourceIndex];
        if (finiteCoordinate(coordinate)) {
            const [lon, lat, elevation] = coordinate;
            const local = toLocal(Number(lon), Number(lat));
            const elevationM = Number(elevation);
            source.push({
                lon: Number(lon),
                lat: Number(lat),
                x: local.x,
                z: local.z,
                elevationM: Number.isFinite(elevationM) ? elevationM : null,
                sourceStationM: alignedChainages
                    ? finiteOrNull(alignedChainages[sourceIndex]) : null,
            });
        }
        if (slice.expired()) {
            yield { phase: 'coordinates' };
            slice.restart();
        }
    }
    if (source.length < 2) return [];
    const samples = [];
    let station = 0;
    for (let index = 0; index < source.length - 1; index++) {
        if (slice.expired()) {
            yield { phase: 'densify' };
            slice.restart();
        }
        const from = source[index];
        const to = source[index + 1];
        const length = Math.hypot(to.x - from.x, to.z - from.z);
        if (length < 0.01) continue;
        const steps = Math.max(1, Math.ceil(length / sampleStepM));
        if (samples.length === 0) {
            samples.push({ ...from, station, incomingCivilStructure: null });
        }
        const fractions = [];
        for (let step = 1; step <= steps; step++) {
            fractions.push(step / steps);
            if (slice.expired()) {
                yield { phase: 'densify' };
                slice.restart();
            }
        }
        const sourceSpanM = from.sourceStationM !== null && to.sourceStationM !== null
            ? to.sourceStationM - from.sourceStationM
            : null;
        if (sourceSpanM !== null && Math.abs(sourceSpanM) > 1e-9) {
            for (const boundaryM of civilBoundaries) {
                const t = (boundaryM - from.sourceStationM) / sourceSpanM;
                if (t > 1e-8 && t < 1 - 1e-8) fractions.push(t);
                if (slice.expired()) {
                    yield { phase: 'densify' };
                    slice.restart();
                }
            }
        }
        fractions.sort((left, right) => left - right);
        let previousT = 0;
        for (let fractionIndex = 0; fractionIndex < fractions.length; fractionIndex++) {
            if (slice.expired()) {
                yield { phase: 'densify' };
                slice.restart();
            }
            const t = fractions[fractionIndex];
            if (fractionIndex > 0 && Math.abs(t - fractions[fractionIndex - 1]) <= 1e-8) continue;
            const sourceStationM = sourceSpanM === null
                ? null
                : from.sourceStationM + sourceSpanM * t;
            const midpointSourceStationM = sourceSpanM === null
                ? null
                : from.sourceStationM + sourceSpanM * ((previousT + t) * 0.5);
            samples.push({
                lon: from.lon + (to.lon - from.lon) * t,
                lat: from.lat + (to.lat - from.lat) * t,
                x: from.x + (to.x - from.x) * t,
                z: from.z + (to.z - from.z) * t,
                elevationM: Number.isFinite(from.elevationM) && Number.isFinite(to.elevationM)
                    ? from.elevationM + (to.elevationM - from.elevationM) * t
                    : null,
                station: station + length * t,
                sourceStationM,
                incomingCivilStructure: civilStructureAt(runs, midpointSourceStationM),
            });
            previousT = t;
        }
        station += length;
    }
    return samples;
}

function* limitGradesSteps(values, stations, maxGrade, startY, endY) {
    const limited = yield* mapRailPreparationSteps(values, value => value, 'grade');
    const slice = createRailPreparationSlice();
    if (limited.length < 2) return limited;
    const lastIndex = limited.length - 1;
    const fullLength = Math.max(0.01, stations[lastIndex] - stations[0]);
    const fixedStartY = Number.isFinite(startY) ? startY : limited[0];
    const requestedEndY = Number.isFinite(endY) ? endY : limited[lastIndex];
    const fixedEndY = clamp(
        requestedEndY,
        fixedStartY - maxGrade * fullLength,
        fixedStartY + maxGrade * fullLength,
    );
    limited[0] = fixedStartY;
    limited[lastIndex] = fixedEndY;
    // Alternating forward/backward projections retain both terrain tie-ins
    // while satisfying the slope constraint between every interior sample.
    for (let pass = 0; pass < 64; pass++) {
        for (let index = 1; index < lastIndex; index++) {
            const rise = maxGrade * Math.max(0.01, stations[index] - stations[index - 1]);
            limited[index] = clamp(limited[index], limited[index - 1] - rise, limited[index - 1] + rise);
            if (slice.expired()) {
                yield { phase: 'grade' };
                slice.restart();
            }
        }
        for (let index = lastIndex - 1; index > 0; index--) {
            const rise = maxGrade * Math.max(0.01, stations[index + 1] - stations[index]);
            limited[index] = clamp(limited[index], limited[index + 1] - rise, limited[index + 1] + rise);
            if (slice.expired()) {
                yield { phase: 'grade' };
                slice.restart();
            }
        }
        limited[0] = fixedStartY;
        limited[lastIndex] = fixedEndY;
    }
    return limited;
}

// Fill gaps in a terrain sample run by interpolating along station between the
// nearest known heights, holding flat beyond the first and last known sample.
// Returns null when nothing is known — an alignment with no ground under any of
// it cannot be designed, and must not be invented at the datum.
export function interpolateUnknownTerrain(samples) {
    return finishRailSteps(interpolateUnknownTerrainSteps(samples));
}

function* interpolateUnknownTerrainSteps(samples) {
    const list = Array.isArray(samples) ? samples : [];
    const knownIndices = [];
    const slice = createRailPreparationSlice();
    for (let index = 0; index < list.length; index++) {
        if (finiteOrNull(list[index]?.terrainY) !== null) knownIndices.push(index);
        if (slice.expired()) {
            yield { phase: 'interpolate' };
            slice.restart();
        }
    }
    if (knownIndices.length === 0) return null;
    let nextKnownIndex = 0;
    return yield* mapRailPreparationSteps(list, (sample, index) => {
        // Known indices are ordered even when a caller supplies non-monotonic
        // stations. Advance once instead of rescanning every preceding sample.
        while (nextKnownIndex < knownIndices.length && knownIndices[nextKnownIndex] < index) {
            nextKnownIndex += 1;
        }
        if (finiteOrNull(sample?.terrainY) !== null) return { ...sample };
        const before = knownIndices[nextKnownIndex - 1] ?? null;
        const after = knownIndices[nextKnownIndex] ?? null;
        // Outside the known span, hold the nearest measured height rather than
        // extrapolating a trend off the end of the data.
        if (before === null) return { ...sample, terrainY: list[after].terrainY };
        if (after === null) return { ...sample, terrainY: list[before].terrainY };
        const span = list[after].station - list[before].station;
        const t = span > 0 ? (sample.station - list[before].station) / span : 0;
        return {
            ...sample,
            terrainY: list[before].terrainY + (list[after].terrainY - list[before].terrainY) * t,
        };
    }, 'interpolate');
}

// Limit neighbourhood scans on the ordered chainage axis. Keep candidates in
// their original order so floating-point summation and the solved heights do
// not change. Unordered inputs still use the same distance predicate below.
function railProfileWindow(samples, station, radius, ordered) {
    if (!ordered) return [0, samples.length];
    let low = 0; let high = samples.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (station - samples[middle].station > radius) low = middle + 1;
        else high = middle;
    }
    const start = low;
    high = samples.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (samples[middle].station - station <= radius) low = middle + 1;
        else high = middle;
    }
    return [start, low];
}

// Turns raw DTM samples into a railway-scale vertical alignment. A short
// rolling median rejects individual 20 m DTM spikes, the broad weighted pass
// removes local undulation, and the final projection enforces maximum grade.
export function designRailVerticalProfile(samples, options = {}) {
    return finishRailSteps(designRailVerticalProfileSteps(samples, options));
}

export function* designRailVerticalProfileSteps(samples, {
    denoiseRadiusM = DEFAULT_DENOISE_RADIUS_M,
    smoothingRadiusM = DEFAULT_SMOOTHING_RADIUS_M,
    maxGrade = DEFAULT_MAX_GRADE,
    cutAvoidanceRatio = 0,
} = {}) {
    const raw = yield* mapRailPreparationSteps(samples || [], (sample, index) => ({
        station: finiteOrNull(sample?.station) ?? index,
        terrainY: finiteOrNull(sample?.terrainY),
    }), 'normalize');
    // A hole in the DEM is bridged from the ground either side of it, NOT read as
    // sea level. Substituting 0 dragged the designed rail down to the datum and
    // then back up, which read downstream as tens of metres of fill — a viaduct
    // conjured out of missing data. If nothing at all is known, there is no
    // alignment to design and the caller must skip the feature.
    const safe = yield* interpolateUnknownTerrainSteps(raw);
    if (!safe) return null;
    if (safe.length < 2) return safe.map((sample) => sample.terrainY);
    const denoiseRadius = Math.max(0, Number(denoiseRadiusM) || 0);
    const smoothRadius = Math.max(1, Number(smoothingRadiusM) || DEFAULT_SMOOTHING_RADIUS_M);
    const grade = Math.max(0.001, Number(maxGrade) || DEFAULT_MAX_GRADE);
    const slice = createRailPreparationSlice();
    let ordered = true;
    for (let index = 1; index < safe.length; index++) {
        if (safe[index].station < safe[index - 1].station) ordered = false;
        if (slice.expired()) {
            yield { phase: 'normalize' };
            slice.restart();
        }
    }
    const denoised = [];
    for (const sample of safe) {
        const [start, end] = railProfileWindow(safe, sample.station, denoiseRadius, ordered);
        const values = [];
        for (let index = start; index < end; index++) {
            if (Math.abs(safe[index].station - sample.station) <= denoiseRadius) {
                values.push(safe[index].terrainY);
            }
            if (slice.expired()) {
                yield { phase: 'denoise' };
                slice.restart();
            }
        }
        denoised.push(median(values));
        if (slice.expired()) {
            yield { phase: 'denoise' };
            slice.restart();
        }
    }
    const smoothed = [];
    for (const sample of safe) {
        let weightedY = 0;
        let weightSum = 0;
        const [start, end] = railProfileWindow(safe, sample.station, smoothRadius, ordered);
        for (let index = start; index < end; index++) {
            const distance = Math.abs(safe[index].station - sample.station);
            if (distance <= smoothRadius) {
                const weight = 1 - distance / smoothRadius;
                weightedY += denoised[index] * weight;
                weightSum += weight;
            }
            if (slice.expired()) {
                yield { phase: 'smooth' };
                slice.restart();
            }
        }
        smoothed.push(weightSum > 1e-9 ? weightedY / weightSum : sample.terrainY);
    }
    // An inferred existing railway should normally add a modest amount of
    // ballast/fill rather than shave a trench through every positive DTM
    // ripple. Move only the below-ground side toward the denoised surface;
    // already-elevated spans are untouched. Authored profiles leave this at 0.
    const cutAvoidance = Math.max(0, Math.min(1, Number(cutAvoidanceRatio) || 0));
    const biased = yield* mapRailPreparationSteps(smoothed, (value, index) => denoised[index] > value
        ? value + (denoised[index] - value) * cutAvoidance
        : value, 'ease');
    const locallyEased = yield* mapRailPreparationSteps(biased, (value, index) => {
        if (index === 0 || index === biased.length - 1) return value;
        return biased[index - 1] * 0.25 + value * 0.5 + biased[index + 1] * 0.25;
    }, 'ease');
    const stations = yield* mapRailPreparationSteps(safe, sample => sample.station, 'grade');
    return yield* limitGradesSteps(
        locallyEased,
        stations,
        grade,
        safe[0].terrainY,
        safe[safe.length - 1].terrainY,
    );
}

export function isEngineeredRailFeature(feature) {
    const properties = feature?.properties || {};
    // A companion rail inside an already-owned physical structure needs the
    // solved Z profile for rendering, but must not build a duplicate tunnel,
    // portal, cut or terrain mask of its own.
    if (properties.railFormationParticipation === 'visual-only') return false;
    return properties.terrainFormation === 'smooth-grade'
        || properties.source === 'cb-proposal'
        // Planner rides in the model world carry authored absolute (EVRF2000)
        // elevations — an engineered vertical alignment, so build its formation
        // (otherwise the rail is skipped and the cab drapes on the terrain).
        || hasAuthoredAbsoluteElevations(feature);
}

export function railMaxGradeForFeature(feature, fallback = DEFAULT_MAX_GRADE) {
    const railMode = String(
        feature?.properties?.railMode || feature?.properties?.trackType || '',
    ).trim().toLowerCase();
    if (railMode === 'tram') return TRAM_MAX_GRADE;
    if (railMode === 'train') return TRAIN_MAX_GRADE;
    const safeFallback = Number(fallback);
    return Number.isFinite(safeFallback) && safeFallback > 0
        ? safeFallback
        : DEFAULT_MAX_GRADE;
}

export function hasAuthoredAbsoluteElevations(feature) {
    const properties = feature?.properties || {};
    if (properties.elevationMode !== 'absolute' || properties.elevationDatum !== 'EVRF2000') {
        return false;
    }
    const coordinates = feature?.geometry?.coordinates;
    return Array.isArray(coordinates)
        && coordinates.length >= 2
        && coordinates.every((coordinate) => finiteOrNull(coordinate?.[2]) !== null);
}

// GROUND-RELATIVE authored elevations: coordinate[2] is metres above/below the
// terrain at that point, not an absolute height. This is what a rail proposal
// imported from a transit project carries (the prijevoz solution stored as
// per-point levels × 10 m — full precision, ground-relative), and the datum
// travels implicitly with the terrain: the formation seats terrain + offset,
// so the alignment reproduces the imported profile on whatever grid the
// session loads.
export function hasAuthoredGroundRelativeElevations(feature) {
    const properties = feature?.properties || {};
    if (properties.elevationMode !== 'ground-relative') return false;
    const coordinates = feature?.geometry?.coordinates;
    return Array.isArray(coordinates)
        && coordinates.length >= 2
        && coordinates.every((coordinate) => finiteOrNull(coordinate?.[2]) !== null);
}

function contiguousFlagRuns(flags, segments, value) {
    const runs = [];
    let start = -1;
    for (let index = 0; index <= flags.length; index++) {
        if (index < flags.length && flags[index] === value) {
            if (start < 0) start = index;
            continue;
        }
        if (start < 0) continue;
        let lengthM = 0;
        for (let runIndex = start; runIndex < index; runIndex++) {
            lengthM += Number(segments[runIndex]?.length) || 0;
        }
        runs.push({ start, end: index - 1, lengthM });
        start = -1;
    }
    return runs;
}

// A reconstruction of an EXISTING line, as opposed to an alignment somebody
// designed: the reference layer's spans (source 'reference-project') and the planner's
// own cab track when the open project is one of those reconstructions
// (alignmentSource). Deliberately narrower than isEngineeredRailFeature, which
// also covers cb-proposals and ordinary planner rides in absolute mode — those
// are authored, and a 60 m viaduct somebody drew on purpose must survive.
export function isReconstructedRailFeature(feature) {
    const properties = feature?.properties || {};
    return properties.source === 'reference-project'
        || properties.alignmentSource === 'reference-project';
}

// Length-weighted moving average of each segment's cover and fill over `windowM`
// of route. Returns CLASSIFICATION-ONLY copies: the segments keep their true
// extremes, because a portal headwall and a deck still have to be built to the
// ground that is actually there.
export function smoothedSegmentExtremes(segments, windowM) {
    const list = Array.isArray(segments) ? segments : [];
    const half = Math.max(0, Number(windowM) || 0) / 2;
    const lengths = list.map(segment => Math.max(0, Number(segment?.length) || 0));
    const mid = [];
    let at = 0;
    for (const length of lengths) { mid.push(at + length / 2); at += length; }
    // Unknown segments are EXCLUDED from the window rather than averaged in as
    // zero. Counting a hole as 0 m of fill drags a genuine viaduct's average
    // below the threshold and can erase a real structure — the mirror of the bug
    // that invented one. A window with nothing known at all stays unknown.
    const knownFill = list.map(segment => finiteOrNull(segment?.maxFillM));
    const knownCover = list.map(segment => finiteOrNull(segment?.maxCoverM));
    return list.map((segment, index) => {
        if (half <= 0) {
            return { length: lengths[index], maxFillM: knownFill[index], maxCoverM: knownCover[index] };
        }
        let fillWeight = 0;
        let coverWeight = 0;
        let fill = 0;
        let cover = 0;
        const accumulate = (other) => {
            const w = lengths[other] || 1e-6;
            if (knownFill[other] != null) { fillWeight += w; fill += w * knownFill[other]; }
            if (knownCover[other] != null) { coverWeight += w; cover += w * knownCover[other]; }
        };
        for (let other = index; other >= 0 && mid[index] - mid[other] <= half; other -= 1) accumulate(other);
        for (let other = index + 1; other < list.length && mid[other] - mid[index] <= half; other += 1) accumulate(other);
        return {
            length: lengths[index],
            maxFillM: fillWeight > 0 ? fill / fillWeight : null,
            maxCoverM: coverWeight > 0 ? cover / coverWeight : null,
        };
    });
}

// The larger of two per-sample extremes, or null if EITHER is unknown. Unknown
// is contagious on purpose: a segment with one end over a hole in the terrain
// has no honest fill or cover, and pretending otherwise is what this whole file
// now guards against.
export function knownExtreme(a, b) {
    const first = finiteOrNull(a);
    const second = finiteOrNull(b);
    if (first === null || second === null) return null;
    return Math.max(first, second);
}

// Convert tall fills to bridges with a little hysteresis: brief terrain
// crests do not chop one viaduct into many pieces, while isolated one-sample
// spikes do not create a forest of tiny bridge fragments.
export function classifyViaductSegments(segments, {
    thresholdM = DEFAULT_VIADUCT_FILL_THRESHOLD_M,
    minRunM = DEFAULT_VIADUCT_MIN_RUN_M,
    bridgeGapM = DEFAULT_VIADUCT_GAP_BRIDGE_M,
} = {}) {
    const threshold = Math.max(0.5, Number(thresholdM) || DEFAULT_VIADUCT_FILL_THRESHOLD_M);
    // Explicitly Number.isFinite, not a bare `>=`: `Number(null)` is 0, so an
    // unknown fill would silently answer "not a viaduct" by arithmetic accident
    // rather than by decision, and the next person to touch this line would have
    // no way to know the absence was being handled at all.
    const flags = (segments || []).map((segment) => {
        const fill = finiteOrNull(segment?.maxFillM);
        return fill !== null && fill >= threshold;
    });
    for (const run of contiguousFlagRuns(flags, segments, false)) {
        const boundedByViaduct = run.start > 0
            && run.end < flags.length - 1
            && flags[run.start - 1]
            && flags[run.end + 1];
        if (boundedByViaduct && run.lengthM <= bridgeGapM) {
            for (let index = run.start; index <= run.end; index++) flags[index] = true;
        }
    }
    for (const run of contiguousFlagRuns(flags, segments, true)) {
        if (run.lengthM >= minRunM) continue;
        for (let index = run.start; index <= run.end; index++) flags[index] = false;
    }
    return flags;
}

// Mirror of classifyViaductSegments for tunnels: flag segments whose ground
// cover tops the threshold, bridge brief exposed gaps between two bored spans,
// and drop tunnel fragments too short to be worth a portal pair.
export function classifyTunnelSegments(segments, {
    thresholdM = DEFAULT_TUNNEL_COVER_THRESHOLD_M,
    minRunM = DEFAULT_TUNNEL_MIN_RUN_M,
    bridgeGapM = DEFAULT_TUNNEL_GAP_BRIDGE_M,
} = {}) {
    const threshold = Math.max(0.5, Number(thresholdM) || DEFAULT_TUNNEL_COVER_THRESHOLD_M)
        - TUNNEL_COVER_TOLERANCE_M;
    // Unknown cover is not a tunnel, for the same reason unknown fill is not a
    // viaduct. (This direction never fabricated structures the way fill did —
    // Math.min clamped it to 0 — but it must state the rule, not rely on that.)
    const flags = (segments || []).map((segment) => {
        const cover = finiteOrNull(segment?.maxCoverM);
        return cover !== null && cover >= threshold;
    });
    for (const run of contiguousFlagRuns(flags, segments, false)) {
        const boundedByTunnel = run.start > 0
            && run.end < flags.length - 1
            && flags[run.start - 1]
            && flags[run.end + 1];
        if (boundedByTunnel && run.lengthM <= bridgeGapM) {
            for (let index = run.start; index <= run.end; index++) flags[index] = true;
        }
    }
    for (const run of contiguousFlagRuns(flags, segments, true)) {
        if (run.lengthM >= minRunM) continue;
        for (let index = run.start; index <= run.end; index++) flags[index] = false;
    }
    return flags;
}

export class RailFormationModel {
    constructor({
        anchorLat,
        anchorLon,
        features = [],
        baseSceneYAtLocal,
        absoluteSceneYAtHeight,
        halfWidthForFeature = null,
        surfaceHalfWidthForFeature = null,
        sampleStepM = DEFAULT_SAMPLE_STEP_M,
        denoiseRadiusM = DEFAULT_DENOISE_RADIUS_M,
        smoothingRadiusM = DEFAULT_SMOOTHING_RADIUS_M,
        maxGrade = DEFAULT_MAX_GRADE,
        viaductFillThresholdM = DEFAULT_VIADUCT_FILL_THRESHOLD_M,
        stationAccessPlanner = null,
        crossSlopeBenchForInferred = false,
        // { previousModel, terrainChangedBounds, contextKey } — enables
        // per-feature assembly reuse. terrainChangedBounds must be an ARRAY
        // ([] = terrain unchanged); null disables reuse entirely. contextKey
        // fingerprints caller-side inputs the signature cannot see (stops fed
        // to the station access planner).
        assemblyReuse = null,
        deferredBuild = false,
        readInputs = null,
    }) {
        this.anchorLat = Number(anchorLat);
        this.anchorLon = Number(anchorLon);
        this.metresPerDegreeLat = DEG_TO_RAD * EARTH_RADIUS_M;
        this.metresPerDegreeLon = this.metresPerDegreeLat
            * Math.cos(this.anchorLat * DEG_TO_RAD);
        // No sampler is "we do not know the ground", not "the ground is at sea
        // level" — see _baseY.
        this.baseSceneYAtLocal = typeof baseSceneYAtLocal === 'function'
            ? baseSceneYAtLocal
            : (() => null);
        this.absoluteSceneYAtHeight = typeof absoluteSceneYAtHeight === 'function'
            ? absoluteSceneYAtHeight
            : ((heightM) => Number(heightM) || 0);
        this.halfWidthForFeature = typeof halfWidthForFeature === 'function'
            ? halfWidthForFeature
            : (() => DEFAULT_HALF_WIDTH_M);
        this.surfaceHalfWidthForFeature = typeof surfaceHalfWidthForFeature === 'function'
            ? surfaceHalfWidthForFeature
            : this.halfWidthForFeature;
        this.sampleStepM = Math.max(4, Number(sampleStepM) || DEFAULT_SAMPLE_STEP_M);
        this.profileOptions = { denoiseRadiusM, smoothingRadiusM, maxGrade };
        this.viaductFillThresholdM = Math.max(
            0.5,
            Number(viaductFillThresholdM) || DEFAULT_VIADUCT_FILL_THRESHOLD_M,
        );
        this.stationAccessPlanner = typeof stationAccessPlanner === 'function'
            ? stationAccessPlanner
            : null;
        this.crossSlopeBenchForInferred = crossSlopeBenchForInferred === true;
        this.alignments = [];
        this.segments = [];
        this.profiles = [];
        this.surfaceProfileIndex = new Map();
        this._civilGroundProfileChecks = 0;
        this.stationAccessPlans = [];
        this.viaductRuns = [];
        this.tunnelRuns = [];
        this.tunnelPortalTerrainOpenings = [];
        this.roadFormationStylesByOsmId = new Map();
        this.roadFormationInterfacesByOsmId = new Map();
        for (const feature of features || []) {
            for (const declaration of feature?.properties?.railRoadInterfaces || []) {
                const osmWayId = String(declaration?.osmWayId ?? '').trim();
                const style = String(declaration?.style ?? '').trim();
                if (!osmWayId || !style) continue;
                this.roadFormationStylesByOsmId.set(osmWayId, style);
                this.roadFormationInterfacesByOsmId.set(osmWayId, {
                    ...declaration,
                    osmWayId,
                    style,
                });
            }
        }
        this.alignmentByFeature = new WeakMap();
        this.revision = 0;
        this._assemblyReuse = assemblyReuse || null;
        // Only this generation's live features are retained. This is not a
        // history cache and never holds the previous model or its geometry.
        this._preparations = new Map();
        this._assemblyContextKey = [
            String(assemblyReuse?.contextKey ?? ''),
            this.sampleStepM,
            JSON.stringify(this.profileOptions),
            this.viaductFillThresholdM,
            this.crossSlopeBenchForInferred ? 1 : 0,
            this.anchorLat,
            this.anchorLon,
        ].join('|');
        this._readInputs = retainReadSnapshot(readInputs, 'rail-formation');
        this._disposed = false;
        this._buildIterator = null;
        try {
            if (deferredBuild === true) this._buildIterator = this._buildSteps(features);
            else {
                this._build(features);
                this._assemblyReuse = null;
            }
        } catch (error) {
            this.dispose();
            throw error;
        }
    }

    dispose() {
        if (this._disposed) return false;
        this._buildIterator?.return?.();
        this._buildIterator = null;
        this._assemblyReuse = null;
        this._readInputs?.release?.();
        this._readInputs = null;
        this._disposed = true;
        return true;
    }

    hasPendingBuild() {
        return this._buildIterator !== null;
    }

    stepPendingBuild() {
        if (this._disposed) throw new Error('Rail formation is disposed');
        if (!this._buildIterator) return { done: true, phase: 'done' };
        let outcome;
        try { outcome = this._buildIterator.next(); }
        catch (error) { this.dispose(); throw error; }
        if (outcome.done) {
            this._buildIterator = null;
            this._assemblyReuse = null;
            return { done: true, phase: 'finalize' };
        }
        return {
            done: false,
            phase: String(outcome.value?.phase || 'build'),
        };
    }

    // A query view contains compiled geometry and its CURRENT crossing flags,
    // unlike assembly reuse which resets flags for a fresh reconciliation.
    // No source/preparation caches or callbacks into live terrain are copied.
    *captureReadSnapshotSteps({ baseSceneYAtLocal, readInputs = this._readInputs } = {}) {
        return yield* this._copyCompiledGenerationSteps({ baseSceneYAtLocal, readInputs, immutable: true });
    }

    // Crossing ownership changes flags on a private compiled successor. The
    // alignment solve and immutable source geometry are reused; mutable profile
    // flags and query indexes belong exclusively to the successor. Its retained
    // terrain owner outlives disposal of the former active model.
    *forkCompiledGenerationSteps() {
        return yield* this._copyCompiledGenerationSteps({
            baseSceneYAtLocal: this.baseSceneYAtLocal, readInputs: this._readInputs, immutable: false,
        });
    }

    *_copyCompiledGenerationSteps({ baseSceneYAtLocal, readInputs, immutable }) {
        if (this._disposed) throw new Error('Rail formation is disposed');
        if (typeof baseSceneYAtLocal !== 'function') {
            throw new TypeError('Rail snapshot requires captured upstream ground');
        }
        if (this.hasPendingBuild()) throw new Error('Prepare the complete rail formation before capturing it');
        const inputs = retainReadSnapshot(readInputs, 'rail-formation-query');
        let handedOff = false;
        try {
            const revision = this.revision;
            const mutation = Number(this.civilGroundMutationRevision) || 0;
            const alignments = this.alignments;
            const query = {
                anchorLat: this.anchorLat, anchorLon: this.anchorLon,
                metresPerDegreeLat: this.metresPerDegreeLat, metresPerDegreeLon: this.metresPerDegreeLon,
                sampleStepM: this.sampleStepM, baseSceneYAtLocal,
                alignments: [], segments: [], profiles: [], stationAccessPlans: [],
                viaductRuns: [], tunnelRuns: [], tunnelPortalTerrainOpenings: [],
                alignmentByFeature: new WeakMap(), surfaceProfileIndex: new Map(),
                roadFormationStylesByOsmId: new Map(), roadFormationInterfacesByOsmId: new Map(),
                _civilGroundProfileChecks: 0,
            };
            const profiles = new Map();
            const slice = createRailPreparationSlice();
            for (const previous of alignments) {
                const alignment = yield* copyRailAlignmentGenerationSteps(previous, previous.feature, { resetFlags: false });
                query.alignments.push(alignment);
                query.alignmentByFeature.set(alignment.feature, alignment);
                for (let i = 0; i < alignment.profiles.length; i++) {
                    const profile = alignment.profiles[i];
                    profiles.set(previous.profiles[i], profile);
                    query.profiles.push(profile);
                    if (immutable) {
                        for (const name of ['internalSegments', 'collarInternalSegments', 'sharedRetainingWallSegments']) {
                            if (profile[name]) Object.freeze(profile[name]);
                        }
                        if (profile.roadOpeningSegmentRanges) {
                            for (const ranges of profile.roadOpeningSegmentRanges) {
                                for (const range of ranges) Object.freeze(range);
                                Object.freeze(ranges);
                            }
                            Object.freeze(profile.roadOpeningSegmentRanges);
                        }
                        Object.freeze(profile);
                    }
                    yield { phase: 'rail-query-profile' };
                }
                for (const segment of alignment.segments) {
                    query.segments.push(immutable ? Object.freeze(segment) : segment);
                    if (slice.expired()) { yield { phase: 'rail-query-segments' }; slice.restart(); }
                }
                for (const name of ['stationAccessPlans', 'viaductRuns', 'tunnelRuns', 'tunnelPortalTerrainOpenings']) {
                    for (const record of alignment._assemblyEffects[name]) {
                        query[name].push(record);
                        if (slice.expired()) { yield { phase: 'rail-query-effects' }; slice.restart(); }
                    }
                }
                if (immutable) {
                    Object.freeze(alignment.segments);
                    Object.freeze(alignment.profiles);
                    Object.freeze(alignment);
                }
                yield { phase: 'rail-query-alignment' };
            }
            for (const [key, members] of this.surfaceProfileIndex) {
                query.surfaceProfileIndex.set(key, yield* mapRailPreparationSteps(
                    members, profile => profiles.get(profile), 'rail-query-index',
                ));
                if (slice.expired()) { yield { phase: 'rail-query-index' }; slice.restart(); }
            }
            for (const name of ['roadFormationStylesByOsmId', 'roadFormationInterfacesByOsmId']) {
                for (const [key, value] of this[name]) {
                    query[name].set(key, typeof value === 'object' ? Object.freeze({ ...value }) : value);
                    if (slice.expired()) { yield { phase: 'rail-query-interfaces' }; slice.restart(); }
                }
            }
            if (this.hasPendingBuild() || this.alignments !== alignments || this.revision !== revision
                || (Number(this.civilGroundMutationRevision) || 0) !== mutation) {
                const error = new Error('Rail formation changed while capturing its query snapshot');
                error.code = 'rail-formation-snapshot-stale';
                throw error;
            }
            // A retained construction read can also supply a private ownership
            // fork. Copy the small source-cache table, never capture the live
            // model in that capability: its later flags/disposal are unrelated.
            Object.setPrototypeOf(query, RailFormationModel.prototype);
            for (const name of ['absoluteSceneYAtHeight', 'halfWidthForFeature', 'surfaceHalfWidthForFeature',
                'profileOptions', 'viaductFillThresholdM', 'stationAccessPlanner', 'crossSlopeBenchForInferred',
                '_assemblyContextKey']) query[name] = this[name];
            query._preparations = new Map();
            for (const [key, value] of this._preparations) {
                query._preparations.set(key, value);
                if (slice.expired()) { yield { phase: 'rail-query-preparations' }; slice.restart(); }
            }
            if (this._disposed || this.alignments !== alignments || this.revision !== revision
                || (Number(this.civilGroundMutationRevision) || 0) !== mutation) {
                const error = new Error('Rail formation changed while forking its compiled generation');
                error.code = 'rail-formation-snapshot-stale'; throw error;
            }
            Object.assign(query, { revision, civilGroundMutationRevision: mutation, _disposed: false,
                _readInputs: inputs, _buildIterator: null, _assemblyReuse: null, buildTimings: {} });
            if (!immutable) {
                handedOff = true;
                return query;
            }
            const result = { contract: 'station3d-rail-formation-read-snapshot-v1', revision,
                civilGroundMutationRevision: mutation, hasPendingBuild: () => false,
                forkCompiledGenerationSteps: () => query.forkCompiledGenerationSteps() };
            for (const name of ['alignments', 'segments', 'profiles', 'stationAccessPlans',
                'viaductRuns', 'tunnelRuns', 'tunnelPortalTerrainOpenings']) {
                result[name] = Object.freeze(query[name]);
            }
            for (const name of ['toLocal', '_baseY', '_nearestOnAlignments', '_railYAtStation',
                'formationAtLocal', 'sceneYAtLocal', 'sceneYForFeatureAtLocal', 'formationAtFeatureStation',
                'slopeAlongHeadingDegAtLocal', 'gradeAlongHeadingForFormation', 'gradeAlongHeadingAtLocal',
                'getSurfaceProfiles', 'getSurfaceProfilesAtLocal', 'dressingProfilesNear', 'roadFormationStyleForOsmId', 'getRoadFormationInterfaces',
                'retainedBoundaryForRoadInterfaceAtLocal', 'getSurfaceStationAccessPlans', 'surfaceProfileAtLocal',
                'civilGroundSceneYAtLocal', 'isOpenCutAtLocal', 'coverAtLocal', 'getViaductRuns', 'getTunnelRuns',
                'getTunnelPortalTerrainOpenings', 'tunnelRoofInfoAt']) {
                query[name] = RailFormationModel.prototype[name].bind(query);
                if (!name.startsWith('_')) result[name] = query[name];
            }
            handedOff = true;
            return ownReadSnapshot(result, [inputs]);
        } finally {
            if (!handedOff) inputs?.release?.();
        }
    }

    toLocal(lon, lat) {
        return {
            x: (Number(lon) - this.anchorLon) * this.metresPerDegreeLon,
            z: -(Number(lat) - this.anchorLat) * this.metresPerDegreeLat,
        };
    }

    // Ground height, or NULL where the terrain is not known — a tile that has not
    // streamed in yet, or one the API failed to serve.
    //
    // This used to return 0 for an absent sample, which is the single most
    // expensive class of bug in this codebase: it turns "no data" into a real,
    // plausible-looking number. Downstream, `maxFillM = railY - 0` made every
    // sample without terrain read as a fill of the rail's full height above sea
    // level, and anything over DEFAULT_VIADUCT_FILL_THRESHOLD_M (3.5 m)
    // classifies as viaduct. In Split, where the line sits ~30 m ASL, a terrain
    // hole therefore grew a 30 m viaduct out of nothing — and because the fill is
    // a Math.max, a missing sample could only ever push TOWARD a structure, never
    // away from one. Returning null makes the absence survive to the classifier,
    // which now declines to call it anything.
    _baseY(x, z) {
        return finiteOrNull(this.baseSceneYAtLocal(x, z));
    }

    *_designExplicitOsmStructureProfileSteps(samples, feature) {
        const structure = feature?.properties?.railStructure;
        if (!['viaduct', 'tunnel'].includes(structure) || samples.length < 2) return null;
        const first = samples[0];
        const second = samples[1];
        const last = samples[samples.length - 1];
        const penultimate = samples[samples.length - 2];
        const startLength = Math.hypot(first.x - second.x, first.z - second.z);
        const endLength = Math.hypot(last.x - penultimate.x, last.z - penultimate.z);
        if (startLength < 0.01 || endLength < 0.01) return null;
        const startOutward = {
            x: (first.x - second.x) / startLength,
            z: (first.z - second.z) / startLength,
        };
        const endOutward = {
            x: (last.x - penultimate.x) / endLength,
            z: (last.z - penultimate.z) / endLength,
        };
        const before = [];
        const after = [];
        const slice = createRailPreparationSlice(PREPARATION_SLICE_MAX_TERRAIN_SAMPLES);
        const contextSteps = Math.ceil(OSM_STRUCTURE_PROFILE_CONTEXT_M / this.sampleStepM);
        for (let step = contextSteps; step >= 1; step--) {
            const distance = step * this.sampleStepM;
            const x = first.x + startOutward.x * distance;
            const z = first.z + startOutward.z * distance;
            before.push({ station: -distance, terrainY: this._baseY(x, z) });
            if (slice.expired()) {
                yield { phase: 'structureTerrain' };
                slice.restart();
            }
        }
        for (let step = 1; step <= contextSteps; step++) {
            const distance = step * this.sampleStepM;
            const x = last.x + endOutward.x * distance;
            const z = last.z + endOutward.z * distance;
            after.push({ station: last.station + distance, terrainY: this._baseY(x, z) });
            if (slice.expired()) {
                yield { phase: 'structureTerrain' };
                slice.restart();
            }
        }
        // DGU is a surface model. At a missing bridge it sees the road below;
        // at a tunnel it sees the hill above. Neither is rail-level evidence
        // inside the explicitly mapped structure, so bridge between the two
        // measured approaches instead of pulling the rail onto that surface.
        const combined = yield* mapRailPreparationSteps(samples,
            sample => ({ station: sample.station, terrainY: null }), 'structureProfile');
        combined.unshift(...before);
        combined.push(...after);
        const designed = yield* designRailVerticalProfileSteps(combined, {
            ...this.profileOptions,
            maxGrade: railMaxGradeForFeature(feature, this.profileOptions.maxGrade),
            cutAvoidanceRatio: OSM_CUT_AVOIDANCE_RATIO,
        });
        return designed?.slice(before.length, before.length + samples.length) || null;
    }

    // stationRange [fromM, toM] restricts candidates to segments overlapping
    // that span of the alignment. A self-crossing (spiral) alignment holds
    // both passes of its crossing, and a caller resolving heights for ONE
    // known run (an earthworks collar, a portal face) must not be answered by
    // the OTHER pass just because it is centimetres nearer in plan.
    // referenceY: the height the caller expects here (a moving cab knows the rail
    // height it is already at). It does NOT change the metric — selection stays
    // plan-nearest, which is smooth and monotonic in station as the cab advances,
    // so a graded single track has no per-segment wobble — it only GATES OUT
    // candidates whose rail sits more than REFERENCE_Y_GATE_M from that height.
    // That is what disambiguates a PLAN crossing (a tunnel track passing under a
    // crossing track): the crossing track is a level away, so it is excluded and
    // the plan-nearest of what remains is the level being ridden. On ordinary
    // single track the ridden rail is always within the gate, so nothing is
    // excluded and the result is byte-for-byte a plain plan-nearest query. The
    // gate FAILS OPEN: if it would leave no candidate (a stale referenceY just
    // after a seek), the ungated plan-nearest is returned, so the height can
    // recover instead of locking onto the terrain fallback.
    _nearestOnAlignments(x, z, alignments, {
        maxDistanceM = DEFAULT_QUERY_RADIUS_M,
        requireSurface = false,
        stationRange = null,
        referenceY = null,
    } = {}) {
        const requestedRadius = Number(maxDistanceM);
        const queryRadius = Number.isFinite(requestedRadius)
            ? Math.max(0, requestedRadius)
            : Math.max(DEFAULT_QUERY_RADIUS_M, this.sampleStepM * 2);
        const radiusSquared = queryRadius ** 2;
        const useReferenceY = Number.isFinite(referenceY);
        const buildFormation = (projected, railY, segment, alignment) => {
            const startStation = segment.alignment.samples[segment.startSampleIndex].station;
            const endStation = segment.alignment.samples[segment.endSampleIndex].station;
            return {
                ...projected,
                railY,
                stationM: segment.alignment.routeStartStationM
                    + startStation
                    + (endStation - startStation) * projected.t,
                grade: segment.grade,
                structure: segment.structure || 'formation',
                alignment,
                segment,
            };
        };
        let best = null;                              // plan-nearest within the gate
        let bestDistanceSquared = radiusSquared;
        let fallback = null;                          // plan-nearest ignoring the gate
        let fallbackDistanceSquared = radiusSquared;
        for (const alignment of alignments || []) {
            for (const segment of alignmentSegmentsNear(alignment, x, z, queryRadius)) {
                if (stationRange) {
                    const spanStart = segment.alignment.samples[segment.startSampleIndex].station;
                    const spanEnd = segment.alignment.samples[segment.endSampleIndex].station;
                    if (spanEnd < stationRange[0] - 1e-6 || spanStart > stationRange[1] + 1e-6) continue;
                }
                const projected = projectPointToSegment(x, z, segment);
                if (!projected || projected.distanceSquared > radiusSquared) continue;
                if (requireSurface
                    && projected.distanceSquared > (alignment.halfWidthM + 0.05) ** 2) continue;
                const railY = segment.y1 + (segment.y2 - segment.y1) * projected.t;
                if (projected.distanceSquared < fallbackDistanceSquared) {
                    fallbackDistanceSquared = projected.distanceSquared;
                    fallback = buildFormation(projected, railY, segment, alignment);
                }
                if (useReferenceY && Math.abs(railY - referenceY) > REFERENCE_Y_GATE_M) continue;
                if (projected.distanceSquared < bestDistanceSquared) {
                    bestDistanceSquared = projected.distanceSquared;
                    best = buildFormation(projected, railY, segment, alignment);
                }
            }
        }
        return best || fallback;
    }

    formationAtLocal(x, z, {
        feature = null,
        maxDistanceM = DEFAULT_QUERY_RADIUS_M,
        requireSurface = false,
        referenceY = null,
    } = {}) {
        const alignment = feature && this.alignmentByFeature.get(feature);
        if (feature && !alignment) return null;
        return this._nearestOnAlignments(
            Number(x),
            Number(z),
            alignment ? [alignment] : this.alignments,
            { maxDistanceM, requireSurface, referenceY },
        );
    }

    // Rail height where there is a formation, else the ground — or NULL when the
    // ground is not known there. Callers must have their own answer for "no
    // terrain yet"; the one thing this must not do is answer 0, which puts the
    // caller at sea level with no way to tell that it was a guess.
    sceneYAtLocal(x, z, options = {}) {
        const formation = this.formationAtLocal(x, z, options);
        return formation ? formation.railY : this._baseY(x, z);
    }

    sceneYForFeatureAtLocal(feature, x, z) {
        const formation = this.formationAtLocal(x, z, {
            feature,
            maxDistanceM: Infinity,
        });
        return formation ? formation.railY : this._baseY(x, z);
    }

    // Formation on ONE feature's alignment addressed by STATION (metres along
    // the feature), not by plan position. On a self-crossing (spiral/loop)
    // alignment the plan-nearest query is ambiguous at the crossing — both
    // passes occupy the same plan point, so nearest-by-distance can seat a
    // chord on the OTHER pass and stretch its deck into a vertical curtain
    // between the two levels. Station is unambiguous by construction; any
    // caller walking a feature in order (rails.js chords) must resolve here.
    // Returns null when the feature has no alignment (no terrain yet) so the
    // caller keeps its usual fallback.
    formationAtFeatureStation(feature, stationM) {
        const alignment = feature ? this.alignmentByFeature.get(feature) : null;
        const samples = alignment?.samples;
        const segments = alignment?.segments;
        if (!samples?.length || !segments?.length) return null;
        const station = Number(stationM);
        if (!Number.isFinite(station)) return null;
        const railY = this._railYAtStation(alignment, station);
        if (railY == null) return null;
        // Segment under the station (clamped to the ends) for its structure tag.
        let low = 0;
        let high = segments.length - 1;
        while (high - low > 1) {
            const mid = (low + high) >> 1;
            if (samples[segments[mid].startSampleIndex].station <= station) low = mid;
            else high = mid;
        }
        const segment = samples[segments[high].startSampleIndex].station <= station
            ? segments[high]
            : segments[low];
        return {
            railY,
            structure: segment.structure || 'formation',
            grade: segment.grade,
            alignment,
            segment,
            stationM: alignment.routeStartStationM + station,
        };
    }

    slopeAlongHeadingDegAtLocal(x, z, headingDeg) {
        const grade = this.gradeAlongHeadingAtLocal(x, z, headingDeg);
        return grade == null ? null : Math.atan(grade) / DEG_TO_RAD;
    }

    // Rail height at a station along one alignment, interpolated between samples.
    // Continuous in station, which is what makes the chord grade below continuous
    // rather than a step per vertex.
    _railYAtStation(alignment, station) {
        const samples = alignment?.samples;
        if (!Array.isArray(samples) || samples.length === 0) return null;
        const first = samples[0].station;
        const last = samples[samples.length - 1].station;
        if (!(Number.isFinite(first) && Number.isFinite(last))) return null;
        if (station <= first) return samples[0].railY;
        if (station >= last) return samples[samples.length - 1].railY;
        let low = 0;
        let high = samples.length - 1;
        while (high - low > 1) {
            const mid = (low + high) >> 1;
            if (samples[mid].station <= station) low = mid;
            else high = mid;
        }
        const a = samples[low];
        const b = samples[high];
        const span = b.station - a.station;
        if (!(span > 0)) return a.railY;
        const t = (station - a.station) / span;
        return a.railY + (b.railY - a.railY) * t;
    }

    // The grade the driver's gaze and the HUD should follow.
    //
    // This used to return the SEGMENT grade, dy over the length of one densified
    // sample step. densifyLocalLine only ever SUBDIVIDES, so wherever the source
    // polyline already had nodes closer than sampleStepM the segment kept its
    // original short length — around 8 m on a reconstruction. Grade over 8 m of
    // centimetre-quantised elevation is a couple of per mille of pure
    // quantisation, and being per-segment it was also a step function: the value
    // jumped at every vertex, roughly twice a second at line speed. That is the
    // readout flicking between -1% and 0% within ten metres, and, through the
    // gaze pitch, a horizon that bobbed 22 px peak-to-peak with about two
    // direction changes a second.
    //
    // A 40 m chord centred on the point is long enough for the data to mean
    // something and, because it interpolates, continuous — so the grade now
    // changes gradually, as a real vertical alignment does.
    gradeAlongHeadingForFormation(formation, headingDeg, chordM = GRADE_CHORD_M) {
        if (!formation) return null;
        const heading = Number(headingDeg) * DEG_TO_RAD;
        if (!Number.isFinite(heading)) return 0;
        const forwardX = Math.sin(heading);
        const forwardZ = -Math.cos(heading);
        const segment = formation.segment;
        const direction = segment.ux * forwardX + segment.uz * forwardZ >= 0 ? 1 : -1;
        const alignment = formation.alignment;
        const samples = alignment?.samples;
        const chord = Math.max(4, Number(chordM) || GRADE_CHORD_M);
        if (Array.isArray(samples) && samples.length > 1) {
            const first = samples[0].station;
            const last = samples[samples.length - 1].station;
            const here = Number(formation.stationM) - Number(alignment.routeStartStationM || 0);
            if (Number.isFinite(first) && Number.isFinite(last) && Number.isFinite(here)) {
                // Both arms shortened equally near the ends: an arm that runs out
                // while the other is full measures the same jitter the segment
                // grade did, only over a longer lever.
                const arm = Math.min(chord / 2, here - first, last - here);
                if (arm >= 2) {
                    const back = this._railYAtStation(alignment, here - arm);
                    const forward = this._railYAtStation(alignment, here + arm);
                    if (Number.isFinite(back) && Number.isFinite(forward)) {
                        return ((forward - back) / (arm * 2)) * direction;
                    }
                }
            }
        }
        // Alignment too short to span a chord — one segment is all there is.
        return formation.grade * direction;
    }

    gradeAlongHeadingAtLocal(x, z, headingDeg) {
        const formation = this.formationAtLocal(x, z);
        return this.gradeAlongHeadingForFormation(formation, headingDeg);
    }

    getSurfaceProfiles() {
        return this.profiles;
    }

    getSurfaceProfilesAtLocal(x, z) {
        const localX = finiteOrNull(x);
        const localZ = finiteOrNull(z);
        if (localX === null || localZ === null) return [];
        return indexedRailSurfaceProfilesAt(this.surfaceProfileIndex, localX, localZ);
    }

    // Profiles whose civil dressing (overlap/cut-out/outer ring) can reach a
    // disc. Collider bubbles use this instead of every profile in the model:
    // a single long corridor otherwise generated its whole wall and collar.
    dressingProfilesNear(x, z, radiusM) {
        const localX = finiteOrNull(x);
        const localZ = finiteOrNull(z);
        const radius = finiteOrNull(radiusM);
        if (localX === null || localZ === null || radius === null || radius < 0) return [];
        return indexedRailSurfaceProfilesNear(this.surfaceProfileIndex, localX, localZ, radius);
    }

    // A reviewed rail/road interface is civil-design evidence, not a render
    // ordering hint. Roads query it by stable OSM identity so their own later
    // formation can consume the retained railway block deterministically.
    roadFormationStyleForOsmId(osmId) {
        return this.roadFormationStylesByOsmId.get(String(osmId ?? '').trim()) || null;
    }

    getRoadFormationInterfaces() {
        return Array.from(this.roadFormationInterfacesByOsmId.values());
    }

    // A declared parallel road and the retained rail approach must meet at one
    // wall plane, not build two independently sampled faces a few decimetres
    // apart. Roads ask with their provisional outer-wall point. Snap only to
    // the declared side of a vertical rail section and only within a tight
    // civil-seam tolerance, so ordinary nearby streets remain untouched.
    retainedBoundaryForRoadInterfaceAtLocal(
        osmId,
        x,
        z,
        {
            maxDistanceM = 1.25,
            innerX = null,
            innerZ = null,
        } = {},
    ) {
        const declaration = this.roadFormationInterfacesByOsmId.get(
            String(osmId ?? '').trim(),
        );
        if (!declaration || declaration.style !== 'vertical-retained') return null;
        const localX = finiteOrNull(x);
        const localZ = finiteOrNull(z);
        if (localX === null || localZ === null) return null;
        // Adjacent OSM road polygons share the same paved-edge vertex but
        // derive different mitred provisional outer points. Projecting those
        // outer points independently makes the two wall runs overlap or leave
        // a slit at the way boundary. Use the shared inner vertex as the
        // longitudinal station whenever the caller supplies it; x/z still
        // provide a backwards-compatible fallback for older consumers.
        const queryX = finiteOrNull(innerX) ?? localX;
        const queryZ = finiteOrNull(innerZ) ?? localZ;
        const side = String(
            declaration.railBoundarySide || 'positive-normal',
        ).trim();
        const limitM = Math.max(
            0,
            finiteOrNull(declaration.boundarySnapDistanceM)
                ?? finiteOrNull(maxDistanceM)
                ?? 1.25,
        );
        const continuationM = Math.max(
            0,
            finiteOrNull(declaration.boundaryContinuationM) || 0,
        );
        let best = null;
        for (const profile of this.profiles) {
            if (!profile?.verticalRetainedWalls) continue;
            const points = profile.points || [];
            const tags = profile.boundarySegmentTags || [];
            for (let index = 0; index < points.length; index++) {
                if (tags[index] !== side) continue;
                const a = points[index];
                const b = points[(index + 1) % points.length];
                const previousIndex = (index - 1 + points.length) % points.length;
                const nextIndex = (index + 1) % points.length;
                const capIsOpen = capIndex => (
                    (tags[capIndex] === 'start' || tags[capIndex] === 'end')
                    && profile.internalSegments?.[capIndex] === true
                );
                const projected = projectPointToSegmentWithEndExtensions(
                    queryX,
                    queryZ,
                    {
                    x1: a.outerX,
                    z1: a.outerZ,
                    x2: b.outerX,
                    z2: b.outerZ,
                    },
                    {
                        extendStartM: continuationM > 0 && capIsOpen(previousIndex)
                            ? continuationM : 0,
                        extendEndM: continuationM > 0 && capIsOpen(nextIndex)
                            ? continuationM : 0,
                    },
                );
                if (!projected || projected.distanceSquared > limitM * limitM
                    || (best && projected.distanceSquared >= best.distanceSquared)) {
                    continue;
                }
                best = {
                    x: projected.x,
                    z: projected.z,
                    distanceSquared: projected.distanceSquared,
                    sharedRailRetainingBoundary: true,
                    railFormationId: profile.formationId || null,
                    railBoundarySide: side,
                    railSegmentIndex: index,
                    retainedBaseY: Number(a.roadY)
                        + (Number(b.roadY) - Number(a.roadY)) * projected.t,
                    railBoundaryContinuation: projected.t < 0 || projected.t > 1,
                };
            }
        }
        return best;
    }

    getSurfaceStationAccessPlans() {
        return this.stationAccessPlans;
    }

    surfaceProfileAtLocal(x, z) {
        const px = Number(x);
        const pz = Number(z);
        if (!Number.isFinite(px) || !Number.isFinite(pz)) return null;
        for (const profile of indexedRailSurfaceProfilesAt(
            this.surfaceProfileIndex,
            px,
            pz,
        )) {
            // Pedestrian safety follows the actual terrain mask, not merely the
            // level trackbed ring: a station stair rides across the retained
            // batter and collar between those two boundaries.
            const hasTerrainCutoutRing = Array.isArray(profile.terrainCutoutRing)
                && profile.terrainCutoutRing.length >= 3;
            const ring = hasTerrainCutoutRing
                ? profile.terrainCutoutRing : (profile.innerRing || []);
            const bounds = profile.terrainCutoutBounds || profile.bounds;
            if (bounds && (px < bounds.minX || px > bounds.maxX
                || pz < bounds.minZ || pz > bounds.maxZ)) continue;
            if (ringContainsPoint(
                ring,
                px,
                pz,
                hasTerrainCutoutRing
                    ? railTerrainCutoutRingQueryIndex(profile)
                    : railInnerRingQueryIndex(profile),
            )) return profile;
        }
        return null;
    }

    // Effective ground after rail civil works, but before roads and their
    // carried surfaces. Only ordinary cut/fill profiles participate; tunnel
    // and viaduct runs have no ground surface for a later formation to consume.
    // Returning null outside the authored envelope lets the caller fall back
    // to the immutable terrain datum.
    civilGroundSceneYAtLocal(x, z, { surfaceOffsetY = 0 } = {}) {
        const px = finiteOrNull(x);
        const pz = finiteOrNull(z);
        if (px == null || pz == null) return null;
        const offsetY = finiteOrNull(surfaceOffsetY) || 0;
        let bestY = null;
        for (const profile of indexedRailSurfaceProfilesAt(
            this.surfaceProfileIndex,
            px,
            pz,
        )) {
            this._civilGroundProfileChecks += 1;
            const bounds = railSurfaceProfileBounds(profile);
            if (bounds && (px < bounds.minX || px > bounds.maxX
                || pz < bounds.minZ || pz > bounds.maxZ)) continue;
            let candidate = null;
            if (ringContainsPoint(
                profile.innerRing || [],
                px,
                pz,
                railInnerRingQueryIndex(profile),
            )) {
                const alignment = profile.alignment;
                candidate = this._nearestOnAlignments(
                    px,
                    pz,
                    alignment ? [alignment] : this.alignments,
                    {
                        maxDistanceM: Infinity,
                        stationRange: [profile.startStation, profile.endStation],
                    },
                )?.railY;
                if (Number.isFinite(candidate)) candidate += offsetY;
            } else {
                candidate = formationDressingSurfaceYAtLocal(
                    profile,
                    px,
                    pz,
                    { surfaceOffsetY: offsetY },
                );
            }
            if (!Number.isFinite(candidate)) continue;
            // Overlapping context tracks publish the physically visible upper
            // ground surface. Grade-separated runs are tunnel/viaduct and were
            // excluded before profiles were created.
            bestY = bestY == null ? candidate : Math.max(bestY, candidate);
        }
        return bestY;
    }

    resetCivilGroundProfileCheckCount() {
        this._civilGroundProfileChecks = 0;
    }

    getCivilGroundProfileCheckCount() {
        return this._civilGroundProfileChecks;
    }

    isOpenCutAtLocal(x, z, minimumDepthM = 0.5) {
        const profile = this.surfaceProfileAtLocal(x, z);
        if (!profile?.alignment) return false;
        const formation = this._nearestOnAlignments(
            Number(x),
            Number(z),
            [profile.alignment],
            {
                maxDistanceM: Infinity,
                stationRange: [profile.startStation, profile.endStation],
            },
        );
        const groundY = this._baseY(Number(x), Number(z));
        return !!formation && groundY !== null
            && groundY - formation.railY >= Math.max(0, Number(minimumDepthM) || 0);
    }

    // Metres of natural ground standing over the designed rail top here, or
    // null where either height is unknown. Negative on fill, where the rail is
    // above the ground rather than under it.
    //
    // Published because consumers kept re-deriving it, or worse, approximating
    // it from run topology: "am I within a portal-carve length of a tunnel run
    // boundary" is a proxy for "does building this disturb the surface", and a
    // poor one — portal topology is not a substitute for the actual cover at
    // the actual point.
    coverAtLocal(x, z) {
        const px = Number(x);
        const pz = Number(z);
        if (!Number.isFinite(px) || !Number.isFinite(pz)) return null;
        const formation = this.formationAtLocal(px, pz);
        if (!formation || !Number.isFinite(formation.railY)) return null;
        const groundY = this._baseY(px, pz);
        if (typeof groundY !== 'number' || !Number.isFinite(groundY)) return null;
        return groundY - formation.railY;
    }

    getViaductRuns() {
        return this.viaductRuns;
    }

    getTunnelRuns() {
        return this.tunnelRuns;
    }

    getTunnelPortalTerrainOpenings() {
        return this.tunnelPortalTerrainOpenings;
    }

    // What lies ABOVE a plan point with respect to bored tunnels. The photo
    // world's corridor-cut polygons claim the whole route as open (Google's
    // mesh is carved everywhere), but in the model world a bored run keeps its
    // hill all the way to its mapped portal. Walk support needs this distinction
    // or it offers the tube floor through solid ground (fall-through) and
    // "recovers" a walker inside the bore up to the surface (wall-bump teleport).
    //   → null                    — not over any bored run
    //   → { over: 'intact-roof' } — the hill above is real; the tube floor is
    //                               the only floor beneath it (floorY)
    tunnelRoofInfoAt(x, z, marginM = 1) {
        for (const run of this.tunnelRuns) {
            const boreHalf = (finiteOrNull(run.boreHalfWidthM)
                ?? railBoreHalfWidthM(run.halfWidthM)) + marginM;
            const samples = run.boreSamples || run.samples;
            if (!samples || samples.length === 0) continue;
            // Cheap reject: outside the run's sample bbox grown by the bore.
            let minX = Infinity; let maxX = -Infinity;
            let minZ = Infinity; let maxZ = -Infinity;
            for (const sample of samples) {
                if (sample.x < minX) minX = sample.x;
                if (sample.x > maxX) maxX = sample.x;
                if (sample.z < minZ) minZ = sample.z;
                if (sample.z > maxZ) maxZ = sample.z;
            }
            if (x < minX - boreHalf || x > maxX + boreHalf
                || z < minZ - boreHalf || z > maxZ + boreHalf) continue;
            let best = null;
            const boreSegments = run.boreSegments || run.segments;
            for (const segment of boreSegments) {
                const projected = projectPointToSegment(x, z, segment);
                if (!projected) continue;
                if (best && projected.distanceSquared >= best.projected.distanceSquared) continue;
                best = { projected, segment };
            }
            if (!best || best.projected.distanceSquared > boreHalf * boreHalf) continue;
            const localStartIndex = run.boreSegments
                ? best.segment.startSampleIndex
                : best.segment.startSampleIndex - run.segments[0].startSampleIndex;
            const startSample = samples[localStartIndex] || samples[0];
            const station = startSample.station + best.projected.t * best.segment.length;
            const floorY = best.segment.y1
                + (best.segment.y2 - best.segment.y1) * best.projected.t;
            const clearHeightM = finiteOrNull(run.tunnelClearHeightM)
                ?? DEFAULT_RENDERED_TUNNEL_CLEAR_HEIGHT_M;
            return {
                over: 'intact-roof',
                floorY,
                railY: floorY,
                ceilingY: floorY + RENDERED_TUNNEL_BED_ABOVE_RAIL_M + clearHeightM,
                clearHeightM,
                boreHalfWidthM: finiteOrNull(run.boreHalfWidthM)
                    ?? railBoreHalfWidthM(run.halfWidthM),
                station,
            };
        }
        return null;
    }

    _build(features) {
        const iterator = this._buildSteps(features);
        while (!iterator.next().done) { /* synchronous default */ }
    }

    *_buildSteps(features) {
        // Stage timings, published as this.buildTimings so the scene layer can
        // attribute a formation rebuild's cost (terrain sampling vs profile
        // design vs join vs assembly) in the perf overlay. Which stage
        // dominates decides what per-feature reuse must cover.
        const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const buildStarted = now();
        let suspendedMs = 0;
        let suspendedAt = now();
        const preparationSlice = createRailPreparationSlice();
        // Delegate inner operations through the same scene-owned iterator.
        // Suspended frame time is never billed as preparation/assembly CPU.
        const runSlices = function* (iterator, prefix = 'prepare') {
            let outcome = iterator.next();
            while (!outcome.done) {
                suspendedAt = now();
                yield { phase: `${prefix}:${outcome.value.phase}` };
                suspendedMs += now() - suspendedAt;
                preparationSlice.restart();
                outcome = iterator.next();
            }
            return outcome.value;
        };
        let prepareTerrainMs = 0;
        let prepareDesignMs = 0;
        let preparedReusedCount = 0;
        let preparedDirtyCount = 0;
        const previous = this._assemblyReuse?.previousModel;
        const changedBounds = this._assemblyReuse?.terrainChangedBounds;
        const reusablePreparation = previous instanceof RailFormationModel
            && Array.isArray(changedBounds)
            && previous._assemblyContextKey === this._assemblyContextKey
            ? previous._preparations : null;
        const routeStationByProposal = new Map();
        const prepared = [];
        for (const [featureIndex, feature] of (features || []).entries()) {
            if (preparationSlice.expired()) {
                suspendedAt = now();
                yield { phase: 'prepare:features' };
                suspendedMs += now() - suspendedAt;
                preparationSlice.restart();
            }
            if (!isEngineeredRailFeature(feature)) continue;
            const preparationKey = railFeaturePreparationKey(feature);
            const cached = reusablePreparation?.get(preparationKey);
            if (cached && !reuseBoundsIntersectRects(cached.bounds, changedBounds)) {
                // Assembly and the endpoint join mutate their working arrays.
                // Never let a cancelled build change a published model's data.
                const samples = yield* runSlices(mapRailPreparationSteps(
                    cached.samples, sample => ({ ...sample }), 'reuse',
                ));
                // Absolute-to-scene conversion is caller supplied; it can
                // change independently of source coordinates and terrain bounds.
                const designedY = yield* runSlices(mapRailPreparationSteps(
                    cached.designedY,
                    (value, index) => cached.authoredAbsolute
                        ? this.absoluteSceneYAtHeight(samples[index].elevationM) : value,
                    'reuse',
                ));
                this._preparations.set(preparationKey, { ...cached, samples });
                prepared.push({ ...cached, featureIndex, feature, samples, designedY });
                preparedReusedCount += 1;
                continue;
            }
            preparedDirtyCount += 1;
            const coordinates = feature?.geometry?.type === 'LineString'
                ? feature.geometry.coordinates
                : null;
            const railCivilRuns = normalizedRailCivilRuns(feature);
            const samples = yield* runSlices(densifyLocalLineSteps(
                coordinates,
                (lon, lat) => this.toLocal(lon, lat),
                this.sampleStepM,
                {
                    sourceChainagesM: feature?.properties?.railSourceChainagesM,
                    civilRuns: railCivilRuns,
                },
            ));
            if (samples.length < 2) continue;
            const terrainStarted = now();
            const terrainSuspendedMs = suspendedMs;
            yield* runSlices(mapRailPreparationSteps(samples, sample => {
                sample.terrainY = this._baseY(sample.x, sample.z);
                return sample;
            }, 'terrain', PREPARATION_SLICE_MAX_TERRAIN_SAMPLES));
            prepareTerrainMs += now() - terrainStarted - (suspendedMs - terrainSuspendedMs);
            const requestedAbsolute = feature?.properties?.elevationMode === 'absolute';
            const authoredAbsolute = hasAuthoredAbsoluteElevations(feature);
            if (requestedAbsolute && !authoredAbsolute) {
                throw new Error(
                    `Rail proposal ${feature?.properties?.proposalId ?? featureIndex} has invalid `
                    + 'absolute elevations; every point must use EVRF2000.',
                );
            }
            const requestedGroundRelative = feature?.properties?.elevationMode === 'ground-relative';
            const authoredGroundRelative = hasAuthoredGroundRelativeElevations(feature);
            if (requestedGroundRelative && !authoredGroundRelative) {
                throw new Error(
                    `Rail proposal ${feature?.properties?.proposalId ?? featureIndex} has invalid `
                    + 'ground-relative elevations; every point must carry one.',
                );
            }
            const designStarted = now();
            const designSuspendedMs = suspendedMs;
            const explicitOsmStructureY = !authoredAbsolute
                && !authoredGroundRelative
                && feature?.properties?.railProfileSource === 'osm-inferred'
                ? yield* runSlices(this._designExplicitOsmStructureProfileSteps(samples, feature))
                : null;
            const designedY = authoredAbsolute
                ? yield* runSlices(mapRailPreparationSteps(samples,
                    sample => this.absoluteSceneYAtHeight(sample.elevationM), 'authored'))
                : authoredGroundRelative
                    // The authored profile relative to the ground it was solved
                    // against: seat terrain + offset, no re-design. Over water
                    // the terrain is the sea datum, so an imported bay bridge
                    // keeps its authored deck height.
                    ? yield* runSlices(mapRailPreparationSteps(samples,
                        sample => sample.terrainY + sample.elevationM, 'authored'))
                    : explicitOsmStructureY || (yield* runSlices(designRailVerticalProfileSteps(samples, {
                        ...this.profileOptions,
                        maxGrade: railMaxGradeForFeature(feature, this.profileOptions.maxGrade),
                        ...(feature?.properties?.railProfileSource === 'osm-inferred'
                            ? { cutAvoidanceRatio: OSM_CUT_AVOIDANCE_RATIO }
                            : {}),
                    })));
            prepareDesignMs += now() - designStarted - (suspendedMs - designSuspendedMs);
            // No ground known anywhere along the feature: skip it entirely rather
            // than lay it on the datum. It will build on a later revision, once
            // the terrain it needs has streamed in.
            if (!designedY) continue;
            this._preparations.set(preparationKey, {
                samples,
                authoredAbsolute,
                authoredGroundRelative,
                designedY: yield* runSlices(mapRailPreparationSteps(designedY,
                    value => value, 'cache')),
                bounds: yield* runSlices(railPreparationBoundsSteps(samples, feature, this.sampleStepM)),
            });
            prepared.push({
                featureIndex,
                feature,
                samples,
                authoredAbsolute,
                authoredGroundRelative,
                designedY,
            });
        }
        const prepareMs = now() - buildStarted - suspendedMs;
        const joinStarted = now();
        const joinSuspendedMs = suspendedMs;
        yield* runSlices(joinOsmRailStructureProfilesSteps(prepared, {
            maxGrade: this.profileOptions.maxGrade,
        }));
        const assembleStarted = now();
        const joinMs = assembleStarted - joinStarted - (suspendedMs - joinSuspendedMs);
        const assemblySuspendedMs = suspendedMs;
        this.buildTimings = {
            prepareMs, prepareTerrainMs, prepareDesignMs, joinMs,
            preparedReusedCount, preparedDirtyCount,
        };
        let reusableAlignments = null;
        let excludedByBoundsCount = 0;
        {
            const previous = this._assemblyReuse?.previousModel;
            const changedBounds = this._assemblyReuse?.terrainChangedBounds;
            if (previous instanceof RailFormationModel
                && Array.isArray(changedBounds)
                && previous._assemblyContextKey === this._assemblyContextKey) {
                reusableAlignments = new Map();
                for (const alignment of previous.alignments || []) {
                    if (!alignment?._assemblySignature || !alignment._assemblyBounds) continue;
                    // Bbox as a cheap pre-filter only; the decision is
                    // chord/profile-level so a tile beside a long way's box
                    // does not dirty the whole way.
                    if (reuseBoundsIntersectRects(alignment._assemblyBounds, changedBounds)
                        && railAlignmentTouchesRects(alignment, changedBounds)) {
                        excludedByBoundsCount += 1;
                        continue;
                    }
                    reusableAlignments.set(alignment._assemblySignature, alignment);
                }
            }
        }
        let reusedAlignmentCount = 0;
        let dirtyAlignmentCount = 0;
        let assembleCrossSectionMs = 0;
        let assembleClassifyMs = 0;
        let assembleProfileMs = 0;
        suspendedAt = now();
        yield { phase: 'prepare' };
        suspendedMs += now() - suspendedAt;
        for (const {
            featureIndex,
            feature,
            samples,
            authoredAbsolute,
            authoredGroundRelative,
            designedY,
        } of prepared) {
            for (let index = 0; index < samples.length; index++) samples[index].railY = designedY[index];
            const halfWidth = Number(this.halfWidthForFeature(feature));
            const resolvedHalfWidthM = Number.isFinite(halfWidth) && halfWidth > 0
                ? halfWidth
                : DEFAULT_HALF_WIDTH_M;
            const surfaceHalfWidth = Number(this.surfaceHalfWidthForFeature(feature));
            const resolvedSurfaceHalfWidthM = Number.isFinite(surfaceHalfWidth)
                && surfaceHalfWidth > 0
                ? Math.min(resolvedHalfWidthM, surfaceHalfWidth)
                : resolvedHalfWidthM;
            const proposalId = feature?.properties?.proposalId;
            const routeKey = proposalId == null ? `feature:${featureIndex}` : `proposal:${proposalId}`;
            const routeStartStationM = routeStationByProposal.get(routeKey) || 0;
            const assemblySignature = railFeatureAssemblySignature({
                feature,
                samples,
                halfWidthM: resolvedHalfWidthM,
                surfaceHalfWidthM: resolvedSurfaceHalfWidthM,
                routeStartStationM,
                authoredAbsolute,
                authoredGroundRelative,
            });
            const reused = reusableAlignments?.get(assemblySignature);
            if (reused) {
                // One previous alignment must serve at most one feature —
                // duplicate identical ways must not share the same object.
                reusableAlignments.delete(assemblySignature);
                const alignment = yield* runSlices(
                    copyRailAlignmentGenerationSteps(reused, feature), 'alignmentReuse',
                );
                this.alignments.push(alignment);
                this.alignmentByFeature.set(feature, alignment);
                for (const segment of alignment.segments) this.segments.push(segment);
                for (const profile of alignment.profiles) this.profiles.push(profile);
                const effects = alignment._assemblyEffects;
                this.stationAccessPlans.push(...(effects.stationAccessPlans || []));
                this.viaductRuns.push(...(effects.viaductRuns || []));
                this.tunnelRuns.push(...(effects.tunnelRuns || []));
                this.tunnelPortalTerrainOpenings.push(
                    ...(effects.tunnelPortalTerrainOpenings || []),
                );
                routeStationByProposal.set(
                    routeKey,
                    routeStartStationM + samples[samples.length - 1].station,
                );
                reusedAlignmentCount += 1;
                suspendedAt = now();
                yield { phase: 'alignment' };
                suspendedMs += now() - suspendedAt;
                continue;
            }
            dirtyAlignmentCount += 1;
            const dirtyStarted = now();
            const crossSectionSuspendedMs = suspendedMs;
            const crossSectionSlice = createRailPreparationSlice(
                PREPARATION_SLICE_MAX_TERRAIN_SAMPLES / 2,
            );
            const effectMarks = {
                viaductRuns: this.viaductRuns.length,
                tunnelRuns: this.tunnelRuns.length,
                tunnelPortalTerrainOpenings: this.tunnelPortalTerrainOpenings.length,
            };
            const alignment = {
                id: `${feature?.properties?.proposalId ?? 'track'}:${featureIndex}`,
                feature,
                samples,
                halfWidthM: resolvedHalfWidthM,
                surfaceHalfWidthM: resolvedSurfaceHalfWidthM,
                segments: [],
                profiles: [],
                authoredAbsolute,
                authoredGroundRelative,
                routeStartStationM,
            };
            for (let index = 0; index < samples.length - 1; index++) {
                if (crossSectionSlice.expired()) {
                    suspendedAt = now();
                    yield { phase: 'alignmentCrossSection:segments' };
                    suspendedMs += now() - suspendedAt;
                    crossSectionSlice.restart();
                }
                const from = samples[index];
                const to = samples[index + 1];
                const dx = to.x - from.x;
                const dz = to.z - from.z;
                const length = Math.hypot(dx, dz);
                if (length < 0.01) continue;
                const segment = {
                    x1: from.x,
                    z1: from.z,
                    y1: from.railY,
                    x2: to.x,
                    z2: to.z,
                    y2: to.railY,
                    ux: dx / length,
                    uz: dz / length,
                    length,
                    grade: (to.railY - from.railY) / length,
                    // `incomingCivilStructure` describes this exact densified
                    // edge. Run boundaries were inserted into the samples
                    // above, so an OSM portal at chainage 48+664 cannot slide
                    // to a nearby 20 m terrain-classification sample.
                    publishedStructure: to.incomingCivilStructure || null,
                    startSampleIndex: index,
                    endSampleIndex: index + 1,
                    alignment,
                };
                alignment.segments.push(segment);
                this.segments.push(segment);
            }
            if (alignment.segments.length === 0) {
                suspendedAt = now();
                yield { phase: 'alignment' };
                suspendedMs += now() - suspendedAt;
                continue;
            }
            yield* runSlices(indexAlignmentSegmentsSteps(alignment), 'alignmentCrossSection');
            const normals = yield* runSlices(mapRailPreparationSteps(alignment.segments,
                segment => segmentNormal(
                { x: segment.x1, z: segment.z1 },
                { x: segment.x2, z: segment.z2 },
            ), 'normals'), 'alignmentCrossSection');
            const joins = yield* runSlices(mapRailPreparationSteps(samples,
                (_, index) => joinVector(normals[index - 1], normals[index]), 'joins'),
            'alignmentCrossSection');
            const left = yield* runSlices(mapRailPreparationSteps(samples, (sample, index) => ({
                x: sample.x - joins[index].x * alignment.halfWidthM,
                z: sample.z - joins[index].z * alignment.halfWidthM,
            }), 'edges'), 'alignmentCrossSection');
            const right = yield* runSlices(mapRailPreparationSteps(samples, (sample, index) => ({
                x: sample.x + joins[index].x * alignment.halfWidthM,
                z: sample.z + joins[index].z * alignment.halfWidthM,
            }), 'edges'), 'alignmentCrossSection');
            crossSectionSlice.restart();
            for (let index = 0; index < samples.length; index++) {
                if (crossSectionSlice.expired()) {
                    suspendedAt = now();
                    yield { phase: 'alignmentCrossSection:terrain' };
                    suspendedMs += now() - suspendedAt;
                    crossSectionSlice.restart();
                }
                // Only ground we actually sampled. A null here means the terrain
                // under this cross-section is unknown, and every figure derived
                // from it must stay unknown too — averaging it in as 0 is what
                // built viaducts over holes in the DEM.
                const known = [
                    samples[index].terrainY,
                    this._baseY(left[index].x, left[index].z),
                    this._baseY(right[index].x, right[index].z),
                ].map(finiteOrNull).filter(value => value !== null);
                if (known.length === 0) {
                    samples[index].maxFillM = null;
                    samples[index].minCoverM = null;
                    samples[index].terrainMaxY = null;
                    continue;
                }
                samples[index].maxFillM = Math.max(
                    0,
                    ...known.map(baseY => samples[index].railY - baseY),
                );
                // Tunnel cover is the MIN ground height over the width minus the
                // rail: a bore needs cover on both flanks and the crown, so the
                // shallowest of the three governs (mirror of photoreal's min).
                samples[index].minCoverM = Math.max(
                    0,
                    Math.min(...known) - samples[index].railY,
                );
                // Highest ground over the section — the portal headwall must seal
                // up to here so no gap shows into the hill at the tunnel mouth.
                samples[index].terrainMaxY = Math.max(...known);
            }
            for (const segment of alignment.segments) {
                // A segment is only as known as its ends. If either end had no
                // ground, the segment cannot claim a fill or a cover, and the
                // classifiers below will decline to call it a structure at all —
                // rather than inventing one from a number that was never measured.
                segment.maxFillM = knownExtreme(
                    samples[segment.startSampleIndex].maxFillM,
                    samples[segment.endSampleIndex].maxFillM,
                );
                segment.maxCoverM = knownExtreme(
                    samples[segment.startSampleIndex].minCoverM,
                    samples[segment.endSampleIndex].minCoverM,
                );
            }
            const requestedThreshold = Number(feature?.properties?.viaductFillThresholdM);
            // Reconstructions classify from terrain low-passed to the DGU grid's
            // resolution and need a longer run to earn a structure; everything
            // else is classified exactly as before, from the raw extremes.
            const reconstruction = isReconstructedRailFeature(feature);
            assembleCrossSectionMs += now() - dirtyStarted - (suspendedMs - crossSectionSuspendedMs);
            suspendedAt = now();
            yield { phase: 'alignmentCrossSection' };
            suspendedMs += now() - suspendedAt;
            const classifyStarted = now();
            const classifySegments = reconstruction
                ? smoothedSegmentExtremes(alignment.segments, RECONSTRUCTION_TERRAIN_SMOOTHING_M)
                : alignment.segments;
            const minRunOptions = reconstruction
                ? { minRunM: RECONSTRUCTION_STRUCTURE_MIN_RUN_M }
                : {};
            let viaductFlags = classifyViaductSegments(classifySegments, {
                thresholdM: Number.isFinite(requestedThreshold) && requestedThreshold > 0
                    ? requestedThreshold
                    : this.viaductFillThresholdM,
                ...minRunOptions,
                ...(authoredAbsolute || authoredGroundRelative
                    ? { bridgeGapM: PLANNER_VIADUCT_GAP_BRIDGE_M }
                    : {}),
            });
            // Tunnels are classified among the NON-viaduct segments (a segment
            // cannot be both above and below terrain), so a bored span and an
            // open cut never claim the same metres of route.
            let tunnelFlags = classifyTunnelSegments(classifySegments, minRunOptions).map(
                (flag, index) => flag && !viaductFlags[index],
            );
            // A solved reconstruction already published its civil regime on
            // the original project chainage axis. It is authoritative wherever
            // present — including ordinary cut/fill spans, which explicitly
            // forbid the runtime from inventing a tunnel or viaduct there.
            for (let index = 0; index < alignment.segments.length; index++) {
                const published = alignment.segments[index].publishedStructure;
                if (!published) continue;
                viaductFlags[index] = published === 'viaduct';
                tunnelFlags[index] = published === 'tunnel';
            }
            // OSM already states who is above/below. It wins over an absent or
            // misleading DGU structure surface, and it is intentionally not
            // subject to generic minimum-run thresholds: a 12 m road bridge is
            // still a bridge.
            if (feature?.properties?.railStructure === 'viaduct') {
                viaductFlags = alignment.segments.map(() => true);
                tunnelFlags = alignment.segments.map(() => false);
            } else if (feature?.properties?.railStructure === 'tunnel') {
                viaductFlags = alignment.segments.map(() => false);
                tunnelFlags = alignment.segments.map(() => true);
            }
            // Curated station-yard rails inherit the solved vertical datum. A
            // terrain ridge or stale OSM layer tag must not independently turn
            // one siding into a bore/bridge; together they form one ordinary,
            // level yard surface up to the solved tunnel mouth.
            if (feature?.properties?.railContextRole === 'station-yard') {
                viaductFlags = alignment.segments.map(() => false);
                tunnelFlags = alignment.segments.map(() => false);
            }
            for (let index = 0; index < alignment.segments.length; index++) {
                alignment.segments[index].structure = viaductFlags[index]
                    ? 'viaduct'
                    : tunnelFlags[index]
                        ? 'tunnel'
                        : 'formation';
            }
            alignment.endpointStructures = {
                start: alignment.segments[0]?.structure || 'formation',
                end: alignment.segments.at(-1)?.structure || 'formation',
            };

            const accessPlans = this.stationAccessPlanner
                ? (this.stationAccessPlanner({
                    alignment,
                    feature,
                    anchorLat: this.anchorLat,
                    anchorLon: this.anchorLon,
                    baseSceneYAtLocal: (x, z) => this._baseY(x, z),
                }) || [])
                : [];
            assembleClassifyMs += now() - classifyStarted;
            suspendedAt = now();
            yield { phase: 'alignmentClassify' };
            suspendedMs += now() - suspendedAt;
            let profileActiveStarted = now();
            alignment.stationAccessPlans = accessPlans;
            this.stationAccessPlans.push(...accessPlans);

            for (const run of contiguousFlagRuns(viaductFlags, alignment.segments, true)) {
                const startSampleIndex = alignment.segments[run.start].startSampleIndex;
                const endSampleIndex = alignment.segments[run.end].endSampleIndex;
                const viaductRun = {
                    alignment,
                    segments: alignment.segments.slice(run.start, run.end + 1),
                    samples: samples.slice(startSampleIndex, endSampleIndex + 1),
                    startStation: samples[startSampleIndex].station,
                    endStation: samples[endSampleIndex].station,
                    lengthM: run.lengthM,
                };
                this.viaductRuns.push(viaductRun);
            }

            for (const run of contiguousFlagRuns(tunnelFlags, alignment.segments, true)) {
                const startSampleIndex = alignment.segments[run.start].startSampleIndex;
                const endSampleIndex = alignment.segments[run.end].endSampleIndex;
                const tunnelSamples = samples.slice(startSampleIndex, endSampleIndex + 1);
                const tunnelSection = railTunnelSectionForFeature(
                    feature,
                    alignment.halfWidthM,
                    tunnelSamples[0]?.sourceStationM,
                    tunnelSamples.at(-1)?.sourceStationM,
                );
                const boreSamples = tunnelSamples.map((sample, localIndex) => {
                    const join = joins[startSampleIndex + localIndex] || { x: 0, z: 0 };
                    const x = sample.x + join.x * tunnelSection.centerOffsetM;
                    const z = sample.z + join.z * tunnelSection.centerOffsetM;
                    const terrainEvidence = [
                        sample.terrainMaxY,
                        this._baseY(x, z),
                        this._baseY(
                            x - join.x * tunnelSection.halfWidthM,
                            z - join.z * tunnelSection.halfWidthM,
                        ),
                        this._baseY(
                            x + join.x * tunnelSection.halfWidthM,
                            z + join.z * tunnelSection.halfWidthM,
                        ),
                    ].map(finiteOrNull).filter(value => value !== null);
                    return {
                        ...sample,
                        x,
                        z,
                        terrainMaxY: terrainEvidence.length
                            ? Math.max(...terrainEvidence)
                            : null,
                    };
                });
                const boreSegments = [];
                for (let index = 0; index < boreSamples.length - 1; index++) {
                    const from = boreSamples[index];
                    const to = boreSamples[index + 1];
                    const dx = to.x - from.x;
                    const dz = to.z - from.z;
                    const length = Math.hypot(dx, dz);
                    if (length < 0.01) continue;
                    boreSegments.push({
                        x1: from.x,
                        z1: from.z,
                        y1: from.railY,
                        x2: to.x,
                        z2: to.z,
                        y2: to.railY,
                        length,
                        startSampleIndex: index,
                        endSampleIndex: index + 1,
                    });
                }
                const tunnelRun = {
                    alignment,
                    segments: alignment.segments.slice(run.start, run.end + 1),
                    samples: tunnelSamples,
                    boreSamples,
                    boreSegments,
                    startStation: samples[startSampleIndex].station,
                    endStation: samples[endSampleIndex].station,
                    lengthM: run.lengthM,
                    halfWidthM: alignment.halfWidthM,
                    boreHalfWidthM: tunnelSection.halfWidthM,
                    tunnelCenterOffsetM: tunnelSection.centerOffsetM,
                    tunnelTrackCount: tunnelSection.trackCount,
                    tunnelTrackSpacingM: tunnelSection.trackSpacingM,
                    tunnelClearHeightM: tunnelSection.clearHeightM,
                    tunnelPortalCrownM: tunnelSection.portalCrownM,
                    tunnelPortalTerrainOpeningInsideM:
                        tunnelSection.portalTerrainOpeningInsideM
                        ?? TUNNEL_PORTAL_TERRAIN_OPENING_INSIDE_M,
                    tunnelPhysicalId: tunnelSection.physicalId,
                    tunnelSectionEvidence: tunnelSection.evidence,
                    // A retained approach can meet a portal asymmetrically.
                    // Publish the reviewed side reaches at each exact mouth so
                    // the renderer extends the headwall to the cut wall instead
                    // of leaving a black slot beside a fixed-width jamb.
                    portalStartRetainedBenchM: retainedBenchForFormationSection(
                        railFormationSectionForSourceRange(
                            feature,
                            tunnelSamples[0]?.sourceStationM,
                            tunnelSamples[0]?.sourceStationM,
                        ),
                    ),
                    portalEndRetainedBenchM: retainedBenchForFormationSection(
                        railFormationSectionForSourceRange(
                            feature,
                            tunnelSamples.at(-1)?.sourceStationM,
                            tunnelSamples.at(-1)?.sourceStationM,
                        ),
                    ),
                    // Portal faces and the tube begin/end at the civil run's
                    // actual boundaries. The approach formation outside this
                    // run owns the 24 m width taper.
                    portalStartMouthIndex: 0,
                    portalEndMouthIndex: endSampleIndex - startSampleIndex,
                    portalStartHasTerrainOpening: run.start > 0,
                    portalEndHasTerrainOpening:
                        run.end < alignment.segments.length - 1,
                };
                this.tunnelRuns.push(tunnelRun);
                // Only a portal that meets another in-range civil run needs a
                // surface aperture. A clipped route ending in a tunnel keeps
                // its hill intact; manufacturing a hole at the data-window edge
                // would expose the bore from above with no real-world mouth.
                const portalCandidates = [
                    {
                        enabled: tunnelRun.portalStartHasTerrainOpening,
                        side: 'start',
                        mouth: boreSamples[0],
                        interior: boreSamples[1],
                    },
                    {
                        enabled: tunnelRun.portalEndHasTerrainOpening,
                        side: 'end',
                        mouth: boreSamples.at(-1),
                        interior: boreSamples.at(-2),
                    },
                ];
                for (const candidate of portalCandidates) {
                    if (!candidate.enabled) continue;
                    const opening = buildTunnelPortalTerrainOpening({
                        mouth: candidate.mouth,
                        interior: candidate.interior,
                        boreHalfWidthM: tunnelSection.halfWidthM,
                        insideM: tunnelSection.portalTerrainOpeningInsideM
                            ?? TUNNEL_PORTAL_TERRAIN_OPENING_INSIDE_M,
                        physicalId: tunnelSection.physicalId,
                        side: candidate.side,
                    });
                    if (opening) this.tunnelPortalTerrainOpenings.push(opening);
                }
            }

            assembleProfileMs += now() - profileActiveStarted;
            suspendedAt = now();
            yield { phase: 'alignmentStructures' };
            suspendedMs += now() - suspendedAt;
            profileActiveStarted = now();

            // Open earthworks (cut trench + retaining walls + terrain carve) are
            // built where the route is neither a viaduct nor a tunnel. A tunnel
            // keeps its hill from its exact first metre; the adjacent open run
            // widens to the bore and opens its tunnel-facing cross-cap.
            const carveFlags = alignment.segments.map(
                (_, index) => !viaductFlags[index] && !tunnelFlags[index],
            );
            for (const run of contiguousFlagRuns(carveFlags, alignment.segments, true)) {
                const startSampleIndex = alignment.segments[run.start].startSampleIndex;
                const endSampleIndex = alignment.segments[run.end].endSampleIndex;
                // A cross-cap seals a formation end; it is a correct abutment
                // where the run abuts a viaduct, at-grade, or the route end, but
                // a wall across the track where it abuts a bored tunnel — the
                // tube must pass through that mouth. Open the cap only on a
                // tunnel-abutting end (route ends / out-of-range are not tunnels).
                const openCapStart = run.start > 0 && tunnelFlags[run.start - 1] === true;
                const openCapEnd = run.end < alignment.segments.length - 1
                    && tunnelFlags[run.end + 1] === true;
                // Over the cut-and-cover portal zone the open cut FLARES its
                // retaining-wall inner face from the normal cut half-width out to
                // the bore half-width, tapering linearly across the approach,
                // so at the mouth the concrete cut wall sits at exactly ±boreHalf —
                // flush and continuous with the stone tunnel wall (no side gap).
                // Only tunnel-abutting ends flare; plain cuts stay their own width
                // (byte-identical to slicing the constant-width left/right rings).
                let runSamples = samples.slice(startSampleIndex, endSampleIndex + 1);
                let runJoins = joins.slice(startSampleIndex, endSampleIndex + 1);
                ({ samples: runSamples, joins: runJoins } = formationBoundarySamples(
                    runSamples,
                    runJoins,
                    accessPlans,
                ));
                const startTunnelSection = openCapStart
                    ? railTunnelSectionForFeature(
                        feature,
                        alignment.halfWidthM,
                        runSamples[0]?.sourceStationM,
                        runSamples[0]?.sourceStationM,
                    )
                    : null;
                const endTunnelSection = openCapEnd
                    ? railTunnelSectionForFeature(
                        feature,
                        alignment.halfWidthM,
                        runSamples.at(-1)?.sourceStationM,
                        runSamples.at(-1)?.sourceStationM,
                    )
                    : null;
                const localDist = [0];
                for (let k = 1; k < runSamples.length; k++) {
                    localDist[k] = localDist[k - 1] + Math.hypot(
                        runSamples[k].x - runSamples[k - 1].x,
                        runSamples[k].z - runSamples[k - 1].z,
                    );
                }
                const runLengthM = localDist[localDist.length - 1] || 0;
                const flaredSideHalfWidthAt = (k, side) => {
                    let width = alignment.halfWidthM;
                    if (openCapStart && localDist[k] < TUNNEL_PORTAL_APPROACH_TAPER_M) {
                        const t = 1 - localDist[k] / TUNNEL_PORTAL_APPROACH_TAPER_M;
                        const target = startTunnelSection.halfWidthM
                            + side * startTunnelSection.centerOffsetM;
                        width = Math.max(width,
                            alignment.halfWidthM + (target - alignment.halfWidthM) * t);
                    }
                    if (openCapEnd && (runLengthM - localDist[k]) < TUNNEL_PORTAL_APPROACH_TAPER_M) {
                        const t = 1 - (runLengthM - localDist[k]) / TUNNEL_PORTAL_APPROACH_TAPER_M;
                        const target = endTunnelSection.halfWidthM
                            + side * endTunnelSection.centerOffsetM;
                        width = Math.max(width,
                            alignment.halfWidthM + (target - alignment.halfWidthM) * t);
                    }
                    return width;
                };
                const stationRightHalfWidthAt = (k) => railSurfaceAccessRightHalfWidthAt(
                    accessPlans,
                    runSamples[k].station,
                    // `runLeft` below is the -join side. A bore centred at
                    // +offset extends (halfWidth-offset) metres that way.
                    flaredSideHalfWidthAt(k, -1),
                );
                // A deliberately wider base formation earns a separate level
                // apron. Ordinary planner flares and station bays keep their
                // existing dedicated surfaces, but a tunnel-mouth flare is a
                // civil aperture: its retaining walls widen beyond the rendered
                // bed and therefore need a shared level floor between bed and
                // wall. Without it the excavation mask exposes two triangular
                // voids on the widening approach.
                const hasSurfaceApron = alignment.halfWidthM
                    - alignment.surfaceHalfWidthM > 1e-6;
                const formationSection = railFormationSectionForSourceRange(
                    feature,
                    runSamples[0]?.sourceStationM,
                    runSamples.at(-1)?.sourceStationM,
                );
                const formationStyle = formationSection?.style || null;
                const negativeNormalRetainedBenchM = Math.max(
                    0,
                    finiteOrNull(formationSection?.negativeNormalRetainedBenchM) || 0,
                );
                const positiveNormalRetainedBenchM = Math.max(
                    0,
                    finiteOrNull(formationSection?.positiveNormalRetainedBenchM) || 0,
                );
                const surfaceApronWidthAt = (
                    boundaryHalfWidthM,
                    portalBoundaryHalfWidthM,
                ) => (
                    hasSurfaceApron
                        || portalBoundaryHalfWidthM > alignment.halfWidthM + 1e-6
                        ? Math.max(0, boundaryHalfWidthM - alignment.surfaceHalfWidthM)
                        : 0
                );
                const runLeft = runSamples.map((sample, k) => ({
                    // `join` points to alignment-left; subtracting it is the
                    // planner platform's right side, and only that side opens
                    // into the station bay/stair well.
                    x: sample.x - runJoins[k].x * stationRightHalfWidthAt(k),
                    z: sample.z - runJoins[k].z * stationRightHalfWidthAt(k),
                    minimumCutBenchReachM: Math.max(
                        negativeNormalRetainedBenchM,
                        stationAccessMinimumCutBenchReachAt(
                            accessPlans,
                            sample.station,
                        ) || 0,
                    ),
                    surfaceApronWidthM: surfaceApronWidthAt(
                        stationRightHalfWidthAt(k),
                        flaredSideHalfWidthAt(k, -1),
                    ),
                }));
                const runRight = runSamples.map((sample, k) => ({
                    x: sample.x + runJoins[k].x * flaredSideHalfWidthAt(k, 1),
                    z: sample.z + runJoins[k].z * flaredSideHalfWidthAt(k, 1),
                    minimumCutBenchReachM: positiveNormalRetainedBenchM,
                    surfaceApronWidthM: surfaceApronWidthAt(
                        flaredSideHalfWidthAt(k, 1),
                        flaredSideHalfWidthAt(k, 1),
                    ),
                }));
                // innerRing = [L_start..L_end, R_end..R_start]. The END cap edge
                // (L_end→R_end) sits at the run END; the START cap edge
                // (R_start→L_start, the closing edge) sits at the run START.
                // Tag the vertex each cap emanates from on fresh point objects so
                // the tag cannot leak onto a shared sample used by another run.
                const ringPoints = runLeft.concat(runRight.slice().reverse())
                    .map((point) => ({
                        x: point.x,
                        z: point.z,
                        ...(Number.isFinite(point.minimumCutBenchReachM)
                            ? { minimumCutBenchReachM: point.minimumCutBenchReachM }
                            : {}),
                        ...(Number.isFinite(point.surfaceApronWidthM)
                            ? { surfaceApronWidthM: point.surfaceApronWidthM }
                            : {}),
                    }));
                // Keep longitudinal side identity through densification and
                // relief refinement. It lets a reviewed parallel road consume
                // one shared vertical face without dropping the rail cess or
                // guessing from polygon winding after the fact.
                for (let index = 0; index < runLeft.length - 1; index++) {
                    ringPoints[index].capEdge = 'negative-normal';
                }
                for (let index = runLeft.length;
                    index < ringPoints.length - 1;
                    index++) {
                    ringPoints[index].capEdge = 'positive-normal';
                }
                ringPoints[runLeft.length - 1].capEdge = 'end';
                ringPoints[ringPoints.length - 1].capEdge = 'start';
                const profileIterator = buildFormationSurfaceProfileSteps({
                    innerRing: ringPoints,
                    // Restricted to THIS run's stations: on a self-crossing
                    // alignment the unrestricted nearest query could answer
                    // with the other pass and float the collar/trench a level
                    // away from its own rails.
                    surfaceSceneYAtLocal: (x, z) => this._nearestOnAlignments(
                        x,
                        z,
                        [alignment],
                        {
                            maxDistanceM: Infinity,
                            stationRange: [
                                samples[startSampleIndex].station,
                                samples[endSampleIndex].station,
                            ],
                        },
                    )?.railY,
                    baseSceneYAtLocal: (x, z) => this._baseY(x, z),
                    maxSegmentM: PROFILE_STEP_M,
                    openCapStart,
                    openCapEnd,
                    // The mouth's side-specific width flare above is a
                    // geometric contract with the stone tunnel wall; the bench
                    // must ease off over the same carve length or it re-opens
                    // the seam the flare closes.
                    capBenchTaperM: TUNNEL_PORTAL_APPROACH_TAPER_M,
                    wallTopUnderlapM: RAIL_FORMATION_TOP_UNDERLAP_M,
                    verticalRetainedWalls: formationStyle === 'vertical-retained',
                    // Rail beds sit in a shallow bench on cross-sloped ground so
                    // the uphill hillside doesn't bury the trackbed edge. The
                    // owning world explicitly enables this for inferred OSM rail
                    // only when its terrain is a model DTM; photo/reality meshes
                    // stay flush and must not be trenched.
                    crossSlopeBench: alignment.authoredAbsolute === true
                        || alignment.authoredGroundRelative === true
                        || (this.crossSlopeBenchForInferred
                            && feature?.properties?.railProfileSource === 'osm-inferred'),
                    metadata: {
                        formationId: alignment.id,
                        startStation: samples[startSampleIndex].station,
                        endStation: samples[endSampleIndex].station,
                        railContextGroupId: feature?.properties?.railContextGroupId || null,
                        railContextRole: feature?.properties?.railContextRole || null,
                        formationStyle,
                    },
                });
                let profileOutcome = profileIterator.next();
                while (!profileOutcome.done) {
                    assembleProfileMs += now() - profileActiveStarted;
                    suspendedAt = now();
                    yield {
                        phase: `alignmentProfile:${String(
                            profileOutcome.value?.phase || 'work',
                        )}`,
                    };
                    suspendedMs += now() - suspendedAt;
                    profileActiveStarted = now();
                    profileOutcome = profileIterator.next();
                }
                const profile = profileOutcome.value;
                if (!profile) {
                    assembleProfileMs += now() - profileActiveStarted;
                    suspendedAt = now();
                    yield { phase: 'alignmentProfile' };
                    suspendedMs += now() - suspendedAt;
                    profileActiveStarted = now();
                    continue;
                }
                profile.alignment = alignment;
                profile._alignmentSegmentRange = {
                    start: run.start,
                    end: run.end,
                };
                // The index only needs a conservative plan-space envelope. Its
                // former measured radius followed the terrain-dependent outer
                // ring, so one changed height invalidated the cell cache for a
                // 100+ km profile even though the civil-work rules cap lateral
                // reach. Combine the exact inner widths with those shared caps;
                // the result is stable across elevation-window refreshes and
                // deliberately wider than every outer/overlap point.
                let maximumInnerReachM = 0;
                let maximumOuterReachM = FORMATION_MAX_CUTOUT_REACH_M;
                for (let k = 0; k < runSamples.length; k++) {
                    const joinScale = Math.hypot(runJoins[k].x, runJoins[k].z) || 1;
                    maximumInnerReachM = Math.max(
                        maximumInnerReachM,
                        stationRightHalfWidthAt(k) * joinScale,
                        flaredSideHalfWidthAt(k, 1) * joinScale,
                    );
                    maximumOuterReachM = Math.max(
                        maximumOuterReachM,
                        (finiteOrNull(runLeft[k].minimumCutBenchReachM) || 0)
                            + PROFILE_STEP_M,
                        (finiteOrNull(runRight[k].minimumCutBenchReachM) || 0)
                            + PROFILE_STEP_M,
                    );
                }
                profile._civilGroundEnvelopeRadiusM = maximumInnerReachM
                    + maximumOuterReachM * MAX_MITER_SCALE
                    + 1;
                profile._civilGroundEnvelopePlanStable = true;
                // The excavated stretches, from the paired boundary edges above.
                // The ownership ring says "the formation owns this ground" and
                // removes the generic surface over all of it; these rings say
                // "and here it is a hole", which is the only place another civil
                // work's dressing has no business standing. Built here rather
                // than inside buildFormationSurfaceProfile because only this
                // caller still has runLeft/runRight paired by cross-section.
                //
                // Offset well past the batter rather than using the trackbed
                // edges: an open cut is a wedge, not a shaft, so the void at
                // ground level is wider than the bed at the bottom of it, and a
                // ring at bed width left every curb and kerbline hanging over
                // the sloped flank. The exact outer boundary is the profile's
                // own terrain-cutout ring, which the mask clips this against —
                // so the reach only has to be an upper bound, never a second
                // copy of the batter rule.
                const excavationReachAt = (k) => Math.max(
                    FORMATION_MAX_CUTOUT_REACH_M,
                    (finiteOrNull(runLeft[k].minimumCutBenchReachM) || 0) + PROFILE_STEP_M,
                );
                // A railway cross-section is level. Its center can sit at grade
                // while the uphill edge is several metres underground (the
                // Split portal approach is exactly this case). Excavation must
                // therefore use the highest measured ground across center +
                // both edges; center-only evidence leaves the uphill terrain
                // physically passing through the bed and retaining shell.
                const excavationSamples = runSamples.map(sample => ({
                    ...sample,
                    terrainY: finiteOrNull(sample.terrainMaxY)
                        ?? finiteOrNull(sample.terrainY),
                }));
                profile.excavationRegions = buildFormationExcavationRegions({
                    samples: excavationSamples,
                    left: runSamples.map((sample, k) => ({
                        x: sample.x - runJoins[k].x * (stationRightHalfWidthAt(k) + excavationReachAt(k)),
                        z: sample.z - runJoins[k].z * (stationRightHalfWidthAt(k) + excavationReachAt(k)),
                    })),
                    right: runSamples.map((sample, k) => ({
                        x: sample.x + runJoins[k].x
                            * (flaredSideHalfWidthAt(k, 1) + excavationReachAt(k)),
                        z: sample.z + runJoins[k].z
                            * (flaredSideHalfWidthAt(k, 1) + excavationReachAt(k)),
                    })),
                    baseYAtLocal: (x, z) => this._baseY(x, z),
                });
                // A rail embankment is additive civil work: its supplied DGU
                // ground remains underneath as the watertight backstop. Only
                // paired samples that prove the rail is in cut may remove bare
                // terrain. The broad rings are clipped later to this profile's
                // exact paved/wall/collar envelope.
                profile.terrainExcavationRegions = buildFormationExcavationRegions({
                    samples: excavationSamples,
                    left: runSamples.map((sample, k) => ({
                        x: sample.x - runJoins[k].x * (stationRightHalfWidthAt(k) + excavationReachAt(k)),
                        z: sample.z - runJoins[k].z * (stationRightHalfWidthAt(k) + excavationReachAt(k)),
                    })),
                    right: runSamples.map((sample, k) => ({
                        x: sample.x + runJoins[k].x
                            * (flaredSideHalfWidthAt(k, 1) + excavationReachAt(k)),
                        z: sample.z + runJoins[k].z
                            * (flaredSideHalfWidthAt(k, 1) + excavationReachAt(k)),
                    })),
                    baseYAtLocal: (x, z) => this._baseY(x, z),
                    minDepthM: TERRAIN_EXCAVATION_MIN_DEPTH_M,
                });
                flagRailFormationBoundarySegmentsForRoadOpenings(
                    [profile],
                    railSurfaceAccessRetainingOpenings(accessPlans),
                );
                // buildFormationSurfaceProfile owns the same exact-toe,
                // terrain-collar, and buried-cutout boundary contract for
                // engineered roads and proposal railways.
                // A cross-cap is kept at viaduct-abutting and plain cut ends —
                // there it is the abutment that seals the formation below deck
                // level with the rails above its top edge — and opened only
                // where the run meets a bored tunnel (openCapStart/openCapEnd).
                alignment.profiles.push(profile);
                if (!alignment.profile) alignment.profile = profile;
                this.profiles.push(profile);
                assembleProfileMs += now() - profileActiveStarted;
                suspendedAt = now();
                yield { phase: 'alignmentProfile' };
                suspendedMs += now() - suspendedAt;
                profileActiveStarted = now();
            }
            // Captured BEFORE the whole-set passes below latch any flags, so a
            // future reuse re-enters those passes with pristine profiles.
            alignment._assemblySignature = assemblySignature;
            alignment._assemblyBounds = railAlignmentReuseBounds(alignment);
            alignment._assemblyEffects = {
                stationAccessPlans: alignment.stationAccessPlans || [],
                viaductRuns: this.viaductRuns.slice(effectMarks.viaductRuns),
                tunnelRuns: this.tunnelRuns.slice(effectMarks.tunnelRuns),
                tunnelPortalTerrainOpenings: this.tunnelPortalTerrainOpenings.slice(
                    effectMarks.tunnelPortalTerrainOpenings,
                ),
            };
            captureRailProfilePristineFlags(alignment);
            assembleProfileMs += now() - profileActiveStarted;
            this.alignments.push(alignment);
            this.alignmentByFeature.set(feature, alignment);
            routeStationByProposal.set(
                routeKey,
                routeStartStationM + samples[samples.length - 1].station,
            );
            suspendedAt = now();
            yield { phase: 'alignment' };
            suspendedMs += now() - suspendedAt;
        }
        const capsStarted = now();
        suppressConnectedRailFormationCaps(this.alignments, this.profiles);
        this.buildTimings.capsMs = now() - capsStarted;
        suspendedAt = now();
        yield { phase: 'wholeSet:caps' };
        suspendedMs += now() - suspendedAt;

        const mergeStarted = now();
        mergeRailContextProfileBoundaries(this.profiles);
        this.buildTimings.mergeMs = now() - mergeStarted;
        suspendedAt = now();
        yield { phase: 'wholeSet:merge' };
        suspendedMs += now() - suspendedAt;

        const indexStarted = now();
        this.surfaceProfileIndex = indexRailSurfaceProfiles(this.profiles);
        this.buildTimings.indexMs = now() - indexStarted;
        suspendedAt = now();
        yield { phase: 'wholeSet:index' };
        suspendedMs += now() - suspendedAt;

        const overlapIterator = suppressRailProfileDressingOverlapSteps(
            this.profiles,
            this.surfaceProfileIndex,
        );
        let overlapsMs = 0;
        let overlapSliceStarted = now();
        let overlapOutcome = overlapIterator.next();
        while (!overlapOutcome.done) {
            overlapsMs += now() - overlapSliceStarted;
            suspendedAt = now();
            yield { phase: `wholeSet:overlaps:${String(
                overlapOutcome.value?.phase || 'work',
            )}` };
            suspendedMs += now() - suspendedAt;
            overlapSliceStarted = now();
            overlapOutcome = overlapIterator.next();
        }
        overlapsMs += now() - overlapSliceStarted;
        this.buildTimings.overlapsMs = overlapsMs;
        suspendedAt = now();
        yield { phase: 'wholeSet:overlaps' };
        suspendedMs += now() - suspendedAt;

        const portalSteps = flagRailFormationBoundarySegmentsForRoadOpeningsSteps(
            this,
            this.tunnelPortalTerrainOpenings,
        );
        let portalOpeningsMs = 0;
        let portalSliceStarted = now();
        let portalOutcome = portalSteps.next();
        while (!portalOutcome.done) {
            portalOpeningsMs += now() - portalSliceStarted;
            suspendedAt = now();
            yield { phase: `wholeSet:portalOpenings:${String(
                portalOutcome.value?.phase || 'work',
            )}` };
            suspendedMs += now() - suspendedAt;
            portalSliceStarted = now();
            portalOutcome = portalSteps.next();
        }
        portalOpeningsMs += now() - portalSliceStarted;
        this.buildTimings.portalOpeningsMs = portalOpeningsMs;
        suspendedAt = now();
        yield { phase: 'wholeSet:portalOpenings' };
        suspendedMs += now() - suspendedAt;
        this.revision = this.alignments.length > 0 ? 1 : 0;
        this.buildTimings.assembleMs = now() - assembleStarted - (suspendedMs - assemblySuspendedMs);
        this.buildTimings.totalMs = now() - buildStarted - suspendedMs;
        this.buildTimings.reusedCount = reusedAlignmentCount;
        this.buildTimings.dirtyCount = dirtyAlignmentCount;
        this.buildTimings.excludedByBounds = excludedByBoundsCount;
        this.buildTimings.reuseCandidates = reusableAlignments ? reusableAlignments.size : -1;
        this.buildTimings.crossSectionMs = assembleCrossSectionMs;
        this.buildTimings.classifyMs = assembleClassifyMs;
        this.buildTimings.profileMs = assembleProfileMs;
    }
}
