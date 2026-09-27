// Reads npm pack's JSON report even when lifecycle scripts prefix it with logs.
export function parseNpmPackReport(output) {
    // npm can run prepare despite --ignore-scripts; skip lifecycle stdout.
    // Require an array of objects (or an empty array), not a [log] prefix.
    const jsonStart = output.search(/^[ \t]*\[(?=\s*(?:\{|\]))/m);
    if (jsonStart < 0) throw new Error(`npm pack produced no JSON:\n${output}`);
    const [report] = JSON.parse(output.slice(jsonStart));
    if (!report) throw new Error(`npm pack produced no package report:\n${output}`);
    return report;
}
