import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildProposalCorridorJunctionRing,
    findProposalCorridorJunctions,
    proposalCorridorPointKey,
    splitProposalCorridorAtJunctions,
    topologizeProposalCorridorEntries,
} from '../world/proposal-corridor.js';

const ORIGIN_LAT = 45;
const ORIGIN_LON = 16;
const METRES_PER_DEGREE_LAT = 111320;
const METRES_PER_DEGREE_LON = METRES_PER_DEGREE_LAT
    * Math.cos(ORIGIN_LAT * Math.PI / 180);

function geographicPoint(x, z) {
    return {
        lat: ORIGIN_LAT - z / METRES_PER_DEGREE_LAT,
        lng: ORIGIN_LON + x / METRES_PER_DEGREE_LON,
    };
}

function entry(id, points, widthM = 8) {
    return { id, topologyId: id, points, widthM };
}

test('snaps a near-miss side-road endpoint into one shared T-junction node', () => {
    const source = [
        entry('through', [geographicPoint(-30, 0), geographicPoint(30, 0)], 10),
        entry('side', [geographicPoint(0.45, 24), geographicPoint(0.45, 0.42)], 8),
    ];
    const resolved = topologizeProposalCorridorEntries(source);
    assert.equal(source[0].points.length, 2, 'topology resolution must not mutate source data');
    assert.equal(resolved[0].points.length, 3,
        'the through road receives an explicit vertex at the side-road mouth');
    const sharedThrough = resolved[0].points[1];
    const sharedSide = resolved[1].points.at(-1);
    assert.equal(proposalCorridorPointKey(sharedThrough), proposalCorridorPointKey(sharedSide));
    assert.ok(Math.abs(sharedThrough.lat - ORIGIN_LAT) < 1e-10,
        'the noisy side-road endpoint snaps to the through-road centreline');

    const junctions = findProposalCorridorJunctions(resolved);
    assert.equal(junctions.size, 1);
    const [junction] = junctions.values();
    assert.equal(junction.arms.length, 3);
    assert.deepEqual(new Set(junction.entryIds), new Set(['through', 'side']));
});

test('keeps same-named segments from separate proposals as distinct junction members', () => {
    const node = geographicPoint(0, 0);
    const entries = [
        {
            ...entry('s1', [geographicPoint(-30, 0), node, geographicPoint(30, 0)], 10),
            topologyId: 'proposal-road:253:s1:0',
        },
        {
            ...entry('s1', [node, geographicPoint(0, 30)], 8),
            topologyId: 'proposal-road:293:s1:0',
        },
    ];
    const junctions = findProposalCorridorJunctions(entries);
    assert.equal(junctions.size, 1);
    assert.deepEqual(
        new Set(junctions.values().next().value.entryIds),
        new Set(['proposal-road:253:s1:0', 'proposal-road:293:s1:0']),
        'proposal-local segment ids must not collapse the incident formation owners',
    );
});

test('does not turn a nearby parallel frontage-road endpoint into a junction', () => {
    const source = [
        entry('through', [geographicPoint(-30, 0), geographicPoint(30, 0)]),
        entry('frontage', [geographicPoint(-15, 0.4), geographicPoint(0, 0.4)]),
    ];
    const resolved = topologizeProposalCorridorEntries(source);
    assert.deepEqual(resolved.map(item => item.points.length), [2, 2]);
    assert.equal(findProposalCorridorJunctions(resolved).size, 0);
});

test('does not infer an at-grade junction from an unconnected interior crossing', () => {
    const source = [
        entry('over', [geographicPoint(-30, 0), geographicPoint(30, 0)]),
        entry('under', [geographicPoint(0, -30), geographicPoint(0, 30)]),
    ];
    const resolved = topologizeProposalCorridorEntries(source);
    assert.deepEqual(resolved.map(item => item.points.length), [2, 2]);
    assert.equal(findProposalCorridorJunctions(resolved).size, 0,
        'an interior/interior crossing needs explicit topology before it becomes a crossroads');
});

test('trimmed junction arms retain open-mouth metadata instead of becoming road ends', () => {
    const node = geographicPoint(0, 0);
    const entries = [
        entry('through', [geographicPoint(-30, 0), node, geographicPoint(30, 0)], 10),
        entry('side', [node, geographicPoint(0, 30)], 8),
    ];
    const junctions = findProposalCorridorJunctions(entries);
    const [junction] = junctions.values();
    assert.ok(junction.radiusM > junction.trimM,
        'the apron radius and centerline cutback are different dimensions');
    assert.ok(junction.radiusM > Math.hypot(junction.trimM, 5),
        'the apron must overlap the widest branch mouth corners');
    const apronRing = buildProposalCorridorJunctionRing(junction);
    assert.equal(apronRing.length, 7,
        'the T junction is a six-corner branch-mouth hull, not a generic circle');
    const throughPieces = splitProposalCorridorAtJunctions(entries[0], junctions);
    const sidePieces = splitProposalCorridorAtJunctions(entries[1], junctions);
    assert.equal(throughPieces.length, 2);
    assert.equal(throughPieces[0].junctionEnd, true);
    assert.equal(throughPieces[1].junctionStart, true);
    assert.equal(sidePieces.length, 1);
    assert.equal(sidePieces[0].junctionStart, true);
    assert.equal(sidePieces[0].junctionEnd, false);
    assert.ok(sidePieces[0].points.length >= 2);
    const trimDistanceM = (point) => Math.hypot(
        (point.lng - node.lng) * METRES_PER_DEGREE_LON,
        (point.lat - node.lat) * METRES_PER_DEGREE_LAT,
    );
    assert.ok(Math.abs(trimDistanceM(throughPieces[0].points.at(-1)) - junction.trimM) < 0.02,
        'branches end at the centerline trim, not at the larger apron radius');
});
