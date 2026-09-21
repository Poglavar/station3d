// What the perf overlay should say, as pure functions.
//
// Written after a stutter took a whole session to find. Three things the overlay
// could not tell us, each of which sent the hunt somewhere wrong:
//
//   1. The worst frame resets every window, so by the time you look at the screen
//      the spike is gone. There was no way to see what had just happened.
//   2. A layer that never calls recordLayerFrameMs is invisible: its cost merely
//      inflates `hooks`, with nothing naming it. lane-markings rebuilding every
//      tile synchronously from onFrame looked like time spent nowhere.
//   3. The scheduler already tracks longestItemMs and over50msItems per queue —
//      the numbers that identify an unchunked builder — and the overlay showed
//      neither. A 71.9 ms curb item sat there unreported for weeks.
//
// Restructured 2026-07-27 into topic sections carrying their own colour, and a
// stutter LOG rather than a six-entry teaser: a spike you did not click to copy
// used to be gone forever, so you had to sit and wait for another one.
//
// Pure and DOM-free so each rule is unit-testable; scene/animate.js only renders
// the sections these return.

// A frame this long is a visible stutter rather than jitter.
//
// Was 33 ms, which is one dropped frame at 60 Hz — but a scene that has settled
// onto the 30 Hz vsync cadence has a 33.3 ms frame period BY DEFINITION, so
// every single frame logged itself as a stutter. One 2026-07-30 trace held 2,862
// entries, essentially all of them 33-34 ms with `render 7 stall 25`: the frame
// period, not a fault. That buries the real spikes among thousands of rows and
// makes the count meaningless as a comparison between runs.
//
// 50 ms is above both the 60 Hz and the 30 Hz cadence, so a row means the frame
// missed its own budget rather than merely being a slow-but-regular one.
export const STUTTER_MS = 50;
// The log holds a TIME window, not a count: "the last five minutes" is what you
// actually want when you have just felt something and are reaching for the
// overlay, whereas "the newest 60" silently means four seconds during a bad
// patch and half an hour during a good one.
export const STUTTER_WINDOW_MS = 5 * 60 * 1000;
// A pathological session (every frame stuttering, ~20/s) would put 6,000 entries
// in the window. At a few hundred bytes each that is ~2 MB — irrelevant. The
// hard cap exists only so a runaway cannot grow without bound at all.
export const STUTTER_HARD_CAP = 4000;
// What the DOM may hold, which is the real constraint: 6,000 entries is ~48,000
// nodes, and an overlay that janks is worse than no overlay. Older entries stay
// in memory and still come out in `copy` — see formatStutterLogText.
export const STUTTER_RENDER_LIMIT = 250;

// One colour per topic, so a glance lands on the right block before you read any
// number. Severity colours are shared with the stutter log: yellow is a dropped
// frame, orange is a visible hitch, red is a stall you feel in the chair.
export const TONE_COLORS = Object.freeze({
    heading: '#e2e8f0',
    label: '#7c8da4',
    muted: '#64748b',
    value: '#cbd5e1',
    frame: '#67e8f9',    // cyan   — where this frame's time went
    gpu: '#c4b5fd',      // violet — draw calls and triangles
    work: '#fcd34d',     // amber  — the frame-budget scheduler
    layer: '#86efac',    // green  — per-layer hook cost
    queue: '#93c5fd',    // blue   — background queues and streams
    physics: '#f9a8d4',  // pink   — GTA local physics and collision bubble
    good: '#4ade80',
    warn: '#fb923c',
    minor: '#fde047',    // 33–99 ms
    major: '#fb923c',    // 100–249 ms
    severe: '#f87171',   // 250 ms and up
});

// Thresholds chosen by feel, not by maths: 33 ms is measurable, 100 ms is when a
// ride visibly hitches, 250 ms is when it lurches.
export function stutterSeverity(frameMs) {
    const ms = Number(frameMs) || 0;
    if (ms >= 250) return 'severe';
    if (ms >= 100) return 'major';
    return 'minor';
}

const seg = (text, tone = 'value') => ({ text, tone });

