// Pure decoding and sampling for the compact TramSim terrain grid. No THREE,
// DOM, fetch, or module state: rendering layers share TerrainReference rather
// than each inventing their own altitude conversion.

import { DEG_TO_RAD, EARTH_RADIUS_M, finiteOrNull } from './math.js';
import { terrainLatticeStepForBounds } from './terrain-lattice.js';

function finiteNumber(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`terrain metadata: invalid ${label}`);
    return number;
}

function maxFinite(values) {
    let best = null;
    for (const value of values) {
        if (!Number.isFinite(value)) continue;
        if (best === null || value > best) best = value;
    }
    return best;
}

function normalizeLocalBounds(bounds) {
    const list = Array.isArray(bounds) ? bounds : bounds ? [bounds] : [];
    return list.map(entry => ({
        minX: Number(entry?.minX),
        minZ: Number(entry?.minZ),
        maxX: Number(entry?.maxX),
        maxZ: Number(entry?.maxZ),
    })).filter(entry => (
        [entry.minX, entry.minZ, entry.maxX, entry.maxZ].every(Number.isFinite)
        && entry.maxX > entry.minX
        && entry.maxZ > entry.minZ
    ));
}

function normalizeTerrainTileKeys(keys) {
    const list = Array.isArray(keys) || keys instanceof Set ? [...keys] : [];
    return [...new Set(list.map(String).filter(key => /^-?\d+_-?\d+$/.test(key)))];
}

// Exact geographic grid coverage expressed in the session's permanent local
// coordinate frame. Composite grids return the union envelope of base and
// detail components; callers that know which component changed can pass that
// component directly for a tighter invalidation region.
export function terrainGridLocalBounds(grid, anchorLon, anchorLat) {
    const grids = [];
    const visit = (entry) => {
        if (!entry) return;
        if (Array.isArray(entry.grids)) {
            for (const child of entry.grids) visit(child?.grid || child);
            return;
        }
        if (entry.base) {
            visit(entry.base);
            for (const child of entry.details || []) visit(child);
            return;
        }
        grids.push(entry);
    };
    visit(grid);
    const valid = grids.filter(entry => (
        [entry?.west, entry?.east, entry?.south, entry?.north]
            .every(value => finiteOrNull(value) !== null)
    ));
    if (valid.length === 0) return null;
    const latScale = DEG_TO_RAD * EARTH_RADIUS_M;
    const lonScale = latScale * Math.cos(Number(anchorLat) * DEG_TO_RAD);
    const west = Math.min(...valid.map(entry => Number(entry.west)));
    const east = Math.max(...valid.map(entry => Number(entry.east)));
    const south = Math.min(...valid.map(entry => Number(entry.south)));
    const north = Math.max(...valid.map(entry => Number(entry.north)));
    return {
        minX: (west - Number(anchorLon)) * lonScale,
        maxX: (east - Number(anchorLon)) * lonScale,
        minZ: -(north - Number(anchorLat)) * latScale,
        maxZ: -(south - Number(anchorLat)) * latScale,
    };
}

// A bounded set of overlapping fixed terrain grids exposed as one sampling
// surface. Each item may carry its unpadded coreBounds; those cores decide
// ownership in overlap collars, so request arrival order cannot move a seam.
export class MosaicTerrainGrid {
    constructor(items) {
        const normalized = (Array.isArray(items) ? items : [])
            .map((item, index) => ({
                grid: item?.grid || item,
                key: String(item?.key ?? index),
                coreBounds: item?.coreBounds || null,
            }))
            .filter(item => item.grid && typeof item.grid.sampleHeight === 'function');
        if (normalized.length === 0) {
            throw new Error('MosaicTerrainGrid requires terrain grids');
        }
        normalized.sort((a, b) => a.key.localeCompare(b.key));
        this.items = normalized;
        this.grids = normalized.map(item => item.grid);
        this._coreLookup = this._buildCoreLookup(normalized);
    }

    _buildCoreLookup(items) {
        let spanLon = null;
        let spanLat = null;
        const byKey = new Map();
        for (const item of items) {
            const match = /^(-?\d+)_(-?\d+)$/.exec(item.key);
            const bounds = item.coreBounds;
            if (!match || !bounds) return null;
            const tx = Number(match[1]);
            const ty = Number(match[2]);
            const width = Number(bounds.east) - Number(bounds.west);
            const height = Number(bounds.north) - Number(bounds.south);
            if (!(width > 0) || !(height > 0)) return null;
            spanLon ??= width;
            spanLat ??= height;
            const tolerance = 1e-9;
            if (Math.abs(width - spanLon) > tolerance
                || Math.abs(height - spanLat) > tolerance
                || Math.abs(Number(bounds.west) - tx * spanLon) > tolerance
                || Math.abs(Number(bounds.south) - ty * spanLat) > tolerance) return null;
            byKey.set(item.key, item);
        }
        return { spanLon, spanLat, byKey };
    }

    _candidates(lon, lat) {
        const numericLon = Number(lon);
        const numericLat = Number(lat);
        return this.items.filter(item => item.grid.contains(numericLon, numericLat));
    }

    _ownsCore(item, lon, lat) {
        const bounds = item.coreBounds;
        return !!bounds
            && lon >= Number(bounds.west) && lon <= Number(bounds.east)
            && lat >= Number(bounds.south) && lat <= Number(bounds.north);
    }

    _orderedCandidates(lon, lat) {
        const candidates = this._candidates(lon, lat);
        candidates.sort((a, b) => {
            const aCore = this._ownsCore(a, lon, lat) ? 1 : 0;
            const bCore = this._ownsCore(b, lon, lat) ? 1 : 0;
            if (aCore !== bCore) return bCore - aCore;
            const edgeDepth = (item) => Math.min(
                lon - item.grid.west,
                item.grid.east - lon,
                lat - item.grid.south,
                item.grid.north - lat,
            );
            return edgeDepth(b) - edgeDepth(a) || a.key.localeCompare(b.key);
        });
        return candidates;
    }

    _primaryCandidate(lon, lat) {
        if (this._coreLookup) {
            const { spanLon, spanLat, byKey } = this._coreLookup;
            const indexed = byKey.get(
                `${Math.floor(lon / spanLon)}_${Math.floor(lat / spanLat)}`,
            );
            const bounds = indexed?.coreBounds;
            // Exact shared borders retain the deterministic scan/tie-breaker;
            // every interior sample resolves its fixed-lattice owner in O(1).
            if (indexed && bounds
                && lon > Number(bounds.west) && lon < Number(bounds.east)
                && lat > Number(bounds.south) && lat < Number(bounds.north)
                && indexed.grid.contains(lon, lat)) return indexed;
        }
        let best = null;
        let bestCore = -1;
        let bestEdgeDepth = -Infinity;
        for (const item of this.items) {
            if (!item.grid.contains(lon, lat)) continue;
            const core = this._ownsCore(item, lon, lat) ? 1 : 0;
            const edgeDepth = Math.min(
                lon - item.grid.west,
                item.grid.east - lon,
                lat - item.grid.south,
                item.grid.north - lat,
            );
            // Items are already key-sorted, so retaining the first exact tie
            // preserves the deterministic ordering used by
            // _orderedCandidates(). The ordinary path has one core owner and
            // now performs no filter allocation or array sort per sample.
            if (core > bestCore || (core === bestCore && edgeDepth > bestEdgeDepth)) {
                best = item;
                bestCore = core;
                bestEdgeDepth = edgeDepth;
            }
        }
        return best;
    }

