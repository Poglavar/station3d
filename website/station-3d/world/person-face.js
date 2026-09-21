// Optional authored face for the few campaign persons who need to carry an
// expression: eyes, brows, nose, ears, mouth, teeth, moustache, beard,
// stubble, glasses and headgear on the shared low-poly head. Static features
// are merged per colour so a full face costs about a dozen draw calls, while
// brows, eyes, mouth, teeth, moustache and beard stay separate meshes so
// expressions and the blink/talk motion are transforms, never geometry
// rebuilds. Motion is a pure function of time, so any frame is reproducible
// headlessly. Anonymous pedestrians use the single textured head in
// person-head.js; this expression rig stays opt-in per actor.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { registerShared, unregisterShared } from '../core/dispose.js';
import { FACE_EXPRESSIONS } from '../core/face-expressions.js';

export { FACE_EXPRESSIONS };

// browLift is in head radii, browTilt in radians (negative pulls the inner
// ends down into a scowl), eyeOpen scales the eye whites about the eye line.
const EXPRESSION_PRESETS = Object.freeze({
    neutral: { browLift: 0, browTilt: 0, eyeOpen: 1, mouth: 'neutral' },
    smile: { browLift: 0.02, browTilt: 0.1, eyeOpen: 0.82, mouth: 'smile' },
    stern: { browLift: -0.07, browTilt: -0.34, eyeOpen: 0.66, mouth: 'frown' },
    surprised: { browLift: 0.06, browTilt: 0.04, eyeOpen: 1.3, mouth: 'open' },
});

// `normal` is one ellipsoid, `fine` a thin two-segment arch, `heavy` a thick
// low bar that sits a little closer to the eyes.
export const FACE_BROW_STYLES = Object.freeze(['normal', 'fine', 'heavy']);
export const FACE_HAT_KINDS = Object.freeze(['fisherman-cap', 'flat-cap', 'headscarf']);

const DEFAULT_HAIR = 0x3b2a1e;
const DEFAULT_IRIS = 0x4b6b8a;
const DEFAULT_LIP = 0x6b3030;
const DEFAULT_GLASSES = 0x2b2b30;
const DEFAULT_SCARF = 0x7a1f2b;
const DEFAULT_FLAT_CAP = 0x3b3a36;
const EYE_WHITE = 0xf4f1ea;
const PUPIL = 0x0b0f14;
const TEETH = 0xf6f2e8;

const TAU = Math.PI * 2;
const BLINK_SLOT_S = 3.2;
const BLINK_S = 0.18;
const DOUBLE_BLINK_GAP_S = 0.28;
// Below this openness the lips still hide the teeth while talking.
const TEETH_SHOW_OPEN = 0.18;

let sphereGeo = null;
let cylinderGeo = null;
let peakGeo = null;
let mouthArcGeo = null;
let teethGeo = null;
let ringGeo = null;
let scarfShellGeo = null;
let stubbleShellGeo = null;
const mergedGeoCache = new Map();

function getSphereGeo() {
    if (!sphereGeo) {
        sphereGeo = new THREE.SphereGeometry(1, 12, 9);
        registerShared(sphereGeo);
    }
    return sphereGeo;
}

function getCylinderGeo() {
    if (!cylinderGeo) {
        cylinderGeo = new THREE.CylinderGeometry(1, 1, 1, 18);
        registerShared(cylinderGeo);
    }
    return cylinderGeo;
}

function getPeakGeo() {
    if (!peakGeo) {
        // A flat cylinder sector centred on the face (+Z); the part inside the
        // crown is hidden, the rest is the cap's peak.
        peakGeo = new THREE.CylinderGeometry(1, 1, 1, 14, 1, false, -1.1, 2.2);
        registerShared(peakGeo);
    }
    return peakGeo;
}

function getMouthArcGeo() {
    if (!mouthArcGeo) {
        // Upper half ring: an arch as built, a smile once turned over.
        mouthArcGeo = new THREE.TorusGeometry(1, 0.16, 5, 12, Math.PI);
        registerShared(mouthArcGeo);
    }
    return mouthArcGeo;
}

