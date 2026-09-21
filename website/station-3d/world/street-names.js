// Street names floating over their street, in real 3D letters. On by default,
// toggled with U (ulice).
//
// The letters are extruded geometry, not billboards or HUD text: they hang in
// the air above the roofline, so they are solid objects seen from an angle, lit
// like everything else, rather than a flat overlay pasted on the view.
//
// Each one turns to face the player, and there is exactly ONE per street: the
// API anchors a street every ~160 m and each map tile answers for its own bbox,
// so a street crossing the view arrives many times over. Only the anchor nearest
// the player is mounted, re-picked as they walk.
//
// There is no font asset. Outlines are traced from the browser's own rasterised
// glyphs (canvas → boundary loops → THREE.Shape → ExtrudeGeometry), so every
// Croatian diacritic renders exactly as the system font draws it — a typeface
// JSON would have had to carry č/ć/ž/š/đ, and the ones three.js ships do not.

import * as THREE from 'three';
import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';
import { getApiBase } from '../core/api.js';
import { disposeGroup, registerShared } from '../core/dispose.js';
import { evidencePlacementBaseSceneY } from '../core/terrain-placement.js';
import { traceRasterLoops, extrudeLabelShapesSteps } from '../core/street-label-geometry.js';
import { recordLayerFrameMs } from '../scene/animate.js';
import { scene, camera } from '../scene/setup.js';

const LABEL_CAP_HEIGHT_M = 2.0;     // the letters themselves, as asked
const LABEL_DEPTH_M = 0.12;         // extrusion — enough to read as solid
const LABEL_MIN_FLOAT_M = 30;       // clear of the roofline, so nothing buries them
const LABEL_MAX_FLOAT_M = 60;
const LABEL_MAX_DIST_M = 300;       // beyond this a 2 m letter is a smudge
const LABEL_REPICK_MOVE_M = 25;     // walk this far and the nearest anchor is re-chosen
const RASTER_FONT_PX = 64;
const RASTER_PAD_PX = 6;
const CONTOUR_SIMPLIFY_PX = 0.9;

let group = null;
let tileSource = null;
let tileSubscription = null;
let terrainReference = null;
let terrainUnsubscribe = null;
let anchorLat = 0;
let anchorLon = 0;
let visible = false;
let presentationHidden = false;
let keyBound = false;
const geometryCache = new Map();    // name → ExtrudeGeometry
const anchors = [];                 // every candidate position, from every tile
const mounted = new Map();          // name → { mesh, x, z } — the one label per street
let desiredAnchors = new Map();      // name → currently selected nearest anchor
let pendingMounts = [];              // names waiting for one bounded build/mount stage
let activeGeometryBuild = null;      // { name, iterator }
let pickX = 0;
let pickZ = 0;
let picksDirty = true;
let yawX = NaN;                     // camera position the labels were last aimed from
let yawZ = NaN;

let material = null;
function getLabelMaterial() {
    if (material) return material;
    // One material for every label: opacity cannot be per-label without cloning
    // it, so labels are culled by distance rather than faded out.
    material = new THREE.MeshStandardMaterial({
        color: 0xf3f0e8,
        emissive: 0x2a2926,          // legible against dark asphalt at dusk
        emissiveIntensity: 0.5,
        roughness: 0.65,
        metalness: 0.05,
    });
    registerShared(material);
    return material;
}

// ─── Glyph outlines ────────────────────────────────────────────────────────
// The bitmap boundary is walked as axis-aligned unit edges between an inside
// pixel and an outside one. Every endpoint is an integer, so loops close
// exactly — no epsilon, no dangling contour — and the staircase they produce is
// simplified afterwards.

