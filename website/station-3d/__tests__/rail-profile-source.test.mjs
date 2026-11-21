import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBoundsGrid } from '../core/bounds-grid.js';
import {
    canonicalSolvedRailFeatures,
    isSolvedRailFeature,
    normalizeRailProfileMode,
    osmRailStructureKind,
    prepareOsmRailFeature,
    resolveRailProfileFeatures,
    resolveRailProfileFeaturesSteps,
    resolveStreamedRailSessionFeatures,
} from '../core/rail-profile-source.js';

const LAT = 45.8;

test('dense solved rail source yields through context matching and clearance without changing its geometry', () => {
    const count = 2001;
    const coordinates = Array.from({ length: count }, (_, i) => [16.4422, 43.524 - i * 0.000009, 7]);
    const authoritative = geographicLine(coordinates, {
        source: 'reference-project', elevationMode: 'absolute', elevationDatum: 'EVRF2000',
        referenceProjectId: 152, referenceSourceId: 'legacy-rail-perkovic-split-v1',
        referenceSegmentKey: 'rail:m604:perkovic-split',
        railSourceChainagesM: coordinates.map((_, i) => 46700 + i),
        railCivilRuns: [{ startM: 46777.147, endM: 48664.145, regime: 'tunnel' }],
    });
    const companion = geographicLine(coordinates.map(p => [p[0] + 0.00005, p[1]]), {
        osm_id: 909020201, railway_type: 'rail', tags: { tunnel: 'yes', 'tunnel:name': 'Split' },
    });
    let terrainSamples = 0;
    const options = { mode: 'solved', solvedFeatures: [authoritative], osmFeatures: [companion],
        terrainReference: { anchorLon: 16.4422, anchorLat: 43.51, anchorHeightM: 0,
            evidenceSceneYAtLocal() { terrainSamples++; return 11; } } };
    const expected = resolveRailProfileFeatures(options);
    terrainSamples = 0;
    let clock = 0, lastSamples = 0, maxSamplesPerVisit = 0, next;
    const phases = new Set();
    const steps = resolveRailProfileFeaturesSteps(options, { now: () => ++clock });
    do {
        next = steps.next();
        maxSamplesPerVisit = Math.max(maxSamplesPerVisit, terrainSamples - lastSamples);
        lastSamples = terrainSamples;
        if (!next.done) phases.add(next.value.phase);
    } while (!next.done);
    assert.deepEqual(next.value, expected);
    assert.ok(terrainSamples > 1000, 'the dense case must exercise real tunnel clearance sampling');
    assert.ok(maxSamplesPerVisit < 32, 'clearance cannot scan the whole tunnel in one compiler visit');
    for (const phase of ['context-elevations', 'shared-tunnel', 'context-alignment', 'clearance-samples',
        'clearance-profile', 'context-rebase']) assert.ok(phases.has(`rail-source:${phase}`), phase);
    assert.equal(authoritative.geometry.coordinates, coordinates, 'source data remains untouched');
    assert.ok(coordinates.every(p => p[2] === 7));
});

test('solved source lookup retains global nearest and original tie order with bounded local work', () => {
    const source = readFileSync(new URL('../core/rail-profile-source.js', import.meta.url), 'utf8');
    const createLookup = Function('createBoundsGrid', 'DEFAULT_INDEX_CELL_M',
        source.slice(source.indexOf('function createSolvedSegmentLookup('), source.indexOf('\nfunction solvedElevationSampler('))
        + '\nreturn createSolvedSegmentLookup;')(createBoundsGrid, 80);
    let visits = 0;
    const segments = Array.from({ length: 12000 }, (_, i) => ({
        a: { x: i * 10, z: 0 }, b: { x: (i + 1) * 10, z: 0 },
        get dx() { visits++; return 10; }, dz: 0, lengthSquared: 100,
    }));
    const lookup = createLookup(segments);
    const near = lookup({ x: 60000, z: 4 });
    assert.equal(near.segment, segments[5999], 'the earlier source wins at a shared endpoint');
    assert.equal(near.distanceM, 4);
    assert.ok(visits < 200, `${visits} segment evaluations should not scan the 12,000-segment route`);
    assert.equal(lookup({ x: 60000, z: 11 }, { maxDistanceM: 10, distanceMetric: true }), null);
    const far = lookup({ x: 130000, z: 1000 });
    assert.equal(far.segment, segments.at(-1), 'a distant point still receives the exact global nearest');
    assert.equal(far.t, 1);
    const tied = createLookup([
        { a: { x: 80, z: 1 }, b: { x: 160, z: 1 }, dx: 80, dz: 0, lengthSquared: 6400 },
        { a: { x: 0, z: -1 }, b: { x: 80, z: -1 }, dx: 80, dz: 0, lengthSquared: 6400 },
    ]);
    assert.equal(tied({ x: 80, z: 0 }).segment.a.x, 80, 'grid traversal order cannot change source precedence');
});
const metresToLon = metres => metres / (6371000 * Math.PI / 180 * Math.cos(LAT * Math.PI / 180));
const metresToLat = metres => metres / (6371000 * Math.PI / 180);

