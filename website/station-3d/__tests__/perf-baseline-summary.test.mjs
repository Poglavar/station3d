// Locks the compact baseline aggregation so repeated raw traces remain honest.

import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeBaselineArtifacts } from '../core/perf-baseline-summary.js';

function artifact(id, frameMedian, frameP95, stutters, requests, valid = true) {
    return {
        baseline: { scenarioId: id },
        harness: {
            validation: { valid },
            network: {
                startup: {
                    requests,
                    encodedBytes: requests * 10,
                    decodedBytes: requests * 20,
                    station3dCode: { requests: Math.round(requests / 5) },
                    station3dDependencyCdn: { requests: 0 },
                    thirdPartyCdn: { requests: 0 },
                },
            },
            runtimeTiming: { durationMs: requests * 4 },
            worldReady: { elapsedMs: requests * 100 },
        },
        sampleSummary: {
            metrics: {
                frameAvgMs: { median: frameMedian, p95: frameP95 },
                gpuCalls: { p95: 500 + frameMedian },
                gpuTriangles: { p95: 1000 + frameP95 },
            },
        },
        summary: {
            movingStutters: stutters,
            worstFrames: [{ frameMs: frameP95 + 50, renderMs: frameP95, cause: 'render' }],
        },
        gpuPrograms: 40 + stutters,
        phaseSnapshots: {
            settle: { frameAvgMs: frameMedian - 1, queues: [{ pendingItems: stutters }] },
        },
    };
}

test('summarizes valid repetitions without allowing invalid runs into medians', () => {
    const manifest = {
        baselineRef: 'abc',
        runsPerScenario: 3,
        settleSeconds: 30,
        scenarios: [{ id: 'tram', label: 'Tram' }],
    };
    const summary = summarizeBaselineArtifacts(manifest, [
        artifact('tram', 10, 20, 2, 100),
        artifact('tram', 12, 30, 4, 120),
        artifact('tram', 1, 2, 0, 1, false),
    ], { generatedAt: 'fixed' });

    assert.equal(summary.generatedAt, 'fixed');
    assert.equal(summary.revision, 'abc');
    assert.equal(summary.scenarios[0].validRuns, 2);
    assert.equal(summary.scenarios[0].movingFrameMs.medianOfMedians, 11);
    assert.equal(summary.scenarios[0].movingFrameMs.medianP95, 25);
    assert.equal(summary.scenarios[0].movingStutters.median, 3);
    assert.equal(summary.scenarios[0].startup.medianRequests, 110);
    assert.equal(summary.scenarios[0].startup.medianStation3dCodeRequests, 22);
    assert.equal(summary.scenarios[0].startup.maxStation3dDependencyCdnRequests, 0);
    assert.equal(summary.scenarios[0].startup.maxThirdPartyCdnRequests, 0);
    assert.equal(summary.scenarios[0].startup.medianRuntimeReadyMs, 440);
    assert.equal(summary.scenarios[0].worstFrame.frameMs, 80);
});

test('candidate metadata and an explicit revision use the same compact reducer', () => {
    const run = artifact('tram', 9, 18, 1, 24);
    delete run.baseline;
    run.performanceMatrix = { scenarioId: 'tram' };
    const summary = summarizeBaselineArtifacts({
        baselineRef: 'base',
        runsPerScenario: 1,
        settleSeconds: 30,
        scenarios: [{ id: 'tram', label: 'Tram' }],
    }, [run], { revision: 'candidate', generatedAt: 'fixed' });
    assert.equal(summary.revision, 'candidate');
    assert.equal(summary.scenarios[0].validRuns, 1);
    assert.equal(summary.scenarios[0].startup.medianRequests, 24);
});
