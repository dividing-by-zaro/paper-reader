"""Break a research paper PDF into what the four reading passes need.

Usage: python ingest.py PAPER.pdf OUT_DIR
Writes OUT_DIR/paper.json and OUT_DIR/figures/*.png.

The paper JSON holds the title, authors, abstract, sections (paragraphs, display math
and figure anchors in reading order), figures and tables cropped from the page, and
the reference list.
"""

import json
import re
import statistics
import sys
from pathlib import Path

import pymupdf

PAPER_VERSION = 6  # bump when the extractor changes, so saved papers are re-read
CAPTION = re.compile(r"^\s*(Figure|Fig\.?|Table|Tab\.)\s*([A-Z]?\d+(?:\.\d+)*[a-z]?)\s*[.:|]", re.I)
NUMBERED = re.compile(r"^((?:\d+\.)*\d+\.?|[A-Z]\.(?:\d+\.?)*|[IVX]+\.)\s+(\S.*)$")
KNOWN = re.compile(
    r"^(abstract|introduction|background|related work|preliminaries|method|methods|methodology|approach|model|"
    r"experiments?|experimental setup|results|evaluation|analysis|discussion|limitations|conclusions?|"
    r"conclusion and future work|future work|summary|acknowledg(e)?ments?|references|bibliography|appendix|"
    r"appendices|broader impact|ethics statement)\b",
    re.I,
)
MATH_FONT = re.compile(r"CMMI|CMSY|CMEX|CMBSY|MSBM|MSAM|Math|Symbol|rsfs|eufm|STIX|Cambria Math|LMMath|txsy|txex|esint", re.I)
MATH_CHARS = set("=∑∏∫∂∇√≤≥≈≠∈∉⊂⊆∀∃∞±×·∘⊙⊕→←↦αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩ^_{}|‖")
EQ_NUMBER = re.compile(r"\(\s*\d+[a-z]?\s*\)\s*$")


def clean(text):
    text = text.replace("­", "")
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)
    text = re.sub(r"\s*\n\s*", " ", text)
    return re.sub(r"\s{2,}", " ", text).strip()


def block_info(block, page_no):
    lines, sizes, chars, bold, mathy = [], [], 0, 0, 0
    if any(abs(line["dir"][0] - 1) > 0.01 for line in block["lines"]):
        return None
    for line in block["lines"]:
        parts = []
        for span in line["spans"]:
            t = span["text"]
            if not t.strip():
                parts.append(t)
                continue
            n = len(t.strip())
            chars += n
            sizes.extend([span["size"]] * n)
            if span["flags"] & 16 or re.search(r"Bold|Black|Semibold|\.B$|-B$", span["font"]):
                bold += n
            if MATH_FONT.search(span["font"]):
                mathy += n
            else:
                mathy += sum(1 for ch in t if ch in MATH_CHARS)
            parts.append(t)
        lines.append("".join(parts))
    text = clean("\n".join(lines))
    return {
        "page": page_no,
        "bbox": pymupdf.Rect(block["bbox"]),
        "text": text,
        "size": statistics.median(sizes) if sizes else 0,
        "max_size": max(sizes) if sizes else 0,
        "chars": chars,
        "bold": bold / chars if chars else 0,
        "math": mathy / chars if chars else 0,
        "lines": len(block["lines"]),
    }


def body_size(blocks):
    weights = {}
    for b in blocks:
        key = round(b["size"] * 2) / 2
        weights[key] = weights.get(key, 0) + b["chars"]
    return max(weights, key=weights.get) if weights else 10


def heading_level(b, body):
    text = b["text"]
    if not text or len(text) > 90 or b["lines"] > 3 or CAPTION.match(text):
        return None
    if text.endswith((".", ",", ";")) and not NUMBERED.match(text):
        return None
    m = NUMBERED.match(text)
    big = b["size"] >= body + 0.8
    strong = b["bold"] > 0.6
    if m and (big or strong) and not re.match(r"^\d+(\.\d+)?\s*$", text):
        label = m.group(1).rstrip(".")
        if re.search(r"\d", m.group(2)[:2]) and not strong:
            return None
        return label.count(".") + 1 if label[0].isdigit() else 1
    if KNOWN.match(text) and (big or strong or text.isupper()) and len(text.split()) <= 6:
        return 1
    if (big and strong) and len(text.split()) <= 10:
        return 1
    return None