function line(points, properties = {}) {
    return {
        type: 'Feature',
        properties,
        geometry: {
            type: 'LineString',
            coordinates: points.map(([x, z, y]) => [
                16 + metresToLon(x),
                LAT - metresToLat(z),
                ...(Number.isFinite(y) ? [y] : []),
            ]),
        },
    };
}

function solved(points, projectId) {
    return line(points, {
        source: 'reference-project',
        elevationMode: 'absolute',
        elevationDatum: 'EVRF2000',
        referenceProjectId: projectId,
    });
}

function geographicLine(coordinates, properties = {}) {
    return {
        type: 'Feature',
        properties,
        geometry: { type: 'LineString', coordinates },
    };
}

test('rail profile mode is explicit and defaults safely to inferred OSM', () => {
    assert.equal(normalizeRailProfileMode('solved'), 'solved');
    assert.equal(normalizeRailProfileMode('OSM'), 'osm');
    assert.equal(normalizeRailProfileMode('anything-else'), 'osm');
});

test('streaming preserves an authored proposal bridge in either profile mode', () => {
    const staticOsm = line([[0, 0], [40, 0]], {
        osmId: 44,
        railway_type: 'rail',
    });
    const proposalBridge = line([[0, 20, 22], [40, 20, 24]], {
        source: 'cb-proposal',
        proposalId: 701,
        elevationMode: 'absolute',
        elevationDatum: 'EVRF2000',
        terrainFormation: 'authored-elevation',
    });

    for (const mode of ['osm', 'solved']) {
        const result = resolveStreamedRailSessionFeatures({
            suppliedFeatures: [staticOsm, proposalBridge],
            streamedOsmFeatures: [],
            mode,
        });
        assert.deepEqual(result, [proposalBridge]);
        assert.equal(result[0], proposalBridge,
            'streaming must retain the exact authored feature, not reinterpret its profile');
    }
});

test('streaming replaces supplied static OSM while retaining authored session geometry', () => {
    const staticOsm = line([[0, 0], [40, 0]], {
        osmId: 44,
        railway_type: 'rail',
    });
    const streamedOsm = line([[100, 0], [140, 0]], {
        osm_id: 55,
        railway_type: 'rail',
    });
    const authored = line([[0, 20, 22], [40, 20, 24]], {
        source: 'user',
        elevationMode: 'absolute',
        elevationDatum: 'EVRF2000',
    });

    const result = resolveStreamedRailSessionFeatures({
        suppliedFeatures: [staticOsm, authored],
        streamedOsmFeatures: [streamedOsm],
        mode: 'osm',
    });
    assert.equal(result.length, 2);
    assert.equal(result[0].properties.osm_id, 55);
    assert.equal(result[0].properties.railProfileSource, 'osm-inferred');
    assert.equal(result[1], authored);
    assert.ok(!result.some(feature => feature.properties.osmId === 44));
});

