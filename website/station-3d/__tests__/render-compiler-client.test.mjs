import test from 'node:test';
import assert from 'node:assert/strict';

import { createRenderCompilerClient } from '../core/render-compiler-client.js';

class FakeWorker {
    constructor() {
        this.listeners = new Map();
        this.messages = [];
        this.terminateCalls = 0;
        this.autoAcknowledgeStates = true;
    }

    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(listener);
    }

    removeEventListener(type, listener) {
        this.listeners.get(type)?.delete(listener);
    }

    postMessage(message, transfer = []) {
        this.messages.push(structuredClone(message, { transfer }));
        if (message.type === 'state' && this.autoAcknowledgeStates) {
            this.emit('message', { type: 'state-ready', stateId: message.stateId,
                stateGeneration: message.stateGeneration, stateRevision: message.stateRevision });
        }
    }

    emit(type, data) {
        for (const listener of this.listeners.get(type) || []) listener({ data, message: data?.message });
    }

    terminate() {
        this.terminateCalls += 1;
    }

    listenerCount() {
        return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0);
    }
}

function request(generation, requestKey = 'terrain:0:0') {
    return {
        requestKey,
        compilerId: 'test',
        compilerVersion: '1',
        sourceRevision: 'source:1',
        generation,
        tile: {
            matrix: 'test', z: 0, x: 0, y: 0,
            originLon: 16, originLat: 45.8, sizeM: 1,
        },
        inputs: {},
    };
}

function terrainRequest(generation, revision = generation) {
    return { ...request(generation), requiredStates: { terrain: revision } };
}

function packetFor(jobRequest) {
    return {
        schemaVersion: 1,
        compilerId: jobRequest.compilerId,
        compilerVersion: jobRequest.compilerVersion,
        sourceRevision: jobRequest.sourceRevision,
        generation: jobRequest.generation,
        tile: jobRequest.tile,
        primitives: [{
            positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]),
            normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
            uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
            indices: new Uint16Array([0, 1, 2]),
            materialKey: 'test',
            renderOrder: 0,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0, maxZ: 1 },
            entityRanges: [{ entityId: 'triangle', startIndex: 0, indexCount: 3 }],
            surfaceClaims: [],
            colliderData: null,
        }],
    };
}

test('prepared state transfers fresh buffers before compilation, including after Worker restart', async () => {
    const workers = [], preparations = [], buffers = [];
    const source = new Uint16Array([1, 2, 3, 4]);
    const client = createRenderCompilerClient({ workerUrl: 'worker.js', workerFactory: () => {
        const worker = new FakeWorker(); workers.push(worker); return worker;
    } });
    let job;
    try {
        const installed = client.setState('terrain', ({ signal }) => new Promise(resolve => {
            preparations.push({ signal, finish() {
                const copy = new Uint16Array(source).buffer;
                buffers.push(copy);
                resolve({ payload: { revision: 7, values: copy }, transferables: [copy] });
            } });
        }), { revision: 7 });
        job = client.compile(terrainRequest(7));
        assert.equal(workers[0].messages.length, 0, 'compile waits behind state preparation');
        assert.equal(client.snapshot().preparingStates, 1);
        preparations[0].finish();
        assert.equal(await installed, true);
        assert.deepEqual(workers[0].messages.map(message => message.type), ['state', 'compile']);
        assert.equal(buffers[0].byteLength, 0, 'Worker messaging transfers, not clones, the prepared buffer');
        assert.equal(source.byteLength, 8);
        workers[0].emit('error', { message: 'restart during compilation' });
        assert.equal(workers[1].messages.length, 0, 'retry waits for replay preparation');
        assert.equal(preparations.length, 2);
        preparations[1].finish();
        for (let i = 0; i < 4; i++) await Promise.resolve();
        assert.deepEqual(workers[1].messages.map(message => message.type), ['state', 'compile']);
        assert.deepEqual(new Uint16Array(workers[1].messages[0].payload.values), source);
        assert.equal(buffers[1].byteLength, 0);
        workers[1].emit('message', { type: 'result', jobId: job.jobId, packet: packetFor(request(7)) });
        assert.equal((await job.promise).generation, 7);
    } finally {
        client.dispose();
        await job?.promise.catch(() => {});
    }
});

