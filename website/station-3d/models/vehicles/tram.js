// Reusable TMK tram geometry, shared model caches, doors, lights, and distance detail.
// The ambient/combat adapter owns world state and releases these caches at session end.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { cssColorToHex } from '../../core/math.js';
import { registerShared, unregisterShared } from '../../core/dispose.js';
import { CAB_RING_COUNT, CAB_RING_SEGMENTS, cabLightMount, cabLinePlateMount, cabRingPoint, cabTipPoint } from './tram-cab-profile.js';
import { addTramFleetBody, disposeTramFleetGeometry, tramFleetFarGeometry, tramFleetSurface } from './tmk-2400-detail.js';

export const TRAM_MAX_HEALTH = 140;
let tramAssets = null;
const tramBodyMaterials = new Map();
const staticTramGeometryCache = new Map();
const farTramGeometryCache = new Map();
let farTramMaterial = null;
let fleetDetailMaterial = null;
let fleetGlassMaterial = null;

// Day/night emissive intensities for headlights and taillights. Headlights
// are dimly on during the day (running lights) and bright at night;
// taillights are faintly visible always and brighter at night.
const DAY_HL_INTENSITY   = 0.30;
const NIGHT_HL_INTENSITY = 1.40;
const DAY_TL_INTENSITY   = 0.40;
const NIGHT_TL_INTENSITY = 1.10;
let tramIsNight = false;
let sharedHeadlightMat = null;
let sharedTaillightMat = null;

// Called from scene/sky.js when the simulated hour crosses dawn/dusk —
// flips the shared head/tail materials so every tram updates at once.
export function setTramNightMode(night) {
    if (night === tramIsNight) return;
    tramIsNight = night;
    if (sharedHeadlightMat) {
        sharedHeadlightMat.emissiveIntensity = night ? NIGHT_HL_INTENSITY : DAY_HL_INTENSITY;
    }
    if (sharedTaillightMat) {
        sharedTaillightMat.emissiveIntensity = night ? NIGHT_TL_INTENSITY : DAY_TL_INTENSITY;
    }
}


// Beyond this range, doors, mullions, line plates and light fittings are below
// useful screen size. Keep a one-draw silhouette rather than submitting every
// detail mesh for each service inside the 1.4 km traffic bubble.
const OTHER_TRAM_DETAIL_RADIUS_M = 360;
const OTHER_TRAM_DETAIL_RADIUS_M_2 = OTHER_TRAM_DETAIL_RADIUS_M
    * OTHER_TRAM_DETAIL_RADIUS_M;

let enemyTramCarriageMaterial = null;
let enemyTramGunMaterial = null;
let enemyTramWheelMaterial = null;
let enemyTramMuzzleMaterial = null;
let enemyTramBulletMaterial = null;
let enemyTramImpactMaterial = null;
let enemyTramDeckGeometry = null;
let enemyTramShieldGeometry = null;
let enemyTramBeamGeometry = null;
let enemyTramWheelGeometry = null;
let enemyTramTurretPostGeometry = null;
let enemyTramTurretBaseGeometry = null;
let enemyTramReceiverGeometry = null;
let enemyTramBarrelGeometry = null;
let enemyTramMuzzleFlashGeometry = null;
let enemyTramBulletGeometry = null;
let enemyTramImpactGeometry = null;
let enemyTramEmblemTexture = null;
let enemyTramEmblemMaterial = null;
let enemyTramSideEmblemGeometry = null;
let enemyTramFrontEmblemGeometry = null;
let enemyTramSpeakerHornGeometry = null;
let enemyTramSpeakerBracketGeometry = null;

function buildStreamlinedTramCabGeometry(bodyW, bodyH, length) {
    const ringCount = CAB_RING_COUNT;
    const ringSegments = CAB_RING_SEGMENTS;
    const positions = [];
    const indices = [];
    for (let ring = 0; ring < ringCount; ring++) {
        const t = ring / (ringCount - 1);
        for (let step = 0; step < ringSegments; step++) {
            // Shape comes from tram-cab-profile.js so the parts mounted on this
            // surface are fitted to the same numbers the mesh is built from.
            const point = cabRingPoint(bodyW, bodyH, length, t, step / ringSegments * Math.PI * 2);
            positions.push(point.x, point.y, point.z);
        }
    }
    for (let ring = 0; ring + 1 < ringCount; ring++) {
        for (let step = 0; step < ringSegments; step++) {
            const next = (step + 1) % ringSegments;
            const a = ring * ringSegments + step;
            const b = ring * ringSegments + next;
            const c = (ring + 1) * ringSegments + next;
            const d = (ring + 1) * ringSegments + step;
            indices.push(a, b, c, a, c, d);
        }
    }
    const tipCenter = positions.length / 3;
    const tip = cabTipPoint(bodyW, bodyH, length);
    positions.push(tip.x, tip.y, tip.z);
    const lastRing = (ringCount - 1) * ringSegments;
    for (let step = 0; step < ringSegments; step++) {
        indices.push(lastRing + step, lastRing + (step + 1) % ringSegments, tipCenter);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
}

function buildTramCabWindowGeometry(bodyH, length) {
    const tipWidth = 1.48;
    const tipBottom = 0.22;
    const tipTop = bodyH * 0.82;
    const columns = 12;
    const rows = 6;
    const positions = [];
    const indices = [];
    for (let row = 0; row <= rows; row++) {
        const yNorm = THREE.MathUtils.lerp(0.54, 0.84, row / rows);
        const y = THREE.MathUtils.lerp(tipBottom, tipTop, yNorm);
        const upperTurn = THREE.MathUtils.clamp((yNorm - 0.52) / 0.48, 0, 1) ** 1.7;
        for (let column = 0; column <= columns; column++) {
            const xNorm = THREE.MathUtils.lerp(-0.82, 0.82, column / columns);
            const x = xNorm * tipWidth / 2;
            const sideRound = 1 - 0.12 * xNorm * xNorm;
            positions.push(x, y, length * (1 - 0.38 * upperTurn) * sideRound + 0.018);
        }
    }
    for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
            const a = row * (columns + 1) + column;
            const b = a + 1;
            const c = a + columns + 2;
            const d = a + columns + 1;
            indices.push(a, b, c, a, c, d);
        }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
}

