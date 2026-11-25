'use strict';

const $ = id => document.getElementById(id);
const inboxForm = $('inbox-form');
const destination = $('destination');
const picker = $('pick-directory');
const manualDirectory = $('manual-directory');
const network = $('network');
const shareLink = $('share-link');
const shareQr = $('share-qr');
const qrDialog = $('qr-dialog');
const stopDialog = $('stop-dialog');
const receiptList = $('receipts');
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
});
const sizeFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });

let snapshot = null;
let writing = false;
let pollRequest = null;
let actionError = '';
let refreshError = '';
let shareAddresses = [];
let addressSignature = '';
let receiptSignature = '';

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = bytes > 0 ? Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1) : 0;
  return `${sizeFormat.format(bytes / 1024 ** index)} ${units[index]}`;
}

function setText(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

function renderStatus() {
  const status = $('host-status');
  status.dataset.state = refreshError ? 'error' : snapshot?.active ? 'active' : 'idle';
  if (refreshError) setText(status, '连接中断');
  else if (writing) setText(status, '处理中');
  else if (!snapshot) setText(status, '正在连接');
  else if (snapshot.active) setText(status, '收件中');
  else setText(status, snapshot.sessionId ? '收件已结束' : '');

  const error = actionError || refreshError;
  $('host-error').hidden = !error;
  setText($('host-error'), error);
  destination.disabled = !snapshot || writing;
  picker.disabled = writing;
  $('start-inbox').disabled = !snapshot || writing;
  $('stop-inbox').disabled = writing;
}

function renderAddress() {
  const address = shareAddresses.find(item => item.url === network.value);
  const placeholder = $('qr-placeholder');
  const showQr = $('show-qr');

  $('share-details').hidden = !address;
  $('copy-link').hidden = !address;
  shareLink.value = address?.url || '';
  setText($('copy-feedback'), '');
  showQr.disabled = true;
  showQr.hidden = true;
  placeholder.hidden = false;

  if (!address) {
    shareQr.removeAttribute('src');
    setText(placeholder, '未找到局域网地址，请检查主机的网络连接。');
    return;
  }

  setText(placeholder, '正在加载二维码…');
  shareQr.src = address.qrUrl;
  if (qrDialog.open) $('projector-qr').src = address.qrUrl;
}

function renderShare(addresses) {
  const signature = JSON.stringify(addresses);
  if (signature === addressSignature) return;

  const selected = network.value;
  addressSignature = signature;
  shareAddresses = addresses;
  network.replaceChildren(...addresses.map(address => {
    const label = `${address.label} · ${new URL(address.url).hostname}`;
    return new Option(label, address.url);
  }));
  if (addresses.some(address => address.url === selected)) network.value = selected;
  $('network-option').hidden = addresses.length < 2;
  renderAddress();
}

function renderReceipts(receipts) {
  const signature = JSON.stringify(receipts);
  if (signature === receiptSignature) return;
  receiptSignature = signature;

  const rows = receipts.map(receipt => {
    const row = document.createElement('li');
    row.className = 'file-row';

    const tile = document.createElement('span');
    tile.className = 'file-tile';
    tile.setAttribute('aria-hidden', 'true');
    const extension = /\.([a-z0-9]{1,5})$/i.exec(receipt.name);
    tile.textContent = extension ? extension[1].toUpperCase() : '';

    const details = document.createElement('div');
    details.className = 'file-text';

    const filename = document.createElement('p');
    filename.className = 'file-name';
    filename.textContent = receipt.name;

    const meta = document.createElement('p');
    meta.className = 'file-meta';
    meta.textContent = `${formatSize(receipt.size)} · ${dateFormat.format(new Date(receipt.receivedAt))}`;

    details.append(filename, meta);
    row.append(tile, details);
    return row;
  });

  receiptList.replaceChildren(...rows);
  receiptList.hidden = !receipts.length;
  $('receipts-empty').hidden = receipts.length > 0;
  setText($('file-count'), `${receipts.length} 个文件`);
}

function renderSnapshot(data) {
  const firstSnapshot = !snapshot;
  const ended = snapshot?.active && !data.active;
  if (firstSnapshot || ended) {
    destination.value = data.destination || '';
    manualDirectory.open = !data.canPickDirectory;
    $('share-options').open = false;
  }
  snapshot = data;

  $('setup-card').hidden = data.active;
  $('share-card').hidden = !data.active;
  $('receipts-card').hidden = !data.sessionId;
  picker.hidden = !data.canPickDirectory;
  manualDirectory.hidden = false;
  $('manual-directory-toggle').hidden = !data.canPickDirectory;
  $('active-destination').hidden = !data.sessionId;
  setText($('active-destination'), data.sessionId ? `保存到 ${data.destination}` : '');
  setText($('receipts-empty'), data.active ? '等待第一份文件。' : '本次没有收到文件。');

  if (!data.active && qrDialog.open) qrDialog.close();
  if (!data.active && stopDialog.open) stopDialog.close();
  renderShare(data.addresses);
  renderReceipts(data.receipts);
  renderStatus();
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error || '无法连接投递箱服务，请确认服务仍在运行。');
  if (!payload) throw new Error('无法读取投递箱状态，请重新加载页面。');
  return payload;
}

