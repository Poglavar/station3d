// Pure catenary span ownership, geometry staging, and streaming-cell selection.

export const ELECTRIFICATION_CELL_M = 600;
export const ELECTRIFICATION_PRELOAD_M = 1800;
export const ELECTRIFICATION_ACTIVE_M = 1500;
export const ELECTRIFICATION_EVICT_M = 2400;
export const ELECTRIFICATION_MAX_CELLS = 36;
export const SUPPORT_SPACING_M = 40;
export const CONTACT_HEIGHT_M = 5.5;
export const MESSENGER_HEIGHT_M = 6.5;
export const DROPPER_SPACING_M = 8;

// Dense street-running Zagreb spans commonly hang from facade-to-facade wires.
// This layer does not own building attachment points, so road-shared spans keep
// the contact wire continuous but add a physical pole only every third 40 m bay.
const ZAGREB_TRAM_POLE_INTERVAL_BAYS = 3;
const TRAM_SIDE_MAST_EDGE_GAP_M = 0.7;
const TRAM_SIDE_MAST_SEARCH_STEP_M = 0.75;
const TRAM_SIDE_MAST_SEARCH_M = 12;
const TRAM_CROSSARM_OVERHANG_M = 0.45;
const TRAM_PAIR_MIN_SPACING_M = 1.8;
const TRAM_PAIR_MAX_SPACING_M = 5.5;

function interpolate(a, b, t) {
    return a + (b - a) * t;
}

function distance2d(a, b) {
    return Math.hypot(Number(a.x) - Number(b.x), Number(a.z) - Number(b.z));
}

function headingDeltaDeg(left, right) {
    const delta = Math.abs((Number(left) - Number(right)) * 180 / Math.PI) % 180;
    return Math.min(delta, 180 - delta);
}

export function cellKeyAt(x, z, cellM = ELECTRIFICATION_CELL_M) {
    return `${Math.floor(Number(x) / cellM)}:${Math.floor(Number(z) / cellM)}`;
}

export function cellCenter(key, cellM = ELECTRIFICATION_CELL_M) {
    const [x, z] = String(key).split(':').map(Number);
    return { x: (x + 0.5) * cellM, z: (z + 0.5) * cellM };
}

export function electrificationCellKeysTouchingBounds(
    cellKeys,
    bounds,
    { paddingM = 0, cellM = ELECTRIFICATION_CELL_M } = {},
) {
    const regions = (Array.isArray(bounds) ? bounds : []).filter(region => (
        Number.isFinite(region?.minX)
        && Number.isFinite(region?.maxX)
        && Number.isFinite(region?.minZ)
        && Number.isFinite(region?.maxZ)
    ));
    const padding = Math.max(0, Number(paddingM) || 0);
    return [...(cellKeys || [])].filter((key) => {
        const [cellX, cellZ] = String(key).split(':').map(Number);
        if (!Number.isFinite(cellX) || !Number.isFinite(cellZ)) return false;
        const minX = cellX * cellM;
        const maxX = minX + cellM;
        const minZ = cellZ * cellM;
        const maxZ = minZ + cellM;
        return regions.some(region => (
            region.maxX + padding >= minX
            && region.minX - padding <= maxX
            && region.maxZ + padding >= minZ
            && region.minZ - padding <= maxZ
        ));
    });
}

function featureIdentity(segment) {
    const properties = segment?.feature?.properties || segment?.properties || {};
    return properties.osmId || properties.osm_id || properties.trackId
        || properties.lineId || segment?.sortKey || 'track';
}

function trackOffsetsAt(segment, t) {
    const start = Array.isArray(segment.startTrackCenterOffsetsM)
        ? segment.startTrackCenterOffsetsM
        : [0];
    const end = Array.isArray(segment.endTrackCenterOffsetsM)
        ? segment.endTrackCenterOffsetsM
        : start;
    const count = Math.max(start.length, end.length, 1);
    return Array.from({ length: count }, (_, index) => interpolate(
        Number(start[index] ?? start.at(-1) ?? 0),
        Number(end[index] ?? end.at(-1) ?? 0),
        t,
    ));
}

function signatureNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric.toFixed(6) : '-';
}

function signatureArray(values) {
    return Array.isArray(values)
        ? values.map(signatureNumber).join(',')
        : '-';
}

