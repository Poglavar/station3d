// Pure acceptance rules for sealed Station3D performance runs and ABBA comparisons.

const HASH_FIELDS = ['scenarioHash', 'sourceHash', 'hostHash', 'observerHash', 'engineHash'];
const VARIANTS = ['baseline', 'candidate'];
const PHASES = ['stationary', 'movement'];
const HASH_RE = /^[a-f0-9]{64}$/i;
const finiteNonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const finitePositive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function emptyBlockers(value) {
    if (value === null) return true;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value !== 'string') return false;
    const text = value.trim();
    if (!text) return true;
    if (text !== '[]') return false;
    return true;
}

function add(reasons, condition, message) {
    if (!condition) reasons.push(message);
}

function validatePaintBindings(observation, label, reasons) {
    const binding = observation?.paintBindings;
    add(reasons, isRecord(binding), `${label}.paintBindings evidence is missing`);
    if (!isRecord(binding)) return;
    add(reasons, binding.available === true, `${label}.paintBindings is unavailable`);
    add(reasons, Number.isSafeInteger(binding.compiledMaterials) && binding.compiledMaterials >= 1,
        `${label}.paintBindings.compiledMaterials must be a safe integer of at least 1`);
    add(reasons, Array.isArray(binding.mismatches), `${label}.paintBindings.mismatches must be an array`);
    if (Array.isArray(binding.mismatches)) add(reasons, binding.mismatches.length === 0, `${label}.paintBindings has stale uniform mismatches`);
}

function validateCommon(run) {
    const reasons = [];
    add(reasons, isRecord(run), 'run must be an object');
    if (!isRecord(run)) return reasons;

    add(reasons, ['record', 'preflight', 'measure'].includes(run.stage), 'stage must be record, preflight, or measure');
    add(reasons, run.complete === true, 'run is incomplete');
    add(reasons, ['walk', 'rail'].includes(run.scenario?.mode), 'scenario mode must be walk or rail');
    const identity = run.identity;
    add(reasons, isRecord(identity), 'identity is missing');
    if (isRecord(identity)) {
        for (const field of HASH_FIELDS) add(reasons, typeof identity[field] === 'string' && HASH_RE.test(identity[field]), `identity.${field} must be a 64-character hexadecimal hash`);
        add(reasons, VARIANTS.includes(identity.variant), 'identity.variant must be baseline or candidate');
        if (run.stage === 'measure') {
            for (const field of ['browser', 'gpu']) add(reasons, typeof identity[field] === 'string' && identity[field].trim().length > 0, `identity.${field} is missing`);
        }
        const viewport = identity.viewport;
        add(reasons, isRecord(viewport), 'identity.viewport is missing');
        if (isRecord(viewport)) {
            for (const field of ['width', 'height', 'deviceScaleFactor']) add(reasons, finitePositive(viewport[field]), `identity.viewport.${field} must be a finite positive number`);
        }
        validateRenderContext(identity.renderContext, reasons);
    }

    add(reasons, Array.isArray(run.errors), 'errors must be an array');
    if (Array.isArray(run.errors)) add(reasons, run.errors.length === 0, 'run contains errors');

    add(reasons, isRecord(run.files), 'final file fingerprint result is missing');
    if (isRecord(run.files)) add(reasons, run.files.changed === false, 'host or engine files changed during the run');

    const sources = run.sources;
    add(reasons, isRecord(sources), 'sources are missing');
    if (isRecord(sources)) {
        add(reasons, sources.sealed === true, 'source set is not sealed');
        for (const field of ['missing', 'unexpectedResponses']) {
            add(reasons, Array.isArray(sources[field]), `sources.${field} must be an array`);
            if (Array.isArray(sources[field])) add(reasons, sources[field].length === 0, `sources.${field} is not empty`);
        }
        add(reasons, sources.changed === false, 'source set changed during the run');
    }

    const ready = run.ready;
    add(reasons, isRecord(ready), 'readiness result is missing');
    if (isRecord(ready)) {
        add(reasons, ready.reason === 'ready', 'world readiness reason is not ready');
        add(reasons, emptyBlockers(ready.blockers), 'world readiness has blockers');
    }

    for (const field of ['initialDrain', 'finalDrain']) {
        add(reasons, isRecord(run[field]), `${field} result is missing`);
        if (isRecord(run[field])) {
            add(reasons, run[field].state === 'drained', `${field} is not drained`);
            validatePaintBindings(run[field], field, reasons);
        }
    }

    const lifecycle = run.lifecycle;
    add(reasons, isRecord(lifecycle), 'lifecycle result is missing');
    if (isRecord(lifecycle)) {
        add(reasons, Array.isArray(lifecycle.errors), 'lifecycle.errors must be an array');
        if (Array.isArray(lifecycle.errors)) add(reasons, lifecycle.errors.length === 0, 'lifecycle contains errors');
        add(reasons, Array.isArray(lifecycle.observations), 'lifecycle.observations must be an array');
        if (Array.isArray(lifecycle.observations)) {
            add(reasons, Number.isSafeInteger(lifecycle.cycles) && lifecycle.observations.length === lifecycle.cycles,
                'lifecycle observation count does not match completed cycles');
            for (let i = 0; i < lifecycle.observations.length; i++) {
                const observation = lifecycle.observations[i];
                add(reasons, isRecord(observation) && observation.state === 'drained', `lifecycle observation ${i} is not drained`);
                add(reasons, observation?.snapshot?.reason === 'ready', `lifecycle observation ${i} is not ready`);
                add(reasons, observation?.snapshot?.drainState === 'drained', `lifecycle observation ${i} snapshot is not drained`);
                validatePaintBindings(observation, `lifecycle observation ${i}`, reasons);
            }
        }
    }

    const required = run.required;
    add(reasons, isRecord(required), 'required thresholds are missing');
    if (isRecord(required)) {
        add(reasons, finitePositive(required.stationaryMs), 'required.stationaryMs must be finite and positive');
        add(reasons, finitePositive(required.movementMs), 'required.movementMs must be finite and positive');
        add(reasons, finitePositive(required.minDistanceM), 'required.minDistanceM must be finite and positive');
        add(reasons, Number.isSafeInteger(required.lifecycleCycles) && required.lifecycleCycles >= 1, 'required.lifecycleCycles must be a positive integer');
    }
    return reasons;
}

