import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {ThreadsService} from '../src/service.js';
import {SearchIndex} from '../src/search.js';
import {getConfig} from '../src/config.js';
import {startRemoteHttp,RemoteReadDriver} from '../src/http-server.js';
import {ThreadsError} from '../src/types.js';

// Valid one-pixel PNG; the browser implementation is verified separately in an
// intercepted Chrome fixture. This fixture exercises the actual MCP transports.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const target='https://www.threads.com/';
const account='fixture';
const metadata={name:'test.png',mime:'image/png',size:png.length,sha256:createHash('sha256').update(png).digest('hex')};
const unpack=(value:any)=>{assert.ok(!value.isError,JSON.stringify(value.content));return value.structuredContent as any;};
const code=(value:any)=>JSON.parse(value.content[0].text).error;
const call=(client:Client,name:string,args:any)=>client.callTool({name,arguments:args},undefined,{timeout:30_000});

async function fixture(media=true,writes=true){
 const dir=mkdtempSync(join(tmpdir(),'threads-http-media-'));let bearer='x'.repeat(43),url=target,accountName=account,attached=false,text='',committed=false,uncertain=false;
 const commands:any[]=[];const received:Buffer[]=[];let heldOperation:string|undefined,entered:(()=>void)|undefined,release:(()=>void)|undefined,hold:Promise<void>|undefined;
 const raw={status:()=>({connected:true,health:{state:'connected',checkedAt:new Date().toISOString()}}),close:async()=>{},command:async<T>(c:any)=>{
  commands.push(c);
  if(heldOperation&&c.operation===heldOperation){entered!();await hold;heldOperation=undefined;}
  if(c.type==='read')return {runtimeVersion:'0.6.0',extensionVersion:'0.6.0',remoteMediaVersion:1,url,viewer:{username:accountName},posts:[],profiles:[],replies:[],warnings:[],observedAt:new Date().toISOString(),composerState:{present:attached,attachments:attached,nonempty:!!text,ambiguous:false}} as T;
  if(c.type==='navigate'){url=c.url;return {url} as T;}
  if(c.type==='media'){
   if(c.operation==='begin'){assert.deepEqual(c.compose,{kind:'publish',targetUrl:target});return {uploadId:randomUUID()} as T;}
   if(c.operation==='chunk'){received.push(Buffer.from(c.data,'base64'));return {received:received.reduce((n,b)=>n+b.length,0),fileIndex:0} as T;}
   if(c.operation==='finish'){attached=true;if(uncertain)throw new ThreadsError('BRIDGE_TIMEOUT','private diagnostics');return {status:'staged',mediaToken:randomUUID(),fileCount:1,files:['test.png'],published:false,previewReady:null,warning:'fixture'} as T;}
   if(c.operation==='abort')return {aborted:true} as T;
  }
  if(c.type==='social'){
   const before={account:accountName,url,targetUrl:target,state:committed?'publication-observed-media-unverified':'draft',verified:false,evidence:[]};
   if(c.operation==='stage'){assert.equal(attached,true);assert.ok(c.request.mediaToken);text=c.request.text;return {token:randomUUID(),account:accountName,url,request:c.request,before,noop:false} as T;}
   if(c.operation==='commit'){committed=true;attached=false;text='';return {dispatched:true,noop:false} as T;}
   return before as T;
  }
  throw Error('Unexpected fixture command');
 }};
 const service=new ThreadsService(new RemoteReadDriver(raw),new SearchIndex(dir),{...getConfig(),dataDir:dir,writesEnabled:writes,minActionIntervalMs:0});
 const http=await startRemoteHttp(service,{port:0,readToken:()=>bearer,controlledWrites:writes,controlledMedia:media,socialDriver:writes?raw:undefined});
 const endpoint=new URL(`http://127.0.0.1:${(http.address() as any).port}/mcp`);const clients:Client[]=[];
 const connect=async()=>{const c=new Client({name:'media-fixture',version:'1'});clients.push(c);await c.connect(new StreamableHTTPClientTransport(endpoint,{requestInit:{headers:{Authorization:`Bearer ${bearer}`}}}));return c;};
 const client=await connect();
 return {client,connect,dir,endpoint,commands,received,token:()=>bearer,rotate:()=>bearer='y'.repeat(43),account:(name:string)=>accountName=name,uncertain:()=>uncertain=true,
  pause:(op:string)=>{heldOperation=op;const ready=new Promise<void>(r=>entered=r);hold=new Promise<void>(r=>release=r);return {ready,release:()=>release!()};},
  close:async()=>{for(const c of clients)await c.close();http.closeAllConnections();await new Promise<void>(r=>http.close(()=>r()));await service.close();assert.equal(dirname(dir),tmpdir());rmSync(dir,{recursive:true,force:true});}};
}
async function upload(client:Client){
 const uploadId=randomUUID();const stage=(operation:string,args:any={})=>call(client,'threads_stage_media_remote',{operation,uploadId,expectedAccount:account,...args});
 unpack(await stage('begin',{kind:'publish',targetUrl:target,files:[metadata]}));
 unpack(await stage('chunk',{fileIndex:0,offset:0,data:png.toString('base64')}));
 return {uploadId,stage};
}

