import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroundPaintCache } from '../core/ground-paint-cache.js';
import { createGroundPaintTargetPool } from '../core/ground-paint-target-pool.js';
import { createSurfacePublicationRegistry } from '../core/surface-publication-registry.js';
import { createGroundPublicationBoundary } from '../core/ground-publication-boundary.js';
import { createGroundCompositePlanSteps } from '../core/ground-composite-plan.js';
import { compileSurfaceClaim } from '../core/surface-hierarchy.js';
import { FRAME_CHUNK_REPEAT_ITEM, FRAME_CHUNK_DEFER_ITEM } from '../core/frame-chunk-queue.js';
import { captureGroundPaintMaterialRows } from '../core/ground-paint-styles.js';

const receiver = { key: 'ground:test', verticalBand: 'ground', coverageRevision: 'r1',
    bounds: { minX: -1024, minZ: -1024, maxX: 1024, maxZ: 1024 } };
const box = { minX: -4, minZ: -4, maxX: 4, maxZ: 4 };
const ring = (a,b) => [{x:a,z:a},{x:b,z:a},{x:b,z:b},{x:a,z:b}];
const styles = new Map(['road-carriageway','sidewalk'].map((surfaceClass,i) => [surfaceClass, {
    id:i+1, revision:'m1', surfaceClass, roughness:.9, metalness:0, normalInfluence:0, linearColor:[.5,.5,.5],
}]));
const finish = g => { let n; do n=g.next(); while(!n.done); return n.value; };
function plan(paving = true, farOutside = false, separated = false) {
    const records = [['road','road-carriageway',-128,128], ...(paving ? [['plaza','sidewalk',-4,4]] : []),
        ...(separated ? [['edit-nw','sidewalk',-7,-5],['edit-se','sidewalk',5,7]] : []),
        ...(farOutside ? [['far-new','sidewalk',400,408]] : []),
        ...(farOutside === 'both' ? [['far-other','sidewalk',-408,-400]] : [])]
        .map(([key,surfaceClass,a,b]) => ({ key, sourceRevision:'s1', materialRevision:'m1',
            materialKey:surfaceClass, receiver, polygons:[{outerRing:ring(a,b),holeRings:[]}],
            claim:compileSurfaceClaim({surfaceClass,coverageState:'published',verticalBand:'ground',verticalRelation:'same-level'}),
        }));
    return finish(createGroundCompositePlanSteps({receiver,records,
        limits:{records:4,vertices:20,verticesPerRecord:20,oversized:4}}));
}
function harness() {
    const jobs = [], events = [], packets = [], controls = { failDraw:false, rejectCommit:false, now:0, frame:0,
        prepareHold:false, gpuSteps:0, stepsPerPage:1, submissionMs:0 };
    const queue = {
        enqueue(items,fn,options) { const job={items,fn,options,done:false}; jobs.push(job); return job; },
        cancel(job) { if(!job || job.done) return; job.done=true; job.options.onCancel?.(); },
        dispose() { for(const job of jobs) this.cancel(job); },
    };
    let painting = null, closed = false;
    const painter = {
        createTask({packet,targetLease,isCurrent}) {
            packets.push(packet);
            assert.equal(painting,null,'only one GPU candidate is allowed');
            let transferred=false,disposed=false,complete=false,steps=0;
            const task = {
                async prepare() { assert.ok(isCurrent());
                    if (controls.prepareHold) await new Promise(resolve => { controls.releasePrepare = resolve; }); },
                step() {
                    controls.gpuSteps++;
                    controls.now += controls.submissionMs;
                    if(controls.failDraw) throw new Error('injected GPU draw failure');
                    assert.ok(isCurrent()); complete=++steps >= controls.stepsPerPage; return complete;
                },
                result() {
                    assert.ok(complete && !transferred); transferred=true; painting=null;
                    let retired=false;
                    return Object.freeze({ receiver:packet.receiver,bounds:packet.bounds,size:packet.size,
                        styles:packet.styles,target:targetLease.target,layer:targetLease.layer,
                        patterns:{ready:true,released:false,texture:null},
                        copyMaterialRows:()=>captureGroundPaintMaterialRows(packet.styles,null,packet.bounds),
                        get disposed(){return retired || closed;},
                        dispose(){if(retired)return false;retired=true;targetLease.release();return true;},
                    });
                },
                dispose(){if(disposed)return false;disposed=true;if(!transferred)targetLease.release();
                    if(painting===task)painting=null;return true;},
            };
            painting=task;return task;
        },
        dispose(){closed=true;painting?.dispose();},
    };
    const registry = createSurfacePublicationRegistry();
    const publicationRegistry = {
        begin:registry.begin,
        prepareBatch:entries=>registry.prepareBatch(entries,{commit:()=>!controls.rejectCommit}),
    };
    const boundary = createGroundPublicationBoundary();
    const pool = createGroundPaintTargetPool({size:8,maxTargets:4,maxTextureBytes:8*8*4});
    const cache = createGroundPaintCache({renderer:{domElement:new EventTarget()},receiver,
        size:8,widthsM:[16,64,256],blockSize:2,maxTextureBytes:8*8*4,
        packetLimits:{pixels:64,draws:4,verticesPerPolygon:20},registry:publicationRegistry,
        boundary,queue,painter,pool,now:()=>controls.now,frameSequence:()=>controls.frame});
    async function step(advanceFrame = true) {
        if (advanceFrame) controls.frame++;
        const job=jobs.find(j=>!j.done);
        let result;
        if(job) {
            try {
                result=job.fn(job.items[0]);
                if(result!==FRAME_CHUNK_REPEAT_ITEM && result!==FRAME_CHUNK_DEFER_ITEM) {
                    job.done=true;job.options.onComplete?.();
                }
            } catch(error) {job.done=true;events.push(error.message);job.options.onError?.(error);}
        }
        await Promise.resolve();await Promise.resolve();
        return result;
    }
    async function ready() {
        for(let i=0;i<500 && !boundary.snapshot().pending;i++) {
            assert.ok(cache.snapshot().pending,'cache must reach publication instead of silently dropping work');
            await step();
        }
        assert.equal(boundary.snapshot().pending,1,'complete page must enter the shared boundary');
    }
    async function publish(index,x=0) {
        const previous=cache.snapshot().published;
        cache.onFrame(x,0);assert.equal(cache.snapshot().pending?.index,index);
        await ready();boundary.publishReady();await Promise.resolve();await Promise.resolve();
        assert.equal(cache.snapshot().published,previous+1);
        assert.equal(cache.snapshot().pending,null);
    }
    function rawPrepareSource(nextPlan, isCurrent = () => true) {
        return cache.prepareSourceSteps({ plan: nextPlan, styles, isCurrent });
    }
    async function prepareSource(nextPlan) {
        const iterator = rawPrepareSource(nextPlan);
        let next;
        for (let calls = 0; calls < 500; calls++) {
            controls.frame++;
            next = iterator.next();
            if (next.done) break;
            // Source preparation starts asynchronous GPU work from the generator;
            // let its promise callbacks run before asking for the next slice.
            await Promise.resolve(); await Promise.resolve();
            if (next.value?.phase === 'paint-source-slot') {
                for (let i = 0; i < 500; i++) {
                    await step();
                    if (boundary.snapshot().pending) {
                        boundary.publishReady();
                        await Promise.resolve(); await Promise.resolve();
                    }
                    if (!cache.snapshot().pending && !jobs.some(j => !j.done)) break;
                }
            }
        }
        assert.ok(next?.done, 'source preparation must settle within 500 slices');
        return next.value;
    }
    async function source(nextPlan) {
        const publication = await prepareSource(nextPlan);
        if (!publication) return false;
        const batch = publication.entry ? registry.prepareBatch([publication.entry]) : null;
        const ticket = boundary.enqueue(batch, { onPublished: publication.finalize });
        assert.ok(ticket, 'source publication must enter the shared boundary');
        boundary.publishReady(); await Promise.resolve(); await Promise.resolve();
        return true;
    }
    async function initial() { await source(plan()); await publish(0); await publish(1); }
    return {cache,boundary,registry,pool,jobs,controls,events,packets,step,ready,publish,initial,source,prepareSource,rawPrepareSource};
}

