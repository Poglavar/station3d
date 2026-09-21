// Immutable plan footprints for the trackbed geometry actually rendered by
// world/rails.js. Engineered formations describe earthworks, but ordinary OSM
// street-running tram chords deliberately ride a road/terrain height and have
// no formation profile of their own. These exact surface strips close that
// hierarchy gap without inventing a second vertical alignment.

import { TERRAIN_EXCAVATION_MIN_DEPTH_M } from './formation-excavation.js';
import { createBoundsGridSteps } from './bounds-grid.js';
import { pointInRing } from './mask-query.js';
import { isOrdinaryOsmTramFeature } from './rail-road-grade-separation.js';
import { extendViaductDeckSamplesSteps } from './rail-viaduct-deck.js';
import {
    VIADUCT_DECK_EDGE_MARGIN_M,
    VIADUCT_DECK_TOP_BELOW_TRACKBED_M,
    viaductDeckHalfWidthM,
    viaductSampleJoinsSteps,
} from './viaduct-parapet.js';
import {
    GROUND_SURFACE_LEVELS,
    SURFACE_CLASS,
    SURFACE_COVERAGE_STATE,
    SURFACE_VERTICAL_RELATION,
    compileSurfaceClaim,
    surfaceClaimMayCutBackstop,
    surfaceClaimMayPaintOver,
} from './surface-hierarchy.js';

function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function endpointJoin(segment, endpoint) {
    const prefix = endpoint === 'start' ? 'start' : 'end';
    const x = finite(segment?.[`${prefix}JoinX`]);
    const z = finite(segment?.[`${prefix}JoinZ`]);
    if (x !== null && z !== null && Math.hypot(x, z) > 1e-6) return { x, z };
    const x1 = finite(segment?.x1);
    const z1 = finite(segment?.z1);
    const x2 = finite(segment?.x2);
    const z2 = finite(segment?.z2);
    if (x1 === null || z1 === null || x2 === null || z2 === null) return null;
    const dx = x2 - x1;
    const dz = z2 - z1;
    const length = Math.hypot(dx, dz);
    return length > 1e-6 ? { x: dz / length, z: -dx / length } : null;
}

function propertiesOf(segment) {
    return segment?.feature?.properties || segment?.properties || {};
}

function affirmative(value) {
    if (value === true || value === 1) return true;
    return ['yes', 'true', '1'].includes(String(value ?? '').trim().toLowerCase());
}

// A bored tunnel intentionally keeps its terrain roof. Mixed portal chords are
// left to the engineered portal-opening contract rather than having their full
// rendered strip punch a rectangular hole through the hill.
export function renderedRailSegmentKeepsTerrainRoof(segment) {
    const properties = propertiesOf(segment);
    const structures = [
        segment?.structureStart,
        segment?.structureEnd,
        properties.railStructure,
        properties.rail_structure,
        properties.structure,
    ].map(value => String(value ?? '').trim().toLowerCase());
    return structures.includes('tunnel') || affirmative(properties.tunnel);
}

// Only ordinary street-running OSM tram is allowed to use a plan footprint as
// final civil-surface ownership. Its vertical alignment is explicitly borrowed
// from the nearby road/terrain, so asphalt and buffered sidewalk polygons at
// the same level must stop at the visible paver edge. Structural tram and
// engineered railway can cross another road at a different elevation; those
// keep using their formation/grade-separation contracts instead of a plan-only
// exclusion that would punch a hole through the lower surface.
export function renderedRailSegmentOwnsCivilGround(segment) {
    return !renderedRailSegmentKeepsTerrainRoof(segment)
        && isOrdinaryOsmTramFeature(segment);
}

function renderedRailSegmentVerticalRelation(segment) {
    const properties = propertiesOf(segment);
    const structures = [
        segment?.structureStart,
        segment?.structureEnd,
        properties.railStructure,
        properties.rail_structure,
        properties.structure,
    ].map(value => String(value ?? '').trim().toLowerCase());
    const layer = Number(properties.layer);
    return structures.some(value => ['viaduct', 'bridge', 'tunnel'].includes(value))
        || affirmative(properties.bridge)
        || affirmative(properties.tunnel)
        || (Number.isFinite(layer) && layer !== 0)
        ? SURFACE_VERTICAL_RELATION.GRADE_SEPARATED
        : SURFACE_VERTICAL_RELATION.SAME_LEVEL;
}

