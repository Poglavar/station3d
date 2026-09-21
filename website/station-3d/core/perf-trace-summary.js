// Reduces raw Station3D stutter snapshots into honest duration-based tables for
// the automated trace harness. Pure data in/out keeps attribution unit-testable.

import { describeStutter } from './perf-overlay-model.js';

function finiteMs(value) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, value)
        : 0;
}

function numericValues(samples, key) {
    return (samples || [])
        .map(sample => sample?.[key])
        .filter(value => typeof value === 'number' && Number.isFinite(value));
}

function quantile(values, fraction) {
    if (values.length === 0) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    const weight = position - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function parseTimedTokens(value) {
    const tokens = String(value || '').trim().split(/\s+/).filter(Boolean);
    const parsed = [];
    for (const token of tokens) {
        const separator = token.lastIndexOf(':');
        if (separator <= 0) continue;
        const name = token.slice(0, separator);
        const ms = Number(token.slice(separator + 1));
        if (!name || !Number.isFinite(ms) || ms < 0) continue;
        parsed.push({ name, ms });
    }
    return parsed;
}

function addStat(stats, name, ms, frameMs) {
    if (!name) return;
    const durationMs = finiteMs(ms);
    const frameDurationMs = finiteMs(frameMs);
    const current = stats.get(name) || {
        name,
        count: 0,
        totalMs: 0,
        worstMs: 0,
        worstFrameMs: 0,
        over50ms: 0,
    };
    current.count += 1;
    current.totalMs += durationMs;
    current.worstMs = Math.max(current.worstMs, durationMs);
    current.worstFrameMs = Math.max(current.worstFrameMs, frameDurationMs);
    if (durationMs >= 50) current.over50ms += 1;
    stats.set(name, current);
}

function sortedStats(stats) {
    return [...stats.values()].sort((a, b) => (
        b.totalMs - a.totalMs
        || b.worstMs - a.worstMs
        || a.name.localeCompare(b.name)
    ));
}

function diagnosedDuration(stutter, cause) {
    const parsed = parseTimedTokens(cause);
    if (parsed.length === 1 && parsed[0].name === cause.slice(0, cause.lastIndexOf(':'))) {
        if (parsed[0].name === 'hooks') {
            return { name: 'hooks', ms: finiteMs(stutter?.hooksMs) };
        }
        if (parsed[0].name === 'render') {
            return { name: 'render', ms: finiteMs(stutter?.renderMs) };
        }
        if (parsed[0].name === 'stall') {
            return { name: 'stall', ms: finiteMs(stutter?.stallMs) };
        }
        return parsed[0];
    }
    if (cause === 'outside-loop') return { name: cause, ms: finiteMs(stutter?.stallMs) };
    if (cause === 'unattributed') return { name: cause, ms: finiteMs(stutter?.hooksMs) };
    return { name: cause || 'unknown', ms: 0 };
}

export function summarizePerfTrace(snapshot = {}) {
    const stutters = Array.isArray(snapshot?.stutters) ? snapshot.stutters : [];
    const owners = new Map();
    const causes = new Map();
    const phases = new Map();
    const outsideWork = new Map();

    for (const stutter of stutters) {
        const components = [
            ['hooks', finiteMs(stutter?.hooksMs)],
            ['render', finiteMs(stutter?.renderMs)],
            ['stall', finiteMs(stutter?.stallMs)],
        ];
        components.sort((a, b) => b[1] - a[1]);
        addStat(owners, components[0][0], components[0][1], stutter?.frameMs);

        const diagnosis = describeStutter(stutter).cause;
        const diagnosed = diagnosedDuration(stutter, diagnosis);
        addStat(causes, diagnosed.name, diagnosed.ms, stutter?.frameMs);

        for (const part of parseTimedTokens(stutter?.layers)) {
            addStat(phases, part.name, part.ms, stutter?.frameMs);
        }
        for (const part of parseTimedTokens(stutter?.outside)) {
            addStat(outsideWork, part.name, part.ms, stutter?.frameMs);
        }
    }

    const worstFrames = stutters
        .slice()
        .sort((a, b) => finiteMs(b?.frameMs) - finiteMs(a?.frameMs))
        .slice(0, 12)
        .map(stutter => ({
            atMs: finiteMs(stutter?.atMs),
            frameMs: finiteMs(stutter?.frameMs),
            hooksMs: finiteMs(stutter?.hooksMs),
            renderMs: finiteMs(stutter?.renderMs),
            stallMs: finiteMs(stutter?.stallMs),
            longTaskMs: finiteMs(stutter?.longTaskMs),
            cause: describeStutter(stutter).cause,
            layers: String(stutter?.layers || ''),
            outside: String(stutter?.outside || ''),
            background: String(stutter?.background || ''),
            gpuCalls: finiteMs(stutter?.gpuCalls),
            gpuTriangles: finiteMs(stutter?.gpuTriangles),
            gpuPrograms: finiteMs(stutter?.gpuPrograms),
            gpuGeometries: finiteMs(stutter?.gpuGeometries),
            gpuTextures: finiteMs(stutter?.gpuTextures),
            gpuAttribution: stutter?.gpuAttribution || null,
            resourceUploadState: String(stutter?.resourceUploadState || ''),
            hostBusy: stutter?.hostBusy === true,
            stationary: stutter?.stationary !== false,
        }));

    return {
        stutterTotal: typeof snapshot?.stutterTotal === 'number'
            && Number.isFinite(snapshot.stutterTotal)
            ? Math.max(0, snapshot.stutterTotal)
            : stutters.length,
        heldStutters: stutters.length,
        hostBusyStutters: stutters.filter(stutter => stutter?.hostBusy === true).length,
        movingStutters: stutters.filter(stutter => stutter?.stationary === false).length,
        startupStutters: stutters.filter(stutter => (
            String(stutter?.background || '').startsWith('startup:')
        )).length,
        owners: sortedStats(owners),
        causes: sortedStats(causes),
        phases: sortedStats(phases),
        outsideWork: sortedStats(outsideWork),
        worstFrames,
    };
}

// Older branches expose the trace snapshot but not the native phase-reset
// hook. Keep their startup history out of a movement A/B by taking a monotonic
// page-time boundary immediately before movement and retaining only stutters
// recorded after it. Modern runtimes still use their full native reset; this
// is a compatibility adapter for measuring an unchanged historical baseline.
export function isolatePerfTraceMeasurement(snapshot = {}, startedAtMs) {
    const boundary = Number(startedAtMs);
    if (!Number.isFinite(boundary)) return snapshot;
    const stutters = (Array.isArray(snapshot?.stutters) ? snapshot.stutters : [])
        .filter(stutter => (
            typeof stutter?.atMs === 'number'
            && Number.isFinite(stutter.atMs)
            && stutter.atMs >= boundary
        ));
    return {
        ...snapshot,
        stutters,
        stutterTotal: stutters.length,
        measurementStartedAtMs: boundary,
    };
}

export function summarizePerfSamples(samples = []) {
    const metrics = {};
    for (const key of [
        'fps',
        'frameAvgMs',
        'hooksMs',
        'renderMs',
        'stallMs',
        'gpuCalls',
        'gpuTriangles',
        'pendingItems',
        'speedMps',
    ]) {
        const values = numericValues(samples, key);
        metrics[key] = {
            count: values.length,
            median: quantile(values, 0.5),
            p05: quantile(values, 0.05),
            p95: quantile(values, 0.95),
            min: values.length ? Math.min(...values) : null,
            max: values.length ? Math.max(...values) : null,
        };
    }
    return {
        windows: samples.length,
        cleanWindows: samples.filter(sample => sample?.host?.level === 'clean').length,
        busyWindows: samples.filter(sample => (
            sample?.host?.contended === true
            || sample?.host?.level === 'busy'
            || sample?.host?.level === 'overloaded'
        )).length,
        movingWindows: samples.filter(sample => (
            (typeof sample?.speedMps === 'number' && sample.speedMps >= 0.5)
            || (sample?.motionState && sample.motionState !== 'stationary')
        )).length,
        metrics,
    };
}
