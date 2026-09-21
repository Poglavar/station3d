// Metadata-safe windows over solved rail LineStrings.
//
// Rail coordinates are not standalone geometry: optional source chainages are
// vertex-aligned civil authority, while segmentTrackIds are edge-aligned. Any
// renderer that shortens a solved route must shorten those arrays in lockstep
// or the formation layer can no longer honour published portals and structures.

import { finiteOrNull, haversineMeters } from './math.js';

function lineCoordinates(feature) {
    return feature?.geometry?.type === 'LineString'
        && Array.isArray(feature.geometry.coordinates)
        ? feature.geometry.coordinates
        : [];
}

function interpolateCoordinate(a, b, ratio) {
    const length = Math.max(a?.length || 0, b?.length || 0, 2);
    const coordinate = [];
    for (let index = 0; index < length; index += 1) {
        const start = finiteOrNull(a?.[index]);
        const end = finiteOrNull(b?.[index]);
        coordinate.push(start !== null && end !== null
            ? start + (end - start) * ratio
            : start !== null ? start : end);
    }
    return coordinate;
}

function alignedNumericProperty(feature, key, expectedLength) {
    const values = feature?.properties?.[key];
    if (values == null) return null;
    const normalized = Array.isArray(values) ? values.map(finiteOrNull) : [];
    if (!Array.isArray(values)
        || values.length !== expectedLength
        || normalized.some(value => value === null)) {
        throw new RangeError(`${key} must contain one finite value per rail vertex`);
    }
    return normalized;
}

function sourceRatioAtBoundary(sourceA, sourceB, boundaryM) {
    const delta = sourceB - sourceA;
    if (!Number.isFinite(delta) || Math.abs(delta) <= 1e-9) return null;
    const ratio = (boundaryM - sourceA) / delta;
    return ratio >= -1e-9 && ratio <= 1 + 1e-9
        ? Math.max(0, Math.min(1, ratio))
        : null;
}

function normalizedCivilRegime(run) {
    return String(
        run?.regime ?? run?.structure ?? run?.expectedRegime ?? run?.type ?? '',
    ).trim().toLowerCase();
}

function civilBoundaryBeyondCut(feature, sourceM, direction, protectedRegimes) {
    if (!Number.isFinite(sourceM) || !Number.isFinite(direction) || direction === 0) return null;
    for (const run of feature?.properties?.railCivilRuns || []) {
        if (!protectedRegimes.has(normalizedCivilRegime(run))) continue;
        const startM = finiteOrNull(run?.startM ?? run?.fromM ?? run?.dM0);
        const endM = finiteOrNull(run?.endM ?? run?.toM ?? run?.dM1);
        if (startM === null || endM === null) continue;
        const lowM = Math.min(startM, endM);
        const highM = Math.max(startM, endM);
        if (sourceM <= lowM + 1e-6 || sourceM >= highM - 1e-6) continue;
        return direction > 0 ? highM : lowM;
    }
    return null;
}

