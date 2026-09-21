// General-purpose Shift+click scene inspector. It raycasts every registered
// world surface, reports the camera ray plus a vertical stack at the selected
// X/Z, highlights the owning feature when possible, and exposes reversible
// layer visibility controls in a docked diagnostics panel.

import { groundPaintReceiverAcceptsPaint } from '../core/ground-paint-receiver-claim.js';
import * as THREE from 'three';
import { analyzeFacadeSurfaceGeometry } from '../core/facade-surface-inspection.js';
import { localToGeo } from '../core/math.js';
import { inspectionIdentityForHit } from '../core/inspection-identity.js';
import { ownerRangeForFace } from '../core/geometry-batch.js';
import { surfaceClaimForObject } from '../core/surface-claim.js';
import { surfacePublicationIdentityForObject } from '../core/surface-publication-registry.js';
import { onLangChange, t } from '../core/i18n.js';
import {
    absoluteInspectionPoint,
    collectInspectionLayers,
    distinctInspectionHits,
    formatInspectionReport,
    groupInspectionLayers,
    hiddenInspectionLayerIds,
    inspectionLayerForObject,
    isEffectivelyVisible,
    isInspectionOverlay,
    resetInspectionLayerVisibility,
    setInspectionLayerVisible,
    setInspectionLayersVisible,
    summarizeInspectionUserData,
} from '../core/scene-inspection.js';

const VERTICAL_RAY_TOP_M = 2500;
const VERTICAL_RAY_DEPTH_M = 5000;
const MAX_REPORTED_HITS = 60;
const HIGHLIGHT_COLOR = 0xff3ed1;
const CROSS_MESH_RAY_GAP_M = 0.05;
const NORMAL_PARALLEL_DOT = 0.95;

const raycaster = new THREE.Raycaster();
const verticalRaycaster = new THREE.Raycaster();
const mouseNdc = new THREE.Vector2();
const verticalOrigin = new THREE.Vector3();
const verticalDirection = new THREE.Vector3(0, -1, 0);

let attachedDom = null;
let attachedHandler = null;
let currentOptions = null;
let panelEl = null;
let resultsEl = null;
let layerListEl = null;
let summaryEl = null;
let detailEl = null;
let copyButtonEl = null;
let unsubscribeLang = null;
let currentReport = null;
let activeHighlight = null;
let facadeAnalysisCache = new WeakMap();
let hitDescriptionCache = new WeakMap();
const expandedInspectionTopics = new Set();

const TOPIC_TRANSLATION_KEYS = {
    Buildings: 'inspector.topic.buildings',
    'Civil works': 'inspector.topic.civilWorks',
    Diagnostics: 'inspector.topic.diagnostics',
    Ground: 'inspector.topic.ground',
    Other: 'inspector.topic.other',
    Plans: 'inspector.topic.plans',
    'Street furniture': 'inspector.topic.streetFurniture',
    Transport: 'inspector.topic.transport',
    Unregistered: 'inspector.topic.unregistered',
    Vegetation: 'inspector.topic.vegetation',
    Water: 'inspector.topic.water',
};

