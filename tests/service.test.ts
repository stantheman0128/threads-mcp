import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ThreadsService,sameThreadsRoute} from '../src/service.js';
import {SearchIndex} from '../src/search.js';
import {getConfig} from '../src/config.js';
import type {BrowserDriver} from '../src/driver.js';
import {normalizePost} from '../src/parser.js';
import {ThreadsError,type Profile} from '../src/types.js';
import type {PageRead} from '../src/page-runtime.js';
function fixture(writesEnabled=false,minActionIntervalMs=0){
  const dir=mkdtempSync(join(tmpdir(),'threads-service-'));const calls:Record<string,unknown>[]=[];
  let account='alice';const url='https://www.threads.com/@alice';
  const page=()=>({url,title:'Threads',posts:[],replies:[],profiles:[],dialogUsers:[],viewer:{username:account},text:'',warnings:[],observedAt:new Date().toISOString()});
  const driver:BrowserDriver={status:()=>({}),close:async()=>{},command:async<T>(cmd:Record<string,unknown>)=>{calls.push(cmd);if(cmd.type==='snapshot')return {...page(),snapshotId:'snapshot-1',elements:[{ref:'1',name:'Like',role:'button',text:'',context:'',editable:false}]} as T;if(cmd.type==='interact')throw new Error('timeout: outcome unknown');return page() as T;}};
  const service=new ThreadsService(driver,new SearchIndex(dir),{...getConfig(),dataDir:dir,writesEnabled,minActionIntervalMs,timeoutMs:100});
  return {service,calls,setAccount:(v:string)=>{account=v;},close:async()=>{await service.close();rmSync(dir,{recursive:true,force:true});}};
}
test('write guard prevents dispatch even for a prepared action',async()=>{const f=fixture();try{await f.service.snapshot();const p=await f.service.prepare({snapshotId:'snapshot-1',ref:'1',verb:'click',purpose:'authorized like'});await assert.rejects(f.service.execute(p.id,'alice'),/THREADS_ALLOW_WRITES/);assert.equal(f.calls.filter(c=>c.type==='interact').length,0);}finally{await f.close();}});
test('account change blocks action and consumes it',async()=>{const f=fixture(true);try{await f.service.snapshot();const p=await f.service.prepare({snapshotId:'snapshot-1',ref:'1',verb:'click',purpose:'authorized like'});f.setAccount('bob');await assert.rejects(f.service.execute(p.id,'alice'),/account changed/);await assert.rejects(f.service.execute(p.id,'alice'),/already consumed/);assert.equal(f.calls.filter(c=>c.type==='interact').length,0);}finally{await f.close();}});
test('uncertain dispatch cannot be replayed',async()=>{const f=fixture(true);try{await f.service.snapshot();const p=await f.service.prepare({snapshotId:'snapshot-1',ref:'1',verb:'click',purpose:'authorized like'});await assert.rejects(f.service.execute(p.id,'alice'),/outcome unknown/);await assert.rejects(f.service.execute(p.id,'alice'),/already consumed/);assert.equal(f.calls.filter(c=>c.type==='interact').length,1);}finally{await f.close();}});

test('shared write reservation guards named-to-generic dispatch and consumes blocked preparations',async()=>{
  const f=fixture(true,60_000);
  try{
    f.service.reserveWrite();await f.service.snapshot();
    const p=await f.service.prepare({snapshotId:'snapshot-1',ref:'1',verb:'click',purpose:'authorized like'});
    await assert.rejects(f.service.execute(p.id,'alice'),{code:'ACTION_COOLDOWN'});
    await assert.rejects(f.service.execute(p.id,'alice'),{code:'INVALID_ACTION'});assert.equal(f.calls.filter(c=>c.type==='interact').length,0);
  }finally{await f.close();}
});

test('generic uncertain dispatch keeps shared cooldown charged and disabled writes cannot reserve',async()=>{
  const f=fixture(true,60_000),disabled=fixture(false);
  try{
    assert.throws(()=>disabled.service.reserveWrite(),{code:'WRITES_DISABLED'});
    await f.service.snapshot();const p=await f.service.prepare({snapshotId:'snapshot-1',ref:'1',verb:'click',purpose:'authorized like'});
    await assert.rejects(f.service.execute(p.id,'alice'),/outcome unknown/);assert.throws(()=>f.service.reserveWrite(),{code:'ACTION_COOLDOWN'});
  }finally{await f.close();await disabled.close();}
});

