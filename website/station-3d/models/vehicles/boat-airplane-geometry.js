// Pure geometry data for GTA-only special vehicles. Keeping the authored hull
// sections and fuselage lofts free of Three.js makes their proportions and
// topology testable. The boat's full shape lives in leut-geometry.js.

import { LEUT_HULL_DIMENSIONS, leutHalfBeam, leutKeelZ, leutSheerZ } from './leut-geometry.js';

// Hull sections of the leut courier boat, sampled from its authored lines
// (model frame: +Z nose). The boat clearance probes and the interaction box
// read these, so they follow the rendered hull exactly.
export const BOAT_HULL_SECTIONS = Object.freeze(
    // the sternpost sits 5 cm aft of the first section; the last is the stem head point
    [-3.95, -3.4, -2.6, -1.6, -0.4, 0.8, 2.0, 3.0, 3.7, 4.2, 4.5].map(z => Object.freeze({
        z, halfWidth: leutHalfBeam(z), topY: leutSheerZ(z), keelY: leutKeelZ(z),
    })),
);
// The interaction box is centred at the model origin; its forward extent must
// include the raked stem, which reaches farther than the sternpost.
export const BOAT_HULL_DIMENSIONS = LEUT_HULL_DIMENSIONS;

export function buildEllipticalLoftGeometryData(sections, radialSegments = 16) {
    const segmentCount = Math.max(8, Math.floor(Number(radialSegments) || 16));
    // Both the side quads and the two end caps below wind outward only when the
    // sections run nose-first, i.e. from high z to low z. Normalise the order
    // here rather than trusting every caller: the cabin was authored aft-first,
    // which turned the whole greenhouse inside out — with backface culling the
    // rear of it simply vanished and you looked straight through the aircraft.
    const ordered = sections.length > 1 && sections[0].z < sections.at(-1).z
        ? [...sections].reverse()
        : [...sections];
    const positions = [];
    for (const section of ordered) {
        for (let segment = 0; segment < segmentCount; segment += 1) {
            const angle = segment / segmentCount * Math.PI * 2;
            positions.push(
                Math.cos(angle) * section.halfWidth,
                section.centerY + Math.sin(angle) * section.halfHeight,
                section.z,
            );
        }
    }

    const indices = [];
    for (let section = 0; section < ordered.length - 1; section += 1) {
        const current = section * segmentCount;
        const next = (section + 1) * segmentCount;
        for (let segment = 0; segment < segmentCount; segment += 1) {
            const following = (segment + 1) % segmentCount;
            indices.push(
                current + segment, next + segment, next + following,
                current + segment, next + following, current + following,
            );
        }
    }

    const noseCenter = positions.length / 3;
    positions.push(0, ordered[0].centerY, ordered[0].z);
    const tailCenter = positions.length / 3;
    positions.push(0, ordered.at(-1).centerY, ordered.at(-1).z);
    const tailRing = (ordered.length - 1) * segmentCount;
    for (let segment = 0; segment < segmentCount; segment += 1) {
        const following = (segment + 1) % segmentCount;
        indices.push(
            noseCenter, segment, following,
            tailCenter, tailRing + following, tailRing + segment,
        );
    }
    return { positions, indices, sections: ordered, radialSegments: segmentCount };
}

const AIRPLANE_FUSELAGE_SECTIONS = [
    // +Z is the nose. The cowling is deliberately lower and narrower than the
    // cabin, like a Cessna-class light aircraft, so the windshield can see
    // over it. From the aft shoulder rearward, every section becomes both
    // smaller and higher: the tail is a rising tapered boom, not a capsule.
    { z: 3.66, centerY: 0.77, halfWidth: 0.08, halfHeight: 0.08 },
    { z: 3.28, centerY: 0.77, halfWidth: 0.43, halfHeight: 0.34 },
    { z: 2.12, centerY: 0.80, halfWidth: 0.54, halfHeight: 0.38 },
    { z: 1.55, centerY: 0.83, halfWidth: 0.58, halfHeight: 0.42 },
    { z: 0.00, centerY: 0.98, halfWidth: 0.74, halfHeight: 0.70 },
    { z: -1.55, centerY: 1.04, halfWidth: 0.64, halfHeight: 0.58 },
    { z: -2.55, centerY: 1.22, halfWidth: 0.42, halfHeight: 0.36 },
    { z: -3.65, centerY: 1.46, halfWidth: 0.09, halfHeight: 0.07 },
];

