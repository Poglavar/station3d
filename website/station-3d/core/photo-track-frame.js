// Maps an authored WGS84 rail alignment into the same local tangent frame as
// Google Photorealistic 3D Tiles, while keeping the vertical profile immutable.

const WGS84_A_M = 6378137;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function geodeticToEcef(lonDeg, latDeg, heightM) {
    const lon = finite(lonDeg) * DEG_TO_RAD;
    const lat = finite(latDeg) * DEG_TO_RAD;
    const height = finite(heightM);
    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    const primeVertical = WGS84_A_M / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    return {
        x: (primeVertical + height) * cosLat * Math.cos(lon),
        y: (primeVertical + height) * cosLat * Math.sin(lon),
        z: (primeVertical * (1 - WGS84_E2) + height) * sinLat,
    };
}

function ecefToGeodetic(xValue, yValue, zValue) {
    const x = finite(xValue);
    const y = finite(yValue);
    const z = finite(zValue);
    const lon = Math.atan2(y, x);
    const p = Math.hypot(x, y);
    let lat = Math.atan2(z, p * (1 - WGS84_E2));
    let height = 0;
    for (let iteration = 0; iteration < 8; iteration++) {
        const sinLat = Math.sin(lat);
        const primeVertical = WGS84_A_M / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
        const cosLat = Math.cos(lat);
        height = Math.abs(cosLat) > 1e-12 ? p / cosLat - primeVertical : 0;
        lat = Math.atan2(z, p * (1 - WGS84_E2 * primeVertical / (primeVertical + height)));
    }
    return { lon: lon * RAD_TO_DEG, lat: lat * RAD_TO_DEG, heightM: height };
}

function destinationPoint(lonDeg, latDeg, headingDeg, distanceM) {
    const lat = finite(latDeg) * DEG_TO_RAD;
    const heading = finite(headingDeg) * DEG_TO_RAD;
    const distance = finite(distanceM);
    const sinLat = Math.sin(lat);
    const denom = Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    const meridionalRadius = WGS84_A_M * (1 - WGS84_E2) / (denom ** 3);
    const primeVertical = WGS84_A_M / denom;
    const north = Math.cos(heading) * distance;
    const east = Math.sin(heading) * distance;
    const nextLat = lat + north / meridionalRadius;
    const nextLon = finite(lonDeg) * DEG_TO_RAD
        + east / Math.max(1e-9, primeVertical * Math.cos(lat));
    return { lon: nextLon * RAD_TO_DEG, lat: nextLat * RAD_TO_DEG };
}

// Google terrain is translated, never the track. At the registration point the
// translated Google ground must preserve the authored track-vs-DGU relationship.
export function terrainSeatOffset({
    trackY,
    unshiftedGroundY,
    authoredGroundOffsetM = 0,
} = {}) {
    const track = Number(trackY);
    const ground = Number(unshiftedGroundY);
    const authoredOffset = Number(authoredGroundOffsetM);
    if (!Number.isFinite(track) || !Number.isFinite(ground)) return null;
    return track - (Number.isFinite(authoredOffset) ? authoredOffset : 0) - ground;
}

// One bad Google read at a single registration point (station platforms, an
// embankment crest, canopy, an overpass — exactly what surrounds a route's
// first station) shifts the ENTIRE Google world vertically: flat sections then
// classify as phantom viaducts or trenches route-wide. Registration therefore
// samples several stations along the alignment and takes the MEDIAN candidate
// shift, so systematic clutter at any one spot becomes an outlier instead of
// the datum. Still exactly ONE translation is applied.
export function selectConsensusSeatOffset(candidateShifts, { minCandidates = 3 } = {}) {
    const finiteShifts = (candidateShifts || []).map(Number).filter(Number.isFinite);
    if (finiteShifts.length < Math.max(1, Number(minCandidates) || 1)) return null;
    finiteShifts.sort((a, b) => a - b);
    const middle = Math.floor(finiteShifts.length / 2);
    return finiteShifts.length % 2
        ? finiteShifts[middle]
        : (finiteShifts[middle - 1] + finiteShifts[middle]) * 0.5;
}

