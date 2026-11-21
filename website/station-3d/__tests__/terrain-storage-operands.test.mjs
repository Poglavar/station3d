import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { createTerrainCutoutTopologySteps } from '../core/terrain-cutout-topology.js';
import { clipReceiverGeometrySteps } from '../core/terrain-receiver-topology.js';
import { buildTerrainReceiverSupportSteps } from '../core/terrain-receiver-support.js';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/ground-gric-terrain-operands.json',import.meta.url)));
const drain=steps=>{for(;;){const next=steps.next();if(next.done)return next.value;}};
const cross=(a,b,c)=>(b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x);
const rect=(a,b,c,d)=>[{x:a,z:b},{x:c,z:b},{x:c,z:d},{x:a,z:d}];
const typed=geometry=>Object.fromEntries(Object.entries(geometry).map(([key,values])=>
    [key,key==='indices'?new Uint32Array(values):new Float32Array(values)]));
function compile(geometry,layers,options={}) {
    return drain(clipReceiverGeometrySteps({geometry,
        topology:drain(createTerrainCutoutTopologySteps({layers,limits:fixture.limits})),
        maxVertices:4096,maxTriangles:4096,...options}));
}
function meshOf(data) {
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.BufferAttribute(data.positions,3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices,1));
    const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial());mesh.updateMatrixWorld(true);return mesh;
}
function inside(point,ring) {
    let winding=0;
    for(let i=0;i<ring.length;i++) {
        const a=ring[i],b=ring[(i+1)%ring.length],side=cross(a,b,point);
        if(a.z<=point.z&&b.z>point.z&&side>0)winding++;
        if(a.z>point.z&&b.z<=point.z&&side<0)winding--;
    }
    return winding!==0;
}
function boundaryDistance(point,ring) {
    let distance=Infinity;
    for(let i=0;i<ring.length;i++) {
        const a=ring[i],b=ring[(i+1)%ring.length],dx=b.x-a.x,dz=b.z-a.z;
        const t=Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.z-a.z)*dz)/(dx*dx+dz*dz||1)));
        distance=Math.min(distance,Math.hypot(point.x-a.x-t*dx,point.z-a.z-t*dz));
    }
    return distance;
}

test('Kambelovac overlapping road cuts terminate in storage and preserve receiver coverage',()=>{
    // Two operands reduced from project 64, offset 11390, on 2026-09-15.
    // Vertex-only rounding followed by union still failed after 64 passes.
    // The full receiver bounds matter: they determine source-ring clipping
    // before these individual 4 m faces are intersected.
    const captured=JSON.parse(readFileSync(new URL('./fixtures/terrain-storage-kambelovac.json',import.meta.url)));
    const {triangle,bounds,storageOrigin,layers}=captured;
    const topology=drain(createTerrainCutoutTopologySteps({layers,limits:fixture.limits}));
    const stored=drain(topology.prepareReceiverStorageSteps({bounds,storageOrigin}));
    const boundary=drain(stored.clipTriangleSteps(...triangle,{storageOrigin}));
    assert.ok(boundary.triangles.length>0);
    for(const face of boundary.triangles)for(const p of face) {
        assert.equal(Math.fround(p.x-storageOrigin.x)+storageOrigin.x,p.x);
        assert.equal(Math.fround(p.z-storageOrigin.z)+storageOrigin.z,p.z);
    }
    const [a,b,c]=triangle,d={x:c.x,y:b.y,z:b.z};
    // The last two unreferenced vertices retain the actual tile's storage
    // domain while only the affected adjacent source faces need compilation.
    const vertices=[a,b,c,d,{x:bounds.minX,y:0,z:bounds.minZ},{x:bounds.maxX,y:0,z:bounds.maxZ}];
    const source={positions:new Float32Array(vertices.flatMap(p=>[p.x-storageOrigin.x,p.y,p.z-storageOrigin.z])),
        indices:new Uint32Array([0,1,2,2,1,3])};
    const before=structuredClone(source),result=compile(source,layers,{originX:storageOrigin.x,originZ:storageOrigin.z});
    assert.deepEqual(source,before,'compilation does not mutate source evidence');
    const faces=[];
    for(let i=0;i<result.indices.length;i+=3) {
        const face=Array.from(result.indices.subarray(i,i+3),n=>({x:result.positions[n*3]+storageOrigin.x,
            y:result.positions[n*3+1],z:result.positions[n*3+2]+storageOrigin.z}));
        assert.ok(cross(...face)<0,'every stored triangle has nonzero area and faces upward');
        for(const p of face) {
            assert.ok(p.x>=a.x-.001&&p.x<=c.x+.001&&p.z>=a.z-.001&&p.z<=b.z+.001);
            const expected=a.y+(b.y-a.y)*(p.z-a.z)/(b.z-a.z);
            assert.ok(Math.abs(p.y-expected)<.001,'new vertices follow the source plane');
        }
        faces.push(face);
    }
    const rings=layers.flatMap(layer=>layer.regions.flatMap(r=>[r.ring,...r.holeRings,...r.clipRings]));
    let kept=0,cut=0;
    for(let x=a.x+.031;x<c.x;x+=.113)for(let z=a.z+.043;z<b.z;z+=.127) {
        const p={x,z};if(rings.some(r=>boundaryDistance(p,r)<.001))continue;
        let covered=true;
        for(const layer of layers)for(const region of layer.regions) {
            if(!inside(p,region.ring)||region.holeRings.some(r=>inside(p,r)))continue;
            if(region.clipRings.length&&!region.clipRings.some(r=>inside(p,r)))continue;
            covered=layer.operation==='restore';
        }
        const hits=faces.filter(([a,b,c])=>cross(a,b,p)<=0&&cross(b,c,p)<=0&&cross(c,a,p)<=0).length;
        assert.equal(hits,covered?1:0,`original cut coverage, without overlap, at ${x},${z}`);
        if(covered)kept++;else cut++;
    }
    assert.ok(kept>100&&cut>100,'oracle exercises both retained terrain and openings');
});

