// Every Station3D session starts at local (0, 0), on a shared tile-grid corner.
// These are the four tiles whose bounds touch the observer. They are the finite
// support contract for the opaque startup hold; wider layer rings and route-ahead
// corridors continue streaming after reveal.

export function initialWorldSupportTileKeys() {
    return new Set(['0_0', '-1_0', '0_-1', '-1_-1']);
}

// The startup curtain needs one complete physical ground publication under the
// observer. Successor generations may immediately start for a route-ahead
// corridor; they retain the already published world and must stream behind the
// visible scene instead of reopening the initial hold.
export function initialGroundSupportReady(groundGenerations) {
    if (!groundGenerations) return true;
    if (groundGenerations.isSettled()) return true;
    return Number(groundGenerations.snapshot?.().published) > 0;
}
