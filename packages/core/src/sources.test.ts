import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { extractCitedSources, formatCitedSources, headingSlug } from "./sources.js";

const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const PRD = [
  "# Product",
  "Intro.",
  "## Checkout flow",
  "Pay in one click.",
  "### Edge cases",
  "Expired card is refused.",
  "## Payment & Refunds (v2)",
  "Refund within 14 days.",
  "# Appendix",
  "Glossary.",
  "",
].join("\n");

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "sources-"));
  tmpDirs.push(dir);
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "PRD.md"), PRD);
  writeFileSync(join(dir, "docs", "API.md"), "# API\nGET /items\n");
  return dir;
}

const SOURCES = [{ path: "docs/PRD.md" }, { path: "docs/API.md" }];

describe("headingSlug", () => {
  it.each([
    ["Checkout flow", "checkout-flow"],
    ["Payment & Refunds (v2)", "payment--refunds-v2"],
    ["  Édition des données  ", "édition-des-données"],
  ])("%j → %s", (heading, slug) => {
    expect(headingSlug(heading)).toBe(slug);
  });
});

describe("extractCitedSources", () => {
  it("extracts a cited section with its subsections, up to the next heading of the same level", async () => {
    const spec = "Implements docs/PRD.md#checkout-flow.";

    expect(await extractCitedSources(spec, SOURCES, makeProject())).toEqual([
      {
        path: "docs/PRD.md",
        anchor: "checkout-flow",
        content: "## Checkout flow\nPay in one click.\n### Edge cases\nExpired card is refused.",
      },
    ]);
  });

  it("matches headings with punctuation through their slug", async () => {
    const spec = "See docs/PRD.md#payment--refunds-v2";

    expect(await extractCitedSources(spec, SOURCES, makeProject())).toEqual([
      { path: "docs/PRD.md", anchor: "payment--refunds-v2", content: "## Payment & Refunds (v2)\nRefund within 14 days." },
    ]);
  });

  it("returns the whole file when it is cited without anchor", async () => {
    const spec = "Must follow docs/API.md.";

    expect(await extractCitedSources(spec, SOURCES, makeProject())).toEqual([
      { path: "docs/API.md", anchor: null, content: "# API\nGET /items\n" },
    ]);
  });

  it("returns several citations once each, in order of first appearance", async () => {
    const spec = "docs/API.md, docs/PRD.md#checkout-flow, docs/PRD.md#appendix, docs/PRD.md#checkout-flow";

    const cited = await extractCitedSources(spec, SOURCES, makeProject());

    expect(cited.map(({ path, anchor }) => `${path}#${anchor ?? ""}`)).toEqual([
      "docs/API.md#",
      "docs/PRD.md#checkout-flow",
      "docs/PRD.md#appendix",
    ]);
  });

  it("ignores sources the spec does not cite", async () => {
    expect(await extractCitedSources("No citation.", SOURCES, makeProject())).toEqual([]);
  });

  it("reports an unknown anchor or a missing file with null content", async () => {
    const spec = "docs/PRD.md#nope and docs/MISSING.md";

    expect(await extractCitedSources(spec, [...SOURCES, { path: "docs/MISSING.md" }], makeProject())).toEqual([
      { path: "docs/PRD.md", anchor: "nope", content: null },
      { path: "docs/MISSING.md", anchor: null, content: null },
    ]);
  });
});

describe("formatCitedSources", () => {
  it("formats each citation under its own heading", () => {
    expect(
      formatCitedSources([
        { path: "docs/PRD.md", anchor: "checkout-flow", content: "## Checkout flow\nPay." },
        { path: "docs/MISSING.md", anchor: null, content: null },
      ]),
    ).toBe("### docs/PRD.md#checkout-flow\n## Checkout flow\nPay.\n\n### docs/MISSING.md\n(not found)");
  });

  it("says so when nothing is cited", () => {
    expect(formatCitedSources([])).toBe("None cited.");
  });
});
