// Registers reusable localhost-only development scenarios and resolves a
// scenario/checkpoint deep link without coupling the runner to one campaign.

import {
    campaignBoatCheckpoint,
    campaignTrainCheckpoint,
} from './campaign-transport-spikes.js';
import { flagEnabled, isPhotoLikeWorld } from './terrain-request.js';

export const SCENARIO_MODE = 'scenario';

const MODEL_TERRAIN_WORLD = Object.freeze({
    mode: 'model',
    terrain: 'required',
});

const SCENARIOS = Object.freeze({
    'boat-crossing': Object.freeze({
        id: 'boat-crossing',
        kind: 'boat',
        title: 'Boat crossing',
        world: MODEL_TERRAIN_WORLD,
        checkpointIds: Object.freeze(['vis-departure', 'split-arrival']),
        resolveCheckpoint: campaignBoatCheckpoint,
    }),
    'heavy-rail': Object.freeze({
        id: 'heavy-rail',
        kind: 'train',
        title: 'Heavy rail',
        world: MODEL_TERRAIN_WORLD,
        checkpointIds: Object.freeze([
            'split-departure',
            'lika-inspection',
            'zagreb-platform-arrival',
        ]),
        resolveCheckpoint: campaignTrainCheckpoint,
    }),
});

export function scenarioCatalog() {
    return Object.values(SCENARIOS).map(({ resolveCheckpoint, ...scenario }) => ({
        ...scenario,
        checkpointIds: [...scenario.checkpointIds],
    }));
}

export function isLocalScenarioHost(hostname) {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(
        String(hostname || '').trim().toLowerCase(),
    );
}

export function resolveScenarioWorldSearch(search, world = null) {
    const params = new URLSearchParams(search || '');
    if (world?.terrain === 'required') {
        if (isPhotoLikeWorld(params)) {
            return { ok: false, reason: 'photo-world-conflict' };
        }
        if (params.has('elevation') && !flagEnabled(params, 'elevation')) {
            return { ok: false, reason: 'terrain-disabled' };
        }
        params.set('elevation', '1');
    }
    const query = params.toString();
    const canonicalSearch = query ? `?${query}` : '';
    return {
        ok: true,
        canonicalSearch,
        changed: canonicalSearch !== String(search || ''),
    };
}

export function scenarioRequest(
    search,
    hostname = globalThis.location?.hostname || '',
) {
    const params = new URLSearchParams(search || '');
    if ((params.get('st3d') || '').trim().toLowerCase() !== SCENARIO_MODE) {
        return { ok: false, reason: 'mode' };
    }
    if (!isLocalScenarioHost(hostname)) {
        return { ok: false, reason: 'localhost-only' };
    }
    const scenarioId = (params.get('id') || '').trim().toLowerCase();
    const checkpointId = (params.get('checkpoint') || '').trim().toLowerCase();
    const scenario = SCENARIOS[scenarioId];
    if (!scenario) return { ok: false, reason: 'unknown-scenario', scenarioId };
    const checkpoint = scenario.resolveCheckpoint(checkpointId);
    if (!checkpoint || !scenario.checkpointIds.includes(checkpointId)) {
        return {
            ok: false,
            reason: 'unknown-checkpoint',
            scenarioId,
            checkpointId,
        };
    }
    const worldSearch = resolveScenarioWorldSearch(search, scenario.world);
    if (!worldSearch.ok) {
        return {
            ok: false,
            reason: worldSearch.reason,
            scenarioId,
            checkpointId,
        };
    }
    return {
        ok: true,
        scenarioId,
        checkpointId,
        kind: scenario.kind,
        checkpoint,
        world: scenario.world,
        canonicalSearch: worldSearch.canonicalSearch,
        worldSearchChanged: worldSearch.changed,
    };
}
