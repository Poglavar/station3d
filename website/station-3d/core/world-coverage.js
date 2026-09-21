// Decides whether an empty-looking world is empty because there is nothing
// there, or because nothing was ever prepared there — and says which.
//
// The two are indistinguishable on screen: a bbox query over unprepared ground
// returns exactly what open karst returns, an empty FeatureCollection, and the
// world dutifully renders a bare plane. That is how three locations can be
// live on a server that holds none of their data and look like a rendering bug
// instead of a missing ingest.
//
// Kept pure and free of fetch/DOM so the rule can be tested headlessly. The
// signals it consumes are all crisp — "is this point inside a served area",
// "did the server ever ingest this location", "did the terrain grid answer" —
// deliberately NOT "did this bbox come back empty", because over the Lika line
// an empty bbox is the correct answer and must never raise a warning.

// What the message is about, so the UI can style it: 'none' means nothing is
// prepared here at all, 'warn' means part of the bundle is missing.
export const COVERAGE_OK = null;

// Which /prepared-coverage counter backs each building source.
//
// The Overture counters are bucketed by whatever the ingest actually loaded,
// and that is no longer one bucket per prepared location: the pull was widened
// to a whole country, so the keys read `croatia` and `belgrade` rather than
// `sjeverna-dalmacija`. Ask for the city first — a per-city bucket is still the
// more precise answer wherever one exists — then the country it belongs to.
//
// A key nobody wrote is NOT zero. Reading an absent key as "none prepared" is
// what put a false "no buildings" warning over every Croatian location while
// their tiles were streaming in perfectly well; unknown has to stay unknown, or
// the warning stops being evidence of anything.
function preparedBuildingCount(coverage, locationId, buildingSource, country) {
    if (!coverage) return null;
    if (buildingSource === 'gdi') {
        return Number.isFinite(coverage.gdiBuildings) ? coverage.gdiBuildings : null;
    }
    if (buildingSource === 'overture') {
        const counts = coverage.overtureBuildings;
        if (!counts || typeof counts !== 'object') return null;
        const city = counts[locationId];
        if (Number.isFinite(city)) return city;
        // With no country to fall back on there is nothing left to ask, and a
        // missing city key on a country-bucketed server proves nothing.
        if (!country) return null;
        const national = counts[country];
        // The endpoint returns one row per bucket it actually holds, so a
        // country with no row is a country with no buildings at all — which IS
        // the missing-ingest case this check was written for, and the one it
        // caught in production. Only the CITY key is allowed to be absent
        // without meaning zero.
        return Number.isFinite(national) ? national : 0;
    }
    return null;
}

// locationId          active prepared-location id
// buildingSource      LOCATIONS[id].buildings — 'gdi', 'overture' or false
// country             LOCATIONS[id].country — the ingest bucket this location
//                     falls back to when the server holds no per-city counter
// declaresTerrain     whether this location expects a DGU grid
// insidePreparedArea  registry detectByLatLng(anchor) !== null; null when unknown
// coverage            GET /prepared-coverage payload, or null if it failed
// terrainState        'ok' | 'missing' | 'unknown'
//
// Returns null when there is nothing to say, else { level, key, params } for
// the UI to translate.
export function assessWorldCoverage({
    locationId,
    buildingSource = false,
    country = null,
    declaresTerrain = false,
    insidePreparedArea = null,
    coverage = null,
    terrainState = 'unknown',
} = {}) {
    // Outermost case first: no amount of ingested data helps a point that is
    // not in any served area. This is the honest answer for a spawn on the
    // Rijeka line or the Sunja–Kostajnica branch, neither of which is prepared.
    if (insidePreparedArea === false) {
        return { level: 'none', key: 'coverage.outside', params: {} };
    }

    const buildings = preparedBuildingCount(coverage, locationId, buildingSource, country);
    const buildingsMissing = buildings === 0;
    const terrainMissing = declaresTerrain && terrainState === 'missing';

    if (buildingsMissing && terrainMissing) {
        return { level: 'none', key: 'coverage.nothingPrepared', params: { location: locationId } };
    }
    if (buildingsMissing) {
        return { level: 'warn', key: 'coverage.noBuildings', params: { location: locationId } };
    }
    if (terrainMissing) {
        return { level: 'warn', key: 'coverage.noTerrain', params: { location: locationId } };
    }
    return COVERAGE_OK;
}
