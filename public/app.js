// Paper Reader front end: library, four reading passes, figure side notes and the guide dock.
const $ = (sel, el = document) => el.querySelector(sel);
const view = $("#view");
const state = { paper: null, meta: null, stages: null, stage: 1, poll: null, asking: false, dockWanted: true };

const PASSES = {
  1: ["Pass 1", "Title, abstract, figures"],
  2: ["Pass 2", "Intro, conclusion, skim"],
  3: ["Pass 3", "Read, skip the math"],
  4: ["Pass 4", "Read everything"],
};
const QUESTIONS = [
  "What did the authors try to accomplish?",
  "What are the key elements of the approach?",
  "What can I use myself?",
  "Which references do I want to follow?",
];

// ---------- helpers ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers ?? {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(data.error ?? "Something went wrong.");
  return data;
}

// Escaped, minimal Markdown with figure and table references turned into links.
function md(text) {
  const inline = (s) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, "$1<i>$2</i>")
      .replace(/\b(Figures?|Fig\.|Tables?)\s+(\d+(?:\.\d+)*[a-z]?)/g, (m, word, num) => {
        const label = `${/^Tab/.test(word) ? "Table" : "Figure"} ${num}`;
        return `<a class="figref" data-label="${label}">${m}</a>`;
      });
  const out = [];
  // Group consecutive lines into paragraphs, bullet lists and numbered lists.
  const kindOf = (l) => (/^\s*[-*•]\s+/.test(l) ? "ul" : /^\s*\d+[.)]\s+/.test(l) ? "ol" : l.trim() ? "p" : "");
  let group = null;
  const flush = () => {
    if (!group) return;
    if (group.kind === "p") out.push(`<p>${group.lines.map(inline).join("<br>")}</p>`);
    else out.push(`<${group.kind}>${group.lines.map((l) => `<li>${inline(l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ""))}</li>`).join("")}</${group.kind}>`);
    group = null;
  };
  for (const line of String(text).trim().split("\n")) {
    const kind = kindOf(line);
    if (!kind) {
      flush();
      continue;
    }
    if (group?.kind !== kind) {
      flush();
      group = { kind, lines: [] };
    }
    group.lines.push(line);
  }
  flush();
  return out.join("");
}

const fileUrl = (rel) => `/files/${state.meta.id}/${rel}`;
const date = (iso) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

