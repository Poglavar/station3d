// Pure junction choice for a campaign pursuer. Ordinary traffic picks its exit
// at random, which is what made the Zagreb chase a chase in name only: the
// encounter spawned four armed cars into the traffic flow, they wandered off
// down their own routes and were retired, and the player walked the whole
// authored escape route unmolested. A pursuer takes the exit that closes on the
// target instead, so it uses the same road graph and the same steering as every
// other car — it just stops choosing arbitrarily.

// Steering alone does not keep a chase alive. Ordinary traffic is culled when it
// reaches a dead end, when it has been held at a standstill too long, or when it
// falls far behind — and a pursuer driving hard at the player meets all three
// more often than a wandering car does. Left to that, the wave quietly dissolved
// and the street was empty again. An authored encounter therefore tops itself
// back up to its authored strength while it is running.
//
// Returns how many replacements to spawn now: nothing while the wave is at
// strength, nothing until `intervalS` has passed (so losses read as a chase
// regrouping rather than cars blinking into existence), and never more than
// `maxPerWave` at once.
export function pursuitTopUp({
    desired,
    live,
    nowS,
    lastSpawnS = null,
    intervalS = 6,
    maxPerWave = 2,
} = {}) {
    const want = Math.max(0, Math.trunc(Number(desired) || 0));
    const have = Math.max(0, Math.trunc(Number(live) || 0));
    const now = Number(nowS);
    if (!want || !Number.isFinite(now)) return 0;
    const shortfall = want - have;
    if (shortfall <= 0) return 0;
    const last = Number(lastSpawnS);
    if (Number.isFinite(last) && now - last < Math.max(0, Number(intervalS) || 0)) return 0;
    return Math.min(shortfall, Math.max(1, Math.trunc(Number(maxPerWave) || 1)));
}

// Exits are the junction's outgoing options, each carrying the world position of
// the far end of that segment. Returns the entry that gets nearest the target,
// or null when there is nothing to choose from.
//
// `spread` keeps a wave from collapsing into a single-file queue: an exit within
// `spread` metres of the best one is treated as equally good and picked between
// at random, so four pursuers approaching the same junction fan out across the
// streets that all lead to the player rather than nose-to-tail down one.
export function choosePursuitExit(exits, target, { random = Math.random, spread = 0 } = {}) {
    if (!Array.isArray(exits) || exits.length === 0) return null;
    const tx = Number(target?.x);
    const tz = Number(target?.z);
    if (!Number.isFinite(tx) || !Number.isFinite(tz)) return null;
    const scored = [];
    for (const exit of exits) {
        const x = Number(exit?.x);
        const z = Number(exit?.z);
        if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
        scored.push({ exit, distance: Math.hypot(x - tx, z - tz) });
    }
    if (scored.length === 0) return null;
    let best = scored[0];
    for (const entry of scored) if (entry.distance < best.distance) best = entry;
    const tolerance = Math.max(0, Number(spread) || 0);
    if (tolerance === 0) return best.exit;
    const equals = scored.filter(entry => entry.distance <= best.distance + tolerance);
    return equals[Math.min(equals.length - 1, Math.floor(random() * equals.length))].exit;
}
