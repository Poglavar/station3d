// Pure ground-surface audit. Given every surface a vertical ray meets at one
// plan point, decides whether what renders from above contradicts the
// canonical hierarchy in surface-hierarchy.js: a lower-ranked surface on top
// (inversion), a winner too close to resolve (coplanar), a firm sheet hanging
// over visible ground (floating), nothing visible where ground is loaded
// (void), or one feature published twice at the same place (duplicate).

import {
    SURFACE_CLASS,
    SURFACE_COVERAGE_STATE,
    SURFACE_POLICIES,
    SURFACE_ROLE,
    SURFACE_STENCIL_COMPARE,
    SURFACE_STENCIL_OPERATION,
    SURFACE_VERTICAL_RELATION,
    asSurfaceClaim,
    compileSurfaceClaim,
    surfacePolicy,
    surfaceStencilContract,
} from './surface-hierarchy.js';

export const SURFACE_AUDIT_CONTRACT = 'station3d-surface-audit-v3';

export const SURFACE_AUDIT_VIOLATION = Object.freeze({
    INVERSION: 'inversion',
    COPLANAR: 'coplanar',
    FLOATING: 'floating',
    VOID: 'void',
    DUPLICATE: 'duplicate',
    MISSING_PAINT: 'missing-paint',
});

const DEFAULT_CELL_M = 4;
// A triangle spanning more cells than this is checked by every query instead
// of being stamped into hundreds of cells (a 46 m road shard, a sea plane).
const MAX_CELLS_PER_TRIANGLE = 256;
const MIN_PLAN_AREA_M2 = 1e-6;
const SAME_HIT_EPSILON_M = 1e-6;
const DEPTH_BUFFER_BITS = 24;

function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function round(value, digits = 4) {
    return isFiniteNumber(value) ? Number(value.toFixed(digits)) : null;
}

// Smallest separation a standard (non-logarithmic) depth buffer resolves at
// this eye distance for a perspective camera with this near plane. Two stacked
// sheets closer than this are candidates for a depth precision problem. This
// estimate does not model slope, polygon offset, occlusion or actual GPU bits.
export function depthResolutionM(distanceM, nearM, bits = DEPTH_BUFFER_BITS) {
    if (!isFiniteNumber(distanceM) || !isFiniteNumber(nearM) || nearM <= 0) return null;
    return (distanceM * distanceM) / (nearM * 2 ** bits);
}

function transformInto(matrix, x, y, z, out, offset) {
    if (!matrix) {
        out[offset] = x;
        out[offset + 1] = y;
        out[offset + 2] = z;
        return;
    }
    // Column-major 4x4, as THREE.Matrix4#elements.
    const w = (matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15]) || 1;
    out[offset] = (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w;
    out[offset + 1] = (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w;
    out[offset + 2] = (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) / w;
}

// Plan-space (XZ) triangle index for one mesh, so a vertical ray at (x, z)
// visits only the triangles above that cell instead of the whole mesh.
export function buildPlanTriangleIndex({
    positions,
    itemSize = 3,
    index = null,
    matrix = null,
    bounds = null,
    drawStart = 0,
    drawCount = Infinity,
    cellM = DEFAULT_CELL_M,
    hitIdentity = null,
} = {}) {
    if (!positions || typeof positions.length !== 'number') {
        throw new TypeError('buildPlanTriangleIndex requires a positions array');
    }
    const vertexCount = Math.floor(positions.length / itemSize);
    const world = new Float64Array(vertexCount * 3);
    for (let vertex = 0; vertex < vertexCount; vertex++) {
        const source = vertex * itemSize;
        transformInto(
            matrix,
            positions[source],
            positions[source + 1],
            positions[source + 2],
            world,
            vertex * 3,
        );
    }
    const elementCount = index ? index.length : vertexCount;
    const start = Math.max(0, Math.floor(drawStart / 3) * 3);
    const end = Math.min(elementCount, isFiniteNumber(drawCount) ? start + drawCount : elementCount);
    const cells = new Map();
    const oversized = [];
    const elements = [];
    let triangleCount = 0;
    for (let element = start; element + 2 < end; element += 3) {
        const a = index ? index[element] : element;
        const b = index ? index[element + 1] : element + 1;
        const c = index ? index[element + 2] : element + 2;
        const ax = world[a * 3];
        const az = world[a * 3 + 2];
        const bx = world[b * 3];
        const bz = world[b * 3 + 2];
        const cx = world[c * 3];
        const cz = world[c * 3 + 2];
        const planArea = Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) * 0.5;
        // Vertical walls have no plan area: a vertical ray grazes them.
        if (!Number.isFinite(planArea) || planArea < MIN_PLAN_AREA_M2) continue;
        const minX = Math.min(ax, bx, cx);
        const maxX = Math.max(ax, bx, cx);
        const minZ = Math.min(az, bz, cz);
        const maxZ = Math.max(az, bz, cz);
        if (bounds && (maxX < bounds.minX || minX > bounds.maxX
            || maxZ < bounds.minZ || minZ > bounds.maxZ)) continue;
        triangleCount += 1;
        elements.push(element);
        const minCellX = Math.floor(minX / cellM);
        const maxCellX = Math.floor(maxX / cellM);
        const minCellZ = Math.floor(minZ / cellM);
        const maxCellZ = Math.floor(maxZ / cellM);
        if ((maxCellX - minCellX + 1) * (maxCellZ - minCellZ + 1) > MAX_CELLS_PER_TRIANGLE) {
            oversized.push(element);
            continue;
        }
        for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
            for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
                const key = `${cellX},${cellZ}`;
                const bucket = cells.get(key);
                if (bucket) bucket.push(element);
                else cells.set(key, [element]);
            }
        }
    }
    return { world, index, cells, oversized, elements, cellM, triangleCount, hitIdentity };
}

