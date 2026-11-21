import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('the live vehicle installer passes each session publication owner without an ambient registry', async () => {
    const source = await readFile(new URL('../modes/cab.js', import.meta.url), 'utf8');
    const installer = source.slice(source.indexOf('function installVehicleControllers('),
        source.indexOf('\nexport async function transitionCampaignGtaToWalk('));
    const calls = [];
    const context = vm.createContext({
        enabledVehicleControllerKinds: () => ['road'],
        createGtaSession(options) { calls.push(options); return { debugState: () => ({ ready: true }) }; },
        getRenderedRoadSurfacePartsNear: () => [], getRenderedRoadSurfaceRevision: () => 1,
        gtaSpecialVehicleProvider: {}, setWalkControlsMode() {}, window: {},
        getWalkGroundY: () => 3, getGtaPhysicsGroundY: () => 4,
    });
    vm.runInContext(installer, context);
    const first = { anchorLat: 45, anchorLon: 16, surfacePublications: {}, groundPublications: {}, terrain: {} };
    const second = { ...first, surfacePublications: {}, groundPublications: {}, terrain: {} };
    context.installVehicleControllers(first, {});
    context.installVehicleControllers(second, {});
    assert.equal(calls.length, 2);
    for (const [index, session] of [first, second].entries()) {
        assert.equal(calls[index].surfacePublications, session.surfacePublications);
        assert.equal(calls[index].groundPublications, session.groundPublications);
        assert.equal(calls[index].terrain(), session.terrain);
        assert.equal(calls[index].physicsGroundYAt(0, 0, 0), 4);
        assert.equal(session.gtaSession.debugState().ready, true);
    }
});

