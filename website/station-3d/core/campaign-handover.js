// Pure choreography for the two moments the sealed package changes hands: Jerko
// lifting it off the Vis quay into the courier's arms, and the courier holding
// it out to Viktorija under Grič, where she carries it to the map desk and cuts
// the twine. Both are sampled from the film clock so the camera keyframes in the
// campaign definition and the prop in the world read one deterministic timeline.
// Metres are set-local (x east, y up, z south), angles radians.

export const VIS_HANDOVER_DURATION_S = 7;
// The live prefix inside permit-reveal: everything after it is the blueprint
// artwork the cinematic already had.
export const PERMIT_HANDOVER_DURATION_S = 5;

function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
}

function smoothstep(value) {
    const t = clamp(value, 0, 1);
    return t * t * (3 - 2 * t);
}

// Linear between keys, eased inside each leg: the parcel is carried by hand, so
// it should never arrive or leave at a constant speed.
function samplePath(path, time) {
    const clamped = clamp(time, path[0].t, path.at(-1).t);
    let left = path[0];
    let right = path.at(-1);
    for (let index = 0; index < path.length - 1; index += 1) {
        if (clamped <= path[index + 1].t) {
            left = path[index];
            right = path[index + 1];
            break;
        }
    }
    const ratio = smoothstep((clamped - left.t) / Math.max(1e-6, right.t - left.t));
    return {
        x: left.x + (right.x - left.x) * ratio,
        y: left.y + (right.y - left.y) * ratio,
        z: left.z + (right.z - left.z) * ratio,
        pitch: left.pitch + (right.pitch - left.pitch) * ratio,
        yaw: left.yaw + (right.yaw - left.yaw) * ratio,
    };
}

// Set-local about the fisherman: he sits on the quay edge facing east over the
// water, the parcel resting on the stones at his landward side under a coil of
// net. It rises to his lap, swings out west toward the courier and ends filling
// the frame at the camera, key on top.
const VIS_PATH = Object.freeze([
    Object.freeze({ t: 0, x: -0.38, y: 0.06, z: 0.52, pitch: 0, yaw: 0.35 }),
    Object.freeze({ t: 1.9, x: -0.3, y: 0.66, z: 0.34, pitch: 0.12, yaw: 0.2 }),
    Object.freeze({ t: 3.4, x: -0.72, y: 0.82, z: 0.16, pitch: 0.28, yaw: -0.35 }),
    Object.freeze({ t: 5.1, x: -1.32, y: 1.02, z: -0.02, pitch: 0.5, yaw: -0.72 }),
    Object.freeze({ t: 7, x: -1.5, y: 0.98, z: -0.04, pitch: 0.62, yaw: -0.86 }),
]);

// The boat key goes on top once the parcel is off the ground and clear of the net.
const VIS_KEY_VISIBLE_FROM_S = 3.4;

export function sampleVisHandover(elapsedSeconds) {
    const time = Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0;
    const pose = samplePath(VIS_PATH, time);
    return Object.freeze({
        package: Object.freeze({ ...pose, visible: true }),
        keyVisible: time >= VIS_KEY_VISIBLE_FROM_S,
        open: 0,
    });
}

// Set-local about the Grič room centre. The courier stands at x 24.3 and
// Viktorija at 26.35, both on z 5, facing each other; the map desk with the
// lamp is at x 23.2, z 2.1, its top 1.0 m above the floor.
const PERMIT_PATH = Object.freeze([
    Object.freeze({ t: 0, x: 25.02, y: 1.02, z: 5, pitch: 0.34, yaw: 1.5 }),
    Object.freeze({ t: 1.7, x: 25.78, y: 1.08, z: 5, pitch: 0.22, yaw: 1.62 }),
    Object.freeze({ t: 2.6, x: 25.84, y: 1.26, z: 4.5, pitch: 0.05, yaw: 2.35 }),
    Object.freeze({ t: 4.2, x: 23.7, y: 1.2, z: 2.72, pitch: 0.02, yaw: 3.05 }),
    Object.freeze({ t: 5, x: 23.36, y: 1.03, z: 2.34, pitch: 0, yaw: 3.12 }),
]);

// She sets it down, then cuts the twine: the wrapping is open by the time the
// film cuts to the blueprint, so the artwork is what came out of this parcel.
const PERMIT_CUT_START_S = 4.3;
const PERMIT_CUT_END_S = 5;

export function samplePermitHandover(elapsedSeconds) {
    const time = Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0;
    const pose = samplePath(PERMIT_PATH, time);
    const open = smoothstep(
        (time - PERMIT_CUT_START_S) / (PERMIT_CUT_END_S - PERMIT_CUT_START_S),
    );
    return Object.freeze({
        package: Object.freeze({ ...pose, visible: true }),
        keyVisible: false,
        open,
    });
}

// Where the parcel rests when no film is running. `sealed` is the Vis quay in
// set-local metres about the fisherman; `delivered` is the Grič map desk in
// set-local metres about the room centre. `carried` has no pose: it is in the
// courier's own hands, and nothing in the world should draw a second copy.
export function campaignPackageRestPose(stage) {
    if (stage === 'sealed') return sampleVisHandover(0).package;
    if (stage === 'delivered') {
        return Object.freeze({ ...samplePermitHandover(PERMIT_HANDOVER_DURATION_S).package });
    }
    return null;
}

export function campaignPackageStage(worldEffects, effectId = 'toranj-package') {
    const stage = worldEffects?.[effectId];
    return typeof stage === 'string' && stage !== '' ? stage : null;
}
