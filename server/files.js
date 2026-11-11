import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { adb } from './adb.js';
import { config } from './config.js';

/** 设备 shell 单引号转义 */
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** 只接受绝对路径，去掉末尾的 / */
function checkPath(p) {
  if (typeof p !== 'string' || !p.startsWith('/') || /[\0\n\r]/.test(p) || p.split('/').includes('..')) {
    throw new Error('路径不合法');
  }
  return p.replace(/\/+$/, '') || '/';
}

function checkName(n) {
  if (typeof n !== 'string' || !n || n === '.' || n === '..' || /[\/\0\n\r]/.test(n)) throw new Error('文件名不合法');
  return n;
}

const join = (dir, name) => (dir === '/' ? `/${name}` : `${dir}/${name}`);

/** 列出目录：一次 stat 取大小、修改时间、类型（-L 跟随符号链接，/sdcard 本身就是链接） */
export async function listDir(serial, dir) {
  dir = checkPath(dir);
  const script =
    `cd ${shq(dir)} 2>/dev/null || { echo @@NOTDIR@@; exit 0; }; ` +
    `stat -L -c '%s %Y %F|%n' -- * .[!.]* ..?* 2>/dev/null; true`;
  const out = await adb(['shell', script], { serial, timeout: 30000 });
  if (out.includes('@@NOTDIR@@')) throw new Error(`无法打开目录：${dir}`);
  const entries = [];
  for (const line of out.split('\n')) {
    const m = line.replace(/\r$/, '').match(/^(\d+) (\d+) ([^|]+)\|(.+)$/);
    if (!m) continue;
    const [, size, mtime, type, name] = m;
    const isDir = type === 'directory';
    entries.push({ name, dir: isDir, size: isDir ? 0 : Number(size), mtime: Number(mtime) * 1000 });
  }
  return { path: dir, entries };
}

export async function storageInfo(serial) {
  const out = await adb(['shell', 'df -k /sdcard | tail -1'], { serial });
  const f = out.trim().split(/\s+/);
  return { total: Number(f[1]) * 1024 || 0, used: Number(f[2]) * 1024 || 0, free: Number(f[3]) * 1024 || 0 };
}

export async function makeDir(serial, p) {
  p = checkPath(p);
  await adb(['shell', `mkdir -p ${shq(p)}`], { serial });
}

export async function rename(serial, from, to) {
  from = checkPath(from);
  to = checkPath(to);
  const out = await adb(['shell', `[ -e ${shq(to)} ] && echo @@EXISTS@@ || mv ${shq(from)} ${shq(to)}`], { serial });
  if (out.includes('@@EXISTS@@')) throw new Error('目标已存在');
}

export async function remove(serial, paths) {
  if (!Array.isArray(paths) || !paths.length) throw new Error('没有要删除的文件');
  const list = paths.map((p) => {
    const c = checkPath(p);
    // 防止误删整个存储
    if (c.split('/').filter(Boolean).length < 2 || /^\/(sdcard|storage\/emulated\/0)$/.test(c)) {
      throw new Error(`不允许删除：${c}`);
    }
    return shq(c);
  });
  await adb(['shell', `rm -rf ${list.join(' ')}`], { serial, timeout: 120000 });
}

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  svg: 'image/svg+xml', mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac',
  wav: 'audio/wav', txt: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8', json: 'application/json',
  pdf: 'application/pdf', apk: 'application/vnd.android.package-archive', zip: 'application/zip',
};

/** 下载文件（目录打包成 tar），流式传输，不落盘 */
export async function download(serial, p, res, { inline = false } = {}) {
  p = checkPath(p);
  const st = await adb(['shell', `stat -L -c '%s %F' ${shq(p)} 2>/dev/null || echo @@NOENT@@`], { serial });
  if (st.includes('@@NOENT@@')) throw new Error('文件不存在');
  const [size, ...typeParts] = st.trim().split(' ');
  const isDir = typeParts.join(' ') === 'directory';
  const base = path.posix.basename(p) || 'root';
  const name = isDir ? `${base}.tar` : base;
  const ext = path.posix.extname(base).slice(1).toLowerCase();
  const cmd = isDir ? `tar -cf - -C ${shq(path.posix.dirname(p))} ${shq(base)} 2>/dev/null` : `cat ${shq(p)}`;

  const headers = {
    'content-type': isDir ? 'application/x-tar' : (inline && MIME[ext]) || 'application/octet-stream',
    'content-disposition': `${inline && !isDir ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    'cache-control': 'no-store',
  };
  if (!isDir) headers['content-length'] = size;
  res.writeHead(200, headers);

  const proc = spawn(config.adbPath, ['-s', serial, 'exec-out', cmd], { stdio: ['ignore', 'pipe', 'ignore'] });
  res.on('close', () => proc.kill());
  proc.stdout.pipe(res);
}

/** 上传：先把请求体存到临时文件，再 adb push（支持大文件） */
export async function upload(serial, dir, name, req) {
  dir = checkPath(dir);
  name = checkName(name);
  const tmp = path.join(os.tmpdir(), `miscreen-up-${crypto.randomUUID()}`);
  try {
    await pipeline(req, fs.createWriteStream(tmp));
    await adb(['push', tmp, join(dir, name)], { serial, timeout: 30 * 60 * 1000 });
  } finally {
    fs.rm(tmp, { force: true }, () => {});
  }
  return { path: join(dir, name) };
}
