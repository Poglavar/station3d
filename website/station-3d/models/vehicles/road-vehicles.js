// Reusable road vehicle model catalog and mesh factories. Traffic graph,
// placement, physics, damage, and world lifecycle remain in world/cars.js.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { registerShared, unregisterShared } from '../../core/dispose.js';
import { trafficVehicleVerticalLayout } from '../../core/traffic-vehicle-profile.js';
import { createBicycleMesh } from './bicycle.js';
import { createRoadFleetDetail, disposeRoadFleetModels } from './road-fleet-models.js';
export { preloadRoadFleetModels } from './road-fleet-models.js';

const WHEEL_RADIUS = 0.32;
const CHASSIS_SHOULDER_RATIO = 0.25;
const carBodyMaterials = {};
let headlightMaterial = null, taillightMaterial = null, glassMaterial = null;
let fleetDetailMaterial = null;
let roadVehicleNight = false;
let enemyGunMaterial = null, enemyMuzzleMaterial = null, enemyBulletMaterial = null, enemyImpactMaterial = null;
let technicalEmblemTexture = null, technicalEmblemMaterial = null;
const chassisGeometries = {}, cabinGeometries = {}, farTrafficGeometries = {};
let technicalBedGeometry = null, enemyTurretBaseGeometry = null, enemyTurretPostGeometry = null, enemyTurretReceiverGeometry = null, enemyTurretBarrelGeometry = null, enemyMuzzleFlashGeometry = null, enemyBulletGeometry = null, enemyImpactGeometry = null, technicalDoorEmblemGeometry = null, technicalHoodEmblemGeometry = null, technicalSpeakerHornGeometry = null, technicalSpeakerBracketGeometry = null;


// ─── Material caches ───────────────────────────────────────────────────────


function getCarBodyMaterial(hex) {
    if (!carBodyMaterials[hex]) {
        const mat = new THREE.MeshStandardMaterial({
            color: hex, roughness: 0.5, metalness: 0.4,
        });
        registerShared(mat);
        carBodyMaterials[hex] = mat;
    }
    return carBodyMaterials[hex];
}

function getHeadlightMaterial() {
    if (!headlightMaterial) {
        headlightMaterial = new THREE.MeshStandardMaterial({
            color: 0xfff5d8,
            emissive: 0xfff5d8,
            emissiveIntensity: roadVehicleNight ? 1.4 : 0,
            roughness: 0.2, metalness: 0.0,
        });
        registerShared(headlightMaterial);
    }
    return headlightMaterial;
}

function getTaillightMaterial() {
    if (!taillightMaterial) {
        taillightMaterial = new THREE.MeshStandardMaterial({
            color: 0x801010,
            emissive: 0xff2020,
            emissiveIntensity: roadVehicleNight ? 1.1 : 0.4,
            roughness: 0.3, metalness: 0.0,
        });
        registerShared(taillightMaterial);
    }
    return taillightMaterial;
}

function getGlassMaterial() {
    if (!glassMaterial) {
        glassMaterial = new THREE.MeshStandardMaterial({
            color: 0x14181c,           // dark blue-black tint
            roughness: 0.18,           // smooth, glassy
            metalness: 0.65,           // some reflectivity (env-map would help; we don't have one)
            // Opaque exterior tint hides the unoccupied ambient cabin. Front
            // faces let a camera inside the shell see out from behind.
            side: THREE.FrontSide,
        });
        registerShared(glassMaterial);
    }
    return glassMaterial;
}

function getFleetDetailMaterial() {
    if (!fleetDetailMaterial) {
        fleetDetailMaterial = new THREE.MeshStandardMaterial({
            color: 0xffffff, vertexColors: true, roughness: 0.62, metalness: 0.15,
        });
        registerShared(fleetDetailMaterial);
    }
    return fleetDetailMaterial;
}

