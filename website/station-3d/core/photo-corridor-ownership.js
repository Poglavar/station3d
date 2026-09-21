// Pure ownership rules for photo-mode tunnel mouths, intact hill cores, and
// source-mesh clipping. Rendering consumes these exact slices and portal faces.

// The portal collar straddles the nominal portal plane. Google terrain is a
// coarse triangle mesh, so an oblique triangle can remain on the approach side
// and depth-test in front of a facade whose mask begins at the exact same
// plane. Two mask texels in both directions, buried inside a facade with a
// full pixel-diagonal apron, make the cleared footprint strictly interior to
// masonry at any route angle, with room for filtering and floating-point edge
// disagreement.
// The collar clears BORE-STYLE: only below the running-tube source roof. It
// must never be an open/sky column — facade masonry is sized from robust bare
// earth and capped, while the crust above it is raw DSM (hillside + canopy),
// so a full-height column tears crust that no bounded wall can ever bury (the
// "shredded terrain floating over the portal" artifact). Everything the collar
// keeps below the facade crown sits inside the opaque lintel/jamb boxes
// (lintel bottom rail+6.3 < source roof rail+7.45), and above the crown the
// hill stays genuinely intact.
// A separate, narrow green hood clears the bore farther into the hill without
// turning either interval into an open cut.
// Full-corridor carve half-width (cuts/fills/tunnels). 12 m reads as a
// motorway-scale gash for a rail line; 8 m gives a
// ~17 m trench between wall outer faces, which matches a real double-track
// cutting. At-grade spans stay at PHOTO_AT_GRADE_CORRIDOR_HALF_WIDTH_M.
export const PHOTO_CORRIDOR_HALF_WIDTH_M = 8;
// AT-GRADE spans carve only the running formation + a shoulder: real projects
// never reserve a six-track apron for a two-track route. Cuts, fills, tunnels
// and station envelopes keep the full corridor above, so every wall/flank/
// portal contract derived from it is untouched.
export const PHOTO_AT_GRADE_CORRIDOR_HALF_WIDTH_M = 5.5;
export const PHOTO_CORRIDOR_MASK_WINDOW_HALF_M = 512;
export const PHOTO_CORRIDOR_MASK_RESOLUTION = 1024;
export const PHOTO_CORRIDOR_MASK_TEXEL_M = (
    PHOTO_CORRIDOR_MASK_WINDOW_HALF_M * 2
) / PHOTO_CORRIDOR_MASK_RESOLUTION;
export const PHOTO_TUNNEL_PORTAL_COLLAR_DEPTH_M = 2 * PHOTO_CORRIDOR_MASK_TEXEL_M;
export const PHOTO_TUNNEL_PORTAL_COLLAR_OUTWARD_DEPTH_M = 2 * PHOTO_CORRIDOR_MASK_TEXEL_M;
export const PHOTO_TUNNEL_PORTAL_FACADE_DEPTH_M = (
    2 + Math.SQRT2
) * PHOTO_CORRIDOR_MASK_TEXEL_M;
export const PHOTO_TUNNEL_PORTAL_FACADE_OUTWARD_DEPTH_M = (
    2 + Math.SQRT2
) * PHOTO_CORRIDOR_MASK_TEXEL_M;
export const PHOTO_TUNNEL_PORTAL_HOOD_DEPTH_M = 10;
export const PHOTO_TUNNEL_SOURCE_ROOF_OFFSET_M = 7.45;
// Mirror the model portal's minimum visible crown: 1.4 m of headwall plus
// 0.6 m overlap into retained ground. Robust local bare-earth raises the
// headwall to meet the adjoining cut crest; the same rail-relative safety cap
// as retaining walls prevents a DSM/LOD outlier from becoming masonry.
export const PHOTO_TUNNEL_PORTAL_CROWN_M = 2;
export const PHOTO_TUNNEL_PORTAL_MAX_HEIGHT_M = 60;

const EPS = 1e-6;

function maskContainmentApron(maskTexelM) {
    return Math.SQRT2 * maskTexelM;
}

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

// One source of truth for the plan-view portal/mask contract. Source removal
// reaches one texel beyond the generic route ribbon because a coarse Google
// triangle can cross the visible headwall from outside that ribbon. Opaque
// masonry then extends one complete pixel diagonal around the removal footprint.
// The world passes its actual render-target texel size here, so changing mask
// resolution cannot silently restore the old sub-texel apron.
export function resolvePhotoPortalPlanContract({
    maskTexelM = PHOTO_CORRIDOR_MASK_TEXEL_M,
    corridorHalfWidthM = PHOTO_CORRIDOR_HALF_WIDTH_M,
    tunnelRoofHalfWidthM = 7,
} = {}) {
    const texelM = Math.max(EPS, finite(maskTexelM, PHOTO_CORRIDOR_MASK_TEXEL_M));
    const corridorM = Math.max(0, finite(corridorHalfWidthM, PHOTO_CORRIDOR_HALF_WIDTH_M));
    const roofM = Math.max(0, finite(tunnelRoofHalfWidthM, 7));
    const collarHalfWidthM = corridorM + texelM;
    const opaqueApronM = maskContainmentApron(texelM);
    return {
        maskTexelM: texelM,
        collarInwardDepthM: 2 * texelM,
        collarOutwardDepthM: 2 * texelM,
        opaqueApronM,
        facadeInwardDepthM: 2 * texelM + opaqueApronM,
        facadeOutwardDepthM: 2 * texelM + opaqueApronM,
        collarHalfWidthM,
        facadeHalfWidthM: collarHalfWidthM + opaqueApronM,
        hoodHalfWidthM: Math.max(0, roofM - texelM * 0.5),
    };
}

