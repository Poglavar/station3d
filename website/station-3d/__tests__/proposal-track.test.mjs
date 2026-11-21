// The proposal-to-GeoJSON rail adapter and its elevation contract — three
// flavours: absolute EVRF2000 per point, per-point LEVELS (a transit-project
// import: the solved profile as ground-relative metres ÷ 10), and bare points
// that leave the profile to the sim's own grade design. Proposals arrive as the
// OSM document consensus-builder stores (definition.osm, 2d73946): node tags
// `ele` and `cb:level` carry the heights, way tags the cross-section.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import {
    buildProposalTrackFeatures,
    isAuthoredPlannerRailFeature,
    LEVEL_HEIGHT_M,
    mergeProposalTrackFeatures,
    startPoseForTrackFeatures,
    transitProjectTrackPhysicalId,
    transitProposalTrackPhysicalId,
} from '../core/proposal-track.js';

// A rail proposal as consensus-builder stores it (definition.osm): one way over
// the points, node tags `ele`/`cb:level` for heights, the cross-section in way
// tags (cb:lanes when one is drawn, else a plain single-track railway=rail).
function railProposal({ metadata, points, profile = null }) {
    const flat = points.flat();
    const elements = flat.map((point, index) => {
        const tags = {};
        if (point.elevationM !== undefined) tags.ele = String(point.elevationM);
        if (point.level !== undefined) tags['cb:level'] = String(point.level);
        return { id: -(index + 1), type: 'node', lat: point.lat, lon: point.lng, tags };
    });
    const wayTags = profile
        ? { 'cb:lanes': profile.strips.map(lane => [lane.type, lane.width, ...(lane.gauge ? [`gauge=${lane.gauge}`] : [])].join(':')).join('|') }
        : { railway: 'rail' };
    elements.push({ id: -1, type: 'way', nodes: flat.map((_, index) => -(index + 1)), tags: wayTags });
    return { metadata, osm: { version: 0.6, generator: 'consensus-builder', elements } };
}

test('flat proposal masks cannot delete authored planner rail alignments', () => {
    for (const source of ['cb-proposal', 'user', 'user-line']) {
        assert.equal(
            isAuthoredPlannerRailFeature({ properties: { source } }),
            true,
            `${source} carries authored vertical ownership`,
        );
    }
    assert.equal(
        isAuthoredPlannerRailFeature({ properties: { source: 'osm' } }),
        false,
        'ordinary background rails retain proposal replacement masking',
    );
    assert.equal(
        isAuthoredPlannerRailFeature({ feature: { properties: { source: 'user-line' } } }),
        true,
        'derived rail segments retain their authored source contract',
    );
});


test('a transit proposal has the same physical identity as its source project track', () => {
    assert.equal(
        transitProjectTrackPhysicalId(141, 1),
        'transit-project-141-track-1',
    );
    assert.equal(transitProposalTrackPhysicalId({
        proposalId: 'transit-project-141-track-1',
        source: { transitProjectId: 141 },
    }), 'transit-project-141-track-1');
    assert.equal(transitProposalTrackPhysicalId({
        proposalId: 'transit-project-141-track-1',
        source: { transitProjectId: 999 },
    }), null, 'a conflicting provenance record must not claim the project track');
});

