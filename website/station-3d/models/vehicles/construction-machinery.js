// Construction machines for the tower's building site: tracked excavators,
// three-axle tipper trucks, a bulldozer, concrete mixer trucks and a flat-top
// tower crane. Each machine is a few rigid parts, and each part is one merged,
// vertex-coloured geometry in its own joint frame, so a whole site draws every
// excavator boom (or truck bed, or crane mast section) as one instanced mesh.
// The compose functions turn a consumer-supplied pose into part matrices in
// the machine's frame; the preview group uses the same ones.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
    BULLDOZER_RIG,
    DUMP_TRUCK_RIG,
    EXCAVATOR_RIG,
    MIXER_TRUCK_RIG,
    TOWER_CRANE_RIG,
} from './construction-machinery-rig.js';

const YELLOW = 0xf2b705;
const DEEP_YELLOW = 0xc98f00;
const STEEL = 0x2c2f33;
const BARE_STEEL = 0x8a8d90;
const RUBBER = 0x1b1b1b;
const GLASS = 0x33414d;
const TRUCK_CAB = 0xe0662a;
const TRUCK_BED = 0xe39a1c;
const MIXER_CAB = 0xe9e9e4;
const MIXER_STRIPE = 0xc8342a;
const MIXER_DRUM = 0xf08a24;
const EARTH = 0x6b5037;
const CONCRETE = 0x9a968c;
const REBAR = 0x7a4a2a;

const HALF_PI = Math.PI / 2;

function paint(geometry, hex) {
    const colour = new THREE.Color(hex);
    const count = geometry.getAttribute('position').count;
    const colours = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) {
        colours[index * 3] = colour.r;
        colours[index * 3 + 1] = colour.g;
        colours[index * 3 + 2] = colour.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    return geometry;
}

function place(geometry, position, rotation) {
    if (rotation) geometry.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rotation)));
    geometry.translate(position[0], position[1], position[2]);
    return geometry;
}

function box(width, height, depth, hex, position = [0, 0, 0], rotation = null) {
    return paint(place(new THREE.BoxGeometry(width, height, depth), position, rotation), hex);
}

function cylinder(radiusTop, radiusBottom, height, segments, hex, position = [0, 0, 0], rotation = null) {
    return paint(place(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments), position, rotation), hex);
}

// A square-section member from one point to another.
function beam(from, to, thickness, hex) {
    const start = new THREE.Vector3(...from);
    const end = new THREE.Vector3(...to);
    const geometry = new THREE.BoxGeometry(thickness, start.distanceTo(end), thickness);
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        end.clone().sub(start).normalize(),
    ));
    const middle = start.add(end).multiplyScalar(0.5);
    geometry.translate(middle.x, middle.y, middle.z);
    return paint(geometry, hex);
}

// A wheel whose axle runs along X.
function wheel(x, y, z, radius, width) {
    return [
        cylinder(radius, radius, width, 14, RUBBER, [x, y, z], [0, 0, HALF_PI]),
        cylinder(radius * 0.42, radius * 0.42, width + 0.02, 8, BARE_STEEL, [x, y, z], [0, 0, HALF_PI]),
    ];
}

function merged(parts) {
    const geometry = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    if (!geometry) throw new Error('Construction machine parts could not be merged.');
    return geometry;
}

function excavatorTracks() {
    const { trackHeightM: height, trackLengthM: length, trackWidthM: width } = EXCAVATOR_RIG;
    const parts = [
        box(1.6, 0.55, length - 1.2, STEEL, [0, 0.62, 0]),
        cylinder(1.0, 1.0, 0.1, 18, STEEL, [0, height - 0.05, 0]),
    ];
    for (const side of [-1, 1]) {
        const x = side * (width / 2 - 0.36);
        parts.push(
            box(0.72, height, length - height, RUBBER, [x, height / 2, 0]),
            cylinder(height / 2, height / 2, 0.72, 12, RUBBER, [x, height / 2, (length - height) / 2], [0, 0, HALF_PI]),
            cylinder(height / 2, height / 2, 0.72, 12, RUBBER, [x, height / 2, -(length - height) / 2], [0, 0, HALF_PI]),
            box(0.2, 0.3, length - 1.4, DEEP_YELLOW, [side * (width / 2 - 0.82), 0.62, 0]),
        );
    }
    return merged(parts);
}

