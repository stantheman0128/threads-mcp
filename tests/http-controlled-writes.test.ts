import test from 'node:test';
import {request} from 'node:http';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {ThreadsService} from '../src/service.js';
import {SearchIndex} from '../src/search.js';
import {getConfig} from '../src/config.js';
import {startRemoteHttp,RemoteReadDriver} from '../src/http-server.js';
import {REMOTE_READ_TOOLS,REMOTE_SOCIAL_TOOLS} from '../src/server.js';
const target='https://www.threads.com/@alice/post/ABC';
async function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'threads-controlled-')),calls:any[]=[];let token='a'.repeat(43),url=target,committed=false,uncertain=false;let readHook:(()=>Promise<void>)|undefined;
 const raw={status:()=>({connected:true}),close:async()=>{},command:async<T>(c:any)=>{
  calls.push(c);if(c.type==='read'&&readHook){const hook=readHook;readHook=undefined;await hook();}
  if(c.type==='read')return {url,viewer:{username:'alice'},posts:[],profiles:[],replies:[],warnings:[],observedAt:new Date().toISOString(),composerState:{present:false,nonempty:false,attachments:false,ambiguous:false}} as T;
  if(c.type==='navigate'){url=c.url;return {url} as T;}
  if(c.type==='social'){
   const observation={account:'alice',url,targetUrl:target,state:committed?'unlike':'like',verified:committed,evidence:[]};
   if(c.operation==='stage')return {token:'stage-token',account:'alice',url,request:c.request,before:observation,noop:false} as T;
   if(c.operation==='commit'){committed=true;if(uncertain)throw Error('private raw error');return {dispatched:true,noop:false} as T;}
   return observation as T;
  }
  throw Error('Unexpected command');
 }};
 const service=new ThreadsService(new RemoteReadDriver(raw),new SearchIndex(dir),{...getConfig(),dataDir:dir,writesEnabled:true,minActionIntervalMs:8000});
 const http=await startRemoteHttp(service,{port:0,readToken:()=>token,controlledWrites:true,socialDriver:raw});
 const endpoint=new URL(`http://127.0.0.1:${(http.address() as any).port}/mcp`);const clients:Client[]=[];
 const connect=async()=>{const client=new Client({name:'controlled-test',version:'1'});clients.push(client);await client.connect(new StreamableHTTPClientTransport(endpoint,{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));return client;};
 const client=await connect();
 return {client,connect,calls,service,endpoint,pauseRead:()=>{let start!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>start=r),hold=new Promise<void>(r=>release=r);readHook=async()=>{start();await hold;};return {ready,release};},rotate:()=>token='b'.repeat(43),uncertain:()=>uncertain=true,close:async()=>{for(const c of clients)await c.close();await new Promise<void>(r=>http.close(()=>r()));await service.close();rmSync(dir,{recursive:true,force:true});}};
}
const call=(c:Client,name:string,args:any)=>c.callTool({name,arguments:args});
const prepare=(c:Client)=>call(c,'threads_prepare_social',{kind:'like',targetUrl:target,expectedAccount:'alice'});
function errorCode(response:any){return JSON.parse(response.content[0].text).error;}
test('controlled HTTP retains reviewed preparation across requests and consumes it once',async()=>{
 const f=await fixture();try{
  const list=await f.client.listTools();assert.deepEqual(new Set(list.tools.map(t=>t.name)),new Set([...REMOTE_READ_TOOLS,...REMOTE_SOCIAL_TOOLS]));assert.equal(list.tools.length,18);
  const status=(await call(f.client,'threads_status',{})).structuredContent as any;assert.equal(status.writesEnabled,true);assert.equal(status.remoteReadOnly,false);assert.ok(!status.allowedWriteKinds.includes('delete'));
  const staged=await prepare(f.client);assert.ok(!staged.isError);const id=(staged.structuredContent as any).id;
  const executed=await call(f.client,'threads_execute_social',{id,expectedAccount:'alice'});assert.equal((executed.structuredContent as any).outcome,'verified');
  const replay=await call(f.client,'threads_execute_social',{id,expectedAccount:'alice'});assert.equal(errorCode(replay),'INVALID_ACTION');assert.equal(f.calls.filter(c=>c.operation==='commit').length,1);
  for(const name of ['threads_execute_action','threads_stage_media','threads_get_feed','threads_export','threads_api_execute','threads_run_schedules'])await assert.rejects(call(f.client,name,{}),/not found/);
 }finally{await f.close();}
});
test('controlled HTTP rejects wrong account and unsupported fields/kinds before stage',async()=>{
 const f=await fixture();try{
  const wrong=await call(f.client,'threads_prepare_social',{kind:'like',targetUrl:target,expectedAccount:'bob'});assert.equal(wrong.isError,true);
  for(const extra of [{kind:'delete'},{mediaToken:'x'},{targetUrl:'https://evil.example/'}]){const result=await call(f.client,'threads_prepare_social',{kind:'like',targetUrl:target,expectedAccount:'alice',...extra});assert.equal(result.isError,true);}
  assert.equal(f.calls.filter(c=>c.operation==='stage').length,0);
 }finally{await f.close();}
});
test('bearer rotation invalidates pending remote preparations across clients',async()=>{
 const f=await fixture();try{
  const id=((await prepare(f.client)).structuredContent as any).id;f.rotate();const replacement=await f.connect();
  const response=await call(replacement,'threads_execute_social',{id,expectedAccount:'alice'});assert.equal(errorCode(response),'INVALID_ACTION');assert.equal(f.calls.filter(c=>c.operation==='commit').length,0);
 }finally{await f.close();}
});
test('uncertain HTTP execution cannot replay; shared cooldown survives new request server objects',async()=>{
 const f=await fixture();try{
  f.uncertain();const id=((await prepare(f.client)).structuredContent as any).id;
  const result=await call(f.client,'threads_execute_social',{id,expectedAccount:'alice'});assert.equal((result.structuredContent as any).outcome,'outcome-uncertain');assert.doesNotMatch(JSON.stringify(result),/private raw error/);
  assert.equal(errorCode(await call(f.client,'threads_execute_social',{id,expectedAccount:'alice'})),'INVALID_ACTION');
  const next=((await prepare(f.client)).structuredContent as any).id;const cooldown=await call(f.client,'threads_execute_social',{id:next,expectedAccount:'alice'});assert.equal(errorCode(cooldown),'ACTION_COOLDOWN');assert.equal(f.calls.filter(c=>c.operation==='commit').length,1);
 }finally{await f.close();}
});

