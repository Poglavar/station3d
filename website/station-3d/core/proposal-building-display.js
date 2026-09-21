// How proposal BUILDINGS are shown in the walk/cab world — the display-state
// model, pure and DOM-free. Three states, the same vocabulary consensus-builder
// uses for its planned layer (three-building-display.js):
//
//   solid — local style: the building goes through the ordinary buildings
//           pipeline (facades, roofs, batching) and looks like the town around
//           it. The DEFAULT: massing shown as architecture, not as a diagram.
//   ghost — the glass prism: the massing diagram, useful for reading the plan
//           against the existing city.
//   off   — proposal building volumes hidden. Masking is NOT a display concern:
//           a proposed building still substitutes for the cadastre building on
//           its plot in every state, so `off` shows the cleared site.
//
// URL:      ?proposalsView=solid|ghost|off   (missing/junk → solid)
// Keyboard: N cycles solid → ghost → off → solid (wired in modes/cab.js).

export const PROPOSAL_BUILDING_DISPLAY_STATES = Object.freeze(['solid', 'ghost', 'off']);
export const DEFAULT_PROPOSAL_BUILDING_DISPLAY = 'solid';
export const PROPOSAL_BUILDING_DISPLAY_PARAM = 'proposalsView';

export function parseProposalBuildingDisplay(search = globalThis.location?.search || '') {
    const raw = new URLSearchParams(String(search ?? ''))
        .get(PROPOSAL_BUILDING_DISPLAY_PARAM);
    const value = (raw || '').trim().toLowerCase();
    return PROPOSAL_BUILDING_DISPLAY_STATES.includes(value)
        ? value
        : DEFAULT_PROPOSAL_BUILDING_DISPLAY;
}

export function nextProposalBuildingDisplay(state) {
    const index = PROPOSAL_BUILDING_DISPLAY_STATES.indexOf(state);
    return PROPOSAL_BUILDING_DISPLAY_STATES[
        (index + 1) % PROPOSAL_BUILDING_DISPLAY_STATES.length
    ];
}

// What each state shows. `models` are uploaded glTF buildings: they ARE the
// bespoke look, so they render in both solid and ghost and hide only in off.
export function proposalBuildingDisplayPolicy(state) {
    switch (state) {
        case 'ghost': return { solid: false, ghost: true, models: true };
        case 'off': return { solid: false, ghost: false, models: false };
        case 'solid':
        default: return { solid: true, ghost: false, models: true };
    }
}
