// Builds a JSON-safe, human-readable decision trace for the road structure
// nearest a test observer. It reports current evidence and fallbacks without
// changing geometry or adding work to normal sessions.

import { roadGradeSeparationBuildPlan } from './road-grade-separation-spec.js';
import { CURB_OWNER_SEPARATION_M } from './curb-height.js';
import { finiteOrNull } from './math.js';

const DEFAULT_TRACE_RADIUS_M = 250;

function rounded(value, digits = 2) {
    const numeric = finiteOrNull(value);
    return numeric == null ? null : Number(numeric.toFixed(digits));
}

function numericRange(values, digits = 2) {
    const finite = values.map(Number).filter(Number.isFinite);
    if (finite.length === 0) return { min: null, max: null };
    return {
        min: rounded(Math.min(...finite), digits),
        max: rounded(Math.max(...finite), digits),
    };
}

function maximumGrade(samples) {
    let maximum = 0;
    for (let index = 0; index + 1 < samples.length; index++) {
        const a = samples[index];
        const b = samples[index + 1];
        const runM = Number(b.s) - Number(a.s);
        if (!(runM > 0)) continue;
        maximum = Math.max(maximum, Math.abs(Number(b.y) - Number(a.y)) / runM);
    }
    return maximum;
}

function absoluteRange(sceneRange, anchorElevationAslM) {
    const anchorElevation = finiteOrNull(anchorElevationAslM);
    if (anchorElevation == null) {
        return { min: null, max: null };
    }
    return {
        min: sceneRange.min == null
            ? null
            : rounded(sceneRange.min + anchorElevation),
        max: sceneRange.max == null
            ? null
            : rounded(sceneRange.max + anchorElevation),
    };
}

function evidenceStatus(definition) {
    if (String(definition?.source || '').startsWith('authored')) return 'measured/authored';
    const profile = definition?.profile || {};
    if (profile.type === 'absolute' || profile.type === 'absolute-peak') {
        return 'absolute OSM/authored elevation';
    }
    if (String(definition?.source || '').startsWith('osm-paired')) {
        return 'paired OSM heuristic';
    }
    return 'heuristic';
}

function verticalEvidenceDescription(alignment) {
    const definition = alignment.definition || {};
    const profile = definition.profile || {};
    if (profile.type === 'absolute') {
        return `absolute elevation ${rounded(profile.elevationAslM)} m ASL`;
    }
    if (profile.type === 'absolute-peak') {
        return `absolute peak ${rounded(profile.peakElevationAslM)} m ASL`;
    }
    if (profile.type === 'terrain-clearance-peak') {
        return `lower-corridor terrain + clearance → ${rounded(profile.peakElevationAslM)} m ASL deck`;
    }
    if (profile.type === 'coupled-clearance-peak') {
        return `coupled crossing target → ${rounded(profile.peakElevationAslM)} m ASL lower road`;
    }
    if (profile.type === 'crossing-clearance') {
        return 'lower-corridor terrain + per-crossing clearance';
    }
    if (profile.type === 'nodes') {
        return `${Array.isArray(profile.nodes) ? profile.nodes.length : 0} authored profile nodes`;
    }
    if (profile.type === 'relative-peak') {
        return `terrain-relative peak ${rounded(profile.peakOffsetM)} m`;
    }
    if (profile.type === 'terrain-offset') {
        return `terrain-relative offset ${rounded(profile.offsetM)} m`;
    }
    return `profile ${String(profile.type || 'unspecified')}`;
}

