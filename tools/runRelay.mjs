import { build } from 'esbuild';
import { simulationFingerprint } from './simulationFingerprint.ts';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=resolve(root,'node_modules/.cache/cc3-relay/relay.mjs');
await build({entryPoints:[resolve(root,'server/relay.ts')],bundle:true,platform:'node',format:'esm',target:'node24',external:['ws'],outfile:output,define:{__SIMULATION_BUILD__:JSON.stringify(simulationFingerprint(root))},tsconfig:resolve(root,'tsconfig.json')});
const {createRelayServer}=await import(pathToFileURL(output).href);
const relay=await createRelayServer({host:process.env.CC3_RELAY_HOST??'127.0.0.1',port:Number(process.env.PORT??8787),staticDir:process.env.CC3_STATIC_DIR?resolve(process.env.CC3_STATIC_DIR):undefined,allowedOrigins:process.env.CC3_ALLOWED_ORIGINS?.split(',').filter(Boolean)});
console.log(`CC3 relay listening on port ${relay.port}`);
let stopping=false;
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{if(stopping)return;stopping=true;await relay.close();process.exit(0);});
