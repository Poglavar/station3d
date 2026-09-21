// Generic player/vehicle occupancy state shared by road, water, air and rail
// providers. It deliberately contains no solver, scene or DOM dependencies.

export const OCCUPANT_STATES = Object.freeze({
    ON_FOOT: 'on-foot',
    BOARDING_REQUESTED: 'boarding-requested',
    CONTROLLING: 'controlling',
    EXITING: 'exiting',
});

export function createOccupantState() {
    return {
        state: OCCUPANT_STATES.ON_FOOT,
        providerId: null,
        vehicleId: null,
        controllerId: null,
        lastFailure: '',
    };
}

function resetToFoot(occupant) {
    occupant.state = OCCUPANT_STATES.ON_FOOT;
    occupant.providerId = null;
    occupant.vehicleId = null;
    occupant.controllerId = null;
}

export function requestBoarding(occupant, candidate) {
    if (!occupant || occupant.state !== OCCUPANT_STATES.ON_FOOT) return false;
    if (!candidate || candidate.available === false || candidate.destroyed === true
        || candidate.reachable === false || candidate.id == null) {
        occupant.lastFailure = candidate?.reachable === false
            ? 'vehicle-unreachable' : 'vehicle-unavailable';
        return false;
    }
    occupant.state = OCCUPANT_STATES.BOARDING_REQUESTED;
    occupant.providerId = String(candidate.providerId || candidate.provider || '');
    occupant.vehicleId = String(candidate.id);
    occupant.controllerId = candidate.controllerId == null
        ? null : String(candidate.controllerId);
    occupant.lastFailure = '';
    return true;
}

export function completeBoarding(occupant, claim = {}) {
    if (!occupant || occupant.state !== OCCUPANT_STATES.BOARDING_REQUESTED) return false;
    if (claim.id != null && String(claim.id) !== occupant.vehicleId) {
        occupant.lastFailure = 'vehicle-mismatch';
        return false;
    }
    if (claim.providerId != null && occupant.providerId
        && String(claim.providerId) !== occupant.providerId) {
        occupant.lastFailure = 'provider-mismatch';
        return false;
    }
    occupant.state = OCCUPANT_STATES.CONTROLLING;
    if (claim.controllerId != null) occupant.controllerId = String(claim.controllerId);
    occupant.lastFailure = '';
    return true;
}

export function selectSafeExitCandidate(candidates) {
    // Providers may evaluate support/collision lazily. Stop at the first safe
    // candidate so previews and real exits do not probe unused landing places.
    for (const candidate of candidates || []) {
        if (candidate && candidate.supported !== false
            && candidate.blocked !== true && candidate.headroom !== false) return candidate;
    }
    return null;
}

export function beginExit(occupant, { speedMps, maxSpeedMps, candidates } = {}) {
    if (!occupant || occupant.state !== OCCUPANT_STATES.CONTROLLING) return null;
    if (Math.abs(Number(speedMps) || 0) > Math.max(0, Number(maxSpeedMps) || 0)) {
        occupant.lastFailure = 'vehicle-moving';
        return null;
    }
    const candidate = selectSafeExitCandidate(candidates);
    if (!candidate) {
        occupant.lastFailure = 'no-safe-exit';
        return null;
    }
    occupant.state = OCCUPANT_STATES.EXITING;
    occupant.lastFailure = '';
    return candidate;
}

export function completeExit(occupant) {
    if (!occupant || occupant.state !== OCCUPANT_STATES.EXITING) return false;
    resetToFoot(occupant);
    occupant.lastFailure = '';
    return true;
}

export function cancelOccupantTransition(occupant) {
    if (!occupant) return false;
    if (occupant.state === OCCUPANT_STATES.BOARDING_REQUESTED) {
        resetToFoot(occupant);
        occupant.lastFailure = '';
        return true;
    }
    if (occupant.state === OCCUPANT_STATES.EXITING) {
        occupant.state = OCCUPANT_STATES.CONTROLLING;
        occupant.lastFailure = '';
        return true;
    }
    return false;
}

export function forceOccupantOnFoot(occupant, failure = '') {
    if (!occupant) return false;
    resetToFoot(occupant);
    occupant.lastFailure = String(failure || '');
    return true;
}

// A vehicle exit owns the walker's complete support state. Reusing only the
// latitude/longitude can retain an old spawn floor or airborne velocity.
// Vehicle headings use +Z scene yaw; the walker uses north-facing compass yaw.
export function placeWalkerAtVehicleExit(walker, { lat, lon, y, heading }) {
    if (!walker || ![lat, lon, y, heading].every(Number.isFinite)) return false;
    Object.assign(walker, {
        lat, lon, y, yaw: Math.PI - heading, vy: 0, airborne: false,
        initialGroundY: null, initialSupportLat: lat, initialSupportLon: lon,
        lastDetectedGroundY: y, spawnY: y, floorGuardActive: false, groundMissSeconds: 0,
    });
    return true;
}
