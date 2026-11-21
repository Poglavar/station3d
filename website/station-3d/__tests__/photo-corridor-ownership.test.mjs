// Verifies exact tunnel portal mouths, intact cores, mask heights, and clipping.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildCutFlankMaskQuads,
    buildPortalCollarMaskQuads,
    buildPortalHoodMaskQuads,
    buildTunnelCoreMaskQuads,
    derivePhotoCorridorOwnership,
    photoCutFlankOwnershipAt,
    photoPortalFacadeFrame,
    photoPortalSourceOwnershipAt,
    PHOTO_CORRIDOR_HALF_WIDTH_M,
    PHOTO_CORRIDOR_MASK_TEXEL_M,
    PHOTO_TUNNEL_PORTAL_CROWN_M,
    PHOTO_TUNNEL_PORTAL_MAX_HEIGHT_M,
    resolvePhotoCutFlankBand,
    resolvePhotoCutPlanContract,
    resolvePhotoPortalPlanContract,
    resolvePhotoPortalCivilEnvelope,
    resolvePhotoPortalCollarRoof,
    resolvePhotoPortalHoodRoof,
    shouldDiscardPhotoSourceFragment,
} from '../core/photo-corridor-ownership.js';

const PORTAL_PLAN = resolvePhotoPortalPlanContract({
    maskTexelM: PHOTO_CORRIDOR_MASK_TEXEL_M,
    corridorHalfWidthM: PHOTO_CORRIDOR_HALF_WIDTH_M,
    tunnelRoofHalfWidthM: 7,
});

function chunk(x0, x1, structure, routeRunId = 'route') {
    return {
        routeRunId,
        structure,
        x0,
        z0: 0,
        ty0: x0 * 0.01,
        x1,
        z1: 0,
        ty1: x1 * 0.01,
        mx: (x0 + x1) * 0.5,
        mz: 0,
        ty: (x0 + x1) * 0.005,
        spanLen: x1 - x0,
        groundL: 0,
        groundR: 0,
        groundC: 0,
    };
}

test('portal faces sit at the first and last qualifying terrain samples', () => {
    const chunks = [chunk(-12, 0, 'formation')];
    for (let x = 0; x < 120; x += 12) chunks.push(chunk(x, x + 12, 'tunnel'));
    chunks.push(chunk(120, 132, 'formation'));
    const ownership = derivePhotoCorridorOwnership(chunks);
    const core = ownership.slices.filter(slice => slice.sourceMode === 'tunnel-core');
    const open = ownership.slices.filter(slice => slice.sourceMode === 'open');
    assert.equal(core[0].x0, 6);
    assert.equal(core[core.length - 1].x1, 114);
    assert.equal(open.reduce((sum, slice) => sum + slice.spanLen, 0), 12);
    assert.deepEqual(ownership.portalFaces.map(face => face.x), [6, 114]);
    assert.deepEqual(
        ownership.portalCollars.map(collar => [collar.side, collar.x0, collar.x1]),
        [['start', 4, 8], ['end', 116, 112]],
        'full-headwall collars straddle the face inside the opaque facade',
    );
    assert.deepEqual(
        ownership.portalHoods.map(hood => [hood.side, hood.x0, hood.x1]),
        [['start', 8, 18], ['end', 112, 102]],
        'narrow bore hoods begin behind the collars and project ten metres inward',
    );
});

test('portal boundary splits a coarse chunk at the exact metre', () => {
    const chunks = [
        chunk(-20, 0, 'formation'),
        chunk(0, 30, 'tunnel'),
        chunk(30, 70, 'tunnel'),
        chunk(70, 100, 'tunnel'),
        chunk(100, 120, 'formation'),
    ];
    const ownership = derivePhotoCorridorOwnership(chunks);
    assert.ok(ownership.slices.some(slice => slice.x0 === 0 && slice.x1 === 15 && slice.sourceMode === 'open'));
    assert.ok(ownership.slices.some(slice => slice.x0 === 15 && slice.x1 === 30 && slice.sourceMode === 'tunnel-core'));
    assert.deepEqual(ownership.portalFaces.map(face => face.x), [15, 85]);
});