test('waiting for a shared write slot is bounded, cancellable and does not reserve a new write',async t=>{
  let now=10_000;t.mock.method(Date,'now',()=>now);const f=fixture(true,1000),waits:number[]=[];
  try{
    f.service.reserveWrite();assert.equal(f.service.writeCooldownRemainingMs(),1000);
    await f.service.waitForWriteSlot({sleep:async ms=>{waits.push(ms);now+=ms;}});
    assert.deepEqual(waits,[250,250,250,250]);assert.equal(f.service.writeCooldownRemainingMs(),0);
    f.service.reserveWrite();let stop=false;
    await assert.rejects(f.service.waitForWriteSlot({shouldStop:()=>stop,sleep:async ms=>{now+=ms;stop=true;}}),{code:'STOP_REQUESTED'});
    assert.equal(f.service.writeCooldownRemainingMs(),750);
  }finally{await f.close();}
});
test('absent target in partial following list is unknown',async()=>{const f=fixture();try{const result=await f.service.relationship('alice','bob',0);assert.equal(result.follows,null);assert.equal(result.state,'unknown');}finally{await f.close();}});
test('connection reads wait for async loading and accept identical lists when the requested tab is visibly selected',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'threads-list-'));let reads=0;let following=false;
  const base={url:'https://www.threads.com/@alice',title:'Threads',posts:[],replies:[],profiles:[],viewer:{username:'alice'},text:'',warnings:[],observedAt:new Date().toISOString()};
  const user={username:'bob',bio:null,followers:null,following:null,private:null,url:'https://www.threads.com/@bob',links:[]};
  const driver:BrowserDriver={status:()=>({}),close:async()=>{},command:async<T>(cmd:Record<string,unknown>)=>{
    if(cmd.type==='open_read_panel'&&cmd.panel==='following')following=true;
    if(cmd.type==='read'){reads++;return {...base,dialogUsers:reads>1?[user]:[],dialogState:{present:true,selectedTab:following?'追蹤中':'粉絲',busy:reads===1}} as T;}
    return {} as T;
  }};
  const service=new ThreadsService(driver,new SearchIndex(dir),{...getConfig(),dataDir:dir,timeoutMs:800});
  try{
    const result=await service.users('alice','followers',0);assert.equal(result.items[0]?.username,'bob');assert.ok(reads>=2);
    const relation=await service.relationship('alice','bob',0);assert.equal(following,true);assert.equal(relation.follows,true);assert.equal(relation.evidence.items.length,1);
  }finally{await service.close();rmSync(dir,{recursive:true,force:true});}
});

test('profile sections keep embedded replies and conversation parents out of the wrong authored collection',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'threads-profile-'));
  const ownPost=normalizePost({pk:'1',code:'POST',user:{username:'alice'},text_post_app_info:{is_reply:false}})!;
  const ownReply=normalizePost({pk:'2',code:'REPLY',user:{username:'alice'},text_post_app_info:{is_reply:true}})!;
  const other=normalizePost({pk:'3',code:'OTHER',user:{username:'bob'},text_post_app_info:{is_reply:false}})!;
  let url='https://www.threads.com/@alice';
  const driver:BrowserDriver={status:()=>({}),close:async()=>{},command:async<T>(cmd:Record<string,unknown>)=>{if(cmd.type==='navigate')url=String(cmd.url);return {url,posts:[ownPost,ownReply,other],profiles:[],replies:[ownReply],warnings:[],observedAt:new Date().toISOString()} as T;}};
  const service=new ThreadsService(driver,new SearchIndex(dir),{...getConfig(),dataDir:dir});
  try{
    const posts=await service.profile('alice','posts',0);assert.deepEqual(posts.items.map(p=>p.code),['POST']);assert.deepEqual(posts.contextualPosts.map(p=>p.code),['REPLY','OTHER']);
    const replies=await service.profile('alice','replies',0);assert.deepEqual(replies.items.map(p=>p.code),['REPLY']);assert.deepEqual(replies.contextualPosts.map(p=>p.code),['POST','OTHER']);
  }finally{await service.close();rmSync(dir,{recursive:true,force:true});}
});

