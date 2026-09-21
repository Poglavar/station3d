// Camera-centred sky for authored scenes: the painted sky's own gradient, a
// sun disc where the directional sun actually stands, a layer of fair-weather
// cumulus at altitude with real parallax, and a lens flare while the sun is in
// frame. Drawn first and without depth, so everything else draws over it; at
// the horizon it becomes the fog colour the far world fades into.

import * as THREE from 'three';
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js';
import { buildTileableCloudNoise } from '../core/sky-clouds.js';
import { getSkyPalette, getSunDirection } from './sky.js';

// Inside every camera far plane the dome's scenes use (films clip at 800 m or
// more); depth testing is off, so the radius only has to survive clipping.
const DOME_RADIUS_M = 600;
const FLARE_DISTANCE_M = 560;
const CLOUD_TEXTURE_SIZE = 128;

// The noise is CPU work (~10 ms), built once per page; each dome owns and
// disposes its GPU texture.
let cloudNoiseRgba = null;

function createCloudTexture() {
    if (!cloudNoiseRgba) {
        const values = buildTileableCloudNoise({ size: CLOUD_TEXTURE_SIZE, octaves: 5, basePeriod: 4, seed: 11 });
        cloudNoiseRgba = new Uint8Array(values.length * 4);
        for (let index = 0; index < values.length; index++) {
            cloudNoiseRgba[index * 4] = values[index];
            cloudNoiseRgba[index * 4 + 1] = values[index];
            cloudNoiseRgba[index * 4 + 2] = values[index];
            cloudNoiseRgba[index * 4 + 3] = 255;
        }
    }
    const texture = new THREE.DataTexture(cloudNoiseRgba, CLOUD_TEXTURE_SIZE, CLOUD_TEXTURE_SIZE, THREE.RGBAFormat);
    texture.name = 'AuthoredSkyCloudNoise';
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.colorSpace = THREE.NoColorSpace;
    texture.needsUpdate = true;
    return texture;
}

const VERTEX_SHADER = /* glsl */`
varying vec3 vSkyDirection;

void main() {
    vSkyDirection = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */`
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uHaze;
uniform vec3 uSunColor;
uniform vec3 uSunDirection;
uniform float uDaylight;
uniform float uSunDisc;
uniform sampler2D uCloudMap;
uniform float uCloudCoverage;
uniform float uCloudHeight;
uniform float uCloudScale;
uniform vec2 uCloudOrigin;
varying vec3 vSkyDirection;

