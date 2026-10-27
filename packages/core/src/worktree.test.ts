import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as worktree from "./worktree.js";

const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

beforeAll(() => {
  // Isolate from the developer's git config (signing, hooks, default branch…).
  const configDir = mkdtempSync(join(tmpdir(), "git-config-"));
  tmpDirs.push(configDir);
  const globalConfig = join(configDir, "gitconfig");
  writeFileSync(globalConfig, "");
  process.env["GIT_CONFIG_GLOBAL"] = globalConfig;
  process.env["GIT_CONFIG_NOSYSTEM"] = "1";
  process.env["GIT_AUTHOR_NAME"] = "Test";
  process.env["GIT_AUTHOR_EMAIL"] = "test@example.com";
  process.env["GIT_COMMITTER_NAME"] = "Test";
  process.env["GIT_COMMITTER_EMAIL"] = "test@example.com";
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commitFile(cwd: string, path: string, content: string, message = `write ${path}`): void {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), content);
  git(cwd, "add", "--", path);
  git(cwd, "commit", "-q", "-m", message);
}

function initRepo(): string {
  // Each repo gets its own parent so sibling worktree directories never collide.
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "worktree-test-")));
  tmpDirs.push(parent);
  const repo = join(parent, "project");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  commitFile(repo, "README.md", "line 1\nline 2\n", "initial");
  return repo;
}

describe("worktree.create", () => {
  it("creates a worktree next to the project on branch loop/<taskId>", async () => {
    const repo = initRepo();

    const path = await worktree.create(repo, "task-1");

    expect(path).toBe(join(dirname(repo), ".loop-worktrees", basename(repo), "task-1"));
    expect(existsSync(join(path, "README.md"))).toBe(true);
    expect(git(path, "branch", "--show-current")).toBe("loop/task-1");
  });

  it("branches from main even when the project has another branch checked out", async () => {
    const repo = initRepo();
    const mainSha = git(repo, "rev-parse", "main");
    git(repo, "checkout", "-q", "-b", "other");
    commitFile(repo, "other.txt", "other\n");

    const path = await worktree.create(repo, "task-1");

    expect(git(path, "rev-parse", "HEAD")).toBe(mainSha);
  });

  it("rejects when the task branch already exists", async () => {
    const repo = initRepo();
    await worktree.create(repo, "task-1");

    await expect(worktree.create(repo, "task-1")).rejects.toThrow(worktree.GitError);
  });

  it.each(["", "../escape", "a b", "a/b", ".hidden", "x.lock", "-flag"])(
    "rejects the unsafe task id %j without touching the repo",
    async (taskId) => {
      const repo = initRepo();

      await expect(worktree.create(repo, taskId)).rejects.toThrow(worktree.InvalidTaskIdError);
      expect(git(repo, "branch", "--list", "loop/*")).toBe("");
    },
  );
});

describe("worktree.diff / changedFiles", () => {
  it("returns the diff of the branch commits against main", async () => {
    const repo = initRepo();
    const path = await worktree.create(repo, "task-1");
    commitFile(path, "README.md", "line 1\nline 2 changed\n");

    const diff = await worktree.diff(repo, "task-1");

    expect(diff).toContain("diff --git a/README.md b/README.md");
    expect(diff).toContain("-line 2\n+line 2 changed\n");
  });

  it("ignores commits made on main after the branch was created", async () => {
    const repo = initRepo();
    const path = await worktree.create(repo, "task-1");
    commitFile(repo, "from-main.txt", "main only\n");
    commitFile(path, "from-task.txt", "task only\n");

    expect(await worktree.changedFiles(repo, "task-1")).toEqual(["from-task.txt"]);
    expect(await worktree.diff(repo, "task-1")).not.toContain("from-main.txt");
  });

  it("lists added, modified and deleted files, including unusual names", async () => {
    const repo = initRepo();
    commitFile(repo, "to-delete.txt", "bye\n");
    const path = await worktree.create(repo, "task-1");
    commitFile(path, "README.md", "edited\n");
    commitFile(path, "src/new file.ts", "export {};\n");
    git(path, "rm", "-q", "to-delete.txt");
    git(path, "commit", "-q", "-m", "delete");

    expect(await worktree.changedFiles(repo, "task-1")).toEqual(["README.md", "src/new file.ts", "to-delete.txt"]);
  });

  it("returns nothing for a branch without commits", async () => {
    const repo = initRepo();
    await worktree.create(repo, "task-1");

    expect(await worktree.changedFiles(repo, "task-1")).toEqual([]);
    expect(await worktree.diff(repo, "task-1")).toBe("");
  });
});

