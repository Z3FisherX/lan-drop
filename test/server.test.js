'use strict';

const assert = require('assert').strict;
const http = require('http');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { createApp, parseArgs } = require('../server');

let app;
let cookie = '';
let temp;
let passed = 0;

function request(method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ hostname: '127.0.0.1', port: app.server.address().port, method, path: route,
      headers: { Connection: 'keep-alive', ...(cookie ? { Cookie: cookie } : {}), ...(data ? { 'Content-Length': data.length } : {}), ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        let json;
        try { json = JSON.parse(buffer.toString('utf8')); } catch { /* Binary/static response. */ }
        resolve({ status: res.statusCode, headers: res.headers, body: buffer, json });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  PASS ${name}`);
}

async function start(options) {
  app = await createApp({ dir: path.join(temp, 'share'), port: 0, host: '127.0.0.1', code: '123456', ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  cookie = '';
}

async function stop() {
  if (app?.server.listening) await new Promise(resolve => app.server.close(resolve));
}

async function run() {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lan-drop-test-'));
  await start({ maxBytes: 3 * 1024 * 1024 });
  await test('CLI flags and invalid arguments', async () => {
    assert.deepEqual(parseArgs(['--public-read', '--port', '9001']), { publicRead: true, port: '9001' });
    assert.deepEqual(parseArgs(['--public']), { public: true });
    assert.throws(() => parseArgs(['--dir']));
    assert.throws(() => parseArgs(['--unknown']));
  });
  await test('Static UI works; private files require a code', async () => {
    assert.equal((await request('GET', '/')).status, 200);
    assert.equal((await request('GET', '/style.css')).status, 200);
    assert.equal((await request('GET', '/api/files')).status, 401);
    assert.equal((await request('DELETE', '/api/files', { path: 'file.txt', confirmed: true }, { 'Content-Type': 'application/json' })).status, 401);
    assert.deepEqual((await request('GET', '/api/session')).json, { authenticated: false });
  });
  await test('Code validation handles bad JSON, Unicode and wrong codes', async () => {
    assert.equal((await request('POST', '/api/login', 'no', { 'Content-Type': 'application/json' })).status, 400);
    for (const code of ['000000', '中文中文中文']) assert.equal((await request('POST', '/api/login', { code }, { 'Content-Type': 'application/json' })).status, 401);
    const result = await request('POST', '/api/login', { code: '123456' }, { 'Content-Type': 'application/json' });
    assert.equal(result.status, 200);
    cookie = result.headers['set-cookie'][0].split(';')[0];
    assert(result.headers['set-cookie'][0].includes('HttpOnly'));
  });
  await test('Unsafe Host and cross-origin requests are rejected', async () => {
    assert.equal((await request('GET', '/api/files', undefined, { Host: 'evil.example' })).status, 403);
    assert.equal((await request('GET', '/api/files', undefined, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await request('GET', '/api/files', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  });
  await test('Folder creation and duplicate checks', async () => {
    assert.equal((await request('POST', '/api/folders', { name: '资料', path: '' }, { 'Content-Type': 'application/json' })).status, 201);
    assert.equal((await request('POST', '/api/folders', { name: '资料', path: '' }, { 'Content-Type': 'application/json' })).status, 409);
  });
  const contents = crypto.randomBytes(2 * 1024 * 1024);
  const filename = '安装包 (测试).exe';
  const route = '/api/upload?path=' + encodeURIComponent('资料') + '&name=' + encodeURIComponent(filename);
  await test('Streaming upload and download preserve binary SHA-256', async () => {
    const upload = await request('POST', route, contents, { 'X-Landrop-Upload': '1' });
    assert.equal(upload.status, 201);
    const downloaded = await request('GET', '/api/download?path=' + encodeURIComponent('资料/' + filename));
    assert.equal(downloaded.status, 200);
    assert.equal(crypto.createHash('sha256').update(downloaded.body).digest('hex'), crypto.createHash('sha256').update(contents).digest('hex'));
    assert(downloaded.headers['content-disposition'].includes("filename*=UTF-8''"));
  });
  await test('Concurrent duplicate uploads do not overwrite files', async () => {
    const results = await Promise.all([request('POST', route, 'second', { 'X-Landrop-Upload': '1' }), request('POST', route, 'third', { 'X-Landrop-Upload': '1' })]);
    assert(results.every(result => result.status === 201));
    assert.equal(new Set(results.map(result => result.json.name)).size, 2);
    assert.deepEqual(await fs.readFile(path.join(app.root, '资料', filename)), contents);
  });
  await test('Range downloads, HEAD and invalid ranges', async () => {
    const file = '/api/download?path=' + encodeURIComponent('资料/' + filename);
    const range = await request('GET', file, undefined, { Range: 'bytes=10-99' });
    assert.equal(range.status, 206);
    assert.deepEqual(range.body, contents.subarray(10, 100));
    const suffix = await request('GET', file, undefined, { Range: 'bytes=-16' });
    assert.deepEqual(suffix.body, contents.subarray(contents.length - 16));
    const head = await request('HEAD', file);
    assert.equal(Number(head.headers['content-length']), contents.length);
    assert.equal(head.body.length, 0);
    assert.equal((await request('GET', file, undefined, { Range: 'bytes=999999999-' })).status, 416);
  });
  await test('Traversal, hidden paths and Windows reserved names are rejected', async () => {
    for (const value of ['../outside', '/etc', '资料/../outside', 'C:\\Windows', '.secret', 'CON', 'data:stream', '资料\\test', 'trailing.']) {
      assert.equal((await request('GET', '/api/files?path=' + encodeURIComponent(value))).status, 400, value);
    }
    assert.equal((await request('POST', '/api/folders', { name: {} }, { 'Content-Type': 'application/json' })).status, 400);
  });
  await test('External directory junctions are neither listed nor traversed', async () => {
    const outside = path.join(temp, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'secret.txt'), 'private');
    await fs.symlink(outside, path.join(app.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await request('GET', '/api/files?path=linked')).status, 403);
    assert(!(await request('GET', '/api/files')).json.files.some(file => file.name === 'linked'));
  });
  await test('Size limits and missing upload marker are enforced', async () => {
    assert.equal((await request('POST', '/api/upload?name=large.bin', Buffer.alloc(4 * 1024 * 1024), { 'X-Landrop-Upload': '1' })).status, 413);
    assert.equal((await request('POST', '/api/upload?name=bad.bin', 'x')).status, 400);
  });
  await test('Empty files upload/download correctly; staging files are hidden', async () => {
    assert.equal((await request('POST', '/api/upload?name=empty.txt', Buffer.alloc(0), { 'X-Landrop-Upload': '1' })).status, 201);
    const empty = await request('GET', '/api/download?path=empty.txt');
    assert.equal(empty.status, 200);
    assert.equal(empty.body.length, 0);
    assert(!(await fs.readdir(app.root)).some(name => name.startsWith('.landrop-')));
  });
  await test('Interrupted uploads are removed and never published', async () => {
    await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: app.server.address().port, method: 'POST', path: '/api/upload?name=interrupted.bin', headers: { Cookie: cookie, 'X-Landrop-Upload': '1', 'Content-Length': '1000000' } });
      req.on('error', err => { if (err.code !== 'ECONNRESET') reject(err); });
      req.write(Buffer.alloc(10000));
      setTimeout(() => { req.destroy(); resolve(); }, 100);
    });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert(!(await fs.readdir(app.root)).some(name => name === 'interrupted.bin' || name.startsWith('.landrop-')));
  });
  await test('Deletion requires confirmation and removes only the selected file', async () => {
    const upload = await request('POST', '/api/upload?path=' + encodeURIComponent('资料') + '&name=' + encodeURIComponent('待删除.txt'), 'delete fixture', { 'X-Landrop-Upload': '1' });
    assert.equal(upload.status, 201);
    const listed = (await request('GET', '/api/files?path=' + encodeURIComponent('资料'))).json.files.find(file => file.name === '待删除.txt');
    const headers = { 'Content-Type': 'application/json' };
    assert.equal((await request('DELETE', '/api/files', listed, headers)).status, 400);
    assert.equal((await request('GET', '/api/download?path=' + encodeURIComponent(listed.path))).status, 200);
    assert.equal((await request('DELETE', '/api/files', { ...listed, confirmed: true }, headers)).status, 200);
    assert.equal((await request('GET', '/api/download?path=' + encodeURIComponent(listed.path))).status, 404);
    assert.equal((await request('DELETE', '/api/files', { ...listed, confirmed: true }, headers)).status, 404);
    assert.deepEqual(await fs.readFile(path.join(app.root, '资料', filename)), contents);
  });
  await test('Stale deletion requests cannot remove a changed file', async () => {
    await request('POST', '/api/upload?name=changed.txt', 'old', { 'X-Landrop-Upload': '1' });
    const listed = (await request('GET', '/api/files')).json.files.find(file => file.name === 'changed.txt');
    await fs.writeFile(path.join(app.root, 'changed.txt'), 'new and longer contents');
    assert.equal((await request('DELETE', '/api/files', { ...listed, confirmed: true }, { 'Content-Type': 'application/json' })).status, 409);
    assert.equal(await fs.readFile(path.join(app.root, 'changed.txt'), 'utf8'), 'new and longer contents');
  });
  await test('Deletion rejects folders, outside paths and cross-origin requests', async () => {
    const headers = { 'Content-Type': 'application/json' };
    const payload = { confirmed: true, size: 0, modified: new Date().toISOString() };
    for (const target of ['', '..', '../outside/secret.txt', '.secret', '资料']) {
      assert.equal((await request('DELETE', '/api/files', { ...payload, path: target }, headers)).status, 400, target);
    }
    assert.equal((await request('DELETE', '/api/files', { ...payload, path: 'linked/secret.txt' }, headers)).status, 403);
    assert.equal(await fs.readFile(path.join(temp, 'outside', 'secret.txt'), 'utf8'), 'private');
    assert.equal((await request('DELETE', '/api/files', { ...payload, path: 'empty.txt' }, { ...headers, Origin: 'https://evil.example' })).status, 403);
    assert.equal((await request('GET', '/api/download?path=empty.txt')).status, 200);
  });
  await test('Logout revokes the session', async () => {
    assert.equal((await request('POST', '/api/logout')).status, 200);
    assert.equal((await request('GET', '/api/files')).status, 401);
  });
  await stop();
  await start({ publicRead: true });
  await test('Public download mode works without cookies and blocks all writes', async () => {
    assert.equal((await request('GET', '/api/session')).json.authenticated, true);
    const info = (await request('GET', '/api/info')).json;
    assert.equal(info.publicRead, true);
    assert.equal(info.readOnly, true);
    assert.equal(info.code, null);
    assert.equal((await request('GET', '/api/files')).status, 200);
    assert.equal((await request('GET', '/api/download?path=empty.txt')).status, 200);
    assert.equal((await request('POST', '/api/upload?name=denied.txt', 'x', { 'X-Landrop-Upload': '1' })).status, 403);
    assert.equal((await request('POST', '/api/folders', { name: 'denied' }, { 'Content-Type': 'application/json' })).status, 403);
    assert.equal((await request('DELETE', '/api/files', { path: 'empty.txt', confirmed: true }, { 'Content-Type': 'application/json' })).status, 403);
  });
  await stop();
  await start({ public: true, maxBytes: 1024 });
  await test('Public sharing accepts anonymous uploads and preserves existing files', async () => {
    const info = (await request('GET', '/api/info')).json;
    assert.equal(info.publicAccess, true);
    assert.equal(info.publicRead, false);
    assert.equal(info.readOnly, false);
    assert.equal(info.code, null);
    const body = Buffer.from('public upload round trip');
    const uploaded = await request('POST', '/api/upload?name=public.txt', body, { 'X-Landrop-Upload': '1' });
    assert.equal(uploaded.status, 201);
    assert.deepEqual((await request('GET', '/api/download?path=public.txt')).body, body);
    const duplicate = await request('POST', '/api/upload?name=public.txt', 'another file', { 'X-Landrop-Upload': '1' });
    assert.equal(duplicate.status, 201);
    assert.equal(duplicate.json.name, 'public (1).txt');
    assert.deepEqual((await request('GET', '/api/download?path=public.txt')).body, body);
  });
  await test('Public upload retains size, path and cross-origin restrictions', async () => {
    assert.equal((await request('POST', '/api/upload?name=too-big.bin', Buffer.alloc(2048), { 'X-Landrop-Upload': '1' })).status, 413);
    assert.equal((await request('POST', '/api/upload?name=../outside.txt', 'x', { 'X-Landrop-Upload': '1' })).status, 400);
    assert.equal((await request('POST', '/api/upload?name=cross-origin.txt', 'x', { 'X-Landrop-Upload': '1', Origin: 'https://evil.example' })).status, 403);
    assert.equal((await request('POST', '/api/upload?name=missing-marker.txt', 'x')).status, 400);
  });
  await test('Public writable mode supports confirmed deletion without a cookie', async () => {
    const listed = (await request('GET', '/api/files')).json.files.find(file => file.name === 'public (1).txt');
    assert.equal((await request('DELETE', '/api/files', { ...listed, confirmed: true }, { 'Content-Type': 'application/json' })).status, 200);
    assert.equal((await request('GET', '/api/download?path=' + encodeURIComponent(listed.path))).status, 404);
    assert.equal((await request('GET', '/api/download?path=public.txt')).status, 200);
  });
  await stop();
  await start({ public: true, readOnly: true });
  await test('An explicit read-only flag still disables public uploads', async () => {
    assert.equal((await request('GET', '/api/files')).status, 200);
    assert.equal((await request('POST', '/api/upload?name=denied.txt', 'x', { 'X-Landrop-Upload': '1' })).status, 403);
    assert.equal((await request('DELETE', '/api/files', { path: 'empty.txt', confirmed: true }, { 'Content-Type': 'application/json' })).status, 403);
  });
  await stop();
  await start({ readOnly: true });
  await test('Protected read-only mode still requires authentication', async () => {
    assert.equal((await request('GET', '/api/files')).status, 401);
    const login = await request('POST', '/api/login', { code: '123456' }, { 'Content-Type': 'application/json' });
    cookie = login.headers['set-cookie'][0].split(';')[0];
    assert.equal((await request('GET', '/api/files')).status, 200);
    assert.equal((await request('POST', '/api/upload?name=denied.txt', 'x', { 'X-Landrop-Upload': '1' })).status, 403);
    assert.equal((await request('DELETE', '/api/files', { path: 'empty.txt', confirmed: true }, { 'Content-Type': 'application/json' })).status, 403);
  });
  console.log(`\n  ${passed} integration checks passed.\n`);
}

run().catch(err => { console.error(err); process.exitCode = 1; }).finally(async () => {
  await stop();
  // Only remove the uniquely created test workspace under the OS temp directory.
  if (temp && path.dirname(path.resolve(temp)).toLowerCase() === path.resolve(os.tmpdir()).toLowerCase() && path.basename(temp).startsWith('lan-drop-test-')) {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