function getTeethGeo() {
    if (!teethGeo) {
        // Lower half of a sphere with its flat top on the origin: hung from the
        // upper lip it is a row of teeth, flattened into a smile it fills the arc.
        teethGeo = new THREE.SphereGeometry(1, 12, 5, 0, TAU, Math.PI / 2, Math.PI / 2);
        registerShared(teethGeo);
    }
    return teethGeo;
}

function getRingGeo() {
    if (!ringGeo) {
        ringGeo = new THREE.TorusGeometry(1, 0.1, 6, 16);
        registerShared(ringGeo);
    }
    return ringGeo;
}

function getScarfShellGeo() {
    if (!scarfShellGeo) {
        // A sphere with a lune cut out of the +Z face: the scarf frames the
        // face from the forehead to under the chin and covers the hair.
        scarfShellGeo = new THREE.SphereGeometry(1, 14, 10, Math.PI / 2 + 0.72, TAU - 1.44);
        registerShared(scarfShellGeo);
    }
    return scarfShellGeo;
}

function getStubbleShellGeo() {
    if (!stubbleShellGeo) {
        // The lower front of a sphere from just under the lower lip to the
        // chin and round to the jaw hinge: a shade over the skin, not a beard,
        // and its edge hides behind the mouth.
        stubbleShellGeo = new THREE.SphereGeometry(1, 14, 6, Math.PI / 2 - 1.45, 2.9, 2.1, Math.PI - 2.1);
        registerShared(stubbleShellGeo);
    }
    return stubbleShellGeo;
}

function placed(base, [x, y, z], [sx, sy, sz], { rotX = 0, rotY = 0, rotZ = 0, alignY = null, alignZ = null } = {}) {
    const geometry = base.clone();
    let rotation;
    if (alignY || alignZ) {
        const from = alignY ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
        rotation = new THREE.Quaternion().setFromUnitVectors(from, new THREE.Vector3(...(alignY || alignZ)).normalize());
    } else {
        rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(rotX, rotY, rotZ));
    }
    geometry.applyMatrix4(new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        rotation,
        new THREE.Vector3(sx, sy, sz),
    ));
    return geometry;
}

function mergedGeometry(key, build) {
    let geometry = mergedGeoCache.get(key);
    if (geometry) return geometry;
    const parts = build();
    geometry = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    geometry.computeBoundingSphere();
    registerShared(geometry);
    mergedGeoCache.set(key, geometry);
    return geometry;
}

function facePart(name, geometry, material) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    // The head already casts the silhouette; a dozen tiny casters would only
    // multiply the shadow pass for no visible gain.
    mesh.castShadow = false;
    return mesh;
}

function clamp01(value) {
    return Math.max(0, Math.min(1, value));
}

// A spec measurement is either absent or a finite number; anything else is a
// typo that must not quietly become 0 or 1.
function measurement(spec, key, fallback) {
    const value = spec[key];
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(`Face spec ${key} must be a finite number, got ${value}.`);
    }
    return value;
}

function colorOr(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}

// Deterministic unit hash, so a blink schedule needs no per-actor state.
function hash01(n) {
    const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
}

function blinkPulse(local) {
    return local >= 0 && local < BLINK_S ? 1 - Math.abs(local / BLINK_S * 2 - 1) : 0;
}

/** Lid closure 0..1 at `time`: one blink somewhere in every 3.2 s slot, a quarter of them doubled. */
export function blinkAmountAt(time) {
    const slot = Math.floor(time / BLINK_SLOT_S);
    const start = slot * BLINK_SLOT_S
        + hash01(slot) * (BLINK_SLOT_S - 2 * BLINK_S - DOUBLE_BLINK_GAP_S);
    let amount = blinkPulse(time - start);
    if (hash01(slot + 0.5) < 0.25) {
        amount = Math.max(amount, blinkPulse(time - start - DOUBLE_BLINK_GAP_S));
    }
    return amount;
}

