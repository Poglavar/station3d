import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MODEL_CATALOG } from './model-catalog.js';
import { studyCatalog } from './model-studies.js';
import { MODEL_CODES } from '../models/model-codes.js';
import { generateModelCode, namedModel, validateModelCodes } from './model-names.js';
import { MODEL_FORMATS, cameraNearPlane, controlDefaults, copyModelPreview, disposePreview, fitCamera, inspectModel, modelBounds, normalizePreview, readViewerLink } from './model-viewer-core.js';
import { createModelImporter } from './model-import.js';

const $ = selector => document.querySelector(selector);
const params = new URLSearchParams(location.search);
const initial = readViewerLink(params);
const catalog = MODEL_CATALOG.map(entry => namedModel(entry));
const usedModelCodes = new Set(Object.values(MODEL_CODES));
const slots = [null, null];
const generations = [0, 0];
let activeSlot = 0, seed = initial.seed, playing = false, time = 0, lastFrame = null, pendingFrame = null;
let selectedCamera = initial.camera;
let importNumber = 0;
let renderedTime = null;
const materialsBeforeWireframe = new Map();
const viewport = $('#viewport');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x11191d);
const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 1000);
camera.position.set(8, 5, 10);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
viewport.append(renderer.domElement);
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.minDistance = 0.02;
orbit.addEventListener('change', requestRender);
const content = new THREE.Group();
scene.add(content);
const hemisphere = new THREE.HemisphereLight(0xe3eef9, 0x75665a, 2.2);
scene.add(hemisphere);
const sun = new THREE.DirectionalLight(0xfff1db, 3);
sun.position.set(-5, 9, 7);
scene.add(sun);
const fill = new THREE.DirectionalLight(0xc4dded, 1.2);
fill.position.set(5, 3, -5);
scene.add(fill);
const grid = new THREE.GridHelper(20, 20, 0x657f78, 0x314044);
grid.position.y = -0.004;
grid.material.transparent = true;
grid.material.opacity = 0.45;
scene.add(grid);
const water = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0x0e3b58, roughness: .25, metalness: .25 }));
water.name = 'Viewer sea';
water.rotation.x = -Math.PI / 2;
water.visible = false;
scene.add(water);
THREE.DefaultLoadingManager.onLoad = requestRender;
const importer = await createModelImporter(renderer);
const pmrem = new THREE.PMREMGenerator(renderer);
const room = new RoomEnvironment();
const environment = pmrem.fromScene(room, .04);
scene.environment = environment.texture;
scene.environmentIntensity = .45;
room.dispose(); pmrem.dispose();

function status(message, error = false) {
    $('#status').textContent = message;
    $('#status').classList.toggle('error', error);
}

function option(value, label = value) {
    const node = document.createElement('option');
    node.value = value;
    node.textContent = label;
    return node;
}

function importedModel(entry) {
    const code = generateModelCode(usedModelCodes);
    usedModelCodes.add(code);
    return namedModel(entry, code);
}

function provenanceLabel(provenance) {
    const label = document.createElement('span');
    label.className = 'provenance-label';
    label.textContent = provenance;
    label.title = `Created with ${provenance}`;
    return label;
}

function writeLink() {
    const url = new URL(location.href);
    for (const [key, value] of Object.entries({ model: slots[0]?.entry.id, compare: slots[1]?.entry.id, seed, cam: selectedCamera })) {
        if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
    }
    for (const [key, value] of Object.entries({ category: $('#category').value === 'all' ? '' : $('#category').value, night: $('#night').checked ? '1' : '', sea: $('#sea').checked ? '' : '0' })) {
        if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
    }
    const states = slots.map(slot => slot?.state || null);
    url.searchParams.set('controls', JSON.stringify(states));
    for (const key of ['actor', 'expression', 'talk', 'walk', 'turn', 'view', 'shot']) url.searchParams.delete(key);
    history.replaceState(null, '', url);
}

