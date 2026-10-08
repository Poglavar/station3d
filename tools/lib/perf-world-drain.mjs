// World liveness evidence used before phases and after movement/reopen.
export function captureGroundDrainSample(previousPublication = null) {
    const cab = window.__st3dDebug?.state?.cabState;
    const ground = cab?.groundGenerations?.snapshot?.();
    const network = cab?.layerCtx?.sharedTileSession?.getNetworkDebugState?.();
    const tileSources = cab?.layerCtx?.sharedTileSession?.getDebugState?.();
    const paint = cab?.groundPaint?.snapshot?.();
    const scheduler = window.__s3dStreamingReport?.()?.scheduler;
    const trace = window.__perfTrace?.();
    const queues = scheduler?.queues || trace?.queues;
    const decor = cab?.layerCtx?.getDecorReadiness?.();
    const buildings = window.__s3dBuildingBuildState?.();
    const aggregatePipeline = buildings?.aggregatePipeline
        || window.__s3dBuildingDraw?.()?.aggregatePipeline;
    return {
        atMs: performance.now(),
        decor: decor ? { ...decor, observation: 'publication' } : null,
        ground: ground ? Object.fromEntries(['closed', 'generation', 'published', 'pending',
            'preparing', 'waitingPublication', 'phase', 'failed', 'lastError',
            'capacityBlocked', 'sourceBlocked', 'failureBlocked',
            'preparationCpuMs', 'preparationSteps'].map(key => [key, ground[key]])) : null,
        publication: ground?.lastPublication?.generation !== previousPublication
            ? ground?.lastPublication || null : null,
        network: network ? { active: network.active, queued: network.queued } : null,
        tileSources: Array.isArray(tileSources) ? tileSources.map(source => Object.fromEntries(
            ['key', 'label', 'pendingTiles', 'pendingCallbacks', 'queuedByVisibility', 'oldestVisibleQueuedMs']
                .map(key => [key, source[key]]))) : null,
        // The engine reports a pending job object or explicit null, not a boolean.
        // Preserve absent/malformed evidence instead of coercing it to false.
        paint: paint ? { pending: paint.pending === null ? false
            : paint.pending && typeof paint.pending === 'object' && !Array.isArray(paint.pending) ? true : undefined,
            failures: paint.failures, closed: paint.closed } : null,
        buildings: buildings ? {
            ...Object.fromEntries(['loadedBuildingCount', 'reservedBuildingCount',
                'activeTileBuildCount', 'activeVisualReplacementTiles', 'pendingTerrainRebuildTiles',
                'pendingRegionalRebuildTiles', 'staticBuildActive'].map(key => [key, buildings[key]])),
            aggregatePipeline: aggregatePipeline || null,
        } : null,
        scheduler: scheduler ? Object.fromEntries(['phase', 'sceneWorkMs', 'previousFrameMs',
            'totalBudgetMs', 'classBudgets', 'lifetimeFrames', 'lifetimeSpentByClass']
            .map(key => [key, scheduler[key]])) : null,
        queueTotals: scheduler?.queues?.map(queue => ({ label: queue.label,
            cpuMs: queue.cpuMs, processedItems: queue.processedItems,
            longestItemMs: queue.longestItemMs, longestItemLabel: queue.longestItemLabel,
            over50msItems: queue.over50msItems })),
        queues: Array.isArray(queues) ? queues.filter(queue => queue.pendingItems > 0)
            .map(queue => ({ label: queue.label, pendingItems: queue.pendingItems,
                workClass: queue.workClass, pendingJobs: queue.pendingJobs,
                deferredJobs: queue.deferring?.length })) : null,
    };
}

// Feature jobs can finish before their merged meshes upload and release the
// replacement slots. Neither those slots nor the queued tile invalidations
// belong to FrameChunkQueue, so an empty scheduler alone is not completion.
export function buildingDrainState(buildings) {
    const pipeline = buildings?.aggregatePipeline;
    if (!buildings || !pipeline || typeof buildings.staticBuildActive !== 'boolean'
        || !Object.hasOwn(pipeline, 'activeBucket')) return 'unavailable';
    const counts = [buildings.reservedBuildingCount, buildings.activeTileBuildCount,
        buildings.activeVisualReplacementTiles, buildings.pendingTerrainRebuildTiles,
        buildings.pendingRegionalRebuildTiles, pipeline.pendingBuckets, pipeline.waitingTiles];
    if (!counts.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
        return 'unavailable';
    }
    return counts.every(value => value === 0) && !buildings.staticBuildActive
        && pipeline.activeBucket === null ? 'drained' : 'pending';
}

export function groundDrainState(sample) {
    const { ground, network, paint, queues, decor, tileSources } = sample || {};
    if (!ground || !network || !paint || !Array.isArray(queues) || !Array.isArray(tileSources)) return 'unavailable';
    if (!tileSources.every(source => source && ['pendingTiles', 'pendingCallbacks'].every(key =>
        Number.isSafeInteger(source[key]) && source[key] >= 0))) return 'unavailable';
    const tilesReady = tileSources.every(source => source.pendingTiles === 0 && source.pendingCallbacks === 0);
    if (!['closed', 'capacityBlocked', 'sourceBlocked', 'failureBlocked'].every(key => typeof ground[key] === 'boolean')
        || !['closed', 'pending'].every(key => typeof paint[key] === 'boolean')
        || ![ground.failed, paint.failures].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
        return 'unavailable';
    }
    if (ground.closed || paint.closed || ground.failed > 0 || paint.failures > 0
        || ground.capacityBlocked || ground.sourceBlocked || ground.failureBlocked || decor?.failed > 0) return 'failed';
    if (!decor || !['pending', 'failed'].every(key => Number.isFinite(decor[key]) && decor[key] >= 0)) return 'unavailable';
    if (decor.observation !== 'publication' || !['expected', 'published', 'empty'].every(key =>
        Number.isSafeInteger(decor[key]) && decor[key] >= 0) || typeof decor.initialized !== 'boolean') return 'unavailable';
    const decorReady = decor.pending === 0 && decor.initialized && decor.published + decor.empty === decor.expected;
    const counts = [ground.pending, ground.preparing, ground.waitingPublication, network.active, network.queued];
    if (!counts.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)
        || !Number.isFinite(ground.published) || ground.published < 1) return 'unavailable';
    const buildingState = buildingDrainState(sample.buildings);
    if (buildingState === 'unavailable') return 'unavailable';
    return counts.every(value => value === 0) && !paint.pending && queues.length === 0
        && buildingState === 'drained' && decorReady && tilesReady
        ? 'drained' : 'pending';
}
