// Conversion of ingested proposal buildings into pipeline features: the id
// namespace (dedup safety against cadastre ids), the synthetic tile keys that
// keep proposal geometry in its own aggregate regions, and the exemption
// predicate the mask/carve tests key on.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PROPOSAL_BUILDING_ID_PREFIX,
    PROPOSAL_BUILDING_TILE_PREFIX,
    isProposalBuildingBucketKey,
    isProposalBuildingFeature,
    isProposalBuildingTileKey,
    proposalBuildingFeaturesByTile,
} from '../core/proposal-building-features.js';

const ANCHOR = { anchorLat: 43.75, anchorLon: 15.87 };

// ~200 m × ~140 m rectangle of lon/lat around a point.
function ringAround(lat, lon, dLat = 0.00063, dLon = 0.00125) {
    return [
        [lon - dLon, lat - dLat], [lon + dLon, lat - dLat],
        [lon + dLon, lat + dLat], [lon - dLon, lat + dLat],
        [lon - dLon, lat - dLat],
    ];
}

test('features carry namespaced unique ids, the flag, and the height', () => {
    const byTile = proposalBuildingFeaturesByTile([
        { ring: ringAround(43.7501, 15.8701), heightM: 17.5, proposalId: 903 },
        { ring: ringAround(43.7502, 15.8702), heightM: 12 },
    ], ANCHOR);
    const features = [...byTile.values()].flat();
    assert.equal(features.length, 2);
    const ids = features.map(f => f.properties.object_id);
    assert.equal(new Set(ids).size, 2, 'ids must be unique');
    for (const f of features) {
        assert.ok(f.properties.object_id.startsWith(PROPOSAL_BUILDING_ID_PREFIX));
        assert.equal(isProposalBuildingFeature(f), true);
        assert.equal(f.geometry.type, 'Polygon');
    }
    assert.equal(features[0].properties.height, 17.5);
    assert.equal(features[0].properties.proposalId, 903);
    assert.equal('proposalId' in features[1].properties, false);
});

test('holes ride along as inner rings; degenerate holes drop, degenerate outers skip', () => {
    const outer = ringAround(43.7501, 15.8701);
    const hole = ringAround(43.7501, 15.8701, 0.0002, 0.0004);
    const byTile = proposalBuildingFeaturesByTile([
        { ring: outer, holes: [hole, [[15.87, 43.75]]], heightM: 15 },
        { ring: [[15.87, 43.75], [15.87, 43.75], [15.87, 43.75]], heightM: 15 },   // one repeated point
        { ring: null, heightM: 15 },
    ], ANCHOR);
    const features = [...byTile.values()].flat();
    assert.equal(features.length, 1, 'only the valid building survives');
    assert.equal(features[0].geometry.coordinates.length, 2, 'outer + the one valid hole');
});

test('block-wide courtyard rings survive independently of parcel-piece holes', () => {
    const outer = ringAround(43.7501, 15.8701);
    const courtyard = ringAround(43.7501, 15.8701, 0.0002, 0.0004);
    const byTile = proposalBuildingFeaturesByTile([
        {
            ring: outer,
            holes: [],
            courtyardRings: [courtyard, [[15.87, 43.75]]],
            heightM: 15,
        },
    ], ANCHOR);
    const [feature] = [...byTile.values()].flat();

    assert.equal(feature.geometry.coordinates.length, 1, 'the parcel piece itself stays hole-free');
    assert.deepEqual(feature.properties.__proposalCourtyardRings, [courtyard]);
});

test('model-url buildings stay off this path', () => {
    const byTile = proposalBuildingFeaturesByTile([
        { ring: ringAround(43.7501, 15.8701), heightM: 15, modelUrl: 'https://x/model.glb' },
        { ring: ringAround(43.7502, 15.8702), heightM: 15 },
    ], ANCHOR);
    const features = [...byTile.values()].flat();
    assert.equal(features.length, 1);
});

test('heights are floored at 1 m and default when non-finite', () => {
    const byTile = proposalBuildingFeaturesByTile([
        { ring: ringAround(43.7501, 15.8701), heightM: 0.2 },
        { ring: ringAround(43.7502, 15.8702), heightM: Number.NaN },
    ], ANCHOR);
    const heights = [...byTile.values()].flat().map(f => f.properties.height);
    assert.deepEqual(heights.sort((a, b) => a - b), [1, 6]);
});

