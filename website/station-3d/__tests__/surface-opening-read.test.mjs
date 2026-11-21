// Opening applicability must agree with the existing hierarchy in the point
// query, actual receiver triangles, and the terrain Worker input layers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurfaceOpeningReadSteps } from '../core/surface-opening-read.js';
import { compileSurfaceClaim, compileSurfaceRenderContract, SURFACE_STENCIL_MODE, SURFACE_PLANNER_CUTOUT_MODE,
    SURFACE_CLASS, SURFACE_COVERAGE_STATE, SURFACE_VERTICAL_RELATION } from '../core/surface-hierarchy.js';
import { clipReceiverGeometrySteps } from '../core/terrain-receiver-topology.js';
import { createTerrainCutoutTopologySteps } from '../core/terrain-cutout-topology.js';
import { clipReceiverOpeningsSteps } from '../core/receiver-opening-geometry.js';
import { createReceiverFootprintSteps } from '../core/receiver-footprint.js';

const drain=steps=>{for(;;){const next=steps.next();if(next.done)return next.value;}};
const limits={maxRegions:64,maxSourceVertices:256,maxCandidates:32,maxFragments:128};
const region=(x,extra={})=>({ring:[{x,z:-1},{x:x+2,z:-1},{x:x+2,z:1},{x,z:1}],minY:null,maxY:1,maxYExclusive:true,...extra});
const claim=(surfaceClass,extra={})=>compileSurfaceClaim({surfaceClass,
    coverageState:SURFACE_COVERAGE_STATE.PUBLISHED,verticalRelation:SURFACE_VERTICAL_RELATION.SAME_LEVEL,...extra});
const terrain=claim(SURFACE_CLASS.TERRAIN),road=claim(SURFACE_CLASS.ROAD_CARRIAGEWAY),marking=claim(SURFACE_CLASS.ROAD_MARKING);
const bridge=claim(SURFACE_CLASS.STRUCTURE,{verticalRelation:SURFACE_VERTICAL_RELATION.GRADE_SEPARATED,replacementKey:'bridge'});
const sources=()=>({authored:[region(0,{minY:-2,maxY:3,maxYExclusive:false,replacementKey:'portal'})],entrances:[region(10)],
    planner:[region(20,{kind:'surface-track'}),region(30,{kind:'ramp'})],water:[region(40,{maxY:null})]});
const build=options=>drain(createSurfaceOpeningReadSteps({limits,...options}));
const triangle=(x,y=0)=>[{x:x+.25,y,z:-.5},{x:x+1.75,y,z:-.5},{x:x+1,y,z:.5}];

test('canonical receiver classes select identical cuts for point queries and geometry',()=>{
    const read=build(sources());
    for(const [receiver,expected] of [[terrain,[true,true,true,true,true]],
        [road,[true,true,true,true,false]],[marking,[true,true,false,true,false]],[bridge,[true,false,false,false,false]]]) {
        for(const [i,x] of [0,10,20,30,40].entries()) {
            assert.equal(read.contains(x+1,0,0,receiver),expected[i],`${receiver.surfaceClass} at ${x}`);
            const result=drain(read.topologyForClaim(receiver).clipTriangleSteps(...triangle(x)));
            assert.equal(result.unchanged,!expected[i]);
            if(expected[i])assert.deepEqual(result.triangles,[]);
        }
    }
});

test('detached receivers prepare the published openings without receiving renderer permission',()=>{
    const read=build(sources());
    for(const surfaceClass of [SURFACE_CLASS.TERRAIN,SURFACE_CLASS.ROAD_CARRIAGEWAY,SURFACE_CLASS.ROAD_MARKING]) {
        const published=claim(surfaceClass);
        for(const coverageState of [SURFACE_COVERAGE_STATE.PLANNED,SURFACE_COVERAGE_STATE.BUILDING]) {
            const detached=claim(surfaceClass,{coverageState});
            for(const x of [0,10,20,30,40]) {
                const removed=read.contains(x+1,0,0,published);
                assert.equal(read.contains(x+1,0,0,detached),removed,`${surfaceClass}/${coverageState}/${x}`);
                assert.equal(drain(read.topologyForClaim(detached).clipTriangleSteps(...triangle(x))).unchanged,!removed);
            }
            assert.deepEqual(drain(read.terrainLayersSteps(detached)),drain(read.terrainLayersSteps(published)));
            const render=compileSurfaceRenderContract(detached);
            assert.equal(render.disabledReason,'surface-not-published');
            assert.equal(render.stencilMode,SURFACE_STENCIL_MODE.NONE);
            assert.equal(render.plannerCutoutMode,SURFACE_PLANNER_CUTOUT_MODE.NONE);
            assert.equal(detached.coverageState,coverageState);
        }
    }
    for(const verticalRelation of [SURFACE_VERTICAL_RELATION.UNKNOWN,SURFACE_VERTICAL_RELATION.GRADE_SEPARATED]) {
        const detached=claim(SURFACE_CLASS.ROAD_CARRIAGEWAY,{coverageState:SURFACE_COVERAGE_STATE.BUILDING,verticalRelation});
        assert.equal(read.contains(31,0,0,detached),false,'unproved or separate strata retain depth ownership');
    }
});

