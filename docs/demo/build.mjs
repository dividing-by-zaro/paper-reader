// Build the narrated demo video: narration (Cartesia), a timeline from its word times, and frames of the captured
// shots with a camera push, highlight boxes and captions, encoded with ffmpeg.
// Usage: DEMO_VOICE_ID=<cartesia voice id> node docs/demo/build.mjs   (run capture.mjs first)
// Writes docs/demo.mp4, docs/demo-poster.png and docs/demo-preview.gif. Never plays audio.
import { chromium } from "playwright";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { NARRATION, SHOTS } from "./script.mjs";
import { narrate, spoken } from "./narrate.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const build = join(here, "build");
const docs = join(here, "..");
const FPS = 30, W = 1920, H = 1200, SRC_W = 1440, SRC_H = 900;

// Keys come from the environment or the project's .env.
const env = await readFile(join(here, "../../.env"), "utf8").catch(() => "");
for (const m of env.matchAll(/^\s*(CARTESIA_API_KEY)\s*=\s*"?([^"\n]*)"?\s*$/gm)) process.env[m[1]] ??= m[2].trim();

// 1. Narration, cached by its text and voice.
const cacheKey = JSON.stringify({ NARRATION, voice: process.env.DEMO_VOICE_ID });
let narration;
try {
  const cached = JSON.parse(await readFile(join(build, "narration.json"), "utf8"));
  if (cached.key === cacheKey) narration = cached;
} catch {}
if (!narration) {
  console.log("narrating…");
  const n = await narrate(NARRATION, { voiceId: process.env.DEMO_VOICE_ID });
  await writeFile(join(build, "narration.wav"), n.wav);
  narration = { key: cacheKey, words: n.words, durationSeconds: n.durationSeconds };
  await writeFile(join(build, "narration.json"), JSON.stringify(narration));
}
const words = narration.words;
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9']/g, "");
const tokens = words.map((w) => norm(w.word));

// Find a phrase in the narration's words, at or after a word index.
function find(phrase, from = 0) {
  const want = spoken(phrase).split(/\s+/).map(norm).filter(Boolean);
  for (let i = from; i <= tokens.length - want.length; i++) if (want.every((w, j) => tokens[i + j] === w)) return i;
  throw new Error(`"${phrase}" is not in the narration`);
}

// 2. Timeline: when each shot starts, where its camera points, when each box appears.
const boxes = JSON.parse(await readFile(join(build, "shots/boxes.json"), "utf8"));
const duration = narration.durationSeconds + 1.6;
let cursor = 0;
const shots = SHOTS.map((shot, i) => {
  const at = i === 0 ? 0 : find(shot.from, cursor);
  cursor = at;
  return { ...shot, startWord: at, start: i === 0 ? 0 : Math.max(0, words[at].start - 0.2) };
});
shots.forEach((s, i) => (s.end = i + 1 < shots.length ? shots[i + 1].start : duration));
const timeline = shots.map((s) => {
  const rects = boxes[s.name] ?? {};
  const marks = s.boxes
    .filter((b) => rects[b.target])
    .map((b) => ({ ...rects[b.target], at: words[find(b.at, s.startWord)].start }));
  // The camera eases toward everything the shot highlights, by the time the first box appears.
  const focusRects = s.camera ? [s.camera].flat().map((c) => rects[c]).filter(Boolean) : marks;
  let focus = null;
  if (focusRects.length) {
    const x0 = Math.min(...focusRects.map((r) => r.x)), y0 = Math.min(...focusRects.map((r) => r.y));
    const x1 = Math.max(...focusRects.map((r) => r.x + r.w)), y1 = Math.max(...focusRects.map((r) => r.y + r.h));
    const pad = 90;
    const zoom = Math.max(1, Math.min(1.55, SRC_W / (x1 - x0 + 2 * pad), SRC_H / (y1 - y0 + 2 * pad)));
    focus = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, zoom, at: marks.length ? Math.min(...marks.map((m) => m.at)) : s.start + 0.6 };
  }
  return { name: s.name, start: s.start, end: s.end, marks, focus };
});

// Captions: the narration's sentences, timed by their words.
const sentences = NARRATION.split(/(?<=[.?!])\s+/);
const captions = [];
let w = 0;
for (const text of sentences) {
  const n = spoken(text).split(/\s+/).filter((x) => norm(x)).length;
  const first = words[Math.min(w, words.length - 1)];
  captions.push({ text, start: first.start });
  w += n;
}
captions.forEach((c, i) => (c.end = i + 1 < captions.length ? captions[i + 1].start : duration));
if (Math.abs(w - words.length) > 2) console.warn(`captions: counted ${w} words, narration has ${words.length}; caption timing may drift`);

