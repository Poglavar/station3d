import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const liveSource = readFileSync(new URL('../world/rails.js', import.meta.url), 'utf8');
const source = process.env.RAIL_GROUND_REFRESH_OLD_CODE === '1'
    ? liveSource.replace("if (groundManaged) return groundCoordinator.invalidate('rails', { reason: 'rail-visual-refresh' });", 'if (false) return groundCoordinator.invalidate(\'rails\', { reason: \'rail-visual-refresh\' });')
    : liveSource;
function extract(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} exists`);
    const brace = source.indexOf('{', start);
    let depth = 0;
    for (let i = brace; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error(`unterminated ${name}`);
}
function harness({ managed }) {
    const invalidations = [];
    const ctx = vm.createContext({ Promise, setTimeout, console });
    vm.runInContext(`
        let groundManaged = ${managed};
        let groundCoordinator = { invalidate: (family, changes) => { invalidations.push({family, changes}); return 'queued'; } };
        let lastFeatures = [{ id: 'viaduct' }];
        let lastRailFormation = { getViaductRuns: () => [{ id: 'run' }] };
        let lastAnchorLat = 45, lastAnchorLon = 16, railSessionToken = 1;
        let pillarClearanceReady = false, pillarClearanceLoading = false, lastPillarClearance = null;
        let pendingRailVisualRefresh = null, lastRenderCenterX = 3, lastRenderCenterZ = 4;
        let roadIndexCalls = 0;
        function discardPendingRailVisualRefresh() { pendingRailVisualRefresh = null; }
        const invalidations = ${JSON.stringify(invalidations)};
        function ensureRoadIndex() { roadIndexCalls++; return Promise.resolve(); }
        function createPillarClearanceEvaluator(lat, lon, features) { return { lat, lon, features }; }
    `, ctx);
    vm.runInContext(`${extract('rebuildVisibleRails')}\n${extract('ensurePillarClearanceForFormation')}`, ctx);
    return { ctx, invalidations };
}

// This executes the production function bodies with only their external world
// state supplied by the fixture; no source-text assertion can prove this gate.
test('managed late pillar clearance queues one ground invalidation and no ordinary visual request', async () => {
    const h = harness({ managed: true });
    const result = await vm.runInContext(`ensurePillarClearanceForFormation(lastFeatures); 'done'`, h.ctx);
    assert.equal(result, 'done');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(vm.runInContext('pillarClearanceReady', h.ctx), true);
    assert.equal(vm.runInContext('pendingRailVisualRefresh', h.ctx), null);
    assert.equal(vm.runInContext('roadIndexCalls', h.ctx), 1);
    assert.equal(vm.runInContext('invalidations.length', h.ctx), 1);
    assert.equal(vm.runInContext('invalidations[0].family', h.ctx), 'rails');
    assert.equal(vm.runInContext('invalidations[0].changes.reason', h.ctx), 'rail-visual-refresh');
});

test('unmanaged late pillar clearance defers the ordinary visual replacement', async () => {
    const h = harness({ managed: false });
    vm.runInContext('ensurePillarClearanceForFormation(lastFeatures); rebuildVisibleRails()', h.ctx);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(vm.runInContext('pendingRailVisualRefresh?.reason', h.ctx), 'requested');
    assert.equal(vm.runInContext('pendingRailVisualRefresh.reason', h.ctx), 'requested');
    assert.equal(vm.runInContext('invalidations.length', h.ctx), 0);
});

test('rebuild has no effect when no rail features exist', () => {
    const h = harness({ managed: true });
    assert.equal(vm.runInContext('lastFeatures = null; rebuildVisibleRails()', h.ctx), false);
    assert.equal(vm.runInContext('invalidations.length', h.ctx), 0);
    assert.equal(vm.runInContext('pendingRailVisualRefresh', h.ctx), null);
});
