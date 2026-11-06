import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('page runtime: stale controls and read-only Following tab guard', { skip: process.env.THREADS_BROWSER_TESTS !== 'true' }, async () => {
  const bundled = await build({ entryPoints: ['src/page-runtime.ts'], bundle: true, platform: 'browser', format: 'iife',
    globalName: 'ThreadsMCP', write: false, target: 'chrome120' });
  const browser = await chromium.launch({ channel: process.env.THREADS_BROWSER_CHANNEL || 'chrome', headless: true });
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
      <a href="/@fixture" aria-label="Profile">Profile</a>
      <input aria-label="Draft" value="original">
      <div role="dialog"><button aria-label="Following" onclick="window.didUnfollow=true">Following</button></div>
    </body></html>` }));
    const page = await context.newPage();
    await page.goto('https://www.threads.com/@fixture');
    await page.addScriptTag({ content: bundled.outputFiles[0]!.text });
    await assert.rejects(page.evaluate(() => (window as any).ThreadsMCP.openReadPanel('following')), /unique read-only panel/);
    assert.equal(await page.evaluate(() => (window as any).didUnfollow), undefined);
    await page.evaluate(() => {
      const tab = document.createElement('div'); tab.setAttribute('role', 'tab');
      const button=document.createElement('button');button.textContent='Following';
      button.onclick = () => { (window as any).openedFollowing = true; };tab.append(button);document.querySelector('[role="dialog"]')!.prepend(tab);
    });
    await page.evaluate(() => (window as any).ThreadsMCP.openReadPanel('following'));
    assert.equal(await page.evaluate(() => (window as any).openedFollowing), true);
    assert.equal(await page.evaluate(() => (window as any).didUnfollow), undefined);
    const snap = await page.evaluate(() => (window as any).ThreadsMCP.snapshot());
    const draftRef = snap.elements.find((el: any) => el.name === 'Draft').ref;
    await page.locator('input').fill('manual edit');
    await assert.rejects(page.evaluate(({ snapshotId, ref }) => (window as any).ThreadsMCP.interact({ snapshotId, ref, verb: 'fill', value: 'agent edit' }),
      { snapshotId: snap.snapshotId, ref: draftRef }), /STALE_ELEMENT/);
    assert.equal(await page.locator('input').inputValue(), 'manual edit');
    const fresh = await page.evaluate(() => (window as any).ThreadsMCP.snapshot());
    const freshRef = fresh.elements.find((el: any) => el.name === 'Draft').ref;
    const args = { snapshotId: fresh.snapshotId, ref: freshRef, verb: 'fill', value: 'agent edit' };
    await page.evaluate(args => (window as any).ThreadsMCP.interact(args), args);
    assert.equal(await page.locator('input').inputValue(), 'agent edit');
    await assert.rejects(page.evaluate(args => (window as any).ThreadsMCP.interact(args), args), /STALE_SNAPSHOT/);
    // A hidden old dialog may precede the active dialog in the DOM during transitions.
    await page.evaluate(() => {
      document.querySelector('[role="dialog"]')!.outerHTML = `
        <div role="dialog" style="display:none"><a href="/@hidden_old">hidden_old</a></div>
        <div role="dialog" aria-hidden="true"><a href="/@background">background</a></div>
        <div role="dialog" id="active-list">
          <button role="tab" aria-selected="true">Followers</button>
          <button role="tab" aria-selected="false" id="following-tab">Following</button>
          <div id="list-content"><a href="/@follower">follower</a></div>
          <span role="progressbar" style="display:none">Old spinner</span>
        </div>`;
      document.getElementById('following-tab')!.onclick = () => {
        const dialog = document.getElementById('active-list')!;
        dialog.querySelector('[aria-selected="true"]')!.setAttribute('aria-selected', 'false');
        document.getElementById('following-tab')!.setAttribute('aria-selected', 'true');
        document.getElementById('list-content')!.innerHTML = '<svg role="progressbar" width="16" height="16"></svg>';
        (window as any).finishListLoad = () => {
          document.getElementById('list-content')!.innerHTML = '<a href="/@following_user">following_user</a><a style="display:none" href="/@hidden_row">hidden_row</a>';
        };
      };
    });
    const followers = await page.evaluate(() => (window as any).ThreadsMCP.readPage());
    assert.deepEqual(followers.dialogState, { present: true, selectedTab: 'Followers', busy: false });
    assert.deepEqual(followers.dialogUsers.map((user: any) => user.username), ['follower']);
    await page.evaluate(() => (window as any).ThreadsMCP.openReadPanel('following'));
    const loading = await page.evaluate(() => (window as any).ThreadsMCP.readPage());
    assert.deepEqual(loading.dialogState, { present: true, selectedTab: 'Following', busy: true });
    assert.deepEqual(loading.dialogUsers, []);
    await page.evaluate(() => (window as any).finishListLoad());
    assert.equal((await page.evaluate(() => (window as any).ThreadsMCP.readPage())).dialogState.busy, true);
    await page.waitForFunction(() => !(window as any).ThreadsMCP.readPage().dialogState.busy);
    const loaded = await page.evaluate(() => (window as any).ThreadsMCP.readPage());
    assert.deepEqual(loaded.dialogState, { present: true, selectedTab: 'Following', busy: false });
    assert.deepEqual(loaded.dialogUsers.map((user: any) => user.username), ['following_user']);
    await page.evaluate(() => document.getElementById('active-list')!.remove());
    const absent = await page.evaluate(() => (window as any).ThreadsMCP.readPage());
    assert.deepEqual(absent.dialogState, { present: false, selectedTab: null, busy: false });
    assert.deepEqual(absent.dialogUsers, []);

    const jsonPost = (code: string, pk: string) => ({ code, pk, user: { username: 'fixture', pk: '9' }, caption: { text: `old ${code}` }, like_count: 500 });
    const payload = { data: { media: { ...jsonPost('ROOT', '100'), text_post_app_info: {
      direct_replies: { edges: [{ node: { posts: { edges: [{ node: jsonPost('CHILD', '101') }] } } }] },
    } }, other: jsonPost('OFFSCREEN', '102') } };
    const cards = `<article><a href="/@fixture/post/ROOT">Root link</a><p>visible root</p><button aria-label="Like">7</button></article>
      <article><a href="/@fixture/post/CHILD">Child link</a><p>visible child</p><button aria-label="Like">3</button></article>`;
    await page.goto('https://www.threads.com/@fixture/post/ROOT');
    await page.evaluate(({ payload, cards }) => {
      document.body.innerHTML = cards;
      const script = document.createElement('script'); script.type = 'application/json'; script.textContent = JSON.stringify(payload); document.body.append(script);
    }, { payload, cards });
    await page.addScriptTag({ content: bundled.outputFiles[0]!.text });
    const initial = await page.evaluate(() => (window as any).ThreadsMCP.readPage());
    assert.equal(initial.replies.length, 1);
    assert.equal(initial.replies[0].rootId, '100');
    assert.equal(initial.posts.find((post: any) => post.code === 'CHILD').rootId, '100');
    assert.equal(initial.replies[0].likes, 3);
    assert.equal(initial.visibilityState, await page.evaluate(() => document.visibilityState));
    assert.ok(initial.warnings.some((message: string) => message.startsWith('SSR_DOCUMENT_SNAPSHOT')));
    await page.evaluate(() => {
      history.pushState({}, '', '/@fixture/post/NEXT');
      document.querySelectorAll('article')[1]!.remove();
      document.querySelector('article p')!.textContent = 'new visible content';
      document.querySelector('article button')!.textContent = '';
    });
    const moved = await page.evaluate(() => (window as any).ThreadsMCP.readPage());
    assert.deepEqual(moved.posts.map((post: any) => post.code), ['ROOT']);
    assert.equal(moved.posts[0].id, '100');
    assert.equal(moved.posts[0].text, 'new visible content');
    assert.equal(moved.posts[0].likes, null);
    assert.equal(moved.posts[0].source, 'browser-dom');
    assert.deepEqual(moved.replies, []);
    assert.deepEqual(moved.profiles, []);
    assert.ok(moved.warnings.some((message: string) => message.startsWith('SSR_SCOPE_UNCERTAIN')));
    await page.evaluate(() => history.pushState({}, '', '/@fixture/post/ROOT'));
    const back = await page.evaluate(() => (window as any).ThreadsMCP.readPage());
    assert.equal(back.posts.length, 1); // Returning to the document URL does not revive old SSR records.
    assert.equal(back.posts[0].likes, null);

    // Detect SPA navigation that happened before runtime attachment using document timing.
    await page.goto('https://www.threads.com/@fixture/post/ROOT');
    await page.evaluate(({ payload, cards }) => {
      document.body.innerHTML = cards;
      const script = document.createElement('script'); script.type = 'application/json'; script.textContent = JSON.stringify(payload); document.body.append(script);
      history.pushState({}, '', '/@fixture/post/NEXT');
    }, { payload, cards });
    await page.addScriptTag({ content: bundled.outputFiles[0]!.text });
    const lateAttach = await page.evaluate(() => (window as any).ThreadsMCP.readPage());
    assert.deepEqual(lateAttach.posts.map((post: any) => post.code), ['ROOT', 'CHILD']);
    assert.deepEqual(lateAttach.replies, []);
    assert.ok(lateAttach.warnings.some((message: string) => message.startsWith('SSR_SCOPE_UNCERTAIN')));
  } finally { await browser.close(); }
});

test('page runtime: account visibility, complete draft fingerprints and SVG-title post metrics', {skip:process.env.THREADS_BROWSER_TESTS!=='true'},async t=>{
  const bundled=await build({entryPoints:['src/page-runtime.ts'],bundle:true,platform:'browser',format:'iife',globalName:'ThreadsMCP',write:false,target:'chrome120'});
  const browser=await chromium.launch({channel:process.env.THREADS_BROWSER_CHANNEL||'chrome',headless:true});
  try{
    const context=await browser.newContext();await context.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><html><body></body></html>'}));
    const page=await context.newPage();await page.goto('https://www.threads.com/@alice/post/ROOT');await page.addScriptTag({content:bundled.outputFiles[0]!.text});
    const setBody=(html:string)=>page.evaluate(html=>{document.body.innerHTML=html;},html);
    await t.test('viewer ignores hidden old accounts, inert links and external profiles, and rejects visible account conflicts',async()=>{
      await setBody(`<a style="display:none" href="/@old" aria-label="Profile">Old</a><div aria-hidden="true"><a href="/@old2" aria-label="Profile">Old</a></div>
        <div inert><a href="/@old3" aria-label="Profile">Old</a></div><a href="https://example.com/@external" aria-label="Profile">External</a>
        <nav><a href="/@alice"><svg width="18" height="18" title="個人檔案"><title>個人檔案</title></svg></a><a href="/@ALICE" aria-label="Profile">Duplicate navigation</a></nav>`);
      assert.equal((await page.evaluate(()=>(window as any).ThreadsMCP.snapshot())).viewer.username,'alice');
      await page.evaluate(()=>{const link=document.createElement('a');link.href='/@bob';link.setAttribute('aria-label','Profile');document.querySelector('nav')!.append(link);link.textContent='Bob';});
      assert.equal((await page.evaluate(()=>(window as any).ThreadsMCP.snapshot())).viewer.username,null);
    });
    await t.test('manual long-draft tail edits invalidate editor fill and nearby prepared submit clicks',async()=>{
      await setBody(`<div role="dialog"><div contenteditable="true" role="textbox" aria-label="Draft">${'x'.repeat(1200)}original tail</div><button onclick="window.didSubmit=true">Publish</button></div>`);
      const before=await page.evaluate(()=>(window as any).ThreadsMCP.snapshot());const ref=before.elements.find((el:any)=>el.name==='Draft').ref;
      await page.evaluate(()=>{document.querySelector('[contenteditable]')!.textContent='x'.repeat(1200)+'manual tail';});
      await assert.rejects(page.evaluate(args=>(window as any).ThreadsMCP.interact(args),{snapshotId:before.snapshotId,ref,verb:'fill',value:'replacement'}),/STALE_ELEMENT/);
      assert.ok((await page.locator('[contenteditable]').innerText()).endsWith('manual tail'));
      const after=await page.evaluate(()=>(window as any).ThreadsMCP.snapshot());const button=after.elements.find((el:any)=>el.name==='Publish').ref;
      await page.evaluate(()=>{document.querySelector('[contenteditable]')!.textContent='x'.repeat(1200)+'second manual tail';});
      await assert.rejects(page.evaluate(args=>(window as any).ThreadsMCP.interact(args),{snapshotId:after.snapshotId,ref:button,verb:'click'}),/STALE_ELEMENT/);
      assert.equal(await page.evaluate(()=>(window as any).didSubmit),undefined);
    });
    await t.test('SVG title labels yield observed counts without borrowing sibling post reactions',async()=>{
      await setBody(`<main><div><header><a href="/@alice/post/ROOT">Duplicate root header</a><a href="/@orphan/post/ORPHAN">Orphan header</a></header>
        <article><a href="/@alice/post/ROOT">Root</a><a href="/insights/post/ROOT">Insights</a><p>root content</p>
          <div role="button"><svg width="18" height="18" title="收回讚"><title>收回讚</title></svg>193</div>
          <div role="button"><svg width="18" height="18"><title>已回覆</title></svg>2</div>
          <div role="button"><svg width="18" height="18" title="轉發"><title>轉發</title></svg>3</div></article>
        <article><a href="/@bob/post/SECOND">Second</a><p>second content</p><button aria-label="讚7"></button><button aria-label="回覆5"></button><button aria-label="轉發2"></button></article></div></main>`);
      const result=await page.evaluate(()=>(window as any).ThreadsMCP.readPage());assert.deepEqual(result.posts.map((post:any)=>post.code).sort(),['ROOT','SECOND']);
      const root=result.posts.find((post:any)=>post.code==='ROOT');assert.equal(root.text,'root content');assert.equal(root.likes,193);assert.equal(root.replies,2);assert.equal(root.reposts,3);assert.equal(root.likedByViewer,true);
      const second=result.posts.find((post:any)=>post.code==='SECOND');assert.equal(second.likes,7);assert.equal(second.replies,5);assert.equal(second.reposts,2);assert.equal(second.likedByViewer,false);
      const snap=await page.evaluate(()=>(window as any).ThreadsMCP.snapshot());assert.ok(snap.elements.some((el:any)=>el.name==='收回讚'));
    });
    await t.test('conflicting icon titles do not establish a reaction or supply a post card',async()=>{
      await setBody('<article><a href="/@alice/post/ROOT">Root</a><p>root</p><button><svg width="18" height="18" title="Like"><title>Delete</title></svg>12</button></article>');
      const result=await page.evaluate(()=>(window as any).ThreadsMCP.readPage());assert.deepEqual(result.posts,[]);
    });
  }finally{await browser.close();}
});
