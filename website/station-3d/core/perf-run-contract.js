// Defines the Station3D benchmark observer mode and the dimensions that must
// match before two trace artifacts may be treated as a performance A/B pair.

export const PERF_PROFILER_MODE = Object.freeze({
    TIMING: 'timing',
    DRAW_ATTRIBUTION: 'draw-attribution',
});

export function resolvePerfProfilerMode(params) {
    const value = String(params?.get?.('perfAttribution') || '').trim().toLowerCase();
    return ['1', 'true', 'on', 'yes'].includes(value)
        ? PERF_PROFILER_MODE.DRAW_ATTRIBUTION
        : PERF_PROFILER_MODE.TIMING;
}

export function drawCallAttributionEnabled(params) {
    return resolvePerfProfilerMode(params) === PERF_PROFILER_MODE.DRAW_ATTRIBUTION;
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.keys(value).sort().map(key => [key, canonical(value[key])]),
    );
}

function comparableContext(run) {
    const harness = run?.harness || {};
    const context = harness.runtimeContext || {};
    const route = harness.route || {};
    const numericDpr = Number(context.dpr);
    return {
        headless: harness.headless === true,
        sourceFixtures: harness.sourceFixtures ? {
            schema: harness.sourceFixtures.schema,
            manifestHash: harness.sourceFixtures.manifestHash,
            replay: harness.sourceFixtures.replay === true,
        } : null,
        observer: {
            frameCadence: harness.observer?.frameCadence || null,
            chromeTimeline: harness.observer?.chromeTimeline === true,
            chromeTimelineMode: harness.observer?.chromeTimeline === true
                ? (harness.observer?.chromeTimelineMode || 'full') : null,
            cpuProfile: harness.observer?.cpuProfile === true,
            heapProfile: harness.observer?.heapProfile === true,
            disableQuic: harness.observer?.disableQuic === true,
            renderStalls: harness.observer?.renderStalls === true,
        },
        route: {
            pathname: route.pathname || null,
            startPolicy: route.startPolicy || 'ready',
            groundSettledStart: route.groundSettledStart === true,
            driveVehicle: route.driveVehicle || null,
            tramRoute: canonical(route.tramRoute || null),
            params: canonical(route.params || {}),
            walk: canonical(route.walk || []),
            walkCorridor: canonical(route.walkCorridor || null),
            autonomousSeconds: Number(route.autonomousSeconds),
            settleSeconds: Number(route.settleSeconds),
            viewport: canonical(route.viewport || null),
        },
        runtime: {
            profilerMode: context.profilerMode || null,
            quality: canonical(context.quality || null),
            terrainActive: context.terrainActive === true,
            terrainPolicy: context.terrainPolicy || null,
            sourceProfile: canonical(context.sourceProfile || null),
            dpr: Number.isFinite(numericDpr)
                ? Math.round(numericDpr * 1000) / 1000
                : null,
            activeLayers: Array.isArray(context.activeLayers)
                ? [...new Set(context.activeLayers.map(String))].sort()
                : null,
            worldMode: context.worldMode || null,
            renderGrade: context.renderGrade || null,
            sessionPresetId: context.sessionPresetId || null,
        },
    };
}

function collectMismatches(baseline, candidate, path, mismatches) {
    if (Array.isArray(baseline) || Array.isArray(candidate)) {
        if (JSON.stringify(baseline) !== JSON.stringify(candidate)) {
            mismatches.push({ field: path, baseline, candidate });
        }
        return;
    }
    const baselineObject = baseline && typeof baseline === 'object';
    const candidateObject = candidate && typeof candidate === 'object';
    if (baselineObject || candidateObject) {
        const keys = new Set([
            ...Object.keys(baselineObject ? baseline : {}),
            ...Object.keys(candidateObject ? candidate : {}),
        ]);
        for (const key of [...keys].sort()) {
            collectMismatches(
                baselineObject ? baseline[key] : undefined,
                candidateObject ? candidate[key] : undefined,
                path ? `${path}.${key}` : key,
                mismatches,
            );
        }
        return;
    }
    if (!Object.is(baseline, candidate)) {
        mismatches.push({ field: path, baseline, candidate });
    }
}

export function perfRunCompatibilityMismatches(baselineRun, candidateRun) {
    const mismatches = [];
    collectMismatches(
        comparableContext(baselineRun),
        comparableContext(candidateRun),
        '',
        mismatches,
    );
    return mismatches;
}

export function formatPerfRunMismatch(mismatch) {
    const printable = value => (value === undefined ? '<missing>' : JSON.stringify(value));
    return `${mismatch.field}: ${printable(mismatch.baseline)} != ${printable(mismatch.candidate)}`;
}
