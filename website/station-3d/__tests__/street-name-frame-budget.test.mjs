// Ensures streamed street-label geometry remains a resumable frame task.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../world/street-names.js', import.meta.url), 'utf8');

test('street-name repicks queue labels instead of extruding the whole set', () => {
    const repick = source.slice(
        source.indexOf('function repick'),
        source.indexOf('function setVisible'),
    );
    assert.match(source, /function\* buildTextGeometrySteps/);
    assert.match(source, /function stepPendingMount/);
    assert.match(repick, /pendingMounts\.push\(name\)/);
    assert.doesNotMatch(repick, /new THREE\.ExtrudeGeometry/);
    assert.match(source, /stepPendingMount\(cx, cz\)/);
});

test('street-name build evidence identifies each bounded stage', () => {
    for (const phase of [
        'raster',
        'contours',
        'shape-classification',
        'shape-holes',
        'shapes',
    ]) {
        assert.match(source, new RegExp(`phase: '${phase}'`));
    }
    assert.match(source, /classificationChecks % 32/);
    assert.match(source, /holeChecks % 16/);
    assert.match(source, /result\.done \? 'extrude'/);
    assert.match(source, /recordLayerFrameMs\([\s\S]*streetNames:build:/);
    assert.match(source, /yield\* traceRasterLoops\(inside, width, height\)/);
    assert.match(source, /yield\* extrudeLabelShapesSteps\(shapes,/);
    assert.match(source, /while \(performance\.now\(\) < deadline\)/);
    assert.doesNotMatch(source, /new THREE\.ExtrudeGeometry/);
});

test('street-name teardown unmounts cached geometry before disposing it once', () => {
    const teardown = source.slice(source.indexOf('    endSession()'));
    assert.match(teardown, /for \(const name of \[\.\.\.mounted\.keys\(\)\]\) unmount\(name\)/);
    assert.ok(
        teardown.indexOf('unmount(name)') < teardown.indexOf('disposeGroup(group)'),
        'cached label geometry is detached before the group disposer runs',
    );
    assert.match(teardown, /for \(const geometry of geometryCache\.values\(\)\)/);
});
