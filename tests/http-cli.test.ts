import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {BridgeServer} from '../src/bridge.js';

async function freePort(){const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=(listener.address() as any).port;await new Promise<void>(r=>listener.close(()=>r()));return port as number;}
for(const [controlledWrites,controlledMedia] of [[false,false],[true,false],[true,true]])test('serve-http CLI starts without bridge and reports fresh state, controlled='+controlledWrites+', media='+controlledMedia,async()=>{
  const data=mkdtempSync(join(tmpdir(),'threads-http-cli-'));const httpPort=await freePort();let bridgePort=await freePort();while(bridgePort===httpPort)bridgePort=await freePort();
  const host=new BridgeServer({dataDir:data,port:bridgePort});
  const child=spawn(process.execPath,['--import','tsx',resolve('src/cli.ts'),'serve-http'],{env:{...process.env,THREADS_DATA_DIR:data,THREADS_HTTP_PORT:String(httpPort),THREADS_BRIDGE_PORT:String(bridgePort),THREADS_ALLOW_WRITES:'true',THREADS_REMOTE_ALLOW_WRITES:controlledWrites?'true':'false',THREADS_REMOTE_ALLOW_MEDIA:controlledMedia?'true':'false',THREADS_API_ACCESS_TOKEN:'',THREADS_API_USER_ID:''},stdio:'ignore',windowsHide:true});
  let childError=false;child.on('error',()=>{childError=true;});
  const stopped=once(child,'exit');
  try{
    let token='';let health:any;const deadline=Date.now()+10000;
    while(Date.now()<deadline){
      assert.equal(childError,false);assert.equal(child.exitCode,null,'HTTP exited before bridge could start');
      try{token=readFileSync(join(data,'remote-access.token'),'utf8').trim();const response=await fetch(`http://127.0.0.1:${httpPort}/healthz`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(500)});if(response.ok){health=await response.json();break;}}catch{}
      await new Promise(r=>setTimeout(r,50));
    }
    assert.equal(health?.bridge.state,'pairing-missing');
    await host.start();
    const response=await fetch(`http://127.0.0.1:${httpPort}/healthz`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(5000)});
    health=await response.json();assert.equal(health.bridge.state,'extension-disconnected');assert.equal(health.browser.connected,false);
    const rpc=await fetch(`http://127.0.0.1:${httpPort}/mcp`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'threads_status',arguments:{}}})});
    const result=(await rpc.json() as any).result.structuredContent;assert.equal(result.writesEnabled,controlledWrites);assert.equal(result.mediaEnabled,controlledMedia);assert.equal(result.tools.length,controlledMedia?19:controlledWrites?18:15);
  }finally{child.kill();await stopped;await host.close();rmSync(data,{recursive:true,force:true});}
});