export function buildAirplaneFuselageGeometryData(radialSegments = 16) {
    return buildEllipticalLoftGeometryData(AIRPLANE_FUSELAGE_SECTIONS, radialSegments);
}

export const AIRPLANE_CABIN_SECTIONS = Object.freeze([
    Object.freeze({ z: 0.20, centerY: 1.29, halfWidth: 0.48, halfHeight: 0.31 }),
    Object.freeze({ z: 0.38, centerY: 1.31, halfWidth: 0.63, halfHeight: 0.45 }),
    Object.freeze({ z: 1.27, centerY: 1.31, halfWidth: 0.66, halfHeight: 0.47 }),
    Object.freeze({ z: 1.61, centerY: 1.27, halfWidth: 0.53, halfHeight: 0.38 }),
]);

export function airplaneCabinSectionAtZ(z) {
    const value = Number(z);
    if (!Number.isFinite(value)) return null;
    const first = AIRPLANE_CABIN_SECTIONS[0];
    const last = AIRPLANE_CABIN_SECTIONS.at(-1);
    if (value <= first.z) return { ...first };
    if (value >= last.z) return { ...last };
    for (let index = 1; index < AIRPLANE_CABIN_SECTIONS.length; index += 1) {
        const before = AIRPLANE_CABIN_SECTIONS[index - 1];
        const after = AIRPLANE_CABIN_SECTIONS[index];
        if (value > after.z) continue;
        const ratio = (value - before.z) / (after.z - before.z);
        return {
            z: value,
            centerY: before.centerY + (after.centerY - before.centerY) * ratio,
            halfWidth: before.halfWidth + (after.halfWidth - before.halfWidth) * ratio,
            halfHeight: before.halfHeight + (after.halfHeight - before.halfHeight) * ratio,
        };
    }
    return { ...last };
}

export function airplaneCabinSurfaceXAt(z, y, side = 1) {
    const section = airplaneCabinSectionAtZ(z);
    const height = Number(y);
    if (!section || !Number.isFinite(height)) return null;
    const normalizedY = (height - section.centerY) / section.halfHeight;
    const bodyX = airplaneBodySurfaceXAt(z, y);
    if (Math.abs(normalizedY) > 1 && bodyX === 0) return null;
    return Math.sign(Number(side) || 1)
        * Math.max(bodyX, section.halfWidth * Math.sqrt(Math.max(0, 1 - normalizedY * normalizedY)));
}

export function airplaneBodySurfaceXAt(z, y) {
    const section = sectionAtZ(AIRPLANE_FUSELAGE_SECTIONS, z);
    return section.halfWidth * Math.sqrt(Math.max(0, 1 - ((y - section.centerY) / section.halfHeight) ** 2));
}

export function buildAirplaneCabinBulkheadGeometryData({ z, topY = Infinity, bottomY = 0.5 }) {
    const section = sectionAtZ(AIRPLANE_FUSELAGE_SECTIONS, z);
    const ceiling = Math.min(topY, section.centerY + section.halfHeight - 0.01);
    const positions = [0, (bottomY + ceiling) / 2, z];
    for (const side of [1, -1]) {
        for (let index = 0; index <= 16; index += 1) {
            const ratio = side > 0 ? index / 16 : 1 - index / 16;
            const y = bottomY + (ceiling - bottomY) * ratio;
            positions.push(side * airplaneBodySurfaceXAt(z, y) * 0.98, y, z);
        }
    }
    const count = positions.length / 3 - 1;
    const indices = [];
    for (let index = 0; index < count; index += 1) indices.push(0, index + 1, (index + 1) % count + 1);
    return { positions, indices };
}

