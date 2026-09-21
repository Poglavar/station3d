// Shared runtime state. Only two things live here:
//   - mode:     'static' (station ring view) or 'cab' (first-person / walk view)
//   - cabState: per-ride state while a cab session is open (null otherwise)
//
// cabState holds ONLY the cross-cutting per-ride fields (pose sourcing,
// anchor, fetch controller, driver/walk submode, handoff callbacks).
// Each world / vehicle layer owns its own session state privately and wires
// itself via the {beginSession, onFrame, endSession} protocol in modes/cab.js.

export const state = {
    mode: 'static',
    cabState: null,
};

export function setMode(next) {
    state.mode = next;
}

export function setCabState(next) {
    state.cabState = next;
}

export function createCabState(initialPose, options) {
    return {
        // Pose sourcing (autopilot / driver / walk pick one).
        poseFn: null,                               // ({ paused }) => { lat, lon, headingDeg, status? }
        lastAutoPose: null,
        lastRenderedPose: null,
        smoothedHeading: null,                      // radians, EMA-smoothed
        lastFrameMs: 0,

        // User-controlled screenshot pause. Rendering and camera input keep
        // running; cab.js supplies dt=0 to simulation systems and freezes the
        // shared schedule clock until P is pressed again.
        simPaused: false,
        simPauseStartedMs: 0,
        simPausedPose: null,
        clockWasPausedBeforeCabPause: false,

        // Scene anchor — local (0,0,0) corresponds to this lat/lon.
        anchorLat: initialPose.lat,
        anchorLon: initialPose.lon,
        trackBaseY: Number.isFinite(options && options.trackBaseY) ? options.trackBaseY : 0,
        terrain: null,                              // shared TerrainReference when ?terrain is active
        roadFormation: null,                        // engineered road grade/cross-section model
        roadVerticalAlignments: null,                // bridge/tunnel structure ownership + profiles
        railFormation: null,                        // engineered rail vertical alignment/cross-section
        renderCompiler: null,                       // one module Worker client shared by packet layers
        terrainRenderCompiler: null,                // optional second moving-terrain compiler Worker
        unregisterRenderCompilerActivity: null,
        allStops: (options && options.allStops) || [],
        routeDirectionLabel: String(options && options.routeDirectionLabel || ''),
        railMode: String(options && options.railMode || '').trim().toLowerCase(),
        trackGaugeMm: Number.isFinite(Number(options && options.trackGaugeMm))
            ? Number(options.trackGaugeMm)
            : null,

        // Shared fetch controller aborted when the session ends.
        fetchController: new AbortController(),

        // Driver submode (optional override for pose source).
        driverGraph: null,
        driver: null,
        switchRules: (options && options.switchRules) || null,
        driverUnavailableMessage: (options && options.driverUnavailableMessage) || '',
        driverUnavailableKey: (options && options.driverUnavailableKey) || '',

        // Walk submode (alternative pose source).
        walkMode: (options && options.walkMode) || null,
        walkCameraMode: 'first',
        playerWalkerAvatar: null,
        walkerElapsedSeconds: 0,
        sessionPresetId: String(options && options.sessionPresetId || ''),
        sessionCapabilities: (options && options.sessionCapabilities) || Object.freeze({}),
        terrainPolicy: null,
        gtaSession: null,
        occupant: null,
        controllerRouter: null,
        controllerFrame: null,
        ambientTramClaim: null,
        campaignRailClaim: null,
        campaignRailVehicleId: null,
        campaignRailDisembarkEnabled: false,
        parkedCampaignTrainMesh: null,
        playerTramMeshBorrowed: false,
        // A campaign scene may reopen around a named vehicle that the player
        // was already controlling in the previous scene. The GTA frame loop
        // claims it once its authored spawn and physics provider are ready.
        initialVehicleId: String(options && options.initialVehicleId || '').trim(),
        initialVehicleClaimPending: !!String(options && options.initialVehicleId || '').trim(),

        // Cab/game presentation. Campaign encounters can opt into the existing
        // combat presentation without owning a parallel quest state machine.
        gameMode: 'simulation',
        cameraMode: 'front',
        playerService: null,
        walkLaunchOptions: null,

        // Optional declarative campaign scene context. The generic campaign
        // director owns story state; cab mode only exposes live session hooks.
        campaignScene: (options && options.campaignScene) || null,
        campaignDefinition: (options && options.campaignDefinition) || null,
        campaignWorldEffects: (options && options.campaignWorldEffects) || {},
        campaignWorldPack: (options && options.campaignWorldPack) || null,
        navigationTarget: (options && options.navigationTarget) || null,
        campaignFrameHandler: null,
        campaignRailDerail: null,
        onCampaignInteract: (options && options.onCampaignInteract) || null,
        onCampaignSessionReady: (options && options.onCampaignSessionReady) || null,
        // Authored driving chapters can preload and retain a complete surface
        // corridor behind the opaque world-loading curtain. This is separate
        // from the moving velocity-shaped streaming focus used in free roam.
        driveSurfacePreload: null,
        driveSurfacePreloadStatus: null,
        driveSurfacePreloadReadySinceMs: null,
        driveSurfacePreloadSettled: false,

        // Control-transfer hooks fired when the player enters/leaves driver mode.
        onTakeControl:    (options && options.onTakeControl)    || null,
        onReleaseControl: (options && options.onReleaseControl) || null,
        onClose:          (options && options.onClose)          || null,
    };
}