    contains(lon, lat) {
        return this.items.some(item => item.grid.contains(Number(lon), Number(lat)));
    }

    // Padding collars overlap neighbouring fixed cells. A point covered only
    // by a loaded collar is still transient: its owning cell may arrive with
    // real evidence. NoData becomes terminal only after that core owner is in
    // the mosaic, so dependency-bound compilers can distinguish "not loaded"
    // from authoritative sea/data-hole NoData without guessing a height.
    hasCoreCoverage(lon, lat) {
        const numericLon = Number(lon);
        const numericLat = Number(lat);
        if (this._coreLookup) {
            const { spanLon, spanLat, byKey } = this._coreLookup;
            const indexed = byKey.get(
                `${Math.floor(numericLon / spanLon)}_${Math.floor(numericLat / spanLat)}`,
            );
            if (indexed && this._ownsCore(indexed, numericLon, numericLat)) return true;
        }
        return this.items.some(item => (
            item.coreBounds
                ? this._ownsCore(item, numericLon, numericLat)
                : item.grid.contains(numericLon, numericLat)
        ));
    }

    sampleHeight(lon, lat) {
        const numericLon = Number(lon);
        const numericLat = Number(lat);
        const primary = this._primaryCandidate(numericLon, numericLat);
        if (!primary) return null;
        const primaryValue = primary.grid.sampleHeight(numericLon, numericLat);
        if (Number.isFinite(primaryValue)) return primaryValue;
        // NoData overlap is exceptional. Retain the exact historical order for
        // that fallback without charging its allocation/sort cost to every
        // terrain sample in every road and building compiler.
        for (const item of this._orderedCandidates(numericLon, numericLat)) {
            if (item === primary) continue;
            const value = item.grid.sampleHeight(numericLon, numericLat);
            if (Number.isFinite(value)) return value;
        }
        return null;
    }

    sourceIndexAtLocation(lon, lat) {
        const numericLon = Number(lon);
        const numericLat = Number(lat);
        const primary = this._primaryCandidate(numericLon, numericLat);
        if (!primary) return null;
        const primaryValue = primary.grid.sourceIndexAtLocation?.(numericLon, numericLat);
        if (primaryValue != null) return primaryValue;
        for (const item of this._orderedCandidates(numericLon, numericLat)) {
            if (item === primary) continue;
            const value = item.grid.sourceIndexAtLocation?.(numericLon, numericLat);
            if (value != null) return value;
        }
        return null;
    }
}

export class TerrainGrid {
    constructor(metadata, arrayBuffer, { sourceArrayBuffer = null } = {}) {
        // API metadata arrives beside base64 transport copies of both decoded
        // buffers. Do not retain those strings or serialize them to the Worker;
        // encoding, provenance and diagnostic metadata are still unchanged.
        this.metadata = { ...metadata };
        delete this.metadata.dataBase64;
        delete this.metadata.sourceDataBase64;
        const grid = this.metadata.grid || {};
        const bounds = grid.bounds || {};
        const encoding = this.metadata.encoding || {};
        this.width = Math.trunc(finiteNumber(grid.width, 'grid.width'));
        this.height = Math.trunc(finiteNumber(grid.height, 'grid.height'));
        this.west = finiteNumber(bounds.west, 'grid.bounds.west');
        this.east = finiteNumber(bounds.east, 'grid.bounds.east');
        this.south = finiteNumber(bounds.south, 'grid.bounds.south');
        this.north = finiteNumber(bounds.north, 'grid.bounds.north');
        this.scaleM = finiteNumber(encoding.scaleM, 'encoding.scaleM');
        this.offsetM = finiteNumber(encoding.offsetM, 'encoding.offsetM');
        this.noDataValue = Math.trunc(finiteNumber(encoding.noDataValue, 'encoding.noDataValue'));
        if (this.width < 2 || this.height < 2) {
            throw new Error('terrain metadata: grid must be at least 2 x 2');
        }
        if (!(this.east > this.west) || !(this.north > this.south)) {
            throw new Error('terrain metadata: invalid geographic bounds');
        }
        if (!(this.scaleM > 0)) throw new Error('terrain metadata: scaleM must be positive');
        const expectedBytes = this.width * this.height * 2;
        if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength !== expectedBytes) {
            throw new Error(`terrain binary: expected ${expectedBytes} bytes, got ${arrayBuffer?.byteLength ?? 0}`);
        }
        this.values = new Uint16Array(arrayBuffer);
        if (sourceArrayBuffer !== null) {
            const expectedSourceBytes = this.width * this.height;
            if (!(sourceArrayBuffer instanceof ArrayBuffer)
                || sourceArrayBuffer.byteLength !== expectedSourceBytes) {
                throw new Error(
                    `terrain source mask: expected ${expectedSourceBytes} bytes, `
                    + `got ${sourceArrayBuffer?.byteLength ?? 0}`,
                );
            }
            this.sourceValues = new Uint8Array(sourceArrayBuffer);
        } else {
            this.sourceValues = null;
        }
    }

    contains(lon, lat) {
        return Number.isFinite(lon) && Number.isFinite(lat)
            && lon >= this.west && lon <= this.east
            && lat >= this.south && lat <= this.north;
    }

    hasCoreCoverage(lon, lat) {
        return this.contains(Number(lon), Number(lat));
    }

    valueAt(column, row) {
        const raw = this.values[row * this.width + column];
        return raw === this.noDataValue ? null : this.offsetM + raw * this.scaleM;
    }

    sourceIndexAt(column, row) {
        if (!this.sourceValues) return null;
        const value = this.sourceValues[row * this.width + column];
        return value === 255 ? null : value;
    }

    sourceIndexAtLocation(lon, lat) {
        const numericLon = Number(lon);
        const numericLat = Number(lat);
        if (!this.sourceValues || !this.contains(numericLon, numericLat)) return null;
        const rawX = ((numericLon - this.west) / (this.east - this.west)) * this.width - 0.5;
        const rawY = ((this.north - numericLat) / (this.north - this.south)) * this.height - 0.5;
        const column = Math.max(0, Math.min(this.width - 1, Math.round(rawX)));
        const row = Math.max(0, Math.min(this.height - 1, Math.round(rawY)));
        return this.sourceIndexAt(column, row);
    }

    // Bounds describe pixel edges and rows run north-to-south. Samples are at
    // pixel centres, so the half-pixel offset is part of the lookup rather than
    // being baked into callers.
    sampleHeight(lon, lat) {
        const numericLon = Number(lon);
        const numericLat = Number(lat);
        if (!this.contains(numericLon, numericLat)) return null;
        const rawX = ((numericLon - this.west) / (this.east - this.west)) * this.width - 0.5;
        const rawY = ((this.north - numericLat) / (this.north - this.south)) * this.height - 0.5;
        const x = Math.max(0, Math.min(this.width - 1, rawX));
        const y = Math.max(0, Math.min(this.height - 1, rawY));
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const x1 = Math.min(this.width - 1, x0 + 1);
        const y1 = Math.min(this.height - 1, y0 + 1);
        const tx = x - x0;
        const ty = y - y0;
        const samples = [
            [this.valueAt(x0, y0), (1 - tx) * (1 - ty)],
            [this.valueAt(x1, y0), tx * (1 - ty)],
            [this.valueAt(x0, y1), (1 - tx) * ty],
            [this.valueAt(x1, y1), tx * ty],
        ];
        let weightedHeight = 0;
        let totalWeight = 0;
        for (const [height, weight] of samples) {
            if (!Number.isFinite(height) || weight <= 0) continue;
            weightedHeight += height * weight;
            totalWeight += weight;
        }
        return totalWeight > 1e-9 ? weightedHeight / totalWeight : null;
    }

    // Bilinear sample restricted to one provenance source. At a composed
    // raster edge, ordinary interpolation mixes the high-resolution value
    // with the unadjusted fallback before the seam correction can run and
    // creates a one-cell notch. Renormalising the matching corners preserves
    // the authoritative source right up to its coverage boundary.
    sampleHeightFromSource(lon, lat, sourceIndex) {
        const numericLon = Number(lon);
        const numericLat = Number(lat);
        if (!this.sourceValues || !this.contains(numericLon, numericLat)) return null;
        const rawX = ((numericLon - this.west) / (this.east - this.west)) * this.width - 0.5;
        const rawY = ((this.north - numericLat) / (this.north - this.south)) * this.height - 0.5;
        const x = Math.max(0, Math.min(this.width - 1, rawX));
        const y = Math.max(0, Math.min(this.height - 1, rawY));
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const x1 = Math.min(this.width - 1, x0 + 1);
        const y1 = Math.min(this.height - 1, y0 + 1);
        const tx = x - x0;
        const ty = y - y0;
        const samples = [
            [x0, y0, (1 - tx) * (1 - ty)],
            [x1, y0, tx * (1 - ty)],
            [x0, y1, (1 - tx) * ty],
            [x1, y1, tx * ty],
        ];
        let weightedHeight = 0;
        let totalWeight = 0;
        for (const [column, row, weight] of samples) {
            if (weight <= 0 || this.sourceIndexAt(column, row) !== sourceIndex) continue;
            const height = this.valueAt(column, row);
            if (!Number.isFinite(height)) continue;
            weightedHeight += height * weight;
            totalWeight += weight;
        }
        return totalWeight > 1e-9 ? weightedHeight / totalWeight : null;
    }
}

