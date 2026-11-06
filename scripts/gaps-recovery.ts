import {RemoteExtensionDriver} from '../src/remote-driver.js';
import {ThreadsService} from '../src/service.js';
import {ThreadsObservations} from '../src/observations.js';
import {SearchIndex} from '../src/search.js';
import {getConfig} from '../src/config.js';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
const config=getConfig();const remote=new RemoteExtensionDriver({dataDir:config.dataDir});
const commands:unknown[]=[];
const driver={status:()=>remote.status(),close:()=>remote.close(),command:async<T>(command:Record<string,unknown>)=>{
  const started=Date.now();try{const result=await remote.command<T>(command);const r=result as any;commands.push({type:command.type,elapsed:Date.now()-started,url:r?.url,visibility:r?.visibilityState,textLength:r?.text?.length,posts:r?.posts?.length});return result;}
  catch(error){commands.push({type:command.type,elapsed:Date.now()-started,error:(error as any).code});throw error;}
}};
const service=new ThreadsService(driver,new SearchIndex(config.dataDir),config);const observations=new ThreadsObservations(service,config.dataDir);
const checks:Record<string,unknown>={};
try{
  await remote.connect();
  const initial=await service.browserRead();const account=initial.viewer.username;if(!account)throw new Error('Account unavailable');
  for(const [name,run] of [
    ['insights',async()=>{const r=await observations.accountInsights({account});if(r.state!=='observed-summary')throw new Error('Summary not ready');return {state:r.state,period:r.periodLabel,metrics:r.metrics};}],
    ['recent',async()=>{const r=await service.discover('Codex',1,'recent');if(!r.posts.length)throw new Error('No recent posts');return {observed:r.posts.length,url:r.sourceUrl};}],
    ['next-cycle',async()=>{const r=await service.profile(account,'posts',0);if(!r.items.length)throw new Error('Profile not ready');return {observed:r.items.length};}],
  ] as const){try{const before=await service.browserRead();const result=await run();const after=await service.browserRead();checks[name]={status:'PASS',result,before:before.visibilityState,after:after.visibilityState};console.log(JSON.stringify({check:name,...checks[name] as object}));}catch(error){checks[name]={status:'FAIL',error:String(error)};console.log(JSON.stringify({check:name,...checks[name] as object}));}}
}finally{writeFileSync(join(config.dataDir,'gaps-recovery.json'),JSON.stringify({finishedAt:new Date().toISOString(),checks,commands},null,2));await service.close();if(Object.values(checks).some((x:any)=>x.status!=='PASS'))process.exitCode=2;}
