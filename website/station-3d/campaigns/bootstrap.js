// Public package boundary: campaign definitions are supplied by separate authored-content packages.
let installed = null;

function unavailable() {
    throw new Error('No campaign package is registered with this Station3D build.');
}

export function installCampaignRuntime({ station3D, enabled = true } = {}) {
    if (!enabled) return null;
    if (installed) return installed;
    installed = Object.freeze({
        openMenu: unavailable,
        start: unavailable,
        startCheckpoint: unavailable,
        continue: unavailable,
        restart: unavailable,
        retry: unavailable,
        exit: () => false,
        snapshot: () => null,
        replayCinematic: unavailable,
        list: () => [],
        active: () => null,
    });
    if (station3D) station3D.campaigns = installed;
    return installed;
}
