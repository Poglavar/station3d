import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {readFileSync} from 'node:fs';
import {createSurfaceOpeningReadSteps} from '../core/surface-opening-read.js';
import {clipReceiverOpeningsSteps} from '../core/receiver-opening-geometry.js';
import {createGeometryBatcher,ownerRangeForFace} from '../core/geometry-batch.js';

const drain=s=>{for(;;){const n=s.next();if(n.done)return n.value;}};
const f=JSON.parse(readFileSync(new URL('./fixtures/ground-gric-opening-seam.json',import.meta.url),'utf8'));
const claim=f.claim, limits={maxRegions:16,maxSourceVertices:4096,maxCandidates:8,maxFragments:4096};
const make=(g,i=null)=>{const b=new THREE.BufferGeometry();b.setAttribute('position',new THREE.BufferAttribute(g.positions,3));if(i)b.setIndex(new THREE.BufferAttribute(i,1));const m=new THREE.Mesh(b,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));m.updateMatrixWorld(true);return [b,m];};

test('a clipped native seam joins its retained implicit neighbour in one reversible batch',()=>{
    const source=Object.fromEntries(Object.entries(f.geometry).map(([key,values])=>[key,new Float32Array(values)]));
    const read=drain(createSurfaceOpeningReadSteps({authored:f.regions,limits}));
    const clipped=drain(clipReceiverOpeningsSteps({geometry:source,openingRead:read,claim,maxVertices:4096,maxTriangles:4096}));
    const part=geometry=>({attributes:{position:geometry.positions,normal:geometry.normals,uv:geometry.uvs},
        ...(geometry.indices?{index:geometry.indices}:{}),surfaceClaim:claim});
    const neighbour={...source,positions:source.positions.slice()};
    for(let i=0;i<neighbour.positions.length;i+=3)neighbour.positions[i]+=100;
    const batcher=createGeometryBatcher();
    batcher.addPart('seam','opening',part(source));batcher.addPart('seam','retained',part(neighbour));
    const before=batcher.assemble('seam');assert.equal(before.index,null);
    const tx=drain(batcher.prepareReplacementSteps([{bucketKey:'seam',ownerKey:'opening',parts:[part(clipped)]}],
        {maxBuckets:1,maxOwners:2,maxParts:4,maxOutputBytes:100000}));
    const task=tx.beginAssembly('seam');while(!task.step(.5))assert.deepEqual(batcher.assemble('seam'),before);
    const result=task.result(),base=clipped.positions.length/3;
    assert.deepEqual([...result.index.slice(0,clipped.indices.length)],[...clipped.indices]);
    assert.deepEqual([...result.index.slice(clipped.indices.length)],Array.from({length:neighbour.positions.length/3},(_,i)=>i+base));
    assert.equal(result.vertexCount,base+neighbour.positions.length/3);
    for(const [name,key] of [['position','positions'],['normal','normals'],['uv','uvs']]) {
        assert.deepEqual([...result.attributes[name]],[...clipped[key],...neighbour[key]]);
    }
    for(let face=0;face<result.index.length/3;face++)assert.equal(ownerRangeForFace(result.ranges,face).ownerKey,
        face<clipped.indices.length/3?'opening':'retained');
    assert.equal(tx.outputBytes,Object.values(result.attributes).reduce((sum,a)=>sum+a.byteLength,0)+result.index.byteLength);
    assert.equal(tx.commit(),true);assert.equal(Object.keys(batcher.stats()).length,1);
    assert.deepEqual(batcher.assemble('seam'),result);
    assert.equal(tx.rollback(),true);assert.deepEqual(batcher.assemble('seam'),before);tx.discard();
});

