import { spawn } from "node:child_process";

export interface RunProcessOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  /** Written to stdin, which is then closed. */
  readonly input?: string;
  /** Delay between SIGTERM and SIGKILL on timeout. */
  readonly killGraceMs?: number;
}

export interface ProcessOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

const DEFAULT_KILL_GRACE_MS = 5000;

/**
 * Runs a command in its own process group. On timeout the whole group gets SIGTERM, then SIGKILL after
 * the grace delay; the promise settles only once the process has exited. Rejects only if spawning fails.
 */
export function runProcess(options: RunProcessOptions): Promise<ProcessOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, { cwd: options.cwd, detached: true, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;

    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group is already gone.
      }
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => {
        killGroup("SIGKILL");
      }, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    // The child may exit before reading stdin; the resulting EPIPE is reported through exit/close.
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");

    child.on("error", (cause) => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      reject(cause);
    });

    child.on("close", (exitCode) => {
      clearTimeout(timeoutTimer);
      if (timedOut) {
        // Make sure nothing in the group outlives the leader.
        killGroup("SIGKILL");
        clearTimeout(killTimer);
      }
      resolve({ stdout, stderr, exitCode, timedOut });
    });
  });
}
