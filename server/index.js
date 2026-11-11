import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { listDevices, getDeviceInfo, getDeviceStatus, connectTcp, startServer } from './adb.js';
import { ScrcpySession, sanitizeOptions } from './scrcpy.js';
import * as files from './files.js';

// ---------- 浏览器 <-> 服务端 二进制帧格式 ----------
// [0]    kind   1=视频 2=音频
// [1]    flags  bit0=config bit1=keyframe
// [2..9] pts    uint64 BE（微秒）
// [10..] payload
const KIND_VIDEO = 1;
const KIND_AUDIO = 2;
const RESET_VIDEO = Buffer.from([17]); // scrcpy 控制消息 TYPE_RESET_VIDEO：让编码器立即输出关键帧

function frame(kind, p) {
  const head = Buffer.allocUnsafe(10);
  head[0] = kind;
  head[1] = (p.config ? 1 : 0) | (p.key ? 2 : 0);
  head.writeBigUInt64BE(p.pts, 2);
  return Buffer.concat([head, p.data]);
}

// ---------- 认证 ----------
function checkAuth(req) {
  if (!config.authUser || !config.authPassword) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, ...rest] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  return u === config.authUser && rest.join(':') === config.authPassword;
}

// ---------- 静态文件 & API ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > 1e5) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, scrcpy: config.scrcpyVersion });
    }
    if (req.method === 'GET' && url.pathname === '/api/devices') {
      return sendJson(res, 200, { devices: await listDevices() });
    }
    const st = url.pathname.match(/^\/api\/devices\/([^/]+)\/status$/);
    if (req.method === 'GET' && st) {
      return sendJson(res, 200, await getDeviceStatus(decodeURIComponent(st[1])));
    }
    const m = url.pathname.match(/^\/api\/devices\/([^/]+)\/info$/);
    if (req.method === 'GET' && m) {
      return sendJson(res, 200, await getDeviceInfo(decodeURIComponent(m[1])));
    }
    // ---------- 文件管理 ----------
    const f = url.pathname.match(/^\/api\/devices\/([^/]+)\/files(?:\/(list|storage|download|upload|mkdir|rename|delete))?$/);
    if (f) {
      const serial = decodeURIComponent(f[1]);
      const op = f[2] || 'list';
      const q = url.searchParams;
      if (req.method === 'GET' && op === 'list') return sendJson(res, 200, await files.listDir(serial, q.get('path') || '/sdcard'));
      if (req.method === 'GET' && op === 'storage') return sendJson(res, 200, await files.storageInfo(serial));
      if (req.method === 'GET' && op === 'download') return await files.download(serial, q.get('path'), res, { inline: q.get('inline') === '1' });
      if (req.method === 'POST' && op === 'upload') return sendJson(res, 200, await files.upload(serial, q.get('dir'), q.get('name'), req));
      if (req.method === 'POST' && op === 'mkdir') {
        await files.makeDir(serial, (await readBody(req)).path);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && op === 'rename') {
        const b = await readBody(req);
        await files.rename(serial, b.from, b.to);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && op === 'delete') {
        await files.remove(serial, (await readBody(req)).paths);
        return sendJson(res, 200, { ok: true });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/adb/connect') {
      const { address } = await readBody(req);
      return sendJson(res, 200, { message: await connectTcp(String(address || '')) });
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    if (res.headersSent) res.destroy();
    else sendJson(res, 500, { error: e.message });
  }
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  let file = path.join(config.webDir, p);
  if (!file.startsWith(config.webDir)) {
    res.writeHead(403).end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(config.webDir, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('前端尚未构建：请先运行 npm run build');
    return;
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

/** 去掉网关路径前缀（/app/miscreen/api/... → /api/...），没有前缀时原样返回 */
function parseUrl(req) {
  const url = new URL(req.url, 'http://x');
  const base = config.basePath;
  if (base && (url.pathname === base || url.pathname.startsWith(base + '/'))) {
    url.pathname = url.pathname.slice(base.length) || '/';
  }
  return url;
}

function onRequest(req, res) {
  if (!checkAuth(req)) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="MiScreen"' }).end();
    return;
  }
  // 前端使用相对路径，入口必须以 / 结尾
  if (config.basePath && req.url.split('?')[0] === config.basePath) {
    res.writeHead(301, { location: config.basePath + '/' }).end();
    return;
  }
  const url = parseUrl(req);
  if (url.pathname.startsWith('/api/')) handleApi(req, res, url);
  else serveStatic(req, res, url);
}

// ---------- WebSocket：一个连接对应一个 scrcpy 会话 ----------
const sessions = new Map(); // serial -> ScrcpySession

function onWsConnection(ws, req) {
  const url = parseUrl(req);
  const serial = url.searchParams.get('serial');
  const sendJsonMsg = (o) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(o));

  let options;
  try {
    if (!serial) throw new Error('缺少 serial 参数');
    options = sanitizeOptions(Object.fromEntries(url.searchParams));
  } catch (e) {
    sendJsonMsg({ type: 'error', message: e.message });
    ws.close();
    return;
  }

  // 同一台设备同时只允许一个会话：新的连接会顶掉旧的
  sessions.get(serial)?.stop('被新的连接替换');
  const session = new ScrcpySession(serial, options);
  sessions.set(serial, session);

  let waitingKeyFrame = false;
  let lastReset = 0;
  let dropped = 0;

  session.on('log', (line) => {
    console.log(`[${serial}] ${line}`);
    sendJsonMsg({ type: 'log', line });
  });
  session.on('device', (d) => sendJsonMsg({ type: 'device', ...d }));
  session.on('video-codec', (codec) => sendJsonMsg({ type: 'video-codec', codec }));
  session.on('audio-codec', (codec) => sendJsonMsg({ type: 'audio-codec', codec }));
  session.on('session', (s) => sendJsonMsg({ type: 'session', ...s }));
  session.on('clipboard', (text) => sendJsonMsg({ type: 'clipboard', text }));
  session.on('clipboard-ack', (seq) => sendJsonMsg({ type: 'clipboard-ack', seq }));

  session.on('video', (p) => {
    if (ws.readyState !== ws.OPEN) return;
    if (!p.config) {
      if (ws.bufferedAmount > config.maxWsBuffer) {
        // 网络跟不上：丢帧，并让设备重新输出关键帧，避免延迟越积越大
        waitingKeyFrame = true;
        dropped++;
        const now = Date.now();
        if (now - lastReset > 1000) {
          lastReset = now;
          session.sendControl(RESET_VIDEO);
        }
        return;
      }
      if (waitingKeyFrame) {
        if (!p.key) {
          dropped++;
          return;
        }
        waitingKeyFrame = false;
        sendJsonMsg({ type: 'dropped', count: dropped });
      }
    }
    ws.send(frame(KIND_VIDEO, p));
  });
  session.on('audio', (p) => {
    if (ws.readyState !== ws.OPEN) return;
    if (!p.config && ws.bufferedAmount > config.maxWsBuffer * 2) return;
    ws.send(frame(KIND_AUDIO, p));
  });
  session.on('close', (reason) => {
    if (sessions.get(serial) === session) sessions.delete(serial);
    sendJsonMsg({ type: 'closed', reason });
    ws.close();
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) session.sendControl(Buffer.isBuffer(data) ? data : Buffer.concat(data));
  });
  ws.on('close', () => session.stop('浏览器已断开'));

  session.start().then(
    () => sendJsonMsg({ type: 'ready' }),
    (e) => sendJsonMsg({ type: 'error', message: e.message }),
  );
}

