// Selection and validation helpers for Station3D vehicle providers. Providers
// own identity and reservation lifecycle; this module only compares candidates.

export const VEHICLE_PROVIDER_METHODS = Object.freeze([
    'findNearest',
    'requestBoarding',
    'claim',
    'sync',
    'release',
    'cancelReservation',
]);

export function vehicleProviderContractMissing(provider) {
    return VEHICLE_PROVIDER_METHODS.filter(method => typeof provider?.[method] !== 'function');
}

export function selectNearestVehicleProvider(providers, local, maxDistanceM = Infinity) {
    let nearest = null;
    for (const entry of providers || []) {
        const provider = entry?.provider || entry;
        const providerId = String(entry?.id || provider?.id || '').trim();
        if (!provider || !providerId || typeof provider.findNearest !== 'function') continue;
        const candidate = Object.prototype.hasOwnProperty.call(entry || {}, 'candidate')
            ? entry.candidate
            : provider.findNearest(local);
        if (!candidate) continue;
        const distanceM = Number(candidate.distanceM);
        if (!Number.isFinite(distanceM) || distanceM < 0 || distanceM > maxDistanceM) continue;
        const resolved = { ...candidate, providerId, provider };
        if (!nearest || distanceM < nearest.distanceM
            || (distanceM === nearest.distanceM && providerId < nearest.providerId)) {
            nearest = resolved;
        }
    }
    return nearest;
}
