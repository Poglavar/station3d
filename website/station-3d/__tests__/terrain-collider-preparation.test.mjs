// Preserve pre-refactor terrain geometry and exercise cooperative work/lifetimes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/terrain-collider-before-scheduling.json' with { type: 'json' };
import { sampleTerrainColliderGridSteps, buildTerrainColliderMeshSteps } from '../core/terrain-collider-grid.js';
import { buildFormationTerrainCutoutQuerySteps } from '../core/formation-terrain-cutout-query.js';
import { createBoundsGridSteps } from '../core/bounds-grid.js';

function run(gen) { let n; do n = gen.next(); while (!n.done); return n.value; }
function clock() { let t = 0; return { now: () => (t += 1), get value() { return t; } }; }
function scene(f) {
  const clocker = clock(); let calls = 0;
  const sample = (x, z) => { calls++; if (f.name === 'bounded-missing-corner' && x < -.5 && z < -.5) return NaN; return f.name === 'step-1-quadratic-bubble' ? .1*x*x+.3*z : f.name === 'bounded-missing-corner' ? 2+x+z : .2*x-.1*z; };
  const heights = run(sampleTerrainColliderGridSteps({ columns: 4, rows: 4, startX: -2, startZ: -2, step: 1, sample, bounded: f.name === 'bounded-missing-corner', now: clocker.now }));
  const cutout = f.name === 'broad-formation-cutout' ? { contains: (x,z) => x > -1.5 && x < 1.5 && z > -1.5 && z < 1.5 } : { contains: () => false };
  const mesh = run(buildTerrainColliderMeshSteps({ columns: 4, rows: 4, startX: -2, startZ: -2, step: 1, heights, cutoutQuery: cutout, now: clocker.now }));
  assert.deepEqual([...mesh.vertices], f.vertices); assert.deepEqual([...mesh.indices], f.indices); assert.ok(calls === 25); return { clocker, calls };
}
test('step builders preserve frozen independent terrain outputs', () => { for (const f of fixture.fixtures) scene(f); });
test('sampling and meshing yield within budget and cancel cleanly', () => {
  let tick = 0, current = true, samples = 0; const gen = sampleTerrainColliderGridSteps({ columns: 20, rows: 20, startX: 0, startZ: 0, step: 1, sample: () => { samples++; return 1; }, now: () => ++tick, isCurrent: () => current });
  let yielded = 0, n; while (!(n = gen.next()).done) { yielded++; assert.equal(n.value.phase, 'ground-terrain-sample'); current = false; }
  assert.equal(n.value, null); assert.equal(yielded, 1); assert.equal(samples, 1);
  const cancelled = buildTerrainColliderMeshSteps({ columns: 4, rows: 4, startX: -2, startZ: -2, step: 1, heights: new Float64Array(25).fill(1), now: () => ++tick, isCurrent: () => false });
  assert.equal(cancelled.next().value, null);
  const phases = [], mesh = buildTerrainColliderMeshSteps({ columns: 4, rows: 4, startX: -2, startZ: -2, step: 1, heights: new Float64Array(25).fill(1), now: () => ++tick });
  let step; while (!(step = mesh.next()).done) phases.push(step.value.phase);
  assert.ok(phases.includes('ground-terrain-vertices') && phases.includes('ground-terrain-triangles'));
});
test('cutout steps detach rings and bounds grid handles small and oversized bounds', () => {
  // Purpose: prove the queued query owns immutable geometry, including the
  // excavation ring and its paved clip, across a live model mutation.
  const outer = [{x:-2,z:-2},{x:2,z:-2},{x:2,z:2},{x:-2,z:2}], clip = [{x:-1,z:-1},{x:1,z:-1},{x:1,z:1},{x:-1,z:1}];
  const model = { getSurfaceProfiles: () => [{ innerRing: clip, terrainCutoutRing: clip, points: [], terrainExcavationRegions: [{ ring: outer, replacementBackstopReady: true, clipToPavedSurface: true }] }] };
  const q = run(buildFormationTerrainCutoutQuerySteps({ models:[model], centerX:0, centerZ:0, radiusM:4, now: () => 1 }));
  assert.equal(q.contains(.5, 0), true); assert.equal(q.contains(1.5, 0), false); assert.equal(q.contains(3, 0), false);
  for (const p of [...outer, ...clip]) { p.x = 99; p.z = 99; }
  assert.equal(q.contains(.5, 0), true); assert.equal(q.contains(1.5, 0), false); assert.equal(q.contains(3, 0), false);
  const grid = run(createBoundsGridSteps([{ id:'small', bounds:{minX:-1,maxX:1,minZ:-1,maxZ:1} }, { id:'big', bounds:{minX:-100,maxX:100,minZ:-100,maxZ:100} }], { cellM: 1, now: () => 1 }));
  assert.deepEqual(grid.candidatesAt(0,0).map(x=>x.id).sort(), ['big','small']); assert.deepEqual(grid.candidatesAt(50,50).map(x=>x.id), ['big']);
});
