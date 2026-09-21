// Instrument values for the arcade light aircraft: height above the ground it
// is actually over, climb/descent rate and engine power. Pure and DOM-free so
// the display rules are unit-testable headless; ui/hud.js only prints them.
//
// The rail gauges (chainage, grade) are meaningless in the air and are not
// produced here — a flown aircraft has no chainage and its "grade" is its pitch,
// which the vertical speed already says more usefully.

function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function aircraftInstruments({
    sceneY = null,
    groundSceneY = null,
    verticalSpeedMps = null,
    throttle = null,
    throttleLocked = false,
    grounded = false,
    engineFailed = false,
} = {}) {
    const y = finite(sceneY);
    const ground = finite(groundSceneY);
    const throttleFraction = finite(throttle);
    return {
        // Never clamped at zero: an aircraft reading below its own ground is a
        // bug worth seeing rather than one worth hiding.
        aglM: y === null || ground === null ? null : y - ground,
        verticalSpeedMps: grounded ? 0 : finite(verticalSpeedMps),
        throttlePercent: throttleFraction === null
            ? null
            : Math.round(Math.max(0, Math.min(1, throttleFraction)) * 100),
        powerHeld: !!throttleLocked && !engineFailed,
        grounded: !!grounded,
        engineFailed: !!engineFailed,
    };
}

export function formatAircraftAgl(aglM) {
    const value = finite(aglM);
    if (value === null) return '';
    // Metres, no decimal: this is a "am I about to hit the ground" gauge, and a
    // tenth of a metre flickering at 300 km/h is noise.
    return `AGL ${Math.round(value)} m`;
}

export function formatAircraftVerticalSpeed(verticalSpeedMps) {
    const value = finite(verticalSpeedMps);
    if (value === null) return '';
    const shown = Math.abs(value) < 0.05 ? 0 : value;
    const arrow = shown > 0 ? '↑' : shown < 0 ? '↓' : '→';
    return `${arrow} ${Math.abs(shown).toFixed(1)} m/s`;
}

export function formatAircraftThrottle(throttlePercent, powerHeld = false, engineFailed = false) {
    // A dead engine replaces the power gauge outright: a throttle percentage
    // that no longer does anything is the reading most likely to be misread.
    if (engineFailed) return 'ENGINE OUT';
    const value = finite(throttlePercent);
    if (value === null) return '';
    // The lock marker matters: Q holds the current power after Space is
    // released, and without a marker a held throttle is indistinguishable from
    // a stuck one.
    return `THR ${Math.round(value)}%${powerHeld ? ' 🔒' : ''}`;
}

export function formatAircraftInstruments(instruments) {
    if (!instruments) return null;
    return {
        agl: formatAircraftAgl(instruments.aglM),
        vertical: formatAircraftVerticalSpeed(instruments.verticalSpeedMps),
        throttle: formatAircraftThrottle(
            instruments.throttlePercent,
            instruments.powerHeld,
            instruments.engineFailed,
        ),
    };
}
