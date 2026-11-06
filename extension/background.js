/* No cookies, debugger access, arbitrary script execution, or automatic reconnection. */
let socket = null;
let boundTabId = null;
let heartbeat = null;
let connected = false;
let epoch = 0;
let queue = Promise.resolve();
let lastError = '';
const seen = new Set();
const pendingNavigations = new Set();
const pendingConnections = new Set();

function threadsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') &&
      ['threads.com', 'threads.net'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch { return false; }
}

function failure(code, message) { return Object.assign(new Error(message), { code }); }

function disconnect(reason = '') {
  const previousTabId = boundTabId;
  epoch++;
  for (const cancel of pendingNavigations) cancel();
  for (const cancel of pendingConnections) cancel();
  connected = false;
  boundTabId = null;
  clearInterval(heartbeat);
  heartbeat = null;
  const old = socket;
  socket = null;
  old?.close();
  lastError = reason;
  seen.clear();
  queue = Promise.resolve();
  // Invalidate pending in-page approvals and async media work without changing the
  // user's composer. Effects already dispatched cannot be undone by disconnect.
  if (previousTabId !== null && chrome.scripting?.executeScript) {
    void chrome.scripting.executeScript({ target: { tabId: previousTabId }, world: 'ISOLATED', injectImmediately: true, func: () => {
      globalThis.ThreadsMCP?.cancelMediaTransfers?.();
      globalThis.ThreadsMCP?.cancelSocialActions?.();
    } }).catch(() => undefined);
  }
}

async function boundTab(requireActive = false) {
  if (boundTabId === null) throw failure('BRIDGE_DISCONNECTED', 'Threads 分頁已斷線。');
  let tab;
  try { tab = await chrome.tabs.get(boundTabId); }
  catch { disconnect('選取的分頁已關閉。'); throw failure('TAB_CLOSED', '選取的分頁已關閉。'); }
  if (!threadsUrl(tab.url)) { disconnect('分頁已離開 Threads。'); throw failure('INVALID_TAB_URL', '選取的分頁已離開 Threads。'); }
  if (requireActive && !tab.active) throw failure('TAB_NOT_ACTIVE', '請先手動切換回已連接的 Threads 分頁。');
  return tab;
}

function assertConnection(tabId, generation) {
  if (generation !== epoch || !connected || boundTabId !== tabId) throw failure('BRIDGE_DISCONNECTED', '連線已中斷；指令未執行。');
}

async function ensureRuntime(tabId, generation) {
  assertConnection(tabId, generation);
  const version = chrome.runtime.getManifest().version;
  const existing = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', injectImmediately: true,
    args: [version], func: version => Boolean(globalThis.ThreadsMCP?.readPage && globalThis.ThreadsMCP?.snapshot && globalThis.ThreadsMCP.runtimeVersion === version) });
  assertConnection(tabId, generation);
  const documentId = existing[0]?.documentId;
  if (typeof documentId !== 'string' || !documentId) throw failure('RUNTIME_CONTEXT_UNVERIFIED', '無法確認目前文件；指令未執行。');
  if (!existing[0]?.result) await chrome.scripting.executeScript({ target: { tabId, documentIds: [documentId] }, world: 'ISOLATED', injectImmediately: true, files: ['runtime.js'] });
  assertConnection(tabId, generation);
  return documentId;
}

