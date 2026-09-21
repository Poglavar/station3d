// Deterministic, bounded ambient rail fleets for GTA sessions: trams on tram
// track and trains on heavy rail, both from the same streamed centreline
// collection as rails.js. Trains chain OSM ways end to end so one has a run
// to make, not one short way to shuttle on.

import { isSolvedRailFeature } from './rail-profile-source.js';

export const TRAM_RAILWAYS = new Set(['tram', 'light_rail']);
export const HEAVY_RAILWAYS = new Set(['rail']);
const NON_REVENUE_TRACK_SERVICES = new Set(['yard', 'siding', 'spur']);
const FORWARD_ONEWAY_VALUES = new Set(['yes', 'true', '1']);
const REVERSE_ONEWAY_VALUES = new Set(['-1', 'reverse']);

// Three.js and Rapier both rotate a local Z-aligned box by the scene's Y yaw.
// Tram timetable headings use 0=north (-Z), so tram.js already converts them
// into `mesh.rotation.y`. Negating that scene yaw again makes the long Rapier
// box cross the rails at twice the path angle and can hit a car several metres
// beside the track.
export function gtaTramPhysicsHeadingFromSceneYaw(sceneYaw) {
    const yaw = Number(sceneYaw);
    return Number.isFinite(yaw) ? yaw : 0;
}

export function railwayType(feature) {
    const properties = feature?.properties || {};
    const explicit = String(
        properties.railway_type
        ?? properties.railway
        ?? properties.tags?.railway
        ?? '',
    ).trim().toLowerCase();
    if (explicit) return explicit;
    // A solved reference span carries its gauge instead of an OSM railway tag.
    const gauge = String(properties.trackType ?? properties.gauge ?? '').trim().toLowerCase();
    if (gauge === 'g1435') return 'rail';
    if (gauge === 'g1000') return 'tram';
    return '';
}

// Heavy rail a train may run and a player may drive: revenue track only, and
// in solved mode only the reconstructed spans, the same rule the cab applies
// to its driving track, so every train the fleet shows can also be boarded.
export function isAmbientTrainFeature(feature, { solvedOnly = false } = {}) {
    if (!HEAVY_RAILWAYS.has(railwayType(feature)) || !isRevenueTramTrack(feature)) return false;
    if (feature?.properties?.driverTrackOnly) return false;
    return !solvedOnly || isSolvedRailFeature(feature);
}

function osmIdOf(feature) {
    const properties = feature?.properties || {};
    const osmId = properties.osm_id ?? properties.osmId;
    return osmId != null && String(osmId) !== '' ? osmId : null;
}

function sourceIdOf(feature, featureIndex) {
    const properties = feature?.properties || {};
    return osmIdOf(feature) ?? properties.referenceSegmentKey ?? properties.railProfileFragment ?? featureIndex;
}

function propertyOrTag(feature, key) {
    const properties = feature?.properties || {};
    return properties[key] ?? properties.tags?.[key];
}

function oneWayTravelDirection(feature) {
    const value = String(propertyOrTag(feature, 'oneway') ?? '').trim().toLowerCase();
    if (FORWARD_ONEWAY_VALUES.has(value)) return 1;
    if (REVERSE_ONEWAY_VALUES.has(value)) return -1;
    return 0;
}

function isRevenueTramTrack(feature) {
    const service = String(propertyOrTag(feature, 'service') ?? '').trim().toLowerCase();
    return !NON_REVENUE_TRACK_SERVICES.has(service);
}

