// The batcher replaces thousands of individual road meshes with a handful of
// merged ones, so its whole correctness story is: the merged buffers must be
// exactly the concatenation of the parts (with rebased indices), the recorded
// ranges must map every face back to the owner that contributed it, and owners
// leaving must take precisely their geometry with them. A silent off-by-one in
// any of those draws garbage triangles or picks the wrong road — neither shows
// up in a timing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeometryBatcher, ownerRangeForFace } from '../core/geometry-batch.js';

// A quad as an indexed part: 4 vertices, 2 triangles.
function quad(x0, z0, size = 1, entity = null) {
    return {
        attributes: {
            position: Float32Array.from([
                x0, 0, z0, x0 + size, 0, z0, x0 + size, 0, z0 + size, x0, 0, z0 + size,
            ]),
            uv: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        },
        index: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        ...(entity ? { entity } : {}),
    };
}

const replacementLimits = { maxBuckets: 4, maxOwners: 8, maxParts: 32, maxOutputBytes: 100000 };
function drainReplacement(iterator, visit = () => {}) {
    for (let steps = 0; steps < 10000; steps++) {
        const next = iterator.next(); if (next.done) return next.value;
        visit(next.value);
    }
    throw new Error('Geometry replacement did not finish');
}

test('staged owner replacements preserve active buffers and dirty work through commit and rollback', () => {
    const batcher = createGeometryBatcher(), expected = createGeometryBatcher();
    const a = quad(0, 0), b = quad(5, 0), c = quad(10, 0), d = quad(15, 0);
    const aNext = { ...quad(0, 4), surfaceClaim: { ownerId: 'a' } };
    for (const [bucket, owner, part] of [['surface', 'a', a], ['surface', 'b', b], ['empty', 'c', c], ['distant', 'd', d]]) {
        batcher.addPart(bucket, owner, part);
    }
    expected.addPart('surface', 'a', aNext); expected.addPart('surface', 'b', b);
    expected.addPart('new', 'a', c);
    const old = batcher.assemble('surface'), oldEmpty = batcher.assemble('empty');
    const oldAssembly = batcher.beginAssembly('surface'); oldAssembly.step(Infinity);
    batcher.takeDirtyBuckets(); batcher.addPart('distant', 'e', quad(20, 0));
    // Mark a changed bucket dirty too; rollback must restore its unconsumed
    // legacy work without touching the unrelated bucket's flag.
    batcher.addPart('empty', 'c', d);
    const oldEmptyWithWork = batcher.assemble('empty');
    const transaction = drainReplacement(batcher.prepareReplacementSteps([
        { bucketKey: 'surface', ownerKey: 'a', parts: [aNext] },
        { bucketKey: 'empty', ownerKey: 'c', parts: [] },
        { bucketKey: 'new', ownerKey: 'a', parts: [c] },
    ], replacementLimits), () => {
        assert.deepEqual(batcher.assemble('surface'), old);
        assert.equal(batcher.hasOwner('new', 'a'), false);
    });
    assert.deepEqual(transaction.bucketKeys, ['surface', 'empty', 'new']);
    assert.equal(transaction.commit(), false, 'output allocation/copy must finish before commit');
    const outputs = new Map(); let clock = 0, slices = 0;
    for (const key of transaction.bucketKeys) {
        const task = transaction.beginAssembly(key, { now: () => clock++, valuesPerStage: 3, partsPerStage: 1 });
        while (!task.step(.1)) {
            slices++; assert.ok(slices < 1000);
            assert.deepEqual(batcher.assemble('surface'), old);
        }
        outputs.set(key, task.result());
    }
    assert.ok(slices > 15);
    assert.deepEqual(outputs.get('surface'), expected.assemble('surface'));
    assert.equal(outputs.get('empty'), null);
    assert.deepEqual(outputs.get('new'), expected.assemble('new'));
    const expectedBytes = [...outputs.values()].filter(Boolean).reduce((sum, result) => sum
        + Object.values(result.attributes).reduce((n, values) => n + values.byteLength, 0)
        + (result.index?.byteLength || 0), 0);
    assert.equal(transaction.outputBytes, expectedBytes);
    assert.equal(transaction.commit(), true); assert.equal(oldAssembly.isCurrent(), false);
    assert.deepEqual(batcher.assemble('surface'), outputs.get('surface'));
    assert.equal(batcher.assemble('empty'), null); assert.equal(batcher.hasOwner('new', 'a'), true);
    assert.equal(transaction.rollback(), true); assert.equal(oldAssembly.isCurrent(), true);
    assert.deepEqual(batcher.assemble('surface'), old);
    assert.deepEqual(batcher.assemble('empty'), oldEmptyWithWork);
    assert.notDeepEqual(oldEmpty, oldEmptyWithWork);
    assert.equal(batcher.hasOwner('new', 'a'), false);
    assert.deepEqual(batcher.takeDirtyBuckets().sort(), ['distant', 'empty']);
    assert.equal(transaction.commit(), true); assert.equal(transaction.finalize(), true);
    assert.equal(transaction.finalize(), false); assert.equal(transaction.rollback(), false);
    assert.deepEqual(batcher.assemble('surface'), expected.assemble('surface'));
    assert.equal(batcher.hasOwner('distant', 'd'), true); assert.equal(batcher.hasOwner('distant', 'e'), true);
});