test('minimum tunnel run keeps only half of each sampled end chunk open', () => {
    const ownership = derivePhotoCorridorOwnership([
        chunk(-10, 0, 'formation'),
        chunk(0, 15, 'tunnel'),
        chunk(15, 30, 'tunnel'),
        chunk(30, 45, 'tunnel'),
        chunk(45, 55, 'formation'),
    ]);
    const core = ownership.slices.filter(slice => slice.sourceMode === 'tunnel-core');
    const open = ownership.slices.filter(slice => slice.sourceMode === 'open');
    assert.equal(core[0].x0, 7.5);
    assert.equal(core[core.length - 1].x1, 37.5);
    assert.equal(open.reduce((sum, slice) => sum + slice.spanLen, 0), 15);
    assert.deepEqual(ownership.portalFaces.map(face => face.x), [7.5, 37.5]);
});

test('route-run discontinuity cannot merge tunnel ownership', () => {
    const ownership = derivePhotoCorridorOwnership([
        chunk(-12, 0, 'formation', 'a'),
        chunk(0, 30, 'tunnel', 'a'),
        chunk(30, 60, 'tunnel', 'b'),
        chunk(60, 72, 'formation', 'b'),
    ]);
    assert.ok(ownership.slices.every(slice => !(slice.x0 < 30 && slice.x1 > 30)));
    assert.deepEqual(ownership.portalFaces.map(face => face.x), [15, 45]);
});

test('an unloaded formation neighbour cannot invent a portal mouth', () => {
    const before = chunk(-12, 0, 'formation');
    before.groundL = null;
    before.groundR = null;
    before.groundC = null;
    const ownership = derivePhotoCorridorOwnership([
        before,
        chunk(0, 60, 'tunnel'),
        chunk(60, 72, 'formation'),
    ]);
    assert.equal(ownership.slices[0].sourceMode, 'tunnel-core');
    assert.deepEqual(ownership.portalFaces.map(face => face.x), [30]);
});

test('covered station neighbours do not invent underground terrain portals', () => {
    for (const stationStructure of ['station-covered', 'station-underground']) {
        const ownership = derivePhotoCorridorOwnership([
            chunk(-12, 0, stationStructure),
            chunk(0, 60, 'tunnel'),
            chunk(60, 72, 'formation'),
        ]);
        assert.deepEqual(
            ownership.portalFaces.map(face => [face.side, face.x]),
            [['end', 30]],
            'only the real tunnel-to-surface end owns a portal',
        );
        assert.ok(ownership.slices.some(slice => (
            slice.x0 === 0 && slice.sourceMode === 'tunnel-core'
        )), 'the running tube reaches the covered station without a false open mouth');
    }
});

test('start portal at a bend uses the first intact-core tangent', () => {
    const ownership = derivePhotoCorridorOwnership([
        { ...chunk(-12, 0, 'formation'), z0: -12, z1: 0 },
        chunk(0, 24, 'tunnel'),
        {
            ...chunk(24, 48, 'tunnel'),
            x0: 24,
            z0: 0,
            x1: 24,
            z1: -24,
            spanLen: 24,
        },
        {
            ...chunk(48, 72, 'tunnel'),
            x0: 24,
            z0: -24,
            x1: 24,
            z1: -48,
            spanLen: 24,
        },
        {
            ...chunk(72, 84, 'formation'),
            x0: 24,
            z0: -48,
            x1: 24,
            z1: -60,
            spanLen: 12,
        },
    ], { portalCarveM: 24 });
    const start = ownership.portalFaces.find(face => face.side === 'start');
    assert.equal(start.ux, 0);
    assert.equal(start.uz, -1);
    const collar = ownership.portalCollars.find(portal => portal.side === 'start');
    const facade = photoPortalFacadeFrame(start);
    assert.equal(collar.ux, facade.ux,
        'the outward collar follows the same core-side tangent as its masonry');
    assert.equal(collar.uz, facade.uz);
    assert.ok(Math.abs(facade.ux * facade.pz - facade.uz * facade.px - 1) < 1e-9,
        'a bent portal still emits a right-handed facade basis');
});

