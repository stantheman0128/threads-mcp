import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {getConfig} from '../src/config.js';
import {BridgeServer} from '../src/bridge.js';
import {ExtensionDriver} from '../src/driver.js';
import {SearchIndex} from '../src/search.js';
import {ThreadsService} from '../src/service.js';
import {RemoteExtensionDriver} from '../src/remote-driver.js';
const config=getConfig();const port=Number(process.env.THREADS_BRIDGE_PORT??19758);
let remote:RemoteExtensionDriver|undefined=new RemoteExtensionDriver({dataDir:config.dataDir,port});let bridge:BridgeServer|undefined;
try{await remote.connect();}catch(error){if(!['BRIDGE_PAIRING_MISSING','ECONNREFUSED'].includes((error as any).code))throw error;remote=undefined;bridge=new BridgeServer({dataDir:config.dataDir,port});await bridge.start();}
const driver=remote??new ExtensionDriver(bridge!);
const connected=async()=>{if(remote)await remote.connect();return (driver.status() as any).connected;};
console.log(`等待手動配對：http://127.0.0.1:${port}/`);
const service=new ThreadsService(driver,new SearchIndex(config.dataDir),config);
const report:Record<string,unknown>={startedAt:new Date().toISOString(),status:'BLOCKED',writesPerformed:false};
try{
  const deadline=Date.now()+Number(process.env.THREADS_PAIR_WAIT_MS??600000);
  while(!await connected()&&Date.now()<deadline)await new Promise(r=>setTimeout(r,1000));
  if(!await connected())report.reason='The extension was not paired within the wait window.';
  else{
    const read=await service.browserRead();const snap=await service.snapshot();
    report.read={url:read.url,viewer:read.viewer,posts:read.posts.length,profiles:read.profiles.length,controls:snap.elements.length,warnings:read.warnings};
    report.status=read.viewer.username&&snap.elements.length?'PARTIAL':'BLOCKED';
    const post=read.posts.find(p=>p.code);
    if(post){const detail=await service.post(post.url,0);report.post={found:!!detail.post,likes:detail.post?.likes,replies:detail.replies.length};}
    if(read.viewer.username){
      try{const users=await service.users(read.viewer.username,'followers',0);report.followers={observed:users.items.length,completeness:users.completeness,warnings:users.warnings};}catch(error){report.followers={error:String(error)};}
      try{const users=await service.users(read.viewer.username,'following',0);report.following={observed:users.items.length,completeness:users.completeness,warnings:users.warnings};}catch(error){report.following={error:String(error)};}
    }
    report.limitations=['No public writes performed. Following, private messages and all UI fallback actions are not exhaustively tested.'];
  }
}catch(error){report.error=String(error);}
finally{report.finishedAt=new Date().toISOString();writeFileSync(join(config.dataDir,'live-smoke.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await service.close();if(report.status==='BLOCKED')process.exitCode=2;}
