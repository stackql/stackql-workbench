"""Writes a 1024x1024 app icon PNG using only the standard library.

Design: a Classic Blue (#0F4C81) rounded square with a white prompt glyph,
a chevron and a cursor bar, standing for a query prompt.
"""

import math
import struct
import sys
import zlib

SIZE = 1024
BLUE = (0x0F, 0x4C, 0x81)
WHITE = (255, 255, 255)


def rounded_rect_sdf(x, y, half, radius):
    dx = abs(x) - (half - radius)
    dy = abs(y) - (half - radius)
    outside = math.hypot(max(dx, 0.0), max(dy, 0.0))
    inside = min(max(dx, dy), 0.0)
    return outside + inside - radius


def segment_dist(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    t = max(0.0, min(1.0, (wx * vx + wy * vy) / (vx * vx + vy * vy)))
    return math.hypot(px - (ax + t * vx), py - (ay + t * vy))


def coverage(dist):
    """Maps a signed distance to an anti-aliased coverage in 0..1."""
    return max(0.0, min(1.0, 0.5 - dist))


def main(path):
    c = SIZE / 2
    stroke = 44.0
    # Chevron: two strokes meeting at a point on the right.
    ax, ay = 300.0, 330.0
    mx, my = 500.0, 512.0
    bx, by = 300.0, 694.0
    # Cursor bar.
    ux0, ux1, uy = 560.0, 740.0, 694.0

    rows = bytearray()
    for y in range(SIZE):
        rows.append(0)
        for x in range(SIZE):
            px, py = x + 0.5, y + 0.5
            bg = coverage(rounded_rect_sdf(px - c, py - c, 472.0, 190.0))
            if bg <= 0.0:
                rows.extend((0, 0, 0, 0))
                continue
            d = min(
                segment_dist(px, py, ax, ay, mx, my),
                segment_dist(px, py, mx, my, bx, by),
                segment_dist(px, py, ux0, uy, ux1, uy),
            )
            fg = coverage(d - stroke)
            r = round(BLUE[0] + (WHITE[0] - BLUE[0]) * fg)
            g = round(BLUE[1] + (WHITE[1] - BLUE[1]) * fg)
            b = round(BLUE[2] + (WHITE[2] - BLUE[2]) * fg)
            rows.extend((r, g, b, round(255 * bg)))

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(rows), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(png)


if __name__ == "__main__":
    main(sys.argv[1])
