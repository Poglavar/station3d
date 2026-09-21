// Top-down minimap overlay for the cab/walk sim. Draws the drivable route and
// the station dots once per ride (projected to local metres via geoToLocal),
// then the live tram/walker position + heading each frame. Pure 2D canvas in
// the HUD layer — north-up, no second camera, no scene geometry. The player
// position is re-projected from pose lat/lon each frame with the session anchor,
// so it stays aligned with the route in both model and photo modes.
//
// A 🗺️ toggle collapses the map down to just its icon (state persists across
// rides). The canvas lives inside a fixed-size panel because the 3D container's
// CSS forces `canvas { width:100% !important }` — 100% then resolves to the
// panel's size instead of the whole viewport.

import { containerEl, titleEl } from './modal.js';
import { getWorldStatusDotEl } from './world-status-dot.js';
import { getSoundToggleEl, setSoundToggleVisible } from './sound-toggle.js';
import { finiteOrNull, geoToLocal } from '../core/math.js';
import { MINIMAP_LAYOUT_EVENT } from '../core/hud-overlay-layout.js';
import { navigationMapContext } from '../core/navigation-map-context.js';
import {
    CITY_CENTRE_POINTER_PATH,
    advanceNavigationWaypoint,
    rejoinNavigationRoute,
    cityCentreGuideTopPx,
    cityCentreGuidance,
    formatGuidanceDistance,
    minimapMarkerPlacement,
    minimapPointToScreen,
    minimapViewportNeedsRecenter,
    minimapViewportTransform,
    ZAGREB_CITY_CENTRE,
    minimapFollowSpan,
    navigationWaypointsFor,
    skipRecedingWaypoint,
} from '../core/navigation-guidance.js';

let wrapEl = null;
let toggleBtn = null;
let panelEl = null;
let canvasEl = null;
let ctx = null;
let centreGuideEl = null;
let centreArrowEl = null;
let centreTextEl = null;
// Current ride's projected geometry + world→screen transform, or null when
// there is nothing worth drawing.
let session = null;
// Persists across rides. A ride starts with the map open; a campaign starts
// it closed — the story's own objective card owns that corner and a phone
// frame has no room for both — until the player opens it with the 🗺️
// button, after which their choice stands for the rest of the visit.
let collapsed = false;
let collapseChosenByPlayer = false;

const SIZE = 148;   // logical (css) px — the map is a square
const PAD = 10;     // inner margin so edge geometry/player isn't clipped
const CONTEXT_REFRESH_MS = 500;
const DPR = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
const GUIDE_UPDATE_INTERVAL_MS = 100;
let lastGuideUpdateMs = -Infinity;
let lastGuideRotation = null;
let lastGuideText = '';
let lastGuideTopPx = null;
let guideHostEl = null;
let guideVisible = false;

// The guide floats over the map by default. The campaign HUD hands it a host
// instead — its one-line instruction band — where it becomes a chip in that
// line: a centred pill between two full-width bands reads as a third shape,
// and the band already names the target, so the chip keeps only the arrow and
// the distance.
const GUIDE_FLOATING_CSS = [
    'position:absolute',
    'top:12px',
    'left:50%',
    'z-index:6',
    'display:none',
    'align-items:center',
    'gap:7px',
    'padding:6px 10px',
    'pointer-events:none',
    'transform:translateX(-50%)',
    'border-radius:999px',
    'border:1px solid rgba(255,255,255,0.18)',
    'background:rgba(16,18,22,0.72)',
    'box-shadow:0 2px 12px rgba(0,0,0,0.35)',
    'color:#fff',
    'font:600 12px/1 system-ui,sans-serif',
    'white-space:nowrap',
].join(';');

const GUIDE_HOSTED_CSS = [
    'position:static',
    'display:none',
    'align-items:center',
    'gap:4px',
    'flex:0 0 auto',
    'min-height:30px',
    'padding:0',
    'pointer-events:none',
    'transform:none',
    'border:0',
    'background:transparent',
    'box-shadow:none',
    'color:inherit',
    'font-weight:700',
    'font-size:0.82rem',
    'font-variant-numeric:tabular-nums',
    'white-space:nowrap',
].join(';');

function applyGuideVisibility() {
    if (!centreGuideEl) return;
    const display = guideVisible ? (guideHostEl ? 'inline-flex' : 'flex') : 'none';
    if (centreGuideEl.style.display !== display) centreGuideEl.style.display = display;
}

