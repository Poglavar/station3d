// One physical boundary for the terrain receiver and its support mesh.
// Input regions are ordered subtract/restore operations, in engine metres.
// Window clipping is cooperative. Boolean operations and triangulation receive
// explicitly capped local operands, never the loaded world or a complete DTM.
import { Clipper64, PolyTree64, ClipType, FillRule } from 'clipper2-ts';
import earcut from 'earcut';
import { orient2d } from 'robust-predicates';
import { createBoundsGridSteps } from './bounds-grid.js';
import { clipRingToWindowSteps } from './render-budgets.js';
import { captureOpeningLowerPlane, openingLowerPlaneHeight } from './surface-opening-plane.js';
import { roundTerrainBoundarySteps, TERRAIN_BOOLEAN_LATTICE_M } from './terrain-storage-rounding.js';

function fail(code, message, details = null) { throw Object.assign(new Error(message), { code, details }); }
const finite = value => typeof value === 'number' && Number.isFinite(value);
const cross = (a,b,c) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const same = (a,b) => a[0]===b[0] && a[1]===b[1];
const pointKey = p => `${p[0]},${p[1]}`;
const edgeKey = (a,b) => `${pointKey(a)}:${pointKey(b)}`;
const overlaps = (a,b) => a.minX<=b.maxX && a.maxX>=b.minX && a.minZ<=b.maxZ && a.maxZ>=b.minZ;
const overlapsWithArea = (a,b) => Math.min(a.maxX,b.maxX)>Math.max(a.minX,b.minX)
    && Math.min(a.maxZ,b.maxZ)>Math.max(a.minZ,b.minZ);
const TERRAIN_STORAGE_STEP_TOLERANCE_M=.001/5;

function clockFor(now, isCurrent) {
    let deadline=now()+.5;
    const check=()=>{if(!isCurrent())fail('ground-topology-stale','Terrain topology was superseded');};
    return {check,
        *step(phase) { check(); if(now()>=deadline){yield {phase};check();deadline=now()+.5;} },
    };
}

// Exact directed boundary cancellation is stronger than area agreement alone:
// consistently wound triangles must have precisely the polygon's boundary.
// Split exact collinear junctions before validation. Unmatched internal edges
// then reject the candidate rather than spanning a hole or leaving a crack.
function* triangulatePolygonSteps(polygon, clock, limits) {
    const points=[],flat=[],holes=[],boundary=new Map(),edges=[];
    const onSegment=(p,a,b)=>!same(p,a)&&!same(p,b)
        &&p[0]>=Math.min(a[0],b[0])&&p[0]<=Math.max(a[0],b[0])
        &&p[1]>=Math.min(a[1],b[1])&&p[1]<=Math.max(a[1],b[1])
        &&orient2d(...a,...b,...p)===0;
    function addEdge(a,b,sign) {
        if(same(a,b))return;
        const key=edgeKey(a,b), reverse=edgeKey(b,a);
        if(boundary.has(reverse)) {
            const next=boundary.get(reverse)-sign;
            if(next===0)boundary.delete(reverse);else boundary.set(reverse,next);
        } else {
            const next=(boundary.get(key)||0)+sign;
            if(next===0)boundary.delete(key);else boundary.set(key,next);
        }
    }
    for(const [ringIndex,ring] of polygon.entries()) {
        if(ringIndex)holes.push(points.length);
        const end=ring.length>1&&same(ring[0],ring.at(-1))?ring.length-1:ring.length;
        for(let i=0;i<end;i++) {
            yield* clock.step('ground-topology-polygon');
            const point=ring[i]; points.push(point);flat.push(point[0],point[1]);
            edges.push([point,ring[(i+1)%end]]);
        }
    }
    if(points.length>limits.maxOperandVertices)fail('ground-topology-capacity','Terrain polygon exceeds triangulation capacity');
    // A hole may touch an outer edge at a point which is not already an outer
    // vertex. Subdivide boundary segments without moving any coordinate.
    for(const edge of edges) {
        const pending=[edge];
        while(pending.length) {
            const [a,b]=pending.pop();let split=null;
            for(const p of points) {
                yield* clock.step('ground-topology-boundary-junction');
                if(onSegment(p,a,b)){split=p;break;}
            }
            if(split)pending.push([a,split],[split,b]);else addEdge(a,b,-1);
        }
    }
    yield* clock.step('ground-topology-triangulate');
    const indices=earcut(flat,holes,2), triangles=[];
    if(indices.length/3>limits.maxOutputTriangles)fail('ground-topology-capacity','Terrain polygon exceeds triangle capacity');
    for(let i=0;i<indices.length;i+=3) {
        const a=points[indices[i]],b=points[indices[i+1]],c=points[indices[i+2]];
        if(!a||!b||!c)fail('ground-topology-triangulation','Terrain triangulation contains an invalid index');
        const area=cross(a,b,c);
        if(!finite(area)||area===0)fail('ground-topology-triangulation','Terrain triangulation contains a degenerate face');
        const pending=[area>0?[a,b,c]:[a,c,b]];
        while(pending.length) {
            const face=pending.pop();let split=false;
            for(let edge=0;edge<3&&!split;edge++)for(const p of points) {
                yield* clock.step('ground-topology-triangle-junction');
                const a=face[edge],b=face[(edge+1)%3],c=face[(edge+2)%3];
                if(!onSegment(p,a,b))continue;
                pending.push([a,p,c],[p,b,c]);split=true;break;
            }
            if(triangles.length+pending.length>limits.maxOutputTriangles)fail('ground-topology-capacity','Terrain junction repair exceeds triangle capacity');
            if(split)continue;
            yield* clock.step('ground-topology-verify');
            addEdge(face[0],face[1],1);addEdge(face[1],face[2],1);addEdge(face[2],face[0],1);
            triangles.push(face);
        }
    }
    if(boundary.size)fail('ground-topology-triangulation','Terrain triangulation does not preserve its complete boundary');
    return triangles;
}