// Advance preparation within one scheduler frame; asynchronous shader setup
// may yield, but only the shared submission gate ends this frame's draw work.
async function submitWithinFrame(iterator) {
    for (let calls = 0; calls < 500; calls++) {
        const next = iterator.next();
        await Promise.resolve(); await Promise.resolve();
        if (next.done || next.value?.phase === 'paint-gpu-slot') return next;
    }
    assert.fail('bounded packet preparation must reach its submission gate');
}

test('small paint submissions share a frame up to the fixed operation limit', async () => {
    const h = harness(); let iterator;
    try {
        h.controls.stepsPerPage = 20;
        iterator = h.rawPrepareSource(plan());
        assert.equal((await submitWithinFrame(iterator)).value.phase, 'paint-gpu-slot');
        assert.equal(h.controls.gpuSteps, 8);
        await submitWithinFrame(iterator);
        assert.equal(h.controls.gpuSteps, 8, 'another call in the same frame cannot reset the budget');
        assert.equal(h.cache.materialState.pages.length, 0);
        h.controls.frame++;
        await submitWithinFrame(iterator);
        assert.equal(h.controls.gpuSteps, 16);
        h.controls.frame++;
        const ready = await submitWithinFrame(iterator);
        assert.equal(ready.done, true);
        assert.equal(h.controls.gpuSteps, 20);
        ready.value.discard();
    } finally { iterator?.return(); h.cache.dispose(); h.boundary.close(); }
    assert.equal(h.pool.stats().leased, 0);
});

