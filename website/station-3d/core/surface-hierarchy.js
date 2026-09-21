// Canonical Station3D surface hierarchy.
//
// This module is deliberately pure: renderers, civil solvers, collision code,
// and diagnostics all import the same semantic policy without importing THREE
// or browser state.  A layer may compile this policy into height offsets,
// stencil operations, an ownership mask, or collision filters; it must not
// invent a competing order of its own.

export const SURFACE_VERTICAL_RELATION = Object.freeze({
    SAME_LEVEL: 'same-level',
    GRADE_SEPARATED: 'grade-separated',
    UNKNOWN: 'unknown',
});

// A planned/built surface is not yet allowed to erase what is already visible.
// PUBLISHED means its complete replacement geometry is in the scene. An
// intentional opening is safe only after its interior/structural backstop has
// published too; an opening to literal void is never valid.
export const SURFACE_COVERAGE_STATE = Object.freeze({
    PLANNED: 'planned',
    BUILDING: 'building',
    PUBLISHED: 'published',
    RETIRING: 'retiring',
    INTENTIONAL_OPENING: 'intentional-opening',
});

export const SURFACE_ROLE = Object.freeze({
    VOID: 'void',
    BACKSTOP: 'backstop',
    MATERIAL_COVER: 'material-cover',
    FIRM_SURFACE: 'firm-surface',
    DRESSING: 'dressing',
    RECESSED_SURFACE: 'recessed-surface',
    VOLUME: 'volume',
    STRUCTURE: 'structure',
});

// Surface ownership is not one boolean. A thin marking may own the visible
// colour without becoming walkable support, while a tunnel opening may remove
// the terrain backstop only after its interior support has published. Keep the
// channels independent so no renderer can accidentally infer one permission
// from another.
export const SURFACE_DECISION_CHANNEL = Object.freeze({
    COLOR: 'color',
    SUPPORT: 'support',
    BACKSTOP_CUT: 'backstop-cut',
});

// Renderer-neutral operation names. The THREE adapter translates these into
// concrete stencil constants; producers only publish what they are.
export const SURFACE_STENCIL_MODE = Object.freeze({
    NONE: 'none',
    ROAD_COVER_WRITER: 'road-cover-writer',
    ROAD_CARRIAGEWAY_WRITER: 'road-carriageway-writer',
    PEDESTRIAN_GROUND_WRITER: 'pedestrian-ground-writer',
    BUFFERED_SIDEWALK_WRITER: 'buffered-sidewalk-writer',
    RAIL_SAME_LEVEL_WRITER: 'rail-same-level-writer',
    PASSIVE_GROUND_READER: 'passive-ground-reader',
    RAIL_SAME_LEVEL_READER: 'rail-same-level-reader',
    EXPLICIT_GROUND_READER: 'explicit-ground-reader',
    // The real 3D DGU ground. Same-level writer bits are PLAN-ONLY facts:
    // rasterised in screen space and depth-tested at writer time, they cannot
    // tell "this pixel replaces my ground" from "this pixel happens to be a
    // hill in front of me". Reading them here made a far-side street erase the
    // rail embankment above it as a see-through slit (Branimirova, fixed
    // 2026-08-12, regressed by the 2026-08-20 centralization, re-fixed now).
    // Real terrain honors only depth-independent explicit cutouts (water);
    // genuine civil cuts arrive via the formation ownership mask instead.
    TERRAIN_BACKSTOP_READER: 'terrain-backstop-reader',
    ROAD_CARRIAGEWAY_READER: 'road-carriageway-reader',
    WATER_GROUND_CUTOUT_WRITER: 'water-ground-cutout-writer',
});

export const SURFACE_STENCIL_COMPARE = Object.freeze({
    ALWAYS: 'always',
    EQUAL: 'equal',
    NOT_EQUAL: 'not-equal',
});

export const SURFACE_STENCIL_OPERATION = Object.freeze({
    KEEP: 'keep',
    REPLACE: 'replace',
});

export const SURFACE_PLANNER_CUTOUT_MODE = Object.freeze({
    NONE: 'none',
    ALL: 'all',
    STRUCTURAL_ONLY: 'structural-only',
});

export const SURFACE_BACKSTOP_CUT_OPERATION = Object.freeze({
    ROAD_FORMATION: 'road-formation',
    RAIL_FORMATION: 'rail-formation',
    RAIL_EXCAVATION: 'rail-excavation',
    INTENTIONAL_OPENING: 'intentional-opening',
});

export const SURFACE_CLASS = Object.freeze({
    VOID: 'void',
    TERRAIN: 'terrain',
    DEFAULT_GROUND_COVER: 'default-ground-cover',
    PASSIVE_LANDUSE: 'passive-landuse',
    BUFFERED_SIDEWALK: 'buffered-sidewalk',
    ROAD_CARRIAGEWAY: 'road-carriageway',
    ROAD_EARTHWORK: 'road-earthwork',
    RAIL_EARTHWORK: 'rail-earthwork',
    ROAD_DRESSING: 'road-dressing',
    CURB_RAMP: 'curb-ramp',
    PASSIVE_EDGING: 'passive-edging',
    TRAM_CORRIDOR: 'tram-corridor',
    SIDEWALK: 'sidewalk',
    PEDESTRIAN_EDGING: 'pedestrian-edging',
    CYCLEWAY: 'cycleway',
    PARKING: 'parking',
    PARKING_MARKING: 'parking-marking',
    CONSTRUCTION: 'construction',
    RAIL_TRACKBED: 'rail-trackbed',
    RAIL_TRACKBED_CURB: 'rail-trackbed-curb',
    ROAD_MARKING: 'road-marking',
    LEVEL_CROSSING_APRON: 'level-crossing-apron',
    LEVEL_CROSSING_DRESSING: 'level-crossing-dressing',
    RAIL_STEEL: 'rail-steel',
    WATER: 'water',
    WATER_CUTOUT: 'water-cutout',
    BUILDING: 'building',
    STRUCTURE: 'structure',
});

// Civil design dependency order is intentionally separate from visible
// same-level precedence. A road may consume a rail earthwork height while the
// rendered trackbed still wins the final same-level fragment contest.
export const CIVIL_GROUND_AUTHORITY = Object.freeze({
    TERRAIN: 'terrain',
    RAIL: 'rail',
    ROAD: 'road',
    SIDEWALK: 'sidewalk',
    PATH: 'path',
    BUILDING: 'building',
});

export const CIVIL_GROUND_AUTHORITY_ORDER = Object.freeze([
    CIVIL_GROUND_AUTHORITY.TERRAIN,
    CIVIL_GROUND_AUTHORITY.RAIL,
    CIVIL_GROUND_AUTHORITY.ROAD,
    CIVIL_GROUND_AUTHORITY.SIDEWALK,
    CIVIL_GROUND_AUTHORITY.PATH,
    CIVIL_GROUND_AUTHORITY.BUILDING,
]);

// Physical offsets are a rendering precision aid, not the semantic authority.
// They nevertheless live beside the semantic order so every producer uses the
// same compiled values.
export const GROUND_SURFACE_LEVELS = Object.freeze({
    passiveLanduseMax: 0.016,
    ordinaryRoadBase: 0.020,
    ordinaryRoadStep: 0.0012,
    passiveEdging: 0.035,
    tramCorridor: 0.040,
    pedestrian: 0.043,
    pedestrianEdging: 0.047,
    cycleway: 0.049,
    parking: 0.052,
    parkingMarking: 0.054,
    construction: 0.056,
    tramBed: 0.075,
    tramBedFlatCurb: 0.081,
    roadMarking: 0.086,
});

export const WATER_LEVELS = Object.freeze({
    inland: -0.42,
    sea: -1.60,
    cutout: 0.006,
    naturalBankTop: 0.016,
});

