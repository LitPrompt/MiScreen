import './style.css';
import { VideoPlayer } from './video';
import { AudioPlayer } from './audio';
import { InputHandler } from './input';
import { Keycode, MsgType, backOrScreenOn, KeyAction, getClipboard, setDisplayPower, simple } from './protocol';

// ---------- DOM ----------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const deviceSel = $<HTMLSelectElement>('device');
const connectBtn = $<HTMLButtonElement>('connect');
const statusEl = $('status');
const canvas = $<HTMLCanvasElement>('screen');
const screenWrap = $('screenWrap');
const placeholder = $('placeholder');
const logEl = $('log');
const clipboardEl = $<HTMLTextAreaElement>('clipboard');
const banner = $('banner');
const statsEl = $('stats');
const layoutEl = $('layout');

// ---------- 设置（保存在 localStorage） ----------
interface Settings {
  serial: string;
  videoCodec: string;
  videoBitRate: number; // Mbps
  maxSize: string;
  maxFps: string;
  audio: boolean;
  audioSource: string;
  audioCodec: string;
  audioBitRate: string;
  audioBuffer: number; // ms
  volume: number;
  stayAwake: boolean;
  screenOff: boolean;
  showTouches: boolean;
  powerOffOnClose: boolean;
}

const DEFAULTS: Settings = {
  serial: '',
  videoCodec: 'h264',
  videoBitRate: 8,
  maxSize: '1920',
  maxFps: '60',
  audio: true,
  audioSource: 'output',
  audioCodec: 'opus',
  audioBitRate: '128000',
  audioBuffer: 60,
  volume: 1,
  stayAwake: true,
  screenOff: false,
  showTouches: false,
  powerOffOnClose: false,
};

function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('miscreen.settings') || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}
const settings = loadSettings();
function saveSettings() {
  try {
    localStorage.setItem('miscreen.settings', JSON.stringify(settings));
  } catch {
    /* 隐私模式等情况下忽略 */
  }
}

// 需要重连才生效的设置
const RECONNECT_KEYS = new Set<keyof Settings>([
  'videoCodec', 'videoBitRate', 'maxSize', 'maxFps', 'audio', 'audioSource', 'audioCodec', 'audioBitRate',
  'stayAwake', 'showTouches', 'powerOffOnClose',
]);

function bindSetting<K extends keyof Settings>(key: K, onChange?: () => void) {
  const el = $<HTMLInputElement | HTMLSelectElement>(key);
  const isCheck = el instanceof HTMLInputElement && el.type === 'checkbox';
  const isNum = el instanceof HTMLInputElement && el.type === 'range';
  if (isCheck) (el as HTMLInputElement).checked = settings[key] as boolean;
  else el.value = String(settings[key]);
  const handler = () => {
    const v = isCheck ? (el as HTMLInputElement).checked : isNum ? Number(el.value) : el.value;
    (settings as unknown as Record<string, unknown>)[key] = v;
    saveSettings();
    onChange?.();
    updatePresetActive();
    if (session && RECONNECT_KEYS.has(key)) $('reconnectHint').hidden = false;
  };
  el.addEventListener(el instanceof HTMLSelectElement || isCheck ? 'change' : 'input', handler);
}

const updateBitrateLabel = () => ($('bitrateOut').textContent = `${settings.videoBitRate} Mbps`);
const updateBufferLabel = () => ($('bufferOut').textContent = `${settings.audioBuffer} ms`);
const updateVolumeLabel = () => ($('volumeOut').textContent = `${Math.round(settings.volume * 100)}%`);
bindSetting('videoCodec');
bindSetting('videoBitRate', updateBitrateLabel);
bindSetting('maxSize');
bindSetting('maxFps');
bindSetting('audio');
bindSetting('audioSource');
bindSetting('audioCodec');
bindSetting('audioBitRate');
bindSetting('audioBuffer', () => {
  updateBufferLabel();
  session?.audio?.setLatency(settings.audioBuffer);
});
bindSetting('volume', () => {
  updateVolumeLabel();
  session?.audio?.setVolume(muted ? 0 : settings.volume);
});
bindSetting('stayAwake');
bindSetting('screenOff');
bindSetting('showTouches');
bindSetting('powerOffOnClose');
updateBitrateLabel();
updateBufferLabel();
updateVolumeLabel();

