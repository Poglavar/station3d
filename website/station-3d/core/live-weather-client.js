// Session-wide live-weather polling. It follows the current Station3D WGS84
// pose, polls at most once per ten minutes, and never overrides a forced test
// preset from the URL or public runtime API.

import {
    LIVE_WEATHER_POLL_INTERVAL_MS,
    buildOpenMeteoCurrentUrl,
    parseOpenMeteoCurrent,
} from './live-weather.js';
import {
    applyLiveWeatherRainIntensity,
    isLiveWeatherEnabled,
} from './weather.js';

const REQUEST_TIMEOUT_MS = 8000;

let active = false;
let latitude = null;
let longitude = null;
let lastAttemptAtMs = -Infinity;
let lastSuccessAtMs = null;
let lastResult = null;
let lastError = null;
let pendingRequest = null;

function setLocation(detail = {}) {
    const lat = Number(detail.lat);
    const lon = Number(detail.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    latitude = lat;
    longitude = lon;
    return true;
}

function ensureOpenMeteoAttribution() {
    const container = document.getElementById('station3DContainer');
    if (!container || document.getElementById('station3DWeatherAttribution')) return;
    const link = document.createElement('a');
    link.id = 'station3DWeatherAttribution';
    link.className = 'station-3d-weather-attribution';
    link.href = 'https://open-meteo.com/';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Weather: Open-Meteo';
    container.append(link);
}

function publish(result) {
    window.dispatchEvent(new CustomEvent('station3d:live-weather', { detail: result }));
}

export function getLiveWeatherSnapshot() {
    return Object.freeze({
        active,
        latitude,
        longitude,
        pollIntervalMs: LIVE_WEATHER_POLL_INTERVAL_MS,
        pending: !!pendingRequest,
        lastAttemptAtMs: Number.isFinite(lastAttemptAtMs) ? lastAttemptAtMs : null,
        lastSuccessAtMs,
        result: lastResult,
        error: lastError,
    });
}

export function refreshLiveWeather({ force = false } = {}) {
    if (pendingRequest) return pendingRequest;
    if (!active && !force) return Promise.resolve(getLiveWeatherSnapshot());
    if (!isLiveWeatherEnabled()) return Promise.resolve(getLiveWeatherSnapshot());
    const requestUrl = buildOpenMeteoCurrentUrl(latitude, longitude);
    if (!requestUrl) return Promise.resolve(getLiveWeatherSnapshot());
    const nowMs = Date.now();
    if (!force && nowMs - lastAttemptAtMs < LIVE_WEATHER_POLL_INTERVAL_MS) {
        return Promise.resolve(getLiveWeatherSnapshot());
    }

    lastAttemptAtMs = nowMs;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeoutId = setTimeout(() => controller?.abort(), REQUEST_TIMEOUT_MS);
    const request = fetch(requestUrl, {
        cache: 'no-store',
        signal: controller?.signal,
    }).then((response) => {
        if (!response.ok) throw new Error(`Open-Meteo request failed (${response.status})`);
        return response.json();
    }).then((payload) => {
        const parsed = parseOpenMeteoCurrent(payload);
        const weather = applyLiveWeatherRainIntensity(parsed.rainIntensity);
        if (weather === false) return;
        lastSuccessAtMs = Date.now();
        lastError = null;
        lastResult = Object.freeze({
            ...parsed,
            latitude,
            longitude,
            provider: 'Open-Meteo',
            weather,
        });
        ensureOpenMeteoAttribution();
        publish(lastResult);
    }).catch((error) => {
        lastError = error?.name === 'AbortError'
            ? 'Open-Meteo request timed out'
            : String(error?.message || error);
    }).finally(() => {
        clearTimeout(timeoutId);
        if (pendingRequest === request) pendingRequest = null;
    });
    pendingRequest = request;
    return request.then(() => getLiveWeatherSnapshot());
}

if (typeof window !== 'undefined') {
    window.addEventListener('station3d:visibility', (event) => {
        active = event?.detail?.active === true;
        if (active) refreshLiveWeather();
    });
    window.addEventListener('station3d:location', (event) => {
        if (setLocation(event?.detail) && active) refreshLiveWeather();
    });
    window.addEventListener('station3d:pose', (event) => {
        if (setLocation(event?.detail) && active) refreshLiveWeather();
    });
    window.addEventListener('station3d:weather-live-request', () => {
        lastAttemptAtMs = -Infinity;
        refreshLiveWeather({ force: true });
    });
}
