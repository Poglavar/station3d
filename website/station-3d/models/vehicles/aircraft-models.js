// Shared aircraft selection and bounded asset preparation. World layers await
// the asset during their normal startup, then publish complete model instances.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { station3dAssetUrl } from '../../core/asset-url.js';
import { disposeGroup } from '../../core/dispose.js';
import { createAirplaneMesh } from './boat-airplane.js';
import { createUtvaAirplaneMesh } from './utva-airplane.js';

let utvaSource = null;
let utvaLoading = null;
let cacheGeneration = 0;
const utvaTemplates = new Map();
const interiorKey = interior => interior === 'smuggler' ? 'smuggler' : null;

export async function preloadAircraftModels(specs = []) {
    if (!specs.some(spec => spec?.model === 'utva')) return;
    const generation = cacheGeneration;
    if (!utvaLoading) {
        utvaLoading = new GLTFLoader().loadAsync(station3dAssetUrl('models/vehicles/utva-liaison.glb'))
            .then(gltf => {
                if (generation !== cacheGeneration) { disposeGroup(gltf.scene); return; }
                utvaSource = gltf.scene;
            })
            .catch(error => { if (generation === cacheGeneration) utvaLoading = null; throw error; });
    }
    await utvaLoading;
    if (generation !== cacheGeneration) throw new Error('Aircraft asset preparation was cancelled');
    for (const spec of specs) {
        if (spec?.model !== 'utva') continue;
        const interior = interiorKey(spec.interior);
        if (utvaTemplates.has(interior)) continue;
        const template = createUtvaAirplaneMesh(utvaSource, { interior });
        // Object references are rebound on each clone, never serialized as data.
        delete template.userData.pilotSeat;
        delete template.userData.propeller;
        utvaTemplates.set(interior, template);
    }
}

export function createAircraftMesh({ model = null, interior = null } = {}) {
    if (model === 'utva') {
        const template = utvaTemplates.get(interiorKey(interior));
        if (!template) throw new Error('UTVA aircraft must be preloaded before publication');
        const root = template.clone(true);
        const materials = new Map();
        root.traverse(node => {
            if (!node.isMesh) return;
            node.geometry = node.geometry.clone();
            if (!materials.has(node.material)) materials.set(node.material, node.material.clone());
            node.material = materials.get(node.material);
        });
        root.userData.pilotSeat = root.getObjectByName('GtaAirplanePilotSeat');
        root.userData.propeller = root.getObjectByName('GtaAirplanePropeller');
        return root;
    }
    if (model != null) throw new Error(`Unknown aircraft model: ${model}`);
    return createAirplaneMesh({ interior });
}

// Live instances own their buffers; clearing the bounded preparation cache
// cannot dispose any aircraft already published in a scene.
export function disposeAircraftModelCache() {
    cacheGeneration += 1;
    disposeGroup(utvaSource);
    for (const template of utvaTemplates.values()) disposeGroup(template);
    utvaTemplates.clear();
    utvaSource = null;
    utvaLoading = null;
}
