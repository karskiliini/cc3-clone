import {spawn,execFileSync} from 'node:child_process';
import {mkdirSync,openSync,readFileSync,writeFileSync} from 'node:fs';
import {build} from 'esbuild';
const out=process.env.CC3_COMMAND_OUT??'evidence/parity';mkdirSync(out,{recursive:true});
await build({entryPoints:['tools/commandSupportTraceNode.ts'],bundle:true,platform:'node',format:'esm',outfile:out+'/node.mjs'});
const log=openSync(out+'/server.log','w');
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5203','--strictPort'],{detached:true,stdio:['ignore',log,log]});
const result={passed:false,ownedServicesStopped:false};
try{
 for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:5203')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 execFileSync(process.execPath,[out+'/node.mjs',out+'/node.json'],{stdio:'inherit'});
 for(const engine of ['chromium','webkit'])execFileSync(process.execPath,['tools/commandSupportTraceBrowser.mjs',engine,out+`/${engine}.json`],{stdio:'inherit'});
 const expected=readFileSync(out+'/node.json','utf8');
 for(const engine of ['chromium','webkit'])if(readFileSync(out+`/${engine}.json`,'utf8')!==expected)throw new Error(`${engine} trace differs from Node`);
 const trace=JSON.parse(expected);Object.assign(result,{passed:true,ticks:trace.chain.length,hash:trace.hash,replayHash:trace.replayHash,impacts:trace.impacts});
}catch(e){result.failure=String(e);process.exitCode=1;}
finally{if(server.exitCode==null){try{process.kill(-server.pid,'SIGTERM');}catch{}}await new Promise(r=>server.exitCode!=null?r():server.once('exit',r));result.ownedServicesStopped=true;writeFileSync(out+'/result.json',JSON.stringify(result,null,2));console.log(result);}
