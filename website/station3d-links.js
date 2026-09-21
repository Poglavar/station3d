// Shared pure URL codec: paths identify explorer sessions, while query
// parameters carry camera, world and debugging options without a whitelist.
(function exposeStation3DLinks(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.__station3DLinks = api;
}(globalThis, function createLinks() {
    'use strict';
    const DEFAULT_BASE_PATH = '/sloboda/';
    const CAMPAIGN_ALIASES = Object.freeze({ toranj: 'toranj-ljepote-snage-slobode' });
    const IDENTITY_KEYS = ['st3d', 'lat', 'lon', 'campaign', 'checkpoint', 'loc'];
    const TRANSPORT_KEYS = ['cab', 'station', 'stop', 'dir', 'line', 'shape', 'offset', 'project', 'new', 'scene'];

    function number(value) {
        if (value == null || String(value).trim() === '') return null;
        const text = String(value).trim();
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
        return Number.isFinite(Number(text)) ? Number(text) : null;
    }

    function validCoordinates(lat, lon) {
        return number(lat) !== null && number(lon) !== null
            && Number(lat) >= -90 && Number(lat) <= 90 && Number(lon) >= -180 && Number(lon) <= 180;
    }

    function normalizeBasePath(value = DEFAULT_BASE_PATH) {
        const path = `/${String(value).replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');
        if (/[?#\\]/.test(path) || path.split('/').some(part => part === '.' || part === '..')) {
            throw new TypeError('Invalid explorer base path.');
        }
        return path;
    }

    function railProfileModeFrom(value) {
        const mode = String(value || '').trim().toLowerCase();
        return mode === 'solved' || mode === 'osm' ? mode : null;
    }

    function parseSessionQuery(search = '') {
        const params = new URLSearchParams(search);
        return {
            mode: (params.get('st3d') || '').trim().toLowerCase(),
            lat: number(params.get('lat')), lon: number(params.get('lon')),
            headingDeg: number(params.get('heading')) ?? 0,
            pitchDeg: number(params.get('pitch')) ?? 0,
            // Explicit only: absent means the host's default (solved where the
            // reference rail service answers, OSM otherwise).
            railProfileMode: railProfileModeFrom(params.get('railProfile')),
            proposalIds: (params.get('proposals') || '').split(',').map(value => value.trim()).filter(Boolean),
            campaignId: (params.get('campaign') || '').trim() || null,
            checkpointId: (params.get('checkpoint') || '').trim() || null,
        };
    }

    function canonicalCampaignId(value) {
        return Object.hasOwn(CAMPAIGN_ALIASES, value) ? CAMPAIGN_ALIASES[value]
            : (Object.values(CAMPAIGN_ALIASES).includes(value) ? value : null);
    }

    function parseExplorerUrl(input, { basePath = DEFAULT_BASE_PATH, places = {} } = {}) {
        let url;
        try { url = new URL(input); }
        catch (_error) { return { kind: 'invalid', isExplorer: false, error: 'invalid-url' }; }
        const query = parseSessionQuery(url.search);
        const root = normalizeBasePath(basePath);
        const isExplorer = url.pathname === root.slice(0, -1) || url.pathname.startsWith(root);
        const result = { ...query, kind: 'other', isExplorer, error: null };
        const invalid = error => ({ ...result, kind: 'invalid', error });
        const gta = values => validCoordinates(values.lat, values.lon)
            ? { ...result, ...values, kind: 'gta', mode: 'gta' } : invalid('invalid-coordinates');
        const campaign = () => {
            if (!query.campaignId && !query.checkpointId) return { ...result, kind: 'campaign-menu', mode: 'campaign' };
            const campaignId = canonicalCampaignId(query.campaignId);
            if (!campaignId) return invalid('unknown-campaign');
            return { ...result, campaignId, kind: query.checkpointId ? 'checkpoint' : 'campaign', mode: 'campaign' };
        };
        if (!isExplorer) {
            if (query.mode === 'gta') return gta(query);
            if (query.mode === 'campaign') return campaign();
            return result;
        }
        let parts;
        try {
            const relative = url.pathname === root.slice(0, -1) ? '' : url.pathname.slice(root.length);
            parts = relative.replace(/\/$/, '').split('/');
            if (parts.length === 1 && parts[0] === '') parts = [];
            parts = parts.map(part => decodeURIComponent(part));
            if (parts.some(part => !part || /[/\\]/.test(part))) return invalid('invalid-path');
        } catch (_error) { return invalid('invalid-path'); }
        if (parts.length === 0) {
            if (query.mode === 'campaign') return campaign();
            if (query.mode === 'gta' || url.searchParams.has('lat') || url.searchParams.has('lon')) return gta(query);
            return { ...result, kind: 'map', mode: null };
        }
        if (parts[0] === 'kampanja') {
            if (parts.length === 1) return { ...result, kind: 'campaign-menu', mode: 'campaign', campaignId: null, checkpointId: null };
            const campaignId = Object.hasOwn(CAMPAIGN_ALIASES, parts[1]) ? CAMPAIGN_ALIASES[parts[1]] : null;
            if (!campaignId || parts.length > 3) return invalid('unknown-campaign');
            return { ...result, kind: parts.length === 3 ? 'checkpoint' : 'campaign', mode: 'campaign',
                campaignId, checkpointId: parts[2] || null };
        }
        if (parts.length !== 1) return invalid('invalid-path');
        if (parts[0].startsWith('@')) {
            const coords = parts[0].slice(1).split(',');
            if (coords.length !== 2) return invalid('invalid-coordinates');
            return gta({ lat: number(coords[0]), lon: number(coords[1]), campaignId: null, checkpointId: null });
        }
        if (!Object.hasOwn(places, parts[0])) return invalid('unknown-place');
        const place = places[parts[0]];
        return gta({ lat: place.lat, lon: place.lon, city: parts[0],
            headingDeg: number(url.searchParams.get('heading')) ?? place.headingDeg ?? 0,
            pitchDeg: number(url.searchParams.get('pitch')) ?? place.pitchDeg ?? 0,
            campaignId: null, checkpointId: null });
    }

    // Whether an address starts a session (a free-roam world or a campaign)
    // rather than the map. A host asks before its first paint, so a deep link
    // starts on the loading screen instead of flashing the map page. It follows
    // the session controller as far as classic scripts can: a point or place
    // must lie inside `isInCroatia` when that is given, a campaign address needs
    // `campaignEnabled`, and without a place list any single name counts as a
    // place (the host turns an unknown one into the map and a notice once it
    // has loaded).
    function explorerAddressOpensSession(input, {
        basePath = DEFAULT_BASE_PATH, places = null, isInCroatia = null, campaignEnabled = false,
    } = {}) {
        const route = parseExplorerUrl(input, { basePath, places: places || {} });
        if (route.kind === 'gta') return typeof isInCroatia !== 'function' || isInCroatia(route.lat, route.lon) === true;
        if (route.kind === 'invalid') return route.error === 'unknown-place' && !places;
        return ['campaign-menu', 'campaign', 'checkpoint'].includes(route.kind) && campaignEnabled === true;
    }

    function formatCoordinate(value) { return Number(Number(value).toFixed(6)).toString(); }

    function buildExplorerUrl({ currentUrl, basePath = DEFAULT_BASE_PATH, kind = 'gta',
        lat, lon, campaignId, checkpointId, city } = {}) {
        const url = new URL(currentUrl);
        const root = normalizeBasePath(basePath);
        const position = kind === 'checkpoint' && validCoordinates(url.searchParams.get('lat'), url.searchParams.get('lon'))
            ? [url.searchParams.get('lat'), url.searchParams.get('lon')] : null;
        for (const key of [...IDENTITY_KEYS, ...TRANSPORT_KEYS]) url.searchParams.delete(key);
        if (kind === 'map') url.pathname = root;
        else if (kind === 'campaign-menu') url.pathname = `${root}kampanja/`;
        else if (kind === 'campaign' || kind === 'checkpoint') {
            const id = canonicalCampaignId(campaignId || CAMPAIGN_ALIASES.toranj);
            const alias = Object.keys(CAMPAIGN_ALIASES).find(key => CAMPAIGN_ALIASES[key] === id);
            if (!alias) throw new TypeError('Unknown campaign.');
            if (kind === 'checkpoint' && (!checkpointId || ['.', '..'].includes(checkpointId) || /[/\\]/.test(checkpointId))) throw new TypeError('Invalid checkpoint.');
            url.pathname = `${root}kampanja/${alias}/${kind === 'checkpoint' ? `${encodeURIComponent(checkpointId)}/` : ''}`;
            if (position) { url.searchParams.set('lat', position[0]); url.searchParams.set('lon', position[1]); }
        } else if (kind === 'gta') {
            if (city) {
                if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(city)) throw new TypeError('Invalid city.');
                url.pathname = `${root}${city}/`;
            } else {
                if (!validCoordinates(lat, lon)) throw new TypeError('Invalid coordinates.');
                url.pathname = `${root}@${formatCoordinate(lat)},${formatCoordinate(lon)}/`;
            }
        } else throw new TypeError('Unknown explorer route.');
        return url.href;
    }

    function legacyExplorerRedirect(currentUrl, { basePath = DEFAULT_BASE_PATH } = {}) {
        const url = new URL(currentUrl);
        const route = parseExplorerUrl(url.href, { basePath });
        if (route.isExplorer || !['gta', 'campaign'].includes(route.mode)) return null;
        // Keep malformed legacy input visible to the new host's error UI.
        if (route.kind === 'invalid') { url.pathname = normalizeBasePath(basePath); return url.href; }
        return buildExplorerUrl({ currentUrl, basePath, ...route });
    }

    return { DEFAULT_BASE_PATH, CAMPAIGN_ALIASES, parseSessionQuery, parseExplorerUrl, explorerAddressOpensSession,
        buildExplorerUrl, legacyExplorerRedirect, normalizeBasePath, validCoordinates, TRANSPORT_KEYS };
}));
