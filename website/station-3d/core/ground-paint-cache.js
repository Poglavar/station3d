// Publishes receiver-bound paint through the shared ground boundary, with a
// fixed page pool and one submission budget for source and movement updates.
import { createFrameChunkQueue, FRAME_CHUNK_REPEAT_ITEM, FRAME_CHUNK_DEFER_ITEM, getFrameChunkSequence } from './frame-chunk-queue.js';
import { planGroundPaintCascadeLayout } from './ground-paint-cascade-layout.js';
import { planGroundPaintUpdate } from './ground-paint-update.js';
import { createGroundPaintPacketSteps } from './ground-paint-packet.js';
import { captureGroundPaintStyles } from './ground-paint-styles.js';
import { createGroundPaintPagePainter } from './ground-paint-page-three.js';
import { createGroundPaintTargetPool } from './ground-paint-target-pool.js';
import { createGroundPaintMaterialState } from './ground-paint-material.js';
import { groundPaintInvalidationBounds } from './ground-composite-plan.js';

const union = (a, b) => !a ? { ...b } : ({ minX: Math.min(a.minX,b.minX), minZ: Math.min(a.minZ,b.minZ),
    maxX: Math.max(a.maxX,b.maxX), maxZ: Math.max(a.maxZ,b.maxZ) });
const inside = (b,x,z) => b && x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
const intersects = (a,b) => a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
let publicationGeneration = 0;

