// Terrain invalidation must update real curb/manhole vertices and support together,
// while skipped readiness, cancellation and supersession retain the old publication.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurfaceRebuildLedger, surfaceChangesFromTerrainEvent, commitSurfaceRebuild } from '../core/surface-rebuild-ledger.js';
import { TerrainReference, TerrainGrid, CompositeTerrainGrid } from '../core/terrain-grid.js';
import { stepCurbTerrainDrape } from '../core/curb-terrain-drape.js';
import { pushManholesAlongRun } from '../world/manholes.js';
import { boundsIntersectWithPadding } from '../core/tile-stream.js';

const grid = (height, bounds) => new TerrainGrid({ grid: { width: 2, height: 2, bounds },
    encoding: { type: 'uint16', scaleM: 1, offsetM: 0, noDataValue: 65535 } }, new Uint16Array(4).fill(height).buffer);

test('coarse→fine terrain event refreshes affected curb, cover and support vertices only', () => {
    const base = grid(100, { west: 15, east: 16, south: 45, north: 46 });
    const terrain = new TerrainReference(base, 15.5, 45.5, { surfaceStepM: 4 });
    const ledger = createSurfaceRebuildLedger();
    const tiles = new Map([['near', { minX: 0, maxX: 200, minZ: 0, maxZ: 200 }],
        ['far', { minX: 1000, maxX: 1200, minZ: 0, maxZ: 200 }]]);
    const published = new Map();
    const build = key => {
        const x = tiles.get(key).minX;
        const curb = [x + 10, 0.12, 10, x + 10, 0.12, 11, x + 11, 0.12, 10];
        const covers = { positions: [], uvs: [] };
        pushManholesAlongRun(covers, { points: [{ x: x + 1, z: 10 }, { x: x + 199, z: 10 }] });
        assert.ok(covers.positions.length > 0, 'exercise the actual manhole geometry generator');
        for (const positions of [curb, covers.positions]) {
            const item = { positions };
            while (!stepCurbTerrainDrape(item, (_state, px, pz) => terrain.evidenceSceneYAtLocal(px, pz))) {}
        }
        return { curb: new Float32Array(curb), covers: new Float32Array(covers.positions), support: new Float32Array(curb) };
    };
    for (const key of tiles.keys()) published.set(key, build(key));
    const previous = new Map(published);
    const bounds = { minX: -20, maxX: 220, minZ: -20, maxZ: 220 };
    terrain.onChange((revision, event) => {
        const change = surfaceChangesFromTerrainEvent(event);
        assert.equal(change.full, false, 'the real TerrainReference event contains an array');
        for (const [key, tileBounds] of tiles) if (change.bounds.some(rect => boundsIntersectWithPadding(tileBounds, rect, 15))) ledger.mark(key, revision);
    });
    const nw = terrain.lonLatAtLocal(bounds.minX, bounds.minZ);
    const se = terrain.lonLatAtLocal(bounds.maxX, bounds.maxZ);
    const detail = grid(105, { west: nw.lon, east: se.lon, south: se.lat, north: nw.lat });
    assert.equal(terrain.sampleStepMAtLocal(10, 10), 4);
    terrain.replaceGrid(new CompositeTerrainGrid(base, [detail], { blendMarginM: 0, sourceBlendMarginM: 0 }), {
        changedBounds: bounds, detail: { ...bounds, stepM: 1, tileM: 200 },
    });
    assert.equal(terrain.sampleStepMAtLocal(10, 10), 1);
    assert.equal(terrain.sampleStepMAtLocal(1010, 10), 4);
    assert.equal(ledger.isPending('near'), true);
    assert.equal(ledger.isPending('far'), false);
    const candidate = build('near');
    assert.equal(published.get('near'), previous.get('near'), 'preparing is not publication');
    assert.equal(commitSurfaceRebuild({ ledger, tileKey: 'near', revision: 1, isCurrent: () => true,
        publish: acknowledge => { published.set('near', candidate); acknowledge(); } }), true);
    assert.equal(ledger.size, 0);
    assert.equal(published.get('far'), previous.get('far'));
    for (const kind of ['curb', 'covers', 'support']) {
        for (let index = 0; index < candidate[kind].length; index++) {
            const delta = candidate[kind][index] - previous.get('near')[kind][index];
            assert.ok(Math.abs(delta - (index % 3 === 1 ? 5 : 0)) < 1e-5, `${kind} coordinate ${index}`);
        }
    }
    assert.deepEqual(candidate.curb, candidate.support, 'visual and support publication use the same corrected vertices');
});

test('same-tile newer invalidation survives old completion and cannot publish stale geometry', () => {
    const ledger = createSurfaceRebuildLedger();
    ledger.mark('a', 1); const revision = ledger.requested('a');
    ledger.mark('a', 2);
    let active = 'old';
    assert.equal(commitSurfaceRebuild({ ledger, tileKey: 'a', revision, isCurrent: () => true,
        publish: acknowledge => { active = 'stale'; acknowledge(); } }), false);
    assert.equal(active, 'old'); assert.equal(ledger.pendingRevision('a'), 2);
    assert.equal(ledger.shouldRequest('a'), true);
    ledger.requested('a'); ledger.settled('a', 1);
    assert.equal(ledger.shouldRequest('a'), false, 'old completion cannot reset the newer scheduled request');
    assert.equal(commitSurfaceRebuild({ ledger, tileKey: 'a', revision: 2, isCurrent: () => true,
        publish: acknowledge => { active = 'fine'; acknowledge(); } }), true);
    assert.equal(active, 'fine'); assert.equal(ledger.size, 0);
});

test('unready tiles retain obligations; in-flight or failed work cannot cause retry storms', () => {
    const ledger = createSurfaceRebuildLedger();
    ledger.mark('unready', 1); ledger.mark('ready', 1);
    assert.deepEqual([ledger.nextTile(), ledger.nextTile()], ['unready', 'ready']);
    assert.equal(ledger.shouldRequest('unready'), true);
    ledger.requested('ready');
    for (let frame = 0; frame < 100; frame++) assert.equal(ledger.shouldRequest('ready'), false);
    ledger.settled('ready', 1, { failed: true });
    for (let frame = 0; frame < 100; frame++) assert.equal(ledger.shouldRequest('ready'), false);
    assert.equal(ledger.isPending('ready'), true);
    ledger.mark('ready', 2); assert.equal(ledger.shouldRequest('ready'), true);
    ledger.forget('unready'); assert.equal(ledger.size, 1);
});

test('failed or superseded publication keeps the previous owner and pending work', () => {
    for (const mode of ['cancel', 'supersede', 'no-commit', 'throw']) {
        const ledger = createSurfaceRebuildLedger(); ledger.mark('a', 1);
        const options = { ledger, tileKey: 'a', revision: 1, cancelled: mode === 'cancel', isCurrent: () => mode !== 'supersede',
            publish: () => { if (mode === 'throw') throw new Error('candidate failed'); } };
        if (mode === 'throw') assert.throws(() => commitSurfaceRebuild(options), /candidate failed/);
        else assert.equal(commitSurfaceRebuild(options), false);
        assert.equal(ledger.pendingRevision('a'), 1);
    }
});