test('stale or cancelled replacement cannot overwrite newer streamed geometry', () => {
    const batcher = createGeometryBatcher(), original = quad(0, 0);
    batcher.addPart('surface', 'a', original); batcher.takeDirtyBuckets();
    const rows = [{ bucketKey: 'surface', ownerKey: 'a', parts: [quad(4, 0)] }];
    const partial = batcher.prepareReplacementSteps(rows, replacementLimits);
    assert.equal(partial.next().done, false); partial.return();
    let tx = drainReplacement(batcher.prepareReplacementSteps(rows, replacementLimits));
    let task = tx.beginAssembly('surface'); task.step(Infinity);
    batcher.removeOwner('surface', 'a');
    assert.equal(tx.isCurrent(), false); assert.equal(task.isCurrent(), false); assert.equal(tx.commit(), false);
    assert.equal(tx.discard(), true); assert.equal(batcher.assemble('surface'), null);
    tx = drainReplacement(batcher.prepareReplacementSteps(rows, replacementLimits));
    task = tx.beginAssembly('surface'); task.step(Infinity); batcher.clear();
    assert.equal(tx.commit(), false); assert.equal(tx.discard(), true);
    assert.deepEqual(batcher.stats(), {});
    assert.deepEqual(batcher.takeDirtyBuckets(), []);
});

test('replacement capacity/schema checks fail before assembly and release the pending owner', () => {
    const batcher = createGeometryBatcher();
    batcher.addPart('surface', 'a', quad(0, 0)); batcher.addPart('surface', 'b', quad(2, 0));
    const original = batcher.assemble('surface');
    const rows = [{ bucketKey: 'surface', ownerKey: 'a', parts: [quad(4, 0)] }];
    for (const limits of [{ ...replacementLimits, maxParts: 1 }, { ...replacementLimits, maxOutputBytes: 1 }]) {
        assert.throws(() => drainReplacement(batcher.prepareReplacementSteps(rows, limits)), /capacity exceeded/);
        assert.deepEqual(batcher.assemble('surface'), original);
    }
    const wrong = [{ ...rows[0], parts: [{ attributes: { position: new Float32Array(9) } }] }];
    assert.throws(() => drainReplacement(batcher.prepareReplacementSteps(wrong, replacementLimits)), /schema mismatch/);
    assert.throws(() => drainReplacement(batcher.prepareReplacementSteps([...rows, ...rows], replacementLimits)), /Duplicate/);
    const tx = drainReplacement(batcher.prepareReplacementSteps(rows, replacementLimits));
    assert.throws(() => drainReplacement(batcher.prepareReplacementSteps(rows, replacementLimits)), /already pending/);
    assert.equal(tx.discard(), true); assert.deepEqual(batcher.assemble('surface'), original);
});

