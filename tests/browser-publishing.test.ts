import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserPublishingError, publishBrowserDraft, type BrowserPublishContext } from '../src/browser-publishing.js';
import { ThreadsError } from '../src/types.js';
import type { Draft } from '../src/workflows.js';
import type { SocialRequest } from '../src/social-runtime.js';
import { ThreadsService } from '../src/service.js';
import { getConfig } from '../src/config.js';
import type { BrowserDriver } from '../src/driver.js';
import type { SearchIndex } from '../src/search.js';

const draft: Draft = { id: 'd', accountId: 'fixture_user', text: 'Offline authorized fixture', createdAt: '', updatedAt: '' };
const context: BrowserPublishContext = { accountId: 'fixture_user', jobId: 'j', partIndex: 0, idempotencyKey: 'fixture-key' };
function fixture(options: { account?: string; switchedAccount?: string; editable?: boolean; dialog?: boolean; uncertain?: boolean;
  postUrl?: string; preparedText?: string; executeError?: Error; writesEnabled?: boolean; searchbox?: boolean;
  composerState?: { present: boolean; nonempty: boolean; attachments: boolean; ambiguous: boolean } } = {}) {
  const calls: string[] = [];
  let url = 'https://www.threads.com/@fixture_user';
  let locked = false;
  let prepared: SocialRequest | undefined;
  const page = (account = options.account ?? 'fixture_user') => ({ url, viewer: { username: account }, dialogState: { present: !!options.dialog, busy: false, selectedTab: null }, ...(options.composerState ? { composerState: options.composerState } : {}) });
  const service = {
    config: { writesEnabled: options.writesEnabled ?? true },
    browserRead: async () => { assert.equal(locked, false, 'Public read must not reenter the service mutex'); calls.push('browserRead'); return page(); },
    serial: async <T>(fn: () => Promise<T>) => { assert.equal(locked, false); locked = true; calls.push('lock'); try { return await fn(); } finally { locked = false; } },
    waitForWriteSlot: async () => { assert.equal(locked,true); calls.push('waitForWriteSlot'); },
    driver: { command: async (command: { type: string; url?: string }) => {
      assert.equal(locked, true); calls.push(command.type);
      if (command.type === 'navigate') { url = command.url!; return {}; }
      if (command.type === 'snapshot') return { ...page(), elements: options.searchbox ? [{ editable: true, role: 'searchbox', name: 'Search' }] : options.editable ? [{ editable: true, role: 'textbox', name: 'Reply' }] : [] };
      return page(options.switchedAccount ?? options.account ?? 'fixture_user');
    } },
  } as unknown as Parameters<typeof publishBrowserDraft>[0];
  const social = {
    prepare: async (request: SocialRequest) => { assert.equal(locked, true); calls.push('prepare'); prepared = structuredClone(request); return { id: 'prepared-1', account: 'fixture_user', request: { ...request, ...(options.preparedText ? { text: options.preparedText } : {}) } }; },
    execute: async (_id: string, expected: string) => {
      assert.equal(locked, true); assert.equal(expected, 'fixture_user'); calls.push('execute');
      if (options.executeError) throw options.executeError;
      return { verified: !options.uncertain, outcome: options.uncertain ? 'outcome-uncertain' : 'verified', dispatch: { dispatched: true, noop: false }, after: {
        verified: !options.uncertain, account: 'fixture_user', targetUrl: prepared!.targetUrl, url: prepared!.targetUrl,
        postUrl: options.postUrl ?? 'https://www.threads.com/@fixture_user/post/NEW123', evidence: [], state: 'published',
      } };
    },
  } as unknown as Parameters<typeof publishBrowserDraft>[1];
  return { service, social, calls, request: () => prepared };
}

test('browser publisher owns its mutex without nested public reads and commits exactly once', async () => {
  const f = fixture();
  const result = await publishBrowserDraft(f.service, f.social, draft, context);
  assert.equal(result.status, 'confirmed');
  if (result.status === 'confirmed') { assert.equal(result.postId, 'NEW123'); assert.equal(result.postUrl, 'https://www.threads.com/@fixture_user/post/NEW123'); }
  assert.equal(f.calls.filter(c => c === 'execute').length, 1);
  assert.equal(f.request()?.kind, 'publish');
  assert.equal(f.request()?.text, draft.text);
});

test('wrong account and an account switch stop before navigation or staging', async () => {
  for (const options of [{ account: 'other_user' }, { switchedAccount: 'other_user' }]) {
    const f = fixture(options);
    assert.equal((await publishBrowserDraft(f.service, f.social, draft, context)).status, 'failed');
    assert.ok(!f.calls.includes('navigate')); assert.ok(!f.calls.includes('prepare'));
  }
});