// The ordinary open-cut ribbon needs the same containment invariant as a
// portal: the source-removal edge must sit strictly inside opaque replacement
// geometry. The old wall centre was corridor - 1 m, so a 3 m wall reached only
// half a metre outside a 12 m mask. That is less than the sqrt(2)/2 footprint
// of a one-metre texel at a diagonal route and left filtered Google fragments
// visible through the retaining wall near oblique tunnel mouths.
export function resolvePhotoCutPlanContract({
    maskTexelM = PHOTO_CORRIDOR_MASK_TEXEL_M,
    corridorHalfWidthM = PHOTO_CORRIDOR_HALF_WIDTH_M,
    wallThicknessM = 3,
    sourceSampleApronM = 0.75,
} = {}) {
    const texelM = Math.max(EPS, finite(maskTexelM, PHOTO_CORRIDOR_MASK_TEXEL_M));
    const corridorM = Math.max(0, finite(corridorHalfWidthM, PHOTO_CORRIDOR_HALF_WIDTH_M));
    const thicknessM = Math.max(EPS, finite(wallThicknessM, 3));
    const opaqueApronM = maskContainmentApron(texelM);
    const wallOuterDistanceM = corridorM + opaqueApronM;
    const wallCenterDistanceM = wallOuterDistanceM - thicknessM * 0.5;
    const wallInnerDistanceM = wallCenterDistanceM - thicknessM * 0.5;
    return {
        maskTexelM: texelM,
        sourceRemovalHalfWidthM: corridorM,
        opaqueApronM,
        wallThicknessM: thicknessM,
        wallInnerDistanceM,
        wallCenterDistanceM,
        wallOuterDistanceM,
        sourceSampleDistanceM: wallOuterDistanceM
            + Math.max(0, finite(sourceSampleApronM, 0.75)),
        floorHalfWidthM: wallOuterDistanceM,
    };
}

function chunkLength(chunk) {
    const explicit = Number(chunk?.spanLen);
    if (Number.isFinite(explicit) && explicit > EPS) return explicit;
    return Math.hypot(
        finite(chunk?.x1) - finite(chunk?.x0),
        finite(chunk?.z1) - finite(chunk?.z0),
    );
}

function chunksTouch(a, b, toleranceM) {
    if (!a || !b || a.routeRunId !== b.routeRunId) return false;
    return Math.hypot(
        finite(a.x1) - finite(b.x0),
        finite(a.z1) - finite(b.z0),
    ) <= toleranceM;
}

function hasKnownSection(chunk) {
    if (chunk?.sourceKnown === true) return true;
    return [chunk?.groundL, chunk?.groundR, chunk?.groundC]
        .every(value => value !== null
            && value !== undefined
            && value !== ''
            && Number.isFinite(Number(value)));
}

function isCoveredStation(chunk) {
    return chunk?.structure === 'station-underground'
        || chunk?.structure === 'station-covered';
}

function pointOnChunk(chunk, t) {
    const clamped = Math.max(0, Math.min(1, finite(t)));
    const x0 = finite(chunk.x0, finite(chunk.mx));
    const z0 = finite(chunk.z0, finite(chunk.mz));
    const y0 = finite(chunk.ty0, finite(chunk.ty));
    const x1 = finite(chunk.x1, finite(chunk.mx));
    const z1 = finite(chunk.z1, finite(chunk.mz));
    const y1 = finite(chunk.ty1, finite(chunk.ty));
    return {
        x: x0 + (x1 - x0) * clamped,
        z: z0 + (z1 - z0) * clamped,
        trackY: y0 + (y1 - y0) * clamped,
    };
}

function makeSlice(chunk, chunkIndex, t0, t1, sourceMode) {
    const start = pointOnChunk(chunk, t0);
    const end = pointOnChunk(chunk, t1);
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const spanLen = Math.hypot(dx, dz);
    if (spanLen <= EPS) return null;
    const ux = dx / spanLen;
    const uz = dz / spanLen;
    return {
        routeRunId: chunk.routeRunId,
        chunkIndex,
        structure: 'tunnel',
        sourceMode,
        x0: start.x,
        z0: start.z,
        ty0: start.trackY,
        x1: end.x,
        z1: end.z,
        ty1: end.trackY,
        mx: (start.x + end.x) * 0.5,
        mz: (start.z + end.z) * 0.5,
        ty: (start.trackY + end.trackY) * 0.5,
        spanLen,
        ux,
        uz,
        px: -uz,
        pz: ux,
    };
}

function faceAtRunDistance(run, distanceM, side) {
    let remaining = distanceM;
    for (let localIndex = 0; localIndex < run.chunks.length; localIndex++) {
        const item = run.chunks[localIndex];
        const length = chunkLength(item.chunk);
        // At an exact start-mouth chunk boundary, use the first CORE-side
        // tangent. The preceding open-cut tangent can point across a bend and
        // leave a skewed gap between the facade and tube. At an end mouth the
        // preceding chunk already is the core side, so keep it.
        const exactEnd = Math.abs(remaining - length) <= EPS;
        if (side === 'start'
            && exactEnd
            && localIndex < run.chunks.length - 1) {
            remaining = 0;
            continue;
        }
        if (remaining <= length + EPS || localIndex === run.chunks.length - 1) {
            const t = length > EPS ? Math.max(0, Math.min(1, remaining / length)) : 0;
            const point = pointOnChunk(item.chunk, t);
            const dx = finite(item.chunk.x1) - finite(item.chunk.x0);
            const dz = finite(item.chunk.z1) - finite(item.chunk.z0);
            const horizontal = Math.hypot(dx, dz) || 1;
            const dy = finite(item.chunk.ty1, finite(item.chunk.ty))
                - finite(item.chunk.ty0, finite(item.chunk.ty));
            return {
                routeRunId: item.chunk.routeRunId,
                chunkIndex: item.index,
                side,
                x: point.x,
                z: point.z,
                trackY: point.trackY,
                ux: dx / horizontal,
                uz: dz / horizontal,
                px: -dz / horizontal,
                pz: dx / horizontal,
                gradeYPerM: dy / horizontal,
            };
        }
        remaining -= length;
    }
    return null;
}

