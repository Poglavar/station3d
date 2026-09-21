// Chooses which planner corridor cuts may punch the generic ground mask for
// a location; wet locations keep at-grade rail on solid land above the sea.

export function plannerGroundMaskCuts(cuts, location) {
    const candidates = Array.isArray(cuts) ? cuts : [];
    if (!location?.water) return candidates;
    return candidates.filter((cut) => cut?.kind !== 'surface-track');
}
