// The demo video: what is said, which screen is shown, and what gets highlighted when.
// Each shot starts on a phrase of the narration; each box appears on its phrase.

const RESNET = "8ac0777e-362c-4e38-ad8f-bf001dec0940";
const ATTENTION = "51f7349b-3cdb-43d3-a262-7f88d72b2dbc";

export const NARRATION = [
  "This is Paper Reader. It helps you read a research paper the way Andrew Ng suggests: in four passes, from the big picture down to the math.",
  "Paste an arXiv link, and it pulls every figure and table out of the PDF.",
  "Pass one is just the title, the abstract and the figures. Each figure gets a side note with its main takeaway, in plain words.",
  "Want more? Walk me through it takes you through a figure step by step: first the axes, then what each line means, then the takeaway.",
  "And you can ask the guide anything. It sees exactly what you're looking at, highlights included.",
  "The next passes add the introduction and conclusion, then the full text with the equations folded away, and finally everything.",
  "Key points are highlighted for you. And any paragraph can be rewritten in plain words, with one click to undo.",
  "It keeps track of what you've read, and it learns about you from your questions, so every explanation fits you.",
  "Paper Reader runs on your own computer, and it's built on the OpenWorker SDK.",
].join(" ");

// Helpers run inside the page.
const scrollTo = (selector, offset = 80) => `(() => { const el = ${selector}; window.scrollTo(0, el.getBoundingClientRect().top + scrollY - ${offset}); })()`;
const hideDock = `document.getElementById('dock-close')?.click()`;

