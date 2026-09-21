// Shared passenger transport for model-authored lifts. Models expose only
// local handles; this layer owns registration, world placement and attachment.
import * as THREE from 'three';
import { geoToLocal, localToGeo } from '../core/math.js';
import { createLiftMotion, sampleLiftMotion } from '../core/lift-motion.js';
import { liftSoundCue } from '../core/lift-sound-cues.js';
import { playLiftDoorSound, playLiftArrivalSound, stopLiftSounds } from '../ui/lift-sfx.js';

function playSoundCue(cue, phase) {
    if (cue === 'arrival-chime') playLiftArrivalSound();
    else playLiftDoorSound({ phase });
}

const lifts = new Map();
const point = new THREE.Vector3();
const otherPoint = new THREE.Vector3();

export function registerModelLifts(root) {
    for (const lift of root?.userData?.lifts || []) {
        const previous = lifts.get(lift.id)?.lift;
        if (previous) {
            lift.cabin.position.y = previous.cabin.position.y;
            lift.doors.forEach((door, i) => { door.object.position.x = previous.doors[i].object.position.x; });
            for (const stop of lift.stops) {
                const old = previous.stops.find(item => item.id === stop.id);
                stop.doors?.forEach((door, i) => { door.object.position.x = old.doors[i].object.position.x; });
            }
        }
        lifts.set(lift.id, { root, lift });
    }
}

export function unregisterModelLifts(root) {
    for (const lift of root?.userData?.lifts || []) {
        if (lifts.get(lift.id)?.root === root) lifts.delete(lift.id);
    }
}

function worldPoint(root, x, y, z) {
    root.updateWorldMatrix(true, false);
    return root.localToWorld(point.set(x, y, z));
}

export function liftFloorYAt(x, z, walkerY) {
    for (const { root, lift } of lifts.values()) {
        root.updateWorldMatrix(true, false);
        // Highest-support queries use Infinity; passing it through a matrix
        // would contaminate X/Z with 0 * Infinity and match every footprint.
        const local = root.worldToLocal(point.set(x, Number.isFinite(walkerY) ? walkerY : 0, z));
        if (Math.abs(local.x - lift.cabin.position.x) > lift.widthM / 2
            || Math.abs(local.z - lift.cabin.position.z) > lift.depthM / 2) continue;
        const y = worldPoint(root, lift.cabin.position.x, lift.cabin.position.y, lift.cabin.position.z).y;
        if (y <= walkerY + 1.75) return y;
    }
    return null;
}

// Landing gates are moving geometry, separate from the static world collider
// index. Query just the registered lifts instead of rebuilding that index.
export function resolveLiftLandingMove(fromX, fromZ, toX, toZ, y) {
    for (const { root, lift } of lifts.values()) {
        root.updateWorldMatrix(true, false);
        const from = root.worldToLocal(point.set(fromX, y, fromZ));
        const to = root.worldToLocal(otherPoint.set(toX, y, toZ));
        const stop = lift.stops.find(item => Math.abs(item.y - from.y) < 1.75);
        if (!stop) continue;
        const normal = stop.doorNormal || { x: 0, z: 1 };
        const lateral = (to.x - lift.cabin.position.x) * normal.z
            - (to.z - lift.cabin.position.z) * normal.x;
        if (Math.abs(lateral) > lift.widthM / 2 + 0.35) continue;
        const gateDistance = lift.depthM / 2 + 0.1;
        const distance = p => (p.x - lift.cabin.position.x) * normal.x
            + (p.z - lift.cabin.position.z) * normal.z - gateDistance;
        const fromDistance = distance(from), toDistance = distance(to);
        const entering = fromDistance >= 0 && toDistance < 0.35;
        const leaving = fromDistance <= 0 && toDistance > -0.35;
        const doors = stop.doors || lift.doors;
        const open = doors.every(door => Math.abs(door.object.position.x - door.openX) < 0.1);
        if ((entering || leaving) && (!open || Math.abs(lift.cabin.position.y - stop.y) > 0.1)) {
            return { x: fromX, z: fromZ };
        }
    }
    return { x: toX, z: toZ };
}