test('tunnel mask preserves encoded track height at both slice ends', () => {
    const ownership = derivePhotoCorridorOwnership([
        chunk(-12, 0, 'formation'),
        chunk(0, 120, 'tunnel'),
        chunk(120, 132, 'formation'),
    ], { portalCarveM: 6 });
    const mask = buildTunnelCoreMaskQuads(ownership.slices, {
        halfWidthM: 13,
        encodeFloor: value => value / 10,
    });
    assert.equal(mask.positions.length, 18);
    const blue = mask.colors.filter((_, index) => index % 3 === 2);
    assert.ok(blue.some(value => Math.abs(value - 0.006) < 1e-9));
    assert.ok(blue.some(value => Math.abs(value - 0.114) < 1e-9));
});

test('portal mask composes a bore-style facade collar and tapered bore hood', () => {
    const ownership = derivePhotoCorridorOwnership([
        chunk(-12, 0, 'formation'),
        chunk(0, 120, 'tunnel'),
        chunk(120, 132, 'formation'),
    ], { portalCarveM: 6 });
    const resolvedHoods = ownership.portalHoods.map(hood => resolvePhotoPortalHoodRoof(
        hood,
        { faceRoofY: hood.faceTrackY + 10 },
    ));
    const resolvedCollars = ownership.portalCollars.map((collar, index) => (
        resolvePhotoPortalCollarRoof(collar, {
            portalTopY: resolvedHoods[index].roofY0,
        })
    ));
    const collars = buildPortalCollarMaskQuads(resolvedCollars, {
        halfWidthM: PORTAL_PLAN.collarHalfWidthM,
        encodeFloor: value => value / 10,
    });
    assert.equal(collars.positions.length, 2 * 6 * 3);
    assert.ok(collars.colors.every((value, index) => index % 3 !== 1 || value === 1),
        'the facade collar is core/roof ownership — a red sky column would tear the hill above the crown');
    const collarBlue = collars.colors.filter((_, index) => index % 3 === 2);
    for (const expected of [0.004, 0.008, 0.116, 0.112]) {
        assert.ok(collarBlue.some(value => Math.abs(value - expected) < 1e-9));
    }
    const hoods = buildPortalHoodMaskQuads(resolvedHoods, {
        halfWidthM: PORTAL_PLAN.hoodHalfWidthM,
        encodeFloor: value => value / 10,
    });
    assert.equal(hoods.positions.length, 2 * 6 * 3);
    assert.ok(hoods.colors.every((value, index) => index % 3 !== 1 || value === 1));
    const hoodBlue = hoods.colors.filter((_, index) => index % 3 === 2);
    for (const expected of [0.263, 0.018, 0.367, 0.102]) {
        assert.ok(hoodBlue.some(value => Math.abs(value - expected) < 1e-9));
    }

    assert.deepEqual(photoPortalFacadeFrame(ownership.portalFaces[0]), {
        centerX: 6,
        centerZ: 0,
        depthM: PORTAL_PLAN.facadeInwardDepthM + PORTAL_PLAN.facadeOutwardDepthM,
        inwardDepthM: PORTAL_PLAN.facadeInwardDepthM,
        outwardDepthM: PORTAL_PLAN.facadeOutwardDepthM,
        ux: 1,
        uz: 0,
        px: 0,
        pz: 1,
    }, 'the facade straddles the exact face with a full-texel apron');
    assert.deepEqual(photoPortalFacadeFrame(ownership.portalFaces[1]), {
        centerX: 114,
        centerZ: 0,
        depthM: PORTAL_PLAN.facadeInwardDepthM + PORTAL_PLAN.facadeOutwardDepthM,
        inwardDepthM: PORTAL_PLAN.facadeInwardDepthM,
        outwardDepthM: PORTAL_PLAN.facadeOutwardDepthM,
        ux: -1,
        uz: 0,
        px: 0,
        pz: -1,
    }, 'the reverse facade uses the same two-sided contract');
});

