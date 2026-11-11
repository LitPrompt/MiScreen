import { h264CodecString, h265CodecString } from './codec-string';

export interface VideoStats {
  fps: number;
  kbps: number;
  width: number;
  height: number;
  decodeQueue: number;
  codec: string;
}

/**
 * WebCodecs 解码 + canvas 渲染。
 * 只保留最新一帧，在 requestAnimationFrame 中绘制，解码慢时自动跳帧，保证低延迟。
 */
export class VideoPlayer {
  private decoder: VideoDecoder | null = null;
  private codec = 'h264';
  private codecString = '';
  private pendingConfig: Uint8Array | null = null;
  private needKey = true;
  private latest: VideoFrame | null = null;
  private raf = 0;
  /** 驱动绘制的窗口：画面移到小窗后改用小窗的 requestAnimationFrame（主窗口最小化时它会被暂停） */
  private win: Window = window;
  private ctx: CanvasRenderingContext2D;
  private frames = 0;
  private bytes = 0;
  private lastStat = performance.now();
  stats: VideoStats = { fps: 0, kbps: 0, width: 0, height: 0, decodeQueue: 0, codec: '' };
  onError: (msg: string) => void = () => {};
  onResize: (w: number, h: number) => void = () => {};
  /** 请求设备立即发送关键帧 */
  requestKeyFrame: () => void = () => {};

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })!;
    this.raf = this.win.requestAnimationFrame(this.loop);
  }

  private loop = () => {
    this.raf = this.win.requestAnimationFrame(this.loop);
    this.draw();
  };

  setWindow(win: Window) {
    if (win === this.win) return;
    try {
      this.win.cancelAnimationFrame(this.raf);
    } catch {
      /* 旧窗口可能已关闭 */
    }
    this.win = win;
    this.raf = win.requestAnimationFrame(this.loop);
  }

  setCodec(codec: string) {
    this.codec = codec;
  }

  private configure(config: Uint8Array) {
    const codecString = this.codec === 'h265' ? h265CodecString(config) : h264CodecString(config);
    if (this.decoder && this.decoder.state === 'configured' && codecString === this.codecString) return;
    this.codecString = codecString;
    this.stats.codec = codecString;
    const cfg: VideoDecoderConfig = {
      codec: codecString,
      optimizeForLatency: true,
      hardwareAcceleration: 'no-preference',
    };
    VideoDecoder.isConfigSupported(cfg).then(
      (s) => {
        if (!s.supported)
          this.onError(
            this.codec === 'h265'
              ? `浏览器不支持 H.265 解码（${codecString}），请改用 H.264`
              : `浏览器不支持该视频格式（${codecString}）`,
          );
      },
      () => {},
    );
    this.decoder?.close();
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.latest?.close();
        this.latest = frame;
        this.frames++;
      },
      error: (e) => {
        console.error(e);
        this.needKey = true;
        this.decoder = null;
        this.codecString = '';
        this.requestKeyFrame();
      },
    });
    this.decoder.configure(cfg);
    this.needKey = true;
  }

  push(flags: number, pts: bigint, data: Uint8Array) {
    const isConfig = (flags & 1) !== 0;
    const isKey = (flags & 2) !== 0;
    this.bytes += data.length;
    if (isConfig) {
      // H.26x 的 SPS/PPS：缓存起来，与下一帧合并后送入解码器
      this.pendingConfig = data.slice();
      this.configure(this.pendingConfig);
      return;
    }
    if (!this.decoder || this.decoder.state !== 'configured') {
      if (this.pendingConfig) this.configure(this.pendingConfig);
      if (!this.decoder) return;
    }
    if (this.needKey) {
      if (!isKey) return;
      this.needKey = false;
    }
    let payload = data;
    if (this.pendingConfig && isKey) {
      payload = new Uint8Array(this.pendingConfig.length + data.length);
      payload.set(this.pendingConfig);
      payload.set(data, this.pendingConfig.length);
    }
    // 解码队列积压过多时，直接丢弃到下一个关键帧
    if (this.decoder.decodeQueueSize > 30) {
      this.needKey = true;
      this.requestKeyFrame();
      return;
    }
    try {
      this.decoder.decode(
        new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp: Number(pts), data: payload }),
      );
    } catch (e) {
      console.error(e);
      this.needKey = true;
      this.requestKeyFrame();
    }
  }

  private draw() {
    const f = this.latest;
    if (f) {
      this.latest = null;
      const w = f.displayWidth;
      const h = f.displayHeight;
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
        this.stats.width = w;
        this.stats.height = h;
        this.onResize(w, h);
      }
      this.ctx.drawImage(f, 0, 0, w, h);
      f.close();
    }
    const now = performance.now();
    if (now - this.lastStat >= 1000) {
      const dt = (now - this.lastStat) / 1000;
      this.stats.fps = Math.round(this.frames / dt);
      this.stats.kbps = Math.round((this.bytes * 8) / 1000 / dt);
      this.stats.decodeQueue = this.decoder?.decodeQueueSize ?? 0;
      this.frames = 0;
      this.bytes = 0;
      this.lastStat = now;
    }
  }

  reset() {
    this.decoder?.close();
    this.decoder = null;
    this.codecString = '';
    this.pendingConfig = null;
    this.needKey = true;
    this.latest?.close();
    this.latest = null;
  }

  destroy() {
    this.reset();
    try {
      this.win.cancelAnimationFrame(this.raf);
    } catch {
      /* ignore */
    }
  }
}
