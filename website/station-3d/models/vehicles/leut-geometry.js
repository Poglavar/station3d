// Pure geometry for the Adriatic courier boat: an 8.5 m Dalmatian wooden leut
// with a raked curved stem, round bilge, open cargo well and a wheelhouse aft
// of midships. No Three.js here — the builder accumulates per-material
// triangle soups with smooth-by-angle normals so the hull lines, decks and
// fittings are testable headlessly. The lines are authored in the Blender
// frame they were designed in (X starboard, Y bow, Z up, origin at midship on
// the waterline) and converted to the model frame (+Z nose, +Y up, +X port,
// y = 0 at the waterline) on output.

// ------------------------------------------------------------------ lines
export const LEUT_Y_STERN = -4.0;     // sternpost at the sheer
export const LEUT_Y_STEM = 4.5;       // stem head at the sheer
const YB = -0.4;                      // lowest point of the sheer line
const HW = 1.37;                      // greatest half-beam at the sheer
const ZS_MID = 0.72;                  // sheer above the waterline amidships
const KEEL_Z = -0.78;
const POST_HW = 0.05;                 // stem / sternpost half thickness
const KX = 0.045;                     // keel half thickness
const BULWARK = 0.33;                 // bulwark above the sheer
const BAND = [-0.10, 0.12];           // boot-top: antifouling below, topsides above
const FOREFOOT_Y = 3.55;
const HEEL_Y = -3.85;
const N_BELOW = 5;
const N_BAND = 2;
const N_ABOVE = 8;

// Interaction box (model frame, centred on the origin; the stem band reaches
// z 4.53 and the rudder z −4.34, so the box is longer than the 8.5 m hull) and
// the helm eye point:
// the wheelhouse spans z −2.35…−0.25, the helmsman stands just aft of the front
// windows with the deck at y ≈ 0.74 and the roof underside at y ≈ 2.34.
export const LEUT_HULL_DIMENSIONS = Object.freeze({ width: 3.0, length: 9.2, height: 2.5 });
export const LEUT_HELM_EYE = Object.freeze({ x: 0, y: 2.05, z: -0.8 });
export const LEUT_WHEELHOUSE = Object.freeze({ zAft: -2.35, zFore: -0.25, halfWidth: 0.88, deckY: 0.74, roofY: 2.34 });

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { const s = clamp(t); return s * s * (3 - 2 * s); };

export function leutSheerZ(y) {
    if (y >= YB) {
        const t = clamp((y - YB) / (LEUT_Y_STEM - YB));
        return ZS_MID + 0.56 * t ** 2.1;
    }
    const t = clamp((YB - y) / (YB - LEUT_Y_STERN));
    return ZS_MID + 0.24 * t ** 2.3;
}

export function leutHalfBeam(y) {
    let hw;
    if (y >= YB) {
        const t = clamp((y - YB) / (LEUT_Y_STEM - YB));
        hw = HW * (1 - t ** 2.7) ** 0.66;
    } else {
        const t = clamp((YB - y) / (YB - LEUT_Y_STERN));
        hw = HW * (1 - t ** 2.3) ** 0.72;
    }
    return Math.max(POST_HW, Number.isFinite(hw) ? hw : POST_HW);
}

export function leutKeelZ(y) {
    if (y >= FOREFOOT_Y) {                       // curved, forward-raked stem
        const t = clamp((y - FOREFOOT_Y) / (LEUT_Y_STEM - FOREFOOT_Y));
        return lerp(-0.14, leutSheerZ(LEUT_Y_STEM), t ** 1.55);
    }
    if (y >= 2.1) {                              // forefoot
        const t = clamp((y - 2.1) / (FOREFOOT_Y - 2.1));
        return lerp(KEEL_Z, -0.14, t ** 1.7);
    }
    if (y >= -2.9) return KEEL_Z;
    if (y >= HEEL_Y) {                           // keel rising to the sternpost heel
        return lerp(KEEL_Z, -0.46, smooth((-2.9 - y) / (-2.9 - HEEL_Y)));
    }
    const t = clamp((HEEL_Y - y) / (HEEL_Y - LEUT_Y_STERN));   // raked sternpost
    return lerp(-0.46, leutSheerZ(LEUT_Y_STERN), t ** 0.9);
}

// (p, q): width and rise exponents of the section curve. Small p = full round
// bilge; small q = V-shaped entry.
function fullness(y) {
    const t = y >= YB ? clamp((y - YB) / (LEUT_Y_STEM - YB)) : clamp((YB - y) / (YB - LEUT_Y_STERN));
    return [lerp(0.60, 1.40, t ** 2.0), lerp(1.40, 0.72, t ** 1.7)];
}

function sectionFn(y) {
    const hw = leutHalfBeam(y);
    const zs = leutSheerZ(y);
    const zk = leutKeelZ(y);
    const [p, q] = fullness(y);
    const pt = (t) => {
        const s = Math.sin(t * Math.PI / 2);
        const c = Math.cos(t * Math.PI / 2);
        return [KX + (hw - KX) * s ** p, zk + (zs - zk) * (1 - c ** q)];
    };
    return { pt, hw, zs, zk };
}

function tAtZ(pt, zk, zs, zb) {
    if (zk >= zb) return 0;
    if (zs <= zb) return 1;
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < 40; k += 1) {
        const mid = (lo + hi) / 2;
        if (pt(mid)[1] < zb) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
}

// Half-width of the hull skin at height z on station y.
export function leutSurfaceX(y, z) {
    const { pt, hw, zs, zk } = sectionFn(y);
    if (z >= zs) return hw + 0.02 * clamp((z - zs) / BULWARK);
    return pt(tAtZ(pt, zk, zs, z))[0];
}

// Keel → sheer → bulwark top as [x, z], the boot-top rows always at the same
// indices so the material bands stay crisp along the whole hull.
export function leutHalfSection(y) {
    const { pt, hw, zs, zk } = sectionFn(y);
    const t1 = tAtZ(pt, zk, zs, BAND[0]);
    const t2 = tAtZ(pt, zk, zs, BAND[1]);
    const ts = [];
    for (let i = 0; i < N_BELOW; i += 1) ts.push(t1 * i / N_BELOW);
    for (let i = 0; i < N_BAND; i += 1) ts.push(lerp(t1, t2, i / N_BAND));
    for (let i = 0; i <= N_ABOVE; i += 1) ts.push(lerp(t2, 1, i / N_ABOVE));
    const pts = ts.map(pt);
    pts.push([hw + 0.012, zs + BULWARK * 0.5]);
    pts.push([hw + 0.02, zs + BULWARK]);
    return pts;
}

// Material slot of the segment (i, i+1) of a half section.
function rowMaterial(i) {
    if (i < N_BELOW) return 0;                          // antifouling
    if (i < N_BELOW + N_BAND) return 1;                 // boot-top
    if (i >= N_BELOW + N_BAND + N_ABOVE) return 2;      // bulwark
    return 2 + (i - N_BELOW - N_BAND) % 2;              // alternating plank strakes
}

function stations(n, y0 = LEUT_Y_STERN, y1 = LEUT_Y_STEM) {
    const out = [];
    for (let i = 0; i <= n; i += 1) out.push(lerp(y0, y1, 0.5 - 0.5 * Math.cos(Math.PI * i / n)));
    return out;
}

