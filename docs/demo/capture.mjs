// Capture each shot of the demo: a 2x screenshot of the app plus the on-screen box of every element it highlights.
// Usage: node docs/demo/capture.mjs [base url] (default http://localhost:4410, a server started on demo data)
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { SHOTS } from "./script.mjs";

const base = process.argv[2] ?? "http://localhost:4410";
const out = fileURLToPath(new URL("./build/shots/", import.meta.url));
await mkdir(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, reducedMotion: "reduce", bypassCSP: true });
const boxes = {};
for (const shot of SHOTS) {
  await page.goto("about:blank");
  await page.goto(base + shot.url, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  for (const step of shot.prepare ?? []) {
    if (step.startsWith("wait:")) await page.waitForTimeout(Number(step.slice(5)));
    else {
      await page.evaluate(step);
      await page.waitForTimeout(250);
    }
  }
  await page.waitForTimeout(700);
  // Hide the caret and scrollbars so stills look clean.
  await page.addStyleTag({ content: "*{caret-color:transparent!important} ::-webkit-scrollbar{display:none}" });
  boxes[shot.name] = await page.evaluate((targets) => {
    const out = {};
    for (const [name, sel] of Object.entries(targets)) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      out[name] = { x: r.left, y: r.top, w: r.width, h: r.height };
    }
    return out;
  }, shot.targets ?? {});
  const missing = Object.keys(shot.targets ?? {}).filter((t) => !boxes[shot.name][t]);
  if (missing.length) console.warn(`${shot.name}: not found: ${missing.join(", ")}`);
  await page.screenshot({ path: join(out, `${shot.name}.png`) });
  console.log(`captured ${shot.name}`);
}
await writeFile(join(out, "boxes.json"), JSON.stringify(boxes, null, 1));
await browser.close();
