// Compare cold actors, compile-only preparation, and the real queued warmup.
// Shader-link/status-query counts and pixel parity are correctness assertions,
// not performance measurements; the fixture loads no city data or API traffic.
import * as THREE from 'three';
import { createPersonMesh, PERSON_BODY_COLORS, PERSON_LEG_COLORS } from '../../world/person-mesh.js';
import { createLeashedDog } from '../../world/dog-mesh.js';
import { prewarmDetachedObject } from '../../core/detached-gpu-prewarm.js';
import { createQueuedShaderWarmup } from '../../core/queued-shader-warmup.js';

const audit = window.auditResult = { done: false, cases: [], errors: [] };
addEventListener('error', event => audit.errors.push(event.message));
addEventListener('unhandledrejection', event => audit.errors.push(String(event.reason)));
const originalError = console.error.bind(console);
console.error = (...args) => { audit.errors.push(args.map(String).join(' ')); originalError(...args); };
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
function actors({ visible = false } = {}) {
    const root = new THREE.Group();
    for (const [index, kind] of ['kid', 'female', 'male'].entries()) {
        const person = createPersonMesh({ kind,
            ...(visible ? { bodyColor: PERSON_BODY_COLORS.at(-1), legColor: PERSON_LEG_COLORS.at(-1) } : {}),
        });
        person.position.x = index * 1.2 - 1.2;
        root.add(person);
    }
    const dog = createLeashedDog({ random: () => visible ? 0.9 : 0 });
    dog.position.x = 1.8;
    root.add(dog);
    return root;
}
let reference = null;
try {
    for (const mode of ['cold', 'compile-only', 'queued']) {
        const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
        renderer.setSize(256, 160);
        renderer.shadowMap.enabled = true;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        const gl = renderer.getContext(), debug = gl.getExtension('WEBGL_debug_renderer_info');
        audit.renderer ||= debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'unknown';
        audit.parallelShaderCompile = !!gl.getExtension('KHR_parallel_shader_compile');
        const result = { mode, links: 0, statusQueries: 0, warmLinks: 0, warmStatusQueries: 0 };
        let measuring = false;
        const link = gl.linkProgram.bind(gl), info = gl.getProgramInfoLog.bind(gl);
        gl.linkProgram = program => { result[measuring ? 'links' : 'warmLinks']++; return link(program); };
        gl.getProgramInfoLog = program => { result[measuring ? 'statusQueries' : 'warmStatusQueries']++; return info(program); };
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x203044);
        scene.fog = new THREE.Fog(0x506070, 20, 100);
        scene.add(new THREE.HemisphereLight(0xffffff, 0x556677, 1));
        const sun = new THREE.DirectionalLight(0xffffff, 2);
        sun.castShadow = true; sun.shadow.mapSize.set(64, 64); sun.position.set(2, 5, 3); scene.add(sun);
        const world = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshStandardMaterial());
        world.position.set(-2, 0, 0); world.castShadow = true; scene.add(world);
        const camera = new THREE.PerspectiveCamera(45, 256 / 160, 0.1, 100);
        camera.position.set(0, 2, 8); camera.lookAt(0, 0.8, 0); camera.updateMatrixWorld();
        // The loaded city has already drawn ordinary surfaces and shadows.
        renderer.render(scene, camera);
        const prototype = actors();
        let warmup = null;
        if (mode === 'compile-only') {
            const iterator = prewarmDetachedObject(prototype, {
                renderer, camera, targetScene: scene, uploadGeometry: false, prewarmTextures: false,
            });
            for (let visit = 0; visit < 100; visit++) {
                const outcome = iterator.next();
                if (outcome.done) break;
                if (outcome.value?.ready) await outcome.value.ready;
                await frame(); renderer.render(scene, camera);
                if (visit === 99) throw new Error('compile-only did not finish');
            }
        } else if (mode === 'queued') {
            warmup = createQueuedShaderWarmup(prototype, { renderer, camera, targetScene: scene });
            for (let visit = 0; !warmup.ready && visit < 100; visit++) {
                if (warmup.error) throw warmup.error;
                await frame(); renderer.render(scene, camera);
            }
            if (!warmup.ready) throw new Error('queued warmup did not finish');
        }
        const visible = actors({ visible: true }); scene.add(visible);
        measuring = true; renderer.render(scene, camera); measuring = false;
        const pixels = new Uint8Array(256 * 160 * 4);
        gl.readPixels(0, 0, 256, 160, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        if (!reference) reference = pixels;
        result.pixelDifferences = pixels.reduce((count, value, index) => count + (value !== reference[index] ? 1 : 0), 0);
        result.glError = gl.getError();
        audit.cases.push(result);
        const image = new Image(); image.src = renderer.domElement.toDataURL(); image.alt = mode; image.title = mode;
        document.querySelector('#views').append(image);
        await warmup?.dispose();
        renderer.dispose(); renderer.forceContextLoss();
        world.geometry.dispose(); world.material.dispose(); sun.shadow.dispose();
    }
} catch (error) { audit.errors.push(String(error.stack || error)); }
audit.done = true;
const [cold, compileOnly, queued] = audit.cases;
audit.passed = audit.errors.length === 0 && audit.cases.length === 3
    && cold.links > 0 && cold.statusQueries > 0
    && compileOnly.links === 0 && compileOnly.statusQueries > 0
    && queued.links === 0 && queued.statusQueries === 0
    && audit.cases.every(result => result.pixelDifferences === 0 && result.glError === 0);
document.querySelector('#result').textContent = JSON.stringify(audit, null, 2);
