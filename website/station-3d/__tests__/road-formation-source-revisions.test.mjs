import test from 'node:test';
import assert from 'node:assert/strict';
import { RoadFormationModel, formationProfilesEquivalent } from '../core/road-formation.js';
import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';
import { createRoadFeatureIdentityIndex } from '../core/road-feature-identity.js';
import { createRoadFeatureSourceIndex } from '../core/road-feature-sources.js';

const anchor = { anchorLat: 43.5, anchorLon: 16.4 };
const latitudeM = DEG_TO_RAD * EARTH_RADIUS_M;
const longitudeM = latitudeM * Math.cos(anchor.anchorLat * DEG_TO_RAD);
const lonLat = (x, z) => [anchor.anchorLon + x / longitudeM, anchor.anchorLat - z / latitudeM];
const line = (id, z = 0) => ({ type: 'Feature', properties: { osm_id: id, highway: 'residential' },
    geometry: { type: 'LineString', coordinates: [[-20, z], [20, z]].map(p => lonLat(...p)) } });
const polygon = (id, z = 0, properties = {}) => ({ type: 'Feature',
    properties: { osm_id: id, highway_type: 'residential', ...properties },
    geometry: { type: 'Polygon', coordinates: [[[-20, z - 3], [20, z - 3], [20, z + 3], [-20, z + 3], [-20, z - 3]].map(p => lonLat(...p))] } });
const model = () => new RoadFormationModel({ ...anchor, baseSceneYAtLocal: (x, z) => x * .1 + z * .05 });
function build(subject, cooperative = false) {
    if (cooperative) {
        let steps = 0;
        while (subject.stepPendingBuildPreparation() !== 'done') assert.ok(++steps < 10000, 'bounded convergence');
    }
    return subject.getSurfaceProfiles();
}
const geometry = subject => subject.getSurfaceProfiles().map(profile => ({
    osmId: profile.osmId, points: profile.points, internal: profile.internalSegments,
    collars: profile.collarInternalSegments, cutout: profile.terrainCutoutRing,
}));
function sourceSelection(tiles) {
    const identities = createRoadFeatureIdentityIndex();
    const sources = createRoadFeatureSourceIndex(identities);
    for (const [key, features] of tiles) sources.setTile(key,
        features.map((feature, featureIndex) => sources.prepare(feature, { tileKey: key, featureIndex })));
    return feature => sources.selected(identities.identityFor(feature).key);
}
function singleton(centerline, surface) {
    const subject = model();
    subject.setCenterlineTile('only', [centerline]);
    subject.setSurfaceTile('only', [surface]);
    return subject;
}

test('a paired surface centerline builds a real formation without a separate graph response', () => {
    const axis = line(101183634), surface = polygon(101183634, 0, { centerline_geometry: axis.geometry });
    const expected = geometry(singleton(axis, polygon(101183634)));
    for (const cooperative of [false, true]) {
        const subject = model(); subject.setSurfaceTile('surface-only', [surface]); build(subject, cooperative);
        assert.equal(subject.getSurfaceProfiles().length, 1);
        const actual = geometry(subject);
        // Ownership metadata refers to the paired source; physical vertices
        // must still match the independently supplied axis/profile path.
        assert.deepEqual(actual, expected);
        assert.ok(Number.isFinite(subject.sceneYAtLocal(0, 0, { osmId: 101183634 })));
    }
});

test('paired axes keep their polygon source across graph arrival, source replacement and removal', () => {
    const paired = z => polygon(1, z, { centerline_geometry: line(1, z).geometry });
    for (const graphFirst of [true, false]) {
        const subject = model();
        if (graphFirst) { subject.setCenterlineTile('graph', [line(1, 30)]); build(subject); }
        subject.setSurfaceTile('surface', [paired(0)]); build(subject, true);
        const first = subject.sceneYAtLocal(0, 0, { osmId: 1 });
        const firstGeometry = geometry(subject);
        subject.setCenterlineTile('graph', [line(1, 30)]); build(subject, true);
        assert.deepEqual(geometry(subject), firstGeometry);
        subject.removeCenterlineTile('graph'); build(subject, true);
        assert.deepEqual(geometry(subject), firstGeometry);
        subject.setSurfaceTile('surface', [paired(12)]); build(subject, true);
        const expected = singleton(line(1, 12), polygon(1, 12));
        assert.deepEqual(geometry(subject), geometry(expected));
        assert.notEqual(subject.sceneYAtLocal(0, 12, { osmId: 1 }), first);
        const revision = subject.revision, profile = subject.getSurfaceProfiles()[0];
        subject.setSurfaceTile('surface', [structuredClone(paired(12))]); build(subject, true);
        assert.equal(subject.revision, revision); assert.equal(subject.getSurfaceProfiles()[0], profile);
        subject.removeSurfaceTile('surface'); build(subject, true);
        assert.equal(subject.getSurfaceProfiles().length, 0);
        assert.equal(subject.nearbyCenterlineSegments(0, 12, 5).length, 0);
    }
});

