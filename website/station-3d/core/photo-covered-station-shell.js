// Pure route-swept geometry for compact photo-mode stations. One indexed set of
// route rings owns the visible shell, its source mask and walk-wall colliders.

const EPS = 1e-7;

export const PHOTO_COVERED_STATION_TRANSITION_M = 8;
export const PHOTO_COVERED_STATION_SAMPLE_STEP_M = 2;
export const PHOTO_COVERED_STATION_MASK_HALF_WIDTH_M = 12;

// These values are also consumed by world/photoreal.js for the running tube.
// Keeping the endpoint section here makes an adapter mismatch impossible.
export const PHOTO_RUNNING_TUNNEL_SECTION = Object.freeze({
    wallCenterM: 6,
    wallThicknessM: 1,
    wallBottomOffsetM: -4,
    wallTopOffsetM: 6.5,
    roofHalfWidthM: 7,
    roofBottomOffsetM: 6.5,
    roofTopOffsetM: 7.3,
    sourceRoofOffsetM: 7.45,
    floorHalfWidthM: 7,
    floorBottomOffsetM: -0.4,
    floorTopOffsetM: -0.05,
});

export const PHOTO_COVERED_STATION_SECTION = Object.freeze({
    wallCenterM: 9,
    wallThicknessM: 1,
    wallBottomOffsetM: -4,
    wallTopOffsetM: 8.25,
    roofHalfWidthM: 9.5,
    roofBottomOffsetM: 7.65,
    roofTopOffsetM: 8.25,
    sourceRoofOffsetM: 8.25,
    floorHalfWidthM: 9,
    floorBottomOffsetM: -0.4,
    floorTopOffsetM: -0.05,
});

const SHELL_COMPONENTS = Object.freeze([
    { name: 'floor', color: [0.24, 0.23, 0.215] },
    { name: 'left-wall', color: [0.35, 0.335, 0.305] },
    { name: 'right-wall', color: [0.35, 0.335, 0.305] },
    { name: 'roof', color: [0.31, 0.30, 0.28] },
]);

function finite(value, fallback = null) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function lerp(from, to, t) {
    return from + (to - from) * t;
}

function smoothstep01(value) {
    const t = Math.max(0, Math.min(1, finite(value, 0)));
    return t * t * (3 - 2 * t);
}

function interpolateSection(from, to, t) {
    const section = {};
    for (const key of Object.keys(from)) section[key] = lerp(from[key], to[key], t);
    return section;
}

function cleanAndDensifySamples(samples, maxStepM) {
    const cleaned = [];
    for (const sample of samples || []) {
        const point = {
            x: finite(sample?.x),
            y: finite(sample?.y, 0),
            z: finite(sample?.z),
        };
        if (point.x == null || point.z == null) continue;
        const previous = cleaned[cleaned.length - 1];
        if (previous && Math.hypot(point.x - previous.x, point.z - previous.z) <= EPS) {
            previous.y = point.y;
            continue;
        }
        cleaned.push(point);
    }
    if (cleaned.length < 2) return [];

    const stepM = Math.max(0.25, finite(maxStepM, PHOTO_COVERED_STATION_SAMPLE_STEP_M));
    const dense = [{ ...cleaned[0] }];
    for (let index = 1; index < cleaned.length; index++) {
        const from = cleaned[index - 1];
        const to = cleaned[index];
        const distanceM = Math.hypot(to.x - from.x, to.z - from.z);
        const steps = Math.max(1, Math.ceil(distanceM / stepM));
        for (let step = 1; step <= steps; step++) {
            const t = step / steps;
            dense.push({
                x: lerp(from.x, to.x, t),
                y: lerp(from.y, to.y, t),
                z: lerp(from.z, to.z, t),
            });
        }
    }
    return dense;
}

function horizontalDirection(from, to) {
    const fromX = finite(from?.x);
    const fromZ = finite(from?.z);
    const toX = finite(to?.x);
    const toZ = finite(to?.z);
    if (fromX == null || fromZ == null || toX == null || toZ == null) return null;
    const dx = toX - fromX;
    const dz = toZ - fromZ;
    const lengthM = Math.hypot(dx, dz);
    return lengthM > EPS ? { x: dx / lengthM, z: dz / lengthM } : null;
}

function directionsDiffer(from, to) {
    return Math.abs(from.x * to.z - from.z * to.x) > EPS
        || from.x * to.x + from.z * to.z < 1 - EPS;
}

