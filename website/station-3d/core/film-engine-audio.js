// How a film mixes the engine of the aircraft it stars. A cinematic authors
// `engineAudio` segments: `{ follow: 'stand-in' }` makes the engine follow the
// set piece's stand-in aircraft, swelling as it passes the camera with the
// pitch rising on the approach and falling away after; `{ gain }` holds the
// engine at a share of its level, under narration. Pure —
// ui/gta-special-vehicle-audio.js applies the mix to the recorded loop.

const SPEED_OF_SOUND_MPS = 343;

export const NEUTRAL_ENGINE_MIX = Object.freeze({ gainScale: 1, rateScale: 1 });

const finite = value => typeof value === 'number' && Number.isFinite(value);

function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
}

export function filmEngineAudioSegment(track, elapsedMs) {
    const segments = track?.engineAudio;
    if (!Array.isArray(segments) || !finite(elapsedMs)) return null;
    return segments.find(segment => elapsedMs >= (segment.fromMs ?? 0)
        && elapsedMs < (segment.toMs ?? Infinity)) || null;
}

// Distance and Doppler for an engine passing the listener. Positions and the
// velocity are scene metres (per second); `referenceM` is where the film hears
// the engine at its flown level.
export function flybyEngineMix({ listener, source, velocity = null, referenceM = 60 }) {
    if (!finite(listener?.x) || !finite(source?.x)) return NEUTRAL_ENGINE_MIX;
    const dx = source.x - listener.x;
    const dy = source.y - listener.y;
    const dz = source.z - listener.z;
    const distanceM = Math.hypot(dx, dy, dz);
    const gainScale = clamp((referenceM / Math.max(distanceM, 6)) ** 0.8, 0.25, 2.6);
    let rateScale = 1;
    if (finite(velocity?.x) && finite(velocity?.y) && finite(velocity?.z) && distanceM > 1e-3) {
        const approachMps = -(velocity.x * dx + velocity.y * dy + velocity.z * dz) / distanceM;
        rateScale = clamp(SPEED_OF_SOUND_MPS / (SPEED_OF_SOUND_MPS - clamp(approachMps, -150, 150)), 0.8, 1.25);
    }
    return { gainScale, rateScale, distanceM };
}

// The mix for one film frame: `standIn` is `{ position, velocity }` of the
// filmed stand-in aircraft, or null when no set piece flies one.
export function filmEngineMix({ segment, listener, standIn = null }) {
    if (!segment) return NEUTRAL_ENGINE_MIX;
    if (segment.follow === 'stand-in') {
        return standIn
            ? flybyEngineMix({ listener, source: standIn.position, velocity: standIn.velocity })
            : NEUTRAL_ENGINE_MIX;
    }
    return finite(segment.gain)
        ? { gainScale: clamp(segment.gain, 0, 4), rateScale: 1 }
        : NEUTRAL_ENGINE_MIX;
}
