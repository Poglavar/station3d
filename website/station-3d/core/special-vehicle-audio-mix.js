// How a player-driven boat's or aircraft's pose becomes its recorded-loop mix:
// engine gain and playback rate, plus the boat's wake. Pure — no DOM, no
// WebAudio; ui/gta-special-vehicle-audio.js applies these to the live nodes and
// owns the engine-failure cue.
//
// Levels are calibrated against the car, whose recorded engine loops play at up
// to ~0.92 (ui/gta-engine-audio.js). The boat's diesel used to peak at 0.175 —
// roughly a fifth of the car — which read as silence next to every other
// vehicle, so it now idles audibly and reaches ~0.62 flat out: clearly present,
// still under the car and under the compressor's -22 dB threshold. The wake was
// lifted with it so it does not disappear beneath the louder engine, but stays
// below the engine at every pose.

const BOAT_SPEED_REFERENCE_MPS = 18;
const AIRPLANE_SPEED_REFERENCE_MPS = 92;

const BOAT_MIX = Object.freeze({
    engineIdleGain: 0.115,
    engineThrottleGain: 0.36,
    engineSpeedGain: 0.14,
    engineBaseRate: 0.82,
    engineThrottleRate: 0.28,
    engineSpeedRate: 0.12,
    // 0.24 stays under the quietest moving-boat engine level (coasting at full
    // speed with the throttle shut: 0.115 + 0.14 = 0.255).
    wakeGain: 0.24,
    wakeExponent: 1.35,
    wakeBaseRate: 0.86,
    wakeSpeedRate: 0.32,
});

const AIRPLANE_MIX = Object.freeze({
    engineIdleGain: 0.035,
    engineThrottleGain: 0.15,
    engineSpeedGain: 0.035,
    engineBaseRate: 0.82,
    engineThrottleRate: 0.42,
    engineSpeedRate: 0.12,
});

function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

export function specialVehicleSpeedRatio(kind, speedMps) {
    const speed = Math.abs(Number(speedMps) || 0);
    return clamp01(speed / (kind === 'airplane' ? AIRPLANE_SPEED_REFERENCE_MPS : BOAT_SPEED_REFERENCE_MPS));
}

// `kind` is 'airplane' or 'boat'; anything else is treated as a boat, matching
// the audio session's own normalization. The aircraft has no wake voice, so its
// wake gain is zero.
export function specialVehicleAudioMix({ kind, speedMps, throttle } = {}) {
    const normalizedKind = kind === 'airplane' ? 'airplane' : 'boat';
    const speedRatio = specialVehicleSpeedRatio(normalizedKind, speedMps);
    const throttleRatio = clamp01(throttle);
    if (normalizedKind === 'airplane') {
        const mix = AIRPLANE_MIX;
        return {
            kind: normalizedKind,
            speedRatio,
            engineGain: mix.engineIdleGain + throttleRatio * mix.engineThrottleGain + speedRatio * mix.engineSpeedGain,
            engineRate: mix.engineBaseRate + throttleRatio * mix.engineThrottleRate + speedRatio * mix.engineSpeedRate,
            wakeGain: 0,
            wakeRate: 1,
        };
    }
    const mix = BOAT_MIX;
    return {
        kind: normalizedKind,
        speedRatio,
        engineGain: mix.engineIdleGain + throttleRatio * mix.engineThrottleGain + speedRatio * mix.engineSpeedGain,
        engineRate: mix.engineBaseRate + throttleRatio * mix.engineThrottleRate + speedRatio * mix.engineSpeedRate,
        wakeGain: Math.pow(speedRatio, mix.wakeExponent) * mix.wakeGain,
        wakeRate: mix.wakeBaseRate + speedRatio * mix.wakeSpeedRate,
    };
}
