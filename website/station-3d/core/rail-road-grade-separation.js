// Pure ownership contract for openings where a road passes below an existing
// railway. The road structure owns the void through the embankment; rail keeps
// its immutable top/profile, while only overlapping longitudinal retaining-wall
// and terrain-collar boundary segments are suppressed.

import { finiteOrNull } from './math.js';
import { roadGradeSeparationBuildPlan } from './road-grade-separation-spec.js';
import { isStructuralOsmTramFeature } from './structural-tram-corridor.js';

// Longitudinal allowance absorbs the rail-formation boundary sampling step.
export const ROAD_UNDER_RAIL_OPENING_APRON_M = 0.75;
// Across the road, use the rendered tunnel shell itself as the owner. This
// small overlap buries the rail seam just behind the concrete outer face
// without opening an unsupported strip beside the tunnel.
export const ROAD_UNDER_RAIL_SIDE_OVERLAP_M = 0.18;
// A tram in the central reservation can sit well outside either one-way
// carriageway centreline even though all three surfaces share one bridge deck.
// Keep this bounded: the direction and structural-tag checks below are the
// ownership evidence, while this radius only absorbs the mapped lateral offset.
export const ROAD_CARRIED_TRAM_MAX_LATERAL_M = 18;
// Parallel carriageway/tram lines can wander a little independently through a
// curve. Anything more oblique is a crossing and must retain its own elevation.
export const ROAD_CARRIED_TRAM_MIN_DIRECTION_DOT = Math.cos(35 * Math.PI / 180);
export const EMBEDDED_TRAM_MAX_LATERAL_M = 8;
export const RAIL_VIADUCT_TERRAIN_EVIDENCE_MARGIN_M = 3.5;

function finitePositive(value) {
    const parsed = finiteOrNull(value);
    return parsed != null && parsed > 0 ? parsed : null;
}

function normalizedDirection(value) {
    const x = finiteOrNull(value?.x);
    const z = finiteOrNull(value?.z);
    const lengthM = x == null || z == null ? 0 : Math.hypot(x, z);
    return lengthM > 1e-6 ? { x: x / lengthM, z: z / lengthM } : null;
}

// Existing Zagreb tram geometry is intentionally not fed into the generic
// RailFormationModel: ordinary street-running rails should follow terrain. A
// mapped bridge/embankment tram is different. It declares that the track is
// physically carried by an engineered structure and may therefore consume a
// matching road-overpass profile.
export const isPotentialRoadCarriedTramFeature = isStructuralOsmTramFeature;

function alignmentTangentAtNearest(alignment, nearest) {
    const points = alignment?.points || [];
    if (points.length < 2) return null;
    const segmentIndex = Math.max(
        0,
        Math.min(points.length - 2, Number(nearest?.segmentIndex) || 0),
    );
    return normalizedDirection({
        x: Number(points[segmentIndex + 1]?.x) - Number(points[segmentIndex]?.x),
        z: Number(points[segmentIndex + 1]?.z) - Number(points[segmentIndex]?.z),
    });
}

// Returns the road-owned deck height only when a structurally tagged OSM tram
// runs longitudinally with an overpass. A transverse rail is a lower/upper
// crossing counterpart, not a deck passenger, and is rejected by the tangent
// test even when its plan geometry falls inside the road corridor.
export function roadDeckForCarriedTramAtLocal(
    roadVerticalAlignments,
    feature,
    x,
    z,
    railDirection,
    {
        maxLateralM = ROAD_CARRIED_TRAM_MAX_LATERAL_M,
        minDirectionDot = ROAD_CARRIED_TRAM_MIN_DIRECTION_DOT,
    } = {},
) {
    if (!roadVerticalAlignments?.getAlignments
        || !isPotentialRoadCarriedTramFeature(feature)) {
        return null;
    }
    const direction = normalizedDirection(railDirection);
    const localX = finiteOrNull(x);
    const localZ = finiteOrNull(z);
    if (!direction || localX == null || localZ == null) return null;
    const radiusM = Math.max(0, finiteOrNull(maxLateralM) || 0);
    const directionDot = Math.max(
        0,
        Math.min(1, finiteOrNull(minDirectionDot) ?? ROAD_CARRIED_TRAM_MIN_DIRECTION_DOT),
    );
    let best = null;
    for (const alignment of roadVerticalAlignments.getAlignments() || []) {
        if (alignment?.kind !== 'overpass'
            || alignment.definition?.renderStructure === false
            || typeof alignment.nearest !== 'function'
            || typeof alignment.profileYAtS !== 'function') {
            continue;
        }
        const nearest = alignment.nearest(localX, localZ);
        if (!nearest || nearest.distanceSquared > radiusM ** 2) continue;
        const roadDirection = alignmentTangentAtNearest(alignment, nearest);
        if (!roadDirection) continue;
        const parallelDot = Math.abs(
            direction.x * roadDirection.x + direction.z * roadDirection.z,
        );
        if (parallelDot < directionDot) continue;
        const roadY = finiteOrNull(alignment.profileYAtS(nearest.s));
        if (roadY == null) continue;
        if (!best || nearest.distanceSquared < best.distanceSquared) {
            best = {
                roadY,
                alignmentId: alignment.id || null,
                distanceSquared: nearest.distanceSquared,
                stationM: nearest.s,
            };
        }
    }
    return best;
}

// DGU is a surface model, so a rail bridge can appear in the elevation samples
// directly below it. That upper deck is not valid terrain evidence for the
// lower road profile. Returning null preserves the ordinary road solver's
// contract for missing evidence: interpolate from known street samples on both
// sides instead of pulling the road up onto the railway.
export function roadProfileTerrainEvidenceYAtLocal({
    railFormation,
    groundEvidenceSceneYAtLocal,
    x,
    z,
    marginM = RAIL_VIADUCT_TERRAIN_EVIDENCE_MARGIN_M,
} = {}) {
    if (typeof groundEvidenceSceneYAtLocal !== 'function') return null;
    const localX = finiteOrNull(x);
    const localZ = finiteOrNull(z);
    if (localX == null || localZ == null) return null;
    const formation = railFormation?.formationAtLocal?.(localX, localZ, {
        maxDistanceM: 24,
    });
    const halfWidthM = Math.max(0, finiteOrNull(formation?.alignment?.halfWidthM) || 0);
    const evidenceMarginM = Math.max(0, finiteOrNull(marginM) || 0);
    if (formation?.structure === 'viaduct'
        && Number(formation.distanceSquared) <= (halfWidthM + evidenceMarginM) ** 2) {
        return null;
    }
    return finiteOrNull(groundEvidenceSceneYAtLocal(localX, localZ));
}