def column_of(rect, page_rect):
    w = page_rect.width
    if rect.width > w * 0.55:
        return pymupdf.Rect(page_rect.x0 + 20, 0, page_rect.x1 - 20, 0)
    if rect.x1 <= w * 0.56:
        return pymupdf.Rect(page_rect.x0 + 20, 0, w / 2 + 6, 0)
    if rect.x0 >= w * 0.44:
        return pymupdf.Rect(w / 2 - 6, 0, page_rect.x1 - 20, 0)
    return pymupdf.Rect(page_rect.x0 + 20, 0, page_rect.x1 - 20, 0)


def graphics(page):
    rects = []
    page_area = abs(page.rect)
    ph = page.rect.height

    def furniture(r):
        # Thin rules under running headers or above footers span the page; they belong to no figure.
        return r.height < 3 and r.width > page.rect.width * 0.5 and (r.y1 < ph * 0.1 or r.y0 > ph * 0.9)

    for info in page.get_image_info():
        r = pymupdf.Rect(info["bbox"]) & page.rect
        if r.width > 8 and r.height > 8 and abs(r) < page_area * 0.9:
            rects.append(r)
    try:
        for cluster in page.cluster_drawings(x_tolerance=6, y_tolerance=6):
            r = pymupdf.Rect(cluster) & page.rect
            if abs(r) < page_area * 0.85 and (r.width > 12 or r.height > 12) and not furniture(r):
                rects.append(r)
    except Exception:
        for d in page.get_drawings():
            r = pymupdf.Rect(d["rect"]) & page.rect
            if abs(r) < page_area * 0.85 and (r.width > 3 or r.height > 3):
                rects.append(r)
    return rects


def is_prose(b, body):
    """A running paragraph of body text, which ends a figure region."""
    return (
        b["chars"] > 140
        and abs(b["size"] - body) < 0.9
        and b["math"] < 0.25
        and b["lines"] >= 2
        and not CAPTION.match(b["text"])
    )


def overlaps_x(a, col, need=0.5):
    inter = min(a.x1, col.x1) - max(a.x0, col.x0)
    return inter > 0 and inter >= need * min(a.width, col.width)


