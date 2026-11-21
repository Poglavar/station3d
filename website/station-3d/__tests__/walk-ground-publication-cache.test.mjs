// Controller support caches must observe a complete publication in the same frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createGroundPublicationBoundary} from '../core/ground-publication-boundary.js';

const source=readFileSync(new URL('../modes/cab.js',import.meta.url),'utf8');
const start=source.indexOf('    const publication = state.cabState?.groundPublications?.revision ?? 0;');
const end=source.indexOf('    const rayTopY = Number.isFinite(walkerY)',start);
assert.ok(start>=0&&end>start,'actual walk cache guard is present');
const guard=source.slice(start,end);

function makeGuard(boundary){
  const state={cabState:{groundPublications:boundary}};
  const walkGroundCache=new Map(), walkGroundPositionCache=new Map();
  const context={state,performance:{now:()=>1},_walkGroundCacheSession:null,
    _walkGroundCachePublication:null,_walkGroundCacheStamp:0,_WALK_GROUND_CACHE_LIFETIME_MS:500,
    _walkGroundCache:walkGroundCache,_walkGroundPositionCache:walkGroundPositionCache,
    _WALK_GROUND_CACHE_QUANT:.25};
  const run=new Function('ctx',`with(ctx){const now=performance.now();${guard} return {session:_walkGroundCacheSession,publication:_walkGroundCachePublication,stamp:_walkGroundCacheStamp};}`);
  return {state,walkGroundCache,walkGroundPositionCache,run:()=>run(context)};
}

test('walk support cache guard follows real ground publication revision',()=>{
  const boundary=createGroundPublicationBoundary({now:()=>0});
  const guard=makeGuard(boundary);
  guard.walkGroundCache.set('support',12); guard.walkGroundPositionCache.set('position',12);
  guard.run();
  assert.equal(guard.walkGroundCache.size,0); assert.equal(guard.walkGroundPositionCache.size,0);
  guard.walkGroundCache.set('support',12); guard.walkGroundPositionCache.set('position',12); guard.run();
  assert.equal(guard.walkGroundCache.size,1); assert.equal(guard.walkGroundPositionCache.size,1);
  const ticket=boundary.enqueue({state:'staged',publish(){return {status:'published'};},discard(){}});
  assert.ok(ticket); boundary.publishReady();
  guard.run();
  assert.equal(boundary.revision,1); assert.equal(guard.walkGroundCache.size,0); assert.equal(guard.walkGroundPositionCache.size,0);
  guard.walkGroundCache.set('support',12); guard.walkGroundPositionCache.set('position',12);
  const rejected=boundary.enqueue({state:'staged',publish(){return {status:'rejected'};},discard(){}});
  assert.ok(rejected); boundary.publishReady(); guard.run();
  assert.equal(boundary.revision,1); assert.equal(guard.walkGroundCache.size,1); assert.equal(guard.walkGroundPositionCache.size,1);
});
