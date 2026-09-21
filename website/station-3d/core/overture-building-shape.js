// Pure geometry helpers for giving height-poor Overture footprints stable,
// plausible building heights and small Mediterranean pitched roofs.

import { DEG_TO_RAD, EARTH_RADIUS_M } from './math.js';
import { triangulate } from './polygon-triangulation.js';

function stableUnit(value) {
    const text = String(value == null ? '' : value);
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) / 4294967296;
}

function openRing(ring) {
    if (!Array.isArray(ring) || ring.length < 3) return [];
    const first = ring[0];
    const last = ring[ring.length - 1];
    const isClosed = first && last && first[0] === last[0] && first[1] === last[1];
    return isClosed ? ring.slice(0, -1) : ring.slice();
}

export function ringAreaM2(ring, latitude) {
    const points = openRing(ring);
    if (points.length < 3 || !Number.isFinite(latitude)) return 0;
    const scaleLon = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(latitude * DEG_TO_RAD);
    const scaleLat = DEG_TO_RAD * EARTH_RADIUS_M;
    const originLon = points[0][0];
    const originLat = points[0][1];
    let twiceArea = 0;
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const q = points[(i + 1) % points.length];
        const px = (p[0] - originLon) * scaleLon;
        const pz = (p[1] - originLat) * scaleLat;
        const qx = (q[0] - originLon) * scaleLon;
        const qz = (q[1] - originLat) * scaleLat;
        twiceArea += px * qz - qx * pz;
    }
    return Math.abs(twiceArea) * 0.5;
}

// Andrew's monotone chain. Convex hull first because the minimum width of a
// footprint is the minimum width of its hull — a courtyard or a notch cannot
// make a building narrower than its outline.
function convexHull(points) {
    if (points.length < 3) return points.slice();
    const sorted = points.slice().sort((a, b) => (a.x - b.x) || (a.z - b.z));
    const cross = (o, a, b) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
    const half = (source) => {
        const out = [];
        for (const point of source) {
            while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], point) <= 0) out.pop();
            out.push(point);
        }
        out.pop();
        return out;
    };
    const hull = [...half(sorted), ...half(sorted.reverse())];
    return hull.length >= 3 ? hull : points.slice();
}

// The narrowest the building is in plan, in metres — the width of the tightest
// pair of parallel lines that still contains it. For a convex polygon that pair
// always has one line flush with an edge, so testing every hull edge is exact,
// not an approximation.
export function footprintMinWidthM(ring, latitude) {
    const points = openRing(ring);
    if (points.length < 3 || !Number.isFinite(latitude)) return 0;
    const scaleLon = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(latitude * DEG_TO_RAD);
    const scaleLat = DEG_TO_RAD * EARTH_RADIUS_M;
    const originLon = points[0][0];
    const originLat = points[0][1];
    const hull = convexHull(points.map(([lon, lat]) => ({
        x: (lon - originLon) * scaleLon,
        z: (lat - originLat) * scaleLat,
    })));
    if (hull.length < 3) return 0;
    let best = Infinity;
    for (let index = 0; index < hull.length; index++) {
        const a = hull[index];
        const b = hull[(index + 1) % hull.length];
        const length = Math.hypot(b.x - a.x, b.z - a.z);
        if (length < 1e-6) continue;
        const nx = -(b.z - a.z) / length;
        const nz = (b.x - a.x) / length;
        let span = 0;
        for (const point of hull) {
            span = Math.max(span, Math.abs((point.x - a.x) * nx + (point.z - a.z) * nz));
        }
        best = Math.min(best, span);
    }
    return Number.isFinite(best) ? best : 0;
}

// A building can only be so tall for how narrow it is. 3.5 leaves room for the
// genuinely slender old-town house — 4 m across and four storeys up, which is
// ordinary inside Diocletian's palace — while refusing the 1.2 m wide garden
// wall that came out 16 m tall.
const MAX_SLENDERNESS = 3.5;
// Every footprint gets at least a single storey, however small it is.
const MIN_ESTIMATED_HEIGHT_M = 3.2;
// Below this, "landmark" is not a plausible reading of a footprint: it is a
// shed, a garage or a lean-to.
const LANDMARK_MIN_AREA_M2 = 500;

