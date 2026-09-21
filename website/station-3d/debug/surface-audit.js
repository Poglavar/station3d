// Browser runner for the ground-surface audit (core/surface-audit.js): samples
// a plan grid around the camera, collects every claimed surface a vertical ray
// meets in the live scene, and reports hierarchy violations as JSON plus a
// coloured point overlay. Exposed as window.__s3dSurfaceAudit(options).

import * as THREE from 'three';
import { surfaceClaimForObject } from '../core/surface-claim.js';
import { surfacePublicationIdentityForObject } from '../core/surface-publication-registry.js';
import {
    inspectionLayerForObject,
    isEffectivelyVisible,
    isInspectionOverlay,
} from '../core/scene-inspection.js';
import { buildFormationTerrainCutoutQuery } from '../core/formation-terrain-cutout-query.js';
import { localToGeo } from '../core/math.js';
import { ownerRangeForFace } from '../core/geometry-batch.js';
import { getBackgroundActivitySnapshot } from '../core/background-activity.js';
import { createSurfaceAuditRecording } from '../core/surface-audit-recording.js';
import { groundPaintAuditHits } from '../core/ground-paint-inspection.js';
import {
    SURFACE_CLASS,
    SURFACE_ROLE,
    reviseSurfaceClaim,
    SURFACE_STENCIL_COMPARE,
    SURFACE_STENCIL_OPERATION,
} from '../core/surface-hierarchy.js';
import {
    SURFACE_AUDIT_VIOLATION,
    buildPlanTriangleIndex,
    classifySurfaceStack,
    depthResolutionM,
    planTriangleHitsAt,
    summarizeSurfaceAudit,
} from '../core/surface-audit.js';

const OVERLAY_NAME = 'SurfaceAuditOverlay';
const VIOLATION_COLOURS = Object.freeze({
    [SURFACE_AUDIT_VIOLATION.INVERSION]: 0xff2d55,
    [SURFACE_AUDIT_VIOLATION.VOID]: 0xb65cff,
    [SURFACE_AUDIT_VIOLATION.MISSING_PAINT]: 0xb65cff,
    [SURFACE_AUDIT_VIOLATION.FLOATING]: 0x33c7ff,
    [SURFACE_AUDIT_VIOLATION.DUPLICATE]: 0xff9500,
    [SURFACE_AUDIT_VIOLATION.COPLANAR]: 0xffcc00,
});
// When one sample carries several violations, the overlay shows the first.
const OVERLAY_PRIORITY = Object.freeze(Object.keys(VIOLATION_COLOURS));

let auditOptions = null;
let overlay = null;
let lastReport = null;

function round(value, digits = 3) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Number(value.toFixed(digits))
        : null;
}

// The material's real GPU stencil state, not what the registry intended: a
// producer that bypasses the registry is audited as it actually renders.
function stencilContractForMaterial(material) {
    if (!material?.stencilWrite) return null;
    const compare = material.stencilFunc === THREE.EqualStencilFunc
        ? SURFACE_STENCIL_COMPARE.EQUAL
        : material.stencilFunc === THREE.NotEqualStencilFunc
            ? SURFACE_STENCIL_COMPARE.NOT_EQUAL
            : SURFACE_STENCIL_COMPARE.ALWAYS;
    return {
        enabled: true,
        ref: material.stencilRef,
        funcMask: material.stencilFuncMask,
        writeMask: material.stencilWriteMask,
        compare,
        zPass: material.stencilZPass === THREE.ReplaceStencilOp
            ? SURFACE_STENCIL_OPERATION.REPLACE
            : SURFACE_STENCIL_OPERATION.KEEP,
    };
}

function positionArray(attribute) {
    if (!attribute.isInterleavedBufferAttribute) {
        return { positions: attribute.array, itemSize: attribute.itemSize };
    }
    const positions = new Float32Array(attribute.count * 3);
    for (let vertex = 0; vertex < attribute.count; vertex++) {
        positions[vertex * 3] = attribute.getX(vertex);
        positions[vertex * 3 + 1] = attribute.getY(vertex);
        positions[vertex * 3 + 2] = attribute.getZ(vertex);
    }
    return { positions, itemSize: 3 };
}

