// Deterministic shelf packing for the streamed-building facade atlas.
//
// This module deliberately owns data only. Canvas/Texture creation stays in
// world/buildings.js, while tests can prove allocation and UV localization in
// Node without Three.js or a DOM.

function positiveInteger(value, fallback) {
    const numeric = Math.floor(Number(value));
    return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

export function createFacadeAtlasLayout({
    pageSize = 1024,
    padding = 2,
    maxEntrySize = 256,
} = {}) {
    const size = positiveInteger(pageSize, 1024);
    const gutter = Math.max(0, Math.floor(Number(padding) || 0));
    const maxInner = Math.min(
        size - gutter * 2,
        positiveInteger(maxEntrySize, 256),
    );
    if (maxInner <= 0) throw new Error('facade-atlas: padding leaves no drawable page area');

    const allocations = new Map();
    const pages = [];
    let activePages = 0;
    let contentTexels = 0;
    let reservedTexels = 0;
    let sourceTexels = 0;
    let shelfTexels = 0;

    function occupancy(page) {
        if (!page) return null;
        const capacityTexels = size * size;
        return {
            entries: page.keys.size,
            capacityTexels,
            allocatedContentTexels: page.contentTexels,
            reservedTexels: page.reservedTexels,
            sourceTexels: page.sourceTexels,
            gutterTexels: page.reservedTexels - page.contentTexels,
            unallocatedTexels: capacityTexels - page.reservedTexels,
            shelfWasteTexels: page.shelfTexels - page.reservedTexels,
            contentFillRatio: page.contentTexels / capacityTexels,
            reservedFillRatio: page.reservedTexels / capacityTexels,
        };
    }

    function scaledDimensions(sourceWidth, sourceHeight) {
        const width = positiveInteger(sourceWidth, 1);
        const height = positiveInteger(sourceHeight, 1);
        const scale = Math.min(1, maxInner / width, maxInner / height);
        return {
            width: Math.max(1, Math.round(width * scale)),
            height: Math.max(1, Math.round(height * scale)),
        };
    }

    function placeOnPage(page, outerWidth, outerHeight) {
        for (const shelf of page.shelves) {
            if (outerHeight > shelf.height || shelf.cursorX + outerWidth > size) continue;
            const x = shelf.cursorX;
            shelf.cursorX += outerWidth;
            page.shelfTexels += outerWidth * shelf.height;
            return { x, y: shelf.y, shelfTexels: outerWidth * shelf.height };
        }
        if (page.cursorY + outerHeight > size) return null;
        const shelf = {
            y: page.cursorY,
            height: outerHeight,
            cursorX: outerWidth,
        };
        page.shelves.push(shelf);
        page.cursorY += outerHeight;
        page.shelfTexels += outerWidth * outerHeight;
        return { x: 0, y: shelf.y, shelfTexels: outerWidth * shelf.height };
    }

    function allocate(key, sourceWidth, sourceHeight) {
        const stableKey = String(key);
        const existing = allocations.get(stableKey);
        if (existing) return existing;

        const inner = scaledDimensions(sourceWidth, sourceHeight);
        const outerWidth = inner.width + gutter * 2;
        const outerHeight = inner.height + gutter * 2;
        let pageIndex = -1;
        let placed = null;
        for (let index = 0; index < pages.length; index++) {
            if (!pages[index]) continue;
            placed = placeOnPage(pages[index], outerWidth, outerHeight);
            if (placed) {
                pageIndex = index;
                break;
            }
        }
        if (!placed) {
            const page = {
                cursorY: 0, shelves: [], keys: new Set(),
                contentTexels: 0, reservedTexels: 0, sourceTexels: 0, shelfTexels: 0,
            };
            // Retired page numbers may be reused, but never move an allocation
            // on a live page: its UVs may still belong to a retiring mesh.
            pageIndex = pages.findIndex(entry => entry === null);
            if (pageIndex < 0) pageIndex = pages.length;
            pages[pageIndex] = page;
            activePages++;
            placed = placeOnPage(page, outerWidth, outerHeight);
        }
        if (!placed) throw new Error('facade-atlas: entry cannot fit an empty page');

        const allocation = Object.freeze({
            key: stableKey,
            pageIndex,
            pageSize: size,
            padding: gutter,
            sourceWidth: positiveInteger(sourceWidth, 1),
            sourceHeight: positiveInteger(sourceHeight, 1),
            x: placed.x + gutter,
            y: placed.y + gutter,
            width: inner.width,
            height: inner.height,
        });
        allocations.set(stableKey, allocation);
        const page = pages[pageIndex];
        page.keys.add(stableKey);
        page.contentTexels += inner.width * inner.height;
        page.reservedTexels += outerWidth * outerHeight;
        page.sourceTexels += allocation.sourceWidth * allocation.sourceHeight;
        contentTexels += inner.width * inner.height;
        reservedTexels += outerWidth * outerHeight;
        sourceTexels += allocation.sourceWidth * allocation.sourceHeight;
        // placeOnPage already advanced this page's shelf cursor. Account the
        // exact shelf rectangle added by the selected row, not just its entry.
        shelfTexels += placed.shelfTexels;
        return allocation;
    }

    return {
        allocate,
        // The resource owner must first prove that no staged part, upload or
        // live/retiring mesh still references this page. Releasing individual
        // rectangles without that proof would overwrite still-visible pixels.
        releasePage(pageIndex) {
            if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) throw new RangeError('Invalid atlas page');
            const page = pages[pageIndex];
            if (!page) return 0;
            for (const key of page.keys) allocations.delete(key);
            contentTexels -= page.contentTexels;
            reservedTexels -= page.reservedTexels;
            sourceTexels -= page.sourceTexels;
            shelfTexels -= page.shelfTexels;
            pages[pageIndex] = null;
            activePages--;
            return page.keys.size;
        },
        get(key) {
            return allocations.get(String(key)) || null;
        },
        pageStats(pageIndex) {
            const page = pages[pageIndex];
            return page ? { pageIndex, ...occupancy(page) } : null;
        },
        stats({ includePages = false } = {}) {
            const capacityTexels = activePages * size * size;
            return {
                pageSize: size,
                padding: gutter,
                maxEntrySize: maxInner,
                pages: activePages,
                pageSlots: pages.length,
                entries: allocations.size,
                capacityTexels,
                allocatedContentTexels: contentTexels,
                reservedTexels,
                sourceTexels,
                gutterTexels: reservedTexels - contentTexels,
                unallocatedTexels: capacityTexels - reservedTexels,
                shelfWasteTexels: shelfTexels - reservedTexels,
                contentFillRatio: capacityTexels > 0 ? contentTexels / capacityTexels : 0,
                reservedFillRatio: capacityTexels > 0 ? reservedTexels / capacityTexels : 0,
                ...(includePages ? { pageDetails: pages.flatMap((page, pageIndex) => (
                    page ? [{ pageIndex, ...occupancy(page) }] : []
                )) } : {}),
            };
        },
    };
}

// CanvasTexture has flipY=true: source UV v=0 samples the bottom of its
// canvas. Atlas canvas rows grow downward, so V must be localized from the
// allocation's bottom edge toward its top edge.
export function remapFacadeAtlasUvs(sourceUvs, allocation) {
    if (!sourceUvs || sourceUvs.length % 2 !== 0) {
        throw new Error('facade-atlas: UV input must contain complete pairs');
    }
    const size = Number(allocation?.pageSize);
    if (!(size > 0)) throw new Error('facade-atlas: allocation has no page size');
    const out = new Float32Array(sourceUvs.length);
    const u0 = allocation.x / size;
    const v0 = 1 - (allocation.y + allocation.height) / size;
    const uScale = allocation.width / size;
    const vScale = allocation.height / size;
    for (let offset = 0; offset < sourceUvs.length; offset += 2) {
        out[offset] = u0 + Number(sourceUvs[offset]) * uScale;
        out[offset + 1] = v0 + Number(sourceUvs[offset + 1]) * vScale;
    }
    return out;
}
