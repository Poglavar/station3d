// Locks the watertight shared edge between a roadside surface and adjacent ground.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import {
    buildRoadsideSurfaceTerrainSeamGeometryData,
} from '../core/roadside-surface-seam.js';

const squarePositions = new Float32Array([
    0, 1, 0,
    4, 1, 0,
    4, 1, 4,
    0, 1, 4,
]);
const squareIndices = new Uint16Array([0, 1, 2, 0, 2, 3]);

test('sidewalk seam shares the exact paved boundary and lands outside on ground', () => {
    const seam = buildRoadsideSurfaceTerrainSeamGeometryData({
        positions: squarePositions,
        indices: squareIndices,
        landingWidthM: 0.5,
        terrainOverlapM: 0.02,
        landingSceneYAtLocal: (x, z) => 2 + x * 0.1 + z * 0.05,
    });

    assert.equal(seam.ready, true);
    assert.equal(seam.boundaryEdgeCount, 4, 'the interior diagonal is not a seam');
    assert.equal(seam.emittedEdgeCount, 4);
    assert.equal(seam.positions.length, 4 * 2 * 3 * 3);

    const pavedCorners = new Set(['0,0', '4,0', '4,4', '0,4']);
    for (let edge = 0; edge < seam.emittedEdgeCount; edge += 1) {
        const offset = edge * 18;
        const topA = `${seam.positions[offset]},${seam.positions[offset + 2]}`;
        const topB = `${seam.positions[offset + 15]},${seam.positions[offset + 17]}`;
        assert.ok(pavedCorners.has(topA));
        assert.ok(pavedCorners.has(topB));
        assert.equal(seam.positions[offset + 1], 1);
        assert.equal(seam.positions[offset + 16], 1);

        for (const landingOffset of [offset + 3, offset + 6]) {
            const x = seam.positions[landingOffset];
            const y = seam.positions[landingOffset + 1];
            const z = seam.positions[landingOffset + 2];
            assert.ok(x <= -0.49 || x >= 4.49 || z <= -0.49 || z >= 4.49,
                `landing ${x},${z} must be outside the paved ring`);
            assert.ok(Math.abs(y - (2 + x * 0.1 + z * 0.05 - 0.02)) < 1e-9);
        }
    }
});

test('sidewalk seam can suppress the carriageway side without opening the terrain side', () => {
    const seam = buildRoadsideSurfaceTerrainSeamGeometryData({
        positions: squarePositions,
        indices: squareIndices,
        landingWidthM: 0.5,
        landingSceneYAtLocal: () => 0,
        segmentKeep: ({ outerMidZ }) => outerMidZ > -0.1,
    });
    assert.equal(seam.ready, true);
    assert.equal(seam.boundaryEdgeCount, 4);
    assert.equal(seam.emittedEdgeCount, 3, 'only the edge landing on asphalt yields');
});

test('sidewalk seam waits rather than publishing a partial open edge', () => {
    const seam = buildRoadsideSurfaceTerrainSeamGeometryData({
        positions: squarePositions,
        indices: squareIndices,
        landingSceneYAtLocal: (x) => x > 4 ? null : 0,
    });
    assert.equal(seam.ready, false);
    assert.deepEqual(seam.positions, []);
    assert.equal(seam.emittedEdgeCount, 0);
});

test('the road adapter finishes flat-world seams and keeps unavailable terrain deferred', () => {
    const source = readFileSync(new URL('../world/roads.js', import.meta.url), 'utf8');
    const start = source.indexOf('function appendRoadRingTerrainSeam(');
    const code = source.slice(start, source.indexOf('\nfunction appendRoadRingCollar', start));
    const material = new THREE.MeshBasicMaterial();
    const append = Function('THREE', 'finiteOrNull', 'CIVIL_GROUND_AUTHORITY',
        'buildRoadsideSurfaceTerrainSeamGeometryData', 'buildWorldXZUvsForPositions',
        'getActiveTerrainSurface', 'getSidewalkTerrainSeamMaterial', 'markSidewalkTerrainSeamClaim',
        'SURFACE_RENDER_ORDER', `${code}; return appendRoadRingTerrainSeam;`)(
        THREE, value => typeof value === 'number' && Number.isFinite(value) ? value : null,
        { PATH: 'path' }, buildRoadsideSurfaceTerrainSeamGeometryData,
        positions => new Float32Array(positions.length / 3 * 2), () => ({ uvPerM: 1 }),
        () => material, () => {}, { ROAD_EARTHWORK: 0 });
    const surface = new THREE.BufferGeometry();
    surface.setAttribute('position', new THREE.BufferAttribute(squarePositions, 3));
    surface.setIndex(new THREE.BufferAttribute(squareIndices, 1));
    const group = new THREE.Group(), ctx = { ground: { terrain: null }, featureGroup: group, type: 'footway' };
    try {
        assert.equal(append(ctx, surface), 'done');
        assert.equal(group.children.length, 1);
        const ys = Array.from(group.children[0].geometry.attributes.position.array).filter((_, i) => i % 3 === 1);
        assert.ok(ys.some(y => Math.abs(y + .025) < 1e-6), 'the seam lands just beneath the known flat plane');
        ctx.ground.terrain = { evidenceSceneYAtLocal: () => null, hasLoadedCoreCoverageAtLocal: () => false };
        assert.equal(append(ctx, surface), 'defer');
        assert.equal(group.children.length, 1, 'missing terrain cannot publish a fabricated seam');
    } finally {
        surface.dispose(); material.dispose();
        for (const mesh of group.children) mesh.geometry.dispose();
    }
});