function applyGuidePlacement() {
    if (!centreGuideEl) return;
    const host = guideHostEl || containerEl;
    if (!host || centreGuideEl.parentNode === host) {
        applyGuideVisibility();
        return;
    }
    host.appendChild(centreGuideEl);
    centreGuideEl.style.cssText = guideHostEl ? GUIDE_HOSTED_CSS : GUIDE_FLOATING_CSS;
    // The hosted chip writes a different string and never takes a floating
    // `top`, so the other placement's cached values must not suppress the
    // first write after a switch.
    lastGuideTopPx = null;
    lastGuideRotation = null;
    lastGuideText = '';
    applyGuideVisibility();
}

// Folds the guide into another element (the campaign instruction line); pass
// null to return it to floating over the minimap.
export function setGuideHost(element) {
    guideHostEl = element || null;
    applyGuidePlacement();
}

// Mode-agnostic on purpose: the cab minimap sits in the same top-left corner as
// the walk one, so the FPS/diagnostics overlays have to stack below it in BOTH
// modes. Gating this on walk mode left the cab's stats box sitting on top of the
// map at its default 109 px.
function expandedMapVisible() {
    return !collapsed
        && wrapEl?.style.display !== 'none'
        && panelEl?.style.display !== 'none';
}

function announceMinimapLayout() {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(MINIMAP_LAYOUT_EVENT, {
        detail: { expanded: expandedMapVisible() },
    }));
}

// The toggle lives in the header next to the title in BOTH modes — in the cab
// the title is the line badge, so the map button sits right beside the line
// number instead of floating over the map it opens. It goes AFTER the title
// element rather than inside it: renderCabTitle() rewrites the title's
// innerHTML on every update and would delete a child button.
function placeToggle() {
    if (!wrapEl || !toggleBtn || !panelEl) return;
    if (titleEl?.parentElement) titleEl.insertAdjacentElement('afterend', toggleBtn);
    else wrapEl.insertBefore(toggleBtn, panelEl);
    // The world-loading light rides along on the right of the map button. It has to be re-placed
    // here for the same reason the button does: renderCabTitle() rewrites the title on every
    // update, and anything parked next to it gets moved with it.
    const worldStatusEl = getWorldStatusDotEl();
    toggleBtn.insertAdjacentElement('afterend', worldStatusEl);
    worldStatusEl.insertAdjacentElement('afterend', getSoundToggleEl());
}

function applyCollapsedState() {
    if (!panelEl || !toggleBtn) return;
    panelEl.style.display = collapsed ? 'none' : 'block';
    toggleBtn.style.opacity = collapsed ? '0.7' : '1';
    toggleBtn.title = collapsed ? 'Prikaži kartu' : 'Sakrij kartu';
    announceMinimapLayout();
}