export function isOrdinaryOsmTramFeature(feature) {
    const properties = feature?.feature?.properties || feature?.properties || {};
    const railway = String(
        properties.railway_type ?? properties.railway ?? properties.tags?.railway ?? '',
    ).trim().toLowerCase();
    const source = String(properties.source ?? '').trim().toLowerCase();
    return railway === 'tram'
        && (!source || source === 'osm')
        && !isStructuralOsmTramFeature(feature);
}

function embeddedTramRoadCandidateAtLocal(
    roadFormation,
    feature,
    x,
    z,
    {
        maxLateralM = EMBEDDED_TRAM_MAX_LATERAL_M,
    } = {},
) {
    if (!roadFormation?.surfaceAtLocal || !roadFormation?.formationAtLocal
        || !isOrdinaryOsmTramFeature(feature)) return null;
    const localX = finiteOrNull(x);
    const localZ = finiteOrNull(z);
    if (localX == null || localZ == null) return null;
    const surface = roadFormation.surfaceAtLocal(localX, localZ);
    if (!surface) return null;
    const formation = roadFormation.formationAtLocal(localX, localZ, {
        osmId: surface.osmId,
    });
    if (!formation || Number(formation.distanceSquared) > Math.max(
        0,
        finiteOrNull(maxLateralM) || 0,
    ) ** 2) return null;
    const roadY = finiteOrNull(formation.roadY);
    const roadDirection = normalizedDirection({
        x: formation.tangentX,
        z: formation.tangentZ,
    });
    return roadY == null || !roadDirection ? null : {
        roadY,
        osmId: surface.osmId,
        distanceSquared: formation.distanceSquared,
        tangentX: roadDirection.x,
        tangentZ: roadDirection.z,
    };
}

function embeddedTramRoadSurfaceForDirection(
    candidate,
    railDirection,
    { minDirectionDot = ROAD_CARRIED_TRAM_MIN_DIRECTION_DOT } = {},
) {
    if (!candidate) return null;
    const direction = normalizedDirection(railDirection);
    if (!direction) return null;
    const roadDirection = normalizedDirection({
        x: candidate.tangentX,
        z: candidate.tangentZ,
    });
    if (!roadDirection) return null;
    const parallelDot = Math.abs(
        direction.x * roadDirection.x + direction.z * roadDirection.z,
    );
    if (parallelDot < Math.max(0, Math.min(1, finiteOrNull(minDirectionDot) || 0))) {
        return null;
    }
    return {
        roadY: candidate.roadY,
        osmId: candidate.osmId,
        distanceSquared: candidate.distanceSquared,
    };
}

// Ordinary street-running tram rails are passengers of the paved road surface,
// not a second independently smoothed vertical alignment. The surface hit plus
// tangent test prevents a transverse rail crossing from accidentally claiming
// the road's elevation.
export function roadSurfaceForEmbeddedTramAtLocal(
    roadFormation,
    feature,
    x,
    z,
    railDirection,
    options = {},
) {
    return embeddedTramRoadSurfaceForDirection(
        embeddedTramRoadCandidateAtLocal(
            roadFormation,
            feature,
            x,
            z,
            options,
        ),
        railDirection,
        options,
    );
}

// A densified LineString visits each interior vertex twice: once as the end of
// a chord and once as the start of the next. Road ownership at that point is
// independent of rail direction; only the final tangent gate is directional.
// Cache the expensive surface + formation lookup per point, then apply the
// tangent gate separately for each incident chord.
export function createEmbeddedTramRoadEndpointResolver({
    roadFormation,
    feature,
    points = [],
    maxLateralM = EMBEDDED_TRAM_MAX_LATERAL_M,
    minDirectionDot = ROAD_CARRIED_TRAM_MIN_DIRECTION_DOT,
} = {}) {
    const list = Array.isArray(points) ? points : [];
    const candidates = new Array(list.length);
    const resolved = new Uint8Array(list.length);
    return (pointIndex, railDirection) => {
        const index = Number(pointIndex);
        if (!Number.isInteger(index) || index < 0 || index >= list.length) return null;
        if (!resolved[index]) {
            const point = list[index];
            candidates[index] = embeddedTramRoadCandidateAtLocal(
                roadFormation,
                feature,
                point?.x,
                point?.z,
                { maxLateralM },
            );
            resolved[index] = 1;
        }
        return embeddedTramRoadSurfaceForDirection(
            candidates[index],
            railDirection,
            { minDirectionDot },
        );
    };
}

export function roadEmbeddedTramSurfaceSignature(
    roadFormation,
    segments = [],
    { useResolved = false, cacheResolved = false } = {},
) {
    if (!roadFormation?.surfaceAtLocal) return '';
    const roadRevision = Number(roadFormation.surfaceGeometryRevision ?? roadFormation.revision) || 0;
    const publicationRevision = Number(roadFormation.surfacePublicationRevision) || 0;
    const entries = [];
    for (let index = 0; index < (segments || []).length; index++) {
        const segment = segments[index];
        const feature = segment?.feature || segment;
        if (!isOrdinaryOsmTramFeature(feature)) continue;
        const direction = {
            x: Number(segment?.x2) - Number(segment?.x1),
            z: Number(segment?.z2) - Number(segment?.z1),
        };
        const resolved = segment?._embeddedRoadSupport;
        const resolvedIsCurrent = useResolved
            && resolved?.formation === roadFormation
            && resolved.revision === roadRevision
            && (Number(resolved.publicationRevision) || 0) === publicationRevision;
        const start = resolvedIsCurrent
            ? resolved.start
            : roadSurfaceForEmbeddedTramAtLocal(
                roadFormation,
                feature,
                segment?.x1,
                segment?.z1,
                direction,
            );
        const end = resolvedIsCurrent
            ? resolved.end
            : roadSurfaceForEmbeddedTramAtLocal(
                roadFormation,
                feature,
                segment?.x2,
                segment?.z2,
                direction,
            );
        // A signature pass already paid for both spatial lookups. The rail
        // renderer can opt in to retaining those answers on its transient
        // solved chords, so the partial height refresh immediately following
        // a changed signature does not query the same endpoints a second time.
        if (cacheResolved && segment && typeof segment === 'object') {
            segment._embeddedRoadSupport = {
                formation: roadFormation,
                revision: roadRevision,
                publicationRevision,
                start,
                end,
            };
        }
        entries.push(`${index}:${deckSignatureToken(start)}:${deckSignatureToken(end)}`);
    }
    return entries.join('|');
}