// The scene layer compares these signatures before scheduling a replacement.
// Object identity is deliberately irrelevant: rail streaming often republishes
// equivalent segment objects while terrain settles. Every field consumed by
// stageCellGeometry is included, so a real height/shape change still rebuilds.
export function electrificationCellSignature(spans = []) {
    return (Array.isArray(spans) ? spans : []).map((span) => {
        const segment = span?.segment || {};
        return [
            String(span?.ownerKey || ''),
            signatureNumber(span?.fromM),
            signatureNumber(span?.toM),
            signatureNumber(span?.fromT),
            signatureNumber(span?.toT),
            span?.tunnel ? '1' : '0',
            String(span?.trackMode || ''),
            String(span?.locationId || ''),
            signatureNumber(segment.len),
            signatureNumber(segment.uStart),
            signatureNumber(segment.x1),
            signatureNumber(segment.yStart),
            signatureNumber(segment.z1),
            signatureNumber(segment.x2),
            signatureNumber(segment.yEnd),
            signatureNumber(segment.z2),
            signatureNumber(segment.startJoinX),
            signatureNumber(segment.startJoinZ),
            signatureNumber(segment.endJoinX),
            signatureNumber(segment.endJoinZ),
            signatureNumber(segment.angle),
            signatureArray(segment.startTrackCenterOffsetsM),
            signatureArray(segment.endTrackCenterOffsetsM),
            signatureNumber(segment.startTrackbedHalfWidthM),
            signatureNumber(segment.endTrackbedHalfWidthM),
            segment?._embeddedRoadSupport?.start ? 'road-start' : '-',
            segment?._embeddedRoadSupport?.end ? 'road-end' : '-',
        ].join('/');
    }).sort().join('|');
}

// A cell stages its own wires plus support candidates from the eight-cell
// halo. Include those signatures in its build token so a changed neighbour
// replaces only the cells whose published geometry can actually differ.
export function electrificationNeighborhoodSignature(key, signatures) {
    const [cellX, cellZ] = String(key).split(':').map(Number);
    const parts = [];
    for (let z = cellZ - 1; z <= cellZ + 1; z++) {
        for (let x = cellX - 1; x <= cellX + 1; x++) {
            const neighborKey = `${x}:${z}`;
            parts.push(`${neighborKey}=${signatures?.get?.(neighborKey) || ''}`);
        }
    }
    return parts.join(';');
}

export function createChangedElectrificationCellKeysTask(
    previousSignatures = new Map(),
    nextSignatures = new Map(),
    { keysPerStep = 16 } = {},
) {
    const candidates = new Set();
    const previousIterator = previousSignatures.keys();
    const nextIterator = nextSignatures.keys();
    const changed = [];
    const chunkSize = Math.max(1, Math.floor(Number(keysPerStep) || 16));
    let candidateIterator = null;
    let phase = 'collect-previous';
    let compared = 0;

    const collect = (iterator) => {
        for (let count = 0; count < chunkSize; count++) {
            const entry = iterator.next();
            if (entry.done) return true;
            candidates.add(entry.value);
        }
        return false;
    };

    return {
        phaseLabel() {
            if (phase === 'compare') return `cell diff ${compared}/${candidates.size}`;
            return `cell diff ${phase}`;
        },
        step() {
            if (phase === 'collect-previous') {
                if (collect(previousIterator)) phase = 'collect-next';
                return { done: false, value: null };
            }
            if (phase === 'collect-next') {
                if (collect(nextIterator)) {
                    candidateIterator = candidates.values();
                    phase = 'compare';
                }
                return { done: false, value: null };
            }
            if (phase === 'compare') {
                for (let count = 0; count < chunkSize; count++) {
                    const entry = candidateIterator.next();
                    if (entry.done) {
                        phase = 'done';
                        return { done: true, value: changed };
                    }
                    const key = entry.value;
                    if (electrificationNeighborhoodSignature(key, previousSignatures)
                        !== electrificationNeighborhoodSignature(key, nextSignatures)) {
                        changed.push(key);
                    }
                    compared += 1;
                }
                return { done: false, value: null };
            }
            return { done: true, value: changed };
        },
    };
}

export function changedElectrificationCellKeys(
    previousSignatures = new Map(),
    nextSignatures = new Map(),
) {
    const task = createChangedElectrificationCellKeysTask(
        previousSignatures,
        nextSignatures,
    );
    let outcome = task.step();
    while (!outcome.done) outcome = task.step();
    return outcome.value;
}

