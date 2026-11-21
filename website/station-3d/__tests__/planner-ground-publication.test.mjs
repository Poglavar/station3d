import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createPlannerGeometryRuntime } from './fixtures/planner-geometry-runtime.mjs';
import { createSurfacePublicationRegistry } from '../core/surface-publication-registry.js';
import { createGroundPublicationBoundary } from '../core/ground-publication-boundary.js';
import { getPlannerSurfaceCutoutState } from '../world/planner-surface-cutout.js';
import { createGroundGenerationCoordinator } from '../core/ground-generation-coordinator.js';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/planner-backstop-before.json', import.meta.url))).fixtures[0];
const finish = steps => { try { for (;;) { const next = steps.next(); if (next.done) return next.value; } } finally { steps.return(); } };

function setup() {
    const runtime = createPlannerGeometryRuntime({ trackResources: true }), { context } = runtime;
    const registry = createSurfacePublicationRegistry(), boundary = createGroundPublicationBoundary();
    const invalidations = [];
    let inputsReady;
    const inputReady = new Promise(resolve => { inputsReady=resolve; });
    context.args = { otherTracks: structuredClone(fixture.features), allStops: [], anchorLat: 45, anchorLon: 16,
        surfacePublications: registry, groundPublications: boundary,
        groundCoordinator: { invalidate: (...args) => { invalidations.push(args);
            if(args[1]?.reason==='planner-pillar-inputs')inputsReady(); } } };
    context.ensureRoadIndex = () => Promise.resolve();
    context.captureRoadIndexRead = () => () => [];
    const layer = vm.runInContext('plannerElevationLayer', context);
    const state = () => vm.runInContext('activePlannerState', context);
    layer.beginSession(context.args);
    const prepare = (generation, options = {}) => context.preparePlannerOpeningGroundSteps({
        terrain: { absoluteToSceneY: y => y-100, evidenceSceneYAtLocal: () => 3 },
        registry, generation, isCurrent: () => true, ...options });
    const publish = async candidate => {
        const batch = registry.prepareBatch(candidate.entries, { isCurrent: candidate.isCurrent });
        const ticket = boundary.enqueue(batch, { onPublished: () => candidate.finalize() });
        assert.equal(boundary.publishReady(), true);
        assert.match((await ticket.promise).status, /^published/);
    };
    return { ...runtime, registry, boundary, layer, state, prepare, publish, invalidations, inputReady,
        close() { layer.endSession(); boundary.close(); registry.close(); } };
}

test('planner entrypoints queue work and one real boundary publishes the root, floor, masks and query state', async () => {
    const f = setup();
    try {
        assert.equal(f.context.getPlannerElevationGroup(), null);
        assert.equal(f.resources.size, 0, 'beginSession cannot drain geometry');
        await f.inputReady;
        assert.equal(f.resources.size, 0, 'resolved pillar I/O cannot build or publish');
        assert.equal(f.invalidations.length, 2);
        let time=0;
        const steps = f.prepare(1, { now: () => time += .1 });
        let candidate;
        for (;;) {
            const next = steps.next();
            assert.equal(f.context.getPlannerElevationGroup(), null);
            assert.equal(getPlannerSurfaceCutoutState().enabled, false);
            if (next.done) { candidate = next.value; break; }
        }
        assert.ok(candidate.planner.length >= 2);
        assert.ok(Math.abs(candidate.supportRead.supportYAt(60,3.69,{maxY:.9})+5.05)<1e-6);
        await f.publish(candidate);
        const root = f.context.getPlannerElevationGroup(), first = f.state();
        assert.equal(root.parent, f.context.scene);
        assert.equal(first.surfaceMask.texture, getPlannerSurfaceCutoutState().texture);
        assert.equal(first.openingRead.isCurrent(), true);
        assert.equal(f.context.isPointInsidePlannerSurfaceCutout(60,3.69), true);
        assert.equal(f.context.isPointInsidePlannerSurfaceCutout(60,3.71), false);
        assert.ok(Math.abs(f.context.getPlannerSubsurfaceWalkFloorY(60,0,-5)+5.05)<1e-6);
        assert.ok(Math.abs(f.context.getPlannerSubsurfaceWalkFloorY(60,3.69,-5)+5.05)<1e-6);
        assert.equal(f.context.getPlannerSubsurfaceWalkFloorY(60,3.71,-5),null,'no support beyond the actual floor edge');
        const count = f.resources.size;
        const next = finish(f.prepare(2));
        assert.equal(next.supportRead, candidate.supportRead, 'terrain changes reuse terrain-independent civil faces');
        assert.equal(f.resources.size, count, 'no repeated geometry or material allocation');
        await f.publish(next);
        assert.equal(f.context.getPlannerElevationGroup(), root);
        assert.equal(getPlannerSurfaceCutoutState().texture, first.surfaceMask.texture);
        assert.equal(first.openingRead.isCurrent(), false);
        assert.equal(f.state().openingRead.isCurrent(), true);
    } finally { f.close(); }
    for (const [resource,count] of f.resources) assert.equal(count,1,resource.type);
});

