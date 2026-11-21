// The shared session query (station3d-links.js parseSessionQuery): mode, pose, rail profile, proposals and planned
// buildings read from a link, with absent or junk values left absent. The Sloboda explorer's own routes are tested
// in its repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { parseSessionQuery } = createRequire(import.meta.url)('../../station3d-links.js');

test('shared session query handles absent values without inventing sea-level coordinates', () => {
    const session = parseSessionQuery('?st3d=GTA&lat=45.8&lon=15.9&heading=2&pitch=-3&railProfile=SOLVED&proposals=a,b');
    assert.deepEqual(session, { mode: 'gta', lat: 45.8, lon: 15.9, headingDeg: 2, pitchDeg: -3,
        railProfileMode: 'solved', proposalIds: ['a', 'b'], plannedBuildings: false, campaignId: null, checkpointId: null });
    assert.equal(parseSessionQuery('?st3d=walk&lat=45.8&lon=15.9&future=1').plannedBuildings, true);
    assert.equal(parseSessionQuery('?future=0').plannedBuildings, false);
    for (const search of ['', '?lat=&lon=', '?lat=hello&lon=Infinity', '?lat=%20&lon=0x15']) {
        assert.equal(parseSessionQuery(search).lat, null);
        assert.equal(parseSessionQuery(search).lon, null);
    }
    assert.equal(parseSessionQuery('?lat=0&lon=0').lat, 0);
    // Only an explicit profile mode reaches the host; absent or junk leaves the default to it.
    assert.equal(parseSessionQuery('?railProfile=osm').railProfileMode, 'osm');
    assert.equal(parseSessionQuery('?railProfile=SOLVED').railProfileMode, 'solved');
    for (const search of ['', '?railProfile=', '?railProfile=maybe']) assert.equal(parseSessionQuery(search).railProfileMode, null, search);
});