function pointAt(segment, t, offsetM = 0, heightM = 0) {
    const joinX = interpolate(segment.startJoinX, segment.endJoinX, t);
    const joinZ = interpolate(segment.startJoinZ, segment.endJoinZ, t);
    return {
        x: interpolate(segment.x1, segment.x2, t) + joinX * offsetM,
        y: interpolate(segment.yStart, segment.yEnd, t) + heightM,
        z: interpolate(segment.z1, segment.z2, t) + joinZ * offsetM,
    };
}

function isTunnelSegment(segment) {
    const properties = segment?.properties || segment?.feature?.properties || {};
    const tags = properties.tags || {};
    const explicit = properties.tunnel ?? tags.tunnel;
    if (explicit && explicit !== 'no' && explicit !== 'building_passage') return true;
    return segment.structureStart === 'tunnel'
        && segment.structureEnd === 'tunnel';
}

function resolvedAt(segment, chainageM, resolver, locationId) {
    const properties = segment?.properties || segment?.feature?.properties || {};
    const trackMode = typeof resolver?.trackModeFor === 'function'
        ? resolver.trackModeFor(properties)
        : '';
    if (typeof resolver?.resolveAtDistance === 'function') {
        return {
            ...resolver.resolveAtDistance(properties, chainageM, {
            locationId,
            trackMode,
            provenance: properties.source === 'user' || properties.source === 'reference-project'
                ? 'authored'
                : 'osm',
            }),
            trackMode,
        };
    }
    return { status: 'unknown', trackMode };
}

function appendOwnedElectrificationSpans(cells, segment, resolver, locationId) {
    if (!(Number(segment?.len) > 0)) return;
    const sourceStartM = Number(segment.uStart) || 0;
    const sourceEndM = sourceStartM + Number(segment.len);
    const cuts = [sourceStartM, sourceEndM];
    for (
        let stationM = Math.ceil(sourceStartM / SUPPORT_SPACING_M) * SUPPORT_SPACING_M;
        stationM < sourceEndM;
        stationM += SUPPORT_SPACING_M
    ) cuts.push(stationM);
    cuts.sort((left, right) => left - right);
    for (let index = 1; index < cuts.length; index++) {
        const fromM = cuts[index - 1];
        const toM = cuts[index];
        if (!(toM > fromM + 1e-6)) continue;
        const middleM = (fromM + toM) * 0.5;
        const resolved = resolvedAt(segment, middleM, resolver, locationId);
        if (resolved.status !== 'overhead') continue;
        const fromT = (fromM - sourceStartM) / segment.len;
        const toT = (toM - sourceStartM) / segment.len;
        const midpoint = pointAt(segment, (fromT + toT) * 0.5);
        const key = cellKeyAt(midpoint.x, midpoint.z);
        const list = cells.get(key) || [];
        list.push({
            segment,
            fromM,
            toM,
            fromT,
            toT,
            tunnel: isTunnelSegment(segment),
            trackMode: resolved.trackMode,
            locationId,
            // The span's midpoint in scene coordinates. Already computed
            // just above to pick the cell, and carried because the halo
            // pass needs it to find the nearest span in each neighbouring
            // cell. It used to read span.start.x / span.end.x — fields no
            // span has ever had — so every halo query threw and the whole
            // electrification layer failed and retried forever.
            midX: midpoint.x,
            midZ: midpoint.z,
            ownerKey: `${featureIdentity(segment)}:${middleM.toFixed(3)}`,
        });
        cells.set(key, list);
    }
}

// Builds span ownership without one citywide synchronous pass. A scene layer
// can advance this task from its frame queue and atomically publish `value`
// only after every source chord has been visited.
export function createOwnedElectrificationSpansTask(
    segments,
    resolver,
    { locationId = 'zagreb', segmentsPerStep = 32 } = {},
) {
    const source = Array.isArray(segments) ? segments : [];
    const cells = new Map();
    const chunkSize = Math.max(1, Math.floor(Number(segmentsPerStep) || 32));
    let index = 0;
    return {
        phaseLabel: () => `span ownership ${Math.min(index, source.length)}/${source.length}`,
        step() {
            const end = Math.min(source.length, index + chunkSize);
            while (index < end) {
                appendOwnedElectrificationSpans(
                    cells,
                    source[index],
                    resolver,
                    locationId,
                );
                index += 1;
            }
            return index >= source.length
                ? { done: true, value: cells }
                : { done: false, value: null };
        },
    };
}