function renderCatalog() {
    const search = $('#search').value.trim().toLowerCase();
    const category = $('#category').value;
    const entries = catalog.filter(entry => (category === 'all' || entry.category === category || entry.collection === category) && `${entry.label} ${entry.id} ${entry.description} ${entry.provenance || ''} ${entry.llmModel || 'Not recorded'}`.toLowerCase().includes(search));
    $('#catalog-count').textContent = `${entries.length} / ${catalog.length}`;
    $('#model-list').replaceChildren(...entries.map(entry => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'model-button';
        button.dataset.model = entry.id;
        button.setAttribute('aria-current', String(slots[0]?.entry.id === entry.id));
        const title = document.createElement('strong'); title.textContent = entry.label;
        const detail = document.createElement('small'); detail.textContent = entry.category === 'people' ? 'People & faces' : entry.category === 'objects' ? 'Small objects' : entry.category === 'imports' ? 'Imported model' : 'Vehicle';
        if (entry.collection) detail.textContent += entry.collection === 'archive' ? ' · Earlier study' : ' · Detailed study';
        if (entry.provenance) detail.append(provenanceLabel(entry.provenance));
        button.append(title, detail);
        button.addEventListener('click', () => openEntry(entry.id).catch(() => {}));
        return button;
    }));
    const compare = $('#compare');
    compare.replaceChildren(option('', 'No comparison'), ...catalog.map(entry => option(entry.id, entry.label)));
    compare.value = slots[1]?.entry.id || '';
}

function applyStateDefaults(preview, saved = {}) {
    const state = controlDefaults(preview.controls);
    for (const control of preview.controls) {
        const value = saved[control.id];
        if (control.type === 'checkbox' && typeof value === 'boolean') state[control.id] = value;
        if (control.type === 'range' && typeof value === 'number' && Number.isFinite(value)) state[control.id] = Math.min(control.max, Math.max(control.min, value));
        if (control.type === 'select' && control.options.some(option => option.value === value)) state[control.id] = value;
    }
    return state;
}

function restoreWireframe() {
    for (const [mesh, original] of materialsBeforeWireframe) {
        for (const material of [].concat(mesh.material)) material.dispose();
        mesh.material = original;
    }
    materialsBeforeWireframe.clear();
}

function applyWireframe() {
    restoreWireframe();
    if (!$('#wireframe').checked) return;
    content.traverse(part => {
        if (!part.isMesh) return;
        const original = part.material;
        const clone = material => { const copy = material.clone(); copy.wireframe = true; return copy; };
        part.material = Array.isArray(original) ? original.map(clone) : clone(original);
        materialsBeforeWireframe.set(part, original);
    });
}

function retire(slot) {
    if (!slot) return;
    slot.mixer?.stopAllAction();
    slot.mixer?.uncacheRoot(slot.preview.object);
    disposePreview(slot.preview);
    slot.placement.removeFromParent();
}

async function openEntry(id, slotIndex = 0, saved = {}) {
    const generation = ++generations[slotIndex];
    if (!id && slotIndex === 1) {
        restoreWireframe(); retire(slots[1]); slots[1] = null; activeSlot = 0;
        finishSelection(); return;
    }
    const entry = catalog.find(item => item.id === id);
    if (!entry) { status(`Model “${id}” is not in this library. Choose a model from the catalog.`, true); return; }
    status(`Opening ${entry.label}…`);
    $('#reference-preview').hidden = true;
    let preview;
    try {
        preview = normalizePreview(await entry.create({ seed, columns: viewport.clientWidth < 600 ? 3 : 6 }));
        const state = applyStateDefaults(preview, saved);
        preview.seek?.(0, state);
        const stats = inspectModel(preview.object);
        if (generations[slotIndex] !== generation) { disposePreview(preview); return; }
        const placement = new THREE.Group();
        placement.add(preview.object);
        const slot = { entry, preview, state, placement, stats, mixer: null, action: null, clip: -1 };
        if (preview.animations.length) {
            slot.mixer = new THREE.AnimationMixer(preview.object);
            setClip(slot, 0);
        }
        restoreWireframe();
        retire(slots[slotIndex]);
        slots[slotIndex] = slot;
        content.add(placement);
        activeSlot = slotIndex;
        if (slots[1]) selectedCamera = 'auto';
        if (slotIndex === 0) { time = 0; setPlaying(false); }
        finishSelection();
        status(`${entry.label} ready. ${entry.category === 'imports' ? 'Imported files stay in this browser session.' : 'Original model scale; dimensions in metres.'}`);
        if (id === 'crowd-walking' && !matchMedia('(prefers-reduced-motion: reduce)').matches) setPlaying(true);
    } catch (error) {
        if (preview && !slots.some(slot => slot?.preview === preview)) disposePreview(preview);
        if (generation === generations[slotIndex]) status(`Could not open ${entry.label}: ${error.message}`, true);
        throw error;
    }
}

