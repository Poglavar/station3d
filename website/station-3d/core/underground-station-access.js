// Vertical layout for an underground station's street access: how many flights
// of stairs, how long, and where the landings fall, for ANY depth.
//
// The geometry this replaces ran one flight over a FIXED along-track run from
// the mezzanine to the street. That is fine at exactly one depth — the flat
// world's level −1, where 3.9 m of rise over 7.7 m of run is a normal 1:2 stair
// — and nonsense at every other. An authored ASL station 20 m down climbed
// 13.9 m over the same 7.7 m: a 61° ladder with 0.55 m treads, which is what
// made a deep station look wrong however it was placed.
//
// Here the RUN follows the rise at a fixed, buildable pitch, and the climb is
// broken by landings so no single flight is longer than a public building would
// allow. A deeper station simply gets a longer inclined shaft, which is what a
// deep station actually has.
//
// Pure: no THREE, no DOM. The renderer turns these numbers into boxes, and a
// test (or a standalone viewer) can check the layout without a scene.

// A public-building stair: 0.17 m riser on a 0.30 m tread is ~29.5°, the pitch
// used throughout metro concourses. Keeping riser and tread explicit means the
// step count and the run stay consistent with each other by construction.
export const ACCESS_STAIR_RISER_M = 0.17;
export const ACCESS_STAIR_TREAD_M = 0.30;
// Rise between landings. Codes commonly cap a flight at ~3 m of rise (about 18
// risers); 2.6 m keeps flights short enough that a deep shaft reads as a real
// stair rather than one impossible ramp.
export const ACCESS_MAX_FLIGHT_RISE_M = 2.6;
export const ACCESS_LANDING_DEPTH_M = 1.4;
// Below this there is nothing to climb — the mezzanine is essentially at street
// level and a "stair" would be a lip.
const MIN_MEANINGFUL_RISE_M = 0.35;

// How much horizontal run a given rise needs at the stair's pitch.
export function accessStairRunForRiseM(riseM) {
    const rise = Math.max(0, Number(riseM) || 0);
    return (rise / ACCESS_STAIR_RISER_M) * ACCESS_STAIR_TREAD_M;
}

// Steps in a flight, never fewer than one, so a stub flight still has a tread.
export function accessStairStepCount(riseM) {
    return Math.max(1, Math.round(Math.max(0, Number(riseM) || 0) / ACCESS_STAIR_RISER_M));
}

/**
 * Lay out the climb from `fromY` up to `toY`, starting at `startAlongM` and
 * running in `direction` (+1 / -1) along the track axis.
 *
 * Returns segments in climb order. Each is either a flight (sloped, with a step
 * count) or a landing (level). `totalRunM` is the along-axis distance consumed,
 * and `topAlongM` where the street entrance lands — the shaft, well and
 * entrance head all size themselves from those instead of a fixed constant.
 */
export function planUndergroundAccessStairs(fromY, toY, {
    startAlongM = 0,
    direction = 1,
    maxFlightRiseM = ACCESS_MAX_FLIGHT_RISE_M,
    landingDepthM = ACCESS_LANDING_DEPTH_M,
} = {}) {
    const bottomY = Number(fromY);
    const topY = Number(toY);
    const start = Number(startAlongM) || 0;
    const sign = direction < 0 ? -1 : 1;
    const empty = {
        segments: [], flights: [], landings: [],
        totalRunM: 0, topAlongM: start, totalRiseM: 0, flightCount: 0,
    };
    if (!Number.isFinite(bottomY) || !Number.isFinite(topY)) return empty;
    const totalRiseM = topY - bottomY;
    if (!(totalRiseM > MIN_MEANINGFUL_RISE_M)) return { ...empty, totalRiseM };

    const capM = Math.max(0.5, Number(maxFlightRiseM) || ACCESS_MAX_FLIGHT_RISE_M);
    // Equal flights rather than a full-height run plus a stub: a 6 cm last
    // flight would render as a single floating tread at the top of the shaft.
    const flightCount = Math.max(1, Math.ceil(totalRiseM / capM));
    const flightRiseM = totalRiseM / flightCount;
    const flightRunM = accessStairRunForRiseM(flightRiseM);
    const landingM = Math.max(0, Number(landingDepthM) || 0);

    const segments = [];
    let alongM = start;
    let y = bottomY;
    for (let index = 0; index < flightCount; index++) {
        const toAlongM = alongM + sign * flightRunM;
        // The last flight lands exactly on `toY`; accumulating flightRiseM
        // would drift by a float epsilon and leave the top tread off the street.
        const flightTopY = index === flightCount - 1 ? topY : y + flightRiseM;
        segments.push({
            kind: 'flight',
            fromAlongM: alongM,
            toAlongM,
            fromY: y,
            toY: flightTopY,
            stepCount: accessStairStepCount(flightTopY - y),
        });
        alongM = toAlongM;
        y = flightTopY;
        // Landings BETWEEN flights only — the street entrance is the top, and a
        // landing there would push the head of the stair past its own well.
        if (index < flightCount - 1 && landingM > 0) {
            const landingToM = alongM + sign * landingM;
            segments.push({
                kind: 'landing',
                fromAlongM: alongM,
                toAlongM: landingToM,
                fromY: y,
                toY: y,
            });
            alongM = landingToM;
        }
    }

    return {
        segments,
        flights: segments.filter((s) => s.kind === 'flight'),
        landings: segments.filter((s) => s.kind === 'landing'),
        totalRunM: Math.abs(alongM - start),
        topAlongM: alongM,
        totalRiseM,
        flightCount,
    };
}