test('an opening cannot cut its own prepared replacement floor, while unrelated intersecting structure yields',()=>{
    const read=build(sources()),replacement=claim(SURFACE_CLASS.STRUCTURE,{
        verticalRelation:SURFACE_VERTICAL_RELATION.GRADE_SEPARATED,replacementKey:'portal'});
    assert.equal(read.contains(1,0,0,replacement),false);
    assert.equal(drain(read.topologyForClaim(replacement).clipTriangleSteps(...triangle(0))).unchanged,true);
    assert.equal(read.contains(1,0,0,bridge),true);
    assert.equal(read.contains(1,3,0,bridge),true,'inclusive authored ceiling');
    assert.equal(read.contains(1,3.001,0,bridge),false);
    assert.equal(read.contains(11,1,0,terrain),false,'strict planner ceiling');
});

test('terrain layers retain height gates and exactly the same selected holes as receiver buffers',()=>{
    const read=build(sources()),layers=drain(read.terrainLayersSteps(terrain));
    const terrainTopology=drain(createTerrainCutoutTopologySteps({layers,limits:{maxSources:64,maxSourceVertices:256,
        maxIndexEntries:8192,maxCellCandidates:64,maxOperandVertices:2048,maxIntersections:2048,maxOutputTriangles:2048}}));
    for(const x of [0,10,20,30,40,50])for(const y of [0,1,4]) {
        const face=triangle(x,y),geometry={positions:new Float32Array(face.flatMap(p=>[p.x,p.y,p.z])),indices:new Uint32Array([0,2,1])};
        const a=drain(clipReceiverGeometrySteps({geometry,topology:read.topologyForClaim(terrain),maxVertices:128,maxTriangles:128}));
        const b=drain(clipReceiverGeometrySteps({geometry,topology:terrainTopology,maxVertices:128,maxTriangles:128}));
        assert.equal(a.indices.length,b.indices.length,`terrain (${x},${y})`);
        assert.equal(a.indices.length===0,read.contains(x+1,y,0,terrain));
    }
    assert.equal(Object.isFrozen(layers[0].regions),true);
});

test('captured boundaries are immutable and rejected preparation cannot alter them',()=>{
    const input=sources(),read=build(input);input.authored[0].ring[0].x=-999;
    assert.equal(read.regions[0].ring[0].x,0);
    assert.equal(Object.isFrozen(read.regions[0].ring),true);
    assert.throws(()=>read.regions[0].ring[0].x=999,TypeError);
    assert.throws(()=>build({...sources(),limits:{...limits,maxRegions:4}}),{code:'ground-opening-capacity'});
    let current=true,time=0;
    const steps=createSurfaceOpeningReadSteps({...sources(),limits,now:()=>time+=.3,isCurrent:()=>current});
    assert.equal(steps.next().done,false);current=false;
    assert.throws(()=>drain(steps),{code:'ground-opening-stale'});
    assert.equal(read.contains(1,0,0,terrain),true);
});

test('empty opening reads preserve receiver arrays and emit no terrain work',()=>{
    const read=build({}),geometry={positions:new Float32Array([0,0,0,2,0,0,0,0,2]),indices:new Uint32Array([0,2,1])};
    assert.equal(read.empty,true);assert.deepEqual(drain(read.terrainLayersSteps(terrain)),[]);
    const result=drain(clipReceiverGeometrySteps({geometry,topology:read.topologyForClaim(terrain),maxVertices:3,maxTriangles:1}));
    assert.equal(result.positions,geometry.positions);assert.equal(result.indices,geometry.indices);
    assert.equal(read.contains(1,0,.1,terrain),false);
});

test('a clipped sloping receiver remains connected across its source grid and keeps complete holes',()=>{
    const positions=[],indices=[];
    for(let z=0;z<=12;z++)for(let x=0;x<=12;x++)positions.push(x-6,(x-6)*.03+(z-6)*.07,z-6);
    for(let z=0;z<12;z++)for(let x=0;x<12;x++){const i=z*13+x;indices.push(i,i+13,i+1,i+1,i+13,i+14);}
    const geometry={positions:new Float32Array(positions),indices:new Uint32Array(indices)};
    for(const ring of [
        [{x:-1,z:-1},{x:1,z:-1},{x:1,z:1},{x:-1,z:1}],
        [{x:-.17,z:-.41},{x:1.19,z:-.41},{x:1.19,z:1.13},{x:-.17,z:1.13}],
        [{x:0,z:-2},{x:2,z:0},{x:0,z:2},{x:-2,z:0}],
        [{x:-1.25,z:-.75},{x:2.25,z:.5},{x:1.25,z:1.5},{x:-2.25,z:.25}],
    ]) {
        const read=build({authored:[{ring,minY:-2,maxY:2}]});
        const clipped=drain(clipReceiverOpeningsSteps({geometry,openingRead:read,claim:road,maxVertices:8192,maxTriangles:4096}));
        const footprint=drain(createReceiverFootprintSteps({positions:clipped.positions,indices:clipped.indices,maxTriangles:4096}));
        assert.equal(footprint.regions.length,1);assert.equal(footprint.regions[0].holeRings.length,1);
        const area=r=>Math.abs(r.reduce((a,p,i)=>{const q=r[(i+1)%r.length];return a+p.x*q.z-q.x*p.z;},0))/2;
        assert.ok(Math.abs(area(footprint.regions[0].holeRings[0])-area(ring))<1e-5);
    }
});