test('identical owner parts and absent removals are no-op staged replacements', () => {
    const batcher = createGeometryBatcher(), part = quad(0, 0);
    batcher.addPart('surface', 'a', part); batcher.takeDirtyBuckets();
    const held = batcher.beginAssembly('surface'); held.step(Infinity);
    const tx = drainReplacement(batcher.prepareReplacementSteps([
        { bucketKey: 'surface', ownerKey: 'a', parts: [part] },
        { bucketKey: 'absent', ownerKey: 'missing', parts: [] },
    ], replacementLimits));
    assert.deepEqual(tx.bucketKeys, []); assert.equal(tx.outputBytes, 0);
    assert.equal(tx.commit(), true); assert.equal(tx.finalize(), true);
    assert.equal(held.isCurrent(), true); assert.deepEqual(batcher.takeDirtyBuckets(), []);
});

test('merged buffers are the exact concatenation with rebased indices', () => {
    const batcher = createGeometryBatcher();
    batcher.addPart('surface', 'roadA', quad(0, 0));
    batcher.addPart('surface', 'roadA', quad(10, 0));   // second part, same owner
    batcher.addPart('surface', 'roadB', quad(20, 0));

    const out = batcher.assemble('surface');
    assert.equal(out.vertexCount, 12);
    assert.equal(out.index.length, 18);
    // First part verbatim…
    assert.deepEqual([...out.attributes.position.slice(0, 12)], [...quad(0, 0).attributes.position]);
    // …second part's vertices follow, and its indices are rebased by 4.
    assert.deepEqual([...out.index.slice(6, 12)], [4, 5, 6, 4, 6, 7]);
    // Third part rebased by 8.
    assert.deepEqual([...out.index.slice(12, 18)], [8, 9, 10, 8, 10, 11]);
    // No index may reach outside the vertex buffer — the classic rebase bug.
    for (const i of out.index) assert.ok(i < out.vertexCount);
});

test('ranges cover the whole buffer and resolve faces to their owner', () => {
    const batcher = createGeometryBatcher();
    batcher.addPart('surface', 'roadA', quad(0, 0, 1, { key: 'osm:way:1' }));
    batcher.addPart('surface', 'roadA', quad(5, 0));
    batcher.addPart('surface', 'roadB', quad(9, 0, 1, { key: 'osm:way:2' }));

    const out = batcher.assemble('surface');
    assert.equal(out.ranges.length, 2);
    assert.deepEqual(out.ranges.map(r => r.ownerKey), ['roadA', 'roadB']);
    // Contiguous cover: each range starts where the previous ended.
    assert.equal(out.ranges[0].start, 0);
    assert.equal(out.ranges[1].start, out.ranges[0].count);
    assert.equal(out.ranges[1].start + out.ranges[1].count, out.index.length);
    // roadA contributed 4 triangles (faces 0-3), roadB 2 (faces 4-5).
    assert.equal(ownerRangeForFace(out.ranges, 0).ownerKey, 'roadA');
    assert.equal(ownerRangeForFace(out.ranges, 3).ownerKey, 'roadA');
    assert.equal(ownerRangeForFace(out.ranges, 4).ownerKey, 'roadB');
    assert.equal(ownerRangeForFace(out.ranges, 5).entity.key, 'osm:way:2');
    assert.equal(ownerRangeForFace(out.ranges, 6), null, 'past the end is nobody');
});

