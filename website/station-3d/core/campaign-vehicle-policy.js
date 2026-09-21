// What a campaign scene does when a driven vehicle can no longer move, which
// patches of road ambient traffic must leave alone, and where a scene lets the
// player step off a boat. All are pure rules so they can be reasoned about
// without a renderer.

// A scene whose objective can still be reached on foot ejects the player when the
// car is lost — wedged or wrecked — instead of ending the run: the Zagreb chase
// explicitly offers "by car or on foot", so failing there punishes the player
// for the city's geometry rather than for a mistake. Every other scene, where
// the vehicle IS the objective (the boat to Split, the train), still fails.
export function campaignVehicleLossOutcome(scene) {
    return scene?.authored?.onVehicleLost === 'eject' ? 'eject' : 'fail';
}

// Local-metre circles ambient traffic may not spawn inside. Authored in
// degrees; the caller converts once per session against the world anchor.
export function pointInsideKeepClear(x, z, volumes, marginM = 0) {
    if (!Array.isArray(volumes) || volumes.length === 0) return false;
    for (const volume of volumes) {
        const radius = Number(volume?.radiusM);
        if (!Number.isFinite(radius) || radius <= 0) continue;
        const dx = Number(x) - Number(volume.x);
        const dz = Number(z) - Number(volume.z);
        if (!Number.isFinite(dx) || !Number.isFinite(dz)) continue;
        const reach = radius + (Number.isFinite(marginM) ? marginM : 0);
        if (dx * dx + dz * dz <= reach * reach) return true;
    }
    return false;
}

// A scene whose story hinges on docking names one of its zones as the only
// place the boat may be left: `authored.boatExitZoneId`. Outside it the safe
// exit preview and E both refuse, so the green point can never invite the
// player ashore somewhere the docking objective will not recognise. Split's
// audit found exactly that: a valid quay landing 200 m from the berth, on foot
// with a boat-only objective. Scenes without the field keep the free exit.
export function campaignBoatExitBerth(scene) {
    const zoneId = scene?.authored?.boatExitZoneId;
    if (typeof zoneId !== 'string' || !zoneId) return null;
    const zone = (scene.authored.zones || []).find(item => item?.id === zoneId);
    const radius = Number(zone?.radiusM);
    if (!zone || !Number.isFinite(radius) || radius <= 0) return null;
    // Authored zones carry `center: { lat, lon }`; accept a flat pair too.
    const lat = Number(zone.center?.lat ?? zone.lat);
    const lon = Number(zone.center?.lon ?? zone.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { id: zone.id, lat, lon, radiusM: radius };
}

// Local-metre check the vehicle session runs on the boat's own pose. A berth
// converted against the world anchor is `{ x, z, radiusM }`; no berth means
// the scene did not restrict the exit.
export function boatExitAllowedAt(x, z, berth) {
    if (!berth) return true;
    return pointInsideKeepClear(x, z, [berth]);
}
