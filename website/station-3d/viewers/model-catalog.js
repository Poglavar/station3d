// Factories own models; the catalog selects variants and exposes local handles.
import * as THREE from 'three';
import { ROAD_TRAFFIC_VEHICLE_TYPES } from '../models/vehicles/traffic-vehicle-catalog.js';

const range = (id, label, value = 0, min = 0, max = 1, step = .01) => ({ id, label, type: 'range', value, min, max, step });
const checkbox = (id, label, value = false) => ({ id, label, type: 'checkbox', value });
const select = (id, label, choices) => ({ id, label, type: 'select', value: choices[0], options: choices.map(value => ({ value, label: value })) });
const source = name => 'station-3d/models/' + name + '.js';
const entry = (id, label, category, source, description, create, metadata = {}) => ({ id, label, category, source, description, ...metadata, create });

function preview(object, controls = [], apply = () => {}, extra = {}) {
    return { object, controls, cameraViews: {}, update: (time, dt, state = {}) => apply(time, state, dt), seek: (time, state = {}) => apply(time, state, 0), ...extra };
}

async function tramPreview(enemy = false, legacy = false) {
    const { createTramMesh, createLegacyTramMesh, setTramDoorsOpen, updateTramRenderLod } = await import('../models/vehicles/tram.js');
    const create = legacy ? createLegacyTramMesh : createTramMesh;
    const object = create(enemy ? '#4b5138' : '#1688cc', enemy ? 'X' : '12', { enemy });
    return preview(object, [range('doors', 'Doors'), ...(object.userData.farMesh ? [select('lod', 'Detail', ['near', 'far'])] : [])], (_time, state) => {
        setTramDoorsOpen(object, state.doors || 0);
        updateTramRenderLod(object, state.lod === 'far' ? 1e8 : 0);
    });
}

async function trainPreview() {
    const { createHz7022Mesh, HZ_7022_CAR_SPACING_M } = await import('../models/vehicles/hz-7022.js');
    const object = createHz7022Mesh({ animatedDoors: true });
    const cars = object.userData.cars;
    return preview(object, [range('doors', 'Doors'), range('bend', 'Articulation', 0, -.25, .25)], (_time, state) => {
        for (const [index, car] of cars.entries()) {
            const angle = (state.bend || 0) * (index - 1);
            car.rotation.y = angle;
            car.position.set(Math.sin(angle) * HZ_7022_CAR_SPACING_M * .5, 0, (index - 1) * HZ_7022_CAR_SPACING_M * Math.cos(angle));
            for (const part of car.userData.doorParts) part.mesh.position.z = part.closedZ + part.direction * .78 * (state.doors || 0);
        }
    });
}

export const AIRPLANE_VIEWS = {
    front: { position: [-4.4, 2.4, 4.4], target: [.1, 1.25, .8], fov: 42 },
    side: { position: [-4, 2.3, 1], target: [.1, 1.15, .5], fov: 38 },
    inside: { position: [.04, 1.5, 1.42], target: [0, .92, .2], fov: 68 },
    whole: { position: [-8, 5, 10], target: [0, 1, 0], fov: 40 },
};

export async function airplanePreview({ smuggler = false, object = null } = {}) {
    const { createAirplaneMesh } = await import('../models/vehicles/boat-airplane.js');
    const { createAirplaneBreakupController } = await import('../models/vehicles/airplane-breakup.js');
    object ??= createAirplaneMesh({ interior: smuggler ? 'smuggler' : null });
    let pilot;
    if (smuggler) {
        const { createPersonMesh, animatePersonSit } = await import('../world/person-mesh.js');
        pilot = createPersonMesh({ bodyColor: 0x405b67, legColor: 0x2b3442, hairColor: 0x392b21, hairStyle: 'short', faceSeed: 12 });
        pilot.name = 'ViewerAirplanePilot';
        pilot.scale.setScalar(.6);
        animatePersonSit(pilot, 1);
        object.getObjectByName('GtaAirplanePilotSeat').add(pilot);
    }
    const breakup = createAirplaneBreakupController(object);
    const propeller = object.getObjectByName('GtaAirplanePropeller');
    return preview(object, [...(pilot ? [checkbox('pilot', 'Pilot', true)] : []), checkbox('propellers', 'Spin propeller'), range('breakup', 'Breakup')], (time, state) => {
        breakup.advance((state.breakup || 0) * breakup.durationS);
        if (pilot) pilot.visible = state.pilot !== false;
        if (propeller && state.propellers) propeller.rotation.z += time * 35;
    }, { cameraViews: AIRPLANE_VIEWS });
}