test('the imported proposal becomes the sole structure owner for its open project track', () => {
    const physicalId = transitProjectTrackPhysicalId(141, 1);
    const projectFeature = {
        type: 'Feature',
        properties: {
            source: 'user',
            trackId: 1,
            electrified: true,
            voltage: 25000,
            railPhysicalId: physicalId,
            railSourceGeometryHash: 'geometry-v1',
        },
        geometry: { type: 'LineString', coordinates: [[15.9, 43.7, 2], [15.8, 43.8, 4]] },
    };
    const proposalFeature = {
        type: 'Feature',
        properties: {
            source: 'cb-proposal',
            proposalId: '701',
            elevationMode: 'absolute',
            railPhysicalId: physicalId,
            railSourceGeometryHash: 'geometry-v1',
            railSourceChainagesM: [0, 100],
            railCivilRuns: [{ startM: 0, endM: 100, structure: 'viaduct' }],
        },
        geometry: { type: 'LineString', coordinates: [[15.9, 43.7, 2], [15.85, 43.75, 3], [15.8, 43.8, 4]] },
    };
    const result = mergeProposalTrackFeatures([projectFeature], [proposalFeature]);

    assert.equal(result.length, 1, 'one physical railway must not enter clearance twice');
    assert.equal(result[0].properties.source, 'user');
    assert.equal(result[0].properties.trackId, 1);
    assert.equal(result[0].properties.electrified, true);
    assert.equal(result[0].properties.proposalId, '701');
    assert.deepEqual(result[0].properties.railCivilRuns, proposalFeature.properties.railCivilRuns);
    assert.equal(result[0].geometry, proposalFeature.geometry,
        'the civil run chainages belong to the proposal geometry');

    const changedProposal = {
        ...proposalFeature,
        properties: {
            ...proposalFeature.properties,
            railSourceGeometryHash: 'geometry-v2',
        },
    };
    assert.equal(
        mergeProposalTrackFeatures([projectFeature], [changedProposal]).length,
        2,
        'a newer project alignment and an older proposal snapshot remain distinct',
    );
});

test('defaults an unlevelled rail proposal to conservative train grading', () => {
    const [feature] = buildProposalTrackFeatures(railProposal({
        metadata: { isTrack: true },
        points: [{ lng: 16.4, lat: 43.5 }, { lng: 16.3, lat: 43.51 }],
    }), 5);
    assert.equal(feature.properties.railMode, 'train');
    assert.equal(feature.properties.trackType, 'g1435');
    assert.equal(feature.properties.gaugeMm, 1435);
    assert.equal(feature.properties.elevationMode, 'terrain-graded');
    assert.equal(feature.properties.terrainFormation, 'smooth-grade');
    assert.deepEqual(feature.geometry.coordinates[0], [16.4, 43.5]);
});

test('preserves complete EVRF2000 authored heights', () => {
    const [feature] = buildProposalTrackFeatures(railProposal({
        metadata: { isTrack: true, trackType: 'tram', elevationDatum: 'EVRF2000' },
        // Stored as a tram line carries it: one metre-gauge lane.
        profile: { strips: [{ type: 'rail', width: 2.75, gauge: 1000 }] },
        points: [
            { lng: 16.4, lat: 43.5, elevationM: 12.5 },
            { lng: 16.3, lat: 43.51, elevationM: 13.25 },
        ],
    }), 8);
    assert.equal(feature.properties.railMode, 'tram');
    assert.equal(feature.properties.trackType, 'g1000');
    assert.equal(feature.properties.gaugeMm, 1000);
    assert.equal(feature.properties.elevationMode, 'absolute');
    assert.equal(feature.properties.elevationDatum, 'EVRF2000');
    assert.deepEqual(feature.geometry.coordinates[1], [16.3, 43.51, 13.25]);
});

test('per-point levels become ground-relative metres — the transit-project import shape', () => {
    // Fractional levels are the SOLVED profile at full precision: level
    // -0.854 is -8.54 m below ground, level 1 a +10 m deck (the bay bridge).
    const [feature] = buildProposalTrackFeatures(railProposal({
        metadata: { isTrack: true, mode: 'import', source: 'transit-project' },
        points: [
            { lng: 15.852, lat: 43.7503, level: 1 },
            { lng: 15.8437, lat: 43.7452, level: 0.624 },
            { lng: 15.84, lat: 43.742, level: 0 },
            { lng: 15.83, lat: 43.741 },   // undrawn = grade, not missing data
        ],
    }), 701);
    assert.equal(feature.properties.elevationMode, 'ground-relative');
    assert.equal(feature.properties.terrainFormation, 'authored-elevation');
    assert.equal('elevationDatum' in feature.properties, false);
    assert.deepEqual(feature.geometry.coordinates[0], [15.852, 43.7503, 1 * LEVEL_HEIGHT_M]);
    assert.deepEqual(feature.geometry.coordinates[1], [15.8437, 43.7452, 6.24]);
    assert.deepEqual(feature.geometry.coordinates[2], [15.84, 43.742, 0]);
    assert.deepEqual(feature.geometry.coordinates[3], [15.83, 43.741, 0]);
});

