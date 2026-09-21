// Reusable small-vehicle geometry factories. World adapters own spawning, terrain gating, possession, and lifecycle.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
 AIRPLANE_LANDING_GEAR_ASSEMBLIES, buildAirplaneCabinShellGeometryData,
 buildAirplaneCabinSurfaceLinePositions, buildAirplaneWingGeometryData,
 airplaneBodySurfaceXAt, buildAirplaneCabinBulkheadGeometryData,
} from './boat-airplane-geometry.js';
import { LEUT_LIVERIES, buildLeutGeometryData } from './leut-geometry.js';

function standardMaterial(color, roughness = 0.7, metalness = 0.05) {
    return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function shadowTree(root) {
    root.traverse((node) => {
        if (!node?.isMesh) return;
        node.castShadow = true;
        node.receiveShadow = true;
    });
    return root;
}

function airplanePanelGeometry(positions, indices) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
}

// Pure shell arrays are shared; each vehicle still owns its disposable buffers.
let airplaneShellData = null;

function airplaneShellGeometries() {
    const data = airplaneShellData ||= buildAirplaneCabinShellGeometryData();
    const whole = airplanePanelGeometry(data.positions, [...data.fuselage, ...data.cabin, ...data.glass]);
    const part = indices => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', whole.getAttribute('position').clone());
        geometry.setAttribute('normal', whole.getAttribute('normal').clone());
        geometry.setIndex(indices);
        geometry.computeBoundingSphere();
        return geometry;
    };
    const fuselage = part(data.fuselage);
    const cabin = part([...data.cabin, ...data.glass]);
    cabin.addGroup(0, data.cabin.length, 0);
    cabin.addGroup(data.cabin.length, data.glass.length, 1);
    whole.dispose();
    return { fuselage, cabin, data };
}

function airplaneLinerGeometry(data, indices, { windowReveals = false } = {}) {
    // Inset around the cabin's centre, including the belly. The same holes as
    // the outer skin leave the far windows clear too; no scaled closed bubble.
    const positions = data.positions.map((value, index) => index % 3 === 0 ? value * 0.96
        : index % 3 === 1 ? 1 + (value - 1) * 0.96 : 0.75 + (value - 0.75) * 0.985);
    const faces = [...indices];
    if (windowReveals) {
        const edges = new Map();
        const opaqueEdges = new Set();
        for (const opaque of [data.cabin, data.fuselage]) {
            for (let index = 0; index < opaque.length; index += 3) {
                for (let edge = 0; edge < 3; edge += 1) {
                    const a = opaque[index + edge];
                    const b = opaque[index + (edge + 1) % 3];
                    opaqueEdges.add(a < b ? `${a}:${b}` : `${b}:${a}`);
                }
            }
        }
        for (let index = 0; index < data.glass.length; index += 3) {
            for (let edge = 0; edge < 3; edge += 1) {
                const a = data.glass[index + edge];
                const b = data.glass[index + (edge + 1) % 3];
                const key = a < b ? `${a}:${b}` : `${b}:${a}`;
                const previous = edges.get(key);
                edges.set(key, { a, b, count: (previous?.count || 0) + 1 });
            }
        }
        for (const [key, { a, b, count }] of edges) {
            // A clipping subdivision inside the glazing is not a frame.
            if (count !== 1 || !opaqueEdges.has(key)) continue;
            const outerA = positions.length / 3;
            positions.push(...data.positions.slice(a * 3, a * 3 + 3), ...data.positions.slice(b * 3, b * 3 + 3));
            faces.push(outerA, b, outerA + 1, outerA, a, b);
        }
    }
    return airplanePanelGeometry(positions, faces);
}