// Road streaming changes the vertical owner of an ordinary tram chord, not
// its densification, joins, gauge, UV station or render-cell ownership. Reuse
// that solved horizontal record and replace only its two base heights. The
// caller reapplies junction lifts after the whole embedded subset is sampled.
// This turns a settled road revision from a complete rail LineString solve into
// one cheap immutable pass over the already-visible chords.
export function resampleEmbeddedTramRoadSegmentHeights(
    roadFormation,
    segments = [],
    { preserveEndpointOffsets = false, supportCacheSource = roadFormation } = {},
) {
    const roadRevision = Number(roadFormation?.surfaceGeometryRevision ?? roadFormation?.revision) || 0;
    const publicationRevision = Number(roadFormation?.surfacePublicationRevision) || 0;
    return (segments || []).map((segment) => {
        if (!segment || !isOrdinaryOsmTramFeature(segment)) return segment;
        const direction = {
            x: Number(segment.x2) - Number(segment.x1),
            z: Number(segment.z2) - Number(segment.z1),
        };
        const resolved = segment._embeddedRoadSupport;
        const resolvedIsCurrent = resolved?.formation === supportCacheSource
            && resolved.revision === roadRevision
            && (Number(resolved.publicationRevision) || 0) === publicationRevision;
        const start = resolvedIsCurrent
            ? resolved.start
            : roadSurfaceForEmbeddedTramAtLocal(
                roadFormation,
                segment.feature || segment,
                segment.x1,
                segment.z1,
                direction,
            );
        const end = resolvedIsCurrent
            ? resolved.end
            : roadSurfaceForEmbeddedTramAtLocal(
                roadFormation,
                segment.feature || segment,
                segment.x2,
                segment.z2,
                direction,
            );
        const fallbackStart = finiteOrNull(segment._embeddedRoadFallbackYStart);
        const fallbackEnd = finiteOrNull(segment._embeddedRoadFallbackYEnd);
        const previousRoadStart = segment._embeddedRoadEligibleStart !== false
            ? finiteOrNull(resolved?.start?.roadY)
            : null;
        const previousRoadEnd = segment._embeddedRoadEligibleEnd !== false
            ? finiteOrNull(resolved?.end?.roadY)
            : null;
        const previousBaseStart = previousRoadStart
            ?? fallbackStart
            ?? finiteOrNull(segment.yStart)
            ?? 0;
        const previousBaseEnd = previousRoadEnd
            ?? fallbackEnd
            ?? finiteOrNull(segment.yEnd)
            ?? 0;
        // OSM topology is immutable during a session, so its deterministic
        // junction separation is immutable too. A bounded road-tile refresh
        // can preserve that already-solved endpoint offset without pulling the
        // complete connected tram network back through the junction pass.
        const startOffset = preserveEndpointOffsets
            ? (finiteOrNull(segment.yStart) ?? previousBaseStart) - previousBaseStart
            : 0;
        const endOffset = preserveEndpointOffsets
            ? (finiteOrNull(segment.yEnd) ?? previousBaseEnd) - previousBaseEnd
            : 0;
        const roadStart = segment._embeddedRoadEligibleStart !== false
            ? finiteOrNull(start?.roadY)
            : null;
        const roadEnd = segment._embeddedRoadEligibleEnd !== false
            ? finiteOrNull(end?.roadY)
            : null;
        return {
            ...segment,
            yStart: (roadStart ?? fallbackStart ?? segment.yStart) + startOffset,
            yEnd: (roadEnd ?? fallbackEnd ?? segment.yEnd) + endOffset,
            _embeddedRoadSupport: {
                // This identity is only a memoization key. Heights were read
                // from the captured generation passed to this function.
                formation: supportCacheSource,
                revision: roadRevision,
                publicationRevision,
                start,
                end,
            },
        };
    });
}

// Cooperative facade for the exact synchronous algorithm above. Road support
// lookups are individually bounded, but a settled Zagreb tile revision can
// touch hundreds of already-solved tram chords. Chunk the immutable subset and
// concatenate it in source order so output is identical while the caller can
// retain its previous complete rail generation between slices.
export function* resampleEmbeddedTramRoadSegmentHeightsSteps(
    roadFormation,
    segments = [],
    options = {},
) {
    const source = Array.isArray(segments) ? segments : [];
    const segmentsPerYield = Math.max(
        1,
        Math.floor(Number(options.segmentsPerYield) || 16),
    );
    const result = [];
    for (let start = 0; start < source.length; start += segmentsPerYield) {
        const end = Math.min(source.length, start + segmentsPerYield);
        result.push(...resampleEmbeddedTramRoadSegmentHeights(
            roadFormation,
            source.slice(start, end),
            options,
        ));
        if (end < source.length) {
            yield { phase: 'resample', processedSegments: end, totalSegments: source.length };
        }
    }
    return result;
}

// Rail piers use the existing centreline/track clearance evaluator, plus the
// complete rendered road surface footprint. A median or verge remains usable;
// carriageway, tram reservation and sidewalk polygons do not.
export function railViaductPillarClearanceAtLocal(
    baseClearance,
    roadFormation,
    x,
    z,
    options = {},
) {
    if (roadFormation?.surfaceAtLocal?.(x, z)) return -1;
    return typeof baseClearance === 'function'
        ? baseClearance(x, z, options)
        : 0;
}

export function railViaductTerrainEvidenceBounds(railFormation, paddingM = 12) {
    const padding = Math.max(0, finiteOrNull(paddingM) || 0);
    return (railFormation?.getViaductRuns?.() || [])
        .map((run) => {
            const samples = run?.samples || [];
            if (samples.length === 0) return null;
            const halfWidthM = Math.max(
                0,
                finiteOrNull(run?.alignment?.halfWidthM) || 0,
            ) + padding;
            return {
                minX: Math.min(...samples.map(sample => sample.x)) - halfWidthM,
                maxX: Math.max(...samples.map(sample => sample.x)) + halfWidthM,
                minZ: Math.min(...samples.map(sample => sample.z)) - halfWidthM,
                maxZ: Math.max(...samples.map(sample => sample.z)) + halfWidthM,
            };
        })
        .filter(Boolean);
}

// Complete bounded dependency published by rail civil ground: profile
// envelopes expose cut/fill surfaces, while viaduct footprints change which
// DGU samples remain valid evidence for later authorities.
export function railCivilGroundDependencyBounds(railFormation, paddingM = 12) {
    return railCivilGroundDependencySnapshot(railFormation, paddingM).bounds;
}

