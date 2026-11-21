import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { captureReceiverMeshReadSteps } from '../core/receiver-mesh-read.js';
import { captureStationGroundOpeningsSteps } from '../core/station-ground-openings.js';
import { createSurfaceOpeningReadSteps } from '../core/surface-opening-read.js';
import { captureSurfaceEntranceCuts } from '../core/surface-opening-shapes.js';
import { GROUND_GENERATION_LIMITS } from '../core/ground-generation-limits.js';
import { SURFACE_CLASS, SURFACE_VERTICAL_RELATION, SURFACE_COVERAGE_STATE } from '../core/surface-hierarchy.js';

const drain = steps => { for (;;) { const next = steps.next(); if (next.done) return next.value; } };
const claim = { surfaceClass: SURFACE_CLASS.TERRAIN, coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
    verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL };
const limits = GROUND_GENERATION_LIMITS.openings;
function fixture({ slope = .2, reverse = false, originX = 0, originZ = 0 } = {}) {
    const root = new THREE.Group(), geometry = new THREE.PlaneGeometry(2, 8);
    root.position.set(originX, 0, originZ);
    geometry.rotateX(-Math.PI / 2);
    const position = geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) position.setY(i, 3 + slope * position.getZ(i));
    if (reverse) {
        const indices = geometry.index.array;
        for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
    }
    root.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));
    const supportRead = drain(captureReceiverMeshReadSteps({ root, include: () => true,
        revision: 1, ...GROUND_GENERATION_LIMITS.openingSupport }));
    const cuts = [{ x1: originX, z1: originZ-5, x2: originX, z2: originZ+5, widthM: 3, maxY: 7 }];
    return { supportRead, cuts, close() { geometry.dispose(); root.children[0].material.dispose(); } };
}

for (const origin of [0, 100000.321]) test(`station openings follow stored sloping floors and ceilings at ${origin}`, () => {
    const f = fixture({ originX: origin, originZ: -origin });
    try {
        const entrances = drain(captureStationGroundOpeningsSteps({ ...f, replacementKey: 'station:test', maxCuts: 16, limits }));
        const read = drain(createSurfaceOpeningReadSteps({ entrances, limits }));
        assert.ok(entrances.length > 0);
        for (const z of [-3, -1, 1, 3]) {
            const x = origin, worldZ = z-origin;
            const floorY = f.supportRead.supportYAt(x, worldZ, { maxY: Infinity });
            assert.ok(Math.abs(floorY - (3 + z * .2)) < 1e-6);
            assert.equal(read.contains(x, floorY - .01, worldZ, claim), false, 'lower terrain remains physical');
            assert.equal(read.contains(x, floorY + .01, worldZ, claim), true, 'soil above the real floor is removed');
            assert.equal(read.contains(x+1.2, floorY + .1, worldZ, claim), false, 'capsule alone cannot remove an unsupported rim');
            assert.equal(read.contains(x, 7, worldZ, claim), false, 'another level above the entrance survives');
            assert.equal(read.contains(x, floorY + .1, worldZ, { ...claim, replacementKey: 'station:test' }), false);
        }
        assert.equal(read.contains(origin, 6, 4.5-origin, claim), false, 'no floor beyond its stored endpoint');
    } finally { f.close(); }
});

test('station openings reject absent floors, malformed ceilings, over-capacity boundaries and superseded preparation', () => {
    const f = fixture({ reverse: true });
    try {
        const args = { ...f, replacementKey: 'station:test', maxCuts: 16, limits };
        assert.throws(() => drain(captureStationGroundOpeningsSteps(args)), { code: 'ground-backstop-unavailable' });
        assert.throws(() => captureSurfaceEntranceCuts([{ ...f.cuts[0], maxY: null }], 16), { code: 'ground-opening-coordinate' });
        assert.throws(() => drain(captureStationGroundOpeningsSteps({ ...args, limits: { ...limits, maxSourceVertices: 3 } })), { code: 'ground-opening-capacity' });
        let current = true, now = 0;
        const steps = captureStationGroundOpeningsSteps({ ...args, now: () => ++now, isCurrent: () => current });
        assert.equal(steps.next().done, false); current = false;
        assert.throws(() => steps.next(), { code: 'ground-opening-stale' });
    } finally { f.close(); }
});