function portalInwardFrame(face) {
    if (!face) return null;
    const inward = face.side === 'end' ? -1 : 1;
    const ux = finite(face.ux) * inward;
    const uz = finite(face.uz) * inward;
    const gradeYPerM = finite(face.gradeYPerM) * inward;
    return { ux, uz, px: -uz, pz: ux, gradeYPerM };
}

function portalSourceCollar(
    face,
    inwardDepthM,
    outwardDepthM,
    tunnelRoofOffsetM,
) {
    const inwardDepth = Math.max(0, finite(inwardDepthM));
    const outwardDepth = Math.max(0, finite(outwardDepthM));
    const depth = inwardDepth + outwardDepth;
    const frame = portalInwardFrame(face);
    if (!frame || depth <= EPS) return null;
    const portalTrackY = finite(face.trackY);
    const trackY0 = portalTrackY - frame.gradeYPerM * outwardDepth;
    const trackY1 = portalTrackY + frame.gradeYPerM * inwardDepth;
    const roofOffsetM = finite(
        tunnelRoofOffsetM,
        PHOTO_TUNNEL_SOURCE_ROOF_OFFSET_M,
    );
    return {
        routeRunId: face.routeRunId,
        chunkIndex: face.chunkIndex,
        side: face.side,
        sourceMode: 'portal-collar',
        faceX: finite(face.x),
        faceZ: finite(face.z),
        faceTrackY: portalTrackY,
        x0: finite(face.x) - frame.ux * outwardDepth,
        z0: finite(face.z) - frame.uz * outwardDepth,
        ty0: trackY0,
        roofY0: trackY0 + roofOffsetM,
        maskTy0: trackY0,
        x1: finite(face.x) + frame.ux * inwardDepth,
        z1: finite(face.z) + frame.uz * inwardDepth,
        ty1: trackY1,
        roofY1: trackY1 + roofOffsetM,
        maskTy1: trackY1,
        spanLen: depth,
        inwardDepthM: inwardDepth,
        outwardDepthM: outwardDepth,
        ux: frame.ux,
        uz: frame.uz,
        px: frame.px,
        pz: frame.pz,
    };
}

function portalSourceHood(
    face,
    startDepthM,
    depthM,
    tunnelRoofOffsetM,
) {
    const startDepth = Math.max(0, finite(startDepthM));
    const depth = Math.max(0, finite(depthM));
    const frame = portalInwardFrame(face);
    if (!frame || depth <= EPS) return null;
    const portalTrackY = finite(face.trackY);
    const startTrackY = portalTrackY + frame.gradeYPerM * startDepth;
    const endTrackY = portalTrackY + frame.gradeYPerM * (startDepth + depth);
    const roofOffsetM = finite(
        tunnelRoofOffsetM,
        PHOTO_TUNNEL_SOURCE_ROOF_OFFSET_M,
    );
    const faceRoofY = startTrackY + roofOffsetM;
    const endRoofY = endTrackY
        + roofOffsetM;
    return {
        routeRunId: face.routeRunId,
        chunkIndex: face.chunkIndex,
        side: face.side,
        sourceMode: 'portal-hood',
        faceX: finite(face.x),
        faceZ: finite(face.z),
        faceTrackY: startTrackY,
        startDepthM: startDepth,
        x0: finite(face.x) + frame.ux * startDepth,
        z0: finite(face.z) + frame.uz * startDepth,
        ty0: startTrackY,
        roofY0: faceRoofY,
        maskTy0: faceRoofY - roofOffsetM,
        x1: finite(face.x) + frame.ux * (startDepth + depth),
        z1: finite(face.z) + frame.uz * (startDepth + depth),
        ty1: endTrackY,
        roofY1: endRoofY,
        maskTy1: endTrackY,
        spanLen: depth,
        inwardDepthM: depth,
        ux: frame.ux,
        uz: frame.uz,
        px: frame.px,
        pz: frame.pz,
    };
}

function addPortalBands(face, output, options, coreLengthM, approachLengthM) {
    if (!face) return;
    output.portalFaces.push(face);
    const collar = portalSourceCollar(
        face,
        Math.min(options.portalCollarDepthM, coreLengthM * 0.5),
        Math.min(options.portalCollarOutwardDepthM, approachLengthM),
        options.tunnelRoofOffsetM,
    );
    if (collar) output.portalCollars.push(collar);
    const hoodStartM = collar?.inwardDepthM || 0;
    const hood = portalSourceHood(
        face,
        hoodStartM,
        Math.min(
            options.portalHoodDepthM,
            Math.max(0, coreLengthM * 0.5 - hoodStartM),
        ),
        options.tunnelRoofOffsetM,
    );
    if (hood) output.portalHoods.push(hood);
}

