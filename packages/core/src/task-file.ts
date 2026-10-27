import { readFile } from "node:fs/promises";
import { z } from "zod";
import { TASK_ID_PATTERN } from "./worktree.js";

export const TaskFileSchema = z.strictObject({
  id: z.string().regex(TASK_ID_PATTERN, "must contain only letters, digits, - and _"),
  title: z.string().min(1),
  /** Free text; cites source-of-truth sections as `<path>#<heading-slug>`. */
  description: z.string().min(1),
});

export type TaskFile = z.output<typeof TaskFileSchema>;

export class TaskFileError extends Error {
  override readonly name = "TaskFileError";
}

export async function loadTaskFile(path: string): Promise<TaskFile> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    throw new TaskFileError(`Cannot read task file ${path}`, { cause });
  }
  const result = TaskFileSchema.safeParse(json);
  if (!result.success) {
    throw new TaskFileError(`Invalid task file ${path}:\n${z.prettifyError(result.error)}`, { cause: result.error });
  }
  return result.data;
}
