// Reference-counted entity registry that keeps highlighting independent of render materials.

import { isEntityKey } from './entity-key.js';

function visualStateFor(key, state) {
    if (state.selectedKey === key) return 'selected';
    if (state.hoveredKey === key) return 'hovered';
    return null;
}

export class EntityRegistry {
    constructor({ applyVisualState = () => {} } = {}) {
        this.applyVisualState = applyVisualState;
        this.entries = new Map();
        this.byObject = new Map();
        this.state = { hoveredKey: null, selectedKey: null };
    }

    register(key, object, metadata = null) {
        if (!isEntityKey(key) || !object) return () => {};
        let objects = this.entries.get(key);
        if (!objects) {
            objects = new Map();
            this.entries.set(key, objects);
        }
        let record = objects.get(object);
        if (record) {
            record.refs += 1;
            if (metadata) record.metadata = { ...record.metadata, ...metadata, key };
        } else {
            record = {
                key,
                object,
                metadata: { ...(metadata || {}), key },
                refs: 1,
                visualState: null,
            };
            objects.set(object, record);
            this.byObject.set(object, record);
            this.#apply(record);
        }

        let active = true;
        return () => {
            if (!active) return;
            active = false;
            record.refs -= 1;
            if (record.refs > 0) return;
            this.applyVisualState(record.object, null, record.visualState);
            objects.delete(object);
            this.byObject.delete(object);
            if (objects.size === 0) this.entries.delete(key);
        };
    }

    #apply(record) {
        const next = visualStateFor(record.key, this.state);
        if (next === record.visualState) return;
        this.applyVisualState(record.object, next, record.visualState);
        record.visualState = next;
    }

    setInteractionState({ hoveredKey = null, selectedKey = null } = {}) {
        const next = {
            hoveredKey: isEntityKey(hoveredKey) ? hoveredKey : null,
            selectedKey: isEntityKey(selectedKey) ? selectedKey : null,
        };
        if (next.hoveredKey === this.state.hoveredKey
            && next.selectedKey === this.state.selectedKey) return;
        const changedKeys = new Set([
            this.state.hoveredKey,
            this.state.selectedKey,
            next.hoveredKey,
            next.selectedKey,
        ]);
        this.state = next;
        for (const key of changedKeys) {
            for (const record of this.entries.get(key)?.values() || []) this.#apply(record);
        }
    }

    resolveObject(object) {
        let current = object;
        while (current) {
            const record = this.byObject.get(current);
            if (record) return record;
            current = current.parent || null;
        }
        return null;
    }

    getPickObjects() {
        return [...this.byObject.keys()];
    }

    has(key) {
        return (this.entries.get(key)?.size || 0) > 0;
    }

    clear() {
        for (const objects of this.entries.values()) {
            for (const record of objects.values()) {
                this.applyVisualState(record.object, null, record.visualState);
            }
        }
        this.entries.clear();
        this.byObject.clear();
    }

    snapshot() {
        return {
            entityCount: this.entries.size,
            objectCount: this.byObject.size,
            hoveredKey: this.state.hoveredKey,
            selectedKey: this.state.selectedKey,
        };
    }
}
