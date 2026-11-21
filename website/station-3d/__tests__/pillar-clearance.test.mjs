import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPillarClearanceEvaluator, createPillarClearanceEvaluatorSteps, PILLAR_CLEARANCE_LIMITS } from '../core/pillar-clearance.js';

const ANCHOR_LAT = 45.8;
const ANCHOR_LON = 16;
const metresPerLat = 6371000 * Math.PI / 180;
const metresPerLon = metresPerLat * Math.cos(ANCHOR_LAT * Math.PI / 180);

function line(points) {
    return {
        type: 'Feature',
        properties: {},
        geometry: {
            type: 'LineString',
            coordinates: points.map(([x, z]) => [
                ANCHOR_LON + x / metresPerLon,
                ANCHOR_LAT - z / metresPerLat,
            ]),
        },
    };
}

test('a viaduct pier ignores its carrying feature but still avoids adjacent track', () => {
    const carryingTrack = line([[-50, 0], [50, 0]]);
    const adjacentTrack = line([[-50, 10], [50, 10]]);
    const clearance = createPillarClearanceEvaluator(
        ANCHOR_LAT,
        ANCHOR_LON,
        [carryingTrack, adjacentTrack],
        { roadClearanceM: 0, trackClearanceM: 3 },
    );
    assert.ok(clearance(0, 0) < 0, 'the carrying track blocks a non-self-aware caller');
    assert.ok(clearance(0, 0, { ignoreTrackFeature: carryingTrack }) > 0,
        'the pier may stand below its own deck');
    assert.ok(clearance(0, 10, { ignoreTrackFeature: carryingTrack }) < 0,
        'the adjacent track remains an obstacle');
});

const finish = steps => { try { for (;;) { const next=steps.next(); if(next.done)return next.value; } } finally { steps.return(); } };
test('the captured dense Zagreb reference cell keeps exact clearance and feature exclusion', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/pillar-clearance-zagreb-dense.json', import.meta.url)));
    const { anchorLat, anchorLon, features, cell } = fixture;
    const m = Math.PI / 180 * 6371000, scale = m * Math.cos(anchorLat * Math.PI / 180);
    const segments = features.flatMap(feature => feature.geometry.coordinates.slice(1).map((b, i) => {
        const a = feature.geometry.coordinates[i];
        return { feature, ax: (a[0] - anchorLon) * scale, az: -(a[1] - anchorLat) * m,
            bx: (b[0] - anchorLon) * scale, bz: -(b[1] - anchorLat) * m };
    }));
    assert.equal(segments.length, fixture.cellSegments);
    const evaluate = createPillarClearanceEvaluator(anchorLat, anchorLon, features, { roadSegmentsAt: () => [] });
    for (const ignored of [null, ...features]) for (let i = 0; i < 40; i++) {
        const x = cell[0] * 60 + (i * 13) % 60, z = cell[1] * 60 + (i * 7) % 60;
        let distance = Infinity;
        for (const segment of segments) {
            if (segment.feature === ignored) continue;
            const { ax, az, bx, bz } = segment, dx = bx - ax, dz = bz - az;
            const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
            distance = Math.min(distance, Math.hypot(x - ax - t * dx, z - az - t * dz));
        }
        assert.ok(Math.abs(evaluate(x, z, { ignoreTrackFeature: ignored }) - (distance - 3)) < 1e-8);
    }
});

test('cooperative planner clearance captures only ground obstacles and retains road median semantics',()=>{
    const tracks=line([[-50,0],[50,0]]), elevated=line([[-50,20],[50,20]]);
    elevated.geometry.coordinates.forEach(p=>p[2]=10);
    const multilines={geometry:{type:'MultiLineString',coordinates:[tracks.geometry.coordinates,elevated.geometry.coordinates]}};
    const toRoad=feature=>feature.geometry.coordinates.flat();
    const roads=[toRoad(line([[-50,45],[50,45]])),toRoad(line([[-50,55],[50,55]]))];
    let time=0,stepsSeen=0;
    const steps=createPillarClearanceEvaluatorSteps(ANCHOR_LAT,ANCHOR_LON,[multilines],{
        groundTracksOnly:true,roadSegmentsAt:()=>roads,now:()=>time+=1,
    });
    let evaluate;
    for(;;){const next=steps.next();if(next.done){evaluate=next.value;break;}stepsSeen++;}
    assert.ok(stepsSeen>0);
    assert.ok(Math.abs(evaluate(0,0)+3)<1e-8);
    assert.ok(evaluate(0,20)>0,'a planner deck cannot reject every pier beneath itself');
    assert.ok(Math.abs(evaluate(0,50)-1.6)<1e-8,'a five-metre divided-road median remains usable');
    tracks.geometry.coordinates[0][1]+=1;
    assert.ok(Math.abs(evaluate(0,0)+3)<1e-8,'captured track coordinates do not alias mutable sources');
});

test('pillar source, spatial and local query limits reject complete inputs and cancellation never returns a partial index',()=>{
    const feature=line([[-100,0],[100,0]]);
    for(const patch of[{maxFeatures:1},{maxCoordinates:1},{maxIndexEntries:1},{maxCellCandidates:1}]){
        assert.throws(()=>finish(createPillarClearanceEvaluatorSteps(ANCHOR_LAT,ANCHOR_LON,[feature,feature],{
            limits:{...PILLAR_CLEARANCE_LIMITS,...patch},roadSegmentsAt:()=>[],
        })),{code:'ground-generation-capacity'});
    }
    const evaluate=finish(createPillarClearanceEvaluatorSteps(ANCHOR_LAT,ANCHOR_LON,[],{
        limits:{...PILLAR_CLEARANCE_LIMITS,maxRoadCandidates:1},roadSegmentsAt:()=>[[16,45.8,16,45.9],[16,45.8,16,45.9]],
    }));
    assert.throws(()=>evaluate(0,0),{code:'ground-generation-capacity'});
    let current=true,time=0;
    const steps=createPillarClearanceEvaluatorSteps(ANCHOR_LAT,ANCHOR_LON,[feature],{now:()=>time+=1,isCurrent:()=>current});
    assert.equal(steps.next().done,false);current=false;
    assert.throws(()=>finish(steps),{code:'ground-generation-stale'});
});
