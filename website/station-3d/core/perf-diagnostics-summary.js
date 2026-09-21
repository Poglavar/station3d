// Compact reducers for the expensive browser-only Station3D diagnostics. Raw
// attribution/lifecycle captures remain ignored; these summaries are small
// enough to review and retain beside the formal timing baseline.

function finiteOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sumPending(entries, field = 'pending') {
    return (entries || []).reduce((sum, entry) => (
        sum + (finiteOrNull(entry?.[field]) || 0)
    ), 0);
}

function resourceDelta(current, baseline) {
    const fields = [
        'objects', 'drawables', 'geometries', 'materials', 'textures',
        'programs', 'rendererGeometries', 'rendererTextures',
    ];
    return Object.fromEntries(fields.map(field => [
        field,
        (finiteOrNull(current?.resources?.[field]) || 0)
            - (finiteOrNull(baseline?.resources?.[field]) || 0),
    ]));
}

function compactLifecycleSnapshot(snapshot) {
    return {
        listeners: finiteOrNull(snapshot?.listeners?.active) || 0,
        timers: finiteOrNull(snapshot?.timers?.active) || 0,
        resources: Object.fromEntries([
            'objects', 'drawables', 'geometries', 'materials', 'textures',
            'programs', 'rendererGeometries', 'rendererTextures',
        ].map(field => [field, finiteOrNull(snapshot?.resources?.[field]) || 0])),
        backgroundPending: sumPending(snapshot?.background),
        backgroundJobs: sumPending(snapshot?.background, 'jobs'),
        sessionActive: snapshot?.session != null,
    };
}

export function summarizeAttributionArtifacts(manifest, artifacts, {
    generatedAt = new Date().toISOString(),
    revision = null,
} = {}) {
    const byScenario = new Map((artifacts || []).map(artifact => [
        artifact?.diagnostic?.scenarioId,
        artifact,
    ]));
    return {
        comment: 'Station3D draw attribution baseline; raw traces are intentionally ignored.',
        schemaVersion: 1,
        generatedAt,
        revision: revision || manifest?.baselineRef || null,
        scenarios: (manifest?.scenarios || []).map((scenario) => {
            const artifact = byScenario.get(scenario.id);
            const attribution = artifact?.gpuAttributionSummary || null;
            const network = artifact?.harness?.network?.startup || null;
            return {
                id: scenario.id,
                valid: artifact?.diagnostic?.ownershipValid === true,
                timingValid: artifact?.harness?.validation?.valid === true,
                timingValidationReasons: artifact?.harness?.validation?.reasons || [],
                runtimeContext: artifact?.harness?.runtimeContext || null,
                gpu: {
                    calls: finiteOrNull(artifact?.gpuCalls),
                    triangles: finiteOrNull(artifact?.gpuTriangles),
                    programs: finiteOrNull(artifact?.gpuPrograms),
                    attributedMainCalls: finiteOrNull(attribution?.mainCalls),
                    attributedShadowCalls: finiteOrNull(attribution?.shadowCalls),
                    unattributedCalls: finiteOrNull(attribution?.unattributedCalls),
                    groups: (attribution?.groups || []).slice(0, 20).map(group => ({
                        name: String(group?.name || 'unclassified'),
                        calls: finiteOrNull(group?.calls),
                        mainCalls: finiteOrNull(group?.mainCalls),
                        shadowCalls: finiteOrNull(group?.shadowCalls),
                    })),
                },
                startup: network ? {
                    requests: finiteOrNull(network.requests),
                    encodedBytes: finiteOrNull(network.encodedBytes),
                    decodedBytes: finiteOrNull(network.decodedBytes),
                } : null,
            };
        }),
    };
}

export function summarizeLifecycleCapture(capture, {
    generatedAt = new Date().toISOString(),
} = {}) {
    const baseline = capture?.baseline || {};
    const cycles = (capture?.cycles || []).map((cycle) => {
        const listenerDelta = (finiteOrNull(cycle?.closed?.listeners?.active) || 0)
            - (finiteOrNull(baseline?.listeners?.active) || 0);
        const timerDelta = (finiteOrNull(cycle?.closed?.timers?.active) || 0)
            - (finiteOrNull(baseline?.timers?.active) || 0);
        const deltas = resourceDelta(cycle?.closed, baseline);
        const backgroundPending = sumPending(cycle?.closed?.background);
        return {
            cycle: cycle.cycle,
            opened: compactLifecycleSnapshot(cycle.opened),
            closed: compactLifecycleSnapshot(cycle.closed),
            closedDelta: {
                listeners: listenerDelta,
                timers: timerDelta,
                resources: deltas,
                backgroundPending,
            },
            returnedToBaseline: listenerDelta === 0
                && timerDelta === 0
                && backgroundPending === 0
                && Object.values(deltas).every(value => value === 0),
        };
    });
    return {
        comment: 'Five-cycle Station3D lifecycle baseline; raw per-cycle capture is ignored.',
        schemaVersion: 1,
        generatedAt,
        revision: capture?.revision || null,
        url: capture?.url || null,
        baseline: compactLifecycleSnapshot(baseline),
        cycles,
        allReturnedToBaseline: cycles.length === 5
            && cycles.every(cycle => cycle.returnedToBaseline),
    };
}
