// How hard a mesh that STATED an emissive burns after dark.
//
// Landmarks are drawn through the ordinary buildings path, so their windows and
// LED strips have to come on through the ordinary dusk switch — there is no
// landmark layer left to run its own. This is the part of that switch worth
// testing without a browser: given a stated material kind and whether it is
// night, how bright.
//
// The two levels come from the bespoke layer these models were authored
// against. LED strips tracing a setback read as light SOURCES and lit windows
// as rooms behind glass, so the strips must burn a good deal hotter to survive
// tone mapping — on Cibona the strips, not the offices, are what the tower is
// recognisable by at night.
export const NIGHT_STATED_EMISSIVE = 1.35;
export const NIGHT_STATED_EDGE_LIGHT_FACTOR = 3.2;

export function statedNightIntensity(kind, isNight) {
    if (!isNight) return 0;
    return kind === 'edgeLight'
        ? NIGHT_STATED_EMISSIVE * NIGHT_STATED_EDGE_LIGHT_FACTOR
        : NIGHT_STATED_EMISSIVE;
}
