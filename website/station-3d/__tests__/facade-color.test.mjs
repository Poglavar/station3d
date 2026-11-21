// Measured facade colours: lookup and, more importantly, the fallback.
//
// The fallback is the part worth testing. Every building without a measurement -- most of
// the city -- must keep the procedural palette, and a failed fetch must leave the whole
// city looking exactly as it did before rather than painting it black or throwing during
// the build.

import test from 'node:test';
import assert from 'node:assert/strict';

// The module reads getApiBase() at import time, which wants a browser global.
globalThis.window = { __ZAGREB_RUNTIME_CONFIG__: { zagrebApiBaseUrl: 'http://x/api' } };

const BODY = {
    version: 1,
    count: 2,
    colors: { '14540': ['#a7a8a4', 0.9], '14544': ['#edede9', 0.42] },
};

async function freshModule(fetchImpl) {
    globalThis.fetch = fetchImpl;
    // cache-bust so each test gets its own module state
    return import(`../world/facade-color.js?t=${Math.random()}`);
}

test('a measured building returns its measured hex', async () => {
    const m = await freshModule(async () => ({ ok: true, json: async () => BODY }));
    await m.ensureFacadeColorData();
    assert.equal(m.facadeColorFor(14540), '#a7a8a4');
    assert.equal(m.facadeColorFor('14540'), '#a7a8a4', 'numeric and string ids agree');
    assert.equal(m.facadeColorCount(), 2);
});

test('an unmeasured building returns null, so the caller falls back to the palette', async () => {
    const m = await freshModule(async () => ({ ok: true, json: async () => BODY }));
    await m.ensureFacadeColorData();
    assert.equal(m.facadeColorFor(999999), null);
    assert.equal(m.facadeColorFor(null), null);
});

test('minConfidence drops weak measurements rather than showing them', async () => {
    const m = await freshModule(async () => ({ ok: true, json: async () => BODY }));
    await m.ensureFacadeColorData();
    assert.equal(m.facadeColorFor(14544, 0.5), null, '0.42 is below the bar');
    assert.equal(m.facadeColorFor(14544, 0.4), '#edede9');
    assert.equal(m.facadeColorFor(14540, 0.5), '#a7a8a4', 'a strong one survives');
});

test('a failed fetch leaves every building on the palette instead of breaking the build',
    async () => {
        const m = await freshModule(async () => { throw new Error('network down'); });
        const colors = await m.ensureFacadeColorData();
        assert.deepEqual(colors, {});
        assert.equal(m.facadeColorFor(14540), null);
        assert.equal(m.facadeColorCount(), 0);
    });

test('a non-ok response is treated as no data, not as an exception', async () => {
    const m = await freshModule(async () => ({ ok: false, json: async () => ({}) }));
    await m.ensureFacadeColorData();
    assert.equal(m.facadeColorFor(14540), null);
});

test('the bundle is fetched once however many callers ask for it', async () => {
    let calls = 0;
    const m = await freshModule(async () => { calls++; return { ok: true, json: async () => BODY }; });
    await Promise.all([m.ensureFacadeColorData(), m.ensureFacadeColorData()]);
    await m.ensureFacadeColorData();
    assert.equal(calls, 1);
});