function traceWarnings(alignment, buildPlan) {
    const definition = alignment.definition || {};
    const profile = definition.profile || {};
    const warnings = [];
    if (profile.type === 'terrain-clearance-peak'
        || profile.type === 'coupled-clearance-peak'
        || profile.type === 'crossing-clearance') {
        warnings.push(
            'No surveyed absolute structure elevation is recorded; the deck elevation is derived from lower-corridor terrain and required clearance.',
        );
    } else if (!['absolute', 'absolute-peak', 'nodes'].includes(profile.type)) {
        warnings.push(
            'No absolute structure elevation is recorded; the current profile uses a terrain-relative fallback.',
        );
    }
    if (!Array.isArray(definition.crossings) || definition.crossings.length === 0) {
        warnings.push(
            'The current payload does not identify the crossed road/rail corridors, their widths, or their absolute elevations.',
        );
    }
    const crossingSolutions = (Array.isArray(definition.crossings)
        ? definition.crossings
        : [])
        .map(crossing => crossing?.elevationSolution)
        .filter(Boolean);
    const infeasibleSolutions = crossingSolutions.filter(solution => (
        solution.feasible === false
    ));
    if (infeasibleSolutions.length > 0) {
        warnings.push(
            `${infeasibleSolutions.length} crossing elevation pair${infeasibleSolutions.length === 1 ? '' : 's'} cannot satisfy the required separation under the current ownership or movement limits.`,
        );
    }
    if (!definition.jointProfileSolved
        && definition.crossingElevationPairSolved) {
        warnings.push(
            'Absolute crossing elevations are solved with the counterpart fixed to its normal profile; both longitudinal profiles are not jointly optimized yet.',
        );
    } else if (!definition.jointProfileSolved) {
        warnings.push(
            'The two crossing lines are not jointly solved yet; this alignment is moved independently while the counterpart keeps its own terrain rules.',
        );
    }
    if (alignment.kind === 'underpass' && !definition.replaceRoadSurface) {
        warnings.push(
            'This underpass does not own one continuous replacement carriageway; streamed road members can still expose joins.',
        );
    }
    if (alignment.kind === 'overpass' && !definition.crossings?.length) {
        warnings.push(
            'Intermediate supports currently avoid detected road surfaces, but the trace has no explicit rail-track or full swept-clearance result.',
        );
    }
    const permittedGrade = finiteOrNull(definition.maxGrade);
    const actualGrade = maximumGrade(alignment.samples);
    if (permittedGrade != null && actualGrade > permittedGrade + 0.001) {
        warnings.push(
            `The sampled profile reaches ${rounded(actualGrade * 100)}% despite a ${rounded(permittedGrade * 100)}% permitted grade.`,
        );
    }
    if (buildPlan?.underpass && buildPlan.underpass.terrainClearHalfWidthM == null) {
        warnings.push(
            'Terrain clear/cut widths were not explicit; renderer defaults determine the fit around the walls.',
        );
    }
    return warnings;
}

function nearestAlignment(model, x, z, radiusM, { alignmentId = null, osmId = null } = {}) {
    let best = null;
    const requestedOsmAlignment = osmId == null
        ? null
        : model?.getAlignmentForOsmId?.(osmId);
    const candidates = requestedOsmAlignment
        ? [requestedOsmAlignment]
        : (model?.getAlignments?.() || []).filter(alignment => (
            alignmentId == null || String(alignment.id) === String(alignmentId)
        ));
    for (const alignment of candidates) {
        const nearest = alignment.nearest(Number(x), Number(z));
        if (!nearest || nearest.distanceSquared > radiusM ** 2) continue;
        if (!best || nearest.distanceSquared < best.nearest.distanceSquared) {
            best = { alignment, nearest };
        }
    }
    return best;
}