// House frame: origin on the slewing ring, +Z towards the boom.
function excavatorHouse() {
    const { boomPivot } = EXCAVATOR_RIG;
    return merged([
        box(2.7, 1.15, 3.0, YELLOW, [0, 0.62, -0.45]),
        box(2.7, 0.95, 0.75, DEEP_YELLOW, [0, 0.55, -2.25]),
        box(0.95, 1.7, 1.6, YELLOW, [0.85, 1.05, 0.95]),
        box(0.86, 1.05, 0.04, GLASS, [0.85, 1.35, 1.76]),
        box(0.04, 0.85, 1.2, GLASS, [1.33, 1.38, 0.95]),
        box(0.7, 0.75, 0.9, DEEP_YELLOW, [boomPivot.x, boomPivot.y - 0.3, boomPivot.z - 0.2]),
        cylinder(0.07, 0.07, 0.55, 6, STEEL, [-0.95, 1.45, -1.3]),
    ]);
}

// Boom frame: origin on the hinge, the tip at +Z boomLengthM.
function excavatorBoom() {
    const length = EXCAVATOR_RIG.boomLengthM;
    return merged([
        beam([0, 0, 0], [0, 0.8, length * 0.5], 0.56, YELLOW),
        beam([0, 0.8, length * 0.5], [0, 0, length], 0.5, YELLOW),
        beam([0, -0.45, 0.3], [0, 0.25, length * 0.45], 0.16, BARE_STEEL),
        cylinder(0.2, 0.2, 0.62, 10, STEEL, [0, 0, length], [0, 0, HALF_PI]),
    ]);
}

function excavatorStick() {
    const length = EXCAVATOR_RIG.stickLengthM;
    return merged([
        beam([0, 0.1, -0.45], [0, 0, length], 0.42, YELLOW),
        beam([0, 0.48, -0.4], [0, 0.34, length * 0.5], 0.14, BARE_STEEL),
        cylinder(0.16, 0.16, 0.5, 10, STEEL, [0, 0, length], [0, 0, HALF_PI]),
    ]);
}

// The bucket's opening faces -Y at pitch 0; its teeth sit bucketLengthM out.
function excavatorBucket() {
    const length = EXCAVATOR_RIG.bucketLengthM;
    return merged([
        box(0.95, 0.72, length * 0.8, STEEL, [0, -0.12, length * 0.45]),
        box(0.99, 0.1, length * 0.6, DEEP_YELLOW, [0, 0.26, length * 0.42]),
        box(0.95, 0.08, 0.26, BARE_STEEL, [0, -0.46, length * 0.93]),
    ]);
}

function dumpTruckChassis() {
    const { lengthM: length } = DUMP_TRUCK_RIG;
    const front = length / 2;
    return merged([
        box(1.1, 0.45, length - 0.6, STEEL, [0, 0.95, -0.1]),
        box(2.35, 1.5, 1.7, TRUCK_CAB, [0, 2.05, front - 1.0]),
        box(2.37, 0.62, 1.1, GLASS, [0, 2.35, front - 0.9]),
        box(2.05, 0.66, 0.04, GLASS, [0, 2.36, front - 0.13]),
        box(2.3, 0.55, 0.55, TRUCK_CAB, [0, 1.12, front - 0.4]),
        box(2.45, 0.32, 0.25, STEEL, [0, 0.72, front - 0.05]),
        box(0.5, 0.5, 1.0, STEEL, [-0.95, 1.0, 1.3]),
        ...wheel(-1.0, 0.55, front - 1.2, 0.55, 0.45),
        ...wheel(1.0, 0.55, front - 1.2, 0.55, 0.45),
        ...wheel(-1.0, 0.55, -1.7, 0.55, 0.6),
        ...wheel(1.0, 0.55, -1.7, 0.55, 0.6),
        ...wheel(-1.0, 0.55, -3.05, 0.55, 0.6),
        ...wheel(1.0, 0.55, -3.05, 0.55, 0.6),
    ]);
}

