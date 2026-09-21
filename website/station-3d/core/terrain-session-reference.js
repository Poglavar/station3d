// The public session object keeps derived authorities attachable while every
// terrain query comes from the immutable table of published receivers.
export function createTerrainSessionReference(published) {
    if (published?.contract !== 'station3d-published-terrain-v1') throw new TypeError('Missing published terrain');
    return Object.assign(Object.create(published), {
        roadFormation: null, railFormation: null, renderedRailSurface: null,
        setRoadFormation(model) { this.roadFormation = model || null; },
        setRailFormation(model) { this.railFormation = model || null; },
        setRenderedRailSurface(model) { this.renderedRailSurface = model || null; },
    });
}