test('a newer state aborts unfinished preparation and ignores its late completion', async () => {
    const worker = new FakeWorker();
    const client = createRenderCompilerClient({ workerUrl: 'worker.js', workerFactory: () => worker });
    let finishOld, oldSignal, job;
    try {
        const old = client.setState('terrain', ({ signal }) => {
            oldSignal = signal;
            return new Promise(resolve => { finishOld = resolve; });
        }, { revision: 1 });
        job = client.compile(terrainRequest(1));
        const oldJobRejected = assert.rejects(job.promise, error => error.code === 'state-superseded');
        const latest = client.setState('terrain', () => ({ payload: { revision: 2 } }), { revision: 2 });
        job = client.compile(terrainRequest(2));
        assert.equal(oldSignal.aborted, true);
        assert.equal(await latest, true);
        await oldJobRejected;
        finishOld({ payload: { revision: 1 } });
        assert.equal(await old, false);
        assert.deepEqual(worker.messages.filter(message => message.type === 'state').map(message => message.payload.revision), [2]);
        assert.deepEqual(worker.messages.map(message => message.type), ['state', 'compile']);
    } finally {
        client.dispose();
        await job?.promise.catch(() => {});
    }
});

test('clear/dispose abort pending state preparation and cannot resurrect a late state', async () => {
    for (const action of ['clear', 'dispose']) {
        const worker = new FakeWorker();
        const client = createRenderCompilerClient({ workerUrl: 'worker.js', workerFactory: () => worker });
        let finish, signal;
        const installed = client.setState('terrain', (options) => {
            signal = options.signal;
            return new Promise(resolve => { finish = resolve; });
        });
        try {
            if (action === 'clear') client.clearState('terrain');
            else client.dispose();
            assert.equal(signal.aborted, true);
            finish({ payload: { revision: 1 } });
            assert.equal(await installed, false);
            assert.equal(worker.messages.some(message => message.type === 'state'), false);
            assert.equal(client.snapshot().preparingStates, 0);
        } finally { client.dispose(); }
    }
});

test('preparation failure rejects waiting jobs, remains explicit, and replacement can recover', async () => {
    const worker = new FakeWorker(), failures = [];
    const client = createRenderCompilerClient({ workerUrl: 'worker.js', workerFactory: () => worker,
        onFailure: error => failures.push(error) });
    let fail, job;
    try {
        const installed = client.setState('terrain', () => new Promise((_resolve, reject) => { fail = reject; }), { revision: 1 });
        const stateRejected = assert.rejects(installed, error => error.code === 'state-preparation-failed');
        job = client.compile(terrainRequest(1));
        const jobRejected = assert.rejects(job.promise, error => error.code === 'state-preparation-failed');
        fail(new Error('copy failed'));
        await Promise.all([stateRejected, jobRejected]);
        assert.equal(failures.length, 1);
        assert.equal(client.snapshot().preparingStates, 0);
        assert.equal(worker.messages.length, 0);
        assert.throws(() => client.compile(terrainRequest(2, 1)), error => error.code === 'state-preparation-failed');
        await client.setState('terrain', { revision: 2 }, { revision: 2 });
        job = client.compile(terrainRequest(2));
        assert.deepEqual(worker.messages.map(message => message.type), ['state', 'compile']);
    } finally {
        client.dispose();
        await job?.promise.catch(() => {});
    }
});

test('a crash during preparation fences its late reply behind the replacement Worker state', async () => {
    const workers = [], attempts = [];
    const client = createRenderCompilerClient({ workerUrl: 'worker.js', workerFactory: () => {
        const worker = new FakeWorker(); workers.push(worker); return worker;
    } });
    let job;
    try {
        const initial = client.setState('terrain', ({ signal }) => new Promise(resolve => { attempts.push({ signal, resolve }); }), { revision: 1 });
        let initialSettled = false;
        initial.then(() => { initialSettled = true; });
        job = client.compile(terrainRequest(1));
        workers[0].emit('error', { message: 'crash while copying' });
        assert.equal(attempts[0].signal.aborted, true);
        attempts[0].resolve({ payload: { revision: 1, attempt: 'old' } });
        for (let i = 0; i < 4; i++) await Promise.resolve();
        assert.equal(initialSettled, false, 'the logical install still awaits its replay');
        assert.equal(workers[1].messages.length, 0);
        attempts[1].resolve({ payload: { revision: 1, attempt: 'new' } });
        assert.equal(await initial, true);
        for (let i = 0; i < 4; i++) await Promise.resolve();
        assert.deepEqual(workers[1].messages.map(message => message.type), ['state', 'compile']);
        assert.equal(workers[1].messages[0].payload.attempt, 'new');
    } finally {
        client.dispose();
        await job?.promise.catch(() => {});
    }
});