function contentHash(value) {
    let hash = 2166136261;
    for (const char of JSON.stringify(value)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    return hash.toString(16);
}

function groundContentSignature(plan, claim, material) {
    const triangles = plan.elements.map(element => {
        const vertices = [0, 1, 2].flatMap(offset => {
            const vertex = plan.index ? plan.index[element + offset] : element + offset;
            return [plan.world[vertex * 3], plan.world[vertex * 3 + 1], plan.world[vertex * 3 + 2]];
        });
        return contentHash([vertices, plan.hitIdentity?.(element / 3) ?? null]);
    }).sort();
    // Three increments material.version during every two-pass transparent
    // DoubleSide draw. It is a program-invalidation counter, not content.
    return contentHash([triangles, claim, material.customProgramCacheKey?.(), material.color?.getHex(), material.opacity,
        material.visible, material.colorWrite, material.side, material.map?.uuid,
        material.map?.version, material.alphaTest, material.transparent, material.depthTest,
        material.depthWrite, material.polygonOffset, material.polygonOffsetFactor,
        material.polygonOffsetUnits, material.userData?.terrainExactFormationCutouts === true,
        stencilContractForMaterial(material)]);
}

export function surfaceAuditClaimForFace(ranges, faceIndex) {
    const range = ownerRangeForFace(ranges, faceIndex);
    return range ? range.claim : null;
}

function surfaceAuditIdentityForRange(range) {
    return JSON.stringify([range?.ownerKey ?? null, range?.claim ?? null]);
}

// Also used by headless THREE fixtures: group/owner ranges must match the
// drawn element range, including two owners inside one merged geometry.
export function collectAuditSurfaces(scene, bounds) {
    const surfaces = [];
    const box = new THREE.Box3();
    let triangleCount = 0;
    const skipped = {};
    const skippedInventory = [];
    const content = [];
    const contentRevisions = [];
    const skip = (object, reason, worldBox = null) => {
        const measured = worldBox && [worldBox.min.x, worldBox.max.x,
            worldBox.min.z, worldBox.max.z].every(Number.isFinite);
        const outside = measured && (worldBox.max.x < bounds.minX || worldBox.min.x > bounds.maxX
            || worldBox.max.z < bounds.minZ || worldBox.min.z > bounds.maxZ);
        // Unknown bounds remain uncertainty. No name/layer allowlist may hide
        // an unsupported deck, platform or unclaimed ground producer.
        if (!outside) skipped[reason] = (skipped[reason] || 0) + 1;
        skippedInventory.push({
            reason, scope: outside ? 'outside' : measured ? 'intersecting' : 'unknown',
            name: object.name || object.type, uuid: object.uuid,
            layerId: inspectionLayerForObject(object)?.id || null,
            claim: surfaceClaimForObject(object) || null,
            instances: object.isInstancedMesh ? object.count : null,
            bounds: measured ? { minX: worldBox.min.x, maxX: worldBox.max.x,
                minZ: worldBox.min.z, maxZ: worldBox.max.z } : null,
        });
    };
    scene.traverse((object) => {
        if (!object?.isMesh || object.name === OVERLAY_NAME
            || isInspectionOverlay(object) || !isEffectivelyVisible(object)) return;
        if (object.isInstancedMesh || object.isBatchedMesh || object.isSkinnedMesh) {
            // Instance/skinning transforms are absent from geometry.boundingBox.
            // Recompute the object box for this diagnostic: Three does not
            // invalidate it when setMatrixAt or a bone moves.
            let worldBox = null;
            try {
                object.computeBoundingBox();
                if (object.boundingBox) worldBox = box.copy(object.boundingBox).applyMatrix4(object.matrixWorld);
            } catch { /* Missing/malformed bounds cannot establish exclusion. */ }
            skip(object, object.isInstancedMesh ? 'instanced-mesh' : object.isBatchedMesh ? 'batched-mesh' : 'skinned-mesh', worldBox);
            return;
        }
        const geometry = object.geometry;
        const attribute = geometry?.getAttribute?.('position');
        if (!attribute || attribute.count < 3) { skip(object, 'missing-position'); return; }
        if (!geometry.boundingBox) geometry.computeBoundingBox();
        box.copy(geometry.boundingBox).applyMatrix4(object.matrixWorld);
        if (box.max.x < bounds.minX || box.min.x > bounds.maxX
            || box.max.z < bounds.minZ || box.min.z > bounds.maxZ) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        const count = geometry.index?.count ?? attribute.count;
        const drawStart = geometry.drawRange?.start ?? 0;
        const drawEnd = Math.min(count, drawStart + (geometry.drawRange?.count ?? Infinity));
        const groups = Array.isArray(object.material) ? geometry.groups
            : [{ start: 0, count, materialIndex: 0 }];
        if (!groups?.length) { skip(object, 'missing-material-groups', box); return; }
        const { positions, itemSize } = positionArray(attribute);
        const entityRanges = object.userData?.entityRanges || [];
        const surfaceAuditRanges = object.userData?.surfaceAuditRanges || null;
        const surfaceAuditIdentities = surfaceAuditRanges
            ? new Map(surfaceAuditRanges.map(range => [range, surfaceAuditIdentityForRange(range)])) : null;
        for (const group of groups) {
            const material = materials[group.materialIndex];
            const start = Math.max(drawStart, group.start);
            const end = Math.min(drawEnd, group.start + group.count);
            if (end <= start) continue;
            if (!material) { skip(object, 'missing-material', box); continue; }
            const claim = object.userData?.surfaceClaim || material.userData?.surfaceClaim
                || surfaceClaimForObject(object) || null;
            const plan = buildPlanTriangleIndex({
                positions, itemSize, index: geometry.index?.array || null,
                matrix: object.matrixWorld.elements, bounds, drawStart: start, drawCount: end - start,
                hitIdentity: face => {
                    const auditRange = surfaceAuditRanges
                        ? ownerRangeForFace(surfaceAuditRanges, face)
                        : null;
                    return surfaceAuditRanges
                        ? surfaceAuditIdentities.get(auditRange) ?? null
                        : ownerRangeForFace(entityRanges, face)?.key ?? null;
                },
            });
            if (plan.triangleCount === 0) continue;
            triangleCount += plan.triangleCount;
            const renderContract = material.userData?.surfaceRenderContract || null;
            if (claim && ![SURFACE_ROLE.VOLUME, SURFACE_ROLE.STRUCTURE, SURFACE_ROLE.VOID].includes(claim.role)) {
                const signature = groundContentSignature(plan, claim, material);
                content.push(signature);
                contentRevisions.push({ name: object.name || object.type, surfaceClass: claim.surfaceClass, signature });
            }
            surfaces.push({
                plan, claim, entityRanges, surfaceAuditRanges,
                paintReceiver: material.userData?.groundPaintReceiver || null,
                bounds: { minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z },
                name: object.name || object.type,
                layerId: inspectionLayerForObject(object)?.id || null,
                renderOrder: Number.isFinite(object.renderOrder) ? object.renderOrder : 0,
                stencil: stencilContractForMaterial(material),
                colorWrite: material.colorWrite !== false && material.visible !== false,
                side: material.side ?? THREE.FrontSide,
                removesGround: Array.isArray(renderContract?.groundRemovalChannels)
                    && renderContract.groundRemovalChannels.some(Boolean),
                exactFormationCutouts: material.userData?.terrainExactFormationCutouts === true,
                unverifiedOpening: material.userData?.plannerSurfaceCutout === true
                    || material.userData?.authoredSurfaceOpeningCutout === true,
                publicationKey: surfacePublicationIdentityForObject(object)?.key
                    ?? claim?.replacementKey ?? null,
            });
        }
    });
    // Hash the intersecting triangles, owners and appearance, not a regional
    // aggregate's UUID/version: a distant tile can replace that aggregate.
    return { surfaces, triangleCount, skipped, skippedInventory, contentRevisions, contentSignature: contentHash(content.sort()) };
}

function dominantViolationType(violations) {
    for (const type of OVERLAY_PRIORITY) {
        if (violations.some(entry => entry.type === type)) return type;
    }
    return violations[0]?.type ?? null;
}

export function clearSurfaceAuditOverlay() {
    if (!overlay) return;
    overlay.parent?.remove(overlay);
    overlay.geometry.dispose();
    overlay.material.dispose();
    overlay = null;
}

function replaceOverlay(scene, points) {
    clearSurfaceAuditOverlay();
    if (points.length === 0) return;
    const positions = new Float32Array(points.length * 3);
    const colours = new Float32Array(points.length * 3);
    const colour = new THREE.Color();
    points.forEach((point, index) => {
        positions[index * 3] = point.x;
        positions[index * 3 + 1] = point.y + 0.25;
        positions[index * 3 + 2] = point.z;
        colour.setHex(VIOLATION_COLOURS[point.type] ?? 0xffffff);
        colours[index * 3] = colour.r;
        colours[index * 3 + 1] = colour.g;
        colours[index * 3 + 2] = colour.b;
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    overlay = new THREE.Points(geometry, new THREE.PointsMaterial({
        size: 5,
        sizeAttenuation: false,
        vertexColors: true,
        depthTest: false,
        depthWrite: false,
        transparent: true,
    }));
    overlay.name = OVERLAY_NAME;
    overlay.renderOrder = 10001;
    overlay.frustumCulled = false;
    overlay.userData.station3dInspectorOverlay = true;
    overlay.raycast = () => {};
    // Children of the scene root live in absolute session metres; the render
    // origin shifts the root, not its children.
    scene.add(overlay);
}

export function runSurfaceAudit({
    radiusM = 60,
    stepM = 1,
    centerX = null,
    centerZ = null,
    nominalViewDistanceM = 150,
    inversionToleranceM = 0.01,
    floatingToleranceM = 0.3,
    showOverlay = true,
    log = true,
    recordHitStacks = false,
} = {}) {
    const scene = auditOptions?.scene;
    const camera = auditOptions?.camera;
    if (!scene || !camera) throw new Error('Surface audit is not installed on a live scene');
    const startedAt = performance.now();
    scene.updateMatrixWorld(true);
    // Outside a render the root sits at the absolute origin; a render shifts it
    // by -renderOrigin. Sample in absolute metres and query the matrices in
    // whichever frame they were just computed.
    const frameX = scene.position.x;
    const frameZ = scene.position.z;
    const cx = typeof centerX === 'number' && Number.isFinite(centerX) ? centerX : camera.position.x;
    const cz = typeof centerZ === 'number' && Number.isFinite(centerZ) ? centerZ : camera.position.z;
    const step = Math.max(0.1, Number(stepM) || 1);
    const radius = Math.max(step, Number(radiusM) || 0);
    const { surfaces, triangleCount, skipped, skippedInventory, contentSignature, contentRevisions } = collectAuditSurfaces(scene, {
        minX: cx - radius + frameX,
        maxX: cx + radius + frameX,
        minZ: cz - radius + frameZ,
        maxZ: cz + radius + frameZ,
    });

    const terrain = auditOptions.getTerrain?.() || null;
    const groundPaint = auditOptions.getGroundPaint?.() || null;
    const models = auditOptions.getFormationModels?.() || [];
    // CPU twin of the terrain shader's formation ownership discard.
    const cutout = terrain && models.length > 0
        ? buildFormationTerrainCutoutQuery({
            models,
            centerX: cx,
            centerZ: cz,
            radiusM: radius * Math.SQRT2 + 50,
            allowStale: false,
            terrainSceneYAtLocal: (x, z) => terrain.evidenceSceneYAtLocal?.(x, z),
        })
        : null;
    const coplanarGapM = depthResolutionM(nominalViewDistanceM, camera.near) ?? 0.002;
    const hitStacks = recordHitStacks ? createSurfaceAuditRecording({
        options: { coplanarGapM, inversionToleranceM, floatingToleranceM },
    }) : null;
    const anchor = auditOptions.getAnchor?.() || null;
    const hasAnchor = Number.isFinite(anchor?.lat) && Number.isFinite(anchor?.lon);

    const samples = [];
    const overlayPoints = [];
    const scratch = [];
    let sampleCount = 0;
    let invalidClaims = 0;
    let unverifiedDiscardHits = 0;
    let unclaimedHits = 0;
    const coverage = { terrainSamples: 0, expectedPaintSamples: 0, visibleGroundSamples: 0, supportSamples: 0 };
    for (let z = cz - radius + step / 2; z < cz + radius; z += step) {
        for (let x = cx - radius + step / 2; x < cx + radius; x += step) {
            sampleCount += 1;
            const queryX = x + frameX;
            const queryZ = z + frameZ;
            const hits = [];
            const expectedHits = [];
            const visiblePaint = groundPaint?.paintAt(x, z)?.record || null;
            const expectedPaint = groundPaint?.sourceAt(x, z) || null;
            let topY = -Infinity;
            for (const surface of surfaces) {
                const bounds = surface.bounds;
                if (queryX < bounds.minX || queryX > bounds.maxX
                    || queryZ < bounds.minZ || queryZ > bounds.maxZ) continue;
                scratch.length = 0;
                planTriangleHitsAt(surface.plan, queryX, queryZ, scratch);
                for (const hit of scratch) {
                    const culled = (surface.side === THREE.FrontSide && hit.normalY < 0)
                        || (surface.side === THREE.BackSide && hit.normalY > 0);
                    if (!culled && hit.y > topY) topY = hit.y;
                    const auditRange = surface.surfaceAuditRanges
                        ? ownerRangeForFace(surface.surfaceAuditRanges, hit.faceIndex)
                        : null;
                    const hitClaim = surface.surfaceAuditRanges
                        ? auditRange?.claim ?? null
                        : surface.claim;
                    if (!hitClaim) {
                        unclaimedHits += 1;
                        continue;
                    }
                    let discarded = false;
                    if (hitClaim.surfaceClass === SURFACE_CLASS.TERRAIN) {
                        // Compiled receivers already contain their cut boundary.
                        // Reapplying the analytic mask would conceal a bad mesh
                        // and would disagree with its actual shader variant.
                        discarded = !surface.exactFormationCutouts && cutout ? cutout.contains(x, z) === true : false;
                    } else if (surface.removesGround) {
                        // No CPU twin for this material's removal channel yet.
                        discarded = null;
                    }
                    if (discarded === null || surface.unverifiedOpening) unverifiedDiscardHits += 1;
                    const entity = surface.surfaceAuditRanges ? null
                        : ownerRangeForFace(surface.entityRanges, hit.faceIndex);
                    const physicalHit = {
                        y: hit.y,
                        claim: entity ? reviseSurfaceClaim(hitClaim, {
                            featureId: entity.key,
                        }) : hitClaim,
                        renderOrder: surface.renderOrder,
                        stencil: surface.stencil,
                        colorWrite: surface.colorWrite,
                        culled,
                        discarded,
                        layerId: surface.layerId,
                        objectName: surface.name,
                        ownerKey: auditRange?.ownerKey ?? entity?.key ?? null,
                        publicationKey: surface.publicationKey,
                    };
                    const observations = groundPaintAuditHits(physicalHit, {
                        receiver: surface.paintReceiver, normalY: hit.normalY,
                        visible: visiblePaint, expected: expectedPaint,
                    });
                    hits.push(...observations.hits);
                    expectedHits.push(...observations.expectedHits);
                }
            }
            const terrainCovered = terrain?.hasLoadedCoreCoverageAtLocal?.(x, z) === true;
            hitStacks?.recordCell({ x, z, terrainCovered, hits, expectedHits });
            const result = classifySurfaceStack(hits, {
                terrainCovered,
                coplanarGapM,
                inversionToleranceM,
                floatingToleranceM,
                expectedHits,
            });
            invalidClaims += result.invalidClaims;
            if (terrainCovered) coverage.terrainSamples += 1;
            if (result.coverage.expectedPaint) coverage.expectedPaintSamples += 1;
            if (result.coverage.visibleGround) coverage.visibleGroundSamples += 1;
            if (result.coverage.support) coverage.supportSamples += 1;
            if (result.violations.length === 0) continue;
            const geo = hasAnchor ? localToGeo(x, z, anchor.lon, anchor.lat) : null;
            samples.push({ x, z, lat: geo?.lat ?? null, lon: geo?.lon ?? null, violations: result.violations });
            overlayPoints.push({
                x,
                y: Number.isFinite(topY) ? topY : 0,
                z,
                type: dominantViolationType(result.violations),
            });
        }
    }

    const summary = summarizeSurfaceAudit(samples, { stepM: step, sampleCount });
    const centerGeo = hasAnchor ? localToGeo(cx, cz, anchor.lon, anchor.lat) : null;
    const publications = auditOptions.getSurfacePublications?.()?.snapshot?.() || null;
    const activity = getBackgroundActivitySnapshot({ includeIdle: true });
    const readiness = auditOptions.getGroundReadiness?.({
        minX: cx - radius, maxX: cx + radius, minZ: cz - radius, maxZ: cz + radius,
    }) || { ready: false, pending: 1, failed: 0, reason: 'Ground readiness provider missing' };
    const publicationSignature = JSON.stringify({
        contentSignature, terrainRevision: terrain?.revision,
        readiness,
    });
    const report = {
        ...summary,
        generatedAt: new Date().toISOString(),
        center: {
            x: round(cx),
            z: round(cz),
            lat: round(centerGeo?.lat, 7),
            lon: round(centerGeo?.lon, 7),
        },
        radiusM: radius,
        stepM: step,
        thresholds: {
            inversionToleranceM,
            floatingToleranceM,
            coplanarGapM: round(coplanarGapM, 5),
            nominalViewDistanceM,
            cameraNearM: camera.near,
        },
        surfaces: surfaces.length,
        claimedSurfaces: surfaces.filter(surface => surface.claim).length,
        triangles: triangleCount,
        invalidClaims,
        unverifiedDiscardHits,
        unclaimedHits,
        skippedSurfaces: Object.values(skipped).reduce((sum, count) => sum + count, 0),
        skippedByReason: skipped,
        skippedScope: 'intersecting-or-unknown-world-bounds-v1',
        skippedInventory,
        coverage,
        coverageBasis: { expectedPaint: 'published-mesh-intent', support: 'published-support-claims', gpuVerified: false },
        publicationSignature,
        contentRevisions,
        readiness: { ...readiness, ready: !!terrain && readiness.ready === true,
            scope: 'intersecting-ground-tiles-and-shared-rail-dependencies', activity,
            publications },
        terrainCutoutQuery: cutout
            ? {
                formationRings: cutout.formationRingCount ?? null,
                portalOpenings: cutout.portalOpeningRingCount ?? null,
                replacements: cutout.replacementRingCount ?? null,
            }
            : null,
        terrainRevision: terrain?.revision ?? null,
        terrainDetailRects: terrain?.detail?.rects?.length ?? 0,
        durationMs: Math.round(performance.now() - startedAt),
        ...(hitStacks ? { hitStacks: hitStacks.result() } : {}),
    };
    lastReport = report;
    if (showOverlay) replaceOverlay(scene, overlayPoints);
    else clearSurfaceAuditOverlay();
    if (log) {
        const counts = Object.entries(summary.byType)
            .filter(([, count]) => count > 0)
            .map(([type, count]) => `${type} ${count}`)
            .join(' · ') || 'clean';
        console.info(
            `[surface-audit ${report.generatedAt}] ${sampleCount} samples at ${step} m`
            + ` · ${summary.violatingSamples} violating · ${counts} · ${report.durationMs} ms`,
        );
    }
    return report;
}

export function installSurfaceAudit(options) {
    if (auditOptions?.scene && auditOptions.scene !== options?.scene) clearSurfaceAuditOverlay();
    auditOptions = options || null;
    if (typeof window === 'undefined') return;
    const audit = runOptions => runSurfaceAudit(runOptions);
    audit.clear = clearSurfaceAuditOverlay;
    Object.defineProperty(audit, 'last', { get: () => lastReport });
    window.__s3dSurfaceAudit = audit;
}