test('disabled writes, unsupported media/alt text and numeric targets fail without browser calls', async () => {
  const inputs = [
    { ...draft, media: [{ type: 'image' as const, path: 'C:/fixture/image.jpg' }] },
    { ...draft, media: [{ type: 'image' as const, url: 'https://example.com/image.jpg', altText: 'authorized alternative text' }] },
    { ...draft, replyTo: '123456' },
    { ...draft, quotePostId: '123456' },
  ];
  for (const input of inputs) { const f = fixture(); assert.equal((await publishBrowserDraft(f.service, f.social, input, context)).status, 'failed'); assert.deepEqual(f.calls, []); }
  const disabled = fixture({ writesEnabled: false });
  assert.equal((await publishBrowserDraft(disabled.service, disabled.social, draft, context)).status, 'failed'); assert.deepEqual(disabled.calls, []);
});

test('reply and quote prepare only the exact authorized canonical post URL', async () => {
  const url = 'https://threads.net/@target_user/post/ROOT123?tracking=ignored';
  for (const field of ['replyUrl', 'quoteUrl'] as const) {
    const f = fixture();
    const result = await publishBrowserDraft(f.service, f.social, { ...draft, [field]: url }, context);
    assert.equal(result.status, 'confirmed');
    assert.equal(f.request()?.kind, field === 'replyUrl' ? 'reply' : 'quote');
    assert.equal(f.request()?.targetUrl, 'https://www.threads.com/@target_user/post/ROOT123');
  }
});

test('chain continuation requires and uses the previous confirmed post URL', async () => {
  const f = fixture();
  const next = { ...context, partIndex: 1, replyTo: 'PREV123', previousPostUrl: 'https://www.threads.com/@fixture_user/post/PREV123' };
  assert.equal((await publishBrowserDraft(f.service, f.social, draft, next)).status, 'confirmed');
  assert.equal(f.request()?.targetUrl, next.previousPostUrl);
  const missing = fixture();
  assert.equal((await publishBrowserDraft(missing.service, missing.social, draft, { ...next, previousPostUrl: undefined })).status, 'failed');
  assert.deepEqual(missing.calls, []);
});

test('external or authorless targets cannot navigate the selected browser', async () => {
  for (const quoteUrl of ['https://example.com/@target/post/ROOT', 'https://www.threads.com/post/ROOT']) {
    const f = fixture(); assert.equal((await publishBrowserDraft(f.service, f.social, { ...draft, quoteUrl }, context)).status, 'failed'); assert.deepEqual(f.calls, []);
  }
});

test('existing editors and dialogs are preserved without navigation or staging', async () => {
  for (const options of [{ editable: true }, { dialog: true }]) {
    const f = fixture(options); assert.equal((await publishBrowserDraft(f.service, f.social, draft, context)).status, 'failed');
    assert.ok(!f.calls.includes('navigate')); assert.ok(!f.calls.includes('prepare'));
  }
});

test('known empty inline composers and searchboxes do not block scheduled text publication', async () => {
  for (const options of [{ searchbox: true }, { editable: true, composerState: { present: false, nonempty: false, attachments: false, ambiguous: false } }]) {
    const f = fixture(options); assert.equal((await publishBrowserDraft(f.service, f.social, draft, context)).status, 'confirmed');
  }
});

test('composer metadata preserves nonempty text, attachments and ambiguous editors', async () => {
  for (const field of ['present', 'nonempty', 'attachments', 'ambiguous'] as const) {
    const f = fixture({ composerState: { present: false, nonempty: false, attachments: false, ambiguous: false, [field]: true } });
    assert.equal((await publishBrowserDraft(f.service, f.social, draft, context)).status, 'failed');
    assert.ok(!f.calls.includes('navigate')); assert.ok(!f.calls.includes('prepare'));
  }
});

test('prepared text mismatch or Stop after staging never executes', async () => {
  const mismatch = fixture({ preparedText: 'changed content' });
  assert.equal((await publishBrowserDraft(mismatch.service, mismatch.social, draft, context)).status, 'failed'); assert.ok(!mismatch.calls.includes('execute'));
  const stopped = fixture();
  const result = await publishBrowserDraft(stopped.service, stopped.social, draft, context, { shouldStop: () => stopped.calls.includes('prepare') });
  assert.equal(result.status, 'failed'); assert.ok(!stopped.calls.includes('execute'));
});

