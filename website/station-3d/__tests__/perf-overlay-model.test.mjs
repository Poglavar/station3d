// The overlay's job is to make the next slowdown findable. Each of these pins a
// gap that actually cost a debugging session: a spike that vanished before it
// could be read, a layer nothing named, and a fat queue item nobody displayed.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildPerfSections,
    describeBackgroundEntry,
    describeQueueHotspots,
    describeStutter,
    describeWorkClasses,
    recordStutter,
    formatStutterLogText,
    pruneStutterLog,
    STUTTER_HARD_CAP,
    STUTTER_WINDOW_MS,
    stutterLogDelta,
    STUTTER_MS,
    stutterSeverity,
    TONE_COLORS,
    unattributedHooksMs,
    performanceOverlayKeyAllowed,
} from '../core/perf-overlay-model.js';

// Flatten a section's rows the way the DOM renderer does, so assertions read
// against what actually lands on screen.
const rowText = row => row.map(segment => segment.text).join('');
const sectionText = section => section.rows.map(rowText).join('\n');
const sectionById = (sections, id) => sections.find(section => section.id === id);
const allSegments = sections => sections.flatMap(s => s.rows.flat());

test('a stutter survives the window that found it', () => {
    let history = [];
    history = recordStutter(history, {
        frameMs: 521, skyMs: 0.1, hooksMs: 507, renderMs: 7, atMs: 1000, layers: 'laneMarkings:507',
    });
    assert.equal(history.length, 1);
    assert.equal(history[0].frameMs, 521);
    assert.equal(history[0].stallMs, Math.max(0, 521 - 0.1 - 507 - 7));
    // A later, SMALLER stutter still gets recorded — the worst frame of a window
    // is not the only one worth seeing.
    history = recordStutter(history, { frameMs: 120, hooksMs: 110, renderMs: 6, atMs: 3000, layers: 'rails:110' });
    assert.equal(history.length, 2);
    assert.equal(history[0].frameMs, 120, 'most recent first');
    assert.equal(history[1].frameMs, 521);
});

test('a stutter retains exact-frame GPU ownership and upload state', () => {
    const attribution = {
        totalCalls: 75,
        mainCalls: 44,
        shadowCalls: 31,
        unattributedCalls: 0,
        groups: [{ name: 'platforms:surface', calls: 44, triangles: 1200 }],
    };
    const [stutter] = recordStutter([], {
        frameMs: 88,
        atMs: 123,
        gpuCalls: 75,
        gpuTriangles: 42_000,
        gpuPrograms: 19,
        gpuGeometries: 80,
        gpuTextures: 31,
        gpuAttribution: attribution,
        resourceUploadState: 'near 2 · delivery 1',
    });
    assert.equal(stutter.gpuCalls, 75);
    assert.equal(stutter.gpuTriangles, 42_000);
    assert.equal(stutter.gpuPrograms, 19);
    assert.deepEqual(stutter.gpuAttribution, attribution);
    assert.notEqual(stutter.gpuAttribution, attribution, 'diagnostics own an immutable object copy');
    assert.notEqual(
        stutter.gpuAttribution.groups,
        attribution.groups,
        'the nested per-group evidence is copied too',
    );
    assert.equal(stutter.resourceUploadState, 'near 2 · delivery 1');
});

test('ordinary frames are not recorded, and the same spike is not double-counted', () => {
    let history = [];
    history = recordStutter(history, { frameMs: STUTTER_MS - 0.1, hooksMs: 1, atMs: 10 });
    assert.deepEqual(history, [], 'below the threshold is jitter, not a stutter');
    const spike = { frameMs: 400, hooksMs: 390, renderMs: 5, atMs: 50, layers: 'cars:390' };
    history = recordStutter(history, spike);
    // Every window that spans the spike reports it; only one entry should result.
    history = recordStutter(history, spike);
    history = recordStutter(history, { ...spike });
    assert.equal(history.length, 1);
});

