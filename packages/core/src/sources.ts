import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectConfig } from "./project-config.js";

export interface CitedSource {
  readonly path: string;
  /** Heading slug after `#`, or null when the whole file is cited. */
  readonly anchor: string | null;
  /** Null when the file or the section cannot be found. */
  readonly content: string | null;
}

/** GitHub-style heading anchor. */
export function headingSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Finds the `<path>` and `<path>#<anchor>` citations of the sources of truth in `text` and loads them. */
export async function extractCitedSources(
  text: string,
  sources: ProjectConfig["agents"]["sourcesOfTruth"],
  projectPath: string,
): Promise<CitedSource[]> {
  const citations = sources
    .flatMap((path) =>
      [...text.matchAll(new RegExp(`${escapeRegExp(path)}(?:#([\\p{L}\\p{N}_-]+))?`, "gu"))].map((match) => ({
        path,
        anchor: match[1] ?? null,
        index: match.index,
      })),
    )
    .sort((a, b) => a.index - b.index);

  const seen = new Set<string>();
  const unique = citations.filter(({ path, anchor }) => {
    const key = `${path}#${anchor ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return Promise.all(
    unique.map(async ({ path, anchor }) => {
      const file = await readFile(join(projectPath, path), "utf8").catch(() => null);
      const content = file === null || anchor === null ? file : extractSection(file, anchor);
      return { path, anchor, content };
    }),
  );
}

export function formatCitedSources(cited: readonly CitedSource[]): string {
  if (cited.length === 0) return "None cited.";
  return cited
    .map(({ path, anchor, content }) => `### ${anchor === null ? path : `${path}#${anchor}`}\n${content ?? "(not found)"}`)
    .join("\n\n");
}

function extractSection(markdown: string, anchor: string): string | null {
  const lines = markdown.split("\n");
  let inFence = false;
  let start = -1;
  let level = 0;

  for (const [index, line] of lines.entries()) {
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    const heading = inFence ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading === null) continue;
    const headingLevel = heading[1]?.length ?? 0;
    if (start === -1) {
      if (headingSlug(heading[2] ?? "") === anchor) {
        start = index;
        level = headingLevel;
      }
    } else if (headingLevel <= level) {
      return lines.slice(start, index).join("\n").trimEnd();
    }
  }
  return start === -1 ? null : lines.slice(start).join("\n").trimEnd();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