test('native Grić terrain operands preserve actual source coverage, winding and Rapier support',async()=>{
    const source=typed(fixture.geometry),before=structuredClone(source),result=compile(source,fixture.layers);
    assert.equal(result.topology.sourceTriangles,32);
    assert.equal(result.sourceTriangleOffsets.length,33);
    assert.ok(result.sourceTriangleOffsets[1]>0,'the first source face retains its representable ground');
    assert.ok(result.indices.length>source.indices.length,'retained cut boundaries are triangulated');
    for(const [key,size]of[['positions',3],['normals',3],['uvs',2]]) {
        assert.equal(result[key].length,result.positions.length/3*size);
        assert.deepEqual(source[key],before[key]);
    }
    assert.deepEqual(source.indices,before.indices);
    const point=(positions,i)=>({x:positions[i*3],y:positions[i*3+1],z:positions[i*3+2]});
    for(let face=0;face<32;face++) {
        const [a,b,c]=Array.from(source.indices.subarray(face*3,face*3+3),i=>point(source.positions,i));
        const denominator=cross(a,b,c);
        for(let offset=result.sourceTriangleOffsets[face];offset<result.sourceTriangleOffsets[face+1];offset+=3) {
            const points=Array.from(result.indices.subarray(offset,offset+3),i=>point(result.positions,i));
            assert.ok(cross(...points)*denominator>0,'every stored face preserves source winding and nonzero area');
            for(const p of points) {
                const wa=cross(p,b,c)/denominator,wb=cross(a,p,c)/denominator,wc=1-wa-wb;
                assert.ok(Math.min(wa,wb,wc)>-.001,'storage stays on the original source face');
                assert.ok(Math.abs(p.y-wa*a.y-wb*b.y-wc*c.y)<.001,'height follows the exact source plane');
            }
        }
    }
    const original=meshOf(source),visible=meshOf(result);
    await RAPIER.init();const world=new RAPIER.World({x:0,y:-9.81,z:0});
    try {
        const support=drain(buildTerrainReceiverSupportSteps({
            tiles:[{tileX:0,tileZ:0,tileM:16,segments:4,receiver:result}],
            bounds:{minX:0,minZ:0,maxX:16,maxZ:16},
            limits:{maxTiles:1,maxSourceCells:16,maxTriangles:4096,maxMeshes:128,maxTrianglesPerMesh:32},
        }));
        assert.equal(support.triangles,result.indices.length/3);
        for(const part of support.meshes)world.createCollider(RAPIER.ColliderDesc.trimesh(part.vertices,part.indices));
        world.step();
        const rings=fixture.layers.flatMap(layer=>layer.regions.flatMap(region=>
            [region.ring,...region.holeRings||[],...region.clipRings||[]]));
        let retained=0,removed=0;
        for(let x=.071;x<16;x+=.317)for(let z=.053;z<16;z+=.313) {
            const ray=new THREE.Raycaster(new THREE.Vector3(x,20,z),new THREE.Vector3(0,-1,0));
            const baseline=ray.intersectObject(original)[0];assert.ok(baseline,'source covers the fixture square');
            const point={x,z,y:baseline.point.y};
            if(rings.some(ring=>boundaryDistance(point,ring)<.001))continue;
            if(fixture.layers.some(layer=>layer.regions.some(region=>[region.minY,region.maxY]
                .some(y=>typeof y==='number'&&Math.abs(y-point.y)<.001))))continue;
            // Independent source-domain oracle: original mesh height plus the
            // complete original rings, with no engine window/index/rounding.
            let covered=true;
            for(const layer of fixture.layers)for(const region of layer.regions) {
                if(typeof region.minY==='number'&&point.y<region.minY)continue;
                if(typeof region.maxY==='number'&&(region.maxYExclusive?point.y>=region.maxY:point.y>region.maxY))continue;
                if(!inside(point,region.ring)||(region.holeRings||[]).some(hole=>inside(point,hole)))continue;
                if(region.clipRings?.length&&!region.clipRings.some(ring=>inside(point,ring)))continue;
                covered=layer.operation==='restore';
            }
            const hit=ray.intersectObject(visible)[0];
            const physical=world.castRay(new RAPIER.Ray({x,y:20,z},{x:0,y:-1,z:0}),100,true);
            assert.equal(!!hit,covered,`visible coverage at ${x},${z}`);
            assert.equal(!!physical,covered,`physical coverage at ${x},${z}`);
            if(covered) {
                retained++;
                assert.ok(Math.abs(hit.point.y-point.y)<.001);
                assert.ok(Math.abs(20-physical.timeOfImpact-point.y)<.001);
            } else removed++;
        }
        assert.ok(retained>100&&removed>100,`oracle needs retained and removed ground (${retained}/${removed})`);
    } finally {
        world.free();
        for(const mesh of[original,visible]){mesh.geometry.dispose();mesh.material.dispose();}
    }
});