function collectTriangleHit(planIndex, element, x, z, out) {
    const { world, index } = planIndex;
    const a = index ? index[element] : element;
    const b = index ? index[element + 1] : element + 1;
    const c = index ? index[element + 2] : element + 2;
    const ax = world[a * 3];
    const ay = world[a * 3 + 1];
    const az = world[a * 3 + 2];
    const bx = world[b * 3];
    const by = world[b * 3 + 1];
    const bz = world[b * 3 + 2];
    const cx = world[c * 3];
    const cy = world[c * 3 + 1];
    const cz = world[c * 3 + 2];
    const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(det) < 1e-12) return;
    const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
    const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) return;
    const y = l1 * ay + l2 * by + l3 * cy;
    const identity = planIndex.hitIdentity?.(element / 3) ?? null;
    // A point on a shared edge lies in both neighbours; one mesh reports one
    // surface there, never a phantom duplicate of itself.
    for (const hit of out) {
        if (hit.identity === identity && Math.abs(hit.y - y) <= SAME_HIT_EPSILON_M) return;
    }
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    out.push({ y, faceIndex: element / 3, identity, normalY: length > 0 ? ny / length : 0 });
}

export function planTriangleHitsAt(planIndex, x, z, out = []) {
    if (!planIndex) return out;
    const key = `${Math.floor(x / planIndex.cellM)},${Math.floor(z / planIndex.cellM)}`;
    const bucket = planIndex.cells.get(key);
    if (bucket) {
        for (const element of bucket) collectTriangleHit(planIndex, element, x, z, out);
    }
    for (const element of planIndex.oversized) collectTriangleHit(planIndex, element, x, z, out);
    return out;
}

function stencilTestPasses(contract, stencil) {
    if (!contract?.enabled) return true;
    const mask = isFiniteNumber(contract.funcMask) ? contract.funcMask : 0xff;
    const ref = (isFiniteNumber(contract.ref) ? contract.ref : 0) & mask;
    const value = stencil & mask;
    if (contract.compare === SURFACE_STENCIL_COMPARE.EQUAL) return ref === value;
    if (contract.compare === SURFACE_STENCIL_COMPARE.NOT_EQUAL) return ref !== value;
    return true;
}

function stencilAfterPass(contract, stencil) {
    if (!contract?.enabled || contract.zPass !== SURFACE_STENCIL_OPERATION.REPLACE) return stencil;
    const writeMask = isFiniteNumber(contract.writeMask) ? contract.writeMask : 0xff;
    const ref = isFiniteNumber(contract.ref) ? contract.ref : 0;
    return (stencil & ~writeMask) | (ref & writeMask);
}

