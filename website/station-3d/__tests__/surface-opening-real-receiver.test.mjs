import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { readFileSync } from 'node:fs';
import { createSurfaceOpeningReadSteps } from '../core/surface-opening-read.js';
import { clipReceiverOpeningsSteps } from '../core/receiver-opening-geometry.js';
import { createReceiverFootprintSteps } from '../core/receiver-footprint.js';

const drain = steps => { for (;;) { const n=steps.next(); if (n.done) return n.value; } };
const limits={maxRegions:16,maxSourceVertices:4096,maxCandidates:8,maxFragments:4096};
const fixture=JSON.parse(readFileSync(new URL('./fixtures/ground-gric-opening-sidewalk.json',import.meta.url),'utf8'));
const claim=fixture.claim;
const geometry={positions:new Float32Array(fixture.geometry.positions),indices:new Uint32Array(fixture.geometry.indices),uvs:new Float32Array(fixture.geometry.uvs),normals:new Float32Array(fixture.geometry.normals)};

test('real indexed Grič receiver clips opening consistently for footprint, Three and Rapier',async()=>{
 const sourcePositions=geometry.positions.slice(), sourceIndices=geometry.indices.slice();
 const source=drain(createReceiverFootprintSteps({positions:geometry.positions,indices:geometry.indices,maxTriangles:1200}));
 assert.ok(Math.abs(source.area-440.3598098528202)<1e-5,`source area ${source.area}`);
 assert.equal(source.regions.length,1);
 assert.deepEqual(geometry.positions,sourcePositions); assert.deepEqual(geometry.indices,sourceIndices);
 const openingRead=drain(createSurfaceOpeningReadSteps({authored:fixture.regions,entrances:[],planner:[],water:[],limits}));
 const originalGeometry=new THREE.BufferGeometry();
 originalGeometry.setAttribute('position',new THREE.BufferAttribute(geometry.positions,3));
 originalGeometry.setIndex(new THREE.BufferAttribute(geometry.indices,1));
 const originalMesh=new THREE.Mesh(originalGeometry,new THREE.MeshBasicMaterial({side:THREE.DoubleSide})); originalMesh.updateMatrixWorld(true);
 const clipped=drain(clipReceiverOpeningsSteps({geometry,openingRead,claim,maxVertices:8192,maxTriangles:4096}));
 assert.notEqual(clipped,geometry); assert.ok(clipped.indices?.length>0);
 const footprint=drain(createReceiverFootprintSteps({...clipped,maxTriangles:4096}));
 assert.ok(footprint.area>0);
 const threeGeometry=new THREE.BufferGeometry();
 threeGeometry.setAttribute('position',new THREE.BufferAttribute(clipped.positions,3));
 threeGeometry.setIndex(new THREE.BufferAttribute(clipped.indices,1));
 const mesh=new THREE.Mesh(threeGeometry,new THREE.MeshBasicMaterial({side:THREE.DoubleSide})); mesh.updateMatrixWorld(true);
 assert.deepEqual(geometry.positions,sourcePositions); assert.deepEqual(geometry.indices,sourceIndices);
 assert.deepEqual(geometry.uvs,new Float32Array(fixture.geometry.uvs)); assert.deepEqual(geometry.normals,new Float32Array(fixture.geometry.normals));
 await RAPIER.init(); const world=new RAPIER.World({x:0,y:0,z:0});
 try {
  world.createCollider(RAPIER.ColliderDesc.trimesh(clipped.positions,clipped.indices)); world.step();
  let originalSupported=0,cut=0,retained=0;
  for(let ix=0;ix<40;ix++) for(let iz=0;iz<30;iz++) {
   const x=1.0+ix*(21.8/39), z=1.0+iz*(6.34/29), y=10;
   const ray=new THREE.Raycaster(new THREE.Vector3(x,y,z),new THREE.Vector3(0,-1,0));
   const originalHit=ray.intersectObject(originalMesh)[0];
   if(originalHit) originalSupported++;
   const inside=originalHit ? openingRead.contains(x,originalHit.point.y,z,claim) : false;
   if(inside) cut++;
   else if(originalHit) retained++;
   const visibleHit=ray.intersectObject(mesh)[0], visible=!!visibleHit;
   const hit=world.castRay(new RAPIER.Ray({x,y,z},{x:0,y:-1,z:0}),30,true);
   const physical=!!hit;
   assert.equal(visible,physical,`Three/Rapier presence mismatch at ${x},${z}`);
   assert.equal(visible,!!originalHit&&!inside,`clipped presence mismatch at ${x},${z}`);
   if(visible&&originalHit) assert.ok(Math.abs(visibleHit.point.y-originalHit.point.y)<.001,`retained height mismatch at ${x},${z}`);
   if(visibleHit&&hit) assert.ok(Math.abs(visibleHit.point.y-(y-hit.timeOfImpact))<.001,`height mismatch at ${x},${z}`);
  }
  assert.ok(originalSupported>0); assert.ok(cut>0); assert.ok(retained>0);
 } finally { world.free(); threeGeometry.dispose(); originalGeometry.dispose(); mesh.material.dispose(); originalMesh.material.dispose(); }
});