function ensureMinimap() {
    if (wrapEl || !containerEl) return;

    wrapEl = document.createElement('div');
    wrapEl.className = 'station-3d-minimap-wrap';
    wrapEl.style.cssText = [
        'position:absolute',
        // Snug under the top bar (dev Stats overlay may overlap it). The
        // campaign objective card claims the same corner, so it lowers this
        // variable on the container rather than covering the map.
        'top:var(--station3d-minimap-top, 12px)',
        'left:12px',
        'z-index:6',
        'display:none',        // shown when a ride opens
        'pointer-events:none', // empty area passes clicks through to the scene
        'flex-direction:column',
        'gap:6px',
        'align-items:flex-start',
    ].join(';');

    toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.textContent = '🗺️';
    toggleBtn.style.cssText = [
        'width:30px',
        'height:30px',
        'flex:0 0 30px',
        'margin:0',
        'padding:0',
        'font-size:15px',
        // Centre the glyph by BOX, not by line-height/text-align: an emoji's
        // ink sits off-centre inside its em box, so 30 px line-height left the
        // 🗺️ visibly low and slightly left of the button's middle.
        'display:inline-flex',
        'align-items:center',
        'justify-content:center',
        'line-height:1',
        'cursor:pointer',
        'pointer-events:auto',
        'border-radius:8px',
        'border:1px solid rgba(255,255,255,0.18)',
        'background:rgba(16,18,22,0.72)',
        'color:#fff',
    ].join(';');
    toggleBtn.addEventListener('click', () => {
        collapsed = !collapsed;
        collapseChosenByPlayer = true;
        applyCollapsedState();
    });
    wrapEl.appendChild(toggleBtn);

    panelEl = document.createElement('div');
    panelEl.className = 'station-3d-minimap-panel';
    panelEl.style.cssText = [
        'position:relative',
        `width:${SIZE}px`,
        `height:${SIZE}px`,
        'pointer-events:none',
        'border-radius:9px',
        'overflow:hidden',
        'background:rgba(16,18,22,0.60)',
        'border:1px solid rgba(255,255,255,0.16)',
        'box-shadow:0 2px 12px rgba(0,0,0,0.45)',
    ].join(';');

    canvasEl = document.createElement('canvas');
    canvasEl.width = SIZE * DPR;
    canvasEl.height = SIZE * DPR;
    // The container rule forces width/height:100% !important; 100% here is the
    // panel (SIZE px), so the square canvas renders at the intended size.
    canvasEl.style.cssText = 'display:block';
    ctx = canvasEl.getContext('2d');
    panelEl.appendChild(canvasEl);
    wrapEl.appendChild(panelEl);

    containerEl.appendChild(wrapEl);

    // View-relative direction to Zagreb's centre. This is ordinary HUD DOM,
    // not a THREE object: it contributes zero scene geometry, triangles or
    // WebGL draw calls. Updates are throttled below and unchanged DOM values
    // are not written again.
    centreGuideEl = document.createElement('div');
    centreGuideEl.className = 'station-3d-city-centre-guide';
    centreGuideEl.title = ZAGREB_CITY_CENTRE.title;
    centreGuideEl.setAttribute('aria-label', `Smjer prema ${ZAGREB_CITY_CENTRE.title}`);

    centreArrowEl = document.createElement('span');
    centreArrowEl.style.cssText = [
        'display:inline-flex',
        'width:20px',
        'height:22px',
        'align-items:center',
        'justify-content:center',
        'flex:0 0 20px',
        'transform-origin:50% 50%',
    ].join(';');
    const pointerSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    pointerSvg.setAttribute('viewBox', '0 0 20 24');
    pointerSvg.setAttribute('width', '20');
    pointerSvg.setAttribute('height', '22');
    pointerSvg.setAttribute('aria-hidden', 'true');
    const pointerPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    // A long shaft and broad arrowhead make the pointing end unambiguous at
    // every rotation, unlike the old equilateral triangle.
    pointerPath.setAttribute('d', CITY_CENTRE_POINTER_PATH);
    pointerPath.setAttribute('fill', '#ff9d3c');
    pointerPath.setAttribute('stroke', '#fff');
    pointerPath.setAttribute('stroke-width', '1.2');
    pointerPath.setAttribute('stroke-linejoin', 'round');
    pointerSvg.appendChild(pointerPath);
    centreArrowEl.appendChild(pointerSvg);
    centreGuideEl.appendChild(centreArrowEl);

    centreTextEl = document.createElement('span');
    centreGuideEl.appendChild(centreTextEl);
    applyGuidePlacement();

    placeToggle();
    applyCollapsedState();
}

// Prefer the driveable route (the drawn track the cab runs on); fall back to the
// broader OSM network features if no driver graph was built (e.g. some walks).
// Returns segments as [lon1, lat1, lon2, lat2].
function collectSegments(src) {
    const segs = [];
    const edges = src && src.driverGraph && src.driverGraph.edges;
    if (Array.isArray(edges) && edges.length) {
        for (const e of edges) {
            if ([e.lat1, e.lng1, e.lat2, e.lng2].every((v) => Number.isFinite(v))) {
                segs.push([e.lng1, e.lat1, e.lng2, e.lat2]);
            }
        }
        if (segs.length) return segs;
    }
    for (const f of (src && src.otherTracks) || []) {
        const coords = f && f.geometry && f.geometry.coordinates;
        if (!Array.isArray(coords)) continue;
        for (let i = 0; i < coords.length - 1; i++) {
            const a = coords[i];
            const b = coords[i + 1];
            if (a && b && Number.isFinite(a[0]) && Number.isFinite(b[0])) {
                segs.push([a[0], a[1], b[0], b[1]]);
            }
        }
    }
    return segs;
}

