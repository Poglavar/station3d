// Bench supports are sub-pixel shadow detail; pin the two useful caster batches.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../world/decor.js', import.meta.url), 'utf8');

test('benches cast one seat and one back shadow, not four part shadows', () => {
    const start = source.indexOf("seatMesh.name = 'DecorBenchSeats'");
    const end = source.indexOf('const dummy = new THREE.Object3D()', start);
    const build = source.slice(start, end);
    assert.match(build, /seatMesh\.castShadow = true/);
    assert.match(build, /backMesh\.castShadow = true/);
    assert.match(build, /leftSupportMesh\.castShadow = false/);
    assert.match(build, /rightSupportMesh\.castShadow = false/);
});
