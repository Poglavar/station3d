// Cab driving physics: a steady throttle must hold a steady cruise speed
// (rolling resistance balances the motor), instead of the old accelerate-then-
// coast limit cycle that surged the ride and pumped the autopilot throttle.
// Verified without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildDriverGraph,
    computeDriverPose,
    createDriverState,
    driverStep,
    DRIVER_TUNING,
    resnapDriverState,
} from '../modes/driver.js';

test('driver builds the exact rail graph without a host loading switch helpers', t => {
    const previousWindow = globalThis.window;
    globalThis.window = globalThis;
    t.after(() => {
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    });
    const line = coordinates => ({ type: 'Feature', geometry: { type: 'LineString', coordinates } });
    const graph = buildDriverGraph([
        line([[16.4388, 43.5049], [16.4398, 43.5049], [16.4408, 43.5049]]),
        line([[16.4398, 43.5049], [16.4398, 43.5059]]),
    ]);
    assert.equal(graph.nodes.length, 4);
    assert.equal(graph.edges.length, 3);
    const junction = graph.nodes.find(node => node.lng === 16.4398 && node.lat === 43.5049);
    assert.equal(junction.adj.length, 3);
});

// One very long straight edge: the train never reaches its end, so the graph
// advance and the curve speed-limit stay trivial and we isolate the speed
// integration.
const straightGraph = { edges: [{ a: 'n0', b: 'n1', length: 1e6, bearing: 90 }], nodes: {} };

function run(ds, steps, dt = 1 / 60) {
    for (let i = 0; i < steps; i++) driverStep(ds, straightGraph, null, dt);
    return ds.speed;
}

function driverAt(speed, throttle) {
    const ds = createDriverState({ edgeId: 0, direction: 1, t: 0 }, speed);
    ds.throttle = throttle;
    ds.throttleTarget = throttle;
    return ds;
}

// Speed where a given throttle balances rolling resistance: motor = drag.
function equilibrium(throttle) {
    return Math.sqrt((throttle * DRIVER_TUNING.accel - DRIVER_TUNING.coast) / DRIVER_TUNING.coastDragPerV2);
}

test('a steady throttle holds a steady cruise speed (a real equilibrium, no surge)', () => {
    const T = 0.15;
    const vEq = equilibrium(T);
    assert.ok(vEq < DRIVER_TUNING.maxSpeedKmh / 3.6 - 2, 'a partial-throttle equilibrium exists below max');
    // Start AT the equilibrium: a correct model holds it; the old one (no
    // resistance under throttle) would accelerate away to the max cap.
    const held = run(driverAt(vEq, T), 3000);   // ~50 s
    assert.ok(Math.abs(held - vEq) < 0.3, `equilibrium not held: ${vEq.toFixed(2)} -> ${held.toFixed(2)}`);
});

test('more throttle holds a higher equilibrium; full throttle caps at max', () => {
    const vLow = run(driverAt(equilibrium(0.15), 0.15), 2000);
    const vHigh = run(driverAt(equilibrium(0.22), 0.22), 2000);
    assert.ok(vHigh > vLow + 1, `more throttle should hold faster: ${vLow.toFixed(2)} vs ${vHigh.toFixed(2)}`);
    const vFull = run(driverAt(0, 1), 4000);
    assert.ok(Math.abs(vFull - DRIVER_TUNING.maxSpeedKmh / 3.6) < 0.3, `full throttle should cap at max: ${vFull}`);
});

test('coasting decelerates to a clean stop, not a jitter around zero', () => {
    const ds = driverAt(5, 0);   // coasting from 5 m/s
    run(ds, 8000);               // long coast
    assert.equal(ds.speed, 0, `coast did not settle to a clean 0: ${ds.speed}`);
});

function refreshGraph({ lat = 45, lon = 15 } = {}) {
    return {
        edges: [{
            id: 0,
            lineIdx: 0,
            lat1: lat,
            lng1: lon,
            lat2: lat,
            lng2: lon + 0.001,
            bearing: 90,
            length: 78,
            a: 0,
            b: 1,
        }],
        nodes: [{ id: 0, adj: [] }, { id: 1, adj: [] }],
    };
}

test('streamed graph replacement preserves signed motion and manual controls', () => {
    const previous = refreshGraph();
    const next = refreshGraph({ lat: 45.00001 });
    const driver = createDriverState({ edgeId: 0, direction: -1, t: 0.45 }, 4);
    driver.speed = -4;
    driver.throttle = 0.3;
    driver.throttleTarget = -0.25;
    driver.armedTurn = 'left';
    driver.autopilot = true;
    const replacement = resnapDriverState(driver, previous, next, 60);
    assert.ok(replacement);
    assert.equal(replacement.speed, -4);
    assert.equal(replacement.throttle, 0.3);
    assert.equal(replacement.throttleTarget, -0.25);
    assert.equal(replacement.armedTurn, 'left');
    assert.equal(replacement.autopilot, true);
});

