// Public planning interoperability helpers. These are deliberately separate
// from the runtime entry so proposal/plan hosts can prepare Station3D inputs
// without loading Three.js or starting a render loop.

export {
    ENS_PLAN_PARAM,
    ensPlanSlug,
    mergeProposalIds,
    parseEnsPlanParam,
} from './core/ens-plan.js';
export {
    LEVEL_HEIGHT_M,
    SUPPORTED_ELEVATION_DATUM,
    buildProposalTrackFeatures,
    gaugeMillimetresForType,
    isAuthoredPlannerRailFeature,
    mergeProposalTrackFeatures,
    normalizeRailMode,
    startPoseForTrackFeatures,
    transitProjectTrackPhysicalId,
    transitProposalTrackPhysicalId,
} from './core/proposal-track.js';
export {
    COMPACT_COVERED_STATION,
    STATION_VERTICAL_FORM,
    UNDERGROUND_STATION_INTERIOR_HALF_WIDTH_M,
    UNDERGROUND_STATION_PLATFORM_HEIGHT_M,
    UNDERGROUND_STATION_TYPE_ID,
    classifyStationVerticalForm,
    describeStation,
    stationTypeIds,
} from './core/station-contract.js';
