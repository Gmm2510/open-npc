# Draws the companion's default skin (64x64, slim arms) from simple shapes and colors.
#   python tools/make_skin.py <out.png> [preview.png]
import random, sys
from PIL import Image

random.seed(7)
W = 64
img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
px = img.load()

def shade(c, k):
    return tuple(max(0, min(255, int(v * k))) for v in c[:3]) + (255,)

def noisy(c, amt=0.06):
    return shade(c, 1 + random.uniform(-amt, amt))

def rect(x0, y0, x1, y1, col, amt=0.06):
    for y in range(y0, y1):
        for x in range(x0, x1):
            px[x, y] = noisy(col, amt)

def dot(x, y, col):
    px[x, y] = col + (255,) if len(col) == 3 else col

SKIN = (229, 184, 150)
SKIN_D = (205, 158, 125)
HAIR = (58, 36, 30)
HAIR_L = (84, 54, 42)
HOOD = (52, 128, 120)      # teal hoodie
HOOD_D = (40, 100, 94)
CORD = (235, 235, 228)
JEANS = (44, 56, 86)
JEANS_D = (34, 44, 68)
SHOE = (236, 236, 232)
SOLE = (180, 180, 176)
EYE = (60, 92, 60)
WHITE = (250, 250, 250)
LIP = (186, 104, 104)
BROW = (50, 32, 26)

# ---------- head (base layer)
# faces: right (0,8) front (8,8) left (16,8) back (24,8); top (8,0) bottom (16,0)
rect(8, 0, 16, 8, HAIR)                 # top of head: hair
rect(16, 0, 24, 8, SKIN_D)              # under the chin
rect(24, 8, 32, 16, HAIR)               # back: hair
for x0 in (0, 16):                      # sides: hair with an ear and some skin at the front edge
    rect(x0, 8, x0 + 8, 16, HAIR)
# right side (x 0..7): the face is at its right edge (x=7); left side (16..23): face at its left edge (x=16)
for y in range(11, 16):
    dot(7, y, noisy(SKIN)); dot(16, y, noisy(SKIN))
for y in range(12, 14):
    dot(6, y, noisy(SKIN_D)); dot(17, y, noisy(SKIN_D))   # ears peeking through
# front face
rect(8, 8, 16, 16, SKIN, 0.03)
for x in range(8, 16):
    dot(x, 8, noisy(HAIR)); dot(x, 9, noisy(HAIR))
for x in (8, 9, 11, 12, 14, 15):        # bangs
    dot(x, 10, noisy(HAIR_L if x % 2 else HAIR))
dot(8, 11, noisy(HAIR)); dot(15, 11, noisy(HAIR))
dot(8, 12, noisy(HAIR)); dot(15, 12, noisy(HAIR))
dot(9, 11, BROW); dot(10, 11, BROW); dot(13, 11, BROW); dot(14, 11, BROW)   # brows
dot(9, 12, WHITE); dot(10, 12, EYE); dot(13, 12, EYE); dot(14, 12, WHITE)  # eyes
dot(10, 13, noisy(SKIN_D)); dot(13, 13, noisy(SKIN_D))
dot(9, 13, (236, 164, 150)); dot(14, 13, (236, 164, 150))                  # cheeks
dot(11, 14, LIP); dot(12, 14, LIP)
dot(11, 13, noisy(SKIN_D, 0.0)) if False else None

# ---------- hat layer: hair volume and long strands framing the face
# hat faces: right (32,8) front (40,8) left (48,8) back (56,8); top (40,0)
rect(40, 0, 48, 8, HAIR_L, 0.08)
for x in range(40, 48):
    dot(x, 8, noisy(HAIR_L))
for x in (40, 41, 46, 47):
    dot(x, 9, noisy(HAIR))
for y in range(9, 16):
    dot(40, y, noisy(HAIR)); dot(47, y, noisy(HAIR))
rect(56, 8, 64, 16, HAIR_L, 0.08)       # back of the hair
for x0 in (32, 48):                     # sides of the hair, open where the ear is
    rect(x0, 8, x0 + 8, 16, HAIR_L, 0.08)
for y in range(11, 15):
    for x in (38, 39):
        px[x, y] = (0, 0, 0, 0)
    for x in (48, 49):
        px[x, y] = (0, 0, 0, 0)

