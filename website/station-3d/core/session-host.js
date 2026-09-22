// Small host boundary shared by the lazy facade and runtime. World rules stay
// in the engine; the embedding app owns where an explicit exit takes the user
// and whether the localhost diagnostics overlays open by themselves.
let host = Object.freeze({});

function optionalString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function loadingScreenConfiguration(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const loadingScreen = Object.freeze({
        logoUrl: optionalString(value.logoUrl),
        logoAlt: typeof value.logoAlt === 'string' ? value.logoAlt.trim() : '',
        background: optionalString(value.background),
        foreground: optionalString(value.foreground),
        accent: optionalString(value.accent),
    });
    return Object.values(loadingScreen).some(Boolean) ? loadingScreen : null;
}

export function configureSessionHost(options = {}) {
    host = Object.freeze({
        basePath: options.basePath || null,
        name: options.name || null,
        onExit: typeof options.onExit === 'function' ? options.onExit : null,
        // Loading-screen presentation belongs to the embedding product. The
        // engine supplies the layout and progress behavior, but no regional
        // logo or product palette of its own.
        loadingScreen: loadingScreenConfiguration(options.loadingScreen),
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