function airplaneWingGeometry(options) {
    const data = buildAirplaneWingGeometryData(options);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
    geometry.setIndex(data.indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
}

function boatWakeGeometry() {
    const geometry = new THREE.BufferGeometry();
    const positions = [];
    const indices = [];
    for (const side of [-1, 1]) {
        const base = positions.length / 3;
        positions.push(
            side * 0.34, 0, 0,
            side * 0.54, 0, -0.08,
            side * 1.34, 0, -5.6,
            side * 1.72, 0, -5.75,
        );
        indices.push(base, base + 1, base + 3, base, base + 3, base + 2);
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
}

function softSprayTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext('2d');
    const gradient = context.createRadialGradient(16, 16, 1, 16, 16, 15);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.5, 'rgba(235,251,255,0.78)');
    gradient.addColorStop(1, 'rgba(235,251,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 32, 32);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

export function createBoatWake() {
    const wake = new THREE.Group();
    wake.name = 'GtaBoatWake';
    wake.visible = false;
    wake.position.set(0, 0.03, -4.1);   // just aft of the leut's sternpost

    const foamMaterial = new THREE.MeshBasicMaterial({
        color: 0xe8fbff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
    });
    const foam = new THREE.Mesh(boatWakeGeometry(), foamMaterial);
    foam.name = 'GtaBoatWakeFoam';
    wake.add(foam);

    const sprayPositions = new Float32Array(8 * 3);
    const sprayGeometry = new THREE.BufferGeometry();
    sprayGeometry.setAttribute('position', new THREE.BufferAttribute(sprayPositions, 3));
    const sprayMaterial = new THREE.PointsMaterial({
        color: 0xf5fdff,
        size: 0.24,
        map: softSprayTexture(),
        transparent: true,
        opacity: 0,
        alphaTest: 0.04,
        depthWrite: false,
        sizeAttenuation: true,
    });
    const spray = new THREE.Points(sprayGeometry, sprayMaterial);
    spray.name = 'GtaBoatSpray';
    wake.add(spray);
    wake.userData.foamMaterial = foamMaterial;
    wake.userData.sprayMaterial = sprayMaterial;
    wake.userData.sprayPositions = sprayPositions;
    wake.userData.sprayAttribute = sprayGeometry.getAttribute('position');
    return wake;
}

// The boat is the 8.5 m leut from leut-geometry.js, merged into one draw per
// material family with the authored palette carried by vertex colours: hull,
// paint, metal, glass and unlit lamps, plus the wake. The hull and paint keep
// a faint emissive so the boat stays readable on a moonless crossing.
const BOAT_MATERIAL_FAMILIES = Object.freeze({
    hull: {
        name: 'GtaBoatVHull',
        make: livery => new THREE.MeshStandardMaterial({
            vertexColors: true, roughness: 0.42, metalness: 0.08,
            emissive: livery.hullEmissive, emissiveIntensity: 0.45, side: THREE.DoubleSide,
        }),
    },
    paint: {
        name: 'GtaBoatPaint',
        make: () => new THREE.MeshStandardMaterial({
            vertexColors: true, roughness: 0.62, metalness: 0.04,
            emissive: 0x3a3326, emissiveIntensity: 0.28, side: THREE.DoubleSide,
        }),
    },
    metal: {
        name: 'GtaBoatMetal',
        make: () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.7 }),
    },
    glass: {
        name: 'GtaBoatGlass',
        castShadow: false,
        make: () => new THREE.MeshStandardMaterial({
            vertexColors: true, roughness: 0.12, metalness: 0.05,
            transparent: true, opacity: 0.36, depthWrite: false, side: THREE.DoubleSide,
        }),
    },
    lamp: {
        name: 'GtaBoatLamps',
        castShadow: false,
        make: () => new THREE.MeshBasicMaterial({ vertexColors: true }),
    },
});

// The pure build takes ~45 ms, so its merged per-family arrays are kept per
// lettering and livery and copied into a fresh geometry for every boat: each
// vehicle owns and disposes its own buffers like every other special vehicle.
const boatFamilyArrays = new Map();