function createCivilGroundSignatureHasher() {
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    let count = 0;
    const addWord = (word) => {
        const value = Number(word) | 0;
        first = Math.imul(first ^ value, 0x01000193);
        second = Math.imul(second ^ value, 0x85ebca6b);
        count += 1;
    };
    return {
        addNumber(value) {
            const number = finiteOrNull(value);
            addWord(number == null ? 0x7fc00000 : Math.round(number * 100));
        },
        addBoolean(value) {
            addWord(value ? 1 : 0);
        },
        digest() {
            return `${count}:${(first >>> 0).toString(16).padStart(8, '0')}`
                + `${(second >>> 0).toString(16).padStart(8, '0')}`;
        },
    };
}

function railCivilProfileSignature(profile) {
    const hash = createCivilGroundSignatureHasher();
    hash.addBoolean(profile?.formationDressingDisabled);
    hash.addNumber(profile?.startStation);
    hash.addNumber(profile?.endStation);
    const pointFields = [
        'innerX', 'innerZ', 'roadY',
        'outerX', 'outerZ', 'terrainY',
        'cutoutX', 'cutoutZ', 'cutoutTerrainY',
        'overlapX', 'overlapZ', 'overlapTerrainY',
    ];
    for (const point of profile?.points || []) {
        for (const field of pointFields) hash.addNumber(point?.[field]);
    }
    for (const value of profile?.internalSegments || []) hash.addBoolean(value);
    for (const value of profile?.collarInternalSegments || []) hash.addBoolean(value);
    for (const ranges of profile?.roadOpeningSegmentRanges || []) {
        hash.addNumber(ranges?.length || 0);
        for (const range of ranges || []) {
            hash.addNumber(range?.startT ?? range?.[0]);
            hash.addNumber(range?.endT ?? range?.[1]);
        }
    }
    return hash.digest();
}

function railViaductRunGroundSignature(run) {
    const hash = createCivilGroundSignatureHasher();
    hash.addNumber(run?.alignment?.halfWidthM);
    for (const sample of run?.samples || []) {
        hash.addNumber(sample?.x);
        hash.addNumber(sample?.z);
        hash.addNumber(sample?.railY);
    }
    return hash.digest();
}

function railCivilProfileChangeBounds(profile, paddingM) {
    const alignment = profile?.alignment;
    const segments = alignment?.segments || [];
    const envelopeRadiusM = finiteOrNull(profile?._civilGroundEnvelopeRadiusM);
    if (segments.length === 0 || envelopeRadiusM == null) return null;
    const radiusM = Math.max(0, envelopeRadiusM) + paddingM;
    const startStation = finiteOrNull(profile?.startStation);
    const endStation = finiteOrNull(profile?.endStation);
    const bounds = [];
    for (const segment of segments) {
        const segmentStartM = finiteOrNull(
            alignment.samples?.[segment.startSampleIndex]?.station,
        );
        const segmentEndM = finiteOrNull(
            alignment.samples?.[segment.endSampleIndex]?.station,
        );
        if (startStation != null && endStation != null
            && segmentStartM != null && segmentEndM != null
            && (segmentEndM < startStation - 1e-6
                || segmentStartM > endStation + 1e-6)) continue;
        bounds.push({
            minX: Math.min(segment.x1, segment.x2) - radiusM,
            maxX: Math.max(segment.x1, segment.x2) + radiusM,
            minZ: Math.min(segment.z1, segment.z2) - radiusM,
            maxZ: Math.max(segment.z1, segment.z2) + radiusM,
        });
    }
    return bounds.length > 0 ? bounds : null;
}

// Roads consult this EVERY FRAME (world/roads.js onFrame →
// refreshCivilGroundDependencies), and computing it walks every surface-profile
// point and every viaduct sample to re-hash tokens that almost never change:
// measured at 6.4–15 ms per frame in terrain worlds, larger than render.
//
// So the RESULT is memoized per formation. That is sound because a formation is
// immutable once built: world/rails.js rebuildRailFormation constructs a NEW
// RailFormationModel for every change (terrain, streamed features) and stamps it
// with a fresh monotonic revision, and nothing mutates profiles or viaduct runs
// afterwards. Identity plus revision plus padding is therefore a complete key —
// on a hit, recomputation could not produce anything different.
//
// This does NOT put revision into the signature: the contract below is
// unchanged, and a rebuild that leaves the ground alone still yields an EQUAL
// signature and stays a downstream no-op. Revision only decides whether the work
// must be redone. Returning the SAME object on a hit is also what lets the
// composition layer skip its own per-frame rebuild (core/civil-ground-composition.js).
// A model revision is NOT enough on its own. Some ground-affecting edits happen
// IN PLACE on an already-built formation and never construct a new model: the
// level-crossing wall flagger (world/rails.js) and the two boundary-segment
// flaggers below set profile.internalSegments / collarInternalSegments /
// roadOpeningSegmentRanges directly, and all three are hashed into the signature.
// Without this counter the cache would answer with the pre-flag signature, roads
// would see no change, and the stale rail ground would survive exactly the event
// those flaggers exist to announce — invisible in a settled scene, wrong the
// moment a crossing resolves mid-ride.
//
// The flaggers call this themselves, so a caller cannot forget to.
export function noteRailCivilGroundMutation(railFormationOrProfiles) {
    if (!railFormationOrProfiles || Array.isArray(railFormationOrProfiles)) return;
    const formation = railFormationOrProfiles;
    formation.civilGroundMutationRevision =
        (Number(formation.civilGroundMutationRevision) || 0) + 1;
}

const railCivilGroundSnapshotCache = new WeakMap();   // formation → { revision, mutation, padding, snapshot }

export function peekRailCivilGroundDependencySnapshot(railFormation, paddingM = 12) {
    if (!railFormation) return null;
    const padding = Math.max(0, finiteOrNull(paddingM) || 0);
    const mutation = Number(railFormation.civilGroundMutationRevision) || 0;
    const cached = railCivilGroundSnapshotCache.get(railFormation);
    return cached && cached.padding === padding
        && cached.revision === railFormation.revision
        && cached.mutation === mutation
        ? cached.snapshot
        : null;
}

