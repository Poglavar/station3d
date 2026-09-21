// Pure URL builder for sharing the position currently visible in Station3D.
// A cab/train session is normally shared as a walk/GTA inspection point: the
// receiver lands at the same coordinates and view direction without needing
// the sender's transient simulation state. Explicit campaign checkpoint links
// are different: keep their campaign mode so copying a position does not turn
// the story checkpoint into generic free roam.

import '../../station3d-links.js';

const TRANSPORT_QUERY_KEYS = [
    'cab',
    'station',
    'stop',
    'dir',
    'line',
    'shape',
    'offset',
    'loc',
];

function finiteNumber(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

export function buildPositionShareUrl({
    currentUrl,
    pose,
    sessionPresetId = null,
    lookYawRad = 0,
    lookPitchRad = 0,
    explorerBasePath = globalThis.__station3DLinks.DEFAULT_BASE_PATH,
} = {}) {
    const lat = finiteNumber(pose?.lat);
    const lon = finiteNumber(pose?.lon);
    if (lat == null || lon == null || !currentUrl) return '';

    let url;
    try {
        url = new URL(currentUrl);
    } catch (_) {
        return '';
    }

    const baseHeadingDeg = finiteNumber(pose?.headingDeg) || 0;
    const yawDeg = (finiteNumber(lookYawRad) || 0) * (180 / Math.PI);
    const pitchDeg = clamp(
        (finiteNumber(lookPitchRad) || 0) * (180 / Math.PI),
        -60,
        60,
    );
    const headingDeg = ((baseHeadingDeg + yawDeg) % 360 + 360) % 360;

    const requestedMode = (url.searchParams.get('st3d') || '').trim().toLowerCase();
    const route = globalThis.__station3DLinks.parseExplorerUrl(url.href, { basePath: explorerBasePath });
    const isCampaignCheckpoint = route.kind === 'checkpoint' || requestedMode === 'campaign'
        && !!(url.searchParams.get('campaign') || '').trim()
        && !!(url.searchParams.get('checkpoint') || '').trim();
    url.searchParams.set(
        'st3d',
        isCampaignCheckpoint ? 'campaign' : (sessionPresetId === 'gta' ? 'gta' : 'walk'),
    );
    url.searchParams.set('lat', lat.toFixed(6));
    url.searchParams.set('lon', lon.toFixed(6));
    url.searchParams.set('heading', headingDeg.toFixed(1));
    url.searchParams.set('pitch', pitchDeg.toFixed(1));
    for (const key of TRANSPORT_QUERY_KEYS) url.searchParams.delete(key);
    if (isCampaignCheckpoint || route.kind === 'campaign' || sessionPresetId === 'gta') {
        return globalThis.__station3DLinks.buildExplorerUrl({
            currentUrl: url.href, basePath: explorerBasePath,
            kind: isCampaignCheckpoint ? 'checkpoint' : route.kind === 'campaign' ? 'campaign' : 'gta',
            campaignId: route.campaignId || url.searchParams.get('campaign'),
            checkpointId: route.checkpointId || url.searchParams.get('checkpoint'),
            lat, lon,
        });
    }
    return url.toString();
}
