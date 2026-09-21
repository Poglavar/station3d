// Pure placement helpers shared by terrain-aware world layers. They choose
// the engineered road surface when requested and otherwise sample bare DGU
// terrain, without depending on THREE, DOM, fetch, or scene state.

function finite(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

export function placementBaseSceneY(terrain, localX, localZ, {
    preferRoadSurface = false,
} = {}) {
    if (!terrain) return 0;
    const x = finite(localX);
    const z = finite(localZ);
    if (x == null || z == null) return 0;

    if (preferRoadSurface) {
        const formation = terrain.roadFormation;
        const surface = formation && typeof formation.surfaceAtLocal === 'function'
            ? formation.surfaceAtLocal(x, z)
            : null;
        if (surface && typeof formation.sceneYAtLocal === 'function') {
            const roadY = finite(formation.sceneYAtLocal(x, z, {
                osmId: surface.osmId,
                requireSurface: true,
            }));
            if (roadY != null) return roadY;
        }
    }

    if (typeof terrain.sceneYAtLocal !== 'function') return 0;
    return finite(terrain.sceneYAtLocal(x, z)) ?? 0;
}

export function placementSceneY(terrain, localX, localZ, offsetM = 0, options = {}) {
    return placementBaseSceneY(terrain, localX, localZ, options)
        + (finite(offsetM) ?? 0);
}

// Nullable placement for authored geometry and visible ground-relative actors.
// The ordinary helper above is deliberately total only for rendering an opaque
// fallback ground and for non-authoring runtime safety. Nothing may turn that
// visual fallback into a published surface or visible placement, so publishers
// and actors use this evidence-only twin and defer when it returns null. A
// missing terrain authority is the intentional flat-world datum and therefore
// remains scene zero.
export function evidencePlacementBaseSceneY(terrain, localX, localZ, {
    preferRoadSurface = false,
    preferPublishedRoadSurface = false,
} = {}) {
    if (!terrain) return 0;
    const x = finite(localX);
    const z = finite(localZ);
    if (x == null || z == null) return null;
    const evidenceY = typeof terrain.evidenceSceneYAtLocal === 'function'
        ? finite(terrain.evidenceSceneYAtLocal(x, z))
        : null;
    if (evidenceY == null) return null;

    if (preferRoadSurface) {
        const formation = terrain.roadFormation;
        // Moving streamed worlds can have a dirty replacement formation while
        // the previous visible generation is still authoritative. Per-frame
        // presentation consumers must be able to query that published
        // generation without surfaceAtLocal() synchronously rebuilding the
        // entire pending road model inside their frame hook.
        const publishedQuery = preferPublishedRoadSurface
            && typeof formation?.publishedSurfaceAtLocal === 'function';
        const surface = publishedQuery
            ? formation.publishedSurfaceAtLocal(x, z)
            : typeof formation?.surfaceAtLocal === 'function'
                ? formation.surfaceAtLocal(x, z)
                : null;
        if (surface && typeof formation.sceneYAtLocal === 'function') {
            const roadY = finite(formation.sceneYAtLocal(x, z, {
                osmId: surface.osmId,
                requireSurface: true,
            }));
            if (roadY != null) return roadY;
        }
    }
    return evidenceY;
}

export function evidencePlacementSceneY(
    terrain,
    localX,
    localZ,
    offsetM = 0,
    options = {},
) {
    const baseY = evidencePlacementBaseSceneY(terrain, localX, localZ, options);
    return baseY == null ? null : baseY + (finite(offsetM) ?? 0);
}

export function drapePositionArray(positions, terrain, options = {}) {
    const result = Float32Array.from(positions || []);
    for (let index = 0; index + 2 < result.length; index += 3) {
        result[index + 1] += placementBaseSceneY(
            terrain,
            result[index],
            result[index + 2],
            options,
        );
    }
    return result;
}
