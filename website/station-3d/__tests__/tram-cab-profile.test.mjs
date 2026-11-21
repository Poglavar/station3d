// The TMK nose profile, and the fitting queries that mount parts on it.
//
// The lights and the line-number plate were placed at a fixed -BODY_L/2 "tip
// plane" while the nose is a raked, swept cap. The plate ended up 0.89 m in
// front of the shell at a height the shell does not reach — visibly floating
// ahead of the tram. These tests pin that a fitted point lands ON the surface,
// and that the vertical band the light housing sits on really is vertical.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    CAB_RING_COUNT,
    CAB_RING_SEGMENTS,
    cabCenterProfile,
    cabFrontAt,
    cabLightMount,
    cabLinePlateMount,
    cabRing,
    cabRingPoint,
    cabTipPoint,
    cabVerticalFaceBand,
} from '../models/vehicles/tram-cab-profile.js';

// The real TMK 2400 numbers from tram.js.
const BODY_W = 2.4;
const BODY_H = 3.0 + 0.35;      // body + roof, what the cab cap is built to
const CAB_L = 2.35;

const profile = cabCenterProfile(BODY_W, BODY_H, CAB_L);
const tip = cabTipPoint(BODY_W, BODY_H, CAB_L);

test('the sweep runs from the body join to the tip', () => {
    const join = cabRing(BODY_W, BODY_H, CAB_L, 0);
    const last = cabRing(BODY_W, BODY_H, CAB_L, 1);
    assert.equal(join.halfW, BODY_W / 2, 'starts at full body width');
    assert.ok(last.halfW < join.halfW, 'and draws in toward the nose');
    assert.equal(cabRingPoint(BODY_W, BODY_H, CAB_L, 0, Math.PI / 2).z, 0, 'join is at z 0');
    assert.ok(Math.abs(tip.z - CAB_L) < 1e-9, 'tip is the full cab length forward');
});

test('the centre profile is a y-ascending silhouette spanning the whole nose', () => {
    for (let i = 1; i < profile.length; i++) {
        assert.ok(
            profile[i].y >= profile[i - 1].y - 1e-9,
            `profile must ascend in y (broke at ${i}: ${profile[i - 1].y} -> ${profile[i].y})`,
        );
    }
    assert.ok(Math.abs(profile[0].y) < 1e-9, 'starts at the body bottom');
    assert.ok(Math.abs(profile[profile.length - 1].y - BODY_H) < 1e-9, 'ends at the roof line');
    assert.ok(profile.some(p => Math.abs(p.z - CAB_L) < 1e-9), 'includes the tip');
});

test('a fitted mount point lies ON the surface, not ahead of it', () => {
    // The regression: the plate was mounted at z = CAB_L (the tip plane) for a
    // height of 0.92 * BODY body height. Nothing is that far forward up there.
    const plateY = BODY_H * 0.78;
    const mount = cabFrontAt(profile, plateY);
    assert.ok(mount, 'the shell exists at the plate height');
    assert.ok(mount.z < CAB_L, 'and its surface is BEHIND the tip plane');
    assert.ok(mount.z > 0, 'but still forward of the body join');
    // Quantifies the old bug: mounting at the tip plane floated it this far out.
    assert.ok(CAB_L - mount.z > 0.5, `old placement floated ${(CAB_L - mount.z).toFixed(2)} m`);
});

test('every fitted point matches the mesh the builder produces', () => {
    // Fit a run of heights and check each against the nose silhouette rebuilt
    // straight from the ring formula — if the two ever disagree, a part mounted
    // by cabFrontAt would sink into or hover off the shell it is glued to.
    const silhouette = [];
    for (let ring = 0; ring < CAB_RING_COUNT; ring++) {
        const t = ring / (CAB_RING_COUNT - 1);
        silhouette.push(cabRingPoint(BODY_W, BODY_H, CAB_L, t, Math.PI / 2));
        silhouette.push(cabRingPoint(BODY_W, BODY_H, CAB_L, t, -Math.PI / 2));
    }
    silhouette.push(tip);
    for (const vertex of silhouette) {
        const mount = cabFrontAt(profile, vertex.y);
        assert.ok(mount, `no surface at y=${vertex.y}`);
        // The profile passes through every silhouette vertex, so at a vertex
        // height the fit must reproduce a z the mesh actually has there.
        const candidates = silhouette
            .filter(other => Math.abs(other.y - vertex.y) < 1e-6)
            .map(other => other.z);
        assert.ok(
            candidates.some(z => Math.abs(z - mount.z) < 1e-6),
            `fit z=${mount.z} is not a mesh z at y=${vertex.y} (mesh has ${candidates})`,
        );
    }
});