// ---------- 启动 ----------
function attachWs(server) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  wss.on('connection', onWsConnection);
  server.on('upgrade', (req, socket, head) => {
    const url = parseUrl(req);
    if (url.pathname !== '/ws' || !checkAuth(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
}

function loadOrCreateCert() {
  if (config.tlsCert && config.tlsKey) {
    return { cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) };
  }
  const dir = path.join(config.dataDir, 'tls');
  const cert = path.join(dir, 'cert.pem');
  const key = path.join(dir, 'key.pem');
  if (!fs.existsSync(cert) || !fs.existsSync(key)) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650',
      '-keyout', key, '-out', cert, '-subj', '/CN=MiScreen',
    ], { stdio: 'ignore' });
    console.log(`已生成自签名证书: ${cert}`);
  }
  return { cert: fs.readFileSync(cert), key: fs.readFileSync(key) };
}

async function main() {
  try {
    await startServer();
  } catch (e) {
    console.warn(`adb start-server 失败: ${e.message}`);
  }

  const httpServer = http.createServer(onRequest);
  attachWs(httpServer);
  httpServer.listen(config.port, config.host, () => console.log(`HTTP  http://${config.host}:${config.port}`));

  if (config.httpsPort) {
    try {
      const httpsServer = https.createServer(loadOrCreateCert(), onRequest);
      attachWs(httpsServer);
      httpsServer.listen(config.httpsPort, config.host, () =>
        console.log(`HTTPS https://${config.host}:${config.httpsPort}`),
      );
    } catch (e) {
      console.warn(`HTTPS 未启用: ${e.message}`);
    }
  }

  if (config.unixSocket) {
    // 飞牛网关通过 unix socket 转发 /app/miscreen/ 的请求（含 WebSocket）
    try {
      fs.rmSync(config.unixSocket, { force: true });
      const sockServer = http.createServer(onRequest);
      attachWs(sockServer);
      sockServer.listen(config.unixSocket, () => {
        fs.chmodSync(config.unixSocket, 0o666);
        console.log(`UNIX  ${config.unixSocket}${config.basePath ? `（前缀 ${config.basePath}）` : ''}`);
      });
    } catch (e) {
      console.warn(`unix socket 未启用: ${e.message}`);
    }
  }

  const shutdown = () => {
    for (const s of sessions.values()) s.stop('服务关闭');
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
