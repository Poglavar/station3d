// Wakes the ground coordinator when downloaded source tiles are parked behind
// a closed generation's delivery barrier. Only an admission lifts that barrier,
// and only a delivered tile invalidates ground, so without this an observer who
// stops moving never receives tiles that already finished downloading.

// countHeld(): callbacks waiting behind barriers; isIdle(): the coordinator has
// no active or pending generation; publishedCount(): its publication counter;
// wake(): request the next admission. A wake that publishes without reducing
// the held count is a stall: it is reported, and retried only after some other
// generation has published, so an undeliverable callback cannot loop forever.
export function createHeldDeliveryWake({ countHeld, isIdle, publishedCount, wake }) {
    if (![countHeld, isIdle, publishedCount, wake].every(value => typeof value === 'function')) {
        throw new TypeError('Held delivery wake requires count, idle, publication and wake callbacks');
    }
    let lastWake = null, wakes = 0, stalled = false;
    return Object.freeze({
        onFrame() {
            if (!isIdle()) return false;
            const held = countHeld();
            if (!(held > 0)) { lastWake = null; stalled = false; return false; }
            const published = publishedCount();
            if (lastWake) {
                // Idle again without a publication: the woken generation failed
                // or was rejected. The coordinator reports that cause; do not
                // hammer it, retry after a publication from anything else.
                if (published === lastWake.published) { stalled = true; return false; }
                const onlyOurs = published === lastWake.published + 1;
                if (onlyOurs && held >= lastWake.held) { stalled = true; return false; }
            }
            stalled = false;
            lastWake = { held, published };
            wakes += 1;
            wake();
            return true;
        },
        snapshot: () => ({ wakes, stalled, lastWakeHeld: lastWake?.held ?? null }),
    });
}