def figure_region(page, caption, blocks, body, is_table, taken=()):
    """Find the rectangle holding the figure or table that a caption describes."""
    col = column_of(caption["bbox"], page.rect)
    cap = caption["bbox"]
    gfx = [g for g in graphics(page) if overlaps_x(g, col, 0.4)]
    def in_graphic(r):
        return any(abs(r & g) > 0.5 * abs(r) for g in gfx if not (r & g).is_empty)

    prose = [b["bbox"] for b in blocks if b is not caption and is_prose(b, body) and overlaps_x(b["bbox"], col, 0.3) and not in_graphic(b["bbox"])]
    others = [b["bbox"] for b in blocks if b is not caption and CAPTION.match(b["text"])]

    def limit_up(c):
        return max([r.y1 for r in prose + others if r.y1 <= c.y0 + 2] + [page.rect.y0 + 20])

    def grow(direction):
        if direction == "up":
            limit = max([r.y1 for r in prose + others if r.y1 <= cap.y0 + 2] + [page.rect.y0 + 20])
            # Drawings that run past the caption (merged clusters) are cut off at it.
            pool = [pymupdf.Rect(g.x0, g.y0, g.x1, min(g.y1, cap.y0 - 1)) for g in gfx if g.y0 < cap.y0 - 10 and g.y0 >= limit - 2]
            edge = cap.y0
        else:
            limit = min([r.y0 for r in prose + others if r.y0 >= cap.y1 - 2] + [page.rect.y1 - 20])
            pool = [pymupdf.Rect(g.x0, max(g.y0, cap.y1 + 1), g.x1, g.y1) for g in gfx if g.y1 > cap.y1 + 10 and g.y1 <= limit + 2 and g.y0 >= limit_up(cap) - 2]
            edge = cap.y1
        region = None
        changed = True
        while changed:
            changed = False
            for g in pool:
                near = (edge - g.y1 < 60) if direction == "up" else (g.y0 - edge < 60)
                if region is None and near:
                    region = pymupdf.Rect(g)
                    changed = True
                elif region is not None and not region.contains(g):
                    gap = max(region.y0 - g.y1, g.y0 - region.y1, 0)
                    if gap < 30:
                        region |= g
                        changed = True
            pool = [g for g in pool if region is None or not region.contains(g)]
        if region is None and not is_table:
            return None
        if region is None:
            # Text-only figures and tables: everything between the caption and the nearest prose.
            if direction == "up":
                region = pymupdf.Rect(col.x0, limit + 2, col.x1, cap.y0 - 2)
            else:
                region = pymupdf.Rect(col.x0, cap.y1 + 2, col.x1, limit - 2)
            if region.height < 30:
                return None
            texts = [b["bbox"] for b in blocks if b is not caption and region.intersects(b["bbox"])]
            if len(texts) < 3:
                return None
            tight = pymupdf.Rect(texts[0])
            for t in texts[1:]:
                tight |= t
            region = tight & region
            return region if region.height >= 30 else None
        # Pull in labels and legends (small text) that sit inside or right against the graphic.
        for b in blocks:
            if b is caption or (is_prose(b, body) and not in_graphic(b["bbox"])) or CAPTION.match(b["text"]):
                continue
            r = b["bbox"]
            if r.y1 < page.rect.height * 0.08 or r.y0 > page.rect.height * 0.92:
                continue  # running headers, footers and page numbers
            grown = pymupdf.Rect(region.x0 - 14, region.y0 - 14, region.x1 + 14, region.y1 + 14)
            if grown.intersects(r) and overlaps_x(r, col, 0.5) and (r.y1 <= cap.y0 + 2 if direction == "up" else r.y0 >= cap.y1 - 2):
                region |= r
        return region

    # Rotated text (vertical axis titles) that sits right against the figure belongs to it.
    rotated = []
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            if abs(line["dir"][0] - 1) > 0.01 and "".join(sp["text"] for sp in line["spans"]).strip():
                rotated.append(pymupdf.Rect(line["bbox"]))

    def with_axis_titles(region):
        for r in rotated:
            gap = max(region.x0 - r.x1, r.x0 - region.x1, 0)
            overlap = min(r.y1, region.y1) - max(r.y0, region.y0)
            if gap < 24 and overlap > 0.5 * r.height and r.x1 > page.rect.width * 0.03:
                region = region | r
        return region

    order = ["down", "up"] if is_table else ["up", "down"]
    found = []
    one_column = cap.width <= page.rect.width * 0.55
    for rank, direction in enumerate(order):
        region = grow(direction)
        if region is None or region.width <= 40 or region.height <= 30:
            continue
        region = with_axis_titles(region)
        pad = 4
        region = pymupdf.Rect(region.x0 - pad, region.y0 - pad, region.x1 + pad, region.y1 + pad) & page.rect
        if one_column:
            # Captions usually span their column exactly, so they mark its edges better than the page middle does.
            lo_x, hi_x = (cap.x0 - 20, cap.x1 + 20) if cap.width > 0.8 * (col.x1 - col.x0 - 20) else (col.x0 - 6, col.x1 + 6)
            # ...but never into the neighbouring column's text.
            beside = [b["bbox"] for b in blocks if b is not caption and not overlaps_x(b["bbox"], col, 0.3) and b["bbox"].y1 > region.y0 and b["bbox"].y0 < region.y1 and b["chars"] > 20]
            lo_x = max([lo_x] + [r.x1 + 2 for r in beside if r.x1 <= cap.x0 + 2])
            hi_x = min([hi_x] + [r.x0 - 2 for r in beside if r.x0 >= cap.x1 - 2])
            region.x0, region.x1 = max(region.x0, lo_x), min(region.x1, hi_x)
        if direction == "up":
            region.y1 = min(region.y1, cap.y0 - 1)
            gap = cap.y0 - region.y1
        else:
            region.y0 = max(region.y0, cap.y1 + 1)
            gap = region.y0 - cap.y1
        if region.height <= 30:
            continue
        clash = any(abs(region & t) > 0.4 * min(abs(region), abs(t)) for t in taken if not (region & t).is_empty)
        if clash:
            continue
        found.append((gap > (60 if not is_table else 24), rank, region))
    found.sort(key=lambda f: (f[0], f[1]))
    return found[0][2] if found else None


def is_eq_part(b, body):
    text = b["text"]
    if not text or b["chars"] >= 200 or CAPTION.match(text) or heading_level(b, body) is not None:
        return False
    words = len(re.findall(r"[A-Za-z]{4,}", text))
    if re.fullmatch(r"\(\s*\d+[a-z]?\s*\)", text):
        return True
    if words >= 7 and b["math"] < 0.5:
        return False
    return b["math"] >= 0.2 or ("=" in text and b["math"] >= 0.05) or (b["chars"] <= 8 and b["math"] > 0)


