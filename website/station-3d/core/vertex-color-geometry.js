// Plain-array geometry primitives for merged, vertex-coloured decor meshes —
// pure, no THREE, no DOM, so the shapes are provable headless.
//
// Everything appends into { positions, colors } flat arrays that a caller turns
// into ONE BufferGeometry sharing ONE material. That is the whole point: decor
// built this way merges into the buildings batcher instead of adding a draw call
// per bush, chair or bench. Shared by the new-build roof decor and the courtyard
// landscaping.

export function createDecorArrays() {
    return { positions: [], colors: [] };
}

export function pushTriangle(arrays, ax, ay, az, bx, by, bz, cx, cy, cz, color) {
    arrays.positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    for (let i = 0; i < 3; i++) arrays.colors.push(color.r, color.g, color.b);
}

export function pushQuad(arrays, a, b, c, d, color) {
    pushTriangle(arrays, a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], color);
    pushTriangle(arrays, a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2], color);
}

// Box centred on (cx, cz), standing on baseY, rotated by `angle` about Y.
// `caps` adds the top face; posts and legs skip it — nobody sees the top of a
// 5 cm post, and it is a sixth of the triangles.
export function pushBox(arrays, cx, baseY, cz, w, h, d, angle, color, caps = true) {
    const hw = w / 2;
    const hd = d / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const corner = (dx, dz, y) => [cx + dx * cos - dz * sin, y, cz + dx * sin + dz * cos];
    const y0 = baseY;
    const y1 = baseY + h;
    const p = [
        corner(-hw, -hd, y0), corner(hw, -hd, y0), corner(hw, hd, y0), corner(-hw, hd, y0),
        corner(-hw, -hd, y1), corner(hw, -hd, y1), corner(hw, hd, y1), corner(-hw, hd, y1),
    ];
    pushQuad(arrays, p[0], p[1], p[5], p[4], color);
    pushQuad(arrays, p[1], p[2], p[6], p[5], color);
    pushQuad(arrays, p[2], p[3], p[7], p[6], color);
    pushQuad(arrays, p[3], p[0], p[4], p[7], color);
    if (caps) pushQuad(arrays, p[4], p[5], p[6], p[7], color);
}

// Vertical ribbon following a closed ring between two heights (railings).
export function pushRingRibbon(arrays, ring, y0, y1, color) {
    for (let i = 0, n = ring.length - 1; i < n; i++) {
        pushQuad(
            arrays,
            [ring[i].x, y0, ring[i].z],
            [ring[i + 1].x, y0, ring[i + 1].z],
            [ring[i + 1].x, y1, ring[i + 1].z],
            [ring[i].x, y1, ring[i].z],
            color,
        );
    }
}

// Flat band between two matching rings (jogging track, perimeter path).
export function pushRingBand(arrays, outer, inner, y, color) {
    for (let i = 0, n = Math.min(outer.length, inner.length) - 1; i < n; i++) {
        pushQuad(
            arrays,
            [outer[i].x, y, outer[i].z],
            [outer[i + 1].x, y, outer[i + 1].z],
            [inner[i + 1].x, y, inner[i + 1].z],
            [inner[i].x, y, inner[i].z],
            color,
        );
    }
}

export function pushFlatPatch(arrays, cx, cz, w, d, angle, y, color) {
    const hw = w / 2;
    const hd = d / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const corner = (dx, dz) => [cx + dx * cos - dz * sin, y, cz + dx * sin + dz * cos];
    pushQuad(arrays, corner(-hw, -hd), corner(hw, -hd), corner(hw, hd), corner(-hw, hd), color);
}

// Flat strip from a to b of a given width — a straight footpath leg.
export function pushFlatStrip(arrays, a, b, widthM, y, color) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (!(length > 1e-6)) return;
    const nx = (-dz / length) * (widthM / 2);
    const nz = (dx / length) * (widthM / 2);
    pushQuad(
        arrays,
        [a.x + nx, y, a.z + nz],
        [b.x + nx, y, b.z + nz],
        [b.x - nx, y, b.z - nz],
        [a.x - nx, y, a.z - nz],
        color,
    );
}

