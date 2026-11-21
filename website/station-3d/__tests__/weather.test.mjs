import test from 'node:test';
import assert from 'node:assert/strict';

import {
    WEATHER_PRESETS,
    createWeatherController,
    hasWeatherOverride,
    parseWeatherQuery,
} from '../core/weather.js';

test('weather query accepts presets, boolean rain and numeric intensity', () => {
    assert.deepEqual(parseWeatherQuery('?weather=rain'), {
        preset: 'rain',
        rainIntensity: WEATHER_PRESETS.rain,
    });
    assert.deepEqual(parseWeatherQuery('?weather=clear&rain=0.46'), {
        preset: 'drizzle',
        rainIntensity: 0.46,
    });
    assert.equal(parseWeatherQuery('?rain=true').rainIntensity, WEATHER_PRESETS.rain);
    assert.equal(parseWeatherQuery('?weather=heavy&rain=off').rainIntensity, 0);
});

test('only explicit weather query parameters disable live weather', () => {
    assert.equal(hasWeatherOverride('?line=1&weather=rain'), true);
    assert.equal(hasWeatherOverride('?rain=0'), true);
    assert.equal(hasWeatherOverride('?line=1&quality3d=low'), false);
    assert.equal(hasWeatherOverride('?line=1&weather=live'), false);
});

test('weather controller transitions smoothly and clamps requested intensity', () => {
    const weather = createWeatherController({ preset: 'clear', rainIntensity: 0 });
    weather.set('rain', { intensity: 2, transitionMs: 4000, nowMs: 1000 });
    assert.equal(weather.intensityAt(1000), 0);
    assert.equal(weather.intensityAt(3000), 0.5);
    assert.equal(weather.intensityAt(5000), 1);
    assert.deepEqual(weather.snapshot(5000), {
        preset: 'rain',
        rainIntensity: 1,
        targetRainIntensity: 1,
        transitioning: false,
    });
});

test('a new weather transition starts from the current interpolated value', () => {
    const weather = createWeatherController({ preset: 'clear', rainIntensity: 0 });
    weather.set('rain', { transitionMs: 4000, nowMs: 0 });
    const halfway = weather.intensityAt(2000);
    assert.equal(halfway, WEATHER_PRESETS.rain * 0.5);
    weather.set('clear', { transitionMs: 2000, nowMs: 2000 });
    assert.equal(weather.intensityAt(2000), halfway);
    assert.equal(weather.intensityAt(3000), halfway * 0.5);
    assert.equal(weather.intensityAt(4000), 0);
});