export function buildRoadStructureDecisionTrace(
    model,
    x,
    z,
    {
        radiusM = DEFAULT_TRACE_RADIUS_M,
        alignmentId = null,
        osmId = null,
    } = {},
) {
    const selected = nearestAlignment(
        model,
        x,
        z,
        Math.max(1, Number(radiusM) || DEFAULT_TRACE_RADIUS_M),
        { alignmentId, osmId },
    );
    if (!selected) return null;

    const { alignment, nearest } = selected;
    const definition = alignment.definition || {};
    const firstMemberOsmId = alignment.memberOsmIds.values().next().value;
    const profileOwner = firstMemberOsmId == null
        ? alignment
        : model.getProfileOwnerForOsmId?.(firstMemberOsmId) || alignment;
    const followsProfileOwner = profileOwner !== alignment;
    const profileDefinition = profileOwner.definition || {};
    const allAlignments = model.getAlignments();
    const buildPlan = roadGradeSeparationBuildPlan(profileOwner, allAlignments);
    const sceneRoadRangeM = numericRange(profileOwner.samples.map(sample => sample.y));
    const sceneTerrainRangeM = numericRange(
        profileOwner.samples.map(sample => sample.terrainY),
    );
    const terrainDeltaRangeM = numericRange(
        profileOwner.samples.map(sample => Number(sample.y) - Number(sample.terrainY)),
    );
    const anchorElevationAslM = finiteOrNull(model.anchorElevationAslM);
    const permittedGrade = finiteOrNull(profileDefinition.maxGrade);
    const maxGrade = maximumGrade(profileOwner.samples);
    const profile = profileDefinition.profile || {};
    const crossings = Array.isArray(profileDefinition.crossings)
        ? profileDefinition.crossings
        : [];
    const sourceEvidence = profileDefinition.osm
        ? { ...profileDefinition.osm }
        : null;
    const steps = [
        {
            number: 1,
            name: 'Identify ownership',
            status: followsProfileOwner
                ? 'surface companion'
                : evidenceStatus(profileDefinition),
            decision: followsProfileOwner
                ? `${alignment.kind} surface OSM ${Array.from(alignment.memberOsmIds).join(', ') || 'unassigned road'} follows structural/profile owner ${profileOwner.id}`
                : `${alignment.kind}: move OSM ${Array.from(alignment.memberOsmIds).join(', ') || 'unassigned road'}`,
            measurements: {
                source: definition.source || 'osm',
                profileOwner: {
                    id: profileOwner.id,
                    memberOsmIds: Array.from(profileOwner.memberOsmIds),
                },
                osmEvidence: sourceEvidence,
                crossedCorridors: crossings,
            },
        },
        {
            number: 2,
            name: 'Build one continuous axis',
            status: definition.replaceRoadSurface
                ? 'owned replacement'
                : alignment.memberOsmIds.size > 1
                    ? 'continuous members + approaches'
                    : 'tagged member axis',
            decision: `${rounded(alignment.totalLengthM, 1)} m axis; ${rounded(alignment.structureEndM - alignment.structureStartM, 1)} m physical structure`,
            measurements: {
                axisLengthM: rounded(alignment.totalLengthM, 1),
                structureStartM: rounded(alignment.structureStartM, 1),
                structureEndM: rounded(alignment.structureEndM, 1),
                structureOsmIds: Array.from(alignment.structureOsmIds || []),
                sampleCount: alignment.samples.length,
                replaceRoadSurface: !!definition.replaceRoadSurface,
            },
        },
        {
            number: 3,
            name: 'Solve absolute and relative elevation',
            status: followsProfileOwner
                ? `inherited from ${profileOwner.id}`
                : evidenceStatus(profileDefinition),
            decision: verticalEvidenceDescription(profileOwner),
            measurements: {
                profileType: profile.type || null,
                anchorElevationAslM: rounded(anchorElevationAslM),
                terrainElevationAslM: absoluteRange(
                    sceneTerrainRangeM,
                    anchorElevationAslM,
                ),
                roadElevationAslM: absoluteRange(
                    sceneRoadRangeM,
                    anchorElevationAslM,
                ),
                roadMinusTerrainM: terrainDeltaRangeM,
                clearanceDerivedPeakElevationAslM:
                    profile.type === 'terrain-clearance-peak'
                        || profile.type === 'coupled-clearance-peak'
                        ? rounded(profile.peakElevationAslM)
                        : null,
                crossingElevationPairSolved:
                    !!profileDefinition.crossingElevationPairSolved,
                crossingElevationSolutions: crossings.map(crossing => ({
                    upperElevationAslM: rounded(
                        crossing.elevationSolution?.upperElevationAslM,
                    ),
                    lowerElevationAslM: rounded(
                        crossing.elevationSolution?.lowerElevationAslM,
                    ),
                    upperLiftM: rounded(
                        crossing.elevationSolution?.upperLiftM,
                    ),
                    lowerCutM: rounded(
                        crossing.elevationSolution?.lowerCutM,
                    ),
                    allocation: crossing.elevationSolution?.allocation || null,
                    feasible: crossing.elevationSolution?.feasible ?? null,
                    remainingDeficitM: rounded(
                        crossing.elevationSolution?.remainingDeficitM,
                    ),
                })),
                maximumGradePercent: rounded(maxGrade * 100),
                permittedGradePercent: permittedGrade != null
                    ? rounded(permittedGrade * 100)
                    : null,
            },
        },
        {
            number: 4,
            name: 'Resolve cross-section',
            status: profileDefinition.crossSection ? 'explicit/derived' : 'renderer defaults',
            decision: `${rounded(buildPlan.roadHalfWidthM * 2, 1)} m carriageway; ${rounded(buildPlan.formationLeftM + buildPlan.formationRightM, 1)} m formation`,
            measurements: {
                laneCount: Number(profileDefinition.laneCountOverride) || null,
                roadWidthM: rounded(buildPlan.roadHalfWidthM * 2, 1),
                formationLeftM: rounded(buildPlan.formationLeftM, 1),
                formationRightM: rounded(buildPlan.formationRightM, 1),
                sidewalkBandsM: buildPlan.sidewalkBandsM.map(band => ({
                    side: band.side,
                    innerOffsetM: rounded(band.rightOffsetM, 1),
                    outerOffsetM: rounded(band.leftOffsetM, 1),
                })),
            },
        },
        {
            number: 5,
            name: 'Fit terrain and clear the crossing',
            status: crossings.length ? 'counterpart-aware' : 'single-corridor heuristic',
            decision: profileOwner.kind === 'underpass'
                ? 'cut terrain around the lower road, then collar it to retaining-wall crowns'
                : crossings.length
                    ? `hold clearance across ${crossings.length} crossed corridor${crossings.length === 1 ? '' : 's'}; begin ramps outside that envelope`
                    : 'keep terrain beneath the deck and join approaches at the axis endpoints',
            measurements: {
                crossings: crossings.map(crossing => ({
                    coordinate: crossing.coordinate || null,
                    angleDeg: rounded(crossing.angleDeg, 1),
                    upperOsmIds: crossing.upperOsmIds || [],
                    lowerOsmIds: crossing.lowerOsmIds || [],
                    requiredClearanceM: rounded(crossing.requiredClearanceM),
                    requiredSurfaceSeparationM: rounded(
                        crossing.requiredSurfaceSeparationM,
                    ),
                    elevationSolution: crossing.elevationSolution
                        ? {
                            allocation: crossing.elevationSolution.allocation,
                            feasible: crossing.elevationSolution.feasible,
                            upperElevationAslM: rounded(
                                crossing.elevationSolution.upperElevationAslM,
                            ),
                            lowerElevationAslM: rounded(
                                crossing.elevationSolution.lowerElevationAslM,
                            ),
                            remainingDeficitM: rounded(
                                crossing.elevationSolution.remainingDeficitM,
                            ),
                        }
                        : null,
                    lowerFormationWidthM: rounded(
                        crossing.lowerComposition?.formationWidthM,
                        1,
                    ),
                })),
                ...(profileOwner.kind === 'underpass'
                    ? buildPlan.underpass
                    : {
                        nominalPierSpacingM: buildPlan.bridge.nominalPierSpacingM,
                        deckDepthM: buildPlan.bridge.deckDepthM,
                    }),
            },
        },
        {
            number: 6,
            name: 'Build civil structure',
            status: followsProfileOwner
                ? `owned by ${profileOwner.id}`
                : profileDefinition.renderStructure === false
                    ? 'owned by companion'
                    : 'scheduled',
            decision: buildPlan.stages.join(' → '),
            measurements: {
                stages: buildPlan.stages,
                bridge: buildPlan.bridge,
                underpass: buildPlan.underpass,
                curbOwnership: {
                    policy: 'nearest source corridor at each curb piece',
                    separatedOwnerThresholdM: CURB_OWNER_SEPARATION_M,
                    internalMemberCaps: 'removed from structure and approach members',
                    upperLowerConnectors: 'removed',
                },
            },
        },
    ];
    return {
        id: alignment.id,
        name: definition.name || null,
        kind: alignment.kind,
        revision: Number(model.revision) || 0,
        observer: {
            x: rounded(x, 1),
            z: rounded(z, 1),
            distanceFromAxisM: rounded(Math.sqrt(nearest.distanceSquared), 1),
            stationM: rounded(nearest.s, 1),
            insidePhysicalStructure: nearest.s >= alignment.structureStartM
                && nearest.s <= alignment.structureEndM,
        },
        memberOsmIds: Array.from(alignment.memberOsmIds),
        profileOwner: {
            id: profileOwner.id,
            memberOsmIds: Array.from(profileOwner.memberOsmIds),
            inherited: followsProfileOwner,
        },
        steps,
        warnings: traceWarnings(profileOwner, buildPlan),
    };
}
