// Parses the ?time= URL override that pins the sky's local hour. Season (sun
// declination, sunrise/sunset) stays real; only the clock is fixed, so a
// shared "look at this at sunset" link renders the same light for everyone.
// Accepts ?time=14, ?time=14.5, ?time=14:30; anything else means no override.
export function parseTimeOfDayOverride(search) {
    const raw = new URLSearchParams(String(search ?? '')).get('time');
    if (raw == null || raw === '') return null;
    const match = String(raw).trim().match(/^(\d{1,2})(?::([0-5]?\d))?$|^(\d{1,2}(?:\.\d+)?)$/);
    if (!match) return null;
    const hour = match[3] != null
        ? Number(match[3])
        : Number(match[1]) + Number(match[2] || 0) / 60;
    return hour >= 0 && hour < 24 ? hour : null;
}
