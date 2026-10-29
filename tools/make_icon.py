# 生成 VS Code 扩展图标：一方砚台（外形椭圆 + 墨池 + 一点墨）
# 纯标准库，不依赖 Pillow。产物 images/icon.png（128x128 RGBA）

import os
import struct
import zlib

W = H = 128
BG = (0, 0, 0, 0)


def new():
    return [[BG for _ in range(W)] for _ in range(H)]


def ellipse(buf, cx, cy, rx, ry, color, ring=0.0):
    for y in range(H):
        for x in range(W):
            d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2
            if ring > 0.0:
                if ring ** 2 <= d <= 1.0:
                    buf[y][x] = color
            elif d <= 1.0:
                buf[y][x] = color


def round_rect(buf, x0, y0, x1, y1, r, color):
    for y in range(max(0, y0), min(H, y1)):
        for x in range(max(0, x0), min(W, x1)):
            dx = max(x0 + r - x, x - (x1 - 1 - r), 0)
            dy = max(y0 + r - y, y - (y1 - 1 - r), 0)
            if dx * dx + dy * dy <= r * r:
                buf[y][x] = color


buf = new()

# 砚台外形：一圈石身
round_rect(buf, 8, 20, 120, 116, 26, (58, 63, 71, 255))
# 石身内凹的墨池
ellipse(buf, 64, 68, 46, 34, (17, 20, 24, 255))
# 墨池边缘的一圈亮口
ellipse(buf, 64, 68, 46, 34, (96, 106, 118, 255), ring=0.86)
# 池里的墨：偏下偏左一点，留出反光
ellipse(buf, 58, 74, 30, 20, (10, 12, 15, 255))
# 右上角一小片反光
ellipse(buf, 78, 58, 12, 7, (74, 86, 100, 255))
# 砚台前端一滴将落未落的墨
ellipse(buf, 98, 104, 7, 7, (26, 30, 36, 255))

raw = bytearray()
for y in range(H):
    raw.append(0)  # filter type: None
    for x in range(W):
        raw += bytes(buf[y][x])


def chunk(tag, data):
    return (struct.pack('>I', len(data)) + tag + data
            + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))


png = (b'\x89PNG\r\n\x1a\n'
       + chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 6, 0, 0, 0))
       + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
       + chunk(b'IEND', b''))

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'images', 'icon.png')
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, 'wb') as f:
    f.write(png)
print('wrote', os.path.normpath(out), len(png), 'bytes')
