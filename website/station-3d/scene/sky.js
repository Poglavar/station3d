// Sky + fog background colour, driven by the sim clock through a seasonal
// 24-hour colour table. The palette is authored against a reference sunrise /
// sunset, then remapped to the current Zagreb day length so spring/summer
// evenings stay bright much longer than winter ones. Also flips building wall
// materials into "night-window-glow" mode once Zagreb is actually into night.
//
// The sun itself is NOT dynamic — scene/setup.js owns it at a fixed
// east-south-high angle.

import * as THREE from 'three';
import { scene, renderer, sun, fill, ambient } from './setup.js';
import { setBuildingNightMode } from '../world/buildings.js';
import { setCarNightMode } from '../world/cars.js';
import { setTramNightMode } from '../models/vehicles/tram.js';
import { setStreetLampNightMode } from '../world/streetlamps.js';
import { parseTimeOfDayOverride } from '../core/time-of-day.js';
import { getRainIntensity } from '../core/weather.js';

const ZAGREB_LAT_DEG = 45.815;
const ZAGREB_LON_DEG = 15.982;
const ZAGREB_TIME_ZONE = 'Europe/Zagreb';
const REFERENCE_SUNRISE_HOUR = 6;
const REFERENCE_SUNSET_HOUR = 19;
const NIGHT_MARGIN_HOURS = 0.75;

const SKY_COLORS = [
    [10,  15,  40],  //  0 deep night
    [10,  15,  40],  //  1
    [10,  15,  40],  //  2
    [10,  15,  40],  //  3
    [20,  28,  66],  //  4 pre-dawn (deep blue)
    [50,  62, 110],  //  5 early dawn (blue, not washed)
    [96, 116, 168],  //  6 dawn — cool blue, only a faint warm cast (was orange)
    [134, 170, 216], //  7 lightening blue (was warm beige)
    [146, 194, 232], //  8 morning blue
    [128, 186, 230], //  9
    [115, 181, 228], // 10
    [108, 180, 230], // 11 midday
    [108, 180, 230], // 12
    [108, 180, 230], // 13
    [108, 180, 230], // 14
    [116, 183, 229], // 15 early afternoon
    [130, 187, 228], // 16 late afternoon
    [145, 190, 225], // 17 sunny evening
    [154, 192, 222], // 18 pre-sunset blue
    [218, 164, 110], // 19 sunset
    [152,  94,  98], // 20 dusk
    [ 60,  40,  80], // 21 twilight
    [ 20,  20,  55], // 22 night
    [ 10,  15,  40], // 23
];

const zagrebDateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZAGREB_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});

const zagrebTimeFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: ZAGREB_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
});

const zagrebOffsetFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: ZAGREB_TIME_ZONE,
    timeZoneName: 'shortOffset',
});

function normalizeHour(hour) {
    return ((hour % 24) + 24) % 24;
}

function clamp01(value) {
    return Math.max(0, Math.min(1, value));
}

function clampSignedUnit(value) {
    return Math.max(-1, Math.min(1, value));
}