export function ownedElectrificationSpans(
    segments,
    resolver,
    options = {},
) {
    const task = createOwnedElectrificationSpansTask(
        segments,
        resolver,
        options,
    );
    let outcome = task.step();
    while (!outcome.done) outcome = task.step();
    return outcome.value;
}

function pushLine(positions, start, end) {
    positions.push(start.x, start.y, start.z, end.x, end.y, end.z);
}

function messengerPoint(span, t, offsetM) {
    const spanT = interpolate(span.fromT, span.toT, t);
    const shallowSagM = 0.16 * 4 * t * (1 - t);
    return pointAt(span.segment, spanT, offsetM, MESSENGER_HEIGHT_M - shallowSagM);
}

function averagePoint(points) {
    const list = Array.isArray(points) ? points.filter(Boolean) : [];
    if (list.length === 0) return { x: 0, y: 0, z: 0 };
    return {
        x: list.reduce((sum, point) => sum + Number(point.x), 0) / list.length,
        y: Math.max(...list.map(point => Number(point.y) || 0)),
        z: list.reduce((sum, point) => sum + Number(point.z), 0) / list.length,
    };
}

function uniquePoints(points) {
    const unique = [];
    for (const point of points || []) {
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.z)) continue;
        if (unique.some(existing => distance2d(existing, point) < 0.05)) continue;
        unique.push({ ...point });
    }
    return unique;
}

function farthestPointPair(points) {
    const list = uniquePoints(points);
    let pair = null;
    for (let left = 0; left < list.length; left += 1) {
        for (let right = left + 1; right < list.length; right += 1) {
            const distanceM = distance2d(list[left], list[right]);
            if (!pair || distanceM > pair.distanceM) {
                pair = { left: list[left], right: list[right], distanceM };
            }
        }
    }
    return pair;
}

function pointIsRoadbed(point, roadbedAt) {
    return typeof roadbedAt === 'function' && roadbedAt(point.x, point.z) === true;
}

function roadbedCrossesPoints(points, roadbedAt) {
    if (typeof roadbedAt !== 'function') return false;
    const list = uniquePoints(points);
    if (list.some(point => pointIsRoadbed(point, roadbedAt))) return true;
    const pair = farthestPointPair(list);
    if (!pair) return false;
    const samples = Math.max(1, Math.ceil(pair.distanceM / 0.75));
    for (let index = 1; index < samples; index += 1) {
        const t = index / samples;
        if (pointIsRoadbed({
            x: interpolate(pair.left.x, pair.right.x, t),
            z: interpolate(pair.left.z, pair.right.z, t),
        }, roadbedAt)) return true;
    }
    return false;
}

function isZagrebTramSpan(span) {
    return String(span?.locationId || '').toLowerCase() === 'zagreb'
        && String(span?.trackMode || '').toLowerCase() === 'tram';
}

function hasEmbeddedRoadSupport(segment) {
    const support = segment?._embeddedRoadSupport;
    return !!(support?.start || support?.end);
}

function sideLGeometry(mastPoint, wirePoints) {
    let farthest = null;
    for (const wirePoint of wirePoints || []) {
        const distanceM = distance2d(mastPoint, wirePoint);
        if (!farthest || distanceM > farthest.distanceM) {
            farthest = { point: wirePoint, distanceM };
        }
    }
    if (!farthest || farthest.distanceM <= 1e-6) {
        return {
            profile: 'tram-side-l',
            mastPoints: [{ ...mastPoint }],
            crossarmCenter: { ...mastPoint },
            crossarmWidthM: 0.8,
            crossarmRotationY: 0,
        };
    }
    const ux = (farthest.point.x - mastPoint.x) / farthest.distanceM;
    const uz = (farthest.point.z - mastPoint.z) / farthest.distanceM;
    const widthM = farthest.distanceM + TRAM_CROSSARM_OVERHANG_M;
    return {
        profile: 'tram-side-l',
        mastPoints: [{ ...mastPoint }],
        crossarmCenter: {
            x: mastPoint.x + ux * widthM * 0.5,
            y: Math.max(Number(mastPoint.y) || 0, Number(farthest.point.y) || 0),
            z: mastPoint.z + uz * widthM * 0.5,
        },
        crossarmWidthM: widthM,
        crossarmRotationY: Math.atan2(-uz, ux),
    };
}