function ensureTramAssets() {
    if (tramAssets) return tramAssets;

    // TMK 2400 proportions: 20.8 m long, 2.4 m wide, three articulated
    // modules. The low-poly shell stays continuous for cheap cloning; dark
    // bellows rings below make the real three-part construction readable.
    const BODY_L = 20.8, BODY_W = 2.4, BODY_H = 3.0, ROOF_H = 0.35;
    const CAB_L = 2.35;
    const CENTER_BODY_L = BODY_L - CAB_L * 2;
    // Body sits on top of an undercarriage band (bogies/wheels live in this
    // gap visually — not modelled in detail). Everything else stacks on top.
    const UNDERCARRIAGE_H = 0.40;
    const BODY_Y0 = UNDERCARRIAGE_H;                       // body bottom
    const ROOF_TOP = BODY_Y0 + BODY_H + ROOF_H;            // pantograph base sits on this
    const WIN_H = 1.0, WIN_INSET = 0.02;
    const PANTO_Z = -BODY_L * 0.22;
    const PANTO_W = 1.8, PANTO_H = 2.0, STICK = 0.06;
    const legLen = Math.sqrt((PANTO_W / 2) ** 2 + PANTO_H ** 2);
    const legTilt = Math.atan2(PANTO_W / 2, PANTO_H);

    const buildCapsuleShape = (rOff, lOff) => {
        const r = BODY_W / 2 - rOff;
        const halfL = CENTER_BODY_L / 2 - lOff;
        const s = new THREE.Shape();
        s.moveTo(-r, -halfL + r);
        s.lineTo(-r,  halfL - r);
        s.quadraticCurveTo(-r, halfL, 0, halfL);
        s.quadraticCurveTo( r, halfL, r, halfL - r);
        s.lineTo( r, -halfL + r);
        s.quadraticCurveTo( r, -halfL, 0, -halfL);
        s.quadraticCurveTo(-r, -halfL, -r, -halfL + r);
        return s;
    };

    const bodyGeom = new THREE.ExtrudeGeometry(buildCapsuleShape(0, 0), {
        depth: BODY_H, bevelEnabled: false, curveSegments: 10,
    });
    bodyGeom.rotateX(-Math.PI / 2);

    const roofGeom = new THREE.ExtrudeGeometry(buildCapsuleShape(0.02, 0.02), {
        depth: ROOF_H, bevelEnabled: false, curveSegments: 10,
    });
    roofGeom.rotateX(-Math.PI / 2);
    const cabGeom = buildStreamlinedTramCabGeometry(BODY_W, BODY_H + ROOF_H, CAB_L);

    const WIN_LEN        = BODY_L * 0.78;
    const windowGeom     = new THREE.BoxGeometry(WIN_INSET, WIN_H, WIN_LEN);
    const pantoBaseGeom  = new THREE.BoxGeometry(PANTO_W, STICK, STICK);
    const pantoLegGeom   = new THREE.BoxGeometry(STICK, legLen, STICK);
    const pantoStripGeom = new THREE.BoxGeometry(PANTO_W + 0.3, STICK, 0.28);
    const linePlateGeom  = new THREE.PlaneGeometry(1.1, 0.55);

    // Black vertical mullions every ~2m dividing the side window strip into panes.
    const DIVIDER_SPACING = 2.0;
    const dividerCount = Math.max(1, Math.round(WIN_LEN / DIVIDER_SPACING) - 1);
    const dividerStride = WIN_LEN / (dividerCount + 1);
    const dividerOffsets = [];
    for (let i = 1; i <= dividerCount; i++) {
        dividerOffsets.push(-WIN_LEN / 2 + i * dividerStride);
    }
    const windowDividerGeom = new THREE.BoxGeometry(WIN_INSET * 2.4, WIN_H + 0.08, 0.06);

    // Front windshield + rear cab window — flat planes mounted just outside
    // the rounded ends of the capsule body. Same dark glass material as the
    // side strip, so all the trams' glazing reads consistently.
    const windshieldGeom = buildTramCabWindowGeometry(BODY_H + ROOF_H, CAB_L);
    const rearWindowGeom = buildTramCabWindowGeometry(BODY_H + ROOF_H, CAB_L);

    // Where the nose surface actually is, so the lights and the line plate can
    // be seated ON it instead of hovering at the tip plane (see
    // tram-cab-profile.js). The vertical band is the plumb stretch of the front
    // below the windscreen rake — on a real tram this is exactly where the light
    // cluster is bolted, which is why the lights get a housing there rather than
    // being glued to the inclined part above it.
    const LIGHT_MOUNT = cabLightMount(BODY_W, BODY_H + ROOF_H, CAB_L);
    const PLATE_MOUNT = cabLinePlateMount(BODY_W, BODY_H + ROOF_H, CAB_L);
    // Light housing: a shallow plinth standing on the nose's plumb band, its
    // back buried in the shell, its front face carrying the lamps.
    const lightHousingGeom = new THREE.BoxGeometry(
        LIGHT_MOUNT.housingHalfW * 2, LIGHT_MOUNT.housingH, LIGHT_MOUNT.housingD,
    );
    // Lamps sit flush on that face; narrower than the old pair, which ran off
    // the corners of a nose only 0.74 m wide at the tip.
    const headlightGeom = new THREE.BoxGeometry(LIGHT_MOUNT.lampW, LIGHT_MOUNT.lampH, 0.05);
    const taillightGeom = new THREE.BoxGeometry(LIGHT_MOUNT.lampW, LIGHT_MOUNT.lampH, 0.05);

    // Undercarriage skirt — a slim dark box filling the gap between the
    // body bottom and the rails, suggesting the bogies/wheels area.
    const skirtGeom = new THREE.BoxGeometry(BODY_W * 0.95, UNDERCARRIAGE_H, BODY_L * 0.94);

    // Four door pairs on the right (+X) side. Each pair is two narrow
    // bi-fold doors side by side with a thin frame gap between them, so
    // each pair reads as a real ~1.7 m double door instead of one wide
    // slab. Doors run from just above the skirt to near the roof. Each
    // half-door has its own inset glass panel in the upper portion.
    const DOOR_W = 0.85;                                  // Z extent of each half-door
    const DOOR_THICK = 0.05;                              // X extent
    const DOOR_GAP = 0.05;                                // gap between the two halves of a pair
    const DOOR_BOTTOM = UNDERCARRIAGE_H + 0.05;
    const DOOR_TOP    = UNDERCARRIAGE_H + BODY_H * 0.92;
    const DOOR_H      = DOOR_TOP - DOOR_BOTTOM;
    const doorGeom = new THREE.BoxGeometry(DOOR_THICK, DOOR_H, DOOR_W);
    // The fleet shell has real openings. Its leaves meet at the centre;
    // the legacy model's decorative gap was backed by a solid body panel.
    const fleetDoorGeom = new THREE.BoxGeometry(DOOR_THICK, DOOR_H, DOOR_W + DOOR_GAP);
    // Door window: small inset glass panel in upper third of each half-door.
    const DOOR_WIN_W = DOOR_W * 0.78;
    const DOOR_WIN_H = DOOR_H * 0.32;
    const doorWindowGeom = new THREE.PlaneGeometry(DOOR_WIN_W, DOOR_WIN_H);
    // Pair CENTRES along Z; each pair renders two doors at ±DOOR_HALF_OFFSET.
    const DOOR_PAIR_OFFSETS_Z = [-BODY_L * 0.34, -BODY_L * 0.115, BODY_L * 0.115, BODY_L * 0.34];
    const DOOR_HALF_OFFSET = (DOOR_W + DOOR_GAP) / 2;
    const DOOR_Y_CENTER = DOOR_BOTTOM + DOOR_H / 2;
    const DOOR_WIN_Y    = DOOR_TOP - DOOR_WIN_H / 2 - 0.10;

    const roofMat      = new THREE.MeshStandardMaterial({ color: 0x1a1a2e, roughness: 0.7 });
    const doorMat      = new THREE.MeshStandardMaterial({ color: 0x282b32, roughness: 0.55, metalness: 0.25 });
    // Tram glass — much lighter than car glass (trams traditionally have
    // less-tinted windows so passengers can see out and the city can see
    // in). Reads as cool blue-grey rather than pitch-black.
    const glassMat     = new THREE.MeshStandardMaterial({
        color: 0x6c8294, roughness: 0.20, metalness: 0.40, side: THREE.DoubleSide,
    });
    const metalMat     = new THREE.MeshStandardMaterial({ color: 0x707880, roughness: 0.45, metalness: 0.4 });
    const dividerMat   = new THREE.MeshStandardMaterial({ color: 0x0e0e12, roughness: 0.5 });
    const skirtMat     = new THREE.MeshStandardMaterial({ color: 0x202428, roughness: 0.85 });
    const bellowsGeom  = new THREE.BoxGeometry(BODY_W + 0.035, BODY_H * 0.92, 0.16);
    const headlightMat = new THREE.MeshStandardMaterial({
        color: 0xfff5d8, emissive: 0xfff5d8,
        emissiveIntensity: tramIsNight ? NIGHT_HL_INTENSITY : DAY_HL_INTENSITY,
        roughness: 0.2, metalness: 0.0,
    });
    const taillightMat = new THREE.MeshStandardMaterial({
        color: 0x801010, emissive: 0xff2020,
        emissiveIntensity: tramIsNight ? NIGHT_TL_INTENSITY : DAY_TL_INTENSITY,
        roughness: 0.3, metalness: 0.0,
    });
    sharedHeadlightMat = headlightMat;
    sharedTaillightMat = taillightMat;

    registerShared(
        bodyGeom, roofGeom, cabGeom, windowGeom, windowDividerGeom,
        windshieldGeom, rearWindowGeom, headlightGeom, taillightGeom, skirtGeom,
        lightHousingGeom,
        doorGeom, fleetDoorGeom, doorWindowGeom, bellowsGeom,
        pantoBaseGeom, pantoLegGeom, pantoStripGeom, linePlateGeom,
        roofMat, glassMat, metalMat, dividerMat, skirtMat, doorMat,
        headlightMat, taillightMat,
    );

    tramAssets = {
        BODY_L, BODY_W, BODY_H, BODY_Y0, ROOF_TOP, CAB_L, CENTER_BODY_L, PANTO_Z, PANTO_W, PANTO_H, STICK, legLen, legTilt, WIN_INSET,
        bodyGeom, roofGeom, cabGeom, windowGeom, pantoBaseGeom, pantoLegGeom, pantoStripGeom, linePlateGeom,
        windowDividerGeom, dividerOffsets,
        windshieldGeom, rearWindowGeom, headlightGeom, taillightGeom, skirtGeom,
        lightHousingGeom, LIGHT_MOUNT, PLATE_MOUNT,
        doorGeom, fleetDoorGeom, doorWindowGeom, bellowsGeom, DOOR_THICK, DOOR_PAIR_OFFSETS_Z, DOOR_HALF_OFFSET, DOOR_Y_CENTER, DOOR_WIN_Y,
        roofMat, glassMat, metalMat, dividerMat, skirtMat, doorMat, headlightMat, taillightMat,
    };
    return tramAssets;
}

