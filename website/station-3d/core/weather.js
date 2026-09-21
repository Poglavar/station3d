// Shared Station3D weather state. Rendering, audio and campaign adapters all
// consume this one transition instead of inventing mode-specific rain rules.

export const WEATHER_PRESETS = Object.freeze({
    clear: 0,
    drizzle: 0.34,
    rain: 0.72,
    heavy: 1,
    storm: 1,
});

export const DEFAULT_WEATHER_TRANSITION_MS = 4000;
export const LIVE_WEATHER_TRANSITION_MS = 6000;

function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

function smoothstep01(value) {
    const t = clamp01(value);
    return t * t * (3 - 2 * t);
}

function clockNowMs() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
}

function presetIntensity(value, fallback = 0) {
    if (typeof value === 'number') return clamp01(value);
    const normalized = String(value || '').trim().toLowerCase();
    if (Object.hasOwn(WEATHER_PRESETS, normalized)) return WEATHER_PRESETS[normalized];
    const numeric = Number(normalized);
    return Number.isFinite(numeric) ? clamp01(numeric) : clamp01(fallback);
}

function presetName(value, intensity) {
    const normalized = String(value || '').trim().toLowerCase();
    if (Object.hasOwn(WEATHER_PRESETS, normalized)) return normalized === 'storm' ? 'heavy' : normalized;
    if (intensity <= 0.001) return 'clear';
    if (intensity < 0.52) return 'drizzle';
    if (intensity < 0.9) return 'rain';
    return 'heavy';
}

export function parseWeatherQuery(search = '') {
    const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
    const weatherValue = params.get('weather');
    const rainValue = params.get('rain');
    let intensity = presetIntensity(weatherValue, 0);
    if (rainValue != null) {
        const normalized = rainValue.trim().toLowerCase();
        if (['true', 'yes', 'on'].includes(normalized)) intensity = WEATHER_PRESETS.rain;
        else if (['false', 'no', 'off'].includes(normalized)) intensity = 0;
        else intensity = presetIntensity(normalized, intensity);
    }
    return Object.freeze({
        preset: presetName(rainValue == null ? weatherValue : '', intensity),
        rainIntensity: intensity,
    });
}

export function hasWeatherOverride(search = '') {
    const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
    if (params.has('rain')) return true;
    if (!params.has('weather')) return false;
    return !['live', 'auto', 'actual'].includes(String(params.get('weather') || '').trim().toLowerCase());
}

export function createWeatherController(initial = {}) {
    let fromIntensity = clamp01(initial.rainIntensity);
    let targetIntensity = fromIntensity;
    let preset = presetName(initial.preset, targetIntensity);
    let startedAtMs = 0;
    let durationMs = 0;

    function intensityAt(nowMs = clockNowMs()) {
        if (durationMs <= 0) return targetIntensity;
        const progress = (Number(nowMs) - startedAtMs) / durationMs;
        if (progress >= 1) {
            fromIntensity = targetIntensity;
            durationMs = 0;
            return targetIntensity;
        }
        if (progress <= 0) return fromIntensity;
        return fromIntensity + (targetIntensity - fromIntensity) * smoothstep01(progress);
    }

    function set(nextPreset = 'clear', options = {}) {
        const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : clockNowMs();
        const current = intensityAt(nowMs);
        const requested = options.intensity == null ? nextPreset : options.intensity;
        const nextIntensity = presetIntensity(requested, current);
        fromIntensity = current;
        targetIntensity = nextIntensity;
        preset = presetName(nextPreset, nextIntensity);
        startedAtMs = nowMs;
        durationMs = Math.max(0, Number(options.transitionMs ?? DEFAULT_WEATHER_TRANSITION_MS) || 0);
        if (durationMs === 0) fromIntensity = targetIntensity;
        return snapshot(nowMs);
    }

    function snapshot(nowMs = clockNowMs()) {
        const rainIntensity = intensityAt(nowMs);
        return Object.freeze({
            preset,
            rainIntensity,
            targetRainIntensity: targetIntensity,
            transitioning: durationMs > 0,
        });
    }

    return Object.freeze({ intensityAt, set, snapshot });
}

function linkedWeatherSearch() {
    if (typeof window === 'undefined') return '';
    const current = window.location.search || '';
    const currentParams = new URLSearchParams(current);
    if (currentParams.has('weather') || currentParams.has('rain')) return current;
    // transit.html intentionally replaces its verbose opening URL with the
    // stable project URL. PerformanceNavigationTiming retains the URL that
    // actually loaded the document, so engine-owned presentation parameters
    // remain available after that host cleanup.
    try {
        const navigationUrl = performance.getEntriesByType?.('navigation')?.[0]?.name;
        if (navigationUrl) return new URL(navigationUrl).search || current;
    } catch (_error) {
        // Embedded/webview environments may not expose navigation timing.
    }
    return current;
}

const linkedWeatherQuery = linkedWeatherSearch();
const linkedWeather = parseWeatherQuery(linkedWeatherQuery);
const weatherController = createWeatherController(linkedWeather);
let weatherSource = hasWeatherOverride(linkedWeatherQuery) ? 'forced' : 'live';

function publicSnapshot(nowMs) {
    return Object.freeze({
        ...weatherController.snapshot(nowMs),
        source: weatherSource,
    });
}

function dispatchWeather(snapshot) {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('station3d:weather', { detail: snapshot }));
}

export function getRainIntensity(nowMs) {
    return weatherController.intensityAt(nowMs);
}

export function getWeatherSnapshot(nowMs) {
    return publicSnapshot(nowMs);
}

export function setWeatherPreset(preset = 'clear', options = {}) {
    const normalized = String(preset || '').trim().toLowerCase();
    if (['live', 'auto', 'actual'].includes(normalized)) {
        weatherSource = 'live';
        const snapshot = publicSnapshot(options.nowMs);
        dispatchWeather(snapshot);
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('station3d:weather-live-request'));
        }
        return snapshot;
    }
    weatherSource = 'forced';
    const snapshot = publicSnapshotAfterSet(preset, options);
    dispatchWeather(snapshot);
    return snapshot;
}

function publicSnapshotAfterSet(preset, options) {
    weatherController.set(preset, options);
    return publicSnapshot(options.nowMs);
}

export function applyLiveWeatherRainIntensity(intensity, options = {}) {
    if (weatherSource !== 'live') return false;
    const numeric = clamp01(intensity);
    weatherController.set(presetName('', numeric), {
        ...options,
        intensity: numeric,
        transitionMs: options.transitionMs ?? LIVE_WEATHER_TRANSITION_MS,
    });
    const snapshot = publicSnapshot(options.nowMs);
    dispatchWeather(snapshot);
    return snapshot;
}

export function isLiveWeatherEnabled() {
    return weatherSource === 'live';
}