function sourcePlan(grid) {
    const sources = grid?.metadata?.source?.sources;
    return Array.isArray(sources) ? sources : [];
}

function primarySourceIndex(grid) {
    const first = sourcePlan(grid)[0];
    const index = Number(first?.index);
    return Number.isInteger(index) && index >= 0 ? index : 0;
}

// The best-available detail raster is a mosaic: 1 m LiDAR where present and
// the 20 m DTM in its holes. Those datasets can disagree by a metre or two at
// an arbitrary source-tile edge. Preserve the higher-priority detail exactly,
// but let the coarse fallback meet it over a short band instead of exposing a
// vertical terrain wall. Boundary samples are bucketed so runtime lookup is
// local rather than scanning the full source edge.
const SOURCE_BOUNDARY_ROWS_PER_STEP = 16;

export function* createSourceBoundaryIndexBuildIterator(
    baseGrid,
    detailGrid,
    blendMarginM,
    { rowsPerStep = SOURCE_BOUNDARY_ROWS_PER_STEP } = {},
) {
    if (!detailGrid?.sourceValues || blendMarginM <= 0) return null;
    const plan = sourcePlan(detailGrid);
    if (plan.length < 2) return null;
    const primaryIndex = primarySourceIndex(detailGrid);
    const midLat = (detailGrid.south + detailGrid.north) / 2;
    const metresPerDegreeLat = DEG_TO_RAD * EARTH_RADIUS_M;
    const metresPerDegreeLon = metresPerDegreeLat * Math.cos(midLat * DEG_TO_RAD);
    const cellM = {
        x: ((detailGrid.east - detailGrid.west) / detailGrid.width) * metresPerDegreeLon,
        y: ((detailGrid.north - detailGrid.south) / detailGrid.height) * metresPerDegreeLat,
    };
    const bucketCells = Math.max(1, Math.ceil(
        blendMarginM / Math.max(0.01, Math.min(cellM.x, cellM.y)),
    ));
    const buckets = new Map();
    const keyFor = (column, row) => (
        `${Math.floor(column / bucketCells)}:${Math.floor(row / bucketCells)}`
    );
    const addBoundary = (column, row) => {
        const lon = detailGrid.west
            + ((column + 0.5) / detailGrid.width) * (detailGrid.east - detailGrid.west);
        const lat = detailGrid.north
            - ((row + 0.5) / detailGrid.height) * (detailGrid.north - detailGrid.south);
        const detailHeight = detailGrid.valueAt(column, row);
        const baseHeight = baseGrid.sampleHeight(lon, lat);
        if (!Number.isFinite(detailHeight) || !Number.isFinite(baseHeight)) return;
        const key = keyFor(column, row);
        let bucket = buckets.get(key);
        if (!bucket) {
            bucket = [];
            buckets.set(key, bucket);
        }
        bucket.push({ column, row, correctionM: detailHeight - baseHeight });
    };
    const boundedRowsPerStep = Math.max(1, Math.floor(Number(rowsPerStep) || 0));
    for (let row = 0; row < detailGrid.height; row++) {
        for (let column = 0; column < detailGrid.width; column++) {
            if (detailGrid.sourceIndexAt(column, row) !== primaryIndex) continue;
            const left = column > 0 ? detailGrid.sourceIndexAt(column - 1, row) : primaryIndex;
            const right = column + 1 < detailGrid.width
                ? detailGrid.sourceIndexAt(column + 1, row)
                : primaryIndex;
            const up = row > 0 ? detailGrid.sourceIndexAt(column, row - 1) : primaryIndex;
            const down = row + 1 < detailGrid.height
                ? detailGrid.sourceIndexAt(column, row + 1)
                : primaryIndex;
            if ([left, right, up, down].some(index => index !== primaryIndex)) {
                addBoundary(column, row);
            }
        }
        if ((row + 1) % boundedRowsPerStep === 0 && row + 1 < detailGrid.height) {
            yield {
                phase: 'source-boundary-rows',
                completedRows: row + 1,
                totalRows: detailGrid.height,
            };
        }
    }
    return buckets.size > 0 ? {
        primaryIndex,
        blendMarginM,
        cellM,
        bucketCells,
        buckets,
    } : null;
}

