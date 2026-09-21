// Fast, pure collision index between a proposed rail corridor and streamed
// building geometry. A plan-position hit is intentionally binary — the whole
// building goes — but only where the track actually disturbs the ground the
// building stands on: at-grade, embankment, open cut, and the stretches of a
// tunnel too shallow to bury its own roof. A tunnel with real cover over it
// passes UNDER a building and a viaduct deck flies OVER it; neither demolishes.
//
// The vertical rule is the COVER at the hit, never the plan topology around it.
// Both are available and they disagree: run boundaries move with smoothing,
// minimum-run and gap-bridging constants, so keying demolition on "am I near
// the end of a tunnel run" razes buildings over ground the track never came
// near. Cover is a property of the place, and it is the same question the
// flat-world rule at the bottom of _hitSpared has always asked.

import { DEG_TO_RAD, EARTH_RADIUS_M, finiteOrNull } from './math.js';
import {
    DEFAULT_TUNNEL_COVER_THRESHOLD_M,
    DEFAULT_VIADUCT_FILL_THRESHOLD_M,
    RAIL_TUBE_HEIGHT_ABOVE_RAIL_M,
} from './rail-formation.js';
import { FORMATION_MAX_CUTOUT_REACH_M } from './road-formation.js';
import { structureOverheadVerdict } from './structure-clearance.js';

const DEFAULT_CELL_M = 100;
const DEFAULT_HALF_WIDTH_M = 2;
// Footprint samples when asking whether a building overhangs the cut, and the
// finest spacing worth walking: a cut is metres wide, so sub-metre steps buy
// nothing but time on the streaming path.
const OPEN_CUT_FOOTPRINT_SAMPLES = 48;
const OPEN_CUT_FOOTPRINT_MIN_STEP_M = 1.5;

// Authored landmarks arrive as one feature per MATERIAL bucket, not one
// feature per logical building. Demolishing a bucket independently dismantles
// the model (glass disappears while its roof survives), and the far LOD carries
// those same parts without `material`, identified by its canonical resolver
// provenance instead. Until the backend supplies a single parent-building
// footprint for an all-or-nothing verdict, the automatic track-acquisition
// pass must leave every authored part intact.
export function supportsProposalTrackDemolition(feature) {
    const properties = feature?.properties;
    if (!properties) return true;
    if (properties.material != null) return false;
    if (properties.source === 'landmark') return false;
    if (properties.render_source === 'landmark_mesh') return false;
    if (properties.footprint_source === 'landmark') return false;
    if (properties.mesh_table === 'buildings.landmark_mesh') return false;
    return true;
}

function finiteCoordinate(coordinate) {
    return Array.isArray(coordinate)
        && Number.isFinite(Number(coordinate[0]))
        && Number.isFinite(Number(coordinate[1]));
}

function cellKey(x, z, cellM) {
    return `${Math.floor(x / cellM)}_${Math.floor(z / cellM)}`;
}

function pointSegmentDistanceSquared(point, a, b) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSquared = dx * dx + dz * dz;
    if (lengthSquared < 1e-9) return (point.x - a.x) ** 2 + (point.z - a.z) ** 2;
    const t = Math.max(0, Math.min(1,
        ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSquared,
    ));
    const x = a.x + dx * t;
    const z = a.z + dz * t;
    return (point.x - x) ** 2 + (point.z - z) ** 2;
}

function orientation(a, b, c) {
    return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

function onSegment(a, b, point) {
    return point.x >= Math.min(a.x, b.x) - 1e-8
        && point.x <= Math.max(a.x, b.x) + 1e-8
        && point.z >= Math.min(a.z, b.z) - 1e-8
        && point.z <= Math.max(a.z, b.z) + 1e-8;
}

function segmentsIntersect(a, b, c, d) {
    const abC = orientation(a, b, c);
    const abD = orientation(a, b, d);
    const cdA = orientation(c, d, a);
    const cdB = orientation(c, d, b);
    if (((abC > 0 && abD < 0) || (abC < 0 && abD > 0))
        && ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))) return true;
    if (Math.abs(abC) < 1e-8 && onSegment(a, b, c)) return true;
    if (Math.abs(abD) < 1e-8 && onSegment(a, b, d)) return true;
    if (Math.abs(cdA) < 1e-8 && onSegment(c, d, a)) return true;
    return Math.abs(cdB) < 1e-8 && onSegment(c, d, b);
}