// Most recent first. Kept across windows on purpose — the whole point is that a
// spike survives long enough to read, and now long enough to scroll back to.
export function recordStutter(history, frame, {
    windowMs = STUTTER_WINDOW_MS,
    hardCap = STUTTER_HARD_CAP,
    thresholdMs = STUTTER_MS,
} = {}) {
    const list = Array.isArray(history) ? history : [];
    const frameMs = Number(frame?.frameMs);
    if (!Number.isFinite(frameMs) || frameMs < thresholdMs) return list;
    // The same spike is reported by every window it spans; keep one entry per
    // occurrence by ignoring a repeat of the identical frame timestamp.
    if (list.length > 0 && list[0].atMs === frame.atMs) return list;
    const atMs = Number(frame.atMs) || 0;
    return pruneStutterLog([{
        atMs,
        frameMs,
        hooksMs: Number(frame.hooksMs) || 0,
        renderMs: Number(frame.renderMs) || 0,
        stallMs: Math.max(0, frameMs
            - (Number(frame.skyMs) || 0)
            - (Number(frame.hooksMs) || 0)
            - (Number(frame.renderMs) || 0)),
        layers: String(frame.layers || ''),
        // Named work that ran in the GAP this frame period covers, and how much
        // of that gap still has no name on it.
        outside: String(frame.outside || ''),
        unclaimedStallMs: Number(frame.unclaimedStallMs) || 0,
        // Was the gap a main-thread task at all? Long tasks are JS the page ran;
        // their absence beside a big unclaimed figure points at time the page
        // never had rather than at code we have failed to instrument.
        longTaskMs: Number(frame.longTaskMs) || 0,
        // What was building at the time. Kept per entry rather than only on the
        // window's worst frame: "which spike happened while roads was streaming"
        // is the question the log exists to answer.
        background: String(frame.background || ''),
        // Render's NORMAL cost when this frame ran (previous window's average),
        // so describeStutter can tell a render spike from render being the
        // session's floor. 0 when no window has completed yet.
        renderBaselineMs: Number(frame.renderBaselineMs) || 0,
        // Was the MACHINE contended when this frame ran? A spike recorded while
        // something else was eating the CPU is not evidence about our code, and
        // without this the log invites exactly that mistake — twice in one day.
        hostBusy: frame.hostBusy === true,
        // Was the observer STOPPED when this frame ran? A long frame while the
        // tram sits at a platform is the scheduler doing what it is told —
        // stationary mode hands out a far larger budget precisely so the world
        // catches up while nobody is moving through it. The same frame while
        // moving is the thing we are hunting. Without this the log looks
        // identical for both and the reader has to remember which was which.
        stationary: frame.stationary === true,
        // Renderer/resource evidence belongs to the frame that actually went
        // long, not the next one-second overlay sample. This distinguishes a
        // shader compile/upload spike from a normal high-draw scene.
        gpuCalls: Number(frame.gpuCalls) || 0,
        gpuTriangles: Number(frame.gpuTriangles) || 0,
        gpuPrograms: Number(frame.gpuPrograms) || 0,
        gpuGeometries: Number(frame.gpuGeometries) || 0,
        gpuTextures: Number(frame.gpuTextures) || 0,
        gpuAttribution: Array.isArray(frame.gpuAttribution)
            ? frame.gpuAttribution.map(group => ({ ...group }))
            : frame.gpuAttribution && typeof frame.gpuAttribution === 'object'
                ? {
                    ...frame.gpuAttribution,
                    groups: Array.isArray(frame.gpuAttribution.groups)
                        ? frame.gpuAttribution.groups.map(group => ({ ...group }))
                        : [],
                }
                : null,
        resourceUploadState: String(frame.resourceUploadState || ''),
    }, ...list], atMs, { windowMs, hardCap });
}

// Drop everything older than the window. Called on insert AND once per window by
// the overlay, so the log stays honest about its own span even when nothing new
// arrives — otherwise a quiet minute leaves stale entries claiming to be recent.
export function pruneStutterLog(history, nowMs, {
    windowMs = STUTTER_WINDOW_MS,
    hardCap = STUTTER_HARD_CAP,
} = {}) {
    const list = Array.isArray(history) ? history : [];
    const now = Number(nowMs);
    if (!Number.isFinite(now)) return list.slice(0, hardCap);
    const oldest = now - windowMs;
    // Newest-first, so the first entry outside the window ends the list.
    let keep = list.length;
    for (let index = 0; index < list.length; index++) {
        if ((Number(list[index]?.atMs) || 0) < oldest) { keep = index; break; }
    }
    const pruned = keep === list.length ? list : list.slice(0, keep);
    return pruned.length > hardCap ? pruned.slice(0, hardCap) : pruned;
}

