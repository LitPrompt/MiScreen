// scrcpy server 会话：推送 server jar、建立 adb forward 隧道、解析音视频流和控制通道。
// 协议参照 scrcpy v5.0.1 源码（app/src/demuxer.c、server/.../Streamer.java、DesktopConnection.java）。
import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { adb, adbSpawn } from './adb.js';
import { config } from './config.js';

const DEVICE_SERVER_PATH = '/data/local/tmp/scrcpy-server.jar';
const FLAG_CONFIG = 1n << 62n;
const FLAG_KEY_FRAME = 1n << 61n;
const PTS_MASK = FLAG_KEY_FRAME - 1n;

export const CODEC_NAMES = {
  0x68323634: 'h264',
  0x68323635: 'h265',
  0x00617631: 'av1',
  0x6f707573: 'opus',
  0x00616163: 'aac',
  0x666c6163: 'flac',
  0x00726177: 'raw',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 按字节数读取 socket 数据的辅助类 */
class SocketReader {
  constructor(socket) {
    this.chunks = [];
    this.length = 0;
    this.waiter = null;
    this.ended = false;
    this.error = null;
    socket.on('data', (c) => {
      this.chunks.push(c);
      this.length += c.length;
      this.#check();
    });
    const end = (err) => {
      if (err) this.error = err;
      this.ended = true;
      this.#check();
    };
    socket.on('end', () => end());
    socket.on('close', () => end());
    socket.on('error', (e) => end(e));
  }

  read(n) {
    return new Promise((resolve, reject) => {
      this.waiter = { n, resolve, reject };
      this.#check();
    });
  }

  #check() {
    const w = this.waiter;
    if (!w) return;
    if (this.length >= w.n) {
      this.waiter = null;
      w.resolve(this.#take(w.n));
    } else if (this.ended) {
      this.waiter = null;
      w.reject(this.error || new Error('连接已关闭'));
    }
  }

  #take(n) {
    this.length -= n;
    const first = this.chunks[0];
    if (first.length === n) return this.chunks.shift();
    if (first.length > n) {
      this.chunks[0] = first.subarray(n);
      return first.subarray(0, n);
    }
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const c = this.chunks[0];
      const take = Math.min(c.length, n - off);
      c.copy(out, off, 0, take);
      off += take;
      if (take === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(take);
    }
    return out;
  }
}

function connectOnce(port) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => {
      s.removeListener('error', reject);
      s.setNoDelay(true);
      resolve(s);
    });
    s.once('error', reject);
  });
}

/** 把参数对象转成 scrcpy server 的 key=value 参数（只允许白名单中的键） */
const ALLOWED = {
  video_codec: /^(h264|h265|av1)$/,
  video_bit_rate: /^\d{4,9}$/,
  max_size: /^\d{1,5}$/,
  max_fps: /^\d{1,3}(\.\d+)?$/,
  audio: /^(true|false)$/,
  audio_codec: /^(opus|aac|flac|raw)$/,
  audio_bit_rate: /^\d{4,7}$/,
  audio_source: /^[a-z-]+$/,
  audio_dup: /^(true|false)$/,
  video_source: /^(display|camera)$/,
  display_id: /^\d{1,4}$/,
  show_touches: /^(true|false)$/,
  stay_awake: /^(true|false)$/,
  power_off_on_close: /^(true|false)$/,
  clipboard_autosync: /^(true|false)$/,
  video_encoder: /^[\w.-]+$/,
  audio_encoder: /^[\w.-]+$/,
  video_codec_options: /^[\w:=,.-]+$/,
  capture_orientation: /^@?(0|90|180|270)$/,
};

export function sanitizeOptions(input) {
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null || v === '') continue;
    const re = ALLOWED[k];
    if (!re) continue;
    const s = String(v);
    if (!re.test(s)) throw new Error(`参数 ${k}=${s} 不合法`);
    out[k] = s;
  }
  return out;
}

export class ScrcpySession extends EventEmitter {
  constructor(serial, options) {
    super();
    this.serial = serial;
    this.options = options;
    this.scid = crypto.randomInt(0, 0x7fffffff).toString(16).padStart(8, '0');
    this.port = 0;
    this.proc = null;
    this.sockets = {};
    this.closed = false;
    this.audioEnabled = options.audio !== 'false';
  }

  log(line) {
    this.emit('log', line);
  }

  async start() {
    try {
      await this.#start();
    } catch (e) {
      this.stop(e.message);
      throw e;
    }
  }

  async #start() {
    const { serial } = this;
    this.log(`推送 scrcpy-server v${config.scrcpyVersion}`);
    await adb(['push', config.scrcpyServerPath, DEVICE_SERVER_PATH], { serial, timeout: 30000 });

    const socketName = `scrcpy_${this.scid}`;
    this.port = Number((await adb(['forward', 'tcp:0', `localabstract:${socketName}`], { serial })).trim());
    if (!this.port) throw new Error('adb forward 失败');
    this.log(`adb forward tcp:${this.port} -> localabstract:${socketName}`);

