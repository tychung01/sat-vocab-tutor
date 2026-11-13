"""Build install.pdf, the step-by-step guide to adding SAT Words to an iPhone home screen.

The screenshots come from a UI test that taps through Safari in the iOS Simulator
(ShotsUITests/Tour.swift). To retake them:

    cd scripts/install-guide && xcodegen generate
    TEST_RUNNER_OUT_DIR=<scratch folder> xcodebuild test -project Shots.xcodeproj -scheme Shots \
        -destination "id=<booted iPhone simulator>" -only-testing:ShotsUITests/Tour/testTour
    ... -only-testing:ShotsUITests/Tour/testOpen      # the app opened from the home screen
    ... -only-testing:ShotsUITests/Tour/testHome      # then retake the home screen without the runner:
    xcrun simctl uninstall booted local.satwords.Shots
    xcrun simctl uninstall booted local.satwords.ShotsUITests.xctrunner
    xcrun simctl io booted screenshot <scratch folder>/06-home.png

Use a scratch folder for TEST_RUNNER_OUT_DIR (the simulator can't write into the
home folder) and copy the PNGs and frames.json into screenshots/. The test saves NN-*.png and
frames.json (the frame, in points, of the button tapped on each screenshot). This
script circles those buttons, lays the steps out as HTML, and prints it to
install.pdf at the repo root with headless Chrome.

Usage: python3 scripts/install-guide/build_pdf.py
"""

import base64
import io
import json
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
SHOTS = HERE / "screenshots"
OUT = HERE.parents[1] / "install.pdf"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
SCALE = 3  # screenshot pixels per point
RING = (247, 103, 7)  # orange, so it stands out from the app's blue
SITE = "sat-word-study-bfabd.firebaseapp.com"

# (shot, title, instructions as HTML, optional crop height in points)
STEPS = [
    ("01-site", "Open the site in Safari",
     f"<p>Open <b>Safari</b> and go to:</p><p class='url'>{SITE}</p>"
     "<p>Then tap the <b>Page Menu</b> button (☰) at the left of the address bar.</p>"
     "<p class='note'>You don't need to sign in yet. You'll sign in inside the app in step 7.</p>", None),
    ("02-menu", "Tap Share",
     "<p>In the menu that opens, tap <b>Share</b>.</p>"
     "<p class='note'>On some iPhones, a Share button (a square with an arrow ⬆) is right in the "
     "bottom bar. If you see one, tap it and go on to step 3.</p>", None),
    ("03-share", "Tap View More",
     "<p>The share sheet slides up. Tap <b>View More</b> to see the full list of actions.</p>", None),
    ("04-more", "Tap Add to Home Screen",
     "<p>Tap <b>Add to Home Screen</b>.</p>"
     "<p class='note'>Not in the list? Scroll to the bottom, tap <b>Edit Actions…</b>, and add it.</p>", None),
    ("05-add", "Tap Add",
     "<p>You'll see the app's icon and its name, <b>SAT Words</b>. Leave <b>Open as Web App</b> "
     "turned on, then tap <b>Add</b> at the top right.</p>", 420),
    ("06-home", "Open SAT Words",
     "<p>The <b>SAT Words</b> icon is now on your home screen. Tap it to open the app.</p>", None),
    ("07-app", "Sign in",
     "<p>The app opens full-screen, without Safari's address bar. Tap <b>Sign in with Google</b> "
     "and choose the account your teacher invited.</p>"
     "<p class='note'>The home-screen app keeps its own sign-in, separate from Safari. Even if you "
     "already signed in on the website, you'll sign in once more here. After that, it remembers you.</p>", None),
]


def ring(img, frame, pad=6):
    x, y, w, h = (v * SCALE for v in frame)
    p = pad * SCALE
    ImageDraw.Draw(img).rounded_rectangle(
        (x - p, y - p, x + w + p, y + h + p), radius=16 * SCALE, outline=RING, width=4 * SCALE)


def processed(shot, crop, frames):
    img = Image.open(SHOTS / f"{shot}.png").convert("RGB")
    if shot in frames:
        ring(img, frames[shot])
    if crop:
        img = img.crop((0, 0, img.width, crop * SCALE))
    img.thumbnail((700, 1600))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=88)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def step_html(n, shot, title, body, src):
    return f"""<section class="step">
  <div class="head"><span class="num">{n}</span><h2>{title}</h2></div>
  <div class="body">{body}</div>
  <img src="{src}" alt="Step {n}: {title}">
</section>"""


