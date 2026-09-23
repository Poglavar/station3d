// The shared engine's dependency graph. Layer compilers prepare their ordinary
// geometry; this owner orders their captured reads and submits exactly one
// reversible publication, including the one shared Rapier reservation.
import { ownReadSnapshot, retainReadSnapshot } from '../core/read-snapshot-lifetime.js';
import { captureProposalMaskSnapshot } from './proposals.js';
import { createGroundGenerationCoordinator } from '../core/ground-generation-coordinator.js';
import { createGroundSourceAdmission } from '../core/ground-source-admission.js';
import { createHeldDeliveryWake } from '../core/held-delivery-wake.js';
import { initialWorldSupportTileKeys } from '../core/initial-world-support.js';
import { groundGenerationScope } from '../core/ground-generation-scope.js';
import { createPublishedGroundReadSlot } from '../core/published-ground-read.js';
import { prepareGroundConsumerSteps } from '../core/ground-consumer-preparation.js';
import { createFrameChunkQueue, FRAME_CHUNK_REPEAT_ITEM, FRAME_CHUNK_DEFER_ITEM,
    FRAME_CHUNK_WAIT_ITEM } from '../core/frame-chunk-queue.js';
import { GROUND_GENERATION_LIMITS } from '../core/ground-generation-limits.js';
import { prepareTerrainCutoutTilesSteps } from '../core/terrain-cutout-tiles.js';
import { registerBackgroundActivityReader } from '../core/background-activity.js';
import { isWorldBuilding, noteWorldMilestone } from '../core/world-ready.js';
import { createSurfaceOpeningReadSteps } from '../core/surface-opening-read.js';
import { SURFACE_CLASS, SURFACE_COVERAGE_STATE, SURFACE_VERTICAL_RELATION } from '../core/surface-hierarchy.js';
import { composeReceiverSupportReadsSteps } from '../core/receiver-support-read.js';
import {
    buildFormationTerrainCutoutQuerySteps,
    replaceTerrainCutoutLayerSources,
} from '../core/formation-terrain-cutout-query.js';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const GROUND_SOURCE_BATCH_TILES = 6;

// Admission pins source delivery and model inputs. Receiver admission follows
// preparation of the physical closure, before any receiver may be replaced.
// None of the source-current functions below consults a member's new state
// after promotion; the registry checks the complete graph before any mutation.
export function* prepareWorldGroundGenerationSteps(options) {
    // Source leases cannot change during one synchronous read-only visit.
    // Share the admission check within a compiler visit or a complete registry
    // preflight. Never retain it across yields, resource preparation or commits.
    let validationDepth = 0, cached = null;
    const readChecks = new Map();
    const withValidationScope = check => {
        validationDepth++;
        try { return check(); }
        finally { if (--validationDepth === 0) { cached = null; readChecks.clear(); } }
    };
    const checkSources = check => validationDepth ? (cached ??= check()) : check();
    const checkRead = check => {
        if (!validationDepth) return check();
        if (!readChecks.has(check)) readChecks.set(check, check());
        return readChecks.get(check);
    };
    const steps = prepareWorldGroundGraphSteps({ ...options, checkSources, checkRead });
    try {
        for (;;) {
            const next = withValidationScope(() => steps.next());
            if (next.done) {
                const candidate = next.value;
                return Object.freeze({ ...candidate, withValidationScope,
                    isCurrent: () => withValidationScope(candidate.isCurrent) });
            }
            yield next.value;
        }
    } finally { steps.return(); }
}

