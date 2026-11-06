import type { BrowserDriver } from './driver.js';
import type { PageRead } from './page-runtime.js';
import { sameThreadsRoute, type ThreadsService } from './service.js';
import { assertRemoteDraftSafe, assertRemoteViewer, remoteAccount } from './remote-social-driver.js';
import { normalizeNotificationRows } from './observations.js';
import { dedupePosts } from './parser.js';
import { ThreadsError } from './types.js';

const routes = {for_you:'/',following:'/following/',saved:'/saved/',liked:'/liked/',notifications:'/activity',messages:'/messages/'};
export class RemoteReadController {
  private generation = 0;
  constructor(private readonly service: ThreadsService, private readonly driver: BrowserDriver, private readonly assertAccess: () => void,
    private readonly options: {extendedReads: boolean; messages: boolean}) {}
  invalidate(): void { this.generation++; }
  feed(args: {kind: keyof typeof routes; expectedAccount: string; purpose: string; rounds?: number}) {
    const generation = this.generation;
    return this.service.serial(async () => {
      const check = () => { this.assertAccess(); if (generation !== this.generation) throw new ThreadsError('ACCESS_CHANGED', 'Read authorization changed.'); };
      check();
      if (!Object.hasOwn(routes,args.kind) || (args.kind === 'messages' ? !this.options.messages : !this.options.extendedReads))
        throw new ThreadsError('REMOTE_READ_DISABLED', 'This view requires its explicit remote capability.');
      if (typeof args.purpose !== 'string' || !args.purpose.trim() || args.purpose.length > 500 || !Number.isInteger(args.rounds ?? 0) || (args.rounds ?? 0) < 0 || (args.rounds ?? 0) > 3)
        throw new ThreadsError('INVALID_INPUT', 'An explicit purpose and 0–3 additional windows are required.');
      const account = remoteAccount(args.expectedAccount), url = 'https://www.threads.com' + routes[args.kind];
      const read = async (exact: boolean) => {
        check(); const page = await this.driver.command<PageRead>({type:'read'}); check(); assertRemoteViewer(page,account);
        if (exact && !sameThreadsRoute(page.url,url)) throw new ThreadsError('SOURCE_CHANGED', 'The requested view changed.');
        return page;
      };
      const before = await read(false); assertRemoteDraftSafe(before);
      if(typeof before.remoteNavigationToken!=='string')throw new ThreadsError('RUNTIME_CAPABILITY_REQUIRED','Reload the matching extension/runtime for guarded view reads.');
      check(); await this.driver.command({type:'remote_view',kind:args.kind,expectedAccount:account,navigationToken:before.remoteNavigationToken}); check();
      // Wait only for the single dispatched navigation. Never resend navigation on timeout.
      const transitionDeadline=Date.now()+Math.max(1000,Math.min(8000,this.service.config.timeoutMs));
      for(;;){
        const current=await read(false);
        if(sameThreadsRoute(current.url,url))break;
        if(!sameThreadsRoute(current.url,before.url)||Date.now()>=transitionDeadline)throw new ThreadsError('SOURCE_CHANGED','The requested view changed or navigation remains unverified.');
        await new Promise(r=>setTimeout(r,150));
      }
      const pages: PageRead[] = [];
      for (let i=0;i<=(args.rounds??0);i++) {
        if(i) { await read(true); check(); await this.driver.command({type:'scroll',pixels:1500}); check(); }
        let page = await read(true);
        if(args.kind === 'notifications' && i === 0) {
          const end=Date.now()+Math.min(8000,this.service.config.timeoutMs);
          while(!page.notificationRows?.length && Date.now()<end) { await new Promise(r=>setTimeout(r,250)); page=await read(true); }
        }
        pages.push(page);
      }
      check(); const last=pages.at(-1)!, warnings=[...new Set(pages.flatMap(p=>p.warnings)),'Only loaded windows were observed; absence does not establish no messages or notifications.'];
      const base={account,kind:args.kind,items:dedupePosts(pages.flatMap(p=>p.posts)),sourceUrl:url,observedAt:last.observedAt,completeness:'partial',warnings};
      // Private view data is returned only to this authorized call and never persisted in the search corpus.
      if(args.kind==='messages') return {...base,visibleText:last.text,mayMarkSeen:true,privateDataPersisted:false};
      if(args.kind==='notifications') {
        const notificationRows=pages.flatMap(p=>p.notificationRows??[]);
        return {...base,visibleText:last.text,notificationRows,events:normalizeNotificationRows(notificationRows,{sourceUrl:url,observedAt:last.observedAt}),mayMarkSeen:true,privateDataPersisted:false};
      }
      this.service.index.upsert(base.items); return base;
    });
  }
}
