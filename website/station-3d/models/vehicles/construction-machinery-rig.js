// Joint layout and dimensions of the construction machines, shared by their
// geometry (construction-machinery.js) and by downstream site plans that pose
// them, so an excavator's reach, a truck's bed and a crane's jib are one set of
// numbers. Every machine faces local +Z and
// stands on y = 0; a pitch is a rotation about the part's local X axis.

// The upper house slews on the tracks at trackHeightM. From the house frame the
// boom hinges at boomPivot and points along +Z at pitch 0: a negative pitch
// raises it. The stick hinges at the boom tip and the bucket at the stick tip;
// positive pitches fold them down and in.
export const EXCAVATOR_RIG = Object.freeze({
    trackHeightM: 0.95,
    trackLengthM: 4.6,
    trackWidthM: 3.2,
    houseLengthM: 3.9,
    tailRadiusM: 2.75,
    boomPivot: Object.freeze({ x: -0.35, y: 1.95, z: 1.05 }),
    boomLengthM: 5.7,
    stickLengthM: 2.9,
    bucketLengthM: 1.3,
});

// A three-axle tipper. The bed hinges at its rear edge and reaches forward
// bedLengthM from there; a negative pitch lifts its front.
export const DUMP_TRUCK_RIG = Object.freeze({
    lengthM: 8.6,
    widthM: 2.5,
    bedHinge: Object.freeze({ y: 1.45, z: -4.0 }),
    bedLengthM: 5.2,
    bedWidthM: 2.4,
    bedSideHeightM: 1.1,
});

// How far behind the truck's origin the middle of its bed sits.
export const DUMP_TRUCK_BED_CENTRE_BACK_M = -(DUMP_TRUCK_RIG.bedHinge.z + DUMP_TRUCK_RIG.bedLengthM / 2);

export const BULLDOZER_RIG = Object.freeze({
    lengthM: 4.4,
    widthM: 2.6,
    bladeWidthM: 3.4,
    bladeZ: 2.75,
});

// The drum turns about its own axis, which rises towards the rear.
export const MIXER_TRUCK_RIG = Object.freeze({
    lengthM: 8.4,
    widthM: 2.5,
    drumPivot: Object.freeze({ y: 2.35, z: -0.9 }),
    drumTiltRad: 0.2,
    drumLengthM: 4.4,
    drumRadiusM: 1.15,
});

// A flat-top tower crane: a concrete pad, a lattice mast of stacked sections,
// and a slewing head carrying the jib (+Z) and counter-jib (-Z).
export const TOWER_CRANE_RIG = Object.freeze({
    padSizeM: 6,
    padHeightM: 1,
    mastSectionM: 6,
    mastWidthM: 2,
    jibLengthM: 60,
    counterJibLengthM: 18,
    trolleyMinM: 10,
    trolleyMaxM: 57,
});