export function buildAirplaneCabinSidePatchGeometryData({
    side = 1,
    zStart = 0.42,
    zEnd = 1.46,
    bottomStartY = 1.10,
    bottomEndY = 1.10,
    topStartY = 1.64,
    topEndY = 1.57,
    zSegments = 6,
    ySegments = 3,
} = {}) {
    const columns = Math.max(1, Math.floor(Number(zSegments) || 1));
    const rows = Math.max(1, Math.floor(Number(ySegments) || 1));
    const positions = [];
    for (let column = 0; column <= columns; column += 1) {
        const zRatio = column / columns;
        const z = zStart + (zEnd - zStart) * zRatio;
        const bottomY = bottomStartY + (bottomEndY - bottomStartY) * zRatio;
        const topY = topStartY + (topEndY - topStartY) * zRatio;
        for (let row = 0; row <= rows; row += 1) {
            const y = bottomY + (topY - bottomY) * (row / rows);
            const x = airplaneCabinSurfaceXAt(z, y, side);
            if (!Number.isFinite(x)) {
                throw new RangeError('airplane cabin patch lies outside the cabin surface');
            }
            positions.push(x, y, z);
        }
    }
    const indices = [];
    const stride = rows + 1;
    for (let column = 0; column < columns; column += 1) {
        for (let row = 0; row < rows; row += 1) {
            const a = column * stride + row;
            const b = (column + 1) * stride + row;
            indices.push(a, b, b + 1, a, b + 1, a + 1);
        }
    }
    return { positions, indices };
}

export function buildAirplaneCabinSurfaceLinePositions(points, {
    side = 1,
    segmentsPerEdge = 5,
    offsetM = 0,
    surfaceGeometry = null,
} = {}) {
    const source = Array.isArray(points) ? points : [];
    const segments = Math.max(1, Math.floor(Number(segmentsPerEdge) || 1));
    const positions = [];
    const pointAt = (from, to, ratio) => {
        const z = from.z + (to.z - from.z) * ratio;
        const y = from.y + (to.y - from.y) * ratio;
        const surfaceX = surfaceGeometry ? airplaneCabinShellSurfaceXAt(surfaceGeometry, z, y, side)
            : airplaneCabinSurfaceXAt(z, y, side);
        if (!Number.isFinite(surfaceX)) {
            throw new RangeError('airplane cabin line lies outside the cabin surface');
        }
        return [surfaceX + Math.sign(Number(side) || 1) * offsetM, y, z];
    };
    for (let edge = 0; edge + 1 < source.length; edge += 1) {
        for (let segment = 0; segment < segments; segment += 1) {
            positions.push(
                ...pointAt(source[edge], source[edge + 1], segment / segments),
                ...pointAt(source[edge], source[edge + 1], (segment + 1) / segments),
            );
        }
    }
    return positions;
}

// Sample the actual rendered triangles for door seams and handles. The union
// of the two lofts can differ from either ideal ellipse between section rings.
export function airplaneCabinShellSurfaceXAt(data, z, y, side = 1) {
    const p = data.positions;
    let result = null;
    for (const indices of [data.fuselage, data.cabin, data.glass]) {
        for (let index = 0; index < indices.length; index += 3) {
            const a = indices[index] * 3;
            const b = indices[index + 1] * 3;
            const c = indices[index + 2] * 3;
            const determinant = (p[b + 2] - p[c + 2]) * (p[a + 1] - p[c + 1])
                + (p[c + 1] - p[b + 1]) * (p[a + 2] - p[c + 2]);
            if (Math.abs(determinant) < 1e-12) continue;
            const u = ((p[b + 2] - p[c + 2]) * (y - p[c + 1])
                + (p[c + 1] - p[b + 1]) * (z - p[c + 2])) / determinant;
            const v = ((p[c + 2] - p[a + 2]) * (y - p[c + 1])
                + (p[a + 1] - p[c + 1]) * (z - p[c + 2])) / determinant;
            if (u < -1e-8 || v < -1e-8 || u + v > 1 + 1e-8) continue;
            const x = u * p[a] + v * p[b] + (1 - u - v) * p[c];
            if (result === null || side * x > side * result) result = x;
        }
    }
    return result;
}

