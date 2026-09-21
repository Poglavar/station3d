// Converts OSM cycling tags and a road centreline into simple offset ribbons.
// The output is plain geometry data so tag interpretation stays headless-testable.

import {
    computeRibbonStations,
    densifyChain,
    smoothChain,
} from '../world/footpath-geometry.js';

const DEFAULT_LANE_WIDTH_M = 1.65;
const MIN_EDGE_MARGIN_M = 0.15;
const SMOOTHING_ITERATIONS = 2;
// Standalone/shared bike paint lies on a separately triangulated path polygon.
// Exact coplanarity makes those two meshes alternate in the depth buffer at a
// grazing view, producing long triangular "shards" at bridge approaches.
// Six millimetres is realistic paint thickness and remains far below any
// grade-separation clearance, so ordinary depth testing still hides the far
// side of an overpass.
export const PATH_BIKE_PAINT_LIFT_M = 0.006;
const SUPPORTED_VALUES = new Set([
    'lane', 'track', 'shared_lane', 'share_busway', 'opposite_lane', 'opposite_track',
    'yes', 'designated',
]);

export function bikePaintSceneY(groundY, surfaceY, {
    pathOwned = false,
} = {}) {
    return Number(groundY) + Number(surfaceY)
        + (pathOwned ? PATH_BIKE_PAINT_LIFT_M : 0);
}

function tagValue(tags, key) {
    const value = tags && tags[key];
    return value == null ? '' : String(value).trim().toLowerCase();
}

function isCyclingValue(value) {
    return SUPPORTED_VALUES.has(String(value || '').toLowerCase());
}

export function resolveBikeLaneBands(properties = {}) {
    const tags = properties.tags || properties;
    const highway = properties.highway_type || properties.highway || '';
    if (highway === 'cycleway') {
        return [{
            side: 'center',
            widthM: Math.max(0.8, Number(properties.width_meters) || DEFAULT_LANE_WIDTH_M),
            placement: 'standalone',
        }];
    }
    const bands = [];
    const left = tagValue(tags, 'cycleway:left');
    const right = tagValue(tags, 'cycleway:right');
    const both = tagValue(tags, 'cycleway:both');
    if (isCyclingValue(left) || isCyclingValue(both)) {
        bands.push({ side: 'left', widthM: DEFAULT_LANE_WIDTH_M, placement: left || both });
    }
    if (isCyclingValue(right) || isCyclingValue(both)) {
        bands.push({ side: 'right', widthM: DEFAULT_LANE_WIDTH_M, placement: right || both });
    }
    if (bands.length > 0) return bands;
    if (['footway', 'path', 'pedestrian'].includes(highway)
        && ['designated', 'yes'].includes(tagValue(tags, 'bicycle'))) {
        return [{ side: 'center', widthM: DEFAULT_LANE_WIDTH_M, placement: 'shared_path' }];
    }
    const generic = tagValue(tags, 'cycleway');
    if (!isCyclingValue(generic)) return [];
    // `cycleway=lane` is directional shorthand, not a physical OSM-way side.
    // Right-driving traffic therefore gets a strip at the outside-right edge
    // of every represented travel direction: both outer edges on a two-way
    // road and exactly one edge on a one-way road. This remains correct for
    // any motor-lane count because geometry offsets from the complete road
    // width, beyond the rightmost lane rather than between lanes.
    const oneway = tagValue(properties, 'oneway') || tagValue(tags, 'oneway');
    const reverseOneway = oneway === '-1' || oneway === 'reverse';
    const forwardOneway = ['yes', '1', 'true'].includes(oneway);
    const opposite = generic.startsWith('opposite_');
    if (reverseOneway) {
        return [{
            side: opposite ? 'right' : 'left',
            widthM: DEFAULT_LANE_WIDTH_M,
            placement: generic,
        }];
    }
    if (forwardOneway) {
        return [{
            side: opposite ? 'left' : 'right',
            widthM: DEFAULT_LANE_WIDTH_M,
            placement: generic,
        }];
    }
    return [
        { side: 'left', widthM: DEFAULT_LANE_WIDTH_M, placement: generic },
        { side: 'right', widthM: DEFAULT_LANE_WIDTH_M, placement: generic },
    ];
}