function round(value, digits = 3) {
    const number = Number(value);
    return Number.isFinite(number) ? Number(number.toFixed(digits)) : null;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function topicLabel(category) {
    const key = TOPIC_TRANSLATION_KEYS[category];
    return key ? t(key) : category;
}

function effectiveMaterial(hit) {
    const material = hit?.object?.material;
    if (!Array.isArray(material)) return material || null;
    const groupIndex = Number(hit?.face?.materialIndex);
    return material[Number.isInteger(groupIndex) ? groupIndex : 0] || null;
}

function materialSummary(hit) {
    const material = effectiveMaterial(hit);
    if (!material) return null;
    return {
        type: material.type || null,
        name: material.name || null,
        uuid: material.uuid || null,
        color: material.color?.getHexString?.() ? `#${material.color.getHexString()}` : null,
        map: material.map?.name || material.map?.source?.data?.currentSrc
            || material.map?.source?.data?.src || null,
        opacity: round(material.opacity),
        transparent: material.transparent === true,
        visible: material.visible !== false,
        colorWrite: material.colorWrite !== false,
        depthTest: material.depthTest !== false,
        depthWrite: material.depthWrite !== false,
        stencilWrite: material.stencilWrite === true,
        surfaceClaim: material.userData?.surfaceClaim
            ? summarizeInspectionUserData(material.userData.surfaceClaim)
            : null,
        surfaceRenderContract: material.userData?.surfaceRenderContract
            ? summarizeInspectionUserData(material.userData.surfaceRenderContract)
            : null,
        surfaceStencilContract: material.userData?.surfaceStencilContract
            ? summarizeInspectionUserData(material.userData.surfaceStencilContract)
            : null,
        shaderHooks: summarizeInspectionUserData({
            groundRemovalChannels: material.userData?.groundRemovalChannels,
            groundHoleMask: material.userData?.groundHoleMask,
            groundWaterMask: material.userData?.groundWaterMask,
            plannerSurfaceCutout: material.userData?.plannerSurfaceCutout,
            corridorPatched: material.userData?.__corridorPatched,
            urbanGroundSurface: material.userData?.urbanGroundSurface,
            urbanGroundSurfaceMode: material.userData?.urbanGroundSurfaceMode,
        }),
        polygonOffset: material.polygonOffset === true
            ? {
                factor: round(material.polygonOffsetFactor),
                units: round(material.polygonOffsetUnits),
            }
            : null,
    };
}

function renderRoleForHit(hit) {
    const material = effectiveMaterial(hit);
    if (!material || material.visible === false) return 'material-hidden';
    if (material.colorWrite === false) return material.stencilWrite === true
        ? 'stencil/mask geometry'
        : 'non-color helper geometry';
    if (material.opacity === 0) return 'transparent helper geometry';
    const described = describeHit(hit);
    if (described?.renderRole) return described.renderRole;
    if (material.userData?.groundRemovalChannels
        || material.userData?.groundHoleMask
        || material.userData?.groundWaterMask
        || material.userData?.plannerSurfaceCutout
        || material.userData?.__corridorPatched) return 'shader-conditional color surface';
    return 'visible color surface';
}

function preferredVisibleHit(hits) {
    return hits.find(hit => renderRoleForHit(hit) === 'visible color surface')
        || hits.find(hit => renderRoleForHit(hit) === 'shader-conditional color surface')
        || hits[0]
        || null;
}

function describeHit(hit) {
    if (!hit || typeof hit !== 'object') return null;
    if (hitDescriptionCache.has(hit)) return hitDescriptionCache.get(hit);
    if (typeof currentOptions?.describeHit !== 'function') return null;
    try {
        const result = currentOptions.describeHit(hit);
        const description = result && typeof result === 'object' ? result : null;
        hitDescriptionCache.set(hit, description);
        return description;
    } catch (error) {
        console.warn('[inspect] hit classification failed', error);
        hitDescriptionCache.set(hit, null);
        return null;
    }
}

function scenePath(object) {
    const path = [];
    for (let node = object; node; node = node.parent) {
        path.unshift(node.name || node.type || `Object3D#${node.id}`);
        if (node.isScene) break;
    }
    return path;
}

function inheritedInspectionSummary(object, key) {
    for (let node = object; node; node = node.parent) {
        if (node?.userData?.[key] != null) {
            return summarizeInspectionUserData(node.userData[key]);
        }
    }
    return null;
}

function worldNormalForHit(hit) {
    if (!hit?.face?.normal || !hit.object?.matrixWorld) return null;
    return hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
}

function surfacePublicationSummary(object, claim) {
    const identity = surfacePublicationIdentityForObject(object);
    const key = identity?.key || claim?.replacementKey;
    if (!key) return null;
    const registry = currentOptions?.getSurfacePublications?.() || null;
    const active = registry?.getActive?.(key) || null;
    let belongsToActiveRoot = false;
    for (let node = object; node; node = node.parent) {
        if (node === active?.root) {
            belongsToActiveRoot = true;
            break;
        }
    }
    return {
        key,
        generation: identity?.generation ?? claim?.generation ?? null,
        activeGeneration: active?.generation ?? null,
        status: !registry
            ? 'registry-unavailable'
            : !active
                ? 'unregistered-owner'
                : belongsToActiveRoot
                    ? 'active-owner'
                    : 'competing-owner',
    };
}

function hitSummary(hit, index, referenceY = null, renderOrigin = null) {
    const object = hit.object;
    const layer = inspectionLayerForObject(object);
    const identity = inspectionIdentityForHit(hit);
    const normal = worldNormalForHit(hit);
    const surfaceClaim = surfaceClaimForObject(object);
    const absolutePoint = absoluteInspectionPoint(hit.point, renderOrigin);
    const receiver = effectiveMaterial(hit)?.userData?.groundPaintReceiver;
    const paint = currentOptions?.getGroundPaint?.();
    const materialPaint = receiver?.key === paint?.receiver.key && normal?.y > .01 && absolutePoint
        ? paint.paintAt(absolutePoint.x, absolutePoint.z) : null;
    const record = materialPaint?.record;
    return {
        index,
        layer: layer ? {
            id: layer.id,
            label: layer.label,
            category: layer.category,
            source: layer.source,
            description: layer.description || null,
        } : null,
        object: {
            name: object?.name || null,
            type: object?.type || null,
            uuid: object?.uuid || null,
            path: scenePath(object),
            visible: isEffectivelyVisible(object),
            renderOrder: round(object?.renderOrder, 0),
        },
        feature: {
            key: identity.key ?? null,
            objectId: identity.objectId ?? null,
            batchId: identity.batchId ?? null,
            instanceId: Number.isInteger(hit.instanceId) ? hit.instanceId : null,
            metadata: identity.metadata
                ? summarizeInspectionUserData(identity.metadata)
                : null,
        },
        surface: {
            point: {
                x: round(absolutePoint?.x),
                y: round(hit.point?.y),
                z: round(absolutePoint?.z),
            },
            distanceFromCameraM: round(hit.distance),
            belowSelectedSurfaceM: Number.isFinite(referenceY)
                ? round(referenceY - hit.point.y)
                : null,
            faceIndex: Number.isInteger(hit.faceIndex) ? hit.faceIndex : null,
            normal: normal ? {
                x: round(normal.x, 4),
                y: round(normal.y, 4),
                z: round(normal.z, 4),
            } : null,
        },
        roadVerticalAlignment: inheritedInspectionSummary(
            object,
            'roadVerticalAlignment',
        ),
        material: materialSummary(hit),
        materialPaint: record && groundPaintReceiverAcceptsPaint(receiver, surfaceClaim, record) ? {
            ownerId: record.key, sourceRevision: record.sourceRevision, materialKey: record.materialKey,
            surfaceClass: record.claim.surfaceClass, receiver: record.receiver,
            cacheRevision: materialPaint.revision, cascade: materialPaint.cascade,
            supportOwner: surfaceClaim?.ownerId || null,
        } : null,
        surfaceClaim: surfaceClaim
            ? summarizeInspectionUserData(surfaceClaim)
            : null,
        surfacePublication: surfacePublicationSummary(object, surfaceClaim),
        renderRole: renderRoleForHit(hit),
        renderDiagnostic: describeHit(hit),
        userData: summarizeInspectionUserData(object?.userData),
    };
}

function facadeAnalysisForHit(hit, rayHits = []) {
    const layerId = inspectionLayerForObject(hit?.object)?.id;
    if (!hit?.object || (layerId !== 'buildings' && layerId !== 'proposal-buildings')) return null;
    if (facadeAnalysisCache.has(hit)) return facadeAnalysisCache.get(hit);
    if (hit.object.isBatchedMesh) {
        const result = {
            report: {
                status: 'unavailable',
                reason: 'face-bucket analysis is not available for BatchedMesh buildings',
            },
            highlightTriangles: null,
        };
        facadeAnalysisCache.set(hit, result);
        return result;
    }
    const range = ownerRangeForFace(hit.object.userData?.entityRanges, hit.faceIndex);
    const analysis = analyzeFacadeSurfaceGeometry(hit.object.geometry, hit.faceIndex, { range });
    const { highlightTriangles = null, ...report } = analysis;
    if (analysis.status === 'analysed') {
        const seenObjects = new Set();
        const crossMeshHits = [];
        for (const candidate of rayHits) {
            if (!candidate || candidate === hit || candidate.object === hit.object) continue;
            if (Math.abs(candidate.distance - hit.distance) > CROSS_MESH_RAY_GAP_M) continue;
            const candidateLayerId = inspectionLayerForObject(candidate.object)?.id;
            if (candidateLayerId !== 'buildings' && candidateLayerId !== 'proposal-buildings') continue;
            const candidateNormal = worldNormalForHit(candidate);
            const hitNormal = worldNormalForHit(hit);
            const normalDot = candidateNormal
                && hitNormal
                ? Math.abs(hitNormal.dot(candidateNormal))
                : 0;
            if (normalDot < NORMAL_PARALLEL_DOT) continue;
            const objectKey = candidate.object.uuid || candidate.object.id;
            if (seenObjects.has(objectKey)) continue;
            seenObjects.add(objectKey);
            const identity = inspectionIdentityForHit(candidate);
            crossMeshHits.push({
                objectId: identity.objectId ?? null,
                entityKey: identity.key ?? null,
                objectName: candidate.object.name || candidate.object.type || null,
                distanceGapM: round(Math.abs(candidate.distance - hit.distance), 4),
                normalDot: round(normalDot, 4),
            });
        }
        report.separateNearCoplanarMeshes = crossMeshHits;
    }
    const result = { report, highlightTriangles };
    facadeAnalysisCache.set(hit, result);
    return result;
}

function removeHighlight() {
    if (!activeHighlight) return;
    activeHighlight.mesh?.removeFromParent?.();
    activeHighlight.material?.dispose?.();
    if (activeHighlight.ownsGeometry) activeHighlight.geometry?.dispose?.();
    activeHighlight = null;
}

function rangeGeometryForHit(hit) {
    const ranges = hit?.object?.userData?.entityRanges;
    const range = ownerRangeForFace(ranges, hit?.faceIndex);
    if (!range || !hit.object?.geometry) return null;
    const geometry = new THREE.BufferGeometry();
    for (const [name, attribute] of Object.entries(hit.object.geometry.attributes || {})) {
        geometry.setAttribute(name, attribute);
    }
    if (hit.object.geometry.index) geometry.setIndex(hit.object.geometry.index);
    geometry.setDrawRange(range.start, range.count);
    return geometry;
}

function featureHighlightGeometry(hit, rayHits = []) {
    const facade = facadeAnalysisForHit(hit, rayHits);
    if (facade?.highlightTriangles?.length) {
        const positions = new Float32Array(facade.highlightTriangles.length * 9);
        let offset = 0;
        for (const triangle of facade.highlightTriangles) {
            for (const vertex of triangle) {
                positions[offset++] = vertex[0];
                positions[offset++] = vertex[1];
                positions[offset++] = vertex[2];
            }
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        return { geometry, parent: hit.object, sharesBuffers: false };
    }
    const rangeGeometry = rangeGeometryForHit(hit);
    if (rangeGeometry) return { geometry: rangeGeometry, parent: hit.object, sharesBuffers: true };
    if (hit?.object?.isBatchedMesh || hit?.object?.isInstancedMesh) {
        const geometry = hit.object.geometry;
        const position = geometry?.getAttribute?.('position');
        const index = geometry?.getIndex?.();
        const faceIndex = Number(hit.faceIndex);
        if (!position || !Number.isInteger(faceIndex) || faceIndex < 0) return null;
        const transform = new THREE.Matrix4();
        if (hit.object.isBatchedMesh && Number.isInteger(hit.batchId)) {
            hit.object.getMatrixAt?.(hit.batchId, transform);
        } else if (hit.object.isInstancedMesh && Number.isInteger(hit.instanceId)) {
            hit.object.getMatrixAt?.(hit.instanceId, transform);
        }
        transform.premultiply(hit.object.matrixWorld);
        const values = [];
        for (let corner = 0; corner < 3; corner++) {
            const drawIndex = faceIndex * 3 + corner;
            const vertexIndex = index ? index.getX(drawIndex) : drawIndex;
            const vertex = new THREE.Vector3().fromBufferAttribute(position, vertexIndex)
                .applyMatrix4(transform);
            values.push(vertex.x, vertex.y, vertex.z);
        }
        const triangle = new THREE.BufferGeometry();
        triangle.setAttribute('position', new THREE.Float32BufferAttribute(values, 3));
        return { geometry: triangle, parent: currentOptions?.scene, sharesBuffers: false };
    }
    if (!hit?.object?.geometry) return null;
    return { geometry: hit.object.geometry, parent: hit.object, sharesBuffers: true };
}

function highlightHit(hit, rayHits = []) {
    removeHighlight();
    const target = featureHighlightGeometry(hit, rayHits);
    if (!target) return;
    const material = new THREE.MeshBasicMaterial({
        color: HIGHLIGHT_COLOR,
        transparent: true,
        opacity: 0.62,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
    });
    const overlay = new THREE.Mesh(target.geometry, material);
    overlay.name = 'SceneInspectorHighlight';
    overlay.renderOrder = 10000;
    overlay.frustumCulled = false;
    overlay.userData.station3dInspectorOverlay = true;
    overlay.raycast = () => {};
    target.parent.add(overlay);
    activeHighlight = {
        mesh: overlay,
        geometry: target.geometry,
        material,
        ownsGeometry: target.sharesBuffers === false,
    };
}

function allRaycastTargets(scene) {
    const targets = [];
    scene?.traverse?.((object) => {
        if ((!object?.isMesh && !object?.isLine && !object?.isPoints)
            || isInspectionOverlay(object)
            || !isEffectivelyVisible(object)) return;
        targets.push(object);
    });
    return targets;
}

function copyReport() {
    if (!currentReport) return;
    const text = formatInspectionReport(currentReport);
    const copy = navigator.clipboard?.writeText
        ? navigator.clipboard.writeText(text)
        : Promise.reject(new Error('Clipboard API unavailable'));
    copy.then(() => {
        if (!copyButtonEl) return;
        copyButtonEl.textContent = t('inspector.copied');
        setTimeout(() => {
            if (copyButtonEl) copyButtonEl.textContent = t('inspector.copy');
        }, 1200);
    }).catch(() => {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand?.('copy');
        area.remove();
    });
}

function renderPanelChrome() {
    if (!panelEl) return;
    panelEl.setAttribute('aria-label', t('inspector.title'));
    panelEl.querySelector('[data-role="title"]').textContent = t('inspector.title');
    panelEl.querySelector('[data-role="shift-hint"]').textContent = t('inspector.shiftHint');
    panelEl.querySelector('.station-3d-inspector-close')
        .setAttribute('aria-label', t('inspector.close'));
    panelEl.querySelector('[data-action="copy"]').textContent = t('inspector.copy');
    panelEl.querySelector('[data-action="restore"]').textContent = t('inspector.restore');
    panelEl.querySelector('[data-role="point-heading"]').textContent = t('inspector.selectedPoint');
    panelEl.querySelector('[data-role="details-heading"]').textContent = t('inspector.details');
    panelEl.querySelector('[data-role="layers-heading"]').textContent = t('inspector.layers');
    panelEl.querySelector('[data-role="layer-hint"]').textContent = t('inspector.layerHint');
}

function closePanel() {
    if (currentOptions?.scene) resetInspectionLayerVisibility(currentOptions.scene);
    panelEl?.classList.add('hidden');
    removeHighlight();
}

function ensurePanel() {
    if (panelEl) return panelEl;
    const container = document.getElementById('station3DContainer');
    if (!container) return null;
    panelEl = document.createElement('aside');
    panelEl.className = 'station-3d-inspector hidden';
    panelEl.innerHTML = `
        <div class="station-3d-inspector-header">
            <div>
                <strong data-role="title"></strong>
                <span data-role="shift-hint"></span>
            </div>
            <button type="button" class="station-3d-inspector-close">×</button>
        </div>
        <div class="station-3d-inspector-actions">
            <button type="button" data-action="copy"></button>
            <button type="button" data-action="restore"></button>
        </div>
        <div class="station-3d-inspector-scroll">
            <section>
                <h4 data-role="point-heading"></h4>
                <div class="station-3d-inspector-summary"></div>
                <div class="station-3d-inspector-results"></div>
                <h4 data-role="details-heading"></h4>
                <div class="station-3d-inspector-details"></div>
            </section>
            <section>
                <h4 data-role="layers-heading"></h4>
                <p class="station-3d-inspector-hint" data-role="layer-hint"></p>
                <div class="station-3d-inspector-layers"></div>
            </section>
        </div>`;
    container.appendChild(panelEl);
    resultsEl = panelEl.querySelector('.station-3d-inspector-results');
    layerListEl = panelEl.querySelector('.station-3d-inspector-layers');
    summaryEl = panelEl.querySelector('.station-3d-inspector-summary');
    detailEl = panelEl.querySelector('.station-3d-inspector-details');
    copyButtonEl = panelEl.querySelector('[data-action="copy"]');
    copyButtonEl.addEventListener('click', copyReport);
    panelEl.querySelector('[data-action="restore"]').addEventListener('click', () => {
        resetInspectionLayerVisibility(currentOptions?.scene);
        rerunInspection();
    });
    panelEl.querySelector('.station-3d-inspector-close').addEventListener('click', closePanel);
    renderPanelChrome();
    unsubscribeLang ||= onLangChange(() => {
        renderPanelChrome();
        rerunInspection();
    });
    return panelEl;
}

function renderLayerList(revealCategory = null) {
    if (!layerListEl || !currentOptions?.scene) return;
    const layers = collectInspectionLayers(currentOptions.scene);
    const topics = groupInspectionLayers(layers);
    if (revealCategory) expandedInspectionTopics.add(revealCategory);
    layerListEl.innerHTML = topics.map((topic, topicIndex) => {
        const label = topicLabel(topic.category);
        return `
            <div class="station-3d-inspector-topic">
                <label class="station-3d-inspector-topic-bulk">
                    <input type="checkbox" data-topic-index="${topicIndex}"
                        aria-label="${escapeHtml(t('inspector.topicToggle', { topic: label }))}">
                </label>
                <details data-topic-index="${topicIndex}" ${expandedInspectionTopics.has(topic.category) ? 'open' : ''}>
                    <summary>
                        <span>
                            <strong>${escapeHtml(label)}</strong>
                            <small>${escapeHtml(t('inspector.topicCounts', { enabled: topic.enabledCount, n: topic.layers.length }))}</small>
                        </span>
                        <span class="station-3d-inspector-topic-chevron" aria-hidden="true">⌄</span>
                    </summary>
                    <div class="station-3d-inspector-topic-layers">
                        ${topic.layers.map(layer => `
                            <label class="station-3d-inspector-layer">
                                <input type="checkbox" data-layer-id="${escapeHtml(layer.id)}" ${layer.enabled ? 'checked' : ''}>
                                <span>
                                    <strong>${escapeHtml(layer.label)}</strong>
                                    <small>${escapeHtml(layer.source)} · ${escapeHtml(t('inspector.objectCounts', { visible: layer.visibleObjectCount, n: layer.objectCount }))}</small>
                                </span>
                            </label>`).join('')}
                    </div>
                </details>
            </div>`;
    }).join('');
    for (const input of layerListEl.querySelectorAll('input[data-topic-index]')) {
        const topic = topics[Number(input.dataset.topicIndex)];
        if (!topic) continue;
        input.checked = topic.allEnabled;
        input.indeterminate = topic.partiallyEnabled;
        input.addEventListener('change', () => {
            setInspectionLayersVisible(
                currentOptions.scene,
                topic.layers.map(layer => layer.id),
                input.checked,
            );
            rerunInspection();
        });
    }
    for (const details of layerListEl.querySelectorAll('details[data-topic-index]')) {
        const topic = topics[Number(details.dataset.topicIndex)];
        if (!topic) continue;
        details.addEventListener('toggle', () => {
            if (details.open) expandedInspectionTopics.add(topic.category);
            else expandedInspectionTopics.delete(topic.category);
        });
    }
    for (const input of layerListEl.querySelectorAll('input[data-layer-id]')) {
        input.addEventListener('change', () => {
            setInspectionLayerVisible(currentOptions.scene, input.dataset.layerId, input.checked);
            rerunInspection();
        });
    }
}

function facadeDetailsMarkup(facade) {
    if (!facade) return '';
    if (facade.status !== 'analysed') {
        return `<details class="station-3d-inspector-facade">
            <summary>${escapeHtml(t('inspector.facadeTitle'))}</summary>
            <p>${escapeHtml(t('inspector.facadeUnavailable'))}: ${escapeHtml(facade.reason || facade.status)}</p>
        </details>`;
    }
    const warnings = [];
    if (facade.probableThickWallPairs > 0) {
        warnings.push(t('inspector.facadeThickWarning', { n: facade.probableThickWallPairs }));
    }
    if (facade.probableBucketFragmentation > 0) {
        warnings.push(t('inspector.facadeBucketWarning', { n: facade.probableBucketFragmentation }));
    }
    return `<details class="station-3d-inspector-facade" open>
        <summary>${escapeHtml(t('inspector.facadeTitle'))}</summary>
        <dl>
            <dt>${escapeHtml(t('inspector.facadeBucket'))}</dt><dd>${escapeHtml(facade.bucketKey)}</dd>
            <dt>${escapeHtml(t('inspector.facadeRecovered'))}</dt><dd>${facade.recoveredFaceTriangleCount}</dd>
            <dt>${escapeHtml(t('inspector.facadeNear'))}</dt><dd>${facade.nearCoplanarCount}</dd>
            <dt>${escapeHtml(t('inspector.facadeCross'))}</dt><dd>${facade.separateNearCoplanarMeshes?.length || 0}</dd>
        </dl>
        ${warnings.map(warning => `<p class="station-3d-inspector-warning">⚠ ${escapeHtml(warning)}</p>`).join('')}
    </details>`;
}

function pointClassificationMarkup(classifications) {
    if (!Array.isArray(classifications) || classifications.length === 0) return '';
    return `<div class="station-3d-inspector-classifications">
        <strong>${escapeHtml(t('inspector.surfaceClassification'))}</strong>
        ${classifications.map(item => `<span>${escapeHtml(item.label)}<small>${escapeHtml(item.source)}</small></span>`).join('')}
    </div>`;
}

function renderHitDetails(
    hit,
    index,
    referenceY,
    rayHits = [],
    pointClassifications = [],
    renderOrigin = null,
) {
    if (!detailEl) return;
    if (!hit) {
        detailEl.innerHTML = `<strong>${escapeHtml(t('inspector.noHitTitle'))}</strong><p>${escapeHtml(t('inspector.noHitBody'))}</p>`;
        return;
    }
    const summary = hitSummary(hit, index, referenceY, renderOrigin);
    const layer = summary.layer || {};
    const material = summary.material || {};
    const feature = summary.feature || {};
    const point = summary.surface.point;
    const facade = facadeAnalysisForHit(hit, rayHits)?.report || null;
    detailEl.innerHTML = `
        <dl>
            <dt>${escapeHtml(t('inspector.field.layer'))}</dt><dd>${escapeHtml(layer.label || t('inspector.unregistered'))}</dd>
            <dt>${escapeHtml(t('inspector.field.producer'))}</dt><dd>${escapeHtml(layer.source || t('inspector.unregisteredProducer'))}</dd>
            <dt>${escapeHtml(t('inspector.field.object'))}</dt><dd>${escapeHtml(summary.object.name || summary.object.type || t('inspector.unnamed'))}</dd>
            <dt>${escapeHtml(t('inspector.field.path'))}</dt><dd>${escapeHtml(summary.object.path.join(' › '))}</dd>
            <dt>${escapeHtml(t('inspector.field.feature'))}</dt><dd>${escapeHtml(feature.key ?? feature.objectId ?? feature.instanceId ?? t('inspector.none'))}</dd>
            <dt>${escapeHtml(t('inspector.field.material'))}</dt><dd>${escapeHtml(material.name || material.type || t('inspector.none'))}${material.color ? ` · ${escapeHtml(material.color)}` : ''}</dd>
            <dt>${escapeHtml(t('inspector.field.renderRole'))}</dt><dd>${escapeHtml(summary.renderRole)}</dd>
            <dt>${escapeHtml(t('inspector.field.position'))}</dt><dd>X ${point.x?.toFixed?.(3)} · Y ${point.y?.toFixed?.(3)} · Z ${point.z?.toFixed?.(3)}</dd>
            <dt>${escapeHtml(t('inspector.field.triangle'))}</dt><dd>${summary.surface.faceIndex ?? t('inspector.none')}</dd>
        </dl>
        ${pointClassificationMarkup(pointClassifications)}
        ${facadeDetailsMarkup(facade)}
        <details>
            <summary>${escapeHtml(t('inspector.materialData'))}</summary>
            <pre>${escapeHtml(JSON.stringify({
                material,
                surfaceClaim: summary.surfaceClaim,
                userData: summary.userData,
            }, null, 2))}</pre>
        </details>`;
    return facade;
}

function renderHitCards(
    rayHits,
    verticalHits,
    selected,
    referenceY,
    pointClassifications = [],
    renderOrigin = null,
) {
    if (!resultsEl) return;
    const cards = [];
    const render = (hit, index, kind, referenceY) => {
        const summary = hitSummary(hit, index, referenceY, renderOrigin);
        const layer = summary.layer;
        const feature = summary.feature.key || summary.feature.objectId || summary.feature.instanceId;
        const verticalGap = summary.surface.belowSelectedSurfaceM;
        const gap = kind === 'vertical' && verticalGap != null
            ? ` · ΔY ${verticalGap >= 0 ? '−' : '+'}${Math.abs(verticalGap).toFixed(3)} m`
            : '';
        const role = summary.renderRole === 'visible color surface' ? '' : ` · ${summary.renderRole}`;
        cards.push(`
            <button type="button" class="station-3d-inspector-hit${hit === selected ? ' is-selected' : ''}" data-hit-kind="${kind}" data-hit-index="${index}">
                <span class="station-3d-inspector-hit-number">${kind === 'ray' ? 'R' : 'V'}${index + 1}</span>
                <span>
                    <strong>${escapeHtml(layer?.label || summary.object.name || summary.object.type)}</strong>
                    <small>${escapeHtml(summary.object.name || summary.object.type)}${gap}${escapeHtml(role)}</small>
                    <small>${escapeHtml(layer?.source || 'unregistered producer')}${feature != null ? ` · ${escapeHtml(feature)}` : ''}</small>
                </span>
            </button>`);
    };
    rayHits.forEach((hit, index) => render(hit, index, 'ray', referenceY));
    if (verticalHits.length > 0) {
        cards.push(`<div class="station-3d-inspector-divider">${escapeHtml(t('inspector.verticalStack'))}</div>`);
        verticalHits.forEach((hit, index) => render(hit, index, 'vertical', referenceY));
    }
    resultsEl.innerHTML = cards.join('') || `<p>${escapeHtml(t('inspector.noHits'))}</p>`;
    for (const button of resultsEl.querySelectorAll('.station-3d-inspector-hit')) {
        button.addEventListener('click', () => {
            const hits = button.dataset.hitKind === 'ray' ? rayHits : verticalHits;
            const hit = hits[Number(button.dataset.hitIndex)];
            if (!hit) return;
            resultsEl.querySelectorAll('.is-selected').forEach(el => el.classList.remove('is-selected'));
            button.classList.add('is-selected');
            const index = Number(button.dataset.hitIndex);
            highlightHit(hit, rayHits);
            const facade = renderHitDetails(
                hit,
                index,
                referenceY,
                rayHits,
                pointClassifications,
                renderOrigin,
            );
            if (currentReport) {
                currentReport.selectedSurface = hitSummary(
                    hit,
                    index,
                    referenceY,
                    renderOrigin,
                );
                currentReport.selectedSurfaceDiagnostics = facade || null;
            }
        });
    }
    const rayIndex = rayHits.indexOf(selected);
    const selectedIndex = rayIndex >= 0 ? rayIndex : Math.max(0, verticalHits.indexOf(selected));
    return renderHitDetails(
        selected,
        selectedIndex,
        referenceY,
        rayHits,
        pointClassifications,
        renderOrigin,
    );
}

function layersInReport() {
    return collectInspectionLayers(currentOptions?.scene).map(layer => ({
        id: layer.id,
        label: layer.label,
        category: layer.category,
        source: layer.source,
        enabled: layer.enabled,
        objectCount: layer.objectCount,
        visibleObjectCount: layer.visibleObjectCount,
    }));
}

function runInspectionAt(clientX, clientY, { revealSelectedTopic = true } = {}) {
    const {
        camera,
        scene,
        domElement,
        getAnchor,
        getTerrain,
        getCivilGround,
        getRenderOrigin,
    } = currentOptions || {};
    if (!camera || !scene || !domElement) return;
    facadeAnalysisCache = new WeakMap();
    hitDescriptionCache = new WeakMap();
    const rect = domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    mouseNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    mouseNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouseNdc, camera);
    const targets = allRaycastTargets(scene);
    const rayHits = distinctInspectionHits(raycaster.intersectObjects(targets, false))
        .slice(0, MAX_REPORTED_HITS);
    // Raycaster also sees stencil writers, opacity-zero pick proxies, and
    // material-hidden support meshes. Keep those in the diagnostic stack, but
    // start on the first surface that can actually contribute visible colour.
    const selected = preferredVisibleHit(rayHits);
    const renderOrigin = getRenderOrigin?.() || null;
    const absoluteSelectedPoint = absoluteInspectionPoint(selected?.point, renderOrigin);
    let verticalHits = [];
    if (selected?.point) {
        verticalOrigin.set(selected.point.x, VERTICAL_RAY_TOP_M, selected.point.z);
        verticalRaycaster.set(verticalOrigin, verticalDirection);
        verticalRaycaster.far = VERTICAL_RAY_DEPTH_M;
        verticalHits = distinctInspectionHits(
            verticalRaycaster.intersectObjects(targets, false),
            { measure: 'height' },
        ).slice(0, MAX_REPORTED_HITS);
    }
    ensurePanel()?.classList.remove('hidden');
    const selectedCategory = inspectionLayerForObject(selected?.object)?.category || null;
    renderLayerList(revealSelectedTopic ? selectedCategory : null);

    const anchor = getAnchor?.() || {};
    const geo = absoluteSelectedPoint && Number.isFinite(anchor.lon) && Number.isFinite(anchor.lat)
        ? localToGeo(
            absoluteSelectedPoint.x,
            absoluteSelectedPoint.z,
            anchor.lon,
            anchor.lat,
        )
        : null;
    const terrain = getTerrain?.() || null;
    const civilGround = getCivilGround?.() || null;
    const selectedY = selected?.point?.y ?? null;
    let pointClassifications = [];
    if (absoluteSelectedPoint && typeof currentOptions?.describePoint === 'function') {
        try {
            pointClassifications = currentOptions.describePoint(
                absoluteSelectedPoint.x,
                absoluteSelectedPoint.z,
            ) || [];
        } catch (error) {
            console.warn('[inspect] point classification failed', error);
        }
    }
    const selectedFacade = renderHitCards(
        rayHits,
        verticalHits,
        selected,
        selectedY,
        pointClassifications,
        renderOrigin,
    );
    let civilGroundResolution = null;
    if (absoluteSelectedPoint && civilGround?.resolveAtLocal) {
        try {
            civilGroundResolution = civilGround.resolveAtLocal(
                absoluteSelectedPoint.x,
                absoluteSelectedPoint.z,
            );
        } catch (error) {
            console.warn('[inspect] civil-ground resolution failed', error);
        }
    }
    if (selected) highlightHit(selected, rayHits);
    else removeHighlight();
    currentReport = {
        generatedAt: new Date().toISOString(),
        selectedPoint: selected ? {
            local: {
                x: round(absoluteSelectedPoint.x),
                y: round(selected.point.y),
                z: round(absoluteSelectedPoint.z),
            },
            renderLocal: {
                x: round(selected.point.x),
                y: round(selected.point.y),
                z: round(selected.point.z),
            },
            renderOrigin: {
                x: round(renderOrigin?.x) ?? 0,
                z: round(renderOrigin?.z) ?? 0,
            },
            geographic: geo ? { lat: round(geo.lat, 7), lon: round(geo.lon, 7) } : null,
            elevationAslM: Number.isFinite(selectedY) && Number.isFinite(terrain?.anchorHeightM)
                ? round(terrain.anchorHeightM + selectedY)
                : null,
            sourceTerrainY: selected
                ? round(terrain?.sceneYAtLocal?.(
                    absoluteSelectedPoint.x,
                    absoluteSelectedPoint.z,
                ))
                : null,
            civilGround: civilGroundResolution ? {
                sceneY: round(civilGroundResolution.sceneY),
                ownerAuthority: civilGroundResolution.ownerAuthority,
                ownerId: civilGroundResolution.ownerId,
                stages: civilGroundResolution.stages.map(stage => ({
                    ...stage,
                    inputSceneY: round(stage.inputSceneY),
                    sceneY: round(stage.sceneY),
                })),
            } : null,
            materialClassifications: pointClassifications,
        } : null,
        cameraRayHits: rayHits.map((hit, index) => (
            hitSummary(hit, index, selectedY, renderOrigin)
        )),
        verticalSurfaceStack: verticalHits.map((hit, index) => (
            hitSummary(hit, index, selectedY, renderOrigin)
        )),
        selectedSurface: selected
            ? hitSummary(selected, rayHits.indexOf(selected), selectedY, renderOrigin)
            : null,
        selectedSurfaceDiagnostics: selectedFacade || null,
        groundOwnershipMask: currentOptions?.getGroundOwnershipMaskDiagnostics?.() || null,
        surfacePublications: currentOptions?.getSurfacePublications?.()?.snapshot?.() || null,
        layers: layersInReport(),
        hiddenLayerIds: Array.from(hiddenInspectionLayerIds()),
    };
    if (summaryEl) {
        const point = currentReport.selectedPoint;
        summaryEl.innerHTML = point
            ? `<strong>X ${point.local.x.toFixed(2)} · Y ${point.local.y.toFixed(2)} · Z ${point.local.z.toFixed(2)}</strong>
               <span>${point.geographic ? `${point.geographic.lat.toFixed(6)}, ${point.geographic.lon.toFixed(6)}` : escapeHtml(t('inspector.localCoordinates'))}${point.elevationAslM != null ? ` · ${point.elevationAslM.toFixed(2)} ${escapeHtml(t('inspector.altitudeSuffix'))}` : ''}</span>
               <span>${escapeHtml(t('inspector.hitCounts', { ray: rayHits.length, vertical: verticalHits.length }))}</span>`
            : `<strong>${escapeHtml(t('inspector.noHitTitle'))}</strong><span>${escapeHtml(t('inspector.noHitBody'))}</span>`;
    }
}

function rerunInspection() {
    if (!currentOptions?.lastPointer) {
        renderLayerList();
        return;
    }
    runInspectionAt(
        currentOptions.lastPointer.clientX,
        currentOptions.lastPointer.clientY,
        { revealSelectedTopic: false },
    );
}

export function attachInspector(options) {
    const { camera, scene, domElement } = options || {};
    if (!camera || !scene || !domElement) {
        console.warn('[inspect] attachInspector missing required args; skipped');
        return;
    }
    currentOptions = { ...options, lastPointer: currentOptions?.lastPointer || null };
    ensurePanel();
    if (attachedDom && attachedHandler) attachedDom.removeEventListener('click', attachedHandler, true);
    attachedDom = domElement;
    attachedHandler = (event) => {
        if (!event.shiftKey) return;
        event.preventDefault();
        event.stopPropagation();
        currentOptions.lastPointer = { clientX: event.clientX, clientY: event.clientY };
        runInspectionAt(event.clientX, event.clientY);
    };
    domElement.addEventListener('click', attachedHandler, true);
}

export function resetInspector() {
    if (attachedDom && attachedHandler) attachedDom.removeEventListener('click', attachedHandler, true);
    attachedDom = null;
    attachedHandler = null;
    removeHighlight();
    if (currentOptions?.scene) resetInspectionLayerVisibility(currentOptions.scene);
    panelEl?.remove();
    panelEl = null;
    resultsEl = null;
    layerListEl = null;
    summaryEl = null;
    detailEl = null;
    copyButtonEl = null;
    unsubscribeLang?.();
    unsubscribeLang = null;
    currentReport = null;
    currentOptions = null;
    facadeAnalysisCache = new WeakMap();
    hitDescriptionCache = new WeakMap();
    expandedInspectionTopics.clear();
}