function smoothstep(edge0, edge1, value) {
    if (edge1 <= edge0) return value >= edge1 ? 1 : 0;
    const t = clamp01((value - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
}

function getZagrebDateParts(date = new Date()) {
    const parts = zagrebDateFormatter.formatToParts(date);
    const get = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
    return {
        year: get('year'),
        month: get('month'),
        day: get('day'),
    };
}

function getDayOfYear({ year, month, day }) {
    const utc = Date.UTC(year, month - 1, day);
    const start = Date.UTC(year, 0, 1);
    return Math.floor((utc - start) / 86400000) + 1;
}

function getZagrebUtcOffsetHours(date = new Date()) {
    const parts = zagrebOffsetFormatter.formatToParts(date);
    const zone = parts.find((part) => part.type === 'timeZoneName')?.value || '';
    const match = zone.match(/GMT([+-]\d{1,2})(?::?(\d{2}))?/i);
    if (match) {
        const signHours = Number(match[1]);
        const minutes = Number(match[2] || 0);
        return signHours + Math.sign(signHours || 1) * (minutes / 60);
    }
    const { month } = getZagrebDateParts(date);
    return month >= 4 && month <= 10 ? 2 : 1;
}

// NOAA-style equation of time + solar declination for the given date.
// Shared by the sunrise/sunset calc and the animated sun direction.
function getSolarAngles(date = new Date()) {
    const dateParts = getZagrebDateParts(date);
    const dayOfYear = getDayOfYear(dateParts);
    const gamma = (2 * Math.PI / 365) * (dayOfYear - 1);
    const eqTime = 229.18 * (
        0.000075 +
        0.001868 * Math.cos(gamma) -
        0.032077 * Math.sin(gamma) -
        0.014615 * Math.cos(2 * gamma) -
        0.040849 * Math.sin(2 * gamma)
    );
    const decl = 0.006918 -
        0.399912 * Math.cos(gamma) +
        0.070257 * Math.sin(gamma) -
        0.006758 * Math.cos(2 * gamma) +
        0.000907 * Math.sin(2 * gamma) -
        0.002697 * Math.cos(3 * gamma) +
        0.00148 * Math.sin(3 * gamma);
    return { eqTime, decl };
}

export function getApproximateZagrebSunHours(date = new Date()) {
    const { eqTime, decl } = getSolarAngles(date);
    const latRad = ZAGREB_LAT_DEG * Math.PI / 180;
    const zenithRad = 90.833 * Math.PI / 180;
    const hourAngle = Math.acos(clampSignedUnit(
        (Math.cos(zenithRad) / (Math.cos(latRad) * Math.cos(decl))) -
        Math.tan(latRad) * Math.tan(decl)
    ));
    const offsetHours = getZagrebUtcOffsetHours(date);
    const solarNoonMinutes = 720 - (4 * ZAGREB_LON_DEG) - eqTime + (offsetHours * 60);
    const deltaMinutes = hourAngle * 180 / Math.PI * 4;
    return {
        sunriseHour: (solarNoonMinutes - deltaMinutes) / 60,
        sunsetHour: (solarNoonMinutes + deltaMinutes) / 60,
    };
}

export function remapHourForSeasonalSky(hour, sunHours = getApproximateZagrebSunHours()) {
    const normalizedHour = normalizeHour(hour);
    const sunriseHour = Math.max(0.25, Math.min(11.5, sunHours?.sunriseHour ?? REFERENCE_SUNRISE_HOUR));
    const sunsetHour = Math.max(sunriseHour + 1, Math.min(23.75, sunHours?.sunsetHour ?? REFERENCE_SUNSET_HOUR));

    if (normalizedHour <= sunriseHour) {
        return (normalizedHour / sunriseHour) * REFERENCE_SUNRISE_HOUR;
    }
    if (normalizedHour <= sunsetHour) {
        return REFERENCE_SUNRISE_HOUR +
            ((normalizedHour - sunriseHour) / (sunsetHour - sunriseHour)) *
            (REFERENCE_SUNSET_HOUR - REFERENCE_SUNRISE_HOUR);
    }
    return REFERENCE_SUNSET_HOUR +
        ((normalizedHour - sunsetHour) / Math.max(0.25, 24 - sunsetHour)) *
        (24 - REFERENCE_SUNSET_HOUR);
}

export function getSkyColorForHour(hour, sunHours = getApproximateZagrebSunHours()) {
    const seasonalHour = remapHourForSeasonalSky(hour, sunHours);
    const i = Math.floor(seasonalHour) % 24;
    const t = seasonalHour - Math.floor(seasonalHour);
    const a = SKY_COLORS[i];
    const b = SKY_COLORS[(i + 1) % 24];
    cachedSkyColor.setRGB(
        (a[0] + (b[0] - a[0]) * t) / 255,
        (a[1] + (b[1] - a[1]) * t) / 255,
        (a[2] + (b[2] - a[2]) * t) / 255,
        THREE.SRGBColorSpace,
    );
    return cachedSkyColor;
}

const linkedTimeOfDayOverride = typeof window !== 'undefined'
    ? parseTimeOfDayOverride(window.location.search)
    : null;
let sessionTimeOfDayOverride = null;

export function setSceneTimeOfDayOverride(hour = null) {
    const numeric = hour == null || hour === '' ? null : Number(hour);
    sessionTimeOfDayOverride = Number.isFinite(numeric) && numeric >= 0 && numeric < 24
        ? numeric
        : null;
    updateSky();
    return sessionTimeOfDayOverride;
}

// True while the sky follows the real clock: no authored scene hour, no ?time=
// link override and no host simulation clock. The in-world night notice
// offers daylight only then; every other clock was chosen on purpose.
export function isSceneClockRealTime() {
    return sessionTimeOfDayOverride == null
        && linkedTimeOfDayOverride == null
        && !(typeof window !== 'undefined' && typeof window.simClock?.getSimHour === 'function');
}

function getCurrentHour() {
    if (sessionTimeOfDayOverride != null) return sessionTimeOfDayOverride;
    if (linkedTimeOfDayOverride != null) return linkedTimeOfDayOverride;
    if (window.simClock && typeof window.simClock.getSimHour === 'function') {
        return window.simClock.getSimHour();
    }
    const parts = zagrebTimeFormatter.formatToParts(new Date());
    const get = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
    return get('hour') + get('minute') / 60 + get('second') / 3600;
}

// Reused every frame; mutated in place to avoid per-frame allocation.
const cachedSkyColor = new THREE.Color();
const envZenithColor = new THREE.Color();
const envHorizonColor = new THREE.Color();
const envGroundColor = new THREE.Color();
const envSunColor = new THREE.Color();
const paletteZenithColor = new THREE.Color();
const paletteHorizonColor = new THREE.Color();
const paletteGroundColor = new THREE.Color();
const paletteSunColor = new THREE.Color();
const warmHorizonColor = new THREE.Color(0xf3d9ad);
const daylightGroundColor = new THREE.Color(0x6f675a);
const warmSunColor = new THREE.Color(0xffb25e);
const overcastZenithColor = new THREE.Color(0x657580);
const overcastHorizonColor = new THREE.Color(0x929da2);
const overcastGroundColor = new THREE.Color(0x555f62);
const overcastSunColor = new THREE.Color(0xbfc7c9);
let envCanvas = null;
let envTexture = null;
let envPmrem = null;
let envRenderTarget = null;
let lastEnvKey = '';
let lastDaylight = 1;
let lastRainIntensity = 0;

export function getDaylightStrength(hour, sunHours = getApproximateZagrebSunHours()) {
    const normalizedHour = normalizeHour(hour);
    const sunriseHour = sunHours?.sunriseHour ?? REFERENCE_SUNRISE_HOUR;
    const sunsetHour = sunHours?.sunsetHour ?? REFERENCE_SUNSET_HOUR;
    const dawnStart = Math.max(0, sunriseHour - 1);
    const fullDayStart = Math.min(23.75, sunriseHour + 1.25);
    const goldenStart = Math.max(dawnStart, sunsetHour - 2);
    const duskEnd = Math.min(24, sunsetHour + 0.9);

    if (normalizedHour <= dawnStart) return 0;
    if (normalizedHour < fullDayStart) return smoothstep(dawnStart, fullDayStart, normalizedHour);
    if (normalizedHour <= goldenStart) return 1;
    if (normalizedHour < duskEnd) return 1 - smoothstep(goldenStart, duskEnd, normalizedHour);
    return 0;
}

// Master on/off for ALL night lighting (lit windows, car beams, streetlamps,
// tram windows, the walker's headlamp). Lets the user A/B the frame cost with
// the L key. Default on; only ever *suppresses* lights — nothing lights up by
// day regardless, since the night check still has to pass first.
let nightLightsEnabled = true;

export function toggleNightLights() {
    nightLightsEnabled = !nightLightsEnabled;
    updateSky();   // apply immediately instead of waiting for the next frame
    return nightLightsEnabled;
}

export function areNightLightsEnabled() {
    return nightLightsEnabled;
}

// Whether night lights should currently be ON: actually dark AND not muted by
// the L toggle. Exposed so the walk-mode camera gates the walker's headlamp on
// exactly the same condition the rest of the night lighting uses.
export function isSceneNight() {
    return isNightHour(getCurrentHour()) && nightLightsEnabled;
}

function isNightHour(hour, sunHours = getApproximateZagrebSunHours()) {
    const normalizedHour = normalizeHour(hour);
    const sunriseHour = sunHours?.sunriseHour ?? REFERENCE_SUNRISE_HOUR;
    const sunsetHour = sunHours?.sunsetHour ?? REFERENCE_SUNSET_HOUR;
    return normalizedHour >= sunsetHour + NIGHT_MARGIN_HOURS || normalizedHour < sunriseHour - NIGHT_MARGIN_HOURS;
}

function ensureEnvironmentResources() {
    if (!renderer) return false;
    if (!envCanvas) {
        envCanvas = document.createElement('canvas');
        envCanvas.width = 512;
        envCanvas.height = 256;
    }
    if (!envTexture) {
        envTexture = new THREE.CanvasTexture(envCanvas);
        envTexture.colorSpace = THREE.SRGBColorSpace;
        envTexture.mapping = THREE.EquirectangularReflectionMapping;
        envTexture.needsUpdate = true;
    }
    if (!envPmrem) {
        envPmrem = new THREE.PMREMGenerator(renderer);
        envPmrem.compileEquirectangularShader();
    }
    return true;
}

function updateWeatherPalette(zenith, horizon, ground, sunColor, sky, daylight, rainIntensity) {
    const weather = clamp01(rainIntensity);
    zenith.copy(sky).multiplyScalar(0.70 + daylight * 0.20)
        .lerp(overcastZenithColor, weather * 0.9);
    horizon.copy(sky).lerp(warmHorizonColor, daylight * 0.45)
        .lerp(overcastHorizonColor, weather * 0.88);
    ground.copy(sky).multiplyScalar(0.65)
        .lerp(daylightGroundColor, daylight * 0.45)
        .lerp(overcastGroundColor, weather * 0.82);
    sunColor.set(0xffffff).lerp(warmSunColor, 0.55)
        .multiplyScalar(0.45 + daylight * 0.85)
        .lerp(overcastSunColor, weather * 0.72)
        .multiplyScalar(1 - weather * 0.48);
}

function updateEnvironment(hour, sky, sunHours = getApproximateZagrebSunHours(), rainIntensity = 0) {
    if (!scene || !ensureEnvironmentResources()) return;
    // PMREM generation is substantial GPU work. Rain transitions may update
    // every frame, so the reflection environment advances through four cached
    // visual steps while direct light/fog/rain move smoothly every frame.
    const weatherStep = Math.round(clamp01(rainIntensity) * 4) / 4;
    const key = `${Math.round(hour * 6)}:${Math.round(sky.r * 255)}:${Math.round(sky.g * 255)}:${Math.round(sky.b * 255)}:${weatherStep}`;
    if (key === lastEnvKey) return;
    lastEnvKey = key;

    const daylight = getDaylightStrength(hour, sunHours);
    updateWeatherPalette(
        envZenithColor,
        envHorizonColor,
        envGroundColor,
        envSunColor,
        sky,
        daylight,
        weatherStep,
    );

    const ctx = envCanvas.getContext('2d');
    const w = envCanvas.width;
    const h = envCanvas.height;
    ctx.clearRect(0, 0, w, h);

    // Canvas pixels are sRGB; THREE colours are linear. Encoding with
    // getStyle avoids applying the sRGB transfer twice to the sky while fog
    // keeps its linear value. The equator (v=.5) must be exactly the fog colour.
    const skyGrad = ctx.createLinearGradient(0, 0, 0, h);
    skyGrad.addColorStop(0.00, envZenithColor.getStyle(THREE.SRGBColorSpace));
    skyGrad.addColorStop(0.46, envHorizonColor.getStyle(THREE.SRGBColorSpace));
    skyGrad.addColorStop(0.54, envHorizonColor.getStyle(THREE.SRGBColorSpace));
    skyGrad.addColorStop(0.68, envGroundColor.getStyle(THREE.SRGBColorSpace));
    skyGrad.addColorStop(1.00, envGroundColor.clone().multiplyScalar(0.5).getStyle(THREE.SRGBColorSpace));
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, w, h);

    const sunAlpha = daylight * 0.55;
    if (sunAlpha > 0.02) {
        const sunX = w * 0.73;
        const sunY = h * 0.24;
        const sunR = Math.round(envSunColor.r * 255);
        const sunG = Math.round(envSunColor.g * 255);
        const sunB = Math.round(envSunColor.b * 255);
        const sunGlow = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, h * 0.22);
        sunGlow.addColorStop(0.00, `rgba(${Math.min(255, sunR + 28)},${Math.min(255, sunG + 24)},${Math.min(255, sunB + 18)},${0.80 * sunAlpha})`);
        sunGlow.addColorStop(0.10, `rgba(${sunR},${sunG},${sunB},${0.45 * sunAlpha})`);
        sunGlow.addColorStop(0.40, `rgba(${sunR},${sunG},${sunB},${0.14 * sunAlpha})`);
        sunGlow.addColorStop(1.00, `rgba(${sunR},${sunG},${sunB},0)`);
        ctx.fillStyle = sunGlow;
        ctx.fillRect(sunX - h * 0.22, sunY - h * 0.22, h * 0.44, h * 0.44);
    }

    for (let i = 0; i < 4; i++) {
        const bandY = h * (0.16 + i * 0.08);
        ctx.strokeStyle = `rgba(255,255,255,${daylight * 0.027})`;
        ctx.lineWidth = 8 + i * 4;
        ctx.beginPath();
        for (let x = 0; x <= w; x += 16) {
            const yy = bandY + Math.sin((x / w) * Math.PI * (1.6 + i * 0.25) + i * 0.9) * (4 + i * 1.2);
            if (x === 0) ctx.moveTo(x, yy);
            else ctx.lineTo(x, yy);
        }
        ctx.stroke();
    }

    // three.js converts an equirectangular background to a cubemap once per
    // texture object and keeps that conversion until the texture is disposed
    // (WebGLCubeMaps); needsUpdate alone re-uploads the pixels the env map
    // reads but leaves the visible sky at the hour it was first rendered, so
    // a session hour change (the daylight offer, an authored scene) showed
    // lit facades under a night sky. Dispose before flagging the repaint so
    // the next frame converts the new painting; the object stays in use.
    envTexture.dispose();
    envTexture.needsUpdate = true;
    const nextTarget = envPmrem.fromEquirectangular(envTexture);
    if (envRenderTarget) envRenderTarget.dispose();
    envRenderTarget = nextTarget;
    scene.environment = envRenderTarget.texture;
}