// Overture preserves OSM building=greenhouse as class=greenhouse. A greenhouse
// is an agricultural cover system, not a height-poor hall awaiting a storey
// estimate: these dimensions are the complete low silhouette used by near and
// far LODs alike.
export const GREENHOUSE_EAVE_HEIGHT_M = 1.25;
export const GREENHOUSE_RIDGE_HEIGHT_M = 2.4;

export function isGreenhouseBuilding(properties) {
    const value = properties?.class
        ?? properties?.building_class
        ?? properties?.building;
    return String(value || '').trim().toLowerCase() === 'greenhouse';
}

// Split's Overture footprints almost never carry height or floor counts (97% of
// them have neither), so nearly every building in that world is sized by this
// estimate rather than by data. It is deterministic per object id — the same
// building is the same height on every load — but it is still a guess, and it
// is bounded by the footprint so the guess stays a shape that could be built.
export function estimateOvertureBuildingHeight(geometry, objectId, latitude) {
    const ring = geometry?.type === 'Polygon'
        ? geometry.coordinates?.[0]
        : geometry?.type === 'MultiPolygon' ? geometry.coordinates?.[0]?.[0] : null;
    if (!ring || ring.length < 3) return 6;
    const area = ringAreaM2(ring, latitude);
    const first = ring[0] || [];
    const seed = stableUnit(objectId == null ? `${first[0]}:${first[1]}` : objectId);
    let floors;
    if (area < 45) floors = 1;
    else if (area < 500) floors = 2 + Math.floor(seed * 2);
    else if (area < 1500) floors = 3 + Math.floor(seed * 2);
    else floors = 4 + Math.floor(seed * 3);
    // The tall outlier belongs on a block big enough to carry one. Ungated, this
    // branch was what put five storeys on 8 m² sheds.
    if (seed > 0.94 && area >= LANDMARK_MIN_AREA_M2) floors += 2 + Math.floor(seed * 3);
    const height = floors * (3.1 + (seed - 0.5) * 0.4);
    const width = footprintMinWidthM(ring, latitude);
    if (!(width > 0)) return height;
    // The pitched roof goes ON TOP of this, so the slenderness budget has to
    // cover both — clamping the walls alone let a 1.2 m footprint reach 4.2 m
    // of wall and then wear another 1.4 m of gable, which is the 3.5 limit
    // overshot by a tenth. The roof is a pure function of the same ring, so it
    // can simply be spent up front.
    const roof = proceduralRoofHeightM(ring, latitude) || 0;
    const budget = width * MAX_SLENDERNESS - roof;
    // The floor wins when the budget cannot even buy one storey: a shed is
    // still drawn as a shed rather than collapsing to nothing.
    return Math.max(MIN_ESTIMATED_HEIGHT_M, Math.min(height, budget));
}

export function proceduralRoofHeightM(ring, latitude) {
    const area = ringAreaM2(ring, latitude);
    if (!Number.isFinite(area) || area < 4 || area > 900) return null;
    return Math.min(3.5, Math.max(1.4, Math.sqrt(area) * 0.22));
}

// Metric wall quads for a footprint extrusion. Unlike ExtrudeGeometry's cap
// mapping, these UVs are explicitly metres along/up the facade, so large
// masonry blocks keep a real-world scale on every wall bearing.
export function buildFootprintWallGeometry(polygon, heightM, centerLon, centerLat) {
    const height = Number(heightM);
    if (!polygon?.coordinates || !(height > 0)) return null;
    const scaleLon = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(centerLat * DEG_TO_RAD);
    const scaleLat = DEG_TO_RAD * EARTH_RADIUS_M;
    const positions = [];
    const uvs = [];
    for (const sourceRing of polygon.coordinates) {
        const points = openRing(sourceRing).map(([lon, lat]) => ({
            x: (lon - centerLon) * scaleLon,
            z: -(lat - centerLat) * scaleLat,
        }));
        if (points.length < 3) continue;
        let u = 0;
        for (let index = 0; index < points.length; index++) {
            const start = points[index];
            const end = points[(index + 1) % points.length];
            const length = Math.hypot(end.x - start.x, end.z - start.z);
            if (length < 0.02) continue;
            const nextU = u + length;
            positions.push(
                start.x, 0, start.z,
                end.x, 0, end.z,
                end.x, height, end.z,
                start.x, 0, start.z,
                end.x, height, end.z,
                start.x, height, start.z,
            );
            uvs.push(
                u, 0,
                nextU, 0,
                nextU, height,
                u, 0,
                nextU, height,
                u, height,
            );
            u = nextU;
        }
    }
    return positions.length > 0 ? { positions, uvs } : null;
}

