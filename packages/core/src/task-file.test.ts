import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadTaskFile, TaskFileError } from "./task-file.js";

const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function writeTaskFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "task-file-"));
  tmpDirs.push(dir);
  const path = join(dir, "task.json");
  writeFileSync(path, content);
  return path;
}

const TASK = { id: "task-1", title: "Add checkout", description: "Implement docs/PRD.md#checkout-flow." };

describe("loadTaskFile", () => {
  it("reads and validates a task file", async () => {
    expect(await loadTaskFile(writeTaskFile(JSON.stringify(TASK)))).toEqual(TASK);
  });

  it.each([
    ["an unsafe id", JSON.stringify({ ...TASK, id: "../task" })],
    ["an empty title", JSON.stringify({ ...TASK, title: "" })],
    ["a missing description", JSON.stringify({ id: TASK.id, title: TASK.title })],
    ["an unknown field", JSON.stringify({ ...TASK, state: "approved" })],
    ["invalid JSON", "{ id: task-1 }"],
  ])("rejects %s", async (_label, content) => {
    await expect(loadTaskFile(writeTaskFile(content))).rejects.toThrow(TaskFileError);
  });

  it("rejects a missing file", async () => {
    await expect(loadTaskFile(join(tmpdir(), "does-not-exist", "task.json"))).rejects.toThrow(TaskFileError);
  });
});
