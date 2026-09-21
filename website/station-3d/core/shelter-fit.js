// Fits an oriented rectangle to a shelter footprint ring: centre, heading and
// plan dimensions in local scene metres. The footprint is OSM-mapped and can
// be slightly ragged; the fit takes the longest edge as the shelter's long
// axis and the projected extents as its size, which is exact for the
// rectangles these almost always are and sane for anything else.

const DEG_TO_RAD = Math.PI / 180;
const EARTH_RADIUS_M = 6378137;

export function orientedFootprintFit(ring, anchorLat, anchorLon) {
    if (!Array.isArray(ring) || ring.length < 3) return null;
    const scaleLon = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(anchorLat * DEG_TO_RAD);
    const scaleLat = DEG_TO_RAD * EARTH_RADIUS_M;
    const points = [];
    for (const coordinate of ring) {
        const lon = Number(coordinate?.[0]);
        const lat = Number(coordinate?.[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
        points.push({
            x: (lon - anchorLon) * scaleLon,
            z: -(lat - anchorLat) * scaleLat,
        });
    }
    let longest = null;
    for (let index = 0; index < points.length; index++) {
        const a = points[index];
        const b = points[(index + 1) % points.length];
        const lengthM = Math.hypot(b.x - a.x, b.z - a.z);
        if (!longest || lengthM > longest.lengthM) {
            longest = { lengthM, dx: b.x - a.x, dz: b.z - a.z };
        }
    }
    if (!longest || longest.lengthM < 1e-6) return null;
    const dirX = longest.dx / longest.lengthM;
    const dirZ = longest.dz / longest.lengthM;
    let minAlong = Infinity;
    let maxAlong = -Infinity;
    let minAcross = Infinity;
    let maxAcross = -Infinity;
    for (const point of points) {
        const along = point.x * dirX + point.z * dirZ;
        const across = -point.x * dirZ + point.z * dirX;
        if (along < minAlong) minAlong = along;
        if (along > maxAlong) maxAlong = along;
        if (across < minAcross) minAcross = across;
        if (across > maxAcross) maxAcross = across;
    }
    const midAlong = (minAlong + maxAlong) / 2;
    const midAcross = (minAcross + maxAcross) / 2;
    return {
        x: dirX * midAlong - dirZ * midAcross,
        z: dirZ * midAlong + dirX * midAcross,
        // THREE rotation.y θ maps local +X to (cosθ, −sinθ) in (x, z); solve
        // for the long axis to land on (dirX, dirZ).
        angleY: Math.atan2(-dirZ, dirX),
        lengthM: maxAlong - minAlong,
        depthM: maxAcross - minAcross,
    };
}
