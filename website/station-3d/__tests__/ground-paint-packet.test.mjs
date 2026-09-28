import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { geoToLocal } from '../core/math.js';
import { createGroundCompositePlanSteps } from '../core/ground-composite-plan.js';
import { createGroundPaintPacketSteps } from '../core/ground-paint-packet.js';
import { createGroundPaintPagePainter } from '../core/ground-paint-page-three.js';
import { planGroundPaintUpdate } from '../core/ground-paint-update.js';
import { compileSurfaceClaim, SURFACE_CLASS } from '../core/surface-hierarchy.js';
import { captureGroundPaintStyles } from '../core/ground-paint-styles.js';

const receiver = { key: 'terrain:1', verticalBand: 'ground', coverageRevision: 'r1', bounds: { minX: 0, minZ: 0, maxX: 10, maxZ: 10 } };
const claim = compileSurfaceClaim({ surfaceClass: SURFACE_CLASS.SIDEWALK, coverageState: 'published', verticalBand: 'ground', verticalRelation: 'same-level' });
const limits = { records: 10, vertices: 100, verticesPerRecord: 100, oversized: 10 };
const run = (generator) => { const task = generator; let next; do next = task.next(); while (!next.done); return next.value; };
function planFor(polygons, extra = {}) {
    return run(createGroundCompositePlanSteps({ receiver, records: [{ key: 'source', sourceRevision: 's1', materialRevision: 'm1', materialKey: 'sidewalk', claim, polygons, receiver, ...extra }], limits }));
}
function area(packet) {
    const draw = packet.draws[0]; let total = 0;
    for (let i = 0; i < draw.indices.length; i += 3) {
        const p = Array.from(draw.indices.slice(i, i + 3), index => [draw.positions[index * 3], draw.positions[index * 3 + 1]]);
        total += Math.abs((p[1][0]-p[0][0])*(p[2][1]-p[0][1])-(p[2][0]-p[0][0])*(p[1][1]-p[0][1])) / 2;
    }
    return total;
}
function packet(plan, styles = new Map([['sidewalk', { id: 1, revision: 'm1', linearColor: [0.5, 0.5, 0.5] }]]), overrides = {}) {
    styles = new Map([...styles].map(([key, style]) => [key, {
        surfaceClass: style.surfaceClass || (key === 'buffered-pavers' ? SURFACE_CLASS.BUFFERED_SIDEWALK : SURFACE_CLASS.SIDEWALK),
        roughness: style.roughness ?? 0.96, metalness: style.metalness ?? 0, normalInfluence: style.normalInfluence ?? 0,
        ...style,
    }]));
    return run(createGroundPaintPacketSteps({ plan, bounds: receiver.bounds, size: 16, styles, limits: { pixels: 1000, draws: 10, verticesPerPolygon: 100, ...overrides } }));
}

test('polygon-with-hole triangulates to outer-minus-hole area', () => {
    const p = planFor([{ outerRing: [{x:0,z:0},{x:10,z:0},{x:10,z:10},{x:0,z:10}], holeRings: [[{x:2,z:2},{x:8,z:2},{x:8,z:8},{x:2,z:8}]] }]);
    assert.equal(Math.round(area(packet(p))), 64);
});

test('one textured contribution retains its world UV phase and tint across cooperative polygon yields', () => {
    const p = planFor([0, 2].map(x => ({ outerRing: [{x,z:0},{x:x+1,z:0},{x,z:1}], holeRings: [] })));
    const map = { key: 'stone-pavers', revision: 'bitmap:1', uvTransform: [1/3.6, 0, .25, 0, 1/3.6, .75] };
    const color = [.6, .7, .8];
    const styles = new Map([['sidewalk', { id: 7, revision: 'm1', surfaceClass: SURFACE_CLASS.SIDEWALK, roughness: .96, metalness: 0, normalInfluence: 0, linearColor: color, albedoMap: map }]]);
    const steps = createGroundPaintPacketSteps({ plan: p, bounds: receiver.bounds, size: 16, styles,
        limits: { pixels: 256, draws: 2, verticesPerPolygon: 10 } });
    let firstPolygon;
    do { firstPolygon = steps.next(); } while (!firstPolygon.done && firstPolygon.value.phase !== 'paint-triangulation');
    assert.equal(firstPolygon.done, false);
    map.uvTransform[2] = .9; color[0] = 0;
    const out = run(steps);
    assert.equal(out.draws.length, 1, 'polygons in one source command share one draw');
    assert.deepEqual(out.styles.recipes[0].linearColor, [.6, .7, .8]);
    assert.equal(out.styles.recipes[0].albedoMap.uvTransform[2], .25);
    assert.equal(Object.isFrozen(out.styles.recipes[0].albedoMap.uvTransform), true);
    assert.equal(out.stats.textureBytes, 256 * 1, 'page stores exact R8 material IDs');
});