function renderedRailSurfaceClaim({
    coverageState,
    verticalRelation,
    ownerId = null,
}) {
    return compileSurfaceClaim({
        surfaceClass: SURFACE_CLASS.RAIL_TRACKBED,
        coverageState,
        verticalRelation,
        verticalBand: verticalRelation === SURFACE_VERTICAL_RELATION.SAME_LEVEL
            ? 'ground'
            : null,
        ownerId,
        sourceId: 'world/rails.js',
        supportReady: coverageState === SURFACE_COVERAGE_STATE.PUBLISHED,
        cutsBackstop: true,
    });
}

function viaductTerrainCutoutClaim({
    coverageState,
    ownerId = null,
}) {
    const published = coverageState === SURFACE_COVERAGE_STATE.PUBLISHED;
    return compileSurfaceClaim({
        surfaceClass: SURFACE_CLASS.STRUCTURE,
        coverageState: published
            ? SURFACE_COVERAGE_STATE.INTENTIONAL_OPENING
            : coverageState,
        verticalRelation: SURFACE_VERTICAL_RELATION.GRADE_SEPARATED,
        ownerId,
        sourceId: 'world/rails.js:viaduct-deck-terrain-cutout',
        replacementKey: ownerId,
        replacementBackstopReady: published,
        supportReady: published,
        cutsBackstop: true,
        paintsColor: false,
    });
}

function ringBounds(ring) {
    return ring.reduce((bounds, point) => ({
        minX: Math.min(bounds.minX, point.x),
        minZ: Math.min(bounds.minZ, point.z),
        maxX: Math.max(bounds.maxX, point.x),
        maxZ: Math.max(bounds.maxZ, point.z),
    }), {
        minX: Infinity,
        minZ: Infinity,
        maxX: -Infinity,
        maxZ: -Infinity,
    });
}

function surfacePoint(segment, endpoint, offsetM, surfaceOffsetM) {
    const atEnd = endpoint === 'end';
    const join = endpointJoin(segment, endpoint);
    const x = finite(atEnd ? segment?.x2 : segment?.x1);
    const z = finite(atEnd ? segment?.z2 : segment?.z1);
    const baseY = finite(atEnd ? segment?.yEnd : segment?.yStart);
    if (!join || x === null || z === null || baseY === null) return null;
    return {
        x: x + join.x * offsetM,
        y: baseY + surfaceOffsetM,
        z: z + join.z * offsetM,
    };
}