function finalizeTunnelRun(run, allChunks, output, options) {
    if (!run || run.chunks.length === 0) return;
    const first = run.chunks[0];
    const last = run.chunks[run.chunks.length - 1];
    const before = allChunks[first.index - 1];
    const after = allChunks[last.index + 1];
    const boundedStart = !!before
        && before.structure !== 'tunnel'
        && !isCoveredStation(before)
        && hasKnownSection(before)
        && chunksTouch(before, first.chunk, options.continuityToleranceM);
    const boundedEnd = !!after
        && after.structure !== 'tunnel'
        && !isCoveredStation(after)
        && hasKnownSection(after)
        && chunksTouch(last.chunk, after, options.continuityToleranceM);
    const runLength = run.chunks.reduce((sum, item) => sum + chunkLength(item.chunk), 0);
    // Tunnel classification is sampled at each corridor chunk midpoint. Place
    // the visible portal at the first/last sample that actually qualified as
    // tunnel, rather than a fixed distance farther into the hill. The old 24 m
    // inset put portals deep into steep slopes, where even the 60 m civil cap
    // could not meet retained ground and Google appeared above the headwall.
    const requestedCarveM = options.portalCarveM;
    const startEvidenceInsetM = requestedCarveM === null
        ? chunkLength(first.chunk) * 0.5
        : requestedCarveM;
    const endEvidenceInsetM = requestedCarveM === null
        ? chunkLength(last.chunk) * 0.5
        : requestedCarveM;
    const startCarveM = boundedStart ? Math.min(startEvidenceInsetM, runLength) : 0;
    const endCarveM = boundedEnd ? Math.min(endEvidenceInsetM, runLength) : 0;
    const hasCore = startCarveM + endCarveM < runLength - EPS;
    const coreStartM = hasCore ? startCarveM : null;
    const coreEndM = hasCore ? runLength - endCarveM : null;

    let station = 0;
    for (const item of run.chunks) {
        const length = chunkLength(item.chunk);
        const startM = station;
        const endM = station + length;
        const cuts = [startM, endM];
        if (hasCore && coreStartM > startM + EPS && coreStartM < endM - EPS) cuts.push(coreStartM);
        if (hasCore && coreEndM > startM + EPS && coreEndM < endM - EPS) cuts.push(coreEndM);
        cuts.sort((a, b) => a - b);
        for (let cutIndex = 1; cutIndex < cuts.length; cutIndex++) {
            const a = cuts[cutIndex - 1];
            const b = cuts[cutIndex];
            if (b - a <= EPS) continue;
            const middle = (a + b) * 0.5;
            const sourceMode = hasCore
                && middle >= coreStartM - EPS
                && middle <= coreEndM + EPS
                ? 'tunnel-core'
                : 'open';
            const slice = makeSlice(
                item.chunk,
                item.index,
                length > EPS ? (a - startM) / length : 0,
                length > EPS ? (b - startM) / length : 1,
                sourceMode,
            );
            if (slice) output.slices.push(slice);
        }
        station = endM;
    }

    if (hasCore && boundedStart && startCarveM > EPS) {
        const face = faceAtRunDistance(run, coreStartM, 'start');
        addPortalBands(
            face,
            output,
            options,
            coreEndM - coreStartM,
            startCarveM,
        );
    }
    if (hasCore && boundedEnd && endCarveM > EPS) {
        const face = faceAtRunDistance(run, coreEndM, 'end');
        addPortalBands(
            face,
            output,
            options,
            coreEndM - coreStartM,
            endCarveM,
        );
    }
}

export function derivePhotoCorridorOwnership(chunks, {
    portalCarveM = null,
    portalCollarDepthM = PHOTO_TUNNEL_PORTAL_COLLAR_DEPTH_M,
    portalCollarOutwardDepthM = PHOTO_TUNNEL_PORTAL_COLLAR_OUTWARD_DEPTH_M,
    portalHoodDepthM = PHOTO_TUNNEL_PORTAL_HOOD_DEPTH_M,
    tunnelRoofOffsetM = PHOTO_TUNNEL_SOURCE_ROOF_OFFSET_M,
    continuityToleranceM = 1.5,
} = {}) {
    const input = Array.isArray(chunks) ? chunks : [];
    const options = {
        // Null is the normal adaptive policy. A numeric value remains useful
        // for deterministic geometry tests and deliberate future overrides.
        portalCarveM: portalCarveM === null || portalCarveM === undefined
            ? null
            : Math.max(0, finite(portalCarveM)),
        portalCollarDepthM: Math.max(
            0,
            finite(portalCollarDepthM, PHOTO_TUNNEL_PORTAL_COLLAR_DEPTH_M),
        ),
        portalCollarOutwardDepthM: Math.max(
            0,
            finite(
                portalCollarOutwardDepthM,
                PHOTO_TUNNEL_PORTAL_COLLAR_OUTWARD_DEPTH_M,
            ),
        ),
        portalHoodDepthM: Math.max(
            0,
            finite(portalHoodDepthM, PHOTO_TUNNEL_PORTAL_HOOD_DEPTH_M),
        ),
        tunnelRoofOffsetM: Math.max(
            0,
            finite(tunnelRoofOffsetM, PHOTO_TUNNEL_SOURCE_ROOF_OFFSET_M),
        ),
        continuityToleranceM: Math.max(0, finite(continuityToleranceM, 1.5)),
    };
    const output = {
        slices: [],
        portalFaces: [],
        portalCollars: [],
        portalHoods: [],
    };
    let run = null;
    for (let index = 0; index < input.length; index++) {
        const chunk = input[index];
        const previous = run?.chunks[run.chunks.length - 1]?.chunk;
        const continues = chunk?.structure === 'tunnel'
            && previous
            && chunksTouch(previous, chunk, options.continuityToleranceM);
        if (chunk?.structure !== 'tunnel' || (!continues && run)) {
            finalizeTunnelRun(run, input, output, options);
            run = null;
        }
        if (chunk?.structure === 'tunnel') {
            if (!run) run = { chunks: [] };
            run.chunks.push({ chunk, index });
        }
    }
    finalizeTunnelRun(run, input, output, options);
    return output;
}

