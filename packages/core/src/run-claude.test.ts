import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ClaudeRunError, runClaude } from "./run-claude.js";

const FAKE_BIN = fileURLToPath(new URL("../test/fixtures/fake-claude.mjs", import.meta.url));

function makeTmpDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "run-claude-")));
}

interface Echo {
  args: string[];
  stdin: string;
  cwd: string;
}

async function echo(options: Partial<Parameters<typeof runClaude>[0]> = {}): Promise<Echo> {
  const result = await runClaude({ cwd: makeTmpDir(), prompt: "mode:success", timeoutMs: 5000, bin: FAKE_BIN, ...options });
  return JSON.parse(result.resultText) as Echo;
}

async function captureError(promise: Promise<unknown>): Promise<ClaudeRunError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ClaudeRunError) return error;
    throw error;
  }
  throw new Error("expected runClaude to reject");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !isAlive(pid);
}

describe("runClaude — invocation", () => {
  it("only passes print mode and JSON output when no option is given", async () => {
    expect((await echo()).args).toEqual(["-p", "--output-format", "json"]);
  });

  it("sends the prompt on stdin", async () => {
    expect((await echo()).stdin).toBe("mode:success");
  });

  it("runs in the given cwd", async () => {
    const cwd = makeTmpDir();

    expect((await echo({ cwd })).cwd).toBe(cwd);
  });

  it("passes the model", async () => {
    expect((await echo({ model: "haiku" })).args).toEqual(["-p", "--output-format", "json", "--model", "haiku"]);
  });

  it("appends the content of the system prompt file", async () => {
    const file = join(makeTmpDir(), "system.md");
    writeFileSync(file, "You are terse.\nAnswer in French.");

    expect((await echo({ systemPromptFile: file })).args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--append-system-prompt",
      "You are terse.\nAnswer in French.",
    ]);
  });

  it("appends an inline system prompt", async () => {
    expect((await echo({ appendSystemPrompt: "Inline rules." })).args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--append-system-prompt",
      "Inline rules.",
    ]);
  });

  it("appends the file content then the inline system prompt in a single flag", async () => {
    const file = join(makeTmpDir(), "system.md");
    writeFileSync(file, "From file.");

    expect((await echo({ systemPromptFile: file, appendSystemPrompt: "Inline rules." })).args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--append-system-prompt",
      "From file.\n\nInline rules.",
    ]);
  });

  it("passes allowed tools last, one argument each, so they cannot swallow other flags", async () => {
    const args = (await echo({ model: "haiku", allowedTools: ["Read", "Bash(git *)"] })).args;

    expect(args).toEqual(["-p", "--output-format", "json", "--model", "haiku", "--allowedTools", "Read", "Bash(git *)"]);
  });

  it("grants extra directories before the allowed tools, both variadic lists ending at the next flag", async () => {
    const args = (await echo({ addDirs: ["/runs/task-1", "/shared"], allowedTools: ["Read"] })).args;

    expect(args).toEqual(["-p", "--output-format", "json", "--add-dir", "/runs/task-1", "/shared", "--allowedTools", "Read"]);
  });

  it("omits --add-dir for an empty list", async () => {
    expect((await echo({ addDirs: [] })).args).toEqual(["-p", "--output-format", "json"]);
  });

  it("omits --allowedTools for an empty list", async () => {
    expect((await echo({ allowedTools: [] })).args).toEqual(["-p", "--output-format", "json"]);
  });
});

describe("runClaude — result", () => {
  it("maps the JSON output", async () => {
    const result = await runClaude({ cwd: makeTmpDir(), prompt: "mode:success", timeoutMs: 5000, bin: FAKE_BIN });

    expect(result).toMatchObject({
      costUsd: 0.0042,
      durationMs: 1234,
      usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 100, cacheReadInputTokens: 200 },
      raw: { type: "result", subtype: "success", total_cost_usd: 0.0042 },
    });
  });
});

describe("runClaude — failures", () => {
  const base = { prompt: "", timeoutMs: 5000, bin: FAKE_BIN };

  it("rejects when claude reports an error result", async () => {
    const error = await captureError(runClaude({ ...base, cwd: makeTmpDir(), prompt: "mode:error_result" }));

    expect(error.kind).toBe("error_result");
    expect(error.raw).toMatchObject({ is_error: true, result: "boom" });
  });

  it("rejects with stderr and exit code on non-zero exit", async () => {
    const error = await captureError(runClaude({ ...base, cwd: makeTmpDir(), prompt: "mode:exit" }));

    expect(error).toMatchObject({ kind: "exit", exitCode: 2, stderr: "fatal: something broke\n" });
  });

  it("rejects on non-JSON output", async () => {
    const error = await captureError(runClaude({ ...base, cwd: makeTmpDir(), prompt: "mode:garbage" }));

    expect(error.kind).toBe("invalid_output");
  });

  it("rejects when the binary cannot be spawned", async () => {
    const error = await captureError(runClaude({ ...base, cwd: makeTmpDir(), bin: "/nonexistent/claude" }));

    expect(error.kind).toBe("spawn");
  });
});

describe("runClaude — timeout", () => {
  it("kills the process and rejects once the timeout elapses", async () => {
    const pidFile = join(makeTmpDir(), "pid");
    const started = Date.now();

    const error = await captureError(
      runClaude({ cwd: makeTmpDir(), prompt: `mode:hang:${pidFile}`, timeoutMs: 300, bin: FAKE_BIN }),
    );

    expect(error.kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await waitUntilDead(Number(readFileSync(pidFile, "utf8")))).toBe(true);
  });

  it("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const pidFile = join(makeTmpDir(), "pid");

    const error = await captureError(
      runClaude({
        cwd: makeTmpDir(),
        prompt: `mode:ignore-sigterm:${pidFile}`,
        timeoutMs: 300,
        killGraceMs: 200,
        bin: FAKE_BIN,
      }),
    );

    expect(error.kind).toBe("timeout");
    expect(await waitUntilDead(Number(readFileSync(pidFile, "utf8")))).toBe(true);
  });

  it("also kills the processes spawned by claude", async () => {
    const pidFile = join(makeTmpDir(), "pid");

    await captureError(
      runClaude({ cwd: makeTmpDir(), prompt: `mode:hang-with-child:${pidFile}`, timeoutMs: 300, bin: FAKE_BIN }),
    );

    expect(await waitUntilDead(Number(readFileSync(pidFile, "utf8")))).toBe(true);
  });
});
