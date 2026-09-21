// Mounts full 3D relief facades (built from LLM-recognized facade specs, see
// zagreb-zgrade-datiranje/facade-3d) onto buildings that have one. The spec is a
// declarative JSON model of the street facade (floors, openings, cornices,
// balconies…); facade-builder.js turns it into a THREE.Group in a local metre
// frame (x along wall, y up, z out). This module anchors that group onto the
// building's street wall using the same A/B lon-lat corners as facade-windows.js
// and supersedes the flat window quads for buildings that have a spec.

import * as THREE from 'three';
import { geoToLocal } from '../core/math.js';
import { buildFacade } from './facade-builder.js';
import {
    buildFacadeWallSupport,
    getFacadeEntry,
    isFacadeOpeningFullyContained,
} from './facade-windows.js';

// Static demo data: { version, buildings: { [object_id]: <facade spec> } }.
// Served from the website root next to transit.html.
const DATA_URL = 'json/facade-specs.json';
// Wall clearance: the LOD2 plaster wall sits ~0.1 m street-ward of the cadastral
// line, and the spec recesses glass up to 0.15 m BEHIND its own front face (plus
// a 0.12 m wall body). The whole assembly must clear the plaster or the recessed
// glass z-fights/buries: 0.1 + 0.15 + 0.12 + margin.
const PROUD_M = 0.55;

let specMap = null;       // object_id(string) → facade spec
let loadPromise = null;

function getOpeningAssemblyBounds(opening, floorBase, sill) {
    const x = Number(opening.x);
    const width = Number(opening.w);
    const height = Number(opening.h);
    let x0 = x;
    let x1 = x + width;
    let y0 = floorBase + sill;
    let y1 = y0 + height;

    // The arch, stone surround, sill ledge and pediment are visually part of
    // the opening. Include their full envelope so retaining a window cannot
    // leave its frame or arched glass sliced by a roof edge.
    if (opening.arch === 'round') y1 += width / 2;
    else if (opening.arch === 'segmental') y1 += Math.min(0.4, 0.12 * width);

    const surround = Number(opening.surround && opening.surround.width);
    const surroundWidth = Number.isFinite(surround) && surround > 0 ? surround : 0;
    if (surroundWidth > 0) {
        x0 -= surroundWidth;
        x1 += surroundWidth;
        y1 += surroundWidth;
        if (!opening.sillLedge) y0 -= surroundWidth;
    }
    if (opening.sillLedge) {
        x0 -= 0.1;
        x1 += 0.1;
        y0 -= 0.08;
    }
    const pediment = opening.pediment && opening.pediment.type;
    if (pediment) {
        const baseWidth = width + 2 * surroundWidth;
        if (pediment === 'triangular') y1 += Math.min(0.6, 0.35 * baseWidth);
        else if (pediment === 'segmental') y1 += Math.min(0.6, 0.2 * baseWidth);
        else y1 += 0.2;
    }
    return { x0, x1, y0, y1 };
}

export function ensureFacadeSpecData() {
    if (specMap) return Promise.resolve(specMap);
    if (loadPromise) return loadPromise;
    loadPromise = fetch(DATA_URL)
        .then((r) => (r.ok ? r.json() : { buildings: {} }))
        .then((j) => { specMap = j.buildings || {}; return specMap; })
        .catch((err) => { console.warn('[facade-spec] load failed:', err); specMap = {}; return specMap; });
    return loadPromise;
}

export function hasFacadeSpec(objectId) {
    return !!(specMap && objectId != null && specMap[String(objectId)]);
}

// Builds the anchored facade group for this building, or null. Anchoring reuses
// the facade_openings wall corners A,B (lon/lat) and the footprint centroid to
// orient the outward normal — identical conventions to buildFacadeWindowMeshes.
// The group is scaled so the spec's width/height match the measured frontage
// (width from |A-B|, height from facade_height_m when present).
export function buildFacadeSpecGroup(
    objectId,
    anchorLat,
    anchorLon,
    centroidX,
    centroidZ,
    simWallHeight,
    wallTriangles = [],
) {
    try {
        return buildFacadeSpecGroupInner(
            objectId,
            anchorLat,
            anchorLon,
            centroidX,
            centroidZ,
            simWallHeight,
            wallTriangles,
        );
    } catch (err) {
        console.warn(`[facade-spec] failed for ${objectId}:`, err);
        if (typeof window !== 'undefined') {
            (window.__facadeSpecDebug = window.__facadeSpecDebug || {})[String(objectId)] = { error: String(err && err.stack || err) };
        }
        return null;
    }
}