export function buildHippedRoofGeometry(polygon, baseY, roofHeight, centerLon, centerLat) {
    const points = openRing(polygon?.coordinates?.[0]);
    if (points.length < 3 || !Number.isFinite(baseY) || !Number.isFinite(roofHeight)) return null;
    const scaleLon = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(centerLat * DEG_TO_RAD);
    const scaleLat = DEG_TO_RAD * EARTH_RADIUS_M;
    const local = points.map(([lon, lat]) => ({
        x: (lon - centerLon) * scaleLon,
        z: -(lat - centerLat) * scaleLat,
    }));
    const apex = local.reduce((sum, point) => ({
        x: sum.x + point.x / local.length,
        z: sum.z + point.z / local.length,
    }), { x: 0, z: 0 });
    const positions = [];
    const uvs = [];
    for (let i = 0; i < local.length; i++) {
        let a = local[i];
        let b = local[(i + 1) % local.length];
        const normalY = (b.z - a.z) * (apex.x - a.x)
            - (b.x - a.x) * (apex.z - a.z);
        if (normalY < 0) [a, b] = [b, a];
        positions.push(
            a.x, baseY, a.z,
            b.x, baseY, b.z,
            apex.x, baseY + roofHeight, apex.z,
        );
        // Metric face-local UVs make rows follow the eave while tile channels
        // run up/down the pitch. The previous world-XZ projection could turn
        // roof tiles sideways on faces with a different compass bearing.
        const edgeLength = Math.hypot(b.x - a.x, b.z - a.z);
        const edgeMidX = (a.x + b.x) * 0.5;
        const edgeMidZ = (a.z + b.z) * 0.5;
        const slopeLength = Math.hypot(apex.x - edgeMidX, roofHeight, apex.z - edgeMidZ);
        uvs.push(0, 0, edgeLength, 0, edgeLength * 0.5, slopeLength);
    }
    return { positions, uvs };
}

function principalRoofAxis(points) {
    const center = points.reduce((sum, point) => ({
        x: sum.x + point.x / points.length,
        z: sum.z + point.z / points.length,
    }), { x: 0, z: 0 });
    let xx = 0;
    let xz = 0;
    let zz = 0;
    for (const point of points) {
        const dx = point.x - center.x;
        const dz = point.z - center.z;
        xx += dx * dx;
        xz += dx * dz;
        zz += dz * dz;
    }
    if (Math.hypot(xx - zz, 2 * xz) > 1e-8) {
        const angle = 0.5 * Math.atan2(2 * xz, xx - zz);
        return { x: Math.cos(angle), z: Math.sin(angle) };
    }
    let longest = { length: 0, x: 1, z: 0 };
    for (let index = 0; index < points.length; index++) {
        const a = points[index];
        const b = points[(index + 1) % points.length];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const length = Math.hypot(dx, dz);
        if (length > longest.length) longest = { length, x: dx / length, z: dz / length };
    }
    return { x: longest.x, z: longest.z };
}

function clipTriangleToRoofSide(points, ridgeCross, keepLower) {
    const inside = (point) => keepLower ? point.cross <= ridgeCross + 1e-8 : point.cross >= ridgeCross - 1e-8;
    const clipped = [];
    for (let index = 0; index < points.length; index++) {
        const start = points[index];
        const end = points[(index + 1) % points.length];
        const startInside = inside(start);
        const endInside = inside(end);
        if (startInside) clipped.push(start);
        if (startInside === endInside) continue;
        const denominator = end.cross - start.cross;
        if (Math.abs(denominator) < 1e-10) continue;
        const t = (ridgeCross - start.cross) / denominator;
        clipped.push({
            x: start.x + (end.x - start.x) * t,
            z: start.z + (end.z - start.z) * t,
            cross: ridgeCross,
        });
    }
    return clipped.filter((point, index) => index === 0
        || Math.hypot(point.x - clipped[index - 1].x, point.z - clipped[index - 1].z) > 1e-7);
}

