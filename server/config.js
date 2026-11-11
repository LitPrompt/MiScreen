import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

export const SCRCPY_VERSION = env.SCRCPY_VERSION || '5.0.1';

export const config = {
  root,
  host: env.HOST || '0.0.0.0',
  port: Number(env.PORT || 8080),
  // 0 表示关闭 HTTPS。WebCodecs / AudioWorklet 只能在安全上下文（https 或 localhost）中使用。
  httpsPort: Number(env.HTTPS_PORT ?? 8443),
  tlsCert: env.TLS_CERT || '',
  tlsKey: env.TLS_KEY || '',
  dataDir: path.resolve(env.DATA_DIR || path.join(root, 'data')),
  webDir: path.resolve(env.WEB_DIR || path.join(root, 'dist')),
  adbPath: env.ADB_PATH || 'adb',
  scrcpyVersion: SCRCPY_VERSION,
  scrcpyServerPath: path.resolve(
    env.SCRCPY_SERVER_PATH || path.join(root, 'vendor', `scrcpy-server-v${SCRCPY_VERSION}`),
  ),
  // 可选的 HTTP Basic 认证，两个都设置才生效
  authUser: env.AUTH_USER || '',
  authPassword: env.AUTH_PASSWORD || '',
  // WebSocket 发送缓冲超过该值时丢弃视频帧并请求关键帧，避免延迟累积
  maxWsBuffer: Number(env.MAX_WS_BUFFER || 4 * 1024 * 1024),
};
