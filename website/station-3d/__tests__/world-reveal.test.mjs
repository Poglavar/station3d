// Verify world publication and the first rendered controller frame gate the reveal.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const cab=readFileSync(new URL('../modes/cab.js',import.meta.url),'utf8');
const animate=readFileSync(new URL('../scene/animate.js',import.meta.url),'utf8');

test('world readiness is delivered once after a real render with an initialized camera pose',()=>{
 const events=[];
 const state={cabState:{initialWorldPending:true,pendingCampaignReadyReason:'layers-published',onCampaignSessionReady:r=>events.push(r)}};
 const context=vm.createContext({state,isAutoRenderQualityActive:()=>false});
 vm.runInContext(cab.slice(cab.indexOf('function cabAfterRender()'),cab.indexOf('\n}',cab.indexOf('function cabAfterRender()'))+2),context);
 context.cabAfterRender();assert.equal(events.length,0);
 state.cabState.lastRenderedPose={lat:1,lon:1};
 Object.assign(context,{renderFrame:false,restoreAbsoluteRenderCoordinates:()=>events.push('restore'),renderer:{render:()=>events.push('render')},scene:{},camera:{},afterRenderHooks:new Set([context.cabAfterRender])});
 const start=animate.indexOf('        if (renderFrame) {');
 const render=animate.slice(start,animate.indexOf('        const frameGpuAttribution',start));
 vm.runInContext(render,context);assert.deepEqual(events,['restore'],'a skipped hidden frame cannot release the cover');
 context.renderFrame=true;vm.runInContext(render,context);
 assert.deepEqual(events,['restore','render','layers-published']);assert.equal(state.cabState.initialWorldPending,false);
 vm.runInContext(render,context);assert.deepEqual(events,['restore','render','layers-published','render']);
 state.cabState=null;context.cabAfterRender();
});

test('blocking publication precedes pack readiness and the old scheduling-RAF shortcut is gone',()=>{
 const body=cab.slice(cab.indexOf('async function startSessionLayers'),cab.indexOf('// ── Tunnel surface suspension'));
 assert.ok(body.indexOf("pendingCampaignReadyReason = 'layers-published'")>body.indexOf('await cabState.layerStartup.start(entry)'));
 assert.doesNotMatch(body,/onCampaignSessionReady\?\./);
 assert.match(cab,/unregisterAfterRenderHook = onAfterRender\(cabAfterRender\)/);
 assert.match(cab,/unregisterAfterRenderHook\?\.\(\)/);
});


test('a resumed boat remains covered until its controller and camera replace the temporary foot pose',()=>{
 let ready=0;
 const cabState={initialVehicleId:'boat',initialVehicleClaimPending:true,
  pendingCampaignReadyReason:'layers-published',lastRenderedPose:{status:{driving:false}},onCampaignSessionReady:()=>ready++};
 const context=vm.createContext({state:{cabState}});
 vm.runInContext(cab.slice(cab.indexOf('function cabAfterRender()'),cab.indexOf('\n}',cab.indexOf('function cabAfterRender()'))+2),context);
 context.cabAfterRender();assert.equal(ready,0);
 cabState.initialVehicleClaimPending=false;context.cabAfterRender();assert.equal(ready,0);
 cabState.lastRenderedPose.status.driving=true;context.cabAfterRender();assert.equal(ready,1);
});