// Plan the registration stations: points spaced along the flat corridor
// segment array ([ax, az, bx, bz, ya, yb] stride 6, route-ordered), centred on
// the arc position nearest a reference point. Pure so the sampling plan is
// testable without a scene.
export function registrationStationsAlong(segments, refX, refZ, {
    spacingM = 80,
    maxStations = 7,
    maxSpanM = 700,
    segmentTrackIds = null,
} = {}) {
    const segs = [];
    let total = 0;
    for (let s = 0; Array.isArray(segments) && s + 5 < segments.length; s += 6) {
        const ax = Number(segments[s]);
        const az = Number(segments[s + 1]);
        const bx = Number(segments[s + 2]);
        const bz = Number(segments[s + 3]);
        const ya = Number(segments[s + 4]);
        const yb = Number(segments[s + 5]);
        const length = Math.hypot(bx - ax, bz - az);
        if (!Number.isFinite(length) || length <= 1e-6) continue;
        segs.push({
            ax, az, bx, bz, ya, yb, length,
            startArc: total,
            trackId: Array.isArray(segmentTrackIds) ? segmentTrackIds[s / 6] ?? null : null,
        });
        total += length;
    }
    if (!segs.length) return [];
    // Nearest arc position to the reference.
    let bestArc = 0;
    let bestDistSq = Infinity;
    for (const seg of segs) {
        const dx = seg.bx - seg.ax;
        const dz = seg.bz - seg.az;
        const lenSq = dx * dx + dz * dz;
        let t = lenSq > 0 ? ((refX - seg.ax) * dx + (refZ - seg.az) * dz) / lenSq : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = seg.ax + dx * t - refX;
        const qz = seg.az + dz * t - refZ;
        const distSq = qx * qx + qz * qz;
        if (distSq < bestDistSq) {
            bestDistSq = distSq;
            bestArc = seg.startArc + seg.length * t;
        }
    }
    const atArc = (arc) => {
        const clamped = Math.max(0, Math.min(total, arc));
        for (const seg of segs) {
            if (clamped > seg.startArc + seg.length + 1e-9) continue;
            const t = seg.length > 0 ? (clamped - seg.startArc) / seg.length : 0;
            return {
                x: seg.ax + (seg.bx - seg.ax) * t,
                z: seg.az + (seg.bz - seg.az) * t,
                y: seg.ya + (seg.yb - seg.ya) * t,
                ux: (seg.bx - seg.ax) / seg.length,
                uz: (seg.bz - seg.az) / seg.length,
                trackId: seg.trackId,
                arcM: clamped,
            };
        }
        return null;
    };
    const spacing = Math.max(1, Number(spacingM) || 80);
    const budget = Math.max(1, Math.floor(Number(maxStations) || 7));
    const span = Math.max(spacing, Number(maxSpanM) || 700);
    const stations = [];
    const seen = new Set();
    const pushArc = (arc) => {
        if (stations.length >= budget) return;
        if (Math.abs(arc - bestArc) > span) return;
        if (arc < 0 || arc > total) return;
        const key = Math.round(Math.max(0, Math.min(total, arc)) / 5);
        if (seen.has(key)) return;
        seen.add(key);
        const station = atArc(arc);
        if (station) stations.push(station);
    };
    pushArc(bestArc);
    for (let step = 1; stations.length < budget && step * spacing <= span; step++) {
        pushArc(bestArc + step * spacing);
        pushArc(bestArc - step * spacing);
    }
    return stations;
}

// Cab -> walk is a camera/physics handoff, not a new geospatial registration.
// Keep the exact tangent frame and, when the photo world has already resolved
// its Google/DGU tie, carry that one root translation into the replacement
// session. The walker's support is the old frame's scene Y, not the authored
// relative-height number (those diverge with globe curvature away from origin).
export function resolvePhotoHandoffState({
    frame,
    registration = null,
    lon,
    lat,
    relativeHeightM = 0,
} = {}) {
    if (!frame || typeof frame.toScene !== 'function') return null;
    const scene = frame.toScene(lon, lat, relativeHeightM);
    const inheritedSeat = registration?.photoTrackFrame === frame
        ? Number(registration.seatOffsetY)
        : Number.NaN;
    return {
        photoTrackFrame: frame,
        photoSeatOffsetY: Number.isFinite(inheritedSeat) ? inheritedSeat : null,
        groundY: scene.y,
    };
}