test('unchanged copied pages avoid triangulation, while dirty blocks replay surviving lower ranks', () => {
    const polygon = { outerRing: [{x:0,z:0},{x:10,z:0},{x:10,z:10},{x:0,z:10}], holeRings: [] };
    const p = planFor([polygon]);
    const previous = { receiver, bounds: receiver.bounds, size: 16, styles: captureGroundPaintStyles(new Map([['sidewalk', { id: 1, revision: 'm1', surfaceClass: SURFACE_CLASS.SIDEWALK, roughness: .96, metalness: 0, normalInfluence: 0, linearColor: [.5,.5,.5] }]])) };
    const options = { receiver, bounds: receiver.bounds, size: 16, previous, blockSize: 4 };
    const make = update => run(createGroundPaintPacketSteps({ plan: p, bounds: receiver.bounds, size: 16,
        styles: new Map([['sidewalk', { id: 1, revision: 'm1', surfaceClass: SURFACE_CLASS.SIDEWALK, roughness: .96, metalness: 0, normalInfluence: 0, linearColor: [.5,.5,.5] }]]),
        limits: { pixels: 256, draws: 2, verticesPerPolygon: 10, submissions: 4 }, update }));
    const unchanged = make(planGroundPaintUpdate(options));
    assert.equal(unchanged.draws.length, 0);
    assert.equal(unchanged.stats.geometryBytes, 0);
    const incompatible = { ...previous, styles: captureGroundPaintStyles(new Map([['sidewalk', {
        ...previous.styles.recipes[0], roughness: .2,
    }]])) };
    assert.throws(() => make(planGroundPaintUpdate({ ...options, previous: incompatible })), /full repaint/,
        'retained style IDs cannot be reinterpreted through a changed table');
    const removal = make(planGroundPaintUpdate({ ...options,
        dirtyBounds: [{ minX: 1, minZ: 1, maxX: 2, maxZ: 2 }] }));
    assert.deepEqual(removal.draws.flatMap(draw => draw.sources.map(source => source.key)), ['source']);
    assert.ok(removal.draws[0].regions.length <= 4);
    assert.ok(removal.draws[0].regions.every(region => region.width * region.height <= 16));
});

test('malformed UV transforms and unresolved repeating texture inputs reject the complete page', () => {
    const p = planFor([{ outerRing: [{x:0,z:0},{x:1,z:0},{x:0,z:1}], holeRings: [] }]);
    const recipe = { id: 1, revision: 'm1', linearColor: [.5,.5,.5],
        albedoMap: { key: 'pavers', revision: 'bitmap:1', uvTransform: [1,0,0,0,1,0] } };
    for (const uvTransform of [[1,0,0], [1,0,NaN,0,1,0]]) {
        assert.throws(() => packet(p, new Map([['sidewalk', { ...recipe,
            albedoMap: { ...recipe.albedoMap, uvTransform } }]])), /albedo map/);
    }
    const out = packet(p, new Map([['sidewalk', recipe]]));
    const renderer = { isWebGLRenderer: true, capabilities: { maxTextureSize: 1024 }, initTexture() {} };
    const painter = createGroundPaintPagePainter({ renderer });
    assert.throws(() => painter.createTask({ packet: out }), /resolver/);
    const requests = [];
    assert.throws(() => painter.createTask({ packet: out,
        resolveAlbedoMap: (...args) => { requests.push(args); return { isTexture: true }; } }), /paint texture/);
    assert.deepEqual(requests, [['pavers', 'bitmap:1']], 'texture resolution includes its exact revision');
    painter.dispose();
});

test('page-local coordinates preserve precision at large world coordinates', () => {
    const r = { ...receiver, bounds: { minX: 100000, minZ: 100000, maxX: 100010, maxZ: 100010 } };
    const rr = { ...receiver, bounds: r.bounds };
    const p = run(createGroundCompositePlanSteps({ receiver: rr, records: [{ key: 's', sourceRevision: 's', materialRevision: 'm', materialKey: 'sidewalk', claim, receiver: rr, polygons: [{ outerRing: [{x:100000,z:100000},{x:100001,z:100000},{x:100000,z:100001}], holeRings: [] }] }], limits }));
    const out = run(createGroundPaintPacketSteps({ plan: p, bounds: r.bounds, size: 4, styles: new Map([['sidewalk',{id:1,revision:'m',surfaceClass:SURFACE_CLASS.SIDEWALK,roughness:.96,metalness:0,normalInfluence:0,linearColor:[1,0,0]}]]), limits: { pixels: 100, draws: 2, verticesPerPolygon: 10 } }));
    assert.deepEqual([...out.draws[0].positions], [0,0,0, 1,0,0, 0,1,0]);
});

