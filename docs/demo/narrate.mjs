// Narration: one Cartesia text-to-speech call (server-sent events) returning the audio and a time for every word.
// Adapted from lesson-preview's lib/narrate.mjs.
import { spawn } from "node:child_process";

const URL = "https://api.cartesia.ai/tts/sse";
const API_VERSION = "2026-08-14";
const SAMPLE_RATE = 44100;

// Written forms the voice reads wrong, and what to send instead.
const SPOKEN_FORMS = [
  ["Andrew Ng", "Andrew Ing"],
  ["arXiv", "archive"],
  ["OpenWorker", "Open Worker"],
];
export function spoken(text) {
  for (const [written, said] of SPOKEN_FORMS) text = text.split(written).join(said);
  return text;
}

const run = (argv, input) =>
  new Promise((ok, bad) => {
    const p = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    let err = "";
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", bad);
    p.stdin.on("error", () => {});
    p.on("exit", (code) => (code === 0 ? ok(Buffer.concat(out)) : bad(new Error(`${argv[0]} exited ${code}: ${err.slice(-500)}`))));
    p.stdin.end(input);
  });

export async function narrate(text, { voiceId, model = "sonic-3.6", apiKey = process.env.CARTESIA_API_KEY }) {
  if (!apiKey) throw new Error("CARTESIA_API_KEY is missing (set it or put it in .env)");
  if (!voiceId) throw new Error("Set DEMO_VOICE_ID to a Cartesia voice id");
  const res = await fetch(URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Cartesia-Version": API_VERSION, "Content-Type": "application/json" },
    body: JSON.stringify({
      model_id: model,
      transcript: spoken(text),
      voice: voiceId,
      output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: SAMPLE_RATE },
      add_timestamps: true,
      use_normalized_timestamps: false,
      language: "en",
    }),
  });
  if (!res.ok) throw new Error(`Cartesia rejected the narration (${res.status}): ${(await res.text()).slice(0, 800)}`);
  const audio = [], words = [], starts = [], ends = [];
  let done = false, buffer = "";
  const handle = (line) => {
    if (!line.startsWith("data:")) return;
    const event = JSON.parse(line.slice(5).trim());
    if (event.done || event.type === "done") done = true;
    if (event.type === "chunk" && event.data) audio.push(Buffer.from(event.data, "base64"));
    else if (event.type === "timestamps" || event.type === "word_timestamps") {
      const ts = event.word_timestamps ?? event.timestamps ?? {};
      words.push(...(ts.words ?? []).map(String));
      starts.push(...(ts.start ?? []).map(Number));
      ends.push(...(ts.end ?? []).map(Number));
    } else if (event.type === "error") throw new Error(`Cartesia failed: ${event.message ?? "unknown error"}`);
  };
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      handle(buffer.slice(0, nl).trim());
      buffer = buffer.slice(nl + 1);
    }
  }
  if (buffer.trim()) handle(buffer.trim());
  if (!done || !audio.length || !words.length) throw new Error("Cartesia returned an incomplete narration");
  const pcm = Buffer.concat(audio);
  const wav = await run(["ffmpeg", "-loglevel", "error", "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", "1", "-i", "pipe:0", "-f", "wav", "pipe:1"], pcm);
  return {
    wav,
    durationSeconds: pcm.length / 2 / SAMPLE_RATE,
    words: words.map((word, i) => ({ word, start: +starts[i].toFixed(3), end: +ends[i].toFixed(3) })),
  };
}
