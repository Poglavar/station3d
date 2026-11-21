// The night notice offers daylight only while the sky follows the real clock:
// an authored scene hour, a ?time= link or a host simulation clock were all
// chosen on purpose and must not trigger it.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as Three from 'three';

function skyApi({ search = '', simClock = null, timeOverride = null } = {}) {
    const ctx = {
        clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
        createLinearGradient() { return { addColorStop() {} }; },
        createRadialGradient() { return { addColorStop() {} }; },
    };
    const THREE = {
        ...Three,
        PMREMGenerator: class { compileEquirectangularShader() {} fromEquirectangular() { return { texture: {}, dispose() {} }; } },
    };
    const source = readFileSync(new URL('../scene/sky.js', import.meta.url), 'utf8')
        .replace(/^import[\s\S]*?;\s*$/gm, '')
        .replace(/\bexport /g, '');
    const context = vm.createContext({
        THREE, scene: { fog: new Three.Fog(0, 0, 1200) }, renderer: {},
        sun: { intensity: 1 }, fill: { intensity: 1 }, ambient: { intensity: 1 },
        window: { location: { search }, ...(simClock ? { simClock } : {}) },
        document: { createElement: () => ({ width: 512, height: 256, getContext: () => ctx }) },
        parseTimeOfDayOverride: () => timeOverride,
        getRainIntensity: () => 0,
        setBuildingNightMode() {}, setCarNightMode() {}, setTramNightMode() {}, setStreetLampNightMode() {},
    });
    vm.runInContext(source + '\nglobalThis.api={setSceneTimeOfDayOverride,isSceneClockRealTime,updateSky};', context);
    return Object.assign(context.api, { scene: context.scene });
}

// three.js keeps the cubemap it converted from an equirectangular background
// until that texture is disposed, so a repainted sky must dispose itself or
// the visible sky stays at the hour it was first rendered (lit facades under
// a night sky after the daylight offer, 2026-09-10).
test('a session hour change repaints the sky and disposes the cached background', () => {
    const api = skyApi();
    api.setSceneTimeOfDayOverride(23);
    const background = api.scene.background;
    assert.ok(background?.isTexture, 'the sky is the painted equirect texture');
    let disposed = 0;
    background.addEventListener('dispose', () => { disposed += 1; });
    const versionAtNight = background.version;
    api.setSceneTimeOfDayOverride(12);
    assert.equal(api.scene.background, background, 'the same texture object stays in use');
    assert.ok(disposed >= 1, 'the stale cubemap conversion is released');
    assert.ok(background.version > versionAtNight, 'the repaint is flagged for upload');
    const before = disposed;
    api.updateSky();
    assert.equal(disposed, before, 'an unchanged hour does not repaint or dispose');
});

test('the sky follows the real clock only without overrides or a host clock', () => {
    const plain = skyApi();
    assert.equal(plain.isSceneClockRealTime(), true);
    plain.setSceneTimeOfDayOverride(12);
    assert.equal(plain.isSceneClockRealTime(), false, 'a session override is a chosen hour');
    plain.setSceneTimeOfDayOverride(null);
    assert.equal(plain.isSceneClockRealTime(), true, 'cleared again');
    assert.equal(skyApi({ timeOverride: 14 }).isSceneClockRealTime(), false, '?time= link');
    assert.equal(skyApi({ simClock: { getSimHour: () => 9 } }).isSceneClockRealTime(), false, 'timetable clock');
});
