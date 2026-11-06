import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {getConfig} from '../src/config.js';
const config=getConfig();
const client=new Client({name:'live-capability-test',version:'1.0.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/cli.js'),'serve'],env:{...process.env as Record<string,string>,THREADS_PROVIDER:'extension',THREADS_DATA_DIR:config.dataDir,THREADS_ALLOW_WRITES:'false'},stderr:'pipe'});
const report:{startedAt:string;status:string;socialWritesPerformed:boolean;notificationViewOpened:boolean;checks:Record<string,unknown>;finishedAt?:string}={startedAt:new Date().toISOString(),status:'BLOCKED',socialWritesPerformed:false,notificationViewOpened:false,checks:{}};
async function call(name:string,args:Record<string,unknown>){
  const result=await client.callTool({name,arguments:args},undefined,{timeout:180000});
  if(result.isError)throw new Error(JSON.stringify(result.content));
  return result.structuredContent as any;
}
async function check(name:string,run:()=>Promise<unknown>){try{const result=await run();report.checks[name]={status:'PASS',result};console.log(JSON.stringify({check:name,result}));}catch(error){report.checks[name]={status:'FAIL',error:String(error)};console.log(JSON.stringify({check:name,error:String(error)}));}}
try{
  await client.connect(transport);const status=await call('threads_status',{});
  if(!status.browser.connected)throw new Error('The browser extension is not connected.');
  const list=await client.listTools();report.checks.protocol={status:'PASS',tools:list.tools.length};
  const page=await call('threads_read_page',{});const account=page.viewer.username;
  if(!account)throw new Error('Signed-in account could not be established.');
  for(const kind of ['posts','replies','liked','saved'])await check(kind,async()=>{
    const result=await call('threads_my_activity',{kind,rounds:0,expectedAccount:account});
    if(!result.sourceUrl)throw new Error('No source provenance.');
    return {observed:result.items.length,collection:result.collection,sourceUrl:result.sourceUrl,completeness:result.completeness,warnings:result.warnings};
  });
  await check('notifications',async()=>{
    report.notificationViewOpened=true;
    const result=await call('threads_get_notifications',{rounds:0});
    return {visibleTextCharacters:result.visibleText?.length??0,associatedPosts:result.items.length,sourceUrl:result.sourceUrl,completeness:result.completeness};
  });
  await check('scoped-semantic-research',async()=>{
    const result=await call('threads_research',{query:'開源專案維護者有機會免費使用付費的人工智慧方案嗎',sources:['my_posts','my_replies','liked'],account,refresh:false,mode:'hybrid',limit:5,maxPerAuthor:2});
    if(!result.items.length||/fallback/i.test(result.method))throw new Error('No actual scoped embedding results.');
    return {method:result.method,corpusSize:result.corpusSize,results:result.items.map((x:any)=>({url:x.post.url,score:x.score,lexicalScore:x.lexicalScore,semanticScore:x.semanticScore,observedCollections:x.observedCollections})),warnings:result.warnings};
  });
  await check('mentions',async()=>{
    const result=await call('threads_find_mentions',{username:account,refresh:true,rounds:0,limit:5});
    return {state:result.state,observedCandidates:result.items.length,kinds:result.items.map((x:any)=>x.mentionKind),discovery:result.discoveries};
  });
  report.status=Object.values(report.checks).every((x:any)=>x.status==='PASS')?'PASS':'PARTIAL';
}catch(error){report.checks.connection={status:'FAIL',error:String(error)};}
finally{report.finishedAt=new Date().toISOString();writeFileSync(join(config.dataDir,'research-live-smoke.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,finishedAt:report.finishedAt}));await client.close();if(report.status!=='PASS')process.exitCode=2;}