// ---------- 画质预设 ----------
const PRESETS: Record<string, Pick<Settings, 'videoBitRate' | 'maxSize' | 'maxFps'>> = {
  smooth: { videoBitRate: 4, maxSize: '1280', maxFps: '60' },
  balanced: { videoBitRate: 8, maxSize: '1920', maxFps: '60' },
  hd: { videoBitRate: 16, maxSize: '2400', maxFps: '90' },
  max: { videoBitRate: 32, maxSize: '0', maxFps: '120' },
};
function updatePresetActive() {
  document.querySelectorAll<HTMLButtonElement>('#presets button').forEach((b) => {
    const p = PRESETS[b.dataset.preset!];
    b.classList.toggle(
      'active',
      p.videoBitRate === settings.videoBitRate && p.maxSize === settings.maxSize && p.maxFps === settings.maxFps,
    );
  });
}
document.querySelectorAll<HTMLButtonElement>('#presets button').forEach((b) =>
  b.addEventListener('click', () => {
    Object.assign(settings, PRESETS[b.dataset.preset!]);
    saveSettings();
    $<HTMLInputElement>('videoBitRate').value = String(settings.videoBitRate);
    $<HTMLSelectElement>('maxSize').value = settings.maxSize;
    $<HTMLSelectElement>('maxFps').value = settings.maxFps;
    updateBitrateLabel();
    updatePresetActive();
    if (session) $('reconnectHint').hidden = false;
  }),
);
updatePresetActive();

// ---------- 标签页 & 面板开关 ----------
function selectTab(name: string) {
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) =>
    b.setAttribute('aria-selected', String(b.dataset.tab === name)),
  );
  document.querySelectorAll<HTMLElement>('.tab-page').forEach((p) => (p.hidden = p.dataset.page !== name));
  try {
    localStorage.setItem('miscreen.tab', name);
  } catch {
    /* ignore */
  }
}
document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) =>
  b.addEventListener('click', () => selectTab(b.dataset.tab!)),
);
function setPanel(open: boolean) {
  layoutEl.classList.toggle('panel-closed', !open);
  $('togglePanel').setAttribute('aria-pressed', String(open));
  try {
    localStorage.setItem('miscreen.panel', open ? '1' : '0');
  } catch {
    /* ignore */
  }
}
$('togglePanel').addEventListener('click', () => setPanel(layoutEl.classList.contains('panel-closed')));
try {
  selectTab(localStorage.getItem('miscreen.tab') || 'video');
  setPanel(localStorage.getItem('miscreen.panel') !== '0');
} catch {
  /* ignore */
}
statsEl.dataset.on = 'false';

// ---------- UI 辅助 ----------
function setStatus(state: 'idle' | 'connecting' | 'connected' | 'error', text: string) {
  statusEl.dataset.state = state;
  statusEl.querySelector('span')!.textContent = text;
}

let toastTimer = 0;
function toast(msg: string, ms = 4000) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), ms);
}

function log(line: string) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent += `[${time}] ${line}\n`;
  if (logEl.textContent!.length > 60000) logEl.textContent = logEl.textContent!.slice(-40000);
  logEl.scrollTop = logEl.scrollHeight;
}

function setStat(k: string, v: string) {
  const el = document.querySelector<HTMLElement>(`#stats [data-k="${k}"]`);
  if (el) el.textContent = v;
}

// ---------- 环境检查 ----------
if (!window.isSecureContext || !('VideoDecoder' in window)) {
  const httpsUrl = `https://${location.hostname}:8443${location.pathname}`;
  banner.hidden = false;
  banner.innerHTML = !window.isSecureContext
    ? `当前页面不是安全上下文（HTTP 且非 localhost），浏览器禁用了 WebCodecs 解码。请改用 <a href="${httpsUrl}">${httpsUrl}</a> 访问（自签名证书需手动信任一次），或用反向代理配置正式证书。`
    : '当前浏览器不支持 WebCodecs，请使用最新版 Chrome / Edge / Safari 17+ / Firefox 130+。';
}