type ReadState={url:string;panel:string|null;activityTab:string|null;scrolls:number;reads:number};
function readFixture(makePage:(state:ReadState)=>Partial<PageRead>,navigationTimeout=false,timeoutMs=30){
  const dir=mkdtempSync(join(tmpdir(),'threads-source-'));const calls:Record<string,unknown>[]=[];
  const state:ReadState={url:'https://www.threads.com/@alice',panel:null,activityTab:null,scrolls:0,reads:0};
  const driver:BrowserDriver={status:()=>({}),close:async()=>{},command:async<T>(cmd:Record<string,unknown>)=>{
    calls.push(cmd);
    if(cmd.type==='navigate'){state.url=String(cmd.url);state.scrolls=0;state.panel=null;if(navigationTimeout)throw new ThreadsError('NAVIGATION_TIMEOUT','Test navigation timeout.');}
    if(cmd.type==='open_read_panel'){state.panel=String(cmd.panel);state.activityTab=typeof cmd.activityTab==='string'?cmd.activityTab:null;}
    if(cmd.type==='scroll')state.scrolls++;
    if(cmd.type==='read')state.reads++;
    return {runtimeVersion:'test',url:state.url,title:'Threads',posts:[],replies:[],profiles:[],dialogUsers:[],dialogState:{present:false,selectedTab:null,busy:false},viewer:{username:'alice'},text:'',warnings:[],observedAt:new Date().toISOString(),...makePage(state)} as T;
  }};
  const service=new ThreadsService(driver,new SearchIndex(dir),{...getConfig(),dataDir:dir,timeoutMs});
  return {service,state,calls,close:async()=>{await service.close();rmSync(dir,{recursive:true,force:true});}};
}
const connectionUser=(username:string):Profile=>({username,bio:null,followers:null,following:null,private:null,url:`https://www.threads.com/@${username}`,links:[]});

test('route identity normalizes legacy host, slash, hash and query order while preserving query meaning',()=>{
  assert.equal(sameThreadsRoute('https://threads.net/@Alice/#panel','https://www.threads.com/@alice'),true);
  assert.equal(sameThreadsRoute('https://threads.net/search/?serp_type=default&q=tea%20shop#top','https://www.threads.com/search?q=tea+shop&serp_type=default'),true);
  for(const other of ['https://www.threads.com/search?q=coffee&serp_type=default','https://www.threads.com/search?q=tea+shop&serp_type=default&filter=recent','https://www.threads.com/@alice','https://example.com/search?q=tea+shop&serp_type=default']){
    assert.equal(sameThreadsRoute('https://www.threads.com/search?q=tea+shop&serp_type=default',other),false);
  }
  assert.equal(sameThreadsRoute('https://www.threads.com/@alice/post/AbC','https://www.threads.com/@alice/post/abc'),false);
});

test('connection list with unknown or absent selected tab cannot prove a following relationship',async t=>{
  for(const mode of ['unknown','wrong','absent','busy'] as const)await t.test(mode,async()=>{
    const f=readFixture(state=>({dialogUsers:[connectionUser('bob')],dialogState:{present:state.panel!==null&&(state.panel!=='following'||mode!=='absent'),selectedTab:state.panel==='following'?(mode==='unknown'?null:mode==='wrong'?'Followers':'Following'):'Followers',busy:state.panel==='following'&&mode==='busy'}}));
    try{
      const relation=await f.service.relationship('alice','bob',0);assert.equal(relation.follows,null);assert.equal(relation.evidence.items.length,0);
      assert.ok(relation.evidence.warnings.some(w=>/not confirmed|not visibly selected/.test(w)));
    }finally{await f.close();}
  });
});

