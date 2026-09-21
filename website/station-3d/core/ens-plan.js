// Named-plan deeplinks: ?plan=<slug or ENS name> instead of enumerating
// ?proposals=701,708,… (a 299-proposal plan is a 1.4 KB URL that dies in every
// chat scroll). consensus-builder publishes a plan as
// <slug>.proposals.urbangametheory.eth and serves GET /plans/<slug> → its
// proposalIds; the API takes the BARE slug only, so the name is normalized
// here. Pure — parsing and merging are provable under node; the fetch lives
// with the consensus API base in world/proposals.js.

export const ENS_PLAN_PARAM = 'plan';

// 'sibenik-2066-1'                                    → 'sibenik-2066-1'
// 'sibenik-2066-1.proposals.urbangametheory.eth'      → 'sibenik-2066-1'
// A slug never contains dots (an ENS label cannot), so the first label IS the
// slug whatever domain the name hangs under. ENS names normalize lowercase.
export function ensPlanSlug(value) {
    const raw = String(value ?? '').trim().toLowerCase();
    if (!raw) return null;
    const slug = raw.split('.')[0].trim();
    return slug || null;
}

export function parseEnsPlanParam(search = globalThis.location?.search || '') {
    return ensPlanSlug(new URLSearchParams(String(search ?? '')).get(ENS_PLAN_PARAM));
}

// Explicit ?proposals= ids and the plan's ids, deduped, explicit first — so a
// link can say "the plan, plus these two extra proposals" and a proposal named
// both ways loads once.
export function mergeProposalIds(explicitIds, planIds) {
    const seen = new Set();
    const out = [];
    for (const list of [explicitIds, planIds]) {
        if (!Array.isArray(list)) continue;
        for (const id of list) {
            const key = String(id ?? '').trim();
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out.push(key);
        }
    }
    return out;
}