test('the cross-section names the track count and gauge — one rail lane per parallel track', () => {
    // The transit-project importer stores this profile since 2026-08: two 3 m rail
    // lanes at 1435 mm. Rendering must ride the cross-section, not the land-take
    // width, or the double-track bay bridge draws single-track.
    const [feature] = buildProposalTrackFeatures(railProposal({
        metadata: { isTrack: true, mode: 'import', source: 'transit-project' },
        profile: { strips: [
            { type: 'rail', width: 3, gauge: 1435 },
            { type: 'rail', width: 3, gauge: 1435 },
        ] },
        points: [{ lng: 15.85, lat: 43.75 }, { lng: 15.84, lat: 43.74 }],
    }), 701);
    assert.equal(feature.properties.trackCount, 2);
    assert.equal(feature.properties.trackType, 'g1435');
    assert.equal(feature.properties.gaugeMm, 1435);
});

test('the living cross-section outranks the import-time metadata snapshot', () => {
    const [feature] = buildProposalTrackFeatures(railProposal({
        metadata: { isTrack: true, trackCount: 2, trackGauge: 'g1435' },
        // Edited down to a single metre-gauge lane in the cross-section editor.
        profile: { strips: [
            { type: 'sidewalk', width: 2 },
            { type: 'rail', width: 2.75, gauge: 1000 },
        ] },
        points: [{ lng: 15.85, lat: 43.75 }, { lng: 15.84, lat: 43.74 }],
    }), 12);
    assert.equal(feature.properties.trackCount, 1);
    assert.equal(feature.properties.trackType, 'g1000');
    assert.equal(feature.properties.gaugeMm, 1000);
});


test('mixed-gauge rail lanes name no single gauge — the mode default stands', () => {
    const [feature] = buildProposalTrackFeatures(railProposal({
        metadata: { isTrack: true },
        profile: { strips: [
            { type: 'rail', width: 3.5, gauge: 1435 },
            { type: 'rail', width: 2.75, gauge: 1000 },
        ] },
        points: [{ lng: 15.85, lat: 43.75 }, { lng: 15.84, lat: 43.74 }],
    }), 14);
    assert.equal(feature.properties.trackCount, 2);
    assert.equal(feature.properties.trackType, 'g1435');
});

test('all-grade levels stay a smooth-grade proposal — nothing was authored', () => {
    const [feature] = buildProposalTrackFeatures(railProposal({
        metadata: { isTrack: true },
        points: [
            { lng: 16.4, lat: 43.5, level: 0 },
            { lng: 16.3, lat: 43.51, level: 0 },
        ],
    }), 6);
    assert.equal(feature.properties.elevationMode, 'terrain-graded');
    assert.deepEqual(feature.geometry.coordinates[0], [16.4, 43.5]);
});

test('supplied elevationM outranks levels', () => {
    const [feature] = buildProposalTrackFeatures(railProposal({
        metadata: { isTrack: true, elevationDatum: 'EVRF2000' },
        points: [
            { lng: 16.4, lat: 43.5, elevationM: 40, level: 1 },
            { lng: 16.3, lat: 43.51, elevationM: 42, level: -1 },
        ],
    }), 7);
    assert.equal(feature.properties.elevationMode, 'absolute');
    assert.deepEqual(feature.geometry.coordinates[0], [16.4, 43.5, 40]);
});

test('absolute heights retain an authored viaduct regime from planner levels', () => {
    const [feature] = buildProposalTrackFeatures(railProposal({
        metadata: { isTrack: true, levels: true, elevationDatum: 'EVRF2000' },
        points: [
            { lng: 15.86, lat: 43.75, elevationM: 24, level: 0 },
            { lng: 15.85, lat: 43.75, elevationM: 28, level: 0.4 },
            { lng: 15.84, lat: 43.75, elevationM: 30, level: 1 },
            { lng: 15.83, lat: 43.75, elevationM: 24, level: 0 },
        ],
    }), 701);
    assert.equal(feature.properties.elevationMode, 'absolute');
    assert.equal(feature.properties.railSourceChainagesM.length, 4);
    assert.deepEqual(feature.properties.railCivilRuns, [{
        startM: 0,
        endM: feature.properties.railSourceChainagesM.at(-1),
        structure: 'viaduct',
    }]);
});

