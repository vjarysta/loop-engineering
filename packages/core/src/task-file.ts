import { readFile } from "node:fs/promises";
import { z } from "zod";
import { TASK_ID_PATTERN } from "./worktree.js";

export const TaskFileSchema = z.strictObject({
  id: z.string().regex(TASK_ID_PATTERN, "must contain only letters, digits, - and _"),
  title: z.string().min(1),
  /** Markdown body after the title; cites source-of-truth sections as `<path>#<heading-slug>`. */
  description: z.string().min(1, "must not be empty"),
});

export type TaskFile = z.output<typeof TaskFileSchema>;

export class TaskFileError extends Error {
  override readonly name = "TaskFileError";
}

/** `# T001 — Title`; the separator may be an em dash, an en dash or 1 to 3 hyphens. */
const TITLE_LINE = /^#\s+(\S+)\s+(?:—|–|-{1,3})\s+(.+?)\s*$/;

/** Parses a task file: a `# <id> — <title>` first line, then the markdown description. */
export function parseTaskFile(markdown: string): TaskFile {
  const [first = "", ...rest] = markdown.trimStart().split("\n");
  const title = TITLE_LINE.exec(first);
  if (title === null) throw new TaskFileError(`First line must be "# <id> — <title>", got: ${first}`);

  const result = TaskFileSchema.safeParse({ id: title[1], title: title[2], description: rest.join("\n").trim() });
  if (!result.success) throw new TaskFileError(z.prettifyError(result.error), { cause: result.error });
  return result.data;
}

export async function loadTaskFile(path: string): Promise<TaskFile> {
  let markdown: string;
  try {
    markdown = await readFile(path, "utf8");
  } catch (cause) {
    throw new TaskFileError(`Cannot read task file ${path}`, { cause });
  }
  try {
    return parseTaskFile(markdown);
  } catch (error) {
    if (!(error instanceof TaskFileError)) throw error;
    throw new TaskFileError(`Invalid task file ${path}:\n${error.message}`, { cause: error });
  }
}
