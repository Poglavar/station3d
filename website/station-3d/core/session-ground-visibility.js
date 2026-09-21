// The sliding catch-all plane belongs only to sessions that have no complete
// ground owner of their own. Underground rooms and immutable campaign packs
// both provide their visible floor, so leaving the plane enabled creates a
// second surface at scene y=0 that can cut through players and actors.

// An open-sea set piece (the Adriatic crossing, 20 km offshore) has no water
// polygons to retire the plane into; without this the lit grey concrete stood
// 1.6 m above the sea datum and showed as a hard band on the night horizon.
// An authored aerial scene (the Vis arrival) draws its own far terrain and sea
// out to the horizon; the sliding concrete plane would show through both.
export function shouldHideCatchAllGround({
    isUndergroundSession = false,
    campaignWorldPack = null,
    openSea = false,
    aerialView = false,
} = {}) {
    return !!isUndergroundSession || !!campaignWorldPack || openSea === true || aerialView === true;
}
