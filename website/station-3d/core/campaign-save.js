// Owns the versioned campaign save document, pure migrations, and the thin
// injected-storage adapter used by the browser director.

import { CAMPAIGN_SCHEMA_VERSION } from './campaign-definition.js';

export const CAMPAIGN_SAVE_KEY = 'station3d:campaigns';
export const CAMPAIGN_SAVE_SCHEMA_VERSION = 1;

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function createCampaignSaveDocument() {
    return {
        schemaVersion: CAMPAIGN_SAVE_SCHEMA_VERSION,
        runs: {},
        cinematicUnlocks: {},
    };
}

function migrateSchemaZero(document) {
    return {
        schemaVersion: 1,
        runs: clone(document.campaigns || document.runs || {}),
        cinematicUnlocks: clone(document.cinematicUnlocks || {}),
    };
}

export function migrateCampaignSave(document) {
    let current = clone(document);
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
        throw new Error('Campaign save must be an object.');
    }
    let version = Number(current.schemaVersion) || 0;
    while (version < CAMPAIGN_SAVE_SCHEMA_VERSION) {
        if (version === 0) current = migrateSchemaZero(current);
        else throw new Error(`Unsupported campaign save schema ${version}.`);
        version = Number(current.schemaVersion);
    }
    if (version !== CAMPAIGN_SAVE_SCHEMA_VERSION) {
        throw new Error(`Unsupported campaign save schema ${version}.`);
    }
    if (!current.runs || typeof current.runs !== 'object' || Array.isArray(current.runs)) {
        throw new Error('Campaign save runs are malformed.');
    }
    if (!current.cinematicUnlocks || typeof current.cinematicUnlocks !== 'object'
        || Array.isArray(current.cinematicUnlocks)) {
        throw new Error('Campaign cinematic unlocks are malformed.');
    }
    for (const [campaignId, run] of Object.entries(current.runs)) {
        if (!run || run.campaignId !== campaignId
            || Number(run.schemaVersion) !== CAMPAIGN_SCHEMA_VERSION
            || !run.currentSceneId || !run.checkpoint?.state) {
            throw new Error(`Campaign run "${campaignId}" is malformed.`);
        }
    }
    return current;
}

export function parseCampaignSave(raw) {
    if (raw == null || raw === '') {
        return { ok: true, document: createCampaignSaveDocument(), migrated: false };
    }
    try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : clone(raw);
        const document = migrateCampaignSave(parsed);
        return {
            ok: true,
            document,
            migrated: Number(parsed?.schemaVersion || 0) !== CAMPAIGN_SAVE_SCHEMA_VERSION,
        };
    } catch (error) {
        return {
            ok: false,
            error: error?.message || String(error),
            recovery: createCampaignSaveDocument(),
        };
    }
}

export function saveCampaignRun(document, run) {
    const next = migrateCampaignSave(document);
    next.runs[run.campaignId] = clone(run);
    const unlocked = new Set(next.cinematicUnlocks[run.campaignId] || []);
    for (const cinematicId of run.unlockedCinematics || []) unlocked.add(cinematicId);
    next.cinematicUnlocks[run.campaignId] = [...unlocked];
    return next;
}

export function removeCampaignRun(document, campaignId) {
    const next = migrateCampaignSave(document);
    delete next.runs[campaignId];
    return next;
}

export function campaignWorldEffectsFromSave(document) {
    const parsed = migrateCampaignSave(document);
    const effects = {};
    for (const run of Object.values(parsed.runs)) {
        for (const [id, stage] of Object.entries(run.worldEffects || {})) effects[id] = stage;
    }
    return effects;
}

export function createCampaignStore({ storage, key = CAMPAIGN_SAVE_KEY } = {}) {
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
        throw new Error('Campaign storage adapter requires getItem/setItem.');
    }
    const read = () => parseCampaignSave(storage.getItem(key));
    const write = (document) => {
        const normalized = migrateCampaignSave(document);
        const serialized = JSON.stringify(normalized);
        storage.setItem(key, serialized);
        return normalized;
    };
    return {
        read,
        write,
        recover() {
            return write(createCampaignSaveDocument());
        },
        saveRun(run) {
            const current = read();
            if (!current.ok) throw new Error(current.error);
            return write(saveCampaignRun(current.document, run));
        },
        removeRun(campaignId) {
            const current = read();
            if (!current.ok) throw new Error(current.error);
            return write(removeCampaignRun(current.document, campaignId));
        },
    };
}
