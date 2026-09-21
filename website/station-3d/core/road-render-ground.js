// Capture the compiled read graph used by a road's geometry, edging and paint.
// Model compilation and query capture remain cooperative; unchanged captures
// share one completed read view rather than copying it for every road feature.
import { CIVIL_GROUND_AUTHORITY } from './civil-ground-composition.js';
import { ROAD_FORMATION_QUERY_RADIUS_M } from './road-formation.js';
import { ownReadSnapshot, retainReadSnapshot } from './read-snapshot-lifetime.js';

export function roadRenderQueryBounds(feature, project) {
    const steps = roadRenderQueryBoundsSteps(feature, project);
    for (;;) { const next = steps.next(); if (next.done) return next.value; }
}

export function* roadRenderQueryBoundsSteps(feature, project, maxCoordinates = 1048576) {
    const bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
    const pending = [feature?.geometry?.coordinates, feature?.properties?.centerline_geometry?.coordinates];
    let count = 0, deadline = performance.now() + .5;
    while (pending.length) {
        const coordinates = pending.pop();
        if (!Array.isArray(coordinates)) continue;
        if (++count > maxCoordinates) throw Object.assign(new Error('Road bounds exceed coordinate capacity'), { code: 'ground-generation-capacity' });
        if (coordinates.length >= 2 && Number.isFinite(coordinates[0]) && Number.isFinite(coordinates[1])) {
            const { x, z } = project(coordinates[0], coordinates[1]);
            bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
            bounds.minZ = Math.min(bounds.minZ, z); bounds.maxZ = Math.max(bounds.maxZ, z);
        } else for (const child of coordinates) pending.push(child);
        if (performance.now() >= deadline) { yield { phase: 'road-source-bounds' }; deadline = performance.now() + .5; }
    }
    if (!Number.isFinite(bounds.minX)) return null;
    const padding = ROAD_FORMATION_QUERY_RADIUS_M + Math.max(0, Number(feature?.properties?.width_meters) || 6);
    return { minX: bounds.minX - padding, minZ: bounds.minZ - padding,
        maxX: bounds.maxX + padding, maxZ: bounds.maxZ + padding };
}

function intersectsChange(changes, bounds) {
    return changes.full || changes.bounds.some(b => b.minX <= bounds.maxX && b.maxX >= bounds.minX
        && b.minZ <= bounds.maxZ && b.maxZ >= bounds.minZ);
}

