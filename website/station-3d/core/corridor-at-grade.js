// Pure corridor-segment collection for the photoreal corridor cut. Two
// regimes exist:
//  - LEVELS features (planner levels x 10 m, or 2D consensus/OSM): earthworks
//    only make sense where the track is at grade — spans at other levels carry
//    their own designed structures (viaduct decks, tunnel tubes), so their
//    segments must not produce a spurious surface trench. collectAtGradeCorridor
//    keeps only segments whose BOTH endpoints are within epsM of grade.
//  - ASL features (authored vertical profiles): c[2] is the immutable designed
//    elevation in one session frame. Photoreal terrain only classifies/dresses
//    cuts, tunnels, decks and piers around it at runtime, so every segment is
//    kept with its endpoint elevations (collectFullCorridor).
// Segments are [ax, az, bx, bz, ya, yb]; disc centers are [x, z, y].

function elevationOf(point) {
    const elev = Number(point && point[2]);
    return Number.isFinite(elev) ? elev : 0;
}

// pts = [[x, z, elevM], ...] — one polyline in the local frame. A segment is
// kept iff BOTH endpoints are within epsM of grade (a ramp chord straddling
// the threshold is earthwork the designed ramp fill already models). Missing
// or non-finite elevation counts as 0, so 2D consensus/OSM features pass
// through unchanged. Disc centers are the at-grade vertices — the round joins
// between kept segments, doubling as round end caps where the clip stops.
export function collectAtGradeCorridor(pts, epsM) {
    const segs = [];
    const discCenters = [];
    if (!Array.isArray(pts)) return { segs, discCenters };
    const atGrade = pts.map((p) => Math.abs(elevationOf(p)) <= epsM);
    for (let i = 0; i < pts.length - 1; i++) {
        if (atGrade[i] && atGrade[i + 1]) {
            segs.push([
                pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1],
                elevationOf(pts[i]), elevationOf(pts[i + 1]),
            ]);
        }
    }
    for (let i = 0; i < pts.length; i++) {
        if (atGrade[i]) discCenters.push([pts[i][0], pts[i][1], elevationOf(pts[i])]);
    }
    return { segs, discCenters };
}

// ASL features: keep everything, elevations included.
export function collectFullCorridor(pts) {
    const segs = [];
    const discCenters = [];
    if (!Array.isArray(pts)) return { segs, discCenters };
    for (let i = 0; i < pts.length - 1; i++) {
        segs.push([
            pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1],
            elevationOf(pts[i]), elevationOf(pts[i + 1]),
        ]);
    }
    for (const p of pts) discCenters.push([p[0], p[1], elevationOf(p)]);
    return { segs, discCenters };
}
