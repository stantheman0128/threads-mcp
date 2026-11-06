import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {ThreadsService} from './service.js';
import {ThreadsResearch} from './research.js';
import {ThreadsError,type Post,type Profile} from './types.js';
import {handle,postTarget,profileUrl} from './urls.js';

export interface NotificationRowEvidence {
  text:string;actorLinks:Array<{username:string;url:string}>;postLinks:string[];
  timeLabel?:string|null;timestamp?:string|null;eventId?:string|null;actionText?:string|null;
  additionalActorCount?:number|null;badge?:{kind:'like'|'reply'|'follow'|'unknown';signature:string|null};
}
export type NotificationKind='like'|'reply'|'mention'|'repost'|'quote'|'follow'|'unknown';
export interface NotificationEvent {
  id:string;kind:NotificationKind;text:string;actors:Array<{username:string;url:string}>;
  postUrls:string[];createdAt:string|null;timeLabel:string|null;
  additionalActorCount:number|null;kindEvidence:'observed-badge'|'action-label'|'row-text-candidate'|'unknown';badgeSignature:string|null;
  provenance:{source:'browser-dom';sourceUrl:string;observedAt:string;identity:'site-event-id'|'observation-fingerprint'};
  warnings:string[];
}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const unique=<T>(values:T[])=>[...new Set(values)];
const partialWarning='Only bounded observed page windows are represented; missing items and counts do not prove absence or complete history.';
const validTime=(value:string|undefined|null)=>value&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
function notificationKind(text:string):NotificationKind {
  // A row can contain post content as well as action text. Multiple action signals
  // deliberately remain unknown rather than selecting the first match.
  const patterns:Array<[NotificationKind,RegExp]>=[
    ['like',/\b(?:liked your|likes your)\b|對你的.+(?:按讚|讚好)|說你的.+讚|讚了你的/iu],
    ['reply',/\b(?:replied to you|replied to your|responded to your)\b|回覆了你|回覆你的/iu],
    ['mention',/\bmentioned you\b|提及了你|提到了你|標註了你/iu],
    ['repost',/\breposted your\b|轉發了你|轉發你的/iu],
    ['quote',/\bquoted your\b|引用了你|引用你的/iu],
    ['follow',/\b(?:started following you|followed you)\b|開始追蹤你|追蹤了你|已追蹤你/iu],
  ];
  const matches=patterns.filter(([,pattern])=>pattern.test(text));
  return matches.length===1?matches[0]![0]:'unknown';
}
/** Requires row-local DOM evidence; never pass flattened whole-page text as a row. */
export function normalizeNotificationRows(rows:NotificationRowEvidence[],meta:{sourceUrl:string;observedAt:string}):NotificationEvent[]{
  const events=new Map<string,NotificationEvent>();
  for(const row of rows.slice(0,1000)){
    const text=row.text.trim().slice(0,10000);if(!text)continue;
    const actors:NotificationEvent['actors']=[];
    for(const actor of row.actorLinks){try{
      const name=handle(actor.username);const url=new URL(actor.url,meta.sourceUrl);
      if(!['threads.com','www.threads.com','threads.net','www.threads.net'].includes(url.hostname)||url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||url.pathname.replace(/\/$/,'').toLowerCase()!==`/@${name}`)continue;
      if(!actors.some(item=>item.username===name))actors.push({username:name,url:profileUrl(name)});
    }catch{/* Unvalidated links are not actor evidence. */}}
    const postUrls:string[]=[];
    for(const url of row.postLinks){try{postUrls.push(postTarget(url).url);}catch{/* Keep malformed target links out of results. */}}
    const timestamp=validTime(row.timestamp);const labelKind=row.actionText?notificationKind(row.actionText):'unknown';
    const conflict=row.badge&&row.badge.kind!=='unknown'&&labelKind!=='unknown'&&row.badge.kind!==labelKind;
    const kind=conflict?'unknown':row.badge?(row.badge.kind==='unknown'?labelKind:row.badge.kind):notificationKind(row.actionText??text);
    const kindEvidence=kind==='unknown'?'unknown':row.badge?.kind===kind?'observed-badge':row.actionText?'action-label':'row-text-candidate';
    const id=row.eventId?`event:${hash(row.eventId)}`:`observation:${hash(JSON.stringify([text,actors.map(a=>a.username).sort(),unique(postUrls).sort(),timestamp,row.timeLabel??null,row.badge?.signature??null,row.additionalActorCount??null]))}`;
    events.set(id,{id,kind,text,actors,postUrls:unique(postUrls),createdAt:timestamp,timeLabel:row.timeLabel??null,
      additionalActorCount:Number.isSafeInteger(row.additionalActorCount)&&row.additionalActorCount!>=0?row.additionalActorCount!:null,kindEvidence,badgeSignature:row.badge?.signature??null,
      provenance:{source:'browser-dom',...meta,identity:row.eventId?'site-event-id':'observation-fingerprint'},
      warnings:[...(!actors.length?['No row-local actor link was observed; names in text are not asserted as actors.']:[]),
        ...(kindEvidence==='row-text-candidate'?['Action classification is a row-text candidate; quoted post text can make the action ambiguous.']:[]),
        ...(kind==='unknown'?['Notification action could not be classified unambiguously.']:[]),
        ...(!row.eventId?['Fingerprint deduplicates identical observations only; relative-time or text changes may represent the same event.']:[])]});
  }
  return [...events.values()];
}