test('a scene settled on the 30 Hz cadence does not log every frame as a stutter', () => {
    // The threshold was 33 ms, which IS the 30 Hz frame period, so a session
    // that had simply dropped to half refresh logged a stutter every frame —
    // 2,862 of them in one 2026-07-30 trace, burying the real spikes and making
    // the count useless for comparing runs. A regular 30 Hz frame is a slow
    // scene, not a fault; only a frame that misses even that budget is.
    let history = [];
    for (let frame = 0; frame < 120; frame++) {
        history = recordStutter(history, {
            frameMs: 33.3, hooksMs: 0.3, renderMs: 8, atMs: frame * 33.3,
        });
    }
    assert.deepEqual(history, [], 'the 30 Hz cadence is not a stutter');

    // And a frame that genuinely overruns even that cadence still lands.
    history = recordStutter(history, { frameMs: 64, hooksMs: 40, atMs: 9000 });
    assert.equal(history.length, 1);
});

test('a rejected frame returns the SAME array, which is how the total is counted', () => {
    // animate.js increments its running stutter count on identity change, because
    // the log holds a time window and its length is not a running total.
    const history = [];
    assert.equal(recordStutter(history, { frameMs: 10, atMs: 1 }), history, 'ordinary frame');
    const withOne = recordStutter(history, { frameMs: 90, atMs: 2 });
    assert.notEqual(withOne, history, 'a real stutter is a new array');
    assert.equal(recordStutter(withOne, { frameMs: 90, atMs: 2 }), withOne, 'a repeat of the same frame');
});

test('the log holds a time window, not a count', () => {
    // "the newest 60" is four seconds during a bad patch and half an hour during
    // a good one — which is the wrong unit for "what just happened to me".
    let history = [];
    // One stutter a second for eight minutes.
    for (let i = 0; i < 8 * 60; i++) {
        history = recordStutter(history, { frameMs: 100 + i, hooksMs: 90, atMs: i * 1000 });
    }
    const newestAtMs = history[0].atMs;
    assert.ok(history.length > 60, `a count cap would have left 60, got ${history.length}`);
    assert.ok(history.every(e => newestAtMs - e.atMs <= STUTTER_WINDOW_MS),
        'nothing older than the window survives');
    assert.ok(history.length >= 295 && history.length <= 302,
        `~5 minutes of one-per-second, got ${history.length}`);
});

test('a runaway session still cannot grow without bound', () => {
    // 4,000 entries is ~2 MB, far past any real five minutes; the cap exists so
    // a pathological run has a ceiling at all, not as the normal mechanism.
    let history = [];
    for (let i = 0; i < STUTTER_HARD_CAP + 500; i++) {
        // All within the window, so only the hard cap can bound this.
        history = recordStutter(history, { frameMs: 50, hooksMs: 40, atMs: 1_000_000 + i });
    }
    assert.equal(history.length, STUTTER_HARD_CAP);
});

test('the window is enforced on the clock, not only when a stutter arrives', () => {
    // Otherwise a quiet minute leaves aged-out entries on screen still claiming
    // to be recent — the log would lie about its own span exactly when calm.
    const history = [
        { atMs: 400_000, frameMs: 90 },
        { atMs: 100_000, frameMs: 90 },   // 5 min older than the first
        { atMs: 10_000, frameMs: 90 },
    ];
    const pruned = pruneStutterLog(history, 400_000);
    assert.deepEqual(pruned.map(e => e.atMs), [400_000, 100_000]);
    assert.deepEqual(pruneStutterLog(history, 700_000).map(e => e.atMs), [400_000]);
    assert.deepEqual(pruneStutterLog(history, 1_000_000), [], 'all aged out');
    // A nonsense clock must not silently empty the log.
    assert.equal(pruneStutterLog(history, NaN).length, 3);
});