function* checkOperandsSteps(operands, clock, limits) {
    const segments=[];let scale=1;
    for(const multi of operands)for(const polygon of multi)for(const ring of polygon) {
        const end=ring.length>1&&same(ring[0],ring.at(-1))?ring.length-1:ring.length;
        for(let i=0;i<end;i++) {
            yield* clock.step('ground-topology-capacity');
            if(segments.length>=limits.maxOperandVertices)fail('ground-topology-capacity','Terrain Boolean operand exceeds vertex capacity');
            const a=ring[i],b=ring[(i+1)%end];
            if(!a.every(finite)||!b.every(finite))fail('ground-topology-coordinate','Non-finite terrain Boolean coordinate');
            scale=Math.max(scale,Math.abs(a[0]),Math.abs(a[1]),Math.abs(b[0]),Math.abs(b[1]));
            if(!same(a,b))segments.push([a,b]);
        }
    }
    let crossings=0;
    for(let i=0;i<segments.length;i++)for(let j=i+1;j<segments.length;j++) {
        yield* clock.step('ground-topology-intersections');
        const [a,b]=segments[i],[c,d]=segments[j];
        if(cross(a,b,c)*cross(a,b,d)<0 && cross(c,d,a)*cross(c,d,b)<0
            && ++crossings>limits.maxIntersections)fail('ground-topology-capacity','Terrain Boolean operand exceeds crossing capacity');
    }
    return scale;
}

function* booleanSteps(operation, operands, clock, limits) {
    const scale=yield* checkOperandsSteps(operands,clock,limits);
    const clipType={union:ClipType.Union,intersection:ClipType.Intersection,difference:ClipType.Difference}[operation];
    if(!clipType||operands.length<1||operands.length>2)throw new TypeError('Invalid terrain Boolean operation');
    // Operands have already been clipped into one small source-face window.
    // A binary integer grid avoids almost-coincident floating sweep edges.
    // 2^-40 m is below local source-double precision at ordinary world offsets
    // and far below GPU storage; never use pixel or screen resolution here.
    const unit=1/TERRAIN_BOOLEAN_LATTICE_M,clipper=new Clipper64(),tree=new PolyTree64();
    function* pathsFor(multi) {
        const paths=[];
        for(const polygon of multi)for(const [ringIndex,ring] of polygon.entries()) {
            const path=[];let area=0;
            for(let i=0;i<ring.length;i++) {
                yield* clock.step('ground-topology-integer-input');
                const p=ring[i],q=ring[(i+1)%ring.length];
                const x=Math.round(p[0]*unit),y=Math.round(p[1]*unit);
                if(!Number.isSafeInteger(x)||!Number.isSafeInteger(y)||Math.max(Math.abs(x),Math.abs(y))>2**51) {
                    fail('ground-topology-capacity','Terrain Boolean window exceeds exact integer capacity');
                }
                area+=p[0]*q[1]-p[1]*q[0];
                if(!path.length||path.at(-1).x!==x||path.at(-1).y!==y)path.push({x,y});
            }
            if(path.length>1&&path[0].x===path.at(-1).x&&path[0].y===path.at(-1).y)path.pop();
            if(path.length<3)continue;
            if(ringIndex?area>0:area<0)path.reverse();
            paths.push(path);
        }
        return paths;
    }
    clipper.addSubject(yield* pathsFor(operands[0]));
    if(operands.length===2)clipper.addClip(yield* pathsFor(operands[1]));
    yield* clock.step('ground-topology-boolean');
    if(!clipper.execute(clipType,FillRule.NonZero,tree))fail('ground-topology-boolean','Terrain polygon clipping failed');
    const result=[],pending=[{node:tree,polygon:null}];
    while(pending.length) {
        const {node,polygon}=pending.pop();
        for(let i=0;i<node.count;i++) {
            yield* clock.step('ground-topology-integer-output');
            const child=node.child(i),ring=[];
            for(const p of child.poly) { yield* clock.step('ground-topology-integer-output');ring.push([p.x/unit,p.y/unit]); }
            ring.push(ring[0]);
            const owner=child.isHole?polygon:[ring];
            if(child.isHole)owner.push(ring);else result.push(owner);
            pending.push({node:child,polygon:owner});
        }
    }
    let vertices=0;
    for(const polygon of result)for(const ring of polygon) {
        yield* clock.step('ground-topology-result');
        vertices+=ring.length;
        if(vertices>limits.maxOperandVertices)fail('ground-topology-capacity','Terrain Boolean result exceeds vertex capacity');
    }
    const normalized=[],tolerance=32*Number.EPSILON*Math.max(scale,clock.coordinateScale||1);
    for(const polygon of result) {
        const rings=[];
        for(const ring of polygon) {
            const points=same(ring[0],ring.at(-1))?ring.slice(0,-1):ring;
            const n=points.length,previous=new Int32Array(n),next=new Int32Array(n),removed=new Uint8Array(n),pending=[];
            for(let i=0;i<n;i++) {
                yield* clock.step('ground-topology-roundoff');
                previous[i]=(i+n-1)%n;next[i]=(i+1)%n;pending.push(i);
            }
            let count=n;
            while(pending.length&&count>=3) {
                yield* clock.step('ground-topology-roundoff');
                const index=pending.pop();if(removed[index])continue;
                const left=previous[index],right=next[index],a=points[left],b=points[index],c=points[right];
                const length=Math.hypot(c[0]-a[0],c[1]-a[1]);
                if(length&&Math.abs(cross(a,b,c))>tolerance*length)continue;
                removed[index]=1;count--;next[left]=right;previous[right]=left;
                pending.push(left,right);
            }
            if(count<3) {
                if(!rings.length)break;
                continue;
            }
            const clean=[];
            for(let i=0;i<n;i++) { yield* clock.step('ground-topology-roundoff'); if(!removed[i])clean.push(points[i]); }
            clean.push(clean[0]);rings.push(clean);
        }
        if(rings.length)normalized.push(rings);
    }
    return normalized;
}