// Two roof planes meeting along the footprint's principal (normally longest)
// axis. Triangles are clipped at the ridge so even a rectangle gains real ridge
// vertices; gablePositions closes the triangular wall ends above the eaves.
export function buildGabledRoofGeometry(polygon, baseY, roofHeight, centerLon, centerLat) {
    const points = openRing(polygon?.coordinates?.[0]);
    if (points.length < 3 || !Number.isFinite(baseY) || !Number.isFinite(roofHeight)) return null;
    const scaleLon = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(centerLat * DEG_TO_RAD);
    const scaleLat = DEG_TO_RAD * EARTH_RADIUS_M;
    const local = points.map(([lon, lat]) => ({
        x: (lon - centerLon) * scaleLon,
        z: -(lat - centerLat) * scaleLat,
    }));
    const triangles = triangulate(local);
    if (triangles.length !== local.length - 2) return null;

    const ridge = principalRoofAxis(local);
    const crossAxis = { x: -ridge.z, z: ridge.x };
    for (const point of local) point.cross = point.x * crossAxis.x + point.z * crossAxis.z;
    const minCross = Math.min(...local.map((point) => point.cross));
    const maxCross = Math.max(...local.map((point) => point.cross));
    const ridgeCross = (minCross + maxCross) * 0.5;
    const halfWidth = (maxCross - minCross) * 0.5;
    if (!(halfWidth > 0.35)) return null;
    const slopeLength = Math.hypot(halfWidth, roofHeight);
    const positions = [];
    const uvs = [];
    const gablePositions = [];

    const roofVertex = (point, lowerSide) => {
        const rise = lowerSide
            ? (point.cross - minCross) / halfWidth
            : (maxCross - point.cross) / halfWidth;
        const ratio = Math.max(0, Math.min(1, rise));
        return {
            x: point.x,
            y: baseY + roofHeight * ratio,
            z: point.z,
            u: point.x * ridge.x + point.z * ridge.z,
            v: slopeLength * ratio,
        };
    };
    const pushRoofTriangle = (a, b, c) => {
        const area = (b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z);
        if (Math.abs(area) < 1e-8) return;
        let second = b;
        let third = c;
        if (area > 0) [second, third] = [third, second];
        for (const vertex of [a, second, third]) {
            positions.push(vertex.x, vertex.y, vertex.z);
            uvs.push(vertex.u, vertex.v);
        }
    };

    for (const triangle of triangles) {
        const source = triangle.map((index) => local[index]);
        for (const lowerSide of [true, false]) {
            const clipped = clipTriangleToRoofSide(source, ridgeCross, lowerSide);
            if (clipped.length < 3) continue;
            const first = roofVertex(clipped[0], lowerSide);
            for (let index = 1; index < clipped.length - 1; index++) {
                pushRoofTriangle(
                    first,
                    roofVertex(clipped[index], lowerSide),
                    roofVertex(clipped[index + 1], lowerSide),
                );
            }
        }
    }
    if (positions.length === 0) return null;

    const topRatio = (point) => Math.max(0, Math.min(1, 1 - Math.abs(point.cross - ridgeCross) / halfWidth));
    for (let index = 0; index < local.length; index++) {
        const start = local[index];
        const end = local[(index + 1) % local.length];
        const edge = [start];
        if ((start.cross - ridgeCross) * (end.cross - ridgeCross) < -1e-8) {
            const t = (ridgeCross - start.cross) / (end.cross - start.cross);
            edge.push({
                x: start.x + (end.x - start.x) * t,
                z: start.z + (end.z - start.z) * t,
                cross: ridgeCross,
            });
        }
        edge.push(end);
        for (let segment = 0; segment < edge.length - 1; segment++) {
            const a = edge[segment];
            const b = edge[segment + 1];
            const aRatio = topRatio(a);
            const bRatio = topRatio(b);
            const bottomA = [a.x, baseY, a.z];
            const bottomB = [b.x, baseY, b.z];
            const topA = [a.x, baseY + roofHeight * aRatio, a.z];
            const topB = [b.x, baseY + roofHeight * bRatio, b.z];
            if (bRatio > 1e-7) gablePositions.push(...bottomA, ...bottomB, ...topB);
            if (aRatio > 1e-7) gablePositions.push(...bottomA, ...topB, ...topA);
        }
    }

    return { positions, uvs, gablePositions, ridgeDirection: ridge };
}

