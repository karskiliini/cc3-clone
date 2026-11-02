import {writeFileSync} from 'node:fs';
const pw=await import(process.env.CC3_PLAYWRIGHT_MODULE??'playwright');
const engine=process.argv[2]??'chromium';
const browser=await pw[engine].launch({headless:true});
try{
 const page=await browser.newPage();await page.goto((process.env.CC3_GAME_URL??'http://127.0.0.1:5203')+'/tools/determinism.html?list=1');
 const trace=await page.evaluate(async()=>{const {commandSupportTrace}=await import('/tools/commandSupportTrace.ts');return commandSupportTrace();});
 writeFileSync(process.argv[3],JSON.stringify(trace));
}finally{await browser.close();}
