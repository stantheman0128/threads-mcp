import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {request as httpRequest} from 'node:http';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {startRemoteHttp,ensureRemoteToken,changeRemoteToken,RemoteReadDriver} from '../src/http-server.js';
import {ThreadsService} from '../src/service.js';
import {SearchIndex} from '../src/search.js';
import {REMOTE_READ_TOOLS} from '../src/server.js';

test('authenticated HTTP MCP has an enforced read allowlist, redaction, bounds and token revocation',async()=>{
  const data=mkdtempSync(join(tmpdir(),'threads-http-'));let token=randomBytes(32).toString('base64url');
  const service=new ThreadsService({status:()=>({connected:true,pairingUrl:'PRIVATE_PAIRING',tab:{title:'PRIVATE_TITLE'}}),command:async()=>{throw new Error('PRIVATE_FILESYSTEM_PATH');},close:async()=>{}},new SearchIndex(data),{dataDir:data,profileDir:data,channel:'chrome',headless:true,writesEnabled:false,timeoutMs:100,minActionIntervalMs:0});
  const http=await startRemoteHttp(service,{port:0,readToken:()=>token});const address=http.address() as {port:number};const url=`http://127.0.0.1:${address.port}/mcp`;
  const raw=(body:unknown,headers:Record<string,string>={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream',Authorization:`Bearer ${token}`,...headers},body:JSON.stringify(body)});
  const client=new Client({name:'remote-test',version:'1'});
  try{
    const path=ensureRemoteToken(data);const first=readFileSync(path,'utf8');assert.equal(ensureRemoteToken(data),path);assert.equal(readFileSync(path,'utf8'),first);assert.notEqual(first,token);
    for(const method of ['GET','POST','DELETE'])assert.equal((await fetch(url,{method})).status,401);
    assert.equal((await fetch(url.replace('/mcp','/healthz'))).status,401);
    const health=await fetch(url.replace('/mcp','/healthz'),{headers:{Authorization:`Bearer ${token}`}});assert.equal(health.status,200);assert.equal((await health.json() as any).service,'threads-mcp-readonly');
    assert.equal((await raw({}, {Authorization:'Bearer wrong'})).status,401);
    assert.equal((await raw({}, {Origin:'https://untrusted.example'})).status,403);
    const badHost=await new Promise<number|undefined>((resolve,reject)=>{const req=httpRequest(url,{method:'POST',headers:{Host:'untrusted.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end('{}');});assert.equal(badHost,403);
    assert.equal((await raw([{jsonrpc:'2.0',id:1,method:'tools/list'}])).status,400);
    assert.equal((await raw({data:'x'.repeat(65536)})).status,413);
    assert.equal((await fetch(url+'?token=not-accepted',{headers:{Authorization:`Bearer ${token}`}})).status,404);
    await client.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
    const list=await client.listTools();assert.deepEqual(new Set(list.tools.map(t=>t.name)),REMOTE_READ_TOOLS);
    const status=await client.callTool({name:'threads_status',arguments:{}});assert.equal((status.structuredContent as any).writesEnabled,false);assert.doesNotMatch(JSON.stringify(status),/PRIVATE_|pairingUrl|"tab"/);
    const search=await client.callTool({name:'threads_search',arguments:{query:'test',refresh:false,mode:'lexical'}});assert.ok(!search.isError);
    for(const name of ['threads_execute_action','threads_prepare_social','threads_stage_media','threads_get_feed','threads_read_page','threads_list_drafts','threads_api_read']){
      await assert.rejects(client.callTool({name,arguments:{}}),/not found/,name);
    }
    const failed=await client.callTool({name:'threads_get_profile',arguments:{username:'fixture',rounds:0}});assert.equal(failed.isError,true);assert.doesNotMatch(JSON.stringify(failed),/PRIVATE_FILESYSTEM_PATH/);
    const old=token;token=randomBytes(32).toString('base64url');assert.equal((await raw({}, {Authorization:`Bearer ${old}`})).status,401);
  }finally{await client.close();await new Promise<void>(resolve=>http.close(()=>resolve()));await service.close();rmSync(data,{recursive:true,force:true});}
});

test('remote driver blocks writes and private routes before navigation, rejects private read before indexing',async()=>{
  let calls=0;const driver=new RemoteReadDriver({status:()=>({}),command:async()=>{calls++;return {url:'https://www.threads.com/messages/',text:'private'} as any;},close:async()=>{}});
  for(const c of [{type:'interact'},{type:'social'},{type:'navigate',url:'https://www.threads.com/messages/'},{type:'navigate',url:'https://evil.example/'}])await assert.rejects(driver.command(c),/Unsupported/);
  assert.equal(calls,0);await assert.rejects(driver.command({type:'read'}),/outside/);assert.equal(calls,1);
});

test('remote whole-request lock prevents nested read flows from interleaving; discover omits page text',async()=>{
  const data=mkdtempSync(join(tmpdir(),'threads-http-lock-'));const token=randomBytes(32).toString('base64url');let release!:()=>void;let started!:()=>void;
  const ready=new Promise<void>(r=>started=r);const hold=new Promise<void>(r=>release=r);
  const service=new ThreadsService({status:()=>({}),command:async()=>({}) as any,close:async()=>{}},new SearchIndex(data),{dataDir:data,profileDir:data,channel:'chrome',headless:true,writesEnabled:false,timeoutMs:100,minActionIntervalMs:0});
  service.discover=(async()=>{started();await hold;return {posts:[],pages:[{text:'PRIVATE_PAGE_TEXT'}],sourceUrl:'https://www.threads.com/search',observedAt:'2026-11-06T00:00:00Z',completeness:'partial',warnings:[]};}) as any;
  const http=await startRemoteHttp(service,{port:0,readToken:()=>token});const url=`http://127.0.0.1:${(http.address() as any).port}/mcp`;
  const request=(method:string,params:any={})=>fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  try{
    const pending=request('tools/call',{name:'threads_discover',arguments:{query:'test'}});await ready;
    const busyHealth=await fetch(url.replace('/mcp','/healthz'),{headers:{Authorization:`Bearer ${token}`}});assert.equal((await busyHealth.json() as any).busy,true);
    assert.equal((await request('tools/list')).status,429);release();const response=await pending;assert.equal(response.status,200);assert.doesNotMatch(await response.text(),/PRIVATE_PAGE_TEXT|pages/);
    assert.equal((await request('tools/list')).status,200);
  }finally{release();await new Promise<void>(resolve=>http.close(()=>resolve()));await service.close();rmSync(data,{recursive:true,force:true});}
});

test('deleted remote token stays revoked through restarts, explicit rotation restores access',async()=>{
  const data=mkdtempSync(join(tmpdir(),'threads-http-revoke-'));
  const service=new ThreadsService({status:()=>({}),command:async()=>({}) as any,close:async()=>{}},new SearchIndex(data),{dataDir:data,profileDir:data,channel:'chrome',headless:true,writesEnabled:false,timeoutMs:100,minActionIntervalMs:0});
  const path=ensureRemoteToken(data);const old=readFileSync(path,'utf8');let http:Awaited<ReturnType<typeof startRemoteHttp>>|undefined;
  try{
    rmSync(path);assert.equal(ensureRemoteToken(data),path);assert.equal(existsSync(path),false);
    http=await startRemoteHttp(service,{port:0,readToken:()=>readFileSync(path,'utf8').trim()});
    const url=`http://127.0.0.1:${(http.address() as any).port}/healthz`;
    assert.equal((await fetch(url,{headers:{Authorization:`Bearer ${old}`}})).status,503);
    changeRemoteToken(data,'rotate');const fresh=readFileSync(path,'utf8');assert.notEqual(fresh,old);
    assert.equal((await fetch(url,{headers:{Authorization:`Bearer ${old}`}})).status,401);
    assert.equal((await fetch(url,{headers:{Authorization:`Bearer ${fresh}`}})).status,200);
    writeFileSync(path,'invalid');assert.equal(ensureRemoteToken(data),path);assert.equal(readFileSync(path,'utf8'),'invalid');
    assert.equal((await fetch(url,{headers:{Authorization:`Bearer ${fresh}`}})).status,503);
    changeRemoteToken(data,'revoke');assert.equal((await fetch(url,{headers:{Authorization:`Bearer ${fresh}`}})).status,503);
  }finally{await new Promise<void>(resolve=>http?http.close(()=>resolve()):resolve());await service.close();rmSync(data,{recursive:true,force:true});}
});

test('remote threads_status refreshes dependency health without reading a page or leaking local details',async()=>{
  const data=mkdtempSync(join(tmpdir(),'threads-http-health-'));const token=randomBytes(32).toString('base64url');let state='host-unreachable';let commands=0;
  const driver={status:()=>({connected:true,tab:{title:'PRIVATE_TITLE'}}),refreshStatus:async()=>({connected:state==='connected',tab:{title:'PRIVATE_TITLE'},pairingUrl:'PRIVATE_PAIRING',health:{state,checkedAt:new Date().toISOString()}}),command:async()=>{commands++;return {} as any;},close:async()=>{}};
  const service=new ThreadsService(new RemoteReadDriver(driver),new SearchIndex(data),{dataDir:data,profileDir:data,channel:'chrome',headless:true,writesEnabled:false,timeoutMs:100,minActionIntervalMs:0});
  const http=await startRemoteHttp(service,{port:0,readToken:()=>token});const client=new Client({name:'health-test',version:'1'});
  try{
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(http.address() as any).port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
    for(const next of ['host-unreachable','extension-disconnected','connected']){state=next;const response=await client.callTool({name:'threads_status',arguments:{}});const result=response.structuredContent as any;assert.equal(result.health.bridge.state,next);assert.equal(result.browser.connected,next==='connected');assert.doesNotMatch(JSON.stringify(response),/PRIVATE_/);}
    assert.equal(commands,0);
  }finally{await client.close();await new Promise<void>(resolve=>http.close(()=>resolve()));await service.close();rmSync(data,{recursive:true,force:true});}
});
