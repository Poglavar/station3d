import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as polyclip from 'polyclip-ts';
import {createTerrainCutoutTopologySteps} from '../core/terrain-cutout-topology.js';
import {clipReceiverGeometrySteps} from '../core/terrain-receiver-topology.js';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/ground-jelacic-cut-boundaries.json',import.meta.url)));
const drain=steps=>{for(;;){const n=steps.next();if(n.done)return n.value;}};
const limits={maxSources:256,maxSourceVertices:32768,maxIndexEntries:262144,maxCellCandidates:128,maxOperandVertices:256,maxIntersections:64,maxOutputTriangles:256};
const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const area=poly=>Math.abs(poly.reduce((s,p,i)=>s+cross(p,poly[(i+1)%poly.length],[0,0]),0))/2;
const multiArea=mp=>mp.reduce((s,polygon)=>s+area(polygon[0])-polygon.slice(1).reduce((q,h)=>q+area(h),0),0);
const pointIn=([x,z],ring)=>{
    let winding=0;
    for(let i=0;i<ring.length;i++) {
        const a=ring[i],b=ring[(i+1)%ring.length],side=cross(a,b,[x,z]);
        if(a[1]<=z&&b[1]>z&&side>0)winding++;
        if(a[1]>z&&b[1]<=z&&side<0)winding--;
    }
    return winding!==0;
};
const distanceToEdge=(p,a,b)=>{
    const dx=b[0]-a[0],dz=b[1]-a[1],length=dx*dx+dz*dz;
    const t=length?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dz)/length)):0;
    return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dz);
};
const asRing=ring=>ring.map(p=>[p.x,p.z]);

test('native Jelacic Float32 boundaries match independent coverage and retain every stored face orientation',()=>{
    // This oracle uses complete original source polygons, without the engine's
    // local clipping/window/index optimizations or storage normalization.
    let removed=[];
    const edges=[];
    for(const layer of fixture.layers)for(const region of layer.regions) {
        const ring=asRing(region.ring),clips=(region.clipRings||[]).map(asRing);
        edges.push(ring,...clips);
        let cut=[[ring]];
        if(clips.length)cut=polyclip.intersection(cut,polyclip.union(...clips.map(ring=>[ring])));
        if(cut.length)removed=layer.operation==='subtract'?polyclip.union(removed,cut):polyclip.difference(removed,cut);
    }
    for(const source of fixture.triangles) {
        const expected=polyclip.difference([source],removed);
        const topology=drain(createTerrainCutoutTopologySteps({layers:fixture.layers,limits}));
        const positions=new Float32Array(source.flatMap(([x,z],i)=>[x,i+1,z]));
        const geometry=drain(clipReceiverGeometrySteps({geometry:{positions,indices:new Uint32Array([0,1,2])},
            topology,maxVertices:256,maxTriangles:256,originX:0,originZ:0,now:(()=>{let t=0;return()=>t+=.1;})()}));
        const faces=[];
        for(let i=0;i<geometry.indices.length;i+=3) {
            const face=Array.from(geometry.indices.subarray(i,i+3),index=>[
                geometry.positions[index*3],geometry.positions[index*3+2]]);
            assert.ok(cross(...face)<0,'every stored face has nonzero upward orientation');faces.push(face);
        }
        assert.ok(faces.length>0);
        const actual=faces.reduce((sum,face)=>sum+area(face),0);
        assert.ok(Math.abs(actual-multiArea(expected))<.0002,`receiver area ${actual} differs from source ${multiArea(expected)}`);
        let retained=0,cut=0;
        for(let dx=.031;dx<4;dx+=.071)for(let dz=.029;dz<4;dz+=.073) {
            const p=[source[0][0]+dx,source[0][1]+dz];
            if(!pointIn(p,source)||[source,...edges].some(r=>r.some((a,i)=>distanceToEdge(p,a,r[(i+1)%r.length])<.001)))continue;
            const wanted=expected.some(poly=>pointIn(p,poly[0])&&!poly.slice(1).some(hole=>pointIn(p,hole)));
            const visible=faces.some(face=>pointIn(p,face));
            assert.equal(visible,wanted,`coverage at ${p}`);
            if(wanted)retained++;else cut++;
        }
        assert.ok(retained>10&&cut>10,'the witness exercises both retained ground and cut ground');
    }
});
