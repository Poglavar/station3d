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