def group_equations(blocks, body):
    """Merge the pieces of a display equation (lines, sub/superscripts, number) into one block."""
    out, group = [], None
    for b in blocks:
        if is_eq_part(b, body):
            gx = max(group["bbox"].x0 - b["bbox"].x1, b["bbox"].x0 - group["bbox"].x1, 0) if group else 0
            if group and b["bbox"].y0 <= group["bbox"].y1 + 8 and b["bbox"].y1 >= group["bbox"].y0 - 8 and gx < 40:
                group["bbox"] = group["bbox"] | b["bbox"]
                group["text"] += " " + b["text"]
                group["chars"] += b["chars"]
                continue
            group = dict(b, bbox=pymupdf.Rect(b["bbox"]), eq=True)
            out.append(group)
            continue
        group = None
        out.append(b)
    # A lone short fragment with no math next to it is just text.
    for b in out:
        if b.get("eq") and b["chars"] <= 8 and b["math"] < 0.2 and not re.fullmatch(r"\(\s*\d+[a-z]?\s*\)", b["text"]):
            b["eq"] = False
    return out


def region_texts(page, region):
    """Text lines inside a figure, with positions in percent of the cropped image, for walkthrough marks."""
    items = []
    for block in page.get_text("dict", clip=region)["blocks"]:
        for line in block.get("lines", []):
            text = "".join(sp["text"] for sp in line["spans"]).strip()
            r = pymupdf.Rect(line["bbox"]) & region
            if not text or r.is_empty:
                continue
            items.append({
                "id": f"t{len(items) + 1}",
                "text": text[:80],
                "x": round((r.x0 - region.x0) / region.width * 100, 1),
                "y": round((r.y0 - region.y0) / region.height * 100, 1),
                "w": round(r.width / region.width * 100, 1),
                "h": round(r.height / region.height * 100, 1),
            })
            if len(items) >= 160:
                return items
    return items


def table_candidates(page, taken):
    """Rectangles that look like tables: ruled grids found by PyMuPDF, plus drawn graphics not used by figures."""
    cands = []
    try:
        for t in page.find_tables(strategy="lines").tables:
            cands.append(pymupdf.Rect(t.bbox))
    except Exception:
        pass
    for g in graphics(page):
        if not any(abs(g & c) > 0.5 * min(abs(g), abs(c)) for c in cands if not (g & c).is_empty):
            cands.append(g)
    ok = []
    for c in cands:
        if c.width < 40 or c.height < 12:
            continue
        if any(not (c & t).is_empty and abs(c & t) > 0.4 * abs(c) for t in taken):
            continue
        ok.append(c)
    return ok


def grow_table(region, cap, blocks, body, above):
    """Add header rows, footnotes and cells just outside the detected grid, never crossing the caption."""
    for _ in range(3):
        changed = False
        for b in blocks:
            r = b["bbox"]
            if b is cap or CAPTION.match(b["text"]) or region.contains(r):
                continue
            if is_prose(b, body) or heading_level(b, body) is not None:
                continue
            cb = cap["bbox"]
            if above and r.y1 > cb.y0 + 2 or not above and r.y0 < cb.y1 - 2:
                continue
            near = pymupdf.Rect(region.x0 - 6, region.y0 - 16, region.x1 + 6, region.y1 + 16)
            inter = min(r.x1, region.x1) - max(r.x0, region.x0)
            if near.intersects(r) and inter > 0.5 * min(r.width, region.width):
                region = region | r
                changed = True
        if not changed:
            break
    return region


def content_box(page, region, skip=()):
    """The tight box around the lines and drawings inside a region, ignoring the given rectangles (captions)."""
    rects = []
    for block in page.get_text("dict", clip=region)["blocks"]:
        for line in block.get("lines", []):
            r = pymupdf.Rect(line["bbox"]) & region
            if not r.is_empty and not any(abs(r & k) > 0.5 * abs(r) for k in skip if not (r & k).is_empty):
                rects.append(r)
    for d in page.get_drawings():
        r = pymupdf.Rect(d["rect"]) & region
        if not r.is_empty or (r.width > 0 or r.height > 0):
            if region.contains(pymupdf.Point(r.x0, r.y0)) and not any(abs(r & k) > 0.5 * max(abs(r), 1) for k in skip if not (r & k).is_empty):
                rects.append(r)
    if not rects:
        return None
    box = pymupdf.Rect(rects[0])
    for r in rects[1:]:
        box |= r
    return box & region