// The side windows and the windshield of a furnished cabin are faces of the
// shell itself (a second material group), not decals over it: only an opening
// lets the pilot and the cargo show through translucent glass. Extra sections
// at the window edges make the cut exact.
export const AIRPLANE_CABIN_WINDOW_BOX = Object.freeze({
    zStart: 0.42, zEnd: 1.46, bottomY: 1.10, topY: 1.66, minSideX: 0.25,
});
export const AIRPLANE_WINDSHIELD_BOTTOM_Y = 1.08;

// Split a face at a plane, retaining both halves. Windows and wing roots need
// actual edges at their boundaries, rather than dropping whole triangles.
function splitPolygon(polygon, distance) {
    const inside = [];
    const outside = [];
    for (let index = 0; index < polygon.length; index += 1) {
        const a = polygon[index];
        const b = polygon[(index + 1) % polygon.length];
        const da = distance(a);
        const db = distance(b);
        (da >= 0 ? inside : outside).push(a);
        if ((da > 0 && db < 0) || (da < 0 && db > 0)) {
            const t = da / (da - db);
            const point = a.map((value, axis) => value + (b[axis] - value) * t);
            inside.push(point);
            outside.push(point);
        } else if (da === 0) outside.push(a);
    }
    return { inside, outside };
}

function sectionAtZ(sections, z) {
    const sorted = [...sections].sort((a, b) => a.z - b.z);
    if (z <= sorted[0].z) return sorted[0];
    for (let index = 1; index < sorted.length; index += 1) {
        const a = sorted[index - 1];
        const b = sorted[index];
        if (z > b.z) continue;
        const t = (z - a.z) / (b.z - a.z);
        return Object.fromEntries(Object.keys(a).map(key => [key, a[key] + (b[key] - a[key]) * t]));
    }
    return sorted.at(-1);
}

function ellipseRadius(section, centerY, angle) {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const offsetY = centerY - section.centerY;
    const a = (dx / section.halfWidth) ** 2 + (dy / section.halfHeight) ** 2;
    const b = 2 * offsetY * dy / section.halfHeight ** 2;
    const c = (offsetY / section.halfHeight) ** 2 - 1;
    const discriminant = b * b - 4 * a * c;
    return discriminant < 0 ? 0 : Math.max(0, (-b + Math.sqrt(discriminant)) / (2 * a));
}