test('style IDs are delivery-order independent and conflicts/revisions reject', () => {
    const p = planFor([{ outerRing: [{x:0,z:0},{x:1,z:0},{x:0,z:1}], holeRings: [] }]);
    const styles = new Map([['sidewalk',{id:7,revision:'m1',linearColor:[.1,.2,.3]}]]);
    assert.equal(packet(p, styles).draws[0].styleId, 7);
    assert.throws(() => packet(p, new Map([['sidewalk',{id:7,revision:'wrong',linearColor:[.1,.2,.3]}]])), /recipe/);
    assert.throws(() => packet(p, new Map([['sidewalk',{id:0,revision:'m1',linearColor:[.1,.2,.3]}]])), /recipe/);
});

test('two material classes retain independent recipes regardless of arrival order', () => {
    const records = ['a', 'b'].map((key, index) => ({ key, sourceRevision: key, materialRevision: 'm', materialKey: key, claim,
        receiver, polygons: [{ outerRing: [{x:index*2,z:0},{x:index*2+1,z:0},{x:index*2,z:1}], holeRings: [] }] }));
    const p = run(createGroundCompositePlanSteps({ receiver, records: records.reverse(), limits }));
    const out = packet(p, new Map([['a',{id:3,revision:'m',linearColor:[1,0,0]}],['b',{id:4,revision:'m',linearColor:[0,1,0]}]]));
    assert.deepEqual(out.draws.map(draw => draw.styleId), [3, 4]);
    const conflict = new Map([['a',{id:3,revision:'m',linearColor:[1,0,0]}],['b',{id:3,revision:'m',linearColor:[0,1,0]}]]);
    assert.throws(() => packet(p, conflict), /Conflicting/);
});

test('the actual 82/15-vertex Jelačić source triangulates its full area minus the hole', () => {
    const source = JSON.parse(readFileSync(new URL('./fixtures/ground-jelacic-source.json', import.meta.url)));
    const rings = source.road.feature.geometry.coordinates.map(ring => ring.map(([lon, lat]) => geoToLocal(lon, lat, 15.976903, 45.813215)));
    assert.deepEqual(rings.map(ring => ring.length), [82, 15]);
    const signedArea = ring => Math.abs(ring.reduce((sum, p, i) => {
        const next = ring[(i + 1) % ring.length]; return sum + p.x * next.z - next.x * p.z;
    }, 0)) / 2;
    const expected = signedArea(rings[0]) - signedArea(rings[1]);
    const r = { ...receiver, bounds: { minX: -500, minZ: -500, maxX: 500, maxZ: 500 } };
    const p = run(createGroundCompositePlanSteps({ receiver: r, records: [{ key: 'real', sourceRevision: 'fixture',
        materialRevision: 'm1', materialKey: 'sidewalk', claim, receiver: r,
        polygons: [{ outerRing: rings[0], holeRings: rings.slice(1) }] }], limits }));
    const out = run(createGroundPaintPacketSteps({ plan: p, bounds: r.bounds, size: 32,
        styles: new Map([['sidewalk', { id: 1, revision: 'm1', surfaceClass: SURFACE_CLASS.SIDEWALK, roughness: .96, metalness: 0, normalInfluence: 0, linearColor: [.5, .5, .5] }]]),
        limits: { pixels: 1024, draws: 2, verticesPerPolygon: 100 } }));
    assert.ok(expected > 100);
    assert.ok(Math.abs(area(out) - expected) / expected < 1e-6, `${area(out)} vs ${expected}`);
});

test('pixel, draw and polygon budgets reject without truncation', () => {
    const p = planFor([{ outerRing: [{x:0,z:0},{x:1,z:0},{x:0,z:1}], holeRings: [] }]);
    assert.throws(() => packet(p, undefined, { pixels: 1 }), /pixel/);
    assert.throws(() => packet(p, undefined, { draws: 0 }), /draw/);
    assert.throws(() => packet(planFor([{ outerRing: Array.from({length: 5}, (_,i) => ({x:i,z:i%2})), holeRings: [] }]), undefined, { verticesPerPolygon: 2 }), /item budget/);
});