test('the light band is genuinely vertical, which is why lights mount there', () => {
    const band = cabVerticalFaceBand(profile);
    assert.ok(band, 'the nose has a plumb face');
    assert.ok(band.y1 > band.y0, 'spanning a real height');
    assert.ok(band.y1 - band.y0 > 0.5, `tall enough for a light cluster (${band.y1 - band.y0} m)`);
    // Vertical means the surface z does not move across the band.
    const low = cabFrontAt(profile, band.y0 + 0.01);
    const high = cabFrontAt(profile, band.y1 - 0.01);
    assert.ok(Math.abs(low.z - high.z) < 0.02, 'z is constant across the band');
    assert.ok(Math.abs(low.rakeRad) < 0.05, 'and its rake is ~0 (plumb)');
});

test('the windscreen rake leans back, and a plate mounted on it leans with it', () => {
    const band = cabVerticalFaceBand(profile);
    const onRake = cabFrontAt(profile, band.y1 + 0.4);
    assert.ok(onRake, 'there is shell above the vertical band');
    // Positive rake = recedes as it rises, which is the tilt the plate takes.
    assert.ok(onRake.rakeRad > 0.2, `raked back (${onRake.rakeRad.toFixed(2)} rad)`);
    assert.ok(onRake.rakeRad < Math.PI / 2, 'but not past horizontal');
    // Higher on the rake is further back.
    const higher = cabFrontAt(profile, band.y1 + 0.9);
    assert.ok(higher.z < onRake.z, 'the surface recedes with height');
});

test('nothing is fitted outside the shell', () => {
    assert.equal(cabFrontAt(profile, -0.5), null, 'below the body bottom');
    assert.equal(cabFrontAt(profile, BODY_H + 0.5), null, 'above the roof line');
    assert.equal(cabFrontAt([], 1), null, 'no profile at all');
    assert.equal(cabFrontAt(null, 1), null);
});

test('the ring count and segment count are the ones the mesh is indexed for', () => {
    // tram.js builds its triangle indices from these; a mismatch would tear the
    // cap open, so they are shared rather than repeated.
    assert.equal(CAB_RING_COUNT, 9);
    assert.equal(CAB_RING_SEGMENTS, 16);
});

// ─── The mount points tram.js actually builds with ─────────────────────────
// The tests above prove the fitting maths; these prove the numbers the vehicle
// is assembled from are on the shell. Without them the maths could be perfect
// and the parts still mounted somewhere silly.

test('the light housing sits on the plumb band, inside the nose width', () => {
    const mount = cabLightMount(BODY_W, BODY_H, CAB_L);
    const band = cabVerticalFaceBand(profile);
    assert.ok(mount, 'there is a mount');
    assert.ok(mount.y > band.y0 && mount.y < band.y1, 'height is inside the plumb band');
    assert.ok(Math.abs(mount.faceZ - band.z) < 1e-9, 'face is the band surface');
    // The nose is only 0.74 m half-width at the tip; a wider housing or a lamp
    // pair placed further out overhangs the bodyside (the old lights did: they
    // sat at x 0.55 with a 0.5 m width, reaching 0.80).
    const NOSE_HALF_W = 0.74;
    assert.ok(mount.housingHalfW < NOSE_HALF_W, 'housing fits the nose');
    assert.ok(
        mount.lampX + mount.lampW / 2 < NOSE_HALF_W,
        `lamp outer edge ${(mount.lampX + mount.lampW / 2).toFixed(2)} must clear ${NOSE_HALF_W}`,
    );
    // Housing is deep enough that its back is buried behind the face.
    assert.ok(mount.housingD > 0.1, 'housing has real depth to seat into the shell');
    // The lamps must clear the housing they are bolted to, in height.
    assert.ok(mount.lampH < mount.housingH, 'lamp fits on the housing face');
});

test('the line plate is on the shell and tilted to it', () => {
    const mount = cabLinePlateMount(BODY_W, BODY_H, CAB_L);
    assert.ok(mount, 'there is a mount');
    // Not the tip plane — that is the bug this replaced.
    assert.ok(mount.z < CAB_L - 0.3, `plate is ${(CAB_L - mount.z).toFixed(2)} m behind the tip`);
    assert.ok(mount.z > 0, 'and forward of the body join');
    // On the rake, so it must lean; a plate left vertical would cut into the shell.
    assert.ok(mount.rakeRad > 0.2, `leans back with the surface (${mount.rakeRad.toFixed(2)} rad)`);
    // High on the nose, where a destination box belongs — above the light band.
    const band = cabVerticalFaceBand(profile);
    assert.ok(mount.y > band.y1, 'above the light band');
    assert.ok(mount.y < BODY_H, 'below the roof line');
    // And the height/depth pair really is a point on the silhouette.
    const surface = cabFrontAt(profile, mount.y);
    assert.ok(Math.abs(surface.z - mount.z) < 1e-9, 'depth is the surface depth');
});
