// The runtime shore probe reads heights from claimed ground only: a bench,
// a tree or the walker above the promenade must never become "the ground".

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { markSurfaceClaim } from '../core/surface-claim.js';
import { SURFACE_CLASS, SURFACE_COVERAGE_STATE, SURFACE_VERTICAL_RELATION } from '../core/surface-hierarchy.js';
import { claimedGroundTopYAt, runShoreAudit } from '../debug/shore-audit.js';
import { SHORE_KIND } from '../core/shore-formation-audit.js';

const claim = { surfaceClass: SURFACE_CLASS.TERRAIN, coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
    verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL };
// A flat slab whose top sits at `topY`, spanning z from z0 to z1 across x ±50.
function slab(topY, z0, z1, { claimed = true } = {}) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(100, 1, z1 - z0), new THREE.MeshBasicMaterial());
    mesh.position.set(0, topY - 0.5, (z0 + z1) / 2);
    if (claimed) markSurfaceClaim(mesh, claim);
    mesh.updateMatrixWorld(true);
    return mesh;
}
const quad = { shoreA: [-2, 0], shoreB: [2, 0], landA: [-2, 4.5], landB: [2, 4.5] };
const seaY = -0.738;

test('props above the ground are not the ground', () => {
    const scene = new THREE.Scene();
    scene.add(slab(-0.05, 0.5, 30));
    scene.add(slab(5, 0.5, 30, { claimed: false }));
    scene.updateMatrixWorld(true);
    assert.ok(Math.abs(claimedGroundTopYAt(scene, 0, 8) + 0.05) < 1e-6);
    assert.equal(claimedGroundTopYAt(scene, 0, -5), null, 'nothing claimed seaward of the shore');
});

test('a paved shore with a deck is clean; a collar ramp behind paving is ramped', () => {
    const deck = new THREE.Scene();
    deck.add(slab(-0.038, 0.5, 30));
    deck.updateMatrixWorld(true);
    const clean = runShoreAudit({ scene: deck, quads: [quad], seaY, pavedAt: () => true });
    assert.equal(clean.rampedCount, 0);
    assert.deepEqual(clean.byKind, { [SHORE_KIND.CLEAN]: 1 });

    const ramp = new THREE.Scene();
    ramp.add(slab(-0.6, 0.5, 2));     // the collar band, still near sea level a metre inland
    ramp.add(slab(-0.05, 2, 30));     // the promenade grade behind it
    ramp.updateMatrixWorld(true);
    const faulty = runShoreAudit({ scene: ramp, quads: [quad], seaY, pavedAt: () => true });
    assert.equal(faulty.rampedCount, 1);
    assert.equal(faulty.ramped[0].kind, SHORE_KIND.RAMPED);
    // The same ramp on a natural bank is not a fault.
    assert.equal(runShoreAudit({ scene: ramp, quads: [quad], seaY, pavedAt: () => false }).rampedCount, 0);
});
