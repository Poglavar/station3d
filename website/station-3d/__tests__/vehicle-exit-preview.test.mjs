// The berth preview reuses safe exits at a bounded cadence and invalidates on motion.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createVehicleExitPreview } from '../core/vehicle-exit-preview.js';

test('boat landing preview is bounded, refreshes after movement, and never promises an exit while moving', () => {
 const preview = createVehicleExitPreview(); let calls=0, target=null;
 const read = overrides => preview.read({vehicleId:'boat',pose:{x:0,z:0,heading:0},speedMps:0,maxSpeedMps:.8,nowMs:0,resolve:()=>{calls++;return target;},...overrides});
 assert.equal(read().key,'gta.boatMoveCloserPrompt');
 target={lat:43,lon:16,y:1};
 assert.equal(read({nowMs:200}).available,false);
 assert.equal(calls,1);
 assert.deepEqual(read({nowMs:301}).exitTarget,target);
 assert.equal(calls,2);
 assert.equal(read({speedMps:1}).available,false);
 assert.equal(calls,2);
 assert.equal(read({nowMs:302}).key,'gta.boatExitPrompt');
 read({nowMs:303,pose:{x:0,z:.5,heading:0}});
 read({nowMs:304,pose:{x:0,z:.5,heading:.1}});
 assert.equal(calls,5);
 preview.reset();read({nowMs:305});assert.equal(calls,6);
});

test('a different boat and expired unsupported landing invalidate the preview',()=>{
 const preview=createVehicleExitPreview();let calls=0;
 const args={vehicleId:'a',pose:{x:0,z:0,heading:0},speedMps:0,maxSpeedMps:.8,nowMs:0,resolve:()=>{calls++;return null;}};
 preview.read(args);preview.read({...args,vehicleId:'b'});preview.read({...args,vehicleId:'b',nowMs:301});
 assert.equal(calls,3);
});
