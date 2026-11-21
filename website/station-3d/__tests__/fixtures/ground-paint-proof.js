import * as THREE from 'three';
import { geoToLocal } from '../../core/math.js';
import { compileSurfaceClaim } from '../../core/surface-hierarchy.js';
import { createGroundCompositePlanSteps } from '../../core/ground-composite-plan.js';
import { createGroundPaintPacketSteps } from '../../core/ground-paint-packet.js';
import { planGroundPaintUpdate } from '../../core/ground-paint-update.js';
import { createGroundPaintTargetPool } from '../../core/ground-paint-target-pool.js';
import { createGroundPaintPagePainter, groundPaintPageMatchesReceiver } from '../../core/ground-paint-page-three.js';
import { bindGroundPaintMaterial, createGroundPaintMaterialState } from '../../core/ground-paint-material.js';
import { setSceneRenderOrigin, applyRenderOriginForRender, resetSceneRenderOrigin } from '../../core/render-origin.js';

// Correctness only: readbacks and diagnostic pages are excluded from performance
// runs. One native renderer is reused, including the five disposal cycles.
const status = document.querySelector('#status'), output = document.querySelector('#result');
const painters = new WeakMap();
const limits = { records: 32, vertices: 20000, verticesPerRecord: 10000, oversized: 32 };
const pageLimits = { pixels: 65536, draws: 64, verticesPerPolygon: 2048 };
const receiver = { key: 'proof-ground', verticalBand: 'ground', coverageRevision: 'footprint:1',
    bounds: { minX: 0, minZ: 0, maxX: 16, maxZ: 16 } };
