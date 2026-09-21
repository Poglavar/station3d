export function readViewerLink(params, oldPage = '') {
    let model = params.get('model') || 'airplane-smuggler';
    let compare = params.get('compare') || '';
    if (oldPage.includes('people-viewer')) model = `crowd-${['faces', 'walking', 'waiting'].includes(params.get('view')) ? params.get('view') : 'faces'}`;
    if (oldPage.includes('airplane-cabin')) model = 'airplane-smuggler';
    if (oldPage.includes('rolling-stock')) {
        const view = params.get('view');
        model = view === 'person' ? 'person-male' : view === 'train' ? 'hz-7022' : 'tmk-2400-new';
        if (!view || view === 'both') compare = 'hz-7022';
    }
    return { model, compare, seed: params.get('seed') || 'city-people-1', camera: params.get('cam') || params.get('shot') || 'auto' };
}