test('same-id variants converge to selected physical geometry in either tile order and build mode', () => {
    const lines = [['a', [line(1, 0)]], ['b', [line(1, 12)]]];
    const surfaces = [['a', [polygon(1, 0)]], ['b', [polygon(1, 12)]]];
    const selectedLine = sourceSelection(lines)(lines[0][1][0]).feature;
    const selectedSurface = sourceSelection(surfaces)(surfaces[0][1][0]).feature;
    const expected = geometry(singleton(selectedLine, selectedSurface));
    for (const order of [[0, 1], [1, 0]]) for (const cooperative of [false, true]) {
        const subject = model();
        for (const index of order) {
            subject.setCenterlineTile(...lines[index]);
            subject.setSurfaceTile(...surfaces[index]);
            build(subject, cooperative); // Exercise caches between arrivals.
        }
        assert.deepEqual(geometry(subject), expected);
    }
});

test('same-id polygon replacement updates exact geometry without an eviction or terrain event', () => {
    const subject = singleton(line(1), polygon(1));
    const before = structuredClone(geometry(subject));
    const revision = subject.revision;
    subject.setSurfaceTile('only', [polygon(1, 12)]);
    assert.ok(subject.revision > revision);
    assert.deepEqual(geometry(subject), geometry(singleton(line(1), polygon(1, 12))));
    assert.notDeepEqual(geometry(subject), before);
});

test('same-id centreline replacement invalidates projected segments and support without eviction', () => {
    const subject = singleton(line(1), polygon(1));
    const before = subject.sceneYAtLocal(0, 0, { osmId: 1 });
    subject.setCenterlineTile('only', [line(1, 12)]);
    const expected = singleton(line(1, 12), polygon(1));
    const after = subject.sceneYAtLocal(0, 0, { osmId: 1 });
    assert.ok(Number.isFinite(before) && Number.isFinite(after));
    assert.ok(Math.abs(after - before) > .4);
    assert.equal(after, expected.sceneYAtLocal(0, 0, { osmId: 1 }));
    assert.deepEqual(geometry(subject), geometry(expected));
});

test('evicting the selected variant changes support to the surviving source in either arrival order', () => {
    const tiles = [['a', [line(1)]], ['b', [line(1, 12)]]];
    const selected = sourceSelection(tiles)(tiles[0][1][0]);
    const survivor = tiles.find(([key]) => key !== selected.tileKey)[1][0];
    for (const order of [tiles, [...tiles].reverse()]) {
        const subject = model();
        subject.setSurfaceTile('surface', [polygon(1)]);
        for (const [key, features] of order) { subject.setCenterlineTile(key, features); build(subject); }
        const before = subject.sceneYAtLocal(0, 0, { osmId: 1 });
        subject.removeCenterlineTile(selected.tileKey);
        const expected = singleton(survivor, polygon(1));
        assert.deepEqual(geometry(subject), geometry(expected));
        assert.notEqual(subject.sceneYAtLocal(0, 0, { osmId: 1 }), before);
    }
});

test('an exact duplicate in another tile and eviction of the original preserve generation and profile identity', () => {
    const sourceLine = line(1), surface = polygon(1);
    const subject = singleton(sourceLine, surface);
    const original = build(subject)[0], revision = subject.revision;
    const generation = subject.getSurfaceGeometryGeneration(1);
    subject.setCenterlineTile('duplicate', [structuredClone(sourceLine)]);
    subject.setSurfaceTile('duplicate', [structuredClone(surface)]);
    subject.removeCenterlineTile('only');
    subject.removeSurfaceTile('only');
    assert.equal(subject.revision, revision);
    assert.equal(build(subject)[0], original);
    assert.equal(subject.getSurfaceGeometryGeneration(1), generation);
});

