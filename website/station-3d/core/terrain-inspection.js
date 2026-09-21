// Pure reversible scene-visibility/material controller used by the Station3D
// terrain-only diagnostic and its headless tests.

import * as THREE from 'three';

export function createTerrainInspectionController({
    targetSceneProvider,
    terrainGroupProvider,
    wireframeMaterial,
} = {}) {
    const diagnosticMaterial = wireframeMaterial || new THREE.MeshBasicMaterial({
        color: 0x52e3a4,
        wireframe: true,
        depthTest: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
    });
    const visibilitySnapshot = new Map();
    const materialSnapshot = new Map();
    const overlays = new Map();
    let mode = 'normal';

    const terrainMeshes = (terrainGroup) => {
        const meshes = [];
        terrainGroup?.traverse?.((object) => {
            if (object?.isMesh && !object.userData?.terrainInspectionOverlay) {
                meshes.push(object);
            }
        });
        return meshes;
    };

    const clearOverlays = () => {
        for (const overlay of overlays.values()) overlay.removeFromParent?.();
        overlays.clear();
    };

    const isolateTerrain = (targetScene, terrainGroup) => {
        for (const child of targetScene?.children || []) {
            if (!visibilitySnapshot.has(child)) {
                visibilitySnapshot.set(child, child.visible);
            }
            child.visible = child === terrainGroup;
        }
        terrainGroup.visible = true;
    };

    const enforceOverlay = (targetScene, terrainGroup) => {
        isolateTerrain(targetScene, terrainGroup);
        const current = new Set(terrainMeshes(terrainGroup));
        for (const [mesh, overlay] of overlays) {
            if (current.has(mesh)) continue;
            overlay.removeFromParent?.();
            overlays.delete(mesh);
        }
        for (const mesh of current) {
            let overlay = overlays.get(mesh);
            if (!overlay) {
                overlay = new THREE.Mesh(mesh.geometry, diagnosticMaterial);
                overlay.name = 'TerrainInspectionOverlay';
                overlay.userData.terrainInspectionOverlay = true;
                overlay.castShadow = false;
                overlay.receiveShadow = false;
                overlay.renderOrder = (Number(mesh.renderOrder) || 0) + 100;
                mesh.add(overlay);
                overlays.set(mesh, overlay);
            } else if (overlay.geometry !== mesh.geometry) {
                overlay.geometry = mesh.geometry;
            }
        }
    };

    const enforceOnly = (targetScene, terrainGroup) => {
        clearOverlays();
        isolateTerrain(targetScene, terrainGroup);
        for (const object of terrainMeshes(terrainGroup)) {
            if (!materialSnapshot.has(object)) {
                materialSnapshot.set(object, object.material);
            } else if (object.material !== diagnosticMaterial) {
                // Terrain style can legitimately change while inspecting. Keep
                // the latest real material as the restoration target.
                materialSnapshot.set(object, object.material);
            }
            object.material = diagnosticMaterial;
        }
    };

    const enforce = () => {
        if (mode === 'normal') return false;
        const terrainGroup = terrainGroupProvider?.() || null;
        if (!terrainGroup) return false;
        const targetScene = targetSceneProvider?.() || null;
        if (mode === 'overlay') enforceOverlay(targetScene, terrainGroup);
        else if (mode === 'only') enforceOnly(targetScene, terrainGroup);
        return true;
    };

    const restore = () => {
        clearOverlays();
        for (const [child, visible] of visibilitySnapshot) child.visible = visible;
        for (const [mesh, material] of materialSnapshot) mesh.material = material;
        visibilitySnapshot.clear();
        materialSnapshot.clear();
        mode = 'normal';
    };

    return {
        toggle() {
            if (mode === 'only') {
                restore();
                return { changed: true, enabled: false, mode };
            }
            if (!terrainGroupProvider?.()) {
                return {
                    changed: false,
                    enabled: false,
                    mode: 'normal',
                    reason: 'unavailable',
                };
            }
            mode = mode === 'normal' ? 'overlay' : 'only';
            enforce();
            return { changed: true, enabled: true, mode };
        },
        enforce,
        reset: restore,
        isEnabled: () => mode !== 'normal',
        getMode: () => mode,
    };
}