function simplify(points, tolerance) {
    if (points.length < 3) return points;
    const keep = new Array(points.length).fill(false);
    keep[0] = true;
    keep[points.length - 1] = true;
    const stack = [[0, points.length - 1]];
    while (stack.length > 0) {
        const [first, last] = stack.pop();
        if (last <= first + 1) continue;
        const [ax, ay] = points[first];
        const [bx, by] = points[last];
        const dx = bx - ax;
        const dy = by - ay;
        const lengthSq = dx * dx + dy * dy;
        let worst = -1;
        let worstIndex = -1;
        for (let i = first + 1; i < last; i++) {
            const [px, py] = points[i];
            const t = lengthSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lengthSq : 0;
            const clamped = Math.max(0, Math.min(1, t));
            const ex = ax + dx * clamped - px;
            const ey = ay + dy * clamped - py;
            const distSq = ex * ex + ey * ey;
            if (distSq > worst) { worst = distSq; worstIndex = i; }
        }
        if (worst > tolerance * tolerance) {
            keep[worstIndex] = true;
            stack.push([first, worstIndex], [worstIndex, last]);
        }
    }
    return points.filter((_, index) => keep[index]);
}

function signedArea(points) {
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
        const [ax, ay] = points[i];
        const [bx, by] = points[(i + 1) % points.length];
        sum += ax * by - bx * ay;
    }
    return sum / 2;
}

function pointInPolygon(px, py, points) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i];
        const [xj, yj] = points[j];
        const intersects = (yi > py) !== (yj > py)
            && px < ((xj - xi) * (py - yi)) / (yj - yi || 1e-9) + xi;
        if (intersects) inside = !inside;
    }
    return inside;
}

function* buildTextGeometrySteps(text) {
    const canvas = document.createElement('canvas');
    const measureCtx = canvas.getContext('2d', { willReadFrequently: true });
    const font = `700 ${RASTER_FONT_PX}px "Helvetica Neue", Arial, sans-serif`;
    measureCtx.font = font;
    const metrics = measureCtx.measureText(text);
    const width = Math.ceil(metrics.width) + RASTER_PAD_PX * 2;
    const height = Math.ceil(RASTER_FONT_PX * 1.5) + RASTER_PAD_PX * 2;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.font = font;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#fff';
    ctx.fillText(text, RASTER_PAD_PX, RASTER_PAD_PX + RASTER_FONT_PX);

    const { data } = ctx.getImageData(0, 0, width, height);
    const inside = new Uint8Array(width * height);
    for (let start = 0; start < inside.length; start += 8192) {
        const end = Math.min(inside.length, start + 8192);
        for (let i = start; i < end; i++) inside[i] = data[i * 4 + 3] > 128 ? 1 : 0;
        yield { phase: 'raster-mask' };
    }

    yield { phase: 'raster' };
    const rawLoops = yield* traceRasterLoops(inside, width, height);
    const loops = [];
    for (const raw of rawLoops) {
        const loop = simplify(raw, CONTOUR_SIMPLIFY_PX);
        if (loop.length >= 3 && Math.abs(signedArea(loop)) > 2) loops.push(loop);
        yield { phase: 'contour-simplify' };
    }
    if (loops.length === 0) return null;

    // A loop with an odd number of loops around it is a hole (the counter of an
    // "o", the eye of an "e"); the rest are the letters themselves.
    yield { phase: 'contours' };
    const ordered = loops
        .map((points) => ({ points, area: Math.abs(signedArea(points)) }))
        .sort((a, b) => b.area - a.area);
    const outers = [];
    const holes = [];
    let classificationChecks = 0;
    for (let loopIndex = 0; loopIndex < ordered.length; loopIndex += 1) {
        const loop = ordered[loopIndex];
        const [px, py] = loop.points[0];
        let depth = 0;
        for (const other of ordered) {
            if (other === loop) continue;
            if (other.area <= loop.area) continue;
            if (pointInPolygon(px, py, other.points)) depth++;
            classificationChecks += 1;
            if (classificationChecks % 32 === 0) {
                yield { phase: 'shape-classification' };
            }
        }
        (depth % 2 === 0 ? outers : holes).push(loop);
    }
    if (outers.length === 0) return null;

    // px → metres, with the canvas's downward y flipped into world-up.
    const scale = LABEL_CAP_HEIGHT_M / (RASTER_FONT_PX * 0.72);
    const toShapePoint = ([x, y]) => new THREE.Vector2(x * scale, (height - y) * scale);

    const shapes = [];
    let holeChecks = 0;
    for (const { points, area } of outers) {
        const shape = new THREE.Shape(points.map(toShapePoint));
        for (const hole of holes) {
            const [hx, hy] = hole.points[0];
            if (hole.area < area && pointInPolygon(hx, hy, points)) {
                shape.holes.push(new THREE.Path(hole.points.map(toShapePoint)));
            }
            holeChecks += 1;
            if (holeChecks % 16 === 0) yield { phase: 'shape-holes' };
        }
        shapes.push(shape);
        yield { phase: 'shapes' };
    }

    // ExtrudeGeometry lays the shape in XY and extrudes along +Z, which is
    // already what an upright letter is: X across the text, Y up, Z the
    // thickness. So the glyphs read forwards to anyone looking down -Z at them,
    // and yawing the mesh to face the player is all the orientation there is.
    // Centred, so the mesh sits on its anchor rather than starting at it.
    return yield* extrudeLabelShapesSteps(shapes, {
        depth: LABEL_DEPTH_M,
        bevelEnabled: false,
        curveSegments: 1,
    });
}