// Material cache only. Source publication supplies immutable plans; physical
// receivers, removal and collider participants remain with the shared registry.
// A prepared source entry changes coarse colour and CPU ownership with its
// physical dependency group. Fine pages then refine that generation using the
// ONE spare layer; preparing a change never invalidates the active material.
export function createGroundPaintCache({ renderer, receiver, size, widthsM, blockSize = 256,
    maxTextureBytes, packetLimits, registry, boundary, resolveAlbedoMap,
    queue = null, painter = null, pool = null, now = () => performance.now(), frameSequence = getFrameChunkSequence,
    submissionBudgetMs = 1, maxSubmissionsPerFrame = 8 }) {
    if (!Array.isArray(widthsM) || !widthsM.length || widthsM.length > 3
        || widthsM.some((width,i) => !Number.isFinite(width) || width <= 0 || (i > 0 && width <= widthsM[i-1]))) {
        throw new TypeError('Ground cache requires one to three increasing cascade widths');
    }
    if (!registry?.prepareBatch || !boundary?.enqueue) throw new TypeError('Ground cache requires the shared publication boundary');
    if (!Number.isFinite(submissionBudgetMs) || submissionBudgetMs <= 0
        || !Number.isSafeInteger(maxSubmissionsPerFrame) || maxSubmissionsPerFrame < 1) {
        throw new TypeError('Ground cache requires finite positive submission limits');
    }
    const widths = [...widthsM];
    // Validate dimensions before acquiring a queue or GPU owner.
    for (const widthM of widths) planGroundPaintCascadeLayout({ cameraX: 0, cameraZ: 0, widthM, size, blockSize });
    pool ||= createGroundPaintTargetPool({ size, maxTargets: widths.length+1, maxTextureBytes });
    const materialState = createGroundPaintMaterialState({ receiver });
    queue ||= createFrameChunkQueue({ label: 'ground:paint', frameBudgetMs: 1,
        pauseDuringMovement: false, preferAnimationFrame: true, workClass: 'near', trackWorldReady: true });
    painter ||= createGroundPaintPagePainter({ renderer });
    const active = widths.map(() => null), invalid = widths.map(() => null);
    let sourceRevision = 0, planRevision = -1, plan = null, styles = null, styleKey = null;
    let cameraX = 0, cameraZ = 0, candidate = null, closed = false;
    let pendingSource = null;
    let submissionFrame = -1, frameSubmissions = 0, frameSubmissionMs = 0;
    let totalSubmissions = 0, maxSubmissionMs = 0;
    let failures = 0, retryAt = 0, lastError = null, published = 0;
    const publishMapping = () => {
        const pages = [], stale = [];
        active.forEach((entry,i) => { if (entry) { pages.push(entry.page); stale.push(invalid[i]); } });
        materialState.replacePages(pages, stale);
    };
    const releaseCandidate = c => {
        if (c.batch?.state === 'staged') c.batch.discard('paint-candidate-retired');
        if (c.surfaceTicket?.state === 'pending') c.surfaceTicket.discard();
        c.steps?.return(); c.task?.dispose();
        if (!c.committed) c.page?.dispose();
        if (candidate === c) candidate = null;
    };
    const fail = (c, error) => {
        c.ticket?.cancel('paint-cancelled');
        if (c.batch?.state === 'staged') c.batch.discard('paint-cancelled');
        releaseCandidate(c);
        if (!closed) {
            failures++; lastError = String(error?.message || error);
            retryAt = failures < 3 ? now() + 1000 * 2 ** (failures-1) : Infinity;
            console.error('[ground:paint] Previous coverage retained:', error);
        }
    };
    function stagePublication(c) {
        let before = null, beforeInvalid = null;
        c.surfaceTicket = registry.begin({ key: `ground-paint:${receiver.key}:${c.index}`, generation: ++publicationGeneration });
        const entry = { ticket: c.surfaceTicket, clear: true,
            isCurrent: () => !closed && candidate === c && !c.page.disposed,
            commit() {
                before = active[c.index]; beforeInvalid = invalid[c.index];
                active[c.index] = { page: c.page, layout: c.layout, plan: c.plan, revision: c.revision };
                invalid[c.index] = c.invalidAfter;
                try { publishMapping(); } catch (error) {
                    active[c.index] = before; invalid[c.index] = beforeInvalid; throw error;
                }
                c.committed = true; return true;
            },
            rollback() {
                if (!c.committed) return;
                active[c.index] = before; invalid[c.index] = beforeInvalid;
                publishMapping(); c.committed = false;
            },
            discard() { if (!c.committed) c.page.dispose(); },
        };
        c.batch = registry.prepareBatch([entry]);
        c.finalize = result => {
            if (result.status.startsWith('published')) {
                before?.page.dispose(); published++; failures = 0; lastError = null; retryAt = 0;
            } else c.page.dispose();
            releaseCandidate(c);
        };
    }
    function* preparePageSteps(c, update) {
        c.phase = 'packet';
        const packet = yield* createGroundPaintPacketSteps({ plan: c.plan, bounds: c.layout.bounds, size,
            styles: c.styles, limits: packetLimits, update });
        const lease = pool.acquire();
        if (!lease) throw new Error('Ground paint staging layer exhausted');
        try { c.task = painter.createTask({ packet, targetLease: lease, resolveAlbedoMap,
            isCurrent: c.isCurrent || (() => !closed && candidate === c) }); }
        catch (error) { lease.release(); throw error; }
        c.phase = 'prepare';
        let ready = false, error = null;
        c.task.prepare().then(() => { ready = true; }, failure => { error = failure; ready = true; });
        while (!ready) yield { phase: 'paint-prepare', deferFrame: true };
        if (error) throw error;
        c.phase = 'paint';
        for (;;) {
            // Both the source driver's queue and the cache's own queue draw
            // from this budget. A new task/caller cannot reset it mid-frame.
            if (submissionFrame !== frameSequence()) {
                submissionFrame = frameSequence(); frameSubmissions = 0; frameSubmissionMs = 0;
            }
            if (frameSubmissions >= maxSubmissionsPerFrame || frameSubmissionMs >= submissionBudgetMs) {
                yield { phase: 'paint-gpu-slot', deferFrame: true };
                continue;
            }
            frameSubmissions++; totalSubmissions++;
            const startedAt = now();
            let complete;
            try { complete = c.task.step(); }
            finally {
                const elapsedMs = Math.max(0, now() - startedAt);
                frameSubmissionMs += elapsedMs;
                maxSubmissionMs = Math.max(maxSubmissionMs, elapsedMs);
            }
            if (complete) break;
            // Yield between bounded operations so the owning queue can apply
            // its own deadline too. Submission time is CPU/driver time; GPU
            // execution remains bounded by packet geometry and dirty blocks.
            yield { phase: 'paint-block' };
        }
        return c.task.result();
    }
    function begin(index, layout) {
        const previous = active[index];
        const c = { index, layout, plan, styles, revision: planRevision, invalidAfter: null,
            phase: 'packet', steps: null, task: null, page: null, batch: null, ticket: null, committed: false };
        const copy = previous?.page.styles.key === styleKey ? previous.page : null;
        const update = planGroundPaintUpdate({ receiver, bounds: layout.bounds, size, previous: copy,
            dirtyBounds: invalid[index] ? [invalid[index]] : [], blockSize });
        c.steps = preparePageSteps(c, update);
        candidate = c;
        c.job = queue.enqueue([c], () => {
            if (closed || candidate !== c) return;
            if (c.phase !== 'publish') {
                const step = c.steps.next();
                if (!step.done) return step.value?.deferFrame ? FRAME_CHUNK_DEFER_ITEM : FRAME_CHUNK_REPEAT_ITEM;
                c.page = step.value; stagePublication(c); c.phase = 'publish';
                return FRAME_CHUNK_REPEAT_ITEM;
            }
            if (c.phase === 'publish') {
                c.ticket = boundary.enqueue(c.batch);
                if (!c.ticket) return FRAME_CHUNK_DEFER_ITEM;
                c.phase = 'boundary';
                c.ticket.promise.then(c.finalize, error => fail(c,error));
                return;
            }
        }, { maxItemsPerFrame: 4, maxItemsPerSettledFrame: 8,
            onError: error => fail(c,error), onCancel: () => releaseCandidate(c),
            describeItem: () => `${c.index}:${c.phase}` });
    }
    // Source changes belong to the same batch as their old drape's retirement
    // and replacement support. Preparing this entry never invalidates active
    // pixels. Coarse coverage and the CPU plan become current at commit; fine
    // pages then refine the agreed source through the ordinary cache queue.
    function* prepareSourceSteps({ plan: nextPlan, styles: nextStyles, isCurrent = () => true }) {
        if (closed || pendingSource) throw new Error('Ground paint source preparation unavailable');
        if (nextPlan?.contract !== 'station3d-ground-composite-plan-v1'
            || ['key','verticalBand','coverageRevision'].some(key => nextPlan.receiver[key] !== receiver[key])) {
            throw new TypeError('Ground paint plan belongs to another receiver');
        }
        const token = {}; pendingSource = token;
        let c = null, handedOff = false;
        const available = () => !closed && pendingSource === token && isCurrent();
        try {
            // Reserve the next source turn before waiting, so continuously
            // moving fine pages cannot starve an actual source publication.
            while (candidate) {
                if (!available()) return null;
                yield { phase: 'paint-source-slot', deferFrame: true, waitingForDependency: true };
            }
            if (!available()) return null;
            const table = captureGroundPaintStyles(nextStyles);
            const nextRecipes = new Map(table.recipes.map(recipe => [recipe.key, recipe]));
            const changed = groundPaintInvalidationBounds(plan, nextPlan);
            if (styleKey && table.key !== styleKey) changed.push(nextPlan.bounds);
            if (!changed.length) return null;
            const dirty = changed.reduce((box, bounds) => union(box, bounds), null);
            const before = { plan, styles, styleKey, sourceRevision, planRevision,
                active: [...active], invalid: [...invalid] };
            const revision = sourceRevision+1;
            const current = () => available() && sourceRevision === before.sourceRevision;
            const index = widths.length-1;
            const layout = planGroundPaintCascadeLayout({ cameraX, cameraZ,
                widthM: widths[index], size, blockSize, previous: active[index]?.layout });
            c = { index, layout, plan: nextPlan, styles: nextRecipes, revision, phase: 'source',
                page: null, committed: false, steps: null, task: null, isCurrent: current };
            candidate = c;
            const needsPage = !active[index] ? nextPlan.commands.length > 0
                : layout.changed || intersects(layout.bounds, dirty);
            if (needsPage) {
                const copy = active[index]?.page.styles.key === table.key ? active[index].page : null;
                const update = planGroundPaintUpdate({ receiver, bounds: layout.bounds, size, previous: copy,
                    dirtyBounds: [dirty, invalid[index]].filter(Boolean), blockSize });
                c.steps = preparePageSteps(c, update);
                for (;;) {
                    if (!current()) return null;
                    const step = c.steps.next();
                    if (step.done) { c.page = step.value; break; }
                    yield step.value;
                }
            }
            if (!current()) return null;
            const nextActive = active.map(entry => entry ? { ...entry, revision } : null);
            const nextInvalid = invalid.map((bounds, i) => active[i] && intersects(active[i].page.bounds, dirty)
                ? union(bounds, dirty) : bounds);
            if (c.page) {
                nextActive[index] = { page: c.page, layout, plan: nextPlan, revision };
                nextInvalid[index] = null;
            }
            c.surfaceTicket = registry.begin({ key: `ground-paint:${receiver.key}:sources`, generation: ++publicationGeneration });
            const restore = () => {
                ({ plan, styles, styleKey, sourceRevision, planRevision } = before);
                active.splice(0, active.length, ...before.active);
                invalid.splice(0, invalid.length, ...before.invalid);
                publishMapping(); c.committed = false;
            };
            const entry = { ticket: c.surfaceTicket, clear: true,
                isCurrent: () => current() && candidate === c && (!c.page || !c.page.disposed),
                commit() {
                    plan = nextPlan; styles = nextRecipes; styleKey = table.key;
                    sourceRevision = revision; planRevision = revision;
                    active.splice(0, active.length, ...nextActive);
                    invalid.splice(0, invalid.length, ...nextInvalid);
                    c.committed = true;
                    try { publishMapping(); } catch (error) { restore(); throw error; }
                    return true;
                },
                rollback() { if (c.committed) restore(); },
                discard() {
                    if (c.committed) throw new Error('Rollback paint source before discarding');
                    releaseCandidate(c);
                    if (pendingSource === token) pendingSource = null;
                },
            };
            handedOff = true;
            let finalized = false;
            return { entry,
                finalize() {
                    if (finalized || !c.committed) return false;
                    finalized = true;
                    if (c.page) { before.active[index]?.page.dispose(); published++; }
                    failures = 0; lastError = null; retryAt = 0;
                    releaseCandidate(c);
                    if (pendingSource === token) pendingSource = null;
                    return true;
                },
                discard() {
                    if (finalized) return;
                    if (c.surfaceTicket.state === 'pending') c.surfaceTicket.discard();
                    entry.discard();
                },
            };
        } finally {
            if (!handedOff) {
                if (c) releaseCandidate(c);
                if (pendingSource === token) pendingSource = null;
            }
        }
    }
    const contextReset = () => {
        pendingSource = null;
        if (candidate) {
            const c = candidate;
            c.ticket?.cancel('paint-context-reset');
            if (c.job) queue.cancel(c.job);
            releaseCandidate(c);
        }
        active.forEach((entry,i) => { entry?.page.dispose(); active[i] = null; invalid[i] = null; });
        materialState.clear(); failures = 0; retryAt = 0;
    };
    renderer.domElement?.addEventListener('webglcontextlost', contextReset);
    renderer.domElement?.addEventListener('webglcontextrestored', contextReset);
    return Object.freeze({ materialState, prepareSourceSteps,
        get revision() { return sourceRevision; },
        onFrame(x,z) {
            if (closed || !Number.isFinite(x) || !Number.isFinite(z)) return;
            cameraX = x; cameraZ = z;
            if (candidate || pendingSource || !plan || planRevision !== sourceRevision || now() < retryAt) return;
            if (!plan.commands.length && !active.some(Boolean)) return;
            const layouts = widths.map((widthM,i) => planGroundPaintCascadeLayout({
                cameraX, cameraZ, widthM, size, blockSize, previous: active[i]?.layout }));
            const last = widths.length-1;
            const needs = i => !active[i] || active[i].page.disposed || active[i].revision !== planRevision
                || invalid[i] || layouts[i].changed;
            // Coarse coverage leads a source generation, then near detail.
            // Camera motion alone does not cancel a useful immutable build.
            const index = (!active[last] || active[last].revision !== planRevision) ? last : widths.findIndex((_,i) => needs(i));
            if (index >= 0) begin(index,layouts[index]);
        },
        paintAt(x,z,requestedReceiver) {
            if (closed || ['key','verticalBand','coverageRevision'].some(key => requestedReceiver?.[key] !== receiver[key])) return null;
            for (let i=0;i<active.length;i++) {
                const item = active[i]; if (!item || item.page.disposed || !inside(item.page.bounds,x,z)) continue;
                const b = invalid[i], halo = item.layout.texelM;
                if (b && inside({ minX:b.minX-halo,minZ:b.minZ-halo,maxX:b.maxX+halo,maxZ:b.maxZ+halo },x,z)) continue;
                return { record: item.plan.paintAt(x,z,receiver), revision: item.revision, cascade: i };
            }
            return null;
        },
        snapshot: () => ({ closed, sourceRevision, planRevision, published, failures, retryAt, lastError,
            submissions: { frame: submissionFrame, count: frameSubmissions, elapsedMs: frameSubmissionMs,
                budgetMs: submissionBudgetMs, limit: maxSubmissionsPerFrame, total: totalSubmissions, maxItemMs: maxSubmissionMs },
            pending: candidate ? { index:candidate.index,phase:candidate.phase,revision:candidate.revision } : null,
            pages: active.map((entry,i) => entry ? { revision:entry.revision,layer:entry.page.layer,
                bounds:entry.page.bounds,invalidBounds:invalid[i],disposed:entry.page.disposed } : null),
            resources:pool.stats(), materialTableBytes:materialState.textureBytes,
            patterns:painter.stats?.().patterns || null }),
        dispose() {
            if (closed) return false;
            closed = true; contextReset();
            renderer.domElement?.removeEventListener('webglcontextlost',contextReset);
            renderer.domElement?.removeEventListener('webglcontextrestored',contextReset);
            queue.dispose(); painter.dispose(); pool.dispose(); materialState.dispose();
            return true;
        },
    });
}