function* prepareWorldGroundGraphSteps({ ctx, layers, admission, scope, limits,
    registry, generation, isCurrent, checkSources, checkRead, receiverReadSlot = null }) {
    if (!ctx || !layers || !admission || !scope || !limits || !registry
        || !Number.isSafeInteger(generation) || generation <= 0 || typeof isCurrent !== 'function') {
        throw new TypeError('Ground preparation requires an admitted dependency graph');
    }
    const owned = [], ownedLabels = [], reads = [], entries = [], finalizers = [];
    let handedOff = false, settled = false, published = false;
    const sourceCurrent = () => !settled && isCurrent()
        && checkSources(() => Object.values(admission).every(value => !value?.isCurrent || value.isCurrent()));
    const check = () => { if (!sourceCurrent()) fail('ground-generation-stale', 'Ground source admission expired'); };
    function keep(resource, label = null) {
        if (!resource) fail('ground-dependency-busy', 'A required ground receiver is unavailable');
        // Completed receiver resources share input guards within the same
        // read-only compiler visit/preflight. Their entry commit/rollback and
        // lifetime operations run after that scope has been cleared.
        // Preserve the immutable publication contract and accessors (notably
        // its live prepared/committed state). Spreading a publication loses
        // both, which the downstream road capture correctly rejects.
        const guarded = resource.isCurrent
            ? Object.freeze(Object.defineProperties(Object.create(Object.getPrototypeOf(resource)), {
                ...Object.getOwnPropertyDescriptors(resource),
                isCurrent: { enumerable: true, value: () => checkRead(resource.isCurrent) },
            })) : resource;
        owned.push(guarded); ownedLabels.push(label); return guarded;
    }
    function metadata(key, resource) {
        if (resource.unchanged) return;
        entries.push({ ticket: registry.begin({ key, generation }), clear: true,
            isCurrent: resource.isCurrent, commit: resource.commit, rollback: resource.rollback,
            // One owner discards the complete graph after rollback.
            discard() {} });
    }
    const release = () => {
        const failures = [];
        for (const read of reads.splice(0).reverse()) {
            try { read?.release?.(); } catch (error) { failures.push(error); }
        }
        for (const value of Object.values(admission).reverse()) {
            try { value?.release?.(); } catch (error) { failures.push(error); }
        }
        if (failures.length) throw new AggregateError(failures, 'Ground source releases failed');
    };
    const discard = () => {
        if (settled || published) return false;
        settled = true;
        const failures = [];
        for (const entry of entries) {
            try { if (entry.ticket?.state === 'pending') entry.ticket.discard(); }
            catch (error) { failures.push(error); }
        }
        for (const resource of owned.reverse()) {
            try { if (resource.discard) resource.discard(); else resource.entry?.discard?.(); }
            catch (error) { failures.push(error); }
        }
        try { release(); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, 'Ground candidate cleanup failed');
        return true;
    };
    function* preparePhysics(families, prepareReadSteps) {
        const physics = keep(yield* prepareGroundConsumerSteps({ isCurrent: sourceCurrent, prepareReadSteps,
            capture() {
                const owner = ctx.getGroundPhysics?.();
                const ownerCurrent = () => ctx.getGroundPhysics?.() === owner;
                if (!owner) return { empty: true, isCurrent: ownerCurrent };
                const region = owner.admitGroundPublicationRegion(families, { allowEmpty: true });
                return region && { ...region, isCurrent: () => ownerCurrent() && region.isCurrent() };
            },
        }));
        if (physics.entry) entries.push({ ...physics.entry, ticket: registry.begin({ key: 'ground:physics', generation }) });
        return physics;
    }
    function* prepareTerrain(cutoutLayers) {
        const cutTiles = yield* prepareTerrainCutoutTilesSteps(cutoutLayers, admission.terrain.rows, {
            tileM: limits.terrainPublication.tileM, maxRegions: limits.cutout.limits.maxSources,
            maxVertices: limits.cutout.limits.maxSourceVertices });
        const terrain = keep(yield* layers.terrain.prepareGroundGenerationSteps({ admission: admission.terrain,
            publishedTerrain: ctx.publishedTerrain,
            cutoutForTile: row => ({ ...cutTiles.get(row.key), ...limits.cutout }),
            ...limits.terrain, isCurrent: sourceCurrent }));
        entries.push(...terrain.entries);
        return terrain;
    }
    function complete(resources, usage) {
        const validity = () => {
            const ownedState = owned.map((resource, index) => ({ index, label: ownedLabels[index],
                current: !resource.isCurrent || resource.isCurrent(),
                entries: resource.entries?.length ?? (resource.entry ? 1 : 0),
                unchanged: resource.unchanged === true,
                details: resource.currentDetails?.() }));
            const entryState = entries.map((entry, index) => ({ index, key: entry.ticket?.key || null,
                current: !entry.isCurrent || entry.isCurrent() }));
            const invalidOwned = ownedState.filter(item => !item.current);
            const invalidEntries = entryState.filter(item => !item.current);
            return {
                source: sourceCurrent(),
                admission: Object.fromEntries(Object.entries(admission).map(([key, value]) => [
                    key, !value?.validate || value.validate(),
                ])),
                owned: invalidOwned.slice(0, 16),
                ownedInvalidCount: invalidOwned.length,
                entries: invalidEntries.slice(0, 16),
                entryInvalidCount: invalidEntries.length,
            };
        };
        const validityCurrent = state => state.source
            && Object.values(state.admission).every(Boolean)
            && state.ownedInvalidCount === 0
            && state.entryInvalidCount === 0;
        const allCurrent = () => validityCurrent(validity());
        const beforePublication = validity();
        if (!validityCurrent(beforePublication)) throw Object.assign(
            new Error('Ground changed before complete publication'),
            { code: 'ground-generation-stale', details: { validity: beforePublication } },
        );
        const cleanupTicket = registry.begin({ key: 'ground:generation', generation });
        entries.push({ ticket: cleanupTicket, clear: true, isCurrent: sourceCurrent,
            commit: () => true, rollback() {}, discard });
        handedOff = true;
        return Object.freeze({ entries, isCurrent: allCurrent, discard,
            usage: Object.freeze({ ...usage, entries: entries.length }),
            finalize() {
                if (settled || published) return false;
                published = true;
                const errors = [];
                for (const resource of resources) {
                    try {
                        if (resource?.finalize() === false) throw new Error('Published ground member did not finalize');
                    } catch (error) { errors.push(error); }
                }
                settled = true;
                try { release(); } catch (error) { errors.push(error); }
                if (errors.length) throw new AggregateError(errors, 'Published ground generation cleanup failed');
                return true;
            } });
    }
    try {
        check();
        if (scope.curbsOnly) {
            // Curbs are a dependency leaf. Their masks were admitted above;
            // the completed physical receiver graph stays exactly as published.
            const ground = admission.receivers;
            if (!ground) fail('ground-dependency-busy', 'Published curb inputs are unavailable');
            const tileKeys = yield* layers.curbs.groundTileKeysSteps({ bounds: scope.curbBounds,
                keys: scope.curbSourceKeys, full: scope.curbFull, ...limits.curbs });
            const curbs = keep(yield* layers.curbs.prepareGroundGenerationSteps({ tileKeys,
                ground, ...limits.curbs, isCurrent: sourceCurrent }));
            entries.push(...curbs.entries);
            const physics = yield* preparePhysics(['curb-surfaces'], function* () {
                return { isCurrent: curbs.isCurrent, reads: { 'curb-surfaces': curbs.curbSurfaceRead } };
            });
            return complete([physics, curbs], { curbs: { tiles: tileKeys.length },
                reusedReceivers: true, physics: !!physics.entry });
        }
        if (scope.terrainWindowOnly) {
            // Residency changes reuse the published physical design, while
            // recentering the bounded rail receiver and its exact terrain
            // openings. Coordinated mode disables rails' ordinary onFrame
            // rebuild; omitting this leaf left track/cuts fixed at the spawn
            // window while the cab and terrain continued across the country.
            const ground = admission.receivers;
            if (!ground?.terrainCutoutLayers) {
                fail('ground-dependency-busy', 'Published terrain-window inputs are unavailable');
            }
            if (!admission.rails) fail('ground-dependency-busy', 'Rail window admission is pending');
            const proposalMask = captureProposalMaskSnapshot();
            const railGround = ownReadSnapshot({ ...ground, terrain: admission.terrain.read,
                proposalMask, roadSupportCacheSource: ctx.roadFormation,
                isCurrent: () => ground.isCurrent() && proposalMask.isCurrent() },
            [retainReadSnapshot(ground, 'ground-window-rail-receiver')]);
            reads.push(railGround);
            const rails = keep(yield* layers.rails.prepareGroundGenerationSteps({ admission: admission.rails,
                ground: railGround, centerX: scope.centerX, centerZ: scope.centerZ,
                ...limits.railReceivers, isCurrent: sourceCurrent }));
            entries.push(...rails.entries);
            const railCutout = yield* buildFormationTerrainCutoutQuerySteps({
                models: [ground.railFormation, rails.renderedRailSurface],
                modelSources: ['rail-formation', 'rail-rendered'],
                centerX: scope.centerX, centerZ: scope.centerZ, radiusM: limits.ownership.radiusM,
                terrainSceneYAtLocal: admission.terrain.read.evidenceSceneYAtLocal,
            });
            const terrainCutoutLayers = replaceTerrainCutoutLayerSources(
                ground.terrainCutoutLayers,
                railCutout.layers,
                ['rail-formation', 'rail-rendered'],
            );
            const terrain = yield* prepareTerrain(terrainCutoutLayers);
            const readPublication = receiverReadSlot ? keep(receiverReadSlot.begin({ isCurrent: sourceCurrent })) : null;
            if (readPublication) {
                const nextReceivers = ownReadSnapshot({ ...ground, terrain: admission.terrain.read,
                    renderedRailSurface: rails.renderedRailSurface, terrainCutoutLayers,
                    isCurrent: sourceCurrent }, [retainReadSnapshot(ground, 'ground-window-receivers')]);
                reads.push(nextReceivers);
                readPublication.bindRead(nextReceivers);
                metadata('ground:receiver-queries', readPublication);
            }
            const physics = yield* preparePhysics(
                ['terrain', 'rail-trackbed', 'rail-formation-dressings'],
                function* () {
                return { isCurrent: terrain.isCurrent, reads: {
                    terrain: { terrain: terrain.terrain, terrainSource: ctx.terrain },
                    'rail-trackbed': rails.railTrackbedRead,
                    'rail-formation-dressings': rails.railFormationDressingRead,
                } };
            });
            return complete([physics, rails, terrain, readPublication], { terrain: terrain.usage,
                rails: { recentered: true },
                reusedReceivers: true, physics: !!physics.entry });
        }
        // Unchanged road profiles may retain older design inputs. The active
        // receiver graph owns the latest construction snapshot, independently
        // of those profiles and of final rail ownership after road cutouts.
        const previousReceivers = admission.receivers
            || receiverReadSlot?.capture('ground-construction-predecessor');
        if (previousReceivers && previousReceivers !== admission.receivers) reads.push(previousReceivers);
        const readPublication = receiverReadSlot ? keep(receiverReadSlot.begin({ isCurrent: sourceCurrent }), 'receiver-publication') : null;
        const terrain = admission.terrain.read;
        let replacement = ctx.civilGround.captureTerrainReplacementReadSnapshot();
        const construction = keep(yield* layers.rails.prepareConstructionGroundSteps({ admission: admission.rails,
            terrain, previous: previousReceivers?.constructionRailFormation,
            changedBounds: scope.terrainBounds, reusePublished: scope.reusePublishedRail === true,
            ...limits.railConstruction, isCurrent: sourceCurrent }), 'rail-construction');
        const openingResources = [];
        for (const [name, layer] of Object.entries(layers)) if (layer.prepareOpeningGroundSteps) {
            const resource = keep(yield* layer.prepareOpeningGroundSteps({ terrain, registry, generation, isCurrent: sourceCurrent }), `${name}:openings`);
            openingResources.push(resource); entries.push(...resource.entries); finalizers.push(resource);
        }
        // Access floors depend on rail construction, while road/rail receiver
        // clipping depends on those floors. Keep this direction explicit.
        for (const [name, layer] of Object.entries(layers)) if (layer.prepareConstructionOpeningGroundSteps) {
            const resource = keep(yield* layer.prepareConstructionOpeningGroundSteps({ terrain,
                railFormation: construction.read, centerX: scope.centerX, centerZ: scope.centerZ,
                registry, generation, isCurrent: sourceCurrent }), `${name}:construction-openings`);
            openingResources.push(resource); entries.push(...resource.entries); finalizers.push(resource);
        }
        const openingOwners = new Set(openingResources.flatMap(resource => resource.portalOwnerIds || []));
        const portals = Object.freeze([
            ...(ctx.authoredRoadPortalReplacements || []).filter(value => !openingOwners.has(value.ownerId)),
            ...openingResources.flatMap(resource => resource.portals || []),
        ].map(value => Object.freeze({ ...value })));
        const openings = openingResources.length ? yield* createSurfaceOpeningReadSteps({
            authored: openingResources.flatMap(resource => resource.authored || []),
            entrances: openingResources.flatMap(resource => resource.entrances || []),
            planner: openingResources.flatMap(resource => resource.planner || []),
            water: openingResources.flatMap(resource => resource.water || []),
            limits: limits.openings, isCurrent: () => readPublication?.published ? readPublication.queryCurrent()
                : sourceCurrent() && openingResources.every(resource => resource.isCurrent()),
        }) : null;
        const openingReceivers = [];
        for (const [index, resource] of openingResources.entries()) if (resource.prepareOpeningReceiversSteps) {
            const receivers = keep(yield* resource.prepareOpeningReceiversSteps({ openings }), `openings:${index}:receivers`);
            openingReceivers.push(receivers); entries.push(...receivers.entries); finalizers.push(receivers);
            if (Object.hasOwn(receivers, 'terrainReplacement')) replacement = receivers.terrainReplacement;
        }
        const openingSupport = [...openingResources, ...openingReceivers].map(resource => resource.supportRead).filter(Boolean);
        yield* layers.roads.prepareAlignmentSourcesGroundSteps({ terrain, railFormation: construction.read,
            terrainBounds: scope.terrainBounds,
            composedBounds: openingReceivers.flatMap(resource => resource.changedBounds || []),
            ...limits.alignmentSources, isCurrent: sourceCurrent });
        // The sea mask is already assembled above; alignments need it to tell a
        // pier the DTM cannot ground from terrain that has yet to stream in.
        const alignmentTx = yield* ctx.roadVerticalAlignments.preparePublicationSteps({ terrainRead: terrain,
            mappedWater: openingResources.find(resource => resource.mappedWater)?.mappedWater || null,
            authoredPortalReplacements: portals, isCurrent: sourceCurrent });
        let alignment;
        if (alignmentTx) {
            keep(alignmentTx, 'road-alignments'); metadata('ground:road-alignments', alignmentTx); alignment = alignmentTx.read;
            finalizers.push(alignmentTx);
        } else {
            alignment = yield* ctx.roadVerticalAlignments.captureReadSnapshotSteps({ authoredPortalReplacements: portals });
            reads.push(alignment);
        }
        check();
        const road = keep(yield* layers.roads.prepareFormationGroundSteps({ terrain, railFormation: construction.read,
            verticalAlignments: alignment, terrainReplacement: replacement, isCurrent: sourceCurrent }), 'road-formation');
        metadata('ground:road-formation', road); finalizers.push(road);
        const receiverBounds = [...(scope.receiverBounds || []),
            ...[...openingResources, ...openingReceivers].flatMap(resource => resource.changedBounds || [])];
        const roadGeometryBounds = [...(scope.roadGeometryBounds || []),
            ...[...openingResources, ...openingReceivers].flatMap(resource => resource.changedBounds || [])];
        // Include both old and new collars, even when a neighbour's paved
        // footprint does not intersect the triggering source tile.
        for (const model of [ctx.roadFormation, road.read]) for (const profile of model.getSurfaceProfiles()) {
            if (profile.bounds && ctx.roadFormation.getSurfaceGeometryGeneration(profile.osmId)
                !== road.read.getSurfaceGeometryGeneration(profile.osmId)) {
                receiverBounds.push(profile.bounds); roadGeometryBounds.push(profile.bounds);
            }
            yield { phase: 'ground-road-profile-closure' }; check();
        }
        const ownership = keep(yield* layers.rails.prepareOwnershipGroundSteps({ admission: admission.rails,
            construction, roadFormation: road.read, verticalAlignments: alignment,
            retainedCrossings: scope.retainedCrossings, retainedOpenings: scope.retainedOpenings,
            ...limits.railOwnership, isCurrent: sourceCurrent }), 'rail-ownership');
        // A rail collar, wall or road opening can move outside the source tile
        // and outside the road's own top. Withdraw old support and rebuild the
        // complete new footprint, including unchanged neighbouring curb tiles.
        for (const bounds of ownership.changedBounds) {
            receiverBounds.push(bounds); roadGeometryBounds.push(bounds);
            yield { phase: 'ground-rail-profile-closure' }; check();
        }
        const baseGround = yield* layers.roads.capturePreparedGroundSteps('ground-generation', road, ownership.read);
        if (!baseGround) fail('ground-dependency-busy', 'Prepared road queries are unavailable');
        reads.push(baseGround);
        const ground = openings ? ownReadSnapshot({ ...baseGround, openings,
            mappedWater: openingResources.find(resource => resource.mappedWater)?.mappedWater,
            isCurrent: () => baseGround.isCurrent() && openings.isCurrent() },
        [retainReadSnapshot(baseGround, 'ground-opening-receivers')]) : baseGround;
        if (ground !== baseGround) reads.push(ground);
        const structures = keep(yield* layers.structures.prepareGroundGenerationSteps({ admission: admission.structures,
            ground, additionalAlignmentIds: scope.structureIds,
            openingChangedBounds: [...openingResources, ...openingReceivers].flatMap(resource => resource.changedBounds || []),
            ...limits.structures, isCurrent: sourceCurrent }), 'road-structures');
        entries.push(...structures.entries);
        const previousOpenings = ctx.surfaceOpeningRead;
        const openingQueries = keep({ unchanged: openings === previousOpenings,
            isCurrent: () => ctx.surfaceOpeningRead === previousOpenings,
            commit() { ctx.surfaceOpeningRead = openings; return true; },
            rollback() { ctx.surfaceOpeningRead = previousOpenings; }, discard() {} }, 'opening-queries');
        metadata('ground:opening-queries', openingQueries);
        const proposalMask = captureProposalMaskSnapshot();
        const railGround = ownReadSnapshot({ terrain: ground.terrain, roadFormation: ground.roadFormation,
            railFormation: ground.railFormation, verticalAlignments: ground.verticalAlignments,
            mappedWater: ground.mappedWater,
            roadSupportCacheSource: ctx.roadFormation, proposalMask, openings,
            isCurrent: () => ground.isCurrent() && proposalMask.isCurrent() }, [retainReadSnapshot(ground, 'ground-rail-receivers')]);
        reads.push(railGround);
        const rails = keep(yield* layers.rails.prepareGroundGenerationSteps({ admission: admission.rails,
            ground: railGround, centerX: scope.centerX, centerZ: scope.centerZ,
            formationPublication: ownership.formationPublication, additionalEntries: ownership.additionalEntries,
            ...limits.railReceivers, isCurrent: sourceCurrent }), 'rail-receivers');
        entries.push(...rails.entries);
        const receiverGround = ownReadSnapshot({ ...ground, structurePublications: structures.structurePublications,
            renderedRailSurface: rails.renderedRailSurface,
            isCurrent: () => ground.isCurrent() && structures.isCurrent() && rails.isCurrent() },
        [retainReadSnapshot(ground, 'ground-road-curb-receivers')]);
        reads.push(receiverGround);
        // Select receiver ownership after the physical dependency closure is
        // known. Aggregate preparation below adds unchanged bucket neighbours
        // as needed, without recompiling unrelated source owners.
        // One evidence scope per generation: road admission defers owners past it,
        // and the terrain cut must skip exactly those owners' profiles.
        const terrainEvidence = nonEmptyEvidenceScope(layers.terrain.captureEvidenceScope?.());
        if (!admission.roads) {
            const roadKeys = [];
            for (const key of layers.roads.groundSourceKeys()) {
                if (roadKeys.length >= limits.roadAdmission.maxFeatures) fail('ground-generation-capacity', 'Road source closure exceeds capacity');
                roadKeys.push(key);
                yield { phase: 'ground-road-source-closure' }; check();
            }
            admission.roads = yield* layers.roads.admitGroundGenerationSteps(roadKeys, {
                ...limits.roadAdmission, ground: receiverGround,
                changedBounds: roadGeometryBounds, full: scope.full, isCurrent,
                terrainEvidence });
            if (!admission.roads) fail('ground-dependency-busy', 'Road source admission is pending');
        }
        const roads = keep(yield* layers.roads.prepareGroundGenerationSteps({ admission: admission.roads,
            ground: receiverGround, generation,
            changedBounds: roadGeometryBounds, full: scope.full, ...limits.roadReceivers, isCurrent: sourceCurrent, checkRead }), 'road-receivers');
        entries.push(...roads.entries);
        // Urban coast classification consumes actual prepared road faces.
        // Its support joins this same generation's authored collider table.
        for (const [index, resource] of openingResources.entries()) if (resource.prepareRoadReceiversSteps) {
            const receivers = keep(yield* resource.prepareRoadReceiversSteps({ roads, openings,
                centerX: scope.centerX, centerZ: scope.centerZ }), `openings:${index}:road-receivers`);
            entries.push(...receivers.entries); finalizers.push(receivers);
            if (receivers.supportRead) openingSupport.push(receivers.supportRead);
        }
        const curbTileKeys = scope.curbTileKeys || (yield* layers.curbs.groundTileKeysSteps({
            bounds: [...receiverBounds, ...(scope.curbBounds || [])], keys: scope.curbSourceKeys,
            full: scope.full || scope.curbFull, ...limits.curbs }));
        const curbs = keep(yield* layers.curbs.prepareGroundGenerationSteps({ tileKeys: curbTileKeys,
            ground: receiverGround, ...limits.curbs, isCurrent: sourceCurrent }), 'curbs');
        entries.push(...curbs.entries);
        const mask = keep(yield* layers.terrain.prepareOwnershipGroundSteps({ ground: receiverGround,
            roadReceivers: roads, railReceivers: rails, structureReceivers: structures,
            centerX: scope.centerX, centerZ: scope.centerZ, ...limits.ownership, terrainEvidence, isCurrent: sourceCurrent }), 'terrain-ownership');
        for (const [index, resource] of openingResources.entries()) if (resource.prepareTerrainReceiversSteps) {
            const receivers = keep(yield* resource.prepareTerrainReceiversSteps({ cutoutLayers: mask.cutoutQuery.layers, openings }), `openings:${index}:terrain-receivers`);
            entries.push(...receivers.entries); finalizers.push(receivers);
            if (receivers.supportRead) openingSupport.push(receivers.supportRead);
        }
        const previousAuthoredRead = ctx.authoredSurfaceRead;
        const authoredSurfaceRead = yield* composeReceiverSupportReadsSteps(previousAuthoredRead,
            [...openingSupport, structures.supportRead].filter(Boolean), { ...limits.support, isCurrent: sourceCurrent });
        const authoredSupport = keep({ unchanged: authoredSurfaceRead === previousAuthoredRead,
            isCurrent: () => ctx.authoredSurfaceRead === previousAuthoredRead,
            commit() { ctx.authoredSurfaceRead = authoredSurfaceRead; return true; },
            rollback() { ctx.authoredSurfaceRead = previousAuthoredRead; }, discard() {} }, 'authored-support');
        metadata('ground:authored-support', authoredSupport);
        const openingTerrainLayers = openings ? yield* openings.terrainLayersSteps({ surfaceClass: SURFACE_CLASS.TERRAIN,
            coverageState: SURFACE_COVERAGE_STATE.PUBLISHED, verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL }) : [];
        const terrainCutoutLayers = Object.freeze([...mask.cutoutQuery.layers, ...openingTerrainLayers]);
        const nextTerrain = yield* prepareTerrain(terrainCutoutLayers);
        entries.push(mask.entry);
        check();
        const physics = yield* preparePhysics(PHYSICS_FAMILIES, function* (region, isCurrent) {
                const roadRead = yield* roads.captureRoadSurfaceReadSteps(region.bounds, isCurrent);
                if (!roadRead) return null;
                // This read's dependency closure can contain thousands of
                // road owners. Its inputs cannot change inside one synchronous
                // compiler visit; do not rescan them for every terrain vertex.
                // Physics table/lease checks remain live. The scope ends at
                // every yield and before any publication mutation.
                return { isCurrent: () => checkRead(roadRead.isCurrent), release: roadRead.release, reads: {
                terrain: { terrain: nextTerrain.terrain, terrainSource: ctx.terrain },
                'road-surfaces': { ...roadRead, ground: receiverGround,
                    formationSource: ctx.roadFormation, sourceRevision: road.read.revision },
                'formation-dressings': { formation: road.read, formationSource: ctx.roadFormation,
                    sourceRevision: road.read.revision },
                'rail-trackbed': rails.railTrackbedRead,
                'rail-formation-dressings': rails.railFormationDressingRead,
                'curb-surfaces': curbs.curbSurfaceRead,
                'authored-surfaces': authoredSurfaceRead,
                } };
        });
        if (readPublication) {
            readPublication.bindRead(Object.freeze({ ...receiverGround, terrainCutoutLayers }));
            metadata('ground:receiver-queries', readPublication);
        }
        return complete([physics, ...finalizers, rails, ownership, structures, roads, curbs, mask, nextTerrain, readPublication],
            { terrain: nextTerrain.usage, roads: roads.usage,
                structures: structures.usage, railConstruction: construction.usage,
                support: authoredSurfaceRead.usage, physics: !!physics.entry });
    } finally { if (!handedOff) discard(); }
}

