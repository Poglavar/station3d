// What the rails layer does with an in-flight cooperative formation build when
// its inputs move underneath it, kept pure so the frame ordering can be pinned
// by a test. The ordering matters: a terrain revision that touched no rail
// geometry used to discard the unpublished streamed build, and the streamed
// refresh re-created it on the same frame before the terrain flag was ever
// consumed — so every frame dropped and re-created the build (3,375 times in
// 135 s on the Zagreb main line), the formation never published, and the
// embankment west of Savska stayed bare while the world reported itself
// settled.

export const RAIL_BUILD_DISPOSITION = Object.freeze({
    DROP_TERRAIN: 'drop:terrain',
    CONSUME_TERRAIN: 'consume-terrain',
    STEP: 'step',
});

// A terrain revision only costs the build its progress when the change can
// have reached something the build samples: the published rail geometry, or
// the chords of its own features. A streamed tile delivered since the build was
// staged is not a reason at all: the set it was built from is still a complete,
// exact network as of that revision, so it finishes and publishes as a snapshot
// and the streamed refresh catches up. Dropping superseded builds restarted the
// formation on every delivery, and a streaming start showed no rail until the
// whole corridor had settled — about a minute in Zagreb.
export function pendingRailFormationBuildDisposition({
    terrainRevisionDirty = false,
    terrainFullRefresh = false,
    terrainTouchesRail = false,
} = {}) {
    if (terrainRevisionDirty !== true) return RAIL_BUILD_DISPOSITION.STEP;
    if (terrainFullRefresh === true || terrainTouchesRail === true) {
        return RAIL_BUILD_DISPOSITION.DROP_TERRAIN;
    }
    return RAIL_BUILD_DISPOSITION.CONSUME_TERRAIN;
}

export const RAIL_VISUAL_REFRESH_DISPOSITION = Object.freeze({
    DISCARD_TERRAIN: 'discard:terrain',
    CONTINUE: 'continue',
});

// What happens to a staged visual refresh (trackbed strips, render cells,
// structures) when its inputs move before it publishes. A terrain revision
// makes the heights it sampled stale and a replacement formation follows, so
// it is discarded rather than built twice. A streamed tile delivered since the
// formation it draws was published is not a reason: that formation is a
// complete network as of its input revision, and the publication bookkeeping
// already schedules the catch-up. Discarding it on every delivery meant a slow
// API drew no street rail until the corridor's last tile had arrived, about
// two minutes at the Sloboda Zagreb start on zagreb.lol (2026-09-11).
export function pendingRailVisualRefreshDisposition({
    terrainRevisionDirty = false,
} = {}) {
    return terrainRevisionDirty === true
        ? RAIL_VISUAL_REFRESH_DISPOSITION.DISCARD_TERRAIN
        : RAIL_VISUAL_REFRESH_DISPOSITION.CONTINUE;
}

// A streamed refresh must not start while a terrain revision is unconsumed:
// the build it creates would be discarded for that same revision on the next
// frame, and the terrain consumer that follows the streamed branch in the frame
// would never be reached.
export function streamedRailRefreshAllowed({
    streamedRailDirty = false,
    terrainRevisionDirty = false,
} = {}) {
    return streamedRailDirty === true && terrainRevisionDirty !== true;
}

// Local-frame chords of the features an unpublished build samples terrain for.
// The published-geometry impact test cannot see them: before the first
// publication it sees nothing at all.
export function railFeatureChords(features, toLocal) {
    const chords = [];
    if (typeof toLocal !== 'function') return chords;
    for (const feature of features || []) {
        const geometry = feature?.geometry;
        const lines = geometry?.type === 'MultiLineString'
            ? geometry.coordinates
            : geometry?.type === 'LineString'
                ? [geometry.coordinates]
                : [];
        for (const line of lines || []) {
            let previous = null;
            for (const position of line || []) {
                const local = toLocal(Number(position?.[0]), Number(position?.[1]));
                if (!local || !Number.isFinite(local.x) || !Number.isFinite(local.z)) {
                    previous = null;
                    continue;
                }
                if (previous) {
                    chords.push({ x1: previous.x, z1: previous.z, x2: local.x, z2: local.z });
                }
                previous = local;
            }
        }
    }
    return chords;
}
