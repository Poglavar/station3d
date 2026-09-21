// Pure observer-motion classification and frame-work budgets for Station 3D.
// Browser scheduling and queue mutation stay in frame-chunk-queue.js.

export const FRAME_WORK_CLASSES = Object.freeze([
    'delivery',
    'near',
    'simulation',
    'far',
    'orientation',
]);

export const MOTION_STATES = Object.freeze([
    'stationary',
    'slow',
    'transit',
    'fast',
]);

const MOTION_SMOOTHING_MS = 200;
const STATIONARY_CONFIRM_MS = 250;
const POSITION_EPSILON_M = 0.01;
const RESET_AFTER_MS = 1000;
const TELEPORT_DISTANCE_M = 250;

const MOTION_THRESHOLDS_MPS = Object.freeze({
    stationary: 0.5,
    slow: 8,
    transit: 35,
});

const ADAPTIVE_BUDGETS = Object.freeze({
    stationary: Object.freeze({
        delivery: 1,
        // A tram stop is still gameplay. Use the same near-world allowance
        // and headroom protection as walking; an idle camera may also fill
        // its horizon. The opaque loading hold has a separate budget below.
        near: 6,
        simulation: 0.5,
        far: 2,
        orientation: 0.5,
        frameCeilingMs: 25,
        minimumProgressMs: 0.5,
    }),
    slow: Object.freeze({
        delivery: 1,
        // A clean 20 km/h GTA trace accumulated ~200 road/curb items while
        // detailed tiles were still handing off. Use the measured moving-frame
        // headroom to keep the visible world ahead of ordinary city driving.
        near: 6,
        simulation: 0.5,
        far: 0,
        orientation: 0.5,
        frameCeilingMs: 25,
        minimumProgressMs: 0.5,
    }),
    transit: Object.freeze({
        delivery: 0.5,
        near: 4,
        simulation: 0.5,
        far: 0,
        orientation: 0.5,
        frameCeilingMs: 25,
        minimumProgressMs: 0.25,
    }),
    fast: Object.freeze({
        delivery: 0.5,
        // Fast motion needs MORE surface lead, not a construction blackout.
        // The old zero budget allowed just one near item every 250 ms, so the
        // car crossed analytic physics terrain while visible terrain/roads
        // waited for the player to stop. Keep a bounded continuous slice.
        near: 4,
        simulation: 0.25,
        far: 0,
        orientation: 0.5,
        frameCeilingMs: 25,
        minimumProgressMs: 2.5,
    }),
});

// Only the actual world-ready hold (opaque curtain + frozen simulation) may
// favour loading throughput over interactive latency. Speed is not that gate.
// An offline compile — the campaign pack bake — has no frame to protect: the
// player is a script, the camera is parked, and the only goal is to drain
// every queue so the world reaches its fixed point. Budgets here would be
// absurd for play; they are the point of the mode. Bounded all the same, so a
// cooperative item that misbehaves still yields to the event loop.
// Every class, derived from the list: a class left out here is a queue that
// never runs, and a delivery that never runs holds its network slot — which is
// how a bake once starved every remaining fetch behind four orientation tiles.
const OFFLINE_COMPILE_BUDGET = Object.freeze({
    ...Object.fromEntries(FRAME_WORK_CLASSES.map(workClass => [workClass, 250])),
    frameCeilingMs: 800,
    minimumProgressMs: 400,
});

const LOADING_BUDGET = Object.freeze({
    // The opaque curtain freezes the controller. Spend longer on construction
    // here, while returning to the event loop regularly for downloads, Worker
    // replies and progress UI. Offline capture's 400+ ms slices starve those.
    delivery: 4,
    near: 48,
    simulation: 0.5,
    far: 6,
    orientation: 0.5,
    frameCeilingMs: 100,
    minimumProgressMs: 40,
});