function* railCivilProfileSnapshotEntrySteps(profile, padding, workPerStep) {
    const source = profile?.overlapBounds
        || profile?.terrainCutoutBounds
        || profile?.outerBounds
        || profile?.bounds;
    if (!source) return null;
    const hash = createCivilGroundSignatureHasher();
    let work = 0;
    const pointFields = [
        'innerX', 'innerZ', 'roadY',
        'outerX', 'outerZ', 'terrainY',
        'cutoutX', 'cutoutZ', 'cutoutTerrainY',
        'overlapX', 'overlapZ', 'overlapTerrainY',
    ];
    hash.addBoolean(profile?.formationDressingDisabled);
    hash.addNumber(profile?.startStation);
    hash.addNumber(profile?.endStation);
    work += 3;
    for (const point of profile?.points || []) {
        for (const field of pointFields) {
            hash.addNumber(point?.[field]);
            work += 1;
            if (work >= workPerStep) {
                work = 0;
                yield { phase: 'profile-signature' };
            }
        }
    }
    for (const value of profile?.internalSegments || []) {
        hash.addBoolean(value);
        work += 1;
        if (work >= workPerStep) {
            work = 0;
            yield { phase: 'profile-signature' };
        }
    }
    for (const value of profile?.collarInternalSegments || []) {
        hash.addBoolean(value);
        work += 1;
        if (work >= workPerStep) {
            work = 0;
            yield { phase: 'profile-signature' };
        }
    }
    for (const ranges of profile?.roadOpeningSegmentRanges || []) {
        hash.addNumber(ranges?.length || 0);
        work += 1;
        for (const range of ranges || []) {
            hash.addNumber(range?.startT ?? range?.[0]);
            hash.addNumber(range?.endT ?? range?.[1]);
            work += 2;
            if (work >= workPerStep) {
                work = 0;
                yield { phase: 'profile-signature' };
            }
        }
    }

    const broadBounds = {
        minX: source.minX - padding,
        maxX: source.maxX + padding,
        minZ: source.minZ - padding,
        maxZ: source.maxZ + padding,
    };
    const alignment = profile?.alignment;
    const segments = alignment?.segments || [];
    const envelopeRadiusM = finiteOrNull(profile?._civilGroundEnvelopeRadiusM);
    let changeBounds = null;
    if (segments.length > 0 && envelopeRadiusM != null) {
        const radiusM = Math.max(0, envelopeRadiusM) + padding;
        const startStation = finiteOrNull(profile?.startStation);
        const endStation = finiteOrNull(profile?.endStation);
        changeBounds = [];
        work = 0;
        for (const segment of segments) {
            const segmentStartM = finiteOrNull(
                alignment.samples?.[segment.startSampleIndex]?.station,
            );
            const segmentEndM = finiteOrNull(
                alignment.samples?.[segment.endSampleIndex]?.station,
            );
            if (!(startStation != null && endStation != null
                && segmentStartM != null && segmentEndM != null
                && (segmentEndM < startStation - 1e-6
                    || segmentStartM > endStation + 1e-6))) {
                changeBounds.push({
                    minX: Math.min(segment.x1, segment.x2) - radiusM,
                    maxX: Math.max(segment.x1, segment.x2) + radiusM,
                    minZ: Math.min(segment.z1, segment.z2) - radiusM,
                    maxZ: Math.max(segment.z1, segment.z2) + radiusM,
                });
            }
            work += 1;
            if (work >= workPerStep) {
                work = 0;
                yield { phase: 'profile-bounds' };
            }
        }
        if (changeBounds.length === 0) changeBounds = null;
    }
    return {
        signature: `p:${hash.digest()}`,
        bounds: broadBounds,
        changeBounds: changeBounds || [broadBounds],
    };
}

function* railViaductSnapshotEntrySteps(run, padding, workPerStep) {
    const samples = run?.samples || [];
    if (samples.length === 0) return null;
    const halfWidthM = Math.max(
        0,
        finiteOrNull(run?.alignment?.halfWidthM) || 0,
    ) + padding;
    const hash = createCivilGroundSignatureHasher();
    hash.addNumber(run?.alignment?.halfWidthM);
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let work = 1;
    for (const sample of samples) {
        hash.addNumber(sample?.x);
        hash.addNumber(sample?.z);
        hash.addNumber(sample?.railY);
        minX = Math.min(minX, sample.x);
        maxX = Math.max(maxX, sample.x);
        minZ = Math.min(minZ, sample.z);
        maxZ = Math.max(maxZ, sample.z);
        work += 3;
        if (work >= workPerStep) {
            work = 0;
            yield { phase: 'viaduct-signature' };
        }
    }
    return {
        signature: `v:${hash.digest()}`,
        bounds: {
            minX: minX - halfWidthM,
            maxX: maxX + halfWidthM,
            minZ: minZ - halfWidthM,
            maxZ: maxZ + halfWidthM,
        },
    };
}

// The first fingerprint of a new formation used to run inside roads.onFrame.
// The cache made settled frames cheap, but every streamed/terrain generation
// still paid one unbounded walk over all profile points and alignment segments.
// Build that immutable snapshot cooperatively, then install it in the same cache
// read by the synchronous compatibility API below.
export function* railCivilGroundDependencySnapshotSteps(
    railFormation,
    paddingM = 12,
    { workPerStep = 256 } = {},
) {
    const padding = Math.max(0, finiteOrNull(paddingM) || 0);
    if (!railFormation) return computeRailCivilGroundDependencySnapshot(null, padding);
    const cached = peekRailCivilGroundDependencySnapshot(railFormation, padding);
    if (cached) return cached;
    const safeWorkPerStep = Math.max(1, Math.floor(Number(workPerStep) || 256));
    const revision = railFormation.revision;
    const mutation = Number(railFormation.civilGroundMutationRevision) || 0;
    const entries = [];
    for (const profile of railFormation?.getSurfaceProfiles?.() || []) {
        const entry = yield* railCivilProfileSnapshotEntrySteps(
            profile,
            padding,
            safeWorkPerStep,
        );
        if (entry) entries.push(entry);
    }
    for (const run of railFormation?.getViaductRuns?.() || []) {
        const entry = yield* railViaductSnapshotEntrySteps(
            run,
            padding,
            safeWorkPerStep,
        );
        if (entry) entries.push(entry);
    }
    const snapshot = {
        entries,
        bounds: entries.map(entry => entry.bounds),
        signature: entries.map(entry => entry.signature).sort().join(','),
    };
    if (railFormation.revision === revision
        && (Number(railFormation.civilGroundMutationRevision) || 0) === mutation) {
        railCivilGroundSnapshotCache.set(railFormation, {
            revision,
            mutation,
            padding,
            snapshot,
        });
    }
    return snapshot;
}

export function railCivilGroundDependencySnapshot(railFormation, paddingM = 12) {
    const padding = Math.max(0, finiteOrNull(paddingM) || 0);
    if (!railFormation) return computeRailCivilGroundDependencySnapshot(railFormation, padding);
    const mutation = Number(railFormation.civilGroundMutationRevision) || 0;
    const cached = railCivilGroundSnapshotCache.get(railFormation);
    if (cached && cached.padding === padding
        && cached.revision === railFormation.revision
        && cached.mutation === mutation) {
        return cached.snapshot;
    }
    const snapshot = computeRailCivilGroundDependencySnapshot(railFormation, padding);
    railCivilGroundSnapshotCache.set(railFormation, {
        revision: railFormation.revision,
        mutation,
        padding,
        snapshot,
    });
    return snapshot;
}