test('optional owner bounds are copied-output AABBs across parts and owners', () => {
    const batcher = createGeometryBatcher();
    const part = (values, index = null) => ({
        attributes: { position: Float32Array.from(values), uv: new Float32Array(values.length / 3 * 2) },
        ...(index ? { index: Uint32Array.from(index) } : {}),
    });
    batcher.addPart('b', 'a', part([1.0000001, -2, 3, 9, 4, -5], [0, 1]));
    batcher.addPart('b', 'a', part([-7, 8, 2]));
    batcher.addPart('b', 'c', part([100, 1, 2, 101, 3, 4], [0, 1]));
    const task = batcher.beginAssembly('b', { includeOwnerBounds: true });
    task.step(Infinity);
    const result = task.result();
    assert.deepEqual(result.ranges.map(range => range.bounds), [
        { minX: -7, minY: -2, minZ: -5, maxX: 9, maxY: 8, maxZ: 3 },
        { minX: 100, minY: 1, minZ: 2, maxX: 101, maxY: 3, maxZ: 4 },
    ]);
    assert.equal(result.ranges[0].start, 0);
    assert.equal(result.ranges[0].count, 3);
    assert.equal(result.ranges[1].start, 3);
    assert.equal(result.ranges[1].count, 2);
    const legacy = createGeometryBatcher();
    legacy.addPart('b', 'a', part([1, 2, 3]));
    const legacyTask = legacy.beginAssembly('b'); legacyTask.step(Infinity);
    assert.equal(Object.hasOwn(legacyTask.result().ranges[0], 'bounds'), false);
});

test('surface audit ranges retain per-part claims without changing picking ranges', () => {
    const batcher = createGeometryBatcher();
    const sidewalk = { surfaceClass: 'sidewalk', featureId: 'positive' };
    const negativeA = { surfaceClass: 'road', featureId: -1 };
    const negativeB = { surfaceClass: 'road', featureId: -2 };
    batcher.addPart('surface', 'owner', { ...quad(0, 0, 1, { key: 'positive' }), surfaceClaim: sidewalk });
    batcher.addPart('surface', 'owner', { ...quad(2, 0), surfaceClaim: negativeA });
    batcher.addPart('surface', 'owner', { ...quad(4, 0), surfaceClaim: negativeB });
    batcher.addPart('surface', 'owner', quad(6, 0));
    const out = batcher.assemble('surface');
    assert.equal(out.ranges.length, 1);
    assert.equal(out.ranges[0].entity.key, 'positive');
    assert.deepEqual(out.surfaceAuditRanges.map(range => range.claim?.featureId ?? null),
        ['positive', -1, -2, null]);
    assert.deepEqual(out.surfaceAuditRanges.map(range => [range.start, range.count]),
        [[0, 6], [6, 6], [12, 6], [18, 6]]);
});

test('removing an owner removes exactly its geometry', () => {
    const batcher = createGeometryBatcher();
    batcher.addPart('surface', 'roadA', quad(0, 0));
    batcher.addPart('surface', 'roadB', quad(10, 0));
    batcher.addPart('surface', 'roadC', quad(20, 0));
    batcher.takeDirtyBuckets();

    assert.equal(batcher.removeOwner('surface', 'roadB'), true);
    assert.deepEqual(batcher.takeDirtyBuckets(), ['surface']);
    const out = batcher.assemble('surface');
    assert.equal(out.vertexCount, 8);
    assert.deepEqual(out.ranges.map(r => r.ownerKey), ['roadA', 'roadC']);
    // roadC's geometry survives byte-identically, now rebased into slot 2.
    assert.deepEqual([...out.attributes.position.slice(12, 24)], [...quad(20, 0).attributes.position]);
    // Removing an absent owner reports false and does not dirty anything.
    assert.equal(batcher.removeOwner('surface', 'roadB'), false);
    assert.deepEqual(batcher.takeDirtyBuckets(), []);
});

test('removeOwnerEverywhere names the buckets it changed', () => {
    // A road feature contributes to surface + collar + wall without the dispose
    // path knowing which; the return value is what gets re-assembled.
    const batcher = createGeometryBatcher();
    batcher.addPart('surface', 'roadA', quad(0, 0));
    batcher.addPart('collar', 'roadA', quad(0, 0));
    batcher.addPart('surface', 'roadB', quad(5, 0));
    batcher.takeDirtyBuckets();

    assert.deepEqual(batcher.removeOwnerEverywhere('roadA').sort(), ['collar', 'surface']);
    assert.equal(batcher.assemble('collar'), null, 'collar is now empty');
    assert.equal(batcher.assemble('surface').ranges.length, 1);
});