const ring = (a, b) => [{ x: a, z: a }, { x: b, z: a }, { x: b, z: b }, { x: a, z: b }];
const record = (key, surfaceClass, outerRing, holeRings = [], r = receiver) => ({
    key, sourceRevision: `${key}:1`, materialRevision: 'style:1', materialKey: key, receiver: r, sourcePriority: 0,
    claim: compileSurfaceClaim({ surfaceClass, verticalBand: r.verticalBand,
        verticalRelation: r.verticalBand === 'ground' ? 'same-level' : 'grade-separated', coverageState: 'published' }),
    polygons: [{ outerRing, holeRings }],
});
const finish = iterator => { let step; do step = iterator.next(); while (!step.done); return step.value; };
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const recipes = new Map([
    ['road', { id: 1, revision: 'style:1', surfaceClass: 'road-carriageway', roughness: .99, metalness: 0, normalInfluence: 0, linearColor: [.72, .2, .04] }],
    ['paving', { id: 2, revision: 'style:1', surfaceClass: 'sidewalk', roughness: .92, metalness: 0, normalInfluence: 0, linearColor: [.08, .65, .16] }],
    ['deck', { id: 3, revision: 'style:1', surfaceClass: 'road-carriageway', roughness: .7, metalness: 0, normalInfluence: 0, linearColor: [.04, .16, .72] }],
    ['path', { id: 4, revision: 'style:1', surfaceClass: 'buffered-sidewalk', roughness: .92, metalness: 0, normalInfluence: 0, linearColor: [.72, .2, .04] }],
]);
function inside(p, path) {
    let hit = false;
    for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
        const a = path[i], b = path[j];
        if ((a.z > p.z) !== (b.z > p.z) && p.x < (b.x - a.x) * (p.z - a.z) / (b.z - a.z) + a.x) hit = !hit;
    }
    return hit;
}
function cpuAt(p, records, r) {
    if (p.x < r.bounds.minX || p.x > r.bounds.maxX || p.z < r.bounds.minZ || p.z > r.bounds.maxZ) return null;
    return records.filter(item => item.visible !== false && item.polygons.some(poly => inside(p, poly.outerRing)
        && !poly.holeRings.some(h => inside(p, h)))).sort((a, b) => a.claim.rank - b.claim.rank
        || a.sourcePriority - b.sourcePriority || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).at(-1) || null;
}
function edgeDistance(p, records) {
    let best = Infinity;
    for (const item of records) for (const poly of item.polygons) for (const path of [poly.outerRing, ...poly.holeRings]) {
        for (let i = 0; i < path.length; i++) {
            const a = path[i], b = path[(i + 1) % path.length], dx = b.x - a.x, dz = b.z - a.z;
            const lengthSq = dx * dx + dz * dz;
            const t = lengthSq ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / lengthSq)) : 0;
            best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.z - a.z - t * dz));
        }
    }
    return best;
}
function renderState(renderer) {
    return { target: renderer.getRenderTarget()?.texture.uuid || null,
        viewport: renderer.getViewport(new THREE.Vector4()).toArray(), scissor: renderer.getScissor(new THREE.Vector4()).toArray(),
        scissorTest: renderer.getScissorTest(), color: renderer.getClearColor(new THREE.Color()).toArray(),
        alpha: renderer.getClearAlpha(), autoClear: renderer.autoClear, autoReset: renderer.info.autoReset, xr: renderer.xr.enabled };
}
function preparePacket(records, r = receiver, bounds = r.bounds, size = 64) {
    const plan = finish(createGroundCompositePlanSteps({ receiver: r, records, limits }));
    const packet = finish(createGroundPaintPacketSteps({ plan, bounds, size, styles: recipes, limits: pageLimits }));
    return { plan, packet };
}
async function buildPage(renderer, packet, isCurrent = () => true, resolveAlbedoMap = null, targetLease = null) {
    const task = painters.get(renderer).createTask({ packet, isCurrent, resolveAlbedoMap, targetLease });
    const before = JSON.stringify(renderState(renderer));
    try {
        let refused = false; try { task.result(); } catch { refused = true; }
        assert(refused, 'An unfinished page was publishable');
        await task.prepare();
        assert(JSON.stringify(renderState(renderer)) === before, 'Preparation leaked render state');
        while (!task.step()) assert(JSON.stringify(renderState(renderer)) === before, 'A partial draw leaked render state');
        assert(JSON.stringify(renderState(renderer)) === before, 'Final draw leaked render state');
        return task.result();
    } finally { task.dispose(); }
}
async function readPaintPixels(renderer, page, buffer) {
    const target = renderer.getRenderTarget(), layer = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    const viewport = renderer.getViewport(new THREE.Vector4()), scissor = renderer.getScissor(new THREE.Vector4());
    const scissorTest = renderer.getScissorTest();
    try {
        // Bind the page's array layer explicitly before issuing the read.
        renderer.setRenderTarget(page.target, page.layer);
        return await renderer.readRenderTargetPixelsAsync(page.target, 0, 0, page.size, page.size, buffer);
    } finally {
        renderer.setRenderTarget(target, layer, mip); renderer.setViewport(viewport);
        renderer.setScissor(scissor); renderer.setScissorTest(scissorTest);
    }
}
async function runCase(renderer, name, records, r = receiver, bounds = r.bounds, size = 64) {
    const { plan, packet } = preparePacket(records, r, bounds, size);
    const page = await buildPage(renderer, packet);
    try {
        const material = new Uint8Array(size * size);
        await readPaintPixels(renderer, page, material);
        // Freeze edge exclusion from the device's advertised raster precision,
        // before inspecting pixels. Full CPU coverage remains checked everywhere.
        const subpixelBits = renderer.getContext().getParameter(renderer.getContext().SUBPIXEL_BITS);
        const pixelM = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / size;
        const boundaryM = pixelM / (2 ** subpixelBits) + 1e-5;
        let boundarySamples = 0, testedSamples = 0, paintedSamples = 0, mismatches = 0;
        const examples = [];
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
            const p = { x: bounds.minX + (x + .5) * (bounds.maxX - bounds.minX) / size,
                z: bounds.minZ + (y + .5) * (bounds.maxZ - bounds.minZ) / size };
            const winner = cpuAt(p, records, r), expected = winner ? recipes.get(winner.materialKey) : null, i = y * size + x;
            assert(plan.paintAt(p.x, p.z, r)?.key === winner?.key, `Independent CPU ownership disagrees at ${name}:${x},${y}`);
            if (edgeDistance(p, records) <= boundaryM) { boundarySamples++; continue; }
            testedSamples++; if (winner) paintedSamples++;
            if (material[i] !== (expected?.id || 0)) {
                mismatches++;
                if (examples.length < 8) examples.push({ x, y, expected: expected?.id || 0, actual: material[i] });
            }
        }
        assert(testedSamples > size * size * .98 && paintedSamples > 0, `${name}: missing test or paint coverage`);
        assert(mismatches === 0, `${name}: ${mismatches} GPU mismatches ${JSON.stringify(examples)}`);
        return { name, testedSamples, boundarySamples, paintedSamples, subpixelBits, boundaryM, mismatches, receipt: page.receipt };
    } finally { page.dispose(); }
}
async function realJelacic(renderer) {
    const response = await fetch('./ground-jelacic-source.json'); assert(response.ok, `Fixture HTTP ${response.status}`);
    const source = await response.json();
    const rings = source.road.feature.geometry.coordinates.map(path => path.map(([lon, lat]) => geoToLocal(lon, lat, 15.976903, 45.813215)));
    const p = rings[0];
    const r = { ...receiver, key: 'proof-jelacic', bounds: { minX: Math.min(...p.map(v => v.x)), minZ: Math.min(...p.map(v => v.z)),
        maxX: Math.max(...p.map(v => v.x)), maxZ: Math.max(...p.map(v => v.z)) } };
    return runCase(renderer, 'real-jelacic-82-exterior-15-hole', [record('paving', 'sidewalk', rings[0], rings.slice(1), r)], r, r.bounds, 256);
}
async function conflictingJelacic(renderer) {
    const response = await fetch('./ground-jelacic-receiver.json'); assert(response.ok, `Fixture HTTP ${response.status}`);
    const source = await response.json();
    const representative = geoToLocal(15.9773223, 45.8131745, 15.976903, 45.813215);
    assert(Math.abs(representative.x - 32.5) < .01 && Math.abs(representative.z - 4.5) < .01,
        'Jelačić source projection must match the recorded native audit coordinate');
    const r = { ...receiver, key: 'proof-jelacic-conflict',
        bounds: { minX: -150, minZ: -80, maxX: 150, maxZ: 100 } };
    const records = source.features.map(({ ownerId, selected }) => {
        const rings = selected.geometry.coordinates.map(path => path.map(([lon, lat]) => geoToLocal(lon, lat, 15.976903, 45.813215)));
        const plaza = selected.properties.highway_type === 'pedestrian';
        return { ...record(String(ownerId), plaza ? 'sidewalk' : 'buffered-sidewalk', rings[0], rings.slice(1), r),
            materialKey: plaza ? 'paving' : 'path' };
    });
    assert(records[0].polygons[0].holeRings.length === 14, 'The complete plaza source must retain fourteen holes');
    assert(cpuAt(representative, records, r)?.key === '-1493356001', 'Canonical plaza paint must win the recorded overlap');
    return runCase(renderer, 'real-jelacic-conflict-fourteen-holes', records, r, r.bounds, 256);
}