function getTramBodyMaterial(cssColor, side = THREE.FrontSide) {
    const hex = cssColorToHex(cssColor);
    const key = `${hex}:${side}`;
    let mat = tramBodyMaterials.get(key);
    if (!mat) {
        mat = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.55, side });
        registerShared(mat);
        tramBodyMaterials.set(key, mat);
    }
    return mat;
}

function getEnemyTramCarriageMaterial() {
    if (!enemyTramCarriageMaterial) {
        enemyTramCarriageMaterial = new THREE.MeshStandardMaterial({
            color: 0x4c1517,
            roughness: 0.76,
            metalness: 0.18,
        });
        registerShared(enemyTramCarriageMaterial);
    }
    return enemyTramCarriageMaterial;
}

function getEnemyTramGunMaterial() {
    if (!enemyTramGunMaterial) {
        enemyTramGunMaterial = new THREE.MeshStandardMaterial({
            color: 0x151719,
            roughness: 0.44,
            metalness: 0.82,
        });
        registerShared(enemyTramGunMaterial);
    }
    return enemyTramGunMaterial;
}

function getEnemyTramWheelMaterial() {
    if (!enemyTramWheelMaterial) {
        enemyTramWheelMaterial = new THREE.MeshStandardMaterial({
            color: 0x101114,
            roughness: 0.68,
            metalness: 0.42,
        });
        registerShared(enemyTramWheelMaterial);
    }
    return enemyTramWheelMaterial;
}

function getEnemyTramMuzzleMaterial() {
    if (!enemyTramMuzzleMaterial) {
        enemyTramMuzzleMaterial = new THREE.MeshStandardMaterial({
            color: 0xffd0a0,
            emissive: 0xff3510,
            emissiveIntensity: 4.5,
            transparent: true,
            opacity: 0.96,
        });
        registerShared(enemyTramMuzzleMaterial);
    }
    return enemyTramMuzzleMaterial;
}

export function getEnemyTramBulletMaterial() {
    if (!enemyTramBulletMaterial) {
        enemyTramBulletMaterial = new THREE.MeshStandardMaterial({
            color: 0xff4430,
            emissive: 0xff1e10,
            emissiveIntensity: 3.9,
            roughness: 0.28,
        });
        registerShared(enemyTramBulletMaterial);
    }
    return enemyTramBulletMaterial;
}

export function getEnemyTramImpactMaterial() {
    if (!enemyTramImpactMaterial) {
        enemyTramImpactMaterial = new THREE.MeshStandardMaterial({
            color: 0xffb070,
            emissive: 0xff4210,
            emissiveIntensity: 3.4,
        });
        registerShared(enemyTramImpactMaterial);
    }
    return enemyTramImpactMaterial;
}

function getEnemyTramDeckGeometry() {
    if (!enemyTramDeckGeometry) {
        enemyTramDeckGeometry = new THREE.BoxGeometry(1.85, 0.26, 2.10);
        registerShared(enemyTramDeckGeometry);
    }
    return enemyTramDeckGeometry;
}

