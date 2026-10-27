// Manual smoke test against the real `claude` binary (costs a few cents).
// Usage: corepack pnpm try:claude [model]
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaude } from "../dist/index.js";

const model = process.argv[2] ?? "haiku";
const cwd = mkdtempSync(join(tmpdir(), "try-run-claude-"));

console.log(`Running claude (model: ${model}) in ${cwd}…`);
const result = await runClaude({
  cwd,
  prompt: "Reply with exactly: OK",
  model,
  allowedTools: [],
  timeoutMs: 60_000,
});

console.log({
  resultText: result.resultText,
  costUsd: result.costUsd,
  durationMs: result.durationMs,
  usage: result.usage,
});