function buildSourceBoundaryIndex(baseGrid, detailGrid, blendMarginM) {
    const iterator = createSourceBoundaryIndexBuildIterator(
        baseGrid,
        detailGrid,
        blendMarginM,
        { rowsPerStep: Number.MAX_SAFE_INTEGER },
    );
    let step = iterator.next();
    while (!step.done) step = iterator.next();
    return step.value;
}

// The source-provenance seam is the only expensive part of constructing a
// composite. A moving Zagreb detail grid contains roughly two million cells;
// scanning them in its fetch Promise blocked animation for 150+ ms. This
// iterator prepares the identical immutable index in row slices and publishes
// only the complete CompositeTerrainGrid returned at the end.
export function* createCompositeTerrainGridBuildIterator(
    baseGrid,
    detailGrids,
    options = {},
) {
    const details = Array.isArray(detailGrids) ? detailGrids : [detailGrids];
    const {
        rowsPerStep = SOURCE_BOUNDARY_ROWS_PER_STEP,
        sourceBlendMarginM = 48,
        ...gridOptions
    } = options;
    const sourceBoundaries = new Map();
    for (let index = 0; index < details.length; index++) {
        const grid = details[index];
        const iterator = createSourceBoundaryIndexBuildIterator(
            baseGrid,
            grid,
            Math.max(0, Number(sourceBlendMarginM) || 0),
            { rowsPerStep },
        );
        let step = iterator.next();
        while (!step.done) {
            yield {
                ...step.value,
                detailIndex: index,
                detailCount: details.length,
            };
            step = iterator.next();
        }
        sourceBoundaries.set(grid, step.value);
    }
    return new CompositeTerrainGrid(baseGrid, details, {
        ...gridOptions,
        sourceBlendMarginM,
        sourceBoundaries,
    });
}

function sampleSourceBoundaryCorrection(grid, boundary, lon, lat) {
    if (!boundary) return null;
    const sourceIndex = grid.sourceIndexAtLocation(lon, lat);
    if (sourceIndex === boundary.primaryIndex) return null;
    if (sourceIndex == null) return { correctionM: 0, weight: 0 };
    const rawColumn = ((lon - grid.west) / (grid.east - grid.west)) * grid.width - 0.5;
    const rawRow = ((grid.north - lat) / (grid.north - grid.south)) * grid.height - 0.5;
    const bucketColumn = Math.floor(rawColumn / boundary.bucketCells);
    const bucketRow = Math.floor(rawRow / boundary.bucketCells);
    let nearestDistanceM = Infinity;
    const nearest = [];
    for (let rowOffset = -1; rowOffset <= 1; rowOffset++) {
        for (let columnOffset = -1; columnOffset <= 1; columnOffset++) {
            const candidates = boundary.buckets.get(
                `${bucketColumn + columnOffset}:${bucketRow + rowOffset}`,
            );
            if (!candidates) continue;
            for (const candidate of candidates) {
                const dxM = (candidate.column - rawColumn) * boundary.cellM.x;
                const dyM = (candidate.row - rawRow) * boundary.cellM.y;
                const distanceM = Math.hypot(dxM, dyM);
                if (distanceM > boundary.blendMarginM) continue;
                nearestDistanceM = Math.min(nearestDistanceM, distanceM);
                nearest.push({ candidate, distanceM });
            }
        }
    }
    if (!Number.isFinite(nearestDistanceM)) return { correctionM: 0, weight: 0 };
    // Average the local edge correction instead of switching abruptly between
    // individual boundary pixels along an otherwise straight source edge.
    const localRadiusM = Math.max(2, Math.min(8, boundary.blendMarginM * 0.2));
    let correctionTotal = 0;
    let correctionWeight = 0;
    for (const candidate of nearest) {
        if (candidate.distanceM > nearestDistanceM + localRadiusM) continue;
        const weight = 1 / Math.max(0.5, candidate.distanceM);
        correctionTotal += candidate.candidate.correctionM * weight;
        correctionWeight += weight;
    }
    const linear = Math.max(0, Math.min(1, 1 - nearestDistanceM / boundary.blendMarginM));
    const weight = linear * linear * (3 - 2 * linear);
    return {
        correctionM: correctionWeight > 0 ? correctionTotal / correctionWeight : 0,
        weight,
    };
}

// Stacked grids, one sampling surface: DETAIL grids (small windows at the
// source's native resolution — the anchor window plus the route-band chunks)
// win inside their bounds, the BASE grid (corridor-scale) everywhere else.
// A short blend band at each detail edge keeps raw bilinear reads (heightAt,
// decor placement) from stepping where the datasets disagree; where chunks
// overlap, the one deepest inside its own bounds wins, so a chunk join never
// blends back down to the base. Detail NoData holes (water, delivery gaps)
// fall through to the base rather than to sea level.
export class CompositeTerrainGrid {
    constructor(baseGrid, detailGrids, {
        blendMarginM = 24,
        sourceBlendMarginM = 48,
        sourceBoundaries = null,
    } = {}) {
        if (!baseGrid || typeof baseGrid.sampleHeight !== 'function') {
            throw new Error('CompositeTerrainGrid requires a base grid');
        }
        const details = Array.isArray(detailGrids) ? detailGrids : [detailGrids];
        if (details.length === 0
            || details.some(grid => !grid || typeof grid.sampleHeight !== 'function')) {
            throw new Error('CompositeTerrainGrid requires detail grids');
        }
        this.base = baseGrid;
        this.details = details;
        this.detail = details[0];
        this.blendMarginM = Math.max(0, Number(blendMarginM) || 0);
        this.sourceBlendMarginM = Math.max(0, Number(sourceBlendMarginM) || 0);
        if (sourceBoundaries !== null && !(sourceBoundaries instanceof Map)) {
            throw new Error('CompositeTerrainGrid source boundaries must be a Map');
        }
        if (sourceBoundaries && details.some(grid => !sourceBoundaries.has(grid))) {
            throw new Error('CompositeTerrainGrid source boundaries are incomplete');
        }
        this._sourceBoundaries = new Map(details.map(grid => [
            grid,
            sourceBoundaries
                ? sourceBoundaries.get(grid)
                : buildSourceBoundaryIndex(baseGrid, grid, this.sourceBlendMarginM),
        ]));
        const midLat = (details[0].south + details[0].north) / 2;
        this._metresPerDegreeLat = DEG_TO_RAD * EARTH_RADIUS_M;
        this._metresPerDegreeLon = this._metresPerDegreeLat
            * Math.cos(midLat * DEG_TO_RAD);
    }

    sourceBoundaryIndexSnapshot() {
        // Boundary records are immutable after construction. Copy only the Map
        // shell so a later base-mosaic wrapper can reuse the expensive detail
        // provenance solve without exposing this instance's membership table.
        return new Map(this._sourceBoundaries);
    }

    contains(lon, lat) {
        if (this.base.contains(lon, lat)) return true;
        return this.details.some(grid => grid.contains(lon, lat));
    }

