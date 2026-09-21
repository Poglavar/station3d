// Compatibility facade for world modules. The sole definitions live in the
// pure canonical policy so render, civil, support, and collision consumers can
// never drift into different surface orders.

export {
    decorSurfaceUsesFormationCutout,
    GROUND_STENCIL_READER_RENDER_ORDER,
    GROUND_SURFACE_LEVELS,
    ROAD_CARRIAGEWAY_STENCIL_REF,
    ROAD_STENCIL_REF,
    ROAD_STENCIL_RENDER_ORDER,
    roadSurfaceSceneOffset,
    WATER_CUTOUT_RENDER_ORDER,
    WATER_LEVELS,
} from '../core/surface-hierarchy.js';
