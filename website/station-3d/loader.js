// Selects the debuggable native-ESM source graph on local hosts and the stable
// production bundle everywhere else. `?bundle3d=1` exercises production chunks
// locally without changing the deployed entry URL.
(function loadStation3DEntry() {
    const host = window.location.hostname;
    const local = host === 'localhost' || host === '127.0.0.1'
        || host === '[::1]' || host === '::1' || host === '' || host.endsWith('.local');
    const params = new URLSearchParams(window.location.search || '');
    const useSource = local && params.get('bundle3d') !== '1';
    // Dynamic import in an external classic script resolves against this
    // script's own URL (/station-3d/loader.js), not the document URL.
    const entry = useSource ? './lazy-entry.js' : './dist/index.js';
    window.__station3DEntryUrl = entry;
    window.__station3DReady = import(entry).then(
        () => window.Station3D,
        (error) => {
            window.__station3DLoadError = error;
            console.error('[Station3D] entry load failed:', error);
            return null;
        },
    );
    window.dispatchEvent(new Event('station3d:loader-ready'));
}());
