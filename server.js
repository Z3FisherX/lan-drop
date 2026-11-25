'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const QRCode = require('qrcode');

const PUBLIC = path.join(__dirname, 'public');
const SESSION_TTL = 12 * 60 * 60 * 1000;
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
const INBOX_STATIC = {
  '/inbox-host.js': ['inbox-host.js', 'text/javascript; charset=utf-8'],
  '/inbox-guest.js': ['inbox-guest.js', 'text/javascript; charset=utf-8'],
  '/inbox.css': ['inbox.css', 'text/css; charset=utf-8'],
  '/favicon.svg': STATIC['/favicon.svg'],
};

function error(status, message) {
  return Object.assign(new Error(message), { status });
}

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--inbox') options.inbox = true;
    else if (arg === '--read-only') options.readOnly = true;
    else if (arg === '--public-read') options.publicRead = true;
    else if (arg === '--public') options.public = true;
    else if (['--dir', '--host', '--port', '--code', '--max-size'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw error(400, `${arg} 缺少参数`);
      options[{ '--dir': 'dir', '--host': 'host', '--port': 'port', '--code': 'code', '--max-size': 'maxSize' }[arg]] = value;
    } else throw error(400, `未知参数：${arg}`);
  }
  return options;
}

function validateSegment(name) {
  if (typeof name !== 'string' || !name || name.startsWith('.') || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[ .]$/.test(name) ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name) || Buffer.byteLength(name) > 240) {
    throw error(400, '文件名不能以点开头，也不能包含系统保留字符或名称');
  }
  return name;
}

function splitPath(value = '') {
  if (typeof value !== 'string' || value.length > 2048) throw error(400, '路径过长');
  if (!value) return [];
  return value.split('/').map(validateSegment);
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function readJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw error(415, '需要 JSON 请求');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw error(413, '请求内容过大');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw error(400, '请求格式不正确'); }
}

function localAddresses() {
  const addresses = [];
  for (const [name, interfaces] of Object.entries(os.networkInterfaces())) {
    for (const item of interfaces || []) {
      if ((item.family === 'IPv4' || item.family === 4) && !item.internal) {
        addresses.push({ name, address: item.address });
      }
    }
  }
  const rank = item => Number(/virtual|vmware|vethernet|wsl|vpn|docker|meta|tun|tailscale/i.test(item.name)) * 2 +
    Number(!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address));
  return addresses.sort((a, b) => rank(a) - rank(b));
}

async function serveStatic(req, res, [file, type]) {
  const data = await fsp.readFile(path.join(PUBLIC, file));
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length });
  res.end(req.method === 'HEAD' ? undefined : data);
}

async function prepareDirectory(directory) {
  try { await fsp.mkdir(directory, { recursive: true }); }
  catch (err) {
    if (err.code === 'EEXIST' || err.code === 'ENOTDIR') throw error(400, '请选择文件夹');
    throw err;
  }
  const real = await fsp.realpath(directory);
  if (!(await fsp.stat(real)).isDirectory()) throw error(400, '请选择文件夹');
  return real;
}

async function sendQr(res, value) {
  const svg = await QRCode.toString(value, { type: 'svg', margin: 2, width: 200, color: { dark: '#244c40', light: '#ffffff' } });
  res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
  res.end(svg);
}