function segmentDistanceSquared(a, b, c, d) {
    if (segmentsIntersect(a, b, c, d)) return 0;
    return Math.min(
        pointSegmentDistanceSquared(a, c, d),
        pointSegmentDistanceSquared(b, c, d),
        pointSegmentDistanceSquared(c, a, b),
        pointSegmentDistanceSquared(d, a, b),
    );
}

function ringPerimeter(ring) {
    let total = 0;
    for (let index = 0; index < ring.length; index++) {
        const a = ring[index];
        const b = ring[(index + 1) % ring.length];
        total += Math.hypot(b.x - a.x, b.z - a.z);
    }
    return total;
}

function pointInRing(point, ring) {
    let inside = false;
    for (let index = 0, previous = ring.length - 1;
        index < ring.length;
        previous = index++) {
        const a = ring[index];
        const b = ring[previous];
        if ((a.z > point.z) !== (b.z > point.z)
            && point.x < ((b.x - a.x) * (point.z - a.z)) / ((b.z - a.z) || 1e-12) + a.x) {
            inside = !inside;
        }
    }
    return inside;
}

function normalizePolygons(geometry) {
    if (geometry?.type === 'Polygon') return [geometry.coordinates || []];
    if (geometry?.type === 'MultiPolygon') return geometry.coordinates || [];
    return [];
}

function pointInPolygon(point, rings) {
    if (!rings?.[0] || !pointInRing(point, rings[0])) return false;
    return !rings.slice(1).some((hole) => pointInRing(point, hole));
}