// Technical render sequencing compiled from the same policy. The early road
// pass exists to establish stencil ownership; renderOrder alone never decides
// bridges/underpasses, where normal depth and structure geometry preserve both.
export const SURFACE_RENDER_ORDER = Object.freeze({
    WATER_CUTOUT: -20,
    RAIL_SAME_LEVEL_PREPASS: -11,
    ROAD: -10,
    SIDEWALK: -9,
    ROAD_EARTHWORK: -9,
    CYCLEWAY: -8,
    PARKING: -8,
    CURB_RAMP: -7,
    TERRAIN_BACKSTOP: -6,
    LANDUSE: 0,
    PARKING_MARKING: 1,
    CONSTRUCTION: 2,
    RAIL_EARTHWORK: 2,
    ROAD_MARKING: 3,
    LEVEL_CROSSING_APRON: 3,
    RAIL_STRUCTURE: 3,
    RAIL_TRACKBED: 4,
    RAIL_TRACKBED_CURB: 5,
    LEVEL_CROSSING_DRESSING: 6,
    RAIL_STEEL: 7,
    WATER_BANK: 19,
    WATER_SURFACE: 20,
    WATER_SHORE: 21,
});

export const SURFACE_POLYGON_OFFSET = Object.freeze({
    TERRAIN_BACKSTOP: Object.freeze({ factor: 2, units: 2 }),
    WATER_SURFACE: Object.freeze({ factor: -2, units: -2 }),
    ROAD: Object.freeze({ factor: -1, units: 1 }),
    BUFFERED_SIDEWALK: Object.freeze({ factor: -1, units: 1 }),
    SIDEWALK: Object.freeze({ factor: -2, units: -1 }),
    CYCLEWAY: Object.freeze({ factor: -2, units: -2 }),
    TRAM_CORRIDOR: Object.freeze({ factor: -3, units: -3 }),
    RAIL_TRACKBED: Object.freeze({ factor: -4, units: -4 }),
    RAIL_TRACKBED_CURB: Object.freeze({ factor: -5, units: -5 }),
    RAIL_STEEL: Object.freeze({ factor: -6, units: -6 }),
    ROAD_MARKING: Object.freeze({ factor: -3, units: -3 }),
    LEVEL_CROSSING_APRON: Object.freeze({ factor: -1, units: -1 }),
});

// Independent stencil bits. A broad routing sidewalk is intentionally a
// distinct class from an authored sidewalk: it yields inside carriageway bit 2
// while remaining a real pedestrian surface everywhere outside it.
export const SURFACE_STENCIL = Object.freeze({
    ROAD_COVER: 1,
    ROAD_CARRIAGEWAY: 2,
    RAIL_SAME_LEVEL_PRIORITY: 4,
    // Exact, already-published at-grade paving. Flat ground underlays read
    // this bit as a backstop replacement; grade-separated pedestrian decks
    // never emit it, and the real 3D terrain never reads it (see
    // TERRAIN_BACKSTOP_READER).
    PEDESTRIAN_GROUND_PRIORITY: 8,
    // Depth-independent terrain opening for water bodies below ground level.
    // Kept on its own bit so the 3D terrain can honor it WITHOUT also
    // honoring the plan-only road/pedestrian bits — sharing the road bit is
    // what let far-side streets stencil a see-through slit into the rail
    // embankment in front of them.
    WATER_GROUND_CUTOUT: 16,
});

export const ROAD_STENCIL_REF = SURFACE_STENCIL.ROAD_COVER;
export const ROAD_CARRIAGEWAY_STENCIL_REF = SURFACE_STENCIL.ROAD_CARRIAGEWAY;
export const RAIL_SAME_LEVEL_STENCIL_REF = SURFACE_STENCIL.RAIL_SAME_LEVEL_PRIORITY;
export const PEDESTRIAN_GROUND_STENCIL_REF = SURFACE_STENCIL.PEDESTRIAN_GROUND_PRIORITY;
export const WATER_GROUND_CUTOUT_STENCIL_REF = SURFACE_STENCIL.WATER_GROUND_CUTOUT;
export const ROAD_STENCIL_RENDER_ORDER = SURFACE_RENDER_ORDER.ROAD;
export const GROUND_STENCIL_READER_RENDER_ORDER = SURFACE_RENDER_ORDER.TERRAIN_BACKSTOP;
export const WATER_CUTOUT_RENDER_ORDER = SURFACE_RENDER_ORDER.WATER_CUTOUT;

// RGB ownership-mask channels are facts, not ad-hoc material choices. R removes
// generic ground, G gives an engineered rail excavation/final civil surface
// priority, and B gives published road formation final-ground priority.
// Ordinary rendered trackbed is intentionally NOT rasterised into this coarse
// mask; its exact geometry writes SURFACE_STENCIL.RAIL_SAME_LEVEL_PRIORITY.
export const GROUND_REMOVAL_CHANNELS = Object.freeze({
    NONE: Object.freeze([0, 0, 0]),
    GENERIC_REPLACEMENT: Object.freeze([1, 0, 0]),
    RAIL_FINAL_SURFACE: Object.freeze([0, 1, 0]),
    ROAD_FINAL_SURFACE: Object.freeze([0, 0, 1]),
});

export const GROUND_OWNERSHIP_MASK_FILL = Object.freeze({
    GENERIC_REPLACEMENT: 'rgb(255,0,0)',
    RAIL_FINAL_SURFACE: 'rgb(0,255,0)',
    ROAD_FINAL_SURFACE: 'rgb(0,0,255)',
    ROAD_AND_GENERIC_REPLACEMENT: 'rgb(255,0,255)',
});

function policy(rank, role, options = {}) {
    return Object.freeze({
        rank,
        role,
        sameLevelComparable: options.sameLevelComparable !== false,
        groundBackstop: options.groundBackstop === true,
        capabilities: Object.freeze({
            color: options.color !== false,
            support: options.support === true,
            backstopCut: options.backstopCut === true,
        }),
        sceneOffsetM: options.sceneOffsetM ?? null,
        renderOrder: options.renderOrder ?? null,
        polygonOffset: options.polygonOffset || null,
        depthTest: typeof options.depthTest === 'boolean' ? options.depthTest : null,
        depthWrite: typeof options.depthWrite === 'boolean' ? options.depthWrite : null,
    });
}

