// Stable reservation/claim/release lifecycle for GTA ambient rail vehicles:
// one instance runs the trams, another the trains, differing in policy, ids
// and pace. Motion is pure bounded path following; rendered meshes remain
// owned by vehicles/tram.js.

import {
    advanceGtaAmbientTramPath,
    reconcileGtaAmbientTramFleet,
    sampleGtaAmbientTramPath,
} from './gta-ambient-trams.js';

export const AMBIENT_TRAM_STATES = Object.freeze({
    AUTONOMOUS: 'autonomous',
    BOARDING_REQUESTED: 'boarding-requested',
    CONTROLLING: 'controlling',
    EXITING: 'exiting',
    WAITING_FOR_PATH: 'waiting-for-path',
    DESTROYED: 'destroyed',
});

export const AMBIENT_TRAM_POLICY = Object.freeze({
    detectionDistanceM: 12,
    entryDistanceM: 3.2,
    reservationDistanceM: 40,
    reservationMs: 30_000,
    stoppedMps: 0.4,
    exitMaxSpeedMps: 0.8,
    boardingDoorRatio: 0.95,
    dwellMs: 2_000,
    serviceBrakeMps2: 1.8,
    resumeAccelMps2: 0.9,
    doorRatioPerSecond: 1.8,
    snapToleranceM: 60,
});

// A train hailed at 20 m/s and braking at 1.5 m/s² stops some 130 m on, so
// the reservation must survive that walk and a longer wait.
export const AMBIENT_TRAIN_POLICY = Object.freeze({
    ...AMBIENT_TRAM_POLICY,
    detectionDistanceM: 16,
    reservationDistanceM: 260,
    reservationMs: 60_000,
    dwellMs: 2_500,
    serviceBrakeMps2: 1.5,
    resumeAccelMps2: 0.5,
    doorRatioPerSecond: 1.2,
    snapToleranceM: 80,
});
export const AMBIENT_TRAIN_CRUISE = Object.freeze({ cruiseMinMps: 18, cruiseStepMps: 0.2 });

export const AMBIENT_TRAIN_SERVICE_PHASES = Object.freeze({
    WAITING: 'waiting',
    APPROACHING: 'approaching',
    DWELLING: 'dwelling',
    DEPARTING: 'departing',
});

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function distanceToLocal(record, local) {
    const x = Number(record?.lastPose?.x);
    const z = Number(record?.lastPose?.z);
    const localX = Number(local?.x);
    const localZ = Number(local?.z);
    if (![x, z, localX, localZ].every(Number.isFinite)) return Infinity;
    return Math.hypot(x - localX, z - localZ);
}

function normaliseRecord(record) {
    const cruiseSpeedMps = Math.max(0, finite(record.cruiseSpeedMps, record.speedMps));
    return {
        ...record,
        state: record.state || AMBIENT_TRAM_STATES.AUTONOMOUS,
        cruiseSpeedMps,
        currentSpeedMps: Math.max(0, finite(record.currentSpeedMps, record.speedMps)),
        speedMps: Math.max(0, finite(record.currentSpeedMps, record.speedMps)),
        doorRatio: Math.max(0, Math.min(1, finite(record.doorRatio))),
        doorTarget: record.doorTarget === 1 ? 1 : 0,
        reservationExpiresAtMs: finite(record.reservationExpiresAtMs, 0),
        resumeAtMs: finite(record.resumeAtMs, 0),
        controlledVisible: record.controlledVisible === true,
        lastPose: record.lastPose || null,
        resumeSourceOsmId: record.resumeSourceOsmId ?? null,
    };
}

function projectPoseOntoPath(path, pose) {
    const px = Number(pose?.x);
    const pz = Number(pose?.z);
    if (!path?.points?.length || !Number.isFinite(px) || !Number.isFinite(pz)) return null;
    let best = null;
    for (let index = 1; index < path.points.length; index += 1) {
        const a = path.points[index - 1];
        const b = path.points[index];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const lengthSq = dx * dx + dz * dz;
        if (lengthSq < 1e-9) continue;
        const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (pz - a.z) * dz) / lengthSq));
        const x = a.x + dx * t;
        const z = a.z + dz * t;
        const distanceM = Math.hypot(px - x, pz - z);
        if (!best || distanceM < best.distanceM) {
            best = {
                distanceM,
                pathDistanceM: path.cumulativeM[index - 1]
                    + Math.sqrt(lengthSq) * t,
            };
        }
    }
    return best;
}

