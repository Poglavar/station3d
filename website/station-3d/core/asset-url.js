// Resolves static Station3D assets independently of the module/chunk that asks
// for them. Production chunks live under dist/chunks while checked-in media
// stays under station-3d/audio and station-3d/assets.

const nativeRootUrl = new URL('../', import.meta.url).href;

export function station3dAssetUrl(relativePath) {
    const configuredRoot = globalThis.window?.__station3DAssetConfig?.rootUrl;
    return new URL(String(relativePath || '').replace(/^\/+/, ''), configuredRoot || nativeRootUrl).href;
}
