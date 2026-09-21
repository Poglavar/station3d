// Validating ESM facade over the hybrid planner/Station3D rule. Importing the
// root script for its side effect works in browsers and through Node's CJS
// interop, leaving every ESM consumer on ordinary named imports.
import '../../tunnel-cover-rule.js';

const rule = globalThis.__tunnelCoverRule;
if (!rule
    || !Number.isFinite(rule.RAIL_TUBE_HEIGHT_ABOVE_RAIL_M)
    || !Number.isFinite(rule.TUNNEL_ROOF_SLAB_COVER_M)
    || !Number.isFinite(rule.TUNNEL_FULL_COVER_MIN_M)
    || !Number.isFinite(rule.TUNNEL_COVER_TOLERANCE_M)
    || Math.abs(
        rule.RAIL_TUBE_HEIGHT_ABOVE_RAIL_M
            + rule.TUNNEL_ROOF_SLAB_COVER_M
            - rule.TUNNEL_FULL_COVER_MIN_M,
    ) > 1e-9) {
    throw new Error('Invalid shared tunnel-cover rule');
}

export const RAIL_TUBE_HEIGHT_ABOVE_RAIL_M = rule.RAIL_TUBE_HEIGHT_ABOVE_RAIL_M;
export const TUNNEL_ROOF_SLAB_COVER_M = rule.TUNNEL_ROOF_SLAB_COVER_M;
export const TUNNEL_FULL_COVER_MIN_M = rule.TUNNEL_FULL_COVER_MIN_M;
export const TUNNEL_COVER_TOLERANCE_M = rule.TUNNEL_COVER_TOLERANCE_M;
