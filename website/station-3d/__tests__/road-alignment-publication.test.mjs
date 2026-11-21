import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RoadVerticalAlignmentModel, createIndexedPolylineNearestSteps } from '../core/road-vertical-alignment.js';
import { createGroundPublicationBoundary } from '../core/ground-publication-boundary.js';
import { createSurfacePublicationRegistry } from '../core/surface-publication-registry.js';

const before = JSON.parse(fs.readFileSync(new URL('./fixtures/road-alignment-before-preparation.json', import.meta.url)));
const geometryKeys = ['id','points','cumulative','samples','structureStartM','structureEndM',
    'borePortalOpenM','crossingClearRanges','junctionGapRanges'];
const terrainY = (x,z) => 10+Math.sin(x/80)*2+z*.02;
const serial = value => JSON.parse(JSON.stringify(value));
const drain = steps => { for (;;) { const next = steps.next(); if (next.done) return next.value; } };
const yieldingClock = () => { let time=0; return () => time += .3; };

// Count actual retained upstream owners, including the transient query facade.
// Each handle closes over a fixed elevation offset; changing the fixture's
// requested source never changes an already captured sampler.
function fixture(group = before.groups[1]) {
    let offset = 0, missing = false, reads = 0, samples = 0;
    function capture(shift = offset) {
        const absent = missing;
        let owners = 0;
        const view = { contract:'station3d-ground-read-snapshot-v1',
            evidenceSceneYAtLocal(x,z) { assert.ok(owners>0); samples++; return absent ? null : terrainY(x,z)+shift; },
            absoluteToSceneY(y) { assert.ok(owners>0); return y-100; },
        };
        function handle() {
            reads++; owners++; let released=false;
            return Object.freeze({...view,
                retain() { assert.equal(released,false); return handle(); },
                release() { if (released) return false; released=true; reads--; owners--; return true; },
            });
        }
        return handle();
    }
    const model = new RoadVerticalAlignmentModel({anchorLon:0,anchorLat:0,sampleSpacingM:8,
        definitions:structuredClone(group.definitions),captureTerrainSnapshot:capture});
    return {model, group, capture, reads:()=>reads, samples:()=>samples,
        change(shift, absent=false) { offset=shift; missing=absent; model.invalidateTerrain(); }};
}

function assertGeometry(read, group) {
    assert.deepEqual(serial(read.getAlignments().map(alignment => Object.fromEntries(
        geometryKeys.map(key=>[key,alignment[key]])))), group.compiled);
    assert.deepEqual(serial(read.getReplacementTerrainCutoutRegions()), group.cutouts);
    assert.deepEqual(group.probes.map(p=>({ ...p,y:read.roadYAtLocal(p.x,p.z,p.osmId),
        ownerId:read.getProfileOwnerForOsmId(p.osmId)?.id ?? null })), group.probes);
}

test('synchronous and prepared compilers match independently frozen profile, companion and portal geometry', () => {
    assert.equal(before.provenance.sourceSha256,'93a2a7f1a415217874ec2c49cf8846a6e71fdb43c397cfeb5f697ca87e9588b2');
    assert.equal(before.groups.length,4);
    for (const group of before.groups) {
        const direct = fixture(group); assertGeometry(direct.model,group); direct.model.dispose();
        assert.equal(direct.reads(),0);
        const prepared = fixture(group);
        const candidate = drain(prepared.model.preparePublicationSteps({authoredPortalReplacements:[],now:yieldingClock()}));
        assertGeometry(candidate.read,group);
        assert.deepEqual(prepared.model.getAlignments(),[], 'candidate has not published');
        assert.equal(candidate.isCurrent(),true); assert.equal(candidate.commit(),true);
        assertGeometry(prepared.model,group); assert.equal(candidate.finalize(),true);
        prepared.model.dispose(); assert.equal(prepared.reads(),0);
    }
});

