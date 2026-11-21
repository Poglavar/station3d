// The far-buildings horizon has two load guards that a Rijeka amphitheatre view
// (dense hillside, tunnel drive) proved it needs: a per-tile count cap so a
// ~2000-footprint tile never dumps its invisible tail into the far queue, and a
// gate that stops streaming the horizon while enclosed in ANY tunnel span (a
// short tube never trips the length-gated surface suspension, yet still occludes
// the distant hillside). Both live in modules that import THREE and cannot run
// headlessly, so — like roads-aggregate-contract — these are text-level pins:
// they guard against a rename or refactor silently detaching one guard. If a
// shape changes, update the test WITH the code.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FAR = readFileSync(
    fileURLToPath(new URL('../world/buildings-far.js', import.meta.url)),
    'utf8',
);
const CAB = readFileSync(
    fileURLToPath(new URL('../modes/cab.js', import.meta.url)),
    'utf8',
);

test('a dense far tile enqueues only the tallest N prisms, not every footprint', () => {
    assert.match(FAR, /const FAR_MAX_PER_TILE = \d+/,
        'the per-tile horizon cap constant exists');
    // Cap by height, then enqueue the CAPPED list — enqueuing visibleFeatures
    // directly would defeat the cap.
    assert.match(FAR, /farFeatures\.length > FAR_MAX_PER_TILE/,
        'the cap is only paid when a tile actually exceeds it');
    assert.match(FAR, /farFeatures\.sort\(\(a, b\) => b\.farHeight - a\.farHeight\)/,
        'over the cap, keep the tallest by farHeight');
    assert.match(FAR, /\.slice\(0, FAR_MAX_PER_TILE\)/,
        'the tail beyond the cap is dropped');
    assert.match(FAR, /const requestFeatures = farFeatures\.map/,
        'the capped list is what gets sent to the Worker, not the full tile');
    assert.match(FAR, /renderCompiler\.compile\(request\)/,
        'the capped packet is compiled off the main thread');
    // The detailed layer's far→near swap must still know every footprint, so the
    // authoritative registration covers the WHOLE tile, not the capped subset.
    assert.match(FAR, /registerAuthoritativeBuildingFootprints\(visibleFeatures,/,
        'authoritative footprints still cover every building in the tile');
    assert.match(FAR, /prioritizeByView: true/,
        'the far fetch ring follows the current view before filling hidden horizon tiles');
    assert.match(FAR, /priority: \(\) => classifyViewPriority/,
        'resolved far tiles retain the same view order in the bounded upload queue');
});

test('the far horizon stops streaming while enclosed in any tunnel span', () => {
    assert.match(CAB, /suspendInAnyTunnel: true/,
        'the farBuildings layer entry opts into the any-tunnel gate');
    assert.match(CAB, /cabState\.insideTunnelSpan = !!here/,
        'enclosure is recorded from findEnclosingSpan, independent of the length-gated suspend');
    assert.match(CAB, /if \(entry\.suspendInAnyTunnel && cabState\.insideTunnelSpan\) continue;/,
        'the frame dispatch skips any-tunnel-gated layers while enclosed');
});

test('compiled far primitives retain bounded delivery throughput behind near work', () => {
    const queueFactory = FAR.slice(
        FAR.indexOf('function createFarPacketUploadQueue()'),
        FAR.indexOf('function colorForUseClass('),
    );
    assert.match(queueFactory, /workClass: 'delivery'/,
        'a primitive copy must not wait for the one-item/500 ms far-build liveness valve');
    assert.match(queueFactory, /frameBudgetMs: \(\) => farFrameBudgetMs/);
    assert.match(FAR, /job\.uploadTask\.step\(1\)/,
        'one delivery item copies one primitive, not an entire tile');
    assert.match(FAR, /maxItemsPerFrame: 24/,
        'cheap packet copies still have an item cap as well as a time budget');
    assert.match(FAR, /const FAR_CHUNK = 32;/,
        'GPU backing buffers remain divided into small bounded batches');
});

test('far packet admission remains connected to the queue without retaining completed packet arrays', () => {
    const handoff = FAR.slice(FAR.indexOf('const uploadPacket = (packet) => {'), FAR.indexOf('job.promise = job.compileHandle.promise'));
    assert.match(handoff, /job\.compileHandle = null;/,
        'a resolved compiler promise must not pin the packet through GPU prewarm');
    assert.match(handoff, /memoryBudget: buildingGeometryMemory/);
    assert.match(handoff, /const uploadItems = \[\.\.\.packet\.primitives\.keys\(\), FAR_PACKET_PREWARM_ITEM\]/,
        'queue entries are indices, not references to uploaded primitive arrays');
    assert.match(handoff, /if \(job\.uploadTask\.waitingForMemory\) return FRAME_CHUNK_DEFER_ITEM/,
        'denied allocation keeps the queue item pending for a later turn');
});

test('terrain rebasing stages a complete far tile before replacing the visible generation', () => {
    const drain = FAR.slice(
        FAR.indexOf('function drainTerrainFarRebuild'),
        FAR.indexOf('// Centroid of the footprint'),
    );
    const build = FAR.slice(
        FAR.indexOf('function buildFarTile'),
        FAR.indexOf('function removeFarTileVisuals'),
    );
    assert.doesNotMatch(drain, /removeFarTile\(task\.tileKey\)/,
        'terrain refresh must not tear down the visible far tile before rebuilding');
    assert.match(drain, /replaceExisting: true/);
    assert.match(build, /publicationTicket\.publish\(root/);
    assert.doesNotMatch(
        build.slice(0, build.indexOf('publicationTicket.publish(root')),
        /removeFarTileVisuals\(tileKey\)/,
        'the complete packet publishes before the registry retires the prior generation',
    );
});