test('an opening across zero-length source joins retains one closed footprint and separate UV seams',()=>{
    const opening=region(1.5,{ring:[{x:1.5,z:1.5},{x:2.5,z:1.5},{x:2.5,z:2.5},{x:1.5,z:2.5}],minY:-1,maxY:1});
    const read=build({authored:[opening]});
    const geometry={positions:new Float32Array([0,0,0,4,0,0,0,0,4,4,0,0,4,0,4,0,0,4]),
        indices:new Uint32Array([0,1,2,3,4,5,1,3,2,3,5,2]),
        uvs:new Float32Array([0,0,1,0,0,1,11,0,11,1,10,1])};
    const original=structuredClone(geometry);
    for(const source of [geometry,{positions:new Float32Array([...geometry.indices].flatMap(i=>[...geometry.positions.slice(i*3,i*3+3)])),
        uvs:new Float32Array([...geometry.indices].flatMap(i=>[...geometry.uvs.slice(i*2,i*2+2)])),indices:null}]) {
        const clipped=drain(clipReceiverOpeningsSteps({geometry:source,openingRead:read,claim:road,maxVertices:256,maxTriangles:256}));
        // Omitting the geometric identities recreates the native failure.
        if(source.indices)assert.throws(()=>drain(createReceiverFootprintSteps({positions:clipped.positions,indices:clipped.indices,maxTriangles:256})),
            {code:'receiver-footprint-topology'});
        else {
            const broken=drain(createReceiverFootprintSteps({positions:clipped.positions,indices:clipped.indices,maxTriangles:256}));
            assert.notDeepEqual([broken.regions.length,...broken.regions.map(r=>r.holeRings.length)],[1,1]);
        }
        const footprint=drain(createReceiverFootprintSteps({...clipped,maxTriangles:256}));
        assert.equal(footprint.regions.length,1);assert.equal(footprint.regions[0].holeRings.length,1);
        assert.equal(footprint.area,15);
        const seam=[];
        for(let i=0;i<clipped.positions.length/3;i++)if(clipped.positions[i*3]===2.5&&clipped.positions[i*3+2]===1.5)seam.push(i);
        assert.equal(seam.length,2);
        assert.equal(clipped.topologyVertexIds[seam[0]],clipped.topologyVertexIds[seam[1]]);
        assert.equal(Math.abs(clipped.uvs[seam[0]*2]-clipped.uvs[seam[1]*2]),10);
        const corrupt=clipped.topologyVertexIds.slice();corrupt[0]=1;
        assert.throws(()=>drain(createReceiverFootprintSteps({...clipped,topologyVertexIds:corrupt,maxTriangles:256})),
            {code:'receiver-footprint-topology'});
    }
    assert.deepEqual(geometry,original);
});

test('nonindexed wall receivers keep source attributes and distant openings reuse arrays without triangle work',()=>{
    const geometry={positions:new Float32Array([-2,0,0,2,0,0,2,4,0,-2,0,0,2,4,0,-2,4,0]),
        uvs:new Float32Array([0,0,1,0,1,1,0,0,1,1,0,1])};
    const read=build({authored:[{...region(-.5),ring:[{x:-.5,z:-1},{x:.5,z:-1},{x:.5,z:1},{x:-.5,z:1}],minY:0,maxY:2.5}]});
    const clipped=drain(clipReceiverOpeningsSteps({geometry,openingRead:read,claim:bridge,maxVertices:128,maxTriangles:128}));
    assert.equal(clipped.topology.changedTriangles,2);assert.ok(clipped.indices.length>0);
    assert.notEqual(clipped.positions,geometry.positions);assert.equal(clipped.uvs.length/2,clipped.positions.length/3);
    assert.equal(Object.hasOwn(geometry,'indices'),false,'no synthetic indices are installed on the source');
    const far=build({authored:[region(1000)]});
    let touches=0;
    const guarded={...far,topologyForClaim(claim){const t=far.topologyForClaim(claim);return {...t,
        clipTriangleSteps(){touches++;throw new Error('Distant triangles must not be visited');}};}};
    const retained=drain(clipReceiverOpeningsSteps({geometry,openingRead:guarded,claim:bridge,maxVertices:128,maxTriangles:128}));
    assert.equal(retained,geometry);assert.equal(touches,0);
    assert.throws(()=>drain(clipReceiverOpeningsSteps({geometry,openingRead:read,claim:bridge,maxVertices:5,maxTriangles:128})),
        {code:'ground-opening-capacity'});
});
