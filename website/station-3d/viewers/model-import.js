import * as THREE from 'three';
import { copyModelPreview, modelFormat, normalizePreview } from './model-viewer-core.js';
import { isMeshDocument, parseMeshDocument } from './model-mesh-document.js';

function pathKey(path) {
    return decodeURIComponent(path).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

// Keep directory paths intact; only use a basename when it is unambiguous.
export function localFileResolver(files, createURL = file => URL.createObjectURL(file)) {
    const paths = new Map(), basenames = new Map(), urls = new Map();
    for (const file of files) {
        const path = pathKey(file.webkitRelativePath || file.name);
        paths.set(path, file);
        const name = path.split('/').pop();
        basenames.set(name, basenames.has(name) ? null : file);
    }
    return {
        resolve(url) {
            if (/^(blob:|data:)/.test(url)) return url;
            const path = pathKey(new URL(url, 'https://model.local/').pathname);
            const exact = paths.get(path) || [...paths.entries()].find(([key]) => path.endsWith('/' + key))?.[1];
            const file = exact || basenames.get(path.split('/').pop());
            if (!file) throw new Error(`Missing or ambiguous companion file: ${path}. Open the model together with its textures and buffers, or choose its folder.`);
            if (!urls.has(file)) urls.set(file, createURL(file));
            return urls.get(file);
        },
        dispose() { for (const url of urls.values()) URL.revokeObjectURL(url); urls.clear(); },
    };
}

export async function loadProceduralModule(url, { exportName = '', parameters = [], importer = path => import(/* @vite-ignore */ path) } = {}) {
    const module = await importer(url);
    const candidates = Object.keys(module).filter(key => typeof module[key] === 'function' || module[key]?.isObject3D || module[key]?.isBufferGeometry);
    const selected = exportName || ('default' in module ? 'default' : candidates.length === 1 ? candidates[0] : '');
    if (!selected || !(selected in module)) throw new Error(`Choose a module export: ${candidates.join(', ') || 'no model exports found'}.`);
    const exported = module[selected];
    return typeof exported === 'function'
        ? normalizePreview(await exported(...(Array.isArray(parameters) ? parameters : [parameters])))
        : copyModelPreview(exported);
}

export async function createModelImporter(renderer, { decoderBase = new URL('../../vendor/three/examples/jsm/libs/', import.meta.url).href } = {}) {
    let draco, ktx;
    async function parse(data, format, { base = '', manager = new THREE.LoadingManager(), files = [] } = {}) {
        if (format === 'json') {
            const json = typeof data === 'string' ? JSON.parse(data) : data;
            if (isMeshDocument(json)) return normalizePreview(parseMeshDocument(json));
            if (json.asset?.version) return parse(JSON.stringify(json), 'gltf', { base, manager, files });
            if (json.metadata?.type === 'BufferGeometry' || json.data?.attributes) return normalizePreview(new THREE.BufferGeometryLoader().parse(json));
            return normalizePreview(await new THREE.ObjectLoader(manager).setResourcePath(base).parseAsync(json));
        }
        if (format === 'glb' || format === 'gltf') {
            const [{ GLTFLoader }, { DRACOLoader }, { KTX2Loader }, { MeshoptDecoder }] = await Promise.all([
                import('three/addons/loaders/GLTFLoader.js'), import('three/addons/loaders/DRACOLoader.js'),
                import('three/addons/loaders/KTX2Loader.js'), import('three/addons/libs/meshopt_decoder.module.js'),
            ]);
            draco ??= new DRACOLoader().setDecoderPath(decoderBase + 'draco/gltf/').setWorkerLimit(2);
            if (renderer) ktx ??= new KTX2Loader().setTranscoderPath(decoderBase + 'basis/').detectSupport(renderer).setWorkerLimit(2);
            const loader = new GLTFLoader(manager).setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
            if (ktx) loader.setKTX2Loader(ktx);
            return normalizePreview(await loader.parseAsync(data, base));
        }
        if (format === 'obj') {
            const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
            const loader = new OBJLoader(manager);
            const libraries = [...data.matchAll(/^mtllib\s+(.+)$/gm)].map(match => match[1].trim());
            if (libraries.length) {
                const { MTLLoader } = await import('three/addons/loaders/MTLLoader.js');
                const materials = new MTLLoader(manager).setResourcePath(base);
                // OBJLoader takes a single MaterialCreator; join all libraries.
                const texts = await Promise.all(libraries.map(async name => {
                    const url = manager.resolveURL(new URL(name, base || document.baseURI).href);
                    const response = await fetch(url, { cache: 'no-store' });
                    if (!response.ok) throw new Error(`Material library could not be loaded: ${name}`);
                    return response.text();
                }));
                const creator = materials.parse(texts.join('\n'), base);
                creator.preload();
                loader.setMaterials(creator);
            }
            return normalizePreview(loader.parse(data));
        }
        if (format === 'fbx') {
            const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
            return normalizePreview(new FBXLoader(manager).parse(data, base));
        }
        if (format === 'dae') {
            const { ColladaLoader } = await import('three/addons/loaders/ColladaLoader.js');
            return normalizePreview(new ColladaLoader(manager).parse(data, base));
        }
        if (format === 'stl' || format === 'ply') {
            const { STLLoader } = format === 'stl' ? await import('three/addons/loaders/STLLoader.js') : {};
            const { PLYLoader } = format === 'ply' ? await import('three/addons/loaders/PLYLoader.js') : {};
            const geometry = new (STLLoader || PLYLoader)().parse(data);
            geometry.computeVertexNormals();
            return normalizePreview(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: geometry.attributes.color ? 0xffffff : 0xa8bdb1, vertexColors: !!geometry.attributes.color, side: THREE.DoubleSide })));
        }
        throw new Error(`No loader for ${format}.`);
    }

    async function blend(data) {
        const response = await fetch(new URL('./__model_viewer__/blend', document.baseURI), {
            method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Model-Viewer': '1' }, body: data,
        });
        if (!response.ok) {
            let detail = '';
            try { const body = await response.json(); detail = body.error || body.detail || ''; } catch { /* a static host returns HTML */ }
            throw new Error(detail || 'Blender import requires the local viewer server: npm run models:viewer. You can also export GLB from Blender and open it here.');
        }
        return parse(await response.arrayBuffer(), 'glb');
    }

    const binary = format => ['glb', 'blend', 'fbx', 'stl', 'ply'].includes(format);
    return {
        async files(files, { primary = files[0], ...options } = {}) {
            const format = modelFormat(primary.name);
            if (format === 'blend') return blend(await primary.arrayBuffer());
            if (format === 'js' || format === 'mjs') {
                const source = await primary.text();
                if (/(?:from\s*|import\s*\(?)['"]\.\.?\//.test(source)) {
                    throw new Error('This JavaScript module uses relative imports. Open it by its served module URL below so its dependencies resolve.');
                }
                const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
                try { return await loadProceduralModule(url, options); } finally { URL.revokeObjectURL(url); }
            }
            const resolver = localFileResolver(files);
            const manager = new THREE.LoadingManager();
            manager.setURLModifier(resolver.resolve);
            const waiting = new Promise((resolve, reject) => {
                manager.onLoad = resolve;
                manager.onError = url => reject(new Error(`Could not load companion asset: ${url}`));
            });
            waiting.catch(() => {}); // parsing may reject before the manager settles
            // The synthetic item keeps the manager alive until parsing has
            // registered every image and buffer, including OBJ material maps.
            manager.itemStart('model-import');
            try {
                const path = primary.webkitRelativePath || primary.name;
                const base = new URL(path.slice(0, path.lastIndexOf('/') + 1), 'https://model.local/').href;
                const preview = await parse(await primary[binary(format) ? 'arrayBuffer' : 'text'](), format, { base, manager, files });
                manager.itemEnd('model-import');
                await waiting;
                return preview;
            } finally { resolver.dispose(); }
        },
        async url(value, options = {}) {
            const url = new URL(value, document.baseURI).href;
            const format = options.format || modelFormat(url);
            if (format === 'js' || format === 'mjs') return loadProceduralModule(url, options);
            const response = await fetch(url, { cache: 'no-store' });
            if (!response.ok) throw new Error(`Could not load model (${response.status}).`);
            const data = await response[binary(format) ? 'arrayBuffer' : 'text']();
            if (format === 'blend') return blend(data);
            const manager = new THREE.LoadingManager();
            const waiting = new Promise((resolve, reject) => {
                manager.onLoad = resolve;
                manager.onError = url => reject(new Error(`Could not load companion asset: ${url}`));
            });
            waiting.catch(() => {});
            manager.itemStart('model-import');
            const preview = await parse(data, format, { base: new URL('.', url).href, manager });
            manager.itemEnd('model-import');
            await waiting;
            return preview;
        },
        parse,
        dispose() { draco?.dispose(); ktx?.dispose(); },
    };
}
