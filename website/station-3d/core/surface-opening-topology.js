// Subtract bounded convex opening volumes from actual receiver triangles.
// Unlike an XZ height field, this also preserves vertical tunnel walls and
// ceilings. The returned barycentric weights let the renderer interpolate
// every vertex attribute; physics consumes the same resulting positions.
import { orient2d } from 'robust-predicates';
import { createBoundsGridSteps } from './bounds-grid.js';
import { triangulateReceiverPolygonsSteps } from './terrain-cutout-topology.js';
import { captureOpeningLowerPlane, openingLowerPlaneHeight } from './surface-opening-plane.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const same = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;
const before = (a, b) => a.x < b.x || a.x === b.x && (a.y < b.y || a.y === b.y && a.z < b.z);
const normal = (a, b, c) => [
    (b.y-a.y)*(c.z-a.z)-(b.z-a.z)*(c.y-a.y),
    (b.z-a.z)*(c.x-a.x)-(b.x-a.x)*(c.z-a.z),
    (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x),
];
const hasArea = polygon => polygon.length >= 3 && polygon.slice(2).some((p, i) =>
    normal(polygon[0], polygon[i+1], p).some(value => value !== 0));
const push = (polygon, point) => { if (!polygon.length || !same(polygon.at(-1), point)) polygon.push(point); };
const close = polygon => { if (polygon.length > 1 && same(polygon[0], polygon.at(-1))) polygon.pop(); return polygon; };

// Canonical edge direction gives adjacent source triangles exactly the same
// intersection coordinates even when their shared edge is oppositely wound.
function intersection(a, b, plane) {
    if (before(b, a)) [a, b] = [b, a];
    const da = plane.distance(a), db = plane.distance(b);
    if (da === 0) return a;
    if (db === 0) return b;
    const t = da / (da - db);
    const point = { x: a.x + (b.x-a.x)*t, y: a.y + (b.y-a.y)*t, z: a.z + (b.z-a.z)*t,
        weights: a.weights.map((value, i) => value + (b.weights[i]-value)*t) };
    if (plane.height !== undefined) point.y = plane.height;
    if (![point.x, point.y, point.z, ...point.weights].every(finite)) {
        fail('ground-opening-coordinate', 'Opening intersection is not finite');
    }
    return point;
}