function leutFamilyArrays(appearance) {
    const key = JSON.stringify(appearance);
    const cached = boatFamilyArrays.get(key);
    if (cached) return cached;
    const data = buildLeutGeometryData(appearance);
    const families = new Map();
    for (const family of Object.keys(BOAT_MATERIAL_FAMILIES)) {
        const groups = data.groups.filter(group => group.family === family);
        if (!groups.length) continue;
        const count = groups.reduce((total, group) => total + group.positions.length, 0);
        const positions = new Float32Array(count);
        const normals = new Float32Array(count);
        const colors = new Float32Array(count);
        let offset = 0;
        for (const group of groups) {
            positions.set(group.positions, offset);
            normals.set(group.normals, offset);
            for (let index = offset; index < offset + group.positions.length; index += 3) {
                colors[index] = group.color[0];
                colors[index + 1] = group.color[1];
                colors[index + 2] = group.color[2];
            }
            offset += group.positions.length;
        }
        families.set(family, { positions, normals, colors });
    }
    boatFamilyArrays.set(key, families);
    return families;
}

// `appearance` is the leut's lettering ({ name, registration }) and its
// `livery`, one of LEUT_LIVERIES (blue unless given).
export function createBoatMesh(appearance = {}) {
    const root = new THREE.Group();
    root.name = 'GtaBoat';
    const families = leutFamilyArrays(appearance);
    const livery = LEUT_LIVERIES[appearance.livery ?? 'blue'];
    for (const [family, arrays] of families) {
        const spec = BOAT_MATERIAL_FAMILIES[family];
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(arrays.positions.slice(), 3));
        geometry.setAttribute('normal', new THREE.BufferAttribute(arrays.normals.slice(), 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(arrays.colors.slice(), 3));
        geometry.computeBoundingSphere();
        const mesh = new THREE.Mesh(geometry, spec.make(livery));
        mesh.name = spec.name;
        mesh.castShadow = spec.castShadow !== false;
        mesh.receiveShadow = true;
        root.add(mesh);
    }
    const wake = createBoatWake();
    root.add(wake);
    root.userData.wake = wake;
    return root;
}

// Pilot rig anchor in model metres, +Z the nose, so +X is the port side.
// The seated person's origin remains at foot level: its hips are 0.432 m
// higher at 0.6 scale, where the physical seat cushion belongs.
export const AIRPLANE_PILOT_SEAT = Object.freeze({ x: 0.24, y: 0.56, z: 0.98 });
const CABIN_FLOOR_Y = 0.5;

