#!/usr/bin/env node
// Stand-in for the `claude` binary in unit tests.
// The behaviour is selected by the prompt received on stdin: "mode:<name>[:<pidFile>]".
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (stdin += chunk));
process.stdin.on("end", () => {
  const [, mode, pidFile] = stdin.split(":");

  switch (mode) {
    case "success":
      process.stdout.write(
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: JSON.stringify({ args: process.argv.slice(2), stdin, cwd: process.cwd() }),
          duration_ms: 1234,
          total_cost_usd: 0.0042,
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 200,
          },
        }),
      );
      break;
    case "error_result":
      process.stdout.write(
        JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "boom",
          duration_ms: 1,
          total_cost_usd: 0,
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        }),
      );
      break;
    case "exit":
      process.stderr.write("fatal: something broke\n");
      process.exit(2);
      break;
    case "garbage":
      process.stdout.write("this is not json");
      break;
    case "hang":
      writeFileSync(pidFile, String(process.pid));
      setInterval(() => undefined, 1000);
      break;
    case "ignore-sigterm":
      process.on("SIGTERM", () => undefined);
      writeFileSync(pidFile, String(process.pid));
      setInterval(() => undefined, 1000);
      break;
    case "hang-with-child": {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      writeFileSync(pidFile, String(child.pid));
      setInterval(() => undefined, 1000);
      break;
    }
    default:
      process.stderr.write(`unknown mode: ${mode}\n`);
      process.exit(99);
  }
});