// Returns an exact endpoint fragment no longer than maxDistanceM, except when
// that cut would invent a boundary inside an authored civil run. In that case
// the fragment extends to the run's real boundary. The source feature is never
// mutated, and every supported vertex/edge metadata array remains aligned.
export function railFeatureEndpointFragment(feature, {
    endpoint = 'first',
    maxDistanceM,
    preserveCivilRegimes = ['tunnel'],
} = {}) {
    const coordinates = lineCoordinates(feature);
    const distanceLimitM = finiteOrNull(maxDistanceM);
    if (coordinates.length < 2 || distanceLimitM === null || distanceLimitM <= 0) {
        return null;
    }
    const fromLast = endpoint === 'last';
    const ordered = fromLast ? coordinates.slice().reverse() : coordinates;
    const sourceChainages = alignedNumericProperty(
        feature,
        'railSourceChainagesM',
        coordinates.length,
    );
    if (Array.isArray(feature?.properties?.railCivilRuns)
        && feature.properties.railCivilRuns.length > 0
        && !sourceChainages) {
        throw new RangeError('railCivilRuns require vertex-aligned railSourceChainagesM');
    }
    const orderedSourceChainages = sourceChainages
        ? (fromLast ? sourceChainages.slice().reverse() : sourceChainages)
        : null;
    const sourceSegmentTrackIds = feature?.properties?.segmentTrackIds == null
        ? null
        : feature.properties.segmentTrackIds;
    if (sourceSegmentTrackIds !== null
        && (!Array.isArray(sourceSegmentTrackIds)
            || sourceSegmentTrackIds.length !== coordinates.length - 1)) {
        throw new RangeError('segmentTrackIds must contain one value per rail edge');
    }
    const orderedSegmentTrackIds = sourceSegmentTrackIds
        ? (fromLast ? sourceSegmentTrackIds.slice().reverse() : sourceSegmentTrackIds)
        : null;
    const protectedRegimes = new Set((preserveCivilRegimes || []).map(value => (
        String(value || '').trim().toLowerCase()
    )).filter(Boolean));
    const selected = [ordered[0]];
    const selectedSourceChainages = orderedSourceChainages
        ? [orderedSourceChainages[0]]
        : null;
    const selectedSegmentTrackIds = orderedSegmentTrackIds ? [] : null;
    let distanceM = 0;
    let civilBoundaryM = null;
    const pushSelected = (previous, current, segmentIndex, ratio = 1) => {
        selected.push(ratio >= 1 ? current : interpolateCoordinate(previous, current, ratio));
        if (selectedSourceChainages) {
            const sourceA = orderedSourceChainages[segmentIndex];
            const sourceB = orderedSourceChainages[segmentIndex + 1];
            selectedSourceChainages.push(sourceA + (sourceB - sourceA) * ratio);
        }
        if (selectedSegmentTrackIds) {
            selectedSegmentTrackIds.push(orderedSegmentTrackIds[segmentIndex]);
        }
    };
    for (let index = 1; index < ordered.length; index += 1) {
        const previous = ordered[index - 1];
        const current = ordered[index];
        if (civilBoundaryM !== null && orderedSourceChainages) {
            const ratio = sourceRatioAtBoundary(
                orderedSourceChainages[index - 1],
                orderedSourceChainages[index],
                civilBoundaryM,
            );
            if (ratio !== null) {
                pushSelected(previous, current, index - 1, ratio);
                civilBoundaryM = null;
                break;
            }
            pushSelected(previous, current, index - 1);
            continue;
        }
        const segmentM = haversineMeters(
            Number(previous?.[1]),
            Number(previous?.[0]),
            Number(current?.[1]),
            Number(current?.[0]),
        );
        if (!Number.isFinite(segmentM) || segmentM <= 0) continue;
        if (distanceM + segmentM <= distanceLimitM) {
            pushSelected(previous, current, index - 1);
            distanceM += segmentM;
            continue;
        }
        const remainingM = distanceLimitM - distanceM;
        if (remainingM > 0) {
            const ratio = remainingM / segmentM;
            if (orderedSourceChainages && protectedRegimes.size > 0) {
                const sourceA = orderedSourceChainages[index - 1];
                const sourceB = orderedSourceChainages[index];
                const cutSourceM = sourceA + (sourceB - sourceA) * ratio;
                const direction = Math.sign(sourceB - sourceA);
                const boundaryM = civilBoundaryBeyondCut(
                    feature,
                    cutSourceM,
                    direction,
                    protectedRegimes,
                );
                if (boundaryM !== null) {
                    const boundaryRatio = sourceRatioAtBoundary(sourceA, sourceB, boundaryM);
                    if (boundaryRatio !== null) {
                        pushSelected(previous, current, index - 1, boundaryRatio);
                        break;
                    }
                    pushSelected(previous, current, index - 1);
                    civilBoundaryM = boundaryM;
                    continue;
                }
            }
            pushSelected(previous, current, index - 1, ratio);
        }
        break;
    }
    if (selected.length < 2) return null;
    const outputSourceChainages = selectedSourceChainages
        ? (fromLast ? selectedSourceChainages.reverse() : selectedSourceChainages)
        : null;
    const outputSegmentTrackIds = selectedSegmentTrackIds
        ? (fromLast ? selectedSegmentTrackIds.reverse() : selectedSegmentTrackIds)
        : null;
    return {
        ...feature,
        properties: {
            ...(feature.properties || {}),
            ...(outputSourceChainages ? { railSourceChainagesM: outputSourceChainages } : {}),
            ...(outputSegmentTrackIds ? { segmentTrackIds: outputSegmentTrackIds } : {}),
        },
        geometry: {
            type: 'LineString',
            coordinates: fromLast ? selected.reverse() : selected,
        },
    };
}
