// Builds one bounded Rapier trimesh from the same engineered road polygons and
// vertical profiles used by the visible Station3D asphalt surface.

import { ShapeUtils, Vector2 } from 'three';

import {
    buildFormationTerrainCollarGeometryData,
    buildRetainingWallPositions,
    refineTriangulatedSurface,
} from './road-formation.js';

function finiteNumberOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function boundsDistanceSquared(bounds, x, z) {
    if (!bounds) return Infinity;
    const dx = x < bounds.minX ? bounds.minX - x
        : x > bounds.maxX ? x - bounds.maxX : 0;
    const dz = z < bounds.minZ ? bounds.minZ - z
        : z > bounds.maxZ ? z - bounds.maxZ : 0;
    return dx * dx + dz * dz;
}

function openFiniteRing(ring) {
    const points = (Array.isArray(ring) ? ring : [])
        .map(point => ({
            x: finiteNumberOrNull(point?.x),
            z: finiteNumberOrNull(point?.z),
        }))
        .filter(point => point.x !== null && point.z !== null);
    if (points.length > 2) {
        const first = points[0];
        const last = points[points.length - 1];
        if (Math.hypot(first.x - last.x, first.z - last.z) <= 1e-6) points.pop();
    }
    return points;
}

export function buildRoadSurfaceTrimeshData({
    profiles = [],
    centerX,
    centerZ,
    radiusM,
    heightAt,
    toPhysics = (x, z) => ({ x, z }),
    maxProfiles = 96,
    maxTriangles = 8000,
    maxEdgeM = 8,
    surfaceOffsetM = 0.025,
} = {}) {
    const x = finiteNumberOrNull(centerX);
    const z = finiteNumberOrNull(centerZ);
    const radius = finiteNumberOrNull(radiusM);
    if (x === null || z === null || radius === null || radius <= 0
        || typeof heightAt !== 'function' || typeof toPhysics !== 'function') {
        return {
            vertices: new Float32Array(),
            indices: new Uint32Array(),
            surfaces: [],
            profileCount: 0,
            triangleCount: 0,
            truncated: false,
        };
    }
    const profileLimit = Math.max(0, Math.trunc(finiteNumberOrNull(maxProfiles) ?? 96));
    const triangleLimit = Math.max(0, Math.trunc(finiteNumberOrNull(maxTriangles) ?? 8000));
    const offsetY = finiteNumberOrNull(surfaceOffsetM) ?? 0;
    const candidates = (Array.isArray(profiles) ? profiles : [])
        .map(profile => ({
            profile,
            distanceSquared: boundsDistanceSquared(profile?.bounds, x, z),
        }))
        .filter(candidate => candidate.distanceSquared <= radius * radius)
        .sort((left, right) => left.distanceSquared - right.distanceSquared
            || String(left.profile?.osmId || '').localeCompare(String(right.profile?.osmId || '')));

    const vertices = [];
    const indices = [];
    const surfaces = [];
    let profileCount = 0;
    let truncated = candidates.length > profileLimit;
    for (const { profile } of candidates.slice(0, profileLimit)) {
        const ring = openFiniteRing(profile?.innerRing);
        if (ring.length < 3) continue;
        const contour = ring.map(point => new Vector2(point.x, point.z));
        const seedTriangles = ShapeUtils.triangulateShape(contour, []);
        if (seedTriangles.length === 0) continue;
        const remainingTriangles = triangleLimit - indices.length / 3;
        if (remainingTriangles < seedTriangles.length) {
            truncated = true;
            break;
        }
        const refined = refineTriangulatedSurface(
            ring,
            seedTriangles,
            maxEdgeM,
            remainingTriangles,
        );
        if (!refined || refined.triangles.length > remainingTriangles) {
            truncated = true;
            continue;
        }
        const profileVertices = [];
        let valid = true;
        for (const point of refined.points) {
            const roadY = finiteNumberOrNull(heightAt(point.x, point.z, profile));
            const physics = toPhysics(point.x, point.z);
            const physicsX = finiteNumberOrNull(physics?.x);
            const physicsZ = finiteNumberOrNull(physics?.z);
            if (roadY === null || physicsX === null || physicsZ === null) {
                valid = false;
                break;
            }
            profileVertices.push(physicsX, roadY + offsetY, physicsZ);
        }
        if (!valid) continue;

        const baseIndex = vertices.length / 3;
        const profileIndices = [];
        for (const triangle of refined.triangles) {
            const [a, b, c] = triangle;
            const ax = profileVertices[a * 3];
            const az = profileVertices[a * 3 + 2];
            const bx = profileVertices[b * 3];
            const bz = profileVertices[b * 3 + 2];
            const cx = profileVertices[c * 3];
            const cz = profileVertices[c * 3 + 2];
            const normalY = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
            if (normalY >= 0) profileIndices.push(a, b, c);
            else profileIndices.push(a, c, b);
        }
        vertices.push(...profileVertices);
        indices.push(...profileIndices.map(index => baseIndex + index));
        let minY = Infinity;
        let maxY = -Infinity;
        for (let index = 1; index < profileVertices.length; index += 3) {
            minY = Math.min(minY, profileVertices[index]);
            maxY = Math.max(maxY, profileVertices[index]);
        }
        surfaces.push({
            id: `${String(profile?.osmId ?? 'road')}:${profileCount}`,
            osmId: profile?.osmId ?? null,
            bounds: profile?.bounds ? { ...profile.bounds } : null,
            vertices: new Float32Array(profileVertices),
            indices: new Uint32Array(profileIndices),
            minY,
            maxY,
        });
        profileCount += 1;
        if (indices.length / 3 >= triangleLimit) {
            truncated = candidates.length > profileCount;
            break;
        }
    }
    return {
        vertices: new Float32Array(vertices),
        indices: new Uint32Array(indices),
        surfaces,
        profileCount,
        triangleCount: indices.length / 3,
        truncated,
    };
}

