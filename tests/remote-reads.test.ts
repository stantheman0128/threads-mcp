import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RemoteReadController} from '../src/remote-reads.js';
import {ThreadsService} from '../src/service.js';
import {SearchIndex} from '../src/search.js';
import {ThreadsError} from '../src/types.js';

function fixture(options={extendedReads:true,messages:true}){
  const data=mkdtempSync(join(tmpdir(),'threads-remote-reads-'));let url='https://www.threads.com/',account='fixture',access=true,busy=false;
  const commands:Record<string,unknown>[]=[], indexed:unknown[]=[];
  let afterRead:(()=>void)|undefined;
  const driver={status:()=>({connected:true}),close:async()=>{},command:async(command:Record<string,unknown>)=>{
    commands.push(command);if(command.type==='remote_view')url='https://www.threads.com'+({for_you:'/',following:'/following/',saved:'/saved/',liked:'/liked/',notifications:'/activity',messages:'/messages/'} as any)[String(command.kind)];
    if(command.type==='read'){
      const page={remoteNavigationToken:'00000000-0000-4000-8000-000000000001',url,viewer:{username:account},text:'PRIVATE_VISIBLE_TEXT',posts:[],replies:[],profiles:[],warnings:[],observedAt:new Date().toISOString(),
        composerState:{present:busy,nonempty:busy,attachments:false,ambiguous:false},notificationRows:[{text:'visitor liked your post',actorLinks:[{username:'visitor',url:'https://www.threads.com/@visitor'}],postLinks:['https://www.threads.com/@fixture/post/ABC'],actionText:'liked your post'}]};
      afterRead?.();return page as any;
    }return {} as any;
  }};
  const service=new ThreadsService(driver,new SearchIndex(data),{dataDir:data,profileDir:data,channel:'chrome',headless:true,writesEnabled:false,timeoutMs:0,minActionIntervalMs:0});
  service.index.upsert=((items:unknown[])=>{indexed.push(...items);}) as any;
  const reads=new RemoteReadController(service,driver,()=>{if(!access)throw new ThreadsError('ACCESS_CHANGED','revoked');},options);
  return {reads,commands,indexed,setAccount:(v:string)=>account=v,setBusy:()=>busy=true,revoke:()=>access=false,onRead:(fn:()=>void)=>afterRead=fn,setUrl:(v:string)=>url=v,
    close:async()=>{await service.close();rmSync(data,{recursive:true,force:true});}};
}
const intent={expectedAccount:'fixture',purpose:'Read this specific view',rounds:0};
test('messages require their independent flag before any command; mismatched account and draft block navigation',async()=>{
  const f=fixture({extendedReads:true,messages:false});
  try{
    await assert.rejects(f.reads.feed({...intent,kind:'messages'}),/explicit remote capability/);assert.equal(f.commands.length,0);
    f.setAccount('another');await assert.rejects(f.reads.feed({...intent,kind:'notifications'}),/differs/);assert.ok(!f.commands.some(c=>c.type==='remote_view'));
    f.setAccount('fixture');f.setBusy();await assert.rejects(f.reads.feed({...intent,kind:'following'}),/composer/i);assert.ok(!f.commands.some(c=>c.type==='remote_view'));
  }finally{await f.close();}
});
test('private authorized views return only normalized visible data without corpus persistence; notification events retain partial scope',async()=>{
  const f=fixture();
  try{
    const messages=await f.reads.feed({...intent,kind:'messages'});assert.equal(messages.completeness,'partial');assert.equal((messages as any).visibleText,'PRIVATE_VISIBLE_TEXT');assert.equal((messages as any).mayMarkSeen,true);assert.equal(f.indexed.length,0);
    assert.doesNotMatch(JSON.stringify(messages),/composerState|viewer|runtimeDiagnostics/);
    const notifications=await f.reads.feed({...intent,kind:'notifications'});assert.ok((notifications as any).events.length);assert.equal(f.indexed.length,0);
    const following=await f.reads.feed({...intent,kind:'following'});assert.equal(following.sourceUrl,'https://www.threads.com/following/');assert.ok(!('visibleText'in following));
  }finally{await f.close();}
});
test('revocation and source change after read prevent further dispatch or return of private windows',async()=>{
  const f=fixture();
  try{
    f.onRead(()=>f.revoke());await assert.rejects(f.reads.feed({...intent,kind:'messages'}),/revoked/);assert.equal(f.commands.length,1);assert.equal(f.indexed.length,0);
  }finally{await f.close();}
  const g=fixture();let count=0;
  try{
    g.onRead(()=>{if(++count===3)g.setUrl('https://www.threads.com/settings');});
    await assert.rejects(g.reads.feed({...intent,kind:'messages',rounds:1}),/view changed/);assert.equal(g.commands.filter(c=>c.type==='scroll').length,0);assert.equal(g.indexed.length,0);
  }finally{await g.close();}
});
