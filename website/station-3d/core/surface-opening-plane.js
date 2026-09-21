// A lower excavation plane is expressed in session metres, independently of
// receiver storage origins. It bounds removal above an actual sloping backstop.
export function captureOpeningLowerPlane(source) {
    if (source === undefined || source === null) return null;
    const plane = {};
    for (const key of ['x', 'y', 'z', 'slopeX', 'slopeZ']) {
        if (typeof source[key] !== 'number' || !Number.isFinite(source[key])) {
            throw Object.assign(new TypeError('Opening lower plane requires finite origin and slopes'),
                { code: 'ground-opening-coordinate' });
        }
        plane[key] = source[key];
    }
    return Object.freeze(plane);
}

export const openingLowerPlaneHeight = (plane, x, z) =>
    plane.y + (x - plane.x) * plane.slopeX + (z - plane.z) * plane.slopeZ;
