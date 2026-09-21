// Turn the Blender aircraft into a reusable flight model. The GLB stays in
// its parked display pose; the returned, independently disposable model uses
// the engine's +Z nose, +Y up frame and exposes the usual pilot/propeller parts.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const PART_NAMES = Object.freeze({
    body: 'UtvaAirframe',
    wing: 'GtaAirplaneRoundedMainWing',
    tail: 'GtaAirplaneRoundedTailplane',
    fin: 'GtaAirplaneRoundedFin',
    gear: 'GtaAirplaneLandingGear',
    propeller: 'GtaAirplanePropeller',
});

function partFor(names) {
    if (names.some(name => /^(PropBlade|Spinner)/.test(name))) return 'propeller';
    if (names.some(name => /^(Wing|CallsignWing|Strut|Jury)/.test(name))) return 'wing';
    if (names.some(name => /^(Tailplane|TailBrace)/.test(name))) return 'tail';
    if (names.some(name => /^(Fin|DorsalFillet)/.test(name))) return 'fin';
    if (names.some(name => /^(Gear|Hub|Wheel|TailLeg|TailWheel)/.test(name))) return 'gear';
    return 'body';
}

export function createUtvaAirplaneMesh(source, { interior = null } = {}) {
    const authored = source?.getObjectByName('UTVA_Liaison');
    if (!authored) throw new Error('UTVA asset has no UTVA_Liaison root');
    source.updateWorldMatrix(true, true);
    const toFlight = new THREE.Matrix4().makeRotationY(Math.PI)
        .multiply(authored.matrixWorld.clone().invert());
    const root = new THREE.Group();
    root.name = 'GtaAirplaneUTVA';
    root.userData.modelId = 'utva';
    const parts = Object.fromEntries(Object.entries(PART_NAMES).map(([id, name]) => {
        const part = new THREE.Group();
        part.name = name;
        root.add(part);
        return [id, part];
    }));
    parts.propeller.position.set(0, 1.2, 4.02);
    const batches = new Map();
    const materials = new Map();
    authored.traverse(node => {
        if (!node.isMesh) return;
        const names = [];
        for (let parent = node; parent && parent !== authored; parent = parent.parent) names.push(parent.name);
        // The world seats the current player here, so do not bake a second pilot.
        if (names.includes('Pilot') || (interior !== 'smuggler' && names.includes('Cargo'))) return;
        const partId = partFor(names);
        const material = node.material;
        if (Array.isArray(material)) throw new Error('UTVA primitives must have one material');
        if (!materials.has(material.uuid)) materials.set(material.uuid, material.clone());
        // Keep clear panes individually sortable; batch repeated opaque parts.
        const key = `${partId}:${material.uuid}:${material.transparent ? node.uuid : ''}`;
        if (!batches.has(key)) batches.set(key, { partId, material: materials.get(material.uuid), geometries: [], names: [] });
        const batch = batches.get(key);
        const transform = toFlight.clone().multiply(node.matrixWorld);
        if (partId === 'propeller') transform.premultiply(new THREE.Matrix4().makeTranslation(0, -1.2, -4.02));
        const geometry = node.geometry.clone().applyMatrix4(transform);
        for (const name of Object.keys(geometry.attributes)) {
            if (name !== 'position' && name !== 'normal') geometry.deleteAttribute(name);
        }
        if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
        if (!geometry.index) geometry.setIndex(Array.from({ length: geometry.getAttribute('position').count }, (_, index) => index));
        batch.geometries.push(geometry);
        batch.names.push(node.name);
    });
    for (const { partId, material, geometries, names } of batches.values()) {
        const geometry = mergeGeometries(geometries, false);
        for (const sourceGeometry of geometries) sourceGeometry.dispose();
        if (!geometry) throw new Error(`Cannot batch UTVA ${partId}`);
        geometry.computeBoundingSphere();
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = `Utva:${names.join('+')}`;
        mesh.castShadow = !material.transparent;
        mesh.receiveShadow = true;
        parts[partId].add(mesh);
    }
    const pilotSeat = new THREE.Group();
    pilotSeat.name = 'GtaAirplanePilotSeat';
    pilotSeat.position.set(0.24, 0.56, 1.28);
    root.add(pilotSeat);
    root.userData.pilotSeat = pilotSeat;
    root.userData.propeller = parts.propeller;
    const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
    root.userData.dimensions = { width: size.x, height: size.y, length: size.z };
    return root;
}