export function createPassengerLiftRide({ liftId, fromStop, toStop, speedMps,
    walker, anchorLat, anchorLon, onSoundCue = playSoundCue }) {
    const entry = lifts.get(liftId);
    if (!entry) throw new Error(`Lift ${liftId} is not loaded.`);
    const from = entry.lift.stops.find(stop => stop.id === fromStop);
    const to = entry.lift.stops.find(stop => stop.id === toStop);
    if (!from || !to) throw new Error(`Unknown stop for lift ${liftId}.`);
    const motion = createLiftMotion({ fromY: from.y, toY: to.y, speedMps });
    const initialWorld = geoToLocal(walker.lon, walker.lat, anchorLon, anchorLat);
    entry.root.updateWorldMatrix(true, false);
    const initial = entry.root.worldToLocal(new THREE.Vector3(initialWorld.x, walker.y, initialWorld.z));
    if (Math.abs(initial.y - from.y) > 3
        || Math.hypot(initial.x - from.landing.x, initial.z - from.landing.z) > 6) {
        throw new Error(`Player is not at lift ${liftId}'s ${fromStop} landing.`);
    }
    let elapsedS = 0;
    let lastSoundPhase = null;
    let finished = false;
    let resolveFinished;
    const completed = new Promise(resolve => { resolveFinished = resolve; });
    let snapshot = { liftId, fromStop, toStop, phase: 'opening', floorY: from.y };
    return {
        completed,
        get snapshot() { return snapshot; },
        cancel() {
            if (finished) return;
            stopLiftSounds();
            // A retry/cancel returns to a real landing, never leaves the
            // released walker suspended halfway down an empty shaft.
            const live = lifts.get(liftId);
            if (live) {
                live.lift.cabin.position.y = from.y;
                const p = worldPoint(live.root, from.landing.x, from.y, from.landing.z);
                Object.assign(walker, localToGeo(p.x, p.z, anchorLon, anchorLat), { y: p.y, vy: 0 });
            }
            finished = true;
            resolveFinished(false);
        },
        step(dt) {
            if (finished) return null;
            const live = lifts.get(liftId);
            if (!live) { this.cancel(); return null; }
            elapsedS += Math.max(0, Number(dt) || 0);
            const sample = sampleLiftMotion(motion, elapsedS);
            if (sample.phase !== lastSoundPhase) {
                lastSoundPhase = sample.phase;
                const cue = liftSoundCue(sample.phase);
                if (cue) onSoundCue(cue, sample.phase);
            }
            const { cabin, doors } = live.lift;
            cabin.position.y = sample.floorY;
            const arriving = ['arrival-opening', 'exiting', 'done'].includes(sample.phase);
            const activeStopId = arriving ? to.id : from.id;
            for (const door of doors) {
                const open = !door.stopId || door.stopId === activeStopId ? sample.doorOpen : 0;
                door.object.position.x = door.closedX + (door.openX - door.closedX) * open;
            }
            for (const stop of live.lift.stops) {
                const atStop = Math.abs(stop.y - sample.floorY) < 0.001;
                for (const door of stop.doors || []) {
                    door.object.position.x = door.closedX
                        + (door.openX - door.closedX) * (atStop ? sample.doorOpen : 0);
                }
            }
            const landing = arriving ? to.landing : initial;
            const x = landing.x + (cabin.position.x - landing.x) * sample.passengerT;
            const z = landing.z + (cabin.position.z - landing.z) * sample.passengerT;
            const p = worldPoint(live.root, x, sample.floorY, z);
            Object.assign(walker, localToGeo(p.x, p.z, anchorLon, anchorLat), {
                y: p.y, vy: 0, airborne: false, parachute: false,
                initialGroundY: p.y, initialSupportLat: walker.lat,
                initialSupportLon: walker.lon, lastDetectedGroundY: p.y,
                floorGuardActive: false, groundMissSeconds: 0,
            });
            snapshot = { liftId, fromStop, toStop, ...sample, elapsedS, durationS: motion.durationS };
            if (sample.done) { finished = true; resolveFinished(true); }
            return {
                y: p.y, headingDeg: walker.yaw * 180 / Math.PI,
                supportReady: true, airborne: false, parachute: false,
                verticalSpeedMps: 0, horizontalDistM: 0, landed: false,
                impactSpeedMps: 0, jetpackHeld: false,
            };
        },
    };
}

export function nearestLiftLanding(x, z, y, radius = 4) {
    let nearest = null;
    let distance = radius;
    for (const { root, lift } of lifts.values()) {
        for (const stop of lift.stops) {
            const p = worldPoint(root, stop.landing.x, stop.y, stop.landing.z);
            const d = Math.hypot(x - p.x, z - p.z);
            if (Math.abs(y - p.y) > 2 || d > distance) continue;
            nearest = { id: lift.id, nameKey: 'world.lift', fromStop: stop.id,
                stops: lift.stops.filter(other => other.id !== stop.id).map(other => ({ id: other.id, y: other.y })),
                x: p.x, y: p.y, z: p.z };
            distance = d;
        }
    }
    return nearest;
}
