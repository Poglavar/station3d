// Atomic producer owner moves, removal and source identity rejection.
import test from 'node:test'; import assert from 'node:assert/strict';
import { groundPaintOwnerReplacementsSteps } from '../core/ground-paint-owner-set.js';
const run=(a,b)=>{const g=groundPaintOwnerReplacementsSteps(Object.freeze(a),Object.freeze(b));let n=g.next();while(!n.done)n=g.next();return n.value};
const row=(bucketKey,owner,canonical=owner)=>({bucketKey,owner,canonical,records:Object.freeze([])});
test('owner move emits tombstone and leaves distinct producers intact',()=>{const rows=run([row('a','x'),row('a','keep')],[row('b','x','x'),row('a','keep')]);assert.deepEqual(rows.map(r=>[r.bucketKey,r.owner,r.records]),[['b','x',rows[0].records],['a','keep',rows[1].records],['a','x',null]]);});
test('removed owners and collisions are rejected',()=>{assert.equal(run([row('a','gone')],[])[0].records,null);assert.throws(()=>run([row('a','x','old')],[row('a','x','new')]),/collision/);assert.throws(()=>run([], [row('a','x'),row('a','x')]),/Duplicate/);});
