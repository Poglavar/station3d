import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createDecorGroundPaintOwnerSteps,
    DECOR_LANDUSE_TYPES,
    decorGroundPaintEligible,
} from '../core/decor-ground-paint.js';
import {
    decorSurfaceEdgingPolygonsSteps,
    decorSurfaceEdgingTypeIndex,
} from '../core/decor-surface-edging.js';
import { createGroundCompositePlanSteps } from '../core/ground-composite-plan.js';
import { createGroundSurfacePaintRecordSteps } from '../core/ground-surface-paint.js';
import { compileSurfaceClaim, SURFACE_CLASS } from '../core/surface-hierarchy.js';

const receiver = Object.freeze({
    key: 'terrain:fixture', verticalBand: 'ground', coverageRevision: 'r1',
    bounds: Object.freeze({ minX: -20, minZ: -20, maxX: 20, maxZ: 20 }),
});
const outer = [{ x: -4, z: -4 }, { x: 4, z: -4 }, { x: 4, z: 4 }, { x: -4, z: 4 }];
const hole = [{ x: -1, z: -1 }, { x: 1, z: -1 }, { x: 1, z: 1 }, { x: -1, z: 1 }];

function exhaust(iterator) {
    for (;;) {
        const next = iterator.next();
        if (next.done) return next.value;
    }
}

function decor(type, rings = [outer], sourceId = `fixture-${type}`) {
    return exhaust(createDecorGroundPaintOwnerSteps({
        type, sourceId, rings, receiver,
        materialKey: `landuse:${type}`, materialRevision: 'v1',
    }));
}

function composite(records) {
    return exhaust(createGroundCompositePlanSteps({
        receiver, records,
        limits: { records: 32, vertices: 4096, verticesPerRecord: 1024, oversized: 32 },
    }));
}

test('all supported land-use types emit colour-only holed sources', () => {
    for (const type of DECOR_LANDUSE_TYPES) {
        const source = decor(type, [outer, hole]);
        const record = source.records[0];
        assert.equal(record.claim.capabilities.color, true, type);
        assert.equal(record.claim.capabilities.support, false, type);
        assert.equal(record.claim.capabilities.backstopCut, false, type);
        assert.equal(record.polygons[0].holeRings.length, 1, type);
        assert.equal(record.receiver.key, receiver.key, type);
    }
});

test('land-use priority is stable across overlap and higher-ranked road paint wins', () => {
    const green = decor('green', [outer], 'same-source');
    const forest = decor('forest', [outer], 'same-source');
    const paving = decor('paving', [outer], 'same-source');
    assert.ok(green.records[0].sourcePriority < forest.records[0].sourcePriority);
    assert.ok(forest.records[0].sourcePriority < paving.records[0].sourcePriority);

    for (const [surfaceClass, key] of [
        [SURFACE_CLASS.ROAD_CARRIAGEWAY, 'road:fixture'],
        [SURFACE_CLASS.CYCLEWAY, 'cycle:fixture'],
        [SURFACE_CLASS.PARKING, 'parking:fixture'],
    ]) {
        const road = exhaust(createGroundSurfacePaintRecordSteps({
            geometry: { type: 'Polygon', coordinates: [outer.map(({ x, z }) => [x, z])] },
            identity: { key, revisionKey: `${key}:r1` }, receiver,
            project: (x, z) => ({ x, z }), materialKey: key, materialRevision: 'v1',
            sourcePriority: 0,
            claim: compileSurfaceClaim({
                surfaceClass, ownerId: key,
                verticalBand: 'ground', verticalRelation: 'same-level',
            }),
        }));
        const plan = composite([green.records[0], forest.records[0], paving.records[0], road]);
        assert.equal(plan.paintAt(0, 0, receiver).key, key);
        assert.equal(plan.paintAt(2, 2, receiver).key, key);
    }
});

test('decor eligibility rejects grade-separated and unrelated sources', () => {
    assert.equal(decorGroundPaintEligible('green', {}), true);
    assert.equal(decorGroundPaintEligible('green', { level: 1 }), false);
    assert.equal(decorGroundPaintEligible('green', { tags: { bridge: 'yes' } }), false);
    assert.equal(decorGroundPaintEligible('unknown', {}), false);
    assert.throws(() => decor('not-a-landuse'), /Unsupported decor ground paint class/);
    assert.throws(() => exhaust(createGroundSurfacePaintRecordSteps({
        geometry: { type: 'Polygon', coordinates: [outer.map(({ x, z }) => [x, z])] },
        identity: { key: 'grade:fixture', revisionKey: 'r1' }, receiver,
        project: (x, z) => ({ x, z }), materialKey: 'grade', materialRevision: 'v1',
        claim: compileSurfaceClaim({
            surfaceClass: SURFACE_CLASS.PARKING, ownerId: 'grade:fixture',
            verticalBand: 'ground', verticalRelation: 'grade-separated',
        }),
    })), /Contradictory ground paint claim relation/);
});