test('real receiver clipping is cancellable, capacity bounded, and source-order independent',()=>{
 const openingRead=drain(createSurfaceOpeningReadSteps({authored:fixture.regions,entrances:[],planner:[],water:[],limits}));
 const original={positions:geometry.positions.slice(),indices:geometry.indices.slice(),uvs:geometry.uvs.slice(),normals:geometry.normals.slice()};
 let clock=0, active=true, sawConformity=false;
 const steps=clipReceiverOpeningsSteps({geometry,openingRead,claim,maxVertices:8192,maxTriangles:4096,now:()=>{clock+=.6;return clock;},isCurrent:()=>active});
 let yielded=steps.next(); while(!yielded.done){if(yielded.value?.phase==='ground-topology-edge-conformity'){sawConformity=true;active=false;break;} yielded=steps.next();}
 assert.ok(sawConformity); assert.throws(()=>steps.next(),e=>e.code==='ground-topology-stale');
 assert.deepEqual(geometry.positions,original.positions); assert.deepEqual(geometry.indices,original.indices);
 assert.deepEqual(geometry.uvs,original.uvs); assert.deepEqual(geometry.normals,original.normals);
 active=true; const good=drain(clipReceiverOpeningsSteps({geometry,openingRead,claim,maxVertices:8192,maxTriangles:4096}));
 assert.equal(good.topology.conformityAddedTriangles,1);
 assert.throws(()=>drain(clipReceiverOpeningsSteps({geometry,openingRead,claim,maxVertices:8192,maxTriangles:Math.max(1,good.indices.length/3-1)})),e=>e.code==='ground-topology-capacity');
 assert.deepEqual(geometry.positions,original.positions); assert.deepEqual(geometry.indices,original.indices);
 const indexed=drain(createReceiverFootprintSteps({...good,maxTriangles:4096}));
 const reversed=geometry.indices.slice(),opposite=geometry.indices.slice();
 for(let i=0;i<reversed.length;i+=3){
  reversed.set(geometry.indices.subarray(reversed.length-i-3,reversed.length-i),i);
  opposite[i+1]=geometry.indices[i+2];opposite[i+2]=geometry.indices[i+1];
 }
 for(const indices of [reversed,opposite]) {
  const result=drain(clipReceiverOpeningsSteps({geometry:{...geometry,indices},openingRead,claim,maxVertices:8192,maxTriangles:4096}));
  const footprint=drain(createReceiverFootprintSteps({...result,maxTriangles:4096}));
  assert.equal(footprint.regions.length,indexed.regions.length);
  assert.deepEqual(footprint.regions.map(r=>r.holeRings.length),indexed.regions.map(r=>r.holeRings.length));
  assert.ok(Math.abs(footprint.area-indexed.area)<1e-5);
 }
 // This refined source has coincident but topologically distinct vertices.
 // Removing its index loses that information even before an opening is cut;
 // the compiler must not manufacture a valid footprint from that ambiguity.
 const nonindexed={positions:new Float32Array([...geometry.indices].flatMap(i=>[...geometry.positions.subarray(i*3,i*3+3)]))};
 assert.throws(()=>drain(createReceiverFootprintSteps({...nonindexed,maxTriangles:4096})),{code:'receiver-footprint-topology'});
 const flat=drain(clipReceiverOpeningsSteps({geometry:nonindexed,openingRead,claim,maxVertices:8192,maxTriangles:4096}));
 assert.throws(()=>drain(createReceiverFootprintSteps({...flat,maxTriangles:4096})),{code:'receiver-footprint-topology'});
 assert.deepEqual(geometry,original);
});
