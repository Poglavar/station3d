import test from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import { prepareFixedSurfacePublication, prepareFixedSurfacePublicationSteps } from '../core/fixed-surface-publication.js';

await RAPIER.init();
const mesh = (y, spec) => ({
    vertices: new Float32Array([-2, y, -2, 2, y, -2, -2, y, 2, 2, y, 2]),
    indices: new Uint32Array([0, 2, 1, 1, 2, 3]),
    friction: 1, collisionGroups: 0xffffffff, spec,
});
const replacement = (key, y) => ({ key, spec: { id: key, kind: key },
    meshes: y === null ? [] : [mesh(y, { owner: key, y })] });
function fixture(t) {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    t.after(() => world.free());
    const active = new Map(), metadata = new Map();
    for (const [key, y] of [['ground', 0], ['bridge', 2]]) {
        const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
        const m = mesh(y);
        const collider = world.createCollider(RAPIER.ColliderDesc.trimesh(m.vertices, m.indices), body);
        active.set(key, { body, collider, colliders: [collider], spec: { id: key, kind: key } });
        metadata.set(collider.handle, { owner: key, y });
    }
    const prepare = (replacements, overrides = {}) => prepareFixedSurfacePublication({
        RAPIER, world, active, metadata, replacements,
        activeColliderCount: [...active.values()].reduce((sum, entry) => sum + (entry.colliders?.length || 0), 0),
        maxColliders: 2, maxStagedColliders: 2, ...overrides,
    });
    const support = fromY => {
        world.step();
        const hit = world.castRay(new RAPIER.Ray({ x: 0, y: fromY, z: 0 }, { x: 0, y: -1, z: 0 }), 30, true);
        return hit ? fromY - hit.timeOfImpact : null;
    };
    const counts = () => [world.bodies.len(), world.colliders.len()];
    return { world, active, metadata, prepare, support, counts };
}

test('disabled candidates are absent from Rapier queries; promotion and rollback switch both floors', t => {
    const f = fixture(t);
    const old = new Map(f.active), oldMetadata = new Map(f.metadata);
    const tx = f.prepare([replacement('ground', 0.5), replacement('bridge', 3)]);
    assert.deepEqual(f.counts(), [4, 4], 'two live and two bounded staged bodies');
    assert.equal(f.support(1), 0);
    assert.equal(f.support(5), 2);
    assert.deepEqual(f.active, old);
    assert.deepEqual(f.metadata, oldMetadata);
    assert.equal(tx.promote(), true);
    assert.equal(f.support(1), 0.5);
    assert.equal(f.support(5), 3);
    assert.equal(f.metadata.size, 2);
    assert.equal(f.metadata.get(f.active.get('ground').collider.handle).y, 0.5);
    assert.equal(tx.rollback(), true);
    assert.equal(f.support(1), 0);
    assert.equal(f.support(5), 2);
    assert.deepEqual(f.active, old);
    assert.deepEqual(f.metadata, oldMetadata);
    assert.equal(tx.dispose(), true);
    assert.equal(tx.dispose(), false);
    assert.deepEqual(f.counts(), [2, 2]);
});

test('cooperative allocation keeps all chunks private and closing a partial body frees every chunk', t => {
    const f = fixture(t), before = new Map(f.active);
    const steps = prepareFixedSurfacePublicationSteps({
        RAPIER, world: f.world, active: f.active, metadata: f.metadata,
        replacements: [{ key: 'ground', spec: { id: 'ground' }, meshes: [mesh(.5), mesh(.6), mesh(.7)] }],
        activeColliderCount: 2, maxColliders: 4, maxStagedColliders: 3,
    });
    assert.equal(steps.next().value.stagedColliders, 1);
    assert.deepEqual(f.counts(), [3, 3]);
    assert.equal(f.support(1), 0, 'the first private chunk is not yet support');
    assert.equal(steps.next().value.stagedColliders, 2);
    assert.deepEqual(f.counts(), [3, 4]);
    assert.equal(f.support(1), 0);
    steps.return();
    assert.deepEqual(f.active, before);
    assert.deepEqual(f.counts(), [2, 2]);
    assert.equal(f.support(1), 0);
});

