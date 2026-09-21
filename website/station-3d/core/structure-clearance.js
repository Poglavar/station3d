// Whether a building the corridor hits in PLAN is actually standing in the way,
// or flying over it.
//
// The plan test cannot tell the two apart, and until now nothing asked: an open
// formation demolished whatever its footprint touched. That is right for a
// building on the ground and wrong for an overpass. Split airport's landside arm
// is the case that forced this — a 9 m wide deck reaching 44 m out of the
// terminal, mapped in OSM as `building` + `layer=1` with three `covered=yes`
// ways beneath it (including the D409). The alignment crosses it head-on, and
// because demolition is all-or-nothing per object, that 9 m strip took the whole
// 22,578 m² terminal with it. There is nowhere to move the line to either: the
// arm's tip is contiguous with the next two buildings, so every lateral offset
// just demolishes a different one.
//
// The discriminating fact is the SOFFIT: the lowest surveyed geometry the
// building has over the crossing. Where that stands clear of the ground, the
// building is a deck and the corridor runs underneath it.
//
// Pure: plain numbers in one vertical frame (scene-Y throughout, or ASL
// throughout — the caller picks, this only ever subtracts them). No THREE,
// no DOM.

// How far the soffit must stand above natural ground before we read the
// geometry as a deck rather than a building sitting on a plinth or a terrace.
// Below this there is no opening to drive through whatever the survey says.
export const MIN_STRUCTURE_OPENING_M = 2.5;

// Verdict for one (building, crossing point) pair.
//
//   { spared, reason, openingM, clearanceM, shortfallM }
//
// `spared` true means the corridor passes under the structure and the building
// must not be demolished. `shortfallM` is set when it passes under something too
// low for the railway: the building is still spared — a measurement we do have
// must not be turned into a demolition — but the shortfall is reported so the
// alignment can be lowered by exactly that much instead.
export function structureOverheadVerdict({
    soffitY = null,
    groundY = null,
    railY = null,
    clearanceNeededM,
    minOpeningM = MIN_STRUCTURE_OPENING_M,
} = {}) {
    const soffit = finite(soffitY);
    const ground = finite(groundY);
    const rail = finite(railY);
    const needed = finite(clearanceNeededM);

    // No surveyed base means no evidence of anything overhead — an Overture
    // footprint, a prism from a guessed height. Absence of evidence is not
    // evidence of a deck, so this stays exactly as it behaved before: the
    // plan hit decides, and the caller demolishes.
    if (soffit === null) return { spared: false, reason: 'no-soffit' };
    if (rail === null) return { spared: false, reason: 'no-rail' };

    // A soffit we can see over ground we cannot. The building may well be a
    // deck and we have no way to tell; a missing terrain sample must never
    // invent a demolition, which is the same call the tunnel-cover rule makes
    // one function over.
    if (ground === null) return { spared: true, reason: 'unknown-ground' };

    const openingM = soffit - ground;
    if (openingM < minOpeningM) {
        return { spared: false, reason: 'grounded', openingM };
    }

    const clearanceM = soffit - rail;
    // The rail is at or above the deck: it is not going under anything, it is
    // going through it — or riding on top of it.
    if (clearanceM <= 0) {
        return { spared: false, reason: 'rail-above-soffit', openingM, clearanceM };
    }
    if (needed === null || clearanceM >= needed) {
        return { spared: true, reason: 'clears', openingM, clearanceM };
    }
    return {
        spared: true,
        reason: 'short-clearance',
        openingM,
        clearanceM,
        shortfallM: needed - clearanceM,
    };
}

// Number(null) is 0, so a plain Number()+isFinite() pair turns a MISSING height
// into a real one at datum level — and every branch above is a decision about
// where geometry stands. An absent input has to stay absent.
function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
