import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {normalizeNotificationRows} from '../src/observations.js';
import type {PageRead} from '../src/page-runtime.js';
// Public icon geometry captured from the visually verified activity badges; no private row content.
const knownBadgePaths:Record<string,string>={"like":"M5 8.33956C5 6.84296 6.07645 5.75 7.48174 5.75C8.08884 5.75 8.61175 5.95938 9.00094 6.30299C9.3914 5.95863 9.91188 5.75 10.5183 5.75C11.9276 5.75 13 6.84345 13 8.33956C13 9.20812 12.6297 10.037 12.0266 10.7947C11.4237 11.5521 10.5712 12.2609 9.5565 12.9023L9.55379 12.904C9.48997 12.9437 9.41108 12.9882 9.32747 13.0242C9.25284 13.0563 9.1332 13.1001 9 13.1001C8.86687 13.1001 8.74693 13.0551 8.67518 13.0242C8.59318 12.9889 8.51482 12.9453 8.45151 12.9072L8.44748 12.9048L8.4435 12.9023C7.42882 12.2609 6.57626 11.5521 5.97338 10.7947C5.37032 10.037 5 9.20812 5 8.33956Z","follow":"M5.81283 13C5.55932 13 5.35968 12.9466 5.2139 12.8398C5.0713 12.736 5 12.5921 5 12.4082C5 12.1235 5.0919 11.8224 5.2757 11.505C5.4595 11.1876 5.72569 10.891 6.07427 10.6151C6.42286 10.3363 6.84274 10.1109 7.33393 9.93882C7.82828 9.76381 8.38285 9.67631 8.99762 9.67631C9.61557 9.67631 10.1701 9.76381 10.6613 9.93882C11.1557 10.1109 11.5756 10.3363 11.921 10.6151C12.2696 10.891 12.5357 11.1876 12.7195 11.505C12.9065 11.8224 13 12.1235 13 12.4082C13 12.5921 12.9271 12.736 12.7813 12.8398C12.6387 12.9466 12.4407 13 12.1872 13H5.81283ZM9.00238 8.87987C8.6633 8.87987 8.34957 8.79384 8.0612 8.6218C7.77283 8.44679 7.53991 8.21246 7.36245 7.9188C7.18816 7.62217 7.10101 7.28995 7.10101 6.92214C7.10101 6.56025 7.18816 6.23396 7.36245 5.94327C7.53991 5.65258 7.77283 5.42269 8.0612 5.25362C8.34957 5.08454 8.6633 5 9.00238 5C9.34145 5 9.65518 5.08306 9.94355 5.24917C10.2319 5.41528 10.4633 5.64368 10.6376 5.93437C10.815 6.2221 10.9037 6.54839 10.9037 6.91324C10.9037 7.28402 10.815 7.61772 10.6376 7.91435C10.4633 8.21098 10.2319 8.44679 9.94355 8.6218C9.65518 8.79384 9.34145 8.87987 9.00238 8.87987Z","reply":"M8.62523 12.5C8.5337 12.5 8.44836 12.4796 8.3692 12.4389C8.29004 12.4008 8.20594 12.3384 8.11688 12.2519L5.18924 9.4084C5.1175 9.33969 5.06803 9.26972 5.04082 9.19847C5.01361 9.12723 5 9.06107 5 9C5 8.93639 5.01361 8.86896 5.04082 8.79771C5.06803 8.72646 5.1175 8.65649 5.18924 8.58779L8.11688 5.77099C8.21583 5.6743 8.30117 5.6056 8.37291 5.56489C8.44465 5.52163 8.52628 5.5 8.61781 5.5C8.74892 5.5 8.85529 5.5458 8.93692 5.6374C9.01855 5.72901 9.05937 5.83842 9.05937 5.96565V7.4084H9.16698C9.83488 7.4084 10.41 7.51399 10.8924 7.72519C11.3772 7.93639 11.7743 8.24173 12.0835 8.64122C12.3952 9.04071 12.6252 9.5229 12.7737 10.0878C12.9246 10.6501 13 11.2837 13 11.9885C13 12.1539 12.9604 12.2799 12.8813 12.3664C12.8046 12.4555 12.7168 12.5 12.6178 12.5C12.5387 12.5 12.4583 12.4835 12.3766 12.4504C12.2975 12.4173 12.2257 12.3397 12.1614 12.2176C11.9462 11.8003 11.6976 11.4746 11.4156 11.2405C11.1336 11.0038 10.8083 10.8372 10.4397 10.7405C10.0711 10.6438 9.64688 10.5954 9.16698 10.5954H9.05937V12.0534C9.05937 12.1832 9.01855 12.2901 8.93692 12.374C8.85529 12.458 8.75139 12.5 8.62523 12.5Z"};
const badge=(kind:string,viewBox='0 0 18 18')=>`<svg width="18" height="18" viewBox="${viewBox}" role="img" aria-label=""><title></title><path d="${knownBadgePaths[kind]??'M0 0L1 1'}"></path></svg>`;


