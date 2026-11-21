import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    compressCampaignPackPayload,
    decompressCampaignPackPayload,
} from '../core/campaign-pack-compression.js';

test('campaign pack gzip round-trips and shrinks repetitive geometry bytes', async () => {
    const source = new Uint8Array(256 * 1024);
    for (let index = 0; index < source.length; index++) source[index] = index % 17;
    const compressed = await compressCampaignPackPayload(source);
    const decoded = await decompressCampaignPackPayload(compressed, { encoding: 'gzip' });
    assert.ok(compressed.byteLength < source.byteLength / 10);
    assert.deepEqual(new Uint8Array(decoded), source);
});

test('campaign pack compression rejects undeclared codecs', async () => {
    await assert.rejects(
        compressCampaignPackPayload(new Uint8Array([1]), { encoding: 'brotli' }),
        /Unsupported/,
    );
});
