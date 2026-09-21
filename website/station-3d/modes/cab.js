import { resolveActorSupportY } from '../core/actor-support.js';
import { collectVisibleRayHits } from '../core/visible-raycast.js';
import { jetpackShopLayer, getNearbyJetpackShop } from '../world/jetpack-shop.js';
import { readFreeRoamProgress, purchaseJetpack, reduceJetpackShop } from '../core/free-roam-progress.js';
import { showWorldChoices, closeWorldChoices, worldChoicesOpen } from '../ui/world-interaction.js';
import { nearestLiftLanding } from '../world/lifts.js';
import { setTrafficSessionCapabilities } from '../world/cars.js';
import { setDecorSessionCapabilities, getDecorReadinessSnapshot } from '../world/decor.js';
// Cab-mode orchestrator. Owns the cabState lifecycle, the per-frame update
// that drives camera + pose sourcing, and the keyboard handlers that toggle
// driver / walk / throttle / armed turn.
//
// Layers (buildings, roads, rails, platforms, decor, other trams) are wired
// via the uniform {beginSession, onFrame, endSession} protocol. Adding a new
// layer is a two-line change: import + push onto the `layers` array.
//
// Pose sources: driver physics (modes/driver.js), walk physics (modes/walk.js),
// or the autopilot poseFn supplied by tram-sim.js / railway-sim.js.

import * as THREE from 'three';
import { evidencePlacementBaseSceneY } from '../core/terrain-placement.js';
import {
    DEG_TO_RAD, EARTH_RADIUS_M, finiteOrNull, lerpAngle, geoToLocal, localToGeo,
    haversineMeters,
} from '../core/math.js';
import { CivilGroundComposition } from '../core/civil-ground-composition.js';
import { SURFACE_CLASS, SURFACE_COVERAGE_STATE, SURFACE_VERTICAL_RELATION } from '../core/surface-hierarchy.js';
import { createFlightCameraResolver } from '../core/flight.js';
import {
    createPhotoTrackFrame,
    resolvePhotoHandoffState,
    resolvePhotoVehiclePose,
} from '../core/photo-track-frame.js';
import {
    scene, camera, renderer, groundMesh, ringMesh, northArrowMesh, stationMarker, sun, fill, ambient,
    getResizeHandler, SIDEWALK_UV_PER_M, getRenderQualityContext,
} from '../scene/setup.js';
import {
    isPerformanceProfilingActive,
    onBeforeRender,
    onAfterRender,
    recordLayerFrameMs,
} from '../scene/animate.js';
import {
    resetTerrainInspection,
    toggleTerrainInspection,
} from '../scene/terrain-inspection.js';
import { startupTrace } from '../core/startup-trace.js';
import {
    noteFrameChunkObserver,
    resetFrameChunkObserver,
    setFrameChunkSchedulerThroughput,
    resetFrameChunkSessionStatistics,
} from '../core/frame-chunk-queue.js';
import {
    getBackgroundActivitySnapshot,
    registerBackgroundActivityReader,
} from '../core/background-activity.js';
import { waitForCampaignPackSettlement } from '../core/campaign-pack-settlement.js';
import { createSurfacePublicationRegistry } from '../core/surface-publication-registry.js';
import { createGroundPublicationBoundary } from '../core/ground-publication-boundary.js';
import { createRenderCompilerClient } from '../core/render-compiler-client.js';
import { applySurfacePublicationDrawContracts } from '../world/surface-material-authority.js';
import {
    campaignWorldPackBuildingColliderSpecsNear,
    campaignWorldPackBuildingFootprintsNear,
    campaignWorldPackLayer,
    campaignWorldPackSpawnYAtLocal,
    campaignWorldPackSupportYAtLocal,
    campaignWorldPackRailSurfaceAtLocal,
} from '../world/campaign-world-pack.js';
import { shouldHideCatchAllGround } from '../core/session-ground-visibility.js';
import {
    horizontalFovDeg,
    resolveCameraViewHeadingDeg,
} from '../core/view-priority.js';
import { createLayerStartupCoordinator } from '../core/layer-startup.js';
import {
    applyRenderOriginForRender,
    getRenderOrigin,
    resetSceneRenderOrigin,
    restoreAbsoluteRenderCoordinates,
    resolveRenderOriginRebase,
    setSceneRenderOrigin,
} from '../core/render-origin.js';
import {
    nextWalkCameraMode,
    thirdPersonWalkCameraPose,
    walkCameraModeAfterVehicleExit,
    walkerAvatarVisible,
} from '../core/walk-camera.js';
import { filmEngineAudioSegment, filmEngineMix } from '../core/film-engine-audio.js';
import { setAircraftEngineFilmMix } from '../ui/gta-special-vehicle-audio.js';
import { buildPositionShareUrl } from '../core/position-share.js';
import { getSessionHost } from '../core/session-host.js';
import { worldProviderContains } from '../core/api.js';
import { captureCampaignPackScene } from '../core/campaign-pack-capture-three.js';
import { isSolvedRailFeature } from '../core/rail-profile-source.js';
import { encodeCampaignPackArchiveBlob } from '../core/campaign-pack-archive.js';
import { shouldHandleVehicleResetKeyDown } from '../core/gta-config.js';
import {
    routedVehicleSurfaceStreamingFocus,
    vehicleSurfaceGenerationCenter,
    vehicleSurfaceStreamingFocus,
} from '../core/vehicle-surface-streaming.js';
import {
    campaignDrivePreloadReadiness,
    resolveCampaignDrivePreload,
} from '../core/campaign-drive-preload.js';
import {
    campaignPackBakeSegmentPlan,
    campaignPackSegmentOwnsChunkKey,
} from '../core/campaign-pack-segments.js';
import { DETAILED_BUILDING_TILE_M } from '../core/tile-stream.js';
import { campaignPackReplacesLayer } from '../core/campaign-pack-layer-policy.js';
import { campaignRoomElevationOffsetM, resolveCampaignRoom } from '../core/campaign-room.js';
import { includeSurfaceLayerInElevationMode } from '../core/session-layer-policy.js';
import { isElevationMode, shouldStartCabPaused } from '../core/session-flags.js';
import { resolveTerrainSessionPolicy } from '../core/terrain-request.js';
import { initialGroundSupportReady } from '../core/initial-world-support.js';
import {
    enabledVehicleControllerKinds,
    hasEnterableVehicleCapability,
    resolveFreeRoamPreset,
    SESSION_CAPABILITY,
    sessionCapabilityEnabled,
} from '../core/session-capabilities.js';
import { findEnclosingSpan, shouldSuspendOutsideWorld } from '../core/tunnel-occlusion.js';
import { applyAnchorStyle, getLocation } from '../core/locations.js';
import { beginCoverageProbe } from '../core/coverage-probe.js';
import { ensureCoverageNotice } from '../ui/coverage-notice.js';
import {
    beginWorldBuild,
    canReleaseWorldBuildRequirement,
    forceWorldReady,
    getWorldLoadComponents,
    getWorldLoadDurations,
    getWorldLoadTelemetry,
    isWorldBuilding,
    noteWorldBuildProgress,
    noteWorldBuildRequirementActive,
    noteWorldBuildRequirementIdle,
    noteWorldPhase,
    noteWorldQueueActive,
    noteWorldQueueIdle,
    noteWorldQueueProgress,
    noteWorldTransferBytes,
    onWorldReady,
    setWorldBuildOptionalQueues,
    tickWorldReady,
} from '../core/world-ready.js';
import {
    getSunDirection,
    isSceneNight,
    isSceneClockRealTime,
    setSceneTimeOfDayOverride,
    toggleNightLights,
} from '../scene/sky.js';
import { updateWalkerLamp, disposeWalkerLamp } from '../scene/walker-lamp.js';
import { updateRailHeadlight, disposeRailHeadlight } from '../scene/rail-headlight.js';
import { createSharedTileSession, onTileStreamHealth } from '../core/shared-tile-session.js';
import {
    updateCameraLook, getCameraLook, resetCameraLook,
    setCameraLookDirectAim, setCameraLookInstant,
} from '../scene/camera-look.js';
import { state, setMode, setCabState, createCabState } from '../state.js';
import { CAMPAIGN_READY_CAP_MS } from '../core/campaign-ready-watchdog.js';
import { createControllerRouter } from '../core/controller-router.js';
import { sessionPoseReadyForPublication } from '../core/session-pose-readiness.js';
import {
    authoredAbsoluteRailGrade,
    authoredAbsoluteRailSceneY,
    composeRailVehicleSceneY,
} from '../core/rail-vehicle-elevation.js';
import { aircraftInstruments } from '../core/aircraft-readout.js';
import { controlsHintAvailableFor, controlsHintKeyFor, vehicleInteractionKeyForSession } from '../core/controls-hint.js';
import {
    campaignRailDoorState,
    campaignRailHandoffReady,
    shouldRouteRailDoorInteraction,
} from '../core/campaign-rail-handoff.js';
import {
    CAMPAIGN_RAIL_DERAIL_DURATION_MS,
    campaignRailDerailFrame,
} from '../core/campaign-rail-derail.js';
import { campaignPresentationDeltaSeconds } from '../core/campaign-speaking.js';
import { campaignDialogueGroundY } from '../core/campaign-dialogue-staging.js';
import { resolveCampaignWalkRelocation } from '../core/campaign-world-reuse.js';
import {
    cancelOccupantTransition,
    completeBoarding,
    completeExit,
    createOccupantState,
    forceOccupantOnFoot,
    OCCUPANT_STATES,
    requestBoarding,
} from '../core/occupant.js';
import {
    SESSION_ACTIONS,
    semanticActionForKey,
} from '../core/semantic-actions.js';
import { selectNearestVehicleProvider } from '../core/vehicle-provider.js';
import {
    renderCabTitle, showModal, clearInfo,
    setRideShareUrl, setRideShareUrlProvider, setLineBadgeLongPressHandler,
    setCampaignButtonHandler, setCampaignButtonVisible, setCampaignButtonEnabled,
    setWalkModeButtonHandler, setWalkModeButtonVisible, setWalkModeButtonEnabled,
    setControlsHintHandler, setControlsHintButtonVisible,
    setWeaponToggleButtonHandler, setWeaponToggleButtonVisible, setWeaponToggleButtonEnabled, setWeaponToggleButtonArmed,
    setAutopilotButtonHandler, modalEl } from '../ui/modal.js';
import {
    ensureHud, renderStatusOverlay, renderDriverHud, hideDriverHud,
    updateKillCounter, hideKillCounter,
    updateAmmoCounter, hideAmmoCounter,
    updateTramHealthBar, hideTramHealthBar,
    showCabToast, hideCabToast, resetBellMemory,
    setFireButtonHandlers, showFireButton, hideFireButton,
    setViewButtonHandler, setViewButtonPlacement, showViewButton, hideViewButton,
    setViewIndicator, hideViewIndicator,
} from '../ui/hud.js';
import {
    startEngineWhine, updateEngineWhine, stopEngineWhine,
} from '../ui/engine-whine.js';
import {
    startWalkAudio, stopWalkAudio, updateFootsteps, updateJetpack,
    playLandingImpact,
} from '../ui/walk-audio.js';
import {
    startTrackClangs, updateTrackClangs, stopTrackClangs,
} from '../ui/track-clangs.js';
import {
    startTramSounds, stopTramSounds, updateTramSounds, playTramBell,
    playDoorOpen, playDoorClose,
} from '../ui/tram-sounds.js';
import { preloadCabVoice, stopCabVoice } from '../ui/cab-voice.js';
import { preloadHonkSfx } from '../ui/honk-sfx.js';
import { preloadSirens } from '../ui/siren-sfx.js';
import { preloadStationPa, updateStationPa, stopStationPa, bindAudioUnlock } from '../ui/station-pa.js';
import { preloadStationCrowd, updateStationCrowd, stopStationCrowd, bindStationCrowdUnlock } from '../ui/station-crowd.js';
import { ensureSoundPrompt, hideSoundPrompt } from '../ui/sound-prompt.js';
import { ensureNightNotice, hideNightNotice } from '../ui/night-notice.js';
import {
    bindEnemyMusicUnlock, resetEnemyMusicFrame, tickEnemyMusic, stopEnemyMusic,
} from '../ui/enemy-music.js';
import { ensureDriverControls, updateDriverControls } from '../ui/driver-controls.js';
import {
    ensureWalkControls,
    hideWalkControls,
    setGtaInteractionAvailable,
    setWalkControlPressed,
    setWalkControlsMode,
    setWalkJetpackAvailable,
    showWalkControls,
} from '../ui/walk-controls.js';
import { getLang, t } from '../core/i18n.js';
import { campaignSceneLoadingHeading } from '../core/campaign-feature.js';
import { campaignBakeStatus } from '../core/campaign-bake-status.js';
import {
    AUTOMATIC_DOOR_CLOSE_LEAD_SECONDS,
    shouldAutomaticDoorsRemainOpen,
} from '../core/station-departure.js';
import {
    buildingsLayer,
    getBuildingFootprintsNear,
    getBuildingsGroup,
    isPointInsideBuildingPassageVolume,
} from '../world/buildings.js';
import { resolveWalkAgainstBuildingWalls } from '../core/walk-building-collision.js';
import { findPlatformDeckLanding, platformLandingPoint } from '../core/campaign-rail-disembark.js';
import { resolvePrimaryPlatformExtent } from '../core/platform-extents.js';
import { buildFormationTerrainCutoutQuery } from '../core/formation-terrain-cutout-query.js';
import { isDetailedTileAtLocal } from '../world/building-lod-registry.js';
import { farBuildingsLayer, farBuildingShadowOwnership } from '../world/buildings-far.js';
import { createFarBuildingBakeShadow } from '../world/buildings-bake-shadow.js';
import { attachInspector, resetInspector } from '../debug/inspect.js';
import { installSurfaceAudit } from '../debug/surface-audit.js';
import { installShoreAudit } from '../debug/shore-audit.js';
import { auditTilePoints } from '../core/surface-audit-readiness.js';
import { attachStreetViewLink } from '../world/streetview-link.js';
import { courtyardPassagesLayer } from '../world/courtyard-passages.js';
import {
    proposalsLayer,
    cycleProposalBuildingDisplay,
    getProposalsBuildingsGroup,
    getProposalsWalkableGroup,
    isPointInProposalLake,
    markTrackDemolitionPassed,
} from '../world/proposals.js';
import { beginMinimapSession, updateMinimap, hideMinimap } from '../ui/minimap.js';
import {
    getRenderedRoadSurfacePartsNear,
    getRenderedRoadSurfaceRevision,
    isRenderedRoadTilePublishedAtLocal,
    pedestrianZoneAtLocal,
    renderedRoadSurfaceSupportYAtLocal,
    roadsLayer,
} from '../world/roads.js';
import {
    getRoadGradeSeparationsGroup,
    roadGradeSeparationsLayer,
} from '../world/road-grade-separations.js';
import { streetLampsLayer } from '../world/streetlamps.js';
import { curbsLayer, getCurbsGroupForWalkSupport, getCurbAuditReadiness } from '../world/curbs.js';
import { createWorldGroundGenerations } from '../world/ground-generations.js';
import { laneMarkingsLayer } from '../world/lane-markings.js';
import {
    getRailsGroupForWalkColliders,
    getEnclosedRailTunnelSpans,
    getActiveRailTrafficSource,
    isRailSurfacePreloadSettled,
    tramTrackbedSupportYAtLocal,
    railsLayer,
} from '../world/rails.js';
import { electrificationLayer } from '../world/electrification.js';
import { levelCrossingsLayer } from '../world/level-crossings.js';
import { streetNamesLayer, setStreetNamesPresentationHidden } from '../world/street-names.js';
import { rebaseSessionRestorePoint } from '../core/session-restore.js';
import {
    plannerElevationLayer,
    getPlannerElevationGroup,
    getEnclosedTunnelSpans,
    getPlannerSubsurfaceWalkFloorY,
    isPointInsidePlannerSurfaceCutout,
} from '../world/planner-elevation.js';
import { ambientTrainsLayer } from '../world/ambient-trains.js';
import {
    campaignRailVehiclePose,
    campaignRailVehiclesLayer,
    claimCampaignRailVehicle,
} from '../world/campaign-rail-vehicles.js';
import { ambientBirdsLayer } from '../world/ambient-birds.js';
import {
    platformsLayer,
    getPlatformWaitingPeople,
    getPlatformsGroup,
    setPlatformWaitingPeopleVisible,
} from '../world/platforms.js';
import { flagsLayer } from '../world/flags.js';
import { decorLayer, isPointInDecorWater } from '../world/decor.js';
import { aerialViewLayer, getAerialViewFog } from '../world/aerial-view.js';
import { fishJumpsLayer } from '../world/fish-jumps.js';
import { inspectGroundSurfaceMaterialAtLocal } from '../world/urban-ground-surface.js';
import {
    getWaterGroupForWalkColliders,
    isPointInMappedSea,
    mappedCoastCollarQuadsNear,
    mappedSeaSurfaceSceneY,
    urbanCoastFormationSupportYAtLocal,
    waterLayer,
} from '../world/water.js';
import {
    gtaSpecialVehicleProvider,
    gtaSpecialVehiclesLayer,
} from '../world/gta-special-vehicles.js';
import { sourceEntitiesLayer } from '../world/source-entities.js';
import { photorealLayer, getPhotorealGroundGroup, getPhotorealWallsGroup, isPhotorealGhostGround, getPhotorealAltitudeOffset, getPhotorealRegistration, isPhotoWorld, isPhotorealRevealed, isPhotorealUnavailable, getPhotorealLoadProgress, getPhotorealLoadTelemetry, photorealCorridorDeckY } from '../world/photoreal.js';
import {
    groundOwnershipMaskDiagnostics,
    isTerrainTilePublishedAtLocal,
    isTerrainRequested,
    terrainLayer,
} from '../world/terrain.js';
import { beginGroundCover, groundCoverFrame } from '../world/ground-cover.js';
import { createWorldGroundPaint } from '../world/ground-paint.js';
import { machineGunNestsLayer } from '../world/machine-gun-nests.js';
import {
    addAmmo,
    attachWeapon,
    detachWeapon,
    getAmmo,
    isWeaponAttached,
    isWeaponMounted,
    preloadWeaponRuntime,
    resetAmmo,
    setWeaponFiring,
    setWeaponMount,
    setWeaponVisible,
    tickWeapon,
} from '../core/weapon-runtime.js';
import { ambientHostilesEnabled } from '../core/hostility-scope.js';
import { weaponToggleEnabled, weaponToggleIntent } from '../core/campaign-sidearm.js';
import { undergroundLayer, getUndergroundGroup } from '../world/underground.js';
import {
    resolveWalkMove,
    resolveWalkCameraLineOfSight,
    resetWalkColliders,
    setWalkColliderSource,
} from '../world/walk-collision.js';
import {
    carsLayer, waitForTrafficRoadsNear, ensureAuthoredParkedCars, getTrafficObstaclesNear, resetAuthoredParkedCars,
    getEnemyEncounterSnapshot, restoreEnemyEncounterSnapshot,
    getWreckedCarCount, spawnEnemyWaveNear,
    beginEncounterPursuit, endEncounterPursuit,
    spawnSmokeAt, spawnFireFlashAt, getTrafficWorldDebugState,
    stopCampaignEnemyEncounter,
} from '../world/cars.js';
import { boardingLayer, triggerBoardingBurst } from '../world/boarding.js';
import { pedestriansLayer, setPedestriansEnabled, setPedestrianFreeRoamEnabled, getNearbyDog, petNearbyDog, holdDogInteraction } from '../world/pedestrians.js';
import { disposePersonMeshSessionCaches } from '../world/person-mesh.js';
import { disposeDogMeshSessionCaches } from '../world/dog-mesh.js';
import {
    campaignActorsLayer,
    getCampaignActorsSnapshot,
    restoreCampaignActorsSnapshot,
    replaceCampaignActorsScene,
} from '../world/campaign-actors.js';
import {
    campaignMarkersLayer,
    replaceCampaignMarkersScene, setCampaignMarkersHidden } from '../world/campaign-markers.js';
import {
    campaignEnvironmentLayer,
    getCampaignEnvironmentSnapshot,
    restoreCampaignEnvironmentSnapshot,
    getCampaignEnvironmentGroup,
    getCampaignEnvironmentFloorY,
    getCampaignEnvironmentGroundYAt,
    replaceCampaignEnvironmentScene,
    syncCampaignEnvironmentCinematic,
    campaignEnvironmentFilmAircraft,
    campaignEnvironmentStandInVehicleKinds,
    campaignEnvironmentStandsInForPlayer,
} from '../world/public-empty-authored-world.js';
import {
    getGricTunnelLandmarkGroup,
    gricTunnelLandmarkLayer,
} from '../world/public-empty-authored-world.js';
import { campaignFireworksLayer } from '../world/public-empty-authored-world.js';
import { campaignCrowdLayer, replaceCampaignCrowdScene } from '../world/campaign-crowd.js';
import { campaignMusicLayer } from '../world/public-empty-authored-world.js';
import { createPassengerLiftRide, liftFloorYAt, resolveLiftLandingMove } from '../world/lifts.js';
import {
    campaignTowerLayer,
    campaignTowerRoofYAt,
    getCampaignTowerGroup,
} from '../world/public-empty-authored-world.js';
import {
    createPlayerWalkerAvatar,
    updatePlayerWalkerAvatar,
} from '../world/player-walker-avatar.js';

// The external performance harness must inspect the module graph that owns the
// active cab. Importing these source modules from a bundled page creates fresh
// singleton state and both perturbs and falsifies startup measurements.
if (typeof window !== 'undefined') {
    window.__s3dWorldLoadState = () => ({
        building: isWorldBuilding(),
        telemetry: getWorldLoadTelemetry(),
        components: getWorldLoadComponents(),
        startupTrace: startupTrace.snapshot(),
        // The campaign drive-surface gate ("Ruta bijega"): which corridor
        // points are still unready, and why, while the curtain is up.
        driveSurface: state.cabState?.driveSurfacePreloadStatus || null,
        railGate: typeof window.__s3dRailPreloadGate === 'function'
            ? window.__s3dRailPreloadGate(state.cabState?.driveSurfacePreload)
            : null,
        driveSurfaceSettled: state.cabState?.driveSurfacePreloadSettled ?? null,
        groundGeneration: state.cabState?.groundGenerations?.snapshot?.() ?? null,
        initialSourceLoad: state.cabState?.initialSourceLoadState ?? null,
        pendingLayers: state.cabState?.pendingLayerEntries?.map(entry => entry?.name ?? entry?.id ?? '?') ?? null,
        pendingLayerFrame: state.cabState?.pendingLayerFrame ?? null,
    });
}

const DRIVE_SURFACE_STABLE_MS = 1_000;
// The authoring compiler settles a whole corridor before capture (see the
// campaign adapters' bake timeout); the world hold must not cut it short.
const CAMPAIGN_PACK_BAKE_CEILING_MS = 30 * 60_000;
const AMMO_PER_STATION_RELOAD = 100;
let lastReloadStation = null;
const PLAYER_TRAM_SERVICE_CAPACITY = 200;
const PLAYER_TRAM_INITIAL_PASSENGERS = 8;
const PLAYER_STOP_BAND_RADIUS_M = 5.5;
const PLAYER_STOP_GUIDE_MAX_FORWARD_M = 90;
const PLAYER_STOP_GUIDE_MAX_LATERAL_M = 16;
const PLAYER_STOPPED_SPEED_MPS = 0.12;
// Localhost-only dev aid: the perf overlay's "open here in Google Maps / OSM"
// links read window.__simLatLon. Resolved once, so prod pays a single false
// branch per frame and never allocates.
const IS_LOCAL_DEV = typeof window !== 'undefined'
    && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
const simLatLon = IS_LOCAL_DEV ? { lat: 0, lon: 0, headingDeg: 0 } : null;
const PLAYER_STOP_MIN_BOARD = 1;
const PLAYER_STOP_MAX_BOARD = 4;
const PLAYER_STOP_MIN_ALIGHT = 1;
const PLAYER_STOP_MAX_ALIGHT = 3;
const PLAYER_FARE_EUR = 1;
import { otherTramsLayer, getGtaAmbientTramProvider } from '../vehicles/tram.js';
import { isAmbientTrainFeature } from '../core/gta-ambient-trams.js';
import { createTramMesh, setTramDoorsOpen, TRAM_HALF_WIDTH_M } from '../models/vehicles/tram.js';
import { createHz7022Mesh, HZ_7022_CAR_SPACING_M } from '../models/vehicles/hz-7022.js';
const TRAIN_CAR_CENTER_OFFSETS_M = Object.freeze([
    HZ_7022_CAR_SPACING_M,
    0,
    -HZ_7022_CAR_SPACING_M,
]);
import { ROLLING_STOCK_HZ_7022, selectRollingStock } from '../core/rolling-stock.js';
import { disposeGroup } from '../core/dispose.js';
import { smoothRailTrackFeatures } from '../world/rail-track-smoothing.js';
import { updateCabInterior, disposeCabInterior } from '../vehicles/cab-interior.js';
import {
    setDashboardAltitudeVisible,
    setDashboardHeading,
    setDashboardVisible,
    setDashboardBellHandler,
    setDashboardDoorHandler,
    setDashboardDoorState,
    setDashboardParkingBrakeHandler,
    setDashboardParkingBrakeState,
    setPhotoLoading,
    setWorldLoading,
    setCampaignBakeStatus,
    setPhotoLoadProgress,
    setPhotoLoadTelemetry,
    setWorldLoadComponents,
    setWorldLoadTelemetry,
    recordWorldLoadDurations,
} from '../ui/dashboard.js';
import { dropLoadingCurtain, setLoadingCurtainProgress } from '../ui/loading-curtain.js';
import { cabViewHeadingDeg } from '../core/compass.js';
import {
    buildDriverGraph, snapPoseToGraph, driverStep, computeDriverPose,
    createDriverState, resnapDriverState, sampleDriverStateAtOffset, DRIVER_TUNING,
} from './driver.js';
import {
    createWalkState, stepWalk, onKeyDown as walkKeyDown, onKeyUp as walkKeyUp,
    clearWalkKeys, shouldRecoverTerrainFloor, shouldUseBuildingRoofBump, shouldAcceptRoofSupport,
    isWalkSupportOverhead, reachableWalkSupportY, selectWalkBaselineSupportY,
    resolveRailFormationWalkSupport, resolveRoadReplacementWalkSupport,
    resolveViaductTerrainWalkSupport,
    resolveWalkSupportContext,
    WALK_BORE_LEVEL_CLEARANCE_M,
    WALK_MAX_STEP_UP_M, WALK_MOVEMENT_KEYS, setJetpackCeiling,
    setWalkSpeed, FREE_ROAM_WALK_SPEED_MPS, STORY_WALK_SPEED_MPS,
    beginWalkParachute,
    isWalkSpeedBoostOn,
    seaSurfaceSupportY,
} from './walk.js';
import { advanceRunHint, createRunHintState } from '../core/walk-run-hint.js';
import {
    getCampaignFootPursuitSnapshot,
    startCampaignFootPursuit,
    stepCampaignFootPursuit,
    stopCampaignFootPursuit,
} from '../world/public-empty-authored-world.js';
let createGtaSession = null;
let gtaModePromise = null;

export async function preloadCabOptionalCapabilities({ gta = false, weapons = false } = {}) {
    const jobs = [];
    if (gta && !createGtaSession) {
        if (!gtaModePromise) {
            gtaModePromise = import('./gta.js').then((module) => {
                createGtaSession = module.createGtaSession;
                return module;
            }).catch((error) => {
                gtaModePromise = null;
                throw error;
            });
        }
        jobs.push(gtaModePromise);
    }
    if (weapons) jobs.push(preloadWeaponRuntime());
    await Promise.all(jobs);
    return true;
}

// Camera mounted INSIDE the driver's cab. CAB_HEIGHT is the driver's eye
// height above the rail (was 3.5 = above the roof, which read like a
// drone-cam). CAB_FORWARD_OFFSET shifts the camera from the tram's centre
// (where the pose is anchored) toward the front of the body — the tram is
// 18 m long, so 7 m forward puts the eye ~2 m back from the front edge,
// roughly where a tram driver actually sits.
const CAB_HEIGHT = 2.5;
// Walk-mode eye height above the avatar's feet/y position. Stays fixed
// regardless of jetpack / rooftop landing — the camera just rides higher.
const WALK_EYE_HEIGHT = 1.7;
const CAB_FORWARD_OFFSET = 7.0;
const CAB_LOOKAHEAD = 60;
const HEADING_SMOOTH = 0.18;
// Vertical eye/tram Y is EMA-smoothed like heading: the rail-formation ground
// sample can step when the lookup drops in/out near curves/junctions, which
// otherwise reads as camera wobble.
const GROUND_Y_SMOOTH = 0.25;
// Max gaze pitch (deg). A tram/metro never exceeds a few % grade, so this bounds
// any bad grade sample from flinging the cab view up or down.
const CAB_MAX_PITCH_DEG = 6;
const CAB_SNAP_RADIUS_M = 60;
// Third-person bird's-eye view (C key). Camera sits BIRD_HEIGHT above
// the ground at BIRD_BACK_OFFSET behind the tram centre, looking at a
// point BIRD_LOOK_AHEAD ahead of it. Slight forward tilt makes the
// upcoming track visible instead of pure top-down.
//
// Mouse wheel in third-person adjusts the elevation between
// BIRD_HEIGHT_MIN..MAX. Back-offset and look-ahead scale linearly with
// elevation so the apparent angle stays roughly constant — at any
// height you still see the tram + a chunk of track ahead.
const BIRD_HEIGHT_DEFAULT = 22;
const BIRD_HEIGHT_MIN     = 8;
const BIRD_HEIGHT_MAX     = 120;
// Ratios chosen so the WHOLE 18 m tram (tail included) fits in frame at the
// default height: camera well behind the tram, aim point just past the nose.
// The old 12/22 + 20/22 pair aimed 20 m ahead from close behind, which
// dropped the tram's rear ~80° below the view axis — outside the FOV.
const BIRD_BACK_RATIO     = 24 / 22;   // back-offset = elevation × this
const BIRD_LOOK_RATIO     = 8 / 22;    // look-ahead = elevation × this
// Wheel sensitivity. Browsers report deltaY in pixels (typically 100
// per notch on a mouse, smaller on trackpads). 0.05 m per pixel works
// well for both — one mouse notch = ~5 m elevation step.
const BIRD_WHEEL_M_PER_DELTA = 0.05;
// Speed-coupled FOV in driver mode. At rest the camera is the static FOV
// below; at top tram speed it widens by FOV_SPEED_GAIN, giving a subtle
// "going faster" cinematic cue. Smoothed so brake/release isn't snappy.
const FOV_BASE_DEG = 60;
const FOV_SPEED_GAIN = 12;     // +12° at 100 km/h
const FOV_SMOOTH = 0.06;
const TRAM_MAX_HEALTH = 1000;
// Stable local datum used by the heavy-rail vehicle mesh. Reference/project
// geometry resolves the actual world height separately; the mesh and camera
// move together from this internal baseline.
const TRAIN_CAB_BASE_Y = 7.5;
const CAMERA_MODES = ['front', 'rear', 'third'];
const UNDERGROUND_CAMERA_MODES = ['front', 'rear'];
const CAB_WALK_AIRDROP_HEIGHT_M = 6;
const CAB_WALK_AIRDROP_VY_MPS = -1.5;

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function currentPositionShareUrl(cabState, pose) {
    if (!cabState || !pose) return '';
    const look = getCameraLook();
    return buildPositionShareUrl({
        currentUrl: window.location.href,
        pose,
        sessionPresetId: cabState.sessionPresetId,
        lookYawRad: look.yaw,
        lookPitchRad: look.pitch,
        explorerBasePath: getSessionHost().basePath || undefined,
    });
}

// The canonical layer list. Order controls lifecycle/render context only;
// terrain/civil precedence lives in CivilGroundComposition and cannot be
// changed by moving a layer or by whichever stream publishes first.
// `name` is used by the per-frame perf overlay (scene/animate.js) so each
// layer's onFrame cost shows up under a stable label. Keep it short.
const surfaceLayerEntries = [
    // An authored campaign level replaces the stable surface layers below as
    // one immutable blocking publication. For ordinary sessions this is a
    // no-op and the existing streaming stack remains unchanged.
    { name: 'campaignWorldPack', layer: campaignWorldPackLayer, blocking: true, worlds: 'model' },
    // Terrain is the session's vertical datum. It blocks the other world
    // layers only when requested, ensuring every consumer receives the same
    // ready TerrainReference before it constructs geometry.
    { name: 'terrain', layer: terrainLayer, blocking: true },
    // The Mesnička Grič portal is part of Zagreb itself, not campaign-only
    // scenery. It publishes its replacement shell before live world streams
    // can expose terrain/building fragments through the entrance footprint.
    { name: 'gricTunnelLandmark', layer: gricTunnelLandmarkLayer, blocking: true, worlds: 'model' },
    { name: 'campaignTower', layer: campaignTowerLayer, worlds: 'model' },
    // Finale fireworks over the tower; one draw call, idle until its world effect.
    { name: 'campaignFireworks', layer: campaignFireworksLayer, worlds: 'model' },
    // Chapter music bed; streams one looping track, idle outside a campaign session.
    { name: 'campaignMusic', layer: campaignMusicLayer, worlds: 'model' },
    // Optional photorealistic base world (Google 3D Tiles via 3d-tiles-renderer),
    // enabled per session with ?rw. A no-op unless the flag is set.
    { name: 'photoreal', layer: photorealLayer },
    { name: 'roads', layer: roadsLayer, worlds: 'model' , outside: true},
    { name: 'roadStructures', layer: roadGradeSeparationsLayer, worlds: 'model' , outside: true},
    // Curbs and road furniture consume the formation model created by roads.
    { name: 'curbs', layer: curbsLayer, worlds: 'model' , outside: true},
    { name: 'laneMarkings', layer: laneMarkingsLayer, worlds: 'model' , outside: true},
    { name: 'rails', layer: railsLayer },
    // Authored waiting stock consumes the exact formation built by rails and
    // must exist before the generic deferred ambient services begin.
    { name: 'campaignRailVehicles', layer: campaignRailVehiclesLayer, worlds: 'model' },
    // Separate, cancellable near-work. It reads rails' exact sampled alignment,
    // never participates in world readiness, and is excluded from photo worlds.
    { name: 'electrification', layer: electrificationLayer, deferred: true, worlds: 'model' },
    // Level crossings dress at-grade track×road crossings (zebra + ramp aprons)
    // and share the rails' road-index pass. Runs after rails so ctx.railFormation
    // is set; cheap merged quads, rebuilt only when the alignment re-solves.
    { name: 'levelCrossings', layer: levelCrossingsLayer, deferred: true, worlds: 'model' , outside: true},
    // Viaducts + tunnel tubes for planner tracks whose levels leave the ground.
    // MODEL-ONLY: the photo world builds its own civil works (photoreal.js);
    // these flat-world boxes sit at model heights and must never exist there.
    { name: 'plannerElevation', layer: plannerElevationLayer, worlds: 'model' },
    { name: 'ambientTrains', layer: ambientTrainsLayer, deferred: true },
    // Audio-only: the location's bird calls once every few minutes. Deferred —
    // it must never appear in world readiness, and it builds nothing.
    { name: 'ambientBirds', layer: ambientBirdsLayer, deferred: true },
    // Proposals must run BEFORE buildingsLayer: its beginSession is what arms proposalsReady(),
    // and the cadastre building stream awaits that promise before it builds anything — so no
    // existing building is drawn before we know whether a proposal razed it, cut it, or tunnelled
    // under it. Registered after it, the buildings layer would see a promise that was already
    // resolved and race the proposal fetch.
    { name: 'proposals', layer: proposalsLayer, worlds: 'model' },
    // Start detailed buildings with the immediate layers: the observer's four
    // touching 100 m tiles are the useful near field and must own network/CPU
    // priority before horizon placeholders. Far LOD1 remains deferred and each
    // box disappears as its detailed mesh publishes.
    { name: 'buildings', layer: buildingsLayer, worlds: 'model' , outside: true},
    { name: 'farBuildings', layer: farBuildingsLayer, deferred: true, worlds: 'model' , outside: true, suspendInAnyTunnel: true},
    // NOT deferred: a modelled tower is one 25k-triangle build in a handful of draw calls,
    // and it is a landmark — the thing you look for from across the city. Behind the
    // deferred queue it waits on farBuildings streaming the whole LOD1 city first.
    // The landmark layer is GONE: landmarks are baked upstream and stream in as
    // ordinary building meshes through /buildings-mesh, so the buildings layer
    // draws them and the server withholds the survey massing they replace.
    // Mounting this as well drew every landmark TWICE — the modelled glass and,
    // in the same place, a second copy from the client-side builder.
    //
    { name: 'courtyardPassages', layer: courtyardPassagesLayer, deferred: true, worlds: 'model' , outside: true},
    // Reuse the established metro hall for planner stops at level -1;
    // platformsLayer below contributes only the surface entrance/stairs.
    // Shared assets: all three station types come from this
    // one set — there is no photo-specific set — so both layers run in both
    // worlds. Only the flat-world CIVIL boxes (plannerElevation) are
    // model-only; station seating in the photo datum is its own concern.
    { name: 'undergroundStations', layer: undergroundLayer },
    { name: 'platforms', layer: platformsLayer, deferred: true },
    { name: 'flags', layer: flagsLayer, deferred: true, worlds: 'model' , outside: true},
    { name: 'decor', layer: decorLayer, deferred: true, worlds: 'model' , outside: true},
    { name: 'water', layer: waterLayer, worlds: 'model' , outside: true},
    // Far terrain, far sea and the sky of scenes that author them (the Vis arrival).
    { name: 'aerialView', layer: aerialViewLayer, worlds: 'model', outside: true },
    // Now and then a fish jumps out of the sea near the camera. Deferred: it
    // builds a handful of tiny meshes and never gates world readiness.
    { name: 'fishJumps', layer: fishJumpsLayer, deferred: true, worlds: 'model', outside: true },
    { name: 'gtaSpecialVehicles', layer: gtaSpecialVehiclesLayer, blocking: true, worlds: 'model', outside: true },
    // Checker-only pick proxies for imported decor/water that render in merged
    // or instanced batches and therefore cannot carry per-source mesh identity.
    { name: 'sourceEntities', layer: sourceEntitiesLayer, deferred: true, worlds: 'model', outside: true },
    { name: 'mgNests', layer: machineGunNestsLayer, deferred: true, worlds: 'model' , outside: true},
    { name: 'cars', layer: carsLayer, deferred: true, worlds: 'model' , outside: true},
    // Authored floors are spawn authority, not decoration. Publish them before
    // the blocking-ready handoff so direct room checkpoints are seated on the
    // same surface actors and rendering use.
    { name: 'campaignEnvironment', layer: campaignEnvironmentLayer, blocking: true, worlds: 'model' },
    { name: 'campaignActors', layer: campaignActorsLayer, worlds: 'model' },
    { name: 'campaignCrowd', layer: campaignCrowdLayer, worlds: 'model' },
    { name: 'campaignMarkers', layer: campaignMarkersLayer, blocking: true, worlds: 'model' },
    // Streetlamps ride the same 'roads:graph' source as cars (fetched once).
    { name: 'streetLamps', layer: streetLampsLayer, deferred: true, worlds: 'model' , outside: true},
    { name: 'otherTrams', layer: otherTramsLayer },
    // boardingLayer reads otherTrainsFn (provided to all layers in ctx)
    // to detect tram-at-stop transitions, so it must run after the tram
    // poses are settled but order otherwise doesn't matter.
    { name: 'boarding', layer: boardingLayer, deferred: true, worlds: 'model' },
    { name: 'pedestrians', layer: pedestriansLayer, deferred: true, worlds: 'model' , outside: true},
    { name: 'jetpackShop', layer: jetpackShopLayer, worlds: 'model', outside: true },
    // Street names in 3D letters, on by default, toggled with U (ulice).
    { name: 'streetNames', layer: streetNamesLayer, deferred: true, worlds: 'model' , outside: true},
];
const undergroundLayerEntries = [
    { name: 'underground', layer: undergroundLayer },
    { name: 'campaignEnvironment', layer: campaignEnvironmentLayer, blocking: true },
    { name: 'campaignActors', layer: campaignActorsLayer },
    { name: 'campaignMarkers', layer: campaignMarkersLayer, blocking: true },
];
let unregisterFrameHook = null;
let unregisterAfterRenderHook = null;

function cabAfterRender() {
    const cabState = state.cabState;
    const reason = cabState?.pendingCampaignReadyReason;
    if (!reason || !cabState.lastRenderedPose || cabState.initialVehicleClaimPending) return;
    // The initial claim happens at the end of cabStep. Its first vehicle
    // camera is rendered on the following frame, after the foot pose is gone.
    if (cabState.initialVehicleId && cabState.lastRenderedPose.status?.driving !== true) return;
    cabState.pendingCampaignReadyReason = null;
    cabState.initialWorldPending = false;
    cabState.onCampaignSessionReady?.(reason);
}
let keysBound = false;

export function campaignWorldPackLayerEntries(entries = surfaceLayerEntries) {
    return entries.filter(entry => !campaignPackReplacesLayer(entry?.name));
}

function getSessionLayerEntries(isUndergroundSession, useCampaignWorldPack = false) {
    if (isUndergroundSession) return undergroundLayerEntries;
    const entries = useCampaignWorldPack
        ? campaignWorldPackLayerEntries()
        : surfaceLayerEntries;
    if (!isElevationMode()) return entries;
    return entries.filter(entry => includeSurfaceLayerInElevationMode(entry.name));
}

function beginSessionLayer(cabState, entry, ctx) {
    if (!entry || !entry.layer) return null;
    const name = entry.name || 'unnamed';
    const traceT0 = startupTrace.enabled ? performance.now() : 0;
    const result = entry.layer.beginSession ? entry.layer.beginSession(ctx) : null;
    if (startupTrace.enabled) {
        startupTrace.layerSync(name, performance.now() - traceT0);
        if (result && typeof result.then === 'function') {
            const done = () => startupTrace.layerAsync(name, performance.now() - traceT0);
            result.then(done, done);
        }
    }
    return result;
}

function scheduleDeferredLayerStarts(cabState, ctx) {
    if (!cabState.pendingLayerEntries || cabState.pendingLayerEntries.length === 0) {
        cabState.pendingLayerFrame = null;
        startupTrace.milestone('deferred-built');
        startupTrace.reportLayers();
        noteWorldPhase('deferred-built');
        return;
    }
    cabState.pendingLayerFrame = requestAnimationFrame(() => {
        cabState.pendingLayerFrame = null;
        if (state.cabState !== cabState) return;
        const entry = cabState.pendingLayerEntries.shift();
        if (entry) void cabState.layerStartup.start(entry);
        scheduleDeferredLayerStarts(cabState, ctx);
    });
}

function settleCampaignPackWalkSpawn(cabState, ctx) {
    const walk = cabState?.walkMode;
    if (!walk) return false;
    const environmentGroundY = getCampaignEnvironmentGroundYAt(0, 0);
    const upperSupportY = ctx?.campaignScene?.authored?.spawnOnUpperSupport === true
        ? getWalkGroundY(0, 0, Infinity) : null;
    if (!Number.isFinite(environmentGroundY) && !Number.isFinite(upperSupportY)
        && (!ctx?.campaignWorldPack || Number.isFinite(walk.initialGroundY))) return false;
    // A closed authored room is built after openWalk has created its initial
    // state. Its floor is an absolute scene height (terrain + room offset),
    // whereas the declarative offset alone is not. Seat direct checkpoints on
    // the built surface before revealing the world.
    const groundY = Number.isFinite(upperSupportY) ? upperSupportY
        : Number.isFinite(environmentGroundY) ? environmentGroundY
        : campaignWorldPackSpawnYAtLocal(0, 0);
    if (!Number.isFinite(groundY)) return false;
    Object.assign(walk, {
        y: groundY,
        vy: 0,
        initialGroundY: groundY,
        lastDetectedGroundY: groundY,
        spawnY: groundY,
        floorGuardActive: false,
        groundMissSeconds: 0,
        airborne: false,
    });
    return true;
}

async function startSessionLayers(cabState, ctx, entries) {
    // Readiness and presentation are independent: a campaign pack uses its
    // chapter curtain, but input still waits for publication and a real frame.
    cabState.initialWorldPending = true;
    cabState.pendingCampaignReadyReason = null;
    resetFrameChunkSessionStatistics();
    resetFrameChunkObserver();
    // Keep the baseline dynamic: the blocking terrain layer publishes onto the
    // shared context after this object is created, and moving terrain windows
    // can subsequently replace the TerrainReference without changing policy.
    ctx.civilGround = new CivilGroundComposition({
        terrainSceneYAtLocal: (x, z) => ctx.terrain?.sceneYAtLocal?.(x, z),
        terrainEvidenceSceneYAtLocal: (x, z) => (
            ctx.terrain?.evidenceSceneYAtLocal?.(x, z)
        ),
    });
    cabState.civilGround = ctx.civilGround;
    // Context-aware catch-all ground (grass beyond building/road coverage).
    // Photo has no catch-all plane, so it's always off there. In the terrain
    // world we still feed this same shader slot UNLESS the location builds its
    // own terrain urban-ground mask (Split) — otherwise (Zagreb) the terrain
    // surface is grass and this mask blends the sidewalk catch-all back in near
    // buildings and roads, exactly as the flat world does.
    const terrainOwnsGroundMask = isTerrainRequested(ctx.terrainPolicy)
        && !!getLocation().urbanGround;
    beginGroundCover({
        enabled: !ctx.campaignWorldPack && !isPhotoWorld() && !terrainOwnsGroundMask,
    });
    startupTrace.begin();
    // Hold an opaque loading overlay (with the sim frozen, see cabStep) until the
    // near-field has settled — but only for the surface MODEL world. Underground
    // has no streaming queues to wait on, and the photo world reveals via its own gate.
    const useCampaignWorldPack = !!ctx.campaignWorldPack;
    const useLoadingHold = !cabState.isUndergroundSession
        && !isPhotoWorld()
        && !useCampaignWorldPack;
    cabState.initialSourceLoadPending = useLoadingHold;
    cabState.driveSurfacePreload = useLoadingHold
        ? resolveCampaignDrivePreload({
            spec: cabState.campaignScene?.authored?.driveSurfacePreload,
            anchorLat: cabState.anchorLat,
            anchorLon: cabState.anchorLon,
        })
        : null;
    // Terrain is the blocking layer and starts below. Give it the resolved
    // local/geo corridor now so its base cells and final-detail band belong to
    // the same chapter load as the later terrain/road mesh readiness gate.
    ctx.campaignDriveSurfacePreload = cabState.driveSurfacePreload;
    // Bake-only terrain window (see campaignPackBakeAuthoredOverrides).
    ctx.campaignTerrainDetail = cabState.campaignScene?.authored?.campaignTerrainDetail || null;
    cabState.driveSurfacePreloadStatus = null;
    cabState.driveSurfacePreloadReadySinceMs = null;
    cabState.driveSurfacePreloadSettled = false;
    // Per build: which corridor points have published at least once. Readiness
    // stays live, but tile churn may not take a published point back and reopen
    // the gate (core/campaign-drive-preload.js).
    cabState.driveSurfaceSatisfiedPoints = new Set();
    if (useLoadingHold) {
        // A chapter answers to the campaign's progress-aware watchdog, so the
        // generic 120 s ceiling must not fail a slow host first; a bake has
        // its own half-hour allowance.
        beginWorldBuild({
            ceilingMs: ctx.campaignPackBake
                ? CAMPAIGN_PACK_BAKE_CEILING_MS
                : cabState.campaignScene ? CAMPAIGN_READY_CAP_MS : null,
        });
        startWorldTransferObserver();
        // Source delivery is distinct from geometry publication. Keep the
        // curtain over the finite initial view while queued downloads or their
        // subscriber handoffs remain. The coordinator must also finish its
        // final physical/rendered publication, including admission gaps when
        // it has pending input but no compiler job in a watched queue yet.
        noteWorldQueueActive('world-data');
        if (cabState.driveSurfacePreload) {
            noteWorldBuildRequirementActive('drive-surface');
            noteWorldQueueActive('drive-surface');
        }
        // A campaign chapter names itself on the hold, the same heading the
        // campaign curtain shows while the previous session is being closed.
        const loadingHeading = cabState.campaignScene
            ? campaignSceneLoadingHeading(
                cabState.campaignScene.chapter
                    ? t('campaign.chapter', { n: cabState.campaignScene.chapter })
                    : '',
                // The override arrives with the launch options later in the
                // open flow; the scene's own title is the same heading.
                cabState.titleOverride
                    || cabState.campaignScene.title?.[getLang()]
                    || cabState.campaignScene.title?.en
                    || '',
            )
            : null;
        setWorldLoading(true, '', {
            eyebrow: loadingHeading?.eyebrow || '',
            headline: loadingHeading?.headline || '',
        });
        if (ctx.campaignPackBake) beginCampaignBakeStatus(cabState);
        onWorldReady((reason) => {
            startupTrace.milestone(`world-ready:${reason}`);
            // Feed this build's measured component times back into the bar's
            // experienced-width EWMA, then drop the overlay.
            recordWorldLoadDurations(getWorldLoadDurations());
            stopWorldTransferObserver();
            setWorldLoading(false, reason);
            // A free-roam world takes the loading screen away now; a campaign
            // chapter leaves it to the director, which drops it once the scene
            // has opened (core/campaign-director.js).
            if (!cabState.campaignScene) dropLoadingCurtain();
            offerDaylightIfNight(cabState);
            if (state.cabState === cabState) cabState.pendingCampaignReadyReason = reason;
            if (cabState.outsideSuspended) cabState.initialSourceLoadPending = false;
            if (ctx.campaignPackBake) {
                updateCampaignBakeStatus(cabState, 'ready');
                // Only once the corridor has built: the loading-phase budgets
                // are what get the world here, and full throttle from the
                // start starved delivery (measured: 60 MB flat for minutes).
                // After the reveal nothing needs to stay smooth, so every
                // queue drains at full throttle until the capture.
                setFrameChunkSchedulerThroughput(true);
            }
        });
    }
    cabState.activeLayers = [];
    cabState.pendingLayerEntries = [];
    cabState.pendingLayerFrame = null;
    cabState.layerStartup = createLayerStartupCoordinator({
        begin: (entry) => beginSessionLayer(cabState, entry, ctx),
        cleanup: (entry) => {
            if (entry?.layer?.endSession) entry.layer.endSession();
        },
        isCurrent: () => state.cabState === cabState,
        onActive: (entry) => {
            if (!cabState.activeLayers.some(active => active.layer === entry.layer)) {
                cabState.activeLayers.push(entry);
            }
        },
        onFailure: (entry, error, layerState) => {
            console.error(
                `[cab] layer '${entry.name || 'unnamed'}' failed`
                + ` (attempt ${layerState.attempts}, retry scheduled)`,
                error,
            );
        },
        onRecovery: (entry) => {
            console.info(`[cab] layer '${entry.name || 'unnamed'}' recovered`);
        },
    });
    cabState.unregisterLayerStartupActivity = registerBackgroundActivityReader(() => ({
        kind: 'layer',
        label: 'startup',
        ...cabState.layerStartup.getSnapshot(),
    }));
    // World contract: an entry declares worlds: 'model' | 'photo' | 'both'
    // (default 'both'). Layers outside the session's world are never begun —
    // no build, no per-frame cost, no geometry to hide. This replaces
    // visibility panning as the separation mechanism, layer by layer.
    const entryInWorld = (entry) => {
        const worlds = entry.worlds || 'both';
        if (worlds === 'model') return !isPhotoWorld();
        if (worlds === 'photo') return isPhotoWorld();
        return true;
    };
    // Entries skipped by the world contract are remembered: if a photo
    // session terminally falls back to the model world, cabStep late-starts
    // them so the fallback is a complete model world, not a naked track.
    cabState.worldSkippedEntries = entries.filter((entry) => entry && !entryInWorld(entry));
    cabState.layerCtx = ctx;
    for (const entry of entries) {
        const needsUpperSupport = entry?.name === 'campaignTower'
            && ctx.campaignScene?.authored?.spawnOnUpperSupport === true;
        if (!entry || (!entry.blocking && !needsUpperSupport) || !entryInWorld(entry)) continue;
        const started = await cabState.layerStartup.start(entry);
        if (state.cabState !== cabState) return;
        if (!started && entry.name === 'campaignWorldPack') {
            throw cabState.layerStartup.getState(entry)?.error
                || new Error('The baked campaign world failed to publish.');
        }
    }
    settleCampaignPackWalkSpawn(cabState, ctx);
    startupTrace.milestone('blocking-ready');   // terrain built → first frame can render
    noteWorldPhase('blocking-ready');
    cabState.terrain = ctx.terrain || null;
    if (ctx.terrainSource && ctx.publishedTerrain && !isPhotoWorld() && !cabState.isUndergroundSession) {
        cabState.groundGenerations = createWorldGroundGenerations({ ctx,
            layers: { terrain: terrainLayer, roads: roadsLayer, rails: railsLayer,
                structures: roadGradeSeparationsLayer, curbs: curbsLayer, gric: gricTunnelLandmarkLayer,
                planner: plannerElevationLayer, stations: platformsLayer, water: waterLayer },
            isCurrent: () => state.cabState === cabState });
        ctx.groundCoordinator = cabState.groundGenerations;
    }
    for (const entry of entries) {
        if (!entry || entry.blocking || !entryInWorld(entry)) continue;
        if (entry.deferred) cabState.pendingLayerEntries.push(entry);
        else void cabState.layerStartup.start(entry);
    }
    startupTrace.milestone('immediate-built');
    noteWorldPhase('immediate-built');
    cabState.roadFormation = ctx.roadFormation || null;
    cabState.roadVerticalAlignments = ctx.roadVerticalAlignments || null;
    cabState.railFormation = ctx.railFormation || null;
    scheduleDeferredLayerStarts(cabState, ctx);
    if (!useLoadingHold && state.cabState === cabState) {
        cabState.pendingCampaignReadyReason = 'layers-published';
        // No model build hold here. A photo world keeps the loading screen until
        // its tiles reveal (cabStep); an underground session has nothing to wait for.
        if (!cabState.campaignScene && !isPhotoWorld()) dropLoadingCurtain();
    }
}

// ── Tunnel surface suspension ───────────────────────────────────────────────
// Sealed inside an enclosed tube, none of the surface world is visible, yet every
// layer's onFrame kept running: roads streaming a 1.4 km corridor, detailed
// buildings 800 m, curbs, lane paint, decor — all building meshes for a city
// nobody can see, which is what made long underground runs choppy. The photo
// world already does this for its own source (shouldSuspendPhotoSource).
//
// Resuming is the delicate half: it happens far enough before the portal that the
// surface has streamed back in by the time it is visible, scaled by speed, with
// hysteresis so a short tube is ridden through untouched and nothing flaps. See
// core/tunnel-occlusion.js for the rules and their tests.
const TUNNEL_OCCLUDED_STARTUP_QUEUES = Object.freeze([
    'world-data',
    'ground-generation',
    'ground:paint',
    'roads',
    'curbs',
    'lane-markings.rebuild',
    'cars',
    'buildings',
    'far-buildings',
    'platforms',
    'decor',
]);

function updateTunnelSurfaceSuspension(cabState, pose, local) {
    if (!cabState || cabState.walkMode || cabState.isUndergroundSession || isPhotoWorld()) {
        if (cabState) cabState.insideTunnelSpan = false;
        return applyTunnelSurfaceSuspension(cabState, false);
    }
    const plannerSpans = getEnclosedTunnelSpans();
    const railSpans = getEnclosedRailTunnelSpans();
    if ((!plannerSpans || !plannerSpans.length) && (!railSpans || !railSpans.length)) {
        cabState.insideTunnelSpan = false;
        return applyTunnelSurfaceSuspension(cabState, false);
    }
    const here = findEnclosingSpan(plannerSpans, local.x, local.z)
        || findEnclosingSpan(railSpans, local.x, local.z);
    // Inside ANY tunnel span, short or long: the length-gated `suspend` below
    // keeps the near surface up while a short tube is ridden through, but the
    // distant horizon is occluded by the tube either way, so the far-buildings
    // layer gates on this instead (a short tube like Brajdica never suspends,
    // yet has no reason to keep streaming the whole amphitheatre hillside).
    cabState.insideTunnelSpan = !!here;
    const speedKmh = Number(pose?.status?.speedKmh);
    const suspend = shouldSuspendOutsideWorld({
        inside: !!here,
        metresToExit: here ? here.metresToExit : null,
        speedMps: Number.isFinite(speedKmh) ? speedKmh / 3.6 : 0,
        wasSuspended: !!cabState.outsideSuspended,
    });
    return applyTunnelSurfaceSuspension(cabState, suspend);
}

// Lighting follows the same switch. Zeroing the sun while enclosed removes the
// whole directional shadow pass — the single biggest GPU cost of the surface we
// just stopped drawing — and is what a dedicated underground session already does
// (applySessionSceneMode). Restored verbatim on resume.
function applyTunnelSurfaceSuspension(cabState, suspend) {
    if (!cabState) return false;
    const next = !!suspend;
    const changed = next !== !!cabState.outsideSuspended;
    cabState.outsideSuspended = next;
    setWorldBuildOptionalQueues(next ? TUNNEL_OCCLUDED_STARTUP_QUEUES : []);
    if (!changed) return next;
    if (next) {
        cabState.tunnelPrevSunIntensity = sun ? sun.intensity : null;
        cabState.tunnelPrevFillIntensity = fill ? fill.intensity : null;
        if (sun) sun.intensity = 0;
        if (fill) fill.intensity = 0;
    } else {
        if (sun && cabState.tunnelPrevSunIntensity != null) sun.intensity = cabState.tunnelPrevSunIntensity;
        if (fill && cabState.tunnelPrevFillIntensity != null) fill.intensity = cabState.tunnelPrevFillIntensity;
        cabState.tunnelPrevSunIntensity = null;
        cabState.tunnelPrevFillIntensity = null;
    }
    console.log(`[Station3D] surface world ${next ? 'suspended (in tunnel)' : 'resumed (nearing portal)'}`);
    return next;
}

function applySessionSceneMode(cabState, {
    isUndergroundSession = false,
    campaignWorldPack = null,
    openSea = false,
} = {}) {
    cabState.prevGroundVisible = groundMesh ? groundMesh.visible : true;
    cabState.prevSceneBackground = scene && scene.background && typeof scene.background.clone === 'function'
        ? scene.background.clone()
        : scene ? scene.background : null;
    cabState.prevSceneFog = scene && scene.fog
        ? { color: scene.fog.color.clone(), near: scene.fog.near, far: scene.fog.far }
        : null;
    cabState.prevSunIntensity = sun ? sun.intensity : null;
    cabState.prevFillIntensity = fill ? fill.intensity : null;
    cabState.prevAmbientIntensity = ambient ? ambient.intensity : null;
    if (groundMesh && shouldHideCatchAllGround({
        isUndergroundSession,
        campaignWorldPack,
        openSea,
    })) {
        groundMesh.visible = false;
    }
    if (!isUndergroundSession) return;
    if (scene) {
        const fogColor = new THREE.Color(0x07080b);
        scene.background = fogColor.clone();
        scene.fog = new THREE.Fog(fogColor, 30, 240);
    }
    if (sun) sun.intensity = 0;
    if (fill) fill.intensity = 0;
    if (ambient) ambient.intensity = 0.42 * Math.PI;
}

// A film may author its own fog (core/campaign-cinematics: cinematic.fog).
// A camera 300 m up sees the world's edge as a grey band with a lit ridge
// floating above it; a night sea shot sees the far plane's edge. Pulling fog
// in for the duration of the shot turns both into sky. Restored when the film
// stops framing, and on close. An aerial scene's height-dependent haze
// (world/aerial-view.js) takes the same path whenever no film fog applies.
let filmFogPrevious = null;
function applyCampaignFilmFog(fog) {
    if (!scene || !camera) return;
    const farM = finiteOrNull(fog?.farM);
    const wanted = farM !== null ? fog : null;
    if (wanted) {
        if (!filmFogPrevious) {
            filmFogPrevious = {
                fog: scene.fog ? { color: scene.fog.color.clone(), near: scene.fog.near, far: scene.fog.far } : null,
                cameraFar: camera.far,
            };
        }
        const near = finiteOrNull(wanted.nearM) ?? Math.min(60, farM * 0.1);
        const color = scene.fog?.color?.clone?.() || new THREE.Color(0x87ceeb);
        if (!scene.fog) scene.fog = new THREE.Fog(color, near, farM);
        else { scene.fog.near = near; scene.fog.far = farM; }
        const cameraFar = finiteOrNull(wanted.cameraFarM) ?? Math.max(farM + 200, camera.far);
        if (Math.abs(camera.far - cameraFar) > 0.01) { camera.far = cameraFar; camera.updateProjectionMatrix(); }
        return;
    }
    if (!filmFogPrevious) return;
    scene.fog = filmFogPrevious.fog
        ? new THREE.Fog(filmFogPrevious.fog.color, filmFogPrevious.fog.near, filmFogPrevious.fog.far)
        : null;
    if (Math.abs(camera.far - filmFogPrevious.cameraFar) > 0.01) { camera.far = filmFogPrevious.cameraFar; camera.updateProjectionMatrix(); }
    filmFogPrevious = null;
}

function restoreSessionSceneMode(cabState) {
    if (!cabState) return;
    applyCampaignFilmFog(null);
    if (groundMesh) groundMesh.visible = cabState.prevGroundVisible !== false;
    if (scene) {
        scene.background = cabState.prevSceneBackground || new THREE.Color(0x87ceeb);
        if (cabState.prevSceneFog) {
            scene.fog = new THREE.Fog(
                cabState.prevSceneFog.color.clone(),
                cabState.prevSceneFog.near,
                cabState.prevSceneFog.far,
            );
        } else {
            scene.fog = null;
        }
    }
    if (sun && Number.isFinite(cabState.prevSunIntensity)) sun.intensity = cabState.prevSunIntensity;
    if (fill && Number.isFinite(cabState.prevFillIntensity)) fill.intensity = cabState.prevFillIntensity;
    if (ambient && Number.isFinite(cabState.prevAmbientIntensity)) ambient.intensity = cabState.prevAmbientIntensity;
}

// ─── Mode transitions ──────────────────────────────────────────────────────

function enterCabMode() {
    setMode('cab');
    if (ringMesh) ringMesh.visible = false;
    if (northArrowMesh) northArrowMesh.visible = false;
    if (stationMarker) stationMarker.visible = false;
    resetCameraLook();
    updateDriverControls();
}

// Toggles the machine gun. Used by the keyboard 'G' shortcut, the header
// flower/gun button, and the mobile long-press-on-line-badge Easter egg.
//
// Stowing → simulation mode + 🌸 peace toast. Existing enemies stay in
// the world but their fire logic + new-enemy spawn are gated on
// isGameMode(), so they fall silent automatically and no fresh waves
// appear. Re-equipping flips back to game mode and combat resumes.
// Controllers that mean "the player is riding something they could mount a gun
// on" rather than walking.
const GTA_VEHICLE_CONTROLLER_IDS = new Set(['road', 'boat', 'aircraft']);

function isDrivingGtaVehicle(cabState) {
    return GTA_VEHICLE_CONTROLLER_IDS.has(cabState?.controllerRouter?.activeId || '');
}

// Is the player ON FOOT right now?
//
// Not the same question as `cabState.walkMode`, which holds the walk STATE
// OBJECT and stays truthy for a whole free-roam session — including while you
// are driving a car. Reading the session flag where this question was meant is
// what left the weapon permanently unavailable in every GTA session: the toggle
// bailed out, the header button rendered disabled, and the "Press (G) for guns"
// hint pointed at a key that was being refused. Ask this, never `walkMode`.
// Last on-foot state the header was synced for. Entering or leaving a
// vehicle is the only thing that changes what the weapon toggle can do, and
// nothing else re-syncs the header on that transition.
let headerSyncedOnFoot = null;

function isPlayerOnFoot(cabState) {
    return !!cabState?.walkMode && !isDrivingGtaVehicle(cabState);
}

function toggleWeapon() {
    const cabState = state.cabState;
    if (!cabState) return;
    const intent = weaponToggleIntent({
        onFoot: isPlayerOnFoot(cabState),
        sidearmAvailable: cabState.campaignSidearmAvailable === true,
        weaponAttached: isWeaponAttached(),
        underground: !!cabState.isUndergroundSession,
    });
    if (!intent) return;
    if (intent === 'holster') {
        setCabGameMode(cabState, 'simulation');
        showCabToast(t('weapon.holstered'), 2000);
        return;
    }
    if (intent === 'draw') {
        // The sidearm is hand-held: no vehicle mount, the first-person gun
        // rig. A walking session never preloads the weapon module, so the
        // draw waits for it; a second press before it lands is a no-op.
        if (cabState.sidearmDrawPending) return;
        cabState.sidearmDrawPending = true;
        preloadWeaponRuntime().then(() => {
            if (state.cabState !== cabState) return;
            setCabGameMode(cabState, 'game');
            setWeaponMount(null);
            attachWeapon();
            syncWeaponForCameraMode(cabState);
            showFireButton();
            showCabToast(t('weapon.drawn'), 2000);
            syncHeaderActionButtons(cabState);
        }).catch(error => console.warn('[cab] sidearm draw failed', error))
            .finally(() => { cabState.sidearmDrawPending = false; });
        return;
    }
    if (isWeaponAttached()) {
        // setCabGameMode('simulation') already detaches the weapon, hides
        // the fire button and zeroes the ammo counter — we just announce
        // the transition to the player.
        setCabGameMode(cabState, 'simulation');
        showCabToast(t('weapon.peaceMode'), 2400);
    } else {
        setCabGameMode(cabState, 'game');
        // A gun on a car belongs ON the car. The callback is polled per frame
        // and reads the live session, so it follows the vehicle and falls back
        // to the first-person mounting the moment there is no vehicle.
        setWeaponMount(() => {
            const active = state.cabState;
            if (!active || !isDrivingGtaVehicle(active)) return null;
            // The session reports the top of the vehicle, so the turret sits on
            // a van's roof and a sedan's roof alike rather than a fixed height
            // that buries it in one and floats over the other.
            return active.gtaSession?.getWeaponMountPoint?.() || null;
        });
        attachWeapon();
        // Direct aim pulls the camera into the sights, which is right for a gun
        // held at the eye and wrong for one bolted to a roof you can see.
        setCameraLookDirectAim(!isWeaponMounted());
        showFireButton();
        updateAmmoCounter(getAmmo(), true);
        syncHeaderActionButtons(cabState);
        showCabToast(t('weapon.ready'), 2000);
    }
}

function isGameMode() {
    const cabState = state.cabState;
    return !!cabState && cabState.gameMode === 'game';
}

function syncHeaderActionButtons(cabState) {
    const showWalk = !!cabState
        && !cabState.isUndergroundSession
        && (!cabState.campaignRailClaim || cabState.campaignRailDisembarkEnabled);
    // "Start walk mode" is a session-level action, so it is spent for as long
    // as this IS a walk session. The weapon is not: it belongs to whatever you
    // are riding, so it turns back on the moment you get into a vehicle.
    const enableWalk = showWalk && !cabState.walkMode;
    const enableWeapon = weaponToggleEnabled({
        showWalk,
        onFoot: isPlayerOnFoot(cabState),
        sidearmAvailable: cabState?.campaignSidearmAvailable === true,
    });
    setWalkModeButtonVisible(showWalk);
    setWalkModeButtonEnabled(enableWalk);
    setWeaponToggleButtonVisible(showWalk);
    setWeaponToggleButtonEnabled(enableWeapon);
    setWeaponToggleButtonArmed(!!cabState && cabState.gameMode === 'game' && isWeaponAttached());
}

function getAllowedCameraModes(cabState) {
    return cabState && cabState.isUndergroundSession ? UNDERGROUND_CAMERA_MODES : CAMERA_MODES;
}

// An authored scene is walked at a person's pace; free roam keeps the survey
// speed that makes the city quick to inspect. Called wherever a session takes
// ownership of its campaign scene, and released in closeCab so ordinary walk
// mode can never be left slowed down by a campaign that has ended.
function syncWalkSpeedForCampaign(cabState) {
    setWalkSpeed(cabState?.campaignScene ? STORY_WALK_SPEED_MPS : FREE_ROAM_WALK_SPEED_MPS);
}

function setCabGameMode(cabState, mode) {
    if (!cabState) return;
    const nextMode = cabState.isUndergroundSession && mode === 'game' ? 'simulation' : mode;
    cabState.gameMode = nextMode;
    if (nextMode !== 'game') {
        setWeaponMount(null);
        detachWeapon();
        setWeaponVisible(false);
        setCameraLookDirectAim(false);
        hideFireButton();
        updateAmmoCounter(0, false);
    }
    syncTramHealthBar(cabState);
    syncHeaderActionButtons(cabState);
}

function syncWeaponForCameraMode(cabState) {
    if (!cabState || cabState.gameMode !== 'game' || !isWeaponAttached()) return;
    if (isWeaponMounted()) {
        // Bolted to the vehicle: visible from the chase camera too, and never
        // dragging the view into a first-person sight picture.
        setWeaponVisible(true);
        setCameraLookDirectAim(false);
        return;
    }
    const visible = cabState.cameraMode !== 'third';
    setWeaponVisible(visible);
    setCameraLookDirectAim(visible);
}

function setCameraMode(cabState, mode) {
    const allowedModes = getAllowedCameraModes(cabState);
    const nextMode = allowedModes.includes(mode) ? mode : allowedModes[0];
    cabState.cameraMode = nextMode;
    cabState.thirdPerson = nextMode === 'third';
    syncWeaponForCameraMode(cabState);
    setViewIndicator(nextMode);
}

function cycleCameraMode(cabState) {
    const allowedModes = getAllowedCameraModes(cabState);
    const current = cabState.cameraMode || (cabState.thirdPerson ? 'third' : 'front');
    const idx = allowedModes.indexOf(current);
    const next = allowedModes[(idx + 1 + allowedModes.length) % allowedModes.length];
    setCameraMode(cabState, next);
    const label = next === 'front'
        ? t('view.frontCab')
        : next === 'rear'
            ? t('view.rearCab')
            : t('view.outside');
    showCabToast(label, 1200);
}

function cycleWalkCameraMode(cabState) {
    if (!cabState?.walkMode) return false;
    cabState.walkCameraMode = nextWalkCameraMode(cabState.walkCameraMode);
    showCabToast(t(`walk.view.${cabState.walkCameraMode}`), 1200);
    return true;
}

function cycleActiveGtaCamera(cabState) {
    if (!cabState?.gtaSession) return false;
    return cabState.gtaSession.isDriving()
        ? cabState.gtaSession.cycleCamera()
        : cycleWalkCameraMode(cabState);
}

function showViewHintToast(cabState) {
    if (!cabState || cabState.viewHintShown) return;
    cabState.viewHintShown = true;
    showCabToast(t('view.hint'), 3600);
}

// The health strip belongs to combat. With the gun stowed nothing can hurt the
// tram, so a permanently full green band just eats the top of the view — it
// appears when the weapon is armed (or, defensively, on any damage taken).
function syncTramHealthBar(cabState) {
    if (!cabState || cabState.walkMode || !cabState.tramHealth || cabState.gameMode !== 'game') {
        hideTramHealthBar();
        return;
    }
    updateTramHealthBar(cabState.tramHealth.current, cabState.tramHealth.max);
}

function resetTramHealth(cabState) {
    cabState.tramHealth = {
        current: TRAM_MAX_HEALTH,
        max: TRAM_MAX_HEALTH,
        criticalAnnounced: false,
        disabledAnnounced: false,
    };
    syncTramHealthBar(cabState);
}

function damagePlayerTram(amount) {
    const cabState = state.cabState;
    if (!cabState || !cabState.tramHealth) return;
    if (!Number.isFinite(amount) || amount <= 0) return;
    // Nothing can hit a tram the player is not in. The campaign reaches its
    // Zagreb chapters through a rail session, so tramHealth is still on the
    // cab state when the story hands the player over to the street on foot;
    // damaging it there drained a nameless bar across the top of a chase in
    // which the player has no tram at all.
    if (cabState.walkMode) return;

    const health = cabState.tramHealth;
    const before = health.current;
    health.current = Math.max(0, health.current - amount);
    syncTramHealthBar(cabState);

    // Hit feedback: orange impact flash + smoke puff at a random spot
    // on the player tram's roof. The mesh position is set every frame
    // from the cab pose (even when invisible in first-person), so we
    // can read it here without caring about camera mode.
    const ptm = cabState.playerTramMesh;
    if (ptm) {
        const heading = -ptm.rotation.y;
        const along = (Math.random() - 0.5) * 11;   // ±5.5 m along body
        const fx = ptm.position.x + Math.sin(heading) * along;
        const fz = ptm.position.z + Math.cos(heading) * along;
        const fy = ptm.position.y + 3.0;
        spawnFireFlashAt(fx, fy, fz);
    }

    if (before > 0 && health.current <= 0 && !health.disabledAnnounced) {
        health.disabledAnnounced = true;
        showCabToast(t('tram.disabled'), 2600);
    } else if (before > health.max * 0.25 && health.current <= health.max * 0.25 &&
        !health.criticalAnnounced) {
        health.criticalAnnounced = true;
        showCabToast(t('tram.criticalDamage'), 2200);
    }
}

// Per-frame smoke for the player's own tram once it's been damaged. Mirrors
// the tram.js emitTramDamageSmoke logic but reads cabState.tramHealth and
// emits at cabState.playerTramMesh.position. Lazy-allocates a small
// per-cabState accumulator on the cabState itself.
function emitPlayerTramDamageSmoke(cabState, dt) {
    const health = cabState.tramHealth;
    if (!health || health.current >= health.max) return;
    const ptm = cabState.playerTramMesh;
    if (!ptm) return;

    const ratio = health.current / health.max;
    const PLAYER_SMOKE_THRESHOLD = 0.7;
    if (ratio >= PLAYER_SMOKE_THRESHOLD) return;
    const intensity = (PLAYER_SMOKE_THRESHOLD - ratio) / PLAYER_SMOKE_THRESHOLD;
    const interval = 0.8 / (1.0 + intensity);

    cabState.playerSmokeAccum = (cabState.playerSmokeAccum || 0) + dt;
    if (cabState.playerSmokeAccum < interval) return;
    cabState.playerSmokeAccum = 0;

    const heading = -ptm.rotation.y;
    const along = (Math.random() - 0.5) * 10;
    const sx = ptm.position.x + Math.sin(heading) * along;
    const sz = ptm.position.z + Math.cos(heading) * along;
    const sy = ptm.position.y + 3.1;
    spawnSmokeAt(sx, sy, sz);
}

function stopIdentity(stop) {
    if (!stop) return '';
    if (stop.stopId != null) return `id:${stop.stopId}`;
    return `${stop.name || ''}:${Number(stop.lat).toFixed(6)}:${Number(stop.lng ?? stop.lon).toFixed(6)}`;
}

function findClosestStopWithinBand(pose, stops, maxDistanceM) {
    let best = null;
    let bestDistance = maxDistanceM;
    for (const stop of stops || []) {
        const stopLat = Number(stop.lat);
        const stopLon = Number(stop.lng ?? stop.lon);
        if (!Number.isFinite(stopLat) || !Number.isFinite(stopLon)) continue;
        const dist = haversineMeters(pose.lat, pose.lon, stopLat, stopLon);
        if (dist <= bestDistance) {
            bestDistance = dist;
            best = stop;
        }
    }
    return best;
}

function findPlayerStopGuide(cabState, pose) {
    if (!cabState || !pose || !cabState.driver || !cabState.driver.enabled) return null;
    const stops = cabState.allStops || [];
    if (stops.length === 0) return null;
    const poseLocal = geoToLocal(pose.lon, pose.lat, cabState.anchorLon, cabState.anchorLat);
    const headingRad = (Number(pose.headingDeg) || 0) * Math.PI / 180;
    const forwardDirX = Math.sin(headingRad);
    const forwardDirZ = -Math.cos(headingRad);
    const rightDirX = Math.cos(headingRad);
    const rightDirZ = Math.sin(headingRad);
    let best = null;
    for (const stop of stops) {
        const stopLat = Number(stop.lat);
        const stopLon = Number(stop.lng ?? stop.lon);
        if (!Number.isFinite(stopLat) || !Number.isFinite(stopLon)) continue;
        const stopLocal = geoToLocal(stopLon, stopLat, cabState.anchorLon, cabState.anchorLat);
        const dx = stopLocal.x - poseLocal.x;
        const dz = stopLocal.z - poseLocal.z;
        const directDistanceM = Math.hypot(dx, dz);
        const inBand = directDistanceM <= PLAYER_STOP_BAND_RADIUS_M;
        const forwardMeters = dx * forwardDirX + dz * forwardDirZ;
        const lateralMeters = dx * rightDirX + dz * rightDirZ;
        if (!inBand) {
            if (forwardMeters < -PLAYER_STOP_BAND_RADIUS_M || forwardMeters > PLAYER_STOP_GUIDE_MAX_FORWARD_M) continue;
            if (Math.abs(lateralMeters) > PLAYER_STOP_GUIDE_MAX_LATERAL_M) continue;
        }
        const score = (inBand ? -20 : Math.max(0, forwardMeters))
            + Math.abs(lateralMeters) * 0.35
            + directDistanceM * 0.15;
        if (!best || score < best.score) {
            best = {
                name: stop.name || '',
                stop,
                inBand,
                remainingDistanceM: Math.max(0, directDistanceM - PLAYER_STOP_BAND_RADIUS_M),
                score,
            };
        }
    }
    return best;
}

function randomInclusiveInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
}

// ─── Door service loop ──────────────────────────────────────────────────
// Doors are the gate between "stopped near a platform" and "exchanging
// passengers": the exchange only fires once they are fully open, and the
// throttle is interlocked while they are anywhere but closed. Manual
// driving toggles them with E / the 🚪 console button; the driver-graph
// autopilot opens them for its dwell; schedule rides mirror status.paused.
const DOOR_ANIM_RATE = 1.6;               // full open/close ≈ 0.6 s
const DOOR_OPEN_MAX_SPEED_MPS = 0.4;      // may only open when practically stopped
const DOOR_INTERLOCK_RATIO = 0.05;        // "closed enough to depart"

function setPlayerDoorsTarget(cabState, open) {
    const doors = cabState && cabState.doors;
    if (!doors || doors.open === open) return;
    doors.open = open;
    if (open) playDoorOpen(); else playDoorClose();
    setDashboardDoorState(open);
}

function togglePlayerDoors() {
    const cabState = state.cabState;
    if (!cabState || !cabState.doors || cabState.walkMode) return;
    const ds = cabState.driver;
    // Manual doors only make sense when the player holds the controls;
    // autopilot and schedule rides run their own door cycle.
    if (!ds || !ds.enabled || ds.autopilot) return;
    if (!cabState.doors.open && Math.abs(ds.speed || 0) > DOOR_OPEN_MAX_SPEED_MPS) {
        showCabToast(t('doors.stopFirst'), 1800);
        return;
    }
    setPlayerDoorsTarget(cabState, !cabState.doors.open);
}

// An authored campaign train is handed over parked: the brake is on and the
// throttle is dead until the driver releases it. That is the whole point of the
// departure checklist, so it toasts the reason exactly like the door interlock.
function throttleBlockedByParkingBrake(cabState) {
    if (!cabState?.parkingBrake) return false;
    showCabToast(t('brake.releaseFirst'), 1800);
    return true;
}

function setParkingBrake(cabState, applied) {
    if (!cabState) return;
    const next = !!applied;
    if (cabState.parkingBrake === next) return;
    cabState.parkingBrake = next;
    setDashboardParkingBrakeState(next);
    showCabToast(t(next ? 'brake.applied' : 'brake.released'), 1500);
}

function togglePlayerParkingBrake() {
    const cabState = state.cabState;
    if (!cabState || cabState.walkMode || cabState.parkingBrake === undefined) return;
    const ds = cabState.driver;
    // Applying the brake at speed is not a stopping device; it is the handbrake
    // of a parked train, so it only engages once the train is standing.
    if (!cabState.parkingBrake && Math.abs(ds?.speed || 0) > DOOR_OPEN_MAX_SPEED_MPS) {
        showCabToast(t('brake.stopFirst'), 1800);
        return;
    }
    setParkingBrake(cabState, !cabState.parkingBrake);
}

// True (and toasts why) when forward throttle must be refused.
function throttleBlockedByDoors(cabState) {
    const doors = cabState && cabState.doors;
    if (!doors || doors.ratio <= DOOR_INTERLOCK_RATIO) return false;
    showCabToast(t('doors.closeFirst'), 1600);
    return true;
}

// Per-frame: resolve the door target for non-manual rides and animate the
// ratio toward it, driving the player tram's door meshes.
function updatePlayerDoors(cabState, pose, dt) {
    const doors = cabState && cabState.doors;
    if (!doors) return;
    if (!cabState.driver || !cabState.driver.enabled) {
        // Schedule-autopilot ride: the source dwell clock owns departure.
        // Close shortly before it expires so movement and door interlock agree.
        setPlayerDoorsTarget(cabState, shouldAutomaticDoorsRemainOpen(pose.status));
    } else if (doors.open && Math.abs(cabState.driver.speed || 0) > 1.5) {
        // Safety: should the tram ever move with doors open, close them.
        setPlayerDoorsTarget(cabState, false);
    }
    const target = doors.open ? 1 : 0;
    if (doors.ratio !== target) {
        const step = DOOR_ANIM_RATE * Math.max(0, dt || 0);
        doors.ratio = target > doors.ratio
            ? Math.min(target, doors.ratio + step)
            : Math.max(target, doors.ratio - step);
        if (cabState.playerTramMesh) setTramDoorsOpen(cabState.playerTramMesh, doors.ratio);
    }
}

function updatePlayerServiceStop(cabState, pose) {
    const service = cabState && cabState.playerService;
    if (!service || !cabState.driver || !cabState.driver.enabled || !pose) return;
    const speedMps = Math.abs(cabState.driver.speed || 0);
    const stop = speedMps <= PLAYER_STOPPED_SPEED_MPS
        ? findClosestStopWithinBand(pose, cabState.allStops, PLAYER_STOP_BAND_RADIUS_M)
        : null;
    if (!stop) {
        service.activeStopKey = null;
        return;
    }
    const status = pose.status || (pose.status = {});
    status.paused = true;
    status.stationName = stop.name || status.stationName || null;
    // Passengers only move through OPEN doors: stopping at the platform
    // shows the stop, but the exchange waits for the door cycle. Gate on
    // the commanded state + past the interlock (not "fully open") — door
    // animation runs on clamped frame dt, so on slow devices a fully-open
    // gate could miss the whole wall-clock dwell.
    if (!cabState.doors || !cabState.doors.open || cabState.doors.ratio <= DOOR_INTERLOCK_RATIO) {
        status.lastBoarded = service.lastBoarded;
        status.lastAlighted = service.lastAlighted;
        return;
    }
    const stopKey = stopIdentity(stop);
    if (service.activeStopKey === stopKey) {
        status.lastBoarded = service.lastBoarded;
        status.lastAlighted = service.lastAlighted;
        return;
    }
    service.activeStopKey = stopKey;

    const alightCap = Math.min(service.totalPassengers, PLAYER_STOP_MAX_ALIGHT);
    const alighted = alightCap > 0
        ? randomInclusiveInt(Math.min(PLAYER_STOP_MIN_ALIGHT, alightCap), alightCap)
        : 0;
    service.totalPassengers = Math.max(0, service.totalPassengers - alighted);

    const boardCap = Math.min(service.capacity - service.totalPassengers, PLAYER_STOP_MAX_BOARD);
    const boarded = boardCap > 0
        ? randomInclusiveInt(Math.min(PLAYER_STOP_MIN_BOARD, boardCap), boardCap)
        : 0;
    service.totalPassengers = Math.min(service.capacity, service.totalPassengers + boarded);
    service.balanceEur += boarded * PLAYER_FARE_EUR;
    service.lastBoarded = boarded;
    service.lastAlighted = alighted;

    status.lastBoarded = boarded;
    status.lastAlighted = alighted;
    triggerBoardingBurst(
        { lat: pose.lat, lon: pose.lon, headingDeg: pose.headingDeg || 0 },
        stop,
        {
            boardCount: boarded,
            alightCount: alighted,
            boardingOrigins: getPlatformWaitingPeople(stop),
        },
    );
}

function updateTrainPlatformExchange(cabState, pose) {
    if (!cabState?.isTrainSession || !pose) return;
    const status = pose.status || {};
    if (!status.paused) {
        if (cabState.trainPlatformExchangeStopKey != null) {
            cabState.trainPlatformExchangeStopKey = null;
            setPlatformWaitingPeopleVisible(true);
        }
        return;
    }
    const stop = findClosestStopWithinBand(pose, cabState.allStops, 14);
    if (!stop) return;
    // Platform people are rebuilt as surrounding tiles change, so enforce
    // the dwell state every frame rather than only on the arrival edge.
    const waitingPeople = getPlatformWaitingPeople(stop);
    setPlatformWaitingPeopleVisible(false, stop);
    if (waitingPeople.length === 0) return;
    const stopKey = stopIdentity(stop);
    if (cabState.trainPlatformExchangeStopKey === stopKey) return;
    cabState.trainPlatformExchangeStopKey = stopKey;
    triggerBoardingBurst(
        { id: 'player-train', lat: pose.lat, lon: pose.lon, headingDeg: pose.headingDeg || 0 },
        stop,
        {
            boardCount: waitingPeople.length,
            alightCount: 10,
            boardingOrigins: waitingPeople,
            bodyWidthM: 2.885,
            carPoses: pose.articulatedCars,
            // The model has two doors per car at these exact local offsets.
            doorOffsetsZ: [-9.35, 9.35],
        },
    );
}

// The world streams from the API tile by tile. When that dies, the city simply
// stops appearing — and the player has no way to tell a quiet neighbourhood from
// a broken backend. The tile sources retry on their own now; this says so.
let lastDegradedCount = 0;
onTileStreamHealth((labels) => {
    const count = labels.length;
    if (count > 0 && lastDegradedCount === 0) {
        showCabToast('Podaci grada se ne učitavaju — pokušavam ponovno…', 4000);
    } else if (count === 0 && lastDegradedCount > 0) {
        showCabToast('Podaci grada su opet dostupni.', 2400);
    }
    lastDegradedCount = count;
});

function runCabEntryFlow(cabState) {
    if (!cabState) return;
    if (cabState.walkMode || cabState.isUndergroundSession) {
        setCabGameMode(cabState, 'simulation');
        setCameraMode(cabState, 'front');
        showViewHintToast(cabState);
        setCampaignButtonVisible(true);
        setCampaignButtonEnabled(true);
        syncHeaderActionButtons(cabState);
        return;
    }
    // Gun stowed by default: setCabGameMode('simulation') detaches the
    // weapon, hides the fire button, and zeroes the ammo counter, so the
    // player starts on a calm autopilot ride until they choose to arm.
    setCabGameMode(cabState, 'simulation');
    setCameraMode(cabState, 'front');
    showViewHintToast(cabState);
    // Cab opens in autopilot — the tram drives itself, the 🤖 header
    // icon shows engaged, and the player takes over only when they
    // tap a direction key / on-screen control. Previously this auto-
    // called enableDriverMode() which dropped them straight into manual
    // and bypassed the autopilot UX entirely.
    updateDriverControls();
    setCampaignButtonVisible(true);
    setCampaignButtonEnabled(true);
    syncHeaderActionButtons(cabState);
}

function getCurrentCabPose(cabState) {
    if (!cabState) return null;
    if (cabState.driver && cabState.driver.enabled && cabState.driverGraph) {
        return computeControlledRailPose(cabState);
    }
    if (typeof cabState.poseFn === 'function') {
        const pose = cabState.poseFn();
        if (pose) return pose;
    }
    return cabState.lastAutoPose || null;
}

function computeControlledRailPose(cabState) {
    if (!cabState?.driver || !cabState.driverGraph) return null;
    return computeDriverPose(cabState.driver, cabState.driverGraph, {
        articulatedCarOffsetsM: cabState.isTrainSession
            ? TRAIN_CAR_CENTER_OFFSETS_M
            : null,
        switchRules: cabState.switchRules,
    });
}

function railSurfaceStreamingFocus(cabState, local, pose) {
    if (!cabState?.driver?.enabled || !cabState.driverGraph) return null;
    return routedVehicleSurfaceStreamingFocus({
        local,
        speedMps: cabState.driver.speed,
        headingDeg: pose?.headingDeg,
        sampleRouteLocal(offsetM) {
            const sampledState = sampleDriverStateAtOffset(
                cabState.driver,
                cabState.driverGraph,
                offsetM,
                cabState.switchRules,
            );
            if (!sampledState) return null;
            const sampledPose = computeDriverPose(sampledState, cabState.driverGraph, {
                switchRules: cabState.switchRules,
            });
            const sampledLocal = geoToLocal(
                sampledPose.lon,
                sampledPose.lat,
                cabState.anchorLon,
                cabState.anchorLat,
            );
            return { ...sampledLocal, headingDeg: sampledPose.headingDeg };
        },
    });
}

function transitionRailCabToWalk(cabState, {
    pose,
    headingDeg,
    pitchDeg,
    groundY,
}) {
    if (!cabState || cabState.walkMode || !pose || !Number.isFinite(groundY)) return false;

    const walkState = createWalkState(pose.lat, pose.lon, {
        initialY: groundY + CAB_WALK_AIRDROP_HEIGHT_M,
        initialGroundY: groundY,
        initialVerticalVelocity: CAB_WALK_AIRDROP_VY_MPS,
    });
    walkState.yaw = headingDeg * DEG_TO_RAD;

    // Cab and walk are two controllers over the same place, not two different
    // worlds. Reopening Station3D here used to discard a complete rail/terrain
    // generation and build a second one with the walk preset's local OSM rail
    // subscription. At Split that took the full 120 s readiness timeout and
    // replaced the ridden line's 3-alignments/3-tunnels snapshot with a
    // 14-alignments/4-tunnels snapshot, visibly changing the tunnel portals.
    // Keep the published world and change only player/controller ownership.
    if (cabState.playerTramMesh && !cabState.playerTramMeshBorrowed) {
        cabState.playerTramMesh.parent?.remove(cabState.playerTramMesh);
        disposeGroup(cabState.playerTramMesh);
    }
    cabState.playerTramMesh = null;
    cabState.playerTramMeshBorrowed = false;
    if (!cabState.playerWalkerAvatar) {
        cabState.playerWalkerAvatar = createPlayerWalkerAvatar();
        scene.add(cabState.playerWalkerAvatar);
    }

    const walkPreset = resolveFreeRoamPreset('walk');
    cabState.walkMode = walkState;
    cabState.walkCameraMode = 'first';
    cabState.cameraMode = 'front';
    cabState.sessionPresetId = walkPreset.id;
    cabState.sessionCapabilities = walkPreset.capabilities;
    cabState.isTrainSession = false;
    cabState.railMode = '';
    cabState.trackGaugeMm = null;
    cabState.routeDirectionLabel = '';
    cabState.driver = null;
    cabState.doors = null;
    cabState.poseFn = () => ({
        lat: walkState.lat,
        lon: walkState.lon,
        headingDeg: walkState.yaw / DEG_TO_RAD,
    });
    cabState.lastAutoPose = cabState.poseFn();
    cabState.lastRenderedPose = snapshotCabPose(cabState.lastAutoPose);
    cabState.smoothedHeading = null;
    cabState.smoothedPitch = null;
    cabState.speedProbe = null;
    cabState.probeSpeedKmh = 0;
    cabState.walkPedestriansEnabled = false;
    forceOccupantOnFoot(cabState.occupant);
    clearWalkKeys();
    setCameraLookInstant(0, pitchDeg * DEG_TO_RAD);

    // Layers which consult the live session context should see the same mode
    // as the controller. No layer is restarted: the already-published rail,
    // ground, buildings and tunnel structures remain the authoritative set.
    if (cabState.layerCtx) cabState.layerCtx.sessionCapabilities = walkPreset.capabilities;
    setTrafficSessionCapabilities(walkPreset.capabilities);
    setDecorSessionCapabilities(walkPreset.capabilities);
    setPedestrianFreeRoamEnabled(false);
    setPedestriansEnabled(false);
    cabState.controllerRouter?.activate('foot', cabState, 'rail-cab-walk');

    setCabGameMode(cabState, 'simulation');
    setDashboardVisible(false);
    setDashboardAltitudeVisible(false);
    setDashboardDoorHandler(null);
    setDashboardBellHandler(null);
    setDashboardParkingBrakeHandler(null);
    setDashboardDoorState(false);
    stopEngineWhine();
    stopTrackClangs();
    stopTramSounds();
    stopStationPa();
    stopStationCrowd();
    hideViewButton();
    startWalkAudio();
    setWalkJetpackAvailable(walkState.jetpackAllowed !== false);
    ensureWalkControls();
    setWalkControlsMode('walk', {
        onInteract: () => interactWithWorld(state.cabState)
            || state.cabState?.onCampaignInteract?.(getCabSessionSnapshot()),
    });
    showWalkControls();
    beginMinimapSession({
        driverGraph: cabState.driverGraph,
        otherTracks: cabState.walkLaunchOptions?.otherTracks || [],
        allStops: cabState.allStops || [],
        anchorLat: cabState.anchorLat,
        anchorLon: cabState.anchorLon,
        walkMode: true,
        navigationTarget: cabState.navigationTarget || null,
        campaignActive: false,
    });
    renderCabTitle(t('title.walk'), null);
    setControlsHintHandler(() => showCabToast(t('walk.controlsHint'), 7000));
    setControlsHintButtonVisible(true);
    setCampaignButtonVisible(true);
    setCampaignButtonEnabled(true);
    syncHeaderActionButtons(cabState);
    showCabToast(t('walk.controlsHint'), 5200);
    // The train handed us a complete world, not a quiet inspection scene.
    // Promote that same live session to the established GTA/free-roam preset:
    // traffic, pedestrians and ambient rail resume, special boats/aircraft are
    // installed, and their controller providers become enterable. This remains
    // asynchronous so the walker is usable immediately while optional vehicle
    // modules finish loading; enterFreeRoam guards against a closed session.
    void enterFreeRoam().catch((error) => {
        console.warn('[cab] train-to-free-roam activation failed', error);
    });
    return true;
}

function enterWalkModeFromCab(cabState) {
    if (!cabState || cabState.walkMode || cabState.isUndergroundSession) return;
    if (cabState.campaignRailClaim) {
        if (!cabState.campaignRailDisembarkEnabled) return;
        const transitioned = transitionCampaignTrainToGta({
            campaignScene: cabState.campaignScene,
            campaignDefinition: cabState.campaignDefinition,
            onCampaignInteract: cabState.onCampaignInteract,
            disembark: cabState.campaignScene?.authored?.manualRailDisembark || {},
            navigationTarget: cabState.navigationTarget,
        });
        if (!transitioned) showCabToast(t('campaign.trainExitRequiresStop'), 3600);
        return;
    }
    const pose = getCurrentCabPose(cabState);
    if (!pose) return;
    const look = getCameraLook();
    const headingDeg = ((pose.headingDeg || 0) + look.yaw * (180 / Math.PI) + 360) % 360;
    const pitchDeg = clamp(look.pitch * (180 / Math.PI), -60, 60);
    const relativeHeightM = Number(pose.y) || 0;
    const local = cabState.photoTrackFrame
        ? cabState.photoTrackFrame.toScene(pose.lon, pose.lat, relativeHeightM)
        : geoToLocal(pose.lon, pose.lat, cabState.anchorLon, cabState.anchorLat);
    const photoHandoff = resolvePhotoHandoffState({
        frame: cabState.photoTrackFrame,
        registration: getPhotorealRegistration(),
        lon: pose.lon,
        lat: pose.lat,
        relativeHeightM,
    });
    // Reuse the cab's fixed tangent frame and resolved Google seat. Re-anchoring
    // and re-raycasting here made walk mode a second, locally different datum.
    const groundY = photoHandoff?.groundY ?? getRooftopY(local.x, local.z);
    if (!Number.isFinite(groundY)) return;
    transitionRailCabToWalk(cabState, {
        pose,
        headingDeg,
        pitchDeg,
        groundY,
    });
}

// Wires building count → modal info row once, then HUD + driver controls +
// keyboard. Safe to call on every open — everything inside is idempotent.
export function initCabMode() {
    ensureHud();
    // Mobile fire button: pointerdown/up routes through setWeaponFiring,
    // exactly mirroring the desktop spacebar handler.
    setFireButtonHandlers(
        () => { if (isGameMode()) setWeaponFiring(true); },
        () => setWeaponFiring(false),
    );
    // Mobile (C) view-cycle button: same effect as the keyboard C key,
    // just a tap target above the gun. Available whenever a cab is open;
    // works in both simulation and game modes.
    setViewButtonHandler(() => {
        const cabState = state.cabState;
        if (!cabState || cabState.walkMode) return;
        cabState.controllerRouter?.handleAction(SESSION_ACTIONS.CAMERA, 'press');
    });
    // Header campaign button delegates to the generic director facade. The
    // director can start or continue from any Station3D mode.
    setCampaignButtonHandler(() => {
        window.Station3D?.campaigns?.openMenu?.();
    });
    setWalkModeButtonHandler(() => {
        const cabState = state.cabState;
        if (!cabState) return;
        enterWalkModeFromCab(cabState);
    });
    setWeaponToggleButtonHandler(() => {
        toggleWeapon();
    });
    // Header 🤖 autopilot icon: status indicator while autopilot is
    // driving (clicking is a no-op then), and a "hand back to autopilot"
    // toggle once the player has taken manual control. updateDriverControls
    // also flips the disabled/engaged styling so this matches.
    setAutopilotButtonHandler(() => {
        const cs = state.cabState;
        if (!cs) return;
        if (cs.driver && cs.driver.enabled) {
            disableDriverMode();
        }
    });
    // Hidden Easter egg on mobile: hold the line-number badge in the cab
    // title for 5 s to summon (or stow) the machine gun.
    setLineBadgeLongPressHandler(() => toggleWeapon(), 5000);
    ensureDriverControls({
        onEnter: () => { enableDriverMode(); updateDriverControls(); },
        onThrottle: (phase, direction) => {
            const cabState = state.cabState;
            if (!cabState) return;
            if (cabState.campaignRailDerail) return;
            // Auto-engage manual control on first throttle press. Two
            // sub-cases: no driver state at all (schedule autopilot →
            // create one with current speed), or driver-graph autopilot
            // already running (just clear the autopilot flag so the
            // player's input takes effect this frame).
            if (!cabState.driver || !cabState.driver.enabled) {
                enableDriverMode();
            } else if (cabState.driver.autopilot) {
                cabState.driver.autopilot = false;
            }
            const ds = cabState.driver;
            if (!ds || !ds.enabled) return;
            if (phase === 'start') {
                if (direction > 0
                    && (throttleBlockedByParkingBrake(cabState) || throttleBlockedByDoors(cabState))) return;
                ds.throttleTarget = direction;
            } else if (phase === 'end') {
                if ((direction > 0 && ds.throttleTarget > 0) ||
                    (direction < 0 && ds.throttleTarget < 0)) {
                    ds.throttleTarget = 0;
                }
            }
            updateDriverControls();
        },
        onArmTurn: (direction) => {
            const cabState = state.cabState;
            if (!cabState) return;
            if (cabState.campaignRailDerail) return;
            if (!cabState.driver || !cabState.driver.enabled) {
                enableDriverMode();
            } else if (cabState.driver.autopilot) {
                cabState.driver.autopilot = false;
            }
            const ds = cabState.driver;
            if (!ds || !ds.enabled) return;
            // Each click unconditionally ARMS the chosen direction. Same-
            // direction clicks are no-ops; opposite-direction clicks swap.
            // The arm clears only when the turn actually fires (driverStep)
            // — there's no time-based decay and the button stays blue
            // until that happens.
            ds.armedTurn = direction;
            updateDriverControls();
        },
    });
    if (!keysBound) bindKeyboard();
    // Shift+click inspects any scene surface, opens the docked diagnostics
    // panel, and lets the user peel world layers away without rebuilding them.
    if (renderer && renderer.domElement) {
        attachInspector({
            camera,
            scene,
            domElement: renderer.domElement,
            getAnchor: () => ({
                lat: state.cabState?.anchorLat,
                lon: state.cabState?.anchorLon,
            }),
            getTerrain: () => state.cabState?.terrain || null,
            getCivilGround: () => state.cabState?.civilGround || null,
            getGroundPaint: () => state.cabState?.groundPaint || null,
            getRenderOrigin: () => getRenderOrigin(),
            getGroundOwnershipMaskDiagnostics: () => groundOwnershipMaskDiagnostics(),
            getSurfacePublications: () => state.cabState?.surfacePublications || null,
            // These masks describe the authored model-terrain shader. Photo
            // worlds and underground sessions use different ground systems,
            // so reporting the current location's base terrain style there
            // would be a plausible-looking but false diagnostic.
            describePoint: (x, z) => (
                isPhotoWorld() || state.cabState?.isUndergroundSession
                    ? []
                    : inspectGroundSurfaceMaterialAtLocal(x, z)
            ),
            describeHit: (hit) => {
                const photoGround = getPhotorealGroundGroup();
                let object = hit?.object || null;
                while (object && object !== photoGround) object = object.parent;
                if (!photoGround || object !== photoGround || !hit?.point) return null;
                if (!isPhotorealGhostGround(hit.point.x, hit.point.y, hit.point.z)) return {
                    renderRole: 'visible color surface',
                    shaderDiscarded: false,
                    source: 'world/photoreal.js · streamed source surface',
                };
                return {
                    renderRole: 'shader-discarded photoreal source geometry',
                    shaderDiscarded: true,
                    source: 'world/photoreal.js · CPU twin of corridor/station discard mask',
                };
            },
        });
        // window.__s3dShoreAudit(): does paved ground meet the sea with a face
        // or ramp into it (core/shore-formation-audit.js). The hierarchy audit
        // below cannot see that: a flat apron under the sea stacks correctly.
        installShoreAudit({
            scene, camera,
            getQuadsNear: mappedCoastCollarQuadsNear,
            getSeaY: mappedSeaSurfaceSceneY,
            pavedAt: pedestrianZoneAtLocal,
        });
        // window.__s3dSurfaceAudit(): ground-hierarchy audit over a plan grid
        // around the camera (core/surface-audit.js), so artefacts are found by
        // measurement instead of screenshots.
        installSurfaceAudit({
            camera,
            scene,
            getGroundPaint: () => state.cabState?.groundPaint || null,
            getSurfacePublications: () => state.cabState?.surfacePublications || null,
            getGroundReadiness: bounds => {
                const points = auditTilePoints(bounds);
                const sources = state.cabState?.sharedTileSession?.getAuditCoverage(bounds,
                    ['roads:cab', 'roads:graph', 'roads:curbs', 'roads:lane-markings', 'roads:vertical-alignments'])
                    || { pending: 1, failed: 0, sources: [] };
                const curbs = getCurbAuditReadiness(bounds);
                const unpublished = points.filter(point => !isTerrainTilePublishedAtLocal(point.x, point.z)
                    || !isRenderedRoadTilePublishedAtLocal(point.x, point.z)).map(point => point.key);
                const railsReady = isRailSurfacePreloadSettled({ points });
                const paint = state.cabState?.groundPaint?.snapshot() || null;
                const decor = getDecorReadinessSnapshot();
                const physics = state.cabState?.gtaSession?.groundPublicationState?.() || null;
                const pending = sources.pending + curbs.pending + unpublished.length + (railsReady ? 0 : 1)
                    + (paint?.pending ? 1 : 0) + (physics?.pending || 0)
                    + decor.pending + (decor.initialized ? 0 : 1);
                const failed = sources.failed + curbs.failed + (paint?.failures || 0) + (physics?.failed || 0) + decor.failed;
                return { ready: pending === 0 && failed === 0, pending, failed, sources, curbs, unpublished, railsReady, paint, physics, decor };
            },
            getAnchor: () => ({
                lat: state.cabState?.anchorLat,
                lon: state.cabState?.anchorLon,
            }),
            getTerrain: () => state.cabState?.terrain || null,
            getFormationModels: () => {
                const terrain = state.cabState?.terrain;
                return Array.from(new Set([
                    terrain?.roadFormation,
                    terrain?.railFormation,
                    terrain?.renderedRailSurface,
                    state.cabState?.roadFormation,
                ].filter(Boolean)));
            },
        });
        // Alt+click a building → open it in Google Street View (exact pano for
        // buildings with detected-window data, nearest viewpoint otherwise).
        attachStreetViewLink({
            camera,
            domElement: renderer.domElement,
            getBuildingsGroup,
            getAnchor: () => ({
                lat: state.cabState && state.cabState.anchorLat,
                lon: state.cabState && state.cabState.anchorLon,
            }),
        });
    }
}

// Normalises a KeyboardEvent to a lowercase movement token. Reads e.code first
// ('ArrowUp', 'KeyW', …) so IME / layout quirks can't mask the physical key,
// falling back to e.key for completeness.
function keyTokenFor(e) {
    const code = e.code || '';
    if (code === 'ArrowUp')    return 'arrowup';
    if (code === 'ArrowDown')  return 'arrowdown';
    if (code === 'ArrowLeft')  return 'arrowleft';
    if (code === 'ArrowRight') return 'arrowright';
    if (code === 'KeyW') return 'w';
    if (code === 'KeyA') return 'a';
    if (code === 'KeyS') return 's';
    if (code === 'KeyD') return 'd';
    if (code === 'KeyV') return 'v';
    if (code === 'KeyC') return 'c';
    if (code === 'KeyE') return 'e';
    if (code === 'KeyH') return 'h';
    if (code === 'KeyP') return 'p';
    if (code === 'KeyR') return 'r';
    return (e.key || '').toLowerCase();
}

// Screenshot-friendly pause: the scene keeps rendering (so camera look,
// view switching and asynchronous tile completion remain responsive), while
// cabStep feeds zero elapsed time to every physical/animated subsystem. The
// shared clock is paused too so schedule-driven trams cannot move underneath
// the frozen player. Restoring the clock honours a pre-existing UI pause.
function snapshotCabPose(pose) {
    if (!pose) return null;
    const status = pose.status ? { ...pose.status } : null;
    if (status && status.nextStation) status.nextStation = { ...status.nextStation };
    if (status && status.stopGuide) status.stopGuide = { ...status.stopGuide };
    return {
        ...pose,
        ...(status ? { status } : {}),
    };
}

function setCabSimulationPaused(cabState, paused, { showToast = true } = {}) {
    if (!cabState || !!cabState.simPaused === !!paused) return;
    const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const simClock = window.simClock;

    if (paused) {
        cabState.simPaused = true;
        cabState.simPauseStartedMs = nowMs;
        // Freeze the exact pose already drawn on screen. Schedule-backed
        // trams have their own wall-clock physics source, so dt=0 alone does
        // not guarantee that polling poseFn returns the same coordinates.
        cabState.simPausedPose = snapshotCabPose(
            cabState.lastRenderedPose || cabState.lastAutoPose
        );
        cabState.clockWasPausedBeforeCabPause = !!(
            simClock && typeof simClock.isPaused === 'function' && simClock.isPaused()
        );
        if (simClock && typeof simClock.setPaused === 'function') simClock.setPaused(true);
        // A held fire input must not queue shots for the resume frame.
        setWeaponFiring(false);
        cabState.gtaSession?.clearControls?.();
        clearWalkKeys();
        if (showToast) showCabToast(t('simulation.paused'), 1800);
        return;
    }

    const pausedMs = Math.max(0, nowMs - (cabState.simPauseStartedMs || nowMs));
    // Autopilot station dwell uses a wall-clock deadline. Move it forward by
    // the paused duration so a ten-second stop remains ten simulated seconds.
    if (Number.isFinite(cabState.autopilotStopWaitUntil)) {
        cabState.autopilotStopWaitUntil += pausedMs;
    }
    // Rebase a wall-clock pose source before releasing the frozen snapshot.
    // This covers a backgrounded tab where no paused render frames ran.
    if (!(cabState.driver && cabState.driver.enabled) && typeof cabState.poseFn === 'function') {
        cabState.poseFn({ paused: true });
    }
    cabState.simPaused = false;
    cabState.simPauseStartedMs = 0;
    cabState.simPausedPose = null;
    cabState.lastFrameMs = nowMs;
    cabState.speedProbe = null;
    if (!cabState.clockWasPausedBeforeCabPause && simClock && typeof simClock.setPaused === 'function') {
        simClock.setPaused(false);
    }
    cabState.clockWasPausedBeforeCabPause = false;
    if (showToast) showCabToast(t('simulation.resumed'), 1200);
}

function gtaInteractionLocal(cabState) {
    const latestPose = cabState?.lastRenderedPose || cabState?.lastAutoPose;
    if (cabState?.lastLocal) return cabState.lastLocal;
    if (!latestPose) return null;
    const local = geoToLocal(latestPose.lon, latestPose.lat, cabState.anchorLon, cabState.anchorLat);
    local.y = finiteOrNull(cabState?.walkMode?.y) ?? finiteOrNull(latestPose.y) ?? 0;
    return local;
}

function streamedTramFeatures(source) {
    return (source?.features || []).filter((feature) => {
        const properties = feature?.properties || {};
        const railway = String(
            properties.railway_type ?? properties.railway ?? properties.tags?.railway ?? '',
        ).toLowerCase();
        return railway === 'tram' || railway === 'light_rail';
    });
}

// The rails a claimed ambient vehicle may run: tram track for a tram, and for
// a train the same heavy-rail set its fleet was built from (in solved mode
// the reconstructed spans only), so its driving graph always holds its path.
function streamedAmbientRailFeatures(source, kind) {
    if (kind !== 'train') return streamedTramFeatures(source);
    return (source?.features || []).filter(feature => (
        isAmbientTrainFeature(feature, { solvedOnly: source?.mode === 'solved' })
    ));
}

const ambientPromptKey = (kind, suffix) => `gta.${kind === 'train' ? 'train' : 'tram'}${suffix}`;

function railSourceOsmId(cabState) {
    const edge = cabState?.driverGraph?.edges?.[cabState?.driver?.edgeId];
    const feature = cabState?.ambientTramClaim?.railFeatures?.[edge?.lineIdx];
    return feature?.properties?.osm_id ?? feature?.properties?.osmId ?? null;
}

function refreshAmbientTramRailGraph(cabState) {
    const claim = cabState?.ambientTramClaim;
    const driver = cabState?.driver;
    if (!claim || !driver?.enabled) return;
    const source = getActiveRailTrafficSource();
    if (source.revision === claim.lastAttemptedRailRevision) return;
    claim.lastAttemptedRailRevision = source.revision;
    const features = streamedAmbientRailFeatures(source, claim.kind);
    if (features.length === 0) return;
    const replacementGraph = buildDriverGraph(features);
    const replacement = resnapDriverState(
        driver,
        cabState.driverGraph,
        replacementGraph,
        CAB_SNAP_RADIUS_M,
    );
    if (!replacement) return;
    cabState.driverGraph = replacementGraph;
    cabState.driver = replacement;
    claim.railFeatures = features;
    claim.acceptedRailRevision = source.revision;
}

function beginAmbientTramControl(cabState, provider, candidate, local) {
    const record = provider.get(candidate.id);
    if (!record?.lastPose) return false;
    const kind = candidate.kind === 'train' ? 'train' : 'tram';
    const source = getActiveRailTrafficSource();
    const railFeatures = streamedAmbientRailFeatures(source, kind);
    if (railFeatures.length === 0) return false;
    const graph = buildDriverGraph(railFeatures);
    const snap = snapPoseToGraph(
        graph,
        record.lastPose.lat,
        record.lastPose.lon,
        record.lastPose.headingDeg,
        CAB_SNAP_RADIUS_M,
    );
    if (!snap) return false;
    const claimed = provider.claim(candidate.id, local);
    if (!claimed) return false;
    if (!completeBoarding(cabState.occupant, {
        id: candidate.id,
        providerId: provider.id,
        controllerId: 'rail',
    })) {
        provider.release(candidate.id, claimed.lastPose, { force: true });
        return false;
    }
    const walkState = cabState.walkMode;
    cabState.ambientTramClaim = {
        id: candidate.id,
        kind,
        provider,
        mesh: claimed.mesh,
        walkState,
        cruiseSpeedMps: claimed.cruiseSpeedMps,
        railFeatures,
        acceptedRailRevision: source.revision,
        lastAttemptedRailRevision: source.revision,
    };
    cabState.walkMode = null;
    cabState.driverGraph = graph;
    cabState.driver = createDriverState(snap, claimed.currentSpeedMps);
    cabState.driver.throttleTarget = 0;
    cabState.lastAutoPose = {
        lat: claimed.lastPose.lat,
        lon: claimed.lastPose.lon,
        headingDeg: claimed.lastPose.headingDeg,
        status: { speedKmh: claimed.currentSpeedMps * 3.6 },
    };
    cabState.doors = { open: true, ratio: claimed.doorRatio };
    cabState.playerTramMesh = claimed.mesh;
    cabState.playerTramMeshBorrowed = true;
    cabState.cameraMode = 'front';
    cabState.walkCameraMode = 'third';
    clearWalkKeys();
    hideWalkControls();
    setDashboardVisible(true);
    setDashboardDoorState(true);
    setDashboardDoorHandler(() => cabState.controllerRouter?.handleAction(
        SESSION_ACTIONS.DOORS,
        'press',
    ));
    setDashboardBellHandler(() => cabState.controllerRouter?.handleAction(
        SESSION_ACTIONS.BELL,
        'press',
    ));
    startEngineWhine();
    startTramSounds();
    if (!cabState.suppressTrackClangs) startTrackClangs();
    showViewButton();
    cabState.controllerRouter?.activate('rail', cabState, 'ambient-tram-board');
    showCabToast(t(ambientPromptKey(kind, 'Entered')), 3000);
    return true;
}

function ambientTramExitCandidate(cabState, pose, local) {
    const heading = (Number(pose.headingDeg) || 0) * DEG_TO_RAD;
    // A train is wider than a tram: step off beside its own body, not the tram's.
    const halfWidthM = Number(cabState?.ambientTramClaim?.mesh?.userData?.collisionHalfWidthM) || TRAM_HALF_WIDTH_M;
    const distance = halfWidthM + 1.05;
    const candidate = {
        x: local.x + Math.cos(heading) * distance,
        z: local.z + Math.sin(heading) * distance,
    };
    candidate.y = getWalkGroundY(candidate.x, candidate.z, (Number(pose.y) || 0) + 3);
    if (!Number.isFinite(candidate.y)) return null;
    const candidateGeo = localToGeo(
        candidate.x,
        candidate.z,
        cabState.anchorLon,
        cabState.anchorLat,
    );
    const resolved = resolveWalkStep(
        pose.lat,
        pose.lon,
        candidateGeo.lat,
        candidateGeo.lon,
        candidate.y,
    );
    if (!resolved) return null;
    const resolvedLocal = geoToLocal(
        resolved.lon,
        resolved.lat,
        cabState.anchorLon,
        cabState.anchorLat,
    );
    if (Math.hypot(resolvedLocal.x - candidate.x, resolvedLocal.z - candidate.z) > 0.45) {
        return null;
    }
    const obstacles = getTrafficObstaclesNear(candidate.x, candidate.z, 2.2, cabState.ambientTramClaim?.id);
    if (obstacles.some(obstacle => Math.hypot(
        obstacle.x - candidate.x,
        obstacle.z - candidate.z,
    ) < Math.max(1, Number(obstacle.widthM) * 0.6))) return null;
    return { ...candidate, ...candidateGeo };
}

function exitAmbientTram(cabState) {
    const claim = cabState?.ambientTramClaim;
    const driver = cabState?.driver;
    if (!claim || !driver) return false;
    if (Math.abs(driver.speed) > 0.8) {
        driver.throttleTarget = -1;
        showCabToast(t(ambientPromptKey(claim.kind, 'StopToExit')), 2200);
        return true;
    }
    if (!cabState.doors?.open || cabState.doors.ratio < 0.95) {
        setPlayerDoorsTarget(cabState, true);
        showCabToast(t(ambientPromptKey(claim.kind, 'DoorsOpening')), 1800);
        return true;
    }
    const pose = computeDriverPose(driver, cabState.driverGraph);
    const local = geoToLocal(pose.lon, pose.lat, cabState.anchorLon, cabState.anchorLat);
    const exit = ambientTramExitCandidate(cabState, pose, local);
    if (!exit) {
        showCabToast(t('gta.noSafeExit'), 2200);
        return false;
    }
    cabState.occupant.state = OCCUPANT_STATES.EXITING;
    const released = claim.provider.release(claim.id, {
        ...pose,
        x: local.x,
        z: local.z,
        speedMps: driver.speed,
        doorRatio: cabState.doors.ratio,
        visible: true,
    }, {
        sourceOsmId: railSourceOsmId(cabState),
        cruiseSpeedMps: claim.cruiseSpeedMps,
    });
    if (!released) {
        cabState.occupant.state = OCCUPANT_STATES.CONTROLLING;
        return false;
    }
    const walkState = claim.walkState;
    walkState.lat = exit.lat;
    walkState.lon = exit.lon;
    walkState.y = exit.y;
    walkState.vy = 0;
    walkState.yaw = (Number(pose.headingDeg) || 0) * DEG_TO_RAD;
    walkState.airborne = false;
    walkState.initialGroundY = null;
    walkState.lastDetectedGroundY = exit.y;
    cabState.walkMode = walkState;
    cabState.walkCameraMode = walkCameraModeAfterVehicleExit();
    cabState.playerTramMesh = null;
    cabState.playerTramMeshBorrowed = false;
    cabState.driver = null;
    cabState.driverGraph = null;
    cabState.doors = null;
    cabState.ambientTramClaim = null;
    completeExit(cabState.occupant);
    cabState.controllerRouter?.activate('foot', cabState, 'ambient-tram-exit');
    setDashboardVisible(false);
    setDashboardDoorHandler(null);
    setDashboardBellHandler(null);
    setDashboardParkingBrakeHandler(null);
    stopEngineWhine();
    stopTrackClangs();
    stopTramSounds();
    hideViewButton();
    setWalkControlsMode('gta-walk');
    showWalkControls();
    showCabToast(t('gta.tramExited'), 2200);
    return true;
}

function abandonDestroyedAmbientTram(cabState) {
    const claim = cabState?.ambientTramClaim;
    if (!claim || claim.provider.get(claim.id)?.state !== 'destroyed') return false;
    const pose = cabState.lastRenderedPose || claim.provider.get(claim.id)?.lastPose;
    const local = pose && Number.isFinite(pose.lon) && Number.isFinite(pose.lat)
        ? geoToLocal(pose.lon, pose.lat, cabState.anchorLon, cabState.anchorLat)
        : cabState.lastLocal;
    const walkState = claim.walkState;
    if (pose && walkState) {
        walkState.lat = pose.lat;
        walkState.lon = pose.lon;
        walkState.y = getWalkGroundY(local?.x || 0, local?.z || 0, Number(pose.y) || 0) || 0;
        walkState.vy = 0;
        walkState.yaw = (Number(pose.headingDeg) || 0) * DEG_TO_RAD;
        walkState.airborne = false;
        walkState.initialGroundY = null;
        walkState.lastDetectedGroundY = walkState.y;
    }
    cabState.walkMode = walkState;
    cabState.walkCameraMode = walkCameraModeAfterVehicleExit();
    cabState.playerTramMesh = null;
    cabState.playerTramMeshBorrowed = false;
    cabState.driver = null;
    cabState.driverGraph = null;
    cabState.doors = null;
    cabState.ambientTramClaim = null;
    forceOccupantOnFoot(cabState.occupant, 'vehicle-destroyed');
    cabState.controllerRouter?.activate('foot', cabState, 'ambient-tram-destroyed');
    setDashboardVisible(false);
    setDashboardDoorHandler(null);
    setDashboardBellHandler(null);
    setDashboardParkingBrakeHandler(null);
    stopEngineWhine();
    stopTrackClangs();
    stopTramSounds();
    hideViewButton();
    setWalkControlsMode('gta-walk');
    showWalkControls();
    showCabToast(t('gta.carUnavailable'), 2200);
    return true;
}

function getUnifiedGtaInteraction(cabState, local) {
    if (shouldRouteRailDoorInteraction({
        isTrainSession: cabState?.isTrainSession,
        walkMode: cabState?.walkMode,
        controllerId: cabState?.controllerRouter?.activeId,
    })) return null;
    if (cabState?.ambientTramClaim) {
        const speedMps = Math.abs(Number(cabState.driver?.speed) || 0);
        const kind = cabState.ambientTramClaim.kind;
        return {
            key: ambientPromptKey(kind, speedMps <= 0.8 ? 'ExitPrompt' : 'StopToExitPrompt'),
            available: speedMps <= 0.8,
        };
    }
    const ambientTramsEnabled = sessionCapabilityEnabled(
        cabState?.sessionCapabilities,
        SESSION_CAPABILITY.AMBIENT_TRAMS,
    );
    const tramProvider = ambientTramsEnabled ? getGtaAmbientTramProvider() : null;
    if (tramProvider && cabState?.occupant?.state === OCCUPANT_STATES.BOARDING_REQUESTED
        && cabState.occupant.providerId === tramProvider.id) {
        const record = tramProvider.get(cabState.occupant.vehicleId);
        if (!record || record.state !== OCCUPANT_STATES.BOARDING_REQUESTED) {
            cancelOccupantTransition(cabState.occupant);
        } else {
            const tram = tramProvider.findById(cabState.occupant.vehicleId, local);
            return tram?.ready
                ? {
                    ...tram,
                    key: ambientPromptKey(tram.kind, 'BoardPrompt'),
                    available: tram.distanceM <= 3.2,
                    vehicleId: tram.id,
                }
                : { ...tram, key: ambientPromptKey(tram?.kind, 'StoppingPrompt'), available: false, vehicleId: tram?.id };
        }
    }
    const road = cabState?.gtaSession?.getInteractionState?.(local) || null;
    const tram = tramProvider?.findNearest(local) || null;
    if (!tram) return road;
    if (!road || tram.distanceM < (Number(road.distanceM) || Infinity)) {
        return {
            ...tram,
            key: ambientPromptKey(tram.kind, tram.ready ? 'BoardPrompt' : 'RequestPrompt'),
            available: !tram.ready || tram.distanceM <= 3.2,
            vehicleId: tram.id,
        };
    }
    return road;
}

function completeGtaVehicleExit(cabState, reason = 'vehicle-exit') {
    if (!cabState || cabState.gtaSession?.isDriving?.()) return false;
    if (cabState.controllerRouter?.activeId !== 'foot') {
        cabState.controllerRouter?.activate('foot', cabState, reason);
    }
    clearWalkKeys();
    cabState.walkCameraMode = walkCameraModeAfterVehicleExit();
    const walker = cabState.walkMode;
    if (walker) {
        const pose = {
            lat: walker.lat, lon: walker.lon, headingDeg: walker.yaw / DEG_TO_RAD,
            y: walker.y, status: { speedKmh: 0, gtaMode: true, driving: false },
        };
        cabState.lastAutoPose = pose;
        cabState.lastRenderedPose = snapshotCabPose(pose);
        cabState.speedProbe = null;
        cabState.probeSpeedKmh = 0;
    }
    resetCameraLook();
    setWalkControlsMode('gta-walk');
    showWalkControls();
    return true;
}

function toggleGtaVehicle(cabState) {
    if (!cabState || !hasEnterableVehicleCapability(cabState.sessionCapabilities)) return false;
    if (shouldRouteRailDoorInteraction({
        isTrainSession: cabState.isTrainSession,
        walkMode: cabState.walkMode,
        controllerId: cabState.controllerRouter?.activeId,
    })) {
        return cabState.controllerRouter?.handleAction(
            SESSION_ACTIONS.DOORS,
            'press',
        ) || false;
    }
    if (cabState.ambientTramClaim) return exitAmbientTram(cabState);
    const local = gtaInteractionLocal(cabState);
    const ambientTramsEnabled = sessionCapabilityEnabled(
        cabState.sessionCapabilities,
        SESSION_CAPABILITY.AMBIENT_TRAMS,
    );
    const tramProvider = ambientTramsEnabled ? getGtaAmbientTramProvider() : null;
    if (tramProvider && cabState.occupant?.state === OCCUPANT_STATES.BOARDING_REQUESTED
        && cabState.occupant.providerId === tramProvider.id) {
        const candidate = tramProvider.findById(cabState.occupant.vehicleId, local);
        if (!candidate?.ready || candidate.distanceM > 3.2) {
            showCabToast(t(ambientPromptKey(candidate?.kind, candidate?.ready ? 'MoveCloser' : 'Stopping')), 1800);
            return true;
        }
        return beginAmbientTramControl(cabState, tramProvider, candidate, local);
    }
    const roadProvider = cabState.gtaSession?.vehicleProvider || null;
    if (roadProvider && cabState.gtaSession.isDriving()) {
        const changed = roadProvider.release(cabState.occupant.vehicleId, null, {
            walkState: cabState.walkMode,
        });
        if (changed && !cabState.gtaSession.isDriving()) {
            completeGtaVehicleExit(cabState);
        }
        return changed;
    }
    const tramCandidate = tramProvider?.findNearest(local) || null;
    const roadCandidate = roadProvider?.findNearest(local) || null;
    const selected = selectNearestVehicleProvider([
        ...(tramProvider ? [{ provider: tramProvider, candidate: tramCandidate }] : []),
        ...(roadProvider ? [{ provider: roadProvider, candidate: roadCandidate }] : []),
    ], local);
    if (selected?.provider === tramProvider) {
        const occupantCandidate = {
            ...tramCandidate,
            providerId: tramProvider.id,
            controllerId: 'rail',
        };
        if (!requestBoarding(cabState.occupant, occupantCandidate)) return false;
        if (!tramProvider.requestBoarding(tramCandidate.id, local)) {
            cancelOccupantTransition(cabState.occupant);
            return false;
        }
        if (tramCandidate.ready && tramCandidate.distanceM <= 3.2) {
            return beginAmbientTramControl(cabState, tramProvider, tramCandidate, local);
        }
        showCabToast(t('gta.tramStopping'), 2200);
        return true;
    }
    if (!selected) {
        showCabToast(t('gta.noCarNearby'), 1800);
        return false;
    }
    if (!roadProvider) return false;
    const requested = roadProvider.requestBoarding(selected.id, local);
    const changed = requested && !!roadProvider.claim(selected.id);
    const driving = cabState.gtaSession.isDriving();
    if (changed && driving) {
        activateClaimedGtaVehicle(cabState, 'vehicle-enter');
    }
    return changed;
}

function activateClaimedGtaVehicle(cabState, reason) {
    cabState.initialVehicleClaimPending = false;
    cabState.controllerRouter?.activate(
        cabState.gtaSession?.getControllerKind?.() || 'road',
        cabState,
        reason,
    );
    clearWalkKeys();
    setWalkControlsMode('gta-drive');
    showWalkControls();
}

function claimInitialGtaVehicle(cabState, local) {
    if (!cabState?.initialVehicleClaimPending || !cabState.initialVehicleId) return false;
    const provider = cabState.gtaSession?.vehicleProvider;
    if (!provider) return false;
    if (cabState.gtaSession.isDriving()) {
        cabState.initialVehicleClaimPending = false;
        return false;
    }
    if (cabState.occupant?.state !== OCCUPANT_STATES.ON_FOOT) return false;
    const candidate = provider.findNearest(local);
    if (!candidate || String(candidate.id) !== cabState.initialVehicleId) return false;
    // A campaign checkpoint restores the player directly into its canonical
    // vehicle. It does not represent an on-foot approach, so open-water boats
    // may bypass the ordinary walk-path reachability guard here only.
    const requested = provider.requestBoarding(cabState.initialVehicleId, local, {
        allowUnreachable: true,
    });
    const claimed = requested && !!provider.claim(cabState.initialVehicleId);
    if (!claimed || !cabState.gtaSession.isDriving()) return false;
    activateClaimedGtaVehicle(cabState, 'campaign-vehicle-resume');
    return true;
}

function bindKeyboard() {
    keysBound = true;
    // Capture-phase so we see arrow keys before Leaflet's map keyboard handler
    // (enabled by default on L.map) can pan the map behind the modal.
    window.addEventListener('keydown', (e) => {
        if (state.mode !== 'cab' || !state.cabState) return;
        const cabState = state.cabState;
        const k = keyTokenFor(e);

        // P freezes simulation time/physics but deliberately leaves the
        // renderer and camera controls live for composing screenshots.
        if (k === 'p') {
            e.preventDefault();
            e.stopPropagation();
            if (!e.repeat) setCabSimulationPaused(cabState, !cabState.simPaused);
            return;
        }

        if (k === 't') {
            e.preventDefault();
            e.stopPropagation();
            if (!e.repeat) {
                const result = toggleTerrainInspection();
                const key = result.reason === 'unavailable'
                    ? 'terrainInspection.unavailable'
                    : result.mode === 'overlay'
                        ? 'terrainInspection.overlay'
                        : result.mode === 'only'
                            ? 'terrainInspection.only'
                            : 'terrainInspection.disabled';
                showCabToast(t(key), 2200);
            }
            return;
        }

        // H = humans: ambient people stay opt-in for ordinary walking, while
        // GTA starts with them visible and uses the same key as an optional
        // visibility/performance toggle. They remain visual-only in GTA.
        if (k === 'h' && cabState.walkMode) {
            e.preventDefault();
            e.stopPropagation();
            if (!e.repeat) {
                cabState.walkPedestriansEnabled = !cabState.walkPedestriansEnabled;
                const on = setPedestriansEnabled(cabState.walkPedestriansEnabled);
                showCabToast(t(on ? 'walk.peopleOn' : 'walk.peopleOff'), 1800);
            }
            return;
        }

        // L = master toggle for all night lighting (windows, car beams, street-
        // lamps, walker headlamp). Works in every camera/walk mode so you can
        // A/B the frame cost. No effect by day — the lights are night-gated.
        if (k === 'l') {
            e.preventDefault();
            e.stopPropagation();
            const on = toggleNightLights();
            showCabToast(on ? 'Noćna rasvjeta: UKLJ' : 'Noćna rasvjeta: ISKLJ', 1600);
            return;
        }

        // N = display state of proposal BUILDINGS: solid (local style) → ghost
        // (glass prism) → off. Works in cab and walk alike — a drive past the
        // plan wants the toggle as much as a walk through it. Inert (and the
        // key not consumed) when the session carries no proposal buildings.
        if (k === 'n' && !e.repeat) {
            const displayState = cycleProposalBuildingDisplay();
            if (displayState) {
                e.preventDefault();
                e.stopPropagation();
                showCabToast(t(`proposals.buildings.${displayState}`), 1800);
                return;
            }
        }

        if (k === 'e' && !e.repeat
            && (interactWithWorld(cabState) || cabState.onCampaignInteract?.(getCabSessionSnapshot()))) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        if (hasEnterableVehicleCapability(cabState.sessionCapabilities)) {
            const controllerId = cabState.controllerRouter?.activeId || 'foot';
            if (k === 'e') {
                e.preventDefault();
                e.stopPropagation();
                if (!e.repeat) toggleGtaVehicle(cabState);
                return;
            }
            if (k === 'c') {
                e.preventDefault();
                e.stopPropagation();
                if (!e.repeat) cabState.controllerRouter?.handleAction(
                    SESSION_ACTIONS.CAMERA,
                    'press',
                );
                return;
            }
            if (controllerId !== 'foot' && k === 'r') {
                if (!shouldHandleVehicleResetKeyDown(k, e)) return;
                e.preventDefault();
                e.stopPropagation();
                cabState.controllerRouter?.handleAction(SESSION_ACTIONS.RESET, 'press');
                return;
            }
            const action = semanticActionForKey(k, controllerId);
            if (controllerId !== 'foot' && action
                && cabState.controllerRouter?.handleAction(
                    action,
                    e.repeat ? 'repeat' : 'press',
                )) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
        }

        // Walker keys, and then a hard stop. This must ask whether the player is
        // ON FOOT: asking the session flag swallowed every later key — g, v —
        // for the whole of a free-roam session, driving included. Keys the
        // vehicle controller wanted were already consumed above.
        if (isPlayerOnFoot(cabState)) {
            if (k === 'c') {
                e.preventDefault();
                e.stopPropagation();
                if (!e.repeat) cabState.controllerRouter?.handleAction(
                    SESSION_ACTIONS.CAMERA,
                    'press',
                );
                return;
            }
            // G draws or holsters the campaign sidearm on foot (the header
            // button does the same); without one the key stays inert here.
            if (k === 'g' && cabState.campaignSidearmAvailable === true) {
                e.preventDefault();
                e.stopPropagation();
                if (!e.repeat) toggleWeapon();
                return;
            }
            // A drawn sidearm takes Space from the jetpack: it fires, first
            // person only, exactly as the mounted gun does in a vehicle.
            if ((k === ' ' || e.code === 'Space') && isGameMode() && isWeaponAttached()) {
                e.preventDefault();
                e.stopPropagation();
                if (cabState.cameraMode !== 'third') setWeaponFiring(true);
                return;
            }
            if (WALK_MOVEMENT_KEYS.includes(k)) {
                e.preventDefault();
                e.stopPropagation();
                const action = semanticActionForKey(k, 'foot');
                if (action) cabState.controllerRouter?.handleAction(
                    action,
                    e.repeat ? 'repeat' : 'press',
                );
            }
            return;
        }

        let ds = cabState.driver;
        if (k === 'v') {
            e.preventDefault();
            e.stopPropagation();
            if (!ds || !ds.enabled) enableDriverMode();
            return;
        }
        // G = toggle machine gun on/off (gamification). Hidden by default
        // when entering the cab; press G to bring it up, G again to stow.
        // Routed through toggleWeapon() so the on-screen fire button shows
        // / hides in lock-step (handy when toggling on a touchscreen
        // device that also has a keyboard).
        if (k === 'g') {
            e.preventDefault();
            e.stopPropagation();
            toggleWeapon();
            return;
        }
        // C = cycle front cab → rear cab → outside chase view.
        if (k === 'c') {
            e.preventDefault();
            e.stopPropagation();
            cabState.controllerRouter?.handleAction(SESSION_ACTIONS.CAMERA, 'press');
            return;
        }
        // B = ring the tram bell (classic Zagreb "ding-ding").
        if (k === 'b') {
            e.preventDefault();
            e.stopPropagation();
            cabState.controllerRouter?.handleAction(SESSION_ACTIONS.BELL, 'press');
            return;
        }
        // E = toggle the doors (manual driving only; interlocks throttle).
        if (k === 'e') {
            e.preventDefault();
            e.stopPropagation();
            cabState.controllerRouter?.handleAction(SESSION_ACTIONS.DOORS, 'press');
            return;
        }
        // Spacebar = machine-gun fire (only meaningful when gun is out).
        // Available whenever the cab is open, regardless of driver mode.
        if (k === ' ' || e.code === 'Space') {
            e.preventDefault();
            e.stopPropagation();
            if (isGameMode() && cabState.cameraMode !== 'third') setWeaponFiring(true);
            return;
        }
        const railAction = semanticActionForKey(k, 'rail');
        if (railAction && cabState.controllerRouter?.handleAction(
            railAction,
            e.repeat ? 'repeat' : 'press',
        )) {
            e.preventDefault();
            e.stopPropagation();
        }
    }, true);
    window.addEventListener('keyup', (e) => {
        const k = keyTokenFor(e);
        if (state.mode !== 'cab' || !state.cabState) return;
        const cabState = state.cabState;
        const controllerId = cabState.controllerRouter?.activeId
            || (cabState.walkMode ? 'foot' : 'rail');
        const action = semanticActionForKey(k, controllerId);
        if (action && cabState.controllerRouter?.handleAction(action, 'release')) {
            e.preventDefault();
            return;
        }
        // Releasing Space stops the gun on foot as well as in a cab.
        if (k === ' ' || e.code === 'Space') {
            e.preventDefault();
            setWeaponFiring(false);
        }
        if (cabState.walkMode) return;
        const ds = cabState.driver;
        if (!ds || !ds.enabled) return;
        if (k === 'arrowup' || k === 'arrowdown' || k === 'w' || k === 's') {
            e.preventDefault();
            ds.throttleTarget = 0;
        }
    });
    const releaseHeldInputs = () => {
        clearWalkKeys();
        for (const key of ['w', 'a', 's', 'd', 'arrowup', 'arrowleft', 'arrowdown', 'arrowright', ' ']) {
            setWalkControlPressed(key, false);
        }
        const cabState = state.cabState;
        cabState?.gtaSession?.clearControls?.();
        if (cabState?.driver) cabState.driver.throttleTarget = 0;
        setWeaponFiring(false);
    };
    // The campaign director broadcasts every world-effect change; the session
    // keeps its own copy current so anything read per frame (the conductor's
    // cap on the walker) follows the story without a scene reopen.
    window.addEventListener('station3d:campaign-world-effects-changed', (event) => {
        const cabState = state.cabState;
        const effects = event?.detail?.worldEffects;
        if (!cabState || !effects || typeof effects !== 'object') return;
        cabState.campaignWorldEffects = { ...effects };
    });
    window.addEventListener('blur', releaseHeldInputs);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) releaseHeldInputs();
    });
    // Mouse wheel in third-person bird's-eye view: scroll up = zoom in
    // (lower elevation), scroll down = zoom out (higher elevation).
    // Capture-phase + preventDefault so OrbitControls and the page's
    // scroll handlers don't also react. No-op outside C-mode so the
    // first-person cab still ignores the wheel.
    window.addEventListener('wheel', (e) => {
        if (state.mode !== 'cab' || !state.cabState) return;
        const cabState = state.cabState;
        if (cabState.cameraMode !== 'third') return;
        e.preventDefault();
        e.stopPropagation();
        const next = (cabState.birdHeight || BIRD_HEIGHT_DEFAULT) + e.deltaY * BIRD_WHEEL_M_PER_DELTA;
        cabState.birdHeight = Math.max(BIRD_HEIGHT_MIN, Math.min(BIRD_HEIGHT_MAX, next));
    }, { capture: true, passive: false });
}

// ─── Walk-mode support-surface raycast ─────────────────────────────────────
// Finds the highest walkable surface no more than one step above the walker:
// street, roof, viaduct, underground platform, or station stair.
const _walkRayDir = new THREE.Vector3(0, -1, 0);
const _walkRayOrigin = new THREE.Vector3();
const _walkRaycaster = new THREE.Raycaster();
const _walkGroundCache = new Map();        // key "qx|qz|qy" → groundY/null
const _walkGroundPositionCache = new Map(); // same lifetime, before ownership queries
let _walkGroundCacheStamp = 0;
let _walkGroundCacheSession = null;
let _walkGroundCachePublication = -1;
const _WALK_GROUND_CACHE_LIFETIME_MS = 500;
const _WALK_GROUND_CACHE_QUANT = 0.5;       // metres
const _WALK_MAX_STEP_UP_M = WALK_MAX_STEP_UP_M;

// Rapier builds a local terrain mesh from hundreds of samples at a time. The
// walking query below is intentionally comprehensive and raycasts authored
// meshes, so using it for that grid turns one GTA frame into thousands of
// scene traversals. Driving needs the analytic road formation where one is
// present and the DGU terrain everywhere else; isolated exit/entry probes keep
// using the full walking authority.
function getGtaPhysicsGroundY(localX, localZ, hintY = null) {
    const campaignPackY = campaignWorldPackSupportYAtLocal(localX, localZ, {
        maxY: Number.isFinite(hintY) ? hintY + 1.25 : Infinity,
        drivableOnly: true,
    });
    if (Number.isFinite(campaignPackY)) return campaignPackY;
    const renderedRoadY = renderedRoadSurfaceSupportYAtLocal(localX, localZ, {
        // Ignore a bridge deck overhead when the vehicle is on the road below.
        // Recovery callers provide a local height hint; bulk terrain sampling
        // has no hint and still falls through to its raw terrain authority.
        maxY: Number.isFinite(hintY) ? hintY + 1.25 : Infinity,
        drivableOnly: true,
    });
    if (Number.isFinite(renderedRoadY)) return renderedRoadY;
    const roadY = state.cabState?.roadFormation?.sceneYAtLocal(
        localX,
        localZ,
        // Streamed road generations are prepared cooperatively by roads.js.
        // Physics keeps the last atomically published generation until that
        // work completes instead of turning one height sample into a whole-city
        // synchronous rebuild on the driving frame.
        { requireSurface: true, allowStale: true },
    );
    if (Number.isFinite(roadY)) return roadY;
    const terrainY = state.cabState?.terrain?.evidenceSceneYAtLocal?.(localX, localZ);
    return finiteOrNull(terrainY);
}

export function getWalkGroundY(localX, localZ, walkerY = 999) {
    const liftY = liftFloorYAt(localX, localZ, walkerY);
    if (liftY !== null) return liftY;
    const now = performance.now();
    const publication = state.cabState?.groundPublications?.revision ?? 0;
    if (_walkGroundCacheSession !== state.cabState
        || _walkGroundCachePublication !== publication
        || now - _walkGroundCacheStamp > _WALK_GROUND_CACHE_LIFETIME_MS) {
        _walkGroundCache.clear();
        _walkGroundPositionCache.clear();
        _walkGroundCacheStamp = now;
        _walkGroundCacheSession = state.cabState;
        _walkGroundCachePublication = publication;
    }
    const rayTopY = Number.isFinite(walkerY) ? walkerY + _WALK_MAX_STEP_UP_M : 1000;
    // The detailed cache key below records every ownership classification, but
    // computing those classifications was itself ~22 ms in the reported
    // stationary Zagreb scene. Results were already allowed to remain valid
    // for 500 ms; reuse that same bounded answer by position BEFORE touching
    // the planner, rail, road, terrain, or raycast authorities.
    // A quantized point can straddle a stair, opening or stacked-level
    // ceiling. Reuse exact repeated queries; never reuse a neighbour's floor.
    const positionKey = localX + '|' + localZ + '|' + rayTopY;
    if (_walkGroundPositionCache.has(positionKey)) {
        return _walkGroundPositionCache.get(positionKey);
    }
    const campaignEnvironmentY = getCampaignEnvironmentGroundYAt(localX, localZ);
    if (Number.isFinite(campaignEnvironmentY)) {
        _walkGroundPositionCache.set(positionKey, campaignEnvironmentY);
        return campaignEnvironmentY;
    }
    const authoredSurfaceRead = state.cabState?.layerCtx?.authoredSurfaceRead;
    const authoredGroundY = authoredSurfaceRead?.supportYAt(localX, localZ, { maxY: rayTopY });
    const openingRead = state.cabState?.layerCtx?.surfaceOpeningRead;
    // Analytic formation inputs remain useful design data. They cannot fill
    // a volume removed from the published receivers, even before every rail
    // and platform producer has migrated its point queries to exact faces.
    const eligibleSupportY = (y, surfaceClass) => Number.isFinite(y)
        && !openingRead?.contains(localX, y, localZ, { surfaceClass,
            coverageState: SURFACE_COVERAGE_STATE.PUBLISHED, verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL }) ? y : null;
    // A baked level's visible meshes and support triangles are one immutable
    // payload. Resolve them before the live-world ownership graph: none of the
    // streaming formations below exist in this session, and consulting them
    // would reintroduce the invisible/stale-floor disagreement the pack removes.
    const campaignPackY = campaignWorldPackSupportYAtLocal(localX, localZ, {
        maxY: rayTopY,
    });
    if (Number.isFinite(campaignPackY)) {
        _walkGroundPositionCache.set(positionKey, campaignPackY);
        return campaignPackY;
    }
    const insideSurfaceCutout = isPointInsidePlannerSurfaceCutout(localX, localZ);
    const insideStructuralCutout = isPointInsidePlannerSurfaceCutout(
        localX,
        localZ,
        0,
        { includeSurfaceTrack: false },
    );
    const photorealGroundGroup = getPhotorealGroundGroup();
    // A requested photo session can still reveal the abstract world when the
    // Google stream fails. Suppress model/DGU baselines only while a seated
    // Google ground authority actually exists; otherwise the fallback world
    // must retain its ordinary walk support.
    const usePhotorealSupport = isPhotoWorld() && !!photorealGroundGroup;
    // Pass the walker's own height: where a surface track crosses over a
    // tunnel, the support beneath them is the tunnel floor, not the bed above.
    let plannerTrackSupportY = eligibleSupportY(getPlannerSubsurfaceWalkFloorY(localX, localZ, walkerY), SURFACE_CLASS.RAIL_TRACKBED);
    // A viaduct footprint is not a hole in the ground. When its authored deck
    // is above the walker's step reach, the walker is in the underpass and the
    // ordinary terrain/road/rail support below must remain eligible.
    const insidePlannerUnderpass = isWalkSupportOverhead(walkerY, plannerTrackSupportY);
    // Bored tunnels in the model terrain world: the corridor polygons above
    // describe the PHOTO carve (the whole route), so over an intact bore roof
    // they must not open the surface — and inside the bore, the tube floor is
    // the support even though the flat world's "underground = negative scene Y"
    // rule can never fire on a hillside. resolveWalkSupportContext owns that
    // classification; the formation says which case this point is.
    const modelTerrainWorld = !usePhotorealSupport && !!state.cabState?.terrain;
    const railFormation = state.cabState?.railFormation || null;
    const tunnelRoof = modelTerrainWorld
        ? railFormation?.tunnelRoofInfoAt?.(localX, localZ)
        : null;
    const rawTerrainY = modelTerrainWorld
        ? state.cabState.terrain.evidenceSceneYAtLocal?.(localX, localZ)
        : null;
    const viaductTerrainCutout = modelTerrainWorld
        ? state.cabState.terrain.renderedRailSurface
            ?.viaductTerrainCutoutAtLocal?.(localX, localZ)
        : null;
    const viaductTerrainWalkSupport = resolveViaductTerrainWalkSupport({
        walkerY,
        deckY: viaductTerrainCutout?.sceneY ?? null,
        terrainCutoutActive: !!viaductTerrainCutout,
        maxStepUpM: _WALK_MAX_STEP_UP_M,
    });
    const insideRailOpenCut = modelTerrainWorld
        && railFormation?.isOpenCutAtLocal?.(localX, localZ) === true;
    const railCivilGroundY = insideRailOpenCut
        ? railFormation?.civilGroundSceneYAtLocal?.(
            localX,
            localZ,
            { surfaceOffsetY: 0.075 },
        )
        : null;
    const railFormationWalkSupport = resolveRailFormationWalkSupport({
        walkerY,
        civilGroundY: railCivilGroundY,
        insideOpenCut: insideRailOpenCut,
        maxStepUpM: _WALK_MAX_STEP_UP_M,
    });
    if (tunnelRoof && !Number.isFinite(plannerTrackSupportY)
        && Number.isFinite(tunnelRoof.floorY)
        && Number.isFinite(walkerY)
        && walkerY < tunnelRoof.floorY + WALK_BORE_LEVEL_CLEARANCE_M) {
        // Inside the bore the planner's own subsurface lookup can miss (it
        // walks planner segments, not the formation); the formation knows its
        // tube floor exactly. Only at bore level — a walker falling through
        // the hill far above the tube must be caught by terrain recovery,
        // not handed the tunnel floor.
        // + the trackbed slab the walker actually stands on (rails.js TRACKBED_Y).
        plannerTrackSupportY = eligibleSupportY(tunnelRoof.floorY + 0.08, SURFACE_CLASS.RAIL_TRACKBED);
    }
    const supportContext = resolveWalkSupportContext({
        walkerY,
        terrainY: rawTerrainY,
        corridorFloorY: plannerTrackSupportY,
        tunnelFloorY: tunnelRoof?.floorY ?? null,
        insideCutPolygon: insideSurfaceCutout,
        insideCutPolygonStructural: insideStructuralCutout && !insidePlannerUnderpass,
        tunnelRoof: tunnelRoof?.over ?? null,
        hasTerrainWorld: modelTerrainWorld,
        maxStepUpM: _WALK_MAX_STEP_UP_M,
    });
    const activeSurfaceCutout = supportContext.surfaceCutout;
    const activeStructuralCutout = supportContext.structuralCutout
        || railFormationWalkSupport.ownsCut
        || viaductTerrainWalkSupport.ownsTerrain;
    const insideSubsurfaceCorridor = supportContext.subsurface;
    const key = positionKey + '|'
        + (activeSurfaceCutout ? 1 : 0) + '|' + (activeStructuralCutout ? 1 : 0)
        + '|' + (insidePlannerUnderpass ? 1 : 0)
        + '|' + (insideSubsurfaceCorridor ? 1 : 0)
        + '|' + (railFormationWalkSupport.ownsCut ? 1 : 0)
        + '|' + (viaductTerrainWalkSupport.ownsTerrain ? 1 : 0)
        + '|' + (supportContext.suppressRecovery ? 1 : 0)
        + '|' + (tunnelRoof ? tunnelRoof.over : '-')
        + '|' + (usePhotorealSupport ? 1 : 0)
        + '|' + (Number.isFinite(plannerTrackSupportY)
            ? Math.round(plannerTrackSupportY / _WALK_GROUND_CACHE_QUANT)
            : 'x')
        + '|' + (Number.isFinite(railFormationWalkSupport.firmGroundY)
            ? Math.round(railFormationWalkSupport.firmGroundY / _WALK_GROUND_CACHE_QUANT)
            : 'x')
        + '|' + (Number.isFinite(viaductTerrainWalkSupport.firmDeckY)
            ? Math.round(viaductTerrainWalkSupport.firmDeckY / _WALK_GROUND_CACHE_QUANT)
            : 'x');
    if (_walkGroundCache.has(key)) return _walkGroundCache.get(key);
    // A replacement road underpass opens the terrain along its ramps and owns
    // one continuous depressed carriageway there. The analytic terrain knows
    // nothing of that cut, so inside the OPENING it must stop being a floor
    // candidate (it held walkers at grass level over the ramp) and the solved
    // road profile becomes the authoritative support, exactly like a planner
    // subsurface corridor. Inside the covered box the intact ground above is
    // a ceiling — suppressed only when it is beyond step reach, so a walker
    // standing ON the fill over the tunnel keeps ordinary terrain support.
    // Deterministic per exact position, so it lives BEHIND the cache like
    // every other alignment lookup; the 500 ms wholesale clear bounds any
    // staleness across model revisions.
    const roadAlignments = state.cabState?.roadVerticalAlignments || null;
    const walkTerrainSceneY = state.cabState?.terrain?.evidenceSceneYAtLocal?.(
        localX,
        localZ,
    );
    // The exact rendered top is also the feet authority. At Gornji grad an
    // ordinary pedestrian surface crosses a lower solved foot tunnel; treating
    // every plan-overlap as "inside the tunnel" discarded that visible paving
    // and dropped the walker onto the structure floor below. Resolve the upper
    // triangle before suppressing any street-level baseline: it wins while it
    // is within step reach, and naturally becomes an overhead roof for a walker
    // who is genuinely inside the tunnel.
    const renderedRoadRecoveryCeilingY = Number.isFinite(walkerY)
        ? Math.max(
            rayTopY,
            Number.isFinite(rawTerrainY) ? rawTerrainY + 1.5 : rayTopY,
        )
        : Infinity;
    const renderedRoadGroundY = renderedRoadSurfaceSupportYAtLocal(
        localX,
        localZ,
        { maxY: renderedRoadRecoveryCeilingY },
    );
    const insideRoadOpening = !!roadAlignments
        && roadAlignments.isInsideReplacementTerrainOpening(localX, localZ);
    const insideRoadCorridor = !!roadAlignments
        && roadAlignments.containsReplacementCorridor(localX, localZ) === true;
    const roadReplacementWalkSupport = resolveRoadReplacementWalkSupport({
        walkerY,
        terrainY: walkTerrainSceneY,
        renderedSurfaceY: renderedRoadGroundY,
        insideOpening: insideRoadOpening,
        insideCorridor: insideRoadCorridor,
        maxStepUpM: _WALK_MAX_STEP_UP_M,
    });
    const insideRoadReplacementCorridor = !!roadAlignments
        && roadReplacementWalkSupport.insideReplacementCorridor;
    const roadCorridorFloorY = insideRoadReplacementCorridor && !authoredSurfaceRead
        ? roadAlignments.roadYAtLocal(localX, localZ)
        : null;
    const roadStructure = roadAlignments?.structureAtLocal(localX, localZ);
    const structuralRoadSupportY = !authoredSurfaceRead && roadStructure?.kind === 'overpass'
        ? roadAlignments.roadYAtLocal(
            localX,
            localZ,
            roadStructure.osmIds?.[0],
        )
        : null;
    const reachableStructuralRoadSupportY = reachableWalkSupportY(
        walkerY,
        structuralRoadSupportY,
    );
    const reachableTramTrackbedSupportY = reachableWalkSupportY(
        walkerY,
        eligibleSupportY(tramTrackbedSupportYAtLocal(localX, localZ), SURFACE_CLASS.RAIL_TRACKBED),
    );
    // Street level is a valid floor only once it is below (or a walkable step
    // above) the player and the visible surface is not actually cut open.
    // Underground spawns therefore stay on their platform, jetpack descents
    // land on intact streets, and the metro stair opening remains re-enterable.
    const railSurface = railFormation?.formationAtLocal(
        localX,
        localZ,
        { requireSurface: true },
    );
    const solvedRoadGroundY = eligibleSupportY(state.cabState?.roadFormation
        ? state.cabState.roadFormation.sceneYAtLocal(localX, localZ, {
            requireSurface: true,
            // A walk query runs inside the render hook. Streamed road updates
            // must not make it pay the model's lazy whole-generation rebuild;
            // the last published formation remains correct until the roads
            // queue atomically publishes its successor.
            allowStale: true,
        })
        : null, SURFACE_CLASS.ROAD_CARRIAGEWAY);
    // The renderer also owns pedestrian/shared streets that have no engineered
    // formation. Its exact published triangles were queried above because they
    // also decide whether a lower replacement corridor is floor or overhead.
    const roadGroundY = [solvedRoadGroundY, renderedRoadGroundY]
        .filter(Number.isFinite)
        .reduce((best, value) => Math.max(best, value), -Infinity);
    const finiteRoadGroundY = Number.isFinite(roadGroundY) ? roadGroundY : null;
    const terrainGroundY = selectWalkBaselineSupportY({
        photoWorld: usePhotorealSupport,
        requireEvidence: modelTerrainWorld,
        walkerY,
        railY: eligibleSupportY(railSurface?.railY, SURFACE_CLASS.RAIL_TRACKBED),
        roadY: finiteRoadGroundY,
        terrainY: viaductTerrainWalkSupport.ownsTerrain
            ? null
            : walkTerrainSceneY,
        maxStepUpM: _WALK_MAX_STEP_UP_M,
    });
    // Recovery aims at the REAL surface, not the baseline: mid-fall through a
    // hillside every within-reach candidate is far below (the tube), and
    // recovering "to" the tube floor is exactly the fall-through.
    const recoveryTargetY = [
        viaductTerrainWalkSupport.ownsTerrain ? null : rawTerrainY,
        renderedRoadGroundY,
    ]
        .filter(Number.isFinite)
        .reduce((best, value) => Math.max(best, value), -Infinity);
    const finiteRecoveryTargetY = Number.isFinite(recoveryTargetY)
        ? recoveryTargetY : terrainGroundY;
    let bestY = Number.isFinite(terrainGroundY)
        && rayTopY >= terrainGroundY
        && !activeStructuralCutout && !insideSubsurfaceCorridor
        && !insideRoadReplacementCorridor
        ? terrainGroundY
        : -Infinity;
    if (Number.isFinite(authoredGroundY) && authoredGroundY > bestY) bestY = authoredGroundY;
    if (insideSubsurfaceCorridor && Number.isFinite(plannerTrackSupportY) && plannerTrackSupportY <= rayTopY + 0.01) {
        bestY = plannerTrackSupportY;
    }
    // The analytic formation surface is available before the streamed apron
    // mesh and uses the same profile. It is therefore the stable feet authority
    // throughout an open cut, including a tunnel-mouth flare where the raw DGU
    // surface has already been removed several metres above the track.
    if (Number.isFinite(railFormationWalkSupport.firmGroundY)
        && eligibleSupportY(railFormationWalkSupport.firmGroundY, SURFACE_CLASS.RAIL_TRACKBED) !== null
        && railFormationWalkSupport.firmGroundY <= rayTopY + 0.01
        && railFormationWalkSupport.firmGroundY > bestY) {
        bestY = railFormationWalkSupport.firmGroundY;
    }
    if (Number.isFinite(viaductTerrainWalkSupport.firmDeckY)
        && eligibleSupportY(viaductTerrainWalkSupport.firmDeckY, SURFACE_CLASS.STRUCTURE) !== null
        && viaductTerrainWalkSupport.firmDeckY <= rayTopY + 0.01
        && viaductTerrainWalkSupport.firmDeckY > bestY) {
        bestY = viaductTerrainWalkSupport.firmDeckY;
    }
    // The solved corridor profile is the underpass floor backstop: present as
    // soon as the alignment exists (its meshes may still be streaming), and
    // capped like every mesh hit so a deck resolved by plan-nearest ambiguity
    // at the crossing can never yank the walker up from below.
    if (insideRoadReplacementCorridor
        && Number.isFinite(roadCorridorFloorY)
        && roadCorridorFloorY <= rayTopY + 0.01
        && roadCorridorFloorY > bestY) {
        bestY = roadCorridorFloorY;
    }
    if (Number.isFinite(reachableStructuralRoadSupportY)
        && reachableStructuralRoadSupportY <= rayTopY + 0.01
        && reachableStructuralRoadSupportY > bestY) {
        bestY = reachableStructuralRoadSupportY;
    }
    if (Number.isFinite(reachableTramTrackbedSupportY)
        && reachableTramTrackbedSupportY <= rayTopY + 0.01
        && reachableTramTrackbedSupportY > bestY) {
        bestY = reachableTramTrackbedSupportY;
    }
    _walkRayOrigin.set(localX, rayTopY, localZ);
    _walkRaycaster.set(_walkRayOrigin, _walkRayDir);
    _walkRaycaster.far = 2000;
    // Include station platforms/stairs and the underground hall in addition
    // to ordinary roofs and viaducts. Starting the ray only one walkable step
    // above the player ignores ceilings/ground that are still overhead.
    const plannerSupportNames = new Set([
        'PlannerViaductDeck',
        'PlannerEmergencyWalkway',
        'PlannerTunnelFloors',
        'PlannerLowRampFill',
    ]);
    const groups = [
        // Photoreal terrain: stand on the real streamed ground, not the y=0 plane.
        // Hits on "ghost ground" — the original surface inside the carved corridor,
        // which the corridor shader clips away visually but which still exists as
        // geometry — are rejected, so inside a cut the walker stands on the trench
        // floor (y=0) instead of floating on invisible mesh.
        {
            group: photorealGroundGroup,
            // Every raycastable mesh in this dedicated group is visible Google
            // source terrain. Do not wait for the periodic walkable tag pass:
            // freshly streamed LOD children would otherwise create support
            // misses for up to half a second while replacing their parent.
            filter: null,
            rejectHit: h => isPhotorealGhostGround(h.point.x, h.point.y, h.point.z),
        },
        // Photoreal trench walls: solid colliders from the side, but their tops
        // are firm — including them here lets the walker stand on and walk along
        // a wall crest (a downward ray only ever hits the top face).
        { group: getPhotorealWallsGroup(), filter: null },
        {
            // Until a coordinated generation is published, read the actual
            // visible authored faces through the same capped mesh query as
            // other structures. There is no unconditional rectangular floor.
            group: authoredSurfaceRead ? null : getGricTunnelLandmarkGroup(),
            filter: object => object?.userData?.surfaceClaim?.capabilities?.support === true,
        },
        {
            group: getProposalsWalkableGroup(),
            filter: object => object?.userData?.walkableSurface === true,
        },
        {
            group: getWaterGroupForWalkColliders(),
            filter: object => object?.userData?.walkableSurface === true,
        },
        {
            group: authoredSurfaceRead ? null : getPlannerElevationGroup(),
            filter: object => plannerSupportNames.has(object?.name),
        },
        {
            group: getUndergroundGroup(),
            filter: object => object?.userData?.walkableSurface === true,
        },
        {
            group: getPlatformsGroup(),
            filter: object => object?.userData?.walkableSurface === true,
        },
        {
            group: authoredSurfaceRead ? null : getRoadGradeSeparationsGroup(),
            filter: object => object?.userData?.walkableSurface === true,
        },
        {
            group: getCampaignEnvironmentGroup(),
            filter: object => object?.userData?.walkableSurface === true,
        },
        // Cut/fill dressing is real ground: the batter face doubling as the
        // cross-slope bench and the terrain collar are what a walker on a
        // formation flank actually stands on. Without them the only "support"
        // there is the raw DTM (mask-discarded, possibly a cliff) or the bed
        // metres below, and the terrain-recovery yank filled the gap.
        {
            group: getRailsGroupForWalkColliders(),
            filter: object => object?.name === 'RailFormationTerrainCollar'
                || object?.name === 'RailFormationRetainingWalls'
                || object?.name === 'ProposalRailViaductDeck',
        },
        {
            // The curb's raised-side collar is visible paving/earthwork. Keep
            // feet on that exact slope instead of the lower formation surface
            // it conceals; curb faces remain lateral obstacles and are not
            // accepted by this downward support ray.
            group: getCurbsGroupForWalkSupport(),
            filter: object => (object?.name === 'CurbTerrainSeam'
                    || object?.name === 'CurbProfile')
                && object?.userData?.walkableSurface === true,
        },
    ];
    for (const { group, filter, rejectHit } of groups) {
        if (!group) continue;
        // Select support receivers before intersection. Raycasting the rail
        // group first also tested every instanced sleeper, rail and fitting,
        // then discarded those hits. This query needs only the named physical
        // floors; the exact triangles and height/opening checks stay the same.
        let hits;
        if (filter) {
            const receivers = [];
            group.traverse(object => { if (filter(object)) receivers.push(object); });
            hits = _walkRaycaster.intersectObjects(receivers, false);
        } else {
            hits = _walkRaycaster.intersectObject(group, true);
        }
        for (const h of hits) {
            if (rejectHit && rejectHit(h)) continue;
            if (openingRead?.contains(h.point.x, h.point.y, h.point.z,
                h.object.userData.surfaceClaim || h.object.material?.userData?.surfaceClaim)) continue;
            if (h.point.y <= rayTopY + 0.01 && h.point.y > bestY) bestY = h.point.y;
        }
    }
    // Photo mode: the fixed track deck / trench floor is firm ground. Inside a
    // cut the carve rejects the Google terrain as ghost (isPhotorealGhostGround),
    // the rails trackbed is not a raycast target, and the dressing floor-slab
    // mesh can be momentarily absent (freshly streamed, or not yet rebuilt around
    // a walker who left the cab spawn) — so without this the walker air-dropped
    // onto the track falls straight through it into the void. The authoritative
    // deck height agrees with the ghost-ground floor, is present as soon as the
    // corridor exists, and is capped like the mesh hits (only a walkable step
    // above the ray top) so it never yanks a walker up onto a viaduct from below.
    if (usePhotorealSupport && !activeStructuralCutout && !insideSubsurfaceCorridor) {
        const deckY = photorealCorridorDeckY(localX, localZ);
        if (Number.isFinite(deckY) && deckY <= rayTopY + 0.01 && deckY > bestY) {
            bestY = deckY;
        }
    }
    // A genuine underground space must remain beneath model terrain, but elsewhere
    // getting more than a body-height below the terrain can only be a seam or
    // support miss. Return the terrain even though it is above the short ray;
    // walk physics then snaps the player back instead of letting them fall
    // forever beneath the mountain. An active photo ground authority has no
    // synthetic baseline or recovery plane: its support is the mesh ray below.
    // Runs LAST, after every real support source (baseline, dressing/platform
    // rays, photoreal deck) has answered, and only on a true support deficit
    // (see shouldRecoverTerrainFloor.nearestSupportY).
    const recoverFromTerrainMiss = !usePhotorealSupport
        && !supportContext.suppressRecovery
        && shouldRecoverTerrainFloor(walkerY, finiteRecoveryTargetY, {
            insideSurfaceCutout: activeSurfaceCutout,
            insideStructuralCutout: activeStructuralCutout,
            insideSubsurfaceCorridor: insideSubsurfaceCorridor
                || insideRoadReplacementCorridor,
            nearestSupportY: Number.isFinite(bestY) ? bestY : null,
        });
    if (recoverFromTerrainMiss && Number.isFinite(finiteRecoveryTargetY)
        && finiteRecoveryTargetY > bestY
        && !activeStructuralCutout
        && !insideSubsurfaceCorridor
        && !insideRoadReplacementCorridor) {
        bestY = finiteRecoveryTargetY;
    }
    // Facades are solid walls (resolveWalkStep), so this roof ray now mostly
    // serves standing on a rooftop after a jetpack or parachute landing; it
    // still lifts a walker who somehow ended up inside a block. One ray from
    // above serves both, so buildings are not in the capped list above.
    //
    // Where the building is shader-cut — a courtyard archway, an open cut, a
    // station entrance — its triangles still exist for raycasting but the wall
    // is not there. Walking under an arch must not launch you onto the roof, so
    // the bump is skipped inside those volumes, and so are hits within them.
    const insideBuildingPassage = Number.isFinite(walkerY)
        && isPointInsideBuildingPassageVolume(localX, walkerY + 1.0, localZ);
    if (shouldUseBuildingRoofBump(walkerY, terrainGroundY, {
        insideSurfaceCutout: activeSurfaceCutout,
        insideStructuralCutout: activeStructuralCutout,
        insideSubsurfaceCorridor: insideSubsurfaceCorridor || insideRoadReplacementCorridor,
        insideBuildingPassage,
    })) {
        const roofY = getBuildingRoofY(localX, localZ);
        // A jetpack walker only lands on a roof from above it; see walk.js.
        const airborne = state.cabState?.walkMode?.airborne === true;
        if (shouldAcceptRoofSupport(walkerY, roofY, { airborne }) && roofY > bestY) bestY = roofY;
    }
    const campaignRoofY = campaignTowerRoofYAt(localX, localZ, walkerY);
    if (Number.isFinite(campaignRoofY) && campaignRoofY > bestY) bestY = campaignRoofY;
    const result = Number.isFinite(bestY) ? bestY : null;
    _walkGroundCache.set(key, result);
    _walkGroundPositionCache.set(positionKey, result);
    return result;
}

// Dev probe (tools/walk-probe.mjs and manual console use): the exact ground
// answer walk physics would get, addressable by geo coordinates too.
if (typeof window !== 'undefined') {
    window.__walkGroundDebug = {
        at: (x, z, y) => getWalkGroundY(x, z, y),
        atLatLon(lat, lon, y) {
            const cab = state.cabState;
            if (!cab) return null;
            const local = geoToLocal(lon, lat, cab.anchorLon, cab.anchorLat);
            return { x: local.x, z: local.z, groundY: getWalkGroundY(local.x, local.z, y) };
        },
        roadAlignments: () => state.cabState?.roadVerticalAlignments || null,
        railFormation: () => state.cabState?.railFormation || null,
        // Building walls the walker would collide with around a point, and
        // the resolved end of a step, so a facade pass-through can be
        // diagnosed from the console without a screenshot.
        wallsAtLatLon(lat, lon, y) {
            const cab = state.cabState;
            if (!cab) return null;
            const local = geoToLocal(lon, lat, cab.anchorLon, cab.anchorLat);
            const walkerY = Number.isFinite(y) ? y : (cab.walkMode?.y ?? 0);
            return {
                x: local.x, z: local.z, walkerY,
                packActive: !!cab.campaignWorldPack,
                footprints: walkBuildingFootprintsNear(cab, local.x, local.z, walkerY),
            };
        },
        step: (fromLat, fromLon, toLat, toLon, y) => resolveWalkStep(fromLat, fromLon, toLat, toLon, y),
        packWalls: (x, z, radiusM, verticalRange = null) => campaignWorldPackBuildingFootprintsNear(x, z, radiusM, verticalRange),
    };
}

// Station shells, tunnel trench walls, guard rails and entrance boxes are
// solid boxes here; building facades are resolved separately from their
// footprints in resolveWalkStep.
setWalkColliderSource(() => [
    getUndergroundGroup(),
    getPlatformsGroup(),
    getPlannerElevationGroup(),
    getRoadGradeSeparationsGroup(),
    getProposalsWalkableGroup(),
    getPhotorealWallsGroup(),        // solid stone trench walls in photoreal mode
    // Bore walls + cut retaining walls (explicit yaw boxes on the rail meshes):
    // bumping a tunnel wall must slide the walker, not push them into the hill.
    getRailsGroupForWalkColliders(),
    getGricTunnelLandmarkGroup(),
    getCampaignEnvironmentGroup(),
    getCampaignTowerGroup(),
]);

// Building walls the walker may run into around a point: the baked pack's
// facade index in a packed level, the live footprint index otherwise. An
// underground session owns its own floor and walls, and the photo world has
// no footprints at all.
const WALK_BUILDING_WALL_QUERY_RADIUS_M = 12;
// The loading overlay counts what the build actually downloads: Resource
// Timing reports every response the page received while the hold is up. The
// tile sessions' decoded estimate remains the fallback figure (the API must
// be same-origin or send Timing-Allow-Origin for its sizes to be visible).
let worldTransferObserver = null;
function startWorldTransferObserver() {
    stopWorldTransferObserver();
    if (typeof PerformanceObserver !== 'function') return;
    try {
        worldTransferObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                noteWorldTransferBytes(entry.transferSize || entry.encodedBodySize || 0);
            }
        });
        worldTransferObserver.observe({ type: 'resource' });
    } catch (error) {
        console.warn('[cab] resource timing unavailable for the loading counter', error);
        worldTransferObserver = null;
    }
}
function stopWorldTransferObserver() {
    if (worldTransferObserver) worldTransferObserver.disconnect();
    worldTransferObserver = null;
}

// Free roam follows the real clock, so an evening visit opens on a dark city.
// Say so once the world is visible and offer noon; authored scenes and the
// planner's timetable clock choose their own hour and are left alone.
const DAYLIGHT_HOUR = 12;
function offerDaylightIfNight(cabState) {
    if (state.cabState !== cabState || !cabState.walkMode || cabState.campaignScene) return;
    if (!isSceneClockRealTime() || !isSceneNight()) return;
    ensureNightNotice({ onDaylight: () => setSceneTimeOfDayOverride(DAYLIGHT_HOUR) });
}

function walkBuildingFootprintsNear(cabState, x, z, walkerY) {
    if (cabState.isUndergroundSession || cabState.photoTrackFrame) return [];
    // An authored room owns its floor and walls; the city's facades around it
    // must not seal the player inside the hideout.
    if (resolveCampaignRoom(cabState.campaignScene?.authored?.environment)) return [];
    if (cabState.campaignWorldPack) {
        return campaignWorldPackBuildingFootprintsNear(x, z, WALK_BUILDING_WALL_QUERY_RADIUS_M, {
            minY: walkerY - 1,
            maxY: walkerY + 3,
        });
    }
    return getBuildingFootprintsNear(x, z, WALK_BUILDING_WALL_QUERY_RADIUS_M);
}

// Slides a walk step along whatever it runs into, in lat/lon terms: first the
// civil box colliders, then building facades, which the walker used to pass
// straight through before dropping under the visible ground.
function resolveWalkStep(fromLat, fromLon, toLat, toLon, walkerY) {
    const cabState = state.cabState;
    if (!cabState) return null;
    const anchorLat = cabState.anchorLat;
    const anchorLon = cabState.anchorLon;
    const frame = cabState.photoTrackFrame;
    const from = frame
        ? frame.toScene(fromLon, fromLat, 0)
        : geoToLocal(fromLon, fromLat, anchorLon, anchorLat);
    const to = frame
        ? frame.toScene(toLon, toLat, 0)
        : geoToLocal(toLon, toLat, anchorLon, anchorLat);
    const staticMove = resolveWalkMove(from.x, from.z, to.x, to.z, walkerY) || to;
    const slid = resolveLiftLandingMove(from.x, from.z, staticMove.x, staticMove.z, walkerY);
    const footprints = walkBuildingFootprintsNear(cabState, from.x, from.z, walkerY);
    // Facades with no surveyed base stand on the terrain here, so a jetpack
    // walker above a block clears it instead of being held by a wall that
    // follows their feet upward (core/walk-building-collision.js).
    const wallGroundY = cabState.terrain?.evidenceSceneYAtLocal?.(from.x, from.z);
    const moved = footprints.length === 0 ? slid : resolveWalkAgainstBuildingWalls(
        from.x, from.z, slid.x, slid.z, walkerY, footprints,
        {
            insidePassage: (x, z) => isPointInsideBuildingPassageVolume(x, walkerY + 1.0, z),
            groundY: Number.isFinite(wallGroundY) ? wallGroundY : null,
        },
    );
    if (!moved) return null;
    if (frame) {
        const geo = frame.fromScene(moved.x, walkerY, moved.z);
        return { lat: geo.lat, lon: geo.lon };
    }
    const metresPerDegree = EARTH_RADIUS_M * DEG_TO_RAD;
    const cosLat = Math.cos(anchorLat * DEG_TO_RAD);
    return {
        lat: anchorLat - moved.z / metresPerDegree,
        lon: anchorLon + moved.x / (metresPerDegree * cosLat),
    };
}

// True when the object and every ancestor up to the scene are visible — what
// the renderer actually shows. THREE's Raycaster tests hidden objects too.
function isEffectivelyVisible(object) {
    for (let node = object; node; node = node.parent) {
        if (node.visible === false) return false;
    }
    return true;
}

// Highest building surface above a point, ignoring the step-up limit. Hits
// inside a shader-cut volume are invisible in the scene and must not count.
function getBuildingRoofY(localX, localZ) {
    _walkRayOrigin.set(localX, 1000, localZ);
    _walkRaycaster.set(_walkRayOrigin, _walkRayDir);
    _walkRaycaster.far = 2000;
    let bestY = -Infinity;
    // Landmarks used to need naming here as a third group of their own. They are
    // streamed buildings now, so getBuildingsGroup() already contains them and
    // walking into one is stopped by the same ray as any other wall.
    for (const group of [getBuildingsGroup(), getProposalsBuildingsGroup()]) {
        if (!group || group.visible === false) continue;
        for (const hit of collectVisibleRayHits(_walkRaycaster, group)) {
            // Demolished proposal-track buildings remain only as transparent
            // planning silhouettes; they are not physical roofs or walls.
            if (hit.object?.userData?.proposalTrackDemolitionGhost) continue;
            // A transparent rooftop-pool surface is visible water, not firm
            // roof support. Its shared material carries this through regional
            // batching, so the ray continues to the modeled basin bottom.
            const hitMaterial = hit.object?.material;
            if (!Array.isArray(hitMaterial)
                && hitMaterial?.userData?.walkSupport === false) continue;
            // Raycaster does not honour visibility, so a HIDDEN proposal
            // building (display state ghost/off) would still lift the walker
            // onto an invisible roof. Effective visibility = the whole chain:
            // ghost prisms hide via their group, solid meshes individually.
            if (!isEffectivelyVisible(hit.object)) continue;
            if (hit.point.y <= bestY) continue;
            if (isPointInsideBuildingPassageVolume(hit.point.x, hit.point.y, hit.point.z)) continue;
            bestY = hit.point.y;
        }
    }
    return Number.isFinite(bestY) ? bestY : null;
}

function getRooftopY(localX, localZ) {
    return getWalkGroundY(localX, localZ, 999)
        ?? state.cabState?.terrain?.evidenceSceneYAtLocal?.(localX, localZ)
        ?? null;
}

function canonicalKeyForAction(action) {
    return ({
        [SESSION_ACTIONS.MOVE_FORWARD]: 'w',
        [SESSION_ACTIONS.MOVE_BACKWARD]: 's',
        [SESSION_ACTIONS.TURN_LEFT]: 'a',
        [SESSION_ACTIONS.TURN_RIGHT]: 'd',
        [SESSION_ACTIONS.JETPACK]: ' ',
        [SESSION_ACTIONS.WALK_BOOST]: 'shift',
        [SESSION_ACTIONS.THROTTLE]: 'w',
        [SESSION_ACTIONS.BRAKE_REVERSE]: 's',
        [SESSION_ACTIONS.STEER_LEFT]: 'a',
        [SESSION_ACTIONS.STEER_RIGHT]: 'd',
        [SESSION_ACTIONS.RAIL_TURN_LEFT]: 'a',
        [SESSION_ACTIONS.RAIL_TURN_RIGHT]: 'd',
        [SESSION_ACTIONS.AIRCRAFT_PITCH_DOWN]: 'w',
        [SESSION_ACTIONS.AIRCRAFT_PITCH_UP]: 's',
        [SESSION_ACTIONS.AIRCRAFT_THROTTLE_UP]: ' ',
        [SESSION_ACTIONS.AIRCRAFT_THROTTLE_DOWN]: 'x',
        [SESSION_ACTIONS.AIRCRAFT_THROTTLE_HOLD]: 'q',
    })[action] || null;
}

function sampleExternalPose(cabState, loadingHold) {
    const sampledPose = cabState.poseFn({ paused: cabState.simPaused || loadingHold });
    if (!sampledPose) return null;
    if (cabState.simPaused) {
        if (!cabState.simPausedPose) {
            cabState.simPausedPose = snapshotCabPose(
                cabState.lastRenderedPose || cabState.lastAutoPose || sampledPose,
            );
        }
        return snapshotCabPose(cabState.simPausedPose);
    }
    cabState.lastAutoPose = sampledPose;
    return sampledPose;
}

function stepFootController(cabState, dt) {
    const backgroundStartedAt = performance.now();
    cabState.gtaSession?.backgroundStep?.(dt);
    recordLayerFrameMs('foot:background', performance.now() - backgroundStartedAt);
    const aLat = cabState.anchorLat;
    const aLon = cabState.anchorLon;
    const localXZ = cabState.photoTrackFrame
        ? (lat, lon) => cabState.photoTrackFrame.toScene(lon, lat, 0)
        : (lat, lon) => geoToLocal(lon, lat, aLon, aLat);
    const resolveFreeRoamMove = sessionCapabilityEnabled(
        cabState.sessionCapabilities,
        SESSION_CAPABILITY.CROATIA_BOUNDS,
    )
        ? (fromLat, fromLon, toLat, toLon, walkerY) => {
            const moved = resolveWalkStep(fromLat, fromLon, toLat, toLon, walkerY);
            const targetLat = Number(moved?.lat ?? toLat);
            const targetLon = Number(moved?.lon ?? toLon);
            return !worldProviderContains(targetLat, targetLon)
                ? { lat: fromLat, lon: fromLon }
                : moved;
        }
        : resolveWalkStep;
    let collisionMs = 0;
    let groundMs = 0;
    const measuredGroundY = (x, z, walkerY) => {
        const startedAt = performance.now();
        try {
            const groundY = getWalkGroundY(x, z, walkerY);
            // Anyone over the mapped sea stands on the water — a parachutist,
            // a jetpack jumper, a walker stepping off the quay — not on the
            // sea floor the terrain sample describes, or on nothing at all.
            return isPointInMappedSea(x, z)
                ? seaSurfaceSupportY(groundY, mappedSeaSurfaceSceneY())
                : groundY;
        } finally {
            groundMs += performance.now() - startedAt;
        }
    };
    const measuredResolveMove = (fromLat, fromLon, toLat, toLon, walkerY) => {
        const startedAt = performance.now();
        try {
            return resolveFreeRoamMove(fromLat, fromLon, toLat, toLon, walkerY);
        } finally {
            collisionMs += performance.now() - startedAt;
        }
    };
    const walkStartedAt = performance.now();
    const extras = cabState.passengerLiftRide?.step(dt) || stepWalk(
        cabState.walkMode,
        worldChoicesOpen() ? 0 : dt,
        getCameraLook().yaw,
        measuredGroundY,
        localXZ,
        measuredResolveMove,
    );
    const walkMs = performance.now() - walkStartedAt;
    recordLayerFrameMs('foot:collision', collisionMs);
    recordLayerFrameMs('foot:ground', groundMs);
    recordLayerFrameMs('foot:walk-other', Math.max(0, walkMs - collisionMs - groundMs));
    const poseStartedAt = performance.now();
    const pose = sampleExternalPose(cabState, cabState.controllerFrame?.loadingHold);
    recordLayerFrameMs('foot:pose', performance.now() - poseStartedAt);
    if (!pose) return null;
    // Local metres and a person-convention heading (+Z forward), so a
    // player-relative film and the on-foot pursuit read the walker the way
    // they read a vehicle pose.
    const footLocal = localXZ(pose.lat, pose.lon);
    const footYawRad = extras.headingDeg * DEG_TO_RAD;
    return {
        ...pose,
        x: footLocal.x,
        z: footLocal.z,
        heading: Math.atan2(Math.sin(footYawRad), -Math.cos(footYawRad)),
        y: extras.y,
        terrainSupportReady: extras.supportReady,
        airborne: extras.airborne,
        parachute: extras.parachute,
        verticalSpeedMps: extras.verticalSpeedMps,
        jetpackHeld: extras.jetpackHeld,
        horizontalDistM: extras.horizontalDistM,
        landed: extras.landed,
        impactSpeedMps: extras.impactSpeedMps,
    };
}

function stepRailController(cabState, dt) {
    const profilePhases = isPerformanceProfilingActive();
    let phaseStartedAt = profilePhases ? performance.now() : 0;
    const finishPhase = profilePhases
        ? (label) => {
            const endedAt = performance.now();
            recordLayerFrameMs(`railCtl:${label}`, endedAt - phaseStartedAt);
            phaseStartedAt = endedAt;
        }
        : null;
    cabState.gtaSession?.backgroundStep?.(dt);
    finishPhase?.('background');
    refreshAmbientTramRailGraph(cabState);
    finishPhase?.('graph-refresh');
    if (cabState.driver?.enabled) {
        if (cabState.campaignRailDerail) {
            cabState.driver.autopilot = false;
            cabState.driver.throttleTarget = -1;
            cabState.driver.throttle = Math.min(cabState.driver.throttle, -0.82);
        }
        if (cabState.driver.autopilot && !cabState.simPaused) {
            const current = computeDriverPose(cabState.driver, cabState.driverGraph);
            finishPhase?.('autopilot-pose');
            applyAutopilotControls(cabState, current);
            finishPhase?.('autopilot-controls');
        }
        driverStep(cabState.driver, cabState.driverGraph, cabState.switchRules, dt);
        finishPhase?.('driver-step');
        const pose = computeControlledRailPose(cabState);
        finishPhase?.('pose');
        return pose;
    }
    const pose = sampleExternalPose(cabState, cabState.controllerFrame?.loadingHold);
    finishPhase?.('external-pose');
    return pose;
}

function makeController({
    cabState,
    kind,
    step,
    action,
    cameraProfile,
    stop,
    exitState,
    deactivate = () => {},
    dispose = () => {},
}) {
    return {
        activate() { return true; },
        handleAction: action || (() => false),
        step,
        getCameraProfile: cameraProfile || (() => ({ kind })),
        requestStop: stop || (() => false),
        getExitState: exitState || (() => null),
        deactivate,
        dispose,
    };
}

function createSessionControllerRouter(cabState) {
    const router = createControllerRouter();
    router.register('foot', makeController({
        cabState,
        kind: 'foot',
        step: dt => stepFootController(cabState, dt),
        action(action, phase) {
            if (action === SESSION_ACTIONS.CAMERA && phase === 'press') {
                return cycleWalkCameraMode(cabState);
            }
            const key = canonicalKeyForAction(action);
            if (!key) return false;
            if (phase === 'release') walkKeyUp(key);
            else walkKeyDown(key);
            setWalkControlPressed(key, phase !== 'release');
            return true;
        },
        cameraProfile: () => ({ kind: 'foot', mode: cabState.walkCameraMode }),
        deactivate() { clearWalkKeys(); },
    }));

    const roadAction = (action, phase) => {
        if (action === SESSION_ACTIONS.CAMERA && phase === 'press') {
            return cabState.gtaSession?.cycleCamera?.() || false;
        }
        if (action === SESSION_ACTIONS.STOP && phase === 'press') {
            return cabState.gtaSession?.requestStop?.() || false;
        }
        if (action === SESSION_ACTIONS.RESET && phase === 'press') {
            return cabState.gtaSession?.resetVehicle?.() || false;
        }
        const key = canonicalKeyForAction(action);
        if (!key) return false;
        return phase === 'release'
            ? cabState.gtaSession?.handleKeyUp?.(key) || false
            : cabState.gtaSession?.handleKeyDown?.(key, { repeat: phase === 'repeat' }) || false;
    };
    if (cabState.gtaSession) {
        for (const kind of enabledVehicleControllerKinds(cabState.sessionCapabilities)) {
            router.register(kind, makeController({
                kind,
                step(dt) {
                    const gtaPose = cabState.gtaSession?.step?.(dt);
                    if (!gtaPose) return null;
                    return {
                        lat: gtaPose.lat,
                        lon: gtaPose.lon,
                        headingDeg: gtaPose.headingDeg,
                        y: gtaPose.y,
                        status: {
                            speedKmh: gtaPose.speedKmh,
                            gtaMode: true,
                            driving: true,
                            vehicleKind: kind,
                            vehicleHealth: gtaPose.health,
                            // Flight state the campaign reads from the session
                            // snapshot: whether the aircraft is in the air, what
                            // it last came down on, and how.
                            vehicleAirborne: gtaPose.airborne === true,
                            vehicleSurface: gtaPose.surface || null,
                            vehicleVerticalSpeedMps: finiteOrNull(gtaPose.verticalSpeedMps),
                            vehicleTouchdown: gtaPose.touchdown || null,
                            engineFailed: gtaPose.engineFailed === true,
                        },
                        gtaPose,
                    };
                },
                action: roadAction,
                cameraProfile: () => ({
                    kind,
                    mode: 'vehicle',
                    pose: cabState.gtaSession?.getCameraPose?.() || null,
                }),
                stop: () => cabState.gtaSession?.requestStop?.() || false,
                exitState: () => cabState.gtaSession?.getInteractionState?.(
                    gtaInteractionLocal(cabState),
                ) || null,
                deactivate() { cabState.gtaSession?.clearControls?.(); },
            }));
        }
    }

    if (!cabState.walkMode || sessionCapabilityEnabled(
        cabState.sessionCapabilities,
        SESSION_CAPABILITY.AMBIENT_TRAMS,
    ) || (cabState.campaignScene?.authored?.railVehicles || []).length > 0) {
        router.register('rail', makeController({
            cabState,
            kind: 'rail',
            step: dt => stepRailController(cabState, dt),
            action(action, phase) {
                if (action === SESSION_ACTIONS.CAMERA && phase === 'press') {
                    cycleCameraMode(cabState);
                    return true;
                }
                // A scripted derail is terminal. Keep the camera available so
                // the player can see it, but do not let traction, doors, or a
                // switch command cancel the failure beat before retry.
                if (cabState.campaignRailDerail) return true;
                if (action === SESSION_ACTIONS.BELL && phase === 'press') {
                    playTramBell();
                    return true;
                }
                if (action === SESSION_ACTIONS.DOORS && phase === 'press') {
                    togglePlayerDoors();
                    return true;
                }
                if (action === SESSION_ACTIONS.PARKING_BRAKE && phase === 'press') {
                    togglePlayerParkingBrake();
                    return true;
                }
                if (![SESSION_ACTIONS.THROTTLE, SESSION_ACTIONS.BRAKE_REVERSE,
                    SESSION_ACTIONS.RAIL_TURN_LEFT, SESSION_ACTIONS.RAIL_TURN_RIGHT]
                    .includes(action)) return false;
                if ((!cabState.driver || !cabState.driver.enabled) && phase !== 'release') {
                    enableDriverMode();
                } else if (cabState.driver?.autopilot && phase !== 'release') {
                    cabState.driver.autopilot = false;
                }
                const driver = cabState.driver;
                if (!driver?.enabled) return false;
                if (action === SESSION_ACTIONS.THROTTLE) {
                    driver.throttleTarget = phase === 'release' ? 0
                        : (throttleBlockedByParkingBrake(cabState)
                            || throttleBlockedByDoors(cabState)) ? 0 : 1;
                } else if (action === SESSION_ACTIONS.BRAKE_REVERSE) {
                    driver.throttleTarget = phase === 'release' ? 0 : -1;
                } else if (phase !== 'release') {
                    driver.armedTurn = action === SESSION_ACTIONS.RAIL_TURN_LEFT
                        ? 'left'
                        : 'right';
                }
                updateDriverControls();
                return true;
            },
            cameraProfile: () => ({ kind: 'rail', mode: cabState.cameraMode }),
            stop() {
                if (!cabState.driver?.enabled) enableDriverMode();
                if (!cabState.driver?.enabled) return false;
                cabState.driver.throttleTarget = -1;
                return true;
            },
            exitState: () => cabState.ambientTramClaim ? {
                speedMps: Math.abs(Number(cabState.driver?.speed) || 0),
            } : null,
            deactivate() {
                if (cabState.driver) cabState.driver.throttleTarget = 0;
            },
        }));
    }
    router.activate(cabState.walkMode ? 'foot' : 'rail', cabState, 'session-start');
    return router;
}

// ─── Main frame hook ───────────────────────────────────────────────────────

function cabStep() {
    const cabState = state.cabState;
    if (!cabState) return;
    // Normally Scene.onAfterRender already did this. It is also a failsafe for
    // a zero-size canvas or interrupted render pass.
    restoreAbsoluteRenderCoordinates();
    cabState.layerStartup?.tick();
    // Complete prepared ground groups before support queries and physics.
    // Layer onFrame hooks below may prepare successors for the next frame.
    if (cabState.groundPublications?.publishReady()) {
        recordLayerFrameMs('ground:publish', cabState.groundPublications.snapshot().lastCommitMs);
    }

    // Failsafe release for the model-world loading hold: a stalled or feature-empty
    // area can never trap the overlay past the world-ready timeout.
    tickWorldReady();
    // Model loading bar: a segment per streaming component, greened as it settles.
    const modelLoading = isWorldBuilding() || cabState.initialWorldPending === true;
    if (modelLoading) {
        setWorldLoadComponents(getWorldLoadComponents());
        setWorldLoadTelemetry(getWorldLoadTelemetry());
    }

    // Hold the ride OR the walk while the photo world is still loading, showing
    // the "Loading surroundings" pill + bar — regardless of how it was entered.
    // A DIRECT walk (from the map) starts unrevealed so it holds like the cab; a
    // walk entered FROM the cab is already revealed (tiles cached) so this is a
    // no-op there. photoreal.onFrame keeps revealing even with dt frozen (its
    // dtS falls back to 0.016), so the hold always releases.
    const photoLoading = isPhotoWorld() && !isPhotorealRevealed();
    setPhotoLoading(photoLoading);
    if (photoLoading) {
        setPhotoLoadProgress(getPhotorealLoadProgress());
        setPhotoLoadTelemetry(getPhotorealLoadTelemetry());
        setLoadingCurtainProgress({ fraction: getPhotorealLoadProgress() });
    } else if (isPhotoWorld() && !cabState.campaignScene && cabState.photoCurtainPending !== false) {
        // The photo world reveals itself, and the loading screen goes with the reveal.
        cabState.photoCurtainPending = false;
        dropLoadingCurtain();
    }

    // Photo world terminally unavailable (registration timeout, tiles failure):
    // the session continues in the model world, so the model-only layers the
    // world contract skipped at start must build now — otherwise the fallback
    // is a bare track ribbon with no civil works.
    if (isPhotoWorld() && isPhotorealUnavailable()
        && cabState.worldSkippedEntries && cabState.worldSkippedEntries.length) {
        const lateEntries = cabState.worldSkippedEntries;
        cabState.worldSkippedEntries = [];
        for (const entry of lateEntries) {
            void cabState.layerStartup.start(entry);
        }
    }

    const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let dt = cabState.lastFrameMs ? (nowMs - cabState.lastFrameMs) / 1000 : 0;
    cabState.lastFrameMs = nowMs;
    if (dt > 0.1) dt = 0.1;
    if (cabState.simPaused) dt = 0;
    // Freeze the sim while the loading hold is up: the scene is hidden anyway, and
    // advancing would teleport the tram forward on reveal and keep streaming new
    // tiles ahead (so the near-field queues would never all settle). lastFrameMs is
    // still updated above, so the first revealed frame resumes with a small dt.
    if (modelLoading) dt = 0;
    if (photoLoading) dt = 0;   // freezes driver-mode motion during the photo hold

    abandonDestroyedAmbientTram(cabState);
    // External schedule-backed pose sources own their own wall clocks. Passing
    // the same hold state to them is load-bearing: dt=0 freezes controllers we
    // step here, but cannot by itself stop a poseFn from moving the hidden tram
    // and making every streaming ring chase it during startup.
    cabState.controllerFrame = {
        photoLoading,
        loadingHold: modelLoading || photoLoading,
    };
    const controllerStartedAt = performance.now();
    const pose = cabState.controllerRouter?.step(dt);
    const activeControllerId = cabState.controllerRouter?.activeId || '';
    const gtaDriving = GTA_VEHICLE_CONTROLLER_IDS.has(activeControllerId);
    const controllerCameraProfile = cabState.controllerRouter?.getCameraProfile() || {
        kind: cabState.walkMode ? 'foot' : 'rail',
    };
    const gtaPose = pose?.gtaPose || null;
    const controllerElapsedMs = performance.now() - controllerStartedAt;
    if (gtaDriving) recordLayerFrameMs('gta-physics', controllerElapsedMs);
    else recordLayerFrameMs(`controller:${activeControllerId || 'none'}`, controllerElapsedMs);
    if (!pose) return;

    const status = pose.status || (pose.status = {});
    status.controlsHintKey = controlsHintKeyFor(activeControllerId, {
        railDoors: !cabState.ambientTramClaim,
        train: cabState.ambientTramClaim?.kind === 'train',
        enterable: hasEnterableVehicleCapability(cabState.sessionCapabilities),
        parachute: cabState.walkMode?.parachute === true && cabState.walkMode.airborne === true,
    });
    // The derived on-foot flag. See isPlayerOnFoot for why this is not
    // simply cabState.walkMode.
    status.walkMode = !!cabState.walkMode && !gtaDriving;
    // A campaign on foot reads its objective, not instruments: walking
    // speed and height above ground say nothing about the story and cost
    // a phone the top third of its frame.
    status.campaignOnFoot = status.walkMode && !!cabState.campaignScene;
    if (headerSyncedOnFoot !== status.walkMode) {
        headerSyncedOnFoot = status.walkMode;
        // The turret belongs to the vehicle, so getting out stows it rather
        // than leaving a gun floating over an empty car.
        if (status.walkMode && isWeaponAttached()) {
            setCabGameMode(cabState, 'simulation');
        }
        syncHeaderActionButtons(cabState);
    }
    status.gtaMode = cabState.sessionPresetId === 'gta';
    status.expandedBuildingStreaming = sessionCapabilityEnabled(
        cabState.sessionCapabilities,
        SESSION_CAPABILITY.EXPANDED_BUILDING_STREAMING,
    );
    status.driving = gtaDriving;
    status.routeDirectionLabel = cabState.routeDirectionLabel || '';
    status.railMode = cabState.railMode || '';
    status.trackGaugeMm = cabState.trackGaugeMm;
    const stopGuide = cabState.playerService ? findPlayerStopGuide(cabState, pose) : null;
    if (cabState.playerService) {
        status.totalPassengers = cabState.playerService.totalPassengers;
        status.capacity = cabState.playerService.capacity;
        status.balanceEur = cabState.playerService.balanceEur;
        status.lastBoarded = cabState.playerService.lastBoarded;
        status.lastAlighted = cabState.playerService.lastAlighted;
        // Only Zagreb has boarding demand + fares; elsewhere the counter is
        // static ("8/200 · 0 EUR"), so the HUD hides it (getLocation memoizes).
        status.passengersSupported = !!getLocation()?.passengers;
    }
    updatePlayerDoors(cabState, pose, dt);
    if (cabState.doors) status.doorsOpen = cabState.doors.ratio > DOOR_INTERLOCK_RATIO;
    if (cabState.parkingBrake !== undefined) status.parkingBrake = !!cabState.parkingBrake;
    updatePlayerServiceStop(cabState, pose);
    updateTrainPlatformExchange(cabState, pose);
    // Departure UI reads the same deadline as the driver autopilot. It never
    // starts a second timer: manual driving explicitly has no countdown, and
    // an expired dwell remains in a waiting state until the doors are closed.
    if (cabState.driver && cabState.driver.enabled && status.paused) {
        if (cabState.driver.autopilot && cabState.autopilotStopWaitUntil) {
            const dwellNowMs = cabState.simPaused && cabState.simPauseStartedMs
                ? cabState.simPauseStartedMs
                : performance.now();
            const remainMs = cabState.autopilotStopWaitUntil - dwellNowMs;
            status.departureAutomatic = true;
            status.dwellRemainingS = Math.max(0, remainMs / 1000);
            status.departureBlockedByDoors = remainMs <= 0
                && !!cabState.doors
                && cabState.doors.ratio > DOOR_INTERLOCK_RATIO;
        } else {
            status.departureAutomatic = false;
            status.dwellRemainingS = null;
            status.departureBlockedByDoors = false;
        }
    }
    status.stopGuide = !status.paused && stopGuide
        ? {
            name: stopGuide.name,
            remainingDistanceM: stopGuide.remainingDistanceM,
            inBand: stopGuide.inBand,
        }
        : null;

    // ASL photo rides use the same exact WGS84 tangent frame as Google tiles.
    // This includes globe curvature without ever adding Google terrain to the
    // authored profile. Cab, rails and corridor therefore share one scene Y.
    const photoPosePoint = !cabState.walkMode
        && cabState.photoTrackFrame
        && Number.isFinite(Number(pose.y))
        ? cabState.photoTrackFrame.toScene(pose.lon, pose.lat, Number(pose.y))
        : null;
    const local = photoPosePoint
        || (cabState.photoTrackFrame
            ? cabState.photoTrackFrame.toScene(pose.lon, pose.lat, 0)
            : geoToLocal(pose.lon, pose.lat, cabState.anchorLon, cabState.anchorLat));
    cabState.lastLocal = { x: local.x, y: finiteOrNull(pose.y) ?? 0, z: local.z };
    // Surface streaming keeps the player's exact position as its hard support
    // anchor, then ranks a second point down the measured vehicle velocity.
    // This gives terrain/road formation time to finish without making a skid,
    // reverse or sharp turn prefetch the street the bonnet happens to face.
    const surfacePreload = modelLoading ? cabState.driveSurfacePreload : null;
    const surfaceStreamingFocus = surfacePreload?.priority
        || (gtaDriving ? vehicleSurfaceStreamingFocus({
            local,
            vehiclePose: gtaPose,
            headingDeg: pose.headingDeg,
        }) : railSurfaceStreamingFocus(cabState, local, pose));
    pose.surfaceStreamingFocus = surfaceStreamingFocus;
    pose.surfaceStreamingPreload = surfacePreload;
    cabState.surfaceStreamingFocus = surfaceStreamingFocus;
    if (cabState.ambientTramClaim) {
        cabState.ambientTramClaim.provider.sync(cabState.ambientTramClaim.id, {
            ...pose,
            x: local.x,
            z: local.z,
            speedMps: Number(cabState.driver?.speed) || 0,
            doorRatio: Number(cabState.doors?.ratio) || 0,
            visible: cabState.cameraMode === 'third',
            osmId: railSourceOsmId(cabState),
        });
    }
    // Tick the 🏚️ counter as the ride drives past each demolished building.
    markTrackDemolitionPassed(pose.lat, pose.lon);
    // Dev-only: publish the current sim position (localhost only, mutating a
    // reused object — no per-frame allocation) for the perf overlay's map links.
    if (simLatLon && Number.isFinite(pose.lat) && Number.isFinite(pose.lon)) {
        simLatLon.lat = pose.lat;
        simLatLon.lon = pose.lon;
        simLatLon.headingDeg = Number(pose.headingDeg) || 0;
        window.__simLatLon = simLatLon;
    }
    const terrainGroundY = cabState.terrain
        ? cabState.terrain.evidenceSceneYAt?.(pose.lon, pose.lat)
        : 0;
    // referenceY = the height we are already riding, so a plan crossing (a
    // tunnel track passing under a crossing track, as at Brajdica) resolves to
    // the level we are ON rather than snapping to the other track for a frame.
    // smoothedGroundY holds the PREVIOUS frame's height here (it is updated
    // below), which is exactly the continuity signal we want; null on the first
    // frame / after a seek falls back to plan-nearest.
    // A GTA road/water/air vehicle is never on the rail formation, so it must not
    // take its chainage, grade or ground datum from one — a campaign car driving
    // over a modelled line would otherwise be handed that line's rail height as
    // its own ground. (Free-roam GTA keeps cabState.walkMode set while driving,
    // so it was already excluded; this makes the rule hold either way.)
    const railFormationAtPose = !cabState.walkMode && !gtaDriving
        ? cabState.railFormation?.formationAtLocal(local.x, local.z, {
            referenceY: cabState.smoothedGroundY,
        })
        : null;
    // Vertical position for both the camera and the tram mesh (via poseY). Use
    // the rail formation's CONTINUOUS scene-Y — the authored profile, and its
    // OWN base as the only fallback — rather than snapping to the bare DTM when
    // the pose grazes the formation's query radius near curves/junctions. That
    // rail-vs-terrain datum switch (differing by the whole cut/fill depth) was
    // the source of the camera wobble.
    const bakedRailSurface = !cabState.walkMode && !gtaDriving && cabState.campaignWorldPack
        ? campaignWorldPackRailSurfaceAtLocal(local.x, local.z, {
            referenceY: cabState.smoothedGroundY,
            headingDeg: pose.headingDeg,
            profilePitchDeg: pose.pitchDeg,
        }) : null;
    const authoredAbsolutePoseY = authoredAbsoluteRailSceneY({
        elevationM: pose.y,
        elevationMode: pose.elevationMode,
        elevationDatum: pose.elevationDatum,
        absoluteToSceneY: heightM => {
            const formationY = finiteOrNull(
                cabState.railFormation?.absoluteSceneYAtHeight?.(heightM),
            );
            return formationY !== null
                ? formationY
                : cabState.terrain?.absoluteToSceneY?.(heightM);
        },
    });
    let rawGroundY;
    let railGroundAuthoritative = false;
    if (cabState.walkMode || gtaDriving) {
        // Walk poseY is 0 and unused. A GTA vehicle rides the terrain/roads, not
        // the rail formation, so its ground is the terrain under it — that is
        // also the surface the aircraft's height-above-ground gauge reports.
        rawGroundY = terrainGroundY;
    } else if (authoredAbsolutePoseY !== null) {
        // Planner rail rides already carry the immutable EVRF2000 profile at
        // their exact chainage. Use it directly instead of re-selecting a
        // nearby formation triangle every frame; the latter can change owner
        // at crossings or publication boundaries and make the cab bob even
        // though the designed alignment itself is continuous.
        rawGroundY = authoredAbsolutePoseY;
        railGroundAuthoritative = true;
    } else if (bakedRailSurface) {
        rawGroundY = bakedRailSurface.railY;
        railGroundAuthoritative = true;
    } else if (railFormationAtPose) {
        rawGroundY = railFormationAtPose.railY;
        railGroundAuthoritative = true;
    } else if (cabState.railFormation) {
        // The published formation remains authoritative where present. A miss
        // may use genuine local terrain evidence, but never the visible fallback
        // datum: hold/hide below until the DTM window reaches this point.
        const formationGroundY = cabState.railFormation.sceneYAtLocal(local.x, local.z, {
            referenceY: cabState.smoothedGroundY,
        });
        if (Number.isFinite(formationGroundY)) {
            rawGroundY = formationGroundY;
            railGroundAuthoritative = true;
        } else {
            rawGroundY = terrainGroundY;
        }
    } else {
        rawGroundY = terrainGroundY;                    // no engineered formation
    }
    // EMA-smooth it, mirroring the heading/pitch smoothing, to absorb any
    // residual step. Camera and tram mesh both consume this via poseY, so they
    // stay in sync. Hold (don't lerp) on the first frame and while paused.
    const terrainPlacementReady = sessionPoseReadyForPublication({
        photoPoseReady: !!photoPosePoint,
        vehicleController: gtaDriving,
        footController: controllerCameraProfile.kind === 'foot',
        terrainSupportReady: pose.terrainSupportReady,
        terrainPresent: !!cabState.terrain,
        groundY: rawGroundY,
    });
    if (Number.isFinite(rawGroundY)) {
        if (cabState.smoothedGroundY == null || cabState.simPaused) {
            cabState.smoothedGroundY = rawGroundY;
        } else {
            cabState.smoothedGroundY += (rawGroundY - cabState.smoothedGroundY) * GROUND_Y_SMOOTH;
        }
    }
    const vehicleGroundY = finiteOrNull(cabState.smoothedGroundY) ?? 0;
    const poseY = composeRailVehicleSceneY({
        walkMode: !!cabState.walkMode,
        photoSceneY: photoPosePoint?.y,
        formationSceneY: railGroundAuthoritative ? vehicleGroundY : null,
        authoredAbsoluteSceneY: authoredAbsolutePoseY,
        groundSceneY: vehicleGroundY,
        relativePoseY: pose.y,
    });
    // Prefer the rail formation's chainage/grade (tram-sim rides); fall back to
    // whatever the pose supplied (planner rides carry no formation).
    // stationM is distance along the loaded formation, not stacionaža from the
    // line's origin. A free-roam ride stays on one formation, so the two read
    // alike; the campaign hops between authored segments hundreds of km apart,
    // where it read km 2+083 leaving Split and km 2+462 in Lika. There is no
    // authored line datum to correct it with, so a campaign scene shows no
    // chainage rather than a number that looks like one and is not.
    status.chainageM = cabState.campaignScene
        ? null
        : railFormationAtPose?.stationM ?? status.chainageM ?? null;
    // Authored rail grade drives the gaze pitch. When the formation lookup grazes
    // its query radius (curves/junctions) it returns null, and the pitch would
    // otherwise snap to the noisy terrain-slope fallback — a head-bob in bends.
    // Hold the last good grade across a miss so the pitch stays on the rail datum.
    const authoredAbsoluteGrade = authoredAbsoluteRailGrade({
        pitchDeg: pose.pitchDeg,
        elevationMode: pose.elevationMode,
        elevationDatum: pose.elevationDatum,
    });
    let signedGrade = authoredAbsoluteGrade ?? bakedRailSurface?.grade ?? (railFormationAtPose
        ? cabState.railFormation?.gradeAlongHeadingForFormation(railFormationAtPose, pose.headingDeg)
        : null);
    if (Number.isFinite(signedGrade)) {
        cabState.lastSignedGrade = signedGrade;
    } else if (Number.isFinite(cabState.lastSignedGrade)) {
        signedGrade = cabState.lastSignedGrade;
    }
    status.gradePercent = Number.isFinite(signedGrade) ? signedGrade * 100 : (status.gradePercent ?? null);

    // Schedule-autopilot poses don't carry speedKmh (tram-sim never sets
    // it), which left the dashboard speed instrument blank outside driver
    // mode — derive it from pose deltas so the speedo works in every ride.
    if (pose.status && !Number.isFinite(Number(pose.status.speedKmh))) {
        const nowMs = performance.now();
        const probe = cabState.speedProbe;
        if (probe && nowMs > probe.t && nowMs - probe.t < 1000) {
            const dM = haversineMeters(probe.lat, probe.lon, pose.lat, pose.lon);
            const instKmh = (dM / ((nowMs - probe.t) / 1000)) * 3.6;
            cabState.probeSpeedKmh = (cabState.probeSpeedKmh ?? instKmh) * 0.85 + instKmh * 0.15;
        }
        cabState.speedProbe = { lat: pose.lat, lon: pose.lon, t: nowMs };
        pose.status.speedKmh = Math.round(cabState.probeSpeedKmh || 0);
    }
    if (!cabState.simPaused && terrainPlacementReady) {
        cabState.lastRenderedPose = snapshotCabPose(pose);
    }

    // Altitude gauge. Photoreal sessions show the real altitude above sea level
    // (worldY − seated sea-level offset) for both the cab and the walker; other
    // sessions show planner metres plus the DGU-terrain offset when that layer
    // is active. The two never overlap: isTerrainRequested() refuses ?rw
    // sessions, so cabState.terrain is null whenever seaOffset is set.
    {
        const seaOffset = getPhotorealAltitudeOffset();
        let altitudeM;
        let altitudeAbsolute;
        let pitchGradePct = null;
        if (cabState.photoTrackFrame && !cabState.walkMode && Number.isFinite(Number(pose.y))) {
            // The vehicle rides the authored EVRF2000 profile, so its displayed
            // altitude comes straight from that source—not from a Google ray hit.
            altitudeM = cabState.photoTrackFrame.heightOriginM + Number(pose.y);
            altitudeAbsolute = true;
            pitchGradePct = Number.isFinite(pose.pitchDeg)
                ? Math.tan(pose.pitchDeg * Math.PI / 180) * 100
                : null;
        } else if (cabState.photoTrackFrame && cabState.walkMode && Number.isFinite(Number(pose.y))) {
            altitudeM = cabState.photoTrackFrame.fromScene(local.x, Number(pose.y), local.z).heightM;
            altitudeAbsolute = true;
        } else if (seaOffset != null) {
            const worldY = (Number.isFinite(cabState.trackBaseY) ? cabState.trackBaseY : 0)
                + (Number.isFinite(pose.y) ? pose.y : 0);
            // Live grade % from the cab pitch (train poses carry pitchDeg on
            // elevation-aware routes; the walker has none and shows only m).
            pitchGradePct = !cabState.walkMode && Number.isFinite(pose.pitchDeg)
                ? Math.tan(pose.pitchDeg * Math.PI / 180) * 100
                : null;
            altitudeM = worldY - seaOffset;
            altitudeAbsolute = true;
        } else {
            // A GTA vehicle's controller already publishes an ABSOLUTE scene Y
            // (the Rapier chassis translation, or the arcade solver's own
            // integrated height). poseY is the rail composition, which adds a
            // ground datum to a relative offset — feeding it a vehicle that is
            // already absolute pinned the altimeter to the terrain, so a climb
            // to 2 km still read the 106 m of the runway below.
            const readoutSceneY = gtaDriving
                ? (finiteOrNull(pose.y) ?? vehicleGroundY)
                : poseY;
            altitudeM = (Number.isFinite(cabState.trackBaseY) ? cabState.trackBaseY : 0) +
                (cabState.terrain ? cabState.terrain.anchorHeightM : 0) +
                // `cabState.walkMode` survives while you drive — it is the walk
                // state you get back on exit, not "the player is walking". Test
                // it together with gtaDriving. On foot, use the walker too:
                // an upper terrace must not report the street below it.
                (cabState.walkMode && !gtaDriving
                    ? (finiteOrNull(pose.y) ?? vehicleGroundY)
                    : readoutSceneY);
            altitudeAbsolute = false;
            // An authored interior is lifted clear of the streamed world by
            // elevationOffsetM (the Grič rooms sit 80 m up). That lift is a
            // staging trick, not height: leaving it in made a tunnel under a
            // 155 m hill report 213 m, and 80 m when the same room was entered
            // without terrain loaded. Applied outside the scene-Y selection
            // above so that expression stays a pure function of the pose.
            altitudeM -= campaignRoomElevationOffsetM(
                cabState.campaignScene?.authored?.environment,
            );
        }
        // Altitude · grade · chainage render as one metrics instrument, driven
        // from status by renderStatusOverlay below (and, in walk mode, folded
        // into the top status line the same way). Grade prefers the rail
        // formation's authored value (set above); fall back to the live cab
        // pitch on photoreal rides that carry no formation.
        if (!Number.isFinite(status.gradePercent) && Number.isFinite(pitchGradePct)) {
            status.gradePercent = pitchGradePct;
        }
        if (Number.isFinite(altitudeM)) {
            status.altitudeM = altitudeM;
            status.altitudeAbsolute = altitudeAbsolute;
        }
        // Aircraft-only gauges. They replace the rail chainage/grade pair, which
        // the block above has already left null for every GTA vehicle.
        if (activeControllerId === 'aircraft' && gtaPose) {
            status.aircraft = aircraftInstruments({
                sceneY: pose.y,
                groundSceneY: finiteOrNull(gtaPose.groundY) ?? vehicleGroundY,
                verticalSpeedMps: gtaPose.verticalSpeedMps,
                throttle: gtaPose.throttle,
                throttleLocked: gtaPose.throttleLocked,
                grounded: gtaPose.grounded,
                engineFailed: gtaPose.engineFailed === true,
            });
        }
    }
    const worldInteraction = nearbyWorldInteraction(cabState);
    const gtaInteraction = worldInteraction ? { key: 'world.interactPrompt', label: t(worldInteraction.nameKey), vehicleId: worldInteraction.id } : hasEnterableVehicleCapability(cabState.sessionCapabilities)
        ? getUnifiedGtaInteraction(cabState, local)
        : null;
    const interactionLabel = gtaInteraction?.label;
    status.gtaInteractionName = interactionLabel && typeof interactionLabel === 'object'
        ? String(interactionLabel[getLang()] || interactionLabel.hr || interactionLabel.en || '')
        : String(interactionLabel || '');
    status.gtaInteractionKey = vehicleInteractionKeyForSession(
        gtaInteraction?.key === 'gta.enterPrompt' && status.gtaInteractionName ? 'gta.enterNamedPrompt' : (gtaInteraction?.key || ''),
        { inCampaign: !!cabState.campaignScene, vehicleKind: status.vehicleKind || '' },
    );
    status.vehicleExitTarget = gtaInteraction?.exitTarget || null;
    status.gtaInteractionAvailable = gtaInteraction?.available !== false;
    status.gtaInteractionEnterable = !!(
        gtaInteraction?.vehicleId
        && gtaInteraction.available !== false
    );
    setGtaInteractionAvailable(status.gtaInteractionEnterable, worldInteraction ? t('world.interactPrompt', { name: t(worldInteraction.nameKey) }) : '');
    renderStatusOverlay(pose.status || null);
    renderDriverHud(cabState.driver);
    updateKillCounter(getWreckedCarCount());

    // Station arrival → +AMMO_PER_STATION_RELOAD bullets (debounced by
    // station name so a long stop doesn't trigger repeatedly).
    if (!status.paused) lastReloadStation = null;
    if (isGameMode() && status && status.paused && status.stationName &&
        status.stationName !== lastReloadStation) {
        lastReloadStation = status.stationName;
        addAmmo(AMMO_PER_STATION_RELOAD);
        showCabToast(`+${AMMO_PER_STATION_RELOAD} 🔫`, 1600);
    }
    // Show ammo only while the gun is out (otherwise it's meaningless).
    updateAmmoCounter(
        getAmmo(),
        isGameMode() && isWeaponAttached(),
        // Only promise the G key where G is accepted — on foot it is not.
        isGameMode() && !isWeaponAttached() && !isPlayerOnFoot(cabState),
    );
    updateDriverControls();
    if (!cabState.walkMode) {
        updateEngineWhine(pose);
        if (!cabState.suppressTrackClangs) updateTrackClangs(pose);
        updateStationPa(pose.status || null);
        updateStationCrowd(pose.status || null);
        updateTramSounds(pose, cabState.otherTrainsFn || null);
    }
    if (cabState.walkMode && !gtaDriving) {
        const isNearWaterLevel = (Number.isFinite(pose.y) ? pose.y : 0) < 0.6;
        const inWater = isNearWaterLevel
            && (isPointInDecorWater(local.x, local.z)
                || isPointInProposalLake(pose.lat, pose.lon)
                || isPointInMappedSea(local.x, local.z));
        // Suppress footsteps while airborne (jetpack ascent or any free
        // fall) — you don't step on air. Cadence comes from horizontal
        // distance covered, so the sound naturally tracks walk speed.
        updateFootsteps(pose.airborne ? 0 : (pose.horizontalDistM || 0), dt, inWater);
        // Story pace is a stroll; remind a walker now and then that Shift
        // (or ⚡ on a touch screen) runs, until they have run for real.
        if (cabState.campaignScene) {
            if (!cabState.runHint) cabState.runHint = createRunHintState();
            if (advanceRunHint(cabState.runHint, {
                dt,
                moving: !pose.airborne && (finiteOrNull(pose.horizontalDistM) ?? 0) > 0.005,
                boosted: isWalkSpeedBoostOn(),
            })) {
                const touch = typeof window !== 'undefined'
                    && window.matchMedia?.('(pointer: coarse)')?.matches === true;
                showCabToast(t(touch ? 'walk.runHintTouch' : 'walk.runHint'), 2800);
            }
        }
        updateJetpack(!!pose.jetpackHeld, dt);
        // Thud on the airborne→grounded transition. Volume scales with
        // impact speed — soft for a short hop off a kerb, heavy after a
        // 50 m drop.
        if (pose.landed) playLandingImpact(pose.impactSpeedMps || 0, inWater);
    } else if (cabState.walkMode) {
        // Entry clears held walk controls, but explicitly shut down the jetpack
        // loop too so a touch release lost during the handoff cannot leave it
        // audible inside the car.
        updateFootsteps(0, dt, false);
        updateJetpack(false, dt);
    }

    const photoFrameOrientation = photoPosePoint && cabState.photoTrackFrame
        ? cabState.photoTrackFrame.orientationAt({
            lon: pose.lon,
            lat: pose.lat,
            relativeHeightM: Number(pose.y),
            headingDeg: pose.headingDeg,
            profilePitchDeg: Number.isFinite(pose.pitchDeg) ? pose.pitchDeg : 0,
        })
        : null;
    const trackBaseY = Number.isFinite(cabState.trackBaseY) ? cabState.trackBaseY : 0;
    const targetHeading = (photoFrameOrientation?.headingDeg ?? pose.headingDeg) * Math.PI / 180;
    if (cabState.smoothedHeading == null) {
        cabState.smoothedHeading = targetHeading;
    } else if (!cabState.simPaused && !status.paused) {
        // Hold heading while stopped at a platform (status.paused) so the view
        // doesn't drift or turn during the dwell.
        cabState.smoothedHeading = lerpAngle(cabState.smoothedHeading, targetHeading, HEADING_SMOOTH);
    }
    const h = cabState.smoothedHeading;

    // Track elevation + slope from the pose (planner tracks with levels).
    // Walk mode manages its own pose.y; tram/train poses carry the track's
    // height in metres and the grade the vehicle is climbing.
    // The tram's scene-Y (trackbed height). Cars ride the road surface, so the
    // car-collision test uses this to ignore cars a tunnel below or a viaduct
    // above the tram instead of "hitting" them across an altitude gap.
    pose.tramSceneY = trackBaseY + poseY;
    const designedRailPitchDeg = Number.isFinite(signedGrade)
        ? Math.atan(signedGrade) / DEG_TO_RAD
        : null;
    const terrainPitchEvidence = (!cabState.walkMode
        && cabState.terrain
        && !Number.isFinite(designedRailPitchDeg)
        && !photoPosePoint)
        ? finiteOrNull(cabState.terrain.evidenceSlopeAlongHeadingDeg?.(
            pose.lon,
            pose.lat,
            pose.headingDeg,
        ))
        : 0;
    // A missing slope chord holds the previous pitch; it cannot invalidate
    // the supported train position or hide the train at a trackbed edge.
    const terrainPitchDeg = designedRailPitchDeg
        ?? terrainPitchEvidence
        ?? (Number.isFinite(cabState.smoothedPitch)
            ? cabState.smoothedPitch / DEG_TO_RAD
            : 0);
    const photoFramePitchDeg = photoFrameOrientation?.pitchDeg ?? null;
    // Gaze pitch follows the AUTHORED rail grade (designedRailPitchDeg — the same
    // sane value shown on the HUD). We deliberately do NOT also add pose.pitchDeg
    // (the line-elevation slope): on a formation ride both express the same grade,
    // so summing them double-counted it and a spiky slope sample flung the gaze
    // up/down at grade changes. Clamp so no bad sample can tilt the view hard.
    const rawPitchDeg = Number.isFinite(photoFramePitchDeg)
        ? photoFramePitchDeg
        : (Number.isFinite(designedRailPitchDeg)
            ? designedRailPitchDeg
            : terrainPitchDeg + (Number.isFinite(pose.pitchDeg) ? pose.pitchDeg : 0));
    const clampedPitchDeg = Math.max(-CAB_MAX_PITCH_DEG, Math.min(CAB_MAX_PITCH_DEG, rawPitchDeg));
    const targetPitch = !cabState.walkMode ? clampedPitchDeg * Math.PI / 180 : 0;
    if (cabState.smoothedPitch == null) {
        cabState.smoothedPitch = targetPitch;
    } else if (!cabState.simPaused && !status.paused) {
        // Hold the gaze pitch too while stopped at a platform.
        cabState.smoothedPitch += (targetPitch - cabState.smoothedPitch) * HEADING_SMOOTH;
    }
    const posePitch = cabState.smoothedPitch;

    updateCameraLook();
    const look = getCameraLook();
    const viewHeadingDeg = cabViewHeadingDeg(h, look.yaw, cabState.cameraMode);
    if (!cabState.walkMode) {
        setDashboardHeading(viewHeadingDeg);
    }
    const yaw = h + look.yaw;
    const fx = Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const pitchY = Math.tan(look.pitch) * CAB_LOOKAHEAD;
    // Redraw the 2D minimap marker for this frame. The city-centre indicator
    // receives the actual camera heading (including mouse look), so it points
    // correctly relative to the visible screen rather than the vehicle body.
    updateMinimap(pose, viewHeadingDeg);

    const tramFx = Math.sin(h);
    const tramFz = -Math.cos(h);
    if (cabState.campaignRailDerail) {
        cabState.campaignRailDerail.elapsedMs += campaignPresentationDeltaSeconds({
            simulationDt: dt,
            nowMs,
            previousNowMs: cabState.campaignRailDerail.previousNowMs,
        }) * 1000;
        cabState.campaignRailDerail.previousNowMs = nowMs;
    }
    const derailFrame = cabState.campaignRailDerail
        ? campaignRailDerailFrame(
            cabState.campaignRailDerail.elapsedMs,
            cabState.campaignRailDerail,
        )
        : null;
    const derailOffsetX = derailFrame ? Math.cos(h) * derailFrame.lateralM : 0;
    const derailOffsetZ = derailFrame ? Math.sin(h) * derailFrame.lateralM : 0;
    const derailForwardX = derailFrame ? tramFx * derailFrame.forwardM : 0;
    const derailForwardZ = derailFrame ? tramFz * derailFrame.forwardM : 0;
    const railVisualX = local.x + derailForwardX + derailOffsetX;
    const railVisualZ = local.z + derailForwardZ + derailOffsetZ;
    const railVisualPoseY = poseY - (derailFrame?.dropM || 0);
    status.derailed = !!derailFrame;

    // Position + heading of the player's own tram body. Visible only in
    // third-person view (C); hidden in first-person so it can't envelop
    // the cab camera. Heading uses the same convention as autopilot
    // trams (mesh.rotation.y = -heading) — built with FRONT at local -Z.
    if (cabState.playerTramMesh) {
        const articulatedCars = cabState.isTrainSession
            && Array.isArray(pose.articulatedCars)
            && pose.articulatedCars.length === cabState.playerTramMesh.userData?.cars?.length
            ? pose.articulatedCars
            : null;
        if (articulatedCars) {
            cabState.playerTramMesh.position.set(0, 0, 0);
            cabState.playerTramMesh.rotation.set(0, 0, 0);
            for (let index = 0; index < articulatedCars.length; index++) {
                const carPose = articulatedCars[index];
                const car = cabState.playerTramMesh.userData.cars[index];
                const photoCarPose = resolvePhotoVehiclePose(cabState.photoTrackFrame, carPose, {
                    relativeHeightM: Number(pose.y) || 0,
                    profilePitchDeg: Number.isFinite(pose.pitchDeg) ? pose.pitchDeg : 0,
                });
                const carLocal = photoCarPose || geoToLocal(
                    Number(carPose.lon),
                    Number(carPose.lat),
                    cabState.anchorLon,
                    cabState.anchorLat,
                );
                const carAuthoredAbsoluteY = authoredAbsoluteRailSceneY({
                    elevationM: carPose.y,
                    elevationMode: carPose.elevationMode,
                    elevationDatum: carPose.elevationDatum,
                    absoluteToSceneY: heightM => {
                        const formationY = finiteOrNull(
                            cabState.railFormation?.absoluteSceneYAtHeight?.(heightM),
                        );
                        return formationY !== null
                            ? formationY
                            : cabState.terrain?.absoluteToSceneY?.(heightM);
                    },
                });
                car.position.set(
                    carLocal.x + derailForwardX + derailOffsetX,
                    trackBaseY + (photoCarPose ? photoCarPose.y : carAuthoredAbsoluteY ?? poseY)
                        - (derailFrame?.dropM || 0),
                    carLocal.z + derailForwardZ + derailOffsetZ,
                );
                car.rotation.order = 'YXZ';
                car.rotation.y = -Number(
                    photoCarPose?.headingDeg ?? carPose.headingDeg ?? 0,
                ) * DEG_TO_RAD;
                car.rotation.x = photoCarPose
                    ? Number(photoCarPose.pitchDeg || 0) * DEG_TO_RAD
                    : posePitch;
                car.rotation.z = derailFrame?.rollRad || 0;
            }
        } else {
            cabState.playerTramMesh.position.set(
                railVisualX,
                trackBaseY + railVisualPoseY,
                railVisualZ,
            );
            // YXZ order so pitch (nose up on a climb) applies around the already-
            // yawed local X axis. Front of the mesh is at local -Z.
            cabState.playerTramMesh.rotation.order = 'YXZ';
            cabState.playerTramMesh.rotation.y = -h;
            cabState.playerTramMesh.rotation.x = posePitch;
            cabState.playerTramMesh.rotation.z = derailFrame?.rollRad || 0;
        }
        cabState.playerTramMesh.visible = terrainPlacementReady
            && cabState.cameraMode === 'third';
        cabState.playerTramMesh.userData.terrainReady = terrainPlacementReady;
    }
    updateRailHeadlight({
        x: railVisualX,
        railY: trackBaseY + railVisualPoseY,
        z: railVisualZ,
        forwardX: tramFx,
        forwardZ: tramFz,
        halfLengthM: cabState.playerTramMesh?.userData?.collisionHalfLengthM,
        on: cabState.isTrainSession
            && !cabState.walkMode
            && controllerCameraProfile.kind === 'rail'
            && terrainPlacementReady
            && isSceneNight(),
    });
    if (cabState.playerWalkerAvatar) {
        cabState.walkerElapsedSeconds += dt;
        updatePlayerWalkerAvatar(cabState.playerWalkerAvatar, {
            x: local.x,
            y: Number(pose.y) || 0,
            z: local.z,
            // Shared person meshes face local +Z; the walk camera's forward
            // vector uses -Z at zero yaw, hence the explicit vector heading.
            headingRad: Math.atan2(fx, fz),
            horizontalDistanceM: Number(pose.horizontalDistM) || 0,
            airborne: !!pose.airborne,
            jetpackActive: !!pose.jetpackHeld && !!pose.airborne,
            jetpackAvailable: cabState.walkMode?.jetpackAllowed !== false,
            parachuteActive: !!pose.parachute && !!pose.airborne,
            elapsedSeconds: cabState.walkerElapsedSeconds,
            dt,
            hat: cabState.campaignWorldEffects?.['conductor-hat'] === 'worn',
            visible: walkerAvatarVisible({
                walkMode: !!cabState.walkMode,
                walkCameraMode: cabState.walkCameraMode,
                filmActive: cabState.campaignFilmActive === true,
                dialogueShotActive: cabState.campaignDialogueShotActive === true,
                standInFilming: cabState.campaignPlayerStandInFilming === true,
                driving: gtaDriving,
                terrainReady: terrainPlacementReady,
                airborne: pose.airborne === true,
            }),
        });
    }
    // Damage smoke trailing the player tram. Position is set above; the
    // helper short-circuits if health is full.
    emitPlayerTramDamageSmoke(cabState, dt);

    // Walker's lamp only exists in walk mode; keep it off in the tram/chase
    // cameras (the walk branch turns it back on).
    if (!cabState.walkMode || gtaDriving) updateWalkerLamp(0, 0, 0, 0, 0, false);

    camera.up.set(0, 1, 0);
    if (derailFrame
        && controllerCameraProfile.kind === 'rail'
        && controllerCameraProfile.mode !== 'third') {
        const sinRoll = Math.sin(derailFrame.rollRad);
        camera.up.set(
            Math.cos(h) * sinRoll,
            Math.cos(derailFrame.rollRad),
            Math.sin(h) * sinRoll,
        );
    }
    if (['road', 'boat', 'aircraft'].includes(controllerCameraProfile.kind)) {
        updateCabInterior({ visible: false });
        const chase = controllerCameraProfile.pose || cabState.gtaSession.getCameraPose();
        if (chase) {
            camera.position.set(chase.x, chase.y, chase.z);
            camera.lookAt(chase.lookX, chase.lookY, chase.lookZ);
        }
    } else if (controllerCameraProfile.kind === 'foot'
        && controllerCameraProfile.mode === 'third') {
        updateCabInterior({ visible: false });
        const desiredChase = thirdPersonWalkCameraPose({
            x: local.x,
            feetY: Number(pose.y) || 0,
            z: local.z,
            forwardX: fx,
            forwardZ: fz,
            pitchRad: look.pitch,
        });
        const chase = resolveWalkCameraLineOfSight({
            x: local.x, y: (Number(pose.y) || 0) + WALK_EYE_HEIGHT, z: local.z,
        }, desiredChase);
        camera.position.set(chase.x, chase.y, chase.z);
        camera.lookAt(chase.lookX, chase.lookY, chase.lookZ);
        updateWalkerLamp(
            local.x,
            (Number(pose.y) || 0) + WALK_EYE_HEIGHT,
            local.z,
            fx,
            fz,
            isSceneNight(),
        );
    } else if (controllerCameraProfile.kind === 'rail'
        && controllerCameraProfile.mode === 'third') {
        updateCabInterior({ visible: false });
        // Bird's-eye chase camera. Elevation is mouse-wheel-adjustable
        // (cabState.birdHeight); back-offset and look-ahead scale with
        // it so the apparent tilt stays consistent at any height.
        const elev = cabState.birdHeight;
        const back = elev * BIRD_BACK_RATIO;
        const look = elev * BIRD_LOOK_RATIO;
        const camX = railVisualX - tramFx * back;
        const camZ = railVisualZ - tramFz * back;
        camera.position.set(camX, trackBaseY + railVisualPoseY + elev, camZ);
        camera.lookAt(
            railVisualX + tramFx * look,
            trackBaseY + railVisualPoseY,
            railVisualZ + tramFz * look,
        );
    } else if (controllerCameraProfile.kind === 'foot') {
        updateCabInterior({ visible: false });
        // Walk mode: camera at the player's eye height above their current
        // y (which may be on the street, on a rooftop, or hovering on the
        // jetpack). No forward offset — the eye sits above the avatar's
        // own (x, z), looking in the camera-look direction.
        const eyeY = (pose.y || 0) + WALK_EYE_HEIGHT;
        camera.position.set(local.x, eyeY, local.z);
        camera.lookAt(local.x + fx * CAB_LOOKAHEAD, eyeY + pitchY, local.z + fz * CAB_LOOKAHEAD);
        // Handheld lamp: throws a warm cone the way you're facing once Zagreb
        // is dark. Off in daylight and parked at zero cost.
        updateWalkerLamp(local.x, eyeY, local.z, fx, fz, isSceneNight());
    } else {
        // Mount the camera at either end of the tram. Rear cab flips the
        // base heading 180° so the same camera-mounted weapon becomes a
        // rear gun.
        const rear = cabState.cameraMode === 'rear';
        const seatSign = rear ? -1 : 1;
        const viewHeading = rear ? h + Math.PI : h;
        const viewYaw = viewHeading + look.yaw;
        const viewFx = Math.sin(viewYaw);
        const viewFz = -Math.cos(viewYaw);
        const camX = railVisualX + tramFx * CAB_FORWARD_OFFSET * seatSign;
        const camZ = railVisualZ + tramFz * CAB_FORWARD_OFFSET * seatSign;
        const cabEyeY = trackBaseY + railVisualPoseY + CAB_HEIGHT;
        // Track grade tilts the default gaze: climbing raises the horizon,
        // and the rear cab sees the slope inverted.
        const gradeY = Math.tan(rear ? -posePitch : posePitch) * CAB_LOOKAHEAD;
        camera.position.set(camX, cabEyeY, camZ);
        camera.lookAt(camX + viewFx * CAB_LOOKAHEAD, cabEyeY - 0.3 + pitchY + gradeY, camZ + viewFz * CAB_LOOKAHEAD);
        // Cab interior frame around the first-person view. It tracks the
        // tram HEADING (drag-look rotates the head inside it) and skips
        // train sessions — the viaduct cab is a different vehicle.
        updateCabInterior({
            x: camX,
            y: cabEyeY,
            z: camZ,
            headingRad: viewHeading,
            visible: !cabState.isTrainSession,
            night: isSceneNight(),
        });
    }

    // Speed-coupled FOV. Driver mode pushes wider as throttle builds; in
    // autopilot we drift back to the static FOV. Lerp keeps it smooth so
    // sudden brakes don't snap the lens.
    let targetFov = FOV_BASE_DEG;
    if (gtaDriving) {
        targetFov = FOV_BASE_DEG + Math.min(FOV_SPEED_GAIN, (gtaPose.speedKmh || 0) * (FOV_SPEED_GAIN / 140));
    } else if (cabState.driver && cabState.driver.enabled) {
        const speedKmh = cabState.driver.speed * 3.6;
        targetFov = FOV_BASE_DEG + Math.min(FOV_SPEED_GAIN, speedKmh * (FOV_SPEED_GAIN / 100));
    }
    if (Math.abs(camera.fov - targetFov) > 0.01) {
        camera.fov += (targetFov - camera.fov) * FOV_SMOOTH;
        camera.updateProjectionMatrix();
    }
    // The on-foot pursuers read the walker's feet every frame; the catch they
    // report lands in the session snapshot the campaign frame reads next.
    if (cabState.campaignEncounterId && getCampaignFootPursuitSnapshot()) {
        const pursuitStartedAt = performance.now();
        const chase = stepCampaignFootPursuit({
            dt,
            x: local.x,
            y: finiteOrNull(pose.y) ?? 0,
            z: local.z,
            headingRad: finiteOrNull(pose.heading),
            onFoot: isPlayerOnFoot(cabState),
            airborne: pose.airborne === true,
        });
        recordLayerFrameMs('campaignFootPursuers', performance.now() - pursuitStartedAt);
        if (chase?.spawned > 0 && getCampaignFootPursuitSnapshot()?.groups === 1) {
            showCabToast(t('campaign.footPursuit'), 3600);
        }
    }
    if (typeof cabState.campaignFrameHandler === 'function') {
        const frame = cabState.campaignFrameHandler({
            nowMs,
            pose: snapshotCabPose(pose),
            snapshot: getCabSessionSnapshot(),
        });
        const setPieceFilming = syncCampaignEnvironmentCinematic(frame?.campaignCinematic);
        // Read by the walker update: a set piece filming its own player
        // stand-in hides the walker the scene started wherever it did.
        cabState.campaignPlayerStandInFilming = setPieceFilming && campaignEnvironmentStandsInForPlayer();
        // A set piece that films its own stand-in for a vehicle kind (the
        // Adriatic crossing hero boat) hides the real ones, parked or driven.
        for (const kind of campaignEnvironmentStandInVehicleKinds()) {
            gtaSpecialVehicleProvider.setKindHiddenByFilm(kind, setPieceFilming);
        }
        const filmingCamera = cabState.cinematicCameraResolver?.(frame);
        // Zone rings and posts are guidance, not scenery: out of every framed shot.
        // Read by next frame's avatar update: a film of the walker must show
        // the walker even when they were playing in first person, while a
        // dialogue shot (same camera path) must hide the walker it looks past.
        const dialogueShot = !!filmingCamera && frame?.framing === 'dialogue';
        cabState.campaignDialogueShotActive = dialogueShot;
        cabState.campaignFilmActive = !!filmingCamera && !dialogueShot;
        setCampaignMarkersHidden(!!filmingCamera);
        applyCampaignFilmFog((filmingCamera ? frame?.campaignCinematic?.fog : null) || getAerialViewFog());
        if (filmingCamera) {
            // An authored exterior shot must show the existing player train,
            // which the ordinary first-person cab camera hides.
            if (frame.campaignCinematic && cabState.playerTramMesh && terrainPlacementReady) {
                cabState.playerTramMesh.visible = true;
            }
            // A derailment can deliberately hold the driver's real cab view
            // through the blast, then hand off to an authored exterior shot.
            // The cab inherits vehicle roll; the film camera must not, or its
            // horizon remains tipped after the cut.
            camera.up.set(0, 1, 0);
            camera.position.set(
                filmingCamera.position.x,
                filmingCamera.position.y,
                filmingCamera.position.z,
            );
            camera.lookAt(
                filmingCamera.lookAt.x,
                filmingCamera.lookAt.y,
                filmingCamera.lookAt.z,
            );
            if (Number.isFinite(filmingCamera.fovDeg) && Math.abs(camera.fov - filmingCamera.fovDeg) > 0.01) {
                camera.fov = filmingCamera.fovDeg;
                camera.updateProjectionMatrix();
            }
        }
        // The flown aircraft's engine as the film's camera hears it: following
        // a filmed stand-in past the lens, or held under narration. Before this
        // point the camera is still the chase camera at the real aircraft.
        setAircraftEngineFilmMix(filmEngineMix({
            segment: filmEngineAudioSegment(frame?.campaignCinematic, frame?.campaignCinematic?.elapsedMs),
            listener: filmingCamera ? filmingCamera.position : camera.position,
            standIn: campaignEnvironmentFilmAircraft(),
        }));
    } else {
        cabState.campaignFilmActive = false;
        cabState.campaignDialogueShotActive = false;
        setCampaignMarkersHidden(false);
        applyCampaignFilmFog(getAerialViewFog());
        cabState.campaignPlayerStandInFilming = false;
        setAircraftEngineFilmMix(null);
    }
    // World streaming needs the camera's view, not merely the vehicle/player
    // travel heading. Walk drag-look and the rear cab can point at a different
    // half of the city, while third person deliberately follows the vehicle.
    pose.viewHeadingDeg = resolveCameraViewHeadingDeg({
        baseHeadingDeg: h / DEG_TO_RAD,
        lookYawRad: look.yaw,
        cameraMode: cabState.cameraMode,
        walkMode: controllerCameraProfile.kind === 'foot',
    });
    pose.viewFovDeg = horizontalFovDeg(camera.fov, camera.aspect);

    // Slide the ground plane under the camera so we never run off its edge.
    if (groundMesh) {
        groundMesh.position.x = local.x;
        groundMesh.position.z = local.z;
        // Compensate the concrete texture's UV offset by the same
        // amount the mesh moved, so the texture appears anchored in
        // world coords (matches asphalt, trackbed, paving polys —
        // which all have UVs baked from world XZ at build time and
        // therefore stay put as the cab moves over them).
        const map = groundMesh.material && groundMesh.material.map;
        // repeat-aware: the grass base tiles denser than the sidewalk, and
        // offset is expressed in post-repeat UV units.
        if (map) {
            map.offset.set(
                local.x * SIDEWALK_UV_PER_M * map.repeat.x,
                local.z * SIDEWALK_UV_PER_M * map.repeat.y,
            );
        }
        groundCoverFrame(local.x, local.z);
    }
    cabState.groundPaint?.onFrame(local.x, local.z);
    // Source layers rank work at the full route-ahead focus and retain current
    // support separately. The atomic compositor has one bounded window, so its
    // centre spans the current train and that focus. Following only the train
    // starts too late; following only the focus can retire ground underneath it.
    cabState.groundGenerations?.onFrame(
        vehicleSurfaceGenerationCenter(local, surfaceStreamingFocus),
    );

    // Anchor the shadow frustum to the ground under the camera AND shift the
    // sun with it by the same offset, so the world-space sun direction stays
    // consistent regardless of where the tram is. The direction itself comes
    // from sky.js's real solar path for the current sim hour — long westward
    // shadows at sunrise, short at noon, long eastward at dusk. Fill light
    // mirrors the sun's azimuth so shaded walls keep their relief.
    const sunDir = getSunDirection();
    const SUN_DIST = 216;
    if (sun) {
        sun.target.position.set(local.x, terrainGroundY, local.z);
        sun.position.set(
            local.x + sunDir.x * SUN_DIST,
            terrainGroundY + sunDir.y * SUN_DIST,
            local.z + sunDir.z * SUN_DIST,
        );
    }
    if (fill) {
        fill.target.position.set(local.x, terrainGroundY, local.z);
        fill.position.set(
            local.x - sunDir.x * SUN_DIST,
            terrainGroundY + sunDir.y * SUN_DIST,
            local.z - sunDir.z * SUN_DIST,
        );
    }

    // Let every registered layer do its per-frame work. Time each call so
    // the perf overlay (scene/animate.js) can break down where the frame
    // budget is being spent. recordLayerFrameMs is a no-op when the
    // overlay isn't shown, so this stays free in prod.
    resetEnemyMusicFrame();
    noteFrameChunkObserver(local.x, local.z, {
        pauseWhileMoving: !!cabState.walkMode && !sessionCapabilityEnabled(
            cabState.sessionCapabilities,
            SESSION_CAPABILITY.CONTINUOUS_STREAMING,
        ),
        viewHeadingDeg: pose.viewHeadingDeg,
    });
    const activeLayers = cabState.activeLayers || [];
    cabState.bakedWorldShadow?.updatePose(pose);
    const outsideSuspended = updateTunnelSurfaceSuspension(cabState, pose, local);
    // A screenshot pause freezes motion by passing dt=0, but streaming and
    // delivery must keep running. Skipping these hooks wedges cooperative
    // queues forever while the renderer appears idle — precisely when a
    // recorder waits for the stationary world to settle.
    for (let i = 0; i < activeLayers.length; i++) {
        const entry = activeLayers[i];
        const layer = entry.layer;
        if (!layer.onFrame) continue;
        // Sealed inside a tunnel: the surface layers have nothing visible to
        // build, so they stop entirely until the portal is near. Everything
        // that IS visible down here — the tube, rails, trains, station
        // interiors — is not flagged `outside` and keeps running.
        if (outsideSuspended && entry.outside) continue;
        // The far horizon is occluded by any tube, even a short one the
        // surface world is ridden through un-suspended — so stop streaming
        // it while enclosed instead of pulling the whole hillside underground.
        if (entry.suspendInAnyTunnel && cabState.insideTunnelSpan) continue;
        const t0 = performance.now();
        layer.onFrame(pose, local, dt);
        recordLayerFrameMs(entry.name || 'unnamed', performance.now() - t0);
    }
    if (modelLoading && cabState.initialSourceLoadPending
        && cabState.pendingLayerEntries?.length === 0) {
        const startup = cabState.layerStartup.getSnapshot();
        const data = cabState.layerCtx.sharedTileSession.getInitialLoadState();
        cabState.initialSourceLoadState = data;
        const groundReady = initialGroundSupportReady(cabState.groundGenerations);
        if (!startup.pending && !startup.retrying && data.ready && groundReady) {
            cabState.initialSourceLoadPending = false;
            noteWorldQueueIdle('world-data');
        }
    }
    // A campaign driving corridor is ready only when the actual terrain mesh,
    // final rendered road generation, and rail/road formation fixed point cover
    // every retained source tile. Source download alone is insufficient:
    // Zagreb tram geometry can arrive after the first asphalt and legitimately
    // revise Ilica's road support. Require the complete state to remain stable
    // beyond every 300 ms road/rail reconciliation debounce, and release the
    // critical requirement only when all ordinary startup queues are idle in
    // this same turn.
    if (modelLoading && cabState.driveSurfacePreload
        && !cabState.driveSurfacePreloadSettled
        && cabState.pendingLayerEntries?.length === 0
        && cabState.pendingLayerFrame === null
        && activeLayers.some(entry => entry.name === 'roads')) {
        const previousReadyCount = cabState.driveSurfacePreloadStatus?.readyCount ?? -1;
        const preloadStatus = campaignDrivePreloadReadiness(
            cabState.driveSurfacePreload,
            (x, z) => ({
                terrainReady: !isTerrainRequested(cabState.terrainPolicy)
                    || isTerrainTilePublishedAtLocal(x, z),
                roadReady: isRenderedRoadTilePublishedAtLocal(x, z),
                buildingReady: isDetailedTileAtLocal(x, z, DETAILED_BUILDING_TILE_M),
            }),
            { satisfied: cabState.driveSurfaceSatisfiedPoints },
        );
        const railReady = isRailSurfacePreloadSettled(cabState.driveSurfacePreload);
        const worldQueuesReady = canReleaseWorldBuildRequirement('drive-surface');
        const candidateReady = preloadStatus.ready && railReady && worldQueuesReady;
        const previousCandidateReady = cabState.driveSurfacePreloadStatus?.candidateReady === true;
        cabState.driveSurfacePreloadStatus = {
            ...preloadStatus,
            railReady,
            worldQueuesReady,
            candidateReady,
        };
        if (preloadStatus.readyCount > previousReadyCount) {
            // The corridor's own ratio moves the chapter bar and tells the
            // campaign readiness watchdog the level is still coming together.
            noteWorldQueueProgress('drive-surface', preloadStatus.readyCount, preloadStatus.totalCount);
            noteWorldBuildProgress();
        }
        if (candidateReady !== previousCandidateReady) noteWorldBuildProgress();
        if (!candidateReady) {
            cabState.driveSurfacePreloadReadySinceMs = null;
        } else if (!Number.isFinite(cabState.driveSurfacePreloadReadySinceMs)) {
            cabState.driveSurfacePreloadReadySinceMs = performance.now();
        } else if (performance.now() - cabState.driveSurfacePreloadReadySinceMs
            >= DRIVE_SURFACE_STABLE_MS) {
            cabState.driveSurfacePreloadSettled = true;
            noteWorldBuildRequirementIdle('drive-surface');
            noteWorldQueueIdle('drive-surface');
        }
    }
    if (!cabState.simPaused) {
        // Authored special vehicles are spawned by their world layer above.
        // Reclaim only after that layer and vehicle physics are both ready, so a
        // campaign transition preserves control without teleporting on foot.
        claimInitialGtaVehicle(cabState, local);
    }
    {
        syncWeaponForCameraMode(cabState);
        tickWeapon(dt);
    }
    tickEnemyMusic(dt);
    // Rendering alone uses a floating XZ origin. Streaming, tile caches,
    // terrain queries and every gameplay callback above continue to see
    // absolute session-local metres. While driving we adopt Rapier's already-
    // atomic origin; on foot we independently rebase at the same window.
    if (sessionCapabilityEnabled(
        cabState.sessionCapabilities,
        SESSION_CAPABILITY.RENDER_ORIGIN_REBASING,
    )) {
        const physicsOrigin = gtaDriving
            ? cabState.gtaSession?.getPhysicsOrigin?.()
            : null;
        if (physicsOrigin) {
            setSceneRenderOrigin(scene, physicsOrigin);
        } else {
            const rebase = resolveRenderOriginRebase(getRenderOrigin(), local);
            if (rebase) setSceneRenderOrigin(scene, rebase);
        }
    }
    // Must remain the final CPU operation in this hook. The scene callback
    // restores absolute coordinates immediately after renderer.render().
    if (sessionCapabilityEnabled(
        cabState.sessionCapabilities,
        SESSION_CAPABILITY.RENDER_ORIGIN_REBASING,
    )) applyRenderOriginForRender(scene, camera);
}

// ─── Driver mode handoff ───────────────────────────────────────────────────

// Tram-realistic cruise speed for the driver-graph autopilot. 14 m/s
// matches `TRAM_MAX_SPEED_MPS` in tram-sim.js (~50 km/h); manual driving
// may go up to DRIVER_TUNING.maxSpeedKmh where curves allow.
const AUTOPILOT_CRUISE_MPS = 14;
// Proportional gain (throttle per m/s of speed error) for the autopilot's
// speed hold. ~3 m/s off target → full throttle; small errors → a gentle,
// steady throttle, so the tram cruises instead of pumping.
const AUTOPILOT_THROTTLE_KP = 0.35;
// How long to dwell at each stop before resuming. Matches the user's
// expectation of a normal tram stop.
const AUTOPILOT_DWELL_MS = 10000;
// Speed below which we consider the tram "stopped" for dwell purposes.
const AUTOPILOT_STOPPED_THRESHOLD_MPS = 0.5;

function applyAutopilotControls(cabState, pose) {
    const ds = cabState.driver;
    const graph = cabState.driverGraph;
    if (!ds || !graph) return;

    // CRITICAL safeguard. The driver flips ds.direction whenever it
    // crosses a node while moving backward (driver.js:253), so any
    // negative speed under autopilot would cause the tram to U-turn at
    // the next node and lock the autopilot into a back-and-forth loop
    // — brake to stop, reverse, flip direction, accelerate "forward"
    // (now backward in world frame), brake again, reverse, etc. The
    // autopilot has no business reversing under any circumstances, so
    // clamp speed to ≥ 0 unconditionally. This single line is what
    // actually prevents the loop; the throttle logic below just
    // ensures we don't keep pumping negative throttle into a stopped
    // tram (which would re-trigger the clamp every frame for no
    // reason and look like a stuck brake on the HUD).
    if (ds.speed < 0) ds.speed = 0;

    // Steering: always 'straight' so the driver picks the natural
    // continuation at every switch. Random arming was producing
    // back-and-forth loops at parallel-rail crossover switches —
    // even with bias-to-straight + U-turn lockout, the autopilot
    // would eventually flip onto a backward rail and the next switch
    // would flip it back. Sticking to the line is the safe default
    // and matches what real autopilots on a fixed route would do.
    ds.armedTurn = 'straight';

    // Decide the target speed for this frame: 0 at / approaching a
    // station, otherwise cruise. Then map target → throttle below.
    const stopGuide = pose ? findPlayerStopGuide(cabState, pose) : null;
    const inBandStopName = (stopGuide && stopGuide.inBand) ? stopGuide.name : null;
    const speed = ds.speed;
    const now = performance.now();

    let targetSpeed = AUTOPILOT_CRUISE_MPS;
    if (inBandStopName) {
        if (cabState.autopilotLastStopName !== inBandStopName) {
            cabState.autopilotLastStopName = inBandStopName;
            cabState.autopilotStopWaitUntil = now + AUTOPILOT_DWELL_MS;
        }
        if (now < (cabState.autopilotStopWaitUntil || 0)) {
            targetSpeed = 0;          // dwelling at the platform
            // Door cycle: open once actually stopped, close in the final
            // stretch of the dwell so departure isn't delayed. The HUD's
            // dwell countdown comes from here too.
            const remainMs = cabState.autopilotStopWaitUntil - now;
            if (speed <= DOOR_OPEN_MAX_SPEED_MPS) {
                setPlayerDoorsTarget(
                    cabState,
                    remainMs > AUTOMATIC_DOOR_CLOSE_LEAD_SECONDS * 1000,
                );
                // The dwell runs on wall-clock but the door animation on
                // clamped frame dt, so on very slow devices the dwell could
                // expire before the doors ever finish opening. Hold the
                // window open until they do — a tram never departs without
                // having fully opened its doors. No-op at normal frame
                // rates (doors open in ~0.6 s of a 10 s dwell).
                if (cabState.doors && cabState.doors.open &&
                    cabState.doors.ratio < 1 && remainMs < 2400) {
                    cabState.autopilotStopWaitUntil = now + 2400;
                }
            }
        } else {
            targetSpeed = AUTOPILOT_CRUISE_MPS;  // dwell elapsed → resume
            setPlayerDoorsTarget(cabState, false);
        }
    } else {
        if (cabState.autopilotLastStopName) {
            cabState.autopilotLastStopName = null;
            cabState.autopilotStopWaitUntil = null;
        }
        // Feedback braking: target speed = the kinematic √-curve
        // v = √(2·BRAKE·remainingToStop). Tram naturally decelerates
        // as it approaches the platform and lands inside the band
        // instead of stopping short the way a flat brake-ahead-distance
        // does. Capped by the cruise speed so a fresh approach from
        // far away just keeps cruising until close enough.
        const remainingToStop = stopGuide ? stopGuide.remainingDistanceM : Infinity;
        if (Number.isFinite(remainingToStop)) {
            // Aim to stop a little PAST the band edge (1 m inside) so
            // the tram actually triggers the inBand dwell instead of
            // halting at the boundary.
            const stopAtM = Math.max(0, remainingToStop - 1);
            const v = Math.sqrt(2 * DRIVER_TUNING.brake * stopAtM);
            targetSpeed = Math.min(AUTOPILOT_CRUISE_MPS, v);
        }
    }

    // Never pull away while the doors are anywhere but closed.
    if (cabState.doors && cabState.doors.ratio > DOOR_INTERLOCK_RATIO) targetSpeed = 0;

    // Throttle policy: a proportional controller with a rolling-resistance
    // feed-forward. At the target speed the tram holds a small steady throttle
    // that balances drag (a real constant-current cruise) instead of the old
    // bang-bang accelerate-then-coast that pumped the throttle and surged the
    // speed. At a platform (target ~0) it brakes to a stop and holds there.
    if (targetSpeed < 0.1) {
        // The `speed > 0.4` guard is the no-reverse safeguard: without it the
        // throttle would pin at -1 as speed crosses zero and the HUD would show
        // a permanent brake on a stopped tram.
        ds.throttleTarget = speed > 0.4 ? -1 : 0;
    } else {
        const err = targetSpeed - speed;
        const resistNow = DRIVER_TUNING.coast + DRIVER_TUNING.coastDragPerV2 * speed * speed;
        const holdThrottle = clamp(resistNow / DRIVER_TUNING.accel, 0, 1);   // balances drag at this speed
        ds.throttleTarget = clamp(holdThrottle + err * AUTOPILOT_THROTTLE_KP, -1, 1);
        if (ds.throttleTarget < 0 && speed <= 0.4) ds.throttleTarget = 0;    // never brake a near-stopped tram
    }
}

function enableDriverMode() {
    const cabState = state.cabState;
    if (!cabState) return;
    if (!cabState.driverGraph) {
        if (cabState.driverUnavailableKey || cabState.driverUnavailableMessage) {
            if (window.simClock && typeof window.simClock.setPaused === 'function') {
                window.simClock.setPaused(true);
            }
            const msg = cabState.driverUnavailableKey
                ? t(cabState.driverUnavailableKey)
                : cabState.driverUnavailableMessage;
            showCabToast(msg, 2800);
        }
        return;
    }
    if (cabState.driver && cabState.driver.enabled) return;
    const pose = cabState.lastAutoPose;
    if (!pose) return;
    const snap = snapPoseToGraph(cabState.driverGraph, pose.lat, pose.lon, pose.headingDeg || 0, CAB_SNAP_RADIUS_M);
    if (!snap) {
        console.warn('[Station3D] driver mode: could not snap pose to OSM tram network');
        return;
    }
    // Carry forward whatever speed the schedule autopilot was running
    // at so the takeover is seamless — without this the tram stalls
    // mid-route the moment the player taps anything.
    const speedKmh = Number(pose && pose.status && pose.status.speedKmh);
    const initialSpeedMps = Number.isFinite(speedKmh) ? speedKmh / 3.6 : 0;
    cabState.driver = createDriverState(snap, initialSpeedMps);
    if (cabState.onTakeControl) cabState.onTakeControl();
    updateDriverControls();
}

// Hands the wheel back to the autopilot WITHOUT teleporting the
// player back to where the schedule autopilot last was. Instead of
// nullifying the driver state (which would make the cab fall back to
// the schedule's stale wallphysics pose), we flip `driver.autopilot`
// so the per-frame loop continues to step the player's current
// driver state on the OSM graph — but with throttle and turn forced
// by the layer rather than the player. Position and momentum carry
// across the toggle. Player gets the wheel back the moment they tap
// any direction key or on-screen control.
function disableDriverMode() {
    const cabState = state.cabState;
    if (!cabState) return;
    if (!cabState.driver || !cabState.driver.enabled) return;
    cabState.driver.autopilot = true;
    cabState.driver.throttleTarget = 1;
    cabState.driver.armedTurn = 'straight';
    updateDriverControls();
}

// ─── Entry points ──────────────────────────────────────────────────────────

export function openCab(train, line, poseFn, options) {
    if (typeof poseFn !== 'function') {
        console.warn('[Station3D] openCab requires a poseFn');
        return false;
    }
    const initialPose = poseFn();
    if (!initialPose) {
        console.warn('[Station3D] openCab: train pose unavailable');
        return false;
    }

    closeCab();
    setSceneTimeOfDayOverride(options?.timeOfDayOverride);
    resetSceneRenderOrigin(scene);
    enterCabMode();

    const lineLabel = line && (line.number || line.id);
    const titleOverride = options && options.titleOverride;
    const defaultTitle = lineLabel != null
        ? t('title.line', { n: lineLabel })
        : ((options && options.isTrainSession) ? t('title.train') : t('title.tram'));
    renderCabTitle(titleOverride || defaultTitle, lineLabel);
    showModal();

    const altitudeDatumM = options?.altitudeDatumM == null
        ? null
        : Number(options.altitudeDatumM);
    const requestedPhotoSeatOffsetY = options?.photoSeatOffsetY == null
        ? null
        : Number(options.photoSeatOffsetY);
    const suppliedPhotoTrackFrame = options?.photoTrackFrame;
    const reusablePhotoTrackFrame = suppliedPhotoTrackFrame
        && typeof suppliedPhotoTrackFrame.toScene === 'function'
        && typeof suppliedPhotoTrackFrame.fromScene === 'function';
    const photoTrackFrame = isPhotoWorld()
        ? (reusablePhotoTrackFrame
            ? suppliedPhotoTrackFrame
            : Number.isFinite(altitudeDatumM)
                && Number.isFinite(Number(initialPose.lon))
                && Number.isFinite(Number(initialPose.lat))
                ? createPhotoTrackFrame({
                    anchorLon: Number(initialPose.lon),
                    anchorLat: Number(initialPose.lat),
                    heightOriginM: altitudeDatumM,
                })
                : null)
        : null;
    const cabState = createCabState(initialPose, options);
    cabState.photoTrackFrame = photoTrackFrame;
    // Ordinary walk mode keeps its established opt-in crowd. GTA starts with
    // ambient people visible; the GTA obstacle policy deliberately gives
    // people neither a collider nor damage/destruction interaction.
    cabState.walkPedestriansEnabled = sessionCapabilityEnabled(
        cabState.sessionCapabilities,
        SESSION_CAPABILITY.AMBIENT_PEDESTRIANS,
    ) && options?.campaignScene?.authored?.ambientPedestrians !== false;
    cabState.suppressTrackClangs = !!(options && options.suppressTrackClangs);
    cabState.poseFn = poseFn;
    cabState.lastAutoPose = initialPose;
    cabState.lastRenderedPose = snapshotCabPose(initialPose);
    headerSyncedOnFoot = null;
    syncWalkSpeedForCampaign(cabState);
    setCabState(cabState);
    if (shouldStartCabPaused(options)) {
        setCabSimulationPaused(cabState, true, { showToast: false });
    }
    const renderCompilerWorkerUrl = window.__station3DAssetConfig?.renderCompilerWorkerUrl;
    const reportRenderCompilerFailure = (error) => {
        console.error('[render-compiler] Worker failure:', error);
        window.dispatchEvent(new CustomEvent('station3d:render-compiler-error', {
            detail: {
                code: error?.code || 'render-compiler-failed',
                message: String(error?.message || error || 'Render compiler failed'),
            },
        }));
    };
    const createCompiler = () => createRenderCompilerClient({
        workerUrl: renderCompilerWorkerUrl, maxInFlight: 1, maxRestarts: 1,
        onFailure: reportRenderCompilerFailure,
    });
    try {
        cabState.renderCompiler = createCompiler();
        cabState.unregisterRenderCompilerActivity = registerBackgroundActivityReader(() => {
            const snapshots = [cabState.renderCompiler, cabState.terrainRenderCompiler]
                .filter(Boolean).map(compiler => compiler.snapshot?.() || {});
            return {
                kind: 'build',
                label: snapshots.length > 1 ? 'render compiler Workers' : 'render compiler Worker',
                pending: snapshots.reduce((sum, snapshot) => sum + (snapshot.pendingJobs || 0), 0),
                jobs: snapshots.reduce((sum, snapshot) => sum + (snapshot.activeJobs || 0), 0),
                failed: snapshots.reduce((sum, snapshot) => sum + (snapshot.failureCount || 0), 0),
            };
        });
    } catch (error) {
        console.error('[render-compiler] Module Worker could not start:', error);
        window.dispatchEvent(new CustomEvent('station3d:render-compiler-error', {
            detail: {
                code: error?.code || 'worker-unavailable',
                message: String(error?.message || error || 'Render compiler Worker unavailable'),
            },
        }));
        closeCab();
        return false;
    }
    // No tram → no hitpoints HUD in walk mode.
    if (!cabState.walkMode) resetTramHealth(cabState);
    else hideTramHealthBar();
    // A campaign has no ride to share: its own address is a checkpoint the
    // story writes into the URL bar, so the header drops the link icon.
    const inCampaign = !!(options && (options.campaignScene || options.campaignDefinition));
    const suppliedShareUrl = (!inCampaign && options && options.shareRideUrl) || '';
    const suppliedShareProvider = (!inCampaign && options && options.shareRideUrlProvider) || null;
    setRideShareUrl(suppliedShareUrl);
    setRideShareUrlProvider(suppliedShareProvider || (inCampaign || suppliedShareUrl ? null : () => (
        currentPositionShareUrl(
            state.cabState,
            state.cabState?.lastRenderedPose || state.cabState?.lastAutoPose || poseFn(),
        )
    )));

    const initialLookYawDeg = Number(options && options.initialLookYawDeg);
    const initialLookPitchDeg = Number(options && options.initialLookPitchDeg);
    if (Number.isFinite(initialLookYawDeg) || Number.isFinite(initialLookPitchDeg)) {
        setCameraLookInstant(
            Number.isFinite(initialLookYawDeg) ? initialLookYawDeg * Math.PI / 180 : 0,
            Number.isFinite(initialLookPitchDeg) ? initialLookPitchDeg * Math.PI / 180 : 0,
        );
    }

    // Driver graph from the supplied driveable track geometry — built up front
    // so V-key is instant when a session actually allows manual driving.
    // Track polylines are lightly smoothed first (bending joints rounded,
    // junction vertices untouched) so the rendered rails, the driver graph,
    // and the curve speed limits all share the same kink-free geometry.
    // The shared policy distinguishes dense tram geometry, coarse heavy-rail
    // survey chords, and hand-drawn proposal lines per feature. Mixed worlds
    // therefore do not round a tram switch merely because the driven vehicle
    // happens to be a train.
    const tracksAlreadySmoothed = !!(options && options.tracksAlreadySmoothed);
    const otherTracks = tracksAlreadySmoothed
        ? ((options && options.otherTracks) || [])
        : smoothRailTrackFeatures((options && options.otherTracks) || []);
    const customTrackCorridors = tracksAlreadySmoothed
        ? ((options && options.customTrackCorridors) || [])
        : smoothRailTrackFeatures((options && options.customTrackCorridors) || []);
    const driverTracks = Array.isArray(options && options.driverTracks)
        ? (tracksAlreadySmoothed
            ? options.driverTracks
            : smoothRailTrackFeatures(options.driverTracks))
        : otherTracks;
    cabState.walkLaunchOptions = {
        otherTracks,
        customTrackCorridors,
        tracksAlreadySmoothed: true,
        allStops: (options && options.allStops) || [],
        ambientTrainServices: (options && options.ambientTrainServices) || [],
        proposalIds: (options && options.proposalIds) || null,
        prefetchedProposals: (options && options.prefetchedProposals) || null,
        entityInspection: options?.entityInspection === true,
        railProfileMode: options?.railProfileMode || 'osm',
        // Retained for campaign train/GTA hand-offs that deliberately preserve
        // route context. The ordinary cab-to-walk action overrides this with
        // the walk-mode title at its transition boundary.
        titleOverride: (options && options.titleOverride) || '',
        routeDirectionLabel: (options && options.routeDirectionLabel) || '',
        // Carry the asl datum so a walk launched from this cab reports true
        // a.s.l. on the altitude pill (same as the cab), not the ellipsoidal seat.
        altitudeDatumM: Number.isFinite(options && options.altitudeDatumM) ? options.altitudeDatumM : null,
        // Re-evaluate the authored DGU ground relationship at the walk's actual
        // entry point; changing cab/walk entry must never redefine the alignment.
        photoGroundOffsetAt: (options && options.photoGroundOffsetAt) || null,
        // Keep capturing Google-ground samples in walk mode too (additive).
        onPhotoGroundSamples: (options && options.onPhotoGroundSamples) || null,
    };
    if (driverTracks.length > 0) {
        cabState.driverGraph = buildDriverGraph(driverTracks);
    }
    // An explicitly supplied driving graph must cover the initial cab pose.
    // Validate once at entry; walking sessions may start away from their train.
    if (!cabState.walkMode && Array.isArray(options?.driverTracks)
        && (!cabState.driverGraph || !snapPoseToGraph(
            cabState.driverGraph, initialPose.lat, initialPose.lon,
            initialPose.headingDeg || 0, CAB_SNAP_RADIUS_M,
        ))) {
        closeCab();
        throw new Error(t('rail.startUnavailable'));
    }

    // Shared session context passed to every layer's beginSession.
    // Heavy-rail behavior is OPT-IN: some planner cabs are intentionally
    // non-driveable but still run on ground-level tram-style track, so
    // "driver unavailable" must not imply elevated-train rendering.
    const isTrainSession = !!(options && options.isTrainSession);
    const isUndergroundSession = !!(options && options.isUndergroundSession);
    const isTramSession = !!cabState.driverGraph && !cabState.walkMode && !isTrainSession;
    cabState.isTrainSession = isTrainSession;
    cabState.isUndergroundSession = isUndergroundSession;
    if (isTramSession) {
        cabState.playerService = {
            capacity: PLAYER_TRAM_SERVICE_CAPACITY,
            totalPassengers: PLAYER_TRAM_INITIAL_PASSENGERS,
            balanceEur: 0,
            lastBoarded: 0,
            lastAlighted: 0,
            activeStopKey: null,
        };
    }
    setViewButtonPlacement(isUndergroundSession ? { left: 18, bottom: 18 } : { left: 18, bottom: 116 });
    // Dashboard console hosts the driving controls + readouts for every cab
    // ride; walk mode has neither. In the cab the altitude reads on its own pill
    // beside the console; in walk mode it folds into the top status line instead
    // (renderStatusOverlay), so the separate pill is hidden there.
    setDashboardVisible(!cabState.walkMode);
    setDashboardAltitudeVisible(isPhotoWorld() && !cabState.walkMode);
    // Photoreal terrain inspection wants real height — raise the jetpack
    // ceiling well above the deepest cuts. City walks get 120 m above the
    // street so every roof, including the ~100 m towers, can be landed on.
    setJetpackCeiling(isPhotoWorld() ? 350 : 120);
    // Lift train cabs onto the elevated viaduct deck so the camera
    // doesn't clip through pillars and z-fight the deck above. Tram
    // and walk sessions stay at ground level. Caller-supplied
    // trackBaseY (e.g. a deeplink override) wins.
    if (isTrainSession && !Number.isFinite(options && options.trackBaseY)) {
        cabState.trackBaseY = TRAIN_CAB_BASE_Y;
    }

    const sceneAnchorLat = photoTrackFrame?.anchorLat ?? cabState.anchorLat;
    const sceneAnchorLon = photoTrackFrame?.anchorLon ?? cabState.anchorLon;
    // A corridor location has no ground style of its own — settle it from the
    // anchor before the terrain and ground-cover layers read it below. Every
    // walk and cab session funnels through here, so this is the one place that
    // knows where the session actually is.
    const sessionLocation = applyAnchorStyle(sceneAnchorLat, sceneAnchorLon);
    const sessionParams = new URLSearchParams(window.location.search || '');
    const terrainPolicy = resolveTerrainSessionPolicy(
        sessionParams,
        {
            sessionPresetId: cabState.sessionPresetId,
            campaignSession: !!(options?.campaignScene || options?.campaignDefinition),
            location: sessionLocation,
        },
    );
    cabState.terrainPolicy = terrainPolicy;
    // Moving terrain rebuilds a bounded receiver window repeatedly. A second
    // compiler overlaps those independent tiles on machines with enough CPU,
    // while every other packet layer retains the primary client and the same
    // publication path. It is optional: failure keeps the established
    // single-worker path alive.
    if ((Number(navigator.hardwareConcurrency) || 1) >= 4 && isTerrainRequested(terrainPolicy)) {
        try { cabState.terrainRenderCompiler = createCompiler(); }
        catch (error) { reportRenderCompilerFailure(error); }
    }
    // Same reason this sits here: it is the one place that knows where the
    // session actually is. An unprepared spawn renders an empty plane that is
    // indistinguishable from a load failure, so ask the server what it holds
    // and say so rather than letting the driver debug a rendering bug.
    ensureCoverageNotice();
    beginCoverageProbe({
        location: sessionLocation,
        anchorLat: sceneAnchorLat,
        anchorLon: sceneAnchorLon,
    });
    const surfacePublications = createSurfacePublicationRegistry({
        prepare(root) {
            applySurfacePublicationDrawContracts(root);
            cabState.groundPaint?.bindRoot(root);
        },
    });
    cabState.surfacePublications = surfacePublications;
    cabState.groundPublications = createGroundPublicationBoundary();
    cabState.groundPaint = !isPhotoWorld() && !isUndergroundSession ? createWorldGroundPaint({
        renderer, registry: surfacePublications, boundary: cabState.groundPublications,
        qualityProfileId: getRenderQualityContext().profileId,
    }) : null;
    cabState.groundPaint?.attachGroundMesh(groundMesh);
    cabState.unregisterSurfacePublicationActivity = registerBackgroundActivityReader(
        () => surfacePublications.backgroundActivity(),
    );
    const ctx = {
        anchorLat: sceneAnchorLat,
        anchorLon: sceneAnchorLon,
        fetchController: cabState.fetchController,
        // Offline compiler session: the corridor is pinned whole and the bake
        // indicator narrates the wait (see beginCampaignBakeStatus).
        campaignPackBake: sessionParams.has('campaignPackBake'),
        sharedTileSession: createSharedTileSession({
            anchorLat: sceneAnchorLat,
            anchorLon: sceneAnchorLon,
            fetchController: cabState.fetchController,
            // Offline pack authoring fans out over the complete corridor and
            // may legitimately hold a PostGIS query longer than a live
            // near-field request. Players retain the ordinary 12 s bound.
            requestTimeoutMs: sessionParams.has('campaignPackBake') ? 90_000 : undefined,
        }),
        surfacePublications,
        groundPublications: cabState.groundPublications,
        groundPaint: cabState.groundPaint,
        getDecorReadiness: () => state.cabState === cabState ? getDecorReadinessSnapshot() : null,
        getGroundPhysics: () => state.cabState === cabState ? cabState.gtaSession || null : null,
        renderCompiler: cabState.renderCompiler,
        terrainRenderCompilers: [cabState.renderCompiler, cabState.terrainRenderCompiler].filter(Boolean),
        otherTracks,
        customTrackCorridors,
        allStops: (options && options.allStops) || [],
        ambientTrainServices: (options && options.ambientTrainServices) || [],
        // ASL sessions (planner tracks with authored vertical profiles): the
        // absolute altitude of sim y=0. Photoreal seats the streamed world to
        // this datum instead of sampling the terrain for one.
        altitudeDatumM: Number.isFinite(options && options.altitudeDatumM)
            ? options.altitudeDatumM
            : null,
        photoTrackFrame,
        photoSeatOffsetY: Number.isFinite(requestedPhotoSeatOffsetY)
            ? requestedPhotoSeatOffsetY
            : null,
        photoGroundOffsetAt: (options && options.photoGroundOffsetAt) || null,
        // Photoreal reports Google-ground a.s.l. samples along the ride here so
        // the planner can overlay the real photo surface on the elevation strip.
        onPhotoGroundSamples: (options && options.onPhotoGroundSamples) || null,
        routedSegments: (options && options.routedSegments) || null,
        otherTrainsFn: (options && options.otherTrainsFn) || null,
        initialPose,
        driverGraph: cabState.driverGraph || null,
        switchRules: cabState.switchRules || null,
        isTramSession,
        isTrainSession,
        isUndergroundSession,
        locationId: sessionLocation.regionalLocationId || sessionLocation.id,
        styleCityId: sessionLocation.styleCityId || sessionLocation.id,
        terrainPolicy,
        proposalIds: (options && options.proposalIds) || null,
        prefetchedProposals: (options && options.prefetchedProposals) || null,
        entityInspection: options?.entityInspection === true,
        railProfileMode: options?.railProfileMode || 'osm',
        onPlayerTramDamage: damagePlayerTram,
        isGameMode: () => state.cabState === cabState && cabState.gameMode === 'game',
        // The world's own hostile population — random enemy cars, machine-gun
        // nests, capture flags, enemy trams. An authored campaign encounter
        // runs in game mode so the player can shoot back, but must not also
        // switch the free-roam sandbox on top of its own pursuers.
        isAmbientHostileMode: () => state.cabState === cabState
            && ambientHostilesEnabled({
                gameMode: cabState.gameMode,
                campaignEncounterActive: !!cabState.campaignEncounterId,
                campaignSession: !!cabState.campaignScene,
            }),
        isWalkMode: () => state.cabState === cabState
            && (!!cabState.walkMode || cabState.playerTramMeshBorrowed),
        isGtaSession: () => state.cabState === cabState
            && cabState.sessionPresetId === 'gta',
        boatSpawnAnchors: (options && options.boatSpawnAnchors) || [],
        aircraftSpawnAnchors: (options && options.aircraftSpawnAnchors) || [],
        authoredVehicleSpawns: (options && options.authoredVehicleSpawns) || [],
        trafficKeepClear: options?.campaignScene?.authored?.trafficKeepClear || [],
        boatExitBerth: (options && options.boatExitBerth) || null,
        campaignScene: (options && options.campaignScene) || null,
        campaignDefinition: (options && options.campaignDefinition) || null,
        campaignWorldEffects: (options && options.campaignWorldEffects) || {},
        campaignWorldPack: (options && options.campaignWorldPack) || null,
        onCampaignRailVehicleReady: (vehicleId) => {
            const effect = options?.campaignRailResumeEffect;
            if (!effect || effect.vehicleId !== vehicleId) return;
            requestAnimationFrame(() => {
                if (state.cabState !== cabState) return;
                boardCampaignRailVehicle(vehicleId, {
                    titleOverride: effect.title || cabState.titleOverride,
                    lineLabel: effect.lineLabel || null,
                    routeDirectionLabel: effect.routeDirectionLabel || '',
                    trackGaugeMm: 1435,
                    parkingBrake: effect.parkingBrake === true,
                });
            });
        },
        actorGroundYAt: (x, z, hintY, placement = {}) => resolveActorSupportY({
            x, z, hintY,
            terrainY: cabState.terrain?.evidenceSceneYAtLocal?.(x, z)
                ?? getCampaignEnvironmentGroundYAt(x, z)
                ?? campaignWorldPackSpawnYAtLocal(x, z),
            supportYAt: getWalkGroundY,
            highest: placement.support === 'highest',
        }),
        sessionCapabilities: cabState.sessionCapabilities,
        arePedestriansEnabled: () => !cabState.walkMode
            || cabState.walkPedestriansEnabled,
        onBuildingCountChanged: () => {},
    };
    // Rails publishes and replaces its immutable formation after earlier road
    // dressing layers have begun. Consumers that clip against rail civil works
    // need the live context value, not the null snapshot from startup order.
    ctx.getRailFormation = () => ctx.railFormation || null;
    ctx.bakedWorldShadow = createFarBuildingBakeShadow(ctx);
    cabState.bakedWorldShadow = ctx.bakedWorldShadow;
    if (ctx.bakedWorldShadow) {
        cabState.bakedWorldShadowDebug = () => ({ ...ctx.bakedWorldShadow.debugState(), liveOwnership: farBuildingShadowOwnership() });
        window.__worldBakeShadow = cabState.bakedWorldShadowDebug;
    }
    cabState.sharedTileSession = ctx.sharedTileSession;
    cabState.tileStreamingDebug = () => ctx.sharedTileSession.getDebugState();
    cabState.networkRequestDebug = () => ctx.sharedTileSession.getNetworkDebugState();
    window.__tileStreamingDebug = cabState.tileStreamingDebug;
    window.__networkRequestDebug = cabState.networkRequestDebug;
    cabState.otherTrainsFn = ctx.otherTrainsFn;
    cabState.occupant = createOccupantState();
    installVehicleControllers(cabState, ctx);
    cabState.controllerRouter = createSessionControllerRouter(cabState);
    cabState.sessionLayerEntries = getSessionLayerEntries(
        isUndergroundSession,
        !!ctx.campaignWorldPack,
    );
    applySessionSceneMode(cabState, {
        isUndergroundSession,
        campaignWorldPack: ctx.campaignWorldPack,
        openSea: ctx.campaignScene?.authored?.environment?.openSea === true,
        aerialView: !!ctx.campaignScene?.authored?.aerialView,
    });
    startSessionLayers(cabState, ctx, cabState.sessionLayerEntries).catch((error) => {
        console.warn('[cab] session layer startup failed', error);
        if (state.cabState === cabState) {
            cabState.onCampaignSessionReady?.('layer-failed', error);
        }
    });

    clearInfo();

    requestAnimationFrame(() => {
        const rh = getResizeHandler();
        if (rh) rh();
    });

    // Build the correct player vehicle for third-person bird's-eye view (C).
    // Train sessions use the shared HŽ 7022; tram sessions use the same detailed
    // TMK 2400 as ambient traffic. Both stay hidden in first-person.
    if (!cabState.walkMode) {
        const playerLineLabel = lineLabel != null ? String(lineLabel) : '';
        const playerRollingStock = selectRollingStock({ isTrainSession });
        cabState.playerTramMesh = playerRollingStock === ROLLING_STOCK_HZ_7022
            ? createHz7022Mesh({ articulated: true })
            : createTramMesh('#1560a8', playerLineLabel);
        // Photoreal mode hides all top-level abstract-world objects except its
        // explicit naming-contract whitelist. Keep the ridden vehicle available
        // for the C-key outside view while still hiding ambient sim traffic.
        cabState.playerTramMesh.name = 'PlayerVehicle';
        cabState.playerTramMesh.visible = false;
        scene.add(cabState.playerTramMesh);
    }
    if (cabState.walkMode) {
        cabState.playerWalkerAvatar = createPlayerWalkerAvatar();
        scene.add(cabState.playerWalkerAvatar);
    }
    // Minimap overlay: route context and the current campaign destination are
    // complementary. Keep both visible so a goal marker never turns the
    // railway or road network into a blank map.
    const navigationTarget = options?.navigationTarget || null;
    beginMinimapSession({
        driverGraph: cabState.driverGraph,
        otherTracks,
        allStops: ctx.allStops,
        anchorLat: sceneAnchorLat,
        anchorLon: sceneAnchorLon,
        walkMode: !!cabState.walkMode,
        navigationTarget,
        campaignActive: !!cabState.campaignScene,
    });
    // Door state for the service loop (see the Door service loop block).
    // Driveable heavy rail uses the same interlock and HŽ 7022 door animation.
    if (!cabState.walkMode) {
        cabState.doors = { open: false, ratio: 0 };
        setDashboardDoorState(false);
        setDashboardDoorHandler(() => cabState.controllerRouter?.handleAction(
            SESSION_ACTIONS.DOORS,
            'press',
        ));
    }
    // Bird's-eye elevation (C-mode). Persisted on cabState so the
    // mouse-wheel handler in bindKeyboard can mutate it across frames.
    cabState.birdHeight = isTrainSession ? 58 : BIRD_HEIGHT_DEFAULT;

    if (!unregisterFrameHook) {
        unregisterFrameHook = onBeforeRender(cabStep);
        unregisterAfterRenderHook = onAfterRender(cabAfterRender);
    }
    if (!cabState.walkMode) {
        startEngineWhine();
        if (!cabState.suppressTrackClangs) startTrackClangs();
        startTramSounds();
        setDashboardBellHandler(() => cabState.controllerRouter?.handleAction(
            SESSION_ACTIONS.BELL,
            'press',
        ));
    }
    preloadCabVoice();
    preloadHonkSfx();
    preloadSirens();
    if (!cabState.walkMode) preloadStationPa();
    if (!cabState.walkMode) preloadStationCrowd();
    bindEnemyMusicUnlock();
    // Footstep + jetpack audio is only meaningful in walk mode. The shared
    // audio unlock helper defers actual AudioContext creation until the
    // first real user gesture, so URL-opened sessions stay quiet until then
    // but spring to life as soon as the player interacts.
    if (cabState.walkMode) {
        startWalkAudio();
        setWalkJetpackAvailable(cabState.walkMode.jetpackAllowed !== false);
        ensureWalkControls();
        if (!hasEnterableVehicleCapability(cabState.sessionCapabilities)) {
            setWalkControlsMode('walk', {
                onInteract: () => interactWithWorld(state.cabState) || state.cabState?.onCampaignInteract?.(getCabSessionSnapshot()),
            });
        }
        showWalkControls();
    }
    // Keep the Station PA wiring alive for auto-open sessions too; its
    // warmup work runs once the shared audio unlock gate opens.
    if (!cabState.walkMode) bindAudioUnlock();
    if (!cabState.walkMode) bindStationCrowdUnlock();
    // Deeplinked rides (/voznja) open the cab with no gesture spent, so the
    // unlock gate is still shut and the ride would run silently. Offer the
    // click that opens it. No-op when audio is already unlocked.
    ensureSoundPrompt();
    // Machine gun is opt-in: hidden by default, toggled with the G key
    // while in cab. Ammo starts at 1000 per session and refills at stations.
    resetAmmo();
    lastReloadStation = null;
    // The control list stays one tap away for the whole session, for whatever
    // the player is currently controlling — a five-second toast on entry is not
    // a place to keep the flying keys.
    const controlsHintAvailable = controlsHintAvailableFor(cabState.sessionPresetId);
    setControlsHintHandler(controlsHintAvailable
        ? () => showCabToast(t(controlsHintKeyFor(
            cabState.controllerRouter?.activeId || 'foot',
            { railDoors: !cabState.ambientTramClaim,
        train: cabState.ambientTramClaim?.kind === 'train', enterable: hasEnterableVehicleCapability(cabState.sessionCapabilities) },
        )), 7000)
        : null);
    // In a campaign the objective line owns the control list behind its
    // movement button; a second header icon for the same text is exactly
    // the clutter this HUD is shedding.
    setControlsHintButtonVisible(controlsHintAvailable && !cabState.campaignScene);
    if (cabState.walkMode) {
        // Walk mode HUD is intentionally minimal — no view-cycle hint
        // (there's no third-person tram view to flip to), no driver
        // controls, no tram health bar, no weapon UI. The simulation
        // mode flip below also clears any stale weapon state from a
        // previous cab session. The campaign menu remains available.
        setCabGameMode(cabState, 'simulation');
        setCampaignButtonVisible(true);
        setCampaignButtonEnabled(true);
        showCabToast(t(cabState.sessionPresetId === 'gta'
            ? 'gta.controlsHint' : 'walk.controlsHint'), 5200);
    } else {
        showViewButton();
        runCabEntryFlow(cabState);
        // Static manual rides must occupy their physical track immediately,
        // including before the player's first throttle press.
        if (options?.manualDrive && cabState.driverGraph) enableDriverMode();
        // autoDrive (deeplinked track rides): the caller supplied a static
        // initial pose, so the schedule "autopilot" would leave the tram
        // parked forever. Engage driver mode on the supplied track graph and
        // immediately hand the wheel to the graph autopilot — the player
        // takes over with the first throttle press, same as any ride.
        if (options && options.autoDrive && cabState.driverGraph) {
            enableDriverMode();
            disableDriverMode();
        }
    }
    return true;
}

function openFreeRoam(lat, lon, options, presetId) {
    const preset = resolveFreeRoamPreset(presetId, options?.sessionCapabilities);
    const ws = createWalkState(lat, lon, options);
    const initialHeadingDeg = Number(options && options.initialHeadingDeg);
    if (Number.isFinite(initialHeadingDeg)) {
        ws.yaw = initialHeadingDeg * Math.PI / 180;
    }
    const poseFn = () => ({
        lat: ws.lat,
        lon: ws.lon,
        headingDeg: ws.yaw * (180 / Math.PI),
    });
    return openCab(null, null, poseFn, {
        walkMode: ws,
        sessionPresetId: preset.id,
        sessionCapabilities: preset.capabilities,
        titleOverride: (options && options.titleOverride)
            || t(preset.id === 'gta' ? 'title.gta' : 'title.walk'),
        timeOfDayOverride: options?.timeOfDayOverride ?? null,
        driverTracks: (options && options.driverTracks) || undefined,
        otherTracks: (options && options.otherTracks) || [],
        customTrackCorridors: (options && options.customTrackCorridors) || [],
        tracksAlreadySmoothed: !!(options && options.tracksAlreadySmoothed),
        altitudeDatumM: Number.isFinite(options && options.altitudeDatumM) ? options.altitudeDatumM : null,
        photoTrackFrame: (options && options.photoTrackFrame) || null,
        photoSeatOffsetY: options?.photoSeatOffsetY ?? null,
        photoGroundOffsetAt: (options && options.photoGroundOffsetAt) || null,
        onPhotoGroundSamples: (options && options.onPhotoGroundSamples) || null,
        allStops: (options && options.allStops) || [],
        ambientTrainServices: (options && options.ambientTrainServices) || [],
        initialLookPitchDeg: options && options.initialLookPitchDeg,
        proposalIds: (options && options.proposalIds) || null,
        prefetchedProposals: (options && options.prefetchedProposals) || null,
        entityInspection: options?.entityInspection === true,
        railProfileMode: options?.railProfileMode || 'osm',
        railMode: options?.railMode || '',
        trackGaugeMm: options?.trackGaugeMm,
        trackBaseY: options?.trackBaseY,
        suppressTrackClangs: options?.suppressTrackClangs === true,
        routeDirectionLabel: (options && options.routeDirectionLabel) || '',
        boatSpawnAnchors: (options && options.boatSpawnAnchors) || [],
        aircraftSpawnAnchors: (options && options.aircraftSpawnAnchors) || [],
        authoredVehicleSpawns: (options && options.authoredVehicleSpawns) || [],
        trafficKeepClear: options?.campaignScene?.authored?.trafficKeepClear || [],
        boatExitBerth: (options && options.boatExitBerth) || null,
        initialVehicleId: (options && options.initialVehicleId) || '',
        isUndergroundSession: options?.isUndergroundSession === true,
        campaignScene: (options && options.campaignScene) || null,
        campaignDefinition: (options && options.campaignDefinition) || null,
        campaignWorldEffects: (options && options.campaignWorldEffects) || {},
        campaignWorldPack: (options && options.campaignWorldPack) || null,
        campaignRailResumeEffect: options?.campaignRailResumeEffect || null,
        navigationTarget: options?.navigationTarget || null,
        onCampaignInteract: (options && options.onCampaignInteract) || null,
        onCampaignSessionReady: (options && options.onCampaignSessionReady) || null,
        shareRideUrlProvider: () => currentPositionShareUrl(state.cabState, poseFn()),
    });
}

export function openWalk(lat, lon, options) {
    return openFreeRoam(lat, lon, options, 'walk');
}

export function openGta(lat, lon, options) {
    return openFreeRoam(lat, lon, options, 'gta');
}

function campaignTrainDisembarkPose(cabState, pose, options = {}) {
    const heading = (Number(pose?.headingDeg) || 0) * DEG_TO_RAD;
    const side = String(options.side || 'right').toLowerCase() === 'left' ? -1 : 1;
    const clearanceM = Math.max(2.1, Math.min(4, Number(options.clearanceM) || 2.55));
    const trainLocal = geoToLocal(
        Number(pose.lon),
        Number(pose.lat),
        cabState.anchorLon,
        cabState.anchorLat,
    );
    const railY = finiteOrNull(cabState.smoothedGroundY) ?? 0;
    // The station's platform extent says a platform is here and on which side;
    // the deck itself is found in the world, standing above the rails. The
    // fixed clearance from the centreline is only the fallback for a stop with
    // no authored platform (it landed the player in the Glavni kolodvor track bed).
    const stop = findClosestStopWithinBand(pose, cabState.allStops, 250);
    const extent = stop
        ? resolvePrimaryPlatformExtent(stop, { anchorLat: cabState.anchorLat, anchorLon: cabState.anchorLon })
        : null;
    const platform = platformLandingPoint({ trainX: trainLocal.x, trainZ: trainLocal.z, extent });
    const acrossX = Math.cos(heading);
    const acrossZ = Math.sin(heading);
    const deck = platform
        ? findPlatformDeckLanding({
            trainX: trainLocal.x,
            trainZ: trainLocal.z,
            acrossX,
            acrossZ,
            railY,
            preferredSide: Math.sign((platform.x - trainLocal.x) * acrossX + (platform.z - trainLocal.z) * acrossZ) || side,
            supportYAt: (sampleX, sampleZ) => getWalkGroundY(sampleX, sampleZ, railY + 3),
        })
        : null;
    let x;
    let z;
    let y;
    if (deck) {
        x = deck.x;
        z = deck.z;
        y = deck.y;
    } else {
        x = trainLocal.x + Math.cos(heading) * clearanceM * side;
        z = trainLocal.z + Math.sin(heading) * clearanceM * side;
        y = getWalkGroundY(x, z, railY + 3);
    }
    if (!Number.isFinite(y)) return null;
    const faceTarget = options.faceTarget;
    const facing = Number.isFinite(faceTarget?.lat) && Number.isFinite(faceTarget?.lon)
        ? geoToLocal(faceTarget.lon, faceTarget.lat, cabState.anchorLon, cabState.anchorLat)
        : null;
    return {
        ...localToGeo(x, z, cabState.anchorLon, cabState.anchorLat),
        x,
        y,
        z,
        headingDeg: facing ? Math.atan2(facing.x - x, z - facing.z) / DEG_TO_RAD : Number(pose.headingDeg) || 0,
    };
}

// Zagreb already owns one GTA-capable model-world session while the train is
// approaching. Convert that live session to an on-foot controller at the open
// doors instead of closing Station3D and rebuilding the same terrain/tiles.
// A scene that continues in the already-streamed world still owns its hour.
// The finished tower's opening night follows its noon construction film in
// the same world, so the sky has to change with the scene rather than stay
// at the hour the session opened with.
function applyCampaignSceneHour(campaignScene) {
    const hour = campaignScene?.authored?.timeOfDay;
    if (typeof hour === 'number' && Number.isFinite(hour)) setSceneTimeOfDayOverride(hour);
}

export function transitionCampaignTrainToGta(options = {}) {
    const cabState = state.cabState;
    if (!cabState || !campaignRailHandoffReady({
        isTrainSession: cabState.isTrainSession,
        walkMode: cabState.walkMode,
        controllerId: cabState.controllerRouter?.activeId,
        gtaReady: !!cabState.gtaSession && !!cabState.controllerRouter,
        speedMps: cabState.driver?.speed,
        doorRatio: cabState.doors?.ratio,
    })) return false;
    const pose = getCurrentCabPose(cabState);
    if (!pose) return false;
    const exit = campaignTrainDisembarkPose(cabState, pose, options.disembark);
    if (!exit) return false;
    const authoredVehicleSpawns = options.campaignScene?.authored?.vehicleSpawns || [];
    if (!ensureAuthoredParkedCars(authoredVehicleSpawns)) return false;

    const walkState = createWalkState(exit.lat, exit.lon, {
        initialY: exit.y,
        initialGroundY: exit.y,
    });
    walkState.yaw = exit.headingDeg * DEG_TO_RAD;
    const parkedTrain = cabState.playerTramMesh;
    if (parkedTrain) {
        parkedTrain.name = 'ParkedCampaignTrain';
        parkedTrain.visible = true;
        cabState.parkedCampaignTrainMesh = parkedTrain;
        cabState.playerTramMesh = null;
        cabState.playerTramMeshBorrowed = false;
    }
    if (!cabState.playerWalkerAvatar) {
        cabState.playerWalkerAvatar = createPlayerWalkerAvatar();
        scene.add(cabState.playerWalkerAvatar);
    }

    cabState.walkMode = walkState;
    cabState.walkCameraMode = 'first';
    cabState.sessionPresetId = 'gta';
    cabState.isTrainSession = false;
    // The reused world is no longer a rail session. Leaving these fields on
    // the shared cab state kept "Split → Zagreb Glavni kolodvor" and train
    // gauge metadata in the HUD after the player stepped into the car chase.
    cabState.railMode = '';
    cabState.trackGaugeMm = null;
    cabState.routeDirectionLabel = '';
    cabState.campaignRailClaim = null;
    cabState.campaignRailVehicleId = null;
    cabState.campaignRailDisembarkEnabled = false;
    cabState.campaignScene = options.campaignScene || cabState.campaignScene;
    applyCampaignSceneHour(cabState.campaignScene);
    cabState.campaignDefinition = options.campaignDefinition || cabState.campaignDefinition;
    cabState.onCampaignInteract = options.onCampaignInteract || null;
    syncWalkSpeedForCampaign(cabState);
    cabState.driver = null;
    cabState.doors = null;
    cabState.poseFn = () => ({
        lat: walkState.lat,
        lon: walkState.lon,
        headingDeg: walkState.yaw / DEG_TO_RAD,
    });
    cabState.lastAutoPose = cabState.poseFn();
    cabState.lastRenderedPose = snapshotCabPose(cabState.lastAutoPose);
    cabState.smoothedHeading = null;
    cabState.smoothedPitch = null;
    forceOccupantOnFoot(cabState.occupant);
    clearWalkKeys();
    resetCameraLook();
    cabState.controllerRouter.activate('foot', cabState, 'campaign-train-disembark');

    setCabGameMode(cabState, 'simulation');
    setDashboardVisible(false);
    setDashboardAltitudeVisible(false);
    setDashboardDoorHandler(null);
    setDashboardBellHandler(null);
    setDashboardParkingBrakeHandler(null);
    setDashboardDoorState(false);
    stopEngineWhine();
    stopTrackClangs();
    stopTramSounds();
    stopStationPa();
    stopStationCrowd();
    hideViewButton();
    startWalkAudio();
    setWalkJetpackAvailable(walkState.jetpackAllowed !== false);
    ensureWalkControls();
    setWalkControlsMode('gta-walk');
    showWalkControls();
    cabState.navigationTarget = options.navigationTarget || null;
    beginMinimapSession({
        driverGraph: cabState.driverGraph,
        otherTracks: cabState.walkLaunchOptions?.otherTracks || [],
        allStops: cabState.allStops || [],
        anchorLat: cabState.anchorLat,
        anchorLon: cabState.anchorLon,
        walkMode: true,
        navigationTarget: cabState.navigationTarget,
        campaignActive: !!cabState.campaignScene,
    });
    renderCabTitle(options.titleOverride || t('title.gta'), null);
    setCampaignButtonVisible(true);
    setCampaignButtonEnabled(true);
    syncHeaderActionButtons(cabState);
    return true;
}

// Mesnička and the Upper Town entrance are already inside the live Zagreb
// GTA world. Switch campaign events, actors, markers and presentation in
// place; terrain, buildings, traffic and the current player pose stay intact.
// Leaves a wedged campaign vehicle where it stands and puts the player back on
// foot beside it, with the authored fleet reset. Unlike the retry transition it
// relocates nothing: the objective continues from wherever the car gave up.
// An authored mechanical failure on a named campaign vehicle (today: the
// aircraft engine). Applies whether the player is flying it or it is gliding
// on without them.
// A vehicle the story is done with (the sunk aircraft) leaves the world.
// The campaign says whether the player carries a sidearm: it unlocks the
// weapon button on foot (draw/holster) and shows it in the campaign header.
export function setCabCampaignSidearm(available) {
    const cabState = state.cabState;
    if (!cabState) return false;
    cabState.campaignSidearmAvailable = available === true;
    modalEl?.classList?.toggle('has-campaign-sidearm', cabState.campaignSidearmAvailable);
    if (!cabState.campaignSidearmAvailable && isPlayerOnFoot(cabState) && isWeaponAttached()) {
        setCabGameMode(cabState, 'simulation');
    }
    syncHeaderActionButtons(cabState);
    return true;
}

export function retireCampaignVehicle(effect = {}) {
    return state.cabState?.gtaSession?.retireVehicle?.(effect) === true;
}

export function failCampaignVehicle(effect = {}) {
    const cabState = state.cabState;
    return cabState?.gtaSession?.failVehicle?.(effect) === true;
}

// The story hands the player a canopy at an authored spot (the Vis arrival):
// out of the flown aircraft when they are still in it, otherwise straight into
// the walker's descent. `altitudeM` is metres above the sea; `headingDeg` is
// the walker's compass heading.
export function beginCampaignParachute({ lat, lon, altitudeM, headingDeg = 0 } = {}) {
    const cabState = state.cabState;
    if (!cabState?.walkMode || ![lat, lon, altitudeM].every(Number.isFinite)) return false;
    const seaY = finiteOrNull(mappedSeaSurfaceSceneY()) ?? 0;
    const target = { lat, lon, y: seaY + altitudeM, yaw: (Number(headingDeg) || 0) * DEG_TO_RAD };
    if (cabState.gtaSession?.isDriving?.()) {
        if (cabState.gtaSession.bailOutAt?.(cabState.walkMode, target) !== true) return false;
        // The same hand-over as any exit: the router walks, the HUD follows.
        return completeGtaVehicleExit(cabState, 'campaign-parachute');
    }
    return beginWalkParachute(cabState.walkMode, { ...target, initialVerticalVelocity: -2 });
}

export function abandonCampaignVehicle(options = {}) {
    const cabState = state.cabState;
    if (!cabState?.gtaSession?.isDriving?.()) return false;
    const abandoned = cabState.gtaSession.abandonVehicle?.(cabState.walkMode) === true;
    if (!abandoned) return false;
    completeGtaVehicleExit(cabState, 'vehicle-abandoned');
    if (options.resetFleet !== false) {
        resetAuthoredParkedCars(cabState.campaignScene?.authored?.vehicleSpawns || []);
    }
    return true;
}

function installVehicleControllers(cabState, ctx) {
    const sceneAnchorLat = cabState.anchorLat;
    const sceneAnchorLon = cabState.anchorLon;
    const vehicleControllerKinds = enabledVehicleControllerKinds(cabState.sessionCapabilities);
    if (vehicleControllerKinds.length > 0) {
        if (typeof createGtaSession !== 'function') {
            throw new Error('GTA capability was not preloaded before the cab session opened.');
        }
        cabState.gtaSession = createGtaSession({
            anchorLat: sceneAnchorLat,
            anchorLon: sceneAnchorLon,
            terrain: () => cabState.terrain,
            roadFormation: () => cabState.roadFormation,
            roadVerticalAlignments: () => cabState.roadVerticalAlignments,
            renderedRoadSurfacePartsNear: getRenderedRoadSurfacePartsNear,
            renderedRoadSurfaceRevision: getRenderedRoadSurfaceRevision,
            authoredSurfaceRead: () => ctx.authoredSurfaceRead,
            surfacePublications: cabState.surfacePublications,
            groundPublications: cabState.groundPublications,
            buildingFootprintsNear: ctx.campaignWorldPack
                ? campaignWorldPackBuildingFootprintsNear
                : null,
            buildingColliderSpecsNear: ctx.campaignWorldPack
                ? campaignWorldPackBuildingColliderSpecsNear
                : null,
            groundYAt: (x, z, hintY) => getWalkGroundY(x, z, hintY),
            physicsGroundYAt: (x, z, hintY) => getGtaPhysicsGroundY(x, z, hintY),
            specialVehicles: gtaSpecialVehicleProvider,
            enabledControllerKinds: vehicleControllerKinds,
            enterableRoadVehicleIds: cabState.campaignScene?.authored?.enterableVehicleIds || null,
            // Authored in degrees; the session works in scene metres.
            boatExitBerth: ctx.boatExitBerth ? (() => {
                const local = geoToLocal(ctx.boatExitBerth.lon, ctx.boatExitBerth.lat, sceneAnchorLon, sceneAnchorLat);
                return { x: local.x, z: local.z, radiusM: ctx.boatExitBerth.radiusM };
            })() : null,
            occupant: cabState.occupant,
            toast: key => showCabToast(t(key), 2600),
            onAutomaticExit: () => {
                if (state.cabState === cabState) {
                    completeGtaVehicleExit(cabState, 'vehicle-auto-exit');
                }
            },
        });
        setWalkControlsMode('gta-walk', {
            onKeyDown: (key) => {
                const current = state.cabState;
                const controllerId = current?.controllerRouter?.activeId || 'foot';
                const action = semanticActionForKey(key, controllerId);
                return action ? current?.controllerRouter?.handleAction(action, 'press') : false;
            },
            onKeyUp: (key) => {
                const current = state.cabState;
                const controllerId = current?.controllerRouter?.activeId || 'foot';
                const action = semanticActionForKey(key, controllerId);
                return action ? current?.controllerRouter?.handleAction(action, 'release') : false;
            },
            onInteract: () => {
                const current = state.cabState;
                if (current?.passengerLiftRide) return;
                if (!interactWithWorld(current) && !current?.onCampaignInteract?.(getCabSessionSnapshot())) {
                    toggleGtaVehicle(current);
                }
            },
            onCamera: () => state.cabState?.controllerRouter?.handleAction(
                SESSION_ACTIONS.CAMERA,
                'press',
            ),
            onReset: () => state.cabState?.controllerRouter?.handleAction(
                SESSION_ACTIONS.RESET,
                'press',
            ),
            onStop: () => state.cabState?.controllerRouter?.requestStop?.(),
        });
        window.__gtaCroatiaDebug = () => ({
            physics: cabState.gtaSession?.debugState?.() || null,
            renderOrigin: getRenderOrigin(),
            traffic: getTrafficWorldDebugState(),
        });
    }
}

export async function transitionCampaignGtaToWalk(options = {}) {
    const cabState = state.cabState;
    const campaignScene = options.campaignScene || null;
    const campaignDefinition = options.campaignDefinition || cabState?.campaignDefinition || null;
    // A plain walking session already owns the same world and foot controller.
    // Reusing it does not require initializing vehicle physics.
    if (!cabState
        || cabState.isTrainSession
        || !cabState.controllerRouter
        || !cabState.walkMode
        || !campaignScene
        || !campaignDefinition) return false;

    if (options.liftRide) {
        cabState.passengerLiftRide?.cancel();
        const ride = createPassengerLiftRide({
            ...options.liftRide, walker: cabState.walkMode,
            anchorLat: cabState.anchorLat, anchorLon: cabState.anchorLon,
        });
        cabState.passengerLiftRide = ride;
        // Keep the normal first-person camera and mouse look throughout the
        // ride. Simulation and streaming follow the passenger's real height.
        cabState.walkMode.yaw = 0;
        setCameraMode(cabState, 'front');
        setCameraLookInstant(0, -0.18);
        applyCampaignSceneHour(campaignScene);
        const arrived = await ride.completed;
        if (cabState.passengerLiftRide === ride) cabState.passengerLiftRide = null;
        if (!arrived || state.cabState !== cabState) return false;
    }

    // A retry from behind the wheel: leave the vehicle where it stands, put
    // the authored fleet back on its marks, then relocate the walker below.
    if (options.ejectVehicle) {
        if (cabState.gtaSession?.isDriving?.()) cabState.gtaSession.abandonVehicle?.();
        resetAuthoredParkedCars(campaignScene.authored?.vehicleSpawns || []);
    }

    // Build the authored interior before resolving the player relocation. A
    // campaign room owns its own elevated floor; resolving against the street
    // first and merely adding the same nominal offset can disagree by an
    // entire building height, leaving the player beneath the closed set.
    const environmentReady = replaceCampaignEnvironmentScene({
        campaignScene,
        anchorLat: cabState.anchorLat,
        anchorLon: cabState.anchorLon,
        terrain: cabState.terrain,
    });
    if (environmentReady === false) return false;
    const roomFloorY = getCampaignEnvironmentFloorY();
    const relocation = options.relocatePose && !options.liftRide
        ? resolveCampaignWalkRelocation({
            pose: options.relocatePose,
            anchorLat: cabState.anchorLat,
            anchorLon: cabState.anchorLon,
            groundYAt: (x, z) => {
                if (options.spawnOnUpperSupport) return getWalkGroundY(x, z, Infinity);
                if (Number.isFinite(roomFloorY)) return roomFloorY;
                const terrainY = cabState.terrain?.evidenceSceneYAtLocal?.(x, z);
                return Number.isFinite(terrainY)
                    ? terrainY
                    : getWalkGroundY(x, z, cabState.walkMode.y);
            },
            verticalOffsetM: Number.isFinite(roomFloorY)
                ? 0
                : options.relocateElevationOffsetM,
        })
        : null;
    if (options.relocatePose && !options.liftRide && !relocation) return false;
    if (!replaceCampaignActorsScene({ campaignScene, campaignDefinition })) return false;
    replaceCampaignCrowdScene({ campaignScene });
    replaceCampaignMarkersScene({
        campaignScene,
        anchorLat: cabState.anchorLat,
        anchorLon: cabState.anchorLon,
        terrain: cabState.terrain,
    });

    cabState.campaignScene = campaignScene;
    applyCampaignSceneHour(campaignScene);
    cabState.campaignDefinition = campaignDefinition;
    cabState.onCampaignInteract = options.onCampaignInteract || null;
    syncWalkSpeedForCampaign(cabState);
    cabState.walkPedestriansEnabled = sessionCapabilityEnabled(
        cabState.sessionCapabilities,
        SESSION_CAPABILITY.AMBIENT_PEDESTRIANS,
    ) && campaignScene.authored?.ambientPedestrians !== false;
    setPedestriansEnabled(cabState.walkPedestriansEnabled);
    if (relocation) {
        Object.assign(cabState.walkMode, {
            lat: relocation.lat,
            lon: relocation.lon,
            yaw: relocation.yaw,
            y: relocation.y,
            vy: 0,
            initialGroundY: relocation.y,
            initialSupportLat: relocation.lat,
            initialSupportLon: relocation.lon,
            lastDetectedGroundY: relocation.y,
            spawnY: relocation.y,
            floorGuardActive: false,
            groundMissSeconds: 0,
            airborne: false,
        });
        const relocatedPose = cabState.poseFn?.() || {};
        cabState.lastAutoPose = {
            ...relocatedPose, lat: relocation.lat, lon: relocation.lon,
            headingDeg: relocation.yaw / DEG_TO_RAD, y: relocation.y,
            status: { ...relocatedPose.status, speedKmh: 0 },
        };
        cabState.lastRenderedPose = snapshotCabPose(cabState.lastAutoPose);
        cabState.lastLocal = { x: relocation.x, y: relocation.y, z: relocation.z };
        cabState.speedProbe = null;
        cabState.probeSpeedKmh = 0;
        resetCameraLook();
    }
    setCabGameMode(cabState, 'simulation');
    clearWalkKeys();
    cabState.gtaSession?.clearControls?.();

    const driving = cabState.gtaSession?.isDriving?.() === true;
    if (!driving) {
        cabState.controllerRouter.activate('foot', cabState, 'campaign-zagreb-walk');
        setWalkControlsMode(cabState.gtaSession ? 'gta-walk' : 'walk');
        showWalkControls();
    }
    const navigationTarget = options.navigationTarget || null;
    cabState.navigationTarget = navigationTarget;
    beginMinimapSession({
        driverGraph: cabState.driverGraph,
        otherTracks: cabState.walkLaunchOptions?.otherTracks || [],
        allStops: cabState.allStops || [],
        anchorLat: cabState.anchorLat,
        anchorLon: cabState.anchorLon,
        walkMode: !driving,
        navigationTarget,
        campaignActive: !!cabState.campaignScene,
    });
    renderCabTitle(options.titleOverride || t('title.walk'), null);
    syncHeaderActionButtons(cabState);
    return true;
}

// Converts an authored waiting train into the active rail controller without
// reopening Station3D. Split's solved track, terrain, buildings and vehicle
// mesh all remain the exact objects already loaded for the arrival scene.
export function boardCampaignRailVehicle(vehicleId, options = {}) {
    const cabState = state.cabState;
    const id = String(vehicleId || '').trim();
    if (!cabState || !id) return false;
    const retainedDisembarkPermission = cabState.campaignRailDisembarkEnabled === true;
    if (cabState.campaignRailClaim?.id === id
        && cabState.occupant?.state === OCCUPANT_STATES.CONTROLLING) {
        return true;
    }
    if (!cabState.walkMode || !cabState.driverGraph
        || cabState.occupant?.state !== OCCUPANT_STATES.ON_FOOT) {
        return false;
    }
    const waitingPose = campaignRailVehiclePose(id);
    if (!waitingPose) return false;
    const snap = snapPoseToGraph(
        cabState.driverGraph,
        waitingPose.lat,
        waitingPose.lon,
        waitingPose.headingDeg,
        CAB_SNAP_RADIUS_M,
    );
    if (!snap) return false;
    if (!requestBoarding(cabState.occupant, {
        id,
        providerId: 'campaign-rail',
        controllerId: 'rail',
    })) return false;
    const record = claimCampaignRailVehicle(id);
    if (!record?.mesh || !record.pose) {
        cancelOccupantTransition(cabState.occupant);
        return false;
    }
    if (!completeBoarding(cabState.occupant, {
        id,
        providerId: 'campaign-rail',
        controllerId: 'rail',
    })) {
        cabState.playerTramMesh = record.mesh;
        cabState.playerTramMeshBorrowed = false;
        cancelOccupantTransition(cabState.occupant);
        return false;
    }

    const walkState = cabState.walkMode;
    // A restored checkpoint can apply its disembark permission before the
    // waiting-stock layer finishes publishing and this late cab claim runs.
    // Boarding must not erase that already-authorized campaign action.
    cabState.campaignRailDisembarkEnabled = retainedDisembarkPermission;
    cabState.campaignRailClaim = { id, mesh: record.mesh, walkState };
    cabState.campaignRailVehicleId = id;
    cabState.walkMode = null;
    cabState.isTrainSession = true;
    cabState.railMode = 'train';
    cabState.trackGaugeMm = finiteOrNull(options.trackGaugeMm) ?? 1435;
    cabState.routeDirectionLabel = String(
        options.routeDirectionLabel || cabState.routeDirectionLabel || '',
    );
    cabState.driver = createDriverState(snap, 0);
    cabState.driver.throttleTarget = 0;
    cabState.lastAutoPose = {
        ...record.pose,
        status: { ...record.pose.status, speedKmh: 0, doorsOpen: record.doorRatio >= 0.8 },
    };
    cabState.lastRenderedPose = snapshotCabPose(cabState.lastAutoPose);
    cabState.smoothedHeading = null;
    cabState.smoothedPitch = null;
    cabState.doors = { open: record.doorRatio >= 0.8, ratio: record.doorRatio };
    const parkedHandover = options.parkingBrake === true;
    cabState.parkingBrake = parkedHandover;
    setDashboardParkingBrakeState(parkedHandover);
    setDashboardParkingBrakeHandler(parkedHandover
        ? () => cabState.controllerRouter?.handleAction(SESSION_ACTIONS.PARKING_BRAKE, 'press')
        : null);
    cabState.playerTramMesh = record.mesh;
    cabState.playerTramMeshBorrowed = false;
    cabState.cameraMode = 'front';
    cabState.walkCameraMode = 'third';
    cabState.birdHeight = 58;
    resetTramHealth(cabState);
    clearWalkKeys();
    stopWalkAudio();
    hideWalkControls();
    setDashboardVisible(true);
    setDashboardAltitudeVisible(isPhotoWorld());
    setDashboardDoorState(cabState.doors.open);
    setDashboardDoorHandler(() => cabState.controllerRouter?.handleAction(
        SESSION_ACTIONS.DOORS,
        'press',
    ));
    setDashboardBellHandler(() => cabState.controllerRouter?.handleAction(
        SESSION_ACTIONS.BELL,
        'press',
    ));
    setViewButtonPlacement({ left: 18, bottom: 116 });
    setCabGameMode(cabState, 'simulation');
    startEngineWhine();
    startTramSounds();
    if (!cabState.suppressTrackClangs) startTrackClangs();
    preloadStationPa();
    preloadStationCrowd();
    bindAudioUnlock();
    bindStationCrowdUnlock();
    showViewButton();
    beginMinimapSession({
        driverGraph: cabState.driverGraph,
        otherTracks: cabState.walkLaunchOptions?.otherTracks || [],
        allStops: cabState.allStops || [],
        anchorLat: cabState.anchorLat,
        anchorLon: cabState.anchorLon,
        walkMode: false,
        navigationTarget: cabState.navigationTarget || null,
        campaignActive: !!cabState.campaignScene,
    });
    renderCabTitle(options.titleOverride || t('title.train'), options.lineLabel || null);
    cabState.controllerRouter?.activate('rail', cabState, 'campaign-train-board');
    updateDriverControls();
    showCabToast(t('campaign.trainEntered'), 4200);
    return true;
}

export function setCampaignRailDisembarkEnabled(enabled = true) {
    const cabState = state.cabState;
    if (!cabState) return false;
    cabState.campaignRailDisembarkEnabled = enabled === true;
    syncHeaderActionButtons(cabState);
    return true;
}

export function setCampaignNavigationTarget(target = null) {
    const cabState = state.cabState;
    if (!cabState) return false;
    cabState.navigationTarget = target || null;
    beginMinimapSession({
        driverGraph: cabState.driverGraph,
        otherTracks: cabState.walkLaunchOptions?.otherTracks || [],
        allStops: cabState.allStops || [],
        anchorLat: cabState.anchorLat,
        anchorLon: cabState.anchorLon,
        walkMode: cabState.controllerRouter?.activeId === 'foot' || !!cabState.walkMode,
        navigationTarget: cabState.navigationTarget,
        campaignActive: !!cabState.campaignScene,
    });
    return true;
}

// Expensive exit support queries are explicit and kept out of the snapshot
// read by every cinematic frame and by the general pose telemetry.
export function getCabVehicleExitTarget() {
    return state.cabState?.gtaSession?.getSafeExitTarget?.() || null;
}

export function getCabSessionSnapshot() {
    const cabState = state.cabState;
    if (!cabState) return null;
    const pose = snapshotCabPose(cabState.lastRenderedPose || cabState.lastAutoPose);
    const status = pose?.status || {};
    const controllerId = cabState.controllerRouter?.activeId
        || (cabState.walkMode ? 'foot' : 'rail');
    const occupant = cabState.occupant || null;
    const controllingVehicle = occupant?.state === OCCUPANT_STATES.CONTROLLING;
    const speedKmh = Number(status.speedKmh);
    const speedMps = Number.isFinite(speedKmh)
        ? Math.abs(speedKmh) / 3.6
        : Math.abs(Number(cabState.driver?.speed) || 0);
    const doorState = campaignRailDoorState({ doors: cabState.doors, status });
    return {
        mode: cabState.sessionPresetId || (cabState.isTrainSession ? 'heavy-rail' : 'cab'),
        sessionPresetId: cabState.sessionPresetId || (cabState.isTrainSession ? 'heavy-rail' : 'cab'),
        terrainPolicy: cabState.terrainPolicy || null,
        activeLayers: (cabState.activeLayers || [])
            .map(entry => String(entry?.name || ''))
            .filter(Boolean),
        pendingLayers: (cabState.pendingLayerEntries || [])
            .map(entry => String(entry?.name || ''))
            .filter(Boolean),
        sceneId: cabState.campaignScene?.id || null,
        freeRoam: cabState.freeRoamGameplay === true,
        jetpackOwned: cabState.freeRoamGameplay ? cabState.walkMode?.jetpackAllowed === true : null,
        pose: pose ? {
            lat: Number(pose.lat),
            lon: Number(pose.lon),
            headingDeg: Number(pose.headingDeg) || 0,
            y: Number(pose.y) || 0,
        } : null,
        status: { ...status },
        controllerId,
        occupantState: occupant?.state || (cabState.walkMode ? OCCUPANT_STATES.ON_FOOT : null),
        providerId: controllingVehicle ? occupant.providerId : null,
        vehicleId: controllingVehicle
            ? occupant.vehicleId
            : (cabState.campaignRailVehicleId
                || (cabState.isTrainSession ? 'campaign:hz-7022' : null)),
        speedMps,
        footPursuit: getCampaignFootPursuitSnapshot(),
        liftRide: cabState.passengerLiftRide?.snapshot || null,
        // How fast the vehicle is travelling through the world, which is not
        // the same as what its engine reports — see core/ground-motion.js. Null
        // when the reading has not settled or nothing is being driven.
        groundSpeedMps: finiteOrNull(cabState.gtaSession?.getGroundSpeedMps?.()),
        stuckSeconds: Number(cabState.gtaSession?.getStuckSeconds?.()) || 0,
        doorsOpen: doorState.doorsOpen,
        doorRatio: doorState.doorRatio,
        // undefined (not false) outside a cab that has a brake, so the campaign
        // checklist cannot mistake a boat or a car for a released train.
        parkingBrake: cabState.parkingBrake,
        vehicleHealth: finiteOrNull(status.vehicleHealth) != null
            ? finiteOrNull(status.vehicleHealth)
            : null,
        paused: !!cabState.simPaused,
        // Flight and descent state for the campaign's landing rules: null
        // wherever the question does not apply (a car, a train, no pose).
        ...cabSessionFlightState(cabState, pose, controllingVehicle),
    };
}

function cabSessionFlightState(cabState, pose, controllingVehicle) {
    const status = pose?.status || {};
    let airborne = null;
    let descent = null;
    let verticalSpeedMps = null;
    if (controllingVehicle && status.vehicleKind === 'aircraft') {
        airborne = status.vehicleAirborne === true;
        verticalSpeedMps = finiteOrNull(status.vehicleVerticalSpeedMps);
    } else if (!controllingVehicle && cabState.walkMode && pose) {
        airborne = pose.airborne === true;
        descent = pose.parachute === true && airborne ? 'parachute' : null;
        verticalSpeedMps = finiteOrNull(pose.verticalSpeedMps);
    }
    let surface = null;
    const lat = finiteOrNull(pose?.lat);
    const lon = finiteOrNull(pose?.lon);
    if (lat != null && lon != null && !cabState.photoTrackFrame) {
        const local = geoToLocal(lon, lat, cabState.anchorLon, cabState.anchorLat);
        surface = isPointInMappedSea(local.x, local.z) || isPointInDecorWater(local.x, local.z)
            ? 'water'
            : 'land';
    }
    return {
        airborne,
        descent,
        surface,
        verticalSpeedMps,
        touchdown: controllingVehicle ? (status.vehicleTouchdown || null) : null,
    };
}

// Explicit gallery lifecycle I/O. Keep allocations and world capture out of
// getCabSessionSnapshot(), which is also read on every cinematic frame.
export function captureCabSessionRestorePoint() {
    const cab = state.cabState;
    if (!cab) return null;
    return {
        ...getCabSessionSnapshot(),
        altitudeDatumM: cab.photoTrackFrame?.heightOriginM ?? cab.terrain?.anchorHeightM ?? null,
        walkMotion: cab.walkMode ? { ...cab.walkMode } : null,
        cameraMode: cab.cameraMode,
        walkCameraMode: cab.walkCameraMode,
        cameraLook: { ...getCameraLook() },
        driverMotion: cab.driver ? { speed: cab.driver.speed, throttleTarget: cab.driver.throttleTarget,
            autopilot: cab.driver.autopilot } : null,
        vehicleMotion: cab.gtaSession?.getVehicleResumeState?.() || null,
        actorState: getCampaignActorsSnapshot(),
        environmentState: getCampaignEnvironmentSnapshot(),
        encounter: cab.campaignEncounterId ? {
            id: cab.campaignEncounterId,
            placement: cab.campaignEncounterSpawn || null,
            previousGameMode: cab.gameModeBeforeEncounter,
            enemies: getEnemyEncounterSnapshot(cab.campaignEncounterId),
        } : null,
    };
}

export function restoreCabSessionRestorePoint(snapshot) {
    const cab = state.cabState;
    if (!cab || !snapshot?.pose) return false;
    snapshot = rebaseSessionRestorePoint(snapshot,
        cab.photoTrackFrame?.heightOriginM ?? cab.terrain?.anchorHeightM);
    // World readiness may precede the normal initial-vehicle claim. The adapter
    // waits for that existing handoff before applying saved motion once.
    if (snapshot.vehicleMotion && !cab.gtaSession?.isDriving?.()) return false;
    if (snapshot.controllerId === 'rail') {
        if (cab.walkMode) return false;
        const snap = snapPoseToGraph(cab.driverGraph, snapshot.pose.lat, snapshot.pose.lon,
            snapshot.pose.headingDeg, CAB_SNAP_RADIUS_M);
        if (!snap) return false;
        cab.driver = createDriverState(snap, snapshot.driverMotion?.speed || 0);
        cab.driver.throttleTarget = snapshot.driverMotion?.throttleTarget || 0;
        cab.driver.autopilot = snapshot.driverMotion?.autopilot === true;
        if (cab.doors) { cab.doors.open = snapshot.doorsOpen === true; cab.doors.ratio = snapshot.doorRatio || 0; }
        cab.parkingBrake = snapshot.parkingBrake === true;
        setDashboardDoorState(cab.doors?.open === true);
        setDashboardParkingBrakeState(cab.parkingBrake);
        cab.lastAutoPose = computeControlledRailPose(cab);
        cab.lastRenderedPose = snapshotCabPose(cab.lastAutoPose);
    }
    if (snapshot.controllerId === 'foot' && cab.walkMode && snapshot.walkMotion) {
        Object.assign(cab.walkMode, snapshot.walkMotion);
    }
    if (snapshot.vehicleMotion && !cab.gtaSession.restoreVehicleMotion(snapshot.vehicleMotion)) return false;
    // A restored session may remain paused at its menu. Publish the saved
    // pose now instead of waiting for the first simulation step to replace
    // the temporary boarding/spawn pose.
    if (snapshot.controllerId === 'foot' || snapshot.vehicleMotion) {
        const pose = { ...snapshot.pose, status: cab.lastRenderedPose?.status || {} };
        cab.lastAutoPose = pose;
        cab.lastRenderedPose = snapshotCabPose(pose);
        cab.lastLocal = { ...geoToLocal(pose.lon, pose.lat, cab.anchorLon, cab.anchorLat), y: pose.y };
    }
    cab.cameraMode = snapshot.cameraMode || cab.cameraMode;
    cab.walkCameraMode = snapshot.walkCameraMode || cab.walkCameraMode;
    if (snapshot.cameraLook) setCameraLookInstant(snapshot.cameraLook.yaw, snapshot.cameraLook.pitch);
    if (snapshot.encounter) {
        if (!restoreEnemyEncounterSnapshot(snapshot.encounter.id, snapshot.encounter.enemies)) return false;
        cab.campaignEncounterId = snapshot.encounter.id;
        cab.gameModeBeforeEncounter = snapshot.encounter.previousGameMode;
        setCabGameMode(cab, 'game');
    }
    restoreCampaignActorsSnapshot(snapshot.actorState);
    restoreCampaignEnvironmentSnapshot(snapshot.environmentState);
    setCabSimulationPaused(cab, snapshot.paused === true, { showToast: false });
    return true;
}

export function derailCabCampaignRailVehicle(spec = {}) {
    const cabState = state.cabState;
    const snapshot = getCabSessionSnapshot();
    if (!cabState?.isTrainSession
        || snapshot?.controllerId !== 'rail'
        || !cabState.driver?.enabled
        || !cabState.playerTramMesh) return false;
    const requestedVehicleId = String(spec.vehicleId || '').trim();
    if (requestedVehicleId && requestedVehicleId !== snapshot.vehicleId) return false;
    if (cabState.campaignRailDerail) return true;

    const configuredDurationMs = finiteOrNull(spec.durationMs);
    const configuredStartDelayMs = finiteOrNull(spec.startDelayMs);
    cabState.campaignRailDerail = {
        elapsedMs: 0,
        previousNowMs: performance.now(),
        durationMs: configuredDurationMs != null
            ? Math.max(1, configuredDurationMs)
            : CAMPAIGN_RAIL_DERAIL_DURATION_MS,
        startDelayMs: configuredStartDelayMs != null
            ? Math.max(0, configuredStartDelayMs)
            : 0,
        side: (finiteOrNull(spec.side) ?? 1) < 0 ? -1 : 1,
        forwardM: Math.max(0, finiteOrNull(spec.forwardM) ?? 0),
        lateralM: Math.max(0, finiteOrNull(spec.lateralM) ?? 4.6),
        dropM: Math.max(0, finiteOrNull(spec.dropM) ?? 1.15),
        rollDeg: Math.max(0, finiteOrNull(spec.rollDeg) ?? 76),
    };
    cabState.driver.autopilot = false;
    cabState.driver.throttleTarget = -1;
    cabState.driver.throttle = Math.min(cabState.driver.throttle, -0.82);
    setPlayerDoorsTarget(cabState, false);
    if (!spec.preserveCameraMode) setCameraMode(cabState, 'third');
    cabState.birdHeight = Math.min(
        finiteOrNull(cabState.birdHeight) ?? BIRD_HEIGHT_DEFAULT,
        24,
    );
    updateDriverControls();
    return true;
}

function localBoundsForGeographicBounds(bounds, anchorLon, anchorLat) {
    if (!bounds || ![bounds.west, bounds.south, bounds.east, bounds.north].every(Number.isFinite)) {
        return null;
    }
    const corners = [
        geoToLocal(bounds.west, bounds.south, anchorLon, anchorLat),
        geoToLocal(bounds.west, bounds.north, anchorLon, anchorLat),
        geoToLocal(bounds.east, bounds.south, anchorLon, anchorLat),
        geoToLocal(bounds.east, bounds.north, anchorLon, anchorLat),
    ];
    return {
        minX: Math.min(...corners.map(point => point.x)),
        maxX: Math.max(...corners.map(point => point.x)),
        minZ: Math.min(...corners.map(point => point.z)),
        maxZ: Math.max(...corners.map(point => point.z)),
    };
}

function triggerCampaignPackDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10 * 60_000);
}

// The bake indicator: a pill that names the phase, lists what still blocks
// settlement, and ticks a clock once a second — so a twenty-minute wait for
// the corridor to settle is visibly a wait, not a stall. Bake sessions only.
function renderCampaignBakeStatus(cabState) {
    const bake = cabState?.bakeStatus;
    if (!bake) return;
    const status = campaignBakeStatus({
        phase: bake.phase,
        elapsedMs: performance.now() - bake.startedAt,
        blocking: bake.blocking,
        detail: bake.detail,
    });
    setCampaignBakeStatus({
        title: t('bake.title'),
        phase: t(`bake.${status.phase}`),
        detail: status.detail,
        elapsed: status.elapsed,
        failed: status.phase === 'failed',
        done: status.phase === 'done',
    });
}

function beginCampaignBakeStatus(cabState) {
    if (!cabState || cabState.bakeStatus) return;
    cabState.bakeStatus = {
        startedAt: performance.now(),
        phase: 'corridor',
        blocking: [],
        detail: '',
        timer: setInterval(() => renderCampaignBakeStatus(cabState), 1000),
    };
    renderCampaignBakeStatus(cabState);
}

function updateCampaignBakeStatus(cabState, phase, { blocking, detail } = {}) {
    const bake = cabState?.bakeStatus;
    if (!bake) return;
    bake.phase = phase;
    bake.blocking = Array.isArray(blocking) ? blocking : [];
    bake.detail = typeof detail === 'string' ? detail : '';
    renderCampaignBakeStatus(cabState);
}

function endCampaignBakeStatus(cabState) {
    const bake = cabState?.bakeStatus;
    if (!bake) return;
    clearInterval(bake.timer);
    cabState.bakeStatus = null;
    setCampaignBakeStatus(null);
}

async function waitForCampaignBakeFixedPoint(cabState, timeoutMs = 5 * 60_000) {
    const startedAt = performance.now();
    while (state.cabState === cabState && (
        isWorldBuilding()
        || (cabState.driveSurfacePreload && !cabState.driveSurfacePreloadSettled)
    )) {
        window.__station3DCampaignPackBakeActivity = Object.freeze({
            updatedAt: new Date().toISOString(),
            settled: false,
            phase: 'fixed-point-publication',
            blocking: Object.freeze([]),
        });
        if (performance.now() - startedAt >= timeoutMs) return false;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return state.cabState === cabState;
}

// Development/offline compiler entry. It is intentionally unavailable in an
// ordinary campaign session so a player can never turn the live streaming
// world back on underneath an immutable level.
export async function captureCurrentCampaignWorldPack(options = {}) {
    const params = new URLSearchParams(window.location.search || '');
    if (!params.has('campaignPackBake')) {
        throw new Error('Campaign level capture requires ?campaignPackBake=1');
    }
    const cabState = state.cabState;
    const spec = cabState?.campaignScene?.authored?.campaignWorldPack;
    const bake = spec?.bake;
    if (!cabState || !spec?.packId || !bake) {
        throw new Error('The active scene has no authored campaign pack bake specification');
    }
    if (cabState.campaignWorldPack) throw new Error('Cannot capture an already baked campaign level');
    try {
        return await captureCampaignWorldPackPhases(cabState, spec, bake, params, options);
    } catch (error) {
        updateCampaignBakeStatus(cabState, 'failed', { detail: String(error?.message || error) });
        throw error;
    }
}

// The live terrain hides its ground under rail formations and road cuts with
// a shader discard the bake cannot copy. This is the same CPU cutout query the
// physics ground uses, over the whole capture window, so the baked terrain is
// carved where the live terrain is discarded (grass no longer covers the
// sleepers on the Zagreb approach).
function campaignBakeTerrainCutoutAt(cabState, localBounds) {
    if (!localBounds) return null;
    const terrain = cabState.terrain;
    const models = Array.from(new Set([
        terrain?.roadFormation,
        terrain?.railFormation,
        terrain?.renderedRailSurface,
        cabState.roadFormation,
    ].filter(Boolean)));
    if (models.length === 0) return null;
    const centerX = (localBounds.minX + localBounds.maxX) * 0.5;
    const centerZ = (localBounds.minZ + localBounds.maxZ) * 0.5;
    const radiusM = Math.hypot(localBounds.maxX - localBounds.minX, localBounds.maxZ - localBounds.minZ) * 0.5 + 50;
    const query = buildFormationTerrainCutoutQuery({
        models,
        centerX,
        centerZ,
        radiusM,
        allowStale: false,
        terrainSceneYAtLocal: (x, z) => terrain?.evidenceSceneYAtLocal?.(x, z),
    });
    console.info('[campaign-pack] terrain carve query',
        `${query.formationRingCount} formation rings, ${query.portalOpeningRingCount} portal openings, ${query.replacementRingCount} replacements`);
    return (x, z) => query.contains(x, z);
}

// The level's rail features: the campaign layer resolves them for the scene
// that will drive on the level (bake.railCheckpointId); without a checkpoint
// the streamed reference rails are the source. A rail level captured with no
// rail is refused here — a player found the empty list as a dead chapter.
function campaignBakeRailFeatures(bake, options) {
    const provided = Array.isArray(options?.railFeatures) ? options.railFeatures : null;
    const features = provided || getActiveRailTrafficSource().features.filter(isSolvedRailFeature);
    if (bake?.railCheckpointId && features.length === 0) {
        throw new Error(`Campaign level capture requires the rail features of "${bake.railCheckpointId}"`);
    }
    return features;
}

async function captureCampaignWorldPackPhases(cabState, spec, bake, params, options) {
    updateCampaignBakeStatus(cabState, 'settling');
    // Offline authoring only: name what still blocks settlement, with every
    // detail the activity readers carry (in-flight requests, retries, the
    // deferred item), every 30 s. A twenty-minute timeout that ends in
    // "curbs:1" is undiagnosable from the summary alone.
    let lastSettleLogMs = 0;
    await waitForCampaignPackSettlement({
        readActivity: () => getBackgroundActivitySnapshot(),
        onProgress: blocking => {
            window.__station3DCampaignPackBakeActivity = Object.freeze({
                updatedAt: new Date().toISOString(),
                settled: blocking.length === 0,
                blocking: blocking.map(entry => Object.freeze({ ...entry })),
            });
            updateCampaignBakeStatus(cabState, 'settling', { blocking });
            if (blocking.length > 0 && performance.now() - lastSettleLogMs >= 30_000) {
                lastSettleLogMs = performance.now();
                console.info('[campaign-pack] settling on', JSON.stringify(blocking).slice(0, 4000));
            }
        },
    });
    updateCampaignBakeStatus(cabState, 'fixed-point');
    const fixedPointReady = await waitForCampaignBakeFixedPoint(cabState);
    if (!fixedPointReady || isWorldBuilding()
        || (cabState.driveSurfacePreload && !cabState.driveSurfacePreloadSettled)) {
        throw new Error('The authored live world has not reached its final fixed point');
    }
    const releaseId = String(
        options.releaseId || params.get('campaignPackRelease') || '',
    ).trim();
    const sourceRevision = String(
        options.sourceRevision || params.get('campaignPackSource') || '',
    ).trim();
    if (!releaseId || !sourceRevision) {
        throw new Error('Campaign level capture requires releaseId and sourceRevision');
    }
    const anchor = bake.anchor || { lat: cabState.anchorLat, lon: cabState.anchorLon };
    const packAnchorLocal = geoToLocal(
        Number(anchor.lon),
        Number(anchor.lat),
        cabState.anchorLon,
        cabState.anchorLat,
    );
    const sceneDatumAslM = Number(cabState.terrain?.anchorHeightM);
    if (!Number.isFinite(sceneDatumAslM)) {
        throw new Error('Campaign level capture requires an EVRF2000 terrain datum');
    }
    restoreAbsoluteRenderCoordinates();
    updateCampaignBakeStatus(cabState, 'capturing');
    // A segmented bake captures one band of the level. Only the filter moves:
    // the manifest still describes the whole level, and the band keeps only the
    // chunk cells it owns, so parts merge without ever colliding on a key
    // (core/campaign-pack-segments.js).
    const segmentPlan = campaignPackBakeSegmentPlan(
        spec,
        options.segment || params.get('campaignPackBakeSegment'),
    );
    const captureLocalBounds = localBoundsForGeographicBounds(
        segmentPlan?.captureBounds || bake.visualBounds,
        cabState.anchorLon,
        cabState.anchorLat,
    );
    const captured = await captureCampaignPackScene({
        scene,
        terrainCutoutAt: campaignBakeTerrainCutoutAt(cabState, captureLocalBounds),
        packId: spec.packId,
        releaseId,
        sourceRevision,
        anchor: {
            lat: Number(anchor.lat),
            lon: Number(anchor.lon),
            sceneDatumAslM,
            verticalDatum: 'EVRF2000',
        },
        packAnchorLocal,
        bounds: bake.visualBounds,
        playArea: bake.playArea,
        railFeatures: campaignBakeRailFeatures(bake, options),
        captureLocalBounds,
        chunkSizeM: bake.chunkSizeM,
        maxChunkBytes: bake.maxChunkBytes,
    });
    console.info('[campaign-pack] terrain carve', captured.outputCounts?.terrainCarve);
    updateCampaignBakeStatus(cabState, 'encoding');
    const owned = segmentPlan
        ? Object.freeze({
            ...captured,
            manifest: {
                ...captured.manifest,
                chunks: (captured.manifest.chunks || [])
                    .filter(chunk => campaignPackSegmentOwnsChunkKey(segmentPlan, chunk.key)),
            },
            chunks: captured.chunks.filter(chunk => campaignPackSegmentOwnsChunkKey(segmentPlan, chunk.key)),
        })
        : captured;
    if (segmentPlan && owned.chunks.length === 0) {
        throw new Error(`Segment ${segmentPlan.index}/${segmentPlan.count} captured no chunks of its own`);
    }
    const archive = encodeCampaignPackArchiveBlob(owned);
    const filename = `${spec.packId}-${releaseId}.s3pack`;
    if (options.download !== false) triggerCampaignPackDownload(archive, filename);
    updateCampaignBakeStatus(cabState, 'done', {
        detail: `${filename} · ${(archive.size / 1048576).toFixed(1)} MB`,
    });
    return Object.freeze({
        filename,
        archiveByteLength: archive.size,
        manifest: owned.manifest,
        segment: segmentPlan ? `${segmentPlan.index}/${segmentPlan.count}` : null,
    });
}

export function setCabSessionPaused(paused) {
    const cabState = state.cabState;
    if (!cabState) return false;
    setCabSimulationPaused(cabState, !!paused, { showToast: false });
    return true;
}

export function clearCabSessionInput() {
    const cabState = state.cabState;
    if (!cabState) return false;
    clearWalkKeys();
    cabState.gtaSession?.clearControls?.();
    if (cabState.driver) cabState.driver.throttleTarget = 0;
    setWeaponFiring(false);
    return true;
}

export function setCabCampaignFrameHandler(handler) {
    const cabState = state.cabState;
    if (!cabState) return false;
    cabState.campaignFrameHandler = typeof handler === 'function' ? handler : null;
    // A replay or another recording gets its own height reference, even when
    // it reuses the same world. Never carry the previous film's ground into it.
    cabState.cinematicCameraResolver = cabState.campaignFrameHandler
        ? createFlightCameraResolver({
            anchorLon: cabState.anchorLon,
            anchorLat: cabState.anchorLat,
            groundYAt: (x, z, reference) => campaignDialogueGroundY({
                roomFloorY: getCampaignEnvironmentFloorY(),
                authoredGroundY: reference
                    ? cabState.layerCtx?.actorGroundYAt?.(x, z, null, reference)
                    : null,
                terrainGroundY: cabState.terrain
                    ? cabState.terrain.evidenceSceneYAtLocal?.(x, z)
                    : 0,
            }),
        })
        : null;
    setStreetNamesPresentationHidden(!!cabState.campaignFrameHandler);
    return true;
}

export async function startCabCampaignEncounter(spec = {}) {
    const cabState = state.cabState;
    const pose = cabState && (cabState.lastRenderedPose || cabState.lastAutoPose);
    if (!cabState || !pose) return false;
    const local = geoToLocal(pose.lon, pose.lat, cabState.anchorLon, cabState.anchorLat);
    const count = Math.max(1, Math.min(8, Math.trunc(Number(spec.pursuerCount) || 3)));
    const radiusM = Math.max(80, Math.min(500, Number(spec.spawnRadiusM) || 240));
    // Claim the encounter BEFORE arming game mode: the flag is what holds the
    // free-roam hostile sandbox back, and a frame of game mode without it is a
    // frame in which the world may seed nests and enemy cars of its own.
    if (cabState.campaignEncounterId) stopCabCampaignEncounter();
    cabState.campaignEncounterId = String(spec.id || 'campaign-encounter');
    cabState.gameModeBeforeEncounter = cabState.gameMode;
    setCabGameMode(cabState, 'game');
    const generation = cabState.campaignEncounterGeneration = (cabState.campaignEncounterGeneration || 0) + 1;
    const carsEntry = surfaceLayerEntries.find(entry => entry.layer === carsLayer);
    const layerReady = await cabState.layerStartup?.start(carsEntry);
    if (state.cabState !== cabState || generation !== cabState.campaignEncounterGeneration) return false;
    const roadsReady = layerReady && await waitForTrafficRoadsNear(local.x, local.z, radiusM);
    if (state.cabState !== cabState || generation !== cabState.campaignEncounterGeneration) return false;
    if (!roadsReady) {
        console.warn(`[campaign ${new Date().toISOString()}] Encounter roads unavailable`, cabState.campaignEncounterId);
        stopCabCampaignEncounter();
        return false;
    }
    const placement = {};
    const spawned = spawnEnemyWaveNear(local.x, local.z, radiusM, count, {
        encounterId: cabState.campaignEncounterId, diagnostics: placement,
    });
    cabState.campaignEncounterSpawn = { requested: count, spawned, radiusM, placement };
    if (spawned === 0) {
        console.warn(`[campaign ${new Date().toISOString()}] Encounter placement failed`, {
            id: cabState.campaignEncounterId, ...cabState.campaignEncounterSpawn,
        });
        stopCabCampaignEncounter();
        return false;
    }
    // Only once the wave is actually on the streets. Armed cars in the traffic
    // flow are not a chase: this is what makes them hunt the player and hold
    // their number for as long as the scene runs. Declaring it before the
    // placement check would have left a pursuit running for a wave that never
    // existed.
    beginEncounterPursuit({ encounterId: cabState.campaignEncounterId, count, radiusM });
    // The crews on foot: they follow a walker along the walker's own trail
    // and never fire. A catch reaches the story through the session snapshot.
    if (spec.footPursuers) {
        startCampaignFootPursuit(spec.footPursuers, { encounterId: cabState.campaignEncounterId });
    }
    return true;
}

export function stopCabCampaignEncounter() {
    const cabState = state.cabState;
    if (!cabState) return false;
    cabState.campaignEncounterGeneration = (cabState.campaignEncounterGeneration || 0) + 1;
    // Stop hunting and reinforcing before the encounter id is cleared, or the
    // wave would keep topping itself up into free roam.
    endEncounterPursuit();
    stopCampaignEnemyEncounter(cabState.campaignEncounterId);
    stopCampaignFootPursuit();
    cabState.campaignEncounterId = null;
    // The encounter is what armed the world, so ending it has to hand that
    // back. Leaving game mode on with the encounter flag cleared is the worst
    // of both: the story fight is over and the free-roam hostile sandbox — the
    // nests and the random enemy cars — switches on inside the scene instead.
    if (cabState.gameModeBeforeEncounter) {
        setCabGameMode(cabState, cabState.gameModeBeforeEncounter);
        cabState.gameModeBeforeEncounter = null;
    }
    return true;
}

export function closeCab() {
    closeWorldChoices();
    setSceneTimeOfDayOverride(null);
    const cabState = state.cabState;
    if (!cabState) return;
    cabState.passengerLiftRide?.cancel();
    endCampaignBakeStatus(cabState);
    stopCampaignFootPursuit();
    setFrameChunkSchedulerThroughput(false);
    resetTerrainInspection();
    resetInspector();
    resetFrameChunkObserver();
    resetSceneRenderOrigin(scene);
    headerSyncedOnFoot = null;
    setWalkSpeed(FREE_ROAM_WALK_SPEED_MPS);

    setPlatformWaitingPeopleVisible(true);

    // Never leak a P-key clock pause into the map or the next cab session.
    if (cabState.simPaused) setCabSimulationPaused(cabState, false, { showToast: false });

    hideMinimap();

    if (cabState.fetchController) cabState.fetchController.abort();
    cabState.bakedWorldShadow?.dispose();
    cabState.bakedWorldShadow = null;
    if (window.__worldBakeShadow === cabState.bakedWorldShadowDebug) delete window.__worldBakeShadow;
    if (cabState.pendingLayerFrame) {
        cancelAnimationFrame(cabState.pendingLayerFrame);
        cabState.pendingLayerFrame = null;
    }
    cabState.pendingLayerEntries = [];
    cabState.layerStartup?.dispose();
    cabState.layerStartup = null;
    cabState.unregisterLayerStartupActivity?.();
    cabState.unregisterLayerStartupActivity = null;
    cabState.unregisterSurfacePublicationActivity?.();
    cabState.unregisterSurfacePublicationActivity = null;
    if (cabState.driver && cabState.driver.enabled && cabState.onReleaseControl) {
        cabState.onReleaseControl();
    }
    if (cabState.onClose) {
        cabState.onClose();
    }
    const ambientProvider = getGtaAmbientTramProvider();
    if (cabState.occupant?.state === OCCUPANT_STATES.BOARDING_REQUESTED
        && cabState.occupant.providerId === ambientProvider.id) {
        ambientProvider.cancelReservation(cabState.occupant.vehicleId);
        cancelOccupantTransition(cabState.occupant);
    }
    if (cabState.ambientTramClaim) {
        const pose = cabState.driver && cabState.driverGraph
            ? computeDriverPose(cabState.driver, cabState.driverGraph)
            : cabState.lastRenderedPose;
        const local = pose ? geoToLocal(
            pose.lon,
            pose.lat,
            cabState.anchorLon,
            cabState.anchorLat,
        ) : cabState.lastLocal;
        cabState.ambientTramClaim.provider.release(cabState.ambientTramClaim.id, {
            ...pose,
            x: local?.x,
            z: local?.z,
            speedMps: Number(cabState.driver?.speed) || 0,
            doorRatio: Number(cabState.doors?.ratio) || 0,
            visible: true,
        }, {
            force: true,
            sourceOsmId: railSourceOsmId(cabState),
            cruiseSpeedMps: cabState.ambientTramClaim.cruiseSpeedMps,
        });
        cabState.playerTramMesh = null;
        cabState.playerTramMeshBorrowed = false;
        cabState.ambientTramClaim = null;
    }
    cabState.groundGenerations?.close();
    cabState.groundGenerations = null;
    cabState.groundPublications?.close();
    cabState.groundPublications = null;
    cabState.controllerRouter?.dispose();
    cabState.controllerRouter = null;
    if (cabState.gtaSession) {
        cabState.gtaSession.dispose();
        cabState.gtaSession = null;
    }
    delete window.__gtaCroatiaDebug;

    disposeCabInterior();
    setDashboardVisible(false);
    setDashboardAltitudeVisible(false);
    setPhotoLoading(false);
    cabState.pendingCampaignReadyReason = null;
    cabState.initialWorldPending = false;
    // Drop any pending loading hold so a session that closes mid-build can never
    // leave rendering paused or the overlay stuck for the next session.
    forceWorldReady();
    setWorldLoading(false);

    // Player tram body (only used in third-person view) — detach +
    // dispose. Tram-internal shared materials/geos are registered as
    // shared, so disposeGroup leaves them alone for the next session.
    if (cabState.playerTramMesh && !cabState.playerTramMeshBorrowed) {
        if (cabState.playerTramMesh.parent) {
            cabState.playerTramMesh.parent.remove(cabState.playerTramMesh);
        }
        disposeGroup(cabState.playerTramMesh);
        cabState.playerTramMesh = null;
    }
    cabState.playerTramMesh = null;
    cabState.playerTramMeshBorrowed = false;
    if (cabState.parkedCampaignTrainMesh) {
        if (cabState.parkedCampaignTrainMesh.parent) {
            cabState.parkedCampaignTrainMesh.parent.remove(cabState.parkedCampaignTrainMesh);
        }
        disposeGroup(cabState.parkedCampaignTrainMesh);
        cabState.parkedCampaignTrainMesh = null;
    }
    if (cabState.playerWalkerAvatar) {
        if (cabState.playerWalkerAvatar.parent) {
            cabState.playerWalkerAvatar.parent.remove(cabState.playerWalkerAvatar);
        }
        disposeGroup(cabState.playerWalkerAvatar);
        cabState.playerWalkerAvatar = null;
    }

    // Uniform teardown of every layer — matching order of beginSession.
    for (const entry of cabState.activeLayers || []) {
        if (entry.layer && entry.layer.endSession) entry.layer.endSession();
    }
    // Person geometry is shared by boarding, pedestrians, campaign actors and
    // the player avatar; release it only after every owning layer is down.
    disposeDogMeshSessionCaches();
    disposePersonMeshSessionCaches();
    cabState.unregisterRenderCompilerActivity?.();
    cabState.unregisterRenderCompilerActivity = null;
    cabState.renderCompiler?.dispose?.('cab-session-ended');
    cabState.renderCompiler = null;
    cabState.terrainRenderCompiler?.dispose?.('cab-session-ended');
    cabState.terrainRenderCompiler = null;
    cabState.surfacePublications?.close();
    cabState.surfacePublications = null;
    beginGroundCover({ enabled: false });   // restore the sidewalk catch-all
    cabState.groundPaint?.dispose();
    cabState.groundPaint = null;
    resetWalkColliders();
    if (cabState.sharedTileSession) cabState.sharedTileSession.abort();
    if (window.__tileStreamingDebug === cabState.tileStreamingDebug) {
        delete window.__tileStreamingDebug;
    }
    cabState.tileStreamingDebug = null;
    if (window.__networkRequestDebug === cabState.networkRequestDebug) {
        delete window.__networkRequestDebug;
    }
    cabState.networkRequestDebug = null;
    disposeWalkerLamp();
    disposeRailHeadlight();
    restoreSessionSceneMode(cabState);

    setCabState(null);
    clearWalkKeys();
    resetCameraLook();
    resetBellMemory();
    stopEngineWhine();
    stopTrackClangs();
    stopTramSounds();
    setDashboardBellHandler(null);
    setDashboardDoorHandler(null);
    setDashboardDoorState(false);
    stopCabVoice();
    stopWalkAudio();
    hideWalkControls();
    setWalkControlsMode('walk');
    setWalkJetpackAvailable(true);
    stopStationPa();
    stopStationCrowd();
    hideSoundPrompt();
    hideNightNotice();
    stopEnemyMusic();
    detachWeapon();
    setRideShareUrlProvider(null);

    hideCabToast();
    renderStatusOverlay(null);
    hideDriverHud();
    hideKillCounter();
    hideAmmoCounter();
    hideTramHealthBar();
    hideFireButton();
    hideViewButton();
    hideViewIndicator();
    setCampaignButtonVisible(false);
    syncHeaderActionButtons(null);
    setControlsHintButtonVisible(false);
    setControlsHintHandler(null);
    lastReloadStation = null;
    setRideShareUrl('');
    updateDriverControls();

    if (unregisterFrameHook) {
        unregisterFrameHook();
        unregisterFrameHook = null;
    }
    unregisterAfterRenderHook?.();
    unregisterAfterRenderHook = null;
    // Module-level queues survive for reuse, but their counters belong to the
    // session that just ended. Reset only after every layer has cancelled its
    // work so teardown activity cannot leak into the next ride's diagnostics.
    resetFrameChunkSessionStatistics();
}

// Dev-only debug handle (localhost): lets automated test sessions probe walk
// support decisions, raycast scene objects, and read cab/walk state without a
// rebuild. Never present on a public origin.
if (typeof window !== 'undefined'
    && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
    window.__st3dDebug = {
        // Getters: scene/camera/renderer are assigned during setup, after this
        // module evaluates — a plain object literal would snapshot undefined.
        get state() { return state; },
        get scene() { return scene; },
        get camera() { return camera; },
        get renderer() { return renderer; },
        getWalkGroundY,
        THREE,
    };
}

function nearbyWorldInteraction(cab) {
    if (!cab?.walkMode || cab.passengerLiftRide || worldChoicesOpen()
        || (cab.controllerRouter?.activeId || 'foot') !== 'foot') return null;
    const w = cab.walkMode;
    const p = geoToLocal(w.lon, w.lat, cab.anchorLon, cab.anchorLat);
    const dog = getNearbyDog(p.x, p.z, w.y);
    if (dog) return { ...dog, kind: 'dog', nameKey: 'world.dog' };
    if (cab.campaignScene) return null;
    const lift = nearestLiftLanding(p.x, p.z, w.y);
    if (lift) return { ...lift, kind: 'lift' };
    const shop = getNearbyJetpackShop(p.x, p.z, w.y);
    return shop ? { ...shop, kind: 'shop' } : null;
}

function interactWithWorld(cab) {
    if (cab?.passengerLiftRide || worldChoicesOpen()) return true;
    const target = nearbyWorldInteraction(cab);
    if (!target) return false;
    clearWalkKeys();
    const title = t(target.nameKey);
    if (target.kind === 'dog') {
        holdDogInteraction(target.id, true);
        showWorldChoices({ title, onDismiss: () => holdDogInteraction(target.id, false), choices: ['pat', 'scratch'].map(kind => ({
            label: t(`world.dog.${kind}`), action: () => {
                closeWorldChoices();
                const nearby = nearbyWorldInteraction(cab);
                if (nearby?.id === target.id && petNearbyDog(target.id, kind)) {
                    showCabToast(t(`world.dog.${kind}Done`), 3700);
                }
            },
        })) });
    } else if (target.kind === 'lift') {
        showWorldChoices({ title, choices: target.stops.map(stop => ({
            label: t(stop.y > target.y ? 'world.liftUp' : 'world.liftDown'),
            action: async () => {
                closeWorldChoices(); clearWalkKeys();
                const ride = createPassengerLiftRide({ liftId: target.id, fromStop: target.fromStop,
                    toStop: stop.id, walker: cab.walkMode, anchorLat: cab.anchorLat, anchorLon: cab.anchorLon });
                cab.passengerLiftRide = ride;
                setCameraMode(cab, 'front');
                const arrived = await ride.completed;
                if (cab.passengerLiftRide === ride) cab.passengerLiftRide = null;
                if (arrived && state.cabState === cab) showCabToast(t('world.liftArrived'), 2200);
            },
        })) });
    } else {
        let shopState = { phase: 'offer', jetpackOwned: readFreeRoamProgress(localStorage).jetpackOwned };
        const render = () => showWorldChoices({ title,
            text: t(shopState.jetpackOwned ? 'world.shopOwned' : shopState.phase === 'accepted' ? 'world.shopAccepted' : 'world.shopPrice'),
            choices: shopState.jetpackOwned ? [] : [{
                label: t(shopState.phase === 'accepted' ? 'world.shopBuy' : 'world.shopOffer'),
                action: () => {
                    if (shopState.phase === 'offer') { shopState = reduceJetpackShop(shopState, 'offer-bitcoin'); render(); return; }
                    try {
                        purchaseJetpack(localStorage);
                        shopState = reduceJetpackShop(shopState, 'buy');
                        cab.walkMode.jetpackAllowed = true;
                        setWalkJetpackAvailable(true);
                        closeWorldChoices();
                        showCabToast(t('world.shopBought'), 6000);
                    } catch (error) {
                        console.warn('[jetpack-shop] purchase could not be saved', error);
                        showCabToast(t('world.shopSaveFailed'), 5000);
                    }
                },
            }],
        });
        render();
    }
    return true;
}

// Release story ownership while keeping the same world, terrain and player.
export async function enterFreeRoam() {
    const cab = state.cabState;
    if (!cab?.walkMode || !cab.layerCtx) return false;
    if (cab.freeRoamGameplay) return true;
    await preloadCabOptionalCapabilities({ gta: true });
    if (state.cabState !== cab) return false;
    const ctx = cab.layerCtx;
    stopCabCampaignEncounter();
    setCabCampaignSidearm(false);
    campaignMusicLayer.endSession();
    cab.campaignFrameHandler = null;
    cab.cinematicCameraResolver = null;
    cab.onCampaignInteract = null;
    cab.campaignScene = null;
    cab.campaignDefinition = null;
    ctx.campaignScene = null;
    ctx.campaignDefinition = null;
    cab.sessionPresetId = 'gta';
    cab.sessionCapabilities = resolveFreeRoamPreset('gta').capabilities;
    ctx.sessionCapabilities = cab.sessionCapabilities;
    cab.walkPedestriansEnabled = true;
    setPedestrianFreeRoamEnabled(true);
    setTrafficSessionCapabilities(cab.sessionCapabilities);
    setDecorSessionCapabilities(cab.sessionCapabilities);
    if (!cab.gtaSession) {
        gtaSpecialVehiclesLayer.endSession();
        await gtaSpecialVehiclesLayer.beginSession(ctx);
        if (state.cabState !== cab) return false;
        installVehicleControllers(cab, ctx);
    } else cab.gtaSession.releaseCampaignRestrictions?.();
    cab.controllerRouter = createSessionControllerRouter(cab);
    cab.controllerRouter.activate('foot', cab, 'free-roam');
    replaceCampaignActorsScene({ campaignScene: null, campaignDefinition: null });
    replaceCampaignCrowdScene({ campaignScene: null });
    replaceCampaignMarkersScene({ campaignScene: null, anchorLat: cab.anchorLat, anchorLon: cab.anchorLon, terrain: cab.terrain });
    cab.freeRoamGameplay = true;
    cab.walkMode.jetpackAllowed = readFreeRoamProgress(localStorage).jetpackOwned;
    setWalkJetpackAvailable(cab.walkMode.jetpackAllowed);
    clearWalkKeys();
    syncWalkSpeedForCampaign(cab);
    setCabGameMode(cab, 'simulation');
    setCampaignNavigationTarget(null);
    setStreetNamesPresentationHidden(false);
    setControlsHintButtonVisible(true);
    setCampaignButtonVisible(false);
    renderCabTitle(t('title.walk'), null);
    showCabToast(t(cab.walkMode.jetpackAllowed ? 'world.freeRoam' : 'world.freeRoamShop'), 8000);
    return true;
}
