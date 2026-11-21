// Exact cycle coverage and bounded immutable source-record splitting.
import test from 'node:test'; import assert from 'node:assert/strict';
import { compileSurfaceClaim } from '../core/surface-hierarchy.js';
import { createGroundBikePaintRecordsSteps } from '../core/ground-bike-paint.js';
const receiver={key:'terrain',verticalBand:'ground',coverageRevision:'r1'}; const q=[{x:0,z:0},{x:1,z:0},{x:1,z:1},{x:0,z:1}];
const collect=(quads)=>{const g=createGroundBikePaintRecordsSteps({quads,identity:{key:'bike',revisionKey:'r'},receiver,claim:compileSurfaceClaim({surfaceClass:'cycleway',verticalBand:'ground',verticalRelation:'same-level'}),materialKey:'m',materialRevision:'1'});let n=g.next(), ys=0;while(!n.done){ys++;n=g.next()}return [n.value,ys]};
test('bike records preserve quads and priority',()=>{const [r,y]=collect([q]);assert.equal(r[0].polygons[0].outerRing.length,4);assert.equal(r[0].sourcePriority,1);assert.equal(r[0].claim.surfaceClass,'cycleway');assert.equal(r[0].claim.capabilities.backstopCut,false);assert.deepEqual(r[0].polygons[0].outerRing,q);assert.ok(Object.isFrozen(r));});
test('bike splits at 2048 and rejects over seven records',()=>{const [r]=collect(Array.from({length:2049},()=>q));assert.equal(r.length,2);assert.throws(()=>collect(Array.from({length:7*2048+1},()=>q)),/capacity/)});