function validateRenderContext(context, reasons) {
    add(reasons, isRecord(context), 'identity.renderContext is missing');
    if (!isRecord(context)) return;
    for (const field of ['dpr', 'width', 'height']) add(reasons, finitePositive(context[field]), `identity.renderContext.${field} must be a finite positive number`);
    for (const field of ['antialias', 'shadows', 'terrainActive']) add(reasons, typeof context[field] === 'boolean', `identity.renderContext.${field} must be boolean`);
    add(reasons, typeof context.quality === 'string' && context.quality.trim().length > 0, 'identity.renderContext.quality must be a nonempty string');
}

function validateMotionAndVisibility(run, reasons) {
    const phases = run.phases;
    add(reasons, isRecord(phases), 'phases are missing');
    if (!isRecord(phases)) return;
    for (const phase of PHASES) {
        const row = phases[phase];
        add(reasons, isRecord(row), `${phase} phase is missing`);
        if (isRecord(row)) {
            add(reasons, row.visible === true, `${phase} phase was not visible`);
            add(reasons, row.renderContextStable === true, `${phase} render context changed or was not observed`);
        }
    }
    const movement = phases.movement;
    const required = run.required;
    if (isRecord(movement)) {
        if (run.scenario?.mode === 'walk') {
            add(reasons, Number.isSafeInteger(required?.walkTurns) && required.walkTurns >= 2, 'walk requires at least two corridor turns');
            add(reasons, Number.isSafeInteger(movement.turns) && movement.turns >= required?.walkTurns, 'walk corridor turn count is below the required threshold');
        }
        add(reasons, finiteNonnegative(movement.distanceM), 'movement.distanceM must be finite and nonnegative');
        if (isRecord(required) && finiteNonnegative(required.minDistanceM) && finiteNonnegative(movement.distanceM)) {
            add(reasons, movement.distanceM >= required.minDistanceM, `movement distance ${movement.distanceM}m is below ${required.minDistanceM}m`);
        }
    }
    const lifecycle = run.lifecycle;
    if (isRecord(lifecycle) && isRecord(required)) {
        add(reasons, Number.isSafeInteger(lifecycle.cycles) && lifecycle.cycles >= required.lifecycleCycles, 'lifecycle cycle count is below the required threshold');
    }
}