// ------------------------------------------------------------------ materials
// Linear-RGB base colours as designed in Blender. `family` decides how the
// model factory merges them: hull and paint are vertex-coloured standard
// materials, metal is a metallic one, glass is transparent, lamps are unlit.
export const LEUT_MATERIALS = Object.freeze({
    Antifouling: { color: [0.36, 0.09, 0.07], family: 'hull' },
    BootTop: { color: [0.90, 0.89, 0.84], family: 'hull' },
    HullBlue: { color: [0.05, 0.27, 0.60], family: 'hull' },
    HullBlue2: { color: [0.045, 0.245, 0.555], family: 'hull' },
    Wood: { color: [0.38, 0.20, 0.08], family: 'paint' },
    WoodPale: { color: [0.58, 0.44, 0.27], family: 'paint' },
    Deck: { color: [0.66, 0.60, 0.50], family: 'paint' },
    Deck2: { color: [0.61, 0.55, 0.45], family: 'paint' },
    CabinWhite: { color: [0.91, 0.90, 0.85], family: 'paint' },
    Roof: { color: [0.80, 0.77, 0.68], family: 'paint' },
    Glass: { color: [0.60, 0.78, 0.86], family: 'glass' },
    Iron: { color: [0.11, 0.11, 0.12], family: 'metal' },
    Brass: { color: [0.74, 0.56, 0.24], family: 'metal' },
    Rubber: { color: [0.045, 0.045, 0.045], family: 'paint' },
    Rope: { color: [0.76, 0.68, 0.50], family: 'paint' },
    Canvas: { color: [0.36, 0.40, 0.31], family: 'paint' },
    Crate: { color: [0.60, 0.46, 0.28], family: 'paint' },
    Orange: { color: [0.92, 0.32, 0.06], family: 'paint' },
    Lettering: { color: [0.95, 0.95, 0.92], family: 'paint' },
    LampRed: { color: [1.0, 0.12, 0.10], family: 'lamp' },
    LampGreen: { color: [0.15, 1.0, 0.35], family: 'lamp' },
    LampWhite: { color: [1.0, 0.92, 0.70], family: 'lamp' },
    CabinGlow: { color: [1.0, 0.65, 0.30], family: 'lamp' },
});

// ------------------------------------------------------------------ builder
const DEG = Math.PI / 180;

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(a) {
    const l = Math.hypot(a[0], a[1], a[2]);
    return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
}

// Blender XYZ Euler: rotate about X, then Y, then Z.
function eulerXYZ(rx, ry, rz) {
    const cx = Math.cos(rx); const sx = Math.sin(rx);
    const cy = Math.cos(ry); const sy = Math.sin(ry);
    const cz = Math.cos(rz); const sz = Math.sin(rz);
    return (p) => {
        let [x, y, z] = p;
        [y, z] = [cx * y - sx * z, sx * y + cx * z];
        [x, z] = [cy * x + sy * z, -sy * x + cy * z];
        [x, y] = [cz * x - sz * y, sz * x + cz * y];
        return [x, y, z];
    };
}

// Accumulates polygons per material and emits triangle soups with normals.
class Soup {
    constructor() {
        this.groups = new Map();
    }

    // verts: [x, y, z][]; faces: index polygons; faceMaterials indexes `materials`.
    add(verts, faces, materials, { smooth = true, faceMaterials = null, sharpDeg = 38 } = {}) {
        const faceNormals = [];
        const faceList = [];
        for (let f = 0; f < faces.length; f += 1) {
            const poly = faces[f];
            // Newell's method handles ngons and skips degenerate faces.
            let nx = 0; let ny = 0; let nz = 0;
            for (let i = 0; i < poly.length; i += 1) {
                const a = verts[poly[i]];
                const b = verts[poly[(i + 1) % poly.length]];
                nx += (a[1] - b[1]) * (a[2] + b[2]);
                ny += (a[2] - b[2]) * (a[0] + b[0]);
                nz += (a[0] - b[0]) * (a[1] + b[1]);
            }
            const l = Math.hypot(nx, ny, nz);
            if (l < 1e-9) continue;
            faceNormals.push([nx / l, ny / l, nz / l]);
            faceList.push({ poly, material: faceMaterials ? faceMaterials[f] : 0 });
        }
        const vertexFaces = new Map();
        if (smooth) {
            faceList.forEach(({ poly }, fi) => {
                for (const vi of poly) {
                    let list = vertexFaces.get(vi);
                    if (!list) { list = []; vertexFaces.set(vi, list); }
                    list.push(fi);
                }
            });
        }
        const cosSharp = Math.cos(sharpDeg * DEG);
        faceList.forEach(({ poly, material }, fi) => {
            const fn = faceNormals[fi];
            const corner = poly.map((vi) => {
                if (!smooth) return fn;
                let sx = 0; let sy = 0; let sz = 0;
                for (const other of vertexFaces.get(vi)) {
                    const on = faceNormals[other];
                    if (dot(on, fn) >= cosSharp) { sx += on[0]; sy += on[1]; sz += on[2]; }
                }
                return norm([sx, sy, sz]);
            });
            const group = this.group(materials[material]);
            for (let i = 1; i < poly.length - 1; i += 1) {
                for (const k of [0, i, i + 1]) {
                    const v = verts[poly[k]];
                    const n = corner[k];
                    group.positions.push(v[0], v[1], v[2]);
                    group.normals.push(n[0], n[1], n[2]);
                }
            }
        });
    }

    group(material) {
        let g = this.groups.get(material);
        if (!g) {
            g = { material, positions: [], normals: [] };
            this.groups.set(material, g);
        }
        return g;
    }
}

// ---- primitives (all emit into the soup in the Blender frame)
function loft(soup, rings, materials, { caps = [false, false], smooth = true, faceMaterialFn = null, closed = true } = {}) {
    const verts = [];
    const faces = [];
    const fmats = [];
    const n = rings[0].length;
    for (const r of rings) for (const p of r) verts.push(p);
    const segs = closed ? n : n - 1;
    for (let s = 0; s < rings.length - 1; s += 1) {
        const a = s * n;
        const b = (s + 1) * n;
        for (let i = 0; i < segs; i += 1) {
            const j = (i + 1) % n;
            faces.push([a + i, a + j, b + j, b + i]);
            fmats.push(faceMaterialFn ? faceMaterialFn(s, i) : 0);
        }
    }
    if (caps[0]) { faces.push(Array.from({ length: n }, (_, i) => n - 1 - i)); fmats.push(0); }
    if (caps[1]) {
        const base = (rings.length - 1) * n;
        faces.push(Array.from({ length: n }, (_, i) => base + i));
        fmats.push(0);
    }
    soup.add(verts, faces, materials, { smooth, faceMaterials: fmats });
}

function box(soup, size, centre, material, { rot = null, transform = null } = {}) {
    const [sx, sy, sz] = size.map((s) => s * 0.5);
    let v = [[-sx, -sy, -sz], [sx, -sy, -sz], [sx, sy, -sz], [-sx, sy, -sz],
        [-sx, -sy, sz], [sx, -sy, sz], [sx, sy, sz], [-sx, sy, sz]];
    if (rot) { const r = eulerXYZ(...rot); v = v.map(r); }
    v = v.map((p) => add(p, centre));
    if (transform) v = v.map(transform);
    const f = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
    soup.add(v, f, [material], { smooth: false });
}