describe("worktree.merge", () => {
  it("merges the branch into main with a merge commit, even when a fast-forward is possible", async () => {
    const repo = initRepo();
    const mainBefore = git(repo, "rev-parse", "main");
    const path = await worktree.create(repo, "task-1");
    commitFile(path, "feature.txt", "feature\n");
    const branchSha = git(path, "rev-parse", "HEAD");

    const result = await worktree.merge(repo, "task-1");

    const mainAfter = git(repo, "rev-parse", "main");
    expect(result).toEqual({ status: "merged", commit: mainAfter });
    expect(git(repo, "rev-parse", "main^1", "main^2").split("\n")).toEqual([mainBefore, branchSha]);
    expect(existsSync(join(repo, "feature.txt"))).toBe(true);
  });

  it("aborts cleanly and reports the conflicting files on conflict", async () => {
    const repo = initRepo();
    const path = await worktree.create(repo, "task-1");
    commitFile(path, "README.md", "line 1\nfrom task\n");
    commitFile(repo, "README.md", "line 1\nfrom main\n");
    const mainBefore = git(repo, "rev-parse", "main");

    const result = await worktree.merge(repo, "task-1");

    expect(result).toEqual({ status: "conflict", files: ["README.md"] });
    expect(git(repo, "rev-parse", "main")).toBe(mainBefore);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
  });

  it("refuses to merge when the project is not on main", async () => {
    const repo = initRepo();
    const path = await worktree.create(repo, "task-1");
    commitFile(path, "feature.txt", "feature\n");
    const mainBefore = git(repo, "rev-parse", "main");
    git(repo, "checkout", "-q", "-b", "other");

    await expect(worktree.merge(repo, "task-1")).rejects.toThrow(worktree.MergePreconditionError);
    expect(git(repo, "rev-parse", "main")).toBe(mainBefore);
  });

  it("refuses to merge when the project has uncommitted changes", async () => {
    const repo = initRepo();
    const path = await worktree.create(repo, "task-1");
    commitFile(path, "feature.txt", "feature\n");
    const mainBefore = git(repo, "rev-parse", "main");
    writeFileSync(join(repo, "README.md"), "dirty\n");

    await expect(worktree.merge(repo, "task-1")).rejects.toThrow(worktree.MergePreconditionError);
    expect(git(repo, "rev-parse", "main")).toBe(mainBefore);
  });
});

describe("worktree.commitAll", () => {
  it("commits every change in the worktree, untracked and deleted files included", async () => {
    const repo = initRepo();
    commitFile(repo, "to-delete.txt", "bye\n");
    const path = await worktree.create(repo, "task-1");
    writeFileSync(join(path, "README.md"), "edited\n");
    writeFileSync(join(path, "new.txt"), "new\n");
    rmSync(join(path, "to-delete.txt"));

    expect(await worktree.commitAll(repo, "task-1", "task-1: work")).toBe(true);

    expect(git(path, "status", "--porcelain")).toBe("");
    expect(git(path, "log", "-1", "--format=%s")).toBe("task-1: work");
    expect(await worktree.changedFiles(repo, "task-1")).toEqual(["README.md", "new.txt", "to-delete.txt"]);
  });

  it("creates no commit when nothing changed", async () => {
    const repo = initRepo();
    const path = await worktree.create(repo, "task-1");
    const headBefore = git(path, "rev-parse", "HEAD");

    expect(await worktree.commitAll(repo, "task-1", "task-1: nothing")).toBe(false);

    expect(git(path, "rev-parse", "HEAD")).toBe(headBefore);
  });
});

describe("worktree.remove", () => {
  it("removes the worktree directory and the task branch, even with uncommitted changes", async () => {
    const repo = initRepo();
    const path = await worktree.create(repo, "task-1");
    writeFileSync(join(path, "scratch.txt"), "uncommitted\n");

    await worktree.remove(repo, "task-1");

    expect(existsSync(path)).toBe(false);
    expect(git(repo, "branch", "--list", "loop/task-1")).toBe("");
    expect(git(repo, "worktree", "list")).not.toContain("task-1");
  });

  it("rejects when the worktree does not exist", async () => {
    const repo = initRepo();

    await expect(worktree.remove(repo, "task-1")).rejects.toThrow(worktree.GitError);
  });
});
