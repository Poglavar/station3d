// Verifies the copyable material classifications shown when several shader
// masks share one authoritative terrain mesh.

import test from 'node:test';
import assert from 'node:assert/strict';

import { groundSurfaceMaterialClassifications } from '../core/ground-surface-inspection.js';

test('ground surface diagnostics report generic urban blend and base material', () => {
    const layers = groundSurfaceMaterialClassifications({
        urbanPixel: [255, 255, 255, 255],
        urbanUv: { u: 0.5, v: 0.5 },
        baseStyle: 'dalmatian-karst',
    });

    assert.deepEqual(layers.map(layer => layer.id), [
        'generic-urban-ground',
        'terrain-base-material',
    ]);
    assert.equal(layers[0].blend, 1);
});

test('ground surface diagnostics omit empty and edge-faded masks', () => {
    const layers = groundSurfaceMaterialClassifications({
        urbanPixel: [255, 255, 255, 255],
        urbanUv: { u: 0, v: 0.5 },
    });

    assert.deepEqual(layers, []);
});
