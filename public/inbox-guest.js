'use strict';

const $ = id => document.getElementById(id);
const endpoint = '/api' + window.location.pathname;
const chooseButton = $('choose-files');
const fileInput = $('file-input');
const uploadList = $('upload-list');
const guestStatus = $('guest-status');
const uploadAnnouncement = $('upload-announcement');
const sizeFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
const entries = [];

let maxBytes = null;
let connection = 'checking';
let checking = false;
let uploading = false;

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = bytes > 0 ? Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1) : 0;
  return `${sizeFormat.format(bytes / 1024 ** index)} ${units[index]}`;
}

function setText(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

function renderControls() {
  const canUpload = connection === 'ready' && !uploading;
  $('guest-controls').hidden = connection !== 'ready';
  chooseButton.disabled = !canUpload;
  uploadList.hidden = entries.length === 0;

  for (const entry of entries) {
    entry.retry.hidden = entry.state !== 'error' || connection === 'ended';
    entry.retry.disabled = !canUpload;
  }
}

function setStatus(next, message) {
  connection = next;
  guestStatus.hidden = next === 'ready';
  guestStatus.classList.toggle('error', next === 'offline');
  setText(guestStatus, message);

  if (next === 'ended') {
    for (const entry of entries) {
      if (entry.state === 'pending') setEntryState(entry, 'invalid', '投递已结束');
    }
  }

  renderControls();
}

async function checkLink() {
  if (checking || uploading || connection === 'ended') return;
  checking = true;
  try {
    const response = await fetch(endpoint, { cache: 'no-store' });
    if (response.status === 404 || response.status === 410) {
      setStatus('ended', '投递链接已失效，请向主办方索取新链接。');
      return;
    }
    if (!response.ok) throw new Error('无法获取投递状态');
    const payload = await response.json();
    if (uploading || connection === 'ended') return;
    maxBytes = payload.maxBytes;
    setText($('guest-limit'), `单个文件最多 ${formatSize(maxBytes)}`);
    setStatus('ready', '');
  } catch {
    if (!uploading && connection !== 'ended') {
      setStatus('offline', '暂时连不到主办方电脑，请确认设备在同一网络。');
    }
  } finally {
    checking = false;
  }
}

function setEntryState(entry, state, message) {
  entry.state = state;
  entry.meta.dataset.state = state === 'invalid' ? 'error' : state;
  setText(entry.meta, message);
  entry.progress.hidden = state !== 'uploading';
}

function addFile(file) {
  const row = document.createElement('li');
  row.className = 'file-row';

  const details = document.createElement('div');
  details.className = 'file-text';
  const name = document.createElement('p');
  name.className = 'file-name';
  name.textContent = file.name;
  const meta = document.createElement('p');
  meta.className = 'file-meta';
  const progress = document.createElement('progress');
  progress.max = 100;
  progress.setAttribute('aria-label', `${file.name} 上传进度`);
  details.append(name, meta, progress);

  const actions = document.createElement('div');
  actions.className = 'upload-row-actions';
  const retry = document.createElement('button');
  retry.className = 'button';
  retry.type = 'button';
  retry.textContent = '重试';
  retry.setAttribute('aria-label', `重试上传 ${file.name}`);
  actions.append(retry);

  const entry = { file, name, meta, progress, retry, state: '' };
  if (file.size > maxBytes) setEntryState(entry, 'invalid', '超过单个文件大小上限');
  else setEntryState(entry, 'pending', '等待上传');
  entries.push(entry);
  row.append(details, actions);
  uploadList.append(row);
  retry.addEventListener('click', () => uploadBatch([entry]));
  return entry;
}

function sendFile(entry) {
  return new Promise(resolve => {
    const request = new XMLHttpRequest();
    const query = new URLSearchParams({ name: entry.file.name });
    request.open('POST', `${endpoint}?${query}`);
    request.setRequestHeader('X-Landrop-Upload', '1');
    request.responseType = 'json';
    request.upload.addEventListener('progress', event => {
      if (!event.lengthComputable || !event.total) return;
      const percent = Math.floor(event.loaded / event.total * 100);
      entry.progress.value = percent;
      entry.meta.textContent = percent < 100 ? `上传中 ${percent}%` : '正在确认收件…';
    });
    request.upload.addEventListener('load', () => setText(entry.meta, '正在确认收件…'));
    request.addEventListener('loadend', () => resolve({ status: request.status, body: request.response }));
    request.send(entry.file);
  });
}

function announceResults(batch) {
  const received = batch.filter(entry => entry.state === 'success').length;
  const failed = batch.length - received;
  const summary = received ? `主办方已收到 ${received} 个文件。` : '';
  setText(uploadAnnouncement, `${summary}${failed ? `${failed} 个文件未完成，请查看上传记录。` : ''}`);
}

async function uploadBatch(batch) {
  if (uploading || connection !== 'ready') return;
  uploading = true;
  setText(uploadAnnouncement, '');
  renderControls();

  try {
    for (const entry of batch) {
      if (connection === 'ended') break;
      if (entry.state === 'invalid') continue;
      setEntryState(entry, 'uploading', '正在上传…');
      entry.progress.removeAttribute('value');
      entry.retry.hidden = true;

      const { status, body } = await sendFile(entry).catch(() => ({ status: 0 }));
      if (status === 201 && typeof body?.name === 'string') {
        entry.name.textContent = body.name;
        setEntryState(entry, 'success', '主办方已收到');
        continue;
      }

      if (status === 404 || status === 410) {
        setEntryState(entry, 'invalid', '投递已结束');
        setStatus('ended', '投递链接已失效，请向主办方索取新链接。');
        break;
      }
      if (status === 0 || status === 201) {
        setEntryState(entry, 'error', '无法确认是否收到，请先向主办方核对。');
        break;
      }
      setEntryState(entry, 'error', body?.error || '上传失败，请重试。');
    }
  } finally {
    uploading = false;
    for (const entry of batch) {
      if (entry.state === 'pending') setEntryState(entry, 'error', '尚未上传，请重试。');
    }
    announceResults(batch);
    renderControls();
    checkLink();
  }
}

chooseButton.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const files = Array.from(fileInput.files);
  fileInput.value = '';
  if (connection === 'ended' || maxBytes === null || uploading || !files.length) return;
  const batch = files.map(addFile);
  if (connection === 'ready') {
    uploadBatch(batch);
    return;
  }

  for (const entry of batch) {
    if (entry.state === 'pending') setEntryState(entry, 'error', '尚未上传，请在恢复连接后重试。');
  }
  announceResults(batch);
  renderControls();
});

checkLink();
setInterval(checkLink, 4000);