    hasCoreCoverage(lon, lat) {
        const covered = grid => (
            typeof grid?.hasCoreCoverage === 'function'
                ? grid.hasCoreCoverage(lon, lat)
                : grid?.contains?.(lon, lat) === true
        );
        return covered(this.base) || this.details.some(covered);
    }

    // 0 at the grid's edge, 1 once blendMarginM inside it.
    _weightIn(grid, lon, lat) {
        const edgeM = Math.min(
            (lon - grid.west) * this._metresPerDegreeLon,
            (grid.east - lon) * this._metresPerDegreeLon,
            (lat - grid.south) * this._metresPerDegreeLat,
            (grid.north - lat) * this._metresPerDegreeLat,
        );
        if (this.blendMarginM <= 0) return edgeM >= 0 ? 1 : 0;
        return Math.max(0, Math.min(1, edgeM / this.blendMarginM));
    }

    sampleHeight(lon, lat) {
        const numericLon = Number(lon);
        const numericLat = Number(lat);
        let best = null;
        let bestWeight = 0;
        for (const grid of this.details) {
            if (!grid.contains(numericLon, numericLat)) continue;
            const weight = this._weightIn(grid, numericLon, numericLat);
            if (weight > bestWeight) {
                best = grid;
                bestWeight = weight;
                if (weight >= 1) break;
            }
        }
        if (!best) return this.base.sampleHeight(numericLon, numericLat);
        const sourceBoundary = this._sourceBoundaries.get(best);
        const sourceIndex = best.sourceIndexAtLocation?.(numericLon, numericLat);
        let detailHeight = sourceBoundary && sourceIndex === sourceBoundary.primaryIndex
            ? best.sampleHeightFromSource(
                numericLon,
                numericLat,
                sourceBoundary.primaryIndex,
            )
            : best.sampleHeight(numericLon, numericLat);
        if (detailHeight === null) return this.base.sampleHeight(numericLon, numericLat);
        if (sourceBoundary && sourceIndex !== sourceBoundary.primaryIndex) {
            const baseHeight = this.base.sampleHeight(numericLon, numericLat);
            if (baseHeight === null) return detailHeight;
            const seam = sampleSourceBoundaryCorrection(
                best,
                sourceBoundary,
                numericLon,
                numericLat,
            );
            detailHeight = baseHeight + (seam?.correctionM || 0) * (seam?.weight || 0);
        }
        if (bestWeight >= 1) return detailHeight;
        const baseHeight = this.base.sampleHeight(numericLon, numericLat);
        if (baseHeight === null) return detailHeight;
        return baseHeight + (detailHeight - baseHeight) * bestWeight;
    }

    sourceIndexAtLocation(lon, lat) {
        for (const grid of this.details) {
            if (!grid.contains(lon, lat)) continue;
            const index = grid.sourceIndexAtLocation?.(lon, lat);
            if (index != null) return index;
        }
        return this.base.sourceIndexAtLocation?.(lon, lat) ?? null;
    }
}

export class TerrainReference {
    constructor(grid, anchorLon, anchorLat, {
        fallbackHeightM = 0,
        surfaceStepM = null,
        detail = null,
    } = {}) {
        if (!grid || typeof grid.sampleHeight !== 'function') {
            throw new Error('TerrainReference requires a terrain grid');
        }
        this.grid = grid;
        this.anchorLon = finiteNumber(anchorLon, 'anchorLon');
        this.anchorLat = finiteNumber(anchorLat, 'anchorLat');
        this.fallbackHeightM = finiteNumber(fallbackHeightM, 'fallbackHeightM');
        this.metresPerDegreeLat = DEG_TO_RAD * EARTH_RADIUS_M;
        this.metresPerDegreeLon = this.metresPerDegreeLat * Math.cos(this.anchorLat * DEG_TO_RAD);
        this.anchorHeightM = grid.sampleHeight(this.anchorLon, this.anchorLat);
        if (!Number.isFinite(this.anchorHeightM)) this.anchorHeightM = this.fallbackHeightM;
        const numericSurfaceStepM = Number(surfaceStepM);
        this.surfaceStepM = Number.isFinite(numericSurfaceStepM) && numericSurfaceStepM > 0
            ? numericSurfaceStepM
            : null;
        // Optional fine-step surface region (local metres). The region is the
        // UNION OF WHOLE TILES (tileM squares on the world tile grid) fully
        // covered by at least one rect — never a partial tile — so a rendered
        // tile is entirely fine or entirely coarse and the mesh matches the
        // sampler by construction. Inside, sceneYAtLocal samples a stepM
        // piecewise-planar surface; a fine corner ON the region's boundary
        // takes the coarse surface's value, which along a coarse grid line is
        // linear between coarse corners, so fine and coarse surfaces (and the
        // meshes built from them) meet watertight without a stitching pass.
        // Rects may overlap freely (the anchor window plus route-band chunks).
        this.detail = null;
        this.revision = 0;
        this._changeListeners = new Set();
        // A fine (1 m) window that has been requested but not merged yet, in
        // local metres. Inside it the 20 m base is deliberately NOT evidence:
        // where the probe found LiDAR, infrastructure waits for the 1 m surface
        // instead of publishing on the coarse one and re-solving when it lands.
        this.pendingDetailWindow = null;
        this._configureDetail(detail);
        this.roadFormation = null;
        this.railFormation = null;
        this.renderedRailSurface = null;
    }

    _configureDetail(detail) {
        this.detail = null;
        this._fineTileCache = null;
        if (detail && this.surfaceStepM) {
            const stepM = Number(detail.stepM);
            const tileM = Number(detail.tileM);
            const rects = (Array.isArray(detail.rects) ? detail.rects : [detail])
                .map(rect => ({
                    minX: Number(rect.minX),
                    maxX: Number(rect.maxX),
                    minZ: Number(rect.minZ),
                    maxZ: Number(rect.maxZ),
                }))
                .filter(rect => [rect.minX, rect.maxX, rect.minZ, rect.maxZ]
                    .every(Number.isFinite)
                    && rect.maxX > rect.minX && rect.maxZ > rect.minZ);
            if (rects.length > 0
                && Number.isFinite(stepM) && stepM > 0 && stepM < this.surfaceStepM
                && Number.isFinite(tileM) && tileM > 0
                && tileM % stepM === 0 && tileM % this.surfaceStepM === 0) {
                this.detail = {
                    stepM,
                    tileM,
                    rects,
                    bounds: {
                        minX: Math.min(...rects.map(rect => rect.minX)),
                        maxX: Math.max(...rects.map(rect => rect.maxX)),
                        minZ: Math.min(...rects.map(rect => rect.minZ)),
                        maxZ: Math.max(...rects.map(rect => rect.maxZ)),
                    },
                };
                this._fineTileCache = new Map();
            }
        }
    }