async function texturedPavingProof(renderer) {
    // Compare the actual receiver shader with a direct material using the
    // original image. Pattern detail is much finer than an ownership texel.
    const texels = new Uint8Array(64*64*4);
    for (let y=0;y<64;y++) for (let x=0;x<64;x++) {
        const index=(y*64+x)*4, light=(x%8<4)!==(y%8<4);
        texels.set(light ? [192,160,128,255] : [48,96,192,255],index);
    }
    const texture = new THREE.DataTexture(texels,64,64);
    texture.wrapS=texture.wrapT=THREE.RepeatWrapping;
    texture.minFilter=THREE.LinearMipmapLinearFilter; texture.magFilter=THREE.LinearFilter;
    texture.generateMipmaps=true; texture.anisotropy=4;
    texture.colorSpace=THREE.SRGBColorSpace; texture.needsUpdate=true;
    let sourceDisposals=0;
    texture.addEventListener('dispose',()=>sourceDisposals++);
    const uvTransform=[0,.5,.125,-.25,0,.375], tint=[.8,.9,1], size=64, outputSize=256;
    const results=[], originalTarget=renderer.getRenderTarget();
    const originalViewport=renderer.getViewport(new THREE.Vector4());
    const originalScissor=renderer.getScissor(new THREE.Vector4()), originalScissorTest=renderer.getScissorTest();
    const target=new THREE.WebGLRenderTarget(outputSize,outputSize,{depthBuffer:false,stencilBuffer:false});
    target.texture.colorSpace=THREE.NoColorSpace;
    const diagnostic = (material,key) => {
        material.onBeforeCompile=shader=>{
            shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>',
                '#include <opaque_fragment>\ngl_FragColor = vec4(diffuseColor.rgb, 1.0);');
        };
        material.customProgramCacheKey=()=>key;
        return material;
    };
    try {
        for (const [minX,minZ] of [[0,0],[100000.25,-200000.75]]) {
            const bounds={minX,minZ,maxX:minX+128,maxZ:minZ+128};
            const r={...receiver,key:`texture-proof:${minX}:${minZ}`,bounds};
            const polygon=[{x:minX,z:minZ},{x:minX+128,z:minZ},{x:minX+128,z:minZ+128},{x:minX,z:minZ+128}];
            const plan=finish(createGroundCompositePlanSteps({receiver:r,records:[record('paving','sidewalk',polygon,[],r)],limits}));
            const packet=finish(createGroundPaintPacketSteps({plan,bounds,size,limits:pageLimits,
                styles:new Map([['paving',{id:11,revision:'style:1',linearColor:tint,surfaceClass:'sidewalk',
                    roughness:.92,metalness:0,normalInfluence:0,
                    albedoMap:{key:'paving-bitmap',revision:'bitmap:1',uvTransform}}]])}));
            const page=await buildPage(renderer,packet,()=>true,(key,revision)=>{
                assert(key==='paving-bitmap' && revision==='bitmap:1','Texture identity/revision changed');
                return texture;
            });
            const geometry=new THREE.PlaneGeometry(128,128).rotateX(-Math.PI/2).translate(minX+64,0,minZ+64);
            const positions=geometry.attributes.position, uv=geometry.attributes.uv;
            const originU=.5*minZ+.125, originV=-.25*minX+.375;
            for(let i=0;i<positions.count;i++) uv.setXY(i,.5*(positions.getZ(i)-minZ)+originU-Math.floor(originU),
                -.25*(positions.getX(i)-minX)+originV-Math.floor(originV));
            const painted=diagnostic(new THREE.MeshStandardMaterial({color:0xffffff}),'ground-pattern-receiver-proof-v1');
            const reference=diagnostic(new THREE.MeshStandardMaterial({map:texture,color:new THREE.Color(...tint)}),
                'ground-pattern-direct-proof-v1');
            const binding=bindGroundPaintMaterial(painted,{receiver:r,page});
            const mesh=new THREE.Mesh(geometry,painted), scene=new THREE.Scene(); scene.add(mesh);
            const camera=new THREE.OrthographicCamera(-2,2,2,-2,.1,200);
            camera.up.set(0,0,-1);
            const draw=async(material,span,origin)=>{
                mesh.material=material;
                camera.left=-span/2;camera.right=span/2;camera.top=span/2;camera.bottom=-span/2;camera.updateProjectionMatrix();
                camera.position.set(minX+64,100,minZ+64);camera.lookAt(minX+64,0,minZ+64);
                renderer.setRenderTarget(target);renderer.setViewport(0,0,outputSize,outputSize);renderer.setScissorTest(false);
                renderer.clear();
                setSceneRenderOrigin(scene,origin);applyRenderOriginForRender(scene,camera);renderer.render(scene,camera);
                const bytes=new Uint8Array(outputSize*outputSize*4);
                await renderer.readRenderTargetPixelsAsync(target,0,0,outputSize,outputSize,bytes);
                return bytes;
            };
            try {
                const ids=new Uint8Array(size*size);await readPaintPixels(renderer,page,ids);
                assert(ids.every(id=>id===11),'Textured receiver lost categorical coverage');
                for(const span of [4,64]) {
                    const origin={x:minX+64,z:minZ+64};
                    const expected=await draw(reference,span,origin), actual=await draw(painted,span,origin);
                    const rebased=await draw(painted,span,{x:origin.x+2000,z:origin.z-2000});
                    let maxByteError=0,mismatches=0,rebaseMaxByteError=0,minRed=255,maxRed=0;
                    for(let i=0;i<actual.length;i++) {
                        const error=Math.abs(actual[i]-expected[i]);
                        maxByteError=Math.max(maxByteError,error);if(error>2)mismatches++;
                        rebaseMaxByteError=Math.max(rebaseMaxByteError,Math.abs(actual[i]-rebased[i]));
                        if(i%4===0){minRed=Math.min(minRed,expected[i]);maxRed=Math.max(maxRed,expected[i]);}
                    }
                    assert(mismatches===0,`Direct/receiver material mismatch: ${mismatches}, max ${maxByteError}`);
                    assert(rebaseMaxByteError<=2,`Pattern moved with render origin: ${rebaseMaxByteError}`);
                    if(span===4)assert(maxRed-minRed>50,'Fine pattern reference cannot be a flat tint');
                    results.push({bounds,span,ownershipTexelM:2,sourceTexelM:2/64,
                        comparedPixels:outputSize*outputSize,mismatches,maxByteError,rebaseMaxByteError,referenceRedRange:maxRed-minRed});
                }
            } finally {
                resetSceneRenderOrigin(scene);binding.clear();page.dispose();
                geometry.dispose();painted.dispose();reference.dispose();scene.clear();
            }
            assert(sourceDisposals===0,'Page retirement disposed its borrowed source bitmap');
        }
        return {cases:results,sourceDisposalsBeforeOwnerRelease:sourceDisposals,patterns:painters.get(renderer).stats().patterns,
            scope:'direct-image parity at magnification/minification, sRGB, UV phase and rebase; performance is separate'};
    } finally {
        resetSceneRenderOrigin();renderer.setRenderTarget(originalTarget);renderer.setViewport(originalViewport);
        renderer.setScissor(originalScissor);renderer.setScissorTest(originalScissorTest);target.dispose();texture.dispose();
    }
}