test('streamed profile mode selects strict references without dropping authored tracks', () => {
    const reference = solved([[0, 0, 120], [40, 0, 120]], 100);
    const authored = line([[0, 20, 22], [40, 20, 24]], { source: 'cb-proposal' });
    const osmResult = resolveStreamedRailSessionFeatures({
        suppliedFeatures: [reference, authored],
        mode: 'osm',
    });
    const solvedResult = resolveStreamedRailSessionFeatures({
        suppliedFeatures: [reference, authored],
        mode: 'solved',
    });

    assert.deepEqual(osmResult, [authored]);
    assert.equal(solvedResult.filter(isSolvedRailFeature).length, 1);
    assert.equal(solvedResult.at(-1), authored);
});

test('OSM rail gets a smooth grade and preserves explicit over/under ownership', () => {
    const bridge = line([[0, 0], [20, 0]], {
        railway_type: 'rail',
        tags: { bridge: 'yes', layer: '1' },
    });
    const tunnel = line([[0, 0], [20, 0]], {
        railway_type: 'rail',
        tunnel: 'yes',
    });
    assert.equal(osmRailStructureKind(bridge), 'viaduct');
    assert.equal(osmRailStructureKind(tunnel), 'tunnel');
    const prepared = prepareOsmRailFeature(bridge);
    assert.equal(prepared.properties.terrainFormation, 'smooth-grade');
    assert.equal(prepared.properties.railMode, 'train');
    assert.equal(prepared.properties.railStructure, 'viaduct');
});

test('ordinary OSM tram stays road-owned and does not create rail earthworks', () => {
    const ordinary = prepareOsmRailFeature(line([[0, 0], [20, 0]], {
        railway_type: 'tram',
        tags: { railway: 'tram' },
    }));
    assert.equal(ordinary.properties.railMode, 'tram');
    assert.equal(ordinary.properties.terrainFormation, undefined);
    assert.equal(ordinary.properties.railProfileSource, undefined);

    for (const tags of [{ bridge: 'yes' }, { embankment: 'yes' }]) {
        const structural = prepareOsmRailFeature(line([[0, 0], [20, 0]], {
            railway_type: 'tram',
            tags: { railway: 'tram', ...tags },
        }));
        assert.equal(structural.properties.terrainFormation, 'smooth-grade',
            'an explicitly mapped tram structure still owns its civil works');
    }
});

test('solved mode replaces only parallel covered metres and keeps continuations', () => {
    const osm = line([[-100, 3], [0, 3], [100, 3]], { osm_id: 44, railway_type: 'rail' });
    const authoritative = solved([[-30, 0, 120], [30, 0, 120]], 100);
    const result = resolveRailProfileFeatures({
        mode: 'solved',
        osmFeatures: [osm],
        solvedFeatures: [authoritative],
    });
    const osmFragments = result.filter(feature => feature.properties.osm_id === 44);
    assert.equal(result.filter(isSolvedRailFeature).length, 1);
    assert.equal(osmFragments.length, 2, 'both uncovered ends survive');
    assert.ok(osmFragments.every(feature => feature.properties.terrainFormation === 'smooth-grade'));
    assert.ok(osmFragments[0].geometry.coordinates.at(-1)[0] < 16);
    assert.ok(osmFragments[1].geometry.coordinates[0][0] > 16);
});

test('a transverse crossing is not erased by solved corridor coverage', () => {
    const crossing = line([[0, -50], [0, 50]], { osm_id: 55, railway_type: 'rail' });
    const authoritative = solved([[-50, 0, 120], [50, 0, 120]], 100);
    const result = resolveRailProfileFeatures({
        mode: 'solved',
        osmFeatures: [crossing],
        solvedFeatures: [authoritative],
    });
    const [kept] = result.filter(feature => feature.properties.osm_id === 55);
    assert.ok(kept);
    assert.equal(kept.geometry.coordinates.length, 2);
});