    replaceGrid(grid, {
        detail = null,
        changedBounds = null,
        changedTileKeys = null,
        reason = 'grid-replaced',
        focus = null,
    } = {}) {
        if (!grid || typeof grid.sampleHeight !== 'function') {
            throw new Error('TerrainReference replacement requires a terrain grid');
        }
        this.grid = grid;
        this._cornerCache = null;
        this._coarseCornerSampler = null;
        this._fineCornerSceneY = null;
        this._configureDetail(detail);
        return this._emitChange({ reason, changedBounds, changedTileKeys, focus });
    }

    onChange(listener) {
        if (typeof listener !== 'function') return () => {};
        this._changeListeners.add(listener);
        return () => this._changeListeners.delete(listener);
    }

    _emitChange({ reason, changedBounds = null, changedTileKeys = null, focus = null } = {}) {
        this.revision += 1;
        const event = {
            revision: this.revision,
            reason: String(reason || 'grid-replaced'),
            bounds: normalizeLocalBounds(changedBounds),
            changedTileKeys: normalizeTerrainTileKeys(changedTileKeys),
            focus: focus && [focus.x, focus.z].every(value => finiteOrNull(value) !== null)
                ? {
                    x: Number(focus.x),
                    z: Number(focus.z),
                    lat: finiteOrNull(focus.lat),
                    lon: finiteOrNull(focus.lon),
                }
                : null,
        };
        this.lastChange = event;
        for (const listener of this._changeListeners) {
            try {
                // Revision remains the first argument for existing consumers.
                listener(this.revision, event);
            } catch (error) {
                console.error('[terrain] change listener failed', error);
            }
        }
        return this.revision;
    }

    // Declares a fine window in flight. Until it merges (or is released),
    // points inside it that are not already covered by loaded fine detail
    // report no evidence, so nothing terrain-relative publishes on the base
    // surface there. Replaces any previous pending window.
    setPendingDetailWindow(bounds) {
        const rect = bounds
            ? {
                minX: Number(bounds.minX),
                maxX: Number(bounds.maxX),
                minZ: Number(bounds.minZ),
                maxZ: Number(bounds.maxZ),
            }
            : null;
        this.pendingDetailWindow = rect
            && [rect.minX, rect.maxX, rect.minZ, rect.maxZ].every(Number.isFinite)
            && rect.maxX > rect.minX && rect.maxZ > rect.minZ
            ? rect
            : null;
        return this.pendingDetailWindow;
    }

    // Releases the pending window. With notify (the default) it announces a
    // revision over the window so consumers that deferred on missing evidence
    // publish now; a merge that replaces the grid announces itself and passes
    // notify: false.
    clearPendingDetailWindow({ notify = true, reason = 'detail-window-released' } = {}) {
        const previous = this.pendingDetailWindow;
        if (!previous) return false;
        this.pendingDetailWindow = null;
        if (notify) this._emitChange({ reason, changedBounds: [previous] });
        return true;
    }

    evidenceWithheldAtLocal(localX, localZ) {
        const pending = this.pendingDetailWindow;
        if (!pending) return false;
        const x = Number(localX);
        const z = Number(localZ);
        if (!(x >= pending.minX && x <= pending.maxX && z >= pending.minZ && z <= pending.maxZ)) {
            return false;
        }
        for (const rect of this.detail?.rects || []) {
            if (x >= rect.minX && x <= rect.maxX && z >= rect.minZ && z <= rect.maxZ) return false;
        }
        return true;
    }

    heightAt(lon, lat) {
        return this.grid.sampleHeight(Number(lon), Number(lat));
    }

    absoluteToSceneY(heightM) {
        const height = Number(heightM);
        return (Number.isFinite(height) ? height : this.anchorHeightM) - this.anchorHeightM;
    }

    sourceSceneYAt(lon, lat) {
        const height = this.heightAt(lon, lat);
        // DGU's Split DTM deliberately has NoData over the Adriatic. Falling
        // those samples back to the *anchor* height turns the sea into a flat
        // elevated slab (46 m at proposal 5's eastern endpoint), which looks
        // exactly like a 180-degree world-orientation error. Keep fallbackM
        // absolute instead: the default 0 m follows the EVRF2000 sea datum,
        // while callers can still choose another explicit absolute fallback.
        return this.absoluteToSceneY(Number.isFinite(height) ? height : this.fallbackHeightM);
    }

    sceneYAt(lon, lat) {
        if (!this.surfaceStepM) return this.sourceSceneYAt(lon, lat);
        const localX = (Number(lon) - this.anchorLon) * this.metresPerDegreeLon;
        const localZ = -(Number(lat) - this.anchorLat) * this.metresPerDegreeLat;
        return this.sceneYAtLocal(localX, localZ);
    }

    // Geographic twin of evidenceSceneYAtLocal. Keep this beside the visual
    // sceneYAt API so GeoJSON consumers never have to reach into `grid` or
    // accidentally substitute the visible fallback datum for source evidence.
    evidenceSceneYAt(lon, lat) {
        const numericLon = Number(lon);
        const numericLat = Number(lat);
        const height = this.grid.sampleHeight(numericLon, numericLat);
        if (!Number.isFinite(height)) return null;
        const localX = (numericLon - this.anchorLon) * this.metresPerDegreeLon;
        const localZ = -(numericLat - this.anchorLat) * this.metresPerDegreeLat;
        if (this.evidenceWithheldAtLocal(localX, localZ)) return null;
        if (!this.surfaceStepM) return this.absoluteToSceneY(height);
        // Evidence decides WHETHER the point is publishable; once it is, use
        // the same piecewise-planar surface the visible terrain mesh renders.
        // This avoids a bilinear-vs-triangle mismatch that can let ground poke
        // through an otherwise correctly gated road or trackbed.
        return finiteOrNull(this.sceneYAtLocal(localX, localZ));
    }

    hasLoadedCoreCoverageAt(lon, lat) {
        const numericLon = Number(lon);
        const numericLat = Number(lat);
        if (![numericLon, numericLat].every(Number.isFinite)) return false;
        if (typeof this.grid.hasCoreCoverage === 'function') {
            return this.grid.hasCoreCoverage(numericLon, numericLat) === true;
        }
        return this.grid.contains?.(numericLon, numericLat) === true;
    }

    lonLatAtLocal(localX, localZ) {
        return {
            lon: this.anchorLon + Number(localX) / this.metresPerDegreeLon,
            lat: this.anchorLat - Number(localZ) / this.metresPerDegreeLat,
        };
    }

    sourceSceneYAtLocal(localX, localZ) {
        const point = this.lonLatAtLocal(localX, localZ);
        return this.sourceSceneYAt(point.lon, point.lat);
    }

    // Trusted terrain evidence for civil/vertical solvers. The visible world
    // deliberately falls back to the configured datum so an unloaded terrain
    // window never exposes void, but that fallback is not a surveyed height.
    // Feeding it into a road or rail grade solver makes every long feature
    // slope toward sea level while its far terrain tiles are still loading.
    // Preserve the distinction here, in the terrain authority itself: scene
    // rendering may use sceneYAtLocal(), while infrastructure uses this method
    // and receives null until the source actually covers the point.
    evidenceSceneYAtLocal(localX, localZ) {
        const point = this.lonLatAtLocal(localX, localZ);
        return this.evidenceSceneYAt(point.lon, point.lat);
    }

