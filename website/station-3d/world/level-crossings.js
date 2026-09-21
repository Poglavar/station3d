// Paints proper LEVEL CROSSINGS where an AT-GRADE planner track crosses a road
// in the MODEL world: a pedestrian zebra across the road, and small asphalt ramp
// aprons where the road meets the flat trackbed. The track has precedence, so
// the trackbed surface reads on top and the road is dressed up to it.
//
// A companion to world/lane-markings.js — same session lifecycle, same cheap
// approach (a couple of merged BufferGeometries). The crossing detection lives
// in world/rails.js (the ONE authority — an immediate layer that accumulates
// crossings as /roads tiles stream, so nothing is missed); this layer only
// reads that shared set and turns the pure quad geometry into meshes.
//
// Only at-grade crossings are dressed. A viaduct/cut carries its own structure
// (deck / trench) — those are grade-separated and never get a zebra.

import * as THREE from 'three';
import { disposeGroup, registerShared, unregisterShared } from '../core/dispose.js';
import { scene } from '../scene/setup.js';
import { GROUND_SURFACE_LEVELS } from './ground-surface-levels.js';
import { buildZebraStripes, buildCrossingAprons } from '../core/level-crossing.js';
import { getAccumulatedLevelCrossings } from './rails.js';
import { markInspectionLayer } from '../core/scene-inspection.js';
import { markSurfaceClaim } from '../core/surface-claim.js';
import {
    SURFACE_CLASS,
    SURFACE_COVERAGE_STATE,
    SURFACE_POLYGON_OFFSET,
    SURFACE_RENDER_ORDER,
    SURFACE_VERTICAL_RELATION,
} from '../core/surface-hierarchy.js';

// Default crossing dressing dimensions (roadWidth from a typical two-lane
// street; the road index carries no per-road width).
const ROAD_QUERY = { roadWidthM: 7, zebraDepthM: 4, apronLenM: 2.5 };
// Zebra paint sits at the canonical road-marking level; aprons just under it so
// the stripes read on top of the ramp asphalt.
const ZEBRA_Y = GROUND_SURFACE_LEVELS.roadMarking;
const APRON_Y = GROUND_SURFACE_LEVELS.tramBed;   // meet the raised trackbed edge
const APRON_RENDER_ORDER = SURFACE_RENDER_ORDER.LEVEL_CROSSING_APRON;
const RENDER_ORDER = SURFACE_RENDER_ORDER.LEVEL_CROSSING_DRESSING;

let group = null;
let generationGroup = null;
let zebraMesh = null;
let apronMesh = null;
let zebraMaterial = null;
let apronMaterial = null;
let seenAccumRevision = -1;   // last rails crossing-accum revision we rendered
let terrainReference = null;
let terrainChangeSubscription = null;
let surfacePublications = null;
let publicationGeneration = 0;
const LEVEL_CROSSING_PUBLICATION_KEY = 'roads:level-crossing-dressing';

function terrainY(x, z) {
    if (!terrainReference) return 0;
    const raw = terrainReference.evidenceSceneYAtLocal?.(x, z);
    if (raw == null) return null;
    const y = Number(raw);
    return Number.isFinite(y) ? y : null;
}

function getZebraMaterial() {
    if (zebraMaterial) return zebraMaterial;
    zebraMaterial = new THREE.MeshBasicMaterial({
        color: 0xf2f2ee,
        side: THREE.DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: SURFACE_POLYGON_OFFSET.ROAD_MARKING.factor,
        polygonOffsetUnits: SURFACE_POLYGON_OFFSET.ROAD_MARKING.units,
    });
    registerShared(zebraMaterial);
    return zebraMaterial;
}
function getApronMaterial() {
    if (apronMaterial) return apronMaterial;
    apronMaterial = new THREE.MeshStandardMaterial({
        color: 0x3a3a3d,
        roughness: 0.96,
        metalness: 0.0,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: SURFACE_POLYGON_OFFSET.LEVEL_CROSSING_APRON.factor,
        polygonOffsetUnits: SURFACE_POLYGON_OFFSET.LEVEL_CROSSING_APRON.units,
    });
    registerShared(apronMaterial);
    return apronMaterial;
}