function setClip(slot, index) {
    slot.mixer.stopAllAction();
    slot.clip = index;
    slot.action = slot.mixer.clipAction(slot.preview.animations[index]);
    slot.action.reset().play();
    slot.mixer.setTime(time);
}

function arrange() {
    const visible = slots.filter(Boolean);
    if (!visible.length) return;
    const matchSize = visible.length > 1 && $('#normalize-size').checked;
    const hasWaterline = visible.some(slot => typeof slot.preview.waterline === 'number');
    $('#sea-control').hidden = !hasWaterline;
    water.visible = hasWaterline && $('#sea').checked;
    grid.visible = $('#grid').checked && !water.visible;
    const referenceSize = new THREE.Vector3(...visible[0].stats.dimensions).length();
    const scales = visible.map(slot => matchSize ? referenceSize / new THREE.Vector3(...slot.stats.dimensions).length() : 1);
    const widths = visible.map((slot, index) => slot.stats.dimensions[0] * scales[index]);
    const gap = visible.length > 1 ? Math.max(...widths) * 0.25 + referenceSize * 0.08 : 0;
    let left = -(widths.reduce((a, b) => a + b, 0) + gap * (visible.length - 1)) / 2;
    visible.forEach((slot, index) => {
        const center = slot.stats.bounds.getCenter(new THREE.Vector3());
        const scale = scales[index];
        slot.placement.scale.setScalar(scale);
        const ground = water.visible && typeof slot.preview.waterline === 'number' ? slot.preview.waterline : slot.stats.bounds.min.y;
        slot.placement.position.set(left + widths[index] / 2 - center.x * scale, -ground * scale, -center.z * scale);
        left += widths[index] + gap;
    });
    content.updateMatrixWorld(true);
    const bounds = modelBounds(content);
    const size = bounds.getSize(new THREE.Vector3());
    grid.scale.setScalar(Math.max(size.x, size.z, size.y, 0.5) / 8);
    grid.position.y = -Math.max(size.length() * 0.0005, 0.001);
    water.scale.setScalar(Math.max(size.x, size.z, 1) * 10);
}

function applyLighting() {
    restoreWireframe();
    const night = $('#night').checked;
    hemisphere.intensity = night ? .20 : 2.2;
    sun.intensity = night ? .14 : 3;
    sun.color.setHex(night ? 0x6f8fc0 : 0xfff1db);
    fill.intensity = night ? .08 : 1.2;
    scene.environmentIntensity = night ? .025 : .45;
    scene.background.set(night ? 0x060b14 : { slate: 0x11191d, light: 0xd9e3e5, dark: 0x07090a }[$('#background').value]);
    water.material.color.setHex(night ? 0x061622 : 0x0e3b58);
    for (const slot of slots.filter(Boolean)) slot.preview.setLighting?.(night);
    applyWireframe();
    requestRender();
}

function finishSelection() {
    arrange();
    applyLighting();
    renderCatalog();
    renderInspector();
    applyTime(true);
    setCamera(selectedCamera);
    writeLink();
}