function airplaneCabinInterior(interior, shellData) {
    const group = new THREE.Group();
    group.name = 'GtaAirplaneCabinInterior';
    // Dark liners on the inside of the shells: through translucent glazing a
    // single-sided hull would otherwise show the world beyond the far wall.
    const linerMaterial = standardMaterial(0x2b2f34, 0.92, 0.02);
    linerMaterial.side = THREE.BackSide;
    // The baggage bay ends before the tail, and a low firewall closes the
    // engine compartment without obstructing the windshield.
    const rearWall = buildAirplaneCabinBulkheadGeometryData({ z: -0.43 });
    const firewall = buildAirplaneCabinBulkheadGeometryData({ z: 1.5, topY: 1.1 });
    const linerPieces = [
        airplaneLinerGeometry(shellData, shellData.cabin, { windowReveals: true }),
        airplanePanelGeometry(rearWall.positions, rearWall.indices.reverse()),
        airplanePanelGeometry(firewall.positions, firewall.indices),
    ];
    const cabinLiner = new THREE.Mesh(mergeGeometries(linerPieces), linerMaterial);
    for (const geometry of linerPieces) geometry.dispose();
    cabinLiner.name = 'GtaAirplaneCabinLiner';
    group.add(cabinLiner);
    const fuselageLiner = new THREE.Mesh(airplaneLinerGeometry(shellData, shellData.fuselage), linerMaterial);
    fuselageLiner.name = 'GtaAirplaneFuselageLiner';
    group.add(fuselageLiner);
    const floorGeometry = new THREE.BoxGeometry(1.08, 0.04, 1.95, 1, 1, 8);
    const floorPositions = floorGeometry.getAttribute('position');
    for (let index = 0; index < floorPositions.count; index += 1) {
        const halfWidth = Math.min(0.54, airplaneBodySurfaceXAt(floorPositions.getZ(index) + 0.525,
            floorPositions.getY(index) + CABIN_FLOOR_Y) - 0.03);
        floorPositions.setX(index, Math.sign(floorPositions.getX(index)) * halfWidth);
    }
    floorGeometry.computeVertexNormals();
    const floor = new THREE.Mesh(floorGeometry, standardMaterial(0x3a3d42, 0.9, 0.02));
    floor.name = 'GtaAirplaneCabinFloor';
    floor.position.set(0, CABIN_FLOOR_Y, 0.525);
    group.add(floor);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.22, 0.1), standardMaterial(0x1d2024, 0.7, 0.1));
    panel.name = 'GtaAirplaneInstrumentPanel';
    panel.position.set(0, 1.0, 1.52);
    group.add(panel);
    const seatMaterial = standardMaterial(0x6b3f2a, 0.8, 0.02);
    const seatPieces = [];
    const cushionY = AIRPLANE_PILOT_SEAT.y + 0.432;
    for (const x of [AIRPLANE_PILOT_SEAT.x, -AIRPLANE_PILOT_SEAT.x]) {
        seatPieces.push(
            new THREE.BoxGeometry(0.4, 0.07, 0.42).translate(x, cushionY - 0.035, AIRPLANE_PILOT_SEAT.z),
            new THREE.BoxGeometry(0.4, 0.46, 0.07).translate(x, cushionY + 0.2, AIRPLANE_PILOT_SEAT.z - 0.21),
            new THREE.BoxGeometry(0.22, cushionY - 0.59, 0.26).translate(x, (cushionY - 0.07 + 0.52) / 2, AIRPLANE_PILOT_SEAT.z),
        );
    }
    const seats = new THREE.Mesh(mergeGeometries(seatPieces), seatMaterial);
    seats.name = 'GtaAirplaneSeats';
    group.add(seats);
    for (const geometry of seatPieces) geometry.dispose();
    const seat = new THREE.Group();
    seat.name = 'GtaAirplanePilotSeat';
    seat.position.set(AIRPLANE_PILOT_SEAT.x, AIRPLANE_PILOT_SEAT.y, AIRPLANE_PILOT_SEAT.z);
    group.add(seat);
    if (interior === 'smuggler') group.add(airplaneSmugglerCargo());
    return { group, seat };
}

// Behind the seats: two hundred cartons of cigarettes in cardboard, one box
// of books, and a sack. Visible through the rear of the side windows.
function airplaneSmugglerCargo() {
    const cargo = new THREE.Group();
    cargo.name = 'GtaAirplaneCargo';
    // A little bounced-light colour keeps the cargo readable through the
    // tinted glass. The stacks sit on the floor inside the hollow fuselage.
    const cargoMaterial = (color) => {
        const material = new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0.02 });
        material.emissive = new THREE.Color(color);
        material.emissiveIntensity = 0.12;
        return material;
    };
    const carton = cargoMaterial(0xc4955f);
    const cartonDark = cargoMaterial(0xa87a4b);
    const books = cargoMaterial(0x62778a);
    const boxes = [
        { size: [0.42, 0.30, 0.30], at: [-0.24, 0.67, 0.48], material: carton },
        { size: [0.42, 0.30, 0.30], at: [-0.24, 0.97, 0.48], material: cartonDark },
        { size: [0.40, 0.28, 0.30], at: [-0.24, 1.26, 0.48], material: carton },
        { size: [0.40, 0.30, 0.30], at: [0.24, 0.67, 0.48], material: cartonDark },
        { size: [0.40, 0.30, 0.30], at: [0.24, 0.97, 0.48], material: carton },
        { size: [0.34, 0.24, 0.26], at: [0.22, 1.24, 0.48], material: books, name: 'GtaAirplaneCargoBooks' },
    ];
    for (const box of boxes) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(...box.size), box.material);
        mesh.name = box.name || 'GtaAirplaneCargoCarton';
        mesh.position.set(...box.at);
        cargo.add(mesh);
    }
    const sack = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 7), standardMaterial(0x8a7a55, 1, 0));
    sack.name = 'GtaAirplaneCargoSack';
    sack.scale.set(1.1, 0.75, 1.4);
    sack.position.set(0, 0.67, -0.1);
    cargo.add(sack);
    return cargo;
}

