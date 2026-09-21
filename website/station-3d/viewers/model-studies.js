import * as THREE from 'three';
import { disposePreview, modelBounds, normalizePreview } from './model-viewer-core.js';

export function studyCatalog(manifest, importer, baseURL) {
    const publicURL = path => new URL(path.replace(/^website\//, ''), baseURL).href;
    const entries = manifest.filter(asset => asset.model.startsWith('website/')).map(asset => ({
        id: asset.id, label: asset.label, category: asset.category, description: asset.description, provenance: asset.provenance,
        llmModel: asset.llmModel || 'Not recorded',
        collection: asset.collection || 'studies', source: publicURL(asset.source || asset.model),
        sourceLabel: asset.source?.endsWith('.blend') ? 'Download Blender source' : 'Model source',
        create: async () => {
            const preview = await importer.url(publicURL(asset.model), { format: asset.format });
            const object = new THREE.Group();
            object.name = asset.label;
            object.rotation.y = asset.yaw || 0;
            object.add(preview.object);
            preview.object = object;
            preview.cameraViews = asset.cameraViews || {};
            if (asset.partControls?.length) {
                const parts = asset.partControls.map(control => {
                    const part = object.getObjectByName(control.node);
                    if (!part) {
                        disposePreview(preview);
                        throw new Error(`Missing model part: ${control.node}`);
                    }
                    return { control, part };
                });
                preview.controls = [...(preview.controls || []), ...parts.map(({ control }) => ({
                    id: control.id, label: control.label, type: 'checkbox', value: true,
                }))];
                const updateParts = (_time, state = {}) => {
                    for (const { control, part } of parts) part.visible = state[control.id] !== false;
                };
                const update = preview.update, seek = preview.seek;
                preview.update = (time, dt, state) => { update?.(time, dt, state); updateParts(time, state); };
                preview.seek = (time, state) => { seek?.(time, state); updateParts(time, state); };
            }
            preview.references = (asset.referenceImages || []).map(reference => ({ label: reference.label, url: publicURL(reference.path) }));
            if (typeof asset.waterline === 'number') preview.waterline = asset.waterline;
            object.traverse(part => {
                if ((asset.hideNodes || []).includes(part.name)) part.visible = false;
                for (const material of [].concat(part.material || [])) {
                    if ((asset.alphaCutoutMaterials || []).some(name => material.name.includes(name))) {
                        material.alphaTest = .32; material.transparent = false; material.depthWrite = true;
                    }
                }
            });
            if (asset.nightEmissiveMultiplier) {
                const strengths = new Map();
                object.traverse(part => {
                    for (const material of [].concat(part.material || [])) strengths.set(material, material.emissiveIntensity);
                });
                preview.setLighting = night => {
                    for (const [material, intensity] of strengths) material.emissiveIntensity = intensity * (night ? asset.nightEmissiveMultiplier : 1);
                };
            }
            return preview;
        },
    }));
    const fleet = manifest.filter(asset => asset.fleet === 'current').map(asset => entries.find(entry => entry.id === asset.id));
    if (fleet.length) entries.splice(1, 0, {
        id: 'study-fleet-lineup', label: 'Fleet line-up', category: 'vehicles', collection: 'studies', provenance: 'Blender', llmModel: 'Not recorded',
        description: `${fleet.length} detailed vehicles at their original scale, including the TMK tram and HŽ train.`,
        source: publicURL('website/station-3d/models/vehicles/studies/fleet/build_fleet.py'),
        create: () => fleetLineup(fleet),
    });
    return entries;
}

export async function fleetLineup(entries) {
    const root = new THREE.Group();
    root.name = 'Fleet line-up';
    const previews = [];
    try {
        // Sequential loads keep the all-fleet view from spiking memory/network.
        let x = 0;
        for (const entry of entries) {
            const preview = normalizePreview(await entry.create());
            previews.push(preview);
            const holder = new THREE.Group();
            holder.add(preview.object); holder.rotation.y = Math.PI / 2;
            const bounds = modelBounds(holder), size = bounds.getSize(new THREE.Vector3());
            const center = bounds.getCenter(new THREE.Vector3());
            holder.position.set(x + size.x / 2 - center.x, -bounds.min.y, -center.z);
            root.add(holder);
            x += size.x + 4;
        }
        return { object: root, setLighting: night => previews.forEach(preview => preview.setLighting?.(night)) };
    } catch (error) {
        for (const preview of previews) disposePreview(preview);
        throw error;
    }
}
