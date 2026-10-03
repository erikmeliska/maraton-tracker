# Generuje PWA ikony z tvaru trasy (route.json): ružové pozadie, biela trasa, modrá bodka bežca.
import json, math
from PIL import Image, ImageDraw
pts = json.load(open('route.json'))['points']
lat0 = sum(p[0] for p in pts) / len(pts)
xy = [(p[1] * math.cos(math.radians(lat0)), -p[0]) for p in pts]
minx, maxx = min(x for x, _ in xy), max(x for x, _ in xy)
miny, maxy = min(y for _, y in xy), max(y for _, y in xy)

def icon(size, safe, rounded):
    S = size * 4  # supersampling
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    bg = (225, 29, 72, 255)
    if rounded: d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=bg)
    else: d.rectangle([0, 0, S, S], fill=bg)
    box = S * safe  # trasa sa zmestí do stredového štvorca
    sc = box / max(maxx - minx, maxy - miny)
    ox = (S - (maxx - minx) * sc) / 2 - minx * sc
    oy = (S - (maxy - miny) * sc) / 2 - miny * sc
    line = [(x * sc + ox, y * sc + oy) for x, y in xy]
    w = max(4, int(S * 0.02))
    d.line(line, fill=(255, 255, 255, 255), width=w, joint='curve')
    sx, sy = line[0]; r = S * 0.035
    d.ellipse([sx - r, sy - r, sx + r, sy + r], fill=(5, 150, 105, 255), outline=(255, 255, 255, 255), width=w // 2)
    bx, by = line[len(line) * 2 // 5]; r = S * 0.05
    d.ellipse([bx - r, by - r, bx + r, by + r], fill=(37, 99, 235, 255), outline=(255, 255, 255, 255), width=w // 2)
    return im.resize((size, size), Image.LANCZOS)

icon(192, 0.72, True).save('icons/icon-192.png')
icon(512, 0.72, True).save('icons/icon-512.png')
icon(512, 0.56, False).save('icons/icon-maskable-512.png')   # bezpečná zóna pre Android masky
icon(180, 0.66, False).save('icons/apple-touch-icon.png')    # iOS si zaoblí sám
print('ok')