// Revision and object identity are deliberately absent. Rails can rebuild as
// new tiles stream without changing the ground consumed by roads; those broad
// revisions must be no-ops. Quantised geometry/height tokens still invalidate
// when the visible civil surface or viaduct evidence footprint really changes.
function computeRailCivilGroundDependencySnapshot(railFormation, paddingM = 12) {
    const padding = Math.max(0, finiteOrNull(paddingM) || 0);
    const entries = [];
    for (const profile of railFormation?.getSurfaceProfiles?.() || []) {
        const source = profile?.overlapBounds
            || profile?.terrainCutoutBounds
            || profile?.outerBounds
            || profile?.bounds;
        if (!source) continue;
        const broadBounds = {
            minX: source.minX - padding,
            maxX: source.maxX + padding,
            minZ: source.minZ - padding,
            maxZ: source.maxZ + padding,
        };
        entries.push({
            signature: `p:${railCivilProfileSignature(profile)}`,
            bounds: broadBounds,
            changeBounds: railCivilProfileChangeBounds(profile, padding)
                || [broadBounds],
        });
    }
    const viaductRuns = railFormation?.getViaductRuns?.() || [];
    for (const run of viaductRuns) {
        const samples = run?.samples || [];
        if (samples.length === 0) continue;
        const halfWidthM = Math.max(
            0,
            finiteOrNull(run?.alignment?.halfWidthM) || 0,
        ) + padding;
        entries.push({
            signature: `v:${railViaductRunGroundSignature(run)}`,
            bounds: {
                minX: Math.min(...samples.map(sample => sample.x)) - halfWidthM,
                maxX: Math.max(...samples.map(sample => sample.x)) + halfWidthM,
                minZ: Math.min(...samples.map(sample => sample.z)) - halfWidthM,
                maxZ: Math.max(...samples.map(sample => sample.z)) + halfWidthM,
            },
        });
    }
    const tokens = entries.map(entry => entry.signature).sort();
    return {
        entries,
        bounds: entries.map(entry => entry.bounds),
        signature: tokens.join(','),
    };
}

export function railCivilGroundDependencySignature(railFormation) {
    return railCivilGroundDependencySnapshot(railFormation).signature;
}

function deckSignatureToken(deck) {
    if (!deck) return '-';
    const roadY = finiteOrNull(deck.roadY);
    if (roadY == null) return '-';
    // Rendering consumes the height, not the identity of whichever parallel
    // carriageway supplied it. The second half of a split bridge often streams
    // later and becomes the nearer owner at the same elevation; including its
    // id turned that harmless ownership swap into a full rail-network rebuild.
    return roadY.toFixed(2);
}

// Road alignments stream independently from the OSM rail network. Their model
// revision therefore changes for every newly arrived road tile, even when none
// of those roads carries a structural tram. Rebuilding the complete rail group
// on that broad revision costs hundreds of milliseconds. This compact visible-
// corridor signature lets the rail layer invalidate only when the deck that an
// actual bridge/embankment tram endpoint consumes has changed.
export function roadCarriedTramDeckSignature(
    roadVerticalAlignments,
    segments = [],
) {
    if (!roadVerticalAlignments?.getAlignments) return '';
    const alignments = roadVerticalAlignments.getAlignments() || [];
    const alignmentSnapshot = { getAlignments: () => alignments };
    const entries = [];
    for (let index = 0; index < (segments || []).length; index++) {
        const segment = segments[index];
        if (!isPotentialRoadCarriedTramFeature(segment)) continue;
        const x1 = finiteOrNull(segment?.x1);
        const z1 = finiteOrNull(segment?.z1);
        const x2 = finiteOrNull(segment?.x2);
        const z2 = finiteOrNull(segment?.z2);
        if (x1 == null || z1 == null || x2 == null || z2 == null
            || Math.hypot(x2 - x1, z2 - z1) <= 1e-6) continue;
        const direction = { x: x2 - x1, z: z2 - z1 };
        const start = roadDeckForCarriedTramAtLocal(
            alignmentSnapshot,
            segment,
            x1,
            z1,
            direction,
        );
        const end = roadDeckForCarriedTramAtLocal(
            alignmentSnapshot,
            segment,
            x2,
            z2,
            direction,
        );
        entries.push(`${index}:${deckSignatureToken(start)}:${deckSignatureToken(end)}`);
    }
    return entries.join('|');
}

export function roadUnderRailFormationOpenings(
    alignments = [],
    {
        apronM = ROAD_UNDER_RAIL_OPENING_APRON_M,
        sideOverlapM = ROAD_UNDER_RAIL_SIDE_OVERLAP_M,
    } = {},
) {
    const openings = [];
    const apron = Math.max(0, finiteOrNull(apronM) || 0);
    const sideOverlap = Math.max(0, finiteOrNull(sideOverlapM) || 0);
    const safeAlignments = Array.isArray(alignments) ? alignments : [];
    for (const alignment of safeAlignments) {
        if (alignment?.kind !== 'underpass'
            || alignment.definition?.renderStructure === false) {
            continue;
        }
        const buildPlan = roadGradeSeparationBuildPlan(
            alignment,
            safeAlignments,
        );
        for (const range of alignment.crossingClearRanges || []) {
            const crossing = range?.crossing;
            if (crossing?.upperComposition?.mode !== 'rail'
                || crossing?.lowerComposition?.mode !== 'road') {
                continue;
            }
            const pointX = finiteOrNull(range.crossingPoint?.x);
            const pointZ = finiteOrNull(range.crossingPoint?.z);
            const direction = normalizedDirection(range.roadTangent);
            const crossingStationM = finiteOrNull(range.crossingStationM);
            const startM = finiteOrNull(range.startM);
            const endM = finiteOrNull(range.endM);
            const formationWidthM = finitePositive(
                crossing.lowerComposition.formationWidthM,
            );
            const fallbackFormationHalfWidthM = formationWidthM == null
                ? null
                : formationWidthM * 0.5;
            const wallThicknessM = finitePositive(
                buildPlan?.underpass?.wallThicknessM,
            ) || 0;
            const formationLeftM = finitePositive(buildPlan?.formationLeftM)
                || fallbackFormationHalfWidthM;
            const formationRightM = finitePositive(buildPlan?.formationRightM)
                || fallbackFormationHalfWidthM;
            if (pointX == null || pointZ == null || !direction
                || crossingStationM == null || startM == null || endM == null
                || formationLeftM == null || formationRightM == null) {
                continue;
            }
            const beforeM = Math.max(0, crossingStationM - startM) + apron;
            const afterM = Math.max(0, endM - crossingStationM) + apron;
            const leftM = formationLeftM + wallThicknessM + sideOverlap;
            const rightM = formationRightM + wallThicknessM + sideOverlap;
            const coordinate = crossing.coordinate || [];
            openings.push({
                key: [
                    alignment.id || 'road-underpass',
                    Number(coordinate[0]).toFixed(7),
                    Number(coordinate[1]).toFixed(7),
                ].join(':'),
                roadAlignmentId: alignment.id || null,
                x: pointX,
                z: pointZ,
                tangentX: direction.x,
                tangentZ: direction.z,
                beforeM,
                afterM,
                leftM,
                rightM,
                halfWidthM: Math.max(leftM, rightM),
                crossing,
            });
        }
    }
    return openings;
}