test('a rejected planner successor restores the live root and masks and releases only its private resources', async () => {
    const f = setup();
    try {
        await f.inputReady;
        await f.publish(finish(f.prepare(1)));
        const before = f.state(), root = f.context.getPlannerElevationGroup(), oldResources = new Set(f.resources.keys());
        f.context.args.otherTracks = structuredClone(fixture.features);
        const candidate = finish(f.prepare(2));
        const batch = f.registry.prepareBatch([...candidate.entries, {
            ticket: f.registry.begin({ key: 'fixture:failed-sibling', generation: 2 }), clear: true,
            commit() { throw new Error('forced sibling failure'); }, rollback() {},
        }]);
        const ticket = f.boundary.enqueue(batch);
        const result = ticket.promise.catch(error => error);
        f.boundary.publishReady();
        assert.match(String((await result).message), /forced sibling failure/);
        candidate.discard(); // Registry and coordinator cleanup may both call it.
        assert.equal(f.state(), before); assert.equal(f.context.getPlannerElevationGroup(), root);
        assert.equal(root.parent, f.context.scene);
        assert.equal(getPlannerSurfaceCutoutState().texture, before.surfaceMask.texture);
        assert.equal(before.openingRead.isCurrent(), true);
        for (const [resource,count] of f.resources) if (!oldResources.has(resource)) assert.equal(count,1,resource.type);
        else if (resource.isBufferGeometry || resource.isInstancedMesh) assert.equal(count,0,resource.type);
    } finally { f.close(); }
});

test('missing terrain evidence cannot prepare or replace the live planner generation',async()=>{
    const f=setup();
    try {
        await f.inputReady;await f.publish(finish(f.prepare(1)));
        const root=f.context.getPlannerElevationGroup(),before=f.state(),resources=f.resources.size;
        f.context.args.otherTracks=structuredClone(fixture.features);
        for(const feature of f.context.args.otherTracks)feature.properties={...feature.properties,elevationMode:'ground-relative'};
        assert.throws(()=>finish(f.prepare(2,{terrain:{evidenceSceneYAtLocal:()=>null}})),{code:'ground-dependency-busy'});
        assert.equal(f.context.getPlannerElevationGroup(),root);assert.equal(f.state(),before);
        assert.equal(f.resources.size,resources,'missing evidence allocates no candidate geometry');
        assert.equal(root.parent,f.context.scene);assert.equal(before.openingRead.isCurrent(),true);
        assert.equal(getPlannerSurfaceCutoutState().texture,before.surfaceMask.texture);
    }finally{f.close();}
});

