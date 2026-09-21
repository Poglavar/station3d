// Keep native memory/load observations separate from timing admission, and make
// paired run ordering and comparability explicit without discarding slow frames.
import { assessPerfHostCoverage } from './perf-host-coverage.js';
import { perfRunCompatibilityMismatches } from './perf-run-contract.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const sumKnown = values => values.some(finite)
    ? values.filter(finite).reduce((sum, value) => sum + value, 0) : null;

export function parseNativeMemorySample(raw) {
    const size = String(raw).match(/page size of (\d+) bytes/);
    return {
        pageSizeBytes: size ? Number(size[1]) : null,
        counters: Object.fromEntries(
            [...String(raw).matchAll(/^([^:\n]+):\s+(\d+)\./gm)]
                .map(match => [match[1], Number(match[2])]),
        ),
    };
}

export function summarizeNativeContext(rows = [], samples = []) {
    const timestamps = samples.map(sample => sample?.at).filter(finite);
    const start = timestamps.length ? Math.min(...timestamps) : null;
    const end = timestamps.length ? Math.max(...timestamps) : null;
    const durationMs = start !== null && end > start ? end - start : null;
    const inside = durationMs === null ? [] : rows.filter(row => {
        const at = Date.parse(row.at);
        return at >= start && at <= end;
    });
    const intervals = [];
    for (let index = 1; index < inside.length; index++) {
        const before = inside[index - 1], after = inside[index];
        const elapsedMs = Date.parse(after.at) - Date.parse(before.at);
        const delta = key => {
            const first = before.counters?.[key], last = after.counters?.[key];
            return elapsedMs > 0 && finite(first) && finite(last) && last >= first
                && finite(after.pageSizeBytes) && after.pageSizeBytes > 0
                && before.pageSizeBytes === after.pageSizeBytes
                ? (last - first) * after.pageSizeBytes / 1048576 : null;
        };
        const incomingMiB = delta('Swapins'), outgoingMiB = delta('Swapouts');
        const loads = [before.load?.[0], after.load?.[0]].filter(finite);
        intervals.push({ from: before.at, to: after.at, elapsedMs,
            incomingMiB, outgoingMiB,
            incomingMiBPerSecond: incomingMiB === null ? null : incomingMiB * 1000 / elapsedMs,
            outgoingMiBPerSecond: outgoingMiB === null ? null : outgoingMiB * 1000 / elapsedMs,
            load1: loads.length ? Math.max(...loads) : null,
            complete: incomingMiB !== null && outgoingMiB !== null,
        });
    }
    const coveredMs = sumKnown(intervals.filter(row => row.complete).map(row => row.elapsedMs));
    const incoming = sumKnown(intervals.map(row => row.incomingMiB));
    const outgoing = sumKnown(intervals.map(row => row.outgoingMiB));
    const warnings = [];
    if (!intervals.length) warnings.push('native movement context unavailable; not zero paging');
    if (intervals.some(row => !row.complete)) {
        warnings.push('missing/reset counters or invalid interval; unknown deltas are retained as null');
    }
    if (intervals.some(row => row.elapsedMs > 7500)) {
        warnings.push('native sampling gaps exceed 7.5 seconds; interval totals are retained');
    }
    if (incoming > 0 || outgoing > 0) {
        warnings.push('system-wide paging observed; not proof of external contention or a process attribution');
    }
    return {
        role: 'context-only', durationMs, coveredMs,
        coverage: durationMs !== null && coveredMs !== null ? coveredMs / durationMs : null,
        totalIncomingMiB: incoming, totalOutgoingMiB: outgoing,
        totalsScope: 'known counter deltas between native samples wholly inside movement; no boundary interpolation',
        intervals, warnings,
    };
}

export function createPairedPlan(scenarios) {
    if (!Array.isArray(scenarios) || scenarios.length === 0
        || scenarios.some(row => !/^[a-z0-9][a-z0-9-]*$/.test(row.id))
        || new Set(scenarios.map(row => row.id)).size !== scenarios.length) {
        throw new Error('Scenarios require unique lowercase filename-safe IDs');
    }
    return scenarios.flatMap(scenario => (
        ['baseline', 'candidate', 'candidate', 'baseline'].map((variant, index) => ({
            scenario, variant, run: index < 2 ? 1 : 2,
            id: `${variant}-${scenario.id}-${index < 2 ? 1 : 2}`,
        }))
    ));
}

export function evaluateBenchmarkRun(artifact, { status = 0, requireRailFormation = false } = {}) {
    const harness = artifact?.harness;
    const reasons = [...(harness?.validation?.reasons || [])];
    if (status !== 0) reasons.push(`capture exited with ${status}`);
    if (harness?.validation?.valid !== true) reasons.push('harness validation failed or missing');
    const host = assessPerfHostCoverage(harness?.measurementSamples || []);
    if (!host.valid) reasons.push('insufficient clean CPU coverage');
    if (harness?.errors?.length) reasons.push('console/page errors occurred');
    if (harness?.headless === true) reasons.push('headless capture is not a timing measurement');
    if (harness?.worldReady?.outcomeVerified !== true) reasons.push('world readiness outcome not verified');
    if (harness?.route?.startPolicy?.includes('fully-built') && harness?.settledStart?.ready !== true) {
        reasons.push('initial world queues did not settle');
    }
    const backgrounds = [artifact, ...Object.values(artifact?.phaseSnapshots || {})]
        .flatMap(snapshot => snapshot?.background || []);
    if (backgrounds.some(row => ['buildFailed', 'fetchFailed', 'failed', 'retrying']
        .some(key => finite(row[key]) && row[key] > 0))) {
        reasons.push('reported build/fetch failure or unresolved retry');
    }
    if (requireRailFormation) {
        const rail = artifact?.runtimeDiagnostics?.railFormation;
        if (!(rail?.alignments > 0 && rail?.segments > 0)) reasons.push('missing live rail formation coverage');
    }
    return { accepted: reasons.length === 0, reasons: [...new Set(reasons)], host };
}

export function compareBenchmarkPair(baseline, candidate) {
    const mismatches = perfRunCompatibilityMismatches(baseline, candidate);
    return {
        comparable: evaluateBenchmarkRun(baseline).accepted
            && evaluateBenchmarkRun(candidate).accepted && mismatches.length === 0,
        mismatches,
    };
}
