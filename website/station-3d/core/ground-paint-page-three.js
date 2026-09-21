// Bounded GPU page primitive for the compositor proof. A candidate stays private
// until every rank has rendered. Cache placement/publication belongs to the
// shared generation scheduler, not this Three.js adapter.
import * as THREE from 'three';
import { GROUND_PAINT_PACKET } from './ground-paint-packet.js';
import { createGroundPaintPatternLibrary } from './ground-paint-patterns.js';
import { captureGroundPaintMaterialRows } from './ground-paint-styles.js';

const vertexShader = `
precision highp float;
in vec3 position;
uniform vec2 pageSizeM;
out vec2 pagePosition;
void main() { pagePosition = position.xy; gl_Position = vec4(position.xy / pageSizeM * 2.0 - 1.0, 0.0, 1.0); }
`;
const fragmentShader = `
precision highp float;
uniform float paintStyle;
uniform vec4 receiverBounds;
in vec2 pagePosition;
layout(location = 0) out vec4 materialId;
void main() {
    if (any(lessThan(pagePosition, receiverBounds.xy)) || any(greaterThan(pagePosition, receiverBounds.zw))) discard;
    materialId = vec4(paintStyle / 255.0, 0.0, 0.0, 1.0);
}
`;

export function groundPaintPageMatchesReceiver(page, receiver) {
    return !!page && !page.disposed && !!receiver && page.receiver.key === receiver.key
        && page.receiver.verticalBand === receiver.verticalBand
        && page.receiver.coverageRevision === receiver.coverageRevision;
}

function withRenderState(renderer, operation) {
    const target = renderer.getRenderTarget();
    const cubeFace = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    const viewport = renderer.getViewport(new THREE.Vector4());
    const scissor = renderer.getScissor(new THREE.Vector4()), scissorTest = renderer.getScissorTest();
    const clearColor = renderer.getClearColor(new THREE.Color()), clearAlpha = renderer.getClearAlpha();
    const autoClear = renderer.autoClear, autoReset = renderer.info.autoReset, xr = renderer.xr.enabled;
    try {
        renderer.xr.enabled = false;
        renderer.autoClear = false;
        renderer.info.autoReset = false;
        return operation();
    } finally {
        renderer.setRenderTarget(target, cubeFace, mip);
        renderer.setViewport(viewport); renderer.setScissor(scissor); renderer.setScissorTest(scissorTest);
        renderer.setClearColor(clearColor, clearAlpha);
        renderer.autoClear = autoClear; renderer.info.autoReset = autoReset; renderer.xr.enabled = xr;
    }
}

export function createGroundPaintTarget(size, layers = 1) {
    if (![size, layers].every(n => Number.isSafeInteger(n) && n > 0)) throw new TypeError('Invalid ground paint target size');
    // Coverage is categorical: zero means uncovered. The receiver shades the
    // selected material at its own resolution, independent of page texel size.
    const target = new THREE.WebGLArrayRenderTarget(size, size, layers, {
        depthBuffer: false, stencilBuffer: false, samples: 0,
        type: THREE.UnsignedByteType, format: THREE.RedFormat,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
    });
    target.texture.name = 'Ground paint exact material ID';
    target.texture.format = THREE.RedFormat;
    target.texture.internalFormat = 'R8';
    target.texture.minFilter = target.texture.magFilter = THREE.NearestFilter;
    target.texture.generateMipmaps = false;
    target.texture.colorSpace = THREE.NoColorSpace;
    return target;
}

// One painter belongs to the world, not to a page. Keeping its material alive
// retains Three's compiled program across target swaps. A single active task
// also prevents two cooperative jobs from mutating the same draw uniforms.
export function createGroundPaintPagePainter({ renderer, patternLibrary = null }) {
    if (!renderer?.isWebGLRenderer) throw new TypeError('Ground paint requires a WebGL renderer');
    patternLibrary ||= createGroundPaintPatternLibrary({ renderer });
    const material = new THREE.RawShaderMaterial({
        name: 'Ground paint compositor', glslVersion: THREE.GLSL3, vertexShader, fragmentShader,
        uniforms: { pageSizeM: { value: new THREE.Vector2(1, 1) },
            paintStyle: { value: 0 },
            receiverBounds: { value: new THREE.Vector4() } },
        depthTest: false, depthWrite: false, blending: THREE.NoBlending, side: THREE.DoubleSide, toneMapped: false,
    });
    const idleGeometry = new THREE.BufferGeometry();
    idleGeometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    const mesh = new THREE.Mesh(idleGeometry, material); mesh.frustumCulled = false;
    const scene = new THREE.Scene(); scene.add(mesh);
    const camera = new THREE.Camera();
    let active = null, closed = false, compile = null, contextEpoch = 0, compileCalls = 0;
    const resetContext = () => { contextEpoch++; compile = null; active?.dispose(); };
    renderer.domElement?.addEventListener('webglcontextlost', resetContext);
    renderer.domElement?.addEventListener('webglcontextrestored', resetContext);
    const relinquish = () => {
        if (mesh.geometry !== idleGeometry) mesh.geometry.dispose();
        mesh.geometry = idleGeometry;
        active = null;
    };
    return Object.freeze({
        createTask(options) {
            if (closed || active) throw new Error(closed ? 'Ground painter is closed' : 'Ground painter already has a candidate');
            const epoch = contextEpoch;
            const pipeline = { material, mesh, scene, camera, idleGeometry, patternLibrary, cleanup: relinquish,
                current: () => !closed && epoch === contextEpoch,
                prepare() {
                    if (!compile) {
                        compileCalls++;
                        const pending = renderer.compileAsync(scene, camera).catch(error => {
                            if (compile === pending) compile = null;
                            throw error;
                        });
                        compile = pending;
                    }
                    return compile;
                },
            };
            active = createGroundPaintPageTask({ ...options, renderer, pipeline });
            return active;
        },
        stats: () => Object.freeze({ closed, active: !!active, compileCalls, contextEpoch,
            patterns: patternLibrary.stats() }),
        dispose() {
            if (closed) return false;
            closed = true; active?.dispose();
            renderer.domElement?.removeEventListener('webglcontextlost', resetContext);
            renderer.domElement?.removeEventListener('webglcontextrestored', resetContext);
            idleGeometry.dispose(); material.dispose(); patternLibrary.dispose(); scene.clear();
            return true;
        },
    });
}