test('copy serialises every held stutter, not just the rendered ones', () => {
    // The DOM holds STUTTER_RENDER_LIMIT rows; the copy must not quietly match
    // it, or the readout omits exactly the history the window exists to keep.
    const history = [
        { atMs: 2000, frameMs: 521, hooksMs: 507, renderMs: 7, stallMs: 7, layers: 'laneMarkings:507 cars:9', background: 'roads:412', hostBusy: true },
        { atMs: 1000, frameMs: 66, hooksMs: 1, renderMs: 2, stallMs: 63, layers: '', background: 'idle' },
    ];
    const text = formatStutterLogText(history, at => `T+${at}`);
    assert.match(text, /T\+2000\s+521ms\s+laneMarkings:507\s+\[host busy\]/);
    assert.match(text, /hooks 507\s+render 7\s+stall 7\s+· cars:9\s+· while roads:412/);
    assert.match(text, /T\+1000\s+66ms\s+outside-loop/);
    assert.ok(!/while idle/.test(text), 'an idle background says nothing');
    assert.equal(text.split('\n').length, 4, 'two lines per entry');
    assert.equal(formatStutterLogText([]), '');
});

test('the log renders only what is new, oldest of the batch first', () => {
    // Rebuilding sixty rows a second would have this overlay perturbing the very
    // frames it measures, so only the delta is ever built.
    const history = [{ atMs: 300 }, { atMs: 200 }, { atMs: 100 }];
    const first = stutterLogDelta(history, null);
    assert.deepEqual(first.fresh.map(e => e.atMs), [100, 200, 300], 'each is prepended, so oldest goes in first');
    assert.equal(first.newestAtMs, 300);

    // Nothing new since the last render: no DOM work at all.
    assert.deepEqual(stutterLogDelta(history, 300).fresh, []);

    const grown = [{ atMs: 500 }, { atMs: 400 }, ...history];
    assert.deepEqual(stutterLogDelta(grown, 300).fresh.map(e => e.atMs), [400, 500], 'only the two that arrived');
    assert.deepEqual(stutterLogDelta([], null).fresh, []);
});

test('a stutter names the layer, or says plainly that the time was not ours', () => {
    // laneMarkings filled the frame, and the other layers that ran are still shown.
    const named = describeStutter({
        atMs: 6000, frameMs: 521, hooksMs: 507, renderMs: 7, stallMs: 7,
        layers: 'laneMarkings:507 cars:9 rails:3', background: 'roads:412',
    });
    assert.equal(named.cause, 'laneMarkings:507');
    assert.equal(named.alsoLayers, 'cars:9 rails:3');
    assert.equal(named.severity, 'severe');
    assert.match(named.breakdown, /hooks 507\s+render 7\s+stall 7/);
    assert.equal(named.background, 'roads:412');

    // No layer recorded and the time was mostly stall: that is the case where
    // guessing "our JS" wasted a session, so it must say so.
    assert.equal(describeStutter({ frameMs: 660, hooksMs: 0.7, renderMs: 2.3, stallMs: 657 }).cause, 'outside-loop');
    // No layer recorded but the time WAS in hooks: an uninstrumented layer.
    assert.equal(describeStutter({ frameMs: 300, hooksMs: 290, renderMs: 5, stallMs: 5 }).cause, 'unattributed');
});

