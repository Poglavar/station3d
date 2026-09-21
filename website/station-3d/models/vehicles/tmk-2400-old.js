// Stable named access to the legacy production TMK 2400 model. Its shared factory
// and model resources live beside this named variant in tram.js.

export {
    createLegacyTramMesh as createTmk2400OldMesh,
    setTramDoorsOpen as setTmk2400OldDoorsOpen,
    setTramNightMode as setTmk2400OldNightMode,
} from './tram.js';