export const SHOTS = [
  {
    name: "library",
    from: "This is Paper Reader",
    url: "/#/",
    camera: null,
    targets: { table: ".pr-lib", h1: "h1" },
    boxes: [{ target: "table", at: "four passes" }],
  },
  {
    name: "add",
    from: "Paste an arXiv link",
    url: "/#/",
    prepare: [`(() => { const i = document.querySelector('.pr-add input'); i.value = 'https://arxiv.org/abs/1512.03385'; })()`],
    camera: "form",
    targets: { form: ".pr-add", input: ".pr-add input" },
    boxes: [{ target: "input", at: "arXiv link" }],
  },
  {
    name: "pass1",
    from: "Pass one is just",
    url: `/#/paper/${RESNET}/1`,
    prepare: [hideDock, scrollTo(`document.querySelector('.pr-passes')`, 60)],
    camera: null,
    targets: { tabs: ".pr-passes button[data-pass='1']", abstract: ".pr-abstract" },
    boxes: [
      { target: "tabs", at: "Pass one" },
      { target: "abstract", at: "the abstract" },
    ],
  },
  {
    name: "notes",
    from: "Each figure gets",
    url: `/#/paper/${RESNET}/1`,
    prepare: [hideDock, scrollTo(`document.querySelector('[data-figure="figure-1"]')`, 120)],
    camera: "row",
    targets: { row: "[data-figure='figure-1']", figure: "[data-figure='figure-1'] figure", note: "[data-note='figure-1']" },
    boxes: [
      { target: "figure", at: "Each figure" },
      { target: "note", at: "side note" },
    ],
  },
  ...[1, 2, 3, 6].map((step, i) => ({
    name: `walk${step}`,
    from: ["Walk me through it", "first the axes", "what each line means", "then the takeaway"][i],
    url: `/#/paper/${RESNET}/1`,
    prepare: [
      hideDock,
      `document.querySelector('[data-figure="figure-1"] .pr-figure-actions button').click()`,
      `wait:1500`,
      ...Array(step - 1).fill(`document.getElementById('wt-next').click()`),
      `wait:900`,
    ],
    // Frame the whole figure and the step beside it, so the camera never crops the figure.
    camera: ["canvas", "panel"],
    targets: { canvas: "#wt-canvas", panel: "#wt-panel", title: "#wt-title", button: "#walk-start" },
    boxes: i === 0 ? [{ target: "panel", at: "step by step" }] : [{ target: "title", at: ["first the axes", "what each line means", "then the takeaway"][i - 1] }],
  })),
  {
    name: "guide",
    from: "And you can ask the guide",
    url: `/#/paper/${RESNET}/1`,
    prepare: [
      `document.getElementById('dock-open')?.click()`,
      `document.querySelector('[data-figure="figure-1"] .pr-figure-actions button').click()`,
      `wait:1500`,
      `document.getElementById('wt-next').click()`,
      `document.getElementById('wt-next').click()`,
      `document.getElementById('wt-next').click()`,
      `wait:900`,
      `(() => { const t = document.getElementById('thread'); const chip = t.querySelector('.pr-view-chip'); if (chip) t.scrollTop = chip.offsetTop - 60; })()`,
    ],
    camera: null,
    targets: { chip: "#thread .pr-view-chip", context: "#ask-context", dock: "#dock" },
    boxes: [
      { target: "dock", at: "ask the guide" },
      { target: "chip", at: "what you're looking at" },
      { target: "context", at: "highlights included" },
    ],
  },
  {
    name: "pass2",
    from: "The next passes",
    url: `/#/paper/${ATTENTION}/2`,
    prepare: [hideDock, scrollTo(`document.querySelector('.pr-passes')`, 60)],
    camera: null,
    targets: { tab: ".pr-passes button[data-pass='2']" },
    boxes: [{ target: "tab", at: "introduction and conclusion" }],
  },
  {
    name: "pass3",
    from: "then the full text",
    url: `/#/paper/${ATTENTION}/3`,
    prepare: [hideDock, scrollTo(`document.querySelector('details.pr-math')`, 260)],
    camera: null,
    targets: { tab: ".pr-passes button[data-pass='3']", math: "details.pr-math" },
    boxes: [{ target: "math", at: "equations folded away" }],
  },
  {
    name: "pass4",
    from: "and finally everything",
    url: `/#/paper/${ATTENTION}/4`,
    prepare: [hideDock, scrollTo(`document.querySelector('.pr-math img')`, 260)],
    camera: null,
    targets: { math: ".pr-math img" },
    boxes: [{ target: "math", at: "finally everything" }],
  },
  {
    name: "highlights",
    from: "Key points are highlighted",
    url: `/#/paper/${RESNET}/2`,
    prepare: [hideDock, scrollTo(`[...document.querySelectorAll('p.pr-para')].find((p) => p.querySelector('mark'))`, 200)],
    camera: null,
    targets: { mark: "p.pr-para mark" },
    boxes: [{ target: "mark", at: "Key points" }],
  },
  {
    name: "rewrite",
    from: "And any paragraph",
    url: `/#/paper/${RESNET}/2`,
    prepare: [
      hideDock,
      // Show the saved rewrite of this paragraph (instant: it is cached), as a reader would by clicking its button.
      `[...document.querySelectorAll('p.pr-para')].find((p) => p.textContent.startsWith('Driven by')).closest('.pr-row').querySelectorAll('.pr-tool')[1].click()`,
      `wait:2000`,
      scrollTo(`document.querySelector('p.pr-para.is-rewritten')`, 220),
    ],
    camera: null,
    targets: { para: "p.pr-para.is-rewritten", undo: ".pr-tool.is-undo" },
    boxes: [
      { target: "para", at: "rewritten in plain words" },
      { target: "undo", at: "one click to undo" },
    ],
  },
  {
    name: "progress",
    from: "It keeps track",
    url: "/#/",
    camera: null,
    targets: { progress: ".pr-lib td.pr-lib-progress" },
    boxes: [{ target: "progress", at: "what you've read" }],
  },
  {
    name: "profile",
    from: "it learns about you",
    url: "/#/",
    prepare: [scrollTo(`document.querySelector('.pr-profile')`, 40)],
    camera: null,
    targets: { profile: ".pr-profile-groups" },
    boxes: [{ target: "profile", at: "learns about you" }],
  },
  {
    name: "end",
    from: "Paper Reader runs on",
    url: "/#/",
    camera: "h1",
    targets: { h1: "h1" },
    boxes: [],
  },
];