CSS = """
@page { size: letter; margin: 0.55in 0.6in; }
* { box-sizing: border-box; }
body { font: 11pt/1.45 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #1d1f23; margin: 0; }
h1 { font-size: 24pt; margin: 0 0 4pt; }
.lead { font-size: 12pt; color: #4a4f57; margin: 0 0 10pt; }
.need { background: #e6ecfb; border-radius: 8pt; padding: 8pt 12pt; margin-bottom: 14pt; }
.need ul { margin: 2pt 0 0; padding-left: 16pt; }
.page { display: grid; grid-template-columns: 1fr 1fr; gap: 22pt; break-after: page; }
.page:last-of-type { break-after: auto; }
.step { break-inside: avoid; }
.head { display: flex; align-items: center; gap: 8pt; margin-bottom: 4pt; }
.num { flex: none; width: 24pt; height: 24pt; border-radius: 50%; background: #2f5bd3; color: #fff;
       display: grid; place-items: center; font-weight: 700; font-size: 12pt; }
h2 { font-size: 14pt; margin: 0; }
.body p { margin: 0 0 5pt; }
.url { font: 600 10.5pt ui-monospace, Menlo, monospace; background: #f1f1ee; padding: 3pt 6pt; border-radius: 4pt;
       display: inline-block; }
.note { color: #4a4f57; font-size: 9.5pt; }
.step img { display: block; width: 2.45in; margin: 8pt auto 0; border: 1pt solid #c9c9c4; border-radius: 16pt; }
.extra h2 { margin: 0 0 6pt; }
table { border-collapse: collapse; width: 100%; font-size: 10pt; margin-bottom: 12pt; }
td { border-top: 1pt solid #ddd; padding: 5pt 6pt; vertical-align: top; }
td:first-child { width: 38%; font-weight: 600; }
.extra p { margin: 0 0 10pt; }
"""

EXTRA = """<div class="extra">
<h2>If something goes wrong</h2>
<table>
<tr><td>Add to Home Screen isn't in the list</td><td>Make sure you're in Safari. Scroll to the bottom of the list, tap <b>Edit Actions…</b>, and add it.</td></tr>
<tr><td>It won't let you in after you sign in</td><td>Check that you picked the Google account your teacher invited. If it still doesn't work, ask your teacher to check your invite.</td></tr>
<tr><td>Sign-in goes back to the sign-in screen</td><td>Close the app completely (swipe it away), reopen it, and try again. If it keeps happening, tell your teacher.</td></tr>
<tr><td>The address bar still shows</td><td>You opened the site in Safari, not the app. Close Safari and tap <b>SAT Words</b> on your home screen.</td></tr>
</table>
<h2>Removing the app</h2>
<p>Press and hold the <b>SAT Words</b> icon, tap <b>Remove App</b>, then tap <b>Delete from Home Screen</b>. Your progress is saved to your account, so it will still be there if you add the app again.</p>
<h2>Android phones</h2>
<p>Open the same address in <b>Chrome</b>, tap the <b>⋮</b> menu at the top right, and tap <b>Add to Home screen</b> (or <b>Install app</b>). Then open <b>SAT Words</b> from your home screen and sign in.</p>
</div>"""


def main():
    frames = json.loads((SHOTS / "frames.json").read_text())
    steps = [step_html(i + 1, shot, title, body, processed(shot, crop, frames))
             for i, (shot, title, body, crop) in enumerate(STEPS)]
    intro = f"""<h1>Installing the SAT Words App</h1>
<p class="lead">Put SAT Word Study on your iPhone's home screen like any other app. It opens full-screen
with its own icon, with no App Store and no download. It takes about a minute.</p>
<div class="need"><b>You'll need:</b><ul><li>An iPhone or iPad with Safari</li>
<li>The Google account your teacher invited</li></ul></div>"""
    # Two steps per page; the last step shares its page with the troubleshooting notes.
    pages = [steps[0:2], steps[2:4], steps[4:6], [steps[6], EXTRA]]
    body = intro + "".join(f'<div class="page">{"".join(p)}</div>' for p in pages)
    html = f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Installing the SAT Words App</title><style>{CSS}</style></head><body>{body}</body></html>'
    with tempfile.TemporaryDirectory() as tmp:
        page = Path(tmp) / "install.html"
        page.write_text(html)
        subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
                        f"--print-to-pdf={OUT}", page.as_uri()], check=True, capture_output=True)
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
