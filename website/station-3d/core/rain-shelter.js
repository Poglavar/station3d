// Cheap semantic shelter policy for rain. It deliberately uses existing
// session facts rather than raycasting every drop or traversing world geometry.
// The frozen results are shared so this per-frame decision allocates nothing.

const SEALED = Object.freeze({ visualExposure: 0, audioExposure: 0, innerRadiusM: 7, muffled: 1 });
const TUNNEL_PORTAL = Object.freeze({ visualExposure: 0, audioExposure: 0, innerRadiusM: 6, muffled: 1 });
const VEHICLE = Object.freeze({ visualExposure: 1, audioExposure: 0.42, innerRadiusM: 3.2, muffled: 0.62 });
const EXPOSED = Object.freeze({ visualExposure: 1, audioExposure: 1, innerRadiusM: 1.2, muffled: 0 });

export function resolveRainShelter(cabState) {
    if (cabState?.isUndergroundSession || cabState?.outsideSuspended) {
        return SEALED;
    }
    if (cabState?.insideTunnelSpan) {
        return TUNNEL_PORTAL;
    }
    if (cabState && !cabState.walkMode) {
        return VEHICLE;
    }
    return EXPOSED;
}
