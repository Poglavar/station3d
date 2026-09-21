// Lightweight wall-material corrections for survey meshes. Custom landmark geometry and
// source precedence are backend concerns and deliberately do not pass through this module.

import { getApiBase } from '../core/api.js';

const DATA_URL = `${getApiBase()}/buildings/massing-overrides`;

let data = null;
let loadPromise = null;

export function ensureMassingOverrideData() {
    if (data) return Promise.resolve(data);
    if (loadPromise) return loadPromise;
    loadPromise = fetch(DATA_URL)
        .then((response) => (response.ok ? response.json() : { overrides: {}, index: {} }))
        .then((payload) => {
            data = {
                overrides: payload.overrides || {},
                index: payload.index || {},
            };
            return data;
        })
        .catch((error) => {
            console.warn('[massing-overrides] load failed:', error);
            data = { overrides: {}, index: {} };
            return data;
        });
    return loadPromise;
}

export function massingOverrideFor(objectId) {
    if (!data || objectId == null) return null;
    const key = data.index[String(objectId)];
    return key ? data.overrides[key] : null;
}
