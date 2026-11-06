import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {getConfig} from '../src/config.js';
import {RemoteExtensionDriver} from '../src/remote-driver.js';
import {ThreadsService} from '../src/service.js';
import {SearchIndex} from '../src/search.js';

// Uses only the already paired tab. Never activates a tab, starts a host, or reconnects it.
const config=getConfig();
const driver=new RemoteExtensionDriver({dataDir:config.dataDir});
const service=new ThreadsService(driver,new SearchIndex(config.dataDir),config);
const report:{startedAt:string;status:string;writesPerformed:boolean;checks:Record<string,unknown>;backgroundObservations:{check:string;before:string;after:string;url:string}[];backgroundStatus:string;finishedAt?:string}={startedAt:new Date().toISOString(),status:'BLOCKED',writesPerformed:false,checks:{},backgroundObservations:[],backgroundStatus:'UNVERIFIED'};
async function check(name:string,run:()=>Promise<unknown>){
  try{const before=await service.browserRead();const result=await run();const page=await service.browserRead();report.backgroundObservations.push({check:name,before:(before as any).visibilityState??'unavailable',after:(page as any).visibilityState??'unavailable',url:page.url});report.checks[name]={status:'PASS',result};console.log(JSON.stringify({check:name,result}));}
  catch(error){report.checks[name]={status:'FAIL',error:String(error)};console.log(JSON.stringify({check:name,error:String(error)}));}
}
try{
  await driver.connect();
  if(!driver.status().connected)throw new Error('The selected tab is not connected.');
  const initial=await service.browserRead();
  if(initial.runtimeVersion!=='0.5.0'||initial.extensionVersion!=='0.5.0')throw new Error(`Expected runtime and extension 0.5.0; received ${initial.runtimeVersion}/${initial.extensionVersion}`);
  if(!initial.viewer.username)throw new Error('Signed-in viewer was not observed.');
  if(process.env.THREADS_EXPECT_RUNTIME_REVISION&&initial.runtimeRevision!==process.env.THREADS_EXPECT_RUNTIME_REVISION)throw new Error(`Runtime revision mismatch: ${initial.runtimeRevision??'unreported'}`);
  report.checks.runtime={status:'PASS',version:initial.runtimeVersion,runtimeRevision:initial.runtimeRevision??null,extension:initial.extensionVersion};
  const username=initial.viewer.username;
  const initialCode=new URL(initial.url).pathname.match(/\/post\/([\w-]+)/)?.[1];
  const target=initial.posts.find(p=>initialCode&&p.code===initialCode)??initial.posts.find(p=>p.code&&p.author.username===username);
  if(target)await check('conversation',async()=>{
    const result=await service.replies(target.url,1);
    if(!result.root)throw new Error('Target post was not observed.');
    if((result.root.replies??0)>0&&!result.items.length)throw new Error('Displayed reply count is positive but no replies were classified.');
    return {url:target.url,likes:result.root.likes,displayedReplies:result.root.replies,classifiedReplies:result.items.length,unclassified:result.unclassifiedVisiblePosts.length};
  });
  for(const kind of ['followers','following'] as const)await check(kind,async()=>{
    const result=await service.users(username,kind,1);
    if(!result.items.length)throw new Error(result.warnings.join(' '));
    return {observed:result.items.length,completeness:result.completeness};
  });
  await check('search-discovery',async()=>{
    const result=await service.search({query:'Codex',refresh:true,rounds:0,mode:'lexical',limit:3});
    const page=await service.browserRead();
    if(!page.url.includes('/search?')||!page.posts.length)throw new Error('Search page posts were not observed.');
    return {url:page.url,observedPosts:page.posts.length,ranked:result.items.length,method:result.method};
  });
  await check('next-read-cycle',async()=>{
    const result=await service.profile(username,'posts',0);
    if(!result.items.length)throw new Error('Profile posts were not observed after completing other reads.');
    await driver.connect();
    return {posts:result.items.length,connected:driver.status().connected};
  });
  report.status=Object.values(report.checks).every((v:any)=>v.status==='PASS')?'PASS':'PARTIAL';
  if(report.status==='PASS'&&report.backgroundObservations.length>=5&&report.backgroundObservations.every(x=>x.before==='hidden'&&x.after==='hidden'))report.backgroundStatus='PASS';
}catch(error){report.checks.connection={status:'FAIL',error:String(error)};}
finally{
  report.finishedAt=new Date().toISOString();
  writeFileSync(join(config.dataDir,'background-smoke.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({status:report.status,finishedAt:report.finishedAt}));
  await service.close();if(report.status!=='PASS')process.exitCode=2;
}
