// Defines one collision-layer contract for GTA vehicle bodies, firm support
// surfaces, physical obstacles and traffic, including wheel-only ray queries.

export const GTA_COLLISION_MEMBERSHIP = Object.freeze({
    VEHICLE: 1 << 0,
    SUPPORT: 1 << 1,
    WORLD: 1 << 2,
    TRAFFIC_MOVING: 1 << 3,
    TRAFFIC_STATIC: 1 << 4,
});

const ALL_MEMBERSHIPS = 0xffff;

export function interactionGroups(membership, filter) {
    return (((Number(membership) & 0xffff) << 16)
        | (Number(filter) & 0xffff)) >>> 0;
}

export const GTA_COLLISION_GROUPS = Object.freeze({
    chassis: interactionGroups(GTA_COLLISION_MEMBERSHIP.VEHICLE, ALL_MEMBERSHIPS),
    support: interactionGroups(GTA_COLLISION_MEMBERSHIP.SUPPORT, ALL_MEMBERSHIPS),
    obstacle: interactionGroups(GTA_COLLISION_MEMBERSHIP.WORLD, ALL_MEMBERSHIPS),
    // The traffic layer already owns headway, signals and crossing brakes.
    // Letting two route-guided dynamic bodies collide made queues self-compress
    // until Rapier's only free separation axis was upward. Moving traffic still
    // hits the player, the world, support, parked cars, wrecks and trams.
    trafficMoving: interactionGroups(
        GTA_COLLISION_MEMBERSHIP.TRAFFIC_MOVING,
        GTA_COLLISION_MEMBERSHIP.VEHICLE
            | GTA_COLLISION_MEMBERSHIP.SUPPORT
            | GTA_COLLISION_MEMBERSHIP.WORLD
            | GTA_COLLISION_MEMBERSHIP.TRAFFIC_STATIC,
    ),
    trafficStatic: interactionGroups(
        GTA_COLLISION_MEMBERSHIP.TRAFFIC_STATIC,
        GTA_COLLISION_MEMBERSHIP.VEHICLE
            | GTA_COLLISION_MEMBERSHIP.SUPPORT
            | GTA_COLLISION_MEMBERSHIP.WORLD
            | GTA_COLLISION_MEMBERSHIP.TRAFFIC_MOVING,
    ),
    wheelQuery: interactionGroups(
        GTA_COLLISION_MEMBERSHIP.VEHICLE,
        GTA_COLLISION_MEMBERSHIP.SUPPORT,
    ),
    // A chase camera sees firm ground and the immutable world, but not the
    // player chassis or traffic. This keeps a passing car from punching the
    // camera inward while still letting terrain/buildings preserve line of sight.
    cameraQuery: interactionGroups(
        GTA_COLLISION_MEMBERSHIP.VEHICLE,
        GTA_COLLISION_MEMBERSHIP.SUPPORT | GTA_COLLISION_MEMBERSHIP.WORLD,
    ),
});