test('the native driving ring exactly retraces its boundary and has no opening or island to lose',()=>{
    const captured=JSON.parse(readFileSync(new URL('./fixtures/ground-drive-retraced-ring.json',import.meta.url)));
    const source={positions:new Float32Array([0,0,0,0,0,400,400,0,0,400,0,400]),
        indices:new Uint32Array([0,1,2,2,1,3])};
    const original=structuredClone(source),big=rect(-1300,-100,-700,500);
    const options={originX:captured.storageOrigin.x,originZ:captured.storageOrigin.z};
    for(const ring of[captured.ring,[...captured.ring].reverse(),
        [...captured.ring.slice(3),...captured.ring.slice(0,3)]]) {
        for(const layers of[
            [{operation:'subtract',regions:[{ring}]}],
            [{operation:'restore',regions:[{ring}]}],
            [{operation:'subtract',regions:[{ring:big,clipRings:[ring]}]}],
        ]) {
            const result=compile(source,layers,options);
            assert.deepEqual(result.indices,source.indices);
            assert.equal(result.positions,source.positions,'an empty operand preserves the actual receiver');
        }
        for(const layers of[
            [{operation:'subtract',regions:[{ring:big}]},{operation:'restore',regions:[{ring}]}],
            [{operation:'subtract',regions:[{ring:big,holeRings:[ring]}]}],
        ]) assert.equal(compile(source,layers,options).indices.length,0,'an empty path cannot restore support');
    }
    const partial={positions:new Float32Array([0,0,0,0,0,2,2,0,0,2,0,2]),indices:source.indices};
    const clipped=compile(partial,[{operation:'subtract',regions:[{ring:captured.ring}]}],{originX:-971,originZ:168});
    assert.deepEqual(clipped.indices,partial.indices,'window clipping cannot give a retraced input an interior');
    assert.equal(clipped.positions,partial.positions);
    assert.deepEqual(source,original);
});