// Rank applies only after two surfaces have been proved to share a physical
// level. A grade-separated pair is always preserved, irrespective of rank.
export const SURFACE_POLICIES = Object.freeze({
    [SURFACE_CLASS.VOID]: policy(-1000, SURFACE_ROLE.VOID, { color: false }),
    [SURFACE_CLASS.WATER]: policy(5, SURFACE_ROLE.RECESSED_SURFACE, {
        backstopCut: true,
        renderOrder: SURFACE_RENDER_ORDER.WATER_SURFACE,
        polygonOffset: SURFACE_POLYGON_OFFSET.WATER_SURFACE,
    }),
    [SURFACE_CLASS.WATER_CUTOUT]: policy(null, SURFACE_ROLE.VOID, {
        sameLevelComparable: false,
        color: false,
        backstopCut: true,
    }),
    [SURFACE_CLASS.TERRAIN]: policy(10, SURFACE_ROLE.BACKSTOP, {
        groundBackstop: true,
        support: true,
        renderOrder: SURFACE_RENDER_ORDER.TERRAIN_BACKSTOP,
        polygonOffset: SURFACE_POLYGON_OFFSET.TERRAIN_BACKSTOP,
    }),
    [SURFACE_CLASS.DEFAULT_GROUND_COVER]: policy(20, SURFACE_ROLE.MATERIAL_COVER, {
        groundBackstop: true,
        support: true,
    }),
    [SURFACE_CLASS.PASSIVE_LANDUSE]: policy(30, SURFACE_ROLE.MATERIAL_COVER, {
        sceneOffsetM: GROUND_SURFACE_LEVELS.passiveLanduseMax,
        renderOrder: SURFACE_RENDER_ORDER.LANDUSE,
    }),
    // Derived OSM buffers lose to a carriageway. Explicit/authored sidewalks
    // use SURFACE_CLASS.SIDEWALK below and may legitimately cover road edges.
    [SURFACE_CLASS.BUFFERED_SIDEWALK]: policy(40, SURFACE_ROLE.FIRM_SURFACE, {
        support: true,
        backstopCut: true,
        sceneOffsetM: GROUND_SURFACE_LEVELS.pedestrian,
        renderOrder: SURFACE_RENDER_ORDER.SIDEWALK,
        polygonOffset: SURFACE_POLYGON_OFFSET.BUFFERED_SIDEWALK,
    }),
    [SURFACE_CLASS.ROAD_CARRIAGEWAY]: policy(50, SURFACE_ROLE.FIRM_SURFACE, {
        support: true,
        backstopCut: true,
        sceneOffsetM: GROUND_SURFACE_LEVELS.ordinaryRoadBase,
        renderOrder: SURFACE_RENDER_ORDER.ROAD,
        polygonOffset: SURFACE_POLYGON_OFFSET.ROAD,
    }),
    [SURFACE_CLASS.CURB_RAMP]: policy(52, SURFACE_ROLE.MATERIAL_COVER, {
        renderOrder: SURFACE_RENDER_ORDER.CURB_RAMP,
    }),
    [SURFACE_CLASS.ROAD_DRESSING]: policy(54, SURFACE_ROLE.DRESSING),
    [SURFACE_CLASS.ROAD_EARTHWORK]: policy(null, SURFACE_ROLE.STRUCTURE, {
        sameLevelComparable: false,
        support: true,
        backstopCut: true,
    }),
    [SURFACE_CLASS.RAIL_EARTHWORK]: policy(null, SURFACE_ROLE.STRUCTURE, {
        sameLevelComparable: false,
        support: true,
        backstopCut: true,
    }),
    [SURFACE_CLASS.PASSIVE_EDGING]: policy(55, SURFACE_ROLE.DRESSING, {
        sceneOffsetM: GROUND_SURFACE_LEVELS.passiveEdging,
    }),
    [SURFACE_CLASS.TRAM_CORRIDOR]: policy(60, SURFACE_ROLE.FIRM_SURFACE, {
        support: true,
        backstopCut: true,
        sceneOffsetM: GROUND_SURFACE_LEVELS.tramCorridor,
        polygonOffset: SURFACE_POLYGON_OFFSET.TRAM_CORRIDOR,
    }),
    [SURFACE_CLASS.SIDEWALK]: policy(65, SURFACE_ROLE.FIRM_SURFACE, {
        support: true,
        backstopCut: true,
        sceneOffsetM: GROUND_SURFACE_LEVELS.pedestrian,
        renderOrder: SURFACE_RENDER_ORDER.SIDEWALK,
        polygonOffset: SURFACE_POLYGON_OFFSET.SIDEWALK,
    }),
    [SURFACE_CLASS.PEDESTRIAN_EDGING]: policy(70, SURFACE_ROLE.DRESSING, {
        sceneOffsetM: GROUND_SURFACE_LEVELS.pedestrianEdging,
    }),
    [SURFACE_CLASS.CYCLEWAY]: policy(75, SURFACE_ROLE.FIRM_SURFACE, {
        support: true,
        backstopCut: true,
        sceneOffsetM: GROUND_SURFACE_LEVELS.cycleway,
        renderOrder: SURFACE_RENDER_ORDER.CYCLEWAY,
        polygonOffset: SURFACE_POLYGON_OFFSET.CYCLEWAY,
    }),
    [SURFACE_CLASS.PARKING]: policy(78, SURFACE_ROLE.FIRM_SURFACE, {
        support: true,
        backstopCut: true,
        sceneOffsetM: GROUND_SURFACE_LEVELS.parking,
        renderOrder: SURFACE_RENDER_ORDER.PARKING,
    }),
    [SURFACE_CLASS.PARKING_MARKING]: policy(80, SURFACE_ROLE.DRESSING, {
        sceneOffsetM: GROUND_SURFACE_LEVELS.parkingMarking,
        renderOrder: SURFACE_RENDER_ORDER.PARKING_MARKING,
    }),
    [SURFACE_CLASS.CONSTRUCTION]: policy(82, SURFACE_ROLE.FIRM_SURFACE, {
        support: true,
        backstopCut: true,
        sceneOffsetM: GROUND_SURFACE_LEVELS.construction,
        renderOrder: SURFACE_RENDER_ORDER.CONSTRUCTION,
    }),
    // Ordinary road paint belongs to the road and therefore yields to a
    // same-level published trackbed. Dedicated at-grade crossing dressing is
    // a separate explicit exception below; grade-separated pairs never use
    // these ranks and remain governed by geometry/depth.
    [SURFACE_CLASS.ROAD_MARKING]: policy(85, SURFACE_ROLE.DRESSING, {
        sceneOffsetM: GROUND_SURFACE_LEVELS.roadMarking,
        renderOrder: SURFACE_RENDER_ORDER.ROAD_MARKING,
        polygonOffset: SURFACE_POLYGON_OFFSET.ROAD_MARKING,
    }),
    // The asphalt ramp closes the road-to-trackbed seam but remains below the
    // trackbed itself. Crossing paint is a separate, later winner below.
    [SURFACE_CLASS.LEVEL_CROSSING_APRON]: policy(88, SURFACE_ROLE.FIRM_SURFACE, {
        sceneOffsetM: GROUND_SURFACE_LEVELS.tramBed,
        renderOrder: SURFACE_RENDER_ORDER.LEVEL_CROSSING_APRON,
        polygonOffset: SURFACE_POLYGON_OFFSET.LEVEL_CROSSING_APRON,
    }),
    [SURFACE_CLASS.RAIL_TRACKBED]: policy(90, SURFACE_ROLE.FIRM_SURFACE, {
        support: true,
        backstopCut: true,
        sceneOffsetM: GROUND_SURFACE_LEVELS.tramBed,
        renderOrder: SURFACE_RENDER_ORDER.RAIL_TRACKBED,
        polygonOffset: SURFACE_POLYGON_OFFSET.RAIL_TRACKBED,
    }),
    [SURFACE_CLASS.RAIL_TRACKBED_CURB]: policy(92, SURFACE_ROLE.DRESSING, {
        sceneOffsetM: GROUND_SURFACE_LEVELS.tramBedFlatCurb,
        renderOrder: SURFACE_RENDER_ORDER.RAIL_TRACKBED_CURB,
        polygonOffset: SURFACE_POLYGON_OFFSET.RAIL_TRACKBED_CURB,
    }),
    [SURFACE_CLASS.LEVEL_CROSSING_DRESSING]: policy(95, SURFACE_ROLE.DRESSING, {
        sceneOffsetM: GROUND_SURFACE_LEVELS.roadMarking,
        renderOrder: SURFACE_RENDER_ORDER.LEVEL_CROSSING_DRESSING,
        polygonOffset: SURFACE_POLYGON_OFFSET.ROAD_MARKING,
    }),
    [SURFACE_CLASS.RAIL_STEEL]: policy(100, SURFACE_ROLE.STRUCTURE, {
        renderOrder: SURFACE_RENDER_ORDER.RAIL_STEEL,
        polygonOffset: SURFACE_POLYGON_OFFSET.RAIL_STEEL,
    }),
    // Volumes/structures use geometry and depth, never this flat rank.
    [SURFACE_CLASS.BUILDING]: policy(null, SURFACE_ROLE.VOLUME, {
        sameLevelComparable: false,
    }),
    [SURFACE_CLASS.STRUCTURE]: policy(null, SURFACE_ROLE.STRUCTURE, {
        sameLevelComparable: false,
        support: true,
        backstopCut: true,
    }),
});

