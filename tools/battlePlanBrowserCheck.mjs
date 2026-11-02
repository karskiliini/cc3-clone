/** Real canvas input and deterministic fast-forward. Own Vite/browser only; no shared services. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync,openSync,writeFileSync} from 'node:fs';
const {chromium}=await import(process.env.CC3_PLAYWRIGHT_MODULE??'playwright');
const out=process.env.CC3_SUPPORT_OUT??'support-evidence/battle-plan';mkdirSync(out,{recursive:true});
const log=openSync(out+'/server.log','w');
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5202','--strictPort'],{detached:true,stdio:['ignore',log,log]});
let browser;const result={errors:[],passed:false};
try{
  for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:5202')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({headless:true,...(process.env.CC3_CHROMIUM_EXECUTABLE?{executablePath:process.env.CC3_CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1024,height:768}});page.on('pageerror',e=>result.errors.push(String(e)));
  await page.goto('http://127.0.0.1:5202');await page.waitForFunction(()=>window.__cc3?.input);
  result.setup=await page.evaluate(async()=>{
    const [{Battle},{DeployScreen},{centerCamera}]=await Promise.all([import('/src/sim/battle.ts'),import('/src/ui/screens/deploy.ts'),import('/src/engine/camera.ts')]);
    const b=new Battle({mapId:'border_1941',playerSide:'german',year:1944,seed:58059,durationS:600,difficulty:'normal',controllers:{german:'human',soviet:'human'},neverActOnInitiative:true,alwaysObeyOrders:true,artillerySupport:{german:{shells:48},soviet:{shells:48}},forces:{german:['ger_command','ger_rifle_41','ger_rifle_41'],soviet:['sov_command','sov_rifle_41']}});
    const teams=b.selectableTeams('german'),hq=teams.find(t=>t.type==='command'),rifles=teams.filter(t=>t.type==='rifle'),enemy=b.selectableTeams('soviet').find(t=>t.type==='command');
    const g=window.__cc3;g.battle=b;g.settings.showUnitVision=false;g.settings.showDepthMap=false;g.cam.zoom=1;
    const screen=new DeployScreen(b);g.setScreen(screen);screen.setSelection([hq.id]);centerCamera(g.cam,hq.pos);
    window.__planEvidence={b,hq,rifles,enemy,impacts:[],centerCamera};
    // A sealed opponent plan is deliberately absent from the viewing side's review/traffic.
    b.submit('soviet',{type:'planOrder',teamId:enemy.id,order:{type:'sneak',target:{x:17,y:19},issuedAt:0},trigger:{kind:'signal',signal:3}});
    return{hq:hq.id,rifles:rifles.map(t=>t.id),enemy:enemy.id};
  });
  const click=async(x,y)=>{const r=await page.locator('#game').boundingBox();await page.mouse.click(r.x+x*r.width/1024,r.y+y*r.height/768);await page.waitForTimeout(100);};
  // Pick Signal 1 through the real timing button, collapse review, then Z + ground click.
  await click(135,105);await click(200,73);await page.keyboard.press('z');await click(610,350);
  // Same order gesture with an H-hour trigger, on a different team.
  await page.evaluate(()=>{const e=window.__planEvidence;window.__cc3.screen.setSelection([e.rifles[0].id]);e.centerCamera(window.__cc3.cam,e.rifles[0].pos);});
  await click(200,73);await click(390,105);await click(200,73);await page.keyboard.press('z');await click(610,350);await click(200,73);
  result.plans=await page.evaluate(()=>window.__planEvidence.b.state.battlePlans);
  assert.equal(result.plans.german.orders.length,2);assert.equal(result.plans.german.orders[0].trigger.signal,1);assert.equal(result.plans.german.orders[1].trigger.at,60);
  await page.screenshot({path:out+'/plan-deploy.png'});
  // Opponent ready is setup, local Begin remains a real HUD click.
  await page.evaluate(()=>window.__planEvidence.b.submit('soviet',{type:'ready'}));await click(310,746);
  await page.waitForFunction(()=>window.__cc3.screen.constructor.name==='BattleScreen'&&window.__planEvidence.b.state.phase==='running');
  await page.evaluate(()=>{const e=window.__planEvidence;e.b.step=()=>{};e.before={...e.hq.pos};window.__cc3.screen.setSelection([e.hq.id]);});
  async function advance(seconds){return page.evaluate(seconds=>{const e=window.__planEvidence,end=e.b.state.time+seconds;while(e.b.state.time<end&&e.b.state.phase==='running'){e.b.advanceTick();for(const event of e.b.drainEvents())if(event.kind==='explosion'&&String(event.weaponId).startsWith('field_'))e.impacts.push(event);}return{time:e.b.state.time,phase:e.b.state.phase};},seconds);}
  await click(690,20);await advance(10);
  result.signal=await page.evaluate(()=>{const e=window.__planEvidence;return{before:e.before,after:e.hq.pos,plan:e.b.state.battlePlans.german.orders[0]};});
  assert.equal(result.signal.plan.status,'executed');assert(Math.hypot(result.signal.after.x-result.signal.before.x,result.signal.after.y-result.signal.before.y)>.1);
  await advance(51);result.timed=await page.evaluate(()=>window.__planEvidence.b.state.battlePlans.german.orders[1]);assert.equal(result.timed.status,'executed');
  // Actual Soviet public commands generate intercepted radio; no sealed order content is emitted.
  await page.evaluate(()=>{const e=window.__planEvidence;e.b.submit('soviet',{type:'signal',signal:2});e.b.submit('soviet',{type:'artillery',target:{x:80,y:80},size:'small'});});
  await advance(.1);await click(965,20);
  result.radio=await page.evaluate(async()=>{const {interceptedRadio}=await import('/src/sim/radioTraffic.ts');return interceptedRadio(window.__planEvidence.b.state,'german');});
  assert(result.radio.some(m=>m.payload.kind==='signal'&&m.payload.signalId==='2'));assert(result.radio.some(m=>m.payload.kind==='fireRequest'&&m.payload.target.x===80));assert(!JSON.stringify(result.radio).includes('sneak'));
  // Real artillery button and ground click, followed by simulated message/preparation/flight time.
  await page.evaluate(()=>window.__planEvidence.centerCamera(window.__cc3.cam,{x:80,y:80}));
  await click(490,20);await click(500,390);await advance(.1);
  result.artilleryRequest=await page.evaluate(()=>window.__planEvidence.b.state.artillery.missions.find(m=>m.side==='german'));assert(result.artilleryRequest);
  await page.screenshot({path:out+'/plan-radio-artillery.png'});
  await advance(69);result.airborne=await page.evaluate(()=>window.__planEvidence.b.state.artillery.shells.filter(s=>s.side==='german'));assert(result.airborne.length>0);
  await advance(24);result.impacts=await page.evaluate(()=>window.__planEvidence.impacts);assert(result.impacts.some(e=>e.weaponId==='field_105'));
  // A second real UI request, cancelled through its visible control before any shot.
  await click(490,20);await click(500,390);await advance(.1);await click(960,50);await advance(2.1);
  result.cancelled=await page.evaluate(()=>window.__planEvidence.b.state.artillery.missions.filter(m=>m.side==='german').at(-1));assert.equal(result.cancelled.phase,'cancelled');
  result.commands=await page.evaluate(()=>window.__planEvidence.b.commandLog().filter(c=>['planOrder','signal','artillery','cancelArtillery'].includes(c.type)));
  assert.equal(result.errors.length,0);result.passed=true;
}catch(error){result.failure=String(error);process.exitCode=1;}
finally{await browser?.close();if(server.exitCode==null){try{process.kill(-server.pid,'SIGTERM');}catch{}}await new Promise(r=>server.exitCode!=null?r():server.once('exit',r));result.ownedServicesStopped=true;writeFileSync(out+'/result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