const CHECK = (fresh = false) => h("span", { class: `pr-check ${fresh ? "is-new" : ""}`, "aria-hidden": "true", html: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>' });

// ---------- progress ----------
function passDoneText(fresh = false) {
  const n = state.stage;
  if (!state.meta.passesDone?.includes(n)) return "";
  const all = [1, 2, 3, 4].every((x) => state.meta.passesDone.includes(x));
  return h("span", { class: fresh ? "is-new" : "" }, CHECK(fresh), all ? `Pass ${n} done. You've read the whole paper.` : `Pass ${n} done`);
}

async function markDone(body) {
  const id = state.meta.id;
  const r = await api(`/api/papers/${id}/done`, { method: "POST", body: JSON.stringify(body) }).catch(() => null);
  if (!r || state.meta?.id !== id) return null;
  state.meta.passesDone = r.passesDone;
  state.meta.figuresWalked = r.figuresWalked;
  return r;
}

// A pass counts as read once you scroll to its end (or spend a little while on a page that fits the screen).
let endCheck = null;
function watchPassEnd() {
  if (endCheck) endCheck();
  const stage = state.stage;
  const id = state.meta.id;
  if (state.meta.passesDone?.includes(stage)) return;
  let done = false;
  const complete = async () => {
    if (done) return;
    done = true;
    stop();
    if (!(await markDone({ pass: stage })) || state.stage !== stage || state.meta.id !== id) return;
    $("#pr-end")?.replaceChildren(passDoneText(true));
    const b = $(`.pr-passes [data-pass="${stage}"] b`);
    if (b && !b.querySelector(".pr-check")) b.append(CHECK(true));
  };
  const check = () => {
    const end = $("#pr-end");
    if (!end || state.stage !== stage) return stop();
    const reached = end.getBoundingClientRect().top < window.innerHeight;
    const scrollable = document.documentElement.scrollHeight > window.innerHeight + 40;
    if (reached && scrollable && window.scrollY > 80) complete();
  };
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => ((ticking = false), check()));
  };
  const timer = setTimeout(() => {
    if (document.documentElement.scrollHeight <= window.innerHeight + 40 && state.stage === stage) complete();
  }, 15000);
  const stop = () => {
    window.removeEventListener("scroll", onScroll);
    clearTimeout(timer);
    endCheck = null;
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  endCheck = stop;
}

function figureWalked(id) {
  return state.meta.figuresWalked?.includes(id);
}

// ---------- routing ----------
window.addEventListener("hashchange", route);
async function route() {
  clearInterval(state.poll);
  const m = location.hash.match(/^#\/paper\/([a-f0-9-]{36})(?:\/(\d))?$/);
  if (m) return openPaper(m[1], Number(m[2] ?? 0));
  state.paper = state.meta = null;
  setDock(false);
  $("#dock-open").hidden = true;
  return renderLibrary();
}

// ---------- library ----------
async function renderLibrary() {
  document.title = "Paper Reader";
  const [{ papers }, memory] = await Promise.all([api("/api/library"), api("/api/memory")]);
  const status = h("p", { class: "pr-status", role: "status" });
  const input = h("input", { type: "text", placeholder: "arXiv link or ID, like 1706.03762", "aria-label": "arXiv link or ID" });
  const file = h("input", { type: "file", accept: "application/pdf,.pdf", hidden: true, onchange: () => file.files[0] && upload(file.files[0], status) });

  view.replaceChildren(
    h("div", { class: "pr-library" },
    h("h1", {}, "Paper library"),
    h("p", { class: "pr-purpose" }, "Add a paper, then read it in four passes: title, abstract and figures first; the full math last."),
    h(
      "form",
      { class: "pr-add", onsubmit: (e) => (e.preventDefault(), addArxiv(input.value, status)) },
      input,
      h("button", { class: "hs-button", type: "submit" }, "Add from arXiv"),
      h("button", { class: "hs-button", type: "button", onclick: () => file.click() }, "Upload a PDF"),
      file,
    ),
    status,
    h(
      "section",
      { class: "pr-section" },
      h("h2", {}, papers.length ? `${papers.length} paper${papers.length === 1 ? "" : "s"}` : "No papers yet"),
      papers.length
        ? h(
            "div",
            { class: "hs-scroll" },
            h(
              "table",
              { class: "hs-table pr-lib" },
              h("thead", {}, h("tr", {}, h("th", {}, "Paper"), h("th", {}, "Progress"), h("th", {}, "Added"), h("th", {}, ""))),
              h(
                "tbody",
                {},
                papers.map((p) => {
                  const passes = p.passesDone?.length ?? 0;
                  const walked = p.figuresWalked?.length ?? 0;
                  // Passes count for most of the progress; walked-through figures fill in the rest.
                  const share = (passes / 4) * 0.8 + (p.figures ? walked / p.figures : 0) * 0.2;
                  const meter = h("div", { class: "hs-meter c1", role: "img", "aria-label": `${passes} of 4 passes read, ${walked} of ${p.figures} figures walked through` }, h("span"));
                  meter.style.setProperty("--v", `${Math.round(share * 100)}%`);
                  return h(
                    "tr",
                    {},
                    h("td", {}, h("a", { href: `#/paper/${p.id}` }, p.title)),
                    h(
                      "td",
                      { class: "pr-lib-progress", title: `${passes} of 4 passes read, ${walked} of ${p.figures} figures walked through` },
                      meter,
                    ),
                    h("td", {}, date(p.added)),
                    h("td", {}, h("button", { class: "pr-link", type: "button", onclick: () => removePaper(p) }, "Remove")),
                  );
                }),
              ),
            ),
          )
        : h("p", { class: "pr-empty" }, "Add one above, or drop a PDF anywhere on this page."),
    ),
    renderMemory(memory),
    ),
  );
}

function renderMemory(memory) {
  const categories = memory.categories ?? ["About you", "Knows well", "New to", "Goals", "Interests", "How to explain"];
  const profile = memory.profile ?? [];
  const questions = (memory.questions ?? []).slice(-15).reverse();
  const input = h("input", { type: "text", placeholder: "For example: I teach high-school biology", "aria-label": "Something about you" });
  const pick = h("select", { class: "hs-select", "aria-label": "Category" }, categories.map((c) => h("option", { value: c }, c)));
  const forget = (p) => async () => (await api(`/api/memory/profile/${p.id}`, { method: "DELETE" }), renderLibrary());
  const groups = categories
    .map((c) => [c, profile.filter((p) => (p.category ?? "How to explain") === c)])
    .filter(([, items]) => items.length);
  return [
    h(
      "section",
      { class: "pr-section pr-memory pr-profile" },
      h("h2", {}, "Profile"),
      h("p", { class: "pr-purpose" }, "What the guide has learned about you, one fact at a time. It tailors every explanation to this."),
      groups.length
        ? h(
            "div",
            { class: "pr-profile-groups" },
            groups.map(([c, items]) =>
              h(
                "div",
                { class: "pr-profile-group" },
                h("h3", {}, c),
                h(
                  "ul",
                  {},
                  items.map((p) =>
                    h(
                      "li",
                      {},
                      h("span", {}, p.text, h("small", {}, p.source === "you" ? `Added by you, ${date(p.added)}` : p.from ? `Learned while reading ${p.from}, ${date(p.updated ?? p.added)}` : `Learned ${date(p.updated ?? p.added)}`)),
                      h("button", { class: "pr-link", type: "button", onclick: forget(p) }, "Forget"),
                    ),
                  ),
                ),
              ),
            ),
          )
        : h("p", { class: "pr-empty" }, "Nothing yet. Ask the guide questions as you read, or add something below."),
      h(
        "form",
        {
          class: "pr-add pr-profile-add",
          onsubmit: async (e) => {
            e.preventDefault();
            if (!input.value.trim()) return;
            await api("/api/memory/profile", { method: "POST", body: JSON.stringify({ text: input.value, category: pick.value }) });
            renderLibrary();
          },
        },
        pick,
        input,
        h("button", { class: "hs-button", type: "submit" }, "Add to profile"),
      ),
    ),
    h(
      "section",
      { class: "pr-section pr-memory" },
      h("h2", {}, "Questions you asked"),
      questions.length
        ? h("ul", {}, questions.map((q) => h("li", {}, h("span", {}, q.text, h("small", {}, `${q.paperTitle}, pass ${q.stage}, ${date(q.at)}`)))))
        : h("p", { class: "pr-empty" }, "Questions you ask while reading show up here. The guide uses them to spot what you find hard."),
      questions.length ? h("button", { class: "pr-link", type: "button", onclick: async () => confirm("Forget every question you've asked?") && (await api("/api/memory/questions", { method: "DELETE" }), renderLibrary()) }, "Forget all questions") : null,
    ),
  ];
}

async function addArxiv(value, status) {
  if (!value.trim()) return;
  status.className = "pr-status pr-spin";
  status.textContent = "Fetching from arXiv and pulling out the figures";
  try {
    const { id } = await api("/api/papers/arxiv", { method: "POST", body: JSON.stringify({ url: value }) });
    location.hash = `#/paper/${id}/1`;
  } catch (e) {
    status.className = "pr-status";
    status.textContent = e.message;
  }
}

async function upload(fileObj, status) {
  status = status ?? $(".pr-status");
  if (!/\.pdf$/i.test(fileObj.name) && fileObj.type !== "application/pdf") return status && (status.textContent = "Choose a PDF file.");
  if (status) {
    status.className = "pr-status pr-spin";
    status.textContent = "Reading the PDF and pulling out the figures";
  }
  try {
    const res = await fetch(`/api/papers?name=${encodeURIComponent(fileObj.name)}`, { method: "POST", headers: { "Content-Type": "application/pdf" }, body: fileObj });
    const data = await res.json();
    if (!res.ok) throw Error(data.error);
    location.hash = `#/paper/${data.id}/1`;
  } catch (e) {
    if (status) {
      status.className = "pr-status";
      status.textContent = e.message || "Upload failed.";
    }
  }
}

async function removePaper(p) {
  if (!confirm(`Remove “${p.title}” and its notes from your library?`)) return;
  await api(`/api/papers/${p.id}`, { method: "DELETE" });
  renderLibrary();
}

// Drag and drop anywhere on the library.
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (state.paper || !e.dataTransfer?.types.includes("Files")) return;
  dragDepth++;
  $("#drop").hidden = false;
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) $("#drop").hidden = true;
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("#drop").hidden = true;
  const f = e.dataTransfer?.files?.[0];
  if (f && !state.paper) upload(f);
});

// ---------- paper ----------
async function openPaper(id, stage) {
  let data;
  try {
    data = await api(`/api/papers/${id}`);
  } catch (e) {
    view.replaceChildren(h("a", { class: "pr-back", href: "#/" }, "← Library"), h("p", {}, e.message));
    return;
  }
  const sameStage = state.meta?.id === id && state.stage === (stage || data.meta.stage);
  state.paper = data.paper;
  state.meta = data.meta;
  state.stage = stage || data.meta.stage || 1;
  if (!stage) return void history.replaceState(null, "", `#/paper/${id}/${state.stage}`), openPaper(id, state.stage);
  document.title = `${state.paper.title} · Paper Reader`;
  if (state.meta.stage !== state.stage || (state.meta.reached ?? 1) < state.stage)
    api(`/api/papers/${id}/progress`, { method: "PUT", body: JSON.stringify({ stage: state.stage }) }).then((m) => (state.meta.reached = m.reached));
  renderPaper();
  if (!sameStage) window.scrollTo(0, 0);
  watchPassEnd();
  renderThread();
  setDock(state.dockWanted && window.innerWidth >= 1000);
  $("#dock-open").hidden = false;
  if (!(state.meta.chats?.[state.stage] ?? []).length) ask("start");
  watchNotes();
}

