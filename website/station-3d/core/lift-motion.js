// Pure timing and interpolation model for a two-stop passenger lift.

const OPEN_S = 1;
const BOARD_S = 1.5;
const CLOSE_S = 1;
const MIN_TRAVEL_S = 2;
const EXIT_S = 1.5;

const clamp01 = value => Math.max(0, Math.min(1, value));
const smoothstep = value => {
    const t = clamp01(value);
    return t * t * (3 - 2 * t);
};

export function createLiftMotion({ fromY, toY, speedMps = 7 } = {}) {
    if (![fromY, toY, speedMps].every(Number.isFinite)) {
        throw new TypeError('lift heights and speed must be finite');
    }
    if (speedMps <= 0) throw new RangeError('lift speed must be positive');
    const travelS = Math.max(MIN_TRAVEL_S, Math.abs(toY - fromY) / speedMps * 1.5);
    return Object.freeze({
        fromY,
        toY,
        speedMps,
        travelS,
        durationS: OPEN_S + BOARD_S + CLOSE_S + travelS + OPEN_S + EXIT_S,
    });
}

export function sampleLiftMotion(motion, elapsedS = 0) {
    if (!motion || ![motion.fromY, motion.toY, motion.travelS, motion.durationS].every(Number.isFinite)) {
        throw new TypeError('invalid lift motion');
    }
    const t = Math.max(0, Number.isFinite(elapsedS) ? elapsedS : 0);
    const travelStart = OPEN_S + BOARD_S + CLOSE_S;
    const arrivalStart = travelStart + motion.travelS;
    const exitStart = arrivalStart + OPEN_S;
    if (t >= motion.durationS) {
        return { phase: 'done', floorY: motion.toY, doorOpen: 1, passengerT: 0, done: true };
    }
    if (t < OPEN_S) return { phase: 'opening', floorY: motion.fromY, doorOpen: t / OPEN_S, passengerT: 0, done: false };
    if (t < travelStart - CLOSE_S) return { phase: 'boarding', floorY: motion.fromY, doorOpen: 1, passengerT: (t - OPEN_S) / BOARD_S, done: false };
    if (t < travelStart) return { phase: 'closing', floorY: motion.fromY, doorOpen: 1 - (t - (OPEN_S + BOARD_S)) / CLOSE_S, passengerT: 1, done: false };
    if (t < arrivalStart) return { phase: 'traveling', floorY: motion.fromY + (motion.toY - motion.fromY) * smoothstep((t - travelStart) / motion.travelS), doorOpen: 0, passengerT: 1, done: false };
    if (t < exitStart) return { phase: 'arrival-opening', floorY: motion.toY, doorOpen: (t - arrivalStart) / OPEN_S, passengerT: 1, done: false };
    return { phase: 'exiting', floorY: motion.toY, doorOpen: 1, passengerT: 1 - (t - exitStart) / EXIT_S, done: false };
}