function triangleBoundsDistanceSquared(positions, ia, ib, ic, x, z) {
    const ax = positions[ia * 3];
    const az = positions[ia * 3 + 2];
    const bx = positions[ib * 3];
    const bz = positions[ib * 3 + 2];
    const cx = positions[ic * 3];
    const cz = positions[ic * 3 + 2];
    if (![ax, az, bx, bz, cx, cz].every(Number.isFinite)) return Infinity;
    return boundsDistanceSquared({
        minX: Math.min(ax, bx, cx),
        minZ: Math.min(az, bz, cz),
        maxX: Math.max(ax, bx, cx),
        maxZ: Math.max(az, bz, cz),
    }, x, z);
}

// Builds Rapier support from the exact vertex/index arrays published by the
// road renderer. This covers every visible road class, including pedestrian
// and shared streets that deliberately have no engineered formation profile.
// Triangles are clipped to the moving physics bubble and re-wound upward;
// rendering geometry can otherwise arrive clockwise or counter-clockwise.
export function* buildRenderedRoadSurfaceTrimeshDataSteps({
    parts = [],
    centerX,
    centerZ,
    radiusM,
    toPhysics = (x, z) => ({ x, z }),
    maxParts = 160,
    maxTriangles = 8000,
    trianglesPerStep = 128,
    includeMerged = true,
} = {}) {
    if (!Number.isSafeInteger(trianglesPerStep) || trianglesPerStep < 1) {
        throw new TypeError('Rendered road collider requires a positive triangle work limit');
    }
    const x = finiteNumberOrNull(centerX);
    const z = finiteNumberOrNull(centerZ);
    const radius = finiteNumberOrNull(radiusM);
    if (x === null || z === null || radius === null || radius <= 0
        || typeof toPhysics !== 'function') {
        return {
            vertices: new Float32Array(),
            indices: new Uint32Array(),
            surfaces: [],
            profileCount: 0,
            triangleCount: 0,
            truncated: false,
        };
    }
    const partLimit = Math.max(0, Math.trunc(finiteNumberOrNull(maxParts) ?? 160));
    const triangleLimit = Math.max(0, Math.trunc(
        finiteNumberOrNull(maxTriangles) ?? 8000,
    ));
    const radiusSquared = radius * radius;
    const candidates = (Array.isArray(parts) ? parts : [])
        .map(part => ({
            part,
            distanceSquared: boundsDistanceSquared(part?.bounds, x, z),
        }))
        .filter(candidate => candidate.distanceSquared <= radiusSquared)
        .sort((left, right) => left.distanceSquared - right.distanceSquared
            || String(left.part?.osmId || left.part?.id || '').localeCompare(
                String(right.part?.osmId || right.part?.id || ''),
            ));
    const vertices = [];
    const indices = [];
    const surfaces = [];
    let processedParts = 0;
    let scannedTriangles = 0;
    let triangleCount = 0;
    let truncated = candidates.length > partLimit;
    for (const { part } of candidates.slice(0, partLimit)) {
        processedParts += 1;
        const sourceVertices = part?.positions;
        const sourceIndices = part?.indices;
        if (!sourceVertices || sourceVertices.length < 9) continue;
        const sourceIndexCount = sourceIndices?.length ?? sourceVertices.length / 3;
        const surfaceVertices = [];
        const surfaceIndices = [];
        let minY = Infinity;
        let maxY = -Infinity;
        let triangleLimitReached = false;
        for (let offset = 0; offset + 2 < sourceIndexCount; offset += 3) {
            // Count rejected/far triangles too. A large polygon may cross the
            // bubble while most of its triangles are outside it.
            if (++scannedTriangles % trianglesPerStep === 0) {
                yield { phase: 'road-collider-triangles', scannedTriangles };
            }
            const ia = sourceIndices ? sourceIndices[offset] : offset;
            const ib = sourceIndices ? sourceIndices[offset + 1] : offset + 1;
            const ic = sourceIndices ? sourceIndices[offset + 2] : offset + 2;
            if (triangleBoundsDistanceSquared(
                sourceVertices,
                ia,
                ib,
                ic,
                x,
                z,
            ) > radiusSquared) continue;
            const triangle = [];
            let valid = true;
            for (const sourceIndex of [ia, ib, ic]) {
                const sourceOffset = sourceIndex * 3;
                const localX = finiteNumberOrNull(sourceVertices[sourceOffset]);
                const localY = finiteNumberOrNull(sourceVertices[sourceOffset + 1]);
                const localZ = finiteNumberOrNull(sourceVertices[sourceOffset + 2]);
                const physics = toPhysics(localX, localZ);
                const physicsX = finiteNumberOrNull(physics?.x);
                const physicsZ = finiteNumberOrNull(physics?.z);
                if (localX === null || localY === null || localZ === null
                    || physicsX === null || physicsZ === null) {
                    valid = false;
                    break;
                }
                triangle.push(physicsX, localY, physicsZ);
            }
            if (!valid) continue;
            // Reaching capacity is not truncation until another valid local
            // triangle needs a slot. Far/invalid trailing geometry is free.
            if (triangleCount + surfaceIndices.length / 3 >= triangleLimit) {
                truncated = true;
                triangleLimitReached = true;
                break;
            }
            const ax = triangle[0];
            const az = triangle[2];
            const bx = triangle[3];
            const bz = triangle[5];
            const cx = triangle[6];
            const cz = triangle[8];
            const normalY = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
            const baseIndex = surfaceVertices.length / 3;
            surfaceVertices.push(...triangle);
            if (normalY >= 0) surfaceIndices.push(baseIndex, baseIndex + 1, baseIndex + 2);
            else surfaceIndices.push(baseIndex, baseIndex + 2, baseIndex + 1);
            minY = Math.min(minY, triangle[1], triangle[4], triangle[7]);
            maxY = Math.max(maxY, triangle[1], triangle[4], triangle[7]);
        }
        if (surfaceIndices.length === 0) {
            if (triangleLimitReached) break;
            continue;
        }
        // The physics publisher partitions the per-surface data into bounded
        // native meshes, so it need not retain a second full merged copy.
        if (includeMerged) {
            const globalBaseIndex = vertices.length / 3;
            for (const value of surfaceVertices) vertices.push(value);
            for (const index of surfaceIndices) indices.push(globalBaseIndex + index);
        }
        triangleCount += surfaceIndices.length / 3;
        surfaces.push({
            id: String(part?.id || `rendered-road:${processedParts - 1}`),
            osmId: part?.osmId ?? null,
            bounds: part?.bounds ? { ...part.bounds } : null,
            vertices: new Float32Array(surfaceVertices),
            indices: new Uint32Array(surfaceIndices),
            minY,
            maxY,
        });
        if (triangleLimitReached) break;
    }
    return {
        vertices: new Float32Array(vertices),
        indices: new Uint32Array(indices),
        surfaces,
        profileCount: surfaces.length,
        triangleCount,
        truncated: truncated || processedParts < Math.min(candidates.length, partLimit),
    };
}

