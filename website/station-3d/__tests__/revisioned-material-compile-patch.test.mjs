import test from 'node:test';
import assert from 'node:assert/strict';
import {
    hasRevisionedMaterialCompilePatch,
    installRevisionedMaterialCompilePatch,
} from '../core/revisioned-material-compile-patch.js';

function fakeMaterial() {
    const calls = [];
    return {
        calls,
        needsUpdate: false,
        userData: {},
        onBeforeCompile(shader, renderer) {
            calls.push(['base-compile', this, shader, renderer]);
        },
        customProgramCacheKey() {
            calls.push(['base-key', this]);
            return 'base-program';
        },
    };
}

test('revisioned material patch composes prior callbacks and has a stable cache signature', () => {
    const material = fakeMaterial();
    const applied = [];
    assert.equal(installRevisionedMaterialCompilePatch(material, {
        id: 'corridor',
        revision: '1',
        apply(shader, renderer) {
            applied.push([this, shader, renderer]);
        },
    }), true);
    assert.equal(material.needsUpdate, true);
    assert.equal(hasRevisionedMaterialCompilePatch(material, {
        id: 'corridor', revision: '1',
    }), true);
    assert.equal(installRevisionedMaterialCompilePatch(material, {
        id: 'corridor', revision: '1', apply() {},
    }), false, 'same callback revision is idempotent');

    const shader = { vertexShader: 'v', fragmentShader: 'f' };
    const renderer = {};
    material.onBeforeCompile(shader, renderer);
    assert.deepEqual(material.calls[0], ['base-compile', material, shader, renderer]);
    assert.deepEqual(applied[0], [material, shader, renderer]);
    assert.equal(material.customProgramCacheKey(), 'base-program|corridor@1');
    assert.deepEqual(material.calls[1], ['base-key', material]);
});

test('JSON-cloned legacy marker cannot suppress a missing shader callback', () => {
    const source = fakeMaterial();
    installRevisionedMaterialCompilePatch(source, {
        id: 'corridor', revision: '1', apply() {},
    });
    source.userData.__corridorPatched = true;

    // Mirrors Three r184 Material.copy(): userData is JSON-copied while
    // onBeforeCompile and customProgramCacheKey assignments are not copied.
    const clone = fakeMaterial();
    clone.userData = JSON.parse(JSON.stringify(source.userData));
    assert.equal(clone.userData.__corridorPatched, true);
    assert.equal(hasRevisionedMaterialCompilePatch(clone, {
        id: 'corridor', revision: '1',
    }), false);
    assert.equal(installRevisionedMaterialCompilePatch(clone, {
        id: 'corridor', revision: '1', apply() {},
    }), true);
    assert.equal(clone.userData.__corridorPatched, undefined);
    assert.equal(hasRevisionedMaterialCompilePatch(clone, {
        id: 'corridor', revision: '1',
    }), true);
});

test('revision upgrade replaces its old wrapper instead of stacking injections', () => {
    const material = fakeMaterial();
    let oldApplies = 0;
    let newApplies = 0;
    installRevisionedMaterialCompilePatch(material, {
        id: 'corridor', revision: '1', apply() { oldApplies++; },
    });
    installRevisionedMaterialCompilePatch(material, {
        id: 'corridor', revision: '2', apply() { newApplies++; },
    });
    material.onBeforeCompile({}, {});
    assert.equal(oldApplies, 0);
    assert.equal(newApplies, 1);
    assert.equal(material.calls.filter(([name]) => name === 'base-compile').length, 1);
    assert.equal(material.customProgramCacheKey(), 'base-program|corridor@2');
    assert.equal(material.customProgramCacheKey().includes('corridor@1'), false);
});

test('foreign callback replacement is reconciled at the same patch revision', () => {
    const material = fakeMaterial();
    installRevisionedMaterialCompilePatch(material, {
        id: 'corridor', revision: '1', apply() {},
    });
    let foreignCompile = 0;
    material.onBeforeCompile = function foreignHook() { foreignCompile++; };
    material.customProgramCacheKey = function foreignKey() { return 'foreign'; };
    assert.equal(hasRevisionedMaterialCompilePatch(material, {
        id: 'corridor', revision: '1',
    }), false);
    let repairedApply = 0;
    assert.equal(installRevisionedMaterialCompilePatch(material, {
        id: 'corridor', revision: '1', apply() { repairedApply++; },
    }), true);
    material.onBeforeCompile({}, {});
    assert.equal(foreignCompile, 1);
    assert.equal(repairedApply, 1);
    assert.equal(material.customProgramCacheKey(), 'foreign|corridor@1');
});
