// Apply a captured cutout topology to the exact source triangles. Both the
// visible receiver and physics call this compiler; boundary heights/attributes
// are interpolated on their source face, not resampled from a different DTM.
import { createReceiverSourceVertexIdsSteps, createReceiverTopologyVertexIdsSteps } from './receiver-connectivity.js';
import { createReceiverEdgeSplitReadSteps } from './receiver-edge-conformity.js';
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const cross=(a,b,c)=>(b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x);
const normal=(a,b,c)=>[(b.y-a.y)*(c.z-a.z)-(b.z-a.z)*(c.y-a.y),
    (b.z-a.z)*(c.x-a.x)-(b.x-a.x)*(c.z-a.z),(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x)];
// A failure names where it happened: an unlocatable rejection cost days at Split.
const fail=(code,message,details=null)=>{throw Object.assign(new Error(details?`${message} at ${details.x?.toFixed?.(3)},${details.z?.toFixed?.(3)}`:message),details?{code,details}:{code});};

// `overlappingFaces` declares a receiver whose faces may cover the same plan
// point at different heights by design (the coast collar's extended quads fan
// across each other at bends; its sampler picks the upper face). Such a sheet
// keeps one vertex per distinct height at a shared cut point instead of being
// rejected as a seam fault, which a manifold receiver still is.
export function* clipReceiverGeometrySteps({geometry,topology,originX=0,originY=0,originZ=0,
    maxVertices,maxTriangles,now=()=>performance.now(),isCurrent=()=>true,overlappingFaces=false}={}) {
    const volume=topology?.contract==='station3d-surface-opening-topology-v1';
    if(!volume&&topology?.contract!=='station3d-terrain-cutout-topology-v1'||typeof topology.clipTriangleSteps!=='function') {
        throw new TypeError('Receiver requires captured cutout topology');
    }
    if(!Number.isSafeInteger(maxVertices)||maxVertices<3||!Number.isSafeInteger(maxTriangles)||maxTriangles<1) {
        throw new TypeError('Terrain receiver requires explicit output capacities');
    }
    const source=geometry?.positions,indices=geometry?.indices??null;
    if(!ArrayBuffer.isView(source)||source.length%3||(indices!==null&&(!ArrayBuffer.isView(indices)||indices.length%3))
        ||!finite(originX)||!finite(originY)||!finite(originZ))throw new TypeError('Invalid indexed receiver');
    const sourceCount=source.length/3;
    const sourceIndexCount=indices?.length??sourceCount;
    if(sourceIndexCount%3)throw new TypeError('Nonindexed receiver requires complete triangles');
    if(sourceCount>maxVertices||sourceIndexCount/3>maxTriangles)fail('ground-topology-capacity','Terrain source exceeds mesh capacity');
    const attributes=[['positions',3]];
    for(const [name,size] of [['normals',3],['uvs',2],['colors',3]])if(geometry[name]) {
        if(!ArrayBuffer.isView(geometry[name])||geometry[name].length!==sourceCount*size)throw new TypeError(`Invalid terrain ${name}`);
        attributes.push([name,size]);
    }
    let deadline=now()+.5;
    function check(){if(!isCurrent())fail('ground-topology-stale','Terrain receiver preparation was superseded');}
    function* budget(phase){check();if(now()>=deadline){yield {phase};check();deadline=now()+.5;}}
    if(!volume&&sourceCount&&typeof topology.prepareReceiverStorageSteps==='function') {
        const bounds={minX:Infinity,minZ:Infinity,maxX:-Infinity,maxZ:-Infinity};
        for(let i=0;i<source.length;i+=3) {
            yield* budget('ground-topology-storage-bounds');
            const x=source[i]+originX,z=source[i+2]+originZ;
            if(!finite(x)||!finite(z))fail('ground-topology-coordinate','Terrain source triangle lacks evidence');
            bounds.minX=Math.min(bounds.minX,x);bounds.maxX=Math.max(bounds.maxX,x);
            bounds.minZ=Math.min(bounds.minZ,z);bounds.maxZ=Math.max(bounds.maxZ,z);
        }
        topology=yield* topology.prepareReceiverStorageSteps({bounds,storageOrigin:{x:originX,z:originZ},now,isCurrent});
    }
    let outputIndices=null,sourceTriangleOffsets=null,indexCount=0,vertexCount=sourceCount,output=null,changedTriangles=0,degenerateSourceTriangles=0;
    let conformityAddedTriangles=0,edgeOnlyFragments=0;
    const boundaryVertices=new Map();
    function* copy(target,values,length=values.length) {
        // A copy item is at most 16 KiB; the complete tile is never one copy.
        for(let offset=0;offset<length;offset+=4096) {
            yield* budget('ground-topology-buffer-copy');
            target.set(values.subarray(offset,Math.min(offset+4096,length)),offset);
        }
    }
    function* ensureIndices(beforeOffset) {
        if(outputIndices)return;
        outputIndices=new Uint32Array(Math.min(maxTriangles,Math.max(16,sourceIndexCount/3))*3);
        if(indices)yield* copy(outputIndices,indices,beforeOffset);
        else for(let offset=0;offset<beforeOffset;offset++) {
            if(offset%4096===0)yield* budget('ground-topology-source-index');
            outputIndices[offset]=offset;
        }
        indexCount=beforeOffset;
        sourceTriangleOffsets=new Uint32Array(sourceIndexCount/3+1);
        for(let face=0;face<=beforeOffset/3;face++) {
            yield* budget('ground-topology-source-index');
            sourceTriangleOffsets[face]=face*3;
        }
    }
    function* ensureAttributes() {
        const capacity=output?.positions.length/3||0;
        if(capacity>vertexCount)return;
        const nextCapacity=Math.min(maxVertices,Math.max(vertexCount+1,32,Math.ceil(capacity*1.5)));
        const previous=output;
        output={};
        for(const [name,size] of attributes) {
            yield* budget('ground-topology-buffer-allocation');
            output[name]=new Float32Array(nextCapacity*size);
            yield* copy(output[name],previous?.[name]||geometry[name],vertexCount*size);
        }
    }
    const point=index=>({x:source[index*3]+originX,y:source[index*3+1]+originY,z:source[index*3+2]+originZ});
    function* append(a,b,c,expectedWinding,preserveDegenerateSource=false,sourceTriangle=null,exactFace=null) {
        if(indexCount+3>maxTriangles*3)fail('ground-topology-capacity','Terrain cutout exceeds mesh triangle capacity');
        if(indexCount+3>outputIndices.length) {
            const nextCapacity=Math.min(maxTriangles,Math.max(indexCount/3+1,Math.ceil(outputIndices.length/3*1.5)));
            const previous=outputIndices;
            yield* budget('ground-topology-buffer-allocation');
            outputIndices=new Uint32Array(nextCapacity*3);
            yield* copy(outputIndices,previous,indexCount);
        }
        const positions=output?.positions||source;
        const xz=index=>({x:positions[index*3],z:positions[index*3+2]});
        const xyz=index=>({...xz(index),y:positions[index*3+1]});
        const area=volume?normal(xyz(a),xyz(b),xyz(c)).reduce((sum,value,i)=>sum+value*expectedWinding[i],0)
            :cross(xz(a),xz(b),xz(c))*Math.sign(expectedWinding);
        if(!finite(area)||(area<=0&&!preserveDegenerateSource)) {
            fail('ground-topology-precision','Float32 receiver storage collapses or reverses a clipped face',{
                x:(xyz(a).x+xyz(b).x+xyz(c).x)/3,
                z:(xyz(a).z+xyz(b).z+xyz(c).z)/3,
                sourceTriangle,
                storedFace:[xyz(a),xyz(b),xyz(c)],
                exactFace:exactFace?.map(point=>({x:point.x,y:point.y,z:point.z,
                    ...(Array.isArray(point.weights)?{weights:point.weights.slice()}:{}),
                }))||null,
                expectedWinding:Array.isArray(expectedWinding)?expectedWinding.slice():expectedWinding,
                storedWinding:area,
            });
        }
        outputIndices[indexCount++]=a;outputIndices[indexCount++]=b;outputIndices[indexCount++]=c;
    }
    for(let offset=0;offset<sourceIndexCount;offset+=3) {
        yield* budget('ground-topology-source-triangles');
        const ids=indices?[indices[offset],indices[offset+1],indices[offset+2]]:[offset,offset+1,offset+2];
        if(ids.some(i=>!Number.isInteger(i)||i<0||i>=sourceCount))throw new TypeError('Invalid terrain vertex index');
        const [a,b,c]=ids.map(point),denominator=cross(a,b,c);
        const winding=volume?normal(a,b,c):denominator;
        if(![a,b,c].every(p=>finite(p.x)&&finite(p.y)&&finite(p.z)))fail('ground-topology-coordinate','Terrain source triangle lacks evidence');
        // Refined source rings can already contain coincident-vertex faces.
        // They draw no area but retain indexed boundary connectivity. Preserve
        // those exact source indices; only newly clipped faces must have area.
        // This is an exact 3D test, so a vertical wall is never mistaken for an
        // empty face. Nonzero faces still use the strict storage validation.
        const degenerateSource=volume&&winding.every(value=>value===0);
        if(degenerateSource)degenerateSourceTriangles++;
        const clipped=degenerateSource?{unchanged:true}:yield* topology.clipTriangleSteps(a,b,c,{now,isCurrent,storageOrigin:{x:originX,z:originZ}});
        if(clipped.unchanged) {
            if(outputIndices){yield* append(...ids,winding,degenerateSource,offset/3);sourceTriangleOffsets[offset/3+1]=indexCount;}
            continue;
        }
        if(volume?winding.every(value=>value===0):denominator===0)fail('ground-topology-triangulation','Cannot clip a degenerate receiver triangle');
        changedTriangles++;
        yield* ensureIndices(offset);
        for(const face of clipped.triangles) {
            const faceIds=[];
            for(const p of face) {
                yield* budget('ground-topology-boundary-vertices');
                const original=[a,b,c].findIndex(q=>p.x===q.x&&p.z===q.z&&(!volume||p.y===q.y));
                if(original>=0){faceIds.push(ids[original]);continue;}
                const x=Math.fround(p.x-originX),z=Math.fround(p.z-originZ);
                // Evaluate at the actual stored XZ. Float32 rounding must not
                // move a vertex horizontally while retaining an unrelated Y.
                const q={x:x+originX,z:z+originZ};
                if(Math.hypot(q.x-p.x,q.z-p.z)>.001)fail('ground-topology-precision','Terrain boundary exceeds the 1 mm storage tolerance');
                const wa=volume?p.weights[0]:cross(q,b,c)/denominator;
                const wb=volume?p.weights[1]:cross(a,q,c)/denominator,wc=volume?p.weights[2]:1-wa-wb;
                const y=Math.fround((volume?p.y:wa*a.y+wb*b.y+wc*c.y)-originY);
                // Reuse vertices only across the same source edge/face. Two
                // coincident authored walls can have different normals/UVs.
                const sourceIds=volume?ids.filter((_,i)=>p.weights[i]!==0).sort((a,b)=>a-b):null;
                const key=volume?`${sourceIds.join(':')}|${x},${y},${z}`:`${x},${z}`;
                if(volume&&Math.hypot(q.x-p.x,y+originY-p.y,q.z-p.z)>.001) {
                    fail('ground-topology-precision','Opening boundary exceeds the 1 mm storage tolerance');
                }
                if(!finite(y))fail('ground-topology-coordinate','Terrain boundary interpolation failed');
                let mapKey=key;
                if(boundaryVertices.has(key)) {
                    const {index}=boundaryVertices.get(key);
                    if(Math.abs(output.positions[index*3+1]-y)<=.001){faceIds.push(index);continue;}
                    if(!overlappingFaces)fail('ground-topology-seam','Receiver faces disagree at a shared cut boundary',{x:q.x,z:q.z,y:y+originY,existingY:output.positions[index*3+1]+originY,sourceTriangle:offset/3});
                    mapKey=`${key}|${y}`;
                    if(boundaryVertices.has(mapKey)){faceIds.push(boundaryVertices.get(mapKey).index);continue;}
                }
                if(vertexCount>=maxVertices)fail('ground-topology-capacity','Terrain cutout exceeds mesh vertex capacity');
                yield* ensureAttributes();
                const index=vertexCount++;
                output.positions.set([x,y,z],index*3);
                for(const [name,size] of attributes)if(name!=='positions')for(let k=0;k<size;k++) {
                    output[name][index*size+k]=wa*geometry[name][ids[0]*size+k]
                        +wb*geometry[name][ids[1]*size+k]+wc*geometry[name][ids[2]*size+k];
                }
                boundaryVertices.set(mapKey,{index,sourceIds});faceIds.push(index);
            }
            // The topology validator uses positive XZ winding. Keep the
            // source receiver's actual face orientation, including upward Y.
            if(!volume&&denominator<0)[faceIds[1],faceIds[2]]=[faceIds[2],faceIds[1]];
            // Integer Boolean projection can triangulate a sliver between
            // points which all belong to one exact source edge. Float32 can
            // even give that sliver apparent area. Its barycentric provenance
            // proves it is only an edge: retain its vertices as conformity
            // constraints, but never turn it into an extra surface face.
            if(volume&&[0,1,2].some(i=>face.every(p=>p.weights[i]===0))) {
                edgeOnlyFragments++;continue;
            }
            yield* append(...faceIds,winding,false,offset/3,face);
        }
        sourceTriangleOffsets[offset/3+1]=indexCount;
    }
    const sourceVertexIds=volume?yield* createReceiverSourceVertexIdsSteps({geometry,now,isCurrent}):null;
    if(volume&&outputIndices&&boundaryVertices.size) {
        const splits=yield* createReceiverEdgeSplitReadSteps({geometry,boundaryVertices,sourceVertexIds,
            positions:()=>output?.positions||source,now,isCurrent});
        if(splits) {
            const previousIndices=outputIndices,previousCount=indexCount,previousOffsets=sourceTriangleOffsets;
            yield* budget('ground-topology-buffer-allocation');
            outputIndices=new Uint32Array(previousIndices.length);indexCount=0;
            sourceTriangleOffsets=new Uint32Array(previousOffsets.length);
            function* edgeVertex(pointIndex,edge,faceIds) {
                const ids=edge.ids.map(id=>faceIds.find(candidate=>splits.canonical(candidate)===id)).sort((a,b)=>a-b);
                if(ids.some(id=>id===undefined))fail('ground-topology-seam','Receiver split has no source edge');
                const positions=output?.positions||source;
                const p=[0,1,2].map(k=>positions[pointIndex*3+k]);
                const key=`${ids.join(':')}|${p.join(',')}`;
                if(boundaryVertices.has(key))return boundaryVertices.get(key).index;
                if(vertexCount>=maxVertices)fail('ground-topology-capacity','Terrain edge conformity exceeds mesh vertex capacity');
                const delta=[0,1,2].map(k=>source[ids[1]*3+k]-source[ids[0]*3+k]);
                const lengthSquared=delta.reduce((sum,value)=>sum+value*value,0);
                const t=delta.reduce((sum,value,k)=>sum+value*(p[k]-source[ids[0]*3+k]),0)/lengthSquared;
                if(!finite(t)||t<0||t>1)fail('ground-topology-seam','Receiver split lies outside its source edge');
                yield* ensureAttributes();
                const index=vertexCount++;
                output.positions.set(p,index*3);
                for(const [name,size] of attributes)if(name!=='positions')for(let k=0;k<size;k++) {
                    output[name][index*size+k]=(1-t)*geometry[name][ids[0]*size+k]+t*geometry[name][ids[1]*size+k];
                }
                boundaryVertices.set(key,{index,sourceIds:ids});splits.registerVertex(index,ids);
                return index;
            }
            for(let face=0;face<sourceIndexCount/3;face++) {
                yield* budget('ground-topology-edge-conformity');
                const sourceIds=indices?[indices[face*3],indices[face*3+1],indices[face*3+2]]:[face*3,face*3+1,face*3+2];
                const winding=normal(...sourceIds.map(point)),degenerate=winding.every(value=>value===0);
                for(let offset=previousOffsets[face];offset<previousOffsets[face+1];offset+=3) {
                    const pending=[[previousIndices[offset],previousIndices[offset+1],previousIndices[offset+2]]];
                    while(pending.length) {
                        yield* budget('ground-topology-edge-conformity');
                        const triangle=pending.pop();let divided=false;
                        if(!degenerate)for(let edgeIndex=0;edgeIndex<3;edgeIndex++) {
                            const a=triangle[edgeIndex],b=triangle[(edgeIndex+1)%3],c=triangle[(edgeIndex+2)%3];
                            const split=splits.split(a,b);if(!split)continue;
                            const count=split.to-split.from;
                            if(indexCount/3+pending.length+count+1>maxTriangles)fail('ground-topology-capacity',
                                'Terrain edge conformity exceeds mesh triangle capacity');
                            let previous=a;
                            for(let at=0;at<count;at++) {
                                yield* budget('ground-topology-edge-conformity');
                                const node=split.edge.points[split.forward?split.from+at:split.to-1-at];
                                const current=yield* edgeVertex(node.index,split.edge,sourceIds);
                                pending.push([previous,current,c]);previous=current;
                            }
                            pending.push([previous,b,c]);divided=true;break;
                        }
                        if(!divided)yield* append(...triangle,winding,degenerate);
                    }
                }
                sourceTriangleOffsets[face+1]=indexCount;
            }
            conformityAddedTriangles=indexCount/3-previousCount/3;
        }
    }
    check();
    // A subarray retains/transfers its entire backing allocation. Compact
    // before the Worker transfer so a capacity ceiling never becomes retained
    // memory for every terrain tile. Copies remain cooperatively bounded.
    function* compact(values,length) {
        if(values.length===length)return values;
        yield* budget('ground-topology-buffer-allocation');
        const result=new values.constructor(length);
        yield* copy(result,values,length);
        return result;
    }
    const result={...geometry,indices:outputIndices?yield* compact(outputIndices,indexCount):indices,sourceTriangleOffsets};
    if(output)for(const [name,size] of attributes)result[name]=yield* compact(output[name],vertexCount*size);
    if(volume)result.topologyVertexIds=yield* createReceiverTopologyVertexIdsSteps({geometry,positions:result.positions,
        boundaryVertices,sourceVertexIds,now,isCurrent});
    result.topology=Object.freeze({changedTriangles,degenerateSourceTriangles,edgeOnlyFragments,conformityAddedTriangles,sourceTriangles:sourceIndexCount/3,
        triangles:(result.indices?.length??sourceIndexCount)/3,addedVertices:vertexCount-sourceCount});
    return result;
}
