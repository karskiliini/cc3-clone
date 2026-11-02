// A render-only day/night comparison on the same production BattleScreen.
// Simulate the real mortar mission first; then hold actors fixed and vary only
// display time/conditions, restoring and checking the complete canonical hash.
// Run in isolation. Use `canvas` to force the Canvas/sprite fallback.
const {chromium}=await import(process.env.CC3_PLAYWRIGHT_MODULE??'playwright');
import {spawn} from 'node:child_process';import {mkdirSync,openSync,writeFileSync} from 'node:fs';
const mode=process.argv[2]??'gpu';const dir=process.env.CC3_SUPPORT_OUT??'support-evidence/benchmark-'+mode;mkdirSync(dir,{recursive:true});const out=openSync(dir+'/server.log','w');
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5200','--strictPort'],{detached:true,stdio:['ignore',out,out]});let browser;const result={errors:[],console:[]};
try{
 for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:5200')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({headless:true,...(process.env.CC3_CHROMIUM_EXECUTABLE?{executablePath:process.env.CC3_CHROMIUM_EXECUTABLE}:{})});
 const page=await browser.newPage({viewport:{width:1024,height:768}});page.on('pageerror',e=>result.errors.push(String(e)));page.on('console',m=>{if(['warning','error'].includes(m.type())||m.text().includes('[night]'))result.console.push(m.text());});await page.goto('http://127.0.0.1:5200'+(mode==='canvas'?'?nightLighting=canvas&vehicles=sprites':''));await page.waitForFunction(()=>window.__cc3?.input);await page.mouse.move(512,335);
 result.setup=await page.evaluate(async()=>{
  const [{Battle},{BattleScreen},{centerCamera},{nightLightingDiagnostics},{hashState}]=await Promise.all([import('/src/sim/battle.ts'),import('/src/ui/screens/battle.ts'),import('/src/engine/camera.ts'),import('/src/render/nightLighting.ts'),import('/src/sim/stateHash.ts')]);
  const b=new Battle({mapId:'village_1942',playerSide:'german',year:1944,scenarioDate:'1944-07-15',seed:58059,durationS:600,difficulty:'normal',controllers:{german:'human',soviet:'human'},timeOfDay:'night',weather:'clear',illuminationRounds:2,neverActOnInitiative:true,alwaysObeyOrders:true,forces:{german:['ger_mortar81','ger_rifle_41','ger_pz4gh'],soviet:['sov_rifle_41','sov_t34_76']}});
  const mortar=[...b.state.teams.values()].find(t=>t.side==='german'&&t.type==='mortar'),rifle=[...b.state.teams.values()].find(t=>t.side==='german'&&t.type==='rifle'),tank=[...b.state.teams.values()].find(t=>t.side==='german'&&t.vehicleId&&!t.supportForTeamId);
  for(const [t,pos]of [[mortar,{x:112,y:120}],[rifle,{x:98,y:106}],[tank,{x:112,y:106}]])if(t)b.submit('german',{type:'deployTeam',teamId:t.id,pos});
  b.step(0);b.submit('german',{type:'ready'});b.submit('soviet',{type:'ready'});b.step(0);
  if(rifle)b.submit('german',{type:'order',teamId:rifle.id,order:{type:'moveFast',target:{x:100,y:97},issuedAt:0}});if(tank)b.submit('german',{type:'order',teamId:tank.id,order:{type:'move',target:{x:112,y:96},issuedAt:0}});
  for(let i=0;i<300;i++){b.advanceTick();b.drainEvents();}
  b.step=()=>{};const g=window.__cc3;g.battle=b;g.cam.zoom=.75;g.settings.showUnitVision=false;g.settings.showDepthMap=false;g.settings.alwaysSeeEnemy=false;
  const screen=new BattleScreen(b);g.setScreen(screen);screen.setSelection([mortar.id]);centerCamera(g.cam,{x:105,y:93});
  window.__support={b,mortar,screen,nightLightingDiagnostics,hashState};
  return{time:b.state.time,mortar:mortar.id,cw:mortar.crewWeapon,stock:mortar.illuminationAmmo,tank:tank?.id,hash:hashState(b)};
 });
 await page.waitForTimeout(1000);await page.screenshot({path:dir+'/night-dark.png'});
 await page.keyboard.press('l');await page.waitForTimeout(150);result.armed=await page.evaluate(()=>({pending:window.__support.screen.pendingSupport,count:window.__support.b.pendingCount()}));
 const target=await page.evaluate(async()=>{const {worldToScreen}=await import('/src/engine/camera.ts');return worldToScreen(window.__cc3.cam,{x:105,y:83});});const rect=await page.locator('#game').boundingBox();await page.mouse.click(rect.x+target.x*rect.width/1024,rect.y+target.y*rect.height/768);await page.waitForTimeout(150);
 result.mission=await page.evaluate(()=>{const {b,mortar}=window.__support;for(let i=0;i<230;i++){b.advanceTick();b.drainEvents();}return{time:b.state.time,mission:mortar.illuminationMission,stock:mortar.illuminationAmmo,flares:b.state.flares,shots:b.state.illuminationShots,commands:b.commandLog().filter(c=>c.type==='illuminate'),cw:mortar.crewWeapon};});
 await page.waitForTimeout(1200);
 result.benchmarks={};
 for(const quality of ['day','night'])result.benchmarks[quality]=await page.evaluate(async quality=>{
  const s=window.__support,state=s.b.state,originalTime=state.time,originalMode=state.config.timeOfDay,before=s.hashState(s.b),draw=s.screen.draw.bind(s.screen),samples=[],frames=[];let last=performance.now(),count=0;
  return await new Promise(resolve=>{s.screen.draw=ctx=>{state.config.timeOfDay=quality;state.time=originalTime+count*.05;const start=performance.now();draw(ctx);const end=performance.now();if(count>10){samples.push(end-start);frames.push(start-last);}last=start;if(++count<130)return;s.screen.draw=draw;state.time=originalTime;state.config.timeOfDay=originalMode;const stat=v=>{const a=v.sort((a,b)=>a-b);return{median:a[Math.floor(a.length*.5)],p95:a[Math.floor(a.length*.95)],max:a.at(-1),samples:a.length};};resolve({drawMs:stat(samples),frameMs:stat(frames),renderer:s.nightLightingDiagnostics(),restored:s.hashState(s.b)===before});};});
 },quality);
 result.renderer=await page.evaluate(()=>window.__support.nightLightingDiagnostics());
 result.readonly=await page.evaluate(()=>{const {b,hashState}=window.__support;return{hash:hashState(b),rng:b.rng.state()};});await page.waitForTimeout(500);result.after=await page.evaluate(()=>{const {b,hashState}=window.__support;return{hash:hashState(b),rng:b.rng.state()};});
 if(result.errors.length||Object.values(result.benchmarks).some(b=>!b.restored)||JSON.stringify(result.readonly)!==JSON.stringify(result.after))process.exitCode=1;
} catch(e){result.failure=String(e);process.exitCode=1;}finally{await browser?.close();try{process.kill(-server.pid,'SIGTERM');}catch{}await new Promise(r=>server.exitCode!=null?r():server.once('exit',r));result.serverStopped=true;writeFileSync(dir+'/smoke.json',JSON.stringify(result,null,2));console.log(JSON.stringify({errors:result.errors,console:result.console,renderer:result.renderer,benchmarks:result.benchmarks,flareCount:result.mission?.flares?.length,stock:result.mission?.stock,commands:result.mission?.commands?.length,failure:result.failure,serverStopped:result.serverStopped}));}
