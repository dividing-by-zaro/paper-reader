// Paper Reader: a local web app that walks you through a research paper in four passes.
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, resolve, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "./lib/store.mjs";
import { loadKeys, startGuide, STAGES, NOTES_VERSION, PROFILE_CATEGORIES } from "./lib/agent.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const dataDir = resolve(process.env.PAPER_READER_DATA ?? join(root, "data"));
const python = join(root, ".venv/bin/python");
const MAX_PDF = 40 * 1024 * 1024;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };

await loadKeys();
const store = createStore(dataDir, root);
await store.init();
const guide = await startGuide({ stateDir: join(dataDir, "harness"), store });
const PAPER_VERSION = 6; // matches PAPER_VERSION in ingest.py

// Re-read papers saved by an older extractor (better tables, figure text positions), one at a time.
async function migrate() {
  for (const meta of await store.list()) {
    const paper = await store.paper(meta.id);
    if (!paper) continue;
    if (paper.version === PAPER_VERSION) {
      // Notes interrupted by a restart pick up where they stopped.
      if (["queued", "running"].includes(meta.notesStatus)) await guide.noteFigures(meta.id);
      if (meta.highlightStatus === "running") void guide.autoHighlight(meta.id);
      continue;
    }
    const dir = store.paperDir(meta.id);
    try {
      const before = new Map(paper.figures.map((f) => [f.id, `${f.width}x${f.height}`]));
      const summary = await ingest(join(dir, "paper.pdf"), dir);
      const after = await store.paper(meta.id);
      const same = new Set(after.figures.filter((f) => before.get(f.id) === `${f.width}x${f.height}` && f.texts).map((f) => f.id));
      await store.updateMeta(meta.id, (m) => {
        m.figures = summary.figures;
        // Keep walkthroughs for figures whose crop did not change.
        m.walkthroughs = Object.fromEntries(Object.entries(m.walkthroughs ?? {}).filter(([fid]) => same.has(fid)));
      });
      console.log(`re-read ${meta.title}: ${summary.figures} figures and tables`);
      await guide.noteFigures(meta.id);
      // Paragraph text can change when a paper is re-read; highlight anything new (done ones are cached).
      if (meta.highlightStatus) void guide.autoHighlight(meta.id);
    } catch (error) {
      console.error(`re-read ${meta.title} failed:`, error.message);
    }
  }
}

const json = (res, status, value) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
};
const fail = (status, message) => Object.assign(Error(message), { status });