test('every yield retains active geometry and publication revision; candidate read and commit agree', () => {
    const f=fixture(), {model}=f;
    const old=model.getAlignments(), oldY=model.roadYAtLocal(100,0,4201), oldInputs=model._publishedInputs;
    const oldCutouts=model.getReplacementTerrainCutoutRegions(), oldRevision=model.publishedRevision;
    f.change(12);
    const phases=new Set(); let yields=0, next;
    const steps=model.preparePublicationSteps({authoredPortalReplacements:[],now:yieldingClock()});
    while (!(next=steps.next()).done) {
        phases.add(next.value.phase); yields++;
        assert.equal(model.getAlignments(),old); assert.equal(model._publishedInputs,oldInputs);
        assert.equal(model.roadYAtLocal(100,0,4201),oldY);
        assert.equal(model.getReplacementTerrainCutoutRegions(),oldCutouts);
        assert.equal(model.publishedRevision,oldRevision);
    }
    assert.ok(yields>100); assert.ok(phases.has('alignment-terrain-readiness'));
    assert.ok(phases.has('alignment-opening-runs')); assert.ok(phases.has('alignment-query-index'));
    const candidate=next.value;
    assert.ok(Math.abs(candidate.read.roadYAtLocal(100,0,4201)-oldY-12)<1e-10);
    const activeRead=drain(model.captureReadSnapshotSteps({authoredPortalReplacements:[]}));
    assert.equal(activeRead.revision,oldRevision); assert.equal(activeRead.roadYAtLocal(100,0,4201),oldY);
    const retained=candidate.read.retain('dependent');
    assert.equal(candidate.commit(),true); assert.equal(model.publishedRevision,model.revision);
    assert.equal(model.roadYAtLocal(100,0,4201),retained.roadYAtLocal(100,0,4201));
    assert.equal(candidate.finalize(),true); assert.equal(candidate.finalize(),false);
    model.dispose(); assert.equal(activeRead.roadYAtLocal(100,0,4201),oldY);
    assert.ok(Math.abs(retained.roadYAtLocal(100,0,4201)-oldY-12)<1e-10);
    activeRead.release(); retained.release(); assert.equal(f.reads(),0);
});

test('a real boundary group commits after its upstream promotion and rolls back on a later rejection', async () => {
    for (const failLater of [true,false]) {
        const f=fixture(), {model}=f; const old=model.getAlignments(), inputs=model._publishedInputs;
        const y=model.roadYAtLocal(100,0,4201); f.change(7);
        let upstream=0;
        const candidate=drain(model.preparePublicationSteps({authoredPortalReplacements:[],isCurrent:()=>upstream===0}));
        const registry=createSurfacePublicationRegistry(), boundary=createGroundPublicationBoundary();
        const entry=(key,hooks)=>({ticket:registry.begin({key,generation:1}),clear:true,...hooks});
        const batch=registry.prepareBatch([
            entry('terrain',{commit:()=>{upstream=1;return true;},rollback:()=>{upstream=0;}}),
            entry('alignment',{isCurrent:candidate.isCurrent,commit:candidate.commit,
                rollback:candidate.rollback,discard:candidate.discard}),
            entry('later',{commit:()=>!failLater}),
        ]);
        const handle=boundary.enqueue(batch,{onPublished:()=>candidate.finalize()});
        const settled=failLater ? assert.rejects(handle.promise,{code:'rejected-publication-commit'}) : handle.promise;
        boundary.publishReady(); await settled;
        if (failLater) {
            assert.equal(upstream,0); assert.equal(model.getAlignments(),old); assert.equal(model._publishedInputs,inputs);
            assert.equal(model.roadYAtLocal(100,0,4201),y); assert.equal(model._dirty,true);
            assert.equal(candidate.state,'discarded');
            const retry=drain(model.preparePublicationSteps({authoredPortalReplacements:[]}));
            assert.equal(retry.isCurrent(),true); retry.commit(); retry.finalize();
        } else { assert.equal(upstream,1); assert.equal(candidate.state,'published'); }
        assert.ok(Math.abs(model.roadYAtLocal(100,0,4201)-y-7)<1e-10);
        model.dispose(); assert.equal(f.reads(),0); registry.close(); boundary.close();
    }
});

test('cancellation and disposal release partially prepared and captured query owners at every phase', () => {
    for (const phase of ['alignment-points','bounds-grid-index','alignment-terrain-readiness',
        'alignment-opening-runs','alignment-ribbon','alignment-query-index']) {
        for (const dispose of [false,true]) {
            const f=fixture(), {model}=f; const old=model.getAlignments(), owners=f.reads(); f.change(4);
            const steps=model.preparePublicationSteps({authoredPortalReplacements:[],now:yieldingClock()});
            let next;
            do { next=steps.next(); assert.equal(next.done,false,`missing phase ${phase}`); }
            while (next.value.phase!==phase);
            if (dispose) { model.dispose(); assert.equal(f.reads(),0,`${phase}: dispose releases suspended ownership`); }
            else { steps.return(); assert.equal(f.reads(),owners); assert.equal(model.getAlignments(),old);
                assert.equal(model._dirty,true); assert.equal(model._publicationOwner,null); model.dispose(); }
            steps.return(); assert.equal(f.reads(),0);
        }
    }
});