function centreTGeometry(wirePoints) {
    const pair = farthestPointPair(wirePoints);
    if (!pair) return null;
    const centre = {
        x: (pair.left.x + pair.right.x) * 0.5,
        y: Math.max(Number(pair.left.y) || 0, Number(pair.right.y) || 0),
        z: (pair.left.z + pair.right.z) * 0.5,
    };
    const ux = (pair.right.x - pair.left.x) / pair.distanceM;
    const uz = (pair.right.z - pair.left.z) / pair.distanceM;
    return {
        profile: 'tram-centre-t',
        mastPoints: [{ ...centre }],
        crossarmCenter: { ...centre },
        crossarmWidthM: Math.max(
            4.2,
            pair.distanceM + TRAM_CROSSARM_OVERHANG_M * 2,
        ),
        crossarmRotationY: Math.atan2(-uz, ux),
    };
}

function clearTramMastPoint(
    span,
    offsetM,
    supportClearance,
    roadbedAt,
) {
    const point = pointAt(span.segment, span.fromT, offsetM, 0);
    if (pointIsRoadbed(point, roadbedAt)) return null;
    const score = typeof supportClearance === 'function'
        ? Number(supportClearance(point.x, point.z))
        : 0;
    if (Number.isNaN(score) || score < 0) return null;
    return { ...point, clearance: score };
}

function completedSupportTask(candidate = null, label = 'support decision') {
    const outcome = { done: true, value: candidate, phase: 'complete' };
    return {
        phaseLabel: () => label,
        step: () => outcome,
    };
}

function createTramSupportCandidateTask(span, supportClearance, roadbedAt) {
    const offsets = trackOffsetsAt(span.segment, span.fromT);
    const wirePoints = uniquePoints(offsets.map(offsetM => (
        pointAt(span.segment, span.fromT, offsetM, 0)
    )));
    const phaseIndex = Math.round(span.fromM / SUPPORT_SPACING_M);
    const roadShared = hasEmbeddedRoadSupport(span.segment)
        || roadbedCrossesPoints(wirePoints, roadbedAt);
    if (roadShared && phaseIndex % ZAGREB_TRAM_POLE_INTERVAL_BAYS !== 0) {
        return completedSupportTask(null, 'sparse tram support decision');
    }

    const pair = farthestPointPair(wirePoints);
    if (!roadShared && wirePoints.length === 2
        && pair?.distanceM >= TRAM_PAIR_MIN_SPACING_M
        && pair.distanceM <= TRAM_PAIR_MAX_SPACING_M) {
        const geometry = centreTGeometry(wirePoints);
        const anchor = averagePoint(wirePoints);
        return completedSupportTask({
            ...anchor,
            ...geometry,
            heading: Number(span.segment.angle) || 0,
            supportKey: `${featureIdentity(span.segment)}:${phaseIndex}`,
            wirePoints,
            roadShared: false,
            zagrebTram: true,
        }, 'centre tram support');
    }

    const halfWidthM = Math.max(
        Number(span.segment.startTrackbedHalfWidthM) || 1.5,
        Number(span.segment.endTrackbedHalfWidthM) || 1.5,
        ...offsets.map(Math.abs),
    );
    const normalSide = phaseIndex % 2 === 0 ? -1 : 1;
    const firstOffsetM = halfWidthM + TRAM_SIDE_MAST_EDGE_GAP_M;
    const probeOffsetsM = [];
    for (const side of [normalSide, -normalSide]) {
        for (
            let distanceM = firstOffsetM;
            distanceM <= firstOffsetM + TRAM_SIDE_MAST_SEARCH_M + 1e-6;
            distanceM += TRAM_SIDE_MAST_SEARCH_STEP_M
        ) probeOffsetsM.push(side * distanceM);
    }

    let probeIndex = 0;
    let completedOutcome = null;
    return {
        phaseLabel: () => (
            `tram mast clearance ${Math.min(probeIndex + 1, probeOffsetsM.length)}`
            + `/${probeOffsetsM.length}`
        ),
        step() {
            if (completedOutcome) return completedOutcome;
            const mastPoint = clearTramMastPoint(
                span,
                probeOffsetsM[probeIndex],
                supportClearance,
                roadbedAt,
            );
            probeIndex += 1;
            if (mastPoint) {
                const anchor = averagePoint(wirePoints);
                completedOutcome = {
                    done: true,
                    value: {
                        ...anchor,
                        ...sideLGeometry(mastPoint, wirePoints),
                        heading: Number(span.segment.angle) || 0,
                        supportKey: `${featureIdentity(span.segment)}:${phaseIndex}`,
                        wirePoints,
                        roadShared,
                        zagrebTram: true,
                    },
                    phase: 'complete',
                };
                return completedOutcome;
            }
            if (probeIndex >= probeOffsetsM.length) {
                completedOutcome = { done: true, value: null, phase: 'complete' };
                return completedOutcome;
            }
            return { done: false, value: null, phase: 'tram-mast-clearance' };
        },
    };
}