test('cancelling planner mask preparation preserves the live generation and rejects late session inputs', async () => {
    const f = setup();
    try {
        await f.inputReady;
        await f.publish(finish(f.prepare(1)));
        const before=f.state(), oldResources=new Set(f.resources.keys());
        f.context.args.otherTracks=structuredClone(fixture.features);
        let time=0;
        const steps=f.prepare(2,{now:()=>time+=1});
        try { for (;;) { const next=steps.next(); assert.equal(next.done,false); if(next.value.phase==='planner-mask-polygon')break; } }
        finally { steps.return(); }
        assert.equal(f.state(),before); assert.equal(getPlannerSurfaceCutoutState().texture,before.surfaceMask.texture);
        for(const [resource,count]of f.resources)if(!oldResources.has(resource))assert.equal(count,1,resource.type);
        f.layer.endSession();
        assert.equal(getPlannerSurfaceCutoutState().enabled,false);
        assert.equal(f.context.getPlannerElevationGroup(),null);
    } finally { f.boundary.close(); f.registry.close(); }
});

test('explicit flat sessions drive the same planner compiler through the shared coordinator', async()=>{
    const {context}=createPlannerGeometryRuntime(),jobs=[];
    const registry=createSurfacePublicationRegistry(),boundary=createGroundPublicationBoundary();
    context.createGroundGenerationCoordinator=createGroundGenerationCoordinator;
    context.FRAME_CHUNK_REPEAT_ITEM=Symbol('repeat');context.FRAME_CHUNK_DEFER_ITEM=Symbol('defer');
    context.createFrameChunkQueue=()=>({
        enqueue(items,fn,options){const job={items,fn,options};jobs.push(job);return job;},
        cancel(job){job.cancelled=true;job.options.onCancel?.();},dispose(){},
    });
    let releaseInputs;
    context.ensureRoadIndex=()=>new Promise(resolve=>{releaseInputs=resolve;});
    context.captureRoadIndexRead=()=>()=>[];
    const layer=vm.runInContext('plannerElevationLayer',context);
    try{
        layer.beginSession({otherTracks:fixture.features,allStops:[],anchorLat:45,anchorLon:16,
            surfacePublications:registry,groundPublications:boundary});
        layer.onFrame(null,{x:60,z:0});
        assert.equal(jobs.length,1);
        for(let visits=0;!boundary.snapshot().pending;visits++){
            assert.ok(visits<10000);const job=jobs[0];job.fn(job.items[0]);
            assert.equal(context.getPlannerElevationGroup(),null);
        }
        boundary.publishReady();await Promise.resolve();
        assert.ok(context.getPlannerElevationGroup()?.parent===context.scene);
        const snapshot=vm.runInContext('localGroundCoordinator.snapshot()',context);
        assert.equal(snapshot.published,1);assert.equal(snapshot.pending,0);assert.equal(snapshot.failed,0);
        layer.endSession();releaseInputs();await Promise.resolve();await Promise.resolve();
        assert.equal(context.getPlannerElevationGroup(),null,'late I/O cannot revive an ended session');
    }finally{boundary.close();registry.close();}
});

test('cancelling an in-flight shader preparation retains candidate materials only through its GPU fence',{timeout:1000},async()=>{
    const f=setup();let complete;
    const fence=new Promise(resolve=>{complete=resolve;});
    try{
        await f.inputReady;
        f.context.prewarmDetachedObject=function*(){yield {phase:'fixture-shader-fence',ready:fence};};
        const steps=f.prepare(1);
        for(;;){const next=steps.next();assert.equal(next.done,false);if(next.value.phase==='fixture-shader-fence')break;}
        const privateGeometry=[...f.resources.keys()].filter(object=>object.isBufferGeometry);
        steps.return();
        assert.ok(privateGeometry.some(object=>f.resources.get(object)===0));
        const disposed=new Promise(resolve=>privateGeometry.find(object=>f.resources.get(object)===0).addEventListener('dispose',resolve));
        assert.equal(f.context.getPlannerElevationGroup(),null);
        complete();await disposed;
        for(const [resource,count]of f.resources)assert.equal(count,1,resource.type);
    }finally{f.close();}
});