function intervalForAxis(start, end, minimum, maximum) {
    const delta = end - start;
    if (Math.abs(delta) < 1e-9) {
        return start >= minimum && start <= maximum ? [0, 1] : null;
    }
    const first = (minimum - start) / delta;
    const second = (maximum - start) / delta;
    return [Math.min(first, second), Math.max(first, second)];
}

function seamPoint(point) {
    const innerX = finiteOrNull(point?.innerX);
    const innerZ = finiteOrNull(point?.innerZ);
    const outerX = finiteOrNull(point?.outerX);
    const outerZ = finiteOrNull(point?.outerZ);
    if (innerX == null || innerZ == null || outerX == null || outerZ == null) {
        return null;
    }
    return {
        x: (innerX + outerX) * 0.5,
        z: (innerZ + outerZ) * 0.5,
    };
}

function pointInOpeningFrame(point, opening) {
    const dx = point.x - opening.x;
    const dz = point.z - opening.z;
    return {
        along: dx * opening.tangentX + dz * opening.tangentZ,
        across: dx * -opening.tangentZ + dz * opening.tangentX,
    };
}

export function formationBoundarySegmentIntersectsRoadOpening(
    startPoint,
    endPoint,
    opening,
) {
    return formationBoundarySegmentRoadOpeningInterval(
        startPoint,
        endPoint,
        opening,
    ) != null;
}

export function formationBoundarySegmentRoadOpeningInterval(
    startPoint,
    endPoint,
    opening,
) {
    const start = seamPoint(startPoint);
    const end = seamPoint(endPoint);
    const tangentLengthM = Math.hypot(
        Number(opening?.tangentX),
        Number(opening?.tangentZ),
    );
    const beforeM = finitePositive(opening?.beforeM);
    const afterM = finitePositive(opening?.afterM);
    const halfWidthM = finitePositive(opening?.halfWidthM);
    const leftM = finitePositive(opening?.leftM) || halfWidthM;
    const rightM = finitePositive(opening?.rightM) || halfWidthM;
    if (!start || !end || !(tangentLengthM > 0.999 && tangentLengthM < 1.001)
        || beforeM == null || afterM == null
        || leftM == null || rightM == null
        || finiteOrNull(opening?.x) == null || finiteOrNull(opening?.z) == null) {
        return null;
    }
    const a = pointInOpeningFrame(start, opening);
    const b = pointInOpeningFrame(end, opening);
    const alongInterval = intervalForAxis(a.along, b.along, -beforeM, afterM);
    const acrossInterval = intervalForAxis(
        a.across,
        b.across,
        -rightM,
        leftM,
    );
    if (!alongInterval || !acrossInterval) return null;
    const enter = Math.max(0, alongInterval[0], acrossInterval[0]);
    const exit = Math.min(1, alongInterval[1], acrossInterval[1]);
    return enter <= exit + 1e-9 ? [enter, exit] : null;
}

function mergedIntervals(intervals) {
    const sorted = intervals
        .filter(interval => (
            Array.isArray(interval)
            && finiteOrNull(interval[0]) != null
            && finiteOrNull(interval[1]) != null
        ))
        .map(interval => [
            Math.max(0, Math.min(1, Number(interval[0]))),
            Math.max(0, Math.min(1, Number(interval[1]))),
        ])
        .filter(interval => interval[1] >= interval[0] - 1e-9)
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [];
    for (const interval of sorted) {
        const previous = merged[merged.length - 1];
        if (!previous || interval[0] > previous[1] + 1e-9) {
            merged.push(interval);
        } else {
            previous[1] = Math.max(previous[1], interval[1]);
        }
    }
    return merged;
}

function sameIntervals(left, right) {
    return left.length === right.length && left.every((interval, index) => (
        Math.abs(interval[0] - right[index][0]) <= 1e-9
        && Math.abs(interval[1] - right[index][1]) <= 1e-9
    ));
}

function pointSegmentDistanceSquared(point, a, b) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSquared = dx * dx + dz * dz;
    const t = lengthSquared > 1e-9
        ? Math.max(0, Math.min(1,
            ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSquared,
        ))
        : 0;
    const nearestX = a.x + dx * t;
    const nearestZ = a.z + dz * t;
    return (point.x - nearestX) ** 2 + (point.z - nearestZ) ** 2;
}

function* sharedRetainedRoadBoundarySegmentsSteps(roadFormation, { now = () => performance.now(), isCurrent = () => true } = {}) {
    const segments = [];
    let started = now();
    for (const profile of roadFormation?.getSurfaceProfiles?.() || []) {
        if (now() - started >= .5) { yield { phase: 'road-boundary-profile' }; started = now(); }
        if (!isCurrent()) return null;
        if (!profile?.verticalRetainedWalls) continue;
        const points = profile.points || [];
        for (let index = 0; index < points.length; index++) {
            if (now() - started >= .5) { yield { phase: 'boundary-segment' }; started = now(); }
            if (!isCurrent()) return null;
            const a = points[index];
            const b = points[(index + 1) % points.length];
            if (a?.sharedRailRetainingBoundary !== true
                || b?.sharedRailRetainingBoundary !== true
                || a.railBoundarySide !== b.railBoundarySide
                || a.railFormationId !== b.railFormationId) continue;
            segments.push({
                a: { x: a.outerX, z: a.outerZ },
                b: { x: b.outerX, z: b.outerZ },
                railFormationId: a.railFormationId || null,
                railBoundarySide: a.railBoundarySide || null,
            });
            if (now() - started >= 0.5) { yield { phase: 'road-boundary' }; started = now(); }
        }
    }
    return segments;
}
// The road and rail solvers retain their own level benches, but a reviewed
// parallel interface has only ONE vertical face. Road profile points are first
// snapped to the declared rail wall plane; once both endpoints prove that
// shared plane, transfer the coincident rail face (and its outer terrain
// collar) to road ownership. Full-segment proof avoids opening a rail-wall gap
// at a streamed road endpoint. Idempotent flags survive subsequent mesh-only
// rebuilds just like level-crossing ownership.
export function flagRailFormationBoundarySegmentsForRetainedRoadInterfaces(
    railFormationOrProfiles,
    roadFormation,
    { maxSeparationM = 0.2 } = {},
) {
    return drainFlag(flagRailFormationBoundarySegmentsForRetainedRoadInterfacesSteps(railFormationOrProfiles, roadFormation, { maxSeparationM }));
}