function renderPaper() {
  const { paper, stage } = state;
  const sections = paper.sections.filter((s) => s.title !== "Opening" || s.items.some((i) => i.type === "p" && i.text.length > 200));
  const intro = sections.find((s) => /introduction/i.test(s.title));
  const conclusion = [...sections].reverse().find((s) => /conclusion|discussion|summary/i.test(s.title) && s.level === 1);

  const body = [];
  if (stage === 1) {
    body.push(section("Abstract", paper.abstract ? paragraphRow(paper.abstract, null, "Abstract", "pr-abstract") : h("div", { class: "pr-row pr-text" }, h("p", {}, "No abstract found in this PDF."))));
    body.push(
      section(
        paper.figures.length ? `${paper.figures.length} figures and tables` : "No figures found",
        ...paper.figures.map((f, i) => figureRow(f, i + 1, { ask: true })),
      ),
    );
  } else if (stage === 2) {
    if (intro) body.push(section(intro.title, ...items(intro, { math: "skip", figures: false })));
    body.push(section("Figures again", ...paper.figures.map((f, i) => figureRow(f, i + 1, { compact: true }))));
    body.push(
      section(
        "Skim the rest",
        h(
          "div",
          {},
          sections
            .filter((s) => s !== intro && s !== conclusion && !/acknowledg/i.test(s.title))
            .map((s) =>
              h(
                "details",
                { class: `pr-skim ${s.level > 1 ? "pr-sub" : ""}` },
                h("summary", {}, h("b", {}, s.title), h("span", {}, firstSentence(s))),
                ...items(s, { math: "skip", figures: false }).map((row) => row),
              ),
            ),
        ),
      ),
    );
    if (conclusion) body.push(section(conclusion.title, ...items(conclusion, { math: "skip", figures: false })));
  } else {
    const numbers = new Map(paper.figures.map((f, i) => [f.id, i + 1]));
    for (const s of sections) body.push(section(s.title, ...items(s, { math: stage === 3 ? "collapse" : "show", figures: true, numbers }), s.level));
    if (stage === 4) {
      body.push(questionsSection());
      if (paper.references.length)
        body.push(section("References", h("ol", { class: "pr-refs" }, paper.references.map((r) => h("li", {}, r)))));
    }
  }

  view.replaceChildren(
    h("a", { class: "pr-back", href: "#/" }, "← Library"),
    h("h1", {}, paper.title),
    paper.authors ? h("p", { class: "pr-authors" }, paper.authors.replace(/\S+@\S+/g, "").replace(/\s·\s(?=\s|·|$)/g, "").slice(0, 400)) : null,
    passSwitcher(),
    h("p", { id: "pr-bg-status", class: "hs-label pr-spin pr-bg-status", role: "status", hidden: true }),
    ...body,
    h("div", { id: "pr-end", class: "pr-done-line", role: "status" }, passDoneText()),
    navButtons(),
  );
}

function passSwitcher() {
  return h(
    "nav",
    { class: "pr-passes", "aria-label": "Reading passes" },
    [1, 2, 3, 4].map((n) =>
      h(
        "button",
        { type: "button", "aria-pressed": String(n === state.stage), "data-pass": n, onclick: () => (location.hash = `#/paper/${state.meta.id}/${n}`) },
        h("b", {}, PASSES[n][0], state.meta.passesDone?.includes(n) ? CHECK() : null),
        PASSES[n][1],
      ),
    ),
  );
}

function navButtons() {
  const id = state.meta.id;
  return h(
    "div",
    { class: "pr-nav" },
    state.stage > 1 ? h("a", { class: "hs-button is-back", href: `#/paper/${id}/${state.stage - 1}` }, `Back to pass ${state.stage - 1}`) : h("span"),
    state.stage < 4 ? h("a", { class: "hs-button", href: `#/paper/${id}/${state.stage + 1}` }, `On to pass ${state.stage + 1}`) : h("a", { class: "hs-button", href: "#/" }, "Back to the library"),
  );
}

function section(title, ...rows) {
  let level = 1;
  if (typeof rows[rows.length - 1] === "number") level = rows.pop();
  const heading = level > 1 ? h("h3", {}, title) : h("h2", {}, title);
  const flat = rows.flat(Infinity).filter((r) => r instanceof Element);
  const hasParas = flat.some((r) => r.matches("[data-para]"));
  const el = h("section", { class: level > 1 ? "pr-subsection" : "pr-section" }, h("div", { class: "pr-row" }, heading, hasParas ? sectionTool() : null), ...rows);
  if (hasParas) syncSectionTool(el);
  return el;
}

// ---------- paragraph tools: highlight key points, rewrite for a busy parent ----------
const ICONS = {
  highlight: '<svg class="pr-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 4.5l5 5-8.5 8.5H6v-5z"/><path d="M12.5 6.5l5 5"/><path d="M4 21h9"/></svg>',
  rewrite: '<svg class="pr-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h12M4 11h9M4 16h6"/><path d="M18 13l1.1 2.4 2.4 1.1-2.4 1.1L18 20l-1.1-2.4-2.4-1.1 2.4-1.1z"/></svg>',
  undo: '<svg class="pr-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/></svg>',
};
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function hashKey(text) {
  let x = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) x = Math.imul(x ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return x.toString(36);
}

// Per paper: which paragraphs show highlights or a rewrite, remembered in this browser.
function ui() {
  const id = state.meta.id;
  if (state.ui?.id === id) return state.ui;
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(`pr-ui-${id}`) ?? "{}");
  } catch {}
  state.ui = { id, hlOff: new Set(saved.hlOff ?? []), rewritten: new Set(saved.rewritten ?? []) };
  return state.ui;
}
function saveUi() {
  try {
    localStorage.setItem(`pr-ui-${state.ui.id}`, JSON.stringify({ hlOff: [...state.ui.hlOff], rewritten: [...state.ui.rewritten] }));
  } catch {}
}
const phrasesFor = (key) => (ui().hlOff.has(key) ? [] : state.meta.highlights?.[key] ?? []);
const showingRewrite = (key) => ui().rewritten.has(key) && !!state.meta.rewrites?.[key];

function paragraphRow(text, page, sectionTitle, extra = "") {
  const key = hashKey(text);
  const para = h("p", { class: "pr-para", "data-key": key });
  para._text = text;
  para._page = page;
  renderPara(para);
  const hl = h("button", { class: "pr-tool", type: "button", onclick: () => toggleHighlight(para, sectionTitle) });
  const rw = h("button", { class: "pr-tool", type: "button", onclick: () => toggleRewrite(para, sectionTitle) });
  para._buttons = { hl, rw };
  syncButtons(para);
  return h("div", { class: `pr-row pr-text ${extra}`, "data-para": key }, para, h("div", { class: "pr-para-tools" }, hl, rw));
}

function syncButtons(para) {
  syncSectionTool(para.closest("section"));
  const key = para.dataset.key;
  const { hl, rw } = para._buttons;
  const lit = phrasesFor(key).length > 0 && !showingRewrite(key);
  hl.innerHTML = ICONS.highlight;
  hl.setAttribute("aria-pressed", String(lit));
  hl.setAttribute("aria-label", lit ? "Remove highlights" : "Highlight key points");
  hl.title = lit ? "Remove highlights" : "Highlight key points";
  hl.disabled = showingRewrite(key);
  const re = showingRewrite(key);
  rw.innerHTML = re ? ICONS.undo : ICONS.rewrite;
  rw.setAttribute("aria-label", re ? "Undo rewrite" : "Rewrite for a busy parent");
  rw.title = re ? "Undo rewrite: back to the original" : "Rewrite for a busy parent";
  rw.classList.toggle("is-undo", re);
}