test('paint submission time ends a frame before its operation limit is reached', async () => {
    const h = harness(); let iterator;
    try {
        h.controls.stepsPerPage = 20;
        h.controls.submissionMs = 0.6;
        iterator = h.rawPrepareSource(plan());
        await submitWithinFrame(iterator);
        assert.equal(h.controls.gpuSteps, 2);
        assert.equal(h.cache.snapshot().submissions.elapsedMs, 1.2);
        assert.equal(h.cache.snapshot().submissions.maxItemMs, 0.6);
        await submitWithinFrame(iterator);
        assert.equal(h.controls.gpuSteps, 2);
        h.controls.frame++;
        await submitWithinFrame(iterator);
        assert.equal(h.controls.gpuSteps, 4);
    } finally { iterator?.return(); h.cache.dispose(); h.boundary.close(); }
});

test('source and background page preparation consume the same frame budget', async () => {
    const h = harness(); let iterator;
    try {
        h.controls.stepsPerPage = 6;
        iterator = h.rawPrepareSource(plan());
        const ready = await submitWithinFrame(iterator);
        assert.equal(ready.done, true);
        h.boundary.enqueue(h.registry.prepareBatch([ready.value.entry]), { onPublished: ready.value.finalize });
        h.boundary.publishReady(); await Promise.resolve(); await Promise.resolve();
        assert.equal(h.controls.gpuSteps, 6);
        h.cache.onFrame(0, 0);
        for (let calls = 0; calls < 500 && h.controls.gpuSteps < 8; calls++) await h.step(false);
        assert.equal(h.controls.gpuSteps, 8);
        assert.equal(await h.step(false), FRAME_CHUNK_DEFER_ITEM);
        assert.equal(h.controls.gpuSteps, 8, 'a different page and queue inherit the source work already submitted');
        assert.equal(h.cache.materialState.pages.length, 1, 'fine page remains private until fully drawn');
        await h.ready();
        h.boundary.publishReady(); await Promise.resolve(); await Promise.resolve();
        assert.equal(h.cache.materialState.pages.length, 2);
    } finally { iterator?.return(); h.cache.dispose(); h.boundary.close(); }
});

test('completed page remains private until the real registry boundary publishes it', async () => {
    const h=harness();try {
        const publication=await h.prepareSource(plan());
        assert.equal(h.cache.materialState.pages.length,0);
        assert.equal(h.cache.paintAt(0,0,receiver),null);
        assert.equal(h.pool.stats().leased,1);
        const batch=h.registry.prepareBatch([publication.entry]);
        h.boundary.enqueue(batch,{onPublished:publication.finalize});
        h.boundary.publishReady(); await Promise.resolve(); await Promise.resolve();
        assert.equal(h.cache.materialState.pages.length,1);
        assert.equal(h.cache.paintAt(0,0,receiver).record.key,'plaza');
        assert.equal(h.cache.paintAt(0,0,receiver).cascade,2);
        assert.equal(h.cache.snapshot().published,1);
    }finally{h.cache.dispose();h.boundary.close();}
    assert.equal(h.pool.stats().leased,0);
});

