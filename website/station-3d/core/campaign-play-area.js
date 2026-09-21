import { geoToLocal, haversineMeters } from './math.js';

function segmentDistanceSquared(point, start, end) {
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const lengthSquared = dx * dx + dz * dz;
    if (lengthSquared <= 1e-9) {
        return (point.x - start.x) ** 2 + (point.z - start.z) ** 2;
    }
    const t = Math.max(0, Math.min(1, (
        (point.x - start.x) * dx + (point.z - start.z) * dz
    ) / lengthSquared));
    const x = start.x + t * dx;
    const z = start.z + t * dz;
    return (point.x - x) ** 2 + (point.z - z) ** 2;
}
export function campaignPlayAreaContainsPose(bounds, pose) {
    if (!bounds || !pose || ![pose.lat, pose.lon].every(Number.isFinite)) return true;
    if (bounds.kind === 'corridor') {
        const path = (bounds.path || []).filter(point => (
            [point?.lat, point?.lon].every(Number.isFinite)
        ));
        const halfWidthM = Number(bounds.halfWidthM);
        if (path.length < 2 || !(halfWidthM > 0)) return true;
        const anchor = path[0];
        const localPath = path.map(point => geoToLocal(
            point.lon,
            point.lat,
            anchor.lon,
            anchor.lat,
        ));
        const localPose = geoToLocal(pose.lon, pose.lat, anchor.lon, anchor.lat);
        let nearestSquared = Infinity;
        for (let index = 1; index < localPath.length; index++) {
            nearestSquared = Math.min(
                nearestSquared,
                segmentDistanceSquared(localPose, localPath[index - 1], localPath[index]),
            );
        }
        return nearestSquared <= halfWidthM * halfWidthM;
    }
    if (bounds.center && Number(bounds.radiusM) > 0) {
        return haversineMeters(
            pose.lat,
            pose.lon,
            bounds.center.lat,
            bounds.center.lon,
        ) <= Number(bounds.radiusM);
    }
    return true;
}
