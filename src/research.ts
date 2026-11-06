import {ThreadsService} from './service.js';
import {ThreadsError,type Post} from './types.js';
import {handle} from './urls.js';
import {classifyMentionText,type SearchOptions} from './search.js';
import {createHash} from 'node:crypto';
import {normalizeNotificationRows} from './observations.js';

export type ActivityKind='posts'|'replies'|'reposts'|'liked'|'saved';
export type ResearchSource='search'|'local'|'liked'|'saved'|'my_posts'|'my_replies'|'profiles';
export interface ResearchOptions extends SearchOptions {
  query:string;queries?:string[];sources:ResearchSource[];usernames?:string[];account?:string;
  refresh:boolean;rounds:number;includeReplies?:boolean;maxPerAuthor?:number;
}
const unique=(values:string[])=>[...new Set(values.map(value=>value.trim()).filter(Boolean))];
const collectionFor=(account:string,kind:ActivityKind)=>`account:${handle(account)}:${kind}`;
const searchCollection=(query:string)=>{
  const normalized=query.normalize('NFKC').toLocaleLowerCase('en').trim();
  return normalized.length<=193?`search:${normalized}`:`search:sha256:${createHash('sha256').update(normalized).digest('hex')}`;
};
const historyWarning='Collections record historical observations from partial page windows. A previously liked or saved item is not guaranteed to remain liked or saved now.';

