import { dedupePosts, parsePayloads, parseWire, parseCount } from './parser.js';
import type { Post, Profile } from './types.js';
import { directProfile as collectDirectProfile } from './direct-profile-runtime.js';
import type { DirectProfileArgs } from './direct-profile-types.js';
export { cancelDirectProfiles } from './direct-profile-runtime.js';
export function directProfile(args: DirectProfileArgs) {
  return collectDirectProfile(args, { viewer: () => viewer().username, guard });
}
export {socialStage,socialCommit,socialInspect,socialPrepareConfirmation,socialCommitConfirmation,cancelSocialActions} from './social-runtime.js';
export {remoteBrowser,validateRemoteBrowserCommand,cancelRemoteBrowserActions} from './remote-browser-runtime.js';
export {media,cancelMediaTransfers} from './media-runtime.js';
export const runtimeVersion='0.7.0';
export const runtimeRevision='20261107-profile-label-1';
let remoteViewEpoch=0,remoteViewWatching=false;
let remoteViewBinding:{token:string;route:string;account:string|null;epoch:number;expires:number}|undefined;
export function cancelRemoteViews(){remoteViewEpoch++;remoteViewBinding=undefined;}
function remoteViewToken(){
  if(!remoteViewWatching){remoteViewWatching=true;
    for(const type of ['pointerdown','mousedown','touchstart','keydown','beforeinput','input','paste','cut','drop','wheel'])document.addEventListener(type,event=>{if(event.isTrusted)cancelRemoteViews();},true);
    globalThis.addEventListener('pagehide',cancelRemoteViews);
  }
  const token=crypto.randomUUID();remoteViewBinding={token,route:location.href,account:viewer().username,epoch:remoteViewEpoch,expires:Date.now()+30000};return token;
}

/** Fixed remote view navigation: the last account/draft checks and dispatch share one JS turn. */
export function remoteView(command:Record<string,unknown>){
  const routes:Record<string,string>={for_you:'/',following:'/following/',saved:'/saved/',liked:'/liked/',notifications:'/activity',messages:'/messages/'};
  if(command.type!=='remote_view'||Object.keys(command).some(key=>!['type','kind','expectedAccount','navigationToken'].includes(key))||
    typeof command.kind!=='string'||!Object.hasOwn(routes,command.kind)||typeof command.expectedAccount!=='string'||!/^@?[A-Za-z0-9_.]{1,30}$/.test(command.expectedAccount))throw new Error('INVALID_COMMAND: Invalid remote view.');
  guard();
  const expected=command.expectedAccount.replace(/^@/,'').toLowerCase();
  const binding=remoteViewBinding;remoteViewBinding=undefined;
  if(!binding||binding.token!==command.navigationToken||binding.route!==location.href||binding.epoch!==remoteViewEpoch||binding.expires<Date.now()||binding.account!==expected)throw new Error('REMOTE_VIEW_STALE: The read-view binding changed.');
  if(viewer().username?.toLowerCase()!==expected)throw new Error('ACCOUNT_MISMATCH: Remote view account changed.');
  const composer=readComposerState();
  if(composer.present||composer.nonempty||composer.attachments||composer.ambiguous)throw new Error('COMPOSER_BUSY: Preserve the current composer.');
  const destination='https://www.threads.com'+routes[command.kind];
  location.assign(destination);
  return {dispatched:true,verified:false,destination};
}

