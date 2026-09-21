// A shopfront display in the shared city; interaction/purchase belongs to the
// foot controller. The existing building supplies the shop's facade.
import { createJetpackDisplayMesh } from '../models/objects/jetpack-display.js';
import { geoToLocal } from '../core/math.js';
import { scene } from '../scene/setup.js';

export const JETPACK_SHOP = Object.freeze({
    id: 'tbjj-jetpack-shop', lat: 45.813333, lon: 15.9769,
    nameKey: 'world.shopJetpack',
});
let session = null;
export function getNearbyJetpackShop(x, z, y, radius = 4) {
    if (!session?.group.visible || !Number.isFinite(session.groundY)
        || Math.abs(y - session.groundY) > 2) return null;
    const p = session.point;
    return Math.hypot(x - p.x, z - p.z) <= radius
        ? { ...JETPACK_SHOP, x: p.x, y: session.groundY, z: p.z } : null;
}
export const jetpackShopLayer = {
    beginSession(ctx) {
        this.endSession();
        const point = geoToLocal(JETPACK_SHOP.lon, JETPACK_SHOP.lat, ctx.anchorLon, ctx.anchorLat);
        const group = createJetpackDisplayMesh();
        group.name = 'JetpackShop'; group.visible = false;
        // Ground-floor frontage of building 111707, just south of 108044.
        // Its surveyed facade faces south-southwest into the square.
        group.rotation.y = -0.2125;
        scene.add(group);
        session = { group, point, groundY: null, ctx, nextPlacementMs: 0 };
    },
    onFrame(_pose, local) {
        if (!session || !local) return;
        const { point, ctx, group } = session;
        const nearby = Math.hypot(local.x - point.x, local.z - point.z) < 150;
        const now = performance.now();
        if (nearby && now >= session.nextPlacementMs) {
            session.nextPlacementMs = now + 1000;
            const terrainY = ctx.terrain?.evidenceSceneYAtLocal?.(point.x, point.z);
            const support = ctx.actorGroundYAt?.(point.x, point.z, Number.isFinite(terrainY) ? terrainY : null);
            const ground = Number.isFinite(support) ? support : terrainY;
            if (Number.isFinite(ground)) {
                session.groundY = ground;
                group.position.set(point.x, ground, point.z);
            }
        }
        group.visible = nearby && Number.isFinite(session.groundY);
    },
    endSession() {
        if (!session) return;
        session.group.removeFromParent();
        const resources = new Set();
        session.group.traverse(object => {
            if (object.geometry) resources.add(object.geometry);
            for (const material of [].concat(object.material || [])) {
                resources.add(material);
                if (material.map) resources.add(material.map);
            }
        });
        for (const resource of resources) resource.dispose();
        session = null;
    },
};