// ---------- 设备列表 ----------
async function refreshDevices() {
  try {
    const res = await fetch('/api/devices');
    const { devices, error } = await res.json();
    if (error) throw new Error(error);
    deviceSel.innerHTML = '';
    if (!devices.length) {
      deviceSel.add(new Option('未发现设备', ''));
    }
    for (const d of devices) {
      const label =
        d.state === 'device'
          ? `${d.model || d.serial}  ·  ${d.serial}`
          : `${d.serial}  ·  ${d.state === 'unauthorized' ? '未授权：请在手机上允许 USB 调试' : d.state}`;
      const opt = new Option(label, d.serial);
      opt.disabled = d.state !== 'device';
      deviceSel.add(opt);
    }
    const usable = devices.filter((d: { state: string }) => d.state === 'device');
    const keep = usable.find((d: { serial: string }) => d.serial === settings.serial);
    deviceSel.value = keep ? keep.serial : usable[0]?.serial || '';
    connectBtn.disabled = !deviceSel.value && !session;
  } catch (e) {
    toast(`获取设备列表失败: ${(e as Error).message}`);
  }
}
deviceSel.addEventListener('change', () => {
  settings.serial = deviceSel.value;
  saveSettings();
});
$('refresh').addEventListener('click', refreshDevices);

$('tcpConnect').addEventListener('click', async () => {
  const address = $<HTMLInputElement>('tcpAddr').value.trim();
  if (!address) return;
  const res = await fetch('/api/adb/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address }),
  });
  const body = await res.json();
  toast(body.error || body.message);
  refreshDevices();
});

// ---------- 会话 ----------
interface Session {
  ws: WebSocket;
  video: VideoPlayer;
  audio: AudioPlayer | null;
  input: InputHandler;
  statTimer: number;
  screenOn: boolean;
}
let session: Session | null = null;
let muted = false;
const isTouchDevice = matchMedia('(pointer: coarse)').matches;