async function runtime(tabId, command, generation) {
  const documentId = await ensureRuntime(tabId, generation);
  assertConnection(tabId, generation);
  const extensionVersion = chrome.runtime.getManifest().version;
  const results = await chrome.scripting.executeScript({ target: { tabId, documentIds: [documentId] }, world: 'ISOLATED', injectImmediately: true, args: [command, extensionVersion],
    func: async (command, extensionVersion) => {
      const api = globalThis.ThreadsMCP;
      try {
        if (api.runtimeVersion !== extensionVersion && (command.type === 'interact' || command.type === 'media' || (command.type === 'social' && command.operation !== 'inspect')))
          throw Object.assign(new Error('Reload the extension and reconnect before preparing or executing actions; installed and page runtime versions differ.'), { code: 'RUNTIME_VERSION_MISMATCH' });
        let result;
        switch (command.type) {
          case 'read': result = { ...await api.readPage(), extensionVersion }; break;
          case 'snapshot': result = await api.snapshot(); break;
          case 'interact': result = await api.interact({ snapshotId: command.snapshotId, ref: command.ref, verb: command.verb, value: command.value }); break;
          case 'scroll': result = await api.scroll(command.pixels); break;
          case 'open_read_panel': result = await api.openReadPanel(command.panel,command.activityTab); break;
          case 'social': result = command.operation==='stage'?await api.socialStage(command.request):command.operation==='commit'?await api.socialCommit(command.token,command.expectedAccount):await api.socialInspect(command.request,command.token);break;
          case 'media': result=await api.media(command);break;
          default: throw Object.assign(new Error('Unsupported command'), { code: 'INVALID_COMMAND' });
        }
        return { result };
      } catch (error) {
        const message=String(error?.message ?? 'Page command failed');
        return { error: { code: String(error?.code ?? /^[A-Z_]+:/.exec(message)?.[0].slice(0,-1) ?? 'PAGE_COMMAND_FAILED').slice(0, 100), message: message.slice(0, 1000) } };
      }
    } });
  const response = results[0]?.result;
  if (!response) throw failure('PAGE_COMMAND_FAILED', '頁面沒有回應；指令不會重送。');
  if (response.error) throw failure(response.error.code, response.error.message);
  return response.result;
}

function destinationKey(value) {
  const url = new URL(value);
  // Threads redirects its legacy domain and bare hostname to the canonical site.
  const hostname = ['threads.com', 'www.threads.com', 'threads.net', 'www.threads.net'].includes(url.hostname) ? 'threads.com' : url.hostname;
  url.searchParams.sort();
  return `${hostname}${url.pathname.replace(/\/$/, '')}${url.search}${url.hash}`;
}

async function navigate(tabId, url, generation) {
  if (!threadsUrl(url)) throw failure('INVALID_URL', '僅允許 HTTPS Threads 網址。');
  const requested = destinationKey(url);
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let finished = false;
    let pollTimer;
    let previousDocumentId;
    // Controlled phase only: it survives the host's sanitized error envelope and
    // distinguishes an outstanding script from an observed not-ready document.
    let phase = 'BASELINE_PROBE';
    const deadline = setTimeout(() => finish(failure(`NAVIGATION_TIMEOUT_${phase}`, '指定頁面尚未完成載入；請檢查分頁狀態。')), 20000);
    const cancel = () => finish(failure('BRIDGE_DISCONNECTED', '連線已中斷，已停止等待導覽。'));
    pendingNavigations.add(cancel);
    function finish(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearTimeout(pollTimer);
      pendingNavigations.delete(cancel);
      if (error) reject(error); else resolve(result);
    }
    function stillConnected() {
      return !finished && generation === epoch && connected && boundTabId === tabId;
    }
    async function inspect() {
      if (!stillConnected()) { cancel(); return; }
      try {
        phase = 'TAB';
        const tab = await boundTab();
        if (!stillConnected()) { cancel(); return; }
        if (destinationKey(tab.url) === requested) {
          // Wait for the requested document and visible body, not all image/video
          // subresources. Neither tab URL metadata nor an old document is enough.
          phase = 'PROBE';
          const states = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', injectImmediately: true,
            func: () => ({ url: location.href, readyState: document.readyState, hasBody: Boolean(document.body?.innerText?.trim()) }) });
          if (!stillConnected()) { cancel(); return; }
          const state = states[0]?.result;
          const documentId = states[0]?.documentId;
          if (typeof documentId !== 'string' || !documentId || documentId === previousDocumentId) phase = 'DOCUMENT';
          else if (!state || !threadsUrl(state.url) || destinationKey(state.url) !== requested) phase = 'ROUTE';
          else if (!['interactive', 'complete'].includes(state.readyState)) phase = 'DOM';
          else if (!state.hasBody) phase = 'CONTENT';
          else {
            finish(null, { url: state.url, title: tab.title ?? '', readiness: state.readyState, tabStatus: tab.status ?? null,
              documentChanged: true, elapsedMs: Date.now() - startedAt }); return;
          }
        } else phase = 'ROUTE';
      } catch (error) {
        if (!stillConnected()) { cancel(); return; }
        if (error?.code === 'TAB_CLOSED' || error?.code === 'INVALID_TAB_URL') { finish(error); return; }
        // A document can disappear during navigation; retry only this read-only readiness inspection.
        phase = 'PROBE_ERROR';
      }
      if (!finished) pollTimer = setTimeout(inspect, 150);
    }
    if (!stillConnected()) { cancel(); return; }
    // Capture the old document before dispatch. A same-URL reload otherwise lets
    // the old ready DOM (including open dialogs) masquerade as the new page.
    void (async () => {
      try {
        const before = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', injectImmediately: true,
          func: () => ({ url: location.href }) });
        if (!stillConnected()) { cancel(); return; }
        previousDocumentId = before[0]?.documentId;
        if (typeof previousDocumentId !== 'string' || !previousDocumentId) {
          finish(failure('NAVIGATION_CONTEXT_UNVERIFIED', '無法確認導覽前的文件；尚未導覽。')); return;
        }
        // Issue navigation exactly once. Never activate the tab or focus its window.
        phase = 'UPDATE';
        await chrome.tabs.update(tabId, { url });
        if (!stillConnected()) { cancel(); return; }
        void inspect();
      } catch {
        if (!stillConnected()) { cancel(); return; }
        finish(failure('NAVIGATION_FAILED', '無法導覽已連接的分頁。'));
      }
    })();
  });
}

