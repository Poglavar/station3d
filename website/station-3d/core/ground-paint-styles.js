import { surfacePolicy } from './surface-hierarchy.js';

const unit = n => Number.isFinite(n) && n >= 0 && n <= 1;

export const GROUND_PAINT_STYLE_ROWS = 4;

// Prepare receiver-shading data before publication. The page records ownership;
// repeating patterns retain their original spatial frequency in the receiver.
export function captureGroundPaintMaterialRows(styles, patterns, bounds) {
    if (!Array.isArray(styles?.recipes) || styles.recipes.length > 255
        || !Number.isFinite(bounds?.minX) || !Number.isFinite(bounds?.minZ)) {
        throw new TypeError('Invalid ground paint shading inputs');
    }
    const data = new Float32Array(256 * GROUND_PAINT_STYLE_ROWS * 4);
    for (const recipe of styles.recipes) {
        const offset = recipe.id * 4;
        data.set([recipe.roughness, recipe.metalness, recipe.normalInfluence, recipe.rank], offset);
        data.set([...recipe.linearColor, 0], 1024 + offset);
        if (!recipe.albedoMap) continue;
        const pattern = patterns?.get(recipe.albedoMap);
        if (!pattern || !Number.isSafeInteger(pattern.layer) || pattern.layer < 0
            || !Number.isFinite(pattern.scaleU) || pattern.scaleU <= 0
            || !Number.isFinite(pattern.scaleV) || pattern.scaleV <= 0) {
            throw new TypeError('Ground paint pattern is not prepared');
        }
        const [a, b, c, d, e, f] = recipe.albedoMap.uvTransform;
        const u = a * bounds.minX + b * bounds.minZ + c;
        const v = d * bounds.minX + e * bounds.minZ + f;
        // Reduce whole repeats in CPU double precision. The shader only adds
        // page-local coordinates, including after a floating-origin rebase.
        data[1024 + offset + 3] = pattern.layer + 1;
        data.set([a * pattern.scaleU, b * pattern.scaleU,
            (u - Math.floor(u)) * pattern.scaleU, 0], 2048 + offset);
        data.set([d * pattern.scaleV, e * pattern.scaleV,
            (v - Math.floor(v)) * pattern.scaleV, 0], 3072 + offset);
    }
    if (!data.every(Number.isFinite)) throw new RangeError('Ground paint shading data exceeds finite float storage');
    return data;
}

// IDs are local to a completed page. Copying texels requires the same complete
// table: reassigning an ID must never reinterpret retained pixels as a new style.
export function captureGroundPaintStyles(styles) {
    if (!(styles instanceof Map) || styles.size > 255) throw new TypeError('Invalid paint style table');
    const byKey = new Map(), byId = new Map();
    const data = new Uint8Array(256 * 4);
    for (const [key, input] of styles) {
        const rank = surfacePolicy(input?.surfaceClass).rank;
        if (typeof key !== 'string' || !key || typeof input?.revision !== 'string' || !input.revision
            || !Number.isSafeInteger(input.id) || input.id < 1 || input.id > 255
            || !Number.isInteger(rank) || rank < 0 || rank > 255
            || !unit(input.roughness) || !unit(input.metalness) || !unit(input.normalInfluence)
            || !Array.isArray(input.linearColor) || input.linearColor.length !== 3
            || !input.linearColor.every(unit)) throw new TypeError(`Invalid paint recipe ${key}`);
        if (byId.has(input.id)) throw new Error('Conflicting paint style IDs');
        const map = input.albedoMap;
        if (map != null && (typeof map.key !== 'string' || !map.key
            || typeof map.revision !== 'string' || !map.revision
            || !Array.isArray(map.uvTransform) || map.uvTransform.length !== 6
            || !map.uvTransform.every(Number.isFinite))) throw new TypeError('Invalid paint albedo map');
        const recipe = Object.freeze({ key, id: input.id, revision: input.revision,
            surfaceClass: input.surfaceClass, rank, roughness: input.roughness, metalness: input.metalness,
            normalInfluence: input.normalInfluence, linearColor: Object.freeze([...input.linearColor]),
            albedoMap: map ? Object.freeze({ key: map.key, revision: map.revision,
                uvTransform: Object.freeze([...map.uvTransform]) }) : null });
        byKey.set(key, recipe); byId.set(input.id, recipe);
        data.set([Math.round(recipe.roughness * 255), Math.round(recipe.metalness * 255),
            Math.round(recipe.normalInfluence * 255), rank], recipe.id * 4);
    }
    const recipes = Object.freeze([...byId.values()].sort((a, b) => a.id - b.id));
    return Object.freeze({ key: JSON.stringify(recipes), recipes, byKey: key => byKey.get(key) || null,
        // Callers receive a copy so a candidate cannot mutate an active table.
        copyBytes: () => data.slice(), byteLength: data.byteLength });
}
