import test from 'node:test';
import assert from 'node:assert/strict';
import earcut from 'earcut';
import { readFileSync } from 'node:fs';
import { createReceiverFootprintSteps } from '../core/receiver-footprint.js';
import { pointInRingNonZero } from '../core/mask-query.js';

const drain = steps => { for (;;) { const n = steps.next(); if (n.done) return n.value; } };
const footprint = (geometry, options = {}) => drain(createReceiverFootprintSteps({ ...geometry, maxTriangles: 8192, ...options }));
const contains = (result, x, z) => result.regions.some(r => pointInRingNonZero(x,z,r.ring)
    && !r.holeRings.some(h=>pointInRingNonZero(x,z,h)));
function grid(n, keep = () => true, offset = 0) {
    const positions = [], indices = [];
    for (let z=0;z<=n;z++) for (let x=0;x<=n;x++) positions.push(offset+x, .1*x+.07*z, offset+z);
    for (let z=0;z<n;z++) for (let x=0;x<n;x++) {
        if (!keep(x,z)) continue;
        const a=z*(n+1)+x,b=a+1,c=a+n+1,d=c+1;
        indices.push(a,c,b,b,c,d);
    }
    return {positions:new Float32Array(positions),indices:new Uint32Array(indices)};
}

test('a dense sloped receiver retains its exact perimeter and does not turn interior triangles into regions',()=>{
    const geometry=grid(48,()=>true,12000),result=footprint(geometry);
    assert.equal(result.triangles,4608);
    assert.equal(result.regions.length,1);
    assert.equal(result.boundaryVertices,192);
    assert.equal(result.area,48*48);
    assert.equal(contains(result,12024.3,12017.6),true);
    assert.equal(contains(result,11999.999,12017.6),false);
    assert.equal(result.regions[0].holeRings.length,0);
    assert.ok(Object.isFrozen(result.regions[0].ring));
});

test('actual mesh omissions, islands and disconnected parts survive independently of source polygons',()=>{
    const keep=(x,z)=>!(x>=2&&x<6&&z>=2&&z<6)||(x===4&&z===4);
    const geometry=grid(8,keep),result=footprint(geometry);
    assert.equal(result.regions.length,2);
    assert.equal(result.regions.reduce((n,r)=>n+r.holeRings.length,0),1);
    for(let x=0;x<8;x++)for(let z=0;z<8;z++)assert.equal(contains(result,x+.2,z+.3),keep(x,z),`${x},${z}`);
    assert.equal(result.area,49);
});

test('welds exact duplicated vertices without inventing support across a polygon hole',()=>{
    const flat=[0,0,8,0,8,8,0,8,2,2,2,6,6,6,6,2];
    const index=earcut(flat,[4],2),positions=[];
    for(const i of index)positions.push(flat[i*2],Math.fround(flat[i*2]*.2),flat[i*2+1]);
    const result=footprint({positions:new Float32Array(positions)});
    assert.equal(result.regions.length,1);
    assert.equal(result.regions[0].holeRings.length,1);
    assert.equal(result.area,48);
    assert.equal(contains(result,1,1),true);
    assert.equal(contains(result,3,3),false);
});

test('rejects topology/capacity errors and aborts a superseded cooperative build',()=>{
    const geometry=grid(4);
    assert.throws(()=>footprint(geometry,{maxTriangles:1}),{code:'ground-generation-capacity'});
    const duplicate={...geometry,indices:new Uint32Array([...geometry.indices,...geometry.indices.slice(0,3)])};
    assert.throws(()=>footprint(duplicate),{code:'receiver-footprint-topology'});
    const invalid={positions:new Float32Array([0,0,0,0,0,1,1,0,0,0,1,0]),indices:new Uint32Array([0,1,2,3,1,2])};
    assert.throws(()=>footprint(invalid),{code:'receiver-footprint-topology'});
    let current=true,time=0;
    const steps=createReceiverFootprintSteps({...geometry,maxTriangles:8192,now:()=>time+=.3,isCurrent:()=>current});
    assert.equal(steps.next().done,false);current=false;
    assert.throws(()=>steps.next(),{code:'ground-generation-stale'});
});

test('saved native Float32 refinement keeps boundary connectivity and reports its bounded precision loss',()=>{
    const {rows}=JSON.parse(readFileSync(new URL('./fixtures/ground-buffered-receivers.json',import.meta.url)));
    let folds=0,collapsed=0,sharedHeight=0;
    for(const row of rows) {
        const geometry={positions:new Float32Array(row.positions),indices:new Uint32Array(row.indices)};
        const before=geometry.positions.slice(),result=footprint(geometry);
        assert.equal(result.regions.length,1);
        assert.ok(result.boundaryVertices<result.triangles);
        assert.ok(result.maxFoldWidthM<.000061);
        folds+=result.maxFoldWidthM;collapsed+=result.collapsedFaces;sharedHeight+=result.maxHeightDifferenceM;
        assert.deepEqual(geometry.positions,before,'boundary extraction never edits physical support');
        // The independently stored faces establish coverage away from numerical
        // slivers. Check every ordinary triangle's centroid against the boundary.
        const p=geometry.positions;
        for(let i=0;i<geometry.indices.length;i+=3) {
            const [a,b,c]=[...geometry.indices.slice(i,i+3)].map(i=>({x:p[i*3],z:p[i*3+2]}));
            const area=Math.abs((b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x));
            const perimeter=Math.hypot(b.x-a.x,b.z-a.z)+Math.hypot(c.x-b.x,c.z-b.z)+Math.hypot(a.x-c.x,a.z-c.z);
            if(area/perimeter<.003)continue;
            assert.equal(contains(result,(a.x+b.x+c.x)/3,(a.z+b.z+c.z)/3),true);
        }
    }
    assert.ok(folds>0);assert.ok(collapsed>0);assert.ok(sharedHeight>0);
    // The same connectivity with a real fold is invalid, even though its
    // triangle count and boundary still look plausible.
    const folded={positions:new Float32Array([0,0,0,4,0,0,0,0,4,1,0,1]),
        indices:new Uint32Array([0,2,1,1,2,3])};
    assert.throws(()=>footprint(folded),{code:'receiver-footprint-topology'});
});
