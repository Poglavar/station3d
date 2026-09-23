// Packs variable-length per-owner instance blocks contiguously at the front of
// shared instance buffers, so an InstancedMesh's draw count covers only occupied
// instances. Fixed per-owner slots left empty capacity between owners inside
// the drawn range: street lamps drew 24,675 instances for 744 real lamps
// (2026-09-23). Removing a block slides later blocks down in place.

export function createPackedInstanceBlocks({ capacity, stride = 16 } = {}) {
    if (!(Number.isInteger(capacity) && capacity > 0)) throw new TypeError('Packed instance blocks need a positive integer capacity');
    const blocks = new Map(); // key → { offset, length }, offsets mutate as earlier blocks leave
    let used = 0;
    return {
        get used() { return used; },
        get size() { return blocks.size; },
        // Reserves `length` instances after the current blocks; returns the live block record.
        append(key, length) {
            if (blocks.has(key)) throw new Error(`Instance block ${key} already exists`);
            if (!(Number.isInteger(length) && length >= 0)) throw new TypeError('Instance block length must be a non-negative integer');
            if (used + length > capacity) throw new RangeError(`Instance blocks exceed capacity ${capacity}`);
            const block = { offset: used, length };
            blocks.set(key, block);
            used += length;
            return block;
        },
        // Removes a block, compacting `arrays` (per-instance buffers of `stride` values each) and
        // zeroing the freed tail. Returns false when the key has no block.
        remove(key, arrays = []) {
            const block = blocks.get(key);
            if (!block) return false;
            blocks.delete(key);
            const start = block.offset * stride, end = (block.offset + block.length) * stride;
            for (const array of arrays) {
                array.copyWithin(start, end, used * stride);
                array.fill(0, (used - block.length) * stride, used * stride);
            }
            for (const other of blocks.values()) if (other.offset > block.offset) other.offset -= block.length;
            used -= block.length;
            return true;
        },
    };
}