// The whole log as plain text, from the DATA rather than from the DOM — the DOM
// only holds the newest STUTTER_RENDER_LIMIT, and a copy that silently dropped
// the rest would be a readout you cannot trust for the thing it exists to catch.
export function formatStutterLogText(history, clockFor = () => '') {
    return (Array.isArray(history) ? history : []).map((entry) => {
        const d = describeStutter(entry);
        const head = `${clockFor(d.atMs)}  ${d.frameText.padStart(6)}  ${d.cause}`
            + (d.hostBusy ? '  [host busy]' : '')
            + (d.stationary ? '  [stopped]' : '');
        const detail = `          ${d.breakdown}`
            + (d.alsoLayers ? `  · ${d.alsoLayers}` : '')
            + (d.background && d.background !== 'idle' ? `  · while ${d.background}` : '');
        return `${head}\n${detail}`;
    }).join('\n');
}

// One stutter, broken into the parts the log renders. Naming the dominant layer
// — or saying plainly that the time was NOT in our callbacks — is the whole
// diagnosis, and guessing it wrong is what cost a session.
export function describeStutter(entry) {
    const frameMs = Number(entry?.frameMs) || 0;
    const hooksMs = Number(entry?.hooksMs) || 0;
    const renderMs = Number(entry?.renderMs) || 0;
    const stallMs = Number(entry?.stallMs) || 0;
    const layers = String(entry?.layers || '').trim();
    const layerParts = layers ? layers.split(/\s+/) : [];
    // Work of ours that ran between two loop starts — queue flushes, payload
    // decoding, async builders resuming in their own animation frame. Same
    // "name:ms" shape as layers, biggest first.
    const outside = String(entry?.outside || '').trim();
    const outsideParts = outside ? outside.split(/\s+/) : [];
    const unclaimedMs = Number(entry?.unclaimedStallMs) || 0;
    const longTaskMs = Number(entry?.longTaskMs) || 0;
    // The single biggest named contributor wins the headline, wherever it ran.
    // Picking layers first (which is what this did) meant a frame filled by a
    // 1.3 s queue flush was headlined by whichever layer had used 2 ms of hooks,
    // and a frame with no hooks at all was headlined `outside-loop` — a label
    // that names the accounting, not the cause.
    const named = biggestNamedPart(layerParts, outsideParts);
    const namedMs = named ? Number(named.slice(named.lastIndexOf(':') + 1)) || 0 : 0;
    // A render SPIKE must headline as render. On a prod trace, a 114 ms frame
    // whose render was 104 ms was headlined `decor:trees:2` — the biggest named
    // part — and dozens like it sent the reader after decor when the render call
    // itself had tripled. The baseline is what separates that from render merely
    // being the session's floor: at a 36 ms render floor, a 55 ms frame tipped
    // over by 15 ms of roads work should still name roads, because render at its
    // usual price is not that frame's NEWS. Spike = at least double the usual
    // price (or, before any window has completed, most of the frame), and
    // bigger than every named part.
    const renderBaselineMs = Number(entry?.renderBaselineMs) || 0;
    const renderSpiked = renderMs > namedMs
        && renderMs >= 30
        && (renderBaselineMs > 0
            ? renderMs >= renderBaselineMs * 2
            : renderMs >= frameMs * 0.7);
    const unclaimedDominates = unclaimedMs > namedMs
        && unclaimedMs > renderMs
        && unclaimedMs >= frameMs * 0.5;
    const cause = (renderSpiked
        ? `render:${renderMs.toFixed(0)}`
        : unclaimedDominates ? 'outside-loop' : named)
        // Nothing claimed it. `outside-loop` is now an honest statement: the
        // time was in the gap AND no reporter accounted for it.
        || (stallMs > hooksMs + renderMs ? 'outside-loop' : 'unattributed');
    return {
        atMs: Number(entry?.atMs) || 0,
        severity: stutterSeverity(frameMs),
        frameText: `${frameMs.toFixed(0)}ms`,
        cause,
        breakdown: `hooks ${hooksMs.toFixed(0)}  render ${renderMs.toFixed(0)}  stall ${stallMs.toFixed(0)}`
            // `unclaimed` is stall nobody reported; `task` is how much of the
            // period was a main-thread task at all. Together they separate the
            // two things a big gap can be: work of ours that still reports
            // nothing (unclaimed high, task high), or time the page never got —
            // vsync wait, GC, another tab (unclaimed high, task low).
            + (unclaimedMs >= 1
                ? ` (unclaimed ${unclaimedMs.toFixed(0)}, task ${longTaskMs.toFixed(0)})`
                : ''),
        // Everything after the culprit, so a frame filled by three layers still
        // shows the other two without burying the headline.
        alsoLayers: [...layerParts, ...outsideParts]
            .filter(part => part !== cause)
            .join(' '),
        background: String(entry?.background || '').trim(),
        hostBusy: entry?.hostBusy === true,
        stationary: entry?.stationary === true,
    };
}

