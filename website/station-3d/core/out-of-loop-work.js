// Lets our own main-thread work that runs OUTSIDE the render loop say so.
//
// The overlay derives `stall` as framePeriod - sky - hooks - render, and labels
// a frame `outside-loop` when stall dominates. That reads as "not our code" —
// but a frame-chunk queue schedules its own requestAnimationFrame, a fetch
// continuation parses its payload in a microtask, and an async builder resumes
// in a callback of its own. None of that is inside the loop's hooks, so all of
// it landed in the same anonymous bucket, and a 1.3 s freeze looked like
// something the browser did to us rather than something we did.
//
// Reporting through a registered sink instead of importing the loop directly:
// scene/animate.js already imports core/frame-chunk-queue.js, so the reverse
// import would be a cycle, and core/ has no business depending on scene/ anyway.
//
// The sink is set once at startup. Before that (and in unit tests) reporting is
// a no-op, so nothing here can make a module require a render loop to exist.

let sink = null;

export function setOutOfLoopWorkSink(next) {
    sink = typeof next === 'function' ? next : null;
}

// `name` is a stable label the overlay groups by — prefix it with the kind of
// work ('q:' for a queue flush, 'parse:' for payload decoding) so a row reads as
// a category rather than a mystery.
export function reportOutOfLoopWork(name, ms) {
    if (!sink) return;
    const value = Number(ms);
    // Sub-tenth-millisecond reports are noise that would crowd out the row that
    // matters; the residual below still accounts for them in aggregate.
    if (!Number.isFinite(value) || value < 0.1) return;
    sink(String(name), value);
}

// Times `fn` and reports it. Returns whatever `fn` returns, and still reports
// when it throws — a payload that blows up after 900 ms of parsing cost those
// 900 ms just the same.
export function measureOutOfLoopWork(name, fn, now = () => performance.now()) {
    if (!sink) return fn();
    const startedMs = now();
    try {
        return fn();
    } finally {
        reportOutOfLoopWork(name, now() - startedMs);
    }
}
