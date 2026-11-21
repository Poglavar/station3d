import test from 'node:test';
import assert from 'node:assert/strict';

import {
    summarizeAttributionArtifacts,
    summarizeLifecycleCapture,
} from '../core/perf-diagnostics-summary.js';

test('draw attribution summary retains ranked ownership and startup floors', () => {
    const summary = summarizeAttributionArtifacts({
        baselineRef: 'abc',
        scenarios: [{ id: 'tram' }],
    }, [{
        diagnostic: { scenarioId: 'tram', ownershipValid: true },
        gpuCalls: 100,
        gpuTriangles: 200,
        gpuPrograms: 4,
        gpuAttributionSummary: {
            mainCalls: 70,
            shadowCalls: 20,
            unattributedCalls: 10,
            groups: [{ name: 'platforms', calls: 30, mainCalls: 20, shadowCalls: 10 }],
        },
        harness: {
            validation: { valid: true },
            runtimeContext: { worldMode: 'model' },
            network: { startup: { requests: 550, encodedBytes: 13, decodedBytes: 25 } },
        },
    }], { generatedAt: 'fixed' });
    assert.equal(summary.revision, 'abc');
    assert.equal(summary.scenarios[0].gpu.groups[0].name, 'platforms');
    assert.equal(summary.scenarios[0].startup.requests, 550);
});

test('draw attribution can identify a candidate revision', () => {
    const summary = summarizeAttributionArtifacts({
        baselineRef: 'base',
        scenarios: [{ id: 'tram' }],
    }, [], { generatedAt: 'fixed', revision: 'candidate' });
    assert.equal(summary.revision, 'candidate');
});

test('lifecycle summary requires all five closed states to match baseline', () => {
    const snapshot = {
        listeners: { active: 3 },
        timers: { active: 1 },
        resources: {
            objects: 2, drawables: 0, geometries: 0, materials: 0, textures: 0,
            programs: 1, rendererGeometries: 0, rendererTextures: 0,
        },
        background: [],
    };
    const summary = summarizeLifecycleCapture({
        revision: 'abc',
        baseline: snapshot,
        cycles: Array.from({ length: 5 }, (_, index) => ({
            cycle: index + 1,
            opened: snapshot,
            closed: index === 4
                ? { ...snapshot, listeners: { active: 4 } }
                : snapshot,
        })),
    }, { generatedAt: 'fixed' });
    assert.equal(summary.cycles[0].returnedToBaseline, true);
    assert.equal(summary.cycles[4].returnedToBaseline, false);
    assert.equal(summary.allReturnedToBaseline, false);
    assert.equal(summary.baseline.listeners, 3);
    assert.equal(summary.cycles[0].opened.resources.programs, 1);
    assert.equal('byTargetType' in summary.baseline, false);
});
