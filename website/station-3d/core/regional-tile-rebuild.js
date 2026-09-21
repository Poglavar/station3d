// Pure scheduler for presentation-only tile rebuilds. Data stays owned by the
// existing stream; this only orders stale cached payloads nearest-first so a
// regional transition can replay them through the normal bounded build queue.

export function planRegionalTileRebuild(tilePayloads, nextArchitectureId, {
    tileM,
    focusX = 0,
    focusZ = 0,
} = {}) {
    const pitch = Math.max(1, Number(tileM) || 1);
    const target = String(nextArchitectureId || '');
    const distanceSq = tileKey => {
        const [tileX, tileZ] = String(tileKey).split('_').map(Number);
        if (!Number.isFinite(tileX) || !Number.isFinite(tileZ)) return Infinity;
        const centerX = (tileX + 0.5) * pitch;
        const centerZ = (tileZ + 0.5) * pitch;
        return (centerX - Number(focusX || 0)) ** 2
            + (centerZ - Number(focusZ || 0)) ** 2;
    };
    return [...(tilePayloads?.entries?.() || [])]
        .filter(([, payload]) => payload?.architectureId !== target)
        .sort((left, right) => distanceSq(left[0]) - distanceSq(right[0]))
        .map(([tileKey, payload]) => ({
            tileKey,
            payload,
            architectureId: target,
        }));
}

// Admission is separate from invalidation. The queue retains obligations for
// tiles already rebuilding; their current generation must finish before a
// newer one can start. The caller's live replacement map owns slot lifetime.
export function takeNextTileRebuild(tasks, {
    tilePayloads,
    activeTiles,
    maxActive = 2,
    tileM = 100,
    focusX = 0,
    focusZ = 0,
    stillNeeded = () => true,
} = {}) {
    let kept = 0;
    for (const task of tasks) {
        const current = tilePayloads.get(task.tileKey);
        if (current !== task.payload || !stillNeeded(task, current)) continue;
        tasks[kept++] = task;
    }
    tasks.length = kept;
    if (!Number.isInteger(maxActive) || maxActive < 1) throw new RangeError('maxActive must be a positive integer');
    if (activeTiles.size >= maxActive) return null;
    let nextIndex = -1;
    let nearestSq = Infinity;
    const pitch = Math.max(1, Number(tileM) || 1);
    for (let index = 0; index < tasks.length; index++) {
        const task = tasks[index];
        if (activeTiles.has(String(task.tileKey))) continue;
        const [x, z] = String(task.tileKey).split('_').map(Number);
        const distanceSq = ((x + 0.5) * pitch - focusX) ** 2
            + ((z + 0.5) * pitch - focusZ) ** 2;
        if (nextIndex < 0 || distanceSq < nearestSq) {
            nextIndex = index;
            nearestSq = distanceSq;
        }
    }
    return nextIndex < 0 ? null : tasks.splice(nextIndex, 1)[0];
}
