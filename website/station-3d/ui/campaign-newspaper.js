import { station3dAssetUrl } from '../core/asset-url.js';

// Thin DOM painter; timing and motion live in the pure cinematic sampler.
export function createCinematicNewspaper(localized) {
    const stage = document.createElement('div');
    stage.className = 'station-3d-campaign-newspapers';
    const page = document.createElement('article');
    page.className = 'station-3d-campaign-newspaper';
    page.setAttribute('aria-live', 'polite');
    page.setAttribute('aria-atomic', 'true');
    stage.appendChild(page);
    const text = (tag, name, parent = page) => {
        const node = document.createElement(tag);
        node.className = `station-3d-newspaper-${name}`;
        parent.appendChild(node);
        return node;
    };
    const masthead = text('header', 'masthead');
    const edition = text('div', 'edition');
    const headline = text('h2', 'headline');
    const deck = text('p', 'deck');
    const columns = text('div', 'columns');
    const picture = document.createElement('img');
    picture.className = 'station-3d-newspaper-picture';
    picture.decoding = 'async';
    columns.appendChild(picture);
    const story = text('div', 'story', columns);
    const summary = text('p', 'summary', story);
    const rules = text('div', 'rules', story);
    rules.setAttribute('aria-hidden', 'true');
    const folio = text('footer', 'folio');
    let lastPaper = null;
    return {
        element: stage,
        render(sample) {
            page.hidden = !sample;
            if (!sample) return;
            const { paper } = sample;
            if (paper !== lastPaper) {
                lastPaper = paper;
                page.dataset.style = paper.style || 'daily';
                masthead.textContent = paper.masthead;
                edition.textContent = localized(paper.edition);
                headline.textContent = localized(paper.headline);
                deck.textContent = localized(paper.deck);
                summary.textContent = localized(paper.summary);
                picture.hidden = !paper.imageSrc;
                if (paper.imageSrc) {
                    picture.src = station3dAssetUrl(paper.imageSrc.replace(/^station-3d\//, ''));
                    picture.alt = localized(paper.imageAlt);
                }
                folio.textContent = `${paper.masthead} · ${sample.index + 1} / ${sample.count}`;
            }
            page.dataset.phase = sample.phase;
            page.style.transform = `rotate(${sample.rotationDeg}deg) scale(${sample.scale})`;
            page.style.opacity = String(sample.opacity);
        },
    };
}