test('remote defaults remain 15/18 and media needs both opt-ins',async()=>{
 for(const writes of [false,true]){const f=await fixture(false,writes);try{
  assert.equal((await f.client.listTools()).tools.length,writes?18:15);
  assert.equal(unpack(await call(f.client,'threads_status',{})).mediaEnabled,false);
  await assert.rejects(call(f.client,'threads_stage_media_remote',{}),/not found/);
  await assert.rejects(call(f.client,'threads_stage_media',{paths:['C:\\secret.png'],expectedAccount:account}),/not found/);
 }finally{await f.close();}}
 const dir=mkdtempSync(join(tmpdir(),'threads-media-mode-'));
 const service=new ThreadsService({status:()=>({connected:false}),command:async()=>{throw Error('unused');},close:async()=>{}},new SearchIndex(dir),{...getConfig(),dataDir:dir,writesEnabled:false});
 try{await assert.rejects(startRemoteHttp(service,{port:0,readToken:()=>'',controlledMedia:true}),/requires explicitly enabled/);}
 finally{await service.close();rmSync(dir,{recursive:true,force:true});}
});

test('HTTP byte upload -> status -> review preparation -> execute once preserves exact bytes',async()=>{
 const f=await fixture();try{
  assert.equal((await f.client.listTools()).tools.length,19);
  const status=unpack(await call(f.client,'threads_status',{}));assert.equal(status.writesEnabled,true);assert.equal(status.mediaEnabled,true);
  const u=await upload(f.client);const staged=unpack(await u.stage('finish'));
  assert.equal(staged.published,false);assert.equal(staged.previewReady,null);assert.ok(staged.mediaToken);
  assert.deepEqual(Buffer.concat(f.received),png);
  const recovered=unpack(await u.stage('status'));assert.equal(JSON.stringify(recovered).includes(staged.mediaToken),true);
  assert.equal((await u.stage('finish')).isError,true);
  const prepared=unpack(await call(f.client,'threads_prepare_social',{kind:'publish',targetUrl:target,expectedAccount:account,text:'Approved fixture caption',mediaToken:staged.mediaToken}));
  assert.equal(prepared.request.mediaToken,staged.mediaToken);assert.equal(prepared.published,false);assert.ok(prepared.id);
  const result=unpack(await call(f.client,'threads_execute_social',{id:prepared.id,expectedAccount:account}));assert.equal(result.outcome,'outcome-uncertain');assert.equal(result.dispatch.dispatched,true);assert.equal(result.after.state,'publication-observed-media-unverified');
  assert.equal(code(await call(f.client,'threads_execute_social',{id:prepared.id,expectedAccount:account})),'INVALID_ACTION');
  assert.equal(f.commands.filter(c=>c.type==='social'&&c.operation==='commit').length,1);
  assert.equal(f.commands.filter(c=>c.type==='media'&&c.operation==='finish').length,1);
  for(const denied of ['threads_stage_media','threads_execute_action','threads_api_execute','threads_export'])await assert.rejects(call(f.client,denied,{}),/not found/);
 }finally{await f.close();}
});

