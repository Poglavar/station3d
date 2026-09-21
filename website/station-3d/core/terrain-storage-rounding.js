// Round a planar boundary to its receiver's Float32 coordinates. Endpoints
// alone are insufficient: an edge passing through another vertex's rounding
// cell must also visit that stored vertex. Otherwise rounding can introduce a
// crossing, whose new intersection drifts again on every Boolean/round pass.
// This is local segment noding in storage cells, independent of screen size.
const same=(a,b)=>a[0]===b[0]&&a[1]===b[1];
const key=p=>`${p[0]},${p[1]}`;
// The Boolean kernel (terrain-cutout-topology.js) computes on an integer
// lattice of this pitch, so every union returns vertices re-quantised to it.
// A Float32-exact storage position returns from a union at most half a
// lattice unit away, and that residual is not movement: the Float32 cell is
// 2^-24 relative, twenty-plus bits coarser, and the next Boolean would snap
// the vertex back to the very same lattice point. Reporting it as moved made
// the round/union loop alternate for ever whenever the storage offset itself
// carried bits below the lattice — Float32 vertices plus a double-precision
// origin, which is what a coast collar triangle brings — and the four-pass
// limit rejected the port's whole ground generation (Split, 2026-09-16).
export const TERRAIN_BOOLEAN_LATTICE_M=2**-40;
const bits=new DataView(new ArrayBuffer(4));
const fail=(message)=>{throw Object.assign(new Error(message),{code:'ground-topology-capacity'});};

function cellBounds(value,offset) {
    if(value===0)return [-(2**-150)-offset,2**-150-offset];
    bits.setFloat32(0,value);
    const encoded=bits.getUint32(0),direction=value>0?1:-1;
    bits.setUint32(0,encoded-direction);const previous=bits.getFloat32(0);
    bits.setUint32(0,encoded+direction);const next=bits.getFloat32(0);
    return [value+(previous-value)*.5-offset,value+(next-value)*.5-offset];
}

// Closed-cell clipping includes corner touches. Equal traversal parameters
// are ordered in opposite directions for reversed edges, so both copies of
// a shared edge acquire the same nodes in reverse order.
function visitAt(a,b,cell) {
    let enter=0,leave=1;
    for(let axis=0;axis<2;axis++) {
        const delta=b[axis]-a[axis],lo=cell.bounds[axis][0],hi=cell.bounds[axis][1];
        if(delta===0){if(a[axis]<lo||a[axis]>hi)return null;continue;}
        const t0=(lo-a[axis])/delta,t1=(hi-a[axis])/delta;
        enter=Math.max(enter,Math.min(t0,t1));leave=Math.min(leave,Math.max(t0,t1));
        if(enter>leave)return null;
    }
    return (enter+leave)*.5;
}

export function* roundTerrainBoundarySteps(polygons,{offsetX,offsetZ,tolerance,clock,limits}) {
    const cells=new Map(),storedByPoint=new Map();let moved=false,vertices=0;
    for(const polygon of polygons)for(const ring of polygon)for(const p of ring) {
        yield* clock.step('ground-topology-storage');
        if(++vertices>limits.maxOperandVertices)fail('Terrain storage input exceeds vertex capacity');
        const x=Math.fround(p[0]+offsetX),z=Math.fround(p[1]+offsetZ),q=[x-offsetX,z-offsetZ];
        if(!q.every(Number.isFinite)||Math.hypot(q[0]-p[0],q[1]-p[1])>tolerance) {
            throw Object.assign(new Error('Terrain boundary exceeds the 1 mm storage tolerance'),{code:'ground-topology-precision'});
        }
        moved ||= Math.hypot(q[0]-p[0],q[1]-p[1])>TERRAIN_BOOLEAN_LATTICE_M;
        const id=key(q);storedByPoint.set(p,id);
        if(!cells.has(id))cells.set(id,{id,point:q,bounds:[cellBounds(x,offsetX),cellBounds(z,offsetZ)]});
    }
    // An already stored planar Boolean result requires neither a rewrite nor
    // an additional scan through nearby rounding cells.
    if(!moved)return {polygons,moved:false};
    const stored=[];let outputVertices=0;
    for(const polygon of polygons) {
        const rings=[];
        for(const ring of polygon) {
            const points=[],end=ring.length>1&&same(ring[0],ring.at(-1))?ring.length-1:ring.length;
            function append(point) {
                if(points.length&&same(points.at(-1),point))return;
                if(++outputVertices>limits.maxOperandVertices)fail('Terrain storage noding exceeds vertex capacity');
                points.push(point);
            }
            for(let i=0;i<end;i++) {
                const a=ring[i],b=ring[(i+1)%end],aId=storedByPoint.get(a),bId=storedByPoint.get(b);
                append(cells.get(aId).point);
                if(aId===bId)continue;
                const visits=[];
                for(const cell of cells.values()) {
                    yield* clock.step('ground-topology-storage-noding');
                    if(cell.id===aId||cell.id===bId)continue;
                    const at=visitAt(a,b,cell);if(at===null)continue;
                    // Every added node lies within the same displacement
                    // allowance as ordinary vertex rounding. Never admit a
                    // large-coordinate cell just because an edge crosses it.
                    const dx=b[0]-a[0],dz=b[1]-a[1];
                    const t=Math.max(0,Math.min(1,((cell.point[0]-a[0])*dx+(cell.point[1]-a[1])*dz)/(dx*dx+dz*dz)));
                    if(Math.hypot(cell.point[0]-a[0]-t*dx,cell.point[1]-a[1]-t*dz)>tolerance) {
                        throw Object.assign(new Error('Terrain storage node exceeds the 1 mm storage tolerance'),{code:'ground-topology-precision'});
                    }
                    visits.push({at,cell});
                }
                const direction=a[0]===b[0]?Math.sign(b[1]-a[1]):Math.sign(b[0]-a[0]);
                visits.sort((p,q)=>p.at-q.at||direction*(p.cell.point[0]-q.cell.point[0]||p.cell.point[1]-q.cell.point[1]));
                for(const {cell} of visits)append(cell.point);
            }
            if(points.length>1&&same(points[0],points.at(-1)))points.pop();
            const area=points.reduce((sum,p,i)=>{
                const a=points[0],b=points[(i+1)%points.length];
                return sum+(p[0]-a[0])*(b[1]-a[1])-(p[1]-a[1])*(b[0]-a[0]);
            },0);
            // Original input openings/islands are checked before composition.
            // Derived sub-ULP residuals can have no area in this storage domain.
            if(points.length<3||area===0){if(!rings.length)break;continue;}
            rings.push(points);
        }
        if(rings.length)stored.push(rings);
    }
    return {polygons:stored,moved:true};
}
