// Reduces repeated Station3D trace artifacts into a compact, reviewable A/B
// reference while leaving the large raw browser captures outside git.

function finiteOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function quantile(values, fraction) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (sorted.length === 0) return null;
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    const weight = position - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function maximum(values) {
    const finite = values.filter(Number.isFinite);
    return finite.length ? Math.max(...finite) : null;
}

function metric(run, key, statistic) {
    return finiteOrNull(run?.sampleSummary?.metrics?.[key]?.[statistic]);
}

function worstFrame(run) {
    return (run?.summary?.worstFrames || []).reduce((worst, frame) => (
        (finiteOrNull(frame?.frameMs) || 0) > (finiteOrNull(worst?.frameMs) || 0)
            ? frame
            : worst
    ), null);
}

function summarizeScenario(scenario, runs) {
    const validRuns = runs.filter(run => run?.harness?.validation?.valid === true);
    const startupNetworks = validRuns
        .map(run => run?.harness?.network?.startup)
        .filter(Boolean);
    const worst = validRuns.map(worstFrame).filter(Boolean)
        .sort((a, b) => (finiteOrNull(b.frameMs) || 0) - (finiteOrNull(a.frameMs) || 0))[0]
        || null;
    const numbers = (select) => validRuns.map(select).filter(Number.isFinite);
    return {
        id: scenario.id,
        label: scenario.label,
        requestedRuns: runs.length,
        validRuns: validRuns.length,
        movingFrameMs: {
            medianOfMedians: quantile(numbers(run => metric(run, 'frameAvgMs', 'median')), 0.5),
            medianP95: quantile(numbers(run => metric(run, 'frameAvgMs', 'p95')), 0.5),
        },
        movingStutters: {
            median: quantile(numbers(run => finiteOrNull(run?.summary?.movingStutters)), 0.5),
            min: numbers(run => finiteOrNull(run?.summary?.movingStutters)).length
                ? Math.min(...numbers(run => finiteOrNull(run?.summary?.movingStutters)))
                : null,
            max: numbers(run => finiteOrNull(run?.summary?.movingStutters)).length
                ? Math.max(...numbers(run => finiteOrNull(run?.summary?.movingStutters)))
                : null,
        },
        gpu: {
            medianCallsP95: quantile(numbers(run => metric(run, 'gpuCalls', 'p95')), 0.5),
            medianTrianglesP95: quantile(numbers(run => metric(run, 'gpuTriangles', 'p95')), 0.5),
            maxPrograms: numbers(run => finiteOrNull(run?.gpuPrograms)).length
                ? Math.max(...numbers(run => finiteOrNull(run?.gpuPrograms)))
                : null,
        },
        startup: {
            medianRequests: quantile(startupNetworks.map(row => finiteOrNull(row.requests)), 0.5),
            medianEncodedBytes: quantile(startupNetworks.map(row => finiteOrNull(row.encodedBytes)), 0.5),
            medianDecodedBytes: quantile(startupNetworks.map(row => finiteOrNull(row.decodedBytes)), 0.5),
            medianStation3dCodeRequests: quantile(
                startupNetworks.map(row => finiteOrNull(row?.station3dCode?.requests)),
                0.5,
            ),
            maxStation3dDependencyCdnRequests: maximum(
                startupNetworks.map(row => finiteOrNull(row?.station3dDependencyCdn?.requests)),
            ),
            maxThirdPartyCdnRequests: maximum(
                startupNetworks.map(row => finiteOrNull(row?.thirdPartyCdn?.requests)),
            ),
            medianRuntimeReadyMs: quantile(
                numbers(run => finiteOrNull(run?.harness?.runtimeTiming?.durationMs)),
                0.5,
            ),
            medianWorldReadyMs: quantile(
                numbers(run => finiteOrNull(run?.harness?.worldReady?.elapsedMs)),
                0.5,
            ),
        },
        settle: {
            medianFrameMs: quantile(
                numbers(run => finiteOrNull(run?.phaseSnapshots?.settle?.frameAvgMs)),
                0.5,
            ),
            medianPendingItems: quantile(numbers((run) => (
                (run?.phaseSnapshots?.settle?.queues || []).reduce(
                    (sum, queue) => sum + (finiteOrNull(queue?.pendingItems) || 0),
                    0,
                )
            )), 0.5),
        },
        worstFrame: worst ? {
            frameMs: finiteOrNull(worst.frameMs),
            hooksMs: finiteOrNull(worst.hooksMs),
            renderMs: finiteOrNull(worst.renderMs),
            stallMs: finiteOrNull(worst.stallMs),
            cause: worst.cause || null,
            hostBusy: worst.hostBusy === true,
        } : null,
    };
}

export function summarizeBaselineArtifacts(manifest, artifacts, {
    revision = null,
    generatedAt = new Date().toISOString(),
} = {}) {
    const runsByScenario = new Map();
    for (const artifact of artifacts || []) {
        const scenarioId = artifact?.performanceMatrix?.scenarioId
            || artifact?.baseline?.scenarioId;
        if (!scenarioId) continue;
        const list = runsByScenario.get(scenarioId) || [];
        list.push(artifact);
        runsByScenario.set(scenarioId, list);
    }
    return {
        comment: 'Compact Station3D performance summary; raw trace artifacts are intentionally ignored.',
        schemaVersion: 1,
        generatedAt,
        revision: revision || manifest?.baselineRef || null,
        runsPerScenario: Number(manifest?.runsPerScenario) || 0,
        settleSeconds: Number(manifest?.settleSeconds) || 0,
        scenarios: (manifest?.scenarios || []).map(scenario => (
            summarizeScenario(scenario, runsByScenario.get(scenario.id) || [])
        )),
    };
}
