// One bounded, one-draw-call skid-mark mesh. Slots are overwritten FIFO, so a
// cross-country drive cannot grow scene objects or GPU buffers indefinitely.

import * as THREE from 'three';

import { skidMarkQuad } from '../core/gta-tire-effects.js';

const VERTICES_PER_MARK = 6;
const COMPONENTS_PER_VERTEX = 3;
const VALUES_PER_MARK = VERTICES_PER_MARK * COMPONENTS_PER_VERTEX;
const MIN_INTENSITY = 0.16;
const MIN_SPACING_M = 0.12;
const MAX_GAP_M = 2.5;

const SURFACE_COLORS = Object.freeze({
    asphalt: new THREE.Color(0x171513),
    terrain: new THREE.Color(0x4a3929),
});

export function createGtaSkidMarks({ parent, maxSegments = 640 } = {}) {
    const capacity = Math.max(1, Math.trunc(Number(maxSegments) || 640));
    const positions = new Float32Array(capacity * VALUES_PER_MARK);
    const colors = new Float32Array(capacity * VALUES_PER_MARK);
    const geometry = new THREE.BufferGeometry();
    const positionAttribute = new THREE.BufferAttribute(positions, 3);
    const colorAttribute = new THREE.BufferAttribute(colors, 3);
    positionAttribute.setUsage(THREE.DynamicDrawUsage);
    colorAttribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', positionAttribute);
    geometry.setAttribute('color', colorAttribute);
    geometry.setDrawRange(0, 0);
    const material = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.68,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'GtaSkidMarks';
    mesh.frustumCulled = false;
    mesh.renderOrder = 7;
    parent?.add?.(mesh);

    const previousByWheel = new Map();
    let writeIndex = 0;
    let segmentCount = 0;
    let totalWritten = 0;

    function breakWheel(wheelIndex) {
        previousByWheel.delete(wheelIndex);
    }

    function append(sample, intensity) {
        const wheelIndex = Number(sample?.wheelIndex);
        const color = SURFACE_COLORS[sample?.surfaceKind];
        const point = sample?.point;
        if (!Number.isInteger(wheelIndex) || !color || !point
            || intensity < MIN_INTENSITY) {
            if (Number.isInteger(wheelIndex)) breakWheel(wheelIndex);
            return false;
        }
        const current = {
            x: Number(point.x),
            y: Number(point.y),
            z: Number(point.z),
        };
        if (![current.x, current.y, current.z].every(Number.isFinite)) {
            breakWheel(wheelIndex);
            return false;
        }
        const previous = previousByWheel.get(wheelIndex);
        previousByWheel.set(wheelIndex, current);
        if (!previous) return false;
        const distance = Math.hypot(current.x - previous.x, current.z - previous.z);
        if (distance < MIN_SPACING_M) return false;
        if (distance > MAX_GAP_M) return false;
        const quad = skidMarkQuad(previous, current, 0.18, 0.018);
        if (!quad) return false;
        const offset = writeIndex * VALUES_PER_MARK;
        positions.set(quad, offset);
        const shade = 0.66 + Math.min(1, intensity) * 0.34;
        for (let vertex = 0; vertex < VERTICES_PER_MARK; vertex += 1) {
            const colorOffset = offset + vertex * 3;
            colors[colorOffset] = color.r * shade;
            colors[colorOffset + 1] = color.g * shade;
            colors[colorOffset + 2] = color.b * shade;
        }
        writeIndex = (writeIndex + 1) % capacity;
        segmentCount = Math.min(capacity, segmentCount + 1);
        totalWritten += 1;
        positionAttribute.needsUpdate = true;
        colorAttribute.needsUpdate = true;
        geometry.setDrawRange(0, segmentCount * VERTICES_PER_MARK);
        return true;
    }

    return {
        update(samples = []) {
            const active = new Set();
            for (const sample of Array.isArray(samples) ? samples : []) {
                const wheelIndex = Number(sample?.wheelIndex);
                if (!Number.isInteger(wheelIndex)) continue;
                active.add(wheelIndex);
                append(sample, Number(sample.intensity) || 0);
            }
            for (const wheelIndex of previousByWheel.keys()) {
                if (!active.has(wheelIndex)) breakWheel(wheelIndex);
            }
        },
        breakAll() {
            previousByWheel.clear();
        },
        debugState() {
            return { segmentCount, capacity, totalWritten };
        },
        dispose() {
            previousByWheel.clear();
            if (mesh.parent) mesh.parent.remove(mesh);
            geometry.dispose();
            material.dispose();
        },
    };
}
