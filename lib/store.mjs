// Library, per-paper state and the reader's memory, kept as JSON files under data/.
import { mkdir, readFile, writeFile, rm, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// The reader's profile: separate facts, each in a category. Older "preferences" become "How to explain" facts.
function normalizeMemory(m) {
  m.profile ??= [];
  m.questions ??= [];
  if (Array.isArray(m.preferences)) {
    for (const p of m.preferences)
      if (!m.profile.some((x) => x.text === p.text)) m.profile.push({ id: p.id, text: p.text, category: "How to explain", source: p.source, added: p.added });
    delete m.preferences;
  }
  return m;
}

export function createStore(dataDir, root) {
  const papersDir = join(dataDir, "papers");
  const memoryFile = join(dataDir, "memory.json");
  const ID = /^[a-f0-9-]{36}$/;

  async function readJson(file, fallback) {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch {
      return fallback;
    }
  }
  async function writeJson(file, value) {
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 1));
    await rename(tmp, file);
  }
  const dir = (id) => {
    if (!ID.test(id)) throw Object.assign(Error("Paper not found."), { status: 404 });
    return join(papersDir, id);
  };

  // One write queue per file so concurrent updates never interleave.
  const queues = new Map();
  function update(file, fallback, change) {
    const prev = queues.get(file) ?? Promise.resolve();
    const next = prev.then(async () => {
      const value = await readJson(file, fallback);
      const result = await change(value);
      await writeJson(file, value);
      return result ?? value;
    });
    queues.set(file, next.catch(() => {}));
    return next;
  }

  return {
    papersDir,
    root,
    newId: () => randomUUID(),
    paperDir: dir,
    async init() {
      await mkdir(papersDir, { recursive: true });
    },
    async list() {
      const ids = (await readdir(papersDir).catch(() => [])).filter((d) => ID.test(d));
      const metas = await Promise.all(ids.map((id) => readJson(join(papersDir, id, "meta.json"), null)));
      return metas.filter(Boolean).sort((a, b) => b.added.localeCompare(a.added));
    },
    meta: (id) => readJson(join(dir(id), "meta.json"), null),
    paper: (id) => readJson(join(dir(id), "paper.json"), null),
    updateMeta: (id, change) => update(join(dir(id), "meta.json"), {}, change),
    async remove(id) {
      await rm(dir(id), { recursive: true, force: true });
    },

    memory: async () => normalizeMemory(await readJson(memoryFile, {})),
    updateMemory: (change) => update(memoryFile, {}, (m) => change(normalizeMemory(m))),
  };
}
