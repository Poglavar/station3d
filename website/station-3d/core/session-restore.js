// Reopening a world can choose a different height origin. Runtime positions
// keep their absolute height; velocities and absent measurements stay unchanged.
export function rebaseSessionRestorePoint(snapshot, altitudeDatumM) {
    if (!snapshot || !Number.isFinite(snapshot.altitudeDatumM)
        || !Number.isFinite(altitudeDatumM)) return snapshot;
    const offset = snapshot.altitudeDatumM - altitudeDatumM;
    const shift = (record, keys) => record ? {
        ...record,
        ...Object.fromEntries(keys.filter(key => Number.isFinite(record[key]))
            .map(key => [key, record[key] + offset])),
    } : record;
    return {
        ...snapshot,
        altitudeDatumM,
        pose: shift(snapshot.pose, ['y']),
        walkMotion: shift(snapshot.walkMotion, ['y', 'initialGroundY', 'lastDetectedGroundY', 'spawnY']),
        vehicleMotion: snapshot.vehicleMotion ? {
            ...shift(snapshot.vehicleMotion, ['y', 'groundY']),
            special: shift(snapshot.vehicleMotion.special, ['y']),
        } : snapshot.vehicleMotion,
    };
}