function renderContract(options = {}) {
    return Object.freeze({
        stencilMode: options.stencilMode || SURFACE_STENCIL_MODE.NONE,
        groundRemovalChannels: options.groundRemovalChannels
            || GROUND_REMOVAL_CHANNELS.NONE,
        plannerCutoutMode: options.plannerCutoutMode
            || SURFACE_PLANNER_CUTOUT_MODE.NONE,
        groundHoleTarget: options.groundHoleTarget === true,
        urbanGroundEligible: options.urbanGroundEligible === true,
    });
}

// The sole compilation table from semantic identity to GPU behaviour. No
// producer is allowed to choose stencil bits, mask channels, or planner-cutout
// variants directly. Grade separation and publication are applied below.
export const SURFACE_RENDER_CONTRACTS = Object.freeze({
    [SURFACE_CLASS.VOID]: renderContract(),
    [SURFACE_CLASS.WATER]: renderContract({
        groundRemovalChannels: GROUND_REMOVAL_CHANNELS.GENERIC_REPLACEMENT,
        plannerCutoutMode: SURFACE_PLANNER_CUTOUT_MODE.ALL,
    }),
    [SURFACE_CLASS.WATER_CUTOUT]: renderContract({
        stencilMode: SURFACE_STENCIL_MODE.WATER_GROUND_CUTOUT_WRITER,
    }),
    [SURFACE_CLASS.TERRAIN]: renderContract({
        stencilMode: SURFACE_STENCIL_MODE.TERRAIN_BACKSTOP_READER,
        groundRemovalChannels: GROUND_REMOVAL_CHANNELS.GENERIC_REPLACEMENT,
        plannerCutoutMode: SURFACE_PLANNER_CUTOUT_MODE.ALL,
        groundHoleTarget: true,
        urbanGroundEligible: true,
    }),
    [SURFACE_CLASS.DEFAULT_GROUND_COVER]: renderContract({
        stencilMode: SURFACE_STENCIL_MODE.EXPLICIT_GROUND_READER,
        groundRemovalChannels: GROUND_REMOVAL_CHANNELS.GENERIC_REPLACEMENT,
        plannerCutoutMode: SURFACE_PLANNER_CUTOUT_MODE.ALL,
        groundHoleTarget: true,
        urbanGroundEligible: true,
    }),
    [SURFACE_CLASS.PASSIVE_LANDUSE]: renderContract({
        stencilMode: SURFACE_STENCIL_MODE.PASSIVE_GROUND_READER,
        groundRemovalChannels: GROUND_REMOVAL_CHANNELS.GENERIC_REPLACEMENT,
        plannerCutoutMode: SURFACE_PLANNER_CUTOUT_MODE.ALL,
    }),
    [SURFACE_CLASS.BUFFERED_SIDEWALK]: renderContract({
        stencilMode: SURFACE_STENCIL_MODE.BUFFERED_SIDEWALK_WRITER,
        groundRemovalChannels: GROUND_REMOVAL_CHANNELS.RAIL_FINAL_SURFACE,
        plannerCutoutMode: SURFACE_PLANNER_CUTOUT_MODE.ALL,
    }),
    [SURFACE_CLASS.ROAD_CARRIAGEWAY]: renderContract({
        stencilMode: SURFACE_STENCIL_MODE.ROAD_CARRIAGEWAY_WRITER,
        groundRemovalChannels: GROUND_REMOVAL_CHANNELS.RAIL_FINAL_SURFACE,
        plannerCutoutMode: SURFACE_PLANNER_CUTOUT_MODE.ALL,
    }),
    [SURFACE_CLASS.ROAD_EARTHWORK]: renderContract({
        stencilMode: SURFACE_STENCIL_MODE.RAIL_SAME_LEVEL_READER,
        groundRemovalChannels: GROUND_REMOVAL_CHANNELS.RAIL_FINAL_SURFACE,
        plannerCutoutMode: SURFACE_PLANNER_CUTOUT_MODE.ALL,
        urbanGroundEligible: true,
    }),
    [SURFACE_CLASS.RAIL_EARTHWORK]: renderContract({
        stencilMode: SURFACE_STENCIL_MODE.ROAD_CARRIAGEWAY_READER,
        // Rail collars include the visible, often near-vertical face of an
        // embankment. The coarse XZ ownership texture has no height, so a low
        // service road beside/under that embankment must never discard the
        // face above it. Exact road geometry still wins true same-level
        // overlaps through the depth-tested carriageway stencil.
        groundRemovalChannels: GROUND_REMOVAL_CHANNELS.NONE,
        plannerCutoutMode: SURFACE_PLANNER_CUTOUT_MODE.ALL,
        urbanGroundEligible: true,
    }),
    [SURFACE_CLASS.ROAD_DRESSING]: renderContract({
        stencilMode: SURFACE_STENCIL_MODE.RAIL_SAME_LEVEL_READER,
        groundRemovalChannels: GROUND_REMOVAL_CHANNELS.RAIL_FINAL_SURFACE,
        plannerCutoutMode: SURFACE_PLANNER_CUTOUT_MODE.ALL,
    }),
    [SURFACE_CLASS.CURB_RAMP]: renderContract({
        stencilMode: SURFACE_STENCIL_MODE.EXPLICIT_GROUND_READER,
        groundRemovalChannels: GROUND_REMOVAL_CHANNELS.RAIL_FINAL_SURFACE,
        plannerCutoutMode: SURFACE_PLANNER_CUTOUT_MODE.ALL,
    }),
    [SURFACE_CLASS.PASSIVE_EDGING]: renderContract({
        stencilMode: SURFACE_STENCIL_MODE.PASSIVE_GROUND_READER,
        groundRemovalChannels: GROUND_REMOVAL_CHANNELS.GENERIC_REPLACEMENT,
        plannerCutoutMode: SURFACE_PLANNER_CUTOUT_MODE.ALL,
    }),
    [SURFACE_CLASS.TRAM_CORRIDOR]: renderContract({
        stencilMode: SURFACE_STENCIL_MODE.ROAD_COVER_WRITER,
        groundRemovalChannels: GROUND_REMOVAL_CHANNELS.RAIL_FINAL_SURFACE,
        plannerCutoutMode: SURFACE_PLANNER_CUTOUT_MODE.ALL,
    }),
    [SURFACE_CLASS.SIDEWALK]: renderContract({
        stencilMode: SURFACE_STENCIL_MODE.PEDESTRIAN_GROUND_WRITER,
        groundRemovalChannels: GROUND_REMOVAL_CHANNELS.RAIL_FINAL_SURFACE,
        plannerCutoutMode: SURFACE_PLANNER_CUTOUT_MODE.ALL,
    }),
    [SURFACE_CLASS.PEDESTRIAN_EDGING]: renderContract({
        stencilMode: SURFACE_STENCIL_MODE.RAIL_SAME_LEVEL_READER,
        groundRemovalChannels: GROUND_REMOVAL_CHANNELS.GENERIC_REPLACEMENT,
        plannerCutoutMode: SURFACE_PLANNER_CUTOUT_MODE.ALL,
    }),
    [SURFACE_CLASS.CYCLEWAY]: renderContract({
        stencilMode: SURFACE_STENCIL_MODE.PEDESTRIAN_GROUND_WRITER,
        groundRemovalChannels: GROUND_REMOVAL_CHANNELS.RAIL_FINAL_SURFACE,
        plannerCutoutMode: SURFACE_PLANNER_CUTOUT_MODE.ALL,
    }),
    [SURFACE_CLASS.PARKING]: renderContract({
        stencilMode: SURFACE_STENCIL_MODE.ROAD_COVER_WRITER,
        groundRemovalChannels: GROUND_REMOVAL_CHANNELS.RAIL_FINAL_SURFACE,
        plannerCutoutMode: SURFACE_PLANNER_CUTOUT_MODE.ALL,
    }),
    [SURFACE_CLASS.PARKING_MARKING]: renderContract({
        stencilMode: SURFACE_STENCIL_MODE.RAIL_SAME_LEVEL_READER,
        groundRemovalChannels: GROUND_REMOVAL_CHANNELS.RAIL_FINAL_SURFACE,
        plannerCutoutMode: SURFACE_PLANNER_CUTOUT_MODE.ALL,
    }),
    [SURFACE_CLASS.CONSTRUCTION]: renderContract({
        stencilMode: SURFACE_STENCIL_MODE.RAIL_SAME_LEVEL_READER,
        groundRemovalChannels: GROUND_REMOVAL_CHANNELS.GENERIC_REPLACEMENT,
        plannerCutoutMode: SURFACE_PLANNER_CUTOUT_MODE.ALL,
    }),
    [SURFACE_CLASS.ROAD_MARKING]: renderContract({
        stencilMode: SURFACE_STENCIL_MODE.RAIL_SAME_LEVEL_READER,
        groundRemovalChannels: GROUND_REMOVAL_CHANNELS.RAIL_FINAL_SURFACE,
        plannerCutoutMode: SURFACE_PLANNER_CUTOUT_MODE.STRUCTURAL_ONLY,
    }),
    [SURFACE_CLASS.LEVEL_CROSSING_APRON]: renderContract(),
    [SURFACE_CLASS.RAIL_TRACKBED]: renderContract({
        stencilMode: SURFACE_STENCIL_MODE.RAIL_SAME_LEVEL_WRITER,
    }),
    [SURFACE_CLASS.RAIL_TRACKBED_CURB]: renderContract(),
    [SURFACE_CLASS.LEVEL_CROSSING_DRESSING]: renderContract(),
    [SURFACE_CLASS.RAIL_STEEL]: renderContract(),
    [SURFACE_CLASS.BUILDING]: renderContract({
        groundRemovalChannels: GROUND_REMOVAL_CHANNELS.RAIL_FINAL_SURFACE,
        plannerCutoutMode: SURFACE_PLANNER_CUTOUT_MODE.ALL,
    }),
    [SURFACE_CLASS.STRUCTURE]: renderContract(),
});

