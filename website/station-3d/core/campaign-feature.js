// Central campaign release gate, plus the one string shared by the two screens
// a chapter load can be behind. The campaign is released on deployed hosts
// (2026-09-11); loopback development keeps its own switch.

export const CAMPAIGN_PRODUCTION_ENABLED = true;

const LOCAL_CAMPAIGN_HOSTS = new Set([
    'localhost',
    '127.0.0.1',
    '::1',
    '[::1]',
]);

// "Poglavlje 4 · Zagreb · Kontakt" — the heading the campaign curtain and the
// world-build hold both carry, so a chapter load never reads as a blank screen.
// Pure: the caller localizes both halves.
export function campaignSceneLoadingTitle(chapterLabel, sceneTitle) {
    return [chapterLabel, sceneTitle]
        .map(part => String(part == null ? '' : part).trim())
        .filter(Boolean)
        .join(' · ');
}

// The same heading split the way the chapter card is: the chapter as a small
// gold eyebrow, the scene title as the mark. The world-build hold shows this
// so a chapter load is the chapter card, not a black screen followed by one.
export function campaignSceneLoadingHeading(chapterLabel, sceneTitle) {
    const eyebrow = String(chapterLabel == null ? '' : chapterLabel).trim();
    const headline = String(sceneTitle == null ? '' : sceneTitle).trim();
    return Object.freeze({
        eyebrow,
        headline,
        text: campaignSceneLoadingTitle(eyebrow, headline),
    });
}

export function isCampaignFeatureEnabled({
    hostname = globalThis.location?.hostname || '',
    productionEnabled = CAMPAIGN_PRODUCTION_ENABLED,
    localDevelopmentEnabled = true,
} = {}) {
    if (productionEnabled === true) return true;
    if (!localDevelopmentEnabled) return false;
    return LOCAL_CAMPAIGN_HOSTS.has(String(hostname).trim().toLowerCase());
}
