import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { RailFormationModel } from '../core/rail-formation.js';
import { ownReadSnapshot } from '../core/read-snapshot-lifetime.js';
import { detectAtGradeLevelCrossingsSteps } from '../world/level-crossing-detect.js';
import { flagRailFormationBoundarySegmentsForRetainedRoadInterfacesSteps,
    flagRailFormationBoundarySegmentsForRoadOpeningsSteps, noteRailCivilGroundMutation,
    railCivilGroundDependencySnapshotSteps } from '../core/rail-road-grade-separation.js';

const source = readFileSync(new URL('../world/rails.js', import.meta.url), 'utf8');
const drain = steps => { let next; do { next = steps.next(); } while (!next.done); return next.value; };
function fixture({ crossing = true } = {}) {
    let owners = 0;
    const lease = () => {
        owners++; let active = true;
        return { retain: lease, release() { if (!active) return false; active = false; owners--; return true; } };
    };
    const inputs = lease();
    const model = new RailFormationModel({ anchorLat: 0, anchorLon: 0, baseSceneYAtLocal: () => 2,
        readInputs: inputs, features: [{ properties: { source: 'cb-proposal', proposalId: 'crossing' },
            geometry: { type: 'LineString', coordinates: [[0, 0], [.001, 0]] } }] });
    inputs.release();
    const profile = model.profiles[0], flagIndex = profile.internalSegments.findIndex(value => !value);
    assert.ok(flagIndex >= 0);
    const a = profile.points[flagIndex], b = profile.points[(flagIndex + 1) % profile.points.length];
    const crossings = new Map(crossing ? [['crossing', { x: (a.innerX + b.innerX) / 2,
        z: (a.innerZ + b.innerZ) / 2, halfWidthM: 3 }]] : []);
    const parent = {}, road = { revision: 1, nearbyCenterlineSegments: () => [], getSurfaceProfiles: () => [] };
    const r = vm.createContext({ Map, performance, lastRailFormation: model, lastRoadFormation: road,
        lastRoadVerticalAlignments: null, lastFeatures: [], railFormationRevision: model.revision,
        group: parent, publishedRailBoundaryInputs: null, pendingRailBoundaryInputs: null,
        pendingRailBoundarySinceMs: 0, pendingCrossingFormationRefresh: null,
        levelCrossingAccum: crossings, levelCrossingAccumRevision: crossings.size,
        roadUnderRailOpeningAccum: new Map(), LEVEL_CROSSING_WALL_CLEAR_M: 4.5,
        RAIL_CIVIL_GROUND_SNAPSHOT_PADDING_M: 12,
        detectAtGradeLevelCrossingsSteps, flagRailFormationBoundarySegmentsForRetainedRoadInterfacesSteps,
        flagRailFormationBoundarySegmentsForRoadOpeningsSteps, noteRailCivilGroundMutation,
        railCivilGroundDependencySnapshotSteps, ownReadSnapshot, roadUnderRailFormationOpenings: () => [],
        captureRailVisualGroundSteps: function* () {
            return ownReadSnapshot({ terrain: { evidenceSceneYAtLocal: () => 2 },
                railFormation: model, roadFormation: road, verticalAlignments: null,
                isCurrent: () => r.lastRoadFormation === road && road.revision === 1 }, [lease()]);
        },
        prepareRailFormationPublication(next, features, options) {
            assert.equal(options.owner, r.pendingCrossingFormationRefresh);
            return { model: next, entry: { isCurrent: () => r.lastRailFormation === model }, discard: () => next.dispose() };
        },
    });
    vm.runInContext(source.slice(source.indexOf('function* flagRetainingWallsForCrossingsSteps('),
        source.indexOf('// Rails owns the ONE level-crossing detection.'))
        + source.slice(source.indexOf('function railBoundaryInputs('),
            source.indexOf('// Road centreline tiles arrive after the first rail mesh')), r);
    const refresh = { inputs: r.railBoundaryInputs(), parent, centerX: 0, centerZ: 0 };
    r.pendingCrossingFormationRefresh = refresh;
    return { r, model, profile, flagIndex, crossings, refresh, owners: () => owners,
        steps: r.prepareRailBoundaryGroundSteps(refresh) };
}

test('the live crossing compiler changes private flags while all active queries and acknowledgements stay old', () => {
    const f = fixture(), before = f.model.sceneYAtLocal(30, 0), oldFlags = [...f.profile.internalSegments];
    let next, yields = 0;
    do {
        next = f.steps.next(); yields++;
        assert.equal(f.r.lastRailFormation, f.model); assert.equal(f.model.sceneYAtLocal(30, 0), before);
        assert.deepEqual(f.profile.internalSegments, oldFlags);
        assert.equal(f.r.levelCrossingAccum, f.crossings); assert.equal(f.r.publishedRailBoundaryInputs, null);
    } while (!next.done);
    assert.ok(yields > 1);
    const ground = next.value;
    assert.ok(ground); assert.equal(f.refresh.noGeometryChange, false);
    assert.equal(ground.railFormation.profiles[0].internalSegments[f.flagIndex], true);
    assert.equal(f.profile.internalSegments[f.flagIndex], false);
    assert.equal(Object.isFrozen(ground.railFormation.profiles[0].internalSegments), true);
    assert.equal(ground.isCurrent(), true);
    f.refresh.ground = ground;
    const ack = f.r.prepareRailBoundaryAcknowledgement(f.refresh);
    assert.equal(ack.isCurrent(), true); assert.equal(ack.commit(), true);
    assert.equal(f.r.publishedRailBoundaryInputs.rail, f.refresh.formationPublication.model);
    ack.rollback(); assert.equal(f.r.publishedRailBoundaryInputs, null);
    ground.release(); f.refresh.formationPublication.discard(); f.model.dispose(); assert.equal(f.owners(), 0);
});

test('a no-op crossing pass retains the existing authority and does not allocate a replacement formation', () => {
    const f = fixture({ crossing: false }), ground = drain(f.steps);
    assert.equal(f.refresh.noGeometryChange, true); assert.equal(f.refresh.formationPublication, undefined);
    assert.equal(ground.railFormation, f.model); assert.equal(f.owners(), 2);
    ground.release(); f.model.dispose(); assert.equal(f.owners(), 0);
});

test('superseded or cancelled crossing preparation releases private generations without acknowledging the update', () => {
    for (const stale of [true, false]) {
        const f = fixture(); assert.equal(f.steps.next().done, false);
        assert.ok(f.owners() > 1);
        if (stale) { f.r.lastRoadFormation = { revision: 2 }; assert.equal(drain(f.steps), null); }
        else f.steps.return();
        assert.equal(f.r.publishedRailBoundaryInputs, null); assert.equal(f.r.lastRailFormation, f.model);
        assert.equal(f.profile.internalSegments[f.flagIndex], false);
        assert.equal(f.owners(), 1); f.model.dispose(); assert.equal(f.owners(), 0);
    }
});