function createGroundPaintPageTask({ renderer, packet, pipeline, isCurrent = () => true, resolveAlbedoMap = null,
    targetLease = null }) {
    if (packet?.contract !== GROUND_PAINT_PACKET || !renderer?.isWebGLRenderer
        || packet.size > renderer.capabilities.maxTextureSize) throw new TypeError('Unsupported ground paint packet/renderer');
    const source = packet.update.source;
    if (source && (source.disposed || !source.target || !groundPaintPageMatchesReceiver(source, packet.receiver))) {
        throw new Error('Ground paint copy source is unavailable');
    }
    if (targetLease && (targetLease.released || typeof targetLease.release !== 'function'
        || targetLease.target?.width !== packet.size || targetLease.target?.height !== packet.size
        || (targetLease.target === source?.target && targetLease.layer === source.layer)
        || !targetLease.target?.isWebGLArrayRenderTarget || !Number.isSafeInteger(targetLease.layer)
        || targetLease.layer < 0 || targetLease.layer >= targetLease.target.depth || targetLease.target.textures?.length !== 1
        || targetLease.target.texture.format !== THREE.RedFormat
        || targetLease.target.texture.internalFormat !== 'R8')) throw new TypeError('Invalid ground paint target lease');
    // Reserve material revisions before page allocation. Private row copies
    // and uploads then use the same per-frame submission budget as page work.
    const patterns = pipeline.patternLibrary.acquire(packet.styles, resolveAlbedoMap);
    let target;
    try { target = targetLease?.target || createGroundPaintTarget(packet.size); }
    catch (error) { patterns.release(); throw error; }
    const layer = targetLease?.layer ?? 0;
    const releaseTarget = () => targetLease ? targetLease.release() : target.dispose();
    const { material, mesh, scene, camera, cleanup } = pipeline;
    material.uniforms.pageSizeM.value.set(packet.bounds.maxX - packet.bounds.minX, packet.bounds.maxZ - packet.bounds.minZ);
    material.uniforms.receiverBounds.value.set(packet.receiverBounds.minX - packet.bounds.minX,
        packet.receiverBounds.minZ - packet.bounds.minZ, packet.receiverBounds.maxX - packet.bounds.minX,
        packet.receiverBounds.maxZ - packet.bounds.minZ);
    let state = 'created', cursor = 0, regionCursor = 0, copyCursor = 0, clearCursor = 0, transferred = false;
    let loadedDraw = null;
    const timing = { prepareMs: 0, workMs: 0, maxItemMs: 0, drawMs: 0, maxDrawMs: 0, drawCalls: 0, triangles: 0,
        copiedPixels: 0, clearedPixels: 0, submittedPixels: 0, copyCalls: 0, clearCalls: 0, maxPixelsPerItem: 0 };
    const discard = () => {
        if (state === 'disposed' || transferred) return false;
        cleanup(); releaseTarget(); patterns.release(); state = 'disposed'; return true;
    };
    const assertCurrent = () => {
        if (state === 'disposed') throw new Error('Paint page is disposed');
        if (!isCurrent() || !pipeline.current() || targetLease?.released || source?.disposed) {
            discard(); throw new Error('Paint page generation or copy source is stale');
        }
    };
    return {
        get state() { return state; },
        async prepare() {
            if (state !== 'created') throw new Error(`Cannot prepare ${state} paint page`);
            assertCurrent(); state = 'preparing';
            const start = performance.now();
            try {
                await pipeline.prepare();
                assertCurrent();
                withRenderState(renderer, () => {
                    const gl = renderer.getContext();
                    if (target.depth > gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS)) {
                        throw new Error('Ground paint exceeds the texture array layer limit');
                    }
                    renderer.initRenderTarget(target);
                    renderer.setRenderTarget(target, layer);
                    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
                        throw new Error('Ground paint framebuffer is incomplete');
                    }
                    if (source) renderer.initRenderTarget(source.target);
                    // Context restoration may have dropped GPU storage while
                    // the immutable CPU pattern copy remains ready.
                    if (patterns.ready && patterns.texture) renderer.initTexture(patterns.texture);
                });
                // Allocation/compile is separate from bounded pixel work. Never
                // clear or overwrite a currently published target in place.
                state = 'drawing';
            } catch (error) { discard(); throw error; }
            timing.prepareMs += performance.now() - start;
        },
        // One pattern step, ID copy, scissored clear, or polygon-in-block per scheduler
        // item. The private target may contain incomplete ranks between steps.
        step() {
            assertCurrent();
            if (state === 'complete') return true;
            if (state !== 'drawing') throw new Error(`Cannot draw ${state} paint page`);
            const start = performance.now();
            const beforeCalls = renderer.info.render.calls, beforeTriangles = renderer.info.render.triangles;
            try {
                if (!patterns.ready) {
                    patterns.step();
                } else if (copyCursor < packet.update.copies.length) {
                    const rect = packet.update.copies[copyCursor];
                    withRenderState(renderer, () => {
                        renderer.copyTextureToTexture(source.target.texture, target.texture,
                            new THREE.Box3(new THREE.Vector3(rect.sourceX, rect.sourceY, source.layer),
                                new THREE.Vector3(rect.sourceX + rect.width, rect.sourceY + rect.height, source.layer + 1)),
                            new THREE.Vector3(rect.x, rect.y, layer));
                    });
                    copyCursor++; timing.copyCalls++;
                    timing.copiedPixels += rect.width * rect.height;
                    timing.maxPixelsPerItem = Math.max(timing.maxPixelsPerItem, rect.width * rect.height);
                } else if (clearCursor < packet.update.repaints.length) {
                    const rect = packet.update.repaints[clearCursor++];
                    withRenderState(renderer, () => {
                        renderer.setRenderTarget(target, layer);
                        renderer.setScissor(rect.x, rect.y, rect.width, rect.height); renderer.setScissorTest(true);
                        renderer.setClearColor(0x000000, 0); renderer.clear(true, false, false);
                    });
                    timing.clearCalls++; timing.clearedPixels += rect.width * rect.height;
                    timing.maxPixelsPerItem = Math.max(timing.maxPixelsPerItem, rect.width * rect.height);
                } else if (cursor < packet.draws.length) {
                    const draw = packet.draws[cursor], rect = draw.regions[regionCursor];
                    if (loadedDraw !== draw) {
                        if (mesh.geometry !== pipeline.idleGeometry) mesh.geometry.dispose();
                        mesh.geometry = new THREE.BufferGeometry();
                        mesh.geometry.setAttribute('position', new THREE.BufferAttribute(draw.positions, 3));
                        mesh.geometry.setIndex(new THREE.BufferAttribute(draw.indices, 1));
                        loadedDraw = draw;
                    }
                    material.uniforms.paintStyle.value = draw.styleId;
                    withRenderState(renderer, () => {
                        renderer.setRenderTarget(target, layer);
                        renderer.setScissor(rect.x, rect.y, rect.width, rect.height); renderer.setScissorTest(true);
                        renderer.render(scene, camera);
                    });
                    timing.submittedPixels += rect.width * rect.height;
                    timing.maxPixelsPerItem = Math.max(timing.maxPixelsPerItem, rect.width * rect.height);
                    if (++regionCursor === draw.regions.length) { cursor++; regionCursor = 0; }
                }
                if (patterns.ready && copyCursor === packet.update.copies.length && clearCursor === packet.update.repaints.length
                    && cursor === packet.draws.length) state = 'complete';
            } catch (error) { discard(); throw error; }
            const elapsed = performance.now() - start;
            timing.workMs += elapsed; timing.maxItemMs = Math.max(timing.maxItemMs, elapsed);
            const calls = renderer.info.render.calls - beforeCalls;
            if (calls > 0) { timing.drawMs += elapsed; timing.maxDrawMs = Math.max(timing.maxDrawMs, elapsed); }
            timing.drawCalls += calls;
            timing.triangles += renderer.info.render.triangles - beforeTriangles;
            return state === 'complete';
        },
        result() {
            assertCurrent();
            if (state !== 'complete' || transferred) throw new Error('Paint page is not available for publication');
            const materialRows = captureGroundPaintMaterialRows(packet.styles, patterns, packet.bounds);
            transferred = true; cleanup();
            let disposed = false;
            return Object.freeze({ target, layer, receiver: packet.receiver, bounds: packet.bounds, size: packet.size,
                styles: packet.styles, patterns, copyMaterialRows: () => materialRows.slice(),
                get disposed() { return disposed || !pipeline.current() || targetLease?.released === true; },
                receipt: Object.freeze({ ...packet.stats, ...packet.update.stats, ...timing, textureLayout: 'R8-style-coverage-no-mips',
                    supportAuthority: false, backstopAuthority: false }),
                dispose() { if (disposed) return false; disposed = true; releaseTarget(); patterns.release(); return true; },
            });
        },
        dispose: discard,
    };
}
