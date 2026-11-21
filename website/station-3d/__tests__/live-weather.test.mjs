import test from 'node:test';
import assert from 'node:assert/strict';

import {
    LIVE_WEATHER_POLL_INTERVAL_MS,
    buildOpenMeteoCurrentUrl,
    parseOpenMeteoCurrent,
    rainIntensityFromOpenMeteo,
} from '../core/live-weather.js';

test('Open-Meteo request asks only for current rain classification fields', () => {
    const url = new URL(buildOpenMeteoCurrentUrl(45.815, 15.9819));
    assert.equal(url.origin, 'https://api.open-meteo.com');
    assert.equal(url.pathname, '/v1/forecast');
    assert.equal(url.searchParams.get('latitude'), '45.81500');
    assert.equal(url.searchParams.get('longitude'), '15.98190');
    assert.equal(url.searchParams.get('forecast_days'), '1');
    assert.match(url.searchParams.get('current'), /rain/);
    assert.match(url.searchParams.get('current'), /showers/);
    assert.match(url.searchParams.get('current'), /snowfall/);
    assert.equal(LIVE_WEATHER_POLL_INTERVAL_MS, 600000);
});

test('rain intensity distinguishes clear weather, rain codes and snowfall', () => {
    assert.equal(rainIntensityFromOpenMeteo({ weather_code: 0 }), 0);
    assert.equal(rainIntensityFromOpenMeteo({ weather_code: 61, rain: 0 }), 0.28);
    assert.ok(rainIntensityFromOpenMeteo({ weather_code: 63, rain: 1 }) >= 0.55);
    assert.ok(rainIntensityFromOpenMeteo({ weather_code: 65, rain: 8 }) >= 0.95);
    assert.equal(rainIntensityFromOpenMeteo({ weather_code: 73, precipitation: 2, snowfall: 1 }), 0);
});

test('Open-Meteo current response becomes a compact weather observation', () => {
    assert.deepEqual(parseOpenMeteoCurrent({
        current: {
            time: '2026-09-20T12:00',
            weather_code: 81,
            precipitation: 1.4,
            rain: 0.5,
            showers: 0.9,
            snowfall: 0,
        },
    }), {
        rainIntensity: rainIntensityFromOpenMeteo({ weather_code: 81, rain: 0.5, showers: 0.9 }),
        weatherCode: 81,
        rainMm: 0.5,
        showersMm: 0.9,
        snowfallCm: 0,
        observedAt: '2026-09-20T12:00',
    });
    assert.throws(() => parseOpenMeteoCurrent({}), /current weather block/);
});