// "name:ms" parts from two lists; the largest ms wins. Ties keep the first,
// which is the in-loop one, because a layer naming itself is more specific than
// a queue label covering everything that queue did.
function biggestNamedPart(...lists) {
    let best = null;
    let bestMs = -1;
    for (const list of lists) {
        for (const part of list) {
            const ms = Number(part.slice(part.lastIndexOf(':') + 1));
            if (!Number.isFinite(ms) || ms <= bestMs) continue;
            bestMs = ms;
            best = part;
        }
    }
    return best;
}

// Which entries the log has not rendered yet, OLDEST first so each can be
// prepended in turn and leave the newest on top. Pure because the incremental
// path is what keeps the overlay from rebuilding sixty rows every second —
// a diagnostic that perturbs the frames it measures is worse than none.
export function stutterLogDelta(history, renderedAtMs = null) {
    const list = Array.isArray(history) ? history : [];
    if (list.length === 0) return { fresh: [], newestAtMs: renderedAtMs };
    const newestAtMs = list[0].atMs;
    if (renderedAtMs != null && newestAtMs === renderedAtMs) return { fresh: [], newestAtMs };
    const fresh = renderedAtMs == null
        ? [...list]
        : list.filter(entry => entry.atMs > renderedAtMs);
    fresh.reverse();
    return { fresh, newestAtMs };
}

// Hooks time that no layer claimed. A layer only appears in the per-layer list if
// it calls recordLayerFrameMs, so anything else it does is charged to `hooks` with
// nothing pointing at it. A large figure here means an uninstrumented layer, which
// is exactly the blind spot that hid the lane-markings rebuild.
// Stall time that no out-of-loop reporter claimed — the exact analogue of
// unattributedHooksMs, for the gap between the loop's frames rather than inside
// one. `stall` is everything the frame period was not sky/hooks/render, and it
// used to be printed with no breakdown at all, so a queue flush, a payload
// parse and a genuine GPU wait were one indistinguishable number.
//
// A large figure here now means exactly one of two things, and they are worth
// telling apart: main-thread work of ours that still reports nothing, or time
// the page never had (vsync wait, GC, another tab). `longTaskMs` is what says
// which — see the observer in scene/animate.js.
export function unclaimedStallMs(stallMs, outOfLoopMsByName) {
    const stall = Number(stallMs);
    if (!Number.isFinite(stall)) return 0;
    let claimed = 0;
    const entries = outOfLoopMsByName instanceof Map
        ? outOfLoopMsByName.values()
        : Object.values(outOfLoopMsByName || {});
    for (const ms of entries) {
        const value = Number(ms);
        if (Number.isFinite(value)) claimed += value;
    }
    // Reporters may overlap (a queue flush that itself reports a sub-phase), so
    // the claim can exceed the stall. Never negative: a negative "unclaimed"
    // would read as a bug in the world rather than in the accounting.
    return Math.max(0, stall - claimed);
}

