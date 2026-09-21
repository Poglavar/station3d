// Pure publication helpers for the kilometre-scale civil-ground mask.
//
// A formation model rebuilds cooperatively while streamed tiles arrive. Its
// public spatial indexes remain on the last complete generation throughout
// that rebuild. The render mask may use that immutable generation to follow
// the camera; forcing getSurfaceProfiles() would instead finish the city-wide
// rebuild synchronously, while refusing to build would strand the old mask
// outside its texture window.

function pendingBuild(model) {
    return model?.hasPendingBuild?.() === true;
}

export function formationMaskRevision(models = []) {
    return models.map((model) => (
        `${Number(model?.revision) || 0}`
        + `:${Number(model?.surfacePublicationRevision) || 0}`
        + `:${pendingBuild(model) ? 'pending' : 'ready'}`
    )).join('|');
}

export function formationMaskProfiles(model, centerX, centerZ, radiusM) {
    if (typeof model?.surfaceProfilesNear === 'function') {
        const profiles = model.surfaceProfilesNear(
            Number(centerX) || 0,
            Number(centerZ) || 0,
            Math.max(0, Number(radiusM) || 0),
            { allowStale: true },
        );
        return Array.isArray(profiles) ? profiles : [];
    }
    // Models without a published-generation accessor must finish their build
    // before the mask reads them. Calling their ordinary getter while dirty
    // may turn a sliced background build into one unbounded main-thread task.
    if (pendingBuild(model)) return null;
    const profiles = model?.getSurfaceProfiles?.();
    return Array.isArray(profiles) ? profiles : [];
}

export function captureFormationMaskInputs(
    models,
    { centerX = 0, centerZ = 0, radiusM = 0 } = {},
) {
    const captured = [];
    for (const model of models || []) {
        const profiles = formationMaskProfiles(model, centerX, centerZ, radiusM);
        if (profiles === null) return null;
        captured.push({
            model,
            // Copy the publication arrays. Formation rebuilds swap complete
            // profile objects rather than mutating this array in place.
            profiles: profiles.slice(),
            replacementRegions: Array.from(
                model?.getReplacementTerrainCutoutRegions?.() || [],
            ),
            tunnelPortalOpenings: Array.from(
                model?.getTunnelPortalTerrainOpenings?.() || [],
            ),
        });
    }
    return captured;
}

export function formationMaskTaskNeedsRestart(
    task,
    models,
    centerX,
    centerZ,
    refreshMoveM,
) {
    if (!task) return false;
    const currentModels = Array.isArray(models) ? models : [];
    if (task.models.length !== currentModels.length
        || task.models.some((model, index) => model !== currentModels[index])) {
        return true;
    }
    const moved = Math.hypot(
        (Number(centerX) || 0) - task.centerX,
        (Number(centerZ) || 0) - task.centerZ,
    );
    // A newer source generation does not invalidate captured immutable input.
    // Finish and publish it, then let the normal revision check schedule the
    // successor. Restart only when this task would itself miss the camera.
    return moved >= Math.max(1, Number(refreshMoveM) || 1);
}