function normalizedHits(inputHits) {
    const hits = [];
    let invalidClaims = 0;
    for (const input of Array.isArray(inputHits) ? inputHits : []) {
        if (!input || !isFiniteNumber(input.y) || !input.claim) continue;
        let claim;
        try {
            claim = asSurfaceClaim(input.claim);
        } catch {
            // Counted and reported by the caller: a surface whose claim no
            // longer compiles cannot be judged, but must not vanish silently.
            invalidClaims += 1;
            continue;
        }
        hits.push({
            ...input,
            claim,
            policy: surfacePolicy(claim.surfaceClass),
            renderOrder: isFiniteNumber(input.renderOrder) ? input.renderOrder : 0,
        });
    }
    return { hits, invalidClaims };
}

function describeHit(hit) {
    return {
        surfaceClass: hit.claim.surfaceClass,
        y: round(hit.y),
        layerId: hit.layerId ?? null,
        objectName: hit.objectName ?? null,
        ownerId: hit.claim.ownerId ?? null,
        featureId: hit.claim.featureId ?? hit.featureId ?? null,
        publicationKey: hit.publicationKey ?? null,
        renderOrder: hit.renderOrder,
    };
}

function highestSurface(hits) {
    let best = null;
    for (const hit of hits) {
        if (!best
            || hit.y > best.y + SAME_HIT_EPSILON_M
            // Equal depth: a later draw wins a less-or-equal depth test.
            || (Math.abs(hit.y - best.y) <= SAME_HIT_EPSILON_M && hit.renderOrder >= best.renderOrder)) {
            best = hit;
        }
    }
    return best;
}

function highestRanked(hits) {
    let best = null;
    for (const hit of hits) {
        if (!best
            || hit.policy.rank > best.policy.rank
            || (hit.policy.rank === best.policy.rank && hit.y > best.y)) {
            best = hit;
        }
    }
    return best;
}

function violation(type, band, upper, lower, gapM, extra = {}) {
    return {
        type,
        band,
        upperClass: upper?.claim.surfaceClass ?? null,
        lowerClass: lower?.claim.surfaceClass ?? null,
        gapM: round(gapM),
        upper: upper ? describeHit(upper) : null,
        lower: lower ? describeHit(lower) : null,
        ...extra,
    };
}

function paintIdentity(hit) {
    return JSON.stringify([
        hit.paintKey ?? null, hit.publicationKey ?? null, hit.claim.verticalBand,
        hit.claim.surfaceClass, hit.claim.ownerId, hit.claim.featureId ?? hit.featureId ?? null,
    ]);
}

function hasGroundRole(hit) {
    return hit.policy.role !== SURFACE_ROLE.STRUCTURE
        && hit.policy.role !== SURFACE_ROLE.VOLUME
        && hit.policy.role !== SURFACE_ROLE.VOID;
}

