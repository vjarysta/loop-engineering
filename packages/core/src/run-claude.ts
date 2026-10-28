import { readFile } from "node:fs/promises";
import { type ProcessOutput, runProcess } from "./process.js";

export interface RunClaudeOptions {
  readonly cwd: string;
  readonly prompt: string;
  readonly timeoutMs: number;
  /** Its content is passed to --append-system-prompt. */
  readonly systemPromptFile?: string;
  /** Passed to --append-system-prompt, after the content of systemPromptFile. */
  readonly appendSystemPrompt?: string;
  readonly model?: string;
  /** Built-in tools available at all (--tools); an empty list disables every tool. */
  readonly tools?: readonly string[];
  /** Tools pre-approved without a permission prompt (--allowedTools); it does not restrict the tool set. */
  readonly allowedTools?: readonly string[];
  /** Directories outside cwd the tools may access (--add-dir). */
  readonly addDirs?: readonly string[];
  /** Delay between SIGTERM and SIGKILL on timeout. */
  readonly killGraceMs?: number;
  /** Path to the claude binary. */
  readonly bin?: string;
}

export interface ClaudeUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
}

export interface RunClaudeResult {
  readonly resultText: string;
  readonly usage: ClaudeUsage;
  readonly costUsd: number;
  readonly durationMs: number;
  /** The transcript is in ~/.claude/projects/<escaped cwd>/<sessionId>.jsonl. */
  readonly sessionId: string | null;
  readonly numTurns: number | null;
  /** Tool calls denied during the session. */
  readonly permissionDenials: number | null;
  readonly raw: Readonly<Record<string, unknown>>;
}

export type ClaudeRunErrorKind = "spawn" | "timeout" | "exit" | "invalid_output" | "error_result";

export class ClaudeRunError extends Error {
  override readonly name = "ClaudeRunError";

  constructor(
    readonly kind: ClaudeRunErrorKind,
    message: string,
    readonly details: {
      readonly exitCode?: number | null;
      readonly stderr?: string;
      readonly raw?: unknown;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, { cause: details.cause });
  }

  get exitCode(): number | null | undefined {
    return this.details.exitCode;
  }

  get stderr(): string | undefined {
    return this.details.stderr;
  }

  get raw(): unknown {
    return this.details.raw;
  }
}

export async function runClaude(options: RunClaudeOptions): Promise<RunClaudeResult> {
  const args = await buildArgs(options);
  let output: ProcessOutput;
  try {
    output = await runProcess({
      command: options.bin ?? "claude",
      args,
      cwd: options.cwd,
      input: options.prompt,
      timeoutMs: options.timeoutMs,
      ...(options.killGraceMs !== undefined && { killGraceMs: options.killGraceMs }),
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new ClaudeRunError("spawn", `failed to spawn claude: ${message}`, { cause });
  }

  const { stdout, stderr, exitCode, timedOut } = output;
  if (timedOut) {
    throw new ClaudeRunError("timeout", `claude timed out after ${String(options.timeoutMs)}ms`, { stderr });
  }
  if (exitCode !== 0) {
    throw new ClaudeRunError("exit", `claude exited with code ${String(exitCode)}`, { exitCode, stderr });
  }
  return parseOutput(stdout, stderr);
}

/**
 * Agents load only the project's settings: the user's plugins, hooks, MCP servers, permissions, language
 * and CLAUDE.md never reach them. --bare would isolate further but ignores OAuth, i.e. the subscription.
 */
export const BASE_ARGS = ["-p", "--output-format", "json", "--setting-sources", "project,local"] as const;

async function buildArgs(options: RunClaudeOptions): Promise<string[]> {
  const args: string[] = [...BASE_ARGS];
  if (options.model !== undefined) {
    args.push("--model", options.model);
  }
  const systemPrompt = [
    options.systemPromptFile === undefined ? undefined : await readFile(options.systemPromptFile, "utf8"),
    options.appendSystemPrompt,
  ].filter((part) => part !== undefined);
  if (systemPrompt.length > 0) {
    args.push("--append-system-prompt", systemPrompt.join("\n\n"));
  }
  // --add-dir, --tools and --allowedTools are variadic: each list ends at the next flag, and the prompt
  // goes through stdin so nothing positional can be swallowed.
  if (options.addDirs !== undefined && options.addDirs.length > 0) {
    args.push("--add-dir", ...options.addDirs);
  }
  if (options.tools !== undefined) {
    args.push("--tools", ...(options.tools.length > 0 ? options.tools : [""]));
  }
  if (options.allowedTools !== undefined && options.allowedTools.length > 0) {
    args.push("--allowedTools", ...options.allowedTools);
  }
  return args;
}

function parseOutput(stdout: string, stderr: string): RunClaudeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch (cause) {
    throw new ClaudeRunError("invalid_output", "claude output is not valid JSON", { stderr, raw: stdout, cause });
  }
  if (!isRecord(raw)) {
    throw new ClaudeRunError("invalid_output", "claude output is not a JSON object", { stderr, raw });
  }
  if (raw["is_error"] === true) {
    throw new ClaudeRunError("error_result", `claude reported an error: ${String(raw["subtype"])}`, { stderr, raw });
  }

  const usage = raw["usage"];
  const result = raw["result"];
  const costUsd = raw["total_cost_usd"];
  const durationMs = raw["duration_ms"];
  if (
    typeof result !== "string" ||
    typeof costUsd !== "number" ||
    typeof durationMs !== "number" ||
    !isRecord(usage) ||
    typeof usage["input_tokens"] !== "number" ||
    typeof usage["output_tokens"] !== "number" ||
    typeof usage["cache_creation_input_tokens"] !== "number" ||
    typeof usage["cache_read_input_tokens"] !== "number"
  ) {
    throw new ClaudeRunError("invalid_output", "claude output is missing expected fields", { stderr, raw });
  }

  return {
    resultText: result,
    usage: {
      inputTokens: usage["input_tokens"],
      outputTokens: usage["output_tokens"],
      cacheCreationInputTokens: usage["cache_creation_input_tokens"],
      cacheReadInputTokens: usage["cache_read_input_tokens"],
    },
    costUsd,
    durationMs,
    sessionId: typeof raw["session_id"] === "string" ? raw["session_id"] : null,
    numTurns: typeof raw["num_turns"] === "number" ? raw["num_turns"] : null,
    permissionDenials: Array.isArray(raw["permission_denials"]) ? raw["permission_denials"].length : null,
    raw,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