function segmentSurfaceRegions(segment, surfaceOffsetM, coverageState) {
    if (renderedRailSegmentKeepsTerrainRoof(segment)) return [];
    const ownsCivilGround = renderedRailSegmentOwnsCivilGround(segment);
    const verticalRelation = renderedRailSegmentVerticalRelation(segment);
    const surfaceClaim = renderedRailSurfaceClaim({
        coverageState,
        verticalRelation,
        ownerId: segment?.sortKey ?? null,
    });
    const startHalf = finite(segment?.startTrackbedHalfWidthM);
    const endHalf = finite(segment?.endTrackbedHalfWidthM);
    if (!(startHalf > 0) || !(endHalf > 0)) return [];
    const startInner = Math.max(0, finite(segment?.startTrackbedInnerEdgeM) || 0);
    const endInner = Math.max(0, finite(segment?.endTrackbedInnerEdgeM) || 0);
    if (startInner <= 1e-6 && endInner <= 1e-6) {
        const ring = [
            surfacePoint(segment, 'start', -startHalf, surfaceOffsetM),
            surfacePoint(segment, 'end', -endHalf, surfaceOffsetM),
            surfacePoint(segment, 'end', endHalf, surfaceOffsetM),
            surfacePoint(segment, 'start', startHalf, surfaceOffsetM),
        ];
        if (ring.some(point => !point)) return [];
        return [{
            ring,
            bounds: ringBounds(ring),
            kind: 'trackbed-strip',
            segmentKey: segment?.sortKey ?? null,
            ownsCivilGround,
            coverageState,
            verticalRelation,
            surfaceClaim,
        }];
    }
    const regions = [];
    for (const side of [-1, 1]) {
        const startOuter = side * startHalf;
        const endOuter = side * endHalf;
        const startInnerOffset = side * startInner;
        const endInnerOffset = side * endInner;
        const ring = side < 0
            ? [
                surfacePoint(segment, 'start', startOuter, surfaceOffsetM),
                surfacePoint(segment, 'end', endOuter, surfaceOffsetM),
                surfacePoint(segment, 'end', endInnerOffset, surfaceOffsetM),
                surfacePoint(segment, 'start', startInnerOffset, surfaceOffsetM),
            ]
            : [
                surfacePoint(segment, 'start', startInnerOffset, surfaceOffsetM),
                surfacePoint(segment, 'end', endInnerOffset, surfaceOffsetM),
                surfacePoint(segment, 'end', endOuter, surfaceOffsetM),
                surfacePoint(segment, 'start', startOuter, surfaceOffsetM),
            ];
        if (ring.some(point => !point)) continue;
        regions.push({
            ring,
            bounds: ringBounds(ring),
            kind: 'trackbed-strip',
            segmentKey: segment?.sortKey ?? null,
            ownsCivilGround,
            coverageState,
            verticalRelation,
            surfaceClaim,
        });
    }
    return regions;
}

function junctionSurfaceRegions(
    segments,
    surfaceOffsetM,
    steps,
    { nodeKeys = null, coverageState = SURFACE_COVERAGE_STATE.PLANNED } = {},
) {
    const selectedNodes = nodeKeys == null ? null : new Set(nodeKeys);
    const incidentsByNode = new Map();
    for (const segment of segments || []) {
        if (renderedRailSegmentKeepsTerrainRoof(segment)) continue;
        for (const endpoint of ['start', 'end']) {
            const key = segment?.[`${endpoint}Key`];
            const halfWidthM = finite(segment?.[`${endpoint}TrackbedHalfWidthM`]);
            const x = finite(endpoint === 'start' ? segment?.x1 : segment?.x2);
            const z = finite(endpoint === 'start' ? segment?.z1 : segment?.z2);
            const y = finite(endpoint === 'start' ? segment?.yStart : segment?.yEnd);
            if (key == null || !(halfWidthM > 0)
                || x === null || z === null || y === null) continue;
            const incidents = incidentsByNode.get(key) || [];
            incidents.push({
                x,
                z,
                y: y + surfaceOffsetM,
                halfWidthM,
                ownsCivilGround: renderedRailSegmentOwnsCivilGround(segment),
                verticalRelation: renderedRailSegmentVerticalRelation(segment),
            });
            incidentsByNode.set(key, incidents);
        }
    }
    const regions = [];
    for (const [nodeKey, incidents] of incidentsByNode) {
        if (selectedNodes && !selectedNodes.has(nodeKey)) continue;
        if (incidents.length <= 2) continue;
        const center = incidents[0];
        const radius = Math.max(...incidents.map(incident => incident.halfWidthM));
        const y = incidents.reduce((sum, incident) => sum + incident.y, 0)
            / incidents.length + 0.0005;
        const ring = [];
        for (let step = 0; step < steps; step += 1) {
            const angle = step / steps * Math.PI * 2;
            ring.push({
                x: center.x + Math.cos(angle) * radius,
                y,
                z: center.z + Math.sin(angle) * radius,
            });
        }
        regions.push({
            ring,
            bounds: ringBounds(ring),
            kind: 'trackbed-junction',
            nodeKey,
            // A mixed at-grade/structural node can sit at the lip of an
            // overpass. Require every incident to be ordinary before allowing
            // a plan-only road exclusion at the shared junction patch.
            ownsCivilGround: incidents.every(incident => incident.ownsCivilGround),
            coverageState,
            verticalRelation: incidents.every(incident => (
                incident.verticalRelation === SURFACE_VERTICAL_RELATION.SAME_LEVEL
            ))
                ? SURFACE_VERTICAL_RELATION.SAME_LEVEL
                : SURFACE_VERTICAL_RELATION.GRADE_SEPARATED,
        });
        const region = regions[regions.length - 1];
        region.surfaceClaim = renderedRailSurfaceClaim({
            coverageState,
            verticalRelation: region.verticalRelation,
            ownerId: nodeKey,
        });
    }
    return regions;
}

