import test from 'node:test';
import assert from 'node:assert/strict';
import { roadGroundPaintEligible, roadReceiverPaintEligible } from '../core/road-ground-paint.js';
import { createGroundSurfacePaintRecordSteps } from '../core/ground-surface-paint.js';
import { compileSurfaceClaim, SURFACE_CLASS } from '../core/surface-hierarchy.js';

const receiver = { key:'ground:jelacic', verticalBand:'ground', coverageRevision:'r1' };
const feature = coordinates => ({ geometry:{ type:'Polygon', coordinates } });
const run = g => { let n; do n=g.next(); while(!n.done); return n.value; };
const claim = (surfaceClass=SURFACE_CLASS.SIDEWALK, extra={}) => compileSurfaceClaim({ surfaceClass, verticalBand:'ground', verticalRelation:'same-level', ...extra });

test('eligibility accepts pedestrian paving and rejects engineered/grade-separated types', () => {
    for (const type of ['pedestrian','footway','path']) assert.equal(roadGroundPaintEligible({type}), true);
    for (const type of ['steps','cycleway','bridleway','road']) assert.equal(roadGroundPaintEligible({type}), false);
    assert.equal(roadGroundPaintEligible({type:'footway', properties:{layer:'0'}}), true);
    assert.equal(roadGroundPaintEligible({type:'footway', properties:{bridge:'yes'}}), false);
});

test('record preserves holes, classes, immutable identity and lazy projection', () => {
    let calls=0; const g=createGroundSurfacePaintRecordSteps({ geometry:feature([[[0,0],[1,0],[1,1]],[[.2,.2],[.3,.2],[.2,.3]]]).geometry, identity:{key:'k',revisionKey:'r'}, receiver, project:(lon,lat)=>{calls++;return{x:lon,z:lat}}, claim:claim(), materialKey:'pavers', materialRevision:'m1', verticesPerStep:2 });
    assert.equal(calls,0); g.next(); assert.equal(calls,2); const out=run(g); assert.equal(out.polygons[0].holeRings.length,1); assert.equal(out.sourcePriority,0); assert.equal(Object.isFrozen(out),true);
});

test('rejects contradictory claims, invalid projections and hard vertex cap', () => {
    const base={geometry:feature([[[0,0],[1,0],[0,1]]]).geometry,identity:{key:'k',revisionKey:'r'},receiver,project:()=>({x:0,z:0}),materialKey:'p',materialRevision:'m'};
    assert.equal(run(createGroundSurfacePaintRecordSteps({...base,claim:claim(SURFACE_CLASS.ROAD_CARRIAGEWAY)})).claim.surfaceClass, SURFACE_CLASS.ROAD_CARRIAGEWAY);
    assert.throws(()=>run(createGroundSurfacePaintRecordSteps({...base,geometry:feature([[[0,0],[1,0],[NaN,1]]]).geometry})));
    let calls=0; const g=createGroundSurfacePaintRecordSteps({...base,project:()=>{calls++;return{x:0,z:0}},geometry:feature([Array.from({length:8193},(_,i)=>[i,0])]).geometry}); assert.throws(()=>run(g),/budget/); assert.equal(calls,8192);
});

test('colour-only records support road, cycle, parking and construction while grade separation stays excluded', () => {
    for (const surfaceClass of [SURFACE_CLASS.ROAD_CARRIAGEWAY, SURFACE_CLASS.CYCLEWAY, SURFACE_CLASS.PARKING, SURFACE_CLASS.CONSTRUCTION]) {
        assert.equal(run(createGroundSurfacePaintRecordSteps({ geometry: feature([[[0,0],[1,0],[0,1]]]).geometry,
            identity: { key: String(surfaceClass), revisionKey: 'r' }, receiver,
            project: (x, z) => ({ x, z }), claim: claim(surfaceClass), materialKey: 'p', materialRevision: 'm' })).claim.capabilities.color, true);
    }
    const grade = claim(SURFACE_CLASS.ROAD_CARRIAGEWAY, { verticalRelation: 'grade-separated', verticalBand: 'road-deck' });
    assert.equal(roadReceiverPaintEligible({ claim: grade, type: 'road' }), false);
    assert.equal(roadReceiverPaintEligible({ claim: claim(SURFACE_CLASS.ROAD_CARRIAGEWAY), type: 'road' }), true);
});
