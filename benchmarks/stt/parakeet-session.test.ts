import { describe, expect, test } from "bun:test";
import {
  ReadableStream,
  type ReadableStreamDefaultController,
} from "node:stream/web";
import type { ParakeetSessionRequest } from "../../src/shared/parakeet-session-protocol";
import type { ParakeetTranscriptionRequest } from "../../src/bun/utils/whisper/engines/transcription";
import {
  ParakeetBenchmarkSession,
  type ParakeetSessionProcess,
  type SpawnParakeetSession,
} from "./parakeet-session";

type RequestHandler = (
  request: ParakeetSessionRequest,
  process: FakeSessionProcess,
) => void;

class FakeSessionProcess implements ParakeetSessionProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly requests: ParakeetSessionRequest[] = [];
  readonly killSignals: (number | NodeJS.Signals | undefined)[] = [];
  endCalls = 0;

  private stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  private stderrController!: ReadableStreamDefaultController<Uint8Array>;
  private resolveExited!: (code: number) => void;
  private closed = false;
  private inputBuffer = "";

  readonly exited = new Promise<number>((resolve) => {
    this.resolveExited = resolve;
  });

  readonly stdin = {
    write: (data: string | Uint8Array) => {
      this.inputBuffer +=
        typeof data === "string" ? data : new TextDecoder().decode(data);
      while (true) {
        const newline = this.inputBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.inputBuffer.slice(0, newline);
        this.inputBuffer = this.inputBuffer.slice(newline + 1);
        if (line.trim() === "") continue;
        const request = JSON.parse(line) as ParakeetSessionRequest;
        this.requests.push(request);
        this.onRequest(request, this);
      }
    },
    flush: () => {},
    end: () => {
      this.endCalls++;
      if (!this.ignoreEnd) this.exit(0);
    },
  };

  constructor(
    private readonly onRequest: RequestHandler,
    private readonly ignoreEnd = false,
    private readonly ignoreSignals = false,
    private readonly ignoreCancel = false,
  ) {
    this.stdout = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.stdoutController = controller;
      },
      cancel: () =>
        this.ignoreCancel ? new Promise<void>(() => {}) : undefined,
    });
    this.stderr = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.stderrController = controller;
      },
      cancel: () =>
        this.ignoreCancel ? new Promise<void>(() => {}) : undefined,
    });
    queueMicrotask(() => this.stdoutLine({ kind: "ready" }));
  }

  stdoutLine(value: unknown): void {
    if (this.closed) return;
    const line = typeof value === "string" ? value : JSON.stringify(value);
    this.stdoutController.enqueue(new TextEncoder().encode(`${line}\n`));
  }

  stderrLine(value: string): void {
    if (this.closed) return;
    this.stderrController.enqueue(new TextEncoder().encode(`${value}\n`));
  }

  exit(code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.stdoutController.close();
    this.stderrController.close();
    this.resolveExited(code);
  }

  kill(signal?: number | NodeJS.Signals): void {
    this.killSignals.push(signal);
    if (!this.ignoreSignals) this.exit(signal === "SIGKILL" ? 137 : 143);
  }
}

function request(
  audioPath: string,
  timeoutMs = 100,
): ParakeetTranscriptionRequest {
  return {
    engineId: "whisperkit",
    speechModelId: "parakeet-tdt-0.6b-v3",
    audioPath,
    timeoutMs,
    modelDir: "/models/parakeet-tdt-0.6b-v3",
  };
}

function sessionWith(
  factories: Array<() => FakeSessionProcess>,
  cleanupGraceMs = 5,
): {
  session: ParakeetBenchmarkSession;
  processes: FakeSessionProcess[];
  argv: string[][];
} {
  const processes: FakeSessionProcess[] = [];
  const argv: string[][] = [];
  const spawn: SpawnParakeetSession = (command) => {
    argv.push(command);
    const factory = factories.shift();
    if (!factory) throw new Error("unexpected process spawn");
    const process = factory();
    processes.push(process);
    return process;
  };
  return {
    session: new ParakeetBenchmarkSession({
      speechModelId: "parakeet-tdt-0.6b-v3",
      modelDir: "/models/parakeet-tdt-0.6b-v3",
      resolveHelperBinary: () => "/helpers/Parakeet",
      spawn,
      cleanupGraceMs,
    }),
    processes,
    argv,
  };
}