export function unattributedHooksMs(hooksMs, layerMsByName) {
    const hooks = Number(hooksMs);
    if (!Number.isFinite(hooks)) return 0;
    let claimed = 0;
    const entries = layerMsByName instanceof Map
        ? layerMsByName.values()
        : Object.values(layerMsByName || {});
    for (const ms of entries) {
        const value = Number(ms);
        if (Number.isFinite(value)) claimed += value;
    }
    // Never negative: layers may double-count nested work, and a negative
    // "unattributed" would read as a bug in the overlay rather than in the world.
    return Math.max(0, hooks - claimed);
}

// Queues whose SINGLE items are too big to be bounded by a frame budget. A budget
// only decides whether to start an item; it cannot interrupt one. Any queue here
// needs cooperative staging, not a smaller slice.
export function describeQueueHotspots(queues, { minItemMs = 8, limit = 4 } = {}) {
    return (Array.isArray(queues) ? queues : [])
        .filter(q => Number(q?.longestItemMs) >= minItemMs)
        .sort((a, b) => Number(b.longestItemMs) - Number(a.longestItemMs))
        .slice(0, limit)
        .map(q => ({
            // The stage name when the job supplies one, so the line points at
            // the work rather than at the whole layer that owns it.
            label: q.longestItemLabel
                ? `${q.label}:${q.longestItemLabel}`
                : String(q.label),
            itemMs: Number(q.longestItemMs),
            over50: Number(q.over50msItems) || 0,
        }));
}

// Per work class over the OVERLAY'S WINDOW, not one frame.
//
// This originally read scheduler.spentByClass, which the scheduler resets every
// frame — so sampling it once a second reported whatever a single arbitrary
// frame did, and most frames run no queue work at all. Every class therefore
// showed "0.0 spent" beside a real backlog, and `starved` fired constantly. A
// diagnostic that cries wolf every second is worse than none: it taught the
// reader to ignore the one signal it existed to give.
//
// `windowSpentByClass` is a delta of the scheduler's monotonic lifetime
// counters across the window, and `frames` is how many frames that covers, so
// the budget comparison is like-for-like: a per-frame allowance times the
// frames that actually elapsed.
export function describeWorkClasses(scheduler, {
    windowSpentByClass = null,
    frames = 1,
} = {}) {
    const budgets = scheduler?.classBudgets || {};
    const spent = windowSpentByClass || scheduler?.spentByClass || {};
    const frameCount = Math.max(1, Number(frames) || 1);
    const pendingByClass = new Map();
    for (const queue of scheduler?.queues || []) {
        const workClass = queue?.workClass;
        if (!workClass) continue;
        pendingByClass.set(
            workClass,
            (pendingByClass.get(workClass) || 0) + Math.max(0, Number(queue.pendingItems) || 0),
        );
    }
    return Object.keys(budgets).map((name) => {
        const spentMs = Math.max(0, Number(spent[name]) || 0);
        // The allowance over the same span the spend was measured over.
        const budgetMs = Math.max(0, Number(budgets[name]) || 0) * frameCount;
        const pending = pendingByClass.get(name) || 0;
        // A whole window — a second of frames — with a backlog and not one
        // millisecond spent. THAT is starvation; a single idle frame is not.
        return { name, spentMs, budgetMs, pending, starved: pending > 0 && spentMs === 0 };
    });
}

