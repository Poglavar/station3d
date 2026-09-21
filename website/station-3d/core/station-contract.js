// What a station is, as a thing the rest of the world plugs into.
//
// Today a station has no owner. Its dimensions are shared constants read by nine
// separate modules — the planner, the grade strip, the rails, the walk physics,
// the surface cutouts, two geometry builders — and each one improvises its own
// idea of the station's shape from them. Every bug we hit came from two of those
// improvisations disagreeing:
//
//   • walk physics looked for a floor within the RUNNING TUNNEL's 3.9 m half
//     width, but the platform spawn stands 6.6 m out because the tracks flare
//     around the island. So the walker found no floor at the one point they are
//     always placed, and was lifted to the street.
//   • the hall was built 9.6 m tall at a depth the tunnel rule only guarantees
//     8 m for, so the roof came up through the road.
//   • the hall was seated at one height and its own street entrances at another,
//     so the exits sank into the ground.
//
// None of those are possible against a contract. A station declares what it
// occupies, what it needs from the route, and — the point of the whole exercise
// — that the tunnel meets it UNCHANGED at its ports. Tunnels stay tunnels; the
// widening for an island platform happens inside the station's own envelope,
// because that is the station's business.
//
// This module is deliberately pure: no THREE, no scene, no DOM. It is the
// description. Renderers, physics and the planner read it; a test can check it;
// a standalone viewer can instantiate a station with no world at all.

// ─── Types ──────────────────────────────────────────────────────────────────
// Each entry is one buildable kind of station. Adding a type — a shallow
// cut-and-cover box, a side-platform station, a terminus — means adding a row
// here and nothing else: every consumer reads the description, not the type.
//
// The numbers below reproduce today's underground island station exactly, so
// moving a consumer onto this contract changes no geometry. That is what makes
// the migration checkable one step at a time.
// Track centres sit at ±6.6 m in the island hall. The HŽ 7022 body reaches
// another 1.443 m; 10.5 m leaves a useful evacuation/services margin outside
// the vehicle instead of letting the wall visually swallow it.
export const UNDERGROUND_STATION_INTERIOR_HALF_WIDTH_M = 10.5;
// HŽ 7022 door thresholds sit about 0.65 m above rail. A 0.55 m European
// low-platform leaves a small realistic step; the former 0.9 m metro platform
// rose visibly above the low-floor doorway.
export const UNDERGROUND_STATION_PLATFORM_HEIGHT_M = 0.55;

const STATION_TYPES = Object.freeze({
    'underground-island': {
        label: 'Podzemna otočna stanica',
        // The platform hall proper: where the train stops and people stand.
        platformLengthM: 60,
        // Each throat carries the track from running spacing out to the island
        // spacing. It is part of the STATION, not of the tunnel — the tunnel
        // arrives at the port already at its normal section.
        throatLengthM: 55,
        // Interior half width: the hall wall. This is the number walk physics
        // needs and the one it currently guesses wrong.
        interiorHalfWidthM: UNDERGROUND_STATION_INTERIOR_HALF_WIDTH_M,
        // Track centre spacing at the middle of the station, where the island
        // platform sits between the two tracks.
        trackSpacingM: 13.2,
        platformHeightM: UNDERGROUND_STATION_PLATFORM_HEIGHT_M,
        // Rail to the underside of the roof slab: 6.2 m of platform hall
        // clearing the train envelope, plus 3.4 m of mezzanine over it.
        hallHeightM: 9.6,
        // Earth over the roof slab before the station is properly buried.
        roofCoverM: 0.7,
        requiresStraight: true,
        requiresLevel: true,
    },
});

// The type the planner builds today. Consumers name the type they mean rather
// than hardcoding a string, so adding a second underground type is a one-line
// change at each call site instead of a search for quoted ids.
export const UNDERGROUND_STATION_TYPE_ID = 'underground-island';

export const STATION_VERTICAL_FORM = Object.freeze({
    FULL: 'underground-full',
    COMPACT_COVERED: 'compact-covered',
    OPEN_CUT: 'open-cut',
    UNKNOWN: 'unknown',
});

