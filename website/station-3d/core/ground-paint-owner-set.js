// Replace one producer's complete immutable owner set without withdrawing
// another producer's paint. Moving a source clears its previous region too.
import { GROUND_GENERATION_LIMITS } from './ground-generation-limits.js';
import { groundPaintCapacity } from './ground-paint-source-plans.js';

export const EMPTY_GROUND_PAINT_OWNERS = Object.freeze([]);

export function* groundPaintOwnerReplacementsSteps(previous, next) {
    const limit = GROUND_GENERATION_LIMITS.paintSources.maxReplacements;
    if (!Array.isArray(previous) || !Array.isArray(next) || !Object.isFrozen(previous) || !Object.isFrozen(next)) {
        throw new TypeError('Ground paint owner sets must be immutable');
    }
    if (previous.length + next.length > limit) throw groundPaintCapacity('Ground paint owner set capacity exceeded');
    const buckets = new Map(), rows = [];
    for (const row of next) {
        if (!buckets.has(row.bucketKey)) buckets.set(row.bucketKey, new Map());
        const owners = buckets.get(row.bucketKey);
        if (owners.has(row.owner)) throw new TypeError('Duplicate ground paint owner');
        owners.set(row.owner, row);
        rows.push(row);
        yield { phase: 'paint-next-owner-set' };
    }
    for (const row of previous) {
        const replacement = buckets.get(row.bucketKey)?.get(row.owner);
        if (!replacement) rows.push(Object.freeze({ bucketKey: row.bucketKey, owner: row.owner, records: null }));
        else if (row.canonical != null && replacement.canonical != null && row.canonical !== replacement.canonical) {
            throw new Error('Ground paint source identity collision');
        }
        yield { phase: 'paint-previous-owner-set' };
    }
    return Object.freeze(rows);
}