export function surfacePolicy(surfaceClass) {
    const id = String(surfaceClass || '');
    const resolved = SURFACE_POLICIES[id];
    if (!resolved) throw new Error(`Unknown surface class: ${id || '(empty)'}`);
    return resolved;
}

export function surfaceCoverageCanReplaceLowerSurface(
    coverageState,
    { replacementBackstopReady = false } = {},
) {
    if (coverageState === SURFACE_COVERAGE_STATE.PUBLISHED) return true;
    return coverageState === SURFACE_COVERAGE_STATE.INTENTIONAL_OPENING
        && replacementBackstopReady === true;
}

const SURFACE_COVERAGE_STATES = new Set(Object.values(SURFACE_COVERAGE_STATE));
const SURFACE_VERTICAL_RELATIONS = new Set(Object.values(SURFACE_VERTICAL_RELATION));

function optionalString(value) {
    if (value == null || value === '') return null;
    return String(value);
}

function optionalFinite(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Compile producer metadata into one fail-closed contract. Merely naming a
// surface class never grants it permission to replace an existing surface:
// callers must publish it, prove its vertical relationship, and explicitly
// opt into support/backstop removal where relevant.
export function compileSurfaceClaim(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new TypeError('Surface claim must be an object');
    }
    const surfaceClass = String(input.surfaceClass || '');
    const resolvedPolicy = surfacePolicy(surfaceClass);
    const coverageState = input.coverageState ?? SURFACE_COVERAGE_STATE.PLANNED;
    if (!SURFACE_COVERAGE_STATES.has(coverageState)) {
        throw new Error(`Unknown surface coverage state: ${coverageState}`);
    }
    const verticalRelation = input.verticalRelation
        ?? SURFACE_VERTICAL_RELATION.UNKNOWN;
    if (!SURFACE_VERTICAL_RELATIONS.has(verticalRelation)) {
        throw new Error(`Unknown surface vertical relation: ${verticalRelation}`);
    }
    const replacementBackstopReady = input.replacementBackstopReady === true;
    const capabilities = Object.freeze({
        color: resolvedPolicy.capabilities.color && input.paintsColor !== false,
        support: resolvedPolicy.capabilities.support && input.supportReady === true,
        backstopCut: resolvedPolicy.capabilities.backstopCut
            && input.cutsBackstop === true,
    });
    // The colourless same-level rail claim is the exact stencil prepass, not
    // the visible trackbed. Encode that phase here so publication cannot turn
    // it into an ordinary late trackbed merely by applying the canonical draw
    // contract. Grade-separated trackbed never emits this colourless claim.
    const railSameLevelPrepass = surfaceClass === SURFACE_CLASS.RAIL_TRACKBED
        && verticalRelation === SURFACE_VERTICAL_RELATION.SAME_LEVEL
        && capabilities.color === false;
    return Object.freeze({
        contract: 'station3d-surface-claim-v1',
        surfaceClass,
        role: resolvedPolicy.role,
        rank: resolvedPolicy.rank,
        coverageState,
        verticalRelation,
        verticalBand: optionalString(input.verticalBand),
        ownerId: optionalString(input.ownerId),
        featureId: optionalString(input.featureId),
        sourceId: optionalString(input.sourceId),
        structureId: optionalString(input.structureId),
        replacementKey: optionalString(input.replacementKey),
        generation: optionalFinite(input.generation),
        sceneY: optionalFinite(input.sceneY),
        replacementBackstopReady,
        capabilities,
        technical: Object.freeze({
            sceneOffsetM: resolvedPolicy.sceneOffsetM,
            renderOrder: railSameLevelPrepass
                ? SURFACE_RENDER_ORDER.RAIL_SAME_LEVEL_PREPASS
                : resolvedPolicy.renderOrder,
            polygonOffset: railSameLevelPrepass ? null : resolvedPolicy.polygonOffset,
            depthTest: resolvedPolicy.depthTest,
            depthWrite: resolvedPolicy.depthWrite,
        }),
    });
}

function compiledSurfaceClaim(claim) {
    return claim?.contract === 'station3d-surface-claim-v1'
        ? claim
        : compileSurfaceClaim(claim);
}

export function asSurfaceClaim(claim) {
    return compiledSurfaceClaim(claim);
}

function publishedSameLevelClaim(claim) {
    return claim.coverageState === SURFACE_COVERAGE_STATE.PUBLISHED
        && claim.verticalRelation === SURFACE_VERTICAL_RELATION.SAME_LEVEL;
}

function disabledRenderContract(claim, reason) {
    return Object.freeze({
        claim,
        stencilMode: SURFACE_STENCIL_MODE.NONE,
        groundRemovalChannels: GROUND_REMOVAL_CHANNELS.NONE,
        plannerCutoutMode: SURFACE_PLANNER_CUTOUT_MODE.NONE,
        groundHoleTarget: false,
        urbanGroundEligible: false,
        disabledReason: reason,
    });
}