function createSupportCandidateTask(
    span,
    supportClearance = null,
    roadbedAt = null,
) {
    const atPhaseBoundary = Math.abs(
        span.fromM / SUPPORT_SPACING_M - Math.round(span.fromM / SUPPORT_SPACING_M),
    ) < 1e-6;
    if (!atPhaseBoundary || span.tunnel) {
        return completedSupportTask(null, 'support not required');
    }
    if (isZagrebTramSpan(span)) {
        return createTramSupportCandidateTask(span, supportClearance, roadbedAt);
    }
    const offsets = trackOffsetsAt(span.segment, span.fromT);
    const halfWidthM = Math.max(
        Number(span.segment.startTrackbedHalfWidthM) || 1.5,
        Number(span.segment.endTrackbedHalfWidthM) || 1.5,
        ...offsets.map(Math.abs),
    );
    const side = Math.round(span.fromM / SUPPORT_SPACING_M) % 2 === 0 ? -1 : 1;
    const outsideOffsetM = halfWidthM + 1.1;
    // The normal alternating side remains the first choice. If it lands in a
    // road/track footprint, the opposite side is the only simple fallback; if
    // both are forbidden, omit the mast while keeping the contact wire span.
    const sideOrder = [side, -side];
    let sideIndex = 0;
    let completedOutcome = null;
    return {
        phaseLabel: () => `rail mast clearance ${Math.min(sideIndex + 1, sideOrder.length)}`
            + `/${sideOrder.length}`,
        step() {
            if (completedOutcome) return completedOutcome;
            const point = pointAt(
                span.segment,
                span.fromT,
                sideOrder[sideIndex] * outsideOffsetM,
                0,
            );
            sideIndex += 1;
            if (typeof supportClearance !== 'function'
                || supportClearance(point.x, point.z) >= 0) {
                completedOutcome = {
                    done: true,
                    value: {
                        ...point,
                        heading: Number(span.segment.angle) || 0,
                        crossarmWidthM: Math.max(4.2, halfWidthM * 2 + 2.2),
                        supportKey: `${featureIdentity(span.segment)}`
                            + `:${Math.round(span.fromM / SUPPORT_SPACING_M)}`,
                        mastPoints: [{ ...point }],
                    },
                    phase: 'complete',
                };
                return completedOutcome;
            }
            if (sideIndex >= sideOrder.length) {
                completedOutcome = { done: true, value: null, phase: 'complete' };
                return completedOutcome;
            }
            return { done: false, value: null, phase: 'rail-mast-clearance' };
        },
    };
}

function tramSupportLongitudinalDelta(left, right) {
    const heading = Number(left?.heading) || 0;
    const dx = Number(right?.x) - Number(left?.x);
    const dz = Number(right?.z) - Number(left?.z);
    return Math.abs(dx * Math.sin(heading) + dz * Math.cos(heading));
}

function mergeZagrebTramSupport(group, candidate, roadbedAt) {
    const members = Number(group.members) || 1;
    const candidateMembers = Number(candidate.members) || 1;
    const total = members + candidateMembers;
    const wirePoints = uniquePoints([
        ...(group.wirePoints || []),
        ...(candidate.wirePoints || []),
    ]);
    const mastPoints = uniquePoints([
        ...(group.mastPoints || []),
        ...(candidate.mastPoints || []),
    ]);
    const roadShared = group.roadShared === true
        || candidate.roadShared === true
        || roadbedCrossesPoints(wirePoints, roadbedAt);
    const pair = farthestPointPair(wirePoints);
    const useCentreT = !roadShared
        && pair?.distanceM >= TRAM_PAIR_MIN_SPACING_M
        && pair.distanceM <= TRAM_PAIR_MAX_SPACING_M;
    const geometry = useCentreT
        ? centreTGeometry(wirePoints)
        : sideLGeometry(
            [...mastPoints].sort((left, right) => (
                (Number(right.clearance) || 0) - (Number(left.clearance) || 0)
            ))[0],
            wirePoints,
        );
    const anchor = averagePoint(wirePoints);
    Object.assign(group, anchor, geometry, {
        members: total,
        wirePoints,
        roadShared,
        zagrebTram: true,
    });
}