// Bed frame: origin on the rear hinge, the bed reaching forward along +Z.
function dumpTruckBed() {
    const { bedLengthM: length, bedWidthM: width, bedSideHeightM: side } = DUMP_TRUCK_RIG;
    return merged([
        box(width, 0.16, length, TRUCK_BED, [0, 0.08, length / 2]),
        box(0.1, side, length, TRUCK_BED, [-width / 2 + 0.05, side / 2 + 0.1, length / 2]),
        box(0.1, side, length, TRUCK_BED, [width / 2 - 0.05, side / 2 + 0.1, length / 2]),
        box(width, side + 0.3, 0.12, TRUCK_BED, [0, (side + 0.3) / 2 + 0.05, length - 0.06]),
        box(width, 0.1, 0.8, TRUCK_BED, [0, side + 0.35, length + 0.35]),
        box(0.14, 0.1, length, STEEL, [-width / 2 + 0.05, side + 0.12, length / 2]),
        box(0.14, 0.1, length, STEEL, [width / 2 - 0.05, side + 0.12, length / 2]),
    ]);
}

function dumpTruckLoad() {
    const { bedLengthM: length, bedWidthM: width, bedSideHeightM: side } = DUMP_TRUCK_RIG;
    return merged([
        box(width - 0.22, side * 0.7, length - 0.5, EARTH, [0, side * 0.45, length / 2]),
        box(width - 0.7, 0.45, length - 1.9, EARTH, [0, side * 0.9 + 0.1, length / 2]),
    ]);
}

const CRANE_YELLOW = 0xf5c400;
const BALLAST = 0x7d7a73;

function bulldozerBody() {
    const { lengthM: length, widthM: width, bladeZ } = BULLDOZER_RIG;
    const parts = [
        box(width - 1.2, 0.7, length - 1.0, YELLOW, [0, 0.95, -0.1]),
        box(1.3, 0.9, 1.7, YELLOW, [0, 1.75, 0.7]),
        box(1.7, 1.5, 1.4, YELLOW, [0, 2.05, -1.0]),
        box(1.72, 0.8, 1.2, GLASS, [0, 2.3, -1.0]),
        box(1.9, 0.12, 1.6, DEEP_YELLOW, [0, 2.86, -1.0]),
        cylinder(0.07, 0.07, 0.6, 6, STEEL, [0.4, 2.45, 1.2]),
        box(0.22, 0.9, 0.22, STEEL, [0, 0.55, -length / 2 + 0.05]),
    ];
    for (const side of [-1, 1]) {
        const x = side * (width / 2 - 0.3);
        parts.push(
            box(0.6, 0.9, length - 1.3, RUBBER, [x, 0.45, -0.15]),
            cylinder(0.45, 0.45, 0.6, 12, RUBBER, [x, 0.45, (length - 1.3) / 2 - 0.15], [0, 0, HALF_PI]),
            cylinder(0.45, 0.45, 0.6, 12, RUBBER, [x, 0.45, -(length - 1.3) / 2 - 0.15], [0, 0, HALF_PI]),
            beam([side * (width / 2 - 0.2), 0.7, 0.6], [side * (width / 2 - 0.1), 0.5, bladeZ - 0.2], 0.22, DEEP_YELLOW),
        );
    }
    return merged(parts);
}

