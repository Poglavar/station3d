// First-person cab interior: the static frame around the driver's view —
// dashboard cowl, windshield header + A-pillars + centre mullion, side
// posts/sills and a roof hint. A fixed frame is the strongest speed cue a
// cockpit can have; everything is a handful of dark boxes (1 shared
// material + emissive dots), no shadows, no per-frame logic beyond one
// transform, so the cost is effectively zero.
//
// The group follows the tram's HEADING while drag-look rotates the camera
// inside it — like sitting in a seat. Convention matches the tram mesh:
// front at local -Z, group.rotation.y = -heading.

import { scene } from '../scene/setup.js';
import { createCabInterior } from '../models/vehicles/cab-interior.js';

let group = null;


// Per-frame: place the interior at the driver's eye, aligned to the tram
// heading. Night raises the indicator glow.
export function updateCabInterior({ x = 0, y = 0, z = 0, headingRad = 0, visible = false, night = false } = {}) {
    if (!visible) {
        if (group) group.visible = false;
        return;
    }
    if (!group) {
        group = createCabInterior();
        scene.add(group);
    }
    group.visible = true;
    group.position.set(x, y, z);
    group.rotation.y = -headingRad;
    if (group.userData.indicatorMaterial) group.userData.indicatorMaterial.emissiveIntensity = night ? 1.1 : 0.25;
}

export function disposeCabInterior() {
    if (!group) return;
    if (group.parent) group.parent.remove(group);
    for (const child of group.children) {
        if (child.geometry) child.geometry.dispose();
    }
    group = null;
}
