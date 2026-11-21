import test from 'node:test';
import assert from 'node:assert/strict';
import {roundTerrainBoundarySteps,TERRAIN_BOOLEAN_LATTICE_M} from '../core/terrain-storage-rounding.js';

const drain=steps=>{for(;;){const next=steps.next();if(next.done)return next.value;}};
const options={offsetX:0,offsetZ:0,tolerance:.0002,clock:{*step(){}},limits:{maxOperandVertices:128}};
const round=(polygons,extra={})=>drain(roundTerrainBoundarySteps(polygons,{...options,...extra}));

test('storage noding joins an edge to a nearby rounded vertex in both edge directions',()=>{
    const q=1.5,near=q+2**-25;
    // The lower boundary crosses the rounding cell of the upper polygon's
    // tip. Rounding only the endpoints would leave a new, nonstored crossing.
    const lower=[[1,near],[2,near],[2,1],[1,1]],upper=[[q,near],[1.75,2],[1.25,2]];
    const input=[[lower],[upper]],result=round(input);
    assert.equal(result.moved,true);
    assert.deepEqual(result.polygons[0][0],[[1,q],[q,q],[2,q],[2,1],[1,1]]);
    const reversed=round([[lower.toReversed()],[upper.toReversed()]]);
    assert.deepEqual(reversed.polygons[0][0].toReversed(),result.polygons[0][0]);
    assert.equal(round(result.polygons).moved,false,'stored output is idempotent');
});

test('storage noding preserves a representable one-ULP opening without a coarser uniform grid',()=>{
    const x=.5,next=x+2**-24;
    const hole=[[x,.25],[x,.75],[next,.75],[next,.25]];
    const result=round([[[[0,0],[1+2**-26,0],[1,1],[0,1]],hole]]);
    assert.deepEqual(result.polygons[0][1],hole);
    assert.notEqual(result.polygons[0][1][0][0],result.polygons[0][1][2][0]);
});

test('storage noding is bounded and its scan remains cooperatively cancellable',()=>{
    const lower=[[1,1.5+2**-25],[2,1.5+2**-25],[2,1],[1,1]],upper=[[1.5,1.5+2**-25],[1.75,2],[1.25,2]];
    assert.throws(()=>round([[lower],[upper]],{limits:{maxOperandVertices:7}}),{code:'ground-topology-capacity'});
    let current=true,reached=false;
    const steps=roundTerrainBoundarySteps([[lower],[upper]],{...options,clock:{*step(phase){
        if(!current)throw Object.assign(new Error('cancelled'),{code:'ground-topology-stale'});
        if(phase==='ground-topology-storage-noding'){reached=true;yield {phase};}
    }}});
    assert.equal(steps.next().done,false);assert.equal(reached,true);
    current=false;assert.throws(()=>steps.next(),{code:'ground-topology-stale'});
    assert.throws(()=>round([[[[100000,0],[100001.001,0],[100001,1]]]]),{code:'ground-topology-precision'});
});

test('sub-lattice drift after a Boolean pass is not movement, a real Float32 residual still is',()=>{
    // A storage offset with bits below the Boolean lattice: Float32 vertices
    // plus a double-precision origin, as a coast collar triangle brings.
    const offsetX=311.09118652343756,offsetZ=110.96141815185547;
    const exact=[[8.299072265625,19.347923278808594],[0,.8863906860351562],[4.411834716796875,0]]
        .map(([x,z])=>[Math.fround(x+offsetX)-offsetX,Math.fround(z+offsetZ)-offsetZ]);
    assert.equal(round([[exact]],{offsetX,offsetZ}).moved,false,'Float32-exact input is a fixed point');
    // What the union hands back: every vertex re-quantised to the 2^-40 m lattice.
    const lattice=exact.map(([x,z])=>[Math.round(x/TERRAIN_BOOLEAN_LATTICE_M)*TERRAIN_BOOLEAN_LATTICE_M,
        Math.round(z/TERRAIN_BOOLEAN_LATTICE_M)*TERRAIN_BOOLEAN_LATTICE_M]);
    assert.ok(lattice.some((p,i)=>p[0]!==exact[i][0]||p[1]!==exact[i][1]),'the lattice really displaces these vertices');
    const drifted=round([[lattice]],{offsetX,offsetZ});
    assert.equal(drifted.moved,false,'a residual below one lattice unit rounds to the same stored vertex');
    assert.deepEqual(drifted.polygons,[[lattice]]);
    for(const p of lattice)assert.equal(Math.fround(p[0]+offsetX),Math.fround(exact[lattice.indexOf(p)][0]+offsetX));
    // A residual the size of a Float32 cell is movement and comes back exact.
    const off=exact.map(([x,z],i)=>i?[x,z]:[x+2**-20,z]);
    const result=round([[off]],{offsetX,offsetZ});
    assert.equal(result.moved,true);
    assert.deepEqual(result.polygons[0][0][0],exact[0]);
});