function miterFrame(incoming, outgoing, miterLimit) {
    let tangentX = incoming.x + outgoing.x;
    let tangentZ = incoming.z + outgoing.z;
    let tangentLength = Math.hypot(tangentX, tangentZ);
    let reverseTurn = false;
    if (tangentLength <= EPS) {
        // An exact reversal has no unique bisector. An intermediate orthogonal
        // diameter splits the half-turn into two non-self-intersecting fans.
        tangentX = -incoming.z;
        tangentZ = incoming.x;
        tangentLength = 1;
        reverseTurn = true;
    }
    tangentX /= tangentLength;
    tangentZ /= tangentLength;
    const rightX = -tangentZ;
    const rightZ = tangentX;
    const outgoingRightX = -outgoing.z;
    const outgoingRightZ = outgoing.x;
    const miterDenominator = Math.abs(
        rightX * outgoingRightX + rightZ * outgoingRightZ,
    );
    const miterScale = reverseTurn
        ? 1
        : Math.min(miterLimit, 1 / Math.max(0.05, miterDenominator));
    return { tangentX, tangentZ, rightX, rightZ, miterScale };
}

function buildRings(samples, {
    maxStepM,
    maxMiterScale,
    transitionLengthM,
    tunnelSection,
    stationSection,
    startContext,
    endContext,
}) {
    const points = cleanAndDensifySamples(samples, maxStepM);
    if (points.length < 2) return { rings: [], endpointFans: [] };
    const directions = [];
    const chainagesM = [0];
    for (let index = 1; index < points.length; index++) {
        const dx = points[index].x - points[index - 1].x;
        const dz = points[index].z - points[index - 1].z;
        const lengthM = Math.hypot(dx, dz);
        directions.push({ x: dx / lengthM, z: dz / lengthM });
        chainagesM.push(chainagesM[index - 1] + lengthM);
    }
    const lengthM = chainagesM[chainagesM.length - 1];
    const transitionM = Math.max(0.1, finite(
        transitionLengthM,
        PHOTO_COVERED_STATION_TRANSITION_M,
    ));
    const miterLimit = Math.max(1, finite(maxMiterScale, 2));
    // Context points do not extend longitudinal ownership. They define an
    // explicit endpoint corner fan; the actual endpoint ring remains
    // perpendicular to the owned segment so the following span cannot cross.
    const startIncoming = horizontalDirection(startContext, points[0]);
    const endOutgoing = horizontalDirection(points[points.length - 1], endContext);

    const rings = points.map((point, index) => {
        const incoming = index === 0
            ? startIncoming || directions[0]
            : directions[index - 1];
        const outgoing = index === points.length - 1
            ? endOutgoing || directions[directions.length - 1]
            : directions[index];
        const ownedBoundaryDirection = index === 0 && startIncoming
            ? directions[0]
            : index === points.length - 1 && endOutgoing
                ? directions[directions.length - 1]
                : null;
        let tangentX;
        let tangentZ;
        let rightX;
        let rightZ;
        let miterScale;
        if (ownedBoundaryDirection) {
            tangentX = ownedBoundaryDirection.x;
            tangentZ = ownedBoundaryDirection.z;
            rightX = -tangentZ;
            rightZ = tangentX;
            miterScale = 1;
        } else {
            ({ tangentX, tangentZ, rightX, rightZ, miterScale } = miterFrame(
                incoming,
                outgoing,
                miterLimit,
            ));
        }
        const distanceToEndM = Math.min(chainagesM[index], lengthM - chainagesM[index]);
        const stationFactor = smoothstep01(distanceToEndM / transitionM);
        return {
            ...point,
            chainageM: chainagesM[index],
            tangentX,
            tangentZ,
            rightX: rightX * miterScale,
            rightZ: rightZ * miterScale,
            miterScale,
            ownedBoundaryFrame: !!ownedBoundaryDirection,
            stationFactor,
            section: interpolateSection(tunnelSection, stationSection, stationFactor),
        };
    });
    const endpointFan = ({ boundary, outside, owned, incoming, outgoing, atStart }) => {
        const frame = miterFrame(incoming, outgoing, miterLimit);
        const turn = incoming.x * outgoing.z - incoming.z * outgoing.x;
        return {
            atStart,
            x: boundary.x,
            y: boundary.y,
            z: boundary.z,
            chainageM: boundary.chainageM,
            section: boundary.section,
            outsideRightX: -outside.z,
            outsideRightZ: outside.x,
            ownedRightX: -owned.z,
            ownedRightZ: owned.x,
            miterRightX: frame.rightX * frame.miterScale,
            miterRightZ: frame.rightZ * frame.miterScale,
            // At an exact reversal both sides are exterior; otherwise only
            // the side opposite the turn needs the corner wedge.
            outerSides: Math.abs(turn) <= EPS ? [-1, 1] : [-Math.sign(turn)],
        };
    };
    const endpointFans = [];
    if (startIncoming && directionsDiffer(startIncoming, directions[0])) {
        endpointFans.push(endpointFan({
            boundary: rings[0],
            outside: startIncoming,
            owned: directions[0],
            incoming: startIncoming,
            outgoing: directions[0],
            atStart: true,
        }));
    }
    if (endOutgoing && directionsDiffer(directions[directions.length - 1], endOutgoing)) {
        endpointFans.push(endpointFan({
            boundary: rings[rings.length - 1],
            outside: endOutgoing,
            owned: directions[directions.length - 1],
            incoming: directions[directions.length - 1],
            outgoing: endOutgoing,
            atStart: false,
        }));
    }
    return { rings, endpointFans };
}

