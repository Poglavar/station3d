// ES-module bridge to the deployment-neutral UMD source. Import builders from this file inside
// station-3d code; Consensus Builder vendors the exact same canonical source.
import '../../shared/transit-station-models.js';

const models = globalThis.TransitStationModels;
if (!models) throw new Error('Shared transit station models failed to initialize.');

export const MODEL_VERSION = models.MODEL_VERSION;
export const LEVEL_HEIGHT_M = models.LEVEL_HEIGHT_M;
export const TYPES = models.TYPES;
export const normalizeType = models.normalizeType;
export const specFor = models.specFor;
export const createStationModel = models.createStationModel;
export const createBusStationModel = models.createBusStationModel;
export const createTramStationModel = models.createTramStationModel;
export const createUndergroundStationModel = models.createUndergroundStationModel;
export const createElevatedStationModel = models.createElevatedStationModel;
