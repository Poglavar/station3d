// Exercise the real layer lifecycle and rope factory behind controllable
// shader readiness, including paused streaming and session cancellation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { createLayerStartupCoordinator } from '../core/layer-startup.js';

function fixture() {
    const source = readFileSync(new URL('../world/gta-special-vehicles.js', import.meta.url), 'utf8');
    const functions = ['createMooringRope', 'startMooringShaderWarmup'].map(name => {
        const start = source.indexOf(`function ${name}(`);
        assert.ok(start >= 0, `production ${name} exists`);
        return source.slice(start, source.indexOf('\n}', start) + 2);
    }).join('\n');
    const lifecycle = source.slice(source.indexOf('export const gtaSpecialVehiclesLayer ='))
        .replace('export const gtaSpecialVehiclesLayer =', 'globalThis.layer =');
    const scene = new THREE.Scene(), warmups = [], errors = [];
    let now = 0, boats = 0, aircraft = 0, authored = 0;
    const context = {
        THREE, scene, camera: {}, renderer: {}, performance: { now: () => now },
        console: { error: (...args) => errors.push(args) },
        SESSION_CAPABILITY: { AIRCRAFT: 'aircraft', BOATS: 'boats' },
        sessionCapabilityEnabled: (capabilities, kind) => capabilities[kind] === true,
        preloadAircraftModels: async () => {},
        createLayerStartupCoordinator: options => createLayerStartupCoordinator({ ...options, now: () => now }),
        mooringShaderStartup: null, mooringShaderWarmup: null, sessionGeneration: 0,
        terrainUnsubscribe: null, terrainReference: null, boatsEnabled: false, aircraftEnabled: false,
        specialVehiclesGroup: null, enabled: false, anchorLat: 0, anchorLon: 0,
        boatSpawnAnchors: [], aircraftSpawnAnchors: [], nextSpawnCheckMs: 0, lastRenderNowMs: 0,
        vehicles: new Map(), activeAircraftCrashVehicles: new Set(), retiredVehicleIds: new Set(),
        SPAWN_CHECK_SECONDS: .75,
        ensureAuthoredAircraft() { authored++; }, ensureAircraft() { aircraft++; },
        ensureBoats() { boats++; }, stepAutonomousAircraft() {}, advanceAircraftCrashEffects() {},
        spinIdleAircraftPropellers() {}, retireDistantVehicles() {}, refreshUnclaimedTerrainPlacements() {},
        createQueuedShaderWarmup(root, options) {
            assert.equal(root.parent, null);
            assert.equal(options.targetScene, scene);
            const rope = root.children[0];
            assert.equal(rope.type, 'Line');
            assert.equal(rope.material.type, 'LineBasicMaterial');
            assert.equal(rope.geometry.attributes.position.count, 2);
            let finish, release;
            const fence = new Promise(resolve => { release = resolve; });
            let disposedGeometry = 0;
            rope.geometry.addEventListener('dispose', () => { disposedGeometry++; });
            const state = {
                root, ready: false, error: null, closed: false, disposed: 0, fenceHeld: false,
                completion: new Promise(resolve => { finish = resolve; }), release,
                succeed() { this.ready = true; root.clear(); finish(this); },
                fail() { this.error = new Error('mooring shader fixture failure'); finish(this); },
                dispose() {
                    if (!this.closed) { this.closed = true; this.ready = false; this.disposed++; finish(this); }
                    return this.fenceHeld ? fence : Promise.resolve();
                },
                disposedGeometry: () => disposedGeometry,
            };
            warmups.push(state);
            return state;
        },
    };
    runInNewContext(functions + '\n' + lifecycle, context);
    return { layer: context.layer, scene, warmups, errors,
        begin: (capabilities = { boats: true, aircraft: true }) => context.layer.beginSession({ sessionCapabilities: capabilities }),
        frame(at) { now = at; context.layer.onFrame(null, { x: 0, z: 0 }, 0); },
        counts: () => ({ boats, aircraft, authored }),
        async flush() { for (let n = 0; n < 8; n++) await Promise.resolve(); },
    };
}

test('late boats wait for their exact line shader while authored aircraft remain immediately available', async () => {
    const f = fixture();
    try {
        await f.begin();
        assert.equal(f.counts().authored, 1);
        assert.equal(f.warmups.length, 1);
        assert.equal(f.scene.children.length, 1);
        assert.equal(f.scene.children[0].children.length, 0, 'the warmup line stays detached');
        f.frame(0);
        assert.equal(f.counts().boats, 0);
        assert.equal(f.counts().aircraft, 1, 'independent aircraft publication is not blocked');
        f.warmups[0].succeed(); await f.flush();
        assert.equal(f.warmups[0].disposedGeometry(), 1);
        assert.equal(f.warmups[0].disposed, 0, 'retain the ready program until the session ends');
        f.frame(750);
        assert.equal(f.counts().boats, 1, 'water arriving while paused can still publish boats');
    } finally { f.layer.endSession(); await f.flush(); }
    assert.equal(f.warmups[0].disposed, 1);
});

test('shader failure retries with backoff during pause and never exposes a cold rope', async () => {
    const f = fixture();
    try {
        await f.begin({ boats: true });
        f.warmups[0].fail(); await f.flush();
        assert.equal(f.errors.length, 1);
        f.frame(999);
        assert.equal(f.warmups.length, 1);
        assert.equal(f.counts().boats, 0);
        f.frame(1000);
        assert.equal(f.warmups.length, 2);
        assert.equal(f.warmups[0].disposed, 1);
        f.warmups[1].succeed(); await f.flush();
        f.frame(1750);
        assert.equal(f.counts().boats, 1);
    } finally { f.layer.endSession(); await f.flush(); }
});

test('session cancellation retains proxy geometry through the shader fence and cannot revive an old startup', async () => {
    const f = fixture();
    await f.begin({ boats: true });
    const old = f.warmups[0];
    old.fenceHeld = true;
    f.layer.endSession(); await f.flush();
    assert.equal(old.disposedGeometry(), 0);
    await f.begin({ boats: true });
    old.release(); await f.flush();
    assert.equal(old.disposedGeometry(), 1);
    assert.equal(f.warmups[1].disposed, 0);
    f.frame(2000);
    assert.equal(f.counts().boats, 0);
    f.layer.endSession(); await f.flush();
});

test('a session without boats starts no mooring shader work', async () => {
    const f = fixture();
    await f.begin({ aircraft: true });
    assert.equal(f.warmups.length, 0);
    assert.equal(f.counts().authored, 1);
    f.layer.endSession();
});
