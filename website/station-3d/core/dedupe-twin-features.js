// Drop GDI double-entry: the SAME physical building appearing under two
// object_ids with near-identical footprints and heights (61639/61706 on
// Paromlinska is one). Building both stacks every wall twice — plaster
// z-fights as mottling, and two alpha-tested facade grids fight per viewing
// angle. Keep exactly one twin (smallest object_id); the facade-level covering
// rules still handle PARTIAL duplicates (annexes re-carrying a single wall).
//
// Lives in core/ because the rule below is the kind that eats geometry
// silently, and it has to be provable without a browser.

// A feature that STATES its material is never a twin of anything.
//
// The test above is pure geometry — 2D bbox, top height, vertex count — and a
// hand-modelled landmark is built from parts that are CO-LOCATED BY DESIGN: the
// concrete shell, the glass skin, the mullion cage and the LED strips all wrap
// the same cylinder, at the same height, with the same vertex count. To a
// duplicate-detector written for survey shells they are indistinguishable from
// double entry, so it deleted them.
//
// It cost Cibona its crown lighting — the edgeLight part (91 vertices) was
// eaten as a twin of the concrete parapet (91 vertices, same ring, 0.4 m
// apart), so the tower had no night lights at all and 8 of its 9 parts arrived
// with nothing reporting the ninth. Co-located parts of one modelled building
// are the POINT, not a defect.
export function isTwinnableFeature(feature) {
    return !feature?.properties?.material;
}

export function dedupeTwinFeatures(features, onDropped = null) {
    if (!Array.isArray(features) || features.length < 2) return features;
    const EPS_DEG = 3.5e-6;   // ≈ 0.3 m
    const infos = [];
    for (const feature of features) {
        const geom = feature && feature.geometry;
        if (!geom || geom.type !== 'MultiPolygon' || !isTwinnableFeature(feature)) {
            infos.push({ feature, twinnable: false });
            continue;
        }
        let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
        let maxZ = -Infinity, verts = 0;
        let lonSum = 0, latSum = 0, zSum = 0, zVerts = 0;
        for (const poly of geom.coordinates) {
            const ring = poly && poly[0];
            if (!Array.isArray(ring)) continue;
            for (const pt of ring) {
                if (pt[0] < minLon) minLon = pt[0];
                if (pt[0] > maxLon) maxLon = pt[0];
                if (pt[1] < minLat) minLat = pt[1];
                if (pt[1] > maxLat) maxLat = pt[1];
                lonSum += pt[0];
                latSum += pt[1];
                if (pt.length > 2 && pt[2] != null) {
                    if (pt[2] > maxZ) maxZ = pt[2];
                    zSum += pt[2];
                    zVerts += 1;
                }
                verts++;
            }
        }
        infos.push({
            feature,
            twinnable: verts > 0,
            minLon, maxLon, minLat, maxLat, maxZ, verts,
            meanLon: lonSum / verts,
            meanLat: latSum / verts,
            meanZ: zVerts > 0 ? zSum / zVerts : -Infinity,
            id: feature.properties && feature.properties.object_id != null
                ? Number(feature.properties.object_id)
                : Infinity,
        });
    }
    // Smallest id first, so it is the copy that survives.
    const order = infos.slice().sort((a, b) => (a.id ?? Infinity) - (b.id ?? Infinity));
    const kept = [];
    const droppedFeatures = new Set();
    for (const info of order) {
        if (!info.twinnable) { kept.push(info); continue; }
        const twin = kept.find((k) => k.twinnable
            && Math.abs(k.minLon - info.minLon) < EPS_DEG
            && Math.abs(k.maxLon - info.maxLon) < EPS_DEG
            && Math.abs(k.minLat - info.minLat) < EPS_DEG
            && Math.abs(k.maxLat - info.maxLat) < EPS_DEG
            && Math.abs(k.maxZ - info.maxZ) < 0.6
            // Equal bounds alone do not imply equal geometry: the two
            // complementary triangles of a rectangular panel have the same
            // bbox, height and vertex count. Their centroids sit on opposite
            // halves, while genuine double-entry meshes stay co-located.
            && Math.abs(k.meanLon - info.meanLon) < EPS_DEG
            && Math.abs(k.meanLat - info.meanLat) < EPS_DEG
            && Math.abs(k.meanZ - info.meanZ) < 0.6
            && info.verts > k.verts * 0.8 && info.verts < k.verts * 1.25);
        if (twin) droppedFeatures.add(info.feature);
        else kept.push(info);
    }
    if (droppedFeatures.size > 0) {
        onDropped?.(droppedFeatures.size);
        return features.filter((feature) => !droppedFeatures.has(feature));
    }
    return features;
}
