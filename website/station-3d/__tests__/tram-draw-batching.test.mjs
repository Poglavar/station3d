// Locks the ambient-tram batching and animated-door interaction contract.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const tram = readFileSync(new URL('../vehicles/tram.js', import.meta.url), 'utf8')
    + readFileSync(new URL('../models/vehicles/tram.js', import.meta.url), 'utf8');
const bulletMarks = readFileSync(new URL('../world/bullet-marks.js', import.meta.url), 'utf8');

test('ordinary tram shells batch immutable meshes by material', () => {
    assert.match(tram, /function batchStaticTramMeshes/);
    assert.match(tram, /mergeGeometries\(transformed, false\)/);
    assert.match(tram, /staticTramGeometryCache/);
    assert.match(tram, /registerShared\(geometry\)/);
    assert.match(tram, /if \(options\.legacy\) batchStaticTramMeshes\(group, bodyMat\)/);
    assert.match(tram, /addTramFleetBody\(group, \{/);
});

test('door leaves use two dynamic instances and keep per-instance hit anchors', () => {
    assert.match(tram, /new THREE\.InstancedMesh\([\s\S]*a\.fleetDoorGeom, a\.doorMat, doorCount/);
    assert.match(tram, /new THREE\.InstancedMesh\([\s\S]*a\.doorWindowGeom/);
    assert.match(tram, /userData\.instanceAnchors\[doorInstanceId\] = doorAnchor/);
    assert.match(tram, /setMatrixAt\(p\.instanceId, p\.anchor\.matrix\)/);
    assert.match(bulletMarks, /hit\.object\.userData\?\.instanceAnchors\?\.\[hit\.instanceId\]/);
    assert.match(bulletMarks, /const parentMesh = instanceAnchor \|\| hit\.object/);
});

test('distant services retain a one-draw silhouette and restore detail nearby', () => {
    assert.match(tram, /const OTHER_TRAM_DETAIL_RADIUS_M = 360/);
    assert.match(tram, /function addFarTramLod/);
    assert.match(tram, /new THREE\.Mesh\(geometry, getFarTramMaterial\(\)\)/);
    assert.match(tram, /detailRoot\.visible = detailed/);
    assert.match(tram, /farMesh\.visible = !detailed/);
    assert.match(tram, /updateTramRenderLod\([\s\S]*distanceSq/);
});

test('ambient tram transforms are phased and mesh admission is bounded', () => {
    assert.match(tram, /const OTHER_TRAM_UPDATE_PHASES = 2/);
    assert.match(tram, /hashEnemyTramId\(pose\.id\) % OTHER_TRAM_UPDATE_PHASES/);
    assert.match(tram, /otherTramSeenCycle/);
    assert.match(tram, /if \(createdThisFrame\) continue/);
    assert.match(tram, /otherTramUpdatePhase = \(updatePhase \+ 1\) % OTHER_TRAM_UPDATE_PHASES/);
    assert.match(tram, /buildGtaAmbientTramPathSteps/);
    assert.match(tram, /GTA_AMBIENT_PATH_BUILD_BUDGET_MS = 1/);
    assert.match(tram, /source\.revision === fleet\.build\.revision/, 'each fleet rebuilds only for the revision it started on');
    assert.match(tram, /resetGtaAmbientPathBuild\(\)/);
});

test('ambient tram support cannot synchronously rebuild a dirty road formation', () => {
    const support = tram.slice(
        tram.indexOf('function gtaAmbientTramSupport'),
        tram.indexOf('function gtaAmbientTramPoses'),
    );
    assert.match(support, /sceneYAtLocal\?\.\([\s\S]*requireSurface: true,[\s\S]*allowStale: true/);
});

test('shared tram batches and material variants are session-scoped', () => {
    const dispose = tram.slice(
        tram.indexOf('function disposeTramSessionCaches'),
        tram.indexOf('// Slides a tram'),
    );
    assert.match(dispose, /staticTramGeometryCache\.values\(\)/);
    assert.match(dispose, /farTramGeometryCache\.values\(\)/);
    assert.match(dispose, /tramBodyMaterials\.clear\(\)/);
    assert.match(dispose, /unregisterShared\(resource\)/);
    const lifecycle = tram.slice(tram.indexOf('export const otherTramsLayer'));
    assert.match(lifecycle, /endSession\(\)[\s\S]*disposeTramSessionCaches\(\)/);
});