// Builds a frustum-like box: 8 corners with the top quad scaled (and
// optionally shifted in Z) relative to the bottom quad. Vertices are NOT
// shared between faces, so computeVertexNormals yields per-face flat
// shading rather than smoothed corners — important for the "panelled"
// look cars need.
//
// Origin: bottom-centre of the box (X=Y=Z=0 sits at chassis bottom-centre).
function makeTaperedBox({
    width, height, length,
    topWidthRatio = 1, topLengthRatio = 1,
    frontTopOffset = 0, rearTopOffset = 0,
}) {
    const w2 = width / 2, l2 = length / 2;
    const tw2 = (width * topWidthRatio) / 2;
    const tl2 = (length * topLengthRatio) / 2;

    // 8 corners: 0..3 = bottom (front-right, front-left, rear-left, rear-right),
    //            4..7 = corresponding top corners
    const c = [
        [+w2, 0, +l2], [-w2, 0, +l2], [-w2, 0, -l2], [+w2, 0, -l2],
        [+tw2, height, +tl2 + frontTopOffset],
        [-tw2, height, +tl2 + frontTopOffset],
        [-tw2, height, -tl2 + rearTopOffset],
        [+tw2, height, -tl2 + rearTopOffset],
    ];

    // Faces as quads of corner indices, each ordered CCW from outside.
    const faces = [
        [0, 1, 2, 3],   // bottom (-Y outward)
        [4, 7, 6, 5],   // top    (+Y outward)
        [1, 0, 4, 5],   // front  (+Z outward)
        [3, 2, 6, 7],   // back   (-Z outward)
        [0, 3, 7, 4],   // right  (+X outward)
        [2, 1, 5, 6],   // left   (-X outward)
    ];

    const positions = [];
    for (const f of faces) {
        const v0 = c[f[0]], v1 = c[f[1]], v2 = c[f[2]], v3 = c[f[3]];
        // Quad as two CCW triangles
        positions.push(...v0, ...v1, ...v2);
        positions.push(...v0, ...v2, ...v3);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    // Re-centre Y so the box's centre is at y=0, matching the BoxGeometry
    // convention the parent code positions everything against.
    geo.translate(0, -height / 2, 0);
    return geo;
}

// Smooth-shaded version of makeTaperedBox. Indexed/shared vertices so
// computeVertexNormals averages corner normals, giving the cabin
// (greenhouse) a curved/Gouraud-shaded look rather than hard panel
// breaks. Used for the cabin where rounded silhouette reads as a modern
// car superstructure.
function makeSmoothTaperedBox({
    width, height, length,
    topWidthRatio = 1, topLengthRatio = 1,
    frontTopOffset = 0, rearTopOffset = 0,
}) {
    const w2 = width / 2, l2 = length / 2;
    const tw2 = (width * topWidthRatio) / 2;
    const tl2 = (length * topLengthRatio) / 2;
    const c = [
        [+w2, 0, +l2], [-w2, 0, +l2], [-w2, 0, -l2], [+w2, 0, -l2],
        [+tw2, height, +tl2 + frontTopOffset],
        [-tw2, height, +tl2 + frontTopOffset],
        [-tw2, height, -tl2 + rearTopOffset],
        [+tw2, height, -tl2 + rearTopOffset],
    ];
    const faces = [
        [0, 1, 2, 3],     // bottom
        [4, 7, 6, 5],     // top
        [1, 0, 4, 5],     // front
        [3, 2, 6, 7],     // back
        [0, 3, 7, 4],     // right
        [2, 1, 5, 6],     // left
    ];
    const positions = [];
    for (const v of c) positions.push(...v);
    const indices = [];
    for (const f of faces) {
        indices.push(f[0], f[1], f[2]);
        indices.push(f[0], f[2], f[3]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    geo.translate(0, -height / 2, 0);
    return geo;
}

// Bilinear interpolation across a quad's 4 corners ([BL, BR, TR, TL]).
function bilerp(corners, u, v) {
    const oneU = 1 - u, oneV = 1 - v;
    const w00 = oneU * oneV, w10 = u * oneV, w11 = u * v, w01 = oneU * v;
    return [
        w00 * corners[0][0] + w10 * corners[1][0] + w11 * corners[2][0] + w01 * corners[3][0],
        w00 * corners[0][1] + w10 * corners[1][1] + w11 * corners[2][1] + w01 * corners[3][1],
        w00 * corners[0][2] + w10 * corners[1][2] + w11 * corners[2][2] + w01 * corners[3][2],
    ];
}

function makeShoulderedTaperedBox({
    width, height, length,
    topWidthRatio = 1, topLengthRatio = 1,
    frontTopOffset = 0, rearTopOffset = 0,
    shoulderRatio = 0.5,
}) {
    const w2 = width / 2, l2 = length / 2;
    const tw2 = (width * topWidthRatio) / 2;
    const tl2 = (length * topLengthRatio) / 2;
    const sh = height * shoulderRatio;

    // 12 corners: bottom (0..3) at full dims, shoulder (4..7) at full
    // dims, top (8..11) at tapered dims with optional Z offsets.
    const c = [
        [+w2, 0,  +l2], [-w2, 0,  +l2], [-w2, 0,  -l2], [+w2, 0,  -l2],
        [+w2, sh, +l2], [-w2, sh, +l2], [-w2, sh, -l2], [+w2, sh, -l2],
        [+tw2, height, +tl2 + frontTopOffset],
        [-tw2, height, +tl2 + frontTopOffset],
        [-tw2, height, -tl2 + rearTopOffset],
        [+tw2, height, -tl2 + rearTopOffset],
    ];

    // Faces in CCW-from-outside order (matching makeTaperedBox convention).
    // Each side wall is split into a vertical lower half + a tapered upper
    // half so the shoulder line is real geometry — the smooth-shaded
    // averaged normals give it a curved look.
    const faces = [
        [0, 1, 2, 3],         // bottom (-Y)
        [8, 11, 10, 9],       // top (+Y)
        [1, 0, 4, 5],         // front lower (+Z)
        [5, 4, 8, 9],         // front upper (+Z slanted)
        [3, 2, 6, 7],         // back lower (-Z)
        [7, 6, 10, 11],       // back upper (-Z slanted)
        [0, 3, 7, 4],         // right lower (+X)
        [4, 7, 11, 8],        // right upper (+X slanted)
        [2, 1, 5, 6],         // left lower (-X)
        [6, 5, 9, 10],        // left upper (-X slanted)
    ];

    const positions = [];
    for (const v of c) positions.push(...v);
    const indices = [];
    for (const f of faces) {
        indices.push(f[0], f[1], f[2]);
        indices.push(f[0], f[2], f[3]);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    geo.translate(0, -height / 2, 0);
    return geo;
}

function getChassisGeometry(type) {
    const k = type.name;
    if (!chassisGeometries[k]) {
        // Shouldered + smooth-shaded: lower portion vertical (sharp bottom
        // edge by the wheels), upper portion tapers to the top with
        // averaged corner normals so the hood/trunk slopes read as curves.
        // chassisFrontSlant / chassisRearSlant let the front and rear
        // ends of the top edge slide independently, giving sedans a long
        // hood and short trunk rather than a symmetric profile.
        const g = makeShoulderedTaperedBox({
            width: type.width, height: type.chassisH, length: type.length,
            topWidthRatio: type.chassisTopWidth,
            topLengthRatio: type.chassisTopLen,
            frontTopOffset: type.chassisFrontSlant || 0,
            rearTopOffset: type.chassisRearSlant || 0,
            shoulderRatio: CHASSIS_SHOULDER_RATIO,
        });
        registerShared(g);
        chassisGeometries[k] = g;
    }
    return chassisGeometries[k];
}

function getCabinGeometry(type) {
    const k = type.name;
    if (!cabinGeometries[k]) {
        // Smooth-shaded plain frustum — no shoulder line, since the cabin
        // IS the greenhouse (mostly glass with a thin frame); the belt
        // line is now where the cabin meets the chassis below.
        const g = makeSmoothTaperedBox({
            width: type.width * 0.92, height: type.cabinH, length: type.cabinLen,
            topWidthRatio: type.cabinTopWidth,
            topLengthRatio: type.cabinTopLen,
            frontTopOffset: type.cabinFrontSlant,
            rearTopOffset: type.cabinRearSlant,
        });
        registerShared(g);
        cabinGeometries[k] = g;
    }
    return cabinGeometries[k];
}

// Per-vehicle-type window geometry: 4 inset quads (front windshield,
// rear window, left + right side windows) bundled into one BufferGeometry
// so each car only adds ONE additional mesh for its windows. Quads sit
// 5 mm outside the cabin face so they don't z-fight the body.
function getTechnicalBedGeometry(type) {
    if (!technicalBedGeometry) {
        technicalBedGeometry = new THREE.BoxGeometry(type.width * 0.84, 0.18, type.length * 0.40);
        registerShared(technicalBedGeometry);
    }
    return technicalBedGeometry;
}

function getEnemyGunMaterial() {
    if (!enemyGunMaterial) {
        enemyGunMaterial = new THREE.MeshStandardMaterial({
            color: 0x181a17,
            roughness: 0.48,
            metalness: 0.78,
        });
        registerShared(enemyGunMaterial);
    }
    return enemyGunMaterial;
}

function getEnemyMuzzleMaterial() {
    if (!enemyMuzzleMaterial) {
        enemyMuzzleMaterial = new THREE.MeshStandardMaterial({
            color: 0xffd0a0,
            emissive: 0xff4018,
            emissiveIntensity: 4.0,
            transparent: true,
            opacity: 0.95,
        });
        registerShared(enemyMuzzleMaterial);
    }
    return enemyMuzzleMaterial;
}

function getEnemyTurretBaseGeometry() {
    if (!enemyTurretBaseGeometry) {
        enemyTurretBaseGeometry = new THREE.CylinderGeometry(0.42, 0.50, 0.18, 14);
        registerShared(enemyTurretBaseGeometry);
    }
    return enemyTurretBaseGeometry;
}

function getEnemyTurretPostGeometry() {
    if (!enemyTurretPostGeometry) {
        enemyTurretPostGeometry = new THREE.CylinderGeometry(0.12, 0.17, 0.62, 12);
        registerShared(enemyTurretPostGeometry);
    }
    return enemyTurretPostGeometry;
}

function getEnemyTurretReceiverGeometry() {
    if (!enemyTurretReceiverGeometry) {
        enemyTurretReceiverGeometry = new THREE.BoxGeometry(0.32, 0.22, 0.42);
        registerShared(enemyTurretReceiverGeometry);
    }
    return enemyTurretReceiverGeometry;
}

function getEnemyTurretBarrelGeometry() {
    if (!enemyTurretBarrelGeometry) {
        enemyTurretBarrelGeometry = new THREE.CylinderGeometry(0.045, 0.065, 1.35, 12);
        enemyTurretBarrelGeometry.rotateX(Math.PI / 2);
        registerShared(enemyTurretBarrelGeometry);
    }
    return enemyTurretBarrelGeometry;
}

function getEnemyMuzzleFlashGeometry() {
    if (!enemyMuzzleFlashGeometry) {
        enemyMuzzleFlashGeometry = new THREE.SphereGeometry(0.20, 10, 8);
        registerShared(enemyMuzzleFlashGeometry);
    }
    return enemyMuzzleFlashGeometry;
}

export function getEnemyBulletGeometry() {
    if (!enemyBulletGeometry) {
        enemyBulletGeometry = new THREE.CylinderGeometry(0.04, 0.055, 0.85, 8);
        registerShared(enemyBulletGeometry);
    }
    return enemyBulletGeometry;
}

export function getEnemyBulletMaterial() {
    if (!enemyBulletMaterial) {
        enemyBulletMaterial = new THREE.MeshStandardMaterial({
            color: 0xff5538,
            emissive: 0xff2a12,
            emissiveIntensity: 3.6,
            roughness: 0.30,
        });
        registerShared(enemyBulletMaterial);
    }
    return enemyBulletMaterial;
}

export function getEnemyImpactGeometry() {
    if (!enemyImpactGeometry) {
        enemyImpactGeometry = new THREE.SphereGeometry(0.08, 6, 4);
        registerShared(enemyImpactGeometry);
    }
    return enemyImpactGeometry;
}

export function getEnemyImpactMaterial() {
    if (!enemyImpactMaterial) {
        enemyImpactMaterial = new THREE.MeshStandardMaterial({
            color: 0xffb070,
            emissive: 0xff4010,
            emissiveIntensity: 3.2,
        });
        registerShared(enemyImpactMaterial);
    }
    return enemyImpactMaterial;
}

function getTechnicalEmblemTexture() {
    if (technicalEmblemTexture) return technicalEmblemTexture;
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = 'rgba(82, 0, 0, 0.84)';
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.43, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 10;
    ctx.strokeStyle = 'rgba(255, 222, 82, 0.96)';
    ctx.stroke();
    ctx.fillStyle = '#ffd64a';
    ctx.font = 'bold 142px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('☭', size / 2, size * 0.54);

    technicalEmblemTexture = new THREE.CanvasTexture(canvas);
    technicalEmblemTexture.needsUpdate = true;
    registerShared(technicalEmblemTexture);
    return technicalEmblemTexture;
}

function getTechnicalEmblemMaterial() {
    if (!technicalEmblemMaterial) {
        technicalEmblemMaterial = new THREE.MeshBasicMaterial({
            map: getTechnicalEmblemTexture(),
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1,
        });
        registerShared(technicalEmblemMaterial);
    }
    return technicalEmblemMaterial;
}

function getTechnicalDoorEmblemGeometry() {
    if (!technicalDoorEmblemGeometry) {
        technicalDoorEmblemGeometry = new THREE.PlaneGeometry(0.58, 0.58);
        registerShared(technicalDoorEmblemGeometry);
    }
    return technicalDoorEmblemGeometry;
}

function getTechnicalHoodEmblemGeometry() {
    if (!technicalHoodEmblemGeometry) {
        technicalHoodEmblemGeometry = new THREE.PlaneGeometry(0.82, 0.82);
        registerShared(technicalHoodEmblemGeometry);
    }
    return technicalHoodEmblemGeometry;
}

function getTechnicalSpeakerHornGeometry() {
    if (!technicalSpeakerHornGeometry) {
        technicalSpeakerHornGeometry = new THREE.ConeGeometry(0.18, 0.42, 16, 1, true);
        technicalSpeakerHornGeometry.rotateX(-Math.PI / 2);
        registerShared(technicalSpeakerHornGeometry);
    }
    return technicalSpeakerHornGeometry;
}

function getTechnicalSpeakerBracketGeometry() {
    if (!technicalSpeakerBracketGeometry) {
        technicalSpeakerBracketGeometry = new THREE.BoxGeometry(0.09, 0.24, 0.09);
        registerShared(technicalSpeakerBracketGeometry);
    }
    return technicalSpeakerBracketGeometry;
}

// ─── Vehicle assembly ──────────────────────────────────────────────────────

function farTrafficGeometryPart(source, transform) {
    let geometry = source.clone();
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

function getFarTrafficGeometry(type) {
    const key = String(type?.name || 'vehicle');
    if (farTrafficGeometries[key]) return farTrafficGeometries[key];
    const vertical = trafficVehicleVerticalLayout(type, WHEEL_RADIUS);
    const chassisTransform = new THREE.Matrix4().makeTranslation(
        0,
        vertical.chassisCenterY,
        0,
    );
    const cabinTransform = new THREE.Matrix4().makeTranslation(
        0,
        vertical.cabinCenterY,
        type.cabinZ,
    );
    const parts = [
        farTrafficGeometryPart(getChassisGeometry(type), chassisTransform),
        farTrafficGeometryPart(getCabinGeometry(type), cabinTransform),
    ];
    const geometry = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    if (!geometry) return null;
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    registerShared(geometry);
    farTrafficGeometries[key] = geometry;
    return geometry;
}

function addTrafficVehicleFarLod(group, type, bodyMaterial) {
    const geometry = getFarTrafficGeometry(type);
    if (!geometry) return;
    const detailRoot = new THREE.Group();
    detailRoot.name = 'TrafficVehicleDetailedLod';
    for (const child of [...group.children]) detailRoot.add(child);
    group.add(detailRoot);
    const farMesh = new THREE.Mesh(geometry, bodyMaterial);
    farMesh.name = 'TrafficVehicleFarLod';
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

function updateTrafficVehicleLod(car, observerX, observerZ, detailRadiusM) {
    const detailRoot = car?.mesh?.userData?.detailRoot;
    const farMesh = car?.mesh?.userData?.farMesh;
    if (!detailRoot || !farMesh) return;
    const dx = car.mesh.position.x - observerX;
    const dz = car.mesh.position.z - observerZ;
    const detailed = car.controlled === true
        || car.physicsControlled === true
        || dx * dx + dz * dz <= detailRadiusM * detailRadiusM;
    detailRoot.visible = detailed;
    farMesh.visible = !detailed;
    car.mesh.userData.renderLod = detailed ? 'detail' : 'far';
}

export function updateTrafficVehicleLods(observerX, observerZ, globalCars = [], parkedCars = new Map(), detailRadiusM = 60) {
    for (const car of globalCars) updateTrafficVehicleLod(car, observerX, observerZ, detailRadiusM);
    for (const car of parkedCars.values()) updateTrafficVehicleLod(car, observerX, observerZ, detailRadiusM);
}

export function buildCarMesh(type, hex) {
    // Fixed emergency paint still shares materials across identical liveries.
    const paintHex = type.paintHex != null ? type.paintHex : hex;
    const bodyMat = getCarBodyMaterial(paintHex);
    const group = createRoadFleetDetail(type, {
        body: bodyMat, details: getFleetDetailMaterial(), glass: getGlassMaterial(),
        headlight: getHeadlightMaterial(), taillight: getTaillightMaterial(),
    });

    if (type.livery) {
        addLivery(group, type);
    }
    if (type.enemy) {
        addTechnicalEmblems(group, type);
        addTechnicalLoudspeakers(group, type);
        addTechnicalTurret(group, type);
    }

    addTrafficVehicleFarLod(group, type, bodyMat);

    return group;
}

export function buildTrafficVehicleMesh(type, hex) {
    return type?.kind === 'bicycle'
        ? createBicycleMesh(type, hex)
        : buildCarMesh(type, hex);
}

function modelVerticalLayout(group, type) {
    const layout = trafficVehicleVerticalLayout(type, WHEEL_RADIUS);
    const geometry = group.getObjectByName('TrafficVehiclePaintedBody').geometry;
    const roofY = geometry.boundingBox.max.y;
    const positions = geometry.getAttribute('position');
    let front = -Infinity, rear = Infinity;
    for (let i = 0; i < positions.count; i++) {
        if (positions.getY(i) < roofY - 0.02) continue;
        front = Math.max(front, positions.getZ(i));
        rear = Math.min(rear, positions.getZ(i));
    }
    const scale = roofY / layout.roofY;
    return {
        ...Object.fromEntries(Object.entries(layout).map(([name, value]) => [name, value * scale])),
        roofZ: (front + rear) / 2,
    };
}

function bodySurfaceAt(group, z) {
    const body = group.getObjectByName('TrafficVehiclePaintedBody');
    const ray = new THREE.Raycaster(
        new THREE.Vector3(0, body.geometry.boundingBox.max.y + 1, z),
        new THREE.Vector3(0, -1, 0),
    );
    const hit = ray.intersectObject(body, false)[0];
    if (!hit) throw new Error(`Road-fleet body has no mounting surface at ${z}`);
    return hit;
}

function addTechnicalEmblems(group, type) {
    const vertical = modelVerticalLayout(group, type);
    const mat = getTechnicalEmblemMaterial();
    const doorGeo = getTechnicalDoorEmblemGeometry();
    const sideX = type.width / 2 + 0.010;
    const doorY = vertical.chassisBottomY + (vertical.beltY - vertical.chassisBottomY) * 0.56;
    const doorZ = vertical.roofZ;
    for (const side of [-1, 1]) {
        const door = new THREE.Mesh(doorGeo, mat);
        door.position.set(side * sideX, doorY, doorZ);
        door.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
        door.renderOrder = 24;
        group.add(door);
    }

    const hood = new THREE.Mesh(getTechnicalHoodEmblemGeometry(), mat);
    const hoodZ = type.length * 0.4;
    const hoodSurface = bodySurfaceAt(group, hoodZ);
    hood.position.copy(hoodSurface.point).addScaledVector(hoodSurface.face.normal, 0.008);
    hood.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), hoodSurface.face.normal);
    hood.renderOrder = 24;
    group.add(hood);
}

function addTechnicalLoudspeakers(group, type) {
    const mat = getEnemyGunMaterial();
    const vertical = modelVerticalLayout(group, type);
    const roofY = vertical.roofY + 0.14;
    const roofZ = vertical.roofZ;
    for (const side of [-1, 1]) {
        const bracket = new THREE.Mesh(getTechnicalSpeakerBracketGeometry(), mat);
        bracket.position.set(side * 0.42, roofY - 0.14, roofZ - 0.10);
        bracket.castShadow = true;
        group.add(bracket);

        const horn = new THREE.Mesh(getTechnicalSpeakerHornGeometry(), mat);
        horn.position.set(side * 0.42, roofY, roofZ + 0.16);
        horn.rotation.y = side * (Math.PI / 4);
        horn.castShadow = true;
        group.add(horn);
    }
}

function addTechnicalTurret(group, type) {
    const bedMat = getCarBodyMaterial(type.paintHex || 0x4b5138);
    const bedZ = -type.length * 0.24;
    const bedGeometry = getTechnicalBedGeometry(type);
    bedGeometry.computeBoundingBox();
    const bedY = bodySurfaceAt(group, bedZ).point.y - bedGeometry.boundingBox.min.y + 0.005;
    const bed = new THREE.Mesh(bedGeometry, bedMat);
    bed.position.set(0, bedY, bedZ);
    bed.castShadow = true;
    group.add(bed);

    const gunMat = getEnemyGunMaterial();
    const post = new THREE.Mesh(getEnemyTurretPostGeometry(), gunMat);
    post.position.set(0, bedY + 0.38, bedZ);
    post.castShadow = true;
    group.add(post);

    const turret = new THREE.Group();
    turret.position.set(0, bedY + 0.70, bedZ);
    group.add(turret);

    const base = new THREE.Mesh(getEnemyTurretBaseGeometry(), gunMat);
    base.castShadow = true;
    turret.add(base);

    const receiver = new THREE.Mesh(getEnemyTurretReceiverGeometry(), gunMat);
    receiver.position.set(0, 0.16, 0.16);
    receiver.castShadow = true;
    turret.add(receiver);

    const barrel = new THREE.Mesh(getEnemyTurretBarrelGeometry(), gunMat);
    barrel.position.set(0, 0.16, 0.82);
    barrel.castShadow = true;
    turret.add(barrel);

    const flash = new THREE.Mesh(getEnemyMuzzleFlashGeometry(), getEnemyMuzzleMaterial());
    flash.position.set(0, 0.16, 1.54);
    flash.visible = false;
    turret.add(flash);

    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.16, 1.60);
    turret.add(muzzle);

    group.userData.enemyTurret = {
        yawGroup: turret,
        muzzle,
        flash,
        flashTtl: 0,
    };
}

// ─── Emergency-vehicle livery (ambulance / police) ──────────────────────
// Adds a roof lightbar (with two flashable emissive caps) and side decals to
// an existing car group. Lightbar cap meshes are stashed onto the group as
// `.userData.lightbarCaps` so the per-frame flasher can flip their emissive
// intensity without walking the scene graph.

const LIVERY_CONFIG = {
    police: {
        capColors:    [0x1a3aff, 0x1a3aff],   // both blue (Croatian POLICIJA)
        text:         'POLICIJA',
        textBg:       '#1a3aff',
        textFg:       '#ffffff',
    },
    ambulance: {
        capColors:    [0xff1a1a, 0x1a3aff],   // alternating red + blue
        text:         'HITNA POMOĆ',
        textBg:       '#d11414',
        textFg:       '#ffffff',
    },
};

let _lightbarBaseGeo = null;
let _lightbarCapGeo  = null;
let _lightbarBaseMat = null;
function getLightbarBaseGeo() {
    if (!_lightbarBaseGeo) {
        _lightbarBaseGeo = new THREE.BoxGeometry(1.05, 0.10, 0.22);
        registerShared(_lightbarBaseGeo);
    }
    return _lightbarBaseGeo;
}
function getLightbarCapGeo() {
    if (!_lightbarCapGeo) {
        _lightbarCapGeo = new THREE.BoxGeometry(0.46, 0.07, 0.20);
        registerShared(_lightbarCapGeo);
    }
    return _lightbarCapGeo;
}
function getLightbarBaseMaterial() {
    if (!_lightbarBaseMat) {
        _lightbarBaseMat = new THREE.MeshStandardMaterial({
            color: 0x141416, roughness: 0.6, metalness: 0.3,
        });
        registerShared(_lightbarBaseMat);
    }
    return _lightbarBaseMat;
}

// Per-vehicle cap material so a non-emergency liveried car can stay dark
// while the next-spawned emergency one flashes. (Sharing materials by hex
// would force every police lightbar in the scene to flash in sync,
// breaking the 50/50 emergency-mode design.) ~1-2 such materials live at
// any time given the 1/50 spawn rate, so per-instance is cheap.
function makeLightbarCapMaterial(hex) {
    const mat = new THREE.MeshStandardMaterial({
        color: hex,
        emissive: hex,
        emissiveIntensity: 0,
        roughness: 0.4,
        metalness: 0.0,
    });
    return mat;
}

// Per-livery decal texture cache. Same string + colour scheme reuses one
// CanvasTexture across every spawned vehicle.
const _decalTextureCache = new Map();
function getDecalTexture(text, bg, fg) {
    const key = `${text}|${bg}|${fg}`;
    if (_decalTextureCache.has(key)) return _decalTextureCache.get(key);
    const W = 512, H = 96;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const cx = c.getContext('2d');
    cx.fillStyle = bg;
    cx.fillRect(0, 0, W, H);
    cx.fillStyle = fg;
    cx.font = 'bold 64px Arial, sans-serif';
    cx.textAlign = 'center';
    cx.textBaseline = 'middle';
    cx.fillText(text, W / 2, H / 2 + 4);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    registerShared(tex);
    _decalTextureCache.set(key, tex);
    return tex;
}

const _decalMaterials = new Map();
function getDecalMaterial(text, bg, fg) {
    const key = `${text}|${bg}|${fg}`;
    if (_decalMaterials.has(key)) return _decalMaterials.get(key);
    const mat = new THREE.MeshBasicMaterial({
        map: getDecalTexture(text, bg, fg),
        side: THREE.DoubleSide,
    });
    registerShared(mat);
    _decalMaterials.set(key, mat);
    return mat;
}

function addLivery(group, type) {
    const cfg = LIVERY_CONFIG[type.livery];
    if (!cfg) return;

    // Lightbar sits on top of the authored cabin roof; add a tiny offset so the
    // bar visually rests on the roof surface.
    const vertical = modelVerticalLayout(group, type);
    const cabinTopY = vertical.roofY;
    const lbY = cabinTopY + 0.005;
    const lbZ = vertical.roofZ;     // centred on the authored roof
    const baseMesh = new THREE.Mesh(getLightbarBaseGeo(), getLightbarBaseMaterial());
    baseMesh.name = 'TrafficVehicleLightbarBase';
    baseMesh.position.set(0, lbY + 0.05, lbZ);
    baseMesh.castShadow = true;
    group.add(baseMesh);
    const capLMat = makeLightbarCapMaterial(cfg.capColors[0]);
    const capRMat = makeLightbarCapMaterial(cfg.capColors[1]);
    const capL = new THREE.Mesh(getLightbarCapGeo(), capLMat);
    capL.position.set(-0.27, lbY + 0.10, lbZ);
    group.add(capL);
    const capR = new THREE.Mesh(getLightbarCapGeo(), capRMat);
    capR.position.set(+0.27, lbY + 0.10, lbZ);
    group.add(capR);

    // Side decals: thin planes a hair off each side door surface, sized
    // to fit on the chassis flank. Two-sided material so we don't have
    // to manage flip per side.
    const bodyHeight = vertical.beltY - vertical.chassisBottomY;
    const decalH = bodyHeight * 0.55;
    const decalLen = type.length * 0.45;
    const decalGeo = new THREE.PlaneGeometry(decalLen, decalH);
    const decalMat = getDecalMaterial(cfg.text, cfg.textBg, cfg.textFg);
    const decalY = vertical.chassisBottomY + bodyHeight * 0.55;
    const decalX = type.width / 2 + 0.005;
    const decalLeft  = new THREE.Mesh(decalGeo, decalMat);
    decalLeft.position.set(-decalX, decalY, type.cabinZ);
    decalLeft.rotation.y = -Math.PI / 2;
    group.add(decalLeft);
    const decalRight = new THREE.Mesh(decalGeo, decalMat);
    decalRight.position.set(+decalX, decalY, type.cabinZ);
    decalRight.rotation.y = +Math.PI / 2;
    group.add(decalRight);

    group.userData.lightbarCaps = [capLMat, capRMat];
}

// Release the one shared model cache after all traffic instances leave the scene.
export function disposeRoadVehicleSessionCaches() {
    disposeRoadFleetModels();
    const disposeMap = (map) => {
        for (const k of Object.keys(map)) {
            unregisterShared(map[k]);
            map[k].dispose();
            delete map[k];
        }
    };
    disposeMap(carBodyMaterials);
    disposeMap(chassisGeometries);
    disposeMap(cabinGeometries);
    disposeMap(farTrafficGeometries);
    for (const ref of [
        headlightMaterial, taillightMaterial, glassMaterial, fleetDetailMaterial,
        enemyGunMaterial, enemyMuzzleMaterial, enemyBulletMaterial, enemyImpactMaterial,
        technicalEmblemTexture, technicalEmblemMaterial,
        technicalBedGeometry,
        enemyTurretBaseGeometry, enemyTurretPostGeometry, enemyTurretReceiverGeometry, enemyTurretBarrelGeometry,
        enemyMuzzleFlashGeometry, enemyBulletGeometry, enemyImpactGeometry,
        technicalDoorEmblemGeometry, technicalHoodEmblemGeometry,
        technicalSpeakerHornGeometry, technicalSpeakerBracketGeometry,
    ]) {
        if (ref) { unregisterShared(ref); ref.dispose(); }
    }
    headlightMaterial = taillightMaterial = glassMaterial = null;
    fleetDetailMaterial = null;
    enemyGunMaterial = enemyMuzzleMaterial = enemyBulletMaterial = enemyImpactMaterial = null;
    technicalEmblemTexture = technicalEmblemMaterial = null;
    technicalBedGeometry = null;
    enemyTurretBaseGeometry = enemyTurretPostGeometry = enemyTurretReceiverGeometry = enemyTurretBarrelGeometry = null;
    enemyMuzzleFlashGeometry = enemyBulletGeometry = enemyImpactGeometry = null;
    technicalDoorEmblemGeometry = technicalHoodEmblemGeometry = null;
    technicalSpeakerHornGeometry = technicalSpeakerBracketGeometry = null;
    for (const ref of [_lightbarBaseGeo, _lightbarCapGeo, _lightbarBaseMat]) {
        if (ref) { unregisterShared(ref); ref.dispose(); }
    }
    _lightbarBaseGeo = _lightbarCapGeo = _lightbarBaseMat = null;
    for (const material of _decalMaterials.values()) {
        unregisterShared(material);
        material.dispose();
    }
    _decalMaterials.clear();
    for (const texture of _decalTextureCache.values()) {
        unregisterShared(texture);
        texture.dispose();
    }
    _decalTextureCache.clear();
}

// Shared lamp materials switch together; the world decides when day/night changes.
export function setRoadVehicleNightMode(night) {
    roadVehicleNight = !!night;
    if (headlightMaterial) {
        headlightMaterial.emissiveIntensity = night ? 1.4 : 0;
    }
    if (taillightMaterial) {
        taillightMaterial.emissiveIntensity = night ? 1.1 : 0.4;
    }
}
