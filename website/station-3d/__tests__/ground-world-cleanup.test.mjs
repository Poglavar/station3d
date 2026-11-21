// Regression for early graph preparation failure: the public wrapper must run
// the complete graph finally block so every retained source is released.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createSurfacePublicationRegistry} from '../core/surface-publication-registry.js';
import {composeReceiverSupportReadsSteps} from '../core/receiver-support-read.js';
import {createPublishedGroundReadSlot} from '../core/published-ground-read.js';
import {ownReadSnapshot} from '../core/read-snapshot-lifetime.js';

const source=readFileSync(new URL('../world/ground-generations.js',import.meta.url),'utf8');
const begin=source.indexOf('export function* prepareWorldGroundGenerationSteps');
const end=source.indexOf('const PHYSICS_FAMILIES',begin);
assert.ok(begin>=0&&end>begin,'ground preparation exports must remain extractable');
const extracted=source.slice(begin,end).replaceAll('export function','function');
const make=Function('composeReceiverSupportReadsSteps', `return (()=>{${extracted}; return prepareWorldGroundGenerationSteps;})()` )(composeReceiverSupportReadsSteps);

test('wrapper cleanup releases retained resources and leases after early graph failure',()=>{
  const events=[];
  const registry=createSurfacePublicationRegistry();
  const construction={read:{},discard(){events.push('construction:discard');}};
  const alignment={read:{},isCurrent:()=>true,
    commit(){assert.fail('preparation cannot commit an alignment');},rollback(){},
    discard(){events.push('alignment:discard');throw Error('discard failure');}};
  const admission={terrain:{read:{},release(){events.push('lease:terrain');throw Error('terrain release failure');}},rails:{release(){events.push('lease:rails');}}};
  const layers={rails:{prepareConstructionGroundSteps:function*(){yield {phase:'construction'};return construction;}},roads:{
    prepareAlignmentSourcesGroundSteps:function*(){return null;},
    prepareFormationGroundSteps:function*(){events.push('formation:failure');throw Error('formation failed');}}};
  const ctx={civilGround:{captureTerrainReplacementReadSnapshot(){return {}; }},authoredRoadPortalReplacements:[],
    roadVerticalAlignments:{preparePublicationSteps:function*(){return alignment;}}};
  const steps=make({ctx,layers,admission,scope:{terrainBounds:null,receiverBounds:[]},limits:{railConstruction:{},alignmentSources:{}},registry,generation:1,isCurrent:()=>true});
  assert.equal(steps.next().done,false);
  assert.throws(()=>steps.next(),error=>error.name==='AggregateError'&&error.errors.length>=2);
  assert.deepEqual(events,['formation:failure','alignment:discard','construction:discard','lease:rails','lease:terrain']);
  assert.equal(registry.getActive('ground:road-alignments'),null);
  assert.equal(steps.next().done,true);
  registry.close();
});

test('construction reuse selects the latest published graph and releases its predecessor on cancellation', () => {
  const slot = createPublishedGroundReadSlot(), registry = createSurfacePublicationRegistry();
  const construction = Object.freeze({ revision: 7 }), finalReceiver = Object.freeze({ revision: 8 });
  let owners = 0;
  function lease() {
    owners++;
    let released = false;
    return { retain: lease, release() { if (!released) { released = true; owners--; } } };
  }
  const published = ownReadSnapshot({ constructionRailFormation: construction,
    railFormation: finalReceiver, isCurrent: () => true }, [lease()]);
  const publication = slot.begin({ isCurrent: () => true });
  publication.bindRead(published); publication.commit(); publication.finalize(); published.release();
  assert.equal(owners, 1);
  const ctx = { civilGround: { captureTerrainReplacementReadSnapshot: () => ({}) },
    roadFormation: { getPublishedBuildInputs() { assert.fail('road design inputs can predate the latest published graph'); } } };
  const layers = { rails: { *prepareConstructionGroundSteps({ previous }) {
    assert.equal(previous, construction);
    assert.notEqual(previous, finalReceiver, 'final receiver openings must not feed back into construction');
    yield { phase: 'construction' };
  } } };
  const steps = make({ ctx, layers, admission: { terrain: { read: {} }, rails: {} },
    scope: { terrainBounds: [] }, limits: { railConstruction: {} }, registry, generation: 1,
    receiverReadSlot: slot, isCurrent: () => true });
  assert.equal(steps.next().done, false);
  assert.equal(owners, 2, 'candidate owns the predecessor while copying');
  steps.return();
  assert.equal(owners, 1);
  assert.equal(slot.snapshot().pending, 0);
  assert.equal(slot.hasActive(), true);
  slot.close(); registry.close();
  assert.equal(owners, 0);
});
