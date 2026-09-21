// Which close gestures must ask first. Escape, the × button and the backdrop
// are all easy to hit by accident, so every live simulation (cab, walk, GTA,
// campaign scenes) and every session still loading asks before the world is
// torn down. Only an empty modal (the campaign menu with nothing running) and
// the station preview close at once; the public Station3D.close() API bypasses
// this UI policy for deliberate lifecycle shutdown.
export function shouldConfirmSessionExit(cabState, pendingMode = null) {
    if (pendingMode !== null) return pendingMode !== 'static';
    return !!cabState;
}