export function buildRenderedRailSurfaceRegions(
    segments,
    {
        surfaceOffsetM = 0,
        junctionSteps = 24,
        coverageState = SURFACE_COVERAGE_STATE.PLANNED,
        junctionSegments = null,
        junctionNodeKeys = null,
    } = {},
) {
    const offset = finite(surfaceOffsetM) || 0;
    const list = Array.isArray(segments) ? segments : [];
    const regions = list.flatMap(segment => (
        segmentSurfaceRegions(segment, offset, coverageState)
    ));
    regions.push(...junctionSurfaceRegions(
        Array.isArray(junctionSegments) ? junctionSegments : list,
        offset,
        Math.max(8, Math.floor(finite(junctionSteps) || 24)),
        {
            nodeKeys: junctionNodeKeys,
            coverageState,
        },
    ));
    return regions;
}

// Full opaque footprints of the concrete slabs that replace DGU terrain where
// it physically intrudes above a viaduct. These are deliberately separate from
// the two narrow trackbed strips: cutting only those strips leaves a terrain
// ridge between the tracks and along both evacuation walkways.
export function buildViaductTerrainCutoutRegions(runs, options) {
    const steps = buildViaductTerrainCutoutRegionsSteps(runs, options);
    let next; do { next = steps.next(); } while (!next.done);
    return next.value;
}

export function* buildViaductTerrainCutoutRegionsSteps(
    runs,
    {
        trackbedSurfaceOffsetM = GROUND_SURFACE_LEVELS.tramBed,
        edgeMarginM = VIADUCT_DECK_EDGE_MARGIN_M,
        endpointOverlapM = 1.5,
        coverageState = SURFACE_COVERAGE_STATE.PUBLISHED,
        now = () => performance.now(), isCurrent = () => true,
    } = {},
) {
    const regions = [];
    let started = now();
    if (!isCurrent()) return null;
    for (let runIndex = 0; runIndex < (runs || []).length; runIndex += 1) {
        if (now() - started >= .5) {
            yield { phase: 'rail-viaduct-runs' }; started = now();
            if (!isCurrent()) return null;
        }
        const run = runs[runIndex];
        const samples = yield* extendViaductDeckSamplesSteps(
            run?.samples || [], run, endpointOverlapM, { now, isCurrent },
        );
        if (!samples) return null;
        if (samples.length < 2) continue;
        const trackbedHalfWidthM = finite(run?.alignment?.halfWidthM);
        if (!(trackbedHalfWidthM > 0)) continue;
        const halfWidthM = viaductDeckHalfWidthM(
            trackbedHalfWidthM,
            Math.max(0, finite(edgeMarginM) || 0),
        );
        const joins = yield* viaductSampleJoinsSteps(samples, { now, isCurrent });
        if (!joins) return null;
        const topOffsetM = (finite(trackbedSurfaceOffsetM) || 0)
            - VIADUCT_DECK_TOP_BELOW_TRACKBED_M;
        for (let sampleIndex = 0; sampleIndex + 1 < samples.length; sampleIndex += 1) {
            if (now() - started >= .5) {
                yield { phase: 'rail-viaduct-quads' }; started = now();
                if (!isCurrent()) return null;
            }
            const start = samples[sampleIndex];
            const end = samples[sampleIndex + 1];
            const startJoin = joins[sampleIndex];
            const endJoin = joins[sampleIndex + 1];
            if (!startJoin || !endJoin
                || ![start?.x, start?.z, start?.railY, end?.x, end?.z, end?.railY]
                    .every(value => finite(value) !== null)) continue;
            const ring = [
                {
                    x: start.x - startJoin.x * halfWidthM,
                    y: start.railY + topOffsetM,
                    z: start.z - startJoin.z * halfWidthM,
                },
                {
                    x: end.x - endJoin.x * halfWidthM,
                    y: end.railY + topOffsetM,
                    z: end.z - endJoin.z * halfWidthM,
                },
                {
                    x: end.x + endJoin.x * halfWidthM,
                    y: end.railY + topOffsetM,
                    z: end.z + endJoin.z * halfWidthM,
                },
                {
                    x: start.x + startJoin.x * halfWidthM,
                    y: start.railY + topOffsetM,
                    z: start.z + startJoin.z * halfWidthM,
                },
            ];
            const segmentKey = `viaduct:${runIndex}:${sampleIndex}`;
            regions.push({
                ring,
                bounds: ringBounds(ring),
                kind: 'viaduct-deck-terrain-cutout',
                segmentKey,
                ownsCivilGround: false,
                coverageState,
                verticalRelation: SURFACE_VERTICAL_RELATION.GRADE_SEPARATED,
                surfaceClaim: viaductTerrainCutoutClaim({
                    coverageState,
                    ownerId: segmentKey,
                }),
            });
        }
    }
    return isCurrent() ? regions : null;
}