test('the Sibenik bay span remains a viaduct where the DGU has no water samples', () => {
    // Real consecutive nodes around the bay crossing from proposal 701. Keep
    // the regression fixture here: dev-proposal-fixtures is intentionally
    // ignored and a clean worktree must still exercise this contract.
    const [feature] = buildProposalTrackFeatures(railProposal({
        metadata: {
            mode: 'import',
            source: 'transit-project',
            isTrack: true,
            levels: true,
            elevationDatum: 'EVRF2000',
        },
        points: [[
            { lat: 43.75599999284241, lng: 15.86254119873047, level: 0.376, elevationM: 20.142483665653142 },
            { lat: 43.755690018137436, lng: 15.861897468566896, level: 0.624, elevationM: 21.67270852664819 },
            { lat: 43.75317916384935, lng: 15.857219696044924, level: 0, elevationM: 33.19987929082691 },
            { lat: 43.750327201568666, lng: 15.851984024047853, level: 1, elevationM: 30.928882887372048 },
            { lat: 43.74518092578736, lng: 15.843744277954103, level: 1, elevationM: 32.621163973718026 },
            { lat: 43.74121241101398, lng: 15.83859443664551, level: 0, elevationM: 21.334402192962038 },
            { lat: 43.73929006709723, lng: 15.835418701171877, level: 0, elevationM: 18.05039729542953 },
        ]],
    }), 701);
    const chainages = feature.properties.railSourceChainagesM;
    const bayRun = feature.properties.railCivilRuns?.find(run => (
        run.startM <= chainages[2] + 1e-6
        && run.endM >= chainages[5] - 1e-6
    ));
    assert.equal(feature.properties.elevationMode, 'absolute');
    assert.ok(bayRun, 'the authored bay bridge was not published as civil structure');
    assert.equal(bayRun.structure, 'viaduct');
});

test('rejects partial or datum-free supplied elevations', () => {
    assert.throws(() => buildProposalTrackFeatures(railProposal({
        metadata: { isTrack: true, elevationDatum: 'EVRF2000' },
        points: [
            { lng: 16.4, lat: 43.5, elevationM: 12 },
            { lng: 16.3, lat: 43.51 },
        ],
    }), 9), /djelomično/);
    assert.throws(() => buildProposalTrackFeatures(railProposal({
        metadata: { isTrack: true },
        points: [
            { lng: 16.4, lat: 43.5, elevationM: 12 },
            { lng: 16.3, lat: 43.51, elevationM: 13 },
        ],
    }), 9), /EVRF2000/);
});

test('rejects a drawn ROAD — rails on an avenue would be bogus', () => {
    assert.throws(() => buildProposalTrackFeatures(railProposal({
        metadata: { isRoad: true },
        points: [{ lng: 16.4, lat: 43.5 }, { lng: 16.3, lat: 43.51 }],
    }), 10), /tračnička/);
});

test('starts a local track ride from either endpoint', () => {
    const features = [{
        type: 'Feature',
        properties: {},
        geometry: {
            type: 'LineString',
            coordinates: [
                [15.8, 45.8, 120],
                [15.9, 45.81, 118],
                [16.0, 45.82, 116],
            ],
        },
    }];
    const eastbound = startPoseForTrackFeatures(features, 1);
    const westbound = startPoseForTrackFeatures(features, -1);
    assert.deepEqual([eastbound.lon, eastbound.lat], [15.8, 45.8]);
    assert.deepEqual([westbound.lon, westbound.lat], [16.0, 45.82]);
    assert.ok(eastbound.headingDeg > 80 && eastbound.headingDeg < 90);
    assert.ok(westbound.headingDeg > 260 && westbound.headingDeg < 270);
});
