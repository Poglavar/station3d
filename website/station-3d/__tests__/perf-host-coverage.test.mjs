// Regression coverage for the clean-host acceptance policy used by perf runs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    assessPerfHostCoverage,
    MIN_CLEAN_HOST_WINDOW_FRACTION,
} from '../core/perf-host-coverage.js';

const clean = () => ({ host: { level: 'clean', contended: false } });
const busy = () => ({ host: { level: 'busy', contended: true } });

test('a 59-second capture remains valid with five flagged probe windows', () => {
    const coverage = assessPerfHostCoverage([
        ...Array.from({ length: 54 }, clean),
        ...Array.from({ length: 5 }, busy),
    ]);

    assert.equal(coverage.valid, true);
    assert.equal(coverage.knownHostSamples, 59);
    assert.equal(coverage.cleanHostSamples, 54);
    assert.equal(coverage.busyHostSamples, 5);
    assert.ok(coverage.cleanFraction > MIN_CLEAN_HOST_WINDOW_FRACTION);
});

test('a capture below ninety percent clean is rejected', () => {
    const coverage = assessPerfHostCoverage([
        ...Array.from({ length: 53 }, clean),
        ...Array.from({ length: 6 }, busy),
    ]);

    assert.equal(coverage.valid, false);
    assert.ok(coverage.cleanFraction < MIN_CLEAN_HOST_WINDOW_FRACTION);
});

test('contended clean-labelled windows remain flagged', () => {
    const coverage = assessPerfHostCoverage([
        ...Array.from({ length: 9 }, clean),
        { host: { level: 'clean', contended: true } },
    ]);

    assert.equal(coverage.valid, true, 'exactly ninety percent clean is accepted');
    assert.equal(coverage.busyHostSamples, 1);
});

test('unknown-only coverage cannot certify a timing run', () => {
    const coverage = assessPerfHostCoverage([
        { host: { level: 'unknown', contended: false } },
        {},
    ]);

    assert.equal(coverage.valid, false);
    assert.equal(coverage.knownHostSamples, 0);
    assert.equal(coverage.cleanFraction, null);
});