export function createRoadRenderGroundCapture({ railSurfaceOffsetY, roadSurfaceOffsetAtProfile }) {
    let compiledView = null;
    let latest = null;
    let pending = null;
    let epoch = 0;

    function* prepare({ terrain, civilGround, roadFormation, sourcesCurrent, preparedFormation = null,
        preparedRailFormation = undefined }) {
        const captureEpoch = epoch;
        if (!preparedFormation && latest?.terrainSource === terrain && latest.roadSource === roadFormation
            && latest.civilSource === civilGround && latest.view.isCurrent()) return latest.view;
        if (preparedFormation && (!Object.isFrozen(preparedFormation) || !preparedFormation.inputs?.context
            || !Object.isFrozen(preparedFormation.read) || typeof preparedFormation.isCurrent !== 'function')) {
            throw new TypeError('Prepared road rendering requires a formation publication read');
        }
        if (preparedRailFormation !== undefined && (!preparedFormation
            || preparedRailFormation !== null && (!Object.isFrozen(preparedRailFormation)
                || typeof preparedRailFormation.civilGroundSceneYAtLocal !== 'function'))) {
            throw new TypeError('Final rail receiver input requires a prepared road generation and a captured rail read');
        }
        if (!terrain) return ownReadSnapshot({ terrain: null, civilGround: null,
            roadFormation: null, verticalAlignments: null, isCurrent: () => captureEpoch === epoch && sourcesCurrent() }, []);
        if (!civilGround || !roadFormation?.captureBuildInputsSteps) {
            throw new TypeError('Road rendering requires explicit captured ground inputs');
        }
        while (!preparedFormation && roadFormation.hasPendingBuild()) {
            const status = roadFormation.stepPendingBuildPreparation();
            yield { phase: 'render-ground-formation', ...(status === 'held' ? { deferFrame: true } : {}) };
        }
        // Current source ground may have changed outside the compiled road
        // region. Paths use that source plus the captured civil providers;
        // compiled roads retain the inputs with which their profiles were built.
        const upstream = preparedFormation
            ? retainReadSnapshot(preparedFormation.inputs, 'road-render-inputs')
            : yield* roadFormation.captureBuildInputsSteps();
        let road = null, receiverRail = null, handedOff = false;
        try {
            const inputs = preparedFormation?.inputs || roadFormation.getPublishedBuildInputs();
            if (!inputs) throw new Error('Road formation has no completed input generation');
            const geometryRevision = roadFormation.surfaceGeometryRevision;
            const publicationRevision = roadFormation.surfacePublicationRevision;
            const sourceRevision = roadFormation.revision;
            const civilRevision = civilGround.registrationRevision;
            const isCurrent = () => captureEpoch === epoch && sourcesCurrent() && upstream.isCurrent()
                && (preparedFormation ? preparedFormation.isCurrent()
                    : !roadFormation.hasPendingBuild()
                        && roadFormation.getPublishedBuildInputs() === inputs
                        && roadFormation.surfaceGeometryRevision === geometryRevision
                        && roadFormation.surfacePublicationRevision === publicationRevision)
                && civilGround.registrationRevision === civilRevision;
            const cached = compiledView;
            if (preparedFormation) road = retainReadSnapshot(preparedFormation.read, 'road-render-query');
            else if (cached?.model === roadFormation && cached.inputs === inputs && cached.geometryRevision === geometryRevision
                && cached.publicationRevision === publicationRevision) road = retainReadSnapshot(cached.view, 'road-render-query');
            else {
                const view = yield* roadFormation.captureReadSnapshotSteps({ ...inputs.callbacks, readInputs: inputs,
                    replacementTerrainCutoutRegions: inputs.callbacks.replacementTerrainCutoutRegions?.() || [],
                });
                compiledView?.view.release?.();
                compiledView = { model: roadFormation, inputs, geometryRevision, publicationRevision, view };
                road = retainReadSnapshot(view, 'road-render-query');
            }
            const { terrain: ground, terrainReplacement, railFormation: constructionRail, verticalAlignments } = upstream.context;
            // Engineered road profiles retain the earlier rail construction
            // input. Paths, paint and final support consume the receiver after
            // road openings have withdrawn the conflicting rail faces.
            if (preparedRailFormation !== undefined) receiverRail = retainReadSnapshot(preparedRailFormation, 'road-render-rail-receiver');
            const rail = preparedRailFormation !== undefined ? receiverRail : constructionRail;
            const providers = new Map();
            if (civilGround.hasGroundAuthority(CIVIL_GROUND_AUTHORITY.RAIL)) {
                const sample = (x, z) => rail?.civilGroundSceneYAtLocal(x, z,
                    { surfaceOffsetY: railSurfaceOffsetY }) ?? null;
                providers.set(CIVIL_GROUND_AUTHORITY.RAIL, { id: 'rail-formation',
                    sampleSceneYAtLocal: sample, sampleEvidenceSceneYAtLocal: sample });
            }
            if (civilGround.hasGroundAuthority(CIVIL_GROUND_AUTHORITY.ROAD)) {
                const sample = (x, z) => road.civilGroundSceneYAtLocal(x, z,
                    { surfaceOffsetYAtProfile: roadSurfaceOffsetAtProfile });
                providers.set(CIVIL_GROUND_AUTHORITY.ROAD, { id: 'road-formation',
                    sampleSceneYAtLocal: sample, sampleEvidenceSceneYAtLocal: sample });
            }
            const civil = civilGround.captureReadSnapshot({ beforeAuthority: CIVIL_GROUND_AUTHORITY.PATH,
                terrainSceneYAtLocal: ground.sceneYAtLocal,
                terrainEvidenceSceneYAtLocal: ground.evidenceSceneYAtLocal, terrainReplacement, providers,
                ...(preparedFormation ? { preparedTerrainReplacement: terrainReplacement } : {}),
            });
            if (!isCurrent()) {
                const error = new Error('Ground changed while capturing road rendering inputs');
                error.code = 'road-render-ground-stale';
                throw error;
            }
            const view = ownReadSnapshot({ terrain: ground, civilGround: civil, roadFormation: road, railFormation: rail,
                constructionRailFormation: constructionRail,
                verticalAlignments, isCurrent,
                // Readiness changes elsewhere in the city must not restart every
                // partially sampled road. Check retained bounded histories only
                // when a revision advances; a truncated history fails closed.
                currentWithin(bounds) {
                    if (!bounds || preparedFormation) return isCurrent;
                    let source = sourceRevision, geometry = geometryRevision, publication = publicationRevision;
                    let valid = true;
                    return () => {
                        if (!valid || captureEpoch !== epoch || !sourcesCurrent() || !upstream.isCurrent()
                            || civilGround.registrationRevision !== civilRevision) return false;
                        if (source !== roadFormation.revision) {
                            valid = !intersectsChange(roadFormation.getChangesSince(source), bounds);
                            source = roadFormation.revision;
                        }
                        if (valid && geometry !== roadFormation.surfaceGeometryRevision) {
                            valid = !intersectsChange(roadFormation.getSurfaceGeometryChangesSince(geometry), bounds);
                            geometry = roadFormation.surfaceGeometryRevision;
                        }
                        if (valid && publication !== roadFormation.surfacePublicationRevision) {
                            valid = !intersectsChange(roadFormation.getSurfacePublicationChangesSince(publication), bounds);
                            publication = roadFormation.surfacePublicationRevision;
                        }
                        return valid;
                    };
                },
            }, [upstream, road, receiverRail]);
            if (!preparedFormation) {
                latest?.view.release();
                latest = { terrainSource: terrain, roadSource: roadFormation, civilSource: civilGround, view };
            }
            handedOff = true;
            return view;
        } finally {
            if (!handedOff) { upstream.release?.(); road?.release?.(); receiverRail?.release?.(); }
        }
    }

    const signature = args => [args.terrain?.revision, args.roadFormation?.revision,
        args.roadFormation?.surfacePublicationRevision, args.civilGround?.registrationRevision].join(':');
    function* capture(args) {
        // A coordinator owns this immutable graph. It must neither drain an
        // active model nor replace the ordinary producers' shared cache/job.
        if (args.preparedFormation) return yield* prepare(args);
        if (latest?.terrainSource === args.terrain && latest.roadSource === args.roadFormation
            && latest.civilSource === args.civilGround && latest.view.isCurrent()) return latest.view.retain(args.owner || 'surface-builder');
        const key = signature(args);
        if (!pending || pending.key !== key || pending.args.terrain !== args.terrain
            || pending.args.roadFormation !== args.roadFormation || pending.args.civilGround !== args.civilGround) {
            if (pending && !pending.done) {
                pending.iterator.return();
                pending.error = Object.assign(new Error('Road rendering capture superseded'), { code: 'road-render-ground-stale' });
                pending.done = true;
            }
            pending = { args, key, iterator: prepare(args), done: false, error: null, value: null, consumers: 0 };
        }
        const job = pending;
        job.consumers++;
        // Multiple tile queues share this iterator. Cancelling one consumer
        // only releases that consumer; another can finish the same preparation.
        try {
            while (!job.done) {
                try {
                    const next = job.iterator.next();
                    if (next.done) {
                        job.done = true;
                        job.value = next.value.retain('surface-build-waiters');
                        // A terrain-free capture has no persistent cache owner.
                        if (next.value !== latest?.view) next.value.release();
                    }
                    else yield next.value;
                } catch (error) { job.done = true; job.error = error; }
            }
            if (pending === job) pending = null;
            if (job.error) throw job.error;
            return job.value.retain(args.owner || 'surface-builder');
        } finally {
            if (--job.consumers === 0) {
                if (!job.done) { job.iterator.return(); job.done = true; }
                job.value?.release();
                if (pending === job) pending = null;
            }
        }
    }
    capture.clear = () => {
        epoch++;
        if (pending && !pending.done) {
            pending.iterator.return();
            pending.done = true;
            pending.error = Object.assign(new Error('Road rendering capture closed'), { code: 'road-render-ground-stale' });
        }
        pending?.value?.release();
        latest?.view.release();
        pending = latest = null;
        compiledView?.view.release?.();
        compiledView = null;
    };
    return capture;
}
