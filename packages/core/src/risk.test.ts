import { describe, expect, it } from "vitest";
import type { RiskRules } from "./project-config.js";
import { computeRiskClass, countChangedLines, matchesAny, maxRiskClass } from "./risk.js";

describe("maxRiskClass", () => {
  it.each([
    [["low", "low"], "low"],
    [["low", "medium"], "medium"],
    [["medium", "low"], "medium"],
    [["high", "medium"], "high"],
    [["low", "high", "medium"], "high"],
  ] as const)("max of %j is %s", (classes, expected) => {
    expect(maxRiskClass(...classes)).toBe(expected);
  });
});

describe("matchesAny", () => {
  it.each([
    ["src/auth/login.ts", ["src/auth/**"], true],
    ["src/auth/deep/nested.ts", ["src/auth/**"], true],
    ["src/authz/login.ts", ["src/auth/**"], false],
    ["README.md", ["*.md"], true],
    ["docs/guide.md", ["*.md"], false],
    ["docs/guide.md", ["**/*.md"], true],
    [".github/workflows/ci.yml", ["src/**", ".github/**"], true],
    ["package.json", ["package.json"], true],
    ["package.json", [], false],
  ] as const)("%s against %j is %s", (file, patterns, expected) => {
    expect(matchesAny(file, patterns)).toBe(expected);
  });
});

describe("countChangedLines", () => {
  it("counts added and removed lines, not file headers", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,2 @@",
      " context",
      "-old",
      "+new",
      "diff --git a/b.txt b/b.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/b.txt",
      "@@ -0,0 +1,2 @@",
      "+one",
      "+two",
      "",
    ].join("\n");

    expect(countChangedLines(diff)).toBe(4);
  });

  it("returns 0 for an empty diff", () => {
    expect(countChangedLines("")).toBe(0);
  });
});

describe("computeRiskClass", () => {
  const rules: RiskRules = {
    high: ["src/engine/save/**", "docs/PRD.md"],
    medium: ["src/engine/**"],
    low: ["src/ui/**", "docs/**"],
    maxLowRiskDiffLines: 400,
  };

  it.each([
    [["src/ui/button.ts"], "low"],
    [["src/ui/button.ts", "docs/guide.md"], "low"],
    [["src/engine/tick.ts"], "medium"],
    [["src/engine/save/slot.ts"], "high"],
    [["docs/PRD.md"], "high"],
    [["src/ui/button.ts", "src/engine/save/slot.ts"], "high"],
    [["README.md"], "medium"],
    [["src/ui/button.ts", "README.md"], "medium"],
    [[], "low"],
  ] as const)("%j → %s", (files, expected) => {
    expect(computeRiskClass(rules, files, 10)).toBe(expected);
  });

  it("raises a low-risk change to medium above maxLowRiskDiffLines", () => {
    expect(computeRiskClass(rules, ["src/ui/button.ts"], 400)).toBe("low");
    expect(computeRiskClass(rules, ["src/ui/button.ts"], 401)).toBe("medium");
  });

  it("never lowers a high-risk change because of its size", () => {
    expect(computeRiskClass(rules, ["docs/PRD.md"], 1)).toBe("high");
    expect(computeRiskClass(rules, ["docs/PRD.md"], 10_000)).toBe("high");
  });
});