test('a render spike headlines as render, but render at its floor does not', () => {
    // The prod failure this pins: a 114 ms frame whose render was 104 ms was
    // headlined `decor:trees:2` — the biggest NAMED part — because render was
    // never a cause candidate. Dozens of render spikes wore decor labels.
    const spike = describeStutter({
        frameMs: 114, hooksMs: 1, renderMs: 104, stallMs: 9,
        outside: 'decor:trees:2', renderBaselineMs: 36,
    });
    assert.equal(spike.cause, 'render:104');
    assert.equal(spike.alsoLayers, 'decor:trees:2', 'the named work is still shown');

    // At a 36 ms render FLOOR, a 55 ms frame tipped over by 15 ms of roads work
    // is news about roads, not about render at its usual price.
    const floor = describeStutter({
        frameMs: 55, hooksMs: 1, renderMs: 36, stallMs: 17,
        outside: 'q:roads:15', renderBaselineMs: 36,
    });
    assert.equal(floor.cause, 'q:roads:15');

    // Before any window has completed there is no baseline; most-of-the-frame
    // stands in for it so a session's very first render spike still names itself.
    assert.equal(describeStutter({
        frameMs: 100, hooksMs: 1, renderMs: 90, stallMs: 9,
        outside: 'decor:trees:2', renderBaselineMs: 0,
    }).cause, 'render:90');
    // A named part BIGGER than the spiking render keeps the headline: it is the
    // larger cost whatever render is doing.
    assert.equal(describeStutter({
        frameMs: 300, hooksMs: 160, renderMs: 90, stallMs: 50,
        layers: 'rails:155', renderBaselineMs: 36,
    }).cause, 'rails:155');
});

test('a tiny named decor step does not headline a frame lost outside reported work', () => {
    const gap = describeStutter({
        frameMs: 333, hooksMs: 1, renderMs: 3, stallMs: 329,
        outside: 'decor:dalmatian:3', unclaimedStallMs: 326, longTaskMs: 0,
    });
    assert.equal(gap.cause, 'outside-loop');
    assert.equal(gap.alsoLayers, 'decor:dalmatian:3');

    const realDecor = describeStutter({
        frameMs: 748, hooksMs: 1, renderMs: 6, stallMs: 741,
        outside: 'decor:dalmatian:735', unclaimedStallMs: 5, longTaskMs: 0,
    });
    assert.equal(realDecor.cause, 'decor:dalmatian:735');
});

test('severity splits jitter from a hitch from a lurch', () => {
    assert.equal(stutterSeverity(40), 'minor');
    assert.equal(stutterSeverity(99), 'minor');
    assert.equal(stutterSeverity(100), 'major');
    assert.equal(stutterSeverity(249), 'major');
    assert.equal(stutterSeverity(250), 'severe');
});

test('hooks time that no layer claimed is surfaced, not hidden', () => {
    // This is the blind spot that hid a 507 ms synchronous rebuild: the layer did
    // not report, so its cost only ever showed up as a larger `hooks`.
    assert.equal(unattributedHooksMs(10, new Map([['cars', 2], ['terrain', 1]])), 7);
    assert.equal(unattributedHooksMs(10, { cars: 2, terrain: 1 }), 7);
    assert.equal(unattributedHooksMs(3, new Map()), 3, 'nothing instrumented means all of it is unattributed');
    // Layers may double-count nested work; a negative figure would read as an
    // overlay bug rather than a world bug.
    assert.equal(unattributedHooksMs(1, new Map([['a', 5]])), 0);
    assert.equal(unattributedHooksMs(Number.NaN, new Map()), 0);
});

test('queues with items too big for any budget are named', () => {
    // A budget only decides whether to START an item, so a 71.9 ms item is an
    // unbounded stall however small the slice is set. That is the signal for
    // cooperative staging, and it was in the snapshot unread.
    const hotspots = describeQueueHotspots([
        { label: 'curbs', longestItemMs: 71.9, over50msItems: 6 },
        { label: 'roads', longestItemMs: 27.4, over50msItems: 0 },
        { label: 'cars', longestItemMs: 0.6, over50msItems: 0 },
    ]);
    assert.deepEqual(hotspots.map(h => h.label), ['curbs', 'roads'], 'worst first, tiny items are not hotspots');
    assert.equal(hotspots[0].over50, 6);
    assert.deepEqual(describeQueueHotspots([]), []);
    assert.deepEqual(describeQueueHotspots(null), []);
});