test('connection scrolling stops before merging a manually changed tab, missing dialog or busy rows',async t=>{
  for(const mode of ['wrong','unknown','absent','busy'] as const)await t.test(mode,async()=>{
    const f=readFixture(state=>({dialogUsers:[connectionUser(state.scrolls?'foreign':'bob')],dialogState:{present:state.panel!==null&&!(state.scrolls&&mode==='absent'),selectedTab:state.scrolls?(mode==='unknown'?null:mode==='wrong'?'Followers':'Following'):state.panel==='following'?'Following':'Followers',busy:!!state.scrolls&&mode==='busy'}}));
    try{
      const result=await f.service.users('alice','following',2);assert.deepEqual(result.items.map(p=>p.username),['bob']);
      assert.equal(f.state.scrolls,1);assert.ok(result.warnings.some(w=>/stopped without merging/.test(w)));
    }finally{await f.close();}
  });
});

test('connection scrolling rejects a different profile and does not index its posts',async()=>{
  const foreign=normalizePost({pk:'99',code:'FOREIGN',user:{username:'mallory'},caption:{text:'foreign-marker'}})!;
  const f=readFixture(state=>({url:state.scrolls?'https://www.threads.com/@mallory':state.url,posts:state.scrolls?[foreign]:[],dialogUsers:[connectionUser(state.scrolls?'foreign':'bob')],dialogState:{present:true,selectedTab:state.panel==='following'?'Following':'Followers',busy:false}}));
  try{
    const result=await f.service.users('alice','following',2);assert.deepEqual(result.items.map(p=>p.username),['bob']);assert.equal(result.sourceUrl,'https://www.threads.com/@alice');
    assert.ok(result.warnings.some(w=>/changed profile/.test(w)));assert.equal((await f.service.index.search('foreign-marker',{mode:'lexical'})).items.length,0);
  }finally{await f.close();}
});

test('initial wrong profile blocks opening connection controls',async()=>{
  const f=readFixture(()=>({url:'https://www.threads.com/@mallory'}));
  try{await assert.rejects(f.service.users('alice','followers',0),{code:'SOURCE_CHANGED'});assert.equal(f.calls.filter(c=>c.type==='open_read_panel').length,0);}
  finally{await f.close();}
});

test('capture stops on changed search parameters and never merges or indexes the other source',async()=>{
  const own=normalizePost({pk:'1',code:'OWN',user:{username:'alice'},caption:{text:'tea-marker'}})!;
  const other=normalizePost({pk:'2',code:'OTHER',user:{username:'bob'},caption:{text:'foreign-marker'}})!;
  const f=readFixture(state=>({url:state.scrolls?'https://www.threads.com/search?q=coffee&serp_type=default':state.url,posts:[state.scrolls?other:own]}));
  try{
    const result=await f.service.discover('tea',2);assert.deepEqual(result.posts.map(p=>p.code),['OWN']);assert.equal(result.pages.length,1);assert.equal(result.completeness,'partial');
    assert.ok(result.warnings.some(w=>/changed source route/.test(w)));assert.equal(f.state.scrolls,1);
    assert.equal((await f.service.index.search('foreign-marker',{mode:'lexical'})).items.some(item=>item.post.code==='OTHER'),false);
  }finally{await f.close();}
});

test('initial wrong capture route fails instead of returning a mislabeled collection',async()=>{
  const f=readFixture(()=>({url:'https://www.threads.com/following'}));
  try{await assert.rejects(f.service.feed('for_you',0),{code:'SOURCE_CHANGED'});}
  finally{await f.close();}
});

test('navigation timeout cannot be salvaged by an equivalent URL from the previous document',async()=>{
  const f=readFixture(()=>({url:'https://threads.net/search/?serp_type=default&q=tea#top'}),true);
  try{
    await assert.rejects(f.service.discover('tea',0),{code:'NAVIGATION_TIMEOUT'});
    assert.equal(f.calls.filter(c=>c.type==='navigate').length,1);assert.equal(f.calls.filter(c=>c.type==='read').length,0);
    assert.equal((await f.service.index.search('tea',{mode:'lexical'})).items.length,0);
  }
  finally{await f.close();}
});

