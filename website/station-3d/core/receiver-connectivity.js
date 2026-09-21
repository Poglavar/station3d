// A renderer may split coincident vertices for normals/UVs. Preserve those
// buffers while carrying their proven geometric connectivity into footprint
// extraction. Indexed vertices join only through an existing zero-length
// source edge; unrelated coincident indexed surfaces remain separate.
export function* createReceiverSourceVertexIdsSteps({ geometry,
    now = () => performance.now(), isCurrent = () => true }) {
    const source = geometry.positions, sourceCount = source.length / 3, parents = new Map();
    let deadline = now() + .5;
    function* budget() {
        if (!isCurrent()) throw Object.assign(new Error('Receiver connectivity expired'), { code: 'ground-topology-stale' });
        if (now() >= deadline) { yield { phase: 'ground-topology-connectivity' }; deadline = now() + .5; }
    }
    function root(id) {
        let current = id;
        while (parents.has(current)) current = parents.get(current);
        while (parents.has(id)) { const next = parents.get(id); parents.set(id, current); id = next; }
        return current;
    }
    function join(a, b) { a = root(a); b = root(b); if (a !== b) parents.set(Math.max(a, b), Math.min(a, b)); }
    const same = (a, b) => source[a * 3] === source[b * 3]
        && source[a * 3 + 1] === source[b * 3 + 1] && source[a * 3 + 2] === source[b * 3 + 2];
    if (geometry.topologyVertexIds) {
        const ids = geometry.topologyVertexIds;
        if (!(ids instanceof Uint32Array) || ids.length !== sourceCount) throw new TypeError('Invalid source receiver connectivity');
        for (let i = 0; i < sourceCount; i++) {
            yield* budget();
            if (ids[i] >= sourceCount || !same(i, ids[i])) throw new TypeError('Receiver connectivity joins different positions');
            join(i, ids[i]);
        }
    }
    if (geometry.indices) {
        const ids = geometry.indices;
        for (let i = 0; i < ids.length; i += 3) {
            yield* budget();
            const a = ids[i], b = ids[i + 1], c = ids[i + 2];
            if (same(a, b)) join(a, b);
            if (same(b, c)) join(b, c);
            if (same(c, a)) join(c, a);
        }
    } else {
        // This matches the footprint compiler's existing nonindexed semantics.
        // Turning clipped triangles into an index must not lose those joins.
        const vertices = new Map();
        for (let i = 0; i < sourceCount; i++) {
            yield* budget();
            const key = `${source[i * 3]},${source[i * 3 + 1]},${source[i * 3 + 2]}`;
            if (vertices.has(key)) join(i, vertices.get(key)); else vertices.set(key, i);
        }
    }
    if (!parents.size) return null;
    const ids = new Uint32Array(sourceCount);
    for (let i = 0; i < ids.length; i++) { yield* budget(); ids[i] = root(i); }
    return ids;
}

export function* createReceiverTopologyVertexIdsSteps({ geometry, positions, boundaryVertices, sourceVertexIds,
    now = () => performance.now(), isCurrent = () => true }) {
    const source = geometry.positions, sourceCount = source.length / 3;
    const sourceIds = sourceVertexIds === undefined
        ? yield* createReceiverSourceVertexIdsSteps({ geometry, now, isCurrent }) : sourceVertexIds;
    if (!sourceIds && !boundaryVertices.size) return null;
    let deadline = now() + .5, joined = Boolean(sourceIds);
    function* budget() {
        if (!isCurrent()) throw Object.assign(new Error('Receiver connectivity expired'), { code: 'ground-topology-stale' });
        if (now() >= deadline) { yield { phase: 'ground-topology-connectivity' }; deadline = now() + .5; }
    }
    const root = i => sourceIds ? sourceIds[i] : i;
    const ids = new Uint32Array(positions.length / 3);
    for (let i = 0; i < ids.length; i++) { yield* budget(); ids[i] = i < sourceCount ? root(i) : i; }
    const boundaries = new Map();
    for (const { index, sourceIds } of boundaryVertices.values()) {
        yield* budget();
        const edge = [...new Set(sourceIds.map(root))].sort((a, b) => a - b).join(':');
        const key = `${edge}|${positions[index * 3]},${positions[index * 3 + 1]},${positions[index * 3 + 2]}`;
        const endpoint = sourceIds.find(i => [0, 1, 2].every(k => source[i * 3 + k] === positions[index * 3 + k]));
        if (endpoint !== undefined) { ids[index] = root(endpoint); joined = true; }
        else if (boundaries.has(key)) { ids[index] = boundaries.get(key); joined = true; }
        else boundaries.set(key, index);
    }
    return joined ? ids : null;
}