/**
 * Mouth openness 0..1 of pseudo-speech at `time`: syllables around four a
 * second under an irregular envelope; the negative half-waves are the pauses
 * between words.
 */
export function speechOpennessAt(time) {
    return clamp01(
        Math.sin(time * TAU * 3.8) * 0.6
        + Math.sin(time * TAU * 6.1 + 1.7) * 0.25
        + Math.sin(time * TAU * 0.9 + 0.4) * 0.35,
    );
}

function stillMotion() {
    return { blink: 0, talk: 0, open: 0, width: 0.5, nod: 0, turn: 0, browBump: 0 };
}

function motionInto(motion, time, talk) {
    motion.blink = blinkAmountAt(time);
    motion.talk = talk;
    motion.open = speechOpennessAt(time) * talk;
    motion.width = 0.5 + 0.5 * Math.sin(time * TAU * 2.3 + 0.9);
    // A little head movement is most of what makes speech read as alive.
    motion.nod = (0.035 * Math.sin(time * TAU * 1.3) + 0.02 * Math.sin(time * TAU * 0.45 + 1)) * talk;
    motion.turn = 0.03 * Math.sin(time * TAU * 0.55 + 2) * talk;
    motion.browBump = clamp01(Math.sin(time * TAU * 0.8 + 2.4)) * talk;
}

function hideTeeth(state) {
    if (state.teeth) state.teeth.visible = false;
}

// The teeth hang from `topY` (the upper lip) and are never rebuilt, only
// shown, placed and scaled; hidden they cost nothing and cannot z-fight.
function showTeeth(state, topY, halfWidth, height, z) {
    if (!state.teeth) return;
    state.teeth.visible = true;
    state.teeth.position.set(0, topY, z);
    state.teeth.scale.set(halfWidth, height, 0.03 * state.R);
}

function applyPoseMouth(state, mode) {
    const { mouth, R, mouthBaseY } = state;
    const s = 0.2 * R;
    mouth.rotation.set(0, 0, 0);
    if (mode === 'open') {
        mouth.geometry = getSphereGeo();
        mouth.scale.set(0.1 * R, 0.13 * R, 0.05 * R);
        mouth.position.y = mouthBaseY - 0.06 * R;
        showTeeth(state, mouthBaseY + 0.052 * R, 0.075 * R, 0.045 * R, 0.95 * R);
    } else if (mode === 'neutral') {
        mouth.geometry = getSphereGeo();
        mouth.scale.set(s, 0.035 * R, 0.04 * R);
        mouth.position.y = mouthBaseY;
        hideTeeth(state);
    } else {
        // Smile: a wide, shallow arch turned over so the corners sit on the
        // mouth line and the middle dips. Frown: the arch top stays on the
        // line and the corners droop.
        const [width, depth] = mode === 'smile' ? [0.27, 0.12] : [0.22, 0.13];
        mouth.geometry = getMouthArcGeo();
        mouth.scale.set(width * R, depth * R, s);
        mouth.rotation.z = mode === 'smile' ? Math.PI : 0;
        mouth.position.y = mode === 'smile' ? mouthBaseY : mouthBaseY - depth * R;
        // A smile with teeth fills the arc with a white half-ellipse just
        // inside the lip line; a frown keeps them hidden.
        if (mode === 'smile') showTeeth(state, mouthBaseY + 0.004 * R, 0.225 * R, 0.095 * R, 0.925 * R);
        else hideTeeth(state);
    }
}

function applyTalkMouth(state) {
    const { mouth, R, mouthBaseY, motion } = state;
    // Closed it matches the neutral line; open it narrows and drops with the jaw.
    mouth.geometry = getSphereGeo();
    mouth.rotation.set(0, 0, 0);
    const width = 0.12 + 0.06 * motion.width - 0.04 * motion.open;
    const halfHeight = (0.035 + 0.11 * motion.open) * R;
    const centerY = mouthBaseY - 0.055 * R * motion.open;
    mouth.scale.set(width * R, halfHeight, 0.05 * R);
    mouth.position.y = centerY;
    if (motion.open > TEETH_SHOW_OPEN) {
        showTeeth(state, centerY + halfHeight - 0.012 * R, width * 0.85 * R, Math.min(0.05 * R, halfHeight * 0.55), 0.95 * R);
    } else {
        hideTeeth(state);
    }
}