// Fill a paragraph: the original with highlighted phrases, or the rewrite.
function renderPara(para, { sweep = false, words = false } = {}) {
  const key = para.dataset.key;
  const re = showingRewrite(key);
  para.classList.toggle("is-rewritten", re);
  para.replaceChildren();
  if (re) {
    const text = state.meta.rewrites[key];
    if (words && !reduceMotion()) {
      const parts = text.split(/(\s+)/);
      let n = 0;
      for (const part of parts) {
        if (!part.trim()) {
          para.append(part);
          continue;
        }
        const w = h("span", { class: "pr-w" }, part);
        w.style.animationDelay = `${Math.min(n++ * 14, 700)}ms`;
        para.append(w);
      }
    } else para.append(text);
    para.append(h("span", { class: "pr-rewritten-tag" }, "Rewritten"));
  } else {
    const text = para._text;
    const ranges = [];
    for (const phrase of phrasesFor(key)) {
      let at = text.indexOf(phrase);
      if (at < 0) at = text.toLowerCase().indexOf(phrase.toLowerCase());
      if (at >= 0 && !ranges.some(([a, b]) => at < b && at + phrase.length > a)) ranges.push([at, at + phrase.length]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    let pos = 0;
    ranges.forEach(([a, b], i) => {
      para.append(text.slice(pos, a));
      const mark = h("mark", { class: `pr-hl ${sweep && !reduceMotion() ? "is-sweep" : ""}` }, text.slice(a, b));
      mark.style.animationDelay = `${i * 180}ms`;
      para.append(mark);
      pos = b;
    });
    para.append(text.slice(pos));
  }
  if (para._page) para.append(h("span", { class: "pr-page" }, `p. ${para._page}`));
}

// Fade and blur the old text out, swap, and let the new text resolve in, easing the height between them.
async function dissolve(para, swap) {
  if (reduceMotion()) return swap();
  const before = para.offsetHeight;
  await para.animate([{ opacity: 1, filter: "blur(0)" }, { opacity: 0, filter: "blur(6px)" }], { duration: 280, easing: "ease-in", fill: "forwards" }).finished;
  swap();
  const after = para.offsetHeight;
  para.animate([{ height: `${before}px` }, { height: `${after}px` }], { duration: 380, easing: "cubic-bezier(.3,.7,.2,1)" });
  await para.animate([{ opacity: 0, filter: "blur(6px)" }, { opacity: 1, filter: "blur(0)" }], { duration: 420, easing: "ease-out" }).finished;
  para.getAnimations().forEach((a) => a.cancel());
}

async function toggleRewrite(para, sectionTitle) {
  const key = para.dataset.key;
  const { rw } = para._buttons;
  if (rw.classList.contains("is-busy")) return;
  if (showingRewrite(key)) {
    ui().rewritten.delete(key);
    saveUi();
    await dissolve(para, () => renderPara(para));
    syncButtons(para);
    return;
  }
  if (!state.meta.rewrites?.[key]) {
    rw.classList.add("is-busy");
    para.classList.add("is-thinking");
    try {
      const { text } = await api(`/api/papers/${state.meta.id}/rewrite`, { method: "POST", body: JSON.stringify({ key, text: para._text, section: sectionTitle }) });
      state.meta.rewrites = { ...(state.meta.rewrites ?? {}), [key]: text };
    } catch (e) {
      rw.title = e.message;
      return;
    } finally {
      rw.classList.remove("is-busy");
      para.classList.remove("is-thinking");
    }
  }
  ui().rewritten.add(key);
  saveUi();
  await dissolve(para, () => renderPara(para, { words: true }));
  syncButtons(para);
}

async function highlightParas(paras, sectionTitle) {
  const need = paras.filter((p) => !state.meta.highlights?.[p.dataset.key]);
  if (need.length) {
    const { highlights } = await api(`/api/papers/${state.meta.id}/highlight`, {
      method: "POST",
      body: JSON.stringify({ section: sectionTitle, paragraphs: need.map((p) => ({ key: p.dataset.key, text: p._text })) }),
    });
    state.meta.highlights = { ...(state.meta.highlights ?? {}), ...highlights };
  }
  for (const p of paras) {
    ui().hlOff.delete(p.dataset.key);
    if (!showingRewrite(p.dataset.key)) renderPara(p, { sweep: true });
    syncButtons(p);
  }
  saveUi();
}

async function unhighlight(paras) {
  for (const p of paras) {
    ui().hlOff.add(p.dataset.key);
    const marks = [...p.querySelectorAll("mark.pr-hl")];
    if (marks.length && !reduceMotion()) await Promise.all(marks.map((m) => m.animate([{ backgroundSize: "100% 100%" }, { backgroundSize: "0% 100%" }], { duration: 260, easing: "ease-in", fill: "forwards" }).finished));
    renderPara(p);
    syncButtons(p);
  }
  saveUi();
}

async function toggleHighlight(para, sectionTitle) {
  const { hl } = para._buttons;
  if (hl.classList.contains("is-busy")) return;
  if (phrasesFor(para.dataset.key).length) return unhighlight([para]);
  hl.classList.add("is-busy");
  try {
    await highlightParas([para], sectionTitle);
  } catch (e) {
    hl.title = e.message;
  } finally {
    hl.classList.remove("is-busy");
  }
}

// The section link says what it will do: highlight, or remove highlights when every paragraph already has them.
function syncSectionTool(sectionEl) {
  const label = sectionEl?.querySelector(".pr-section-tool-text");
  if (!label || sectionEl.querySelector(".pr-section-tool.is-busy")) return;
  const paras = [...sectionEl.querySelectorAll("p.pr-para")].filter((p) => !showingRewrite(p.dataset.key));
  label.textContent = paras.length && paras.every((p) => phrasesFor(p.dataset.key).length) ? "Remove highlights" : "Highlight key points";
}

function sectionTool() {
  const btn = h("button", { class: "pr-section-tool", type: "button" }, h("span", { html: ICONS.highlight }), h("span", { class: "pr-section-tool-text" }, "Highlight key points"));
  btn.addEventListener("click", async () => {
    const sectionEl = btn.closest("section");
    const title = $("h2, h3", sectionEl)?.textContent ?? "";
    const paras = [...sectionEl.querySelectorAll("p.pr-para")].filter((p) => !showingRewrite(p.dataset.key));
    if (!paras.length || btn.classList.contains("is-busy")) return;
    const allLit = paras.every((p) => phrasesFor(p.dataset.key).length);
    const label = $(".pr-section-tool-text", btn);
    if (allLit) {
      await unhighlight(paras);
      label.textContent = "Highlight key points";
      return;
    }
    btn.classList.add("is-busy");
    label.textContent = "Finding key points";
    label.classList.add("pr-spin");
    try {
      await highlightParas(paras, title);
      label.textContent = "Remove highlights";
    } catch (e) {
      label.textContent = e.message.length < 50 ? e.message : "Try again";
    } finally {
      btn.classList.remove("is-busy");
      label.classList.remove("pr-spin");
    }
  });
  return h("div", { class: "pr-side pr-section-tools" }, btn);
}

function firstSentence(s) {
  const p = s.items.find((i) => i.type === "p" && i.text.length > 40);
  if (!p) return "";
  const m = p.text.match(/^(.{40,280}?[.!?])(\s|$)/);
  return m ? m[1] : p.text.slice(0, 200) + "…";
}

function items(s, { math, figures, numbers }) {
  const rows = [];
  for (const it of s.items) {
    if (it.type === "figure") {
      if (!figures) continue;
      const f = state.paper.figures.find((x) => x.id === it.id);
      if (f) rows.push(figureRow(f, numbers.get(f.id)));
    } else if (it.type === "math") {
      if (math === "skip") continue;
      const img = it.file ? h("img", { src: fileUrl(it.file), alt: it.text, loading: "lazy", width: Math.round(it.width / 2.4) }) : h("p", {}, it.text);
      rows.push(
        h("div", { class: "pr-row" }, math === "collapse" ? h("details", { class: "pr-math" }, h("summary", {}, "Equation skipped. Show it"), img) : h("div", { class: "pr-math" }, img)),
      );
    } else {
      rows.push(paragraphRow(it.text, it.page, s.title));
    }
  }
  return rows;
}

function figureRow(f, n, { compact = false, ask = false } = {}) {
  const note = state.meta.figureNotes?.[f.id];
  const pending = !note && ["queued", "running"].includes(state.meta.notesStatus);
  const caption = f.caption.replace(/^\s*(Figure|Fig\.?|Table|Tab\.)\s*[A-Z]?\d+(?:\.\d+)*[a-z]?\s*[.:|]\s*/i, "");
  return h(
    "div",
    { class: "pr-row", "data-figure": f.id },
    h(
      "figure",
      { class: `pr-figure ${compact ? "is-compact" : ""}`, id: `fig-${f.id}`, "data-label": f.label },
      h("button", { class: "pr-figure-frame", type: "button", "aria-label": `Enlarge ${f.label}`, onclick: () => lightbox(f, n) }, h("img", { src: fileUrl(f.file), alt: f.caption, loading: "lazy" })),
      h("figcaption", {}, h("b", {}, f.label), " ", caption, h("span", { class: "pr-page" }, `p. ${f.page}`)),
      h(
        "div",
        { class: "pr-figure-actions" },
        figureWalked(f.id)
          ? h("span", { class: "pr-walked", "data-walked": f.id }, CHECK(), "Walked through", h("button", { class: "pr-link", type: "button", onclick: () => lightbox(f, n, { walk: true }) }, "Again"))
          : h("button", { class: "pr-link", type: "button", "data-walked": f.id, onclick: () => lightbox(f, n, { walk: true }) }, "Walk me through it"),
        ask ? h("button", { class: "pr-link", type: "button", onclick: () => prefill(`What should I notice in ${f.label}?`) }, `Ask about ${f.label}`) : null,
      ),
    ),
    h(
      "div",
      { class: `pr-side ${pending ? "is-pending" : ""}`, "data-note": f.id },
      h("p", { class: `pr-note-text ${pending ? "pr-spin" : ""}` }, note ?? (pending ? "Writing a note on this figure" : state.meta.notesStatus === "failed" ? "No note yet." : "")),
      !note && state.meta.notesStatus === "failed" ? h("button", { class: "pr-link", type: "button", style: null, onclick: retryNotes }, "Try again") : null,
    ),
  );
}

async function retryNotes() {
  await api(`/api/papers/${state.meta.id}/figure-notes`, { method: "POST" });
  state.meta.notesStatus = "running";
  renderPaper();
  watchNotes();
}

// While notes are being written, fill them in as they arrive.
const running = (status) => ["queued", "running"].includes(status);

// While figure notes or highlights are being made in the background, fill them in as they arrive.
function watchNotes() {
  clearInterval(state.poll);
  syncBackgroundStatus();
  if (!running(state.meta.notesStatus) && !running(state.meta.highlightStatus)) return;
  const id = state.meta.id;
  state.poll = setInterval(async () => {
    if (state.meta?.id !== id) return clearInterval(state.poll);
    const { meta } = await api(`/api/papers/${id}`).catch(() => ({}));
    if (!meta) return;
    state.meta.figureNotes = meta.figureNotes;
    state.meta.notesStatus = meta.notesStatus;
    state.meta.highlightStatus = meta.highlightStatus;
    for (const el of document.querySelectorAll("[data-note]")) {
      const note = meta.figureNotes?.[el.dataset.note];
      if (note && el.classList.contains("is-pending")) {
        el.classList.remove("is-pending");
        $(".pr-note-text", el).classList.remove("pr-spin");
        $(".pr-note-text", el).textContent = note;
      }
    }
    applyNewHighlights(meta.highlights ?? {});
    syncBackgroundStatus();
    if (!running(meta.notesStatus) && !running(meta.highlightStatus)) {
      clearInterval(state.poll);
      if (meta.notesStatus === "failed") renderPaper();
    }
  }, 2500);
}

function applyNewHighlights(highlights) {
  const before = state.meta.highlights ?? {};
  state.meta.highlights = highlights;
  for (const p of document.querySelectorAll("p.pr-para")) {
    const key = p.dataset.key;
    if (before[key]?.length || !highlights[key]?.length) continue;
    if (!ui().hlOff.has(key) && !showingRewrite(key)) renderPara(p, { sweep: true });
    syncButtons(p);
  }
}

function syncBackgroundStatus() {
  const el = $("#pr-bg-status");
  if (!el) return;
  const on = running(state.meta.highlightStatus);
  el.hidden = !on;
  el.textContent = on ? "Highlighting key points" : "";
}

function questionsSection() {
  const notes = [...(state.meta.notes ?? ["", "", "", ""])];
  const saved = h("span", { class: "pr-saved", role: "status" });
  let timer;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await api(`/api/papers/${state.meta.id}/notes`, { method: "PUT", body: JSON.stringify({ notes }) });
      state.meta.notes = [...notes];
      saved.textContent = "Saved";
    }, 600);
  };
  return h(
    "section",
    { class: "pr-section pr-questions" },
    h("div", { class: "pr-row" }, h("h2", {}, "The four questions")),
    h(
      "div",
      { class: "pr-row" },
      h(
        "div",
        {},
        QUESTIONS.map((q, i) => [
          h("label", { for: `q${i}` }, `${i + 1}. ${q}`),
          h("textarea", { id: `q${i}`, rows: 4, oninput: (e) => ((notes[i] = e.target.value), (saved.textContent = ""), save()) }, notes[i]),
        ]),
        h(
          "div",
          { class: "pr-ask-row" },
          saved,
          h("button", { class: "hs-button", type: "button", onclick: () => ask("draft") }, "Draft answers with the guide"),
        ),
      ),
      h("div", { class: "pr-side" }, h("p", { class: "pr-note-text" }, "Write these in your own words. The guide's draft appears in the guide panel for you to compare against.")),
    ),
  );
}