def split_side_by_side(page, cand, caps):
    """find_tables can merge two tables that sit side by side into one box. Split it between their captions."""
    near = [c["bbox"] for c, *_ in caps if overlaps_x(c["bbox"], cand, 0.5) and max(c["bbox"].y0 - cand.y1, cand.y0 - c["bbox"].y1, 0) < 90]
    near.sort(key=lambda r: r.x0)
    pair = next(((a, b) for a in near for b in near if a.x1 <= b.x0 + 4), None)
    if not pair:
        return [cand]
    a, b = pair
    lo, hi = int((a.x0 + a.x1) / 2), int((b.x0 + b.x1) / 2)
    if hi - lo < 40:
        return [cand]
    busy = [False] * (hi - lo)
    occupied = []
    for block in page.get_text("dict", clip=cand)["blocks"]:
        for line in block.get("lines", []):
            r = pymupdf.Rect(line["bbox"])
            if not any(abs(r & c) > 0.5 * abs(r) for c in near if not (r & c).is_empty):
                occupied.append(r)
    occupied += [pymupdf.Rect(d["rect"]) for d in page.get_drawings() if cand.intersects(pymupdf.Rect(d["rect"])) and pymupdf.Rect(d["rect"]).width < cand.width * 0.6]
    for r in occupied:
        for x in range(max(lo, int(r.x0)), min(hi, int(r.x1) + 1)):
            busy[x - lo] = True
    runs, run, start = [], 0, None
    for i, used in enumerate(busy + [True]):
        if not used:
            start = i if run == 0 else start
            run += 1
        else:
            if run >= 3:
                runs.append((start, run))
            run = 0
    if not runs:
        return [cand]
    between = (a.x1 + b.x0) / 2 - lo
    start, width = min(runs, key=lambda r: abs(r[0] + r[1] / 2 - between))
    x = lo + start + width / 2
    halves = []
    for half in (pymupdf.Rect(cand.x0, cand.y0, x, cand.y1), pymupdf.Rect(x, cand.y0, cand.x1, cand.y1)):
        box = content_box(page, half, near)
        if box and box.width > 30 and box.height > 12:
            halves.append(box)
    return halves or [cand]


def match_tables(page, blocks, caps, body, taken, prefer=None, cands=None, fallback=True):
    """Pair captions with tables. prefer is the side ("above"/"below") this paper puts tables relative to captions."""
    cands = cands if cands is not None else table_candidates(page, taken)
    cands = [part for c in cands for part in split_side_by_side(page, c, caps)]
    pairs = []
    for ci, (cap, *_rest) in enumerate(caps):
        col = column_of(cap["bbox"], page.rect)
        cb = cap["bbox"]
        for ki, c in enumerate(cands):
            beside = min(c.y1, cb.y1) - max(c.y0, cb.y0) > 0.5 * cb.height
            if not overlaps_x(c, col, 0.3) and not (beside and max(c.x0 - cb.x1, cb.x0 - c.x1) < 30):
                continue
            if c.y1 <= cb.y0 + 6:
                gap, above = cb.y0 - c.y1, True
            elif c.y0 >= cb.y1 - 6:
                gap, above = c.y0 - cb.y1, False
            elif min(c.y1, cb.y1) - max(c.y0, cb.y0) > 0.5 * cb.height:
                gap, above = 0, None  # caption beside or inside the table's box
            else:
                continue
            # Prose between the caption and the table means they don't belong together.
            lo, hi = (c.y1, cb.y0) if above else (cb.y1, c.y0)
            if above is not None and any(is_prose(b, body) and b["bbox"].y0 >= lo - 1 and b["bbox"].y1 <= hi + 1 and overlaps_x(b["bbox"], col, 0.3) for b in blocks):
                continue
            if gap < 90:
                side = "beside" if above is None else "above" if above else "below"
                pairs.append((gap + (30 if prefer in ("above", "below") and side != prefer else 0), ci, ki, above))
    pairs.sort()
    used_c, used_k, found = set(), set(), []
    for gap, ci, ki, above in pairs:
        if ci in used_c or ki in used_k:
            continue
        used_c.add(ci)
        used_k.add(ki)
        cap, m, kind, label = caps[ci]
        if above is None:
            # Side caption: keep the table's own box; the caption may sit inside it.
            region = pymupdf.Rect(cands[ki]) & page.rect
            found.append((cap, m, kind, label, region, None))
            continue
        region = grow_table(pymupdf.Rect(cands[ki]), cap, blocks, body, above)
        # Merge further grid parts of the same table (split by a rule gap) on the far side.
        for kj, c in enumerate(cands):
            if kj in used_k or not overlaps_x(c, region, 0.5):
                continue
            touching = (c.y1 <= region.y0 + 2 and region.y0 - c.y1 < 14) if above else (c.y0 >= region.y1 - 2 and c.y0 - region.y1 < 14)
            if touching:
                used_k.add(kj)
                region = grow_table(region | c, cap, blocks, body, above)
        pad = 4
        region = pymupdf.Rect(region.x0 - pad, region.y0 - pad, region.x1 + pad, region.y1 + pad) & page.rect
        if above:
            region.y1 = min(region.y1, cap["bbox"].y0 - 1)
        else:
            region.y0 = max(region.y0, cap["bbox"].y1 + 1)
        found.append((cap, m, kind, label, region, "above" if above else "below"))
    # Captions with no ruled table: fall back to the text-only search.
    claimed_now = taken + [f[4] for f in found]
    if not fallback:
        return found
    for ci, (cap, m, kind, label) in enumerate(caps):
        if ci in used_c:
            continue
        region = figure_region(page, cap, blocks, body, True, claimed_now)
        if region is not None:
            found.append((cap, m, kind, label, region, None))
            claimed_now.append(region)
    return found


