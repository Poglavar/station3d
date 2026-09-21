// Appends large array-like geometry buffers without spreading them into a
// function call, which exceeds browser argument limits on dense tiles.

export function appendArrayValues(target, source) {
    if (!Array.isArray(target)) throw new TypeError('append target must be an Array');
    if (source == null) return target;
    const length = Number(source.length);
    if (!Number.isSafeInteger(length) || length < 0) {
        throw new TypeError('append source must be array-like');
    }
    const offset = target.length;
    target.length = offset + length;
    for (let index = 0; index < length; index++) {
        target[offset + index] = source[index];
    }
    return target;
}
