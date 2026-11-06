const status = document.getElementById('status');
const connectButton = document.getElementById('connect');
const disconnectButton = document.getElementById('disconnect');
const portInput = document.getElementById('port');
const tokenInput = document.getElementById('token');

function display(result) {
  const message = result.error || (result.connected ? `已連接分頁 ${result.tabId}` : '尚未連接');
  status.textContent = `v${result.version ?? chrome.runtime.getManifest().version} · ${message}`;
  connectButton.disabled = Boolean(result.connected);
  disconnectButton.disabled = !result.connected;
}

connectButton.addEventListener('click', async () => {
  connectButton.disabled = true;
  status.textContent = '連接中…';
  try { display(await chrome.runtime.sendMessage({ type: 'connect', port: Number(portInput.value), token: tokenInput.value.trim() })); }
  catch { display({ error: '無法連接，請確認本機服務與目前分頁。' }); }
});
disconnectButton.addEventListener('click', async () => display(await chrome.runtime.sendMessage({ type: 'disconnect' })));

chrome.storage.session.get(['port', 'token']).then(saved => {
  portInput.value = String(saved.port ?? 19758);
  tokenInput.value = saved.token ?? '';
});
chrome.runtime.sendMessage({ type: 'status' }).then(display).catch(() => display({ error: '擴充功能尚未準備完成。' }));
