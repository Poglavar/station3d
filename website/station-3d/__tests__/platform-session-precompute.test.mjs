import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../world/platforms.js', import.meta.url), 'utf8');

test('immutable track projection is prepared once per platform session', () => {
    const preparation = source.slice(
        source.indexOf('function prepareSessionTrackGeometry'),
        source.indexOf('function createPlatformGroup'),
    );
    assert.match(preparation, /prepareStationTrackRoutes\(rawTrackRoutes\)/);
    assert.match(preparation, /splitStationTrackRouteBySegmentOwners/);

    const build = source.slice(
        source.indexOf('function* build('),
        source.indexOf('function distM'),
    );
    assert.match(build, /sessionTrackCandidates\(sessionTrackRoutesByOwner/);
    assert.match(build, /sessionTrackCandidates\([\s\S]*sessionTrackSegmentsByOwner/);
    assert.match(build, /const orderedStops = stops[\s\S]*\.sort\(\(a, b\) => a\.distanceM/);
    assert.match(build, /for \(const stop of orderedStops\)/);
    assert.doesNotMatch(build, /prepareStationTrackRoutes/);
    assert.doesNotMatch(build, /splitStationTrackRouteBySegmentOwners/);
    assert.match(
        build,
        /if \(dx \* dx \+ dz \* dz > r2\) continue;[\s\S]*yield \{ phase: 'station-position'/,
        'each expensive nearby-station build starts as a cooperative stage',
    );
    for (const phase of ['station-shell', 'station-signs', 'station-people']) {
        assert.match(build, new RegExp(`phase: '${phase}'`));
    }
    assert.match(source, /function\* mergeStationPrimitives/);
    assert.match(source, /phase: 'station-merge'/);
    assert.match(source, /yield\* prewarmDetachedObject\(g, \{/);
    assert.match(source, /label: 'station-gpu-prewarm'/);
    assert.match(source, /const asyncGpuPrewarm = true/);
    assert.match(source, /uploadBatch: asyncGpuPrewarm \? 1 : 4/);

    const session = source.slice(
        source.indexOf('export const platformsLayer'),
        source.indexOf('onFrame(pose)'),
    );
    assert.match(session, /prepareSessionTrackGeometry\(tracks \|\| \[\]\)/);
    assert.match(session, /sessionTrackRoutesByOwner = indexSessionTrackCandidates/);
    assert.match(session, /sessionTrackSegmentsByOwner = indexSessionTrackCandidates/);
    assert.match(session, /platformMaterials = createPlatformMaterials\(\)/);
    assert.match(source.slice(source.indexOf('endSession()')), /disposePlatformMaterials\(\)/);
});

test('moving platform rebuilds stage off-scene and publish atomically', () => {
    const sourceLayer = source.slice(source.indexOf('export const platformsLayer'));
    assert.match(sourceLayer, /if \(pendingBuildTask\)[\s\S]*stepPlatformBuild\(pendingBuildTask\)/);
    assert.match(sourceLayer, /pendingBuildTask = task;[\s\S]*stepPlatformBuild\(pendingBuildTask\)/);
    assert.doesNotMatch(sourceLayer, /runPlatformBuildToCompletion/);
    assert.match(source, /noteWorldQueueActive\('platforms'\)/);
    assert.match(source, /noteWorldQueueIdle\('platforms'\)/);
    assert.match(source, /INITIAL_PLATFORM_BUILD_BUDGET_MS = 8/);
    assert.match(source, /function stepPlatformBuild\(task\)/);
    assert.match(source, /outcome\.phase !== 'station-gpu-prewarm:shader-wait'/);

    const publication = source.slice(
        source.indexOf('function publishPlatformGeneration'),
        source.indexOf('function createPlatformBuildTask'),
    );
    assert.match(publication, /PLATFORM_SURFACE_PUBLICATION_KEY/);
    assert.match(publication, /publicationTicket\.publish\(candidate\.root, \{ commit, rollback \}\)/);
    assert.match(publication, /publicationTicket\.clear\(\{ commit, rollback \}\)/);
    assert.ok(
        publication.indexOf('scene.add(candidate.root)')
            < publication.indexOf('disposeGroup(previousGroup)'),
        'the complete replacement becomes live before the previous group is retired',
    );

    const stateCommit = source.slice(
        source.indexOf('function applyPlatformState'),
        source.indexOf('function publishPlatformGeneration'),
    );
    assert.match(stateCommit, /clearPlannerEntranceCuts\(\)/);
    assert.match(stateCommit, /setPlannerEntranceCuts\(next\.entranceCuts, next\.openingClaim\)/);
    assert.match(stateCommit, /group = nextGroup \|\| null/);

    const buildTask = source.slice(
        source.indexOf('function createPlatformBuildTask'),
        source.indexOf('function runPlatformBuildToCompletion'),
    );
    assert.match(buildTask, /annotatePlatformSurfacePublication\(root, generation\)/);
    assert.match(buildTask, /publishPlatformGeneration\(\{ generation, root, state \}\)/);
    assert.ok(
        buildTask.indexOf('builtGroup.userData.terrainEvidenceIncomplete')
            < buildTask.indexOf('publishPlatformGeneration'),
        'incomplete terrain evidence cannot reach the publication transaction',
    );

    const frame = source.slice(
        source.indexOf('    onFrame(pose)'),
        source.indexOf('    endSession()'),
    );
    assert.match(frame, /pendingBuildTask\.cancel\('observer-window-superseded'\)/);
    assert.match(frame, /pendingWindowMoved \|\| pendingGenerationStale/);
});

test('platform primitives are cached and repeated people colours stay instanced', () => {
    const peopleBuilder = source.slice(
        source.indexOf('function buildColoredInstancedMesh'),
        source.indexOf('function buildWaitingPeopleGroup'),
    );
    assert.match(peopleBuilder, /new InstancedMesh\(geometry, material, instances\.length\)/);
    assert.match(peopleBuilder, /mesh\.setColorAt\(/);
    assert.doesNotMatch(peopleBuilder, /const buckets = new Map/);
    assert.match(source, /function consolidateWaitingPeopleGroups/);
    assert.match(source, /consolidateWaitingPeopleGroups\(g\)/,
        'the station window must publish one five-draw crowd, not five draws per stop');
    assert.match(source, /platformPeopleStopKeys/,
        'the consolidated instance buffers retain stop-level boarding visibility');

    assert.match(source, /const stationTemplateCache = new Map\(\)/);
    assert.match(source, /yield\* cloneCachedStation\(templateKey, stopKey\)/);
    assert.match(source, /function\* cloneStationTreeCooperative/);
    assert.match(source, /function cloneStationObjectShallow/);
    assert.match(source, /source\.userData = \{\};[\s\S]*source\.clone\(false\)/,
        'cached clones must not JSON-copy immutable instance metadata');
    assert.match(source, /clone\.userData = \{ \.\.\.\(userData \|\| \{\}\) \}/);
    assert.match(source, /const root = cloneStationObjectShallow\(source\)/);
    assert.match(source, /const childClone = cloneStationObjectShallow\(child\)/);
    assert.match(source, /phase, stop: stopKey, count: copied/);
    assert.doesNotMatch(
        source.slice(
            source.indexOf('function* cacheStationTemplate'),
            source.indexOf('function clearStationTemplateCache'),
        ),
        /\.clone\(true\)/,
    );
    assert.match(source.slice(source.indexOf('    endSession()')), /clearStationTemplateCache\(\)/);
});