// Push a flat [x,z] quad ([c0,c1,c2,c3]) at a fixed surface offset into the open
// positions/indices arrays, draping each corner on the terrain.
function pushQuad(out, quad, surfaceY, cornerYs = null) {
    const resolvedYs = cornerYs || quad.map(([x, z]) => {
        const groundY = terrainY(x, z);
        return groundY === null ? null : groundY + surfaceY;
    });
    if (resolvedYs.some(y => !Number.isFinite(y))) return false;
    const base = out.vertBase;
    for (let i = 0; i < 4; i++) {
        const [x, z] = quad[i];
        const y = resolvedYs[i];
        out.positions.push(x, y, z);
    }
    out.indices.push(base + 0, base + 1, base + 2, base + 0, base + 2, base + 3);
    out.vertBase = base + 4;
    return true;
}

function buildGeometry(crossings) {
    const zebra = { positions: [], indices: [], vertBase: 0 };
    const apron = { positions: [], indices: [], vertBase: 0 };

    for (const frame of crossings) {
        const halfWidthM = Number(frame.halfWidthM) || 3;
        const zebraOpts = { roadWidthM: ROAD_QUERY.roadWidthM, bandDepthM: ROAD_QUERY.zebraDepthM };
        for (const quad of buildZebraStripes(frame, zebraOpts)) {
            if (!pushQuad(zebra, quad, ZEBRA_Y)) return false;
        }
        const [near, far] = buildCrossingAprons(frame, {
            trackHalfWidthM: halfWidthM,
            apronLenM: ROAD_QUERY.apronLenM,
            roadWidthM: ROAD_QUERY.roadWidthM,
        });
        const nearGround = near.map(([x, z]) => terrainY(x, z));
        const farGround = far.map(([x, z]) => terrainY(x, z));
        if (nearGround.some(y => y === null) || farGround.some(y => y === null)) {
            return false;
        }
        // Ramp each apron from the road surface (outer edge) up to the raised
        // trackbed edge (inner edge) so the road meets the bed cleanly.
        // near: corners [outer,-w],[inner,-w],[inner,+w],[outer,+w]
        pushQuad(apron, near, 0, [
            nearGround[0] + APRON_Y * 0.15,
            nearGround[1] + APRON_Y,
            nearGround[2] + APRON_Y,
            nearGround[3] + APRON_Y * 0.15,
        ]);
        pushQuad(apron, far, 0, [
            farGround[0] + APRON_Y,
            farGround[1] + APRON_Y * 0.15,
            farGround[2] + APRON_Y * 0.15,
            farGround[3] + APRON_Y,
        ]);
    }

    if (apron.positions.length > 0) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(apron.positions), 3));
        geo.setIndex(new THREE.BufferAttribute(new Uint32Array(apron.indices), 1));
        geo.computeVertexNormals();
        const mesh = new THREE.Mesh(geo, getApronMaterial());
        mesh.name = 'LevelCrossingAprons';
        mesh.renderOrder = APRON_RENDER_ORDER;
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        apron.mesh = mesh;
    }
    if (zebra.positions.length > 0) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(zebra.positions), 3));
        geo.setIndex(new THREE.BufferAttribute(new Uint32Array(zebra.indices), 1));
        geo.computeVertexNormals();
        const mesh = new THREE.Mesh(geo, getZebraMaterial());
        mesh.name = 'LevelCrossingZebra';
        mesh.renderOrder = RENDER_ORDER;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        zebra.mesh = mesh;
    }
    return { apronMesh: apron.mesh || null, zebraMesh: zebra.mesh || null };
}

