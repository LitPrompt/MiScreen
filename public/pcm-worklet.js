// 低延迟 PCM 播放：环形缓冲 + 抖动缓冲。积压超过上限时丢弃旧数据追上实时。
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = sampleRate * 2;
    this.l = new Float32Array(this.size);
    this.r = new Float32Array(this.size);
    this.readPos = 0;
    this.writePos = 0;
    this.count = 0;
    this.started = false;
    this.target = Math.round(sampleRate * 0.06);
    this.max = Math.round(sampleRate * 0.25);
    this.underruns = 0;
    this.frames = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'pcm') this.push(m.l, m.r);
      else if (m.type === 'latency') {
        this.target = Math.round(sampleRate * m.target);
        this.max = Math.max(this.target * 2, Math.round(sampleRate * m.max));
      } else if (m.type === 'reset') {
        this.count = 0;
        this.readPos = this.writePos = 0;
        this.started = false;
      }
    };
  }

  push(l, r) {
    const n = l.length;
    for (let i = 0; i < n; i++) {
      this.l[this.writePos] = l[i];
      this.r[this.writePos] = r[i];
      this.writePos = (this.writePos + 1) % this.size;
    }
    this.count += n;
    if (this.count > this.size) this.count = this.size;
    if (this.count > this.max) {
      // 延迟过大：跳到只保留 target 长度的数据
      const skip = this.count - this.target;
      this.readPos = (this.readPos + skip) % this.size;
      this.count -= skip;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const ol = out[0];
    const or = out[1] || out[0];
    const n = ol.length;
    if (!this.started) {
      if (this.count >= this.target) this.started = true;
      else return true;
    }
    const avail = Math.min(n, this.count);
    for (let i = 0; i < avail; i++) {
      ol[i] = this.l[this.readPos];
      or[i] = this.r[this.readPos];
      this.readPos = (this.readPos + 1) % this.size;
    }
    this.count -= avail;
    if (avail < n) {
      this.started = false; // 欠载：重新缓冲
      this.underruns++;
    }
    if (++this.frames % 94 === 0) {
      this.port.postMessage({ type: 'stats', buffered: this.count / sampleRate, underruns: this.underruns });
    }
    return true;
  }
}

registerProcessor('pcm-player', PcmPlayer);
