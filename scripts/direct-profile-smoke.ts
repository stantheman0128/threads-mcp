import assert from 'node:assert/strict';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {getConfig} from '../src/config.js';
import {RemoteExtensionDriver} from '../src/remote-driver.js';

// Opt-in real-account reads only. Reports contain counts, never session data or cursors.
const config=getConfig();
const expectedWrites=process.env.THREADS_HTTP_EXPECT_WRITES==='true';
const url=new URL(process.env.THREADS_REMOTE_URL??'http://127.0.0.1:19759/mcp');
if(url.protocol!=='https:'&&!(url.protocol==='http:'&&url.hostname==='127.0.0.1'))throw Error('HTTPS or local loopback required.');
if(url.username||url.password||url.search||url.hash)throw Error('Endpoint must not contain credentials, query or fragment.');
const target=process.env.THREADS_DIRECT_USERNAME??'threads';
if(!/^[A-Za-z0-9_.]{1,30}$/.test(target))throw Error('Invalid target username.');
const client=new Client({name:'direct-profile-acceptance',version:'0.5.0'});
const driver=new RemoteExtensionDriver({dataDir:config.dataDir,port:Number(process.env.THREADS_BRIDGE_PORT??19758)});
const report:any={status:'BLOCKED',transport:url.protocol==='https:'?'https':'loopback',startedAt:new Date().toISOString(),publicMutations:0,checks:[]};
let originalRoute:string|undefined;
try{
 await driver.connect();const initial=await driver.command<any>({type:'read'});
 assert.equal(initial.extensionVersion,'0.5.0');assert.equal(initial.runtimeVersion,'0.5.0');
 assert.ok(initial.viewer.username);assert.ok(!initial.composerState?.present);originalRoute=initial.url;
 const token=readFileSync(join(config.dataDir,'remote-access.token'),'utf8').trim();
 await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
 const list=await client.listTools();assert.equal(list.tools.length,expectedWrites?18:15);
 assert.ok(!list.tools.some(t=>/execute_action|browser|messages|export/.test(t.name)));
 const status=await client.callTool({name:'threads_status',arguments:{}});assert.equal((status.structuredContent as any).writesEnabled,expectedWrites);
 for(const [label,username,maxPages] of [['public-profile',target,4],['next-cycle',initial.viewer.username,3]] as const){
  const response=await client.callTool({name:'threads_get_profile',arguments:{username,provider:'direct',section:'posts',maxPages,pageSize:5}},undefined,{timeout:90000});
  if(response.isError){report.checks.push({label,toolError:response.content});throw Error('TOOL_FAILED');}const data=response.structuredContent as any;
  report.checks.push({label,pagination:data.pagination,count:data.items?.length,authorMatched:data.items?.every((p:any)=>p.author.username.toLowerCase()===username.toLowerCase()),idsUnique:new Set(data.items?.map((p:any)=>p.id)).size===data.items?.length});
  assert.equal(data.pagination.provider,'direct');assert.equal(data.completeness,'partial');
  assert.equal(data.pagination.pagesFetched,maxPages);assert.equal(data.pagination.requests,maxPages-1);
  assert.ok(data.pagination.pages.slice(1).every((p:any)=>p.added>0&&p.cursorAdvanced===true));
  assert.equal(new Set(data.items.map((p:any)=>p.id)).size,data.items.length);
  assert.ok(data.items.every((p:any)=>p.author.username.toLowerCase()===username.toLowerCase()&&p.source==='profile-direct'));

  console.log(JSON.stringify({check:label,pages:data.pagination.pagesFetched,posts:data.items.length,stopReason:data.pagination.stopReason}));
 }
 report.status='PASS';
}catch(error){report.status='FAIL';report.errorCode=(error as any)?.code==='ERR_ASSERTION'?'ACCEPTANCE_MISMATCH':/^[A-Z_]+$/.test((error as any)?.code??'')?(error as any).code:'READ_FAILED';process.exitCode=1;}
finally{
 await client.close();
 if(originalRoute)try{await driver.command({type:'navigate',url:originalRoute});const restored=await driver.command<any>({type:'read'});report.restored=restored.url===originalRoute;report.runtime=restored.runtimeVersion;report.extension=restored.extensionVersion;report.visibility=restored.visibilityState;if(!report.restored)throw Error();}catch{report.restoreFailed=true;report.status='FAIL';process.exitCode=1;}
 await driver.close();report.finishedAt=new Date().toISOString();writeFileSync(join(config.dataDir,'direct-profile-smoke.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