async function incrementalPageProof(renderer) {
    const size = 32, blockSize = 8;
    const r = { ...receiver, bounds: { minX: -32, minZ: -32, maxX: 64, maxZ: 64 } };
    const road = record('road', 'road-carriageway', ring(-16, 64), [], r);
    const paving = record('paving', 'sidewalk', ring(2, 10), [ring(6, 8)], r);
    const moved = { ...record('paving', 'sidewalk', ring(4, 12), [ring(6, 8)], r), sourceRevision: 'paving:2' };
    const shift = { minX: 4, minZ: -4, maxX: 20, maxZ: 12 };
    const cases = [
        { name: 'initial', bounds: receiver.bounds, records: [road, paving], dirtyBounds: [] },
        { name: 'diagonal-movement', bounds: shift, records: [road, paving], dirtyBounds: [] },
        { name: 'moved-source-with-hole', bounds: shift, records: [road, moved], dirtyBounds: [
            { minX: 2, minZ: 2, maxX: 10, maxZ: 10 }, { minX: 4, minZ: 4, maxX: 12, maxZ: 12 }] },
        { name: 'removal-reveals-lower-rank', bounds: shift, records: [road],
            dirtyBounds: [{ minX: 4, minZ: 4, maxX: 12, maxZ: 12 }] },
        { name: 'all-removed-clears-ownership', bounds: shift, records: [], dirtyBounds: [r.bounds] },
        { name: 'teleport-outside-receiver', bounds: { minX: 100, minZ: -100, maxX: 116, maxZ: -84 },
            records: [road, moved], dirtyBounds: [] },
    ];
    const read = async page => {
        const style = new Uint8Array(size*size);
        await readPaintPixels(renderer, page, style);
        return { style };
    };
    const pool = createGroundPaintTargetPool({ size, maxTargets: 2, maxTextureBytes: size*size*2 });
    let active = null;
    const reports = [], targetIds = new Set(), layers = new Set();
    const programIds = renderer.info.programs.map(program => program.id);
    // Exercise restoration of a real framebuffer as well as the public Three
    // viewport/scissor bookkeeping. CopyTextureToTexture changes READ/DRAW FBOs.
    const originalTarget = renderer.getRenderTarget(), sentinel = new THREE.WebGLRenderTarget(8, 8);
    const oldViewport = renderer.getViewport(new THREE.Vector4()), oldScissor = renderer.getScissor(new THREE.Vector4());
    const oldScissorTest = renderer.getScissorTest();
    renderer.setRenderTarget(sentinel);
    const framebuffer = renderer.getContext().getParameter(renderer.getContext().FRAMEBUFFER_BINDING);
    try {
        for (const item of cases) {
            const before = active ? await read(active) : null;
            const plan = finish(createGroundCompositePlanSteps({ receiver: r, records: item.records, limits }));
            const update = planGroundPaintUpdate({ receiver: r, bounds: item.bounds, size, previous: active,
                dirtyBounds: item.dirtyBounds, blockSize });
            const packet = finish(createGroundPaintPacketSteps({ plan, bounds: item.bounds, size,
                styles: recipes, limits: pageLimits, update }));
            const lease = pool.acquire(); assert(lease, 'No bounded staging target was available');
            targetIds.add(lease.target.texture.uuid);
            layers.add(lease.layer);
            const task = painters.get(renderer).createTask({ packet, targetLease: lease });
            try {
                const state = JSON.stringify(renderState(renderer));
                await task.prepare();
                while (true) {
                    const complete = task.step();
                    assert(JSON.stringify(renderState(renderer)) === state, 'Incremental step leaked Three render state');
                    assert(renderer.getContext().getParameter(renderer.getContext().FRAMEBUFFER_BINDING) === framebuffer,
                        'Incremental copy leaked the actual GL framebuffer');
                    if (complete) break;
                    let refused = false; try { task.result(); } catch { refused = true; }
                    assert(refused, 'A partly copied/composited successor was publishable');
                }
                if (active) {
                    const after = await read(active);
                    assert(after.style.every((v,i) => v === before.style[i]),
                        'Preparing the successor changed published texels');
                }
                const next = task.result(), pixels = await read(next);
                let mismatches = 0;
                for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
                    const point = { x: item.bounds.minX+(x+.5)*.5, z: item.bounds.minZ+(y+.5)*.5 };
                    const winner = cpuAt(point, item.records, r), recipe = winner && recipes.get(winner.materialKey);
                    const i = y*size+x;
                    if (pixels.style[i] !== (recipe?.id || 0)) mismatches++;
                }
                assert(mismatches === 0, `${item.name}: ${mismatches} incremental pixel mismatches`);
                assert(next.receipt.maxPixelsPerItem <= blockSize**2, 'A work item exceeded its pixel bound');
                assert(JSON.stringify(renderer.info.programs.map(program => program.id)) === JSON.stringify(programIds),
                    'The persistent painter rebuilt its actual GPU program during page updates');
                reports.push({ name: item.name, checkedPixels: size*size, mismatches, ...next.receipt });
                const retired = active; active = next; retired?.dispose();
            } finally { task.dispose(); }
        }
        assert(reports[1].copiedPixels === 576 && reports[1].clearedPixels === 448,
            'Diagonal movement repainted retained coverage instead of copying it');
        assert(targetIds.size === 1 && layers.size === 2 && pool.stats().layers === 2, 'Moving pages grew the target pool');
        return { cases: reports, targetArrays: targetIds.size, pageLayersUsed: layers.size, peakTextureBytes: pool.stats().textureBytes,
            retainedOldBytesUntilPublication: true, rendererStateRestored: true, retainedProgramIds: programIds };
    } finally {
        active?.dispose(); pool.dispose();
        renderer.setRenderTarget(originalTarget); renderer.setViewport(oldViewport);
        renderer.setScissor(oldScissor); renderer.setScissorTest(oldScissorTest); sentinel.dispose();
    }
}
async function cascadeMaterialProof(renderer) {
    const r = { ...receiver, key: 'material-cascades', bounds: { minX: -128, minZ: -128, maxX: 128, maxZ: 128 } };
    const pool = createGroundPaintTargetPool({ size: 32, maxTargets: 4, maxTextureBytes: 32*32*4 });
    const pages = [], state = createGroundPaintMaterialState({ receiver: r });
    const normalMap = new THREE.DataTexture(new Uint8Array([255,128,128,255]), 1, 1);
    normalMap.needsUpdate = true;
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .6, metalness: .4, normalMap });
    // Diagnostic output reads the factors produced by the real standard shader;
    // the separate physical proof below retains normal lighting and shadows.
    mat.onBeforeCompile = shader => {
        shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>',
            '#include <opaque_fragment>\ngl_FragColor = vec4(roughnessFactor, metalnessFactor, normal.z, 1.0);');
    };
    mat.customProgramCacheKey = () => 'ground-material-factor-proof-v1';
    bindGroundPaintMaterial(mat, { state, minimumRank: 10 });
    const geom = new THREE.PlaneGeometry(256, 256).rotateX(-Math.PI/2);
    const scene = new THREE.Scene(); scene.add(new THREE.Mesh(geom, mat));
    const camera = new THREE.OrthographicCamera(-.5, .5, .5, -.5, .1, 200);
    camera.up.set(0, 0, -1);
    const target = new THREE.WebGLRenderTarget(16, 16, { depthBuffer: false, stencilBuffer: false });
    target.texture.colorSpace = THREE.NoColorSpace;
    const oldTarget = renderer.getRenderTarget(), oldLayer = renderer.getActiveCubeFace(), oldMip = renderer.getActiveMipmapLevel();
    const viewport = renderer.getViewport(new THREE.Vector4()), scissor = renderer.getScissor(new THREE.Vector4());
    const scissorTest = renderer.getScissorTest(), clear = renderer.getClearColor(new THREE.Color()), alpha = renderer.getClearAlpha();
    const factors = [[.2,.1],[.5,.2],[.9,.3]], samples = [];
    const draw = async x => {
        camera.position.set(x, 100, 0); camera.lookAt(x, 0, 0);
        renderer.setRenderTarget(target); renderer.setViewport(0, 0, 16, 16); renderer.setScissorTest(false);
        renderer.setClearColor(0x000000, 1); renderer.clear(); renderer.render(scene, camera);
        const bytes = new Uint8Array(4);
        await renderer.readRenderTargetPixelsAsync(target, 8, 8, 1, 1, bytes);
        return [...bytes];
    };
    try {
        for (const [i, width] of [16,64,256].entries()) {
            const bounds = { minX: -width/2, minZ: -width/2, maxX: width/2, maxZ: width/2 };
            const plan = finish(createGroundCompositePlanSteps({ receiver: r,
                records: [record('paving', 'sidewalk', ring(-128,128), [], r)], limits }));
            const styles = new Map([['paving', { ...recipes.get('paving'), roughness: factors[i][0], metalness: factors[i][1] }]]);
            const packet = finish(createGroundPaintPacketSteps({ plan, bounds, size: 32, styles, limits: pageLimits }));
            pages.push(await buildPage(renderer, packet, () => true, null, pool.acquire()));
        }
        state.replacePages(pages);
        for (const [i,x] of [0,12,64].entries()) {
            const bytes = await draw(x), expected = [...factors[i].map(v => Math.round(v*255)),255,255];
            assert(bytes.every((v,c) => Math.abs(v-expected[c]) <= 1), `Cascade material ${i}: ${bytes} != ${expected}`);
            samples.push({ x, bytes, expected });
        }
        const changedBounds = { minX:-2,minZ:-2,maxX:2,maxZ:2 }, invalidated = [];
        for (let count=1;count<=3;count++) {
            state.replacePages(pages, Array.from({length:count},()=>changedBounds));
            const bytes = await draw(0);
            const expected = count<3 ? [...factors[count].map(v=>Math.round(v*255)),255,255] : [153,102,1,255];
            assert(bytes.every((v,c)=>Math.abs(v-expected[c])<=1),
                `Invalid fine coverage leaked into cascade ${count}: ${bytes} != ${expected}`);
            invalidated.push({ count, bytes, expected });
        }
        state.replacePages(pages);
        const gl = renderer.getContext(), programs = renderer.info.programs;
        const program = programs.find(p => p.cacheKey?.includes('ground-material-factor-proof-v1'));
        assert(program?.program, 'Diagnostic standard material program missing');
        const samplers = [];
        for (let i=0; i<gl.getProgramParameter(program.program, gl.ACTIVE_UNIFORMS); i++) {
            const u = gl.getActiveUniform(program.program, i);
            if ([gl.SAMPLER_2D,gl.SAMPLER_2D_ARRAY,gl.SAMPLER_CUBE,gl.SAMPLER_2D_SHADOW].includes(u.type)) {
                samplers.push({ name:u.name, size:u.size, type:u.type });
            }
        }
        for (const name of ['uReceiverPaintIds','uReceiverPaintStyles']) {
            assert(samplers.some(s => s.name === name), `Missing active paint sampler ${name}`);
        }
        state.clear();
        const unpainted = await draw(0);
        assert(Math.abs(unpainted[0]-153)<=1 && Math.abs(unpainted[1]-102)<=1 && unpainted[2]<5,
            `Cleared paint did not restore underlying roughness/metalness/normal: ${unpainted}`);
        return { samples, invalidated, unpainted, arrayLayers: pages.map(p => p.layer), samplerUniforms: samplers,
            maxFragmentSamplers: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
            materialTableBytes: state.textureBytes, evidence: 'isolated standard shader, not combined terrain or performance' };
    } finally {
        state.dispose(); for (const page of pages) page.dispose(); pool.dispose();
        mat.dispose(); geom.dispose(); normalMap.dispose(); target.dispose(); scene.clear();
        renderer.setRenderTarget(oldTarget, oldLayer, oldMip); renderer.setViewport(viewport);
        renderer.setScissor(scissor); renderer.setScissorTest(scissorTest); renderer.setClearColor(clear, alpha);
    }
}

