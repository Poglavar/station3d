// The transit shelter a flagged Overture footprint becomes: glass canopy on
// slim posts with a glazed back wall and a bench — the planner stop's own
// visual language (world/platforms.js canopy recipe), sized to the real
// footprint. Replaces the procedural little-house-with-a-window that used to
// stand at every equipped stop.

import * as THREE from 'three';
import { registerShared } from '../../core/dispose.js';
import { orientedFootprintFit } from '../../core/shelter-fit.js';

const SHELTER_HEIGHT_M = 2.6;
const CANOPY_THICK_M = 0.14;
const POST_RADIUS_M = 0.05;
const GLASS_TOP_M = 2.35;
const GLASS_BOTTOM_M = 0.35;
const BENCH_HEIGHT_M = 0.45;
// OSM shelter footprints run ~6–16 m²; anything the fit reads outside this is
// clamped so a ragged ring cannot produce a bus-barn or a matchbox.
const LENGTH_RANGE_M = [2.4, 8];
const DEPTH_RANGE_M = [1.1, 3];

let materials = null;

function getMaterials() {
    if (materials) return materials;
    materials = {
        // Same optics as the planner stop canopy: transparent, no transmission
        // (a refraction pass costs a full extra scene render).
        glass: new THREE.MeshPhysicalMaterial({
            color: 0x7ec8e3,
            transparent: true,
            opacity: 0.55,
            roughness: 0.08,
            metalness: 0.1,
        }),
        canopy: new THREE.MeshPhysicalMaterial({
            color: 0x7ec8e3,
            transparent: true,
            opacity: 0.72,
            roughness: 0.05,
            metalness: 0.1,
        }),
        frame: new THREE.MeshStandardMaterial({ color: 0x374151, metalness: 0.4, roughness: 0.5 }),
        bench: new THREE.MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.8 }),
    };
    for (const material of Object.values(materials)) registerShared(material);
    return materials;
}

const clamp = (value, [min, max]) => Math.min(max, Math.max(min, value));

// polygon: GeoJSON Polygon in lon/lat; returns a group seated at foundationY,
// or null when the footprint defeats the fit (the caller then draws nothing —
// a broken tiny footprint must not fall back to being a house).
export function createStopShelterGroup(polygon, anchorLat, anchorLon, foundationY = 0) {
    const fit = orientedFootprintFit(polygon?.coordinates?.[0], anchorLat, anchorLon);
    if (!fit) return null;
    const lengthM = clamp(fit.lengthM, LENGTH_RANGE_M);
    const depthM = clamp(fit.depthM, DEPTH_RANGE_M);
    const mats = getMaterials();
    const group = new THREE.Group();
    group.name = 'StopShelter';

    const canopy = new THREE.Mesh(
        new THREE.BoxGeometry(lengthM + 0.25, CANOPY_THICK_M, depthM + 0.25),
        mats.canopy,
    );
    canopy.position.y = SHELTER_HEIGHT_M - CANOPY_THICK_M / 2;
    canopy.castShadow = true;
    group.add(canopy);

    const postGeometry = new THREE.CylinderGeometry(
        POST_RADIUS_M,
        POST_RADIUS_M,
        SHELTER_HEIGHT_M - CANOPY_THICK_M,
        6,
    );
    for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
            const post = new THREE.Mesh(postGeometry, mats.frame);
            post.position.set(
                sx * (lengthM / 2 - POST_RADIUS_M),
                (SHELTER_HEIGHT_M - CANOPY_THICK_M) / 2,
                sz * (depthM / 2 - POST_RADIUS_M),
            );
            group.add(post);
        }
    }

    // Glazed back wall and half-height ends. Which long side faces the road is
    // unknowable from the footprint alone; a wrong guess is two panes of glass.
    const glassHeight = GLASS_TOP_M - GLASS_BOTTOM_M;
    const back = new THREE.Mesh(
        new THREE.BoxGeometry(lengthM - 0.2, glassHeight, 0.04),
        mats.glass,
    );
    back.position.set(0, GLASS_BOTTOM_M + glassHeight / 2, depthM / 2 - 0.06);
    group.add(back);
    for (const sx of [-1, 1]) {
        const side = new THREE.Mesh(
            new THREE.BoxGeometry(0.04, glassHeight, depthM - 0.25),
            mats.glass,
        );
        side.position.set(sx * (lengthM / 2 - 0.06), GLASS_BOTTOM_M + glassHeight / 2, 0);
        group.add(side);
    }

    const bench = new THREE.Mesh(
        new THREE.BoxGeometry(Math.max(1.2, lengthM * 0.6), 0.06, 0.4),
        mats.bench,
    );
    bench.position.set(0, BENCH_HEIGHT_M, depthM / 2 - 0.35);
    group.add(bench);

    group.rotation.y = fit.angleY;
    group.position.set(fit.x, foundationY, fit.z);
    return group;
}