// Blade frame: the cutting edge on the ground, its face towards +Z.
function bulldozerBlade() {
    const width = BULLDOZER_RIG.bladeWidthM;
    return merged([
        box(width, 1.2, 0.25, YELLOW, [0, 0.62, 0.1]),
        box(width - 0.2, 0.9, 0.12, DEEP_YELLOW, [0, 0.62, -0.08]),
        box(width, 0.12, 0.3, BARE_STEEL, [0, 0.06, 0.15]),
    ]);
}

function mixerTruckChassis() {
    const front = MIXER_TRUCK_RIG.lengthM / 2;
    return merged([
        box(1.1, 0.45, MIXER_TRUCK_RIG.lengthM - 0.5, STEEL, [0, 0.95, -0.1]),
        box(2.35, 1.55, 1.8, MIXER_CAB, [0, 2.05, front - 0.95]),
        box(2.37, 0.18, 1.82, MIXER_STRIPE, [0, 1.55, front - 0.95]),
        box(2.37, 0.62, 1.1, GLASS, [0, 2.4, front - 0.85]),
        box(2.05, 0.66, 0.04, GLASS, [0, 2.36, front - 0.03]),
        box(2.45, 0.32, 0.25, STEEL, [0, 0.72, front - 0.05]),
        box(1.6, 1.3, 0.35, STEEL, [0, 1.75, 1.3]),
        box(1.6, 1.05, 0.35, STEEL, [0, 1.65, -3.2]),
        beam([0, 2.2, -3.6], [0, 1.45, -4.55], 0.32, BARE_STEEL),
        cylinder(0.32, 0.32, 1.4, 10, MIXER_CAB, [0.95, 1.35, 0.6], [HALF_PI, 0, 0]),
        ...wheel(-1.0, 0.55, front - 1.25, 0.55, 0.45),
        ...wheel(1.0, 0.55, front - 1.25, 0.55, 0.45),
        ...wheel(-1.0, 0.55, -1.6, 0.55, 0.6),
        ...wheel(1.0, 0.55, -1.6, 0.55, 0.6),
        ...wheel(-1.0, 0.55, -2.95, 0.55, 0.6),
        ...wheel(1.0, 0.55, -2.95, 0.55, 0.6),
    ]);
}

// Drum frame: its axis along Z through the pivot, the charging opening at -Z.
// Painted with two white spiral bands, so its turning shows from far away.
function mixerTruckDrum() {
    const radius = MIXER_TRUCK_RIG.drumRadiusM;
    const front = new THREE.CylinderGeometry(radius * 0.48, radius, 1.9, 20, 5);
    front.applyMatrix4(new THREE.Matrix4().makeRotationX(HALF_PI));
    front.translate(0, 0, 0.95);
    const rear = new THREE.CylinderGeometry(radius, radius * 0.4, 2.5, 20, 6);
    rear.applyMatrix4(new THREE.Matrix4().makeRotationX(HALF_PI));
    rear.translate(0, 0, -1.25);
    const orange = new THREE.Color(MIXER_DRUM);
    const white = new THREE.Color(MIXER_CAB);
    for (const geometry of [front, rear]) {
        const position = geometry.getAttribute('position');
        const colours = new Float32Array(position.count * 3);
        for (let index = 0; index < position.count; index += 1) {
            const turn = Math.atan2(position.getY(index), position.getX(index)) / (Math.PI * 2);
            const band = ((turn * 2 + position.getZ(index) * 0.3) % 1 + 1) % 1 < 0.24;
            const colour = band ? white : orange;
            colours[index * 3] = colour.r;
            colours[index * 3 + 1] = colour.g;
            colours[index * 3 + 2] = colour.b;
        }
        geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    }
    return merged([front, rear]);
}

function cranePad() {
    const { padSizeM: size, padHeightM: height } = TOWER_CRANE_RIG;
    const parts = [box(size, height, size, CONCRETE, [0, height / 2, 0])];
    for (const x of [-1, 1]) {
        for (const z of [-1, 1]) parts.push(box(1.3, 0.8, 1.3, BALLAST, [x * 2.1, height + 0.4, z * 2.1]));
    }
    return merged(parts);
}

