// The road build runs in cooperative stages: one function prepares a `ctx`, and
// a second appends one ring per visit so a big feature cannot hold the frame.
// Splitting it that way (7ebe0bd) removed the shared scope the two halves used
// to share — and `entityMetadata` was left behind as a dead local in the setup
// while the appender kept referencing the bare name.
//
// The result was `ReferenceError: entityMetadata is not defined` on EVERY road
// tile in Split. Every road surface build failed, so the roads rendered as voids
// with only their lane markings visible (a different layer, different source),
// and the failures retried forever. It survived because nothing here can catch
// it: `node --check` only parses, the unit suite never runs roads.js (it imports
// THREE), and a free identifier is a RUNTIME error.
//
// This is a text-level guard rather than a scope analysis because station-3d
// deliberately has no test dependencies ("No build step, no deps" in its
// package.json) and acorn is not available. It is narrow, but it pins the exact
// contract that broke: everything the appender takes out of `ctx` must be put
// in by the setup. If the shapes below stop matching the file, the test fails
// loudly asking to be updated rather than passing silently.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROADS = readFileSync(
    fileURLToPath(new URL('../world/roads.js', import.meta.url)),
    'utf8',
);

// The `const { a, b } = ctx;` inside the appendRoadRing* helpers ONLY. The
// layer's beginSession(ctx) destructures a completely different ctx (the
// session context: anchorLat, sharedTileSession, terrain…), and folding the two
// together would report permanent false positives — a guard that always fails
// is a guard that gets deleted. The original single appender is now split into
// surface/collar/wall stages so large rings can yield between them.
function namesDestructuredFromCtx(source) {
    const start = source.indexOf('function appendRoadRingSurface(');
    const end = source.indexOf('function createRoadRingTask(', start);
    const names = new Set();
    if (start < 0 || end < 0) return { names, found: 0 };
    const body = source.slice(start, end);
    const pattern = /const\s*\{([^}]*)\}\s*=\s*ctx\s*;/g;
    let match;
    let found = 0;
    while ((match = pattern.exec(body)) !== null) {
        found += 1;
        for (const raw of match[1].split(',')) {
            const name = raw.split(':')[0].split('=')[0].trim();
            if (name) names.add(name);
        }
    }
    return { names, found };
}

// The object literal the setup returns — located by two names that have been in
// it since the split and are meaningless anywhere else in this file.
function namesInReturnedCtx(source) {
    const pattern = /return\s*\{([^}]*featureGroup[^}]*)\}\s*;/g;
    const names = new Set();
    let match;
    let found = 0;
    while ((match = pattern.exec(source)) !== null) {
        if (!/rings/.test(match[1])) continue;
        found += 1;
        for (const raw of match[1].split(/,|\n/)) {
            const line = raw.split('//')[0];
            const name = line.split(':')[0].trim();
            if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
        }
    }
    return { names, found };
}

test('everything the ring appender takes out of ctx is put into it', () => {
    const taken = namesDestructuredFromCtx(ROADS);
    const given = namesInReturnedCtx(ROADS);

    assert.ok(taken.found > 0,
        'guard is stale: found no `const { … } = ctx;` inside the appendRoadRing* helpers — update this test');
    assert.ok(given.found > 0,
        'guard is stale: found no ctx-shaped return object in roads.js — update this test');

    const missing = [...taken.names].filter(name => !given.names.has(name));
    assert.deepEqual(missing, [],
        `these are destructured from ctx but never put in it, so they are free `
        + `identifiers at runtime: ${missing.join(', ')}`);
});

test('entityMetadata specifically survives the stage boundary', () => {
    // Named explicitly because this is the one that shipped broken, and because
    // a generic contract check would pass if someone deleted BOTH sides.
    assert.match(ROADS, /const entityMetadata = roadEntityMetadata\(/,
        'the setup still computes it');
    const taken = namesDestructuredFromCtx(ROADS);
    const given = namesInReturnedCtx(ROADS);
    assert.ok(given.names.has('entityMetadata'), 'it is carried in ctx');
    assert.ok(taken.names.has('entityMetadata'), 'and the appender takes it from ctx');
    // It must NOT be referenced as a bare name outside those two places.
    assert.ok(/entityMetadata,/.test(ROADS), 'carried by shorthand, not recomputed');
});
