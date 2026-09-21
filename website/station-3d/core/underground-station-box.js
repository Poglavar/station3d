// How tall an underground station's box can be at the depth it was actually
// authored at.
//
// The station box is NOT the running tunnel. The tube is 7.3 m from rail to
// roof, which is what the 8 m tunnel-depth rule is sized for; a station adds a
// distribution mezzanine over the platform and stands 9.6 m. Building the full
// 9.6 m at tunnel depth pushed the roof slab up through the street — 1.67 m of
// it at a station authored 7.93 m down.
//
// So the box follows the depth instead of assuming one. A deep station gets the
// full hall with its mezzanine; a shallow one thins the mezzanine and then drops
// it, leaving the platform level that clears the train — which is how shallow
// metro stations are actually built, with the concourse moved to the ends. Below
// the train envelope nothing can be built and the caller is told.
//
// Pure: no THREE, no scene. The renderers read these heights; a test checks them.

// Rail to roof for the complete station: 6.2 m of platform hall clearing the
// train envelope and lighting zone, plus 3.4 m of enclosed mezzanine over it.
export const STATION_FULL_HALL_HEIGHT_M = 9.6;
// Height of the mezzanine DECK above the platform floor. Unchanged by depth —
// it is set by the train envelope beneath it, not by what is above.
export const STATION_MEZZANINE_DECK_Y_M = 6.2;
// A mezzanine you cannot walk through is not a mezzanine. Below this headroom
// the deck is dropped rather than squeezed.
export const STATION_MIN_MEZZANINE_HEADROOM_M = 2.1;
// The irreducible box: platform level with the roof slab directly over it.
export const STATION_MIN_HALL_HEIGHT_M = STATION_MEZZANINE_DECK_Y_M;
// Earth over the roof slab. Same 0.7 m the tunnel rule allows over the tube.
export const STATION_ROOF_COVER_M = 0.7;

/**
 * @param depthM  rail level below bare earth at the station (positive = down)
 * @returns {{
 *   hallHeightM: number,     rail to the underside of the roof slab
 *   hasMezzanine: boolean,
 *   mezzanineDeckY: number|null,
 *   mezzanineHeadroomM: number,
 *   tooShallow: boolean,     even the platform level will not fit
 *   shortfallM: number,      how much more depth a valid box needs (0 when fine)
 * }}
 */
export function planUndergroundStationBox(depthM) {
    const depth = Number(depthM);
    const usableM = Number.isFinite(depth) ? depth - STATION_ROOF_COVER_M : NaN;
    if (!Number.isFinite(usableM) || usableM < STATION_MIN_HALL_HEIGHT_M) {
        return {
            hallHeightM: STATION_MIN_HALL_HEIGHT_M,
            hasMezzanine: false,
            mezzanineDeckY: null,
            mezzanineHeadroomM: 0,
            tooShallow: true,
            shortfallM: Number.isFinite(usableM)
                ? Math.max(0, STATION_MIN_HALL_HEIGHT_M - usableM)
                : STATION_MIN_HALL_HEIGHT_M + STATION_ROOF_COVER_M,
        };
    }
    const hallHeightM = Math.min(STATION_FULL_HALL_HEIGHT_M, usableM);
    const headroomM = hallHeightM - STATION_MEZZANINE_DECK_Y_M;
    const hasMezzanine = headroomM >= STATION_MIN_MEZZANINE_HEADROOM_M;
    return {
        hallHeightM,
        hasMezzanine,
        mezzanineDeckY: hasMezzanine ? STATION_MEZZANINE_DECK_Y_M : null,
        mezzanineHeadroomM: hasMezzanine ? headroomM : 0,
        tooShallow: false,
        shortfallM: 0,
    };
}

// Depth at which a station gets its complete box. Useful for telling the author
// what the full structure would need, without forcing them to it.
export function fullStationBoxDepthM() {
    return STATION_FULL_HALL_HEIGHT_M + STATION_ROOF_COVER_M;
}
