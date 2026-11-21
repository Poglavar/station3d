// Lock ground-input semantics against the actual frozen v76 planner before
// replacing its synchronous state preparation with the shared transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from 'three';
import { captureReceiverMeshReadSteps } from '../core/receiver-mesh-read.js';
import { capturePlannerTrackSegments } from '../core/planner-track-segments.js';
import { createPlannerGeometryBudget, PLANNER_GEOMETRY_LIMITS } from '../core/planner-geometry-budget.js';
import { preparePlannerStationWalkWidthsSteps, preparePlannerWalkIndexSteps,
    collectGroundTrackSurfaceCutoutsSteps, collectSubsurfaceRampCutoutsSteps } from '../core/planner-ground-state.js';
import { createPlannerGeometryRuntime } from './fixtures/planner-geometry-runtime.mjs';
const before=JSON.parse(readFileSync(new URL('./fixtures/planner-state-before.json',import.meta.url)));
const finish=(steps, inspect=()=>{})=>{try{for(let i=0;i<100000;i++){
    const next=steps.next();if(next.done)return next.value;inspect(next.value);
}assert.fail('Planner state did not converge');}finally{steps.return();}};
const budget=(patch={})=>createPlannerGeometryBudget({limits:{...PLANNER_GEOMETRY_LIMITS,...patch}});

test('planner cuts, station widths and walk index preserve eleven frozen route inputs',()=>{
    const phases=new Set();
    for(const fixture of before.fixtures){
        let time=0;
        const work=createPlannerGeometryBudget({now:()=>time+=1});
        const run=steps=>finish(steps,item=>phases.add(item.phase));
        const segments=capturePlannerTrackSegments(fixture.features,45,16,{absoluteToSceneY:y=>y-100,groundSceneYAtLocal:()=>3});
        run(preparePlannerStationWalkWidthsSteps(segments,fixture.stops,45,16,work));
        const cuts=run(collectGroundTrackSurfaceCutoutsSteps(fixture.features,45,16,work))
            .concat(run(collectSubsurfaceRampCutoutsSteps(segments.filter(seg=>!seg.structuresBuiltElsewhere),work)));
        const index=run(preparePlannerWalkIndexSteps(segments,work));
        // The frozen JSON capture normalizes signed zero; preserve the same
        // serialization for comparison without rounding any nonzero number.
        assert.deepEqual(JSON.parse(JSON.stringify({segments,cuts,
            index:[...index].map(([key,rows])=>[key,rows.map(row=>segments.indexOf(row))])})),fixture.expected,fixture.name);
    }
    for(const phase of ['planner-walk-station-segment','planner-walk-index-cell','planner-cut-segment','planner-ramp-cut'])
        assert.ok(phases.has(phase),phase);
});

test('planner state rejects complete input, index and query capacity overruns without returning partial state',()=>{
    const fixture=before.fixtures.at(-1),segments=structuredClone(fixture.expected.segments);
    const throws=steps=>assert.throws(()=>finish(steps),{code:'ground-generation-capacity'});
    throws(preparePlannerWalkIndexSteps(segments,budget({maxInputSegments:1})));
    throws(preparePlannerWalkIndexSteps(segments,budget({maxWalkIndexEntries:1})));
    throws(preparePlannerWalkIndexSteps([segments[0],segments[0]],budget({maxWalkCellCandidates:1})));
    throws(preparePlannerWalkIndexSteps([{...segments[0],x2:Infinity}],budget()));
    throws(preparePlannerStationWalkWidthsSteps(segments,fixture.stops,45,16,budget({maxStopSegmentVisits:1})));
    throws(preparePlannerStationWalkWidthsSteps(segments,[...fixture.stops,...fixture.stops],45,16,budget({maxStops:1})));
    const surface=before.fixtures.find(f=>f.name==='surface-bend-and-ground-intervals');
    throws(collectGroundTrackSurfaceCutoutsSteps(surface.features,45,16,budget({maxCuts:1})));
    throws(collectGroundTrackSurfaceCutoutsSteps(surface.features,45,16,budget({maxCoordinates:1})));
    throws(collectGroundTrackSurfaceCutoutsSteps([...surface.features,...surface.features],45,16,budget({maxFeatures:1})));
    const ramps=before.fixtures.find(f=>f.name==='descending-bend').expected.segments;
    throws(collectSubsurfaceRampCutoutsSteps(ramps,budget({maxCuts:1})));
    let valid=true,time=0;
    const steps=preparePlannerWalkIndexSteps(segments,createPlannerGeometryBudget({isCurrent:()=>valid,now:()=>time+=1}));
    assert.equal(steps.next().done,false);valid=false;
    assert.throws(()=>finish(steps),{code:'ground-generation-stale'});
});

test('the production planner walking query uses published physical faces and distinguishes stacked levels',()=>{
    const {context}=createPlannerGeometryRuntime();
    const root=new THREE.Group(),material=new THREE.MeshBasicMaterial();
    for(const y of [-10,10]) {
        const mesh=new THREE.Mesh(new THREE.PlaneGeometry(2,2).rotateX(-Math.PI/2),material);
        mesh.position.set(60,y,0);root.add(mesh);
    }
    root.updateMatrixWorld(true);
    try {
        context.supportRead=finish(captureReceiverMeshReadSteps({root,revision:1,include:()=>true,
            maxObjects:4,maxVertices:16,maxTriangles:8}));
        vm.runInContext('activePlannerState={supportRead};',context);
        for(const [x,z,y]of [[60,0,-10],[60,0,10],[60,0,-20],[61.01,0,-10]]) {
            const expected=new THREE.Raycaster(new THREE.Vector3(x,y+1.75,z),new THREE.Vector3(0,-1,0))
                .intersectObject(root,true)[0]?.point.y??null;
            assert.equal(context.getPlannerSubsurfaceWalkFloorY(x,z,y),expected,`${x},${z},${y}`);
        }
    }finally{root.traverse(mesh=>mesh.geometry?.dispose());material.dispose();}
});