// Drive the actual scene lights by daylight so the world darkens at night/dawn.
// Previously the sun/ambient were frozen at noon, so only the sky tint changed —
// a dim sky over fully-sunlit beige buildings read as "beige, not night". Night
// floors keep enough light to drive by; the dark sky + lit-window glow carry the
// mood. Day intensities are captured once from setup.js so the two stay in sync.
let _dayLight = null;
// Keep enough directional moonlight for perpendicular facades to read as
// different planes, instead of being flattened by omnidirectional ambient light.
const NIGHT_SUN = 0.16, NIGHT_FILL = 0.08, NIGHT_AMBIENT = 0.20;
function updateLights(daylight, rainIntensity = 0) {
    if (!sun) return;
    if (!_dayLight) {
        _dayLight = {
            sun: sun.intensity,
            fill: fill ? fill.intensity : 0,
            ambient: ambient ? ambient.intensity : 0,
        };
    }
    const weather = clamp01(rainIntensity);
    sun.intensity = _dayLight.sun * (NIGHT_SUN + (1 - NIGHT_SUN) * daylight) * (1 - weather * 0.7);
    if (fill) fill.intensity = _dayLight.fill * (NIGHT_FILL + (1 - NIGHT_FILL) * daylight) * (1 - weather * 0.4);
    if (ambient) ambient.intensity = _dayLight.ambient * (NIGHT_AMBIENT + (1 - NIGHT_AMBIENT) * daylight) * (1 - weather * 0.22);
}

