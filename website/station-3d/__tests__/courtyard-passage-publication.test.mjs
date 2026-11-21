// Characterize the real passage registration/removal orchestration: a tile
// publishes its final cut set once, not once per accepted road/building pair.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { passageCutBand } from '../world/passage-geometry.js';

function fixture() {
    const source = readFileSync(new URL('../world/courtyard-passages.js', import.meta.url), 'utf8');
    const registrations = source.slice(source.indexOf('function getAllPassageOBBs()'),
        source.indexOf('export const courtyardPassagesLayer ='));
    const allPublications = [], shaderPublications = [], removed = [];
    const sandbox = {
        MAX_PASSAGES: 200, VISIBLE_PASSAGES: 24, PASSAGE_HEIGHT_M: 5, PASSAGE_CUT_END_OVERHANG_M: 0.8,
        roadOBBs: new Map(), passageById: new Map(), tilePassages: new Map(),
        customTrackOpenCutOBBs: [], customTrackPatchById: new Map(), customTrackPatchIdsByTile: new Map(),
        buildingSamplesByTile: new Map(), roadSamplesByTile: new Map(), vehicleBuildingGridsByTile: new Map(),
        loadedRoadIds: new Set(), loadedBuildingIds: new Set(), tileRoadIds: new Map(), tileBuildingIds: new Map(),
        cutVolumesRevision: 0, playerLocalX: 0, playerLocalZ: 0, lastSyncedPlayerX: 0, lastSyncedPlayerZ: 0,
        passageCutBand, isPassageDebugBuilding: () => false, boxesOverlap: () => true,
        spawnPassageMesh: id => ({ id }), disposePassageMesh: mesh => removed.push(mesh.id),
        removeCustomTrackPatch() {},
        buildPassageVolume: (_building, road) => ({
            centerX: road.obb.centerX, centerZ: road.obb.centerZ,
            baseSceneY: 0, halfHeight: 2, halfDepth: 1, halfWidth: 1,
        }),
        setAllBuildingPassageCutVolumes: (entries, revision) => allPublications.push({ entries, revision }),
        setBuildingPassageVolumes: entries => shaderPublications.push(entries),
    };
    runInNewContext(registrations, sandbox);
    const roads = Array.from({ length: 200 }, (_, index) => ({
        roadId: `road:${index}`, tileKey: 'roads:0', alongX: 1, alongZ: 0,
        obb: { centerX: index * 2, centerZ: 0, alongX: 1, alongZ: 0, halfDepth: 1 },
    }));
    const buildings = [{ buildingId: 'building:0', tileKey: 'buildings:0' }];
    sandbox.roadSamplesByTile.set('roads:0', roads);
    sandbox.buildingSamplesByTile.set('buildings:0', buildings);
    return { sandbox, roads, buildings, allPublications, shaderPublications, removed };
}

for (const delivery of ['roads', 'buildings']) {
    test(`${delivery} delivery publishes one complete courtyard cut set, and duplicates publish nothing`, () => {
        const f = fixture();
        const pair = () => delivery === 'roads'
            ? f.sandbox.pairRoadsAgainstBuildings(f.roads)
            : f.sandbox.pairBuildingsAgainstRoads(f.buildings);
        pair();
        assert.equal(f.sandbox.passageById.size, 200);
        assert.equal(f.allPublications.length, 1);
        assert.equal(f.shaderPublications.length, 1);
        assert.equal(f.allPublications[0].entries.length, 200);
        assert.equal(f.allPublications[0].revision, 200);
        assert.equal(f.shaderPublications[0].length, 24);
        assert.deepEqual(Array.from(f.shaderPublications[0], entry => entry.centerX),
            Array.from({ length: 24 }, (_, index) => index * 2));
        pair();
        assert.equal(f.allPublications.length, 1, 'an unchanged replay has no publication');
    });
}

for (const removal of ['tile', 'session']) {
    test(`${removal} removal publishes the final empty courtyard cut set once`, () => {
        const f = fixture();
        f.sandbox.pairRoadsAgainstBuildings(f.roads);
        f.allPublications.length = 0; f.shaderPublications.length = 0;
        if (removal === 'tile') f.sandbox.removeTilePassages('roads:0');
        else f.sandbox.clearAllPassages();
        assert.equal(f.sandbox.passageById.size, 0);
        assert.equal(f.removed.length, 200);
        assert.equal(new Set(f.removed).size, 200, 'each mesh is disposed exactly once');
        assert.equal(f.allPublications.length, 1);
        assert.equal(f.shaderPublications.length, 1);
        assert.equal(f.allPublications[0].entries.length, 0);
        assert.equal(f.shaderPublications[0].length, 0);
    });
}