// ─── Layer ─────────────────────────────────────────────────────────────────

function geoToLocal(lng, lat) {
    const metresPerDegree = DEG_TO_RAD * EARTH_RADIUS_M;
    return {
        x: (lng - anchorLon) * metresPerDegree * Math.cos(anchorLat * DEG_TO_RAD),
        z: -(lat - anchorLat) * metresPerDegree,
    };
}

// A street keeps one altitude wherever you meet it: hashed from the name, not
// from the anchor, so a label does not hop up and down as you walk along it and
// the nearest anchor changes underneath it.
function floatHeightFor(name) {
    let hash = 2166136261;
    for (let i = 0; i < name.length; i++) {
        hash ^= name.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    const unit = ((hash >>> 0) % 1024) / 1024;
    return LABEL_MIN_FLOAT_M + unit * (LABEL_MAX_FLOAT_M - LABEL_MIN_FLOAT_M);
}

function addAnchor(label, tileKey) {
    const { x, z } = geoToLocal(label.lng, label.lat);
    anchors.push({ name: label.name, x, z, tileKey });
    picksDirty = true;
}

function clearTile(tileKey) {
    for (let i = anchors.length - 1; i >= 0; i--) {
        if (anchors[i].tileKey === tileKey) anchors.splice(i, 1);
    }
    picksDirty = true;
}

function unmount(name) {
    const label = mounted.get(name);
    if (!label) return;
    group.remove(label.mesh);   // the geometry is cached per name and outlives the mesh
    mounted.delete(name);
}

function mountDesiredLabel(name, cx, cz) {
    const anchor = desiredAnchors.get(name);
    if (!anchor || !group || !visible) return false;
    const geometry = geometryCache.get(name);
    if (!geometry) return false;
    const groundY = evidencePlacementBaseSceneY(
        terrainReference,
        anchor.x,
        anchor.z,
    );
    if (groundY === null) return false;
    const existing = mounted.get(name);
    if (existing) unmount(name);
    const mesh = new THREE.Mesh(geometry, getLabelMaterial());
    mesh.name = 'StreetName';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // Float height is measured over genuine local ground. While a moving
    // terrain window is absent, leave the label unpublished rather than
    // baking the visible fallback datum into its transform.
    mesh.position.set(anchor.x, floatHeightFor(name) + groundY, anchor.z);
    mesh.rotation.y = Math.atan2(cx - anchor.x, cz - anchor.z);
    mesh.visible = visible;
    group.add(mesh);
    mounted.set(name, { mesh, x: anchor.x, z: anchor.z });
    return true;
}

// Advance at most one named stage per animation frame. Rasterization, contour
// tracing, shape classification, extrusion, and scene publication therefore
// cannot accumulate into the former all-label 40 ms repick task.
function stepPendingMount(cx, cz) {
    if (!activeGeometryBuild) {
        while (pendingMounts.length > 0) {
            const name = pendingMounts.shift();
            if (!desiredAnchors.has(name) || mounted.has(name)) continue;
            if (geometryCache.has(name)) {
                const startedMs = performance.now();
                mountDesiredLabel(name, cx, cz);
                recordLayerFrameMs('streetNames:mount', performance.now() - startedMs);
                return;
            }
            activeGeometryBuild = {
                name,
                iterator: buildTextGeometrySteps(name),
            };
            break;
        }
    }
    if (!activeGeometryBuild) return;

    const build = activeGeometryBuild;
    const deadline = performance.now() + 2;
    try {
        // Tiny contour chunks may share a frame, but every chunk consults the
        // clock. One yield per frame would make long names take seconds to
        // appear even though most stages cost only a fraction of a millisecond.
        do {
            const startedMs = performance.now();
            const result = build.iterator.next();
            recordLayerFrameMs(
                `streetNames:build:${result.done ? 'extrude' : result.value?.phase || 'stage'}`,
                performance.now() - startedMs,
            );
            if (result.done) {
                geometryCache.set(build.name, result.value || null);
                activeGeometryBuild = null;
                mountDesiredLabel(build.name, cx, cz);
                return;
            }
        } while (performance.now() < deadline);
    } catch (err) {
        console.warn('[street-names] could not build', build.name, err);
        geometryCache.set(build.name, null);
        activeGeometryBuild = null;
    }
}

// One label per street: the anchor nearest the player, of all the anchors that
// carry that name. Everything else with the same name stays unmounted.
function repick(cx, cz) {
    const nearest = new Map();
    const maxDistSq = LABEL_MAX_DIST_M * LABEL_MAX_DIST_M;
    for (const anchor of anchors) {
        const distSq = (cx - anchor.x) ** 2 + (cz - anchor.z) ** 2;
        if (distSq > maxDistSq) continue;
        const best = nearest.get(anchor.name);
        if (!best || distSq < best.distSq) nearest.set(anchor.name, { anchor, distSq });
    }
    desiredAnchors = new Map(
        [...nearest.entries()].map(([name, { anchor }]) => [name, anchor]),
    );
    pendingMounts = [];
    if (activeGeometryBuild && !desiredAnchors.has(activeGeometryBuild.name)) {
        activeGeometryBuild.iterator.return?.();
        activeGeometryBuild = null;
    }
    for (const name of [...mounted.keys()]) {
        if (!nearest.has(name)) unmount(name);
    }
    for (const [name, { anchor }] of [...nearest.entries()]
        .sort((a, b) => a[1].distSq - b[1].distSq)) {
        const existing = mounted.get(name);
        const groundY = evidencePlacementBaseSceneY(
            terrainReference,
            anchor.x,
            anchor.z,
        );
        if (groundY === null) {
            if (existing) unmount(name);
            continue;
        }
        if (existing && existing.x === anchor.x && existing.z === anchor.z) {
            existing.mesh.position.y = floatHeightFor(name) + groundY;
            continue;
        }
        if (existing) unmount(name);
        if (activeGeometryBuild?.name !== name) pendingMounts.push(name);
    }
    pickX = cx;
    pickZ = cz;
    picksDirty = false;
}

function setVisible(next) {
    visible = next;
    for (const label of mounted.values()) label.mesh.visible = next;
    if (next) {
        picksDirty = true;   // pick from wherever the player is standing now
    } else {
        pendingMounts = [];
        activeGeometryBuild?.iterator?.return?.();
        activeGeometryBuild = null;
    }
}

// A scripted camera can pass directly through these large world labels.
// Hide their parent for the presentation, preserving the player's U toggle.
export function setStreetNamesPresentationHidden(hidden) {
    presentationHidden = hidden === true;
    if (group) group.visible = !presentationHidden;
}

export const streetNamesLayer = {
    beginSession({ anchorLat: lat, anchorLon: lon, sharedTileSession, terrain }) {
        terrainUnsubscribe?.();
        terrainUnsubscribe = null;
        anchorLat = lat;
        anchorLon = lon;
        terrainReference = terrain || null;
        terrainUnsubscribe = terrainReference?.onChange?.(() => {
            picksDirty = true;
        }) || null;
        visible = true;
        anchors.length = 0;
        mounted.clear();
        desiredAnchors = new Map();
        pendingMounts = [];
        activeGeometryBuild = null;
        picksDirty = true;
        group = new THREE.Group();
        group.name = 'StreetNames';
        group.visible = !presentationHidden;
        scene.add(group);

        if (!keyBound) {
            keyBound = true;
            document.addEventListener('keydown', (e) => {
                if (e.metaKey || e.ctrlKey || e.altKey) return;
                const target = e.target;
                if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
                    || target.isContentEditable)) return;
                if ((e.key || '').toLowerCase() !== 'u') return;
                if (!group) return;
                setVisible(!visible);
                console.log('[street-names]', visible ? 'ON' : 'OFF');
            });
        }

        if (!sharedTileSession) return;
        tileSource = sharedTileSession.getSource({
            key: 'roads:labels',
            label: 'street-names',
            url: (bbox) => `${getApiBase()}/roads/labels`
                + `?bbox=${bbox.west},${bbox.south},${bbox.east},${bbox.north}`,
            parseFeatures: (data) => (data && data.labels) || [],
            validatePayload: (data) => Array.isArray(data?.labels),
            // First incremental movement-time experiment: this endpoint is
            // tiny and orientation-critical, so it may parse/publish inside
            // the shared 0.5 ms idle budget while full scenery remains paused.
            allowDuringMovement: true,
        });
        tileSubscription = tileSource.subscribe({
            onFetch: (features, tileKey) => {
                if (!group) return;
                for (const label of features) {
                    if (!label || !label.name || !Number.isFinite(label.lat)) continue;
                    addAnchor(label, tileKey);
                }
            },
            onEvict: (tileKey) => {
                if (!group) return;
                clearTile(tileKey);
            },
        });
    },

    onFrame(pose, local) {
        // Toggled off (U), the layer costs one comparison per frame: no tiles
        // are streamed, no glyph is rasterised, no new mesh is mounted.
        if (presentationHidden || !visible || !group || !camera) return;
        if (tileSource && local) tileSource.ensureAround(local.x, local.z);
        const cx = camera.position.x;
        const cz = camera.position.z;
        // Re-picked on distance walked, not on a timer: the set only changes
        // because the player moved, so a timer would either lag behind them or
        // keep firing while they stand still.
        if (picksDirty || Math.hypot(cx - pickX, cz - pickZ) > LABEL_REPICK_MOVE_M) {
            repick(cx, cz);
        }
        stepPendingMount(cx, cz);
        // A label's heading depends only on where the player IS, so standing
        // still means there is nothing to re-aim — the loop below runs while
        // they move and not otherwise.
        if (cx === yawX && cz === yawZ) return;
        yawX = cx;
        yawZ = cz;
        // Every label turns to face the player, so a name can never read
        // backwards. Yaw only — the letters stay upright.
        for (const label of mounted.values()) {
            const dx = cx - label.x;
            const dz = cz - label.z;
            // Directly underneath one, the bearing to it is undefined and the
            // label would spin on the spot. Keep the heading it already had.
            if (dx * dx + dz * dz < 4) continue;
            label.mesh.rotation.y = Math.atan2(dx, dz);
        }
    },

    endSession() {
        presentationHidden = false;
        terrainUnsubscribe?.();
        terrainUnsubscribe = null;
        terrainReference = null;
        if (tileSubscription) tileSubscription();
        tileSubscription = null;
        tileSource = null;
        anchors.length = 0;
        for (const name of [...mounted.keys()]) unmount(name);
        desiredAnchors = new Map();
        pendingMounts = [];
        activeGeometryBuild?.iterator?.return?.();
        activeGeometryBuild = null;
        picksDirty = true;
        yawX = NaN;
        yawZ = NaN;
        if (group) {
            disposeGroup(group);
            group = null;
        }
        for (const geometry of geometryCache.values()) {
            if (geometry) geometry.dispose();
        }
        geometryCache.clear();
        visible = false;
    },
};