// ---------- figure references and lightbox ----------
document.addEventListener("click", (e) => {
  const a = e.target.closest("a.figref");
  if (!a || !state.paper) return;
  e.preventDefault();
  const fig = document.querySelector(`figure[data-label="${CSS.escape(a.dataset.label)}"]`);
  if (fig) {
    fig.scrollIntoView({ behavior: "smooth", block: "center" });
    fig.classList.add("is-flash");
    setTimeout(() => fig.classList.remove("is-flash"), 1600);
  } else {
    const i = state.paper.figures.findIndex((f) => f.label === a.dataset.label);
    if (i >= 0) lightbox(state.paper.figures[i], i + 1);
  }
});

const wt = { f: null, steps: [], i: 0, loading: false };
const SVG = "http://www.w3.org/2000/svg";

function lightbox(f, _n, { walk = false } = {}) {
  wt.f = f;
  wt.steps = [];
  $("#lightbox-title").textContent = f.label;
  $("#lightbox-img").src = fileUrl(f.file);
  $("#lightbox-img").alt = f.caption;
  $("#lightbox-caption").textContent = f.caption;
  $("#lightbox-note").textContent = state.meta.figureNotes?.[f.id] ?? "";
  $("#wt-svg").setAttribute("viewBox", `0 0 ${f.width} ${f.height}`);
  $("#wt-canvas").style.setProperty("--ar", String(f.width / f.height));
  endWalk();
  $("#lightbox").hidden = false;
  $("#lightbox-close").focus();
  state.ctxOn = true;
  if (window.innerWidth >= 1000 && state.dockWanted) setDock(true);
  $("#lightbox-guide").hidden = !$("#dock").hidden;
  updateContext();
  if (walk) startWalk();
}