describe("ParakeetBenchmarkSession", () => {
  test("loads once and correlates several sequential requests", async () => {
    const harness = sessionWith([
      () =>
        new FakeSessionProcess((received, process) => {
          process.stdoutLine({
            kind: "final",
            id: received.id,
            text: `transcript:${received.audioPath}`,
          });
        }),
    ]);

    await harness.session.start();
    expect(await harness.session.transcribe(request("/clips/one.wav"))).toEqual(
      { status: "ok", rawTranscript: "transcript:/clips/one.wav" },
    );
    expect(await harness.session.transcribe(request("/clips/two.wav"))).toEqual(
      { status: "ok", rawTranscript: "transcript:/clips/two.wav" },
    );

    expect(harness.argv).toEqual([
      [
        "/helpers/Parakeet",
        "transcribe-session",
        "/models/parakeet-tdt-0.6b-v3",
      ],
    ]);
    expect(harness.processes[0].requests).toEqual([
      { id: 1, audioPath: "/clips/one.wav" },
      { id: 2, audioPath: "/clips/two.wav" },
    ]);

    await harness.session.close();
    await harness.session.close();
    expect(harness.processes[0].endCalls).toBe(1);
  });

  test("times out one request, terminates it, and can start a clean session", async () => {
    const harness = sessionWith([
      () => new FakeSessionProcess(() => {}),
      () =>
        new FakeSessionProcess((received, process) => {
          process.stdoutLine({
            kind: "final",
            id: received.id,
            text: "recovered",
          });
        }),
    ]);

    await harness.session.start();
    const timedOut = await harness.session.transcribe(
      request("/clips/hang.wav", 5),
    );
    expect(timedOut.status).toBe("failed");
    if (timedOut.status === "failed") {
      expect(timedOut.reason).toBe("engine_timed_out");
    }
    expect(harness.processes[0].killSignals).toEqual(["SIGTERM"]);

    // This is what AdapterSeam.ensureReady does before the next response clock starts.
    await harness.session.start();
    expect(
      await harness.session.transcribe(request("/clips/next.wav")),
    ).toEqual({ status: "ok", rawTranscript: "recovered" });
    expect(harness.processes).toHaveLength(2);
    await harness.session.close();
  });

  test("turns process exit before a response into a typed failure and resets", async () => {
    const harness = sessionWith([
      () =>
        new FakeSessionProcess((_received, process) => {
          process.stderrLine("wav decode failed");
          process.exit(17);
        }),
      () =>
        new FakeSessionProcess((received, process) => {
          process.stdoutLine({ kind: "final", id: received.id, text: "ok" });
        }),
    ]);

    await harness.session.start();
    const failed = await harness.session.transcribe(request("/clips/bad.wav"));
    expect(failed.status).toBe("failed");
    if (failed.status === "failed") {
      expect(failed.reason).toBe("engine_exited_nonzero");
      expect(failed.diagnostic).toContain("wav decode failed");
    }

    await harness.session.start();
    expect(
      await harness.session.transcribe(request("/clips/good.wav")),
    ).toEqual({ status: "ok", rawTranscript: "ok" });
    await harness.session.close();
  });

  test("rejects a mismatched response id and never reuses that stream", async () => {
    const harness = sessionWith([
      () =>
        new FakeSessionProcess((_received, process) => {
          process.stdoutLine({ kind: "final", id: 999, text: "stale" });
        }),
      () =>
        new FakeSessionProcess((received, process) => {
          process.stdoutLine({ kind: "final", id: received.id, text: "fresh" });
        }),
    ]);

    await harness.session.start();
    const failed = await harness.session.transcribe(request("/clips/one.wav"));
    expect(failed.status).toBe("failed");
    if (failed.status === "failed") {
      expect(failed.reason).toBe("engine_output_unreadable");
    }
    expect(harness.processes[0].killSignals).toEqual(["SIGTERM"]);

    await harness.session.start();
    expect(await harness.session.transcribe(request("/clips/two.wav"))).toEqual(
      { status: "ok", rawTranscript: "fresh" },
    );
    await harness.session.close();
  });

  test("rejects malformed output and restarts before the next request", async () => {
    const harness = sessionWith([
      () =>
        new FakeSessionProcess((_received, process) => {
          process.stdoutLine("not json");
        }),
      () =>
        new FakeSessionProcess((received, process) => {
          process.stdoutLine({ kind: "final", id: received.id, text: "fresh" });
        }),
    ]);

    await harness.session.start();
    const failed = await harness.session.transcribe(request("/clips/one.wav"));
    expect(failed.status).toBe("failed");
    if (failed.status === "failed") {
      expect(failed.reason).toBe("engine_output_unreadable");
      expect(failed.diagnostic).toContain("not json");
    }

    await harness.session.start();
    expect(await harness.session.transcribe(request("/clips/two.wav"))).toEqual(
      { status: "ok", rawTranscript: "fresh" },
    );
    expect(harness.processes).toHaveLength(2);
    await harness.session.close();
  });

  test("close stays bounded when EOF and both signals are ignored", async () => {
    const harness = sessionWith(
      [() => new FakeSessionProcess(() => {}, true, true, true)],
      2,
    );
    await harness.session.start();

    await harness.session.close();
    await harness.session.close();

    expect(harness.processes[0].endCalls).toBe(1);
    expect(harness.processes[0].killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