// Low-poly sphere blob (bushes, tree crowns) — flat-shaded on purpose.
export function pushBlob(arrays, cx, cy, cz, r, squashY, color) {
    const W = 6;
    const H = 4;
    const point = (i, j) => {
        const phi = (j / H) * Math.PI;
        const theta = (i / W) * Math.PI * 2;
        return [
            cx + r * Math.sin(phi) * Math.cos(theta),
            cy + r * squashY * Math.cos(phi),
            cz + r * Math.sin(phi) * Math.sin(theta),
        ];
    };
    for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
            const a = point(i, j);
            const b = point(i + 1, j);
            const c = point(i + 1, j + 1);
            const d = point(i, j + 1);
            if (j > 0) pushTriangle(arrays, a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], color);
            if (j < H - 1) pushTriangle(arrays, a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2], color);
        }
    }
}

// A tree: trunk plus crown, sized from its total height. The crown is seated so
// its top lands exactly on `heightM` — a caller that spaced trees under a
// clearance would otherwise be quietly wrong by the crown's overshoot.
const TREE_CROWN_RADIUS_RATIO = 0.34;
const TREE_CROWN_SQUASH = 0.9;

export function pushTree(arrays, x, z, heightM, trunkColor, foliageColor, baseY = 0) {
    const crownRadius = heightM * TREE_CROWN_RADIUS_RATIO;
    const crownCentreY = heightM - crownRadius * TREE_CROWN_SQUASH;
    pushBox(arrays, x, baseY, z, 0.14, crownCentreY, 0.14, 0, trunkColor, false);
    pushBlob(arrays, x, baseY + crownCentreY, z, crownRadius, TREE_CROWN_SQUASH, foliageColor);
}

// Parasol on a pole. Segment colours alternate through `canopyColors`, so one
// umbrella can be striped rather than flat — passing a single colour keeps the
// plain look.
export function pushSunshade(arrays, x, z, canopyColors, poleColor, baseY = 0) {
    const colors = Array.isArray(canopyColors) ? canopyColors : [canopyColors];
    pushBox(arrays, x, baseY, z, 0.06, 2.2, 0.06, 0, poleColor, false);
    const R = 1.4;
    const TOP = baseY + 2.35;
    const RIM = baseY + 1.85;
    const SEGMENTS = 8;
    for (let i = 0; i < SEGMENTS; i++) {
        const a0 = (i / SEGMENTS) * Math.PI * 2;
        const a1 = ((i + 1) / SEGMENTS) * Math.PI * 2;
        pushTriangle(
            arrays,
            x, TOP, z,
            x + R * Math.cos(a0), RIM, z + R * Math.sin(a0),
            x + R * Math.cos(a1), RIM, z + R * Math.sin(a1),
            colors[i % colors.length],
        );
    }
}

