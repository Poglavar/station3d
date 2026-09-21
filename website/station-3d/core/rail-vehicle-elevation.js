// Composes a rail vehicle's scene elevation without applying an authored rail
// profile twice when the rendered formation already owns the rail's scene Y.

import { finiteOrNull } from './math.js';

export function authoredAbsoluteRailSceneY({
    elevationM = null,
    elevationMode = null,
    elevationDatum = null,
    absoluteToSceneY = null,
} = {}) {
    if (elevationMode !== 'absolute' || elevationDatum !== 'EVRF2000'
        || typeof absoluteToSceneY !== 'function') return null;
    const heightM = finiteOrNull(elevationM);
    if (heightM === null) return null;
    return finiteOrNull(absoluteToSceneY(heightM));
}

export function authoredAbsoluteRailGrade({
    pitchDeg = null,
    elevationMode = null,
    elevationDatum = null,
} = {}) {
    if (elevationMode !== 'absolute' || elevationDatum !== 'EVRF2000') return null;
    const pitch = finiteOrNull(pitchDeg);
    return pitch === null ? null : Math.tan(pitch * Math.PI / 180);
}

export function composeRailVehicleSceneY({
    walkMode = false,
    photoSceneY = null,
    formationSceneY = null,
    authoredAbsoluteSceneY = null,
    groundSceneY = 0,
    relativePoseY = 0,
} = {}) {
    if (walkMode) return 0;
    const photoY = finiteOrNull(photoSceneY);
    if (photoY !== null) return photoY;
    const formationY = finiteOrNull(formationSceneY);
    if (formationY !== null) return formationY;
    const authoredY = finiteOrNull(authoredAbsoluteSceneY);
    if (authoredY !== null) return authoredY;
    return (finiteOrNull(groundSceneY) ?? 0)
        + (finiteOrNull(relativePoseY) ?? 0);
}