async function physicalReceiverProof(renderer, records) {
    const pool = createGroundPaintTargetPool({ size: 64, maxTargets: 2, maxTextureBytes: 64*64*2 });
    const groundPage = await buildPage(renderer, preparePacket(records).packet, () => true, null, pool.acquire());
    const deck = { ...receiver, key: 'physical-deck', verticalBand: 'deck:1',
        bounds: { minX: 6, maxX: 10, minZ: 0, maxZ: 16 } };
    const deckPage = await buildPage(renderer, preparePacket([record('deck', 'road-carriageway', ring(0, 16), [], deck)], deck).packet,
        () => true, null, pool.acquire());
    const groundGeometry = new THREE.PlaneGeometry(16, 16, 8, 8).rotateX(-Math.PI / 2).translate(8, 0, 8);
    const positions = groundGeometry.attributes.position;
    for (let i = 0; i < positions.count; i++) positions.setY(i, positions.getX(i) * .1 + Math.min(positions.getZ(i), 16 - positions.getZ(i)) * .05);
    groundGeometry.computeVertexNormals();
    const groundMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .9 });
    const deckMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .9 });
    const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    const deckMesh = new THREE.Mesh(new THREE.PlaneGeometry(4, 16).rotateX(-Math.PI / 2).translate(8, 5, 8), deckMaterial);
    const undersideMaterial = new THREE.MeshStandardMaterial({ color: 0x888888 });
    const underside = new THREE.Mesh(new THREE.PlaneGeometry(4, 16).rotateX(Math.PI / 2).translate(8, 4.7, 8), undersideMaterial);
    const scene = new THREE.Scene(); scene.add(ground, deckMesh, underside);
    const light = new THREE.HemisphereLight(0xffffff, 0x888888, 2);
    // A hemisphere's position denotes a DIRECTION. It must not inherit the
    // receiver root's temporary translation when comparing identical lighting.
    light.updateMatrixWorld(true); light.matrixWorldAutoUpdate = false; scene.add(light);
    const camera = new THREE.OrthographicCamera(-8, 8, 8, -8, .1, 100);
    camera.up.set(0, 0, -1);
    const target = new THREE.WebGLRenderTarget(128, 128, { depthBuffer: true, stencilBuffer: false });
    const ray = new THREE.Raycaster();
    const support = height => {
        scene.updateMatrixWorld(true); ray.set(new THREE.Vector3(8.125, height, 4.0625), new THREE.Vector3(0, -1, 0));
        return ray.intersectObjects([ground, deckMesh, underside]).map(hit => ({ receiver: hit.object === ground ? 'ground' : hit.object === deckMesh ? 'deck' : 'underside', y: hit.point.y }));
    };
    const supportBefore = [support(10), support(3)];
    assert(JSON.stringify(supportBefore.map(hits => hits.map(hit => hit.receiver))) === JSON.stringify([['deck', 'ground'], ['ground']]), 'Invalid stacked support fixture');
    const groundBinding = bindGroundPaintMaterial(groundMaterial, { receiver, page: groundPage });
    const deckBinding = bindGroundPaintMaterial(deckMaterial, { receiver: deck, page: deckPage });
    let wrongReceiverRejected = false;
    try { deckBinding.replace(groundPage); } catch { wrongReceiverRejected = true; }
    const draw = async (height, origin = { x: 0, z: 0 }) => {
        camera.position.set(8, height, 8); camera.lookAt(8, 0, 8);
        renderer.setRenderTarget(target); renderer.setViewport(0, 0, 128, 128); renderer.setScissorTest(false);
        renderer.setClearColor(0x000000, 1); renderer.clear();
        setSceneRenderOrigin(scene, origin); applyRenderOriginForRender(scene, camera); renderer.render(scene, camera);
        const bytes = new Uint8Array(128 * 128 * 4);
        await renderer.readRenderTargetPixelsAsync(target, 0, 0, 128, 128, bytes);
        return bytes;
    };
    const pixel = (bytes, x, z) => {
        const i = (Math.floor((16 - z) * 8) * 128 + Math.floor(x * 8)) * 4;
        return [...bytes.slice(i, i + 3)];
    };
    try {
        await renderer.compileAsync(scene, camera);
        const above = await draw(20), below = await draw(3);
        const paving = pixel(above, 4, 4), bridge = pixel(above, 8, 4), under = pixel(below, 8, 4);
        assert(paving[1] > paving[0] * 2 && paving[1] > paving[2] * 2, `Paving did not shade the physical slope: ${paving}`);
        assert(bridge[2] > bridge[1] * 2 && bridge[2] > bridge[0] * 2, `Bridge inherited ground paint: ${bridge}`);
        assert(under[1] > under[2] * 2 && under[1] > under[0] * 2, `Underpass lost ground paint: ${under}`);
        const rebased = await draw(20, { x: 2000, z: -2000 });
        let rebaseMaxByteError = 0;
        for (let i = 0; i < above.length; i++) rebaseMaxByteError = Math.max(rebaseMaxByteError, Math.abs(above[i] - rebased[i]));
        assert(rebaseMaxByteError <= 1, `Paint changed under origin rebase: ${rebaseMaxByteError}`);
        resetSceneRenderOrigin(scene);
        light.intensity = .2; const dark = pixel(await draw(20), 4, 4);
        assert(dark.reduce((a,b) => a+b,0) < paving.reduce((a,b) => a+b,0) * .5, 'Lighting was baked into the paint');
        const supportAfter = [support(10), support(3)];
        assert(JSON.stringify(supportBefore) === JSON.stringify(supportAfter), 'Paint changed physical receiver triangles');
        assert(wrongReceiverRejected, 'Material accepted another physical receiver');
        // Keep an oblique view for a screenshot; all owned resources are disposed
        // immediately afterward, so this proof leaves no animation loop running.
        light.intensity = 2; camera.position.set(22, 18, 24); camera.up.set(0, 1, 0); camera.lookAt(8, 1, 8);
        renderer.setRenderTarget(null); renderer.setViewport(0, 0, 512, 512); renderer.setScissorTest(false);
        renderer.setClearColor(0x18202a, 1); renderer.clear(); renderer.render(scene, camera);
        return { paving, bridge, under, dark, supportBefore, supportAfter, rebaseMaxByteError, wrongReceiverRejected,
            sharedTextureArray: groundPage.target === deckPage.target, groundLayer: groundPage.layer, deckLayer: deckPage.layer };
    } finally {
        resetSceneRenderOrigin(scene); groundBinding.clear(); deckBinding.clear(); renderer.setRenderTarget(null);
        target.dispose(); groundPage.dispose(); deckPage.dispose(); pool.dispose();
        for (const mesh of [ground, deckMesh, underside]) { mesh.geometry.dispose(); mesh.material.dispose(); }
        scene.clear();
    }
}