const BACKSTOP_CUT_STENCIL_MODES = new Set([
    SURFACE_STENCIL_MODE.ROAD_COVER_WRITER,
    SURFACE_STENCIL_MODE.ROAD_CARRIAGEWAY_WRITER,
    SURFACE_STENCIL_MODE.PEDESTRIAN_GROUND_WRITER,
    SURFACE_STENCIL_MODE.BUFFERED_SIDEWALK_WRITER,
    SURFACE_STENCIL_MODE.RAIL_SAME_LEVEL_WRITER,
    SURFACE_STENCIL_MODE.WATER_GROUND_CUTOUT_WRITER,
]);

function surfaceRelationDisabledReason(claim) {
    if (claim.verticalRelation === SURFACE_VERTICAL_RELATION.GRADE_SEPARATED) {
        return 'grade-separated-depth-owned';
    }
    if (claim.verticalRelation === SURFACE_VERTICAL_RELATION.UNKNOWN
        && claim.surfaceClass !== SURFACE_CLASS.BUILDING
        && claim.surfaceClass !== SURFACE_CLASS.STRUCTURE) {
        return 'vertical-relation-unknown';
    }
    return null;
}

// A detached receiver must already contain its final openings before it can
// publish. Applicability therefore depends on identity and vertical relation,
// not publication state. This grants no writer/backstop permission: the opening
// producer and receiver still have to join the same publication boundary.
export function compileSurfaceOpeningTarget(inputClaim) {
    const claim = compiledSurfaceClaim(inputClaim);
    const base = SURFACE_RENDER_CONTRACTS[claim.surfaceClass];
    const disabledReason = surfaceRelationDisabledReason(claim);
    return Object.freeze({
        plannerCutoutMode: disabledReason ? SURFACE_PLANNER_CUTOUT_MODE.NONE : base.plannerCutoutMode,
        groundHoleTarget: !disabledReason && base.groundHoleTarget,
    });
}

// Compile semantic identity into all destructive renderer permissions. Unknown
// or grade-separated flat surfaces fail closed: depth preserves both surfaces,
// and no coarse same-level mask may erase either one. Buildings are the one
// explicit unknown-relation target: a proved rail excavation/planner opening
// may clip the surveyed volume, but the building never writes a winner bit.
export function compileSurfaceRenderContract(inputClaim) {
    const claim = compiledSurfaceClaim(inputClaim);
    const base = SURFACE_RENDER_CONTRACTS[claim.surfaceClass];
    if (!base) throw new Error(`Missing surface render contract: ${claim.surfaceClass}`);
    if (claim.coverageState !== SURFACE_COVERAGE_STATE.PUBLISHED) {
        return disabledRenderContract(claim, 'surface-not-published');
    }
    if (claim.surfaceClass === SURFACE_CLASS.WATER_CUTOUT
        && claim.replacementBackstopReady !== true) {
        return disabledRenderContract(claim, 'replacement-backstop-not-ready');
    }
    const relationDisabledReason = surfaceRelationDisabledReason(claim);
    if (relationDisabledReason) return disabledRenderContract(claim, relationDisabledReason);
    let stencilMode = base.stencilMode;
    if (!publishedSameLevelClaim(claim)) stencilMode = SURFACE_STENCIL_MODE.NONE;
    // A stencil writer indirectly suppresses a lower backstop when later
    // readers reject its bit. Semantic identity alone never grants that
    // destructive permission: the producer must opt into backstopCut too.
    if (BACKSTOP_CUT_STENCIL_MODES.has(stencilMode)
        && !claim.capabilities.backstopCut) {
        stencilMode = SURFACE_STENCIL_MODE.NONE;
    }
    // A cycle-lane paint strip is colour-only. It may yield to trackbed but
    // must never claim pedestrian support or suppress terrain by itself.
    if (claim.surfaceClass === SURFACE_CLASS.CYCLEWAY
        && (!claim.capabilities.support || !claim.capabilities.backstopCut)) {
        stencilMode = SURFACE_STENCIL_MODE.RAIL_SAME_LEVEL_READER;
    }
    return Object.freeze({
        claim,
        stencilMode,
        groundRemovalChannels: base.groundRemovalChannels,
        plannerCutoutMode: base.plannerCutoutMode,
        groundHoleTarget: base.groundHoleTarget,
        urbanGroundEligible: base.urbanGroundEligible,
        disabledReason: null,
    });
}

function stencilContract(options = {}) {
    return Object.freeze({
        enabled: options.enabled === true,
        ref: options.ref || 0,
        funcMask: options.funcMask || 0,
        writeMask: options.writeMask || 0,
        compare: options.compare || SURFACE_STENCIL_COMPARE.ALWAYS,
        zPass: options.zPass || SURFACE_STENCIL_OPERATION.KEEP,
        colorWrite: options.colorWrite,
        depthTest: options.depthTest,
        depthWrite: options.depthWrite,
    });
}

// Renderer-neutral stencil program. This is the only place where semantic
// surface classes become bitwise overlap rules.
export function surfaceStencilContract(inputClaim) {
    const render = compileSurfaceRenderContract(inputClaim);
    const road = SURFACE_STENCIL.ROAD_COVER;
    const carriageway = SURFACE_STENCIL.ROAD_CARRIAGEWAY;
    const rail = SURFACE_STENCIL.RAIL_SAME_LEVEL_PRIORITY;
    const pedestrian = SURFACE_STENCIL.PEDESTRIAN_GROUND_PRIORITY;
    const waterCutout = SURFACE_STENCIL.WATER_GROUND_CUTOUT;
    switch (render.stencilMode) {
        case SURFACE_STENCIL_MODE.ROAD_COVER_WRITER:
            return stencilContract({
                enabled: true,
                ref: road | rail,
                funcMask: rail,
                writeMask: road,
                compare: SURFACE_STENCIL_COMPARE.NOT_EQUAL,
                zPass: SURFACE_STENCIL_OPERATION.REPLACE,
            });
        case SURFACE_STENCIL_MODE.ROAD_CARRIAGEWAY_WRITER:
            return stencilContract({
                enabled: true,
                ref: road | carriageway | rail,
                funcMask: rail,
                writeMask: road | carriageway,
                compare: SURFACE_STENCIL_COMPARE.NOT_EQUAL,
                zPass: SURFACE_STENCIL_OPERATION.REPLACE,
            });
        case SURFACE_STENCIL_MODE.PEDESTRIAN_GROUND_WRITER:
            return stencilContract({
                enabled: true,
                ref: road | pedestrian | rail,
                funcMask: rail,
                writeMask: road | pedestrian,
                compare: SURFACE_STENCIL_COMPARE.NOT_EQUAL,
                zPass: SURFACE_STENCIL_OPERATION.REPLACE,
            });
        case SURFACE_STENCIL_MODE.BUFFERED_SIDEWALK_WRITER:
            return stencilContract({
                enabled: true,
                ref: road,
                funcMask: carriageway | rail,
                writeMask: road,
                compare: SURFACE_STENCIL_COMPARE.EQUAL,
                zPass: SURFACE_STENCIL_OPERATION.REPLACE,
            });
        case SURFACE_STENCIL_MODE.RAIL_SAME_LEVEL_WRITER:
            return stencilContract({
                enabled: true,
                ref: road | rail,
                funcMask: road | rail,
                writeMask: road | rail,
                compare: SURFACE_STENCIL_COMPARE.ALWAYS,
                zPass: SURFACE_STENCIL_OPERATION.REPLACE,
                // The early priority prepass and the visible trackbed share
                // one semantic writer. Only the non-colour claim suppresses
                // colour output; the published paving must remain visible.
                colorWrite: render.claim.capabilities.color ? undefined : false,
            });
        case SURFACE_STENCIL_MODE.PASSIVE_GROUND_READER:
            return stencilContract({
                enabled: true,
                funcMask: road | rail | waterCutout,
                compare: SURFACE_STENCIL_COMPARE.EQUAL,
            });
        case SURFACE_STENCIL_MODE.RAIL_SAME_LEVEL_READER:
            return stencilContract({
                enabled: true,
                funcMask: rail,
                compare: SURFACE_STENCIL_COMPARE.EQUAL,
            });
        case SURFACE_STENCIL_MODE.EXPLICIT_GROUND_READER:
            return stencilContract({
                enabled: true,
                funcMask: road | rail | pedestrian | waterCutout,
                compare: SURFACE_STENCIL_COMPARE.EQUAL,
            });
        // Real 3D ground: honor ONLY the depth-independent water opening.
        // Plan-only same-level writer bits are rasterised in screen space, so
        // a street behind an embankment would punch a see-through slit into
        // the slope in front of it. At-grade paving covers this backstop by
        // depth and polygon offsets; genuine civil cuts arrive through the
        // formation ownership mask, never through these bits.
        case SURFACE_STENCIL_MODE.TERRAIN_BACKSTOP_READER:
            return stencilContract({
                enabled: true,
                funcMask: waterCutout,
                compare: SURFACE_STENCIL_COMPARE.EQUAL,
            });
        case SURFACE_STENCIL_MODE.ROAD_CARRIAGEWAY_READER:
            return stencilContract({
                enabled: true,
                ref: carriageway,
                funcMask: carriageway,
                compare: SURFACE_STENCIL_COMPARE.NOT_EQUAL,
            });
        case SURFACE_STENCIL_MODE.WATER_GROUND_CUTOUT_WRITER:
            return stencilContract({
                enabled: true,
                ref: waterCutout,
                funcMask: waterCutout,
                writeMask: waterCutout,
                compare: SURFACE_STENCIL_COMPARE.ALWAYS,
                zPass: SURFACE_STENCIL_OPERATION.REPLACE,
                colorWrite: false,
                depthTest: false,
                depthWrite: false,
            });
        default:
            return stencilContract();
    }
}