function validateTimingPhase(row, phase, requiredMs, reasons, { checkHost = true } = {}) {
    if (!isRecord(row)) return;
    add(reasons, finitePositive(row.requestedMs), `${phase}.requestedMs must be finite and positive`);
    add(reasons, finiteNonnegative(row.durationMs), `${phase}.durationMs must be finite and nonnegative`);
    if (finitePositive(requiredMs) && finitePositive(row.requestedMs)) {
        add(reasons, row.requestedMs >= requiredMs, `${phase} requested duration is below ${requiredMs}ms`);
    }
    if (finitePositive(row.requestedMs) && finiteNonnegative(row.durationMs)) {
        add(reasons, row.durationMs >= row.requestedMs, `${phase} observed duration is shorter than requested`);
        add(reasons, row.durationMs <= row.requestedMs * 1.05 + 250, `${phase} observed duration exceeds the allowed overrun`);
    }

    const frames = row.frames;
    add(reasons, isRecord(frames), `${phase}.frames are missing`);
    if (isRecord(frames)) {
        add(reasons, Number.isSafeInteger(frames.n) && frames.n >= 2, `${phase}.frames.n must be a safe integer of at least 2`);
        for (const field of ['p50Ms', 'p95Ms', 'p99Ms', 'maxMs']) add(reasons, finiteNonnegative(frames[field]), `${phase}.frames.${field} must be finite and nonnegative`);
        for (const field of ['over50', 'over100', 'over250']) {
            add(reasons, Number.isSafeInteger(frames[field]) && frames[field] >= 0, `${phase}.frames.${field} must be a nonnegative safe integer`);
            if (Number.isSafeInteger(frames.n) && Number.isSafeInteger(frames[field])) add(reasons, frames[field] <= frames.n, `${phase}.frames.${field} exceeds the frame count`);
        }
        if (Number.isSafeInteger(frames.over50) && Number.isSafeInteger(frames.over100)) add(reasons, frames.over100 <= frames.over50, `${phase} hitch counts are out of order`);
        if (Number.isSafeInteger(frames.over100) && Number.isSafeInteger(frames.over250)) add(reasons, frames.over250 <= frames.over100, `${phase} hitch counts are out of order`);
        if (finiteNonnegative(frames.p50Ms) && finiteNonnegative(frames.p95Ms)) add(reasons, frames.p50Ms <= frames.p95Ms, `${phase} frame percentiles are out of order`);
        if (finiteNonnegative(frames.p95Ms) && finiteNonnegative(frames.p99Ms)) add(reasons, frames.p95Ms <= frames.p99Ms, `${phase} frame percentiles are out of order`);
        if (finiteNonnegative(frames.p99Ms) && finiteNonnegative(frames.maxMs)) add(reasons, frames.p99Ms <= frames.maxMs, `${phase} frame maximum is below p99`);
    }

    const observation = row.observation;
    add(reasons, isRecord(observation), `${phase}.observation is missing`);
    if (isRecord(observation)) {
        add(reasons, Number.isSafeInteger(observation.rawFrames) && observation.rawFrames >= 0, `${phase}.observation.rawFrames must be a nonnegative safe integer`);
        add(reasons, Number.isSafeInteger(observation.invalidFrames) && observation.invalidFrames >= 0, `${phase}.observation.invalidFrames must be a nonnegative safe integer`);
        add(reasons, finiteNonnegative(observation.coveredMs), `${phase}.observation.coveredMs must be finite and nonnegative`);
        if (Number.isSafeInteger(observation.invalidFrames)) add(reasons, observation.invalidFrames === 0, `${phase} contains invalid frame observations`);
        if (Number.isSafeInteger(observation.rawFrames) && Number.isSafeInteger(observation.invalidFrames) && Number.isSafeInteger(frames?.n)) {
            add(reasons, observation.rawFrames - observation.invalidFrames === frames.n, `${phase} raw and summarized frame counts do not match`);
        }
        if (finiteNonnegative(row.durationMs) && finiteNonnegative(observation.coveredMs)) {
            add(reasons, observation.coveredMs >= row.durationMs * 0.98, `${phase} frame observations cover less than 98% of the phase`);
        }
    }
    if (Number.isSafeInteger(frames?.n) && finiteNonnegative(row.durationMs)) {
        add(reasons, frames.n >= row.durationMs / 1000, `${phase} has fewer than one frame interval per second`);
    }

    const longTasks = row.longTasks;
    add(reasons, isRecord(longTasks), `${phase}.longTasks is missing`);
    if (isRecord(longTasks)) {
        add(reasons, Number.isSafeInteger(longTasks.count) && longTasks.count >= 0, `${phase}.longTasks.count must be a nonnegative safe integer`);
        for (const field of ['over50', 'over100', 'over250']) {
            add(reasons, Number.isSafeInteger(longTasks[field]) && longTasks[field] >= 0, `${phase}.longTasks.${field} must be a nonnegative safe integer`);
            if (Number.isSafeInteger(longTasks.count) && Number.isSafeInteger(longTasks[field])) {
                add(reasons, longTasks[field] <= longTasks.count, `${phase}.longTasks.${field} exceeds the count`);
            }
        }
        if (Number.isSafeInteger(longTasks.over50) && Number.isSafeInteger(longTasks.over100)) add(reasons, longTasks.over100 <= longTasks.over50, `${phase} long-task counts are out of order`);
        if (Number.isSafeInteger(longTasks.over100) && Number.isSafeInteger(longTasks.over250)) add(reasons, longTasks.over250 <= longTasks.over100, `${phase} long-task counts are out of order`);
        add(reasons, finiteNonnegative(longTasks.maxMs), `${phase}.longTasks.maxMs must be finite and nonnegative`);
        add(reasons, finiteNonnegative(longTasks.totalMs), `${phase}.longTasks.totalMs must be finite and nonnegative`);
        if (Number.isSafeInteger(longTasks.count) && longTasks.count === 0 && finiteNonnegative(longTasks.maxMs)) {
            add(reasons, longTasks.maxMs === 0, `${phase}.longTasks.maxMs must be zero when there are no tasks`);
        }
    }

    if (checkHost) {
        add(reasons, isRecord(row.host), `${phase}.host result is missing`);
        if (isRecord(row.host)) {
            add(reasons, row.host.clean === true, `${phase} host window is not clean`);
            add(reasons, Array.isArray(row.host.reasons), `${phase}.host.reasons must be an array`);
            if (Array.isArray(row.host.reasons)) add(reasons, row.host.reasons.length === 0, `${phase} host window has failure reasons`);
        }
    }
}

