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

/**
 * 读取电池和温度信息（一次 adb shell 完成）。
 * 温度来自 /sys/class/thermal（shell 用户可读），不同厂商的传感器命名不同，这里按常见命名挑选。
 */
export async function getDeviceStatus(serial) {
  const script =
    'dumpsys battery; echo @@THERMAL@@; ' +
    // 一次 grep 读出所有传感器的 type 和 temp（逐个 cat 在 100+ 个传感器时要好几秒）
    'grep -s . /sys/class/thermal/thermal_zone*/type /sys/class/thermal/thermal_zone*/temp';
  const out = await adb(['shell', script], { serial, timeout: 10000 });
  const [batteryPart, thermalPart = ''] = out.split('@@THERMAL@@');

  const bat = {};
  for (const line of batteryPart.split('\n')) {
    const m = line.match(/^\s*([\w ]+):\s*(.+?)\s*$/);
    if (m) bat[m[1].trim()] = m[2];
  }
  const status = Number(bat.status); // 2=充电中 3=放电 4=未充电 5=已充满
  const powered = ['AC powered', 'USB powered', 'Wireless powered'].some((k) => bat[k] === 'true');

  // 输出形如 /sys/class/thermal/thermal_zone12/type:cpu-0-0-usr 和 .../thermal_zone12/temp:32000
  const types = {};
  const temps = {};
  for (const line of thermalPart.split('\n')) {
    const m = line.trim().match(/thermal_zone(\d+)\/(type|temp):(.*)$/);
    if (!m) continue;
    if (m[2] === 'type') types[m[1]] = m[3].trim();
    else temps[m[1]] = m[3].trim();
  }
  const zones = {};
  for (const [id, type] of Object.entries(types)) {
    const raw = Number(temps[id]);
    if (!temps[id] || !Number.isFinite(raw)) continue;
    const c = Math.abs(raw) >= 1000 ? raw / 1000 : raw; // 大多数内核以 m℃ 为单位
    if (c > -20 && c < 150) zones[type] = c;
  }
  const names = Object.keys(zones);
  const pickMax = (re) => {
    const v = names.filter((n) => re.test(n) && !/step/i.test(n)).map((n) => zones[n]);
    return v.length ? Math.max(...v) : null;
  };
  const pickFirst = (list) => {
    for (const n of list) if (n in zones) return zones[n];
    return null;
  };

  const batteryTempFromDumpsys = bat.temperature ? Number(bat.temperature) / 10 : null;
  return {
    battery: {
      level: bat.level !== undefined ? Number(bat.level) : null,
      charging: status === 2 || status === 5 || powered,
      full: status === 5,
      temp: pickFirst(['battery', 'battery-therm', 'bms']) ?? batteryTempFromDumpsys,
      voltage: bat.voltage ? Number(bat.voltage) / 1000 : null,
    },
    temps: {
      cpu: pickMax(/^(cpu|cpuss|mtktscpu|soc_thermal|cpu-therm)/i),
      gpu: pickMax(/^(gpu|gpuss)/i),
      // 机身表面温度：小米/高通常用 quiet_therm，其他厂商多为 skin / shell / xo_therm
      skin: pickFirst(['quiet_therm', 'skin-therm', 'skin_therm', 'shell_front', 'shell', 'xo_therm', 'xo-therm']),
    },
  };
}