// The shared road sources one ground admission seals together.
const GROUND_ROAD_SOURCE_KEYS = Object.freeze(['roads:cab', 'roads:graph', 'roads:vertical-alignments', 'roads:curbs']);

// No requested terrain yet means no scope to judge by, not "defer everything":
// deferring every road at bootstrap would reveal a world without roads.
const nonEmptyEvidenceScope = scope => (scope?.tileCount > 0 ? scope : null);

const PHYSICS_FAMILIES = Object.freeze(['terrain', 'road-surfaces', 'formation-dressings',
    'rail-trackbed', 'rail-formation-dressings', 'curb-surfaces', 'authored-surfaces']);

export function createWorldGroundGenerations({ ctx, layers, isCurrent,
    limits = GROUND_GENERATION_LIMITS }) {
    if (!ctx.terrainSource || !ctx.publishedTerrain) throw new TypeError('Ground coordinator requires the terrain source and published provider');
    const queue = createFrameChunkQueue({ label: 'ground-generation', frameBudgetMs: 6,
        // This compiler now owns terrain, road, rail and curb preparation.
        // A single old layer's 2 ms cap strands the shared near-world allowance
        // while its consumers wait. Class sharing, scene headroom and charged
        // work still bound each turn (including the smaller transit allowance).
        // The larger reservation below applies only to the opaque loading hold.
        stationaryReservationMs: 16, pauseDuringMovement: false, preferAnimationFrame: true,
        // One coordinated generation is the critical path for making all
        // prepared road, rail and terrain receivers visible. Give it most of
        // the surface slice while it can compile. Explicit dependency waits
        // release that share back to the source queues below.
        trackWorldReady: true, workClass: 'near', workTier: 'surface', workWeight: 12,
        criticalPath: true });
    let managed = false, closed = false;
    const receiverReadSlot = createPublishedGroundReadSlot();
    let coordinator, drainingSources = null;
    const windowFamilies = new Set(['terrain-window', 'ground-window']);
    const windowAdmission = Object.freeze({ isCurrent: () => !closed, release() {} });
    const layerBlockers = () => Object.entries(layers)
        .filter(([, layer]) => layer.groundReady() !== true)
        .map(([name]) => name);
    function admitSources({ changes = [] } = {}) {
        // Terrain residency reuses the already published receiver graph. It
        // neither needs nor should wait for a road/rail source drain that it
        // deliberately leaves pending for the next physical generation.
        if (changes.length && changes.every(change => windowFamilies.has(change.family))) return windowAdmission;
        if (!drainingSources) {
            const sourceKeys = [...ctx.sharedTileSession.sourceKeys()].filter(key =>
                GROUND_ROAD_SOURCE_KEYS.includes(key));
            // Seal input delivery before waiting for the existing builders.
            // Waiting for every builder first let an initial corridor keep
            // extending their work and delayed the shared engine's first turn.
            // All four sources must exist, including the curb dependency root.
            if (sourceKeys.length !== 4) return null;
            // Existing deliveries run through their normal queues. New ones
            // are held, so a continuous stream cannot move this boundary or
            // starve the next generation. Layer readiness covers asynchronous
            // source registration after each callback has returned.
            const requestedTileKeys = managed
                ? ctx.sharedTileSession.capturePrioritySourceTileKeys?.('roads:curbs', {
                    maxTiles: Math.min(GROUND_SOURCE_BATCH_TILES, limits.curbs.maxTiles),
                    includeTileKeys: [],
                }) ?? null
                : [...initialWorldSupportTileKeys()];
            drainingSources = createGroundSourceAdmission({ session: ctx.sharedTileSession,
                sourceKeys, firstSources: ['roads:curbs'], maxDependencyTiles: limits.curbs.maxTiles,
                // Seal the finite requested corridor even for the bootstrap
                // generation. A network request can already be queued/fetching
                // before it owns a callback sequence; draining callbacks alone
                // therefore allowed the first publication to compile zero road
                // owners while the visible road tiles were still in flight.
                // Bootstrap needs only the four observer-support tiles; the
                // long route corridor remains a successor behind the revealed
                // world. Managed generations seal their complete requested
                // corridor in small visibility-priority batches. This keeps a
                // route-ahead request burst from becoming one minute-long
                // road transaction while preserving one shared publication path.
                drainRequested: true,
                requestedTileKeys,
                captureDependencies: () => layers.curbs.groundSourceDependencies({ maxTiles: limits.curbs.maxTiles }),
                layersReady: () => layerBlockers().length === 0 });
        }
        try {
            const result = drainingSources.poll();
            if (result) {
                if (!managed) {
                    for (const layer of Object.values(layers)) layer.manageGroundPublications(coordinator);
                    managed = true;
                }
                drainingSources = null;
            }
            return result;
        } catch (error) { drainingSources?.release(); drainingSources = null; throw error; }
    }
    function* prepare({ admission: sources, changes, local, generation, isCurrent: current }) {
        const admission = { sources };
        let handedOff = false;
        try {
            const windowOnly = changes.length > 0 && changes.every(change => windowFamilies.has(change.family));
            const reusePublishedRail = changes.length > 0 && receiverReadSlot.hasActive()
                && changes.every(change => !['bootstrap', 'rails', 'planner', 'stations'].includes(change.family));
            const ready = windowOnly ? layers.terrain.groundReady() : Object.values(layers).every(layer => layer.groundReady());
            if (!sources.isCurrent() || !ready) {
                fail('ground-dependency-busy', 'Ground layers are finishing their current work');
            }
            const changedScope = groundGenerationScope(changes, limits.terrainPublication.tileM);
            if (changes.length && changes.every(change => change.family === 'curbs') && receiverReadSlot.hasActive()) {
                admission.receivers = receiverReadSlot.capture('curb-generation');
                const candidate = yield* prepareWorldGroundGenerationSteps({ ctx, layers, admission,
                    scope: { ...changedScope, curbsOnly: true }, registry: ctx.surfacePublications,
                    generation, limits, isCurrent: current });
                handedOff = true; return candidate;
            }
            const terrainScope = yield* layers.terrain.groundScopeSteps(limits.terrainPublication);
            admission.terrain = layers.terrain.admitGroundGeneration({ ...terrainScope,
                maxChangedTiles: limits.terrainPublication.maxChangedTiles, isCurrent: current });
            if (windowOnly && receiverReadSlot.hasActive()) {
                const receivers = receiverReadSlot.capture('terrain-window-generation');
                if (receivers.terrainCutoutLayers) {
                    admission.receivers = receivers;
                    admission.rails = layers.rails.admitWindowGroundGeneration({ isCurrent: current });
                    if (!admission.rails) fail('ground-dependency-busy', 'Rail window admission is pending');
                    const candidate = yield* prepareWorldGroundGenerationSteps({ ctx, layers, admission,
                        scope: { ...changedScope, terrainWindowOnly: true, centerX: local.x, centerZ: local.z }, registry: ctx.surfacePublications,
                        generation, limits, isCurrent: current, receiverReadSlot });
                    handedOff = true; return candidate;
                }
                receivers.release();
            }
            if (reusePublishedRail) {
                admission.receivers = receiverReadSlot.capture('road-priority-generation');
                admission.rails = layers.rails.admitWindowGroundGeneration({ isCurrent: current,
                    constructionInputs: admission.receivers.constructionRailFormation?.constructionInputs });
            } else admission.rails = yield* layers.rails.admitGroundGenerationSteps({ ...limits.railAdmission,
                terrainRead: admission.terrain.read, isCurrent: current });
            if (!admission.rails) fail('ground-dependency-busy', 'Rail source admission is pending');
            admission.structures = layers.structures.admitGroundGeneration({ isCurrent: current });
            const candidate = yield* prepareWorldGroundGenerationSteps({ ctx, layers, admission,
                scope: { ...changedScope, reusePublishedRail,
                    centerX: local.x, centerZ: local.z, retainedCrossings: [], retainedOpenings: [], structureIds: [] },
                registry: ctx.surfacePublications, generation, limits, isCurrent: current, receiverReadSlot });
            handedOff = true;
            return candidate;
        } finally {
            if (!handedOff) {
                const errors = [];
                for (const value of Object.values(admission).reverse()) {
                    try { value?.release?.(); } catch (error) { errors.push(error); }
                }
                if (errors.length) throw new AggregateError(errors, 'Ground admission releases failed');
            }
        }
    }
    coordinator = createGroundGenerationCoordinator({ queue, repeat: FRAME_CHUNK_REPEAT_ITEM,
        defer: FRAME_CHUNK_DEFER_ITEM, wait: FRAME_CHUNK_WAIT_ITEM,
        registry: ctx.surfacePublications, boundary: ctx.groundPublications, admit: admitSources, prepareSteps: prepare,
        windowMoveM: 400, priorityFamilies: [...windowFamilies, 'terrain', 'rails', 'roads'],
        onPublished: () => {
            // Track and road geometry become visible at this same atomic
            // publication boundary. Their source queues can drain much
            // earlier while the coordinated receiver graph is still private.
            noteWorldMilestone('first-ground-publication');
            noteWorldMilestone('track-ready');
            noteWorldMilestone('roads-ready');
        },
        // Source changes must remain publishable during motion. The bounded
        // queue already reserves interactive headroom. A moving window remains
        // the next priority generation, but must not cancel a physical one in
        // progress: at 70 km/h the 400 m window trigger fires about every 20 s,
        // sooner than the Split rail/road closure can finish, so preemption
        // starved roads whose source tiles were already resident. The physical
        // generation starts at the route-ahead midpoint and safely retains the
        // published predecessor while later window requests coalesce behind it.
        isCurrent });
    layers.terrain.connectGroundCoordinator(coordinator);
    // A published generation leaves later road callbacks behind its delivery
    // barrier. Moving observers wake the next admission through window/source
    // changes; a stationary one needs this, or the tiles never arrive. Not
    // behind the loading curtain: reveal waits for the observer tiles only,
    // and the corridor is deliberately a successor of the revealed world.
    const heldDeliveryWake = createHeldDeliveryWake({
        countHeld: () => ctx.sharedTileSession.heldSourceDeliveries?.(GROUND_ROAD_SOURCE_KEYS) || 0,
        isIdle: () => managed && !drainingSources && !isWorldBuilding() && coordinator.isSettled(),
        publishedCount: () => coordinator.snapshot().published,
        wake: () => coordinator.invalidate('roads', { reason: 'held-source-deliveries' }),
    });
    coordinator.invalidate('bootstrap');
    const unregister = registerBackgroundActivityReader(() => ({ kind: 'build', label: 'ground-generation-owner',
        ...coordinator.snapshot() }));
    return Object.freeze({ invalidate: coordinator.invalidate, isSettled: coordinator.isSettled,
        // Inspectors and derived producers can retain the published design
        // inputs and exact cut recipe. This is not a physical support query;
        // final road/terrain triangle readers own that separate contract.
        capturePublishedRead: receiverReadSlot.capture,
        snapshot: () => ({ ...coordinator.snapshot(), managed,
        layerBlockers: managed ? [] : layerBlockers(),
        drainingSources: !!drainingSources, receiverReads: receiverReadSlot.snapshot(),
        heldDeliveries: heldDeliveryWake.snapshot() }),
        onFrame(local) {
            if (closed) return;
            coordinator.onFrame(local);
            heldDeliveryWake.onFrame();
        },
        close() { if (closed) return; closed = true;
            try { coordinator.close(); }
            finally { drainingSources?.release(); drainingSources = null;
                ctx.authoredSurfaceRead = undefined; ctx.surfaceOpeningRead = undefined;
                try { receiverReadSlot.close(); } finally { queue.dispose(); unregister(); } }
        },
    });
}