function refresh(state) {
    const { R, pose, motion } = state;
    for (const { mesh, side } of state.brows) {
        mesh.position.y = pose.browY + motion.browBump * 0.025 * R;
        const tilt = pose.browTilt + state.browArch;
        mesh.rotation.z = side < 0 ? tilt : -tilt;
    }
    const lids = 1 - 0.92 * motion.blink;
    if (state.eyeWhites) state.eyeWhites.scale.y = pose.eyeOpen * lids;
    for (const mesh of state.eyeDetail) mesh.scale.y = lids;
    if (state.mouth) {
        if (motion.talk > 0) applyTalkMouth(state);
        else applyPoseMouth(state, pose.mouth);
    }
    if (state.moustache) {
        state.moustache.position.y = 0.025 * R * motion.open;
        state.moustache.scale.set(1 + 0.06 * motion.open, 1 - 0.15 * motion.open, 1);
    }
    if (state.beard) state.beard.position.y = -0.07 * R * motion.open;
    state.face.rotation.set(motion.nod, motion.turn, 0);
}

function applyExpression(state, name) {
    const preset = EXPRESSION_PRESETS[name];
    if (!preset) throw new RangeError(`Unknown face expression "${name}".`);
    state.pose = {
        browY: state.browBaseY + preset.browLift * state.R,
        browTilt: preset.browTilt,
        eyeOpen: preset.eyeOpen,
        mouth: preset.mouth,
    };
    state.expression = name;
    refresh(state);
}

function browGeometry(style, R, side) {
    if (style === 'fine') {
        // Two thin segments: the inner one rises to a peak two fifths of the
        // way out, the outer one tapers down toward the temple.
        return mergedGeometry(`browFine|${R}|${side}`, () => [
            placed(getSphereGeo(), [-side * 0.08 * R, -0.005 * R, 0], [0.12 * R, 0.03 * R, 0.05 * R], { rotZ: side * 0.28 }),
            placed(getSphereGeo(), [side * 0.1 * R, 0.008 * R, 0], [0.11 * R, 0.028 * R, 0.05 * R], { rotZ: -side * 0.42 }),
        ]);
    }
    return getSphereGeo();
}

/**
 * Builds the authored face onto a person group. Offsets are in head radii so
 * every person kind shares the same proportions. Features are opt-in:
 *   eyes, nose, ears, mouth, teeth, moustache, beard, stubble: booleans
 *   eyeSize, noseSize: finite multipliers (default 1)
 *   browStyle: FACE_BROW_STYLES entry (default 'normal')
 *   hairColor: brows, moustache, beard and stubble; stubbleColor overrides
 *   eyeColor: iris; lipColor
 *   glasses: { color } round rims with a bridge and arms
 *   hat: { kind: 'fisherman-cap', color, peakColor, badgeColor }
 *      | { kind: 'flat-cap', color } | { kind: 'headscarf', color }
 *   expression: initial FACE_EXPRESSIONS entry
 * `material(hex)` is the person's shared material getter. The face group
 * pivots on the head centre, so its nod/turn reads as the head moving (the
 * bare skin sphere is symmetric; separately authored hair does not follow).
 */
