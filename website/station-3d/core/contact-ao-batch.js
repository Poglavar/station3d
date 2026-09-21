// Resumable assembly for a tile's single contact-AO mesh. The world layer
// deliberately publishes one mesh per tile to keep draw calls low, but copying
// every building contribution into that mesh must not be one indivisible frame
// item. This iterator counts and copies bounded chunks while leaving the final
// scene publication to its caller.

export const CONTACT_AO_COUNT_PER_STEP = 64;
export const CONTACT_AO_VERTICES_PER_STEP = 2048;

// Keep every bounded phase of a detached AO assembly on one mask revision.
// A mask can change between any two queue visits, including between chunks of
// the final recheck; restarting is rare and guarantees that no mixture of two
// revisions can reach publication.
export function createRevisionGuardedContactAoTask({
    createTask,
    getMaskRevision,
    cancelReason = 'proposal-mask-changed-before-contact-ao-publication',
} = {}) {
    if (typeof createTask !== 'function' || typeof getMaskRevision !== 'function') {
        throw new TypeError('Contact AO revision guard requires task and revision factories');
    }
    let task = null;
    let taskMaskRevision = null;

    const restart = (revision = getMaskRevision()) => {
        task?.cancel?.(cancelReason);
        taskMaskRevision = revision;
        task = createTask();
    };
    restart();

    return {
        step() {
            const currentRevision = getMaskRevision();
            if (currentRevision !== taskMaskRevision) restart(currentRevision);
            return task.step();
        },
        cancel(reason = null) {
            task.cancel(reason);
        },
        snapshot() {
            return task.snapshot();
        },
    };
}

function safeVertexCount(contribution) {
    return Math.max(0, Math.floor((contribution?.positions?.length || 0) / 3));
}

export function* assembleContactAoBatch(contributions, {
    include = () => true,
    countPerStep = CONTACT_AO_COUNT_PER_STEP,
    verticesPerStep = CONTACT_AO_VERTICES_PER_STEP,
} = {}) {
    const source = Array.isArray(contributions) ? contributions : [];
    const countLimit = Math.max(1, Math.floor(Number(countPerStep) || 1));
    const vertexLimit = Math.max(1, Math.floor(Number(verticesPerStep) || 1));
    let capacityVertices = 0;
    for (let index = 0; index < source.length; index++) {
        capacityVertices += safeVertexCount(source[index]);
        if ((index + 1) % countLimit === 0) {
            yield { phase: 'contact-ao-count', contributions: index + 1 };
        }
    }

    const positions = new Float32Array(capacityVertices * 3);
    const colors = new Float32Array(capacityVertices * 4);
    const entries = [];
    let positionOffset = 0;
    let colorOffset = 0;
    let copiedSinceYield = 0;

    for (const contribution of source) {
        const vertexCount = safeVertexCount(contribution);
        if (vertexCount === 0 || !include(contribution)) continue;
        const start = positionOffset / 3;
        const sourcePositions = contribution.positions;
        const sourceColors = contribution.colors;
        const liftY = Number(contribution.baseY) || 0;
        let vertexIndex = 0;
        while (vertexIndex < vertexCount) {
            const take = Math.min(
                vertexCount - vertexIndex,
                vertexLimit - copiedSinceYield,
            );
            const end = vertexIndex + take;
            for (let index = vertexIndex; index < end; index++) {
                const sourcePosition = index * 3;
                positions[positionOffset++] = Number(sourcePositions[sourcePosition]) || 0;
                positions[positionOffset++] = (Number(sourcePositions[sourcePosition + 1]) || 0) + liftY;
                positions[positionOffset++] = Number(sourcePositions[sourcePosition + 2]) || 0;
                const sourceColor = index * 4;
                colors[colorOffset++] = Number(sourceColors?.[sourceColor]) || 0;
                colors[colorOffset++] = Number(sourceColors?.[sourceColor + 1]) || 0;
                colors[colorOffset++] = Number(sourceColors?.[sourceColor + 2]) || 0;
                colors[colorOffset++] = Number(sourceColors?.[sourceColor + 3]) || 0;
            }
            vertexIndex = end;
            copiedSinceYield += take;
            if (copiedSinceYield >= vertexLimit) {
                yield { phase: 'contact-ao-copy', vertices: copiedSinceYield };
                copiedSinceYield = 0;
            }
        }
        entries.push({
            start,
            count: vertexCount,
            centroidLatLon: contribution.centroidLatLon,
            contribution,
        });
    }
    if (copiedSinceYield > 0) {
        yield { phase: 'contact-ao-copy', vertices: copiedSinceYield };
    }

    // A proposal mask may resolve while copying spans several frames. Recheck
    // before publication. Newly excluded ranges stay in the typed buffers but
    // become fully transparent; this keeps the recheck bounded and avoids a
    // second whole-tile compaction. Future mask sweeps compact retained ranges
    // using the public entries below.
    const keptEntries = [];
    let checkedSinceYield = 0;
    for (const entry of entries) {
        if (include(entry.contribution)) {
            keptEntries.push({
                start: entry.start,
                count: entry.count,
                centroidLatLon: entry.centroidLatLon,
            });
        } else {
            const end = entry.start + entry.count;
            for (let vertex = entry.start; vertex < end; vertex++) {
                colors[vertex * 4 + 3] = 0;
            }
        }
        checkedSinceYield += 1;
        if (checkedSinceYield >= countLimit) {
            yield { phase: 'contact-ao-mask-recheck', contributions: checkedSinceYield };
            checkedSinceYield = 0;
        }
    }
    if (checkedSinceYield > 0) {
        yield { phase: 'contact-ao-mask-recheck', contributions: checkedSinceYield };
    }

    return {
        positions: positions.subarray(0, positionOffset),
        colors: colors.subarray(0, colorOffset),
        entries: keptEntries,
    };
}