function quad(soup, pts, material) {
    soup.add(pts, [[0, 1, 2, 3]], [material], { smooth: false });
}

function prism(soup, cornersBottom, up, material) {
    const v = [...cornersBottom, ...cornersBottom.map((p) => add(p, up))];
    const f = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
    soup.add(v, f, [material], { smooth: false });
}

function grid(soup, y0, y1, xl, xr, zf, material, { ny = 8, nx = 6, planks = null } = {}) {
    const verts = [];
    const faces = [];
    const fmats = [];
    for (let i = 0; i <= ny; i += 1) {
        const y = lerp(y0, y1, i / ny);
        const a = xl(y);
        const b = xr(y);
        for (let j = 0; j <= nx; j += 1) {
            const x = lerp(a, b, j / nx);
            verts.push([x, y, zf(y, x)]);
        }
    }
    for (let i = 0; i < ny; i += 1) {
        for (let j = 0; j < nx; j += 1) {
            const v = i * (nx + 1) + j;
            faces.push([v, v + 1, v + nx + 2, v + nx + 1]);
            fmats.push(planks ? j % 2 : 0);
        }
    }
    soup.add(verts, faces, planks ? [material, planks] : [material], { smooth: true, faceMaterials: fmats });
}

function cylinder(soup, r0, r1, length, centre, axis, material, { n = 18, smooth = true, caps = [true, true] } = {}) {
    const rings = [];
    for (const [t, r] of [[0, r0], [1, r1]]) {
        const ring = [];
        for (let i = 0; i < n; i += 1) {
            const a = 2 * Math.PI * i / n;
            const u = r * Math.cos(a);
            const v = r * Math.sin(a);
            const d = (t - 0.5) * length;
            const p = axis === 'X' ? [d, u, v] : axis === 'Y' ? [u, d, v] : [u, v, d];
            ring.push(add(p, centre));
        }
        rings.push(ring);
    }
    loft(soup, rings, [material], { caps, smooth });
}