test('navigation timeout performs no follow-up read, indexing or navigation replay',async()=>{
  const other=normalizePost({pk:'2',code:'OTHER',user:{username:'bob'},caption:{text:'foreign-marker'}})!;
  const f=readFixture(()=>({url:'https://www.threads.com/search?q=coffee&serp_type=default',posts:[other]}),true);
  try{
    await assert.rejects(f.service.discover('tea',0),{code:'NAVIGATION_TIMEOUT'});assert.equal((await f.service.index.search('foreign-marker',{mode:'lexical'})).items.length,0);
    assert.equal(f.calls.filter(c=>c.type==='read').length,0);assert.equal(f.calls.filter(c=>c.type==='navigate').length,1);
  }
  finally{await f.close();}
});

const notificationRow={text:'bob liked a post',actorLinks:[{username:'bob',url:'https://www.threads.com/@bob'}],postLinks:[],timeLabel:'1h',timestamp:null,eventId:null};

test('notifications wait for source-bound hydrated rows instead of returning a transient empty first window',async()=>{
  const f=readFixture(state=>({notificationRows:state.reads>=3?[notificationRow]:[],text:state.reads>=3?'bob liked a post':'Activity',warnings:state.reads===1?['Initial source warning.']:[]}),false,1500);
  try{
    const result=await f.service.feed('notifications',0);
    assert.equal(result.notificationRows?.length,1);assert.equal(f.state.reads,3);assert.equal(result.visibleText,'bob liked a post');
    assert.equal(result.completeness,'partial');assert.ok(result.warnings.includes('Initial source warning.'));
    assert.equal(result.warnings.some(w=>w.startsWith('No notification rows')),false);assert.equal(f.calls.filter(c=>c.type==='navigate').length,1);
  }finally{await f.close();}
});

test('a persistently empty notification window stays partial with explicit uncertainty after the bound',async()=>{
  const f=readFixture(()=>({notificationRows:[],text:'Activity'}),false,250);
  try{
    const result=await f.service.feed('notifications',0);assert.deepEqual(result.notificationRows,[]);assert.equal(result.completeness,'partial');
    assert.ok(result.warnings.some(w=>w.includes('may be empty, still loading or unsupported')));assert.ok(f.state.reads>=1);assert.ok(f.state.reads<=3);
  }finally{await f.close();}
});

test('notification readiness accepts observed unknown action rows without inventing a classification',async()=>{
  const row={...notificationRow,text:'bob',actionText:null,badge:{kind:'unknown' as const,signature:null}};
  const f=readFixture(()=>({notificationRows:[row]}));
  try{
    const result=await f.service.feed('notifications',0);assert.equal(f.state.reads,1);assert.equal(result.notificationRows?.[0].badge?.kind,'unknown');
    assert.equal(result.warnings.some(w=>w.startsWith('No notification rows')),false);
  }finally{await f.close();}
});

test('notification readiness stops on a changed source before collecting or indexing its content',async()=>{
  const foreign=normalizePost({pk:'2',code:'FOREIGN',user:{username:'bob'},caption:{text:'foreign-marker'}})!;
  const f=readFixture(state=>({url:state.reads>=2?'https://www.threads.com/following':state.url,notificationRows:state.reads>=2?[notificationRow]:[],posts:state.reads>=2?[foreign]:[]}),false,1500);
  try{
    await assert.rejects(f.service.feed('notifications',0),{code:'SOURCE_CHANGED'});
    assert.equal((await f.service.index.search('foreign-marker',{mode:'lexical'})).items.length,0);
  }finally{await f.close();}
});

test('empty non-notification feeds are not subjected to notification readiness polling',async()=>{
  const f=readFixture(()=>({posts:[],notificationRows:[]}));
  try{const result=await f.service.feed('for_you',0);assert.deepEqual(result.items,[]);assert.equal(f.state.reads,1);assert.equal(result.warnings.some(w=>w.startsWith('No notification rows')),false);}
  finally{await f.close();}
});

const activityUrl='https://www.threads.com/@alice/post/POST';
function activityPage(state:ReadState){
  return {present:state.panel==='likers',targetUrl:activityUrl,targetCode:'POST',selectedTab:state.activityTab as 'likes'|'reposts'|null,
    users:[connectionUser('bob')],counts:{likes:2,reposts:null,views:null},displayedCount:2,busy:false,warnings:[] as string[]};
}

