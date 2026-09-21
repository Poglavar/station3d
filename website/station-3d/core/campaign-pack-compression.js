function asBlobPart(value) {
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
    throw new TypeError('Campaign pack compression requires binary input');
}

async function transform(value, StreamType, format) {
    if (typeof StreamType !== 'function') {
        throw new Error(`${format} campaign pack compression is unavailable`);
    }
    const stream = new Blob([asBlobPart(value)]).stream().pipeThrough(new StreamType(format));
    return new Response(stream).arrayBuffer();
}

export async function compressCampaignPackPayload(
    value,
    { encoding = 'gzip', CompressionStreamImpl = globalThis.CompressionStream } = {},
) {
    if (encoding === 'identity') {
        const bytes = value instanceof ArrayBuffer
            ? value
            : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        return bytes;
    }
    if (encoding !== 'gzip') throw new Error(`Unsupported campaign pack encoding: ${encoding}`);
    return transform(value, CompressionStreamImpl, encoding);
}

export async function decompressCampaignPackPayload(
    value,
    { encoding = 'identity', DecompressionStreamImpl = globalThis.DecompressionStream } = {},
) {
    if (encoding === 'identity' || !encoding) {
        return value instanceof ArrayBuffer
            ? value
            : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    if (encoding !== 'gzip') throw new Error(`Unsupported campaign pack encoding: ${encoding}`);
    return transform(value, DecompressionStreamImpl, encoding);
}
