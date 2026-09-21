import { isGreenhouseBuilding } from './overture-building-shape.js';

// Which geometry pipeline builds a given building feature — decided from the
// KIND of geometry the server sent, not from who surveyed it.
//
// The old rule was `feature.properties.source || tileSourceKind`, i.e. the
// SURVEY NAME chose the pipeline. That worked while Zagreb's GDI was the only
// source of real meshes, and it silently broke the moment a second one existed:
// our DGU-LiDAR reconstruction of the Trogir-Split corridor sends
// `source: 'lidar'`, which matched no branch, so 64,760 LOD2 meshes would have
// fallen through to the flat-extrusion path and rendered as boxes.
//
// So the server now states the kind and the client reads only that:
//
//   properties.geometry_kind === 'mesh'      -> build faces (walls + roof)
//   properties.geometry_kind === 'footprint' -> extrude the outline to a height
//
// A new city with a new survey therefore needs NO change here at all.
//
// NOTE ON THE PIPELINE NAMES. 'gdi' and 'overture' are kept as the pipeline
// identifiers because buildings.js branches on those exact strings in about a
// dozen places. They now name a PIPELINE (mesh / footprint), not a data source;
// renaming them is a mechanical follow-up, deliberately not bundled with this
// change so the behavioural part stays reviewable.
export const PIPELINE_MESH = 'gdi';
export const PIPELINE_FOOTPRINT = 'overture';
// A mesh whose source STATED its material is drawn exactly as it was modelled.
// It is a third pipeline, not a flag on the mesh one: the mesh pipeline's whole
// job is to INVENT a look — wall palette, window grid, roof classification — for
// a survey mesh that arrived with none, and running a modelled landmark through
// it paints stucco and windows over glass and mullions.
export const PIPELINE_STATED = 'stated';

// Some GDI survey solids share the building mesh table without being
// buildings. `Cesta` is the road/bridge fabric itself; drawing it through the
// facade + foundation pipeline creates a second, default-coloured deck and a
// skirt through authored underpasses (Miramarska object 61615). Transport owns
// that geometry. A stated model remains authoritative regardless of metadata.
export function belongsInBuildingLayer(properties) {
    if (!properties || properties.material) return true;
    return String(properties.use_class || '').trim().toLowerCase()
        !== 'cesta';
}

// A stated material OUTRANKS geometry_kind, which outranks the source name.
//
// Order matters and was wrong once: geometry_kind alone sent every landmark
// part into the mesh pipeline, which is a `BUILDING_SOURCE === 'gdi'` test at
// the work-item, so the stated-material branch further down was unreachable.
// Cibona rendered as beige stucco with a painted window grid — its glass optics
// (metalness 0.92, roughness 0.066) never reached the renderer at all.
//
// Legacy endpoints (/buildings-3d, /buildings-overture) send no geometry_kind
// and no material, so they keep resolving by source name exactly as before.
export function buildingPipelineForFeature(properties, tileSourceKind = null) {
    if (properties?.material) return PIPELINE_STATED;
    // A greenhouse is a glass cover system whoever surveyed it, and the mesh
    // pipeline cannot draw one: it invents walls, a roof and a window grid for
    // whatever outline it is given. A LiDAR LOD2 reconstruction of the Kaštela
    // fields is exactly that — an extruded outline — so when Split moved off
    // Overture footprints its greenhouses started rendering as one-storey
    // buildings (median 3.8 m against a 2.4 m ridge). The footprint pipeline
    // rebuilds the rows from the outline, which is the right model, and every
    // mesh feature ships its ground outline for precisely this kind of use.
    if (isGreenhouseBuilding(properties) && properties?.footprint) return PIPELINE_FOOTPRINT;
    const kind = properties?.geometry_kind;
    if (kind === 'mesh') return PIPELINE_MESH;
    if (kind === 'footprint') return PIPELINE_FOOTPRINT;
    return properties?.source || tileSourceKind || null;
}

// Endpoint suffix for a location whose buildings come from the resolved,
// source-agnostic mesh endpoint. Split is the first; Zagreb can migrate by
// changing its location entry alone.
export function isMeshModeLocation(location) {
    return location?.buildings === 'mesh';
}