export function groupParallelSupports(candidates, { roadbedAt = null } = {}) {
    const groups = [];
    const seenKeys = new Set();
    for (const candidate of candidates || []) {
        if (seenKeys.has(candidate.supportKey)) continue;
        seenKeys.add(candidate.supportKey);
        const group = groups.find(existing => (
            distance2d(existing, candidate) <= 8
            && headingDeltaDeg(existing.heading, candidate.heading) <= 15
            && !!existing.zagrebTram === !!candidate.zagrebTram
            && (!(existing.zagrebTram && candidate.zagrebTram)
                || tramSupportLongitudinalDelta(existing, candidate) <= 4)
        ));
        if (!group) {
            const mastPoints = Array.isArray(candidate.mastPoints)
                && candidate.mastPoints.length > 0
                ? candidate.mastPoints.map(point => ({ ...point }))
                : [{ x: candidate.x, y: candidate.y, z: candidate.z }];
            groups.push({
                ...candidate,
                members: Number(candidate.members) || mastPoints.length,
                mastPoints,
            });
            continue;
        }
        if (group.zagrebTram && candidate.zagrebTram) {
            mergeZagrebTramSupport(group, candidate, roadbedAt);
            continue;
        }
        const candidateMastPoints = Array.isArray(candidate.mastPoints)
            && candidate.mastPoints.length > 0
            ? candidate.mastPoints.map(point => ({ ...point }))
            : [{ x: candidate.x, y: candidate.y, z: candidate.z }];
        const candidateMembers = Number(candidate.members) || candidateMastPoints.length;
        const total = group.members + candidateMembers;
        group.x = (group.x * group.members + candidate.x * candidateMembers) / total;
        group.y = Math.max(group.y, candidate.y);
        group.z = (group.z * group.members + candidate.z * candidateMembers) / total;
        group.crossarmWidthM = Math.max(
            group.crossarmWidthM,
            candidate.crossarmWidthM + distance2d(group, candidate),
        );
        group.members = total;
        group.mastPoints.push(...candidateMastPoints);
    }
    return groups;
}

function stageSpanLinePositions(span) {
    const linePositions = [];
    const startOffsets = trackOffsetsAt(span.segment, span.fromT);
    const endOffsets = trackOffsetsAt(span.segment, span.toT);
    const trackCount = Math.max(startOffsets.length, endOffsets.length);
    for (let trackIndex = 0; trackIndex < trackCount; trackIndex++) {
        const startOffset = startOffsets[trackIndex] ?? startOffsets.at(-1) ?? 0;
        const endOffset = endOffsets[trackIndex] ?? endOffsets.at(-1) ?? 0;
        const contactHeight = span.tunnel ? CONTACT_HEIGHT_M - 0.3 : CONTACT_HEIGHT_M;
        const contactStart = pointAt(span.segment, span.fromT, startOffset, contactHeight);
        const contactEnd = pointAt(span.segment, span.toT, endOffset, contactHeight);
        pushLine(linePositions, contactStart, contactEnd);
        if (span.tunnel) continue;
        let previous = messengerPoint(span, 0, startOffset);
        for (let index = 1; index <= 5; index++) {
            const t = index / 5;
            const offset = interpolate(startOffset, endOffset, t);
            const next = messengerPoint(span, t, offset);
            pushLine(linePositions, previous, next);
            previous = next;
        }
        const spanLengthM = span.toM - span.fromM;
        for (
            let distanceM = DROPPER_SPACING_M;
            distanceM < spanLengthM - 0.25;
            distanceM += DROPPER_SPACING_M
        ) {
            const t = distanceM / spanLengthM;
            const offset = interpolate(startOffset, endOffset, t);
            const contact = pointAt(
                span.segment,
                interpolate(span.fromT, span.toT, t),
                offset,
                CONTACT_HEIGHT_M,
            );
            pushLine(linePositions, contact, messengerPoint(span, t, offset));
        }
    }
    return linePositions;
}

