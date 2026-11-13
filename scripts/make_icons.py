"""Draw the app's icons: a white "SAT" flashcard over a lighter one, on green.

Writes the home-screen icons (icons/icon-512.png, icon-192.png, and
apple-touch-icon.png, which iOS rounds itself) and the browser tab icons
(favicon.ico and icons/favicon-32.png, with the corners rounded here since
browsers show them square). The green is --good in styles.css.

Needs Pillow and macOS's Arial Bold. After changing the icon, retake the install
guide screenshots (scripts/install-guide/build_pdf.py), since they show it.

Usage: python3 scripts/make_icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "icons"
FONT = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
S = 1024  # drawn at this size, then scaled down

GREEN = (31, 122, 77)
BACK_CARD = (108, 186, 140)
LINE = (227, 243, 234)
WHITE = (255, 255, 255)


def draw():
    img = Image.new("RGB", (S, S), GREEN)
    d = ImageDraw.Draw(img)
    # A second card peeking out behind the front one, like a flashcard stack.
    d.rounded_rectangle((232, 196, 832, 676), 56, fill=BACK_CARD)
    d.rounded_rectangle((192, 276, 792, 756), 56, fill=WHITE)
    d.text((492, 516), "SAT", font=ImageFont.truetype(FONT, 230), fill=GREEN, anchor="mm")
    d.rounded_rectangle((322, 650, 662, 676), 13, fill=LINE)
    return img


def main():
    img = draw()
    for name, size in [("icon-512.png", 512), ("icon-192.png", 192), ("apple-touch-icon.png", 180)]:
        img.resize((size, size), Image.LANCZOS).save(ICONS / name)
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), 225, fill=255)
    rounded = img.convert("RGBA")
    rounded.putalpha(mask)
    rounded.save(ROOT / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    rounded.resize((32, 32), Image.LANCZOS).save(ICONS / "favicon-32.png")
    print(f"Wrote icons to {ICONS} and {ROOT / 'favicon.ico'}")


if __name__ == "__main__":
    main()
