// Build bounded physics chunks from the actual published terrain receiver.
// Source-face offsets select only nearby lattice cells, including their cuts.

const finite=value=>typeof value==='number'&&Number.isFinite(value);
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};

export function* buildTerrainReceiverSupportSteps({tiles,bounds,originX=0,originZ=0,limits,
    evidenceSceneYAtLocal=null,now=()=>performance.now(),isCurrent=()=>true}={}) {
    if(evidenceSceneYAtLocal!==null&&typeof evidenceSceneYAtLocal!=='function')throw new TypeError('Terrain evidence requires a captured query');
    for(const key of ['maxTiles','maxSourceCells','maxTriangles','maxMeshes','maxTrianglesPerMesh']) {
        if(!Number.isSafeInteger(limits?.[key])||limits[key]<1)throw new TypeError(`Explicit terrain support limit required: ${key}`);
    }
    if(!Array.isArray(tiles)||tiles.length>limits.maxTiles)fail('terrain-support-capacity','Terrain support exceeds its tile capacity');
    if(![bounds?.minX,bounds?.maxX,bounds?.minZ,bounds?.maxZ,originX,originZ].every(finite)
        ||bounds.minX>=bounds.maxX||bounds.minZ>=bounds.maxZ)throw new TypeError('Terrain support requires finite bounds');
    let deadline=now()+.5,visitedCells=0,totalTriangles=0;
    const check=()=>{if(!isCurrent())fail('terrain-support-stale','Terrain support input was superseded');};
    function* budget(phase){check();if(now()>=deadline){yield {phase};check();deadline=now()+.5;}}
    check();
    const tileM=tiles[0]?.tileM,keys=new Set();
    if(!finite(tileM)||tileM<=0)fail('terrain-support-missing','Terrain support has no published receiver coverage');
    for(const tile of tiles) {
        yield* budget('terrain-support-coverage');
        const key=`${tile.tileX}_${tile.tileZ}`;
        if(tile.tileM!==tileM||keys.has(key))throw new TypeError('Terrain support requires unique tiles in one metre grid');
        keys.add(key);
    }
    const firstX=Math.floor(bounds.minX/tileM),lastX=Math.ceil(bounds.maxX/tileM)-1;
    const firstZ=Math.floor(bounds.minZ/tileM),lastZ=Math.ceil(bounds.maxZ/tileM)-1;
    if(![firstX,lastX,firstZ,lastZ].every(Number.isSafeInteger)
        ||(lastX-firstX+1)*(lastZ-firstZ+1)>limits.maxTiles)fail('terrain-support-capacity','Terrain support coverage exceeds tile capacity');
    for(let z=firstZ;z<=lastZ;z++)for(let x=firstX;x<=lastX;x++) {
        yield* budget('terrain-support-coverage');
        if(!keys.has(`${x}_${z}`))fail('terrain-support-missing','Terrain support lacks a published receiver tile');
    }
    const meshes=[];
    let vertices=null,indices=null,vertexCount=0,indexCount=0,byGeometry=new Map();
    function finish() {
        if(!indexCount)return;
        meshes.push({vertices:vertices.subarray(0,vertexCount*3),indices:indices.subarray(0,indexCount)});
        vertices=null;indices=null;vertexCount=0;indexCount=0;byGeometry=new Map();
    }
    for(const tile of tiles) {
        yield* budget('terrain-support-tile');
        const {tileX,tileZ,tileM,segments,receiver}=tile;
        if(!Number.isSafeInteger(tileX)||!Number.isSafeInteger(tileZ)||!finite(tileM)||tileM<=0
            ||!Number.isSafeInteger(segments)||segments<1
            ||!(receiver?.positions instanceof Float32Array)
            ||!(receiver.indices instanceof Uint32Array||receiver.indices instanceof Uint16Array)) {
            throw new TypeError('Terrain support requires a validated receiver tile');
        }
        const x0=tileX*tileM,z0=tileZ*tileM,step=tileM/segments;
        const minColumn=Math.max(0,Math.floor((bounds.minX-x0)/step));
        const maxColumn=Math.min(segments-1,Math.ceil((bounds.maxX-x0)/step)-1);
        const minRow=Math.max(0,Math.floor((bounds.minZ-z0)/step));
        const maxRow=Math.min(segments-1,Math.ceil((bounds.maxZ-z0)/step)-1);
        const columns=maxColumn-minColumn+1,rows=maxRow-minRow+1;
        if(columns<=0||rows<=0)continue;
        if(visitedCells+columns*rows>limits.maxSourceCells)fail('terrain-support-capacity','Terrain support exceeds its source cell capacity');
        // Only the selected rectangle needs evidence flags. Its (c+1)(r+1)
        // bytes are at most four per admitted source cell, independent of the
        // full tile size. Each lattice knot is sampled once across both faces.
        const known=evidenceSceneYAtLocal?new Uint8Array((columns+1)*(rows+1)):null;
        const {positions,indices:sourceIndices,sourceTriangleOffsets}=receiver;
        if(sourceTriangleOffsets
            ? !(sourceTriangleOffsets instanceof Uint32Array)||sourceTriangleOffsets.length!==segments*segments*2+1
                ||sourceTriangleOffsets[0]!==0||sourceTriangleOffsets.at(-1)!==sourceIndices.length
            : sourceIndices.length!==segments*segments*6)throw new TypeError('Terrain receiver has an invalid lattice index');
        for(let row=minRow;row<=maxRow;row++)for(let column=minColumn;column<=maxColumn;column++) {
            yield* budget('terrain-support-cell');
            if(++visitedCells>limits.maxSourceCells)fail('terrain-support-capacity','Terrain support exceeds its source cell capacity');
            const face=(row*segments+column)*2;
            const start=sourceTriangleOffsets?sourceTriangleOffsets[face]:face*3;
            const end=sourceTriangleOffsets?sourceTriangleOffsets[face+2]:(face+2)*3;
            if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<start||end>sourceIndices.length) {
                throw new TypeError('Terrain receiver has invalid source-face offsets');
            }
            if(known&&end>start)for(const [dc,dr]of [[0,0],[1,0],[0,1],[1,1]]) {
                yield* budget('terrain-support-evidence');
                const index=(row+dr-minRow)*(columns+1)+column+dc-minColumn;
                if(known[index])continue;
                if(!finite(evidenceSceneYAtLocal(x0+(column+dc)*step,z0+(row+dr)*step))) {
                    fail('terrain-support-evidence-unavailable','Visible terrain fallback cannot become physical support');
                }
                known[index]=1;
            }
            for(let offset=start;offset<end;offset+=3) {
                yield* budget('terrain-support-triangle');
                if(++totalTriangles>limits.maxTriangles)fail('terrain-support-capacity','Terrain support exceeds its triangle capacity');
                if(!vertices) {
                    if(meshes.length>=limits.maxMeshes)fail('terrain-support-capacity','Terrain support exceeds its mesh capacity');
                    vertices=new Float32Array(limits.maxTrianglesPerMesh*9);
                    indices=new Uint32Array(limits.maxTrianglesPerMesh*3);
                }
                let remap=byGeometry.get(receiver);
                if(!remap)byGeometry.set(receiver,remap=new Map());
                for(let corner=0;corner<3;corner++) {
                    const sourceIndex=sourceIndices[offset+corner];
                    if(!Number.isInteger(sourceIndex)||sourceIndex<0||sourceIndex*3+2>=positions.length) {
                        throw new TypeError('Terrain receiver has an invalid vertex index');
                    }
                    let index=remap.get(sourceIndex);
                    if(index===undefined) {
                        const sourceOffset=sourceIndex*3;
                        const x=positions[sourceOffset]+x0-originX,y=positions[sourceOffset+1],z=positions[sourceOffset+2]+z0-originZ;
                        if(![x,y,z].every(finite))throw new TypeError('Terrain receiver has an absent coordinate');
                        index=vertexCount++;remap.set(sourceIndex,index);
                        vertices.set([x,y,z],index*3);
                        if(Math.hypot(vertices[index*3]-x,vertices[index*3+2]-z)>.001) {
                            fail('terrain-support-precision','Terrain support origin exceeds the 1 mm storage tolerance');
                        }
                    }
                    indices[indexCount++]=index;
                }
                if(indexCount===indices.length)finish();
            }
        }
    }
    check();finish();
    // Empty is a valid, completely cut receiver, distinct from missing tiles.
    return {meshes,visitedCells,triangles:totalTriangles};
}
