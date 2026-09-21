// Plans repeatable steel-girder stiffener/fastener stations along a streamed
// rail bridge slice without creating one render object per detail.

export function planSteelBridgeDetailStations(samples, {
    spacingM = 2.4,
    endMarginM = 0.6,
} = {}) {
    const points = Array.isArray(samples) ? samples : [];
    if (points.length < 2) return [];
    const spacing = Math.max(0.5, Number(spacingM) || 2.4);
    const startStation = Number(points[0].station);
    const endStation = Number(points.at(-1).station);
    if (!Number.isFinite(startStation) || !Number.isFinite(endStation)
        || endStation <= startStation) return [];
    const margin = Math.min(
        Math.max(0, Number(endMarginM) || 0),
        Math.max(0, (endStation - startStation) * 0.45),
    );
    const firstStation = Math.ceil((startStation + margin) / spacing) * spacing;
    const lastStation = endStation - margin;
    const stations = [];
    let segmentIndex = 0;
    for (let station = firstStation; station <= lastStation + 1e-6; station += spacing) {
        while (segmentIndex + 1 < points.length - 1
            && station > points[segmentIndex + 1].station) segmentIndex++;
        const a = points[segmentIndex];
        const b = points[segmentIndex + 1];
        const spanM = Number(b.station) - Number(a.station);
        if (!(spanM > 1e-6)) continue;
        const t = Math.max(0, Math.min(1, (station - a.station) / spanM));
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const lengthM = Math.hypot(dx, dz);
        if (!(lengthM > 1e-6)) continue;
        stations.push({
            station,
            x: a.x + dx * t,
            z: a.z + dz * t,
            railY: a.railY + (b.railY - a.railY) * t,
            angle: Math.atan2(dx, dz),
            normalX: dz / lengthM,
            normalZ: -dx / lengthM,
        });
    }
    if (stations.length === 0) {
        const a = points[0];
        const b = points.at(-1);
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const lengthM = Math.hypot(dx, dz);
        if (lengthM > 1e-6) {
            stations.push({
                station: (startStation + endStation) * 0.5,
                x: (a.x + b.x) * 0.5,
                z: (a.z + b.z) * 0.5,
                railY: (a.railY + b.railY) * 0.5,
                angle: Math.atan2(dx, dz),
                normalX: dz / lengthM,
                normalZ: -dx / lengthM,
            });
        }
    }
    return stations;
}