// hits: [{ y, claim, renderOrder?, stencil?, colorWrite?, culled?, discarded?,
//          layerId?, objectName?, publicationKey?, featureId? }]
// `stencil` is the material's real stencil state as a surface stencil
// contract; `discarded` is true/false when a CPU twin of the shader discard
// was evaluated and null when none exists (treated as visible).
export function classifySurfaceStack(inputHits, {
    inversionToleranceM = 0.01,
    coplanarGapM = 0.002,
    floatingToleranceM = 0.3,
    duplicateToleranceM = 1e-4,
    terrainCovered = null,
    intentionalOpening = false,
    expectedHits = null,
} = {}) {
    const { hits, invalidClaims } = normalizedHits(inputHits);
    // Source coverage can be supplied independently of rendered triangles.
    // Until a producer provides it, its published mesh claim is intent; GPU
    // discard/culling/colorWrite are observations and cannot erase that intent.
    const intent = expectedHits === null ? { hits, invalidClaims: 0 } : normalizedHits(expectedHits);

    // Plan-only stencil, replayed in draw order. A vertical ray cannot know
    // what was in front of a writer on screen, so writes are assumed to pass
    // depth — exactly the assumption that made plan-only bits cut embankments.
    const drawOrder = hits
        .map((_hit, position) => position)
        .sort((first, second) => hits[first].renderOrder - hits[second].renderOrder || first - second);
    let stencil = 0;
    for (const position of drawOrder) {
        const hit = hits[position];
        hit.stencilHidden = false;
        if (hit.discarded === true || hit.culled === true) continue;
        if (!stencilTestPasses(hit.stencil, stencil)) {
            hit.stencilHidden = true;
            continue;
        }
        stencil = stencilAfterPass(hit.stencil, stencil);
    }
    for (const hit of hits) {
        hit.paints = hit.colorWrite !== false && hit.claim.capabilities.color === true;
        hit.visible = hit.paints && hit.culled !== true && hit.discarded !== true && !hit.stencilHidden;
    }

    const violations = [];
    const bands = new Map();
    for (const hit of [...hits, ...intent.hits]) {
        const band = hit.claim.verticalBand;
        // A deck is separated from terrain, but surfaces ON that deck still
        // compete. This is the hierarchy's pair-relative vertical-band rule.
        if (!band) continue;
        if (!bands.has(band)) bands.set(band, []);
    }
    for (const hit of hits) {
        bands.get(hit.claim.verticalBand)?.push(hit);
    }

    for (const [band, bandHits] of bands) {
        const ranked = bandHits.filter(hit => hit.policy.sameLevelComparable
            && isFiniteNumber(hit.policy.rank));
        const visible = ranked.filter(hit => hit.visible);
        const top = highestSurface(visible);
        const eligible = intent.hits.filter(hit => hit.claim.verticalBand === band
            && hit.policy.sameLevelComparable && isFiniteNumber(hit.policy.rank)
            && hit.claim.capabilities.color && hit.expected !== false
            && hit.claim.coverageState === SURFACE_COVERAGE_STATE.PUBLISHED);
        const expected = highestRanked(eligible);
        const observedExpected = expected && (hits.includes(expected) ? expected
            : ranked.find(hit => paintIdentity(hit) === paintIdentity(expected)));
        const hiddenCause = expected && (!observedExpected ? 'missing-paint'
            : observedExpected.discarded === true ? 'discard'
                : observedExpected.culled === true ? 'culling'
                    : !observedExpected.paints ? 'color-write'
                        : observedExpected.stencilHidden ? 'stencil' : null);

        if (top && expected && top !== observedExpected && top.policy.rank < expected.policy.rank) {
            const gapM = top.y - expected.y;
            if (hiddenCause) {
                violations.push(violation(
                    SURFACE_AUDIT_VIOLATION.INVERSION, band, top, expected, gapM, { cause: hiddenCause },
                ));
            } else if (gapM > inversionToleranceM) {
                violations.push(violation(
                    SURFACE_AUDIT_VIOLATION.INVERSION, band, top, expected, gapM, { cause: 'depth' },
                ));
            } else {
                // The winner sits below the loser by less than the tolerance:
                // which one shows depends on polygon offset and view angle.
                violations.push(violation(
                    SURFACE_AUDIT_VIOLATION.COPLANAR, band, expected, top, expected.y - top.y,
                ));
            }
        } else if (!top && expected && hasGroundRole(expected)
            && expected.claim.surfaceClass !== SURFACE_CLASS.TERRAIN) {
            violations.push(violation(
                SURFACE_AUDIT_VIOLATION.MISSING_PAINT, band, null, expected, null,
                { cause: hiddenCause || 'missing-paint' },
            ));
        } else if (top && expected && top.policy.rank >= expected.policy.rank) {
            // Two equally ranked/elevated owners need not be the same object
            // chosen by highestRanked(). Their tie cannot waive the depth gap
            // check against lower ranks. In particular, deleting a duplicate
            // must not appear to create previously hidden coplanar conflicts.
            let nearestBelow = null;
            for (const hit of visible) {
                if (hit === top
                    || hit.claim.surfaceClass === top.claim.surfaceClass
                    || hit.policy.rank >= top.policy.rank
                    || hit.y > top.y) continue;
                if (!nearestBelow || hit.y > nearestBelow.y) nearestBelow = hit;
            }
            if (nearestBelow && top.y - nearestBelow.y < coplanarGapM) {
                violations.push(violation(
                    SURFACE_AUDIT_VIOLATION.COPLANAR, band, top, nearestBelow, top.y - nearestBelow.y,
                ));
            }
        }

        let floating = null;
        for (const hit of visible) {
            if (hit.claim.surfaceClass === SURFACE_CLASS.TERRAIN) continue;
            let support = null;
            for (const candidate of bandHits) {
                if (candidate === hit
                    || !candidate.paints
                    || candidate.discarded === true
                    || candidate.culled === true
                    || candidate.y >= hit.y - SAME_HIT_EPSILON_M) continue;
                if (!support || candidate.y > support.y) support = candidate;
            }
            if (!support) continue;
            const gapM = hit.y - support.y;
            if (gapM > floatingToleranceM && (!floating || gapM > floating.gapM)) {
                floating = { hit, support, gapM };
            }
        }
        if (floating) {
            violations.push(violation(
                SURFACE_AUDIT_VIOLATION.FLOATING, band, floating.hit, floating.support, floating.gapM,
            ));
        }

        const copiesByFeature = new Map();
        for (const hit of visible) {
            const featureId = hit.claim.featureId ?? hit.featureId ?? null;
            if (featureId == null) continue;
            const key = `${hit.claim.surfaceClass}|${featureId}`;
            if (!copiesByFeature.has(key)) copiesByFeature.set(key, []);
            copiesByFeature.get(key).push(hit);
        }
        for (const copies of copiesByFeature.values()) {
            if (copies.length < 2) continue;
            const reference = copies[0];
            const stacked = copies.filter(hit => Math.abs(hit.y - reference.y) <= duplicateToleranceM);
            const keys = new Set(stacked.map(hit => hit.publicationKey ?? null));
            // Independent source owners can live in ONE merged drawing. A
            // publication key identifies its bucket, not a polygon lifetime.
            const owners = new Set(stacked.map(hit => JSON.stringify([
                hit.publicationKey ?? null, hit.ownerKey ?? null,
            ])));
            if (stacked.length < 2 || owners.size < 2) continue;
            violations.push(violation(
                SURFACE_AUDIT_VIOLATION.DUPLICATE, band, stacked[0], stacked[1], 0,
                { copies: stacked.length, publicationKeys: [...keys],
                    ownerKeys: [...new Set(stacked.map(hit => hit.ownerKey ?? null))] },
            ));
        }
    }

    const anyVisible = hits.some(hit => hit.visible && hasGroundRole(hit));
    if (terrainCovered === true && !anyVisible && intentionalOpening !== true) {
        violations.push({
            type: SURFACE_AUDIT_VIOLATION.VOID,
            band: null,
            upperClass: null,
            lowerClass: null,
            gapM: null,
            upper: null,
            lower: null,
        });
    }

    return {
        violations,
        invalidClaims: invalidClaims + intent.invalidClaims,
        hitCount: hits.length,
        coverage: {
            expectedPaint: intent.hits.some(hit => hit.claim.capabilities.color && hasGroundRole(hit)
                && hit.expected !== false && hit.claim.coverageState === SURFACE_COVERAGE_STATE.PUBLISHED),
            visibleGround: anyVisible,
            // Claimed support coverage, not a Rapier collider verification.
            support: hits.some(hit => hit.claim.capabilities.support
                && hit.claim.coverageState === SURFACE_COVERAGE_STATE.PUBLISHED),
        },
    };
}

