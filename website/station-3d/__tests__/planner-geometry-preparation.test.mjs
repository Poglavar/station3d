import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { disposeGroup } from '../core/dispose.js';
import { PLANNER_GEOMETRY_LIMITS } from '../core/planner-geometry-budget.js';
import { createPlannerGeometryRuntime, plannerGeometrySignature, plannerFixtureSegments } from './fixtures/planner-geometry-runtime.mjs';

// Captured by the actual frozen v75 compiler before cooperative conversion.
// Concrete pixels and marker rendering are omitted; marker placement is kept.
const before = JSON.parse(readFileSync(new URL('./fixtures/planner-geometry-before.json', import.meta.url), 'utf8'));
function finish(steps, inspect = () => {}) {
    try { for (let i = 0; i < 200000; i++) {
        const next = steps.next(); inspect(next);
        if (next.done) return next.value;
    } assert.fail('Planner geometry did not converge'); } finally { steps.return(); }
}

test('planner geometry preserves eight frozen non-floor mesh, instance, normal and tunnel-state goldens', () => {
    const phases = new Set();
    for (const fixture of before.fixtures) {
        const { context, markers } = createPlannerGeometryRuntime(); let clock = 0;
        const root = finish(context.buildPlannerGeometrySteps(fixture.features, 45, 16,
            plannerFixtureSegments(fixture.features), [], { preparation: { now: () => clock += 1 } }),
        next => { if (!next.done) phases.add(next.value.phase); });
        try {
            assert.equal(root.parent, null);
            // The floor foundation now backs the full civil cut and follows
            // its miter; its changed geometry has independent coverage tests.
            // Keep every other mesh and the tunnel/marker state byte-exact.
            const signature = plannerGeometrySignature(root, markers);
            const withoutFloors = meshes => meshes.filter(mesh => !/^PlannerTunnel(?:Interior)?Floors$/.test(mesh.name));
            assert.deepEqual({ ...signature, meshes: withoutFloors(signature.meshes) },
                { meshes: withoutFloors(fixture.meshes), enclosedSpans: fixture.enclosedSpans, markers: fixture.markers }, fixture.name);
        } finally { disposeGroup(root); }
    }
    for (const phase of ['planner-owned-segments', 'planner-segment', 'planner-tunnel-chunk',
        'planner-prism-vertices', 'planner-instance-matrix', 'planner-instance-colour']) assert.ok(phases.has(phase), phase);
});

test('planner cancellation and stale inputs release private geometry, instance attributes and unused materials', () => {
    const fixture = before.fixtures[0];
    for (const mode of ['cancel', 'stale', 'complete']) {
        const { context, resources } = createPlannerGeometryRuntime({ trackResources: true });
        let clock = 0, valid = true;
        const steps = context.buildPlannerGeometrySteps(fixture.features, 45, 16, plannerFixtureSegments(fixture.features), [],
            { preparation: { now: () => clock += 1, isCurrent: () => valid } });
        let seen = false;
        try {
            for (let i = 0; i < 10000; i++) {
                const next = steps.next();
                if (next.done) { assert.equal(mode, 'complete'); disposeGroup(next.value); break; }
                if (next.value.phase === 'planner-instance-matrix' && mode !== 'complete') {
                    seen = true;
                    if (mode === 'stale') { valid = false; assert.throws(() => steps.next(), { code: 'ground-generation-stale' }); }
                    break;
                }
            }
        } finally { steps.return(); }
        if (mode !== 'complete') assert.equal(seen, true);
        assert.ok(resources.size > 10);
        for (const [resource, count] of resources) assert.equal(count, 1, `${mode}: ${resource.type}`);
    }
});

test('planner route, segment, stop and box capacities reject the whole candidate before renderer allocation', () => {
    const fixture = before.fixtures[4];
    for (const [key, value, stops] of [['maxSegments', 1, []], ['maxRouteMeters', 1, []],
        ['maxStops', 1, [{}, {}]], ['maxBoxes', 1, []]]) {
        const { context, resources } = createPlannerGeometryRuntime({ trackResources: true });
        assert.throws(() => finish(context.buildPlannerGeometrySteps(fixture.features, 45, 16,
            plannerFixtureSegments(fixture.features), stops, { preparation: { limits: { ...PLANNER_GEOMETRY_LIMITS, [key]: value } } })),
        { code: 'ground-generation-capacity' }, key);
        assert.equal(resources.size, 0, key);
    }
});