test('one per-session publication registry owns the first streamed surface swaps', async () => {
    const [cab, terrain, farBuildings, water, markings, rails, decor, planner, platforms, inspector] = await Promise.all([
        readFile(new URL('../modes/cab.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/terrain.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/buildings-far.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/water.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/lane-markings.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/rails.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/decor.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/planner-elevation.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/platforms.js', import.meta.url), 'utf8'),
        readFile(new URL('../debug/inspect.js', import.meta.url), 'utf8'),
    ]);

    assert.match(cab, /createSurfacePublicationRegistry\(\{/);
    assert.match(cab, /surfacePublications,/);
    assert.match(cab, /surfacePublications\.backgroundActivity\(\)/);
    assert.match(cab, /surfacePublications\?\.close\(\)/);
    for (const source of [terrain, farBuildings, water, markings, rails, decor, platforms]) {
        assert.match(source, /surfacePublications\?\.begin|surfacePublications\.begin/);
    }
    assert.match(terrain, /surfacePublications\.prepareBatch\(/);
    assert.match(terrain, /groundPublications\.enqueue\(batch, \{ onPublished \}\)/);
    assert.match(farBuildings, /publicationTicket\.publish\(root/);
    assert.match(water, /publicationTicket\.publish\(nextGroup/);
    assert.match(markings, /publicationTicket\.publish\(mesh/);
    assert.match(rails, /surfacePublications\.prepareBatch\(prepared\.entries\)/);
    assert.match(rails, /groundPublications\.enqueue\(batch/);
    assert.match(platforms, /publicationTicket\.publish\(candidate\.root/);
    assert.match(platforms, /setPlannerEntranceCuts\(next\.entranceCuts, next\.openingClaim\)/);
    assert.doesNotMatch(planner, /setPlannerEntranceCuts/,
        'planner rail generations cannot publish station holes before platform access exists');
    assert.match(inspector, /surfacePublications: currentOptions/);
});

// Planner entrypoints, complete publication, rollback and cancellation are
// exercised against the actual runtime in planner-ground-publication.test.mjs.

test('decor publishes one atomic surface, mask, water, and runway generation', async () => {
    const decor = await readFile(new URL('../world/decor.js', import.meta.url), 'utf8');
    const preparation = decor.slice(
        decor.indexOf('function prepareGreeneryPublicationGroup(group)'),
        decor.indexOf('function setPublishedGreeneryState(group)'),
    );
    const stateCommit = decor.slice(
        decor.indexOf('function setPublishedGreeneryState(group)'),
        decor.indexOf('function disposeGreeneryGroup(group)'),
    );
    const publication = decor.slice(
        decor.indexOf('function publishGreeneryGroup('),
        decor.indexOf('function replaceGroup('),
    );
    const replacement = decor.slice(
        decor.indexOf('function replaceGroup('),
        decor.indexOf('const DECOR_LAYER_SPECS'),
    );

    assert.match(decor, /surfacePublications = publicationRegistry \|\| null/);
    assert.match(decor, /GREENERY_SURFACE_PUBLICATION_KEY = 'decor:greenery-surfaces'/);
    assert.match(preparation, /surfacePublicationClaimCoverage\(child\)/);
    assert.match(preparation, /coverage\.complete[\s\S]*\? surfaceRoot[\s\S]*: propsRoot/);
    assert.match(stateCommit, /greeneryGroup = group \|\| null/);
    assert.match(stateCommit, /waterMaterials = group\?\.userData\?\.waterMaterials \|\| \[\]/);
    assert.match(stateCommit, /currentWaterPolygons = group\?\.userData\?\.waterPolygons \|\| \[\]/);
    assert.match(stateCommit, /currentRunwaySpawns = group\?\.userData\?\.runwaySpawns \|\| \[\]/);
    assert.doesNotMatch(stateCommit, /setTerrainLanduseSurfaceMask\(/);
    assert.match(publication, /group\.remove\(surfaceRoot\)[\s\S]*entry = \{ ticket, root: surfaceRoot/);
    assert.match(publication, /add: \(_context, root\) => \{[\s\S]*group\.add\(root\)[\s\S]*scene\.add\(group\)/);
    assert.match(publication, /commit: \(\) => setPublishedGreeneryState\(group\)/);
    assert.match(publication, /entry = \{ ticket, clear: true[\s\S]*setPublishedGreeneryState\(group\)/);
    assert.match(replacement, /if \(prop === 'greenery'\)\s+publicationResult\s*=\s*publishGreeneryGroup\(group, publication\)/);
    assert.doesNotMatch(
        replacement,
        /if \(greeneryGroup\) disposeGroup\(greeneryGroup\)/,
        'decor cannot remove the visible generation before publishing its successor',
    );
    assert.match(decor, /reason: 'decor-session-ended'/);
});

test('migrated swaps no longer tear down the old root before candidate publication', async () => {
    const [terrain, water, markings, rails] = await Promise.all([
        readFile(new URL('../world/terrain.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/water.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/lane-markings.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/rails.js', import.meta.url), 'utf8'),
    ]);

    const terrainSwap = terrain.slice(
        terrain.indexOf('const root = await runTerrainGridPrepIterator('),
        terrain.indexOf('function ensureAround('),
    );
    assert.match(terrainSwap, /createTerrainTileRootSteps\(/);
    assert.match(terrainSwap, /prepareTerrainTilePublication\(build, root\)/);
    assert.match(terrainSwap, /groundPublications\.enqueue\(batch, \{ onPublished \}\)/);
    assert.doesNotMatch(terrainSwap, /disposeTerrainTileMesh\(previous\)/,
        'the prepared registry batch exclusively owns retirement of the previous tile');
    const markingSwap = markings.slice(
        markings.indexOf('const mesh = new THREE.Mesh(geo, getDashMaterial())'),
        markings.indexOf('function rebuildActiveLaneMarkingsSync'),
    );
    assert.doesNotMatch(markingSwap, /disposeAggregateMesh\(\)[\s\S]*publicationTicket\.publish/);
    assert.match(water, /publicationTicket\.publish\(nextGroup/);
    assert.match(rails, /surfacePublications\.prepareBatch\(prepared\.entries\)/);
    assert.match(rails, /groundPublications\.enqueue\(batch/);
});

test('the complete road family consults the canonical publication registry', async () => {
    const [roads, curbs, structures, crossings] = await Promise.all([
        readFile(new URL('../world/roads.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/curbs.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/road-grade-separations.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/level-crossings.js', import.meta.url), 'utf8'),
    ]);

    for (const source of [roads, curbs, structures, crossings]) {
        assert.match(source, /surfacePublications\?\.begin|surfacePublications\.begin/);
        assert.match(source, /surfacePublications\?\.retire|surfacePublications\.retire/);
    }
    assert.match(roads, /surfacePublications\.prepareBatch\(\[entry\]\)/);
    assert.match(roads, /publicationTicket\.publish\(group/);
    assert.match(roads, /roadReplacementPublicationReadyForOsmId\(\{/);
    assert.match(roads, /surfacePublications\?\.subscribe\?\.\(/);
    assert.match(curbs, /surfacePublications\.prepareBatch\(\[entry\]\)/);
    assert.match(structures, /publicationTicket\.publish\(task\.root, \{ commit, rollback \}\)/);
    assert.match(crossings, /publicationTicket\.publish\(nextGroup, \{ commit \}\)/);
});

test('road-family replacement keys preserve independent grade-separated decks', async () => {
    const [roads, curbs, structures, crossings, replacementPublication] = await Promise.all([
        readFile(new URL('../world/roads.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/curbs.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/road-grade-separations.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/level-crossings.js', import.meta.url), 'utf8'),
        readFile(new URL('../core/road-replacement-publication.js', import.meta.url), 'utf8'),
    ]);

    assert.match(roads, /return `roads:aggregate:\$\{String\(bucketKey\)\}`/);
    assert.match(curbs, /return `curbs:tile:\$\{String\(tileKey\)\}`/);
    assert.match(
        replacementPublication,
        /return `\$\{ROAD_STRUCTURE_PUBLICATION_PREFIX\}\$\{String\(alignmentId\)\}`/,
    );
    assert.match(structures, /roadStructurePublicationKey\(task\.id\)/);
    assert.match(crossings, /LEVEL_CROSSING_PUBLICATION_KEY = 'roads:level-crossing-dressing'/);
    assert.doesNotMatch(
        structures.slice(
            structures.indexOf('function replaceAlignmentGroup(task)'),
            structures.indexOf('function roadStructureInspectionSpec'),
        ),
        /disposeGroup\(previous\)[\s\S]*publicationTicket\.publish/,
        'an old bridge/underpass root cannot retire before its successor commits',
    );
});

test('building aggregate generations publish atomically instead of mutating the live mesh', async () => {
    const buildings = await readFile(new URL('../world/buildings.js', import.meta.url), 'utf8');
    const assembly = buildings.slice(
        buildings.indexOf('function assembleOvertureBuckets'),
        buildings.indexOf('function queueTileAggregates'),
    );

    assert.match(buildings, /surfacePublications = publicationRegistry \|\| null/);
    assert.match(buildings, /return `buildings:aggregate:\$\{String\(bucketKey\)\}`/);
    assert.match(assembly, /publicationTicket\.publish\(active\.mesh/);
    assert.match(assembly, /clearOvertureAggregate\(bucketKey, generation\)/);
    assert.doesNotMatch(
        assembly,
        /aggregate\.mesh\.geometry\s*=/,
        'an assembled successor must stay detached until the registry publishes it',
    );
    assert.ok(
        assembly.indexOf('buildingsGroup.add(active.mesh)')
            < assembly.indexOf('disposeOvertureAggregateMesh(active.aggregate.mesh)'),
        'the direct fallback also attaches and commits before retiring the old aggregate',
    );
});
