// The photo world's reveal as loading-screen steps. photoreal.js keeps the streamed
// world hidden until each of these holds, in this order, so the loading screen can
// name the current step and count the finished ones the way the model build does.

export const PHOTO_REVEAL_STEP_KEYS = Object.freeze([
    'photoTiles',     // 3D tiles renderer loaded and streaming
    'photoGround',    // route registered against the streamed ground and seated on it
    'photoCorridor',  // corridor clip mask rendered around the track
    'photoCivil',     // cuttings, trench and tunnel walls built on that ground
    'photoRefine',    // streamer quiet on refined tiles: the world is revealed
]);

// A step counts as finished only when every step before it has finished: the
// reveal is sequential, so a flag set early (a mask from a previous position)
// must not read as progress past a step still being waited on.
export function photoRevealSteps({
    streaming = false,
    grounded = false,
    carve = true,
    maskReady = false,
    wallsBuilt = false,
    revealed = false,
} = {}) {
    const reached = {
        photoTiles: streaming === true,
        photoGround: grounded === true,
        photoCorridor: carve !== true || maskReady === true,
        photoCivil: carve !== true || wallsBuilt === true,
        photoRefine: revealed === true,
    };
    let open = true;
    const steps = PHOTO_REVEAL_STEP_KEYS.map((key) => {
        const done = open && (reached[key] || revealed === true);
        if (!done) open = false;
        return { key, done };
    });
    const doneCount = steps.filter(step => step.done).length;
    return { steps, doneCount, total: steps.length, current: steps.find(step => !step.done)?.key ?? null };
}
