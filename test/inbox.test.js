'use strict';

const assert = require('assert').strict;
const crypto = require('crypto');
const fs = require('fs').promises;
const http = require('http');
const os = require('os');
const path = require('path');
const { setTimeout: delay } = require('timers/promises');
const { createApp, parseArgs } = require('../server');

const local = '127.0.0.1';
const maxBytes = 128 * 1024;
const uploadHeaders = { 'X-Landrop-Upload': '1' };

function openRequest(port, method, route, { hostname = local, headers } = {}) {
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request({ hostname, port, method, path: route, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        try {
          const json = res.headers['content-type']?.includes('application/json')
            ? JSON.parse(body.toString('utf8'))
            : undefined;
          resolve({ status: res.statusCode, headers: res.headers, body, json });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error(`Timed out: ${method} ${route}`)));
  });
  return { request, response };
}

async function start(defaultDirectory) {
  const app = await createApp({ inbox: true, dir: defaultDirectory, host: '0.0.0.0', port: 0, maxBytes });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '0.0.0.0', resolve);
  });
  return app.server;
}

function stop(server) {
  if (server?.listening) return new Promise(resolve => server.close(resolve));
}

function inboxClient(server) {
  const port = server.address().port;

  function call(method, route, { json, bytes, hostname, headers = {} } = {}) {
    const body = json === undefined ? bytes : Buffer.from(JSON.stringify(json));
    const { request, response } = openRequest(port, method, route, {
      hostname,
      headers: {
        ...(json === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(body === undefined ? {} : { 'Content-Length': body.length }),
        ...headers,
      },
    });
    request.end(body);
    return response;
  }

  function upload(dropPath, name, bytes, hostname) {
    return call('POST', apiDrop(dropPath, name), { bytes, hostname, headers: uploadHeaders });
  }

  function pauseUpload(dropPath, name) {
    const { request, response } = openRequest(port, 'POST', apiDrop(dropPath, name), {
      headers: { ...uploadHeaders, 'Content-Length': '65536' },
    });
    const outcome = response.then(result => ({ result }), error => ({ error }));
    request.write(Buffer.alloc(1024, 18));
    return { request, outcome };
  }

  return { call, upload, pauseUpload };
}

function apiDrop(dropPath, name) {
  const query = name === undefined ? '' : `?name=${encodeURIComponent(name)}`;
  return `/api${dropPath}${query}`;
}

async function waitForStaging(destination) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await fs.readdir(destination)).some(name => name.startsWith('.landrop-'))) return;
    await delay(25);
  }
  assert.fail('Upload did not reach staging before close');
}

