function normalizeAngleRad(a) {
    return ((a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
}

export function applyJunctionEndpointLifts(segments, step) {
    const incidentsByNode = new Map();
    for (const s of segments) {
        const start = incidentsByNode.get(s.startKey) || [];
        start.push({ segment: s, endpoint: 'start', angle: s.angle });
        incidentsByNode.set(s.startKey, start);
        const end = incidentsByNode.get(s.endKey) || [];
        end.push({ segment: s, endpoint: 'end', angle: normalizeAngleRad(s.angle + Math.PI) });
        incidentsByNode.set(s.endKey, end);
    }
    for (const incidents of incidentsByNode.values()) {
        if (!incidents || incidents.length <= 2) continue;
        incidents.sort((a, b) => (a.angle - b.angle) || a.segment.sortKey.localeCompare(b.segment.sortKey));
        const center = (incidents.length - 1) * 0.5;
        for (let i = 0; i < incidents.length; i++) {
            const lift = (i - center) * step;
            if (incidents[i].endpoint === 'start') incidents[i].segment.yStart += lift;
            else incidents[i].segment.yEnd += lift;
        }
    }
    return segments;
}