test('superseded inputs stop before more work, and incomplete evidence cannot delete a published alignment', () => {
    const f=fixture(),{model}=f; const old=model.getAlignments(), owners=f.reads(); f.change(4);
    let current=true;
    const steps=model.preparePublicationSteps({authoredPortalReplacements:[],now:yieldingClock(),isCurrent:()=>current});
    let next;
    do { next=steps.next(); assert.equal(next.done,false); } while(next.value.phase!=='alignment-terrain-readiness');
    const sampled=f.samples(); current=false;
    assert.throws(()=>steps.next(),{code:'road-alignment-preparation-stale'});
    assert.equal(f.samples(),sampled); assert.equal(f.reads(),owners); assert.equal(model.getAlignments(),old);
    f.change(4,true);
    assert.throws(()=>drain(model.preparePublicationSteps({authoredPortalReplacements:[]})),{code:'road-alignment-terrain-incomplete'});
    assert.equal(model.getAlignments(),old); assert.equal(f.reads(),owners);
    f.change(4,false);
    const pending=drain(model.preparePublicationSteps({authoredPortalReplacements:[]}));
    f.change(5); assert.equal(pending.isCurrent(),false); assert.equal(pending.commit(),false);
    pending.discard(); assert.equal(model.getAlignments(),old); model.dispose(); assert.equal(f.reads(),0);
});

test('nearest index build and distant exact scans both yield and cancel without reading further points', () => {
    let reads=0,current=true;
    const points=Array.from({length:1001},(_,i)=>({get x(){reads++;return i;},z:0}));
    const cumulative=Array.from({length:1001},(_,i)=>i);
    const build=createIndexedPolylineNearestSteps(points,cumulative,{now:yieldingClock(),isCurrent:()=>current});
    let next;
    do { next=build.next(); assert.equal(next.done,false); } while(next.value.phase!=='bounds-grid-index');
    const stoppedAt=reads; current=false;
    assert.throws(()=>build.next(),{code:'road-alignment-preparation-stale'}); assert.equal(reads,stoppedAt);
    current=true;
    const nearest=drain(createIndexedPolylineNearestSteps(points,cumulative));
    let time=0,start=0;
    const clock={expired(){if(!current)throw new Error('stale');return (time+=.3)-start>=.5;},
        restart(){if(!current)throw new Error('stale');start=time;}};
    const query=nearest.prepareSteps(501.25,1000,clock);
    assert.equal(query.next().done,false); const paused=reads;current=false;
    assert.throws(()=>query.next(),/stale/); assert.equal(reads,paused);
    assert.equal(nearest(501.25,1000).s,501.25);
});

// A pier or breakwater carries a real road over water the DGU grid does not
// model, so its terrain samples never arrive. Rejecting the candidate for that
// discards every other layer in the shared ground generation — including the
// coast collar, which is prepared last — so Split lost its shore entirely.
// Only the sea mask may settle it; everything else still has to retry.
test('an alignment the sea mask covers is skipped, not thrown, and the rest of the model survives', () => {
    const f = fixture(), { model } = f;
    const published = model.getAlignments(), owners = f.reads();
    f.change(4, true);

    // No mask: indistinguishable from terrain still streaming, so it throws.
    assert.throws(() => drain(model.preparePublicationSteps({ authoredPortalReplacements: [] })),
        { code: 'road-alignment-terrain-incomplete' });
    assert.equal(model.getAlignments(), published);

    // Mask covering the alignment: the gap can never close, so it is skipped.
    const sea = { contains: () => true };
    const pending = drain(model.preparePublicationSteps({ authoredPortalReplacements: [], mappedWater: sea }));
    assert.ok(pending, 'the generation must still produce a candidate');
    assert.deepEqual(pending.read.getAlignments(), [],
        'an alignment that can never be grounded is left uncompiled');
    pending.discard();
    assert.equal(model.getAlignments(), published, 'a discarded candidate cannot delete published alignments');

    // A mask that does not cover the point proves nothing, so it still throws.
    const elsewhere = { contains: () => false };
    assert.throws(() => drain(model.preparePublicationSteps({ authoredPortalReplacements: [], mappedWater: elsewhere })),
        { code: 'road-alignment-terrain-incomplete' });
    model.dispose();
    assert.equal(f.reads(), 0, 'no retained read may leak through either path');
});