export function createAmbientTramProvider({
    nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    policy = AMBIENT_TRAM_POLICY,
    id = 'trams',
    kind = 'tram',
    idPrefix = 'gta-tram',
    cruiseMinMps = 8.5,
    cruiseStepMps = 0.1,
    stationService = null,
    random = Math.random,
} = {}) {
    let paths = [];
    let pathById = new Map();
    let fleet = [];

    const randomDurationMs = (range, fallback) => {
        const lower = Math.max(0, finite(range?.[0], fallback));
        const upper = Math.max(lower, finite(range?.[1], lower));
        const unit = Math.max(0, Math.min(1, finite(random?.(), 0.5)));
        return lower + (upper - lower) * unit;
    };

    const pathCarries = (path, osmId) => String(path.osmId) === String(osmId)
        || (path.osmIds || []).some(candidate => String(candidate) === String(osmId));

    function resolveResumePath(record) {
        const candidates = paths.filter(path => record.resumeSourceOsmId == null
            || pathCarries(path, record.resumeSourceOsmId));
        let best = null;
        for (const path of candidates) {
            const projection = projectPoseOntoPath(path, record.lastPose);
            if (!projection || projection.distanceM > policy.snapToleranceM) continue;
            if (!best || projection.distanceM < best.projection.distanceM) {
                best = { path, projection };
            }
        }
        if (!best) return false;
        record.pathId = best.path.id;
        record.distanceM = best.projection.pathDistanceM;
        record.state = AMBIENT_TRAM_STATES.AUTONOMOUS;
        record.currentSpeedMps = 0;
        record.speedMps = 0;
        record.resumeSourceOsmId = null;
        if (record.servicePhase) {
            const stationProjection = projectPoseOntoPath(best.path, {
                x: stationService?.stationX,
                z: stationService?.stationZ,
            });
            if (stationProjection) {
                configureStationServiceRecord(record, {
                    path: best.path,
                    projection: stationProjection,
                });
            }
            record.servicePhase = AMBIENT_TRAIN_SERVICE_PHASES.DEPARTING;
            record.serviceDirection = record.distanceM >= record.serviceStopDistanceM ? 1 : -1;
            record.direction = record.serviceDirection;
            record.serviceDepartureDistanceM = Math.max(0, Math.min(
                best.path.lengthM,
                record.serviceStopDistanceM + record.serviceDirection
                    * Math.max(1, finite(stationService?.clearDistanceM, 600)),
            ));
        }
        return true;
    }

    function stationPathSelection() {
        if (!stationService || !Number.isFinite(stationService.stationX)
            || !Number.isFinite(stationService.stationZ)) return null;
        let best = null;
        const station = { x: stationService.stationX, z: stationService.stationZ };
        for (const path of paths) {
            const projection = projectPoseOntoPath(path, station);
            if (!projection || projection.distanceM > finite(stationService.pathSnapToleranceM, 90)) continue;
            if (!best || projection.distanceM < best.projection.distanceM
                || (projection.distanceM === best.projection.distanceM
                    && path.lengthM > best.path.lengthM)) {
                best = { path, projection };
            }
        }
        return best;
    }

    function configureStationServiceRecord(record, selected, atMs = nowMs()) {
        const { path, projection } = selected;
        const stopDistanceM = projection.pathDistanceM;
        const approachDirection = stopDistanceM <= path.lengthM * 0.5 ? -1 : 1;
        const approachDistanceM = Math.max(1, finite(stationService.approachDistanceM, 500));
        const clearDistanceM = Math.max(approachDistanceM,
            finite(stationService.clearDistanceM, approachDistanceM));
        record.serviceStopDistanceM = stopDistanceM;
        record.serviceApproachDirection = approachDirection;
        record.serviceSpawnDistanceM = Math.max(0, Math.min(
            path.lengthM,
            stopDistanceM - approachDirection * approachDistanceM,
        ));
        record.serviceDepartureDistanceM = Math.max(0, Math.min(
            path.lengthM,
            stopDistanceM - approachDirection * clearDistanceM,
        ));
        if (!record.servicePhase) {
            record.servicePhase = AMBIENT_TRAIN_SERVICE_PHASES.WAITING;
            record.serviceDirection = approachDirection;
            record.serviceNextAtMs = atMs + randomDurationMs(stationService.initialWaitMs, 10_000);
            record.serviceDwellUntilMs = 0;
            record.distanceM = record.serviceSpawnDistanceM;
            record.direction = approachDirection;
            record.currentSpeedMps = 0;
            record.speedMps = 0;
            record.doorRatio = 0;
            record.doorTarget = 0;
            record.lastPose = null;
        }
    }

    function replacePaths(nextPaths, {
        centerX = 0,
        centerZ = 0,
        maxTrams = 4,
    } = {}) {
        paths = Array.isArray(nextPaths) ? nextPaths : [];
        pathById = new Map(paths.map(path => [path.id, path]));
        const special = fleet.filter(record => record.state !== AMBIENT_TRAM_STATES.AUTONOMOUS);
        const serviceSelection = stationPathSelection();
        const candidatePaths = stationService
            ? (serviceSelection ? [serviceSelection.path] : [])
            : paths;
        const selected = reconcileGtaAmbientTramFleet(candidatePaths, fleet, {
            centerX, centerZ, maxTrams, idPrefix, cruiseMinMps, cruiseStepMps,
        }).map(normaliseRecord);
        if (stationService && selected[0] && serviceSelection) {
            configureStationServiceRecord(selected[0], serviceSelection);
        }
        const selectedIds = new Set(selected.map(record => record.id));
        for (const record of special) {
            if (!selectedIds.has(record.id)) selected.push(record);
        }
        fleet = selected;
        for (const record of fleet) {
            if (record.state === AMBIENT_TRAM_STATES.WAITING_FOR_PATH) resolveResumePath(record);
        }
        return fleet;
    }

    function cancelRecord(record) {
        if (!record || record.state !== AMBIENT_TRAM_STATES.BOARDING_REQUESTED) return false;
        record.state = AMBIENT_TRAM_STATES.AUTONOMOUS;
        record.reservationExpiresAtMs = 0;
        record.doorTarget = 0;
        return true;
    }

    function advanceDoors(record, dt) {
        const direction = record.doorTarget > record.doorRatio ? 1 : -1;
        if (record.doorTarget === record.doorRatio) return;
        record.doorRatio = Math.max(0, Math.min(1,
            record.doorRatio + direction * policy.doorRatioPerSecond * dt));
        if (Math.abs(record.doorRatio - record.doorTarget) < 0.001) {
            record.doorRatio = record.doorTarget;
        }
    }

    function advancePath(record, dt) {
        const path = pathById.get(record.pathId);
        if (!path) return record.lastPose;
        const advanced = advanceGtaAmbientTramPath(
            path,
            record,
            record.currentSpeedMps * dt,
        );
        record.distanceM = advanced.distanceM;
        record.direction = advanced.direction;
        const sample = sampleGtaAmbientTramPath(path, record.distanceM);
        if (!sample) return record.lastPose;
        record.lastPose = {
            ...sample,
            id: record.id,
            osmId: path.osmId,
            headingDeg: sample.headingDeg + (record.direction < 0 ? 180 : 0),
            speedMps: record.currentSpeedMps,
        };
        return record.lastPose;
    }

    function setPoseFromCurrentPath(record) {
        const path = pathById.get(record.pathId);
        const sample = path && sampleGtaAmbientTramPath(path, record.distanceM);
        if (!sample) return record.lastPose;
        record.lastPose = {
            ...sample,
            id: record.id,
            osmId: path.osmId,
            headingDeg: sample.headingDeg + (record.direction < 0 ? 180 : 0),
            speedMps: record.currentSpeedMps,
        };
        return record.lastPose;
    }

    function prepareStationServiceStep(record, seconds, atMs) {
        if (!record.servicePhase) return false;
        if (record.servicePhase === AMBIENT_TRAIN_SERVICE_PHASES.WAITING) {
            record.currentSpeedMps = 0;
            record.speedMps = 0;
            record.doorTarget = 0;
            if (atMs < record.serviceNextAtMs) return true;
            record.servicePhase = AMBIENT_TRAIN_SERVICE_PHASES.APPROACHING;
            record.serviceDirection = record.serviceApproachDirection;
            record.direction = record.serviceDirection;
            record.distanceM = record.serviceSpawnDistanceM;
            setPoseFromCurrentPath(record);
        }
        if (record.servicePhase === AMBIENT_TRAIN_SERVICE_PHASES.DWELLING) {
            record.currentSpeedMps = 0;
            record.speedMps = 0;
            record.doorTarget = atMs < record.serviceDwellUntilMs ? 1 : 0;
            return true;
        }
        record.doorTarget = 0;
        if (record.doorRatio > 0.001) {
            record.currentSpeedMps = 0;
            record.speedMps = 0;
            return true;
        }
        const targetDistanceM = record.servicePhase === AMBIENT_TRAIN_SERVICE_PHASES.APPROACHING
            ? record.serviceStopDistanceM : record.serviceDepartureDistanceM;
        const remainingM = Math.max(0,
            (targetDistanceM - record.distanceM) * record.serviceDirection);
        const stoppingDistanceM = record.currentSpeedMps * record.currentSpeedMps
            / (2 * Math.max(0.1, policy.serviceBrakeMps2));
        if (record.servicePhase === AMBIENT_TRAIN_SERVICE_PHASES.APPROACHING
            && remainingM <= stoppingDistanceM + 0.05) {
            record.currentSpeedMps = Math.max(
                0,
                record.currentSpeedMps - policy.serviceBrakeMps2 * seconds,
            );
        } else {
            record.currentSpeedMps = Math.min(
                record.cruiseSpeedMps,
                record.currentSpeedMps + policy.resumeAccelMps2 * seconds,
            );
        }
        record.speedMps = record.currentSpeedMps;
        return true;
    }

    function advanceStationServicePath(record, seconds, atMs) {
        const path = pathById.get(record.pathId);
        if (!path || record.servicePhase === AMBIENT_TRAIN_SERVICE_PHASES.WAITING
            || record.servicePhase === AMBIENT_TRAIN_SERVICE_PHASES.DWELLING) return;
        const approaching = record.servicePhase === AMBIENT_TRAIN_SERVICE_PHASES.APPROACHING;
        const targetDistanceM = approaching
            ? record.serviceStopDistanceM : record.serviceDepartureDistanceM;
        const remainingM = Math.max(0,
            (targetDistanceM - record.distanceM) * record.serviceDirection);
        const travelM = Math.min(remainingM, record.currentSpeedMps * seconds);
        record.distanceM += record.serviceDirection * travelM;
        record.direction = record.serviceDirection;
        setPoseFromCurrentPath(record);
        if (remainingM - travelM > 0.05) return;
        record.distanceM = targetDistanceM;
        setPoseFromCurrentPath(record);
        if (approaching) {
            if (record.currentSpeedMps > policy.stoppedMps) return;
            record.currentSpeedMps = 0;
            record.speedMps = 0;
            record.servicePhase = AMBIENT_TRAIN_SERVICE_PHASES.DWELLING;
            record.serviceDwellUntilMs = atMs + randomDurationMs(stationService.dwellMs, 25_000);
            record.doorTarget = 1;
            setPoseFromCurrentPath(record);
            return;
        }
        record.currentSpeedMps = 0;
        record.speedMps = 0;
        record.servicePhase = AMBIENT_TRAIN_SERVICE_PHASES.WAITING;
        record.serviceNextAtMs = atMs + randomDurationMs(stationService.intervalMs, 110_000);
        record.distanceM = record.serviceSpawnDistanceM;
        record.direction = record.serviceApproachDirection;
        record.lastPose = null;
    }

    function step(dt, observerLocal = null, atMs = nowMs()) {
        const seconds = Math.max(0, Math.min(0.1, finite(dt)));
        const poses = [];
        for (const record of fleet) {
            if (record.state === AMBIENT_TRAM_STATES.DESTROYED) continue;
            if (record.state === AMBIENT_TRAM_STATES.BOARDING_REQUESTED) {
                if (atMs >= record.reservationExpiresAtMs
                    || distanceToLocal(record, observerLocal) > policy.reservationDistanceM) {
                    cancelRecord(record);
                } else {
                    record.currentSpeedMps = Math.max(
                        0,
                        record.currentSpeedMps - policy.serviceBrakeMps2 * seconds,
                    );
                    if (record.currentSpeedMps <= policy.stoppedMps) record.doorTarget = 1;
                }
            } else if (record.state === AMBIENT_TRAM_STATES.EXITING) {
                record.currentSpeedMps = 0;
                record.doorTarget = atMs < record.resumeAtMs ? 1 : 0;
                if (atMs >= record.resumeAtMs && record.doorRatio <= 0.001) {
                    if (!resolveResumePath(record)) {
                        record.state = AMBIENT_TRAM_STATES.WAITING_FOR_PATH;
                    }
                }
            } else if (record.state === AMBIENT_TRAM_STATES.AUTONOMOUS) {
                if (!prepareStationServiceStep(record, seconds, atMs)) {
                    record.doorTarget = 0;
                    if (record.doorRatio <= 0.001) {
                        record.currentSpeedMps = Math.min(
                            record.cruiseSpeedMps,
                            record.currentSpeedMps + policy.resumeAccelMps2 * seconds,
                        );
                    } else {
                        record.currentSpeedMps = 0;
                    }
                }
            } else if (record.state === AMBIENT_TRAM_STATES.WAITING_FOR_PATH) {
                record.currentSpeedMps = 0;
                record.doorTarget = 0;
                resolveResumePath(record);
            }
            advanceDoors(record, seconds);
            if (record.state === AMBIENT_TRAM_STATES.AUTONOMOUS
                && record.servicePhase === AMBIENT_TRAIN_SERVICE_PHASES.DWELLING
                && atMs >= record.serviceDwellUntilMs && record.doorRatio <= 0.001) {
                record.servicePhase = AMBIENT_TRAIN_SERVICE_PHASES.DEPARTING;
                record.serviceDirection = -record.serviceApproachDirection;
                record.direction = record.serviceDirection;
            }
            if (record.state !== AMBIENT_TRAM_STATES.CONTROLLING
                && record.state !== AMBIENT_TRAM_STATES.EXITING
                && record.state !== AMBIENT_TRAM_STATES.WAITING_FOR_PATH) {
                if (record.state === AMBIENT_TRAM_STATES.AUTONOMOUS && record.servicePhase) {
                    advanceStationServicePath(record, seconds, atMs);
                } else {
                    advancePath(record, seconds);
                }
            }
            if (record.lastPose
                && record.servicePhase !== AMBIENT_TRAIN_SERVICE_PHASES.WAITING) {
                poses.push({
                    ...record.lastPose,
                    speedMps: record.currentSpeedMps,
                    ownershipState: record.state,
                    doorRatio: record.doorRatio,
                    controlledVisible: record.controlledVisible,
                });
            }
        }
        return poses;
    }

    function candidateForRecord(record, local) {
        if (!record || [AMBIENT_TRAM_STATES.CONTROLLING, AMBIENT_TRAM_STATES.EXITING,
            AMBIENT_TRAM_STATES.WAITING_FOR_PATH, AMBIENT_TRAM_STATES.DESTROYED]
            .includes(record.state)
            || record.servicePhase === AMBIENT_TRAIN_SERVICE_PHASES.WAITING) return null;
        const distanceM = distanceToLocal(record, local);
        const maxDistance = record.state === AMBIENT_TRAM_STATES.BOARDING_REQUESTED
            ? policy.reservationDistanceM : policy.detectionDistanceM;
        if (distanceM > maxDistance) return null;
        const ready = (record.state === AMBIENT_TRAM_STATES.BOARDING_REQUESTED
            || (record.state === AMBIENT_TRAM_STATES.AUTONOMOUS
                && record.servicePhase === AMBIENT_TRAIN_SERVICE_PHASES.DWELLING))
            && record.currentSpeedMps <= policy.stoppedMps
            && record.doorRatio >= policy.boardingDoorRatio;
        return {
                id: record.id,
                kind,
                controllerId: kind,
                available: true,
                reachable: true,
                parked: ready,
                state: record.state,
                ready,
                distanceM,
                speedMps: record.currentSpeedMps,
                doorRatio: record.doorRatio,
        };
    }

    function findNearest(local) {
        let best = null;
        for (const record of fleet) {
            const candidate = candidateForRecord(record, local);
            if (!candidate || (best && candidate.distanceM >= best.distanceM)) continue;
            best = candidate;
        }
        return best;
    }

    function requestAmbientTramBoarding(id, local, atMs = nowMs()) {
        const record = fleet.find(item => item.id === id);
        if (!record || record.state !== AMBIENT_TRAM_STATES.AUTONOMOUS
            || distanceToLocal(record, local) > policy.detectionDistanceM) return false;
        const alreadyAtPlatform = record.servicePhase === AMBIENT_TRAIN_SERVICE_PHASES.DWELLING
            && record.currentSpeedMps <= policy.stoppedMps
            && record.doorRatio >= policy.boardingDoorRatio;
        record.state = AMBIENT_TRAM_STATES.BOARDING_REQUESTED;
        record.reservationExpiresAtMs = atMs + policy.reservationMs;
        record.doorTarget = alreadyAtPlatform ? 1 : 0;
        return true;
    }

    return {
        id,
        kind,
        replacePaths,
        step,
        findNearest,
        findById(id, local) {
            return candidateForRecord(fleet.find(item => item.id === id), local);
        },
        requestBoarding: requestAmbientTramBoarding,
        claim(id, local) {
            const record = fleet.find(item => item.id === id);
            if (!record || record.state !== AMBIENT_TRAM_STATES.BOARDING_REQUESTED
                || distanceToLocal(record, local) > policy.entryDistanceM
                || record.currentSpeedMps > policy.stoppedMps
                || record.doorRatio < policy.boardingDoorRatio) return null;
            record.state = AMBIENT_TRAM_STATES.CONTROLLING;
            record.reservationExpiresAtMs = 0;
            record.doorTarget = 1;
            return { ...record, lastPose: record.lastPose && { ...record.lastPose } };
        },
        sync(id, pose) {
            const record = fleet.find(item => item.id === id);
            if (!record || record.state !== AMBIENT_TRAM_STATES.CONTROLLING || !pose) return false;
            record.lastPose = { ...record.lastPose, ...pose, id: record.id };
            record.currentSpeedMps = Math.abs(finite(pose.speedMps));
            record.speedMps = record.currentSpeedMps;
            if (Number.isFinite(pose.doorRatio)) {
                record.doorRatio = Math.max(0, Math.min(1, Number(pose.doorRatio)));
            }
            record.controlledVisible = pose.visible === true;
            return true;
        },
        release(id, pose, releasePolicy = {}, atMs = nowMs()) {
            const record = fleet.find(item => item.id === id);
            if (!record || record.state !== AMBIENT_TRAM_STATES.CONTROLLING) return false;
            if (!releasePolicy.force && Math.abs(finite(pose?.speedMps, record.currentSpeedMps))
                > policy.exitMaxSpeedMps) return false;
            if (pose) record.lastPose = { ...record.lastPose, ...pose, id: record.id };
            record.resumeSourceOsmId = releasePolicy.sourceOsmId ?? record.lastPose?.osmId ?? null;
            record.cruiseSpeedMps = Math.max(
                0,
                finite(releasePolicy.cruiseSpeedMps, record.cruiseSpeedMps),
            );
            record.currentSpeedMps = 0;
            record.speedMps = 0;
            record.state = AMBIENT_TRAM_STATES.EXITING;
            record.resumeAtMs = atMs + policy.dwellMs;
            record.doorTarget = 1;
            record.controlledVisible = true;
            return true;
        },
        cancelReservation(id) {
            const record = fleet.find(item => item.id === id);
            return cancelRecord(record);
        },
        destroy(id) {
            const record = fleet.find(item => item.id === id);
            if (!record) return false;
            record.state = AMBIENT_TRAM_STATES.DESTROYED;
            record.currentSpeedMps = 0;
            record.speedMps = 0;
            return true;
        },
        get(id) {
            const record = fleet.find(item => item.id === id);
            return record || null;
        },
        snapshot: () => fleet.map(record => ({
            ...record,
            lastPose: record.lastPose && { ...record.lastPose },
        })),
        dispose() {
            for (const record of fleet) {
                if (record.state === AMBIENT_TRAM_STATES.BOARDING_REQUESTED) cancelRecord(record);
                if (record.state === AMBIENT_TRAM_STATES.CONTROLLING) {
                    record.state = AMBIENT_TRAM_STATES.WAITING_FOR_PATH;
                    record.currentSpeedMps = 0;
                }
            }
            paths = [];
            pathById.clear();
            fleet = [];
        },
    };
}

export { projectPoseOntoPath };