function rod(soup, p0, p1, r, material, { n = 8 } = {}) {
    const d = sub(p1, p0);
    const w = norm(d);
    const helper = Math.abs(w[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const u = norm(cross(helper, w));
    const v = cross(w, u);
    const rings = [];
    for (const t of [0, 1]) {
        const base = t === 0 ? p0 : p1;
        const ring = [];
        for (let i = 0; i < n; i += 1) {
            const a = 2 * Math.PI * i / n;
            ring.push(add(base, add(scale(u, r * Math.cos(a)), scale(v, r * Math.sin(a)))));
        }
        rings.push(ring);
    }
    loft(soup, rings, [material], { caps: [true, true] });
}

function torus(soup, centre, R, r, materials, { nMajor = 24, nMinor = 10, rot = null, faceMaterialFn = null } = {}) {
    const rotate = rot ? eulerXYZ(...rot) : (p) => p;
    const verts = [];
    const faces = [];
    const fmats = [];
    for (let i = 0; i < nMajor; i += 1) {
        const a = 2 * Math.PI * i / nMajor;
        const c = Math.cos(a);
        const s = Math.sin(a);
        for (let j = 0; j < nMinor; j += 1) {
            const b = 2 * Math.PI * j / nMinor;
            const rr = R + r * Math.cos(b);
            verts.push(add(rotate([rr * c, rr * s, r * Math.sin(b)]), centre));
        }
    }
    for (let s = 0; s < nMajor; s += 1) {
        const a = s * nMinor;
        const b = ((s + 1) % nMajor) * nMinor;
        for (let i = 0; i < nMinor; i += 1) {
            const j = (i + 1) % nMinor;
            faces.push([a + i, a + j, b + j, b + i]);
            fmats.push(faceMaterialFn ? faceMaterialFn(s) : 0);
        }
    }
    soup.add(verts, faces, materials, { smooth: true, faceMaterials: fmats });
}

// Box with rounded vertical edges and a slight crown (the lashed tarpaulin).
function softBox(soup, size, centre, material, { n = 12 } = {}) {
    const [sx, sy, sz] = size;
    const rings = [];
    for (const [t, k] of [[0, 0.62], [0.08, 0.93], [0.5, 1.0], [0.92, 0.93], [1.0, 0.62]]) {
        const y = -sy * 0.5 + sy * t;
        const ring = [];
        for (let i = 0; i < n; i += 1) {
            const a = 2 * Math.PI * i / n;
            const c = Math.cos(a);
            const s = Math.sin(a);
            const ux = Math.sign(c) * Math.abs(c) ** 0.5;
            const uz = Math.sign(s) * Math.abs(s) ** 0.5;
            ring.push(add([sx * 0.5 * ux * k, y, sz * 0.5 * uz * k], centre));
        }
        rings.push(ring);
    }
    loft(soup, rings, [material], { caps: [true, true] });
}

function triangle(soup, pts, material) {
    soup.add(pts, [[0, 1, 2]], [material], { smooth: false });
}

// ------------------------------------------------------------------ hull
function buildHull(soup) {
    const ys = stations(72);
    const rings = [];
    let segRow = null;
    for (const y of ys) {
        const half = leutHalfSection(y);
        const port = [...half].reverse().map(([x, z]) => [-x, y, z]);
        const stbd = half.map(([x, z]) => [x, y, z]);
        rings.push([...port, ...stbd]);
        if (!segRow) {
            const rows = [];
            for (let i = 0; i < half.length - 1; i += 1) rows.push(rowMaterial(i));
            segRow = [...[...rows].reverse(), 0, ...rows];
        }
    }
    loft(soup, rings, ['Antifouling', 'BootTop', 'HullBlue', 'HullBlue2'], {
        faceMaterialFn: (s, i) => segRow[i], closed: false,
    });
    // closures of the two thin posts
    const n = rings[0].length;
    const halfN = n / 2;
    for (const ringIndex of [0, rings.length - 1]) {
        const verts = rings[ringIndex];
        const faces = [];
        for (let i = 0; i < halfN - 1; i += 1) faces.push([i, i + 1, n - 1 - i - 1, n - 1 - i]);
        soup.add(verts, faces, ['HullBlue'], { smooth: false });
    }

    // keel + stem band, leaving the propeller aperture open aft of y = −3.4
    const bandRings = (ylist) => ylist.map((y) => {
        const zk = leutKeelZ(y);
        const dz = leutKeelZ(y + 0.02) - leutKeelZ(y - 0.02);
        const dl = Math.hypot(0.04, dz);
        const d = [0.04 / dl, dz / dl];
        const nrm = [d[1], -d[0]];                        // forward-down
        const pIn = [y - nrm[0] * 0.03, zk - nrm[1] * 0.03];
        const pOut = [y + nrm[0] * 0.07, zk + nrm[1] * 0.07];
        return [[-POST_HW, pIn[0], pIn[1]], [POST_HW, pIn[0], pIn[1]],
            [POST_HW, pOut[0], pOut[1]], [-POST_HW, pOut[0], pOut[1]]];
    });
    loft(soup, bandRings(stations(48, -3.4, LEUT_Y_STEM - 0.03)), ['Antifouling'], { caps: [true, true], smooth: false });
    loft(soup, bandRings(stations(8, LEUT_Y_STERN + 0.005, HEEL_Y)), ['Antifouling'], { caps: [true, true], smooth: false });

    // rubbing strake along the sheer, cap rail on the bulwark
    for (const side of [-1, 1]) {
        const strake = [];
        const cap = [];
        for (const y of stations(60, LEUT_Y_STERN + 0.03, LEUT_Y_STEM - 0.12)) {
            const hw = leutHalfBeam(y) + 0.012;
            const zs = leutSheerZ(y);
            strake.push([[side * (hw + 0.005), y, zs - 0.06], [side * (hw + 0.05), y, zs - 0.045],
                [side * (hw + 0.075), y, zs], [side * (hw + 0.05), y, zs + 0.045],
                [side * (hw + 0.005), y, zs + 0.06], [side * (hw - 0.01), y, zs]]);
            const top = zs + BULWARK;
            const xo = leutHalfBeam(y) + 0.02;
            cap.push([[side * (xo - 0.09), y, top - 0.01], [side * (xo + 0.05), y, top - 0.01],
                [side * (xo + 0.05), y, top + 0.045], [side * (xo - 0.09), y, top + 0.045]]);
        }
        loft(soup, strake, ['Wood'], { caps: [true, true] });
        loft(soup, cap, ['Wood'], { caps: [true, true], smooth: false });
    }
}

// ------------------------------------------------------------------ decks
export function leutDeckZ(y, x) {
    const hw = leutHalfBeam(y);
    return leutSheerZ(y) - 0.03 + 0.07 * (1 - clamp(Math.abs(x) / hw) ** 2);
}

const hwIn = (y) => leutHalfBeam(y) - 0.012;
const WELL = { y0: -0.25, y1: 1.35, hx: 0.84, floor: 0.30 };          // cargo well
const COCKPIT = { y0: -3.35, y1: -2.35, floor: 0.32 };                // aft cockpit
const HOUSE = { y0: -2.35, y1: -0.25, hx: 0.88, rake: 0.14, h: 1.60 };
const cockpitHx = (y) => Math.min(0.62, hwIn(y) - 0.22);

function buildDecks(soup) {
    const deck = 'Deck';
    const wood = 'WoodPale';
    grid(soup, WELL.y1, LEUT_Y_STEM - 0.06, (y) => -hwIn(y), hwIn, leutDeckZ, deck, { ny: 18, nx: 14, planks: 'Deck2' });
    for (const side of [-1, 1]) {
        grid(soup, WELL.y0, WELL.y1,
            (y) => (side > 0 ? Math.min(WELL.hx, hwIn(y)) : -hwIn(y)),
            (y) => (side > 0 ? hwIn(y) : -WELL.hx),
            leutDeckZ, deck, { ny: 6, nx: 2 });
    }
    grid(soup, HOUSE.y0, HOUSE.y1, (y) => -hwIn(y), hwIn, leutDeckZ, wood, { ny: 8, nx: 12, planks: 'Deck2' });
    for (const side of [-1, 1]) {
        grid(soup, COCKPIT.y0, COCKPIT.y1,
            (y) => (side > 0 ? cockpitHx(y) : -hwIn(y)),
            (y) => (side > 0 ? hwIn(y) : -cockpitHx(y)),
            leutDeckZ, deck, { ny: 6, nx: 2 });
    }
    grid(soup, LEUT_Y_STERN + 0.03, COCKPIT.y0, (y) => -hwIn(y), hwIn, leutDeckZ, deck, { ny: 8, nx: 10, planks: 'Deck2' });

    // cargo well: floor, walls, coaming
    const w = WELL;
    grid(soup, w.y0, w.y1, () => -w.hx, () => w.hx, () => w.floor, wood, { ny: 6, nx: 6 });
    for (const side of [-1, 1]) {
        const x = side * w.hx;
        quad(soup, [[x, w.y0, w.floor], [x, w.y1, w.floor],
            [x, w.y1, leutDeckZ(w.y1, x) + 0.01], [x, w.y0, leutDeckZ(w.y0, x) + 0.01]], wood);
    }
    for (const y of [w.y0, w.y1]) {
        quad(soup, [[-w.hx, y, w.floor], [w.hx, y, w.floor],
            [w.hx, y, leutDeckZ(y, w.hx) + 0.01], [-w.hx, y, leutDeckZ(y, -w.hx) + 0.01]], wood);
    }
    const cz = leutDeckZ(0.5, 0.84) + 0.07;
    for (const side of [-1, 1]) {
        box(soup, [0.08, w.y1 - w.y0 + 0.16, 0.16], [side * (w.hx + 0.04), (w.y0 + w.y1) / 2, cz], 'Wood');
    }
    for (const y of [w.y0 - 0.04, w.y1 + 0.04]) box(soup, [w.hx * 2 + 0.16, 0.08, 0.16], [0, y, cz], 'Wood');

    // aft cockpit: floor and walls following the narrowing hull
    const c = COCKPIT;
    grid(soup, c.y0, c.y1, (y) => -cockpitHx(y), cockpitHx, () => c.floor, wood, { ny: 6, nx: 4 });
    for (const side of [-1, 1]) {
        const pts = [];
        for (let i = 0; i <= 6; i += 1) {
            const y = lerp(c.y0, c.y1, i / 6);
            const x = side * cockpitHx(y);
            pts.push([[x, y, c.floor], [x, y, leutDeckZ(y, x) + 0.01]]);
        }
        loft(soup, pts, [wood], { smooth: false, closed: false });
    }
    for (const y of [c.y0, c.y1]) {
        const x = cockpitHx(y);
        quad(soup, [[-x, y, c.floor], [x, y, c.floor], [x, y, leutDeckZ(y, x) + 0.01], [-x, y, leutDeckZ(y, -x) + 0.01]], wood);
    }
    box(soup, [0.70, 0.55, 0.42], [0, c.y0 + 0.33, c.floor + 0.21], wood);
    for (const side of [-1, 1]) {
        box(soup, [0.26, 0.62, 0.05], [side * 0.40, -2.72, c.floor + 0.40], wood);
        for (const y of [-2.98, -2.46]) box(soup, [0.04, 0.04, 0.38], [side * 0.40, y, c.floor + 0.19], wood);
    }
}

// ------------------------------------------------------------------ wheelhouse
function buildWheelhouse(soup) {
    const h = HOUSE;
    const z0 = leutDeckZ(-1.3, 0) - 0.02;
    const z1 = z0 + h.h;
    const wallTop = z1 + 0.04;          // buried in the roof slab
    const white = 'CabinWhite';
    const wood = 'Wood';
    const glass = 'Glass';
    const hx = h.hx;
    const sill = z0 + 0.80;
    const top = z0 + 1.42;

    const frontPos = (u, v) => [u, h.y1 + h.rake * (v - z0) / (z1 - z0), v];

    // Outer + inner skins of a wall minus its openings, plus glass panes and
    // wooden frames that straddle each opening (covering the reveal).
    const wallWithWindows = (pos, nrm, u0, u1, v0, v1, windows, { thick = 0.05, glazed = null } = {}) => {
        const cuts = [...new Set([u0, u1, ...windows.flatMap((w) => [w[0], w[1]])])].sort((a, b) => a - b);
        for (const depth of [0, -thick]) {
            for (let k = 0; k < cuts.length - 1; k += 1) {
                const a = cuts[k];
                const b = cuts[k + 1];
                const win = windows.filter((w) => w[0] <= a + 1e-6 && w[1] >= b - 1e-6);
                const spans = win.length ? [[v0, win[0][2]], [win[0][3], v1]] : [[v0, v1]];
                for (const [va, vb] of spans) {
                    if (vb - va < 1e-4) continue;
                    const pts = [pos(a, va), pos(b, va), pos(b, vb), pos(a, vb)].map((p) => add(p, scale(nrm, depth)));
                    quad(soup, pts, white);
                }
            }
        }
        // Frames run 2 cm proud of both skins so no face shares a plane with a
        // wall; where two windows sit closer than two frame widths, their
        // uprights become one mullion instead of two overlapping bars.
        const fw = 0.045;
        const lip = 0.02;
        const inset = 0.02;
        const bar = (ua, ub, va, vb) => {
            if (ub - ua < 1e-4 || vb - va < 1e-4) return;
            const base = [pos(ua, va), pos(ub, va), pos(ub, vb), pos(ua, vb)].map((p) => add(p, scale(nrm, -thick - inset)));
            prism(soup, base, scale(nrm, thick + inset + 0.025), wood);
        };
        const sorted = windows.map((w, wi) => ({ w, wi })).sort((p, q) => p.w[0] - q.w[0]);
        sorted.forEach(({ w: [a, b, c, d], wi }, k) => {
            if (!glazed || glazed[wi]) {
                const pane = [pos(a, c), pos(b, c), pos(b, d), pos(a, d)].map((p) => add(p, scale(nrm, -thick * 0.4)));
                quad(soup, pane, glass);
            }
            const prev = sorted[k - 1]?.w;
            const next = sorted[k + 1]?.w;
            const mergedLeft = prev && a - prev[1] < 2 * fw;
            const mergedRight = next && next[0] - b < 2 * fw;
            const vLo = Math.min(c, prev?.[2] ?? c, next?.[2] ?? c) - fw;
            const vHi = Math.max(d, prev?.[3] ?? d, next?.[3] ?? d) + fw;
            if (!mergedLeft) bar(a - fw, a + lip, c - fw, d + fw);
            if (mergedRight) bar(b - lip, next[0] + lip, vLo, vHi);        // shared mullion
            else bar(b - lip, b + fw, c - fw, d + fw);
            bar(a + lip, b - lip, c - fw, c + lip);
            bar(a + lip, b - lip, d - lip, d + fw);
        });
    };

    const frontWindows = [[-0.80, -0.30, sill, top], [-0.24, 0.24, sill, top], [0.30, 0.80, sill, top]];
    wallWithWindows(frontPos, [0, 1, 0], -hx, hx, z0, wallTop, frontWindows);
    const sideWindows = [[-2.05, -1.35, sill + 0.04, top - 0.02], [-1.20, -0.50, sill + 0.04, top - 0.02]];
    for (const side of [-1, 1]) {
        wallWithWindows((u, v) => [side * hx, u, v], [side, 0, 0], h.y0, h.y1, z0, wallTop, sideWindows);
    }
    // aft wall: small port window, starboard doorway (an opening without glass)
    const door = [0.20, 0.76, z0, z0 + 1.42];
    wallWithWindows((u, v) => [u, h.y0, v], [0, -1, 0], -hx, hx, z0, wallTop,
        [[-0.75, -0.25, sill + 0.04, top - 0.02], door], { glazed: [true, false] });
    // door swung open aft, with its window and handle
    const dw = door[1] - door[0];
    const swing = -70 * DEG;
    const doorAt = [door[0] + dw * 0.5 * Math.cos(swing), h.y0 - 0.03 + dw * 0.5 * Math.sin(swing), (door[2] + door[3]) / 2];
    const doorFrame = (p) => add(eulerXYZ(0, 0, swing)(p), doorAt);
    box(soup, [dw, 0.04, door[3] - door[2] - 0.02], [0, 0, 0], wood, { transform: doorFrame });
    box(soup, [0.30, 0.02, 0.40], [0, -0.02, 0.35], glass, { transform: doorFrame });
    box(soup, [0.03, 0.06, 0.12], [dw * 0.5 - 0.08, -0.05, -0.05], 'Brass', { transform: doorFrame });

    // cambered roof with an overhang, two skins and edge strips
    const ry0 = h.y0 - 0.10;
    const ry1 = h.y1 + h.rake + 0.10;
    const rx = hx + 0.10;
    const roofZ = (y, x) => z1 + 0.06 * (1 - (x / rx) ** 2);
    grid(soup, ry0, ry1, () => -rx, () => rx, (y, x) => roofZ(y, x) + 0.06, 'Roof', { ny: 2, nx: 10 });
    grid(soup, ry0, ry1, () => -rx, () => rx, roofZ, white, { ny: 2, nx: 10 });
    for (const side of [-1, 1]) {
        const x = side * rx;
        loft(soup, [ry0, ry1].map((y) => [[x, y, roofZ(y, x)], [x, y, roofZ(y, x) + 0.06]]), ['Roof'], { smooth: false, closed: false });
    }
    for (const y of [ry0, ry1]) {
        const pts = [];
        for (let i = 0; i <= 10; i += 1) {
            const x = lerp(-rx, rx, i / 10);
            pts.push([[x, y, roofZ(y, x)], [x, y, roofZ(y, x) + 0.06]]);
        }
        loft(soup, pts, ['Roof'], { smooth: false, closed: false });
    }
    // a low wooden rail around the roof edge
    const railZ = z1 + 0.06 + 0.12;
    for (const side of [-1, 1]) {
        rod(soup, [side * (rx - 0.04), ry0 + 0.05, railZ], [side * (rx - 0.04), ry1 - 0.05, railZ], 0.014, wood);
        for (const y of [ry0 + 0.08, (ry0 + ry1) / 2, ry1 - 0.08]) {
            rod(soup, [side * (rx - 0.04), y, z1 + 0.06], [side * (rx - 0.04), y, railZ], 0.012, wood);
        }
    }
    rod(soup, [-(rx - 0.04), ry0 + 0.05, railZ], [rx - 0.04, ry0 + 0.05, railZ], 0.014, wood);

    // roof gear: searchlight, horn, stern lamp on a short pole
    cylinder(soup, 0.11, 0.13, 0.26, [0.42, ry1 - 0.55, z1 + 0.06 + 0.24], 'Y', 'Brass', { n: 16 });
    cylinder(soup, 0.11, 0.11, 0.02, [0.42, ry1 - 0.55 + 0.14, z1 + 0.06 + 0.24], 'Y', 'LampWhite', { n: 16 });
    rod(soup, [0.42, ry1 - 0.55, z1 + 0.06], [0.42, ry1 - 0.55, z1 + 0.06 + 0.16], 0.02, 'Iron');
    cylinder(soup, 0.025, 0.07, 0.30, [-0.42, ry1 - 0.5, z1 + 0.06 + 0.14], 'Y', 'Brass', { n: 12 });
    rod(soup, [-0.42, ry1 - 0.6, z1 + 0.06], [-0.42, ry1 - 0.6, z1 + 0.06 + 0.12], 0.015, 'Iron');
    rod(soup, [0, ry0 + 0.35, z1 + 0.06], [0, ry0 + 0.35, z1 + 0.06 + 0.55], 0.018, 'Iron');
    cylinder(soup, 0.05, 0.05, 0.12, [0, ry0 + 0.35, z1 + 0.06 + 0.60], 'Z', 'LampWhite', { n: 12 });
    // side lamps in dark housings on the wheelhouse sides near the front
    for (const [side, lamp] of [[-1, 'LampRed'], [1, 'LampGreen']]) {
        const hz = z0 + 1.30;
        box(soup, [0.10, 0.16, 0.16], [side * (hx + 0.06), h.y1 - 0.30, hz], 'Iron');
        cylinder(soup, 0.045, 0.045, 0.11, [side * (hx + 0.10), h.y1 - 0.30, hz], 'Z', lamp, { n: 12 });
    }
    // life ring on the aft wall, port side
    torus(soup, [-0.52, h.y0 - 0.075, z0 + 1.12], 0.30, 0.07, ['Orange', 'CabinWhite'],
        { rot: [90 * DEG, 0, 0], faceMaterialFn: (s) => (Math.floor(s / 6) % 2 === 0 ? 0 : 1) });

    // interior: helm console, wheel, compass, bench, an overhead lamp
    const cz = z0 + 0.95;
    box(soup, [0.96, 0.34, 0.26], [0, h.y1 - 0.30, cz], wood);
    box(soup, [1.00, 0.40, 0.03], [0, h.y1 - 0.30, cz + 0.145], 'Wood');
    cylinder(soup, 0.07, 0.08, 0.10, [0.30, h.y1 - 0.30, cz + 0.21], 'Z', 'Brass', { n: 14 });
    const wheelAt = [0, h.y1 - 0.55, cz + 0.32];
    const wheelRot = eulerXYZ(70 * DEG, 0, 0);
    torus(soup, wheelAt, 0.27, 0.022, [wood], { nMajor: 28, nMinor: 8, rot: [70 * DEG, 0, 0] });
    cylinder(soup, 0.05, 0.05, 0.06, [0, 0, 0], 'Z', 'Brass', { n: 12 });
    for (let k = 0; k < 8; k += 1) {
        const a = 2 * Math.PI * k / 8;
        rod(soup, wheelAt, add(wheelRot([0.36 * Math.cos(a), 0.36 * Math.sin(a), 0]), wheelAt), 0.012, wood);
    }
    rod(soup, wheelAt, [0, h.y1 - 0.38, cz + 0.26], 0.02, 'Iron');
    box(soup, [0.36, 0.95, 0.05], [-(hx - 0.22), h.y0 + 0.65, z0 + 0.42], wood);
    box(soup, [0.03, 0.95, 0.40], [-(hx - 0.40), h.y0 + 0.65, z0 + 0.21], wood);
    cylinder(soup, 0.06, 0.06, 0.05, [0, h.y0 + 0.9, z1 - 0.04], 'Z', 'CabinGlow', { n: 10 });
}

// ------------------------------------------------------------------ fittings
function buildFittings(soup) {
    const wood = 'Wood';
    const iron = 'Iron';
    const rope = 'Rope';
    // mast on the foredeck with crosstree, masthead lamp, forestay and shrouds
    const my = 1.75;
    const mz0 = leutDeckZ(my, 0) - 0.02;
    cylinder(soup, 0.065, 0.038, 3.9, [0, my, mz0 + 1.95], 'Z', wood, { n: 12 });
    box(soup, [0.30, 0.30, 0.16], [0, my, mz0 + 0.08], wood);
    box(soup, [0.9, 0.05, 0.05], [0, my, mz0 + 3.1], wood);
    cylinder(soup, 0.045, 0.045, 0.10, [0, my + 0.07, mz0 + 2.9], 'Z', 'LampWhite', { n: 10 });
    rod(soup, [0, my, mz0 + 3.8], [0, LEUT_Y_STEM - 0.25, leutSheerZ(LEUT_Y_STEM - 0.25) + BULWARK + 0.05], 0.006, iron, { n: 4 });
    for (const side of [-1, 1]) {
        rod(soup, [0, my, mz0 + 3.1], [side * (leutHalfBeam(my) - 0.10), my - 0.05, leutSheerZ(my) + BULWARK], 0.006, iron, { n: 4 });
        box(soup, [0.03, 0.08, 0.10], [side * (leutHalfBeam(my) - 0.10), my - 0.05, leutSheerZ(my) + BULWARK - 0.02], iron);
    }
    triangle(soup, [[0, my, mz0 + 3.88], [0, my - 0.42, mz0 + 3.78], [0, my, mz0 + 3.68]], 'Orange');

    // samson post at the bow, bollards at the quarters, cleats
    const spY = LEUT_Y_STEM - 0.85;
    box(soup, [0.14, 0.14, 0.62], [0, spY, leutDeckZ(spY, 0) + 0.29], wood);
    rod(soup, [-0.16, spY, leutDeckZ(spY, 0) + 0.46], [0.16, spY, leutDeckZ(spY, 0) + 0.46], 0.018, iron);
    for (const side of [-1, 1]) {
        for (const y of [-3.55, 2.95]) {
            const x = side * (hwIn(y) - 0.16);
            const z = leutDeckZ(y, x);
            cylinder(soup, 0.045, 0.04, 0.28, [x, y, z + 0.14], 'Z', iron, { n: 12 });
            cylinder(soup, 0.07, 0.05, 0.05, [x, y, z + 0.30], 'Z', iron, { n: 12 });
        }
        for (const y of [-1.6, 0.5]) {
            const x = side * (hwIn(y) - 0.14);
            const z = leutDeckZ(y, x);
            box(soup, [0.06, 0.24, 0.05], [x, y, z + 0.09], iron);
            box(soup, [0.05, 0.06, 0.07], [x, y, z + 0.035], iron);
        }
    }

    // foredeck hatch, coiled ropes, an anchor lashed on the starboard side
    const hy0 = 2.35;
    const hy1 = 2.95;
    const hz = leutDeckZ(2.65, 0);
    box(soup, [0.84, hy1 - hy0, 0.16], [0, (hy0 + hy1) / 2, hz + 0.08], wood);
    box(soup, [0.92, hy1 - hy0 + 0.08, 0.05], [0, (hy0 + hy1) / 2, hz + 0.185], 'WoodPale');
    torus(soup, [-0.70, 2.0, leutDeckZ(2.0, -0.7) + 0.045], 0.17, 0.045, [rope], { nMajor: 20, nMinor: 8 });
    torus(soup, [-0.70, 2.0, leutDeckZ(2.0, -0.7) + 0.13], 0.15, 0.04, [rope], { nMajor: 20, nMinor: 8 });
    torus(soup, [0.55, -3.55, leutDeckZ(-3.55, 0.55) + 0.045], 0.16, 0.045, [rope], { nMajor: 20, nMinor: 8 });
    const ax = 0.62;
    const ay = 2.45;
    const az = leutDeckZ(2.45, 0.62) + 0.06;
    rod(soup, [ax, ay - 0.45, az], [ax, ay + 0.45, az], 0.024, iron);
    torus(soup, [ax, ay + 0.52, az], 0.07, 0.014, [iron], { nMajor: 14, nMinor: 6, rot: [0, 90 * DEG, 0] });
    rod(soup, [ax - 0.36, ay + 0.35, az], [ax + 0.36, ay + 0.35, az], 0.018, iron);
    for (const s of [-1, 1]) {
        rod(soup, [ax, ay - 0.45, az], [ax + s * 0.02, ay - 0.15, az + 0.34], 0.02, iron);
        triangle(soup, [[ax + s * 0.02, ay - 0.15, az + 0.34], [ax + s * 0.02, ay - 0.27, az + 0.30],
            [ax + s * 0.13, ay - 0.06, az + 0.22]], iron);
    }
    rod(soup, [ax, ay + 0.52, az], [0.08, spY, leutDeckZ(spY, 0) + 0.40], 0.014, rope, { n: 6 });

    // tyre fenders hung over the rail on ropes
    for (const side of [-1, 1]) {
        for (const y of [-2.55, -0.55, 1.45]) {
            const hw = leutHalfBeam(y);
            const zs = leutSheerZ(y);
            const cx = side * (hw + 0.13);
            const cz = zs - 0.22;
            torus(soup, [cx, y, cz], 0.25, 0.085, ['Rubber'], { nMajor: 22, nMinor: 10, rot: [0, 90 * DEG, 0] });
            rod(soup, [cx, y, cz + 0.30], [side * (hw + 0.03), y, zs + BULWARK + 0.04], 0.012, rope, { n: 6 });
        }
    }

    // cargo: crates in the well, two under a lashed tarpaulin, jerrycans aft
    const fl = WELL.floor;
    box(soup, [0.62, 0.52, 0.48], [-0.42, 0.85, fl + 0.24], 'Crate');
    box(soup, [0.50, 0.50, 0.40], [0.38, 0.85, fl + 0.20], 'Crate');
    box(soup, [0.45, 0.60, 0.36], [0.40, 0.20, fl + 0.18], 'Crate');
    for (const x of [-0.55, -0.15, -0.42]) box(soup, [0.03, 0.54, 0.50], [x, 0.85, fl + 0.24], 'Wood');
    softBox(soup, [1.55, 0.95, 0.50], [-0.05, 0.10, fl + 0.30], 'Canvas');
    for (const s of [-1, 1]) rod(soup, [s * 0.80, -0.15, fl + 0.55], [s * 0.80, 0.35, fl + 0.55], 0.008, rope, { n: 5 });
    for (const y of [-2.62, -2.88]) box(soup, [0.18, 0.34, 0.46], [-0.44, y, COCKPIT.floor + 0.23], iron);

    // exhaust stub on the starboard quarter, stern light on the aft rail
    const ey = -3.15;
    const ez = 0.40;
    rod(soup, [leutSurfaceX(ey, ez) - 0.02, ey, ez], [leutSurfaceX(ey, ez) + 0.10, ey - 0.02, ez], 0.04, iron, { n: 10 });
    rod(soup, [0, -3.75, leutSheerZ(-3.75) + BULWARK], [0, -3.75, leutSheerZ(-3.75) + BULWARK + 0.4], 0.015, iron);
    cylinder(soup, 0.04, 0.04, 0.09, [0, -3.75, leutSheerZ(-3.75) + BULWARK + 0.44], 'Z', 'LampWhite', { n: 10 });
}

// ------------------------------------------------------------------ underwater
function buildUnderwater(soup) {
    const iron = 'Iron';
    const brass = 'Brass';
    prism(soup, [[-0.025, -3.84, -0.74], [-0.025, -4.24, -0.74], [-0.025, -4.34, -0.06], [-0.025, -3.94, -0.06]],
        [0.05, 0, 0], 'Antifouling');
    for (const z of [-0.62, -0.18]) cylinder(soup, 0.035, 0.035, 0.16, [0, -3.90 + (z + 0.62) * -0.12, z], 'X', iron, { n: 8 });
    rod(soup, [0, -4.05, -0.06], [0, -3.95, leutSheerZ(-3.95) - 0.05], 0.03, iron);
    const sz = -0.70;
    rod(soup, [0, -2.55, sz], [0, -3.72, sz], 0.025, iron);
    rod(soup, [0, -3.45, leutKeelZ(-3.45) + 0.02], [0, -3.45, sz], 0.02, iron);
    cylinder(soup, 0.055, 0.04, 0.16, [0, -3.72, sz], 'Y', brass, { n: 12 });
    for (let k = 0; k < 3; k += 1) {
        const rotate = eulerXYZ(35 * DEG, 2 * Math.PI * k / 3, 0);
        const blade = [[0.04, 0, 0], [0.24, -0.05, 0.05], [0.26, 0.0, 0.12], [0.20, 0.06, 0.16], [0.06, 0.03, 0.06]]
            .map((p) => add(rotate(p), [0, -3.72, sz]));
        soup.add(blade, [[0, 1, 2, 3, 4]], [brass], { smooth: true });
    }
}

// ------------------------------------------------------------------ lettering
// A small stroke alphabet for painted names: polylines in a unit cell.
const GLYPHS = {
    S: [[[1, 1], [0, 1], [0, 0.5], [1, 0.5], [1, 0], [0, 0]]],
    V: [[[0, 1], [0.5, 0], [1, 1]]],
    '.': [[[0.35, 0], [0.65, 0]]],
    N: [[[0, 0], [0, 1], [1, 0], [1, 1]]],
    I: [[[0.5, 0], [0.5, 1]]],
    K: [[[0, 0], [0, 1]], [[1, 1], [0, 0.45]], [[0.3, 0.6], [1, 0]]],
    O: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]],
    L: [[[0, 1], [0, 0], [1, 0]]],
    A: [[[0, 0], [0.5, 1], [1, 0]], [[0.2, 0.4], [0.8, 0.4]]],
    E: [[[1, 1], [0, 1], [0, 0], [1, 0]], [[0, 0.5], [0.8, 0.5]]],
    R: [[[0, 0], [0, 1], [1, 1], [1, 0.5], [0, 0.5]], [[0.4, 0.5], [1, 0]]],
    T: [[[0, 1], [1, 1]], [[0.5, 1], [0.5, 0]]],
    M: [[[0, 0], [0, 1], [0.5, 0.45], [1, 1], [1, 0]]],
    J: [[[1, 1], [1, 0], [0.5, 0], [0, 0.15]]],
    D: [[[0, 0], [0, 1], [0.7, 1], [1, 0.75], [1, 0.25], [0.7, 0], [0, 0]]],
    C: [[[1, 1], [0, 1], [0, 0], [1, 0]]],
    U: [[[0, 1], [0, 0], [1, 0], [1, 1]]],
    Z: [[[0, 1], [1, 1], [0, 0], [1, 0]]],
    G: [[[1, 1], [0, 1], [0, 0], [1, 0], [1, 0.45], [0.55, 0.45]]],
    P: [[[0, 0], [0, 1], [1, 1], [1, 0.5], [0, 0.5]]],
    B: [[[0, 0], [0, 1], [0.9, 1], [0.9, 0.5], [0, 0.5]], [[0.9, 0.5], [1, 0.25], [0.9, 0], [0, 0]]],
    H: [[[0, 0], [0, 1]], [[1, 0], [1, 1]], [[0, 0.5], [1, 0.5]]],
    Š: [[[1, 1], [0, 1], [0, 0.5], [1, 0.5], [1, 0], [0, 0]], [[0.25, 1.35], [0.5, 1.15], [0.75, 1.35]]],
    Ž: [[[0, 1], [1, 1], [0, 0], [1, 0]], [[0.25, 1.35], [0.5, 1.15], [0.75, 1.35]]],
    Č: [[[1, 1], [0, 1], [0, 0], [1, 0]], [[0.25, 1.35], [0.5, 1.15], [0.75, 1.35]]],
    Ć: [[[1, 1], [0, 1], [0, 0], [1, 0]], [[0.4, 1.15], [0.7, 1.4]]],
    0: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]],
    1: [[[0.2, 0.8], [0.5, 1], [0.5, 0]]],
    2: [[[0, 1], [1, 1], [1, 0.5], [0, 0.5], [0, 0], [1, 0]]],
    3: [[[0, 1], [1, 1], [1, 0], [0, 0]], [[0.2, 0.5], [1, 0.5]]],
    4: [[[0, 1], [0, 0.5], [1, 0.5]], [[1, 1], [1, 0]]],
    5: [[[1, 1], [0, 1], [0, 0.5], [1, 0.5], [1, 0], [0, 0]]],
    6: [[[1, 1], [0, 1], [0, 0], [1, 0], [1, 0.5], [0, 0.5]]],
    7: [[[0, 1], [1, 1], [0.4, 0]]],
    8: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]], [[0, 0.5], [1, 0.5]]],
    9: [[[1, 0.5], [0, 0.5], [0, 1], [1, 1], [1, 0], [0, 0]]],
};
const NARROW = new Set(['.', 'I', '1']);

