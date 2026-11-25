'use strict';

const $ = selector => document.querySelector(selector);
const state = { info: null, path: '', files: [], uploads: [], signature: '', request: 0, uploading: false, pendingDelete: null, deleting: false };
let toastTimer;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.classList.add('icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

function toast(message) {
  clearTimeout(toastTimer);
  const node = $('#toast');
  (document.querySelector('dialog[open]') || document.body).append(node);
  node.textContent = message;
  node.hidden = false;
  toastTimer = setTimeout(() => { node.hidden = true; }, 3000);
}

function bytes(size) {
  if (!size) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unit = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  return (size / 1024 ** unit).toFixed(unit ? 1 : 0) + ' ' + units[unit];
}

function formatDate(value) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value));
}

function showError(message) {
  $('#connection-error').hidden = !message;
  $('#connection-message').textContent = message || '';
}

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 401 && url !== '/api/login') showAuth();
    throw new Error(body.error || '操作失败');
  }
  return body;
}

function showAuth() {
  state.info = null;
  state.files = [];
  state.signature = '';
  $('#file-list').replaceChildren();
  $('#empty-state').hidden = true;
  $('#share-button').disabled = true;
  $('#upload-button').hidden = true;
  $('#new-folder-button').hidden = true;
  $('#access-code').textContent = '';
  $('#address-select').replaceChildren();
  $('#qr-image').hidden = true;
  document.querySelectorAll('dialog[open]').forEach(dialog => {
    if (dialog.id !== 'auth-dialog') dialog.close();
  });
  if (!$('#auth-dialog').open) $('#auth-dialog').showModal();
}

function updateAddress() {
  const url = $('#address-select').value;
  $('#copy-address').disabled = !url;
  $('#qr-image').hidden = !url;
  $('#qr-placeholder').hidden = Boolean(url);
  $('#qr-placeholder').textContent = '暂无局域网地址';
  if (url && $('#share-dialog').open) $('#qr-image').src = '/api/qr?url=' + encodeURIComponent(url);
}

async function loadInfo() {
  const info = await api('/api/info');
  state.info = info;
  $('#upload-button').hidden = info.readOnly;
  $('#new-folder-button').hidden = info.readOnly || info.publicAccess;
  $('#share-button').disabled = false;
  $('#code-row').hidden = !info.code;
  $('#access-code').textContent = info.code || '';
  $('#address-select').replaceChildren();
  for (const address of info.urls) {
    const option = element('option', '', address.url);
    option.value = address.url;
    option.title = address.label;
    $('#address-select').append(option);
  }
  if (info.urls.some(item => item.url === location.origin)) $('#address-select').value = location.origin;
  updateAddress();
  showError('');
}

function renderBreadcrumbs() {
  const parts = state.path ? state.path.split('/') : [];
  $('#breadcrumbs').replaceChildren();
  ['全部文件', ...parts].forEach((name, index) => {
    if (index) $('#breadcrumbs').append(element('span', '', '/'));
    const button = element('button', '', name);
    button.title = name;
    if (index === parts.length) button.setAttribute('aria-current', 'page');
    button.addEventListener('click', () => navigate(parts.slice(0, index).join('/')));
    $('#breadcrumbs').append(button);
  });
}

function navigate(folder) {
  state.path = folder;
  state.signature = '';
  state.files = [];
  $('#search').value = '';
  renderBreadcrumbs();
  $('#file-list').replaceChildren();
  $('#empty-state').hidden = false;
  $('#empty-state').textContent = '正在加载…';
  refresh();
}

async function refresh(silent = false) {
  if (!state.info) return;
  const request = ++state.request;
  try {
    const data = await api('/api/files?path=' + encodeURIComponent(state.path));
    if (request !== state.request) return;
    showError('');
    const signature = JSON.stringify(data.files);
    state.files = data.files;
    if (!silent || signature !== state.signature) renderFiles();
    state.signature = signature;
  } catch (err) {
    if (request !== state.request) return;
    showError(err.message || '连接已断开');
    if (!state.files.length) {
      $('#empty-state').hidden = false;
      $('#empty-state').textContent = '加载失败';
    }
  }
}