function bandOffsetM(side, roadWidthM, laneWidthM, placement) {
    if (side === 'center') return 0;
    const outsideRoadEdge = ['track', 'opposite_track'].includes(placement);
    const offset = outsideRoadEdge
        ? Number(roadWidthM) * 0.5 + laneWidthM * 0.5
        : Math.max(
            laneWidthM * 0.5,
            Number(roadWidthM) * 0.5 - laneWidthM * 0.5 - MIN_EDGE_MARGIN_M,
        );
    // Station3D's road traffic uses right=(-forwardZ,+forwardX). Match that
    // convention exactly; the former sign put `cycleway:right` on the physical
    // left of travel (most visibly between one-way traffic and tram tracks).
    return side === 'left' ? -offset : offset;
}

export function buildBikeLaneQuads(points, bands, roadWidthM) {
    const safePoints = (points || [])
        .filter((point) => point && Number.isFinite(point.x) && Number.isFinite(point.z))
        .filter((point, index, all) => (
            index === 0 || Math.hypot(point.x - all[index - 1].x, point.z - all[index - 1].z) >= 0.05
        ));
    if (safePoints.length < 2) return [];
    const widthM = Math.max(2, Number(roadWidthM) || 6);
    const quads = [];
    for (const band of bands || []) {
        const laneWidthM = Math.max(0.8, Number(band.widthM) || DEFAULT_LANE_WIDTH_M);
        const offsetM = bandOffsetM(band.side, widthM, laneWidthM, band.placement);
        // Offset the source road first, then smooth that already-offset chain.
        // Smoothing the centreline before a large inside-curb offset makes the
        // offset radius go negative at a tight bend: the chain doubles back and
        // its paint miter grows into a red arrowhead. A raw miter has the same
        // corner ownership as the road polygon and remains valid on both sides.
        const rawOffsetCenterline = computeRibbonStations(
            safePoints,
            safePoints.map(() => laneWidthM),
        ).map((station) => {
            const miterScale = station.halfWidth / (laneWidthM * 0.5);
            const nx = -station.nx;
            const nz = -station.nz;
            return {
                x: station.x + nx * offsetM * miterScale,
                z: station.z + nz * offsetM * miterScale,
            };
        });
        const offsetCenterline = smoothChain(
            rawOffsetCenterline,
            rawOffsetCenterline.map(() => laneWidthM),
            SMOOTHING_ITERATIONS,
        ).points;
        // Then extrude only the paint width around that offset line. This
        // keeps neighboring quads watertight without letting the road-width
        // offset inflate the paint at corners.
        const stations = computeRibbonStations(
            offsetCenterline,
            offsetCenterline.map(() => laneWidthM),
        ).map((station) => ({
            left: {
                x: station.x - station.nx * station.halfWidth,
                z: station.z - station.nz * station.halfWidth,
            },
            right: {
                x: station.x + station.nx * station.halfWidth,
                z: station.z + station.nz * station.halfWidth,
            },
        }));
        for (let index = 0; index + 1 < stations.length; index++) {
            const from = stations[index];
            const to = stations[index + 1];
            if (!from || !to) continue;
            quads.push([
                from.left,
                to.left,
                to.right,
                from.right,
            ]);
        }
    }
    return quads;
}

export function buildCenteredBikeLaneQuads(points, widths, {
    maxSegmentM = null,
} = {}) {
    const safePoints = (points || []).filter((point) => (
        point && Number.isFinite(point.x) && Number.isFinite(point.z)
    ));
    if (safePoints.length < 2) return [];
    const safeWidths = safePoints.map((_, index) => (
        Math.max(0.8, Number(widths?.[index]) || DEFAULT_LANE_WIDTH_M)
    ));
    const profilePoints = Number.isFinite(maxSegmentM) && maxSegmentM > 0
        ? densifyChain(safePoints, safeWidths, maxSegmentM)
        : { points: safePoints, widths: safeWidths };
    const smoothed = smoothChain(
        profilePoints.points,
        profilePoints.widths,
        SMOOTHING_ITERATIONS,
    );
    const stations = computeRibbonStations(smoothed.points, smoothed.widths);
    const quads = [];
    for (let index = 0; index + 1 < stations.length; index++) {
        const from = stations[index];
        const to = stations[index + 1];
        quads.push([
            { x: from.x - from.nx * from.halfWidth, z: from.z - from.nz * from.halfWidth },
            { x: to.x - to.nx * to.halfWidth, z: to.z - to.nz * to.halfWidth },
            { x: to.x + to.nx * to.halfWidth, z: to.z + to.nz * to.halfWidth },
            { x: from.x + from.nx * from.halfWidth, z: from.z + from.nz * from.halfWidth },
        ]);
    }
    return quads;
}