function collectStops(src) {
    const out = [];
    for (const s of (src && src.allStops) || []) {
        const lon = Number(s.lng != null ? s.lng : s.lon);
        const lat = Number(s.lat);
        if (Number.isFinite(lon) && Number.isFinite(lat)) out.push({ lon, lat });
    }
    return out;
}

function pointInViewport(x, z, viewport) {
    return !viewport || (
        x >= viewport.minX
        && x <= viewport.maxX
        && z >= viewport.minZ
        && z <= viewport.maxZ
    );
}

function segmentTouchesViewport(segment, viewport) {
    if (!viewport) return true;
    return Math.max(segment[0], segment[2]) >= viewport.minX
        && Math.min(segment[0], segment[2]) <= viewport.maxX
        && Math.max(segment[1], segment[3]) >= viewport.minZ
        && Math.min(segment[1], segment[3]) <= viewport.maxZ;
}

function renderSessionBackground(currentSession, viewport = null) {
    if (!currentSession || typeof document === 'undefined') return null;
    const background = document.createElement('canvas');
    background.width = SIZE * DPR;
    background.height = SIZE * DPR;
    const backgroundCtx = background.getContext('2d');
    if (!backgroundCtx) return null;
    backgroundCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const map = navigationMapContext.snapshot();
    // The water mask and road graph are already published in this anchor's
    // metric frame. Cache their 2D drawing; the live player needs no 3D pass.
    backgroundCtx.fillStyle = '#15394b';
    backgroundCtx.strokeStyle = '#71a4ad';
    backgroundCtx.lineWidth = 1;
    for (const feature of map.water?.features || []) {
        backgroundCtx.beginPath();
        for (const ring of feature.rings || []) {
            for (let i = 0; i < ring.length; i++) {
                const point = currentSession.toScreen(ring[i][0], ring[i][1]);
                if (i === 0) backgroundCtx.moveTo(point.sx, point.sy);
                else backgroundCtx.lineTo(point.sx, point.sy);
            }
            backgroundCtx.closePath();
        }
        backgroundCtx.fill('evenodd');
        backgroundCtx.stroke();
    }
    backgroundCtx.strokeStyle = '#78858f';
    backgroundCtx.lineWidth = 2.2;
    backgroundCtx.lineCap = 'round';
    backgroundCtx.beginPath();
    for (const road of map.roads.values()) {
        if (!segmentTouchesViewport([road.x0, road.z0, road.x1, road.z1], viewport)) continue;
        const a = currentSession.toScreen(road.x0, road.z0);
        const b = currentSession.toScreen(road.x1, road.z1);
        backgroundCtx.moveTo(a.sx, a.sy);
        backgroundCtx.lineTo(b.sx, b.sy);
    }
    backgroundCtx.stroke();
    backgroundCtx.strokeStyle = '#f4b94f';
    backgroundCtx.lineWidth = 2;
    backgroundCtx.setLineDash([4, 3]);
    backgroundCtx.beginPath();
    const route = [...currentSession.waypoints, currentSession.navigationTarget].filter(Boolean);
    for (let i = 0; i < route.length; i++) {
        const point = currentSession.toScreen(route[i].x, route[i].z);
        if (i === 0) backgroundCtx.moveTo(point.sx, point.sy);
        else backgroundCtx.lineTo(point.sx, point.sy);
    }
    backgroundCtx.stroke();
    backgroundCtx.setLineDash([]);
    const nextWaypoint = currentSession.waypoints[currentSession.waypointIndex];
    if (nextWaypoint && pointInViewport(nextWaypoint.x, nextWaypoint.z, viewport)) {
        const point = currentSession.toScreen(nextWaypoint.x, nextWaypoint.z);
        backgroundCtx.fillStyle = '#f4b94f';
        backgroundCtx.beginPath();
        backgroundCtx.arc(point.sx, point.sy, 3.5, 0, Math.PI * 2);
        backgroundCtx.fill();
    }

    backgroundCtx.lineWidth = 2;
    backgroundCtx.lineCap = 'round';
    backgroundCtx.strokeStyle = 'rgba(90,170,255,0.92)';
    backgroundCtx.beginPath();
    for (const segment of currentSession.projSegs) {
        if (!segmentTouchesViewport(segment, viewport)) continue;
        const a = currentSession.toScreen(segment[0], segment[1]);
        const b = currentSession.toScreen(segment[2], segment[3]);
        backgroundCtx.moveTo(a.sx, a.sy);
        backgroundCtx.lineTo(b.sx, b.sy);
    }
    backgroundCtx.stroke();

    backgroundCtx.fillStyle = '#ffd24a';
    backgroundCtx.strokeStyle = 'rgba(0,0,0,0.55)';
    backgroundCtx.lineWidth = 1;
    for (const stop of currentSession.projStops) {
        if (!pointInViewport(stop.x, stop.z, viewport)) continue;
        const point = currentSession.toScreen(stop.x, stop.z);
        backgroundCtx.beginPath();
        backgroundCtx.arc(point.sx, point.sy, 2.6, 0, Math.PI * 2);
        backgroundCtx.fill();
        backgroundCtx.stroke();
    }

    if (currentSession.navigationTarget && pointInViewport(
        currentSession.navigationTarget.x,
        currentSession.navigationTarget.z,
        viewport,
    )) {
        const destination = currentSession.toScreen(
            currentSession.navigationTarget.x,
            currentSession.navigationTarget.z,
        );
        backgroundCtx.save();
        backgroundCtx.fillStyle = '#ff9d3c';
        backgroundCtx.strokeStyle = '#fff';
        backgroundCtx.lineWidth = 1.2;
        backgroundCtx.beginPath();
        backgroundCtx.arc(destination.sx, destination.sy, 4.2, 0, Math.PI * 2);
        backgroundCtx.fill();
        backgroundCtx.stroke();
        backgroundCtx.restore();
    }

    backgroundCtx.fillStyle = 'rgba(255,255,255,0.7)';
    backgroundCtx.font = '9px system-ui, sans-serif';
    backgroundCtx.textAlign = 'center';
    backgroundCtx.textBaseline = 'middle';
    backgroundCtx.fillText('N', SIZE - 11, 11);
    return background;
}

