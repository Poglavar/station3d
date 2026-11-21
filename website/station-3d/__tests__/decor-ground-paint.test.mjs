// Pure decor source identities, holes and colour-only ownership.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createDecorGroundPaintOwnerSteps, decorGroundPaintEligible } from '../core/decor-ground-paint.js';
import { groundPaintReceiverAcceptsClaim, groundPaintReceiverMinimumRank, groundPaintReceiverMaterialPolicy,
  groundPaintReceiverAcceptsPaint } from '../core/ground-paint-receiver-claim.js';
import { compileSurfaceClaim, SURFACE_CLASS } from '../core/surface-hierarchy.js';

const receiver = { key:'terrain', verticalBand:'ground', coverageRevision:'r1' };
const rings = [ [{x:0,z:0},{x:10,z:0},{x:10,z:10},{x:0,z:10}], [{x:2,z:2},{x:2,z:4},{x:4,z:4},{x:4,z:2}] ];
const run = (type, rs=rings) => { const g=createDecorGroundPaintOwnerSteps({type,sourceId:'x',rings:rs,receiver,materialKey:'m',materialRevision:'1'}); let n=g.next(), out; while(!n.done)n=g.next(); out=n.value; return out; };
test('parking and construction are colour-only, hole-bearing and canonical', () => {
  for (const type of ['parking','construction']) { const a=run(type), b=run(type,[rings[0].slice().reverse(),rings[1].slice().reverse()]); assert.equal(a.records[0].polygons[0].holeRings.length,1); assert.equal(a.records[0].claim.capabilities.color,true); assert.equal(a.records[0].claim.capabilities.support,false); assert.equal(a.records[0].claim.capabilities.backstopCut,false); assert.equal(a.owner,b.owner); }
  assert.equal(decorGroundPaintEligible('parking',{layer:1}),false); assert.equal(decorGroundPaintEligible('construction',{bridge:'yes'}),false);
  assert.equal(decorGroundPaintEligible('paving',{semantic:'fountain'}),false,'fountain water retains its physical producer');
});
test('decor source is bounded and yields cooperatively',()=>{ const many=Array.from({length:8200},(_,i)=>({x:i,z:0})); const g=createDecorGroundPaintOwnerSteps({type:'parking',sourceId:'x',rings:[many],receiver,materialKey:'m',materialRevision:'1'}); let yields=0; assert.throws(()=>{for(;;){const n=g.next(); if(n.done)return n.value; yields++;}},/capacity/); assert.ok(yields>0); });

test('retained parking stripes query physical road/terrain without actor or design policy', () => {
  const source = fs.readFileSync(new URL('../world/decor.js', import.meta.url), 'utf8');
  const functions = source.slice(source.indexOf('const PARKING_RECEIVER_QUERY'), source.indexOf('function decorSurfaceYAt('));
  const calls = [];
  const bounds = { minX: 0, minZ: 0, maxX: 1, maxZ: 1 };
  const terrainFace = { positions: new Float32Array([0, .8, 0, 1, .8, 0, 1, .8, 1]), a: 0, b: 3, c: 6 };
  const roadFace = { ...terrainFace, positions: new Float32Array([0, .8212, 0, 1, .8212, 0, 1, .8212, 1]) };
  let terrainFaces = [terrainFace], roadFaces = [roadFace];
  const context = vm.createContext({
    terrainReference: { *receiverTrianglesInBounds(query) { assert.equal(query, bounds); yield* terrainFaces; } },
    groundPaint: { receiver }, bounds, groundPaintReceiverAcceptsClaim,
    renderedRoadTrianglesInBounds: (query, options) => {
      calls.push(query); assert.equal(typeof options.acceptPart, 'function'); return roadFaces;
    },
  });
  vm.runInContext(functions, context);
  const read = () => Array.from(vm.runInContext('parkingReceiverTriangles(bounds)', context));
  assert.deepEqual(read(), [terrainFace, roadFace], 'preserve the real immutable geometry identities');
  assert.deepEqual(calls, [bounds]);
  terrainFaces = [];
  assert.deepEqual(read(), [roadFace], 'a road can replace cut terrain');
  roadFaces = [];
  assert.deepEqual(read(), [], 'missing both receivers withholds paint');
  context.terrainReference = null;
  assert.equal(read().length, 2, 'only an explicitly flat world supplies a zero-height receiver');
});

test('ordinary terrain continuations receive paint without reclassifying structures or physical claims', () => {
  const claim = (surfaceClass, verticalRelation = 'same-level') => compileSurfaceClaim({ surfaceClass,
    verticalRelation, verticalBand: 'ground', ownerId: 'road:1', coverageState: 'published', supportReady: true });
  const collar = claim(SURFACE_CLASS.ROAD_EARTHWORK);
  assert.equal(collar.rank, null);
  assert.equal(groundPaintReceiverMinimumRank(receiver, collar), 0);
  assert.equal(groundPaintReceiverAcceptsClaim(receiver, claim(SURFACE_CLASS.ROAD_EARTHWORK, 'grade-separated')), false);
  assert.equal(groundPaintReceiverAcceptsClaim(receiver, claim(SURFACE_CLASS.STRUCTURE)), false);
  assert.equal(groundPaintReceiverAcceptsClaim(receiver, claim(SURFACE_CLASS.RAIL_EARTHWORK)), false);
  assert.equal(collar.capabilities.support, true);
});

test('rail earthwork retains land-use colour without becoming road paint or parking support', () => {
  const claim = compileSurfaceClaim({surfaceClass:SURFACE_CLASS.RAIL_EARTHWORK,
    verticalBand:'ground',verticalRelation:'same-level',supportReady:true});
  assert.deepEqual(groundPaintReceiverMaterialPolicy(receiver,claim), {minimumRank:0,maximumRank:30});
  assert.equal(groundPaintReceiverAcceptsPaint(receiver,claim,run('forest').records[0]),true);
  assert.equal(groundPaintReceiverAcceptsPaint(receiver,claim,run('parking').records[0]),false);
  assert.equal(groundPaintReceiverAcceptsClaim(receiver,claim),false);
  assert.equal(groundPaintReceiverMaterialPolicy(receiver,{...claim,verticalRelation:'grade-separated'}),null);
  assert.equal(claim.capabilities.support,true);
});