test('both oblique portals bury their two-sided mask collars inside right-handed masonry', () => {
    const diagonal = (station0, station1, structure) => {
        const scale = Math.SQRT1_2;
        return {
            ...chunk(station0, station1, structure),
            x0: station0 * scale,
            z0: station0 * scale,
            x1: station1 * scale,
            z1: station1 * scale,
            mx: (station0 + station1) * 0.5 * scale,
            mz: (station0 + station1) * 0.5 * scale,
            spanLen: station1 - station0,
        };
    };
    const ownership = derivePhotoCorridorOwnership([
        diagonal(-12, 0, 'formation'),
        diagonal(0, 120, 'tunnel'),
        diagonal(120, 132, 'formation'),
    ], { portalCarveM: 6 });
    assert.equal(PORTAL_PLAN.maskTexelM, 1, 'production mask remains one metre per texel');
    assert.ok(
        Math.abs(
            PORTAL_PLAN.facadeHalfWidthM
                - PORTAL_PLAN.collarHalfWidthM
                - PORTAL_PLAN.opaqueApronM
        ) < 1e-12,
        'opaque masonry owns one complete pixel diagonal beyond source removal',
    );
    assert.ok(
        PORTAL_PLAN.opaqueApronM >= PHOTO_CORRIDOR_MASK_TEXEL_M * Math.SQRT2,
        'the apron contains a complete mask-pixel diagonal at any route angle',
    );

    for (const face of ownership.portalFaces) {
        const collar = ownership.portalCollars.find(portal => portal.side === face.side);
        const facade = photoPortalFacadeFrame(face, {
            depthM: PORTAL_PLAN.facadeInwardDepthM,
            outwardDepthM: PORTAL_PLAN.facadeOutwardDepthM,
        });
        const along = (x, z) => (
            (x - face.x) * facade.ux + (z - face.z) * facade.uz
        );

        assert.ok(Math.abs(along(collar.x0, collar.z0) + 2) < 1e-9,
            `${face.side} source removal reaches two texels onto the approach`);
        assert.ok(Math.abs(along(collar.x1, collar.z1) - 2) < 1e-9,
            `${face.side} source removal reaches two texels into the hill`);
        assert.ok(Math.abs(along(facade.centerX, facade.centerZ)) < 1e-9);
        assert.ok(Math.abs(
            facade.inwardDepthM - collar.inwardDepthM - PORTAL_PLAN.opaqueApronM
        ) < 1e-12);
        assert.ok(Math.abs(
            facade.outwardDepthM - collar.outwardDepthM - PORTAL_PLAN.opaqueApronM
        ) < 1e-12);
        assert.ok(Math.abs(
            facade.ux * facade.pz - facade.uz * facade.px - 1
        ) < 1e-9, `${face.side} facade basis remains right-handed for FrontSide culling`);

        for (const lateralSign of [-1, 1]) {
            // Just inside the collar's lateral edge, whatever the contract width.
            const nearCollarEdgeM = PORTAL_PLAN.collarHalfWidthM - 0.75;
            const approachPoint = {
                x: face.x - facade.ux * 1.5
                    + facade.px * lateralSign * nearCollarEdgeM,
                z: face.z - facade.uz * 1.5
                    + facade.pz * lateralSign * nearCollarEdgeM,
            };
            const owner = photoPortalSourceOwnershipAt(
                ownership.portalCollars,
                ownership.portalHoods,
                approachPoint.x,
                approachPoint.z,
                {
                    collarHalfWidthM: PORTAL_PLAN.collarHalfWidthM,
                    hoodHalfWidthM: PORTAL_PLAN.hoodHalfWidthM,
                },
            );
            assert.equal(owner?.sourceMode, 'portal-collar',
                `${face.side} angled approach flank ${lateralSign} is source-cleared`);
            assert.equal(owner?.mode, 'tunnel-core');
            assert.equal(shouldDiscardPhotoSourceFragment({
                insideCorridor: true,
                tunnelCore: true,
                worldY: owner.floorY + 2,
                trackY: owner.floorY,
            }), true, 'oblique source triangles in the aperture still die');
            assert.equal(shouldDiscardPhotoSourceFragment({
                insideCorridor: true,
                tunnelCore: true,
                worldY: owner.floorY + 40,
                trackY: owner.floorY,
            }), false,
                'the hillside above the crown stays real — the sky column here is what shredded it');
        }

        const beyondApproachApron = {
            x: face.x - facade.ux * (collar.outwardDepthM + 0.01),
            z: face.z - facade.uz * (collar.outwardDepthM + 0.01),
        };
        assert.equal(photoPortalSourceOwnershipAt(
            ownership.portalCollars,
            ownership.portalHoods,
            beyondApproachApron.x,
            beyondApproachApron.z,
            {
                collarHalfWidthM: PORTAL_PLAN.collarHalfWidthM,
                hoodHalfWidthM: PORTAL_PLAN.hoodHalfWidthM,
            },
        ), null, `${face.side} collar stays bounded outside the opaque facade`);
    }
});