export class ProposalTrackImpactIndex {
    constructor({
        anchorLat,
        anchorLon,
        features = [],
        halfWidthForFeature = null,
        cellM = DEFAULT_CELL_M,
        railFormation = null,
        absoluteToSceneY = null,
    }) {
        this.anchorLat = Number(anchorLat);
        this.anchorLon = Number(anchorLon);
        this.metresPerDegreeLat = DEG_TO_RAD * EARTH_RADIUS_M;
        this.metresPerDegreeLon = this.metresPerDegreeLat
            * Math.cos(this.anchorLat * DEG_TO_RAD);
        this.cellM = Math.max(20, Number(cellM) || DEFAULT_CELL_M);
        // Lazy: the rail formation is built by the rails layer during the same
        // session boot but possibly after this index; buildings only stream
        // (and query) once the boot pass has finished, so reading it per query
        // sees the finished formation.
        this.railFormation = typeof railFormation === 'function' ? railFormation : null;
        // Converts a surveyed absolute base (a building's z_min, EVRF2000) into
        // the scene frame the formation reports its rail and ground in, so the
        // overhead test can subtract them. Null in a flat world, where a z_min
        // means nothing and no building is ever lifted onto terrain.
        this.absoluteToSceneY = typeof absoluteToSceneY === 'function' ? absoluteToSceneY : null;
        // Buildings spared because the corridor passes under them, but under a
        // deck too low for the railway. Reported rather than silently accepted:
        // each entry is the metres the alignment must drop to fit.
        this.clearanceShortfalls = new Map();
        this.index = new Map();
        this.segments = [];
        const resolveHalfWidth = typeof halfWidthForFeature === 'function'
            ? halfWidthForFeature
            : (() => DEFAULT_HALF_WIDTH_M);
        for (const feature of features || []) {
            if (feature?.geometry?.type !== 'LineString') continue;
            const coordinates = (feature.geometry.coordinates || []).filter(finiteCoordinate);
            const requestedHalfWidth = Number(resolveHalfWidth(feature));
            const halfWidthM = Number.isFinite(requestedHalfWidth) && requestedHalfWidth > 0
                ? requestedHalfWidth
                : DEFAULT_HALF_WIDTH_M;
            // Third coordinates in the RELATIVE regime are metres above flat
            // ground, so a level bored run or an elevated deck is recognizable
            // from the geometry alone. Absolute/asl datums are only meaningful
            // against terrain — there the rail formation is the judge instead.
            const relativeElevations = feature.properties?.elevationMode !== 'absolute'
                && feature.properties?.elevationDatum !== 'asl';
            for (let index = 0; index < coordinates.length - 1; index++) {
                const a = this.toLocal(coordinates[index][0], coordinates[index][1]);
                const b = this.toLocal(coordinates[index + 1][0], coordinates[index + 1][1]);
                if (Math.hypot(b.x - a.x, b.z - a.z) < 0.01) continue;
                const elevA = Number(coordinates[index][2]) || 0;
                const elevB = Number(coordinates[index + 1][2]) || 0;
                const segment = { a, b, halfWidthM, elevA, elevB, relativeElevations };
                this.segments.push(segment);
                // Padded by the cut's reach, not just the bed's half width: a
                // building standing on the batter has to reach the broad phase
                // before anything can ask whether it stands over the hole.
                const pad = halfWidthM + FORMATION_MAX_CUTOUT_REACH_M;
                const minCellX = Math.floor((Math.min(a.x, b.x) - pad) / this.cellM);
                const maxCellX = Math.floor((Math.max(a.x, b.x) + pad) / this.cellM);
                const minCellZ = Math.floor((Math.min(a.z, b.z) - pad) / this.cellM);
                const maxCellZ = Math.floor((Math.max(a.z, b.z) + pad) / this.cellM);
                for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
                    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
                        const key = `${cellX}_${cellZ}`;
                        const bucket = this.index.get(key);
                        if (bucket) bucket.push(segment);
                        else this.index.set(key, [segment]);
                    }
                }
            }
        }
    }

    toLocal(lon, lat) {
        return {
            x: (Number(lon) - this.anchorLon) * this.metresPerDegreeLon,
            z: -(Number(lat) - this.anchorLat) * this.metresPerDegreeLat,
        };
    }

    _candidateSegments(polygons) {
        const candidates = new Set();
        for (const rings of polygons) {
            for (const rawRing of rings || []) {
                const ring = (rawRing || []).filter(finiteCoordinate)
                    .map((coordinate) => this.toLocal(coordinate[0], coordinate[1]));
                if (ring.length === 0) continue;
                let minX = Infinity;
                let maxX = -Infinity;
                let minZ = Infinity;
                let maxZ = -Infinity;
                for (const point of ring) {
                    minX = Math.min(minX, point.x);
                    maxX = Math.max(maxX, point.x);
                    minZ = Math.min(minZ, point.z);
                    maxZ = Math.max(maxZ, point.z);
                }
                const minCellX = Math.floor(minX / this.cellM);
                const maxCellX = Math.floor(maxX / this.cellM);
                const minCellZ = Math.floor(minZ / this.cellM);
                const maxCellZ = Math.floor(maxZ / this.cellM);
                for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
                    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
                        for (const segment of this.index.get(`${cellX}_${cellZ}`) || []) {
                            candidates.add(segment);
                        }
                    }
                }
            }
        }
        return candidates;
    }

    // Does this building fly OVER the corridor at the crossing? The plan test
    // cannot tell a deck from a wall, so it is asked here, from the lowest
    // surveyed geometry the building has (its z_min) against the ground and the
    // designed rail at that point. See core/structure-clearance.js for why the
    // soffit is the discriminating fact and what each verdict means.
    _overheadVerdict(formationAt, x, z, buildingBaseAslM, formation) {
        if (this.absoluteToSceneY === null) return null;
        const base = finiteOrNull(buildingBaseAslM);
        if (base === null) return null;
        const soffitY = finiteOrNull(this.absoluteToSceneY(base));
        const railY = finiteOrNull(formationAt?.railY);
        const coverM = typeof formation?.coverAtLocal === 'function'
            ? finiteOrNull(formation.coverAtLocal(x, z))
            : null;
        // cover is ground − rail, so the ground comes back by adding it on.
        const groundY = railY !== null && coverM !== null ? railY + coverM : null;
        return structureOverheadVerdict({
            soffitY,
            groundY,
            railY,
            clearanceNeededM: RAIL_TUBE_HEIGHT_ABOVE_RAIL_M,
        });
    }

    // Is any of this footprint standing over the excavation? The formation owns
    // the exact answer — its surface profile's terrain-cutout ring IS the hole —
    // so this asks rather than re-deriving a batter width that would drift out
    // of step with the one actually dug.
    //
    // Sampled rather than exhaustive: a footprint ring can carry hundreds of
    // vertices and this runs per candidate building on the streaming path. The
    // centre plus a bounded walk of the outer ring catches an overhang without
    // paying for every vertex of a cathedral.
    _standsOverOpenCut(polygons, centreX, centreZ) {
        const formation = this.railFormation ? this.railFormation() : null;
        if (!formation || typeof formation.isOpenCutAtLocal !== 'function') return false;
        // The excavation footprint decides on its own here. Gating it on cover
        // as well left buildings standing over ground the formation had already
        // carved away — the dangling rim leftovers by the portals, where the
        // terrain opens for a cut-and-cover mouth but the cover reads deep.
        // Where the world digs, the building goes; if a carve is wrong, that is
        // a bug in the carve, and the demolition must not paper over it by
        // disagreeing with the hole that is actually there.
        const open = (x, z) => formation.isOpenCutAtLocal(x, z);
        if (open(centreX, centreZ)) return true;
        for (const rings of polygons) {
            const outer = rings[0] || [];
            if (outer.length < 2) continue;
            // Walked along the EDGES, not vertex to vertex: a long wall with two
            // endpoints outside the cut can still cross it, and a thin overhang
            // between two vertices was slipping through a vertex-only sample.
            const perimeter = ringPerimeter(outer);
            const stepM = Math.max(
                OPEN_CUT_FOOTPRINT_MIN_STEP_M,
                perimeter / OPEN_CUT_FOOTPRINT_SAMPLES,
            );
            for (let index = 0; index < outer.length; index++) {
                const a = outer[index];
                const b = outer[(index + 1) % outer.length];
                const edge = Math.hypot(b.x - a.x, b.z - a.z);
                const steps = Math.max(1, Math.ceil(edge / stepM));
                for (let s = 0; s < steps; s++) {
                    const t = s / steps;
                    if (open(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t)) return true;
                }
            }
        }
        return false;
    }

    // Whether the track at this plan-position hit leaves the building's ground
    // untouched. Judged at the track point nearest the footprint centre — one
    // structure answer per hit, taken where the ghost would stand.
    _hitSpared(track, centreX, centreZ, buildingBaseAslM = null, objectId = null,
        overExcavation = false) {
        const dx = track.b.x - track.a.x;
        const dz = track.b.z - track.a.z;
        const lengthSquared = dx * dx + dz * dz;
        const t = lengthSquared < 1e-9 ? 0 : Math.max(0, Math.min(1,
            ((centreX - track.a.x) * dx + (centreZ - track.a.z) * dz) / lengthSquared,
        ));
        const x = track.a.x + dx * t;
        const z = track.a.z + dz * t;
        const formation = this.railFormation ? this.railFormation() : null;
        if (formation && typeof formation.formationAtLocal === 'function') {
            // No feature pin: the corridor features were smoothed separately
            // from the formation's, so identity never matches — but the query
            // point sits ON the corridor, and its own alignment is the nearest
            // by construction. Where a parallel line coincides, both are at
            // grade there and classify the same.
            const at = formation.formationAtLocal(x, z, {
                maxDistanceM: Math.max(track.halfWidthM * 2, 16),
            });
            if (at) {
                // A deck flies over; nothing below it is disturbed, whatever
                // the ground is doing.
                if (at.structure === 'viaduct') return true;
                // The other way round: OUR formation is open, but the building
                // is the one flying over. An overpass is not in the way of the
                // thing that passes under it, and razing a whole complex for a
                // deck it happens to reach across is the bug this fixes.
                // Checked before the open-formation rule below, which would
                // otherwise demolish it regardless.
                const overhead = this._overheadVerdict(at, x, z, buildingBaseAslM, formation);
                if (overhead && overhead.spared) {
                    if (overhead.reason === 'short-clearance' && objectId != null) {
                        this.clearanceShortfalls.set(String(objectId), {
                            objectId: String(objectId),
                            shortfallM: overhead.shortfallM,
                            clearanceM: overhead.clearanceM,
                            openingM: overhead.openingM,
                        });
                    }
                    return true;
                }
                // The footprint is over ground the formation has actually dug —
                // a cut-and-cover mouth carves the surface even where the cover
                // reads deep — so the cover rule below has nothing left to
                // decide. It was vetoing this case and leaving buildings on
                // excavated ground: whole walls standing at the rim with their
                // foundation skirt hanging into the trench.
                if (overExcavation) return false;
                // An open formation stays open even where the ground happens to
                // be deep beside it: a short high-cover span between two cuts
                // gets excavated along with them, and sparing it would leave a
                // building standing over the trench.
                if (at.structure !== 'tunnel') return false;
                // Inside a bore, the only thing that disturbs the surface is a
                // mouth — and a mouth is where the cover runs out, not where a
                // run index happens to end. The old form carved a fixed 24 m at
                // every run boundary, so a dip whose cover never fell below
                // 3.4 m produced two bores facing each other, a portal each, and
                // 109 m of demolished city block on ground the track never came
                // near. Ask the cover, at the point.
                //
                // The threshold is the design rule and not a policy dial: 8 m is
                // 7.3 m of tube above rail plus 0.7 m over the roof slab, so a
                // metre less cover is a metre of tunnel crown standing proud of
                // the hillside. Sparing a building there would perch it on a
                // roof that is not underground.
                const coverM = typeof formation.coverAtLocal === 'function'
                    ? formation.coverAtLocal(x, z)
                    : null;
                if (typeof coverM === 'number' && Number.isFinite(coverM)) {
                    return coverM >= DEFAULT_TUNNEL_COVER_THRESHOLD_M;
                }
                // Unknown cover is not "no cover". Keep the bore's benefit of
                // the doubt rather than inventing a demolition from a missing
                // terrain sample.
                return true;
            }
        }
        if (!track.relativeElevations) return false;
        // Flat world: a SLOPING underground segment is a ramp — an open carved
        // trench (see isPlannerUndergroundRampSegment) — so only LEVEL spans
        // can clear the ground, at bored depth below or deck height above.
        if (Math.abs(track.elevA - track.elevB) > 0.01) return false;
        if (track.elevA <= -DEFAULT_TUNNEL_COVER_THRESHOLD_M) return true;
        if (track.elevA >= DEFAULT_VIADUCT_FILL_THRESHOLD_M) return true;
        return false;
    }

    intersectsFeature(feature) {
        if (!supportsProposalTrackDemolition(feature)) return false;
        if (this.segments.length === 0) return false;
        const rawPolygons = normalizePolygons(feature?.geometry);
        if (rawPolygons.length === 0) return false;
        const polygons = rawPolygons.map((rings) => (rings || [])
            .map((ring) => (ring || []).filter(finiteCoordinate)
                .map((coordinate) => this.toLocal(coordinate[0], coordinate[1])))
            .filter((ring) => ring.length >= 2));
        let centreX = 0;
        let centreZ = 0;
        let centrePoints = 0;
        for (const rings of polygons) {
            for (const point of rings[0] || []) {
                centreX += point.x;
                centreZ += point.z;
                centrePoints += 1;
            }
        }
        if (centrePoints > 0) {
            centreX /= centrePoints;
            centreZ /= centrePoints;
        }
        const candidates = this._candidateSegments(rawPolygons);
        // One answer per BUILDING, not per segment: whether it stands over the
        // excavation is a fact about the footprint, and asking it per candidate
        // segment would let the same ground be open for one segment and closed
        // for its neighbour. Lazy — most candidates never need it.
        let overExcavationMemo = null;
        const overExcavation = () => {
            if (overExcavationMemo === null) {
                overExcavationMemo = this._standsOverOpenCut(polygons, centreX, centreZ);
            }
            return overExcavationMemo;
        };
        for (const track of candidates) {
            const radiusSquared = track.halfWidthM ** 2;
            // An open cut is a wedge, not a shaft. The construction envelope is
            // the level bed plus a metre, but the hole in the ground reaches out
            // to the toe of the batter, and a building standing on the SLOPE is
            // standing on nothing once the slope is dug. Beyond the bed the
            // formation's own cut footprint is the judge — see _standsOverOpenCut
            // — so this only has to be an upper bound on how far it can reach.
            const cutReachSquared = (track.halfWidthM + FORMATION_MAX_CUTOUT_REACH_M) ** 2;
            let nearestSquared = Infinity;
            for (const rings of polygons) {
                if (rings.length === 0) continue;
                if (pointInPolygon(track.a, rings) || pointInPolygon(track.b, rings)) {
                    nearestSquared = 0;
                    break;
                }
                for (const ring of rings) {
                    for (let index = 0; index < ring.length; index++) {
                        const a = ring[index];
                        const b = ring[(index + 1) % ring.length];
                        const d = segmentDistanceSquared(track.a, track.b, a, b);
                        if (d < nearestSquared) nearestSquared = d;
                        if (nearestSquared === 0) break;
                    }
                    if (nearestSquared === 0) break;
                }
                if (nearestSquared === 0) break;
            }
            const hit = nearestSquared <= radiusSquared
                || (nearestSquared <= cutReachSquared && overExcavation());
            if (hit && !this._hitSpared(
                track,
                centreX,
                centreZ,
                feature?.properties?.z_min,
                feature?.properties?.object_id,
                overExcavation(),
            )) return true;
        }
        return false;
    }

    // Buildings the corridor passes under, where the deck is too low for the
    // railway. Each carries the metres the alignment must drop to fit. Empty
    // when every crossing clears — nothing here is a demolition, only a
    // clearance the designer has not resolved yet.
    getClearanceShortfalls() {
        return Array.from(this.clearanceShortfalls.values());
    }
}
