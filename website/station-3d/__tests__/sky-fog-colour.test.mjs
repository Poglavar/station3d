// Sky texture and fog must describe the same colour at night and daylight.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import * as Three from 'three';

function skyHarness(){
 const gradients=[];
 const ctx={clearRect(){},fillRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},
  createLinearGradient(){const gradient={stops:[],addColorStop(at,color){this.stops.push({at,color});}};gradients.push(gradient);return gradient;},
  createRadialGradient(){return{addColorStop(){}};}};
 const scene={fog:new Three.Fog(0,0,1200)};
 const THREE={...Three,PMREMGenerator:class{compileEquirectangularShader(){}fromEquirectangular(){return{texture:{},dispose(){}};}}};
 const source=readFileSync(new URL('../scene/sky.js',import.meta.url),'utf8').replace(/^import[\s\S]*?;\s*$/gm,'').replace(/\bexport /g,'');
 const context=vm.createContext({THREE,scene,renderer:{},sun:{intensity:1},fill:{intensity:1},ambient:{intensity:1},window:{location:{search:''}},document:{createElement:()=>({width:512,height:256,getContext:()=>ctx})},parseTimeOfDayOverride:()=>null,getRainIntensity:()=>0,setBuildingNightMode(){},setCarNightMode(){},setTramNightMode(){},setStreetLampNightMode(){}});
 vm.runInContext(source+'\nglobalThis.api={setSceneTimeOfDayOverride,getSkyColorForHour};',context);
 return{scene,gradients,api:context.api};
}

test('fog matches the sRGB sky at the equator in night, dawn and day',()=>{
 const h=skyHarness();
 for(const hour of [23,6,12]){
  h.api.setSceneTimeOfDayOverride(hour);
  const stops=h.gradients.at(-1).stops;
  const horizon=stops.find(s=>s.at===.46),next=stops.find(s=>s.at===.54);
  assert.equal(horizon.color,next.color,'a constant horizon straddles the equator');
  const decoded=new Three.Color().setStyle(horizon.color);
  for(const component of ['r','g','b']) assert.ok(Math.abs(decoded[component]-h.scene.fog.color[component])<.004,'canvas round-trip matches linear fog');
 }
 h.api.setSceneTimeOfDayOverride(23);
 assert.ok(Math.max(h.scene.fog.color.r,h.scene.fog.color.g,h.scene.fog.color.b)<.04,'night fog stays dark with no unconditional daylight tint');
});