// ─── Animated sun direction ─────────────────────────────────────────────────
// Unit vector from the scene toward the sun for the CURRENT sky hour, in the
// local frame (x = east, z = south, y = up). cab.js positions the shadow sun
// (and the mirrored fill) along this each frame, so shadows sweep from long
// westward ones at sunrise through short noon ones to long eastward ones at
// dusk. Elevation is clamped so grazing sun angles don't stretch the shadow
// map into shimmering streaks; at night the intensity is ~0 so the direction
// simply stops mattering. Defaults to the legacy fixed angle until the first
// updateSky().
let _sunDir = { x: 120 / 216, y: 160 / 216, z: 80 / 216 };
const MIN_SUN_ELEVATION_RAD = 6 * Math.PI / 180;

export function getSunDirection() {
    return _sunDir;
}

function updateSunDirection(hour, sunHours, date = new Date()) {
    const { decl } = getSolarAngles(date);
    const solarNoonHour = ((sunHours?.sunriseHour ?? REFERENCE_SUNRISE_HOUR) +
                           (sunHours?.sunsetHour ?? REFERENCE_SUNSET_HOUR)) / 2;
    const latRad = ZAGREB_LAT_DEG * Math.PI / 180;
    const hourAngle = (normalizeHour(hour) - solarNoonHour) * 15 * Math.PI / 180;
    const sinEl = Math.sin(latRad) * Math.sin(decl) +
        Math.cos(latRad) * Math.cos(decl) * Math.cos(hourAngle);
    const el = Math.max(Math.asin(clampSignedUnit(sinEl)), MIN_SUN_ELEVATION_RAD);
    // Azimuth from north, clockwise; the acos form gives the morning (east)
    // side, mirrored for afternoon hours.
    const cosAz = (Math.sin(decl) - Math.sin(latRad) * sinEl) /
        (Math.cos(latRad) * Math.cos(Math.asin(clampSignedUnit(sinEl))) || 1e-9);
    let az = Math.acos(clampSignedUnit(cosAz));
    if (hourAngle > 0) az = 2 * Math.PI - az;
    _sunDir = {
        x: Math.cos(el) * Math.sin(az),
        y: Math.sin(el),
        z: -Math.cos(el) * Math.cos(az),
    };
}

