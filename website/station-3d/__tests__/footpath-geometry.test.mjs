// Headless unit tests for footpath chain building, smoothing and ribbon
// stations. Run: npm run test:unit (in website/station-3d).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildChainsFromSegments,
    densifyChain,
    smoothChain,
    computeRibbonStations,
    MITER_LIMIT,
} from '../world/footpath-geometry.js';

const seg = (x1, z1, x2, z2, width = 2) => ({ x1, z1, x2, z2, width });

test('segment soup joins into one chain regardless of order and direction', () => {
    const chains = buildChainsFromSegments([
        seg(10, 0, 20, 0),
        seg(0, 0, 10, 0),
        seg(30, 5, 20, 0),   // reversed direction
    ]);
    assert.equal(chains.length, 1);
    assert.equal(chains[0].points.length, 4);
    const xs = chains[0].points.map((p) => p.x);
    assert.deepEqual([Math.min(...xs), Math.max(...xs)], [0, 30]);
});

test('junction of three ways ends the chains there and flags it', () => {
    const chains = buildChainsFromSegments([
        seg(-10, 0, 0, 0),
        seg(0, 0, 10, 0),
        seg(0, 0, 0, 10),
    ]);
    assert.equal(chains.length, 3);
    for (const chain of chains) {
        const touchesJunction = chain.points.some((p) => Math.hypot(p.x, p.z) < 0.3);
        assert.ok(touchesJunction);
        assert.ok(chain.startsAtJunction || chain.endsAtJunction);
    }
});

test('near-coincident endpoints snap together within the join epsilon', () => {
    const chains = buildChainsFromSegments([
        seg(0, 0, 10, 0),
        seg(10.05, 0.05, 20, 0),
    ]);
    assert.equal(chains.length, 1);
    assert.equal(chains[0].points.length, 3);
});

test('smoothing preserves endpoints and shortens the corner', () => {
    const points = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }];
    const { points: sm } = smoothChain(points, [2, 2, 2], 2);
    assert.deepEqual(sm[0], { x: 0, z: 0 });
    assert.deepEqual(sm[sm.length - 1], { x: 10, z: 10 });
    // no smoothed point reaches the sharp corner itself
    const cornerDist = Math.min(...sm.map((p) => Math.hypot(p.x - 10, p.z - 0)));
    assert.ok(cornerDist > 1, `corner should be cut, min dist ${cornerDist}`);
});

test('densifies long terrain spans and interpolates path width', () => {
    const dense = densifyChain(
        [{ x: 0, z: 0 }, { x: 25, z: 0 }],
        [1, 3],
        10,
    );
    assert.deepEqual(dense.points.map((point) => Number(point.x.toFixed(3))), [0, 8.333, 16.667, 25]);
    assert.deepEqual(dense.widths.map((width) => Number(width.toFixed(3))), [1, 1.667, 2.333, 3]);
});

test('ribbon stations keep arc length monotonic and cap the miter', () => {
    const points = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10.5, z: 0.1 }, { x: 11, z: 10 }];
    const stations = computeRibbonStations(points, [2, 2, 2, 2]);
    for (let i = 1; i < stations.length; i++) {
        assert.ok(stations[i].arc > stations[i - 1].arc);
    }
    for (const s of stations) {
        assert.ok(s.halfWidth <= 1 * MITER_LIMIT + 1e-9);
        assert.ok(Math.abs(Math.hypot(s.nx, s.nz) - 1) < 1e-6);
    }
});