// Static check of the compiled physical ladder, needing no scene. Depth can
// honour rank only when a higher-ranked same-level class sits above a lower
// one by more than the depth buffer resolves; below that, an explicit stencil
// relation (the higher class draws first and the lower one reads its bits)
// has to decide, or the winner is left to tessellation and polygon offset.
export function auditSurfaceLevelLadder({ minimumGapM = 0.003 } = {}) {
    const entries = [];
    // Classes whose height comes from their own geometry (curbs, rail steel,
    // dressing) are not on this ladder; they are listed, never paired.
    const undeclaredOffsetClasses = [];
    for (const [surfaceClass, policy] of Object.entries(SURFACE_POLICIES)) {
        if (!policy.sameLevelComparable || !isFiniteNumber(policy.rank) || !policy.capabilities.color) continue;
        // Water is recessed below ground by WATER_LEVELS, not stacked on it.
        if (policy.role === SURFACE_ROLE.RECESSED_SURFACE) continue;
        if (!isFiniteNumber(policy.sceneOffsetM) && surfaceClass !== SURFACE_CLASS.TERRAIN) {
            undeclaredOffsetClasses.push(surfaceClass);
            continue;
        }
        // Compile exactly as a publishing producer does: published, same
        // level, with support and backstop-cut opted in where policy allows.
        const compile = extra => compileSurfaceClaim({
            surfaceClass,
            coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
            verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
            verticalBand: 'ground',
            supportReady: true,
            cutsBackstop: true,
            ...extra,
        });
        const claim = compile();
        // Same-level trackbed arbitrates through its colourless prepass.
        const writerClaim = surfaceClass === SURFACE_CLASS.RAIL_TRACKBED
            ? compile({ paintsColor: false })
            : claim;
        entries.push({
            surfaceClass,
            rank: policy.rank,
            offsetM: isFiniteNumber(policy.sceneOffsetM) ? policy.sceneOffsetM : 0,
            renderOrder: isFiniteNumber(claim.technical.renderOrder) ? claim.technical.renderOrder : null,
            stencil: surfaceStencilContract(claim),
            writerRenderOrder: isFiniteNumber(writerClaim.technical.renderOrder)
                ? writerClaim.technical.renderOrder
                : null,
            writerStencil: surfaceStencilContract(writerClaim),
        });
    }
    const pairs = [];
    for (const upper of entries) {
        for (const lower of entries) {
            if (upper.rank <= lower.rank) continue;
            const gapM = upper.offsetM - lower.offsetM;
            if (gapM + 1e-9 >= minimumGapM) continue;
            const stencilArbitrated = upper.writerRenderOrder !== null
                && lower.renderOrder !== null
                && upper.writerRenderOrder < lower.renderOrder
                && upper.writerStencil?.enabled === true
                && lower.stencil?.enabled === true
                && !stencilTestPasses(lower.stencil, stencilAfterPass(upper.writerStencil, 0));
            pairs.push({
                upperClass: upper.surfaceClass,
                lowerClass: lower.surfaceClass,
                upperRank: upper.rank,
                lowerRank: lower.rank,
                gapM: round(gapM),
                kind: gapM < -1e-9 ? 'inverted' : Math.abs(gapM) <= 1e-9 ? 'equal' : 'fragile',
                stencilArbitrated,
            });
        }
    }
    pairs.sort((first, second) => second.upperRank - first.upperRank
        || second.lowerRank - first.lowerRank);
    return { minimumGapM, pairs, undeclaredOffsetClasses };
}

