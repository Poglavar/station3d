import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeTreeType,
    treeShapeDimensions,
} from '../core/tree-shape.js';
import {
    createPalmTreeParts,
    palmCrownGeometryData,
    palmTrunkGeometryData,
} from '../models/objects/palm-tree.js';
import { normalizeDecorPayload } from '../core/source-entity-data.js';

test('tree type normalization accepts only the imported palm classification', () => {
    assert.equal(normalizeTreeType('PALM'), 'palm');
    assert.equal(normalizeTreeType('broadleaved'), null);
    assert.equal(normalizeTreeType(null), null);
});

test('palms have tall trunks and a reusable feathered crown', () => {
    const palm = treeShapeDimensions(10, 'palm');
    const broadleaf = treeShapeDimensions(10, null);
    assert.ok(palm.trunkHeightM > broadleaf.trunkHeightM);
    assert.ok(palm.trunkRadiusM > 0.1);
    const crown = palmCrownGeometryData();
    assert.equal(crown.positions.length, crown.colors.length);
    assert.ok(crown.positions.length > 4_000, 'paired leaflets provide a detailed silhouette');
    const ys = crown.positions.filter((_, index) => index % 3 === 1);
    assert.ok(Math.max(...ys) > 0);
    assert.ok(Math.min(...ys) < 0);
    const trunk = palmTrunkGeometryData();
    assert.equal(trunk.positions.length, trunk.colors.length);
    const parts = createPalmTreeParts();
    assert.ok(parts.trunkGeo.attributes.normal);
    assert.ok(parts.crownGeo.attributes.color);
    for (const resource of Object.values(parts)) resource.dispose();
});

test('the compact provider payload exposes palm type to engine consumers', () => {
    const [tree] = normalizeDecorPayload('trees', [
        [43.507224, 16.439456, null, 'n1370997552:trees', 'palm'],
    ]);
    assert.equal(tree.metadata.treeType, 'palm');
});