// 3. The player: one page that draws any moment of the video.
const player = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#fff;overflow:hidden}
#stage{position:relative;width:${W}px;height:${H}px;overflow:hidden;background:#fff;font-family:Inter,"Helvetica Neue",Helvetica,Arial,sans-serif}
.shot{position:absolute;inset:0;transform-origin:0 0;opacity:0}
.shot img{position:absolute;left:0;top:0;width:${W}px;height:${H}px}
.box{position:absolute;border:5px solid #e66256;box-sizing:border-box;opacity:0}
#cap{position:absolute;left:0;right:0;bottom:0;background:rgba(255,255,255,.96);border-top:1.5px solid #111;padding:24px 140px 28px;
  font-size:40px;line-height:1.3;font-weight:500;color:#111;text-align:center;min-height:70px}
</style></head><body><div id="stage">
${timeline.map((s, i) => `<div class="shot" id="s${i}"><img src="${pathToFileURL(join(build, "shots", s.name + ".png"))}">${s.marks.map((m, j) => `<div class="box" id="s${i}b${j}"></div>`).join("")}</div>`).join("")}
<div id="cap"></div></div><script>
const T=${JSON.stringify(timeline)}, C=${JSON.stringify(captions)}, K=${W / SRC_W};
const ease=(x)=>x<=0?0:x>=1?1:x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2;
function render(t){
  T.forEach((s,i)=>{
    const el=document.getElementById('s'+i);
    const fadeIn=ease((t-s.start)/0.45), fadeOut=i+1<T.length?1-ease((t-T[i+1].start)/0.45):1;
    const vis=Math.min(fadeIn,fadeOut);
    el.style.opacity=vis; el.style.display=vis>0?'block':'none';
    if(vis<=0)return;
    let z=1,cx=${SRC_W / 2},cy=${SRC_H / 2};
    if(s.focus){const k=ease((t-(s.focus.at-1.1))/1.1); z=1+(s.focus.zoom-1)*k; cx=${SRC_W / 2}+(s.focus.cx-${SRC_W / 2})*k; cy=${SRC_H / 2}+(s.focus.cy-${SRC_H / 2})*k;}
    // Keep the view inside the screenshot.
    const vw=${SRC_W}/z, vh=${SRC_H}/z; const x0=Math.min(Math.max(cx-vw/2,0),${SRC_W}-vw), y0=Math.min(Math.max(cy-vh/2,0),${SRC_H}-vh);
    el.style.transform='scale('+z+') translate('+(-x0*K)+'px,'+(-y0*K)+'px)';
    s.marks.forEach((m,j)=>{
      const b=document.getElementById('s'+i+'b'+j), k=ease((t-m.at)/0.35), pad=8;
      b.style.opacity=k; const grow=(1-k)*14;
      b.style.left=((m.x-pad-grow)*K)+'px'; b.style.top=((m.y-pad-grow)*K)+'px';
      b.style.width=((m.w+2*pad+2*grow)*K)+'px'; b.style.height=((m.h+2*pad+2*grow)*K)+'px';
      b.style.borderWidth=(5/z)+'px';
    });
  });
  const c=C.find((c)=>t>=c.start-0.1&&t<c.end-0.1); document.getElementById('cap').textContent=c?c.text:'';
}
</script></body></html>`;
await writeFile(join(build, "player.html"), player);

// 4. Frames → ffmpeg, with the narration.
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.goto(pathToFileURL(join(build, "player.html")).href);
await page.waitForLoadState("load");
await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
const mp4 = join(docs, "demo.mp4");
const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-r", String(FPS), "-i", "pipe:0",
  "-i", join(build, "narration.wav"), "-c:v", "libx264", "-preset", "slow", "-crf", "22", "-pix_fmt", "yuv420p", "-tune", "stillimage",
  "-af", "apad", "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", mp4], { stdio: ["pipe", "inherit", "inherit"] });
const frames = Math.ceil(duration * FPS);
for (let f = 0; f < frames; f++) {
  await page.evaluate((t) => render(t), f / FPS);
  const jpg = await page.screenshot({ type: "jpeg", quality: 92 });
  if (!ff.stdin.write(jpg)) await new Promise((r) => ff.stdin.once("drain", r));
  if (f % 300 === 0) console.log(`frame ${f}/${frames}`);
}
ff.stdin.end();
await new Promise((ok, bad) => ff.on("exit", (code) => (code === 0 ? ok() : bad(new Error("ffmpeg failed")))));

// Poster: the walkthrough moment, with a play mark, for the README.
const walk = timeline.find((s) => s.name === "walk2");
await page.evaluate((t) => render(t), walk.marks[0].at + 1.2);
await page.screenshot({ path: join(build, "poster-raw.png") });
await browser.close();
console.log(`wrote ${mp4} (${duration.toFixed(1)} s)`);