// One lattice section, origin at the middle of its foot.
function craneMastSection() {
    const { mastSectionM: height, mastWidthM: width } = TOWER_CRANE_RIG;
    const half = width / 2 - 0.08;
    const corners = [[-half, -half], [half, -half], [half, half], [-half, half]];
    const parts = corners.map(([x, z]) => box(0.16, height, 0.16, CRANE_YELLOW, [x, height / 2, z]));
    corners.forEach(([x, z], index) => {
        const [nextX, nextZ] = corners[(index + 1) % corners.length];
        parts.push(
            beam([x, 0.08, z], [nextX, 0.08, nextZ], 0.09, CRANE_YELLOW),
            beam([x, 0.1, z], [nextX, height / 2, nextZ], 0.08, CRANE_YELLOW),
            beam([nextX, height / 2, nextZ], [x, height - 0.1, z], 0.08, CRANE_YELLOW),
        );
    });
    return merged(parts);
}

// Head frame: on top of the mast, slewing about Y; the jib along +Z.
function craneHead() {
    const { jibLengthM: jib, counterJibLengthM: counter } = TOWER_CRANE_RIG;
    const parts = [
        box(2.4, 1.2, 2.4, CRANE_YELLOW, [0, 0.6, 0]),
        box(1.4, 1.9, 1.8, CRANE_YELLOW, [1.65, 0.35, 1.1]),
        box(1.42, 0.85, 1.4, GLASS, [1.65, 0.65, 1.2]),
        beam([-0.8, 1.25, 1.2], [-0.8, 1.25, jib], 0.14, CRANE_YELLOW),
        beam([0.8, 1.25, 1.2], [0.8, 1.25, jib], 0.14, CRANE_YELLOW),
        beam([0, 2.7, 1.2], [0, 2.7, jib - 1.5], 0.14, CRANE_YELLOW),
        beam([-0.9, 1.25, -1.2], [-0.9, 1.25, -counter], 0.16, CRANE_YELLOW),
        beam([0.9, 1.25, -1.2], [0.9, 1.25, -counter], 0.16, CRANE_YELLOW),
        box(1.8, 0.08, counter - 1.4, STEEL, [0, 1.32, -(counter + 1.2) / 2]),
    ];
    for (let z = 1.2; z < jib - 1.5; z += 3) {
        parts.push(
            beam([-0.8, 1.25, z], [0, 2.7, z + 1.5], 0.08, CRANE_YELLOW),
            beam([0, 2.7, z + 1.5], [-0.8, 1.25, z + 3], 0.08, CRANE_YELLOW),
            beam([0.8, 1.25, z], [0, 2.7, z + 1.5], 0.08, CRANE_YELLOW),
            beam([0, 2.7, z + 1.5], [0.8, 1.25, z + 3], 0.08, CRANE_YELLOW),
            beam([-0.8, 1.25, z + 3], [0.8, 1.25, z + 3], 0.07, CRANE_YELLOW),
        );
    }
    for (let index = 0; index < 3; index += 1) {
        parts.push(box(2.6, 2.4, 0.9, BALLAST, [0, 0.3, -counter + 0.6 + index * 1.0]));
    }
    return merged(parts);
}

function craneTrolley() {
    return merged([
        box(1.7, 0.45, 2.2, STEEL, [0, 0, 0]),
        cylinder(0.3, 0.3, 0.12, 10, BARE_STEEL, [0, -0.3, 0], [0, 0, HALF_PI]),
    ]);
}

// Hook frame: the bottom of the hook block.
function craneHook() {
    return merged([
        box(0.7, 1.0, 0.45, CRANE_YELLOW, [0, 0.5, 0]),
        cylinder(0.08, 0.05, 0.5, 6, STEEL, [0, -0.25, 0]),
    ]);
}

