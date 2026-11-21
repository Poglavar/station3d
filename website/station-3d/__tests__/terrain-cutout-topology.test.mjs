// Preserve actual opening boundaries, including the failures hidden by point sampling.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import * as polyclip from 'polyclip-ts';
import {orient2d} from 'robust-predicates';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {createTerrainCutoutTopologySteps} from '../core/terrain-cutout-topology.js';
import {pointInRing,pointInRingNonZero} from '../core/mask-query.js';
import {buildFormationTerrainCutoutQuery} from '../core/formation-terrain-cutout-query.js';
import {clipReceiverGeometrySteps} from '../core/terrain-receiver-topology.js';
import {buildTerrainReceiverSupportSteps} from '../core/terrain-receiver-support.js';
import {clipRingToWindow,clipRingToWindowSteps} from '../core/render-budgets.js';

const limits={maxSources:256,maxSourceVertices:32768,maxIndexEntries:262144,maxCellCandidates:128,maxOperandVertices:256,maxIntersections:64,maxOutputTriangles:256};
const supportLimits={maxTiles:4,maxSourceCells:256,maxTriangles:256,maxMeshes:256,maxTrianglesPerMesh:3};
const drain=steps=>{for(;;){const next=steps.next();if(next.done)return next.value;}};
const clock=()=>{let time=0;return()=>time+=.3;};
const ring=points=>points.map(([x,z])=>({x,z}));
const rect=(x0,z0,x1,z1)=>ring([[x0,z0],[x1,z0],[x1,z1],[x0,z1]]);
const triangle=ring([[0,0],[6,0],[0,6]]);
const big=rect(-1,-1,7,7),small=rect(.8,.8,1.2,1.2);
const layer=(operation,...rings)=>({operation,regions:rings.map(ring=>({ring}))});
const build=(layers,options={})=>drain(createTerrainCutoutTopologySteps({layers,limits,...options}));
const clipped=(topology,points=triangle,options={})=>drain(topology.clipTriangleSteps(...points,options));
const cross=(a,b,c)=>(b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x);
const area=triangles=>triangles.reduce((sum,t)=>sum+Math.abs(cross(...t))*.5,0);
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} differs from ${b}`);
const covers=(triangles,x,z)=>triangles.some(([a,b,c])=>{
    const p={x,z},signs=[cross(a,b,p),cross(b,c,p),cross(c,a,p)];
    return signs.every(s=>s>=-1e-10)||signs.every(s=>s<=1e-10);
});

test('small openings and protected islands survive between the former seven test points',()=>{
    const opening=clipped(build([layer('subtract',small)]));
    assert.equal(opening.unchanged,false);near(area(opening.triangles),18-.16);
    assert.equal(covers(opening.triangles,1,1),false);assert.equal(covers(opening.triangles,3,1),true);
    const island=clipped(build([layer('subtract',big),layer('restore',small)]));
    assert.equal(island.unchanged,false);near(area(island.triangles),.16);
    assert.equal(covers(island.triangles,1,1),true);assert.equal(covers(island.triangles,3,1),false);
});

test('region holes preserve the island while independent later cuts still apply',()=>{
    const donut = clipped(build([{operation:'subtract',regions:[{ring:big,holeRings:[small]}]}]));
    near(area(donut.triangles),.16);
    assert.equal(covers(donut.triangles,1,1),true);
    const cut = clipped(build([{operation:'subtract',regions:[{ring:big,holeRings:[small]}]},
        layer('subtract',rect(.95,.7,1.05,1.3))]));
    assert.equal(covers(cut.triangles,1,1),false);
});

test('ordered restorations, later portal cuts and region clipping preserve ownership',()=>{
    const slit=rect(.95,.7,1.05,1.3);
    const result=clipped(build([layer('subtract',big),layer('restore',small),layer('subtract',slit)]));
    near(area(result.triangles),.12);assert.equal(covers(result.triangles,1,1),false);
    assert.equal(covers(result.triangles,.85,1),true);
    const constrained=clipped(build([{operation:'subtract',regions:[{ring:big,clipRings:[small]}]}]));
    near(area(constrained.triangles),17.84);assert.equal(covers(constrained.triangles,1,1),false);
});

test('prepared physical receivers cut after roof restoration and keep their own holes local',()=>{
    const receiver={ring:rect(0,0,5,5),holeRings:[rect(1,1,2,2)]};
    const query=buildFormationTerrainCutoutQuery({models:[{
        getReplacementTerrainCutoutRegions:()=>[{clearRing:big,cutoutRing:rect(1.4,1.4,1.6,1.6)}],
    }],receiverRegions:[receiver],centerX:0,centerZ:0,radiusM:100});
    assert.equal(query.receiverRingCount,1);
    const result=clipped(build(query.layers));
    for(const [x,z,cut]of [[.5,.5,true],[1.2,1.2,false],[1.5,1.5,true],[.25,5.5,false]]) {
        assert.equal(query.contains(x,z),cut);
        assert.equal(covers(result.triangles,x,z),!cut);
    }
    receiver.holeRings[0][0].x=-100;
    assert.equal(query.contains(1.2,1.2),false,'query owns detached boundary evidence');
});

test('a height-bounded opening clips the sloped source face and preserves decks outside its volume',()=>{
    const points=[{x:0,y:0,z:0},{x:6,y:6,z:0},{x:0,y:0,z:6}];
    const topology=build([{operation:'subtract',regions:[{ring:big,minY:2,maxY:4}]}]);
    const result=clipped(topology,points);
    near(area(result.triangles),12); // integral of (6-x) from x=2 to x=4 removes 6 m².
    for(let x=.071;x<6;x+=.137)for(let z=.053;z<6;z+=.149) {
        const expected=x+z<=6+1e-10&&(x<2||x>4);
        assert.equal(covers(result.triangles,x,z),expected,`volume coverage ${x},${z}`);
    }
    for(const offset of [-10,10])assert.deepEqual(clipped(topology,points.map(p=>({...p,y:p.y+offset}))),
        {unchanged:true,triangles:null},'the same footprint cannot erase a different deck');
    assert.throws(()=>clipped(topology,triangle),{code:'ground-topology-coordinate'});
    for(const bounds of [{minY:2,maxY:2},{minY:Infinity},{maxY:NaN}]) {
        assert.throws(()=>build([{operation:'subtract',regions:[{ring:big,...bounds}]}]),{code:'ground-topology-source'});
    }
    const restored=clipped(build([layer('subtract',big),
        {operation:'restore',regions:[{ring:big,minY:2,maxY:4}]}]),points);
    near(area(restored.triangles),6);
    assert.equal(covers(restored.triangles,3,1),true);
    assert.equal(covers(restored.triangles,1,1),false);
});

test('height and polygon clips compose on the real receiver with unchanged interpolated support heights',()=>{
    const positions=new Float32Array([0,0,0,0,0,6,6,6,0]);
    const geometry={positions,indices:new Uint32Array([0,1,2])};
    const topology=build([{operation:'subtract',regions:[{ring:big,
        clipRings:[rect(1,1,5,3)],minY:2,maxY:4}]}]);
    const receiver=drain(clipReceiverGeometrySteps({geometry,topology,maxVertices:128,maxTriangles:128}));
    const faces=[];
    for(let offset=0;offset<receiver.indices.length;offset+=3) {
        faces.push([...receiver.indices.slice(offset,offset+3)].map(i=>({x:receiver.positions[i*3],z:receiver.positions[i*3+2]})));
    }
    for(let i=0;i<receiver.positions.length;i+=3)near(receiver.positions[i+1],receiver.positions[i]);
    for(let x=.071;x<6;x+=.137)for(let z=.053;z<6;z+=.149) {
        const expected=x+z<=6+1e-10&&!(x>=2&&x<=4&&z>=1&&z<=3);
        assert.equal(covers(faces,x,z),expected,`stored receiver ${x},${z}`);
    }
    assert.deepEqual(positions,new Float32Array([0,0,0,0,0,6,6,6,0]),'captured source remains unchanged');
});

test('empty and fully restored regions return the original lattice triangle unchanged',()=>{
    for(const layers of [[],[layer('subtract',rect(50,50,60,60))],
        [layer('subtract',small),layer('restore',big)]]) {
        assert.deepEqual(clipped(build(layers)),{unchanged:true,triangles:null});
    }
    assert.deepEqual(clipped(build([layer('subtract',big)])),{unchanged:false,triangles:[]});
});

test('winding agrees with Canvas nonzero even when an overlapping loop has even parity',()=>{
    const double=[...small,...small];
    assert.equal(pointInRing(1,1,double),false);
    assert.equal(pointInRingNonZero(1,1,double),true);
    const result=clipped(build([layer('subtract',double)]));near(area(result.triangles),17.84);
    assert.equal(covers(result.triangles,1,1),false);
});

test('a self-crossing path through the four window corners is not a full-cell cut',()=>{
    const crossed=ring([[0,0],[6,6],[6,0],[0,6]]);
    const result=clipped(build([layer('subtract',crossed)]));near(area(result.triangles),9);
    assert.equal(covers(result.triangles,.5,1),false);
    assert.equal(covers(result.triangles,2,1),true);
});

test('normalized stars and crossing paths preserve coverage and have no collinear T-junctions',()=>{
    const points=ring([[-12,-12],[12,-12],[0,12]]);
    const cases=[
        Array.from({length:100},(_,i)=>{const angle=i*Math.PI*2/100,r=i%2?5:9;
            return {x:r*Math.cos(angle),z:r*Math.sin(angle)};}),
        ring([[-8,-8],[8,8],[-8,8],[8,-8]]),
        ring([[-9,-8],[9,8],[-9,8],[9,-8],[-7,-6],[7,6]]),
    ];
    for(const source of cases) {
        const result=clipped(build([layer('subtract',source)]),points);
        assert.equal(result.unchanged,false);
        for(let x=-11.83;x<12;x+=.71)for(let z=-11.79;z<12;z+=.73) {
            const expected=covers([points],x,z)&&!pointInRingNonZero(x,z,source);
            assert.equal(covers(result.triangles,x,z),expected,`coverage at ${x},${z}`);
        }
        const vertices=result.triangles.flat();
        for(const face of result.triangles)for(let edge=0;edge<3;edge++) {
            const a=face[edge],b=face[(edge+1)%3];
            for(const p of vertices) {
                if((p.x===a.x&&p.z===a.z)||(p.x===b.x&&p.z===b.z))continue;
                if(p.x<Math.min(a.x,b.x)||p.x>Math.max(a.x,b.x)
                    ||p.z<Math.min(a.z,b.z)||p.z>Math.max(a.z,b.z))continue;
                assert.notEqual(orient2d(a.x,a.z,b.x,b.z,p.x,p.z),0,'unresolved collinear mesh junction');
            }
        }
    }
});

test('production query and topology consume the same immutable formation and restoration layers',()=>{
    const model={getSurfaceProfiles:()=>[{innerRing:big,terrainCutoutDisabled:false,formationDressingDisabled:true}],
        getReplacementTerrainCutoutRegions:()=>[{clearRing:small}]};
    const query=buildFormationTerrainCutoutQuery({models:[model],centerX:0,centerZ:0,radiusM:20});
    const result=clipped(build(query.layers));near(area(result.triangles),.16);
    for(const [x,z] of [[1,1],[2,1],[.1,.1]])assert.equal(covers(result.triangles,x,z),!query.contains(x,z));
    assert.throws(()=>{query.layers[0].regions[0].ring[0].x=20;},TypeError);
    const double=[...small,...small];
    const loop=buildFormationTerrainCutoutQuery({models:[{getReplacementTerrainCutoutRegions:()=>[{cutoutRing:double}]}],centerX:0,centerZ:0,radiusM:20});
    assert.equal(loop.contains(1,1),true);assert.equal(covers(clipped(build(loop.layers)).triangles,1,1),false);
});

test('concave window clipping normalizes disconnected components before triangulation',()=>{
    const u=ring([[-4,-4],[4,-4],[4,4],[2,4],[2,-2],[-2,-2],[-2,4],[-4,4]]);
    const windowed=clipRingToWindow(u,0,2,3);
    const exact=polyclip.intersection([u.map(p=>[p.x,p.z])],[[[-3,-1],[3,-1],[3,5],[-3,5]]]);
    assert.equal(exact.length,2);
    assert.deepEqual(polyclip.union([windowed.map(p=>[p.x,p.z])]),exact);
    const tri=ring([[-3,-1],[3,-1],[0,5]]),result=clipped(build([layer('subtract',u)]),tri);
    assert.equal(covers(result.triangles,0,1),true);
    assert.equal(covers(result.triangles,-2.5,-.5),false);
});

test('source capture detaches coordinates and simultaneous triangle builders cannot overwrite scratch',()=>{
    const source=structuredClone(small),topology=build([layer('subtract',source)]);
    source.forEach(p=>{p.x+=100;});
    const left=topology.clipTriangleSteps(...triangle,{now:clock()});
    const other=triangle.map(p=>({x:p.x+100,z:p.z}));
    const right=topology.clipTriangleSteps(...other,{now:clock()});
    let a,b;
    do {if(!a?.done)a=left.next();if(!b?.done)b=right.next();} while(!a.done||!b.done);
    near(area(a.value.triangles),17.84);assert.deepEqual(b.value,{unchanged:true,triangles:null});
});

test('rebase keeps small hole topology and boundary positions within double precision',()=>{
    for(const shift of [0,2000,100000]) {
        const moved=small.map(p=>({x:p.x+shift,z:p.z-shift}));
        const tri=triangle.map(p=>({x:p.x+shift,z:p.z-shift}));
        const result=clipped(build([layer('subtract',moved)]),tri);
        near(area(result.triangles),17.84);assert.equal(covers(result.triangles,shift+1,1-shift),false);
    }
});

test('capacity and stale input reject candidates instead of returning partial topology',()=>{
    assert.throws(()=>build([layer('subtract',small)],{limits:{...limits,maxSourceVertices:3}}),{code:'ground-topology-capacity'});
    assert.throws(()=>build([layer('subtract',small)],{limits:{...limits,maxIndexEntries:1}}),{code:'ground-topology-capacity'});
    const top=build([layer('subtract',small)],{limits:{...limits,maxOperandVertices:3}});
    assert.throws(()=>clipped(top),{code:'ground-topology-capacity'});
    let current=true;
    const steps=build([layer('subtract',small)]).clipTriangleSteps(...triangle,{now:clock(),isCurrent:()=>current});
    assert.equal(steps.next().done,false);current=false;
    assert.throws(()=>steps.next(),{code:'ground-topology-stale'});
    let reads=0;current=true;
    const watched=Array.from({length:1000},(_,i)=>({get x(){reads++;return i;},z:i%2}));
    const clip=clipRingToWindowSteps(watched,0,0,10,{now:clock(),isCurrent:()=>current});
    assert.equal(clip.next().done,false);const stopped=reads;current=false;
    assert.throws(()=>clip.next(),{code:'ground-topology-stale'});assert.equal(reads,stopped);
});

test('complex owners use indexed containment for interior cells without entering Boolean clipping',()=>{
    const owner=Array.from({length:512},(_,i)=>({x:1000*Math.cos(i*Math.PI/256),z:1000*Math.sin(i*Math.PI/256)}));
    const topology=build([layer('subtract',owner)],{limits:{...limits,maxOperandVertices:3}});
    assert.deepEqual(clipped(topology),{unchanged:false,triangles:[]});
    const cancelled=[...owner,...owner.slice().reverse()];
    assert.deepEqual(clipped(build([layer('subtract',cancelled)],{limits:{...limits,maxOperandVertices:3}})),
        {unchanged:true,triangles:null});
});

function receiver() {
    return {positions:new Float32Array([0,3,0,6,4.2,0,0,4.8,6,6,8,6]),
        normals:new Float32Array([0,1,0,0,1,0,0,1,0,0,1,0]),
        uvs:new Float32Array([0,0,12,0,0,18,12,18]),indices:new Uint32Array([0,2,1,1,2,3])};
}

test('receiver and real Rapier support have the same hole, island, heights and face orientation',async()=>{
    await RAPIER.init();
    for(const island of [false,true]) {
        const source=receiver(), original=source.positions.slice();
        const topology=build(island?[layer('subtract',big),layer('restore',small)]:[layer('subtract',small)]);
        const geometry=drain(clipReceiverGeometrySteps({geometry:source,topology,maxVertices:256,maxTriangles:256,now:clock()}));
        assert.deepEqual(source.positions,original);assert.ok(geometry.topology.addedVertices>0);
        const rendered=new THREE.BufferGeometry();
        rendered.setAttribute('position',new THREE.BufferAttribute(geometry.positions,3));rendered.setIndex(new THREE.BufferAttribute(geometry.indices,1));
        const mesh=new THREE.Mesh(rendered,new THREE.MeshBasicMaterial());mesh.updateMatrixWorld();
        const world=new RAPIER.World({x:0,y:-9.81,z:0});
        const support=drain(buildTerrainReceiverSupportSteps({tiles:[{tileX:0,tileZ:0,tileM:6,segments:1,receiver:geometry}],
            bounds:{minX:0,minZ:0,maxX:6,maxZ:6},limits:supportLimits,now:clock()}));
        assert.equal(support.triangles,geometry.indices.length/3);
        for(const chunk of support.meshes) {
            assert.ok(chunk.indices.length<=supportLimits.maxTrianglesPerMesh*3);
            world.createCollider(RAPIER.ColliderDesc.trimesh(chunk.vertices,chunk.indices));
        }
        world.step();
        for(const [x,z] of [[1,1],[2,1],[4,4]]) {
            const visible=new THREE.Raycaster(new THREE.Vector3(x,20,z),new THREE.Vector3(0,-1,0)).intersectObject(mesh)[0];
            const hit=world.castRay(new RAPIER.Ray({x,y:20,z},{x:0,y:-1,z:0}),40,true);
            const expected=island?x===1:x!==1;
            assert.equal(!!visible,expected);assert.equal(!!hit,expected);
            if(hit){assert.ok(Math.abs((20-hit.timeOfImpact)-visible.point.y)<1e-5);
                if(x+z<6)assert.ok(Math.abs(visible.point.y-(3+.2*x+.3*z))<1e-6);}
        }
        for(let i=source.positions.length/3;i<geometry.positions.length/3;i++) {
            assert.ok(Math.abs(geometry.uvs[i*2]-geometry.positions[i*3]*2)<1e-6);
            assert.ok(Math.abs(geometry.uvs[i*2+1]-geometry.positions[i*3+2]*3)<1e-6);
        }
        world.free();rendered.dispose();mesh.material.dispose();
    }
});

test('shared receiver compiler reuses unmodified buffers and rejects capacity/cancellation without changing input',()=>{
    const source=receiver(),topology=build([]);
    const same=drain(clipReceiverGeometrySteps({geometry:source,topology,maxVertices:4,maxTriangles:2}));
    assert.equal(same.positions,source.positions);assert.equal(same.indices,source.indices);assert.equal(same.topology.changedTriangles,0);
    const hole=build([layer('subtract',small)]), original=source.positions.slice();
    assert.throws(()=>drain(clipReceiverGeometrySteps({geometry:source,topology:hole,maxVertices:4,maxTriangles:32})),{code:'ground-topology-capacity'});
    assert.deepEqual(source.positions,original);
    let current=true;
    const steps=clipReceiverGeometrySteps({geometry:source,topology:hole,maxVertices:256,maxTriangles:256,now:clock(),isCurrent:()=>current});
    assert.equal(steps.next().done,false);current=false;assert.throws(()=>steps.next(),{code:'ground-topology-stale'});
    assert.deepEqual(source.positions,original);
});

test('terrain output transfers only used bytes as bounded buffers grow through many openings',()=>{
    const holes=Array.from({length:20},(_,i)=>{
        const x=.3+(i%5),z=.3+Math.floor(i/5);
        return rect(x,z,x+.2,z+.2);
    });
    const source=receiver(),original=structuredClone(source);
    const topology=build([layer('subtract',...holes)]);
    const geometry=drain(clipReceiverGeometrySteps({geometry:source,topology,
        maxVertices:1048576,maxTriangles:1048576,now:clock()}));
    assert.ok(geometry.positions.length/3>32,'vertex storage grew');
    assert.ok(geometry.indices.length/3>16,'triangle storage grew');
    for(const name of ['positions','normals','uvs','indices','sourceTriangleOffsets']) {
        assert.equal(geometry[name].buffer.byteLength,geometry[name].byteLength,`${name} retains no spare capacity`);
    }
    assert.deepEqual(source,original);
    const exact=drain(clipReceiverGeometrySteps({geometry:source,topology,
        maxVertices:geometry.positions.length/3,maxTriangles:geometry.indices.length/3}));
    for(const name of ['positions','normals','uvs','indices','sourceTriangleOffsets'])assert.deepEqual(exact[name],geometry[name]);
    assert.throws(()=>drain(clipReceiverGeometrySteps({geometry:source,topology,
        maxVertices:geometry.positions.length/3-1,maxTriangles:geometry.indices.length/3})),{code:'ground-topology-capacity'});
});

test('a coast collar triangle with a double-precision storage origin settles in the four passes',()=>{
    // The bounded counterexample the coordinator kept from Split's ferry port
    // (2026-09-16): a Float32-vertex collar triangle at the shore, a 2.6 m
    // stadium cut by a 0.59 m `steps` way (OSM 1303175757), and a storage
    // origin whose offset carries bits below the Boolean lattice. Rounding
    // and union alternated for ever and the port's ground was rejected on
    // every generation.
    const d=JSON.parse(readFileSync(new URL('./fixtures/split-port-collar-storage.json',import.meta.url),'utf8'));
    const hole=d.retained[0][1].map(([x,z])=>({x:x+d.originX,z:z+d.originZ}));
    const wide={...limits,maxOperandVertices:4096,maxIntersections:256,maxOutputTriangles:1024};
    const [a,b,c]=d.triangle;
    const clip=storageOrigin=>drain(drain(createTerrainCutoutTopologySteps({layers:[layer('subtract',hole)],limits:wide}))
        .clipTriangleSteps(a,b,c,{storageOrigin}));
    const stored=clip(d.storageOrigin);
    assert.equal(stored.unchanged,false);
    assert.ok(stored.triangles.length>=30,`the stadium is cut out of the collar (${stored.triangles.length} triangles)`);
    assert.equal(covers(stored.triangles,d.originX+2.6,d.originZ+2.7),false,'inside the steps');
    assert.equal(covers(stored.triangles,d.originX+1.2,d.originZ+2.7),true,'collar beside them');
    // The same clip at an exact offset is the reference; storage rounding must not change coverage.
    near(area(stored.triangles),area(clip({x:d.originX,z:d.originZ}).triangles));
});

test('a sub-tolerance opening is discarded as a sliver and local origins preserve precision',()=>{
    // An opening narrower than the storage contract's 0.2 mm is discarded, not an error (793f76b).
    const source=receiver(), tiny=rect(1,1,1+1e-9,1+1e-9);
    assert.deepEqual(drain(clipReceiverGeometrySteps({geometry:source,topology:build([layer('subtract',tiny)]),
        maxVertices:256,maxTriangles:256})).indices,source.indices);
    const offset=1000000;
    const shifted=small.map(p=>({x:p.x+offset,z:p.z-offset}));
    const local=drain(clipReceiverGeometrySteps({geometry:source,topology:build([layer('subtract',shifted)]),
        originX:offset,originZ:-offset,maxVertices:256,maxTriangles:256}));
    const nearOrigin=drain(clipReceiverGeometrySteps({geometry:source,topology:build([layer('subtract',small)]),
        maxVertices:256,maxTriangles:256}));
    assert.deepEqual(local.indices,nearOrigin.indices);
    for(let i=0;i<local.positions.length;i++)assert.ok(Math.abs(local.positions[i]-nearOrigin.positions[i])<1e-6);
});

test('an operand touching only the receiver boundary may collapse in its storage halo',()=>{
    // Captured at Kambelovac: the source triangle reaches the tile at one
    // boundary point. The 1 mm halo sees a microscopic sliver, but the actual
    // receiver has zero overlap area and therefore no opening to preserve.
    const source=ring([[1599.9510498046875,1198.8798828125],[1600,1600],
        [1600,1198.821533203125]]);
    const topology=build([layer('subtract',source)]);
    const bounds={minX:1200,minZ:1600,maxX:1600,maxZ:2000};
    const stored=drain(topology.prepareReceiverStorageSteps({bounds,storageOrigin:{x:1200,z:1600}}));
    const result=drain(stored.clipTriangleSteps(
        {x:1200,y:0,z:1600},{x:1200,y:0,z:2000},{x:1600,y:0,z:1600},
        {storageOrigin:{x:1200,z:1600}},
    ));
    assert.deepEqual(result,{unchanged:true,triangles:null});
});

test('the last allowed storage normalization may finish the boundary without a fifth repair',()=>{
    // Reduced from the real Split cell: several almost parallel road edges
    // become touching components after storage rounding. Operation four
    // already produces exact Float32 vertices; the former guard rejected it
    // before checking that result.
    const fixture=JSON.parse(readFileSync(new URL('./fixtures/terrain-storage-last-pass.json',import.meta.url),'utf8'));
    const topology=build(fixture.layers,{limits:{...limits,maxOperandVertices:512,maxIntersections:256,maxOutputTriangles:512}});
    const {triangle,storageOrigin}=fixture;
    const result=drain(topology.clipTriangleSteps(...triangle,{storageOrigin}));
    assert.ok(result.triangles.length>0);
    for(const face of result.triangles) {
        assert.ok(cross(...face)>0,'normalization preserves nonzero consistently wound faces');
        for(const p of face) {
            assert.equal(Math.fround(p.x-storageOrigin.x)+storageOrigin.x,p.x);
            assert.equal(Math.fround(p.z-storageOrigin.z)+storageOrigin.z,p.z);
        }
    }
    const geometry={positions:new Float32Array(triangle.flatMap(p=>[p.x-storageOrigin.x,p.y,p.z-storageOrigin.z])),
        indices:new Uint32Array([0,1,2])};
    const clipped=drain(clipReceiverGeometrySteps({geometry,topology,originX:storageOrigin.x,originZ:storageOrigin.z,
        maxVertices:256,maxTriangles:512}));
    for(let i=0;i<clipped.indices.length;i+=3) {
        const face=Array.from(clipped.indices.subarray(i,i+3),n=>({x:clipped.positions[n*3],z:clipped.positions[n*3+2]}));
        assert.ok(cross(...face)<0,'actual stored receiver faces remain upward');
    }
});

test('receiver triangulates rounded boundaries without collapsed ears or lost openings',()=>{
    // Both polygons previously reached the valid double-precision triangulation
    // and then failed when a sub-ULP concave ear collapsed in Float32 storage.
    for(const points of [
        [[.8,.8],[1.2,.8],[1.2,1.2],[1+1e-9,1.2],[1,1.2-1e-9],[.8,1.2]],
        [[.8,.8],[1.2,.8],[1.2,1.2],[1.2-1e-9,1.2-1e-9],[.8,1.2]],
    ]) {
        const source=receiver(),topology=build([layer('subtract',ring(points))]);
        const geometry=drain(clipReceiverGeometrySteps({geometry:source,topology,maxVertices:256,maxTriangles:256}));
        const faces=[];
        for(let offset=0;offset<geometry.indices.length;offset+=3) {
            const face=Array.from(geometry.indices.subarray(offset,offset+3),index=>({
                x:geometry.positions[index*3],z:geometry.positions[index*3+2]}));
            assert.ok(cross(...face)<0,'every stored face faces upward');faces.push(face);
        }
        assert.equal(covers(faces,1,1),false,'the real opening survives');
        assert.equal(covers(faces,.7,1),true);
        assert.equal(covers(faces,1.3,1),true);
        assert.ok(Math.abs(area(faces)-(36-.16))<1e-6,'no overlapping or missing receiver area');
    }
});

test('the production boundary validator rejects equal-area overlapping triangles',()=>{
    // Exercise the actual validator with deliberately corrupt triangulator
    // output. Two copies of half the square have the right total area but
    // cover the wrong ground; deleting boundary cancellation makes this fail.
    const source=readFileSync(new URL('../core/terrain-cutout-topology.js',import.meta.url),'utf8');
    const prefix=source.slice(0,source.indexOf('\nfunction* checkOperandsSteps'))
        .replace(/^import .*;\n/gm,'');
    const validate=runInNewContext(`${prefix}\ntriangulatePolygonSteps`,{
        earcut:()=>[0,1,2,0,1,2],
        orient2d,
    });
    const polygon=[[[0,0],[6,0],[6,6],[0,6],[0,0]]];
    assert.equal(2*Math.abs(cross(...ring([[0,0],[6,0],[6,6]])))/2,36);
    assert.throws(()=>drain(validate(polygon,{*step(){}},limits)),{code:'ground-topology-triangulation'});
});

test('support copies only requested source cells and distinguishes fully cut from missing coverage',()=>{
    const positions=new Float32Array(27),indices=[];
    for(let z=0;z<=2;z++)for(let x=0;x<=2;x++)positions.set([x,x+z,z],(z*3+x)*3);
    for(let z=0;z<2;z++)for(let x=0;x<2;x++) {
        const a=z*3+x,b=a+1,c=a+3,d=c+1;indices.push(a,c,b,b,c,d);
    }
    const source={positions,indices:new Uint32Array(indices)};
    const bounds={minX:1.1,minZ:1.1,maxX:1.9,maxZ:1.9};
    const config={...supportLimits,maxSourceCells:1};
    const makeTiles=geometry=>[{tileX:0,tileZ:0,tileM:2,segments:2,receiver:geometry}];
    for(const offset of [0,1]) {
        const cut=build([layer('subtract',rect(offset+.2,offset+.2,offset+.4,offset+.4))]);
        const geometry=drain(clipReceiverGeometrySteps({geometry:source,topology:cut,maxVertices:64,maxTriangles:64}));
        const support=drain(buildTerrainReceiverSupportSteps({tiles:makeTiles(geometry),bounds,limits:config,now:clock()}));
        assert.equal(support.visitedCells,1);
        assert.equal(support.triangles,(geometry.sourceTriangleOffsets[8]-geometry.sourceTriangleOffsets[6])/3);
        for(const mesh of support.meshes)for(let i=0;i<mesh.vertices.length;i+=3) {
            assert.ok(mesh.vertices[i]>=1&&mesh.vertices[i+2]>=1,'unrequested cells were copied');
            assert.ok(Math.abs(mesh.vertices[i+1]-mesh.vertices[i]-mesh.vertices[i+2])<1e-6);
        }
    }
    const empty=drain(clipReceiverGeometrySteps({geometry:source,topology:build([layer('subtract',big)]),maxVertices:64,maxTriangles:64}));
    assert.equal(drain(buildTerrainReceiverSupportSteps({tiles:makeTiles(empty),bounds,limits:config})).meshes.length,0);
    assert.throws(()=>drain(buildTerrainReceiverSupportSteps({tiles:[],bounds,limits:config})),{code:'terrain-support-missing'});
    assert.throws(()=>drain(buildTerrainReceiverSupportSteps({tiles:makeTiles(source),bounds:{...bounds,maxX:2.1},limits:config})),{code:'terrain-support-missing'});
    assert.throws(()=>drain(buildTerrainReceiverSupportSteps({tiles:makeTiles(source),bounds,limits:{...config,maxTriangles:1}})),{code:'terrain-support-capacity'});
    let current=true;
    const steps=buildTerrainReceiverSupportSteps({tiles:makeTiles(source),bounds,limits:config,now:clock(),isCurrent:()=>current});
    assert.equal(steps.next().done,false);current=false;
    assert.throws(()=>steps.next(),{code:'terrain-support-stale'});
});

test('a declared overlapping sheet keeps distinct heights at a shared cut point; a manifold receiver names the seam',()=>{
    // Two faces over the same plan area at different heights, both crossed by
    // one cut edge: what the coast collar's extended quads do at a bend.
    const geometry={positions:new Float32Array([0,0,0,10,0,0,0,0,10, 0,1,0,10,1,0,0,1,10]),indices:new Uint32Array([0,2,1,3,5,4])};
    const topology=build([layer('subtract',rect(2,-1,4,11))]);
    assert.throws(()=>drain(clipReceiverGeometrySteps({geometry,topology,maxVertices:256,maxTriangles:256})),
        error=>error.code==='ground-topology-seam'&&Number.isFinite(error.details?.x)&&Number.isFinite(error.details?.z)
            &&Math.abs(error.details.existingY-error.details.y)>.5&&/ at -?[\d.]+,-?[\d.]+$/.test(error.message));
    const result=drain(clipReceiverGeometrySteps({geometry,topology,maxVertices:256,maxTriangles:256,overlappingFaces:true}));
    const heights=new Set();for(let i=1;i<result.positions.length;i+=3)heights.add(result.positions[i]);
    assert.deepEqual([...heights].sort(),[0,1],'both sheets keep their own boundary vertices');
    assert.equal(result.topology.changedTriangles,2);
});
