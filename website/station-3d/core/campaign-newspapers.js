// A newspaper montage uses the cinematic clock, including its pause/skip
// lifetime. During the reading hold every transform is exactly stationary.
export const NEWSPAPER_SPIN_MS = 1100;
export const NEWSPAPER_EXIT_MS = 350;

export function sampleCinematicNewspaper(track, elapsedMs, { reducedMotion = false } = {}) {
    const papers = track?.newspapers || [];
    const time = Number(elapsedMs);
    if (!Number.isFinite(time) || time < 0 || time >= Number(track?.durationMs)) return null;
    const index = papers.findIndex(paper => time >= paper.startMs && time < paper.endMs);
    if (index < 0) return null;
    const paper = papers[index];
    const localMs = time - paper.startMs;
    const remainingMs = paper.endMs - time;
    const enter = Math.min(1, localMs / NEWSPAPER_SPIN_MS);
    const exit = Math.min(1, remainingMs / NEWSPAPER_EXIT_MS);
    const settle = 1 - (1 - enter) ** 3;
    return {
        paper,
        index,
        count: papers.length,
        phase: enter < 1 ? 'enter' : exit < 1 ? 'exit' : 'hold',
        rotationDeg: reducedMotion ? 0 : (index % 2 ? 1 : -1) * 720 * (1 - settle),
        scale: reducedMotion ? 1 : 0.12 + 0.88 * settle,
        opacity: reducedMotion ? 1 : Math.min(1, enter * 4, exit),
    };
}
