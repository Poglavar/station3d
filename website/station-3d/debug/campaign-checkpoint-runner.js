// Deep-link parsing for canonical campaign checkpoints. Local hosts may jump
// directly to a checkpoint; public explorer URLs reopen the campaign normally.

import { isLocalScenarioHost } from '../core/scenario-catalog.js';
import { isCampaignFeatureEnabled } from '../core/campaign-feature.js';
import '../../station3d-links.js';

export const CAMPAIGN_CHECKPOINT_MODE = 'campaign';

export function campaignCheckpointRequest(search, hostname, pathname = '/', options = {}) {
    if (!isCampaignFeatureEnabled({ hostname })) {
        return { ok: false, reason: 'feature-disabled' };
    }
    if (!isLocalScenarioHost(hostname)) return { ok: false, reason: 'host-not-local' };
    const route = globalThis.__station3DLinks.parseExplorerUrl(
        `http://localhost${pathname}${search || ''}`,
        options,
    );
    const params = new URLSearchParams(search || '');
    if (route.mode !== CAMPAIGN_CHECKPOINT_MODE) {
        return { ok: false, reason: 'mode-mismatch' };
    }
    const campaignId = route.campaignId || (params.get('campaign') || '').trim();
    if (!campaignId) return { ok: false, reason: 'campaign-missing' };
    const checkpointId = route.checkpointId || (params.get('checkpoint') || '').trim();
    if (!checkpointId) return { ok: false, reason: 'checkpoint-missing' };
    return { ok: true, campaignId, checkpointId };
}

export function checkpointAddressRoute(checkpoint) {
    if (checkpoint?.ok) return null;
    if (checkpoint?.reason === 'host-not-local') {
        return { kind: 'campaign', checkpointId: null };
    }
    return { kind: 'invalid', error: checkpoint?.reason || 'checkpoint-unavailable' };
}

function publishState(next) {
    window.__station3DCampaignCheckpoint = Object.freeze({
        updatedAt: new Date().toISOString(),
        ...next,
    });
    return window.__station3DCampaignCheckpoint;
}

export async function openCampaignCheckpoint({
    station3D = window.Station3D,
    search = window.location.search,
    hostname = window.location.hostname,
    pathname = globalThis.window?.location?.pathname || '/',
} = {}) {
    const request = campaignCheckpointRequest(search, hostname, pathname);
    if (!request.ok) {
        throw new Error(`Campaign checkpoint link refused: ${request.reason}.`);
    }
    if (typeof station3D?.campaigns?.startCheckpoint !== 'function') {
        throw new Error('The Station3D campaign checkpoint runtime is unavailable.');
    }
    publishState({ status: 'opening', ...request });
    const run = await station3D.campaigns.startCheckpoint(
        request.campaignId,
        request.checkpointId,
    );
    return publishState({
        status: 'ready',
        campaignId: request.campaignId,
        checkpointId: request.checkpointId,
        sceneId: run?.currentSceneId || null,
        runId: run?.runId || null,
    });
}