test('failed streamed graph replacement retains the current controller state', () => {
    const current = refreshGraph();
    const farAway = refreshGraph({ lat: 46, lon: 16 });
    const driver = createDriverState({ edgeId: 0, direction: 1, t: 0.5 }, 7);
    assert.equal(resnapDriverState(driver, current, farAway, 60), null);
    assert.equal(driver.speed, 7);
    assert.equal(driver.edgeId, 0);
    assert.equal(driver.t, 0.5);
});

test('manual driver graph preserves an authored photo height and grade in both directions', () => {
    const previousWindow = globalThis.window;
    globalThis.window = {
        TramSwitchUtils: {
            buildExactGraph: () => ({
                edges: [{
                    id: 0,
                    lineIdx: 0,
                    lat1: 43.5,
                    lng1: 16.4,
                    lat2: 43.5,
                    lng2: 16.401,
                    bearing: 90,
                    length: 80,
                    a: 0,
                    b: 1,
                }],
                nodes: [{ id: 0, adj: [] }, { id: 1, adj: [] }],
            }),
        },
    };
    try {
        for (const elevationDatum of ['asl', 'EVRF2000']) {
            const graph = buildDriverGraph([{
                type: 'Feature',
                properties: {
                    elevationDatum,
                    ...(elevationDatum === 'EVRF2000' ? { elevationMode: 'absolute' } : {}),
                },
                geometry: {
                    type: 'LineString',
                    coordinates: [[16.4, 43.5, -2], [16.401, 43.5, 6]],
                },
            }]);
            const forward = computeDriverPose(
                { edgeId: 0, direction: 1, t: 0.25, speed: 0, speedLimit: 1 },
                graph,
            );
            assert.equal(forward.y, 0);
            assert.equal(forward.elevationDatum, elevationDatum);
            assert.equal(
                forward.elevationMode,
                elevationDatum === 'EVRF2000' ? 'absolute' : null,
            );
            assert.ok(Math.abs(forward.pitchDeg - Math.atan2(8, 80) * 180 / Math.PI) < 1e-12);

            const reverse = computeDriverPose(
                { edgeId: 0, direction: -1, t: 0.25, speed: 0, speedLimit: 1 },
                graph,
            );
            assert.equal(reverse.y, 0);
            assert.equal(reverse.pitchDeg, -forward.pitchDeg);
        }
    } finally {
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    }
});

test('manual train poses sample every car along the graph instead of forming a rigid stick', () => {
    const graph = {
        edges: [
            {
                id: 0,
                lineIdx: 0,
                a: 'west',
                b: 'corner',
                lat1: 45,
                lng1: 15,
                lat2: 45,
                lng2: 15.0005,
                bearing: 90,
                length: 40,
            },
            {
                id: 1,
                lineIdx: 0,
                a: 'corner',
                b: 'north',
                lat1: 45,
                lng1: 15.0005,
                lat2: 45.0005,
                lng2: 15.0005,
                bearing: 0,
                length: 40,
            },
        ],
        nodes: {
            west: { adj: [{ edgeId: 0, other: 'corner' }] },
            corner: {
                adj: [
                    { edgeId: 0, other: 'west' },
                    { edgeId: 1, other: 'north' },
                ],
            },
            north: { adj: [{ edgeId: 1, other: 'corner' }] },
        },
    };
    const driver = {
        edgeId: 1,
        direction: 1,
        t: 0.3,
        speed: 0,
        speedLimit: 20,
        throttle: 0,
        armedTurn: 'straight',
    };
    const pose = computeDriverPose(driver, graph, {
        articulatedCarOffsetsM: [23.735, 0, -23.735],
    });

    assert.equal(pose.articulatedCars.length, 3);
    assert.deepEqual(
        pose.articulatedCars.map(car => car.headingDeg),
        [0, 0, 90],
        'the rear car should still follow the incoming leg of the curve',
    );
    assert.ok(pose.articulatedCars[0].lat > pose.articulatedCars[1].lat);
    assert.equal(pose.articulatedCars[2].lat, 45);
    assert.ok(pose.articulatedCars[2].lon < pose.articulatedCars[1].lon);
    assert.deepEqual(
        { edgeId: driver.edgeId, direction: driver.direction, t: driver.t },
        { edgeId: 1, direction: 1, t: 0.3 },
        'sampling the consist must not move the live controller',
    );
});
