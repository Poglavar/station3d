// Shared identity/readiness rules for solved road-replacement structures.
//
// The vertical-alignment model describes the surface that SHOULD exist. The
// publication registry records the detached geometry that ACTUALLY exists in
// the scene. Source asphalt may be retired only when both facts agree; treating
// a planned replacement as already published creates a hole while its civil
// root is still being built.

const ROAD_STRUCTURE_PUBLICATION_PREFIX = 'roads:structure:';
const compiledSources = new WeakMap();

// Keep this source identity out of serialized scene metadata. Snapshot views
// retain the compiled rows/definition; a later alignment with the same OSM ids
// must not use an older deck or tunnel as proof that its replacement is ready.
export function noteRoadStructureCompiledSource(root, alignment) {
    if (!root || !alignment?.definition || !Array.isArray(alignment.samples)) {
        throw new TypeError('Road structure requires its compiled alignment source');
    }
    compiledSources.set(root, { definition: alignment.definition, samples: alignment.samples,
        profileYAtS: alignment.profileYAtS });
}

export function roadStructureMatchesAlignment(root, alignment) {
    const source = compiledSources.get(root);
    return !!source && source.definition === alignment?.definition
        && source.samples === alignment?.samples && source.profileYAtS === alignment?.profileYAtS;
}

function stringId(value) {
    if (value == null || value === '') return null;
    return String(value);
}

export function roadStructurePublicationKey(alignmentId) {
    return `${ROAD_STRUCTURE_PUBLICATION_PREFIX}${String(alignmentId)}`;
}

export function isRoadStructurePublicationKey(key) {
    return String(key || '').startsWith(ROAD_STRUCTURE_PUBLICATION_PREFIX);
}

export function roadReplacementOsmIdsFromRoot(root) {
    const details = root?.userData?.roadVerticalAlignment;
    return Array.from(new Set(
        (details?.replaceRoadSurfaceOsmIds || [])
            .map(stringId)
            .filter(Boolean),
    ));
}

export function roadReplacementPublicationReadyForOsmId({
    alignmentModel,
    surfacePublications,
    osmId,
} = {}) {
    const requestedId = stringId(osmId);
    if (!requestedId) return false;
    const alignment = alignmentModel?.getAlignmentForOsmId?.(osmId) || null;
    const definition = alignment?.definition;
    if (!definition?.replaceRoadSurface) return false;
    const replacementIds = Array.isArray(definition.replaceRoadSurfaceOsmIds)
        ? definition.replaceRoadSurfaceOsmIds.map(stringId).filter(Boolean)
        : Array.from(alignment.memberOsmIds || []).map(stringId).filter(Boolean);
    if (!replacementIds.includes(requestedId)) return false;

    // A compiled alignment alone cannot authorize removal. Detached candidates
    // supply an explicit prepared-root view; active callers use the registry.
    if (typeof surfacePublications?.getActive !== 'function') return false;
    const active = surfacePublications.getActive(
        roadStructurePublicationKey(alignment.id),
    );
    return roadStructureMatchesAlignment(active?.root, alignment)
        && roadReplacementOsmIdsFromRoot(active?.root).includes(requestedId);
}
