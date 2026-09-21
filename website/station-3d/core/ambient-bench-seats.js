// Shared ambient-seat registry for every bench source in the streamed world.
// Decor, courtyards and roofs publish the same small seat contract, so the
// pedestrian state machine does not need source-specific sitting paths.

const seatsById = new Map();
const seatIdsByOwner = new Map();

function ownerKey(ownerId) {
    return String(ownerId ?? '');
}

function normalizedSeat(seat, ownerId) {
    const id = seat?.id == null ? '' : String(seat.id);
    const x = Number(seat?.x);
    const z = Number(seat?.z);
    const seatY = Number(seat?.seatY);
    const yaw = Number(seat?.yaw);
    if (!id || ![x, z, seatY].every(Number.isFinite)) return null;
    return {
        ...seat,
        id,
        x,
        z,
        seatY,
        yaw: Number.isFinite(yaw) ? yaw : 0,
        ownerId,
    };
}

export function clearAmbientBenchSeats(ownerId) {
    const owner = ownerKey(ownerId);
    const ids = seatIdsByOwner.get(owner);
    if (!ids) return 0;
    let removed = 0;
    for (const id of ids) {
        if (seatsById.get(id)?.ownerId !== owner) continue;
        seatsById.delete(id);
        removed += 1;
    }
    seatIdsByOwner.delete(owner);
    return removed;
}

export function replaceAmbientBenchSeats(ownerId, seats) {
    const owner = ownerKey(ownerId);
    clearAmbientBenchSeats(owner);
    if (!owner || !Array.isArray(seats) || seats.length === 0) return 0;
    const ids = new Set();
    for (const candidate of seats) {
        const seat = normalizedSeat(candidate, owner);
        if (!seat) continue;
        const previous = seatsById.get(seat.id);
        if (previous && previous.ownerId !== owner) {
            seatIdsByOwner.get(previous.ownerId)?.delete(seat.id);
        }
        seatsById.set(seat.id, seat);
        ids.add(seat.id);
    }
    if (ids.size > 0) seatIdsByOwner.set(owner, ids);
    return ids.size;
}

export function removeAmbientBenchSeat(id, ownerId = null) {
    const key = String(id ?? '');
    const seat = seatsById.get(key);
    if (!seat) return false;
    if (ownerId != null && seat.ownerId !== ownerKey(ownerId)) return false;
    seatsById.delete(key);
    const ids = seatIdsByOwner.get(seat.ownerId);
    ids?.delete(key);
    if (ids?.size === 0) seatIdsByOwner.delete(seat.ownerId);
    return true;
}

export function getAmbientBenchSeat(id) {
    return seatsById.get(String(id ?? '')) || null;
}

export function visitAmbientBenchSeatsNear(localX, localZ, radiusM, visitor) {
    if (typeof visitor !== 'function') return 0;
    const x = Number(localX);
    const z = Number(localZ);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return 0;
    const radius = Math.max(0, Number(radiusM) || 0);
    const radiusSq = radius * radius;
    let visited = 0;
    for (const seat of seatsById.values()) {
        const dx = seat.x - x;
        const dz = seat.z - z;
        if (dx * dx + dz * dz > radiusSq) continue;
        visited += 1;
        if (visitor(seat) === false) break;
    }
    return visited;
}

export function ambientBenchSeatCount() {
    return seatsById.size;
}