async function refresh() {
  if (writing || pollRequest) return;
  const controller = new AbortController();
  pollRequest = controller;
  try {
    const data = await requestJson('/api/inbox', { signal: controller.signal });
    if (controller.signal.aborted) return;
    refreshError = '';
    renderSnapshot(data);
  } catch (error) {
    if (controller.signal.aborted) return;
    refreshError = error instanceof TypeError ? '与投递箱服务的连接中断，正在尝试重新连接。' : error.message;
    renderStatus();
  } finally {
    if (pollRequest === controller) pollRequest = null;
  }
}

async function performAction(action) {
  if (writing) return;
  writing = true;
  pollRequest?.abort();
  actionError = '';
  renderStatus();
  try {
    await action();
    refreshError = '';
  } catch (error) {
    actionError = error instanceof TypeError ? '无法连接投递箱服务，请重试。' : error.message;
  } finally {
    writing = false;
    renderStatus();
  }
}

async function startInbox(folder) {
  const data = await requestJson('/api/inbox', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ destination: folder })
  });
  renderSnapshot(data);
  $('share-title').focus();
}

inboxForm.addEventListener('submit', event => {
  event.preventDefault();
  const folder = destination.value.trim();
  if (!folder) {
    actionError = '请选择或输入收件文件夹。';
    renderStatus();
    destination.focus();
    return;
  }
  performAction(() => startInbox(folder));
});

destination.addEventListener('input', () => {
  if (!actionError) return;
  actionError = '';
  renderStatus();
});

picker.addEventListener('click', async () => {
  await performAction(async () => {
    try {
      const result = await requestJson('/api/inbox/pick-directory', { method: 'POST' });
      if (!result.destination) return;
      destination.value = result.destination;
      await startInbox(result.destination);
    } catch (error) {
      manualDirectory.open = true;
      throw error;
    }
  });
  if (!snapshot.active) (manualDirectory.open ? destination : picker).focus();
});

network.addEventListener('change', renderAddress);
shareQr.addEventListener('load', () => {
  if (!$('share-card').hidden && shareLink.value) {
    $('qr-placeholder').hidden = true;
    $('show-qr').disabled = false;
    $('show-qr').hidden = false;
  }
});
shareQr.addEventListener('error', () => {
  if (shareLink.value) setText($('qr-placeholder'), '无法加载二维码，可复制投递链接。');
});

$('copy-link').addEventListener('click', async () => {
  const link = shareLink.value;
  if (!link) return;
  let copied = false;
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(link);
      copied = true;
    }
  } catch {
    // The link remains available for manual copy if the browser blocks clipboard access.
  }
  if (link !== shareLink.value) return;
  if (!copied) {
    $('share-options').open = true;
    shareLink.focus();
    shareLink.select();
    try { copied = document.execCommand('copy'); } catch { /* Manual copy stays available. */ }
  }
  setText($('copy-feedback'), copied ? '已复制投递链接。' : '链接已选中，请手动复制。');
});

$('show-qr').addEventListener('click', () => {
  $('projector-qr').src = shareQr.src;
  qrDialog.showModal();
});
$('stop-inbox').addEventListener('click', () => stopDialog.showModal());
$('confirm-stop').addEventListener('click', () => {
  stopDialog.close();
  performAction(async () => {
    const data = await requestJson('/api/inbox', { method: 'DELETE' });
    renderSnapshot(data);
    $('setup-title').focus();
  });
});

refresh();
setInterval(refresh, 2000);
