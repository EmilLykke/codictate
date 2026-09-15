import type { ReadableStreamDefaultReader } from "node:stream/web";
import {
  PARAKEET_TRANSCRIBE_SESSION_COMMAND,
  encodeParakeetSessionRequest,
  parseParakeetSessionResponse,
} from "../../src/shared/parakeet-session-protocol";
import {
  ENGINE_PROCESS_CLEANUP_GRACE_MS,
  ENGINE_PROCESS_TIMEOUT_MS,
} from "../../src/bun/utils/whisper/engines/process-supervisor";
import {
  failedTranscription,
  type ParakeetTranscriptionRequest,
  type TranscriptionResult,
} from "../../src/bun/utils/whisper/engines/transcription";

const STDERR_TAIL_CHARS = 4_000;

interface SessionInput {
  write(data: string | Uint8Array): unknown;
  flush?(): unknown;
  end(): unknown;
}

export interface ParakeetSessionProcess {
  readonly stdin: SessionInput;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr?: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

export type SpawnParakeetSession = (
  argv: string[],
  options: {
    stdin: "pipe";
    stdout: "pipe";
    stderr: "pipe";
    env: Record<string, string | undefined>;
  },
) => ParakeetSessionProcess;

export interface ParakeetBenchmarkSessionOptions {
  speechModelId: string;
  modelDir: string;
  resolveHelperBinary: () => string;
  spawn?: SpawnParakeetSession;
  cleanupGraceMs?: number;
}

class NdjsonLineReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private buffered = "";
  private ended = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  async nextLine(): Promise<string | null> {
    while (true) {
      const newline = this.buffered.indexOf("\n");
      if (newline >= 0) {
        const line = this.buffered.slice(0, newline).replace(/\r$/, "");
        this.buffered = this.buffered.slice(newline + 1);
        return line;
      }

      if (this.ended) {
        if (this.buffered === "") return null;
        const line = this.buffered.replace(/\r$/, "");
        this.buffered = "";
        return line;
      }

      const { done, value } = await this.reader.read();
      if (done) {
        this.buffered += this.decoder.decode();
        this.ended = true;
      } else if (value) {
        this.buffered += this.decoder.decode(value, { stream: true });
      }
    }
  }

  async cancel(): Promise<void> {
    try {
      await this.reader.cancel();
    } catch {
      // The process may have closed the pipe in the same turn.
    }
  }
}

interface StderrCollector {
  readonly completed: Promise<void>;
  tail(): string;
  cancel(): Promise<void>;
}

function collectStderr(stream?: ReadableStream<Uint8Array>): StderrCollector {
  if (!stream) {
    return {
      completed: Promise.resolve(),
      tail: () => "",
      cancel: async () => {},
    };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const completed = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        text = (text + decoder.decode(value, { stream: true })).slice(
          -STDERR_TAIL_CHARS,
        );
      }
      text = (text + decoder.decode()).slice(-STDERR_TAIL_CHARS);
    } catch {
      // Cancellation is normal during a deadline or protocol failure.
    }
  })();

  return {
    completed,
    tail: () => text.trim(),
    cancel: async () => {
      try {
        await reader.cancel();
      } catch {
        // The process may have closed the pipe in the same turn.
      }
    },
  };
}

interface SessionState {
  process: ParakeetSessionProcess;
  stdout: NdjsonLineReader;
  stderr: StderrCollector;
  exited: Promise<number>;
}

type LineWaitResult =
  | { kind: "line"; line: string | null }
  | { kind: "exit"; exitCode: number }
  | { kind: "read_error"; error: unknown }
  | { kind: "timeout" };

function timeout(delayMs: number): {
  promise: Promise<void>;
  cancel(): void;
} {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, Math.max(0, delayMs));
  });
  return {
    promise,
    cancel: () => {
      if (handle !== undefined) clearTimeout(handle);
    },
  };
}

async function waitForLine(
  state: SessionState,
  timeoutMs: number,
): Promise<LineWaitResult> {
  const responseDeadline = timeout(timeoutMs);
  const result = await Promise.race<LineWaitResult>([
    state.stdout.nextLine().then(
      (line) => ({ kind: "line", line }),
      (error) => ({ kind: "read_error", error }),
    ),
    state.exited.then((exitCode) => ({ kind: "exit", exitCode })),
    responseDeadline.promise.then(() => ({ kind: "timeout" })),
  ]);
  responseDeadline.cancel();
  return result;
}

