// "Vidi" mode: the orbit-camera station view. A symbolic station marker sits
// at the centre, a 100m ring shows the catchment, and the buildings within
// that radius are loaded from the cadastre API. Catchment stats (population
// + jobs) are fetched in parallel and shown in the modal info row.
//
// Owns its own per-frame hook (orbit-controls update) so scene/animate.js
// never has to know which mode is active.

import {
    camera, controls,
    groundMesh, ringMesh, northArrowMesh, stationMarker, sun, fill,
} from '../scene/setup.js';
import { onBeforeRender } from '../scene/animate.js';
import { setMode } from '../state.js';
import { setTitleText, setInfoSlot, clearInfo, setRideShareUrl } from '../ui/modal.js';
import { renderStatusOverlay, hideDriverHud } from '../ui/hud.js';
import { updateDriverControls } from '../ui/driver-controls.js';
import { formatNumber } from '../core/text.js';
import {
    loadBuildingsRadius, loadCatchmentStats, closeStaticBuildings,
} from '../world/buildings.js';
import { t } from '../core/i18n.js';
import { applyAnchorStyle } from '../core/locations.js';

let unregisterFrameHook = null;

function enterStaticMode() {
    setMode('static');
    setRideShareUrl('');
    if (groundMesh) groundMesh.position.set(0, 0, 0);
    if (ringMesh) ringMesh.visible = true;
    if (northArrowMesh) northArrowMesh.visible = true;
    if (stationMarker) stationMarker.visible = true;
    if (controls) {
        controls.enabled = true;
        controls.target.set(0, 0, 0);
    }
    camera.position.set(0, 110, 130);
    camera.lookAt(0, 0, 0);
    // Recenter both the sun (and fill) and their targets — a previous cab
    // session would have shifted them along the tram route.
    if (sun) {
        sun.target.position.set(0, 0, 0);
        sun.position.set(120, 160, 80);
    }
    if (fill) {
        fill.target.position.set(0, 0, 0);
        fill.position.set(-120, 160, -80);
    }
    renderStatusOverlay(null);
    hideDriverHud();
    updateDriverControls();

    if (!unregisterFrameHook) {
        // Orbit damping needs per-frame update(); static mode registers its
        // own hook so scene/animate.js stays mode-agnostic.
        unregisterFrameHook = onBeforeRender(() => {
            if (controls) controls.update();
        });
    }
}

export function openStatic(lat, lon, name, options) {
    enterStaticMode();
    applyAnchorStyle(lat, lon);
    setTitleText(name || t('modal.defaultTitle'));

    const isDepot = options && options.stationType === 'depot';
    const markerScale = isDepot ? 5 : 1;
    if (stationMarker) stationMarker.scale.set(markerScale, markerScale, markerScale);

    clearInfo();
    setInfoSlot('buildings', t('info.loading'));

    loadCatchmentStats(lat, lon, (data) => {
        const pop = formatNumber(data.catchment_population);
        const jobs = formatNumber(data.catchment_jobs);
        setInfoSlot('stats', [`🏠 ${pop}`, `💼 ${jobs}`]);
    });

    loadBuildingsRadius(lat, lon,
        (msg) => setInfoSlot('buildings', msg),
        (count) => setInfoSlot('buildings', `🏢 ${formatNumber(count)}`));
}

export function closeStatic() {
    closeStaticBuildings();
    if (unregisterFrameHook) {
        unregisterFrameHook();
        unregisterFrameHook = null;
    }
}
