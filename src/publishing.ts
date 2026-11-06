import {OfficialThreadsApi,type OfficialContainerInput,type OfficialAction} from './official-api.js';
import type {Draft,PublishContext,PublishOutcome} from './workflows.js';

/** Publishing is called only for an explicitly authorized, immutable job part. */
export async function publishApiDraft(api:OfficialThreadsApi,draft:Draft,context:PublishContext,options:{pollAttempts?:number;sleep?:(ms:number)=>Promise<void>;shouldStop?:()=>boolean}={}):Promise<PublishOutcome>{
  const evidence:string[]=[];let publicationSent=false;let publicationConfirmed=false;
  const wait=options.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  const stopGuard=()=>{if(options.shouldStop?.())throw Object.assign(new Error('Stopped'),{code:'STOP_REQUESTED'});};
  const mutate=async(action:OfficialAction)=>{stopGuard();const staged=await api.prepare(action);stopGuard();return api.execute(staged.preparedId);};
  try{
    stopGuard();
    if(draft.replyUrl)return {status:'failed',evidence:['Browser replyUrl requires the browser publisher. No API request or container was created.']};
    const profile=await api.read('own_profile');
    const accountMatches=/^\d+$/.test(context.accountId)?context.accountId===String(profile.data.id):context.accountId.replace(/^@/,'').toLowerCase()===String(profile.data.username).toLowerCase();
    if(!accountMatches)
      return {status:'failed',evidence:['Expected schedule account does not match the official API identity; no container was created.']};
    if(draft.media?.some(media=>!media.url||media.path))return {status:'failed',evidence:['Official API publishing requires public HTTPS media URLs. Local files must use the browser staging tool; no upload was attempted.']};
    if(draft.quoteUrl)return {status:'failed',evidence:['Official API quoting requires quotePostId, not a browser URL. No container was created.']};
    const ready=async(containerId:string)=>{
      const deadline=Date.now()+120000;
      for(let i=0;i<(options.pollAttempts??60)&&Date.now()<deadline;i++){
        stopGuard();
        const state=await api.read('container_status',{id:containerId});
        if(state.data.status==='FINISHED')return true;
        if(state.data.status!=='IN_PROGRESS')return false;
        await wait(2000);
      }
      return false;
    };
    const create=async(container:OfficialContainerInput)=>{
      const result=await mutate({kind:'create_container',container});const containerId=String(result.data.id);
      evidence.push(`Created container ${containerId}.`);
      if(!await ready(containerId))throw Object.assign(new Error('Container not ready'),{code:'CONTAINER_NOT_READY'});
      return containerId;
    };
    const media=draft.media??[];
    const base={text:draft.text,reply_to_id:context.replyTo??draft.replyTo,quote_post_id:(draft as Draft&{quotePostId?:string}).quotePostId};
    let container:OfficialContainerInput;
    if(media.length>1){
      const children:string[]=[];
      for(const item of media)children.push(await create({media_type:item.type==='image'?'IMAGE':'VIDEO',...(item.type==='image'?{image_url:item.url}:{video_url:item.url}),is_carousel_item:true,alt_text:item.altText}));
      container={...base,media_type:'CAROUSEL',children};
    }else if(media[0]){
      const item=media[0];container={...base,media_type:item.type==='image'?'IMAGE':'VIDEO',...(item.type==='image'?{image_url:item.url}:{video_url:item.url}),alt_text:item.altText};
    }else container={...base,media_type:'TEXT'};
    const containerId=await create(container);
    stopGuard();
    const prepared=await api.prepare({kind:'publish_container',creation_id:containerId});
    stopGuard();
    publicationSent=true;
    const result=await api.execute(prepared.preparedId);publicationConfirmed=true;const postId=String(result.data.id);
    evidence.push(`API confirmed publication ${postId} from container ${containerId}.`);
    const post=await api.read('post',{id:postId});
    if(String(post.data.id)!==postId||String(post.data.username).toLowerCase()!==String(profile.data.username).toLowerCase()||(post.data.text??'')!==(draft.text??''))
      return {status:'uncertain',evidence:[...evidence,'Read-back did not match the expected post, author and text. Do not publish again.']};
    const expectedType=media.length>1?'CAROUSEL_ALBUM':media[0]?.type==='image'?'IMAGE':media[0]?.type==='video'?'VIDEO':'TEXT_POST';
    if(post.data.media_type!==expectedType)return {status:'uncertain',evidence:[...evidence,'Published media type was not confirmed by read-back. Do not publish again.']};
    const parent=context.replyTo??draft.replyTo;
    if((!parent&&post.data.is_reply===true)||(!draft.quotePostId&&post.data.is_quote_post===true))return {status:'uncertain',evidence:[...evidence,'Read-back shows an unrequested reply or quote relationship. Do not publish again.']};
    const relationId=(value:unknown)=>typeof value==='object'&&value!==null?String((value as {id?:unknown}).id):String(value??'');
    if(parent&&(post.data.is_reply!==true||relationId(post.data.replied_to)!==parent))return {status:'uncertain',evidence:[...evidence,'Reply-to relationship was not confirmed by read-back. Do not publish again.']};
    if(draft.quotePostId&&(post.data.is_quote_post!==true||relationId(post.data.quoted_post)!==draft.quotePostId))return {status:'uncertain',evidence:[...evidence,'Quote target was not confirmed by read-back. Do not publish again.']};
    if(media.length>1){const children=Array.isArray(post.data.children)?post.data.children:(post.data.children as {data?:unknown[]}|undefined)?.data;if(!Array.isArray(children)||children.length!==media.length)return {status:'uncertain',evidence:[...evidence,'Carousel attachment count was not confirmed by read-back. Do not publish again.']};}
    if(media.length)evidence.push('Authorized container publication and returned media type/count verified; transformed remote media bytes were not independently compared.');
    evidence.push('Post read-back matched ID, account and text.');
    return {status:'confirmed',postId,...(typeof post.data.permalink==='string'?{postUrl:post.data.permalink}:{}),evidence};
  }catch(error){
    const e=error as {code?:string;outcome?:string};
    const status=publicationConfirmed?'uncertain':['not_sent','rejected'].includes(e.outcome??'')?'failed':publicationSent||e.outcome==='unknown'?'uncertain':'failed';
    return {status,evidence:[...evidence,`Publishing stopped (${e.code??'PUBLISH_FAILED'}); no request was replayed.`]};
  }
}
