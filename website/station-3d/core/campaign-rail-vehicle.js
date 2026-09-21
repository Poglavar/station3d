// Pure selection and endpoint-placement rules for authored campaign trains.

function lineCoordinates(feature) {
    return feature?.geometry?.type === 'LineString'
        && Array.isArray(feature.geometry.coordinates)
        ? feature.geometry.coordinates
        : [];
}

export function findCampaignRailVehicleFeature(features, specification = {}) {
    const sourceId = String(specification.sourceId || '').trim();
    const projectId = Number(specification.projectId);
    const candidates = (Array.isArray(features) ? features : [])
        .filter(feature => lineCoordinates(feature).length >= 2);
    return candidates.find((feature) => {
        const properties = feature.properties || {};
        if (sourceId) {
            return String(
                properties.referenceSourceId || properties.sourceId || '',
            ).trim() === sourceId;
        }
        if (Number.isFinite(projectId)) {
            return Number(properties.referenceProjectId ?? properties.projectId) === projectId;
        }
        return true;
    }) || null;
}

export function campaignRailVehicleCenterStation(
    totalLengthM,
    specification = {},
    halfLengthM = 0,
) {
    const total = Math.max(0, Number(totalLengthM) || 0);
    const clearance = Math.max(0, Number(specification.endClearanceM) || 0);
    const margin = Math.min(total * 0.5, Math.max(0, Number(halfLengthM) || 0) + clearance);
    return specification.endpoint === 'first' ? margin : total - margin;
}

export function campaignRailVehicleCarStations({
    totalLengthM,
    specification = {},
    carCount,
    carSpacingM,
    halfLengthM,
}) {
    const count = Math.max(1, Math.floor(Number(carCount) || 1));
    const spacing = Math.max(0, Number(carSpacingM) || 0);
    const direction = Number(specification.direction) < 0 ? -1 : 1;
    const center = campaignRailVehicleCenterStation(
        totalLengthM,
        specification,
        halfLengthM,
    );
    return Array.from({ length: count }, (_, index) => (
        center + direction * ((count - 1) * 0.5 - index) * spacing
    ));
}
