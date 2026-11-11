// scrcpy v5 控制消息序列化（与 app/src/control_msg.c 保持一致，大端序）

export const MsgType = {
  InjectKeycode: 0,
  InjectText: 1,
  InjectTouch: 2,
  InjectScroll: 3,
  BackOrScreenOn: 4,
  ExpandNotificationPanel: 5,
  ExpandSettingsPanel: 6,
  CollapsePanels: 7,
  GetClipboard: 8,
  SetClipboard: 9,
  SetDisplayPower: 10,
  RotateDevice: 11,
  OpenHardKeyboardSettings: 15,
  StartApp: 16,
  ResetVideo: 17,
} as const;

export const KeyAction = { Down: 0, Up: 1 } as const;
export const MotionAction = { Down: 0, Up: 1, Move: 2, Cancel: 3, HoverMove: 7 } as const;

export const POINTER_MOUSE = -1n;
export const POINTER_FINGER = -2n;

export const Meta = {
  Shift: 0x1 | 0x40,
  Alt: 0x2 | 0x10,
  Ctrl: 0x1000 | 0x2000,
  Meta: 0x10000 | 0x20000,
} as const;

const enc = new TextEncoder();

function u16fp(f: number): number {
  const u = Math.round(Math.min(Math.max(f, 0), 1) * 0x10000);
  return u >= 0xffff ? 0xffff : u;
}

function i16fp(f: number): number {
  let i = Math.round(Math.min(Math.max(f, -1), 1) * 0x8000);
  if (i >= 0x7fff) i = 0x7fff;
  return i;
}

export interface Position {
  x: number;
  y: number;
  width: number;
  height: number;
}

function writePosition(v: DataView, off: number, p: Position) {
  v.setInt32(off, Math.round(p.x));
  v.setInt32(off + 4, Math.round(p.y));
  v.setUint16(off + 8, p.width);
  v.setUint16(off + 10, p.height);
}

export function injectKeycode(action: number, keycode: number, repeat = 0, metaState = 0): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(14);
  const v = new DataView(b.buffer);
  b[0] = MsgType.InjectKeycode;
  b[1] = action;
  v.setUint32(2, keycode);
  v.setUint32(6, repeat);
  v.setUint32(10, metaState);
  return b;
}

/** INJECT_TEXT 只支持设备 KeyCharacterMap 能表示的字符（基本是 ASCII），最多 300 字节 */
export function injectText(text: string): Uint8Array<ArrayBuffer> {
  const t = enc.encode(text).subarray(0, 300);
  const b = new Uint8Array(5 + t.length);
  new DataView(b.buffer).setUint32(1, t.length);
  b[0] = MsgType.InjectText;
  b.set(t, 5);
  return b;
}

export function injectTouch(
  action: number,
  pointerId: bigint,
  pos: Position,
  pressure: number,
  actionButton = 0,
  buttons = 0,
): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(32);
  const v = new DataView(b.buffer);
  b[0] = MsgType.InjectTouch;
  b[1] = action;
  v.setBigUint64(2, BigInt.asUintN(64, pointerId));
  writePosition(v, 10, pos);
  v.setUint16(22, u16fp(pressure));
  v.setUint32(24, actionButton);
  v.setUint32(28, buttons);
  return b;
}

/** hscroll/vscroll 取值范围 [-16, 16]，1 约等于鼠标滚轮一格 */
export function injectScroll(pos: Position, hscroll: number, vscroll: number, buttons = 0): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(21);
  const v = new DataView(b.buffer);
  b[0] = MsgType.InjectScroll;
  writePosition(v, 1, pos);
  v.setInt16(13, i16fp(hscroll / 16));
  v.setInt16(15, i16fp(vscroll / 16));
  v.setUint32(17, buttons);
  return b;
}

export function backOrScreenOn(action: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([MsgType.BackOrScreenOn, action]);
}

export function simple(type: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([type]);
}

export function getClipboard(copyKey = 0): Uint8Array<ArrayBuffer> {
  return new Uint8Array([MsgType.GetClipboard, copyKey]);
}

export function setClipboard(sequence: bigint, text: string, paste: boolean): Uint8Array<ArrayBuffer> {
  const t = enc.encode(text);
  const b = new Uint8Array(14 + t.length);
  const v = new DataView(b.buffer);
  b[0] = MsgType.SetClipboard;
  v.setBigUint64(1, sequence);
  b[9] = paste ? 1 : 0;
  v.setUint32(10, t.length);
  b.set(t, 14);
  return b;
}

export function setDisplayPower(on: boolean): Uint8Array<ArrayBuffer> {
  return new Uint8Array([MsgType.SetDisplayPower, on ? 1 : 0]);
}

/** 应用名或包名；前缀 "+" 表示强制停止后再启动 */
export function startApp(name: string): Uint8Array<ArrayBuffer> {
  const t = enc.encode(name).subarray(0, 255);
  const b = new Uint8Array(2 + t.length);
  b[0] = MsgType.StartApp;
  b[1] = t.length;
  b.set(t, 2);
  return b;
}

// ---------- Android 键码 ----------
export const Keycode = {
  HOME: 3,
  BACK: 4,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  MENU: 82,
  APP_SWITCH: 187,
  VOLUME_MUTE: 164,
  MEDIA_PLAY_PAUSE: 85,
} as const;

/** KeyboardEvent.code -> Android keycode */
export const CODE_TO_KEYCODE: Record<string, number> = {
  Enter: 66,
  NumpadEnter: 160,
  Backspace: 67,
  Delete: 112,
  Tab: 61,
  Escape: 111,
  Space: 62,
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Home: 122,
  End: 123,
  PageUp: 92,
  PageDown: 93,
  Insert: 124,
  Minus: 69,
  Equal: 70,
  BracketLeft: 71,
  BracketRight: 72,
  Backslash: 73,
  Semicolon: 74,
  Quote: 75,
  Slash: 76,
  Comma: 55,
  Period: 56,
  Backquote: 68,
  ShiftLeft: 59,
  ShiftRight: 60,
  ControlLeft: 113,
  ControlRight: 114,
  AltLeft: 57,
  AltRight: 58,
  MetaLeft: 117,
  MetaRight: 118,
  CapsLock: 115,
  ContextMenu: 82,
};
for (let i = 0; i < 26; i++) CODE_TO_KEYCODE[`Key${String.fromCharCode(65 + i)}`] = 29 + i;
for (let i = 0; i < 10; i++) CODE_TO_KEYCODE[`Digit${i}`] = 7 + i;
for (let i = 0; i < 10; i++) CODE_TO_KEYCODE[`Numpad${i}`] = 144 + i;
for (let i = 1; i <= 12; i++) CODE_TO_KEYCODE[`F${i}`] = 130 + i;

/** 不产生文字、需要以按键形式注入的键 */
export const NON_TEXT_CODES = new Set([
  'Enter', 'NumpadEnter', 'Backspace', 'Delete', 'Tab', 'Escape',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown', 'Insert',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);
