import {
    SURFACE_CLASS,
    SURFACE_COVERAGE_STATE,
    SURFACE_VERTICAL_RELATION,
} from './surface-hierarchy.js';

// One planner route owns one coherent civil generation: visible structures,
// cutout masks, walk support, and enclosed-tunnel state all advance under this
// key. Individual meshes still describe their own semantic surface below.
export const PLANNER_ELEVATION_PUBLICATION_KEY = 'planner:elevation';

function verticalBandForName(name) {
    if (/LowRampFill/i.test(name)) return 'transition';
    if (/Viaduct|EmergencyWalkway|WalkwayCurb|WalkwayRail|Pillar|PierCap/i.test(name)) {
        return 'elevated';
    }
    if (/Tunnel|Trench|Retaining/i.test(name)) return 'subsurface';
    return 'grade-separated';
}

function supportRoleForName(name) {
    if (/PlannerEmergencyWalkway/i.test(name)) {
        return { surfaceClass: SURFACE_CLASS.SIDEWALK, supportReady: true, cutsBackstop: false };
    }
    if (/PlannerLowRampFill|PlannerTunnel(?:Interior)?Floors/i.test(name)) {
        return { surfaceClass: SURFACE_CLASS.STRUCTURE, supportReady: true, cutsBackstop: true };
    }
    if (/PlannerViaductDeck/i.test(name)) {
        return { surfaceClass: SURFACE_CLASS.STRUCTURE, supportReady: true, cutsBackstop: false };
    }
    return { surfaceClass: SURFACE_CLASS.STRUCTURE, supportReady: false, cutsBackstop: false };
}

// Pure semantic classification used by the renderer and headless tests. Depth,
// not a same-level winner bit, resolves the elevated/subsurface structures.
export function plannerElevationSurfaceClaimInput(rawName, generation) {
    const name = String(rawName || 'Planner structure');
    const support = supportRoleForName(name);
    return Object.freeze({
        ...support,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalRelation: SURFACE_VERTICAL_RELATION.GRADE_SEPARATED,
        verticalBand: verticalBandForName(name),
        ownerId: 'planner-elevation',
        sourceId: 'world/planner-elevation.js',
        structureId: 'planner-elevation',
        replacementKey: PLANNER_ELEVATION_PUBLICATION_KEY,
        generation,
    });
}

export function plannerElevationOpeningClaimInput(generation) {
    return Object.freeze({
        surfaceClass: SURFACE_CLASS.STRUCTURE,
        coverageState: SURFACE_COVERAGE_STATE.INTENTIONAL_OPENING,
        verticalRelation: SURFACE_VERTICAL_RELATION.GRADE_SEPARATED,
        ownerId: 'planner-elevation-openings',
        sourceId: 'world/planner-elevation.js',
        structureId: 'planner-elevation',
        replacementKey: PLANNER_ELEVATION_PUBLICATION_KEY,
        generation,
        replacementBackstopReady: true,
        paintsColor: false,
        supportReady: true,
        cutsBackstop: true,
    });
}

export function plannerElevationPublicationCommitted(status) {
    return status === 'published'
        || status === 'published-with-retirement-error'
        || status === 'cleared'
        || status === 'cleared-with-retirement-error';
}