test('separate explicit polygon parts retain disjoint physical footprints and evict independently', () => {
    const subject = model();
    subject.setCenterlineTile('line', [line(1)]);
    const left = polygon(1, 0, { part_index: 0 }), right = polygon(1, 20, { part_index: 1 });
    subject.setSurfaceTile('left', [left]);
    subject.setSurfaceTile('right', [right]);
    const parts = build(subject);
    assert.equal(parts.length, 2);
    assert.ok(parts[0].bounds.maxZ < parts[1].bounds.minZ);
    assert.deepEqual(subject.getSurfaceProfilesForFeature(left), [parts[0]]);
    assert.deepEqual(subject.getSurfaceProfilesForFeature(right), [parts[1]], 'second part cannot receive the first part collar');
    subject.removeSurfaceTile('left');
    assert.deepEqual(geometry(subject), geometry(singleton(line(1), right)));
    assert.deepEqual(subject.getSurfaceProfilesForFeature(left), [], 'evicted source part has no current formation');
});

test('a completed neighbour change advances affected geometry generations after staged publication only', () => {
    const subject = singleton(line(1), polygon(1));
    subject.setCenterlineTile('distant', [line(3, 300)]);
    subject.setSurfaceTile('distant', [polygon(3, 300)]);
    const oldProfiles = build(subject), frozenOld = structuredClone(oldProfiles);
    const before = subject.surfaceGeometryRevision;
    const originalGeneration = subject.getSurfaceGeometryGeneration(1);
    const distantGeneration = subject.getSurfaceGeometryGeneration(3);
    const crossingLine = line(2);
    crossingLine.geometry.coordinates = [[0, -20], [0, 20]].map(p => lonLat(...p));
    const crossingSurface = polygon(2);
    crossingSurface.geometry.coordinates = [[[-3, -20], [3, -20], [3, 20], [-3, 20], [-3, -20]].map(p => lonLat(...p))];
    subject.setCenterlineTile('crossing', [crossingLine]);
    subject.setSurfaceTile('crossing', [crossingSurface]);
    let steps = 0;
    while (subject.hasPendingBuild()) {
        assert.equal(subject.getSurfaceGeometryGeneration(1), originalGeneration);
        assert.deepEqual(oldProfiles, frozenOld, 'no staged step mutates a published profile');
        subject.stepPendingBuildPreparation();
        assert.ok(++steps < 10000);
    }
    assert.ok(subject.getSurfaceGeometryGeneration(1) > originalGeneration);
    assert.equal(subject.getSurfaceGeometryGeneration(3), distantGeneration);
    const changes = subject.getSurfaceGeometryChangesSince(before);
    assert.deepEqual(changes.osmIds.sort(), ['1', '2']);
    assert.equal(changes.full, false);
    assert.ok(changes.bounds.every(bounds => bounds.maxZ < 30), 'bounded local dependency region');
    assert.deepEqual(oldProfiles, frozenOld);
    subject.removeSurfaceTile('crossing');
    subject.removeCenterlineTile('crossing');
    build(subject);
    assert.equal(subject.getSurfaceGeometryGeneration(2), 0);
    assert.ok(subject.getSurfaceGeometryChangesSince(changes.revision).osmIds.includes('2'));
});

test('a rechecked neighbour advances its generation only when its geometry actually changed', () => {
    const arrive = gap => {
        const subject = singleton(line(1), polygon(1));
        build(subject);
        const profile = subject.getSurfaceProfilesForOsmId(1)[0], generation = subject.getSurfaceGeometryGeneration(1);
        const frozen = structuredClone(profile), before = subject.surfaceGeometryRevision;
        subject.setCenterlineTile('near', [line(2, gap)]);
        subject.setSurfaceTile('near', [polygon(2, gap)]);
        let rechecked = false, steps = 0;
        while (subject.hasPendingBuild()) {
            rechecked ||= !!subject._pendingBuildPreparation?.profilesToRecheck?.some(entry => entry.osmId === profile.osmId);
            subject.stepPendingBuildPreparation();
            assert.ok(++steps < 10000);
        }
        const after = subject.getSurfaceProfilesForOsmId(1)[0];
        return { rechecked, identical: JSON.stringify(after) === JSON.stringify(frozen),
            advanced: subject.getSurfaceGeometryGeneration(1) > generation,
            osmIds: subject.getSurfaceGeometryChangesSince(before).osmIds.sort() };
    };
    // 10 m apart: road 1 falls inside the new road's dependency bounds and is
    // recomputed, but its collar is untouched. Its renderers must not rebuild.
    assert.deepEqual(arrive(10), { rechecked: true, identical: true, advanced: false, osmIds: ['2'] });
    // 8 m apart the collars meet, so road 1 really changes and must advance.
    assert.deepEqual(arrive(8), { rechecked: true, identical: false, advanced: true, osmIds: ['1', '2'] });
});