test('HTTP uncertain finish stays checkable and nonreplayable with no raw diagnostics',async()=>{
 const f=await fixture();try{
  const u=await upload(f.client);f.uncertain();const result=await u.stage('finish');assert.doesNotMatch(JSON.stringify(result),/private diagnostics/);
  assert.match(JSON.stringify(await u.stage('status')),/outcome-uncertain/);
  assert.equal((await u.stage('finish')).isError,true);
  assert.equal(f.commands.filter(c=>c.operation==='finish').length,1);
 }finally{await f.close();}
});

test('finish holds one-request lock; health remains cached; revocation halts before file assignment',async()=>{
 const f=await fixture();try{
  const u=await upload(f.client);const pause=f.pause('chunk');const finishing=u.stage('finish');await pause.ready;
  const headers={Authorization:`Bearer ${f.token()}`};
  const health=await fetch(new URL('/healthz',f.endpoint),{headers});const body=await health.json() as any;
  assert.equal(body.busy,true);assert.equal(body.mediaEnabled,true);assert.equal(body.bridge.state,'connected');
  const blocked=await fetch(f.endpoint,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}'});assert.equal(blocked.status,429);
  f.rotate();pause.release();await finishing;
  assert.equal(f.commands.filter(c=>c.operation==='finish').length,0);
  const c=await f.connect();const result=await call(c,'threads_stage_media_remote',{operation:'status',uploadId:u.uploadId,expectedAccount:account});
  assert.doesNotMatch(JSON.stringify(result),/private diagnostics|remote-access|pairing/);
 }finally{await f.close();}
});

test('actual mcp-remote header-file carries byte chunks and reviewed execution in fixture', {skip:process.env.THREADS_MEDIA_PROXY_TEST!=='true'},async()=>{
 const f=await fixture();let client:Client|undefined;
 try{
  const dependency=resolve('.threads-data/mcp-remote-check/node_modules/mcp-remote');
  assert.equal(JSON.parse(readFileSync(join(dependency,'package.json'),'utf8')).version,'0.16.1');
  const privateDir=join(f.dir,'remote-media');mkdirSync(privateDir,{recursive:true}); // controller applies private ACL before begin; synthetic fixture bearer only.
  const header=join(privateDir,'fixture-headers.txt');writeFileSync(header,`Authorization: Bearer ${f.token()}\n`,{mode:0o600});
  const transport=new StdioClientTransport({command:process.execPath,args:[join(dependency,'dist/proxy.js'),f.endpoint.href,'--allow-http','--header-file',header,'--transport','http-only','--silent'],cwd:f.dir,env:{MCP_REMOTE_CONFIG_DIR:join(f.dir,'proxy-auth'),NO_COLOR:'1',NODE_NO_WARNINGS:'1'},stderr:'pipe'});
  transport.stderr?.on('data',()=>{});
  client=new Client({name:'media-proxy-fixture',version:'1'});await client.connect(transport,{timeout:15000});
  assert.equal((await client.listTools()).tools.length,19);
  const u=await upload(client);const staged=unpack(await u.stage('finish'));
  const prepared=unpack(await call(client,'threads_prepare_social',{kind:'publish',targetUrl:target,expectedAccount:account,text:'Proxy fixture caption',mediaToken:staged.mediaToken}));
  const executed=unpack(await call(client,'threads_execute_social',{id:prepared.id,expectedAccount:account}));assert.equal(executed.outcome,'outcome-uncertain');assert.equal(executed.dispatch.dispatched,true);
  assert.equal((await call(client,'threads_execute_social',{id:prepared.id,expectedAccount:account})).isError,true);
  assert.deepEqual(Buffer.concat(f.received),png);
 }finally{await client?.close();await f.close();}
});