test('a schema mismatch throws instead of corrupting the merge', () => {
    const batcher = createGeometryBatcher();
    batcher.addPart('surface', 'roadA', quad(0, 0));
    // Missing uv — every vertex after the splice point would shear.
    assert.throws(() => batcher.addPart('surface', 'roadB', {
        attributes: { position: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 0, 1]) },
        index: Uint32Array.from([0, 1, 2]),
    }), /schema mismatch/);
    // Attribute length not matching the vertex count.
    assert.throws(() => batcher.addPart('surface', 'roadD', {
        attributes: {
            position: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 0, 1]),
            uv: Float32Array.from([0, 0]),
        },
        index: Uint32Array.from([0, 1, 2]),
    }), /does not match/);
});

test('mixed index representations share one batch without duplicating vertices or losing owner ranges',()=>{
    const implicit={attributes:{position:new Float32Array([10,0,0,11,0,0,10,0,1]),uv:new Float32Array([0,0,1,0,0,1])},
        surfaceClaim:{ownerId:'implicit'}};
    const explicit={...quad(0,0),surfaceClaim:{ownerId:'explicit'}};
    for(const parts of [[implicit,explicit],[explicit,implicit]]) {
        const batcher=createGeometryBatcher();
        for(const part of parts)batcher.addPart('one-material',part.surfaceClaim.ownerId,part);
        const result=batcher.assemble('one-material');
        assert.equal(Object.keys(batcher.stats()).length,1);
        assert.equal(result.indexed,true);assert.equal(result.vertexCount,7);
        const expected=parts[0]===implicit?[0,1,2,3,4,5,3,5,6]:[0,1,2,0,2,3,4,5,6];
        assert.deepEqual([...result.index],expected);
        assert.deepEqual([...result.attributes.position],parts.flatMap(p=>[...p.attributes.position]));
        let face=0;
        for(const part of parts)for(let i=0;i<(part.index?.length??3)/3;i++,face++) {
            assert.equal(ownerRangeForFace(result.ranges,face).ownerKey,part.surfaceClaim.ownerId);
            const audit=result.surfaceAuditRanges.find(r=>face*3>=r.start&&face*3<r.start+r.count);
            assert.equal(audit.claim,part.surfaceClaim);
        }
        batcher.removeOwner('one-material','explicit');
        const remaining=batcher.assemble('one-material');
        assert.equal(remaining.index,null);assert.equal(remaining.indexed,false);
        assert.deepEqual(remaining.attributes,implicit.attributes);
    }
});

test('a staged indexed cut retains implicit neighbours, budgets their indices, and rolls back the complete layout',()=>{
    const triangle=x=>({attributes:{position:new Float32Array([x,0,0,x+1,0,0,x,0,1])}});
    const a=triangle(0),b=triangle(3),replacement={...triangle(0),index:new Uint32Array([0,2,1])};
    const batcher=createGeometryBatcher();batcher.addPart('surface','a',a);batcher.addPart('surface','b',b);
    const old=batcher.assemble('surface');assert.equal(old.index,null);
    const rows=[{bucketKey:'surface',ownerKey:'a',parts:[replacement]}];
    // Two 3-vertex xyz parts plus six output indices, including the neighbour's
    // implicit index. Omitting that neighbour would under-admit by 12 bytes.
    const bytes=(18+6)*4;
    assert.throws(() => drainReplacement(batcher.prepareReplacementSteps(rows, { ...replacementLimits, maxOutputBytes: bytes - 1 })), error => {
        assert.equal(error.code, 'geometry-replacement-capacity');
        assert.equal(error.details.maxOutputBytes, bytes - 1);
        assert.equal(error.details.outputBytes, bytes);
        assert.equal(error.details.bucketKey, 'surface');
        return true;
    });
    const tx=drainReplacement(batcher.prepareReplacementSteps(rows,replacementLimits),()=>assert.deepEqual(batcher.assemble('surface'),old));
    assert.equal(tx.outputBytes,bytes);
    let clock=0,slices=0;
    const task=tx.beginAssembly('surface',{now:()=>clock++,valuesPerStage:3,partsPerStage:1});
    while(!task.step(.1)){assert.deepEqual(batcher.assemble('surface'),old);assert.ok(++slices<100);}
    assert.ok(slices>3);assert.deepEqual([...task.result().index],[0,2,1,3,4,5]);
    assert.equal(tx.commit(),true);assert.deepEqual(batcher.assemble('surface'),task.result());
    assert.equal(tx.rollback(),true);assert.deepEqual(batcher.assemble('surface'),old);assert.equal(tx.discard(),true);
    assert.deepEqual(a,triangle(0));assert.deepEqual(b,triangle(3));
});

