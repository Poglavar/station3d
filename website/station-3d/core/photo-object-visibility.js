// Defines the explicit object-name contract for authored geometry that remains
// visible while the streamed photoreal world hides abstract simulation layers.

const KEEP_IN_PHOTOREAL = /PhotorealRoot|PhotorealTrenchWalls|TramTrackbed|TramRail|HeavyRail|RailBars|CabInterior|PlayerVehicle|PlayerWalker|Station|MetroEntrance|MetroLift|ElevatedLift/i;

export function keepObjectNameInPhoto(name) {
    return typeof name === 'string' && KEEP_IN_PHOTOREAL.test(name);
}
