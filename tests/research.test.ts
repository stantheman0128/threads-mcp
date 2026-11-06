import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ThreadsResearch} from '../src/research.js';
import {ThreadsService} from '../src/service.js';
import {SearchIndex} from '../src/search.js';
import type {Post} from '../src/types.js';

const post=(code:string,text:string,username='alice'):Post=>({id:code,code,text,author:{username},url:`https://www.threads.com/@${username}/post/${code}`,createdAt:'2026-10-01T00:00:00Z',likes:3,replies:0,reposts:null,quotes:null,views:null,isReply:false,parentId:null,rootId:null,media:[],observedAt:'2026-10-23T00:00:00Z',source:'browser-json'});
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'threads-research-'));
  const index=new SearchIndex(dir,{embeddingModel:'fixture',embedder:async texts=>texts.map(()=>[1,0])});
  const calls:string[]=[];let account='alice';
  const results:Record<string,Post[]>={liked:[post('LIKE','AI search')],saved:[post('SAVE','AI search','bob')],posts:[post('OWN','AI search')],replies:[{...post('REPLY','AI search'),isReply:true}],search:[post('FOUND','AI search','carol')]};
  const response=(kind:string)=>({items:results[kind]??[],sourceUrl:`https://www.threads.com/${kind}`,warnings:[],completeness:'partial',observedAt:'2026-10-23T00:00:00Z'});
  const api={index,browserRead:async()=>({viewer:{username:account}}),feed:async(kind:string)=>{calls.push(kind);return response(kind);},profile:async(name:string,kind:string)=>{calls.push(`${name}:${kind}`);return response(kind);},discover:async(q:string)=>{calls.push(q);return {...response('search'),posts:results.search};},replies:async(url:string)=>{calls.push(`thread:${url}`);return response('replies');}};
  const research=new ThreadsResearch(api as unknown as ThreadsService);
  return {index,research,calls,results,api,setAccount:(name:string)=>{account=name;},close:()=>{index.close();rmSync(dir,{recursive:true,force:true});}};
}
test('research ranks only chosen source collections and retains per-hit provenance',async()=>{
  const f=fixture();try{
    f.index.upsert([post('UNRELATED','AI search')]);
    const result=await f.research.research({query:'AI search',sources:['liked','saved'],mode:'lexical',refresh:true,rounds:0});
    assert.deepEqual(result.items.map(x=>x.post.code).sort(),['LIKE','SAVE']);
    assert.equal(result.account,'alice');assert.equal(result.discoveries.length,2);
    assert.ok(result.items.every(x=>x.observedCollections?.some(c=>c.collection.startsWith('account:alice:'))));
    assert.ok(!f.calls.some(c=>c==='search'));
  }finally{f.close();}
});
test('offline personal research requires account and performs no browser calls',async()=>{
  const f=fixture();try{
    f.index.recordCollection('account:alice:liked',f.results.liked!);
    const result=await f.research.research({query:'AI',sources:['liked'],account:'alice',mode:'lexical',refresh:false,rounds:0});
    assert.equal(result.items.length,1);assert.deepEqual(f.calls,[]);
    await assert.rejects(f.research.research({query:'AI',sources:['liked'],mode:'lexical',refresh:false,rounds:0}),/requires the account/);
  }finally{f.close();}
});
test('manual account change prevents attributing the new account feed to the old collection',async()=>{
  const f=fixture();try{
    f.api.feed=async kind=>{f.setAccount('bob');return {items:f.results.liked!,sourceUrl:`https://www.threads.com/${kind}`,warnings:[],completeness:'partial',observedAt:'2026-10-23T00:00:00Z'};};
    await assert.rejects(f.research.activity('liked',0),/account differs/);
    const result=await f.index.search('AI',{mode:'lexical',collections:['account:alice:liked']});assert.equal(result.items.length,0);
  }finally{f.close();}
});
test('discovery retains every captured page window and optional replies with source evidence',async()=>{
  const f=fixture();try{
    f.results.search=[{...post('ROOT','AI search','carol'),replies:2},post('EARLIER','AI search','dave')];
    const result=await f.research.research({query:'AI search',queries:['人工智慧','AI'],sources:['search'],mode:'lexical',refresh:true,rounds:1,includeReplies:true});
    assert.ok(result.items.some(x=>x.post.code==='EARLIER'));assert.ok(result.items.some(x=>x.post.code==='REPLY'));
    assert.deepEqual(f.calls.slice(0,2),['人工智慧','AI']);assert.equal(result.discoveries.filter(d=>d.source==='thread-replies').length,1);
  }finally{f.close();}
});
test('mention matches distinguish exact dotted handles from longer handles and brand candidates',async()=>{
  const f=fixture();try{
    f.results.search=[post('EXACT','謝謝@stan.foo for AI'),post('OTHER','Thanks @stanXfoo'),post('LONG','Thanks @stan.foo.bar'),post('EMAIL','email@stan.foo'),post('SELF','I am @stan.foo','stan.foo'),post('BRAND','Stan Studio product')];
    const result=await f.research.mentions({username:'stan.foo',terms:['Stan Studio'],refresh:true,rounds:0,limit:10});
    assert.deepEqual(result.items.map(x=>[x.post.code,x.mentionKind]),[['EXACT','explicit-handle'],['BRAND','name-or-brand-candidate']]);
    f.results.search=[];
    const empty=await f.research.mentions({username:'nobody',refresh:true,rounds:0,limit:10});assert.equal(empty.state,'unknown');
  }finally{f.close();}
});
test('long natural-language queries use bounded deterministic collection keys',async()=>{
  const f=fixture();try{
    const query='AI'.repeat(150);
    const refreshed=await f.research.research({query,sources:['search'],mode:'lexical',refresh:true,rounds:0});
    assert.ok(refreshed.discoveries[0]!.collection.length<=200);
    const cached=await f.research.research({query,sources:['search'],mode:'lexical',refresh:false,rounds:0});
    assert.equal(cached.discoveries[0]?.collection,refreshed.discoveries[0]?.collection);
  }finally{f.close();}
});
test('positive post/reply contradictions repair only misclassified memberships',async()=>{
  const f=fixture();try{
    const reply={...post('OLD_REPLY','AI search'),isReply:true};
    f.index.recordCollection('account:alice:posts',[reply,post('UNSEEN','AI search')]);
    f.index.recordCollection('account:alice:replies',[reply]);
    f.api.profile=async()=>({items:f.results.posts!,contextualPosts:[reply],sourceUrl:'https://www.threads.com/@alice',warnings:[],completeness:'partial',observedAt:'2026-10-23T00:00:00Z'});
    await f.research.activity('posts',0);
    const posts=await f.index.search('AI',{mode:'lexical',collections:['account:alice:posts']});
    assert.deepEqual(posts.items.map(x=>x.post.code).sort(),['OWN','UNSEEN']);
    const replies=await f.index.search('AI',{mode:'lexical',collections:['account:alice:replies']});assert.equal(replies.items[0]?.post.code,'OLD_REPLY');
  }finally{f.close();}
});
test('discovery failures remain visible and diversity caps do not imply complete recall',async()=>{
  const f=fixture();try{
    f.index.recordCollection('account:alice:liked',[post('A','AI'),post('B','AI'),post('C','AI','bob')]);
    f.api.feed=async()=>{throw Object.assign(new Error('timeout'),{code:'NAVIGATION_TIMEOUT'});};
    const result=await f.research.research({query:'AI',sources:['liked'],mode:'lexical',refresh:true,rounds:0,maxPerAuthor:1});
    assert.equal(result.items.length,2);assert.equal(result.discoveries[0]?.status,'failed');assert.equal(result.completeness,'partial');
    assert.ok(result.warnings.some(w=>w.includes('cached observations')));
  }finally{f.close();}
});
