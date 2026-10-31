# 从 images/yan-logo.png（与 yan-web/assets/yan-logo.png 同一份新 logo）生成
# VS Code 扩展图标 images/icon.png（128x128 RGBA）。
# 纯标准库实现：解 PNG → 面积平均缩小 → 重新编码，不依赖 Pillow。
#
# 用法：python tools/make_icon.py
# 换 logo 时：把 yan-web/assets/yan-logo.png 覆盖到 images/yan-logo.png，再跑一次本脚本。

import os
import struct
import zlib

SIZE = 128

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'images', 'yan-logo.png')
OUT = os.path.join(ROOT, 'images', 'icon.png')


def read_png(path):
    """读 8bit、非隔行的 RGB/RGBA PNG，返回 (宽, 高, RGBA 字节串)。"""
    with open(path, 'rb') as f:
        data = f.read()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise SystemExit('%s 不是 PNG 文件' % path)

    pos = 8
    idat = bytearray()
    width = height = depth = ctype = interlace = None
    while pos < len(data):
        (length,) = struct.unpack('>I', data[pos:pos + 4])
        tag = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if tag == b'IHDR':
            width, height, depth, ctype, _, _, interlace = struct.unpack('>IIBBBBB', body)
        elif tag == b'IDAT':
            idat += body
        elif tag == b'IEND':
            break

    if depth != 8 or interlace != 0:
        raise SystemExit('只支持 8bit 非隔行 PNG（当前 depth=%s, interlace=%s）' % (depth, interlace))
    channels = {2: 3, 6: 4}.get(ctype)
    if channels is None:
        raise SystemExit('只支持 RGB/RGBA PNG（当前 colorType=%s）' % ctype)

    raw = zlib.decompress(bytes(idat))
    stride = width * channels
    pixels = bytearray(height * stride)
    prev = bytearray(stride)
    p = 0
    for y in range(height):
        ftype = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if ftype == 1:      # Sub
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif ftype == 2:    # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ftype == 3:    # Average
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:    # Paeth
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                up = prev[i]
                upleft = prev[i - channels] if i >= channels else 0
                pa = abs(up - upleft)
                pb = abs(left - upleft)
                pc = abs(left + up - 2 * upleft)
                pred = left if (pa <= pb and pa <= pc) else (up if pb <= pc else upleft)
                line[i] = (line[i] + pred) & 0xFF
        elif ftype != 0:
            raise SystemExit('第 %d 行用了未知 filter 类型 %d' % (y, ftype))
        pixels[y * stride:(y + 1) * stride] = line
        prev = line

    if channels == 3:
        rgba = bytearray(width * height * 4)
        for i in range(width * height):
            rgba[i * 4:i * 4 + 3] = pixels[i * 3:i * 3 + 3]
            rgba[i * 4 + 3] = 255
        pixels = rgba
    return width, height, pixels


def spans(src_len, dst_len):
    """每个目标像素覆盖到的源像素及其面积权重（box filter）。"""
    scale = src_len / dst_len
    out = []
    for d in range(dst_len):
        start = d * scale
        end = (d + 1) * scale
        parts = []
        for i in range(int(start), min(int(end) + 1, src_len)):
            lo = max(start, i)
            hi = min(end, i + 1)
            if hi > lo:
                parts.append((i, hi - lo))
        out.append(parts)
    return out


def resize(sw, sh, src, dw, dh):
    """面积平均缩小，颜色按 alpha 预乘累加，避免边缘发黑。"""
    xs = spans(sw, dw)
    ys = spans(sh, dh)
    out = bytearray(dw * dh * 4)
    for dy, yparts in enumerate(ys):
        for dx, xparts in enumerate(xs):
            area = 0.0
            r = g = b = a = 0.0
            for sy, wy in yparts:
                base = sy * sw
                for sx, wx in xparts:
                    w = wx * wy
                    i = (base + sx) * 4
                    alpha = src[i + 3] / 255.0
                    area += w
                    r += src[i] * alpha * w
                    g += src[i + 1] * alpha * w
                    b += src[i + 2] * alpha * w
                    a += src[i + 3] * w
            o = (dy * dw + dx) * 4
            if area <= 0.0 or a <= 0.0:
                continue
            out[o] = min(255, int(r / a * 255.0 + 0.5))
            out[o + 1] = min(255, int(g / a * 255.0 + 0.5))
            out[o + 2] = min(255, int(b / a * 255.0 + 0.5))
            out[o + 3] = min(255, int(a / area + 0.5))
    return out


def write_png(path, w, h, rgba):
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)  # filter type: None
        raw += rgba[y * stride:(y + 1) * stride]

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
           + chunk(b'IEND', b''))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(png)
    return len(png)


if __name__ == '__main__':
    sw, sh, src = read_png(SRC)
    rgba = resize(sw, sh, src, SIZE, SIZE)
    size = write_png(OUT, SIZE, SIZE, rgba)
    print('wrote', os.path.normpath(OUT), size, 'bytes (%dx%d -> %dx%d)'
          % (sw, sh, SIZE, SIZE))
