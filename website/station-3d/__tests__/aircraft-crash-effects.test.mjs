// Locks the shared airplane crash lifecycle: one real wreck transition gets a
// bounded visual/audio cue, while retries, retirement, and normal/ditch poses
// leave no stale transforms or scheduled sound behind.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createAirplaneMesh } from '../models/vehicles/boat-airplane.js';
import { BREAKUP_DURATION_S, createAirplaneBreakupController } from '../models/vehicles/airplane-breakup.js';
import { playAircraftCrashSfx, scheduleAircraftCrashSfx } from '../ui/aircraft-crash-sfx.js';
import { createAircraftCrashLifecycle } from '../core/aircraft-crash-lifecycle.js';

const PART_NAMES = [
    'GtaAirplaneRoundedMainWing',
    'GtaAirplaneRoundedTailplane',
    'GtaAirplaneRoundedFin',
    'GtaAirplaneLandingGear',
    'GtaAirplanePropeller',
];

function transform(object) {
    return [object.position.x, object.position.y, object.position.z,
        object.rotation.x, object.rotation.y, object.rotation.z];
}

test('aircraft breakup moves only existing detachable model roots, settles boundedly, and resets exactly', () => {
    const mesh = createAirplaneMesh();
    const fuselage = mesh.getObjectByName('GtaAirplaneTaperedFuselage');
    const parts = PART_NAMES.map(name => mesh.getObjectByName(name));
    const before = parts.map(transform);
    const fuselageBefore = transform(fuselage);
    const resources = () => {
        const result = [];
        mesh.traverse(object => result.push([
            object.uuid, object.geometry?.uuid, object.material?.uuid,
        ]));
        return result;
    };
    const resourcesBefore = resources();
    const breakup = createAirplaneBreakupController(mesh);

    assert.equal(breakup.advance(0), false, 'no movement at crash start');
    assert.equal(breakup.advance(BREAKUP_DURATION_S * 0.5), false);
    assert.notDeepEqual(transform(parts[0]), before[0], 'wing separates during the finite effect');
    assert.deepEqual(transform(fuselage), fuselageBefore, 'fuselage/cabin remains the core');
    assert.equal(breakup.advance(BREAKUP_DURATION_S * 5), true, 'long frames clamp at terminal state');
    const terminal = parts.map(transform);
    assert.deepEqual(resources(), resourcesBefore,
        'breakup adds no objects, geometry, materials, or additional draw calls');
    breakup.advance(BREAKUP_DURATION_S * 50);
    assert.deepEqual(parts.map(transform), terminal, 'terminal wreck has no continuing drift');
    // A later pose sync writes the propeller angle; the settled breakup must
    // reclaim its own terminal transform on the next wreck sync.
    parts.at(-1).rotation.z = 99;
    breakup.settle();
    assert.deepEqual(parts.map(transform), terminal, 'terminal propeller breakup survives pose synchronisation');
    breakup.reset();
    assert.deepEqual(parts.map(transform), before, 'retry restores all original submesh transforms');
});

function fakeAudioContext() {
    const nodes = [];
    const automation = () => ({
        value: 1,
        setValueAtTime(value, at) { this.value = value; this.setAt = at; },
        exponentialRampToValueAtTime(value, at) { this.rampTo = [value, at]; },
    });
    const node = (kind) => ({
        kind,
        connect(target) { this.target = target; return target; },
        disconnect() { this.disconnected = true; },
    });
    return {
        currentTime: 4,
        sampleRate: 100,
        nodes,
        createGain() { const value = { ...node('gain'), gain: automation() }; nodes.push(value); return value; },
        createOscillator() {
            const value = { ...node('oscillator'), frequency: automation(), start(at) { this.startedAt = at; }, stop(at) { this.stoppedAt = at; } };
            nodes.push(value); return value;
        },
        createBufferSource() {
            const value = { ...node('noise'), start(at) { this.startedAt = at; }, stop(at) { this.stoppedAt = at; } };
            nodes.push(value); return value;
        },
        createBuffer(channels, length, rate) {
            const data = new Float32Array(length);
            return { channels, length, rate, getChannelData: () => data };
        },
    };
}

test('procedural crash schedules one bounded thump/noise graph through its managed output and cleans it up', () => {
    const ctx = fakeAudioContext();
    const destination = { kind: 'managed-output' };
    const cue = scheduleAircraftCrashSfx(ctx, destination, { gain: 99 });
    assert.ok(cue);
    assert.equal(cue.durationS, 1.15);
    const output = ctx.nodes.find(node => node.kind === 'gain');
    const thump = ctx.nodes.find(node => node.kind === 'oscillator');
    const noise = ctx.nodes.find(node => node.kind === 'noise');
    assert.equal(output.target, destination, 'only the provided managed output is reached');
    assert.equal(thump.startedAt, 4);
    assert.equal(noise.startedAt, 4);
    assert.equal(thump.stoppedAt, 5.15);
    assert.equal(noise.stoppedAt, 5.15);
    assert.equal(output.gain.value, 0.28, 'gain is capped');
    cue.stop();
    assert.equal(thump.disconnected, true);
    assert.equal(noise.disconnected, true);
    assert.equal(output.disconnected, true);
    assert.equal(scheduleAircraftCrashSfx(null, destination), null);
});

