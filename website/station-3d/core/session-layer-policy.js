// Pure visibility policy for choosing station-3d surface layers from URL mode
// flags. Kept outside the scene orchestrator so mode regressions are testable.

export function includeSurfaceLayerInElevationMode(layerName) {
    // Elevation mode changes how each ordinary layer resolves height; it does
    // not select a second set of source-specific layers.
    return typeof layerName === 'string' && layerName.length > 0;
}