export class ThreadsResearch {
  constructor(private readonly service:ThreadsService){}
  private async viewer(expected?:string){
    const page=await this.service.browserRead();
    const name=page.viewer.username&&handle(page.viewer.username);
    if(!name)throw new ThreadsError('UNKNOWN_ACCOUNT','The signed-in account was not observed.');
    if(expected&&name!==handle(expected))throw new ThreadsError('ACCOUNT_MISMATCH','The selected browser account differs from the requested account.');
    return name;
  }
  async activity(kind:ActivityKind,rounds=1,expectedAccount?:string){
    const account=await this.viewer(expectedAccount);
    const result=kind==='liked'||kind==='saved'?await this.service.feed(kind,rounds):await this.service.profile(account,kind,rounds);
    await this.viewer(account); // Do not attribute another account's feed after a manual account switch.
    const collection=collectionFor(account,kind);
    if('contextualPosts' in result&&['posts','replies'].includes(kind)){
      const contradicted=result.contextualPosts.filter(post=>post.author.username.toLowerCase()===account&&(kind==='posts'?post.isReply===true:post.isReply===false));
      // Repair positive classification contradictions, never absence from a partial refresh.
      this.service.index.removeCollectionMembers(collection,contradicted.map(post=>post.id));
    }
    this.service.index.recordCollection(collection,result.items);
    return {...result,account,kind,collection,warnings:[...result.warnings,historyWarning]};
  }
  async notifications(rounds=1){
    const account=await this.viewer();
    const result=await this.service.feed('notifications',rounds);
    await this.viewer(account);
    const events=normalizeNotificationRows(result.notificationRows??[],{sourceUrl:result.sourceUrl,observedAt:result.observedAt});
    return {...result,events,account,state:events.length?'observed-rows':'unknown',interpretation:'Row-local notification candidates with actors, links and observed timestamps. Unknown event types remain unknown; this is not complete notification history. Opening the view may update notification read state.'};
  }
  async research(args:ResearchOptions){
    const sources=[...new Set(args.sources)];
    if(!sources.length)throw new ThreadsError('INVALID_INPUT','Choose at least one research source.');
    const queries=unique(args.queries?.length?args.queries:[args.query]).slice(0,5);
    const usernames=unique(args.usernames??[]).map(handle).slice(0,5);
    if(sources.includes('profiles')&&!usernames.length)throw new ThreadsError('INVALID_INPUT','Profile research requires at least one username.');
    const personal=sources.some(source=>['liked','saved','my_posts','my_replies'].includes(source));
    const account=personal?(args.refresh?await this.viewer(args.account):args.account?handle(args.account):null):null;
    if(personal&&!account)throw new ThreadsError('UNKNOWN_ACCOUNT','Offline personal-source research requires the account username.');
    const collections=new Set<string>();
    const discoveries:Array<{source:string;collection:string;url?:string;observed:number;status:'observed'|'cached'|'failed';error?:string}>=[];
    const warnings:string[]=[historyWarning];
    const tasks:Array<{source:string;collection:string;run:()=>Promise<{items:Post[];sourceUrl?:string;warnings:string[]}>}>=[];
    if(sources.includes('search'))for(const query of queries){
      const collection=searchCollection(query);collections.add(collection);
      tasks.push({source:`search:${query}`,collection,run:async()=>{
        // Candidate discovery is lexical; the user's original question is used once
        // for final semantic ranking across every selected source.
        const result=await this.service.discover(query,args.rounds);
        return {items:result.posts,sourceUrl:result.sourceUrl,warnings:result.warnings};
      }});
    }
    for(const source of sources){
      const kind=source==='my_posts'?'posts':source==='my_replies'?'replies':source;
      if(['posts','replies','liked','saved'].includes(kind)){
        const collection=collectionFor(account!,kind as ActivityKind);collections.add(collection);
        tasks.push({source,collection,run:()=>this.activity(kind as ActivityKind,args.rounds,account!)});
      }
    }
    if(sources.includes('profiles'))for(const username of usernames){
      const collection=`profile:${username}:posts`;collections.add(collection);
      tasks.push({source:`profile:${username}`,collection,run:()=>this.service.profile(username,'posts',args.rounds)});
    }
    if(tasks.length>10)throw new ThreadsError('DISCOVERY_BUDGET','At most ten source/query visits are allowed per research request. Reduce variants or profiles.');
    for(const task of tasks){
      if(!args.refresh){discoveries.push({source:task.source,collection:task.collection,observed:0,status:'cached'});continue;}
      try{
        const result=await task.run();this.service.index.recordCollection(task.collection,result.items);
        discoveries.push({source:task.source,collection:task.collection,url:result.sourceUrl,observed:result.items.length,status:'observed'});
        warnings.push(...result.warnings);
      }catch(error){
        const code=(error as {code?:string}).code??'DISCOVERY_FAILED';
        if(['ACCOUNT_MISMATCH','UNKNOWN_ACCOUNT'].includes(code))throw error;
        discoveries.push({source:task.source,collection:task.collection,observed:0,status:'failed',error:code});
        warnings.push(`Source ${task.source} could not be refreshed (${code}); cached observations may still appear.`);
      }
    }
    const options:SearchOptions={...args,collections:sources.includes('local')?undefined:[...collections],limit:100};
    let ranked=await this.service.index.search(args.query,options);
    if(args.refresh&&args.includeReplies){
      const roots=ranked.items.filter(hit=>hit.post.code&&hit.post.isReply!==true&&(hit.post.replies??0)>0).slice(0,3);
      for(const {post} of roots){
        const collection=`thread:${post.code}`;
        try{
          const result=await this.service.replies(post.url,Math.min(1,args.rounds));
          this.service.index.recordCollection(collection,result.items);collections.add(collection);
          discoveries.push({source:'thread-replies',collection,url:post.url,observed:result.items.length,status:'observed'});
          warnings.push(...result.warnings);
        }catch(error){warnings.push(`Could not expand replies for ${post.url} (${(error as {code?:string}).code??'DISCOVERY_FAILED'}).`);}
      }
      ranked=await this.service.index.search(args.query,{...options,collections:sources.includes('local')?undefined:[...collections]});
    }
    const perAuthor=new Map<string,number>();
    const items=ranked.items.filter(hit=>{
      const author=hit.post.author.username.toLowerCase();const count=perAuthor.get(author)??0;
      if(args.maxPerAuthor&&count>=args.maxPerAuthor)return false;perAuthor.set(author,count+1);return true;
    }).slice(0,args.limit??20);
    return {...ranked,items,query:args.query,queriesUsed:queries,sources,account,discoveries,
      warnings:unique([...ranked.warnings,...warnings]),completeness:'partial',
      coverage:'Search discovers bounded candidate pages; embeddings rank observed candidates and cached selected collections. No global Threads recall guarantee.',
      ranking:{mode:args.mode,maxPerAuthor:args.maxPerAuthor??null,queryExpansion:'Caller-supplied variants; no hidden LLM or external embedding API.'}};
  }
  async mentions(args:{username?:string;terms?:string[];refresh:boolean;rounds:number;limit:number;includeSelf?:boolean}){
    const username=args.username?handle(args.username):await this.viewer();
    const terms=unique(args.terms??[]).slice(0,4);
    const query=`@${username}`;
    const result=await this.research({query,queries:[query,...terms],sources:['search'],refresh:args.refresh,rounds:args.rounds,mode:'hybrid',limit:100,
      mentionFilter:{username,terms,excludeSelf:!args.includeSelf}});
    const candidates=result.items.flatMap(hit=>{
      const match=classifyMentionText(hit.post.text,username,terms);
      return match?[{...hit,mentionKind:match.kind,matchedTerms:match.matchedTerms}]:[];
    }).sort((a,b)=>Number(b.mentionKind==='explicit-handle')-Number(a.mentionKind==='explicit-handle')||b.score-a.score).slice(0,args.limit);
    return {...result,items:candidates,username,includeSelf:!!args.includeSelf,state:candidates.length?'observed-candidates':'unknown',
      warnings:unique([...result.warnings,'No matching observed text does not establish that nobody mentioned this account. Display-name or brand matches are candidates, not identity proof.'])};
  }
}
