// Public host-shell helpers. This entry shares chunks with the runtime build so
// embedded products do not need to import Station3D's private source tree.
export { t, getLang, toggleLang, onLangChange } from './core/i18n.js';
export { isCampaignFeatureEnabled } from './core/campaign-feature.js';
export { prepareFreeRoamOptions } from './core/free-roam-entry.js';
export { createExplorerSessionController } from './core/explorer-session-controller.js';
export { getSoundToggleEl } from './ui/sound-toggle.js';
export { dropLoadingCurtain, raiseLoadingCurtain } from './ui/loading-curtain.js';
export { freeRoamLoadingHeading } from './core/loading-curtain-policy.js';
export { station3dAssetUrl } from './core/asset-url.js';
export {
    bindGlobalAudioUnlock,
    registerAudioElement,
    whenAudioUnlocked,
} from './core/audio-unlock.js';
export {
    campaignCheckpointRequest,
    checkpointAddressRoute,
    openCampaignCheckpoint,
} from './debug/campaign-checkpoint-runner.js';
