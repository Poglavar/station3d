import * as THREE from 'three';

export function createJetpackDisplayMesh() {
    const group = new THREE.Group(); group.name = 'JetpackDisplay';
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.5, 0.35), new THREE.MeshStandardMaterial({ color: 0x263746, roughness: .7 }));
    frame.position.y = .75; group.add(frame);
    const pack = new THREE.Mesh(new THREE.BoxGeometry(.3, .55, .18), new THREE.MeshStandardMaterial({ color: 0xd28b24, roughness: .6 }));
    pack.position.set(0, .85, .22); group.add(pack);
    const tankGeometry = new THREE.CylinderGeometry(.09, .09, .46, 10);
    const nozzleGeometry = new THREE.CylinderGeometry(.045, .075, .12, 8);
    const metal = new THREE.MeshStandardMaterial({ color: 0xc4d1d5, metalness: .65, roughness: .3 });
    for (const side of [-1, 1]) {
        const tank = new THREE.Mesh(tankGeometry, metal);
        tank.position.set(side * .14, .88, .35); group.add(tank);
        const nozzle = new THREE.Mesh(nozzleGeometry, metal);
        nozzle.position.set(side * .14, .59, .35); group.add(nozzle);
    }
    const signPost = new THREE.Mesh(new THREE.BoxGeometry(.06, .6, .06), metal);
    signPost.position.set(0, 1.75, 0); group.add(signPost);
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 96;
    const context = canvas.getContext('2d'); context.fillStyle = '#f4c542'; context.fillRect(0, 0, 512, 96); context.fillStyle = '#17222b'; context.font = 'bold 38px sans-serif'; context.textAlign = 'center'; context.fillText('LETEĆI RUKSACI', 256, 62);
    const signTexture = new THREE.CanvasTexture(canvas);
    const sign = new THREE.Mesh(new THREE.BoxGeometry(1.8, .32, .04), new THREE.MeshBasicMaterial({ map: signTexture }));
    sign.name = 'LetećiRuksaciSign'; sign.position.set(0, 2.05, 0); group.add(sign);
    group.userData.signTexture = signTexture;
    return group;
}