void main() {
    vec3 direction = normalize(vSkyDirection);
    float up = direction.y;
    vec3 sky = mix(uHorizon, uZenith, pow(clamp(up, 0.0, 1.0), 0.5));
    float cosSun = dot(direction, uSunDirection);
    float sunward = max(cosSun, 0.0);
    vec3 glow = uSunColor * uDaylight
        * (pow(sunward, 1400.0) * 1.2 + pow(sunward, 96.0) * 0.16 + pow(sunward, 8.0) * 0.05);

    // The cloud layer is a plane uCloudHeight metres above the camera: the
    // view ray meets it farther out the flatter it looks, so the field
    // converges on the horizon and slides past a moving camera.
    float cloud = 0.0;
    vec3 cloudColor = vec3(0.0);
    if (uCloudHeight > 0.0 && up > 0.012) {
        float distanceToLayer = uCloudHeight / up;
        vec2 uv = (uCloudOrigin + direction.xz * distanceToLayer) / uCloudScale;
        float field = texture2D(uCloudMap, uv).r * 0.62
            + texture2D(uCloudMap, uv * 2.83 + vec2(0.37, 0.71)).r * 0.38;
        float threshold = 1.0 - uCloudCoverage;
        float fade = exp(-distanceToLayer / 32000.0) * smoothstep(0.012, 0.16, up);
        cloud = smoothstep(threshold, threshold + 0.2, field) * fade;
        float lit = 0.78 + 0.22 * smoothstep(-0.3, 0.95, cosSun);
        float thick = smoothstep(threshold + 0.1, threshold + 0.45, field);
        cloudColor = mix(vec3(1.0), uHorizon * 0.9, 0.18) * lit * mix(1.0, 0.72, thick);
        cloudColor = mix(cloudColor, uHaze, 1.0 - fade);
        cloudColor *= mix(0.3, 1.0, uDaylight);
    }

    vec3 color = sky + glow * (1.0 - cloud * 0.85);
    color = mix(color, cloudColor, cloud);
    float disc = smoothstep(0.99990, 0.99996, cosSun) * uSunDisc * uDaylight;
    color += uSunColor * disc * 8.0 * (1.0 - cloud);

    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
    // At and below the horizon the air is the fog the far world fades into.
    // three.js mixes fog into lit surfaces after tone mapping and the output
    // conversion, with the raw fog colour, so the haze is mixed the same way.
    gl_FragColor.rgb = mix(gl_FragColor.rgb, uHaze, 1.0 - smoothstep(-0.02, 0.09, up));
}
`;

function radialTexture(size, stops) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    for (const [offset, color] of stops) gradient.addColorStop(offset, color);
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

function createSunFlare() {
    const glow = radialTexture(256, [
        [0, 'rgba(255,253,244,1)'],
        [0.18, 'rgba(255,240,214,0.6)'],
        [1, 'rgba(255,222,186,0)'],
    ]);
    const ghost = radialTexture(128, [
        [0, 'rgba(190,215,255,0.34)'],
        [0.6, 'rgba(150,190,255,0.12)'],
        [1, 'rgba(120,160,255,0)'],
    ]);
    const ring = radialTexture(128, [
        [0, 'rgba(0,0,0,0)'],
        [0.72, 'rgba(0,0,0,0)'],
        [0.84, 'rgba(170,205,255,0.3)'],
        [0.92, 'rgba(120,160,255,0)'],
        [1, 'rgba(0,0,0,0)'],
    ]);
    const flare = new Lensflare();
    flare.name = 'AuthoredSunFlare';
    // The glow stays smaller than a canopy seen from below, so a figure against
    // the sun still reads as a silhouette rather than vanishing into it.
    flare.addElement(new LensflareElement(glow, 240, 0, new THREE.Color(0xd9cdb8)));
    flare.addElement(new LensflareElement(ghost, 50, 0.35));
    flare.addElement(new LensflareElement(ring, 90, 0.55));
    flare.addElement(new LensflareElement(ghost, 64, 0.8));
    flare.addElement(new LensflareElement(ring, 130, 1));
    return flare;
}

// `config` is resolveSkyConfig()'s result. update() runs once per frame after
// the camera has its final pose; seaSceneY anchors the cloud base.
export function createSkyDome(config) {
    const authoredClouds = config?.clouds || null;
    // Keep the texture ready even for a normally clear authored sky so a live
    // weather transition can bring in cloud without rebuilding the sky dome.
    // The shader skips both texture reads while coverage is zero.
    const clouds = authoredClouds || {
        coverage: 0,
        altitudeM: 1450,
        scaleM: 3200,
        windMps: [-2.4, 0.85],
    };
    const cloudTexture = createCloudTexture();
    const baseSunDisc = config?.sunDisc === false ? 0 : 1;
    const uniforms = {
        uZenith: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uHaze: { value: new THREE.Color() },
        uSunColor: { value: new THREE.Color() },
        uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
        uDaylight: { value: 1 },
        uSunDisc: { value: baseSunDisc },
        uCloudMap: { value: cloudTexture },
        uCloudCoverage: { value: clouds?.coverage ?? 0 },
        uCloudHeight: { value: -1 },
        uCloudScale: { value: clouds?.scaleM ?? 1 },
        uCloudOrigin: { value: new THREE.Vector2() },
    };
    const material = new THREE.ShaderMaterial({
        name: 'AuthoredSkyDome',
        uniforms,
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        side: THREE.BackSide,
        depthTest: false,
        depthWrite: false,
        fog: false,
    });
    const geometry = new THREE.SphereGeometry(DOME_RADIUS_M, 48, 24);
    const dome = new THREE.Mesh(geometry, material);
    dome.name = 'AuthoredSkyDome';
    dome.frustumCulled = false;
    // Opaque and first: the rest of the frame depth-tests over it.
    dome.renderOrder = -1e6;
    const root = new THREE.Group();
    root.name = 'AuthoredSky';
    root.add(dome);
    const flare = config?.lensFlare === false ? null : createSunFlare();
    if (flare) root.add(flare);

    return {
        object: root,
        update({ camera, fogColor = null, seaSceneY = null, elapsedS = 0 }) {
            if (!camera) return;
            root.position.copy(camera.position);
            const palette = getSkyPalette();
            uniforms.uZenith.value.copy(palette.zenith);
            uniforms.uHorizon.value.copy(palette.horizon);
            uniforms.uHaze.value.copy(fogColor || palette.horizon);
            uniforms.uSunColor.value.copy(palette.sun);
            uniforms.uDaylight.value = palette.daylight;
            const rainIntensity = Math.max(0, Math.min(1, Number(palette.rainIntensity) || 0));
            uniforms.uSunDisc.value = baseSunDisc * (1 - rainIntensity * 0.98);
            const sun = getSunDirection();
            uniforms.uSunDirection.value.set(sun.x, sun.y, sun.z).normalize();
            const cloudCoverage = Math.max(authoredClouds?.coverage ?? 0, rainIntensity * 0.88);
            uniforms.uCloudCoverage.value = cloudCoverage;
            if (cloudCoverage > 0.005) {
                const cameraAltitudeM = camera.position.y - (Number.isFinite(seaSceneY) ? seaSceneY : 0);
                uniforms.uCloudHeight.value = clouds.altitudeM - cameraAltitudeM;
                // The field drifts with the wind: sample it upwind of the camera.
                uniforms.uCloudOrigin.value.set(
                    camera.position.x - clouds.windMps[0] * elapsedS,
                    camera.position.z - clouds.windMps[1] * elapsedS,
                );
            } else {
                uniforms.uCloudHeight.value = -1;
            }
            if (flare) {
                flare.position.copy(uniforms.uSunDirection.value).multiplyScalar(FLARE_DISTANCE_M);
                flare.visible = palette.daylight > 0.25 && sun.y > 0.02 && rainIntensity < 0.12;
            }
        },
        dispose() {
            root.removeFromParent();
            geometry.dispose();
            material.dispose();
            cloudTexture?.dispose();
            flare?.dispose();
        },
    };
}
