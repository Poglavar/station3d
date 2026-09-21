// One captured opening index serves geometry, point queries and terrain
// compilation. Callers supply only boundaries whose replacement entries join
// the same ground publication; this module does not grant backstop readiness.
import { createSurfaceOpeningTopologySteps } from './surface-opening-topology.js';
import { compileSurfaceOpeningTarget, asSurfaceClaim, SURFACE_PLANNER_CUTOUT_MODE } from './surface-hierarchy.js';

const TARGET = Object.freeze({authored:1, entrance:2, plannerSurface:4, plannerStructural:8, water:16});

export function* createSurfaceOpeningReadSteps({authored=[],entrances=[],planner=[],water=[],limits,
    now=()=>performance.now(),isCurrent=()=>true}={}) {
    const sets=[[authored,()=>TARGET.authored],[entrances,()=>TARGET.entrance],
        [planner,region=>region.kind==='surface-track'?TARGET.plannerSurface:TARGET.plannerStructural],
        [water,()=>TARGET.water]];
    let deadline=now()+.5;
    const regions=[];
    if (!Number.isSafeInteger(limits?.maxRegions) || limits.maxRegions<1) throw new TypeError('Opening read requires bounded regions');
    for(const [sources,target] of sets) {
        if(!Array.isArray(sources)) throw new TypeError('Opening read requires complete source arrays');
        for(const region of sources) {
            if(!isCurrent())throw Object.assign(new Error('Opening sources were superseded'),{code:'ground-opening-stale'});
            if(regions.length>=limits.maxRegions)throw Object.assign(new Error('Combined opening set exceeds capacity'),{code:'ground-opening-capacity'});
            if(now()>=deadline){yield {phase:'ground-opening-sources'};deadline=now()+.5;}
            regions.push({...region,targetMask:target(region)});
        }
    }
    const topology=yield* createSurfaceOpeningTopologySteps({regions,limits,now,isCurrent});
    function queryOptions(inputClaim) {
        const claim=asSurfaceClaim(inputClaim),contract=compileSurfaceOpeningTarget(claim);
        let targetMask=TARGET.authored;
        if(contract.plannerCutoutMode!==SURFACE_PLANNER_CUTOUT_MODE.NONE) {
            targetMask|=TARGET.entrance|TARGET.plannerStructural;
            if(contract.plannerCutoutMode===SURFACE_PLANNER_CUTOUT_MODE.ALL)targetMask|=TARGET.plannerSurface;
        }
        if(contract.groundHoleTarget)targetMask|=TARGET.water;
        return Object.freeze({targetMask,excludeReplacementKey:claim.replacementKey});
    }
    return Object.freeze({contract:'station3d-surface-opening-read-v1',isCurrent,
        regions:topology.regions,empty:topology.regions.length===0,
        topologyForClaim(claim) {
            const options=queryOptions(claim);
            return Object.freeze({contract:topology.contract,
                intersectsBoundsSteps:bounds=>topology.intersectsBoundsSteps(bounds,options),
                clipTriangleSteps:(a,b,c)=>topology.clipTriangleSteps(a,b,c,options)});
        },
        contains(x,y,z,claim) {return topology.contains(x,y,z,queryOptions(claim));},
        *terrainLayersSteps(claim) {
            const {targetMask,excludeReplacementKey}=queryOptions(claim),selected=[];
            for(const region of topology.regions) {
                if(!isCurrent())throw Object.assign(new Error('Opening terrain inputs were superseded'),{code:'ground-opening-stale'});
                if(now()>=deadline){yield {phase:'ground-opening-terrain-regions'};deadline=now()+.5;}
                if(region.targetMask&targetMask && (!excludeReplacementKey || region.replacementKey!==excludeReplacementKey))selected.push(region);
            }
            return Object.freeze(selected.length?[Object.freeze({operation:'subtract',regions:Object.freeze(selected)})]:[]);
        },
    });
}