test('open-cut wall contains the filtered route mask at every angle', () => {
    const plan = resolvePhotoCutPlanContract({
        maskTexelM: PHOTO_CORRIDOR_MASK_TEXEL_M,
        corridorHalfWidthM: PHOTO_CORRIDOR_HALF_WIDTH_M,
        wallThicknessM: 3,
        sourceSampleApronM: 0.75,
    });
    const half = PHOTO_CORRIDOR_HALF_WIDTH_M;
    assert.equal(plan.sourceRemovalHalfWidthM, half);
    assert.equal(plan.opaqueApronM, Math.SQRT2);
    assert.equal(plan.wallOuterDistanceM, half + Math.SQRT2);
    assert.equal(plan.wallCenterDistanceM, (half + Math.SQRT2) - 1.5);
    assert.equal(plan.wallInnerDistanceM, ((half + Math.SQRT2) - 1.5) - 1.5);
    assert.equal(plan.sourceSampleDistanceM, half + 0.75 + Math.SQRT2);
    assert.equal(plan.floorHalfWidthM, plan.wallOuterDistanceM);
    assert.ok(
        plan.wallOuterDistanceM - plan.sourceRemovalHalfWidthM
            >= plan.maskTexelM * Math.SQRT2,
        'the former half-metre wall apron cannot return at a diagonal mask edge',
    );
});

test('portal civil envelope follows robust local ground within a rail-relative cap', () => {
    const ownership = derivePhotoCorridorOwnership([
        chunk(-12, 0, 'formation'),
        chunk(0, 120, 'tunnel'),
        chunk(120, 132, 'formation'),
    ], { portalCarveM: 6 });
    for (let index = 0; index < ownership.portalFaces.length; index++) {
        const face = ownership.portalFaces[index];
        const collar = ownership.portalCollars[index];
        const envelope = resolvePhotoPortalCivilEnvelope(
            collar,
            ownership.portalHoods[index],
        );
        const expected = Math.max(collar.ty0, collar.ty1)
            + 7.45 + PHOTO_TUNNEL_PORTAL_CROWN_M;
        assert.ok(Math.abs(envelope.portalTopY - expected) < 1e-9);
        assert.ok(envelope.portalTopY - face.trackY < 10,
            'the minimum visible headwall stays compact without retained-ground evidence');
        assert.equal(envelope.collar.roofY0, envelope.portalTopY);
        assert.equal(envelope.hood.roofY0, envelope.portalTopY);

        const retained = resolvePhotoPortalCivilEnvelope(
            collar,
            ownership.portalHoods[index],
            { retainedTopY: face.trackY + 12 },
        );
        assert.equal(retained.portalTopY, face.trackY + 12,
            'robust local retained ground can give the entrance a visible headwall');
        assert.equal(retained.collar.roofY0, retained.portalTopY,
            'opaque facade metadata reaches the retained-ground crest');
        assert.ok(retained.hood.roofY0 < retained.portalTopY,
            'the bore hood stays bounded instead of encoding facade height');
        assert.equal(retained.collar.maskTy0, collar.ty0,
            'full-removal collar keeps track-floor payload at a tall facade');

        const capped = resolvePhotoPortalCivilEnvelope(
            collar,
            ownership.portalHoods[index],
            { retainedTopY: face.trackY + 100 },
        );
        const localTrackY = Math.max(collar.ty0, collar.ty1, face.trackY);
        assert.equal(capped.portalTopY, localTrackY + PHOTO_TUNNEL_PORTAL_MAX_HEIGHT_M,
            'even sustained local evidence cannot recreate a terrain-height facade');
    }
});