function processDiagnostic(state: SessionState, detail: string): string {
  const stderr = state.stderr.tail();
  return stderr === "" ? detail : `${detail}: ${stderr}`;
}

const defaultSpawn: SpawnParakeetSession = (argv, options) =>
  Bun.spawn(argv, options) as unknown as ParakeetSessionProcess;

/**
 * One persistent Native Helper for a Parakeet Benchmark Combination.
 *
 * Requests remain sequential. A deadline, process exit or malformed response invalidates
 * the process before returning the typed failure. The runner calls `start()` outside every
 * response window, so the next Sample starts a clean process without charging model loading
 * to its response time.
 */
export class ParakeetBenchmarkSession {
  private readonly speechModelId: string;
  private readonly modelDir: string;
  private readonly resolveHelperBinary: () => string;
  private readonly spawn: SpawnParakeetSession;
  private readonly cleanupGraceMs: number;
  private state: SessionState | null = null;
  private nextRequestId = 1;
  private inFlight = false;
  private closePromise: Promise<void> | null = null;

  constructor(options: ParakeetBenchmarkSessionOptions) {
    this.speechModelId = options.speechModelId;
    this.modelDir = options.modelDir;
    this.resolveHelperBinary = options.resolveHelperBinary;
    this.spawn = options.spawn ?? defaultSpawn;
    this.cleanupGraceMs =
      options.cleanupGraceMs ?? ENGINE_PROCESS_CLEANUP_GRACE_MS;
  }

  /** Load the model and consume the Native Helper's `ready` line. */
  async start(): Promise<void> {
    if (this.closePromise !== null) {
      throw new Error("Parakeet benchmark session is already closed");
    }
    if (this.state !== null) return;
    this.state = await this.spawnReadySession(ENGINE_PROCESS_TIMEOUT_MS);
  }

