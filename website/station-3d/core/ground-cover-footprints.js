// Keep catch-all paving footprints with their published road aggregate. A
// detached successor cannot paint, accumulate duplicates or outlive its owner.
export const GROUND_COVER_FOOTPRINT_LIMITS = Object.freeze({
    maxOwners: 2048,
    maxPoints: 131072,
});

export function createGroundCoverFootprints({ onChanged = () => {} } = {}) {
    const buckets = new Map();
    let epoch = 0;

    function* prepareBucketSteps(bucketKey, ownerRings, {
        isCurrent = () => true,
        maxOwners = GROUND_COVER_FOOTPRINT_LIMITS.maxOwners,
        maxPoints = GROUND_COVER_FOOTPRINT_LIMITS.maxPoints,
    } = {}) {
        if (typeof bucketKey !== 'string' || !bucketKey) throw new TypeError('Ground-cover bucket requires an owner');
        if (![maxOwners, maxPoints].every(value => Number.isSafeInteger(value) && value > 0)) {
            throw new TypeError('Ground-cover footprint limits must be positive integers');
        }
        const capturedEpoch = epoch;
        const previous = buckets.get(bucketKey) || null;
        const current = () => epoch === capturedEpoch && (buckets.get(bucketKey) || null) === previous && isCurrent();
        const owners = new Map();
        let points = 0, ringCount = 0, changed = false;
        for (const [owner, rings] of ownerRings) {
            if (!current()) return null;
            if (typeof owner !== 'string' || !owner || owners.has(owner)) throw new TypeError('Invalid ground-cover source owner');
            if (!Array.isArray(rings) || rings.length === 0) continue;
            if (owners.size >= maxOwners) throw new Error('Ground-cover footprint owner capacity exceeded');
            const old = previous?.owners.get(owner);
            const copies = [];
            let same = !!old && old.length === rings.length;
            for (const [index, ring] of rings.entries()) {
                if (!Array.isArray(ring) || ring.length < 3) throw new TypeError('Ground-cover footprint requires a complete ring');
                if (points + ring.length > maxPoints) throw new Error('Ground-cover footprint point capacity exceeded');
                const copy = [];
                if (old?.[index]?.length !== ring.length * 2) same = false;
                for (const point of ring) {
                    if (!current()) return null;
                    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.z)) throw new TypeError('Invalid ground-cover footprint point');
                    const offset = copy.length;
                    if (old?.[index]?.[offset] !== point.x || old?.[index]?.[offset + 1] !== point.z) same = false;
                    copy.push(point.x, point.z);
                    // The aggregate driver checks its clock after every point.
                    yield;
                }
                points += ring.length; ringCount++;
                copies.push(Object.freeze(copy));
            }
            owners.set(owner, same ? old : Object.freeze(copies));
            changed ||= !same;
            yield;
        }
        if (!current()) return null;
        changed ||= owners.size !== (previous?.owners.size || 0);
        const next = changed ? (owners.size ? { owners, points, ringCount } : null) : previous;
        let state = 'prepared';
        return {
            isCurrent: () => state === 'prepared' && current(),
            commit() {
                if (state !== 'prepared' || !current()) return false;
                if (next) buckets.set(bucketKey, next); else buckets.delete(bucketKey);
                state = 'committed';
                return true;
            },
            rollback() {
                if (state !== 'committed') return;
                if (epoch !== capturedEpoch || (buckets.get(bucketKey) || null) !== next) {
                    throw new Error('Cannot roll back a superseded ground-cover footprint');
                }
                if (previous) buckets.set(bucketKey, previous); else buckets.delete(bucketKey);
                state = 'prepared';
            },
            discard() {
                if (state === 'committed') throw new Error('Roll back ground-cover footprints before discarding');
                state = 'discarded';
            },
            finalize() {
                if (state !== 'committed') return false;
                state = 'finalized';
                if (changed) onChanged();
                return true;
            },
        };
    }

    return {
        prepareBucketSteps,
        *rings() {
            for (const bucket of buckets.values()) for (const rings of bucket.owners.values()) yield* rings;
        },
        clear() {
            epoch++;
            const changed = buckets.size > 0;
            buckets.clear();
            if (changed) onChanged();
        },
        debugState() {
            let owners = 0, rings = 0, points = 0;
            for (const bucket of buckets.values()) {
                owners += bucket.owners.size; rings += bucket.ringCount; points += bucket.points;
            }
            return { buckets: buckets.size, owners, rings, points };
        },
    };
}