def main(pdf_path, out_dir):
    out = Path(out_dir)
    (out / "figures").mkdir(parents=True, exist_ok=True)
    (out / "math").mkdir(parents=True, exist_ok=True)
    math_count = 0  # display equations saved as images
    doc = pymupdf.open(pdf_path)
    if doc.page_count > 120:
        raise SystemExit("Use a PDF with at most 120 pages.")

    pages = []
    for page in doc:
        raw = page.get_text("dict", flags=pymupdf.TEXT_PRESERVE_WHITESPACE)["blocks"]
        blocks = [block_info(b, page.number + 1) for b in raw if b.get("type") == 0 and b.get("lines")]
        pages.append([b for b in blocks if b and b["text"]])
    everything = [b for p in pages for b in p]
    if sum(b["chars"] for b in everything) < 500:
        raise SystemExit("No readable text found. Scanned PDFs need OCR, which this reader does not do.")
    body = body_size(everything)
    pages = [group_equations(p, body) for p in pages]

    # Running headers, footers and page numbers repeat across pages near the edges.
    edge_texts = {}
    for p in pages:
        for b in p:
            ph = doc[b["page"] - 1].rect.height
            if b["bbox"].y1 < ph * 0.07 or b["bbox"].y0 > ph * 0.93:
                key = re.sub(r"\d+", "#", b["text"])[:60]
                edge_texts[key] = edge_texts.get(key, 0) + 1

    def is_furniture(b):
        ph = doc[b["page"] - 1].rect.height
        near_edge = b["bbox"].y1 < ph * 0.07 or b["bbox"].y0 > ph * 0.93
        if not near_edge:
            return False
        key = re.sub(r"\d+", "#", b["text"])[:60]
        return edge_texts.get(key, 0) >= 3 or re.fullmatch(r"[\d\s\-–]+", b["text"]) is not None

    # Figures and tables.
    figures, claimed = [], {}
    seen = set()

    def captions(want):
        for p in pages:
            for b in p:
                m = CAPTION.match(b["text"])
                if not m or b["bbox"].x0 < 0:
                    continue
                kind = "table" if m.group(1).lower().startswith("tab") else "figure"
                label = f"{'Table' if kind == 'table' else 'Figure'} {m.group(2)}"
                # Captions start a block and are not body references like "Figure 2 shows...".
                if kind != want or label in seen or (len(b["text"]) > 40 and re.match(r"^\s*(Figure|Fig\.?|Table)\s*\d+\s+(shows|illustrates|presents|compares|lists|summarizes|reports|gives)\b", b["text"], re.I)):
                    continue
                yield p, b, m, kind, label

    def save(page, b, m, kind, label, region):
        seen.add(label)
        fid = f"{kind}-{m.group(2)}".lower().replace(".", "-")
        pix = page.get_pixmap(clip=region, dpi=200)
        pix.save(out / "figures" / f"{fid}.png")
        figures.append({
            "id": fid,
            "label": label,
            "kind": kind,
            "caption": b["text"],
            "page": b["page"],
            "file": f"figures/{fid}.png",
            "width": pix.width,
            "height": pix.height,
            "y": region.y0,
            "texts": region_texts(page, region),
        })
        claimed.setdefault(b["page"], []).append((region, b))

    # Figures first, so a table caption cannot claim a neighbouring plot.
    for p, b, m, kind, label in list(captions("figure")):
        page = doc[b["page"] - 1]
        taken = [r for r, _ in claimed.get(b["page"], [])]
        region = figure_region(page, b, p, body, False, taken)
        if region is not None:
            save(page, b, m, kind, label, region)

    # Tables: match every table caption on a page to its nearest table, then grow it to take in header rows.
    by_page = {}
    for p, b, m, kind, label in list(captions("table")):
        by_page.setdefault(b["page"], (p, []))[1].append((b, m, kind, label))
    cand_cache = {}
    for page_no in by_page:
        cand_cache[page_no] = table_candidates(doc[page_no - 1], [r for r, _ in claimed.get(page_no, [])])
    # First pass: which side of their captions do this paper's tables sit on?
    sides = {"above": 0, "below": 0}
    for page_no, (p, caps) in by_page.items():
        for *_x, side in match_tables(doc[page_no - 1], p, caps, body, [], None, cand_cache[page_no], fallback=False):
            if side:
                sides[side] += 1
    total = sides["above"] + sides["below"]
    prefer = max(sides, key=sides.get) if total and max(sides.values()) >= 0.6 * total else None
    for page_no, (p, caps) in by_page.items():
        page = doc[page_no - 1]
        taken = [r for r, _ in claimed.get(page_no, [])]
        for b, m, kind, label, region, _side in match_tables(page, p, caps, body, taken, prefer, cand_cache[page_no]):
            if label not in seen:
                save(page, b, m, kind, label, region)

    def inside_figure(b):
        for region, cap in claimed.get(b["page"], []):
            if b is cap:
                return True
            inter = region & b["bbox"]
            if not inter.is_empty and abs(inter) > 0.6 * abs(b["bbox"]):
                return True
        return False

    # Title and authors from page one.
    first = [b for b in pages[0] if not is_furniture(b) and b["bbox"].y0 < doc[0].rect.height * 0.5]
    title = (doc.metadata or {}).get("title", "").strip()
    big = max(first, key=lambda b: b["max_size"], default=None)
    if big and (not title or len(title) < 8 or title.lower().endswith((".pdf", ".dvi", ".tex")) or "untitled" in title.lower()):
        # Titles that wrap can be split into several blocks in the same large type.
        span = big["max_size"] * 3
        parts = [b for b in first if b is big or (abs(b["max_size"] - big["max_size"]) < 0.6 and big["bbox"].y0 - span < b["bbox"].y0 < big["bbox"].y1 + span)]
        parts.sort(key=lambda b: b["bbox"].y0)
        title = " ".join(b["text"] for b in parts)
        title_blocks = parts
    else:
        title_blocks = [big] if big else []
    title = title or Path(pdf_path).stem

    # Walk the text in reading order, building sections.
    sections, current, abstract, authors = [], None, [], []
    in_abstract, in_refs, refs = False, False, []
    seen_heading = False
    fig_queue = {f["page"]: [] for f in figures}
    figures.sort(key=lambda f: (f["page"], f["y"]))
    for f in figures:
        fig_queue[f["page"]].append(f)
    for q in fig_queue.values():
        q.sort(key=lambda f: f["y"])

    def add(item):
        nonlocal current
        if current is None:
            current = {"title": "Opening", "level": 1, "items": []}
            sections.append(current)
        current["items"].append(item)

    for p in pages:
        page_no = p[0]["page"] if p else None
        pending = list(fig_queue.get(page_no, []))
        for b in p:
            if is_furniture(b) or inside_figure(b):
                continue
            while pending and pending[0]["y"] < b["bbox"].y0 and not in_refs and seen_heading:
                add({"type": "figure", "id": pending.pop(0)["id"]})
            text = b["text"]
            if b["page"] == 1 and any(b is t for t in title_blocks):
                continue
            if b["page"] == 1 and not seen_heading and not in_abstract:
                if re.match(r"^abstract\b", text, re.I):
                    in_abstract = True
                    rest = re.sub(r"^abstract[\s.:—–-]*", "", text, flags=re.I)
                    if rest:
                        abstract.append(rest)
                    continue
                if heading_level(b, body) is None and b["bbox"].y0 < doc[0].rect.height * 0.45 and b["size"] < body + 6 and b["chars"] < 260 and not text[:1].islower() and not re.search(r"permission|copyright|licen[cs]e|conference|proceedings|preprint", text, re.I):
                    authors.append(text)
                    continue
            level = heading_level(b, body)
            if level is not None:
                in_abstract = False
                seen_heading = True
                if re.match(r"^(references|bibliography)\b", text, re.I):
                    in_refs = True
                    current = None
                    continue
                if in_refs and not re.match(r"^(appendix|appendices|[A-Z]\.?\s)", text):
                    continue
                in_refs = False
                current = {"title": text, "level": level, "items": []}
                sections.append(current)
                continue
            ph1 = doc[0].rect.height
            footnote = b["page"] == 1 and (
                (b["size"] < body - 0.6 and b["bbox"].y0 > ph1 * 0.7) or (b["size"] < body - 2 and b["bbox"].y0 > ph1 * 0.5)
            )
            if in_abstract:
                # Footnotes (small type at the foot of page one) are not part of the abstract.
                if not footnote:
                    abstract.append(text)
                continue
            if footnote and not seen_heading:
                continue
            if in_refs:
                refs.append(text)
                continue
            # Footnotes: small type in the lower part of the page, outside figures.
            ph = doc[b["page"] - 1].rect.height
            if not b.get("eq") and b["size"] < body - 1 and b["bbox"].y0 > ph * 0.6 and b["chars"] < 600:
                continue
            display_math = bool(b.get("eq"))
            item = {"type": "math" if display_math else "p", "text": text, "page": b["page"], "math": round(b["math"], 2)}
            if display_math:
                math_count += 1
                page = doc[b["page"] - 1]
                r = b["bbox"]
                clip = pymupdf.Rect(r.x0 - 3, r.y0 - 3, r.x1 + 3, r.y1 + 3) & page.rect
                pix = page.get_pixmap(clip=clip, dpi=200)
                name = f"math/m{math_count}.png"
                pix.save(out / name)
                item.update(file=name, width=pix.width, height=pix.height)
            add(item)
        while pending:
            if in_refs or not seen_heading:
                break
            add({"type": "figure", "id": pending.pop(0)["id"]})

    # Figures that never found a place (for example after the references) go at the end.
    placed = {it["id"] for s in sections for it in s["items"] if it["type"] == "figure"}
    leftover = [f for f in figures if f["id"] not in placed]
    if leftover:
        sections.append({"title": "More figures and tables", "level": 1, "items": [{"type": "figure", "id": f["id"]} for f in leftover]})

    # Join paragraphs split across column or page breaks.
    for s in sections:
        merged = []
        for it in s["items"]:
            prev = merged[-1] if merged else None
            if prev and prev["type"] == "p" and it["type"] == "p" and not re.search(r"[.!?:”\"]\s*$", prev["text"]) and it["text"][:1].islower():
                prev["text"] += " " + it["text"]
                continue
            merged.append(it)
        s["items"] = merged

    # Reference list: split on [n] or numbered entries, else keep blocks.
    joined = " ".join(refs)
    parts = re.split(r"\s(?=\[\d+\]\s)", " " + joined) if re.search(r"\[\d+\]\s", joined) else refs
    references = [clean(r) for r in parts if len(clean(r)) > 20][:400]

    if not abstract:
        for s in sections:
            if s["title"].lower().startswith("abstract"):
                abstract = [it["text"] for it in s["items"] if it["type"] == "p"]
                sections.remove(s)
                break
    if not abstract and sections and sections[0]["title"] == "Opening":
        # No "Abstract" heading: the long paragraph before the first section is the abstract.
        long = [it for it in sections[0]["items"] if it["type"] == "p" and len(it["text"]) > 300]
        if long:
            abstract = [long[0]["text"]]
            sections[0]["items"].remove(long[0])

    for f in figures:
        f.pop("y", None)
    paper = {
        "version": PAPER_VERSION,
        "title": clean(title),
        "authors": clean(" · ".join(authors))[:600],
        "abstract": clean(" ".join(abstract)),
        "pages": doc.page_count,
        "sections": [s for s in sections if s["items"] or s["level"] == 1],
        "figures": figures,
        "references": references,
    }
    (out / "paper.json").write_text(json.dumps(paper, ensure_ascii=False, indent=1))
    print(json.dumps({"title": paper["title"], "figures": len(figures), "sections": len(paper["sections"]), "references": len(references)}))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