test('tiling: same neighbourhood shares a tile, a distant building gets another', () => {
    // Two centroids ~15 m apart in the INTERIOR of one 200 m cell (cell centre
    // sits ~100 m south-east of the anchor), plus one ~1.6 km east. Interior on
    // purpose: any two points can straddle a cell boundary, and that would test
    // the grid line's position, not the grouping.
    const byTile = proposalBuildingFeaturesByTile([
        { ring: ringAround(43.749100, 15.871250), heightM: 15 },
        { ring: ringAround(43.749050, 15.871350), heightM: 15 },
        { ring: ringAround(43.749100, 15.891250), heightM: 15 },
    ], ANCHOR);
    assert.equal(byTile.size, 2);
    for (const [tileKey, features] of byTile) {
        assert.ok(isProposalBuildingTileKey(tileKey), tileKey);
        assert.ok(features.length >= 1);
    }
    // Deterministic: the same input tiles identically on a second run.
    const again = proposalBuildingFeaturesByTile([
        { ring: ringAround(43.749100, 15.871250), heightM: 15 },
    ], ANCHOR);
    const [onlyKey] = [...again.keys()];
    assert.ok([...byTile.keys()].includes(onlyKey));
});

test('the closing duplicate point does not bias the centroid across a cell line', () => {
    // An OPEN ring and its CLOSED twin must land in the same tile — averaging
    // the closing duplicate used to drag the centroid ~40 m toward one corner.
    const open = ringAround(43.749100, 15.871250).slice(0, 4);
    const closed = ringAround(43.749100, 15.871250);
    const a = proposalBuildingFeaturesByTile([{ ring: open, heightM: 15 }], ANCHOR);
    const b = proposalBuildingFeaturesByTile([{ ring: closed, heightM: 15 }], ANCHOR);
    assert.deepEqual([...a.keys()], [...b.keys()]);
});

test('tile keys never collide with real tile keys, and bucket keys are recognizable', () => {
    // Real building tile keys are `${tx}_${tz}` — must never be claimed by us.
    assert.equal(isProposalBuildingTileKey('3_4'), false);
    assert.equal(isProposalBuildingTileKey('-1_0'), false);
    assert.equal(isProposalBuildingTileKey('radius'), false);
    assert.equal(isProposalBuildingTileKey(`${PROPOSAL_BUILDING_TILE_PREFIX}3|4`), true);
    // overtureRegionForScope splits on '_' — our keys must NOT parse as numeric.
    const key = `${PROPOSAL_BUILDING_TILE_PREFIX}3|4`;
    const [tx] = key.split('_').map(Number);
    assert.equal(Number.isFinite(tx), false, 'key must not look like a numeric tile');
    // Aggregate bucket keys end in /<region>; for proposal tiles region == tileKey.
    assert.equal(isProposalBuildingBucketKey(`ov#3@0cr:un/${key}`), true);
    assert.equal(isProposalBuildingBucketKey('ov#3@0cr:un/12_7'), false);
    assert.equal(isProposalBuildingBucketKey('ov#3@0cr:un/radius'), false);
});

test('bad anchors or an empty list produce an empty map, never a throw', () => {
    assert.equal(proposalBuildingFeaturesByTile([], ANCHOR).size, 0);
    assert.equal(proposalBuildingFeaturesByTile(null, ANCHOR).size, 0);
    assert.equal(proposalBuildingFeaturesByTile(
        [{ ring: ringAround(43.75, 15.87), heightM: 15 }],
        { anchorLat: Number.NaN, anchorLon: 15.87 },
    ).size, 0);
});

test('recognises proposal building object ids and nothing else', async () => {
    const { isProposalBuildingObjectId } = await import('../core/proposal-building-features.js');
    assert.equal(isProposalBuildingObjectId(`${PROPOSAL_BUILDING_ID_PREFIX}0`), true);
    assert.equal(isProposalBuildingObjectId(`${PROPOSAL_BUILDING_ID_PREFIX}417`), true);
    // Cadastre/Overture ids, numbers and absent ids must never match.
    assert.equal(isProposalBuildingObjectId('HR-330264-628'), false);
    assert.equal(isProposalBuildingObjectId(123456), false);
    assert.equal(isProposalBuildingObjectId(null), false);
    assert.equal(isProposalBuildingObjectId(undefined), false);
});