test('newer overlapping solved projects own only their shared trunk', () => {
    const newer = solved([[-100, 0, 120], [0, 0, 120]], 115);
    const older = solved([[-100, 2, 118], [0, 2, 118], [100, 60, 119]], 96);
    const selected = canonicalSolvedRailFeatures([older, newer]);
    const olderFragments = selected.filter(feature => feature.properties.referenceProjectId === 96);
    assert.equal(selected.filter(feature => feature.properties.referenceProjectId === 115).length, 1);
    assert.equal(olderFragments.length, 1);
    assert.ok(olderFragments[0].geometry.coordinates[0][0] >= 16 - metresToLon(5),
        'the older shared trunk is removed, but its diverging continuation remains');
});

test('solved mode falls back to inferred OSM when no solved span covers the area', () => {
    const osm = line([[0, 0], [50, 0]], { osm_id: 77, railway_type: 'rail' });
    const result = resolveRailProfileFeatures({ mode: 'solved', osmFeatures: [osm] });
    assert.equal(result.length, 1);
    assert.equal(result[0].properties.railProfileSource, 'osm-inferred');
});

test('Split solved mode keeps a bounded station yard and one companion tunnel track', () => {
    const authoritative = geographicLine([
        [16.4422000, 43.5080000, 6.0],
        [16.4421044, 43.5070662, 4.2],
        [16.4421533, 43.5068325, 4.0],
        [16.4426220, 43.5056515, 2.8],
        [16.4430958, 43.5048301, 2.14],
    ], {
        source: 'reference-project',
        elevationMode: 'absolute',
        elevationDatum: 'EVRF2000',
        referenceProjectId: 152,
        referenceSourceId: 'legacy-rail-perkovic-split-v1',
        referenceSegmentKey: 'rail:m604:perkovic-split',
        railSourceChainagesM: [48500, 48637.88, 48664.145, 48770, 48900],
        railCivilRuns: [
            { startM: 46777.147, endM: 48664.145, regime: 'tunnel' },
            { startM: 48664.145, endM: 48900, regime: 'fill' },
        ],
    });
    const exactDrivenOsm = geographicLine([
        [16.4430958, 43.5048301],
        [16.4426220, 43.5056515],
        [16.4421533, 43.5068325],
    ], { osm_id: 659571085, railway_type: 'rail' });
    const trackTwoSouth = geographicLine([
        [16.4430958, 43.5048301],
        [16.4448698, 43.5017679],
    ], {
        osm_id: 659571084,
        railway_type: 'rail',
        tags: { railway: 'rail', 'railway:track_ref': '2' },
    });
    const trackThreeSouth = geographicLine([
        [16.4430958, 43.5048301],
        [16.4448698, 43.5017679],
    ], {
        osm_id: 143731412,
        railway_type: 'rail',
        tags: { railway: 'rail', 'railway:track_ref': '3' },
    });
    const stationTrackFour = geographicLine([
        [16.4448698, 43.5017679],
        [16.4431522, 43.5048549],
        [16.4424285, 43.5060025],
    ], {
        osm_id: 71447510,
        railway_type: 'rail',
        tags: { railway: 'rail', 'railway:track_ref': '4', service: 'siding' },
    });
    const companionTunnel = geographicLine([
        [16.4421029, 43.5068315],
        [16.4420369, 43.5070822],
        [16.4460603, 43.5214357],
    ], {
        osm_id: 909020201,
        railway_type: 'rail',
        tags: {
            railway: 'rail',
            tunnel: 'yes',
            'tunnel:name': 'Split',
            gauge: '1435',
        },
    });
    const unrelated = geographicLine([
        [16.4600, 43.5000],
        [16.4610, 43.5000],
    ], { osm_id: 999, railway_type: 'rail' });
    const unselectedStationSiding = geographicLine([
        [16.4429590, 43.5053347],
        [16.4425137, 43.5059880],
    ], { osm_id: 123456, railway_type: 'rail', service: 'siding' });
    const tunnelCrossover = geographicLine([
        [16.44210, 43.50718],
        [16.44204, 43.50721],
    ], { osm_id: 909020202, railway_type: 'rail', tunnel: 'yes', service: 'crossover' });

    const result = resolveRailProfileFeatures({
        mode: 'solved',
        solvedFeatures: [authoritative],
        osmFeatures: [
            exactDrivenOsm,
            trackTwoSouth,
            trackThreeSouth,
            stationTrackFour,
            companionTunnel,
            unselectedStationSiding,
            tunnelCrossover,
            unrelated,
        ],
    });

    assert.equal(result.some(feature => feature.properties.osm_id === 659571085), false,
        'the exact OSM copy of the solved drive track must disappear');
    const yard = result.filter(feature => feature.properties.railContextRole === 'station-yard');
    assert.deepEqual(
        [...new Set(yard.map(feature => feature.properties.osm_id))].sort((a, b) => a - b),
        [71447510, 143731412, 659571084],
    );
    assert.ok(yard.every(feature => feature.properties.railFormationParticipation === 'surface'));
    assert.ok(yard.every(feature => feature.properties.terrainFormation === 'smooth-grade'));
    const southContinuation = yard.find(feature => feature.properties.osm_id === 659571084);
    const southEnd = southContinuation.geometry.coordinates.reduce(
        (south, coordinate) => coordinate[1] < south[1] ? coordinate : south,
    );
    assert.ok(Math.abs(southEnd[2] - 2.14) < 1e-9,
        'the station continuation must clamp to the solved terminal rail level');

    const tunnel = result.filter(feature => feature.properties.osm_id === 909020201);
    assert.ok(tunnel.length > 0, 'the second physical tunnel track must survive');
    assert.ok(tunnel.every(feature => feature.properties.railContextRole === 'tunnel-companion'));
    assert.ok(tunnel.every(
        feature => feature.properties.railFormationParticipation === 'visual-only',
    ));
    assert.ok(tunnel.some(feature => (
        feature.properties.railHorizontalAlignmentResolution?.maxAppliedOffsetM > 1.2
    )), 'the physical companion track moves with the solved authority');
    assert.equal(Math.max(...tunnel.flatMap(feature => (
        feature.geometry.coordinates.map(coordinate => coordinate[1])
    ))), 43.5214357,
        'the tunnel companion is not clipped to the surface-yard box');
    assert.ok([...yard, ...tunnel].every(feature => feature.geometry.coordinates.every(
        coordinate => coordinate.length === 3 && Number.isFinite(coordinate[2]),
    )), 'every context rail must inherit a finite solved EVRF2000 elevation');
    assert.equal(result.some(feature => feature.properties.osm_id === 123456), false,
        'unselected station sidings stay outside the bounded context');
    assert.equal(result.some(feature => feature.properties.osm_id === 909020202), false,
        'the tunnel crossover must not create its own bore/civil alignment');

    const [solvedFeature] = result.filter(isSolvedRailFeature);
    assert.equal(solvedFeature.properties.railContextGroupId, 'split-station');
    assert.equal(solvedFeature.properties.railContextRole, 'solved-authority');
    assert.deepEqual(solvedFeature.properties.railFormationSections, [{
        sourceStartM: 48664.145,
        sourceEndM: 48900.58,
        style: 'vertical-retained',
        negativeNormalRetainedBenchM: 6,
    }]);
    assert.deepEqual(solvedFeature.properties.railRoadInterfaces, [
        {
            osmWayId: '912809760',
            style: 'vertical-retained',
            railBoundarySide: 'positive-normal',
        },
        {
            osmWayId: '912809761',
            style: 'vertical-retained',
            railBoundarySide: 'positive-normal',
            boundaryContinuationM: 9,
            boundarySnapDistanceM: 4,
        },
    ]);
    assert.equal(
        solvedFeature.properties.railHorizontalAlignmentResolution.method,
        'source-chainage-lateral-taper',
    );
    assert.ok(Math.abs(
        solvedFeature.properties.railHorizontalAlignmentResolution.maxAppliedOffsetM - 1.25,
    ) < 1e-9);
    const portalIndex = solvedFeature.properties.railSourceChainagesM.indexOf(48664.145);
    const shiftedPortal = solvedFeature.geometry.coordinates[portalIndex];
    const sourcePortal = authoritative.geometry.coordinates[2];
    const portalDxM = (shiftedPortal[0] - sourcePortal[0])
        * 6371000 * Math.PI / 180 * Math.cos(sourcePortal[1] * Math.PI / 180);
    const portalDzM = -(shiftedPortal[1] - sourcePortal[1]) * 6371000 * Math.PI / 180;
    assert.ok(Math.abs(Math.hypot(portalDxM, portalDzM) - 1.25) < 0.01,
        'the portal receives the complete reviewed lateral correction');
    assert.ok(shiftedPortal[0] < sourcePortal[0], 'the Split portal moves west/left');
    assert.deepEqual(
        solvedFeature.geometry.coordinates.at(-1),
        authoritative.geometry.coordinates.at(-1),
        'the correction tapers back to the published station alignment',
    );
    assert.equal(solvedFeature.properties.trackCount, undefined,
        'the solved drive path remains one track rather than drawing a synthetic pair');
    const [sharedBore] = solvedFeature.properties.railTunnelSections;
    assert.equal(sharedBore.physicalId, 'split-tunnel');
    assert.equal(sharedBore.trackCount, 2);
    assert.equal(sharedBore.sourceStartM, 46777.147);
    assert.equal(sharedBore.sourceEndM, 48664.145);
    assert.ok(sharedBore.trackSpacingM > 3.5 && sharedBore.trackSpacingM < 4.8,
        `OSM track spacing ${sharedBore.trackSpacingM}`);
    assert.ok(Math.abs(sharedBore.centerOffsetM) > 1.75
        && Math.abs(sharedBore.centerOffsetM) < 2.4,
    `shared bore midpoint offset ${sharedBore.centerOffsetM}`);
    assert.ok(sharedBore.boreHalfWidthM >= 4.6 && sharedBore.boreHalfWidthM < 5.1,
        `compact double-track half-width ${sharedBore.boreHalfWidthM}`);
    assert.equal(sharedBore.clearHeightM, 5.2);
    assert.equal(sharedBore.portalTerrainOpeningInsideM, 4.5,
        'the reviewed Split throat clears coarse DGU triangles inside the portal');
    const keptUnrelated = result.find(feature => feature.properties.osm_id === 999);
    assert.equal(keptUnrelated.properties.railProfileSource, 'osm-inferred');
    assert.equal(keptUnrelated.properties.railContextGroupId, undefined);
});