function interpolatedRegionSamples(ring) {
    const samples = [...ring];
    let centerX = 0;
    let centerY = 0;
    let centerZ = 0;
    for (let index = 0; index < ring.length; index += 1) {
        const a = ring[index];
        const b = ring[(index + 1) % ring.length];
        centerX += a.x;
        centerY += a.y;
        centerZ += a.z;
        samples.push({
            x: (a.x + b.x) * 0.5,
            y: (a.y + b.y) * 0.5,
            z: (a.z + b.z) * 0.5,
        });
    }
    samples.push({
        x: centerX / ring.length,
        y: centerY / ring.length,
        z: centerZ / ring.length,
    });
    return samples;
}

// True only when immutable terrain physically intrudes above the rendered
// trackbed. Fill keeps its terrain backstop; a cut removes exactly the visible
// strip, never the broader road/formation envelope.
export function renderedRailSurfaceRegionCutsTerrain(
    region,
    terrainSceneYAtLocal,
    { minDepthM = TERRAIN_EXCAVATION_MIN_DEPTH_M } = {},
) {
    const ring = Array.isArray(region?.ring) ? region.ring : [];
    if (ring.length < 3) return false;
    const railClaim = region?.surfaceClaim || renderedRailSurfaceClaim({
        coverageState: region?.coverageState || SURFACE_COVERAGE_STATE.PLANNED,
        verticalRelation: region?.verticalRelation || SURFACE_VERTICAL_RELATION.UNKNOWN,
        ownerId: region?.segmentKey || region?.nodeKey || null,
    });
    if (!surfaceClaimMayCutBackstop(railClaim, {
        surfaceClass: SURFACE_CLASS.TERRAIN,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalBand: 'ground',
        supportReady: true,
    }, {
        verticalRelation: region?.verticalRelation || SURFACE_VERTICAL_RELATION.UNKNOWN,
    })) return false;
    if (region?.terrainCutoutActive === true) return true;
    if (region?.terrainCutoutActive === false
        || typeof terrainSceneYAtLocal !== 'function') return false;
    const threshold = Math.max(0, finite(minDepthM) || 0);
    return interpolatedRegionSamples(ring).some((point) => {
        const terrainY = finite(terrainSceneYAtLocal(point.x, point.z));
        return terrainY !== null && terrainY - point.y >= threshold;
    });
}

export function activateRenderedRailTerrainCutoutRegions(
    regions,
    terrainSceneYAtLocal,
    options = {},
) {
    return (regions || []).flatMap((region) => (
        renderedRailSurfaceRegionCutsTerrain(region, terrainSceneYAtLocal, options)
            ? [{ ...region, terrainCutoutActive: true }]
            : []
    ));
}

