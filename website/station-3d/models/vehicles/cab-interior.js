// Pure first-person cab interior model factory. Placement and lifecycle remain in the vehicle adapter.
import * as THREE from 'three';
import { registerShared } from '../../core/dispose.js';

const FRAME_COLOR = 0x1b2026;
const DASH_COLOR = 0x22272e;

function box(w, h, d, mat) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    return mesh;
}

// Flat pane helper for the tinted glass (side windows + saloon door window).
function plane(w, h, mat) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    return mesh;
}

export function createCabInterior() {
    const g = new THREE.Group();
    g.name = 'CabInterior';
    const frameMat = new THREE.MeshStandardMaterial({
        color: FRAME_COLOR,
        roughness: 0.85,
        metalness: 0.15,
        envMapIntensity: 0.25,
    });
    const dashMat = new THREE.MeshStandardMaterial({
        color: DASH_COLOR,
        roughness: 0.9,
        metalness: 0.05,
        envMapIntensity: 0.2,
    });
    const indicatorMat = new THREE.MeshStandardMaterial({
        color: 0x3a4c38,
        emissive: 0x9dff8a,
        emissiveIntensity: 0.25,
        roughness: 0.4,
    });
    // Tinted saloon/side glass: near-transparent so the world reads through it,
    // depthWrite off to dodge transparency-sort artifacts against the frame.
    const glassMat = new THREE.MeshStandardMaterial({
        color: 0x8fb6c8,
        transparent: true,
        opacity: 0.12,
        roughness: 0.1,
        metalness: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
    });
    // Dark rubber/fabric for the floor and driver seat.
    const darkMat = new THREE.MeshStandardMaterial({
        color: 0x14181d,
        roughness: 1.0,
        metalness: 0.0,
        envMapIntensity: 0.15,
    });
    registerShared(frameMat, dashMat, indicatorMat, glassMat, darkMat);

    // Dashboard cowl: angled slab across the bottom of the view.
    const dash = box(2.3, 0.5, 0.6, dashMat);
    dash.position.set(0, -0.62, -0.92);
    dash.rotation.x = -0.22;
    g.add(dash);

    // Indicator dots on the cowl top, right of centre like the TMK console.
    for (let i = 0; i < 3; i++) {
        const dot = box(0.035, 0.012, 0.035, indicatorMat);
        dot.position.set(0.28 + i * 0.09, -0.36, -0.78);
        dot.rotation.x = -0.22;
        g.add(dot);
    }

    // Windshield header + roof hint above.
    const header = box(2.5, 0.16, 0.12, frameMat);
    header.position.set(0, 0.58, -1.14);
    g.add(header);
    const roof = box(2.5, 0.05, 0.85, frameMat);
    roof.position.set(0, 0.68, -0.72);
    g.add(roof);

    // A-pillars, slightly toed-in toward the windshield plane. Placed to
    // show as slim posts at the edges of a 16:9 desktop view while staying
    // OUTSIDE a portrait phone's narrower horizontal FOV — mobile keeps the
    // full windshield. No centre mullion: the TMK 2200 driver looks through
    // one big pane, and a bar dead-centre just blocks the track ahead.
    // Round section, not square: a real A-pillar is a rolled/extruded tube, and
    // a box read as a flat plank edge-on. Slightly oval (scaled in Z) so it
    // keeps the fore-aft depth the box had.
    for (const side of [-1, 1]) {
        const pillar = new THREE.Mesh(
            new THREE.CylinderGeometry(0.045, 0.045, 1.5, 14, 1),
            frameMat,
        );
        pillar.castShadow = false;
        pillar.receiveShadow = false;
        pillar.scale.z = 1.45;
        pillar.position.set(side * 0.80, -0.05, -1.10);
        pillar.rotation.y = side * 0.2;
        g.add(pillar);
    }

    // Side posts + window sills so looking sideways reveals door framing
    // instead of open air.
    for (const side of [-1, 1]) {
        const post = box(0.12, 1.55, 0.15, frameMat);
        post.position.set(side * 1.14, -0.02, 0.42);
        g.add(post);
        const sill = box(0.07, 0.09, 1.55, frameMat);
        sill.position.set(side * 1.15, -0.52, -0.32);
        g.add(sill);
    }

    // --- Enclosure: turn the frame into a sealed cabin so drag-look reveals
    // cab walls/floor/glass instead of open road. All direct children of g.

    // Floor: dark rubber slab under the whole cab, top at y ~ -1.25.
    const floor = box(2.3, 0.05, 2.4, darkMat);
    floor.position.set(0, -1.275, 0);
    g.add(floor);

    // Lower front wall: closes the gap between the dashboard cowl and floor.
    const frontWall = box(2.3, 0.8, 0.08, frameMat);
    frontWall.position.set(0, -0.95, -1.12);
    g.add(frontWall);

    for (const side of [-1, 1]) {
        // Side wall lower panel: floor up to the window sill.
        const panel = box(0.06, 0.73, 2.3, frameMat);
        panel.position.set(side * 1.15, -0.885, 0);
        g.add(panel);

        // Side window: single tinted pane above the sill.
        const win = plane(1.95, 1.0, glassMat);
        win.position.set(side * 1.13, 0.05, -0.025);
        win.rotation.y = Math.PI / 2;
        g.add(win);

        // B-pillar: rear-corner post mirroring the mid side posts.
        const bpost = box(0.12, 1.55, 0.15, frameMat);
        bpost.position.set(side * 1.14, -0.02, 1.1);
        g.add(bpost);
    }

    // Rear bulkhead (wall to the passenger saloon): solid lower half, a header
    // strip, two side jambs and a tinted door window in the middle opening.
    const bhLower = box(2.3, 0.9, 0.08, frameMat);
    bhLower.position.set(0, -0.80, 1.18);
    g.add(bhLower);
    const bhHeader = box(2.3, 0.25, 0.08, frameMat);
    bhHeader.position.set(0, 0.575, 1.18);
    g.add(bhHeader);
    for (const side of [-1, 1]) {
        const jamb = box(0.25, 0.8, 0.08, frameMat);
        jamb.position.set(side * 1.025, 0.05, 1.18);
        g.add(jamb);
    }
    const bhWindow = plane(1.8, 0.8, glassMat);
    bhWindow.position.set(0, 0.05, 1.18);
    g.add(bhWindow);

    // Roof extension: cover the cab from the roof hint's rear edge to the
    // bulkhead, same height as the roof hint.
    const roofExt = box(2.5, 0.05, 1.475, frameMat);
    roofExt.position.set(0, 0.68, 0.4425);
    g.add(roofExt);

    // Driver seat hint: cushion + backrest, tucked behind the eye so it never
    // clips the camera.
    const cushion = box(0.55, 0.12, 0.5, darkMat);
    cushion.position.set(0, -0.78, 0.30);
    g.add(cushion);
    const backrest = box(0.55, 0.65, 0.10, darkMat);
    backrest.position.set(0, -0.40, 0.55);
    g.add(backrest);

    g.visible = false;
    g.userData.indicatorMaterial = indicatorMat;
    return g;
}
