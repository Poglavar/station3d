// Resolves static Station3D assets independently of the module/chunk that asks
// for them. Production chunks live under dist/chunks while checked-in media
// stays under station-3d/audio and station-3d/assets.

const nativeRootUrl = new URL('../', import.meta.url).href;
// Native source hosts own their media tree. Production builds embed the exact
// audited file set, so optional samples omitted from the package stay disabled.
const packagedAssets = typeof __STATION3D_PACKAGED_ASSETS__ === 'undefined'
    ? null : new Set(__STATION3D_PACKAGED_ASSETS__);

export function station3dAssetUrl(relativePath) {
    const configuredRoot = globalThis.window?.__station3DAssetConfig?.rootUrl;
    return new URL(String(relativePath || '').replace(/^\/+/, ''), configuredRoot || nativeRootUrl).href;
}

export function station3dOptionalAssetUrl(relativePath) {
    const path = String(relativePath || '').replace(/^\/+/, '');
    const config = globalThis.window?.__station3DAssetConfig;
    const customRoot = config?.rootUrl && config.rootUrl !== config.baseUrl;
    if (packagedAssets && !customRoot && !packagedAssets.has(path)) return null;
    return station3dAssetUrl(path);
}
