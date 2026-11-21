import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { readFileSync } from 'node:fs';
import { createSurfaceOpeningTopologySteps } from '../core/surface-opening-topology.js';
import { clipReceiverGeometrySteps } from '../core/terrain-receiver-topology.js';
import { clipReceiverOpeningsSteps } from '../core/receiver-opening-geometry.js';
import { captureAuthoredOpeningRegions, captureEntranceOpeningRegionsSteps } from '../core/surface-opening-shapes.js';
import { createTerrainCutoutTopologySteps } from '../core/terrain-cutout-topology.js';

const limits = { maxRegions:128, maxSourceVertices:2048, maxCandidates:16, maxFragments:256 };
const drain = steps => { for (;;) { const next=steps.next(); if(next.done)return next.value; } };
const point = (x,y,z) => ({x,y,z});
const box = (minX,minZ,maxX,maxZ,minY,maxY) => ({
    ring:[{x:minX,z:minZ},{x:maxX,z:minZ},{x:maxX,z:maxZ},{x:minX,z:maxZ}],minY,maxY,
});
const build = (regions,options={}) => drain(createSurfaceOpeningTopologySteps({regions,limits,...options}));
const clip = (topology,triangle) => {const result=drain(topology.clipTriangleSteps(...triangle)); return result.unchanged?[triangle]:result.triangles;};
const area = triangles => triangles.reduce((total,[a,b,c])=>total+Math.hypot(
    (b.y-a.y)*(c.z-a.z)-(b.z-a.z)*(c.y-a.y),
    (b.z-a.z)*(c.x-a.x)-(b.x-a.x)*(c.z-a.z),
    (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x))*.5,0);
const wall = [
    [point(-2,0,0),point(2,0,0),point(2,4,0)],
    [point(-2,0,0),point(2,4,0),point(-2,4,0)],
];
const clock = () => {let time=0;return()=>time+=.3;};
const wallGeometry = () => ({positions:new Float32Array(wall.flatMap(face=>face.flatMap(p=>[p.x,p.y,p.z]))),
    indices:new Uint32Array([0,1,2,3,4,5])});

test('captured Grič zero-area source connectors survive around clipped faces without inventing support',async()=>{
    const fixture=JSON.parse(readFileSync(new URL('./fixtures/ground-gric-degenerate-sidewalk.json',import.meta.url),'utf8'));
    const topology=build(fixture.regions);
    assert.deepEqual(fixture.triangle[1],fixture.triangle[2]);
    // Existing zero-area faces can connect the indexed boundaries of refined
    // road rings. Keep their indices; removing them changes that connectivity.
    const floor=[point(0,0,0),point(24,0,0),point(0,0,8)];
    const positions=new Float32Array([...fixture.triangle,...floor,...fixture.triangle].flatMap(p=>[p.x,p.y,p.z]));
    const original=positions.slice();
    for(const indices of [null,new Uint32Array([0,1,2,3,4,5,6,7,8])]) {
        const receiver=drain(clipReceiverGeometrySteps({geometry:{positions,indices},topology,maxVertices:256,maxTriangles:256}));
        assert.equal(receiver.topology.degenerateSourceTriangles,2);
        assert.equal(receiver.topology.changedTriangles,1);
        assert.deepEqual([...receiver.indices.slice(0,3)],[0,1,2]);
        assert.deepEqual([...receiver.indices.slice(-3)],[6,7,8]);
        assert.equal(receiver.sourceTriangleOffsets[1],3);
        assert.equal(receiver.sourceTriangleOffsets[3]-receiver.sourceTriangleOffsets[2],3);
        assert.deepEqual(positions,original);
        await RAPIER.init();const world=new RAPIER.World({x:0,y:0,z:0});
        const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(receiver.positions,3));
        geometry.setIndex(new THREE.BufferAttribute(receiver.indices,1));
        const material=new THREE.MeshBasicMaterial({side:THREE.DoubleSide}),mesh=new THREE.Mesh(geometry,material);
        mesh.updateMatrixWorld(true);
        try {
            world.createCollider(RAPIER.ColliderDesc.trimesh(receiver.positions,receiver.indices));world.step();
            for(const [x,z,expected] of [[4,3,false],[1,.5,true],[9.668184280395508,-20.785112380981445,false]]) {
                const visible=new THREE.Raycaster(new THREE.Vector3(x,10,z),new THREE.Vector3(0,-1,0)).intersectObject(mesh)[0];
                const physical=world.castRay(new RAPIER.Ray({x,y:10,z},{x:0,y:-1,z:0}),20,true);
                assert.equal(!!visible,expected);assert.equal(!!physical,expected);
                if(expected)assert.ok(Math.abs(visible.distance-physical.timeOfImpact)<.001);
            }
        } finally {world.free();geometry.dispose();material.dispose();}
    }
});