test('starvation is judged over the window, not from one frame', () => {
    // The scheduler resets its per-frame spend every frame, so reading it on a
    // timer samples ONE arbitrary frame — and most frames run no queue work at
    // all. Judging starvation from that marked every class starved every second,
    // which trained the reader to ignore the signal entirely.
    const scheduler = {
        classBudgets: { near: 2, far: 1, delivery: 0.5 },
        // What a single sampled frame happened to show: nothing anywhere.
        spentByClass: { near: 0, far: 0, delivery: 0 },
        queues: [
            { label: 'buildings', workClass: 'near', pendingItems: 12 },
            { label: 'far-buildings', workClass: 'far', pendingItems: 3122 },
            { label: 'tiles', workClass: 'delivery', pendingItems: 4 },
        ],
    };
    // Over 60 frames, near and delivery DID get time; only far got none.
    const classes = describeWorkClasses(scheduler, {
        windowSpentByClass: { near: 74, far: 0, delivery: 18 },
        frames: 60,
    });
    const byName = Object.fromEntries(classes.map(c => [c.name, c]));
    assert.equal(byName.near.starved, false, 'near worked all window — not starved');
    assert.equal(byName.delivery.starved, false);
    assert.equal(byName.far.starved, true, 'a backlog of 3122 and not one ms IS starvation');
    assert.equal(byName.far.pending, 3122);
    // Budget is the per-frame allowance over the same span the spend covers,
    // or the comparison is meaningless.
    assert.equal(byName.near.budgetMs, 2 * 60);
    assert.equal(byName.near.spentMs, 74);

    // Without a window delta it falls back to the frame sample, and then a busy
    // class WOULD look starved — which is exactly the bug, so pin it.
    const sampled = describeWorkClasses(scheduler);
    assert.equal(sampled.find(c => c.name === 'near').starved, true,
        'the per-frame fallback is why the window delta exists');

    // An empty class is idle, not starved — nothing was waiting for it.
    const idle = describeWorkClasses(
        { classBudgets: { far: 1 }, queues: [] },
        { windowSpentByClass: { far: 0 }, frames: 60 },
    );
    assert.equal(idle[0].starved, false);
});

test('a background entry prints only the counters that are moving', () => {
    // The old form printed "0 retry / 0 build-failed" for every stream every
    // second, which buried the one number that was actually changing.
    const quiet = describeBackgroundEntry({
        label: 'roads', pending: 412, jobs: 12, loaded: 0, retrying: 0, buildFailed: 0,
    });
    const text = quiet.parts.map(p => p.text).join(' ');
    assert.match(text, /412 items/);
    assert.match(text, /12 jobs/);
    assert.ok(!/0 /.test(text), `no zero counters, got: ${text}`);

    const broken = describeBackgroundEntry({ label: 'tiles', pending: 3, retrying: 2, buildFailed: 1, fetchFailed: 4 });
    const failed = broken.parts.find(p => /failed/.test(p.text));
    assert.equal(failed.text, '5 failed', 'fetch and build failures are one number');
    assert.equal(failed.tone, 'severe');
    assert.equal(broken.parts.find(p => /retry/.test(p.text)).tone, 'warn');

    const diagnosed = describeBackgroundEntry({
        label: 'ground-generation-owner',
        pending: 9,
        failed: 4,
        lastFailure: { code: 'ground-topology-seam' },
    });
    assert.equal(
        diagnosed.parts.find(p => /failed/.test(p.text)).text,
        '4 failed (ground-topology-seam)',
        'a cumulative hard-failure count must retain the actionable failure code',
    );

    const publications = describeBackgroundEntry({
        label: 'surface publications',
        pending: 2,
        activeOwners: 14,
        staleRejected: 3,
        conflicts: 1,
        missingClaims: 2,
    });
    const publicationText = publications.parts.map(p => p.text).join(' ');
    assert.match(publicationText, /14 owners/);
    assert.match(publicationText, /3 stale rejected/);
    assert.equal(publications.parts.find(p => /owner conflicts/.test(p.text)).tone, 'severe');
    assert.equal(publications.parts.find(p => /missing claims/.test(p.text)).tone, 'severe');

    // A visible tile waiting seconds is a starved queue, not a busy one.
    const waiting = describeBackgroundEntry({ label: 'tiles', visible: 8, support: 2, peripheral: 1, oldestVisibleWaitMs: 5200 });
    assert.match(waiting.parts.map(p => p.text).join(' '), /view 10 \/ edge 1 \/ hidden 0/);
    assert.equal(waiting.parts.find(p => /oldest/.test(p.text)).tone, 'warn');
});

