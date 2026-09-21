// The sealed parcel the whole run is about: oiled canvas over a flat board, a
// twine cross, a wax seal and a stencilled consignment mark. One shared prop so
// the object looks the same in Jerko's hands on the Vis quay, in the courier's,
// and on the map desk under Grič where Viktorija cuts it open.
import * as THREE from 'three';

// Flat, because what is inside it is a folded blueprint and a permit. Built
// lying down (x wide, y thick, z deep) so setting it on a desk needs no
// rotation and holding it out needs only a pitch.
export const SEALED_PACKAGE_SIZE_M = Object.freeze({
    widthM: 0.44,
    thicknessM: 0.075,
    depthM: 0.32,
});

function box(width, height, depth, material, name, position) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
    mesh.name = name;
    mesh.position.set(position[0], position[1], position[2]);
    return mesh;
}

export function createSealedPackageMesh() {
    const { widthM, thicknessM, depthM } = SEALED_PACKAGE_SIZE_M;
    const canvas = new THREE.MeshStandardMaterial({ color: 0x9c8b6b, roughness: 0.95 });
    const twineMaterial = new THREE.MeshStandardMaterial({ color: 0x6b5738, roughness: 0.9 });
    const waxMaterial = new THREE.MeshStandardMaterial({ color: 0x7d1f27, roughness: 0.55 });
    const inkMaterial = new THREE.MeshStandardMaterial({ color: 0x2f2c26, roughness: 0.94 });
    const paperMaterial = new THREE.MeshStandardMaterial({ color: 0xd8cba6, roughness: 0.96 });
    const brass = new THREE.MeshStandardMaterial({ color: 0xb08d3f, roughness: 0.42, metalness: 0.6 });

    const group = new THREE.Group();
    group.name = 'SealedPackage';
    group.add(box(widthM, thicknessM, depthM, canvas, 'SealedPackageWrap', [0, 0, 0]));

    // The twine runs over the top, down both ends and back underneath, so the
    // cross reads from every angle the two films use.
    const twine = new THREE.Group();
    twine.name = 'SealedPackageTwine';
    twine.add(box(widthM + 0.012, thicknessM + 0.011, 0.02, twineMaterial, 'SealedPackageTwineLong', [0, 0, 0]));
    twine.add(box(0.02, thicknessM + 0.011, depthM + 0.012, twineMaterial, 'SealedPackageTwineCross', [0, 0, 0]));
    const seal = new THREE.Mesh(new THREE.CylinderGeometry(0.033, 0.036, 0.011, 12), waxMaterial);
    seal.name = 'SealedPackageWaxSeal';
    seal.position.set(0, thicknessM * 0.5 + 0.011, 0);
    twine.add(seal);
    group.add(twine);

    // A stencilled consignment mark: enough to say "this is freight", not
    // enough to be readable, which would need a texture and a lie about what
    // the paperwork says.
    const stencil = new THREE.Group();
    stencil.name = 'SealedPackageStencil';
    for (const [index, width] of [0.11, 0.07, 0.13].entries()) {
        stencil.add(box(
            width,
            0.003,
            0.016,
            inkMaterial,
            `SealedPackageStencilBar${index}`,
            [-0.1 + index * 0.005, thicknessM * 0.5 + 0.002, -0.086 + index * 0.035],
        ));
    }
    group.add(stencil);

    // Shown only for the Vis handover: Jerko lays the boat key on top before he
    // holds the parcel out, so "the package and the keys" is one gesture.
    const key = new THREE.Group();
    key.name = 'SealedPackageBoatKey';
    key.position.set(0.11, thicknessM * 0.5 + 0.008, 0.085);
    key.rotation.y = 0.42;
    key.add(box(0.052, 0.005, 0.011, brass, 'SealedPackageBoatKeyShaft', [0, 0, 0]));
    key.add(box(0.012, 0.005, 0.022, brass, 'SealedPackageBoatKeyBit', [0.022, 0, 0.008]));
    const bow = new THREE.Mesh(new THREE.TorusGeometry(0.014, 0.004, 6, 12), brass);
    bow.name = 'SealedPackageBoatKeyBow';
    bow.position.set(-0.036, 0, 0);
    bow.rotation.x = Math.PI / 2;
    key.add(bow);
    key.visible = false;
    group.add(key);

    // Revealed as the twine is cut: the folded blueprint lifting out of the
    // wrapping. The film cuts to the full-screen artwork a beat later.
    const contents = new THREE.Group();
    contents.name = 'SealedPackageContents';
    contents.add(box(widthM - 0.06, 0.014, depthM - 0.05, paperMaterial, 'SealedPackageBlueprint', [0, 0, 0]));
    contents.visible = false;
    group.add(contents);

    group.userData.sealedPackage = { twine, key, contents, stencil };
    return group;
}

// ratio 0 → sealed; 1 → twine off and the blueprint clear of the wrapping.
export function setSealedPackageOpen(mesh, ratio) {
    const parts = mesh?.userData?.sealedPackage;
    if (!parts) return;
    const open = Math.max(0, Math.min(1, Number(ratio) || 0));
    parts.twine.visible = open < 0.5;
    parts.contents.visible = open > 0.15;
    parts.contents.position.y = SEALED_PACKAGE_SIZE_M.thicknessM * 0.5 + open * 0.055;
    parts.contents.rotation.z = open * 0.14;
}

export function setSealedPackageKeyVisible(mesh, visible) {
    const parts = mesh?.userData?.sealedPackage;
    if (parts) parts.key.visible = visible === true;
}