function componentRectangle(component, section) {
    if (component === 'floor') {
        return {
            acrossMin: -section.floorHalfWidthM,
            acrossMax: section.floorHalfWidthM,
            yMin: section.floorBottomOffsetM,
            yMax: section.floorTopOffsetM,
        };
    }
    if (component === 'roof') {
        return {
            acrossMin: -section.roofHalfWidthM,
            acrossMax: section.roofHalfWidthM,
            yMin: section.roofBottomOffsetM,
            yMax: section.roofTopOffsetM,
        };
    }
    const side = component === 'left-wall' ? 1 : -1;
    const center = side * section.wallCenterM;
    return {
        acrossMin: center - section.wallThicknessM * 0.5,
        acrossMax: center + section.wallThicknessM * 0.5,
        yMin: section.wallBottomOffsetM,
        yMax: section.wallTopOffsetM,
    };
}

function ringPoint(ring, acrossM, yOffsetM) {
    return [
        ring.x + ring.rightX * acrossM,
        ring.y + yOffsetM,
        ring.z + ring.rightZ * acrossM,
    ];
}

function pushQuad(indices, a, b, c, d) {
    indices.push(a, b, c, a, c, d);
}

function signedTriangleAreaXZ(positions, a, b, c) {
    const ax = positions[a * 3];
    const az = positions[a * 3 + 2];
    const bx = positions[b * 3];
    const bz = positions[b * 3 + 2];
    const cx = positions[c * 3];
    const cz = positions[c * 3 + 2];
    return (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
}

function pushOrientedTriangle(indices, positions, a, b, c, desiredSign = 1) {
    const area = signedTriangleAreaXZ(positions, a, b, c);
    if (area * desiredSign < 0) indices.push(a, c, b);
    else indices.push(a, b, c);
}

function endpointFanPoint(fan, frame, side, acrossM, yOffsetM = 0) {
    const rightX = fan[`${frame}RightX`];
    const rightZ = fan[`${frame}RightZ`];
    return [
        fan.x + rightX * side * acrossM,
        fan.y + yOffsetM,
        fan.z + rightZ * side * acrossM,
    ];
}

function appendEndpointFanPrism(target, fan, component, color) {
    const rectangle = componentRectangle(component, fan.section);
    if (!(rectangle.acrossMin < -EPS && rectangle.acrossMax > EPS)) return;
    const halfWidthM = Math.min(Math.abs(rectangle.acrossMin), rectangle.acrossMax);
    target.endpointFanFaces ||= [];
    for (const side of fan.outerSides) {
        const bottom = rectangle.yMin;
        const top = rectangle.yMax;
        const points = [
            [fan.x, fan.y + bottom, fan.z],
            endpointFanPoint(fan, 'outside', side, halfWidthM, bottom),
            endpointFanPoint(fan, 'miter', side, halfWidthM, bottom),
            endpointFanPoint(fan, 'owned', side, halfWidthM, bottom),
            [fan.x, fan.y + top, fan.z],
            endpointFanPoint(fan, 'outside', side, halfWidthM, top),
            endpointFanPoint(fan, 'miter', side, halfWidthM, top),
            endpointFanPoint(fan, 'owned', side, halfWidthM, top),
        ];
        const vertexStart = target.positions.length / 3;
        for (const point of points) {
            target.positions.push(...point);
            target.colors.push(...color);
        }
        const topTriangles = [];
        for (const [a, b, c] of [[4, 5, 6], [4, 6, 7]]) {
            const before = target.indices.length;
            pushOrientedTriangle(
                target.indices,
                target.positions,
                vertexStart + a,
                vertexStart + b,
                vertexStart + c,
                1,
            );
            topTriangles.push(target.indices.slice(before, before + 3));
        }
        for (const [a, b, c] of [[0, 2, 1], [0, 3, 2]]) {
            pushOrientedTriangle(
                target.indices,
                target.positions,
                vertexStart + a,
                vertexStart + b,
                vertexStart + c,
                -1,
            );
        }
        for (let edge = 0; edge < 4; edge++) {
            const next = (edge + 1) % 4;
            pushQuad(
                target.indices,
                vertexStart + edge,
                vertexStart + next,
                vertexStart + 4 + next,
                vertexStart + 4 + edge,
            );
        }
        target.endpointFanFaces.push({
            component,
            atStart: fan.atStart,
            side,
            vertexStart,
            topTriangles,
        });
    }
}

function fanFrameRing(fan, frame) {
    return {
        x: fan.x,
        y: fan.y,
        z: fan.z,
        rightX: fan[`${frame}RightX`],
        rightZ: fan[`${frame}RightZ`],
        section: fan.section,
    };
}

function appendEndpointOuterWallBand(target, fan, color) {
    for (const side of fan.outerSides) {
        const componentName = side > 0 ? 'left-wall' : 'right-wall';
        const componentIndex = target.components.length;
        appendSolid(target, [
            fanFrameRing(fan, 'outside'),
            fanFrameRing(fan, 'miter'),
            fanFrameRing(fan, 'owned'),
        ], componentName, color);
        target.components[componentIndex].name = `endpoint-${componentName}`;
        target.components[componentIndex].endpointFan = true;
        target.components[componentIndex].atStart = fan.atStart;
    }
}

function appendSolid(target, rings, component, color) {
    const vertexStart = target.positions.length / 3;
    for (const ring of rings) {
        const rectangle = componentRectangle(component, ring.section);
        const corners = [
            [rectangle.acrossMin, rectangle.yMin],
            [rectangle.acrossMax, rectangle.yMin],
            [rectangle.acrossMax, rectangle.yMax],
            [rectangle.acrossMin, rectangle.yMax],
        ];
        for (const [acrossM, yOffsetM] of corners) {
            target.positions.push(...ringPoint(ring, acrossM, yOffsetM));
            target.colors.push(...color);
        }
    }
    for (let ringIndex = 1; ringIndex < rings.length; ringIndex++) {
        const before = vertexStart + (ringIndex - 1) * 4;
        const after = vertexStart + ringIndex * 4;
        for (let edge = 0; edge < 4; edge++) {
            const nextEdge = (edge + 1) % 4;
            pushQuad(
                target.indices,
                before + edge,
                after + edge,
                after + nextEdge,
                before + nextEdge,
            );
        }
    }
    // The adjacent running-tunnel box is independently rebuilt and may meet
    // this ownership boundary at a sharp turn. Caps close both exact boundary
    // sections even before/after that neighbour streams or changes LOD.
    pushQuad(
        target.indices,
        vertexStart,
        vertexStart + 3,
        vertexStart + 2,
        vertexStart + 1,
    );
    const end = vertexStart + (rings.length - 1) * 4;
    pushQuad(target.indices, end, end + 1, end + 2, end + 3);
    target.components.push({
        name: component,
        vertexStart,
        ringCount: rings.length,
        verticesPerRing: 4,
        capped: true,
    });
}

function buildShellGeometry(rings, endpointFans) {
    const shell = {
        positions: [], colors: [], indices: [], components: [], endpointFanFaces: [],
    };
    for (const component of SHELL_COMPONENTS) {
        appendSolid(shell, rings, component.name, component.color);
    }
    for (const fan of endpointFans) {
        appendEndpointFanPrism(shell, fan, 'floor', SHELL_COMPONENTS[0].color);
        appendEndpointFanPrism(shell, fan, 'roof', SHELL_COMPONENTS[3].color);
        appendEndpointOuterWallBand(shell, fan, SHELL_COMPONENTS[1].color);
    }
    return shell;
}

function lightSection(section) {
    return {
        ...section,
        roofHalfWidthM: 0.225,
        roofBottomOffsetM: section.roofBottomOffsetM - 0.24,
        roofTopOffsetM: section.roofBottomOffsetM - 0.12,
    };
}

function buildLightGeometry(rings, endpointFans) {
    const lightRings = rings.map(ring => ({
        ...ring,
        section: lightSection(ring.section),
    }));
    const light = {
        positions: [], colors: [], indices: [], components: [], endpointFanFaces: [],
    };
    appendSolid(light, lightRings, 'roof', [1, 1, 1]);
    for (const fan of endpointFans) {
        appendEndpointFanPrism(
            light,
            { ...fan, section: lightSection(fan.section) },
            'roof',
            [1, 1, 1],
        );
    }
    return light;
}

function appendWallCollider(colliders, from, to, halfAcrossM, minY, maxY) {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const spanM = Math.hypot(dx, dz);
    if (spanM <= EPS) return;
    const yaw = Math.atan2(dx, dz);
    const halfAlongM = spanM * 0.5 + 0.1;
    colliders.push({
        cx: (from.x + to.x) * 0.5,
        cz: (from.z + to.z) * 0.5,
        hx: halfAcrossM,
        hz: halfAlongM,
        sin: Math.sin(yaw),
        cos: Math.cos(yaw),
        minY,
        maxY,
        guard: false,
        reach: Math.hypot(halfAcrossM, halfAlongM) + 0.35,
    });
}

function buildWallColliders(rings, endpointFans) {
    const colliders = [];
    for (let index = 1; index < rings.length; index++) {
        const from = rings[index - 1];
        const to = rings[index];
        for (const side of [-1, 1]) {
            const fromX = from.x + from.rightX * side * from.section.wallCenterM;
            const fromZ = from.z + from.rightZ * side * from.section.wallCenterM;
            const toX = to.x + to.rightX * side * to.section.wallCenterM;
            const toZ = to.z + to.rightZ * side * to.section.wallCenterM;
            const halfAcrossM = Math.max(
                from.section.wallThicknessM,
                to.section.wallThicknessM,
            ) * 0.5;
            appendWallCollider(
                colliders,
                { x: fromX, z: fromZ },
                { x: toX, z: toZ },
                halfAcrossM,
                Math.min(
                    from.y + from.section.wallBottomOffsetM,
                    to.y + to.section.wallBottomOffsetM,
                ),
                Math.max(
                    from.y + from.section.wallTopOffsetM,
                    to.y + to.section.wallTopOffsetM,
                ),
            );
        }
    }
    // Only the exterior side of an endpoint turn has a gap between the
    // adjacent running-tunnel wall and the station-owned perpendicular wall.
    // Mirror the visible outer wall band with two exact collider segments.
    for (const fan of endpointFans || []) {
        const halfAcrossM = fan.section.wallThicknessM * 0.5;
        const minY = fan.y + fan.section.wallBottomOffsetM;
        const maxY = fan.y + fan.section.wallTopOffsetM;
        for (const side of fan.outerSides) {
            const wallCenterM = fan.section.wallCenterM;
            const points = ['outside', 'miter', 'owned'].map(frame => ({
                x: fan.x + fan[`${frame}RightX`] * side * wallCenterM,
                z: fan.z + fan[`${frame}RightZ`] * side * wallCenterM,
            }));
            appendWallCollider(
                colliders,
                points[0],
                points[1],
                halfAcrossM,
                minY,
                maxY,
            );
            appendWallCollider(
                colliders,
                points[1],
                points[2],
                halfAcrossM,
                minY,
                maxY,
            );
        }
    }
    return colliders;
}

function interpolateRingAt(from, to, chainageM) {
    const spanM = to.chainageM - from.chainageM;
    if (spanM <= EPS || chainageM <= from.chainageM + EPS) return { ...from };
    if (chainageM >= to.chainageM - EPS) return { ...to };
    const t = (chainageM - from.chainageM) / spanM;
    const segmentDirection = horizontalDirection(from, to);
    return {
        ...from,
        x: lerp(from.x, to.x, t),
        y: lerp(from.y, to.y, t),
        z: lerp(from.z, to.z, t),
        chainageM,
        // An inserted boundary lies inside this segment, not inside the miter
        // at either original vertex. Letting vertex miter vectors bleed along
        // the segment would bow a supposedly straight platform edge.
        tangentX: segmentDirection?.x ?? lerp(from.tangentX, to.tangentX, t),
        tangentZ: segmentDirection?.z ?? lerp(from.tangentZ, to.tangentZ, t),
        rightX: segmentDirection ? -segmentDirection.z : lerp(from.rightX, to.rightX, t),
        rightZ: segmentDirection ? segmentDirection.x : lerp(from.rightZ, to.rightZ, t),
        miterScale: segmentDirection ? 1 : lerp(from.miterScale, to.miterScale, t),
        stationFactor: lerp(from.stationFactor, to.stationFactor, t),
        section: interpolateSection(from.section, to.section, t),
    };
}

function ringAtChainage(rings, chainageM) {
    const bounded = Math.max(0, Math.min(rings[rings.length - 1].chainageM, chainageM));
    for (let index = 1; index < rings.length; index++) {
        if (bounded <= rings[index].chainageM + EPS) {
            return interpolateRingAt(rings[index - 1], rings[index], bounded);
        }
    }
    return { ...rings[rings.length - 1] };
}

function sliceRings(rings, startM, endM) {
    if (rings.length < 2 || endM - startM <= EPS) return [];
    const sliced = [ringAtChainage(rings, startM)];
    for (const ring of rings) {
        if (ring.chainageM > startM + EPS && ring.chainageM < endM - EPS) {
            sliced.push({ ...ring });
        }
    }
    sliced.push(ringAtChainage(rings, endM));
    return sliced;
}

function closestChainageM(rings, point) {
    const x = finite(point?.x);
    const z = finite(point?.z);
    if (x == null || z == null) return rings[rings.length - 1].chainageM * 0.5;
    let bestDistanceSq = Infinity;
    let bestChainageM = 0;
    for (let index = 1; index < rings.length; index++) {
        const from = rings[index - 1];
        const to = rings[index];
        const dx = to.x - from.x;
        const dz = to.z - from.z;
        const lengthSq = dx * dx + dz * dz;
        const t = lengthSq > EPS
            ? Math.max(0, Math.min(1, ((x - from.x) * dx + (z - from.z) * dz) / lengthSq))
            : 0;
        const qx = from.x + dx * t - x;
        const qz = from.z + dz * t - z;
        const distanceSq = qx * qx + qz * qz;
        if (distanceSq >= bestDistanceSq) continue;
        bestDistanceSq = distanceSq;
        bestChainageM = lerp(from.chainageM, to.chainageM, t);
    }
    return bestChainageM;
}

function offsetFloorRings(rings, centerAcrossM, halfWidthM, bottomOffsetM, topOffsetM) {
    return rings.map(ring => ({
        ...ring,
        x: ring.x + ring.rightX * centerAcrossM,
        z: ring.z + ring.rightZ * centerAcrossM,
        section: {
            ...ring.section,
            floorHalfWidthM: halfWidthM,
            floorBottomOffsetM: bottomOffsetM,
            floorTopOffsetM: topOffsetM,
        },
    }));
}

function buildNameBoardGeometry(rings, {
    sideSign,
    centerM,
    platformStartM,
    platformEndM,
    lengthM,
    label,
}) {
    const boardLengthM = Math.min(
        platformEndM - platformStartM,
        Math.max(2, finite(lengthM, 8)),
    );
    const startM = Math.max(platformStartM, centerM - boardLengthM * 0.5);
    const endM = Math.min(platformEndM, startM + boardLengthM);
    const boardRings = sliceRings(rings, startM, endM);
    if (boardRings.length < 2) return null;
    const bottomOffsetM = 2.15;
    const topOffsetM = 3.15;
    const positions = [];
    const uvs = [];
    const indices = [];
    for (const ring of boardRings) {
        const insideWallM = sideSign * (
            ring.section.wallCenterM - ring.section.wallThicknessM * 0.5 - 0.035
        );
        const x = ring.x + ring.rightX * insideWallM;
        const z = ring.z + ring.rightZ * insideWallM;
        positions.push(
            x, ring.y + bottomOffsetM, z,
            x, ring.y + topOffsetM, z,
        );
        const u = endM - startM > EPS ? (ring.chainageM - startM) / (endM - startM) : 0;
        uvs.push(u, 0, u, 1);
    }
    for (let index = 1; index < boardRings.length; index++) {
        const before = (index - 1) * 2;
        const after = index * 2;
        if (sideSign > 0) pushQuad(indices, before, before + 1, after + 1, after);
        else pushQuad(indices, before, after, after + 1, before + 1);
    }
    const stationLabel = String(label || 'Station').trim().slice(0, 28) || 'Station';
    return {
        positions,
        uvs,
        indices,
        label: stationLabel,
        startM,
        endM,
        ringCount: boardRings.length,
    };
}

function buildPlatformGeometry(rings, platform) {
    const sideM = finite(platform?.sideM);
    const widthM = Math.max(0, finite(platform?.widthM, 0));
    const heightM = Math.max(0, finite(platform?.heightM, 0));
    const requestedLengthM = Math.max(0, finite(platform?.lengthM, 0));
    if (sideM == null || widthM <= EPS || heightM <= EPS || requestedLengthM <= EPS) {
        return { platform: null, identity: null, nameBoard: null, layout: null };
    }
    const routeLengthM = rings[rings.length - 1].chainageM;
    const lengthM = Math.min(routeLengthM, requestedLengthM);
    if (lengthM <= EPS) {
        return { platform: null, identity: null, nameBoard: null, layout: null };
    }
    const desiredCenterM = closestChainageM(rings, platform.center);
    const centerM = Math.max(lengthM * 0.5, Math.min(
        routeLengthM - lengthM * 0.5,
        desiredCenterM,
    ));
    const startM = centerM - lengthM * 0.5;
    const endM = centerM + lengthM * 0.5;
    const platformRings = sliceRings(rings, startM, endM);
    if (platformRings.length < 2) {
        return { platform: null, identity: null, nameBoard: null, layout: null };
    }

    const slabBottomM = finite(platform?.bottomOffsetM, -0.05);
    const slabRings = offsetFloorRings(
        platformRings,
        sideM,
        widthM * 0.5,
        slabBottomM,
        heightM,
    );
    const platformGeometry = { positions: [], colors: [], indices: [], components: [] };
    appendSolid(platformGeometry, slabRings, 'floor', [0.46, 0.47, 0.46]);
    platformGeometry.components[0].name = 'route-platform';

    // A canonical track-side tactile strip is the compact station's identity:
    // it remains visibly a boarding place without resurrecting the legacy
    // tangent-aligned canopy/sign/stair group that mangled curved stations.
    const sideSign = Math.sign(sideM) || 1;
    const stripWidthM = Math.min(widthM, Math.max(0.18, finite(platform?.edgeWidthM, 0.36)));
    const trackSideEdgeM = sideM - sideSign * widthM * 0.5;
    const stripCenterM = trackSideEdgeM + sideSign * stripWidthM * 0.5;
    const edgeBottomM = heightM + 0.012;
    const edgeRings = offsetFloorRings(
        platformRings,
        stripCenterM,
        stripWidthM * 0.5,
        edgeBottomM,
        edgeBottomM + 0.045,
    );
    const identityGeometry = { positions: [], colors: [], indices: [], components: [] };
    appendSolid(identityGeometry, edgeRings, 'floor', [0.95, 0.72, 0.08]);
    identityGeometry.components[0].name = 'tactile-station-edge';
    const nameBoard = buildNameBoardGeometry(rings, {
        sideSign,
        centerM,
        platformStartM: startM,
        platformEndM: endM,
        lengthM: platform?.nameBoardLengthM,
        label: platform?.label,
    });
    return {
        platform: platformGeometry,
        identity: identityGeometry,
        nameBoard,
        layout: {
            sideM,
            widthM,
            heightM,
            lengthM,
            startM,
            endM,
            centerM,
            trackSideEdgeM,
        },
    };
}

export function buildPhotoCoveredStationSweep(samples, {
    maxStepM = PHOTO_COVERED_STATION_SAMPLE_STEP_M,
    maxMiterScale = 2,
    transitionLengthM = PHOTO_COVERED_STATION_TRANSITION_M,
    tunnelSection = PHOTO_RUNNING_TUNNEL_SECTION,
    stationSection = PHOTO_COVERED_STATION_SECTION,
    startContext = null,
    endContext = null,
    platform = null,
} = {}) {
    const { rings, endpointFans } = buildRings(samples, {
        maxStepM,
        maxMiterScale,
        transitionLengthM,
        tunnelSection,
        stationSection,
        startContext,
        endContext,
    });
    if (rings.length < 2) return null;
    const platformData = buildPlatformGeometry(rings, platform);
    return {
        rings,
        endpointFans,
        lengthM: rings[rings.length - 1].chainageM,
        shell: buildShellGeometry(rings, endpointFans),
        light: buildLightGeometry(rings, endpointFans),
        wallColliders: buildWallColliders(rings, endpointFans),
        platform: platformData.platform,
        identity: platformData.identity,
        nameBoard: platformData.nameBoard,
        platformLayout: platformData.layout,
    };
}

function maskPoint(ring, side, halfWidthM) {
    return [
        ring.x + ring.rightX * side * halfWidthM,
        0,
        ring.z + ring.rightZ * side * halfWidthM,
    ];
}

function signedPointTriangleAreaXZ(points) {
    const [a, b, c] = points;
    return (b[0] - a[0]) * (c[1] - a[1])
        - (b[1] - a[1]) * (c[0] - a[0]);
}

function appendOwnershipTriangle(target, points, trackYs, roofYs, metadata) {
    const area = signedPointTriangleAreaXZ(points);
    if (Math.abs(area) <= EPS) return;
    if (area < 0) {
        [points[1], points[2]] = [points[2], points[1]];
        [trackYs[1], trackYs[2]] = [trackYs[2], trackYs[1]];
        [roofYs[1], roofYs[2]] = [roofYs[2], roofYs[1]];
    }
    target.push({ ...metadata, points, trackYs, roofYs });
}

function appendEndpointOwnershipTriangles(target, fan, halfWidthM) {
    const trackY = fan.y;
    const roofY = fan.y + fan.section.sourceRoofOffsetM;
    for (const side of fan.outerSides) {
        const center = [fan.x, fan.z];
        const outside = endpointFanPoint(fan, 'outside', side, halfWidthM);
        const miter = endpointFanPoint(fan, 'miter', side, halfWidthM);
        const owned = endpointFanPoint(fan, 'owned', side, halfWidthM);
        const a = [outside[0], outside[2]];
        const m = [miter[0], miter[2]];
        const b = [owned[0], owned[2]];
        appendOwnershipTriangle(
            target,
            [[...center], a, m],
            [trackY, trackY, trackY],
            [roofY, roofY, roofY],
            { kind: 'endpoint-fan', atStart: fan.atStart, side },
        );
        appendOwnershipTriangle(
            target,
            [[...center], m, b],
            [trackY, trackY, trackY],
            [roofY, roofY, roofY],
            { kind: 'endpoint-fan', atStart: fan.atStart, side },
        );
    }
}

// This primitive list is the single ownership topology used by both the GPU
// source mask and the CPU ghost-ground query. Endpoint turns are explicit
// center fans; no full-width outside-to-miter quad can fold into a bow-tie.
export function buildPhotoCoveredStationOwnershipTriangles(sweep, {
    halfWidthM = PHOTO_COVERED_STATION_MASK_HALF_WIDTH_M,
} = {}) {
    const widthM = Math.max(
        0.1,
        finite(halfWidthM, PHOTO_COVERED_STATION_MASK_HALF_WIDTH_M),
    );
    const triangles = [];
    const rings = sweep?.rings || [];
    const endpointFans = sweep?.endpointFans || [];
    for (const fan of endpointFans) {
        if (fan.atStart) appendEndpointOwnershipTriangles(triangles, fan, widthM);
    }
    for (let index = 1; index < rings.length; index++) {
        const from = rings[index - 1];
        const to = rings[index];
        const fromLeft = maskPoint(from, 1, widthM);
        const fromRight = maskPoint(from, -1, widthM);
        const toLeft = maskPoint(to, 1, widthM);
        const toRight = maskPoint(to, -1, widthM);
        const a = [fromLeft[0], fromLeft[2]];
        const b = [fromRight[0], fromRight[2]];
        const c = [toRight[0], toRight[2]];
        const d = [toLeft[0], toLeft[2]];
        const fromRoofY = from.y + from.section.sourceRoofOffsetM;
        const toRoofY = to.y + to.section.sourceRoofOffsetM;
        appendOwnershipTriangle(
            triangles,
            [a, b, c],
            [from.y, from.y, to.y],
            [fromRoofY, fromRoofY, toRoofY],
            { kind: 'route-span', spanIndex: index - 1 },
        );
        appendOwnershipTriangle(
            triangles,
            [[...a], [...c], d],
            [from.y, to.y, to.y],
            [fromRoofY, toRoofY, toRoofY],
            { kind: 'route-span', spanIndex: index - 1 },
        );
    }
    for (const fan of endpointFans) {
        if (!fan.atStart) appendEndpointOwnershipTriangles(triangles, fan, widthM);
    }
    return triangles;
}

export function buildPhotoCoveredStationMaskData(sweep, {
    halfWidthM = PHOTO_COVERED_STATION_MASK_HALF_WIDTH_M,
    tunnelSourceRoofOffsetM = PHOTO_RUNNING_TUNNEL_SECTION.sourceRoofOffsetM,
    encodeFloor,
} = {}) {
    const encode = typeof encodeFloor === 'function' ? encodeFloor : () => 0;
    const positions = [];
    const colors = [];
    const triangles = buildPhotoCoveredStationOwnershipTriangles(sweep, { halfWidthM });
    for (const triangle of triangles) {
        for (let vertex = 0; vertex < 3; vertex++) {
            positions.push(triangle.points[vertex][0], 0, triangle.points[vertex][1]);
            colors.push(
                1,
                1,
                encode(triangle.roofYs[vertex] - tunnelSourceRoofOffsetM),
            );
        }
    }
    return { positions, colors };
}

function triangleBarycentric(px, pz, a, b, c) {
    const denominator = (b[1] - c[1]) * (a[0] - c[0])
        + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(denominator) <= EPS) return null;
    const aWeight = ((b[1] - c[1]) * (px - c[0])
        + (c[0] - b[0]) * (pz - c[1])) / denominator;
    const bWeight = ((c[1] - a[1]) * (px - c[0])
        + (a[0] - c[0]) * (pz - c[1])) / denominator;
    const cWeight = 1 - aWeight - bWeight;
    if (aWeight < -EPS || bWeight < -EPS || cWeight < -EPS) return null;
    return [aWeight, bWeight, cWeight];
}

function interpolateTrianglePayload(weights, a, b, c) {
    return weights[0] * a + weights[1] * b + weights[2] * c;
}

export function photoCoveredStationOwnershipAt(sweep, x, z, {
    halfWidthM = PHOTO_COVERED_STATION_MASK_HALF_WIDTH_M,
} = {}) {
    const px = finite(x);
    const pz = finite(z);
    if (px == null || pz == null) return null;
    let ownership = null;
    const triangles = buildPhotoCoveredStationOwnershipTriangles(sweep, { halfWidthM });
    for (const triangle of triangles) {
        const weights = triangleBarycentric(
            px,
            pz,
            triangle.points[0],
            triangle.points[1],
            triangle.points[2],
        );
        if (!weights) continue;
        ownership = {
            trackY: interpolateTrianglePayload(weights, ...triangle.trackYs),
            roofY: interpolateTrianglePayload(weights, ...triangle.roofYs),
        };
    }
    // The station mask material has depth disabled, so later primitives are
    // authoritative in both the GPU render and this CPU query.
    return ownership;
}
