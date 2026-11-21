// Audit material coverage independently from the physical receiver and replay
// missing material observations from the recorded source intent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { groundPaintAuditHits } from '../core/ground-paint-inspection.js';
import { compileSurfaceClaim } from '../core/surface-hierarchy.js';
import { classifySurfaceStack } from '../core/surface-audit.js';
import { createSurfaceAuditRecording, classifyRecordedSurfaceCell } from '../core/surface-audit-recording.js';
const receiver={key:'ground',verticalBand:'ground',coverageRevision:'r1'};
const hit={y:0,claim:compileSurfaceClaim({surfaceClass:'terrain',verticalBand:'ground',
    verticalRelation:'same-level',coverageState:'published',supportReady:true}),objectName:'Terrain',publicationKey:'terrain:0:0'};
const paint={key:'plaza',receiver,claim:compileSurfaceClaim({surfaceClass:'sidewalk',verticalBand:'ground',
    verticalRelation:'same-level',coverageState:'published',supportReady:false,cutsBackstop:false,ownerId:'plaza'})};

test('painted ground remains one colour draw with independent terrain support',()=>{
    const observed=groundPaintAuditHits(hit,{receiver,normalY:1,visible:paint,expected:paint});
    const result=classifySurfaceStack(observed.hits,{expectedHits:observed.expectedHits,terrainCovered:true});
    assert.deepEqual(result.violations,[]);
    assert.equal(result.coverage.expectedPaint,true);
    assert.equal(result.coverage.support,true);
    assert.equal(observed.hits[0].claim.capabilities.color,false);
    assert.equal(observed.hits[1].claim.capabilities.support,false);
    assert.equal(observed.hits[1].physicalReceiver.publicationKey,'terrain:0:0');
});
test('missing page coverage cannot erase source intent or pass a recorded replay',()=>{
    const observed=groundPaintAuditHits(hit,{receiver,normalY:1,visible:null,expected:paint});
    const result=classifySurfaceStack(observed.hits,{expectedHits:observed.expectedHits,terrainCovered:true});
    assert.ok(result.violations.some(v=>v.cause==='missing-paint'));
    const recording=createSurfaceAuditRecording();
    recording.recordCell({x:0,z:0,terrainCovered:true,...observed});
    assert.deepEqual(classifyRecordedSurfaceCell(recording.result(),0),result);
});
test('undersides, another receiver and higher-rank tops reject the ordinary paint',()=>{
    for(const input of [{receiver,normalY:-1},{receiver:{...receiver,key:'bridge'},normalY:1},
        {receiver:{...receiver,coverageRevision:'new'},normalY:1}]) {
        assert.deepEqual(groundPaintAuditHits(hit,{...input,visible:paint,expected:paint}).hits,[hit]);
    }
    const top={...hit,claim:compileSurfaceClaim({surfaceClass:'rail-steel',verticalBand:'ground'})};
    assert.deepEqual(groundPaintAuditHits(top,{receiver,normalY:1,visible:paint,expected:paint}).hits,[top]);
});
