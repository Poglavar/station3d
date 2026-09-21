function normalizedOsmId(value) {
    if (value == null || value === '') return null;
    return String(value);
}

// Furniture generated for a lower road must not exist beneath an overpass:
// even when the pole fits, its head can intersect the rendered deck. Furniture
// owned by the overpass itself remains on its engineered surface.
export function roadFurnitureBlockedByOverpass(structure, osmId) {
    if (!structure || structure.kind !== 'overpass') return false;
    const ownerId = normalizedOsmId(osmId);
    if (ownerId == null) return true;
    const structureOsmIds = Array.isArray(structure.osmIds)
        ? structure.osmIds.map(normalizedOsmId).filter(Boolean)
        : [];
    return !structureOsmIds.includes(ownerId);
}
