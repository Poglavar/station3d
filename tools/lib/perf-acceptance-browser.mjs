// External, stats-off frame observer and native input controls shared by acceptance runs.
import { captureGroundDrainSample, buildingDrainState, groundDrainState } from './perf-world-drain.mjs';

export function acceptanceObserverSource(config) {
    return `(() => { ${captureGroundDrainSample}\n${buildingDrainState}\n${groundDrainState}\n(${installAcceptanceObserver})(${JSON.stringify(config)}); })();`;
}

function installAcceptanceObserver(config) {
    const capture = window.__station3dAcceptance = { errors: [], phases: {}, samples: [],
        active: null, ready: null, origin: null, origins: [], publications: [], lifecycle: [], held: [] };
    const now = () => performance.now();
    const error = (message, stack = null) => capture.errors.push({ at: now(), message: String(message).slice(0, 2000), stack });
    window.addEventListener('error', event => error(event.message, event.error?.stack || null));
    window.addEventListener('unhandledrejection', event => error(event.reason?.message || event.reason, event.reason?.stack || null));
    const originalError = console.error;
    console.error = (...args) => { error(args.map(String).join(' '), args.find(value => typeof value?.stack === 'string')?.stack || null); originalError(...args); };
    const tasks = [];
    new PerformanceObserver(list => { for (const item of list.getEntries()) tasks.push({ at: item.startTime, duration: item.duration }); })
        .observe({ type: 'longtask', buffered: true });
    const cab = () => window.__st3dDebug?.state?.cabState;
    const key = (value, pressed) => {
        if (capture.held.includes(value) === pressed) return;
        capture.held = pressed ? [...capture.held, value] : capture.held.filter(item => item !== value);
        window.dispatchEvent(new KeyboardEvent(pressed ? 'keydown' : 'keyup', {
            key: value, code: `Key${value.toUpperCase()}`, bubbles: true, repeat: false }));
    };
    function pause(paused) {
        if (config.mode !== 'rail' || !cab() || cab().simPaused === paused) return;
        key('p', true); key('p', false);
        if (cab().simPaused !== paused) throw new Error('Native pause control failed');
    }
    function sample() {
        const modal = document.getElementById('station3DModal');
        const renderer = window.__st3dDebug?.renderer;
        const context = window.Station3D?.getPerformanceContext?.();
        const drain = captureGroundDrainSample();
        return { at: now(), pose: window.Station3D?.getPose?.() || null,
            reason: modal?.dataset.worldBuildReason || null, blockers: modal?.dataset.worldBuildBlockers ?? null,
            controller: cab()?.controllerRouter?.activeId || null, paused: cab()?.simPaused,
            drain, drainState: groundDrainState(drain), visible: document.visibilityState === 'visible',
            render: renderer ? { dpr: renderer.getPixelRatio(), width: renderer.domElement.width,
                height: renderer.domElement.height, antialias: renderer.getContext().getContextAttributes().antialias,
                shadows: renderer.shadowMap.enabled, quality: context?.quality?.profileId || config.quality,
                terrainActive: context?.terrainActive, calls: renderer.info.render.calls,
                triangles: renderer.info.render.triangles, ...renderer.info.memory,
                programs: renderer.info.programs?.length ?? null } : null,
            heap: performance.memory ? { used: performance.memory.usedJSHeapSize,
                total: performance.memory.totalJSHeapSize } : null };
    }
    capture.sample = sample;
    const distance = (a, b) => Math.hypot((a.lat - b.lat) * 111320,
        (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180));
    let api, reopen = null;
    const railProviders = new WeakSet();
    const attach = value => {
        if (!value || value === api) return;
        api = value;
        for (const name of ['openWalk', 'openCab', 'openGta']) {
            const original = value[name];
            if (typeof original !== 'function') continue;
            const wrapped = (...args) => {
                const copied = [...args];
                if (name === 'openCab' && config.initialPose) {
                    const native = copied[2]; let first = true;
                    if (typeof native !== 'function' || railProviders.has(native)) {
                        throw new Error('Fresh rail controller required: pose callback was reused or is missing');
                    }
                    railProviders.add(native);
                    copied[2] = options => {
                        if (!first) return native(options);
                        first = false;
                        const pose = native({ ...(options || {}), paused: true });
                        const origin = { native: pose, fixed: { ...pose, ...config.initialPose } };
                        capture.origin ||= origin;
                        capture.origins.push(origin);
                        return origin.fixed;
                    };
                }
                reopen = () => wrapped(...args);
                return original.apply(value, copied);
            };
            value[name] = wrapped;
        }
    };
    let assigned = window.Station3D;
    Object.defineProperty(window, 'Station3D', { configurable: true, get: () => assigned,
        set: value => { assigned = value; attach(value); } });
    if (assigned) attach(assigned);
    capture.close = () => {
        for (const value of [...capture.held]) key(value, false);
        capture.active = null; capture.running = false;
        window.Station3D.close();
    };
    capture.reopen = () => {
        if (!reopen) throw new Error('No observed public open call to replay');
        capture.hold = true;
        if (typeof window.__station3dAcceptanceReopen === 'function') return window.__station3dAcceptanceReopen();
        if (config.mode === 'rail') throw new Error('Rail lifecycle requires a host callback that creates a fresh native controller');
        return reopen();
    };
    capture.hold = true;
    capture.start = (name, durationMs) => {
        if (capture.active) throw new Error('A phase is already active');
        const initial = sample();
        if (initial.reason !== 'ready' || initial.drainState !== 'drained') throw new Error('Phase needs a normally ready, fully drained world');
        if (config.mode === 'rail' && !initial.paused) throw new Error('Native rail controller was not held');
        const phase = { name, requestedMs: durationMs, startedAt: now(), wallStartedAt: Date.now(),
            initial, lastPose: initial.pose, distanceM: 0, frames: [], states: [], publications: [],
            route: initial.pose ? [{ distanceM: 0, lat: initial.pose.lat, lon: initial.pose.lon }] : [],
            publicationGaps: [],
            visible: true, turns: 0, backwards: false, done: false };
        capture.phases[name] = phase; capture.active = name; capture.running = true;
        lastPublication = initial.drain.publication?.generation ?? null;
        capture.previousFrame = null; capture.lastSample = phase.startedAt;
        if (name === 'movement') { capture.hold = false; pause(false); }
        return { at: phase.startedAt, wallAt: phase.wallStartedAt, initial };
    };
    capture.read = () => ({ errors: capture.errors, phases: capture.phases,
        samples: capture.samples, ready: capture.ready, origin: capture.origin, origins: capture.origins, current: sample(),
        longTasks: tasks, route: window.__perfPinnedTramRoute || null });
    let lastPoll = 0, lastPublication = null;
    function tick(timestamp) {
        if (capture.hold) pause(true);
        const phase = capture.active ? capture.phases[capture.active] : null;
        if (phase) {
            if (capture.previousFrame !== null) phase.frames.push({ at: timestamp, dt: timestamp - capture.previousFrame });
            capture.previousFrame = timestamp;
            phase.visible &&= document.visibilityState === 'visible';
            const pose = window.Station3D?.getPose?.();
            if (phase.name === 'movement' && pose && phase.lastPose) {
                phase.distanceM += distance(pose, phase.lastPose); phase.lastPose = pose;
                if (phase.distanceM - (phase.route.at(-1)?.distanceM ?? 0) >= 2) {
                    phase.route.push({ distanceM: phase.distanceM, lat: pose.lat, lon: pose.lon });
                }
                if (config.mode === 'walk') {
                    const theta = config.headingDeg * Math.PI / 180;
                    const north = (pose.lat - phase.initial.pose.lat) * 111320;
                    const east = (pose.lon - phase.initial.pose.lon) * 111320 * Math.cos(pose.lat * Math.PI / 180);
                    const along = north * Math.cos(theta) + east * Math.sin(theta);
                    if (!phase.backwards && along >= config.corridorM) { phase.backwards = true; phase.turns++; }
                    else if (phase.backwards && along <= 2) { phase.backwards = false; phase.turns++; }
                    key('w', !phase.backwards); key('s', phase.backwards);
                }
            }
        }
        if (timestamp - lastPoll >= 1000) {
            lastPoll = timestamp;
            const row = sample();
            if (!capture.ready && row.reason === 'ready') capture.ready = { at: timestamp, reason: row.reason, blockers: row.blockers };
            (phase ? phase.states : capture.samples).push(row);
            if (phase && row.drain.publication && row.drain.publication.generation !== lastPublication) {
                if (lastPublication !== null && row.drain.publication.generation > lastPublication + 1) {
                    phase.publicationGaps.push({ after: lastPublication, before: row.drain.publication.generation });
                }
                lastPublication = row.drain.publication.generation;
                phase.publications.push(row.drain.publication);
            }
        }
        if (phase && now() - phase.startedAt >= phase.requestedMs) {
            for (const value of [...capture.held]) key(value, false);
            capture.hold = true; pause(true);
            phase.durationMs = now() - phase.startedAt; phase.final = sample(); phase.done = true;
            if (phase.final.pose && phase.distanceM > (phase.route.at(-1)?.distanceM ?? -1)) {
                phase.route.push({ distanceM: phase.distanceM, lat: phase.final.pose.lat, lon: phase.final.pose.lon });
            }
            phase.finishedAt = now(); capture.active = null; capture.running = false;
        }
        requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
}