function stableHash(value) {
    let hash = 2166136261;
    for (const char of String(value)) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

export function* buildGtaAmbientTramPathSteps(features, {
    toLocal,
    minLengthM = 450,
    coordinateChunk = 128,
    featureChunk = 64,
    railways = TRAM_RAILWAYS,
    accept = null,
    chain = false,
} = {}) {
    if (typeof toLocal !== 'function') return [];
    const wanted = typeof accept === 'function'
        ? accept
        : feature => railways.has(railwayType(feature)) && isRevenueTramTrack(feature);
    const paths = [];
    const coordinateYieldEvery = Math.max(1, Math.trunc(Number(coordinateChunk) || 128));
    const featureYieldEvery = Math.max(1, Math.trunc(Number(featureChunk) || 64));
    let coordinateWork = 0;
    for (let featureIndex = 0; featureIndex < (features || []).length; featureIndex += 1) {
        const feature = features[featureIndex];
        if (!wanted(feature)) {
            if ((featureIndex + 1) % featureYieldEvery === 0) {
                yield { phase: 'features', featureIndex };
            }
            continue;
        }
        const coordinates = feature?.geometry?.type === 'LineString'
            ? feature.geometry.coordinates : null;
        if (!Array.isArray(coordinates) || coordinates.length < 2) {
            if ((featureIndex + 1) % featureYieldEvery === 0) {
                yield { phase: 'features', featureIndex };
            }
            continue;
        }
        const points = [];
        const cumulativeM = [];
        const pointOsmId = osmIdOf(feature);
        let lengthM = 0;
        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        for (let coordinateIndex = 0; coordinateIndex < coordinates.length; coordinateIndex += 1) {
            const coordinate = coordinates[coordinateIndex];
            const lon = Number(coordinate?.[0]);
            const lat = Number(coordinate?.[1]);
            if (Number.isFinite(lon) && Number.isFinite(lat)) {
                const local = toLocal(lon, lat);
                const x = Number(local?.x);
                const z = Number(local?.z);
                if (Number.isFinite(x) && Number.isFinite(z)) {
                    const previous = points[points.length - 1];
                    const stepM = previous
                        ? Math.hypot(x - previous.x, z - previous.z)
                        : Infinity;
                    if (!previous || stepM >= 0.05) {
                        if (previous) lengthM += stepM;
                        points.push({ x, z, lon, lat, osmId: pointOsmId });
                        cumulativeM.push(lengthM);
                        minX = Math.min(minX, x);
                        maxX = Math.max(maxX, x);
                        minZ = Math.min(minZ, z);
                        maxZ = Math.max(maxZ, z);
                    }
                }
            }
            coordinateWork += 1;
            if (coordinateWork % coordinateYieldEvery === 0) {
                yield { phase: 'coordinates', featureIndex, coordinateIndex };
            }
        }
        if (points.length >= 2 && (chain || lengthM >= minLengthM)) {
            const sourceId = sourceIdOf(feature, featureIndex);
            paths.push({
                id: `osm:${String(sourceId)}`,
                // Only a real OSM way id names a trackbed for support queries;
                // a solved span has none and takes the highest trackbed there.
                osmId: pointOsmId,
                osmIds: pointOsmId == null ? [] : [pointOsmId],
                sourceIds: [sourceId],
                points,
                cumulativeM,
                lengthM,
                centerX: (minX + maxX) * 0.5,
                centerZ: (minZ + maxZ) * 0.5,
                travelDirection: oneWayTravelDirection(feature),
            });
        }
        if ((featureIndex + 1) % featureYieldEvery === 0) {
            yield { phase: 'features', featureIndex };
        }
    }
    if (!chain) return paths;
    return chainAmbientRailPaths(paths).filter(path => path.lengthM >= minLengthM);
}

const near = (a, b, toleranceM) => Math.hypot(a.x - b.x, a.z - b.z) <= toleranceM;
// A join must be a continuation, not a reversal through a switch: the travel
// direction arriving at the joint and the one leaving it may differ by this much.
const JOIN_MAX_TURN_DEG = 40;
function continuous(arriveFrom, joint, leaveTo) {
    const ax = joint.x - arriveFrom.x;
    const az = joint.z - arriveFrom.z;
    const bx = leaveTo.x - joint.x;
    const bz = leaveTo.z - joint.z;
    const lengths = Math.hypot(ax, az) * Math.hypot(bx, bz);
    if (!(lengths > 0)) return false;
    return (ax * bx + az * bz) / lengths >= Math.cos(JOIN_MAX_TURN_DEG * Math.PI / 180);
}

function finalisePath(points, sourceIds) {
    const cumulativeM = [0];
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let index = 0; index < points.length; index += 1) {
        const point = points[index];
        if (index > 0) {
            const previous = points[index - 1];
            cumulativeM.push(cumulativeM[index - 1] + Math.hypot(point.x - previous.x, point.z - previous.z));
        }
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minZ = Math.min(minZ, point.z);
        maxZ = Math.max(maxZ, point.z);
    }
    const osmIds = [...new Set(points.map(point => point.osmId).filter(id => id != null))];
    return {
        id: `osm:${sourceIds.map(String).join('+')}`,
        osmId: osmIds[0] ?? null,
        osmIds,
        sourceIds,
        points,
        cumulativeM,
        lengthM: cumulativeM.at(-1),
        centerX: (minX + maxX) * 0.5,
        centerZ: (minZ + maxZ) * 0.5,
        // A chained run is a plain two-way line: a one-way tag on one of its
        // ways would have no meaning across the whole run.
        travelDirection: 0,
    };
}

