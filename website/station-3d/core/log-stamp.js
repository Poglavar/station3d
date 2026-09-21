// One timestamp prefix for the world-building console lines, so a pasted
// console shows the gaps between events, not only their order.
export function logStamp() {
    return `[${new Date().toISOString()}]`;
}