test('canonical identity is unchanged by ring reversal and removal exposes lower winner', () => {
    const forward = decor('paving', [outer], 'canonical');
    const reversed = decor('paving', [outer.slice().reverse()], 'canonical');
    assert.equal(forward.canonical, reversed.canonical);

    const low = decor('green', [outer], 'low');
    const high = decor('paving', [outer], 'high');
    const before = composite([low.records[0], high.records[0]]);
    assert.equal(before.paintAt(0, 0, receiver).key, high.records[0].key);
    const after = composite([low.records[0], { ...high.records[0], visible: false }]);
    assert.equal(after.paintAt(0, 0, receiver).key, low.records[0].key);
});

test('edging emits narrow outer and hole boundary bands with bounded work', () => {
    assert.equal(decorSurfaceEdgingTypeIndex('paving'), 1);
    const chunks = [...decorSurfaceEdgingPolygonsSteps([outer, hole], { segmentsPerStep: 2 })];
    assert.equal(chunks.length, 4);
    assert.ok(chunks.every(chunk => chunk.length <= 2));
    assert.equal(chunks.flat().length, 8);
    assert.throws(() => [...decorSurfaceEdgingPolygonsSteps([outer], { width: 0 })], /Invalid edging/);
    assert.throws(() => [...decorSurfaceEdgingPolygonsSteps([[{ x: NaN, z: 0 }, ...outer.slice(1)]])], /finite/);
});

test('edging output stays on boundaries rather than filling the polygon interior', () => {
    const chunks = [...decorSurfaceEdgingPolygonsSteps([outer, hole])].flat();
    const points = chunks.flatMap(([ring]) => ring);
    assert.ok(points.every(point => Math.abs(Math.abs(point.x) - 4) < 0.2
        || Math.abs(Math.abs(point.z) - 4) < 0.2
        || Math.abs(Math.abs(point.x) - 1) < 0.2
        || Math.abs(Math.abs(point.z) - 1) < 0.2));
    assert.equal(points.some(point => Math.abs(point.x) < 0.5 && Math.abs(point.z) < 0.5), false);
    const owner = exhaust(createDecorGroundPaintOwnerSteps({ type: 'edging', sourceId: 'edge',
        polygons: chunks, receiver, materialKey: 'edge', materialRevision: '1' }));
    const plan = composite(owner.records);
    for (const [x, z] of [[0, -4], [0, -3.931], [0, -4.069], [0, -1], [0, -.931]]) {
        assert.equal(plan.paintAt(x, z, receiver)?.key, owner.owner, `${x},${z} is inside the 14 cm band`);
    }
    for (const [x, z] of [[0, 0], [2, 2], [0, -3.929], [0, -4.071], [0, -.929]]) {
        assert.equal(plan.paintAt(x, z, receiver), null, `${x},${z} is outside the band`);
    }
});

test('retained paving with 88 holes reaches the paint packet with outer-minus-hole area', async () => {
    const {readFileSync}=await import('node:fs');
    const {geoToLocal}=await import('../core/math.js');
    const {createGroundPaintPacketSteps}=await import('../core/ground-paint-packet.js');
    const fixture=JSON.parse(readFileSync(new URL('./fixtures/decor-landuse-holed.json',import.meta.url)));
    const input=fixture.feature.geometry.coordinates;
    const polygons=input.map(rings=>rings.map(ring=>ring.map(([lon,lat])=>geoToLocal(lon,lat,16.44,43.51))));
    const points=polygons.flat(2), bounds={minX:Math.min(...points.map(p=>p.x))-1,minZ:Math.min(...points.map(p=>p.z))-1,
        maxX:Math.max(...points.map(p=>p.x))+1,maxZ:Math.max(...points.map(p=>p.z))+1};
    const target={...receiver,bounds};
    const owner=exhaust(createDecorGroundPaintOwnerSteps({type:'paving',sourceId:'retained-holed-paving',
        polygons,receiver:target,materialKey:'paving',materialRevision:'1'}));
    assert.equal(owner.records[0].polygons.reduce((sum,p)=>sum+p.holeRings.length,0),88);
    const plan=exhaust(createGroundCompositePlanSteps({receiver:target,records:owner.records,
        limits:{records:2,vertices:8192,verticesPerRecord:8192,oversized:2}}));
    const styles=new Map([['paving',{id:1,revision:'1',surfaceClass:SURFACE_CLASS.PASSIVE_LANDUSE,
        roughness:.95,metalness:0,normalInfluence:0,linearColor:[1,1,1]}]]);
    const packet=exhaust(createGroundPaintPacketSteps({plan,bounds,size:32,styles,
        limits:{pixels:1024,draws:100,verticesPerPolygon:8192}}));
    const ringArea=ring=>Math.abs(ring.reduce((sum,p,i)=>{const q=ring[(i+1)%ring.length];return sum+p.x*q.z-q.x*p.z;},0))/2;
    const expected=polygons.reduce((sum,[outer,...holes])=>sum+ringArea(outer)-holes.reduce((s,r)=>s+ringArea(r),0),0);
    let drawn=0;
    for(const draw of packet.draws)for(let i=0;i<draw.indices.length;i+=3){
        const [a,b,c]=[0,1,2].map(j=>draw.indices[i+j]*3),p=draw.positions;
        drawn+=Math.abs((p[b]-p[a])*(p[c+1]-p[a+1])-(p[b+1]-p[a+1])*(p[c]-p[a]))/2;
    }
    assert.ok(Math.abs(drawn-expected)<expected*1e-5,`drawn ${drawn}, source area ${expected}`);
});
