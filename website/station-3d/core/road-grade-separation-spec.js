// Shared civil-structure dimensions and a pure, inspectable build plan for
// road overpasses and underpasses. The renderer and debug trace both consume
// this module so displayed decisions cannot drift from rendered dimensions.

import {
    roadStructureFormationOffsetsM,
    roadStructureSidewalkBandsM,
} from './road-vertical-alignment.js';
import { roadStructureHalfWidths } from './road-structure-cross-section.js';

export { DEFAULT_ROAD_HALF_WIDTH_M, DEFAULT_FORMATION_HALF_WIDTH_M } from './road-structure-cross-section.js';
export const BRIDGE_DECK_DEPTH_M = 0.9;
export const BRIDGE_FENCE_HEIGHT_M = 2;
export const TUNNEL_CLEAR_HEIGHT_M = 5.5;
export const TUNNEL_WALL_M = 0.45;
export const TUNNEL_ROOF_DEPTH_M = 0.7;
export const UNDERPASS_WALL_MAX_SEGMENT_M = 2;
export const UNDERPASS_WALL_CROWN_MAX_GRADE = 0.12;
export const PIER_SPACING_M = 30;

function positiveNumber(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

export function roadGradeSeparationBuildPlan(alignment, alignments = []) {
    if (!alignment) return null;
    const definition = alignment.definition || {};
    const crossSection = definition.crossSection || {};
    const { roadHalfWidthM, formationHalfWidthM: baseFormationHalfWidthM } = roadStructureHalfWidths(alignment);
    const formationOffsetsM = roadStructureFormationOffsetsM(
        alignment,
        alignments,
        baseFormationHalfWidthM,
    );
    const sidewalkBandsM = roadStructureSidewalkBandsM(
        roadHalfWidthM,
        formationOffsetsM,
        alignment,
        alignments,
    );
    const stages = [];
    if (definition.replaceRoadSurface) stages.push('replacement road surface');
    if (definition.renderStructure !== false) {
        if (alignment.kind === 'overpass') {
            stages.push(
                'sidewalk and companion-path surface',
                'firm bridge support surface',
                'concrete deck slab',
                'two-metre metal safety fence',
                'clearance-aware intermediate supports',
                'start abutment',
                'end abutment',
            );
        } else {
            if (definition.replacementCarriagewayOnly) {
                stages.push(
                    'thick concrete approach walls',
                    'terrain-to-wall crown collar',
                );
            }
            if (definition.structureMode !== 'open-cut') {
                stages.push(
                    'thick concrete underpass box and roof slab',
                    'start portal',
                    'end portal',
                );
            }
        }
    }
    return {
        roadHalfWidthM,
        baseFormationHalfWidthM,
        formationLeftM: formationOffsetsM.leftM,
        formationRightM: formationOffsetsM.rightM,
        sidewalkBandsM,
        stages,
        bridge: alignment.kind === 'overpass'
            ? {
                deckDepthM: BRIDGE_DECK_DEPTH_M,
                fenceHeightM: BRIDGE_FENCE_HEIGHT_M,
                nominalPierSpacingM: PIER_SPACING_M,
            }
            : null,
        underpass: alignment.kind === 'underpass'
            ? {
                structureMode: definition.structureMode || 'box',
                clearHeightM: positiveNumber(
                    definition.clearHeightM,
                    TUNNEL_CLEAR_HEIGHT_M,
                ),
                wallThicknessM: TUNNEL_WALL_M,
                roofDepthM: positiveNumber(
                    definition.roofDepthM,
                    TUNNEL_ROOF_DEPTH_M,
                ),
                maxWallSegmentM: UNDERPASS_WALL_MAX_SEGMENT_M,
                maxWallCrownGrade: UNDERPASS_WALL_CROWN_MAX_GRADE,
                terrainClearHalfWidthM: positiveNumber(
                    crossSection.terrainClearHalfWidthM,
                    null,
                ),
                terrainCutoutHalfWidthM: positiveNumber(
                    crossSection.terrainCutoutHalfWidthM,
                    null,
                ),
            }
            : null,
    };
}
