import test from 'node:test';
import { withoutOmittedCurbRanges } from '../core/curb-terrain-drape.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    CURB_DRAPE_KIND,
    CURB_TERRAIN_EVIDENCE_GAP,
    CURB_TERRAIN_STEP_BUDGET_MS,
    CURB_TERRAIN_VERTICES_PER_STEP,
    curbDrapeHeightSource,
    stepCurbTerrainDrape,
    stepCurbTerrainDrapeSettled,
} from '../core/curb-terrain-drape.js';

const CURBS = readFileSync(new URL('../world/curbs.js', import.meta.url), 'utf8');

test('curb terrain draping yields after a bounded vertex step without changing output', () => {
    const vertexCount = CURB_TERRAIN_VERTICES_PER_STEP * 2 + 3;
    const positions = [];
    for (let index = 0; index < vertexCount; index++) {
        positions.push(index, 100, index * 0.5);
    }
    const item = {
        positions,
        start: 0,
        end: positions.length,
        osmIds: ['road'],
        verticalOsmIds: ['bridge'],
    };
    const calls = [];
    const resolveY = (context, x, z, osmIds, verticalOsmIds, drapeVertex) => {
        calls.push({ context, x, z, osmIds, verticalOsmIds, drapeVertex });
        return x + z;
    };

    let visits = 0;
    let done = false;
    while (!done) {
        const callsBefore = calls.length;
        done = stepCurbTerrainDrape(item, resolveY, 'state', CURB_TERRAIN_VERTICES_PER_STEP, () => 0);
        visits += 1;
        assert.ok(
            calls.length - callsBefore <= CURB_TERRAIN_VERTICES_PER_STEP,
            'one scheduler visit exceeded the vertex cap',
        );
    }

    assert.equal(visits, Math.ceil(vertexCount / CURB_TERRAIN_VERTICES_PER_STEP));
    assert.equal(calls.length, vertexCount);
    for (let index = 0; index < vertexCount; index++) {
        assert.equal(positions[index * 3 + 1], 100 + index + index * 0.5);
    }
    assert.ok(calls.every(call => call.context === 'state'));
    assert.ok(calls.every(call => call.osmIds === item.osmIds));
    assert.ok(calls.every(call => call.verticalOsmIds === item.verticalOsmIds));
    assert.ok(calls.every(call => call.drapeVertex.drapeKind === CURB_DRAPE_KIND.OWNER));
    assert.ok(calls.every((call, index) => call.drapeVertex.localY === 100));
});

test('curb draping checks the deadline at every vertex and resumes without adding an offset twice', () => {
    let time = 0, reads = 0;
    const item = { positions: [0, .18, 0, 1, -.035, 0, 2, .18, 0, 3, .18, 0] };
    const resolve = (_context, x) => {
        reads++;
        time += CURB_TERRAIN_STEP_BUDGET_MS * .6;
        return 5 + x;
    };
    assert.equal(stepCurbTerrainDrape(item, resolve, null, 256, () => time), false);
    assert.equal(reads, 2);
    assert.equal(item.cursor, 6);
    assert.deepEqual(item.positions, [0, 5.18, 0, 1, 5.965, 0, 2, .18, 0, 3, .18, 0]);
    assert.equal(stepCurbTerrainDrape(item, resolve, null, 256, () => time), true);
    assert.equal(reads, 4);
    assert.deepEqual(item.positions, [0, 5.18, 0, 1, 5.965, 0, 2, 7.18, 0, 3, 8.18, 0]);
    assert.equal(stepCurbTerrainDrape(item, resolve, null, 256, () => time), true);
    assert.equal(reads, 4);
});

test('one expensive curb lookup yields immediately and cheap cached vertices still obey the finite cap', () => {
    for (const cost of [0, CURB_TERRAIN_STEP_BUDGET_MS * 10]) {
        let time = 0, reads = 0;
        const item = { positions: Array.from({ length: 600 }, () => [0, .18, 0]).flat() };
        const done = stepCurbTerrainDrape(item, () => { reads++; time += cost; return 5; },
            null, CURB_TERRAIN_VERTICES_PER_STEP, () => time);
        assert.equal(done, false);
        assert.equal(reads, cost ? 1 : CURB_TERRAIN_VERTICES_PER_STEP);
        assert.equal(item.cursor, reads * 3);
    }
});