// Lightweight slatted cafe chair. `angle` points toward the seated person's
// view in map XZ (the roof layout uses this to turn paired chairs toward their
// parasol pole). Four narrow legs carry separate seat slats; the rear pair
// continues into a gently reclined open back instead of forming a solid slab.
export function pushCafeChair(
    arrays,
    x,
    z,
    angle,
    slatColor,
    frameColor = slatColor,
    baseY = 0,
) {
    const WIDTH = 0.48;
    const DEPTH = 0.46;
    const SEAT_Y = 0.44;
    const BACK_TOP_Y = 0.89;
    const TUBE = 0.035;
    const EDGE_INSET = 0.02;
    const frontX = Math.cos(angle);
    const frontZ = Math.sin(angle);
    const sideX = -frontZ;
    const sideZ = frontX;
    const point = (side, forward, y) => [
        x + sideX * side + frontX * forward,
        baseY + y,
        z + sideZ * side + frontZ * forward,
    ];
    // pushBox's local depth axis is the chair's front/back axis at this angle.
    const meshAngle = angle - Math.PI / 2;
    const legSide = WIDTH / 2 - TUBE / 2;
    const legFront = DEPTH / 2 - TUBE / 2;

    for (const side of [-legSide, legSide]) {
        for (const forward of [-legFront, legFront]) {
            const centre = point(side, forward, 0);
            pushBox(
                arrays,
                centre[0],
                baseY,
                centre[2],
                TUBE,
                SEAT_Y,
                TUBE,
                meshAngle,
                frameColor,
                false,
            );
        }
    }

    // Rear uprights lean back by 6 cm over their rise. Open ribbons are
    // sufficient because the shared decor material is intentionally two-sided.
    const backBottom = -legFront;
    const backTop = backBottom - 0.06;
    for (const side of [-legSide, legSide]) {
        pushQuad(
            arrays,
            point(side - TUBE / 2, backBottom, SEAT_Y),
            point(side + TUBE / 2, backBottom, SEAT_Y),
            point(side + TUBE / 2, backTop, BACK_TOP_Y),
            point(side - TUBE / 2, backTop, BACK_TOP_Y),
            frameColor,
        );
    }

    // Four separated seat boards keep the silhouette open from every walking
    // height while retaining enough width to read clearly at roof LOD range.
    const slatCount = 4;
    const slatGap = 0.018;
    const usableDepth = DEPTH - EDGE_INSET * 2;
    const slatDepth = (usableDepth - slatGap * (slatCount - 1)) / slatCount;
    const seatStart = -DEPTH / 2 + EDGE_INSET;
    for (let index = 0; index < slatCount; index++) {
        const from = seatStart + index * (slatDepth + slatGap);
        const to = from + slatDepth;
        pushQuad(
            arrays,
            point(-WIDTH / 2, from, SEAT_Y),
            point(WIDTH / 2, from, SEAT_Y),
            point(WIDTH / 2, to, SEAT_Y),
            point(-WIDTH / 2, to, SEAT_Y),
            slatColor,
        );
    }

    const backForwardAt = y => backBottom
        + (backTop - backBottom) * ((y - SEAT_Y) / (BACK_TOP_Y - SEAT_Y));
    for (const [fromY, toY] of [[0.59, 0.68], [0.75, 0.85]]) {
        pushQuad(
            arrays,
            point(-WIDTH / 2, backForwardAt(fromY), fromY),
            point(WIDTH / 2, backForwardAt(fromY), fromY),
            point(WIDTH / 2, backForwardAt(toY), toY),
            point(-WIDTH / 2, backForwardAt(toY), toY),
            slatColor,
        );
    }
}

// Wooden bench: seat slab, backrest and two legs. `angle` is the yaw of a
// seated person facing away from the backrest, matching THREE.Object3D's local
// +Z convention and the shared ambient-bench contract.
export function pushBench(arrays, x, z, angle, woodColor, baseY = 0) {
    const LENGTH = 1.7;
    const DEPTH = 0.5;
    const SEAT_Y = 0.42;
    // pushBox uses map-plane rotation, whose sign is opposite THREE's yaw.
    const meshAngle = -angle;
    pushBox(arrays, x, baseY + SEAT_Y, z, LENGTH, 0.07, DEPTH, meshAngle, woodColor, true);
    // Backrest is opposite the occupant's +Z-facing direction.
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const backX = x - sin * (DEPTH / 2 - 0.05);
    const backZ = z - cos * (DEPTH / 2 - 0.05);
    pushBox(arrays, backX, baseY + SEAT_Y + 0.07, backZ, LENGTH, 0.42, 0.06, meshAngle, woodColor, true);
    for (const side of [-1, 1]) {
        const legX = x + cos * side * (LENGTH / 2 - 0.15);
        const legZ = z - sin * side * (LENGTH / 2 - 0.15);
        pushBox(arrays, legX, baseY, legZ, 0.08, SEAT_Y, DEPTH * 0.8, meshAngle, woodColor, false);
    }
}
