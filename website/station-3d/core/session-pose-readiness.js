// Decides when a controller pose is safe to publish as the live session pose.
// Vehicle controllers own their support, while foot and rail poses wait for world evidence.

export function sessionPoseReadyForPublication({
    photoPoseReady = false,
    vehicleController = false,
    footController = false,
    terrainSupportReady = false,
    terrainPresent = false,
    groundY = null,
} = {}) {
    if (photoPoseReady || vehicleController) return true;
    if (footController) return terrainSupportReady === true || !terrainPresent;
    return Number.isFinite(groundY);
}