// Two falls of rope, one metre long downwards; scaled to the hook drop.
function craneCable() {
    return merged([
        box(0.05, 1, 0.05, STEEL, [-0.25, -0.5, 0]),
        box(0.05, 1, 0.05, STEEL, [0.25, -0.5, 0]),
    ]);
}

// A bundle of reinforcing bars in two slings under the hook.
function craneLoad() {
    return merged([
        box(6, 0.45, 0.8, REBAR, [0, -1.6, 0]),
        beam([0, -0.45, 0], [-2.6, -1.37, 0], 0.05, STEEL),
        beam([0, -0.45, 0], [2.6, -1.37, 0], 0.05, STEEL),
    ]);
}

// Part geometries per machine kind, freshly built and owned by the caller.
// The crane's mast section is a separate, repeated part.
export function createConstructionMachineParts() {
    return {
        excavator: {
            tracks: excavatorTracks(),
            house: excavatorHouse(),
            boom: excavatorBoom(),
            stick: excavatorStick(),
            bucket: excavatorBucket(),
        },
        'dump-truck': { chassis: dumpTruckChassis(), bed: dumpTruckBed(), load: dumpTruckLoad() },
        bulldozer: { body: bulldozerBody(), blade: bulldozerBlade() },
        'mixer-truck': { chassis: mixerTruckChassis(), drum: mixerTruckDrum() },
        'tower-crane': {
            pad: cranePad(),
            mastSection: craneMastSection(),
            head: craneHead(),
            trolley: craneTrolley(),
            hook: craneHook(),
            cable: craneCable(),
            load: craneLoad(),
        },
    };
}

// One material for every machine: the colour lives in the vertices.
export function createConstructionMachineMaterial() {
    return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.05 });
}

const scratch = {
    a: new THREE.Matrix4(),
    b: new THREE.Matrix4(),
};

function jointed(out, parent, x, y, z, pitch) {
    return out.copy(parent)
        .multiply(scratch.a.makeTranslation(x, y, z))
        .multiply(scratch.b.makeRotationX(pitch));
}

// Each compose function writes the pose's part matrices, in the machine's
// own frame, into `out` (a Matrix4 per part key).
export function composeExcavatorParts(pose, out) {
    const { trackHeightM, boomPivot, boomLengthM, stickLengthM } = EXCAVATOR_RIG;
    out.tracks.identity();
    out.house.makeRotationY(pose.houseYaw || 0).setPosition(0, trackHeightM, 0);
    jointed(out.boom, out.house, boomPivot.x, boomPivot.y, boomPivot.z, pose.boomPitch || 0);
    jointed(out.stick, out.boom, 0, 0, boomLengthM, pose.stickPitch || 0);
    jointed(out.bucket, out.stick, 0, 0, stickLengthM, pose.bucketPitch || 0);
    return out;
}

export function composeDumpTruckParts(pose, out) {
    const { bedHinge } = DUMP_TRUCK_RIG;
    out.chassis.identity();
    // A negative pitch lifts the front of the bed about its rear hinge.
    out.bed.makeRotationX(-(pose.bedTilt || 0)).setPosition(0, bedHinge.y, bedHinge.z);
    out.load.copy(out.bed);
    return out;
}

export function composeBulldozerParts(pose, out) {
    out.body.identity();
    out.blade.makeTranslation(0, pose.bladeLift || 0, BULLDOZER_RIG.bladeZ);
    return out;
}

export function composeMixerTruckParts(pose, out) {
    const { drumPivot, drumTiltRad } = MIXER_TRUCK_RIG;
    out.chassis.identity();
    out.drum.makeTranslation(0, drumPivot.y, drumPivot.z)
        .multiply(scratch.a.makeRotationX(drumTiltRad))
        .multiply(scratch.b.makeRotationZ(pose.drumAngle || 0));
    return out;
}

