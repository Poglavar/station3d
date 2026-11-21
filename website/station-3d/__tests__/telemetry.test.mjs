// The telemetry queue is the one piece that runs during play, so its contract is
// pinned here: push-only tracking, a bounded buffer, batching on a timer, and a
// send that can never throw into the game. The campaign diff and the browser
// install are covered with a fake window — no DOM, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createTelemetryQueue, deriveCampaignEvents, installTelemetry, TELEMETRY_MAX_BATCH,
} from '../core/telemetry.js';

function fakeTimers() {
    const pending = [];
    return {
        schedule: (fn, ms) => { const id = { fn, ms }; pending.push(id); return id; },
        cancel: (id) => { const i = pending.indexOf(id); if (i >= 0) pending.splice(i, 1); },
        fire: () => { const p = pending.splice(0); for (const t of p) t.fn(); },
        count: () => pending.length,
    };
}

test('track only enqueues; a single timer batches the flush', () => {
    const sent = [];
    const timers = fakeTimers();
    let t = 1000;
    const q = createTelemetryQueue({ send: (b) => sent.push(b), now: () => t, ...timers });
    q.track('a', { x: 1 }); t += 5; q.track('b'); q.track('c', null);
    assert.equal(sent.length, 0, 'nothing sent synchronously');
    assert.equal(timers.count(), 1, 'one timer armed for the whole burst');
    timers.fire();
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], [{ e: 'a', t: 1000, p: { x: 1 } }, { e: 'b', t: 1005 }, { e: 'c', t: 1005 }]);
    assert.equal(q.size(), 0);
});

test('the buffer is bounded: oldest events are dropped, never grown without limit', () => {
    const timers = fakeTimers();
    const q = createTelemetryQueue({ send: () => {}, maxQueue: 3, ...timers });
    for (let i = 0; i < 10; i++) q.track(`e${i}`);
    assert.equal(q.size(), 3);
    assert.equal(q.droppedCount(), 7);
});

test('a throwing send is swallowed and a backlog drains in maxBatch slices', () => {
    const timers = fakeTimers();
    let calls = 0;
    const q = createTelemetryQueue({ send: () => { calls += 1; throw new Error('network'); }, ...timers });
    for (let i = 0; i < TELEMETRY_MAX_BATCH + 5; i++) q.track('e');
    assert.doesNotThrow(() => q.flush('manual'));
    assert.equal(calls, 1);
    assert.equal(q.size(), 5, 'remainder kept for the next slice');
    assert.equal(timers.count(), 1, 're-armed for the remainder');
    timers.fire();
    assert.equal(calls, 2);
    assert.equal(q.size(), 0);
});

test('deriveCampaignEvents turns state transitions into funnel events', () => {
    const run = (o) => ({ campaignId: 'toranj', currentSceneId: 's1', completed: false, completedScenes: [], ...o });
    assert.deepEqual(deriveCampaignEvents(null, run({})), [
        { e: 'campaign_start', p: { campaignId: 'toranj', sceneId: 's1', checkpointId: null, resumed: false } },
    ]);
    assert.equal(deriveCampaignEvents(null, run({ completedScenes: ['s0'] }))[0].p.resumed, true);
    assert.deepEqual(deriveCampaignEvents(run({}), run({ currentSceneId: 's2' })), [
        { e: 'scene_enter', p: { campaignId: 'toranj', sceneId: 's2' } },
    ]);
    assert.deepEqual(deriveCampaignEvents(run({}), run({ completed: true })), [
        { e: 'campaign_complete', p: { campaignId: 'toranj' } },
    ]);
    assert.deepEqual(deriveCampaignEvents(run({}), null), [
        { e: 'campaign_exit', p: { campaignId: 'toranj', sceneId: 's1' } },
    ]);
    assert.deepEqual(deriveCampaignEvents(run({}), run({})), [], 'no change, no event');
    assert.deepEqual(deriveCampaignEvents(null, null), []);
});

// A minimal window: event target + location + navigator.sendBeacon capture.
function fakeWindow({ search = '', beaconOk = true } = {}) {
    const listeners = new Map();
    const beacons = [];
    const doc = { visibilityState: 'visible', addEventListener: (n, fn) => listeners.set(`doc:${n}`, fn) };
    return {
        beacons,
        location: { search, pathname: '/sloboda/' },
        navigator: { sendBeacon: (url, blob) => { beacons.push({ url, blob }); return beaconOk; } },
        fetch: () => Promise.resolve(),
        document: doc,
        addEventListener: (n, fn) => listeners.set(n, fn),
        emit: (n, detail) => listeners.get(n)?.({ detail }),
        emitDoc: (n) => listeners.get(`doc:${n}`)?.(),
    };
}

async function blobText(blob) { return typeof blob.text === 'function' ? blob.text() : String(blob); }

test('installTelemetry subscribes to the app events and beacons a session-scoped batch on pagehide', async () => {
    const win = fakeWindow();
    const h = installTelemetry({ win, url: '/api/telemetry', sessionId: 'sess_0123456789' });
    assert.ok(h && h.sessionId === 'sess_0123456789');
    assert.equal(win.__s3dTelemetry, h, 'exposed for debugging');
    assert.equal(installTelemetry({ win }), h, 'idempotent');

    win.emit('station3d:visibility', { active: true, mode: 'walk' });
    win.emit('station3d:campaign-state', { campaignId: 'toranj', currentSceneId: 's1', completed: false, completedScenes: [] });
    win.emit('station3d:campaign-state', { campaignId: 'toranj', currentSceneId: 's2', completed: false, completedScenes: ['s1'] });
    win.emit('station3d:mode-load-error', { mode: 'gta' });
    assert.equal(win.beacons.length, 0, 'nothing sent before a flush');

    win.emit('pagehide');
    assert.equal(win.beacons.length, 1, 'one beacon carries the batch');
    assert.equal(win.beacons[0].url, '/api/telemetry');
    assert.equal(win.beacons[0].blob.type, 'text/plain', 'CORS-safelisted, no preflight');
    const payload = JSON.parse(await blobText(win.beacons[0].blob));
    assert.equal(payload.session, 'sess_0123456789');
    assert.deepEqual(payload.events.map((e) => e.e), [
        'session_start', 'mode_open', 'campaign_start', 'scene_enter', 'mode_load_error', 'session_end',
    ]);
    assert.deepEqual(payload.events[0].p, { page: '/sloboda/' });
    assert.deepEqual(payload.events[1].p, { mode: 'walk' });
});

test('?telemetry=0 opts out entirely and a missing window is a no-op', () => {
    assert.equal(installTelemetry({ win: fakeWindow({ search: '?st3d=walk&telemetry=0' }) }), null);
    assert.equal(installTelemetry({ win: null }), null);
});

test('a hidden tab flushes what it has, and a refused beacon falls back to fetch without throwing', async () => {
    const win = fakeWindow({ beaconOk: false });
    let fetched = 0;
    win.fetch = () => { fetched += 1; return Promise.reject(new Error('offline')); };
    installTelemetry({ win, url: '/api/telemetry', sessionId: 'sess_0123456789' });
    win.document.visibilityState = 'hidden';
    assert.doesNotThrow(() => win.emitDoc('visibilitychange'));
    assert.equal(fetched, 1, 'fallback used once');
    await new Promise((r) => setImmediate(r)); // the rejected promise must not become unhandled
});