function finite(value, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

function classifySpeed(speedMps) {
    const speed = Math.max(0, finite(speedMps));
    if (speed < MOTION_THRESHOLDS_MPS.stationary) return 'stationary';
    if (speed < MOTION_THRESHOLDS_MPS.slow) return 'slow';
    if (speed < MOTION_THRESHOLDS_MPS.transit) return 'transit';
    return 'fast';
}

export function resolveFrameWorkSchedulerMode(search = globalThis.location?.search || '') {
    const value = new URLSearchParams(search).get('streamScheduler');
    return value === 'legacy' ? 'legacy' : 'adaptive';
}

export function adaptiveFrameWorkBudget({
    motionState = 'stationary',
    previousFrameMs = 0,
    sceneWorkMs = null,
    viewMoving = false,
    loading = false,
    offlineCompile = false,
} = {}) {
    const throughput = offlineCompile === true;
    const translationState = MOTION_STATES.includes(motionState) ? motionState : 'stationary';
    // A turn exposes new scenery without translating the observer. Keep the
    // active budget until the view settles; horizon filling should yield to
    // a player exposing new near scenery with an interactive camera pan.
    const state = throughput ? 'stationary'
        : translationState === 'stationary' && viewMoving ? 'slow' : translationState;
    const configured = throughput ? OFFLINE_COMPILE_BUDGET
        : loading ? LOADING_BUDGET : ADAPTIVE_BUDGETS[state];
    const classBudgets = {};
    let configuredTotalMs = 0;
    for (const workClass of FRAME_WORK_CLASSES) {
        const value = Math.max(0, finite(configured[workClass]));
        classBudgets[workClass] = value;
        configuredTotalMs += value;
    }
    // A frame interval includes display/GPU waiting, not just occupied main
    // thread time. Subtract measured scene work when available: a 30/40 Hz
    // display must not reduce every compiler to its starvation allowance.
    // Queue work is charged separately by the scheduler. Until the render
    // loop supplies a valid sample, retain the conservative interval estimate.
    const occupiedMs = typeof sceneWorkMs === 'number' && Number.isFinite(sceneWorkMs)
        && sceneWorkMs >= 0 ? sceneWorkMs : Math.max(0, finite(previousFrameMs));
    const headroomMs = Math.max(
        configured.minimumProgressMs,
        configured.frameCeilingMs - occupiedMs,
    );
    return {
        phase: throughput ? 'throughput' : loading ? 'loading' : 'interactive',
        motionState: state,
        classBudgets,
        configuredTotalMs,
        totalBudgetMs: Math.min(configuredTotalMs, headroomMs),
        frameCeilingMs: configured.frameCeilingMs,
    };
}

export function createObserverMotionTracker({
    now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
} = {}) {
    let x = Number.NaN;
    let z = Number.NaN;
    let sampledAtMs = Number.NaN;
    let lastPositionChangeMs = Number.NaN;
    let speedMps = 0;
    let state = 'stationary';
    let previousFrameMs = 0;

    function reset() {
        x = Number.NaN;
        z = Number.NaN;
        sampledAtMs = Number.NaN;
        lastPositionChangeMs = Number.NaN;
        speedMps = 0;
        state = 'stationary';
        previousFrameMs = 0;
    }

    function snapshot() {
        return {
            x,
            z,
            sampledAtMs,
            speedMps,
            state,
            previousFrameMs,
        };
    }

    function motionState() {
        return state;
    }

    function note(nextX, nextZ, { atMs = now() } = {}) {
        const safeX = Number(nextX);
        const safeZ = Number(nextZ);
        const safeAtMs = Number(atMs);
        if (!Number.isFinite(safeX)
            || !Number.isFinite(safeZ)
            || !Number.isFinite(safeAtMs)) {
            reset();
            return snapshot();
        }
        if (!Number.isFinite(x)
            || !Number.isFinite(z)
            || !Number.isFinite(sampledAtMs)) {
            x = safeX;
            z = safeZ;
            sampledAtMs = safeAtMs;
            lastPositionChangeMs = safeAtMs;
            return snapshot();
        }

        const elapsedMs = safeAtMs - sampledAtMs;
        const distanceM = Math.hypot(safeX - x, safeZ - z);
        if (elapsedMs <= 0 || elapsedMs > RESET_AFTER_MS || distanceM > TELEPORT_DISTANCE_M) {
            x = safeX;
            z = safeZ;
            sampledAtMs = safeAtMs;
            lastPositionChangeMs = safeAtMs;
            speedMps = 0;
            state = 'stationary';
            previousFrameMs = Math.max(0, elapsedMs);
            return snapshot();
        }

        previousFrameMs = elapsedMs;
        const instantaneousMps = distanceM * 1000 / elapsedMs;
        const alpha = 1 - Math.exp(-elapsedMs / MOTION_SMOOTHING_MS);
        speedMps += (instantaneousMps - speedMps) * alpha;
        if (distanceM >= POSITION_EPSILON_M) {
            lastPositionChangeMs = safeAtMs;
        } else if (safeAtMs - lastPositionChangeMs >= STATIONARY_CONFIRM_MS) {
            speedMps = 0;
        }
        state = classifySpeed(speedMps);
        x = safeX;
        z = safeZ;
        sampledAtMs = safeAtMs;
        return snapshot();
    }

    return {
        note,
        reset,
        snapshot,
        motionState,
    };
}