// Called once when a cab/walk ride opens. opts: { driverGraph, otherTracks,
// allStops, anchorLat, anchorLon }.
export function beginMinimapSession(opts) {
    ensureMinimap();
    placeToggle();
    if (!ctx) return;
    const anchorLat = Number(opts && opts.anchorLat);
    const anchorLon = Number(opts && opts.anchorLon);
    if (!Number.isFinite(anchorLat) || !Number.isFinite(anchorLon)) { destroyMinimap(); return; }

    const project = (lon, lat) => geoToLocal(lon, lat, anchorLon, anchorLat);
    const navigationLat = finiteOrNull(opts?.navigationTarget?.lat);
    const navigationLon = finiteOrNull(opts?.navigationTarget?.lon);
    const navigationDefinition = navigationLat != null
        && navigationLon != null
        ? {
            lat: navigationLat,
            lon: navigationLon,
            label: String(opts.navigationTarget.label || opts.navigationTarget.title || ''),
            title: String(opts.navigationTarget.title || opts.navigationTarget.label || ''),
        }
        : null;
    const rejoinRoute = opts?.navigationTarget?.rejoinRoute === true;
    const navigationTarget = navigationDefinition
        ? { ...navigationDefinition, ...project(navigationLon, navigationLat) }
        : null;
    const projectWaypoints = list => (list || [])
        .filter(point => Number.isFinite(point?.lat) && Number.isFinite(point?.lon))
        .map(point => ({ ...point, ...project(point.lon, point.lat) }));
    const drivingWaypoints = projectWaypoints(navigationWaypointsFor(opts?.navigationTarget, { driving: true }));
    const walkWaypoints = projectWaypoints(navigationWaypointsFor(opts?.navigationTarget, { driving: false }));
    const waypoints = opts?.walkMode ? walkWaypoints : drivingWaypoints;
    const navigationKey = JSON.stringify([navigationTarget, drivingWaypoints, walkWaypoints, rejoinRoute]);
    const waypointIndex = session?.navigationKey === navigationKey ? session.waypointIndex : 0;
    // Range limit: the network feed can span the whole country (a Split walk
    // received Zagreb's tram web, and the bounds fit shrank the local route
    // to a dot). Only geometry near THIS session's anchor belongs on a local
    // minimap.
    const RANGE_M = 25000;
    const inRange = (x, z) => Math.hypot(x, z) <= RANGE_M;
    const projSegs = collectSegments(opts).map(([lo1, la1, lo2, la2]) => {
        const a = project(lo1, la1);
        const b = project(lo2, la2);
        return [a.x, a.z, b.x, b.z];
    }).filter((seg) => inRange(seg[0], seg[1]) || inRange(seg[2], seg[3]));
    const projStops = collectStops(opts).map((s) => {
        const p = project(s.lon, s.lat);
        return { x: p.x, z: p.z };
    }).filter((s) => inRange(s.x, s.z));

    let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
    const acc = (x, z) => {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    };
    for (const s of projSegs) { acc(s[0], s[1]); acc(s[2], s[3]); }
    for (const s of projStops) acc(s.x, s.z);
    for (const point of waypoints) acc(point.x, point.z);
    if (opts?.walkMode) acc(0, 0);
    if (navigationTarget) {
        // A campaign drive can reuse a rail-built world with no local road
        // graph in the minimap. The player origin and destination still form
        // a useful, stable map instead of leaving the HUD blank.
        acc(0, 0);
        acc(navigationTarget.x, navigationTarget.z);
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minZ)) { destroyMinimap(); return; }

    // Aspect-preserving square fit. z grows southward, so mapping z→screen-Y
    // directly puts north (min z) at the top — a north-up map.
    const spanX = Math.max(1, maxX - minX);
    const spanZ = Math.max(1, maxZ - minZ);
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const routeTransform = minimapViewportTransform({
        centerX: cx,
        centerZ: cz,
        halfSpanM: Math.max(spanX, spanZ) / 2,
        size: SIZE,
        padding: PAD,
    });
    const toScreen = (x, z) => minimapPointToScreen(routeTransform, x, z);

    // Free roam falls back to the city centre so the player always has a
    // bearing. A campaign scene must not: its objective is the only thing
    // worth pointing at, and where a scene has no target — waiting for a
    // contact to open a panel — an arrow to Trg bana Jelačića 480 m away is
    // not a spare bearing, it is a wrong instruction.
    const campaignActive = opts?.campaignActive === true;
    if (!collapseChosenByPlayer) {
        collapsed = campaignActive;
        applyCollapsedState();
    }
    const guideDefinition = navigationDefinition || (campaignActive ? null : ZAGREB_CITY_CENTRE);
    const centreTarget = guideDefinition ? project(guideDefinition.lon, guideDefinition.lat) : null;
    // The simulator can run in other Croatian cities. A far-away Zagreb target
    // would be misleading there, so only enable this local guide for sessions
    // whose anchor is within the wider Zagreb area.
    const localCentreTarget = centreTarget && Math.hypot(centreTarget.x, centreTarget.z) <= 50000
        ? { ...centreTarget, label: guideDefinition.label, title: guideDefinition.title }
        : null;

    session = {
        anchorLat,
        anchorLon,
        projSegs,
        projStops,
        toScreen,
        routeTransform,
        guideTarget: localCentreTarget,
        navigationTarget,
        waypoints, waypointIndex, navigationKey,
        drivingWaypoints, walkWaypoints,
        rejoinRoute,
        previousPlayer: null,
        contextRevision: navigationMapContext.snapshot().revision,
        nextContextRefreshMs: 0,
        viewport: null,
        backgroundDirty: false,
        walkFollowing: false,
        walkCenterX: null,
        walkCenterZ: null,
    };
    if (centreGuideEl && localCentreTarget) {
        centreGuideEl.title = localCentreTarget.title;
        centreGuideEl.setAttribute('aria-label', localCentreTarget.title);
    }
    lastGuideUpdateMs = -Infinity;
    lastGuideRotation = null;
    lastGuideText = '';
    lastGuideTopPx = null;
    session.routeBackground = renderSessionBackground(session);
    session.background = session.routeBackground;
    showMinimap();
}