// One continuous outer skin around the fuselage and canopy. Only the outer
// envelope survives: there is no fuselage roof, canopy floor or internal cap
// crossing the cabin. Glazing replaces skin on BOTH original shapes.
export function buildAirplaneCabinShellGeometryData(radialSegments = 32) {
    const fuselage = buildAirplaneFuselageGeometryData(radialSegments);
    const segmentCount = fuselage.radialSegments;
    const box = AIRPLANE_CABIN_WINDOW_BOX;
    const rearZ = AIRPLANE_CABIN_SECTIONS[0].z;
    const frontZ = AIRPLANE_CABIN_SECTIONS.at(-1).z;
    const cabinZs = [...new Set([
        ...AIRPLANE_CABIN_SECTIONS.map(section => section.z),
        ...fuselage.sections.filter(section => section.z > rearZ && section.z < frontZ).map(section => section.z),
        box.zStart, box.zEnd,
    ])].sort((a, b) => b - a);
    const rings = [
        ...fuselage.sections.filter(section => section.z > frontZ).map(section => ({ z: section.z })),
        { z: frontZ },
        ...cabinZs.map(z => ({ z, cabin: true })),
        { z: rearZ },
        ...fuselage.sections.filter(section => section.z < rearZ).map(section => ({ z: section.z })),
    ].map(({ z, cabin }) => {
        const body = sectionAtZ(fuselage.sections, z);
        const canopy = cabin ? airplaneCabinSectionAtZ(z) : null;
        return Array.from({ length: segmentCount }, (_, index) => {
            const angle = index / segmentCount * Math.PI * 2;
            const radius = Math.max(ellipseRadius(body, body.centerY, angle),
                canopy ? ellipseRadius(canopy, body.centerY, angle) : 0);
            return [Math.cos(angle) * radius, body.centerY + Math.sin(angle) * radius, z];
        });
    });
    const positions = [];
    const vertices = new Map();
    const indices = { fuselage: [], cabin: [], glass: [] };
    const vertexIndex = point => {
        const key = point.map(value => value.toFixed(8)).join(',');
        if (!vertices.has(key)) {
            vertices.set(key, positions.length / 3);
            positions.push(...point);
        }
        return vertices.get(key);
    };
    const append = (polygon, target) => {
        for (let index = 1; index + 1 < polygon.length; index += 1) {
            const a = polygon[0];
            const b = polygon[index];
            const c = polygon[index + 1];
            const ab = b.map((value, axis) => value - a[axis]);
            const ac = c.map((value, axis) => value - a[axis]);
            const area = Math.hypot(ab[1] * ac[2] - ab[2] * ac[1],
                ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]);
            if (area > 1e-10) target.push(vertexIndex(a), vertexIndex(b), vertexIndex(c));
        }
    };
    const windowPlanes = [-1, 1].map(side => [
        p => side * p[0] - box.minSideX,
        p => p[1] - box.bottomY, p => box.topY - p[1],
        p => p[2] - box.zStart, p => box.zEnd - p[2],
    ]);
    const addFace = (face, cabin) => {
        if (!cabin) return append(face, indices.fuselage);
        const windshield = face.every(point => Math.abs(point[2] - frontZ) < 1e-8);
        const openings = windshield ? [-1, 1].map(side => [
            p => p[1] - AIRPLANE_WINDSHIELD_BOTTOM_Y,
            p => side * p[0] - 0.025,
        ]) : windowPlanes;
        let opaque = [face];
        for (const planes of openings) {
            const remaining = [];
            for (const polygon of opaque) {
                let clipped = polygon;
                for (const plane of planes) {
                    const { inside, outside } = splitPolygon(clipped, plane);
                    if (outside.length >= 3) remaining.push(outside);
                    clipped = inside;
                    if (clipped.length < 3) break;
                }
                append(clipped, indices.glass);
            }
            opaque = remaining;
        }
        for (const polygon of opaque) append(polygon, indices.cabin);
    };
    for (let ring = 0; ring + 1 < rings.length; ring += 1) {
        const cabin = rings[ring][0][2] <= frontZ && rings[ring + 1][0][2] >= rearZ;
        for (let index = 0; index < segmentCount; index += 1) {
            const next = (index + 1) % segmentCount;
            addFace([rings[ring][index], rings[ring + 1][index], rings[ring + 1][next]], cabin);
            addFace([rings[ring][index], rings[ring + 1][next], rings[ring][next]], cabin);
        }
    }
    for (const [ring, reverse] of [[rings[0], false], [rings.at(-1), true]]) {
        const centerY = sectionAtZ(fuselage.sections, ring[0][2]).centerY;
        for (let index = 0; index < segmentCount; index += 1) {
            const edge = [ring[index], ring[(index + 1) % segmentCount]];
            append([[0, centerY, ring[0][2]], ...(reverse ? edge.reverse() : edge)], indices.fuselage);
        }
    }
    return { positions, ...indices };
}