// Resolve streamed portal evidence into the same tapered roof used by both the
// green mask payload and the opaque hood. Source above this roof remains real;
// source below it is replaced. The far end always meets the ordinary tube roof.
export function resolvePhotoPortalHoodRoof(hood, {
    faceRoofY,
    maxFaceRoofY = Infinity,
    tunnelRoofOffsetM = PHOTO_TUNNEL_SOURCE_ROOF_OFFSET_M,
} = {}) {
    if (hood?.sourceMode !== 'portal-hood') return hood;
    const roofOffsetM = Math.max(
        0,
        finite(tunnelRoofOffsetM, PHOTO_TUNNEL_SOURCE_ROOF_OFFSET_M),
    );
    const minimumFaceRoofY = finite(hood.faceTrackY) + roofOffsetM;
    const maximumFaceRoofY = Math.max(
        minimumFaceRoofY,
        finite(maxFaceRoofY, Infinity),
    );
    const resolvedFaceRoofY = Math.min(
        maximumFaceRoofY,
        Math.max(minimumFaceRoofY, finite(faceRoofY, minimumFaceRoofY)),
    );
    const endRoofY = finite(hood.ty1) + roofOffsetM;
    return {
        ...hood,
        roofY0: resolvedFaceRoofY,
        maskTy0: resolvedFaceRoofY - roofOffsetM,
        roofY1: endRoofY,
        maskTy1: finite(hood.ty1),
    };
}

// The full-width collar records the horizontal facade top for replacement
// geometry, but its mask stays a bore-style clearance with the plain
// track-floor payload (source removed below floor + the fixed tube-roof
// offset, hill kept above). The roof-to-crown band it keeps is entirely
// buried inside the deeper opaque facade, so this avoids encoding a tall
// civil height in the track-floor payload without exposing a source hole —
// and without cutting a sky-high slot through the hill above the crown.
export function resolvePhotoPortalCollarRoof(collar, {
    portalTopY,
    tunnelRoofOffsetM = PHOTO_TUNNEL_SOURCE_ROOF_OFFSET_M,
} = {}) {
    if (collar?.sourceMode !== 'portal-collar') return collar;
    const roofOffsetM = Math.max(
        0,
        finite(tunnelRoofOffsetM, PHOTO_TUNNEL_SOURCE_ROOF_OFFSET_M),
    );
    const minimumTopY = Math.max(finite(collar.ty0), finite(collar.ty1))
        + roofOffsetM;
    const resolvedTopY = Math.max(minimumTopY, finite(portalTopY, minimumTopY));
    return {
        ...collar,
        roofY0: resolvedTopY,
        roofY1: resolvedTopY,
        // Facade height is replacement geometry, not an encodable tunnel roof:
        // the mask payload remains the real floor and the shader keeps using
        // the shared fixed source-roof offset above it.
        maskTy0: finite(collar.ty0),
        maskTy1: finite(collar.ty1),
    };
}

// Resolve the complete portal from its local authored section and optional
// robust retained-ground evidence. Raw Google surface height intentionally is
// not an input: a shallow collar clears source behind the facade completely,
// while the hood starts behind it and preserves the hill above the bore roof.
export function resolvePhotoPortalCivilEnvelope(collar, hood, {
    crownM = PHOTO_TUNNEL_PORTAL_CROWN_M,
    retainedTopY = null,
    maxPortalHeightM = PHOTO_TUNNEL_PORTAL_MAX_HEIGHT_M,
    tunnelRoofOffsetM = PHOTO_TUNNEL_SOURCE_ROOF_OFFSET_M,
} = {}) {
    if (collar?.sourceMode !== 'portal-collar'
        || hood?.sourceMode !== 'portal-hood') return null;
    const roofOffsetM = Math.max(
        0,
        finite(tunnelRoofOffsetM, PHOTO_TUNNEL_SOURCE_ROOF_OFFSET_M),
    );
    const localTrackY = Math.max(
        finite(collar.ty0),
        finite(collar.ty1),
        finite(hood.faceTrackY),
    );
    const minimumTopY = localTrackY
        + roofOffsetM
        + Math.max(0, finite(crownM, PHOTO_TUNNEL_PORTAL_CROWN_M));
    const maximumTopY = localTrackY + Math.max(
        roofOffsetM + Math.max(0, finite(crownM, PHOTO_TUNNEL_PORTAL_CROWN_M)),
        finite(maxPortalHeightM, PHOTO_TUNNEL_PORTAL_MAX_HEIGHT_M),
    );
    const retained = retainedTopY !== null
        && retainedTopY !== undefined
        && retainedTopY !== ''
        && Number.isFinite(Number(retainedTopY))
        ? Number(retainedTopY)
        : minimumTopY;
    const portalTopY = Math.min(maximumTopY, Math.max(minimumTopY, retained));
    const hoodFaceTopY = Math.max(
        finite(hood.faceTrackY) + roofOffsetM,
        localTrackY + roofOffsetM
            + Math.max(0, finite(crownM, PHOTO_TUNNEL_PORTAL_CROWN_M)),
    );
    const resolvedHood = resolvePhotoPortalHoodRoof(hood, {
        faceRoofY: hoodFaceTopY,
        maxFaceRoofY: hoodFaceTopY,
        tunnelRoofOffsetM: roofOffsetM,
    });
    const resolvedCollar = resolvePhotoPortalCollarRoof(collar, {
        portalTopY,
        tunnelRoofOffsetM: roofOffsetM,
    });
    return {
        portalTopY,
        collar: resolvedCollar,
        hood: resolvedHood,
    };
}

