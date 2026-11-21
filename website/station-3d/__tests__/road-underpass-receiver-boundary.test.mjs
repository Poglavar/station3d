// Replays a native cut wider than its structure, and checks the terrain opening
// against the renderer's actual sampled floor triangles without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { RoadVerticalAlignmentModel, roadStructureFormationOffsetsM,
    roadStructureFormationOffsetsAtSampleM, roadReplacementFormationBlend } from '../core/road-vertical-alignment.js';
import { roadStructureHalfWidths, roadStructureSampleFrame } from '../core/road-structure-cross-section.js';
import { roadGradeSeparationBuildPlan } from '../core/road-grade-separation-spec.js';
import { createRenderedRoadSurfaceRegistry } from '../core/rendered-road-surface.js';
import { pointInRing } from '../core/mask-query.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/savska-underpass-cut.json', import.meta.url)));
function replay(definition = fixture.definition) {
    return new RoadVerticalAlignmentModel({
        anchorLat: fixture.anchorLat, anchorLon: fixture.anchorLon, definitions: [definition],
        absoluteToSceneY: y => y - fixture.anchorElevationM, sampleSpacingM: 8,
        terrainSceneYAtLocal: (x, z) => {
            let best = null, distance = Infinity;
            for (const sample of fixture.samples) {
                const d = (sample.x - x) ** 2 + (sample.z - z) ** 2;
                if (d < distance) { best = sample; distance = d; }
            }
            return best.terrainY;
        },
    });
}

function renderedFloor(alignment, alignments) {
    const source = fs.readFileSync(new URL('../world/road-grade-separations.js', import.meta.url), 'utf8');
    const context = vm.createContext({
        alignmentHalfWidths: roadStructureHalfWidths, roadStructureSampleFrame,
        roadStructureFormationOffsetsAtSampleM, roadReplacementFormationBlend,
        EMBANKMENT_SLOPE_RUN_PER_RISE: 1.65,
        geometryFromPositions: vertices => new Float32Array(vertices),
        pushQuad: (vertices, a, b, c, d) => {
            for (const p of [a, b, c, a, c, d]) vertices.push(p.x, p.y, p.z);
        },
    });
    // Exercise production row frames and floor tessellation. Only the Three.js
    // BufferGeometry wrapper is omitted; the physical triangle buffer is real.
    vm.runInContext(source.slice(source.indexOf('function sampleRows('), source.indexOf('// A junction mouth'))
        + source.slice(source.indexOf('function buildSurface('), source.indexOf('function structureSegmentIndices(')), context);
    const width = roadStructureHalfWidths(alignment).formationHalfWidthM;
    const rows = context.sampleRows(alignment, alignments, roadStructureFormationOffsetsM(alignment, alignments, width));
    const positions = context.buildSurface(rows, r => r.formationLeftM, r => -r.formationRightM);
    const registry = createRenderedRoadSurfaceRegistry();
    registry.replace('floor', [{ positions }]);
    return { rows, registry };
}

test('Savska widthless underpass preserves ground beside its published 12 m formation', () => {
    const model = replay(), alignment = model.getAlignments()[0];
    assert.deepEqual(alignment.samples, fixture.samples, 'the native axis/elevations replay exactly');
    assert.equal(roadGradeSeparationBuildPlan(alignment).baseFormationHalfWidthM, 6);
    for (const [x, z] of [[24.5, 57.5], [27.5, 58.5]]) {
        assert.equal(pointInRing(x, z, fixture.oldCutRing), true, 'old cut removed this real parking receiver');
        assert.equal(model.isInsideReplacementTerrainOpening(x, z), false, 'ground beyond the structure remains');
    }
    assert.equal(model.isInsideReplacementTerrainOpening(12.914, 70.261), true, 'the genuine portal remains open');
    assert.equal(model.isInsideReplacementTerrainOpening(52.75, 67.7), false, 'the covered box retains its terrain roof');
});

test('default and explicit cut cross-sections stay within the renderer floor through curved portal boundaries', () => {
    for (const crossSection of [fixture.definition.crossSection,
        { carriagewayHalfWidthM: 5, formationHalfWidthM: 7.5 }]) {
        const model = replay({ ...fixture.definition, crossSection });
        const alignments = model.getAlignments(), alignment = alignments[0];
        const { rows, registry } = renderedFloor(alignment, alignments);
        let interiorSamples = 0;
        for (const region of model.getReplacementTerrainCutoutRegions().filter(r => r.cutoutRing)) {
            const ring = region.cutoutRing, count = ring.length / 2;
            for (let i = 0; i < count; i++) {
                const centerX = (ring[i].x + ring[ring.length - 1 - i].x) / 2;
                const centerZ = (ring[i].z + ring[ring.length - 1 - i].z) / 2;
                const row = rows.find(r => Math.hypot(r.x - centerX, r.z - centerZ) < 1e-8);
                assert.ok(row);
                assert.ok(Math.hypot(ring[i].x - row.left.x, ring[i].z - row.left.z) < 1e-8,
                    'even the last open row uses the full alignment frame');
            }
            for (let z = region.cutoutBounds.minZ + .13; z < region.cutoutBounds.maxZ; z += .5) {
                for (let x = region.cutoutBounds.minX + .17; x < region.cutoutBounds.maxX; x += .5) {
                    if (!pointInRing(x, z, ring)) continue;
                    interiorSamples++;
                    assert.notEqual(registry.supportYAt(x, z), null, `cut must have a floor at ${x},${z}`);
                }
            }
        }
        assert.ok(interiorSamples > 500);
    }
});