test('post activity opens the requested read-only tab, deduplicates visible users and preserves null metrics',async()=>{
  const f=readFixture(state=>({postActivity:{...activityPage(state),users:state.scrolls?[connectionUser('bob'),connectionUser('carol')]:[connectionUser('bob')]}}));
  try{
    const result=await f.service.postActivity(activityUrl,'likes',1);
    assert.deepEqual(result.items.map(p=>p.username),['bob','carol']);assert.equal(result.completeness,'partial');assert.equal(result.state,'observed-window');
    assert.equal(result.counts.views,null);assert.equal(result.counts.reposts,null);assert.equal(result.displayedCount,2);
    assert.equal(f.calls.filter(c=>c.type==='open_read_panel').length,1);assert.equal(f.calls.find(c=>c.type==='open_read_panel')?.activityTab,'likes');
    assert.equal(f.calls.some(c=>c.type==='interact'||c.type==='social'),false);assert.ok(result.warnings.some(w=>/do not prove absence/.test(w)));
  }finally{await f.close();}
});

test('post activity polling waits for explicitly busy content and then accepts the selected repost tab',async()=>{
  const f=readFixture(state=>({postActivity:{...activityPage(state),busy:state.reads<3}}),false,800);
  try{const result=await f.service.postActivity(activityUrl,'reposts');assert.equal(result.items[0]?.username,'bob');assert.equal(result.kind,'reposts');assert.ok(f.state.reads>=3);}
  finally{await f.close();}
});

test('unconfirmed activity overview or wrong target cannot provide engagement identities or counts',async t=>{
  for(const mode of ['missing','unknown-tab','wrong-tab','absent','busy','wrong-url','wrong-code'] as const)await t.test(mode,async()=>{
    const f=readFixture(state=>({postActivity:mode==='missing'?undefined:{...activityPage(state),
      present:mode!=='absent',busy:mode==='busy',selectedTab:mode==='unknown-tab'?null:mode==='wrong-tab'?'reposts':'likes',
      targetUrl:mode==='wrong-url'?'https://www.threads.com/@alice/post/OTHER':activityUrl,targetCode:mode==='wrong-code'?'OTHER':'POST'}}));
    try{
      const result=await f.service.postActivity(activityUrl,'likes',2);assert.deepEqual(result.items,[]);assert.equal(result.state,'unconfirmed');
      assert.equal(result.displayedCount,null);assert.equal(result.counts.likes,null);assert.equal(f.state.scrolls,0);assert.ok(result.warnings.some(w=>/not confirmed/.test(w)));
    }finally{await f.close();}
  });
});

test('activity scrolling stops on manual tab change, wrong target binding, or busy windows',async t=>{
  for(const mode of ['tab','target','busy'] as const)await t.test(mode,async()=>{
    const f=readFixture(state=>({postActivity:{...activityPage(state),users:[connectionUser(state.scrolls?'foreign':'bob')],
      selectedTab:state.scrolls&&mode==='tab'?'reposts':'likes',targetUrl:state.scrolls&&mode==='target'?'https://www.threads.com/@alice/post/OTHER':activityUrl,
      busy:!!state.scrolls&&mode==='busy'}}));
    try{const result=await f.service.postActivity(activityUrl,'likes',2);assert.deepEqual(result.items.map(p=>p.username),['bob']);assert.equal(f.state.scrolls,1);assert.ok(result.warnings.some(w=>/not merged/.test(w)));}
    finally{await f.close();}
  });
});

test('activity scrolling excludes a changed document route and rejects invalid bounds before navigating',async()=>{
  const f=readFixture(state=>({url:state.scrolls?'https://www.threads.com/@alice/post/OTHER':state.url,postActivity:{...activityPage(state),users:[connectionUser(state.scrolls?'foreign':'bob')]}}));
  try{
    await assert.rejects(f.service.postActivity(activityUrl,'likes',11),{code:'INVALID_INPUT'});assert.equal(f.calls.length,0);
    const result=await f.service.postActivity(activityUrl,'likes',2);assert.deepEqual(result.items.map(p=>p.username),['bob']);assert.equal(result.sourceUrl,activityUrl);assert.ok(result.warnings.some(w=>/changed post route/.test(w)));
  }finally{await f.close();}
});
