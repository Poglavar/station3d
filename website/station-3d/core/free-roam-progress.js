// Persistent progress shared by free-roam sessions. This module deliberately
// knows nothing about the DOM, campaigns, wallets, or payment providers.

export const FREE_ROAM_PROGRESS_KEY = 'station3d:free-roam-progress:v1';
export const JETPACK_PRICE_DINARS = 30_000_000_000;
export const JETPACK_PRICE_BTC = 0.1;

const emptyProgress = () => ({ version: 1, jetpackOwned: false });

export function readFreeRoamProgress(storage) {
    try {
        const raw = storage?.getItem?.(FREE_ROAM_PROGRESS_KEY);
        if (!raw) return emptyProgress();
        const value = JSON.parse(raw);
        if (value?.version !== 1 || typeof value.jetpackOwned !== 'boolean') {
            return emptyProgress();
        }
        return { version: 1, jetpackOwned: value.jetpackOwned };
    } catch (_error) {
        return emptyProgress();
    }
}

export function purchaseJetpack(storage) {
    const progress = readFreeRoamProgress(storage);
    if (progress.jetpackOwned) return { jetpackOwned: true };
    // Deliberately do not catch this: callers must surface storage failure and
    // must never report a purchase that was not persisted.
    storage.setItem(FREE_ROAM_PROGRESS_KEY, JSON.stringify({ version: 1, jetpackOwned: true }));
    return { jetpackOwned: true };
}

export function reduceJetpackShop(state = { phase: 'offer', jetpackOwned: false }, event) {
    const current = {
        phase: state?.phase || 'offer',
        jetpackOwned: state?.jetpackOwned === true,
    };
    if (current.jetpackOwned) return current;
    if (event === 'offer-bitcoin' && current.phase === 'offer') {
        return { phase: 'accepted', jetpackOwned: false };
    }
    if (event === 'buy' && current.phase === 'accepted') {
        return { phase: 'owned', jetpackOwned: true };
    }
    return current;
}
