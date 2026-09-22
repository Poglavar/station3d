// Every Station3D session starts at local (0, 0), on a shared tile-grid corner.
// These are the four tiles whose bounds touch the observer. They are the finite
// support contract for the opaque startup hold; wider layer rings and route-ahead
// corridors continue streaming after reveal.

export function initialWorldSupportTileKeys() {
    return new Set(['0_0', '-1_0', '0_-1', '-1_-1']);
}

// The startup curtain needs the current physical ground generation under the
// observer. A published predecessor is not sufficient: source layers can finish
// immediately afterwards and enqueue the rail/road/planner successor that makes
// the first generation obsolete. Revealing between those two publications
// exposes a mixed world (for example a vehicle already on an authored alignment
// while the visible track and terrain still belong to the predecessor).
//
// This check is only used while the initial world-data hold is active. Once it
// has settled, later route-ahead generations continue behind the visible scene
// and do not reopen the curtain.
export function initialGroundSupportReady(groundGenerations) {
    if (!groundGenerations) return true;
    return groundGenerations.isSettled() === true;
}
