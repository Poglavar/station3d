// Diagnostic draw-call attribution for the existing WebGL renderer.
//
// three.js exposes only one aggregate `renderer.info.render.calls` counter,
// which combines shadow-map draws with the visible colour pass. Object3D's
// before/after callbacks bracket each actual renderBufferDirect call, including
// material groups and double-sided transparent draws, so their counter delta
// lets the perf HUD split the total without changing the render pipeline.

function finiteCalls(value) {
    const calls = Number(value);
    return Number.isFinite(calls) && calls > 0 ? calls : 0;
}

function rendererCalls(renderer) {
    return finiteCalls(renderer?.info?.render?.calls);
}

function addCalls(map, key, calls) {
    if (!(calls > 0)) return;
    map.set(key, (map.get(key) || 0) + calls);
}

function renderGroupLabel(root, object) {
    let node = object;
    let nearestName = '';
    let inspectionLabel = '';
    let top = object;
    while (node && node !== root) {
        const explicit = String(node.userData?.perfRenderGroup || '').trim();
        if (explicit) return explicit;
        if (!inspectionLabel) {
            inspectionLabel = String(
                node.userData?.station3dInspectionLayer?.label || '',
            ).trim();
        }
        if (!nearestName && String(node.name || '').trim()) {
            nearestName = String(node.name).trim();
        }
        top = node;
        node = node.parent;
    }
    return String(top?.name || '').trim()
        || inspectionLabel
        || nearestName
        || String(top?.type || object?.type || 'unnamed');
}

function sortedGroups(main, shadow, frameCount) {
    const names = new Set([...main.keys(), ...shadow.keys()]);
    return [...names].map((name) => {
        const mainCalls = (main.get(name) || 0) / frameCount;
        const shadowCalls = (shadow.get(name) || 0) / frameCount;
        return {
            name,
            mainCalls,
            shadowCalls,
            calls: mainCalls + shadowCalls,
        };
    }).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}

export function createRenderCallAttributor({
    scanIntervalMs = 1000,
    now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
} = {}) {
    const wrapped = new WeakMap();
    const labels = new WeakMap();
    const intervalMs = Math.max(0, Number(scanIntervalMs) || 0);
    let lastScanMs = -Infinity;
    let active = false;
    let frameMain = new Map();
    let frameShadow = new Map();
    let windowMain = new Map();
    let windowShadow = new Map();
    let windowTotalCalls = 0;
    let windowUnattributedCalls = 0;
    let windowFrames = 0;

    const note = (pass, object, calls) => {
        if (!active || !(calls > 0)) return;
        const label = labels.get(object) || 'unclassified';
        addCalls(pass === 'shadow' ? frameShadow : frameMain, label, calls);
    };

    const installCallbacks = (object) => {
        let state = wrapped.get(object);
        if (!state) {
            state = { mainStart: null, shadowStart: null };
            wrapped.set(object, state);
        }
        const install = (property, makeWrapper) => {
            const installed = state[property];
            if (installed && object[property] === installed.wrapper) return;
            const original = typeof object[property] === 'function'
                ? object[property]
                : () => {};
            const wrapper = makeWrapper(original);
            state[property] = { original, wrapper };
            object[property] = wrapper;
        };
        install('onBeforeRender', original => function attributedBeforeRender(...args) {
            const result = original.apply(this, args);
            if (active) state.mainStart = rendererCalls(args[0]);
            return result;
        });
        install('onAfterRender', original => function attributedAfterRender(...args) {
            if (active && state.mainStart != null) {
                note('main', object, rendererCalls(args[0]) - state.mainStart);
            }
            state.mainStart = null;
            return original.apply(this, args);
        });
        install('onBeforeShadow', original => function attributedBeforeShadow(...args) {
            const result = original.apply(this, args);
            if (active) state.shadowStart = rendererCalls(args[0]);
            return result;
        });
        install('onAfterShadow', original => function attributedAfterShadow(...args) {
            if (active && state.shadowStart != null) {
                note('shadow', object, rendererCalls(args[0]) - state.shadowStart);
            }
            state.shadowStart = null;
            return original.apply(this, args);
        });
    };

    return {
        // Scene content streams continuously. Re-scan at a low cadence so new
        // drawables join attribution without traversing the world every frame.
        refresh(root, atMs = now()) {
            const timestamp = Number(atMs);
            if (!root?.traverse || (Number.isFinite(timestamp)
                && timestamp - lastScanMs < intervalMs)) return 0;
            lastScanMs = Number.isFinite(timestamp) ? timestamp : now();
            let count = 0;
            root.traverse((object) => {
                if (!object || !(object.isMesh || object.isLine
                    || object.isPoints || object.isSprite)) return;
                labels.set(object, renderGroupLabel(root, object));
                installCallbacks(object);
                count += 1;
            });
            return count;
        },

        beginFrame() {
            frameMain = new Map();
            frameShadow = new Map();
            active = true;
        },

        endFrame(totalCalls = 0) {
            active = false;
            const mainCalls = [...frameMain.values()].reduce((sum, value) => sum + value, 0);
            const shadowCalls = [...frameShadow.values()].reduce((sum, value) => sum + value, 0);
            const total = finiteCalls(totalCalls);
            const unattributedCalls = Math.max(0, total - mainCalls - shadowCalls);
            for (const [name, calls] of frameMain) addCalls(windowMain, name, calls);
            for (const [name, calls] of frameShadow) addCalls(windowShadow, name, calls);
            windowTotalCalls += total;
            windowUnattributedCalls += unattributedCalls;
            windowFrames += 1;
            return {
                totalCalls: total,
                mainCalls,
                shadowCalls,
                unattributedCalls,
                // Keep the ownership of this exact frame. Window averages are
                // useful for ranking floors, but they cannot explain the one
                // render pass that actually crossed the stutter threshold.
                groups: sortedGroups(frameMain, frameShadow, 1),
            };
        },

        takeWindow() {
            const frames = Math.max(1, windowFrames);
            const snapshot = {
                frames: windowFrames,
                totalCalls: windowTotalCalls / frames,
                mainCalls: [...windowMain.values()].reduce((sum, value) => sum + value, 0) / frames,
                shadowCalls: [...windowShadow.values()].reduce((sum, value) => sum + value, 0) / frames,
                unattributedCalls: windowUnattributedCalls / frames,
                groups: sortedGroups(windowMain, windowShadow, frames),
            };
            windowMain = new Map();
            windowShadow = new Map();
            windowTotalCalls = 0;
            windowUnattributedCalls = 0;
            windowFrames = 0;
            return snapshot;
        },

        reset() {
            active = false;
            frameMain = new Map();
            frameShadow = new Map();
            windowMain = new Map();
            windowShadow = new Map();
            windowTotalCalls = 0;
            windowUnattributedCalls = 0;
            windowFrames = 0;
        },
    };
}
