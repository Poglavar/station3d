// Alt+click a building in the 3D view to open it in Google Street View. Reuses
// the same raycast-against-the-buildings-group approach as debug/inspect.js.
// For buildings that carry detected-window data we have the exact pano + heading
// the detection came from, so we open that precise frame (a built-in "is the
// detection right?" cross-check); otherwise we drop Street View at the clicked
// point's lat/lon and let Google pick the nearest pano.

import * as THREE from 'three';
import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';
import { getFacadePano } from './facade-windows.js';

const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
let _attachedTo = null;

// Inverse of geoToLocal: scene-local metres (x east, z south) → lon/lat about
// the cab anchor. Matches core/math.js geoToLocal exactly.
function localToLatLon(x, z, anchorLat, anchorLon) {
    const cosLat = Math.cos(anchorLat * DEG_TO_RAD);
    return {
        lon: anchorLon + x / (DEG_TO_RAD * EARTH_RADIUS_M * cosLat),
        lat: anchorLat - z / (DEG_TO_RAD * EARTH_RADIUS_M),
    };
}

function streetViewUrl(lat, lon, objectId) {
    const pano = objectId != null ? getFacadePano(objectId) : null;
    if (pano && pano.pano_id) {
        const h = Number.isFinite(pano.heading) ? `&heading=${pano.heading}` : '';
        return `https://www.google.com/maps/@?api=1&map_action=pano&pano=${encodeURIComponent(pano.pano_id)}${h}`;
    }
    return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat.toFixed(6)},${lon.toFixed(6)}`;
}

// Wire the handler. `getAnchor` returns { lat, lon } (the cab session anchor).
export function attachStreetViewLink({ camera, domElement, getBuildingsGroup, getAnchor }) {
    if (!camera || !domElement || typeof getBuildingsGroup !== 'function' || typeof getAnchor !== 'function') {
        console.warn('[streetview] attach missing required args; skipped');
        return;
    }
    _attachedTo = domElement;
    domElement.addEventListener('click', (e) => {
        if (!e.altKey) return;                 // Alt+click → Street View
        e.preventDefault();
        e.stopPropagation();
        const group = getBuildingsGroup();
        const anchor = getAnchor();
        if (!group || !anchor || anchor.lat == null) return;
        const rect = domElement.getBoundingClientRect();
        _ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        _ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        _ray.setFromCamera(_ndc, camera);
        const hits = _ray.intersectObject(group, true);
        if (!hits.length) return;
        const hit = hits[0];
        const objectId = hit.object && hit.object.userData ? hit.object.userData.objectId : null;
        const { lat, lon } = localToLatLon(hit.point.x, hit.point.z, anchor.lat, anchor.lon);
        window.open(streetViewUrl(lat, lon, objectId), '_blank', 'noopener');
    }, true);
}
