// Pure rolling-stock selection shared by rendering entry points and headless tests.

export const ROLLING_STOCK_TMK_2400 = 'tmk-2400';
export const ROLLING_STOCK_HZ_7022 = 'hz-7022';

const TRAM_TRACK_TYPES = new Set(['tram', 'light_rail', 'g1000']);
const HEAVY_RAIL_TRACK_TYPES = new Set(['rail', 'heavy_rail', 'g1435']);

export function selectRollingStock({ isTrainSession = false, trackType = '' } = {}) {
    const explicitTrackType = String(trackType || '').trim().toLowerCase();
    // The surrounding session describes the PLAYER vehicle, not every rail
    // vehicle in the world. A Zagreb tram centreline must keep tram rolling
    // stock even while an HŽ train is approaching in the same loaded scene.
    if (TRAM_TRACK_TYPES.has(explicitTrackType)) return ROLLING_STOCK_TMK_2400;
    if (HEAVY_RAIL_TRACK_TYPES.has(explicitTrackType)) return ROLLING_STOCK_HZ_7022;
    return isTrainSession ? ROLLING_STOCK_HZ_7022 : ROLLING_STOCK_TMK_2400;
}