test('actual road-earthwork seam has no degenerate clipped faces and matching retained support',async()=>{
    const g={positions:new Float32Array(f.geometry.positions),uvs:new Float32Array(f.geometry.uvs),normals:new Float32Array(f.geometry.normals)};
    const before=structuredClone(g);
    const read=drain(createSurfaceOpeningReadSteps({authored:f.regions,limits}));
    const clipped=drain(clipReceiverOpeningsSteps({geometry:g,openingRead:read,claim,maxVertices:4096,maxTriangles:4096}));
    assert.equal(clipped.topology.edgeOnlyFragments,1);
    assert.equal(clipped.topology.conformityAddedTriangles,1);
    assert.equal(clipped.topology.triangles,176);
    assert.deepEqual(g,before);
    assert.equal(clipped.uvs.length/2,clipped.positions.length/3);
    assert.equal(clipped.normals.length,clipped.positions.length);
    const vertex=(positions,i)=>new THREE.Vector3().fromArray(positions,i*3);
    const normal=([a,b,c])=>b.clone().sub(a).cross(c.clone().sub(a));
    const offsets=clipped.sourceTriangleOffsets;
    assert.equal(offsets.length,g.positions.length/9+1);
    assert.equal(offsets[0],0);assert.equal(offsets.at(-1),clipped.indices.length);
    for(let face=0;face<offsets.length-1;face++) {
        assert.ok(offsets[face+1]>=offsets[face]);
        const sourceNormal=normal([0,1,2].map(i=>vertex(g.positions,face*3+i)));
        for(let at=offsets[face];at<offsets[face+1];at+=3) {
            const n=normal([0,1,2].map(i=>vertex(clipped.positions,clipped.indices[at+i])));
            assert.ok(n.lengthSq()>0,`degenerate output from source face ${face}`);
            assert.ok(n.dot(sourceNormal)>0,`reversed output from source face ${face}`);
        }
    }
    const [og,om]=make(g),[cg,cm]=make(clipped,clipped.indices);
    await RAPIER.init();const world=new RAPIER.World({x:0,y:0,z:0});
    let cut=0,retained=0,normalRays=0;
    try {
        world.createCollider(RAPIER.ColliderDesc.trimesh(clipped.positions,clipped.indices));world.step();
        const checkRay=(origin,dir)=>{
            const ray=new THREE.Raycaster(origin,dir,0,100),hits=ray.intersectObject(om);
            const removed=h=>read.contains(h.point.x,h.point.y,h.point.z,claim);
            const expected=hits.find(h=>!removed(h));
            if(hits.some(removed))cut++;
            if(expected)retained++;
            const visible=ray.intersectObject(cm)[0];
            const physical=world.castRay(new RAPIER.Ray(origin,dir),100,true);
            assert.equal(!!visible,!!expected,`visible coverage at ${origin.toArray()}`);
            assert.equal(!!physical,!!expected,`physical coverage at ${origin.toArray()}`);
            if(expected) {
                assert.ok(Math.abs(visible.distance-expected.distance)<.001,'retained source height');
                assert.ok(Math.abs(physical.timeOfImpact-expected.distance)<.001,'physical retained source height');
                assert.ok(Math.abs(visible.distance-physical.timeOfImpact)<.001,'render/physics agreement');
            }
        };
        for(let ix=0;ix<24;ix++)for(let iz=0;iz<16;iz++) {
            checkRay(new THREE.Vector3(1+ix*20.8/23,10,1+iz*4.3/15),new THREE.Vector3(0,-1,0));
        }
        for(let face=0;face<g.positions.length/9;face++) {
            const points=[0,1,2].map(i=>vertex(g.positions,face*3+i)),n=normal(points);
            if(n.lengthSq()===0)continue;
            n.normalize();
            const origin=points[0].clone().add(points[1]).add(points[2]).multiplyScalar(1/3).addScaledVector(n,10);
            checkRay(origin,n.negate());normalRays++;
        }
    } finally {world.free();og.dispose();om.material.dispose();cg.dispose();cm.material.dispose();}
    assert.ok(cut>0,'rays must actually intersect removed source faces');
    assert.ok(retained>0);assert.ok(normalRays>0);
});