export function activateViaductTerrainCutoutRegions(
    regions,
    terrainSceneYAtLocal,
    options = {},
) {
    return activateRenderedRailTerrainCutoutRegions(
        regions,
        terrainSceneYAtLocal,
        options,
    );
}

// Content identity for the supplemental kilometre-scale ownership input. Rail
// render cells publish independently, so their broad revision must not rebuild
// a 3072px terrain mask unless the active viaduct replacement itself changed.
export function renderedRailTerrainCutoutRegionsSignature(regions) {
    const steps = renderedRailTerrainCutoutRegionsSignatureSteps(regions);
    let next; do { next = steps.next(); } while (!next.done);
    return next.value;
}

export function* renderedRailTerrainCutoutRegionsSignatureSteps(regions, {
    now = () => performance.now(), isCurrent = () => true,
} = {}) {
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    const mix = (word) => {
        const value = Number(word) | 0;
        first = Math.imul(first ^ value, 0x01000193);
        second = Math.imul(second ^ value, 0x85ebca6b);
    };
    const list = Array.isArray(regions) ? regions : [];
    mix(list.length);
    let started = now();
    if (!isCurrent()) return null;
    for (const region of list) {
        if (now() - started >= .5) {
            yield { phase: 'rail-cutout-signature' }; started = now();
            if (!isCurrent()) return null;
        }
        const ring = Array.isArray(region?.ring) ? region.ring : [];
        mix(ring.length);
        for (const point of ring) {
            if (now() - started >= .5) {
                yield { phase: 'rail-cutout-signature-points' }; started = now();
                if (!isCurrent()) return null;
            }
            mix(Math.round((finite(point?.x) || 0) * 1000));
            mix(Math.round((finite(point?.y) || 0) * 1000));
            mix(Math.round((finite(point?.z) || 0) * 1000));
        }
    }
    if (!isCurrent()) return null;
    return `${list.length}:${(first >>> 0).toString(16).padStart(8, '0')}`
        + `${(second >>> 0).toString(16).padStart(8, '0')}`;
}

export function viaductTerrainCutoutRegionsSignature(regions) {
    return renderedRailTerrainCutoutRegionsSignature(regions);
}

function triangleSurfaceYAtLocal(point, a, b, c) {
    const denominator = (b.z - c.z) * (a.x - c.x)
        + (c.x - b.x) * (a.z - c.z);
    if (Math.abs(denominator) <= 1e-9) return null;
    const wa = ((b.z - c.z) * (point.x - c.x)
        + (c.x - b.x) * (point.z - c.z)) / denominator;
    const wb = ((c.z - a.z) * (point.x - c.x)
        + (a.x - c.x) * (point.z - c.z)) / denominator;
    const wc = 1 - wa - wb;
    const epsilon = 1e-6;
    if (wa < -epsilon || wb < -epsilon || wc < -epsilon) return null;
    return a.y * wa + b.y * wb + c.y * wc;
}

function regionSurfaceYAtLocal(region, x, z) {
    const ring = region?.ring || [];
    if (ring.length < 3) return null;
    const point = { x, z };
    for (let index = 1; index + 1 < ring.length; index += 1) {
        const y = triangleSurfaceYAtLocal(point, ring[0], ring[index], ring[index + 1]);
        if (y !== null) return y;
    }
    return null;
}

export function createRenderedRailSurfaceMaskModelFromRegions(sourceRegions, options) {
    const steps = createRenderedRailSurfaceMaskModelFromRegionsSteps(sourceRegions, options);
    let next; do { next = steps.next(); } while (!next.done);
    return next.value;
}