function getEnemyTramShieldGeometry() {
    if (!enemyTramShieldGeometry) {
        enemyTramShieldGeometry = new THREE.BoxGeometry(1.55, 0.86, 0.16);
        registerShared(enemyTramShieldGeometry);
    }
    return enemyTramShieldGeometry;
}

function getEnemyTramBeamGeometry() {
    if (!enemyTramBeamGeometry) {
        enemyTramBeamGeometry = new THREE.BoxGeometry(0.24, 0.18, 1.45);
        registerShared(enemyTramBeamGeometry);
    }
    return enemyTramBeamGeometry;
}

function getEnemyTramWheelGeometry() {
    if (!enemyTramWheelGeometry) {
        enemyTramWheelGeometry = new THREE.CylinderGeometry(0.28, 0.28, 0.20, 16);
        enemyTramWheelGeometry.rotateZ(Math.PI / 2);
        registerShared(enemyTramWheelGeometry);
    }
    return enemyTramWheelGeometry;
}

function getEnemyTramTurretPostGeometry() {
    if (!enemyTramTurretPostGeometry) {
        enemyTramTurretPostGeometry = new THREE.CylinderGeometry(0.13, 0.18, 0.70, 12);
        registerShared(enemyTramTurretPostGeometry);
    }
    return enemyTramTurretPostGeometry;
}

function getEnemyTramTurretBaseGeometry() {
    if (!enemyTramTurretBaseGeometry) {
        enemyTramTurretBaseGeometry = new THREE.CylinderGeometry(0.42, 0.52, 0.18, 14);
        registerShared(enemyTramTurretBaseGeometry);
    }
    return enemyTramTurretBaseGeometry;
}

function getEnemyTramReceiverGeometry() {
    if (!enemyTramReceiverGeometry) {
        enemyTramReceiverGeometry = new THREE.BoxGeometry(0.36, 0.24, 0.46);
        registerShared(enemyTramReceiverGeometry);
    }
    return enemyTramReceiverGeometry;
}

function getEnemyTramBarrelGeometry() {
    if (!enemyTramBarrelGeometry) {
        enemyTramBarrelGeometry = new THREE.CylinderGeometry(0.05, 0.07, 1.55, 12);
        enemyTramBarrelGeometry.rotateX(Math.PI / 2);
        registerShared(enemyTramBarrelGeometry);
    }
    return enemyTramBarrelGeometry;
}

function getEnemyTramMuzzleFlashGeometry() {
    if (!enemyTramMuzzleFlashGeometry) {
        enemyTramMuzzleFlashGeometry = new THREE.SphereGeometry(0.23, 10, 8);
        registerShared(enemyTramMuzzleFlashGeometry);
    }
    return enemyTramMuzzleFlashGeometry;
}

export function getEnemyTramBulletGeometry() {
    if (!enemyTramBulletGeometry) {
        enemyTramBulletGeometry = new THREE.CylinderGeometry(0.045, 0.065, 0.95, 8);
        registerShared(enemyTramBulletGeometry);
    }
    return enemyTramBulletGeometry;
}

export function getEnemyTramImpactGeometry() {
    if (!enemyTramImpactGeometry) {
        enemyTramImpactGeometry = new THREE.SphereGeometry(0.09, 6, 4);
        registerShared(enemyTramImpactGeometry);
    }
    return enemyTramImpactGeometry;
}

function getEnemyTramEmblemTexture() {
    if (enemyTramEmblemTexture) return enemyTramEmblemTexture;
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = 'rgba(86, 0, 0, 0.78)';
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.43, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 10;
    ctx.strokeStyle = 'rgba(255, 224, 96, 0.92)';
    ctx.stroke();
    ctx.fillStyle = '#ffd64a';
    ctx.font = 'bold 142px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('☭', size / 2, size * 0.54);

    enemyTramEmblemTexture = new THREE.CanvasTexture(canvas);
    enemyTramEmblemTexture.needsUpdate = true;
    registerShared(enemyTramEmblemTexture);
    return enemyTramEmblemTexture;
}

function getEnemyTramEmblemMaterial() {
    if (!enemyTramEmblemMaterial) {
        enemyTramEmblemMaterial = new THREE.MeshBasicMaterial({
            map: getEnemyTramEmblemTexture(),
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
        });
        registerShared(enemyTramEmblemMaterial);
    }
    return enemyTramEmblemMaterial;
}

function getEnemyTramSideEmblemGeometry() {
    if (!enemyTramSideEmblemGeometry) {
        enemyTramSideEmblemGeometry = new THREE.PlaneGeometry(1.20, 1.20);
        registerShared(enemyTramSideEmblemGeometry);
    }
    return enemyTramSideEmblemGeometry;
}

function getEnemyTramFrontEmblemGeometry() {
    if (!enemyTramFrontEmblemGeometry) {
        enemyTramFrontEmblemGeometry = new THREE.PlaneGeometry(0.92, 0.92);
        registerShared(enemyTramFrontEmblemGeometry);
    }
    return enemyTramFrontEmblemGeometry;
}

function getEnemyTramSpeakerHornGeometry() {
    if (!enemyTramSpeakerHornGeometry) {
        enemyTramSpeakerHornGeometry = new THREE.ConeGeometry(0.24, 0.56, 16, 1, true);
        enemyTramSpeakerHornGeometry.rotateX(Math.PI / 2);
        registerShared(enemyTramSpeakerHornGeometry);
    }
    return enemyTramSpeakerHornGeometry;
}

function getEnemyTramSpeakerBracketGeometry() {
    if (!enemyTramSpeakerBracketGeometry) {
        enemyTramSpeakerBracketGeometry = new THREE.BoxGeometry(0.10, 0.32, 0.10);
        registerShared(enemyTramSpeakerBracketGeometry);
    }
    return enemyTramSpeakerBracketGeometry;
}

