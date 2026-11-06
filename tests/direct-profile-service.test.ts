import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {ThreadsService} from '../src/service.js';
import {SearchIndex} from '../src/search.js';
import {normalizePost} from '../src/parser.js';
import {getConfig} from '../src/config.js';
import {RemoteReadDriver,startRemoteHttp} from '../src/http-server.js';
import {REMOTE_READ_TOOLS} from '../src/server.js';

function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'threads-direct-service-')),calls:Record<string,unknown>[]=[];
 const post=normalizePost({pk:'123',code:'TEST',user:{username:'alice',pk:'42'},caption:{text:'Public post'}},'profile-direct')!;
 let fail=false,foreign=false;
 const driver={status:()=>({connected:true}),close:async()=>{},command:async<T>(c:Record<string,unknown>)=>{
  calls.push(c);if(c.type==='navigate')return {} as T;
  if(c.type==='direct_profile'){
   if(fail)throw Object.assign(new Error('Direct unavailable'),{code:'DIRECT_UNAVAILABLE'});
   return {profile:null,items:[post],contextualPosts:[],sourceUrl:foreign?'https://www.threads.com/@bob':'https://www.threads.com/@alice',observedAt:post.observedAt,completeness:'partial',warnings:[],pagination:{provider:'direct',pagesFetched:3,requests:2,uniquePosts:1,hasNext:true,stopReason:'page-limit',pages:[]}} as T;
  }
  throw Error('Unexpected browser command');
 }};
 const service=new ThreadsService(new RemoteReadDriver(driver),new SearchIndex(dir),{...getConfig(),dataDir:dir,writesEnabled:false});
 return {service,calls,setFail:()=>fail=true,setForeign:()=>foreign=true,close:async()=>{await service.close();rmSync(dir,{recursive:true,force:true});}};
}
test('direct profile uses only navigation plus typed read and never falls back to scrolling',async()=>{
 const f=fixture();try{
  const result=await f.service.profile('alice','posts',10,{provider:'direct',maxPages:3,pageSize:5});
  assert.equal(result.items.length,1);assert.deepEqual(f.calls,[{type:'navigate',url:'https://www.threads.com/@alice'},{type:'direct_profile',username:'alice',maxPages:3,pageSize:5}]);
  await assert.rejects(f.service.profile('alice','replies',0,{provider:'direct'}),{code:'INVALID_INPUT'});
  f.setFail();await assert.rejects(f.service.profile('alice','posts',0,{provider:'direct'}),{code:'DIRECT_UNAVAILABLE'});assert.ok(!f.calls.some(c=>c.type==='scroll'));
 }finally{await f.close();}
});
test('foreign direct source is rejected before indexing',async()=>{
 const f=fixture();try{f.setForeign();await assert.rejects(f.service.profile('alice','posts',0,{provider:'direct'}),{code:'SOURCE_CHANGED'});assert.equal((await f.service.search({query:'Public',refresh:false,rounds:0,mode:'lexical',limit:5})).items.length,0);}finally{await f.close();}
});
test('authenticated remote MCP exposes direct provider on existing profile tool with exactly15 read tools',async()=>{
 const f=fixture(),token='a'.repeat(43),http=await startRemoteHttp(f.service,{port:0,readToken:()=>token});
 const client=new Client({name:'direct-profile-test',version:'1'});
 try{
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(http.address() as any).port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
  const list=await client.listTools();assert.equal(list.tools.length,15);assert.deepEqual(new Set(list.tools.map(t=>t.name)),REMOTE_READ_TOOLS);
  const profile=list.tools.find(t=>t.name==='threads_get_profile')!;assert.ok((profile.inputSchema.properties as any).provider);
  const response=await client.callTool({name:'threads_get_profile',arguments:{username:'alice',provider:'direct',maxPages:3,pageSize:5}});
  assert.ok(!response.isError);assert.equal((response.structuredContent as any).pagination.pagesFetched,3);
  const invalid=await client.callTool({name:'threads_get_profile',arguments:{username:'alice',provider:'direct',maxPages:6}});assert.equal(invalid.isError,true);
  const privateSection=await client.callTool({name:'threads_get_profile',arguments:{username:'alice',section:'replies',provider:'direct'}});assert.equal(privateSection.isError,true);
 }finally{await client.close();await new Promise<void>(resolve=>http.close(()=>resolve()));await f.close();}
});
