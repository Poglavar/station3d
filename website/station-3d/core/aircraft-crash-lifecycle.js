// State-only lifecycle for a bounded aircraft wreck effect. The world owns the
// model/sound factories; this module makes transition and teardown behaviour
// directly testable without Three, DOM, or audio globals.

export function createAircraftCrashLifecycle({
    wrecked = false,
    createVisual,
    playSound,
    now = () => performance.now(),
} = {}) {
    let isWrecked = wrecked === true;
    let visual = null;
    let active = null;

    function reset() {
        active?.sound?.stop?.();
        active = null;
        visual?.reset?.();
        visual = null;
        isWrecked = false;
    }

    function settle() {
        if (!isWrecked) return;
        visual ??= createVisual?.() || null;
        visual?.settle?.();
    }

    function sync(nextWrecked) {
        const next = nextWrecked === true;
        if (!isWrecked && next) {
            active?.sound?.stop?.();
            visual?.reset?.();
            visual = createVisual?.() || null;
            active = {
                visual,
                sound: playSound?.() || null,
                startedMs: now(),
            };
            isWrecked = true;
            return true;
        }
        if (isWrecked && !next) reset();
        else if (next && visual && !active) visual.settle?.();
        isWrecked = next;
        return false;
    }

    function advance() {
        if (!active) return false;
        if (!active.visual?.advance?.((now() - active.startedMs) / 1000)) return true;
        active.sound?.stop?.();
        active = null;
        return false;
    }

    return Object.freeze({
        sync,
        settle,
        advance,
        reset,
        dispose: reset,
        get active() { return active !== null; },
        get visual() { return visual; },
    });
}