async function roadPreview(type) {
    const { preloadRoadFleetModels, buildTrafficVehicleMesh } = await import('../models/vehicles/road-vehicles.js');
    await preloadRoadFleetModels([type]);
    const object = buildTrafficVehicleMesh(type, 0x427896);
    const detail = object.userData.detailRoot, far = object.userData.farMesh;
    const controls = detail && far ? [select('lod', 'Detail', ['near', 'far'])] : [];
    return preview(object, controls, (_time, state) => {
        if (detail && far) { detail.visible = state.lod !== 'far'; far.visible = state.lod === 'far'; }
    });
}

async function character(appearance, options) {
    const { createCharacterPreview } = await import('./model-characters.js');
    return createCharacterPreview(appearance, options);
}

const ROAD_NAMES = { suv: 'SUV car', compact: 'Compact car', sedan: 'Sedan car', van: 'Van', truck: 'Truck', bus: 'City bus', bicycle: 'Bicycle', cargo_bicycle: 'Cargo bicycle', ambulance: 'Ambulance', police: 'Police car', technical: 'Armed pickup truck' };

export const MODEL_CATALOG = [
    entry('tmk-2400-fleet', 'TMK 2400 tram', 'vehicles', source('vehicles/tram'), 'Detailed gameplay tram with working doors and distance detail, shared by the player and street traffic.', () => tramPreview(), { provenance: 'Creator-authored Blender model' }),
    entry('tmk-2400-old', 'TMK 2400 tram', 'vehicles', source('vehicles/tmk-2400-old'), 'Original tram, with working doors and both levels of detail.', () => tramPreview(false, true)),
    entry('tmk-2400-new', 'TMK 2400 tram', 'vehicles', source('vehicles/tmk-2400-new'), 'The streamlined three-section tram study.', async () => preview((await import('../models/vehicles/tmk-2400-new.js')).createTmk2400Mesh())),
    entry('enemy-tram', 'Armed tram', 'vehicles', source('vehicles/tram'), 'Tram with the authored gun carriage and enemy livery.', () => tramPreview(true)),
    entry('hz-7022', 'HŽ 7022 train', 'vehicles', source('vehicles/hz-7022'), 'Three-car train; inspect sliding doors and articulated carriages.', trainPreview),
    ...ROAD_TRAFFIC_VEHICLE_TYPES.map(type => entry('road-' + type.name, ROAD_NAMES[type.name] || type.name, 'vehicles', source(type.kind === 'bicycle' ? 'vehicles/bicycle' : 'vehicles/road-vehicles'), 'The same model used by street traffic.', () => roadPreview(type))),
    entry('boat-leut', 'Leut boat · Sv. Nikola', 'vehicles', source('vehicles/boat-airplane'), 'Wooden fishing boat, cabin and deck details.', async () => {
        const object = (await import('../models/vehicles/boat-airplane.js')).createBoatMesh();
        const wake = object.userData.wake; if (wake) wake.visible = false;
        return preview(object, [checkbox('wake', 'Wake')], (_time, state) => { if (wake) wake.visible = !!state.wake; }, { cameraViews: { helm: { position: [0, 2.05, -.8], target: [0, 1.9, 4], fov: 65 } } });
    }),
    ...Object.entries({
        excavator: ['Excavator', 'A tracked excavator: slew the house, raise the boom, fold the stick and curl the bucket.', [range('houseYaw', 'Slew', 0, -3.14, 3.14), range('boomPitch', 'Boom', -0.5, -1.1, 0.2), range('stickPitch', 'Stick', 1.6, 0.3, 2.6), range('bucketPitch', 'Bucket', 0.8, -0.6, 2)]],
        'dump-truck': ['Dump truck', 'A three-axle tipper with a hinged bed and a load of spoil.', [range('bedTilt', 'Bed', 0, 0, 0.95), checkbox('loaded', 'Loaded', true)]],
        bulldozer: ['Bulldozer', 'A crawler dozer with a lifting blade.', [range('bladeLift', 'Blade', 0, 0, 0.5)]],
        'mixer-truck': ['Concrete mixer truck', 'A mixer truck whose striped drum turns on its tilted axis.', [range('drumAngle', 'Drum', 0, 0, 6.28)]],
        'tower-crane': ['Tower crane', 'A flat-top tower crane: mast height, slew, trolley and hook.', [range('mastHeightM', 'Mast height', 46, 20, 214, 1), range('slewYaw', 'Slew', 0, -3.14, 3.14), range('trolleyM', 'Trolley', 30, 10, 57, 0.5), range('hookDropM', 'Hook drop', 20, 2, 40, 0.5), checkbox('carrying', 'Load', true)]],
    }).map(([kind, [label, description, controls]]) => entry('construction-' + kind, label, 'vehicles', source('vehicles/construction-machinery'), description, async () => {
        const machinery = await import('../models/vehicles/construction-machinery.js');
        const object = machinery.createConstructionMachinePreview(kind);
        const defaults = Object.fromEntries(controls.map(control => [control.id, control.value]));
        const apply = (_time, state) => { machinery.poseConstructionMachinePreview(object, { ...defaults, ...state }); };
        apply(0, {});
        return preview(object, controls, apply);
    })),
    entry('airplane', 'Airplane', 'vehicles', source('vehicles/boat-airplane'), 'Standard airplane with propeller and breakup preview.', () => airplanePreview()),
    entry('airplane-smuggler', 'Airplane · pilot & cargo', 'vehicles', source('vehicles/boat-airplane'), 'Hollow cabin, seated pilot, cargo and interior camera views.', () => airplanePreview({ smuggler: true })),
    entry('airplane-before', 'Airplane · before cabin cutout', 'vehicles', 'station-3d/models/vehicles/references/airplane-solid-cabin.json', 'Saved mesh from before the cabin correction, for direct comparison.', async () => {
        const response = await fetch(new URL('../models/vehicles/references/airplane-solid-cabin.json', import.meta.url), { cache: 'no-store' });
        if (!response.ok) throw new Error('Reference mesh unavailable (' + response.status + ').');
        return airplanePreview({ smuggler: true, object: new THREE.ObjectLoader().parse(await response.json()) });
    }),
    entry('cab-interior', 'Tram cab interior', 'vehicles', source('vehicles/cab-interior'), 'The driver’s dashboard, seat and window framing.', async () => {
        const object = (await import('../models/vehicles/cab-interior.js')).createCabInterior();
        object.visible = true;
        return preview(object, [], undefined, { cameraViews: { inside: { position: [0, 0, 0], target: [0, 0, -1], fov: 65 } } });
    }),
    ...['male', 'female', 'kid'].map(kind => entry('person-' + kind, kind === 'kid' ? 'Child' : kind === 'female' ? 'Woman' : 'Man', 'people', 'station-3d/world/person-mesh.js', 'Procedural character with a seeded face, walking, sitting and turning.', options => character({ kind }, options))),
    ...['faces', 'walking', 'waiting'].map(mode => entry('crowd-' + mode, 'Crowd · ' + mode, 'people', 'station-3d/world/person-mesh.js', mode === 'waiting' ? 'The same twelve faces using the world’s instanced waiting-head renderer.' : 'Twelve seeded people. Their identities stay the same between crowd views.', async options => (await import('./model-characters.js')).createPeoplePreview({ ...options, mode }))),
    entry('dog', 'Leashed dog', 'people', 'station-3d/world/dog-mesh.js', 'Dog and leash, with the shared walking animation.', async () => {
        const { createLeashedDog, animateLeashedDog } = await import('../world/dog-mesh.js');
        const object = createLeashedDog({ random: () => .42 });
        return preview(object, [checkbox('walk', 'Walk')], (time, state) => animateLeashedDog(object, time * 8, state.walk ? 1 : 0));
    }),
    entry('bench', 'Bench', 'objects', source('objects/bench'), 'Wooden seat and back with metal supports.', async () => {
        const parts = (await import('../models/objects/bench.js')).createBenchParts();
        const object = new THREE.Group();
        for (const name of ['seatGeo', 'backGeo', 'leftSupportGeo', 'rightSupportGeo']) object.add(new THREE.Mesh(parts[name], name.includes('Support') ? parts.metalMat : parts.woodMat));
        return preview(object);
    }),
    entry('street-lamp', 'Street lamp', 'objects', source('objects/street-lamp'), 'Streetlight pole, lens and cap; inspect the illuminated lens.', async () => {
        const m = await import('../models/objects/street-lamp.js');
        const object = new THREE.Group();
        const pole = new THREE.Mesh(m.getPoleGeometry(), m.getPoleMaterial());
        const head = new THREE.Mesh(m.getHeadGeometry(), m.getHeadMaterial().clone()); head.position.y = m.LENS_Y;
        const cap = new THREE.Mesh(m.getCapGeometry(), m.getCapMaterial()); cap.position.y = m.CAP_Y;
        object.add(pole, head, cap);
        return preview(object, [checkbox('lit', 'Light on')], (_time, state) => { head.material.emissiveIntensity = state.lit ? 3 : 0; });
    }),
    entry('stop-shelter', 'Stop shelter', 'objects', source('objects/stop-shelter'), 'Glazed shelter fitted to a small platform footprint.', async () => {
        const polygon = { type: 'Polygon', coordinates: [[[-.000025, -.0000072], [.000025, -.0000072], [.000025, .0000072], [-.000025, .0000072], [-.000025, -.0000072]]] };
        return preview((await import('../models/objects/stop-shelter.js')).createStopShelterGroup(polygon, 0, 0));
    }),
    entry('manhole', 'Manhole cover', 'objects', source('objects/manhole'), 'Textured lid and its frame at the original street scale.', async () => {
        const m = await import('../models/objects/manhole.js');
        const out = { positions: [], uvs: [] };
        m.pushCover(out.positions, out.uvs, { x: 0, z: 0, ux: 1, uz: 0, nx: 0, nz: 1 });
        return preview(m.createManholeMesh(out, m.createManholeMaterial()));
    }),
    entry('market-stall', 'Market stall', 'objects', source('objects/market-stall'), 'Authored market stall with its awning and goods.', async () => preview((await import('../models/objects/market-stall.js')).createMarketStallMesh())),
    entry('sealed-package', 'Sealed package', 'objects', source('objects/sealed-package'), 'Canvas package, twine, wax seal, boat key and folded blueprint.', async () => {
        const { createSealedPackageMesh, setSealedPackageOpen, setSealedPackageKeyVisible } = await import('../models/objects/sealed-package.js');
        const object = createSealedPackageMesh();
        return preview(object, [range('open', 'Unwrap'), checkbox('key', 'Boat key')], (_time, state) => { setSealedPackageOpen(object, state.open || 0); setSealedPackageKeyVisible(object, !!state.key); });
    }),
    entry('machine-gun', 'Machine gun', 'objects', source('objects/machine-gun'), 'Shared first-person gun geometry and muzzle flash.', async () => {
        const { buildMachineGunMesh } = await import('../models/objects/machine-gun.js');
        const { group, flash } = buildMachineGunMesh({ metalMaterial: new THREE.MeshStandardMaterial({ color: 0x303539 }), muzzleMaterial: new THREE.MeshBasicMaterial({ color: 0xffba59 }), register() {} });
        return preview(group, [checkbox('flash', 'Muzzle flash')], (_time, state) => { flash.visible = !!state.flash; });
    }),
    entry('machine-gun-nest', 'Machine gun nest', 'objects', source('objects/machine-gun-nest'), 'Sandbags, mounted gun, operators and flag.', async () => {
        const { group, turret } = (await import('../models/objects/machine-gun-nest.js')).createMachineGunNestModel(12);
        return preview(group, [range('aim', 'Turret aim', 0, -1.5, 1.5), checkbox('flash', 'Muzzle flash')], (_time, state) => { turret.yawGroup.rotation.y = state.aim || 0; turret.flash.visible = !!state.flash; });
    }),
];

export function modelCatalogEntry(id) { return MODEL_CATALOG.find(entry => entry.id === id) || null; }