test('state acknowledgement gates dependent jobs only, and ignores a superseded acknowledgement', async () => {
    const worker = new FakeWorker(); worker.autoAcknowledgeStates = false;
    const client = createRenderCompilerClient({ workerUrl: 'worker.js', workerFactory: () => worker });
    let dependent, independent;
    try {
        const first = client.setState('terrain', { revision: 1 }, { revision: 1 });
        const oldMessage = worker.messages[0];
        dependent = client.compile(terrainRequest(1));
        const stale = assert.rejects(dependent.promise, error => error.code === 'state-superseded');
        const latest = client.setState('terrain', { revision: 2 }, { revision: 2 });
        const newMessage = worker.messages[1];
        await stale;
        assert.equal(await first, false);
        dependent = client.compile(terrainRequest(2));
        independent = client.compile(request(1, 'far:0:0'));
        assert.deepEqual(worker.messages.filter(message => message.type === 'compile').map(message => message.jobId), [independent.jobId]);
        worker.emit('message', { type: 'state-error', stateId: 'terrain', stateGeneration: oldMessage.stateGeneration,
            error: { message: 'obsolete failure' } });
        worker.emit('message', { type: 'state-ready', stateId: 'terrain', stateGeneration: oldMessage.stateGeneration, stateRevision: oldMessage.stateRevision });
        assert.equal(client.snapshot().preparingStates, 1);
        assert.equal(client.snapshot().failureCount, 0);
        worker.emit('message', { type: 'result', jobId: independent.jobId, packet: packetFor(request(1, 'far:0:0')) });
        await independent.promise;
        assert.equal(worker.messages.filter(message => message.type === 'compile').length, 1,
            'posting the new state is not acceptance');
        worker.emit('message', { type: 'state-ready', stateId: 'terrain', stateGeneration: newMessage.stateGeneration, stateRevision: newMessage.stateRevision });
        assert.equal(await latest, true);
        assert.equal(client.snapshot().preparingStates, 0);
        assert.equal(worker.messages.at(-1).jobId, dependent.jobId);
    } finally {
        client.dispose();
        await Promise.all([dependent?.promise.catch(() => {}), independent?.promise.catch(() => {})]);
    }
});

test('clearing or rejecting a state fails its waiting jobs, not independent compiler work', async () => {
    for (const action of ['clear', 'reject']) {
        const worker = new FakeWorker(); worker.autoAcknowledgeStates = false;
        const client = createRenderCompilerClient({ workerUrl: 'worker.js', workerFactory: () => worker });
        let dependent, independent;
        try {
            const installed = client.setState('terrain', { revision: 1 }, { revision: 1 });
            const stateOutcome = action === 'reject'
                ? assert.rejects(installed, error => error.code === 'state-rejected') : installed;
            dependent = client.compile(terrainRequest(1));
            const rejected = assert.rejects(dependent.promise, error => error.code === (action === 'clear' ? 'state-cleared' : 'state-rejected'));
            independent = client.compile(request(1, 'far:0:0'));
            if (action === 'clear') client.clearState('terrain');
            else worker.emit('message', { type: 'state-error', stateId: 'terrain',
                stateGeneration: worker.messages[0].stateGeneration, error: { message: 'invalid terrain' } });
            await rejected;
            await stateOutcome;
            assert.equal(worker.messages.filter(message => message.type === 'compile').length, 1);
            worker.emit('message', { type: 'result', jobId: independent.jobId, packet: packetFor(request(1, 'far:0:0')) });
            assert.equal((await independent.promise).generation, 1);
            assert.equal(client.snapshot().pendingJobs, 0);
        } finally {
            client.dispose();
            await Promise.all([dependent?.promise.catch(() => {}), independent?.promise.catch(() => {})]);
        }
    }
});

test('an unrecoverable crash settles an unfinished state and refuses future compilation', async () => {
    const worker = new FakeWorker();
    const client = createRenderCompilerClient({ workerUrl: 'worker.js', workerFactory: () => worker, maxRestarts: 0 });
    let signal;
    const installed = client.setState('terrain', (options) => { signal = options.signal; return new Promise(() => {}); }, { revision: 1 });
    const rejected = assert.rejects(installed, error => error.code === 'worker-crashed');
    try {
        worker.emit('error', { message: 'terminal failure while preparing' });
        await rejected;
        assert.equal(signal.aborted, true);
        assert.equal(client.snapshot().preparingStates, 0);
        assert.throws(() => client.compile(request(1)), error => error.code === 'worker-crashed');
    } finally { client.dispose(); }
});

