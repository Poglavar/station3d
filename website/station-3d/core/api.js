// Runtime data-provider boundary. The engine only needs a neutral HTTP base
// today, but it also retains provider identity and attribution so static world
// packs and alternate servers can use the same public configuration surface.

const DEFAULT_PROVIDER_ID = 'default-http';
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function cloneConfigurationValue(value, field, seen = new Set()) {
    if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
    if (typeof value !== 'object') {
        throw new TypeError(`World provider ${field} must contain only data values`);
    }
    if (seen.has(value)) throw new TypeError(`World provider ${field} must not be circular`);
    seen.add(value);
    const result = Array.isArray(value)
        ? value.map(item => cloneConfigurationValue(item, field, seen))
        : Object.fromEntries(Object.entries(value).map(([key, item]) => (
            [key, cloneConfigurationValue(item, `${field}.${key}`, seen)]
        )));
    seen.delete(value);
    return Object.freeze(result);
}

function normalizeApiBaseUrl(value = '/api') {
    if (typeof value !== 'string' || !value.trim()) {
        throw new TypeError('World provider apiBaseUrl must be a non-empty string');
    }
    const normalized = value.trim().replace(/\/+$/, '') || '/';
    if (!normalized.startsWith('/') && !/^https?:\/\//i.test(normalized)) {
        throw new TypeError('World provider apiBaseUrl must be root-relative or HTTP(S)');
    }
    return normalized;
}

function optionalText(value, field) {
    if (value == null || value === '') return null;
    if (typeof value !== 'string' || !value.trim()) {
        throw new TypeError(`World provider attribution ${field} must be a string`);
    }
    return value.trim();
}

function optionalUrl(value, field) {
    const text = optionalText(value, field);
    if (!text) return null;
    let parsed;
    try { parsed = new URL(text); }
    catch (_error) { throw new TypeError(`World provider attribution ${field} must be an absolute URL`); }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new TypeError(`World provider attribution ${field} must use HTTP(S)`);
    }
    return parsed.href;
}

function normalizeAttributions(entries = []) {
    if (!Array.isArray(entries)) throw new TypeError('World provider attributions must be an array');
    if (entries.length > 32) throw new RangeError('World provider attributions exceed the 32-entry limit');
    return Object.freeze(entries.map((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            throw new TypeError(`World provider attribution ${index} must be an object`);
        }
        const name = optionalText(entry.name, 'name');
        if (!name) throw new TypeError(`World provider attribution ${index} requires a name`);
        return Object.freeze({
            name,
            url: optionalUrl(entry.url, 'url'),
            license: optionalText(entry.license, 'license'),
            licenseUrl: optionalUrl(entry.licenseUrl, 'licenseUrl'),
        });
    }));
}

function normalizeBounds(value = null) {
    if (value == null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('World provider bounds must be an object');
    }
    const bounds = {
        west: Number(value.west),
        south: Number(value.south),
        east: Number(value.east),
        north: Number(value.north),
    };
    if (!Object.values(bounds).every(Number.isFinite)
        || bounds.west < -180 || bounds.east > 180
        || bounds.south < -90 || bounds.north > 90
        || bounds.west >= bounds.east || bounds.south >= bounds.north) {
        throw new TypeError('World provider bounds are invalid');
    }
    return Object.freeze(bounds);
}

export function createWorldProviderConfiguration(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new TypeError('World provider configuration must be an object');
    }
    const id = options.id == null ? DEFAULT_PROVIDER_ID : String(options.id).trim();
    if (!PROVIDER_ID_RE.test(id)) throw new TypeError('World provider id is invalid');
    return Object.freeze({
        id,
        apiBaseUrl: normalizeApiBaseUrl(options.apiBaseUrl),
        attributions: normalizeAttributions(options.attributions),
        bounds: normalizeBounds(options.bounds),
        worldProfile: options.worldProfile == null
            ? null
            : cloneConfigurationValue(options.worldProfile, 'worldProfile'),
    });
}

let provider = createWorldProviderConfiguration();

export function configureWorldProvider(options = {}) {
    provider = createWorldProviderConfiguration(options);
    return provider;
}

export function getWorldProvider() { return provider; }
export function getWorldAttributions() { return provider.attributions; }
export function getApiBase() { return provider.apiBaseUrl; }

export function worldProviderContains(lat, lon, candidate = provider) {
    const latitude = Number(lat);
    const longitude = Number(lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
    const bounds = candidate?.bounds;
    if (!bounds) return true;
    return longitude >= bounds.west && longitude <= bounds.east
        && latitude >= bounds.south && latitude <= bounds.north;
}