test('same-command disjoint quads merge, while vertex cap and repaint-region splits keep draws separate', () => {
    const polygons = [0, 4].map(x => ({ outerRing: [{ x, z: 0 }, { x: x + 2, z: 0 }, { x: x + 2, z: 2 }, { x, z: 2 }], holeRings: [] }));
    const p = planFor(polygons);
    const merged = packet(p, undefined, { verticesPerPolygon: 8 });
    assert.equal(merged.draws.length, 1);
    assert.equal(merged.stats.triangles, 4);
    const split = packet(p, undefined, { verticesPerPolygon: 6 });
    assert.equal(split.draws.length, 2, 'merged draw respects the vertex cap');
    const dirty = planGroundPaintUpdate({ receiver, bounds: receiver.bounds, size: 16,
        dirtyBounds: [{ minX: 0, minZ: 0, maxX: 2, maxZ: 2 }] });
    const regionSplit = run(createGroundPaintPacketSteps({ plan: p, bounds: receiver.bounds, size: 16,
        styles: new Map([['sidewalk', { id: 1, revision: 'm1', surfaceClass: SURFACE_CLASS.SIDEWALK, roughness: .96, metalness: 0, normalInfluence: 0, linearColor: [.5, .5, .5] }]]),
        limits: { pixels: 1000, draws: 10, verticesPerPolygon: 100 }, update: dirty }));
    assert.ok(regionSplit.draws.length >= 1);
});

test('overlapping plaza and footway preserve fourteen holes and canonical paint order', () => {
    const r = { ...receiver, key: 'plaza-ground-proof', bounds: { minX: -150, minZ: -80, maxX: 150, maxZ: 100 } };
    const box = (x, z, width, depth) => [{ x, z }, { x: x + width, z },
        { x: x + width, z: z + depth }, { x, z: z + depth }, { x, z }];
    const footprints = [
        [box(-80, -50, 160, 110), ...Array.from({ length: 14 }, (_, i) =>
            box(-65 + (i % 7) * 20, -25 + Math.floor(i / 7) * 35, 4, 4))],
        [box(-90, 0, 180, 40)],
    ];
    const records = footprints.map((rings, index) => {
        const plaza = index === 0;
        return { key: plaza ? 'plaza' : 'footway',
            sourceRevision: 'geometry-v1', materialKey: plaza ? 'pavers' : 'buffered-pavers', materialRevision: 'proof-v1',
            receiver: r, claim: compileSurfaceClaim({ surfaceClass: plaza ? SURFACE_CLASS.SIDEWALK : SURFACE_CLASS.BUFFERED_SIDEWALK,
                coverageState: 'published', verticalBand: 'ground', verticalRelation: 'same-level' }),
            polygons: [{ outerRing: rings[0], holeRings: rings.slice(1) }] };
    });
    assert.equal(records[0].polygons[0].holeRings.length, 14);
    const prepare = sources => run(createGroundCompositePlanSteps({ receiver: r, records: sources,
        limits: { records: 2, vertices: 274, verticesPerRecord: 237, oversized: 2 } }));
    const plan = prepare(records), reversed = prepare([...records].reverse());
    for (const [x, z] of [[-56.5, 31.5], [32.5, 4.5]]) {
        assert.equal(plan.paintAt(x, z, r)?.key, records[0].key);
        assert.equal(reversed.paintAt(x, z, r)?.key, records[0].key);
    }
    const out = run(createGroundPaintPacketSteps({ plan, bounds: r.bounds, size: 32,
        styles: new Map([['pavers', { id: 1, revision: 'proof-v1', surfaceClass: SURFACE_CLASS.SIDEWALK, roughness: .96, metalness: 0, normalInfluence: 0, linearColor: [.5, .5, .5] }], ['buffered-pavers', { id: 2, revision: 'proof-v1', surfaceClass: SURFACE_CLASS.BUFFERED_SIDEWALK, roughness: .96, metalness: 0, normalInfluence: 0, linearColor: [.5, .5, .5] }]]),
        limits: { pixels: 1024, draws: 2, verticesPerPolygon: 237 } }));
    const ringArea = ring => Math.abs(ring.reduce((sum, p, i) => {
        const next = ring[(i + 1) % ring.length]; return sum + p.x * next.z - next.x * p.z;
    }, 0)) / 2;
    for (const record of records) {
        const polygon = record.polygons[0];
        const expected = ringArea(polygon.outerRing) - polygon.holeRings.reduce((sum, ring) => sum + ringArea(ring), 0);
        const draw = out.draws.find(draw => draw.sources.some(source => source.key === record.key));
        assert.ok(draw);
        const source = draw.sources.find(source => source.key === record.key);
        const indices = draw.indices.subarray(source.indexOffset, source.indexOffset + source.indexCount);
        assert.ok(Math.abs(area({ draws: [{ ...draw, indices }] }) - expected) / expected < 1e-5,
            `${record.key} triangle area must exclude its complete source hole set`);
    }
    assert.equal(plan.paintAt(32.5, 4.5, { ...r, key: 'unrelated-bridge-deck' }), null);
});
