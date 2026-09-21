// A prepared graph and an active graph have different validity rules. Source
// leases protect preparation; the shared publication slot protects immutable
// active reads after those source leases have been released. Keep one active
// graph and at most one private successor, sharing their retained query data.
import { ownReadSnapshot, retainReadSnapshot } from './read-snapshot-lifetime.js';

export function createPublishedGroundReadSlot() {
    let active = null, pending = null, closed = false, revision = 0;
    return Object.freeze({
        hasActive: () => !closed && active !== null,
        capture(owner) { return closed ? null : active?.read.retain(owner) || null; },
        begin({ isCurrent }) {
            if (closed || pending || typeof isCurrent !== 'function') {
                throw Object.assign(new Error('Published ground read slot is unavailable'), { code: 'ground-dependency-busy' });
            }
            const previous = active, previousRevision = revision;
            const row = { read: null };
            let phase = 'preparing';
            const current = () => !closed && phase === 'preparing' && pending === tx
                && active === previous && isCurrent();
            const queryCurrent = () => phase === 'preparing' ? current()
                : !closed && (phase === 'committed' || phase === 'published') && active === row;
            const tx = Object.freeze({
                isCurrent: current, queryCurrent,
                get published() { return phase === 'committed' || phase === 'published'; },
                bindRead(read) {
                    if (!current() || row.read || !Object.isFrozen(read) || typeof read.isCurrent !== 'function') {
                        throw new TypeError('Published ground requires one complete captured receiver read');
                    }
                    row.read = ownReadSnapshot({ ...read, isCurrent: queryCurrent,
                        currentWithin: () => queryCurrent }, [retainReadSnapshot(read, 'published-ground-receivers')]);
                },
                commit() {
                    // The registry validates every source before any member
                    // commits. Earlier road/terrain members have moved by now.
                    if (closed || phase !== 'preparing' || pending !== tx || active !== previous || !row.read) return false;
                    active = row; revision++; phase = 'committed'; return true;
                },
                rollback() {
                    if (phase !== 'committed' || active !== row) return false;
                    active = previous; revision = previousRevision; phase = 'preparing'; return true;
                },
                discard() {
                    if (phase !== 'preparing') return false;
                    phase = 'discarded'; if (pending === tx) pending = null;
                    row.read?.release(); row.read = null; return true;
                },
                finalize() {
                    if (phase !== 'committed' || active !== row) return false;
                    phase = 'published'; if (pending === tx) pending = null;
                    previous?.read.release(); return true;
                },
            });
            pending = tx; return tx;
        },
        snapshot: () => ({ revision, active: active ? 1 : 0, pending: pending ? 1 : 0, closed }),
        close() {
            if (closed) return;
            // An unfinalized commit owns both generations. Finalize first so
            // its former active owner is retired even during exceptional close.
            try { if (pending?.published) pending.finalize(); else pending?.discard(); }
            finally { closed = true; pending = null;
                const previous = active; active = null; previous?.read.release(); }
        },
    });
}