export interface ElementRef { ref: string; role: string; name: string; text: string; href?: string; editable: boolean; checked?: boolean; context: string; }
export interface PageSnapshot { snapshotId: string; url: string; title: string; viewer: { username: string | null }; elements: ElementRef[]; text: string; }
export interface DialogState { present: boolean; selectedTab: string | null; busy: boolean; }
export interface ComposerState {present:boolean;nonempty:boolean;attachments:boolean;ambiguous:boolean;}
export interface PostActivityEvidence {present:boolean;targetUrl:string|null;targetCode:string|null;selectedTab:'likes'|'reposts'|'insights'|null;users:Profile[];displayedCount:number|null;counts:{likes:number|null;reposts:number|null;views:number|null};busy:boolean;warnings:string[];}
export interface NotificationRowEvidence { text:string; actorLinks:Array<{username:string;url:string}>; postLinks:string[]; timeLabel?:string|null; timestamp?:string|null; eventId?:string|null; actionText?:string|null; additionalActorCount?:number|null; badge?:{kind:'like'|'reply'|'follow'|'unknown';signature:string|null}; }
export interface PageRead { runtimeVersion: string; remoteMediaVersion?:number; remoteNavigationToken?:string; runtimeRevision?:string;runtimeDiagnostics?:ReturnType<typeof runtimeDiagnostics>;extensionVersion?: string; url: string; title: string; posts: Post[]; profiles: Profile[]; replies: Post[]; dialogUsers: Profile[]; dialogState: DialogState; composerState?:ComposerState;postActivity?:PostActivityEvidence;notificationRows?:NotificationRowEvidence[]; visibilityState?: DocumentVisibilityState; viewer: { username: string | null }; text: string; warnings: string[]; observedAt: string; }
let current: { id: string; url: string; expires: number; entries: Map<string,{element: HTMLElement; fingerprint: string}> } | undefined;
function routeKey(value: string): string | null {
  try { const url=new URL(value);return `${url.origin}${url.pathname}${url.search}`; } catch { return null; }
}
let lastObservedRoute=routeKey(location.href);
let observedRouteChange=false;
const attachedAfterDocumentStarted=document.readyState!=='loading';
function rendered(el: Element): boolean { return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none'; }
function visible(el: Element): el is HTMLElement { return el instanceof HTMLElement && rendered(el)&&!el.closest('[aria-hidden="true"],[inert]'); }
function visibleDialog(): HTMLElement | undefined {
  return [...document.querySelectorAll('[role="dialog"]')].filter(el=>visible(el)&&!el.closest('[aria-hidden="true"]')).at(-1) as HTMLElement | undefined;
}
const connectionTabPattern=/^(?:Followers|Following|粉絲|追蹤者|追蹤中)(?:\s*[(（]?[\d,.]+(?:[kmb萬億千])?[)）]?)?$/i;
type ConnectionRow= {node:HTMLAnchorElement;href:string};
interface ConnectionSession {dialog:HTMLElement;route:string|null;tab:string|null;rows:ConnectionRow[];observer:MutationObserver;pending?:{from:string|null;target:string|null;baseline:ConnectionRow[];changed:boolean;sawBlocking:boolean;blockingObserved:boolean;quietSince:number};}
let connectionSession:ConnectionSession|undefined;
function clearConnectionSession(){connectionSession?.observer.disconnect();connectionSession=undefined;}
function selectedDialogTab(dialog:HTMLElement){const tabs=[...dialog.querySelectorAll('[role="tab"][aria-selected="true"]')].filter(visible);return tabs.length===1?label(tabs[0]!).replace(/\s+/g,' ').trim()||null:null;}
function connectionTabIdentity(tab:string|null){return tab&&connectionTabPattern.test(tab)?/^(?:Following|追蹤中)/i.test(tab)?'following':'followers':null;}
function connectionRows(dialog:HTMLElement):ConnectionRow[]{return [...dialog.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(a=>visible(a)&&a.protocol==='https:'&&['www.threads.com','threads.com','www.threads.net','threads.net'].includes(a.hostname)&&!a.port&&!a.username&&!a.password&&/^\/@[\w.]+\/?$/.test(a.pathname)&&!a.closest('[role="tablist"]')).map(node=>({node,href:node.href}));}
function sameConnectionRows(a:ConnectionRow[],b:ConnectionRow[]){return a.length===b.length&&a.every((row,index)=>row.node===b[index]?.node&&row.href===b[index]?.href);}
function connectionRowsReplaced(a:ConnectionRow[],b:ConnectionRow[]){return a.length===0?b.length>0:a.every(old=>!b.some(row=>row.node===old.node&&row.href===old.href));}
function loadingIndicators(scope:HTMLElement){return [scope,...scope.querySelectorAll('[aria-busy="true"],[role="progressbar"],[aria-label]')].filter(el=>
  (el.matches('[aria-busy="true"],[role="progressbar"]')||/^(?:Loading|載入中|正在載入)[\s.…]*$/i.test(el.getAttribute('aria-label')||''))&&rendered(el)&&!el.closest('[aria-hidden="true"],[inert]'));}
function connectionPaginationIndicator(el:Element,tab:string|null,rows:ConnectionRow[]){
  if(!tab||!connectionTabPattern.test(tab)||!rows.length||el.matches('[aria-busy="true"],[role="progressbar"]'))return false;
  const status=el.closest('[role="status"]');
  // Native evidence contains both normal and sticky status/SVG footer pairs.
  // Their DOM order and separate profile-free branch identify pagination;
  // viewport position alone does not. Explicit busy/progress remains blocking.
  return !!status&&!status.closest('button,[role="button"],a')&&!!status.parentElement&&rows.every(row=>
    !status.parentElement!.contains(row.node)&&!!(row.node.compareDocumentPosition(status)&Node.DOCUMENT_POSITION_FOLLOWING));
}
function dialogLoading(dialog:HTMLElement,tab:string|null){const indicators=loadingIndicators(dialog);const rows=tab&&connectionTabPattern.test(tab)?connectionRows(dialog):[];const pagination=indicators.filter(el=>connectionPaginationIndicator(el,tab,rows));return {indicators,pagination,blocking:indicators.some(el=>!pagination.includes(el))};}
function updateConnectionSession(session:ConnectionSession,records:MutationRecord[]){
  if(connectionSession!==session)return;
  const closed=records.some(record=>record.type==='childList'&&[...record.removedNodes].some(node=>node===session.dialog||node.contains(session.dialog))||
    record.type==='attributes'&&(record.target===session.dialog||record.target.contains(session.dialog))&&
    (record.attributeName==='aria-hidden'&&record.oldValue==='true'||['hidden','inert'].includes(record.attributeName||'')&&record.oldValue!==null||record.attributeName==='style'&&/(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(record.oldValue||'')));
  if(closed||!session.dialog.isConnected||!visible(session.dialog)||routeKey(location.href)!==session.route){clearConnectionSession();return;}
  const tabLabel=selectedDialogTab(session.dialog),tab=connectionTabIdentity(tabLabel),rows=connectionRows(session.dialog),now=Date.now();
  const selections=records.map((record,index)=>({record,index})).filter(({record})=>record.type==='attributes'&&record.attributeName==='aria-selected'&&record.target instanceof Element&&session.dialog.contains(record.target)&&record.target.matches('[role="tab"]'));
  const activations=selections.filter(({record,index})=>{const next=selections.find(item=>item.index>index&&item.record.target===record.target);return (next?next.record.oldValue:(record.target as Element).getAttribute('aria-selected'))==='true'&&record.oldValue!=='true';});
  // Generic pagination loaders can appear or remount while old rows detach.
  // Only explicit busy/progress evidence can authorize reusing baseline rows;
  // generic loaders still block current reads until they actually settle.
  const blocking=loadingIndicators(session.dialog).some(el=>el.matches('[aria-busy="true"],[role="progressbar"]'));
  const changed=!sameConnectionRows(session.rows,rows),replaced=connectionRowsReplaced(session.rows,rows);
  if(activations.length||tab!==session.tab){
    // A→B→A between reads cannot credit B's rows to A. Such a cycle needs
    // another observable refresh after the final selection; time alone fails.
    const cycle=activations.length>1||tab===session.tab;
    session.pending={from:session.tab,target:tab,baseline:cycle?rows:session.rows,changed:replaced&&!cycle,sawBlocking:blocking,blockingObserved:blocking,quietSince:now};
  }else if(session.pending){
    if(changed){session.pending.changed||=connectionRowsReplaced(session.pending.baseline,rows);session.pending.quietSince=now;}
    if(blocking){session.pending.sawBlocking=true;session.pending.blockingObserved=true;}
    else if(session.pending.sawBlocking){session.pending.changed=true;session.pending.sawBlocking=false;session.pending.quietSince=now;}
  }
  session.tab=tab;session.rows=rows;
}
function connectionTransitionBusy(dialog:HTMLElement,tabLabel:string|null,blocking:boolean){
  const tab=connectionTabIdentity(tabLabel);if(!tab)return false;
  let session=connectionSession;
  if(session?.dialog!==dialog||session.route!==routeKey(location.href)){
    clearConnectionSession();const observer=new MutationObserver(records=>{if(connectionSession)updateConnectionSession(connectionSession,records);});
    session={dialog,route:routeKey(location.href),tab,rows:connectionRows(dialog),observer};connectionSession=session;
    observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeOldValue:true,attributeFilter:['aria-selected','href','aria-busy','aria-label','hidden','aria-hidden','inert','style','class']});
  }else updateConnectionSession(session,session.observer.takeRecords());
  if(connectionSession!==session)return true;
  const pending=session.pending;if(!pending)return false;
  const turnover=connectionRowsReplaced(pending.baseline,session.rows),loadCompleted=pending.blockingObserved&&!pending.sawBlocking;
  if(pending.target!==tab||!pending.changed||(!turnover&&!loadCompleted)||blocking||Date.now()-pending.quietSince<500)return true;
  session.pending=undefined;return false;
}
function readDialogState(dialog: HTMLElement | undefined): DialogState {
  if(!dialog){clearConnectionSession();return {present:false,selectedTab:null,busy:false};}
  const selectedTab=selectedDialogTab(dialog),evidence=dialogLoading(dialog,selectedTab);
  return {present:true,selectedTab,busy:connectionTransitionBusy(dialog,selectedTab,evidence.blocking)||evidence.blocking};
}
let activityDiagnostic:{stage:string;dispatches:number;quietMs:number;region:HTMLElement|null;control:HTMLElement|null;url:string}|undefined;
function busyIndicators(scope:HTMLElement){
  const profiles=[...scope.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(link=>visible(link)&&/^\/@[\w.]+\/?$/.test(link.pathname));
  const indicators=loadingIndicators(scope),tab=selectedDialogTab(scope),rows=connectionRows(scope);
  return {total:indicators.length,profileLinks:profiles.length,transitionPending:connectionSession?.dialog===scope&&!!connectionSession.pending,indicators:indicators.slice(0,8).map(el=>{
    const rect=el.getBoundingClientRect();const ancestors=[];let parent=el.parentElement;
    for(let depth=0;parent&&parent!==scope&&depth<4;depth++,parent=parent.parentElement)ancestors.push({tag:parent.tagName,role:parent.getAttribute('role'),profileLinks:profiles.filter(link=>parent!.contains(link)).length});
    return {tag:el.tagName,role:el.getAttribute('role'),label:el.getAttribute('aria-label'),explicit:el.matches('[aria-busy="true"],[role="progressbar"]'),paginationCandidate:connectionPaginationIndicator(el,tab,rows),
      rect:{top:Math.round(rect.top),bottom:Math.round(rect.bottom),height:Math.round(rect.height)},withinViewport:rect.bottom>0&&rect.top<innerHeight,
      profileLinksBefore:profiles.filter(link=>!!(link.compareDocumentPosition(el)&Node.DOCUMENT_POSITION_FOLLOWING)).length,
      profileLinksAfter:profiles.filter(link=>!!(link.compareDocumentPosition(el)&Node.DOCUMENT_POSITION_PRECEDING)).length,ancestors};
  })};
}
function runtimeDiagnostics(dialog:HTMLElement|undefined){
  const activity=activityDiagnostic&&activityDiagnostic.url===location.href?activityDiagnostic:undefined;
  const connection=connectionSession?.dialog===dialog?connectionSession:undefined,pending=connection?.pending;
  return {dialog:dialog?{...busyIndicators(dialog),transition:{pending:!!pending,from:pending?.from??null,to:pending?.target??null,oldRowCount:pending?.baseline.length??0,
    stillConnectedOldRowCount:pending?.baseline.filter(row=>row.node.isConnected&&visible(row.node)&&row.node.href===row.href).length??0,currentRowCount:connection?.rows.length??0,sawBlockingLoad:pending?.blockingObserved??false}}:null,activity:activity?{stage:activity.stage,dispatches:activity.dispatches,quietMs:activity.quietMs,
    regionConnected:!!activity.region?.isConnected,controlConnected:!!activity.control?.isConnected,
    control:activity.control?{tag:activity.control.tagName,role:activity.control.getAttribute('role'),label:label(activity.control),disabled:activity.control.matches(':disabled,[aria-disabled="true"]')}:null,
    region:activity.region?.isConnected?busyIndicators(activity.region):null}:null};
}
function label(el: Element): string {
  const clean=(value:string|null|undefined)=>(value||'').trim().replace(/\s+/g,' ');
  const explicit=clean(el.getAttribute('aria-label'));if(explicit)return explicit.slice(0,250);
  const labelledBy=(el.getAttribute('aria-labelledby')||'').split(/\s+/).filter(Boolean).map(id=>document.getElementById(id)?.textContent||'').join(' ');
  if(clean(labelledBy))return clean(labelledBy).slice(0,250);
  const iconNames:string[]=[];
  for(const icon of el.querySelectorAll('svg')){
    if(icon.closest('button,[role="button"],[role="menuitem"],a')!==el||!rendered(icon)||icon.closest('[aria-hidden="true"],[inert]'))continue;
    const aria=clean(icon.getAttribute('aria-label'));if(aria){iconNames.push(aria);continue;}
    const titles=[clean(icon.getAttribute('title')),...[...icon.children].filter(child=>child.localName==='title').map(child=>clean(child.textContent))].filter(Boolean);
    if(new Set(titles).size>1)return '';
    if(titles[0])iconNames.push(titles[0]);
  }
  if(iconNames.length>1)return '';
  return (iconNames[0]||clean(el.getAttribute('placeholder'))||clean((el as HTMLElement).innerText)).slice(0,250);
}
function context(el: Element): string { return ((el.parentElement?.parentElement as HTMLElement)?.innerText || '').slice(0,500); }
function nearbyEditorState(el:HTMLElement){
  let scope=el.parentElement;
  for(let depth=0;scope&&scope!==document.body&&depth<6;depth++,scope=scope.parentElement){
    const editors=[...scope.querySelectorAll<HTMLElement>('textarea,[contenteditable="true"]')].filter(visible);
    if(editors.length)return editors.map(editor=>editor instanceof HTMLTextAreaElement?editor.value:editor.innerHTML);
    if(scope.matches('main,[role="main"]'))break;
  }
  return null;
}
function fingerprint(el: HTMLElement): string {
  const state = el instanceof HTMLInputElement ? (/password|file|hidden/i.test(el.type) ? null : [el.value,el.checked]) :
    el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ? el.value : el.isContentEditable?el.innerHTML:null;
  return JSON.stringify([el.tagName,el.getAttribute('role'),label(el),el.getAttribute('href'),context(el),state,nearbyEditorState(el),el.getAttribute('aria-pressed'),el.getAttribute('aria-expanded'),el.getAttribute('aria-disabled')]);
}
function guard() {
  if (!['www.threads.com','threads.com','www.threads.net','threads.net'].includes(location.hostname) || location.protocol !== 'https:') throw new Error('WRONG_PAGE: Only Threads pages are supported.');
  const route=routeKey(location.href);
  if(route!==lastObservedRoute){observedRouteChange=true;lastObservedRoute=route;clearActivityBinding();clearConnectionSession();}
}
function viewer() {
  const names=[...document.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(visible)
    .filter(a=>/^(Profile|個人檔案)$/i.test(label(a))&&!a.closest('article,[role="dialog"],[role="menu"]')&&a.protocol==='https:'&&
      ['www.threads.com','threads.com','www.threads.net','threads.net'].includes(a.hostname)&&!a.username&&!a.password&&!a.port)
    .map(a=>a.pathname.match(/^\/@([\w.]+)\/?$/)?.[1]?.toLowerCase()).filter((value):value is string=>!!value);
  const unique=[...new Set(names)];return {username:unique.length===1?unique[0]!:null};
}
function interactive(scope: ParentNode = document): HTMLElement[] {
  return [...scope.querySelectorAll('a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[role="tab"],[role="menuitem"],[contenteditable="true"]')].filter(visible);
}
function readComposerState():ComposerState {
  const state:ComposerState={present:false,nonempty:false,attachments:false,ambiguous:false};
  const editors=[...document.querySelectorAll<HTMLElement>('textarea,[contenteditable="true"],input:not([type]),input[type="text"],input[type="search"]')].filter(visible);
  const removeMedia=(el:Element)=>/^(?:Remove|Delete|移除|刪除)(?:\s*(?:media|image|photo|video|attachment|圖片|相片|影片|附件))/i.test(label(el));
  for(const editor of editors){
    const name=[editor.getAttribute('aria-label'),editor.getAttribute('placeholder'),editor.getAttribute('aria-placeholder')].filter(Boolean).join(' ');
    if(editor.matches('input[type="search"],[role="searchbox"]')||editor.closest('[role="search"]')||/^(?:Search|搜尋|搜索)(?:\s|$)/i.test(name))continue;
    const dialog=editor.closest<HTMLElement>('[role="dialog"]');
    const body=editor.closest<HTMLElement>('[data-barcelona-composer-body="true"]');
    const recognized=!!body||editor.getAttribute('data-lexical-editor')==='true'||/(?:new (?:thread|post)|reply|what(?:’|')?s new|start a thread|撰寫|新貼文|新串文|回覆)/i.test(name);
    if(!recognized)state.ambiguous=true;
    const value=editor instanceof HTMLInputElement||editor instanceof HTMLTextAreaElement?editor.value:editor.textContent||'';
    const nonempty=!!value.replace(/[\s\u200b\ufeff]/g,'');
    let scope=body||dialog||editor.parentElement;
    if(!body&&!dialog){
      // Inline attachments may be siblings several wrappers above the editor.
      for(let node=editor.parentElement,depth=0;node&&node!==document.body&&!node.matches('main,[role="main"],article')&&depth<8;node=node.parentElement,depth++){
        if(node.querySelectorAll('textarea,[contenteditable="true"]').length>1)break;
        if(node.querySelector('input[type="file"],img[src^="blob:"],video[src^="blob:"]')||interactive(node).some(removeMedia)){scope=node;break;}
      }
    }
    const files=scope?[...scope.querySelectorAll<HTMLInputElement>('input[type="file"]')].some(input=>!!input.files?.length):false;
    const previews=scope?[...scope.querySelectorAll('img,video')].filter(visible).some(el=>
      /^(?:blob:|data:image\/)/i.test(el.getAttribute('src')||'')||!!body&&(el.tagName==='VIDEO'||!/(?:profile picture|profile photo|大頭貼|頭像)/i.test(el.getAttribute('alt')||''))):false;
    const attachments=files||previews||!!scope&&interactive(scope).some(removeMedia);
    state.nonempty||=nonempty;state.attachments||=attachments;state.present||=!!dialog||nonempty||attachments;
  }
  return state;
}
export function snapshot(): PageSnapshot {
  guard();
  current = { id: crypto.randomUUID(), url: location.href, expires: Date.now()+120_000, entries:new Map() };
  const elements = interactive().slice(0,300).map((element,i): ElementRef => {
    const ref=String(i+1); current!.entries.set(ref,{element,fingerprint:fingerprint(element)});
    return {ref,role:element.getAttribute('role') || element.tagName.toLowerCase(), name:label(element),text:element.innerText?.slice(0,300) || '',...(element instanceof HTMLAnchorElement ? {href:element.href} : {}),editable:element.matches('input,textarea,select,[contenteditable="true"]'),...(element instanceof HTMLInputElement && ['checkbox','radio'].includes(element.type) ? {checked:element.checked} : {}),context:context(element)};
  });
  return {snapshotId:current.id,url:location.href,title:document.title,viewer:viewer(),elements,text:document.body.innerText.slice(0,24000)};
}
export function interact(args: {snapshotId:string;ref:string;verb:'click'|'fill'|'press'|'select'|'check';value?:string}) {
  guard();
  if (!current || current.id!==args.snapshotId || current.url!==location.href || Date.now()>current.expires) throw new Error('STALE_SNAPSHOT: Get a new browser snapshot before acting.');
  const entry=current.entries.get(args.ref);
  if (!entry || !entry.element.isConnected || !visible(entry.element) || entry.fingerprint!==fingerprint(entry.element)) throw new Error('STALE_ELEMENT: The target changed. Get a new snapshot.');
  const el=entry.element;
  if (el.matches(':disabled,[aria-disabled="true"]')) throw new Error('DISABLED_ELEMENT: The target is disabled.');
  current=undefined; // An uncertain dispatch must not be replayed with the same reference.
  if (args.verb==='click') el.click();
  else if (args.verb==='fill') {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el instanceof HTMLInputElement && /password|file/i.test(el.type)) throw new Error('UNSUPPORTED_INPUT: Credentials and files require manual input.');
      const proto=el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto,'value')?.set?.call(el,args.value || '');
      el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
    } else if (el.isContentEditable) {
      el.focus(); el.textContent=args.value || ''; el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:args.value || ''}));
    } else throw new Error('NOT_EDITABLE: Target is not a text input.');
  } else if (args.verb==='select') {
    if (!(el instanceof HTMLSelectElement)) throw new Error('NOT_SELECT: Target is not a select.');
    if (![...el.options].some(o=>o.value===args.value)) throw new Error('INVALID_OPTION: Option is not present.');
    el.value=args.value!;el.dispatchEvent(new Event('change',{bubbles:true}));
  } else if (args.verb==='check') {
    if (!(el instanceof HTMLInputElement) || !['checkbox','radio'].includes(el.type)) throw new Error('NOT_CHECKBOX: Target is not a checkbox.');
    if (el.checked!==(args.value==='true')) el.click();
  } else if (args.verb==='press') {
    if (!['Enter','Escape','Tab','ArrowDown','ArrowUp'].includes(args.value || '')) throw new Error('UNSUPPORTED_KEY: Key is not allowed.');
    el.focus(); const event={key:args.value,code:args.value,bubbles:true,cancelable:true};el.dispatchEvent(new KeyboardEvent('keydown',event));el.dispatchEvent(new KeyboardEvent('keyup',event));
  }
  return {dispatched:true,verified:false,message:'Input dispatched. Inspect a fresh snapshot to verify the application result.'};
}
function scrollTarget(): HTMLElement {
  const dialog=visibleDialog();
  const scope=dialog || document;
  const options=[...scope.querySelectorAll<HTMLElement>('div,section,main')].filter(el=>visible(el) && el.scrollHeight>el.clientHeight+80 && /(auto|scroll)/.test(getComputedStyle(el).overflowY));
  options.sort((a,b)=> b.clientHeight-a.clientHeight);
  return options[0] || document.scrollingElement as HTMLElement || document.documentElement;
}
export function scroll(pixels: number) { guard();current=undefined;const el=scrollTarget(); const before=el.scrollTop;el.scrollBy(0,Math.max(-2200,Math.min(2200,pixels)));return {before,after:el.scrollTop}; }
export async function openReadPanel(panel: 'followers'|'following'|'likers',activityTab?:'likes'|'reposts') {
  guard();current=undefined;
  if(panel==='likers')return openPostActivity(activityTab);
  const dialog=visibleDialog();
  if(panel==='following'&&!dialog)throw new Error('UI_CHANGED: Open the follower dialog before selecting its Following tab.');
  // A row's Following button may unfollow an account. Only the dialog tab is read-only.
  const controls=interactive(dialog || document).filter(el=>panel!=='following'||el.getAttribute('role')==='tab');
  const matcher=panel==='following' && dialog ? /^(Following|追蹤中)(?:\s*[\d.,萬万KMB]+)?$/i : /(?:\d[\d.,\s萬万KMB]*\s*(followers|位粉絲)|followers\s*\d)/i;
  const matches=controls.filter(el=>matcher.test(label(el)));
  if (matches.length!==1) throw new Error('UI_CHANGED: Could not identify a unique read-only panel control; use a fresh browser snapshot.');
  const matched=matches[0]!;
  // Threads wraps a clickable button inside its ARIA tab; click only a uniquely
  // identified descendant of that tab, never a Following button in a user row.
  const tabButtons=matched.getAttribute('role')==='tab'?interactive(matched).filter(el=>el.matches('button,[role="button"]')):[];
  if(tabButtons.length>1)throw new Error('UI_CHANGED: The selected tab contains multiple action controls.');
  if(dialog&&panel==='following')readDialogState(dialog);
  (tabButtons[0]||matched).click(); return {opened:panel,verified:false};
}

