export const TREE_TYPE_PALM = 'palm';

export function normalizeTreeType(value) {
    return String(value || '').trim().toLowerCase() === TREE_TYPE_PALM
        ? TREE_TYPE_PALM
        : null;
}

export function treeShapeDimensions(totalHeightM, treeType = null) {
    const height = Number.isFinite(totalHeightM) && totalHeightM > 0 ? totalHeightM : 9;
    if (normalizeTreeType(treeType) === TREE_TYPE_PALM) {
        return {
            trunkHeightM: height * 0.78,
            crownRadiusM: height * 0.22 + 0.55,
            trunkRadiusM: Math.max(0.18, Math.min(0.34, height * 0.024)),
        };
    }
    return {
        trunkHeightM: height * 0.48,
        crownRadiusM: height * 0.20 + 0.5,
        trunkRadiusM: 1,
    };
}
