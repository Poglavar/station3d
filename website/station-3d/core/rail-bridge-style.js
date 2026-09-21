// Regional visual specification for model-world railway bridge structures.

export function railBridgeStyleForLocation({ locationId, styleCityId } = {}) {
    const city = String(styleCityId || locationId || '').trim().toLowerCase();
    if (city === 'zagreb') {
        return {
            kind: 'steel-girder',
            deck: {
                color: 0x2f6847,
                roughness: 0.84,
                metalness: 0.22,
            },
            details: {
                color: 0x28583d,
                roughness: 0.88,
                metalness: 0.18,
            },
            fasteners: {
                color: 0x252c28,
                roughness: 0.72,
                metalness: 0.5,
            },
            piers: {
                color: 0xa7a49a,
                roughness: 0.93,
                metalness: 0,
            },
        };
    }
    return {
        kind: 'concrete',
        deck: {
            color: 0xa7a49a,
            roughness: 0.93,
            metalness: 0,
        },
        piers: {
            color: 0xa7a49a,
            roughness: 0.93,
            metalness: 0,
        },
    };
}