test('portal hood wins over its collar only in the bore and tapers to normal core roof', () => {
    const ownership = derivePhotoCorridorOwnership([
        chunk(-12, 0, 'formation'),
        chunk(0, 120, 'tunnel'),
        chunk(120, 132, 'formation'),
    ], { portalCarveM: 6 });
    const resolvedHoods = ownership.portalHoods.map(hood => resolvePhotoPortalHoodRoof(
        hood,
        { faceRoofY: hood.faceTrackY + 10 },
    ));
    const resolvedCollars = ownership.portalCollars.map((collar, index) => (
        resolvePhotoPortalCollarRoof(collar, {
            portalTopY: resolvedHoods[index].roofY0,
        })
    ));
    const options = {
        collarHalfWidthM: PORTAL_PLAN.collarHalfWidthM,
        hoodHalfWidthM: PORTAL_PLAN.hoodHalfWidthM,
    };
    const facadeAperture = photoPortalSourceOwnershipAt(
        resolvedCollars,
        resolvedHoods,
        6.2,
        0,
        options,
    );
    assert.equal(facadeAperture.sourceMode, 'portal-collar');
    assert.equal(facadeAperture.mode, 'tunnel-core');
    assert.ok(Math.abs(facadeAperture.floorY - 0.062) < 1e-9);
    assert.ok(Math.abs(facadeAperture.roofY - (0.062 + 7.45)) < 1e-9,
        'the collar clears the mouth only up to the shared source-roof offset');

    const centralHood = photoPortalSourceOwnershipAt(
        resolvedCollars,
        resolvedHoods,
        8.2,
        0,
        options,
    );
    assert.equal(centralHood.sourceMode, 'portal-hood');
    assert.ok(Math.abs(centralHood.roofY - 10.031) < 1e-9);

    const facadeFlank = photoPortalSourceOwnershipAt(
        resolvedCollars,
        resolvedHoods,
        6.2,
        PORTAL_PLAN.collarHalfWidthM - 1,
        options,
    );
    assert.equal(facadeFlank.sourceMode, 'portal-collar');
    assert.equal(facadeFlank.mode, 'tunnel-core');
    assert.ok(Math.abs(facadeFlank.floorY - 0.062) < 1e-9);

    const hoodEnd = photoPortalSourceOwnershipAt(
        resolvedCollars,
        resolvedHoods,
        18,
        0,
        options,
    );
    assert.equal(hoodEnd.sourceMode, 'portal-hood');
    assert.ok(Math.abs(hoodEnd.roofY - 7.63) < 1e-9);

    const boundedHood = resolvePhotoPortalHoodRoof(ownership.portalHoods[0], {
        faceRoofY: 50,
        maxFaceRoofY: 11,
    });
    assert.equal(boundedHood.roofY0, 11);
    assert.equal(boundedHood.maskTy0, 3.55);

    const reverseHood = photoPortalSourceOwnershipAt(
        resolvedCollars,
        resolvedHoods,
        108,
        0,
        options,
    );
    assert.equal(reverseHood.sourceMode, 'portal-hood');
    assert.ok(reverseHood.roofY > 9 && reverseHood.roofY < 11);

    assert.equal(photoPortalSourceOwnershipAt(
        resolvedCollars,
        resolvedHoods,
        18.01,
        0,
        options,
    ), null, 'ordinary green core resumes immediately beyond the hood');
    assert.equal(photoPortalSourceOwnershipAt(
        resolvedCollars,
        resolvedHoods,
        6.2,
        6.75,
        options,
    )?.sourceMode, 'portal-collar', 'the narrow hood never opens the headwall flank');

    assert.equal(shouldDiscardPhotoSourceFragment({
        insideCorridor: true,
        tunnelCore: true,
        worldY: centralHood.roofY - 0.01,
        trackY: centralHood.trackY,
    }), true, 'a core-side crown shard below the tapered hood is removed');
    assert.equal(shouldDiscardPhotoSourceFragment({
        insideCorridor: true,
        tunnelCore: true,
        worldY: centralHood.roofY + 0.01,
        trackY: centralHood.trackY,
    }), false, 'real hill above the bounded hood remains visible');

    assert.equal(shouldDiscardPhotoSourceFragment({
        insideCorridor: true,
        tunnelCore: true,
        worldY: facadeFlank.floorY + 40,
        trackY: facadeFlank.floorY,
    }), false,
        'high crust over the headwall flank survives: the facade buries only the roof-to-crown band');

    for (let index = 0; index < resolvedCollars.length; index++) {
        const collar = resolvedCollars[index];
        const hood = resolvedHoods[index];
        assert.ok(collar.roofY0 >= hood.roofY0,
            'the retained-ground facade may rise above the bounded bore hood');
        assert.equal(collar.roofY1, collar.roofY0,
            'the opaque facade top remains horizontal');
        assert.equal(collar.maskTy0, collar.ty0,
            'the red collar payload remains the real track floor');
        assert.equal(collar.maskTy1, collar.ty1,
            'the collar never encodes facade height in the track channel');
    }
});