function fileControl(file, className, text) {
  const folder = file.type === 'folder';
  const control = element(folder ? 'button' : 'a', className, text);
  control.setAttribute('aria-label', (folder ? '打开文件夹 ' : '下载文件 ') + file.name);
  if (folder) control.addEventListener('click', () => navigate(file.path));
  else {
    control.href = '/api/download?path=' + encodeURIComponent(file.path);
    control.download = file.name;
  }
  return control;
}

function renderFiles() {
  const query = $('#search').value.trim().toLocaleLowerCase();
  const files = state.files.filter(file => file.name.toLocaleLowerCase().includes(query));
  files.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
  });
  const rows = document.createDocumentFragment();
  for (const file of files) {
    const folder = file.type === 'folder';
    const row = element('tr');
    const nameCell = element('td');
    const label = element('div', 'file-label');
    const symbol = element('span', 'file-symbol' + (folder ? ' folder' : ''));
    symbol.append(icon(folder ? 'folder' : 'file'));
    const text = element('div', 'file-text');
    const name = fileControl(file, 'file-name', file.name);
    name.title = file.name;
    text.append(name, element('span', 'mobile-size', folder ? '文件夹' : bytes(file.size)));
    label.append(symbol, text);
    nameCell.append(label);
    const actionCell = element('td', 'action-column');
    const action = fileControl(file, 'file-action');
    action.append(icon(folder ? 'arrow' : 'download'), document.createTextNode(folder ? '打开' : '下载'));
    const actions = element('div', 'row-actions');
    actions.append(action);
    if (!folder && state.info && !state.info.readOnly) {
      const remove = element('button', 'icon-button delete-button');
      remove.title = '删除文件';
      remove.setAttribute('aria-label', '删除文件 ' + file.name);
      remove.append(icon('trash'));
      remove.addEventListener('click', () => {
        state.pendingDelete = { ...file };
        $('#delete-filename').textContent = file.name;
        $('#delete-error').textContent = '';
        $('#delete-dialog').showModal();
      });
      actions.append(remove);
    }
    actionCell.append(actions);
    row.append(nameCell, element('td', 'size-column', folder ? '—' : bytes(file.size)),
      element('td', 'date-column', formatDate(file.modified)), actionCell);
    rows.append(row);
  }
  $('#file-list').replaceChildren(rows);
  $('#empty-state').hidden = files.length > 0;
  $('#empty-state').textContent = query ? '没有匹配的文件' : '暂无文件';
}

async function copyAddress() {
  const value = $('#address-select').value;
  if (!value) return;
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(value);
    else {
      // Keep the fallback field inside the modal; elements outside it are inert.
      const input = element('textarea', 'sr-only');
      input.value = value;
      $('#share-dialog').append(input);
      input.select();
      const copied = document.execCommand('copy');
      input.remove();
      if (!copied) throw new Error('copy');
    }
    toast('链接已复制');
  } catch { toast('请手动复制：' + value); }
}

function renderUploads() {
  $('#upload-panel').hidden = !state.uploads.length;
  $('#upload-list').replaceChildren();
  for (const item of state.uploads) {
    const row = element('div', 'upload-item');
    const top = element('div', 'upload-top');
    top.append(element('span', 'upload-name', item.name));
    if (['queued', 'uploading'].includes(item.status)) {
      const cancel = element('button', 'text-button', '取消');
      cancel.addEventListener('click', () => {
        item.status = 'cancelled';
        if (item.xhr) item.xhr.abort();
        renderUploads();
      });
      top.append(cancel);
    } else if (['error', 'cancelled'].includes(item.status) && item.file) {
      const retry = element('button', 'text-button', '重试');
      retry.addEventListener('click', () => {
        item.status = 'queued';
        item.progress = 0;
        item.error = '';
        renderUploads();
        runQueue();
      });
      top.append(retry);
    }
    const descriptions = {
      queued: '等待上传', uploading: item.progress >= 100 ? '正在保存…' : '上传中 ' + item.progress + '%',
      done: '已完成', cancelled: '已取消', error: item.error || '上传失败',
    };
    row.append(top, element('div', 'upload-status' + (item.status === 'error' ? ' failed' : ''), descriptions[item.status]));
    if (item.status === 'uploading') {
      const progress = element('progress');
      progress.max = 100;
      progress.value = item.progress;
      progress.setAttribute('aria-label', item.name);
      row.append(progress);
    }
    $('#upload-list').append(row);
  }
}

