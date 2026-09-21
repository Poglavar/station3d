// Decides whether an engineered proposal-road surface has a complete designed
// formation available for the visible-surface publication transaction.

function formationId(value) {
    if (value == null) return null;
    const id = String(value).trim();
    return id || null;
}

export function proposalRoadSurfaceReady(formationModel, formationIds) {
    if (!formationModel
        || formationModel.hasPendingBuild?.() === true
        || typeof formationModel.getSurfaceProfilesForOsmId !== 'function') {
        return false;
    }
    const ids = Array.from(new Set(
        (Array.isArray(formationIds) ? formationIds : [formationIds])
            .map(formationId)
            .filter(Boolean),
    ));
    if (ids.length === 0) return false;

    return ids.every((id) => {
        const profiles = formationModel.getSurfaceProfilesForOsmId(id);
        return Array.isArray(profiles)
            && profiles.length > 0
            && profiles.every(profile => (
                Array.isArray(profile?.points)
                && profile.points.length >= 3
                && profile.points.every(point => Number.isFinite(point?.roadY))
            ));
    });
}
