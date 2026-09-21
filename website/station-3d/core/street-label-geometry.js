// Bounded work inside a street label, not merely one whole label per frame.
// Rasterisation remains in the world layer so the browser's font/diacritics
// stay authoritative; these stages are DOM-free and preserve its geometry.
import * as THREE from 'three';
import { createGeometryBatcher } from './geometry-batch.js';

export function* traceRasterLoops(inside, width, height, {
    pixelsPerStep = 8192,
    edgesPerStep = 2048,
} = {}) {
    const pixelLimit = Math.max(1, Math.floor(pixelsPerStep));
    const edgeLimit = Math.max(1, Math.floor(edgesPerStep));
    const at = (x, y) => (x < 0 || y < 0 || x >= width || y >= height
        ? false : inside[y * width + x]);
    const edges = new Map();
    const pushEdge = (ax, ay, bx, by) => {
        const key = `${ax},${ay}`;
        const list = edges.get(key);
        if (list) list.push([bx, by]);
        else edges.set(key, [[bx, by]]);
    };
    let pixels = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (at(x, y)) {
                if (!at(x, y - 1)) pushEdge(x, y, x + 1, y);
                if (!at(x + 1, y)) pushEdge(x + 1, y, x + 1, y + 1);
                if (!at(x, y + 1)) pushEdge(x + 1, y + 1, x, y + 1);
                if (!at(x - 1, y)) pushEdge(x, y + 1, x, y);
            }
            if (++pixels >= pixelLimit) {
                yield { phase: 'contour-pixels', pixels };
                pixels = 0;
            }
        }
    }
    if (pixels) yield { phase: 'contour-pixels', pixels };

    const loops = [];
    let walked = 0;
    while (edges.size > 0) {
        const startKey = edges.keys().next().value;
        const [sx, sy] = startKey.split(',').map(Number);
        const loop = [[sx, sy]];
        let cx = sx;
        let cy = sy;
        for (let guard = 0; guard < 1e6; guard++) {
            const key = `${cx},${cy}`;
            const list = edges.get(key);
            if (!list || list.length === 0) break;
            const [nx, ny] = list.pop();
            if (list.length === 0) edges.delete(key);
            if (++walked >= edgeLimit) {
                yield { phase: 'contour-edges', edges: walked };
                walked = 0;
            }
            if (nx === sx && ny === sy) break;
            loop.push([nx, ny]);
            cx = nx;
            cy = ny;
        }
        if (loop.length >= 4) loops.push(loop);
    }
    if (walked) yield { phase: 'contour-edges', edges: walked };
    return loops;
}

export function* extrudeLabelShapesSteps(shapes, options) {
    if (!shapes?.length) return null;
    const batcher = createGeometryBatcher();
    for (let index = 0; index < shapes.length; index++) {
        // Each outline is one raster glyph component, with its holes. Never
        // give ExtrudeGeometry every letter of a long street name at once.
        const part = new THREE.ExtrudeGeometry(shapes[index], options);
        try {
            batcher.addPart('label', index, {
                attributes: {
                    position: part.attributes.position.array,
                    normal: part.attributes.normal.array,
                    uv: part.attributes.uv.array,
                },
            });
        } finally {
            // dispose releases GPU state, not the arrays retained for assembly.
            part.dispose();
        }
        yield { phase: 'extrude-glyph', glyphs: 1 };
    }
    const assembly = batcher.beginAssembly('label', { includeBounds: true });
    while (!assembly.step(2)) yield { phase: `assemble-${assembly.lastPhase()}` };
    const data = assembly.result();
    if (!data?.bounds) return null;
    yield { phase: 'assemble' };
    const b = data.bounds;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    const position = data.attributes.position;
    const bounds = new THREE.Box3();
    let radiusSq = 0;
    for (let start = 0; start < position.length; start += 6144) {
        const end = Math.min(position.length, start + 6144);
        for (let i = start; i < end; i += 3) {
            // Float32 writes match BufferGeometry.center().
            position[i] -= cx;
            position[i + 1] -= cy;
            position[i + 2] -= cz;
            const x = position[i], y = position[i + 1], z = position[i + 2];
            bounds.min.x = Math.min(bounds.min.x, x);
            bounds.min.y = Math.min(bounds.min.y, y);
            bounds.min.z = Math.min(bounds.min.z, z);
            bounds.max.x = Math.max(bounds.max.x, x);
            bounds.max.y = Math.max(bounds.max.y, y);
            bounds.max.z = Math.max(bounds.max.z, z);
            radiusSq = Math.max(radiusSq, x * x + y * y + z * z);
        }
        yield { phase: 'center', vertices: (end - start) / 3 };
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.attributes.normal, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(data.attributes.uv, 2));
    geometry.boundingBox = bounds;
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Math.sqrt(radiusSq));
    return geometry;
}