// Existing immediate callers use the same compiler. Shared ground publication
// consumes its bounded steps while the previous collider remains active.
export function buildRenderedRoadSurfaceTrimeshData(options) {
    const steps = buildRenderedRoadSurfaceTrimeshDataSteps(options);
    let next;
    do { next = steps.next(); } while (!next.done);
    return next.value;
}

export function mergeRoadSurfaceMeshes(surfaces = []) {
    const vertices = [];
    const indices = [];
    let minY = Infinity;
    let maxY = -Infinity;
    for (const surface of Array.isArray(surfaces) ? surfaces : []) {
        const sourceVertices = surface?.vertices;
        const sourceIndices = surface?.indices;
        if (!sourceVertices || !sourceIndices || sourceIndices.length === 0) continue;
        const baseIndex = vertices.length / 3;
        vertices.push(...sourceVertices);
        for (const index of sourceIndices) indices.push(baseIndex + index);
        if (Number.isFinite(surface.minY)) minY = Math.min(minY, surface.minY);
        if (Number.isFinite(surface.maxY)) maxY = Math.max(maxY, surface.maxY);
    }
    return {
        vertices: new Float32Array(vertices),
        indices: new Uint32Array(indices),
        triangleCount: indices.length / 3,
        minY: Number.isFinite(minY) ? minY : null,
        maxY: Number.isFinite(maxY) ? maxY : null,
    };
}