export function disposeTramSessionCaches() {
    // These caches are immutable while a session is live, but streamed line
    // colours mean a later session can discover geometry/material variants the
    // warm-up session never used. Retaining those variants grows renderer
    // geometry/program counts across open/close cycles. Release the complete
    // family after every session; the next session recreates it lazily.
    const resources = new Set();
    const remember = (resource) => {
        if (resource && typeof resource.dispose === 'function') resources.add(resource);
    };
    for (const resource of tramBodyMaterials.values()) remember(resource);
    for (const resource of staticTramGeometryCache.values()) remember(resource);
    for (const resource of farTramGeometryCache.values()) remember(resource);
    for (const resource of Object.values(tramAssets || {})) remember(resource);
    for (const resource of [
        farTramMaterial,
        fleetDetailMaterial,
        fleetGlassMaterial,
        enemyTramCarriageMaterial,
        enemyTramGunMaterial,
        enemyTramWheelMaterial,
        enemyTramMuzzleMaterial,
        enemyTramBulletMaterial,
        enemyTramImpactMaterial,
        enemyTramDeckGeometry,
        enemyTramShieldGeometry,
        enemyTramBeamGeometry,
        enemyTramWheelGeometry,
        enemyTramTurretPostGeometry,
        enemyTramTurretBaseGeometry,
        enemyTramReceiverGeometry,
        enemyTramBarrelGeometry,
        enemyTramMuzzleFlashGeometry,
        enemyTramBulletGeometry,
        enemyTramImpactGeometry,
        enemyTramEmblemTexture,
        enemyTramEmblemMaterial,
        enemyTramSideEmblemGeometry,
        enemyTramFrontEmblemGeometry,
        enemyTramSpeakerHornGeometry,
        enemyTramSpeakerBracketGeometry,
    ]) remember(resource);
    for (const resource of resources) {
        unregisterShared(resource);
        resource.dispose();
    }
    tramBodyMaterials.clear();
    staticTramGeometryCache.clear();
    farTramGeometryCache.clear();
    tramAssets = null;
    farTramMaterial = null;
    fleetDetailMaterial = null;
    fleetGlassMaterial = null;
    disposeTramFleetGeometry();
    sharedHeadlightMat = null;
    sharedTaillightMat = null;
    enemyTramCarriageMaterial = null;
    enemyTramGunMaterial = null;
    enemyTramWheelMaterial = null;
    enemyTramMuzzleMaterial = null;
    enemyTramBulletMaterial = null;
    enemyTramImpactMaterial = null;
    enemyTramDeckGeometry = null;
    enemyTramShieldGeometry = null;
    enemyTramBeamGeometry = null;
    enemyTramWheelGeometry = null;
    enemyTramTurretPostGeometry = null;
    enemyTramTurretBaseGeometry = null;
    enemyTramReceiverGeometry = null;
    enemyTramBarrelGeometry = null;
    enemyTramMuzzleFlashGeometry = null;
    enemyTramBulletGeometry = null;
    enemyTramImpactGeometry = null;
    enemyTramEmblemTexture = null;
    enemyTramEmblemMaterial = null;
    enemyTramSideEmblemGeometry = null;
    enemyTramFrontEmblemGeometry = null;
    enemyTramSpeakerHornGeometry = null;
    enemyTramSpeakerBracketGeometry = null;
}

// Slides a tram's tagged door halves: ratio 0 = closed, 1 = fully open
// (each half parted DOOR_SLIDE_M from its closed spot, as if pocketed
// along the body). No-op on meshes without door tags.
const DOOR_SLIDE_M = 0.78;
export function setTramDoorsOpen(group, ratio) {
    const parts = group && group.userData && group.userData.doorParts;
    if (!parts) return;
    const r = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
    const updatedInstances = new Set();
    for (const p of parts) {
        const z = p.closedZ + p.dir * DOOR_SLIDE_M * r;
        if (Number.isInteger(p.instanceId) && p.anchor) {
            p.anchor.position.z = z;
            p.anchor.updateMatrix();
            p.mesh.setMatrixAt(p.instanceId, p.anchor.matrix);
            updatedInstances.add(p.mesh);
        } else {
            p.mesh.position.z = z;
        }
    }
    for (const mesh of updatedInstances) mesh.instanceMatrix.needsUpdate = true;
}

function mergeCompatibleTramGeometry(sourceGeometry, transform) {
    let geometry = sourceGeometry.clone();
    if (geometry.index) {
        const unindexed = geometry.toNonIndexed();
        geometry.dispose();
        geometry = unindexed;
    }
    geometry.applyMatrix4(transform);
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    if (!geometry.getAttribute('uv')) {
        geometry.setAttribute(
            'uv',
            new THREE.Float32BufferAttribute(
                new Float32Array(geometry.getAttribute('position').count * 2),
                2,
            ),
        );
    }
    for (const name of Object.keys(geometry.attributes)) {
        if (name !== 'position' && name !== 'normal' && name !== 'uv') {
            geometry.deleteAttribute(name);
        }
    }
    return geometry;
}

// Every ordinary tram used to submit roughly forty static meshes. Bake those
// immutable child transforms into one shared geometry per material family;
// the root still moves as one vehicle and animated doors remain independent.
function batchStaticTramMeshes(group, bodyMaterial) {
    group.updateMatrixWorld(true);
    const rootInverse = group.matrixWorld.clone().invert();
    const buckets = new Map();
    group.traverse((object) => {
        if (!object.isMesh || object.isInstancedMesh || object.parent !== group) return;
        if (!object.geometry || !object.material || Array.isArray(object.material)) return;
        if (object.userData.dynamicTramPart === true) return;
        const materialRole = object.material === bodyMaterial
            ? 'body'
            : object.material.uuid;
        const key = [
            materialRole,
            object.castShadow ? 1 : 0,
            object.receiveShadow ? 1 : 0,
            object.renderOrder || 0,
        ].join('|');
        if (!buckets.has(key)) {
            buckets.set(key, {
                key,
                material: object.material,
                castShadow: object.castShadow,
                receiveShadow: object.receiveShadow,
                renderOrder: object.renderOrder,
                meshes: [],
            });
        }
        buckets.get(key).meshes.push(object);
    });

    let sourceCalls = 0;
    let batchedCalls = 0;
    for (const bucket of buckets.values()) {
        sourceCalls += bucket.meshes.length;
        let geometry = staticTramGeometryCache.get(bucket.key);
        if (!geometry) {
            const transformed = bucket.meshes.map((mesh) => (
                mergeCompatibleTramGeometry(
                    mesh.geometry,
                    rootInverse.clone().multiply(mesh.matrixWorld),
                )
            ));
            geometry = mergeGeometries(transformed, false);
            for (const item of transformed) item.dispose();
            if (!geometry) continue;
            geometry.computeBoundingBox();
            geometry.computeBoundingSphere();
            registerShared(geometry);
            staticTramGeometryCache.set(bucket.key, geometry);
        }
        const mesh = new THREE.Mesh(geometry, bucket.material);
        mesh.name = 'TramStaticBatch';
        mesh.castShadow = bucket.castShadow;
        mesh.receiveShadow = bucket.receiveShadow;
        mesh.renderOrder = bucket.renderOrder;
        mesh.updateMatrix();
        mesh.matrixAutoUpdate = false;
        group.add(mesh);
        batchedCalls += 1;
        for (const source of bucket.meshes) source.removeFromParent();
    }
    group.userData.staticDrawCallsBeforeBatch = sourceCalls;
    group.userData.staticDrawCallsAfterBatch = batchedCalls;
}

function getFarTramMaterial() {
    if (!farTramMaterial) {
        farTramMaterial = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            vertexColors: true,
            roughness: 0.66,
            metalness: 0.12,
        });
        registerShared(farTramMaterial);
    }
    return farTramMaterial;
}