test('a post-transfer pre-acknowledgement crash replays fresh buffers before resolving the same install', async () => {
    const workers = [], copies = [];
    const client = createRenderCompilerClient({ workerUrl: 'worker.js', workerFactory: () => {
        const worker = new FakeWorker(); worker.autoAcknowledgeStates = false; workers.push(worker); return worker;
    } });
    let job;
    try {
        const installed = client.setState('terrain', () => {
            const buffer = new Uint16Array([1, 2, 3]).buffer;
            copies.push(buffer);
            return { payload: { buffer }, transferables: [buffer] };
        }, { revision: 1 });
        let accepted = false;
        installed.then(() => { accepted = true; });
        job = client.compile(terrainRequest(1));
        for (let i = 0; i < 4; i++) await Promise.resolve();
        assert.equal(copies[0].byteLength, 0);
        const oldState = workers[0].messages[0];
        workers[0].emit('error', { message: 'crash before state acceptance' });
        for (let i = 0; i < 4; i++) await Promise.resolve();
        assert.equal(copies.length, 2);
        assert.equal(copies[1].byteLength, 0);
        assert.equal(accepted, false);
        workers[0].emit('message', { type: 'state-ready', stateId: 'terrain',
            stateGeneration: oldState.stateGeneration, stateRevision: 1 });
        assert.equal(accepted, false);
        const replay = workers[1].messages[0];
        workers[1].emit('message', { type: 'state-ready', stateId: 'terrain',
            stateGeneration: replay.stateGeneration, stateRevision: 1 });
        assert.equal(await installed, true);
        assert.deepEqual(workers[1].messages.map(message => message.type), ['state', 'compile']);
    } finally { client.dispose(); await job?.promise.catch(() => {}); }
});

test('client rejects stale results while retaining the newest generation', async () => {
    const worker = new FakeWorker();
    const client = createRenderCompilerClient({ workerUrl: 'worker.js', workerFactory: () => worker });
    const older = client.compile(request(1));
    const newer = client.compile(request(2));
    await assert.rejects(older.promise, error => error.code === 'superseded');
    const compileMessage = worker.messages.find(message => (
        message.type === 'compile' && message.jobId === newer.jobId
    ));
    worker.emit('message', {
        type: 'result',
        jobId: newer.jobId,
        packet: packetFor(compileMessage.request),
    });
    assert.equal((await newer.promise).generation, 2);
    client.dispose();
});

test('client cancellation settles once and disposal terminates exactly once', async () => {
    const worker = new FakeWorker();
    const client = createRenderCompilerClient({ workerUrl: 'worker.js', workerFactory: () => worker });
    const job = client.compile(request(1));
    assert.equal(job.cancel('tile-evicted'), true);
    assert.equal(job.cancel('again'), false);
    await assert.rejects(job.promise, error => error.code === 'cancelled');
    assert.equal(client.dispose(), true);
    assert.equal(client.dispose(), false);
    assert.equal(worker.terminateCalls, 1);
    assert.equal(worker.listenerCount(), 0);
    assert.equal(client.snapshot().terminateCount, 1);
});

test('client restarts once, replays immutable state, and retries the pending job', async () => {
    const workers = [];
    const client = createRenderCompilerClient({
        workerUrl: 'worker.js',
        workerFactory: () => {
            const worker = new FakeWorker();
            workers.push(worker);
            return worker;
        },
        maxRestarts: 1,
    });
    client.setState('terrain', { kind: 'terrain-snapshot', snapshot: { revision: 3 } });
    const job = client.compile(request(3));
    workers[0].emit('error', { message: 'boom' });
    assert.equal(workers.length, 2);
    assert.ok(workers[1].messages.some(message => message.type === 'state'));
    const retried = workers[1].messages.find(message => (
        message.type === 'compile' && message.jobId === job.jobId
    ));
    assert.ok(retried);
    workers[1].emit('message', {
        type: 'result',
        jobId: job.jobId,
        packet: packetFor(retried.request),
    });
    assert.equal((await job.promise).generation, 3);
    assert.equal(client.snapshot().restartCount, 1);
    assert.equal(workers[0].listenerCount(), 0);
    // A late second event from the crashed Worker must not consume the bounded
    // restart allowance or terminate the replacement Worker.
    workers[0].emit('messageerror', { message: 'late duplicate crash event' });
    assert.equal(client.snapshot().restartCount, 1);
    client.dispose();
    assert.equal(workers[1].listenerCount(), 0);
});