// Called each ride frame with the current pose ({ lat, lon, headingDeg }) and
// the actual visible camera heading (which can differ due to mouse look).
export function updateMinimap(pose, viewHeadingDeg = pose?.headingDeg) {
    if (!session || !wrapEl || wrapEl.style.display === 'none') return;

    const lon = Number(pose && pose.lon);
    const lat = Number(pose && pose.lat);
    const playerLocal = Number.isFinite(lon) && Number.isFinite(lat)
        ? geoToLocal(lon, lat, session.anchorLon, session.anchorLat)
        : null;

    // On foot the pedestrian cue line applies (when the objective has one) and
    // a walker cutting across a square is still on route 45 m off the line.
    const onFoot = pose?.status?.walkMode === true
        || (pose?.status?.gtaMode === true && pose?.status?.driving !== true);
    const desiredWaypoints = onFoot ? session.walkWaypoints : session.drivingWaypoints;
    if (desiredWaypoints && desiredWaypoints !== session.waypoints) {
        session.waypoints = desiredWaypoints;
        session.waypointIndex = 0;
        session.previousPlayer = null;
        session.backgroundDirty = true;
    }
    if (playerLocal && session.waypoints.length) {
        const atDestination = session.navigationTarget
            && Math.hypot(session.navigationTarget.x - playerLocal.x, session.navigationTarget.z - playerLocal.z) <= 3;
        const reachedIndex = skipRecedingWaypoint(
            session.waypoints,
            advanceNavigationWaypoint(session.waypoints, session.waypointIndex, playerLocal, session.previousPlayer),
            playerLocal,
            session.previousPlayer,
        );
        const index = atDestination ? session.waypoints.length
            : session.rejoinRoute
                ? rejoinNavigationRoute(session.waypoints, session.navigationTarget, reachedIndex, playerLocal, onFoot ? 45 : 12)
                : reachedIndex;
        if (index !== session.waypointIndex) session.backgroundDirty = true;
        session.waypointIndex = index;
        session.guideTarget = session.waypoints[index] || session.navigationTarget;
        session.previousPlayer = playerLocal;
    }
    if (centreGuideEl && centreArrowEl && centreTextEl && session.guideTarget && playerLocal) {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (now - lastGuideUpdateMs >= GUIDE_UPDATE_INTERVAL_MS) {
            lastGuideUpdateMs = now;
            // A hosted chip sits in its line's flow, so it neither needs the
            // route measurement nor may be moved by it.
            if (!guideHostEl) {
                const routeOverlay = containerEl?.querySelector(
                    '.station-3d-route-overlay:not(.hidden)',
                );
                const routeTopPx = Number(routeOverlay?.offsetTop);
                const routeHeightPx = Number(routeOverlay?.offsetHeight);
                const guideTopPx = cityCentreGuideTopPx({
                    walkMode: !!pose?.status?.walkMode,
                    routeVisible: !!routeOverlay && Number.isFinite(routeHeightPx) && routeHeightPx > 0,
                    routeTopPx: Number.isFinite(routeTopPx) && routeTopPx > 0
                        ? routeTopPx
                        : 14,
                    routeHeightPx: Number.isFinite(routeHeightPx) && routeHeightPx > 0
                        ? routeHeightPx
                        : 40,
                });
                if (guideTopPx !== lastGuideTopPx) {
                    centreGuideEl.style.top = `${guideTopPx}px`;
                    lastGuideTopPx = guideTopPx;
                }
            }
            const guide = cityCentreGuidance({
                x: playerLocal.x,
                z: playerLocal.z,
                headingDeg: Number(viewHeadingDeg) || 0,
                targetX: session.guideTarget.x,
                targetZ: session.guideTarget.z,
            });
            const rotation = Math.round(guide.relativeBearingDeg);
            const distance = formatGuidanceDistance(guide.distanceM);
            const text = guideHostEl ? distance : `${session.guideTarget.label} · ${distance}`;
            if (rotation !== lastGuideRotation) {
                centreArrowEl.style.transform = `rotate(${rotation}deg)`;
                lastGuideRotation = rotation;
            }
            if (text !== lastGuideText) {
                centreTextEl.textContent = text;
                lastGuideText = text;
            }
        }
    }

    if (!ctx || !panelEl || collapsed || !playerLocal) return;
    const walking = pose?.status?.walkMode === true || pose?.status?.gtaMode === true;
    const nearBoatDestination = pose?.status?.vehicleKind === 'boat'
        && Number(pose.status.speedKmh) < 7.2 && session.navigationTarget
        && Math.hypot(playerLocal.x - session.navigationTarget.x, playerLocal.z - session.navigationTarget.z) < 50;
    const { halfSpanM, recenterM } = minimapFollowSpan({
        vehicleKind: pose?.status?.vehicleKind || null,
        vehicleExitTarget: !!pose?.status?.vehicleExitTarget,
        nearBoatDestination: !!nearBoatDestination,
    });
    if (walking && (
        !session.walkFollowing || session.walkHalfSpanM !== halfSpanM
        || minimapViewportNeedsRecenter({
            centerX: session.walkCenterX,
            centerZ: session.walkCenterZ,
            playerX: playerLocal.x,
            playerZ: playerLocal.z,
            thresholdM: recenterM,
        })
    )) {
        session.walkFollowing = true;
        session.walkCenterX = playerLocal.x;
        session.walkCenterZ = playerLocal.z;
        session.walkHalfSpanM = halfSpanM;
        const walkTransform = minimapViewportTransform({
            centerX: playerLocal.x,
            centerZ: playerLocal.z,
            halfSpanM,
            size: SIZE,
            padding: PAD,
        });
        session.toScreen = (x, z) => minimapPointToScreen(walkTransform, x, z);
        session.viewport = {
            minX: playerLocal.x - halfSpanM,
            maxX: playerLocal.x + halfSpanM,
            minZ: playerLocal.z - halfSpanM,
            maxZ: playerLocal.z + halfSpanM,
        };
        session.backgroundDirty = true;
    } else if (!walking && session.walkFollowing) {
        session.walkFollowing = false;
        session.walkCenterX = null;
        session.walkCenterZ = null;
        session.toScreen = (x, z) => minimapPointToScreen(session.routeTransform, x, z);
        session.viewport = null;
        session.backgroundDirty = true;
    }
    const nowMs = performance.now();
    const contextRevision = navigationMapContext.snapshot().revision;
    if (session.backgroundDirty || (contextRevision !== session.contextRevision && nowMs >= session.nextContextRefreshMs)) {
        session.background = renderSessionBackground(session, session.viewport);
        session.contextRevision = contextRevision;
        session.nextContextRefreshMs = nowMs + CONTEXT_REFRESH_MS;
        session.backgroundDirty = false;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    if (session.background) ctx.drawImage(session.background, 0, 0);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    const exitTarget = pose?.status?.vehicleExitTarget;
    if (Number.isFinite(exitTarget?.lat) && Number.isFinite(exitTarget?.lon)) {
        const landing = geoToLocal(exitTarget.lon, exitTarget.lat, session.anchorLon, session.anchorLat);
        const point = session.toScreen(landing.x, landing.z);
        ctx.strokeStyle = '#65f0b4';
        ctx.fillStyle = '#65f0b4';
        ctx.lineWidth = 2;
        ctx.beginPath();
        const player = session.toScreen(playerLocal.x, playerLocal.z);
        ctx.moveTo(player.sx, player.sy);
        ctx.lineTo(point.sx, point.sy);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(point.sx, point.sy, 4, 0, Math.PI * 2);
        ctx.fill();
    }

    // Player marker — a triangle pointing along the heading (0°=N, north-up map,
    // so heading 0 points straight up). Outside the fixed route extent, clamp
    // it to the map edge and point toward the player's actual off-map position.
    const rawPoint = session.toScreen(playerLocal.x, playerLocal.z);
    const marker = minimapMarkerPlacement({
        ...rawPoint,
        headingDeg: Number(pose && pose.headingDeg) || 0,
        size: SIZE,
        padding: PAD,
    });
    ctx.save();
    ctx.translate(marker.sx, marker.sy);
    ctx.rotate(marker.rotationDeg * Math.PI / 180);
    ctx.fillStyle = marker.offMap ? '#ff9d3c' : '#ff5a3c';
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -6.5);
    ctx.lineTo(4.5, 5.5);
    ctx.lineTo(-4.5, 5.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

}

export function showMinimap() {
    ensureMinimap();
    if (wrapEl) wrapEl.style.display = 'flex';
    if (toggleBtn) toggleBtn.style.display = 'inline-flex';
    guideVisible = !!session?.guideTarget;
    applyGuideVisibility();
    setSoundToggleVisible(true);
    applyCollapsedState();
}

export function hideMinimap() {
    if (wrapEl) wrapEl.style.display = 'none';
    if (toggleBtn) toggleBtn.style.display = 'none';
    guideVisible = false;
    applyGuideVisibility();
    setSoundToggleVisible(false);
    announceMinimapLayout();
}

export function destroyMinimap() {
    session = null;
    lastGuideTopPx = null;
    placeToggle();
    hideMinimap();
}