function buildFarTramGeometry(group, bodyMaterial) {
    const cacheKey = String(bodyMaterial.color?.getHex?.() ?? bodyMaterial.uuid);
    let geometry = farTramGeometryCache.get(cacheKey);
    if (geometry) return geometry;
    const colored = [];
    for (const object of group.children) {
        if (object.name !== 'TramStaticBatch' || !object.geometry) continue;
        const clone = object.geometry.clone();
        const position = clone.getAttribute('position');
        const color = object.material?.color || new THREE.Color(0xffffff);
        const colors = new Float32Array(position.count * 3);
        for (let index = 0; index < position.count; index += 1) {
            const offset = index * 3;
            colors[offset] = color.r;
            colors[offset + 1] = color.g;
            colors[offset + 2] = color.b;
        }
        clone.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        colored.push(clone);
    }
    geometry = mergeGeometries(colored, false);
    for (const item of colored) item.dispose();
    if (!geometry) return null;
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    registerShared(geometry);
    farTramGeometryCache.set(cacheKey, geometry);
    return geometry;
}

function addFarTramLod(group, bodyMaterial) {
    const geometry = group.userData.fleetStudy
        ? tramFleetFarGeometry(bodyMaterial.color)
        : buildFarTramGeometry(group, bodyMaterial);
    if (!geometry) return;
    const detailRoot = new THREE.Group();
    detailRoot.name = 'TramDetailedLod';
    for (const child of [...group.children]) detailRoot.add(child);
    group.add(detailRoot);

    const farMesh = new THREE.Mesh(geometry, getFarTramMaterial());
    farMesh.name = 'TramFarLod';
    farMesh.castShadow = false;
    farMesh.receiveShadow = true;
    farMesh.visible = false;
    farMesh.updateMatrix();
    farMesh.matrixAutoUpdate = false;
    group.add(farMesh);
    group.userData.detailRoot = detailRoot;
    group.userData.farMesh = farMesh;
    group.userData.renderLod = 'detail';
}

export function updateTramRenderLod(group, distanceSq, forceDetail = false) {
    const detailRoot = group?.userData?.detailRoot;
    const farMesh = group?.userData?.farMesh;
    if (!detailRoot || !farMesh) return;
    const detailed = forceDetail || distanceSq <= OTHER_TRAM_DETAIL_RADIUS_M_2;
    detailRoot.visible = detailed;
    farMesh.visible = !detailed;
    group.userData.renderLod = detailed ? 'detail' : 'far';
}

