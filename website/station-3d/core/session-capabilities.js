// Defines immutable Station3D session presets and the individual capabilities
// that distinguish quiet walking from the full interactive free-roam world.

export const SESSION_CAPABILITY = Object.freeze({
    ROAD_VEHICLES: 'roadVehicles',
    BOATS: 'boats',
    AIRCRAFT: 'aircraft',
    AMBIENT_TRAMS: 'ambientTrams',
    CROATIA_RAIL_STREAMING: 'croatiaRailStreaming',
    PARKED_VEHICLES: 'parkedVehicles',
    TRAFFIC_LIGHTS: 'trafficLights',
    AMBIENT_PEDESTRIANS: 'ambientPedestrians',
    CONTINUOUS_STREAMING: 'continuousStreaming',
    RENDER_ORIGIN_REBASING: 'renderOriginRebasing',
    EXPANDED_BUILDING_STREAMING: 'expandedBuildingStreaming',
    CROATIA_BOUNDS: 'croatiaBounds',
    SUPPRESS_TRAFFIC_WRECK_DRESSING: 'suppressTrafficWreckDressing',
});

const EMPTY_CAPABILITIES = Object.freeze(
    Object.fromEntries(Object.values(SESSION_CAPABILITY).map(key => [key, false])),
);

// Static Croatian rail infrastructure belongs to the base world. It is needed
// for an ordinary walk just as much as for driving a cab: otherwise a walk
// session beside a main-line corridor silently renders only whichever solved
// route happened to launch the session. Keep gameplay actors and the expanded
// national streaming envelope GTA-only, but always subscribe to the local OSM
// rail cells around the observer.
const WALK_CAPABILITIES = Object.freeze({
    ...EMPTY_CAPABILITIES,
    [SESSION_CAPABILITY.CROATIA_RAIL_STREAMING]: true,
});
const GTA_CAPABILITIES = Object.freeze({
    ...EMPTY_CAPABILITIES,
    [SESSION_CAPABILITY.ROAD_VEHICLES]: true,
    [SESSION_CAPABILITY.BOATS]: true,
    [SESSION_CAPABILITY.AIRCRAFT]: true,
    [SESSION_CAPABILITY.AMBIENT_TRAMS]: true,
    [SESSION_CAPABILITY.CROATIA_RAIL_STREAMING]: true,
    [SESSION_CAPABILITY.PARKED_VEHICLES]: true,
    [SESSION_CAPABILITY.TRAFFIC_LIGHTS]: true,
    [SESSION_CAPABILITY.AMBIENT_PEDESTRIANS]: true,
    [SESSION_CAPABILITY.CONTINUOUS_STREAMING]: true,
    [SESSION_CAPABILITY.RENDER_ORIGIN_REBASING]: true,
    [SESSION_CAPABILITY.EXPANDED_BUILDING_STREAMING]: true,
    [SESSION_CAPABILITY.CROATIA_BOUNDS]: true,
    [SESSION_CAPABILITY.SUPPRESS_TRAFFIC_WRECK_DRESSING]: true,
});

export const FREE_ROAM_PRESETS = Object.freeze({
    walk: Object.freeze({ id: 'walk', capabilities: WALK_CAPABILITIES }),
    gta: Object.freeze({ id: 'gta', capabilities: GTA_CAPABILITIES }),
});

export function sessionCapabilityEnabled(capabilities, capability) {
    return capabilities?.[capability] === true;
}

export function resolveFreeRoamPreset(presetId, overrides = null) {
    const normalizedId = String(presetId || '').trim().toLowerCase();
    const preset = FREE_ROAM_PRESETS[normalizedId] || FREE_ROAM_PRESETS.walk;
    if (!overrides || typeof overrides !== 'object') return preset;
    const capabilities = { ...preset.capabilities };
    for (const capability of Object.values(SESSION_CAPABILITY)) {
        if (Object.hasOwn(overrides, capability)) {
            capabilities[capability] = overrides[capability] === true;
        }
    }
    return Object.freeze({
        id: preset.id,
        capabilities: Object.freeze(capabilities),
    });
}

export function enabledVehicleControllerKinds(capabilities) {
    const kinds = [];
    if (sessionCapabilityEnabled(capabilities, SESSION_CAPABILITY.ROAD_VEHICLES)) {
        kinds.push('road');
    }
    if (sessionCapabilityEnabled(capabilities, SESSION_CAPABILITY.BOATS)) {
        kinds.push('boat');
    }
    if (sessionCapabilityEnabled(capabilities, SESSION_CAPABILITY.AIRCRAFT)) {
        kinds.push('aircraft');
    }
    return kinds;
}

export function hasEnterableVehicleCapability(capabilities) {
    return sessionCapabilityEnabled(capabilities, SESSION_CAPABILITY.ROAD_VEHICLES)
        || sessionCapabilityEnabled(capabilities, SESSION_CAPABILITY.BOATS)
        || sessionCapabilityEnabled(capabilities, SESSION_CAPABILITY.AIRCRAFT)
        || sessionCapabilityEnabled(capabilities, SESSION_CAPABILITY.AMBIENT_TRAMS);
}
