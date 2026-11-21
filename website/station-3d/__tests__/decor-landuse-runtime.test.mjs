// Execute the production greenery adapter with real paint records. Unrelated
// vegetation factories are collaborators; any colour-path height call fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from 'three';
import { createDecorGroundPaintOwnerSteps } from '../core/decor-ground-paint.js';
import { decorSurfaceEdgingPolygonsSteps, decorSurfaceEdgingTypeIndex } from '../core/decor-surface-edging.js';
import { createGroundCompositePlanSteps } from '../core/ground-composite-plan.js';
import { captureGroundPaintStyles } from '../core/ground-paint-styles.js';
import { SURFACE_CLASS } from '../core/surface-hierarchy.js';
const source = readFileSync(new URL('../world/decor.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('const registeredDecorPaintStyles'), source.indexOf('async function buildCrossingsGroup'));
const exhaust = steps => { for (;;) { const n = steps.next(); if (n.done) return n.value; } };
const area = ring => ring.reduce((sum, p, i) => {
    const q = ring[(i + 1) % ring.length]; return sum + p.x * q.z - q.x * p.z;
}, 0) / 2;
const square = (size, x = 0) => [{x,z:0},{x:x+size,z:0},{x:x+size,z:size},{x,z:size}];

function harness(hidden = []) {
    const recipes = new Map(), maps = new Map(), calls = [];
    const receiver = {key:'ground',verticalBand:'ground',coverageRevision:'1',
        bounds:{minX:-100,minZ:-100,maxX:100,maxZ:100}};
    const texture = () => {
        const map = new THREE.DataTexture(new Uint8Array([255,255,255,255]),1,1);
        map.colorSpace = THREE.SRGBColorSpace; map.wrapS = map.wrapT = THREE.RepeatWrapping;
        return map;
    };
    const grass = texture(), soil = texture(), concrete = texture();
    const context = vm.createContext({ THREE, SURFACE_CLASS,
        groundPaint:{receiver,registerStyle:(key, recipe, map) => {recipes.set(key,recipe); maps.set(key,map);}},
        getGrassTexture:()=>grass,getFlowerbedTexture:()=>soil,getSidewalkTexture:()=>concrete,
        roadGroundPaintStyle:()=>({key:'road',revision:'1'}), GRASS_UV_PER_M:1/3,FLOWERBED_UV_PER_M:1/1.7,
        SIDEWALK_UV_PER_M:1/4,EDGING_SLAB_LEN_M:.8,EDGING_MIN_AREA_M2:30,
        createDecorGroundPaintOwnerSteps,decorSurfaceEdgingPolygonsSteps,decorSurfaceEdgingTypeIndex,
        hiddenInspectionLayerIds:()=>new Set(hidden),safeSurfaceId:x=>x,
        terrainReference:{roadFormation:null},getLocation:()=>({terrain:{surfaceStyle:'grass'}}),
        terrainBaseY:()=>{throw new Error('colour construction sampled terrain');},
        DEG_TO_RAD:Math.PI/180,EARTH_RADIUS_M:6371000,GREENERY_RADIUS_M:1100,GREENERY_CLIP_MARGIN_M:64,
        DECOR_MARKING_DRAPE_CHUNK_VERTICES:1,DECOR_MERGE_COPY_CHUNK_VALUES:30000,
        querySpatialIndex:index=>index.entries,radiusBounds:()=>({}),getDecorRoadSurfaceIndex:()=>null,
        cleanRing:ring=>ring,ringSelfIntersects:()=>false,normaliseSurfaceType:type=>type,
        signedRingArea:area,polygonAreaM2:({outerRing,holeRings=[]})=>Math.abs(area(outerRing))-holeRings.reduce((s,r)=>s+Math.abs(area(r)),0),
        clipRingToWindow:ring=>ring,createBuildYieldState:()=>({}),maybeYieldBuild:async(_,cancel)=>!cancel(),
        resetBuildYieldState:()=>{},disposeGroup:group=>group?.clear(),
        buildForestTreesGroup:async polygons=>{calls.push(['forest',polygons.length]);return null;},
        buildFlowerbedsGroup:async polygons=>{calls.push(['flowers',polygons.length]);return null;},
        buildFountainRimMesh:()=>null,runwaySpawnCandidates:()=>[],prepareGreeneryPublicationGroup:()=>{},
    });
    vm.runInContext(code, context);
    const build = (entries, cancel = () => false) => context.buildGreeneryGroup({entries},0,0,0,0,cancel);
    const plan = group => exhaust(createGroundCompositePlanSteps({receiver,
        records:group.userData.groundPaintOwners.flatMap(owner=>owner.records),
        limits:{records:64,vertices:8192,verticesPerRecord:8192,oversized:64}}));
    return {build,plan,receiver,recipes,maps,calls};
}

test('production land-use adapter builds holed paint and edging without a drape or height samples', async () => {
    const f = harness();
    const group = await f.build([{type:'paving',rings:[square(10),square(2,3)],groundPaintEligible:true},
        {type:'forest',rings:[square(10,20)],groundPaintEligible:true}]);
    assert.equal(group.children.length,0,'colour contributes no mesh or collision geometry');
    assert.equal(group.userData.terrainLanduseMask,undefined);
    const plan = f.plan(group);
    assert.equal(plan.paintAt(2,5,f.receiver).materialKey,'decor-paving');
    assert.equal(plan.paintAt(4,1,f.receiver),null,'the mapped hole remains open');
    assert.equal(plan.paintAt(0,5,f.receiver).materialKey,'decor-edging');
    assert.equal(plan.paintAt(22,5,f.receiver).materialKey,'decor-forest');
    assert.deepEqual(f.calls,[['forest',1],['flowers',0]],'volumetric vegetation keeps its source polygons');
    const captured = captureGroundPaintStyles(f.recipes);
    assert.equal(captured.recipes.length,8);
    assert.equal(new Set(captured.recipes.map(r=>r.albedoMap?.key).filter(Boolean)).size,3,
        'only grass and soil are new; concrete is shared');
});

test('hidden land-use categories remove only their paint and keep source vegetation', async () => {
    const f = harness(['landuse-forest','surface-edging']);
    const group = await f.build([{type:'forest',rings:[square(10)],groundPaintEligible:true},
        {type:'paving',rings:[square(10,20)],groundPaintEligible:true}]);
    const plan = f.plan(group);
    assert.equal(plan.paintAt(5,5,f.receiver),null);
    assert.equal(plan.paintAt(20,5,f.receiver).materialKey,'decor-paving');
    assert.equal(plan.commands.some(r=>r.materialKey==='decor-edging'),false);
    assert.ok(group.userData.groundPaintLayerIds.includes('landuse-forest'),'the hidden category remains available to re-enable');
    assert.deepEqual(f.calls,[['forest',1],['flowers',0]]);
    assert.equal(await f.build([{type:'paving',rings:[square(10)],groundPaintEligible:true}],()=>true),null,
        'cancellation cannot hand off a partial source set');
});