test('the live pane is built as coloured topic sections', () => {
    const sections = buildPerfSections({
        fps: 118, frameAvgMs: 8.4, skyMs: 0.07, hooksMs: 0.96, unnamedMs: 0.29,
        renderMs: 3.89, stallMs: 3.4, peakFrameMs: 9.4,
        gpuCalls: 316, gpuTriangles: 365000,
        gpuAttribution: {
            frames: 60,
            mainCalls: 210,
            shadowCalls: 102,
            unattributedCalls: 4,
            groups: [
                { name: 'OtherTrams', calls: 90, mainCalls: 45, shadowCalls: 45 },
                { name: 'Roads', calls: 70, mainCalls: 50, shadowCalls: 20 },
            ],
        },
        layers: [{ name: 'cars', avgMs: 1.85 }, { name: 'buildings', avgMs: 0.42 }],
        scheduler: {
            mode: 'adaptive', motionState: 'transit', speedMps: 19.3,
            spentTotalMs: 0, totalBudgetMs: 3.5,
            classBudgets: { near: 2, far: 1 },
            spentByClass: { near: 0, far: 0 },
            queues: [
                { label: 'curbs', workClass: 'near', pendingItems: 2, longestItemMs: 71.9, over50msItems: 6 },
                { label: 'far-buildings', workClass: 'far', pendingItems: 3122, longestItemMs: 1 },
            ],
        },
        background: [{ label: 'roads', pending: 412, jobs: 12 }],
        // A window's worth of spend: near worked, far got nothing.
        workSpentByClass: { near: 96, far: 0 },
        workFrames: 60,
    });
    assert.deepEqual(sections.map(s => s.id), ['frame', 'gpu', 'work', 'layers', 'queues']);
    // Each topic carries its own colour, which is the point of the restructure.
    assert.equal(new Set(sections.map(s => s.tone)).size, sections.length);

    assert.match(sectionText(sectionById(sections, 'frame')), /hooks 0\.96 \(unnamed 0\.29\)/);
    assert.match(sectionText(sectionById(sections, 'frame')), /stall 3\.40/);
    assert.match(sectionText(sectionById(sections, 'frame')), /peak 9\.4ms/);
    // dpr and megapixels are gone: fixed for a session, refreshed every second.
    assert.ok(!/dpr|MP/.test(sectionText(sectionById(sections, 'gpu'))));
    assert.match(sectionText(sectionById(sections, 'gpu')), /avg passes\s+colour 210\s+shadow 102\s+other 4/);
    assert.match(sectionText(sectionById(sections, 'gpu')), /OtherTrams 90 \(45c\/45s\)/);
    // The frame average is in the headline, not repeated as its own field.
    assert.ok(!/frame 8\.4/.test(sections.map(sectionText).join('\n')));

    const work = sectionText(sectionById(sections, 'work'));
    assert.match(work, /adaptive · transit · 19\.3m\/s/);
    assert.match(work, /over 60f/, 'the spend is stated over the window it covers');
    assert.match(work, /far 0\/60\(3122 waiting!\)/, 'the starved class says how big its backlog is');
    assert.match(work, /near 96\/120/, 'a class that worked is not flagged');
    assert.match(work, /fat items curbs 71\.9ms|fat items curbs 72ms/);
    assert.match(work, /×6>50/);

    assert.match(sectionText(sectionById(sections, 'layers')), /cars\s+1\.85ms/);
    assert.match(sectionText(sectionById(sections, 'queues')), /roads\s+412 items · 12 jobs/);
});