// Frame placing text flat on the hull skin at station y / height z, reading
// stern→bow on starboard and bow→stern on port, offset a little outward.
function hullFrame(y, z, side) {
    const x = leutSurfaceX(y, z) * side;
    const dxDy = (leutSurfaceX(y + 0.05, z) - leutSurfaceX(y - 0.05, z)) / 0.1 * side;
    const dxDz = (leutSurfaceX(y, z + 0.05) - leutSurfaceX(y, z - 0.05)) / 0.1 * side;
    const ty = norm([dxDy, 1, 0]);
    const tz = norm([dxDz, 0, 1]);
    let nrm = norm(cross(ty, tz));
    if (nrm[0] * side < 0) nrm = scale(nrm, -1);
    const ex = scale(ty, side);
    const ez = nrm;
    const ey = norm(cross(ez, ex));
    const origin = add([x, y, z], scale(nrm, 0.02));
    return { origin, ex, ey, ez };
}

// Paint a line of text along the hull at height z, centred on station y.
// Each glyph gets its own frame so the letters follow the bow's curve.
function paintText(soup, text, y, z, capHeight, side, material) {
    const cell = capHeight * 0.75;
    const advance = (ch) => (NARROW.has(ch) ? 0.6 : 1.15) * cell;
    const total = [...text].reduce((sum, ch) => sum + advance(ch), 0);
    let cursor = -total / 2;
    const thick = capHeight * 0.16;
    for (const ch of text) {
        const width = advance(ch);
        const strokes = GLYPHS[ch];
        if (strokes) {
            const centre = cursor + width / 2;
            const frame = hullFrame(y + centre, z, side);
            const place = (u, v) => add(frame.origin, add(scale(frame.ex, u), scale(frame.ey, v)));
            const glyphW = NARROW.has(ch) ? cell * 0.5 : cell;
            for (const line of strokes) {
                for (let i = 0; i < line.length - 1; i += 1) {
                    const a = [(line[i][0] - 0.5) * glyphW, (line[i][1] - 0.5) * capHeight];
                    const b = [(line[i + 1][0] - 0.5) * glyphW, (line[i + 1][1] - 0.5) * capHeight];
                    const d = [b[0] - a[0], b[1] - a[1]];
                    const l = Math.hypot(d[0], d[1]) || 1;
                    const p = [-d[1] / l * thick / 2, d[0] / l * thick / 2];
                    const e = [d[0] / l * thick / 2, d[1] / l * thick / 2];     // square the stroke ends
                    const corners = [
                        place(a[0] - e[0] + p[0], a[1] - e[1] + p[1]),
                        place(a[0] - e[0] - p[0], a[1] - e[1] - p[1]),
                        place(b[0] + e[0] - p[0], b[1] + e[1] - p[1]),
                        place(b[0] + e[0] + p[0], b[1] + e[1] + p[1]),
                    ];
                    prism(soup, corners, scale(frame.ez, 0.012), material);
                }
            }
        }
        cursor += width;
    }
}