test('non-indexed buckets merge and range in vertex units', () => {
    const tri = (x) => ({
        attributes: {
            position: Float32Array.from([x, 0, 0, x + 1, 0, 0, x, 0, 1]),
            normal: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0]),
        },
    });
    const batcher = createGeometryBatcher();
    batcher.addPart('collar', 'a', tri(0));
    batcher.addPart('collar', 'b', tri(5));
    const out = batcher.assemble('collar');
    assert.equal(out.index, null);
    assert.equal(out.vertexCount, 6);
    assert.deepEqual(out.ranges.map(r => [r.ownerKey, r.start, r.count]), [['a', 0, 3], ['b', 3, 3]]);
    assert.equal(ownerRangeForFace(out.ranges, 1).ownerKey, 'b');
});

test('dropBucket removes the bucket outright, schema included', () => {
    // Tile-scoped buckets die with their tile; unlike removeOwner, the schema
    // does NOT survive — a refilled tile legitimately redefines it.
    const batcher = createGeometryBatcher();
    batcher.addPart('t:1_1', 'a', quad(0, 0));
    batcher.takeDirtyBuckets();
    assert.equal(batcher.dropBucket('t:1_1'), true);
    assert.equal(batcher.assemble('t:1_1'), null);
    assert.deepEqual(batcher.takeDirtyBuckets(), [], 'a dropped bucket is not dirty');
    assert.equal(batcher.dropBucket('t:1_1'), false, 'double drop reports false');
    // Refill with a DIFFERENT schema is allowed — the old bucket is gone.
    batcher.addPart('t:1_1', 'b', {
        attributes: { position: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 0, 1]) },
    });
    assert.equal(batcher.assemble('t:1_1').vertexCount, 3);
});

test('an emptied bucket keeps its schema', () => {
    const batcher = createGeometryBatcher();
    batcher.addPart('surface', 'roadA', quad(0, 0));
    batcher.removeOwner('surface', 'roadA');
    assert.equal(batcher.assemble('surface'), null);
    // Refilling with the same shape works; a different shape still throws —
    // the schema did not silently reset when the bucket drained.
    assert.throws(() => batcher.addPart('surface', 'roadB', {
        attributes: { position: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 0, 1]) },
    }), /schema mismatch/);
    batcher.addPart('surface', 'roadB', quad(1, 1));
    assert.equal(batcher.assemble('surface').ranges.length, 1);
});

test('assembly is deterministic for identical content', () => {
    const build = () => {
        const batcher = createGeometryBatcher();
        batcher.addPart('surface', 'a', quad(0, 0));
        batcher.addPart('surface', 'b', quad(3, 0));
        batcher.addPart('surface', 'c', quad(6, 0));
        return batcher.assemble('surface');
    };
    const one = build();
    const two = build();
    assert.deepEqual([...one.attributes.position], [...two.attributes.position]);
    assert.deepEqual([...one.index], [...two.index]);
    assert.deepEqual(one.ranges, two.ranges);
});