// The compact cut-and-cover shell is the 60 m platform hall without the full
// station's approach throats. The strip and both 3D worlds consume this same
// authoring contract.
export const COMPACT_COVERED_STATION = Object.freeze({
    label: 'Kompaktna natkrivena stanica',
    lengthM: 60,
    heightAboveRailM: 8.25,
    roofCoverM: 0.7,
    requiredDepthM: 8.95,
});

function lowestFinite(values) {
    let lowest = Infinity;
    for (const value of values || []) {
        if (value == null) continue;
        const number = Number(value);
        if (Number.isFinite(number)) lowest = Math.min(lowest, number);
    }
    return Number.isFinite(lowest) ? lowest : null;
}

// Select one physically buildable station form. There is deliberately no
// "underground but insufficient cover" state: as the rail rises, the full box
// becomes the compact covered box, then an open cut.
export function classifyStationVerticalForm({
    railElevAslM,
    terrainSamplesAslM,
    compactTerrainSamplesAslM,
    runningTrackSpacingM = 4,
} = {}) {
    const rail = Number(railElevAslM);
    if (!Number.isFinite(rail)) return null;
    const full = describeStation(
        UNDERGROUND_STATION_TYPE_ID,
        { runningTrackSpacingM },
    );
    const lowestFullTerrainAslM = lowestFinite(terrainSamplesAslM);
    const lowestCompactTerrainAslM = lowestFinite(
        compactTerrainSamplesAslM ?? terrainSamplesAslM,
    );
    const forms = {
        full: {
            lengthM: full.envelope.lengthM,
            heightAboveRailM: full.envelope.heightAboveRailM,
            requiredDepthM: full.requirements.minDepthBelowGroundM,
        },
        compact: { ...COMPACT_COVERED_STATION },
    };
    if (lowestFullTerrainAslM == null && lowestCompactTerrainAslM == null) {
        return {
            form: STATION_VERTICAL_FORM.UNKNOWN,
            railElevAslM: rail,
            lowestTerrainAslM: null,
            depthM: null,
            selected: null,
            forms,
        };
    }
    const fullDepthM = lowestFullTerrainAslM == null
        ? null : lowestFullTerrainAslM - rail;
    const compactDepthM = lowestCompactTerrainAslM == null
        ? null : lowestCompactTerrainAslM - rail;
    let form = STATION_VERTICAL_FORM.OPEN_CUT;
    let selected = null;
    if (fullDepthM != null && fullDepthM + 0.01 >= forms.full.requiredDepthM) {
        form = STATION_VERTICAL_FORM.FULL;
        selected = forms.full;
    } else if (compactDepthM != null
        && compactDepthM + 0.01 >= forms.compact.requiredDepthM) {
        form = STATION_VERTICAL_FORM.COMPACT_COVERED;
        selected = forms.compact;
    }
    const lowestTerrainAslM = form === STATION_VERTICAL_FORM.FULL
        ? lowestFullTerrainAslM : lowestCompactTerrainAslM;
    const depthM = form === STATION_VERTICAL_FORM.FULL ? fullDepthM : compactDepthM;
    return {
        form,
        railElevAslM: rail,
        lowestTerrainAslM,
        depthM,
        fullDepthM,
        compactDepthM,
        selected,
        forms,
    };
}

export function stationTypeIds() {
    return Object.keys(STATION_TYPES);
}

// Smoothstep from the island spacing at the platform to the running spacing at
// the port. Same curve the current renderer uses, kept here so the transition
// belongs to the station rather than being applied to the tunnel from outside.
//
// The live renderer multiplies this by a SECOND, depth-based easing
// (getUndergroundDepthFlareFactor): it closes the flare as the track climbs out
// of station level, because today the flare is smeared along the tunnel and can
// otherwise reach track that has already surfaced. That is a symptom of the
// missing ownership, not a property of a station: a station requires its
// envelope to be level (see requirements.levelLengthM), and inside a level
// envelope there is nothing to ease out of. It is deliberately NOT reproduced
// here — but it must stay in the renderer until the level requirement is
// actually enforced, or a steep ramp will draw surface track at island spacing.
function flareFactor(distanceFromCentreM, platformHalfLengthM, throatLengthM) {
    const distanceM = Math.max(0, Number(distanceFromCentreM) || 0);
    if (distanceM <= platformHalfLengthM) return 1;
    if (!(throatLengthM > 0)) return 0;
    const t = Math.max(0, Math.min(1, (distanceM - platformHalfLengthM) / throatLengthM));
    return 1 - t * t * (3 - 2 * t);
}

