// Reusable low-poly palm geometry. The model is normalized so the world layer
// can instance it at the OSM tree height without loading a mesh per tree.
import * as THREE from 'three';

const TRUNK_LIGHT = [0.47, 0.32, 0.16];
const TRUNK_DARK = [0.38, 0.24, 0.105];
const FROND_OUTER = [0.12, 0.34, 0.13];
const FROND_MIDDLE = [0.18, 0.46, 0.18];
const FROND_INNER = [0.30, 0.57, 0.22];
const FROND_DRY = [0.38, 0.25, 0.10];

function pushTriangle(positions, colors, a, b, c, color) {
    for (const point of [a, b, c]) {
        positions.push(point.x, point.y, point.z);
        colors.push(...color);
    }
}

function pushQuad(positions, colors, a, b, c, d, colorA, colorB = colorA) {
    pushTriangle(positions, colors, a, b, c, colorA);
    pushTriangle(positions, colors, a, c, d, colorB);
}

export function palmTrunkGeometryData(radialSegments = 8, heightSegments = 18) {
    const radialCount = Math.max(6, Math.round(radialSegments));
    const heightCount = Math.max(6, Math.round(heightSegments));
    const positions = [];
    const colors = [];
    const radiusAt = (t, ring) => {
        const taper = 1.04 - t * 0.28;
        const ringRelief = ring % 2 === 0 ? 0.026 : -0.012;
        const crownBulb = t > 0.86 ? (t - 0.86) / 0.14 * 0.34 : 0;
        return taper + ringRelief + crownBulb;
    };

    for (let ring = 0; ring < heightCount; ring += 1) {
        const t0 = ring / heightCount;
        const t1 = (ring + 1) / heightCount;
        const r0 = radiusAt(t0, ring);
        const r1 = radiusAt(t1, ring + 1);
        const twist0 = (ring % 2) * Math.PI / radialCount;
        const twist1 = ((ring + 1) % 2) * Math.PI / radialCount;
        const bandColor = ring % 2 === 0 ? TRUNK_LIGHT : TRUNK_DARK;
        for (let side = 0; side < radialCount; side += 1) {
            const a0 = side * Math.PI * 2 / radialCount + twist0;
            const a1 = (side + 1) * Math.PI * 2 / radialCount + twist0;
            const b0 = side * Math.PI * 2 / radialCount + twist1;
            const b1 = (side + 1) * Math.PI * 2 / radialCount + twist1;
            pushQuad(positions, colors,
                { x: Math.cos(a0) * r0, y: t0, z: Math.sin(a0) * r0 },
                { x: Math.cos(b0) * r1, y: t1, z: Math.sin(b0) * r1 },
                { x: Math.cos(b1) * r1, y: t1, z: Math.sin(b1) * r1 },
                { x: Math.cos(a1) * r0, y: t0, z: Math.sin(a1) * r0 },
                bandColor,
            );
        }
    }
    return { positions, colors };
}

function frondPoint(angle, reach, layer, t) {
    const radial = reach * t;
    let y;
    if (layer === 'inner') y = 0.04 + Math.sin(t * Math.PI * 0.82) * 0.52 - t * 0.12;
    else if (layer === 'middle') y = 0.07 + Math.sin(t * Math.PI) * 0.24 - t * t * 0.23;
    else if (layer === 'dry') y = 0.01 - t * 0.16 - t * t * 0.48;
    else y = 0.04 + Math.sin(t * Math.PI) * 0.12 - t * t * 0.44;
    return { x: Math.cos(angle) * radial, y, z: Math.sin(angle) * radial };
}