// ------------------------------------------------------------------ output
// Blender frame (X starboard, Y bow, Z up) → model frame (+Z nose, +Y up, +X port).
function toModelFrame(arr) {
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i += 3) {
        out[i] = -arr[i];
        out[i + 1] = arr[i + 2];
        out[i + 2] = arr[i + 1];
    }
    return out;
}

// Hull paint schemes. Blue is the leut the player sails; another scheme
// recolours only the painted topsides and their faint night emissive, never
// the wood, the white or the antifouling.
export const LEUT_LIVERIES = Object.freeze({
    blue: Object.freeze({ colors: Object.freeze({}), hullEmissive: 0x0d4160 }),
    'red-brown': Object.freeze({
        colors: Object.freeze({
            HullBlue: Object.freeze([0.17, 0.05, 0.03]),
            HullBlue2: Object.freeze([0.155, 0.045, 0.027]),
        }),
        hullEmissive: 0x2e120b,
    }),
});

export function buildLeutGeometryData({ name = 'SV. NIKOLA', registration = 'VS 118', livery = 'blue' } = {}) {
    const scheme = LEUT_LIVERIES[livery];
    if (!scheme) throw new Error(`leut geometry: unknown livery ${livery}`);
    const soup = new Soup();
    buildHull(soup);
    buildDecks(soup);
    buildWheelhouse(soup);
    buildFittings(soup);
    buildUnderwater(soup);
    for (const side of [-1, 1]) {
        if (name) paintText(soup, name, 2.35, 0.47, 0.14, side, 'Lettering');
        if (registration) paintText(soup, registration, 2.35, 0.27, 0.10, side, 'Lettering');
    }
    const groups = [];
    for (const g of soup.groups.values()) {
        const material = LEUT_MATERIALS[g.material];
        if (!material) throw new Error(`leut geometry: unknown material ${g.material}`);
        groups.push({
            material: g.material,
            family: material.family,
            color: scheme.colors[g.material] || material.color,
            positions: toModelFrame(g.positions),
            normals: toModelFrame(g.normals),
        });
    }
    return { groups, dimensions: LEUT_HULL_DIMENSIONS };
}