/**
 * Describe a station instance.
 *
 * @param typeId                 key from STATION_TYPES
 * @param runningTrackSpacingM   the spacing the TUNNEL runs at — what the
 *                               station must match at its ports
 * @returns a description, or null for an unknown type
 */
export function describeStation(typeId, { runningTrackSpacingM } = {}) {
    const type = STATION_TYPES[typeId];
    if (!type) return null;
    const runningSpacingM = Number(runningTrackSpacingM);
    if (!Number.isFinite(runningSpacingM) || runningSpacingM <= 0) return null;

    const platformHalfLengthM = type.platformLengthM * 0.5;
    const halfLengthM = platformHalfLengthM + type.throatLengthM;

    // Track centre spacing at a distance along the route from the station's
    // centre. Outside the envelope this is the running spacing by definition:
    // the station does not reach past its own ports.
    const trackSpacingAtM = (alongM) => {
        // An unknown distance is not "at the platform". Number(null) is 0, so
        // without this the worst possible default wins: full island spacing for
        // track that may be nowhere near a station.
        if (alongM == null) return runningSpacingM;
        const distanceM = Math.abs(Number(alongM));
        if (!Number.isFinite(distanceM)) return runningSpacingM;
        if (distanceM >= halfLengthM) return runningSpacingM;
        const factor = flareFactor(distanceM, platformHalfLengthM, type.throatLengthM);
        return runningSpacingM + (type.trackSpacingM - runningSpacingM) * factor;
    };

    return {
        typeId,
        label: type.label,

        // Where tunnels plug in. Each port states the section the tunnel must
        // present: the station guarantees track continuity and RUNNING spacing
        // there, so a tunnel never has to know a station exists.
        ports: [-halfLengthM, halfLengthM].map((alongM) => ({
            alongM,
            trackSpacingM: runningSpacingM,
            railOffsetM: 0,
        })),

        // What the station occupies, relative to its own origin: rail level at
        // the platform centre, heading along the route.
        envelope: {
            lengthM: halfLengthM * 2,
            halfLengthM,
            halfWidthM: type.interiorHalfWidthM,
            platformLengthM: type.platformLengthM,
            heightAboveRailM: type.hallHeightM,
        },

        // What the station needs from the route before it can be placed. The
        // planner validates these; it does not reshape the station to fit.
        requirements: {
            straightLengthM: type.requiresStraight ? halfLengthM * 2 : 0,
            levelLengthM: type.requiresLevel ? halfLengthM * 2 : 0,
            // Rail this far below bare earth, or the roof slab surfaces.
            minDepthBelowGroundM: type.hallHeightM + type.roofCoverM,
        },

        // What physics needs: the volume a walker can be inside, and the floors
        // they can stand on — both relative to rail level. Published by the
        // station instead of inferred from tunnel constants.
        occupancy: {
            halfWidthM: type.interiorHalfWidthM,
            halfLengthM,
            floorAboveRailM: 0,
            ceilingAboveRailM: type.hallHeightM,
            platformTopAboveRailM: type.platformHeightM,
        },

        trackSpacingAtM,
    };
}

// True when a point (in station-local coordinates: alongM down the route,
// offsetM to the side, heightM above rail) is inside the station's interior.
// This is the question walk physics should ask instead of measuring against a
// tunnel's cross-section.
export function isInsideStation(description, { alongM, offsetM, heightM = 0 }) {
    if (!description) return false;
    const { occupancy } = description;
    const along = Number(alongM);
    const offset = Number(offsetM);
    const height = Number(heightM);
    if (!Number.isFinite(along) || !Number.isFinite(offset)) return false;
    if (Math.abs(along) > occupancy.halfLengthM) return false;
    if (Math.abs(offset) > occupancy.halfWidthM) return false;
    if (!Number.isFinite(height)) return true;
    return height >= occupancy.floorAboveRailM - 1e-9
        && height <= occupancy.ceilingAboveRailM + 1e-9;
}