test('uncertain dispatch, wrong publication author and transport error throw categorized one-shot uncertainty', async () => {
  for (const options of [{ uncertain: true }, { postUrl: 'https://www.threads.com/@other_user/post/NEW123' }, { executeError: new Error('Fixture transport failure') }]) {
    const f = fixture(options);
    await assert.rejects(publishBrowserDraft(f.service, f.social, draft, context), error => {
      assert.ok(error instanceof BrowserPublishingError); assert.equal(error.outcome, 'unknown'); assert.equal(error.retryable, false); assert.ok(error.evidence.length); return true;
    });
    assert.equal(f.calls.filter(c => c === 'execute').length, 1);
  }
});

test('known SocialActions cooldown rejection is a precommit failure', async () => {
  const f = fixture({ executeError: new ThreadsError('ACTION_COOLDOWN', 'Fixture cooldown') });
  assert.equal((await publishBrowserDraft(f.service, f.social, draft, context)).status, 'failed');
  assert.equal(f.calls.filter(c => c === 'execute').length, 1);
});

function sharedCooldownFixture(){
  let url='https://www.threads.com/@fixture_user',dispatches=0,preparations=0;
  let request:SocialRequest;
  const calls:string[]=[];
  const page=()=>({url,posts:[],viewer:{username:'fixture_user'},dialogState:{present:false,busy:false,selectedTab:null},
    composerState:{present:false,nonempty:false,attachments:false,ambiguous:false}});
  const driver:BrowserDriver={status:()=>({}),close:async()=>{},command:async<T>(command:Record<string,unknown>)=>{
    calls.push(String(command.type));
    if(command.type==='navigate')url=String(command.url);
    return (command.type==='snapshot'?{...page(),elements:[]}:page()) as T;
  }};
  const service=new ThreadsService(driver,{upsert:()=>{}} as unknown as SearchIndex,{...getConfig(),writesEnabled:true,minActionIntervalMs:1000});
  const social={
    prepare:async(input:SocialRequest)=>{request=structuredClone(input);preparations++;calls.push('prepare');return {id:`p${preparations}`,account:'fixture_user',request};},
    execute:async()=>{
      service.reserveWrite();dispatches++;calls.push('execute');
      return {verified:true,outcome:'verified',dispatch:{dispatched:true,noop:false},after:{verified:true,account:'fixture_user',targetUrl:request.targetUrl,url:request.targetUrl,postUrl:`https://www.threads.com/@fixture_user/post/NEW${dispatches}`}};
    }
  } as unknown as Parameters<typeof publishBrowserDraft>[1];
  return {service,social,calls,dispatches:()=>dispatches,preparations:()=>preparations};
}

test('a fast confirmed chain waits on the real shared reservation before staging its next part',async t=>{
  let now=10_000;t.mock.method(Date,'now',()=>now);const waits:number[]=[];
  const f=sharedCooldownFixture();
  const first=await publishBrowserDraft(f.service,f.social,draft,context);
  assert.equal(first.status,'confirmed');assert.equal(f.service.writeCooldownRemainingMs(),1000);
  const second=await publishBrowserDraft(f.service,f.social,draft,{...context,partIndex:1,replyTo:'NEW1',previousPostUrl:'https://www.threads.com/@fixture_user/post/NEW1'},
    {sleep:async ms=>{assert.equal(f.preparations(),1,'Next draft must not be staged during cooldown');waits.push(ms);now+=ms;}});
  assert.equal(second.status,'confirmed');assert.equal(f.dispatches(),2);assert.equal(f.preparations(),2);
  assert.deepEqual(waits,[250,250,250,250]);assert.equal(f.service.writeCooldownRemainingMs(),1000);
});

test('Stop during shared cooldown prevents new staging and never retries the previous commit',async t=>{
  let now=10_000,stopping=false;t.mock.method(Date,'now',()=>now);
  const f=sharedCooldownFixture();assert.equal((await publishBrowserDraft(f.service,f.social,draft,context)).status,'confirmed');
  const before=f.calls.length;
  const result=await publishBrowserDraft(f.service,f.social,draft,{...context,partIndex:1,replyTo:'NEW1',previousPostUrl:'https://www.threads.com/@fixture_user/post/NEW1'},
    {shouldStop:()=>stopping,sleep:async ms=>{now+=ms;stopping=true;}});
  assert.equal(result.status,'failed');assert.ok(result.evidence.some(item=>item.includes('STOP_REQUESTED')));
  assert.equal(f.dispatches(),1);assert.equal(f.preparations(),1);
  assert.equal(f.calls.slice(before).some(call=>call==='navigate'||call==='prepare'||call==='execute'),false);
});
