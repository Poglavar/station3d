import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createFacadeTopologyCache,
    createFacadeTopologyCacheForGeometry,
    facadeGeometrySignature,
    facadeWallTrianglesFromGeometry,
    restoreFacadeTopologyCache,
} from '../core/facade-topology-cache.js';
import { buildLogicalFacadeSurfaces, mergeDuplicateWallSurfaces } from '../world/facade-surfaces.js';

function strip(x0, x1, z = 0) {
    const a = [x0, 0, z], b = [x1, 0, z];
    const c = [x1, 10, z], d = [x0, 10, z];
    return [[a, b, c], [a, c, d]];
}

const geometry = {
    type: 'MultiPolygon',
    coordinates: [
        [[[16, 43, 5], [16.0001, 43, 5], [16.0001, 43, 15], [16, 43, 15], [16, 43, 5]]],
        [[[16.0001, 43, 5], [16.0001, 43.0001, 5], [16.0001, 43.0001, 15], [16.0001, 43, 15], [16.0001, 43, 5]]],
    ],
};

test('versioned facade topology restores the same logical wall bounds', () => {
    const triangles = [
        // Two disconnected components share one fitted plane. An overlapping,
        // nearly coplanar patch exercises the final duplicate-surface merge.
        ...strip(0, 2),
        ...strip(5, 7),
        ...strip(0.5, 1.5, 0.01),
        ...strip(0, 8, 4),
    ];
    const expected = mergeDuplicateWallSurfaces(buildLogicalFacadeSurfaces(triangles));
    const cache = createFacadeTopologyCache(triangles, geometry);
    const restored = restoreFacadeTopologyCache(triangles, cache);
    assert.ok(restored);
    assert.equal(restored.length, expected.length);
    const summarize = (surfaces) => surfaces.map((surface) => ({
        nx: Number(surface.nx.toFixed(9)),
        nz: Number(surface.nz.toFixed(9)),
        d: Number(surface.d.toFixed(9)),
        minU: Number(surface.minU.toFixed(6)),
        maxU: Number(surface.maxU.toFixed(6)),
        minV: Number(surface.minV.toFixed(6)),
        maxV: Number(surface.maxV.toFixed(6)),
        triangles: surface.worldTriangles.length,
    }));
    assert.deepEqual(summarize(restored), summarize(expected));
});

test('cache signatures track geometry and runtime rejects incompatible membership', () => {
    const triangles = strip(0, 10);
    const cache = createFacadeTopologyCache(triangles, geometry);
    const changed = structuredClone(geometry);
    changed.coordinates[0][0][1][0] += 0.00001;
    assert.match(cache.geometry, /^f5:/);
    assert.notEqual(facadeGeometrySignature(changed), cache.geometry);
    assert.equal(restoreFacadeTopologyCache([...triangles, ...strip(10, 11)], cache), null);
    assert.equal(restoreFacadeTopologyCache(triangles, {
        ...cache,
        surfaces: [{ fit: 0, triangles: [0, 0] }],
    }), null);
    assert.equal(restoreFacadeTopologyCache(triangles, {
        ...cache,
        fits: [{ triangles: [0] }],
        surfaces: [{ fit: 0, triangles: [0, 1] }],
    }), null);
    assert.equal(restoreFacadeTopologyCache(triangles, {
        ...cache,
        surfaces: [{ fit: 0, triangles: [0] }],
    }), null);
});

test('producer helper and browser restore share one geometry contract', () => {
    const triangles = facadeWallTrianglesFromGeometry(geometry, 5);
    const cache = createFacadeTopologyCacheForGeometry(geometry, 5);
    assert.equal(cache.wall_triangles, triangles.length);
    assert.ok(cache.fits.length >= 2);
    assert.ok(cache.surfaces.length >= 2);
    assert.ok(restoreFacadeTopologyCache(triangles, cache));
});