// Since the extraction (793f76b, terrain-cutout-topology.js hasStorageResolvableWidthSteps), an operand
// narrower than the displacement the storage contract already permits (0.2 mm) is discarded as a sliver
// rather than failing the receiver; terrain-cutout-storage.test.mjs covers the densified-edge case.
test('storage discards sub-tolerance holes and islands without touching the source buffers',()=>{
    const source={positions:new Float32Array([0,0,0,0,0,6,6,0,0]),indices:new Uint32Array([0,1,2])};
    const tiny=rect(1,1,1+1e-9,1+1e-9),big=rect(-1,-1,7,7);
    const bowtie=[tiny[0],tiny[2],tiny[3],tiny[1]];
    const cutAway=compile(source,[{operation:'subtract',regions:[{ring:big}]}]);
    for(const [layers,expected] of [
        [[{operation:'subtract',regions:[{ring:tiny}]}],source.indices],
        [[{operation:'subtract',regions:[{ring:[...tiny,...tiny]}]}],source.indices],
        [[{operation:'subtract',regions:[{ring:bowtie}]}],source.indices],
        [[{operation:'subtract',regions:[{ring:big}]},{operation:'restore',regions:[{ring:tiny}]}],cutAway.indices],
        [[{operation:'subtract',regions:[{ring:big,holeRings:[tiny]}]}],cutAway.indices],
    ]) {
        const before=structuredClone(source);
        assert.deepEqual(compile(source,layers).indices,expected);
        assert.deepEqual(source,before);
    }
});

test('a collapsed operand wider than the storage tolerance still fails the receiver',()=>{
    // 0.3 mm square 5 km out: wider than the 0.2 mm width rule, but Float32 storage there cannot keep it.
    const source={positions:new Float32Array([4990,0,4990,4990,0,5010,5010,0,4990]),indices:new Uint32Array([0,1,2])};
    const h=.00015,tiny=rect(5000-h,4995-h,5000+h,4995+h);
    assert.throws(()=>compile(source,[{operation:'subtract',regions:[{ring:tiny}]}]),{code:'ground-topology-precision'});
});

test('cell-edge fragments outside the receiver vanish',()=>{
    const source={positions:new Float32Array([0,0,0,0,0,6,6,0,0,6,0,6]),indices:new Uint32Array([0,1,2,2,1,3])};
    const outside=rect(6-1e-9,-1,7,7),big=rect(-1,-1,7,7);
    const unchanged=compile(source,[{operation:'subtract',regions:[{ring:outside}]}]);
    assert.deepEqual(unchanged.indices,source.indices);
    assert.equal(unchanged.positions,source.positions);
    const empty=compile(source,[{operation:'subtract',regions:[{ring:big}]},
        {operation:'restore',regions:[{ring:outside}]}]);
    assert.equal(empty.indices.length,0,'a stored island wholly outside the receiver supplies no faces');
});

test('operand storage is cooperative and cancellation keeps source buffers intact',()=>{
    const source=typed(fixture.geometry),before=structuredClone(source);
    const topology=drain(createTerrainCutoutTopologySteps({layers:fixture.layers,limits:fixture.limits}));
    let current=true,time=0;
    const steps=clipReceiverGeometrySteps({geometry:source,topology,maxVertices:4096,maxTriangles:4096,
        now:()=>time+=.1,isCurrent:()=>current});
    let reached=false;
    for(;;){const next=steps.next();assert.equal(next.done,false);if(next.value.phase==='ground-topology-operand-storage'){reached=true;break;}}
    assert.ok(reached);current=false;
    assert.throws(()=>steps.next(),{code:'ground-topology-stale'});
    assert.deepEqual(source,before);
});
