// Reversible terrain-only wireframe diagnostic for inspecting the actual DGU
// tessellation without rebuilding or pausing the running Station3D session.

import { scene } from './setup.js';
import { getTerrainGroup } from '../world/terrain.js';
import { createTerrainInspectionController } from '../core/terrain-inspection.js';

const terrainInspection = createTerrainInspectionController({
    // setup.js exports a live binding, but passing its pre-init value captured
    // undefined forever. Resolve it at each toggle/frame, like terrainGroup.
    targetSceneProvider: () => scene,
    terrainGroupProvider: getTerrainGroup,
});

export const toggleTerrainInspection = () => terrainInspection.toggle();
export const enforceTerrainInspection = () => terrainInspection.enforce();
export const resetTerrainInspection = () => terrainInspection.reset();
export const isTerrainInspectionEnabled = () => terrainInspection.isEnabled();
export const getTerrainInspectionMode = () => terrainInspection.getMode();
