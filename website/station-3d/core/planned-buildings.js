// Planned buildings from the world provider: a product that knows what will be built (permits,
// reviewed massings) serves it as GeoJSON, and a session that asks for it shows those buildings
// in place of what stands on their plots today. Pure — no THREE, no DOM — so the request and the
// conversion are provable under node; world/proposals.js fetches and ingests the result as an
// ordinary building proposal (same substitution mask, same N display cycle).

const DEFAULT_RADIUS_M = 1500;
const METRES_PER_DEGREE_LAT = 111320;

// worldProfile.plannedBuildings: { endpoint: 'path/below/apiBaseUrl', radiusM?: number }.
// Returns the request URL for the square of ±radiusM around the session start, or null when
// the world does not offer planned buildings or the start is not a real position.
export function plannedBuildingsUrl(provider, lat, lon) {
    const config = provider?.worldProfile?.plannedBuildings;
    const endpoint = typeof config?.endpoint === 'string' ? config.endpoint.replace(/^\/+/, '') : '';
    const base = typeof provider?.apiBaseUrl === 'string' ? provider.apiBaseUrl.replace(/\/+$/, '') : '';
    if (!endpoint || !base) return null;
    if (typeof lat !== 'number' || !Number.isFinite(lat) || typeof lon !== 'number' || !Number.isFinite(lon)) return null;
    const radiusM = typeof config.radiusM === 'number' && config.radiusM > 0 ? config.radiusM : DEFAULT_RADIUS_M;
    const dLat = radiusM / METRES_PER_DEGREE_LAT;
    const dLon = radiusM / (METRES_PER_DEGREE_LAT * Math.cos(lat * Math.PI / 180));
    const bbox = [lon - dLon, lat - dLat, lon + dLon, lat + dLat].map(value => value.toFixed(6)).join(',');
    return `${base}/${endpoint}?bbox=${bbox}`;
}

// The provider's FeatureCollection → one building proposal record for ingestBuildings. Each
// feature is a building outline (Polygon/MultiPolygon) with its height in properties.height_m;
// an outline whose height is unknown is left out rather than drawn at a guessed height, and it
// does not hide the building standing there today. Returns null when nothing can be drawn.
export function plannedBuildingsProposal(collection) {
    const features = Array.isArray(collection?.features) ? collection.features : [];
    const buildings = [];
    for (const feature of features) {
        const type = feature?.geometry?.type;
        if (type !== 'Polygon' && type !== 'MultiPolygon') continue;
        const height = feature.properties?.height_m;
        if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) continue;
        buildings.push({ type: 'Feature', geometry: feature.geometry, properties: { height } });
    }
    if (buildings.length === 0) return null;
    return { id: 'planned-buildings', goal: 'buildings', geometry: { buildings } };
}