export interface CollectionRequest {source:'search'|'profile'|'replies';target:string;rounds?:number;checkpoint?:string;}
interface Checkpoint {
  id:string;source:string;target:string;account:string|null;createdAt:string;updatedAt:string;
  passes:number;seen:Record<string,string>;sourceUrls:string[];
}
const metrics=['likes','replies','reposts','quotes','views'] as const;
type Metric=typeof metrics[number];
interface Sample {observedAt:string;sourceUrls:string[];posts:Array<{id:string;createdAt:string|null;author:string;counts:Record<Metric,number|null>}>;profile:{username:string;followers:number|null;following:number|null}|null;}
const insightLabels={views:['檢視次數','Views'],viewers:['瀏覽人數','Viewers'],netFollowers:['淨追蹤者人數','Net followers'],interactions:['互動次數','Interactions']} as const;
type InsightMetric=keyof typeof insightLabels;
export interface AccountInsightSummary {periodLabel:string|null;metrics:Record<InsightMetric,{value:number|null;rawValue:string|null;comparisonPercent:number|null}>;}
/** Only exact label/value adjacency inside the bounded summary section is parsed. */
export function parseAccountInsights(text:string):AccountInsightSummary {
  const lines=text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  const start=lines.findIndex(line=>['摘要','Summary'].includes(line));
  const periodLabel=start<0?null:lines.slice(Math.max(0,start-15),start).reverse().find(line=>/^(?:過去\s*\d+\s*天|Last\s+\d+\s+days|今天|昨天|Today|Yesterday)$/i.test(line))??null;
  const section=start<0?[]:lines.slice(start+1,start+30);
  const stop=section.findIndex(line=>/^(?:受眾|粉絲|內容|熱門貼文|活動|Audience|Followers|Content|Top posts|Activity)$/i.test(line));
  const summary=stop<0?section:section.slice(0,stop);
  const count=(raw:string|undefined)=>raw&&/^[+\-]?(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(raw)?Number(raw.replaceAll(',','')):null;
  return {periodLabel,metrics:Object.fromEntries(Object.entries(insightLabels).map(([metric,labels])=>{
    const index=summary.findIndex(line=>(labels as readonly string[]).includes(line));const raw=index<0?undefined:summary[index+1];
    const percentage=index<0?undefined:summary[index+2];
    return [metric,{value:count(raw),rawValue:raw??null,comparisonPercent:percentage&&/^[+\-]?\d+(?:\.\d+)?%$/.test(percentage)?Number(percentage.slice(0,-1)):null}];
  })) as AccountInsightSummary['metrics']};
}
interface InsightSample extends AccountInsightSummary {observedAt:string;sourceUrl:string;}
interface State {version:1;checkpoints:Record<string,Checkpoint>;series:Record<string,Sample[]>;insights?:Record<string,InsightSample[]>;}
const identity=(post:Post)=>post.code?`code:${post.code}`:`id:${post.id}`;
const fingerprint=(post:Post)=>hash(JSON.stringify({text:post.text,author:post.author,createdAt:post.createdAt,counts:metrics.map(metric=>post[metric]),isReply:post.isReply,parentId:post.parentId,rootId:post.rootId,media:post.media}));
const bounded=(value:number|undefined,fallback:number,max:number)=>Math.max(0,Math.min(max,Number.isFinite(value)?Math.floor(value!):fallback));
const trendKey=(query:string)=>query.length<=194?`trend:${query}`:`trend:sha256:${hash(query)}`;

export class ThreadsObservations {
  private readonly statePath:string;
  private readonly research:ThreadsResearch;
  private queue:Promise<unknown>=Promise.resolve();
  constructor(private readonly service:ThreadsService,dataDir:string){
    mkdirSync(dataDir,{recursive:true});this.statePath=join(dataDir,'observations.json');this.research=new ThreadsResearch(service);
  }
  private serial<T>(fn:()=>Promise<T>){const task=this.queue.then(fn);this.queue=task.catch(()=>{});return task;}
  private state():State {
    if(!existsSync(this.statePath))return {version:1,checkpoints:{},series:{}};
    try{const data=JSON.parse(readFileSync(this.statePath,'utf8')) as State;
      if(data.version!==1||!data.checkpoints||!data.series)throw new Error();return data;
    }catch{throw new ThreadsError('OBSERVATIONS_STATE_INVALID','Local observation state is unreadable; preserve it for diagnosis before attempting recovery.');}
  }
  private save(state:State){const tmp=`${this.statePath}.${randomUUID()}.tmp`;writeFileSync(tmp,JSON.stringify(state),{mode:0o600});renameSync(tmp,this.statePath);}
  private key(key:string){if(!key.trim()||key.length>200)throw new ThreadsError('INVALID_INPUT','Observation key must contain 1–200 characters.');return `key:${hash(key)}`;}
  private async viewer(expected?:string){const page=await this.service.browserRead();const account=page.viewer.username?handle(page.viewer.username):null;
    if(!account)throw new ThreadsError('UNKNOWN_ACCOUNT','The selected account could not be observed.');
    if(expected&&account!==handle(expected))throw new ThreadsError('ACCOUNT_MISMATCH','Selected account changed or differs from the requested account.');return account;
  }
  private record(state:State,key:string,posts:Post[],sourceUrls:string[],profile?:Profile|null){
    const sample:Sample={observedAt:new Date().toISOString(),sourceUrls:unique(sourceUrls),profile:profile?{username:profile.username,followers:profile.followers,following:profile.following}:null,
      posts:[...new Map(posts.map(post=>[identity(post),post])).values()].map(post=>({id:identity(post),createdAt:post.createdAt,author:post.author.username,counts:Object.fromEntries(metrics.map(metric=>[metric,post[metric]])) as Record<Metric,number|null>}))};
    const slot=this.key(key);state.series[slot]=[...(state.series[slot]??[]),sample].slice(-100);return sample;
  }
  accountInsights(args:{account?:string;includeHistory?:boolean}={}){return this.serial(async()=>{
    const account=await this.viewer(args.account);let page=await this.service.browserRead('https://www.threads.com/insights/');
    let summary=parseAccountInsights(page.text);
    for(let attempt=0;attempt<3&&!Object.values(summary.metrics).some(metric=>metric.value!==null);attempt++){
      if(!page.viewer.username||handle(page.viewer.username)!==account)throw new ThreadsError('ACCOUNT_MISMATCH','Selected account changed while reading insights.');
      await new Promise(resolve=>setTimeout(resolve,800));page=await this.service.browserRead();summary=parseAccountInsights(page.text);
    }
    if(!page.viewer.username||handle(page.viewer.username)!==account)throw new ThreadsError('ACCOUNT_MISMATCH','Selected account changed while reading insights.');
    await this.viewer(account);
    if(new URL(page.url).pathname.replace(/\/$/,'')!=='/insights')throw new ThreadsError('CONTEXT_CHANGED','Insights page changed before the report was observed.');
    const state=this.state();const key=this.key(account);const sample:InsightSample={...summary,observedAt:page.observedAt,sourceUrl:page.url};
    const available=Object.values(summary.metrics).some(metric=>metric.value!==null);
    state.insights??={};if(available){state.insights[key]=[...(state.insights[key]??[]),sample].slice(-100);this.save(state);}
    return {account,...sample,visibleText:page.text,state:available?'observed-summary':'unknown',history:args.includeHistory?state.insights[key]??[]:undefined,
      completeness:'partial',warnings:[...page.warnings,'Only the selected account Insights summary is normalized. Visible labels determine the period and comparison percentages; unavailable metrics remain null.',
        'Saved observations are rolling-period report snapshots, not daily metrics or reconstructed historical growth. Other report sections remain visible text.']};
  });}
  collect(args:CollectionRequest){return this.serial(async()=>{
    const target=args.source==='profile'?handle(args.target):args.source==='replies'?postTarget(args.target).url:args.target.trim();
    if(!target||target.length>2000)throw new ThreadsError('INVALID_INPUT','A bounded nonempty collection target is required.');
    const state=this.state();const prior=args.checkpoint?state.checkpoints[args.checkpoint]:undefined;
    if(args.checkpoint&&!prior)throw new ThreadsError('CHECKPOINT_NOT_FOUND','The collection checkpoint does not exist.');
    if(prior&&(prior.source!==args.source||prior.target!==target))throw new ThreadsError('CHECKPOINT_MISMATCH','Checkpoint source and target cannot change.');
    const rounds=bounded(args.rounds,1,5);const account=await this.viewer(prior?.account??undefined);
    const result=args.source==='search'?await this.service.discover(target,rounds):args.source==='profile'?await this.service.profile(target,'posts',rounds):await this.service.replies(target,rounds);
    await this.viewer(account);
    const items='posts' in result?result.posts:result.items;const now=new Date().toISOString();
    const checkpoint:Checkpoint=prior??{id:randomUUID(),source:args.source,target,account,createdAt:now,updatedAt:now,passes:0,seen:{},sourceUrls:[]};
    const delta={added:[] as Post[],updated:[] as Post[],unchanged:0};
    const deduped=[...new Map(items.map(post=>[identity(post),post])).values()];
    for(const post of deduped){const id=identity(post);const value=fingerprint(post);const old=checkpoint.seen[id];
      if(!old)delta.added.push(post);else if(old!==value)delta.updated.push(post);else delta.unchanged++;
      checkpoint.seen[id]=value;
    }
    checkpoint.updatedAt=now;checkpoint.passes++;checkpoint.sourceUrls=unique([...checkpoint.sourceUrls,result.sourceUrl]);state.checkpoints[checkpoint.id]=checkpoint;
    const collection=`incremental:${checkpoint.id}`;this.service.index.recordCollection(collection,deduped);
    this.record(state,collection,deduped,[result.sourceUrl],'profile' in result?result.profile:undefined);this.save(state);
    return {items:deduped,delta,checkpoint:{...checkpoint,seen:undefined,historicalDistinctObserved:Object.keys(checkpoint.seen).length},collection,analyticsKey:collection,
      sourceUrl:result.sourceUrl,observedAt:result.observedAt,completeness:'partial',continuation:{mode:'refresh-from-top',checkpoint:checkpoint.id,exhausted:null},
      warnings:unique([...result.warnings,partialWarning,'Resuming refreshes bounded page windows from the top and deduplicates historical observations; this is not a site pagination cursor.'])};
  });}
  replyInbox(args:{account?:string;maxPosts?:number;rounds?:number;includeMentions?:boolean}){return this.serial(async()=>{
    const account=await this.viewer(args.account);const rounds=bounded(args.rounds,0,2);const maxPosts=bounded(args.maxPosts,3,10);
    const own=await this.service.profile(account,'posts',rounds);await this.viewer(account);
    const roots=own.items.filter(post=>post.author.username.toLowerCase()===account&&post.isReply!==true).slice(0,maxPosts);
    const entries=new Map<string,{post:Post;evidence:Array<{kind:'reply-window'|'explicit-mention'|'name-or-brand-candidate';sourceUrl:string;ownPostUrl?:string}>}>();
    const failures:Array<{sourceUrl:string;error:string}>=[];const warnings=[...own.warnings,partialWarning];
    const add=(post:Post,evidence:{kind:'reply-window'|'explicit-mention'|'name-or-brand-candidate';sourceUrl:string;ownPostUrl?:string})=>{
      if(post.author.username.toLowerCase()===account)return;const key=identity(post);const entry=entries.get(key)??{post,evidence:[]};entry.evidence.push(evidence);entries.set(key,entry);
    };
    for(const root of roots){try{const replies=await this.service.replies(root.url,rounds);await this.viewer(account);warnings.push(...replies.warnings);
      for(const post of replies.items)add(post,{kind:'reply-window',sourceUrl:replies.sourceUrl,ownPostUrl:root.url});
    }catch(error){const code=(error as {code?:string}).code??'READ_FAILED';if(['ACCOUNT_MISMATCH','UNKNOWN_ACCOUNT'].includes(code))throw error;failures.push({sourceUrl:root.url,error:code});}}
    if(args.includeMentions!==false){try{const mentions=await this.research.mentions({username:account,refresh:true,rounds,limit:100});await this.viewer(account);warnings.push(...mentions.warnings);
      for(const item of mentions.items)add(item.post,{kind:item.mentionKind==='explicit-handle'?'explicit-mention':'name-or-brand-candidate',sourceUrl:item.post.url});
    }catch(error){const code=(error as {code?:string}).code??'READ_FAILED';if(['ACCOUNT_MISMATCH','UNKNOWN_ACCOUNT'].includes(code))throw error;failures.push({sourceUrl:`https://www.threads.com/search?q=${encodeURIComponent('@'+account)}`,error:code});}}
    await this.viewer(account);const items=[...entries.values()];const collection=`account:${account}:reply-inbox`;this.service.index.recordCollection(collection,items.map(item=>item.post));
    return {account,items,collection,rootsVisited:roots.map(post=>post.url),failures,completeness:'partial',state:items.length?'observed-items':'unknown',
      warnings:unique([...warnings,'This inbox contains incoming reply windows and public mention candidates. It does not establish unread status, pending moderation, or absence of other replies.'])};
  });}
  snapshot(args:{key:string;posts:Post[];sourceUrls?:string[];profile?:Profile|null}){return this.serial(async()=>{
    if(args.posts.length>10000)throw new ThreadsError('OBSERVATION_BUDGET','A snapshot accepts at most 10,000 observed posts.');
    const state=this.state();const sample=this.record(state,args.key,args.posts,args.sourceUrls??[],args.profile);this.save(state);return {key:args.key,sample,completeness:'partial',warnings:[partialWarning]};
  });}
  analytics(args:{key:string}){return this.serial(async()=>{
    const samples=this.state().series[this.key(args.key)]??[];
    const series=samples.map(sample=>({observedAt:sample.observedAt,sourceUrls:sample.sourceUrls,postsObserved:sample.posts.length,authorsObserved:unique(sample.posts.map(post=>post.author)).length,profile:sample.profile,
      metrics:Object.fromEntries(metrics.map(metric=>{const known=sample.posts.map(post=>post.counts[metric]).filter((value):value is number=>value!==null);return [metric,{sum:known.length?known.reduce((a,b)=>a+b,0):null,known:known.length,missing:sample.posts.length-known.length}];}))}));
    const changes=samples.slice(1).map((after,i)=>{const before=samples[i]!;const previous=new Map(before.posts.map(post=>[post.id,post]));
      return {from:before.observedAt,to:after.observedAt,matchedPosts:after.posts.filter(post=>previous.has(post.id)).length,
        metrics:Object.fromEntries(metrics.map(metric=>{const deltas=after.posts.flatMap(post=>{const old=previous.get(post.id)?.counts[metric];const current=post.counts[metric];return old!==null&&old!==undefined&&current!==null?[current-old]:[];});return [metric,{delta:deltas.length?deltas.reduce((a,b)=>a+b,0):null,comparablePosts:deltas.length}];})),
        followerDelta:before.profile&&after.profile&&before.profile.username.toLowerCase()===after.profile.username.toLowerCase()&&before.profile.followers!==null&&after.profile.followers!==null?after.profile.followers-before.profile.followers:null};});
    return {key:args.key,series,changes,completeness:'partial',method:'Observed public-count snapshots; changes compare only the same posts with known values in adjacent samples.',
      warnings:[partialWarning,'Sample totals can change because different posts were visible. Changes use the matched subset and may be negative after count corrections. No private insights, platform-wide trends, or historical reconstruction are inferred.']};
  });}
  trends(args:{queries:string[];rounds?:number}){return this.serial(async()=>{
    const queries=unique(args.queries.map(query=>query.trim()).filter(Boolean));if(!queries.length||queries.length>5||queries.some(query=>query.length>500))throw new ThreadsError('INVALID_INPUT','Provide one to five queries of at most 500 characters.');
    const observations:Array<{query:string;items:Post[];sourceUrl:string;observedAt:string;warnings:string[]}>=[];
    const failures:Array<{query:string;error:string}>=[];const state=this.state();
    for(const query of queries){try{const result=await this.service.discover(query,bounded(args.rounds,0,2));const items=[...new Map(result.posts.map(post=>[identity(post),post])).values()];
      this.record(state,trendKey(query),items,[result.sourceUrl]);observations.push({query,items,sourceUrl:result.sourceUrl,observedAt:result.observedAt,warnings:result.warnings});
    }catch(error){failures.push({query,error:(error as {code?:string}).code??'DISCOVERY_FAILED'});}}
    this.save(state);
    return {items:observations.map(observation=>({query:observation.query,analyticsKey:trendKey(observation.query),postsObserved:observation.items.length,authorsObserved:unique(observation.items.map(post=>post.author.username)).length,
      sourceUrl:observation.sourceUrl,observedAt:observation.observedAt,posts:observation.items,knownLikesSum:observation.items.some(post=>post.likes!==null)?observation.items.reduce((sum,post)=>sum+(post.likes??0),0):null,unknownLikeCounts:observation.items.filter(post=>post.likes===null).length})),failures,
      completeness:'partial',method:'Bounded keyword candidate samples, without platform popularity ranking.',warnings:unique([partialWarning,...observations.flatMap(observation=>observation.warnings),'Different queries can overlap; do not add their totals. Query results are not representative platform trend measurements.'])};
  });}
}
