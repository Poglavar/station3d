// Verifies single-controller lifecycle, action routing and authoritative pose.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createControllerRouter } from '../core/controller-router.js';

function fakeController(id, events) {
    return {
        activate(context) { events.push(`${id}:activate:${context.value}`); return true; },
        handleAction(action, phase) { events.push(`${id}:action:${action}:${phase}`); return true; },
        step(dt) { events.push(`${id}:step:${dt}`); return { id, dt }; },
        getCameraProfile() { return { kind: id }; },
        requestStop() { events.push(`${id}:stop`); return true; },
        getExitState() { return { allowed: id === 'foot' }; },
        deactivate(reason) { events.push(`${id}:deactivate:${reason}`); },
        dispose() { events.push(`${id}:dispose`); },
    };
}

test('only the active controller receives actions, steps and camera selection', () => {
    const events = [];
    const router = createControllerRouter();
    router.register('foot', fakeController('foot', events));
    router.register('road', fakeController('road', events));
    assert.equal(router.activate('foot', { value: 1 }, 'launch'), true);
    assert.deepEqual(router.step(0.25), { id: 'foot', dt: 0.25 });
    assert.equal(router.handleAction('move-forward', 'start'), true);
    assert.deepEqual(router.getCameraProfile(), { kind: 'foot' });
    assert.equal(router.activate('road', { value: 2 }, 'boarded'), true);
    assert.deepEqual(router.step(0.5), { id: 'road', dt: 0.5 });
    assert.equal(router.requestStop(), true);
    assert.deepEqual(router.getExitState(), { allowed: false });
    assert.deepEqual(events.slice(0, 7), [
        'foot:activate:1',
        'foot:step:0.25',
        'foot:action:move-forward:start',
        'road:activate:2',
        'foot:deactivate:boarded',
        'road:step:0.5',
        'road:stop',
    ]);
});

test('invalid controllers and unsupported transitions fail loudly or safely', () => {
    const router = createControllerRouter();
    assert.throws(() => router.register('broken', {}), /missing/);
    assert.equal(router.activate('missing'), false);
    assert.equal(router.step(1), null);
    assert.equal(router.handleAction('anything'), false);
});

test('foot, road, boat, aircraft, tram and train profiles all route through one slot', () => {
    const events = [];
    const router = createControllerRouter();
    for (const id of ['foot', 'road', 'boat', 'aircraft', 'tram', 'train']) {
        router.register(id, fakeController(id, events));
    }
    for (const id of ['foot', 'road', 'boat', 'aircraft', 'tram', 'train']) {
        assert.equal(router.activate(id, { value: id }, 'mode-switch'), true);
        assert.equal(router.handleAction('camera', 'press'), true);
        assert.deepEqual(router.getCameraProfile(), { kind: id });
        assert.deepEqual(router.step(0.1), { id, dt: 0.1 });
    }
    assert.equal(router.activeId, 'train');
});
