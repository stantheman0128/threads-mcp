import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {REMOTE_READ_TOOLS} from '../src/server.js';

const data=resolve(process.env.THREADS_DATA_DIR??'.threads-data');
const endpoint=process.env.THREADS_REMOTE_URL??'http://127.0.0.1:19759/mcp';
const token=readFileSync(join(data,'remote-access.token'),'utf8').trim();
const client=new Client({name:'threads-remote-acceptance',version:'1.0.0'});
const report:Record<string,unknown>={endpoint,startedAt:new Date().toISOString(),status:'FAIL'};
try{
  const anonymous=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(15000)});assert.equal(anonymous.status,401);report.unauthorizedStatus=anonymous.status;
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint),{requestInit:{headers:{Authorization:`Bearer ${token}`}},reconnectionOptions:{maxRetries:0}}));
  const list=await client.listTools();assert.deepEqual(new Set(list.tools.map(x=>x.name)),REMOTE_READ_TOOLS);report.toolCount=list.tools.length;
  const status=await client.callTool({name:'threads_status',arguments:{}});assert.ok(!status.isError);assert.equal((status.structuredContent as any).writesEnabled,false);report.writesEnabled=false;
  await assert.rejects(client.callTool({name:'threads_execute_action',arguments:{}}),/not found/);report.writeToolAbsent=true;
  const search=await client.callTool({name:'threads_search',arguments:{query:'MCP',refresh:false,mode:'lexical'}});assert.ok(!search.isError);report.localSearch=true;
  if(process.env.THREADS_HTTP_LIVE==='true'){
    const first=await client.callTool({name:'threads_my_activity',arguments:{kind:'posts',rounds:0}},undefined,{timeout:90000});
    if(first.isError)throw new Error(JSON.stringify(first.content));const activity=first.structuredContent as any;
    assert.ok(activity.account);report.accountObserved=true;report.ownPosts=activity.items.length;
    const second=await client.callTool({name:'threads_get_profile',arguments:{username:activity.account,rounds:0}},undefined,{timeout:90000});
    if(second.isError)throw new Error(JSON.stringify(second.content));report.nextReadPosts=(second.structuredContent as any).items.length;
    report.completeness='partial';report.liveRead=true;
  }
  report.status='PASS';
}catch(error){report.error=error instanceof Error?error.message:'Remote acceptance failed';process.exitCode=1;}
finally{await client.close();report.finishedAt=new Date().toISOString();writeFileSync(join(data,'http-smoke.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report,null,2));}
