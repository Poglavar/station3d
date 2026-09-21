// Pure proposal-startup policies: reuse caller-provided records before I/O,
// and keep Zagreb's GDI-specific building carve out of other city adapters.

export async function loadRecordsById(ids, prefetchedRecords, fetchById) {
    const prefetched = new Map();
    for (const entry of prefetchedRecords || []) {
        if (entry?.id == null || entry?.record == null) continue;
        prefetched.set(String(entry.id), entry.record);
    }
    return Promise.all((ids || []).map((id) => {
        const key = String(id);
        return prefetched.has(key) ? prefetched.get(key) : fetchById(id);
    }));
}

export function shouldLoadLegacyGdiCarves(cityId) {
    return String(cityId || '').trim().toLowerCase() === 'zagreb';
}