function buildPortalBandMaskQuads(bands, width, payloadAt) {
    const positions = [];
    const colors = [];
    for (const band of bands || []) {
        const nx = finite(band.px) * width;
        const nz = finite(band.pz) * width;
        positions.push(
            band.x0 + nx, 0, band.z0 + nz,
            band.x0 - nx, 0, band.z0 - nz,
            band.x1 - nx, 0, band.z1 - nz,
            band.x0 + nx, 0, band.z0 + nz,
            band.x1 - nx, 0, band.z1 - nz,
            band.x1 + nx, 0, band.z1 + nz,
        );
        const [green, b0, b1] = payloadAt(band);
        colors.push(
            1, green, b0, 1, green, b0, 1, green, b1,
            1, green, b0, 1, green, b1, 1, green, b1,
        );
    }
    return { positions, colors };
}

export function buildPortalCollarMaskQuads(collars, {
    halfWidthM,
    encodeFloor,
} = {}) {
    const width = Math.max(0, finite(halfWidthM));
    const encode = typeof encodeFloor === 'function' ? encodeFloor : () => 0;
    return buildPortalBandMaskQuads(
        (collars || []).filter(band => band?.sourceMode === 'portal-collar'),
        width,
        // Core/roof ownership, NOT red/open: clear the mouth below the shared
        // source-roof offset and KEEP the real hill above it. The band the
        // facade must hide (roof..crown) interpenetrates the opaque lintel and
        // jamb boxes, which are deeper than this collar on both sides; a red
        // sky-column here would notch the hillside above the crown, where no
        // bounded masonry can ever bury the torn crust.
        band => [1, encode(band.maskTy0), encode(band.maskTy1)],
    );
}

export function buildPortalHoodMaskQuads(hoods, {
    halfWidthM,
    encodeFloor,
} = {}) {
    const width = Math.max(0, finite(halfWidthM));
    const encode = typeof encodeFloor === 'function' ? encodeFloor : () => 0;
    return buildPortalBandMaskQuads(
        (hoods || []).filter(band => band?.sourceMode === 'portal-hood'),
        width,
        band => [1, encode(band.maskTy0), encode(band.maskTy1)],
    );
}

function portalBandSampleAt(bands, x, z, width) {
    for (const band of bands || []) {
        const dx = finite(x) - finite(band.x0);
        const dz = finite(z) - finite(band.z0);
        const along = dx * finite(band.ux) + dz * finite(band.uz);
        const right = dx * finite(band.px) + dz * finite(band.pz);
        const spanLen = finite(band.spanLen);
        if (along < -EPS || along > spanLen + EPS || Math.abs(right) > width + EPS) {
            continue;
        }
        const t = spanLen > EPS ? Math.max(0, Math.min(1, along / spanLen)) : 0;
        return { band, t };
    }
    return null;
}

export function photoPortalSourceOwnershipAt(collars, hoods, x, z, {
    collarHalfWidthM,
    hoodHalfWidthM,
    tunnelRoofOffsetM = PHOTO_TUNNEL_SOURCE_ROOF_OFFSET_M,
} = {}) {
    // The narrow hood is drawn after the full-headwall collar and therefore
    // wins in the central bore where the two overlap.
    const hoodHit = portalBandSampleAt(
        (hoods || []).filter(band => band?.sourceMode === 'portal-hood'),
        x,
        z,
        Math.max(0, finite(hoodHalfWidthM)),
    );
    if (hoodHit) {
        const { band, t } = hoodHit;
        const effectiveTrackY = finite(band.maskTy0)
            + (finite(band.maskTy1) - finite(band.maskTy0)) * t;
        return {
            mode: 'tunnel-core',
            sourceMode: 'portal-hood',
            trackY: effectiveTrackY,
            roofY: effectiveTrackY
                + finite(tunnelRoofOffsetM, PHOTO_TUNNEL_SOURCE_ROOF_OFFSET_M),
            band,
        };
    }
    const collarHit = portalBandSampleAt(
        (collars || []).filter(band => band?.sourceMode === 'portal-collar'),
        x,
        z,
        Math.max(0, finite(collarHalfWidthM)),
    );
    if (!collarHit) return null;
    const { band, t } = collarHit;
    const floorY = finite(band.maskTy0)
        + (finite(band.maskTy1) - finite(band.maskTy0)) * t;
    // Bore-style, mirroring the GPU mask: source exists again above the shared
    // roof offset (the kept hill / the roof-to-crown band buried in masonry).
    return {
        mode: 'tunnel-core',
        sourceMode: 'portal-collar',
        trackY: floorY,
        floorY,
        roofY: floorY
            + finite(tunnelRoofOffsetM, PHOTO_TUNNEL_SOURCE_ROOF_OFFSET_M),
        band,
    };
}

