// Clipping a face can introduce points on a retained source edge even when
// the neighbouring face is unchanged. Index those points once for the whole
// receiver so every incident triangle uses the same edge subdivision.
export function* createReceiverEdgeSplitReadSteps({ geometry, boundaryVertices, sourceVertexIds,
    positions, now = () => performance.now(), isCurrent = () => true }) {
    const source = geometry.positions, sourceCount = source.length / 3;
    const canonical = id => sourceVertexIds ? sourceVertexIds[id] : id;
    const provenance = new Map(), edges = new Map();
    let deadline = now() + .5;
    function* budget() {
        if (!isCurrent()) throw Object.assign(new Error('Receiver edge preparation expired'), { code: 'ground-topology-stale' });
        if (now() >= deadline) { yield { phase: 'ground-topology-edge-conformity' }; deadline = now() + .5; }
    }
    const keyOf = ids => `${ids[0]}:${ids[1]}`;
    const geometricIds = ids => [...new Set(ids.map(canonical))].sort((a, b) => a - b);
    for (const { index, sourceIds } of boundaryVertices.values()) {
        yield* budget();
        const ids = geometricIds(sourceIds);
        provenance.set(index, ids);
        if (ids.length !== 2) continue;
        const key = keyOf(ids);
        let edge = edges.get(key);
        if (!edge) {
            const delta = [0, 1, 2].map(k => source[ids[1] * 3 + k] - source[ids[0] * 3 + k]);
            const axis = delta.reduce((best, value, i) => Math.abs(value) > Math.abs(delta[best]) ? i : best, 0);
            if (!delta[axis]) continue;
            edge = { ids, axis, start: source[ids[0] * 3 + axis], delta: delta[axis], points: [], seen: new Set() };
            edges.set(key, edge);
        }
        const values = positions(), t = (values[index * 3 + edge.axis] - edge.start) / edge.delta;
        const pointKey = `${values[index * 3]},${values[index * 3 + 1]},${values[index * 3 + 2]}`;
        if (t > 0 && t < 1 && !edge.seen.has(pointKey)) {
            edge.seen.add(pointKey); edge.points.push({ index, t });
        }
    }
    // Cooperative stable merge sort: even a heavily cut edge cannot monopolise
    // one queue item. The table is bounded by the receiver vertex capacity.
    for (const [key, edge] of edges) {
        yield* budget();
        if (!edge.points.length) { edges.delete(key); continue; }
        let from = edge.points, to = new Array(from.length);
        for (let width = 1; width < from.length; width *= 2) {
            for (let start = 0; start < from.length; start += width * 2) {
                const middle = Math.min(start + width, from.length), end = Math.min(start + width * 2, from.length);
                let left = start, right = middle;
                for (let at = start; at < end; at++) {
                    yield* budget();
                    to[at] = left < middle && (right >= end || from[left].t <= from[right].t) ? from[left++] : from[right++];
                }
            }
            [from, to] = [to, from];
        }
        for (let i = 1; i < from.length; i++) {
            yield* budget();
            if (from[i].t === from[i - 1].t) throw Object.assign(new Error('Receiver faces disagree on a shared edge point'),
                { code: 'ground-topology-seam' });
        }
        edge.points = from; delete edge.seen;
    }
    if (!edges.size) return null;
    function lowerBound(points, t, inclusive) {
        let low = 0, high = points.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (points[middle].t < t || inclusive && points[middle].t === t) low = middle + 1;
            else high = middle;
        }
        return low;
    }
    return {
        canonical,
        registerVertex(index, ids) { provenance.set(index, geometricIds(ids)); },
        split(a, b) {
            const ids = [...new Set([...(a < sourceCount ? [canonical(a)] : provenance.get(a)),
                ...(b < sourceCount ? [canonical(b)] : provenance.get(b))])].sort((a, b) => a - b);
            if (ids.length !== 2) return null;
            const edge = edges.get(keyOf(ids)); if (!edge) return null;
            const values = positions();
            const ta = (values[a * 3 + edge.axis] - edge.start) / edge.delta;
            const tb = (values[b * 3 + edge.axis] - edge.start) / edge.delta;
            const from = lowerBound(edge.points, Math.min(ta, tb), true);
            const to = lowerBound(edge.points, Math.max(ta, tb), false);
            return from < to ? { edge, from, to, forward: ta < tb } : null;
        },
    };
}
