// Exercise the actual terrain installer/queue helper and production Worker:
// copying, transfer, acceptance, revisions and cancellation form one contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { Worker } from 'node:worker_threads';
import { createRenderCompilerClient } from '../core/render-compiler-client.js';
import { TerrainGrid, TerrainReference } from '../core/terrain-grid.js';
import * as snapshots from '../core/terrain-snapshot.js';
import { compileTerrainRenderPacket, TERRAIN_PACKET_COMPILER_ID, TERRAIN_PACKET_COMPILER_VERSION } from '../core/compilers/terrain-render-packet.js';
import { renderPacketFingerprint } from '../core/render-packet.js';

class ModuleWorker {
    constructor() {
        this.listeners = new Map();
        this.sent = [];
        this.thread = new Worker(new URL('./fixtures/render-compiler-node-worker.mjs', import.meta.url));
        this.thread.on('message', data => this.emit('message', { data }));
        this.thread.on('error', error => this.emit('error', error));
        this.thread.on('messageerror', error => this.emit('messageerror', error));
    }
    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(listener);
    }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    emit(type, event) { for (const listener of this.listeners.get(type) || []) listener(event); }
    postMessage(message, transfer = []) {
        this.sent.push({ message, transfer });
        this.thread.postMessage(message, transfer);
    }
    terminate() { return this.termination ??= this.thread.terminate(); }
}

function reference(offset = 0) {
    const width = 257, height = 129;
    const values = Uint16Array.from({ length: width * height }, (_, i) => (i + offset) % 60000);
    const grid = new TerrainGrid({
        grid: { width, height, bounds: { west: 15.99, east: 16.01, south: 45.79, north: 45.81 } },
        encoding: { scaleM: 0.01, offsetM: 100, noDataValue: 65535 },
    }, values.buffer);
    return new TerrainReference(grid, 16, 45.8, { surfaceStepM: 20 });
}

function request(reference) {
    return { requestKey: 'terrain:0:0', compilerId: TERRAIN_PACKET_COMPILER_ID,
        compilerVersion: TERRAIN_PACKET_COMPILER_VERSION, generation: reference.revision,
        sourceRevision: `terrain:${reference.revision}`, requiredStates: { terrain: reference.revision },
        tile: { matrix: 'test', z: 0, x: 0, y: 0, originLon: 16, originLat: 45.8, sizeM: 40 },
        inputs: { snapshotRevision: reference.revision, tileX: 0, tileZ: 0, tileM: 40, segments: 2, uvPerM: 1 / 16 },
    };
}

function fixture() {
    const workers = [], jobs = [], repeat = Symbol('repeat');
    const client = createRenderCompilerClient({ workerUrl: 'node-worker', workerFactory: () => {
        const worker = new ModuleWorker(); workers.push(worker); return worker;
    } });
    const queue = {
        enqueue(_items, onItem, options) {
            let resolve, reject;
            const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
            const job = { onItem, options, promise, resolve, reject, done: false };
            jobs.push(job); return job;
        },
        cancel(job) {
            if (job.done) return;
            job.done = true; job.options.onCancel?.(); job.resolve({ cancelled: true });
        },
    };
    const source = readFileSync(new URL('../world/terrain.js', import.meta.url), 'utf8');
    const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to));
    const sandbox = { ...snapshots, reference: reference(), renderCompiler: client, terrainRenderCompilers: [client],
        terrainGridPrepQueue: queue, FRAME_CHUNK_REPEAT_ITEM: repeat,
        terrainCompilerSnapshotFailure: null, pumpTerrainTileBuilds() {}, rejectTerrainBuildWaiters() {} };
    runInNewContext([
        section('function terrainGridPrepAbortError', 'function resetTerrainGridPrepQueue'),
        section('function resolveTerrainGridPrepPriority', 'function decodeTerrainGridPayloadQueued'),
        section('async function installTerrainCompilerSnapshot', 'function discardActiveTerrainTileBuild'),
    ].join('\n'), sandbox);
    return { sandbox, client, workers, jobs,
        step() {
            const job = jobs.find(job => !job.done);
            if (!job) return false;
            try {
                if (job.onItem() !== repeat) { job.done = true; job.resolve({ cancelled: false }); }
            } catch (error) { job.done = true; job.reject(error); }
            return true;
        },
        async close() {
            client.dispose();
            for (const job of jobs) queue.cancel(job);
            await Promise.all(workers.map(worker => worker.termination));
        },
    };
}