export function photoPortalFacadeFrame(face, {
    depthM = PHOTO_TUNNEL_PORTAL_FACADE_DEPTH_M,
    outwardDepthM = PHOTO_TUNNEL_PORTAL_FACADE_OUTWARD_DEPTH_M,
} = {}) {
    const frame = portalInwardFrame(face);
    const inwardDepth = Math.max(
        0,
        finite(depthM, PHOTO_TUNNEL_PORTAL_FACADE_DEPTH_M),
    );
    const outwardDepth = Math.max(
        0,
        finite(outwardDepthM, PHOTO_TUNNEL_PORTAL_FACADE_OUTWARD_DEPTH_M),
    );
    const totalDepth = inwardDepth + outwardDepth;
    if (!frame || totalDepth <= EPS) return null;
    return {
        centerX: finite(face.x) + frame.ux * (inwardDepth - outwardDepth) * 0.5,
        centerZ: finite(face.z) + frame.uz * (inwardDepth - outwardDepth) * 0.5,
        depthM: totalDepth,
        inwardDepthM: inwardDepth,
        outwardDepthM: outwardDepth,
        ux: Math.abs(frame.ux) <= EPS ? 0 : frame.ux,
        uz: Math.abs(frame.uz) <= EPS ? 0 : frame.uz,
        px: Math.abs(frame.px) <= EPS ? 0 : frame.px,
        pz: Math.abs(frame.pz) <= EPS ? 0 : frame.pz,
    };
}

// Deep-cut flanks have the portal collar's disease in miniature: the open
// ribbon removes source to the SKY out to the mask edge, while the retaining
// wall crown stops at robust bare earth — so canopy/crust straddling the
// removal edge tears along a plane no wall can bury, and the shreds float
// above the crown. Where a wall's crown buries the running-tube roof plane,
// the strip of ribbon hidden by the wall body (wall inner face .. one texel
// past the removal edge) can safely switch to core/roof ownership instead:
// crust below the crown hides inside the masonry, crust and whole treetops
// above the roof plane stay real, and the open sky void shrinks to exactly
// the wall-to-wall aperture.
export function resolvePhotoCutFlankBand({
    x0, z0, ty0, x1, z1, ty1, px, pz, routeRunId = null,
} = {}, {
    side = 1,
    wallTopY,
    innerM,
    outerM,
    tunnelRoofOffsetM = PHOTO_TUNNEL_SOURCE_ROOF_OFFSET_M,
    minRoofBuryM = 1,
} = {}) {
    const ax = finite(x0), az = finite(z0);
    const bx = finite(x1), bz = finite(z1);
    const spanLen = Math.hypot(bx - ax, bz - az);
    const inner = finite(innerM);
    const outer = finite(outerM);
    if (spanLen <= EPS || outer - inner <= EPS) return null;
    const crown = Number(wallTopY);
    if (!Number.isFinite(crown)) return null;
    const roofOffset = Math.max(
        0,
        finite(tunnelRoofOffsetM, PHOTO_TUNNEL_SOURCE_ROOF_OFFSET_M),
    );
    // The roof plane (the horizontal seam the band introduces) must sit
    // strictly below the crown that hides it, with margin for the payload's
    // 8-bit quantisation and the chunk-end grade spread.
    const roofBury = Math.max(0, finite(minRoofBuryM, 1));
    if (crown < Math.max(finite(ty0), finite(ty1)) + roofOffset + roofBury) {
        return null;
    }
    const signed = side >= 0 ? 1 : -1;
    return {
        sourceMode: 'cut-flank',
        routeRunId,
        x0: ax,
        z0: az,
        ty0: finite(ty0),
        x1: bx,
        z1: bz,
        ty1: finite(ty1),
        ux: (bx - ax) / spanLen,
        uz: (bz - az) / spanLen,
        px: finite(px) * signed,
        pz: finite(pz) * signed,
        spanLen,
        innerM: inner,
        outerM: outer,
    };
}

export function buildCutFlankMaskQuads(strips, { encodeFloor } = {}) {
    const encode = typeof encodeFloor === 'function' ? encodeFloor : () => 0;
    const positions = [];
    const colors = [];
    for (const strip of strips || []) {
        if (strip?.sourceMode !== 'cut-flank') continue;
        const aInX = strip.x0 + strip.px * strip.innerM;
        const aInZ = strip.z0 + strip.pz * strip.innerM;
        const aOutX = strip.x0 + strip.px * strip.outerM;
        const aOutZ = strip.z0 + strip.pz * strip.outerM;
        const bInX = strip.x1 + strip.px * strip.innerM;
        const bInZ = strip.z1 + strip.pz * strip.innerM;
        const bOutX = strip.x1 + strip.px * strip.outerM;
        const bOutZ = strip.z1 + strip.pz * strip.outerM;
        positions.push(
            aInX, 0, aInZ,
            aOutX, 0, aOutZ,
            bOutX, 0, bOutZ,
            aInX, 0, aInZ,
            bOutX, 0, bOutZ,
            bInX, 0, bInZ,
        );
        const b0 = encode(strip.ty0);
        const b1 = encode(strip.ty1);
        // Core/roof class with the ordinary floor payload, exactly like the
        // bore: remove below floor + the shared source-roof offset, keep above.
        colors.push(
            1, 1, b0, 1, 1, b0, 1, 1, b1,
            1, 1, b0, 1, 1, b1, 1, 1, b1,
        );
    }
    return { positions, colors };
}