test('old bearer slow request body cannot inherit newly observed credential epoch',async()=>{
 const f=await fixture();let req:ReturnType<typeof request>|undefined;
 try{
  const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'threads_prepare_social',arguments:{kind:'like',targetUrl:target,expectedAccount:'alice'}}});
  const response=new Promise<number>((resolve,reject)=>{req=request(f.endpoint,{method:'POST',headers:{Authorization:`Bearer ${'a'.repeat(43)}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));});req.on('error',reject);req.write(body.slice(0,40));});
  let busy=false;for(let i=0;i<20&&!busy;i++){const health=await fetch(new URL('/healthz',f.endpoint),{headers:{Authorization:`Bearer ${'a'.repeat(43)}`}});busy=(await health.json() as any).busy;if(!busy)await new Promise(r=>setTimeout(r,20));}assert.equal(busy,true);
  f.rotate();assert.equal((await fetch(new URL('/healthz',f.endpoint),{headers:{Authorization:`Bearer ${'b'.repeat(43)}`}})).status,200);
  req!.end(body.slice(40));assert.equal(await response,401);assert.equal(f.calls.filter(c=>c.operation==='stage').length,0);
 }finally{req?.destroy();await f.close();}
});
test('execution rereads revoked access after asynchronous preflight without another HTTP request',async()=>{
 const f=await fixture();try{
  const id=((await prepare(f.client)).structuredContent as any).id;const pause=f.pauseRead();
  const pending=call(f.client,'threads_execute_social',{id,expectedAccount:'alice'});await pause.ready;f.rotate();pause.release();
  const result=(await pending).structuredContent as any;assert.equal(result.outcome,'outcome-uncertain');assert.equal(result.error,'ACCESS_CHANGED');assert.equal(f.calls.filter(c=>c.operation==='commit').length,0);
 }finally{await f.close();}
});