function appendFrond(positions, colors, { angle, reach, layer, segmentCount = 7 }) {
    const across = { x: -Math.sin(angle), z: Math.cos(angle) };
    const direction = { x: Math.cos(angle), z: Math.sin(angle) };
    const color = layer === 'inner' ? FROND_INNER
        : layer === 'middle' ? FROND_MIDDLE
            : layer === 'dry' ? FROND_DRY
                : FROND_OUTER;
    const points = Array.from({ length: segmentCount + 1 }, (_, index) => (
        frondPoint(angle, reach, layer, index / segmentCount)
    ));

    // A tapered blade gives the frond readable mass at street distance; the
    // individual leaflets below break its edge into the feathered silhouette.
    for (let index = 0; index < segmentCount; index += 1) {
        const t0 = index / segmentCount;
        const t1 = (index + 1) / segmentCount;
        const bladeScale = layer === 'inner' ? 0.72 : layer === 'dry' ? 0.55 : 1;
        const width0 = (0.018 + Math.sin(t0 * Math.PI) * 0.082) * bladeScale;
        const width1 = (0.018 + Math.sin(t1 * Math.PI) * 0.082) * bladeScale;
        const p0 = points[index];
        const p1 = points[index + 1];
        pushQuad(positions, colors,
            { x: p0.x + across.x * width0, y: p0.y, z: p0.z + across.z * width0 },
            { x: p1.x + across.x * width1, y: p1.y, z: p1.z + across.z * width1 },
            { x: p1.x - across.x * width1, y: p1.y, z: p1.z - across.z * width1 },
            { x: p0.x - across.x * width0, y: p0.y, z: p0.z - across.z * width0 },
            color,
        );
    }

    // Paired narrow leaflets create the feathered silhouette of a date palm.
    if (layer === 'dry') return;
    for (let index = 1; index < segmentCount; index += 1) {
        const t = index / segmentCount;
        const center = points[index];
        const leafletLength = (0.22 - t * 0.10) * (layer === 'inner' ? 0.72 : 1);
        const rootHalfWidth = 0.016;
        const tipHalfWidth = 0.010;
        const sweep = (0.035 + t * 0.035) * reach;
        for (const side of [-1, 1]) {
            const tip = {
                x: center.x + across.x * leafletLength * side - direction.x * sweep,
                y: center.y - 0.025 - t * 0.035,
                z: center.z + across.z * leafletLength * side - direction.z * sweep,
            };
            const rootA = {
                x: center.x + direction.x * rootHalfWidth,
                y: center.y + 0.004,
                z: center.z + direction.z * rootHalfWidth,
            };
            const rootB = {
                x: center.x - direction.x * rootHalfWidth,
                y: center.y - 0.004,
                z: center.z - direction.z * rootHalfWidth,
            };
            const tipA = {
                x: tip.x + direction.x * tipHalfWidth,
                y: tip.y + 0.003,
                z: tip.z + direction.z * tipHalfWidth,
            };
            const tipB = {
                x: tip.x - direction.x * tipHalfWidth,
                y: tip.y - 0.003,
                z: tip.z - direction.z * tipHalfWidth,
            };
            pushQuad(positions, colors, rootA, tipA, tipB, rootB, color);
        }
    }
}

export function palmCrownGeometryData() {
    const positions = [];
    const colors = [];
    const layers = [
        { count: 10, reach: 1, layer: 'outer', offset: 0 },
        { count: 7, reach: 0.82, layer: 'middle', offset: Math.PI / 7 },
        { count: 4, reach: 0.57, layer: 'inner', offset: Math.PI / 4 },
        { count: 3, reach: 0.68, layer: 'dry', offset: Math.PI / 3 },
    ];
    for (const { count, reach, layer, offset } of layers) {
        for (let index = 0; index < count; index += 1) {
            appendFrond(positions, colors, {
                angle: offset + index * Math.PI * 2 / count,
                reach,
                layer,
            });
        }
    }
    return { positions, colors };
}

function geometryFrom(data) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(data.colors, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
}

export function createPalmTreeParts() {
    return {
        trunkGeo: geometryFrom(palmTrunkGeometryData()),
        crownGeo: geometryFrom(palmCrownGeometryData()),
        trunkMat: new THREE.MeshStandardMaterial({
            color: 0xffffff,
            vertexColors: true,
            roughness: 0.96,
            flatShading: true,
        }),
        crownMat: new THREE.MeshStandardMaterial({
            color: 0xffffff,
            vertexColors: true,
            roughness: 0.86,
            side: THREE.DoubleSide,
        }),
    };
}
