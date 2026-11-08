# Privacy-safe derivative of the owner's Zerion screenshot: the photo behind the translucent
# notifications (the owner's face) is destroyed, the notification text and icons stay crisp.
#   python3 scripts/privacy.py   (needs Pillow, numpy, scipy)
# In:  public/footage/owner/zerion-rescue-notifications.jpg        (untouched)
# Out: public/footage/owner/zerion-rescue-notifications-safe.jpg
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
SRC = os.path.join(ROOT, "public/footage/owner/zerion-rescue-notifications.jpg")
DST = os.path.join(ROOT, "public/footage/owner/zerion-rescue-notifications-safe.jpg")

im = Image.open(SRC).convert("RGB")
W, H = im.size
a = np.asarray(im).astype(np.float32)
lum = 0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]

# 1. Background: a flat dark field with a hint of the original, blurred far past recognition.
bg = np.asarray(im.filter(ImageFilter.GaussianBlur(90))).astype(np.float32)
bg = bg * 0.25 + 18

# 2. Panels (notification cards, header pills, status bar) as rounded rects, measured on the source.
cards = [(33, 280, 826, 434), (33, 455, 826, 596), (33, 617, 826, 770), (33, 791, 826, 932), (33, 952, 826, 1092), (33, 1113, 826, 1253)]
pills = [(515, 188, 735, 260), (754, 188, 826, 260)]
mask = Image.new("L", (W, H), 0)
d = ImageDraw.Draw(mask)
for r in cards: d.rounded_rectangle(r, radius=40, fill=255)
for r in pills: d.rounded_rectangle(r, radius=36, fill=255)
d.rounded_rectangle((30, 0, 826, 120), radius=40, fill=255)  # status bar pill
panel = np.asarray(mask.filter(ImageFilter.GaussianBlur(1.2))).astype(np.float32)[..., None] / 255.0

# 3. Strokes worth keeping: thin, high local contrast and bright (white text), or the coloured icons.
local = lum - ndimage.uniform_filter(lum, 9)
txt = np.clip((lum - 165) / 45, 0, 1) * np.clip((local - 6) / 18, 0, 1)
# the grey timestamps ("now", "1m ago") are dimmer: a lower bar in their column only
ts = np.zeros_like(lum); ts[:, 690:815] = 1
txt = np.maximum(txt, ts * np.clip((lum - 130) / 40, 0, 1) * np.clip((local - 10) / 16, 0, 1))
txt = ndimage.maximum_filter(txt, size=2) * 0.85 + txt * 0.15
sat = a.max(axis=2) - a.min(axis=2)
icons = np.zeros((H, W), np.float32)
for (x0, y0, x1, y1) in cards:
    cy = (y0 + y1) / 2
    # avatar (pink circle, emoji) and the small app badge, plus the emoji before each title
    box = (slice(int(cy - 75), int(cy + 75)), slice(50, 170))
    m = sat[box] > 40  # the pink avatar circle, its emoji and the blue app badge are saturated
    m = ndimage.binary_closing(m, iterations=3)
    m = ndimage.binary_fill_holes(m)
    icons[box] = np.maximum(icons[box], m.astype(np.float32))
    icons[y0 + 10:y0 + 70, 160:215] = np.clip((sat[y0 + 10:y0 + 70, 160:215] - 25) / 30, 0, 1)
icons = ndimage.gaussian_filter(icons, 1.0)
keep = np.clip(np.maximum(txt, icons), 0, 1)[..., None]

# 4. Panels get a flat frosted grey; the kept strokes go back on top at full detail.
card_fill = np.array([96, 96, 100], np.float32)
panels = card_fill * (1 - keep) + a * keep
out = bg * (1 - panel) + panels * panel
# Header text ("Zerion") and the status-bar clock and icons sit on the background: keep them too.
head = np.zeros((H, W), np.float32)
head[150:280, 40:330] = 1
head[0:120, 30:826] = 1
hk = (np.clip((lum - 170) / 40, 0, 1) * head)[..., None]
out = out * (1 - hk) + a * hk
Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(DST, quality=95)
print("wrote", DST)
