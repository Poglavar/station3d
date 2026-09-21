// Static GDI/Overture objects that are known not to be buildings (or are
// replaced by a higher-quality authored model). API drivers do not agree on
// whether numeric object IDs arrive as numbers or strings, so canonicalise both
// the configured values and each lookup before comparing them.

// The Glavni kolodvor platform canopies (GDI 61762/61763/61764/61766 and their
// Overture roofs) are no longer listed here: the `glavni-kolodvor-peroni` landmark
// owns them through buildings.landmark_replacement, the server-side path.
const BLOCKED_OBJECT_IDS = new Set([
    'a03de3ef-4086-49e3-a085-e3a6afde203c',
    61752,
    // Duplicate survey shells at the same footprint as the matched canonical
    // objects 338194, 338196, and 338707. Their tiny Z/topology differences
    // otherwise survive exact-face dedupe and z-fight after ground flattening.
    338195,
    338197,
    338206,
    338211,
    338716,
    338719,
].map(value => String(value).trim().toLowerCase()));

export function isStaticallyBlockedBuildingObjectId(objectId) {
    if (objectId == null) return false;
    const normalized = String(objectId).trim().toLowerCase();
    return normalized !== '' && BLOCKED_OBJECT_IDS.has(normalized);
}