// CPU twin of the flank band quads, for walk ghost-ground parity.
export function photoCutFlankOwnershipAt(strips, x, z, {
    tunnelRoofOffsetM = PHOTO_TUNNEL_SOURCE_ROOF_OFFSET_M,
} = {}) {
    for (const strip of strips || []) {
        if (strip?.sourceMode !== 'cut-flank') continue;
        const dx = finite(x) - strip.x0;
        const dz = finite(z) - strip.z0;
        const along = dx * strip.ux + dz * strip.uz;
        if (along < -EPS || along > strip.spanLen + EPS) continue;
        const right = dx * strip.px + dz * strip.pz;
        if (right < strip.innerM - EPS || right > strip.outerM + EPS) continue;
        const t = strip.spanLen > EPS
            ? Math.max(0, Math.min(1, along / strip.spanLen))
            : 0;
        const trackY = strip.ty0 + (strip.ty1 - strip.ty0) * t;
        return {
            mode: 'tunnel-core',
            sourceMode: 'cut-flank',
            trackY,
            roofY: trackY
                + finite(tunnelRoofOffsetM, PHOTO_TUNNEL_SOURCE_ROOF_OFFSET_M),
            strip,
        };
    }
    return null;
}

export function buildTunnelCoreMaskQuads(slices, {
    halfWidthM,
    encodeFloor,
    joinSegments = 10,
} = {}) {
    const width = Math.max(0, finite(halfWidthM));
    const encode = typeof encodeFloor === 'function' ? encodeFloor : () => 0;
    const circleSegments = Math.max(3, Math.floor(finite(joinSegments, 10)));
    const positions = [];
    const colors = [];
    // Each run's core interval endpoints — the portal faces. An INTERNAL join
    // closer to a face than the corridor radius must have its disc clamped to
    // that distance: a full-radius disc at a junction a few metres inside the
    // mouth bulges through the face and paints keep-above-roof over the OPEN
    // approach — Google cover hangs over the mouth as a torn floating ribbon
    // (this was the un-killable portal sliver). The clipped outer wedge of a
    // clamped disc lies within the portal cap/jamb footprint, so a bend right
    // at a mouth stays sealed by masonry instead of by mask overreach.
    const runEnds = new Map();
    for (const slice of slices || []) {
        if (slice?.sourceMode !== 'tunnel-core') continue;
        const ends = runEnds.get(slice.routeRunId);
        if (!ends) {
            runEnds.set(slice.routeRunId, {
                x0: finite(slice.x0), z0: finite(slice.z0),
                x1: finite(slice.x1), z1: finite(slice.z1),
            });
        } else {
            ends.x1 = finite(slice.x1);
            ends.z1 = finite(slice.z1);
        }
    }
    let previous = null;
    for (const slice of slices || []) {
        if (slice?.sourceMode !== 'tunnel-core') continue;
        // Consecutive core quads need a round INTERNAL join on bends; without
        // one, the red/open ribbon underneath leaks through as a triangular
        // notch. Never cap a run end: that would move the exact portal face by
        // one corridor radius and put Google cover back over the open mouth.
        const joined = previous
            && previous.routeRunId === slice.routeRunId
            && Math.hypot(
                finite(previous.x1) - finite(slice.x0),
                finite(previous.z1) - finite(slice.z0),
            ) <= 1e-4;
        if (joined) {
            const ends = runEnds.get(slice.routeRunId);
            const radius = Math.min(
                width,
                Math.hypot(finite(slice.x0) - ends.x0, finite(slice.z0) - ends.z0),
                Math.hypot(finite(slice.x0) - ends.x1, finite(slice.z0) - ends.z1),
            );
            const b = encode(slice.ty0);
            for (let segment = 0; radius > EPS && segment < circleSegments; segment++) {
                const a0 = (segment / circleSegments) * Math.PI * 2;
                const a1 = ((segment + 1) / circleSegments) * Math.PI * 2;
                positions.push(
                    slice.x0, 0, slice.z0,
                    slice.x0 + Math.cos(a0) * radius, 0, slice.z0 + Math.sin(a0) * radius,
                    slice.x0 + Math.cos(a1) * radius, 0, slice.z0 + Math.sin(a1) * radius,
                );
                colors.push(1, 1, b, 1, 1, b, 1, 1, b);
            }
        }
        const nx = finite(slice.px) * width;
        const nz = finite(slice.pz) * width;
        positions.push(
            slice.x0 + nx, 0, slice.z0 + nz,
            slice.x0 - nx, 0, slice.z0 - nz,
            slice.x1 - nx, 0, slice.z1 - nz,
            slice.x0 + nx, 0, slice.z0 + nz,
            slice.x1 - nx, 0, slice.z1 - nz,
            slice.x1 + nx, 0, slice.z1 + nz,
        );
        const b0 = encode(slice.ty0);
        const b1 = encode(slice.ty1);
        colors.push(
            1, 1, b0, 1, 1, b0, 1, 1, b1,
            1, 1, b0, 1, 1, b1, 1, 1, b1,
        );
        previous = slice;
    }
    return { positions, colors };
}

export function shouldDiscardPhotoSourceFragment({
    insideCorridor = false,
    tunnelCore = false,
    worldY,
    trackY,
    cutFloorOffsetM = -0.4,
    tunnelRoofOffsetM = 7.45,
} = {}) {
    if (!insideCorridor) return false;
    const y = Number(worldY);
    const track = Number(trackY);
    if (!Number.isFinite(y) || !Number.isFinite(track)) return false;
    return tunnelCore
        ? y < track + finite(tunnelRoofOffsetM, 7.45)
        : y > track + finite(cutFloorOffsetM, -0.4);
}
