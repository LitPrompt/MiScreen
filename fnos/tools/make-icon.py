"""生成 fnOS 应用图标（无第三方依赖）：python3 make-icon.py <尺寸> <输出.png>"""
import math, struct, sys, zlib

def sd_round_rect(px, py, cx, cy, hw, hh, r):
    qx = abs(px - cx) - hw + r
    qy = abs(py - cy) - hh + r
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r

def sd_segment(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)

def render(n):
    s = n / 256  # 以 256 为设计尺寸
    bg_top, bg_bot = (255, 132, 40), (255, 94, 0)
    rows = []
    for y in range(n):
        row = bytearray([0])
        for x in range(n):
            px, py = (x + 0.5) / s, (y + 0.5) / s
            aa = 1 / s
            # 背景：圆角方块 + 竖向渐变
            d = sd_round_rect(px, py, 128, 128, 116, 116, 52)
            a_bg = max(0, min(1, 0.5 - d / aa))
            t = py / 256
            col = [bg_top[i] * (1 - t) + bg_bot[i] * t for i in range(3)]
            # 手机外框（描边）
            d_phone = abs(sd_round_rect(px, py, 128, 128, 50, 84, 20)) - 9
            # 底部横条
            d_bar = sd_segment(px, py, 112, 186, 144, 186) - 8
            # 屏幕上的小三角（播放/投屏）
            d_fg = min(d_phone, d_bar)
            a_fg = max(0, min(1, 0.5 - d_fg / aa))
            col = [c * (1 - a_fg) + 255 * a_fg for c in col]
            row += bytes([round(col[0]), round(col[1]), round(col[2]), round(255 * a_bg)])
        rows.append(bytes(row))
    raw = b''.join(rows)
    def chunk(tag, data):
        c = tag + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', n, n, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))

if __name__ == '__main__':
    open(sys.argv[2], 'wb').write(render(int(sys.argv[1])))
