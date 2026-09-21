// Physical planner boundaries follow the same bounded joins as their civil
// backstops. Their world-meter polygons are inputs to both receiver clipping
// and material masks; raster resolution must never choose an opening's width.
import { orient2d } from 'robust-predicates';

export const PLANNER_STRUCTURE_JOIN_MITER_LIMIT = 3;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

export function plannerStructureJoinVector(previous, next) {
    if (!previous) return next || { x: 1, z: 0 };
    if (!next) return previous;
    let nx = next.x, nz = next.z;
    if (previous.x * nx + previous.z * nz < 0) { nx = -nx; nz = -nz; }
    let x = previous.x + nx, z = previous.z + nz;
    const length = Math.hypot(x, z);
    if (length < 1e-5) return previous;
    x /= length; z /= length;
    const denominator = Math.max(1 / PLANNER_STRUCTURE_JOIN_MITER_LIMIT, Math.abs(x * nx + z * nz));
    const scale = Math.min(PLANNER_STRUCTURE_JOIN_MITER_LIMIT, 1 / denominator);
    return { x: x * scale, z: z * scale };
}

const joins = ['startJoinX', 'startJoinZ', 'endJoinX', 'endJoinZ'];
const coordinates = ['x1', 'z1', 'x2', 'z2', 'widthM'];
const samePoint = (a, b) => a.x2 === b.x1 && a.z2 === b.z1;

export function* capturePlannerOpeningRegionsSteps(cuts, { maxCuts, maxRegions, maxVertices,
    now = () => performance.now(), isCurrent = () => true } = {}) {
    if (![maxCuts, maxRegions, maxVertices].every(value => Number.isSafeInteger(value) && value > 0)
        || !Array.isArray(cuts)) throw new TypeError('Planner openings require a complete array and explicit capacities');
    if (cuts.length > maxCuts) fail('ground-opening-capacity', 'Complete planner source set exceeds capacity');
    let deadline = now() + .5;
    const check = () => { if (!isCurrent()) fail('ground-opening-stale', 'Planner opening source was superseded'); };
    function* budget(phase) { check(); if (now() >= deadline) { yield { phase }; check(); deadline = now() + .5; } }
    const rows = [], paths = new Map();
    // Path order is explicit. Neighbour lookup needs no whole-network sort,
    // and arrival order cannot change the two joins belonging to a segment.
    for (const cut of cuts) {
        yield* budget('ground-planner-opening-capture');
        if (!coordinates.every(key => finite(cut?.[key])) || cut.widthM <= 0
            || typeof cut.kind !== 'string' || !cut.kind) {
            fail('ground-opening-coordinate', 'Planner opening lacks finite segment coordinates or kind');
        }
        const dx = cut.x2-cut.x1, dz = cut.z2-cut.z1, length = Math.hypot(dx,dz);
        if (!finite(length) || !length) fail('ground-opening-shape', 'Planner path segments must have length');
        const explicitJoins = joins.some(key => Object.hasOwn(cut,key));
        if (explicitJoins && (!joins.every(key => finite(cut[key]))
            || !Math.hypot(cut.startJoinX,cut.startJoinZ) || !Math.hypot(cut.endJoinX,cut.endJoinZ))) {
            fail('ground-opening-coordinate', 'Planner opening requires both complete civil joins');
        }
        const row = { ...Object.fromEntries(coordinates.map(key => [key,cut[key]])), kind:cut.kind,
            frame:{x:-dz/length,z:dx/length}, explicitJoins,
            ...(explicitJoins ? Object.fromEntries(joins.map(key => [key,cut[key]])) : {}) };
        if (cut.pathId != null) {
            if (typeof cut.pathId !== 'string' || !cut.pathId || !Number.isSafeInteger(cut.pathOrder) || cut.pathOrder < 0) {
                fail('ground-opening-shape', 'Planner paths require an explicit identity and non-negative order');
            }
            let path = paths.get(cut.pathId);
            if (!path) paths.set(cut.pathId,path=new Map());
            if (path.has(cut.pathOrder)) fail('ground-opening-shape', 'Planner path has competing segment order');
            Object.assign(row,{pathId:cut.pathId,pathOrder:cut.pathOrder,path});
            path.set(cut.pathOrder,row);
        }
        rows.push(row);
    }
    const regions = [];
    for (const row of rows) {
        yield* budget('ground-planner-opening-boundary');
        if (regions.length >= maxRegions || (regions.length+1)*4 > maxVertices) {
            fail('ground-opening-capacity', 'Complete planner boundary set exceeds capacity');
        }
        let start, end;
        if (row.explicitJoins) {
            start={x:row.startJoinX,z:row.startJoinZ}; end={x:row.endJoinX,z:row.endJoinZ};
        } else {
            const previous = row.path?.get(row.pathOrder-1), next = row.path?.get(row.pathOrder+1);
            const before = previous && samePoint(previous,row) ? previous : null;
            const after = next && samePoint(row,next) ? next : null;
            if ([before,after].some(value => value && (value.widthM !== row.widthM || value.kind !== row.kind))) {
                fail('ground-opening-shape', 'A planner path changes width or kind without explicit civil joins');
            }
            start=plannerStructureJoinVector(before?.frame,row.frame);
            end=plannerStructureJoinVector(row.frame,after?.frame);
        }
        const half = row.widthM*.5;
        // Butt caps end exactly at the backstop endpoints. Station access is
        // a separate capsule source, never an implicit extension of a ramp.
        const ring = [
            {x:row.x1-start.x*half,z:row.z1-start.z*half},
            {x:row.x2-end.x*half,z:row.z2-end.z*half},
            {x:row.x2+end.x*half,z:row.z2+end.z*half},
            {x:row.x1+start.x*half,z:row.z1+start.z*half},
        ];
        if (!ring.every(point => finite(point.x) && finite(point.z))) fail('ground-opening-coordinate', 'Planner boundary is not finite');
        let winding = 0;
        for (let i=0;i<4;i++) for (const point of ring) {
            const a=ring[i],b=ring[(i+1)%4],side=Math.sign(orient2d(a.x,a.z,b.x,b.z,point.x,point.z));
            if (side && winding && side!==winding) fail('ground-opening-shape', 'Planner joins cross inside a source segment');
            if (side) winding=side;
        }
        if (!winding) fail('ground-opening-shape', 'Planner opening boundary has no area');
        const bounds = {minX:Math.min(...ring.map(p=>p.x)),minZ:Math.min(...ring.map(p=>p.z)),
            maxX:Math.max(...ring.map(p=>p.x)),maxZ:Math.max(...ring.map(p=>p.z))};
        regions.push(Object.freeze({kind:row.kind,
            ...(row.pathId ? {pathId:row.pathId,pathOrder:row.pathOrder} : {}),
            ring:Object.freeze(ring.map(Object.freeze)),bounds:Object.freeze(bounds),
            minY:null,maxY:1,maxYExclusive:true}));
    }
    check(); return Object.freeze(regions);
}
