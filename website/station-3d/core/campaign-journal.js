// Read-only knowledge derived from authored unlock conditions and saved progress.
import { evaluateCampaignCondition } from './campaign-conditions.js';
import { finiteOrNull, haversineMeters } from './math.js';

export function campaignJournalEntries(definition, run) {
    return (definition?.journal || []).filter(entry =>
        evaluateCampaignCondition(entry.when, { run }));
}

export function canPresentJournalItem(entry, scene, run, snapshot) {
    if (!entry?.itemId || entry.presentSceneId !== scene?.id) return false;
    if (!evaluateCampaignCondition(entry.when, { run })
        || !evaluateCampaignCondition(entry.presentWhen, { run })) return false;
    const speed = finiteOrNull(snapshot?.speedMps);
    const target = scene.authored?.actors?.find(actor => actor.actorId === entry.recipientId);
    const pose = snapshot?.pose;
    if (speed === null || Math.abs(speed) > 0.4 || !pose || !target) return false;
    return haversineMeters(pose.lat, pose.lon, target.lat, target.lon) <= 55;
}
