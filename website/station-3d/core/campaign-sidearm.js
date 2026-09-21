// A campaign sidearm: an inventory item that lets the header weapon button
// work on foot. Drawn, the gun is held (first-person mount) and Space fires;
// holstered, walking is back to normal. In a vehicle the same button arms or
// disarms the mounted gun as in free roam. Pure policy; the cab applies it.
export const CAMPAIGN_SIDEARM_ITEM_ID = 'sidearm';

export function campaignSidearmAvailable(run) {
    return Number(run?.inventory?.[CAMPAIGN_SIDEARM_ITEM_ID]) > 0;
}

// What the weapon toggle means right now, or null when it must refuse.
export function weaponToggleIntent({ onFoot = false, sidearmAvailable = false, weaponAttached = false, underground = false } = {}) {
    if (underground) return null;
    if (onFoot) {
        if (!sidearmAvailable) return null;
        return weaponAttached ? 'holster' : 'draw';
    }
    return weaponAttached ? 'disarm' : 'arm';
}

// Whether the header weapon button is usable in this state.
export function weaponToggleEnabled({ showWalk = false, onFoot = false, sidearmAvailable = false } = {}) {
    return showWalk && (!onFoot || sidearmAvailable);
}
