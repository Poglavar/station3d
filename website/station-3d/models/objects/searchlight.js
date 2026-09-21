// A searchlight for the tower's opening night: a pedestal, the lamp drum it
// carries, and the beam the drum throws as a soft additive cone with a glowing
// lens cap. Built for instancing, one geometry per part, so a rig of six lamps
// is three draws. The drum and its beam point along local +Y from the pivot,
// which sits SEARCHLIGHT_PIVOT_HEIGHT_M above the pedestal's foot.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const SEARCHLIGHT_PIVOT_HEIGHT_M = 1.05;
// The lens face, measured from the pivot along the drum's axis.
export const SEARCHLIGHT_LENS_OFFSET_M = 0.72;

const HOUSING_GREY = 0x2d3135;
const HOUSING_DARK = 0x16191c;
const LENS_RIM = 0xb9bcc0;

function coloured(geometry, hex, [x, y, z]) {
    const colour = new THREE.Color(hex);
    const count = geometry.getAttribute('position').count;
    const colours = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) {
        colours[index * 3] = colour.r;
        colours[index * 3 + 1] = colour.g;
        colours[index * 3 + 2] = colour.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    geometry.translate(x, y, z);
    return geometry;
}

function merged(parts) {
    const geometry = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
}

export function createSearchlightPedestalGeometry() {
    const postHeightM = SEARCHLIGHT_PIVOT_HEIGHT_M - 0.3;
    return merged([
        coloured(new THREE.BoxGeometry(1.2, 0.3, 1.2), HOUSING_DARK, [0, 0.15, 0]),
        coloured(new THREE.CylinderGeometry(0.13, 0.17, postHeightM, 10), HOUSING_GREY, [0, 0.3 + postHeightM / 2, 0]),
    ]);
}

export function createSearchlightDrumGeometry() {
    return merged([
        coloured(new THREE.CylinderGeometry(0.6, 0.5, 1.15, 18), HOUSING_GREY, [0, 0.1, 0]),
        coloured(new THREE.CylinderGeometry(0.66, 0.66, 0.1, 18), LENS_RIM, [0, 0.66, 0]),
        coloured(new THREE.CylinderGeometry(0.46, 0.4, 0.14, 14), HOUSING_DARK, [0, -0.53, 0]),
    ]);
}

export function createSearchlightHousingMaterial() {
    return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.45 });
}

export function createSearchlightBeamGeometry({ lengthM, lensRadiusM, halfAngleRad, radialSegments = 20 } = {}) {
    const topRadiusM = lensRadiusM + lengthM * Math.tan(halfAngleRad);
    const cone = new THREE.CylinderGeometry(topRadiusM, lensRadiusM, lengthM, radialSegments, 4, true);
    cone.translate(0, SEARCHLIGHT_LENS_OFFSET_M + lengthM / 2, 0);
    const lens = new THREE.CircleGeometry(lensRadiusM, radialSegments);
    lens.rotateX(-Math.PI / 2);
    lens.translate(0, SEARCHLIGHT_LENS_OFFSET_M, 0);
    return merged([cone, lens]);
}

const BEAM_VERTEX = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uLength;
uniform float uLensOffset;
varying float vAlong;
varying vec3 vViewNormal;
varying vec3 vViewPosition;

void main() {
    vAlong = clamp((position.y - uLensOffset) / uLength, 0.0, 1.0);
    mat4 localToWorld = modelMatrix;
    #ifdef USE_INSTANCING
    localToWorld = modelMatrix * instanceMatrix;
    #endif
    vec4 viewPosition = viewMatrix * localToWorld * vec4(position, 1.0);
    vViewPosition = viewPosition.xyz;
    vViewNormal = normalize(mat3(viewMatrix * localToWorld) * normal);
    gl_Position = projectionMatrix * viewPosition;
    #include <logdepthbuf_vertex>
}
`;

const BEAM_FRAGMENT = /* glsl */`
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
uniform float uLevel;
uniform float uLength;
varying float vAlong;
varying vec3 vViewNormal;
varying vec3 vViewPosition;

void main() {
    #include <logdepthbuf_fragment>
    vec3 viewDir = normalize(-vViewPosition);
    // A cone of light is thickest where the eye looks through its middle and
    // thin air at its silhouette, so brightness follows how squarely the
    // surface faces the eye.
    float facing = abs(dot(normalize(vViewNormal), viewDir));
    float body = facing * facing;
    float along = pow(1.0 - vAlong, 1.8);
    // Glare within the first few metres of the lens, and the lens cap itself.
    float glare = exp(-vAlong * uLength / 6.0);
    float alpha = uLevel * (body * along * 0.3 + glare * 0.8);
    if (alpha < 0.003) discard;
    gl_FragColor = vec4(uColor, min(alpha, 1.0));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

export function createSearchlightBeamMaterial({ lengthM, color = 0xfff0d2 } = {}) {
    return new THREE.ShaderMaterial({
        name: 'SearchlightBeam',
        uniforms: {
            uColor: { value: new THREE.Color(color) },
            uLevel: { value: 0 },
            uLength: { value: lengthM },
            uLensOffset: { value: SEARCHLIGHT_LENS_OFFSET_M },
        },
        vertexShader: BEAM_VERTEX,
        fragmentShader: BEAM_FRAGMENT,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
    });
}

export function setSearchlightBeamLevel(material, level) {
    const value = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0));
    material.uniforms.uLevel.value = value;
    return value;
}
