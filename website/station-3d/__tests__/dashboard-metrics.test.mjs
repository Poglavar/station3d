// Each trackside metric owns a gauge, with stable placeholder/value formatting
// so none of the fixed-size boxes blink in and out on near-level runs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDashboardMetricValues, formatLoadTelemetry } from '../core/dashboard-metrics.js';

// The loading counter shows what was downloaded when the cab reports wire
// bytes, and the decoded estimate (labelled as such) only when it cannot.
test('the loading counter prefers the wire figure over the decoded estimate', () => {
    const labels = { downloaded: 'downloaded', decoded: 'decoded' };
    assert.equal(formatLoadTelemetry({ elapsedMs: 12400, receivedBytes: 36_200_000, transferBytes: 6_400_000 }, labels), '12 s · 6.4 MB downloaded');
    assert.equal(formatLoadTelemetry({ elapsedMs: 12400, receivedBytes: 36_200_000, transferBytes: 0 }, labels), '12 s · 36.2 MB decoded');
    assert.equal(formatLoadTelemetry({ elapsedMs: 900, receivedBytes: 512_000 }), '0 s · 0.5 MB', 'no labels for the photo bar');
    assert.equal(formatLoadTelemetry(), '0 s · 0.0 MB');
});

test('a near-level grade still occupies its slot instead of vanishing', () => {
    // 0.04% used to be dropped entirely; 0.06% was shown. Riding between them
    // made the readout flicker and re-flow.
    const justUnder = formatDashboardMetricValues(-8.2, false, 0.04, '1.4 km');
    const justOver = formatDashboardMetricValues(-8.2, false, 0.06, '1.4 km');
    assert.equal(justUnder.grade, '0.0%');
    assert.equal(justOver.grade, '+0.1%');
});

test('every gauge remains populated across a whole near-level run', () => {
    for (const g of [-0.3, -0.06, -0.04, -0.01, 0, 0.01, 0.04, 0.06, 0.3]) {
        const values = formatDashboardMetricValues(-8.2, false, g, '1.4 km');
        assert.notEqual(values.altitude, '–');
        assert.notEqual(values.grade, '–');
        assert.notEqual(values.chainage, '–');
    }
});

test('an absent value leaves a dash in its own gauge', () => {
    assert.equal(formatDashboardMetricValues(-8.2, false, null, '1.4 km').grade, '–');
    assert.equal(formatDashboardMetricValues(-8.2, false, NaN, '1.4 km').grade, '–');
    assert.equal(formatDashboardMetricValues(-8.2, false, 1.2, '').chainage, '–');
});

test('keeps the existing sign and unit conventions', () => {
    const positive = formatDashboardMetricValues(3.5, false, 2.1, '');
    assert.equal(positive.altitude, '+3.5 m');
    assert.equal(positive.grade, '+2.1%');
    assert.equal(formatDashboardMetricValues(-2, false, -1.5, '').grade, '-1.5%');
    // absolute mode is unsigned metres above sea level
    assert.equal(formatDashboardMetricValues(122.4, true, null, '').altitude, '122.4 m');
});

test('nothing at all leaves three stable dash gauges', () => {
    assert.deepEqual(formatDashboardMetricValues(undefined, false, null, ''), {
        altitude: '–',
        grade: '–',
        chainage: '–',
    });
    assert.equal(formatDashboardMetricValues(NaN, false, null, '').altitude, '–');
});

test('a null altitude reads as 0.0 m, not a dash', () => {
    // Number(null) is 0, not NaN, so null has always rendered as a real zero
    // altitude. Pinning it because it is surprising enough to "fix" by accident.
    assert.equal(formatDashboardMetricValues(null, false, null, '').altitude, '0.0 m');
});