// samples: [{ x, z, lat?, lon?, violations }] — only samples that violated
// need to be passed; sampleCount carries the full grid size.
export function summarizeSurfaceAudit(samples, { stepM = 1, sampleCount = null } = {}) {
    const byType = Object.fromEntries(
        Object.values(SURFACE_AUDIT_VIOLATION).map(type => [type, 0]),
    );
    const pairs = new Map();
    let violatingSamples = 0;
    const list = Array.isArray(samples) ? samples : [];
    for (const sample of list) {
        const sampleViolations = Array.isArray(sample?.violations) ? sample.violations : [];
        if (sampleViolations.length > 0) violatingSamples += 1;
        for (const entry of sampleViolations) {
            byType[entry.type] = (byType[entry.type] || 0) + 1;
            const key = [entry.type, entry.cause || '', entry.upperClass || '', entry.lowerClass || ''].join('|');
            let pair = pairs.get(key);
            if (!pair) {
                pair = {
                    type: entry.type,
                    cause: entry.cause || null,
                    upperClass: entry.upperClass,
                    lowerClass: entry.lowerClass,
                    samples: 0,
                    areaM2: 0,
                    worstGapM: null,
                    worst: null,
                };
                pairs.set(key, pair);
            }
            pair.samples += 1;
            pair.areaM2 += stepM * stepM;
            const magnitude = isFiniteNumber(entry.gapM) ? Math.abs(entry.gapM) : 0;
            if (!pair.worst || magnitude > Math.abs(pair.worstGapM ?? 0)) {
                pair.worstGapM = entry.gapM;
                pair.worst = {
                    x: round(sample.x, 2),
                    z: round(sample.z, 2),
                    lat: round(sample.lat, 7),
                    lon: round(sample.lon, 7),
                    upper: entry.upper,
                    lower: entry.lower,
                };
            }
        }
    }
    return {
        contract: SURFACE_AUDIT_CONTRACT,
        sampleCount: isFiniteNumber(sampleCount) ? sampleCount : list.length,
        violatingSamples,
        byType,
        pairs: [...pairs.values()]
            .map(pair => ({ ...pair, areaM2: round(pair.areaM2, 1) }))
            .sort((first, second) => second.samples - first.samples),
    };
}