function syncWalkedBar(fresh = false) {
  const tag = $("#lightbox-walked");
  const on = wt.f && figureWalked(wt.f.id);
  tag.hidden = !on;
  tag.replaceChildren(...(on ? [CHECK(fresh), "Walked through"] : []));
  if ($("#walk-start").textContent.startsWith("Walk")) $("#walk-start").textContent = on ? "Walk through again" : "Walk me through it";
}

function closeLightbox() {
  $("#lightbox").hidden = true;
  endWalk();
  updateContext();
}

function endWalk() {
  wt.i = 0;
  $("#wt-svg").replaceChildren();
  $("#wt-panel").hidden = true;
  $("#lightbox-text").hidden = false;
  $("#lightbox").classList.remove("is-walking");
  const b = $("#walk-start");
  b.hidden = false;
  b.disabled = false;
  b.classList.remove("pr-spin");
  b.textContent = "Walk me through it";
  syncWalkedBar();
  updateContext();
}

async function startWalk() {
  const f = wt.f;
  if (!f || wt.loading) return;
  const b = $("#walk-start");
  b.disabled = true;
  b.textContent = "Reading the figure";
  b.classList.add("pr-spin");
  wt.loading = true;
  try {
    const walk = state.meta.walkthroughs?.[f.id] ?? (await api(`/api/papers/${state.meta.id}/figures/${f.id}/walkthrough`, { method: "POST" }));
    if (wt.f !== f || $("#lightbox").hidden) return;
    state.meta.walkthroughs = { ...(state.meta.walkthroughs ?? {}), [f.id]: walk };
    wt.steps = walk.steps;
    wt.i = 0;
    b.hidden = true;
    $("#lightbox").classList.add("is-walking");
    $("#lightbox-text").hidden = true;
    $("#wt-panel").hidden = false;
    showStep();
  } catch (e) {
    b.textContent = e.message.length < 60 ? e.message : "Try the walkthrough again";
    b.disabled = false;
    b.classList.remove("pr-spin");
  } finally {
    wt.loading = false;
  }
}

function showStep() {
  const step = wt.steps[wt.i];
  const n = wt.steps.length;
  $("#wt-count").textContent = `Step ${wt.i + 1} of ${n}`;
  $("#wt-title").textContent = step.title;
  $("#wt-text").innerHTML = md(step.text);
  $("#wt-back").disabled = wt.i === 0;
  $("#wt-next").textContent = wt.i === n - 1 ? "Finish" : "Next";
  drawMarks(step.marks, wt.f.width, wt.f.height);
  $("#wt-next").focus({ preventScroll: true });
  updateContext();
  if (wt.i === n - 1 && !figureWalked(wt.f.id)) {
    const f = wt.f;
    markDone({ figure: f.id }).then((r) => {
      if (!r) return;
      syncWalkedBar(true);
      // Update the figure on the page behind the lightbox.
      for (const el of document.querySelectorAll(`[data-walked="${f.id}"]`)) {
        el.replaceWith(h("span", { class: "pr-walked", "data-walked": f.id }, CHECK(true), "Walked through", h("button", { class: "pr-link", type: "button", onclick: () => lightbox(f, 0, { walk: true }) }, "Again")));
      }
    });
  }
}

// Boxes that overlap or touch become one box around all of them.
function mergeBoxes(marks) {
  const boxes = marks.filter((m) => m.kind === "box").map((m) => ({ ...m }));
  const others = marks.filter((m) => m.kind !== "box");
  const near = (a, b) => {
    const gx = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w), 0);
    const gy = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h), 0);
    return gx <= 1.5 && gy <= 1.5;
  };
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++)
        if (near(boxes[i], boxes[j])) {
          const a = boxes[i], b = boxes[j];
          const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
          boxes[i] = { kind: "box", x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
          boxes.splice(j, 1);
          merged = true;
          break outer;
        }
  }
  return [...boxes, ...others];
}

function el(tag, attrs) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

