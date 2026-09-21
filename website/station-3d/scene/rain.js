// One camera-centred GPU rain field. Static particle seeds are uploaded once;
// the vertex shader performs all falling/wrapping/wind movement. Per frame the
// CPU updates only time, camera position, weather intensity and shelter state.

import * as THREE from 'three';
import { getRainIntensity } from '../core/weather.js';
import { buildRainField, rainParticleCountForQuality } from '../core/rain-field.js';
import { resolveRainShelter } from '../core/rain-shelter.js';
import { state } from '../state.js';
import { camera, renderer, scene, getRenderQualityContext } from './setup.js';
import { getRainAudioSnapshot, silenceRainAudio, updateRainAudio } from '../ui/rain-audio.js';

const FIELD_RADIUS_M = 34;
const FIELD_HEIGHT_M = 30;
const FIELD_TOP_M = 18;
const FALL_SPEED_MPS = 19;
const EXPOSURE_RATE_PER_S = 5;

const VERTEX_SHADER = /* glsl */`
uniform float uTime;
uniform float uIntensity;
uniform float uPixelRatio;
uniform float uRadius;
uniform float uHeight;
uniform float uTop;
uniform float uInnerRadius;
uniform vec2 uWind;
uniform vec3 uObserver;
attribute float aPhase;
attribute float aScale;
varying float vAlpha;
varying float vScale;

void main() {
    float cycle = fract(aPhase + uTime * (${FALL_SPEED_MPS.toFixed(1)} / uHeight) * mix(0.86, 1.14, aScale));
    vec2 radial = position.xz;
    float radialUnit = max(length(radial), 0.0001);
    float radiusM = mix(uInnerRadius, uRadius, radialUnit);
    radial = normalize(radial) * radiusM;
    vec2 windOffset = uWind * (cycle - 0.5) * 0.7;
    vec3 worldPosition = vec3(
        uObserver.x + radial.x + windOffset.x,
        uObserver.y + uTop - cycle * uHeight,
        uObserver.z + radial.y + windOffset.y
    );
    vec4 viewPosition = viewMatrix * vec4(worldPosition, 1.0);
    gl_Position = projectionMatrix * viewPosition;
    float distanceM = max(1.0, -viewPosition.z);
    float perspective = clamp(18.0 / distanceM, 0.58, 1.45);
    gl_PointSize = clamp((5.0 + 9.0 * aScale) * uPixelRatio * perspective, 2.0, 28.0);
    float edgeFade = 1.0 - smoothstep(uRadius * 0.78, uRadius, radiusM);
    float verticalFade = smoothstep(0.0, 0.08, cycle) * (1.0 - smoothstep(0.9, 1.0, cycle));
    vAlpha = uIntensity * edgeFade * verticalFade * mix(0.48, 0.92, aScale);
    vScale = aScale;
}
`;

const FRAGMENT_SHADER = /* glsl */`
uniform vec3 uColor;
uniform float uSlant;
varying float vAlpha;
varying float vScale;

void main() {
    vec2 uv = gl_PointCoord;
    float centerX = 0.5 + (uv.y - 0.5) * uSlant;
    float width = mix(0.085, 0.045, vScale);
    float streak = 1.0 - smoothstep(width * 0.35, width, abs(uv.x - centerX));
    float cap = smoothstep(0.0, 0.13, uv.y) * (1.0 - smoothstep(0.78, 1.0, uv.y));
    float alpha = vAlpha * streak * cap;
    if (alpha < 0.008) discard;
    gl_FragColor = vec4(uColor, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

let rainPoints = null;
let rainMaterial = null;
let rainProfileId = '';
let visibleSession = false;
let exposure = 1;
let elapsedS = 0;
let lastFrameMs = 0;

function disposeRainField() {
    if (!rainPoints) return;
    rainPoints.removeFromParent();
    rainPoints.geometry.dispose();
    rainPoints.material.dispose();
    rainPoints = null;
    rainMaterial = null;
    rainProfileId = '';
}

function createRainField(profileId) {
    disposeRainField();
    const field = buildRainField(rainParticleCountForQuality(profileId));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(field.positions, 3));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(field.phases, 1));
    geometry.setAttribute('aScale', new THREE.BufferAttribute(field.scales, 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), FIELD_RADIUS_M + FIELD_HEIGHT_M);
    rainMaterial = new THREE.ShaderMaterial({
        name: 'Station3DRain',
        uniforms: {
            uTime: { value: 0 },
            uIntensity: { value: 0 },
            uPixelRatio: { value: 1 },
            uRadius: { value: FIELD_RADIUS_M },
            uHeight: { value: FIELD_HEIGHT_M },
            uTop: { value: FIELD_TOP_M },
            uInnerRadius: { value: 1.2 },
            uWind: { value: new THREE.Vector2(-2.4, 0.85) },
            uObserver: { value: new THREE.Vector3() },
            uColor: { value: new THREE.Color(0xcfe1eb) },
            uSlant: { value: -0.14 },
        },
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        blending: THREE.NormalBlending,
        toneMapped: true,
    });
    rainPoints = new THREE.Points(geometry, rainMaterial);
    rainPoints.name = 'Station3DRain';
    rainPoints.frustumCulled = false;
    rainPoints.renderOrder = 900;
    scene.add(rainPoints);
    rainProfileId = profileId;
}

function moveTowards(current, target, maxDelta) {
    if (Math.abs(target - current) <= maxDelta) return target;
    return current + Math.sign(target - current) * maxDelta;
}

export function updateRain(nowMs = performance.now()) {
    if (!scene || !camera || !renderer) return;
    const dt = lastFrameMs > 0 ? Math.min(0.1, Math.max(0, (nowMs - lastFrameMs) / 1000)) : 0;
    lastFrameMs = nowMs;
    elapsedS += dt;
    const rainIntensity = visibleSession ? getRainIntensity(nowMs) : 0;
    const shelter = resolveRainShelter(state.cabState);
    exposure = moveTowards(exposure, shelter.visualExposure, EXPOSURE_RATE_PER_S * dt);
    const visualIntensity = rainIntensity * exposure;

    if (visualIntensity > 0.002) {
        const quality = getRenderQualityContext();
        if (!rainPoints || quality.profileId !== rainProfileId) createRainField(quality.profileId);
        rainPoints.visible = true;
        rainMaterial.uniforms.uTime.value = elapsedS;
        rainMaterial.uniforms.uIntensity.value = visualIntensity;
        rainMaterial.uniforms.uPixelRatio.value = Math.min(2, Number(renderer.getPixelRatio()) || 1);
        rainMaterial.uniforms.uInnerRadius.value = shelter.innerRadiusM;
        rainMaterial.uniforms.uObserver.value.copy(camera.position);
    } else if (rainPoints) {
        rainPoints.visible = false;
    }

    const audioLevel = rainIntensity * shelter.audioExposure;
    updateRainAudio(audioLevel, shelter.muffled);
}

if (typeof window !== 'undefined') {
    window.addEventListener('station3d:visibility', (event) => {
        visibleSession = event?.detail?.active === true;
        if (!visibleSession) {
            lastFrameMs = 0;
            if (rainPoints) rainPoints.visible = false;
            silenceRainAudio();
        }
    });
}

export function getRainRenderSnapshot() {
    return Object.freeze({
        active: !!rainPoints?.visible,
        particles: rainPoints?.geometry?.getAttribute('position')?.count || 0,
        profileId: rainProfileId || null,
        drawCalls: rainPoints?.visible ? 1 : 0,
        exposure,
        audio: getRainAudioSnapshot(),
    });
}