async function execute(command, generation) {
  if (generation !== epoch || !connected) throw failure('BRIDGE_DISCONNECTED', '連線已中斷；指令未執行。');
  if (!command || typeof command !== 'object') throw failure('INVALID_COMMAND', '指令格式錯誤。');
  const allowed = ['navigate', 'read', 'snapshot', 'interact', 'scroll', 'open_read_panel', 'screenshot','social','media'];
  if (!allowed.includes(command.type)) throw failure('INVALID_COMMAND', '不支援這個指令。');
  const tab = await boundTab(['interact', 'screenshot'].includes(command.type));
  if (generation !== epoch) throw failure('BRIDGE_DISCONNECTED', '連線已中斷。');
  if (command.type === 'navigate') return navigate(tab.id, command.url, generation);
  if (command.type === 'screenshot') {
    const window = await chrome.windows.get(tab.windowId);
    if (!window.focused) throw failure('TAB_NOT_VISIBLE', '截圖需要你手動將已連接的分頁視窗移到前景。');
    // Recheck immediately before capture; never activate another tab/window ourselves.
    const active = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (active[0]?.id !== tab.id) throw failure('TAB_NOT_ACTIVE', '已連接的分頁不是目前分頁。');
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
    const after = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (after[0]?.id !== tab.id) throw failure('TAB_CHANGED', '截圖期間分頁切換，截圖已丟棄。');
    return { dataUrl, url: tab.url };
  }
  if (command.type === 'scroll' && (typeof command.pixels !== 'number' || !Number.isFinite(command.pixels) || Math.abs(command.pixels) > 10000)) throw failure('INVALID_COMMAND', '捲動距離超出範圍。');
  if (command.type === 'open_read_panel' && !['followers', 'following', 'likers'].includes(command.panel)) throw failure('INVALID_COMMAND', '清單類型錯誤。');
  if (command.type === 'open_read_panel' && command.activityTab !== undefined && (command.panel !== 'likers' || !['likes','reposts'].includes(command.activityTab))) throw failure('INVALID_COMMAND', '貼文動態類型錯誤。');
  if (command.type === 'interact' && (typeof command.snapshotId !== 'string' || typeof command.ref !== 'string' || !['click', 'fill', 'press', 'select', 'check'].includes(command.verb))) throw failure('INVALID_COMMAND', '互動指令格式錯誤。');
  if(command.type==='social'&&!['stage','commit','inspect'].includes(command.operation))throw failure('INVALID_COMMAND','Unknown social operation.');
  if(command.type==='media'&&!['begin','chunk','finish','abort'].includes(command.operation))throw failure('INVALID_COMMAND','Unknown media operation.');
  return runtime(tab.id, command, generation);
}