function renderInspector() {
    const slot = slots[activeSlot] || slots[0];
    if (!slot) return;
    $('#model-category').textContent = slot.entry.category;
    $('#model-title').textContent = slot.entry.label;
    $('#model-provenance').replaceChildren(...(slot.entry.provenance ? [provenanceLabel(slot.entry.provenance)] : []));
    $('#model-provenance').hidden = !slot.entry.provenance;
    $('#model-description').textContent = slot.entry.description || '';
    $('#source').textContent = slot.entry.sourceLabel || slot.entry.source || 'Local file or in-memory mesh';
    if (slot.entry.source && !slot.entry.source.startsWith('Local ')) $('#source').href = new URL(slot.entry.source, document.baseURI); else $('#source').removeAttribute('href');
    const metric = value => value >= 10 ? value.toFixed(1) : value.toFixed(2);
    const stats = [ ['LLM model', slot.entry.llmModel || 'Not recorded'], ['Size · W × H × D', slot.stats.dimensions.map(metric).join(' × ') + ' m'], ['Visible meshes', slot.stats.meshes.toLocaleString()], ['Triangles', slot.stats.triangles.toLocaleString()], ['Vertices', slot.stats.vertices.toLocaleString()] ];
    $('#model-stats').replaceChildren(...stats.flatMap(([name, value]) => { const dt = document.createElement('dt'); const dd = document.createElement('dd'); dt.textContent = name; dd.textContent = value; return [dt, dd]; }));
    $('#context-controls').replaceChildren(...slot.preview.controls.map(control => controlElement(control, slot)));
    const references = slot.preview.references || [];
    $('#references').hidden = references.length === 0;
    $('#references').replaceChildren(...references.map(reference => {
        const button = document.createElement('button');
        button.type = 'button'; button.textContent = reference.label;
        button.addEventListener('click', () => {
            setPlaying(false);
            const image = $('#reference-preview img');
            image.src = reference.url; image.alt = `${slot.entry.label} · ${reference.label}`;
            $('#reference-preview').hidden = false;
        });
        return button;
    }));
    if (slot.preview.animations.length) {
        const clips = document.createElement('label'); clips.className = 'field'; clips.textContent = 'Animation clip';
        const select = document.createElement('select'); select.setAttribute('aria-label', 'Animation clip');
        select.append(...slot.preview.animations.map((clip, index) => option(index, clip.name || `Clip ${index + 1}`)));
        select.value = String(slot.clip);
        select.onchange = () => { setClip(slot, Number(select.value)); time = 0; renderInspector(); applyTime(true); requestRender(); };
        clips.append(select); $('#context-controls').append(clips);
    }
    const presets = { auto: 'Whole model', front: 'Front', quarter: 'Three-quarter', side: 'Side', back: 'Back', top: 'Top', ...Object.fromEntries(Object.keys(slot.preview.cameraViews).map(key => [key, key.replace(/[-_]/g, ' ').replace(/^./, letter => letter.toUpperCase())])) };
    $('#camera-view').replaceChildren(...Object.entries(presets).map(([value, name]) => option(value, name)));
    $('#camera-view').value = selectedCamera in presets ? selectedCamera : 'auto';
    $('#shuffle').hidden = !slot.entry.id.startsWith('crowd-');
    $('#inspect-tabs').hidden = !slots[1];
    document.querySelectorAll('[data-slot]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.slot) === activeSlot)));
    $('.normalize-control').hidden = !slots[1];
    $('#comparison-note').hidden = !slots[1];
    $('#stage-label').textContent = slots.filter(Boolean).map(slot => slot.entry.label).join('  /  ');
    const duration = Math.max(0.1, ...slots.filter(Boolean).map(slot => slot.preview.animations[slot.clip]?.duration || slot.preview.duration || 10));
    $('#timeline').max = String(duration);
    if (time > duration) time = 0;
}

function controlElement(control, slot) {
    const label = document.createElement('label'); label.className = 'control-row';
    const title = document.createElement('span'); title.textContent = control.label; label.append(title);
    const input = document.createElement(control.type === 'select' ? 'select' : 'input');
    input.setAttribute('aria-label', control.label);
    input.dataset.control = control.id;
    if (control.type === 'select') {
        input.append(...control.options.map(item => option(item.value, item.label)));
        input.value = slot.state[control.id];
    } else {
        input.type = control.type;
        if (control.type === 'checkbox') input.checked = slot.state[control.id];
        else { input.min = control.min; input.max = control.max; input.step = control.step || 0.01; input.value = slot.state[control.id]; }
    }
    let output;
    if (control.type === 'range') {
        const wrapper = document.createElement('span'); wrapper.className = 'control-range';
        output = document.createElement('output'); output.textContent = Number(input.value).toFixed(2);
        wrapper.append(input, output); label.append(wrapper);
    } else label.append(input);
    input.addEventListener('input', () => {
        slot.state[control.id] = control.type === 'checkbox' ? input.checked : control.type === 'range' ? Number(input.value) : input.value;
        if (output) output.textContent = Number(input.value).toFixed(2);
        applyTime(true);
        if (['walk', 'talk', 'turn', 'propellers', 'propeller'].includes(control.id) && slot.state[control.id]) setPlaying(true);
        requestRender(); writeLink();
    });
    return label;
}

function setCamera(name = 'auto') {
    if (!slots[0]) return;
    $('#reference-preview').hidden = true;
    const slot = slots[activeSlot] || slots[0];
    const preset = slot.preview.cameraViews[name];
    if (preset) {
        camera.position.copy(slot.placement.localToWorld(new THREE.Vector3(...preset.position)));
        orbit.target.copy(slot.placement.localToWorld(new THREE.Vector3(...preset.target)));
        camera.fov = preset.fov || 38;
        camera.near = cameraNearPlane(camera.position.distanceTo(orbit.target));
        camera.far = Math.max(1000, camera.position.length() * 10);
    } else {
        const directions = { auto: [1, .65, 1.4], quarter: [1, .4, 1.4], front: [0, .1, 1], side: [1, .1, 0], back: [0, .1, -1], top: [0, 1, .001] };
        const frame = fitCamera(modelBounds(content), camera.aspect, directions[name] || directions.auto);
        camera.position.copy(frame.position); orbit.target.copy(frame.target);
        camera.near = frame.near; camera.far = frame.far; camera.fov = frame.fov;
    }
    selectedCamera = name;
    $('#camera-view').value = name;
    camera.updateProjectionMatrix(); orbit.update(); requestRender();
}

function setPlaying(value) {
    playing = value;
    lastFrame = null;
    $('#play').textContent = playing ? 'Ⅱ Pause' : '▶ Play';
    $('#play').setAttribute('aria-label', playing ? 'Pause animation' : 'Play animation');
    requestRender();
}

function applyTime(seek = false, dt = 0) {
    for (const slot of slots.filter(Boolean)) {
        if (seek && slot.preview.seek) slot.preview.seek(time, slot.state);
        else slot.preview.update?.(time, dt, slot.state);
        slot.mixer?.setTime(time);
    }
    $('#timeline').value = String(time);
    $('#time').textContent = `${time.toFixed(2)} s`;
}

function requestRender() {
    if (pendingFrame !== null || document.hidden) return;
    pendingFrame = requestAnimationFrame(render);
}

function renderScene() {
    const near = cameraNearPlane(camera.position.distanceTo(orbit.target));
    if (Math.abs(camera.near - near) > 1e-8) {
        camera.near = near;
        camera.updateProjectionMatrix();
    }
    renderer.render(scene, camera);
}

function render(now) {
    pendingFrame = null;
    if (playing) {
        const dt = lastFrame === null ? 0 : Math.min((now - lastFrame) / 1000, 0.1) * Number($('#speed').value);
        const end = Number($('#timeline').max);
        time += dt;
        const wrapped = time > end;
        if (wrapped) time %= end;
        applyTime(wrapped, dt);
    }
    lastFrame = now;
    const moved = orbit.update();
    renderScene();
    renderedTime = time;
    if (playing || moved) requestRender();
}

function resize() {
    const { width, height } = viewport.getBoundingClientRect();
    if (!width || !height) return;
    camera.aspect = width / height; camera.updateProjectionMatrix();
    renderer.setSize(width, height, false); requestRender();
}

async function openFiles(fileList) {
    $('#import-error').textContent = '';
    const files = Array.from(fileList);
    let moduleOptions;
    try { moduleOptions = { exportName: $('#module-export').value.trim(), parameters: JSON.parse($('#module-args').value || '[]') }; }
    catch { $('#import-error').textContent = 'Factory arguments must be valid JSON.'; return; }
    const entries = files.filter(file => MODEL_FORMATS.includes(file.name.split('.').pop().toLowerCase())).map(primary => importedModel({
        id: `import-${++importNumber}`, category: 'imports', label: primary.name.replace(/\.[^.]+$/, ''), provenance: /\.blend$/i.test(primary.name) ? 'Blender' : undefined,
        description: 'Local model · available until this page is closed', source: 'Local files',
        create: () => importer.files(files, { primary, ...moduleOptions }),
    }));
    if (!entries.length) { $('#import-error').textContent = 'No supported model file was selected.'; return; }
    catalog.push(...entries); renderCatalog();
    try { await openEntry(entries[0].id); $('#import-dialog').close(); }
    catch (error) { $('#import-error').textContent = error.message; }
}

$('#search').addEventListener('input', renderCatalog);
$('#category').addEventListener('change', () => { renderCatalog(); writeLink(); });
$('#compare').addEventListener('change', () => openEntry($('#compare').value, 1).catch(() => {}));
$('#normalize-size').addEventListener('change', () => { arrange(); setCamera('auto'); });
$('#frame').addEventListener('click', () => { setCamera('auto'); writeLink(); });
$('#camera-view').addEventListener('change', () => { setCamera($('#camera-view').value); writeLink(); });
$('#grid').addEventListener('change', () => { grid.visible = $('#grid').checked && !water.visible; requestRender(); });
$('#wireframe').addEventListener('change', () => { applyWireframe(); requestRender(); });
$('#background').addEventListener('change', applyLighting);
$('#night').addEventListener('change', () => { applyLighting(); writeLink(); });
$('#sea').addEventListener('change', () => { arrange(); setCamera(selectedCamera); writeLink(); });
$('#play').addEventListener('click', () => setPlaying(!playing));
$('#rewind').addEventListener('click', () => { time = 0; applyTime(true); requestRender(); });
$('#timeline').addEventListener('input', () => { setPlaying(false); time = Number($('#timeline').value); applyTime(true); requestRender(); });
$('#shuffle').addEventListener('click', () => { seed = String((Number(seed) || 0) + 1); openEntry(slots[activeSlot].entry.id, activeSlot, slots[activeSlot].state).catch(() => {}); });
document.querySelectorAll('[data-slot]').forEach(button => button.addEventListener('click', () => { activeSlot = Number(button.dataset.slot); renderInspector(); }));
$('#capture').addEventListener('click', () => {
    renderScene();
    renderer.domElement.toBlob(blob => {
        if (!blob) return;
        const url = URL.createObjectURL(blob); const link = document.createElement('a');
        link.href = url; link.download = `${slots[activeSlot]?.entry.id || 'model'}-${selectedCamera}.png`; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
});
$('#open-import').addEventListener('click', () => { $('#import-error').textContent = ''; $('#import-dialog').showModal(); });
$('#close-reference').addEventListener('click', () => { $('#reference-preview').hidden = true; requestRender(); });
$('#model-files').addEventListener('change', event => openFiles(event.target.files));
$('#model-folder').addEventListener('change', event => openFiles(event.target.files));
$('#url-form').addEventListener('submit', async event => {
    event.preventDefault();
    $('#import-error').textContent = '';
    try {
        const url = $('#model-url').value.trim();
        const parameters = JSON.parse($('#module-args').value || '[]');
        const exportName = $('#module-export').value.trim();
        const entry = importedModel({ id: `import-${++importNumber}`, category: 'imports', label: url.split('/').pop().split('?')[0].replace(/\.[^.]+$/, ''), provenance: /\.blend(?:\?|$)/i.test(url) ? 'Blender' : undefined, description: exportName ? `JavaScript · ${exportName}` : 'Imported from URL', source: url, create: () => importer.url(url, { parameters, exportName }) });
        catalog.push(entry); renderCatalog();
        await openEntry(entry.id); $('#import-dialog').close();
    } catch (error) { $('#import-error').textContent = error.message; }
});
viewport.addEventListener('dragover', event => { event.preventDefault(); viewport.classList.add('dragging'); });
viewport.addEventListener('dragleave', () => viewport.classList.remove('dragging'));
viewport.addEventListener('drop', event => { event.preventDefault(); viewport.classList.remove('dragging'); openFiles(event.dataTransfer.files); });
document.addEventListener('visibilitychange', () => { lastFrame = null; if (!document.hidden) requestRender(); });
viewport.addEventListener('keydown', event => { if (event.code === 'Space') { event.preventDefault(); setPlaying(!playing); } });
new ResizeObserver(resize).observe(viewport);

// Direct Object3D and custom adapter entry point: no second renderer or viewer.
window.modelViewer = {
    async open(value, { label = 'Imported model', compare = false } = {}) {
        const entry = importedModel({ id: `import-${++importNumber}`, label, category: 'imports', provenance: 'Three.js', description: 'In-memory Three.js model', create: typeof value === 'function' ? value : () => copyModelPreview(value) });
        catalog.push(entry); await openEntry(entry.id, compare ? 1 : 0);
    },
    select: openEntry, openFiles,
    seek(value) {
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Animation time must be a finite number');
        time = Math.max(0, value); setPlaying(false); applyTime(true);
        renderScene(); renderedTime = time;
    },
    setControl(id, value, index = activeSlot) { const slot = slots[index]; if (!slot) return; slot.state = applyStateDefaults(slot.preview, { ...slot.state, [id]: value }); applyTime(true); renderInspector(); requestRender(); },
    get snapshot() { return { models: slots.map(slot => slot?.entry.id || null), states: slots.map(slot => ({ ...slot?.state })), playing, time, renderedTime, seed, renderInfo: { ...renderer.info.render } }; },
    scene, camera, renderer, controls: orbit, requestRender,
};

if (params.get('chrome') === '0') document.body.classList.add('study');
// Durable studies live under models/ and load on static hosts as well as locally.
let catalogError = '';
try {
    const response = await fetch(new URL('./station-3d/models/viewer-studies.json', document.baseURI), { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const studies = studyCatalog(await response.json(), importer, document.baseURI);
    validateModelCodes([...MODEL_CATALOG, ...studies]);
    catalog.unshift(...studies.map(entry => namedModel(entry)));
} catch (error) { catalogError = `The study catalog could not load: ${error.message}.`; }
if ([...$('#category').options].some(option => option.value === params.get('category'))) $('#category').value = params.get('category');
$('#night').checked = params.get('night') === '1';
$('#sea').checked = params.get('sea') !== '0';
renderCatalog(); resize();
let saved = [];
try { saved = JSON.parse(params.get('controls') || '[]'); } catch { /* invalid optional link state */ }
const legacyState = Object.fromEntries(['talk', 'walk', 'turn'].filter(key => params.has(key)).map(key => [key, params.get(key) === '1']));
if (params.has('expression')) legacyState.expression = params.get('expression');
try {
    await openEntry(initial.model, 0, { ...legacyState, ...saved[0] });
    if (initial.compare) await openEntry(initial.compare, 1, saved[1]);
    activeSlot = 0; renderInspector(); setCamera(initial.camera);
    if (Object.values(legacyState).some(value => value === true)) setPlaying(true);
} catch { /* openEntry already shows the actionable error */ }
if (catalogError) status(catalogError, true);
fetch(new URL('./__model_viewer__/blender', document.baseURI), { cache: 'no-store' }).then(response => response.json()).then(data => {
    $('#blender-status').textContent = data.available ? 'Blender is ready. .blend files are converted locally; pack external textures in Blender before importing.' : 'For .blend import, install Blender and start npm run models:viewer. GLB exports work on any host.';
}).catch(() => { $('#blender-status').textContent = 'Blender import is available through npm run models:viewer. GLB exports work on any host.'; });
window.addEventListener('pagehide', () => {
    if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
    restoreWireframe(); slots.forEach(retire); importer.dispose(); orbit.dispose(); environment.dispose(); water.geometry.dispose(); water.material.dispose(); renderer.dispose();
}, { once: true });