// Projects one vehicle/car pose into the exact fixed tangent frame used by
// photoreal rails and terrain. Articulated train cars must use this too: flat
// map coordinates and raw compass headings visibly diverge from the tangent
// frame several kilometres from its anchor.
export function resolvePhotoVehiclePose(frame, pose, {
    relativeHeightM = 0,
    profilePitchDeg = 0,
} = {}) {
    const lon = Number(pose?.lon);
    const lat = Number(pose?.lat);
    if (!frame || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    const height = Number.isFinite(Number(pose?.y)) ? Number(pose.y) : finite(relativeHeightM);
    const headingDeg = finite(pose?.headingDeg);
    const point = frame.toScene(lon, lat, height);
    const orientation = frame.orientationAt({
        lon,
        lat,
        relativeHeightM: height,
        headingDeg,
        profilePitchDeg: finite(pose?.pitchDeg, finite(profilePitchDeg)),
    });
    return {
        x: point.x,
        y: point.y,
        z: point.z,
        headingDeg: orientation.headingDeg,
        pitchDeg: orientation.pitchDeg,
    };
}

export function createPhotoTrackFrame({ anchorLon, anchorLat, heightOriginM = 0 } = {}) {
    const lon0 = finite(anchorLon);
    const lat0 = finite(anchorLat);
    const heightOrigin = finite(heightOriginM);
    const lonRad = lon0 * DEG_TO_RAD;
    const latRad = lat0 * DEG_TO_RAD;
    const sinLon = Math.sin(lonRad);
    const cosLon = Math.cos(lonRad);
    const sinLat = Math.sin(latRad);
    const cosLat = Math.cos(latRad);
    // ReorientationPlugin anchors its local tangent frame at ellipsoid height 0.
    // We use the same ECEF origin and subtract heightOrigin only from local Y,
    // keeping coordinates small while one Google-ground tie absorbs the unknown
    // EVRF2000↔ellipsoid/geoid offset.
    const origin = geodeticToEcef(lon0, lat0, 0);
    const east = { x: -sinLon, y: cosLon, z: 0 };
    const north = { x: -sinLat * cosLon, y: -sinLat * sinLon, z: cosLat };
    const up = { x: cosLat * cosLon, y: cosLat * sinLon, z: sinLat };

    function toScene(lon, lat, relativeHeightM = 0) {
        const point = geodeticToEcef(lon, lat, heightOrigin + finite(relativeHeightM));
        const dx = point.x - origin.x;
        const dy = point.y - origin.y;
        const dz = point.z - origin.z;
        const e = dx * east.x + dy * east.y + dz * east.z;
        const n = dx * north.x + dy * north.y + dz * north.z;
        const u = dx * up.x + dy * up.y + dz * up.z;
        return { x: e, y: u - heightOrigin, z: -n };
    }

    function fromScene(xValue, yValue, zValue) {
        const e = finite(xValue);
        const n = -finite(zValue);
        const u = finite(yValue) + heightOrigin;
        const point = {
            x: origin.x + east.x * e + north.x * n + up.x * u,
            y: origin.y + east.y * e + north.y * n + up.y * u,
            z: origin.z + east.z * e + north.z * n + up.z * u,
        };
        const geodetic = ecefToGeodetic(point.x, point.y, point.z);
        return {
            lon: geodetic.lon,
            lat: geodetic.lat,
            heightM: geodetic.heightM,
            relativeHeightM: geodetic.heightM - heightOrigin,
        };
    }

    // Converts geodetic heading + authored grade into the fixed tangent-frame
    // yaw/pitch used by Three.js. Even a constant-ASL line curves downward and
    // its scene yaw slowly converges in one ENU frame as distance grows.
    function orientationAt({
        lon,
        lat,
        relativeHeightM = 0,
        headingDeg = 0,
        profilePitchDeg = 0,
        stepM = 5,
    } = {}) {
        const step = Math.max(0.5, finite(stepM, 5));
        const start = toScene(lon, lat, relativeHeightM);
        const destination = destinationPoint(lon, lat, headingDeg, step);
        const rise = Math.tan(finite(profilePitchDeg) * DEG_TO_RAD) * step;
        const end = toScene(destination.lon, destination.lat, finite(relativeHeightM) + rise);
        const horizontalM = Math.hypot(end.x - start.x, end.z - start.z);
        return {
            headingDeg: (Math.atan2(end.x - start.x, -(end.z - start.z)) * RAD_TO_DEG + 360) % 360,
            pitchDeg: Math.atan2(end.y - start.y, horizontalM) * RAD_TO_DEG,
        };
    }

    function pitchDegAt(options = {}) {
        return orientationAt(options).pitchDeg;
    }

    return Object.freeze({
        anchorLon: lon0,
        anchorLat: lat0,
        heightOriginM: heightOrigin,
        toScene,
        fromScene,
        orientationAt,
        pitchDegAt,
    });
}