export function updateSky() {
    if (!scene) return;
    const hour = getCurrentHour();
    const sunHours = getApproximateZagrebSunHours();
    const sky = getSkyColorForHour(hour, sunHours);
    const rainIntensity = getRainIntensity();
    updateSunDirection(hour, sunHours);
    updateEnvironment(hour, sky, sunHours, rainIntensity);
    lastDaylight = getDaylightStrength(hour, sunHours);
    lastRainIntensity = rainIntensity;
    updateWeatherPalette(
        paletteZenithColor,
        paletteHorizonColor,
        paletteGroundColor,
        paletteSunColor,
        sky,
        lastDaylight,
        rainIntensity,
    );
    // Visible background = the same zenith→horizon gradient that feeds the env
    // map (painted on envCanvas), instead of a flat fill — so sunrise shows a
    // warm horizon band under a blue zenith. Fog matches the gradient's horizon
    // colour so distant buildings melt into the skyline. Falls back to the flat
    // colour until the gradient texture exists (e.g. before the renderer is up).
    scene.background = envTexture || sky;
    if (scene.fog) scene.fog.color.copy(envTexture ? paletteHorizonColor : sky);
    updateLights(lastDaylight, rainIntensity);
    // Sky colour / fog / sun follow the real hour; only the emissive "lights"
    // are additionally gated by the master toggle so L never changes daylight.
    const lightsOn = isNightHour(hour, sunHours) && nightLightsEnabled;
    setBuildingNightMode(lightsOn);
    setCarNightMode(lightsOn);
    setTramNightMode(lightsOn);
    setStreetLampNightMode(lightsOn);
}

// The painted sky's colours for the current hour, shared with the authored
// sky dome (scene/sky-dome.js) so the two skies agree. Linear colours reused
// every frame: read them, never keep or mutate them.
export function getSkyPalette() {
    return {
        zenith: paletteZenithColor,
        horizon: paletteHorizonColor,
        sun: paletteSunColor,
        daylight: lastDaylight,
        rainIntensity: lastRainIntensity,
    };
}

// Build the page-lifetime environment resources as part of scene
// initialisation, before a cab/static session starts publishing geometry.
// Leaving this to the first animation frame made PMREM's two shader programs,
// render target and internal LOD geometries appear nondeterministically in a
// later open/close cycle. These resources belong to the renderer singleton,
// not to an individual world session, so initialise them at the same boundary
// as the renderer itself and include them in every closed-session baseline.
export function initializeSkyEnvironment() {
    updateSky();
    return !!envRenderTarget;
}
