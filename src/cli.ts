#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { getConfig } from './config.js';
import { BridgeServer } from './bridge.js';
import { ExtensionDriver, DedicatedDriver } from './driver.js';
import { RemoteExtensionDriver } from './remote-driver.js';
import { SearchIndex } from './search.js';
import { ThreadsService } from './service.js';
import { createServer } from './server.js';
import {WorkflowStore} from './workflows.js';
import {OfficialThreadsApi,officialApiOptionsFromEnv} from './official-api.js';
import {publishApiDraft} from './publishing.js';
import {publishBrowserDraft} from './browser-publishing.js';
import {SocialActions} from './social-actions.js';
import {appendFileSync} from 'node:fs';
import {join} from 'node:path';

async function main(){
  const config=getConfig();const command=process.argv[2]??'serve';
  if(command==='help'||command==='--help'){console.log('Threads MCP\n  serve   Start MCP stdio server (extension by default)\n  bridge  Start standalone extension pairing host\n  login   Open a dedicated Chrome profile\n  schedule-worker <username> [--once] [--api]  Execute authorized due jobs (selected browser by default)\nEnvironment: THREADS_PROVIDER=extension|dedicated, THREADS_DATA_DIR, THREADS_BRIDGE_PORT, THREADS_ALLOW_WRITES=true, THREADS_API_ACCESS_TOKEN, THREADS_API_USER_ID');return;}
  if(command==='schedule-worker'){
    const accountId=process.argv[3];if(!accountId||accountId.startsWith('--'))throw new Error('schedule-worker requires an exact account ID or username.');
    if(!config.writesEnabled)throw new Error('schedule-worker requires THREADS_ALLOW_WRITES=true.');
    const useApi=process.argv.includes('--api');
    const api=useApi?new OfficialThreadsApi({...officialApiOptionsFromEnv(),writesEnabled:true}):undefined;
    if(api&&(!api.status().configured||!api.status().writeIdentityConfigured))throw new Error('Configure the official API token and numeric account ID before starting an API publishing worker.');
    let service:ThreadsService|undefined;let social:SocialActions|undefined;
    if(!useApi){
      const driver=new RemoteExtensionDriver({dataDir:config.dataDir,port:Number(process.env.THREADS_BRIDGE_PORT??19758)});await driver.connect();
      service=new ThreadsService(driver,new SearchIndex(config.dataDir),config);
      social=new SocialActions(driver,{writesEnabled:true,minActionIntervalMs:config.minActionIntervalMs,reserveWrite:()=>service!.reserveWrite(),
        audit:event=>appendFileSync(join(config.dataDir,'social-actions.jsonl'),JSON.stringify({...event,time:new Date().toISOString()})+'\n')});
    }
    const store=new WorkflowStore({dataDir:config.dataDir,accountId});let stopping=false;let wake:(()=>void)|undefined;
    const stop=()=>{stopping=true;wake?.();};process.once('SIGINT',stop);process.once('SIGTERM',stop);
    try{do{
      const jobs=await store.runDue((draft,context)=>{
        const shouldStop=()=>stopping||store.getSchedule(context.jobId).cancelRequested;
        return api?publishApiDraft(api,draft,context,{shouldStop}):publishBrowserDraft(service!,social!,draft,context,{shouldStop});
      },{writesEnabled:true,limit:1});
      for(const job of jobs)console.log(JSON.stringify({id:job.id,status:job.status,updatedAt:job.updatedAt}));
      if(process.argv.includes('--once')||stopping)break;
      await new Promise<void>(resolve=>{const timer=setTimeout(()=>{wake=undefined;resolve();},30000);wake=()=>{clearTimeout(timer);wake=undefined;resolve();};});
    }while(!stopping);}finally{store.close();await service?.close();}return;
  }
  if(command==='login'){const {loginDedicated}=await import('./driver.js');await loginDedicated(config);return;}
  if(!['serve','bridge'].includes(command))throw new Error('Unknown command. Use --help.');
  const provider=process.env.THREADS_PROVIDER??'extension';
  if(!['extension','dedicated'].includes(provider))throw new Error('THREADS_PROVIDER must be extension or dedicated.');
  const port=Number(process.env.THREADS_BRIDGE_PORT??19758);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid THREADS_BRIDGE_PORT.');
  let bridge:BridgeServer|undefined;let remote:RemoteExtensionDriver|undefined;
  if(provider==='extension'&&command==='serve'){
    remote=new RemoteExtensionDriver({dataDir:config.dataDir,port});
    try{await remote.connect();}catch(error){const code=(error as {code?:string}).code;if(!['BRIDGE_PAIRING_MISSING','ECONNREFUSED'].includes(code??''))throw error;remote=undefined;}
  }
  if((provider==='extension'&&!remote)||command==='bridge'){bridge=new BridgeServer({dataDir:config.dataDir,port});await bridge.start();console.error(`Threads pairing: ${bridge.status().pairingUrl}`);}
  if(command==='bridge'){const stop=async()=>{await bridge!.close();process.exit(0);};process.once('SIGINT',stop);process.once('SIGTERM',stop);return;}
  const driver=remote??(bridge?new ExtensionDriver(bridge):new DedicatedDriver(config));
  const service=new ThreadsService(driver,new SearchIndex(config.dataDir),config);const server=createServer(service);
  let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await server.close();await service.close();process.exit(0);};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);process.stdin.once('end',stop);
  await server.connect(new StdioServerTransport());
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
