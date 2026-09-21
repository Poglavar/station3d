// Picks which dialogue portrait an actor shows for a beat: a mood variant when the actor has one
// for the beat's mood, otherwise the base portrait. Pure so the choice is testable headlessly.

export function actorPortraitSource(actor, mood = null) {
    const portrait = actor?.portrait;
    if (!portrait || typeof portrait !== 'object') return actor?.portraitSource ?? null;
    const variant = mood ? portrait.moods?.[mood] : null;
    return variant ?? portrait.src ?? null;
}