test('Split open portal does not lower the solved profile to bury the headwall', () => {
    const authoritative = geographicLine([
        [16.4422000, 43.5080000, 6.0],
        [16.4421044, 43.5070662, 4.2],
        [16.4421533, 43.5068325, 4.0],
        [16.4426220, 43.5056515, 2.8],
        [16.4430958, 43.5048301, 2.14],
    ], {
        source: 'reference-project',
        elevationMode: 'absolute',
        elevationDatum: 'EVRF2000',
        referenceProjectId: 152,
        referenceSourceId: 'legacy-rail-perkovic-split-v1',
        referenceSegmentKey: 'rail:m604:perkovic-split',
        railSourceChainagesM: [48500, 48637.88, 48664.145, 48770, 48900],
        railCivilRuns: [
            { startM: 46777.147, endM: 48664.145, regime: 'tunnel' },
            { startM: 48664.145, endM: 48900, regime: 'fill' },
        ],
    });
    const anchorLon = 16.4421533;
    const anchorLat = 43.5068325;
    const metresPerDegreeLat = 6371000 * Math.PI / 180;
    const metresPerDegreeLon = metresPerDegreeLat * Math.cos(anchorLat * Math.PI / 180);
    const terrainReference = {
        anchorLon,
        anchorLat,
        anchorHeightM: 0,
        metresPerDegreeLat,
        metresPerDegreeLon,
        // The portal is an open engineered face. Its low edge must not be
        // mistaken for an intact roof that forces the whole approach down.
        evidenceSceneYAtLocal: (x, z) => Math.hypot(x, z) < 3 ? 4.8 : 30,
    };
    const result = resolveRailProfileFeatures({
        mode: 'solved',
        solvedFeatures: [authoritative],
        osmFeatures: [],
        terrainReference,
    });
    const [resolved] = result.filter(isSolvedRailFeature);
    const [section] = resolved.properties.railTunnelSections;
    assert.equal(section.evidence, 'curated-osm-companion-fallback');
    assert.equal(section.trackCount, 2);
    assert.equal(section.trackSpacingM, 4.1);
    assert.equal(section.centerOffsetM, -2.05);
    assert.equal(section.minimumRoofCoverM, 0.25);

    const resolvedBySourceM = new Map(resolved.properties.railSourceChainagesM.map(
        (sourceM, index) => [sourceM, resolved.geometry.coordinates[index][2]],
    ));
    assert.equal(resolvedBySourceM.get(48664.145), 4,
        'the authored rail head survives at the open portal');
    assert.equal(resolved.properties.railTunnelClearanceResolution, undefined,
        'an open portal edge does not create a buried-roof correction');

    const [companion] = result.filter(feature => (
        feature.properties.railContextRole === 'tunnel-companion'
    ));
    assert.ok(companion, 'a visual second rail exists even when the road tile omits railways');
    assert.equal(companion.properties.railFormationParticipation, 'visual-only');
    assert.equal(companion.properties.source, 'curated-solved-context');
    assert.ok(companion.geometry.coordinates.every(coordinate => (
        coordinate.length === 3 && coordinate.every(Number.isFinite)
    )));
});

