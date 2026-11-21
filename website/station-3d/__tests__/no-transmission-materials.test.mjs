// `transmission` on a material is a frame-rate cliff, not a shading option.
//
// In three.js, ANY object in the scene with transmission > 0 makes WebGLRenderer
// run renderTransmissionPass: it draws the entire scene a second time into a
// render target and builds a mipmap chain for it, every frame. None of that
// appears in renderer.info.render.calls, so the scene still looks cheap while
// the frame is not.
//
// Measured 2026-07-27 on a Split ride (project 64), from the perf overlay:
//     FRAME  hooks 1.05  render 254.65  sky 0.08  stall 0.00  peak 525.8ms
//     GPU    calls 271  tris 326k
// 271 draw calls and 326k triangles is a trivial scene that any GPU rasterises
// in well under a millisecond — yet renderer.render averaged 254 ms and spiked
// past 5 s, and the overlay's worst frame named `platforms`, which is exactly
// where the glass materials lived. Four materials (three in platforms.js, one
// glass facade in proposals.js) were carrying transmission 0.22–0.62.
//
// A textual guard is enough here because the property is a literal in a material
// constructor and there is no legitimate use in this world: transparent +
// opacity already gives see-through glass. Transmission only adds refraction,
// and it costs an entire extra render pass to get it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATION_3D = fileURLToPath(new URL('../', import.meta.url));

// `transmission:` as a material property. Not `transmissionMap`, not a comment.
const TRANSMISSION = /^\s*(?!\/\/)(?:.*[,{]\s*)?transmission\s*:/gm;

function sourceFiles(dir) {
    const found = [];
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '__tests__' || entry === 'dist') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
        else if (entry.endsWith('.js')) found.push(full);
    }
    return found;
}

function stripComments(text) {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('no material sets transmission — it costs a second full scene render per frame', () => {
    const offenders = [];
    for (const file of sourceFiles(STATION_3D)) {
        const code = stripComments(readFileSync(file, 'utf8'));
        const hits = code.match(TRANSMISSION);
        if (hits) offenders.push(`${relative(STATION_3D, file)} (${hits.length})`);
    }
    assert.deepEqual(offenders, [],
        'transmission > 0 makes three.js re-render the whole scene into a render '
        + 'target every frame (measured: render 254 ms at only 271 draw calls). '
        + 'Use transparent + opacity, plus clearcoat/low roughness/envMapIntensity '
        + 'for a glassy look, none of which need a second pass.');
});

test('the guard actually matches a real material declaration', () => {
    // Without this the test above could pass because the pattern matches nothing
    // at all, which is the classic way a green guard turns into decoration.
    const sample = `
        const m = new THREE.MeshPhysicalMaterial({
            color: 0x92bdc9,
            transparent: true,
            transmission: 0.22,
        });
        const inline = new THREE.MeshPhysicalMaterial({ opacity: 0.72, transmission: 0.25 });
    `;
    const hits = stripComments(sample).match(TRANSMISSION);
    assert.equal(hits?.length, 2, 'must catch both the multi-line and inline forms');
    // And must NOT fire on a mention in prose or on transmissionMap.
    const benign = `
        // transmission: 0.25 was removed here on purpose
        const m = new THREE.MeshPhysicalMaterial({ transmissionMap: tex });
    `;
    assert.equal(stripComments(benign).match(TRANSMISSION), null);
});
