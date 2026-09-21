import * as THREE from 'three';
import { bindRenderOriginShader, renderOriginUniform } from './render-origin.js';
import { groundPaintPageMatchesReceiver } from './ground-paint-page-three.js';
import { GROUND_PAINT_STYLE_ROWS } from './ground-paint-styles.js';

const bindings = new WeakMap(), states = new WeakMap();
const MAX_PAGES = 3;
const PATCH_ID = 'station3d-ground-paint-material';
const PATCH_MARKER = '__station3dGroundPaintPatch';
const PATCH_BASE = '__station3dGroundPaintBase';
const validBounds = b => b && ['minX', 'minZ', 'maxX', 'maxZ'].every(k => Number.isFinite(b[k]))
    && b.maxX > b.minX && b.maxZ > b.minZ;

function unwrapGroundPaintPatch(callback) {
    let current = callback;
    const seen = new Set();
    while (typeof current === 'function'
        && current[PATCH_MARKER] === PATCH_ID
        && !seen.has(current)) {
        seen.add(current);
        current = current[PATCH_BASE];
    }
    return current;
}

function markGroundPaintPatch(callback, base) {
    callback[PATCH_MARKER] = PATCH_ID;
    callback[PATCH_BASE] = base;
    return callback;
}

// One logical receiver shares uniforms and the tiny material table across its
// material variants. All mappings change together; this object owns no page.
export function createGroundPaintMaterialState({ receiver }) {
    if (!receiver?.key || !receiver?.verticalBand || !receiver?.coverageRevision) {
        throw new TypeError('Ground paint requires an explicit receiver');
    }
    const binding = Object.freeze({ key: receiver.key, verticalBand: receiver.verticalBand,
        coverageRevision: receiver.coverageRevision });
    const data = new Float32Array(256 * MAX_PAGES * GROUND_PAINT_STYLE_ROWS * 4);
    const table = new THREE.DataTexture(data, 256, MAX_PAGES * GROUND_PAINT_STYLE_ROWS,
        THREE.RGBAFormat, THREE.FloatType);
    table.colorSpace = THREE.NoColorSpace; table.generateMipmaps = false;
    table.minFilter = table.magFilter = THREE.NearestFilter; table.needsUpdate = true;
    const uniforms = {
        uReceiverPaintPatterns: { value: null }, uReceiverPaintIds: { value: null },
        uReceiverPaintStyles: { value: table }, uReceiverPaintCount: { value: 0 },
        uReceiverPaintBounds: { value: Array.from({ length: MAX_PAGES }, () => new THREE.Vector4(0, 0, 1, 1)) },
        uReceiverPaintLayers: { value: new THREE.Vector3() },
        uReceiverPaintInvalidBounds: { value: Array.from({ length: MAX_PAGES }, () => new THREE.Vector4()) },
        uReceiverPaintInvalid: { value: new THREE.Vector3() },
    };
    let current = Object.freeze([]), currentInvalid = [], closed = false;
    let originX = NaN, originZ = NaN;
    function syncRenderOrigin() {
        const { x, y: z } = renderOriginUniform.value;
        if (x === originX && z === originZ) return false;
        originX = x; originZ = z;
        current.forEach((page, index) => {
            const b = page.bounds;
            uniforms.uReceiverPaintBounds.value[index].set(b.minX - x, b.minZ - z,
                b.maxX - b.minX, b.maxZ - b.minZ);
            const invalid = currentInvalid[index];
            if (!invalid) return;
            const haloX = (b.maxX - b.minX) / page.size;
            const haloZ = (b.maxZ - b.minZ) / page.size;
            uniforms.uReceiverPaintInvalidBounds.value[index].set(invalid.minX - haloX - x,
                invalid.minZ - haloZ - z, invalid.maxX + haloX - x, invalid.maxZ + haloZ - z);
        });
        return true;
    }
    function replacePages(input, invalidBounds = []) {
        if (closed) throw new Error('Ground paint material state is closed');
        if (!Array.isArray(input) || input.length > MAX_PAGES) throw new TypeError('Invalid receiver page count');
        const next = [...input], layers = new Set();
        let width = 0;
        // Validate every page before changing an active uniform or byte.
        for (const page of next) {
            if (!groundPaintPageMatchesReceiver(page, binding) || !validBounds(page.bounds)
                || !page.target?.texture?.isDataArrayTexture || page.target.textures.length !== 1
                || page.target.texture.internalFormat !== 'R8'
                || !Number.isSafeInteger(page.layer) || page.layer < 0
                || !Number.isSafeInteger(page.size) || page.size < 1
                || page.size !== page.target.textures[0].image.width || page.size !== page.target.textures[0].image.height
                || page.layer >= page.target.textures[0].image.depth || layers.has(page.layer)
                || page.target !== next[0].target || typeof page.copyMaterialRows !== 'function'
                || !page.patterns?.ready || page.patterns.released) {
                throw new Error('Paint page belongs to a different or retired receiver');
            }
            const span = page.bounds.maxX - page.bounds.minX;
            if (span <= width || (next.length > 1 && span !== page.bounds.maxZ - page.bounds.minZ)) {
                throw new Error('Receiver cascades must be square and ordered near to far');
            }
            width = span; layers.add(page.layer);
        }
        const bytes = next.map(page => page.copyMaterialRows());
        if (bytes.some(row => !(row instanceof Float32Array) || row.length !== 4096
            || !row.every(Number.isFinite))) throw new TypeError('Invalid paint material table');
        const patternTextures = new Set(next.map(page => page.patterns.texture).filter(Boolean));
        if (patternTextures.size > 1) throw new Error('Paint pages use different material libraries');
        if (!Array.isArray(invalidBounds) || invalidBounds.length > next.length
            || invalidBounds.some(b => b != null && !validBounds(b))) throw new TypeError('Invalid stale paint bounds');
        const previous = current;
        data.fill(0);
        next.forEach((page, index) => {
            data.set(bytes[index], index * 4096);
            uniforms.uReceiverPaintLayers.value.setComponent(index, page.layer);
            const invalid = invalidBounds[index];
            uniforms.uReceiverPaintInvalid.value.setComponent(index, invalid ? 1 : 0);
        });
        table.needsUpdate = true;
        uniforms.uReceiverPaintPatterns.value = [...patternTextures][0] || null;
        uniforms.uReceiverPaintIds.value = next[0]?.target.texture || null;
        uniforms.uReceiverPaintCount.value = next.length;
        current = Object.freeze(next);
        currentInvalid = invalidBounds.map(b => b ? { ...b } : null);
        originX = NaN; syncRenderOrigin();
        return previous;
    }
    const state = Object.freeze({ receiver: binding, replacePages, syncRenderOrigin, clear: () => replacePages([]),
        get pages() { return current; }, get disposed() { return closed; },
        textureBytes: data.byteLength,
        dispose() {
            if (closed) return false;
            replacePages([]); closed = true; table.dispose(); return true;
        },
    });
    states.set(state, uniforms);
    return state;
}

