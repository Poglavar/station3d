// Is this machine actually giving us a core, or is something else eating it?
//
// Written 2026-07-27 after two separate slowdowns were investigated as code
// regressions and turned out to be background load on the laptop. A profile
// taken on a contended machine is not a measurement of the program — every
// number in it is inflated by an unknown factor, and the overlay had no way to
// say so. Worse, the inflation is not uniform: it lands on whichever frame
// happened to be scheduled against the competing work, so it looks exactly like
// an intermittent stutter in our own code.
//
// The measure is a CONTENTION RATIO, not a CPU percentage — the browser cannot
// see system CPU, and asking it to would be a lie anyway. Instead we run an
// identical, fixed amount of arithmetic once per window and remember the fastest
// it has ever completed. That best time is this machine at its most available.
// When the same work takes 3x that, we are getting roughly a third of a core,
// whatever the cause: another process, a busy GPU driver thread, thermal
// throttling, a VM neighbour. The ratio is what matters for reading a profile.
//
// Deliberately NOT a wall-clock threshold: "over 2 ms is busy" would be wrong on
// every machine but the one it was tuned on. A ratio against the host's own best
// is self-calibrating.
//
// Pure and DOM-free; scene/animate.js runs the sampler and renders the verdict.

import { finiteOrNull } from './math.js';

// Enough arithmetic to be measurable above timer noise, small enough that the
// probe itself is not a stutter: ~0.5-3 ms on a modern laptop, once per
// second. The shorter original probe fell below Chromium's non-isolated timer
// granularity on fast machines, quantising healthy samples to ratios such as
// 1.0, 1.5, and 2.0 and falsely marking the last one as contention. Integer ops
// with a data dependency keep the work fixed so a JIT cannot hoist or vectorise
// the loop away, and a returned checksum keeps it from becoming dead code.
export const PROBE_ITERATIONS = 2_000_000;

// Below this we have not seen the machine idle enough to trust the baseline.
export const MIN_SAMPLES_FOR_VERDICT = 3;

// Ratios against the host's own best. Generous, because the cost of a false
// "busy" (distrusting a real regression) is higher than a missed one.
export const BUSY_RATIO = 1.6;
export const OVERLOADED_RATIO = 2.5;

export function runContentionProbe(iterations = PROBE_ITERATIONS) {
    const started = performance.now();
    let acc = 1;
    for (let i = 1; i <= iterations; i++) {
        // Keep the multiply in int32 arithmetic. The equivalent floating-point
        // multiply/conversion cost ~16 ms per probe in the 2026-09-05 Chrome
        // capture, making the diagnostic consume a frame every second.
        acc = (Math.imul(acc, 31) + i) | 0;
        acc ^= acc >>> 7;
    }
    const elapsedMs = performance.now() - started;
    // The checksum exists so the loop cannot be optimised out; nothing reads it.
    return { elapsedMs, checksum: acc };
}

// Rolling state: the machine's best-ever probe time and the latest sample.
export function createHostLoadState() {
    return { bestMs: null, lastMs: null, samples: 0 };
}

export function recordProbeSample(state, elapsedMs) {
    const ms = finiteOrNull(elapsedMs);
    if (ms === null || ms <= 0) return state;
    return {
        // Best ever, never decayed. A machine that has been quiet once has shown
        // us what it can do; later contention should be measured against that,
        // not against a recent average that contention itself has poisoned.
        bestMs: state.bestMs === null ? ms : Math.min(state.bestMs, ms),
        lastMs: ms,
        samples: state.samples + 1,
    };
}

// 'unknown' until the baseline has settled, then clean / busy / overloaded.
export function hostLoadVerdict(state, {
    busyRatio = BUSY_RATIO,
    overloadedRatio = OVERLOADED_RATIO,
    minSamples = MIN_SAMPLES_FOR_VERDICT,
} = {}) {
    if (!state || state.samples < minSamples || !state.bestMs || !state.lastMs) {
        return { level: 'unknown', ratio: null, contended: false };
    }
    const ratio = state.lastMs / state.bestMs;
    const level = ratio >= overloadedRatio ? 'overloaded' : ratio >= busyRatio ? 'busy' : 'clean';
    return { level, ratio, contended: level !== 'clean' };
}

// One line for the overlay. Says what the number MEANS, because "×2.4" alone
// invites being read as a CPU percentage.
export function describeHostLoad(verdict) {
    if (!verdict || verdict.level === 'unknown') {
        return { text: 'calibrating…', tone: 'muted' };
    }
    const ratio = `×${verdict.ratio.toFixed(1)}`;
    if (verdict.level === 'overloaded') {
        return { text: `${ratio} OVERLOADED — timings are not the code`, tone: 'severe' };
    }
    if (verdict.level === 'busy') {
        return { text: `${ratio} busy — treat timings with suspicion`, tone: 'warn' };
    }
    return { text: `${ratio} clean`, tone: 'good' };
}

// ── Who is to blame, when the probe says something is ─────────────────────────
// The probe above answers "are my timings trustworthy?" with no dependencies.
// This answers "what is eating the machine?", and needs energy-manager's local
// reader running (`energy-graph start`). Optional by design: if it is not up,
// the overlay simply does not name names, and the ratio still stands on its own.
//
// Only ever fetched while the probe reports contention — a poll that runs when
// the machine is idle would be a diagnostic adding load to the thing it measures.
export const HOST_BLAME_URL = 'http://127.0.0.1:8787/load.json?top=3';
// Slow: the answer changes on human timescales, and each call costs a `ps`.
export const HOST_BLAME_MIN_INTERVAL_MS = 5000;

// Pure. `busyPct` is summed %cpu across all processes, so on an 8-core box it
// runs to ~800 — dividing by cores is what makes it a fraction of the machine.
export function describeHostBlame(payload) {
    const top = Array.isArray(payload?.top) ? payload.top : [];
    // finiteOrNull, not Number(): a missing cpu figure must not read as 0%,
    // which would name an innocent process as a culprit. See core/math.js.
    const named = top
        .map(entry => ({ cpu: finiteOrNull(entry?.cpu), name: entry?.name }))
        .filter(entry => entry.cpu !== null && entry.name)
        .map(entry => `${entry.name} ${Math.round(entry.cpu)}%`);
    if (named.length === 0) return null;
    const cores = finiteOrNull(payload?.cores);
    const busy = finiteOrNull(payload?.busyPct);
    const machine = cores !== null && cores > 0 && busy !== null
        ? `${Math.round((busy / (cores * 100)) * 100)}% of ${cores} cores`
        : null;
    return [machine, named.join(' · ')].filter(Boolean).join(' — ');
}
