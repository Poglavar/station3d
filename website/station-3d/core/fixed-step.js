export function createFixedStepAccumulator({
    stepSeconds = 1 / 60,
    maxSubsteps = 4,
    maxFrameSeconds = 0.25,
} = {}) {
    const step = Number(stepSeconds);
    const limit = Math.max(1, Math.trunc(Number(maxSubsteps) || 0));
    const maxFrame = Math.max(step, Number(maxFrameSeconds) || 0);
    if (!(step > 0)) throw new Error('fixed step must be positive');

    let accumulator = 0;
    let totalDiscardedSeconds = 0;
    let totalSteps = 0;

    return {
        advance(frameSeconds, runStep) {
            const frame = Math.max(0, Math.min(maxFrame, Number(frameSeconds) || 0));
            accumulator += frame;
            let steps = 0;
            while (accumulator >= step && steps < limit) {
                runStep(step);
                accumulator -= step;
                steps += 1;
                totalSteps += 1;
            }
            let discardedSeconds = 0;
            if (accumulator >= step) {
                discardedSeconds = accumulator - (accumulator % step);
                accumulator %= step;
                totalDiscardedSeconds += discardedSeconds;
            }
            return {
                steps,
                alpha: accumulator / step,
                discardedSeconds,
            };
        },
        reset() {
            accumulator = 0;
        },
        snapshot() {
            return { stepSeconds: step, maxSubsteps: limit, accumulator, totalSteps, totalDiscardedSeconds };
        },
    };
}