test('door opening cuts vertical walls and keeps the lintel in actual Three and Rapier geometry',async()=>{
    const topology=build([box(-.5,-1,.5,1,0,2.5)]);
    const triangles=wall.flatMap(triangle=>clip(topology,triangle));
    assert.equal(area(triangles),13.5);
    const receiver=drain(clipReceiverGeometrySteps({geometry:wallGeometry(),topology,maxVertices:128,maxTriangles:128}));
    const {positions,indices}=receiver;
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
    geometry.setIndex(new THREE.BufferAttribute(indices,1));
    const material=new THREE.MeshBasicMaterial({side:THREE.DoubleSide}),mesh=new THREE.Mesh(geometry,material);
    mesh.updateMatrixWorld(true);
    await RAPIER.init();const world=new RAPIER.World({x:0,y:0,z:0});
    try {
        world.createCollider(RAPIER.ColliderDesc.trimesh(positions,indices));world.step();
        for(const [x,y,expected]of [[0,1,false],[.49,2.49,false],[.51,2.49,true],[-1.5,1,true],[0,2.51,true],[0,3.5,true]]) {
            const visible=new THREE.Raycaster(new THREE.Vector3(x,y,5),new THREE.Vector3(0,0,-1)).intersectObject(mesh)[0];
            const physical=world.castRay(new RAPIER.Ray({x,y,z:5},{x:0,y:0,z:-1}),10,true);
            assert.equal(!!visible,expected,`visible (${x},${y})`);
            assert.equal(!!physical,expected,`physical (${x},${y})`);
            if(expected)assert.ok(Math.abs(visible.distance-physical.timeOfImpact)<.001);
        }
    } finally {world.free();geometry.dispose();material.dispose();}
});

test('height bounds preserve a deck above an opening and cut a sloped underside at its real plane',()=>{
    const topology=build([box(-10,-10,10,10,.5,1.5)]);
    const above=[point(0,3,0),point(4,3,0),point(0,3,4)];
    assert.equal(drain(topology.clipTriangleSteps(...above)).unchanged,true);
    const slope=[point(0,0,0),point(4,2,0),point(0,0,4)];
    const triangles=clip(topology,slope);
    // y=x/2; remove x in [1,3] from the right triangle, area ratio 1/2.
    assert.ok(Math.abs(area(triangles)-area([slope])*.5)<1e-12);
    for(const face of triangles)for(const p of face) {
        assert.ok(Math.abs(p.y-p.x/2)<1e-12);
        assert.ok(Math.abs(p.weights.reduce((a,b)=>a+b,0)-1)<1e-12);
        for(const key of ['x','y','z'])assert.ok(Math.abs(p[key]-p.weights.reduce((s,w,i)=>s+w*slope[i][key],0))<1e-12);
    }
});

test('union of overlapping opening volumes removes each part once and keeps an intentional island',()=>{
    const floor=[
        [point(0,0,0),point(4,0,0),point(4,0,4)],
        [point(0,0,0),point(4,0,4),point(0,0,4)],
    ];
    const regions=[box(0,0,4,1,-1,1),box(0,3,4,4,-1,1),box(0,0,1,4,-1,1),box(3,0,4,4,-1,1)];
    const topology=build(regions),triangles=floor.flatMap(t=>clip(topology,t));
    assert.ok(Math.abs(area(triangles)-4)<1e-12);
    for(const face of triangles)for(const p of face)assert.ok(p.x>=1&&p.x<=3&&p.z>=1&&p.z<=3);
    const reversed=build(regions.toReversed().map(r=>({...r,ring:r.ring.toReversed()})));
    assert.ok(Math.abs(area(floor.flatMap(t=>clip(reversed,t)))-4)<1e-12);
});

test('adjacent oppositely wound source edges intersect an oblique prism at identical coordinates',()=>{
    const topology=build([{ring:[{x:-1,z:.123},{x:3,z:.713},{x:3,z:1.819},{x:-1,z:1.229}],minY:-1,maxY:1}]);
    const a=point(0,0,0),b=point(2,0,2),left=[a,b,point(0,0,2)],right=[b,a,point(2,0,0)];
    const boundary=t=>new Set(clip(topology,t).flat().filter(p=>Math.abs(p.x-p.z)<1e-12&&p.x>0&&p.x<2).map(p=>`${p.x},${p.y},${p.z}`));
    assert.deepEqual(boundary(left),boundary(right));
    assert.equal(boundary(left).size,2);
});

test('tangency keeps original triangles and captured regions do not alias mutable source data',()=>{
    const region=box(-.5,-1,.5,1,0,2.5),topology=build([region]);
    region.ring[0].x=-100;region.maxY=100;
    const tangent=[point(.5,0,0),point(2,0,0),point(2,4,0)];
    assert.equal(drain(topology.clipTriangleSteps(...tangent)).unchanged,true);
    assert.equal(area(wall.flatMap(t=>clip(topology,t))),13.5);
});