export function surfaceGroundRemovalChannelsForClaim(inputClaim) {
    return compileSurfaceRenderContract(inputClaim).groundRemovalChannels;
}

export function surfacePlannerCutoutModeForClaim(inputClaim) {
    return compileSurfaceRenderContract(inputClaim).plannerCutoutMode;
}

export function surfaceClaimMayReceiveGroundHole(inputClaim) {
    return compileSurfaceRenderContract(inputClaim).groundHoleTarget;
}

export function surfaceClaimMayUseUrbanGround(inputClaim) {
    return compileSurfaceRenderContract(inputClaim).urbanGroundEligible;
}

export function reviseSurfaceClaim(sourceClaim, overrides = {}) {
    const source = compiledSurfaceClaim(sourceClaim);
    return compileSurfaceClaim({
        ...source,
        paintsColor: source.capabilities.color,
        supportReady: source.capabilities.support,
        cutsBackstop: source.capabilities.backstopCut,
        ...overrides,
    });
}

export function surfaceClaimsVerticalRelation(
    firstClaim,
    secondClaim,
    explicitRelation = SURFACE_VERTICAL_RELATION.UNKNOWN,
) {
    if (!SURFACE_VERTICAL_RELATIONS.has(explicitRelation)) {
        throw new Error(`Unknown surface vertical relation: ${explicitRelation}`);
    }
    if (explicitRelation !== SURFACE_VERTICAL_RELATION.UNKNOWN) return explicitRelation;
    const first = compiledSurfaceClaim(firstClaim);
    const second = compiledSurfaceClaim(secondClaim);
    if (first.verticalBand && second.verticalBand) {
        return first.verticalBand === second.verticalBand
            ? SURFACE_VERTICAL_RELATION.SAME_LEVEL
            : SURFACE_VERTICAL_RELATION.GRADE_SEPARATED;
    }
    if (second.surfaceClass === SURFACE_CLASS.TERRAIN
        && first.verticalRelation !== SURFACE_VERTICAL_RELATION.UNKNOWN) {
        return first.verticalRelation;
    }
    if (first.surfaceClass === SURFACE_CLASS.TERRAIN
        && second.verticalRelation !== SURFACE_VERTICAL_RELATION.UNKNOWN) {
        return second.verticalRelation;
    }
    return SURFACE_VERTICAL_RELATION.UNKNOWN;
}

function claimCoverageCanReplace(claim) {
    return surfaceCoverageCanReplaceLowerSurface(claim.coverageState, {
        replacementBackstopReady: claim.replacementBackstopReady,
    });
}

export function surfaceClaimMayPaintOver(
    suppressorClaim,
    targetClaim,
    { verticalRelation = SURFACE_VERTICAL_RELATION.UNKNOWN } = {},
) {
    const suppressor = compiledSurfaceClaim(suppressorClaim);
    const target = compiledSurfaceClaim(targetClaim);
    if (suppressor.surfaceClass === SURFACE_CLASS.VOID) return false;
    if (!suppressor.capabilities.color || !claimCoverageCanReplace(suppressor)) return false;
    if (target.surfaceClass === SURFACE_CLASS.VOID) return true;
    const relation = surfaceClaimsVerticalRelation(suppressor, target, verticalRelation);
    if (relation !== SURFACE_VERTICAL_RELATION.SAME_LEVEL) return false;
    const suppressorPolicy = surfacePolicy(suppressor.surfaceClass);
    const targetPolicy = surfacePolicy(target.surfaceClass);
    if (!suppressorPolicy.sameLevelComparable || !targetPolicy.sameLevelComparable) return false;
    return suppressorPolicy.rank > targetPolicy.rank;
}

export function surfaceClaimMayProvideSupport(
    sourceClaim,
    { verticalBand = null } = {},
) {
    const claim = compiledSurfaceClaim(sourceClaim);
    if (claim.coverageState !== SURFACE_COVERAGE_STATE.PUBLISHED) return false;
    if (!claim.capabilities.support) return false;
    return verticalBand == null || claim.verticalBand === String(verticalBand);
}

export function surfaceClaimMayCutBackstop(
    sourceClaim,
    targetClaim,
    { verticalRelation = SURFACE_VERTICAL_RELATION.UNKNOWN } = {},
) {
    const source = compiledSurfaceClaim(sourceClaim);
    const target = compiledSurfaceClaim(targetClaim);
    if (!source.capabilities.backstopCut || !claimCoverageCanReplace(source)) return false;
    if (!surfacePolicy(target.surfaceClass).groundBackstop) return false;
    // An opening deliberately connects two vertical bands. It is safe because
    // the replacement interior/deck was published first, not because source
    // and terrain are at the same elevation.
    if (source.coverageState === SURFACE_COVERAGE_STATE.INTENTIONAL_OPENING) {
        return source.replacementBackstopReady === true;
    }
    return surfaceClaimsVerticalRelation(source, target, verticalRelation)
        === SURFACE_VERTICAL_RELATION.SAME_LEVEL;
}

export function requireSurfaceBackstopCutClaim(
    sourceClaim,
    targetClaim,
    { operation = 'surface backstop cut', verticalRelation } = {},
) {
    const source = compiledSurfaceClaim(sourceClaim);
    const target = compiledSurfaceClaim(targetClaim);
    if (!surfaceClaimMayCutBackstop(source, target, { verticalRelation })) {
        throw new Error(
            `${operation} rejected: ${source.surfaceClass}/${source.coverageState}`
            + ` cannot cut ${target.surfaceClass} (${surfaceClaimsVerticalRelation(
                source,
                target,
                verticalRelation,
            )})`,
        );
    }
    return source;
}