test('Split fallback still lowers the solved profile for a genuine interior roof conflict', () => {
    const authoritative = geographicLine([
        [16.4422000, 43.5080000, 6.0],
        [16.4421044, 43.5070662, 4.2],
        [16.4421533, 43.5068325, 4.0],
        [16.4426220, 43.5056515, 2.8],
        [16.4430958, 43.5048301, 2.14],
    ], {
        source: 'reference-project',
        elevationMode: 'absolute',
        elevationDatum: 'EVRF2000',
        referenceProjectId: 152,
        referenceSourceId: 'legacy-rail-perkovic-split-v1',
        referenceSegmentKey: 'rail:m604:perkovic-split',
        railSourceChainagesM: [48500, 48637.88, 48664.145, 48770, 48900],
        railCivilRuns: [
            { startM: 46777.147, endM: 48664.145, regime: 'tunnel' },
            { startM: 48664.145, endM: 48900, regime: 'fill' },
        ],
    });
    const anchorLon = 16.4421533;
    const anchorLat = 43.5068325;
    const metresPerDegreeLat = 6371000 * Math.PI / 180;
    const metresPerDegreeLon = metresPerDegreeLat * Math.cos(anchorLat * Math.PI / 180);
    const result = resolveRailProfileFeatures({
        mode: 'solved',
        solvedFeatures: [authoritative],
        osmFeatures: [],
        terrainReference: {
            anchorLon,
            anchorLat,
            anchorHeightM: 0,
            metresPerDegreeLat,
            metresPerDegreeLon,
            // About ten metres inside the tunnel, not at its open face.
            evidenceSceneYAtLocal: (x, z) => (
                Math.hypot(x + 1.5, z + 10) < 5 ? 4.8 : 30
            ),
        },
    });
    const [resolved] = result.filter(isSolvedRailFeature);
    assert.ok(resolved.properties.railTunnelClearanceResolution.maxDropM > 4.5,
        'a low interior roof still creates a material clearance correction');

    const originalBySourceM = new Map(authoritative.properties.railSourceChainagesM.map(
        (sourceM, index) => [sourceM, authoritative.geometry.coordinates[index][2]],
    ));
    const resolvedBySourceM = new Map(resolved.properties.railSourceChainagesM.map(
        (sourceM, index) => [sourceM, resolved.geometry.coordinates[index][2]],
    ));
    const common = authoritative.properties.railSourceChainagesM.map(sourceM => ({
        sourceM,
        dropM: originalBySourceM.get(sourceM) - resolvedBySourceM.get(sourceM),
    }));
    for (let index = 0; index < common.length - 1; index++) {
        const addedGrade = Math.abs(common[index + 1].dropM - common[index].dropM)
            / (common[index + 1].sourceM - common[index].sourceM);
        assert.ok(addedGrade <= 0.008 + 1e-9, `added grade ${addedGrade}`);
    }
});