test('crash audio drops muted or locked events instead of queueing a later explosion', () => {
    let contextRequests = 0;
    assert.equal(playAircraftCrashSfx({
        muted: () => true,
        createContext: () => { contextRequests += 1; return fakeAudioContext(); },
    }), null);
    assert.equal(contextRequests, 0, 'mute prevents context creation');
    assert.equal(playAircraftCrashSfx({
        muted: () => false,
        createContext: () => { contextRequests += 1; return null; },
    }), null);
    assert.equal(contextRequests, 1, 'locked event is dropped synchronously, with no unlock listener');
});

test('lifecycle starts one first-sync crash, keeps normal/ditch poses quiet, then resets for a new retry', () => {
    let timeMs = 0;
    let visualCount = 0;
    let soundPlays = 0;
    let soundCount = 0;
    const visuals = [];
    const lifecycle = createAircraftCrashLifecycle({
        wrecked: false,
        now: () => timeMs,
        createVisual: () => {
            visualCount += 1;
            const visual = {
                elapsed: [], resetCount: 0, settleCount: 0,
                advance(seconds) { this.elapsed.push(seconds); return seconds >= 1.7; },
                reset() { this.resetCount += 1; },
                settle() { this.settleCount += 1; },
            };
            visuals.push(visual);
            return visual;
        },
        playSound: () => {
            soundPlays += 1;
            return { stop() { soundCount += 1; } };
        },
    });

    assert.equal(lifecycle.sync(false), false, 'normal aircraft does not allocate effects');
    assert.equal(lifecycle.sync(false), false, 'a smooth ditch/no-wreck pose stays intact');
    assert.equal(visualCount, 0);
    assert.equal(lifecycle.sync(true), true, 'first sync can be the actual crash');
    assert.equal(lifecycle.sync(true), false, 'repeated wreck sync is idempotent');
    assert.equal(visualCount, 1);
    assert.equal(soundPlays, 1, 'first crash schedules one cue');
    assert.equal(soundCount, 0);
    // This is render time only; it advances despite a simultaneously paused physics dt of 0.
    timeMs = 1800;
    assert.equal(lifecycle.advance(), false, 'bounded cosmetic finishes on render time');
    assert.deepEqual(visuals[0].elapsed, [1.8]);
    assert.equal(soundCount, 1, 'completed cue is stopped once');
    lifecycle.sync(true);
    assert.equal(visuals[0].settleCount, 1, 'later pose sync restores settled parts, including propeller');
    lifecycle.sync(false);
    assert.equal(visuals[0].resetCount, 1, 'retry restores transforms');
    assert.equal(lifecycle.sync(true), true);
    assert.equal(visualCount, 2);
    assert.equal(soundPlays, 2, 'retry has exactly one new cue');
    lifecycle.dispose();
    assert.equal(visuals[1].resetCount, 1, 'retirement/session teardown clears a live retry');
    assert.equal(soundCount, 2, 'teardown stops the retry cue exactly once');
});

test('pre-existing wreck is silent and autonomous sync reaches the same shared lifecycle', async () => {
    let visualCount = 0;
    let soundCount = 0;
    const preexisting = createAircraftCrashLifecycle({
        wrecked: true,
        createVisual: () => ({ settle() { visualCount += 1; } }),
        playSound: () => { soundCount += 1; },
    });
    preexisting.settle();
    preexisting.sync(true);
    assert.equal(visualCount, 2);
    assert.equal(soundCount, 0, 'checkpoint wreck never replays a crash');

    const source = await readFile(new URL('../world/gta-special-vehicles.js', import.meta.url), 'utf8');
    assert.match(source, /createAircraftCrashLifecycle\(/);
    assert.match(source, /syncAircraftCrash\(vehicle\)/);
    assert.match(source, /stepGtaSpecialVehicle\(state, \{\}, seconds, specialVehicleEnvironment\);\s*syncVehicle\(/);
    assert.match(source, /advanceAircraftCrashEffects\(\);/);
    assert.match(source, /if \(activeAircraftCrashVehicles\.size === 0\) return/);
    assert.match(source, /stepAutonomousAircraft\(dt\);\s*advanceAircraftCrashEffects\(\);/);
    assert.match(source, /clearAircraftCrash\(vehicle\);\s*disposeGroup\(vehicle\.mesh\)/);
});