test('source, local complexity and stale input limits reject complete cuts without mutating receivers',()=>{
    const source=structuredClone(wall),near=box(-.5,-1,.5,1,0,2.5);
    assert.throws(()=>build([near],{limits:{...limits,maxSourceVertices:3}}),{code:'ground-opening-capacity'});
    assert.throws(()=>build([{...near,ring:[{x:0,z:0},{x:2,z:0},{x:1,z:.2},{x:2,z:2},{x:0,z:2}]}]),{code:'ground-opening-shape'});
    const crowded=build([near,box(-1,-1,0,1,0,2)],{limits:{...limits,maxCandidates:1}});
    assert.throws(()=>clip(crowded,wall[0]),{code:'ground-opening-capacity'});
    const limited=build([near],{limits:{...limits,maxFragments:1}});
    assert.throws(()=>clip(limited,wall[0]),{code:'ground-opening-capacity'});
    let current=true;
    const topology=build([near],{now:clock(),isCurrent:()=>current}),steps=topology.clipTriangleSteps(...wall[0]);
    assert.equal(steps.next().done,false);current=false;
    assert.throws(()=>drain(steps),{code:'ground-opening-stale'});
    assert.deepEqual(wall,source);
});

test('distant volumes do not consume the local face budget or change receiver geometry',()=>{
    const far=Array.from({length:100},(_,i)=>box(1000+i*100,1000,1004+i*100,1004,0,10));
    const topology=build([...far,box(-.5,-1,.5,1,0,2.5)],{limits:{...limits,maxCandidates:1},now:clock()});
    assert.equal(area(wall.flatMap(t=>clip(topology,t))),13.5);
});

test('shared receiver adapter preserves UV/color seams and compacts buffers after a translated 3D cut',()=>{
    const geometry=wallGeometry(),uvs=[],colors=[],normals=[];
    for(let i=0;i<6;i++) {
        const x=geometry.positions[i*3],y=geometry.positions[i*3+1],seam=i>=3?10:0;
        uvs.push(x+seam,y);colors.push(y/4,.5,seam);normals.push(0,0,i>=3?-1:1);
    }
    Object.assign(geometry,{uvs:new Float32Array(uvs),colors:new Float32Array(colors),normals:new Float32Array(normals)});
    const original=structuredClone(geometry),origin={originX:4096,originY:30,originZ:-2048};
    const topology=build([box(4095.5,-2049,4096.5,-2047,30,32.5)]);
    const receiver=drain(clipReceiverGeometrySteps({geometry,topology,...origin,maxVertices:128,maxTriangles:128,now:clock()}));
    assert.deepEqual(geometry,original,'the active receiver retains its original arrays');
    assert.ok(receiver.topology.addedVertices>0);assert.equal(receiver.topology.changedTriangles,2);
    for(const values of [receiver.positions,receiver.indices,receiver.uvs,receiver.colors,receiver.normals]) {
        assert.equal(values.byteLength,values.buffer.byteLength,'capacity ceilings are not retained allocations');
    }
    for(let i=6;i<receiver.positions.length/3;i++) {
        const x=receiver.positions[i*3],y=receiver.positions[i*3+1],seam=receiver.normals[i*3+2]<0?10:0;
        assert.ok(Math.abs(receiver.uvs[i*2]-x-seam)<1e-6);
        assert.ok(Math.abs(receiver.uvs[i*2+1]-y)<1e-6);
        assert.ok(Math.abs(receiver.colors[i*3]-y/4)<1e-6);
        assert.ok(Math.abs(receiver.colors[i*3+2]-seam)<1e-6);
    }
    const far=build([box(100,100,101,101,0,10)]);
    const unchanged=drain(clipReceiverGeometrySteps({geometry,topology:far,maxVertices:6,maxTriangles:2}));
    assert.equal(unchanged.positions,geometry.positions);assert.equal(unchanged.indices,geometry.indices);
    assert.equal(unchanged.uvs,geometry.uvs);assert.equal(unchanged.colors,geometry.colors);
});

test('shared receiver adapter rejects unrepresentable volume edges and preserves the active geometry on cancellation',()=>{
    const geometry=wallGeometry(),original=structuredClone(geometry);
    // A 1e-10 m lintel at y=4 cannot survive Float32 receiver storage.
    const tiny=build([box(-10,-1,10,1,-1,4-1e-10)]);
    assert.throws(()=>drain(clipReceiverGeometrySteps({geometry,topology:tiny,maxVertices:128,maxTriangles:128})),
        {code:'ground-topology-precision'});
    let current=true;
    const topology=build([box(-.5,-1,.5,1,0,2.5)]),steps=clipReceiverGeometrySteps({geometry,topology,
        maxVertices:128,maxTriangles:128,now:clock(),isCurrent:()=>current});
    assert.equal(steps.next().done,false);current=false;
    assert.throws(()=>drain(steps),{code:'ground-topology-stale'});
    assert.deepEqual(geometry,original);
});