test('an idle world says so instead of printing an empty block', () => {
    const sections = buildPerfSections({ background: [] });
    assert.match(sectionText(sectionById(sections, 'queues')), /caught up/);
    // No scheduler and no layers means those sections are simply absent, rather
    // than a heading over nothing.
    assert.equal(sectionById(sections, 'work'), undefined);
    assert.equal(sectionById(sections, 'layers'), undefined);
});

test('GTA sessions expose bounded physics and traffic counts in the live pane', () => {
    const sections = buildPerfSections({
        gta: {
            physics: {
                fixedBodies: 240,
                trafficBodies: 12,
                promotedTrafficBodies: 8,
                kinematicTrafficBodies: 4,
                debris: 4,
                debrisPool: 9,
                vehicleHealth: 87,
                lastPhysicsStepMs: 0.8,
                maxPhysicsStepMs: 2.4,
                droppedPhysicsSeconds: 0.02,
                contactEventCount: 8,
                pendingFixedBuilds: 12,
                pendingFixedRetirements: 3,
                capacityHits: { fixed: 1, traffic: 2, debris: 0 },
            },
            traffic: {
                activeGraphSegments: 1234,
                movingCars: 80,
                parkedCars: 30,
                wreckedCars: 2,
            },
        },
    });
    const physics = sectionText(sectionById(sections, 'physics'));
    assert.match(physics, /fixed 240\s+traffic 12 \(8d\/4k\)\s+debris 4\s+pool 9\s+health 87%/);
    assert.match(physics, /graph 1234\s+cars 80\/30\/2/);
    assert.match(physics, /caps 1\/2\/0/);
});

test('every tone a section emits has a colour', () => {
    // A typo'd tone would silently render in the default grey, which is exactly
    // the failure this restructure is meant to prevent.
    const sections = buildPerfSections({
        fps: 20, hooksMs: 5, unnamedMs: 2, renderMs: 40, stallMs: 9, peakFrameMs: 900,
        gpuCalls: 12000, gpuTriangles: 4.2e6,
        layers: [{ name: 'cars', avgMs: 9 }],
        scheduler: {
            mode: 'adaptive', motionState: 'still', speedMps: 0,
            spentTotalMs: 3, totalBudgetMs: 3.5,
            classBudgets: { near: 2, far: 1 }, spentByClass: { near: 3, far: 0 },
            queues: [{ label: 'curbs', workClass: 'far', pendingItems: 9, longestItemMs: 60, over50msItems: 2 }],
        },
        background: [{ label: 'tiles', pending: 4, retrying: 1, failed: 2, visible: 3, oldestVisibleWaitMs: 9000 }],
    });
    for (const section of sections) {
        assert.ok(TONE_COLORS[section.tone], `section ${section.id} tone ${section.tone}`);
    }
    for (const segment of allSegments(sections)) {
        assert.ok(TONE_COLORS[segment.tone], `segment tone ${segment.tone} on "${segment.text}"`);
    }
    // And every severity the log can produce is a real colour too.
    for (const ms of [33, 120, 900]) assert.ok(TONE_COLORS[stutterSeverity(ms)]);
});

test('plain F mounts the perf overlays on localhost or with ?stats=1, never for a deployed player', () => {
    assert.equal(performanceOverlayKeyAllowed({ mounted: false, localHost: true, search: '' }), true);
    assert.equal(performanceOverlayKeyAllowed({ mounted: false, localHost: false, search: '?lang=hr&heading=105' }), false);
    assert.equal(performanceOverlayKeyAllowed({ mounted: false, localHost: false, search: '?stats=1' }), true);
    assert.equal(performanceOverlayKeyAllowed({ mounted: false, localHost: false, search: '?stats=0' }), false);
    // Already mounted (opted in earlier): F keeps toggling anywhere.
    assert.equal(performanceOverlayKeyAllowed({ mounted: true, localHost: false, search: '' }), true);
});
