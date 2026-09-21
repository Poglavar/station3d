import { readViewerLink } from './model-viewer-links.js';

const params = new URLSearchParams(location.search);
const state = readViewerLink(params, location.pathname);
const target = new URL('../../model-viewer.html', import.meta.url);
target.search = params;
target.searchParams.set('model', state.model);
if (state.compare) target.searchParams.set('compare', state.compare);
target.searchParams.set('cam', state.camera);
target.hash = location.hash;
location.replace(target.href);
