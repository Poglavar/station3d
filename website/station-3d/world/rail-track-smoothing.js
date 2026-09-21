// Shared horizontal-geometry policy for every Station3D rail entry path.
// Dense urban tram geometry keeps conservative corner filtering around
// switches. Coarsely sampled heavy rail needs gentle heading changes rounded
// too, while hand-drawn proposal lines retain their broader sketch cleanup.

import { smoothTrackFeatures } from '../core/track-smooth.js';
import { isHeavyRailProperties } from './tram-trackbed-dimensions.js';

export const HEAVY_RAIL_SMOOTHING_OPTIONS = Object.freeze({
    minTurnDeg: 0.05,
    maxTurnDeg: 12,
    maxFilletM: 9.5,
});

const PROPOSAL_SMOOTHING_OPTIONS = Object.freeze({
    maxTurnDeg: 178,
    maxFilletM: 40,
});

export function railSmoothingOptionsForFeature(feature) {
    const properties = feature?.properties || {};
    if (properties.source === 'cb-proposal' || properties.proposalId != null) {
        return PROPOSAL_SMOOTHING_OPTIONS;
    }
    return isHeavyRailProperties(properties)
        ? HEAVY_RAIL_SMOOTHING_OPTIONS
        : null;
}

export function smoothRailTrackFeatures(features) {
    return smoothTrackFeatures(features, {
        optionsForFeature: railSmoothingOptionsForFeature,
    });
}
