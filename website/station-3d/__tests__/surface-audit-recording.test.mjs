import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySurfaceStack, SURFACE_AUDIT_VIOLATION } from '../core/surface-audit.js';
import { compileSurfaceClaim, SURFACE_COVERAGE_STATE, SURFACE_VERTICAL_RELATION } from '../core/surface-hierarchy.js';
import { createSurfaceAuditRecording, decodeSurfaceAuditCell, classifyRecordedSurfaceCell, SURFACE_AUDIT_STACK_SCHEMA } from '../core/surface-audit-recording.js';

const hit = (y, extra = {}) => ({ y, claim: { surfaceClass: 'terrain' }, ownerKey: 'terrain', publicationKey: 'terrain:0', stencil: null, colorWrite: true, renderOrder: 0, culled: false, discarded: false, ...extra });
const claim = surfaceClass => compileSurfaceClaim({ surfaceClass, coverageState: SURFACE_COVERAGE_STATE.PUBLISHED, verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL, verticalBand: 'ground' });

test('JSON roundtrip preserves cells, descriptor deduplication, null claims and null discard', () => {
    const recording = createSurfaceAuditRecording({ options: { radiusM: 2, stepM: 1 } });
    recording.recordCell({ x: 1, z: 2, terrainCovered: true, hits: [hit(4, { discarded: null, claim: null }), hit(4, { discarded: null, claim: null })] });
    recording.recordCell({ x: 2, z: 2, hits: [hit(5, { claim: { surfaceClass: 'sidewalk' }, discarded: false })] });
    const roundtrip = JSON.parse(JSON.stringify(recording.result()));
    assert.equal(roundtrip.schema, SURFACE_AUDIT_STACK_SCHEMA);
    assert.equal(roundtrip.descriptors.length, 2);
    assert.deepEqual(decodeSurfaceAuditCell(roundtrip, 0).hits[0].discarded, null);
    assert.equal(decodeSurfaceAuditCell(roundtrip, 0).hits[0].claim, null);
    assert.equal(decodeSurfaceAuditCell(roundtrip, 0).hits[0].y, 4);
});

test('changed claim or geometry creates a distinct descriptor while coordinates remain explicit', () => {
    const r = createSurfaceAuditRecording();
    r.recordCell({ x: 0, z: 0, hits: [hit(1)] });
    r.recordCell({ x: 0, z: 1, hits: [hit(1, { claim: { surfaceClass: 'sidewalk' } })] });
    assert.equal(r.result().cells[0].x, 0); assert.equal(r.result().cells[1].z, 1);
    assert.equal(r.result().descriptors.length, 2);
});

test('recorded classifier result equals direct classifier result', () => {
    const r = createSurfaceAuditRecording();
    const hits = [hit(1, { claim: claim('terrain') }), hit(0.95, { claim: claim('sidewalk') })];
    r.recordCell({ x: 3, z: 4, hits });
    assert.deepEqual(classifyRecordedSurfaceCell(r.result(), 0), classifySurfaceStack(hits, { terrainCovered: false }));
    assert.equal(classifyRecordedSurfaceCell(r.result(), 0).violations[0].type, SURFACE_AUDIT_VIOLATION.INVERSION);
});

test('malformed recordings and nonfinite inputs are rejected', () => {
    const r = createSurfaceAuditRecording();
    assert.throws(() => r.recordCell({ x: NaN, z: 0 }), /finite/);
    assert.throws(() => r.recordCell({ x: 0, z: 0, hits: [{ y: Infinity }] }), /finite/);
    assert.throws(() => decodeSurfaceAuditCell({ schema: SURFACE_AUDIT_STACK_SCHEMA, descriptors: [], cells: [{ x: 0, z: 0, terrainCovered: false, hits: [{ descriptor: 2, y: 1 }] }] }, 0), /descriptor/);
    assert.throws(() => decodeSurfaceAuditCell({ schema: 'wrong', descriptors: [], cells: [] }, 0), /invalid/);
});

test('captured thresholds are used on replay and unknown coverage does not become zero', () => {
    const options = { coplanarGapM: 0.015 };
    const r = createSurfaceAuditRecording({ options });
    const hits = [hit(1, { claim: claim('terrain') }), hit(1.01, { claim: claim('sidewalk') })];
    r.recordCell({ x: 0, z: 0, terrainCovered: null, hits });
    const saved = JSON.parse(JSON.stringify(r.result()));
    assert.equal(decodeSurfaceAuditCell(saved, 0).terrainCovered, null);
    assert.deepEqual(classifyRecordedSurfaceCell(saved, 0), classifySurfaceStack(hits, { ...options, terrainCovered: null }));
    assert.equal(classifyRecordedSurfaceCell(saved, 0).violations[0].type, SURFACE_AUDIT_VIOLATION.COPLANAR);
    assert.throws(() => r.recordCell({ x: null, z: 0 }), /finite/);
    assert.throws(() => r.recordCell({ x: 0, z: 0, hits: [hit(null)] }), /finite/);
});