test('only a terrain-seam landing consumes raised-side ground', () => {
    assert.equal(
        curbDrapeHeightSource(CURB_DRAPE_KIND.TERRAIN_SEAM, -0.035),
        'raised-side',
    );
    assert.equal(
        curbDrapeHeightSource(CURB_DRAPE_KIND.TERRAIN_SEAM, 0.18),
        'curb-owner',
        'the shared curb-top row stays pinned to its source road',
    );
    assert.equal(
        curbDrapeHeightSource(CURB_DRAPE_KIND.OWNER, -0.035),
        'curb-owner',
        'negative offsets on unrelated geometry do not change owner',
    );
    assert.equal(
        curbDrapeHeightSource(CURB_DRAPE_KIND.TERRAIN_SEAM, null),
        'curb-owner',
        'absent local height is never coerced to a real landing row',
    );
});

test('curb terrain draping rejects unknown support instead of publishing local offsets at the scene datum', () => {
    for (const missing of [null, undefined, NaN, Infinity]) {
        const positions = [0, .18, 0, 1, .18, 1];
        const item = { positions, start: 0, end: positions.length };
        assert.throws(() => stepCurbTerrainDrape(item, (_context, x) => x === 0 ? missing : 2),
            { code: 'curb-terrain-evidence-unavailable' });
        assert.deepEqual(positions, [0, .18, 0, 1, .18, 1]);
        assert.throws(() => stepCurbTerrainDrape(item, () => 2), { code: 'curb-terrain-evidence-unavailable' },
            'a failed partially draped item requires a fresh candidate, not another offset addition');
        const retry = { positions: [0, .18, 0, 1, .18, 1] };
        assert.equal(stepCurbTerrainDrape(retry, () => 2), true);
        assert.deepEqual(retry.positions, [0, 2.18, 0, 1, 2.18, 1]);
    }
});