async function createApp(options = {}) {
  const inboxMode = Boolean(options.inbox);
  const port = options.port === undefined ? 38471 : Number(options.port);
  const host = options.host || '0.0.0.0';
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw error(400, '端口必须为 0–65535 的整数');
  if (host !== '0.0.0.0' && host !== '127.0.0.1' && !localAddresses().some(a => a.address === host)) {
    throw error(400, '--host 必须是本机 IPv4 地址或 0.0.0.0');
  }
  if (inboxMode && host !== '0.0.0.0' && host !== '127.0.0.1') {
    throw error(400, '收件模式需要同时访问本机控制台，请使用 --host 0.0.0.0 或 127.0.0.1');
  }
  if (inboxMode && (options.public || options.publicRead || options.readOnly || options.code)) {
    throw error(400, '收件模式使用独立的投递链接，不能同时设置旧版共享模式或连接码');
  }
  const maxBytes = options.maxBytes === undefined ? Number(options.maxSize || 10) * 1024 ** 3 : options.maxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw error(400, '--max-size 必须是有效的 GB 大小');
  const code = inboxMode ? null : String(options.code || crypto.randomInt(100000, 1000000));
  if (!inboxMode && !/^\d{6}$/.test(code)) throw error(400, '连接码必须是 6 位数字');
  const shared = path.join(__dirname, 'shared');
  const requestedRoot = path.resolve(options.dir || (inboxMode ? path.join(shared, 'inbox') : shared));
  const root = inboxMode ? requestedRoot : await prepareDirectory(requestedRoot);
  const publicAccess = Boolean(options.public || options.publicRead);
  const readOnly = Boolean(options.readOnly || options.publicRead);
  const publicRead = publicAccess && readOnly;
  const sessions = new Map();
  const attempts = new Map();
  const activeUploads = new Set();
  const stagingDirectories = new Set();
  let revision = Date.now();
  let inboxSession;
  let openingInbox = false;

  // Validate every component, including junctions / symlinks, before exposing a file.
  async function resolveSafe(relative, directory = false, sharedRoot = root) {
    const parts = splitPath(relative);
    let resolved = sharedRoot;
    for (const part of parts) {
      resolved = path.join(resolved, part);
      const stat = await fsp.lstat(resolved);
      if (stat.isSymbolicLink()) throw error(403, '不共享符号链接或目录联接');
    }
    const real = await fsp.realpath(resolved);
    const diff = path.relative(sharedRoot, real);
    if (diff.startsWith('..' + path.sep) || diff === '..' || path.isAbsolute(diff)) throw error(403, '路径超出共享目录');
    const stat = await fsp.stat(real);
    if (directory && !stat.isDirectory()) throw error(400, '请选择文件夹');
    return { absolute: real, stat };
  }

  function getSession(req) {
    if (publicAccess) return { public: true };
    const match = (req.headers.cookie || '').match(/(?:^|;\s*)landrop_session=([a-f0-9]{64})(?:;|$)/);
    const session = match && sessions.get(match[1]);
    if (!session || Date.now() - session.created > SESSION_TTL) return null;
    return session;
  }

  function checkRequest(req) {
    const actualPort = server.address().port;
    const allowed = new Set(['localhost', '127.0.0.1', os.hostname().toLowerCase(), ...localAddresses().map(a => a.address)]);
    let parsed;
    try { parsed = new URL(`http://${req.headers.host}`); } catch { throw error(403, '无效的访问地址'); }
    if (parsed.username || parsed.password || !allowed.has(parsed.hostname.toLowerCase()) ||
        Number(parsed.port || 80) !== actualPort || parsed.pathname !== '/') throw error(403, '请使用本机或局域网地址访问');
    if (req.headers.origin && req.headers.origin !== parsed.origin) throw error(403, '不允许跨站请求');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw error(403, '不允许跨站请求');
    return parsed.origin;
  }

  function checkInboxHost(req) {
    const loopbackHost = /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(req.headers.host || '');
    if (req.socket.remoteAddress !== '127.0.0.1' || !loopbackHost) {
      throw error(403, '收件控制台仅可在收件电脑上打开');
    }
  }

  function inboxState() {
    const active = Boolean(inboxSession && !inboxSession.controller.signal.aborted);
    const dropPath = active ? `/drop/${inboxSession.token}` : null;
    const addresses = active && host !== '127.0.0.1' ? localAddresses().map(address => {
      const url = `http://${address.address}:${server.address().port}${dropPath}`;
      return { label: address.name, url, qrUrl: '/api/inbox/qr?url=' + encodeURIComponent(url) };
    }) : [];
    return {
      active, dropPath, addresses, maxBytes,
      canPickDirectory: process.platform === 'win32',
      destination: inboxSession?.destination || root,
      sessionId: inboxSession?.id || null,
      startedAt: inboxSession?.startedAt || null,
      receipts: inboxSession ? [...inboxSession.receipts].reverse() : [],
    };
  }

  async function openInbox(req, res) {
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw error(400, '请选择收件文件夹');
    if (openingInbox || inboxSession?.closing || (inboxSession && !inboxSession.controller.signal.aborted)) {
      throw error(409, '已有收件正在进行，请先结束当前收件');
    }
    const requested = body.destination === undefined || body.destination === '' ? inboxSession?.destination || root : body.destination;
    if (typeof requested !== 'string' || !path.isAbsolute(requested) || /\0/.test(requested) ||
        (process.platform === 'win32' && path.parse(requested).root.length < 2)) {
      throw error(400, '请输入收件文件夹的绝对路径');
    }
    openingInbox = true;
    try {
      let destination;
      try {
        destination = await prepareDirectory(path.resolve(requested));
        await fsp.access(destination, fs.constants.W_OK);
      } catch (err) {
        if (err.code === 'EACCES' || err.code === 'EPERM') throw error(403, '无法写入所选文件夹，请换一个文件夹');
        if (['EINVAL', 'ENOENT', 'ENAMETOOLONG'].includes(err.code)) throw error(400, '无法使用所选路径，请检查后重试');
        throw err;
      }
      inboxSession = {
        controller: new AbortController(), destination,
        id: crypto.randomBytes(8).toString('hex'),
        token: crypto.randomBytes(24).toString('hex'),
        startedAt: new Date().toISOString(),
        receipts: [], uploads: new Set(), closing: null,
      };
      json(res, 201, inboxState());
    } finally {
      openingInbox = false;
    }
  }

  async function closeInbox() {
    if (openingInbox) throw error(409, '正在开启收件，请稍后重试');
    const session = inboxSession;
    if (!session) return;
    if (session.closing) { await session.closing; return; }
    if (session.controller.signal.aborted) return;
    session.controller.abort();
    // The link is inactive now. Wait for temporary files to be removed before acknowledging close.
    session.closing = Promise.allSettled([...session.uploads]);
    try { await session.closing; }
    finally { session.closing = null; }
  }

  async function routeInbox(req, res, url) {
    const route = url.pathname;
    if (route === '/' || route === '/inbox-host.js' || route === '/api/inbox' || route.startsWith('/api/inbox/')) {
      checkInboxHost(req);
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (route === '/') return serveStatic(req, res, ['inbox-host.html', 'text/html; charset=utf-8']);
      if (/^\/drop\/[a-f0-9]{48}$/.test(route)) return serveStatic(req, res, ['inbox-guest.html', 'text/html; charset=utf-8']);
      if (INBOX_STATIC[route]) return serveStatic(req, res, INBOX_STATIC[route]);
    }
    if (route === '/api/inbox') {
      if (req.method === 'GET') { json(res, 200, inboxState()); return; }
      if (req.method === 'POST') return openInbox(req, res);
      if (req.method === 'DELETE') { await closeInbox(); json(res, 200, inboxState()); return; }
    }
    if (route === '/api/inbox/qr' && req.method === 'GET') {
      const value = url.searchParams.get('url');
      if (!inboxState().addresses.some(address => address.url === value)) throw error(400, '请选择有效的投递地址');
      return sendQr(res, value);
    }
    if (route === '/api/inbox/pick-directory' && req.method === 'POST') {
      if (openingInbox || inboxState().active || inboxSession?.closing) throw error(409, '请在开启收件前选择文件夹');
      const { chooseDirectory } = require('./lib/choose-directory');
      json(res, 200, { destination: await chooseDirectory(inboxSession?.destination || root) });
      return;
    }
    const guest = /^\/api\/drop\/([a-f0-9]{48})$/.exec(route);
    if (guest && (req.method === 'GET' || req.method === 'POST')) {
      const session = inboxSession;
      if (!session || session.controller.signal.aborted || session.token !== guest[1]) throw error(410, '此收件链接已关闭');
      if (req.method === 'GET') { json(res, 200, { maxBytes }); return; }
      const pending = upload(req, res, url, session);
      session.uploads.add(pending);
      try { await pending; }
      finally { session.uploads.delete(pending); }
      return;
    }
    throw error(404, '没有找到这个页面');
  }

  async function upload(req, res, url, inbox) {
    if (readOnly) throw error(403, '当前共享为只读模式');
    if (req.headers['x-landrop-upload'] !== '1') throw error(400, '上传请求不正确');
    const filename = validateSegment(url.searchParams.get('name') || '');
    const folder = inbox ? '' : url.searchParams.get('path') || '';
    const parent = await resolveSafe(folder, true, inbox?.destination);
    const signal = inbox?.controller.signal;
    if (signal?.aborted) throw error(410, '此收件链接已关闭');
    if (activeUploads.size >= 4) throw error(429, '正在接收的文件较多，请稍后重试');
    const expected = req.headers['content-length'];
    if (expected !== undefined && (!/^\d+$/.test(expected) || Number(expected) > maxBytes)) throw error(413, '文件超过上传大小限制');
    const id = crypto.randomBytes(8).toString('hex');
    activeUploads.add(id);
    let staging;
    let completed = false;
    try {
      // Stage in the target filesystem. The final name only becomes visible after completion.
      staging = await fsp.mkdtemp(path.join(parent.absolute, '.landrop-'));
      stagingDirectories.add(staging);
      const temporary = path.join(staging, 'upload');
      let received = 0;
      const limiter = new Transform({
        transform(chunk, encoding, callback) {
          received += chunk.length;
          callback(received > maxBytes ? error(413, '文件超过上传大小限制') : null, chunk);
        },
      });
      // Do not include req in pipeline: size errors should still return an HTTP error.
      req.on('aborted', () => limiter.destroy(error(400, '上传已取消')));
      req.on('error', err => limiter.destroy(err));
      req.pipe(limiter);
      try { await pipeline(limiter, fs.createWriteStream(temporary, { flags: 'wx' }), { signal }); }
      catch (err) {
        req.unpipe(limiter);
        req.resume();
        if (signal?.aborted) throw error(410, '此收件链接已关闭');
        throw err;
      }
      if (expected !== undefined && received !== Number(expected)) throw error(400, '文件接收不完整');
      const verified = await resolveSafe(folder, true, inbox?.destination);
      if (verified.absolute !== parent.absolute) throw error(409, '上传期间文件夹发生变化');
      const extension = path.extname(filename);
      const stem = filename.slice(0, filename.length - extension.length);
      let savedName;
      for (let index = 0; index < 10000; index++) {
        if (signal?.aborted) throw error(410, '此收件链接已关闭');
        const candidate = index ? `${stem} (${index})${extension}` : filename;
        try {
          await fsp.link(temporary, path.join(parent.absolute, candidate));
          savedName = candidate;
          break;
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
        }
      }
      if (!savedName) throw error(409, '同名文件过多，请重命名后上传');
      const receipt = { name: savedName, size: received, receivedAt: new Date().toISOString() };
      if (inbox) inbox.receipts.push(receipt);
      try {
        await fsp.rm(staging, { recursive: true, force: true, maxRetries: 3 });
        stagingDirectories.delete(staging);
        staging = undefined;
      } catch (err) {
        if (!inbox) throw err;
        // The final file is already available. A cleanup error must not invite a duplicate upload.
        console.error('[LAN Drop] 无法清理已接收文件的临时目录', err);
      }
      completed = true;
      revision = Date.now();
      if (inbox) {
        json(res, 201, receipt);
      } else {
        json(res, 201, { name: savedName, size: received, path: [...splitPath(folder), savedName].join('/') });
      }
    } finally {
      activeUploads.delete(id);
      if (staging) {
        await fsp.rm(staging, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
        stagingDirectories.delete(staging);
      }
      if (!completed && !req.complete) req.resume();
    }
  }

  async function download(req, res, url) {
    const relative = url.searchParams.get('path') || '';
    const { absolute, stat } = await resolveSafe(relative);
    if (!stat.isFile()) throw error(400, '请选择文件下载');
    const filename = path.basename(absolute);
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`,
      'Accept-Ranges': 'bytes',
      'Last-Modified': stat.mtime.toUTCString(),
    };
    let start = 0;
    let end = stat.size - 1;
    let status = 200;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1] && !match[2])) throw error(416, '下载范围无效');
      if (!match[1]) start = Math.max(0, stat.size - Number(match[2]));
      else {
        start = Number(match[1]);
        if (match[2]) end = Math.min(end, Number(match[2]));
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) {
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        throw error(416, '下载范围超出文件大小');
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      status = 206;
    }
    headers['Content-Length'] = Math.max(0, end - start + 1);
    if (req.method === 'HEAD' || stat.size === 0) { res.writeHead(status, headers); res.end(); return; }
    const stream = fs.createReadStream(absolute, { start, end });
    await new Promise((resolve, reject) => { stream.once('open', resolve); stream.once('error', reject); });
    res.writeHead(status, headers);
    await pipeline(stream, res).catch(err => { if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw err; });
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', inboxMode ? 'same-origin' : 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const origin = checkRequest(req);
      const url = new URL(req.url, origin);
      if (inboxMode) { await routeInbox(req, res, url); return; }
      const route = url.pathname;
      if ((req.method === 'GET' || req.method === 'HEAD') && STATIC[route]) {
        await serveStatic(req, res, STATIC[route]);
        return;
      }
      if (route === '/api/login' && req.method === 'POST') {
        const key = req.socket.remoteAddress;
        const now = Date.now();
        let attempt = attempts.get(key);
        if (!attempt || now > attempt.until) { attempt = { count: 0, until: now + 5 * 60 * 1000 }; attempts.set(key, attempt); }
        if (attempt.count >= 8) throw error(429, '连接码尝试过多，请 5 分钟后重试');
        const body = await readJson(req);
        const provided = String(body?.code || '');
        if (!/^\d{6}$/.test(provided) || !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(code))) {
          attempt.count++;
          throw error(401, '连接码不正确，请查看服务启动终端');
        }
        attempts.delete(key);
        if (sessions.size >= 256) throw error(503, '连接数量已满，请稍后重试');
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, { created: now, token });
        res.setHeader('Set-Cookie', `landrop_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
        json(res, 200, { ok: true });
        return;
      }
      const session = getSession(req);
      if (route === '/api/session' && req.method === 'GET') { json(res, 200, { authenticated: Boolean(session) }); return; }
      if (!session) throw error(401, '请输入连接码');
      if (route === '/api/logout' && req.method === 'POST') {
        sessions.delete(session.token);
        res.setHeader('Set-Cookie', 'landrop_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        json(res, 200, { ok: true });
      } else if (route === '/api/info' && req.method === 'GET') {
        const actualPort = server.address().port;
        const addresses = host === '127.0.0.1' ? [] : localAddresses().filter(a => host === '0.0.0.0' || a.address === host);
        json(res, 200, { name: os.hostname(), folder: path.basename(root), readOnly, publicRead, publicAccess, maxBytes, code: publicAccess ? null : code, revision,
          urls: addresses.map(a => ({ label: a.name, url: `http://${a.address}:${actualPort}` })) });
      } else if (route === '/api/files' && req.method === 'GET') {
        const relative = url.searchParams.get('path') || '';
        const { absolute } = await resolveSafe(relative, true);
        const entries = await fsp.readdir(absolute, { withFileTypes: true });
        const files = [];
        // Bounded batches avoid exhausting file handles in large shared directories.
        for (let i = 0; i < entries.length; i += 32) {
          const batch = await Promise.all(entries.slice(i, i + 32).map(async entry => {
            try {
              validateSegment(entry.name);
              if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) return null;
              const stat = await fsp.lstat(path.join(absolute, entry.name));
              if (stat.isSymbolicLink()) return null;
              return { name: entry.name, type: stat.isDirectory() ? 'folder' : 'file', size: stat.isDirectory() ? null : stat.size,
                modified: stat.mtime.toISOString(), path: [...splitPath(relative), entry.name].join('/') };
            } catch { return null; }
          }));
          files.push(...batch.filter(Boolean));
        }
        json(res, 200, { path: relative, files, revision });
      } else if (route === '/api/files' && req.method === 'DELETE') {
        if (readOnly) throw error(403, '当前共享为只读模式');
        const body = await readJson(req);
        if (!body || typeof body.path !== 'string' || !body.path || body.confirmed !== true ||
            !Number.isSafeInteger(body.size) || body.size < 0 || typeof body.modified !== 'string') {
          throw error(400, '请先确认要删除的文件');
        }
        const { absolute, stat } = await resolveSafe(body.path);
        if (!stat.isFile()) throw error(400, '只能删除文件');
        // Do not delete a file that changed after the user opened the confirmation.
        if (stat.size !== body.size || stat.mtime.toISOString() !== body.modified) {
          throw error(409, '文件已变化，请刷新后重新确认');
        }
        await fsp.unlink(absolute);
        revision = Date.now();
        json(res, 200, { ok: true });
      } else if (route === '/api/folders' && req.method === 'POST') {
        if (readOnly) throw error(403, '当前共享为只读模式');
        const body = await readJson(req);
        const name = validateSegment(body.name);
        const { absolute } = await resolveSafe(body.path || '', true);
        try { await fsp.mkdir(path.join(absolute, name)); }
        catch (err) { if (err.code === 'EEXIST') throw error(409, '此名称已存在'); throw err; }
        revision = Date.now();
        json(res, 201, { name });
      } else if (route === '/api/upload' && req.method === 'POST') await upload(req, res, url);
      else if (route === '/api/download' && ['GET', 'HEAD'].includes(req.method)) await download(req, res, url);
      else if (route === '/api/qr' && req.method === 'GET') {
        const value = url.searchParams.get('url') || '';
        const valid = localAddresses().map(a => `http://${a.address}:${server.address().port}`);
        if (!valid.includes(value)) throw error(400, '请选择有效的局域网地址');
        await sendQr(res, value);
      } else throw error(404, '没有找到这个页面');
    } catch (err) {
      // Consume discarded request bodies so HTTP clients can receive the error response.
      if (!req.complete) req.resume();
      if (res.headersSent) { res.destroy(); return; }
      const status = err.status || ({ ENOENT: 404, ENOTDIR: 404, EACCES: 403, EPERM: 403, ENOSPC: 507 }[err.code]) || 500;
      const message = err.status ? err.message : ({ 404: '文件或文件夹已不存在，请刷新', 403: '没有权限访问此文件', 507: '磁盘空间不足' }[status] || '操作失败，请查看服务终端');
      if (status === 500) console.error('[LAN Drop]', err);
      if (!res.destroyed) json(res, status, { error: message });
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 30000;
  server.keepAliveTimeout = 5000;
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, session] of sessions) if (now - session.created > SESSION_TTL) sessions.delete(key);
    for (const [key, attempt] of attempts) if (now > attempt.until) attempts.delete(key);
  }, 60000);
  cleanup.unref();
  server.on('close', () => clearInterval(cleanup));
  return { server, root, code, host, port, readOnly, publicRead, publicAccess, maxBytes, stagingDirectories, closeInbox };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`LAN Drop · 局域网文件空间\n\n用法：node server.js [选项]\n\n  --inbox            本机控制台开启扫码收件，访客仅能上传\n  --dir <路径>        默认目录，共享为 ./shared，收件为 ./shared/inbox\n  --port <端口>       默认 38471\n  --host <IPv4>       默认 0.0.0.0，收件模式也可选 127.0.0.1\n  --code <6位数字>    固定连接码，默认每次启动随机生成\n  --max-size <GB>     单文件上传上限，默认 10 GB\n  --read-only        仅浏览和下载，需要连接码\n  --public-read      公开下载，无需连接码，禁止上传\n  --public           公开上传和下载，无需连接码\n  --help             查看帮助\n`);
    return;
  }
  const app = await createApp(options);
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(app.port, app.host, resolve); });
  const port = app.server.address().port;
  if (options.inbox) {
    console.log(`\n  LAN DROP / 局域网收件\n\n  本机控制台  http://127.0.0.1:${port}/\n  默认收件目录  ${app.root}\n  上传上限  ${app.maxBytes / 1024 ** 3} GB\n\n  打开控制台并开始收件，然后让同一网络内的人扫码投递。\n  Windows 防火墙如有提示，请允许专用网络访问。\n  按 Ctrl+C 停止服务。\n`);
  } else {
    const accessMode = app.publicAccess ? (app.readOnly ? '公开下载（只读，无需连接码）' : '公开上传和下载（无需连接码）') : '连接码 ' + app.code;
    console.log(`\n  LAN DROP / 局域网文件空间\n\n  本机打开  http://127.0.0.1:${port}/${app.publicAccess ? '' : '#code=' + app.code}\n  共享目录  ${app.root}\n  访问模式  ${accessMode}\n  上传上限  ${app.maxBytes / 1024 ** 3} GB${app.readOnly ? '（只读模式）' : ''}\n`);
    if (app.host !== '127.0.0.1') for (const address of localAddresses().filter(a => app.host === '0.0.0.0' || a.address === app.host)) {
      console.log(`  内网地址  http://${address.address}:${port}  (${address.name})`);
    }
    console.log(`\n  同一网络内打开上方地址${app.publicAccess ? (app.readOnly ? '即可下载文件' : '即可上传和下载文件') : '，输入连接码即可传文件'}。\n  Windows 防火墙如有提示，请允许专用网络访问。\n  按 Ctrl+C 停止服务。\n`);
  }
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    console.log('\n  正在停止服务…');
    if (options.inbox) app.closeInbox().catch(() => {});
    app.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) main().catch(err => {
  console.error(err.code === 'EADDRINUSE' ? '端口已被占用，请使用 --port 其他端口。' : err.message);
  process.exitCode = 1;
});

module.exports = { createApp, parseArgs, validateSegment };
