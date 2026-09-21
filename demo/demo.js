// Configures the published facade exactly as an external host would.
const button = document.querySelector('#open-world');
const status = document.querySelector('#status');

try {
    const station3d = await window.__station3DReady;
    station3d.configureWorld({
        id: 'synthetic-demo',
        apiBaseUrl: '/demo-api',
        worldProfile: {
            id: 'synthetic-demo',
            buildings: 'overture',
            farBuildings: false,
            decorEnabled: false,
            apiDecor: false,
            passengers: false,
            water: false,
            terrain: { surfaceStyle: 'grass' },
        },
        attributions: [{ name: 'Synthetic Station3D demonstration data' }],
    });
    station3d.configureHost({
        name: 'Station3D demo',
        devOverlays: false,
    });
    button.disabled = false;
    button.textContent = 'Open the 3D world';
    status.textContent = 'Bundle ready. No Zagreb host code or private API is present.';
    button.addEventListener('click', () => {
        station3d.open(48.8566, 2.3522, 'Station3D demo');
    });
} catch (error) {
    status.textContent = `Engine load failed: ${error.message}`;
}
