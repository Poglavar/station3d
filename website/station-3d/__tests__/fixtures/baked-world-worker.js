// Fixture-only Worker exercises the same Three-free decoder Node baking uses.
import { decodeBakedWorldTile } from '../../core/baked-world-tile.js';
import { renderPacketTransferables } from '../../core/render-packet.js';
self.onmessage = async ({ data }) => {
    try {
        const tile = await decodeBakedWorldTile(data.bytes, data.expected);
        self.postMessage({ tile }, renderPacketTransferables(tile.packet));
    } catch (error) {
        self.postMessage({ error: { message: error.message, code: error.code } });
    }
};
