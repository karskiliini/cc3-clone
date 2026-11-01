/** Real canvas/DOM multiplayer flow. Requires an already built frontend and relay.
 * CC3_GAME_URL defaults to http://127.0.0.1:8796 (local hook needed for assertions).
 * Optional CC3_PLAYWRIGHT_MODULE / CC3_CHROMIUM_EXECUTABLE reuse an existing install.
 * No server is started or stopped by this script. Output contains no resume tokens. */
import assert from 'node:assert/strict';
import { mkdirSync,writeFileSync,mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const {chromium}=await import(process.env.CC3_PLAYWRIGHT_MODULE??'playwright');
const url=process.env.CC3_GAME_URL??'http://127.0.0.1:8796';
const out=process.env.CC3_SMOKE_OUT??mkdtempSync(join(tmpdir(),'cc3-online-smoke-'));mkdirSync(out,{recursive:true});
const report={errors:[],consoleErrors:[],phases:[],passed:false};let browser;const contexts=[];
const checkpoint=()=>writeFileSync(join(out,'result.json'),JSON.stringify(report,null,2));
try {
 browser=await chromium.launch({headless:true,...(process.env.CC3_CHROMIUM_EXECUTABLE?{executablePath:process.env.CC3_CHROMIUM_EXECUTABLE}:{}),args:[]});
 async function pageFor(name,viewport){const c=await browser.newContext({viewport,acceptDownloads:true,...(process.env.CC3_RECORD_VIDEO==='1'?{recordVideo:{dir:join(out,name),size:{width:1024,height:768}}}:{})});contexts.push(c);const p=await c.newPage();p.on('console',m=>{if(m.type()==='error')report.consoleErrors.push(`${name}: ${m.text()}`);});p.on('pageerror',e=>report.errors.push(`${name}: ${e}`));return p;}
 const a=await pageFor('host',{width:1024,height:768}),b=await pageFor('guest',{width:1280,height:720});
 async function click(p,x,y){const at=await p.evaluate(({x,y})=>{const r=document.getElementById('game').getBoundingClientRect(),s=Math.min(r.width/1024,r.height/768);return{x:r.left+(r.width-1024*s)/2+x*s,y:r.top+(r.height-768*s)/2+y*s};},{x,y});await p.mouse.click(at.x,at.y);}
 async function openLobby(p){await p.goto(url);await p.waitForFunction(()=>window.__cc3?.input);await click(p,740,620);await p.locator('#cc3-online-lobby').waitFor({state:'visible'});}
 const snap=p=>p.evaluate(()=>{const g=window.__cc3,n=g.online;return{screen:g.screen?.constructor.name,phase:n?.phase,message:n?.message,turn:n?.session?.turn,tick:g.battle?.state.tick,battlePhase:g.battle?.state.phase,side:n?.client.side,code:n?.client.room?.code,status:n?.session?.status,progress:n?.progress,speed:g.battle?.state.speed,policy:g.battle?.state.multiplayerPolicy,ready:g.battle?.state.deploymentReady,chain:n?.session?.hashChain??[],reports:n?.session?.reports.map(r=>({epoch:r.epoch,recovered:r.recovered,attempts:r.attempts,reason:r.reason})),rebuiltDrawn:g.battle===n?.session?.battle};});
 function common(x,y){const xm=new Map(x.chain),ym=new Map(y.chain),keys=[...xm.keys()].filter(t=>ym.has(t));assert(keys.length>0,'no shared hash turns');for(const t of keys)assert.equal(xm.get(t),ym.get(t),`hash turn ${t}`);}
 async function phase(name){const x=await snap(a),y=await snap(b);report.phases.push({name,host:x,guest:y});checkpoint();console.log(name);return[x,y];}
 await openLobby(a);await a.getByRole('button',{name:'Create room',exact:true}).click();await a.locator('#share-code').waitFor({state:'visible'});const code=await a.locator('#share-code').inputValue();assert.match(code,/^[A-Z2-9]{6}$/);
 await openLobby(b);await b.getByLabel('Room code',{exact:true}).fill(code);await b.getByRole('button',{name:'Join room',exact:true}).click();await b.locator('#share-code').waitFor({state:'visible'});assert.equal(await b.locator('#share-code').inputValue(),code);
 await a.screenshot({path:join(out,'room.png')});await phase('room-joined');
 async function choose(p){await p.getByRole('button',{name:'Choose my forces',exact:true}).click();await p.waitForFunction(()=>window.__cc3.screen.picker?.rosterIds);
  while((await p.evaluate(()=>window.__cc3.screen.picker.rosterIds.length))>2){await click(p,630,280);await click(p,812,191);await p.waitForTimeout(35);}
  assert.equal(await p.evaluate(()=>window.__cc3.screen.picker.rosterIds.length),2);await click(p,850,657);
 }
 await choose(a);await choose(b);await Promise.all([a,b].map(p=>p.waitForFunction(()=>window.__cc3.online?.battle?.state.phase==='deploy',{},{timeout:12000})));
 async function drag(p){const at=await p.evaluate(()=>{const g=window.__cc3,team=[...g.battle.state.teams.values()].find(t=>t.side===g.battle.playerSide()),s=g.battle.state.soldiers.get(team.leaderId);const target=[{x:team.pos.x+2,y:team.pos.y+2},{x:team.pos.x-2,y:team.pos.y+2},{x:team.pos.x+2,y:team.pos.y-2}].find(p=>g.battle.canDeployTeam(team.id,p));if(!target)throw new Error('no legal drag');return{from:{x:(s.pos.x-g.cam.x)*20*g.cam.zoom,y:(s.pos.y-g.cam.y)*20*g.cam.zoom},to:{x:(target.x-g.cam.x)*20*g.cam.zoom,y:(target.y-g.cam.y)*20*g.cam.zoom}};});
  const scale=await p.evaluate(()=>{const r=document.getElementById('game').getBoundingClientRect(),s=Math.min(r.width/1024,r.height/768);return{s,x:r.left+(r.width-1024*s)/2,y:r.top+(r.height-768*s)/2};});
  await p.mouse.move(scale.x+at.from.x*scale.s,scale.y+at.from.y*scale.s);await p.mouse.down();await p.mouse.move(scale.x+at.to.x*scale.s,scale.y+at.to.y*scale.s,{steps:12});await p.waitForTimeout(100);await p.mouse.up();
 }
 await drag(a);await drag(b);await Promise.all([a,b].map(p=>p.waitForFunction(()=>window.__cc3.battle.commandLog().some(c=>c.type==='deployTeam'&&c.side===window.__cc3.battle.playerSide()),{},{timeout:8000})));
 await click(a,310,746);await a.waitForFunction(()=>window.__cc3.battle.isReady('german'));assert.equal((await snap(a)).battlePhase,'deploy');await click(b,310,746);
 await Promise.all([a,b].map(p=>p.waitForFunction(()=>window.__cc3.battle.state.phase==='running',{},{timeout:8000})));await a.waitForTimeout(1200);common(...await phase('both-deployed-running'));
 await a.keyboard.press('F3');await Promise.all([a,b].map(p=>p.waitForFunction(()=>window.__cc3.battle.state.phase==='paused')));await b.keyboard.press('F3');await b.waitForTimeout(500);assert.equal((await snap(b)).battlePhase,'paused');await a.screenshot({path:join(out,'shared-pause.png')});await phase('owner-controlled-pause');
 await a.keyboard.press('F3');await Promise.all([a,b].map(p=>p.waitForFunction(()=>window.__cc3.battle.state.phase==='running')));
 await a.keyboard.press('Tab');await a.waitForFunction(()=>window.__cc3.battle.state.multiplayerPolicy.speedVotes.german===2);assert.equal((await snap(a)).speed,1);await b.keyboard.press('Tab');await Promise.all([a,b].map(p=>p.waitForFunction(()=>window.__cc3.battle.state.speed===2)));await b.keyboard.press('Tab');await b.waitForTimeout(400);await b.keyboard.press('Tab');await Promise.all([a,b].map(p=>p.waitForFunction(()=>window.__cc3.battle.state.speed===1)));common(...await phase('shared-speed-votes'));
 await b.reload();await a.waitForFunction(()=>window.__cc3.online.phase==='waiting');await b.waitForFunction(()=>window.__cc3?.input);await click(b,740,620);await b.getByRole('button',{name:'Rejoin saved game',exact:true}).click();await Promise.all([a,b].map(p=>p.waitForFunction(()=>window.__cc3.online?.phase==='playing'&&window.__cc3.online.session.turn>10,{},{timeout:20000})));await a.waitForTimeout(1200);common(...await phase('tab-reloaded-rejoined'));assert((await snap(b)).rebuiltDrawn);
 await a.evaluate(()=>{const g=window.__cc3;g.battle.state.soldiers.values().next().value.pos.x+=.001;});await a.waitForFunction(()=>window.__cc3.online.session.status==='resyncing',{},{timeout:10000});await a.screenshot({path:join(out,'resynchronising.png')});await Promise.all([a,b].map(p=>p.waitForFunction(()=>window.__cc3.online.session.status==='playing'&&window.__cc3.online.session.reports.some(r=>r.recovered),{},{timeout:20000})));common(...await phase('desync-recovered-visible'));
 const download1=a.waitForEvent('download');await click(a,938,53);const d1=await download1;await d1.saveAs(join(out,'recovered-report.json'));
 // Inject disagreeing rebuilt hashes on both peers to exercise the actual failure UI.
 for(const p of [a,b])await p.evaluate(()=>{const t=window.__cc3.online.session.transport,send=t.send.bind(t);t.send=m=>send(m.kind==='resynced'?{...m,hash:(m.hash^1)>>>0}:m);});
 await a.evaluate(()=>{window.__cc3.battle.state.soldiers.values().next().value.pos.x+=.001;});await Promise.all([a,b].map(p=>p.waitForFunction(()=>window.__cc3.online.phase==='failed',{},{timeout:30000})));await a.screenshot({path:join(out,'recovery-failed-actions.png')});await phase('three-failed-rebuilds-actions');
 const download2=a.waitForEvent('download');await click(a,642,413);const d2=await download2;await d2.saveAs(join(out,'failed-report.json'));
 await click(a,382,364);await a.waitForFunction(()=>!window.__cc3.online&&window.__cc3.battle.sideIsAI('soviet'));report.localAI=true;await a.screenshot({path:join(out,'local-ai.png')});
 await click(b,382,413);await b.waitForFunction(()=>!window.__cc3.online&&window.__cc3.battle.state.fledSide==='soviet');report.forfeit=true;
 assert.equal(report.errors.length,0);report.passed=true;checkpoint();
}catch(e){report.failure=String(e);checkpoint();throw e;}finally{for(const c of contexts)await c.close();if(browser)await browser.close();report.browsersStopped=true;checkpoint();}
