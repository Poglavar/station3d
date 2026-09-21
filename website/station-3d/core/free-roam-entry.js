// Host-independent free-roam entry options. The solved comparison uses the
// same bounded rail request/feature conversion as the planner, without its UI.
//
// The reconstructed reference lines are preferred wherever they exist and OSM
// rail fills in everywhere else, so a request that names no mode asks for
// solved and quietly falls back to OSM when the reference service cannot
// answer. An explicit `solved` keeps failing loudly: whoever asked for the
// comparison must not get OSM without knowing.
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export async function prepareFreeRoamOptions(request, {
    apiBaseUrl, referenceRailApi, fetchFn = globalThis.fetch, signal,
    modelTerrainActive = true, warn = message => console.warn(message),
} = {}) {
    const explicit = request.railProfileMode === 'solved' || request.railProfileMode === 'osm';
    const options = {
        initialHeadingDeg: request.headingDeg ?? 0,
        initialLookPitchDeg: request.pitchDeg ?? 0,
        railProfileMode: request.railProfileMode === 'osm' ? 'osm' : 'solved',
        proposalIds: request.proposalIds?.length ? request.proposalIds : null,
        otherTracks: [],
    };
    if (options.railProfileMode === 'osm') return options;
    const fallBack = (reason) => {
        if (explicit) throw new Error(reason);
        warn(`[${stamp()}] ${reason} Drawing OSM rail instead.`);
        return { ...options, railProfileMode: 'osm' };
    };
    if (!referenceRailApi || !apiBaseUrl) return fallBack('Reference rail service is unavailable.');
    const bbox = referenceRailApi.areaOfInterestBbox([[request.lat, request.lon]]);
    const url = `${apiBaseUrl}/transit/reference-project-geometry?bbox=${encodeURIComponent(referenceRailApi.bboxQueryValue(bbox))}`;
    let payload;
    try {
        // Reference geometry changes with a reconstruction import, not with
        // play; the API's world-data Cache-Control keeps repeat visits cheap.
        const response = await fetchFn(url, { signal });
        if (!response.ok) throw new Error(`Reference rail request failed (${response.status}).`);
        payload = await response.json();
    } catch (error) {
        if (error?.name === 'AbortError') throw error;
        return fallBack(error?.message || 'Reference rail request failed.');
    }
    options.otherTracks = referenceRailApi.referenceFeatures(payload, {
        modelTerrainActive, solvedOnly: true,
    });
    return options;
}
