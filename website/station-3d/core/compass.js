// Pure cab-compass math. Heading convention matches Station3D poses:
// 0° = north, 90° = east. Keeping camera-mode handling here makes the
// dashboard testable without a DOM or Three.js scene.

const FULL_TURN_DEG = 360;
const RAD_TO_DEG = 180 / Math.PI;

export const COMPASS_POINTS = Object.freeze([
    'N', 'NNE', 'NE', 'ENE',
    'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW',
    'W', 'WNW', 'NW', 'NNW',
]);

export function normalizeHeadingDeg(value) {
    const heading = Number(value);
    if (!Number.isFinite(heading)) return null;
    const wrapped = heading % FULL_TURN_DEG;
    if (Math.abs(wrapped) < 1e-12) return 0;
    return wrapped < 0 ? wrapped + FULL_TURN_DEG : wrapped;
}

export function compassPointForHeading(value) {
    const heading = normalizeHeadingDeg(value);
    if (heading == null) return '–';
    const sectorSize = FULL_TURN_DEG / COMPASS_POINTS.length;
    return COMPASS_POINTS[Math.round(heading / sectorSize) % COMPASS_POINTS.length];
}

// Front/rear cabs use the driver's drag-look yaw. The outside chase camera
// has a fixed forward look-at target, so its instrument follows the tram
// heading and deliberately ignores the stored cab-look offset.
export function cabViewHeadingDeg(tramHeadingRad, lookYawRad = 0, cameraMode = 'front') {
    const heading = Number(tramHeadingRad);
    if (!Number.isFinite(heading)) return null;
    const rearOffset = cameraMode === 'rear' ? Math.PI : 0;
    const lookOffset = cameraMode === 'third' ? 0 : Number(lookYawRad) || 0;
    return normalizeHeadingDeg((heading + rearOffset + lookOffset) * RAD_TO_DEG);
}

export function compassReading(value) {
    const heading = normalizeHeadingDeg(value);
    if (heading == null) {
        return { heading: null, degrees: null, point: '–', degreeText: '–––°' };
    }
    const degrees = Math.round(heading) % FULL_TURN_DEG;
    return {
        heading,
        degrees,
        point: compassPointForHeading(heading),
        degreeText: `${String(degrees).padStart(3, '0')}°`,
    };
}
