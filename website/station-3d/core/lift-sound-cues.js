// Pure mapping for the lift's small sound vocabulary.
export function liftSoundCue(phase) {
    if (phase === 'opening' || phase === 'closing') return 'door-slide';
    if (phase === 'arrival-opening') return 'arrival-chime';
    return null;
}