# ---------- body: hoodie
rect(20, 16, 28, 20, HOOD)              # top (shoulders)
rect(28, 16, 36, 20, HOOD_D)            # bottom
rect(16, 20, 20, 32, HOOD_D)            # right side
rect(20, 20, 28, 32, HOOD)              # front
rect(28, 20, 32, 32, HOOD_D)            # left side
rect(32, 20, 40, 32, HOOD)              # back
for x in range(20, 28):                 # hem and pocket
    dot(x, 31, noisy(HOOD_D)); 
for x in range(21, 27):
    dot(x, 27, noisy(HOOD_D))
dot(22, 21, CORD); dot(22, 22, CORD); dot(25, 21, CORD); dot(25, 22, CORD)  # drawstrings
dot(23, 20, noisy(SKIN)); dot(24, 20, noisy(SKIN))                          # neck
for x in range(32, 40):                 # long hair down the back
    for y in range(20, 26):
        dot(x, y, noisy(HAIR))
for x in range(33, 39):
    dot(x, 26, noisy(HAIR))
# jacket layer: hood resting on the shoulders (front edge and back)
for x in range(20, 28):
    dot(x, 36, noisy(HOOD_D))
for x in (20, 27):
    dot(x, 37, noisy(HOOD_D))

# ---------- arms (slim, 3 wide): hoodie sleeves with hands
def arm(top, bottom, faces):
    # top/bottom: (x, y) of 3x4 caps; faces: list of (x, y, w) for right, front, left, back strips (12 tall)
    rect(top[0], top[1], top[0] + 3, top[1] + 4, HOOD)
    rect(bottom[0], bottom[1], bottom[0] + 3, bottom[1] + 4, SKIN)
    for (x, y, w) in faces:
        rect(x, y, x + w, y + 9, HOOD)
        rect(x, y + 9, x + w, y + 10, HOOD_D)   # cuff
        rect(x, y + 10, x + w, y + 12, SKIN, 0.03)
arm((44, 16), (47, 16), [(40, 20, 4), (44, 20, 3), (47, 20, 4), (51, 20, 3)])   # right arm
arm((36, 48), (39, 48), [(32, 52, 4), (36, 52, 3), (39, 52, 4), (43, 52, 3)])   # left arm

# ---------- legs: jeans and sneakers
def leg(top, bottom, faces):
    rect(top[0], top[1], top[0] + 4, top[1] + 4, JEANS)
    rect(bottom[0], bottom[1], bottom[0] + 4, bottom[1] + 4, SOLE)
    for i, (x, y) in enumerate(faces):
        rect(x, y, x + 4, y + 10, JEANS if i in (1, 3) else JEANS_D)
        rect(x, y + 10, x + 4, y + 11, SHOE)
        rect(x, y + 11, x + 4, y + 12, SOLE, 0.02)
leg((4, 16), (8, 16), [(0, 20), (4, 20), (8, 20), (12, 20)])       # right leg
leg((20, 48), (24, 48), [(16, 52), (20, 52), (24, 52), (28, 52)])  # left leg
# hoodie hangs over the top of the jeans (pants layer, front row)
for x in list(range(4, 8)) + list(range(20, 24)):
    pass

out = sys.argv[1]
img.save(out)
if len(sys.argv) > 2:
    # a flat front view for a quick look, 8x scale: head, body, arms, legs
    pv = Image.new("RGBA", (16 * 8 + 8, 32 * 8 + 8), (200, 210, 220, 255))
    def paste(src, dst):
        sx, sy, w, h = src
        part = img.crop((sx, sy, sx + w, sy + h)).resize((w * 8, h * 8), Image.NEAREST)
        pv.alpha_composite(part, dst)
    paste((8, 8, 8, 8), (4 * 8 + 4, 4))           # head front
    paste((40, 8, 8, 8), (4 * 8 + 4, 4))          # hat front
    paste((20, 20, 8, 12), (4 * 8 + 4, 8 * 8 + 4))  # body
    paste((44, 20, 3, 12), (1 * 8 + 4, 8 * 8 + 4))  # right arm (viewer's left)
    paste((36, 52, 3, 12), (12 * 8 + 4, 8 * 8 + 4)) # left arm
    paste((4, 20, 4, 12), (4 * 8 + 4, 20 * 8 + 4))  # right leg
    paste((20, 52, 4, 12), (8 * 8 + 4, 20 * 8 + 4)) # left leg
    pv.save(sys.argv[2])
