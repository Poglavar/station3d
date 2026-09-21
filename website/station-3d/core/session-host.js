// Small host boundary shared by the lazy facade and runtime. World rules stay
// in the engine; the embedding app owns where an explicit exit takes the user
// and whether the localhost diagnostics overlays open by themselves.
let host = Object.freeze({});

export function configureSessionHost(options = {}) {
    host = Object.freeze({
        basePath: options.basePath || null,
        name: options.name || null,
        onExit: typeof options.onExit === 'function' ? options.onExit : null,
        // The planner keeps its dev default (FPS + PERF panels on localhost);
        // a player-facing host such as Sloboda starts clean and opts in with
        // F, ?stats or the stored preference.
        devOverlays: options.devOverlays !== false,
        // Campaign support is an engine capability, not an obligation for
        // every embedding product. Story hosts keep the default; planners and
        // inspectors can omit the entry point without forking the runtime.
        campaigns: options.campaigns !== false,
    });
    return host;
}

export function getSessionHost() { return host; }
