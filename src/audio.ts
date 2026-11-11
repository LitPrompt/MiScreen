// 音频：Opus / AAC 用 WebCodecs AudioDecoder 解码，RAW 为 48kHz 双声道 s16le PCM

export interface AudioStats {
  bufferedMs: number;
  underruns: number;
  kbps: number;
  codec: string;
}

export class AudioPlayer {
  private ctx: AudioContext;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode;
  private ready: Promise<void>;
  private decoder: AudioDecoder | null = null;
  private codec = '';
  private bytes = 0;
  private lastStat = performance.now();
  stats: AudioStats = { bufferedMs: 0, underruns: 0, kbps: 0, codec: '' };
  onError: (msg: string) => void = () => {};

  /** 必须在用户手势（点击）中构造，否则浏览器会阻止自动播放 */
  constructor() {
    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
    this.ready = this.ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}pcm-worklet.js`).then(() => {
      this.node = new AudioWorkletNode(this.ctx, 'pcm-player', { outputChannelCount: [2] });
      this.node.port.onmessage = (e) => {
        if (e.data.type === 'stats') {
          this.stats.bufferedMs = Math.round(e.data.buffered * 1000);
          this.stats.underruns = e.data.underruns;
        }
      };
      this.node.connect(this.gain);
    });
    this.ctx.resume();
  }

  setLatency(targetMs: number) {
    this.ready.then(() =>
      this.node!.port.postMessage({ type: 'latency', target: targetMs / 1000, max: (targetMs * 3) / 1000 }),
    );
  }

  setVolume(v: number) {
    this.gain.gain.value = v;
  }

  setCodec(codec: string) {
    this.codec = codec;
    this.stats.codec = codec;
    this.decoder?.close();
    this.decoder = null;
  }

  private post(l: Float32Array, r: Float32Array) {
    this.node?.port.postMessage({ type: 'pcm', l, r }, [l.buffer, r.buffer]);
  }

  private configureDecoder(description?: Uint8Array) {
    const codec = this.codec === 'opus' ? 'opus' : this.codec === 'aac' ? 'mp4a.40.2' : this.codec;
    const cfg: AudioDecoderConfig = { codec, sampleRate: 48000, numberOfChannels: 2 };
    if (description && description.length) cfg.description = description;
    this.decoder?.close();
    this.decoder = new AudioDecoder({
      output: (ad) => this.onAudioData(ad),
      error: (e) => {
        console.error(e);
        this.onError(`音频解码失败: ${e.message}`);
        this.decoder = null;
      },
    });
    try {
      this.decoder.configure(cfg);
    } catch (e) {
      this.onError(`浏览器不支持 ${this.codec} 音频解码`);
      this.decoder = null;
    }
  }

  private onAudioData(ad: AudioData) {
    const n = ad.numberOfFrames;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    ad.copyTo(l, { planeIndex: 0, format: 'f32-planar' });
    if (ad.numberOfChannels > 1) ad.copyTo(r, { planeIndex: 1, format: 'f32-planar' });
    else r.set(l);
    ad.close();
    this.post(l, r);
  }

  push(flags: number, pts: bigint, data: Uint8Array) {
    this.bytes += data.length;
    this.tickStats();
    const isConfig = (flags & 1) !== 0;
    // 配置包（AAC 的 AudioSpecificConfig / Opus 的 OpusHead）必须保留，即使 worklet 还没就绪
    if (isConfig && this.codec !== 'raw') {
      this.configureDecoder(data.slice());
      return;
    }
    if (!this.node) return; // worklet 尚未就绪，丢弃最开始的几十毫秒

    if (this.codec === 'raw') {
      const samples = data.length >> 2;
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const l = new Float32Array(samples);
      const r = new Float32Array(samples);
      for (let i = 0; i < samples; i++) {
        l[i] = view.getInt16(i * 4, true) / 32768;
        r[i] = view.getInt16(i * 4 + 2, true) / 32768;
      }
      this.post(l, r);
      return;
    }

    if (!this.decoder) this.configureDecoder();
    if (!this.decoder || this.decoder.state !== 'configured') return;
    this.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Number(pts), data }));
  }

  private tickStats() {
    const now = performance.now();
    if (now - this.lastStat >= 1000) {
      this.stats.kbps = Math.round((this.bytes * 8) / 1000 / ((now - this.lastStat) / 1000));
      this.bytes = 0;
      this.lastStat = now;
    }
  }

  close() {
    this.decoder?.close();
    this.decoder = null;
    this.ctx.close();
  }
}