let activityBinding:{url:string;code:string;dialog:HTMLElement;observer:MutationObserver}|undefined;
function clearActivityBinding(){activityBinding?.observer.disconnect();activityBinding=undefined;}
function checkActivitySession(records:MutationRecord[]=[]){
  const binding=activityBinding;if(!binding)return;
  if(!binding.dialog.isConnected||!visible(binding.dialog)||currentPostTarget()?.url!==binding.url){clearActivityBinding();return;}
  for(const record of records){
    // Removal/reinsertion or a hide/show cycle ends the old modal session, even
    // if both happened before the next read. Hidden inner overview sections are
    // normal list transitions and do not invalidate their still-visible shell.
    if(record.type==='childList'&&[...record.removedNodes].some(node=>node===binding.dialog||node.contains(binding.dialog))){clearActivityBinding();return;}
    if(record.type==='attributes'&&(record.target===binding.dialog||record.target.contains(binding.dialog))&&
      (record.attributeName==='aria-hidden'&&record.oldValue==='true'||['hidden','inert'].includes(record.attributeName||'')&&record.oldValue!==null||
        record.attributeName==='style'&&/(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(record.oldValue||''))){clearActivityBinding();return;}
  }
}
function sessionOwns(dialog:HTMLElement,target:{url:string;code:string}){
  const binding=activityBinding;if(!binding)return false;checkActivitySession(binding.observer.takeRecords());
  if(activityBinding!==binding)return false;
  if(!binding.dialog.contains(dialog)){clearActivityBinding();return false;}
  return binding.url===target.url&&binding.code===target.code;
}
function bindActivitySession(target:{url:string;code:string},dialog:HTMLElement){
  if(sessionOwns(dialog,target))return;
  clearActivityBinding();const observer=new MutationObserver(records=>checkActivitySession(records));
  activityBinding={...target,dialog,observer};
  observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeOldValue:true,attributeFilter:['aria-hidden','hidden','inert','style','class']});
}
function currentPostTarget(){
  const match=location.pathname.match(/^\/@([\w.]+)\/post\/([\w-]+)\/?$/);
  return match?{url:`https://www.threads.com/@${match[1]}/post/${match[2]}`,code:match[2]!}:null;
}
function postActivity(dialog:HTMLElement|undefined):PostActivityEvidence|undefined {
  if(!dialog){clearActivityBinding();return undefined;}
  const headings=[...dialog.querySelectorAll<HTMLElement>('h1,h2,[role="heading"]')].filter(visible).map(el=>el.innerText.trim());
  const title=headings.find(text=>/^(?:貼文動態|Post activity|Activity|[\d,.萬万KMB]+\s*個讚|[\d,.萬万KMB]+\s*次轉發|[\d,.KMB]+\s+(?:likes?|reposts?)|Likes|Reposts)$/i.test(text));
  if(!title)return undefined;
  const selectedTab:PostActivityEvidence['selectedTab']=/個讚$|\blikes?$/i.test(title)?'likes':/次轉發$|\breposts?$/i.test(title)?'reposts':null;
  const target=currentPostTarget();
  // The previous overview remains hidden inside the same modal after selecting a
  // subview. Its exact post reference is identity evidence only, never user-list evidence.
  const codes=[...new Set([...dialog.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(a=>a.protocol==='https:'&&['www.threads.com','threads.com','threads.net','www.threads.net'].includes(a.hostname)&&!a.port&&!a.username&&!a.password)
    .flatMap(a=>{const match=a.pathname.match(/^\/(?:insights\/post|@[\w.]+\/post)\/([\w-]+)\/?$/);return match?[match[1]!]:[];}))];
  if(target&&codes.length&&(codes.length!==1||codes[0]!==target.code))clearActivityBinding();
  const owned=!!target&&sessionOwns(dialog,target);
  const bound=!!target&&(codes.length===1&&codes[0]===target.code||codes.length===0&&owned);
  const busy=readDialogState(dialog).busy;
  const countFor=(re:RegExp)=>{
    const matches=interactive(dialog).filter(el=>el.matches('button,[role="button"],a')&&re.test(el.innerText.replace(/\s+/g,'')));
    return matches.length===1?parseCount(matches[0]!.innerText):null;
  };
  const counts={likes:selectedTab==='likes'?parseCount(title):countFor(/^(?:按讚內容|Likes)[\d,.萬万KMB]*$/i),reposts:selectedTab==='reposts'?parseCount(title):countFor(/^(?:轉發|Reposts?)[\d,.萬万KMB]*$/i),views:countFor(/^(?:洞察報告|Insights)[\d,.萬万KMB]+(?:次瀏覽|views)?$/i)};
  const users=new Map<string,Profile>();
  if(bound&&selectedTab&&!busy)for(const row of [...dialog.querySelectorAll<HTMLElement>('[data-pressable-container="true"],[role="listitem"]')].filter(visible)){
    if(![...row.querySelectorAll('time')].some(time=>rendered(time)&&!time.closest('[aria-hidden="true"],[inert]')))continue;
    const names=[...new Set([...row.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(visible).filter(a=>a.protocol==='https:'&&['www.threads.com','threads.com','threads.net','www.threads.net'].includes(a.hostname)&&!a.username&&!a.password&&!a.port)
      .flatMap(a=>{const match=a.pathname.match(/^\/@([\w.]+)\/?$/);return match?[match[1]!.toLowerCase()]:[];}))];
    if(names.length!==1)continue;const username=names[0]!;
    users.set(username,{username,url:`https://www.threads.com/@${username}`,bio:null,followers:null,following:null,private:null,links:[]});
  }
  return {present:true,targetUrl:bound?target!.url:null,targetCode:bound?target!.code:null,selectedTab,users:[...users.values()],displayedCount:selectedTab==='likes'?counts.likes:selectedTab==='reposts'?counts.reposts:null,counts,busy,
    warnings:[...(!bound?['Activity dialog target was not bound to the exact current post.']:[]),...(!selectedTab?['The activity overview is not a selected liker or reposter list.']:[]),'Only visible, structurally identified activity user rows are included; displayed totals do not prove complete collection.']};
}
function waitActivity<T>(stage:string,read:()=>T|undefined):Promise<T>{
  // React may render a loading dialog first. Observe DOM completion directly so
  // background-tab timer throttling does not postpone an already visible result.
  return new Promise<T>((resolve,reject)=>{
    const deadline=Date.now()+8000;let timer:ReturnType<typeof setTimeout>|undefined;let settled=false;
    const observer=new MutationObserver(check);
    function finish(value:T|undefined,error?:unknown){if(settled)return;settled=true;observer.disconnect();if(timer)clearTimeout(timer);if(error)reject(error);else resolve(value!);}
    function check(){
      if(settled)return;
      try{const value=read();if(value!==undefined){finish(value);return;}
        if(Date.now()>=deadline){finish(undefined,new Error(`ACTIVITY_${stage.toUpperCase()}_TIMEOUT: The post activity ${stage} did not become identifiable within 8 seconds.`));return;}
        if(timer)clearTimeout(timer);timer=setTimeout(check,Math.min(250,deadline-Date.now()));
      }catch(error){finish(undefined,error);}
    }
    observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});check();
  });
}
async function openPostActivity(activityTab?:'likes'|'reposts'){
  const target=currentPostTarget();if(!target)throw new Error('INVALID_INPUT: Open the exact post permalink before its activity.');
  activityDiagnostic={stage:'initial',dispatches:0,quietMs:0,region:null,control:null,url:location.href};
  let dialog=visibleDialog();
  if(!dialog){
    // SSR can expose the target control before the surrounding post is interactive.
    // The observed root-region loading placeholder must disappear before the
    // first click. Reacquire the card after React replaces any initial nodes.
    const activityControl=(el:HTMLElement)=>/^(?:View activity|Post activity|查看動態|貼文動態)$/i.test(label(el));
    let stability:{card:HTMLElement;region:HTMLElement;control:HTMLElement|null;signature:string;quietSince:number;observer:MutationObserver}|undefined;
    const ready=await waitActivity('readiness',()=>{
      if(currentPostTarget()?.url!==target.url)throw new Error('CONTEXT_CHANGED: The post changed before activity was ready.');
      const candidates=new Set<HTMLElement>();
      const links=[...document.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(visible).filter(a=>/^\/@[\w.]+\/post\/[\w-]+\/?$/.test(a.pathname));
      for(const link of links.filter(a=>a.pathname.replace(/\/$/,'')===new URL(target.url).pathname)){
        let node:HTMLElement|null=link;for(let depth=0;node&&node!==document.body&&depth<16;depth++,node=node.parentElement){
          const reactions=interactive(node).filter(el=>el.matches('button,[role="button"]')&&/^(?:Like|Unlike|讚|收回讚)(?:\s*\d[\d.,萬万KMB]*)?$/i.test(label(el)));
          if(reactions.length>1)break;
          if(reactions.length===1&&!links.some(a=>node!.contains(a)&&a.pathname.replace(/\/$/,'')!==new URL(target.url).pathname)){candidates.add(node);break;}
        }
      }
      const isolated=[...candidates].filter(candidate=>![...candidates].some(other=>other!==candidate&&candidate.contains(other)));
      if(isolated.length!==1)return undefined;
      const card=isolated[0]!;let readyRegion=card;let options=interactive(card).filter(activityControl);
      // View activity and the hydration placeholder can be siblings of the
      // narrow card. Readiness belongs to their bounded common post region.
      if(options.length===0){
        for(let region=card.parentElement,depth=0;region&&region!==document.body&&!region.matches('main,[role="main"],nav,aside')&&depth<8;region=region.parentElement,depth++){
          if(links.some(a=>region!.contains(a)&&a.pathname.replace(/\/$/,'')!==new URL(target.url).pathname))break;
          const reactions=interactive(region).filter(el=>el.matches('button,[role="button"]')&&/^(?:Like|Unlike|讚|收回讚)(?:\s*\d[\d.,萬万KMB]*)?$/i.test(label(el)));
          if(reactions.length!==1)break;
          const adjacent=interactive(region).filter(activityControl);if(adjacent.length){options=adjacent;readyRegion=region;break;}
        }
      }
      if(options.length>1)throw new Error('UI_CHANGED: Multiple activity controls were found in the exact-post region.');
      const control=options[0]??interactive(card).find(el=>/^(?:More|More options|更多|更多選項)$/i.test(label(el))&&/^(?:menu|true)$/.test(el.getAttribute('aria-haspopup')||''))??null;
      const signature=control?JSON.stringify([control.tagName,control.getAttribute('role'),label(control),control.getAttribute('aria-disabled'),control.getAttribute('disabled')]):'';
      if(!stability||stability.card!==card||stability.region!==readyRegion||stability.control!==control||stability.signature!==signature){
        stability?.observer.disconnect();const observer=new MutationObserver(()=>{if(stability)stability.quietSince=Date.now();});
        stability={card,region:readyRegion,control,signature,quietSince:Date.now(),observer};
        observer.observe(readyRegion,{subtree:true,childList:true,characterData:true,attributes:true});
      }
      if(stability.observer.takeRecords().length||readDialogState(readyRegion).busy||control?.matches(':disabled,[aria-disabled="true"]'))stability.quietSince=Date.now();
      const quietMs=Date.now()-stability.quietSince;
      activityDiagnostic={stage:'readiness',dispatches:0,quietMs,region:readyRegion,control,url:location.href};
      return quietMs>=2500?{card,options}:undefined;
    }).finally(()=>stability?.observer.disconnect());
    const card=ready.card;let options=ready.options;
    if(options.length!==1){
      if([...document.querySelectorAll('[role="menu"]')].some(visible))throw new Error('EXISTING_OVERLAY: Close the existing menu before opening post activity.');
      const more=interactive(card).filter(el=>/^(?:More|More options|更多|更多選項)$/i.test(label(el))&&/^(?:menu|true)$/.test(el.getAttribute('aria-haspopup')||''));
      if(more.length!==1)throw new Error('UI_CHANGED: A unique exact-post More menu is required to open activity.');
      activityDiagnostic!.stage='menu';activityDiagnostic!.dispatches++;more[0]!.click();options=await waitActivity('menu',()=>{
        const menus=[...document.querySelectorAll<HTMLElement>('[role="menu"],[role="dialog"]')].filter(visible);
        const found=menus.flatMap(menu=>interactive(menu).filter(el=>/^(?:View activity|Post activity|查看動態|貼文動態)$/i.test(label(el))));return found.length===1?found:undefined;
      });
    }
    if(currentPostTarget()?.url!==target.url||!options[0]!.isConnected||!visible(options[0]!))throw new Error('CONTEXT_CHANGED: The post or activity control changed before activity opened.');
    clearActivityBinding();activityDiagnostic!.stage='overview';activityDiagnostic!.control=options[0]!;activityDiagnostic!.dispatches++;options[0]!.click();dialog=await waitActivity('overview',()=>{
      if(currentPostTarget()?.url!==target.url)throw new Error('CONTEXT_CHANGED: The post changed while activity opened.');
      const active=visibleDialog();const state=postActivity(active);
      if(!active||!state||state.busy)return undefined;
      if(state.targetUrl===target.url){bindActivitySession(target,active);return active;}
      // Only the overview reached directly from the exact root control can
      // establish a no-link session; arbitrary selected lists cannot inherit it.
      if(state.selectedTab===null&&!active.querySelector('a[href*="/post/"]')){bindActivitySession(target,active);return active;}
      throw new Error('TARGET_UNVERIFIED: The opened activity view does not identify the requested post.');
    });
  }
  const state=postActivity(dialog);
  if(!state||state.targetUrl!==target.url)throw new Error('TARGET_UNVERIFIED: The activity dialog does not identify the requested post.');
  bindActivitySession(target,dialog);
  if(activityTab&&state.selectedTab!==activityTab){
    if(state.selectedTab)throw new Error('UI_CHANGED: Return to the activity overview before selecting another activity list.');
    const pattern=activityTab==='likes'?/^(?:按讚內容|Likes)[\d,.萬万KMB]*$/i:/^(?:轉發|Reposts?)[\d,.萬万KMB]*$/i;
    const choices=interactive(dialog).filter(el=>el.matches('button,[role="button"]')&&pattern.test(el.innerText.replace(/\s+/g,'')));
    if(choices.length!==1)throw new Error('UI_CHANGED: A unique activity-list selector was not observed.');
    activityDiagnostic!.stage=activityTab;activityDiagnostic!.dispatches++;choices[0]!.click();await waitActivity(activityTab,()=>{const active=postActivity(visibleDialog());if(currentPostTarget()?.url!==target.url)throw new Error('CONTEXT_CHANGED: The post changed while activity loaded.');return active?.targetUrl===target.url&&active.selectedTab===activityTab&&!active.busy?active:undefined;});
  }
  activityDiagnostic!.stage='complete';
  return {opened:'likers',activityTab:activityTab??null,targetUrl:target.url,verified:false};
}

function domPosts(observedAt:string): Post[] {
  const results:Post[]=[];
  const reaction=/^(Like|Unlike|讚|收回讚)(?:\s*\d[\d.,]*(?:\s*[萬万億亿KMB])?)?$/i;
  const links=[...document.querySelectorAll<HTMLAnchorElement>('a[href*="/post/"]')].filter(link=>visible(link)&&link.protocol==='https:'&&
    ['www.threads.com','threads.com','www.threads.net','threads.net'].includes(link.hostname)&&!link.username&&!link.password&&!link.port)
    .flatMap(link=>{const match=link.pathname.match(/^\/@([\w.]+)\/post\/([\w-]+)\/?$/);return match?[{link,username:match[1]!,code:match[2]!}]:[];});
  const byCode=new Map<string,typeof links>();for(const entry of links)byCode.set(entry.code,[...(byCode.get(entry.code)??[]),entry]);
  for(const [code,entries] of byCode){
    const candidates=new Set<HTMLElement>();
    for(const {link} of entries){let candidate:HTMLElement|null=link;
      for(let depth=0;candidate&&depth<14;depth++,candidate=candidate.parentElement){
        if(candidate===document.body||candidate.matches('main,[role="main"]'))break;
        const controls=interactive(candidate).filter(el=>el.matches('button,[role="button"]')&&reaction.test(label(el)));
        if(controls.length>1)break;
        if(controls.length===1&&!links.some(other=>other.code!==code&&candidate!.contains(other.link))){candidates.add(candidate);break;}
      }
    }
    const isolated=[...candidates].filter(candidate=>![...candidates].some(other=>other!==candidate&&candidate.contains(other)));
    if(isolated.length!==1)continue;
    const card=isolated[0]!;const identity=entries.find(entry=>card.contains(entry.link))!;
    // The smallest ancestor containing its own reaction controls is a post card.
    const buttons=interactive(card);
    const metric=(re:RegExp) => {const matches=buttons.filter(e=>e.matches('button,[role="button"]')&&re.test(label(e)));const b=matches.length===1?matches[0]:null;return b ? parseCount(b.innerText.replace(/\s+/g,' '))??parseCount(label(b)) : null;};
    const walker=document.createTreeWalker(card,NodeFilter.SHOW_TEXT);const textParts:string[]=[];
    let node:Node|null;
    while((node=walker.nextNode())) {
      const parent=node.parentElement;
      if (!parent || parent.closest('a,button,[role="button"],time,svg,script,style') || !visible(parent))continue;
      const value=node.textContent?.trim();if(value)textParts.push(value);
    }
    const time=card.querySelector('time[datetime]')?.getAttribute('datetime');
    const normalizedTime=time&&Number.isFinite(Date.parse(time)) ? new Date(time).toISOString() : null;
    const like=buttons.find(e=>e.matches('button,[role="button"]')&&reaction.test(label(e)));
    results.push({id:`url:${code}`,code,url:`https://www.threads.com/@${identity.username}/post/${code}`,author:{username:identity.username},text:textParts.join('\n'),createdAt:normalizedTime,likes:metric(reaction),replies:metric(/^(Reply|Replied|回覆|已回覆)(?:\s*\d[\d.,]*(?:\s*[萬万億亿KMB])?)?$/i),reposts:metric(/^(Repost|轉發)(?:\s*\d[\d.,]*(?:\s*[萬万億亿KMB])?)?$/i),quotes:null,views:null,isReply:null,parentId:null,rootId:null,likedByViewer:like ? /^(Unlike|收回讚)/i.test(label(like)) : null,media:[],observedAt,source:'browser-dom'});
  }
  return results;
}
function dialogUsers(dialog: HTMLElement | undefined): Profile[] {
  if(!dialog)return [];
  const map=new Map<string,Profile>();
  for(const link of dialog.querySelectorAll<HTMLAnchorElement>('a[href^="/@"]')) {
    const username=link.pathname.match(/^\/@([\w.]+)\/?$/)?.[1];if(!username||map.has(username)||!visible(link)||link.closest('[aria-hidden="true"]'))continue;
    map.set(username,{username,bio:null,followers:null,following:null,private:null,url:`https://www.threads.com/@${username}`,links:[]});
  }
  return [...map.values()];
}
// Exact notification badge geometry visually verified against the selected activity view on 2026-10-24.
// The 18x18 badge is distinct from the 24x24 post reaction controls; changed paths remain unknown.
const notificationBadgePaths:Record<string,string>={"like":"M5 8.33956C5 6.84296 6.07645 5.75 7.48174 5.75C8.08884 5.75 8.61175 5.95938 9.00094 6.30299C9.3914 5.95863 9.91188 5.75 10.5183 5.75C11.9276 5.75 13 6.84345 13 8.33956C13 9.20812 12.6297 10.037 12.0266 10.7947C11.4237 11.5521 10.5712 12.2609 9.5565 12.9023L9.55379 12.904C9.48997 12.9437 9.41108 12.9882 9.32747 13.0242C9.25284 13.0563 9.1332 13.1001 9 13.1001C8.86687 13.1001 8.74693 13.0551 8.67518 13.0242C8.59318 12.9889 8.51482 12.9453 8.45151 12.9072L8.44748 12.9048L8.4435 12.9023C7.42882 12.2609 6.57626 11.5521 5.97338 10.7947C5.37032 10.037 5 9.20812 5 8.33956Z","follow":"M5.81283 13C5.55932 13 5.35968 12.9466 5.2139 12.8398C5.0713 12.736 5 12.5921 5 12.4082C5 12.1235 5.0919 11.8224 5.2757 11.505C5.4595 11.1876 5.72569 10.891 6.07427 10.6151C6.42286 10.3363 6.84274 10.1109 7.33393 9.93882C7.82828 9.76381 8.38285 9.67631 8.99762 9.67631C9.61557 9.67631 10.1701 9.76381 10.6613 9.93882C11.1557 10.1109 11.5756 10.3363 11.921 10.6151C12.2696 10.891 12.5357 11.1876 12.7195 11.505C12.9065 11.8224 13 12.1235 13 12.4082C13 12.5921 12.9271 12.736 12.7813 12.8398C12.6387 12.9466 12.4407 13 12.1872 13H5.81283ZM9.00238 8.87987C8.6633 8.87987 8.34957 8.79384 8.0612 8.6218C7.77283 8.44679 7.53991 8.21246 7.36245 7.9188C7.18816 7.62217 7.10101 7.28995 7.10101 6.92214C7.10101 6.56025 7.18816 6.23396 7.36245 5.94327C7.53991 5.65258 7.77283 5.42269 8.0612 5.25362C8.34957 5.08454 8.6633 5 9.00238 5C9.34145 5 9.65518 5.08306 9.94355 5.24917C10.2319 5.41528 10.4633 5.64368 10.6376 5.93437C10.815 6.2221 10.9037 6.54839 10.9037 6.91324C10.9037 7.28402 10.815 7.61772 10.6376 7.91435C10.4633 8.21098 10.2319 8.44679 9.94355 8.6218C9.65518 8.79384 9.34145 8.87987 9.00238 8.87987Z","reply":"M8.62523 12.5C8.5337 12.5 8.44836 12.4796 8.3692 12.4389C8.29004 12.4008 8.20594 12.3384 8.11688 12.2519L5.18924 9.4084C5.1175 9.33969 5.06803 9.26972 5.04082 9.19847C5.01361 9.12723 5 9.06107 5 9C5 8.93639 5.01361 8.86896 5.04082 8.79771C5.06803 8.72646 5.1175 8.65649 5.18924 8.58779L8.11688 5.77099C8.21583 5.6743 8.30117 5.6056 8.37291 5.56489C8.44465 5.52163 8.52628 5.5 8.61781 5.5C8.74892 5.5 8.85529 5.5458 8.93692 5.6374C9.01855 5.72901 9.05937 5.83842 9.05937 5.96565V7.4084H9.16698C9.83488 7.4084 10.41 7.51399 10.8924 7.72519C11.3772 7.93639 11.7743 8.24173 12.0835 8.64122C12.3952 9.04071 12.6252 9.5229 12.7737 10.0878C12.9246 10.6501 13 11.2837 13 11.9885C13 12.1539 12.9604 12.2799 12.8813 12.3664C12.8046 12.4555 12.7168 12.5 12.6178 12.5C12.5387 12.5 12.4583 12.4835 12.3766 12.4504C12.2975 12.4173 12.2257 12.3397 12.1614 12.2176C11.9462 11.8003 11.6976 11.4746 11.4156 11.2405C11.1336 11.0038 10.8083 10.8372 10.4397 10.7405C10.0711 10.6438 9.64688 10.5954 9.16698 10.5954H9.05937V12.0534C9.05937 12.1832 9.01855 12.2901 8.93692 12.374C8.85529 12.458 8.75139 12.5 8.62523 12.5Z"};
function notificationBadge(row:HTMLElement):NotificationRowEvidence['badge'] {
  const icons=[...row.querySelectorAll('svg')].filter(icon=>icon.getAttribute('viewBox')?.trim()==='0 0 18 18'&&rendered(icon)&&!icon.closest('[aria-hidden="true"],[inert]')&&icon.querySelectorAll('path').length===1);
  if(!icons.length)return undefined;
  if(icons.length!==1)return {kind:'unknown',signature:null};
  const path=icons[0]!.querySelector('path')?.getAttribute('d');
  const kind=Object.keys(notificationBadgePaths).find(kind=>notificationBadgePaths[kind]===path) as 'like'|'follow'|'reply'|undefined;
  return {kind:kind??'unknown',signature:kind?'threads-18-'+kind+'-v1':null};
}
function notificationRows(): NotificationRowEvidence[] {
  if(!/^\/activity(?:\/|$)/.test(location.pathname))return [];
  const rows=new Set<HTMLElement>();
  // A single timestamp plus profile links bounds one observed notification row.
  // Never attribute actors from the complete page or from a neighbouring row.
  for(const time of document.querySelectorAll('time')) {
    if(!rendered(time)||time.closest('nav,[role="navigation"],[aria-hidden="true"]'))continue;
    let candidate:HTMLElement|null=time.parentElement;let selected:HTMLElement|null=null;
    for(let depth=0;candidate&&depth<12;depth++,candidate=candidate.parentElement){
      if(candidate===document.body||candidate.matches('main,aside,[role="main"],[role="complementary"]')||candidate.querySelectorAll('time').length!==1)break;
      if(candidate.querySelector('nav,aside,[role="navigation"],[role="complementary"]'))break;
      const profiles=[...candidate.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(a=>/^\/@[\w.]+\/?$/.test(a.pathname)&&visible(a)&&!a.closest('[aria-hidden="true"]'));
      if(profiles.some(link=>/^(Profile|個人檔案)$/i.test(label(link))))break;
      const text=candidate.innerText?.trim()||'';
      const postLink=[...candidate.querySelectorAll<HTMLAnchorElement>('a[href]')].some(link=>/\/post\/[\w-]+/.test(link.pathname));
      const action=/(?:liked your|replied to you|mentioned you|reposted your|quoted your|following you|followed you|回覆了你|提及了你|提到了你|轉發了你|開始追蹤你|追蹤了你|已追蹤你|讚了你的)/i.test(text);
      const badge=notificationBadge(candidate);
      if(profiles.length&&text.length<4000&&badge){selected=candidate;break;}
      // Keep the nearest text-only fallback, but continue to the avatar badge's
      // enclosing row. Aggregate headers can precede the badge by several levels.
      if(!selected&&profiles.length&&text.length<4000&&(postLink||action))selected=candidate;
    }
    // Post cards can be expanded alongside activity rows; do not mislabel them as events.
    if(selected&&(notificationBadge(selected)||!interactive(selected).some(el=>/^(Like|Unlike|Reply|Replied|讚|收回讚|回覆|已回覆)(?:\s*\d|$)/i.test(label(el)))))rows.add(selected);
  }
  return [...rows].slice(0,100).map(row=>{
    const links=[...row.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(a=>visible(a)&&!a.closest('[aria-hidden="true"]'));
    const time=row.querySelector('time');let header:HTMLElement|null=time?.parentElement??null;
    while(header&&header!==row&&!links.some(link=>/^\/@[\w.]+\/?$/.test(link.pathname)&&header!.contains(link)))header=header.parentElement;
    const actorLinks=links.filter(link=>header?.contains(link));
    const aggregate=header?.innerText.match(/和另外\s*([\d,]+)\s*人|and\s+([\d,]+)\s+others?/i);
    const additionalActorCount=aggregate?Number((aggregate[1]??aggregate[2]).replaceAll(',','')):null;
    const actionText=[...row.querySelectorAll<HTMLElement>('span,div')].filter(el=>visible(el)&&!el.closest('a,button,[role="button"]')).map(el=>el.innerText.trim()).find(text=>/^(?:已追蹤你|開始追蹤你|追蹤了你|started following you|followed you)$/i.test(text))??null;
    return {text:row.innerText.slice(0,4000),actorLinks:actorLinks.flatMap(a=>{
      const username=a.pathname.match(/^\/@([\w.]+)\/?$/)?.[1];
      return username?[{username,url:a.href}]:[];
    }),postLinks:[...new Set(links.filter(a=>/\/post\/[\w-]+/.test(a.pathname)).map(a=>a.href))],timeLabel:time?.textContent?.trim()||null,timestamp:time?.getAttribute('datetime')||null,badge:notificationBadge(row),actionText,additionalActorCount};
  });
}
function searchProfiles(): Profile[] {
  if(location.pathname!=='/search'||new URL(location.href).searchParams.get('filter')!=='profiles')return [];
  const found=new Map<string,Profile>();
  const scope=document.querySelector('main,[role="main"]')??document;
  for(const link of scope.querySelectorAll<HTMLAnchorElement>('a[href]')){
    const name=link.pathname.match(/^\/@([\w.]+)\/?$/)?.[1];
    if(!name||link.protocol!=='https:'||(link.port&&link.port!=='443')||!['www.threads.com','threads.com','www.threads.net','threads.net'].includes(link.hostname)||link.username||link.password||!visible(link)||link.closest('nav,aside,[role="navigation"],[role="complementary"],[aria-hidden="true"]')||/^(Profile|個人檔案)$/i.test(label(link)))continue;
    found.set(name.toLowerCase(),{username:name,url:link.href,bio:null,followers:null,following:null,private:null,links:[]});
  }
  return [...found.values()];
}
export function readPage(): PageRead {
  guard();const observedAt=new Date().toISOString();const payloads:unknown[]=[];let size=0;
  for(const script of document.querySelectorAll('script[type="application/json"]')) {
    const value=script.textContent || '';size+=value.length;if(size>12_000_000)break;
    payloads.push(...parseWire(value));
  }
  const rootCode=location.pathname.match(/\/post\/([\w-]+)/)?.[1];
  const parsed=parsePayloads(payloads,{rootCode,observedAt});
  const dom=domPosts(observedAt);
  // Navigation Timing describes the fetched document even when a SPA changed its URL
  // before this runtime attached. Keep an observed change latched after navigating back.
  const navigation=performance.getEntriesByType('navigation')[0];
  const documentRoute=navigation ? routeKey(navigation.name) : null;
  const documentMatches=documentRoute!==null&&documentRoute===routeKey(location.href)&&!observedRouteChange;
  // If the document no longer matches, only borrow a stable canonical ID for a visible
  // post. Do not promote old SSR text, counts, profiles or reply relations into this read.
  const merged=documentMatches ? dedupePosts([...dom,...parsed.posts]) : dom.map(post=>{
    const json=parsed.posts.find(candidate=>candidate.code===post.code&&candidate.author.username===post.author.username);
    return json ? {...post,id:json.id,author:{...post.author,...(json.author.id ? {id:json.author.id} : {})}} : post;
  });
  // Visible counts and viewer-state reflect later UI updates more recently than the initial SSR.
  for(const p of merged) {const d=dom.find(x=>x.code===p.code);if(d){for(const key of ['likes','replies','reposts','likedByViewer'] as const)if(d[key]!==null&&d[key]!==undefined)(p as any)[key]=d[key];}}
  const pageText=document.body.innerText.slice(0,24000);
  const warnings=[...parsed.warnings];
  if(!documentMatches)warnings.push('SSR_SCOPE_UNCERTAIN: The current route does not match the fetched document, a route change was observed, or document navigation provenance is unavailable. Only visible DOM posts are returned; old JSON supplies matching canonical IDs only. Profiles and reply classification from that JSON are omitted.');
  else if(attachedAfterDocumentStarted)warnings.push('SSR_DOCUMENT_SNAPSHOT: JSON records reflect the fetched document, not a new network fetch. Navigation away and back before runtime attachment cannot be ruled out.');
  if(/\/login|\/challenge/.test(location.pathname))warnings.push('LOGIN_REQUIRED: Complete login or account challenge manually.');
  if(size>12_000_000)warnings.push('Page JSON exceeded the capture budget; result is partial.');
  if(dom.some(p=>!parsed.posts.some(x=>x.code===p.code)))warnings.push('Some posts came from visible DOM; unavailable IDs, timestamps or relationships remain unknown.');
  const replies=documentMatches ? parsed.replies.map(reply=>{
    const post=merged.find(candidate=>candidate.code===reply.code);
    if(!post)return reply;
    // Classification can infer rootId even when the raw post has no relationship fields.
    // Preserve that evidence in both the reply result and the posts sent to the index.
    post.rootId=reply.rootId??post.rootId;post.parentId=reply.parentId??post.parentId;post.isReply=reply.isReply??true;
    return post;
  }) : [];
  const dialog=visibleDialog();
  const isProfileSearch=location.pathname==='/search'&&new URL(location.href).searchParams.get('filter')==='profiles';
  const profiles=new Map((documentMatches&&!isProfileSearch?parsed.profiles:[]).map(profile=>[profile.username.toLowerCase(),profile]));
  for(const profile of searchProfiles())if(!profiles.has(profile.username.toLowerCase()))profiles.set(profile.username.toLowerCase(),profile);
  return {runtimeVersion,runtimeRevision,remoteMediaVersion:1,remoteNavigationToken:remoteViewToken(),url:location.href,title:document.title,posts:merged,profiles:[...profiles.values()],replies,dialogUsers:dialogUsers(dialog),dialogState:readDialogState(dialog),composerState:readComposerState(),postActivity:postActivity(dialog),notificationRows:notificationRows(),visibilityState:document.visibilityState,viewer:viewer(),text:pageText,warnings,observedAt,runtimeDiagnostics:runtimeDiagnostics(dialog)};
}