async function body(req, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw fail(413, "That file is too large (40 MB limit).");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
const jsonBody = async (req, max = 64 * 1024) => JSON.parse((await body(req, max)).toString("utf8") || "{}");

function ingest(pdfPath, outDir) {
  return new Promise((ok, no) => {
    execFile(python, ["-I", join(root, "ingest.py"), pdfPath, outDir], { timeout: 180000, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      if (error) {
        const last = (stderr || error.message).trim().split("\n").pop();
        return no(fail(422, /OCR|at most/.test(last) ? last : "This PDF could not be read."));
      }
      ok(JSON.parse(stdout.trim().split("\n").pop()));
    });
  });
}

async function addPaper(bytes, source) {
  if (bytes.subarray(0, 1024).indexOf("%PDF-") === -1) throw fail(415, "Choose a PDF file.");
  const id = store.newId();
  const dir = store.paperDir(id);
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(join(dir, "paper.pdf"), bytes);
    const summary = await ingest(join(dir, "paper.pdf"), dir);
    await store.updateMeta(id, (m) =>
      Object.assign(m, {
        id,
        title: summary.title,
        source,
        added: new Date().toISOString(),
        stage: 1,
        reached: 1,
        figures: summary.figures,
        notes: ["", "", "", ""],
        figureNotes: {},
        notesStatus: "queued",
        highlightStatus: "queued",
        chats: {},
      }),
    );
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  void guide.noteFigures(id);
  void guide.autoHighlight(id);
  return id;
}

function arxivUrl(input) {
  const s = String(input ?? "").trim();
  const m = s.match(/^(?:https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/)?((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?)(?:\.pdf)?\/?$/i);
  if (!m) throw fail(400, "Paste an arXiv link or ID, like 1706.03762.");
  return { id: m[1], url: `https://arxiv.org/pdf/${m[1]}` };
}

const server = createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  );
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  try {
    // Local only: reject other hosts (DNS rebinding) and cross-origin calls.
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host) && !host.endsWith(".localhost")) throw fail(403, "Host not allowed.");
    const local = (h) => ["localhost", "127.0.0.1", "[::1]"].includes(h) || h.endsWith(".localhost");
    if (req.method !== "GET" && req.headers.origin && !local(new URL(req.headers.origin).hostname)) throw fail(403, "Origin not allowed.");

    // Static app files.
    if (req.method === "GET" && !path.startsWith("/api/") && !path.startsWith("/files/")) {
      const file = normalize(join(publicDir, path === "/" ? "index.html" : path));
      if (!file.startsWith(publicDir)) throw fail(404, "Not found.");
      const data = await readFile(file).catch(() => null);
      if (!data) throw fail(404, "Not found.");
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
      return res.end(data);
    }

    // Figure and equation images: /files/<paper id>/(figures|math)/<name>.png
    let m = path.match(/^\/files\/([a-f0-9-]{36})\/((?:figures|math|views)\/[a-z0-9.-]+\.png)$/);
    if (req.method === "GET" && m) {
      const data = await readFile(join(store.paperDir(m[1]), m[2])).catch(() => null);
      if (!data) throw fail(404, "Not found.");
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "max-age=86400" });
      return res.end(data);
    }

    if (req.method === "GET" && path === "/api/library") return json(res, 200, { papers: await store.list(), stages: STAGES });

    if (req.method === "POST" && path === "/api/papers") {
      const id = await addPaper(await body(req, MAX_PDF), { kind: "upload", name: String(url.searchParams.get("name") ?? "").slice(0, 200) });
      return json(res, 201, { id });
    }

    if (req.method === "POST" && path === "/api/papers/arxiv") {
      const { id: arxivId, url: pdfUrl } = arxivUrl((await jsonBody(req)).url);
      const r = await fetch(pdfUrl, { redirect: "follow", signal: AbortSignal.timeout(60000) }).catch(() => null);
      if (!r?.ok) throw fail(502, "arXiv did not return that paper.");
      const bytes = Buffer.from(await r.arrayBuffer());
      if (bytes.length > MAX_PDF) throw fail(413, "That paper is too large (40 MB limit).");
      return json(res, 201, { id: await addPaper(bytes, { kind: "arxiv", arxivId }) });
    }

    m = path.match(/^\/api\/papers\/([a-f0-9-]{36})\/figures\/([a-z0-9-]{1,40})\/walkthrough$/);
    if (req.method === "POST" && m) {
      if (!(await store.meta(m[1]))) throw fail(404, "Paper not found.");
      try {
        return json(res, 200, await guide.walkFigure(m[1], m[2]));
      } catch (error) {
        console.error("walkthrough:", error.message);
        throw error.status ? error : fail(502, "The walkthrough could not be made. Try again.");
      }
    }

    m = path.match(/^\/api\/papers\/([a-f0-9-]{36})(?:\/(ask|progress|notes|figure-notes|highlight|rewrite|done))?$/);
    if (m) {
      const [, id, action] = m;
      const meta = await store.meta(id);
      if (!meta) throw fail(404, "Paper not found.");

      if (req.method === "GET" && !action) {
        // Notes written under older instructions are rewritten in the background.
        // Papers added before automatic highlighting get it the first time they are opened.
        if (!meta.highlightStatus || meta.highlightStatus === "queued") {
          meta.highlightStatus = "running";
          void guide.autoHighlight(id);
        }
        if (meta.notesVersion !== NOTES_VERSION && meta.notesStatus !== "running") {
          meta.notesStatus = "queued";
          meta.figureNotes = {};
          void guide.noteFigures(id);
        }
        return json(res, 200, { meta, paper: await store.paper(id) });
      }
      if (req.method === "DELETE" && !action) {
        await guide.forget(id);
        await store.remove(id);
        return json(res, 200, { ok: true });
      }
      if (req.method === "PUT" && action === "progress") {
        const stage = Number((await jsonBody(req)).stage);
        if (![1, 2, 3, 4].includes(stage)) throw fail(400, "Unknown pass.");
        return json(res, 200, await store.updateMeta(id, (x) => {
          x.stage = stage;
          x.reached = Math.max(x.reached ?? 1, stage);
          x.opened = new Date().toISOString();
        }));
      }
      if (req.method === "PUT" && action === "notes") {
        const notes = (await jsonBody(req)).notes;
        if (!Array.isArray(notes) || notes.length !== 4) throw fail(400, "Send four answers.");
        await store.updateMeta(id, (x) => void (x.notes = notes.map((n) => String(n ?? "").slice(0, 8000))));
        return json(res, 200, { ok: true });
      }
      // Progress: a pass read to the end, or a figure walked through to its last step.
      if (req.method === "POST" && action === "done") {
        const input = await jsonBody(req);
        const pass = Number(input.pass);
        const figure = String(input.figure ?? "");
        const paper = await store.paper(id);
        const updated = await store.updateMeta(id, (x) => {
          x.passesDone ??= [];
          x.figuresWalked ??= [];
          if ([1, 2, 3, 4].includes(pass) && !x.passesDone.includes(pass)) x.passesDone.push(pass);
          if (figure && paper?.figures.some((f) => f.id === figure) && !x.figuresWalked.includes(figure)) x.figuresWalked.push(figure);
        });
        return json(res, 200, { passesDone: updated.passesDone, figuresWalked: updated.figuresWalked });
      }
      if (req.method === "POST" && action === "highlight") {
        const input = await jsonBody(req, 512 * 1024);
        const paragraphs = (Array.isArray(input.paragraphs) ? input.paragraphs : [])
          .filter((p) => /^[a-z0-9]{1,16}$/.test(String(p?.key)) && typeof p.text === "string" && p.text.trim())
          .slice(0, 60)
          .map((p) => ({ key: String(p.key), text: p.text.slice(0, 6000) }));
        if (!paragraphs.length) throw fail(400, "Nothing to highlight.");
        return json(res, 200, { highlights: await guide.highlight(id, { section: String(input.section ?? "").slice(0, 200), paragraphs }) });
      }
      if (req.method === "POST" && action === "rewrite") {
        const input = await jsonBody(req, 64 * 1024);
        if (!/^[a-z0-9]{1,16}$/.test(String(input.key)) || typeof input.text !== "string" || !input.text.trim()) throw fail(400, "Nothing to rewrite.");
        return json(res, 200, { text: await guide.rewrite(id, { section: String(input.section ?? "").slice(0, 200), key: input.key, text: input.text.slice(0, 6000) }) });
      }
      if (req.method === "POST" && action === "figure-notes") {
        if (meta.notesStatus !== "running") void guide.noteFigures(id);
        return json(res, 202, { ok: true });
      }
      if (req.method === "POST" && action === "ask") {
        const input = await jsonBody(req, 9 * 1024 * 1024);
        const stage = Number(input.stage);
        const kind = ["start", "question", "draft"].includes(input.kind) ? input.kind : "question";
        const text = String(input.text ?? "").trim();
        if (![1, 2, 3, 4].includes(stage)) throw fail(400, "Unknown pass.");
        if (kind === "question" && (!text || text.length > 4000)) throw fail(400, "Ask a question of at most 4,000 characters.");
        res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
        res.flushHeaders();
        const emit = (e) => !res.destroyed && res.write(JSON.stringify(e) + "\n");
        const abort = new AbortController();
        let finished = false;
        res.on("close", () => !finished && abort.abort());
        try {
          await guide.ask(id, { stage, kind, text, view: input.view && typeof input.view === "object" ? input.view : null }, emit, abort.signal);
        } catch (error) {
          console.error("guide:", error.message);
          emit({ type: "error", text: error.status ? error.message : "The guide could not answer. Try again." });
        } finally {
          finished = true;
          res.end();
        }
        return;
      }
    }

    if (req.method === "GET" && path === "/api/memory") return json(res, 200, { ...(await store.memory()), categories: PROFILE_CATEGORIES });
    if (req.method === "POST" && path === "/api/memory/profile") {
      const input = await jsonBody(req);
      const text = String(input.text ?? "").trim().slice(0, 200);
      const category = PROFILE_CATEGORIES.includes(input.category) ? input.category : "About you";
      if (!text) throw fail(400, "Write something about yourself.");
      return json(res, 201, await store.updateMemory((mem) => void mem.profile.push({ id: store.newId(), text, category, source: "you", added: new Date().toISOString() })));
    }
    m = path.match(/^\/api\/memory\/profile\/([a-f0-9-]{36})$/);
    if (req.method === "DELETE" && m) return json(res, 200, await store.updateMemory((mem) => void (mem.profile = mem.profile.filter((p) => p.id !== m[1]))));
    if (req.method === "DELETE" && path === "/api/memory/questions") return json(res, 200, await store.updateMemory((mem) => void (mem.questions = [])));

    throw fail(404, "Not found.");
  } catch (error) {
    if (!error.status) console.error(error);
    if (!res.headersSent) json(res, error.status ?? 500, { error: error.status ? error.message : "Something went wrong." });
    else res.end();
  }
});
server.requestTimeout = 300000;
void migrate();

const port = Number(process.env.PORT ?? 4360);
server.listen(port, "127.0.0.1", () => console.log(`Paper Reader on http://localhost:${port}`));
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, async () => {
    server.closeAllConnections();
    await guide.shutdown().catch(() => {});
    process.exit(0);
  });