export function evaluatePerfAcceptanceRun(run) {
    const reasons = validateCommon(run);
    if (!isRecord(run)) return { accepted: false, readyForTiming: false, reasons };

    if (run.stage === 'preflight' || run.stage === 'measure') {
        validateMotionAndVisibility(run, reasons);
        const phases = run.phases;
        const required = run.required;
        if (isRecord(phases)) {
            for (const phase of PHASES) {
                const row = phases[phase];
                validateTimingPhase(row, phase, isRecord(required) ? required[phase === 'stationary' ? 'stationaryMs' : 'movementMs'] : null, reasons,
                    { checkHost: run.stage === 'measure' });
            }
        }
        if (isRecord(phases?.movement)) {
            const row = phases.movement;
            add(reasons, finitePositive(row.requestedMs) && row.requestedMs >= 180000, 'movement requested duration must be at least 180000ms');
            add(reasons, finiteNonnegative(row.durationMs) && row.durationMs >= 180000, 'movement observed duration must be at least 180000ms');
        }
    }

    const accepted = run.stage === 'measure' && reasons.length === 0;
    return { accepted, readyForTiming: run.stage === 'preflight' && reasons.length === 0, reasons };
}

export function comparePerfAcceptanceRuns(runs) {
    const input = Array.isArray(runs) ? runs : [];
    const statuses = input.map((run, index) => {
        const result = evaluatePerfAcceptanceRun(run);
        return { index, variant: run?.identity?.variant ?? null, accepted: result.accepted, reasons: result.reasons };
    });
    const reasons = [];
    const mismatches = [];
    if (!Array.isArray(runs)) reasons.push('runs must be an array');
    if (input.length !== 4) reasons.push('comparison requires exactly four runs');
    const expected = ['baseline', 'candidate', 'candidate', 'baseline'];
    if (input.length === 4) {
        for (let i = 0; i < 4; i++) {
            if (input[i]?.identity?.variant !== expected[i]) {
                const mismatch = { field: `runs[${i}].identity.variant`, expected: expected[i], actual: input[i]?.identity?.variant ?? null };
                mismatches.push(mismatch); reasons.push(`${mismatch.field} must be ${expected[i]}`);
            }
        }
        let previousFinishedAt = null;
        for (let i = 0; i < input.length; i++) {
            const run = input[i];
            const startedAt = typeof run?.startedAt === 'string' ? Date.parse(run.startedAt) : NaN;
            const finishedAt = typeof run?.finishedAt === 'string' ? Date.parse(run.finishedAt) : NaN;
            if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) {
                const mismatch = { field: `runs[${i}].timestamps`, startedAt: run?.startedAt ?? null, finishedAt: run?.finishedAt ?? null };
                mismatches.push(mismatch); reasons.push(`run ${i} needs parseable startedAt and finishedAt timestamps`);
                previousFinishedAt = Number.isFinite(finishedAt) ? finishedAt : null;
                continue;
            }
            if (finishedAt <= startedAt) {
                const mismatch = { field: `runs[${i}].duration`, startedAt: run.startedAt, finishedAt: run.finishedAt };
                mismatches.push(mismatch); reasons.push(`run ${i} duration must be positive`);
            }
            if (previousFinishedAt !== null) {
                const gapMs = startedAt - previousFinishedAt;
                if (gapMs < 0) {
                    const mismatch = { field: `runs[${i}].startedAt`, previousFinishedAt: input[i - 1]?.finishedAt ?? null,
                        startedAt: run.startedAt, overlapMs: -gapMs };
                    mismatches.push(mismatch); reasons.push(`run ${i} overlaps or is out of chronological order`);
                } else if (gapMs > 300000) {
                    const mismatch = { field: `runs[${i}].gap`, previousFinishedAt: input[i - 1]?.finishedAt ?? null,
                        startedAt: run.startedAt, gapMs };
                    mismatches.push(mismatch); reasons.push(`gap before run ${i} exceeds 300000ms`);
                }
            }
            previousFinishedAt = finishedAt;
        }
    }
    for (const status of statuses) if (!status.accepted) reasons.push(`run ${status.index} is not accepted`);

    if (input.length === 4 && input.every(isRecord)) {
        const identity = input[0]?.identity;
        const commonFields = ['scenarioHash', 'sourceHash', 'hostHash', 'observerHash', 'browser', 'gpu'];
        const viewportFields = ['width', 'height', 'deviceScaleFactor'];
        const renderContextFields = ['dpr', 'width', 'height', 'antialias', 'shadows', 'quality', 'terrainActive'];
        for (let i = 1; i < 4; i++) {
            const other = input[i]?.identity;
            if (!isRecord(identity) || !isRecord(other)) continue;
            for (const field of commonFields) {
                if (identity[field] !== other[field]) {
                    const mismatch = { field: `identity.${field}`, runs: [0, i], values: [identity[field] ?? null, other[field] ?? null] };
                    mismatches.push(mismatch); reasons.push(`runs 0 and ${i} have different identity.${field}`);
                }
            }
            for (const field of viewportFields) {
                if (identity.viewport?.[field] !== other.viewport?.[field]) {
                    const mismatch = { field: `identity.viewport.${field}`, runs: [0, i], values: [identity.viewport?.[field] ?? null, other.viewport?.[field] ?? null] };
                    mismatches.push(mismatch); reasons.push(`runs 0 and ${i} have different identity.viewport.${field}`);
                }
            }
            for (const field of renderContextFields) {
                if (identity.renderContext?.[field] !== other.renderContext?.[field]) {
                    const mismatch = { field: `identity.renderContext.${field}`, runs: [0, i], values: [identity.renderContext?.[field] ?? null, other.renderContext?.[field] ?? null] };
                    mismatches.push(mismatch); reasons.push(`runs 0 and ${i} have different identity.renderContext.${field}`);
                }
            }
        }
        for (const variant of VARIANTS) {
            const group = input.filter(run => run?.identity?.variant === variant);
            const hashes = [...new Set(group.map(run => run?.identity?.engineHash))];
            if (hashes.length > 1) {
                const mismatch = { field: `identity.engineHash.${variant}`, values: hashes };
                mismatches.push(mismatch); reasons.push(`${variant} runs use different engine hashes`);
            }
        }
    }
    const comparable = reasons.length === 0;
    let comparison = null;
    if (comparable) {
        const phaseResults = {};
        for (const phase of PHASES) {
            const baselineRuns = [input[0], input[3]];
            const candidateRuns = [input[1], input[2]];
            const frameTimes = {};
            for (const metric of ['p50Ms', 'p95Ms']) {
                const baseline = baselineRuns.reduce((sum, run) => sum + run.phases[phase].frames[metric], 0) / 2;
                const candidate = candidateRuns.reduce((sum, run) => sum + run.phases[phase].frames[metric], 0) / 2;
                const regression = baseline === 0 ? (candidate > 0 ? null : 0) : candidate / baseline - 1;
                frameTimes[metric] = { baseline, candidate, regression };
            }
            const p50Regressed = frameTimes.p50Ms.baseline === 0
                ? frameTimes.p50Ms.candidate > 0 : frameTimes.p50Ms.regression > 0.10;
            const p95Regressed = frameTimes.p95Ms.baseline === 0
                ? frameTimes.p95Ms.candidate > 0 : frameTimes.p95Ms.regression > 0.10;
            const frameRegression = p50Regressed || p95Regressed;
            if (frameRegression) reasons.push(`${phase} p50 or p95 frame time regressed by more than 10%`);

            const baselineOver50 = baselineRuns.map(run => run.phases[phase].longTasks.over50);
            const candidateOver50 = candidateRuns.map(run => run.phases[phase].longTasks.over50);
            const recurringNewLongTasks = baselineOver50.every(count => count === 0)
                && candidateOver50.every(count => count >= 2);
            if (recurringNewLongTasks) reasons.push(`${phase} has new recurring >50ms long tasks in both candidate runs`);
            phaseResults[phase] = { frameTimes,
                longTasks: { baselineOver50, candidateOver50,
                    gate: 'aggregate >50ms task counts only; task function and item identity are not measured', recurringNew: recurringNewLongTasks } };
        }
        comparison = { phases: phaseResults, regressionLimit: 0.10 };
    }
    const accepted = comparable && reasons.length === 0;
    return { comparable, accepted, reasons, mismatches, runs: statuses, comparison };
}

