// Exercise the real entry functions with deferred module loading, without
// importing the renderer or needing a browser/WebGL context.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
function functionSource(name, endMarker) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, `${name} must be present`);
    return source.slice(start, end);
}
const entrySource = [
    functionSource('open', 'function queueCabOpen('),
    functionSource('queueCabOpen', 'function openCab('),
    functionSource('close', '// Live renderer-level grade switch'),
].join('\n');

function harness() {
    let resolve, reject;
    const loaded = new Promise((yes, no) => { resolve = yes; reject = no; });
    const calls = { failures: [], ready: [], visibility: [], initialized: 0, started: 0, hidden: 0, raised: 0, dropped: 0 };
    const noop = () => {};
    const context = vm.createContext({
        openGeneration: 0, pendingOpenMode: null, state: { mode: 'cab' },
        ensureInitialized: () => true, activateRendererLifecycle: noop,
        closeStatic: noop, closeCab: noop, showModal: noop,
        raiseLoadingCurtain: () => { calls.raised += 1; },
        dropLoadingCurtain: () => { calls.dropped += 1; },
        hideModal: () => { calls.hidden += 1; },
        loadCabMode: () => loaded, loadStaticMode: () => loaded,
        initializeCabMode: () => { calls.initialized += 1; },
        startLoop: () => { calls.started += 1; }, stopLoop: noop,
        unbindSceneResize: noop, setTitleText: noop, getSessionHost: () => ({}),
        campaignFeatureEnabled: false, setCampaignButtonVisible: noop, setCampaignButtonEnabled: noop,
        requestAnimationFrame: noop,
        notifyWeatherLocation: noop,
        notifyVisibility: (...args) => calls.visibility.push(args),
        reportModeLoadFailure: (...args) => calls.failures.push(args),
    });
    vm.runInContext(entrySource, context);
    return {
        context, calls, resolve, reject,
        open(mode = 'gta') {
            if (mode === 'static') return context.open(45.8, 16, 'test', {});
            return context.queueCabOpen('openGta', [45.8, 16, {
                onCampaignSessionReady: (...args) => calls.ready.push(args),
            }]);
        },
    };
}
const settled = () => new Promise(resolve => setImmediate(resolve));

for (const mode of ['gta', 'static']) {
    test(`${mode}: a late load failure after close cannot fail a newer navigation`, async () => {
        const h = harness();
        h.open(mode);
        h.context.close();
        h.reject(new Error('late import failure'));
        await settled();
        assert.deepEqual(h.calls.failures, []);
        assert.deepEqual(h.calls.ready, []);
        assert.equal(h.context.pendingOpenMode, null);
        // Only a world session is covered by the loading screen; the static viewer has no build.
        assert.equal(h.calls.raised, mode === 'static' ? 0 : 1);
    });
}

test('a late successful cab import cannot reopen a closed session', async () => {
    const h = harness();
    h.open();
    h.context.close();
    let opened = false;
    h.resolve({ openGta: () => { opened = true; return true; } });
    await settled();
    assert.equal(opened, false);
    assert.equal(h.calls.initialized, 0);
    assert.equal(h.calls.started, 0);
});

test('an active cab load failure reaches the host and campaign readiness callback once', async () => {
    const h = harness();
    h.open();
    const error = new Error('module unavailable');
    h.reject(error);
    await settled();
    assert.deepEqual(h.calls.failures, [['openGta', error]]);
    assert.deepEqual(h.calls.ready, [['open-failed', error]]);
    assert.equal(h.calls.hidden, 1);
    assert.equal(h.calls.dropped, 1, 'a failed mode load never leaves the loading screen up');
    assert.equal(h.context.pendingOpenMode, null);
});

test('a refused asynchronous open reports failure instead of leaving an empty host', async () => {
    const h = harness();
    h.open();
    h.resolve({ openGta: () => false });
    await settled();
    assert.equal(h.calls.failures.length, 1);
    assert.match(h.calls.failures[0][1].message, /refused/);
    assert.equal(h.calls.ready[0][0], 'open-failed');
    assert.equal(h.calls.hidden, 1);
    assert.equal(h.calls.dropped, 1, 'a refused open takes the loading screen away');
    assert.equal(h.calls.started, 0);
});

test('a successful asynchronous open publishes visibility and starts the renderer once', async () => {
    const h = harness();
    h.open();
    h.resolve({ openGta: () => true });
    await settled();
    assert.deepEqual(h.calls.failures, []);
    assert.deepEqual(h.calls.visibility, [[true, 'gta']]);
    assert.equal(h.calls.raised, 1, 'the open is covered from its first frame');
    assert.equal(h.calls.dropped, 0, 'the built world, not the open, takes the loading screen away');
    assert.equal(h.calls.initialized, 1);
    assert.equal(h.calls.started, 1);
    assert.equal(h.context.pendingOpenMode, null);
});