// A private immutable coverage index can be prepared beside the visible cell
// group. Both ring coordinates and membership belong to this generation.
export function* createRenderedRailSurfaceMaskModelFromRegionsSteps(
    sourceRegions,
    {
        revision = 0, terrainCutoutRegions = [], terrainCutoutRevision = 0,
        viaductTerrainCutoutRegions = [], viaductTerrainCutoutRevision = 0,
        onPublished = null, now = () => performance.now(), isCurrent = () => true,
    } = {},
) {
    if (!isCurrent()) return null;
    const captured = new Map();
    let started = now();
    function* capture(region) {
        if (captured.has(region)) return captured.get(region);
        const ring = [];
        for (const point of region.ring || []) {
            if (now() - started >= .5) {
                yield { phase: 'rail-coverage-coordinates' }; started = now();
                if (!isCurrent()) return null;
            }
            ring.push(Object.freeze({ ...point }));
        }
        const value = Object.freeze({ ...region, bounds: Object.freeze({ ...region.bounds }),
            ring: Object.freeze(ring), ...(region.surfaceClaim
                ? { surfaceClaim: Object.freeze({ ...region.surfaceClaim }) } : {}) });
        captured.set(region, value);
        return value;
    }
    const activeTerrainCutouts = [], viaductRegions = [], regions = [], civilGroundRegions = [];
    // Capture membership before any yield; producers retain decoded geometry
    // until their candidate is completed or rejected by isCurrent.
    const inputs = [Array.isArray(terrainCutoutRegions) ? terrainCutoutRegions.slice() : [],
        Array.isArray(viaductTerrainCutoutRegions) ? viaductTerrainCutoutRegions.slice() : [],
        Array.isArray(sourceRegions) ? sourceRegions.slice() : []];
    for (const [family, input] of inputs.entries()) {
        for (const region of input) {
            if (now() - started >= .5) {
                yield { phase: 'rail-coverage-regions' }; started = now();
                if (!isCurrent()) return null;
            }
            if (region?.coverageState !== SURFACE_COVERAGE_STATE.PUBLISHED
                || (family < 2 && region.terrainCutoutActive !== true)) continue;
            const value = yield* capture(region);
            if (!value) return null;
            if (family === 0) activeTerrainCutouts.push(value);
            else if (family === 1) viaductRegions.push(value);
            else regions.push(value);
        }
    }
    // Preserve the established source-first order for height-aware queries.
    for (const region of viaductRegions) regions.push(region);
    for (const region of regions) {
        if (now() - started >= .5) {
            yield { phase: 'rail-coverage-authority' }; started = now();
            if (!isCurrent()) return null;
        }
        if (region.ownsCivilGround === true && surfaceClaimMayPaintOver(
            region.surfaceClaim || renderedRailSurfaceClaim({ coverageState: region.coverageState,
                verticalRelation: region.verticalRelation, ownerId: region.segmentKey || region.nodeKey || null }),
            { surfaceClass: SURFACE_CLASS.ROAD_CARRIAGEWAY, coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
                verticalBand: 'ground', supportReady: true },
            { verticalRelation: region.verticalRelation },
        )) civilGroundRegions.push(region);
    }
    for (const list of [activeTerrainCutouts, viaductRegions, regions, civilGroundRegions]) Object.freeze(list);
    const regionsNear = (source, centerX, centerZ, radiusM) => {
        const x = finite(centerX);
        const z = finite(centerZ);
        const radius = Math.max(0, finite(radiusM) || 0);
        if (x === null || z === null) return [];
        return source.filter(({ bounds }) => !(
            bounds.maxX < x - radius
            || bounds.minX > x + radius
            || bounds.maxZ < z - radius
            || bounds.minZ > z + radius
        ));
    };
    const modelRevision = Number(revision) || 0;
    const terrainRevision = Number(terrainCutoutRevision) || 0;
    const viaductRevision = Number(viaductTerrainCutoutRevision) || 0;
    function* index(list) {
        const steps = createBoundsGridSteps(list, { now });
        try {
            for (;;) {
                if (!isCurrent()) return null;
                const next = steps.next();
                if (next.done) return next.value;
                yield { phase: 'rail-coverage-index' };
            }
        } finally { steps.return(); }
    }
    const civilGroundGrid = yield* index(civilGroundRegions);
    const terrainCutoutGrid = yield* index(activeTerrainCutouts);
    const viaductGrid = yield* index(viaductRegions);
    if (!civilGroundGrid || !terrainCutoutGrid || !viaductGrid || !isCurrent()) return null;
    captured.clear();
    let publicationNotified = false;
    return Object.freeze({
        revision: modelRevision,
        terrainCutoutRevision: terrainRevision,
        viaductTerrainCutoutRevision: viaductRevision,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        getTerrainSurfaceRegions() {
            return regions;
        },
        terrainSurfaceRegionsNear(centerX, centerZ, radiusM) {
            return regionsNear(regions, centerX, centerZ, radiusM);
        },
        getCivilGroundSurfaceRegions() {
            return civilGroundRegions;
        },
        civilGroundSurfaceRegionsNear(centerX, centerZ, radiusM) {
            return regionsNear(civilGroundRegions, centerX, centerZ, radiusM);
        },
        civilGroundSurfaceAtLocal(localX, localZ) {
            const x = finite(localX);
            const z = finite(localZ);
            if (x === null || z === null) return null;
            for (const region of civilGroundGrid.candidatesAt(x, z)) {
                const bounds = region.bounds;
                if (x < bounds.minX || x > bounds.maxX
                    || z < bounds.minZ || z > bounds.maxZ
                    || !pointInRing(x, z, region.ring)) continue;
                const sceneY = regionSurfaceYAtLocal(region, x, z);
                if (sceneY !== null) return { region, sceneY };
            }
            return null;
        },
        getTerrainCutoutRegions() {
            return activeTerrainCutouts;
        },
        terrainCutoutRegionsNear(centerX, centerZ, radiusM) {
            return regionsNear(activeTerrainCutouts, centerX, centerZ, radiusM);
        },
        terrainCutoutAtLocal(localX, localZ) {
            const x = finite(localX);
            const z = finite(localZ);
            if (x === null || z === null) return null;
            for (const region of terrainCutoutGrid.candidatesAt(x, z)) {
                const bounds = region.bounds;
                if (x < bounds.minX || x > bounds.maxX
                    || z < bounds.minZ || z > bounds.maxZ
                    || !pointInRing(x, z, region.ring)) continue;
                const sceneY = regionSurfaceYAtLocal(region, x, z);
                if (sceneY !== null) return { region, sceneY };
            }
            return null;
        },
        getViaductTerrainCutoutRegions() {
            return viaductRegions;
        },
        viaductTerrainCutoutRegionsNear(centerX, centerZ, radiusM) {
            return regionsNear(viaductRegions, centerX, centerZ, radiusM);
        },
        viaductTerrainCutoutAtLocal(localX, localZ) {
            const x = finite(localX);
            const z = finite(localZ);
            if (x === null || z === null) return null;
            for (const region of viaductGrid.candidatesAt(x, z)) {
                const bounds = region.bounds;
                if (x < bounds.minX || x > bounds.maxX
                    || z < bounds.minZ || z > bounds.maxZ
                    || !pointInRing(x, z, region.ring)) continue;
                const sceneY = regionSurfaceYAtLocal(region, x, z);
                if (sceneY !== null) return { region, sceneY };
            }
            return null;
        },
        onGroundMaskPublished() {
            if (publicationNotified) return;
            publicationNotified = true;
            if (typeof onPublished === 'function') onPublished(modelRevision);
        },
    });
}

export function createRenderedRailSurfaceMaskModel(
    segments,
    {
        revision = 0,
        surfaceOffsetM = 0,
        junctionSteps = 24,
        coverageState = SURFACE_COVERAGE_STATE.PLANNED,
        junctionSegments = null,
        junctionNodeKeys = null,
        onPublished = null,
    } = {},
) {
    return createRenderedRailSurfaceMaskModelFromRegions(
        buildRenderedRailSurfaceRegions(segments, {
            surfaceOffsetM,
            junctionSteps,
            coverageState,
            junctionSegments,
            junctionNodeKeys,
        }),
        { revision, onPublished },
    );
}
