// Predeclare randomized loaded-host comparisons and analyze whole run pairs,
// retaining pressure and uncertainty instead of treating a busy host as idle.
import { createHash, randomBytes } from 'node:crypto';
import { evaluatePerfAcceptanceRun } from './perf-acceptance-policy.mjs';

export const LOADED_PLAN_SCHEMA = 'station3d-perf-loaded-plan-v1';
const PHASES = ['stationary', 'movement'];
const METRICS = PHASES.flatMap(phase => ['p50Ms', 'p95Ms'].map(metric => `${phase}.${metric}`));
const HASH_FIELDS = ['scenarioHash', 'sourceHash', 'hostHash', 'observerHash', 'engineHash'];
const COMMON_FIELDS = ['scenarioHash', 'sourceHash', 'hostHash', 'observerHash', 'browser', 'gpu', 'viewport', 'renderContext'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const timestamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
const check = (reasons, condition, reason) => { if (!condition) reasons.push(reason); };
const canonical = value => JSON.stringify(value, (_, item) => record(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const equal = (a, b) => canonical(a) === canonical(b);

export function loadedPlanHash(plan) {
    const { hash, ...payload } = plan;
    return createHash('sha256').update(canonical(payload)).digest('hex');
}

function makeSlots({ id, kind, pairs, seed }) {
    // Exactly half AB and half BA, shuffled before any capture. Rejection sampling
    // avoids modulo bias; the seed records the draw and makes it reproducible.
    const orders = Array.from({ length: pairs }, (_, i) => i < pairs / 2);
    let counter = 0;
    const draw = limit => {
        const bound = Math.floor(0x100000000 / limit) * limit;
        for (;;) {
            const n = createHash('sha256').update(`${seed}:${counter++}`).digest().readUInt32BE();
            if (n < bound) return n % limit;
        }
    };
    for (let i = orders.length - 1; i > 0; i--) {
        const j = draw(i + 1);
        [orders[i], orders[j]] = [orders[j], orders[i]];
    }
    return orders.flatMap((ab, pair) => (ab ? ['baseline', 'candidate'] : ['candidate', 'baseline']).map((role, offset) => {
        const index = pair * 2 + offset;
        return { index, pair, role, variant: kind === 'control' ? 'baseline' : role,
            label: `${id}-${String(index + 1).padStart(4, '0')}-${role === 'baseline' ? 'a' : 'b'}` };
    }));
}

function validateIdentity(identity, variant, reasons) {
    check(reasons, record(identity), `${variant} identity is missing`);
    if (!record(identity)) return;
    for (const field of HASH_FIELDS) check(reasons, typeof identity[field] === 'string' && /^[a-f0-9]{64}$/.test(identity[field]),
        `${variant} identity.${field} is not a SHA-256 hash`);
    for (const field of ['browser', 'gpu']) check(reasons, typeof identity[field] === 'string' && identity[field].trim().length > 0,
        `${variant} identity.${field} is missing`);
    for (const field of ['width', 'height', 'deviceScaleFactor']) check(reasons, positive(identity.viewport?.[field]),
        `${variant} identity.viewport.${field} is invalid`);
    for (const field of ['dpr', 'width', 'height']) check(reasons, positive(identity.renderContext?.[field]),
        `${variant} identity.renderContext.${field} is invalid`);
    for (const field of ['antialias', 'shadows', 'terrainActive']) check(reasons, typeof identity.renderContext?.[field] === 'boolean',
        `${variant} identity.renderContext.${field} is invalid`);
    check(reasons, typeof identity.renderContext?.quality === 'string' && identity.renderContext.quality.trim().length > 0,
        `${variant} identity.renderContext.quality is missing`);
}

function validateRoutePolicy(policy) {
    if (policy?.type === 'distance-aligned-v1') return [];
    if (policy?.type !== 'native-walk-corridor-v1') return ['unknown movement route policy'];
    const reasons = [];
    check(reasons, Number.isFinite(policy.headingDeg), 'walk corridor heading is invalid');
    check(reasons, Number.isFinite(policy.lengthM) && policy.lengthM >= 12,
        'walk corridor length must be at least 12 metres');
    check(reasons, Number.isFinite(policy.origin?.lat) && Math.abs(policy.origin.lat) < 85
        && Number.isFinite(policy.origin?.lon) && Math.abs(policy.origin.lon) <= 180,
    'walk corridor origin is invalid');
    return reasons;
}

export function loadedRoutePolicyForScenario(scenario, movement) {
    if (scenario?.mode !== 'walk') return { type: 'distance-aligned-v1' };
    const start = movement?.route?.[0];
    const policy = { type: 'native-walk-corridor-v1', headingDeg: scenario.headingDeg ?? 0,
        lengthM: scenario.corridorM ?? 55, origin: { lat: start?.lat, lon: start?.lon } };
    const reasons = validateRoutePolicy(policy);
    if (reasons.length) throw new Error(`Invalid planned walk corridor: ${reasons.join('; ')}`);
    return policy;
}

export function validateLoadedComparisonPlan(plan) {
    const reasons = [];
    if (!record(plan)) return ['comparison plan is missing'];
    check(reasons, plan.schema === LOADED_PLAN_SCHEMA, 'unsupported comparison plan schema');
    check(reasons, typeof plan.id === 'string' && /^[a-z0-9][a-z0-9-]{0,95}$/.test(plan.id), 'plan id is not filename-safe');
    check(reasons, ['comparison', 'control'].includes(plan.kind), 'unknown comparison plan kind');
    const validPairs = Number.isInteger(plan.pairs) && plan.pairs >= (plan.kind === 'control' ? 2 : 8)
        && plan.pairs <= 128 && plan.pairs % 2 === 0;
    check(reasons, validPairs, 'use an even fixed pair count: 8–128 for comparison, 2–128 for control');
    check(reasons, typeof plan.seed === 'string' && /^[a-f0-9]{32}$/.test(plan.seed), 'plan seed must be 32 hexadecimal characters');
    check(reasons, Number.isFinite(timestamp(plan.createdAt)), 'plan creation time is invalid');
    check(reasons, positive(plan.maxPairGapMs) && plan.maxPairGapMs <= 300000, 'maxPairGapMs must be positive and at most 300000');
    check(reasons, typeof plan.distanceTolerance === 'number' && Number.isFinite(plan.distanceTolerance)
        && plan.distanceTolerance >= 0 && plan.distanceTolerance <= 0.05, 'distanceTolerance must be between 0 and 0.05');
    check(reasons, typeof plan.pathToleranceM === 'number' && Number.isFinite(plan.pathToleranceM)
        && plan.pathToleranceM >= 0 && plan.pathToleranceM <= 5, 'pathToleranceM must be between 0 and 5');
    reasons.push(...validateRoutePolicy(plan.routePolicy));
    check(reasons, plan.confidence === 0.95 && plan.regressionLimit === 0.10 && equal(plan.metrics, METRICS),
        'confidence, regression limit and primary metrics must use the fixed loaded profile');
    for (const variant of ['baseline', 'candidate']) validateIdentity(plan.identities?.[variant], variant, reasons);
    if (record(plan.identities?.baseline) && record(plan.identities?.candidate)) {
        const { baseline, candidate } = plan.identities;
        check(reasons, baseline.variant === 'baseline', 'baseline preflight must select baseline');
        check(reasons, candidate.variant === (plan.kind === 'control' ? 'baseline' : 'candidate'), 'candidate preflight selects the wrong physical variant');
        for (const field of COMMON_FIELDS) check(reasons, equal(baseline[field], candidate[field]), `planned identities differ in ${field}`);
        if (plan.kind === 'control') check(reasons, equal(baseline, candidate), 'control must use the identical baseline build and identity for both roles');
    }
    if (validPairs && typeof plan.seed === 'string') check(reasons, equal(plan.slots, makeSlots(plan)), 'slots do not match the predeclared balanced randomized order');
    try { check(reasons, plan.hash === loadedPlanHash(plan), 'comparison plan hash does not match its contents'); }
    catch { reasons.push('comparison plan cannot be hashed'); }
    return reasons;
}

export function createLoadedComparisonPlan({ id, kind = 'comparison', pairs = 12, seed = randomBytes(16).toString('hex'),
    identities, createdAt = new Date().toISOString(), maxPairGapMs = 300000, distanceTolerance = 0.05, pathToleranceM = 5,
    routePolicy = { type: 'distance-aligned-v1' } }) {
    const plan = { schema: LOADED_PLAN_SCHEMA, id, kind, pairs, seed, createdAt, identities,
        maxPairGapMs, distanceTolerance, pathToleranceM, routePolicy,
        confidence: 0.95, regressionLimit: 0.10, metrics: [...METRICS] };
    // Avoid allocating an unbounded schedule from malformed arguments.
    plan.slots = Number.isInteger(pairs) && pairs >= 2 && pairs <= 128 ? makeSlots(plan) : [];
    plan.hash = loadedPlanHash(plan);
    const reasons = validateLoadedComparisonPlan(plan);
    if (reasons.length) throw new Error(`Invalid loaded comparison plan: ${reasons.join('; ')}`);
    return plan;
}

const median = sorted => sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;

export function pairedRatioInterval(ratios, { confidence = 0.95, familySize = 4 } = {}) {
    if (!Array.isArray(ratios) || ratios.length < 2 || ratios.length > 128 || !ratios.every(positive)
        || !(confidence > 0 && confidence < 1) || !Number.isInteger(familySize) || familySize < 1) {
        throw new Error('Finite positive pair ratios and a valid confidence family are required');
    }
    const sorted = ratios.map(Math.log).sort((a, b) => a - b), n = sorted.length;
    const alpha = (1 - confidence) / familySize;
    let probability = 2 ** -n, tail = 0, k = 0, coverage = null;
    // The sign interval uses order statistics of independent pair differences.
    // Its unit is a whole pair, never the thousands of correlated frames in it.
    for (let j = 0; j < Math.floor(n / 2); j++) {
        tail += probability;
        if (2 * tail <= alpha) { k = j + 1; coverage = 1 - 2 * tail; }
        probability *= (n - j) / (j + 1);
    }
    const point = Math.exp(median(sorted));
    return { method: 'exact-binomial-sign-median-log-ratio', pairs: n, point,
        lower: k ? Math.exp(sorted[k - 1]) : null, upper: k ? Math.exp(sorted[n - k]) : null,
        bounded: k > 0, confidence, familySize, perMetricConfidence: 1 - alpha,
        guaranteedCoverage: coverage, orderStatistic: k || null,
        observedMin: Math.min(...ratios), observedMax: Math.max(...ratios),
        medianAbsoluteLogDeviation: median(sorted.map(value => Math.abs(value - median(sorted))).sort((a, b) => a - b)) };
}

function validRoute(phase) {
    const route = phase?.route;
    return Array.isArray(route) && route.length >= 2 && positive(phase.distanceM)
        && route.every((p, i) => record(p) && typeof p.distanceM === 'number' && Number.isFinite(p.distanceM)
            && p.distanceM >= 0 && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90
            && Number.isFinite(p.lon) && Math.abs(p.lon) <= 180
            && (i === 0 ? p.distanceM === 0 : p.distanceM > route[i - 1].distanceM))
        && Math.abs(route.at(-1).distanceM - phase.distanceM) < 0.001;
}
const metresBetween = (a, b) => Math.hypot((a.lat - b.lat) * 111320,
    (a.lon - b.lon) * 111320 * Math.cos((a.lat + b.lat) * Math.PI / 360));
function pointAt(route, distanceM) {
    if (distanceM <= route[0].distanceM) return route[0];
    if (distanceM >= route.at(-1).distanceM) return route.at(-1);
    let low = 1, high = route.length - 1;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (route[middle].distanceM < distanceM) low = middle + 1;
        else high = middle;
    }
    const index = low;
    const a = route[index - 1], b = route[index], fraction = (distanceM - a.distanceM) / (b.distanceM - a.distanceM);
    return { lat: a.lat + (b.lat - a.lat) * fraction, lon: a.lon + (b.lon - a.lon) * fraction };
}

function inspectWalkCorridor(phase, policy, pathToleranceM) {
    const theta = policy.headingDeg * Math.PI / 180;
    const longitudeScale = 111320 * Math.cos(policy.origin.lat * Math.PI / 180);
    let maxDeviationM = 0, endWitnesses = 0, towardsEnd = true;
    for (const point of phase.route) {
        const north = (point.lat - policy.origin.lat) * 111320;
        const east = (point.lon - policy.origin.lon) * longitudeScale;
        const along = north * Math.cos(theta) + east * Math.sin(theta);
        const across = east * Math.cos(theta) - north * Math.sin(theta);
        maxDeviationM = Math.max(maxDeviationM, Math.hypot(across,
            along < 0 ? along : Math.max(0, along - policy.lengthM)));
        // The observer records at two-metre intervals. A recorded point can
        // precede a reversal by that distance; the native return threshold is 2m.
        if (towardsEnd ? along >= policy.lengthM - 2 : along <= 4) {
            endWitnesses++; towardsEnd = !towardsEnd;
        }
    }
    const startDeviationM = metresBetween(phase.route[0], policy.origin);
    const validTurns = Number.isSafeInteger(phase.turns) && phase.turns >= 2
        && endWitnesses >= 2 && Math.abs(endWitnesses - phase.turns) <= 1;
    return { matched: startDeviationM <= pathToleranceM && maxDeviationM <= pathToleranceM && validTurns,
        startDeviationM, maxDeviationM, turns: phase.turns, endWitnesses };
}

export function compareLoadedRoutes(a, b, { distanceTolerance = 0.05, pathToleranceM = 5,
    routePolicy = { type: 'distance-aligned-v1' } } = {}) {
    if (!validRoute(a) || !validRoute(b)) return { matched: false, reason: 'movement route evidence is missing or invalid' };
    if (validateRoutePolicy(routePolicy).length) return { matched: false, reason: 'movement route policy is invalid' };
    const distanceDifference = Math.abs(a.distanceM - b.distanceM) / Math.min(a.distanceM, b.distanceM);
    const sharedDistanceM = Math.min(a.distanceM, b.distanceM);
    if (routePolicy.type === 'native-walk-corridor-v1') {
        // Frame-sized overshoots shift the cycle phase after many native turns.
        // Match each walk to its declared corridor and compare distance/turn work,
        // instead of aligning positions at the same cumulative travel distance.
        const corridors = [a, b].map(phase => inspectWalkCorridor(phase, routePolicy, pathToleranceM));
        const turnDifference = Math.abs(a.turns - b.turns) / Math.min(a.turns, b.turns);
        const maxDeviationM = Math.max(...corridors.map(corridor => corridor.maxDeviationM));
        const matched = corridors.every(corridor => corridor.matched)
            && distanceDifference <= distanceTolerance && turnDifference <= distanceTolerance;
        return { matched, method: routePolicy.type, distanceDifference, turnDifference, maxDeviationM,
            sharedDistanceM, corridors,
            reason: matched ? null : 'walk corridor geometry, distance or witnessed turns differ beyond the planned tolerance' };
    }
    // Compare every observed waypoint at the same absolute travelled distance,
    // including turns. Normalizing each run's progress could hide a short route.
    const distances = [...new Set([0, sharedDistanceM, ...a.route.map(p => p.distanceM), ...b.route.map(p => p.distanceM)])]
        .filter(d => d <= sharedDistanceM).sort((x, y) => x - y);
    const maxDeviationM = distances.reduce((peak, d) => Math.max(peak,
        metresBetween(pointAt(a.route, d), pointAt(b.route, d))), 0);
    const matched = distanceDifference <= distanceTolerance && maxDeviationM <= pathToleranceM;
    return { matched, method: routePolicy.type, distanceDifference, maxDeviationM, sharedDistanceM,
        reason: matched ? null : 'movement distance or path differs beyond the planned tolerance' };
}

export function compareLoadedPerfRuns(plan, runs) {
    const reasons = validateLoadedComparisonPlan(plan);
    if (reasons.length) return { comparable: false, accepted: false, decision: 'invalid', reasons, runs: [], comparison: null };
    const input = Array.isArray(runs) ? runs : [];
    check(reasons, Array.isArray(runs) && input.length === plan.slots.length, 'all planned slots are required; no filtering or replacement runs');
    const statuses = [];
    let previousEnd = null, referenceCapacity = null, referenceHost = null;
    for (const slot of plan.slots) {
        const run = input[slot.index], errors = [];
        const verdict = evaluatePerfAcceptanceRun(run, { hostMode: 'loaded' });
        errors.push(...verdict.reasons);
        check(errors, verdict.accepted, 'run is not a completed measurement');
        check(errors, run?.measurementProfile === 'loaded' && run?.experiment?.planHash === plan.hash
            && run?.experiment?.slot === slot.index, 'run was not captured for this loaded plan slot');
        check(errors, run?.label === slot.label && run?.identity?.variant === slot.variant, 'label or physical variant differs from the planned slot');
        const walk = plan.routePolicy.type === 'native-walk-corridor-v1';
        check(errors, (run?.scenario?.mode === 'walk') === walk, 'run movement mode differs from the planned route policy');
        if (walk) check(errors, (run?.scenario?.headingDeg ?? 0) === plan.routePolicy.headingDeg
            && (run?.scenario?.corridorM ?? 55) === plan.routePolicy.lengthM,
        'run walk corridor differs from the planned route policy');
        for (const field of [...COMMON_FIELDS, 'engineHash']) check(errors,
            equal(run?.identity?.[field], plan.identities[slot.variant]?.[field]), `run identity.${field} differs from the plan`);
        const start = timestamp(run?.startedAt), end = timestamp(run?.finishedAt);
        check(errors, Number.isFinite(start) && Number.isFinite(end) && end > start, 'run timestamps are invalid');
        check(errors, start >= timestamp(plan.createdAt), 'run predates the comparison plan');
        if (previousEnd !== null) {
            check(errors, start >= previousEnd, 'run overlaps or is out of planned chronological order');
            if (slot.index % 2 === 1) check(errors, start - previousEnd <= plan.maxPairGapMs, 'gap within the pair exceeds the planned limit');
        }
        previousEnd = Number.isFinite(end) ? end : null;
        for (const phase of PHASES) {
            const host = run?.phases?.[phase]?.host;
            check(errors, ['darwin', 'linux'].includes(host?.platform) && Number.isInteger(host?.cpus) && host.cpus > 0,
                `${phase} native platform or CPU count is missing`);
            if (referenceHost === null && host) referenceHost = { platform: host.platform, cpus: host.cpus };
            if (referenceHost) check(errors, host?.platform === referenceHost.platform && host?.cpus === referenceHost.cpus,
                `${phase} native platform or CPU count changed`);
            if (host?.platform === 'linux' || host?.effectiveCpuCapacity !== undefined) {
                check(errors, host.platform === 'linux' && positive(host.effectiveCpuCapacity), `${phase} Linux CPU capacity is missing or invalid`);
                if (referenceCapacity === null && positive(host.effectiveCpuCapacity)) referenceCapacity = host.effectiveCpuCapacity;
                check(errors, host.effectiveCpuCapacity === referenceCapacity, `${phase} effective Linux CPU capacity changed`);
            }
        }
        statuses.push({ index: slot.index, label: slot.label, role: slot.role, variant: slot.variant, accepted: errors.length === 0, reasons: errors });
        if (errors.length) reasons.push(`slot ${slot.index} is invalid: ${errors.join('; ')}`);
    }
    const pairs = [];
    if (!reasons.length) {
        for (let pair = 0; pair < plan.pairs; pair++) {
            const slots = plan.slots.slice(pair * 2, pair * 2 + 2);
            const a = input[slots.find(s => s.role === 'baseline').index];
            const b = input[slots.find(s => s.role === 'candidate').index];
            for (const phase of PHASES) check(reasons, a.phases[phase].requestedMs === b.phases[phase].requestedMs
                && a.phases[phase].requestedMs === input[0].phases[phase].requestedMs, `pair ${pair} ${phase} requested workloads differ`);
            check(reasons, equal(a.required, b.required) && equal(a.required, input[0].required), `pair ${pair} required workloads differ`);
            const route = compareLoadedRoutes(a.phases.movement, b.phases.movement, plan);
            check(reasons, route.matched, `pair ${pair}: ${route.reason}`);
            const referenceRoute = compareLoadedRoutes(input[0].phases.movement, a.phases.movement, plan);
            check(reasons, referenceRoute.matched, `pair ${pair}: route differs from the series reference`);
            const ratios = {};
            for (const metric of METRICS) {
                const [phase, field] = metric.split('.');
                const baseline = a.phases[phase].frames[field], candidate = b.phases[phase].frames[field];
                const ratio = candidate / baseline;
                check(reasons, positive(baseline) && positive(candidate) && positive(ratio), `pair ${pair} ${metric} has an invalid ratio`);
                ratios[metric] = { baseline, candidate, ratio };
            }
            pairs.push({ pair, order: slots.map(s => s.role), route, ratios });
        }
    }
    if (reasons.length) return { comparable: false, accepted: false, decision: 'invalid', reasons, runs: statuses, comparison: null, pairs };
    const metrics = Object.fromEntries(METRICS.map(metric => {
        const interval = pairedRatioInterval(pairs.map(p => p.ratios[metric].ratio));
        const decision = !interval.bounded ? 'inconclusive' : interval.upper < 1 ? 'improved'
            : interval.upper <= 1 + plan.regressionLimit ? 'within-budget'
                : interval.lower > 1 + plan.regressionLimit ? 'regressed' : 'inconclusive';
        return [metric, { ...interval, decision }];
    }));
    const longTasks = Object.fromEntries(PHASES.map(phase => {
        const counts = role => plan.slots.filter(s => s.role === role).map(s => input[s.index].phases[phase].longTasks.over50);
        const baselineOver50 = counts('baseline'), candidateOver50 = counts('candidate');
        return [phase, { baselineOver50, candidateOver50,
            recurringNew: baselineOver50.every(n => n === 0) && candidateOver50.every(n => n >= 2),
            scope: 'aggregate counts only; task function identity is not measured' }];
    }));
    let decision;
    if (plan.kind === 'control') {
        decision = Object.values(metrics).some(m => m.bounded && (m.upper < 1 || m.lower > 1)) ? 'control-bias'
            : Object.values(metrics).every(m => m.bounded) ? 'control-consistent' : 'control-descriptive';
    } else {
        decision = Object.values(metrics).some(m => m.decision === 'regressed') || Object.values(longTasks).some(p => p.recurringNew)
            ? 'regressed' : Object.values(metrics).some(m => m.decision === 'inconclusive') ? 'inconclusive' : 'within-budget';
    }
    if (decision === 'inconclusive') reasons.push('the fixed series does not resolve the 10% frame-time regression boundary');
    if (decision === 'regressed') reasons.push('frame-time regression or recurring new long tasks exceeded the comparison gate');
    if (decision === 'control-bias') reasons.push('identical-build roles show a systematic difference; investigate ordering or workload effects');
    return { comparable: true, accepted: plan.kind === 'comparison' && decision === 'within-budget', decision, reasons,
        scope: 'relative frame times under the observed load; support, appearance and selection still require their own checks',
        assumptions: 'whole-pair log ratios must be independent and representative; no correction by total CPU load or paging',
        runs: statuses, pairs, comparison: { confidence: plan.confidence, familySize: METRICS.length,
            regressionLimit: plan.regressionLimit, metrics, longTasks,
            improvedMetrics: Object.entries(metrics).filter(([, m]) => m.decision === 'improved').map(([name]) => name) } };
}
