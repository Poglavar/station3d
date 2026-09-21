// Sporadic local-bird calls: the city's bird (locations.js `localBird` —
// seagulls on the coast, hooded crows in Zagreb) calls once every few minutes
// from a random direction at a random distance. Pure ambience: no geometry,
// no per-frame work beyond one clock comparison, and nothing here blocks
// world readiness. Locations without a localBird stay silent.

import {
    birdCallVariant,
    birdForLocation,
    nextBirdCallDelayS,
} from '../core/ambient-bird-calls.js';
import { birdClipCount, playBirdCall, preloadBirdSfx } from '../ui/bird-sfx.js';
import { getLocation } from '../core/locations.js';

let species = null;
let nextCallAtS = Infinity;

const nowSeconds = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;

export const ambientBirdsLayer = {
    beginSession() {
        species = birdForLocation(getLocation());
        if (!species || birdClipCount(species) === 0) {
            species = null;
            nextCallAtS = Infinity;
            return;
        }
        preloadBirdSfx(species);
        nextCallAtS = nowSeconds() + nextBirdCallDelayS(Math.random, { first: true });
    },
    onFrame() {
        if (!species) return;
        const now = nowSeconds();
        if (now < nextCallAtS) return;
        // A dropped call (audio still locked / clips not yet decoded) just
        // reschedules — the bird calls when it calls.
        playBirdCall(species, birdCallVariant(Math.random, birdClipCount(species)));
        nextCallAtS = now + nextBirdCallDelayS(Math.random);
    },
    endSession() {
        species = null;
        nextCallAtS = Infinity;
    },
};

export function getAmbientBirdDebug() {
    return {
        species,
        nextCallInS: Number.isFinite(nextCallAtS)
            ? Math.max(0, nextCallAtS - nowSeconds())
            : null,
    };
}
