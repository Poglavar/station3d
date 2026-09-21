// Builds the complete static/dynamic vehicle obstacle population used by
// ambient traffic braking, including authored and player-controlled cars.

function usable(items) {
    return [...(items || [])].filter(car => (
        car
        && car.destroyed !== true
        && car.terrainReady !== false
    ));
}

export function trafficObstaclePopulation({ moving, wrecked, parked } = {}) {
    return [
        ...usable(moving),
        ...usable(wrecked),
        ...usable(parked),
    ];
}