async function verify(defaultDirectory, destination) {
  assert.deepEqual(parseArgs(['--inbox']), { inbox: true });
  await fs.mkdir(defaultDirectory);
  const hostFile = 'host-notes.txt';
  await fs.writeFile(path.join(defaultDirectory, hostFile), 'host data');
  let server = await start(defaultDirectory);
  try {
    const { call, upload, pauseUpload } = inboxClient(server);
    const initial = await call('GET', '/api/inbox');
    assert.equal(initial.status, 200);
    assert.equal(initial.json.active, false);
    assert.equal(initial.json.destination, defaultDirectory);
    assert.equal((await call('GET', '/')).status, 200);

    const relative = await call('POST', '/api/inbox', { json: { destination: 'relative' } });
    assert.equal(relative.status, 400);
    const created = await call('POST', '/api/inbox', { json: { destination } });
    assert.equal(created.status, 201);
    assert.equal(created.json.active, true);
    assert.equal(created.json.destination, destination);
    assert.deepEqual(created.json.receipts, []);
    const { dropPath, addresses } = created.json;
    assert.match(dropPath, /^\/drop\/[0-9a-f]{48}$/);
    assert.equal((await call('POST', '/api/inbox', { json: { destination } })).status, 409);

    const share = addresses[0];
    const guest = share ? new URL(share.url) : null;
    const hostname = guest?.hostname || local;
    if (share) {
      assert.equal(guest.pathname, dropPath);
      const qr = await call('GET', share.qrUrl);
      assert.equal(qr.status, 200);
      assert.equal(qr.headers['content-type'], 'image/svg+xml');
      assert.match(qr.body.toString('utf8'), /^<svg\b[^>]*\bviewBox=/);
      assert.equal((await call('GET', share.qrUrl, { hostname })).status, 403);
      for (const [method, route] of [
        ['GET', '/'], ['GET', '/api/inbox'], ['POST', '/api/inbox'], ['DELETE', '/api/inbox'],
        ['POST', '/api/inbox/pick-directory'],
      ]) {
        const options = method === 'POST' ? { hostname, json: { destination } } : { hostname };
        assert.equal((await call(method, route, options)).status, 403, `${method} ${route}`);
      }
      const forgedHost = await call('GET', '/api/inbox', {
        hostname,
        headers: { Host: `${local}:${server.address().port}`, 'X-Forwarded-For': local },
      });
      assert.equal(forgedHost.status, 403);
    } else {
      console.log('  SKIP LAN-address and QR smoke checks (no IPv4 adapter)');
    }
    const offsiteQr = '/api/inbox/qr?url=' + encodeURIComponent('https://example.test/drop');
    assert.equal((await call('GET', offsiteQr)).status, 400);
    assert.equal((await call('POST', '/api/inbox', { json: {}, headers: { Origin: 'https://example.test' } })).status, 403);

    const file = '现场照片 (原图).bin';
    const content = crypto.randomBytes(32 * 1024);
    const page = await call('GET', dropPath, { hostname });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    const snapshot = await call('GET', apiDrop(dropPath), { hostname });
    assert.equal(snapshot.status, 200);
    assert.deepEqual(snapshot.json, { maxBytes });
    const submitted = await upload(dropPath, file, content, hostname);
    assert.equal(submitted.status, 201);
    assert.equal(submitted.json.name, file);
    assert.equal(submitted.json.size, content.length);
    assert.deepEqual(await fs.readFile(path.join(destination, file)), content);
    assert.deepEqual(await fs.readdir(defaultDirectory), [hostFile]);
    assert.deepEqual((await call('GET', '/api/inbox')).json.receipts, [submitted.json]);
    assert.deepEqual((await call('GET', apiDrop(dropPath), { hostname })).json, { maxBytes });

    for (const [method, route] of [
      ['GET', '/api/session'], ['POST', '/api/login'], ['GET', '/api/info'],
      ['GET', '/api/files'], ['DELETE', '/api/files'], ['GET', '/api/download?path=' + encodeURIComponent(hostFile)],
      ['POST', '/api/upload?name=legacy.txt'], ['POST', '/api/folders'],
    ]) {
      for (const requestHostname of new Set([hostname, local])) {
        const response = await call(method, route, { hostname: requestHostname });
        assert.equal(response.status, 404, `${method} ${route}`);
      }
    }
    assert.equal((await call('DELETE', apiDrop(dropPath, file), { hostname })).status, 404);
    assert.equal((await call('POST', apiDrop(dropPath, 'marker.bin'), { hostname, bytes: content })).status, 400);
    assert.equal((await upload(dropPath, '../outside.bin', content, hostname)).status, 400);
    assert.equal((await upload(dropPath, 'large.bin', Buffer.alloc(maxBytes + 1), hostname)).status, 413);
    assert.deepEqual(await fs.readdir(destination), [file]);

    const duplicates = [Buffer.from('second photo'), Buffer.from('third photo')];
    const duplicateResults = await Promise.all(duplicates.map(bytes => upload(dropPath, file, bytes, hostname)));
    assert(duplicateResults.every(result => result.status === 201));
    assert.deepEqual(new Set(duplicateResults.map(result => result.json.name)), new Set(['现场照片 (原图) (1).bin', '现场照片 (原图) (2).bin']));
    for (const [index, result] of duplicateResults.entries()) {
      assert.deepEqual(await fs.readFile(path.join(destination, result.json.name)), duplicates[index]);
    }
    assert.deepEqual(await fs.readFile(path.join(destination, file)), content);
    const saved = [file, ...duplicateResults.map(result => result.json.name)].sort();
    assert.deepEqual((await fs.readdir(destination)).sort(), saved);

    const paused = pauseUpload(dropPath, 'unfinished.bin');
    try {
      await waitForStaging(destination);
      const closed = await call('DELETE', '/api/inbox');
      assert.equal(closed.status, 200);
      assert.equal(closed.json.active, false);
      assert.equal(closed.json.receipts.length, 3);
      assert.equal((await call('GET', apiDrop(dropPath), { hostname })).status, 410);
      assert.equal((await upload(dropPath, 'late.bin', content, hostname)).status, 410);
      const { result, error } = await paused.outcome;
      if (result) assert.equal(result.status, 410);
      else assert.equal(error.code, 'ECONNRESET');
      assert.deepEqual((await fs.readdir(destination)).sort(), saved);
    } finally {
      paused.request.destroy();
    }

    const reopened = await call('POST', '/api/inbox', { json: {} });
    assert.equal(reopened.status, 201);
    assert.equal(reopened.json.destination, destination);
    assert.notEqual(reopened.json.sessionId, created.json.sessionId);
    assert.notEqual(reopened.json.dropPath, dropPath);
    assert.deepEqual(reopened.json.receipts, []);
    assert.equal((await upload(dropPath, 'stale.bin', content, hostname)).status, 410);
    assert.equal((await call('GET', apiDrop(reopened.json.dropPath), { hostname })).status, 200);
    if (share) assert.equal((await call('GET', share.qrUrl)).status, 400);

    await stop(server);
    server = await start(defaultDirectory);
    const next = inboxClient(server);
    const reset = await next.call('GET', '/api/inbox');
    assert.equal(reset.json.active, false);
    assert.deepEqual(reset.json.receipts, []);
    assert.equal((await next.upload(reopened.json.dropPath, 'after-restart.bin', content)).status, 410);
    console.log('  PASS Inbox lifecycle, LAN access, exact uploads, permissions, duplicates, and revocation');
  } finally {
    await stop(server);
  }
}

async function run() {
  const tempRoot = await fs.realpath(os.tmpdir());
  const temp = await fs.mkdtemp(path.join(tempRoot, 'lan-drop-inbox-test-'));
  try {
    await verify(path.join(temp, 'default'), path.join(temp, 'submissions'));
  } finally {
    if (path.dirname(path.resolve(temp)) === tempRoot && path.basename(temp).startsWith('lan-drop-inbox-test-')) {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
