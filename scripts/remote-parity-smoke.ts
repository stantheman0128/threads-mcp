import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {RemoteExtensionDriver} from '../src/remote-driver.js';

// Read-only activation: no notification/message views, uploads or social execution.
const data=resolve(process.env.THREADS_DATA_DIR??'.threads-data'), endpoint=process.env.THREADS_REMOTE_URL??'http://127.0.0.1:19759/mcp';
const proxy=process.env.THREADS_ACCEPT_PROXY==='true', expectedVersion='0.7.0';
const driver=new RemoteExtensionDriver({dataDir:data,port:Number(process.env.THREADS_BRIDGE_PORT??19758)});
const client=new Client({name:'controlled-parity-readonly-acceptance',version:expectedVersion});
const report:any={status:'BLOCKED',startedAt:new Date().toISOString(),transport:proxy?'mcp-remote-header-file':'streamable-http',publicMutations:0,privateViewReads:0,checks:[]};
let originalRoute:string|undefined,expectedRoute:string|undefined,account:string|undefined,header:string|undefined,phase='native-version';
async function call(name:string,args:Record<string,unknown>){
  phase=name;const result=await client.callTool({name,arguments:args},undefined,{timeout:90_000});
  if(result.isError){let code='REMOTE_FAILED';try{code=JSON.parse((result.content[0]as any).text).error;}catch{}throw Object.assign(new Error('Remote acceptance failed'),{code});}
  return result.structuredContent as any;
}
try{
  await driver.connect();const initial=await driver.command<any>({type:'read'});
  report.runtime={extension:initial.extensionVersion,runtime:initial.runtimeVersion,revision:initial.runtimeRevision,visibility:initial.visibilityState};
  assert.equal(initial.extensionVersion,expectedVersion);assert.equal(initial.runtimeVersion,expectedVersion);assert.equal(initial.runtimeRevision,'20261107-profile-label-1');
  assert.ok(initial.viewer?.username);assert.equal(initial.composerState?.present,false);assert.equal(initial.composerState?.nonempty,false);
  originalRoute=initial.url;account=initial.viewer.username;
  const token=readFileSync(join(data,'remote-access.token'),'utf8').trim();
  phase='transport';const anonymous=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(15_000)});
  assert.equal(anonymous.status,401);report.unauthorizedStatus=401;
  if(proxy){
    const dependency=resolve(process.env.THREADS_MCP_REMOTE_PATH??join(data,'mcp-remote-check/node_modules/mcp-remote'));
    assert.equal(JSON.parse(readFileSync(join(dependency,'package.json'),'utf8')).version,'0.16.1');
    const folder=join(data,'proxy-live-private');mkdirSync(folder,{recursive:true,mode:0o700});
    if(process.platform==='win32'){
      const secured=spawnSync(join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-File',resolve('scripts/windows/Assert-PrivatePaths.ps1'),'-StateDir',folder,'-ConfigPath',join(folder,'config.json'),'-TokenFile',join(folder,'unused.token'),'-ProtectState'],{windowsHide:true,stdio:'ignore',timeout:15000});
      assert.equal(secured.status,0);
    }
    header=join(folder,`acceptance-${randomUUID()}.headers`);writeFileSync(header,`Authorization: Bearer ${token}\n`,{mode:0o600});
    const transport=new StdioClientTransport({command:process.execPath,args:[join(dependency,'dist/proxy.js'),endpoint,...(endpoint.startsWith('http:')?['--allow-http']:[]),'--header-file',header,'--transport','http-only','--silent'],env:{MCP_REMOTE_CONFIG_DIR:join(folder,'auth'),NO_COLOR:'1',NODE_NO_WARNINGS:'1'},stderr:'pipe'});
    transport.stderr?.on('data',()=>{});await client.connect(transport,{timeout:30_000});
  }else await client.connect(new StreamableHTTPClientTransport(new URL(endpoint),{requestInit:{headers:{Authorization:`Bearer ${token}`}},reconnectionOptions:{maxRetries:0}}));
  const listed=await client.listTools();assert.equal(listed.tools.length,44);report.tools=44;
  for(const denied of ['threads_read_page','threads_export','threads_stage_media','threads_account_insights'])assert.ok(!listed.tools.some(t=>t.name===denied));
  const status=await call('threads_status',{});assert.equal(status.writesEnabled,true);assert.equal(status.mediaEnabled,true);
  for(const key of ['extendedReads','delete','schedule','browserFallback','messages','officialApi'])assert.equal(status.capabilities[key],true);
  report.capabilities=status.capabilities;report.writesEnabled=true;report.mediaEnabled=true;
  const api=await call('threads_api_status',{});report.api={configured:api.configured,authentication:api.authentication,writeIdentityConfigured:api.writeIdentityConfigured};
  for(const [label,maxPages]of[['first-read',2],['next-read',1]]as const){
    const result=await call('threads_get_profile',{username:account,provider:'direct',section:'posts',maxPages,pageSize:5});
    assert.ok(result.items.length>0);assert.ok(result.items.every((p:any)=>p.author.username.toLowerCase()===account!.toLowerCase()));assert.equal(result.pagination.pagesFetched,maxPages);
    report.checks.push({label,pages:result.pagination.pagesFetched,posts:result.items.length,accountMatched:true,completeness:result.completeness});expectedRoute=`https://www.threads.com/@${account}`;
  }
  const snapshot=await call('threads_browser_snapshot',{expectedAccount:account});assert.equal(snapshot.account,account);assert.equal(snapshot.scope,'public-read-navigation');report.browserSnapshot={accountMatched:true,refs:snapshot.elements.length,scope:snapshot.scope};
  report.connected=(await call('threads_status',{})).browser.connected;assert.equal(report.connected,true);report.status='PASS';
}catch(error){report.failedPhase=phase;report.errorCode=/^[A-Z_]+$/.test((error as any)?.code??'')?(error as any).code:'ACCEPTANCE_MISMATCH';process.exitCode=1;}
finally{
  if(originalRoute&&expectedRoute&&account){try{
    const now=await driver.command<any>({type:'read'});
    if(now.url.replace(/\/$/,'')===expectedRoute.replace(/\/$/,'')&&now.viewer.username===account&&!now.composerState?.present){
      if(now.url!==originalRoute)await driver.command({type:'navigate',url:originalRoute});
      const restored=await driver.command<any>({type:'read'});report.originalRouteRestored=restored.url===originalRoute;report.finalVisibility=restored.visibilityState;
    }else report.restoreSkipped='context-changed';
  }catch{report.restoreSkipped='read-unavailable';}}
  await client.close();await driver.close();if(header)try{unlinkSync(header);}catch{}
  report.finishedAt=new Date().toISOString();writeFileSync(join(data,`remote-parity-${proxy?'proxy':'https'}-activation.json`),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report,null,2));
}
