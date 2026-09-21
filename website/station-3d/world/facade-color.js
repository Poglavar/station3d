// Measured facade colours: the real wall colour of a building, read off its Street View
// photograph, keyed by GDI object_id.
//
// Why this exists: buildings are otherwise painted from `use_class`, a categorical palette.
// It is informative and it is not what a city looks like -- a street of ordinary Zagreb
// blocks comes out red and purple, which reads as a diagram. Believability wants the real
// colour, and the real colour is already in photographs we hold.
//
// This layer is deliberately thin. The building still gets its LOD2 massing, its procedural
// openings and its roof; only the wall colour changes. Where there is no measurement --
// which is most buildings, and every building outside Donji grad -- nothing changes at all.
//
// Data: buildings.facade_color, via GET /api/buildings/facade-colors.
// Producer: zagreb-zgrade-datiranje/pipeline/40_facade_color.py (colour, by measurement)
//           and 41_facade_crop_check.py (is the crop a facade at all, by judgement).

import { getApiBase } from '../core/api.js';

const DATA_URL = `${getApiBase()}/buildings/facade-colors`;

let colors = null;          // object_id -> [hex, confidence]
let loadPromise = null;

export function ensureFacadeColorData() {
    if (colors) return Promise.resolve(colors);
    if (loadPromise) return loadPromise;
    loadPromise = fetch(DATA_URL)
        .then((r) => (r.ok ? r.json() : { colors: {} }))
        .then((j) => {
            colors = j.colors || {};
            return colors;
        })
        .catch((err) => {
            // A failed fetch must not take the city with it: every building simply keeps
            // the procedural palette, which is exactly the pre-existing behaviour.
            console.warn('[facade-color] load failed, using the use_class palette:', err);
            colors = {};
            return colors;
        });
    return loadPromise;
}

/**
 * Measured wall colour for this building, or null to fall back to the palette.
 *
 * @param objectId       GDI object_id
 * @param minConfidence  share-of-crop that voted for the colour. The default keeps
 *                       anything the pipeline was willing to publish; raise it to trade
 *                       coverage for certainty.
 * @returns {string|null} '#rrggbb'
 */
export function facadeColorFor(objectId, minConfidence = 0) {
    if (!colors || objectId == null) return null;
    const hit = colors[String(objectId)];
    if (!hit) return null;
    return hit[1] >= minConfidence ? hit[0] : null;
}

/** How many buildings carry a measured colour (0 before the fetch lands). */
export function facadeColorCount() {
    return colors ? Object.keys(colors).length : 0;
}
