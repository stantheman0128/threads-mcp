import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {startRemoteHttp} from '../src/http-server.js';
import {REMOTE_READ_TOOLS} from '../src/server.js';
import {ThreadsService} from '../src/service.js';
import {SearchIndex} from '../src/search.js';

// Run only against a generated loopback fixture. Never read the production token,
// bridge pairing file, browser profile or account credentials.
process.env.THREADS_API_ACCESS_TOKEN='';
process.env.THREADS_API_USER_ID='';
const root=resolve('.threads-data/mcp-remote-check');
mkdirSync(root,{recursive:true});
const dependency=resolve(process.env.THREADS_MCP_REMOTE_PACKAGE_DIR??join(root,'node_modules/mcp-remote'));
const run=mkdtempSync(join(root,'run-'));
const headerFile=join(run,'headers.txt');
const reportPath=join(root,'proxy-smoke.json');
const token=randomBytes(32).toString('base64url');
const report:Record<string,unknown>={status:'FAIL',startedAt:new Date().toISOString(),fixture:'isolated-loopback',expectedPackage:'mcp-remote@0.16.1',liveAccountUsed:false};
let phase='package';
let browserCommands=0;
let stderrBytes=0;
let client:Client|undefined;
let http:Awaited<ReturnType<typeof startRemoteHttp>>|undefined;
let service:ThreadsService|undefined;
const httpResponses:Array<{method:string;status:number}>=[];
try{
  const pkg=JSON.parse(readFileSync(join(dependency,'package.json'),'utf8'));
  assert.equal(pkg.name,'mcp-remote');assert.equal(pkg.version,'0.16.1');
  assert.equal(pkg.bin['mcp-remote'],'dist/proxy.js');
  report.packageVersion=pkg.version;
  phase='fixture';
  service=new ThreadsService({
    status:()=>({connected:false,health:{state:'extension-disconnected',checkedAt:new Date().toISOString()}}),
    command:async()=>{browserCommands++;throw new Error('Fixture browser must never be used');},
    close:async()=>{},
  },new SearchIndex(join(run,'index')),{dataDir:run,profileDir:join(run,'unused-profile'),channel:'chrome',headless:true,writesEnabled:false,timeoutMs:1000,minActionIntervalMs:0});
  http=await startRemoteHttp(service,{port:0,readToken:()=>token});
  http.on('request',(request,response)=>{response.once('finish',()=>httpResponses.push({method:request.method??'unknown',status:response.statusCode}));});
  const port=(http.address() as {port:number}).port;
  const endpoint=`http://127.0.0.1:${port}/mcp`;
  writeFileSync(headerFile,`Authorization: Bearer ${token}\n`,{flag:'wx',mode:0o600});
  const args=[join(dependency,'dist/proxy.js'),endpoint,'--allow-http','--header-file',headerFile,'--transport','http-only','--silent'];
  assert.equal(args.some(value=>value.includes(token)),false);
  const transport=new StdioClientTransport({command:process.execPath,args,cwd:run,
    env:{MCP_REMOTE_CONFIG_DIR:join(run,'auth'),NO_COLOR:'1',NODE_NO_WARNINGS:'1'},stderr:'pipe'});
  transport.stderr?.on('data',(chunk:Buffer)=>{stderrBytes+=chunk.length;}); // Discard; never persist or print child diagnostics.
  client=new Client({name:'threads-mcp-remote-package-smoke',version:'1.0.0'});
  phase='initialize';
  await client.connect(transport,{timeout:15000});
  phase='list-tools';
  const list=await client.listTools(undefined,{timeout:15000});
  assert.equal(list.tools.length,15);
  assert.deepEqual(new Set(list.tools.map(tool=>tool.name)),REMOTE_READ_TOOLS);
  assert.equal(list.tools.some(tool=>/execute|prepare|stage|schedule|draft|api_/.test(tool.name)),false);
  report.toolCount=list.tools.length;
  report.writeToolsAbsent=true;
  phase='status';
  const status=await client.callTool({name:'threads_status',arguments:{}},undefined,{timeout:15000});
  assert.equal(status.isError,undefined);
  assert.equal((status.structuredContent as any).writesEnabled,false);
  assert.equal((status.structuredContent as any).remoteReadOnly,true);
  assert.equal(browserCommands,0);
  assert.equal(JSON.stringify(status).includes(token),false);
  report.writesEnabled=false;
  report.remoteReadOnly=true;
  report.checks=['published-package-version','stdio-initialize','15-tool-read-allowlist','status-writes-disabled','no-execute-tool','no-browser-command'];
  report.status='PASS';
}catch{
  // Assertions/proxy errors can contain request details. Persist only the controlled phase.
  report.failedPhase=phase;
  report.error='Proxy compatibility fixture failed; raw errors and child diagnostics were suppressed.';
  process.exitCode=1;
}finally{
  try{await client?.close();report.proxyTransportClosed=true;}catch{report.cleanupFailed=true;process.exitCode=1;report.status='FAIL';}
  if(http){http.closeAllConnections();await new Promise<void>(done=>http!.close(()=>done()));}
  try{await service?.close();}catch{report.cleanupFailed=true;process.exitCode=1;report.status='FAIL';}
  try{unlinkSync(headerFile);}catch{/* May not have been created. */}
  // This path is generated under the fixed private fixture root and contains no live state.
  assert.equal(dirname(run),root);
  rmSync(run,{recursive:true,force:true});
  report.browserCommands=browserCommands;
  report.childStderrBytes=stderrBytes;
  report.childStderrRetained=false;
  report.httpResponses=httpResponses;
  report.finishedAt=new Date().toISOString();
  report.exitCode=process.exitCode??0;
  writeFileSync(reportPath,JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify(report,null,2));
}