    hasLoadedCoreCoverageAtLocal(localX, localZ) {
        const point = this.lonLatAtLocal(localX, localZ);
        return this.hasLoadedCoreCoverageAt(point.lon, point.lat);
    }

    hasEvidenceAtLocal(localX, localZ) {
        return this.evidenceSceneYAtLocal(localX, localZ) !== null;
    }

    // Strict local publication barrier for geometry whose placement depends on
    // terrain. Every supplied point must have source coverage; an empty list is
    // not proof of readiness. Visual terrain itself intentionally does not use
    // this gate, because its fallback is the opaque no-void backstop.
    evidenceReadyForLocalPoints(points) {
        if (!Array.isArray(points) || points.length === 0) return false;
        for (const point of points) {
            const x = finiteOrNull(Array.isArray(point) ? point[0] : point?.x);
            const z = finiteOrNull(Array.isArray(point) ? point[1] : point?.z);
            if (x === null || z === null || !this.hasEvidenceAtLocal(x, z)) return false;
        }
        return true;
    }

    sceneYAtLocal(localX, localZ) {
        const x = Number(localX);
        const z = Number(localZ);
        const step = this.surfaceStepM;
        if (!step) return this.sourceSceneYAtLocal(x, z);
        const detail = this.detail;
        if (detail && this._pointIsFine(x, z)) {
            return this._planarSceneYAtLocal(
                x,
                z,
                detail.stepM,
                this._fineCornerSceneY
                    || (this._fineCornerSceneY = this._makeFineCornerSampler()),
            );
        }
        return this._planarSceneYAtLocal(
            x,
            z,
            step,
            this._coarseCornerSampler
                || (this._coarseCornerSampler = (i, j) => this._cornerSceneY(i, j)),
        );
    }

    // The rendered surface's sample step at a point — detail.stepM inside the
    // fine window, surfaceStepM elsewhere, null when no planar surface exists.
    // For consumers that TESSELLATE against the terrain (draped proposal
    // surfaces): edges finer than this step only interpolate between the same
    // samples, so the step IS the useful refinement floor — asked here rather
    // than hardcoded, because the resolution differs per location and per
    // point (the 1 m detail windows) and finer sources are coming.
    sampleStepMAtLocal(localX, localZ) {
        const x = Number(localX);
        const z = Number(localZ);
        if (!this.surfaceStepM) return null;
        if (this.detail && Number.isFinite(x) && Number.isFinite(z) && this._pointIsFine(x, z)) {
            return this.detail.stepM;
        }
        return this.surfaceStepM;
    }

    sampleStepMForBounds(bounds) {
        if (!this.surfaceStepM) return null;
        if (!this.detail) return this.surfaceStepM;
        return terrainLatticeStepForBounds(bounds, this.detail.tileM, (x, z) => (
            this.isFineTile(x, z) ? this.detail.stepM : this.surfaceStepM
        ));
    }

    // A tile (tileM square on the world tile grid) is fine when some rect
    // fully covers it; a point is fine when its tile is. Memoised per tile.
    isFineTile(tileI, tileJ) {
        const detail = this.detail;
        if (!detail) return false;
        const key = ((tileI & 0xffff) << 16) | (tileJ & 0xffff);
        const hit = this._fineTileCache.get(key);
        if (hit !== undefined) return hit;
        const minX = tileI * detail.tileM;
        const minZ = tileJ * detail.tileM;
        const maxX = minX + detail.tileM;
        const maxZ = minZ + detail.tileM;
        let fine = false;
        for (const rect of detail.rects) {
            if (minX >= rect.minX && maxX <= rect.maxX
                && minZ >= rect.minZ && maxZ <= rect.maxZ) {
                fine = true;
                break;
            }
        }
        this._fineTileCache.set(key, fine);
        return fine;
    }

    _pointIsFine(x, z) {
        const detail = this.detail;
        const bounds = detail.bounds;
        if (x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ) {
            return false;
        }
        return this.isFineTile(
            Math.floor(x / detail.tileM),
            Math.floor(z / detail.tileM),
        );
    }

    // Match terrain.js exactly: its regular XZ cell is split along the
    // b↔c diagonal into triangles (a,c,b) and (b,c,d). Sampling that same
    // piecewise-planar surface makes retaining seams and object placement
    // agree with the pixels the user actually sees, rather than with a
    // second bilinear interpretation of the source DTM.
    _planarSceneYAtLocal(x, z, step, cornerAt) {
        const i0 = Math.floor(x / step);
        const j0 = Math.floor(z / step);
        const tx = Math.max(0, Math.min(1, (x - i0 * step) / step));
        const tz = Math.max(0, Math.min(1, (z - j0 * step) / step));
        const y00 = cornerAt(i0, j0);
        if (tx < 1e-12 && tz < 1e-12) return y00;
        const y10 = cornerAt(i0 + 1, j0);
        const y01 = cornerAt(i0, j0 + 1);
        const y11 = cornerAt(i0 + 1, j0 + 1);
        if (tx + tz <= 1) {
            return y00 + (y10 - y00) * tx + (y01 - y00) * tz;
        }
        return y10 * (1 - tz) + y01 * (1 - tx) + y11 * (tx + tz - 1);
    }

    // Fine-step corner sampler with its own memo (the coarse cache keys on
    // coarse indices; mixing steps in one map would collide). A corner ON the
    // fine-tile-union boundary — i.e. not surrounded by fine tiles on all
    // four sides — takes the COARSE surface's value so the two surfaces meet
    // exactly along the region edge, whatever shape the tile union has.
    _makeFineCornerSampler() {
        const detail = this.detail;
        const step = detail.stepM;
        const tileM = detail.tileM;
        const cache = new Map();
        const tileAt = (value) => Math.floor(value / tileM);
        return (i, j) => {
            const key = ((i & 0xffff) << 16) | (j & 0xffff);
            const hit = cache.get(key);
            if (hit !== undefined) return hit;
            const x = i * step;
            const z = j * step;
            const eps = step * 0.5;
            const interior = this.isFineTile(tileAt(x - eps), tileAt(z - eps))
                && this.isFineTile(tileAt(x + eps), tileAt(z - eps))
                && this.isFineTile(tileAt(x - eps), tileAt(z + eps))
                && this.isFineTile(tileAt(x + eps), tileAt(z + eps));
            const value = interior
                ? this.sourceSceneYAtLocal(x, z)
                : this._planarSceneYAtLocal(
                    x,
                    z,
                    this.surfaceStepM,
                    this._coarseCornerSampler
                        || (this._coarseCornerSampler = (ci, cj) => this._cornerSceneY(ci, cj)),
                );
            cache.set(key, value);
            return value;
        };
    }