  async transcribe(
    request: ParakeetTranscriptionRequest,
  ): Promise<TranscriptionResult> {
    if (this.closePromise !== null) {
      return failedTranscription(
        "engine_runtime_missing",
        request.speechModelId,
        "Parakeet benchmark session is closed",
      );
    }
    if (this.inFlight) {
      return failedTranscription(
        "engine_output_unreadable",
        request.speechModelId,
        "Parakeet benchmark session received concurrent requests",
      );
    }

    this.inFlight = true;
    try {
      let state = this.state;
      if (state === null) {
        try {
          state = await this.spawnReadySession(request.timeoutMs);
          this.state = state;
        } catch (error) {
          return failedTranscription(
            "engine_exited_nonzero",
            request.speechModelId,
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      const requestId = this.nextRequestId++;
      try {
        state.process.stdin.write(
          `${encodeParakeetSessionRequest({
            id: requestId,
            audioPath: request.audioPath,
          })}\n`,
        );
        await state.process.stdin.flush?.();
      } catch (error) {
        const failure = failedTranscription(
          "engine_exited_nonzero",
          request.speechModelId,
          processDiagnostic(
            state,
            `could not write Parakeet session request: ${String(error)}`,
          ),
        );
        await this.invalidate(state);
        return failure;
      }

      const waited = await waitForLine(state, request.timeoutMs);
      if (waited.kind === "timeout") {
        const failure = failedTranscription(
          "engine_timed_out",
          request.speechModelId,
          processDiagnostic(state, `deadline ${request.timeoutMs} ms`),
        );
        await this.invalidate(state);
        return failure;
      }

      if (waited.kind === "exit") {
        await this.waitForStderr(state);
        const failure = failedTranscription(
          waited.exitCode === 0
            ? "parakeet_no_final_line"
            : "engine_exited_nonzero",
          request.speechModelId,
          processDiagnostic(
            state,
            `session exited with code ${waited.exitCode} before response ${requestId}`,
          ),
        );
        await this.invalidate(state, false);
        return failure;
      }

      if (waited.kind === "read_error" || waited.line === null) {
        const detail =
          waited.kind === "read_error"
            ? `could not read Parakeet session stdout: ${String(waited.error)}`
            : `session stdout closed before response ${requestId}`;
        const failure = failedTranscription(
          "engine_output_unreadable",
          request.speechModelId,
          processDiagnostic(state, detail),
        );
        await this.invalidate(state);
        return failure;
      }

      const response = parseParakeetSessionResponse(waited.line);
      if (
        response === null ||
        response.kind !== "final" ||
        response.id !== requestId
      ) {
        const failure = failedTranscription(
          "engine_output_unreadable",
          request.speechModelId,
          processDiagnostic(
            state,
            `unexpected Parakeet session response for request ${requestId}: ${waited.line}`,
          ),
        );
        await this.invalidate(state);
        return failure;
      }

      return { status: "ok", rawTranscript: response.text.trim() };
    } finally {
      this.inFlight = false;
    }
  }

  /** Idempotent and bounded even when the helper ignores EOF and SIGTERM. */
  async close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closePromise = (async () => {
      const state = this.state;
      this.state = null;
      if (state === null) return;

      try {
        state.process.stdin.end();
      } catch {
        // Fall through to the bounded termination path.
      }
      const closed = await this.waitForExit(state);
      if (!closed) await this.terminate(state);
      await this.cancelReaders(state);
    })();
    return this.closePromise;
  }

  private async spawnReadySession(timeoutMs: number): Promise<SessionState> {
    let helper: string;
    try {
      helper = this.resolveHelperBinary();
    } catch (error) {
      throw new Error(
        `could not resolve Parakeet Native Helper: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }

    let process: ParakeetSessionProcess;
    try {
      process = this.spawn(
        [helper, PARAKEET_TRANSCRIBE_SESSION_COMMAND, this.modelDir],
        {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...processEnv(),
            LC_ALL: "en_US.UTF-8",
            LANG: "en_US.UTF-8",
          },
        },
      );
    } catch (error) {
      throw new Error(`could not spawn Parakeet session: ${String(error)}`, {
        cause: error,
      });
    }

    const state: SessionState = {
      process,
      stdout: new NdjsonLineReader(process.stdout),
      stderr: collectStderr(process.stderr),
      exited: process.exited.then(
        (exitCode) => exitCode,
        () => -1,
      ),
    };
    const waited = await waitForLine(state, timeoutMs);
    if (waited.kind === "line" && waited.line !== null) {
      const response = parseParakeetSessionResponse(waited.line);
      if (response?.kind === "ready") return state;
    }

    if (waited.kind === "exit") await this.waitForStderr(state);
    const detail =
      waited.kind === "timeout"
        ? `timed out after ${timeoutMs} ms while loading ${this.speechModelId}`
        : waited.kind === "exit"
          ? `exited with code ${waited.exitCode} before ready`
          : waited.kind === "read_error"
            ? `could not read ready response: ${String(waited.error)}`
            : `expected ready response, received ${waited.line ?? "EOF"}`;
    await this.terminate(state);
    throw new Error(processDiagnostic(state, detail));
  }

  private async invalidate(
    state: SessionState,
    terminate = true,
  ): Promise<void> {
    if (this.state === state) this.state = null;
    if (terminate) await this.terminate(state);
    else await this.cancelReaders(state);
  }

  private async waitForExit(state: SessionState): Promise<boolean> {
    const cleanupDeadline = timeout(this.cleanupGraceMs);
    const exited = await Promise.race([
      state.exited.then(() => true),
      cleanupDeadline.promise.then(() => false),
    ]);
    cleanupDeadline.cancel();
    return exited;
  }

  private async waitForStderr(state: SessionState): Promise<void> {
    const cleanupDeadline = timeout(this.cleanupGraceMs);
    await Promise.race([state.stderr.completed, cleanupDeadline.promise]);
    cleanupDeadline.cancel();
  }

  private async terminate(state: SessionState): Promise<void> {
    try {
      state.process.kill("SIGTERM");
    } catch {
      // It may already have exited.
    }
    if (!(await this.waitForExit(state))) {
      try {
        state.process.kill("SIGKILL");
      } catch {
        // Cleanup stays bounded if a second signal is rejected.
      }
    }
    await this.cancelReaders(state);
  }

  private async cancelReaders(state: SessionState): Promise<void> {
    const cancellationDeadline = timeout(this.cleanupGraceMs);
    await Promise.race([
      Promise.all([state.stdout.cancel(), state.stderr.cancel()]),
      cancellationDeadline.promise,
    ]);
    cancellationDeadline.cancel();
  }
}

/** Kept behind a function so tests never need to mutate process.env. */
function processEnv(): Record<string, string | undefined> {
  return process.env;
}
