// Opening inputs are complete replacement sets. Dropping a malformed member
// or truncating a full set would publish different visible and physical holes.
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const finite = value => typeof value === 'number' && Number.isFinite(value);

function capture(cuts, maxCuts, fields, valid) {
    if (!Number.isSafeInteger(maxCuts) || maxCuts < 0 || !Array.isArray(cuts)) {
        throw new TypeError('Surface openings require an array and an explicit capacity');
    }
    if (cuts.length > maxCuts) fail('ground-opening-capacity', 'Complete surface opening set exceeds capacity');
    return Object.freeze(cuts.map(cut => {
        if (!fields.every(field => finite(cut?.[field])) || !valid(cut)) {
            fail('ground-opening-coordinate', 'Surface opening requires finite coordinates and positive dimensions');
        }
        return Object.freeze(Object.fromEntries(fields.map(field => [field, cut[field]])));
    }));
}

export function captureSurfaceEntranceCuts(cuts, maxCuts) {
    const shapes = capture(cuts, maxCuts, ['x1', 'z1', 'x2', 'z2', 'widthM'], cut => cut.widthM > 0);
    for (const cut of cuts) if (Object.hasOwn(cut, 'maxY') && !finite(cut.maxY)) {
        fail('ground-opening-coordinate', 'Entrance ceiling must be finite');
    }
    // The planner also distinguishes a station entrance from a surface track.
    // Keep scalar source provenance without retaining mutable input objects.
    return Object.freeze(shapes.map((shape, index) => Object.freeze({ ...shape,
        ...Object.fromEntries(Object.entries(cuts[index]).filter(([key, value]) => !(key in shape)
            && (typeof value === 'string' || finite(value) || typeof value === 'boolean'))) })));
}

export function captureAuthoredOpeningBoxes(cuts, maxCuts) {
    return capture(cuts, maxCuts, ['minX', 'minZ', 'maxX', 'maxZ', 'minY', 'maxY'], cut =>
        cut.maxX > cut.minX && cut.maxZ > cut.minZ && cut.maxY > cut.minY);
}

export function captureAuthoredOpeningRegions(cuts, maxCuts) {
    return Object.freeze(captureAuthoredOpeningBoxes(cuts, maxCuts).map(cut => Object.freeze({
        ring: Object.freeze([[cut.minX,cut.minZ],[cut.maxX,cut.minZ],[cut.maxX,cut.maxZ],[cut.minX,cut.maxZ]]
            .map(([x,z]) => Object.freeze({x,z}))),
        bounds: Object.freeze({minX:cut.minX,minZ:cut.minZ,maxX:cut.maxX,maxZ:cut.maxZ}),
        minY:cut.minY,maxY:cut.maxY,
    })));
}

// Meter-based capsule tessellation for the same station entrance footprint
// used by the analytic shader. Its chord error is explicit and independent of
// texture dimensions. The receiver's separate Float32 check bounds storage.
export function* captureEntranceOpeningRegionsSteps(cuts, {maxCuts,maxVertices,chordErrorM,
    maxY=1,now=()=>performance.now(),isCurrent=()=>true}={}) {
    if(!Number.isSafeInteger(maxVertices)||maxVertices<3||!finite(chordErrorM)||chordErrorM<=0||!finite(maxY)) {
        throw new TypeError('Entrance openings require explicit vertex and meter error limits');
    }
    const shapes=captureSurfaceEntranceCuts(cuts,maxCuts),regions=[];
    let count=0,deadline=now()+.5;
    const check=()=>{if(!isCurrent())fail('ground-opening-stale','Entrance opening inputs were superseded');};
    for(const shape of shapes) {
        check();
        const ceiling = finite(shape.maxY) ? shape.maxY : maxY;
        const radius=shape.widthM*.5,dx=shape.x2-shape.x1,dz=shape.z2-shape.z1,length=Math.hypot(dx,dz);
        const alongX=length?dx/length:1,alongZ=length?dz/length:0;
        // 2r sin²(angle/2) is a stable sagitta bound even for tiny errors.
        const angle=2*Math.asin(Math.sqrt(Math.min(1,chordErrorM/(2*radius))));
        const halfSegments=Math.max(4,Math.ceil(Math.PI/(2*angle)));
        const vertexCount=length?2*(halfSegments+1):2*halfSegments;
        if(!Number.isSafeInteger(vertexCount)||count+vertexCount>maxVertices) {
            fail('ground-opening-capacity','Complete entrance set exceeds its boundary vertex capacity');
        }
        const ring=[],bounds={minX:Infinity,minZ:Infinity,maxX:-Infinity,maxZ:-Infinity};
        for(let end=0;end<2;end++)for(let i=0;i<=halfSegments;i++) {
            if(!length&&i===halfSegments)continue;
            check();
            if(now()>=deadline){yield {phase:'ground-entrance-boundary'};check();deadline=now()+.5;}
            const theta=-Math.PI*.5+end*Math.PI+i*Math.PI/halfSegments;
            const along=Math.cos(theta)*radius,across=Math.sin(theta)*radius;
            const x=(end?shape.x1:shape.x2)+alongX*along-alongZ*across;
            const z=(end?shape.z1:shape.z2)+alongZ*along+alongX*across;
            if(!finite(x)||!finite(z))fail('ground-opening-coordinate','Entrance boundary is not finite');
            ring.push(Object.freeze({x,z}));
            bounds.minX=Math.min(bounds.minX,x);bounds.maxX=Math.max(bounds.maxX,x);
            bounds.minZ=Math.min(bounds.minZ,z);bounds.maxZ=Math.max(bounds.maxZ,z);
        }
        count+=ring.length;
        regions.push(Object.freeze({ring:Object.freeze(ring),bounds:Object.freeze(bounds),
            minY:null,maxY:ceiling,maxYExclusive:true}));
    }
    check();return Object.freeze(regions);
}