function queueFiles(fileList) {
  if (!state.info || state.info.readOnly) { toast('仅供下载'); return; }
  let rejected = 0;
  for (const file of fileList) {
    if (file.size > state.info.maxBytes) { rejected++; continue; }
    state.uploads.push({ file, name: file.name, folder: state.path, status: 'queued', progress: 0 });
  }
  if (rejected) toast(String(rejected) + ' 个文件超过 ' + bytes(state.info.maxBytes) + ' 上限');
  renderUploads();
  runQueue();
}

function sendFile(item) {
  return new Promise(resolve => {
    const xhr = new XMLHttpRequest();
    item.xhr = xhr;
    item.status = 'uploading';
    let lastPaint = 0;
    xhr.open('POST', '/api/upload?path=' + encodeURIComponent(item.folder) + '&name=' + encodeURIComponent(item.name));
    xhr.setRequestHeader('X-Landrop-Upload', '1');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = event => {
      if (!event.lengthComputable) return;
      item.progress = Math.round(event.loaded / event.total * 100);
      if (performance.now() - lastPaint > 180 || event.loaded === event.total) {
        renderUploads();
        lastPaint = performance.now();
      }
    };
    xhr.onload = () => {
      let result = {};
      try { result = JSON.parse(xhr.responseText); } catch { /* Use the fallback message. */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        item.status = 'done';
        item.name = result.name || item.name;
        item.file = null;
      } else {
        item.status = 'error';
        item.error = result.error || '上传失败';
        if (xhr.status === 401) showAuth();
      }
    };
    xhr.onerror = () => { item.status = 'error'; item.error = '连接已断开'; };
    xhr.onabort = () => { item.status = 'cancelled'; };
    xhr.onloadend = () => {
      item.xhr = null;
      renderUploads();
      if (item.status === 'done') setTimeout(() => {
        state.uploads = state.uploads.filter(entry => entry !== item);
        renderUploads();
      }, 2000);
      resolve();
    };
    xhr.send(item.file);
    renderUploads();
  });
}

async function runQueue() {
  if (state.uploading) return;
  state.uploading = true;
  try {
    let next;
    while (state.info && (next = state.uploads.find(item => item.status === 'queued'))) {
      await sendFile(next);
      await refresh(true);
    }
  } finally { state.uploading = false; }
}