test('Worker state rejection is reported explicitly', async () => {
    const worker = new FakeWorker();
    worker.autoAcknowledgeStates = false;
    const failures = [];
    const client = createRenderCompilerClient({
        workerUrl: 'worker.js',
        workerFactory: () => worker,
        onFailure: error => failures.push(error),
    });
    const rejected = assert.rejects(client.setState('terrain', { broken: true }), error => error.code === 'state-rejected');
    worker.emit('message', {
        type: 'state-error',
        stateId: 'terrain',
        stateGeneration: worker.messages[0].stateGeneration,
        error: { message: 'snapshot malformed' },
    });
    await rejected;
    assert.equal(failures[0].code, 'state-rejected');
    assert.equal(client.snapshot().failureCount, 1);
    client.dispose();
});

test('malformed Worker output is rejected explicitly', async () => {
    const worker = new FakeWorker();
    const client = createRenderCompilerClient({ workerUrl: 'worker.js', workerFactory: () => worker });
    const job = client.compile(request(1));
    worker.emit('message', { type: 'result', jobId: job.jobId, packet: { schemaVersion: 999 } });
    await assert.rejects(job.promise, error => error.code === 'malformed-packet');
    assert.equal(client.snapshot().malformedCount, 1);
    client.dispose();
});

test('large Worker results are validated through the queue, not in the message callback', async () => {
    const worker = new FakeWorker();
    const client = createRenderCompilerClient({ workerUrl: 'worker.js', workerFactory: () => worker });
    const job = client.compile(request(1));
    const packet = packetFor(request(1));
    const primitive = packet.primitives[0];
    primitive.positions = new Float32Array(24_000 * 3);
    primitive.normals = new Float32Array(24_000 * 3);
    primitive.uvs = new Float32Array(24_000 * 2);
    primitive.positions[primitive.positions.length - 1] = NaN;
    const rejection = assert.rejects(job.promise, error => error.code === 'malformed-packet');
    try {
        worker.emit('message', { type: 'result', jobId: job.jobId, packet });
        assert.equal(client.snapshot().pendingJobs, 1, 'message delivery must not drain validation');
        assert.equal(client.snapshot().malformedCount, 0, 'late corruption is found by queued work');
        await rejection;
        assert.equal(client.snapshot().malformedCount, 1);
    } finally {
        client.dispose();
        await rejection;
    }
});

test('a transferred packet releases the Worker slot before main-thread validation completes', async () => {
    const worker = new FakeWorker();
    const client = createRenderCompilerClient({ workerUrl: 'worker.js', workerFactory: () => worker, maxInFlight: 1 });
    const firstRequest = request(1, 'terrain:0:0');
    const secondRequest = request(1, 'terrain:1:0');
    const first = client.compile(firstRequest);
    const second = client.compile(secondRequest);
    try {
        assert.deepEqual(worker.messages.filter(message => message.type === 'compile').map(message => message.jobId),
            [first.jobId]);
        worker.emit('message', { type: 'result', jobId: first.jobId, packet: packetFor(firstRequest) });
        assert.deepEqual(worker.messages.filter(message => message.type === 'compile').map(message => message.jobId),
            [first.jobId, second.jobId], 'the next compile overlaps validation of the transferred packet');
        assert.equal(client.snapshot().validatingJobs, 1);
        assert.equal(client.snapshot().activeJobs, 1);
        worker.emit('message', { type: 'result', jobId: second.jobId, packet: packetFor(secondRequest) });
        assert.deepEqual((await Promise.all([first.promise, second.promise])).map(packet => packet.generation), [1, 1]);
    } finally {
        client.dispose();
        await Promise.all([first.promise.catch(() => {}), second.promise.catch(() => {})]);
    }
});

