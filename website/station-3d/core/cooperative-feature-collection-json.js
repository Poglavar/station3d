// Incremental decoder for large GeoJSON FeatureCollections.
//
// JSON.parse is atomic. A detailed Zagreb building tile can therefore occupy
// the animation thread for well over a frame even though every later geometry
// stage is cooperative. Split only the top-level `features` array, parse its
// features in bounded batches, then parse the now-small collection envelope.
// Downstream code still receives the exact ordinary GeoJSON object shape.

const DEFAULT_SCAN_CHARACTERS_PER_STEP = 128 * 1024;
const DEFAULT_FEATURES_PER_STEP = 8;

const CHAR_QUOTE = 34;
const CHAR_BACKSLASH = 92;
const CHAR_OPEN_OBJECT = 123;
const CHAR_CLOSE_OBJECT = 125;
const CHAR_OPEN_ARRAY = 91;
const CHAR_CLOSE_ARRAY = 93;
const CHAR_COLON = 58;
const CHAR_COMMA = 44;

function isWhitespace(code) {
    return code === 32 || code === 9 || code === 10 || code === 13;
}

function syntaxError(message, cursor) {
    return new SyntaxError(`${message} at JSON offset ${cursor}`);
}

function safePositiveInteger(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

// The task deliberately has the same tiny interface as the other resumable
// Station3D jobs: one bounded step returns { done, result? }. The shared tile
// session owns scheduling and cancellation, so this module stays pure and is
// directly testable without a browser.
export function createFeatureCollectionJsonParseTask(serialized, {
    scanCharactersPerStep = DEFAULT_SCAN_CHARACTERS_PER_STEP,
    featuresPerStep = DEFAULT_FEATURES_PER_STEP,
} = {}) {
    if (typeof serialized !== 'string') {
        throw new TypeError('FeatureCollection JSON decoder requires a string');
    }

    const scanLimit = safePositiveInteger(
        scanCharactersPerStep,
        DEFAULT_SCAN_CHARACTERS_PER_STEP,
    );
    const featureLimit = safePositiveInteger(featuresPerStep, DEFAULT_FEATURES_PER_STEP);
    const containers = [];
    const features = [];
    let text = serialized;
    let cursor = 0;
    let phase = 'locate-features';
    let inString = false;
    let escaped = false;
    let candidateKeyStart = -1;
    let candidateKeyEnd = -1;
    let candidateAwaitingColon = false;
    let awaitingFeaturesValue = false;
    let featuresArrayStart = -1;
    let featuresArrayEnd = -1;
    let featureStart = -1;
    let arrayState = 'value-or-end';
    let done = false;
    let result;

    function pushContainer(code) {
        containers.push(code);
    }

    function popContainer(closeCode, offset) {
        const expected = closeCode === CHAR_CLOSE_OBJECT
            ? CHAR_OPEN_OBJECT
            : CHAR_OPEN_ARRAY;
        if (containers.at(-1) !== expected) {
            throw syntaxError('Mismatched JSON container', offset);
        }
        containers.pop();
    }

    function locateFeaturesArray() {
        let scanned = 0;
        while (cursor < text.length && scanned < scanLimit) {
            const offset = cursor;
            const code = text.charCodeAt(cursor);
            cursor += 1;
            scanned += 1;

            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (code === CHAR_BACKSLASH) {
                    escaped = true;
                } else if (code === CHAR_QUOTE) {
                    inString = false;
                    if (candidateKeyStart >= 0) {
                        candidateKeyEnd = offset;
                        candidateAwaitingColon = true;
                    }
                }
                continue;
            }

            if (awaitingFeaturesValue) {
                if (isWhitespace(code)) continue;
                if (code !== CHAR_OPEN_ARRAY) {
                    throw syntaxError('FeatureCollection features must be an array', offset);
                }
                pushContainer(code);
                featuresArrayStart = offset;
                phase = 'parse-features';
                return;
            }

            if (candidateAwaitingColon) {
                if (isWhitespace(code)) continue;
                if (code === CHAR_COLON) {
                    awaitingFeaturesValue = text.slice(
                        candidateKeyStart,
                        candidateKeyEnd + 1,
                    ) === '"features"';
                    candidateKeyStart = -1;
                    candidateKeyEnd = -1;
                    candidateAwaitingColon = false;
                    continue;
                }
                candidateKeyStart = -1;
                candidateKeyEnd = -1;
                candidateAwaitingColon = false;
            }

            if (code === CHAR_QUOTE) {
                inString = true;
                escaped = false;
                candidateKeyStart = containers.length === 1
                    && containers[0] === CHAR_OPEN_OBJECT
                    ? offset
                    : -1;
            } else if (code === CHAR_OPEN_OBJECT || code === CHAR_OPEN_ARRAY) {
                pushContainer(code);
            } else if (code === CHAR_CLOSE_OBJECT || code === CHAR_CLOSE_ARRAY) {
                popContainer(code, offset);
            }
        }
        if (cursor >= text.length) {
            throw syntaxError('FeatureCollection has no top-level features array', cursor);
        }
    }

    function finishFeaturesArray(offset) {
        popContainer(CHAR_CLOSE_ARRAY, offset);
        featuresArrayEnd = offset;
        phase = 'parse-envelope';
    }

    function parseFeatures() {
        let scanned = 0;
        let parsedFeatures = 0;
        while (cursor < text.length
            && scanned < scanLimit
            && parsedFeatures < featureLimit) {
            const offset = cursor;
            const code = text.charCodeAt(cursor);
            cursor += 1;
            scanned += 1;

            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (code === CHAR_BACKSLASH) {
                    escaped = true;
                } else if (code === CHAR_QUOTE) {
                    inString = false;
                }
                continue;
            }

            // Between top-level feature values, validate the separators here.
            // Replacing the array with [] later validates the collection
            // envelope, but cannot detect an omitted/trailing feature comma.
            if (featureStart < 0 && containers.length === 2) {
                if (isWhitespace(code)) continue;
                if (arrayState === 'comma-or-end') {
                    if (code === CHAR_COMMA) {
                        arrayState = 'value';
                        continue;
                    }
                    if (code === CHAR_CLOSE_ARRAY) {
                        finishFeaturesArray(offset);
                        return;
                    }
                    throw syntaxError('Expected comma or end of features array', offset);
                }
                if (code === CHAR_CLOSE_ARRAY) {
                    if (arrayState === 'value') {
                        throw syntaxError('Trailing comma in features array', offset);
                    }
                    finishFeaturesArray(offset);
                    return;
                }
                if (code !== CHAR_OPEN_OBJECT) {
                    throw syntaxError('FeatureCollection entries must be objects', offset);
                }
                featureStart = offset;
                pushContainer(code);
                continue;
            }

            if (code === CHAR_QUOTE) {
                inString = true;
                escaped = false;
            } else if (code === CHAR_OPEN_OBJECT || code === CHAR_OPEN_ARRAY) {
                pushContainer(code);
            } else if (code === CHAR_CLOSE_OBJECT || code === CHAR_CLOSE_ARRAY) {
                popContainer(code, offset);
                if (featureStart >= 0 && containers.length === 2) {
                    if (code !== CHAR_CLOSE_OBJECT) {
                        throw syntaxError('FeatureCollection entry is not an object', offset);
                    }
                    const feature = JSON.parse(text.slice(featureStart, offset + 1));
                    if (!feature || typeof feature !== 'object' || Array.isArray(feature)) {
                        throw syntaxError('FeatureCollection entry is not an object', featureStart);
                    }
                    features.push(feature);
                    featureStart = -1;
                    arrayState = 'comma-or-end';
                    parsedFeatures += 1;
                }
            }
        }
        if (cursor >= text.length) {
            throw syntaxError('Unterminated features array', cursor);
        }
    }

    function parseEnvelope() {
        // Preserve top-level bbox/metadata while removing the expensive array.
        // Parsing this small envelope also validates all punctuation outside the
        // feature list instead of approximating JSON grammar in the scanner.
        const envelopeText = text.slice(0, featuresArrayStart + 1)
            + text.slice(featuresArrayEnd);
        const envelope = JSON.parse(envelopeText);
        if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
            throw new SyntaxError('FeatureCollection JSON must contain an object');
        }
        if (!Array.isArray(envelope.features)) {
            throw new SyntaxError('FeatureCollection features must be an array');
        }
        envelope.features = features;
        result = envelope;
        done = true;
        // Let the often multi-megabyte source string go as soon as the decoded
        // object is published; the task may remain referenced by its promise.
        text = '';
    }

    function step() {
        if (done) return { done: true, result, phase: 'done' };
        const currentPhase = phase;
        if (phase === 'locate-features') locateFeaturesArray();
        else if (phase === 'parse-features') parseFeatures();
        else if (phase === 'parse-envelope') parseEnvelope();
        return {
            done,
            ...(done ? { result } : {}),
            phase: currentPhase,
            cursor,
            featureCount: features.length,
        };
    }

    return { step };
}