$('#share-button').addEventListener('click', () => { $('#share-dialog').showModal(); updateAddress(); });
$('#address-select').addEventListener('change', updateAddress);
$('#copy-address').addEventListener('click', copyAddress);
$('#qr-image').addEventListener('error', () => {
  $('#qr-image').hidden = true;
  $('#qr-placeholder').hidden = false;
  $('#qr-placeholder').textContent = '二维码加载失败';
});
document.querySelectorAll('.close-modal').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('close', () => {
  if (dialog.contains($('#toast'))) { $('#toast').hidden = true; document.body.append($('#toast')); }
}));
$('#search').addEventListener('input', renderFiles);
$('#delete-dialog').addEventListener('cancel', event => {
  if (state.deleting) event.preventDefault();
});
$('#delete-dialog').addEventListener('close', () => { state.pendingDelete = null; });
$('#delete-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!state.pendingDelete || state.deleting) return;
  const file = state.pendingDelete;
  const submit = $('#delete-form button[type="submit"]');
  const buttons = [...document.querySelectorAll('#delete-form button')];
  state.deleting = true;
  buttons.forEach(button => { button.disabled = true; });
  submit.textContent = '删除中…';
  $('#delete-error').textContent = '';
  try {
    await api('/api/files', { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: file.path, size: file.size, modified: file.modified, confirmed: true }) });
    $('#delete-dialog').close();
    toast('已删除');
    await refresh();
  } catch (err) { $('#delete-error').textContent = err.message; }
  finally {
    state.deleting = false;
    buttons.forEach(button => { button.disabled = false; });
    submit.textContent = '删除';
  }
});
$('#retry-button').addEventListener('click', () => state.info ? refresh() : init());
$('#upload-button').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', event => { queueFiles(event.target.files); event.target.value = ''; });
$('#clear-uploads').addEventListener('click', () => {
  state.uploads = state.uploads.filter(item => ['queued', 'uploading'].includes(item.status));
  renderUploads();
});
$('#new-folder-button').addEventListener('click', () => {
  $('#folder-name').value = '';
  $('#folder-error').textContent = '';
  $('#folder-dialog').showModal();
});
$('#folder-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#folder-form button[type="submit"]');
  button.disabled = true;
  try {
    await api('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: $('#folder-name').value.trim(), path: state.path }) });
    $('#folder-dialog').close();
    await refresh();
  } catch (err) { $('#folder-error').textContent = err.message; }
  finally { button.disabled = false; }
});
$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#auth-form button[type="submit"]');
  button.disabled = true;
  $('#auth-error').textContent = '';
  try {
    await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: $('#code-input').value }) });
    $('#auth-dialog').close();
    $('#code-input').value = '';
    await loadInfo();
    await refresh();
    runQueue();
  } catch (err) { $('#auth-error').textContent = err.message; }
  finally { button.disabled = false; }
});
$('#auth-dialog').addEventListener('cancel', event => event.preventDefault());
$('#code-input').addEventListener('input', event => { event.target.value = event.target.value.replace(/\D/g, ''); });

let dragDepth = 0;
function resetDrag() {
  dragDepth = 0;
  $('#drop-overlay').hidden = true;
}
document.addEventListener('dragenter', event => {
  if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
  event.preventDefault();
  dragDepth++;
  if (state.info && !state.info.readOnly) $('#drop-overlay').hidden = false;
});
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('#drop-overlay').hidden = true;
});
document.addEventListener('dragover', event => {
  if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = state.info && !state.info.readOnly ? 'copy' : 'none';
});
document.addEventListener('drop', event => {
  if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
  event.preventDefault();
  resetDrag();
  const entries = [...(event.dataTransfer?.items || [])];
  if (entries.some(item => item.webkitGetAsEntry?.()?.isDirectory)) { toast('请上传文件，文件夹需先压缩'); return; }
  if (event.dataTransfer) queueFiles(event.dataTransfer.files);
});
document.addEventListener('dragend', resetDrag);
window.addEventListener('blur', resetDrag);
window.addEventListener('beforeunload', event => {
  if (state.uploads.some(item => ['queued', 'uploading'].includes(item.status))) {
    event.preventDefault();
    event.returnValue = '';
  }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(true); });
setInterval(() => { if (!document.hidden) refresh(true); }, 8000);

async function init() {
  renderBreadcrumbs();
  try {
    const initialCode = new URLSearchParams(location.hash.slice(1)).get('code');
    if (initialCode) history.replaceState(null, '', location.pathname + location.search);
    if (initialCode && /^\d{6}$/.test(initialCode)) {
      try {
        await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: initialCode }) });
      } catch (err) { showAuth(); $('#auth-error').textContent = err.message; return; }
    }
    const session = await api('/api/session');
    if (!session.authenticated) { showAuth(); return; }
    await loadInfo();
    await refresh();
  } catch (err) {
    showError(err.message || '连接已断开');
    $('#empty-state').textContent = '加载失败';
  }
}
init();