test('supersession cancels queued validation and cannot resolve the old generation', async () => {
    const worker = new FakeWorker();
    const client = createRenderCompilerClient({ workerUrl: 'worker.js', workerFactory: () => worker });
    const old = client.compile(request(1));
    const rejected = assert.rejects(old.promise, error => error.code === 'superseded');
    worker.emit('message', { type: 'result', jobId: old.jobId, packet: packetFor(request(1)) });
    assert.equal(client.snapshot().validatingJobs, 1);
    const latest = client.compile(request(2));
    assert.equal(client.snapshot().validatingJobs, 0);
    assert.equal(worker.messages.filter(message => message.type === 'cancel').length, 0,
        'the Worker already finished; a late cancel would leak its completed job id');
    worker.emit('message', { type: 'result', jobId: old.jobId, packet: packetFor(request(1)) });
    worker.emit('message', { type: 'result', jobId: latest.jobId, packet: packetFor(request(2)) });
    try {
        assert.equal((await latest.promise).generation, 2);
        await rejected;
        assert.equal(client.snapshot().completedCount, 1);
        assert.equal(client.snapshot().pendingJobs, 0);
    } finally { client.dispose(); }
});

test('Worker restart preserves transferred results without recompiling them', async () => {
    const workers = [];
    const client = createRenderCompilerClient({ workerUrl: 'worker.js', workerFactory: () => {
        const worker = new FakeWorker(); workers.push(worker); return worker;
    } });
    const job = client.compile(request(1));
    workers[0].emit('message', { type: 'result', jobId: job.jobId, packet: packetFor(request(1)) });
    assert.equal(client.snapshot().validatingJobs, 1);
    workers[0].emit('error', { message: 'crash during validation' });
    assert.equal(client.snapshot().validatingJobs, 1);
    assert.equal(client.snapshot().completedCount, 0);
    assert.equal(workers[1].messages.filter(message => message.type === 'compile').length, 0);
    try {
        assert.equal((await job.promise).generation, 1);
        assert.equal(client.snapshot().completedCount, 1);
        assert.equal(client.snapshot().restartCount, 1);
    } finally { client.dispose(); }
});

test('exhausted Worker restart allowance cannot fail an already transferred packet', async () => {
    const worker = new FakeWorker();
    const client = createRenderCompilerClient({ workerUrl: 'worker.js', workerFactory: () => worker, maxRestarts: 0 });
    const job = client.compile(request(1));
    const packet = packetFor(request(1));
    packet.primitives[0].colliderData = { samples: Array(30_000).fill(1) };
    worker.emit('message', { type: 'result', jobId: job.jobId, packet });
    worker.emit('error', { message: 'crash after transfer' });
    assert.equal(client.snapshot().validatingJobs, 1);
    try {
        assert.equal(await job.promise, packet);
        assert.equal(client.snapshot().completedCount, 1);
        assert.equal(client.snapshot().restartCount, 0);
        assert.equal(worker.messages.filter(message => message.type === 'compile').length, 1);
    } finally { client.dispose(); }
});

test('a second Worker crash fails explicitly after the bounded retry', async () => {
    const workers = [];
    const client = createRenderCompilerClient({
        workerUrl: 'worker.js',
        workerFactory: () => {
            const worker = new FakeWorker();
            workers.push(worker);
            return worker;
        },
        maxRestarts: 1,
    });
    const job = client.compile(request(1));
    workers[0].emit('error', { message: 'first crash' });
    workers[1].emit('error', { message: 'second crash' });
    await assert.rejects(job.promise, error => error.code === 'worker-crashed');
    assert.equal(client.snapshot().restartCount, 1);
    client.dispose();
});

test('one Worker bounds memory and starts the highest-priority queued packet next', async () => {
    const worker = new FakeWorker();
    const client = createRenderCompilerClient({
        workerUrl: 'worker.js',
        workerFactory: () => worker,
        maxInFlight: 1,
    });
    const active = client.compile({ ...request(1, 'active'), priority: 1 });
    const low = client.compile({ ...request(1, 'low'), priority: 2 });
    const high = client.compile({ ...request(1, 'high'), priority: 9 });
    assert.deepEqual(
        worker.messages.filter(message => message.type === 'compile').map(message => message.jobId),
        [active.jobId],
        'only one packet may occupy the Worker at a time',
    );
    const activeRequest = worker.messages.find(message => message.jobId === active.jobId).request;
    worker.emit('message', {
        type: 'result',
        jobId: active.jobId,
        packet: packetFor(activeRequest),
    });
    await active.promise;
    assert.equal(
        worker.messages.filter(message => message.type === 'compile').at(-1).jobId,
        high.jobId,
    );
    assert.equal(client.snapshot().activeJobs, 1);
    assert.equal(client.snapshot().queuedJobs, 1);
    high.cancel();
    low.cancel();
    await assert.rejects(high.promise, error => error.code === 'cancelled');
    await assert.rejects(low.promise, error => error.code === 'cancelled');
    client.dispose();
});
