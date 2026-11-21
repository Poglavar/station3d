// Production proposal queries and road task boundaries must keep the same
// mask decision while a yielded build is waiting for publication.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as groundReadEvidence from '../core/ground-read-evidence.js';
import { retainReadSnapshot } from '../core/read-snapshot-lifetime.js';

const source = readFileSync(new URL('../world/proposals.js', import.meta.url), 'utf8');
const square = (a, b) => [[a, a], [b, a], [b, b], [a, b], [a, a]];
const feature = (a, b) => ({ geometry: { type: 'Polygon', coordinates: [square(a, b)] }, properties: {} });
function fixture() {
    const runtime = vm.createContext({});
    const declarations = source.slice(source.indexOf('let maskPolygons ='), source.indexOf('// The subset contributed'));
    const helpers = source.slice(source.indexOf('function ringAabb('), source.indexOf('export function getProposalsBuildingsGroup('));
    vm.runInContext((declarations + helpers).replace(/^export /gm, ''), runtime);
    return runtime;
}

test('one immutable proposal read is shared until an edit; source coordinates and holes remain owned', () => {
    const f = fixture(), empty = f.captureProposalMaskSnapshot();
    assert.equal(f.captureProposalMaskSnapshot(), empty);
    const outer = square(0, 10), hole = square(3, 7), aabb = { minLat: 0, maxLat: 10, minLon: 0, maxLon: 10 };
    f.addMaskPolygon(outer, aabb, [hole]);
    const read = f.captureProposalMaskSnapshot();
    assert.equal(empty.isCurrent(), false); assert.equal(empty.isFeatureMasked(feature(1, 2)), false);
    assert.equal(read.isFeatureMasked(feature(1, 2)), true);
    assert.equal(read.isFeatureMasked(feature(4, 5)), false);
    assert.equal(read.isFeatureMasked(feature(21, 22)), false);
    outer.forEach(p => { p[0] += 100; p[1] += 100; });
    hole.forEach(p => { p[0] += 100; p[1] += 100; });
    aabb.minLat = 100;
    assert.equal(read.isFeatureMasked(feature(1, 2)), true);
    assert.equal(read.isFeatureMasked(feature(4, 5)), false);
    assert.equal(f.captureProposalMaskSnapshot(), read, 'no per-road copying for unchanged masks');
    f.addMaskPolygon(square(20, 30));
    assert.equal(read.isCurrent(), false); assert.equal(read.isFeatureMasked(feature(21, 22)), false);
    assert.equal(f.captureProposalMaskSnapshot().isFeatureMasked(feature(21, 22)), true);
    // Execute the actual session reset statements, rather than simulating a
    // reset by only changing the diagnostic revision in this fixture.
    const reset = source.match(/        maskPolygons = \[\];\n        maskRevision\+\+;\n        maskReadSnapshot = null;/)?.[0];
    assert.ok(reset, 'proposal teardown must reset its snapshot owner');
    vm.runInContext(reset, f);
    assert.equal(f.captureProposalMaskSnapshot().isFeatureMasked(feature(1, 2)), false);
    assert.equal(read.isFeatureMasked(feature(1, 2)), true);
});

test('the real yielded road task consumes its captured mask and rejects a changed proposal revision', () => {
    const f = fixture(), observations = [];
    const capture = f.captureProposalMaskSnapshot;
    f.captureProposalMaskSnapshot = () => {
        const read = capture();
        return { isCurrent: read.isCurrent, isFeatureMasked(value) {
            const masked = read.isFeatureMasked(value); observations.push(masked); return masked;
        } };
    };
    Object.assign(f, { ...groundReadEvidence, retainReadSnapshot, profNow: () => 0, profAdd() {},
        roadReplacementPublicationReadyForOsmId: () => false, surfacePublications: null,
        roadRenderQueryBounds: () => null, anchorLat: 0, anchorLon: 0,
    });
    const roads = readFileSync(new URL('../world/roads.js', import.meta.url), 'utf8');
    vm.runInContext(roads.slice(roads.indexOf('function createRoadFeatureTask('), roads.indexOf('function buildRoadFeatureGroup('))
        + roads.slice(roads.indexOf('function prepareRoadFeature('), roads.indexOf('function appendRoadRingSurface(')), f);
    const road = feature(1, 2);
    // A standalone rail aborts after masking; the road compiler's other
    // geometry branches are covered by the full road/terrain builder tests.
    road.properties.railway_type = 'rail';
    const ground = { roadFormation: null, verticalAlignments: null, isCurrent: () => true };
    const task = f.createRoadFeatureTask(road, 'a', ground);
    assert.equal(task.step(), 'more'); assert.equal(task.isCurrent(), true);
    f.addMaskPolygon(square(0, 10));
    assert.equal(task.isCurrent(), false);
    assert.equal(task.step(), 'abort');
    assert.deepEqual(observations, [false], 'setup uses the earlier captured decision even if called after staleness');
    const retry = f.createRoadFeatureTask(road, 'a', ground);
    assert.equal(retry.step(), 'more'); assert.equal(retry.step(), 'abort');
    assert.deepEqual(observations, [false, true]);
});

test('captured rail masks retain line crossing and hole decisions after the live proposal changes', () => {
    const f = fixture();
    const line = coordinates => ({ geometry: { type: 'LineString', coordinates } });
    f.addMaskPolygon(square(0, 10), null, [square(3, 7)]);
    const old = f.captureProposalMaskSnapshot();
    assert.equal(old.isLineStringMasked(line([[-2, 2], [12, 2]])), true);
    assert.equal(old.isLineStringMasked(line([[4, 4], [6, 6]])), false);
    const distant = line([[21, 21], [22, 22]]);
    assert.equal(old.isLineStringMasked(distant), false);
    f.addMaskPolygon(square(20, 30));
    assert.equal(old.isCurrent(), false);
    assert.equal(old.isLineStringMasked(distant), false);
    assert.equal(f.captureProposalMaskSnapshot().isLineStringMasked(distant), true);
});
