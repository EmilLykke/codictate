// Dump per-clip raw engine output for FLEURS da_dk, through the benchmark's adapter
// (same crispasr argv as the app: Edda on nt-vad with the Danish prompt).
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { buildFleursManifest } from "../scripts/build-manifests";
import { adapterFor } from "../stt/runner";
import { modelManager } from "../../src/bun/utils/whisper/model-manager";

const [modelId, out] = process.argv.slice(2);
const entries = buildFleursManifest(`${import.meta.dir}/../datasets`, "da_dk", Number.MAX_SAFE_INTEGER).slice(3);
const done = new Set(existsSync(out) ? readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).clipId) : []);
const adapter = adapterFor(modelId, modelManager.getModelPath(modelId), "crispasr");
await adapter.start?.();
let i = 0;
for (const e of entries) {
  i++;
  if (done.has(e.clipId)) continue;
  const t0 = performance.now();
  const r = await adapter.invoke(adapter.prepare(e));
  const ms = performance.now() - t0;
  appendFileSync(out, JSON.stringify({ clipId: e.clipId, ref: e.rawTranscript, refNorm: e.transcript, hyp: r.status === "ok" ? r.rawTranscript : null, status: r.status, ms }) + "\n");
  if (i % 50 === 0) console.log(modelId, i, "/", entries.length);
}
await adapter.close?.();
console.log("done", modelId, entries.length);
