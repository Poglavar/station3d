// Describe material ownership on an existing physical hit. Paint has no extra
// geometry/support, and missing page coverage must remain visible to the audit.
import { reviseSurfaceClaim } from './surface-hierarchy.js';
import { groundPaintReceiverAcceptsPaint } from './ground-paint-receiver-claim.js';

export function groundPaintAuditHits(hit, { receiver, normalY, visible, expected } = {}) {
    const eligible = record => record && normalY > .01 && receiver
        && ['key', 'verticalBand', 'coverageRevision'].every(key => record.receiver[key] === receiver[key])
        && groundPaintReceiverAcceptsPaint(receiver, hit.claim, record);
    const paintHit = record => ({ ...hit, claim: record.claim, ownerKey: record.key,
        paintKey: record.key, objectName: `${hit.objectName}:paint`,
        physicalReceiver: { key: receiver.key, publicationKey: hit.publicationKey, claim: hit.claim },
    });
    // There is only one colour-producing physical draw. Keep the receiver as
    // a non-colour support observation so the audit cannot mistake painting
    // for a second coplanar mesh or lose its actual support coverage.
    const support = () => ({ ...hit, claim: reviseSurfaceClaim(hit.claim, { paintsColor: false }),
        colorWrite: false, stencil: null });
    return {
        hits: eligible(visible) ? [support(), paintHit(visible)] : [hit],
        expectedHits: eligible(expected) ? [support(), paintHit(expected)] : [hit],
    };
}
