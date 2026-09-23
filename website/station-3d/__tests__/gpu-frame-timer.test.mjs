// GPU frame timer against a fake WebGL2 context: non-blocking read-back, disjoint discard, pool
// bound, pause for external profilers, and graceful absence of the extension.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGpuFrameTimer } from '../core/gpu-frame-timer.js';

function fakeGl({ extension = true } = {}) {
    let nextId = 1, open = null, disjoint = false;
    const results = new Map(); // query id → { ns, available }
    const ext = { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb };
    const gl = {
        QUERY_RESULT: 0x8866, QUERY_RESULT_AVAILABLE: 0x8867,
        created: 0,
        getExtension: name => (extension && name === 'EXT_disjoint_timer_query_webgl2' ? ext : null),
        createQuery() { gl.created += 1; return { id: nextId++ }; },
        deleteQuery() {},
        beginQuery(target, query) { assert.equal(open, null, 'only one timer query may be open'); open = query; },
        endQuery() { results.set(open.id, { ns: 0, available: false }); open = null; },
        getParameter: name => (name === ext.GPU_DISJOINT_EXT ? disjoint : null),
        getQueryParameter: (query, name) => (name === gl.QUERY_RESULT_AVAILABLE ? results.get(query.id).available : results.get(query.id).ns),
        // Test controls: complete every in-flight query with the given GPU milliseconds.
        complete(ms) { for (const r of results.values()) if (!r.available) Object.assign(r, { ns: ms * 1e6, available: true }); },
        setDisjoint(value) { disjoint = value; },
        get open() { return open; },
    };
    return gl;
}

test('frames are timed without blocking and summarised as a median', () => {
    const gl = fakeGl();
    const timer = createGpuFrameTimer(gl);
    assert.equal(timer.available, true);
    for (const ms of [10, 12, 30]) { timer.begin(); timer.end(); gl.complete(ms); }
    assert.deepEqual(timer.takeWindow(), { frames: 3, medianMs: 12 });
    assert.equal(timer.takeWindow(), null, 'a window is consumed once');
    // Results not yet available are left for a later window.
    timer.begin(); timer.end();
    assert.equal(timer.takeWindow(), null);
    gl.complete(8);
    assert.deepEqual(timer.takeWindow(), { frames: 1, medianMs: 8 });
});

test('disjoint intervals are discarded and the query pool stays bounded', () => {
    const gl = fakeGl();
    const timer = createGpuFrameTimer(gl, { poolSize: 4, pollBacklog: 2 });
    timer.begin(); timer.end(); gl.complete(50);
    gl.setDisjoint(true);
    assert.equal(timer.takeWindow(), null, 'a disjoint result is never reported');
    gl.setDisjoint(false);
    // The GPU never answers: timing stops at the pool size instead of allocating queries.
    for (let i = 0; i < 20; i++) { timer.begin(); timer.end(); }
    assert.ok(gl.created <= 4, `${gl.created} queries created`);
    gl.complete(9);
    assert.equal(timer.takeWindow().medianMs, 9);
});

test('an external profiler can pause it, and a missing extension measures nothing', () => {
    const gl = fakeGl();
    const timer = createGpuFrameTimer(gl);
    timer.begin();
    timer.setEnabled(false);
    assert.equal(gl.open, null, 'pausing closes the open query so the profiler can open its own');
    timer.begin();
    assert.equal(gl.open, null);
    timer.setEnabled(true);
    timer.begin(); timer.end(); gl.complete(7);
    assert.equal(timer.takeWindow().medianMs, 7);

    const none = createGpuFrameTimer(fakeGl({ extension: false }));
    assert.equal(none.available, false);
    none.begin(); none.end();
    assert.equal(none.takeWindow(), null);
});
