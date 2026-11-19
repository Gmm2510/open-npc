# Draws the mod's icon from the companion's skin: her face (with the hair layer on top), scaled up with sharp pixels.
#   python tools/make_icon.py <skin.png> <icon.png>
import sys
from PIL import Image

skin = Image.open(sys.argv[1]).convert("RGBA")
face = skin.crop((8, 8, 16, 16))
face.alpha_composite(skin.crop((40, 8, 48, 16)))
face.resize((128, 128), Image.NEAREST).save(sys.argv[2])
