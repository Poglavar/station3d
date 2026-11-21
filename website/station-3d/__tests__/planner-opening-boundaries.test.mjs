// The same civil joins must bound a planner opening regardless of source
// arrival order, raster resolution, or clipping a ramp at ground level.
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSubsurfaceRampCutoutsSteps } from '../core/planner-ground-state.js';
import { createPlannerGeometryBudget } from '../core/planner-geometry-budget.js';
import { capturePlannerOpeningRegionsSteps, plannerStructureJoinVector } from '../core/planner-opening-boundaries.js';
import { createSurfaceOpeningTopologySteps } from '../core/surface-opening-topology.js';
import { clipReceiverGeometrySteps } from '../core/terrain-receiver-topology.js';

const drain=steps=>{for(;;){const next=steps.next();if(next.done)return next.value;}};
const options={maxCuts:128,maxRegions:128,maxVertices:512};
const capture=cuts=>drain(capturePlannerOpeningRegionsSteps(cuts,options));
const segment=(x1,z1,x2,z2,extra={})=>({kind:'ramp',x1,z1,x2,z2,widthM:2,...extra});
const joined=[segment(0,0,10,0,{pathId:'a',pathOrder:0}),segment(10,0,10,10,{pathId:'a',pathOrder:1})];
const topology=regions=>drain(createSurfaceOpeningTopologySteps({regions,
    limits:{maxRegions:128,maxSourceVertices:512,maxCandidates:64,maxFragments:256}}));

test('right-angle route cuts share the exact civil join and use butt end caps',()=>{
    const regions=capture(joined);
    assert.deepEqual(regions[0].ring,[{x:0,z:-1},{x:11,z:-1},{x:9,z:1},{x:0,z:1}]);
    assert.deepEqual(regions[1].ring,[{x:11,z:-1},{x:11,z:10},{x:9,z:10},{x:9,z:1}]);
    assert.deepEqual(regions[0].ring[1],regions[1].ring[0]);
    assert.deepEqual(regions[0].ring[2],regions[1].ring[3]);
    assert.deepEqual(capture(joined.toReversed()).toReversed(),regions);
    const join=plannerStructureJoinVector({x:0,z:1},{x:-1,z:0});
    assert.deepEqual(regions[0].ring[2],{x:10+join.x,z:join.z});
    assert.equal(regions[0].maxY,1);assert.equal(regions[0].maxYExclusive,true);
});

test('explicit partial-ramp joins survive source capture without being recomputed at a cut endpoint',()=>{
    // Exercise the production ground-intersection calculation as well as the
    // pure polygon adapter, using a ramp that reaches grade at t=1/4.
    const [cut]=drain(collectSubsurfaceRampCutoutsSteps([{
        x1:0,z1:0,x2:20,z2:0,e1:2,e2:-6,len:20,
        startJoinX:-1,startJoinZ:1,endJoinX:0,endJoinZ:1,
    }],createPlannerGeometryBudget()));
    assert.equal(cut.x1,5);assert.equal(cut.startJoinX,-.75);
    const [region]=capture([cut]);
    const half=cut.widthM/2;
    assert.deepEqual(region.ring,[{x:5+.75*half,z:-half},{x:20,z:-half},{x:20,z:half},{x:5-.75*half,z:half}]);
    cut.startJoinX=100;
    assert.equal(region.ring[0].x,5+.75*half);assert.equal(Object.isFrozen(region.ring[0]),true);
});

test('path gaps remain closed ground and different path identities cannot create a connecting opening',()=>{
    const inputs=[segment(0,0,10,0,{pathId:'a',pathOrder:0}),segment(10.1,0,10.1,10,{pathId:'a',pathOrder:1}),
        segment(10,0,10,-10,{pathId:'b',pathOrder:0})];
    const regions=capture(inputs);
    assert.deepEqual(regions[0].ring,[{x:0,z:-1},{x:10,z:-1},{x:10,z:1},{x:0,z:1}]);
    assert.deepEqual(regions[1].ring,[{x:11.1,z:0},{x:11.1,z:10},{x:9.1,z:10},{x:9.1,z:0}]);
    const far=capture([segment(20,0,30,0,{pathId:'a',pathOrder:1}),inputs[0]]);
    const face=[{x:14,y:0,z:-.5},{x:16,y:0,z:-.5},{x:15,y:0,z:.5}];
    assert.equal(drain(topology(far).clipTriangleSteps(...face)).unchanged,true);
});

test('joined planner polygons remove the exact union from a receiver without capsule end lobes',()=>{
    const geometry={positions:new Float32Array([-2,0,-2,12,0,-2,12,0,12,-2,0,12]),indices:new Uint32Array([0,2,1,0,3,2])};
    const result=drain(clipReceiverGeometrySteps({geometry,topology:topology(capture(joined)),maxVertices:256,maxTriangles:256}));
    let area=0;
    for(let i=0;i<result.indices.length;i+=3){const [a,b,c]=[0,1,2].map(j=>result.indices[i+j]*3),p=result.positions;
        area+=Math.abs((p[b]-p[a])*(p[c+2]-p[a+2])-(p[b+2]-p[a+2])*(p[c]-p[a]))/2;}
    assert.ok(Math.abs(area-(196-40))<1e-5,`retained area ${area}`);
    const cap=[{x:-.5,y:0,z:0},{x:-.1,y:0,z:-.25},{x:-.1,y:0,z:.25}];
    assert.equal(drain(topology(capture(joined)).clipTriangleSteps(...cap)).unchanged,true);
});

test('malformed, conflicting, folded and over-capacity boundaries reject the complete source set',()=>{
    const rejects=cuts=>assert.throws(()=>capture(cuts),error=>/^ground-opening-/.test(error.code));
    rejects([segment(0,0,0,0)]);rejects([segment(0,0,1,0,{widthM:0})]);
    rejects([segment(0,0,1,0,{pathId:'a'})]);rejects([joined[0],joined[0]]);
    rejects([joined[0],{...joined[1],widthM:4}]);
    rejects([segment(0,0,1,0,{startJoinX:1})]);
    rejects([segment(0,0,1,0,{startJoinX:0,startJoinZ:1,endJoinX:0,endJoinZ:-1})]);
    for(const patch of [{maxCuts:1},{maxRegions:1},{maxVertices:7}])assert.throws(()=>
        drain(capturePlannerOpeningRegionsSteps(joined,{...options,...patch})),{code:'ground-opening-capacity'});
    let current=true,time=0;const steps=capturePlannerOpeningRegionsSteps(joined,{...options,
        now:()=>time+=.3,isCurrent:()=>current});
    assert.equal(steps.next().done,false);current=false;
    assert.throws(()=>drain(steps),{code:'ground-opening-stale'});
});
