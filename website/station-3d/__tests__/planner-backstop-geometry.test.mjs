// Compare complete cut polygons with actual upward faces, including the wall
// tops. The frozen geometry demonstrates the previously unbacked outer strip.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import vm from 'node:vm';
import {createPlannerGeometryRuntime,plannerFixtureSegments} from './fixtures/planner-geometry-runtime.mjs';
import {captureReceiverMeshReadSteps} from '../core/receiver-mesh-read.js';
import {capturePlannerOpeningRegionsSteps} from '../core/planner-opening-boundaries.js';
import {createSurfaceOpeningTopologySteps} from '../core/surface-opening-topology.js';
import {createReceiverSupportQuerySteps} from '../core/receiver-support-read.js';
import {createSurfaceOpeningReadSteps} from '../core/surface-opening-read.js';
import {compileSurfaceClaim,SURFACE_CLASS,SURFACE_COVERAGE_STATE,SURFACE_VERTICAL_RELATION} from '../core/surface-hierarchy.js';
import {disposeGroup,registerShared} from '../core/dispose.js';
import {DEG_TO_RAD,EARTH_RADIUS_M} from '../core/math.js';
const before=JSON.parse(readFileSync(new URL('./fixtures/planner-backstop-before.json',import.meta.url)));
const finish=steps=>{try{for(;;){const next=steps.next();if(next.done)return next.value;}}finally{steps.return();}};
function upwardRegions(surfaces){
    const regions=[];
    for(const {positions:p,indices} of surfaces){
        const count=indices?.length??p.length/3;
        for(let i=0;i<count;i+=3){
            const [a,b,c]=[0,1,2].map(j=>(indices?.[i+j]??i+j)*3);
            const up=(p[b+2]-p[a+2])*(p[c]-p[a])-(p[b]-p[a])*(p[c+2]-p[a+2]);
            if(up>0)regions.push({ring:[a,b,c].map(k=>({x:p[k],z:p[k+2]})),minY:null,maxY:null});
        }
    }
    return regions;
}
const area=([a,b,c])=>Math.abs((b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x))*.5;
function unsupportedArea(cuts,surfaces){
    const regions=finish(capturePlannerOpeningRegionsSteps(cuts,{maxCuts:128,maxRegions:128,maxVertices:512}));
    const support=finish(createSurfaceOpeningTopologySteps({regions:upwardRegions(surfaces),
        limits:{maxRegions:512,maxSourceVertices:2048,maxCandidates:256,maxFragments:2048}}));
    let remaining=0,perimeter=0;
    for(const {ring} of regions){
        for(let i=0;i<ring.length;i++)perimeter+=Math.hypot(ring[i].x-ring[(i+1)%ring.length].x,ring[i].z-ring[(i+1)%ring.length].z);
        for(let i=1;i+1<ring.length;i++){
            const face=[ring[0],ring[i],ring[i+1]].map(p=>({...p,y:0}));
            const clipped=finish(support.clipTriangleSteps(...face));
            remaining+=(clipped.unchanged?[face]:clipped.triangles).reduce((sum,tri)=>sum+area(tri),0);
        }
    }
    return {remaining,perimeter};
}
const capture=root=>finish(captureReceiverMeshReadSteps({root,include:mesh=>/Floors|Walls/.test(mesh.name),
    revision:1,maxObjects:8192,maxVertices:262144,maxTriangles:131072}));

test('the complete straight and bent ramp openings have concrete backstops through their outer edges',()=>{
    for(const fixture of before.fixtures){
        const old=unsupportedArea(fixture.cuts,fixture.surfaces);
        assert.ok(old.remaining>5,`${fixture.name}: frozen unbacked area ${old.remaining}`);
        const {context}=createPlannerGeometryRuntime();
        const root=finish(context.buildPlannerGeometrySteps(fixture.features,45,16,plannerFixtureSegments(fixture.features),[],{}));
        try{
            const read=capture(root),actual=unsupportedArea(fixture.cuts,read.surfaces);
            // Independent clipping includes Float32 mesh storage, whose
            // common engine contract permits at most a 1 mm boundary error.
            assert.ok(actual.remaining<actual.perimeter*.001,`${fixture.name}: unbacked area ${actual.remaining}`);
            if(fixture.name==='descending'){
                assert.equal(finish(createReceiverSupportQuerySteps(fixture.surfaces))(60,3.69,{maxY:.9}),null);
                assert.ok(Math.abs(read.supportYAt(60,3.69,{maxY:.9})+5.05)<1e-6);
            }
        }finally{disposeGroup(root);}
    }
});