export function buildAirplaneCabinGeometryData(radialSegments = 16, { glazed = false } = {}) {
    if (!glazed) return buildEllipticalLoftGeometryData(AIRPLANE_CABIN_SECTIONS, radialSegments);
    const box = AIRPLANE_CABIN_WINDOW_BOX;
    const sections = [
        ...AIRPLANE_CABIN_SECTIONS,
        airplaneCabinSectionAtZ(box.zStart),
        airplaneCabinSectionAtZ(box.zEnd),
    ].sort((a, b) => a.z - b.z);
    const data = buildEllipticalLoftGeometryData(sections, radialSegments);
    const { positions, indices } = data;
    const noseZ = sections.at(-1).z;
    const vertex = index => ({ x: positions[index * 3], y: positions[index * 3 + 1], z: positions[index * 3 + 2] });
    const inWindow = ({ x, y, z }) => Math.abs(x) > box.minSideX
        && y >= box.bottomY - 0.02 && y <= box.topY + 0.02
        && z >= box.zStart - 0.005 && z <= box.zEnd + 0.005;
    const inWindshield = ({ y, z }) => y >= AIRPLANE_WINDSHIELD_BOTTOM_Y && z >= noseZ - 0.005;
    const body = [];
    const glass = [];
    for (let index = 0; index + 2 < indices.length; index += 3) {
        const corners = [vertex(indices[index]), vertex(indices[index + 1]), vertex(indices[index + 2])];
        const glazedFace = corners.every(inWindow) || corners.every(inWindshield);
        (glazedFace ? glass : body).push(indices[index], indices[index + 1], indices[index + 2]);
    }
    return {
        ...data,
        indices: [...body, ...glass],
        groups: [
            { start: 0, count: body.length, materialIndex: 0 },
            { start: body.length, count: glass.length, materialIndex: 1 },
        ],
    };
}

function roundedWingOutline({
    span,
    rootChord,
    tipChord,
    tipRadius,
    oneSided,
    tipSegments,
}) {
    const halfSpan = oneSided ? span : span * 0.5;
    const clampedTipRadius = Math.min(
        Math.max(0.01, tipRadius),
        halfSpan * 0.35,
        tipChord * 0.45,
    );
    const tipCenterX = halfSpan - clampedTipRadius;
    const tipHalfChord = Math.max(clampedTipRadius, tipChord * 0.5);
    const outline = [];

    const appendTip = (side, reverse = false) => {
        for (let index = 0; index <= tipSegments; index += 1) {
            const ratio = index / tipSegments;
            const angle = reverse
                ? Math.PI * 0.5 - ratio * Math.PI
                : -Math.PI * 0.5 + ratio * Math.PI;
            outline.push({
                x: side * (tipCenterX + Math.cos(angle) * clampedTipRadius),
                z: Math.sin(angle) * tipHalfChord,
            });
        }
    };

    outline.push({ x: 0, z: -rootChord * 0.5 });
    if (!oneSided) {
        appendTip(-1);
        outline.push({ x: 0, z: rootChord * 0.5 });
    }
    appendTip(1, !oneSided);
    if (oneSided) outline.push({ x: 0, z: rootChord * 0.5 });
    return outline;
}

/**
 * Builds a shallow, bevelled wing prism. The planform tapers from a broad
 * root to rounded tips; the extra edge ring makes the thickness transition
 * smooth enough to catch light without multiplying draw calls.
 */
