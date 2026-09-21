// Source-aware far identity without rewriting public properties, heights or picking IDs.
export function farBuildingSourceIdentity(properties) {
    if (!properties || typeof properties.object_id !== 'string' || !properties.object_id) return null;
    const render = properties.footprint_source != null || properties.footprint_id != null;
    const source = render ? properties.footprint_source : properties.source;
    if (typeof source !== 'string' || !source || render && properties.footprint_id !== properties.object_id) return null;
    return { source, objectId: properties.object_id, entityId: `${source}:${properties.object_id}`,
        contract: render ? 'building-render-rows-v2' : 'building-render-lod1-whole-v1' };
}