test('profile equivalence compares content and treats an unknown object as a change', () => {
    const profile = { osmId: 1, points: [{ x: 1, z: 2 }], flags: [false, true], index: new Map() };
    const clone = { ...profile, points: profile.points.map(point => ({ ...point })), flags: [...profile.flags] };
    assert.equal(formationProfilesEquivalent(profile, clone), true);
    assert.equal(formationProfilesEquivalent(profile, { ...clone, flags: [false, false] }), false);
    assert.equal(formationProfilesEquivalent(profile, { ...clone, points: [{ x: 1, z: 2.0001 }] }), false);
    assert.equal(formationProfilesEquivalent(profile, { ...clone, points: [{ x: 1, z: 2, y: 0 }] }), false);
    assert.equal(formationProfilesEquivalent(profile, { ...clone, index: new Map() }), false);
    assert.equal(formationProfilesEquivalent(profile, { ...clone, extra: undefined }), false);
});

test('equivalent reordered MultiPolygons return matching per-ring profiles without rebuilding geometry', () => {
    const first = polygon(1), second = polygon(1, 20);
    const source = { ...first, geometry: { type: 'MultiPolygon', coordinates: [first.geometry.coordinates, second.geometry.coordinates] } };
    const subject = singleton(line(1), source);
    const profiles = subject.getSurfaceProfilesForFeature(source);
    const revision = subject.revision;
    const reordered = structuredClone(source);
    reordered.geometry.coordinates.reverse();
    reordered.geometry.coordinates[0][0].reverse();
    subject.setSurfaceTile('equivalent', [reordered]);
    subject.removeSurfaceTile('only');
    assert.equal(subject.revision, revision);
    assert.deepEqual(subject.getSurfaceProfilesForFeature(reordered), [...profiles].reverse());
});

test('a distant source refresh never writes even temporary shared-wall flags into a retained profile', () => {
    const subject = singleton(line(1), polygon(1));
    const oldProfiles = subject.getSurfaceProfiles(), oldGeometry = structuredClone(geometry(subject));
    for (const profile of oldProfiles) Object.freeze(profile.sharedRetainingWallSegments);
    subject.setCenterlineTile('far', [line(2, 300)]);
    subject.setSurfaceTile('far', [polygon(2, 300)]);
    build(subject, true);
    assert.equal(subject.getSurfaceProfilesForOsmId(1)[0], oldProfiles[0]);
    assert.deepEqual(geometry(subject).filter(profile => profile.osmId === '1'), oldGeometry);
});

test('bounded vertical-alignment invalidation preserves distant profile identity while updating nearby support', () => {
    const verticalAlignments = new Map([[11, 0], [12, 0]]);
    const subject = new RoadFormationModel({
        ...anchor,
        baseSceneYAtLocal: (x, z) => z * .02,
        roadYOverrideAtLocal: (x, z, osmId) => verticalAlignments.get(Number(osmId)),
    });
    subject.setCenterlineTile('near', [line(11, 0)]);
    subject.setSurfaceTile('near', [polygon(11, 0)]);
    subject.setCenterlineTile('far', [line(12, 300)]);
    subject.setSurfaceTile('far', [polygon(12, 300)]);
    build(subject, true);
    const nearBefore = subject.getSurfaceProfilesForOsmId(11)[0];
    const farBefore = subject.getSurfaceProfilesForOsmId(12)[0];
    const farGeneration = subject.getSurfaceGeometryGeneration(12);
    const nearY = subject.sceneYAtLocal(0, 0, { osmId: 11 });

    verticalAlignments.set(11, 2);
    subject.invalidateVerticalAlignments([{ minX: -40, minZ: -40, maxX: 40, maxZ: 40 }]);
    build(subject, true);
    const nearAfter = subject.getSurfaceProfilesForOsmId(11)[0];
    assert.notEqual(nearAfter, nearBefore, 'bounded alignment change rebuilds the affected profile');
    const nearUpdatedY = subject.sceneYAtLocal(0, 0, { osmId: 11 });
    assert.ok(Math.abs(nearUpdatedY - nearY) > 0.5,
        `near support follows the changed alignment input (${nearY} -> ${nearUpdatedY})`);
    assert.equal(subject.getSurfaceProfilesForOsmId(12)[0], farBefore,
        'distant profile identity is retained');
    assert.equal(subject.getSurfaceGeometryGeneration(12), farGeneration,
        'distant geometry generation is unchanged');

    verticalAlignments.set(12, 3);
    subject.invalidateVerticalAlignments();
    build(subject, true);
    assert.notEqual(subject.getSurfaceProfilesForOsmId(12)[0], farBefore,
        'explicit full invalidation still rebuilds the distant profile');
});
