// Runtime geometry for the authored Blender road fleet. Fixed detail is baked
// into five material families and shared by every copy of a vehicle shape.
// Traffic, physics, placement and distance selection belong to their callers.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { station3dAssetUrl } from '../../core/asset-url.js';
import { registerShared, unregisterShared } from '../../core/dispose.js';
import { ROAD_TRAFFIC_VEHICLE_TYPES } from './traffic-vehicle-catalog.js';

const STUDIES = Object.freeze({
    compact: 'hatchback', sedan: 'sedan', suv: 'suv', van: 'van',
    truck: 'boxtruck', bus: 'citybus', ambulance: 'van', police: 'sedan',
    technical: 'pickup',
});
const sources = new Map();
const prepared = new Map();
let generation = 0;

function studyFor(type) {
    const study = STUDIES[type?.name];
    if (!study) throw new Error(`No road-fleet model for ${type?.name}`);
    return study;
}

function geometryKey(type) {
    return `${studyFor(type)}|${type.length}|${type.width}`;
}

function materialRole(name) {
    if (name.startsWith('Paint_')) return 'body';
    if (name === 'Glass') return 'glass';
    if (name === 'Lamp') return 'headlight';
    if (name === 'TailLamp') return 'taillight';
    return 'details';
}

function prepareGeometry(document, type) {
    if (document.id !== studyFor(type) || !Array.isArray(document.groups)
        || !(document.length > 0) || !document.materials) {
        throw new Error(`Invalid road-fleet document: ${studyFor(type)}`);
    }
    // Exclude mirrors and tyres from the body-width fit. The nominal length
    // keeps small bumper/number-plate projections and the authored proportions.
    let bodyHalfWidth = 0;
    let bottom = Infinity;
    for (const group of document.groups) {
        const positions = group.positions;
        if (!Array.isArray(positions) || !positions.length || positions.length % 3
            || !positions.every(Number.isFinite) || !Array.isArray(group.indices)
            || group.indices.length % 3 || !group.indices.every(index => (
                Number.isInteger(index) && index >= 0 && index < positions.length / 3
            )) || !document.materials[group.material]) {
            throw new Error(`Invalid road-fleet geometry: ${document.id}/${group.material}`);
        }
        const shell = /^(Paint_|White$|RoofGrey$)/.test(group.material);
        for (let index = 0; index < positions.length; index += 3) {
            if (shell) bodyHalfWidth = Math.max(bodyHalfWidth, Math.abs(positions[index]));
            bottom = Math.min(bottom, positions[index + 2]);
        }
    }
    if (!(bodyHalfWidth > 0) || !Number.isFinite(bottom)) {
        throw new Error(`Road-fleet model has no body: ${document.id}`);
    }
    const widthScale = type.width / (bodyHalfWidth * 2);
    const lengthScale = type.length / document.length;
    const buckets = new Map();
    const geometries = new Map();
    try {
        for (const group of document.groups) {
            const role = materialRole(group.material);
            const geometry = new THREE.BufferGeometry();
            if (!buckets.has(role)) buckets.set(role, []);
            buckets.get(role).push(geometry);
            const positions = new Float32Array(group.positions.length);
            for (let index = 0; index < positions.length; index += 3) {
                // A rotation, not a reflection: Blender +Y nose / +Z up
                // becomes Station3D +Z nose / +Y up with outward faces intact.
                positions[index] = -group.positions[index] * widthScale;
                positions[index + 1] = (group.positions[index + 2] - bottom) * lengthScale;
                positions[index + 2] = group.positions[index + 1] * lengthScale;
            }
            geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geometry.setIndex(group.indices);
            geometry.computeVertexNormals();
            if (role === 'details') {
                const color = document.materials[group.material].color || [1, 1, 1];
                const colors = new Float32Array(positions.length);
                for (let index = 0; index < colors.length; index += 3) colors.set(color, index);
                geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            }
        }
        for (const [role, parts] of buckets) {
            const geometry = mergeGeometries(parts, false);
            if (!geometry) throw new Error(`Cannot batch road-fleet ${document.id}/${role}`);
            geometries.set(role, geometry);
            geometry.computeBoundingBox();
            geometry.computeBoundingSphere();
        }
        if (geometries.size !== 5) throw new Error(`Incomplete road-fleet materials: ${document.id}`);
        for (const geometry of geometries.values()) registerShared(geometry);
        return { study: document.id, geometries };
    } catch (error) {
        for (const geometry of geometries.values()) geometry.dispose();
        throw error;
    } finally {
        for (const parts of buckets.values()) for (const geometry of parts) geometry.dispose();
    }
}

export async function preloadRoadFleetModels(types = ROAD_TRAFFIC_VEHICLE_TYPES) {
    const currentGeneration = generation;
    await Promise.all(types.filter(type => type.kind !== 'bicycle').map(async type => {
        const key = geometryKey(type);
        if (prepared.has(key)) return;
        const study = studyFor(type);
        if (!sources.has(study)) {
            const loading = fetch(station3dAssetUrl(
                `models/vehicles/fleet/${study}.json`,
            ), { cache: 'no-store' }).then(response => {
                if (!response.ok) throw new Error(`Cannot load road-fleet ${study} (${response.status})`);
                return response.json();
            });
            sources.set(study, loading);
            loading.catch(() => {
                if (currentGeneration === generation) sources.delete(study);
            });
        }
        const document = await sources.get(study);
        if (currentGeneration !== generation) throw new Error('Road-fleet preparation was cancelled');
        // Different variants can await the same source: recheck after loading
        // so police/sedan and ambulance/van share the same fitted buffers.
        if (!prepared.has(key)) prepared.set(key, prepareGeometry(document, type));
    }));
}

export function createRoadFleetDetail(type, materials) {
    const model = prepared.get(geometryKey(type));
    if (!model) throw new Error(`Road-fleet ${studyFor(type)} must be preloaded before publication`);
    const group = new THREE.Group();
    group.name = 'TrafficVehicleDetailedModel';
    group.userData.fleetStudy = model.study;
    const names = {
        body: 'TrafficVehiclePaintedBody', details: 'TrafficVehicleDetails',
        glass: 'TrafficVehicleWindows', headlight: 'TrafficVehicleHeadlights',
        taillight: 'TrafficVehicleTaillights',
    };
    for (const [role, geometry] of model.geometries) {
        if (!materials[role]) throw new Error(`Missing road-fleet material: ${role}`);
        const mesh = new THREE.Mesh(geometry, materials[role]);
        mesh.name = names[role];
        mesh.castShadow = role === 'body' || role === 'details';
        mesh.matrixAutoUpdate = false;
        group.add(mesh);
    }
    return group;
}

export function disposeRoadFleetModels() {
    generation += 1;
    for (const model of prepared.values()) {
        for (const geometry of model.geometries.values()) {
            unregisterShared(geometry);
            geometry.dispose();
        }
    }
    prepared.clear();
    sources.clear();
}
