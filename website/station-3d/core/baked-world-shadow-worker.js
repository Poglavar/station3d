// One session-owned, Three-free decoder. Shadow retains comparison evidence;
// explicit authority transfers validated packets to the existing far uploader.
import { decodeBakedWorldTile } from './baked-world-tile.js';
import { validateWorldManifest } from './baked-world-manifest.js';
import { createBakedFarShadowIndex } from './baked-far-shadow-index.js';
import { renderPacketTransferables } from './render-packet.js';
import { indexBakedFarTile } from './baked-far-authority.js';

const index = createBakedFarShadowIndex();
let chain = Promise.resolve();
self.onmessage = ({ data }) => {
    // crypto.digest yields: serialize commands so retain cannot be overtaken by decode.
    chain = chain.then(async () => {
        try {
            let value;
            if (data.kind === 'manifest') value = validateWorldManifest(JSON.parse(new TextDecoder().decode(data.bytes)), data.expected);
            else if (data.kind === 'tile') {
                const tile = await decodeBakedWorldTile(data.bytes, { ...data.descriptor, checksum: data.descriptor.sha256 });
                if (tile.bakeVersion !== data.descriptor.bakeVersion || tile.entities.length !== data.descriptor.entities
                    || tile.packet.primitives.length !== data.descriptor.primitives || tile.state !== data.descriptor.state) {
                    throw new Error('Decoded tile disagrees with pinned manifest');
                }
                value = data.transferTile ? indexBakedFarTile(tile) : index.put(tile);
            } else if (data.kind === 'retain') value = index.retain(data.keys);
            else if (data.kind === 'compare') value = index.compare(data.evidence);
            else throw new Error('Unsupported shadow Worker command');
            self.postMessage({ id: data.id, value }, data.transferTile ? renderPacketTransferables(value.tile.packet) : []);
        } catch (error) { self.postMessage({ id: data.id, error: { name: error.name, message: error.message } }); }
    });
};