test('terrain installer copies through its queue and the real Worker accepts identical terrain', { timeout: 10000 }, async () => {
    const f = fixture(); let handle;
    try {
        f.sandbox.terrainCompilerSnapshotFailure = new Error('previous snapshot failed');
        const installed = f.sandbox.installTerrainCompilerSnapshot();
        const compileRequest = request(f.sandbox.reference);
        handle = f.client.compile(compileRequest);
        assert.equal(f.workers[0].sent.length, 0);
        assert.equal(f.jobs.length, 1);
        assert.equal(f.step(), true);
        assert.equal(f.workers[0].sent.length, 0, 'first queue visit does not install a partial state');
        while (f.step()) {}
        assert.equal(await installed, true, 'the real Worker must acknowledge deserialization');
        assert.equal(f.sandbox.terrainCompilerSnapshotFailure, null);
        const actual = await handle.promise;
        assert.equal(renderPacketFingerprint(actual), renderPacketFingerprint(compileTerrainRenderPacket(compileRequest, f.sandbox.reference)));
        const sent = f.workers[0].sent.find(entry => entry.message.type === 'state');
        assert.equal(sent.transfer.length, 1);
        assert.equal(sent.transfer[0].byteLength, 0, 'the prepared main-thread buffer is detached');
        assert.equal(f.sandbox.reference.grid.values.length, 257 * 129);
    } finally { await f.close(); await handle?.promise.catch(() => {}); }
});

test('a terrain revision cancels partial queue work and only the latest snapshot reaches the real Worker', { timeout: 10000 }, async () => {
    const f = fixture(); let latestHandle;
    try {
        const oldInstall = f.sandbox.installTerrainCompilerSnapshot();
        const oldHandle = f.client.compile(request(f.sandbox.reference));
        const oldRejected = assert.rejects(oldHandle.promise, error => error.code === 'state-superseded');
        f.step(); f.step(); f.step();
        f.sandbox.reference.replaceGrid(reference(1000).grid);
        const latestInstall = f.sandbox.installTerrainCompilerSnapshot();
        latestHandle = f.client.compile(request(f.sandbox.reference));
        assert.equal(await oldInstall, false);
        await oldRejected;
        assert.equal(f.jobs[0].done, true);
        while (f.step()) {}
        assert.equal(await latestInstall, true);
        assert.equal((await latestHandle.promise).generation, 1);
        const states = f.workers[0].sent.filter(entry => entry.message.type === 'state');
        assert.equal(states.length, 1);
        assert.equal(states[0].message.payload.snapshot.revision, 1);
    } finally { await f.close(); await latestHandle?.promise.catch(() => {}); }
});

test('the real Worker rejection fails state readiness and its dependent request', { timeout: 10000 }, async () => {
    const f = fixture(); let handle;
    try {
        const installed = f.client.setState('terrain', { kind: 'terrain-snapshot', snapshot: { schemaVersion: -1 } }, { revision: 0 });
        const rejectedState = assert.rejects(installed, error => error.code === 'state-rejected');
        handle = f.client.compile(request(f.sandbox.reference));
        await Promise.all([rejectedState, assert.rejects(handle.promise, error => error.code === 'state-rejected')]);
        assert.equal(f.workers[0].sent.some(entry => entry.message.type === 'compile'), false);
        assert.equal(f.client.snapshot().preparingStates, 0);
    } finally { await f.close(); await handle?.promise.catch(() => {}); }
});

test('the Worker attests the installed terrain revision instead of trusting its declared label', { timeout: 10000 }, async () => {
    const f = fixture(); let handle;
    try {
        const snapshot = snapshots.serializeTerrainReference(f.sandbox.reference);
        const installed = f.client.setState('terrain', { kind: 'terrain-snapshot', snapshot }, { revision: 1 });
        const rejectedState = assert.rejects(installed, error => error.code === 'state-rejected' && /unexpected revision/.test(error.message));
        handle = f.client.compile({ ...request(f.sandbox.reference), requiredStates: { terrain: 1 } });
        await Promise.all([rejectedState, assert.rejects(handle.promise, error => error.code === 'state-rejected')]);
        assert.equal(f.workers[0].sent.some(entry => entry.message.type === 'compile'), false);
    } finally { await f.close(); await handle?.promise.catch(() => {}); }
});