test('observations runtime: notification isolation and profile result provenance', {skip:process.env.THREADS_BROWSER_TESTS!=='true'}, async t=>{
  const bundled=await build({entryPoints:['src/page-runtime.ts'],bundle:true,platform:'browser',format:'iife',globalName:'ThreadsMCP',write:false,target:'chrome120'});
  const browser=await chromium.launch({channel:process.env.THREADS_BROWSER_CHANNEL||'chrome',headless:true});
  try{
    const context=await browser.newContext();let body='';
    // Intercept all requests. These fixtures never access a signed-in profile or Threads.
    await context.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`}));
    const page=await context.newPage();
    const read=async(html:string,path='/activity'):Promise<PageRead>=>{
      body=html;await page.goto(`https://www.threads.com${path}`);await page.addScriptTag({content:bundled.outputFiles[0]!.text});
      return page.evaluate(()=>(window as any).ThreadsMCP.readPage());
    };
    await t.test('single timed event does not absorb navigation or sidebar actors',async()=>{
      const result=await read(`<div><nav><a href="/@viewer" aria-label="Profile">Profile</a></nav>
        <main><div><a href="/@actor">actor</a> liked your post <time datetime="2026-10-24T00:00:00Z">2h</time><a href="/@viewer/post/ABC">Post</a></div></main>
        <aside><a href="/@unrelated">Unrelated suggestion</a></aside></div>`);
      assert.equal(result.notificationRows?.length,1);
      assert.deepEqual(result.notificationRows?.[0]?.actorLinks.map(actor=>actor.username),['actor']);
      assert.equal(result.notificationRows?.[0]?.text.includes('suggestion'),false);
      const events=normalizeNotificationRows(result.notificationRows??[],{sourceUrl:result.url,observedAt:result.observedAt});
      assert.equal(events[0]?.kind,'like');assert.equal(events[0]?.createdAt,'2026-10-24T00:00:00.000Z');
    });
    await t.test('adjacent notification rows stay separate; explicit follow rows need no post link',async()=>{
      const result=await read(`<main><div><a href="/@alice">alice</a> mentioned you <time>2h</time></div>
        <div><a href="/@bob">bob</a> 開始追蹤你 <time>3h</time></div></main>`);
      assert.deepEqual(result.notificationRows?.map(row=>row.actorLinks.map(actor=>actor.username)),[['alice'],['bob']]);
      const events=normalizeNotificationRows(result.notificationRows??[],{sourceUrl:result.url,observedAt:result.observedAt});
      assert.deepEqual(events.map(event=>event.kind),['mention','follow']);assert.ok(events.every(event=>event.createdAt===null));
    });
    await t.test('unlabeled row with a post link remains unknown, without deriving action from its author',async()=>{
      const result=await read(`<main><div><a href="/@alice">alice</a><time>2h</time><a href="/@viewer/post/ABC">A post preview without an action label</a></div></main>`);
      const events=normalizeNotificationRows(result.notificationRows??[],{sourceUrl:result.url,observedAt:result.observedAt});
      assert.equal(events.length,1);assert.equal(events[0]?.kind,'unknown');assert.deepEqual(events[0]?.actors.map(actor=>actor.username),['alice']);
      assert.deepEqual(events[0]?.postUrls,['https://www.threads.com/@viewer/post/ABC']);
    });
    await t.test('unknown activity does not borrow an unrelated post target from complementary content',async()=>{
      const result=await read(`<main><div><a href="/@actor">actor</a><time>2h</time>unknown event</div>
        <aside><a href="/@suggested">suggested</a><a href="/@suggested/post/WRONG">Unrelated suggested post</a></aside></main>`);
      assert.deepEqual(result.notificationRows,[]);
      const roleVariant=await read(`<div role="main"><div><a href="/@actor">actor</a><time>2h</time>unknown event</div>
        <div role="complementary"><a href="/@suggested">suggested</a><a href="/@suggested/post/WRONG">Unrelated suggested post</a></div></div>`);
      assert.deepEqual(roleVariant.notificationRows,[]);
    });
    await t.test('hidden actors and expanded post cards are excluded from event evidence',async()=>{
      const result=await read(`<main><div><a href="/@alice">alice</a> liked your post <time>2h</time>
        <span aria-hidden="true"><a href="/@hidden_actor">Hidden accessibility duplicate</a></span><a style="display:none" href="/@display_hidden">Hidden</a></div>
        <div><a href="/@post_author">post_author</a><time>3h</time><a href="/@post_author/post/POST">Post text</a><button aria-label="Like">1</button><button aria-label="Reply">Reply</button></div></main>`);
      assert.equal(result.notificationRows?.length,1);assert.deepEqual(result.notificationRows?.[0]?.actorLinks.map(actor=>actor.username),['alice']);
    });
    await t.test('profile search uses visible result scope, excluding SSR, sidebar and non-Threads links',async()=>{
      const result=await read(`<nav><a href="/@viewer" aria-label="Profile">Profile</a></nav><main>
        <a href="/@result">Result</a><a href="/@result">Repeated avatar</a><a href="https://threads.net/@second">Second</a>
        <a href="https://evil.example/@external">External</a><a href="https://www.threads.com:8443/@other_port">Other port</a><a href="https://name:password@www.threads.com/@credential_link">Credential-bearing link</a>
        <span aria-hidden="true"><a href="/@hidden">Hidden duplicate</a></span><a style="display:none" href="/@not_rendered">Not rendered</a>
        <aside><a href="/@inside_sidebar">Inside sidebar</a></aside></main><aside><a href="/@outside_sidebar">Outside sidebar</a></aside>
        <script type="application/json">{"viewer":{"username":"ssr_viewer","pk":"1"},"recommendation":{"username":"ssr_recommended","pk":"2"}}</script>`,
        '/search?q=result&filter=profiles');
      assert.deepEqual(result.profiles.map(profile=>profile.username).sort(),['result','second']);
      assert.ok(result.profiles.every(profile=>profile.followers===null&&profile.following===null));
      assert.deepEqual(result.notificationRows,[]);
    });
    await t.test('verified notification badges classify grouped likes, follows and replies without preview actor/action contamination',async()=>{
      const row=(kind:string,tail:string,aggregate='')=>`<div data-pressable-container="true"><div><a href="/@actor"><img width="20" height="20" alt=""></a>${badge(kind)}</div><div><div><header><a href="/@actor">actor</a>${aggregate}<time>2h</time></header>${tail}</div></div></div>`;
      const result=await read(`<main>${row('like','<a href="/@viewer/post/LIKED">A quoted preview says mentioned you</a>',' 和另外 201 人')}
        ${row('follow','<div role="button">已追蹤你</div>',' 和另外 5 人')}
        ${row('reply','<p>Reply body mentions <a href="/@mentioned">mentioned</a></p><a href="/@viewer/post/REPLY">Original post</a><button><svg width="18" height="18" viewBox="0 0 24 24" title="收回讚"><title>收回讚</title></svg>1</button>')}</main>`);
      const events=normalizeNotificationRows(result.notificationRows??[],{sourceUrl:result.url,observedAt:result.observedAt});
      assert.equal(events.length,3);assert.deepEqual(events.map(event=>event.kind),['like','follow','reply']);
      assert.deepEqual(events.map(event=>event.actors.map(actor=>actor.username)),[['actor'],['actor'],['actor']]);
      assert.deepEqual(events.map(event=>event.additionalActorCount),[201,5,null]);assert.ok(events.every(event=>event.kindEvidence==='observed-badge'));
    });
    await t.test('unknown badge geometry stays unknown and 24x24 reaction icons are not notification badges',async()=>{
      const result=await read(`<main><div>${badge('changed')}<header><a href="/@alice">alice</a><time>2h</time></header><a href="/@viewer/post/ABC">liked your post is preview text</a></div>
        <div>${badge('like','0 0 24 24')}<header><a href="/@bob">bob</a><time>3h</time></header><a href="/@viewer/post/OTHER">Plain preview</a></div></main>`);
      const events=normalizeNotificationRows(result.notificationRows??[],{sourceUrl:result.url,observedAt:result.observedAt});
      assert.equal(events.length,2);assert.deepEqual(events.map(event=>event.kind),['unknown','unknown']);assert.ok(events.every(event=>event.badgeSignature===null));
    });
    await t.test('post activity distinguishes overview from selected lists and preserves actual self-likes',async()=>{
      const overview='<section id="overview"><h1>貼文動態</h1><a href="/@owner">owner</a><time>Original post date</time><button>按讚內容193</button><button>轉發3</button><a href="/insights/post/ROOT">洞察報告72,410次瀏覽</a></section>';
      const initial=await read(`<div role="dialog">${overview}<div data-pressable-container="true"><a href="/@overview_actor">overview_actor</a><time>7週</time></div></div>`,'/@owner/post/ROOT');
      assert.equal(initial.postActivity?.selectedTab,null);assert.deepEqual(initial.postActivity?.users,[]);assert.deepEqual(initial.postActivity?.counts,{likes:193,reposts:3,views:72410});
      const selected=await read(`<div role="dialog"><div aria-hidden="true">${overview}<div data-pressable-container="true"><a href="/@hidden_actor">hidden_actor</a><time>7週</time></div></div>
        <section><h1><span title="193">193</span>個讚</h1><div><a href="/@owner">owner</a><time>Original post date</time><p>Embedded post</p></div>
        <div data-pressable-container="true"><a href="/@alice">alice</a><time>7週</time><button onclick="window.followClicked=true">追蹤</button></div>
        <div data-pressable-container="true"><a href="/@owner">owner</a><time>7週</time><span>Owner display name</span></div></section></div>`,'/@owner/post/ROOT');
      assert.equal(selected.postActivity?.selectedTab,'likes');assert.equal(selected.postActivity?.targetUrl,'https://www.threads.com/@owner/post/ROOT');
      assert.equal(selected.postActivity?.displayedCount,193);assert.deepEqual(selected.postActivity?.users.map(user=>user.username),['alice','owner']);
      assert.equal(await page.evaluate(()=>(window as any).followClicked),undefined);
      await page.evaluate(()=>{document.querySelector('a[href="/insights/post/ROOT"]')!.setAttribute('href','/insights/post/WRONG');});
      const wrong=await page.evaluate(()=>(window as any).ThreadsMCP.readPage());assert.equal(wrong.postActivity.targetUrl,null);assert.deepEqual(wrong.postActivity.users,[]);
    });
    await t.test('read-only activity helper opens exact-root menu and selected liker list without touching Follow',async()=>{
      await read('<main><article><a href="/@owner/post/ROOT">Root</a><p>Root text</p><button aria-label="Like">193</button><button id="root-more" aria-label="More" aria-haspopup="menu">More</button></article></main>','/@owner/post/ROOT');
      await page.evaluate(()=>{
        document.getElementById('root-more')!.onclick=()=>{
          const menu=document.createElement('div');menu.setAttribute('role','menu');menu.innerHTML='<button>查看動態</button>';document.body.append(menu);
          menu.querySelector('button')!.onclick=()=>{
            menu.remove();const dialog=document.createElement('div');dialog.setAttribute('role','dialog');
            dialog.innerHTML='<section id="overview"><h1>貼文動態</h1><button id="choose-likes">按讚內容2</button><button>轉發1</button><a href="/insights/post/ROOT">洞察報告20次瀏覽</a></section>';document.body.append(dialog);
            document.getElementById('choose-likes')!.onclick=()=>{
              document.getElementById('overview')!.setAttribute('aria-hidden','true');
              dialog.insertAdjacentHTML('beforeend','<section><h1>2個讚</h1><div data-pressable-container="true"><a href="/@alice">alice</a><time>1週</time><button id="follow">追蹤</button></div></section>');
              document.getElementById('follow')!.onclick=()=>{(window as any).followClicked=true;};
            };
          };
        };
      });
      const opened=await page.evaluate(()=>(window as any).ThreadsMCP.openReadPanel('likers','likes'));assert.equal(opened.activityTab,'likes');
      const result=await page.evaluate(()=>(window as any).ThreadsMCP.readPage());assert.equal(result.postActivity.selectedTab,'likes');assert.deepEqual(result.postActivity.users.map((user:any)=>user.username),['alice']);
      assert.equal(await page.evaluate(()=>(window as any).followClicked),undefined);
      await page.evaluate(()=>history.pushState({},'','/@owner/post/OTHER'));
      const moved=await page.evaluate(()=>(window as any).ThreadsMCP.readPage());assert.equal(moved.postActivity.targetUrl,null);assert.deepEqual(moved.postActivity.users,[]);
    });
    await t.test('activity control beside the isolated root opens without using More and rejects reply-region controls',async()=>{
      const card='<article><a href="/@owner/post/ROOT">Root</a><button aria-label="Like">2</button><button id="more" aria-label="More" aria-haspopup="menu">More</button></article>';
      const activity='<div><button id="activity">查看動態<svg aria-label="查看動態"><title>查看動態</title></svg></button></div>';
      await read(`<main><section>${card}${activity}</section><article><a href="/@other/post/REPLY">Reply</a><button aria-label="Like">1</button></article></main>`,'/@owner/post/ROOT');
      await page.evaluate(()=>{
        document.getElementById('more')!.onclick=()=>{(window as any).moreClicked=true;};
        document.getElementById('activity')!.onclick=()=>document.body.insertAdjacentHTML('beforeend','<div role="dialog"><h1>貼文動態</h1><a href="/insights/post/ROOT">洞察報告20次瀏覽</a></div>');
      });
      await page.evaluate(()=>(window as any).ThreadsMCP.openReadPanel('likers'));
      assert.equal(await page.evaluate(()=>(window as any).moreClicked),undefined);
      assert.equal((await page.evaluate(()=>(window as any).ThreadsMCP.readPage())).postActivity.targetCode,'ROOT');
      await read(`<main><section>${card.replace(' aria-haspopup="menu"','')}<article><a href="/@other/post/REPLY">Reply</a><button aria-label="Like">1</button>${activity}</article></section></main>`,'/@owner/post/ROOT');
      await page.evaluate(()=>{document.getElementById('activity')!.onclick=()=>{(window as any).wrongClicked=true;};});
      await assert.rejects(page.evaluate(()=>(window as any).ThreadsMCP.openReadPanel('likers')),/unique exact-post More/);
      assert.equal(await page.evaluate(()=>(window as any).wrongClicked),undefined);
    });
    await t.test('composer metadata distinguishes search, empty inline, draft values and scoped attachments without returning drafts',async()=>{
      const empty={present:false,nonempty:false,attachments:false,ambiguous:false};
      let result=await read('<input role="searchbox" value="query"><div data-lexical-editor="true" contenteditable="true" aria-placeholder="回覆owner"><p><br></p></div>','/@owner/post/ROOT');
      assert.deepEqual(result.composerState,empty);
      result=await read('<textarea aria-label="Reply">Private draft text</textarea>','/@owner/post/ROOT');
      assert.deepEqual(result.composerState,{...empty,present:true,nonempty:true});assert.equal(JSON.stringify(result.composerState).includes('Private'),false);
      result=await read('<input type="text" aria-label="New post" value="Typed draft">');
      assert.equal(result.composerState?.nonempty,true);
      result=await read('<textarea aria-label="Unidentified editor"></textarea>');assert.equal(result.composerState?.ambiguous,true);
      result=await read('<div role="dialog"><div data-barcelona-composer-body="true"><textarea aria-label="Reply"></textarea><button aria-label="Remove image">Remove</button></div></div>');
      assert.deepEqual(result.composerState,{...empty,present:true,attachments:true});
      result=await read('<div role="dialog"><img src="https://fixture.invalid/source.jpg" alt="Quoted source"><div data-barcelona-composer-body="true"><textarea aria-label="Reply"></textarea></div></div>');
      assert.deepEqual(result.composerState,{...empty,present:true});
      await read('<section><div><div contenteditable="true" data-lexical-editor="true"></div></div><input type="file" hidden></section>');
      await page.evaluate(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['fixture'],'image.png',{type:'image/png'}));document.querySelector<HTMLInputElement>('input[type="file"]')!.files=transfer.files;});
      assert.equal((await page.evaluate(()=>(window as any).ThreadsMCP.readPage())).composerState.attachments,true);
    });
    await t.test('activity waits through a loading overview longer than the old 2.4 second budget',async()=>{
      await read('<main><article><a href="/@owner/post/ROOT">Root</a><button aria-label="Like">2</button><button id="activity">查看動態</button></article></main>','/@owner/post/ROOT');
      await page.evaluate(()=>{
        document.getElementById('activity')!.onclick=()=>{
          const dialog=document.createElement('div');dialog.setAttribute('role','dialog');dialog.innerHTML='<div role="progressbar">Loading</div>';document.body.append(dialog);
          setTimeout(()=>{
            dialog.innerHTML='<h1>貼文動態</h1><button id="likes">按讚內容2</button><a href="/insights/post/ROOT">洞察報告</a>';
            document.getElementById('likes')!.onclick=()=>{dialog.innerHTML='<h1>2個讚</h1><a hidden href="/insights/post/ROOT">Identity</a><div data-pressable-container="true"><a href="/@alice">alice</a><time>1h</time></div>';};
          },2700);
        };
      });
      await page.evaluate(()=>(window as any).ThreadsMCP.openReadPanel('likers','likes'));
      const result=await page.evaluate(()=>(window as any).ThreadsMCP.readPage());assert.equal(result.postActivity.selectedTab,'likes');assert.equal(result.postActivity.targetCode,'ROOT');
    });
    await t.test('observed loading labels keep selected activity rows busy until hydration finishes',async()=>{
      const result=await read('<div role="dialog"><h1>2個讚</h1><a hidden href="/insights/post/ROOT">Identity</a><svg aria-label="載入中……" width="20" height="20"></svg><div data-pressable-container="true"><a href="/@alice">alice</a><time>1h</time></div></div>','/@owner/post/ROOT');
      assert.equal(result.postActivity?.selectedTab,'likes');assert.equal(result.postActivity?.busy,true);assert.deepEqual(result.postActivity?.users,[]);
      await page.evaluate(()=>document.querySelector('svg')!.remove());const settled=await page.evaluate(()=>(window as any).ThreadsMCP.readPage());assert.equal(settled.postActivity.busy,false);assert.equal(settled.postActivity.users.length,1);
    });
    await t.test('activity waits for exact-root readiness before one click and ignores downstream loading placeholders',async()=>{
      await read('<main><section id="root"><article><a href="/@owner/post/ROOT">Root</a><button aria-label="Like">2</button></article><button id="activity">查看動態</button><div id="root-loading" role="status" aria-label="載入中……">Loading</div></section><section role="status" aria-label="載入中……">Unrelated downstream placeholder</section></main>','/@owner/post/ROOT');
      await page.evaluate(()=>{
        (window as any).clicks=0;
        document.getElementById('activity')!.onclick=()=>{(window as any).clicks++;};
        setTimeout(()=>{
          // Hydration replaces the initial card and attaches the real handler.
          const old=document.getElementById('root')!;const ready=old.cloneNode(true) as HTMLElement;ready.querySelector('#root-loading')!.remove();old.replaceWith(ready);
          ready.querySelector<HTMLElement>('#activity')!.onclick=()=>{(window as any).clicks++;document.body.insertAdjacentHTML('beforeend','<div role="dialog"><h1>貼文動態</h1><a href="/insights/post/ROOT">洞察報告</a></div>');};
        },400);
      });
      await page.evaluate(()=>(window as any).ThreadsMCP.openReadPanel('likers'));
      assert.equal(await page.evaluate(()=>(window as any).clicks),1);
      assert.equal((await page.evaluate(()=>(window as any).ThreadsMCP.readPage())).postActivity.targetCode,'ROOT');
    });
    await t.test('no-link activity identity follows its owned modal through nested views but never a replacement modal on the same route',async()=>{
      await read('<main><article><a href="/@owner/post/ROOT">Root</a><button aria-label="Like">2</button><button id="activity">查看動態</button></article></main>','/@owner/post/ROOT');
      await page.evaluate(()=>{
        document.getElementById('activity')!.onclick=()=>{
          const modal=document.createElement('div');modal.id='owned-modal';modal.setAttribute('role','dialog');modal.innerHTML='<section id="overview"><h1>貼文動態</h1><button id="likes">按讚內容2</button></section>';document.body.append(modal);
          document.getElementById('likes')!.onclick=()=>{document.getElementById('overview')!.setAttribute('aria-hidden','true');modal.insertAdjacentHTML('beforeend','<div role="dialog"><h1>2個讚</h1><div data-pressable-container="true"><a href="/@alice">alice</a><time>1h</time></div></div>');};
        };
      });
      await page.evaluate(()=>(window as any).ThreadsMCP.openReadPanel('likers','likes'));
      let result=await page.evaluate(()=>(window as any).ThreadsMCP.readPage());assert.equal(result.postActivity.targetCode,'ROOT');assert.equal(result.postActivity.users[0].username,'alice');
      // The observed loading transition can collapse two nested dialogs to one
      // while retaining the verified outer modal shell.
      result=await page.evaluate(()=>{const modal=document.getElementById('owned-modal')!;modal.innerHTML=modal.querySelector('[role="dialog"]')!.innerHTML;return (window as any).ThreadsMCP.readPage();});
      assert.equal(result.postActivity.targetCode,'ROOT');assert.equal(result.postActivity.users.length,1);
      result=await page.evaluate(()=>{document.getElementById('owned-modal')!.remove();document.body.insertAdjacentHTML('beforeend','<div role="dialog"><h1>1個讚</h1><div data-pressable-container="true"><a href="/@reply_liker">reply_liker</a><time>1h</time></div></div>');return (window as any).ThreadsMCP.readPage();});
      assert.equal(result.postActivity.targetCode,null);assert.deepEqual(result.postActivity.users,[]);
      await assert.rejects(page.evaluate(()=>(window as any).ThreadsMCP.openReadPanel('likers','likes')),/TARGET_UNVERIFIED/);
    });
    await t.test('closing and reusing the same modal shell invalidates its no-link activity identity',async()=>{
      await read('<div id="modal" role="dialog"><h1>貼文動態</h1><a href="/insights/post/ROOT">Identity</a></div>','/@owner/post/ROOT');
      await page.evaluate(()=>(window as any).ThreadsMCP.openReadPanel('likers'));
      const result=await page.evaluate(()=>{
        const modal=document.getElementById('modal')!;modal.style.display='none';modal.innerHTML='<h1>1個讚</h1><div data-pressable-container="true"><a href="/@other">other</a><time>1h</time></div>';modal.style.display='';
        return (window as any).ThreadsMCP.readPage();
      });
      assert.equal(result.postActivity.targetCode,null);assert.deepEqual(result.postActivity.users,[]);
    });
    await t.test('activity requires local quiet and stable opener identity even without a loading marker',async()=>{
      await read('<main><article id="root"><a href="/@owner/post/ROOT">Root</a><button aria-label="Like">2</button><button id="activity">查看動態</button><span id="local">Initial</span></article><span id="outside">Outside</span></main>','/@owner/post/ROOT');
      await page.evaluate(()=>{
        (window as any).clicks=0;(window as any).started=performance.now();
        document.getElementById('activity')!.onclick=()=>{(window as any).clicks++;};
        const timer=setInterval(()=>{document.getElementById('outside')!.textContent=String(performance.now());},80);
        setTimeout(()=>{document.getElementById('local')!.textContent='Changed';},200);
        setTimeout(()=>{
          const old=document.getElementById('root')!;const ready=old.cloneNode(true) as HTMLElement;old.replaceWith(ready);
          ready.querySelector<HTMLElement>('#activity')!.onclick=()=>{clearInterval(timer);(window as any).clicks++;(window as any).clickedAfter=performance.now()-(window as any).started;document.body.insertAdjacentHTML('beforeend','<div role="dialog"><h1>貼文動態</h1><a href="/insights/post/ROOT">Identity</a></div>');};
        },900);
      });
      await page.evaluate(()=>(window as any).ThreadsMCP.openReadPanel('likers'));
      assert.equal(await page.evaluate(()=>(window as any).clicks),1);assert.ok(await page.evaluate(()=>(window as any).clickedAfter)>=3350);
      const result=await page.evaluate(()=>(window as any).ThreadsMCP.readPage());assert.equal(result.runtimeRevision,'20261024-readiness-3');assert.equal(result.runtimeDiagnostics.activity.dispatches,1);assert.equal(result.runtimeDiagnostics.activity.stage,'complete');
    });
    await t.test('busy diagnostics expose marker structure without actor identities or relaxing current busy semantics',async()=>{
      const result=await read('<div role="dialog"><button role="tab" aria-selected="true">Followers</button><section><div><a href="/@alice">alice</a></div><div role="status" aria-label="載入中……"><svg role="img" aria-label="載入中……" width="20" height="20"></svg></div></section></div>','/@owner');
      assert.equal(result.dialogState.busy,true);assert.equal(result.runtimeDiagnostics?.dialog?.total,2);assert.equal(result.runtimeDiagnostics?.dialog?.profileLinks,1);
      assert.ok(result.runtimeDiagnostics?.dialog?.indicators.every(indicator=>indicator.profileLinksBefore===1&&indicator.profileLinksAfter===0));
      assert.equal(JSON.stringify(result.runtimeDiagnostics).includes('alice'),false);
    });
    const connections=`<div id="connections" role="dialog"><div role="tablist"><button id="followers" role="tab" aria-selected="true">粉絲 539</button><button id="following" role="tab" aria-selected="false">追蹤中 20</button></div>
      <section id="users"><div><a href="/@alice">alice</a></div><div><a href="/@bob">bob</a></div></section>
      <div><div role="status" aria-label="載入中……"><svg role="img" aria-label="載入中……" width="20" height="20"></svg></div></div>
      <div style="position:fixed;top:20px"><div role="status" aria-label="載入中……"><svg role="img" aria-label="載入中……" width="20" height="20"></svg></div></div></div>`;
    const selectConnection=(id:string)=>page.evaluate(id=>{document.querySelector('[role="tab"][aria-selected="true"]')!.setAttribute('aria-selected','false');document.getElementById(id)!.setAttribute('aria-selected','true');},id);
    const waitConnection=()=>page.waitForFunction(()=>(window as any).ThreadsMCP.readPage().dialogState.busy===false,{},{timeout:2500});
    await t.test('observed generic normal and sticky pagination pairs do not block a settled connection list; explicit loading still does',async()=>{
      let result=await read(connections,'/@owner');assert.equal(result.dialogState.busy,false);assert.equal(result.dialogUsers.length,2);
      assert.ok(result.runtimeDiagnostics?.dialog?.indicators.every(indicator=>indicator.paginationCandidate));
      await page.evaluate(()=>document.getElementById('connections')!.setAttribute('aria-busy','true'));
      assert.equal((await page.evaluate(()=>(window as any).ThreadsMCP.readPage())).dialogState.busy,true);
      await page.evaluate(()=>{document.getElementById('connections')!.removeAttribute('aria-busy');document.getElementById('users')!.insertAdjacentHTML('afterend','<span role="progressbar">Loading</span>');});
      assert.equal((await page.evaluate(()=>(window as any).ThreadsMCP.readPage())).dialogState.busy,true);
      result=await read(connections.replace('粉絲 539','Top'),'/@owner');assert.equal(result.dialogState.busy,true);
      result=await read(connections.replace('<div><a href="/@alice">alice</a></div><div><a href="/@bob">bob</a></div>',''),'/@owner');assert.equal(result.dialogState.busy,true);
    });
    await t.test('tab changes cannot release stale rows through footer loaders, time, append-only pagination or partial row removal',async()=>{
      await read(connections,'/@owner');await selectConnection('following');
      assert.equal((await page.evaluate(()=>(window as any).ThreadsMCP.readPage())).dialogState.busy,true);
      await new Promise(resolve=>setTimeout(resolve,550));assert.equal((await page.evaluate(()=>(window as any).ThreadsMCP.readPage())).dialogState.busy,true);
      await page.evaluate(()=>document.getElementById('users')!.insertAdjacentHTML('beforeend','<div><a href="/@carol">carol</a></div>'));
      await new Promise(resolve=>setTimeout(resolve,550));assert.equal((await page.evaluate(()=>(window as any).ThreadsMCP.readPage())).dialogState.busy,true);
      await page.evaluate(()=>document.querySelector('#users a[href="/@alice"]')!.parentElement!.remove());
      await new Promise(resolve=>setTimeout(resolve,550));let state=await page.evaluate(()=>(window as any).ThreadsMCP.readPage());assert.equal(state.dialogState.busy,true);assert.equal(state.runtimeDiagnostics.dialog.transition.stillConnectedOldRowCount,1);
      // Equal handles are valid after actual node replacement; a set-difference
      // requirement would incorrectly reject this completed list refresh.
      await page.evaluate(()=>{document.getElementById('users')!.innerHTML='<div><a href="/@alice">alice</a></div><div><a href="/@bob">bob</a></div>';});
      await waitConnection();state=await page.evaluate(()=>(window as any).ThreadsMCP.readPage());assert.equal(state.dialogState.selectedTab,'追蹤中 20');assert.equal(state.dialogUsers.length,2);
    });
    await t.test('removing and reinserting the original rows cannot credit a completed tab refresh',async()=>{
      await read(connections,'/@owner');await selectConnection('following');
      await page.evaluate(()=>{const users=document.getElementById('users')!;(window as any).originalConnectionRows=[...users.children];users.replaceChildren();});
      assert.equal((await page.evaluate(()=>(window as any).ThreadsMCP.readPage())).dialogState.busy,true);
      await page.evaluate(()=>document.getElementById('users')!.replaceChildren(...(window as any).originalConnectionRows));
      await new Promise(resolve=>setTimeout(resolve,550));const stale=await page.evaluate(()=>(window as any).ThreadsMCP.readPage());
      assert.equal(stale.dialogState.busy,true);assert.equal(stale.runtimeDiagnostics.dialog.transition.stillConnectedOldRowCount,2);
      await page.evaluate(()=>{document.getElementById('users')!.innerHTML='<div><a href="/@fresh">fresh</a></div>';});
      await waitConnection();assert.equal((await page.evaluate(()=>(window as any).ThreadsMCP.readPage())).dialogUsers[0].username,'fresh');
    });
    await t.test('an explicit loading cycle permits settled reused rows while generic loader cycles do not',async()=>{
      await read(connections,'/@owner');await selectConnection('following');
      await page.evaluate(()=>document.getElementById('users')!.insertAdjacentHTML('beforeend','<span id="new-loader" aria-label="Loading">Loading</span>'));
      assert.equal((await page.evaluate(()=>(window as any).ThreadsMCP.readPage())).dialogState.busy,true);
      await page.evaluate(()=>document.getElementById('new-loader')!.remove());
      await new Promise(resolve=>setTimeout(resolve,550));assert.equal((await page.evaluate(()=>(window as any).ThreadsMCP.readPage())).dialogState.busy,true);
      await page.evaluate(()=>document.getElementById('connections')!.setAttribute('aria-busy','true'));
      const loading=await page.evaluate(()=>(window as any).ThreadsMCP.readPage());assert.equal(loading.dialogState.busy,true);assert.equal(loading.runtimeDiagnostics.dialog.transition.sawBlockingLoad,true);
      await page.evaluate(()=>document.getElementById('connections')!.removeAttribute('aria-busy'));
      await waitConnection();assert.equal((await page.evaluate(()=>(window as any).ThreadsMCP.readPage())).dialogUsers.length,2);
    });
    await t.test('count-only tab labels do not create transitions and same-turn A to B to A requires a later refresh',async()=>{
      await read(connections,'/@owner');await page.evaluate(()=>{document.getElementById('followers')!.textContent='粉絲 540';document.getElementById('users')!.insertAdjacentHTML('beforeend','<div><a href="/@carol">carol</a></div>');});
      assert.equal((await page.evaluate(()=>(window as any).ThreadsMCP.readPage())).dialogState.busy,false);
      await page.evaluate(()=>{
        document.getElementById('followers')!.setAttribute('aria-selected','false');document.getElementById('following')!.setAttribute('aria-selected','true');
        document.getElementById('users')!.innerHTML='<div><a href="/@intermediate">intermediate</a></div>';
        document.getElementById('following')!.setAttribute('aria-selected','false');document.getElementById('followers')!.setAttribute('aria-selected','true');
      });
      await new Promise(resolve=>setTimeout(resolve,550));assert.equal((await page.evaluate(()=>(window as any).ThreadsMCP.readPage())).dialogState.busy,true);
      await page.evaluate(()=>{document.getElementById('users')!.innerHTML='<div><a href="/@alice">alice</a></div>';});await waitConnection();
      assert.equal((await page.evaluate(()=>(window as any).ThreadsMCP.readPage())).dialogUsers[0].username,'alice');
    });
    await t.test('connection transition state is discarded on modal replacement and route changes',async()=>{
      await read(connections,'/@owner');await selectConnection('following');assert.equal((await page.evaluate(()=>(window as any).ThreadsMCP.readPage())).dialogState.busy,true);
      await page.evaluate(()=>{const old=document.getElementById('connections')!;old.replaceWith(old.cloneNode(true));});
      let result=await page.evaluate(()=>(window as any).ThreadsMCP.readPage());assert.equal(result.dialogState.busy,false);assert.equal(result.runtimeDiagnostics.dialog.transition.pending,false);
      await selectConnection('followers');assert.equal((await page.evaluate(()=>(window as any).ThreadsMCP.readPage())).dialogState.busy,true);
      await page.evaluate(()=>history.pushState({},'','/@other'));result=await page.evaluate(()=>(window as any).ThreadsMCP.readPage());assert.equal(result.runtimeDiagnostics.dialog.transition.pending,false);
    });
  }finally{await browser.close();}
});
