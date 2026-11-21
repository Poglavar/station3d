import test from 'node:test';
import assert from 'node:assert/strict';
import { auditTilePoints, auditSourceCoverage } from '../core/surface-audit-readiness.js';

test('local readiness includes missing boundary tiles and ignores distant prefetch failures', () => {
    const bounds = { minX: -1, maxX: 200, minZ: -1, maxZ: 1 };
    assert.deepEqual(auditTilePoints(bounds).map(point => point.key), ['-1_-1', '0_-1', '-1_0', '0_0']);
    const source = { tileM: 200, tiles: new Map([['-1_-1', { status: 'loaded' }],
        ['0_-1', { status: 'building' }], ['0_0', { status: 'loaded' }]]), failed: new Map([['10_10', {}]]) };
    let result = auditSourceCoverage(source, bounds);
    assert.equal(result.pending, 2); assert.equal(result.failed, 0);
    source.tiles.set('0_-1', { status: 'loaded' }); source.tiles.set('-1_0', { status: 'loaded' });
    assert.equal(auditSourceCoverage(source, bounds).pending, 0);
    source.failed.set('0_0', {}); assert.equal(auditSourceCoverage(source, bounds).failed, 1);
});

test('probe points cover exactly each intersecting tile at that source resolution', () => {
    const points = auditTilePoints({ minX: 195, maxX: 205, minZ: 395, maxZ: 405 }, 400);
    assert.deepEqual(points, [{ key: '0_0', x: 200, z: 397.5 }, { key: '0_1', x: 200, z: 402.5 }]);
    assert.throws(() => auditTilePoints({ minX: 0, maxX: NaN, minZ: 0, maxZ: 1 }), TypeError);
});