// `interior`: null for the plain hull, 'smuggler' for the campaign's furnished
// cabin (translucent glazing, seats, instrument panel, the cargo) with a
// pilot seat the world layer can seat a person in (root.userData.pilotSeat).
export function createAirplaneMesh({ interior = null } = {}) {
    const root = new THREE.Group();
    root.name = 'GtaAirplane';
    const bodyMaterial = standardMaterial(0xe5e8ec, 0.48, 0.16);
    const accentMaterial = standardMaterial(0xc62d32, 0.55, 0.08);
    const glassMaterial = new THREE.MeshStandardMaterial({
        color: 0x3b6c88,
        roughness: 0.15,
        metalness: 0.2,
        side: THREE.DoubleSide,
        // A furnished cabin shows through its glazing; an empty hull keeps
        // the opaque tint that hides its hollow shell.
        ...(interior ? { transparent: true, opacity: 0.36, depthWrite: false } : {}),
    });
    const shell = airplaneShellGeometries();
    const fuselage = new THREE.Mesh(shell.fuselage, bodyMaterial);
    fuselage.name = 'GtaAirplaneTaperedFuselage';
    root.add(fuselage);
    const wing = new THREE.Mesh(airplaneWingGeometry({
        span: 8.6,
        rootChord: 1.58,
        tipChord: 0.82,
        thickness: 0.17,
        tipRadius: 0.24,
        edgeInset: 0.055,
        tipSegments: 7,
        fuselageCutout: { y: 0.95, z: 0.15 },
    }), bodyMaterial);
    wing.name = 'GtaAirplaneRoundedMainWing';
    wing.position.set(0, 0.95, 0.15);
    root.add(wing);
    const tailplane = new THREE.Mesh(airplaneWingGeometry({
        span: 3.25,
        rootChord: 0.88,
        tipChord: 0.42,
        thickness: 0.12,
        tipRadius: 0.15,
        edgeInset: 0.04,
        tipSegments: 6,
    }), accentMaterial);
    tailplane.name = 'GtaAirplaneRoundedTailplane';
    tailplane.position.set(0, 1.38, -2.82);
    root.add(tailplane);
    const fin = new THREE.Mesh(airplaneWingGeometry({
        span: 1.55,
        rootChord: 1.30,
        tipChord: 0.42,
        thickness: 0.11,
        tipRadius: 0.13,
        edgeInset: 0.035,
        tipSegments: 6,
        oneSided: true,
    }), accentMaterial);
    fin.name = 'GtaAirplaneRoundedFin';
    fin.rotation.z = Math.PI * 0.5;
    fin.position.set(0, 1.32, -2.72);
    root.add(fin);

    // Every variant uses the same hollow airframe with glazing in real holes.
    // Furnishing controls the contents and transparency, never the shell rules.
    const cabin = new THREE.Mesh(
        shell.cabin,
        [bodyMaterial, glassMaterial],
    );
    cabin.name = 'GtaAirplaneRoundedCabin';
    root.add(cabin);
    if (interior) {
        const furnished = airplaneCabinInterior(interior, shell.data);
        root.add(furnished.group);
        root.userData.pilotSeat = furnished.seat;
    }

    const doorOutlineMaterial = new THREE.LineBasicMaterial({ color: 0x2e3338 });
    const doorCorners = [
        { z: 0.37, y: 0.94 },
        { z: 0.37, y: 1.70 },
        { z: 1.49, y: 1.68 },
        { z: 1.53, y: 0.94 },
        { z: 0.37, y: 0.94 },
    ];
    const handlePoints = [
        { z: 1.22, y: 1.01 },
        { z: 1.39, y: 1.01 },
    ];
    for (const side of [-1, 1]) {
        const outlineGeometry = new THREE.BufferGeometry();
        outlineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(
            buildAirplaneCabinSurfaceLinePositions(doorCorners, {
                side,
                segmentsPerEdge: 16,
                offsetM: 0.004,
                surfaceGeometry: shell.data,
            }),
            3,
        ));
        const doorOutline = new THREE.LineSegments(outlineGeometry, doorOutlineMaterial);
        doorOutline.name = side < 0
            ? 'GtaAirplaneCabinDoorOutline'
            : 'GtaAirplaneCabinDoorOutlineRight';
        root.add(doorOutline);

        const handleGeometry = new THREE.BufferGeometry();
        handleGeometry.setAttribute('position', new THREE.Float32BufferAttribute(
            buildAirplaneCabinSurfaceLinePositions(handlePoints, {
                side,
                offsetM: 0.0025,
                surfaceGeometry: shell.data,
            }),
            3,
        ));
        const doorHandle = new THREE.LineSegments(handleGeometry, doorOutlineMaterial);
        doorHandle.name = 'GtaAirplaneCabinDoorHandle';
        root.add(doorHandle);
    }

    const wheelMaterial = standardMaterial(0x202326, 0.88, 0.02);
    const strutMaterial = standardMaterial(0x777f85, 0.38, 0.72);
    const wheelGeometry = new THREE.CylinderGeometry(0.23, 0.23, 0.16, 14);
    wheelGeometry.rotateZ(Math.PI * 0.5);
    const strutGeometry = new THREE.CylinderGeometry(0.035, 0.045, 1.03, 8);
    const landingGear = new THREE.Group();
    landingGear.name = 'GtaAirplaneLandingGear';
    for (const spec of AIRPLANE_LANDING_GEAR_ASSEMBLIES) {
        const assembly = new THREE.Group();
        assembly.name = `GtaAirplaneLandingGear:${spec.name}`;
        assembly.position.set(spec.x, spec.y, spec.z);
        const wheel = new THREE.Mesh(wheelGeometry, wheelMaterial);
        wheel.name = `GtaAirplaneWheel:${spec.name}`;
        assembly.add(wheel);
        const strut = new THREE.Mesh(strutGeometry, strutMaterial);
        strut.name = `GtaAirplaneStrut:${spec.name}`;
        strut.position.y = 0.51;
        assembly.add(strut);
        landingGear.add(assembly);
    }
    root.add(landingGear);

    const propeller = new THREE.Group();
    propeller.name = 'GtaAirplanePropeller';
    propeller.position.set(0, 0.77, 3.76);
    const hub = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 7), accentMaterial);
    hub.scale.z = 0.65;
    propeller.add(hub);
    const bladeMaterial = standardMaterial(0x25292d, 0.46, 0.35);
    const horizontalBlade = new THREE.Mesh(new THREE.BoxGeometry(2.15, 0.13, 0.07), bladeMaterial);
    const verticalBlade = new THREE.Mesh(new THREE.BoxGeometry(0.13, 2.15, 0.07), bladeMaterial);
    propeller.add(horizontalBlade, verticalBlade);
    root.add(propeller);
    root.userData.propeller = propeller;
    return shadowTree(root);
}
