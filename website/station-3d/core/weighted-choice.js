// Pure weighted selection shared by deterministic streamed spawns and random
// ambient traffic. Zero-weight entries are never selected.

export function chooseWeighted(items, unitValue = 0) {
    const candidates = (items || []).filter(item => Number(item?.weight) > 0);
    if (candidates.length === 0) return null;
    const total = candidates.reduce((sum, item) => sum + Number(item.weight), 0);
    const unit = Math.max(0, Math.min(1 - Number.EPSILON, Number(unitValue) || 0));
    let cursor = unit * total;
    for (const item of candidates) {
        cursor -= Number(item.weight);
        if (cursor < 0) return item;
    }
    return candidates[candidates.length - 1];
}