test('tunnel mask fills only internal bend joins and keeps portal ends flat', () => {
    const slices = [
        {
            routeRunId: 'r', sourceMode: 'tunnel-core',
            x0: 0, z0: 0, ty0: 0, x1: 30, z1: 0, ty1: 1,
            px: 0, pz: 1,
        },
        {
            routeRunId: 'r', sourceMode: 'tunnel-core',
            x0: 30, z0: 0, ty0: 1, x1: 30, z1: -30, ty1: 2,
            px: 1, pz: 0,
        },
    ];
    const mask = buildTunnelCoreMaskQuads(slices, {
        halfWidthM: 12,
        encodeFloor: value => value / 10,
        joinSegments: 8,
    });
    assert.equal(mask.positions.length, (2 * 6 + 8 * 3) * 3);
    const xs = mask.positions.filter((_, index) => index % 3 === 0);
    const zs = mask.positions.filter((_, index) => index % 3 === 2);
    assert.equal(Math.min(...xs), 0, 'no round cap before the start portal');
    assert.equal(Math.max(...xs), 42, 'internal join fills the bend to corridor radius');
    assert.equal(Math.min(...zs), -30, 'no round cap beyond the end portal');
});

test('clip ownership removes open-cut cover and hollows only tunnel bore', () => {
    assert.equal(shouldDiscardPhotoSourceFragment({
        insideCorridor: false, worldY: 50, trackY: 0,
    }), false);
    assert.equal(shouldDiscardPhotoSourceFragment({
        insideCorridor: true, worldY: 2, trackY: 0,
    }), true);
    assert.equal(shouldDiscardPhotoSourceFragment({
        insideCorridor: true, worldY: -1, trackY: 0,
    }), false);
    assert.equal(shouldDiscardPhotoSourceFragment({
        insideCorridor: true, tunnelCore: true, worldY: 6, trackY: 0,
    }), true);
    assert.equal(shouldDiscardPhotoSourceFragment({
        insideCorridor: true, tunnelCore: true, worldY: 20, trackY: 0,
    }), false);
});

test('join discs near a portal face are clamped and never bulge over the open mouth', () => {
    // Adaptive carve = half of each 18 m end chunk, so the faces sit at 9 and
    // 93 — and the internal junctions at 18 and 84 are each only 9 m inside
    // their face. Unclamped 12 m join discs would paint keep-above-roof 3 m
    // out over BOTH open approaches — the exact mechanism of the floating
    // portal-sliver crust.
    const ownership = derivePhotoCorridorOwnership([
        chunk(-12, 0, 'formation'),
        chunk(0, 18, 'tunnel'),
        chunk(18, 84, 'tunnel'),
        chunk(84, 102, 'tunnel'),
        chunk(102, 114, 'formation'),
    ]);
    const core = ownership.slices.filter(slice => slice.sourceMode === 'tunnel-core');
    assert.equal(core[0].x0, 9, 'start face at half of the first end chunk');
    assert.equal(core[core.length - 1].x1, 93, 'end face at half of the last end chunk');
    const mask = buildTunnelCoreMaskQuads(ownership.slices, {
        halfWidthM: 12,
        encodeFloor: value => value / 10,
    });
    const xs = mask.positions.filter((_, index) => index % 3 === 0);
    assert.ok(Math.min(...xs) >= 9 - 1e-9,
        `core mask must not cross the start face: min x ${Math.min(...xs)}`);
    assert.ok(Math.max(...xs) <= 93 + 1e-9,
        `core mask must not cross the end face: max x ${Math.max(...xs)}`);
});

