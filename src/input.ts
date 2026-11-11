import {
  CODE_TO_KEYCODE,
  KeyAction,
  Keycode,
  Meta,
  MotionAction,
  NON_TEXT_CODES,
  POINTER_FINGER,
  backOrScreenOn,
  injectKeycode,
  injectScroll,
  injectText,
  injectTouch,
  setClipboard,
  type Position,
} from './protocol';

type Send = (msg: Uint8Array<ArrayBuffer>) => void;

/**
 * 把浏览器的鼠标 / 触摸 / 键盘事件转换成 scrcpy 控制消息。
 * - 左键或手指：触摸（支持多点触控）
 * - 右键：返回（屏幕关闭时点亮）；中键：Home
 * - 滚轮：滚动
 * - 键盘：特殊键以 keycode 注入；文字用 INJECT_TEXT，非 ASCII（中文等）通过剪贴板粘贴
 */
export class InputHandler {
  private videoW = 0;
  private videoH = 0;
  private active = new Map<number, bigint>(); // 浏览器 pointerId -> scrcpy pointerId
  private keysDown = new Set<string>();
  private clipboardSeq = 1n;
  private ime: HTMLTextAreaElement;
  private abort = new AbortController();
  enabled = false;
  /** 每次触摸/点击时调用（用于恢复被浏览器挂起的 AudioContext） */
  onUserGesture: () => void = () => {};

  constructor(
    private surface: HTMLCanvasElement,
    private send: Send,
  ) {
    // 隐藏的输入框，用于接收键盘和输入法（中文）输入
    this.ime = document.createElement('textarea');
    this.ime.className = 'ime-sink';
    this.ime.setAttribute('autocomplete', 'off');
    this.ime.setAttribute('autocapitalize', 'off');
    this.ime.setAttribute('spellcheck', 'false');
    this.ime.setAttribute('aria-label', '键盘输入');
    surface.parentElement!.appendChild(this.ime);
    this.bind();
  }

  setVideoSize(w: number, h: number) {
    this.videoW = w;
    this.videoH = h;
  }

  focus() {
    this.ime.focus({ preventScroll: true });
  }

  blur() {
    this.ime.blur();
  }

  get focused() {
    return document.activeElement === this.ime;
  }

  private pos(e: { clientX: number; clientY: number }): Position | null {
    if (!this.videoW || !this.videoH) return null;
    const r = this.surface.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const x = ((e.clientX - r.left) / r.width) * this.videoW;
    const y = ((e.clientY - r.top) / r.height) * this.videoH;
    return {
      x: Math.min(Math.max(x, 0), this.videoW - 1),
      y: Math.min(Math.max(y, 0), this.videoH - 1),
      width: this.videoW,
      height: this.videoH,
    };
  }