/** 沉浸模式：画面铺满视口，工具栏在底部；同时尝试浏览器全屏（iPhone Safari 不支持时仍保留铺满效果） */
function setImmersive(on: boolean) {
  document.body.classList.toggle('immersive', on);
  if (!on) setMenu(false);
  if (on) document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
  else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function send(msg: Uint8Array<ArrayBuffer>) {
  if (session?.ws.readyState === WebSocket.OPEN) session.ws.send(msg);
}

function connect() {
  const serial = deviceSel.value;
  if (!serial) return toast('没有可用设备');
  const wasImmersive = document.body.classList.contains('immersive');
  disconnect(true);
  // 移动端默认全屏（必须在点击事件中同步调用）
  if (isTouchDevice || wasImmersive) setImmersive(true);
  settings.serial = serial;
  saveSettings();
  $('reconnectHint').hidden = true;

  const params = new URLSearchParams({
    serial,
    video_codec: settings.videoCodec,
    video_bit_rate: String(Math.round(settings.videoBitRate * 1_000_000)),
    max_size: settings.maxSize,
    audio: String(settings.audio),
    stay_awake: String(settings.stayAwake),
    show_touches: String(settings.showTouches),
    power_off_on_close: String(settings.powerOffOnClose),
    clipboard_autosync: 'true',
  });
  if (settings.maxFps !== '0') params.set('max_fps', settings.maxFps);
  if (settings.audio) {
    params.set('audio_codec', settings.audioCodec);
    params.set('audio_bit_rate', settings.audioBitRate);
    params.set('audio_source', settings.audioSource);
    if (settings.audioSource === 'playback') params.set('audio_dup', 'true');
  }

  // AudioContext 必须在点击事件里同步创建
  const audio = settings.audio ? new AudioPlayer() : null;
  audio?.setLatency(settings.audioBuffer);
  audio?.setVolume(muted ? 0 : settings.volume);

  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?${params}`);
  ws.binaryType = 'arraybuffer';
  const video = new VideoPlayer(canvas);
  const input = new InputHandler(canvas, send);
  const s: Session = { ws, video, audio, input, statTimer: 0, screenOn: true };
  session = s;

  video.requestKeyFrame = () => send(simple(MsgType.ResetVideo));
  video.onError = (m) => toast(m, 8000);
  input.onUserGesture = () => audio?.resume();
  video.onResize = (w, h) => {
    screenWrap.style.setProperty('--ar', `${w} / ${h}`);
    screenWrap.style.setProperty('--arw', String(w));
    screenWrap.style.setProperty('--arh', String(h));
    screenWrap.classList.toggle('landscape', w > h);
  };
  if (audio) audio.onError = (m) => toast(m, 6000);

  setStatus('connecting', '连接中…');
  connectBtn.textContent = '断开';
  connectBtn.classList.add('danger');
  for (const k of ['device', 'res', 'fps', 'vkbps', 'akbps', 'abuf', 'codec']) setStat(k, '—');
  statsEl.dataset.on = 'true';
  logEl.textContent = '';

  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') return onJson(s, JSON.parse(ev.data));
    const u8 = new Uint8Array(ev.data as ArrayBuffer);
    const dv = new DataView(u8.buffer);
    const kind = u8[0];
    const flags = u8[1];
    const pts = dv.getBigUint64(2);
    const data = u8.subarray(10);
    if (kind === 1) video.push(flags, pts, data);
    else if (kind === 2) audio?.push(flags, pts, data);
  };
  ws.onclose = () => {
    if (session === s) {
      disconnect();
      setStatus('idle', '已断开');
    }
  };
  ws.onerror = () => {
    if (session === s) setStatus('error', '连接失败');
  };

  s.statTimer = window.setInterval(() => {
    const v = video.stats;
    setStat('res', v.width ? `${v.width} × ${v.height}` : '—');
    setStat('fps', `${v.fps} fps`);
    setStat('vkbps', `${(v.kbps / 1000).toFixed(2)} Mbps`);
    setStat('codec', v.codec || '—');
    if (audio) {
      const codec = audio.stats.codec ? audio.stats.codec.toUpperCase() : '—';
      setStat('akbps', `${codec} ${audio.stats.kbps}k`);
      const u = audio.stats.underruns;
      setStat('abuf', `${audio.stats.bufferedMs} ms${u ? ` · 欠载 ${u}` : ''}`);
    } else {
      setStat('akbps', '关闭');
      setStat('abuf', '—');
    }
  }, 1000);
}

function onJson(s: Session, m: Record<string, string> & { width?: number; height?: number }) {
  switch (m.type) {
    case 'log':
      log(m.line);
      break;
    case 'device':
      setStat('device', m.name);
      break;
    case 'video-codec':
      s.video.setCodec(m.codec);
      break;
    case 'audio-codec':
      if (m.codec) s.audio?.setCodec(m.codec);
      else if (settings.audioSource === 'playback') {
        // MIUI 等系统会拒绝 playback 采集（registerAudioPolicy() returned -1），自动改用系统输出
        settings.audioSource = 'output';
        saveSettings();
        $<HTMLSelectElement>('audioSource').value = 'output';
        toast('该设备不支持「应用播放」采集，已切换为「系统输出」并重新连接', 6000);
        setTimeout(connect, 300);
      } else toast('设备无法采集音频，仅传输画面（可在日志中查看原因）', 6000);
      break;
    case 'session':
      s.input.setVideoSize(m.width!, m.height!);
      break;
    case 'ready':
      setStatus('connected', '已连接');
      placeholder.hidden = true;
      canvas.classList.add('live');
      s.input.enabled = true;
      if (settings.screenOff) {
        send(setDisplayPower(false));
        s.screenOn = false;
      }
      break;
    case 'clipboard':
      clipboardEl.value = m.text;
      navigator.clipboard?.writeText(m.text).catch(() => {});
      break;
    case 'dropped':
      log(`网络拥塞，已丢弃 ${m.count} 帧`);
      break;
    case 'error':
      toast(m.message, 8000);
      log(`错误: ${m.message}`);
      setStatus('error', '出错');
      break;
    case 'closed':
      log(`会话结束: ${m.reason}`);
      break;
  }
}

function disconnect(keepImmersive = false) {
  const s = session;
  if (!s) return;
  session = null;
  s.input.releaseAll();
  s.input.destroy();
  clearInterval(s.statTimer);
  s.ws.onclose = null;
  s.ws.close();
  s.video.destroy();
  s.audio?.close();
  canvas.classList.remove('live');
  canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  placeholder.hidden = false;
  if (!keepImmersive) setImmersive(false);
  connectBtn.textContent = '连接';
  connectBtn.classList.remove('danger');
  statsEl.dataset.on = 'false';
  setStatus('idle', '未连接');
}

connectBtn.addEventListener('click', () => (session ? disconnect() : connect()));
$('reconnect').addEventListener('click', connect);

// ---------- 工具栏 ----------
const actions: Record<string, () => void> = {
  power: () => session?.input.pressKey(Keycode.POWER),
  volup: () => session?.input.pressKey(Keycode.VOLUME_UP),
  voldown: () => session?.input.pressKey(Keycode.VOLUME_DOWN),
  rotate: () => send(simple(MsgType.RotateDevice)),
  back: () => {
    send(backOrScreenOn(KeyAction.Down));
    send(backOrScreenOn(KeyAction.Up));
  },
  home: () => session?.input.pressKey(Keycode.HOME),
  recents: () => session?.input.pressKey(Keycode.APP_SWITCH),
  notifications: () => send(simple(MsgType.ExpandNotificationPanel)),
  quicksettings: () => send(simple(MsgType.ExpandSettingsPanel)),
  screenoff: () => {
    if (!session) return;
    session.screenOn = !session.screenOn;
    send(setDisplayPower(session.screenOn));
    toast(session.screenOn ? '手机屏幕已打开' : '手机屏幕已关闭，投屏继续');
  },
  mute: () => {
    muted = !muted;
    session?.audio?.setVolume(muted ? 0 : settings.volume);
    document.querySelector('[data-action="mute"]')!.classList.toggle('on', muted);
  },
  screenshot: () => {
    if (!canvas.width) return;
    canvas.toBlob((b) => {
      if (!b) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  },
  fullscreen: () => setImmersive(!document.body.classList.contains('immersive')),
  disconnect: () => disconnect(),
  keyboard: () => {
    if (!session) return;
    if (session.input.focused) session.input.blur();
    else session.input.focus(); // 在触屏设备上会弹出软键盘
  },
};
// 这些操作常需要连续点击，执行后不收起菜单
const KEEP_MENU_OPEN = new Set(['volup', 'voldown', 'mute']);
document.querySelectorAll<HTMLButtonElement>('.toolbar button').forEach((b) =>
  b.addEventListener('click', () => {
    actions[b.dataset.action!]?.();
    if (!KEEP_MENU_OPEN.has(b.dataset.action!)) setMenu(false);
    // 桌面端点完按钮后把焦点还给画面，方便继续打字；触屏设备上不这么做，避免弹出软键盘
    if (session && !isTouchDevice && b.dataset.action !== 'keyboard') session.input.focus();
  }),
);

// ---------- 剪贴板 ----------
$('clipSend').addEventListener('click', () => {
  session?.input.setDeviceClipboard(clipboardEl.value);
  toast('已发送到手机剪贴板');
});
$('clipPaste').addEventListener('click', () => session?.input.pasteText(clipboardEl.value));
$('clipCopy').addEventListener('click', async () => {
  send(getClipboard(0));
  try {
    await navigator.clipboard.writeText(clipboardEl.value);
    toast('已复制到电脑剪贴板');
  } catch {
    clipboardEl.select();
    document.execCommand('copy');
  }
});

// ---------- 移动端：导航栏 + 弹出菜单 ----------
function setMenu(open: boolean) {
  document.body.classList.toggle('menu-open', open);
  $('menuBackdrop').hidden = !open;
}
$('menuBackdrop').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  setMenu(false);
});

// 底部三键导航栏：点按 = 返回/主页/多任务，长按 = 打开完整菜单
(function initNavbar() {
  const bar = $('navbar');
  let timer = 0;
  let longPressed = false;
  bar.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    longPressed = false;
    timer = window.setTimeout(() => {
      longPressed = true;
      navigator.vibrate?.(15);
      setMenu(true);
    }, 500);
  });
  const cancel = () => clearTimeout(timer);
  bar.addEventListener('pointerup', cancel);
  bar.addEventListener('pointercancel', cancel);
  bar.addEventListener('pointerleave', cancel);
  bar.addEventListener('contextmenu', (e) => e.preventDefault());
  bar.querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
    b.addEventListener('click', () => {
      if (longPressed) return;
      actions[b.dataset.nav!]?.();
    }),
  );
})();

// 桌面端按 Esc 退出浏览器全屏时同步退出沉浸模式（移动端保留铺满效果，可用工具栏按钮退出）
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && !isTouchDevice) document.body.classList.remove('immersive');
});

refreshDevices();
setInterval(() => {
  if (!session) refreshDevices();
}, 5000);
