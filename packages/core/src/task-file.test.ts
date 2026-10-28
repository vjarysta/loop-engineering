import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadTaskFile, parseTaskFile, TaskFileError } from "./task-file.js";

const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function writeTaskFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "task-file-"));
  tmpDirs.push(dir);
  const path = join(dir, "task.md");
  writeFileSync(path, content);
  return path;
}

const BODY = "## Objectif\nImplement docs/PRD.md#checkout-flow.";
const TASK = `# task-1 — Add checkout\n${BODY}\n`;

describe("parseTaskFile", () => {
  it("reads the id and title from the first line and the rest as description", () => {
    expect(parseTaskFile(TASK)).toEqual({ id: "task-1", title: "Add checkout", description: BODY });
  });

  it.each(["—", "–", "-", "---"])("accepts %s as separator", (separator) => {
    expect(parseTaskFile(`# T001 ${separator} Constantes d'équilibrage\n${BODY}`)).toMatchObject({
      id: "T001",
      title: "Constantes d'équilibrage",
    });
  });

  it("ignores leading blank lines", () => {
    expect(parseTaskFile(`\n\n${TASK}`).id).toBe("task-1");
  });

  it.each([
    ["a missing title line", BODY],
    ["a title without separator", `# task-1 Add checkout\n${BODY}`],
    ["a level-2 title", `## task-1 — Add checkout\n${BODY}`],
    ["an unsafe id", `# ../task — Add checkout\n${BODY}`],
    ["an empty description", "# task-1 — Add checkout\n\n  \n"],
  ])("rejects %s", (_label, content) => {
    expect(() => parseTaskFile(content)).toThrow(TaskFileError);
  });
});

describe("loadTaskFile", () => {
  it("reads and parses a task file", async () => {
    expect(await loadTaskFile(writeTaskFile(TASK))).toEqual({ id: "task-1", title: "Add checkout", description: BODY });
  });

  it("names the file when it is invalid", async () => {
    const path = writeTaskFile(BODY);
    await expect(loadTaskFile(path)).rejects.toThrow(`Invalid task file ${path}`);
  });

  it("rejects a missing file", async () => {
    await expect(loadTaskFile(join(tmpdir(), "does-not-exist", "task.md"))).rejects.toThrow(TaskFileError);
  });
});