const fragmentDeclarations = `
varying vec2 vReceiverPaintXZ;
varying float vReceiverPaintUpness;
uniform highp sampler2DArray uReceiverPaintPatterns;
uniform highp sampler2DArray uReceiverPaintIds;
uniform sampler2D uReceiverPaintStyles;
uniform int uReceiverPaintCount;
uniform vec4 uReceiverPaintBounds[3];
uniform vec3 uReceiverPaintLayers;
uniform vec4 uReceiverPaintInvalidBounds[3];
uniform vec3 uReceiverPaintInvalid;
uniform float uReceiverPaintMinimumRank;
uniform float uReceiverPaintMaximumRank;
struct ReceiverPaintSample { vec4 color; vec3 parameters; };
int receiverPaintId(ivec2 pixel, int layer) {
    return int(floor(texelFetch(uReceiverPaintIds, ivec3(pixel, layer), 0).r * 255.0 + 0.5));
}
ReceiverPaintSample receiverPaintStyle(int id, int level, vec2 point, vec2 dx, vec2 dy) {
    if (id == 0) return ReceiverPaintSample(vec4(0.0), vec3(0.0));
    vec4 recipe = texelFetch(uReceiverPaintStyles, ivec2(id, level * 4), 0);
    if (recipe.a < uReceiverPaintMinimumRank || recipe.a > uReceiverPaintMaximumRank) return ReceiverPaintSample(vec4(0.0), vec3(0.0));
    vec4 color = texelFetch(uReceiverPaintStyles, ivec2(id, level * 4 + 1), 0);
    if (color.a > 0.5) {
        vec3 u = texelFetch(uReceiverPaintStyles, ivec2(id, level * 4 + 2), 0).xyz;
        vec3 v = texelFetch(uReceiverPaintStyles, ivec2(id, level * 4 + 3), 0).xyz;
        vec2 uv = vec2(dot(u, vec3(point, 1.0)), dot(v, vec3(point, 1.0)));
        // Gradients are captured before any ownership/rank branch. Implicit
        // derivatives inside non-uniform material branches are not reliable.
        vec2 uvDx = vec2(dot(u.xy, dx), dot(v.xy, dx));
        vec2 uvDy = vec2(dot(u.xy, dy), dot(v.xy, dy));
        color.rgb *= textureGrad(uReceiverPaintPatterns, vec3(uv, color.a - 1.0), uvDx, uvDy).rgb;
    }
    return ReceiverPaintSample(vec4(color.rgb, 1.0), recipe.rgb);
}
ReceiverPaintSample receiverPaintMix(ReceiverPaintSample a, ReceiverPaintSample b, float weight) {
    return ReceiverPaintSample(mix(a.color, b.color, weight), mix(a.parameters, b.parameters, weight));
}
ReceiverPaintSample receiverPaintAt(vec2 uv, int level, vec2 point, vec2 dx, vec2 dy) {
    ivec2 size = textureSize(uReceiverPaintIds, 0).xy;
    vec2 p = uv * vec2(size) - 0.5;
    ivec2 cell = ivec2(floor(p));
    vec2 f = fract(p);
    // Filter colour and continuous parameters, never categorical IDs. Reject
    // lower-rank taps BEFORE filtering so they cannot tint a higher physical top.
    int layer = int(uReceiverPaintLayers[level]);
    int ia = receiverPaintId(clamp(cell, ivec2(0), size - 1), layer);
    int ib = receiverPaintId(clamp(cell + ivec2(1, 0), ivec2(0), size - 1), layer);
    int ic = receiverPaintId(clamp(cell + ivec2(0, 1), ivec2(0), size - 1), layer);
    int id = receiverPaintId(clamp(cell + ivec2(1, 1), ivec2(0), size - 1), layer);
    ReceiverPaintSample a = receiverPaintStyle(ia, level, point, dx, dy);
    // Most fragments are inside one material: shade it once, irrespective of
    // the ownership page's resolution. Mixed edges still filter each tap.
    if (ia == ib && ia == ic && ia == id) return a;
    ReceiverPaintSample b = receiverPaintStyle(ib, level, point, dx, dy);
    ReceiverPaintSample c = receiverPaintStyle(ic, level, point, dx, dy);
    ReceiverPaintSample d = receiverPaintStyle(id, level, point, dx, dy);
    return receiverPaintMix(receiverPaintMix(a, b, f.x), receiverPaintMix(c, d, f.x), f.y);
}
ReceiverPaintSample receiverPaintForPoint(vec2 localXZ, vec2 dx, vec2 dy) {
    ReceiverPaintSample result = ReceiverPaintSample(vec4(0.0), vec3(0.0));
    float remaining = 1.0;
    float footprintM = max(length(dx), length(dy));
    for (int level = 0; level < 3; level++) {
        if (level >= uReceiverPaintCount || remaining < 0.0001) break;
        vec4 stale = uReceiverPaintInvalidBounds[level];
        if (uReceiverPaintInvalid[level] > 0.5 && all(greaterThanEqual(localXZ, stale.xy))
            && all(lessThanEqual(localXZ, stale.zw))) continue;
        vec4 bounds = uReceiverPaintBounds[level];
        vec2 point = localXZ - bounds.xy;
        vec2 uv = point / bounds.zw;
        if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) continue;
        float weight = 1.0;
        if (level + 1 < uReceiverPaintCount) {
            float edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
            weight = smoothstep(0.0, 0.125, edge);
            float texelM = bounds.z / float(textureSize(uReceiverPaintIds, 0).x);
            float nextTexelM = uReceiverPaintBounds[level + 1].z / float(textureSize(uReceiverPaintIds, 0).x);
            weight *= 1.0 - smoothstep(texelM, nextTexelM, footprintM);
        }
        if (weight <= 0.0) continue;
        ReceiverPaintSample sampleValue = receiverPaintAt(uv, level, point, dx, dy);
        result.color += sampleValue.color * (weight * remaining);
        result.parameters += sampleValue.parameters * (weight * remaining);
        remaining *= 1.0 - weight;
    }
    return result;
}`;

