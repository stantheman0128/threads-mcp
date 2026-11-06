import {z} from 'zod';
import {appendFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {ThreadsService} from './service.js';
import {ThreadsObservations} from './observations.js';
import {OfficialThreadsApi,officialApiOptionsFromEnv,officialActionSchema,officialReadOperationSchema,officialReadInputSchema} from './official-api.js';
import {SocialActions} from './social-actions.js';
import {socialKinds} from './social-runtime.js';
import {WorkflowStore,collectBatch,exportPosts} from './workflows.js';
import {publishApiDraft} from './publishing.js';
import {publishBrowserDraft} from './browser-publishing.js';
import {MediaController} from './media.js';

type Register=(name:string,description:string,schema:z.ZodObject<any>,fn:(args:any)=>unknown,readOnly?:boolean)=>void;
const account=z.string().min(1).max(200);
const rounds=z.number().int().min(0).max(3).default(0).describe('Automatic scroll-and-read passes at the requested source; no manual scrolling required. Zero reads only the initial loaded window.');
const media=z.object({type:z.enum(['image','video']),url:z.string().url().optional(),path:z.string().optional(),altText:z.string().max(1000).optional()});
const draft=z.object({text:z.string().optional(),media:z.array(media).max(20).optional(),replyTo:z.string().optional(),replyUrl:z.string().url().optional(),quoteUrl:z.string().url().optional(),quotePostId:z.string().regex(/^\d+$/).optional()});

export function registerAdvancedTools(tool:Register,service:ThreadsService){
  const observations=new ThreadsObservations(service,service.config.dataDir);
  const api=new OfficialThreadsApi({...officialApiOptionsFromEnv(),writesEnabled:service.config.writesEnabled});
  const social=new SocialActions(service.driver,{writesEnabled:service.config.writesEnabled,minActionIntervalMs:service.config.minActionIntervalMs,
    reserveWrite:()=>service.reserveWrite(),
    audit:event=>appendFileSync(join(service.config.dataDir,'social-actions.jsonl'),JSON.stringify({...event,time:new Date().toISOString()})+'\n')});
  const mediaController=new MediaController({writesEnabled:service.config.writesEnabled,command:command=>service.driver.command(command)});
  tool('threads_stage_media','Upload explicitly selected local files to the current empty composer using bounded chunks. Requires enabled writes and authorization to upload these files to Threads. Returns a mediaToken for prepare_social; does not publish and does not claim previews finished processing.',z.object({paths:z.array(z.string()).min(1).max(20),expectedAccount:account,altTexts:z.array(z.string()).optional()}),a=>service.serial(()=>mediaController.uploadFiles(a.paths,a.expectedAccount,a.altTexts)),false);
  const store=async<T>(accountId:string,fn:(store:WorkflowStore)=>T|Promise<T>)=>{
    const instance=new WorkflowStore({dataDir:service.config.dataDir,accountId});try{return await fn(instance);}finally{instance.close();}
  };
  tool('threads_search_users','Discover observed profile results from the Threads profile-search tab. Partial results, missing profile details remain null.',z.object({query:z.string().min(1).max(500),rounds}),a=>service.searchUsers(a.query,a.rounds));
  tool('threads_discover','Read a bounded top or recent keyword-result window before local reranking. Top is the site default, not our own popularity measure.',z.object({query:z.string().min(1).max(500),sort:z.enum(['top','recent']).default('top'),rounds}),a=>service.discover(a.query,a.rounds,a.sort));
  tool('threads_reply_inbox','Collect incoming replies across up to ten own posts and optional public mention candidates, with source context and deduplication. Does not establish unread or moderation status.',z.object({account:account.optional(),maxPosts:z.number().int().min(1).max(10).default(3),rounds,includeMentions:z.boolean().default(true)}),a=>observations.replyInbox(a));
  tool('threads_account_insights','Read the signed-in account Insights summary, period and comparison values from the browser; retain visible report text and optional historical snapshots. No API token required.',z.object({account:account.optional(),includeHistory:z.boolean().default(false)}),a=>observations.accountInsights(a));
  tool('threads_collect','Refresh a bounded search/profile/reply source and persist account-bound incremental added/updated observations. Continuation refreshes from the top, not a site pagination cursor.',z.object({source:z.enum(['search','profile','replies']),target:z.string().min(1).max(2000),rounds,checkpoint:z.string().optional()}),a=>observations.collect(a),false);
  tool('threads_trends','Compare bounded keyword samples, save public-count snapshots and retain provenance. Does not measure platform-wide popularity.',z.object({queries:z.array(z.string().min(1).max(500)).min(1).max(5),rounds}),a=>observations.trends(a),false);
  tool('threads_observed_analytics','Read saved public-count time series and changes on matched posts. Requires an analyticsKey returned by collect or trends.',z.object({key:z.string().min(1).max(200)}),a=>observations.analytics(a));
  tool('threads_batch_read','Read up to ten profiles or conversations sequentially with per-target failures. Browser results are partial.',z.object({kind:z.enum(['profile','replies']),targets:z.array(z.string()).min(1).max(10),rounds}),async a=>({items:await collectBatch<unknown>(a.targets,target=>a.kind==='profile'?service.profile(target,'posts',a.rounds):service.replies(target,a.rounds)),completeness:'partial'}));
  tool('threads_export','Export up to 100 locally indexed query results as JSON or formula-safe CSV into the private data directory. Scope by collections when needed.',z.object({query:z.string().min(1).max(500),format:z.enum(['json','csv']),collections:z.array(z.string()).max(20).optional(),limit:z.number().int().min(1).max(100).default(100)}),async a=>{
    const result=await service.index.search(a.query,{mode:'lexical',collections:a.collections,limit:a.limit});
    const dir=join(service.config.dataDir,'exports');mkdirSync(dir,{recursive:true});const path=join(dir,`${randomUUID()}.${a.format}`);
    writeFileSync(path,exportPosts(result.items.map(hit=>hit.post),a.format),{mode:0o600});
    const provenancePath=`${path}.provenance.json`;
    writeFileSync(provenancePath,JSON.stringify({query:a.query,collections:a.collections??null,limit:a.limit,method:result.method,items:result.items.map(hit=>({id:hit.post.id,url:hit.post.url,observedCollections:hit.observedCollections}))},null,2),{mode:0o600});
    return {path,provenancePath,exported:result.items.length,completeness:'bounded-query-results',method:result.method,warnings:result.warnings};
  },false);
  tool('threads_api_status','Report optional official API configuration without returning credentials.',z.object({}),()=>api.status());
  tool('threads_api_read','Official API reads for posts, profiles, keyword/tag search, mentions, conversation, own insights, pending replies, publishing quota or container status. Permissions and cursor bounds apply.',z.object({operation:officialReadOperationSchema,input:officialReadInputSchema.default({})}),a=>api.read(a.operation,a.input));
  tool('threads_api_prepare','Prepare an account-bound official mutation: media/text/carousel container, publish container, delete, hide/unhide or approve/reject reply. Does not mutate Threads.',z.object({action:officialActionSchema}),a=>api.prepare(a.action));
  tool('threads_api_execute','Execute one prepared official API mutation once. Requires explicit authorization for this account, content and effect. Unknown outcomes must be reconciled, never replayed.',z.object({preparedId:z.string()}),a=>api.execute(a.preparedId),false);
  tool('threads_inspect_social','Inspect current account, exact target and action state without clicking, filling, opening a menu or requiring writes. Navigate to the target first. Missing or ambiguous UI is an error, not evidence of an absent relationship.',z.object({kind:z.enum(socialKinds),targetUrl:z.string().url(),text:z.string().optional()}),a=>service.serial(()=>social.inspect(a)));
  tool('threads_prepare_social','Stage a named browser action on the current exact target page. May open a composer/menu and fill an empty draft, but never submits. Requires enabled writes. Use mediaToken to bind an explicitly staged upload.',z.object({kind:z.enum(socialKinds),targetUrl:z.string().url(),text:z.string().optional(),mediaToken:z.string().optional()}),a=>service.serial(()=>social.prepare(a)),false);
  tool('threads_execute_social','Commit a prepared browser action once, then verify target state or a new published post. Requires user authorization for the specific effect. An uncertain result must not be retried.',z.object({id:z.string(),expectedAccount:account}),a=>service.serial(()=>social.execute(a.id,a.expectedAccount)),false);
  tool('threads_save_draft','Save or update a local account-scoped text/media draft. No Threads upload or publication occurs.',z.object({accountId:account,id:z.string().optional(),draft}),a=>store(a.accountId,s=>s.saveDraft(a.draft,a.id)),false);
  tool('threads_list_drafts','List local drafts for an exact account identifier.',z.object({accountId:account}),a=>store(a.accountId,s=>({items:s.listDrafts()})));
  tool('threads_delete_draft','Delete one local draft; staged schedules retain their immutable content snapshot.',z.object({accountId:account,id:z.string()}),a=>store(a.accountId,s=>({deleted:s.deleteDraft(a.id)})),false);
  tool('threads_stage_schedule','Stage an immutable single post or ordered reply chain from draft IDs. Time requires ISO Z or explicit offset. Staging does not authorize or publish.',z.object({accountId:account,draftIds:z.array(z.string()).min(1).max(20),at:z.string(),dedupeKey:z.string().max(200).optional()}),a=>store(a.accountId,s=>s.stageSchedule(a)),false);
  tool('threads_list_schedules','Read durable local schedules including uncertain, failed and cancelled outcomes.',z.object({accountId:account}),a=>store(a.accountId,s=>({items:s.listSchedules()})));
  tool('threads_authorize_schedule','Authorize the exact staged immutable content and due time after user review. A running worker may publish at/after this time. User authorization is required.',z.object({accountId:account,id:z.string()}),a=>store(a.accountId,s=>s.authorizeSchedule(a.id)),false);
  tool('threads_cancel_schedule','Cancel pending work or request an in-flight chain stop before its next part. Already sent content is not undone.',z.object({accountId:account,id:z.string()}),a=>store(a.accountId,s=>s.cancelSchedule(a.id)),false);
  tool('threads_run_schedules','Execute due, explicitly authorized jobs through the selected browser by default; API is opt-in. Browser requires the matching username and supports text with explicit reply/quote URLs; scheduled media is unsupported. Stops on uncertain outcomes and preserves existing drafts. A running caller is required; this tool does not install a timer.',z.object({accountId:account,provider:z.enum(['browser','api']).default('browser'),limit:z.number().int().min(1).max(10).default(1)}),a=>store(a.accountId,async s=>({provider:a.provider,items:await s.runDue((draft,context)=>{
    const shouldStop=()=>s.getSchedule(context.jobId).cancelRequested;
    return a.provider==='api'?publishApiDraft(api,draft,context,{shouldStop}):publishBrowserDraft(service,social,draft,context,{shouldStop});
  },{writesEnabled:service.config.writesEnabled,limit:a.limit})})),false);
  tool('threads_reconcile_schedule','Record externally verified resolution of an uncertain publication. Supply real post ID/evidence for confirmed outcomes; remaining chain parts require fresh authorization.',z.object({accountId:account,id:z.string(),status:z.enum(['confirmed','failed']),postId:z.string().optional(),postUrl:z.string().url().optional(),evidence:z.array(z.string().min(1)).min(1).max(10)}),a=>store(a.accountId,s=>s.reconcileSchedule(a.id,a.status==='confirmed'?{status:'confirmed',postId:a.postId??'',postUrl:a.postUrl,evidence:a.evidence}:{status:'failed',evidence:a.evidence})),false);
}