test('cooperative assembly is byte-identical and spans bounded copy stages', () => {
    const batcher = createGeometryBatcher();
    for (let index = 0; index < 12; index++) {
        batcher.addPart('surface', `road${index}`, quad(index * 2, index));
    }
    const expected = batcher.assemble('surface');
    let clock = 0;
    const task = batcher.beginAssembly('surface', {
        valuesPerStage: 6,
        partsPerStage: 2,
        includeBounds: true,
        now: () => clock++,
    });
    let steps = 0;
    while (!task.step(0.1)) {
        steps += 1;
        assert.ok(steps < 1000, 'assembly task must make bounded progress');
    }
    const actual = task.result();
    assert.ok(steps > 12, 'dense assembly must return to its caller repeatedly');
    assert.equal(task.isCurrent(), true);
    assert.deepEqual(actual.attributes, expected.attributes);
    assert.deepEqual(actual.index, expected.index);
    assert.deepEqual(actual.ranges, expected.ranges);
    assert.equal(actual.vertexCount, expected.vertexCount);
    assert.deepEqual(actual.bounds, {
        minX: 0,
        minY: 0,
        minZ: 0,
        maxX: 23,
        maxY: 0,
        maxZ: 12,
    });
});

test('a bucket mutation invalidates an in-flight assembly generation', () => {
    const batcher = createGeometryBatcher();
    batcher.addPart('surface', 'roadA', quad(0, 0));
    let clock = 0;
    const staleTask = batcher.beginAssembly('surface', {
        valuesPerStage: 3,
        now: () => clock++,
    });
    assert.equal(staleTask.step(0.1), false);
    batcher.addPart('surface', 'roadB', quad(10, 0));
    assert.equal(staleTask.isCurrent(), false);

    const currentTask = batcher.beginAssembly('surface', {
        valuesPerStage: 3,
        now: () => clock++,
    });
    while (!currentTask.step(0.1)) { /* drain current immutable snapshot */ }
    assert.equal(currentTask.isCurrent(), true);
    assert.deepEqual(
        currentTask.result().ranges.map(range => range.ownerKey),
        ['roadA', 'roadB'],
    );
});

// --- scoped dirty take -----------------------------------------------------
//
// Callers are REGIONAL: a completing tile may only consume the dirt belonging
// to its own region. Taking the whole set would clear dirt for a region whose
// tile has not completed yet, and that region would then believe its geometry
// was already assembled — announcing detailed coverage over ground whose merged
// mesh does not exist, which drops the far layer's prisms into a hole.
test('takeDirtyBuckets(only) consumes just that subset and leaves the rest', () => {
    const batcher = createGeometryBatcher();
    const part = () => ({ attributes: { position: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]) } });
    batcher.addPart('regionA:1', 'ownerA', part());
    batcher.addPart('regionA:2', 'ownerA', part());
    batcher.addPart('regionB:1', 'ownerB', part());

    const taken = batcher.takeDirtyBuckets(new Set(['regionA:1', 'regionA:2']));
    assert.deepEqual(taken.sort(), ['regionA:1', 'regionA:2']);

    // regionB's dirt must survive, or its tile announces over unbuilt geometry.
    assert.deepEqual(batcher.takeDirtyBuckets(), ['regionB:1']);
    assert.deepEqual(batcher.takeDirtyBuckets(), [], 'a take clears what it returned');
});

test('a scoped take reports only what actually changed', () => {
    // This is the redundancy the region-wide re-assembly was paying: a bucket
    // no owner touched must not come back dirty just because a neighbour in
    // the same region completed.
    const batcher = createGeometryBatcher();
    const part = () => ({ attributes: { position: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]) } });
    batcher.addPart('b1', 'o1', part());
    batcher.addPart('b2', 'o1', part());
    batcher.takeDirtyBuckets();                       // assembled both

    batcher.addPart('b1', 'o2', part());              // only b1 changed
    const region = new Set(['b1', 'b2']);
    assert.deepEqual(batcher.takeDirtyBuckets(region), ['b1']);

    // Removing an owner dirties its bucket too — eviction must re-assemble.
    batcher.removeOwner('b2', 'o1');
    assert.deepEqual(batcher.takeDirtyBuckets(region), ['b2']);
});