// Stages one span cooperatively. Wire arithmetic and support setup happen once;
// every later visit performs at most one potentially expensive clearance probe.
// The caller receives no partial geometry until the span is complete, preserving
// atomic cell publication while letting the frame queue stop between probes.
export function createElectrificationSpanStagingTask(
    span,
    { supportClearance = null, roadbedAt = null } = {},
) {
    let linePositions = null;
    let supportTask = null;
    let completedValue = null;
    const task = {
        phaseLabel: () => {
            if (completedValue) return 'complete';
            if (!linePositions) return 'wire geometry';
            return supportTask?.phaseLabel?.() || 'support geometry';
        },
        step() {
            if (completedValue) {
                return { done: true, value: completedValue, phase: 'complete' };
            }
            if (!linePositions) {
                linePositions = stageSpanLinePositions(span);
                supportTask = createSupportCandidateTask(
                    span,
                    supportClearance,
                    roadbedAt,
                );
            }
            const supportOutcome = supportTask.step();
            if (!supportOutcome.done) {
                return { done: false, value: null, phase: supportOutcome.phase };
            }
            completedValue = {
                linePositions,
                supports: supportOutcome.value ? [supportOutcome.value] : [],
            };
            return { done: true, value: completedValue, phase: 'complete' };
        },
    };
    return task;
}

export function stageCellGeometry(
    spans,
    { supportClearance = null, roadbedAt = null } = {},
) {
    const linePositions = [];
    const supportCandidates = [];
    for (const span of spans || []) {
        const task = createElectrificationSpanStagingTask(
            span,
            { supportClearance, roadbedAt },
        );
        let outcome = task.step();
        while (!outcome.done) outcome = task.step();
        linePositions.push(...outcome.value.linePositions);
        supportCandidates.push(...outcome.value.supports);
    }
    return {
        linePositions,
        supports: groupParallelSupports(supportCandidates, { roadbedAt }),
    };
}

export function selectStreamingCells(cells, observer, {
    preloadM = ELECTRIFICATION_PRELOAD_M,
    activeM = ELECTRIFICATION_ACTIVE_M,
    evictM = ELECTRIFICATION_EVICT_M,
    maxCells = ELECTRIFICATION_MAX_CELLS,
} = {}) {
    if (typeof cells?.has !== 'function') {
        throw new TypeError('Streaming-cell selection requires the indexed cell Map or Set');
    }
    const x = Number(observer?.x), z = Number(observer?.z);
    const radius = Math.max(0, preloadM, activeM, evictM);
    const minX = Math.floor((x - radius) / ELECTRIFICATION_CELL_M);
    const maxX = Math.floor((x + radius) / ELECTRIFICATION_CELL_M);
    const minZ = Math.floor((z - radius) / ELECTRIFICATION_CELL_M);
    const maxZ = Math.floor((z + radius) / ELECTRIFICATION_CELL_M);
    const ranked = [];
    // Cell centres outside this window cannot pass any of the three distance
    // gates. Query the existing ownership index, never materialize/sort every
    // rail cell just to retain at most 36 nearby ones.
    if ([minX, maxX, minZ, maxZ].every(Number.isSafeInteger)) {
        for (let cellX = minX; cellX <= maxX; cellX++) {
            for (let cellZ = minZ; cellZ <= maxZ; cellZ++) {
                const key = `${cellX}:${cellZ}`;
                if (!cells.has(key)) continue;
                const distanceM = Math.hypot(
                    (cellX + 0.5) * ELECTRIFICATION_CELL_M - x,
                    (cellZ + 0.5) * ELECTRIFICATION_CELL_M - z,
                );
                if (distanceM <= radius) ranked.push({ key, distanceM });
            }
        }
    }
    ranked.sort((left, right) => left.distanceM - right.distanceM || left.key.localeCompare(right.key));
    return {
        preload: ranked.filter(item => item.distanceM <= preloadM).slice(0, maxCells),
        active: new Set(ranked.filter(item => item.distanceM <= activeM).slice(0, maxCells).map(item => item.key)),
        retain: new Set(ranked.filter(item => item.distanceM <= evictM).slice(0, maxCells).map(item => item.key)),
    };
}
