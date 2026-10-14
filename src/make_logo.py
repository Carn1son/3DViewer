"""3DViewer logo: the BoardV chip in green with 3DV knocked out of the body (transparent background)."""
import os, sys
from PIL import Image, ImageDraw, ImageFont
HERE = os.path.dirname(os.path.abspath(__file__))
G = (39, 194, 102, 255)
FONT = next(p for p in ['/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'] if os.path.exists(p))

def logo(px=512):
    k = 4; N = 512 * k
    im = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    s = lambda v: int(round(v * k))
    d.rounded_rectangle([s(111), s(111), s(401), s(401)], radius=s(38), fill=G)
    for c in (159, 207.5, 256, 304.5, 353):
        for box in ((c - 11, 20, c + 11, 89), (c - 11, 423, c + 11, 492), (20, c - 11, 89, c + 11), (423, c - 11, 492, c + 11)):
            d.rounded_rectangle([s(box[0]), s(box[1]), s(box[2]), s(box[3])], radius=s(4), fill=G)
    # knock the letters out of the body
    mask = Image.new('L', (N, N), 0)
    md = ImageDraw.Draw(mask)
    txt = '3DV'
    size = s(118)
    while True:
        f = ImageFont.truetype(FONT, size)
        b = md.textbbox((0, 0), txt, font=f)
        if b[2] - b[0] <= s(236): break
        size -= k
    w, h = b[2] - b[0], b[3] - b[1]
    md.text(((N - w) / 2 - b[0], (N - h) / 2 - b[1]), txt, font=f, fill=255)
    a = im.split()[3]
    from PIL import ImageChops
    im.putalpha(ImageChops.subtract(a, mask))
    return im.resize((px, px), Image.LANCZOS)

if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'img')
    os.makedirs(out, exist_ok=True)
    logo(512).save(os.path.join(out, 'logo.png'))
    print('ok')