// Draw a step's marks in image pixels; dim everything outside the boxes and circles.
function drawMarks(marks, W, H) {
  marks = mergeBoxes(marks);
  const svg = $("#wt-svg");
  svg.replaceChildren();
  const X = (v) => (v / 100) * W, Y = (v) => (v / 100) * H;
  const stroke = Math.max(W, H) / 260;
  const defs = el("defs", {});
  const head = el("marker", { id: "wt-head", viewBox: "0 0 10 10", refX: "8", refY: "5", markerWidth: "4.5", markerHeight: "4.5", orient: "auto-start-reverse" });
  head.append(el("path", { d: "M0 0L10 5L0 10z", class: "wt-head" }));
  defs.append(head);
  svg.append(defs);
  const holes = marks.filter((m) => m.kind === "box" || m.kind === "circle");
  if (holes.length) {
    const mask = el("mask", { id: "wt-mask", maskUnits: "userSpaceOnUse", x: 0, y: 0, width: W, height: H });
    mask.append(el("rect", { x: 0, y: 0, width: W, height: H, fill: "#fff" }));
    for (const m of holes) {
      if (m.kind === "box") mask.append(el("rect", { x: X(m.x), y: Y(m.y), width: X(m.w), height: Y(m.h), fill: "#000" }));
      else mask.append(el("ellipse", { cx: X(m.x + m.w / 2), cy: Y(m.y + m.h / 2), rx: X(m.w / 2) * 1.15, ry: Y(m.h / 2) * 1.15, fill: "#000" }));
    }
    defs.append(mask);
    svg.append(el("rect", { x: 0, y: 0, width: W, height: H, class: "wt-veil", mask: "url(#wt-mask)" }));
  }
  for (const m of marks) {
    if (m.kind === "box") svg.append(el("rect", { x: X(m.x), y: Y(m.y), width: X(m.w), height: Y(m.h), class: "wt-box wt-on", "stroke-width": stroke }));
    else if (m.kind === "circle") svg.append(el("ellipse", { cx: X(m.x + m.w / 2), cy: Y(m.y + m.h / 2), rx: X(m.w / 2) * 1.15, ry: Y(m.h / 2) * 1.15, class: "wt-circle wt-on", "stroke-width": stroke }));
    else if (m.kind === "arrow")
      svg.append(el("line", { x1: X(m.from[0]), y1: Y(m.from[1]), x2: X(m.to[0]), y2: Y(m.to[1]), class: "wt-arrow wt-on", "stroke-width": stroke, "marker-end": "url(#wt-head)" }));
  }
  // Labels last, so they sit on top; keep them inside the image.
  const size = Math.max(W, H) / 38;
  for (const m of marks.filter((x) => x.kind === "label")) {
    const anchor = m.x > 70 ? "end" : m.x < 30 ? "start" : "middle";
    const t = el("text", { x: X(m.x), y: Math.min(H - size * 0.3, Math.max(size, Y(m.y))), "text-anchor": anchor, "font-size": size, "stroke-width": size / 4, class: "wt-label wt-on" });
    t.textContent = m.text;
    svg.append(t);
  }
}

function stepBy(d) {
  if (!wt.steps.length) return;
  if (wt.i + d >= wt.steps.length) return endWalk();
  wt.i = Math.max(0, wt.i + d);
  showStep();
}

$("#walk-start").addEventListener("click", startWalk);
$("#wt-next").addEventListener("click", () => stepBy(1));
$("#wt-back").addEventListener("click", () => stepBy(-1));
$("#lightbox-close").addEventListener("click", closeLightbox);
$("#lightbox").addEventListener("click", (e) => e.target.id === "lightbox" && closeLightbox());
document.addEventListener("keydown", (e) => {
  if ($("#lightbox").hidden) return;
  if (e.target.closest?.("textarea, input")) return;
  if (e.key === "Escape") closeLightbox();
  else if (!$("#wt-panel").hidden && e.key === "ArrowRight") stepBy(1);
  else if (!$("#wt-panel").hidden && e.key === "ArrowLeft") stepBy(-1);
});

// ---------- guide dock ----------
function setDock(open) {
  $("#dock").hidden = !open;
  $("#dock-open").hidden = open || !state.paper;
  $("#lightbox-guide").hidden = open;
  document.body.classList.toggle("dock-open", open);
}
$("#lightbox-guide").addEventListener("click", () => ((state.dockWanted = true), setDock(true), $("#ask-text").focus()));

// ---------- sharing what you see with the guide ----------
const isWalking = () => !$("#wt-panel").hidden && wt.steps.length > 0;
const currentMarks = () => (isWalking() ? mergeBoxes(wt.steps[wt.i].marks) : []);

function loaded(img) {
  return img.complete && img.naturalWidth ? Promise.resolve() : new Promise((r) => img.addEventListener("load", r, { once: true }));
}

// The figure as it is on screen: the image with the current step's highlights and fade drawn in.
async function composeView(maxSide = 1600) {
  const img = $("#lightbox-img");
  await loaded(img);
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const W = Math.round(img.naturalWidth * scale), H = Math.round(img.naturalHeight * scale);
  const canvas = Object.assign(document.createElement("canvas"), { width: W, height: H });
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(img, 0, 0, W, H);
  const marks = currentMarks();
  const X = (v) => (v / 100) * W, Y = (v) => (v / 100) * H;
  const holes = marks.filter((m) => m.kind === "box" || m.kind === "circle");
  if (holes.length) {
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    for (const m of holes) {
      if (m.kind === "box") ctx.rect(X(m.x), Y(m.y), X(m.w), Y(m.h));
      else ctx.ellipse(X(m.x + m.w / 2), Y(m.y + m.h / 2), X(m.w / 2) * 1.15, Y(m.h / 2) * 1.15, 0, 0, Math.PI * 2);
    }
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.fill("evenodd");
  }
  const coral = "#e66256";
  ctx.strokeStyle = coral;
  ctx.fillStyle = coral;
  ctx.lineWidth = Math.max(W, H) / 260;
  ctx.lineCap = "round";
  for (const m of marks) {
    ctx.beginPath();
    if (m.kind === "box") ctx.strokeRect(X(m.x), Y(m.y), X(m.w), Y(m.h));
    else if (m.kind === "circle") {
      ctx.ellipse(X(m.x + m.w / 2), Y(m.y + m.h / 2), X(m.w / 2) * 1.15, Y(m.h / 2) * 1.15, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (m.kind === "arrow") {
      const [x1, y1, x2, y2] = [X(m.from[0]), Y(m.from[1]), X(m.to[0]), Y(m.to[1])];
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      const a = Math.atan2(y2 - y1, x2 - x1), s = ctx.lineWidth * 4;
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - s * Math.cos(a - 0.45), y2 - s * Math.sin(a - 0.45));
      ctx.lineTo(x2 - s * Math.cos(a + 0.45), y2 - s * Math.sin(a + 0.45));
      ctx.closePath();
      ctx.fill();
    }
  }
  const size = Math.max(W, H) / 38;
  ctx.font = `500 ${size}px Inter, Helvetica, Arial, sans-serif`;
  ctx.lineJoin = "round";
  for (const m of marks.filter((x) => x.kind === "label")) {
    ctx.textAlign = m.x > 70 ? "right" : m.x < 30 ? "left" : "center";
    const y = Math.min(H - size * 0.3, Math.max(size, Y(m.y)));
    ctx.lineWidth = size / 4;
    ctx.strokeStyle = "#fff";
    ctx.strokeText(m.text, X(m.x), y);
    ctx.fillStyle = "#111";
    ctx.fillText(m.text, X(m.x), y);
  }
  return canvas;
}

function viewStep() {
  if (!isWalking()) return null;
  const st = wt.steps[wt.i];
  return { index: wt.i, count: wt.steps.length, title: st.title, text: st.text };
}

let contextTick = 0;
async function updateContext() {
  const card = $("#ask-context");
  if ($("#lightbox").hidden || !wt.f) {
    card.hidden = true;
    return;
  }
  const tick = ++contextTick;
  const canvas = await composeView(360);
  if (tick !== contextTick) return;
  const step = viewStep();
  $("#ctx-thumb").src = canvas.toDataURL("image/png");
  $("#ctx-label").textContent = state.ctxOn ? `Sharing what you see: ${wt.f.label}` : `Not sharing ${wt.f.label}`;
  $("#ctx-step").textContent = step ? `Step ${step.index + 1} of ${step.count} · ${step.title}` : "The whole figure, enlarged";
  $("#ctx-toggle").textContent = state.ctxOn ? "Don't include" : "Include";
  card.classList.toggle("is-off", !state.ctxOn);
  card.hidden = false;
}
$("#ctx-toggle").addEventListener("click", () => ((state.ctxOn = !state.ctxOn), updateContext()));

// Fly the figure from where it sits into the message's thumbnail.
function flyInto(chip, dataUrl) {
  const target = $("img", chip);
  const source = $("#wt-canvas img");
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || !source || $("#lightbox").hidden) {
    chip.classList.remove("is-arriving");
    return;
  }
  const from = source.getBoundingClientRect(), to = target.getBoundingClientRect();
  const flyer = Object.assign(document.createElement("img"), { src: dataUrl, className: "pr-flyer", alt: "" });
  Object.assign(flyer.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
  document.body.append(flyer);
  const sx = to.width / from.width, sy = to.height / from.height, s = Math.min(sx, sy);
  const dx = to.left + (to.width - from.width * s) / 2 - from.left, dy = to.top + (to.height - from.height * s) / 2 - from.top;
  const anim = flyer.animate(
    [
      { transform: "translate(0, 0) scale(1)", opacity: 1, offset: 0 },
      { transform: `translate(${dx * 0.35}px, ${dy * 0.2 - 30}px) scale(${0.55 + s * 0.45})`, opacity: 1, offset: 0.4 },
      { transform: `translate(${dx}px, ${dy}px) scale(${s})`, opacity: 0.9, offset: 1 },
    ],
    { duration: 750, easing: "cubic-bezier(.3,.7,.2,1)" },
  );
  anim.onfinish = () => {
    flyer.remove();
    chip.classList.remove("is-arriving");
    chip.classList.add("is-landed");
  };
}
$("#dock-close").addEventListener("click", () => ((state.dockWanted = false), setDock(false)));
$("#dock-open").addEventListener("click", () => ((state.dockWanted = true), setDock(true)));

function renderThread() {
  $("#dock-title").textContent = `Guide · ${PASSES[state.stage][0]}: ${PASSES[state.stage][1]}`;
  const msgs = state.meta.chats?.[state.stage] ?? [];
  $("#thread").replaceChildren(...msgs.map(message));
  $("#thread").scrollTop = $("#thread").scrollHeight;
}

function message(m) {
  const el = h("div", { class: `pr-msg ${m.role === "you" ? "is-you" : ""}` }, h("span", { class: "pr-who" }, m.role === "you" ? "You" : m.kind === "draft" ? "Guide · draft answers" : "Guide"));
  if (m.view) {
    const fig = state.paper?.figures.find((f) => f.id === m.view.figureId);
    el.append(
      h(
        "button",
        { class: `pr-view-chip ${m.arriving ? "is-arriving" : ""}`, type: "button", title: `Open ${m.view.label}`, onclick: () => fig && lightbox(fig) },
        h("img", { src: m.view.src ?? fileUrl(m.view.file), alt: `${m.view.label} as you saw it` }),
        h("span", {}, h("b", {}, m.view.label), m.view.step ?? "The whole figure"),
      ),
    );
  }
  const body = h("div", { html: m.role === "you" ? `<p>${esc(m.text)}</p>` : md(m.text) });
  el.append(body);
  return el;
}

function prefill(text) {
  state.dockWanted = true;
  setDock(true);
  $("#ask-text").value = text;
  $("#ask-text").focus();
}

$("#ask").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("#ask-text").value.trim();
  if (text) ask("question", text);
});
$("#ask-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("#ask").requestSubmit();
  }
});