export function createTramMesh(cssColor, lineNumber, options = {}) {
    const a = ensureTramAssets();
    const group = new THREE.Group();
    const disposables = [];
    group.userData.disposables = disposables;

    // Open doors reveal the inner side of the shell and opposite windows.
    const bodyMat = getTramBodyMaterial(cssColor, options.legacy ? THREE.FrontSide : THREE.DoubleSide);

    if (!options.legacy) {
        if (!fleetDetailMaterial) {
            fleetDetailMaterial = new THREE.MeshStandardMaterial({
                color: 0xffffff, vertexColors: true, roughness: .65, metalness: .18,
            });
            fleetGlassMaterial = new THREE.MeshStandardMaterial({
                color: 0x263d4e, roughness: .22, metalness: .35, side: THREE.DoubleSide,
            });
            registerShared(fleetDetailMaterial, fleetGlassMaterial);
        }
        addTramFleetBody(group, {
            body: bodyMat, details: fleetDetailMaterial, glass: fleetGlassMaterial,
            headlight: a.headlightMat, taillight: a.taillightMat,
        });
    } else {
        // Undercarriage skirt — sits between rail level (y=0) and body bottom.
        const skirt = new THREE.Mesh(a.skirtGeom, a.skirtMat);
        skirt.position.y = a.BODY_Y0 / 2;
        skirt.castShadow = true;
        group.add(skirt);

        const body = new THREE.Mesh(a.bodyGeom, bodyMat);
        body.position.y = a.BODY_Y0;
        body.castShadow = true;
        group.add(body);

        const roof = new THREE.Mesh(a.roofGeom, a.roofMat);
        roof.position.y = a.BODY_Y0 + a.BODY_H;
        roof.castShadow = true;
        group.add(roof);

        for (const end of [-1, 1]) {
            const cab = new THREE.Mesh(a.cabGeom, bodyMat);
            cab.position.set(0, a.BODY_Y0, end * a.CENTER_BODY_L / 2);
            cab.rotation.y = end < 0 ? Math.PI : 0;
            cab.castShadow = true;
            group.add(cab);
        }

        for (const bellowsZ of [-a.BODY_L * 0.165, a.BODY_L * 0.165]) {
            const bellows = new THREE.Mesh(a.bellowsGeom, a.skirtMat);
            bellows.position.set(0, a.BODY_Y0 + a.BODY_H * 0.48, bellowsZ);
            bellows.castShadow = true;
            group.add(bellows);
        }

        // Side windows + frame mullions — slightly shorter than the old strip
        // so the body color reads as a frame above and below the glass.
        const sideWinY = a.BODY_Y0 + a.BODY_H * 0.62;
        for (const side of [-1, 1]) {
            const win = new THREE.Mesh(a.windowGeom, a.glassMat);
            win.position.set(side * (a.BODY_W / 2 + a.WIN_INSET / 2), sideWinY, 0);
            group.add(win);
            for (const off of a.dividerOffsets) {
                const pillar = new THREE.Mesh(a.windowDividerGeom, a.dividerMat);
                pillar.position.set(side * (a.BODY_W / 2 + a.WIN_INSET * 1.4), sideWinY, off);
                group.add(pillar);
            }
        }
    }

    // Four pairs of doors on the right (+X) side. Each pair is rendered
    // as two narrow half-doors with a thin gap between them — bi-fold
    // double-door style. Each half-door also gets its own inset glass
    // panel in its upper portion.
    const doorX = a.BODY_W / 2 + a.DOOR_THICK / 2 + a.WIN_INSET;
    const doorWinX = doorX + a.DOOR_THICK / 2 + 0.005;
    // Tag every door half (and its glass) so setTramDoorsOpen can slide the
    // halves of each pair apart at stops — dir is the parting direction.
    const doorParts = [];
    const doorCount = a.DOOR_PAIR_OFFSETS_Z.length * 2;
    const doorInstances = new THREE.InstancedMesh(
        options.legacy ? a.doorGeom : a.fleetDoorGeom, a.doorMat, doorCount,
    );
    doorInstances.name = 'TramDoorLeaves';
    doorInstances.castShadow = true;
    doorInstances.frustumCulled = false;
    doorInstances.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    doorInstances.userData.instanceAnchors = [];
    const doorWindowInstances = new THREE.InstancedMesh(
        a.doorWindowGeom,
        a.glassMat,
        doorCount,
    );
    doorWindowInstances.name = 'TramDoorWindows';
    doorWindowInstances.frustumCulled = false;
    doorWindowInstances.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    doorWindowInstances.userData.instanceAnchors = [];
    group.add(doorInstances, doorWindowInstances);
    let doorInstanceId = 0;
    for (const dzCentre of a.DOOR_PAIR_OFFSETS_Z) {
        for (const half of [-1, +1]) {
            const dz = dzCentre + half * a.DOOR_HALF_OFFSET;
            const doorAnchor = new THREE.Group();
            doorAnchor.name = 'TramDoorLeafAnchor';
            doorAnchor.position.set(doorX, a.DOOR_Y_CENTER, dz);
            doorAnchor.updateMatrix();
            group.add(doorAnchor);
            doorInstances.setMatrixAt(doorInstanceId, doorAnchor.matrix);
            doorInstances.userData.instanceAnchors[doorInstanceId] = doorAnchor;
            doorParts.push({
                mesh: doorInstances,
                instanceId: doorInstanceId,
                anchor: doorAnchor,
                closedZ: dz,
                dir: half,
            });

            const windowAnchor = new THREE.Group();
            windowAnchor.name = 'TramDoorWindowAnchor';
            windowAnchor.position.set(doorWinX, a.DOOR_WIN_Y, dz);
            windowAnchor.rotation.y = -Math.PI / 2;
            windowAnchor.updateMatrix();
            group.add(windowAnchor);
            doorWindowInstances.setMatrixAt(doorInstanceId, windowAnchor.matrix);
            doorWindowInstances.userData.instanceAnchors[doorInstanceId] = windowAnchor;
            doorParts.push({
                mesh: doorWindowInstances,
                instanceId: doorInstanceId,
                anchor: windowAnchor,
                closedZ: dz,
                dir: half,
            });
            doorInstanceId += 1;
        }
    }
    doorInstances.instanceMatrix.needsUpdate = true;
    doorWindowInstances.instanceMatrix.needsUpdate = true;
    group.userData.doorParts = doorParts;

    if (options.legacy) {
        // Front windshield + rear cab window — flat glass panels just outside
        // the rounded ends of the body. PlaneGeometry faces +Z by default;
        // rotate the front by π so its glassy face points outward (-Z).
        const windshield = new THREE.Mesh(a.windshieldGeom, a.glassMat);
        windshield.position.set(0, a.BODY_Y0, -a.CENTER_BODY_L / 2);
        windshield.rotation.y = Math.PI;
        group.add(windshield);
        const rearWindow = new THREE.Mesh(a.rearWindowGeom, a.glassMat);
        rearWindow.position.set(0, a.BODY_Y0, +a.CENTER_BODY_L / 2);
        group.add(rearWindow);

        // Lights: a housing seated on the nose's vertical face, lamps flush on it.
        // Everything below is in cab-local metres converted to group space, so the
        // parts follow the shell instead of the old fixed -BODY_L/2 tip plane, where
        // they hung in front of the vehicle.
        //   local y -> group y : + BODY_Y0
        //   local z -> group z : ±(CENTER_BODY_L/2 + z), front end negative
        const noseY = (localY) => a.BODY_Y0 + localY;
        const noseZ = (localZ, end) => end * (a.CENTER_BODY_L / 2 + localZ);
        const mountLights = a.LIGHT_MOUNT;
        const lightY = noseY(mountLights.y);
        for (const end of [-1, 1]) {
            const housing = new THREE.Mesh(a.lightHousingGeom, bodyMat);
            // Front face flush with the plumb band, body buried behind it.
            housing.position.set(
                0,
                lightY,
                noseZ(mountLights.faceZ - mountLights.housingD / 2, end),
            );
            housing.castShadow = true;
            group.add(housing);
            for (const sx of [-1, 1]) {
                const lamp = new THREE.Mesh(
                    end < 0 ? a.headlightGeom : a.taillightGeom,
                    end < 0 ? a.headlightMat : a.taillightMat,
                );
                lamp.position.set(sx * mountLights.lampX, lightY, noseZ(mountLights.faceZ + 0.012, end));
                group.add(lamp);
            }
        }

        const pantoBase = new THREE.Mesh(a.pantoBaseGeom, a.metalMat);
        pantoBase.position.set(0, a.ROOF_TOP + a.STICK / 2, a.PANTO_Z);
        group.add(pantoBase);
        for (const side of [-1, 1]) {
            const leg = new THREE.Mesh(a.pantoLegGeom, a.metalMat);
            leg.position.set(side * a.PANTO_W / 4, a.ROOF_TOP + a.PANTO_H / 2, a.PANTO_Z);
            leg.rotation.z = -side * a.legTilt;
            group.add(leg);
        }
        const pantoStrip = new THREE.Mesh(a.pantoStripGeom, a.metalMat);
        pantoStrip.position.set(0, a.ROOF_TOP + a.PANTO_H, a.PANTO_Z);
        group.add(pantoStrip);
    }

    // Line number plate — a destination box high on the windscreen rake, just
    // below the roof line. Draped on the shell: both its depth and its tilt come
    // from the nose profile, so it lies flush instead of standing 0.89 m ahead of
    // the vehicle at a height the shell does not even reach (which is where the
    // fixed -BODY_L/2 placement put it).
    if (lineNumber != null) {
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#f5a800';
        ctx.fillRect(0, 0, 128, 64);
        ctx.fillStyle = '#000000';
        ctx.font = 'bold 46px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(lineNumber), 64, 34);
        const tex = new THREE.CanvasTexture(canvas);
        const lineMat = new THREE.MeshBasicMaterial({ map: tex });
        const numMesh = new THREE.Mesh(a.linePlateGeom, lineMat);
        numMesh.name = 'TramLinePlate';
        numMesh.userData.dynamicTramPart = true;
        if (options.legacy) {
            const mount = a.PLATE_MOUNT;
            numMesh.position.set(0, a.BODY_Y0 + mount.y, -(a.CENTER_BODY_L / 2 + mount.z + 0.012));
            numMesh.rotation.y = Math.PI;
            numMesh.rotation.x = mount.rakeRad;
        } else {
            const mount = tramFleetSurface(new THREE.Vector3(0, 2.75, -20), new THREE.Vector3(0, 0, 1));
            numMesh.position.copy(mount.point).addScaledVector(mount.normal, .018);
            numMesh.lookAt(numMesh.position.clone().add(mount.normal));
        }
        group.add(numMesh);
        disposables.push(tex, lineMat);
    }

    if (options.enemy) {
        addEnemyTramEmblems(group, a);
        addEnemyTramLoudspeakers(group, a);
        addEnemyGunCarriage(group, a);
    }
    group.userData.enemyTram = !!options.enemy;
    group.userData.tramFrontExtentM = options.enemy ? ENEMY_TRAM_FRONT_EXTENT_M : TRAM_FRONT_EXTENT_M;
    group.userData.tramRearExtentM = options.enemy ? ENEMY_TRAM_REAR_EXTENT_M : TRAM_REAR_EXTENT_M;
    group.userData.tramHalfWidthM = TRAM_COLLISION_HALF_WIDTH_M;
    group.userData.enemyMusicTrackIndex = options.enemy
        ? Math.floor(Math.random() * (options.enemyMusicTrackCount ?? 1))
        : 0;
    group.userData.tramMaxHealth = TRAM_MAX_HEALTH;
    group.userData.tramHealth = TRAM_MAX_HEALTH;

    if (!options.enemy) {
        if (options.legacy) batchStaticTramMeshes(group, bodyMat);
        addFarTramLod(group, bodyMat);
    }

    return group;
}