// One background entry with every zero dropped. The old form printed
// "0 retry / 0 build-failed" for every stream every second, which is most of a
// screenful of nothing and buried the one counter that was moving.
export function describeBackgroundEntry(entry) {
    const num = field => Math.max(0, Number(entry?.[field]) || 0);
    const parts = [];
    const push = (value, unit, tone = 'value') => {
        if (value > 0) parts.push(seg(`${value} ${unit}`, tone));
    };
    push(num('pending'), 'items');
    push(num('jobs'), 'jobs');
    push(num('fetching'), 'fetching');
    push(num('building'), 'building');
    push(num('loaded'), 'loaded', 'muted');
    push(num('activeOwners'), 'owners', 'muted');
    push(num('retrying'), 'retry', 'warn');
    push(num('staleRejected'), 'stale rejected', 'warn');
    push(num('conflicts'), 'owner conflicts', 'severe');
    push(num('missingClaims'), 'missing claims', 'severe');
    push(num('invalidClaims'), 'invalid claims', 'severe');
    const failureCount = num('fetchFailed') + num('buildFailed') + num('failed');
    if (failureCount > 0) {
        const failureCode = String(
            entry?.lastFailure?.code
            || entry?.lastError?.code
            || '',
        ).trim();
        parts.push(seg(
            `${failureCount} failed${failureCode ? ` (${failureCode})` : ''}`,
            'severe',
        ));
    }
    if (entry?.visible != null) {
        parts.push(seg(
            `view ${num('support') + num('visible')}`
            + ` / edge ${num('peripheral')}`
            + ` / hidden ${num('hidden') + num('unknown')}`,
            'muted',
        ));
    }
    const waitMs = num('oldestVisibleWaitMs');
    // A visible tile that has been waiting seconds is a starved queue, not a busy
    // one — worth colouring even though it is only ever a single number.
    if (waitMs > 0) parts.push(seg(`oldest ${(waitMs / 1000).toFixed(1)}s`, waitMs > 3000 ? 'warn' : 'muted'));
    // A dependency-deferred item that has stopped making progress. Costs ~0 ms,
    // so no timing stat can show it — the wedge is visible only by name.
    if (entry?.stalled) parts.push(seg(`stalled ${entry.stalled}`, 'severe'));
    return { label: String(entry?.label || '?'), parts };
}

const pad = (text, width) => String(text).padEnd(width);

