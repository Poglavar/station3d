import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RoadFormationModel, buildFormationTerrainCollarPositions } from '../core/road-formation.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/ground-gric-formation.json', import.meta.url)));
const { terrain: lattice } = fixture;
// Independent piecewise planar interpolation of the retained rendered nodes.
// No bilinear interpolation: the receiver has the b-c triangle diagonal.
function terrain(x, z) {
    const col = Math.floor((x - lattice.bounds.minX) / 4), row = Math.floor((z - lattice.bounds.minZ) / 4);
    assert.ok(col >= 0 && row >= 0 && col < lattice.width - 1 && row < lattice.height - 1,
        `all formation evidence stays within the retained source patch: ${x},${z}`);
    const u = (x - lattice.bounds.minX) / 4 - col, v = (z - lattice.bounds.minZ) / 4 - row;
    const a = lattice.heights[row * lattice.width + col], b = lattice.heights[row * lattice.width + col + 1];
    const c = lattice.heights[(row + 1) * lattice.width + col], d = lattice.heights[(row + 1) * lattice.width + col + 1];
    return u + v <= 1 ? a + (b - a) * u + (c - a) * v : b * (1 - v) + c * (1 - u) + d * (u + v - 1);
}
const model = () => new RoadFormationModel({ anchorLat: fixture.anchor.lat, anchorLon: fixture.anchor.lon, baseSceneYAtLocal: terrain });
function add(subject, id) {
    const features = fixture.records.map(record => record.feature).filter(feature => feature.properties.osm_id === id);
    subject.setCenterlineTile(String(id), features.filter(feature => feature.geometry.type === 'LineString'));
    subject.setSurfaceTile(String(id), features.filter(feature => feature.geometry.type !== 'LineString'));
}
const order = [780730372, 131118805, 144554403];

test('the real Grič junction records completed neighbour collar generations, independent of arrival order', () => {
    const expected = model();
    for (const id of order) add(expected, id);
    const wanted = buildFormationTerrainCollarPositions(expected.getSurfaceProfilesForOsmId(780730372)[0]);
    assert.equal(wanted.length / 3, 240);
    for (const arrival of [order, [...order].reverse()]) {
        const subject = model();
        const published = [];
        for (const id of arrival) {
            add(subject, id);
            subject.getSurfaceProfiles();
            const profile = subject.getSurfaceProfilesForOsmId(780730372)[0];
            if (profile) published.push({ profile, positions: buildFormationTerrainCollarPositions(profile),
                generation: subject.getSurfaceGeometryGeneration(780730372) });
        }
        const final = published.at(-1);
        assert.deepEqual(final.positions, wanted);
        if (arrival[0] === 780730372) {
            assert.equal(published[0].positions.length / 3, 264, 'early mesh really differs from the settled junction');
            assert.ok(final.generation > published[0].generation, 'road renderer can reject the early mesh generation');
            assert.deepEqual(buildFormationTerrainCollarPositions(published[0].profile), published[0].positions,
                'captured early profile stays immutable while its successor prepares');
        }
    }
});
