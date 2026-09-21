// Keeps a reusable child batch published under the currently visible parent.
// Streaming layers may swap their outer generation while retaining expensive
// cell roots; this invariant repairs any late retirement that detaches one.
export function ensurePersistentRenderRootAttached(parent, child) {
    if (!parent || !child || child.parent === parent) return false;
    parent.add(child);
    return true;
}