    // Memoised source height at grid corner (i, j) = (i*step, j*step). Corner
    // values are pure immutable terrain (no formation influence), so the cache
    // never needs invalidating within a session; a new session builds a fresh
    // TerrainReference and thus a fresh cache. Key is a 32-bit pack of the two
    // signed 16-bit grid indices (grid never spans > 32k cells = 655 km).
    _cornerSceneY(i, j) {
        let cache = this._cornerCache;
        if (!cache) cache = this._cornerCache = new Map();
        const key = ((i & 0xffff) << 16) | (j & 0xffff);
        const hit = cache.get(key);
        if (hit !== undefined) return hit;
        const value = this.sourceSceneYAtLocal(i * this.surfaceStepM, j * this.surfaceStepM);
        cache.set(key, value);
        return value;
    }

    setRoadFormation(model) {
        this.roadFormation = model || null;
    }

    setRailFormation(model) {
        this.railFormation = model || null;
    }

    // Exact immutable footprints of the currently rendered trackbed. Ordinary
    // street-running OSM tram has no engineered formation model, so this is a
    // separate surface-ownership contract rather than a fake civil alignment.
    setRenderedRailSurface(model) {
        this.renderedRailSurface = model || null;
    }

    normalAtLocal(localX, localZ, sampleStepM = 20) {
        const step = Math.max(1, Number(sampleStepM) || 20);
        const dx = (this.sceneYAtLocal(localX + step, localZ)
            - this.sceneYAtLocal(localX - step, localZ)) / (2 * step);
        const dz = (this.sceneYAtLocal(localX, localZ + step)
            - this.sceneYAtLocal(localX, localZ - step)) / (2 * step);
        const nx = -dx;
        const ny = 1;
        const nz = -dz;
        const length = Math.hypot(nx, ny, nz) || 1;
        return { x: nx / length, y: ny / length, z: nz / length };
    }

    evidenceNormalAtLocal(localX, localZ, sampleStepM = 20) {
        const step = Math.max(1, Number(sampleStepM) || 20);
        const leftY = this.evidenceSceneYAtLocal(localX - step, localZ);
        const rightY = this.evidenceSceneYAtLocal(localX + step, localZ);
        const behindY = this.evidenceSceneYAtLocal(localX, localZ - step);
        const aheadY = this.evidenceSceneYAtLocal(localX, localZ + step);
        if ([leftY, rightY, behindY, aheadY].some((value) => value === null)) {
            return null;
        }
        const dx = (rightY - leftY) / (2 * step);
        const dz = (aheadY - behindY) / (2 * step);
        const nx = -dx;
        const ny = 1;
        const nz = -dz;
        const length = Math.hypot(nx, ny, nz) || 1;
        return { x: nx / length, y: ny / length, z: nz / length };
    }

    slopeAlongHeadingDeg(lon, lat, headingDeg, distanceM = 20) {
        const distance = Math.max(2, Number(distanceM) || 20);
        const heading = Number(headingDeg) * DEG_TO_RAD;
        if (!Number.isFinite(heading)) return 0;
        const centerX = (Number(lon) - this.anchorLon) * this.metresPerDegreeLon;
        const centerZ = -(Number(lat) - this.anchorLat) * this.metresPerDegreeLat;
        const half = distance * 0.5;
        const forwardX = Math.sin(heading);
        const forwardZ = -Math.cos(heading);
        const behindY = this.sceneYAtLocal(centerX - forwardX * half, centerZ - forwardZ * half);
        const aheadY = this.sceneYAtLocal(centerX + forwardX * half, centerZ + forwardZ * half);
        return Math.atan2(aheadY - behindY, distance) / DEG_TO_RAD;
    }

    evidenceSlopeAlongHeadingDeg(lon, lat, headingDeg, distanceM = 20) {
        const distance = Math.max(2, Number(distanceM) || 20);
        const heading = Number(headingDeg) * DEG_TO_RAD;
        if (!Number.isFinite(heading)) return null;
        const centerX = (Number(lon) - this.anchorLon) * this.metresPerDegreeLon;
        const centerZ = -(Number(lat) - this.anchorLat) * this.metresPerDegreeLat;
        const half = distance * 0.5;
        const forwardX = Math.sin(heading);
        const forwardZ = -Math.cos(heading);
        const behindY = this.evidenceSceneYAtLocal(
            centerX - forwardX * half,
            centerZ - forwardZ * half,
        );
        const aheadY = this.evidenceSceneYAtLocal(
            centerX + forwardX * half,
            centerZ + forwardZ * half,
        );
        if (behindY === null || aheadY === null) return null;
        return Math.atan2(aheadY - behindY, distance) / DEG_TO_RAD;
    }

    // A single rigid foundation cannot follow every terrain vertex. Base it at
    // the HIGHEST footprint terrain point (ring vertices + centroid) so no part
    // of the building is ever buried in the slope; a separate foundation skirt
    // fills the resulting gap under the downhill side. On flat ground the max
    // equals the median, so level placement is unchanged.
    foundationSceneY(ring) {
        const points = (ring || []).filter(point => (
            Array.isArray(point) && finiteOrNull(point[0]) !== null && finiteOrNull(point[1]) !== null
        ));
        if (points.length === 0) return 0;
        let lonSum = 0;
        let latSum = 0;
        const sceneYs = [];
        for (const point of points) {
            const lon = Number(point[0]);
            const lat = Number(point[1]);
            lonSum += lon;
            latSum += lat;
            // Sample the SAME piecewise-planar surface the terrain mesh renders
            // (sceneYAt → sceneYAtLocal), not a second bilinear interpretation of
            // the DTM (heightAt). Using heightAt here made buildings float/sink by
            // up to ~a metre relative to the ground the player actually walks on —
            // exactly the mismatch sceneYAtLocal was written to avoid.
            const y = this.sceneYAt(lon, lat);
            if (Number.isFinite(y)) sceneYs.push(y);
        }
        const centerY = this.sceneYAt(lonSum / points.length, latSum / points.length);
        if (Number.isFinite(centerY)) sceneYs.push(centerY);
        const foundationY = maxFinite(sceneYs);
        return Number.isFinite(foundationY) ? foundationY : 0;
    }

    // Evidence-only foundation placement. Unlike foundationSceneY(), this is
    // nullable and all-or-nothing: a rigid footprint must not publish at a
    // fallback datum and then jump when the missing terrain tile arrives.
    evidenceFoundationSceneY(ring) {
        const points = (ring || []).filter(point => (
            Array.isArray(point) && finiteOrNull(point[0]) !== null && finiteOrNull(point[1]) !== null
        ));
        if (points.length === 0) return null;
        let lonSum = 0;
        let latSum = 0;
        const sceneYs = [];
        for (const point of points) {
            const lon = Number(point[0]);
            const lat = Number(point[1]);
            lonSum += lon;
            latSum += lat;
            const y = this.evidenceSceneYAt(lon, lat);
            if (y === null) return null;
            sceneYs.push(y);
        }
        const centerY = this.evidenceSceneYAt(
            lonSum / points.length,
            latSum / points.length,
        );
        if (centerY === null) return null;
        sceneYs.push(centerY);
        const foundationY = maxFinite(sceneYs);
        return Number.isFinite(foundationY) ? foundationY : null;
    }
}