// Build wall-overlay quads grouped by their true bay count. A rectangular
// building normally becomes two batches (long and short sides) rather than
// the realism branch's one THREE mesh per wall, while every facade still gets
// a texture whose window spacing matches that wall's metric width.
//
// ALL rings are walked, not just the outer one: a footprint hole is a
// courtyard, and its walls are facades too — reading only coordinates[0] left
// every courtyard-facing wall as blank plaster from lawn to roofline (first
// seen on the Šibenik plan's perimeter blocks). Hole faces batch separately
// with `courtyard: true`, so the caller can drop the shopfront glazing that
// belongs on a street, not on a private court.
export function buildOvertureFacadeBatches(polygon, height, centerLon, centerLat, {
    minFaceWidthM = 2,
    bayPitchM = 4.6,
} = {}) {
    const rings = Array.isArray(polygon?.coordinates) ? polygon.coordinates : [];
    if (!Number.isFinite(height) || height < 2.4) return [];
    const scaleLon = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(centerLat * DEG_TO_RAD);
    const scaleLat = DEG_TO_RAD * EARTH_RADIUS_M;
    const batches = new Map();
    for (let ringIndex = 0; ringIndex < rings.length; ringIndex++) {
        const points = openRing(rings[ringIndex]);
        if (points.length < 3) continue;
        const courtyard = ringIndex > 0;
        const local = points.map(([lon, lat]) => ({
            x: (lon - centerLon) * scaleLon,
            z: -(lat - centerLat) * scaleLat,
        }));
        for (let index = 0; index < local.length; index++) {
            const a = local[index];
            const b = local[(index + 1) % local.length];
            const widthM = Math.hypot(b.x - a.x, b.z - a.z);
            if (!Number.isFinite(widthM) || widthM < minFaceWidthM) continue;
            const bays = Math.max(1, Math.round(widthM / Math.max(0.5, bayPitchM)));
            const key = `${bays}${courtyard ? 'c' : ''}`;
            let batch = batches.get(key);
            if (!batch) {
                batch = { bays, courtyard, positions: [], uvs: [], faceCount: 0 };
                batches.set(key, batch);
            }
            batch.positions.push(
                a.x, 0, a.z,
                b.x, 0, b.z,
                b.x, height, b.z,
                a.x, 0, a.z,
                b.x, height, b.z,
                a.x, height, a.z,
            );
            batch.uvs.push(
                0, 0, 1, 0, 1, 1,
                0, 0, 1, 1, 0, 1,
            );
            batch.faceCount += 1;
        }
    }
    return [...batches.values()].sort((a, b) => a.bays - b.bays);
}