async function ask(kind, text = "") {
  if (state.asking || !state.meta) return;
  const id = state.meta.id;
  const stage = state.stage;
  state.asking = true;
  if (kind !== "start") {
    state.dockWanted = true;
    setDock(true);
  }
  const status = $("#ask-status");
  status.className = "hs-label pr-spin";
  status.textContent = kind === "start" ? "The guide is reading" : "Thinking";
  const thread = $("#thread");
  let view = null;
  if (kind === "question" && !$("#lightbox").hidden && wt.f && state.ctxOn) {
    const canvas = await composeView();
    const step = viewStep();
    const src = canvas.toDataURL("image/png");
    view = { figureId: wt.f.id, step, image: src.split(",")[1], src, label: wt.f.label };
  }
  if (kind === "question") {
    const mine = message({ role: "you", text, arriving: !!view, view: view && { figureId: view.figureId, label: view.label, src: view.src, step: view.step ? `Step ${view.step.index + 1} of ${view.step.count}: ${view.step.title}` : null } });
    thread.append(mine);
    thread.scrollTop = thread.scrollHeight;
    $("#ask-text").value = "";
    if (view) flyInto($(".pr-view-chip", mine), view.src);
  }
  const live = message({ role: "guide", text: "", kind });
  thread.append(live);
  thread.scrollTop = thread.scrollHeight;
  const bodyEl = live.lastChild;
  try {
    const res = await fetch(`/api/papers/${id}/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stage, kind, text, ...(view ? { view: { figureId: view.figureId, step: view.step, image: view.image } } : {}) }) });
    if (!res.ok) throw Error((await res.json().catch(() => ({}))).error ?? "The guide could not answer.");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let final = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.type === "snapshot" || ev.type === "done") {
          bodyEl.innerHTML = md(ev.text);
          const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
          if (nearBottom) thread.scrollTop = thread.scrollHeight;
        }
        if (ev.type === "done") final = ev;
        if (ev.type === "error") throw Error(ev.text);
      }
    }
    if (!final) throw Error("The answer was cut off. Try again.");
    if (final.remembered?.length) live.append(h("div", { class: "pr-remembered" }, h("b", {}, "Added to your profile"), h("ul", {}, final.remembered.map((t) => h("li", {}, t)))));
    if (state.meta?.id === id) {
      const at = new Date().toISOString();
      state.meta.chats ??= {};
      state.meta.chats[stage] ??= [];
      if (kind === "question") state.meta.chats[stage].push({ role: "you", text, at, ...(final.view ? { view: final.view } : {}) });
      state.meta.chats[stage].push({ role: "guide", text: final.text, at, kind });
    }
    status.textContent = "";
  } catch (e) {
    // A walkthrough already running (say, from before a reload): wait for it instead of failing.
    if (kind === "start" && /still answering/.test(e.message)) {
      bodyEl.innerHTML = "<p>The guide is still writing this walkthrough…</p>";
      for (let i = 0; i < 40 && state.meta?.id === id && state.stage === stage; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const { meta } = await api(`/api/papers/${id}`).catch(() => ({}));
        if (meta?.chats?.[stage]?.length) {
          state.meta.chats = meta.chats;
          renderThread();
          break;
        }
      }
      status.textContent = "";
      return;
    }
    bodyEl.innerHTML = `<p>${esc(e.message)}</p>`;
    if (kind === "question") $("#ask-text").value = text;
    status.textContent = "";
  } finally {
    status.className = "hs-label";
    state.asking = false;
    // If the reader moved to a pass that has no walkthrough yet while this ran, start it now.
    if (state.meta?.id === id && state.stage !== stage) {
      renderThread();
      if (!(state.meta.chats?.[state.stage] ?? []).length) ask("start");
    }
  }
}

route();