// The whole live pane, as sections. Each section is one topic with one colour;
// each row is a list of coloured segments that scene/animate.js turns into spans
// and that textContent flattens back into copyable plain text.
export function buildPerfSections({
    fps = 0,
    frameAvgMs = 0,
    skyMs = 0,
    hooksMs = 0,
    unnamedMs = 0,
    renderMs = 0,
    stallMs = 0,
    peakFrameMs = 0,
    gpuCalls = 0,
    gpuTriangles = 0,
    gpuPrograms = 0,
    gpuAttribution = null,
    gta = null,
    layers = [],
    scheduler = null,
    background = [],
    backgroundLimit = 8,
    hostLoad = null,
    hostBlame = null,
    cpuCores = 0,
    workSpentByClass = null,
    workFrames = 1,
} = {}) {
    const sections = [];

    // FIRST, because it qualifies everything below it. A 250 ms render on a
    // contended machine is not a 250 ms render.
    if (hostLoad) {
        sections.push({
            id: 'host', title: 'HOST', tone: 'host',
            rows: [
                [
                    seg('cpu ', 'label'),
                    seg(hostLoad.text, hostLoad.tone),
                    ...(cpuCores ? [seg(`   ${cpuCores} cores`, 'muted')] : []),
                ],
                // Only present while contended AND energy-manager is running;
                // the ratio above is the finding, this is just the name on it.
                ...(hostBlame ? [[seg(hostBlame, 'host')]] : []),
            ],
        });
    }

    // Where this frame's time went. `stall` is the same quantity the stutter log
    // calls `stall` — it used to be `gap` here and `stall` there, two names in one
    // overlay for the one number that says "this was not our JS".
    sections.push({
        id: 'frame', title: 'FRAME', tone: 'frame',
        rows: [[
            seg('hooks ', 'label'), seg(hooksMs.toFixed(2), 'frame'),
            ...(unnamedMs > 0.05
                ? [seg(' (unnamed ', 'label'), seg(unnamedMs.toFixed(2), 'warn'), seg(')', 'label')]
                : []),
            seg('  render ', 'label'), seg(renderMs.toFixed(2), 'frame'),
            seg('  sky ', 'label'), seg(skyMs.toFixed(2), 'frame'),
            seg('  stall ', 'label'), seg(stallMs.toFixed(2), stallMs > 4 ? 'warn' : 'frame'),
            seg('  peak ', 'label'),
            seg(`${peakFrameMs.toFixed(1)}ms`, peakFrameMs >= STUTTER_MS ? 'major' : 'frame'),
        ]],
    });

    sections.push({
        id: 'gpu', title: 'GPU', tone: 'gpu',
        rows: [
            [
                seg('calls ', 'label'),
                seg(String(gpuCalls), gpuCalls > 2000 ? 'warn' : 'gpu'),
                seg('  tris ', 'label'),
                seg(gpuTriangles > 1e6
                    ? `${(gpuTriangles / 1e6).toFixed(2)}M`
                    : `${(gpuTriangles / 1e3).toFixed(0)}k`, 'gpu'),
                // Compiled shader programs. three.js compiles one SYNCHRONOUSLY the
                // first time a material/geometry combination is rendered, inside
                // render() — so a count that climbs step-for-step with unexplained
                // `render` spikes says the cost is compilation rather than upload,
                // and the fix is renderer.compile() off the critical frame. Neither
                // shows up in the draw-call count, which is what made the last
                // render-side cliff so hard to see.
                ...(gpuPrograms
                    ? [seg('  programs ', 'label'), seg(String(gpuPrograms), 'gpu')]
                    : []),
            ],
            ...(Number(gpuAttribution?.frames) > 0 ? [[
                seg('avg passes  colour ', 'label'),
                seg(Number(gpuAttribution.mainCalls || 0).toFixed(0), 'gpu'),
                seg('  shadow ', 'label'),
                seg(Number(gpuAttribution.shadowCalls || 0).toFixed(0), 'gpu'),
                seg('  other ', 'label'),
                seg(Number(gpuAttribution.unattributedCalls || 0).toFixed(0), 'gpu'),
            ]] : []),
            ...((gpuAttribution?.groups || []).slice(0, 5).map(group => [
                seg(`${group.name} `, 'label'),
                seg(Number(group.calls || 0).toFixed(0), 'gpu'),
                seg(` (${Number(group.mainCalls || 0).toFixed(0)}c/`, 'muted'),
                seg(`${Number(group.shadowCalls || 0).toFixed(0)}s)`, 'muted'),
            ])),
        ],
    });

    if (gta?.physics) {
        const physics = gta.physics;
        const traffic = gta.traffic || {};
        const capacity = physics.capacityHits || {};
        sections.push({
            id: 'physics', title: 'PHYSICS', tone: 'physics',
            rows: [
                [
                    seg('fixed ', 'label'), seg(String(Number(physics.fixedBodies) || 0), 'physics'),
                    seg('  traffic ', 'label'), seg(String(Number(physics.trafficBodies) || 0), 'physics'),
                    seg(' (', 'label'), seg(`${Number(physics.promotedTrafficBodies) || 0}d/${Number(physics.kinematicTrafficBodies) || 0}k`, 'physics'), seg(')', 'label'),
                    seg('  debris ', 'label'), seg(String(Number(physics.debris) || 0), 'physics'),
                    seg('  pool ', 'label'), seg(String(Number(physics.debrisPool) || 0), 'physics'),
                    seg('  health ', 'label'), seg(`${Math.round(Number(physics.vehicleHealth) || 0)}%`, 'physics'),
                ],
                [
                    seg('step ', 'label'), seg(`${Number(physics.lastPhysicsStepMs || 0).toFixed(2)}ms`, 'physics'),
                    seg('  max ', 'label'), seg(`${Number(physics.maxPhysicsStepMs || 0).toFixed(2)}ms`, 'physics'),
                    seg('  dropped ', 'label'), seg(`${Number(physics.droppedPhysicsSeconds || 0).toFixed(3)}s`, 'physics'),
                    seg('  contacts ', 'label'), seg(String(Number(physics.contactEventCount) || 0), 'physics'),
                ],
                [
                    seg('graph ', 'label'), seg(String(Number(traffic.activeGraphSegments) || 0), 'physics'),
                    seg('  cars ', 'label'), seg(`${Number(traffic.movingCars) || 0}/${Number(traffic.parkedCars) || 0}/${Number(traffic.wreckedCars) || 0}`, 'physics'),
                    seg('  pending ', 'label'), seg(`${Number(physics.pendingFixedBuilds) || 0}+${Number(physics.pendingFixedRetirements) || 0}`, 'physics'),
                    seg('  caps ', 'label'), seg(`${Number(capacity.fixed) || 0}/${Number(capacity.traffic) || 0}/${Number(capacity.debris) || 0}`, 'physics'),
                ],
            ],
        });
    }

    if (scheduler) {
        const frames = Math.max(1, Number(workFrames) || 1);
        const spentTotal = workSpentByClass
            ? Object.values(workSpentByClass).reduce((sum, ms) => sum + (Number(ms) || 0), 0)
            : Number(scheduler.spentTotalMs || 0);
        const budgetTotal = Number(scheduler.totalBudgetMs || 0) * frames;
        const rows = [[
            seg(String(scheduler.mode || '?'), 'work'),
            seg(' · ', 'muted'), seg(String(scheduler.motionState || '?'), 'work'),
            seg(' · ', 'muted'), seg(`${Number(scheduler.speedMps || 0).toFixed(1)}m/s`, 'work'),
            // Over the window, not this frame — see describeWorkClasses.
            seg(`   spent ${spentTotal.toFixed(0)}/${budgetTotal.toFixed(0)}ms`, 'work'),
            seg(` over ${frames}f`, 'muted'),
        ]];
        const classes = describeWorkClasses(scheduler, {
            windowSpentByClass: workSpentByClass,
            frames,
        });
        if (classes.length > 0) {
            const row = [];
            for (const cls of classes) {
                if (row.length > 0) row.push(seg('  ', 'muted'));
                row.push(seg(`${cls.name} `, cls.starved ? 'severe' : 'label'));
                row.push(seg(
                    `${cls.spentMs.toFixed(0)}/${cls.budgetMs.toFixed(0)}`,
                    cls.starved ? 'severe' : 'work',
                ));
                // A backlog that got no time at all is the thing to notice, so it
                // says how big the backlog is rather than just colouring the zero.
                if (cls.starved) row.push(seg(`(${cls.pending} waiting!)`, 'severe'));
            }
            rows.push(row);
        }
        const hotspots = describeQueueHotspots(scheduler.queues);
        if (hotspots.length > 0) {
            const row = [seg('fat items ', 'label')];
            hotspots.forEach((hot, index) => {
                if (index > 0) row.push(seg(' · ', 'muted'));
                row.push(seg(`${hot.label} `, 'value'));
                row.push(seg(`${hot.itemMs.toFixed(0)}ms`, hot.itemMs >= 50 ? 'severe' : 'warn'));
                if (hot.over50 > 0) row.push(seg(`×${hot.over50}>50`, 'severe'));
            });
            rows.push(row);
        }
        sections.push({ id: 'work', title: 'WORK', tone: 'work', rows });
    }

    if (layers.length > 0) {
        sections.push({
            id: 'layers', title: 'LAYERS', tone: 'layer',
            rows: layers.map(({ name, avgMs }) => [
                seg(pad(name, 18), 'label'),
                seg(`${Number(avgMs).toFixed(2)}ms`, Number(avgMs) >= 2 ? 'warn' : 'layer'),
            ]),
        });
    }

    const busy = Array.isArray(background) ? background : [];
    sections.push({
        id: 'queues', title: 'QUEUES', tone: 'queue',
        rows: busy.length === 0
            ? [[seg('caught up ✓', 'good')]]
            : [
                ...busy.slice(0, backgroundLimit).map((entry) => {
                    const described = describeBackgroundEntry(entry);
                    const row = [seg(pad(described.label, 18), 'queue')];
                    described.parts.forEach((part, index) => {
                        if (index > 0) row.push(seg(' · ', 'muted'));
                        row.push(part);
                    });
                    return row;
                }),
                ...(busy.length > backgroundLimit
                    ? [[seg(`+${busy.length - backgroundLimit} more`, 'muted')]]
                    : []),
            ],
    });

    return sections;
}

// Whether a plain F press may mount the FPS/perf overlays when nothing has
// mounted them yet. Local development keeps the one-key opt-in; a deployed
// host needs the explicit `?stats=1` opt-in, so a player who brushes F while
// walking never gets a diagnostics panel (seen on zagreb.lol, 2026-09-11).
// Once the overlays are mounted, F keeps toggling them everywhere.
export function performanceOverlayKeyAllowed({ mounted = false, localHost = false, search = '' } = {}) {
    if (mounted) return true;
    if (localHost) return true;
    return new URLSearchParams(String(search || '')).get('stats') === '1';
}