function buildFacadeSpecGroupInner(
    objectId,
    anchorLat,
    anchorLon,
    centroidX,
    centroidZ,
    simWallHeight,
    wallTriangles,
) {
    const spec = specMap && specMap[String(objectId)];
    const entry = getFacadeEntry(objectId);
    if (!spec || !entry) return null;

    const A = geoToLocal(entry.a_lonlat[0], entry.a_lonlat[1], anchorLon, anchorLat);
    const B = geoToLocal(entry.b_lonlat[0], entry.b_lonlat[1], anchorLon, anchorLat);
    const dirx = B.x - A.x, dirz = B.z - A.z;
    const L = Math.hypot(dirx, dirz);
    if (L < 0.5) return null;
    let dx = dirx / L, dz = dirz / L;
    // Outward normal: wall-perpendicular pointing away from the footprint centroid.
    let nx = dz, nz = -dx;
    const mx = (A.x + B.x) / 2, mz = (A.z + B.z) / 2;
    if ((mx - centroidX) * nx + (mz - centroidZ) * nz < 0) { nx = -nx; nz = -nz; }

    // Pick the wall direction that makes (x=dir, y=up, z=normal) right-handed,
    // so the facade is never mirrored: right-handed needs normal == dir × up
    // == (-dz, dx). If the outward normal is the other perpendicular, run the
    // facade B→A instead.
    let origin = A;
    if (nx * -dz + nz * dx < 0) { dx = -dx; dz = -dz; origin = B; }

    // Scale spec opening rectangles into the measured wall frame and reject
    // any that do not fit completely inside the actual rendered wall. This is
    // the same strict gable/roof containment used by the flat opening layer.
    const specW = spec.width > 0.1 ? spec.width : L;
    const floorBases = [];
    let specH = 0;
    for (const floor of spec.floors || []) {
        floorBases.push(specH);
        specH += floor && floor.height > 0 ? floor.height : 3.6;
    }
    const fh = entry.facade_height_m > 2 ? entry.facade_height_m : 0;
    const facadeHeight = fh || (simWallHeight > 2 ? simWallHeight : 0) || Infinity;
    const scaleX = L / specW;
    const scaleY = fh && specH > 1 ? fh / specH : 1;
    const supportTriangles = buildFacadeWallSupport(wallTriangles, origin, dx, dz, nx, nz);
    const originalOpenings = Array.isArray(spec.openings) ? spec.openings : [];
    const filteredOpenings = originalOpenings.filter((opening) => {
        const floorIndex = Number(opening && opening.floor);
        if (!opening || !Number.isInteger(floorIndex) || floorIndex < 0 || floorIndex >= floorBases.length) {
            return false;
        }
        const type = opening.type || 'window';
        const sill = Number.isFinite(Number(opening.sill))
            ? Number(opening.sill)
            : (type === 'window' ? 0.85 : 0);
        const bounds = getOpeningAssemblyBounds(opening, floorBases[floorIndex], sill);
        return isFacadeOpeningFullyContained({
            u_m: bounds.x0 * scaleX,
            w_m: (bounds.x1 - bounds.x0) * scaleX,
            sill_m: bounds.y0 * scaleY,
            h_m: (bounds.y1 - bounds.y0) * scaleY,
        }, L, facadeHeight, supportTriangles);
    });
    if (originalOpenings.length > 0 && filteredOpenings.length === 0) return null;
    const fittedSpec = filteredOpenings.length === originalOpenings.length
        ? spec
        : { ...spec, openings: filteredOpenings };

    let group;
    try {
        group = buildFacade(fittedSpec);
    } catch (err) {
        console.warn(`[facade-spec] build failed for ${objectId}:`, err);
        return null;
    }

    // Fit the spec to the measured wall: x to the frontage length, y to the
    // eaves height when known. Relief depth (z) stays in true metres.
    group.scale.set(scaleX, scaleY, 1);

    const container = new THREE.Group();
    container.add(group);
    const m = new THREE.Matrix4().makeBasis(
        new THREE.Vector3(dx, 0, dz),
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(nx, 0, nz),
    );
    container.quaternion.setFromRotationMatrix(m);
    container.position.set(origin.x + nx * PROUD_M, 0, origin.z + nz * PROUD_M);
    // Debug breadcrumb for QA (read via devtools/eval); harmless to leave in.
    if (typeof window !== 'undefined') {
        (window.__facadeSpecDebug = window.__facadeSpecDebug || {})[String(objectId)] = {
            at: [container.position.x, container.position.z], L, nx, nz,
            scale: [group.scale.x, group.scale.y], children: group.children.length,
            openings: [filteredOpenings.length, originalOpenings.length],
        };
    }
    return container;
}