export function towerCraneMastSectionCount(mastHeightM) {
    const { padHeightM, mastSectionM } = TOWER_CRANE_RIG;
    return Math.max(1, Math.ceil((mastHeightM - padHeightM) / mastSectionM));
}

// The head sits on the last whole mast section, never below the asked height.
export function composeTowerCraneParts(pose, out) {
    const { padHeightM, mastSectionM } = TOWER_CRANE_RIG;
    const sections = towerCraneMastSectionCount(pose.mastHeightM);
    const headY = padHeightM + sections * mastSectionM;
    out.pad.identity();
    out.head.makeRotationY(pose.slewYaw || 0).setPosition(0, headY, 0);
    out.trolley.copy(out.head).multiply(scratch.a.makeTranslation(0, 1, pose.trolleyM));
    out.hook.copy(out.head).multiply(scratch.a.makeTranslation(0, 1 - pose.hookDropM, pose.trolleyM));
    out.cable.copy(out.trolley).multiply(scratch.a.makeScale(1, Math.max(0.1, pose.hookDropM - 1), 1));
    out.load.copy(out.hook);
    return { sections, headY };
}

export function composeTowerCraneMastSection(index, out) {
    return out.makeTranslation(0, TOWER_CRANE_RIG.padHeightM + index * TOWER_CRANE_RIG.mastSectionM, 0);
}

const COMPOSERS = Object.freeze({
    excavator: composeExcavatorParts,
    'dump-truck': composeDumpTruckParts,
    bulldozer: composeBulldozerParts,
    'mixer-truck': composeMixerTruckParts,
});

// The model viewer's preview: one mesh per part, placed by the same compose
// functions the site uses. Crane mast sections are one instanced mesh.
const PREVIEW_MAST_SECTIONS = 40;

export function createConstructionMachinePreview(kind) {
    const parts = createConstructionMachineParts();
    const geometries = parts[kind];
    if (!geometries) throw new Error(`Unknown construction machine "${kind}".`);
    for (const [otherKind, other] of Object.entries(parts)) {
        if (otherKind !== kind) for (const geometry of Object.values(other)) geometry.dispose();
    }
    const material = createConstructionMachineMaterial();
    const group = new THREE.Group();
    group.name = `ConstructionMachine:${kind}`;
    const meshes = {};
    const matrices = {};
    for (const [key, geometry] of Object.entries(geometries)) {
        const mesh = key === 'mastSection'
            ? new THREE.InstancedMesh(geometry, material, PREVIEW_MAST_SECTIONS)
            : new THREE.Mesh(geometry, material);
        mesh.name = `${kind}:${key}`;
        mesh.matrixAutoUpdate = false;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        meshes[key] = mesh;
        matrices[key] = new THREE.Matrix4();
        group.add(mesh);
    }
    group.userData.constructionMachine = { kind, meshes, matrices };
    return group;
}

export function poseConstructionMachinePreview(group, pose) {
    const { kind, meshes, matrices } = group.userData.constructionMachine;
    if (kind === 'tower-crane') {
        const { sections } = composeTowerCraneParts(pose, matrices);
        meshes.mastSection.count = Math.min(PREVIEW_MAST_SECTIONS, sections);
        for (let index = 0; index < meshes.mastSection.count; index += 1) {
            meshes.mastSection.setMatrixAt(index, composeTowerCraneMastSection(index, scratch.a));
        }
        meshes.mastSection.instanceMatrix.needsUpdate = true;
        meshes.load.visible = pose.carrying !== false;
    } else {
        COMPOSERS[kind](pose, matrices);
        if (meshes.load) meshes.load.visible = pose.loaded !== false;
    }
    for (const [key, mesh] of Object.entries(meshes)) {
        if (key !== 'mastSection') mesh.matrix.copy(matrices[key]);
        mesh.matrixWorldNeedsUpdate = true;
    }
    return group;
}