test('source removal uses new coarse coverage until fine pages are complete without extra targets', async () => {
    const h=harness();try {
        await h.initial();assert.equal(h.pool.stats().leased,3);
        const before=h.cache.materialState.pages;
        const revision=h.cache.revision+1;
        assert.deepEqual(h.cache.materialState.pages,before,'invalidation does not mutate or retire old pixels');
        const publication = await h.prepareSource(plan(false));
        assert.deepEqual(h.cache.materialState.pages,before);
        assert.equal(h.cache.revision,revision-1);
        assert.equal(h.pool.stats().leased,4);
        assert.equal(h.pool.stats().targets,1);
        assert.equal(h.cache.paintAt(0,0,receiver).record.key,'plaza');
        h.boundary.enqueue(h.registry.prepareBatch([publication.entry]), {onPublished:publication.finalize});
        h.boundary.publishReady();await Promise.resolve();await Promise.resolve();
        assert.equal(h.cache.paintAt(0,0,receiver).record.key,'road');
        assert.equal(h.cache.paintAt(0,0,receiver).cascade,2);
        await h.publish(0);assert.equal(h.cache.paintAt(0,0,receiver).cascade,0);
        await h.publish(1);
        assert.equal(h.pool.stats().leased,3);
        assert.ok(h.cache.snapshot().pages.every(p=>p.revision===revision && p.invalidBounds===null));
        h.cache.onFrame(0,0);assert.equal(h.cache.snapshot().pending,null,'settled input must not repaint');
    }finally{h.cache.dispose();h.boundary.close();}
    assert.equal(h.pool.stats().textureBytes,0);
});

test('an edit during camera movement cannot label an older candidate as current coverage', async () => {
    const h=harness();try {
        await h.initial();h.cache.onFrame(3,0);assert.equal(h.cache.snapshot().pending.index,0);
        await h.step();
        const revision=h.cache.revision+1;
        const publication = await h.prepareSource(plan(false));
        assert.equal(h.cache.snapshot().pages[0].revision,revision-1);
        assert.equal(h.cache.paintAt(0,0,receiver).record.key,'plaza');
        h.boundary.enqueue(h.registry.prepareBatch([publication.entry]), {onPublished:publication.finalize});
        h.boundary.publishReady();await Promise.resolve();await Promise.resolve();
        assert.equal(h.cache.snapshot().pages[0].revision,revision);
        assert.deepEqual(h.cache.snapshot().pages[0].invalidBounds,box);
        assert.equal(h.cache.paintAt(0,0,receiver).cascade,2);
        assert.equal(h.cache.paintAt(7,0,receiver).record.key,'road');
        await h.publish(0,3);
        assert.equal(h.cache.paintAt(0,0,receiver).revision,revision);
        assert.equal(h.cache.paintAt(0,0,receiver).record.key,'road');
    }finally{h.cache.dispose();h.boundary.close();}
});

test('registry failure rolls back mappings and releases only the failed candidate', async t => {
    t.mock.method(console,'error',()=>{});
    const h=harness();try {
        await h.initial();const pages=h.cache.materialState.pages;
        h.cache.onFrame(3,0);await h.ready();h.controls.rejectCommit=true;
        h.boundary.publishReady();
        assert.equal(h.boundary.snapshot().failed,1);
        assert.match(h.boundary.snapshot().lastError,/commit rejected/);
        await Promise.resolve();await Promise.resolve();
        assert.deepEqual(h.cache.materialState.pages,pages);
        assert.ok(pages.every(p=>!p.disposed));
        assert.equal(h.cache.paintAt(0,0,receiver).record.key,'plaza');
        assert.equal(h.pool.stats().leased,3);
        assert.equal(h.cache.snapshot().failures,1);
    }finally{h.cache.dispose();h.boundary.close();}
});

