// Reproduce the old paging veto while preserving the existing CPU/error gates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPairedPlan, evaluateBenchmarkRun, compareBenchmarkPair,
    parseNativeMemorySample, summarizeNativeContext } from '../core/perf-benchmark-policy.js';

const start = Date.parse('2026-09-07T18:00:00Z');
const samples = Array.from({ length: 11 }, (_, i) => ({ at: start + i * 1000,
    frameAvgMs: i === 3 ? 400 : 20, host: { level: 'clean', contended: false } }));
const row = (seconds, incoming = 0, outgoing = 0, load1 = 2) => ({
    at: new Date(start + seconds * 1000).toISOString(), pageSizeBytes: 16384,
    counters: { Swapins: incoming, Swapouts: outgoing }, load: [load1, 2, 2],
});
const artifact = () => ({ harness: { headless: false, errors: [],
    worldReady: { outcomeVerified: true },
    measurementSamples: structuredClone(samples), validation: { valid: true, reasons: [] },
    route: { params: { elevation: '1' } }, runtimeContext: { dpr: 1 } } });

for (const [label, rows] of [
    ['one burst', [row(0), row(5, 0, 128), row(10, 0, 128)]],
    ['sustained paging and high load', [row(0), row(5, 10000, 20000, 12), row(10, 20000, 40000, 14)]],
]) test(`${label} is context, never an automatic timing veto`, () => {
    const run = artifact(), before = structuredClone(run);
    run.nativeContext = summarizeNativeContext(rows, samples);
    assert.equal(run.nativeContext.role, 'context-only');
    assert.ok(run.nativeContext.totalOutgoingMiB > 1);
    assert.ok(run.nativeContext.warnings.some(text => text.includes('paging observed')));
    assert.equal(evaluateBenchmarkRun(run).accepted, true);
    assert.deepEqual(run.harness, before.harness, 'even the 400 ms window remains untouched');
    assert.equal(compareBenchmarkPair(artifact(), run).comparable, true);
});

test('unknown native observations stay unknown, not zero or a veto', () => {
    const result = summarizeNativeContext([], samples);
    assert.equal(result.totalOutgoingMiB, null);
    assert.equal(result.coverage, null);
    assert.match(result.warnings[0], /not zero/);
    assert.equal(evaluateBenchmarkRun({ ...artifact(), nativeContext: result }).accepted, true);
    assert.equal(summarizeNativeContext([row(0), row(5)], [{ at: null }]).durationMs, null);
});

test('known quiet intervals really are zero', () => {
    const result = summarizeNativeContext([row(0), row(5), row(10)], samples);
    assert.equal(result.totalOutgoingMiB, 0);
    assert.equal(result.coverage, 1);
});

test('missing/reset counters and page-size changes cannot invent native deltas', () => {
    for (const invalid of [row(5, null, null), row(5, 1, 1),
        { ...row(5, 200, 200), pageSizeBytes: 4096 }]) {
        const result = summarizeNativeContext([row(0, 100, 100), invalid], samples);
        assert.equal(result.totalOutgoingMiB, null);
        assert.equal(result.intervals[0].complete, false);
    }
    assert.equal(parseNativeMemorySample('unavailable').pageSizeBytes, null);
    assert.deepEqual(parseNativeMemorySample('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nSwapins: 5.\nSwapouts: 10.\n'),
        { pageSizeBytes: 16384, counters: { Swapins: 5, Swapouts: 10 } });
});

test('sampling gaps are reported without losing measured traffic', () => {
    const result = summarizeNativeContext([row(0), row(10, 64, 128)], samples);
    assert.equal(result.totalOutgoingMiB, 2);
    assert.ok(result.warnings.some(text => text.includes('gaps')));
});

test('below-90%-clean CPU, page errors, headless and failed readiness still reject', () => {
    const busy = artifact();
    busy.harness.measurementSamples[0].host.level = 'busy';
    busy.harness.measurementSamples[1].host.level = 'busy';
    assert.equal(evaluateBenchmarkRun(busy).accepted, false);
    for (const change of [
        run => { run.harness.errors = ['ReferenceError']; },
        run => { run.harness.headless = true; },
        run => { run.harness.validation = { valid: false, reasons: ['world not ready'] }; },
    ]) {
        const run = artifact(); change(run);
        assert.equal(evaluateBenchmarkRun(run).accepted, false);
    }
    assert.equal(evaluateBenchmarkRun(artifact(), { status: 2 }).accepted, false);
    assert.equal(evaluateBenchmarkRun(null).accepted, false);
});

test('runtime/scenario mismatches and absent live rail coverage still reject', () => {
    const changed = artifact(); changed.harness.runtimeContext.dpr = 2;
    assert.equal(compareBenchmarkPair(artifact(), changed).comparable, false);
    assert.ok(compareBenchmarkPair(artifact(), changed).mismatches.length > 0);
    assert.equal(evaluateBenchmarkRun(artifact(), { requireRailFormation: true }).accepted, false);
});

test('a valid-looking harness cannot conceal missing readiness or failed builds', () => {
    const unready = artifact(); delete unready.harness.worldReady;
    assert.equal(evaluateBenchmarkRun(unready).accepted, false);
    const unsettled = artifact(); unsettled.harness.route.startPolicy = 'paused-fully-built';
    assert.equal(evaluateBenchmarkRun(unsettled).accepted, false);
    unsettled.harness.settledStart = { ready: true };
    assert.equal(evaluateBenchmarkRun(unsettled).accepted, true);
    for (const key of ['buildFailed', 'fetchFailed', 'failed', 'retrying']) {
        const failed = artifact(); failed.phaseSnapshots = { settle: { background: [{ [key]: 1 }] } };
        assert.equal(evaluateBenchmarkRun(failed).accepted, false);
    }
});

test('all three scenarios receive both variants twice in balanced ABBA order', () => {
    const plan = createPairedPlan(['tram', 'rail', 'walk'].map(id => ({ id })));
    assert.equal(plan.length, 12);
    assert.equal(new Set(plan.map(slot => slot.id)).size, 12);
    for (let i = 0; i < 12; i += 4) assert.deepEqual(plan.slice(i, i + 4).map(slot => slot.variant),
        ['baseline', 'candidate', 'candidate', 'baseline']);
    assert.throws(() => createPairedPlan([{ id: 'x' }, { id: 'x' }]));
    assert.throws(() => createPairedPlan([{ id: '../escape' }]));
});