export function bindGroundPaintMaterial(material, { receiver, page = null, state = null, minimumRank = 0, maximumRank = 255 }) {
    if (!material?.isMeshStandardMaterial || !Number.isFinite(minimumRank) || minimumRank < 0 || minimumRank > 255
        || !Number.isFinite(maximumRank) || maximumRank < minimumRank || maximumRank > 255) {
        throw new TypeError('Ground paint material requires a standard material and valid rank');
    }
    if (bindings.has(material)) throw new Error('A material already belongs to a paint receiver');
    const ownsState = !state;
    state ||= createGroundPaintMaterialState({ receiver });
    const uniforms = states.get(state);
    if (!uniforms || state.disposed) throw new TypeError('Invalid ground paint material state');
    if (page) {
        try { state.replacePages([page]); } catch (error) { if (ownsState) state.dispose(); throw error; }
    }
    // Planner geometry variants deliberately borrow executable callbacks from
    // their source material because Three does not clone them. Such a source
    // may already be paint-bound. Strip that borrowed wrapper before binding
    // the variant to this receiver, otherwise every declaration and helper is
    // injected twice and the road aggregate's shader cannot compile.
    const previousCompile = unwrapGroundPaintPatch(material.onBeforeCompile);
    const previousCacheKey = unwrapGroundPaintPatch(material.customProgramCacheKey);
    const previousRender = unwrapGroundPaintPatch(material.onBeforeRender);
    material.onBeforeRender = markGroundPaintPatch(function (...args) {
        previousRender.apply(this, args);
        state.syncRenderOrigin();
    }, previousRender);
    material.onBeforeCompile = markGroundPaintPatch((shader, renderer) => {
        previousCompile.call(material, shader, renderer);
        bindRenderOriginShader(shader);
        Object.assign(shader.uniforms, uniforms, { uReceiverPaintMinimumRank: { value: minimumRank },
            uReceiverPaintMaximumRank: { value: maximumRank } });
        for (const token of ['#include <common>', '#include <worldpos_vertex>']) {
            if (!shader.vertexShader.includes(token)) throw new Error(`Ground paint vertex hook missing: ${token}`);
        }
        for (const token of ['void main() {', '#include <common>', '#include <alphatest_fragment>', '#include <roughnessmap_fragment>',
            '#include <metalnessmap_fragment>', '#include <normal_fragment_maps>']) {
            if (!shader.fragmentShader.includes(token)) throw new Error(`Ground paint fragment hook missing: ${token}`);
        }
        shader.vertexShader = shader.vertexShader.replace('#include <common>',
            '#include <common>\nvarying vec2 vReceiverPaintXZ;\nvarying float vReceiverPaintUpness;')
            .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
vec4 receiverPaintPosition = vec4(transformed, 1.0);
#ifdef USE_BATCHING
    receiverPaintPosition = batchingMatrix * receiverPaintPosition;
#endif
#ifdef USE_INSTANCING
    receiverPaintPosition = instanceMatrix * receiverPaintPosition;
#endif
vReceiverPaintXZ = (modelMatrix * receiverPaintPosition).xz;
vReceiverPaintUpness = inverseTransformDirection(transformedNormal, viewMatrix).y;`);
        shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${fragmentDeclarations}`)
            .replace('void main() {', `void main() {
vec2 receiverPaintDx = dFdx(vReceiverPaintXZ);
vec2 receiverPaintDy = dFdy(vReceiverPaintXZ);`)
            .replace('#include <alphatest_fragment>', `#include <alphatest_fragment>
ReceiverPaintSample receiverPaint = ReceiverPaintSample(vec4(0.0), vec3(0.0));
if (uReceiverPaintCount > 0 && gl_FrontFacing && vReceiverPaintUpness > 0.01) {
    receiverPaint = receiverPaintForPoint(vReceiverPaintXZ, receiverPaintDx, receiverPaintDy);
    diffuseColor.rgb = diffuseColor.rgb * (1.0 - receiverPaint.color.a) + receiverPaint.color.rgb;
}`)
            .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = roughnessFactor * (1.0 - receiverPaint.color.a) + receiverPaint.parameters.r;`)
            .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor = metalnessFactor * (1.0 - receiverPaint.color.a) + receiverPaint.parameters.g;`)
            .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
normal = normalize(mix(nonPerturbedNormal, normal, 1.0 - receiverPaint.color.a + receiverPaint.parameters.b));`);
    }, previousCompile);
    material.customProgramCacheKey = markGroundPaintPatch(
        () => `${previousCacheKey.call(material)}|ground-paint-id-material-v4`,
        previousCacheKey,
    );
    material.userData.groundPaintReceiver = state.receiver;
    material.needsUpdate = true;
    if (ownsState) material.addEventListener('dispose', () => state.dispose());
    const handle = Object.freeze({ receiver: state.receiver, state,
        replace: next => state.replacePages(next ? [next] : [])[0] || null,
        replacePages: state.replacePages, clear: () => state.clear()[0] || null,
        get page() { return state.pages[0] || null; }, get pages() { return state.pages; } });
    bindings.set(material, handle);
    return handle;
}
