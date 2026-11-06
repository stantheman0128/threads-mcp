import assert from 'node:assert/strict';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {getConfig} from '../src/config.js';
import {RemoteExtensionDriver} from '../src/remote-driver.js';
const config=getConfig();const endpoint=new URL(process.env.THREADS_REMOTE_URL??'http://127.0.0.1:19759/mcp');
if((endpoint.protocol!=='https:'&&!(endpoint.protocol==='http:'&&endpoint.hostname==='127.0.0.1'))||endpoint.username||endpoint.password||endpoint.search)throw Error('Invalid endpoint');
const client=new Client({name:'controlled-write-noop-acceptance',version:'0.5.1'});
const driver=new RemoteExtensionDriver({dataDir:config.dataDir,port:Number(process.env.THREADS_BRIDGE_PORT??19758)});
const report:any={status:'FAIL',publicMutations:0,startedAt:new Date().toISOString()};let restore:string|undefined,phase='connect';
async function call(name:string,args:any={}){phase=name;const response=await client.callTool({name,arguments:args},undefined,{timeout:90000});if(response.isError){let code='REMOTE_FAILED';try{code=JSON.parse((response.content[0] as any).text).error;}catch{}throw Object.assign(new Error('Remote failed'),{code});}return response.structuredContent as any;}
try{
 await driver.connect();const page=await driver.command<any>({type:'read'});assert.ok(page.viewer.username);assert.ok(!page.composerState?.present);restore=page.url;
 const token=readFileSync(join(config.dataDir,'remote-access.token'),'utf8').trim();await client.connect(new StreamableHTTPClientTransport(endpoint,{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
 const list=await client.listTools();assert.equal(list.tools.length,18);report.tools=18;
 for(const name of ['threads_execute_action','threads_stage_media','threads_export','threads_get_feed','threads_run_schedules','threads_api_execute'])assert.ok(!list.tools.some(t=>t.name===name));
 const status=await call('threads_status');assert.equal(status.writesEnabled,true);assert.equal(status.remoteReadOnly,false);report.writesEnabled=true;
 const account=page.viewer.username;
 const own=await call('threads_get_profile',{username:account,provider:'direct',section:'posts',maxPages:1,pageSize:5});const target=own.items.find((p:any)=>p.code);assert.ok(target);
 const before=await call('threads_inspect_social',{kind:'like',targetUrl:target.url,expectedAccount:account});assert.ok(['like','unlike'].includes(before.state));
 const kind=before.state==='unlike'?'like':'unlike';
 const prepared=await call('threads_prepare_social',{kind,targetUrl:target.url,expectedAccount:account});
 phase='require-noop-before-execute';assert.equal(prepared.noop,true);assert.equal(prepared.account,account);assert.equal(prepared.request.targetUrl,target.url);
 const executed=await call('threads_execute_social',{id:prepared.id,expectedAccount:account});assert.equal(executed.outcome,'already-satisfied');assert.equal(executed.dispatch.noop,true);assert.equal(executed.dispatch.dispatched,false);report.noop={verified:true,dispatched:false,outcome:executed.outcome};
 const replay=await client.callTool({name:'threads_execute_social',arguments:{id:prepared.id,expectedAccount:account}});assert.equal(replay.isError,true);assert.equal(JSON.parse((replay.content[0] as any).text).error,'INVALID_ACTION');report.replayBlocked=true;
 const after=await call('threads_inspect_social',{kind:'like',targetUrl:target.url,expectedAccount:account});assert.equal(after.state,before.state);report.stateUnchanged=true;
 const next=await call('threads_get_profile',{username:account,provider:'direct',maxPages:2,pageSize:5});assert.equal(next.pagination.pagesFetched,2);report.nextRead={pages:next.pagination.pagesFetched,posts:next.items.length};report.status='PASS';
}catch(error){report.failedPhase=phase;report.errorCode=/^[A-Z_]+$/.test((error as any)?.code??'')?(error as any).code:'ACCEPTANCE_MISMATCH';process.exitCode=1;}
finally{
 await client.close();if(restore)try{await driver.command({type:'navigate',url:restore});const p=await driver.command<any>({type:'read'});assert.equal(p.url,restore);report.restored=true;report.visibility=p.visibilityState;}catch{report.restored=false;report.status='FAIL';process.exitCode=1;}
 await driver.close();report.finishedAt=new Date().toISOString();writeFileSync(join(config.dataDir,'controlled-write-smoke.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