// The original model remains an explicit viewer variant, never a loading fallback.
export function createLegacyTramMesh(cssColor, lineNumber, options = {}) {
    return createTramMesh(cssColor, lineNumber, { ...options, legacy: true });
}

function addEnemyTramEmblems(group, a) {
    const mat = getEnemyTramEmblemMaterial();
    const sideY = a.BODY_Y0 + a.BODY_H * 0.42;
    const sideZ = a.BODY_L * 0.18;
    for (const side of [-1, 1]) {
        const emblem = new THREE.Mesh(getEnemyTramSideEmblemGeometry(), mat);
        if (group.userData.fleetStudy) {
            const mount = tramFleetSurface(new THREE.Vector3(side * 3, sideY, sideZ), new THREE.Vector3(-side, 0, 0));
            emblem.position.copy(mount.point).addScaledVector(mount.normal, .025);
            emblem.lookAt(emblem.position.clone().add(mount.normal));
        } else {
            emblem.position.set(side * (a.BODY_W / 2 + 0.055), sideY, sideZ);
            emblem.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
        }
        emblem.renderOrder = 26;
        group.add(emblem);
    }

    const front = new THREE.Mesh(getEnemyTramFrontEmblemGeometry(), mat);
    if (group.userData.fleetStudy) {
        const mount = tramFleetSurface(new THREE.Vector3(0, a.BODY_Y0 + a.BODY_H * .47, -20), new THREE.Vector3(0, 0, 1));
        front.position.copy(mount.point).addScaledVector(mount.normal, .025);
        front.lookAt(front.position.clone().add(mount.normal));
    } else {
        front.position.set(0, a.BODY_Y0 + a.BODY_H * 0.47, -a.BODY_L / 2 - 0.075);
        front.rotation.y = Math.PI;
    }
    front.renderOrder = 26;
    group.add(front);
}

function addEnemyTramLoudspeakers(group, a) {
    const mat = getEnemyTramGunMaterial();
    const y = a.BODY_Y0 + a.BODY_H + 0.36;
    const z = group.userData.fleetStudy ? -7.7 : -a.BODY_L / 2 - 0.22;
    for (const side of [-1, 1]) {
        const bracket = new THREE.Mesh(getEnemyTramSpeakerBracketGeometry(), mat);
        bracket.position.set(side * 0.78, y - 0.20, z + 0.16);
        bracket.castShadow = true;
        group.add(bracket);

        const horn = new THREE.Mesh(getEnemyTramSpeakerHornGeometry(), mat);
        horn.position.set(side * 0.78, y, z);
        horn.rotation.y = Math.PI + side * 0.10;
        horn.castShadow = true;
        group.add(horn);
    }
}


function addEnemyGunCarriage(group, a) {
    const carriage = new THREE.Group();
    carriage.position.set(0, 0, -a.BODY_L / 2 - 1.70);
    group.add(carriage);

    const carriageMat = getEnemyTramCarriageMaterial();
    const gunMat = getEnemyTramGunMaterial();
    const wheelMat = getEnemyTramWheelMaterial();

    const deck = new THREE.Mesh(getEnemyTramDeckGeometry(), carriageMat);
    deck.position.set(0, 0.45, 0);
    deck.castShadow = true;
    carriage.add(deck);

    const shield = new THREE.Mesh(getEnemyTramShieldGeometry(), carriageMat);
    shield.position.set(0, 1.02, -0.68);
    shield.rotation.x = -0.08;
    shield.castShadow = true;
    carriage.add(shield);

    const beam = new THREE.Mesh(getEnemyTramBeamGeometry(), carriageMat);
    beam.position.set(0, 0.48, 1.42);
    beam.castShadow = true;
    carriage.add(beam);

    for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
            const wheel = new THREE.Mesh(getEnemyTramWheelGeometry(), wheelMat);
            wheel.position.set(sx * 0.98, 0.25, sz * 0.68);
            wheel.castShadow = true;
            carriage.add(wheel);
        }
    }

    const post = new THREE.Mesh(getEnemyTramTurretPostGeometry(), gunMat);
    post.position.set(0, 0.98, -0.08);
    post.castShadow = true;
    carriage.add(post);

    const turret = new THREE.Group();
    turret.position.set(0, 1.36, -0.08);
    carriage.add(turret);

    const base = new THREE.Mesh(getEnemyTramTurretBaseGeometry(), gunMat);
    base.castShadow = true;
    turret.add(base);

    const receiver = new THREE.Mesh(getEnemyTramReceiverGeometry(), gunMat);
    receiver.position.set(0, 0.18, 0.16);
    receiver.castShadow = true;
    turret.add(receiver);

    const barrel = new THREE.Mesh(getEnemyTramBarrelGeometry(), gunMat);
    barrel.position.set(0, 0.18, 0.94);
    barrel.castShadow = true;
    turret.add(barrel);

    const flash = new THREE.Mesh(getEnemyTramMuzzleFlashGeometry(), getEnemyTramMuzzleMaterial());
    flash.position.set(0, 0.18, 1.74);
    flash.visible = false;
    turret.add(flash);

    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.18, 1.82);
    turret.add(muzzle);

    group.userData.enemyTramWeapon = {
        yawGroup: turret,
        muzzle,
        flash,
        flashTtl: 0,
        nextShotAt: performance.now() / 1000 + Math.random() * 2.0,
        burstRemaining: 0,
    };
}


export const TRAM_HALF_LENGTH_M = 9.0;
export const TRAM_HALF_WIDTH_M  = 1.2;
export const TRAM_FRONT_EXTENT_M = 10.5;
export const TRAM_REAR_EXTENT_M  = 10.5;
export const TRAM_COLLISION_HALF_WIDTH_M = 1.3;
export const ENEMY_TRAM_FRONT_EXTENT_M = 11.8;
export const ENEMY_TRAM_REAR_EXTENT_M  = 9.1;
