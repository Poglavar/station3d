// Static wiring contract for elapsed-time and byte telemetry on both versions
// of the “Loading surroundings” overlay.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dashboard = readFileSync(new URL('../ui/dashboard.js', import.meta.url), 'utf8');
const cab = readFileSync(new URL('../modes/cab.js', import.meta.url), 'utf8');
const photo = readFileSync(new URL('../world/photoreal.js', import.meta.url), 'utf8');
const metrics = readFileSync(new URL('../core/dashboard-metrics.js', import.meta.url), 'utf8');

test('model and photoreal loading overlays display seconds and megabytes', () => {
    assert.match(dashboard, /station-3d-campaign-curtain-telemetry/);
    assert.match(dashboard, /station-3d-photo-loading-telemetry/);
    // The formatting is pure (core/dashboard-metrics.js) and prefers the wire
    // figure; the dashboard supplies both labels so the decoded estimate is
    // never presented as a download.
    assert.match(dashboard, /formatLoadTelemetry.*from '\.\.\/core\/dashboard-metrics\.js'/);
    assert.match(metrics, /toFixed\(1\).*MB/s);
    assert.match(dashboard, /hud\.downloaded/);
    assert.match(dashboard, /hud\.decoded/);
    assert.match(cab, /noteWorldTransferBytes\(entry\.transferSize \|\| entry\.encodedBodySize \|\| 0\)/);
    assert.match(cab, /setWorldLoadTelemetry\(getWorldLoadTelemetry\(\)\)/);
    assert.match(cab, /const photoTelemetry = getPhotorealLoadTelemetry\(\);\s*setPhotoLoadTelemetry\(photoTelemetry\)/);
});

test('photoreal bytes count only renderer-requested Resource Timing URLs', () => {
    assert.match(photo, /tile-download-start/);
    assert.match(photo, /load-tileset/);
    assert.match(photo, /performance\.getEntriesByName\(url, 'resource'\)/);
    assert.match(photo, /encodedBodySize/);
});

test('the model loading hold also pauses wall-clock-backed vehicle poses', () => {
    assert.match(cab, /const modelLoading = isWorldBuilding\(\)/);
    assert.match(cab, /loadingHold: modelLoading \|\| photoLoading/);
    assert.match(cab, /poseFn\(\{ paused: cabState\.simPaused \|\| loadingHold \}\)/);
    assert.doesNotMatch(cab, /sampleExternalPose\(cabState, cabState\.controllerFrame\?\.photoLoading\)/);
});

test('a screenshot pause freezes motion without wedging streamed layer work', () => {
    assert.match(cab, /if \(cabState\.simPaused\) dt = 0;/);
    assert.match(cab, /for \(let i = 0; i < activeLayers\.length; i\+\+\)[\s\S]*layer\.onFrame\(pose, local, dt\)/);
    assert.doesNotMatch(
        cab,
        /if \(!cabState\.simPaused\) \{\s*for \(let i = 0; i < activeLayers\.length;/,
    );
});

test('the benchmark reads loading state from the live cab module graph', () => {
    assert.match(cab, /window\.__s3dWorldLoadState = \(\) => \(\{/);
    assert.match(cab, /building: isWorldBuilding\(\)/);
    assert.match(cab, /startupTrace: startupTrace\.snapshot\(\)/);
});
