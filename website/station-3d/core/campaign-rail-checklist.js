// The departure checklist of an authored campaign train: doors closed, parking
// brake released, then rolling. Pure so the sequence and its one-shot events can
// be tested without a cab; the adapter feeds it session snapshots.

// Below this the train is standing, whatever the throttle claims.
const DEPARTURE_SPEED_MPS = 0.5;

export function createRailChecklistState() {
    return {
        doorsClosed: false,
        brakeReleased: false,
        departed: false,
        vehicleId: null,
    };
}

// Emits each step once per boarded vehicle, in order. A step already satisfied
// when the player takes the controls (a train that spawned closed) still emits,
// so a checklist objective can complete instead of waiting for a toggle that
// has nothing left to do.
export function advanceRailChecklist(state, snapshot) {
    const events = [];
    if (!state || !snapshot) return events;
    if (String(snapshot.controllerId || '') !== 'rail') return events;
    const vehicleId = snapshot.vehicleId ? String(snapshot.vehicleId) : null;
    if (vehicleId !== state.vehicleId) {
        state.vehicleId = vehicleId;
        state.doorsClosed = false;
        state.brakeReleased = false;
        state.departed = false;
    }
    if (!state.doorsClosed && snapshot.doorsOpen === false) {
        state.doorsClosed = true;
        events.push({ type: 'rail:doors-closed', vehicleId });
    }
    if (!state.brakeReleased && snapshot.parkingBrake === false) {
        state.brakeReleased = true;
        events.push({ type: 'rail:brake-released', vehicleId });
    }
    const speed = Number(snapshot.speedMps);
    if (!state.departed
        && state.doorsClosed
        && state.brakeReleased
        && Number.isFinite(speed)
        && Math.abs(speed) >= DEPARTURE_SPEED_MPS) {
        state.departed = true;
        events.push({ type: 'rail:departed', vehicleId });
    }
    return events;
}
