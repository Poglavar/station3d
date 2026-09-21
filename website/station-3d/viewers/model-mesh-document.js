import * as THREE from 'three';

// The Blender fleet and boat studies were exported as per-material mesh groups.
// Keep this format readable by the common importer, including files opened by hand.
export function isMeshDocument(value) {
    return value && !Array.isArray(value) && Array.isArray(value.groups) && value.materials && !Array.isArray(value.materials);
}

export function parseMeshDocument(document) {
    if (!isMeshDocument(document)) throw new Error('Expected a model with material records and mesh groups.');
    const root = new THREE.Group();
    root.name = document.label || document.id || 'Blender mesh';
    root.rotation.x = -Math.PI / 2; // Blender Z-up -> Three.js Y-up
    const materials = new Map();
    for (const group of document.groups) {
        const positions = group.positions;
        const indices = group.indices;
        if (!Array.isArray(positions) || !positions.length || positions.length % 3 || !positions.every(Number.isFinite)
            || !Array.isArray(indices) || indices.length % 3 || !indices.every(index => Number.isInteger(index) && index >= 0 && index < positions.length / 3)) {
            throw new Error(`Invalid geometry in material group ${group.material}.`);
        }
        const record = document.materials[group.material];
        if (!record) throw new Error(`Missing material: ${group.material}.`);
        if (!materials.has(group.material)) {
            const alpha = record.alpha ?? 1;
            const material = new THREE.MeshStandardMaterial({
                name: group.material, color: new THREE.Color(...(record.color || [1, 1, 1])),
                roughness: record.roughness ?? .7, metalness: record.metalness ?? 0,
                opacity: alpha, transparent: alpha < 1, depthWrite: alpha >= 1,
                emissive: new THREE.Color(...(record.emissive || [0, 0, 0])),
                emissiveIntensity: record.emissiveStrength ?? 0, side: THREE.DoubleSide,
            });
            materials.set(group.material, material);
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setIndex(indices);
        if (Array.isArray(group.normals) && group.normals.length === positions.length && group.normals.every(Number.isFinite)) {
            geometry.setAttribute('normal', new THREE.Float32BufferAttribute(group.normals, 3));
        } else geometry.computeVertexNormals();
        const mesh = new THREE.Mesh(geometry, materials.get(group.material));
        mesh.name = group.material;
        root.add(mesh);
    }
    return { object: root };
}