function drainFlag(iterator) { let step; do step = iterator.next(); while (!step.done); return step.value; }

export function* flagRailFormationBoundarySegmentsForRetainedRoadInterfacesSteps(
    railFormationOrProfiles, roadFormation, { maxSeparationM = 0.2, now = () => performance.now(), isCurrent = () => true } = {},
) {
    const profiles = Array.isArray(railFormationOrProfiles)
        ? railFormationOrProfiles
        : railFormationOrProfiles?.getSurfaceProfiles?.() || [];
    const roadSegments = yield* sharedRetainedRoadBoundarySegmentsSteps(roadFormation, { now, isCurrent });
    if (!roadSegments) return null;
    if (roadSegments.length === 0) return 0;
    const maxDistanceSquared = Math.max(
        0,
        finiteOrNull(maxSeparationM) || 0,
    ) ** 2;
    let changed = 0; let started = now();
    for (const profile of profiles) {
        if (now() - started >= .5) { yield { phase: 'boundary-profile' }; started = now(); }
        if (!isCurrent()) return null;
        if (!profile?.verticalRetainedWalls) continue;
        const points = profile.points || [];
        const tags = profile.boundarySegmentTags || [];
        if (!Array.isArray(profile.sharedRetainingWallSegments)
            || profile.sharedRetainingWallSegments.length !== points.length) {
            profile.sharedRetainingWallSegments = new Array(points.length).fill(false);
        }
        for (let index = 0; index < points.length; index++) {
            if (now() - started >= .5) { yield { phase: 'boundary-segment' }; started = now(); }
            if (!isCurrent()) return null;
            if (profile.sharedRetainingWallSegments[index]) continue;
            const side = tags[index];
            if (side !== 'negative-normal' && side !== 'positive-normal') continue;
            const a = { x: points[index].outerX, z: points[index].outerZ };
            const bPoint = points[(index + 1) % points.length];
            const b = { x: bPoint.outerX, z: bPoint.outerZ };
            const midpoint = {
                x: (a.x + b.x) * 0.5,
                z: (a.z + b.z) * 0.5,
            };
            const candidates = [];
            for (const segment of roadSegments) {
                if (now() - started >= .5) { yield { phase: 'boundary-candidate' }; started = now(); }
                if (!isCurrent()) return null;
                if (segment.railBoundarySide === side && (!segment.railFormationId
                    || !profile.formationId || segment.railFormationId === profile.formationId)) candidates.push(segment);
            }
            if (candidates.length === 0) continue;
            let covered = true;
            for (const point of [a, midpoint, b]) {
                let found = false;
                for (const segment of candidates) {
                    if (now() - started >= .5) { yield { phase: 'boundary-distance' }; started = now(); }
                    if (!isCurrent()) return null;
                    if (pointSegmentDistanceSquared(point, segment.a, segment.b) <= maxDistanceSquared) { found = true; break; }
                }
                if (!found) { covered = false; break; }
            }
            if (!covered) continue;
            profile.sharedRetainingWallSegments[index] = true;
            changed += 1;
            if (now() - started >= 0.5) { yield { phase: 'retained' }; started = now(); }
        }
    }
    if (!isCurrent()) return null;
    return changed;
}

export function flagRailFormationBoundarySegmentsForRoadOpenings(
    railFormationOrProfiles,
    openings = [],
) {
    return drainFlag(flagRailFormationBoundarySegmentsForRoadOpeningsSteps(railFormationOrProfiles, openings));
}

export function* flagRailFormationBoundarySegmentsForRoadOpeningsSteps(
    railFormationOrProfiles, openings = [], { now = () => performance.now(), isCurrent = () => true } = {},
) {
    const profiles = Array.isArray(railFormationOrProfiles)
        ? railFormationOrProfiles
        : railFormationOrProfiles?.getSurfaceProfiles?.() || [];
    const safeOpenings = Array.isArray(openings) ? openings : [];
    if (safeOpenings.length === 0) return 0;
    let suppressed = 0; let started = now();
    for (const profile of profiles) {
        if (now() - started >= .5) { yield { phase: 'boundary-profile' }; started = now(); }
        if (!isCurrent()) return null;
        const points = profile?.points;
        const flags = profile?.internalSegments;
        if (!Array.isArray(points) || points.length < 2 || !Array.isArray(flags)) continue;
        if (!Array.isArray(profile.roadOpeningSegmentRanges)
            || profile.roadOpeningSegmentRanges.length !== points.length) {
            profile.roadOpeningSegmentRanges = Array.from(
                { length: points.length },
                () => [],
            );
        }
        for (let index = 0; index < points.length; index++) {
            if (now() - started >= .5) { yield { phase: 'boundary-segment' }; started = now(); }
            if (!isCurrent()) return null;
            if (flags[index]) continue;
            const nextIndex = (index + 1) % points.length;
            const additions = [];
            for (const opening of safeOpenings) {
                if (now() - started >= .5) { yield { phase: 'opening' }; started = now(); }
                if (!isCurrent()) return null;
                const interval = formationBoundarySegmentRoadOpeningInterval(points[index], points[nextIndex], opening);
                if (interval && interval[1] - interval[0] > 1e-9) additions.push(interval);
            }
            if (additions.length === 0) continue;
            const previous = profile.roadOpeningSegmentRanges[index];
            const next = mergedIntervals([
                ...previous,
                ...additions,
            ]);
            if (sameIntervals(previous, next)) continue;
            profile.roadOpeningSegmentRanges[index] = next;
            suppressed += 1;
        }
    }
    // The signature belongs to this caller-owned mutable generation.
    if (suppressed > 0) noteRailCivilGroundMutation(railFormationOrProfiles);
    if (!isCurrent()) return null;
    return suppressed;
}
