import { execFile, spawn } from 'node:child_process';
import { config } from './config.js';

/** 执行一条 adb 命令，返回 stdout */
export function adb(args, { serial, timeout = 20000 } = {}) {
  const full = serial ? ['-s', serial, ...args] : args;
  return new Promise((resolve, reject) => {
    execFile(config.adbPath, full, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || stdout || err.message).toString().trim();
        reject(new Error(`adb ${full.join(' ')} 失败: ${msg}`));
      } else {
        resolve(stdout.toString());
      }
    });
  });
}

/** 以子进程方式运行 adb（用于长时间运行的 scrcpy server） */
export function adbSpawn(args, { serial } = {}) {
  const full = serial ? ['-s', serial, ...args] : args;
  return spawn(config.adbPath, full, { stdio: ['ignore', 'pipe', 'pipe'] });
}

export async function startServer() {
  await adb(['start-server'], { timeout: 30000 });
}

/** 解析 `adb devices -l` */
export async function listDevices() {
  const out = await adb(['devices', '-l']);
  const devices = [];
  for (const line of out.split('\n').slice(1)) {
    const m = line.trim().match(/^(\S+)\s+(\S+)(.*)$/);
    if (!m) continue;
    const [, serial, state, rest] = m;
    const props = {};
    for (const kv of rest.trim().split(/\s+/)) {
      const i = kv.indexOf(':');
      if (i > 0) props[kv.slice(0, i)] = kv.slice(i + 1);
    }
    devices.push({
      serial,
      state, // device / unauthorized / offline / ...
      model: props.model?.replace(/_/g, ' ') || '',
      product: props.product || '',
      device: props.device || '',
      transportId: props.transport_id || '',
      usb: props.usb || '',
    });
  }
  return devices;
}

export async function getDeviceInfo(serial) {
  const keys = [
    'ro.product.manufacturer',
    'ro.product.marketname',
    'ro.product.model',
    'ro.build.version.release',
    'ro.build.version.sdk',
  ];
  const out = await adb(['shell', keys.map((k) => `getprop ${k}`).join(';')], { serial });
  const [manufacturer, marketName, model, release, sdk] = out.split('\n').map((s) => s.trim());
  return { serial, manufacturer, marketName, model, release, sdk: Number(sdk) || 0 };
}

export async function connectTcp(address) {
  if (!/^[\w.-]+(:\d+)?$/.test(address)) throw new Error('地址格式不正确，应为 host:port');
  const out = (await adb(['connect', address])).trim();
  if (/failed|unable|cannot/i.test(out)) throw new Error(out);
  return out;
}