// One large OSM greenhouse footprint often describes a complex of many narrow
// ridge houses (Kaštelanski staklenici is roughly 144 x 69 m), not one giant
// roof. Build the complete complex as three plain geometry batches: translucent
// glass shells, slim ridge/eave frames, and low plant beds visible underneath.
// The principal footprint axis supplies the row bearing, so the rule works for
// every rotated greenhouse without an object-id exception.
export function buildGreenhouseRowsGeometry(polygon, centerLon, centerLat, {
    bayPitchM = 4.25,
    maxRows = 80,
    eaveHeightM = GREENHOUSE_EAVE_HEIGHT_M,
    ridgeHeightM = GREENHOUSE_RIDGE_HEIGHT_M,
} = {}) {
    const ring = openRing(polygon?.coordinates?.[0]);
    if (ring.length < 3 || !Number.isFinite(centerLon) || !Number.isFinite(centerLat)) return null;
    const scaleLon = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(centerLat * DEG_TO_RAD);
    const scaleLat = DEG_TO_RAD * EARTH_RADIUS_M;
    const points = ring.map(([lon, lat]) => ({
        x: (Number(lon) - centerLon) * scaleLon,
        z: -(Number(lat) - centerLat) * scaleLat,
    })).filter(point => Number.isFinite(point.x) && Number.isFinite(point.z));
    if (points.length < 3) return null;

    const alongAxis = principalRoofAxis(points);
    const crossAxis = { x: -alongAxis.z, z: alongAxis.x };
    const alongValues = points.map(point => point.x * alongAxis.x + point.z * alongAxis.z);
    const crossValues = points.map(point => point.x * crossAxis.x + point.z * crossAxis.z);
    let alongMin = Math.min(...alongValues);
    let alongMax = Math.max(...alongValues);
    let crossMin = Math.min(...crossValues);
    let crossMax = Math.max(...crossValues);
    const edgeInsetM = 0.35;
    alongMin += edgeInsetM;
    alongMax -= edgeInsetM;
    crossMin += edgeInsetM;
    crossMax -= edgeInsetM;
    const lengthM = alongMax - alongMin;
    const widthM = crossMax - crossMin;
    if (!(lengthM > 2) || !(widthM > 1.2)) return null;

    const rowCount = Math.max(1, Math.min(
        Math.max(1, Math.floor(Number(maxRows) || 80)),
        Math.round(widthM / Math.max(2.5, Number(bayPitchM) || 4.25)),
    ));
    const bayWidthM = widthM / rowCount;
    const shellPositions = [];
    const framePositions = [];
    const plantPositions = [];
    const vertex = (along, cross, y) => [
        alongAxis.x * along + crossAxis.x * cross,
        y,
        alongAxis.z * along + crossAxis.z * cross,
    ];
    const triangle = (out, a, b, c) => out.push(...a, ...b, ...c);
    const quad = (out, a, b, c, d) => {
        triangle(out, a, b, c);
        triangle(out, a, c, d);
    };

    for (let row = 0; row < rowCount; row++) {
        const nominalStart = crossMin + row * bayWidthM;
        const nominalEnd = crossMin + (row + 1) * bayWidthM;
        const seamM = Math.min(0.08, bayWidthM * 0.02);
        const c0 = nominalStart + seamM;
        const c1 = nominalEnd - seamM;
        const ridge = (c0 + c1) * 0.5;
        const lowA = vertex(alongMin, c0, eaveHeightM);
        const lowB = vertex(alongMax, c0, eaveHeightM);
        const highA = vertex(alongMin, c1, eaveHeightM);
        const highB = vertex(alongMax, c1, eaveHeightM);
        const ridgeA = vertex(alongMin, ridge, ridgeHeightM);
        const ridgeB = vertex(alongMax, ridge, ridgeHeightM);

        // Two distinct roof planes per bay keep every narrow ridge legible in
        // lighting instead of becoming one smooth, dominant mega-roof.
        quad(shellPositions, lowA, lowB, ridgeB, ridgeA);
        quad(shellPositions, ridgeA, ridgeB, highB, highA);
        quad(
            shellPositions,
            vertex(alongMin, c0, 0),
            vertex(alongMax, c0, 0),
            lowB,
            lowA,
        );
        quad(
            shellPositions,
            vertex(alongMax, c1, 0),
            vertex(alongMin, c1, 0),
            highA,
            highB,
        );
        // Low end walls plus the repeated triangular gables visible in the
        // reference photograph.
        quad(
            shellPositions,
            vertex(alongMin, c0, 0),
            lowA,
            highA,
            vertex(alongMin, c1, 0),
        );
        triangle(shellPositions, lowA, ridgeA, highA);
        quad(
            shellPositions,
            vertex(alongMax, c1, 0),
            highB,
            lowB,
            vertex(alongMax, c0, 0),
        );
        triangle(shellPositions, highB, ridgeB, lowB);

        const bedInsetM = Math.min(0.35, bayWidthM * 0.12);
        if (c1 - c0 > bedInsetM * 2 && lengthM > 1) {
            quad(
                plantPositions,
                vertex(alongMin + 0.45, c0 + bedInsetM, 0.06),
                vertex(alongMax - 0.45, c0 + bedInsetM, 0.06),
                vertex(alongMax - 0.45, c1 - bedInsetM, 0.06),
                vertex(alongMin + 0.45, c1 - bedInsetM, 0.06),
            );
        }

        const frameHalfWidthM = Math.min(0.045, bayWidthM * 0.015);
        for (const [cross, y] of [
            [c0, eaveHeightM + 0.025],
            [ridge, ridgeHeightM + 0.025],
            [c1, eaveHeightM + 0.025],
        ]) {
            quad(
                framePositions,
                vertex(alongMin, cross - frameHalfWidthM, y),
                vertex(alongMax, cross - frameHalfWidthM, y),
                vertex(alongMax, cross + frameHalfWidthM, y),
                vertex(alongMin, cross + frameHalfWidthM, y),
            );
        }
    }

    return {
        shellPositions,
        framePositions,
        plantPositions,
        rowCount,
        lengthM,
        widthM,
    };
}
