// Smoke test for ekko-pnc under Bun: load the session, run N inferences, exit.
// Usage: bun pnc-loop.ts <node|web> <modelDir> [iterations]
// Prints one JSON line on success. A crash shows up as a non-zero exit code.
import { Tokenizer } from "@huggingface/tokenizers";
import { join } from "node:path";

const backend = process.argv[2] ?? "node";
const modelDir = process.argv[3] ?? ".";
const iterations = Number(process.argv[4] ?? 200);

const LABELS = ["O", "O|U", ",", ",|U", ".", ".|U", "?", "?|U", "!", "!|U"];
const SAMPLE =
	"kan du sende mig rapporten inden fredag jeg skal bruge den til mødet med københavns kommune";

const ort =
	backend === "web" ? await import("onnxruntime-web") : await import("onnxruntime-node");
if (backend === "web") {
	(ort as typeof import("onnxruntime-web")).env.wasm.numThreads = 1;
}

const tokenizer = new Tokenizer(
	await Bun.file(join(modelDir, "tokenizer.json")).json(),
	await Bun.file(join(modelDir, "tokenizer_config.json")).json(),
);

const loadStart = performance.now();
const modelPath = join(modelDir, "pnc.int8.onnx");
const session =
	backend === "web"
		? await ort.InferenceSession.create(new Uint8Array(await Bun.file(modelPath).arrayBuffer()))
		: await ort.InferenceSession.create(modelPath);
const loadMs = performance.now() - loadStart;

function toTensor(values: number[]) {
	return new ort.Tensor("int64", BigInt64Array.from(values.map(BigInt)), [1, values.length]);
}

// Word-level punctuation from the first subtoken of each word (ekko's pnc.py, no windowing).
async function punctuate(text: string): Promise<string> {
	const words = text.split(/\s+/).filter(Boolean);
	const ids: number[] = [2];
	const firstSub: number[] = [];
	for (const word of words) {
		const wordIds = tokenizer.encode(word, { add_special_tokens: false }).ids;
		firstSub.push(ids.length);
		ids.push(...wordIds);
	}
	ids.push(3);
	const out = await session.run({
		input_ids: toTensor(ids),
		attention_mask: toTensor(ids.map(() => 1)),
	});
	const logits = out.logits.data as Float32Array;
	const classes = LABELS.length;
	return words
		.map((word, i) => {
			const row = logits.subarray(firstSub[i] * classes, (firstSub[i] + 1) * classes);
			const label = LABELS[row.indexOf(Math.max(...row))];
			const [punct, upper] = label.split("|");
			const cased = upper ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word;
			return punct === "O" ? cased : cased + punct;
		})
		.join(" ");
}

const output = await punctuate(SAMPLE);
const times: number[] = [];
for (let i = 0; i < iterations; i++) {
	const t = performance.now();
	await punctuate(SAMPLE);
	times.push(performance.now() - t);
}
times.sort((a, b) => a - b);

console.log(
	JSON.stringify({
		backend,
		bun: Bun.version,
		platform: `${process.platform}-${process.arch}`,
		loadMs: Math.round(loadMs),
		iterations,
		medianMs: +times[Math.floor(times.length / 2)].toFixed(2),
		p95Ms: +times[Math.floor(times.length * 0.95)].toFixed(2),
		output,
	}),
);