export function buildAirplaneWingGeometryData({
    span = 8.6,
    rootChord = 1.55,
    tipChord = 0.82,
    thickness = 0.16,
    tipRadius = 0.24,
    edgeInset = 0.05,
    tipSegments = 5,
    oneSided = false,
    fuselageCutout = null,
} = {}) {
    const safeSpan = Math.max(0.2, Number(span) || 0.2);
    const safeRootChord = Math.max(0.1, Number(rootChord) || 0.1);
    const safeTipChord = Math.max(0.08, Math.min(safeRootChord, Number(tipChord) || 0.08));
    const safeThickness = Math.max(0.02, Number(thickness) || 0.02);
    const safeTipSegments = Math.max(3, Math.floor(Number(tipSegments) || 3));
    const outline = roundedWingOutline({
        span: safeSpan,
        rootChord: safeRootChord,
        tipChord: safeTipChord,
        tipRadius: Number(tipRadius) || 0.01,
        oneSided: !!oneSided,
        tipSegments: safeTipSegments,
    });
    const centroid = outline.reduce(
        (sum, point) => ({ x: sum.x + point.x, z: sum.z + point.z }),
        { x: 0, z: 0 },
    );
    centroid.x /= outline.length;
    centroid.z /= outline.length;
    const inset = Math.min(
        Math.max(0, Number(edgeInset) || 0),
        safeThickness * 0.75,
    );
    const insetOutline = outline.map((point) => {
        const dx = point.x - centroid.x;
        const dz = point.z - centroid.z;
        const distance = Math.hypot(dx, dz) || 1;
        const appliedInset = Math.min(inset, distance * 0.25);
        return {
            x: point.x - dx / distance * appliedInset,
            z: point.z - dz / distance * appliedInset,
        };
    });

    const halfThickness = safeThickness * 0.5;
    const positions = [];
    for (const point of insetOutline) positions.push(point.x, halfThickness, point.z);
    for (const point of outline) positions.push(point.x, 0, point.z);
    for (const point of insetOutline) positions.push(point.x, -halfThickness, point.z);
    const ringSize = outline.length;
    const topCenter = positions.length / 3;
    positions.push(centroid.x, halfThickness, centroid.z);
    const bottomCenter = positions.length / 3;
    positions.push(centroid.x, -halfThickness, centroid.z);

    const indices = [];
    for (let index = 0; index < ringSize; index += 1) {
        const next = (index + 1) % ringSize;
        const top = index;
        const edge = ringSize + index;
        const bottom = ringSize * 2 + index;
        const topNext = next;
        const edgeNext = ringSize + next;
        const bottomNext = ringSize * 2 + next;
        indices.push(
            topCenter, top, topNext,
            bottomCenter, bottomNext, bottom,
            top, edge, edgeNext,
            top, edgeNext, topNext,
            edge, bottom, bottomNext,
            edge, bottomNext, edgeNext,
        );
    }
    let wingPositions = positions;
    let wingIndices = indices;
    if (fuselageCutout) {
        // Two wings meet the outside of the airframe. The centre section must
        // not be a shelf through the seats and baggage compartment.
        wingPositions = [];
        wingIndices = [];
        for (let index = 0; index < indices.length; index += 3) {
            const triangle = indices.slice(index, index + 3).map(vertex => positions.slice(vertex * 3, vertex * 3 + 3));
            for (const side of [-1, 1]) {
                const { inside } = splitPolygon(triangle, point => side * point[0]);
                const polygon = inside.map(([x, y, z]) => [side * Math.max(side * x,
                    airplaneBodySurfaceXAt(z + fuselageCutout.z, y + fuselageCutout.y) - 0.008), y, z]);
                for (let corner = 1; corner + 1 < polygon.length; corner += 1) {
                    const base = wingPositions.length / 3;
                    wingPositions.push(...polygon[0], ...polygon[corner], ...polygon[corner + 1]);
                    wingIndices.push(base, base + 1, base + 2);
                }
            }
        }
    }
    return {
        positions: wingPositions,
        indices: wingIndices,
        outline,
        oneSided: !!oneSided,
        span: safeSpan,
        rootChord: safeRootChord,
        tipChord: safeTipChord,
        thickness: safeThickness,
    };
}

export const AIRPLANE_LANDING_GEAR_ASSEMBLIES = Object.freeze([
    Object.freeze({ name: 'main-left', x: -1.62, y: -0.22, z: 0.12 }),
    Object.freeze({ name: 'main-right', x: 1.62, y: -0.22, z: 0.12 }),
    Object.freeze({ name: 'nose', x: 0, y: -0.22, z: 2.62 }),
]);