function memory(renderer) { return { geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures }; }
async function run() {
    status.textContent = 'Running…';
    const renderer = new THREE.WebGLRenderer({ canvas: document.querySelector('#view'), antialias: false, preserveDrawingBuffer: true });
    const painter = createGroundPaintPagePainter({ renderer }); painters.set(renderer, painter);
    renderer.setPixelRatio(1); renderer.setSize(512, 512, false);
    renderer.setViewport(2, 3, 500, 501); renderer.setScissor(3, 4, 99, 98); renderer.setScissorTest(true);
    renderer.setClearColor(0x102030, .4);
    const shaderErrors = [];
    renderer.debug.onShaderError = (gl, program, vertex, fragment) => shaderErrors.push([
        gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment),
    ].join('\n'));
    const records = [record('road', 'road-carriageway', ring(1, 15)), record('paving', 'sidewalk', ring(2, 14), [ring(6, 10)])];
    const deck = { ...receiver, key: 'proof-deck', verticalBand: 'deck:1' };
    try {
        const cases = [];
        cases.push(await runCase(renderer, 'rank-and-hole', records));
        cases.push(await runCase(renderer, 'reversed-delivery', [...records].reverse()));
        cases.push(await runCase(renderer, 'removal-reveals-road', records.slice(0, 1)));
        cases.push(await runCase(renderer, 'same-xz-deck', [record('deck', 'road-carriageway', ring(1, 15), [], deck)], deck));
        cases.push(await realJelacic(renderer));
        cases.push(await conflictingJelacic(renderer));
        const texturedPaving = await texturedPavingProof(renderer);
        const incrementalPages = await incrementalPageProof(renderer);
        const cascadeMaterials = await cascadeMaterialProof(renderer);
        const physical = await physicalReceiverProof(renderer, records);
        const before = memory(renderer), cycles = [];
        for (let i = 0; i < 5; i++) {
            await runCase(renderer, `cleanup-${i + 1}`, records, receiver, receiver.bounds, 32);
            const after = memory(renderer); assert(JSON.stringify(after) === JSON.stringify(before), 'Paint page resource leak');
            cycles.push(after);
        }
        const { packet } = preparePacket(records);
        const old = await buildPage(renderer, packet);
        let current = true;
        const staged = painter.createTask({ packet, isCurrent: () => current });
        const mat = new THREE.MeshStandardMaterial();
        try {
            const bound = bindGroundPaintMaterial(mat, { receiver, page: old });
            await staged.prepare(); staged.step(); current = false;
            let rejected = false; try { staged.step(); } catch { rejected = true; }
            assert(rejected && staged.state === 'disposed' && bound.page === old && !old.disposed, 'Stale page replaced the active material');
            assert(!groundPaintPageMatchesReceiver(old, deck), 'Ground paint leaked into a deck');
            bound.clear();
        } finally { staged.dispose(); mat.dispose(); old.dispose(); }
        assert(!shaderErrors.length, `Shader errors: ${shaderErrors.join('\n')}`);
        assert(painter.stats().compileCalls === 1, 'Page updates repeatedly compiled their paint shader');
        const gl = renderer.getContext(), info = gl.getExtension('WEBGL_debug_renderer_info');
        return { contract: 'station3d-ground-paint-proof-v1', ok: true, cases, texturedPaving, incrementalPages, cascadeMaterials, physical,
            painter: painter.stats(),
            cleanup: { before, cycles, after: memory(renderer), sharedWarmTexture: 'Three r184 DFG LUT for standard materials' }, staleReplacementRetainedOld: true,
            gpu: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
            renderer: THREE.REVISION, evidence: 'isolated material pages; no production cutover or performance acceptance' };
    } finally { painter.dispose(); painters.delete(renderer); renderer.dispose(); }
}
window.__groundPaintProof = { run, last: null };
run().then(report => {
    window.__groundPaintProof.last = report; output.textContent = JSON.stringify(report, null, 2); status.textContent = 'PASS';
}).catch(error => {
    const report = { ok: false, error: String(error?.stack || error) };
    window.__groundPaintProof.last = report; output.textContent = JSON.stringify(report, null, 2); status.textContent = 'FAIL';
});
