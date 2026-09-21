// Scheduling and variation for the sporadic local-bird calls: which bird a
// location has, how long until the next call, and how a given call should
// sound. Pure functions of an injected random source, so the "sporadic, never
// the same twice" contract is testable headless.

// A call every few minutes. The first one arrives sooner — a visitor who
// opens the world and leaves after a minute should still have heard the city.
export const BIRD_CALL_FIRST_GAP_RANGE_S = Object.freeze([25, 80]);
export const BIRD_CALL_GAP_RANGE_S = Object.freeze([120, 340]);

// Intensity range. The square skews toward faint — most calls read as a bird
// somewhere across the roofs, the occasional one as a fly-past.
export const BIRD_CALL_GAIN_RANGE = Object.freeze([0.06, 0.38]);
export const BIRD_CALL_RATE_RANGE = Object.freeze([0.94, 1.08]);
export const BIRD_CALL_PAN_RANGE = Object.freeze([-0.8, 0.8]);

export function birdForLocation(location) {
    const bird = location && typeof location.localBird === 'string'
        ? location.localBird.trim()
        : '';
    return bird || null;
}

export function nextBirdCallDelayS(random = Math.random, { first = false } = {}) {
    const [min, max] = first ? BIRD_CALL_FIRST_GAP_RANGE_S : BIRD_CALL_GAP_RANGE_S;
    return min + (max - min) * random();
}

// One call's voice: which clip, how loud, how fast, and from which side.
// Squaring the gain draw makes distance the common case; the rate jitter keeps
// the same clip from sounding like the same bird.
export function birdCallVariant(random = Math.random, clipCount = 1) {
    const clips = Math.max(1, Math.floor(clipCount));
    const [gainMin, gainMax] = BIRD_CALL_GAIN_RANGE;
    const [rateMin, rateMax] = BIRD_CALL_RATE_RANGE;
    const [panMin, panMax] = BIRD_CALL_PAN_RANGE;
    const closeness = random() * random();   // 0..1, mass near 0 = far away
    return {
        clipIndex: Math.min(clips - 1, Math.floor(random() * clips)),
        gain: gainMin + (gainMax - gainMin) * closeness,
        playbackRate: rateMin + (rateMax - rateMin) * random(),
        pan: panMin + (panMax - panMin) * random(),
    };
}