test('separated source edits stay sparse across rollback and a fine-page shift', async t => {
    t.mock.method(console,'error',()=>{});
    const h = harness();
    try {
        await h.initial();
        const separatedPlan = plan(true, false, true);

        // A failed shared commit must restore the old fine-page damage mask.
        const rejected = await h.prepareSource(separatedPlan);
        assert.equal(rejected.entry.commit(), true);
        assert.equal(h.cache.snapshot().pages[0].dirtyBlocks, 8);
        rejected.entry.rollback();
        assert.deepEqual(h.cache.snapshot().pages.map(page => page?.dirtyBlocks), [0, 0, 0]);
        rejected.discard();

        // Replaying the same source succeeds and stages two separated dirty
        // islands on the fine page. Its center blocks remain reusable.
        await h.source(separatedPlan);
        const afterSource = h.cache.snapshot();
        assert.equal(afterSource.pages[0].dirtyBlocks, 8);

        // Shift by one cache block, then inspect the private candidate before
        // commit. Reprojection must retain overlapping source damage without
        // filling the untouched gap between the two islands.
        h.cache.onFrame(3, 3);
        assert.equal(h.cache.snapshot().pending?.index, 0);
        await h.ready();
        const update = h.packets.at(-1).update;
        const repainted = new Set(update.repaints.map(rect => (rect.y / 2) * 4 + rect.x / 2));
        assert.ok(repainted.size < 16, 'shifted edits should leave unrelated fine blocks reusable');
        for (const untouched of [1, 2, 4, 8]) {
            assert.equal(repainted.has(untouched), false, `unrelated gap block ${untouched} stays reusable`);
        }
        h.boundary.publishReady(); await Promise.resolve(); await Promise.resolve();
        assert.equal(h.cache.snapshot().pages[0].dirtyBlocks, 0, 'committed fine page consumes its pending mask');
    } finally { h.cache.dispose(); h.boundary.close(); }
});

test('edits outside retained pages acknowledge unchanged coverage without repainting it', async () => {
    const h=harness();try {
        await h.initial();const pages=h.cache.materialState.pages, published=h.cache.snapshot().published;
        const revision=h.cache.revision+1; await h.source(plan(true,true)); h.cache.onFrame(0,0);
        assert.equal(h.cache.snapshot().pending,null);
        assert.equal(h.cache.snapshot().published,published);
        assert.deepEqual(h.cache.materialState.pages,pages);
        assert.equal(h.cache.paintAt(0,0,receiver).record.key,'plaza');
        assert.equal(h.cache.paintAt(0,0,receiver).revision,revision);
    }finally{h.cache.dispose();h.boundary.close();}
});

test('edits on opposite sides outside every page preserve the paint in between', async () => {
    const h = harness();
    try {
        await h.initial();
        const pages = h.cache.materialState.pages, published = h.cache.snapshot().published;
        await h.source(plan(true, 'both'));
        assert.equal(h.cache.paintAt(0, 0, receiver)?.record.key, 'plaza',
            'the union of outside edits must not invalidate current pixels');
        h.cache.onFrame(0, 0);
        assert.equal(h.cache.snapshot().pending, null);
        assert.equal(h.cache.snapshot().published, published);
        assert.deepEqual(h.cache.materialState.pages, pages);
    } finally { h.cache.dispose(); h.boundary.close(); }
});

test('GPU failures have finite retries, retain old coverage and close staged leases', async t => {
    t.mock.method(console,'error',()=>{});
    const h=harness();try {
        await h.initial();h.controls.failDraw=true;
        for(let attempt=1;attempt<=3;attempt++) {
            h.cache.onFrame(3,0);
            for(let i=0;i<500 && h.cache.snapshot().pending;i++)await h.step();
            assert.equal(h.cache.snapshot().failures,attempt);
            assert.equal(h.pool.stats().leased,3);
            assert.equal(h.cache.paintAt(0,0,receiver).record.key,'plaza');
            const jobs=h.jobs.length;
            for(let i=0;i<10;i++)h.cache.onFrame(3,0);
            assert.equal(h.jobs.length,jobs,'retries must wait for their deadline');
            h.controls.now=h.cache.snapshot().retryAt;
        }
        assert.equal(h.cache.snapshot().retryAt,Infinity);
        const count=h.jobs.length;h.controls.now=1e10;
        h.cache.onFrame(3,0);assert.equal(h.jobs.length,count);
        assert.equal(h.events.length,3);
    }finally{h.cache.dispose();h.boundary.close();}
    assert.equal(h.pool.stats().leased,0);
});