// Joins paths end to end where exactly one other path touches an end; a
// junction (two or more touching) ends the chain there, so a run never turns
// through a switch it would not take. Deterministic: seeds in input order.
export function chainAmbientRailPaths(paths, { joinToleranceM = 0.75 } = {}) {
    const remaining = (paths || []).map(path => ({
        points: path.points.map(point => ({ ...point })),
        sourceIds: [...(path.sourceIds || [path.osmId])],
    }));
    const chains = [];
    while (remaining.length > 0) {
        const chain = remaining.shift();
        let extended = true;
        while (extended) {
            extended = false;
            for (const end of ['tail', 'head']) {
                const endpoint = end === 'tail' ? chain.points.at(-1) : chain.points[0];
                const touching = [];
                for (let index = 0; index < remaining.length; index += 1) {
                    const other = remaining[index];
                    const atHead = near(endpoint, other.points[0], joinToleranceM);
                    const atTail = near(endpoint, other.points.at(-1), joinToleranceM);
                    if (atHead || atTail) touching.push({ index, reverse: end === 'tail' ? atTail : atHead });
                }
                if (touching.length !== 1) continue;
                const other = remaining[touching[0].index];
                const points = touching[0].reverse ? [...other.points].reverse() : other.points;
                // Oriented so the joint is at the other's head for a tail join
                // and at its tail for a head join; the run must flow through it.
                const smooth = end === 'tail'
                    ? continuous(chain.points.at(-2), endpoint, points[1])
                    : continuous(points.at(-2), endpoint, chain.points[1]);
                if (!smooth) continue;
                remaining.splice(touching[0].index, 1);
                if (end === 'tail') {
                    // A point owns the segment that leaves it, so the joint
                    // now belongs to the way being appended.
                    const joint = { ...chain.points.at(-1), osmId: points[0].osmId ?? chain.points.at(-1).osmId };
                    chain.points = [...chain.points.slice(0, -1), joint, ...points.slice(1)];
                    chain.sourceIds = [...chain.sourceIds, ...other.sourceIds];
                } else {
                    chain.points = [...points.slice(0, -1), ...chain.points];
                    chain.sourceIds = [...other.sourceIds, ...chain.sourceIds];
                }
                extended = true;
            }
        }
        chains.push(finalisePath(chain.points, chain.sourceIds));
    }
    return chains;
}

export function buildGtaAmbientTramPaths(features, options = {}) {
    const steps = buildGtaAmbientTramPathSteps(features, options);
    while (true) {
        const step = steps.next();
        if (step.done) return step.value;
    }
}

export function sampleGtaAmbientTramPath(path, distanceM) {
    if (!path || !Array.isArray(path.points) || path.points.length < 2) return null;
    const distance = Math.max(0, Math.min(path.lengthM, Number(distanceM) || 0));
    let upper = 1;
    while (upper < path.cumulativeM.length && path.cumulativeM[upper] < distance) upper += 1;
    upper = Math.min(path.points.length - 1, upper);
    const lower = Math.max(0, upper - 1);
    const from = path.points[lower];
    const to = path.points[upper];
    const startM = path.cumulativeM[lower];
    const spanM = Math.max(0.001, path.cumulativeM[upper] - startM);
    const t = Math.max(0, Math.min(1, (distance - startM) / spanM));
    const x = from.x + (to.x - from.x) * t;
    const z = from.z + (to.z - from.z) * t;
    return {
        x,
        z,
        lon: from.lon + (to.lon - from.lon) * t,
        lat: from.lat + (to.lat - from.lat) * t,
        headingDeg: Math.atan2(to.x - from.x, -(to.z - from.z)) * 180 / Math.PI,
        // The rail this point of the run belongs to, for trackbed support and
        // for resuming on the right way after the player steps off.
        osmId: from.osmId ?? path.osmId ?? null,
    };
}

