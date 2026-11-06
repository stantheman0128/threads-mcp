import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ThreadsObservations,normalizeNotificationRows,parseAccountInsights} from '../src/observations.js';
import type {ThreadsService} from '../src/service.js';
import type {Post} from '../src/types.js';

const post=(code:string,likes:number|null=2,username='alice'):Post=>({id:code,code,text:`text ${code}`,author:{username},url:`https://www.threads.com/@${username}/post/${code}`,createdAt:'2026-10-01T00:00:00Z',likes,replies:null,reposts:null,quotes:null,views:null,isReply:false,parentId:null,rootId:null,media:[],observedAt:'2026-10-23T00:00:00Z',source:'browser-json'});
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'threads-observations-'));let account='alice';
  const calls:string[]=[];const collections=new Map<string,Post[]>();const results={posts:[post('ROOT')],replies:[{...post('REPLY',null,'bob'),isReply:true}],search:[post('SEARCH')]};
  const response=(items:Post[])=>({items,sourceUrl:'https://www.threads.com/@alice/post/ROOT',observedAt:'2026-10-23T00:00:00Z',warnings:[]});
  const api={index:{recordCollection:(key:string,posts:Post[])=>collections.set(key,posts)},
    browserRead:async(url?:string)=>({url:url??'https://www.threads.com/',viewer:{username:account},text:'',observedAt:'2026-10-23T00:00:00Z',warnings:[] as string[]}),
    profile:async(username:string)=>{calls.push(`profile:${username}`);return {...response(results.posts),profile:null};},
    replies:async(url:string)=>{calls.push(`replies:${url}`);return response(results.replies);},
    discover:async(query:string)=>{calls.push(`search:${query}`);return {...response(results.search),posts:results.search};}};
  return {dir,api,calls,results,collections,observations:new ThreadsObservations(api as unknown as ThreadsService,dir),setAccount:(name:string)=>{account=name;},close:()=>rmSync(dir,{recursive:true,force:true})};
}
test('notification normalization retains unknown rows and only row-local validated actors',()=>{
  const rows=[{text:'alice liked your post',actorLinks:[{username:'alice',url:'https://www.threads.com/@alice'},{username:'mallory',url:'https://evil.example/@mallory'},{username:'eve',url:'https://www.threads.com/@other'}],postLinks:['https://www.threads.com/@me/post/ABC','https://evil.example/post/BAD'],timeLabel:'2h'},
    {text:'bob followed you; alice mentioned you',actorLinks:[],postLinks:[]}];
  const result=normalizeNotificationRows([...rows,rows[0]!],{sourceUrl:'https://www.threads.com/activity',observedAt:'2026-10-24T00:00:00Z'});
  assert.equal(result.length,2);assert.equal(result[0]?.kind,'like');assert.deepEqual(result[0]?.actors.map(actor=>actor.username),['alice']);
  assert.equal(result[0]?.postUrls.length,1);assert.equal(result[0]?.createdAt,null);assert.equal(result[1]?.kind,'unknown');assert.deepEqual(result[1]?.actors,[]);
  assert.equal(result[0]?.provenance.identity,'observation-fingerprint');
});
test('observed notification badge semantics distinguish identical rows and preserve grouped counts without invented actors',()=>{
  const row={text:'alice and 201 others mentioned you in a quoted preview',actorLinks:[{username:'alice',url:'https://www.threads.com/@alice'}],postLinks:['https://www.threads.com/@viewer/post/ABC'],timeLabel:'2h',additionalActorCount:201};
  const meta={sourceUrl:'https://www.threads.com/activity',observedAt:'2026-10-24T00:00:00Z'};
  const result=normalizeNotificationRows([{...row,badge:{kind:'like',signature:'threads-18-like-v1'}},{...row,badge:{kind:'reply',signature:'threads-18-reply-v1'}}],meta);
  assert.equal(result.length,2);assert.deepEqual(result.map(event=>event.kind),['like','reply']);assert.ok(result.every(event=>event.kindEvidence==='observed-badge'));
  assert.equal(result[0]?.additionalActorCount,201);assert.equal(result[0]?.actors.length,1);
  const changed=normalizeNotificationRows([{...row,badge:{kind:'unknown',signature:null}}],meta);assert.equal(changed[0]?.kind,'unknown');
  const conflicting=normalizeNotificationRows([{...row,actionText:'已追蹤你',badge:{kind:'like',signature:'threads-18-like-v1'}}],meta);assert.equal(conflicting[0]?.kind,'unknown');
  assert.equal(normalizeNotificationRows([{...row,actionText:'已追蹤你'}],meta)[0]?.kind,'follow');
});
test('incremental refresh persists dedupe and value updates without claiming pagination or absence',async()=>{
  const f=fixture();try{
    f.results.search=[post('A'),post('A'),post('B',null)];
    const first=await f.observations.collect({source:'search',target:'AI'});assert.equal(first.delta.added.length,2);
    f.results.search=[post('A',4),post('C',null)];
    const reopened=new ThreadsObservations(f.api as unknown as ThreadsService,f.dir);
    const second=await reopened.collect({source:'search',target:'AI',checkpoint:first.checkpoint.id});
    assert.deepEqual(second.delta.updated.map(post=>post.code),['A']);assert.deepEqual(second.delta.added.map(post=>post.code),['C']);
    assert.equal(second.checkpoint.historicalDistinctObserved,3);assert.equal(second.continuation.mode,'refresh-from-top');assert.equal(second.continuation.exhausted,null);
    const analytics=await reopened.analytics({key:second.analyticsKey});assert.equal(analytics.series.length,2);
    assert.equal(analytics.changes[0]?.metrics.likes.delta,2);assert.equal(analytics.changes[0]?.metrics.likes.comparablePosts,1);
    await assert.rejects(reopened.collect({source:'search',target:'Other',checkpoint:first.checkpoint.id}),/cannot change/);
  }finally{f.close();}
});
test('checkpoint account switch fails before persistence and cannot be resumed by another account',async()=>{
  const f=fixture();try{
    const first=await f.observations.collect({source:'profile',target:'alice'});const before=readFileSync(join(f.dir,'observations.json'),'utf8');
    f.setAccount('bob');await assert.rejects(f.observations.collect({source:'profile',target:'alice',checkpoint:first.checkpoint.id}),/account changed/);
    f.setAccount('alice');f.api.profile=async()=>{f.setAccount('bob');return {items:f.results.posts,profile:null,sourceUrl:'https://www.threads.com/@alice',observedAt:'2026-10-23T00:00:00Z',warnings:[]};};
    await assert.rejects(f.observations.collect({source:'profile',target:'alice',checkpoint:first.checkpoint.id}),/account changed/);
    assert.equal(readFileSync(join(f.dir,'observations.json'),'utf8'),before);
  }finally{f.close();}
});
test('reply inbox bounds root visits, excludes own replies, deduplicates incoming posts and reports failed windows',async()=>{
  const f=fixture();try{
    f.results.posts=[post('R1'),post('R2'),post('R3')];f.results.replies=[{...post('IN',null,'bob'),isReply:true},{...post('SELF'),isReply:true}];
    f.api.replies=async(url:string)=>{f.calls.push(url);if(url.endsWith('R2'))throw Object.assign(new Error('timeout'),{code:'NAVIGATION_TIMEOUT'});return {items:f.results.replies,sourceUrl:url,observedAt:'2026-10-23T00:00:00Z',warnings:[]};};
    const result=await f.observations.replyInbox({maxPosts:2,includeMentions:false});
    assert.equal(result.rootsVisited.length,2);assert.equal(result.items.length,1);assert.equal(result.items[0]?.post.code,'IN');assert.equal(result.failures[0]?.error,'NAVIGATION_TIMEOUT');
    assert.equal(result.completeness,'partial');assert.ok(!f.calls.some(call=>call.endsWith('R3')));
  }finally{f.close();}
});
test('analytics does not turn missing metrics or changing sample membership into growth',async()=>{
  const f=fixture();try{
    await f.observations.snapshot({key:'sample',posts:[post('A',10),post('B',null)]});
    await f.observations.snapshot({key:'sample',posts:[post('A',null),post('C',200)]});
    const result=await f.observations.analytics({key:'sample'});
    assert.deepEqual(result.series[1]?.metrics.likes,{sum:200,known:1,missing:1});assert.deepEqual(result.changes[0]?.metrics.likes,{delta:null,comparablePosts:0});
    assert.deepEqual(result.series[0]?.metrics.views,{sum:null,known:0,missing:2});
  }finally{f.close();}
});
test('trend samples report source failures and persist independent query time series',async()=>{
  const f=fixture();try{
    f.api.discover=async query=>{if(query==='blocked')throw Object.assign(new Error('blocked'),{code:'LOGIN_REQUIRED'});return {items:f.results.search,posts:f.results.search,sourceUrl:'https://www.threads.com/search?q=AI',observedAt:'2026-10-23T00:00:00Z',warnings:[]};};
    const result=await f.observations.trends({queries:['AI','AI','blocked']});
    assert.equal(result.items.length,1);assert.equal(result.failures[0]?.error,'LOGIN_REQUIRED');
    assert.equal((await f.observations.analytics({key:'trend:AI'})).series.length,1);
  }finally{f.close();}
});
test('insights parser anchors counts to exact summary labels and retains missing values',()=>{
  const summary=parseAccountInsights('總覽\n過去30天\n摘要\n檢視次數\n1,234\n-18.3%\n瀏覽人數\n789\n-4.3%\n淨追蹤者人數\n+3\n+8.0%\n互動次數\n20\n+253.5%\n受眾\n檢視次數\n999999');
  assert.equal(summary.periodLabel,'過去30天');assert.equal(summary.metrics.views.value,1234);assert.equal(summary.metrics.views.comparisonPercent,-18.3);assert.equal(summary.metrics.netFollowers.value,3);
  const missing=parseAccountInsights('檢視次數\n999\n摘要\n互動次數\n--\n受眾\n檢視次數\n888');
  assert.equal(missing.metrics.views.value,null);assert.equal(missing.metrics.interactions.value,null);
  assert.equal(parseAccountInsights('Summary\nViews\n1.2K').metrics.views.value,null);
});
test('own insights persists report summaries with account isolation and never treats percentages as absolute counts',async()=>{
  const f=fixture();try{
    f.api.browserRead=async()=>({url:'https://www.threads.com/insights/',viewer:{username:'alice'},text:'Overview\nLast 30 days\nSummary\nViews\n50\n+10.0%\nInteractions\n7',observedAt:'2026-10-23T00:00:00Z',warnings:[]});
    const result=await f.observations.accountInsights({account:'alice',includeHistory:true});assert.equal(result.state,'observed-summary');assert.equal(result.metrics.views.value,50);assert.equal(result.history?.length,1);
    await assert.rejects(f.observations.accountInsights({account:'bob'}),/account changed/);
  }finally{f.close();}
});