test('a later physical member failure restores paint pages, source query and staging lease', async () => {
    const h = harness();
    try {
        await h.initial();
        const pages = h.cache.materialState.pages, revision = h.cache.revision;
        const publication = await h.prepareSource(plan(false));
        const failed = { ticket: h.registry.begin({key:'physical:failure',generation:1}), clear:true,
            commit() { throw new Error('physical commit failed'); } };
        const ticket = h.boundary.enqueue(h.registry.prepareBatch([publication.entry, failed]),
            {onPublished:publication.finalize});
        const rejected = assert.rejects(ticket.promise, /physical commit failed/);
        h.boundary.publishReady(); await rejected;
        assert.equal(h.cache.revision,revision);
        assert.deepEqual(h.cache.materialState.pages,pages);
        assert.ok(pages.every(page => !page.disposed));
        assert.equal(h.cache.paintAt(0,0,receiver).record.key,'plaza');
        assert.equal(h.cache.snapshot().pending,null);
        assert.equal(h.pool.stats().leased,3);
        await h.source(plan(false));
        assert.equal(h.cache.paintAt(0,0,receiver).record.key,'road');
    } finally {h.cache.dispose();h.boundary.close();}
});

test('cancelling a source during GPU preparation frees only its private lease', async () => {
    const h = harness();
    try {
        await h.initial(); h.controls.prepareHold = true;
        const pages = h.cache.materialState.pages;
        const iterator = h.cache.prepareSourceSteps({plan:plan(false),styles});
        for (let i=0;i<500 && !h.controls.releasePrepare;i++) iterator.next();
        assert.equal(typeof h.controls.releasePrepare,'function');
        assert.equal(h.pool.stats().leased,4);
        iterator.return();
        assert.equal(h.pool.stats().leased,3);
        assert.deepEqual(h.cache.materialState.pages,pages);
        assert.equal(h.cache.snapshot().pending,null);
        h.controls.releasePrepare(); await Promise.resolve(); await Promise.resolve();
        assert.equal(h.pool.stats().leased,3);
    } finally {h.cache.dispose();h.boundary.close();}
});

test('source reservation permits the current page to finish and stops camera updates starving it', async () => {
    const h = harness();
    try {
        await h.initial();
        h.cache.onFrame(3,0);
        const iterator = h.cache.prepareSourceSteps({plan:plan(false),styles});
        assert.equal(iterator.next().value.phase,'paint-source-slot');
        const jobs = h.jobs.length;
        for (let i=0;i<500 && h.cache.snapshot().pending;i++) {
            h.cache.onFrame(100+i,0); await h.step();
            if (h.boundary.snapshot().pending) h.boundary.publishReady();
            await Promise.resolve(); await Promise.resolve();
        }
        assert.equal(h.cache.snapshot().pending,null);
        h.cache.onFrame(1200,0);
        assert.equal(h.jobs.length,jobs);
        let next;
        for (let i=0;i<500;i++) {
            h.controls.frame++; next=iterator.next();
            if (next.done) break;
            await Promise.resolve(); await Promise.resolve();
        }
        assert.ok(next.done && next.value);
        next.value.discard();
        assert.equal(h.cache.snapshot().pending,null);
        assert.equal(h.cache.paintAt(0,0,receiver).record.key,'plaza');
        assert.equal(h.pool.stats().leased,3);
    } finally {h.cache.dispose();h.boundary.close();}
});

test('an identical source plan is a no-op', async () => {
    const h=harness();try {
        await h.initial(); const before=h.cache.snapshot();
        assert.equal(await h.source(plan()),false);
        assert.deepEqual(h.cache.snapshot(),before);
    } finally {h.cache.dispose();h.boundary.close();}
});