export function reconcileGtaAmbientTramFleet(paths, fleet = [], {
    centerX = 0,
    centerZ = 0,
    maxTrams = 4,
    idPrefix = 'gta-tram',
    cruiseMinMps = 8.5,
    cruiseStepMps = 0.1,
} = {}) {
    const existing = new Map((fleet || []).map(tram => [tram.pathId, tram]));
    const candidates = [...(paths || [])].sort((left, right) => (
        Math.hypot(left.centerX - centerX, left.centerZ - centerZ)
            - Math.hypot(right.centerX - centerX, right.centerZ - centerZ)
        || right.lengthM - left.lengthM
        || left.id.localeCompare(right.id)
    ));
    return candidates.slice(0, Math.max(0, Math.trunc(maxTrams))).map((path) => {
        const retained = existing.get(path.id);
        if (retained) return {
            ...retained,
            pathId: path.id,
            direction: path.travelDirection || retained.direction,
        };
        const hash = stableHash(path.id);
        return {
            id: `${idPrefix}:${path.id}`,
            pathId: path.id,
            distanceM: path.lengthM * (0.16 + ((hash >>> 8) % 68) / 100),
            direction: path.travelDirection || ((hash & 1) === 0 ? 1 : -1),
            speedMps: cruiseMinMps + (hash % 31) * cruiseStepMps,
        };
    });
}

export function advanceGtaAmbientTramPath(path, state = {}, travelM = 0) {
    const lengthM = Math.max(0, Number(path?.lengthM) || 0);
    if (!(lengthM > 0)) return { distanceM: 0, direction: 1 };
    const distanceM = Math.max(0, Math.min(lengthM, Number(state.distanceM) || 0));
    const travel = Math.max(0, Number(travelM) || 0);
    const constrainedDirection = path.travelDirection === -1
        ? -1
        : path.travelDirection === 1 ? 1 : 0;
    if (constrainedDirection) {
        const next = distanceM + constrainedDirection * travel;
        if (next > lengthM) {
            return { distanceM: next % lengthM, direction: constrainedDirection };
        }
        if (next < 0) {
            const remainder = (-next) % lengthM;
            return {
                distanceM: remainder === 0 ? 0 : lengthM - remainder,
                direction: constrainedDirection,
            };
        }
        return { distanceM: next, direction: constrainedDirection };
    }

    const direction = Number(state.direction) < 0 ? -1 : 1;
    const periodM = lengthM * 2;
    const unfoldedM = (direction > 0 ? distanceM : periodM - distanceM) + travel;
    const phaseM = ((unfoldedM % periodM) + periodM) % periodM;
    return phaseM <= lengthM
        ? { distanceM: phaseM, direction: 1 }
        : { distanceM: periodM - phaseM, direction: -1 };
}

export function stepGtaAmbientTramFleet(paths, fleet, dt) {
    const byId = new Map((paths || []).map(path => [path.id, path]));
    const seconds = Math.max(0, Math.min(0.1, Number(dt) || 0));
    const poses = [];
    for (const tram of fleet || []) {
        const path = byId.get(tram.pathId);
        if (!path) continue;
        const advanced = advanceGtaAmbientTramPath(
            path,
            tram,
            tram.speedMps * seconds,
        );
        tram.distanceM = advanced.distanceM;
        tram.direction = advanced.direction;
        const sample = sampleGtaAmbientTramPath(path, tram.distanceM);
        if (!sample) continue;
        poses.push({
            ...sample,
            id: tram.id,
            osmId: sample.osmId ?? path.osmId,
            headingDeg: sample.headingDeg + (tram.direction < 0 ? 180 : 0),
            speedMps: tram.speedMps,
        });
    }
    return poses;
}