// A volume clip can partition one planar face into adjacent convex pieces.
// Dissolve those artificial internal edges before triangulation, using the
// same bounded Boolean kernel and directed-boundary proof as terrain cuts.
export function* triangulateReceiverPolygonsSteps({polygons,limits,coordinateScale=1,
    now=()=>performance.now(),isCurrent=()=>true}={}) {
    if(!Array.isArray(polygons)||!['maxOperandVertices','maxIntersections','maxOutputTriangles']
        .every(key=>Number.isSafeInteger(limits?.[key])&&limits[key]>0)
        ||!finite(coordinateScale)||coordinateScale<1)throw new TypeError('Receiver polygon triangulation requires bounded local inputs');
    const clock=clockFor(now,isCurrent);clock.coordinateScale=coordinateScale;
    const normalized=yield* booleanSteps('union',[polygons],clock,limits),triangles=[];
    for(const polygon of normalized)for(const triangle of yield* triangulatePolygonSteps(polygon,clock,limits)) {
        yield* clock.step('ground-receiver-polygon-triangles');
        if(triangles.length>=limits.maxOutputTriangles)fail('ground-topology-capacity','Receiver exceeds output triangle capacity');
        triangles.push(triangle);
    }
    clock.check();return triangles;
}

export function* createTerrainCutoutTopologySteps({ layers, limits, now=()=>performance.now(), isCurrent=()=>true,
    receiverStorage=null }={}) {
    for(const key of ['maxSources','maxSourceVertices','maxIndexEntries','maxCellCandidates','maxOperandVertices','maxIntersections','maxOutputTriangles']) {
        if(!Number.isSafeInteger(limits?.[key])||limits[key]<=0)throw new TypeError(`Explicit terrain topology limit required: ${key}`);
    }
    if(!Array.isArray(layers))throw new TypeError('Terrain topology requires ordered captured layers');
    limits=Object.freeze({...limits});
    const clock=clockFor(now,isCurrent), copies=new WeakMap(), prepared=[];
    const cellM=24,maxCellsPerItem=64;
    let sourceCount=0,sourceVertices=0,indexEntries=0;
    function reserveIndex(count=1) {
        indexEntries+=count;
        if(indexEntries>limits.maxIndexEntries)fail('ground-topology-capacity','Terrain topology exceeds spatial index capacity');
    }
    function* gridFor(entries) {
        for(const {bounds} of entries) {
            yield* clock.step('ground-topology-index-capacity');
            const width=Math.floor(bounds.maxX/cellM)-Math.floor(bounds.minX/cellM)+1;
            const height=Math.floor(bounds.maxZ/cellM)-Math.floor(bounds.minZ/cellM)+1;
            reserveIndex(width*height>maxCellsPerItem?1:width*height);
        }
        return yield* createBoundsGridSteps(entries,{cellM,now:()=>{clock.check();return now();}});
    }
    function* copyRing(ring) {
        if(!Array.isArray(ring)||ring.length<3)fail('ground-topology-source','Terrain topology requires valid source rings');
        if(copies.has(ring))return copies.get(ring);
        const copy=[],bounds={minX:Infinity,minZ:Infinity,maxX:-Infinity,maxZ:-Infinity};
        for(const point of ring) {
            yield* clock.step('ground-topology-source');
            if(++sourceVertices>limits.maxSourceVertices)fail('ground-topology-capacity','Terrain topology exceeds source capacity');
            if(!finite(point?.x)||!finite(point?.z))fail('ground-topology-coordinate','Terrain topology contains an absent coordinate');
            copy.push(Object.freeze({x:point.x,z:point.z}));
            bounds.minX=Math.min(bounds.minX,point.x);bounds.maxX=Math.max(bounds.maxX,point.x);
            bounds.minZ=Math.min(bounds.minZ,point.z);bounds.maxZ=Math.max(bounds.maxZ,point.z);
        }
        const edges=[],zBuckets=new Map(),longZ=[];
        for(let i=0;i<copy.length;i++) {
            yield* clock.step('ground-topology-source-edges');
            const a=copy[i],b=copy[(i+1)%copy.length];
            if(a.x===b.x&&a.z===b.z)continue;
            const edge={a,b,bounds:{minX:Math.min(a.x,b.x),minZ:Math.min(a.z,b.z),
                maxX:Math.max(a.x,b.x),maxZ:Math.max(a.z,b.z)}};
            edges.push(edge);
            const low=Math.floor(edge.bounds.minZ/cellM),high=Math.floor(edge.bounds.maxZ/cellM);
            if(high-low+1>maxCellsPerItem){reserveIndex();longZ.push(edge);continue;}
            for(let z=low;z<=high;z++) {
                yield* clock.step('ground-topology-winding-index');
                reserveIndex();let bucket=zBuckets.get(z);
                if(!bucket)zBuckets.set(z,bucket=[]);bucket.push(edge);
            }
        }
        const edgeGrid=yield* gridFor(edges);
        const result=Object.freeze({ring:Object.freeze(copy),bounds:Object.freeze(bounds),edgeGrid,zBuckets,longZ});
        copies.set(ring,result);return result;
    }
    for(const layer of layers) {
        if(!['subtract','restore'].includes(layer?.operation)||!Array.isArray(layer.regions))throw new TypeError('Invalid terrain topology operation');
        const entries=[];
        for(const region of layer.regions) {
            yield* clock.step('ground-topology-regions');
            if(++sourceCount>limits.maxSources)fail('ground-topology-capacity','Terrain topology exceeds region capacity');
            const source=yield* copyRing(region.ring), clips=[], holes=[];
            for(const ring of region.clipRings||[])clips.push(yield* copyRing(ring));
            for(const ring of region.holeRings||[])holes.push(yield* copyRing(ring));
            const minY=region.minY??null,maxY=region.maxY??null,maxYExclusive=region.maxYExclusive??false;
            const minPlane=captureOpeningLowerPlane(region.minPlane);
            if((minY!==null&&!finite(minY))||(maxY!==null&&!finite(maxY))
                ||(minY!==null&&maxY!==null&&minY>=maxY)||typeof maxYExclusive!=='boolean') {
                fail('ground-topology-source','Terrain cut height bounds must form a finite interval');
            }
            entries.push(Object.freeze({...source,clips:Object.freeze(clips),holes:Object.freeze(holes),minY,maxY,maxYExclusive,minPlane}));
        }
        const grid=yield* gridFor(entries);
        prepared.push({operation:layer.operation,grid});
    }
    // One source-coordinate normalization per receiver, before individual
    // lattice cells intersect those paths. Rounding a windowed path anew in
    // each cell changes its edge slope on either side of the cell boundary.
    // A 1 mm halo keeps that window's artificial edges outside the receiver;
    // large remote source coordinates never enter its Float32 storage domain.
    function* prepareReceiverStorageSteps({bounds,storageOrigin,now=()=>performance.now(),isCurrent=()=>true}) {
        if(!bounds||!['minX','minZ','maxX','maxZ'].every(key=>finite(bounds[key]))
            ||bounds.minX>bounds.maxX||bounds.minZ>bounds.maxZ
            ||!finite(storageOrigin?.x)||!finite(storageOrigin?.z))throw new TypeError('Invalid terrain receiver storage domain');
        if(receiverStorage) {
            if(receiverStorage.x!==storageOrigin.x||receiverStorage.z!==storageOrigin.z
                ||['minX','minZ','maxX','maxZ'].some(key=>receiverStorage.bounds[key]!==bounds[key])) {
                throw new TypeError('Terrain storage domain changed');
            }
            return api;
        }
        const clock=clockFor(now,isCurrent),storedLayers=[],copies=new Map();
        const centerX=(bounds.minX+bounds.maxX)*.5,centerZ=(bounds.minZ+bounds.maxZ)*.5;
        const half=Math.max(bounds.maxX-bounds.minX,bounds.maxZ-bounds.minZ)*.5+.001;
        const window={minX:centerX-half,minZ:centerZ-half,maxX:centerX+half,maxZ:centerZ+half};
        let storedVertices=0;
        function* hasAreaSteps(ring) {
            const a=ring[0];let b=null;
            for(const p of ring) {
                yield* clock.step('ground-topology-operand-dimension');
                if(!b){if(p.x!==a.x||p.z!==a.z)b=p;}
                else if(orient2d(a.x,a.z,b.x,b.z,p.x,p.z)!==0)return true;
            }
            return false;
        }
        function* hasUncancelledBoundarySteps(ring) {
            // NonZero fill gives an exactly retraced path no interior, even
            // when interpolation has made its intermediate points slightly
            // noncollinear. This is exact edge cancellation, not an area or
            // distance tolerance that could erase a small real opening.
            const edges=new Map();
            for(let i=0;i<ring.length;i++) {
                yield* clock.step('ground-topology-operand-boundary');
                const a=ring[i],b=ring[(i+1)%ring.length];
                if(a.x===b.x&&a.z===b.z)continue;
                const key=`${a.x},${a.z}:${b.x},${b.z}`,reverse=`${b.x},${b.z}:${a.x},${a.z}`;
                const opposite=edges.get(reverse)||0;
                if(opposite===1)edges.delete(reverse);
                else if(opposite>1)edges.set(reverse,opposite-1);
                else edges.set(key,(edges.get(key)||0)+1);
            }
            return edges.size>0;
        }
        function* hasStorageResolvableWidthSteps(ring) {
            const a=ring[0];let b=a,maxDistanceSquared=0;
            for(const point of ring) {
                yield* clock.step('ground-topology-operand-width');
                const dx=point.x-a.x,dz=point.z-a.z,distanceSquared=dx*dx+dz*dz;
                if(distanceSquared>maxDistanceSquared){maxDistanceSquared=distanceSquared;b=point;}
            }
            if(maxDistanceSquared<=TERRAIN_STORAGE_STEP_TOLERANCE_M*TERRAIN_STORAGE_STEP_TOLERANCE_M)return false;
            const length=Math.sqrt(maxDistanceSquared);
            for(const point of ring) {
                yield* clock.step('ground-topology-operand-width');
                if(Math.abs(orient2d(a.x,a.z,b.x,b.z,point.x,point.z))/length
                    >TERRAIN_STORAGE_STEP_TOLERANCE_M)return true;
            }
            return false;
        }
        function* storedRingSteps(source) {
            if(copies.has(source))return copies.get(source);
            if(!overlaps(source.bounds,window)){copies.set(source,null);return null;}
            const clipped=yield* clipRingToWindowSteps(source.ring,centerX,centerZ,half,{now,isCurrent});
            if(clipped.length<3){copies.set(source,null);return null;}
            const stored=[],clippedBounds={minX:Infinity,minZ:Infinity,maxX:-Infinity,maxZ:-Infinity};
            for(const p of clipped) {
                yield* clock.step('ground-topology-operand-storage');
                if(++storedVertices>limits.maxSourceVertices)fail('ground-topology-capacity','Stored terrain operands exceed source capacity');
                const x=Math.fround(p.x-storageOrigin.x)+storageOrigin.x,z=Math.fround(p.z-storageOrigin.z)+storageOrigin.z;
                // One source rounding plus at most four output rounds share
                // the same 1 mm displacement allowance.
                if(!finite(x)||!finite(z)||Math.hypot(x-p.x,z-p.z)>TERRAIN_STORAGE_STEP_TOLERANCE_M) {
                    fail('ground-topology-precision','Terrain operand exceeds the 1 mm storage tolerance');
                }
                clippedBounds.minX=Math.min(clippedBounds.minX,p.x);clippedBounds.maxX=Math.max(clippedBounds.maxX,p.x);
                clippedBounds.minZ=Math.min(clippedBounds.minZ,p.z);clippedBounds.maxZ=Math.max(clippedBounds.maxZ,p.z);
                if(!stored.length||stored.at(-1).x!==x||stored.at(-1).z!==z)stored.push({x,z});
            }
            if(!(yield* hasAreaSteps(stored))) {
                // The 1 mm storage halo deliberately includes operands that
                // only touch the receiver edge. Clipping can give that contact
                // a tiny double-precision triangle outside the receiver, which
                // correctly collapses when stored. Diagnose loss only when the
                // clipped source owns positive area inside the actual receiver.
                // A source can contain a micrometre-wide triangle made by a
                // densified midpoint that is numerically just off its parent
                // edge. It has exact double-precision area, but it is narrower
                // than the displacement this storage contract already permits
                // and has no representable interior. Discard that sliver. A
                // collapsed operand wider than the contract still fails rather
                // than silently removing a real opening or island.
                if(overlapsWithArea(clippedBounds,bounds)&&(yield* hasAreaSteps(clipped))
                    &&(yield* hasUncancelledBoundarySteps(source.ring))
                    &&(yield* hasStorageResolvableWidthSteps(clipped)))fail('ground-topology-precision',
                    'Float32 terrain storage collapses an input opening or island', {terrainStorage:{
                        kind:'operand-collapse',bounds:{...bounds},storageOrigin:{...storageOrigin},
                        sourceBounds:{...source.bounds},sourceVertices:source.ring.length,
                        ring:source.ring.length<=128?source.ring.map(p=>({...p})):null,
                        clipped:clipped.length<=128?clipped.map(p=>({...p})):null,
                        stored:stored.length<=128?stored.map(p=>({...p})):null,
                    }});
                copies.set(source,null);return null;
            }
            copies.set(source,stored);return stored;
        }
        for(const layer of prepared) {
            const regions=[],seen=new Set();
            for(const region of layer.grid.candidateItemsInBox(window.minX,window.minZ,window.maxX,window.maxZ)) {
                yield* clock.step('ground-topology-stored-regions');
                if(seen.has(region)||!overlaps(region.bounds,window))continue;
                seen.add(region);
                const ring=yield* storedRingSteps(region);if(!ring)continue;
                const clipRings=[],holeRings=[];
                for(const source of region.clips){const part=yield* storedRingSteps(source);if(part)clipRings.push(part);}
                if(region.clips.length&&!clipRings.length)continue;
                for(const source of region.holes){const part=yield* storedRingSteps(source);if(part)holeRings.push(part);}
                regions.push({ring,clipRings,holeRings,minY:region.minY,maxY:region.maxY,maxYExclusive:region.maxYExclusive,
                    minPlane:region.minPlane});
            }
            storedLayers.push({operation:layer.operation,regions});
        }
        return yield* createTerrainCutoutTopologySteps({layers:storedLayers,limits,now,isCurrent,
            receiverStorage:Object.freeze({x:storageOrigin.x,z:storageOrigin.z,bounds:Object.freeze({...bounds})})});
    }
    clock.check();
    const api=Object.freeze({contract:'station3d-terrain-cutout-topology-v1',sourceCount,sourceVertices,indexEntries,
        prepareReceiverStorageSteps,
        *clipTriangleSteps(a,b,c,{now=()=>performance.now(),isCurrent=()=>true,storageOrigin=null}={}) {
            const clock=clockFor(now,isCurrent);
            for(const point of [a,b,c])if(!finite(point?.x)||!finite(point?.z))fail('ground-topology-coordinate','Terrain triangle contains an absent coordinate');
            if(storageOrigin&&(!finite(storageOrigin.x)||!finite(storageOrigin.z)))throw new TypeError('Invalid terrain storage origin');
            if(receiverStorage&&(!storageOrigin||storageOrigin.x!==receiverStorage.x||storageOrigin.z!==receiverStorage.z
                ||[a,b,c].some(p=>p.x<receiverStorage.bounds.minX||p.x>receiverStorage.bounds.maxX
                    ||p.z<receiverStorage.bounds.minZ||p.z>receiverStorage.bounds.maxZ))) {
                throw new TypeError('Terrain triangle is outside its captured storage domain');
            }
            // The local operands were subtracted from session coordinates;
            // their cancellation error follows that coordinate scale too.
            clock.coordinateScale=Math.max(1,...[a,b,c].flatMap(p=>[Math.abs(p.x),Math.abs(p.z)]));
            clock.check();
            if(!sourceCount)return Object.freeze({unchanged:true,triangles:null});
            const bounds={minX:Math.min(a.x,b.x,c.x),minZ:Math.min(a.z,b.z,c.z),
                maxX:Math.max(a.x,b.x,c.x),maxZ:Math.max(a.z,b.z,c.z)};
            if(storageOrigin&&!receiverStorage) {
                const stored=yield* prepareReceiverStorageSteps({bounds,storageOrigin,now,isCurrent});
                return yield* stored.clipTriangleSteps(a,b,c,{now,isCurrent,storageOrigin});
            }
            const originX=bounds.minX,originZ=bounds.minZ;
            const triangle=[a,b,c].map(p=>[p.x-originX,p.z-originZ]);
            if(cross(...triangle)===0)return Object.freeze({unchanged:true,triangles:null});
            const trianglePolygon=[[triangle]],half=Math.max(bounds.maxX-bounds.minX,bounds.maxZ-bounds.minZ)*.5;
            const centerX=(bounds.minX+bounds.maxX)*.5,centerZ=(bounds.minZ+bounds.maxZ)*.5;
            const windowPolygon=[[[[centerX-half-originX,centerZ-half-originZ],
                [centerX+half-originX,centerZ-half-originZ],[centerX+half-originX,centerZ+half-originZ],
                [centerX-half-originX,centerZ+half-originZ]]]];
            let removed=[],candidates=0;
            const normalized=new Map();
            const storageStepTolerance=TERRAIN_STORAGE_STEP_TOLERANCE_M;
            // A bounded opening intersects this source face's actual plane.
            // Clipping its convex window by the height half-planes preserves
            // roofs/decks outside the volume; the remaining XZ Boolean and
            // triangulation are the same path used by ordinary formation cuts.
            // At most seven window vertices result, independently of source size.
            function heightWindow(minY,maxY,minPlane) {
                if(minY===null&&maxY===null&&minPlane===null)return windowPolygon;
                if(![a,b,c].every(p=>finite(p.y)))fail('ground-topology-coordinate','Height-bounded cuts require source triangle heights');
                const faceArea=cross(...triangle);
                const heightAt=p=>{
                    const wa=cross(p,triangle[1],triangle[2])/faceArea;
                    const wb=cross(triangle[0],p,triangle[2])/faceArea;
                    return wa*a.y+wb*b.y+(1-wa-wb)*c.y;
                };
                let polygon=windowPolygon[0][0].map(p=>({x:p[0],z:p[1],y:heightAt(p)})),changed=false;
                const planes=[];
                if(minY!==null)planes.push({height:minY,distance:p=>p.y-minY});
                if(maxY!==null)planes.push({height:maxY,distance:p=>maxY-p.y});
                if(minPlane!==null)planes.push({distance:p=>p.y-openingLowerPlaneHeight(minPlane,p.x+originX,p.z+originZ)});
                for(const plane of planes) {
                    if(!polygon.length)break;
                    const next=[];
                    let previous=polygon.at(-1),previousDistance=plane.distance(previous),previousInside=previousDistance>=0;
                    for(const point of polygon) {
                        const distance=plane.distance(point),inside=distance>=0;
                        if(inside!==previousInside) {
                            const t=previousDistance/(previousDistance-distance);
                            next.push({x:previous.x+(point.x-previous.x)*t,
                                z:previous.z+(point.z-previous.z)*t,
                                y:plane.height??previous.y+(point.y-previous.y)*t});
                        }
                        if(inside)next.push(point);else changed=true;
                        previous=point;previousInside=inside;previousDistance=distance;
                    }
                    polygon=next;
                }
                if(!changed)return windowPolygon;
                if(polygon.length<3)return [];
                return [[polygon.map(p=>[p.x,p.z])]];
            }
            function* clipRing(source) {
                if(normalized.has(source.ring))return normalized.get(source.ring);
                // A whole triangle has constant winding if no ring boundary
                // enters its bounding rectangle. Index actual edges first;
                // this is containment proof, not a collection of point probes.
                let boundary=false;
                for(const edge of source.edgeGrid.candidateItemsInBox(bounds.minX,bounds.minZ,bounds.maxX,bounds.maxZ)) {
                    yield* clock.step('ground-topology-boundary-candidates');
                    if(overlaps(edge.bounds,bounds)){boundary=true;break;}
                }
                if(!boundary) {
                    let winding=0;
                    for(const edges of [source.longZ,source.zBuckets.get(Math.floor(a.z/cellM))||[]])for(const {a:p,b:q} of edges) {
                        yield* clock.step('ground-topology-winding');
                        if(p.z<=a.z&&q.z>a.z&&orient2d(p.x,p.z,q.x,q.z,a.x,a.z)<0)winding++;
                        if(p.z>a.z&&q.z<=a.z&&orient2d(p.x,p.z,q.x,q.z,a.x,a.z)>0)winding--;
                    }
                    const result=winding?windowPolygon:[];normalized.set(source.ring,result);return result;
                }
                const ring=yield* clipRingToWindowSteps(source.ring,centerX,centerZ,half,{now,isCurrent});
                if(ring.length<3){normalized.set(source.ring,[]);return [];}
                const corners=[[centerX-half,centerZ-half],[centerX+half,centerZ-half],
                    [centerX+half,centerZ+half],[centerX-half,centerZ+half]];
                const closed=ring[0].x===ring.at(-1).x&&ring[0].z===ring.at(-1).z;
                const count=closed?ring.length-1:ring.length;
                const followsWindow=ring.slice(0,count).every((p,i)=>{
                    const next=ring[(i+1)%count];
                    return p.x===next.x||p.z===next.z;
                });
                if(count===4&&followsWindow&&corners.every(([x,z])=>ring.some(p=>p.x===x&&p.z===z))) {
                    normalized.set(source.ring,windowPolygon);return windowPolygon;
                }
                const local=[];
                for(const p of ring){yield* clock.step('ground-topology-localize');local.push([p.x-originX,p.z-originZ]);}
                // Sutherland-Hodgman retains winding across doubled boundary
                // connectors; the Boolean operation normalizes disconnected
                // pieces into simple polygons before triangulation.
                const result=yield* booleanSteps('union',[[[local]]],clock,limits);
                normalized.set(source.ring,result);return result;
            }
            for(const layer of prepared) {
                if(layer.operation==='restore'&&!removed.length)continue;
                const seen=new Set();
                const near=layer.grid.candidateItemsInBox(bounds.minX,bounds.minZ,bounds.maxX,bounds.maxZ);
                for(const region of near) {
                    yield* clock.step('ground-topology-candidates');
                    if(layer.operation==='subtract'&&removed===windowPolygon)break;
                    if(seen.has(region))continue;
                    seen.add(region);
                    if(!overlaps(region.bounds,bounds))continue;
                    if(region.maxYExclusive&&region.maxY!==null&&[a,b,c].every(p=>p.y>=region.maxY))continue;
                    if(++candidates>limits.maxCellCandidates)fail('ground-topology-capacity','Terrain cell exceeds region capacity');
                    const heightCut=heightWindow(region.minY,region.maxY,region.minPlane);
                    if(!heightCut.length)continue;
                    let cut=yield* clipRing(region);
                    if (cut.length && region.holes.length) {
                        for (const hole of region.holes) {
                            if (!overlaps(hole.bounds, bounds)) continue;
                            const part = yield* clipRing(hole);
                            if (part.length) cut = yield* booleanSteps('difference', [cut, part], clock, limits);
                            if (!cut.length) break;
                        }
                    }
                    if(region.clips.length&&cut.length) {
                        let clips=[];
                        for(const clip of region.clips) {
                            if(!overlaps(clip.bounds,bounds))continue;
                            const part=yield* clipRing(clip);
                            if(part.length)clips=clips.length?yield* booleanSteps('union',[clips,part],clock,limits):part;
                        }
                        cut=clips.length?yield* booleanSteps('intersection',[cut,clips],clock,limits):[];
                    }
                    if(cut.length&&heightCut!==windowPolygon)cut=cut===windowPolygon?heightCut
                        :yield* booleanSteps('intersection',[cut,heightCut],clock,limits);
                    if(cut===windowPolygon)removed=layer.operation==='restore'?[]:windowPolygon;
                    else if(cut.length)removed=layer.operation==='subtract'&&!removed.length?cut
                        :yield* booleanSteps(layer.operation==='restore'?'difference':'union',[removed,cut],clock,limits);
                }
            }
            if(!removed.length)return Object.freeze({unchanged:true,triangles:null});
            if(removed===windowPolygon)return Object.freeze({unchanged:false,triangles:[]});
            // Normalize source paths before Boolean composition, then intersect
            // the source triangle only once. Re-intersecting an already clipped
            // sloping edge creates nearly coincident double-precision edges.
            let retained=yield* booleanSteps('difference',[trianglePolygon,removed],clock,limits);
            if(retained.length===1&&retained[0].length===1) {
                const ring=retained[0][0],unique=same(ring[0],ring.at(-1))?ring.slice(0,-1):ring;
                if(unique.length===3&&triangle.every(point=>unique.some(other=>same(point,other))))return Object.freeze({unchanged:true,triangles:null});
            }
            if(storageOrigin&&retained.length) {
                // Normalize at the coordinates the receiver can actually store,
                // before triangulating. Resolving a rounded self-touch can add
                // an intersection; admit at most four normalization passes and
                // 1 mm total displacement, never an unbounded repair/retry loop.
                const maxPasses=4;
                // Keep a bounded numerical counterexample on failure. This
                // travels through the Worker instead of requiring another
                // browser run merely to discover the rejected cell boundary.
                const diagnostic = () => {
                    const copy = polygons => {
                        let count=0;
                        for(const polygon of polygons)for(const ring of polygon)count+=ring.length;
                        return count<=128?polygons.map(polygon=>polygon.map(ring=>ring.map(p=>[...p]))):null;
                    };
                    return {triangle:[a,b,c].map(p=>({...p})),storageOrigin:{...storageOrigin},
                        originX,originZ,retained:copy(retained)};
                };
                // Four normalization operations permit a final stability
                // check. Rejecting immediately after operation four used to
                // reject even a boundary that had just become exactly stored.
                for(let pass=0;pass<=maxPasses;pass++) {
                    const {polygons:stored,moved}=yield* roundTerrainBoundarySteps(retained,{
                        offsetX:originX-storageOrigin.x,offsetZ:originZ-storageOrigin.z,
                        tolerance:storageStepTolerance,clock,limits});
                    if(!moved){retained=stored;break;}
                    if(pass===maxPasses)fail('ground-topology-precision','Terrain storage boundary did not stabilize',
                        {terrainStorage:diagnostic()});
                    // A hole touching the cell boundary can become an outer
                    // notch. Ring counts are not a coverage/topology invariant.
                    retained=yield* booleanSteps('union',[stored],clock,limits);
                }
            }
            const triangles=[];
            for(const polygon of retained)for(const face of yield* triangulatePolygonSteps(polygon,clock,limits)) {
                yield* clock.step('ground-topology-triangles');
                if(triangles.length>=limits.maxOutputTriangles)fail('ground-topology-capacity','Terrain cell exceeds output triangle capacity');
                triangles.push(face.map(p=>({x:p[0]+originX,z:p[1]+originZ})));
            }
            clock.check();return Object.freeze({unchanged:false,triangles});
        },
    });
    return api;
}
