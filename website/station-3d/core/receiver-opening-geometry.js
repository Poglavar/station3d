// Clip a detached receiver once, before its visible and support buffers split.
// Distant openings reuse the original arrays; capacities bound actual output,
// and cancellation leaves the active receiver entirely untouched.
import { clipReceiverGeometrySteps } from './terrain-receiver-topology.js';

export function* clipReceiverOpeningsSteps({geometry,openingRead,claim,bounds=null,
    originX=0,originY=0,originZ=0,worldMatrix=null,maxVertices,maxTriangles,
    now=()=>performance.now(),isCurrent=()=>true}={}) {
    if (openingRead?.contract!=='station3d-surface-opening-read-v1' || typeof openingRead.isCurrent!=='function'
        || !Number.isSafeInteger(maxVertices) || maxVertices<3 || !Number.isSafeInteger(maxTriangles) || maxTriangles<1) {
        throw new TypeError('Receiver opening preparation requires a captured read and explicit capacities');
    }
    const current=()=>isCurrent()&&openingRead.isCurrent();
    const check=()=>{if(!current())throw Object.assign(new Error('Receiver openings were superseded'),{code:'ground-opening-stale'});};
    check();
    if(openingRead.empty)return geometry;
    const positions=geometry?.positions;
    if(!ArrayBuffer.isView(positions)||positions.length%3||positions.length/3>maxVertices) {
        throw Object.assign(new Error('Opening receiver source exceeds its vertex capacity'),{code:'ground-opening-capacity'});
    }
    const triangleCount=(geometry.indices?.length??positions.length/3)/3;
    if(!Number.isInteger(triangleCount)||triangleCount>maxTriangles)throw Object.assign(
        new Error('Opening receiver source exceeds its triangle capacity'),{code:'ground-opening-capacity'});
    if(!triangleCount)return geometry;
    let topology=openingRead.topologyForClaim(claim);
    if(worldMatrix && (worldMatrix.length!==16 || ![...worldMatrix].every(Number.isFinite)
        || originX!==0 || originY!==0 || originZ!==0))throw new TypeError('Invalid receiver world transform');
    const world=worldMatrix ? p=>({
        x:worldMatrix[0]*p.x+worldMatrix[4]*p.y+worldMatrix[8]*p.z+worldMatrix[12],
        y:worldMatrix[1]*p.x+worldMatrix[5]*p.y+worldMatrix[9]*p.z+worldMatrix[13],
        z:worldMatrix[2]*p.x+worldMatrix[6]*p.y+worldMatrix[10]*p.z+worldMatrix[14],
    }) : p=>p;
    // Existing compiler bounds avoid another vertex pass. A buffer without
    // those bounds is scanned cooperatively, never in the publication hook.
    if(!bounds) {
        bounds={minX:Infinity,minY:Infinity,minZ:Infinity,maxX:-Infinity,maxY:-Infinity,maxZ:-Infinity};
        let deadline=now()+.5;
        for(let i=0;i<positions.length;i+=3) {
            if(now()>=deadline){yield {phase:'ground-opening-buffer-bounds'};check();deadline=now()+.5;}
            const {x,y,z}=world({x:positions[i]+originX,y:positions[i+1]+originY,z:positions[i+2]+originZ});
            bounds.minX=Math.min(bounds.minX,x);bounds.maxX=Math.max(bounds.maxX,x);
            bounds.minY=Math.min(bounds.minY,y);bounds.maxY=Math.max(bounds.maxY,y);
            bounds.minZ=Math.min(bounds.minZ,z);bounds.maxZ=Math.max(bounds.maxZ,z);
        }
    }
    if(!(yield* topology.intersectsBoundsSteps(bounds))){check();return geometry;}
    if(worldMatrix) {
        const worldTopology=topology;
        // Intersect in world metres, retain source-local storage and attributes.
        // The clipper's barycentric provenance maps every new boundary point
        // back to its original face without another world Float32 round trip.
        topology={contract:worldTopology.contract,*clipTriangleSteps(a,b,c) {
            const clipped=yield* worldTopology.clipTriangleSteps(world(a),world(b),world(c));
            if(clipped.unchanged)return clipped;
            const triangles=[];
            let deadline=now()+.5;
            for(const face of clipped.triangles) {
                const local=[];
                for(const p of face) {
                    if(now()>=deadline){yield {phase:'receiver-opening-local-provenance'};check();deadline=now()+.5;}
                    const [wa,wb,wc]=p.weights;
                    local.push({...p,x:wa*a.x+wb*b.x+wc*c.x,y:wa*a.y+wb*b.y+wc*c.y,z:wa*a.z+wb*b.z+wc*c.z});
                }
                // Integer clipping can return the same quantized world point
                // twice with independently solved barycentric weights. Mapping
                // those weights back through a transformed source face leaves
                // a ~1e-11 m double-precision difference, which is not a real
                // triangle and necessarily collapses in Float32. Remove only
                // this numerical duplicate here; representable thin openings
                // still reach the receiver's fail-closed storage validation.
                const duplicateVertex=local.some((point,index)=>local.slice(index+1).some(other=>(
                    (point.x-other.x)**2+(point.y-other.y)**2+(point.z-other.z)**2<=1e-18
                )));
                if(duplicateVertex)continue;
                triangles.push(local);
            }
            check();return {...clipped,triangles};
        }};
    }
    return yield* clipReceiverGeometrySteps({geometry,topology,originX,originY,originZ,
        maxVertices,maxTriangles,now,isCurrent:current});
}
