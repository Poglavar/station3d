// Tiled query half of a ground publication. Rendering, formations, masks and
// physics join the SAME surface-registry batch; this module cannot publish a
// mesh or trigger an independent re-drape. Preparation is cooperative; commit
// swaps a prebuilt table. The existing TerrainReference remains the sampler.

import { TerrainReference, TerrainGrid, MosaicTerrainGrid, CompositeTerrainGrid } from './terrain-grid.js';
import { terrainLatticeStepForBounds } from './terrain-lattice.js';
import { terrainReceiverSceneYAtLocal, terrainReceiverTrianglesInBounds,
    MAX_TERRAIN_RECEIVER_TRIANGLES_PER_CELL } from './terrain-receiver-query.js';

const CHECKS_PER_STEP = 64;
const TOLERANCE_M = 0.001;
const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);
const tileKey = (x, z) => `${x}_${z}`;

function fail(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    throw error;
}

function* sourceBuffers(snapshot) {
    const pending = [snapshot.source.grid];
    while (pending.length) {
        const grid = pending.pop();
        if (!(grid instanceof TerrainGrid || grid instanceof MosaicTerrainGrid || grid instanceof CompositeTerrainGrid)) {
            fail('terrain-publication-source', 'Cannot budget an unknown terrain source representation');
        }
        if (grid.values?.buffer) yield grid.values.buffer;
        if (grid.sourceValues?.buffer) yield grid.sourceValues.buffer;
        if (Array.isArray(grid.items)) for (const item of grid.items) {
            pending.push(item.grid);
            yield null;
        }
        if (grid.base) pending.push(grid.base, ...(grid.details || []));
        // Do not hide a large mosaic walk in the next buffer-bearing visit.
        yield null;
    }
}

function* validateReceiverSteps(receiver, { positions, indices, segments, step, key, maxReceiverBytes }) {
    const output = receiver?.positions, faces = receiver?.indices, offsets = receiver?.sourceTriangleOffsets;
    if (!(output instanceof Float32Array) || output.length % 3
        || !(faces instanceof Uint32Array || faces instanceof Uint16Array) || faces.length % 3) {
        fail('terrain-publication-receiver', 'Terrain receiver requires complete typed geometry', { key });
    }
    const buffers = new Set([output.buffer, faces.buffer]);
    if (offsets) buffers.add(offsets.buffer);
    let bytes = 0;
    for (const buffer of buffers) {
        if (!buffer) fail('terrain-publication-receiver', 'Invalid receiver buffer', { key });
        bytes += buffer.byteLength;
    }
    if (bytes > maxReceiverBytes) fail('terrain-publication-capacity', 'Terrain receiver exceeds its byte budget', { key });
    if (!offsets) {
        if (output !== positions || faces !== indices) {
            fail('terrain-publication-receiver', 'A changed receiver requires its source-face index', { key });
        }
        return;
    }
    if (!(offsets instanceof Uint32Array) || offsets.length !== segments ** 2 * 2 + 1
        || offsets[0] !== 0 || offsets.at(-1) !== faces.length) {
        fail('terrain-publication-receiver', 'Invalid terrain source-face index', { key });
    }
    let deadline = performance.now() + .5;
    const point = index => ({ x: positions[index * 3], y: positions[index * 3 + 1], z: positions[index * 3 + 2] });
    const cross = (a, b, c) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
    for (let sourceFace = 0; sourceFace < offsets.length - 1; sourceFace++) {
        const start = offsets[sourceFace], end = offsets[sourceFace + 1];
        if (sourceFace % 2 === 0 && offsets[sourceFace + 2] - start > MAX_TERRAIN_RECEIVER_TRIANGLES_PER_CELL * 3) {
            fail('terrain-publication-capacity', 'Terrain receiver cell exceeds its point-query budget', { key, sourceFace });
        }
        if (end < start || start % 3 || end % 3 || end > faces.length) {
            fail('terrain-publication-receiver', 'Non-monotone terrain source-face index', { key, sourceFace });
        }
        const a = point(indices[sourceFace * 3]), b = point(indices[sourceFace * 3 + 1]), c = point(indices[sourceFace * 3 + 2]);
        const denominator = cross(a, b, c), tolerance = TOLERANCE_M / step;
        for (let offset = start; offset < end; offset += 3) {
            const triangle = [];
            for (let corner = 0; corner < 3; corner++) {
                const index = faces[offset + corner];
                if (index >= output.length / 3) fail('terrain-publication-receiver', 'Invalid terrain receiver index', { key });
                const q = { x: output[index * 3], y: output[index * 3 + 1], z: output[index * 3 + 2] };
                const wa = cross(q, b, c) / denominator, wb = cross(a, q, c) / denominator, wc = 1 - wa - wb;
                if (![q.x, q.y, q.z, wa, wb, wc].every(isFiniteNumber)
                    || Math.min(wa, wb, wc) < -tolerance || Math.max(wa, wb, wc) > 1 + tolerance
                    || Math.abs(q.y - (wa * a.y + wb * b.y + wc * c.y)) > TOLERANCE_M) {
                    fail('terrain-publication-mesh-query', 'Terrain receiver differs from its original lattice face', { key, sourceFace });
                }
                triangle.push(q);
            }
            if (cross(...triangle) >= 0) fail('terrain-publication-receiver', 'Terrain receiver reverses or collapses a source face', { key, sourceFace });
            if (performance.now() >= deadline) { yield { phase: 'receiver-face' }; deadline = performance.now() + .5; }
        }
        if (performance.now() >= deadline) { yield { phase: 'receiver-source-face' }; deadline = performance.now() + .5; }
    }
}