export function attachPersonFace({ group, head, dims, skinColor, spec, material }) {
    const R = dims.headR;
    const face = new THREE.Group();
    face.name = 'PersonFace';
    face.position.copy(head.position);
    const hairColor = colorOr(spec.hairColor, DEFAULT_HAIR);
    const eyeSize = measurement(spec, 'eyeSize', 1);
    const noseSize = measurement(spec, 'noseSize', 1);
    const browStyle = spec.browStyle ?? 'normal';
    if (!FACE_BROW_STYLES.includes(browStyle)) {
        throw new RangeError(`Unknown brow style "${browStyle}".`);
    }
    const state = {
        R,
        face,
        brows: [],
        eyeWhites: null,
        eyeDetail: [],
        mouth: null,
        teeth: null,
        moustache: null,
        beard: null,
        // Larger eyes push the brows up so the lids never touch them; heavy
        // brows sit a little lower and lean in.
        browBaseY: (0.3 + (eyeSize - 1) * 0.16 + (browStyle === 'heavy' ? -0.02 : 0)) * R,
        browArch: browStyle === 'heavy' ? -0.06 : 0,
        mouthBaseY: -0.46 * R,
        pose: null,
        motion: stillMotion(),
        expression: 'neutral',
    };

    if (spec.nose || spec.ears) {
        const skin = mergedGeometry(`skin|${R}|${spec.nose ? noseSize : 0}|${!!spec.ears}`, () => {
            const parts = [];
            if (spec.nose) {
                parts.push(placed(
                    getSphereGeo(),
                    [0, (-0.12 - 0.03 * (noseSize - 1)) * R, 0.96 * R],
                    [0.14 * noseSize * R, 0.18 * noseSize * R, 0.19 * noseSize * R],
                ));
            }
            if (spec.ears) {
                for (const side of [-1, 1]) {
                    parts.push(placed(getSphereGeo(), [side * R, 0.02 * R, 0], [0.1 * R, 0.2 * R, 0.15 * R]));
                }
            }
            return parts;
        });
        face.add(facePart('PersonFaceSkin', skin, material(skinColor)));
    }

    if (spec.eyes) {
        // Each eye-line mesh has its origin on the eye line, so one y-scale
        // opens, narrows or blinks both eyes together.
        const whites = mergedGeometry(`whites|${R}|${eyeSize}`, () => [-1, 1].map(side => (
            placed(getSphereGeo(), [side * 0.36 * R, 0, 0], [0.14 * eyeSize * R, 0.11 * eyeSize * R, 0.08 * R])
        )));
        const eyes = facePart('PersonEyeWhites', whites, material(EYE_WHITE));
        eyes.position.set(0, 0.14 * R, 0.9 * R);
        face.add(eyes);
        state.eyeWhites = eyes;

        const irises = mergedGeometry(`irises|${R}|${eyeSize}`, () => [-1, 1].map(side => (
            placed(getSphereGeo(), [side * 0.36 * R, 0, 0], [0.065 * eyeSize * R, 0.065 * eyeSize * R, 0.03 * R])
        )));
        const iris = facePart('PersonIrises', irises, material(colorOr(spec.eyeColor, DEFAULT_IRIS)));
        iris.position.set(0, 0.14 * R, 0.96 * R);
        face.add(iris);

        const pupils = mergedGeometry(`pupils|${R}|${eyeSize}`, () => [-1, 1].map(side => (
            placed(getSphereGeo(), [side * 0.36 * R, 0, 0], [0.035 * eyeSize * R, 0.035 * eyeSize * R, 0.02 * R])
        )));
        const pupil = facePart('PersonPupils', pupils, material(PUPIL));
        pupil.position.set(0, 0.14 * R, 0.98 * R);
        face.add(pupil);
        state.eyeDetail.push(iris, pupil);

        for (const side of [-1, 1]) {
            const brow = facePart(
                side < 0 ? 'PersonBrowLeft' : 'PersonBrowRight',
                browGeometry(browStyle, R, side),
                material(hairColor),
            );
            brow.position.set(side * 0.36 * R, state.browBaseY, 0.9 * R);
            if (browStyle === 'heavy') brow.scale.set(0.27 * R, 0.09 * R, 0.085 * R);
            else if (browStyle === 'normal') brow.scale.set(0.22 * R, 0.06 * R, 0.07 * R);
            face.add(brow);
            state.brows.push({ mesh: brow, side });
        }
    }

    if (spec.mouth) {
        const mouth = facePart('PersonMouth', getSphereGeo(), material(colorOr(spec.lipColor, DEFAULT_LIP)));
        mouth.position.set(0, state.mouthBaseY, 0.93 * R);
        face.add(mouth);
        state.mouth = mouth;
        if (spec.teeth) {
            const teeth = facePart('PersonTeeth', getTeethGeo(), material(TEETH));
            teeth.visible = false;
            face.add(teeth);
            state.teeth = teeth;
        }
    }

    if (spec.moustache) {
        // Outer ends droop like a walrus moustache.
        const geometry = mergedGeometry(`moustache|${R}`, () => [-1, 1].map(side => placed(
            getSphereGeo(),
            [side * 0.21 * R, -0.32 * R, 0.93 * R],
            [0.34 * R, 0.13 * R, 0.12 * R],
            { rotZ: -side * 0.3 },
        )));
        const moustache = facePart('PersonMoustache', geometry, material(hairColor));
        face.add(moustache);
        state.moustache = moustache;
    }

    if (spec.beard) {
        const geometry = mergedGeometry(`beard|${R}`, () => [
            ...[-1, 1].map(side => placed(getSphereGeo(), [side * 0.5 * R, -0.55 * R, 0.48 * R], [0.36 * R, 0.46 * R, 0.5 * R])),
            placed(getSphereGeo(), [0, -0.92 * R, 0.4 * R], [0.5 * R, 0.4 * R, 0.46 * R]),
        ]);
        const beard = facePart('PersonBeard', geometry, material(hairColor));
        face.add(beard);
        state.beard = beard;
    }

    if (spec.stubble) {
        // A shell a few hundredths of a radius over the lower face; the mouth
        // and nose stand proud of it, so nothing fights for the same surface.
        const geometry = mergedGeometry(`stubble|${R}`, () => [
            placed(getStubbleShellGeo(), [0, 0, 0], [1.03 * R, 1.03 * 1.08 * R, 1.03 * R]),
        ]);
        face.add(facePart('PersonStubble', geometry, material(colorOr(spec.stubbleColor, hairColor))));
    }

    if (spec.glasses) {
        const geometry = mergedGeometry(`glasses|${R}`, () => [
            ...[-1, 1].map(side => placed(getRingGeo(), [side * 0.36 * R, 0.14 * R, 1.0 * R], [0.21 * R, 0.21 * R, 0.21 * R])),
            placed(getCylinderGeo(), [0, 0.15 * R, 1.02 * R], [0.02 * R, 0.32 * R, 0.02 * R], { rotZ: Math.PI / 2 }),
            ...[-1, 1].map(side => placed(
                getCylinderGeo(), [side * 0.775 * R, 0.17 * R, 0.49 * R], [0.018 * R, 1.09 * R, 0.018 * R], { alignY: [side * 0.41, 0.06, -0.98] },
            )),
        ]);
        face.add(facePart('PersonGlasses', geometry, material(colorOr(spec.glasses.color, DEFAULT_GLASSES))));
    }

    if (spec.hat) {
        if (!FACE_HAT_KINDS.includes(spec.hat.kind)) {
            throw new RangeError(`Unknown hat kind "${spec.hat.kind}".`);
        }
        if (spec.hat.kind === 'fisherman-cap') {
            const crown = mergedGeometry(`capCrown|${R}`, () => [
                placed(getSphereGeo(), [0, 0.92 * R, -0.04 * R], [1.16 * R, 0.5 * R, 1.16 * R]),
            ]);
            face.add(facePart('PersonHatCrown', crown, material(colorOr(spec.hat.color, 0x1b2433))));
            const trim = mergedGeometry(`capTrim|${R}`, () => [
                placed(getCylinderGeo(), [0, 0.56 * R, 0], [1.08 * R, 0.22 * R, 1.08 * R]),
                placed(getPeakGeo(), [0, 0.5 * R, 0.05 * R], [1.28 * R, 0.04 * R, 1.28 * R], { rotX: 0.08 }),
            ]);
            face.add(facePart('PersonHatTrim', trim, material(colorOr(spec.hat.peakColor, 0x111418))));
            if (Number.isFinite(spec.hat.badgeColor)) {
                const badge = facePart('PersonHatBadge', getSphereGeo(), material(spec.hat.badgeColor));
                badge.position.set(0, 0.56 * R, 1.09 * R);
                badge.scale.setScalar(0.06 * R);
                face.add(badge);
            }
        } else if (spec.hat.kind === 'flat-cap') {
            // A low crown pitched forward onto a stubby peak, one colour, one
            // mesh. The peak tip stays above 0.45 R so raised brows clear it.
            const cap = mergedGeometry(`flatCap|${R}`, () => [
                placed(getSphereGeo(), [0, 0.93 * R, 0.02 * R], [1.18 * R, 0.36 * R, 1.22 * R], { rotX: 0.2 }),
                placed(getPeakGeo(), [0, 0.6 * R, 0.12 * R], [1.12 * R, 0.04 * R, 1.12 * R], { rotX: 0.08 }),
            ]);
            face.add(facePart('PersonFlatCap', cap, material(colorOr(spec.hat.color, DEFAULT_FLAT_CAP))));
        } else {
            // Headscarf tied under the chin: the shell frames the face and
            // hides the hair, the knot and tails hang below the jaw.
            const scarf = mergedGeometry(`headscarf|${R}`, () => [
                placed(getScarfShellGeo(), [0, 0.03 * R, -0.03 * R], [1.1 * R, 1.17 * R, 1.1 * R]),
                placed(getSphereGeo(), [0, -0.98 * R, 0.58 * R], [0.14 * R, 0.11 * R, 0.11 * R]),
                placed(getSphereGeo(), [-0.12 * R, -1.14 * R, 0.55 * R], [0.08 * R, 0.15 * R, 0.06 * R], { rotZ: 0.35 }),
                placed(getSphereGeo(), [0.12 * R, -1.14 * R, 0.55 * R], [0.08 * R, 0.15 * R, 0.06 * R], { rotZ: -0.35 }),
            ]);
            face.add(facePart('PersonHeadscarf', scarf, material(colorOr(spec.hat.color, DEFAULT_SCARF))));
        }
    }

    group.add(face);
    group.userData.face = state;
    applyExpression(state, spec.expression || 'neutral');
    return face;
}