test('continuous tunnel foundations preserve station shell gaps and release private textures on cancellation',()=>{
    const metres=DEG_TO_RAD*EARTH_RADIUS_M,scale=metres*Math.cos(45*DEG_TO_RAD);
    const features=[{type:'Feature',properties:{source:'user'},geometry:{type:'LineString',coordinates:[[16,45,-10],[16+400/scale,45,-10]]}}];
    const {context}=createPlannerGeometryRuntime();
    const root=finish(context.buildPlannerGeometrySteps(features,45,16,plannerFixtureSegments(features),[{lng:16+200/scale,lat:45,level:-1}],{}));
    try{
        const read=capture(root);assert.equal(read.supportYAt(200,0,{maxY:0}),null);
        assert.ok(Math.abs(read.supportYAt(20,0,{maxY:0})+10.05)<1e-5);
        assert.ok(Math.abs(read.supportYAt(380,0,{maxY:0})+10.05)<1e-5);
    }finally{disposeGroup(root);}
    const tracked=createPlannerGeometryRuntime({trackResources:true});
    const shared=new THREE.Texture(),clones=[];registerShared(shared);
    const clone=shared.clone.bind(shared);shared.clone=()=>{
        const texture=clone(),record={texture,disposed:0};clones.push(record);
        texture.addEventListener('dispose',()=>record.disposed++);return texture;
    };
    tracked.context.concrete=shared;vm.runInContext('getConcreteTexture=()=>concrete;',tracked.context);
    let time=0;
    const steps=tracked.context.buildPlannerGeometrySteps(features,45,16,plannerFixtureSegments(features),[],{preparation:{now:()=>time+=1}});
    try{for(;;){const next=steps.next();assert.equal(next.done,false);if(next.value.phase==='planner-floor-uv')break;}}
    finally{steps.return();shared.dispose();}
    assert.equal(clones.length,1);assert.equal(clones[0].disposed,1);
    for(const [resource,count] of tracked.resources)assert.equal(count,1,resource.type);
});

test('every emitted ramp opening starts on an actual stored floor face and preserves ground below it',()=>{
    const claim=compileSurfaceClaim({surfaceClass:SURFACE_CLASS.TERRAIN,
        coverageState:SURFACE_COVERAGE_STATE.PUBLISHED,verticalRelation:SURFACE_VERTICAL_RELATION.SAME_LEVEL});
    for(const fixture of before.fixtures){
        const {context}=createPlannerGeometryRuntime();
        const root=finish(context.buildPlannerGeometrySteps(fixture.features,45,16,plannerFixtureSegments(fixture.features),[],{}));
        try{
            const read=capture(root),regions=root.userData.plannerOpeningRegions;
            assert.ok(regions.length>=2);
            const openings=finish(createSurfaceOpeningReadSteps({planner:regions,
                limits:{maxRegions:512,maxSourceVertices:2048,maxCandidates:256,maxFragments:2048}}));
            for(const region of regions){
                const x=region.ring.reduce((sum,p)=>sum+p.x,0)/3,z=region.ring.reduce((sum,p)=>sum+p.z,0)/3;
                const floor=read.supportYAt(x,z,{maxY:0});assert.ok(Number.isFinite(floor));
                const p=region.minPlane,y=p.y+(x-p.x)*p.slopeX+(z-p.z)*p.slopeZ;
                assert.ok(Math.abs(y-floor)<1e-6);
                assert.equal(openings.contains(x,y-.001,z,claim),false);
                assert.equal(openings.contains(x,y+.001,z,claim),true);
            }
        }finally{disposeGroup(root);}
    }
});