export function assertComparablePreflight(preflight, identity) {
    const reasons = [];
    const verdict = evaluatePerfAcceptanceRun(preflight);
    add(reasons, verdict.readyForTiming, 'preflight is not ready for timing');
    add(reasons, isRecord(identity), 'expected identity is missing');
    const actual = preflight?.identity;
    add(reasons, isRecord(actual), 'preflight identity is missing');
    if (!isRecord(identity) || !isRecord(actual)) return reasons;

    for (const field of HASH_FIELDS) {
        add(reasons, typeof identity[field] === 'string' && HASH_RE.test(identity[field]), `expected identity.${field} must be a 64-character hexadecimal hash`);
        add(reasons, actual[field] === identity[field], `preflight identity.${field} does not match the planned run`);
    }
    add(reasons, actual.variant === identity.variant, 'preflight variant does not match the planned run');
    const viewportFields = ['width', 'height', 'deviceScaleFactor'];
    add(reasons, isRecord(identity.viewport), 'expected identity.viewport is missing');
    add(reasons, isRecord(actual.viewport), 'preflight identity.viewport is missing');
    if (isRecord(identity.viewport) && isRecord(actual.viewport)) {
        for (const field of viewportFields) {
            add(reasons, finitePositive(identity.viewport[field]), `expected identity.viewport.${field} must be a finite positive number`);
            add(reasons, actual.viewport[field] === identity.viewport[field], `preflight identity.viewport.${field} does not match the planned run`);
        }
    }
    const renderContextFields = ['dpr', 'width', 'height', 'antialias', 'shadows', 'quality', 'terrainActive'];
    validateRenderContext(identity.renderContext, reasons);
    if (isRecord(actual.renderContext) && isRecord(identity.renderContext)) {
        for (const field of renderContextFields) add(reasons, actual.renderContext[field] === identity.renderContext[field], `preflight identity.renderContext.${field} does not match the planned run`);
    } else {
        add(reasons, isRecord(actual.renderContext), 'preflight identity.renderContext is missing');
    }
    for (const field of ['browser', 'gpu']) {
        if (identity[field] !== undefined) add(reasons, actual[field] === identity[field], `preflight identity.${field} does not match the planned run`);
    }
    return reasons;
}