    const params = {
      scid: this.scid,
      log_level: 'info',
      tunnel_forward: 'true',
      control: 'true',
      ...this.options,
    };
    const args = [
      'shell',
      `CLASSPATH=${DEVICE_SERVER_PATH}`,
      'app_process',
      '/',
      'com.genymobile.scrcpy.Server',
      config.scrcpyVersion,
      ...Object.entries(params).map(([k, v]) => `${k}=${v}`),
    ];
    this.log(`启动: ${args.slice(1).join(' ')}`);
    const proc = adbSpawn(args, { serial });
    this.proc = proc;
    let exited = false;
    const onLine = (buf) => {
      for (const line of buf.toString().split(/\r?\n/)) if (line.trim()) this.log(line.trim());
    };
    proc.stdout.on('data', onLine);
    proc.stderr.on('data', onLine);
    proc.on('exit', (code) => {
      exited = true;
      this.stop(`scrcpy server 已退出 (code ${code})`);
    });

    // 第一个 socket：等待 dummy byte，确认 server 已在监听（adb forward 在 server 未就绪时也会接受连接再关闭）
    const deadline = Date.now() + 10000;
    let video;
    let reader;
    for (;;) {
      if (exited || this.closed) throw new Error('scrcpy server 启动失败，请查看日志');
      if (Date.now() > deadline) throw new Error('连接 scrcpy server 超时');
      try {
        const s = await connectOnce(this.port);
        const r = new SocketReader(s);
        await r.read(1); // dummy byte
        video = s;
        reader = r;
        break;
      } catch {
        await sleep(100);
      }
    }
    this.sockets.video = video;
    let audioReader = null;
    if (this.audioEnabled) {
      this.sockets.audio = await connectOnce(this.port);
      audioReader = new SocketReader(this.sockets.audio);
    }
    this.sockets.control = await connectOnce(this.port);
    const controlReader = new SocketReader(this.sockets.control);

    const nameBuf = await reader.read(64);
    const deviceName = nameBuf.subarray(0, nameBuf.indexOf(0) >= 0 ? nameBuf.indexOf(0) : 64).toString('utf8');
    this.emit('device', { name: deviceName });

    this.#videoLoop(reader).catch((e) => this.stop(`视频流结束: ${e.message}`));
    if (audioReader) this.#audioLoop(audioReader).catch((e) => this.log(`音频流结束: ${e.message}`));
    this.#controlLoop(controlReader).catch(() => {});
  }

  async #videoLoop(r) {
    const codecId = (await r.read(4)).readUInt32BE(0);
    if (codecId === 0 || codecId === 1) throw new Error(codecId ? '视频配置错误' : '视频已禁用');
    this.emit('video-codec', CODEC_NAMES[codecId] || `0x${codecId.toString(16)}`);
    for (;;) {
      const h = await r.read(12);
      if (h[0] & 0x80) {
        // session 包：MSB=1，后面是宽、高
        this.emit('session', {
          width: h.readUInt32BE(4),
          height: h.readUInt32BE(8),
          clientResized: (h[3] & 1) === 1,
        });
        continue;
      }
      const ptsFlags = h.readBigUInt64BE(0);
      const size = h.readUInt32BE(8);
      const data = await r.read(size);
      this.emit('video', {
        config: (ptsFlags & FLAG_CONFIG) !== 0n,
        key: (ptsFlags & FLAG_KEY_FRAME) !== 0n,
        pts: ptsFlags & PTS_MASK,
        data,
      });
    }
  }

  async #audioLoop(r) {
    const codecId = (await r.read(4)).readUInt32BE(0);
    if (codecId === 0) {
      this.emit('audio-codec', null);
      throw new Error('设备无法采集音频（需要 Android 11+，或所选音频源不受支持）');
    }
    if (codecId === 1) throw new Error('音频配置错误');
    this.emit('audio-codec', CODEC_NAMES[codecId] || `0x${codecId.toString(16)}`);
    for (;;) {
      const h = await r.read(12);
      const ptsFlags = h.readBigUInt64BE(0);
      const size = h.readUInt32BE(8);
      const data = await r.read(size);
      this.emit('audio', {
        config: (ptsFlags & FLAG_CONFIG) !== 0n,
        key: true,
        pts: ptsFlags & PTS_MASK,
        data,
      });
    }
  }

  async #controlLoop(r) {
    for (;;) {
      const type = (await r.read(1))[0];
      if (type === 0) {
        const len = (await r.read(4)).readUInt32BE(0);
        const text = (await r.read(len)).toString('utf8');
        this.emit('clipboard', text);
      } else if (type === 1) {
        const seq = (await r.read(8)).readBigUInt64BE(0);
        this.emit('clipboard-ack', seq.toString());
      } else if (type === 2) {
        const head = await r.read(4);
        await r.read(head.readUInt16BE(2));
      } else {
        throw new Error(`未知设备消息类型 ${type}`);
      }
    }
  }

  /** 向设备发送一条已序列化的控制消息 */
  sendControl(buf) {
    const s = this.sockets.control;
    if (s && !s.destroyed) s.write(buf);
  }

  stop(reason = '已断开') {
    if (this.closed) return;
    this.closed = true;
    for (const s of Object.values(this.sockets)) s?.destroy();
    if (this.proc && this.proc.exitCode === null) this.proc.kill();
    if (this.port) adb(['forward', '--remove', `tcp:${this.port}`], { serial: this.serial }).catch(() => {});
    this.emit('close', reason);
  }
}
