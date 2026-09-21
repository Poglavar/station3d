// Maps GTA vehicle speed/load state to engine RPM, gear, synthesis parameters,
// and an equal-power blend across the recorded RPM-loop bank.

const FORWARD_GEAR_MAX_KMH = Object.freeze([28, 52, 82, 118, 170]);
const IDLE_RPM = 850;
const GEAR_MIN_RPM = 1450;
const GEAR_MAX_RPM = 4400;
const REDLINE_RPM = 5200;

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, Number(value) || 0));
}

export function gtaEngineGear(speedKmh, reverse = false) {
    if (reverse) return -1;
    const speed = Math.abs(Number(speedKmh) || 0);
    const index = FORWARD_GEAR_MAX_KMH.findIndex(max => speed < max);
    return (index < 0 ? FORWARD_GEAR_MAX_KMH.length - 1 : index) + 1;
}

export function gtaEngineSampleMix(rpm, sampleCount = 6) {
    const count = Math.max(1, Math.trunc(Number(sampleCount) || 1));
    const normalizedRpm = clamp(
        (clamp(rpm, IDLE_RPM, REDLINE_RPM) - IDLE_RPM) / (REDLINE_RPM - IDLE_RPM),
        0,
        1,
    );
    const position = normalizedRpm * (count - 1);
    const lowerIndex = Math.floor(position);
    const upperIndex = Math.min(count - 1, lowerIndex + 1);
    const blend = position - lowerIndex;
    const gains = new Array(count).fill(0);
    // Equal-power crossfade: adjacent recordings overlap without losing body
    // halfway between layers or becoming louder than either endpoint.
    gains[lowerIndex] = Math.cos(blend * Math.PI * 0.5);
    gains[upperIndex] = Math.max(
        gains[upperIndex],
        Math.sin(blend * Math.PI * 0.5),
    );
    return {
        normalizedRpm,
        gains,
        // The CC0 bank itself climbs from roughly 43 to 76 Hz. This modest
        // per-bank rate sweep extends it to the full idle-to-redline range.
        playbackRate: 0.68 + normalizedRpm * 1.42,
    };
}

export function gtaEngineAudioTargets({
    speedMps = 0,
    throttle = false,
    reverse = false,
    braking = false,
    health = 100,
} = {}) {
    const speedKmh = clamp(Math.abs(speedMps) * 3.6, 0, 190);
    const gear = gtaEngineGear(speedKmh, reverse);
    let rpm;
    if (reverse) {
        const fraction = clamp(speedKmh / 34, 0, 1);
        rpm = GEAR_MIN_RPM + fraction * (GEAR_MAX_RPM - GEAR_MIN_RPM);
    } else {
        const gearIndex = Math.max(0, gear - 1);
        const lower = gearIndex === 0 ? 0 : FORWARD_GEAR_MAX_KMH[gearIndex - 1];
        const upper = FORWARD_GEAR_MAX_KMH[gearIndex];
        const fraction = clamp((speedKmh - lower) / Math.max(1, upper - lower), 0, 1);
        rpm = GEAR_MIN_RPM + fraction * (GEAR_MAX_RPM - GEAR_MIN_RPM);
    }
    if (speedKmh < 2) rpm = throttle ? 2250 : IDLE_RPM;
    else if (throttle) rpm += 350;
    else rpm -= 220;
    if (braking && !throttle) rpm -= 180;
    rpm = clamp(rpm, IDLE_RPM, REDLINE_RPM);

    const normalizedHealth = clamp(health / 100, 0, 1);
    const load = throttle ? 1 : braking ? 0.22 : speedKmh > 2 ? 0.38 : 0.18;
    return {
        gear,
        rpm,
        // Four-cylinder four-stroke: two firing events per crank revolution.
        firingHz: rpm / 30,
        masterGain: (0.018 + load * 0.042) * (0.78 + normalizedHealth * 0.22),
        intakeGain: 0.0025 + load * 0.012 + (1 - normalizedHealth) * 0.004,
        filterHz: clamp(430 + rpm * 0.52 + load * 320, 500, 3800),
        detuneCents: normalizedHealth >= 1 ? 0 : -(1 - normalizedHealth) * 22,
    };
}
