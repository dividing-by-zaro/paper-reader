# Paper Reader

A local web app that walks you through a research paper with Andrew Ng's four passes, using an OpenWorker agent.

1. Title, abstract and figures
2. Introduction, conclusion, figures again, skim the rest
3. Read it, skip the math (equations collapsed)
4. Read everything, then answer the four questions

Each figure and table is cropped out of the PDF and gets a side note with its main takeaway, in plain words. "Walk me through it" on any figure gives a step-by-step tour with boxes, circles, arrows and labels drawn on it. Graphs go axes first, then the data, then the takeaway. Flow charts go stage by stage. Tables go rows, columns, then the key comparison. Key phrases in every paragraph are highlighted in the background as soon as a paper is added. Each paragraph also has margin buttons to turn its highlights on or off, and to rewrite it in plain words, with undo. A guide panel walks you through each pass and answers questions. It builds a profile of you over time, one fact at a time (who you are, what you know, what you are new to, your goals, interests, and how you like things explained), taken from the questions you ask. Every explanation uses it.

## Run

```bash
npm install
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
portless paper-reader node server.mjs   # https://paper-reader.localhost
```

The model is `gpt-6-astra` through the OpenAI Responses API. Set `OPENAI_API_KEY` in the environment or in a `.env` file in this folder (`OPENAI_API_KEY=...`). Set `PAPER_READER_ENV` to read another `.env` file, or `PAPER_READER_MODEL` to use another model.

## Files

- `ingest.py`: PDF to `paper.json`, figure and table crops (PyMuPDF; tables are matched with `find_tables`), positions of the text inside each figure, and equation images. Bump `PAPER_VERSION` (and the copy in `server.mjs`) to have saved papers re-read on the next start
- `grid.py`: draws a labelled 10% grid over a figure so the walkthrough model can read positions
- `lib/agent.mjs`: OpenWorker harness, reading guide (with a `memory.save_preference` tool), figure note writer, figure walkthrough writer
- `lib/store.mjs`: library, per-paper state and memory, saved as JSON under `data/`
- `server.mjs`: HTTP API and static files
- `public/`: the app (house style)

Agent definitions can't be changed once created. If you change an agent's instructions, also change its name (for example `figure-noter-v2`) and bump `NOTES_VERSION`.