const TERRAIN_BACKSTOP_CLAIM = compileSurfaceClaim({
    surfaceClass: SURFACE_CLASS.TERRAIN,
    coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
    verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
    verticalBand: 'ground',
    supportReady: true,
});

// Ownership-mask colours are source facts. Callers provide a published claim
// and an operation; they never choose RGB channels themselves.
export function surfaceGroundOwnershipMaskFill(
    sourceClaim,
    { operation } = {},
) {
    const source = requireSurfaceBackstopCutClaim(
        sourceClaim,
        TERRAIN_BACKSTOP_CLAIM,
        { operation: `ground ownership ${operation || '(missing)'}` },
    );
    switch (operation) {
        case SURFACE_BACKSTOP_CUT_OPERATION.ROAD_FORMATION:
            if (source.surfaceClass !== SURFACE_CLASS.ROAD_EARTHWORK) break;
            return GROUND_OWNERSHIP_MASK_FILL.ROAD_AND_GENERIC_REPLACEMENT;
        case SURFACE_BACKSTOP_CUT_OPERATION.RAIL_FORMATION:
            if (source.surfaceClass !== SURFACE_CLASS.RAIL_EARTHWORK) break;
            return GROUND_OWNERSHIP_MASK_FILL.GENERIC_REPLACEMENT;
        case SURFACE_BACKSTOP_CUT_OPERATION.RAIL_EXCAVATION:
            if (source.surfaceClass !== SURFACE_CLASS.RAIL_EARTHWORK) break;
            return GROUND_OWNERSHIP_MASK_FILL.RAIL_FINAL_SURFACE;
        case SURFACE_BACKSTOP_CUT_OPERATION.INTENTIONAL_OPENING:
            if (source.coverageState !== SURFACE_COVERAGE_STATE.INTENTIONAL_OPENING) break;
            return GROUND_OWNERSHIP_MASK_FILL.GENERIC_REPLACEMENT;
        default:
            throw new Error(`Unknown ground ownership operation: ${operation || '(empty)'}`);
    }
    throw new Error(
        `Ground ownership operation ${operation} does not match ${source.surfaceClass}`,
    );
}

// Pairwise diagnostic/planning result. Colour resolves by semantic rank;
// physical support remains a set for the height/reachability resolver; terrain
// removal is an explicit directional decision. None is inferred from another.
export function resolveSurfaceClaimDecisions(
    firstClaim,
    secondClaim,
    { verticalRelation = SURFACE_VERTICAL_RELATION.UNKNOWN } = {},
) {
    const first = compiledSurfaceClaim(firstClaim);
    const second = compiledSurfaceClaim(secondClaim);
    const firstPaintsSecond = surfaceClaimMayPaintOver(first, second, { verticalRelation });
    const secondPaintsFirst = surfaceClaimMayPaintOver(second, first, { verticalRelation });
    const colorWinner = firstPaintsSecond ? first : secondPaintsFirst ? second : null;
    return Object.freeze({
        relation: surfaceClaimsVerticalRelation(first, second, verticalRelation),
        color: Object.freeze({
            winner: colorWinner,
            preserved: colorWinner ? Object.freeze([colorWinner]) : Object.freeze([first, second]),
        }),
        support: Object.freeze([first, second].filter(claim => (
            surfaceClaimMayProvideSupport(claim)
        ))),
        backstopCut: Object.freeze({
            firstCutsSecond: surfaceClaimMayCutBackstop(first, second, { verticalRelation }),
            secondCutsFirst: surfaceClaimMayCutBackstop(second, first, { verticalRelation }),
        }),
    });
}

export function surfaceMaySuppress(
    suppressorClass,
    targetClass,
    {
        verticalRelation = SURFACE_VERTICAL_RELATION.UNKNOWN,
        coverageState = SURFACE_COVERAGE_STATE.PLANNED,
        replacementBackstopReady = false,
    } = {},
) {
    surfacePolicy(suppressorClass);
    surfacePolicy(targetClass);
    if (suppressorClass === SURFACE_CLASS.VOID) return false;
    if (targetClass === SURFACE_CLASS.VOID) return true;
    return surfaceClaimMayPaintOver({
        surfaceClass: suppressorClass,
        coverageState,
        verticalRelation,
        replacementBackstopReady,
    }, {
        surfaceClass: targetClass,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
    }, {
        verticalRelation,
    });
}

export function resolveSurfaceOverlap(
    firstClass,
    secondClass,
    {
        verticalRelation = SURFACE_VERTICAL_RELATION.UNKNOWN,
        coverageStateByClass = {},
        replacementBackstopReadyByClass = {},
    } = {},
) {
    surfacePolicy(firstClass);
    surfacePolicy(secondClass);
    if (firstClass === secondClass) {
        return Object.freeze({ mode: 'single', winner: firstClass, preserved: [firstClass] });
    }
    if (firstClass === SURFACE_CLASS.VOID) {
        return Object.freeze({ mode: 'single', winner: secondClass, preserved: [secondClass] });
    }
    if (secondClass === SURFACE_CLASS.VOID) {
        return Object.freeze({ mode: 'single', winner: firstClass, preserved: [firstClass] });
    }
    if (verticalRelation !== SURFACE_VERTICAL_RELATION.SAME_LEVEL) {
        return Object.freeze({
            mode: 'preserve-both',
            winner: null,
            preserved: Object.freeze([firstClass, secondClass]),
        });
    }
    const first = surfacePolicy(firstClass);
    const second = surfacePolicy(secondClass);
    if (!first.sameLevelComparable || !second.sameLevelComparable) {
        return Object.freeze({
            mode: 'preserve-both',
            winner: null,
            preserved: Object.freeze([firstClass, secondClass]),
        });
    }
    const higherClass = first.rank > second.rank ? firstClass : secondClass;
    const lowerClass = higherClass === firstClass ? secondClass : firstClass;
    const canSuppress = surfaceMaySuppress(higherClass, lowerClass, {
        verticalRelation,
        coverageState: coverageStateByClass[higherClass]
            || SURFACE_COVERAGE_STATE.PLANNED,
        replacementBackstopReady: replacementBackstopReadyByClass[higherClass] === true,
    });
    return canSuppress
        ? Object.freeze({ mode: 'single', winner: higherClass, preserved: [higherClass] })
        : Object.freeze({ mode: 'preserve-lower', winner: lowerClass, preserved: [lowerClass] });
}

const ROAD_LAYER_ORDER = Object.freeze({
    default: 0,
    service: 1,
    living_street: 1,
    residential: 2,
    unclassified: 2,
    tertiary: 3,
    tertiary_link: 3,
    pedestrian: 4,
    secondary: 4,
    secondary_link: 4,
    primary: 5,
    primary_link: 5,
    trunk: 6,
    trunk_link: 6,
    motorway: 7,
    motorway_link: 7,
});

export function roadSurfaceSceneOffset(highwayType, railwayType = null) {
    if (railwayType === 'tram' || railwayType === 'subway') {
        return GROUND_SURFACE_LEVELS.tramCorridor;
    }
    const type = String(highwayType || 'default');
    if (type === 'pedestrian') return GROUND_SURFACE_LEVELS.pedestrian;
    if (type === 'cycleway') return GROUND_SURFACE_LEVELS.cycleway;
    const layer = ROAD_LAYER_ORDER[type] ?? ROAD_LAYER_ORDER.default;
    return GROUND_SURFACE_LEVELS.ordinaryRoadBase
        + layer * GROUND_SURFACE_LEVELS.ordinaryRoadStep;
}

export function decorSurfaceUsesFormationCutout(type) {
    return type !== 'parking';
}
