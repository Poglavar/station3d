// Ordinary actors sample reachable player support from their feet or current
// terrain evidence. Missing evidence must never become a highest-roof query.
export function resolveActorSupportY({ x, z, hintY, terrainY, supportYAt, highest = false }) {
    const referenceY = highest ? Infinity : Number.isFinite(hintY) ? hintY
        : Number.isFinite(terrainY) ? terrainY : null;
    if (referenceY === null) return null;
    const y = supportYAt(x, z, referenceY);
    return Number.isFinite(y) ? y : null;
}
