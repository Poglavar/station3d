import { MODEL_CODES } from '../models/model-codes.js';

// Avoid 0/O and 1/I so short model codes are easy to read and share.
export const MODEL_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function generateModelCode(usedCodes, randomBytes = bytes => crypto.getRandomValues(bytes)) {
    for (;;) {
        const bytes = randomBytes(new Uint8Array(4));
        const code = Array.from(bytes, value => MODEL_CODE_ALPHABET[value % MODEL_CODE_ALPHABET.length]).join('');
        if (!usedCodes.has(code)) return code;
    }
}

export function namedModel(entry, code = MODEL_CODES[entry.id]) {
    if (!code) throw new Error(`Assign a permanent code to ${entry.id} with npm run models:codes.`);
    return { ...entry, name: entry.label, code, label: `${entry.label} ${code}` };
}

export function validateModelCodes(entries, codes = MODEL_CODES) {
    const used = new Set();
    for (const [id, code] of Object.entries(codes)) {
        if (typeof code !== 'string' || code.length !== 4 || [...code].some(letter => !MODEL_CODE_ALPHABET.includes(letter))) throw new Error(`Invalid model code for ${id}: ${code}`);
        if (used.has(code)) throw new Error(`Duplicate model code: ${code}`);
        used.add(code);
    }
    const ids = new Set();
    for (const entry of entries) {
        if (ids.has(entry.id)) throw new Error(`Duplicate model ID: ${entry.id}`);
        ids.add(entry.id);
        if (!codes[entry.id]) throw new Error(`Missing model code: ${entry.id}. Run npm run models:codes.`);
    }
}

/**
 * A site's own viewer models (the module a page names in <meta name="station3d-model-catalog">): its
 * MODEL_CATALOG entries, shaped like model-catalog.js's, named with its MODEL_CODES. Throws when an entry has no
 * valid code, or an id or code is already the engine's (a code the engine still lists for the same id is the
 * site's own, kept from before the split).
 */
export function siteModelEntries(site, { engineEntries = [], engineCodes = MODEL_CODES } = {}) {
    const entries = site?.MODEL_CATALOG, codes = site?.MODEL_CODES;
    if (!Array.isArray(entries) || !codes || typeof codes !== 'object') {
        throw new Error('A site model catalog exports MODEL_CATALOG (an array) and MODEL_CODES (id to code).');
    }
    const engineIds = new Set(engineEntries.map(entry => entry.id));
    const engineIdByCode = new Map(Object.entries(engineCodes).map(([id, code]) => [code, id]));
    validateModelCodes(entries, codes);
    return entries.map(entry => {
        if (typeof entry?.create !== 'function') throw new Error(`Site model ${entry?.id} has no create().`);
        if (engineIds.has(entry.id)) throw new Error(`Site model ${entry.id} has the id of an engine model.`);
        const code = codes[entry.id], owner = engineIdByCode.get(code);
        if (owner && owner !== entry.id) throw new Error(`Site model ${entry.id} has the code ${code} of ${owner}.`);
        return namedModel(entry, code);
    });
}