async function connect(port, token) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-f0-9]{64}$/.test(token)) throw failure('INVALID_PAIRING', '請確認連接埠與配對碼。');
  // Reserve this explicit connection attempt before any await. Stop/newer attempts win.
  disconnect();
  const generation = epoch;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (generation !== epoch) throw failure('CONNECTION_CANCELLED', '連線要求已取消或被較新的要求取代。');
  if (!tab?.id || !threadsUrl(tab.url)) throw failure('INVALID_TAB_URL', '請先選取你要連接的 Threads 分頁。');
  boundTabId = tab.id;
  await chrome.storage.session.set({ port, token });
  if (generation !== epoch) throw failure('CONNECTION_CANCELLED', '連線要求已取消或被較新的要求取代。');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
    socket = ws;
    let settled = false;
    const current = () => socket === ws && generation === epoch;
    function fail(code, message) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingConnections.delete(cancel);
      reject(failure(code, message));
    }
    const cancel = () => fail('CONNECTION_CANCELLED', '連線要求已取消或被較新的要求取代。');
    const timer = setTimeout(() => {
      if (settled) return;
      fail('CONNECTION_TIMEOUT', '本機服務沒有回應。');
      if (current()) disconnect('本機服務沒有回應。');
    }, 7000);
    pendingConnections.add(cancel);
    ws.onopen = () => {
      if (!current()) { ws.close(); return; }
      ws.send(JSON.stringify({ type: 'auth', token, extensionVersion: chrome.runtime.getManifest().version, tab: { id: tab.id, url: tab.url, title: tab.title ?? '' } }));
    };
    ws.onerror = () => { fail('CONNECTION_FAILED', '無法連接本機服務，請確認它已啟動。'); if (current()) disconnect('無法連接本機服務。'); };
    ws.onclose = () => { fail('CONNECTION_CLOSED', '連線被拒絕或已中斷，請確認配對碼。'); if (current()) disconnect('連線已中斷，需手動重新連接。'); };
    ws.onmessage = event => {
      if (socket !== ws || generation !== epoch || typeof event.data !== 'string' || event.data.length > 65536) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message !== 'object') return;
      if (message.type === 'ready') {
        if (settled) return;
        settled = true; clearTimeout(timer); pendingConnections.delete(cancel); connected = true; lastError = '';
        heartbeat = setInterval(() => { if (current() && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' })); }, 20000);
        resolve({ connected: true, tabId: boundTabId, version: chrome.runtime.getManifest().version }); return;
      }
      if (!message.id || !message.command || !connected) return;
      const id = message.id;
      if (seen.has(id)) return;
      seen.add(id);
      if (seen.size > 1000) seen.delete(seen.values().next().value);
      queue = queue.then(async () => {
        let response;
        try { response = { id, result: await execute(message.command, generation) }; }
        catch (error) { response = { id, error: { code: error?.code ?? 'BRIDGE_COMMAND_FAILED', message: error?.code ? error.message : '無法執行頁面指令；請檢查已連接的分頁。' } }; }
        if (socket !== ws || generation !== epoch || ws.readyState !== WebSocket.OPEN) return;
        let json = JSON.stringify(response);
        if (new TextEncoder().encode(json).length > 3900000) json = JSON.stringify({ id, error: { code: 'RESULT_TOO_LARGE', message: '結果超過傳輸上限，未傳回部分資料。' } });
        ws.send(json);
      }).catch(() => undefined);
    };
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message.type === 'status') { sendResponse({ connected, tabId: boundTabId, version: chrome.runtime.getManifest().version, error: lastError }); return false; }
  if (message.type === 'disconnect') { disconnect(); sendResponse({ connected: false, version: chrome.runtime.getManifest().version }); return false; }
  if (message.type === 'connect') {
    // Closing the popup destroys its response channel, not the worker-owned connection.
    const reply = result => { try { sendResponse(result); } catch { /* Popup already closed. */ } };
    connect(message.port, message.token).then(reply, error => reply({ error: error.message }));
    return true;
  }
  return false;
});
chrome.tabs.onRemoved.addListener(id => { if (id === boundTabId) disconnect('已連接的分頁已關閉。'); });
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (id !== boundTabId || !change.url) return;
  if (!threadsUrl(change.url)) { disconnect('分頁已離開 Threads。'); return; }
  if (connected && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'tab', tab: { id, url: change.url, title: tab.title ?? '' } }));
});
