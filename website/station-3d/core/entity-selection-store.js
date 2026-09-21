// Pure cross-pane selection state with owner-aware transient hover handling.

import { isEntityKey } from './entity-key.js';

function validKeyOrNull(key) {
    if (key == null || key === '') return null;
    return isEntityKey(key) ? key : null;
}

export function createEntitySelectionStore() {
    let hoveredKey = null;
    let hoverOwner = null;
    let selectedKey = null;
    const metadata = new Map();
    const listeners = new Set();

    function snapshot() {
        return {
            hoveredKey,
            hoverOwner,
            selectedKey,
            metadata,
            hoveredMetadata: hoveredKey ? metadata.get(hoveredKey) || null : null,
            selectedMetadata: selectedKey ? metadata.get(selectedKey) || null : null,
        };
    }

    function emit(previous) {
        const next = snapshot();
        if (previous.hoveredKey === next.hoveredKey
            && previous.hoverOwner === next.hoverOwner
            && previous.selectedKey === next.selectedKey) return next;
        for (const listener of listeners) listener(next, previous);
        return next;
    }

    function remember(key, value) {
        if (!key || !value || typeof value !== 'object') return;
        metadata.set(key, { ...(metadata.get(key) || {}), ...value, key });
    }

    return {
        getState: snapshot,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        rememberMetadata(key, value) {
            const validKey = validKeyOrNull(key);
            if (validKey) remember(validKey, value);
            return snapshot();
        },
        setHover(owner, key, value = null) {
            const previous = snapshot();
            const validKey = validKeyOrNull(key);
            if (!validKey) {
                if (owner !== hoverOwner) return previous;
                hoveredKey = null;
                hoverOwner = null;
                return emit(previous);
            }
            remember(validKey, value);
            hoveredKey = validKey;
            hoverOwner = owner || null;
            return emit(previous);
        },
        clearHover(owner) {
            if (owner != null && owner !== hoverOwner) return snapshot();
            return this.setHover(hoverOwner, null);
        },
        select(key, value = null) {
            const previous = snapshot();
            const validKey = validKeyOrNull(key);
            remember(validKey, value);
            selectedKey = validKey;
            return emit(previous);
        },
        clearSelection() {
            return this.select(null);
        },
    };
}
