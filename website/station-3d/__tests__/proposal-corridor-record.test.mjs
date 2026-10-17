// Corridor proposals arrive in consensus-builder's stored shape: an OSM document
// under `definition.osm`. The records below are trimmed copies of published
// plan records (a road of two stretches and the start of an imported railway).
import test from 'node:test';
import assert from 'node:assert/strict';
import { proposalCorridorView } from '../core/proposal-corridor-record.js';
import { proposalCorridorSegmentEntries } from '../world/proposal-corridor.js';
import { buildProposalTrackFeatures } from '../core/proposal-track.js';

const ROAD_TAGS = {
    lanes: '2', width: '7.5', highway: 'road', 'width:lanes': '2.75|2.75',
    'lanes:forward': '1', 'lanes:backward': '1', 'sidewalk:both': 'yes', 'sidewalk:both:width': '1',
};
const road = () => ({
    metadata: { isRoad: true, isTrack: false, isCorridor: true, trackSpeed: 120, trackMinRadius: 1000 },
    osm: {
        version: 0.6,
        generator: 'consensus-builder',
        elements: [
            { id: -1, lat: 43.755341294675034, lon: 15.86480498313904, type: 'node' },
            { id: -2, lat: 43.75490599967992, lon: 15.864337171134236, type: 'node' },
            { id: -3, lat: 43.754660484731396, lon: 15.864073315951964, type: 'node' },
            { id: -1, type: 'way', nodes: [-1, -2], tags: { ...ROAD_TAGS, 'cb:segment': 's8' } },
            { id: -2, type: 'way', nodes: [-2, -3], tags: { ...ROAD_TAGS, 'cb:segment': 's8~2' } },
        ],
    },
    tunnels: [],
    gradeSeparations: [],
});

const track = () => ({
    metadata: {
        mode: 'import', type: 'track', isRoad: false, levels: true, source: 'transit-project',
        isTrack: true, isCorridor: true, trackCount: 2, elevationDatum: 'EVRF2000',
    },
    osm: {
        version: 0.6,
        generator: 'consensus-builder',
        elements: [
            { id: -1, lat: 43.72789426137266, lon: 15.90049982070923, tags: { ele: '2.44', 'cb:level': '0' }, type: 'node' },
            { id: -2, lat: 43.72845247379096, lon: 15.899941921234133, tags: { ele: '2.44', 'cb:level': '0' }, type: 'node' },
            { id: -3, lat: 43.72870831941075, lon: 15.899223089218141, tags: { ele: '2.44', 'cb:level': '0' }, type: 'node' },
            { id: -4, lat: 43.7290882093756, lon: 15.898118019104006, tags: { ele: '2.44', 'cb:level': '0' }, type: 'node' },
            { id: -5, lat: 43.72935180507809, lon: 15.897388458251955, tags: { ele: '2.44', 'cb:level': '-0.02' }, type: 'node' },
            { id: -6, lat: 43.72963865790682, lon: 15.896873474121096, tags: { ele: '1.4600134598810965', 'cb:level': '-0.229' }, type: 'node' },
            { id: -1, type: 'way', nodes: [-1, -2, -3, -4, -5, -6], tags: { gauge: '1435', width: '6', tracks: '2', railway: 'rail' } },
        ],
    },
});

test('a stored road record yields its stretches with their cross-section', () => {
    const entries = proposalCorridorSegmentEntries(road());
    assert.deepEqual(entries.map(entry => entry.id), ['s8', 's8~2']);
    assert.deepEqual(entries.map(entry => entry.points.length), [2, 2]);
    assert.deepEqual(entries[0].points[0], { lat: 43.755341294675034, lng: 15.86480498313904 });
    for (const entry of entries) {
        assert.equal(entry.widthM, 7.5);
        assert.deepEqual(entry.profile.strips, [
            { type: 'sidewalk', width: 1 },
            { type: 'driving', width: 2.75, direction: 'backward' },
            { type: 'driving', width: 2.75, direction: 'forward' },
            { type: 'sidewalk', width: 1 },
        ]);
    }
});

test('a stored railway record builds its track at the authored heights', () => {
    const features = buildProposalTrackFeatures(track(), '486');
    assert.equal(features.length, 1);
    const [feature] = features;
    assert.equal(feature.properties.elevationMode, 'absolute');
    assert.equal(feature.properties.trackCount, 2);
    assert.equal(feature.properties.gaugeMm, 1435);
    assert.deepEqual(feature.geometry.coordinates.at(-1), [15.896873474121096, 43.72963865790682, 1.4600134598810965]);
    assert.equal(feature.geometry.coordinates.length, 6);
});

test('a way that differs from the first becomes a per-stretch cross-section', () => {
    const record = road();
    record.osm.elements[4].tags = { 'cb:lanes': 'sidewalk:2|driving:3:forward|sidewalk:2', 'cb:segment': 's8~2' };
    const view = proposalCorridorView(record);
    assert.deepEqual(view.segmentIds, ['s8', 's8~2']);
    assert.deepEqual(Object.keys(view.segmentProfiles), ['s8~2']);
    assert.deepEqual(proposalCorridorSegmentEntries(record).map(entry => entry.widthM), [7.5, 7]);
});

test('a record without an OSM document has no stretches to draw', () => {
    assert.equal(proposalCorridorView({ metadata: { isTrack: false }, points: [], polygon: null }), null);
    assert.deepEqual(proposalCorridorSegmentEntries({ metadata: {}, points: [] }), []);
});