function triangleSurfaceYAtPoint(positions, x, z) {
    let supportY = null;
    for (let offset = 0; offset + 8 < positions.length; offset += 9) {
        const ax = positions[offset];
        const ay = positions[offset + 1];
        const az = positions[offset + 2];
        const bx = positions[offset + 3];
        const by = positions[offset + 4];
        const bz = positions[offset + 5];
        const cx = positions[offset + 6];
        const cy = positions[offset + 7];
        const cz = positions[offset + 8];
        const denominator = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        if (Math.abs(denominator) < 1e-9) continue;
        const aWeight = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz))
            / denominator;
        const bWeight = ((cz - az) * (x - cx) + (ax - cx) * (z - cz))
            / denominator;
        const cWeight = 1 - aWeight - bWeight;
        if (aWeight < -1e-7 || bWeight < -1e-7 || cWeight < -1e-7) continue;
        const y = aWeight * ay + bWeight * by + cWeight * cy;
        if (Number.isFinite(y) && (supportY === null || y > supportY)) supportY = y;
    }
    return supportY;
}

// Exact plan-view test of one triangle against the collider disc. A support
// bubble only owes coverage inside its radius, so a long formation profile
// that merely touches the bubble must not spend the budget on its far end.
function triangleIntersectsDisc(positions, offset, cx, cz, radiusSquared) {
    const ax = positions[offset], az = positions[offset + 2];
    const bx = positions[offset + 3], bz = positions[offset + 5];
    const px = positions[offset + 6], pz = positions[offset + 8];
    const pointSegment = (x0, z0, x1, z1) => {
        const dx = x1 - x0, dz = z1 - z0, lengthSquared = dx * dx + dz * dz;
        const t = lengthSquared > 0
            ? Math.max(0, Math.min(1, ((cx - x0) * dx + (cz - z0) * dz) / lengthSquared)) : 0;
        const ex = x0 + dx * t - cx, ez = z0 + dz * t - cz;
        return ex * ex + ez * ez;
    };
    if (pointSegment(ax, az, bx, bz) <= radiusSquared
        || pointSegment(bx, bz, px, pz) <= radiusSquared
        || pointSegment(px, pz, ax, az) <= radiusSquared) return true;
    // Disc centre inside the triangle (all three edge signs agree).
    const d1 = (cx - bx) * (az - bz) - (ax - bx) * (cz - bz);
    const d2 = (cx - px) * (bz - pz) - (bx - px) * (cz - pz);
    const d3 = (cx - ax) * (pz - az) - (px - ax) * (cz - az);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

function formationDressingPositions(profile, surfaceOffsetM) {
    return [
        buildRetainingWallPositions(profile, surfaceOffsetM),
        buildFormationTerrainCollarGeometryData(profile).positions,
    ];
}

// Returns the exact rendered retaining-wall/collar elevation beside a road.
// This is used only for an enterable parked car's initial root; normal road
// driving continues to use the road polygon and Rapier ray-cast suspension.
export function roadFormationDressingSupportYAtPoint({
    profiles = [],
    x,
    z,
    surfaceOffsetM = 0.025,
} = {}) {
    const localX = finiteNumberOrNull(x);
    const localZ = finiteNumberOrNull(z);
    if (localX === null || localZ === null) return null;
    let supportY = null;
    for (const profile of Array.isArray(profiles) ? profiles : []) {
        const bounds = profile?.overlapBounds || profile?.terrainCutoutBounds
            || profile?.outerBounds || profile?.bounds;
        if (bounds && (localX < bounds.minX || localX > bounds.maxX
            || localZ < bounds.minZ || localZ > bounds.maxZ)) continue;
        for (const positions of formationDressingPositions(profile, surfaceOffsetM)) {
            const y = triangleSurfaceYAtPoint(positions, localX, localZ);
            if (y !== null && (supportY === null || y > supportY)) supportY = y;
        }
    }
    return supportY;
}

// The visible terrain is deliberately cut away under a road formation's
// retaining face and terrain-coloured collar. Those exact rendered triangles
// must therefore be Rapier support too; otherwise a wheel that leaves the
// asphalt can enter a real plan-view hole between road and raw terrain.
export function buildRoadFormationDressingTrimeshData({
    profiles = [],
    centerX,
    centerZ,
    radiusM,
    toPhysics = (x, z) => ({ x, z }),
    maxTriangles = 8000,
    surfaceOffsetM = 0.025,
} = {}) {
    const x = finiteNumberOrNull(centerX);
    const z = finiteNumberOrNull(centerZ);
    const radius = finiteNumberOrNull(radiusM);
    if (x === null || z === null || radius === null || radius <= 0
        || typeof toPhysics !== 'function') {
        return {
            vertices: new Float32Array(),
            indices: new Uint32Array(),
            profileCount: 0,
            triangleCount: 0,
            truncated: false,
        };
    }
    const triangleLimit = Math.max(
        0,
        Math.trunc(finiteNumberOrNull(maxTriangles) ?? 8000),
    );
    const candidates = (Array.isArray(profiles) ? profiles : [])
        .map(profile => ({
            profile,
            distanceSquared: boundsDistanceSquared(
                profile?.overlapBounds || profile?.terrainCutoutBounds
                    || profile?.outerBounds || profile?.bounds,
                x,
                z,
            ),
        }))
        .filter(candidate => candidate.distanceSquared <= radius * radius)
        .sort((left, right) => left.distanceSquared - right.distanceSquared
            || String(left.profile?.osmId || '').localeCompare(
                String(right.profile?.osmId || ''),
            ));
    const vertices = [];
    const indices = [];
    const radiusSquared = radius * radius;
    let profileCount = 0;
    let truncated = false;
    // Once over capacity, keep counting (without storing) so the failure
    // reports how much complete coverage this bubble actually needed.
    let requiredTriangles = 0;
    for (const { profile } of candidates) {
        let contributed = false;
        for (const positions of formationDressingPositions(profile, surfaceOffsetM)) {
            for (let offset = 0; offset + 8 < positions.length; offset += 9) {
                if (!triangleIntersectsDisc(positions, offset, x, z, radiusSquared)) continue;
                if (truncated || indices.length / 3 >= triangleLimit) {
                    truncated = true;
                    requiredTriangles += 1;
                    continue;
                }
                const baseIndex = vertices.length / 3;
                let valid = true;
                for (let vertex = 0; vertex < 3; vertex += 1) {
                    const source = offset + vertex * 3;
                    const localVertexX = finiteNumberOrNull(positions[source]);
                    const localVertexY = finiteNumberOrNull(positions[source + 1]);
                    const localVertexZ = finiteNumberOrNull(positions[source + 2]);
                    const physics = toPhysics(localVertexX, localVertexZ);
                    const physicsX = finiteNumberOrNull(physics?.x);
                    const physicsZ = finiteNumberOrNull(physics?.z);
                    if (localVertexX === null || localVertexY === null
                        || localVertexZ === null || physicsX === null || physicsZ === null) {
                        valid = false;
                        break;
                    }
                    vertices.push(physicsX, localVertexY, physicsZ);
                }
                if (!valid) {
                    vertices.length = baseIndex * 3;
                    continue;
                }
                indices.push(baseIndex, baseIndex + 1, baseIndex + 2);
                requiredTriangles += 1;
                contributed = true;
            }
        }
        if (contributed) profileCount += 1;
    }
    return {
        vertices: new Float32Array(vertices),
        indices: new Uint32Array(indices),
        profileCount,
        triangleCount: indices.length / 3,
        requiredTriangles,
        candidateProfiles: candidates.length,
        truncated,
    };
}