export function* createSurfaceOpeningTopologySteps({ regions, limits,
    now = () => performance.now(), isCurrent = () => true } = {}) {
    for (const key of ['maxRegions', 'maxSourceVertices', 'maxCandidates', 'maxFragments']) {
        if (!Number.isSafeInteger(limits?.[key]) || limits[key] < 1) {
            throw new TypeError(`Surface openings require an explicit ${key} limit`);
        }
    }
    if (!Array.isArray(regions) || regions.length > limits.maxRegions) {
        fail('ground-opening-capacity', 'Complete opening set exceeds its region capacity');
    }
    let deadline = now() + .5, vertices = 0;
    const check = () => { if (!isCurrent()) fail('ground-opening-stale', 'Opening inputs were superseded'); };
    function* budget(phase) {
        check();
        if (now() >= deadline) { yield { phase }; check(); deadline = now() + .5; }
    }
    const captured = [], publicRegions = [];
    const maskValue = value => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;
    for (const region of regions) {
        yield* budget('ground-opening-capture');
        const minY = region?.minY ?? null, maxY = region?.maxY ?? null;
        const minPlane = captureOpeningLowerPlane(region?.minPlane);
        const maxYExclusive = region?.maxYExclusive ?? false;
        const targetMask = region?.targetMask ?? 1, replacementKey = region?.replacementKey ?? null;
        if (!Array.isArray(region?.ring) || region.ring.length < 3
            || minY !== null && !finite(minY) || maxY !== null && !finite(maxY)
            || minY !== null && maxY !== null && minY >= maxY || typeof maxYExclusive !== 'boolean'
            || !maskValue(targetMask) || !targetMask
            || replacementKey !== null && (typeof replacementKey !== 'string' || !replacementKey)) {
            fail('ground-opening-coordinate', 'Opening requires a polygon and ordered height bounds');
        }
        const ring = [];
        for (const point of region.ring) {
            yield* budget('ground-opening-capture');
            if (++vertices > limits.maxSourceVertices) fail('ground-opening-capacity', 'Opening vertex capacity exceeded');
            if (!finite(point?.x) || !finite(point?.z)) fail('ground-opening-coordinate', 'Opening vertex is not finite');
            if (ring.length && point.x === ring.at(-1).x && point.z === ring.at(-1).z) continue;
            ring.push(Object.freeze({ x: point.x, z: point.z }));
        }
        if (ring.length > 1 && ring[0].x === ring.at(-1).x && ring[0].z === ring.at(-1).z) ring.pop();
        let winding = 0;
        // Reject concavity/self intersections instead of silently widening a
        // cut. Callers decompose polygon footprints, retaining their holes.
        for (let i = 0; i < ring.length; i++) for (const point of ring) {
            yield* budget('ground-opening-convexity');
            const a = ring[i], b = ring[(i+1)%ring.length];
            const side = Math.sign(orient2d(a.x, a.z, b.x, b.z, point.x, point.z));
            if (side && winding && side !== winding) fail('ground-opening-shape', 'Opening pieces must be convex');
            if (side) winding = side;
        }
        if (!winding) fail('ground-opening-shape', 'Opening footprint has no area');
        const planes = [], bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
        for (let i = 0; i < ring.length; i++) {
            const a = ring[i], b = ring[(i+1)%ring.length];
            // orient2d has the opposite sign of the conventional XZ cross.
            const nx = (b.z-a.z)*winding, nz = -(b.x-a.x)*winding;
            planes.push({ distance: p => (p.x-a.x)*nx + (p.z-a.z)*nz });
            bounds.minX = Math.min(bounds.minX, a.x); bounds.maxX = Math.max(bounds.maxX, a.x);
            bounds.minZ = Math.min(bounds.minZ, a.z); bounds.maxZ = Math.max(bounds.maxZ, a.z);
        }
        if (minY !== null) planes.push({ height: minY, distance: p => p.y-minY });
        if (minPlane !== null) planes.push({ distance: p => p.y-openingLowerPlaneHeight(minPlane,p.x,p.z) });
        if (maxY !== null) planes.push({ height: maxY, distance: p => maxY-p.y });
        const publicRegion = Object.freeze({ring:Object.freeze(ring),bounds:Object.freeze(bounds),
            minY,maxY,maxYExclusive,targetMask,replacementKey,...(minPlane ? { minPlane } : {})});
        publicRegions.push(publicRegion);
        captured.push({ ...publicRegion, planes });
    }
    const index = yield* createBoundsGridSteps(captured, { now });
    check();
    return Object.freeze({
        contract: 'station3d-surface-opening-topology-v1',
        regions: Object.freeze(publicRegions),
        *intersectsBoundsSteps(bounds, {targetMask = 0xffffffff, excludeReplacementKey = null} = {}) {
            if (!['minX','minY','minZ','maxX','maxY','maxZ'].every(key=>finite(bounds?.[key]))
                || !maskValue(targetMask)) throw new TypeError('Invalid opening bounds query');
            for (const region of index.candidateItemsInBox(bounds.minX,bounds.minZ,bounds.maxX,bounds.maxZ)) {
                yield* budget('ground-opening-receiver-bounds');
                if (!(region.targetMask & targetMask) || excludeReplacementKey !== null && region.replacementKey === excludeReplacementKey) continue;
                const b=region.bounds;
                if (b.minX>bounds.maxX || b.maxX<bounds.minX || b.minZ>bounds.maxZ || b.maxZ<bounds.minZ
                    || region.minY!==null && region.minY>bounds.maxY
                    || region.maxY!==null && (region.maxY<bounds.minY || region.maxYExclusive && region.maxY===bounds.minY)) continue;
                return true;
            }
            return false;
        },
        contains(x, y, z, {targetMask = 0xffffffff, excludeReplacementKey = null} = {}) {
            if (![x,y,z].every(finite) || !maskValue(targetMask)) throw new TypeError('Invalid opening point query');
            const point={x,y,z};
            for (const region of index.candidateItemsAt(x,z)) {
                if (!(region.targetMask & targetMask) || excludeReplacementKey !== null && region.replacementKey === excludeReplacementKey
                    || region.maxYExclusive && region.maxY !== null && y >= region.maxY) continue;
                if (region.planes.every(plane=>plane.distance(point)>=0)) return true;
            }
            return false;
        },
        *clipTriangleSteps(a, b, c, {targetMask = 0xffffffff, excludeReplacementKey = null, removedOnly = false} = {}) {
            check();
            if (!maskValue(targetMask)) throw new TypeError('Invalid opening receiver target');
            const source = [a, b, c];
            if (!source.every(p => [p?.x, p?.y, p?.z].every(finite))) {
                fail('ground-opening-coordinate', 'Receiver triangle has an absent coordinate');
            }
            if (!hasArea(source)) fail('ground-opening-shape', 'Receiver triangle has no area');
            const bounds = { minX: Math.min(a.x,b.x,c.x), maxX: Math.max(a.x,b.x,c.x),
                minZ: Math.min(a.z,b.z,c.z), maxZ: Math.max(a.z,b.z,c.z),
                minY: Math.min(a.y,b.y,c.y), maxY: Math.max(a.y,b.y,c.y) };
            let fragments = [source.map((p, i) => ({ x:p.x, y:p.y, z:p.z,
                weights: [0,1,2].map(j => i === j ? 1 : 0) }))], changed = false, candidates = 0;
            const seen = new Set(), removed = removedOnly ? [] : null;
            for (const region of index.candidateItemsInBox(bounds.minX,bounds.minZ,bounds.maxX,bounds.maxZ)) {
                yield* budget('ground-opening-candidates');
                if (seen.has(region)) continue;
                seen.add(region);
                if (!(region.targetMask & targetMask)
                    || excludeReplacementKey !== null && region.replacementKey === excludeReplacementKey) continue;
                const rb = region.bounds;
                if (rb.minX > bounds.maxX || rb.maxX < bounds.minX || rb.minZ > bounds.maxZ || rb.maxZ < bounds.minZ
                    || region.minY !== null && region.minY > bounds.maxY
                    || region.maxY !== null && (region.maxY < bounds.minY
                        || region.maxYExclusive && region.maxY === bounds.minY)) continue;
                if (++candidates > limits.maxCandidates) fail('ground-opening-capacity', 'Receiver face exceeds its opening capacity');
                const next = [];
                for (const fragment of fragments) {
                    let inside = fragment;
                    const outside = [];
                    for (const plane of region.planes) {
                        yield* budget('ground-opening-clip');
                        const keep = [], cut = [];
                        let previous = inside.at(-1);
                        if (!previous) break;
                        let previousInside = plane.distance(previous) >= 0;
                        for (const point of inside) {
                            yield* budget('ground-opening-edge');
                            const pointInside = plane.distance(point) >= 0;
                            if (pointInside !== previousInside) {
                                const crossing = intersection(previous, point, plane);
                                push(keep, crossing); push(cut, crossing);
                            }
                            push(pointInside ? keep : cut, point);
                            previous = point; previousInside = pointInside;
                        }
                        inside = close(keep);
                        if (hasArea(close(cut))) outside.push(cut);
                        if (outside.length + next.length > limits.maxFragments) fail('ground-opening-capacity', 'Opening fragment capacity exceeded');
                    }
                    if (hasArea(inside)) {
                        changed = true; next.push(...outside);
                        if (removedOnly) {
                            if (removed.length >= limits.maxFragments) fail('ground-opening-capacity', 'Removed opening fragment capacity exceeded');
                            removed.push({ polygon: inside, maxY: region.maxY, maxYExclusive: region.maxYExclusive });
                        }
                    }
                    else next.push(fragment); // Tangency removes no receiver area.
                    if (next.length > limits.maxFragments) fail('ground-opening-capacity', 'Opening fragment capacity exceeded');
                }
                fragments = next;
                if (!fragments.length) break;
            }
            // Derive backed openings from actual floor faces without building
            // or triangulating their unused remainder.
            if (removedOnly) return Object.freeze({ unchanged: !changed, removed });
            if (!changed) return Object.freeze({ unchanged: true, triangles: null });
            const triangles = [];
            if(fragments.length) {
                // Sequential half-plane subtraction leaves internal partition
                // edges with T junctions. Triangulating those pieces separately
                // has correct area but incorrect connectivity. Union them in
                // this face's most stable projection before triangulation.
                const n=normal(a,b,c),drop=n.reduce((best,value,i)=>Math.abs(value)>Math.abs(n[best])?i:best,0);
                const axes=['x','y','z'].filter((_,i)=>i!==drop),origin=axes.map(key=>Math.min(a[key],b[key],c[key]));
                const project=p=>axes.map((key,i)=>p[key]-origin[i]);
                const projected=source.map(project),known=new Map(),unit=2**40;
                const key=p=>`${Math.round(p[0]*unit)},${Math.round(p[1]*unit)}`;
                const polygons=[];
                for(const polygon of fragments) {
                    const ring=[];
                    for(const point of polygon) {
                        yield* budget('ground-opening-face-projection');
                        const p=project(point);ring.push(p);known.set(key(p),point);
                    }
                    polygons.push([ring]);
                }
                const cross2=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
                const denominator=cross2(...projected);
                const restore=p=>{
                    const original=known.get(key(p));if(original)return original;
                    const wa=cross2(p,projected[1],projected[2])/denominator;
                    const wb=cross2(projected[0],p,projected[2])/denominator,weights=[wa,wb,1-wa-wb];
                    return {x:weights.reduce((s,w,i)=>s+w*source[i].x,0),y:weights.reduce((s,w,i)=>s+w*source[i].y,0),
                        z:weights.reduce((s,w,i)=>s+w*source[i].z,0),weights};
                };
                const faces=yield* triangulateReceiverPolygonsSteps({polygons,now,isCurrent,
                    coordinateScale:Math.max(1,...source.flatMap(p=>[Math.abs(p.x),Math.abs(p.y),Math.abs(p.z)])),
                    limits:{maxOperandVertices:limits.maxFragments*4,maxIntersections:limits.maxFragments*4,maxOutputTriangles:limits.maxFragments}});
                for(const face of faces) {
                    yield* budget('ground-opening-triangulate');
                    const triangle=face.map(restore);
                    if(denominator<0)[triangle[1],triangle[2]]=[triangle[2],triangle[1]];
                    triangles.push(triangle);
                }
            }
            check();
            return Object.freeze({ unchanged: false, triangles });
        },
    });
}