export function setPersonFaceExpression(person, expression) {
    const state = person?.userData?.face;
    if (!state) return false;
    applyExpression(state, expression);
    return true;
}

export function getPersonFaceExpression(person) {
    return person?.userData?.face?.expression ?? null;
}

/**
 * Drives blinks and, while `talk` > 0, pseudo-speech on the mouth, teeth,
 * moustache, beard, brows and head. Pure in `time`: the same time always
 * yields the same pose, so callers feed a per-actor clock and never keep
 * animation state.
 */
export function animatePersonFace(person, time, { talk = 0 } = {}) {
    const state = person?.userData?.face;
    if (!state) return false;
    if (!Number.isFinite(time)) {
        throw new TypeError(`Face animation time must be a finite number, got ${time}.`);
    }
    motionInto(state.motion, time, Number.isFinite(talk) ? clamp01(talk) : 0);
    refresh(state);
    return true;
}

export function disposePersonFaceCaches() {
    const resources = new Set([
        sphereGeo,
        cylinderGeo,
        peakGeo,
        mouthArcGeo,
        teethGeo,
        ringGeo,
        scarfShellGeo,
        stubbleShellGeo,
        ...mergedGeoCache.values(),
    ]);
    for (const resource of resources) {
        if (!resource) continue;
        unregisterShared(resource);
        resource.dispose();
    }
    sphereGeo = null;
    cylinderGeo = null;
    peakGeo = null;
    mouthArcGeo = null;
    teethGeo = null;
    ringGeo = null;
    scarfShellGeo = null;
    stubbleShellGeo = null;
    mergedGeoCache.clear();
}