test('cut flank band exists only where the wall crown buries the roof seam', () => {
    const piece = {
        x0: 0, z0: 0, ty0: 1,
        x1: 12, z1: 0, ty1: 1.2,
        px: 0, pz: 1,
        routeRunId: 'route',
    };
    const options = {
        side: 1,
        innerM: 10.41,
        outerM: 13,
        tunnelRoofOffsetM: 7.45,
        minRoofBuryM: 1,
    };
    assert.equal(resolvePhotoCutFlankBand(piece, {
        ...options,
        wallTopY: 1.2 + 7.45 + 0.99,
    }), null, 'a crown that cannot bury the roof plane produces no band');
    assert.equal(resolvePhotoCutFlankBand(piece, {
        ...options, wallTopY: null,
    }), null, 'no wall, no band');
    const strip = resolvePhotoCutFlankBand(piece, {
        ...options,
        wallTopY: 1.2 + 7.45 + 1.01,
    });
    assert.equal(strip.sourceMode, 'cut-flank');
    assert.equal(strip.pz, 1, 'across vector carries the wall side sign');
    const mirrored = resolvePhotoCutFlankBand(piece, {
        ...options,
        side: -1,
        wallTopY: 1.2 + 7.45 + 1.01,
    });
    assert.equal(mirrored.pz, -1);
});

test('cut flank band quads and CPU ownership share core/roof semantics', () => {
    const strip = resolvePhotoCutFlankBand({
        x0: 0, z0: 0, ty0: 2,
        x1: 10, z1: 0, ty1: 3,
        px: 0, pz: 1,
    }, {
        side: 1,
        wallTopY: 3 + 7.45 + 2,
        innerM: 10,
        outerM: 13,
        tunnelRoofOffsetM: 7.45,
    });
    const mask = buildCutFlankMaskQuads([strip], {
        encodeFloor: value => value / 10,
    });
    assert.equal(mask.positions.length, 6 * 3);
    assert.ok(mask.colors.every((value, index) => index % 3 !== 0 || value === 1),
        'flank band writes full red coverage for the shader payload division');
    assert.ok(mask.colors.every((value, index) => index % 3 !== 1 || value === 1),
        'flank band is core/roof class: crust above the roof plane stays real');
    const blues = mask.colors.filter((_, index) => index % 3 === 2);
    assert.ok(blues.some(value => Math.abs(value - 0.2) < 1e-9));
    assert.ok(blues.some(value => Math.abs(value - 0.3) < 1e-9));
    const zs = mask.positions.filter((_, index) => index % 3 === 2);
    assert.equal(Math.min(...zs), 10, 'band starts at the wall inner face');
    assert.equal(Math.max(...zs), 13, 'band ends one texel past the removal edge');

    const inside = photoCutFlankOwnershipAt([strip], 5, 11.5, { tunnelRoofOffsetM: 7.45 });
    assert.equal(inside.mode, 'tunnel-core');
    assert.ok(Math.abs(inside.trackY - 2.5) < 1e-9, 'floor payload lerps along the strip');
    assert.ok(Math.abs(inside.roofY - (2.5 + 7.45)) < 1e-9);
    assert.equal(shouldDiscardPhotoSourceFragment({
        insideCorridor: true,
        tunnelCore: true,
        worldY: inside.roofY + 0.5,
        trackY: inside.trackY,
    }), false, 'canopy straddling the old removal edge stays whole above the crown');
    assert.equal(shouldDiscardPhotoSourceFragment({
        insideCorridor: true,
        tunnelCore: true,
        worldY: inside.roofY - 0.5,
        trackY: inside.trackY,
    }), true, 'crust below the roof plane still clears out inside the wall body');

    assert.equal(photoCutFlankOwnershipAt([strip], 5, 9.5, {}), null,
        'the open aperture inside the wall faces stays sky-owned');
    assert.equal(photoCutFlankOwnershipAt([strip], 5, 13.5, {}), null,
        'beyond the band the hillside was never removed');
    assert.equal(photoCutFlankOwnershipAt([strip], 5, -11.5, {}), null,
        'the band is one-sided: the other wall emits its own strip');
    assert.equal(photoCutFlankOwnershipAt([strip], 11, 11.5, {}), null,
        'the band ends with its wall chunk');
});
