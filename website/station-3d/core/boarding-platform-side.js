// Resolves which side of a vehicle contains the visible platform crowd so
// boarding doors and alighting destinations never spill onto the track side.

export function inferPlatformSideSign(vehicle, people) {
    if (!vehicle || !Array.isArray(people) || people.length === 0) return 1;
    const headingRad = (Number(vehicle.headingDeg) || 0) * Math.PI / 180;
    const rightX = Math.cos(headingRad);
    const rightZ = Math.sin(headingRad);
    const centerX = Number(vehicle.x) || 0;
    const centerZ = Number(vehicle.z) || 0;
    const lateralSum = people.reduce(
        (sum, person) => sum
            + ((Number(person.x) - centerX) * rightX)
            + ((Number(person.z) - centerZ) * rightZ),
        0,
    );
    return lateralSum < 0 ? -1 : 1;
}
