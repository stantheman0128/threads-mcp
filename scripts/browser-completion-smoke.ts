import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {getConfig} from '../src/config.js';

// Real-account acceptance: reads plus already-satisfied action commits only.
// A no-op preparation is checked before execution; no test changes are allowed.
const config=getConfig();
const client=new Client({name:'browser-completion-acceptance',version:'0.5.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/cli.js'),'serve'],env:{...process.env as Record<string,string>,THREADS_PROVIDER:'extension',THREADS_DATA_DIR:config.dataDir,THREADS_ALLOW_WRITES:'true',THREADS_API_ACCESS_TOKEN:'',THREADS_API_USER_ID:''},stderr:'pipe'});
const report:any={status:'BLOCKED',startedAt:new Date().toISOString(),publicMutations:0,uploads:0,checks:{}};
async function call(name:string,args:Record<string,unknown>={}){const started=Date.now();console.log(JSON.stringify({phase:'start',tool:name,time:new Date().toISOString()}));const r=await client.callTool({name,arguments:args},undefined,{timeout:180000});console.log(JSON.stringify({phase:'end',tool:name,elapsedMs:Date.now()-started,error:!!r.isError}));if(r.isError)throw new Error(JSON.stringify(r.content));return r.structuredContent as any;}
async function check(name:string,run:()=>Promise<unknown>){let stopError:unknown;try{const result=await run();report.checks[name]={status:'PASS',result};console.log(JSON.stringify({check:name,status:'PASS',result}));}catch(error){report.checks[name]={status:'FAIL',error:String(error)};console.log(JSON.stringify({check:name,status:'FAIL',error:String(error)}));if(/NAVIGATION_TIMEOUT|COMMAND_TIMEOUT|BRIDGE_DISCONNECTED|BRIDGE_NOT_CONNECTED|Request timed out/.test(String(error)))stopError=error;}writeFileSync(join(config.dataDir,'browser-completion-smoke.json'),JSON.stringify(report,null,2));if(stopError)throw stopError;}
try{
  await client.connect(transport);const page=await call('threads_read_page');
  if(page.runtimeVersion!=='0.5.0'||page.extensionVersion!=='0.5.0')throw new Error(`Activation mismatch: runtime=${page.runtimeVersion}, extension=${page.extensionVersion}`);
  if(process.env.THREADS_EXPECT_RUNTIME_REVISION&&page.runtimeRevision!==process.env.THREADS_EXPECT_RUNTIME_REVISION)throw new Error(`Runtime revision mismatch: ${page.runtimeRevision??'unreported'}`);
  const account=page.viewer.username;if(!account)throw new Error('No unique viewer');
  report.checks.activation={status:'PASS',runtime:page.runtimeVersion,runtimeRevision:page.runtimeRevision??null,extension:page.extensionVersion,visibility:page.visibilityState};
  writeFileSync(join(config.dataDir,'browser-completion-smoke.json'),JSON.stringify(report,null,2));
  const onProfile=new URL(page.url).pathname.replace(/\/$/,'').toLowerCase()===`/@${account}`;
  const own=onProfile&&page.posts.length?{items:page.posts.filter((p:any)=>p.author.username===account&&p.isReply!==true)}:await call('threads_get_profile',{username:account,rounds:0});const target=own.items.find((p:any)=>p.code);if(!target)throw new Error('No own post observed');
  report.checks.profile={status:'PASS',observed:own.items.length};
  writeFileSync(join(config.dataDir,'browser-completion-smoke.json'),JSON.stringify(report,null,2));
  await check('post-likes',async()=>{const r=await call('threads_get_post_activity',{url:target.url,kind:'likes',rounds:1});if(r.state!=='observed-window'||!r.items.length)throw new Error('Likes panel not established');return {state:r.state,observed:r.items.length,displayedCount:r.displayedCount,selfObserved:r.items.some((p:any)=>p.username===account),completeness:r.completeness};});
  await check('post-reposts',async()=>{const r=await call('threads_get_post_activity',{url:target.url,kind:'reposts',rounds:0});if(r.state!=='observed-window')throw new Error('Repost panel not established');return {state:r.state,observed:r.items.length,displayedCount:r.displayedCount,selfObserved:r.items.some((p:any)=>p.username===account),completeness:r.completeness};});
  await check('named-inspection-and-noop',async()=>{
    await call('threads_read_page',{url:target.url});
    const state=await call('threads_inspect_social',{kind:'like',targetUrl:target.url});
    if(!['like','unlike'].includes(state.state))throw new Error('No explicit like state');
    const kind=state.state==='unlike'?'like':'unlike';
    const staged=await call('threads_prepare_social',{kind,targetUrl:target.url});
    if(staged.noop!==true)throw new Error('Preparation was not a no-op; no commit sent');
    const result=await call('threads_execute_social',{id:staged.id,expectedAccount:account});
    if(result.outcome!=='already-satisfied'||result.dispatch?.noop!==true||result.dispatch?.dispatched!==false)throw new Error('No-op was not established');
    const after=await call('threads_inspect_social',{kind:'like',targetUrl:target.url});if(after.state!==state.state)throw new Error('State changed unexpectedly');
    return {accountMatched:state.account===account,targetMatched:state.targetUrl===target.url,state:after.state,outcome:result.outcome,dispatched:false};
  });
  await check('own-delete-preparation-only',async()=>{
    const p=await call('threads_prepare_social',{kind:'delete',targetUrl:target.url});
    if(!p.staged||p.account!==account||p.request.targetUrl!==target.url)throw new Error('Delete preparation did not bind the own post');
    const snap=await call('threads_browser_snapshot');if(!snap.elements.some((e:any)=>e.name==='刪除'||e.name==='Delete'))throw new Error('Delete menu item not observed');
    // Close this read-only menu via exact-route navigation. No delete commit occurs.
    await call('threads_read_page',{url:target.url});
    return {staged:true,ownAccountMatched:true,deleteMenuObserved:true,executed:false};
  });
  await check('notifications-classification',async()=>{const r=await call('threads_get_notifications',{rounds:0});const types=[...new Set(r.events.map((e:any)=>e.kind))];if(!r.events.length||types.every(k=>k==='unknown'))throw new Error('No classified observed notification');return {rows:r.events.length,types,aggregatedRows:r.events.filter((e:any)=>e.additionalActorCount>0).length,completeness:r.completeness};});
  await check('followers',async()=>{const r=await call('threads_get_connections',{username:account,kind:'followers',rounds:0});if(!r.items.length)throw new Error('No confirmed follower window');return {observed:r.items.length,completeness:r.completeness};});
  await check('following',async()=>{const r=await call('threads_get_connections',{username:account,kind:'following',rounds:0});if(!r.items.length)throw new Error('No confirmed following window');return {observed:r.items.length,completeness:r.completeness};});
  await check('following-profile-inspection',async()=>{const username=process.env.THREADS_TEST_FOLLOWING_USERNAME;if(!username||! /^[\w.]+$/.test(username))throw new Error('Set THREADS_TEST_FOLLOWING_USERNAME to an account the test viewer already follows; this check does not change a relationship.');const url=`https://www.threads.com/@${username}`;await call('threads_read_page',{url});const r=await call('threads_inspect_social',{kind:'follow',targetUrl:url});if(r.state!=='unfollow')throw new Error('Known following control not established');return {state:r.state,accountMatched:r.account===account,targetMatched:r.targetUrl===url};});
  await check('generic-snapshot-preparation',async()=>{const snap=await call('threads_browser_snapshot');const item=snap.elements.find((e:any)=>e.name==='追蹤中');if(!item)throw new Error('No labelled following control');const p=await call('threads_prepare_action',{snapshotId:snap.snapshotId,ref:item.ref,verb:'click',purpose:'Read-only acceptance: prepare only, never execute'});return {prepared:!!p.id,accountMatched:p.account===account,executed:false};});
  await check('next-read-cycle',async()=>{const r=await call('threads_get_profile',{username:account,rounds:0});const p=await call('threads_read_page');const status=await call('threads_status');if(!r.items.length||!status.browser.connected||p.viewer.username!==account)throw new Error('Next cycle not established');return {observed:r.items.length,connected:true,visibility:p.visibilityState,runtime:p.runtimeVersion,runtimeRevision:p.runtimeRevision??null,extension:p.extensionVersion};});
  report.status=Object.values(report.checks).every((c:any)=>c.status==='PASS')?'PASS':'PARTIAL';
}catch(error){report.checks.blocker={status:'FAIL',error:String(error)};}
finally{report.finishedAt=new Date().toISOString();writeFileSync(join(config.dataDir,'browser-completion-smoke.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,finishedAt:report.finishedAt}));await client.close();if(report.status!=='PASS')process.exitCode=2;}
