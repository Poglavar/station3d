// Exercise session cancellation, serialized teardown and recovery without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createExplorerSessionController } from '../core/explorer-session-controller.js';

const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
const flush = async () => {
    for (let index = 0; index < 5; index += 1) await new Promise(resolve => queueMicrotask(resolve));
};

const harness = (overrides = {}) => {
    const calls = [];
    const engine = {
        close: () => calls.push('close'),
        campaigns: {
            exit: async () => calls.push('exit'),
            openMenu: async () => calls.push('menu'),
            startCheckpoint: async (...args) => calls.push(['checkpoint', ...args]),
        },
        openGta: (...args) => { calls.push(['gta', ...args]); return true; },
    };
    const controller = createExplorerSessionController({
        loadEngine: async () => { calls.push('load'); return engine; },
        prepareOptions: async (...args) => { calls.push(['prepare', ...args]); return { camera: 1 }; },
        showMap: async () => calls.push('map'),
        showLoading: value => calls.push(['loading', value]),
        showError: (...args) => calls.push(['error', ...args]),
        campaignEnabled: () => true,
        ...overrides,
    });
    return { calls, engine, controller };
};

test('map never loads engine; GTA prepares and opens with returned options', async () => {
    const map = harness();
    await map.controller.transition({ kind: 'map' });
    assert.deepEqual(map.calls, [['loading', false], 'map']);
    const gta = harness();
    await gta.controller.transition({ kind: 'gta', lat: 1, lon: 2 });
    assert.deepEqual(gta.calls.filter(call => call === 'load' || call[0] === 'gta'), ['load', ['gta', 1, 2, { camera: 1 }]]);
});

test('delayed engine load becomes stale when map wins and never opens GTA', async () => {
    const load = deferred();
    const h = harness({ loadEngine: () => { h.calls.push('load'); return load.promise; } });
    const gta = h.controller.transition({ kind: 'gta', lat: 1, lon: 2 });
    await flush();
    const map = h.controller.transition({ kind: 'map' });
    load.resolve(h.engine);
    await Promise.all([gta, map]);
    assert.equal(h.calls.some(call => call[0] === 'gta'), false);
    assert.equal(h.calls.includes('map'), true);
});

test('delayed preparation is aborted by map and cannot open GTA', async () => {
    const prepare = deferred();
    let signal;
    const h = harness({ prepareOptions: (_request, context) => { signal = context.signal; h.calls.push('prepare'); return prepare.promise; } });
    const gta = h.controller.transition({ kind: 'gta', lat: 1, lon: 2 });
    await flush();
    const map = h.controller.transition({ kind: 'map' });
    assert.equal(signal.aborted, true);
    prepare.resolve({ camera: 2 });
    await Promise.all([gta, map]);
    assert.equal(h.calls.some(call => call[0] === 'gta'), false);
    assert.equal(h.calls.includes('map'), true);
});

test('map waits for a pending campaign checkpoint before exiting and showing the map', async () => {
    const checkpoint = deferred();
    const h = harness();
    h.engine.campaigns.startCheckpoint = (...args) => { h.calls.push(['checkpoint', ...args]); return checkpoint.promise; };
    const campaign = h.controller.transition({ kind: 'checkpoint', campaignId: 'c', checkpointId: 'p' });
    await flush();
    const map = h.controller.transition({ kind: 'map' });
    await flush();
    assert.equal(h.calls.includes('exit'), false);
    assert.equal(h.calls.includes('map'), false);
    checkpoint.resolve();
    await Promise.all([campaign, map]);
    assert.ok(h.calls.indexOf('exit') < h.calls.indexOf('close'));
    assert.ok(h.calls.indexOf('close') < h.calls.indexOf('map'));
});

test('failed preparation recovers to map and the next transition still works', async () => {
    let attempts = 0;
    const h = harness({ prepareOptions: async () => { attempts += 1; if (attempts === 1) throw new Error('prepare-failed'); return { camera: 3 }; } });
    await h.controller.transition({ kind: 'gta', lat: 1, lon: 2 });
    assert.equal(h.calls.some(call => call[0] === 'error' && call[1].message === 'prepare-failed'), true);
    await h.controller.transition({ kind: 'gta', lat: 3, lon: 4 });
    assert.deepEqual(h.calls.filter(call => call[0] === 'gta').at(-1), ['gta', 3, 4, { camera: 3 }]);
});

test('refused GTA open recovers to map and the next transition still works', async () => {
    let opens = 0;
    const h = harness();
    h.engine.openGta = (...args) => { h.calls.push(['gta', ...args]); opens += 1; return opens > 1; };
    await h.controller.transition({ kind: 'gta', lat: 1, lon: 2 });
    assert.equal(h.calls.some(call => call[0] === 'error' && call[1].message === 'open-refused'), true);
    await h.controller.transition({ kind: 'gta', lat: 3, lon: 4 });
    assert.deepEqual(h.calls.filter(call => call[0] === 'gta').at(-1), ['gta', 3, 4, { camera: 1 }]);
});

test('new route exits campaign before opening the next engine', async () => {
    const h = harness();
    await h.controller.transition({ kind: 'campaign' });
    await h.controller.transition({ kind: 'gta', lat: 1, lon: 2 });
    assert.ok(h.calls.indexOf('exit') < h.calls.indexOf('load', h.calls.indexOf('exit')));
    assert.equal(h.controller.isCampaignOpen(), false);
});

test('campaign disabled never loads engine', async () => {
    const h = harness({ campaignEnabled: () => false });
    await h.controller.transition({ kind: 'campaign' });
    assert.equal(h.calls.includes('load'), false);
});

test('a free-roam open leaves the loading screen to the engine, which drops it when the world is built', async () => {
    const gta = harness();
    assert.equal(await gta.controller.transition({ kind: 'gta', lat: 45.8, lon: 15.9 }), true);
    assert.deepEqual(gta.calls.filter(call => Array.isArray(call) && call[0] === 'loading'), [['loading', true]],
        'raised for the open and never dropped by the host on success');
    const menu = harness();
    assert.equal(await menu.controller.transition({ kind: 'campaign' }), true);
    assert.deepEqual(menu.calls.at(-1), ['loading', false], 'a campaign route is done opening, so the host drops it');
});

test('a failed or superseded free-roam open never leaves the loading screen up', async () => {
    const failing = harness({ prepareOptions: async () => { throw new Error('offline'); } });
    assert.equal(await failing.controller.transition({ kind: 'gta', lat: 45.8, lon: 15.9 }), false);
    assert.deepEqual(failing.calls.filter(call => Array.isArray(call) && call[0] === 'loading'), [['loading', true], ['loading', false]],
        'the error path drops it');
    assert.ok(failing.calls.includes('map'));

    const superseded = harness();
    const first = superseded.controller.transition({ kind: 'gta', lat: 45.8, lon: 15.9 });
    const second = superseded.controller.transition({ kind: 'map' });
    await Promise.all([first, second]);
    assert.deepEqual(superseded.calls.filter(call => Array.isArray(call) && call[0] === 'loading').at(-1), ['loading', false],
        'the map navigation that superseded the open drops it');
});
