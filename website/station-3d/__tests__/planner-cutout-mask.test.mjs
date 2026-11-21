// Inspect the actual canvas commands: physical polygon vertices must survive
// resolution changes, and cancelled work must release its private bitmap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { preparePlannerCutoutMaskSteps } from '../world/planner-cutout-mask.js';
import { capturePlannerOpeningRegionsSteps } from '../core/planner-opening-boundaries.js';
import { createPlannerGeometryBudget } from '../core/planner-geometry-budget.js';
const finish=steps=>{try{for(;;){const next=steps.next();if(next.done)return next.value;}}finally{steps.return();}};
function canvasRecorder(){
    const polygons=[];let path;
    const context={fillRect(){},beginPath(){path=[];},moveTo(x,z){path.push({x,z});},
        lineTo(x,z){path.push({x,z});},closePath(){},fill(){polygons.push(path);}};
    return {width:0,height:0,polygons,getContext:()=>context};
}
const cuts=[{kind:'ramp',x1:0,z1:0,x2:1000,z2:0,widthM:2,pathId:'a',pathOrder:0},
    {kind:'ramp',x1:1000,z1:0,x2:1000,z2:1000,widthM:2,pathId:'a',pathOrder:1}];
const regions=finish(capturePlannerOpeningRegionsSteps(cuts,{maxCuts:8,maxRegions:8,maxVertices:32}));

test('shader mask commands retain exact civil joins and subpixel widths at different resolutions',()=>{
    const frames=[];
    for(const maxSizePx of [256,1024]){
        const canvas=canvasRecorder();
        const mask=finish(preparePlannerCutoutMaskSteps(regions,{budget:createPlannerGeometryBudget(),createCanvas:()=>canvas,maxSizePx}));
        try{
            assert.equal(canvas.width,maxSizePx);assert.equal(canvas.polygons.length,2);
            const world=canvas.polygons.map(ring=>ring.map(p=>({x:p.x/canvas.width*mask.halfSizeM*2+mask.centerX-mask.halfSizeM,
                z:p.z/canvas.height*mask.halfSizeM*2+mask.centerZ-mask.halfSizeM})));
            for(let i=0;i<regions.length;i++)for(let j=0;j<regions[i].ring.length;j++)for(const key of ['x','z'])
                assert.ok(Math.abs(world[i][j][key]-regions[i].ring[j][key])<1e-10);
            frames.push([mask.centerX,mask.centerZ,mask.halfSizeM]);
            assert.equal(mask.texture.generateMipmaps,false);assert.equal(mask.texture.flipY,false);
            assert.equal(mask.texture.userData.cutoutCount,2);
        }finally{mask.texture.dispose();}
    }
    assert.deepEqual(frames[0],frames[1]);
});

test('empty masks allocate nothing and cancellation frees the private canvas before publication',()=>{
    assert.equal(finish(preparePlannerCutoutMaskSteps([],{budget:createPlannerGeometryBudget(),createCanvas:()=>assert.fail('empty allocation')})),null);
    const canvas=canvasRecorder();let time=0,valid=true;
    const steps=preparePlannerCutoutMaskSteps(regions,{budget:createPlannerGeometryBudget({now:()=>time+=1,isCurrent:()=>valid}),createCanvas:()=>canvas});
    for(;;){const next=steps.next();assert.equal(next.done,false);if(next.value.phase==='planner-mask-polygon')break;}
    assert.equal(canvas.width,2048);valid=false;
    assert.throws(()=>steps.next(),{code:'ground-generation-stale'});
    assert.equal(canvas.width,0);assert.equal(canvas.height,0);assert.equal(canvas.polygons.length,0);
});
