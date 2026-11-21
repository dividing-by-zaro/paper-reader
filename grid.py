"""Draw a labelled 10% grid over a figure so a model can read positions off it.

Usage: python grid.py FIGURE.png OUT.png
"""
import sys

import pymupdf

src, dst = sys.argv[1], sys.argv[2]
pix = pymupdf.Pixmap(src)
scale = min(1.0, 1400 / max(pix.width, pix.height))
w, h = pix.width * scale, pix.height * scale
margin = 28
doc = pymupdf.open()
page = doc.new_page(width=w + 2 * margin, height=h + 2 * margin)
page.insert_image(pymupdf.Rect(margin, margin, margin + w, margin + h), pixmap=pix)
red = (0.85, 0.15, 0.15)
for i in range(11):
    x = margin + w * i / 10
    y = margin + h * i / 10
    page.draw_line((x, margin), (x, margin + h), color=red, width=0.6, stroke_opacity=0.55)
    page.draw_line((margin, y), (margin + w, y), color=red, width=0.6, stroke_opacity=0.55)
    page.insert_text((x - 6, margin - 8), str(i * 10), fontsize=10, color=red)
    page.insert_text((x - 6, margin + h + 18), str(i * 10), fontsize=10, color=red)
    page.insert_text((4, y + 4), str(i * 10), fontsize=10, color=red)
    page.insert_text((margin + w + 4, y + 4), str(i * 10), fontsize=10, color=red)
page.get_pixmap(dpi=72).save(dst)
