// The TMK 2400 nose shape, in one place.
//
// The streamlined cab cap is a swept ring surface; anything mounted ON it —
// headlight housing, line-number plate — has to know where its surface actually
// is. Deriving that separately from the mesh is how the lights and the line
// plate ended up floating in mid-air ahead of the vehicle: the plate sat 0.89 m
// in front of the shell, at a height the shell does not even reach. So the ring
// formula lives here, the mesh builder uses it, and the fitting queries below
// are answered from the same numbers.
//
// Local frame (as built, before the front cap is rotated by π):
//   x  across, 0 at centre     y  0 at body bottom, up to bodyH
//   z  0 at the body join, +length at the nose tip
//
// Pure — no THREE, no DOM, so it is testable headlessly.

export const CAB_RING_COUNT = 9;
export const CAB_RING_SEGMENTS = 16;

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const lerp = (from, to, t) => from + (to - from) * t;

// The ring at sweep parameter t (0 = body join, 1 = last ring before the tip).
export function cabRing(bodyW, bodyH, length, t) {
    const eased = t * t * (3 - 2 * t);
    return {
        halfW: lerp(bodyW / 2, 0.74, eased),
        bottom: lerp(0, 0.22, eased),
        top: lerp(bodyH, bodyH * 0.82, eased),
    };
}

// One vertex of that ring. `angle` runs 0..2π around the ring, 0 = +x side,
// π/2 = top, 3π/2 = bottom. The z term is what gives the nose its rake: the
// upper half is pulled back (upperTurn) and the flanks are drawn in (sideRound).
export function cabRingPoint(bodyW, bodyH, length, t, angle) {
    const { halfW, bottom, top } = cabRing(bodyW, bodyH, length, t);
    const halfH = (top - bottom) / 2;
    const centerY = (top + bottom) / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const x = halfW * Math.sign(cos) * Math.abs(cos) ** 0.42;
    const y = centerY + halfH * Math.sign(sin) * Math.abs(sin) ** 0.42;
    const yNorm = clamp01((y - bottom) / Math.max(0.01, top - bottom));
    const upperTurn = clamp01((yNorm - 0.52) / 0.48) ** 1.7;
    const sideRound = 1 - 0.12 * (x / halfW) ** 2;
    return {
        x,
        y,
        z: length * (1 - Math.cos(t * Math.PI / 2)) * (1 - 0.38 * upperTurn) * sideRound,
    };
}

// The tip vertex the cap triangles converge on.
export function cabTipPoint(bodyW, bodyH, length) {
    return { x: 0, y: lerp(0.22, bodyH * 0.82, 0.42), z: length };
}

// The nose silhouette in the x = 0 plane, bottom to top: the bottom sweep edge,
// then the two cap edges through the tip, then the top sweep edge back down.
// Returned as a y-ascending polyline of {y, z} so a mount point can be looked up
// by height.
export function cabCenterProfile(bodyW, bodyH, length) {
    const bottomEdge = [];
    const topEdge = [];
    for (let ring = 0; ring < CAB_RING_COUNT; ring++) {
        const t = ring / (CAB_RING_COUNT - 1);
        const low = cabRingPoint(bodyW, bodyH, length, t, -Math.PI / 2);
        const high = cabRingPoint(bodyW, bodyH, length, t, Math.PI / 2);
        bottomEdge.push({ y: low.y, z: low.z });
        topEdge.push({ y: high.y, z: high.z });
    }
    const tip = cabTipPoint(bodyW, bodyH, length);
    // bottom edge runs y 0 -> 0.22 (ascending); the cap then climbs past the tip
    // to the last ring's top; the top edge descends from bodyH, so reverse it.
    return [
        ...bottomEdge,
        { y: tip.y, z: tip.z },
        ...topEdge.slice().reverse(),
    ];
}

// Where the nose surface is at a given height, on the centre plane, plus how
// far it is raked back there. `rakeRad` is the angle from vertical: 0 is a flat
// vertical face, positive leans back as it rises — which is what a plate mounted
// flush has to be rotated by. Returns null above or below the shell.
export function cabFrontAt(profile, y) {
    if (!Array.isArray(profile) || profile.length < 2) return null;
    for (let i = 0; i + 1 < profile.length; i++) {
        const a = profile[i];
        const b = profile[i + 1];
        const low = Math.min(a.y, b.y);
        const high = Math.max(a.y, b.y);
        if (y < low || y > high) continue;
        const span = b.y - a.y;
        const t = Math.abs(span) < 1e-9 ? 0 : (y - a.y) / span;
        const z = a.z + (b.z - a.z) * t;
        // dz/dy along this segment; a surface receding as y rises has dz < 0.
        const rakeRad = Math.abs(span) < 1e-9
            ? 0
            : Math.atan2(-(b.z - a.z), span);
        return { z, rakeRad };
    }
    return null;
}

// ─── Mount points for the parts that hang on the nose ──────────────────────
// These live here, next to the shape, so the numbers the mesh is fitted with are
// the numbers a test can check. Both return cab-LOCAL coordinates; tram.js maps
// them into group space.

// Light cluster: a housing standing on the plumb band with the lamps flush on
// its face. Gluing lamps straight to the shell here would mean gluing them to
// the raked part above the band, where they would tilt with it — a housing is
// what the real vehicle uses, and it keeps the lamps facing down the track.
export function cabLightMount(bodyW, bodyH, length) {
    const profile = cabCenterProfile(bodyW, bodyH, length);
    const band = cabVerticalFaceBand(profile);
    if (!band) return null;
    return {
        // Low in the band, where a tram's lights actually sit.
        y: band.y0 + (band.y1 - band.y0) * 0.34,
        faceZ: band.z,
        housingHalfW: 0.62,     // inside the 0.74 m nose half-width
        housingH: 0.30,
        housingD: 0.26,
        lampX: 0.40,
        lampW: 0.42,
        lampH: 0.17,
    };
}

// Line-number plate: a destination box high on the windscreen rake, lying flush
// — so it needs the surface's depth AND its tilt at that height.
export function cabLinePlateMount(bodyW, bodyH, length) {
    const profile = cabCenterProfile(bodyW, bodyH, length);
    const y = bodyH * 0.78;
    const front = cabFrontAt(profile, y);
    return front ? { y, z: front.z, rakeRad: front.rakeRad } : null;
}

// The vertical band of the nose — the stretch whose surface is within `tolM` of
// plumb. Real trams seat their light cluster exactly here, and on this shell it
// is the face below the windscreen rake. Returns {y0, y1, z} or null.
export function cabVerticalFaceBand(profile, tolM = 0.02) {
    let y0 = null;
    let y1 = null;
    let z = null;
    for (let i = 0; i + 1 < profile.length; i++) {
        const a = profile[i];
        const b = profile[i + 1];
        if (Math.abs(b.z - a.z) > tolM) continue;
        if (b.y <= a.y) continue;      // ascending segments only
        if (y0 == null || a.y < y0) y0 = a.y;
        if (y1 == null || b.y > y1) y1 = b.y;
        z = Math.max(z ?? -Infinity, a.z, b.z);
    }
    return y0 == null ? null : { y0, y1, z };
}