test('the curb terrain queue repeats the same item until its drape is complete', () => {
    assert.match(CURBS, /stepCurbTerrainDrape\(item, terrainYForBuild, state\)/);
    assert.match(
        CURBS,
        /if \(!applyTerrainBuildItem\(token\.state, item\)\) \{\s*return FRAME_CHUNK_REPEAT_ITEM;/,
    );
    assert.match(CURBS, /describeItem:\s*describeTerrainBuildItem/);
});

// One kerb the DTM cannot support is a tile's data gap, not a world failure.
// Thrown out of the shared ground generation it discarded every other layer in
// that candidate, and the coast collar is prepared last — so a quay kerb over
// Split harbour left the city with a raw sea plane against raw paving.
test('an unsupported curb vertex settles its own tile instead of unwinding the generation', () => {
    const positions = [0, .18, 0, 1, .18, 1];
    const item = { positions, start: 0, end: positions.length };
    const settled = stepCurbTerrainDrapeSettled(item, (_context, x) => (x === 0 ? null : 2), null,
        { isPermanentGap: () => true });
    assert.equal(settled.complete, true, 'the tile must stop asking for more visits');
    assert.equal(settled.evidenceGap?.code, CURB_TERRAIN_EVIDENCE_GAP);
    assert.match(settled.evidenceGap.message, /Curb terrain support is unavailable at 0,0/);
    assert.deepEqual(positions, [0, .18, 0, 1, .18, 1], 'no height may be invented for the gap');

    const supported = { positions: [0, .18, 0, 1, .18, 1] };
    assert.deepEqual(stepCurbTerrainDrapeSettled(supported, () => 2),
        { complete: true, evidenceGap: null });
    assert.deepEqual(supported.positions, [0, 2.18, 0, 1, 2.18, 1]);
});

// Terrain that has not streamed in yet must keep rejecting the candidate —
// that rejection is what brings the evidence. Only the sea mask settles.
test('evidence that is merely late still rejects the candidate', () => {
    const positions = [0, .18, 0];
    const late = () => stepCurbTerrainDrapeSettled({ positions, start: 0, end: 3 }, () => null, null,
        { isPermanentGap: () => false });
    assert.throws(late, { code: CURB_TERRAIN_EVIDENCE_GAP, permanent: false });
    assert.throws(() => stepCurbTerrainDrapeSettled({ positions: [0, .18, 0], start: 0, end: 3 }, () => null),
        { code: CURB_TERRAIN_EVIDENCE_GAP }, 'no classifier means no proof the gap is permanent');
});

test('the sea mask is what proves a curb gap permanent', () => {
    assert.match(CURBS,
        /const curbGapIsPermanent = \(state, x, z\) => isPermanentTerrainGap\(state\?\.ground, x, z\);/);
    assert.match(CURBS, /from '\.\.\/core\/terrain-evidence-gap\.js'/,
        'the whole class must share one definition of a gap that cannot close');
    assert.match(CURBS, /isPermanentGap: curbGapIsPermanent/);
});

test('only a missing-evidence gap is settled; any other fault is still a fault', () => {
    const positions = [0, .18, 0];
    const boom = Object.assign(new Error('resolver exploded'), { code: 'curb-resolver-broken' });
    assert.throws(() => stepCurbTerrainDrapeSettled({ positions, start: 0, end: 3 }, () => { throw boom; }),
        /resolver exploded/);
});

test('the curb generation omits a gapped kerb run and publishes the rest of its tile, never failing its candidate', () => {
    // The candidate carries terrain, paving, water and the coast collar; the
    // collar is built last, so it is the first casualty of an early throw.
    // And one pier kerb must not clear a whole 400 m tile (Split port, 2026-09-16).
    assert.match(CURBS, /\(\{ complete, evidenceGap \} = settleTerrainBuildItem\(state, item\)\)/);
    assert.match(CURBS, /if \(evidenceGap && item\.range\) \{ item\.range\.omitted = true;/,
        'a permanent gap marks its own run, instead of breaking out of the tile');
    assert.doesNotMatch(CURBS, /if \(evidenceGap\) break;/);
    assert.match(
        CURBS,
        /const member = state\s*\n\s*\? yield\* prepareTileBuildPublicationSteps\(withoutOmittedCurbRanges\(state\)/,
        'the geometry builder receives the tile without its omitted runs',
    );
});

test('an omitted kerb run leaves the retained lists intact and vanishes only from the geometry copy', () => {
    const curbPositions = [0, 0, 0, 0, 0, 1, 1, 0, 0,  5, 0, 0, 5, 0, 1, 6, 0, 0,  9, 0, 0, 9, 0, 1, 10, 0, 0];
    const curbUvs = [0, 0, 0, 1, 1, 0,  2, 0, 2, 1, 3, 0,  4, 0, 4, 1, 5, 0];
    const rampPositions = new Float32Array([7, 0, 0, 7, 0, 1, 8, 0, 0]);
    const state = {
        tileKey: 'x', curb: { positions: curbPositions, uvs: curbUvs }, ramp: { positions: rampPositions },
        heightRanges: [
            { positions: curbPositions, start: 0, end: 9, osmIds: [1] },
            { positions: curbPositions, start: 9, end: 18, osmIds: [2], omitted: true },
            { positions: curbPositions, start: 18, end: 27, osmIds: [3] },
            { positions: rampPositions, start: 0, end: 9, osmIds: [2], omitted: true },
        ],
    };
    const view = withoutOmittedCurbRanges(state);
    assert.notEqual(view, state);
    assert.deepEqual(view.curb.positions, [0, 0, 0, 0, 0, 1, 1, 0, 0, 9, 0, 0, 9, 0, 1, 10, 0, 0], 'the middle run is gone');
    assert.deepEqual(view.curb.uvs, [0, 0, 0, 1, 1, 0, 4, 0, 4, 1, 5, 0], 'uvs follow their vertices');
    assert.ok(view.ramp.positions instanceof Float32Array);
    assert.equal(view.ramp.positions.length, 0, 'a fully omitted typed list compacts to nothing');
    assert.equal(view.tileKey, 'x');
    // The retained input is untouched, so a later terrain revision can restore the run.
    assert.equal(curbPositions.length, 27); assert.equal(curbUvs.length, 18);
    assert.equal(state.heightRanges.length, 4);
    // Nothing omitted: the same state comes back, no copies.
    const clean = { ...state, heightRanges: state.heightRanges.map(range => ({ ...range, omitted: false })) };
    assert.equal(withoutOmittedCurbRanges(clean), clean);
    assert.equal(withoutOmittedCurbRanges(null), null);
});
