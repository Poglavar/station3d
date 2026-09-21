// Pure Open-Meteo request and response policy. Browser polling lives separately
// so weather interpretation remains deterministic and unit-testable.

export const OPEN_METEO_FORECAST_ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
export const LIVE_WEATHER_POLL_INTERVAL_MS = 10 * 60 * 1000;

const CURRENT_FIELDS = Object.freeze([
    'precipitation',
    'rain',
    'showers',
    'snowfall',
    'weather_code',
]);

const LIGHT_RAIN_CODES = new Set([51, 56, 61, 80]);
const MODERATE_RAIN_CODES = new Set([53, 63, 66, 81, 95, 96]);
const HEAVY_RAIN_CODES = new Set([55, 57, 65, 67, 82, 99]);

function finiteNonNegative(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
}

function rainCodeFloor(code) {
    const numeric = Number(code);
    if (HEAVY_RAIN_CODES.has(numeric)) return 0.88;
    if (MODERATE_RAIN_CODES.has(numeric)) return 0.55;
    if (LIGHT_RAIN_CODES.has(numeric)) return 0.28;
    return 0;
}

export function buildOpenMeteoCurrentUrl(latitude, longitude) {
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    const url = new URL(OPEN_METEO_FORECAST_ENDPOINT);
    url.searchParams.set('latitude', lat.toFixed(5));
    url.searchParams.set('longitude', lon.toFixed(5));
    url.searchParams.set('current', CURRENT_FIELDS.join(','));
    url.searchParams.set('forecast_days', '1');
    return url.toString();
}

export function rainIntensityFromOpenMeteo(current = {}) {
    const rainMm = finiteNonNegative(current.rain) + finiteNonNegative(current.showers);
    const codeFloor = rainCodeFloor(current.weather_code);
    if (rainMm <= 0) return codeFloor;

    // Current precipitation is an interval sum. This curve keeps a trace of
    // rain visible without making ordinary showers look like a cloudburst.
    const measured = 0.2 + 0.8 * (1 - Math.exp(-rainMm / 2.2));
    return Math.round(Math.min(1, Math.max(codeFloor, measured)) * 1000) / 1000;
}

export function parseOpenMeteoCurrent(payload) {
    if (!payload || typeof payload !== 'object' || !payload.current) {
        throw new TypeError('Open-Meteo response has no current weather block');
    }
    const current = payload.current;
    return Object.freeze({
        rainIntensity: rainIntensityFromOpenMeteo(current),
        weatherCode: Number.isFinite(Number(current.weather_code)) ? Number(current.weather_code) : null,
        rainMm: finiteNonNegative(current.rain),
        showersMm: finiteNonNegative(current.showers),
        snowfallCm: finiteNonNegative(current.snowfall),
        observedAt: current.time || null,
    });
}
