import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { applyPlannerSurfaceCutout, createPlannerGeometryMaterialCache } from '../world/planner-surface-cutout.js';
import { compileSurfaceClaim, SURFACE_CLASS, SURFACE_COVERAGE_STATE, SURFACE_VERTICAL_RELATION } from '../core/surface-hierarchy.js';
import { isShared, unregisterShared } from '../core/dispose.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { asSurfaceClaim, surfaceClaimMayReceiveGroundHole } from '../core/surface-hierarchy.js';
const claim=compileSurfaceClaim({surfaceClass:SURFACE_CLASS.TERRAIN,
    coverageState:SURFACE_COVERAGE_STATE.PUBLISHED,verticalRelation:SURFACE_VERTICAL_RELATION.SAME_LEVEL});

test('the actual terrain program suppresses the raster water discard when exact openings were compiled', () => {
    const source = readFileSync(new URL('../scene/setup.js', import.meta.url), 'utf8');
    const start = source.indexOf('export function applyGroundHoleMask(');
    const code = source.slice(start, source.indexOf('// Inverse companion', start)).replace('export function', 'function');
    const runtime = { asSurfaceClaim, surfaceClaimMayReceiveGroundHole, bindRenderOriginShader() {}, groundHoleUniforms: {} };
    vm.runInNewContext(code, runtime);
    const material = runtime.applyGroundHoleMask(new THREE.MeshStandardMaterial(), claim);
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
    material.onBeforeCompile(shader, {});
    const gate = shader.fragmentShader.split('#ifndef ST3D_PLANNER_GEOMETRY_CUTOUTS')[1].split('#endif')[0];
    assert.match(gate, /texture2D\(uGroundHoleMask, holeUv\).r > 0.5\) discard/);
    assert.match(material.customProgramCacheKey(), /ground-hole-mask-v3/);
    material.dispose();
});

test('clipped receivers select a bounded shader variant without changing active material or duplicating textures',()=>{
    const cache=createPlannerGeometryMaterialCache({maxMaterials:1});
    const texture=new THREE.Texture(),source=new THREE.MeshStandardMaterial({map:texture});
    const uniform={value:7};
    source.onBeforeCompile=shader=>{shader.uniforms.fixture=uniform;};
    applyPlannerSurfaceCutout(source,claim);
    let disposed=0;source.addEventListener('dispose',()=>disposed++);
    try{
        const variant=cache.get(source);
        assert.notEqual(variant,source);assert.equal(cache.get(source),variant);assert.equal(cache.get(variant),variant);
        assert.equal(variant.map,texture);assert.equal(isShared(variant),true);
        assert.equal(source.defines?.ST3D_PLANNER_GEOMETRY_CUTOUTS,undefined);
        assert.equal(variant.defines.ST3D_PLANNER_GEOMETRY_CUTOUTS,1);
        const shader={uniforms:{},vertexShader:THREE.ShaderLib.standard.vertexShader,fragmentShader:THREE.ShaderLib.standard.fragmentShader};
        variant.onBeforeCompile(shader,{});
        assert.equal(shader.uniforms.fixture,uniform);
        assert.ok(shader.uniforms.uPlannerSurfaceCutoutMask);
        // This checks the assembled program contract. Native drawing remains
        // a separate gate; a source-text assertion is not a framebuffer test.
        const gate=shader.fragmentShader.split('#ifndef ST3D_PLANNER_GEOMETRY_CUTOUTS')[1].split('#endif')[0];
        assert.match(gate,/texture2D\(uPlannerSurfaceCutoutMask/);
        assert.match(gate,/uPlannerEntranceCutCount/);
        assert.match(gate,/uAuthoredSurfaceOpeningCount/);
        const another=applyPlannerSurfaceCutout(new THREE.MeshStandardMaterial(),claim);
        try{assert.throws(()=>cache.get(another),{code:'ground-generation-capacity'});}
        finally{another.dispose();}
        const retiring=cache.take();assert.deepEqual(retiring,[variant]);assert.deepEqual(cache.take(),[]);
        assert.equal(disposed,0);
        for(const material of retiring){unregisterShared(material);material.dispose();}
        assert.equal(disposed,0,'retiring the variant preserves the source owner');
    }finally{source.dispose();texture.dispose();}
});