function publishGeometry(next) {
    const generation = ++publicationGeneration;
    const nextGroup = new THREE.Group();
    nextGroup.name = `LevelCrossingGeneration:${generation}`;
    for (const [mesh, ownerId, surfaceClass] of [
        [
            next.apronMesh,
            'level-crossing-aprons',
            SURFACE_CLASS.LEVEL_CROSSING_APRON,
        ],
        [
            next.zebraMesh,
            'level-crossing-zebra',
            SURFACE_CLASS.LEVEL_CROSSING_DRESSING,
        ],
    ]) {
        if (!mesh) continue;
        markSurfaceClaim(mesh, {
            surfaceClass,
            coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
            verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
            verticalBand: 'ground',
            ownerId,
            sourceId: 'world/level-crossings.js',
            replacementKey: LEVEL_CROSSING_PUBLICATION_KEY,
            generation,
        });
        nextGroup.add(mesh);
    }
    const previous = generationGroup;
    const commit = () => {
        generationGroup = nextGroup.children.length > 0 ? nextGroup : null;
        apronMesh = next.apronMesh;
        zebraMesh = next.zebraMesh;
    };
    const publicationTicket = surfacePublications?.begin?.({
        key: LEVEL_CROSSING_PUBLICATION_KEY,
        generation,
        parent: group,
        retire: (_context, root) => disposeGroup(root),
    }) || null;
    if (nextGroup.children.length > 0) {
        if (publicationTicket) publicationTicket.publish(nextGroup, { commit });
        else {
            group.add(nextGroup);
            commit();
            if (previous) disposeGroup(previous);
        }
        return;
    }
    disposeGroup(nextGroup);
    if (publicationTicket) {
        publicationTicket.clear({
            commit: () => {
                generationGroup = null;
                apronMesh = null;
                zebraMesh = null;
            },
        });
    } else {
        generationGroup = null;
        apronMesh = null;
        zebraMesh = null;
        if (previous) disposeGroup(previous);
    }
}

function clearMeshes() {
    const retiring = generationGroup;
    generationGroup = null;
    zebraMesh = null;
    apronMesh = null;
    if (!retiring) return;
    if (surfacePublications?.retire?.(LEVEL_CROSSING_PUBLICATION_KEY, {
        root: retiring,
        reason: 'level-crossing-layer-ended',
    })) {
        return;
    }
    disposeGroup(retiring);
}

export const levelCrossingsLayer = {
    beginSession(ctx) {
        surfacePublications = ctx.surfacePublications || null;
        terrainReference = ctx.terrain || null;
        terrainChangeSubscription?.();
        terrainChangeSubscription = terrainReference?.onChange?.(() => {
            seenAccumRevision = -1;
        }) || null;
        seenAccumRevision = -1;
        if (!group) {
            group = new THREE.Group();
            group.name = 'LevelCrossingDressing';
            markInspectionLayer(group, {
                id: 'level-crossing-dressing',
                label: 'Level-crossing paint and aprons',
                category: 'Transport',
                source: 'world/level-crossings.js · derived track/road crossings',
                order: 159,
            });
            scene.add(group);
        }
        // Crossings are detected + accumulated by the rails layer as /roads tiles
        // stream; onFrame rebuilds the dressing whenever that shared set grows.
    },
    onFrame() {
        const { crossings, revision } = getAccumulatedLevelCrossings();
        if (revision === seenAccumRevision) return;
        seenAccumRevision = revision;
        const next = buildGeometry(crossings);
        // Retain the complete previous crossing generation until every apron
        // and stripe has terrain evidence. Terrain onChange re-opens this
        // revision for one bounded retry.
        if (next === false) return;
        publishGeometry(next);
    },
    endSession() {
        clearMeshes();
        if (group) {
            if (group.parent) group.parent.remove(group);
            group = null;
        }
        if (zebraMaterial) { unregisterShared(zebraMaterial); zebraMaterial.dispose(); zebraMaterial = null; }
        if (apronMaterial) { unregisterShared(apronMaterial); apronMaterial.dispose(); apronMaterial = null; }
        terrainReference = null;
        terrainChangeSubscription?.();
        terrainChangeSubscription = null;
        seenAccumRevision = -1;
        surfacePublications = null;
    },
};
