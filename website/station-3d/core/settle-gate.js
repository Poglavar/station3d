// "Has this stopped changing?" as a pure rule, so the answer can be tested
// without a render loop.
//
// Extracted 2026-07-27 from lane-markings, where rebuilding the whole merged
// mesh on every tile arrival was the single most frequent stutter cause: a
// stream delivering N tiles over N frames did N full rebuilds. The fix is to act
// once the burst SETTLES — a frame in which nothing new arrived — rather than on
// each change or after a guessed timeout (see the house rule against sleeping on
// a delay; a settle is a condition, and it is also the idiom already used for
// the roadFormation revision in that same file).
//
// Two knobs, and the second one turned out to matter more than the first.
//
// `quietFrames` is how many consecutive frames with no change count as settled.
// One frame is barely any coalescing at all when the source delivers with GAPS
// rather than in dense consecutive-frame bursts — which is how tile streams
// actually behave, and why a one-frame settle left lane markings rebuilding
// several times a second.
//
// `maxDeferredFrames` bounds the wait so a source that never goes quiet still
// gets its work done. During continuous streaming this cap, not the settle, sets
// the cadence: measured at 97 fps with a cap of 30, lane markings rebuilt about
// four times a second — one per 25 frames. Size it by how stale the result may
// be, not by how quiet you hope the source will get.
export function createSettleGate({ quietFrames = 1, maxDeferredFrames = 30 } = {}) {
    return {
        applied: 0,
        settled: -1,
        quiet: 0,
        deferred: 0,
        quietFrames: Math.max(1, Number(quietFrames) || 1),
        maxDeferredFrames,
    };
}

// Call once per frame with the current revision. Returns true when the caller
// should do the work now, and records that it did.
export function shouldRunOnSettle(gate, revision) {
    if (!gate) return false;
    if (revision === gate.applied) {
        gate.settled = revision;
        gate.quiet = 0;
        gate.deferred = 0;
        return false;
    }
    gate.quiet = revision === gate.settled ? gate.quiet + 1 : 0;
    gate.settled = revision;
    gate.deferred += 1;
    const settled = gate.quiet >= gate.quietFrames;
    if (!settled && gate.deferred <= gate.maxDeferredFrames) return false;
    gate.quiet = 0;
    gate.deferred = 0;
    gate.applied = revision;
    return true;
}

// After work that covers everything up to `revision` was done out of band.
export function markSettleGateApplied(gate, revision) {
    if (!gate) return;
    gate.applied = revision;
    gate.settled = revision;
    gate.quiet = 0;
    gate.deferred = 0;
}