// Limits are required at the integration boundary: silent defaults would hide
// the retained old source windows and staging peak from the ground budget.
export function createPublishedTerrainReference(frame, {
    tileM, maxTiles, maxChangedTiles, maxSnapshots, maxReadSnapshots, maxSourceBytes, maxReceiverBytes, maxSegments,
}) {
    if (frame?.contract !== 'station3d-terrain-read-snapshot-v1') {
        throw new TypeError('Published terrain requires an immutable session frame');
    }
    // Keep only the datum/configuration. Capturing the initial snapshot here
    // would pin its entire source mosaic even after its last tile is retired.
    frame = Object.freeze(Object.fromEntries(['contract', 'anchorLon', 'anchorLat', 'anchorHeightM',
        'fallbackHeightM', 'metresPerDegreeLon', 'metresPerDegreeLat', 'surfaceStepM']
        .map(key => [key, frame[key]])));
    if (Object.entries(frame).some(([key, value]) => key !== 'contract' && !isFiniteNumber(value))
        || frame.surfaceStepM <= 0) throw new TypeError('Invalid published terrain session frame');
    for (const [name, value] of Object.entries({
        tileM, maxTiles, maxChangedTiles, maxSnapshots, maxReadSnapshots, maxSourceBytes, maxReceiverBytes, maxSegments,
    })) {
        if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`Invalid terrain limit ${name}`);
    }
    const listeners = new Set();
    const readSnapshots = new Set();
    let state = { byX: new Map(), tiles: new Map(), snapshots: new Set(), buffers: new Set(), receiverBuffers: new Set(), revision: 0,
        usage: Object.freeze({ tiles: 0, snapshots: 0, sourceBytes: 0, peakSourceBytes: 0, receiverBytes: 0, peakReceiverBytes: 0 }) };
    let pending = null;
    let preparedState = null;
    let cachedUsage = null;
    let closed = false;
    let readReleaseRevision = 0;
    let lastChange = null;
    const fallbackY = frame.fallbackHeightM - frame.anchorHeightM;
    const lookup = (table, x, z) => table.get(x)?.get(z) || null;
    const tileAt = (x, z, table) => {
        if (!isFiniteNumber(x) || !isFiniteNumber(z)) return null;
        const i = Math.floor(x / tileM), j = Math.floor(z / tileM);
        const primary = lookup(table, i, j);
        if (primary) return primary;
        // Mesh boundaries are closed. Prefer the positive-side tile, but retain
        // coverage at an outer edge when only the negative-side tile exists.
        const onX = x === i * tileM, onZ = z === j * tileM;
        return (onX && lookup(table, i - 1, j))
            || (onZ && lookup(table, i, j - 1))
            || (onX && onZ && lookup(table, i - 1, j - 1)) || null;
    };
    const local = (lon, lat) => ({
        x: isFiniteNumber(lon) ? (lon - frame.anchorLon) * frame.metresPerDegreeLon : NaN,
        z: isFiniteNumber(lat) ? -(lat - frame.anchorLat) * frame.metresPerDegreeLat : NaN,
    });
    const sameFrame = snapshot => snapshot?.contract === frame.contract
        && ['anchorLon', 'anchorLat', 'anchorHeightM', 'fallbackHeightM', 'surfaceStepM']
            .every(key => isFiniteNumber(snapshot[key]) && snapshot[key] === frame[key]);

    // Derived road/rail callbacks may close over this view. Each derived owner
    // retains it explicitly; the shared query stays valid until the LAST owner
    // releases. Every owner participates in admission and retained-source peak.
    function captureReadSnapshot(tableState, owner, shared = { state: tableState, readers: 0 }) {
        if (closed) fail('terrain-publication-closed', 'Published terrain session is closed');
        if (!shared.state) fail('terrain-read-released', 'Terrain read snapshot was released', { owner });
        if (typeof owner !== 'string' || !owner.trim()) throw new TypeError('Terrain read snapshot requires an owner');
        if (readSnapshots.size >= maxReadSnapshots) fail('terrain-publication-capacity', 'Too many retained terrain read snapshots');
        const retained = { state: tableState, owner, shared };
        shared.readers++;
        readSnapshots.add(retained);
        cachedUsage = null;
        const query = createQueries(() => {
            if (!shared.state) fail('terrain-read-released', 'Terrain read snapshot was released', { owner });
            return shared.state;
        });
        return Object.freeze({ ...query, contract: 'station3d-ground-read-snapshot-v1',
            revision: tableState.revision,
            retain: nextOwner => captureReadSnapshot(shared.state, nextOwner, shared),
            release() {
                if (!retained.state) return false;
                retained.state = null;
                if (--shared.readers === 0) shared.state = null;
                readReleaseRevision++;
                readSnapshots.delete(retained); cachedUsage = null; return true;
            },
        });
    }

    function* prepareSteps(replacements, { removeKeys = [], reason = 'terrain-published' } = {}) {
        if (closed) fail('terrain-publication-closed', 'Published terrain session is closed');
        if (pending) fail('terrain-publication-pending', 'Settle or discard the existing terrain candidate');
        if (!Array.isArray(replacements) || !Array.isArray(removeKeys)
            || replacements.length + removeKeys.length > maxChangedTiles) {
            fail('terrain-publication-capacity', 'Invalid or excessive terrain replacement set');
        }
        const token = {};
        pending = token;
        if (!replacements.length && !removeKeys.length) {
            const previous = state;
            let status = 'prepared';
            return Object.freeze({
                get state() { return status; }, usage: previous.usage,
                captureReadSnapshot: owner => {
                    if (!['prepared', 'committed'].includes(status)) fail('terrain-publication-settled', 'Terrain read candidate settled');
                    return captureReadSnapshot(previous, owner);
                },
                isCurrent: () => !closed && pending === token && state === previous && status === 'prepared',
                commit() {
                    if (closed || pending !== token || state !== previous || status !== 'prepared') return false;
                    status = 'committed'; return true;
                },
                rollback() { if (status !== 'committed') return false; status = 'prepared'; return true; },
                discard() { if (status !== 'prepared') return false; status = 'discarded'; if (pending === token) pending = null; return true; },
                notify() { if (status !== 'committed') return false; status = 'published'; if (pending === token) pending = null; return true; },
            });
        }
        let handedOff = false;
        try {
            const previous = state;
            const nextTiles = new Map();
            for (const [key, tile] of previous.tiles) { nextTiles.set(key, tile); yield { phase: 'retain-tile' }; }
            const changed = new Map();
            for (const key of removeKeys) {
                if (typeof key !== 'string' || !/^-?\d+_-?\d+$/.test(key) || changed.has(key)) {
                    fail('terrain-publication-tile', 'Invalid or duplicate terrain removal');
                }
                const old = previous.tiles.get(key);
                if (!old) fail('terrain-publication-tile', 'Cannot remove an unpublished terrain tile');
                changed.set(key, old);
                nextTiles.delete(key);
                yield { phase: 'remove-tile' };
            }
            for (const row of replacements) {
                const { tileX, tileZ, snapshot, segments, positions, indices } = row || {};
                const key = tileKey(tileX, tileZ);
                if (!Number.isSafeInteger(tileX) || !Number.isSafeInteger(tileZ)
                    || !Number.isSafeInteger(segments) || segments < 1 || segments > maxSegments
                    || !sameFrame(snapshot) || changed.has(key)) {
                    fail('terrain-publication-tile', 'Invalid terrain candidate or session datum', { key });
                }
                const step = tileM / segments;
                const x0 = tileX * tileM, z0 = tileZ * tileM;
                if (snapshot.sampleStepMAtLocal(x0 + tileM / 2, z0 + tileM / 2) !== step
                    || (snapshot.detail && snapshot.detail.tileM !== tileM)
                    || !(positions instanceof Float32Array) || positions.length !== (segments + 1) ** 2 * 3
                    || !(indices instanceof Uint32Array || indices instanceof Uint16Array)
                    || indices.length !== segments ** 2 * 6) {
                    fail('terrain-publication-lattice', 'Terrain mesh dimensions do not match its sampler', { key });
                }
                const side = segments + 1;
                // Check actual packet positions and the b-c diagonal. With the
                // same grid and affine triangles, a <=1 mm vertex error bounds
                // the entire triangle; a vertex-only test without topology does not.
                for (let vertex = 0; vertex < side ** 2; vertex++) {
                    const x = (vertex % side) * step, z = Math.floor(vertex / side) * step;
                    const offset = vertex * 3;
                    const expectedY = snapshot.sceneYAtLocal(x0 + x, z0 + z);
                    if (!isFiniteNumber(expectedY) || !isFiniteNumber(positions[offset + 1])
                        || Math.abs(positions[offset] - x) > TOLERANCE_M
                        || Math.abs(positions[offset + 2] - z) > TOLERANCE_M
                        || Math.abs(positions[offset + 1] - expectedY) > TOLERANCE_M) {
                        fail('terrain-publication-mesh-query', 'Terrain packet differs from its captured query', { key, vertex });
                    }
                    if ((vertex + 1) % CHECKS_PER_STEP === 0) yield { phase: 'mesh-query', checked: CHECKS_PER_STEP };
                }
                yield { phase: 'mesh-query-tail' };
                for (let cell = 0; cell < segments ** 2; cell++) {
                    const a = Math.floor(cell / segments) * side + cell % segments;
                    const b = a + 1, c = a + side, d = c + 1;
                    const offset = cell * 6;
                    if (indices[offset] !== a || indices[offset + 1] !== c || indices[offset + 2] !== b
                        || indices[offset + 3] !== b || indices[offset + 4] !== c || indices[offset + 5] !== d) {
                        fail('terrain-publication-diagonal', 'Terrain packet uses a different lattice diagonal', { key, cell });
                    }
                    if ((cell + 1) % CHECKS_PER_STEP === 0) yield { phase: 'mesh-topology', checked: CHECKS_PER_STEP };
                }
                // Keep the raw lattice validation above distinct from the
                // clipped receiver. Physics retains these exact receiver
                // positions/indices; it does not reconstruct openings later.
                const receiver = row.receiver || { positions, indices, sourceTriangleOffsets: null };
                yield* validateReceiverSteps(receiver, { positions, indices, segments, step, key, maxReceiverBytes });
                const tile = Object.freeze({ key, tileX, tileZ, tileM, snapshot, segments,
                    receiver: Object.freeze({ positions: receiver.positions, indices: receiver.indices,
                        sourceTriangleOffsets: receiver.sourceTriangleOffsets || null }) });
                changed.set(key, tile);
                nextTiles.set(key, tile);
                yield { phase: 'candidate-tile' };
            }
            if (nextTiles.size > maxTiles) fail('terrain-publication-capacity', 'Too many retained terrain tiles');
            const byX = new Map();
            const snapshots = new Set();
            for (const tile of nextTiles.values()) {
                let byZ = byX.get(tile.tileX);
                if (!byZ) byX.set(tile.tileX, byZ = new Map());
                byZ.set(tile.tileZ, tile);
                snapshots.add(tile.snapshot);
                yield { phase: 'index-tile' };
            }
            if (snapshots.size > maxSnapshots) fail('terrain-publication-capacity', 'Too many retained terrain snapshots');
            const activeBuffers = new Set(), peakBuffers = new Set(), receiverBuffers = new Set(), peakReceiverBuffers = new Set();
            let sourceBytes = 0, peakSourceBytes = 0, receiverBytes = 0, peakReceiverBytes = 0;
            for (const tile of nextTiles.values()) for (const array of Object.values(tile.receiver)) if (array) {
                if (!receiverBuffers.has(array.buffer)) { receiverBuffers.add(array.buffer); receiverBytes += array.buffer.byteLength; }
                yield { phase: 'receiver-residency' };
            }
            for (const buffers of [receiverBuffers, ...[...new Set([previous, ...[...readSnapshots].map(view => view.state)])]
                .map(table => table.receiverBuffers)]) for (const buffer of buffers) {
                if (!peakReceiverBuffers.has(buffer)) { peakReceiverBuffers.add(buffer); peakReceiverBytes += buffer.byteLength; }
                if (peakReceiverBytes > maxReceiverBytes) fail('terrain-publication-capacity', 'Terrain receivers and retained readers exceed their byte budget');
                yield { phase: 'receiver-peak' };
            }
            for (const snapshot of snapshots) for (const buffer of sourceBuffers(snapshot)) {
                if (buffer && !activeBuffers.has(buffer)) { activeBuffers.add(buffer); sourceBytes += buffer.byteLength; }
                yield { phase: 'source-residency' };
            }
            const peakSnapshots = new Set(snapshots);
            for (const table of new Set([previous, ...[...readSnapshots].map(view => view.state)])) {
                for (const snapshot of table.snapshots) { peakSnapshots.add(snapshot); yield { phase: 'retained-read-source' }; }
            }
            if (peakSnapshots.size > maxSnapshots) fail('terrain-publication-capacity', 'Terrain source staging and retained readers exceed the snapshot budget');
            for (const snapshot of peakSnapshots) {
                for (const buffer of sourceBuffers(snapshot)) {
                    if (buffer && !peakBuffers.has(buffer)) { peakBuffers.add(buffer); peakSourceBytes += buffer.byteLength; }
                    if (peakSourceBytes > maxSourceBytes) fail('terrain-publication-capacity', 'Terrain source staging exceeds its byte budget');
                    yield { phase: 'source-peak' };
                }
            }
            // A coarse/fine edge is piecewise linear. Test the UNION of both
            // edge breakpoint sets, including corners. This catches a fine
            // bump between equal coarse endpoints instead of approving a crack.
            for (const tile of changed.values()) {
                if (!nextTiles.has(tile.key)) continue;
                for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
                    if (dx === 0 && dz === 0) continue;
                    const neighbour = lookup(byX, tile.tileX + dx, tile.tileZ + dz);
                    if (!neighbour) continue;
                    const x = (tile.tileX + (dx > 0 ? 1 : 0)) * tileM;
                    const z = (tile.tileZ + (dz > 0 ? 1 : 0)) * tileM;
                    const aStep = tileM / tile.segments, bStep = tileM / neighbour.segments;
                    let aIndex = 0, bIndex = 0;
                    while (true) {
                        const distance = dx !== 0 && dz !== 0 ? 0 : Math.min(aIndex * aStep, bIndex * bStep);
                        if (distance > tileM) break;
                        const px = dx === 0 ? tile.tileX * tileM + distance : x;
                        const pz = dz === 0 ? tile.tileZ * tileM + distance : z;
                        const y = tile.snapshot.sceneYAtLocal(px, pz);
                        const otherY = neighbour.snapshot.sceneYAtLocal(px, pz);
                        if (!isFiniteNumber(y) || !isFiniteNumber(otherY) || Math.abs(y - otherY) > TOLERANCE_M) {
                            fail('terrain-publication-seam', 'Terrain dependency region must include the changed neighbour', {
                                key: tile.key, neighbourKey: neighbour.key, x: px, z: pz, y, neighbourY: otherY,
                            });
                        }
                        yield { phase: 'seam', checked: 1 };
                        if (dx !== 0 && dz !== 0) break;
                        if (aIndex * aStep <= distance) aIndex++;
                        if (bIndex * bStep <= distance) bIndex++;
                    }
                }
            }
            const usage = Object.freeze({ tiles: nextTiles.size, snapshots: snapshots.size, sourceBytes, peakSourceBytes, receiverBytes, peakReceiverBytes });
            if (closed || pending !== token) fail('terrain-publication-closed', 'Terrain preparation outlived its session');
            let successor = { byX, tiles: nextTiles, snapshots, buffers: activeBuffers, receiverBuffers, revision: previous.revision + 1, usage };
            preparedState = successor;
            cachedUsage = null;
            let oldState = previous;
            let status = 'prepared';
            const event = Object.freeze({ revision: successor.revision, reason: String(reason), focus: null,
                changedTileKeys: Object.freeze([...changed.keys()]),
                bounds: Object.freeze([...changed.values()].map(tile => Object.freeze({
                    minX: tile.tileX * tileM, maxX: (tile.tileX + 1) * tileM,
                    minZ: tile.tileZ * tileM, maxZ: (tile.tileZ + 1) * tileM,
                }))),
            });
            const release = () => {
                if (pending === token) pending = null;
                if (preparedState === successor) preparedState = null;
                oldState = null; successor = null; cachedUsage = null;
            };
            handedOff = true;
            return Object.freeze({
                get state() { return status; },
                usage,
                captureReadSnapshot(owner) {
                    if (!['prepared', 'committed'].includes(status) || !successor) {
                        fail('terrain-publication-settled', 'Terrain candidate is no longer available for new readers');
                    }
                    return captureReadSnapshot(successor, owner);
                },
                isCurrent: () => status === 'prepared' && state === oldState && pending === token,
                commit() {
                    if (status !== 'prepared' || state !== oldState || pending !== token) return false;
                    state = successor;
                    cachedUsage = null;
                    status = 'committed';
                    return true;
                },
                rollback() {
                    if (status !== 'committed' || state !== successor) return false;
                    state = oldState;
                    cachedUsage = null;
                    status = 'prepared';
                    return true;
                },
                discard() {
                    if (status !== 'prepared') return false;
                    status = 'discarded'; release(); return true;
                },
                notify() {
                    if (status !== 'committed' || state !== successor) return false;
                    status = 'published';
                    lastChange = event;
                    release();
                    for (const listener of [...listeners]) {
                        try { listener(event.revision, event); }
                        catch (error) { console.error('[terrain] published change listener failed', error); }
                    }
                    return true;
                },
            });
        } finally {
            if (!handedOff && pending === token) pending = null;
        }
    }

    function createQueries(getState) {
        const at = (x, z) => tileAt(x, z, getState().byX);
        const query = {
        anchorLon: frame.anchorLon, anchorLat: frame.anchorLat,
        anchorHeightM: frame.anchorHeightM, fallbackHeightM: frame.fallbackHeightM,
        metresPerDegreeLon: frame.metresPerDegreeLon, metresPerDegreeLat: frame.metresPerDegreeLat,
        surfaceStepM: frame.surfaceStepM,
        bounded: true,
        *receiverTrianglesInBounds(bounds) {
            if (![bounds?.minX, bounds?.minZ, bounds?.maxX, bounds?.maxZ].every(isFiniteNumber)
                || bounds.minX >= bounds.maxX || bounds.minZ >= bounds.maxZ) throw new TypeError('Receiver query requires finite bounds');
            const x0 = Math.floor(bounds.minX / tileM), x1 = Math.floor(bounds.maxX / tileM);
            const z0 = Math.floor(bounds.minZ / tileM), z1 = Math.floor(bounds.maxZ / tileM);
            if (![x0, x1, z0, z1].every(Number.isSafeInteger)
                || (x1 - x0 + 1) * (z1 - z0 + 1) > maxTiles) {
                fail('terrain-publication-capacity', 'Receiver query exceeds tile capacity');
            }
            const table = getState().byX;
            for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
                yield* terrainReceiverTrianglesInBounds(lookup(table, x, z), bounds);
                yield null;
            }
        },
        receiverTilesForBounds(bounds) {
            if (![bounds?.minX, bounds?.minZ, bounds?.maxX, bounds?.maxZ].every(isFiniteNumber)
                || bounds.minX >= bounds.maxX || bounds.minZ >= bounds.maxZ) throw new TypeError('Receiver query requires finite bounds');
            const minX = Math.floor(bounds.minX / tileM), maxX = Math.ceil(bounds.maxX / tileM) - 1;
            const minZ = Math.floor(bounds.minZ / tileM), maxZ = Math.ceil(bounds.maxZ / tileM) - 1;
            if (![minX, maxX, minZ, maxZ].every(Number.isSafeInteger)
                || (maxX - minX + 1) * (maxZ - minZ + 1) > maxTiles) {
                fail('terrain-publication-capacity', 'Receiver query exceeds tile capacity');
            }
            const table = getState().byX, result = [];
            for (let z = minZ; z <= maxZ; z++) for (let x = minX; x <= maxX; x++) {
                const tile = lookup(table, x, z);
                if (!tile) return null;
                result.push(tile);
            }
            return result;
        },
        receiverSceneYAtLocal: (x, z) => terrainReceiverSceneYAtLocal(at(x, z), x, z),
        sceneYAtLocal: (x, z) => terrainReceiverSceneYAtLocal(at(x, z), x, z) ?? fallbackY,
        // Evidence availability belongs to the retained source. Point support
        // additionally requires a real triangle in the published receiver.
        sourceEvidenceSceneYAtLocal: (x, z) => at(x, z)?.snapshot.evidenceSceneYAtLocal(x, z) ?? null,
        evidenceSceneYAtLocal: (x, z) => {
            const tile = at(x, z);
            return isFiniteNumber(tile?.snapshot.evidenceSceneYAtLocal(x, z))
                ? terrainReceiverSceneYAtLocal(tile, x, z) : null;
        },
        evidenceWithheldAtLocal: (x, z) => at(x, z)?.snapshot.evidenceWithheldAtLocal(x, z) ?? true,
        hasLoadedCoreCoverageAtLocal: (x, z) => at(x, z)?.snapshot.hasLoadedCoreCoverageAtLocal(x, z) ?? false,
        sampleStepMAtLocal: (x, z) => {
            const tile = at(x, z);
            return tile ? tileM / tile.segments : null;
        },
        sampleStepMForBounds: bounds => terrainLatticeStepForBounds(bounds, tileM, (x, z) => {
            const tile = lookup(getState().byX, x, z);
            return tile ? tileM / tile.segments : null;
        }),
        isFineTile: (x, z) => lookup(getState().byX, x, z)?.snapshot.isFineTile(x, z) ?? false,
        heightAt(lon, lat) {
            const { x, z } = local(lon, lat);
            return at(x, z)?.snapshot.heightAt(lon, lat) ?? null;
        },
        sceneYAt(lon, lat) { const { x, z } = local(lon, lat); return query.sceneYAtLocal(x, z); },
        evidenceSceneYAt(lon, lat) { const { x, z } = local(lon, lat); return query.evidenceSceneYAtLocal(x, z); },
        hasLoadedCoreCoverageAt(lon, lat) { const { x, z } = local(lon, lat); return query.hasLoadedCoreCoverageAtLocal(x, z); },
        };
        // These methods compose through the point-query API above. In
        // particular, normals straddling a tile edge sample both table entries.
        for (const name of ['absoluteToSceneY', 'sourceSceneYAt', 'sourceSceneYAtLocal', 'lonLatAtLocal',
            'hasEvidenceAtLocal', 'evidenceReadyForLocalPoints', 'normalAtLocal', 'evidenceNormalAtLocal',
            'slopeAlongHeadingDeg', 'evidenceSlopeAlongHeadingDeg', 'foundationSceneY', 'evidenceFoundationSceneY']) {
            query[name] = TerrainReference.prototype[name].bind(query);
        }
        return query;
    }

    const api = {
        ...createQueries(() => state),
        contract: 'station3d-published-terrain-v1',
        get revision() { return state.revision; },
        // A capacity-blocked producer can observe releases in O(1), without
        // rebuilding the retained-buffer accounting on every frame.
        get readReleaseRevision() { return readReleaseRevision; },
        get lastChange() { return lastChange; },
        captureReadSnapshot: owner => captureReadSnapshot(state, owner),
        prepareSteps,
        close() {
            if (closed) return false;
            closed = true;
            pending = null;
            preparedState = null;
            cachedUsage = null;
            listeners.clear();
            for (const retained of readSnapshots) {
                retained.state = null;
                retained.shared.state = null;
                retained.shared.readers = 0;
            }
            readSnapshots.clear();
            state = { byX: new Map(), tiles: new Map(), snapshots: new Set(), buffers: new Set(), receiverBuffers: new Set(), revision: state.revision + 1,
                usage: Object.freeze({ tiles: 0, snapshots: 0, sourceBytes: 0, peakSourceBytes: 0, receiverBytes: 0, peakReceiverBytes: 0 }) };
            return true;
        },
        onChange(listener) {
            if (typeof listener !== 'function') throw new TypeError('Terrain listener must be a function');
            if (closed) return () => {};
            listeners.add(listener); return () => listeners.delete(listener);
        },
        getTile: (x, z) => lookup(state.byX, x, z),
        usage() {
            if (cachedUsage) return cachedUsage;
            const tables = new Set([state, preparedState, ...[...readSnapshots].map(view => view.state)]);
            const buffers = new Set(), receiverBuffers = new Set(), snapshots = new Set();
            let residentSourceBytes = 0, residentReceiverBytes = 0;
            for (const table of tables) if (table) {
                for (const snapshot of table.snapshots) snapshots.add(snapshot);
                for (const buffer of table.buffers) if (!buffers.has(buffer)) {
                    buffers.add(buffer); residentSourceBytes += buffer.byteLength;
                }
                for (const buffer of table.receiverBuffers) if (!receiverBuffers.has(buffer)) {
                    receiverBuffers.add(buffer); residentReceiverBytes += buffer.byteLength;
                }
            }
            return cachedUsage = Object.freeze({ ...state.usage, readSnapshots: readSnapshots.size,
                residentSnapshots: snapshots.size, residentSourceBytes, residentReceiverBytes });
        },
    };
    return Object.freeze(api);
}
