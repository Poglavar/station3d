// Query graphs share compiled arrays and callbacks. Retain only their upstream
// read owners; copying the graph for each builder would turn a lease into work.
export function retainReadSnapshot(read, owner) {
    if (read?.release && typeof read.retain !== 'function') {
        throw new TypeError('An owned read must support retaining a derived owner');
    }
    return read?.retain?.(owner) || read;
}

// Takes ownership of the supplied reads, including on subsequent release.
// A consumer that outlives this handle must retain its own handle first.
export function ownReadSnapshot(view, reads) {
    let owned = reads.filter(read => typeof read?.release === 'function');
    return Object.freeze({ ...view,
        retain(owner) {
            if (!owned) throw Object.assign(new Error('Read snapshot owner was released'), { code: 'read-snapshot-released' });
            const retained = [];
            try {
                for (const read of owned) retained.push(retainReadSnapshot(read, owner));
                return ownReadSnapshot(view, retained);
            } catch (error) {
                for (const read of retained) read.release();
                throw error;
            }
        },
        release() {
            if (!owned) return false;
            const retiring = owned;
            owned = null;
            for (const read of retiring) read.release();
            return true;
        },
    });
}
