// Characterizes the real HUD's rendering and resize wiring without a browser.
// Layout getters are tripwires: a per-frame status update must never flush layout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { routeOverlayTopPx } from '../core/navigation-guidance.js';
import { finiteOrNull } from '../core/math.js';
import { escapeHtml, formatCurrencyEur } from '../core/text.js';
import { formatAircraftInstruments } from '../core/aircraft-readout.js';

function fixture() {
    const observers = [];
    const mediaListeners = [];
    const languageListeners = [];
    let topWrites = 0;
    class Element {
        className = '';
        children = [];
        parentNode = null;
        innerHTML = '';
        textContent = '';
        attributes = {};
        style = new Proxy({}, { set: (target, key, value) => {
            if (key === 'top' && this.classList.contains('station-3d-route-overlay')) topWrites++;
            target[key] = value; return true;
        } });
        classList = {
            contains: name => this.className.split(/\s+/).includes(name),
            add: name => { if (!this.classList.contains(name)) this.className += ' ' + name; },
            remove: name => { this.className = this.className.split(/\s+/).filter(n => n !== name).join(' '); },
        };
        appendChild(el) { this.children.push(el); el.parentNode = this; return el; }
        insertBefore(el) { return this.appendChild(el); }
        setAttribute(name, value) { this.attributes[name] = value; }
        addEventListener() {}
        querySelector() { return new Element(); }
        get offsetParent() { throw Error('synchronous offsetParent read'); }
        get offsetTop() { throw Error('synchronous offsetTop read'); }
        get offsetHeight() { throw Error('synchronous offsetHeight read'); }
        getBoundingClientRect() { throw Error('synchronous rectangle read'); }
    }
    const container = new Element();
    const status = new Element();
    status.className = 'station-3d-status hidden';
    const media = { matches: false, addEventListener: (_, fn) => mediaListeners.push(fn) };
    const scope = {
        window: { matchMedia: () => media }, document: { createElement: () => new Element() },
        containerEl: container, modalEl: new Element(), statusOverlayEl: status,
        ResizeObserver: class {
            constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
            observe(target, options) { this.targets.push({ target, options }); }
        },
        escapeHtml, formatCurrencyEur, finiteOrNull, routeOverlayTopPx,
        campaignOwnsInteraction: () => false,
        t: key => key, onLangChange: fn => languageListeners.push(fn),
        setShareToastHandler() {}, ensureDashboard() {}, adoptIntoDashboardLeft() {},
        setDashboardSpeed() {}, setDashboardInfo() {}, setDashboardMetrics() {}, setDashboardStation() {},
        isDashboardVisible: () => false, formatRailChainage: () => '', formatSignedGradePercent: () => '',
        formatAircraftInstruments,
    };
    const code = readFileSync(new URL('../ui/hud.js', import.meta.url), 'utf8')
        .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*$/gm, '')
        .replace(/^export /gm, '');
    vm.runInNewContext(code + '\nthis.api = { ensureHud, renderStatusOverlay };', scope);
    scope.api.ensureHud();
    const route = container.children.find(el => el.classList.contains('station-3d-route-overlay'));
    return { ...scope.api, status, route, observers, topWrites: () => topWrites,
        resize(height) {
            const observed = observers.find(o => o.targets.some(t => t.target === status));
            assert.ok(observed, 'the actual status element must be observed');
            observed.callback([{ target: status, borderBoxSize: [{ blockSize: height }] }]);
        },
        compact(value) { media.matches = value; for (const fn of mediaListeners) fn(); },
        languageChanged() { for (const fn of languageListeners) fn(); },
    };
}

test('unchanged and changing per-frame status does not synchronously read layout', () => {
    const hud = fixture();
    for (let frame = 0; frame < 100; frame++) {
        hud.renderStatusOverlay({ walkMode: true, speedKmh: frame, altitudeM: 118.7 });
    }
    assert.equal(hud.route.style.top, '14px');
    assert.match(hud.route.innerHTML, /99 km\/h/);
    assert.match(hud.route.innerHTML, /118\.7 m/);
    assert.equal(hud.topWrites(), 1, 'unchanged position must not be rewritten each frame');
    hud.renderStatusOverlay(null);
    assert.equal(hud.route.classList.contains('hidden'), true);
});

test('visible vehicle prompts preserve their spacing using the observed border-box height', () => {
    const hud = fixture();
    hud.renderStatusOverlay({ speedKmh: 18, gtaMode: true, driving: true, vehicleHealth: 92,
        gtaInteractionKey: 'gta.exit' });
    hud.resize(32);
    assert.equal(hud.status.classList.contains('hidden'), false);
    assert.match(hud.status.innerHTML, /92%/);
    assert.match(hud.status.innerHTML, /gta.exit/);
    assert.equal(hud.route.style.top, '52px');
    hud.resize(48);
    assert.equal(hud.route.style.top, '68px');
    const writes = hud.topWrites();
    hud.resize(48);
    assert.equal(hud.topWrites(), writes);
});

test('a phone keeps the stacked readouts at one top whatever the status pill does', () => {
    const hud = fixture();
    const status = { speedKmh: 18, gtaInteractionKey: 'gta.exit' };
    hud.renderStatusOverlay(status);
    hud.resize(32);
    hud.compact(true);
    assert.equal(hud.route.style.top, '60px', 'row top 22 plus the 38 px status band');
    hud.languageChanged();
    hud.renderStatusOverlay(status);
    hud.resize(48);
    assert.equal(hud.route.style.top, '60px', 'a taller prompt does not move the column');
    hud.renderStatusOverlay({ walkMode: true, speedKmh: 0 });
    hud.resize(0);
    assert.equal(hud.route.style.top, '60px', 'nor does the prompt going away');
    hud.compact(false);
    hud.renderStatusOverlay(status);
    hud.resize(48);
    assert.equal(hud.route.style.top, '68px', 'a desktop still stacks under the measured pill');
});

test('hidden status ignores stale resize delivery and a later reveal receives its real height', () => {
    const hud = fixture();
    hud.renderStatusOverlay({ speedKmh: 18, gtaInteractionKey: 'gta.exit' });
    hud.resize(48);
    hud.renderStatusOverlay({ walkMode: true, speedKmh: 0 });
    hud.resize(48);
    assert.equal(hud.route.style.top, '14px');
    hud.resize(0);
    hud.renderStatusOverlay({ speedKmh: 18, gtaInteractionKey: 'gta.exit' });
    hud.resize(32);
    assert.equal(hud.route.style.top, '52px');
});

test('HUD reuse installs one border-box observer, not a new observer per session/frame', () => {
    const hud = fixture();
    hud.ensureHud();
    hud.ensureHud();
    assert.equal(hud.observers.length, 1);
    assert.equal(hud.observers[0].targets.length, 1);
    assert.equal(hud.observers[0].targets[0].target, hud.status);
    assert.equal(hud.observers[0].targets[0].options.box, 'border-box');
});
