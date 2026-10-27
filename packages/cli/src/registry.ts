// Maps task ids to their project, so commands taking only a task id can find its runs.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Env = Readonly<Record<string, string | undefined>>;

/** `$LOOP_HOME/tasks.json`, `~/.loop/tasks.json` by default. */
export function registryPath(env: Env): string {
  return join(env["LOOP_HOME"] ?? join(homedir(), ".loop"), "tasks.json");
}

export async function registerTask(env: Env, taskId: string, projectPath: string): Promise<void> {
  const path = registryPath(env);
  const registry = await readRegistry(path);
  registry[taskId] = projectPath;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(registry, null, 2)}\n`);
}

export async function lookupTask(env: Env, taskId: string): Promise<string | null> {
  return (await readRegistry(registryPath(env)))[taskId] ?? null;
}

async function readRegistry(path: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}
