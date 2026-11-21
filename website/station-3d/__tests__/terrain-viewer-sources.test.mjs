// Verifies city selection and Zagreb dynamic DGU request coverage without a
// browser, network, or WebGL context.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseTerrainViewerElevationMode,
    parseTerrainViewerSource,
    TERRAIN_VIEWER_SOURCES,
    terrainViewerGridRequest,
} from '../core/terrain-viewer-sources.js';

test('viewer keeps Split as the backwards-compatible default and accepts Zagreb and Šibenik', () => {
    assert.equal(parseTerrainViewerSource(''), 'split');
    assert.equal(parseTerrainViewerSource('?city=zagreb'), 'zagreb');
    assert.equal(parseTerrainViewerSource('?city=sibenik'), 'sibenik');
    assert.equal(parseTerrainViewerSource('?city=unknown'), 'split');
});

test('viewer exposes high-resolution preview modes for the cities that have a LiDAR delivery', () => {
    assert.equal(parseTerrainViewerElevationMode('', 'split'), 'best-available');
    assert.equal(parseTerrainViewerElevationMode('', 'zagreb'), 'best-available');
    for (const city of ['zagreb', 'split']) {
        assert.equal(
            parseTerrainViewerElevationMode('?source=dgu-lidar-dmr-1m', city),
            'dgu-lidar-dmr-1m',
        );
        assert.equal(
            parseTerrainViewerElevationMode('?source=dgu-lidar-dmp-1m', city),
            'dgu-lidar-dmp-1m',
        );
    }
    // Šibenik has no LiDAR delivery, so it must stay on the national 20 m grid.
    assert.equal(parseTerrainViewerElevationMode('', 'sibenik'), 'dgu-dtm-20m');
    assert.equal(
        parseTerrainViewerElevationMode('?source=dgu-lidar-dmr-1m', 'sibenik'),
        'dgu-dtm-20m',
    );
});

test('both cities use the same dynamic DGU grid request contract', () => {
    for (const source of Object.values(TERRAIN_VIEWER_SOURCES)) {
        const preset = source.presets[source.defaultArea];
        const request = terrainViewerGridRequest(preset, preset.spanKm);
        assert.equal(request.bbox.length, 4);
        assert.ok(request.bbox[0] < preset.lon && request.bbox[2] > preset.lon);
        assert.ok(request.bbox[1] < preset.lat && request.bbox[3] > preset.lat);
        assert.ok(request.resolutionDeg >= 0.00025);
        const cells = ((request.bbox[2] - request.bbox[0]) / request.resolutionDeg)
            * ((request.bbox[3] - request.bbox[1]) / request.resolutionDeg);
        assert.ok(cells <= 2_200_001);
        assert.equal('metadataUrl' in source, false);
        assert.equal('dataUrl' in source, false);
    }
});

test('high-resolution requests stay native for detail views and coarsen bounded overviews', () => {
    const source = TERRAIN_VIEWER_SOURCES.zagreb;
    const detail = terrainViewerGridRequest(
        source.presets.railCentral,
        source.presets.railCentral.spanKm,
        { source: 'dgu-lidar-dmr-1m' },
    );
    const overview = terrainViewerGridRequest(source.presets.railCorridor, 35, {
        source: 'best-available',
    });
    assert.equal(detail.source, 'dgu-lidar-dmr-1m');
    assert.ok(detail.resolutionDeg < 0.00001, `detail resolution ${detail.resolutionDeg}`);
    assert.ok(overview.resolutionDeg > detail.resolutionDeg);
    const cells = ((overview.bbox[2] - overview.bbox[0]) / overview.resolutionDeg)
        * ((overview.bbox[3] - overview.bbox[1]) / overview.resolutionDeg);
    assert.ok(cells <= 2_200_001);
});

test('western Sava preset covers terrain on both sides of the railway', () => {
    const source = TERRAIN_VIEWER_SOURCES.zagreb;
    const preset = source.presets.savaWest;
    const request = terrainViewerGridRequest(preset, preset.spanKm);
    assert.ok(request.bbox[0] < 15.813, 'must include the Zaprešić-side track approach');
    assert.ok(request.bbox[2] > 15.857, 'must include Podsused TV');
    assert.ok(request.bbox[1] < 45.77, 'must include the Sava south of the railway');
    assert.ok(request.bbox[3] > 45.84, 'must include the railway and northern hills');
    assert.equal(request.resolutionDeg, 0.00025);
});

test('savaOdraSava preset frames the whole 2026-08 DGU 1 m flood delivery', () => {
    // Bounds of the polygon that was actually requested from DGU
    // (data_sources_exploration/dgu-dmr-requests/2026-08-11-zagreb-poplave).
    // The preset exists to answer "did we get everything we asked for", so it
    // is only useful if the window it opens contains the whole request.
    const request = { west: 15.6580972, south: 45.5838449, east: 16.3724884, north: 46.0199590 };
    const preset = TERRAIN_VIEWER_SOURCES.zagreb.presets.savaOdraSava;
    const { bbox } = terrainViewerGridRequest(preset, preset.spanKm, {
        source: 'dgu-lidar-dmr-1m',
    });
    assert.ok(bbox[0] <= request.west, `west ${bbox[0]} must reach ${request.west} (Samobor)`);
    assert.ok(bbox[1] <= request.south, `south ${bbox[1]} must reach ${request.south} (Odransko polje)`);
    assert.ok(bbox[2] >= request.east, `east ${bbox[2]} must reach ${request.east} (Rugvica/Oborovo)`);
    assert.ok(bbox[3] >= request.north, `north ${bbox[3]} must reach ${request.north} (Medvednica)`);
});