  private bind() {
    const s = this.surface;
    const opt = { signal: this.abort.signal };
    const passiveFalse = { signal: this.abort.signal, passive: false };

    s.addEventListener('contextmenu', (e) => e.preventDefault(), opt);

    s.addEventListener(
      'pointerdown',
      (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        this.onUserGesture();
        // 只有鼠标操作才自动聚焦输入框；触屏设备上聚焦会弹出软键盘，改由工具栏「键盘」按钮打开
        if (e.pointerType === 'mouse') this.focus();
        if (e.pointerType === 'mouse' && e.button === 2) {
          this.send(backOrScreenOn(KeyAction.Down));
          this.send(backOrScreenOn(KeyAction.Up));
          return;
        }
        if (e.pointerType === 'mouse' && e.button === 1) {
          this.pressKey(Keycode.HOME);
          return;
        }
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        const p = this.pos(e);
        if (!p) return;
        const id = e.pointerType === 'mouse' ? POINTER_FINGER : BigInt(e.pointerId);
        this.active.set(e.pointerId, id);
        s.setPointerCapture(e.pointerId);
        this.send(injectTouch(MotionAction.Down, id, p, e.pointerType === 'mouse' ? 1 : e.pressure || 1));
      },
      passiveFalse,
    );

    const move = (e: PointerEvent) => {
      const id = this.active.get(e.pointerId);
      if (id === undefined) return;
      e.preventDefault();
      // 合并事件可以提供更高的采样率
      const events = e.getCoalescedEvents?.() ?? [e];
      for (const ev of events.length ? events : [e]) {
        const p = this.pos(ev);
        if (p) this.send(injectTouch(MotionAction.Move, id, p, e.pointerType === 'mouse' ? 1 : ev.pressure || 1));
      }
    };
    s.addEventListener('pointermove', move, passiveFalse);

    const up = (e: PointerEvent) => {
      const id = this.active.get(e.pointerId);
      if (id === undefined) return;
      this.active.delete(e.pointerId);
      const p = this.pos(e);
      if (p) this.send(injectTouch(e.type === 'pointercancel' ? MotionAction.Cancel : MotionAction.Up, id, p, 0));
    };
    s.addEventListener('pointerup', up, opt);
    s.addEventListener('pointercancel', up, opt);

    s.addEventListener(
      'wheel',
      (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        const p = this.pos(e);
        if (!p) return;
        const unit = e.deltaMode === 1 ? 3 : e.deltaMode === 2 ? 0.1 : 100;
        const clamp = (v: number) => Math.max(-16, Math.min(16, v));
        this.send(injectScroll(p, clamp(-e.deltaX / unit), clamp(-e.deltaY / unit)));
      },
      passiveFalse,
    );

    // ---------- 键盘 ----------
    const ime = this.ime;
    ime.addEventListener(
      'keydown',
      (e) => {
        if (!this.enabled || e.isComposing || e.key === 'Process') return;
        const keycode = CODE_TO_KEYCODE[e.code];
        if (keycode === undefined) return;
        const mod = e.ctrlKey || e.altKey || e.metaKey;
        // Ctrl/Cmd+V 交给 paste 事件，把电脑剪贴板粘贴到手机
        if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV') return;
        if (!mod && !NON_TEXT_CODES.has(e.code)) return; // 普通字符走 input 事件
        if (e.code.startsWith('Shift') || e.code.startsWith('Control') || e.code.startsWith('Alt') || e.code.startsWith('Meta')) return;
        e.preventDefault();
        this.keysDown.add(e.code);
        this.send(injectKeycode(KeyAction.Down, keycode, e.repeat ? 1 : 0, this.meta(e)));
      },
      opt,
    );
    ime.addEventListener(
      'keyup',
      (e) => {
        if (!this.keysDown.delete(e.code)) return;
        e.preventDefault();
        this.send(injectKeycode(KeyAction.Up, CODE_TO_KEYCODE[e.code], 0, this.meta(e)));
      },
      opt,
    );
    ime.addEventListener(
      'input',
      (e) => {
        if (!this.enabled || (e as InputEvent).isComposing) return;
        const text = ime.value;
        ime.value = '';
        if (text) this.sendText(text);
      },
      opt,
    );
    ime.addEventListener(
      'compositionend',
      (e) => {
        ime.value = '';
        if (this.enabled && e.data) this.sendText(e.data);
      },
      opt,
    );
    ime.addEventListener(
      'paste',
      (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        const text = e.clipboardData?.getData('text/plain');
        if (text) this.pasteText(text);
      },
      opt,
    );
    ime.addEventListener(
      'blur',
      () => {
        // 失焦时释放所有按下的键，避免卡键
        for (const code of this.keysDown) this.send(injectKeycode(KeyAction.Up, CODE_TO_KEYCODE[code]));
        this.keysDown.clear();
      },
      opt,
    );
  }

  private meta(e: KeyboardEvent) {
    return (
      (e.shiftKey ? Meta.Shift : 0) | (e.altKey ? Meta.Alt : 0) | (e.ctrlKey ? Meta.Ctrl : 0) | (e.metaKey ? Meta.Meta : 0)
    );
  }

  pressKey(keycode: number) {
    this.send(injectKeycode(KeyAction.Down, keycode));
    this.send(injectKeycode(KeyAction.Up, keycode));
  }

  /** ASCII 直接注入；包含中文等字符时经剪贴板粘贴（INJECT_TEXT 无法输入非 ASCII） */
  sendText(text: string) {
    if (/^[\x20-\x7e\n\t]*$/.test(text)) {
      for (let i = 0; i < text.length; i += 300) this.send(injectText(text.slice(i, i + 300)));
    } else {
      this.pasteText(text);
    }
  }

  /** 设置设备剪贴板并粘贴 */
  pasteText(text: string) {
    this.send(setClipboard(this.clipboardSeq++, text, true));
  }

  /** 只同步到设备剪贴板，不粘贴 */
  setDeviceClipboard(text: string) {
    this.send(setClipboard(this.clipboardSeq++, text, false));
  }

  releaseAll() {
    for (const [, id] of this.active) {
      if (this.videoW) this.send(injectTouch(MotionAction.Up, id, { x: 0, y: 0, width: this.videoW, height: this.videoH }, 0));
    }
    this.active.clear();
  }

  destroy() {
    this.abort.abort();
    this.ime.remove();
  }
}