test('all cooperatively prepared chunks promote and roll back as one surface family', t => {
    const f = fixture(t);
    const steps = prepareFixedSurfacePublicationSteps({
        RAPIER, world: f.world, active: f.active, metadata: f.metadata,
        replacements: [{ key: 'ground', spec: { id: 'ground' }, meshes: [mesh(.5), mesh(.6), mesh(.7)] }],
        activeColliderCount: 2, maxColliders: 4, maxStagedColliders: 3,
    });
    for (let i = 1; i <= 3; i++) {
        assert.equal(steps.next().value.stagedColliders, i);
        assert.equal(f.support(1), 0);
    }
    const ready = steps.next();
    assert.equal(ready.done, true);
    assert.equal(ready.value.promote(), true);
    assert.ok(Math.abs(f.support(1) - .7) < 1e-6);
    assert.equal(ready.value.rollback(), true);
    assert.equal(f.support(1), 0);
    ready.value.dispose();
    assert.deepEqual(f.counts(), [2, 2]);
});

test('successful retirement releases old bodies and empty replacement removes only its family', t => {
    const f = fixture(t);
    const tx = f.prepare([replacement('ground', 0.5), replacement('bridge', 3)]);
    tx.promote();
    assert.deepEqual(tx.retire(), []);
    assert.deepEqual(f.counts(), [2, 2]);
    assert.equal(tx.dispose(), false);
    const empty = f.prepare([replacement('bridge', null)], { maxStagedColliders: 0 });
    assert.equal(empty.promote(), true);
    assert.equal(f.active.get('bridge').body, null, 'explicit empty publication keeps source acknowledgement');
    empty.retire();
    assert.deepEqual(f.counts(), [1, 1]);
    assert.equal(f.support(5), 0.5);
    assert.equal(f.metadata.size, 1);
});

test('replacement capacity excludes old colliders and separately bounds staging peak', t => {
    const f = fixture(t);
    assert.throws(() => f.prepare([replacement('ground', 1), replacement('bridge', 3)],
        { maxStagedColliders: 1 }), { code: 'surface-collider-capacity' });
    assert.throws(() => f.prepare([replacement('extra', 4)]), { code: 'surface-collider-capacity' });
    assert.deepEqual(f.counts(), [2, 2]);
    const tx = f.prepare([replacement('ground', 1), replacement('bridge', 3)]);
    assert.equal(tx.nextColliderCount, 2, 'replacement fits full active capacity');
    tx.dispose();
    assert.deepEqual(f.counts(), [2, 2]);
});

test('a second collider allocation failure frees both partial bodies and preserves every old floor', t => {
    const f = fixture(t), old = new Map(f.active), oldMetadata = new Map(f.metadata);
    let calls = 0;
    const original = f.world.createCollider.bind(f.world);
    const failingWorld = {
        createRigidBody: f.world.createRigidBody.bind(f.world),
        removeRigidBody: f.world.removeRigidBody.bind(f.world),
        createCollider(...args) { if (++calls === 2) throw new Error('injected allocation failure'); return original(...args); },
    };
    assert.throws(() => f.prepare([replacement('ground', 0.5), replacement('bridge', 3)],
        { world: failingWorld }), /injected/);
    assert.deepEqual(f.counts(), [2, 2]);
    assert.deepEqual(f.active, old);
    assert.deepEqual(f.metadata, oldMetadata);
    assert.equal(f.support(1), 0);
    assert.equal(f.support(5), 2);
});

test('a stale prepared batch cannot replace a newer owner or leak its disabled bodies', t => {
    const f = fixture(t);
    const stale = f.prepare([replacement('ground', 0.5)]);
    const newer = f.prepare([replacement('ground', 1)]);
    newer.promote(); newer.retire();
    const current = f.active.get('ground');
    assert.equal(stale.promote(), false);
    assert.equal(f.active.get('ground'), current);
    assert.deepEqual(f.counts(), [2, 2]);
    assert.equal(f.support(1.5), 1);
    assert.equal(f.support(5), 2);
});
