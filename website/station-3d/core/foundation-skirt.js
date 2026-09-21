// Pure geometry for a building's "draped foundation" skirt: a vertical band
// wrapped around a footprint from the flat building base (a single top Y) DOWN
// to the terrain at each footprint vertex. On flat ground the band has ~zero
// height (invisible); on a slope it fills the gap under the downhill side so a
// terrain-draped building never floats. No THREE / DOM here — buildings.js
// wraps the returned arrays in a BufferGeometry.

// A footprint edge whose two endpoints both sit within this of the base carries
// no visible band, so it is skipped (flat ground → no skirt).
export const SKIRT_FLAT_EPSILON_M = 0.03;
export const FOUNDATION_SKIRT_PIECES_PER_STAGE = 16;
export const FOUNDATION_SKIRT_BUFFER_VALUES_PER_STAGE = 8192;
export const FOUNDATION_SKIRT_SEGMENT_UNITS_PER_STAGE = 64;

// GDI/LiDAR buildings arrive as independent surveyed wall polygons rather
// than a ready-made footprint ring. Recover the same boundary-segment contract
// used by footprint buildings from the ground-touching wall descriptors. Keep
// this pure so both the pedestrian/building registry and the render-time
// foundation skirt consume exactly the same outline.
export function* foundationSegmentsFromWallFacesCooperative(faces, center, {
    unitsPerStage = FOUNDATION_SKIRT_SEGMENT_UNITS_PER_STAGE,
} = {}) {
    if (!Array.isArray(faces) || !center) return [];
    const centerX = Number(center.x);
    const centerZ = Number(center.z);
    if (!Number.isFinite(centerX) || !Number.isFinite(centerZ)) return [];
    const segments = [];
    const seen = new Set();
    const stageUnits = Math.max(1, Math.floor(Number(unitsPerStage) || 1));
    let unitsSinceYield = 0;
    for (const face of faces) {
        if (unitsSinceYield >= stageUnits) {
            unitsSinceYield = 0;
            yield { phase: 'foundation-skirt-segments' };
        }
        unitsSinceYield += 1;
        const nx = Number(face?.nx);
        const nz = Number(face?.nz);
        const d = Number(face?.d);
        const uMin = Number(face?.uMin);
        const uMax = Number(face?.uMax);
        if (![nx, nz, d, uMin, uMax].every(Number.isFinite)) continue;
        const tx = nz;
        const tz = -nx;
        const ax = d * nx + uMin * tx;
        const az = d * nz + uMin * tz;
        const bx = d * nx + uMax * tx;
        const bz = d * nz + uMax * tz;
        if (![ax, az, bx, bz].every(Number.isFinite)
            || Math.hypot(bx - ax, bz - az) < 0.2) continue;
        const endpointA = `${Math.round(ax * 20)}:${Math.round(az * 20)}`;
        const endpointB = `${Math.round(bx * 20)}:${Math.round(bz * 20)}`;
        const key = endpointA < endpointB
            ? `${endpointA}|${endpointB}`
            : `${endpointB}|${endpointA}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const midX = (ax + bx) * 0.5;
        const midZ = (az + bz) * 0.5;
        const centerSign = nx * (midX - centerX) + nz * (midZ - centerZ) < 0 ? -1 : 1;
        const interiorSide = Number(face?.interiorSide);
        const outwardSign = Number.isFinite(interiorSide) ? -interiorSide : centerSign;
        segments.push({
            ax,
            az,
            bx,
            bz,
            normalX: nx * outwardSign,
            normalZ: nz * outwardSign,
        });
    }
    return segments;
}

export function foundationSegmentsFromWallFaces(faces, center) {
    const iterator = foundationSegmentsFromWallFacesCooperative(faces, center);
    let outcome;
    do {
        outcome = iterator.next();
    } while (!outcome.done);
    return outcome.value;
}

// The mesh endpoint carries the survey's closed 2D outline separately from
// its MultiPolygon face soup. Project that outline into scene-local XZ and use
// its ring winding to give every edge a consistent outward normal. This is the
// complete perimeter; reconstructing it from individual wall polygons is only
// a fallback for older payloads that do not carry properties.footprint.
export function* foundationSegmentsFromFootprintCooperative(geometry, projectLonLat, {
    unitsPerStage = FOUNDATION_SKIRT_SEGMENT_UNITS_PER_STAGE,
} = {}) {
    if (typeof projectLonLat !== 'function') return [];
    const polygons = geometry?.type === 'Polygon'
        ? [geometry.coordinates]
        : geometry?.type === 'MultiPolygon'
            ? geometry.coordinates
            : [];
    const segments = [];
    const stageUnits = Math.max(1, Math.floor(Number(unitsPerStage) || 1));
    let unitsSinceYield = 0;
    const consumeUnit = function* () {
        if (unitsSinceYield >= stageUnits) {
            unitsSinceYield = 0;
            yield { phase: 'foundation-skirt-segments' };
        }
        unitsSinceYield += 1;
    };
    for (const polygon of polygons) {
        for (let ringIndex = 0; ringIndex < (polygon || []).length; ringIndex++) {
            const ring = polygon[ringIndex];
            if (!Array.isArray(ring) || ring.length < 3) continue;
            const points = [];
            for (const coordinate of ring) {
                yield* consumeUnit();
                const rawLon = coordinate?.[0];
                const rawLat = coordinate?.[1];
                if (rawLon == null || rawLat == null) continue;
                const lon = Number(rawLon);
                const lat = Number(rawLat);
                if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
                const projected = projectLonLat(lon, lat);
                if (projected?.x == null || projected?.z == null) continue;
                const x = Number(projected.x);
                const z = Number(projected.z);
                if (Number.isFinite(x) && Number.isFinite(z)) points.push({ x, z });
            }
            if (points.length > 1
                && Math.hypot(
                    points[0].x - points[points.length - 1].x,
                    points[0].z - points[points.length - 1].z,
                ) < 0.01) {
                points.pop();
            }
            if (points.length < 3) continue;
            let signedArea = 0;
            for (let index = 0; index < points.length; index++) {
                yield* consumeUnit();
                const a = points[index];
                const b = points[(index + 1) % points.length];
                signedArea += a.x * b.z - b.x * a.z;
            }
            if (Math.abs(signedArea) < 0.01) continue;
            // Outer rings face away from their interior; hole rings face INTO
            // their interior (the courtyard void), which is likewise away from
            // the building solid. Ring semantics, not input winding, decides.
            const windingSign = signedArea >= 0 ? 1 : -1;
            const normalSign = ringIndex === 0 ? windingSign : -windingSign;
            for (let index = 0; index < points.length; index++) {
                yield* consumeUnit();
                const a = points[index];
                const b = points[(index + 1) % points.length];
                const dx = b.x - a.x;
                const dz = b.z - a.z;
                const length = Math.hypot(dx, dz);
                if (length < 0.05) continue;
                segments.push({
                    ax: a.x,
                    az: a.z,
                    bx: b.x,
                    bz: b.z,
                    normalX: dz / length * normalSign,
                    normalZ: -dx / length * normalSign,
                });
            }
        }
    }
    return segments;
}

export function foundationSegmentsFromFootprint(geometry, projectLonLat) {
    const iterator = foundationSegmentsFromFootprintCooperative(geometry, projectLonLat);
    let outcome;
    do {
        outcome = iterator.next();
    } while (!outcome.done);
    return outcome.value;
}

export function* foundationSegmentsForMeshFeatureCooperative(
    feature,
    projectLonLat,
    wallFaces,
    center,
) {
    const footprintSegments = yield* foundationSegmentsFromFootprintCooperative(
        feature?.properties?.footprint,
        projectLonLat,
    );
    return footprintSegments.length >= 3
        ? footprintSegments
        : yield* foundationSegmentsFromWallFacesCooperative(wallFaces, center);
}

export function foundationSegmentsForMeshFeature(
    feature,
    projectLonLat,
    wallFaces,
    center,
) {
    const iterator = foundationSegmentsForMeshFeatureCooperative(
        feature,
        projectLonLat,
        wallFaces,
        center,
    );
    let outcome;
    do {
        outcome = iterator.next();
    } while (!outcome.done);
    return outcome.value;
}

// Ground sampler for skirts that respects ENGINEERED surfaces. The raw grid is
// not always the ground you see: a street benched into a slope renders 1–2 m
// below it, so a street-facing edge whose raw terrain sits at/above the base
// skipped its band as "flat" while the visible street ran below — an open gap
// under the facade from that side only. Formations are consulted lazily: only
// where the raw band would be near-skipped (raw terrain within refineBelowM of
// the base), because that is exactly where a cut can hide below, and formation
// spatial queries are too expensive to pay on every clearly-banded sample.
// formationAts: [(x, z) => sceneY|null] — road/rail formation surface queries.
export function composeFoundationGroundSampler({
    terrainAt,
    formationAts = [],
    topSceneY,
    refineBelowM = 1.5,
    // The refinement exists to find a STREET benched a metre or two below the
    // raw grid — never a surface on a different level. Formation queries are
    // 2D (an x,z within maxDistanceM of the alignment answers with the bed
    // height whatever the vertical separation), so a building standing on the
    // hill ABOVE a bored tunnel got its skirt dragged 15+ m down to the
    // trackbed, THROUGH the hill, and hung a concrete band across the bore
    // interior (Rijeka Brajdica). An engineered height deeper than this below
    // the building base is a different level and is ignored.
    maxEngineeredDropM = 6,
} = {}) {
    const top = Number(topSceneY);
    const queries = (formationAts || []).filter((query) => typeof query === 'function');
    if (typeof terrainAt !== 'function') return () => NaN;
    if (queries.length === 0 || !Number.isFinite(top)) return (x, z) => terrainAt(x, z);
    // Absent is not zero: a formation query answers null where it has no
    // surface, and Number(null) is 0 — a plausible-looking datum height that
    // would drag skirt bottoms to the anchor. Guard before coercing.
    const finiteAt = (query, x, z) => {
        const raw = query(x, z);
        if (raw == null) return null;
        const value = Number(raw);
        return Number.isFinite(value) ? value : null;
    };
    return (x, z) => {
        let y = finiteAt(terrainAt, x, z);
        if (y !== null && top - y > refineBelowM) return y;
        for (const query of queries) {
            const engineered = finiteAt(query, x, z);
            if (engineered === null) continue;
            if (top - engineered > maxEngineeredDropM) continue;
            if (y === null || engineered < y) y = engineered;
        }
        return y === null ? NaN : y;
    };
}

// segments: [{ ax, az, bx, bz, normalX, normalZ }] in anchor-local metres — the
//   footprint boundary. normalX/normalZ (outward, optional) fix the winding so
//   the band faces away from the building.
// topSceneY: the flat building-base scene Y (== the terrain MAX over the
//   footprint), so the band's top edge meets the wall base with no seam.
// sampleYAtLocal(x, z) -> terrain scene Y at a local point (the same piecewise
//   -planar surface the terrain mesh renders).
// options:
//   maxSegmentM — subdivide edges longer than this and sample the terrain at
//     every subdivision point. Endpoint-only sampling let a LONG wall bridge a
//     mid-edge dip with a straight chord (a see-through hole under the facade)
//     or skip its band entirely when both corners happened to sit flush.
//     Default Infinity keeps the historical per-edge behaviour.
//   plungeM — sink each emitted band bottom this far below its terrain sample.
//     The visible ground is often NOT the raw grid (draped paving, a road
//     bench) and triangulates differently, so a bottom edge laid exactly on
//     the grid can hover above what is actually rendered. The overshoot is
//     buried and invisible; the flat-ground skip below stays keyed on the RAW
//     delta, so level footprints still emit nothing.
//   minimumBottomYAtLocal(x, z) — optional structural floor for the skirt
//     bottom. A building over a shallow bored tunnel may still need a buried
//     skirt in the soil above, but that burial must stop at the tunnel roof
//     rather than hanging through its ceiling into the bore.
//
// Returns { positions, normals, uvs, triangleCount } — flat arrays, two
// outward-facing triangles per non-flat (sub)segment.
export function* buildFoundationSkirtPositionsCooperative(
    segments,
    topSceneY,
    sampleYAtLocal,
    options,
) {
    const positions = [];
    const normals = [];
    const uvs = [];
    if (!Array.isArray(segments) || typeof sampleYAtLocal !== 'function') {
        return { positions, normals, uvs, triangleCount: 0 };
    }
    const top = Number(topSceneY);
    if (!Number.isFinite(top)) return { positions, normals, uvs, triangleCount: 0 };
    const maxSegmentM = Number(options?.maxSegmentM) > 0 ? Number(options.maxSegmentM) : Infinity;
    const plungeM = Number(options?.plungeM) > 0 ? Number(options.plungeM) : 0;
    const minimumBottomYAtLocal = typeof options?.minimumBottomYAtLocal === 'function'
        ? options.minimumBottomYAtLocal
        : null;
    const piecesPerStage = Math.max(
        1,
        Math.floor(Number(options?.piecesPerStage) || FOUNDATION_SKIRT_PIECES_PER_STAGE),
    );
    let piecesSinceYield = 0;

    // Terrain at a point, clamped to the base: the base is the MAX terrain
    // over the footprint, so a point can only sit at or below it — clamping
    // just absorbs sampling noise and never pokes a sliver above the wall.
    const clampedSample = (x, z) => {
        const y = Number(sampleYAtLocal(x, z));
        if (!Number.isFinite(y)) return top;
        return y > top ? top : y;
    };
    // One emitter for the whole generation. The former inner loop allocated
    // four position arrays, four UV arrays and two closures for every sampled
    // piece. Large but otherwise ordinary footprints consequently created a
    // short-lived-object storm and could trigger a major GC in either this
    // stage or the following Mesh constructor. Scalar writes keep the exact
    // de-indexed buffer contract without per-piece garbage.
    const pushVertex = (x, y, z, u, v, normalX, normalZ) => {
        positions.push(x, y, z);
        normals.push(normalX, 0, normalZ);
        uvs.push(u, v);
    };

    for (const segment of segments) {
        if (!segment) continue;
        const eax = Number(segment.ax);
        const eaz = Number(segment.az);
        const ebx = Number(segment.bx);
        const ebz = Number(segment.bz);
        if (!Number.isFinite(eax) || !Number.isFinite(eaz)
            || !Number.isFinite(ebx) || !Number.isFinite(ebz)) continue;
        const edgeLen = Math.hypot(ebx - eax, ebz - eaz);
        if (edgeLen < 1e-6) continue;
        const pieces = Number.isFinite(maxSegmentM)
            ? Math.max(1, Math.ceil(edgeLen / maxSegmentM))
            : 1;

        for (let piece = 0; piece < pieces; piece++) {
        if (piecesSinceYield >= piecesPerStage) {
            piecesSinceYield = 0;
            yield { phase: 'foundation-skirt-geometry' };
        }
        piecesSinceYield += 1;
        const t0 = piece / pieces;
        const t1 = (piece + 1) / pieces;
        const ax = eax + (ebx - eax) * t0;
        const az = eaz + (ebz - eaz) * t0;
        const bx = eax + (ebx - eax) * t1;
        const bz = eaz + (ebz - eaz) * t1;

        let ay = clampedSample(ax, az);
        let by = clampedSample(bx, bz);

        // Both endpoints flush with the base → no visible band on this piece.
        // Judged BEFORE the plunge, so flat ground still emits nothing.
        if (top - ay <= SKIRT_FLAT_EPSILON_M && top - by <= SKIRT_FLAT_EPSILON_M) continue;
        if (plungeM > 0) {
            ay = Math.min(top, ay) - plungeM;
            by = Math.min(top, by) - plungeM;
        }
        if (minimumBottomYAtLocal) {
            const minimumA = Number(minimumBottomYAtLocal(ax, az));
            const minimumB = Number(minimumBottomYAtLocal(bx, bz));
            if (Number.isFinite(minimumA)) ay = Math.max(ay, Math.min(top, minimumA));
            if (Number.isFinite(minimumB)) by = Math.max(by, Math.min(top, minimumB));
            // A structural roof can collapse the entire skirt piece back to
            // its base. Skip the resulting zero-area triangles.
            if (top - ay <= SKIRT_FLAT_EPSILON_M
                && top - by <= SKIRT_FLAT_EPSILON_M) continue;
        }

        const dx = bx - ax;
        const dz = bz - az;
        const segLen = Math.hypot(dx, dz);
        if (segLen < 1e-6) continue;

        // Base winding (Atop, Btop, Bbot)+(Atop, Bbot, Abot) has a geometric
        // normal proportional to (dz, 0, -dx). When the caller supplies an
        // outward normal, flip the winding if that base normal points the wrong
        // way, so every band faces outward regardless of the polygon's ring
        // orientation.
        const nx = Number(segment.normalX);
        const nz = Number(segment.normalZ);
        const haveNormal = Number.isFinite(nx) && Number.isFinite(nz);
        const flip = haveNormal ? (dz * nx + (-dx) * nz) < 0 : false;

        // Outward horizontal normal that matches the final winding.
        let outX;
        let outZ;
        if (haveNormal) {
            const nLen = Math.hypot(nx, nz) || 1;
            outX = nx / nLen;
            outZ = nz / nLen;
        } else {
            const gLen = Math.hypot(dz, dx) || 1;
            outX = dz / gLen;
            outZ = -dx / gLen;
        }

        // UV: U in metres along the wall, V = scene height. Preserve the old
        // triangle order exactly while writing scalar values directly.
        pushVertex(ax, top, az, 0, top, outX, outZ);
        if (flip) {
            pushVertex(bx, by, bz, segLen, by, outX, outZ);
            pushVertex(bx, top, bz, segLen, top, outX, outZ);
        } else {
            pushVertex(bx, top, bz, segLen, top, outX, outZ);
            pushVertex(bx, by, bz, segLen, by, outX, outZ);
        }
        pushVertex(ax, top, az, 0, top, outX, outZ);
        if (flip) {
            pushVertex(ax, ay, az, 0, ay, outX, outZ);
            pushVertex(bx, by, bz, segLen, by, outX, outZ);
        } else {
            pushVertex(bx, by, bz, segLen, by, outX, outZ);
            pushVertex(ax, ay, az, 0, ay, outX, outZ);
        }
        }
    }

    return { positions, normals, uvs, triangleCount: positions.length / 9 };
}

export function buildFoundationSkirtPositions(segments, topSceneY, sampleYAtLocal, options) {
    const iterator = buildFoundationSkirtPositionsCooperative(
        segments,
        topSceneY,
        sampleYAtLocal,
        options,
    );
    let outcome;
    do {
        outcome = iterator.next();
    } while (!outcome.done);
    return outcome.value;
}

// Convert the staged JavaScript geometry arrays into the immutable Float32
// buffers Three.js uploads. Float32BufferAttribute performs this entire copy
// synchronously in its constructor; a detailed footprint can therefore turn a
// resumable sampler into one large final queue item. Preparing the same buffers
// here keeps publication atomic while returning to the shared queue between
// bounded copies. The optional Y offset is folded into the position copy so no
// second full-array pass is needed. Runtime-only callers may consume the staged
// arrays as each typed buffer finishes; this keeps an unusually detailed but
// valid footprint from retaining both complete representations until publish.
export function* prepareFoundationSkirtBuffersCooperative(
    geometryData,
    { positionYOffsetY = 0, consumeSource = false } = {},
) {
    let sourcePositions = geometryData?.positions || [];
    let sourceNormals = geometryData?.normals || [];
    let sourceUvs = geometryData?.uvs || [];
    const positions = new Float32Array(sourcePositions.length);
    const normals = new Float32Array(sourceNormals.length);
    const uvs = new Float32Array(sourceUvs.length);
    const yOffset = Number(positionYOffsetY) || 0;
    let valuesSinceYield = 0;

    const copy = function* (source, target, offsetY = 0) {
        for (let index = 0; index < source.length; index++) {
            const value = Number(source[index]);
            target[index] = value + (offsetY !== 0 && index % 3 === 1 ? offsetY : 0);
            valuesSinceYield += 1;
            if (valuesSinceYield >= FOUNDATION_SKIRT_BUFFER_VALUES_PER_STAGE) {
                valuesSinceYield = 0;
                yield { phase: 'foundation-skirt-buffer' };
            }
        }
    };

    yield* copy(sourcePositions, positions, yOffset);
    if (consumeSource) {
        if (geometryData) geometryData.positions = null;
        sourcePositions = null;
    }
    yield* copy(sourceNormals, normals);
    if (consumeSource) {
        if (geometryData) geometryData.normals = null;
        sourceNormals = null;
    }
    yield* copy(sourceUvs, uvs);
    if (consumeSource) {
        if (geometryData) geometryData.uvs = null;
        sourceUvs = null;
    }
    return {
        positions,
        normals,
        uvs,
        triangleCount: Math.max(0, Number(geometryData?.triangleCount) || 0),
    };
}
