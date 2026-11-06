import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
const data=mkdtempSync(join(tmpdir(),'threads-mcp-smoke-'));
const client=new Client({name:'smoke-test',version:'1.0.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/cli.js'),'serve'],env:{...process.env as Record<string,string>,THREADS_PROVIDER:'dedicated',THREADS_DATA_DIR:data,THREADS_ALLOW_WRITES:'false',THREADS_API_ACCESS_TOKEN:'',THREADS_API_USER_ID:''},stderr:'pipe'});
try{
  await client.connect(transport);const list=await client.listTools();assert.equal(list.tools.length,44);
  const result=await client.callTool({name:'threads_status',arguments:{}});assert.ok(!result.isError);assert.equal((result.structuredContent as any).writesEnabled,false);
  const search=await client.callTool({name:'threads_search',arguments:{query:'測試',refresh:false,mode:'lexical'}});assert.ok(!search.isError);
  const research=await client.callTool({name:'threads_research',arguments:{query:'測試',sources:['local'],refresh:false,mode:'lexical'}});assert.ok(!research.isError);assert.equal((research.structuredContent as any).items.length,0);
  const mentions=await client.callTool({name:'threads_find_mentions',arguments:{username:'fixture',refresh:false}});assert.ok(!mentions.isError);assert.equal((mentions.structuredContent as any).state,'unknown');
  const denied=await client.callTool({name:'threads_execute_action',arguments:{actionId:'absent',expectedAccount:'test'}});assert.equal(denied.isError,true);
  const api=await client.callTool({name:'threads_api_status',arguments:{}});assert.equal((api.structuredContent as any).configured,false);
  for(const name of ['threads_execute_social','threads_stage_media','threads_run_schedules']){
    const args=name==='threads_execute_social'?{id:'absent',expectedAccount:'fixture'}:name==='threads_stage_media'?{paths:['C:/not-read.png'],expectedAccount:'fixture'}:{accountId:'fixture'};
    const result=await client.callTool({name,arguments:args});assert.equal(result.isError,true);assert.match(JSON.stringify(result.content),/WRITES_DISABLED/);
  }
  const draft=await client.callTool({name:'threads_save_draft',arguments:{accountId:'fixture',draft:{text:'offline scheduled draft'}}});assert.ok(!draft.isError);
  const scheduled=await client.callTool({name:'threads_stage_schedule',arguments:{accountId:'fixture',draftIds:[(draft.structuredContent as any).id],at:'2099-01-01T08:00:00+08:00'}});assert.ok(!scheduled.isError);assert.equal((scheduled.structuredContent as any).status,'staged');
  const cancelled=await client.callTool({name:'threads_cancel_schedule',arguments:{accountId:'fixture',id:(scheduled.structuredContent as any).id}});assert.equal((cancelled.structuredContent as any).status,'cancelled');
  console.log(JSON.stringify({status:'PASS',protocol:'stdio',tools:list.tools.map(t=>t.name),checks:['initialize','tools/list','status','empty-local-search','scoped-research','mentions-unknown','write-guard']}));
}finally{await client.close();rmSync(data,{recursive:true,force:true});}