test('transformed opening projection discards only numerical duplicate faces before Float32 storage',()=>{
    const geometry={positions:new Float32Array([0,0,0,2,0,0,0,0,2]),indices:new Uint32Array([0,1,2])};
    const topology={contract:'station3d-surface-opening-topology-v1',
        *intersectsBoundsSteps(){return true;},
        *clipTriangleSteps(){return {unchanged:false,triangles:[
            [
                {x:0,y:0,z:0,weights:[1,0,0]},
                {x:2,y:0,z:0,weights:[0,1,0]},
                {x:0,y:0,z:2,weights:[0,0,1]},
            ],
            [
                {x:1,y:0,z:1,weights:[.5,.25,.25]},
                {x:1,y:0,z:1,weights:[.5+1e-13,.25-1e-13,.25]},
                {x:1,y:0,z:1,weights:[0,.5,.5]},
            ],
        ]};},
    };
    const openingRead={contract:'station3d-surface-opening-read-v1',empty:false,isCurrent:()=>true,
        topologyForClaim:()=>topology};
    const result=drain(clipReceiverOpeningsSteps({geometry,openingRead,claim:{},
        worldMatrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],maxVertices:32,maxTriangles:32,now:clock()}));
    assert.equal(result.indices.length,3,'the zero-width projection fragment is not stored as a face');
    assert.deepEqual([...result.indices],[0,1,2]);
});

test('authored boxes retain exact world bounds and capsule boundaries obey their meter error budget',()=>{
    const source=[{minX:-1,minZ:-2,maxX:3,maxZ:4,minY:-5,maxY:6}];
    const authored=captureAuthoredOpeningRegions(source,8);source[0].minX=-100;
    assert.deepEqual(authored[0],{
        ...box(-1,-2,3,4,-5,6),bounds:{minX:-1,minZ:-2,maxX:3,maxZ:4},
    });
    for(const [x1,z1,x2,z2,widthM]of [[1,2,1,2,2.1],[1,2,9,11,2.1],[-240,128,-253,122,4.8]]) {
        const cut={x1,z1,x2,z2,widthM},radius=widthM*.5,error=.00025;
        const regions=drain(captureEntranceOpeningRegionsSteps([cut],{maxCuts:16,maxVertices:4096,chordErrorM:error,now:clock()}));
        assert.equal(Object.isFrozen(regions[0].ring),true);
        const distance=p=>{const dx=x2-x1,dz=z2-z1,d2=dx*dx+dz*dz;
            const t=d2?Math.max(0,Math.min(1,((p.x-x1)*dx+(p.z-z1)*dz)/d2)):0;
            return Math.hypot(p.x-x1-t*dx,p.z-z1-t*dz);};
        const ring=regions[0].ring;
        for(let i=0;i<ring.length;i++) {
            const a=ring[i],b=ring[(i+1)%ring.length];
            assert.ok(Math.abs(distance(a)-radius)<1e-12);
            const midpoint={x:(a.x+b.x)/2,z:(a.z+b.z)/2};
            assert.ok(radius-distance(midpoint)<=error+1e-12,'chords cannot widen the hole or lose more than the stated boundary tolerance');
        }
        build(regions,{limits:{...limits,maxSourceVertices:4096}});
    }
    assert.throws(()=>drain(captureEntranceOpeningRegionsSteps([{x1:0,z1:0,x2:5,z2:0,widthM:2}],
        {maxCuts:16,maxVertices:8,chordErrorM:.00025})),{code:'ground-opening-capacity'});
});

test('the strict planner height ceiling preserves a coplanar roof in both surface and terrain topology',()=>{
    const regions=drain(captureEntranceOpeningRegionsSteps([{x1:-2,z1:0,x2:2,z2:0,widthM:8}],
        {maxCuts:16,maxVertices:4096,chordErrorM:.00025}));
    const terrainLimits={maxSources:16,maxSourceVertices:4096,maxIndexEntries:32768,
        maxCellCandidates:16,maxOperandVertices:4096,maxIntersections:4096,maxOutputTriangles:4096};
    const roof=[point(-1,1,-1),point(1,1,-1),point(0,1,1)];
    for(const topology of [build(regions,{limits:{...limits,maxSourceVertices:4096}}),
        drain(createTerrainCutoutTopologySteps({layers:[{operation:'subtract',regions}],limits:terrainLimits}))]) {
        assert.equal(drain(topology.clipTriangleSteps(...roof)).unchanged,true);
        assert.deepEqual(drain(topology.clipTriangleSteps(...roof.map(p=>({...p,y:.999})))).triangles,[]);
    }
});
