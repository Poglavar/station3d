// Pure timetable-like motion for walk-mode project trains. Service state is
// independent of Three.js so line-end reversal, braking, and station dwell can
// be regression-tested without opening the 3D scene.

const POSITION_EPSILON_M = 0.05;
const STOP_MATCH_EPSILON_M = 0.75;
const MAX_INTEGRATION_STEP_S = 0.25;

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
function finitePositive(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeStops(stops, totalLengthM) {
    const clean = [];
    for (const stop of Array.isArray(stops) ? stops : []) {
        const rawPositionM = Number(stop?.positionM);
        if (!Number.isFinite(rawPositionM)) continue;
        const positionM = clamp(rawPositionM, 0, totalLengthM);
        const previous = clean[clean.length - 1];
        if (previous && Math.abs(previous.positionM - positionM) <= POSITION_EPSILON_M) {
            if (previous.stopId == null && stop?.stopId != null) {
                clean[clean.length - 1] = { ...stop, positionM };
            }
            continue;
        }
        clean.push({ ...stop, positionM });
    }
    clean.sort((a, b) => a.positionM - b.positionM);

    if (!clean.length || clean[0].positionM > STOP_MATCH_EPSILON_M) {
        clean.unshift({ stopId: null, name: '', positionM: 0, isTerminus: true });
    } else {
        clean[0] = { ...clean[0], positionM: 0, isTerminus: true };
    }
    const last = clean[clean.length - 1];
    if (totalLengthM - last.positionM > STOP_MATCH_EPSILON_M) {
        clean.push({
            stopId: null,
            name: '',
            positionM: totalLengthM,
            isTerminus: true,
        });
    } else {
        clean[clean.length - 1] = {
            ...last,
            positionM: totalLengthM,
            isTerminus: true,
        };
    }
    return clean;
}

function nextStopIndex(state) {
    if (state.direction > 0) {
        for (let index = 0; index < state.stops.length; index++) {
            if (state.stops[index].positionM > state.positionM + POSITION_EPSILON_M) {
                return index;
            }
        }
        return state.stops.length - 1;
    }
    for (let index = state.stops.length - 1; index >= 0; index--) {
        if (state.stops[index].positionM < state.positionM - POSITION_EPSILON_M) {
            return index;
        }
    }
    return 0;
}

function arriveAtStop(state, stopIndex, events) {
    const stop = state.stops[stopIndex];
    state.positionM = stop.positionM;
    state.speedMps = 0;
    state.phase = 'dwelling';
    state.dwellRemainingS = state.dwellSeconds;
    state.currentStopIndex = stopIndex;
    state.pendingDirection = stopIndex === 0
        ? 1
        : stopIndex === state.stops.length - 1
            ? -1
            : null;
    events.push({ type: 'arrive', stopIndex, stop });
}

export function createAmbientTrainServiceState({
    totalLengthM,
    stops = [],
    direction = 1,
    initialPositionM = null,
    initialSpeedMps = 0,
    initialDwellSeconds = 0,
    cruiseSpeedMps = 70 / 3.6,
    accelerationMps2 = 0.75,
    brakingMps2 = 1.05,
    dwellSeconds = 10,
} = {}) {
    const lengthM = finitePositive(totalLengthM, 1);
    const dir = direction < 0 ? -1 : 1;
    const defaultPositionM = dir > 0 ? 0 : lengthM;
    const dwellRemainingS = Math.max(0, Number(initialDwellSeconds) || 0);
    return {
        totalLengthM: lengthM,
        stops: normalizeStops(stops, lengthM),
        direction: dir,
        pendingDirection: null,
        positionM: clamp(
            Number.isFinite(Number(initialPositionM))
                ? Number(initialPositionM)
                : defaultPositionM,
            0,
            lengthM,
        ),
        speedMps: Math.max(0, Number(initialSpeedMps) || 0),
        cruiseSpeedMps: finitePositive(cruiseSpeedMps, 70 / 3.6),
        accelerationMps2: finitePositive(accelerationMps2, 0.75),
        brakingMps2: finitePositive(brakingMps2, 1.05),
        dwellSeconds: Math.max(0, Number(dwellSeconds) || 0),
        dwellRemainingS,
        phase: dwellRemainingS > 0 ? 'dwelling' : 'moving',
        currentStopIndex: null,
    };
}

export function stepAmbientTrainServiceState(state, dtSeconds) {
    const events = [];
    if (!state || !(state.totalLengthM > 0)) return events;
    let remainingS = Math.max(0, Number(dtSeconds) || 0);
    let iterations = 0;

    while (remainingS > 1e-6 && iterations++ < 128) {
        if (state.dwellRemainingS > 0) {
            const usedS = Math.min(remainingS, state.dwellRemainingS);
            state.dwellRemainingS = Math.max(0, state.dwellRemainingS - usedS);
            state.speedMps = 0;
            state.phase = 'dwelling';
            remainingS -= usedS;
            if (state.dwellRemainingS > 1e-6) break;
            if (Number.isFinite(state.pendingDirection)) {
                state.direction = state.pendingDirection;
                state.pendingDirection = null;
            }
            state.phase = 'moving';
            events.push({
                type: 'depart',
                stopIndex: state.currentStopIndex,
                stop: state.stops[state.currentStopIndex] || null,
            });
            state.currentStopIndex = null;
            continue;
        }

        const stopIndex = nextStopIndex(state);
        const stop = state.stops[stopIndex];
        const distanceM = Math.max(0, Math.abs(stop.positionM - state.positionM));
        if (distanceM <= POSITION_EPSILON_M) {
            arriveAtStop(state, stopIndex, events);
            continue;
        }

        const integrationS = Math.min(remainingS, MAX_INTEGRATION_STEP_S);
        const oldSpeedMps = Math.max(0, state.speedMps);
        const brakingLimitMps = Math.sqrt(2 * state.brakingMps2 * distanceM);
        const targetSpeedMps = Math.min(state.cruiseSpeedMps, brakingLimitMps);
        let nextSpeedMps;
        if (oldSpeedMps < targetSpeedMps) {
            nextSpeedMps = Math.min(
                targetSpeedMps,
                oldSpeedMps + state.accelerationMps2 * integrationS,
            );
        } else {
            nextSpeedMps = Math.max(
                targetSpeedMps,
                oldSpeedMps - state.brakingMps2 * integrationS,
            );
        }
        const travelM = Math.max(0, (oldSpeedMps + nextSpeedMps) * 0.5 * integrationS);
        if (travelM >= distanceM - POSITION_EPSILON_M) {
            const usedFraction = travelM > 1e-9
                ? clamp(distanceM / travelM, 0, 1)
                : 1;
            remainingS -= integrationS * usedFraction;
            arriveAtStop(state, stopIndex, events);
            continue;
        }

        state.positionM += state.direction * travelM;
        state.positionM = clamp(state.positionM, 0, state.totalLengthM);
        state.speedMps = nextSpeedMps;
        state.phase = targetSpeedMps < state.cruiseSpeedMps - 0.01
            ? 'braking'
            : oldSpeedMps < state.cruiseSpeedMps - 0.01
                ? 'accelerating'
                : 'cruising';
        remainingS -= integrationS;
    }

    return events;
}

// Visual door cycle derived from the authoritative dwell clock: open just
// after stopping, remain open through the dwell, then close before departure.
// Keeping this pure lets every ghost-train mesh use the same small animation.
export function ambientTrainDoorRatio(state, {
    transitionSeconds = 0.8,
    closeBeforeDepartureSeconds = 1.0,
} = {}) {
    if (!state || state.phase !== 'dwelling' || !(state.dwellRemainingS > 0)) return 0;
    const transition = Math.max(0.05, Number(transitionSeconds) || 0.8);
    const closeLead = Math.max(transition, Number(closeBeforeDepartureSeconds) || 1);
    const elapsed = Math.max(0, (Number(state.dwellSeconds) || 0) - state.dwellRemainingS);
    const opening = Math.min(1, elapsed / transition);
    const closing = state.dwellRemainingS >= closeLead
        ? 1
        : Math.max(0, state.dwellRemainingS / closeLead);
    return Math.min(opening, closing);
}
